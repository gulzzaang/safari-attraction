import XCTest
@testable import AppCore

// 조각 5 고침 묶음 — 앱 전용 설정 파일(codex config.toml · opencode.json) · agy 도구 막기 · 폴더 실패 · 로그인 상태 판정 · 읽기 흐름.

/// 첫 `claude auth status` 호출은 문을 열 때까지 멈춰 있는 가짜 실행기(읽는 중 새로 고침 · 앱 종료 시험용).
final class GatedStatusRunner: CommandRunning, InteractiveRunning, @unchecked Sendable {
    private let lock = NSLock()
    private var _statusCalls = 0
    private var _stops = 0
    let gate = Gate()
    var statusCalls: Int { lock.withLock { _statusCalls } }
    var stops: Int { lock.withLock { _stops } }
    func run(executable: String, arguments: [String], workDir: URL, path: String, timeout: TimeInterval,
             onEvent: @escaping @Sendable (RunEvent) -> Void) async -> RunOutcome {
        let n = lock.withLock { () -> Int in _statusCalls += 1; return _statusCalls }
        if n == 1 { await gate.wait() }
        return .finished(code: 1)   // claude auth status 종료 1 = 로그인 안 됨 → 한 번 읽기 = 이 호출 하나
    }
    func runInteractive(executable: String, arguments: [String], workDir: URL, path: String, timeout: TimeInterval,
                        initialLines: [String], onEvent: @escaping @Sendable (RunEvent) -> Void) async -> RunOutcome { .stopped }
    func write(_ line: String) throws {}
    func closeInput() {}
    func stop() { lock.withLock { _stops += 1 }; Task { await gate.open() } }
}

