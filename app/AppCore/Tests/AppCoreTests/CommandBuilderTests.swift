import XCTest
@testable import AppCore

final class CommandBuilderTests: XCTestCase {
    let support = URL(fileURLWithPath: "/tmp/sa-support")
    var work: URL { support.appendingPathComponent("work") }
    let page = PageContext(title: "제목", url: "https://example.com/a", selection: nil)
    var tools: SafariTools {
        SafariTools(runScript: "/App/Contents/Resources/safari-attraction/run.sh",
                    gateFile: support.appendingPathComponent("gate-link.json").path,
                    memoryHome: support.appendingPathComponent("memory").path)
    }

    func req(_ model: ModelKind, page: PageContext? = nil, history: [Turn] = [],
             session: String? = nil, modelID: String? = nil, effort: String? = nil,
             safariTools: SafariTools? = nil, q: String = "질문") -> AskRequest {
        AskRequest(question: q, model: model, page: page, history: history,
                   claudeSessionID: session, modelID: modelID, effort: effort, safariTools: safariTools)
    }

    // MARK: Claude
    func testClaudeWithoutAndWithToolsAndEffort() throws {
        let plain = CommandBuilder.build(req(.claude), workDir: work)
        XCTAssertEqual(plain.executable, "claude")
        XCTAssertEqual(plain.arguments, [
            "-p", "질문", "--output-format", "stream-json", "--verbose", "--model", "sonnet",
            "--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch",
            "--strict-mcp-config", "--safe-mode",
        ])
        XCTAssertEqual(plain.environment, [:])

        let withEffort = CommandBuilder.build(req(.claude, effort: "high"), workDir: work)
        XCTAssertEqual(withEffort.arguments.suffix(2), ["--effort", "high"])

        let withTools = CommandBuilder.build(req(.claude, session: "abc-123", effort: "xhigh", safariTools: tools), workDir: work)
        XCTAssertFalse(withTools.arguments.contains("--safe-mode"))
        XCTAssertTrue(withTools.arguments.contains("--setting-sources"))
        let ssIdx = try XCTUnwrap(withTools.arguments.firstIndex(of: "--setting-sources"))
        XCTAssertEqual(withTools.arguments[ssIdx + 1], "")
        XCTAssertTrue(withTools.arguments.contains("--strict-mcp-config"))
        let mcpIdx = try XCTUnwrap(withTools.arguments.firstIndex(of: "--mcp-config"))
        let mcpData = Data(withTools.arguments[mcpIdx + 1].utf8)
        let mcpObj = try XCTUnwrap(JSONSerialization.jsonObject(with: mcpData) as? [String: Any])
        let servers = try XCTUnwrap(mcpObj["mcpServers"] as? [String: Any])
        let sa = try XCTUnwrap(servers["safari-attraction"] as? [String: Any])
        XCTAssertEqual(sa["command"] as? String, "/bin/sh")
        XCTAssertEqual(sa["args"] as? [String], [tools.runScript])
        XCTAssertEqual(sa["env"] as? [String: String], [
            "SAFARI_ATTRACTION_GATE_FILE": tools.gateFile,
            "SAFARI_ATTRACTION_NO_PERMISSION_PROMPTS": "1",
            "SAFARI_ATTRACTION_HOME": tools.memoryHome,
        ])
        let allowedIdx = try XCTUnwrap(withTools.arguments.firstIndex(of: "--allowedTools"))
        XCTAssertEqual(withTools.arguments[allowedIdx + 1], "WebSearch,WebFetch,mcp__safari-attraction")
        XCTAssertEqual(withTools.arguments.suffix(4), ["--effort", "xhigh", "--resume", "abc-123"])
    }

    func testClaudeWithPage() {
        let c = CommandBuilder.build(req(.claude, page: page), workDir: work)
        XCTAssertEqual(c.arguments[1], "[지금 사파리 탭]\n제목: 제목\n주소: https://example.com/a\n\n질문")
    }

