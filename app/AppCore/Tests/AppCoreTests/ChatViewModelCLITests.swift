import XCTest
@testable import AppCore

func codexAnswer(_ text: String, usage: Bool = true) -> RunEvent {
    .stdout(jsonLine(["type": "item.completed", "item": ["type": "agent_message", "text": text]])
        + (usage ? jsonLine(["type": "turn.completed", "usage": ["input_tokens": 100, "cached_input_tokens": 50, "output_tokens": 20]]) : Data()))
}

/// 계획 10 — 고른 CLI · 모델로 묻기, codex 로그인 확인, 설정 저장, 쓴 양.
@MainActor
final class ChatViewModelCLITests: XCTestCase {
    var runner: FakeRunner!
    var settingsDir: URL!

    override func setUp() async throws {
        runner = FakeRunner()
        settingsDir = FileManager.default.temporaryDirectory.appendingPathComponent("vm-settings-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: settingsDir, withIntermediateDirectories: true)
    }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: settingsDir) }

    func makeVM(status: CLIStatusService? = nil, settings: AppSettingsStore? = nil) -> ChatViewModel {
        ChatViewModel(runner: runner, bridge: FakeBridge(), loginPath: { "/test/bin" },
                      workDirectory: { URL(fileURLWithPath: "/tmp/work-test") }, settings: settings, status: status)
    }

    func ask(_ vm: ChatViewModel, _ q: String) async { vm.input = q; await vm.send()?.value }

    // MARK: codex — 묻기 전 로그인 확인(Review Focus 2)
    func testCodexLoggedOutNeverStartsExec() async {
        runner.setScript { call, _ in call.arguments.first == "login" ? .finished(code: 1) : .finished(code: 0) }
        let vm = makeVM(); vm.model = .chatgpt
        await ask(vm, "안녕")
        XCTAssertEqual(runner.calls.map { ([$0.executable] + $0.arguments).joined(separator: " ") }, ["codex login status"])
        XCTAssertEqual(vm.messages.last?.error, "설정에서 ChatGPT 로그인을 해 주세요")
        XCTAssertFalse(vm.isRunning)
        XCTAssertEqual(runner.calls[0].timeout, 20)
    }

    func testCodexStatusUnreadableAlsoNeverStartsExec() async {
        runner.setScript { _, _ in .finished(code: 7) }
        let vm = makeVM(); vm.model = .chatgpt
        await ask(vm, "안녕")
        XCTAssertEqual(runner.calls.count, 1)
        XCTAssertTrue(vm.messages.last?.error?.contains("확인하지 못했어요") == true)
        runner.setScript { _, _ in .timedOut }
        await ask(vm, "또")
        XCTAssertEqual(runner.calls.count, 2, "시간 초과여도 exec 를 띄우지 않는다")
        runner.setScript { _, _ in .notFound("codex") }
        await ask(vm, "또또")
        XCTAssertEqual(vm.messages.last?.error, ModelKind.chatgpt.notFoundMessage)
    }

    func testCodexLoggedInAsksWithChosenModelAndShowsAnswerAndUsage() async {
        runner.setScript { call, emit in
            if call.arguments.first == "exec" { emit(codexAnswer("답이에요")) }
            return .finished(code: 0)
        }
        let vm = makeVM(); vm.model = .chatgpt
        await ask(vm, "질문")
        XCTAssertEqual(runner.calls.count, 2)
        XCTAssertEqual(runner.calls[0].arguments, ["login", "status"])
        let exec = runner.calls[1]
        XCTAssertEqual(exec.executable, "codex")
        XCTAssertEqual(Array(exec.arguments.prefix(8)), ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-c", "cli_auth_credentials_store=file"])
        XCTAssertEqual(exec.arguments.last, "질문")
        XCTAssertFalse(exec.arguments.contains("-m"), "목록을 못 불렀으면 -m 없이")
        XCTAssertEqual(vm.messages.last?.text, "답이에요")
        XCTAssertNil(vm.messages.last?.error)
        XCTAssertEqual(vm.lastUsageText, "쓴 양 120 토큰 (입력 100 · 출력 20 · 캐시 50)")
    }

    func testCodexFollowUpCarriesPreviousTurns() async {
        runner.setScript { call, emit in
            if call.arguments.first == "exec" { emit(codexAnswer("첫 답", usage: false)) }
            return .finished(code: 0)
        }
        let vm = makeVM(); vm.model = .chatgpt
        await ask(vm, "첫 질문")
        await ask(vm, "둘째 질문")
        let second = runner.calls.last!.arguments.last!
        XCTAssertTrue(second.hasPrefix("[앞 대화]\n사용자: 첫 질문\n답: 첫 답"), second)
        XCTAssertTrue(second.hasSuffix("둘째 질문"))
    }

    func testCodexWebSearchIsAlwaysLiveWithNoNotice() async {
        runner.setScript { call, emit in
            if call.arguments.first == "exec" { emit(codexAnswer("답", usage: false)) }
            return .finished(code: 0)
        }
        let vm = makeVM(); vm.model = .chatgpt
        await ask(vm, "최신 뉴스")
        XCTAssertNil(vm.messages.last?.notice)
        XCTAssertTrue(runner.calls.last!.arguments.contains(#"web_search="live""#))
    }

    // MARK: 모델 고르기 · 설정 저장
    func testClaudeModelChoiceGoesIntoCommandAndIsRemembered() async {
        let store = AppSettingsStore(directory: settingsDir)
        let vm = makeVM(settings: store)
        XCTAssertEqual(vm.selectedModelID(for: .claude), "sonnet")
        vm.setModelID("opus", for: .claude)
        vm.setModelID("없는모델", for: .claude)
        XCTAssertEqual(vm.selectedModelID(for: .claude), "opus")
        runner.setScript { _, emit in emit(claudeResultLine(text: "ok")); return .finished(code: 0) }
        await ask(vm, "q")
        let args = runner.calls[0].arguments
        XCTAssertEqual(args[args.firstIndex(of: "--model")! + 1], "opus")

        let again = makeVM(settings: AppSettingsStore(directory: settingsDir))
        XCTAssertEqual(again.selectedModelID(for: .claude), "opus", "다시 켜도 고른 모델이 남는다")
    }

    func testSelectedCLIIsRemembered() {
        let store = AppSettingsStore(directory: settingsDir)
        let vm = makeVM(settings: store)
        XCTAssertTrue(vm.selectCLI(.chatgpt))
        XCTAssertEqual(vm.model, .chatgpt)
        XCTAssertEqual(AppSettingsStore(directory: settingsDir).current.selectedCLI, "chatgpt")
        XCTAssertEqual(makeVM(settings: AppSettingsStore(directory: settingsDir)).model, .chatgpt)
    }

    func testSettingsFileNamingAnUnavailableCLIFallsBackToClaude() throws {
        // 계획 10 조각 5 — 제미나이도 이제 고를 수 있다. 목록에 없는 이름은 그대로 클로드로.
        try Data(#"{"selectedCLI":"nonsense","models":{}}"#.utf8).write(to: settingsDir.appendingPathComponent("settings.json"))
        XCTAssertEqual(makeVM(settings: AppSettingsStore(directory: settingsDir)).model, .claude)
        try Data(#"{"selectedCLI":"gemini","models":{}}"#.utf8).write(to: settingsDir.appendingPathComponent("settings.json"))
        XCTAssertEqual(makeVM(settings: AppSettingsStore(directory: settingsDir)).model, .gemini)
    }

    func testCodexModelListChoiceReachesCommandAndStaleChoiceFallsToFirst() async throws {
        let status = try await loggedInStatus(models: #"[{"slug":"gpt-6-luna","display_name":"Luna","visibility":"list"},{"slug":"gpt-5.6-terra","visibility":"list"}]"#)
        let store = AppSettingsStore(directory: settingsDir)
        let vm = makeVM(status: status, settings: store)
        XCTAssertEqual(vm.modelChoices(for: .chatgpt).map(\.id), ["gpt-6-luna", "gpt-5.6-terra"])
        XCTAssertEqual(vm.selectedModelID(for: .chatgpt), "gpt-6-luna", "기본은 목록의 첫 것")
        vm.setModelID("gpt-5.6-terra", for: .chatgpt)
        XCTAssertEqual(vm.selectedModelID(for: .chatgpt), "gpt-5.6-terra")

        vm.model = .chatgpt
        runner.setScript { call, emit in
            if call.arguments.first == "exec" { emit(codexAnswer("답")) }
            return .finished(code: 0)
        }
        await ask(vm, "q")
        let exec = runner.calls.last!.arguments
        XCTAssertEqual(exec[exec.firstIndex(of: "-m")! + 1], "gpt-5.6-terra")

        try Data(#"{"selectedCLI":"chatgpt","models":{"chatgpt":"사라진모델"}}"#.utf8).write(to: settingsDir.appendingPathComponent("settings.json"))
        let stale = makeVM(status: status, settings: AppSettingsStore(directory: settingsDir))
        XCTAssertEqual(stale.selectedModelID(for: .chatgpt), "gpt-6-luna")
    }

    // MARK: CLI 고르기 — 로그인 안 된 CLI(흐리게)
    func testSelectCLIRefusesWhenKnownLoggedOut() async {
        let r = ScriptedCLIRunner()
        r.reply("codex login status", outcome: .finished(code: 1), stdout: "Not logged in")
        let bin = fakeBin(["claude", "codex"])
        let svc = CLIStatusService(loginPath: { bin }, runnerFactory: { r }, workDirectory: { URL(fileURLWithPath: "/tmp") }, timeout: 5)
        await svc.refresh(.chatgpt, force: true)
        let vm = makeVM(status: svc, settings: AppSettingsStore(directory: settingsDir))
        XCTAssertEqual(vm.loginState(for: .chatgpt), .loggedOut)
        XCTAssertFalse(vm.selectCLI(.chatgpt))
        XCTAssertEqual(vm.model, .claude)
        XCTAssertEqual(vm.hint, "ChatGPT(codex) 로그인이 안 돼 있어요 — 메뉴 막대 「설정…」 에서 로그인해 주세요")
        XCTAssertEqual(AppSettingsStore(directory: settingsDir).current.selectedCLI, "claude")
        XCTAssertEqual(vm.loginState(for: .claude), .unknown, "아직 모르는 CLI 는 막지 않는다")
        XCTAssertTrue(vm.selectCLI(.claude))
    }

    func testSelectCLIIgnoredWhileRunning() async {
        let gate = Gate()
        runner.setScript { _, emit in await gate.wait(); emit(claudeResultLine(text: "x")); return .finished(code: 0) }
        let vm = makeVM()
        vm.input = "q"
        let t = vm.send()
        XCTAssertFalse(vm.selectCLI(.chatgpt))
        XCTAssertEqual(vm.model, .claude)
        await gate.open(); await t?.value
    }

    // MARK: 도우미
    func fakeBin(_ names: [String]) -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fakebin-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for n in names {
            let f = dir.appendingPathComponent(n)
            try! "#!/bin/sh\n".write(to: f, atomically: true, encoding: .utf8)
            try! FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: f.path)
        }
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir.path
    }

    func loggedInStatus(models: String) async throws -> CLIStatusService {
        let r = ScriptedCLIRunner()
        r.reply("codex login status", stdout: "Logged in using ChatGPT")
        r.reply("codex debug models", stdout: models)
        let bin = fakeBin(["claude", "codex"])
        let svc = CLIStatusService(loginPath: { bin }, runnerFactory: { r }, workDirectory: { URL(fileURLWithPath: "/tmp") }, timeout: 5)
        await svc.refresh(.chatgpt, force: true)
        return svc
    }
}