final class ManagedConfigTests: XCTestCase {
    func tempDir() -> URL {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("managed-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: u) }
        return u
    }
    let expectedFeatures = ["shell_tool", "unified_exec", "unified_exec_tty", "shell_snapshot", "computer_use", "browser_use", "browser_use_external",
                            "browser_use_full_cdp_access", "in_app_browser", "apps", "plugins", "remote_plugin", "hooks", "multi_agent", "view_image",
                            "image_generation", "skill_mcp_dependency_install", "workspace_dependencies", "worktrees"]

    func testDisabledFeatureListIsExactlyTheVerifiedOne() {
        XCTAssertEqual(CLIManagedConfig.codexDisabledFeatures, expectedFeatures)
    }

    func testCodexExecDisablesEveryFeatureViaDashCAndKeepsPromptLast() {
        let a = CLICommands.codexExec(prompt: "질문", modelID: "gpt-6-luna").arguments
        for f in expectedFeatures {
            let i = a.firstIndex(of: "features.\(f)=false")
            XCTAssertNotNil(i, f)
            if let i { XCTAssertEqual(a[i - 1], "-c", f) }
        }
        XCTAssertEqual(a.filter { $0.hasPrefix("features.") }.count, expectedFeatures.count)
        XCTAssertFalse(a.contains("--disable"), "--disable 은 모르는 기능 이름이면 종료 1 이라 쓰지 않는다")
        XCTAssertEqual(a.last, "질문")
        XCTAssertTrue(a.contains("cli_auth_credentials_store=file"), "exec 의 -c 는 그대로(이중)")
    }

    func testFreshConfigHasAuthStoreFirstAndAllFeaturesOff() {
        let t = CLIManagedConfig.codexConfig(merging: nil)
        let lines = t.components(separatedBy: "\n")
        let auth = try! XCTUnwrap(lines.firstIndex { $0 == "cli_auth_credentials_store = \"file\"" })
        let table = try! XCTUnwrap(lines.firstIndex { $0 == "[features]" })
        XCTAssertLessThan(auth, table, "최상위 키는 표(table) 앞에")
        for f in expectedFeatures { XCTAssertTrue(lines.contains("\(f) = false"), f) }
        XCTAssertTrue(t.hasSuffix("\n"))
    }

    func testMergingIsIdempotentAndKeepsOtherLinesButDropsConflictingAuthStore() {
        let once = CLIManagedConfig.codexConfig(merging: nil)
        XCTAssertEqual(CLIManagedConfig.codexConfig(merging: once), once)
        let user = "model = \"gpt-6-luna\"\ncli_auth_credentials_store = \"keyring\"\n[projects]\nx = 1\n"
        let merged = CLIManagedConfig.codexConfig(merging: user)
        XCTAssertTrue(merged.contains("model = \"gpt-6-luna\""))
        XCTAssertTrue(merged.contains("[projects]"))
        XCTAssertFalse(merged.contains("keyring"), "인증 저장 줄이 겹치면 앱 값(file)만")
        XCTAssertEqual(merged.components(separatedBy: "cli_auth_credentials_store").count - 1, 1)
        XCTAssertEqual(CLIManagedConfig.codexConfig(merging: merged), merged)
        // 앱이 관리하는 덩어리를 손으로 고쳐도 다시 맞춘다.
        let tampered = once.replacingOccurrences(of: "shell_tool = false", with: "shell_tool = true")
        XCTAssertEqual(CLIManagedConfig.codexConfig(merging: tampered), once)
    }

    func testPrepareDirectoriesWritesBothFilesPrivately() throws {
        let s = tempDir()
        try CLIEnvironment.prepareDirectories(support: s)
        let toml = CLIManagedConfig.codexConfigURL(support: s)
        XCTAssertEqual(toml.path, s.path + "/codex-home/config.toml")
        XCTAssertEqual(try String(contentsOf: toml, encoding: .utf8), CLIManagedConfig.codexConfig(merging: nil))
        let json = CLIManagedConfig.opencodeConfigURL(support: s)
        XCTAssertEqual(json.path, s.path + "/opencode-xdg/config/opencode/opencode.json")
        XCTAssertEqual(try String(contentsOf: json, encoding: .utf8), CLIManagedConfig.opencodeConfigJSON + "\n")
        for u in [toml, json] {
            let perm = (try FileManager.default.attributesOfItem(atPath: u.path)[.posixPermissions] as? NSNumber)?.intValue
            XCTAssertEqual(perm, 0o600)
        }
        // 고쳐 놓아도 다음 준비 때 다시 맞춘다.
        try "[features]\nshell_tool = true\n".write(to: toml, atomically: true, encoding: .utf8)
        try "{}".write(to: json, atomically: true, encoding: .utf8)
        try CLIEnvironment.prepareDirectories(support: s)
        XCTAssertEqual(try String(contentsOf: toml, encoding: .utf8), CLIManagedConfig.codexConfig(merging: nil))
        XCTAssertEqual(try String(contentsOf: json, encoding: .utf8), CLIManagedConfig.opencodeConfigJSON + "\n")
    }

    func testOpenCodeConfigContentDeniesEverything() throws {
        XCTAssertEqual(CLIManagedConfig.opencodeConfigJSON,
                       #"{"$schema":"https://opencode.ai/config.json","permission":{"*":"deny","edit":"deny","bash":"deny","webfetch":"deny","read":"deny","external_directory":"deny"},"tools":{"bash":false,"read":false,"write":false,"edit":false,"list":false,"glob":false,"grep":false,"webfetch":false,"patch":false,"task":false,"todowrite":false,"todoread":false}}"#)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(CLIManagedConfig.opencodeConfigJSON.utf8)) as? [String: Any])
        let tools = try XCTUnwrap(obj["tools"] as? [String: Bool])
        XCTAssertEqual(tools.count, 12)
        XCTAssertFalse(tools.values.contains(true))
        XCTAssertEqual((obj["permission"] as? [String: String])?["*"], "deny")
    }
}

final class AgySettingsTests: XCTestCase {
    func testDenyJSONExactAndWebSearchOpensReadURL() throws {
        XCTAssertEqual(CLICommands.agySettingsJSON(webSearch: false),
                       #"{"permissions":{"deny":["read_file(*)","write_file(*)","command(*)","read_url(*)","execute_url(*)","mcp(*)"]}}"#)
        XCTAssertEqual(CLICommands.agySettingsJSON(webSearch: true),
                       #"{"permissions":{"deny":["read_file(*)","write_file(*)","command(*)","execute_url(*)","mcp(*)"]}}"#)
        for w in [false, true] {
            let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(CLICommands.agySettingsJSON(webSearch: w).utf8)) as? [String: Any])
            XCTAssertNotNil((obj["permissions"] as? [String: Any])?["deny"] as? [String])
        }
    }

    func testEveryAgyCommandCarriesTheSettings() {
        let off = CLICommands.agySettingsJSON(webSearch: false), on = CLICommands.agySettingsJSON(webSearch: true)
        func settings(_ a: [String]) -> String? { a.firstIndex(of: "--settings").map { a[$0 + 1] } }
        XCTAssertEqual(settings(CLICommands.agyModels.arguments), off)
        XCTAssertEqual(settings(CLICommands.agyUsage.arguments), off)
        XCTAssertEqual(settings(CLICommands.agyAsk(prompt: "q", modelID: nil).arguments), off)
        XCTAssertEqual(settings(CLICommands.agyAsk(prompt: "q", modelID: nil, webSearch: true).arguments), on)
        XCTAssertEqual(CLICommands.agyLogin.arguments, [], "로그인 TUI 는 인자 없이")
    }

    func testCommandBuilderPassesWebSearchToTheSettings() {
        let work = URL(fileURLWithPath: "/tmp")
        let web = CommandBuilder.build(AskRequest(question: "q", model: .gemini, webSearch: true), workDir: work).arguments
        XCTAssertFalse(web.last!.contains("read_url"), "웹 검색을 켜면 검색 결과 페이지를 읽게")
        XCTAssertTrue(web.last!.contains("command(*)"))
        let plain = CommandBuilder.build(AskRequest(question: "q", model: .gemini), workDir: work).arguments
        XCTAssertTrue(plain.last!.contains("read_url(*)"))
    }
}

final class FolderBlockedTests: XCTestCase {
    func testBlockedRunnerNeverRunsAndExplainsInKorean() async {
        let r = FolderBlockedRunner(reason: "권한 없음")
        let o = await r.run(executable: "claude", arguments: ["-p", "x"], workDir: URL(fileURLWithPath: "/tmp"), path: "/bin", timeout: 5, onEvent: { _ in XCTFail("출력이 없어야 한다") })
        XCTAssertEqual(o, .failed("앱 전용 설정 폴더를 만들지 못했어요 — 권한 없음"))
        let o2 = await r.runInteractive(executable: "codex", arguments: [], workDir: URL(fileURLWithPath: "/tmp"), path: "/bin", timeout: 5, initialLines: [], onEvent: { _ in })
        XCTAssertEqual(o2, .failed("앱 전용 설정 폴더를 만들지 못했어요 — 권한 없음"))
    }

    @MainActor func testAskThroughBlockedRunnerShowsTheReasonForEveryCLI() async {
        let r = FolderBlockedRunner(reason: "읽기 전용 디스크")
        for kind in [ModelKind.claude, .gemini, .opencode, .chatgpt] {
            let vm = ChatViewModel(runner: r, bridge: FakeBridge(), loginPath: { "/test/bin" }, workDirectory: { URL(fileURLWithPath: "/tmp/work-test") })
            vm.model = kind; vm.input = "q"
            await vm.send()?.value
            let e = vm.messages.last?.error ?? ""
            XCTAssertTrue(e.contains("앱 전용 설정 폴더를 만들지 못했어요 — 읽기 전용 디스크"), "\(kind): \(e)")
        }
    }

    func testOverridesStayAppliedEvenWithoutFolders() {
        // 덮어쓰기 사전은 폴더가 없어도 순수 경로 글자라 늘 만들 수 있다 — 사용자 ~/.codex · ~/.claude 로 되돌아가지 않는다.
        let s = URL(fileURLWithPath: "/nonexistent/support")
        let child = ProcessRunner.childEnvironment(base: ["CODEX_HOME": "/Users/me/.codex"], path: "/bin", overrides: CLIEnvironment.overrides(support: s))
        XCTAssertEqual(child["CODEX_HOME"], "/nonexistent/support/codex-home")
    }
}

final class LoginStatusJudgmentTests: XCTestCase {
    func testOnlyExitCodeOneMeansLoggedOut() {
        XCTAssertEqual(CLIAccountParser.parseClaudeStatus(stdout: "", exitCode: 1), .loggedOut)
        XCTAssertEqual(CLIAccountParser.parseClaudeStatus(stdout: "", exitCode: 2), .unknown)
        XCTAssertEqual(CLIAccountParser.parseClaudeStatus(stdout: "", exitCode: 127), .unknown)
        XCTAssertEqual(CLIAccountParser.parseClaudeStatus(stdout: #"{"loggedIn":true}"#, exitCode: 0), .loggedIn(CLIAccountInfo()))
        XCTAssertEqual(CLIAccountParser.parseCodexStatus(output: "Not logged in", exitCode: 1), .loggedOut)
        XCTAssertEqual(CLIAccountParser.parseCodexStatus(output: "oops", exitCode: 2), .unknown)
        XCTAssertEqual(CLIAccountParser.parseCodexStatus(output: "oops", exitCode: 137), .unknown)
        XCTAssertEqual(CLIAccountParser.parseCodexStatus(output: "Logged in using ChatGPT", exitCode: 0), .loggedIn(CLIAccountInfo(detail: "ChatGPT 계정")))
    }

    @MainActor func testOtherExitCodesGiveUnknownWithReasonAndDoNotBlockTheChip() async {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("judge-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for n in ["claude", "codex"] {
            let f = dir.appendingPathComponent(n)
            try! "#!/bin/sh\n".write(to: f, atomically: true, encoding: .utf8)
            try! FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: f.path)
        }
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let r = ScriptedCLIRunner()
        r.reply("claude auth status", outcome: .finished(code: 2), stderr: "boom sk-SECRETVALUE")
        r.reply("codex login status", outcome: .finished(code: 137))
        let svc = CLIStatusService(loginPath: { dir.path }, runnerFactory: { r }, workDirectory: { URL(fileURLWithPath: "/tmp") }, timeout: 5)
        await svc.refreshAll(force: true, agyAutoRead: false)
        XCTAssertEqual(svc.state(.claude).login, .unknown)
        XCTAssertEqual(svc.state(.claude).loginNote, "알 수 없음 — 상태 확인이 종료 코드 2 로 끝났어요")
        XCTAssertFalse(svc.state(.claude).loginNote?.contains("SECRETVALUE") ?? false)
        XCTAssertEqual(svc.state(.chatgpt).loginNote, "알 수 없음 — 상태 확인이 종료 코드 137 로 끝났어요")
        let vm = ChatViewModel(runner: FakeRunner(), bridge: FakeBridge(), loginPath: { "/x" }, status: svc)
        XCTAssertTrue(vm.selectCLI(.chatgpt), "알 수 없음은 칩을 막지 않는다")
    }
}

final class ChildEnvironmentKeysTests: XCTestCase {
    func testApiKeyVariablesAreStripped() {
        let base = ["ANTHROPIC_API_KEY": "a", "OPENAI_API_KEY": "b", "CODEX_API_KEY": "c", "GEMINI_API_KEY": "d", "GOOGLE_API_KEY": "e", "KEEP": "1"]
        XCTAssertEqual(ProcessRunner.childEnvironment(base: base, path: "/p"), ["KEEP": "1", "PATH": "/p"])
        XCTAssertEqual(ProcessRunner.strippedAPIKeyVariables, ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"])
    }

    func testRealChildDoesNotSeeKeys() async {
        setenv("OPENAI_API_KEY", "should-not-pass", 1); setenv("GEMINI_API_KEY", "should-not-pass", 1)
        defer { unsetenv("OPENAI_API_KEY"); unsetenv("GEMINI_API_KEY") }
        let c = Collector()
        let o = await ProcessRunner().run(executable: "/usr/bin/env", arguments: [], workDir: URL(fileURLWithPath: NSTemporaryDirectory()),
                                          path: "/bin:/usr/bin", timeout: 20, onEvent: { c.handle($0) })
        XCTAssertEqual(o, .finished(code: 0))
        XCTAssertFalse(c.stdout.contains("should-not-pass"))
        XCTAssertFalse(c.stdout.contains("OPENAI_API_KEY"))
    }
}

final class LoginCommandFileTests: XCTestCase {
    func tempDir() -> URL {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("loginfile-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: u) }
        return u
    }
    func fakeBin(_ names: [String]) -> String {
        let d = tempDir().appendingPathComponent("my bin")   // 공백이 든 경로
        try! FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        for n in names {
            let f = d.appendingPathComponent(n)
            try! "#!/bin/sh\n".write(to: f, atomically: true, encoding: .utf8)
            try! FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: f.path)
        }
        return d.path
    }

    func testAbsolutePathLoginPathAndUnsetAreWritten() throws {
        let bin = fakeBin(["claude", "agy", "opencode", "codex"])
        let s = tempDir()
        let loginPath = bin + ":/usr/bin"
        for (kind, name) in [(ModelKind.claude, "claude"), (.gemini, "agy"), (.opencode, "opencode"), (.chatgpt, "codex")] {
            let t = try String(contentsOf: TerminalLogin.writeLoginFile(kind: kind, support: s, loginPath: loginPath), encoding: .utf8)
            XCTAssertTrue(t.contains("export PATH='\(loginPath)'"), name)
            XCTAssertTrue(t.contains("'\(bin)/\(name)'"), "\(name): 이름 대신 찾은 절대 경로")
            XCTAssertTrue(t.contains("\nunset ANTHROPIC_API_KEY CODEX_API_KEY GEMINI_API_KEY GOOGLE_API_KEY OPENAI_API_KEY\n"), name)
            let lines = t.components(separatedBy: "\n")
            XCTAssertLessThan(lines.firstIndex { $0.hasPrefix("unset ") }!, lines.firstIndex { $0.hasPrefix("export ") }!, "unset 이 먼저")
            XCTAssertFalse(t.contains("sk-"), "키 값 없음")
        }
    }

    func testFallsBackToTheNameWhenNotFoundAndWithoutLoginPath() throws {
        let s = tempDir()
        let none = try String(contentsOf: TerminalLogin.writeLoginFile(kind: .claude, support: s, loginPath: "/nonexistent-dir"), encoding: .utf8)
        XCTAssertTrue(none.contains("\n'claude' 'auth' 'login' '--claudeai'\n"))
        XCTAssertTrue(none.contains("export PATH='/nonexistent-dir'"))
        let plain = try String(contentsOf: TerminalLogin.writeLoginFile(kind: .claude, support: s), encoding: .utf8)
        XCTAssertFalse(plain.contains("export PATH"))
        XCTAssertTrue(plain.contains("\n'claude' 'auth' 'login' '--claudeai'\n"))
    }
}

final class OpenCodeFreeLimitTests: XCTestCase {
    let msg = "opencode 무료 사용량이 다 찼어요 — 설정에서 opencode 로그인을 해 주세요"
    func run(_ s: String) -> [StreamEvent] { var p = OpenCodeStreamParser(); return p.feed(Data(s.utf8)) + p.finish() }

    func testFreeLimitInAnyField() {
        XCTAssertEqual(run(#"{"type":"error","error":{"name":"APIError","data":{"message":"Free usage limit reached","code":"provider.free-limit"}}}"# + "\n"), [.error(msg)])
        XCTAssertEqual(run(#"{"type":"error","error":{"name":"provider.free-limit"}}"# + "\n"), [.error(msg)])
        XCTAssertEqual(run("Error: Free usage limit reached\n"), [.error(msg)])
        XCTAssertEqual(ModelKind.opencodeFreeLimitMessage, msg)
    }

    func testReaderMapsFreeLimitOnStderr() {
        var r = ModelOutputReader(model: .opencode)
        _ = r.handle(.stderr(Data("provider.free-limit: Free usage limit reached\n".utf8)))
        XCTAssertEqual(r.finish(outcome: .finished(code: 1)), [.error(msg)])
        var other = ModelOutputReader(model: .chatgpt)
        _ = other.handle(.stderr(Data("provider.free-limit\n".utf8)))
        XCTAssertNotEqual(other.finish(outcome: .finished(code: 1)), [.error(msg)], "opencode 에만 해당")
    }

    func testOpenCodeStatusAndNotes() {
        XCTAssertEqual(ModelKind.opencode.loginNeededMessage, "설정에서 opencode 로그인을 해 주세요 — 로그인 없이 쓰는 무료 사용량은 금방 막혀요")
        XCTAssertEqual(CLIModels.loadFailureNote(for: .chatgpt), "모델 목록을 못 불러왔어요 — 로그인했는지, codex 가 최신인지 확인해 주세요(지금은 기본 모델로 물어요)")
        XCTAssertTrue(CLIModels.loadFailureNote(for: .gemini).contains("기본 모델"))
        XCTAssertFalse(CLIModels.loadFailureNote(for: .gemini).contains("codex"))
        XCTAssertTrue(CLIModels.loadFailureNote(for: .opencode).contains("opencode 기본 모델"))
    }
}

@MainActor
final class StatusFlowFixesTests: XCTestCase {
    func fakeBin(_ names: [String]) -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fakebin5-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for n in names {
            let f = dir.appendingPathComponent(n)
            try! "#!/bin/sh\n".write(to: f, atomically: true, encoding: .utf8)
            try! FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: f.path)
        }
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir.path
    }
    func waitUntil(_ cond: @escaping () -> Bool) async {
        for _ in 0..<400 { if cond() { return }; try? await Task.sleep(nanoseconds: 5_000_000) }
        XCTFail("조건이 오지 않았다")
    }

    // 읽는 중 강제 새로 고침은 버리지 않고 끝난 뒤 한 번 더
    func testForcedRefreshDuringReadRunsOnceMoreAfterwards() async {
        let g = GatedStatusRunner()
        let bin = fakeBin(["claude"])
        let svc = CLIStatusService(loginPath: { bin }, runnerFactory: { g }, workDirectory: { URL(fileURLWithPath: "/tmp") }, timeout: 5)
        let first = Task { await svc.refresh(.claude, force: true) }
        await waitUntil { g.statusCalls == 1 }
        await svc.refresh(.claude, force: true)        // 읽는 중에 들어옴 → 예약만 하고 돌아옴
        XCTAssertEqual(g.statusCalls, 1)
        await svc.refresh(.claude, force: true)        // 예약은 하나로 합쳐진다
        await g.gate.open()
        await first.value
        XCTAssertEqual(g.statusCalls, 2, "버리지 않고 끝난 뒤 한 번 더(합쳐서 한 번)")
        XCTAssertFalse(svc.state(.claude).isRefreshing)
    }

    func testNonForcedRefreshDuringReadIsStillDropped() async {
        let g = GatedStatusRunner()
        let bin = fakeBin(["claude"])
        let svc = CLIStatusService(loginPath: { bin }, runnerFactory: { g }, workDirectory: { URL(fileURLWithPath: "/tmp") }, timeout: 5)
        let first = Task { await svc.refresh(.claude, force: true) }
        await waitUntil { g.statusCalls == 1 }
        await svc.refresh(.claude, force: false)
        await g.gate.open()
        await first.value
        XCTAssertEqual(g.statusCalls, 1)
    }

    // 앱을 끝낼 때 읽는 실행기도 stop
    func testShutdownStopsRunnersOfReadsInFlightAndBlocksNewOnes() async {
        let g = GatedStatusRunner()
        let bin = fakeBin(["claude"])
        let svc = CLIStatusService(loginPath: { bin }, runnerFactory: { g }, workDirectory: { URL(fileURLWithPath: "/tmp") }, timeout: 5)
        let first = Task { await svc.refresh(.claude, force: true) }
        await waitUntil { g.statusCalls == 1 }
        svc.shutdown()
        XCTAssertGreaterThanOrEqual(g.stops, 1)
        await first.value
        let calls = g.statusCalls
        await svc.refresh(.claude, force: true)
        XCTAssertEqual(g.statusCalls, calls, "끝내는 중에는 새로 읽지 않는다")
    }

    // HOME 방식의 제미나이는 자동으로 읽지 않는다
    func testIsolatedAgyIsNotAutoReadUntilAPersonRefreshes() async {
        let r = ScriptedCLIRunner()
        r.reply(cmdKey(CLICommands.agyModels), stdout: "gemini-3.8-flash-medium\tM\n")
        r.reply(cmdKey(CLICommands.agyUsage), stdout: agyUsageSample)
        r.reply("claude auth status", stdout: #"{"loggedIn":true}"#)
        r.reply("claude -p /usage --output-format json", stdout: #"{"result":"Current session: 8% used"}"#)
        let bin = fakeBin(["claude", "codex", "agy", "opencode"])
        let clock = FakeClock()
        let svc = CLIStatusService(loginPath: { bin }, runnerFactory: { r }, workDirectory: { URL(fileURLWithPath: "/tmp") }, now: { clock.date }, timeout: 5)
        await svc.refreshForPanel(selected: .gemini, agyAutoRead: false)
        XCTAssertEqual(r.commands, [], "옆 창을 열어도 agy 를 안 띄운다")
        await svc.refreshAll(force: false, agyAutoRead: false)
        XCTAssertFalse(r.commands.contains { $0.hasPrefix("agy") }, "설정 창을 열어도 agy 는 건너뛴다(나머지는 읽는다)")
        XCTAssertTrue(r.commands.contains { $0.hasPrefix("claude") })
        XCTAssertNil(svc.state(.gemini).lastRefresh)
        await svc.refresh(.gemini, force: true)          // 사람이 새로 고침을 누름
        XCTAssertTrue(svc.state(.gemini).isLoggedIn)
        let n = r.commands.count
        clock.advance(600)
        await svc.refreshForPanel(selected: .gemini, agyAutoRead: false)
        XCTAssertGreaterThan(r.commands.count, n, "한 번 읽은 뒤에는 5분 규칙대로 다시 읽는다")
    }

    func testAgyAutoReadFollowsTheChosenMode() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("vm5-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let store = AppSettingsStore(directory: dir)
        let r = ScriptedCLIRunner()
        r.reply(cmdKey(CLICommands.agyModels), stdout: "gemini-3.8-flash-medium\tM\n")
        r.reply(cmdKey(CLICommands.agyUsage), stdout: agyUsageSample)
        let bin = fakeBin(["agy"])
        let svc = CLIStatusService(loginPath: { bin }, runnerFactory: { r }, workDirectory: { URL(fileURLWithPath: "/tmp") }, timeout: 5)
        let vm = ChatViewModel(runner: FakeRunner(), bridge: FakeBridge(), loginPath: { "/x" }, settings: store, status: svc)
        XCTAssertFalse(vm.agyAutoRead, "기본(앱 전용 HOME)은 자동으로 읽지 않는다")
        await vm.refreshStatus(for: .gemini)
        XCTAssertEqual(r.commands, [])
        try store.update { $0.agyMode = .shared }
        XCTAssertTrue(vm.agyAutoRead)
        await vm.refreshStatus(for: .gemini)
        XCTAssertEqual(r.commands, [cmdKey(CLICommands.agyModels), cmdKey(CLICommands.agyUsage)])
    }

    func testBlockedRunnerGivesUnknownStatusNotACrash() async {
        let b = FolderBlockedRunner(reason: "x")
        let bin = fakeBin(["claude", "codex", "agy", "opencode"])
        let svc = CLIStatusService(loginPath: { bin }, runnerFactory: { b }, workDirectory: { URL(fileURLWithPath: "/tmp") }, timeout: 5)
        await svc.refreshAll(force: true)
        for k in ModelKind.subscriptionCLIs { XCTAssertEqual(svc.state(k).login, .unknown, "\(k)") }
    }
}