    func testClaudeWithPageAndSelection() {
        let p = PageContext(title: "T", url: "U", selection: "고른 부분")
        let c = CommandBuilder.build(req(.claude, page: p), workDir: work)
        XCTAssertEqual(c.arguments[1], "[지금 사파리 탭]\n제목: T\n주소: U\n고른 글: 고른 부분\n\n질문")
    }

    func testSelectionCappedAt2000Characters() {
        let p = PageContext(title: "T", url: "U", selection: String(repeating: "가", count: 2500))
        let c = CommandBuilder.build(req(.claude, page: p), workDir: work)
        XCTAssertTrue(c.arguments[1].contains("고른 글: " + String(repeating: "가", count: 2000) + "\n"))
        XCTAssertFalse(c.arguments[1].contains(String(repeating: "가", count: 2001)))
    }

    func testClaudeIgnoresHistoryWhenResuming() {
        let h = [Turn(role: .user, text: "앞 질문"), Turn(role: .assistant, text: "앞 답")]
        let c = CommandBuilder.build(req(.claude, history: h, session: "s"), workDir: work)
        XCTAssertEqual(c.arguments[1], "질문")
    }

    // MARK: Gemini (agy)
    func testGeminiWithoutAndWithToolsAndEffort() throws {
        let geminiDir = CLIEnvironment.agyGeminiDirectory(support: support).path
        let plain = CommandBuilder.build(req(.gemini), workDir: work)
        XCTAssertEqual(plain.executable, "agy")
        XCTAssertEqual(plain.arguments, [
            "--gemini_dir", geminiDir,
            "-p", "질문", "--model", "gemini-3.8-flash-medium", "--output-format", "stream-json",
            "--settings", CLICommands.agySettingsJSON(safariTools: false),
        ])
        XCTAssertFalse(plain.arguments.contains("--effort"))

        let withEffort = CommandBuilder.build(req(.gemini, modelID: "gemini-4-neon-high", effort: "high"), workDir: work)
        XCTAssertFalse(withEffort.arguments.contains("--effort"), "agy 는 --effort 를 쓰지 않고 합친 모델 id 만 넘긴다")
        XCTAssertTrue(withEffort.arguments.contains("gemini-4-neon-high"))

        let withTools = CommandBuilder.build(req(.gemini, modelID: "gemini-4-neon-xhigh", effort: "xhigh", safariTools: tools), workDir: work)
        XCTAssertFalse(withTools.arguments.contains("--effort"))
        let settingsIdx = try XCTUnwrap(withTools.arguments.firstIndex(of: "--settings"))
        XCTAssertEqual(withTools.arguments[settingsIdx + 1],
                       #"{"permissions":{"allow":["mcp(safari-attraction/*)"],"deny":["read_file(*)","write_file(*)","command(*)","execute_url(*)"]}}"#)
    }

    func testGeminiAllPartsOrder() {
        let h = [Turn(role: .user, text: "앞 질문"), Turn(role: .assistant, text: "앞 답")]
        let c = CommandBuilder.build(req(.gemini, page: page, history: h), workDir: work)
        let pIdx = c.arguments.firstIndex(of: "-p")!
        XCTAssertEqual(c.arguments[pIdx + 1],
            "[앞 대화]\n사용자: 앞 질문\n답: 앞 답\n\n[지금 사파리 탭]\n제목: 제목\n주소: https://example.com/a\n\n질문")
    }

    // MARK: ChatGPT (codex)
    let codexBase = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-c", "cli_auth_credentials_store=file"]
        + CLIManagedConfig.codexDisabledFeatures.flatMap { ["-c", "features.\($0)=false"] }
        + ["-c", #"web_search="live""#]

    func testChatGPTWithoutAndWithToolsAndEffort() {
        let plain = CommandBuilder.build(req(.chatgpt), workDir: work)
        XCTAssertEqual(plain.executable, "codex")
        XCTAssertEqual(plain.arguments, codexBase + ["질문"])

        let withEffort = CommandBuilder.build(req(.chatgpt, modelID: "gpt-6-luna", effort: "high"), workDir: work)
        XCTAssertEqual(withEffort.arguments, codexBase + ["-c", #"model_reasoning_effort="high""#, "-m", "gpt-6-luna", "질문"])

        let withTools = CommandBuilder.build(req(.chatgpt, modelID: "gpt-6-luna", effort: "xhigh", safariTools: tools), workDir: work)
        XCTAssertTrue(withTools.arguments.contains(#"mcp_servers.safari-attraction.command="/bin/sh""#))
        XCTAssertTrue(withTools.arguments.contains(#"mcp_servers.safari-attraction.args=["/App/Contents/Resources/safari-attraction/run.sh"]"#))
        XCTAssertTrue(withTools.arguments.contains(#"mcp_servers.safari-attraction.default_tools_approval_mode="approve""#))
        XCTAssertTrue(withTools.arguments.contains(#"model_reasoning_effort="xhigh""#))
        XCTAssertTrue(withTools.arguments.contains { $0.contains("SAFARI_ATTRACTION_GATE_FILE=\"\(tools.gateFile)\"") })
        XCTAssertEqual(withTools.arguments.last, "질문")
    }

    func testChatGPTModelIDGoesInDashM() {
        var r = req(.chatgpt)
        r.modelID = "gpt-5.6-luna"
        XCTAssertEqual(CommandBuilder.build(r, workDir: work).arguments, codexBase + ["-m", "gpt-5.6-luna", "질문"])
        r.modelID = "--dangerously-bypass-approvals-and-sandbox"
        XCTAssertEqual(CommandBuilder.build(r, workDir: work).arguments, codexBase + ["질문"], "옵션처럼 생긴 모델 id 는 쓰지 않는다")
        r.modelID = "a b"
        XCTAssertEqual(CommandBuilder.build(r, workDir: work).arguments, codexBase + ["질문"])
    }

    func testClaudeModelIDGoesInDashDashModel() {
        var r = req(.claude)
        XCTAssertTrue(CommandBuilder.build(r, workDir: work).arguments.starts(with: ["-p", "질문", "--output-format", "stream-json", "--verbose", "--model", "sonnet"]))
        r.modelID = "opus"
        XCTAssertTrue(CommandBuilder.build(r, workDir: work).arguments.starts(with: ["-p", "질문", "--output-format", "stream-json", "--verbose", "--model", "opus"]))
        r.modelID = "-p"
        XCTAssertTrue(CommandBuilder.build(r, workDir: work).arguments.contains("sonnet"), "이상한 모델 id 는 기본으로")
    }

    func testChatGPTHistoryAndPage() {
        let h = [Turn(role: .user, text: "Q1"), Turn(role: .assistant, text: "A1")]
        let c = CommandBuilder.build(req(.chatgpt, page: page, history: h), workDir: work)
        XCTAssertEqual(c.arguments, codexBase + ["[앞 대화]\n사용자: Q1\n답: A1\n\n[지금 사파리 탭]\n제목: 제목\n주소: https://example.com/a\n\n질문"])
    }

    // MARK: opencode
    func testOpenCodeWithoutAndWithToolsAndEffort() throws {
        let plain = CommandBuilder.build(req(.opencode), workDir: work)
        XCTAssertEqual(plain.executable, "opencode")
        XCTAssertEqual(plain.arguments, ["run", "질문", "--format", "json", "--archived", "--standalone"])
        XCTAssertEqual(plain.environment["OPENCODE_CONFIG_CONTENT"], CLIManagedConfig.opencodeConfigJSON)

        let withEffort = CommandBuilder.build(req(.opencode, modelID: "opencode-go/deepseek-v4.1-flash", effort: "high"), workDir: work)
        XCTAssertEqual(withEffort.arguments, ["run", "질문", "-m", "opencode-go/deepseek-v4.1-flash#high", "--format", "json", "--archived", "--standalone"])

        let withTools = CommandBuilder.build(req(.opencode, modelID: "opencode-go/deepseek-v4.1-flash", effort: "max", safariTools: tools), workDir: work)
        XCTAssertEqual(withTools.arguments, ["run", "질문", "-m", "opencode-go/deepseek-v4.1-flash#max", "--format", "json", "--archived", "--standalone"])
        let cfgStr = try XCTUnwrap(withTools.environment["OPENCODE_CONFIG_CONTENT"])
        let cfg = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(cfgStr.utf8)) as? [String: Any])
        let perms = try XCTUnwrap(cfg["permission"] as? [String: String])
        XCTAssertEqual(perms["*"], "deny")
        XCTAssertEqual(perms["safari-attraction_*"], "allow")
        let mcp = try XCTUnwrap(cfg["mcp"] as? [String: Any])
        let sa = try XCTUnwrap(mcp["safari-attraction"] as? [String: Any])
        XCTAssertEqual(sa["type"] as? String, "local")
        XCTAssertEqual(sa["command"] as? [String], ["/bin/sh", tools.runScript])
        XCTAssertEqual(sa["environment"] as? [String: String], [
            "SAFARI_ATTRACTION_GATE_FILE": tools.gateFile,
            "SAFARI_ATTRACTION_NO_PERMISSION_PROMPTS": "1",
            "SAFARI_ATTRACTION_HOME": tools.memoryHome,
        ])
    }

    // MARK: Token isolation
    func testNoGateTokenAnywhere() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("notoken-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let res = dir.appendingPathComponent("res", isDirectory: true)
        let fakeToken = "SECRET_GATE_TOKEN_DO_NOT_LEAK_9f8e7d"
        try GateLink.write(GateInfo(socketPath: dir.appendingPathComponent("gate/s.sock").path, token: fakeToken), support: dir)
        try CLIEnvironment.prepareDirectories(support: dir, resources: res)
        let localTools = SafariTools(
            runScript: res.appendingPathComponent("safari-attraction/run.sh").path,
            gateFile: GateLink.url(support: dir).path,
            memoryHome: dir.appendingPathComponent("memory").path
        )

        for kind in ModelKind.allCases {
            let built = CommandBuilder.build(
                AskRequest(question: "안녕", model: kind, modelID: kind == .opencode ? "opencode/m" : "m", effort: "high", safariTools: localTools),
                workDir: dir.appendingPathComponent("work"),
                support: dir
            )
            for arg in built.arguments {
                XCTAssertFalse(arg.contains(fakeToken), "\(kind) arg leaked token")
            }
            for (k, v) in built.environment {
                XCTAssertFalse(k.contains(fakeToken) || v.contains(fakeToken), "\(kind) env \(k) leaked token")
            }
            for (k, v) in CLIEnvironment.executableEnvironment(executable: built.executable, support: dir) {
                XCTAssertFalse(k.contains(fakeToken) || v.contains(fakeToken), "\(kind) execEnv \(k) leaked token")
            }
        }
        let mcpConfig = try String(contentsOf: CLIManagedConfig.agyMCPConfigURL(support: dir), encoding: .utf8)
        XCTAssertFalse(mcpConfig.contains(fakeToken))
        XCTAssertTrue(mcpConfig.contains(GateLink.url(support: dir).path))
    }

    // MARK: History limits
    func testHistoryKeepsLastSixTurns() {
        let h = (1...10).map { Turn(role: $0 % 2 == 1 ? .user : .assistant, text: "t\($0)") }
        let args = CommandBuilder.build(req(.gemini, history: h), workDir: work).arguments
        let q = args[args.firstIndex(of: "-p")! + 1]
        XCTAssertFalse(q.contains("t4"))
        XCTAssertTrue(q.contains("t5") && q.contains("t10"))
    }

    func testHistoryCappedAt4000Characters() {
        let long = String(repeating: "나", count: 3000)
        let h = [Turn(role: .user, text: "오래된 " + long), Turn(role: .assistant, text: long), Turn(role: .user, text: "마지막 질문")]
        let q = CommandBuilder.build(req(.chatgpt, history: h), workDir: work).arguments.last!
        let body = q.dropFirst("[앞 대화]\n".count).dropLast("\n질문".count)
        XCTAssertLessThanOrEqual(body.count, 4000 + 1)
        XCTAssertTrue(q.contains("마지막 질문"))
        XCTAssertFalse(q.contains("오래된"))
    }

    func testSingleHugeTurnIsTruncatedNotDropped() {
        let h = [Turn(role: .assistant, text: String(repeating: "다", count: 9000))]
        let args = CommandBuilder.build(req(.gemini, history: h), workDir: work).arguments
        let q = args[args.firstIndex(of: "-p")! + 1]
        XCTAssertTrue(q.hasPrefix("[앞 대화]\n"))
        XCTAssertLessThan(q.count, 4200)
    }

    func testEmptyHistoryAddsNothing() {
        let args = CommandBuilder.build(req(.gemini), workDir: work).arguments
        XCTAssertEqual(args[args.firstIndex(of: "-p")! + 1], "질문")
    }

    // MARK: Safety (Review Focus 3)
    func testDangerousTextPassesThroughUnchanged() {
        let q = "\"$(rm -rf /)\" 'a' `b` \\ \n두번째 줄"
        let c = CommandBuilder.build(req(.claude, q: q), workDir: work)
        XCTAssertEqual(c.arguments[1], q)
    }

    func testQuestionStartingWithDashCannotBecomeAFlag() {
        for model in ModelKind.allCases {
            let c = CommandBuilder.build(req(model, q: "--dangerously-skip-permissions"), workDir: work)
            let promptArg: String
            switch model {
            case .chatgpt: promptArg = c.arguments.last!
            case .gemini: promptArg = c.arguments[c.arguments.firstIndex(of: "-p")! + 1]
            case .claude, .opencode: promptArg = c.arguments[1]
            }
            XCTAssertFalse(promptArg.hasPrefix("-"), "\(model)")
            XCTAssertTrue(promptArg.hasSuffix("--dangerously-skip-permissions"))
        }
    }

    func testClaudeWithoutSessionGetsHistory() {
        let h = [Turn(role: .user, text: "Q1"), Turn(role: .assistant, text: "A1")]
        let c = CommandBuilder.build(req(.claude, history: h, session: nil), workDir: work)
        XCTAssertEqual(c.arguments[1], "[앞 대화]\n사용자: Q1\n답: A1\n\n질문")
        let c2 = CommandBuilder.build(req(.claude, history: h, session: ""), workDir: work)
        XCTAssertEqual(c2.arguments[1], "[앞 대화]\n사용자: Q1\n답: A1\n\n질문")
        XCTAssertFalse(c.arguments.contains("--resume"))
    }

    func testModelKindBasics() {
        XCTAssertEqual(ModelKind.allCases, [.claude, .gemini, .chatgpt, .opencode])
        XCTAssertEqual(ModelKind.claude.koreanName, "클로드")
        XCTAssertEqual(ModelKind.gemini.koreanName, "제미나이")
        XCTAssertEqual(ModelKind.chatgpt.koreanName, "ChatGPT")
    }

    func testPromptLengthLimitIsTwoHundredThousandUTF8Bytes() {
        XCTAssertEqual(CommandBuilder.maxPromptBytes, 200_000)
        let atLimit = AskRequest(question: String(repeating: "a", count: 200_000), model: .claude)
        XCTAssertFalse(CommandBuilder.exceedsPromptLimit(atLimit), "정확히 상한이면 통과")
        let over = AskRequest(question: String(repeating: "a", count: 200_001), model: .claude)
        XCTAssertTrue(CommandBuilder.exceedsPromptLimit(over))
        XCTAssertTrue(CommandBuilder.exceedsPromptLimit(AskRequest(question: String(repeating: "가", count: 67_000), model: .claude)))
        XCTAssertFalse(CommandBuilder.exceedsPromptLimit(AskRequest(question: String(repeating: "가", count: 66_000), model: .claude)))
        XCTAssertTrue(CommandBuilder.promptTooLongMessage.contains("너무 길어요"))
    }
}
