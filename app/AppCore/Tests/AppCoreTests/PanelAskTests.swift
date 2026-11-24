import XCTest
@testable import AppCore

/// 질문마다 새 실행기를 내주는 공장 — 만든 실행기를 모두 적어 둔다.
final class RunnerFactoryLog: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var runners: [FakeRunner] = []
    private let script: FakeRunner.Script
    init(script: @escaping FakeRunner.Script) { self.script = script }
    func make() -> FakeRunner {
        let r = FakeRunner()
        r.setScript(script)
        lock.withLock { runners.append(r) }
        return r
    }
    var count: Int { lock.withLock { runners.count } }
    var all: [FakeRunner] { lock.withLock { runners } }
}

final class LineBox: @unchecked Sendable {
    private let lock = NSLock(); private var _all: [PanelLine] = []
    func add(_ l: PanelLine) { lock.withLock { _all.append(l) } }
    var all: [PanelLine] { lock.withLock { _all } }
}

final class PanelAskTests: XCTestCase {
    private var tempDir: URL!

    override func setUp() async throws {
        tempDir = FileManager.default.temporaryDirectory.appendingPathComponent("panel-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: tempDir) }

    private func service(_ factory: RunnerFactoryLog, kind: ModelKind = .claude, modelID: String? = nil,
                         login: CLILoginState = .unknown, work: (@Sendable () throws -> URL)? = nil) -> PanelAskService {
        let dir = tempDir!
        return PanelAskService(selection: { _ in PanelSelection(kind: kind, modelID: modelID, modelName: modelID, login: login) },
                               runnerFactory: { factory.make() },
                               loginPath: { "/usr/bin:/bin" },
                               workDirectory: work ?? { dir },
                               timeout: 180,
                               geminiLoggedOut: { false })
    }

    private func serve(_ s: PanelAskService) async throws -> UInt16 {
        let server = PanelServer(token: PanelTest.token, backend: s)
        let port = try await server.start()
        addTeardownBlock { server.stop() }
        return port
    }

    private func ask(_ port: UInt16, _ body: Data = PanelTest.askBody()) async -> HTTPReply? {
        await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/ask", port: port, origin: PanelTest.extensionOrigin, body: body), timeout: 10)
    }

    // MARK: 순서 · 내용

    func testNDJSONOrderIsDeltasThenDoneAndMirrorsSideWindowText() async throws {
        let factory = RunnerFactoryLog { _, emit in
            emit(claudeAssistantLine("안녕하세요."))
            emit(claudeAssistantLine("더 있어요."))
            emit(claudeResultLine(text: "안녕하세요.\n\n더 있어요."))
            return .finished(code: 0)
        }
        let port = try await serve(service(factory))
        let r = await ask(port)
        XCTAssertEqual(r?.status, 200)
        XCTAssertEqual(r?.lines, [#"{"t":"delta","text":"안녕하세요."}"#,
                                  #"{"t":"delta","text":"\n\n더 있어요."}"#,   // 옆 창처럼 말풍선 사이를 한 줄 띄운다
                                  #"{"t":"done","usage":null}"#])
    }

    func testPromptHasPageHeaderAndUsesPickedModelAndWebSearchRule() async throws {
        let factory = RunnerFactoryLog { _, emit in emit(claudeAssistantLine("네")); emit(claudeResultLine(text: "네")); return .finished(code: 0) }
        let port = try await serve(service(factory, modelID: "opus"))
        let page: [String: Any] = ["title": "제목\n둘째 줄", "url": "https://example.com/a?x=1", "selection": String(repeating: "고", count: 2_500),
                                   "text": String(repeating: "본", count: 4_500)]
        _ = await ask(port, PanelTest.askBody("요약해 줘", page: page, webSearch: true))
        let call = try XCTUnwrap(factory.all.first?.calls.first)
        XCTAssertEqual(call.executable, "claude")
        XCTAssertTrue(call.arguments.contains("--safe-mode"))
        let model = call.arguments.firstIndex(of: "--model").map { call.arguments[$0 + 1] }
        XCTAssertEqual(model, "opus")
        let tools = call.arguments.firstIndex(of: "--tools").map { call.arguments[$0 + 1] }
        XCTAssertEqual(tools, "WebSearch,WebFetch", "클로드는 웹 검색 규칙을 따른다")
        XCTAssertEqual(call.timeout, 180)
        XCTAssertFalse(call.arguments.contains("--resume"), "패널 질문은 이어 묻기가 아니다")
        let expected = "[지금 사파리 탭]\n제목: 제목 둘째 줄\n주소: https://example.com/a?x=1\n고른 글: \(String(repeating: "고", count: 2_000))\n본문 앞부분: \(String(repeating: "본", count: 4_000))\n\n요약해 줘"
        XCTAssertEqual(call.prompt, expected)
    }

    func testNoPageMeansQuestionOnlyAndEmptyPartsAreDropped() {
        XCTAssertEqual(PanelPrompt.compose(PanelQuestion(question: "질문")), "질문")
        let q = PanelQuestion(question: "질문", page: PanelPage(title: "T", url: "U", selection: "  ", text: ""))
        XCTAssertEqual(PanelPrompt.compose(q), "[지금 사파리 탭]\n제목: T\n주소: U\n\n질문")
    }

    func testEachQuestionGetsAFreshRunner() async throws {
        let factory = RunnerFactoryLog { _, emit in emit(claudeAssistantLine("네")); return .finished(code: 0) }
        let port = try await serve(service(factory))
        _ = await ask(port); _ = await ask(port)
        XCTAssertEqual(factory.count, 2)
        XCTAssertEqual(factory.all.map { $0.calls.count }, [1, 1])
    }

    func testOpencodeWebSearchNoticeComesFirstAsADelta() async throws {
        let factory = RunnerFactoryLog { _, emit in
            emit(.stdout(jsonLine(["type": "text", "part": ["text": "hello"]])))
            return .finished(code: 0)
        }
        let port = try await serve(service(factory, kind: .opencode))
        let r = await ask(port, PanelTest.askBody(webSearch: true))
        XCTAssertEqual(r?.lines.first, "{\"t\":\"delta\",\"text\":\"(\(CommandBuilder.chatgptNoWebNotice))\\n\\n\"}")
        XCTAssertEqual(r?.lines.last, #"{"t":"done","usage":null}"#)
    }

    func testUsageComesInTheDoneLine() async throws {
        let factory = RunnerFactoryLog { _, emit in
            emit(claudeAssistantLine("네"))
            emit(.stdout(jsonLine(["type": "result", "session_id": "s", "is_error": false, "result": "네",
                                   "usage": ["input_tokens": 10, "output_tokens": 5]])))
            return .finished(code: 0)
        }
        let port = try await serve(service(factory))
        let r = await ask(port)
        let done = try JSONSerialization.jsonObject(with: Data(try XCTUnwrap(r?.lines.last).utf8)) as! [String: Any]
        XCTAssertEqual(done["t"] as? String, "done")
        let usage = try XCTUnwrap(done["usage"] as? [String: Any])
        XCTAssertEqual(usage["input"] as? Int, 10)
        XCTAssertEqual(usage["output"] as? Int, 5)
        XCTAssertEqual(usage["total"] as? Int, 15)
        XCTAssertNotNil(usage["summary"] as? String)
    }

    // MARK: 오류

    func testRunFailuresBecomeAKoreanErrorLineAndNoDone() async throws {
        let cases: [(RunOutcome, String)] = [
            (.notFound("claude"), ModelKind.claude.notFoundMessage),
            (.timedOut, "초가 지나 멈췄어요"),
            (.failed("앱 전용 설정 폴더를 만들지 못했어요"), "앱 전용 설정 폴더를 만들지 못했어요"),
            (.finished(code: 3), "종료 코드 3"),
        ]
        for (outcome, expected) in cases {
            let factory = RunnerFactoryLog { _, _ in outcome }
            let port = try await serve(service(factory))
            let r = await ask(port)
            XCTAssertEqual(r?.status, 200)
            let last = try XCTUnwrap(r?.lines.last)
            let obj = try JSONSerialization.jsonObject(with: Data(last.utf8)) as! [String: Any]
            XCTAssertEqual(obj["t"] as? String, "error", "\(outcome)")
            XCTAssertTrue((obj["message"] as? String ?? "").contains(expected), "\(outcome) → \(last)")
            XCTAssertFalse(r?.text.contains("\"done\"") ?? true)
        }
    }

    func testClaudeErrorResultAfterTextEndsWithErrorLine() async throws {
        let factory = RunnerFactoryLog { _, emit in
            emit(claudeAssistantLine("조금"))
            emit(claudeResultLine(isError: true, text: "한도가 찼어요"))
            return .finished(code: 1)
        }
        let port = try await serve(service(factory))
        let r = await ask(port)
        XCTAssertEqual(r?.lines, [#"{"t":"delta","text":"조금"}"#, #"{"t":"error","message":"한도가 찼어요"}"#])
    }

    func testPromptTooLongNeverStartsTheCLI() async throws {
        let factory = RunnerFactoryLog { _, _ in .finished(code: 0) }
        let port = try await serve(service(factory))
        let q = String(repeating: "가", count: 70_000)   // 210KB 넘음, 본문 256KB 안
        let r = await ask(port, PanelTest.askBody(q, page: nil))
        XCTAssertEqual(r?.lines.count, 1)
        XCTAssertTrue(r?.lines.first?.contains("질문이 너무 길어요") ?? false)
        XCTAssertEqual(factory.all.flatMap(\.calls).count, 0)
    }

    func testWorkFolderFailureIsAnErrorLine() async throws {
        struct Boom: Error, LocalizedError { var errorDescription: String? { "막혔어요" } }
        let factory = RunnerFactoryLog { _, _ in .finished(code: 0) }
        let port = try await serve(service(factory, work: { throw Boom() }))
        let r = await ask(port)
        XCTAssertTrue(r?.lines.last?.contains("작업 폴더를 만들지 못했어요") ?? false)
        XCTAssertEqual(factory.all.flatMap(\.calls).count, 0)
    }

    func testBlockedFolderRunnerGivesItsOwnMessage() async throws {
        let blocked = FolderBlockedRunner(reason: "권한이 없어요")
        let dir = tempDir!
        let svc = PanelAskService(selection: { _ in PanelSelection(kind: .claude, modelID: nil) }, runnerFactory: { blocked },
                                  loginPath: { "/usr/bin:/bin" }, workDirectory: { dir }, geminiLoggedOut: { false })
        let port = try await serve(svc)
        let r = await ask(port)
        XCTAssertTrue(r?.lines.last?.contains("앱 전용 설정 폴더를 만들지 못했어요 — 권한이 없어요") ?? false, r?.text ?? "")
    }

    func testCodexLoggedOutStopsBeforeAsking() async throws {
        let factory = RunnerFactoryLog { call, _ in call.arguments.first == "login" ? .finished(code: 1) : .finished(code: 0) }
        let port = try await serve(service(factory, kind: .chatgpt))
        let r = await ask(port)
        XCTAssertTrue(r?.lines.last?.contains(ModelKind.chatgpt.loginNeededMessage) ?? false, r?.text ?? "")
        XCTAssertEqual(factory.all.flatMap(\.calls).count, 1, "login status 한 번만, codex exec 는 안 띄운다")
    }

    // MARK: 끊김 · 멈춤

    func testClientDisconnectStopsTheRunner() async throws {
        let started = Gate()
        let factory = RunnerFactoryLog { _, emit in
            emit(claudeAssistantLine("처음"))
            await started.open()
            try? await Task.sleep(nanoseconds: 30_000_000_000)   // stop() 이 불려도 스스로는 안 끝나는 실행기 — 취소 처리가 부르는지 본다
            return .stopped
        }
        let svc = service(factory)
        let server = PanelServer(token: PanelTest.token, backend: svc)
        let port = try await server.start()
        addTeardownBlock { server.stop() }
        let client = try XCTUnwrap(RawClient(port: port))
        client.send(PanelTest.request("POST", "/ask", port: port, body: PanelTest.askBody()))
        let got = await Task.detached { client.read(timeout: 5) { String(decoding: $0, as: UTF8.self).contains("처음") } }.value
        XCTAssertTrue(String(decoding: got, as: UTF8.self).contains("처음"))
        XCTAssertEqual(server.activeAskCount, 1)
        let runner = try XCTUnwrap(factory.all.first)
        XCTAssertEqual(runner.stopCount, 0)

        client.closeNow()   // 손님이 끊는다
        let stopped = await PanelTest.waitUntil { runner.stopCount >= 1 }
        XCTAssertTrue(stopped, "손님이 끊으면 실행기를 멈춰야 해요")
        let freed = await PanelTest.waitUntil { server.activeAskCount == 0 }
        XCTAssertTrue(freed)
    }

    func testServerStopMidAskStopsTheRunner() async throws {
        let factory = RunnerFactoryLog { _, emit in
            emit(claudeAssistantLine("처음"))
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            return .stopped
        }
        let server = PanelServer(token: PanelTest.token, backend: service(factory))
        let port = try await server.start()
        addTeardownBlock { server.stop() }
        let client = try XCTUnwrap(RawClient(port: port))
        client.send(PanelTest.request("POST", "/ask", port: port, body: PanelTest.askBody()))
        let got = await Task.detached { client.read(timeout: 5) { String(decoding: $0, as: UTF8.self).contains("처음") } }.value
        XCTAssertTrue(String(decoding: got, as: UTF8.self).contains("처음"))
        let runner = try XCTUnwrap(factory.all.first)
        server.stop()
        let stopped = await PanelTest.waitUntil { runner.stopCount >= 1 }
        XCTAssertTrue(stopped, "서버를 멈추면 도는 질문의 실행기도 멈춰야 해요")
    }

    func testStoppedOutcomeWithoutDisconnectGivesNoDone() async throws {
        let factory = RunnerFactoryLog { _, emit in emit(claudeAssistantLine("조금")); return .stopped }
        let port = try await serve(service(factory))
        let r = await ask(port)
        XCTAssertEqual(r?.lines, [#"{"t":"delta","text":"조금"}"#])
    }

    // MARK: 긴 답

    func testLongAnswerArrivesCompleteAndInOrder() async throws {
        let big = String(repeating: "가나다라마바사", count: 16_000)   // 한글 112,000자 ≈ 336KB 의 한 덩어리
        let factory = RunnerFactoryLog { _, emit in
            for i in 0..<400 { emit(claudeAssistantLine("조각 \(i)")) }
            emit(claudeAssistantLine(big))
            emit(claudeAssistantLine("끝"))
            emit(claudeResultLine(text: ""))
            return .finished(code: 0)
        }
        let port = try await serve(service(factory))
        let r = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/ask", port: port, origin: PanelTest.extensionOrigin, body: PanelTest.askBody()), timeout: 20)
        XCTAssertEqual(r?.status, 200)
        let lines = try XCTUnwrap(r?.lines)
        XCTAssertEqual(lines.count, 400 + 1 + 1 + 1, "delta 402 + done 1")
        var texts: [String] = []
        for (i, line) in lines.dropLast().enumerated() {
            let o = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any], "\(i)")
            XCTAssertEqual(o["t"] as? String, "delta")
            texts.append(try XCTUnwrap(o["text"] as? String))
        }
        XCTAssertEqual(lines.last, #"{"t":"done","usage":null}"#)
        XCTAssertEqual(texts.first, "조각 0")
        for i in 1..<400 { XCTAssertEqual(texts[i], "\n\n조각 \(i)") }
        XCTAssertEqual(texts[400], "\n\n" + big, "한 덩어리가 잘리거나 섞이지 않고 온다")
        XCTAssertEqual(texts[401], "\n\n끝")
    }

    // MARK: 끝낼 때

    func testIsRunningStaysTrueUntilTheRunnerReturnsEvenAfterServerStop() async throws {
        let factory = RunnerFactoryLog { _, emit in
            emit(claudeAssistantLine("처음"))
            try? await Task.sleep(nanoseconds: 1_200_000_000)   // stop 을 받고도 늦게 돌아오는 실행기(SIGKILL 유예처럼)
            return .stopped
        }
        let svc = service(factory)
        XCTAssertFalse(svc.isRunning)
        let server = PanelServer(token: PanelTest.token, backend: svc)
        let port = try await server.start()
        addTeardownBlock { server.stop() }
        let client = try XCTUnwrap(RawClient(port: port))
        client.send(PanelTest.request("POST", "/ask", port: port, body: PanelTest.askBody()))
        let got = await Task.detached { client.read(timeout: 5) { String(decoding: $0, as: UTF8.self).contains("처음") } }.value
        XCTAssertTrue(String(decoding: got, as: UTF8.self).contains("처음"))
        XCTAssertTrue(svc.isRunning)

        server.stop()
        XCTAssertEqual(server.activeAskCount, 0, "연결은 바로 정리된다")
        XCTAssertTrue(svc.isRunning, "그래도 실행기가 돌아오기 전엔 끝내기가 기다려야 해요")
        let runner = try XCTUnwrap(factory.all.first)
        XCTAssertGreaterThanOrEqual(runner.stopCount, 1)
        let done = await PanelTest.waitUntil(timeout: 5) { !svc.isRunning }
        XCTAssertTrue(done)
    }

    // MARK: 고른 CLI · 모델 — 진짜 상태 서비스(대본 실행기)

    private func fakeBin(_ names: [String]) -> String {
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

    @MainActor
    func testSavedNonClaudeModelSurvivesOnlyBecauseTheStatusReadIsAwaited() async throws {
        let store = AppSettingsStore(directory: tempDir)
        try store.update { $0.selectedCLI = ModelKind.chatgpt.rawValue; $0.models["chatgpt"] = "gpt-6-luna" }
        let script = ScriptedCLIRunner()
        script.reply("codex login status", stdout: "Logged in using ChatGPT\n")
        script.reply("codex debug models", stdout: #"[{"slug":"gpt-6-luna","display_name":"GPT-6 Luna","visibility":"list"}]"#)
        let bin = fakeBin(["codex"])
        let status = CLIStatusService(loginPath: { bin }, runnerFactory: { script },
                                      workDirectory: { URL(fileURLWithPath: NSTemporaryDirectory()) }, timeout: 5)
        let vm = ChatViewModel(runner: FakeRunner(), bridge: FakeBridge(), loginPath: { bin },
                               workDirectory: { URL(fileURLWithPath: NSTemporaryDirectory()) }, settings: store, status: status)
        // 옆 창을 한 번도 안 열었다 — 목록이 비어 있어 저장한 모델은 지금은 버려진다.
        XCTAssertNil(vm.selectedModelID(for: .chatgpt))
        XCTAssertEqual(script.commands, [])

        // /info(기다리지 않음) 직후 곧바로 묻기(기다림)가 와도 읽는 중인 것을 기다려 모델이 살아남는다.
        _ = await vm.panelSelection(waitForStatus: false)
        let s = await vm.panelSelection(waitForStatus: true)
        XCTAssertEqual(s.kind, .chatgpt)
        XCTAssertEqual(s.modelID, "gpt-6-luna")
        XCTAssertEqual(s.modelName, "GPT-6 Luna")
        guard case .loggedIn = s.login else { return XCTFail("로그인 상태를 읽었어야 해요: \(s.login)") }
        XCTAssertTrue(script.commands.contains("codex debug models"))
    }

    @MainActor
    func testClaudeAskNeverWaitsForOrStartsAStatusRead() async throws {
        let store = AppSettingsStore(directory: tempDir)
        try store.update { $0.models["claude"] = "opus" }
        let script = ScriptedCLIRunner()
        let bin = fakeBin(["claude"])
        let status = CLIStatusService(loginPath: { bin }, runnerFactory: { script },
                                      workDirectory: { URL(fileURLWithPath: NSTemporaryDirectory()) }, timeout: 5)
        let vm = ChatViewModel(runner: FakeRunner(), bridge: FakeBridge(), loginPath: { bin },
                               workDirectory: { URL(fileURLWithPath: NSTemporaryDirectory()) }, settings: store, status: status)
        let s = await vm.panelSelection(waitForStatus: true)
        XCTAssertEqual(s.modelID, "opus")
        XCTAssertEqual(script.commands, [], "클로드 묻기는 상태 읽기(CLI 실행)를 시작하지도 기다리지도 않는다")
    }

    // MARK: 취소

    /// 모든 읽기 호출이 문이 열릴 때까지 멈춰 있는 가짜 실행기(상태 읽기가 진행 중인 채 취소되는 경우).
    final class BlockedStatusRunner: CommandRunning, InteractiveRunning, @unchecked Sendable {
        let gate = Gate()
        private let lock = NSLock()
        private var _calls = 0
        var calls: Int { lock.withLock { _calls } }
        func run(executable: String, arguments: [String], workDir: URL, path: String, timeout: TimeInterval,
                 onEvent: @escaping @Sendable (RunEvent) -> Void) async -> RunOutcome {
            lock.withLock { _calls += 1 }
            await gate.wait()
            return .finished(code: 1)
        }
        func runInteractive(executable: String, arguments: [String], workDir: URL, path: String, timeout: TimeInterval,
                            initialLines: [String], onEvent: @escaping @Sendable (RunEvent) -> Void) async -> RunOutcome { await gate.wait(); return .stopped }
        func write(_ line: String) throws {}
        func closeInput() {}
        func stop() { Task { await gate.open() } }
    }

    @MainActor
    func testCancelWhileWaitingForStatusEndsRightAway() async throws {
        let store = AppSettingsStore(directory: tempDir)
        try store.update { $0.selectedCLI = ModelKind.chatgpt.rawValue }
        let blocked = BlockedStatusRunner()
        let bin = fakeBin(["codex"])
        let status = CLIStatusService(loginPath: { bin }, runnerFactory: { blocked },
                                      workDirectory: { URL(fileURLWithPath: NSTemporaryDirectory()) }, timeout: 60)
        let vm = ChatViewModel(runner: FakeRunner(), bridge: FakeBridge(), loginPath: { bin },
                               workDirectory: { URL(fileURLWithPath: NSTemporaryDirectory()) }, settings: store, status: status)
        _ = await vm.panelSelection(waitForStatus: false)   // /info — 상태 읽기가 문 앞에서 멈춘 채 진행 중
        let started = await PanelTest.waitUntil { blocked.calls >= 1 }
        XCTAssertTrue(started)

        let begun = Date()
        let task = Task { @MainActor in await vm.panelSelection(waitForStatus: true) }   // 진행 중인 읽기를 기다린다(최대 25초)
        try await Task.sleep(nanoseconds: 300_000_000)
        task.cancel()
        _ = await task.value
        XCTAssertLessThan(Date().timeIntervalSince(begun), 3, "취소되면 25초를 채우지 않고 바로 끝나야 해요")
        await blocked.gate.open()
    }

    func testCancelledAskNeverCreatesARunner() async throws {
        let factory = RunnerFactoryLog { _, _ in .finished(code: 0) }
        let gate = Gate()
        let dir = tempDir!
        let svc = PanelAskService(selection: { _ in await gate.wait(); return PanelSelection(kind: .claude, modelID: nil) },
                                  runnerFactory: { factory.make() }, loginPath: { "/usr/bin:/bin" }, workDirectory: { dir },
                                  geminiLoggedOut: { false })
        let lines = LineBox()
        let task = Task { await svc.ask(PanelQuestion(question: "질문")) { lines.add($0) } }
        task.cancel()
        await gate.open()
        _ = await task.value
        XCTAssertEqual(factory.count, 0, "취소된 질문은 실행기를 만들지 않는다")
        XCTAssertEqual(lines.all, [])
        XCTAssertFalse(svc.isRunning)
    }

    // MARK: 정보

    func testInfoMapsSelectionAndLoginState() async throws {
        let factory = RunnerFactoryLog { _, _ in .finished(code: 0) }
        let info = CLIAccountInfo(email: "a@b.c", plan: nil)
        let cases: [(CLILoginState, Bool?)] = [(.loggedIn(info), true), (.loggedOut, false), (.unknown, nil)]
        for (login, expected) in cases {
            let i = await service(factory, kind: .chatgpt, modelID: "gpt-x", login: login).info()
            XCTAssertEqual(i, PanelInfo(cli: "chatgpt", cliName: "ChatGPT", model: "gpt-x", loggedIn: expected))
        }
        let none = await service(factory, kind: .opencode).info()
        XCTAssertNil(none.model)
    }

    // MARK: 고른 CLI · 모델(옆 창과 같은 값)

    @MainActor
    func testPanelSelectionFollowsSavedSettingsLikeTheSideWindow() async throws {
        let store = AppSettingsStore(directory: tempDir)
        try store.update { $0.selectedCLI = ModelKind.opencode.rawValue; $0.models["claude"] = "opus"; $0.models["opencode"] = "x/y" }
        let vm = ChatViewModel(runner: FakeRunner(), bridge: FakeBridge(), loginPath: { "/usr/bin:/bin" },
                               workDirectory: { URL(fileURLWithPath: NSTemporaryDirectory()) }, settings: store)
        // 상태 서비스가 없으면 목록이 비어 모델은 CLI 기본(nil)으로 둔다.
        let s = await vm.panelSelection(waitForStatus: true)
        XCTAssertEqual(s.kind, .opencode)
        XCTAssertNil(s.modelID)
        XCTAssertEqual(s.login, .unknown)

        try store.update { $0.selectedCLI = ModelKind.claude.rawValue }
        let vm2 = ChatViewModel(runner: FakeRunner(), bridge: FakeBridge(), loginPath: { "/usr/bin:/bin" },
                                workDirectory: { URL(fileURLWithPath: NSTemporaryDirectory()) }, settings: store)
        let c = await vm2.panelSelection(waitForStatus: false)
        XCTAssertEqual(c.kind, .claude)
        XCTAssertEqual(c.modelID, "opus")
        XCTAssertEqual(c.modelName, "Opus")
    }
}
