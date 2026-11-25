import XCTest
@testable import AppCore

// 계획 10 조각 5 — 제미나이(agy) · opencode. 출력 모양은 조사 문서(cli-research.md 3 · 4장)의 예시를 고정 글로 쓴다(실제 CLI 는 부르지 않는다).

/// agy `-p … --output-format stream-json` 한 번의 출력(조사 문서의 모양).
/// 가짜 실행기 대본의 열쇠 — 실행 파일 + 인자를 공백으로 이은 글.
func cmdKey(_ c: CLICommands.Command) -> String { ([c.executable] + c.arguments).joined(separator: " ") }

let agySample = """
{"event":"init","conversation_id":"c1","init":{"model":"gemini-3.8-flash-medium","cwd":"/tmp","tools":["a","b"]}}
{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"안녕"}}
{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"하세요"}}
{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","usage":{"input_tokens":120,"output_tokens":8}}}
{"event":"result","result":{"status":"SUCCESS","response":"안녕하세요\\n","duration_seconds":1.2,"num_turns":1,"usage":{"input_tokens":120,"output_tokens":8}}}

"""

/// agy `/usage` — 제미나이 묶음은 weekly 가 앞(5h 가 뒤), 클로드 · GPT 묶음은 아직 시작 안 됨(1970).
let agyUsageSample = """
{"event":"command_result","command":{"name":"usage","data":{"description":"d","groups":[{"name":"Gemini Models","buckets":[{"id":"gemini-weekly","window":"weekly","remaining_fraction":0.52,"reset_time":"2026-12-01T04:51:22Z"},{"id":"gemini-5h","window":"5h","remaining_fraction":0.77,"reset_time":"2026-11-24T09:51:22Z"}]},{"name":"Claude and GPT models","buckets":[{"id":"3p-weekly","window":"weekly","remaining_fraction":1,"reset_time":"1970-01-01T00:00:00Z"},{"id":"3p-5h","window":"5h","remaining_fraction":1,"reset_time":"1970-01-01T00:00:00Z"}]}]}}}
{"event":"result","result":{"status":"SUCCESS","response":"","num_turns":0}}

"""

let opencodeSample = """
{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}
{"type":"text","part":{"type":"text","text":"안녕하세요"}}
{"type":"step_finish","part":{"type":"step-finish","reason":"stop","cost":0,"tokens":{"input":50,"output":7,"reasoning":3,"cache":{"read":20,"write":5}}}}

"""

func agyChunks(_ parser: inout AgyStreamParser, _ text: String) -> [StreamEvent] {
    parser.feed(Data(text.utf8)) + parser.finish()
}

final class CLIEnvironmentFourTests: XCTestCase {
    let support = URL(fileURLWithPath: "/tmp/sa-support")

    func tempDir() -> URL {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("cli-four-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: u) }
        return u
    }

    // MARK: 환경은 CLI 마다(Review Focus 1)
    func testClaudeAndCodexNeverGetHomeOrXDG() {
        let global = CLIEnvironment.overrides(support: support)
        XCTAssertEqual(Set(global.keys), ["CLAUDE_CONFIG_DIR", "CODEX_HOME"], "모든 실행기에 가는 사전은 두 키 그대로")
        for mode in AgyMode.allCases {
            for exe in ["claude", "codex", "/usr/local/bin/claude", "whatever"] {
                XCTAssertEqual(CLIEnvironment.executableEnvironment(executable: exe, support: support, agyMode: mode), [:], "\(exe)/\(mode)")
            }
        }
    }

    func testAgyIsolatedGetsOnlyHomeAndSharedGetsNothing() {
        for mode in AgyMode.allCases {
            XCTAssertEqual(CLIEnvironment.executableEnvironment(executable: "agy", support: support, agyMode: mode), [:])
            XCTAssertEqual(CLIEnvironment.executableEnvironment(executable: "/opt/homebrew/bin/agy", support: support, agyMode: mode), [:])
        }
    }

    func testOpenCodeEnvironmentIsXDGFourPlusDisableFlags() {
        let env = CLIEnvironment.executableEnvironment(executable: "opencode", support: support, agyMode: .shared)
        XCTAssertEqual(env, [
            "XDG_CONFIG_HOME": "/tmp/sa-support/opencode-xdg/config",
            "XDG_STATE_HOME": "/tmp/sa-support/opencode-xdg/state",
            "XDG_CACHE_HOME": "/tmp/sa-support/opencode-xdg/cache",
            "OPENCODE_DISABLE_CLAUDE_CODE": "1",
            "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
            "OPENCODE_DISABLE_AUTOUPDATE": "1",
            "OPENCODE_CONFIG_CONTENT": CLIManagedConfig.opencodeConfigJSON,
        ])
        XCTAssertNil(env["XDG_DATA_HOME"])
        XCTAssertNil(env["HOME"])
    }

    func testEnvironmentForKindMatchesWhatLoginFilesGet() {
        XCTAssertEqual(CLIEnvironment.environment(for: .gemini, support: support), [:])
        XCTAssertEqual(CLIEnvironment.environment(for: .gemini, support: support, agyMode: .shared), [:])
        XCTAssertEqual(CLIEnvironment.environment(for: .opencode, support: support).count, 7)
        XCTAssertNil(CLIEnvironment.environment(for: .opencode, support: support)["XDG_DATA_HOME"])
    }

    func testUserValuesLoseToAppValuesForAgyAndOpenCode() {
        let overrides = CLIEnvironment.executableEnvironment(executable: "agy", support: support, agyMode: .isolated)
        let child = ProcessRunner.childEnvironment(base: ["HOME": "/Users/me"], path: "/bin", overrides: overrides)
        XCTAssertEqual(child["HOME"], "/Users/me", "agy 는 HOME 을 바꾸지 않는다")
        let oc = ProcessRunner.childEnvironment(base: ["XDG_CONFIG_HOME": "/Users/me/.config", "XDG_DATA_HOME": "/Users/me/.local/share"], path: "/bin",
                                                overrides: CLIEnvironment.opencodeEnvironment(support: support))
        XCTAssertEqual(oc["XDG_CONFIG_HOME"], "/tmp/sa-support/opencode-xdg/config")
        XCTAssertEqual(oc["XDG_DATA_HOME"], "/Users/me/.local/share", "XDG_DATA_HOME 은 사용자 기본을 함께 쓴다")
    }

    func testPrepareDirectoriesAlsoMakesAgyHomeAndOpenCodeXDG0700() throws {
        let s = tempDir()
        try CLIEnvironment.prepareDirectories(support: s)
        var dirs = [
            CLIEnvironment.agyGeminiDirectory(support: s),
            CLIEnvironment.agyGeminiDirectory(support: s).appendingPathComponent("config", isDirectory: true),
            CLIEnvironment.opencodeXDGRoot(support: s),
        ]
        dirs += CLIEnvironment.opencodeXDGDirectories(support: s).values
        XCTAssertEqual(dirs.count, 6)
        for d in dirs {
            let perm = (try FileManager.default.attributesOfItem(atPath: d.path)[.posixPermissions] as? NSNumber)?.intValue
            XCTAssertEqual(perm, 0o700, d.lastPathComponent)
        }
    }

    /// 실제 자식 프로세스(`/usr/bin/env`)로: 실행 파일 이름에 맞는 환경만 들어가고, 다른 이름에는 안 샌다.
    func testProcessRunnerAppliesPerExecutableEnvironmentAtSpawnTime() async {
        final class Mode: @unchecked Sendable {
            private let lock = NSLock(); private var v = "A"
            var value: String { get { lock.withLock { v } } set { lock.withLock { v = newValue } } }
        }
        let mode = Mode()
        let r = ProcessRunner(environmentOverrides: ["GLOBAL_X": "g"], executableEnvironment: { exe in
            exe == "env" ? ["PER_EXE": mode.value] : ["OTHER_EXE": "no"]
        })
        let c1 = Collector()
        let o1 = await r.run(executable: "/usr/bin/env", arguments: [], workDir: URL(fileURLWithPath: NSTemporaryDirectory()),
                             path: "/bin:/usr/bin", timeout: 20, onEvent: { c1.handle($0) })
        XCTAssertEqual(o1, .finished(code: 0))
        XCTAssertTrue(c1.stdout.contains("PER_EXE=A\n"))
        XCTAssertTrue(c1.stdout.contains("GLOBAL_X=g\n"))
        XCTAssertFalse(c1.stdout.contains("OTHER_EXE"))
        mode.value = "B"   // 설정이 바뀌면 다음에 띄우는 자식부터 바뀐 값
        let c2 = Collector()
        _ = await r.run(executable: "/usr/bin/env", arguments: [], workDir: URL(fileURLWithPath: NSTemporaryDirectory()),
                        path: "/bin:/usr/bin", timeout: 20, onEvent: { c2.handle($0) })
        XCTAssertTrue(c2.stdout.contains("PER_EXE=B\n"))
    }

    // MARK: 명령줄
    func testAgyCommands() {
        let gdir = CLIEnvironment.agyGeminiDirectory(support: support)
        XCTAssertEqual(CLICommands.agyModels(geminiDir: gdir).arguments, ["--gemini_dir", gdir.path, "models"], "agy models 는 --settings 를 받지 않는다")
        XCTAssertEqual(CLICommands.agyUsage(geminiDir: gdir).arguments, ["--gemini_dir", gdir.path, "-p", "/usage", "--output-format", "stream-json", "--settings", CLICommands.agySettingsJSON(safariTools: false)])
        XCTAssertEqual(CLICommands.agyLogin.arguments, [])
        XCTAssertEqual(CLICommands.agyAsk(prompt: "질문", modelID: "gemini-4-neon-low", geminiDir: gdir).arguments,
                       ["--gemini_dir", gdir.path, "-p", "질문", "--model", "gemini-4-neon-low", "--output-format", "stream-json", "--settings", CLICommands.agySettingsJSON(safariTools: false)])
        XCTAssertEqual(CLICommands.agyAsk(prompt: "q", modelID: nil, geminiDir: gdir).arguments[5], "gemini-3.8-flash-medium")
        XCTAssertEqual(CLICommands.agyAsk(prompt: "q", modelID: "--evil", geminiDir: gdir).arguments[5], "gemini-3.8-flash-medium", "안전하지 않은 id 는 기본으로")
    }

    func testOpenCodeRunShapeAndEveryOpenCodeCommandIsStandalone() {
        let run = CLICommands.opencodeRun(prompt: "질문 $(x)", modelID: "opencode/deepseek-v4.1-flash-free")
        XCTAssertEqual(run.executable, "opencode")
        XCTAssertEqual(run.arguments, ["run", "질문 $(x)", "-m", "opencode/deepseek-v4.1-flash-free", "--format", "json", "--archived", "--standalone"])
        let withEffort = CLICommands.opencodeRun(prompt: "q", modelID: "opencode/deepseek-v4.1-flash-free", effort: "high")
        XCTAssertEqual(withEffort.arguments, ["run", "q", "-m", "opencode/deepseek-v4.1-flash-free#high", "--format", "json", "--archived", "--standalone"])
        XCTAssertFalse(CLICommands.opencodeRun(prompt: "q", modelID: nil).arguments.contains("-m"))
        XCTAssertFalse(CLICommands.opencodeRun(prompt: "q", modelID: "-evil/x").arguments.contains("-m"))
        let all = [CLICommands.opencodeAuthList, CLICommands.opencodeModels, CLICommands.opencodeStats, CLICommands.opencodeLogin,
                   CLICommands.opencodeRun(prompt: "q", modelID: "a/b"), CLICommands.opencodeRun(prompt: "q", modelID: nil)]
        for c in all {
            XCTAssertEqual(c.executable, "opencode")
            XCTAssertTrue(c.arguments.contains("--standalone"), "\(c.arguments)")
        }
        XCTAssertEqual(CLICommands.opencodeStats.arguments, ["stats", "--json", "--days", "7", "--standalone"])
        XCTAssertEqual(CLICommands.opencodeAuthList.arguments, ["auth", "list", "--standalone"])
        XCTAssertEqual(CLICommands.opencodeLogin.arguments, ["auth", "login", "--standalone"])
    }

    func testCommandBuilderRoutesNewKinds() {
        let work = support.appendingPathComponent("work")
        let gdir = CLIEnvironment.agyGeminiDirectory(support: support)
        let g = CommandBuilder.build(AskRequest(question: "q", model: .gemini, modelID: "gemini-4-neon-low"), workDir: work)
        XCTAssertEqual(g.executable, "agy")
        XCTAssertEqual(g.arguments, ["--gemini_dir", gdir.path, "-p", "q", "--model", "gemini-4-neon-low", "--output-format", "stream-json", "--settings", CLICommands.agySettingsJSON(safariTools: false)])
        let o = CommandBuilder.build(AskRequest(question: "-x", model: .opencode, modelID: "opencode/a-free"), workDir: work)
        XCTAssertEqual(o.executable, "opencode")
        XCTAssertEqual(o.arguments, ["run", "질문: -x", "-m", "opencode/a-free", "--format", "json", "--archived", "--standalone"])
        XCTAssertNil(CommandBuilder.notice(for: AskRequest(question: "q", model: .opencode)))
    }

    // MARK: 로그인 .command
    func testAgyLoginFileIsolatedEchoesQuitHintBeforeAgyStarts() throws {
        let s = tempDir()
        let url = try TerminalLogin.writeLoginFile(kind: .gemini, support: s)
        XCTAssertEqual(url.lastPathComponent, "login-agy.command")
        let perm = (try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue
        XCTAssertEqual(perm, 0o755)
        let t = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(t.hasPrefix("#!/bin/zsh -l\n"))
        XCTAssertFalse(t.contains("export HOME="))
        let lines = t.components(separatedBy: "\n")
        let hint = try XCTUnwrap(lines.firstIndex { $0.contains("/quit") })
        let run = try XCTUnwrap(lines.firstIndex { $0 == "'agy'" })
        XCTAssertLessThan(hint, run, "TUI 가 창을 차지하기 전에 끝내는 법을 먼저 보인다")
        XCTAssertTrue(t.contains("로그인을 마친 뒤 /quit"))
    }

    func testAgyLoginFileSharedModeHasNoExports() throws {
        let t = try String(contentsOf: TerminalLogin.writeLoginFile(kind: .gemini, support: tempDir(), agyMode: .shared), encoding: .utf8)
        XCTAssertFalse(t.contains("export "))
        XCTAssertTrue(t.contains("\n'agy'\n"))
    }

    func testOpenCodeLoginFileHasXDGAndStandalone() throws {
        let s = tempDir()
        let t = try String(contentsOf: TerminalLogin.writeLoginFile(kind: .opencode, support: s), encoding: .utf8)
        XCTAssertFalse(t.contains("XDG_DATA_HOME"), "평소 opencode DB 를 함께 쓴다")
        XCTAssertTrue(t.contains("export XDG_CONFIG_HOME='\(s.path)/opencode-xdg/config'"))
        XCTAssertTrue(t.contains("export OPENCODE_DISABLE_CLAUDE_CODE='1'"))
        XCTAssertTrue(t.contains("'opencode' 'auth' 'login' '--standalone'"))
        XCTAssertFalse(t.contains("export HOME"))
    }

    func testClaudeAndCodexLoginFilesStillHaveNoHomeOrXDG() throws {
        let s = tempDir()
        for k in [ModelKind.claude, .chatgpt] {
            let t = try String(contentsOf: TerminalLogin.writeLoginFile(kind: k, support: s), encoding: .utf8)
            XCTAssertFalse(t.contains("HOME=") && !t.contains("CODEX_HOME="), "\(k)")
            XCTAssertFalse(t.contains("XDG_"))
            XCTAssertFalse(t.contains("export HOME"))
        }
    }

    // MARK: 설정 저장 — agy 방식
    func testSettingsDefaultsAndAgyModeRoundTrip() throws {
        let dir = tempDir()
        XCTAssertEqual(AppSettingsStore(directory: dir).current.agyMode, .isolated)
        try AppSettingsStore(directory: dir).update { $0.agyMode = .shared; $0.selectedCLI = "gemini" }
        let again = AppSettingsStore(directory: dir).current
        XCTAssertEqual(again.agyMode, .shared)
        XCTAssertEqual(again.selectedCLI, "gemini")
    }

    func testOldShapedSettingsFileWithoutAgyModeIsNotTreatedAsCorrupt() throws {
        let dir = tempDir()
        try Data(#"{"selectedCLI":"chatgpt","models":{"chatgpt":"gpt-6-luna"}}"#.utf8).write(to: dir.appendingPathComponent("settings.json"))
        let store = AppSettingsStore(directory: dir)
        XCTAssertEqual(store.current, AppSettings(selectedCLI: "chatgpt", models: ["chatgpt": "gpt-6-luna"], agyMode: .isolated))
        try store.update { $0.agyMode = .shared }
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("settings.json.bak").path), "옛 파일을 .bak 으로 밀어내지 않는다")
        XCTAssertEqual(AppSettingsStore(directory: dir).current.models["chatgpt"], "gpt-6-luna")
    }

    func testUnknownAgyModeValueFallsBackToIsolated() throws {
        let dir = tempDir()
        try Data(#"{"selectedCLI":"claude","models":{},"agyMode":"weird"}"#.utf8).write(to: dir.appendingPathComponent("settings.json"))
        XCTAssertEqual(AppSettingsStore(directory: dir).current.agyMode, .isolated)
    }

    func testAgySharedWarningTextAndCopyLine() {
        XCTAssertTrue(AgyMode.sharedWarning.contains("agy mcp disable safari-attraction"))
        XCTAssertEqual(AgyMode.disableMCPCommand, "agy mcp disable safari-attraction")
        XCTAssertEqual(AgyMode.isolated.label, "앱 전용 폴더(시험판)")
        XCTAssertEqual(AgyMode.shared.label, "내 설정 함께 쓰기")
    }
}

final class AgyStreamParserTests: XCTestCase {
    func texts(_ ev: [StreamEvent]) -> [String] { ev.compactMap { if case .text(let t) = $0 { return t }; return nil } }

    func testSampleGivesDeltasThenUsageAndDoesNotRepeatResponse() {
        var p = AgyStreamParser()
        let ev = agyChunks(&p, agySample)
        XCTAssertEqual(texts(ev), ["안녕", "하세요"])
        XCTAssertEqual(ev.filter { if case .usage = $0 { return true }; return false }, [.usage(TokenUsage(input: 120, output: 8))], "쓴 양은 한 번만")
        XCTAssertFalse(ev.contains { if case .error = $0 { return true }; return false })
    }

    func testResponseIsUsedWhenThereWereNoDeltas() {
        var p = AgyStreamParser()
        let ev = agyChunks(&p, #"{"event":"result","result":{"status":"SUCCESS","response":"답이에요\n","usage":{"input_tokens":3,"output_tokens":2}}}"# + "\n")
        XCTAssertEqual(texts(ev), ["답이에요\n"])
    }

    func testChunkSplitInTheMiddleOfALineAndOfAKoreanCharacter() {
        var p = AgyStreamParser()
        let bytes = Array(agySample.utf8)
        var ev: [StreamEvent] = []
        var i = 0
        while i < bytes.count { ev += p.feed(Data(bytes[i..<min(i + 7, bytes.count)])); i += 7 }
        ev += p.finish()
        XCTAssertEqual(texts(ev), ["안녕", "하세요"])
    }

    func testNewStepAfterToolsIsSeparatedByBlankLine() {
        var p = AgyStreamParser()
        let ev = agyChunks(&p, """
        {"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","text_delta":"먼저"}}
        {"event":"step_update","step_update":{"step_index":2,"step_type":"tool_call","text_delta":"무시"}}
        {"event":"step_update","step_update":{"step_index":3,"step_type":"agent_response","text_delta":"그다음"}}

        """)
        XCTAssertEqual(texts(ev).joined(), "먼저\n\n그다음")
    }

    func testFailedResultBecomesKoreanErrorAndLoginTextBecomesLoginMessage() {
        var p = AgyStreamParser()
        let ev = agyChunks(&p, #"{"event":"result","result":{"status":"ERROR","error":"quota exceeded"}}"# + "\n")
        XCTAssertEqual(ev, [.error("quota exceeded")])
        var q = AgyStreamParser()
        let ev2 = agyChunks(&q, #"{"event":"result","result":{"status":"ERROR","error":"Please sign in to continue"}}"# + "\n")
        XCTAssertEqual(ev2, [.error("설정에서 제미나이 로그인을 해 주세요")])
        var r = AgyStreamParser()
        XCTAssertEqual(agyChunks(&r, #"{"event":"result","result":{"status":"CANCELLED"}}"# + "\n"), [.error("제미나이가 답을 끝내지 못했어요")])
    }

    func testBrokenJsonLineIsSkippedButPlainTextIsKept() {
        var p = AgyStreamParser()
        let ev = agyChunks(&p, "{\"event\":\"step_upd\nError: boom\n")
        XCTAssertEqual(texts(ev), ["Error: boom\n"])
        var q = AgyStreamParser()
        XCTAssertEqual(texts(agyChunks(&q, "{깨진")), [], "끝에 남은 깨진 JSON 도 건너뜀")
    }

    func testStepUsageIsUsedWhenNoResultLineArrives() {
        var p = AgyStreamParser()
        let ev = agyChunks(&p, #"{"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","text_delta":"a","usage":{"input_tokens":4,"output_tokens":1}}}"# + "\n")
        XCTAssertEqual(ev.last, .usage(TokenUsage(input: 4, output: 1)))
    }

    func testReaderEndToEndForGemini() {
        var r = ModelOutputReader(model: .gemini)
        var ev = r.handle(.stdout(Data(agySample.utf8)))
        ev += r.finish(outcome: .finished(code: 0))
        XCTAssertEqual(texts(ev).joined(), "안녕하세요")
        XCTAssertTrue(ev.contains(.usage(TokenUsage(input: 120, output: 8))))
    }

    func testReaderSignInOnStderrWithNonZeroExit() {
        var r2 = ModelOutputReader(model: .gemini)
        _ = r2.handle(.stderr(Data("Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n".utf8)))
        XCTAssertEqual(r2.finish(outcome: .finished(code: 1)), [.error("설정에서 제미나이 로그인을 해 주세요")])
    }

    func testAgyToolUseStepUpdate() {
        var p = AgyStreamParser()
        let ev = agyChunks(&p, """
        {"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"call_mcp_tool","tool_info":{"parameters":{"ServerName":"safari-attraction","ToolName":"ping","Arguments":{}}}}}
        {"event":"step_update","step_update":{"step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"search_web"}}
        {"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"call_mcp_tool"}}

        """)
        XCTAssertEqual(ev, [.toolUse(name: "ping"), .toolUse(name: "search_web")])
    }
}

final class OpenCodeStreamParserTests: XCTestCase {
    func run(_ s: String) -> [StreamEvent] {
        var p = OpenCodeStreamParser()
        return p.feed(Data(s.utf8)) + p.finish()
    }

    func testSampleGivesTextAndUsageAtTheEnd() {
        let ev = run(opencodeSample)
        XCTAssertEqual(ev, [.text("안녕하세요"), .usage(TokenUsage(input: 55, cachedInput: 20, output: 7, reasoning: 3))])
    }

    func testSeveralStepFinishesAreSummedOnce() {
        let ev = run(opencodeSample + opencodeSample)
        XCTAssertEqual(ev.filter { if case .usage = $0 { return true }; return false }, [.usage(TokenUsage(input: 110, cachedInput: 40, output: 14, reasoning: 6))])
    }

    func testNoTokensNoUsageAndUnknownTypesIgnored() {
        XCTAssertEqual(run(#"{"type":"tool_use","part":{"x":1}}"# + "\n" + #"{"type":"text","part":{"text":"  "}}"# + "\n"), [])
    }

    func testErrorEventsBecomeKoreanSafeLines() {
        XCTAssertEqual(run(#"{"type":"error","error":{"name":"APIError","data":{"message":"model not found"}}}"# + "\n"), [.error("model not found")])
        XCTAssertEqual(run(#"{"type":"error","error":{"name":"UnknownError"}}"# + "\n"), [.error("UnknownError")])
        XCTAssertEqual(run(#"{"type":"error","error":{"data":{"message":"Authentication failed for provider"}}}"# + "\n"),
                       [.error("설정에서 opencode 로그인을 해 주세요 — 로그인 없이 쓰는 무료 사용량은 금방 막혀요")])
    }

    func testBrokenLinesAndLoginTextOutsideJson() {
        XCTAssertEqual(run("{깨진\n" + opencodeSample).first, .text("안녕하세요"))
        XCTAssertEqual(run("Not logged in\n"), [.error("설정에서 opencode 로그인을 해 주세요 — 로그인 없이 쓰는 무료 사용량은 금방 막혀요")])
        XCTAssertEqual(run("그냥 안내 글\n"), [])
    }

    func testLastLineWithoutNewlineIsRead() {
        XCTAssertEqual(run(#"{"type":"text","part":{"text":"끝"}}"#), [.text("끝")])
    }

    func testReaderEndToEndForOpenCode() {
        var r = ModelOutputReader(model: .opencode)
        var ev = r.handle(.stdout(Data(opencodeSample.utf8)))
        ev += r.finish(outcome: .finished(code: 0))
        XCTAssertEqual(ev.count, 2)
        var r2 = ModelOutputReader(model: .opencode)
        _ = r2.handle(.stderr(Data("Error: not authenticated\n".utf8)))
        XCTAssertEqual(r2.finish(outcome: .finished(code: 1)), [.error(ModelKind.opencode.loginNeededMessage)])
    }

    func testOpenCodeToolUseAndInsufficientBalance() {
        let toolLine = #"{"type":"tool_use","part":{"type":"tool","tool":"safari-attraction_ping","state":{"status":"completed"}}}"# + "\n"
        XCTAssertEqual(run(toolLine), [.toolUse(name: "safari-attraction_ping")])

        let balLine = #"{"type":"error","error":{"name":"APIError","data":{"message":"Insufficient balance"}}}"# + "\n"
        XCTAssertEqual(run(balLine), [.error("무료 한도가 찼어요 — OpenCode Go 로 로그인하면 계속 쓸 수 있어요")])
    }
}

final class ClaudeRateLimitEventTests: XCTestCase {
    func testUnifiedWindowsBecomeSnapshot() {
        var p = ClaudeStreamParser()
        let line = #"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.07,"resetsAt":1798013770,"status":"allowed"},"seven_day":{"utilization":0.47,"resetsAt":1798500000}}},"session_id":"s1"}"# + "\n"
        let ev = p.feed(Data(line.utf8))
        guard case .rateLimits(let snap)? = ev.last else { return XCTFail("\(ev)") }
        XCTAssertEqual(snap.windows.map(\.name), ["현재 세션", "이번 주 · 전체 모델"])
        XCTAssertEqual(snap.windows.map(\.usedFraction), [0.07, 0.47])
        XCTAssertEqual(UsageFormat.oneLine(snap), "5시간 7% 사용 · 주간 47%")
    }

    func testEventWithoutWindowsEmitsNothing() {
        var p = ClaudeStreamParser()
        let ev = p.feed(Data((#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"},"session_id":"s1"}"# + "\n").utf8))
        XCTAssertFalse(ev.contains { if case .rateLimits = $0 { return true }; return false })
    }
}

final class CLIModelsFourTests: XCTestCase {
    func testParseAgyModelsTabSeparated() {
        let out = "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\ngpt-oss-120b-medium\tGPT-OSS 120B\n"
        let m = CLIModels.parseAgyModels(out)
        XCTAssertEqual(m.map(\.id), ["gemini-3.8-flash-low", "gemini-3.8-flash-medium", "claude-opus-5-5-high", "gpt-oss-120b-medium"])
        XCTAssertEqual(m[1].label, "Gemini 3.8 Flash (Medium)")
    }

    func testParseAgyModelsIgnoresHeadersJunkAndDuplicatesAndLoginText() {
        let out = "ID\tNAME\n\n안내 글이에요\ngemini-4-neon-low\tNeon Low\ngemini-4-neon-low\tdup\nbad;id-x\tno\n-evil-id\tno\n"
        XCTAssertEqual(CLIModels.parseAgyModels(out).map(\.id), ["gemini-4-neon-low"])
        XCTAssertEqual(CLIModels.parseAgyModels("Error: Please sign in to view available models.\ngemini-4-neon-low\tx\n"), [])
        XCTAssertEqual(CLIModels.parseAgyModels(""), [])
        XCTAssertEqual(CLIModels.parseAgyModels("gemini-3.8-flash-low   Gemini Low\n").map(\.id), ["gemini-3.8-flash-low"], "탭이 없어도 공백으로")
    }

    func testParseOpenCodeModels() {
        let out = "opencode/deepseek-v4.1-flash-free\nopencode/claude-opus-5-5\n\nFetching models...\nopencode/qwen#high\n  opencode/glm-5.3-free  \nopencode/glm-5.3-free\n"
        XCTAssertEqual(CLIModels.parseOpenCodeModels(out).map(\.id),
                       ["opencode/deepseek-v4.1-flash-free", "opencode/claude-opus-5-5", "opencode/qwen#high", "opencode/glm-5.3-free"])
    }

    func testSafeProviderModelID() {
        for ok in ["opencode/deepseek-v4.1-flash-free", "anthropic/claude-sonnet-5-5", "opencode/x#high"] { XCTAssertTrue(CLIModels.isSafeProviderModelID(ok), ok) }
        for bad in ["", "noslash", "-a/b", "/a", "a b/c", "a/b;c", "a/$(x)", "한글/모델"] { XCTAssertFalse(CLIModels.isSafeProviderModelID(bad), bad) }
        XCTAssertFalse(CLIModels.isSafeID("opencode/x"), "클로드 · codex 의 안전 검사는 그대로(슬래시 불가)")
    }

    func testDefaultsPerCLI() {
        func c(_ ids: [String]) -> [ModelChoice] { ids.map { ModelChoice(id: $0, label: $0) } }
        XCTAssertEqual(CLIModels.defaultID(for: .gemini, in: c(["gemini-4-neon-low", "gemini-3.8-flash-medium"])), "gemini-3.8-flash-medium")
        XCTAssertEqual(CLIModels.defaultID(for: .gemini, in: c(["gemini-4-neon-low", "x-y"])), "gemini-4-neon-low", "기본이 없으면 첫 것")
        XCTAssertEqual(CLIModels.defaultID(for: .opencode, in: c(["opencode/a", "opencode/b-free", "opencode/c-free"])), "opencode/b-free")
        XCTAssertEqual(CLIModels.defaultID(for: .opencode, in: c(["opencode/a", "opencode/b"])), "opencode/a")
        XCTAssertNil(CLIModels.defaultID(for: .opencode, in: []))
        XCTAssertEqual(CLIModels.defaultID(for: .chatgpt, in: c(["x", "y"])), "x")
        XCTAssertEqual(CLIModels.resolve(kind: .opencode, selected: "opencode/gone", in: c(["opencode/a-free"])), "opencode/a-free", "저장해 둔 것이 목록에 없으면 기본으로")
        XCTAssertEqual(CLIModels.resolve(kind: .opencode, selected: "opencode/a", in: c(["opencode/a", "opencode/b-free"])), "opencode/a")
    }
}

final class CLIStatusParsersFourTests: XCTestCase {
    func testAgyStatus() {
        let signIn = "Error: Please sign in to view available models. Launch the CLI without arguments to sign in."
        XCTAssertEqual(CLIAccountParser.parseAgyStatus(stdout: "", stderr: signIn, exitCode: 1).state, .loggedOut, "stderr 에 있어도")
        XCTAssertEqual(CLIAccountParser.parseAgyStatus(stdout: signIn, stderr: "", exitCode: 0).state, .loggedOut, "stdout 에 있어도 · 종료 0 이어도")
        let ok = CLIAccountParser.parseAgyStatus(stdout: "gemini-3.8-flash-low\tLow\n", stderr: "", exitCode: 0)
        XCTAssertEqual(ok.state, .loggedIn(CLIAccountInfo()))
        XCTAssertEqual(ok.models.map(\.id), ["gemini-3.8-flash-low"])
        XCTAssertEqual(CLIAccountParser.parseAgyStatus(stdout: "", stderr: "", exitCode: 0).state, .unknown, "종료 0 인데 목록이 비면 로그인됨으로 보지 않는다")
        XCTAssertEqual(CLIAccountParser.parseAgyStatus(stdout: "", stderr: "network down", exitCode: 1).state, .unknown)
    }

    func testOpenCodeStatus() {
        XCTAssertEqual(CLIAccountParser.parseOpenCodeStatus(output: "No authenticated integrations\n", exitCode: 0), .loggedOut)
        XCTAssertEqual(CLIAccountParser.parseOpenCodeStatus(output: "OpenCode Console  Personal  stored\n", exitCode: 0), .loggedIn(CLIAccountInfo()))
        XCTAssertEqual(CLIAccountParser.parseOpenCodeStatus(output: "", exitCode: 3), .unknown)
        let s = CLIAccountParser.parseOpenCodeStatus(output: "OpenCode Console  Personal  stored  sk-SECRETVALUE\n", exitCode: 0)
        XCTAssertFalse("\(s)".contains("SECRETVALUE"), "목록 글은 버린다")
    }
}

final class CLIUsageFourTests: XCTestCase {
    func testAgyUsageSample() throws {
        let snap = try XCTUnwrap(AgyUsageParser.parse(streamOutput: agyUsageSample))
        XCTAssertEqual(snap.windows.map(\.name), ["제미나이 5시간", "제미나이 주간", "클로드 · GPT 5시간", "클로드 · GPT 주간"], "5시간이 주간보다 앞")
        XCTAssertEqual(snap.windows[0].usedFraction ?? -1, 0.23, accuracy: 1e-9, "사용 비율 = 1 − 남은 비율")
        XCTAssertEqual(snap.windows[1].usedFraction ?? -1, 0.48, accuracy: 1e-9)
        XCTAssertEqual(snap.windows[0].resetsAt, ISO8601DateFormatter().date(from: "2026-11-24T09:51:22Z"))
        XCTAssertFalse(snap.windows[0].notStarted)
        XCTAssertTrue(snap.windows[2].notStarted)
        XCTAssertNil(snap.windows[2].resetsAt)
        XCTAssertEqual(UsageFormat.resetText(snap.windows[2], now: Date(timeIntervalSince1970: 1_800_000_000)), "아직 시작 안 됨")
        XCTAssertEqual(snap.windows[2].usedFraction ?? -1, 0, accuracy: 1e-9)
    }

    func testAgyUsageOneLineByModelGroup() throws {
        let snap = try XCTUnwrap(AgyUsageParser.parse(streamOutput: agyUsageSample))
        XCTAssertEqual(UsageFormat.oneLine(snap, group: AgyUsageParser.group(forModelID: "gemini-3.8-flash-medium")), "5시간 23% 사용 · 주간 48%")
        XCTAssertEqual(UsageFormat.oneLine(snap, group: AgyUsageParser.group(forModelID: "claude-opus-5-5-high")), "5시간 0% 사용 · 주간 0%")
        XCTAssertEqual(AgyUsageParser.group(forModelID: nil), "제미나이")
        XCTAssertEqual(AgyUsageParser.group(forModelID: "gpt-oss-120b-medium"), "클로드 · GPT")
    }

    func testAgyUsageRejectsOtherShapes() {
        XCTAssertNil(AgyUsageParser.parse(streamOutput: ""))
        XCTAssertNil(AgyUsageParser.parse(streamOutput: "Error: Please sign in\n"))
        XCTAssertNil(AgyUsageParser.parse(streamOutput: #"{"event":"command_result","command":{"name":"usage","data":{"groups":[]}}}"# + "\n"))
        XCTAssertNil(AgyUsageParser.parse(streamOutput: #"{"event":"command_result","command":{"data":{"groups":[{"name":"x","buckets":[{"id":"a"}]}]}}}"# + "\n"))
    }

    func testOneLineVariants() {
        let claude = UsageSnapshot(windows: [UsageWindow(name: "현재 세션", usedFraction: 0.08), UsageWindow(name: "이번 주 · 전체 모델", usedFraction: 0.48),
                                             UsageWindow(name: "이번 주 · Fable", usedFraction: 0.47)])
        XCTAssertEqual(UsageFormat.oneLine(claude), "5시간 8% 사용 · 주간 48%")
        let codex = UsageSnapshot(windows: [UsageWindow(name: "5시간", usedFraction: 0.425), UsageWindow(name: "주간", usedFraction: 0.11)], plan: "plus")
        XCTAssertEqual(UsageFormat.oneLine(codex), "5시간 43% 사용 · 주간 11%")
        let free = UsageSnapshot(windows: [UsageWindow(name: "30일", usedFraction: 0)])
        XCTAssertEqual(UsageFormat.oneLine(free), "30일 0% 사용")
        XCTAssertNil(UsageFormat.oneLine(UsageSnapshot()))
        XCTAssertNil(UsageFormat.oneLine(UsageSnapshot(windows: [UsageWindow(name: "x", usedFraction: nil)])))
        XCTAssertNil(UsageFormat.oneLine(UsageSnapshot(rawLines: ["Current session: …"])), "글 그대로 세 줄은 한 줄로 보이지 않는다")
    }

    func testOpenCodeStatsLenient() throws {
        let a = try XCTUnwrap(OpenCodeStatsParser.parse(jsonOutput: #"{"totalSessions":3,"totalCost":0.1234,"totalTokens":12345}"#))
        XCTAssertEqual(a.rawLines, ["최근 7일 이 맥에서 쓴 양 — 토큰 12,345 · 비용 $0.12"])
        let b = try XCTUnwrap(OpenCodeStatsParser.parse(jsonOutput: "잡글\n" + #"{"overview":{"cost":0,"tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":10,"write":5}}}}"#))
        XCTAssertEqual(b.rawLines, ["최근 7일 이 맥에서 쓴 양 — 토큰 140 · 비용 $0.00"])
        let c = try XCTUnwrap(OpenCodeStatsParser.parse(jsonOutput: #"{"totalCost":2}"#))
        XCTAssertEqual(c.rawLines, ["최근 7일 이 맥에서 쓴 양 — 비용 $2.00"])
        XCTAssertNil(OpenCodeStatsParser.parse(jsonOutput: #"{"hello":"world"}"#))
        XCTAssertNil(OpenCodeStatsParser.parse(jsonOutput: "not json"))
        XCTAssertNil(OpenCodeStatsParser.parse(jsonOutput: ""))
        let leak = OpenCodeStatsParser.parse(jsonOutput: #"{"totalCost":1,"apiKey":"sk-SECRETVALUE"}"#)
        XCTAssertFalse("\(String(describing: leak))".contains("SECRETVALUE"))
    }
}

@MainActor
final class CLIStatusServiceFourTests: XCTestCase {
    let agyModelsOut = "gemini-3.8-flash-low\tGemini Low\ngemini-3.8-flash-medium\tGemini Medium\nclaude-opus-5-5-high\tOpus\n"

    func fakeBin(_ names: [String]) -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fakebin4-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for n in names {
            let f = dir.appendingPathComponent(n)
            try! "#!/bin/sh\n".write(to: f, atomically: true, encoding: .utf8)
            try! FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: f.path)
        }
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir.path
    }

    let testGeminiDir = CLIEnvironment.agyGeminiDirectory(support: URL(fileURLWithPath: "/tmp/sa-support"))

    func make(_ r: ScriptedCLIRunner, bin: [String] = ["claude", "codex", "agy", "opencode"]) -> CLIStatusService {
        let path = fakeBin(bin)
        return CLIStatusService(loginPath: { path }, runnerFactory: { r }, workDirectory: { URL(fileURLWithPath: NSTemporaryDirectory()) },
                                supportDirectory: { URL(fileURLWithPath: "/tmp/sa-support") }, timeout: 5)
    }

    func testAgyLoggedInGivesModelsAndUsage() async {
        let r = ScriptedCLIRunner()
        r.reply(cmdKey(CLICommands.agyModels(geminiDir: testGeminiDir)), stdout: agyModelsOut)
        r.reply(cmdKey(CLICommands.agyUsage(geminiDir: testGeminiDir)), stdout: agyUsageSample)
        let svc = make(r)
        await svc.refresh(.gemini, force: true)
        let s = svc.state(.gemini)
        XCTAssertTrue(s.isLoggedIn)
        XCTAssertEqual(s.models.map(\.id), ["gemini-3.8-flash-low", "gemini-3.8-flash-medium", "claude-opus-5-5-high"])
        XCTAssertEqual(s.usage?.windows.count, 4)
        XCTAssertEqual(r.commands, [cmdKey(CLICommands.agyModels(geminiDir: testGeminiDir)), cmdKey(CLICommands.agyUsage(geminiDir: testGeminiDir))], "agy 만 불렀다")
    }

    func testAgyLoggedOutSkipsUsage() async {
        let r = ScriptedCLIRunner()
        r.reply(cmdKey(CLICommands.agyModels(geminiDir: testGeminiDir)), outcome: .finished(code: 1), stderr: "Error: Please sign in to view available models.\n")
        let svc = make(r)
        await svc.refresh(.gemini, force: true)
        let s = svc.state(.gemini)
        XCTAssertEqual(s.login, .loggedOut)
        XCTAssertEqual(s.models, [])
        XCTAssertEqual(s.usageNote, "로그인하면 보여요")
        XCTAssertEqual(r.commands, [cmdKey(CLICommands.agyModels(geminiDir: testGeminiDir))])
    }

    func testAgyTimeoutAndEmptyListAreUnknownNotLoggedOut() async {
        let r = ScriptedCLIRunner()
        r.reply(cmdKey(CLICommands.agyModels(geminiDir: testGeminiDir)), outcome: .timedOut)
        let svc = make(r)
        await svc.refresh(.gemini, force: true)
        XCTAssertEqual(svc.state(.gemini).login, .unknown)
        XCTAssertTrue(svc.state(.gemini).loginNote?.hasPrefix("알 수 없음") == true)
        let r2 = ScriptedCLIRunner()
        r2.reply(cmdKey(CLICommands.agyModels(geminiDir: testGeminiDir)), stdout: "")
        let svc2 = make(r2)
        await svc2.refresh(.gemini, force: true)
        XCTAssertEqual(svc2.state(.gemini).login, .unknown)
    }

    func testOpenCodeWithoutLoginIsLoggedOutButStillReadsModelsAndUsage() async {
        let r = ScriptedCLIRunner()
        r.reply("opencode auth list --standalone", stdout: "No authenticated integrations\n")
        r.reply("opencode models --standalone", stdout: "opencode/a-free\nopencode/b-free\n")
        r.reply("opencode stats --json --days 7 --standalone", stdout: #"{"totalCost":0,"totalTokens":900}"#)
        let svc = make(r)
        await svc.refresh(.opencode, force: true)
        let s = svc.state(.opencode)
        XCTAssertEqual(s.login, .loggedOut, "로그인 없이는 무료 사용량이 금방 막힌다 — 다른 CLI 처럼 로그인 안 됨")
        XCTAssertTrue(s.isLoggedOut)
        XCTAssertEqual(s.models.map(\.id), ["opencode/a-free", "opencode/b-free"])
        XCTAssertEqual(s.usage?.rawLines, ["최근 7일 이 맥에서 쓴 양 — 토큰 900 · 비용 $0.00"])
        XCTAssertEqual(s.usageNote, "구독 남은 양은 알 수 없어요 — 이 맥에서 쓴 양만")
        XCTAssertEqual(r.commands, ["opencode auth list --standalone", "opencode models --standalone", "opencode stats --json --days 7 --standalone"])
    }

    func testOpenCodeStatsFailureOmitsUsageButKeepsNote() async {
        let r = ScriptedCLIRunner()
        r.reply("opencode auth list --standalone", stdout: "OpenCode Console  Personal  stored\n")
        r.reply("opencode models --standalone", stdout: "opencode/a\n")
        r.reply("opencode stats --json --days 7 --standalone", stdout: "엉뚱한 글")
        let svc = make(r)
        await svc.refresh(.opencode, force: true)
        XCTAssertEqual(svc.state(.opencode).login, .loggedIn(CLIAccountInfo()))
        XCTAssertNil(svc.state(.opencode).usage)
        XCTAssertEqual(svc.state(.opencode).usageNote, OpenCodeStatsParser.noteText)
    }

    func testOpenCodeModelsFailureGivesNote() async {
        let r = ScriptedCLIRunner()
        r.reply("opencode auth list --standalone", stdout: "No authenticated integrations\n")
        r.reply("opencode models --standalone", outcome: .timedOut)
        r.reply("opencode stats --json --days 7 --standalone", outcome: .timedOut)
        let svc = make(r)
        await svc.refresh(.opencode, force: true)
        XCTAssertEqual(svc.state(.opencode).models, [])
        XCTAssertNotNil(svc.state(.opencode).modelsNote)
    }

    func testNotInstalledKindsAreNotRun() async {
        let r = ScriptedCLIRunner()
        let svc = make(r, bin: [])
        await svc.refreshAll(force: true)
        XCTAssertEqual(r.commands, [])
        for k in ModelKind.subscriptionCLIs { XCTAssertTrue(svc.state(k).installChecked) }
    }

    /// 옆 창을 열 때는 고른 CLI 만 읽는다 — 쓰지 않는 agy · opencode 를 띄우지 않는다.
    func testPanelOpenReadsOnlyTheSelectedCLIAndOnlyOncePerFiveMinutes() async {
        let r = ScriptedCLIRunner()
        r.reply("claude auth status", stdout: #"{"loggedIn":true,"email":"a@b.c"}"#)
        r.reply("claude -p /usage --output-format json", stdout: #"{"result":"Current session: 8% used"}"#)
        let svc = make(r)
        await svc.refreshForPanel(selected: .claude)
        XCTAssertEqual(Set(r.commands.map { $0.split(separator: " ").first.map(String.init) ?? "" }), ["claude"])
        let n = r.commands.count
        await svc.refreshForPanel(selected: .claude)
        XCTAssertEqual(r.commands.count, n, "5분 안에는 다시 읽지 않는다")
    }

    func testApplyLiveUsageMergesByName() async {
        let r = ScriptedCLIRunner()
        r.reply("claude auth status", stdout: #"{"loggedIn":true}"#)
        r.reply("claude -p /usage --output-format json", stdout: #"{"result":"Current session: 8% used · resets Nov 24 at 6:30pm (Asia/Seoul)\nCurrent week (all models): 48% used\nCurrent week (Fable): 47% used"}"#)
        let svc = make(r)
        await svc.refresh(.claude, force: true)
        svc.applyLiveUsage(.claude, UsageSnapshot(windows: [UsageWindow(name: "현재 세션", usedFraction: 0.31)]))
        let w = svc.state(.claude).usage?.windows ?? []
        XCTAssertEqual(w.count, 3)
        XCTAssertEqual(w.first { $0.name == "현재 세션" }?.usedFraction, 0.31)
        XCTAssertEqual(w.first { $0.name == "이번 주 · Fable" }?.usedFraction, 0.47)
        svc.applyLiveUsage(.claude, UsageSnapshot())   // 창이 없으면 아무 일 없음
        XCTAssertEqual(svc.state(.claude).usage?.windows.count, 3)
    }
}

@MainActor
final class ChatViewModelFourTests: XCTestCase {
    var runner: FakeRunner!
    var dir: URL!

    override func setUp() async throws {
        runner = FakeRunner()
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("vm4-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: dir) }

    func fakeBin() -> String {
        let d = dir.appendingPathComponent("bin")
        try! FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        for n in ["claude", "codex", "agy", "opencode"] {
            let f = d.appendingPathComponent(n)
            try! "#!/bin/sh\n".write(to: f, atomically: true, encoding: .utf8)
            try! FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: f.path)
        }
        return d.path
    }

    func makeVM(status: CLIStatusService? = nil, settings: AppSettingsStore? = nil) -> ChatViewModel {
        ChatViewModel(runner: runner, bridge: FakeBridge(), loginPath: { "/test/bin" },
                      workDirectory: { URL(fileURLWithPath: "/tmp/work-test") }, settings: settings, status: status)
    }

    var testGeminiDir: URL { CLIEnvironment.agyGeminiDirectory(support: dir) }

    func status(_ script: (ScriptedCLIRunner) -> Void, refresh: [ModelKind]) async -> CLIStatusService {
        let r = ScriptedCLIRunner(); script(r)
        let bin = fakeBin()
        let sup = dir!
        let svc = CLIStatusService(loginPath: { bin }, runnerFactory: { r }, workDirectory: { URL(fileURLWithPath: "/tmp") }, supportDirectory: { sup }, timeout: 5)
        for k in refresh { await svc.refresh(k, force: true) }
        return svc
    }

    func ask(_ vm: ChatViewModel, _ q: String) async { vm.input = q; await vm.send()?.value }

    func testAgyAnswerStreamsTextAndShowsUsage() async {
        runner.setScript { _, emit in emit(.stdout(Data(agySample.utf8))); return .finished(code: 0) }
        let vm = makeVM(); vm.model = .gemini
        await ask(vm, "안녕")
        XCTAssertEqual(vm.messages.last?.text, "안녕하세요")
        XCTAssertNil(vm.messages.last?.error)
        XCTAssertEqual(vm.lastUsageText, "쓴 양 128 토큰 (입력 120 · 출력 8)")
        XCTAssertEqual(runner.calls[0].executable, "agy")
        XCTAssertEqual(runner.calls[0].arguments, ["--gemini_dir", "/tmp/agy-gemini", "-p", "안녕", "--model", "gemini-3.8-flash-medium", "--output-format", "stream-json", "--settings", CLICommands.agySettingsJSON(safariTools: false)])
    }

    func testAgyUsesTheChosenModelFromTheLoadedList() async {
        let st = await status({ $0.reply(cmdKey(CLICommands.agyModels(geminiDir: testGeminiDir)), stdout: "gemini-4-neon-low\tN\ngemini-3.8-flash-medium\tM\n")
                                $0.reply(cmdKey(CLICommands.agyUsage(geminiDir: testGeminiDir)), stdout: agyUsageSample) }, refresh: [.gemini])
        let store = AppSettingsStore(directory: dir)
        let vm = makeVM(status: st, settings: store); vm.model = .gemini
        XCTAssertEqual(vm.selectedModelID(for: .gemini), "gemini-3.8-flash-medium", "기본")
        vm.setModelID("gemini-4-neon-low", for: .gemini)
        runner.setScript { _, emit in emit(.stdout(Data(agySample.utf8))); return .finished(code: 0) }
        await ask(vm, "q")
        XCTAssertEqual(runner.calls[0].arguments[5], "gemini-4-neon-low")
        XCTAssertEqual(AppSettingsStore(directory: dir).current.models["gemini"], "gemini-4-neon-low")
    }

    func testAgyPromptHasNoWebSearchPrefixAndNoNotice() async {
        runner.setScript { _, emit in emit(.stdout(Data(agySample.utf8))); return .finished(code: 0) }
        let vm = makeVM(); vm.model = .gemini
        await ask(vm, "날씨")
        XCTAssertEqual(runner.calls[0].arguments[3], "날씨")
        XCTAssertNil(vm.messages.last?.notice)
    }

    func testAgyKnownLoggedOutNeverStartsAProcess() async {
        let st = await status({ $0.reply(cmdKey(CLICommands.agyModels(geminiDir: testGeminiDir)), outcome: .finished(code: 1), stderr: "Please sign in") }, refresh: [.gemini])
        let vm = makeVM(status: st)
        XCTAssertFalse(vm.selectCLI(.gemini), "로그인 안 된 걸 알면 고르지 못한다")
        XCTAssertEqual(vm.hint, "제미나이(agy) 로그인이 안 돼 있어요 — 메뉴 막대 「설정…」 에서 로그인해 주세요")
        vm.model = .gemini   // 개발용 주소 등으로 들어온 경우
        await ask(vm, "q")
        XCTAssertEqual(runner.calls.count, 0)
        XCTAssertEqual(vm.messages.last?.error, "설정에서 제미나이 로그인을 해 주세요")
    }

    func testOpenCodeAnswerWithFreeModelDefaultAndNoNotice() async {
        let st = await status({ $0.reply("opencode auth list --standalone", stdout: "OpenCode Console  Personal  stored\n")
                                $0.reply("opencode models --standalone", stdout: "opencode/pro\nopencode/x-free\n")
                                $0.reply("opencode stats --json --days 7 --standalone", stdout: #"{"totalCost":0,"totalTokens":5}"#) }, refresh: [.opencode])
        let vm = makeVM(status: st)
        XCTAssertTrue(vm.selectCLI(.opencode))
        XCTAssertEqual(vm.model, .opencode)
        XCTAssertEqual(vm.selectedModelID(for: .opencode), "opencode/x-free")
        runner.setScript { _, emit in emit(.stdout(Data(opencodeSample.utf8))); return .finished(code: 0) }
        await ask(vm, "안녕")
        XCTAssertEqual(runner.calls[0].arguments, ["run", "안녕", "-m", "opencode/x-free", "--format", "json", "--archived", "--standalone"])
        XCTAssertEqual(vm.messages.last?.text, "안녕하세요")
        XCTAssertNil(vm.messages.last?.notice)
        XCTAssertEqual(vm.lastUsageText, "쓴 양 62 토큰 (입력 55 · 출력 7 · 캐시 20)")
        XCTAssertEqual(vm.remainingUsageText, "최근 7일 이 맥에서 쓴 양 — 토큰 5 · 비용 $0.00")
    }

    func testOpenCodeLoggedOutCannotBeSelectedLikeOtherCLIs() async {
        let st = await status({ $0.reply("opencode auth list --standalone", stdout: "No authenticated integrations\n")
                                $0.reply("opencode models --standalone", stdout: "opencode/x-free\n")
                                $0.reply("opencode stats --json --days 7 --standalone", stdout: #"{"totalCost":0}"#) }, refresh: [.opencode])
        let vm = makeVM(status: st)
        XCTAssertFalse(vm.selectCLI(.opencode))
        XCTAssertEqual(vm.hint, "opencode 로그인이 안 돼 있어요 — 메뉴 막대 「설정…」 에서 로그인해 주세요")
    }

    func testOpenCodeWithoutLoadedListRunsWithoutDashM() async {
        runner.setScript { _, emit in emit(.stdout(Data(opencodeSample.utf8))); return .finished(code: 0) }
        let vm = makeVM(); vm.model = .opencode
        await ask(vm, "q")
        XCTAssertFalse(runner.calls[0].arguments.contains("-m"))
        XCTAssertTrue(runner.calls[0].arguments.contains("--standalone"))
    }

    func testRemainingUsageLineFollowsTheChosenCLIAndModelGroup() async {
        let st = await status({ $0.reply(cmdKey(CLICommands.agyModels(geminiDir: testGeminiDir)), stdout: "gemini-3.8-flash-medium\tM\nclaude-opus-5-5-high\tO\n")
                                $0.reply(cmdKey(CLICommands.agyUsage(geminiDir: testGeminiDir)), stdout: agyUsageSample)
                                $0.reply("claude auth status", stdout: #"{"loggedIn":true}"#)
                                $0.reply("claude -p /usage --output-format json", stdout: #"{"result":"Current session: 8% used\nCurrent week (all models): 48% used"}"#) },
                              refresh: [.gemini, .claude])
        let vm = makeVM(status: st)
        XCTAssertEqual(vm.remainingUsageText, "5시간 8% 사용 · 주간 48%", "클로드")
        vm.model = .gemini
        XCTAssertEqual(vm.remainingUsageText, "5시간 23% 사용 · 주간 48%")
        vm.setModelID("claude-opus-5-5-high", for: .gemini)
        XCTAssertEqual(vm.remainingUsageText, "5시간 0% 사용 · 주간 0%", "고른 모델 묶음의 창")
        vm.model = .chatgpt
        XCTAssertNil(vm.remainingUsageText, "못 읽은 CLI 는 한 줄을 숨긴다")
        XCTAssertNil(makeVM().remainingUsageText, "상태 서비스가 없으면 숨김")
    }

    func testClaudeAnswerRateLimitEventUpdatesTheLine() async {
        let st = await status({ $0.reply("claude auth status", stdout: #"{"loggedIn":true}"#)
                                $0.reply("claude -p /usage --output-format json", stdout: #"{"result":"Current session: 8% used\nCurrent week (all models): 48% used"}"#) },
                              refresh: [.claude])
        let vm = makeVM(status: st)
        let rl = #"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.31,"resetsAt":1798013770},"seven_day":{"utilization":0.5,"resetsAt":1798500000}}},"session_id":"s1"}"# + "\n"
        runner.setScript { _, emit in
            emit(claudeAssistantLine("답")); emit(.stdout(Data(rl.utf8))); emit(claudeResultLine(text: "답")); return .finished(code: 0)
        }
        await ask(vm, "q")
        XCTAssertEqual(vm.remainingUsageText, "5시간 31% 사용 · 주간 50%")
    }

    func testAllFourChipsAreSelectable() {
        let vm = makeVM()
        for k in [ModelKind.gemini, .chatgpt, .opencode, .claude] { XCTAssertTrue(vm.selectCLI(k)); XCTAssertEqual(vm.model, k) }
    }

    func testAgentModeStillOnlyClaude() async {
        // 일 맡기기 · 루틴은 그대로 클로드만 — 묻기에서 opencode 를 골라 둬도 일 맡기기 명령은 claude(AgentCommandBuilder).
        let res = URL(fileURLWithPath: "/tmp/res"), mem = URL(fileURLWithPath: "/tmp/mem")
        let gate = GateInfo(socketPath: "/tmp/g.sock", token: "t")
        let c = AgentCommandBuilder.build(resources: res, gate: gate, memoryHome: mem, resumeSessionID: nil)
        XCTAssertEqual(c.executable, "claude")
    }
}
