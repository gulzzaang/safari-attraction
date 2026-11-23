import XCTest
@testable import AppCore

// MARK: - 시험 도구

/// 기다렸다가 열어 주는 문.
actor Gate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func open() {
        isOpen = true
        let w = waiters; waiters = []
        w.forEach { $0.resume() }
    }
}

/// 가짜 CLI 실행기 — 부른 명령을 적어 두고, 시험이 정한 대본대로 이벤트를 흘린다.
final class FakeRunner: CommandRunning, @unchecked Sendable {
    struct Call: Sendable {
        var executable: String
        var arguments: [String]
        var workDir: URL
        var path: String
        var timeout: TimeInterval
        /// `-p` 다음에 오는 질문(프롬프트) 전체.
        var prompt: String { arguments.firstIndex(of: "-p").map { arguments[$0 + 1] } ?? (arguments.last ?? "") }
    }
    typealias Script = @Sendable (Call, @escaping @Sendable (RunEvent) -> Void) async -> RunOutcome

    private let lock = NSLock()
    private var _calls: [Call] = []
    private var _stopCount = 0
    private var _script: Script = { _, _ in .finished(code: 0) }
    let stopEvents: AsyncStream<Void>
    private let stopCont: AsyncStream<Void>.Continuation

    init() { (stopEvents, stopCont) = AsyncStream.makeStream(of: Void.self) }

    var calls: [Call] { lock.withLock { _calls } }
    var stopCount: Int { lock.withLock { _stopCount } }
    func setScript(_ s: @escaping Script) { lock.withLock { _script = s } }

    func run(executable: String, arguments: [String], workDir: URL, path: String, timeout: TimeInterval,
             onEvent: @escaping @Sendable (RunEvent) -> Void) async -> RunOutcome {
        let call = Call(executable: executable, arguments: arguments, workDir: workDir, path: path, timeout: timeout)
        let script = lock.withLock { _calls.append(call); return _script }
        return await script(call, onEvent)
    }
    func stop() { lock.withLock { _stopCount += 1 }; stopCont.yield() }
}

/// Claude stream-json 한 줄.
func claudeAssistantLine(_ text: String, session: String = "sess-1") -> RunEvent {
    let obj: [String: Any] = ["type": "assistant", "session_id": session,
                              "message": ["content": [["type": "text", "text": text]]]]
    return .stdout(jsonLine(obj))
}
func claudeResultLine(isError: Bool = false, text: String = "", session: String = "sess-1") -> RunEvent {
    .stdout(jsonLine(["type": "result", "session_id": session, "is_error": isError, "result": text]))
}
func jsonLine(_ obj: [String: Any]) -> Data {
    var d = try! JSONSerialization.data(withJSONObject: obj)
    d.append(0x0A)
    return d
}

final class MainFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: Bool?
    var value: Bool? { lock.withLock { _value } }
    func record() { lock.withLock { _value = Thread.isMainThread } }
}

@MainActor
final class ChatViewModelTests: XCTestCase {
    var runner: FakeRunner!
    var bridge: FakeBridge!
    var clock: TestClock!
    var pathOnMain: MainFlag!
    var vm: ChatViewModel!

    override func setUp() async throws {
        runner = FakeRunner(); bridge = FakeBridge(); clock = TestClock(); pathOnMain = MainFlag()
        let c = clock!, flag = pathOnMain!
        vm = ChatViewModel(runner: runner, bridge: bridge,
                           loginPath: { flag.record(); return "/test/bin" },
                           workDirectory: { URL(fileURLWithPath: "/tmp/work-test") },
                           now: { c.date }, enabledModels: ModelKind.allCases)
    }

    func ask(_ q: String) async {
        vm.input = q
        await vm.send()?.value
    }

    func waitUntil(_ what: String = "", timeout: TimeInterval = 3, _ cond: @escaping () -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while !cond() {
            if Date() > end { XCTFail("기다리던 상태가 안 옴 \(what)"); return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    // MARK: 보내기 · 흘러나오기

    func testStreamedTextAccumulatesAsItArrives() async throws {
        let gate = Gate()
        runner.setScript { _, emit in
            emit(claudeAssistantLine("안녕"))
            await gate.wait()
            emit(claudeAssistantLine("하세요"))
            emit(claudeResultLine(text: "안녕하세요"))
            return .finished(code: 0)
        }
        vm.input = "인사해 줘"
        let t = vm.send()
        XCTAssertTrue(vm.isRunning)
        XCTAssertEqual(vm.input, "", "보내면 입력 칸이 비워진다")
        try await waitUntil { self.vm.messages.last?.text == "안녕" }
        XCTAssertTrue(vm.isRunning, "아직 끝나지 않았다")
        XCTAssertTrue(vm.messages.last?.isStreaming == true)
        await gate.open()
        await t?.value
        XCTAssertEqual(vm.messages.map(\.role), [.user, .assistant])
        XCTAssertEqual(vm.messages[0].text, "인사해 줘")
        XCTAssertEqual(vm.messages[1].text, "안녕\n\n하세요", "Claude 는 말풍선 단위라 사이를 한 줄 띄운다")
        XCTAssertFalse(vm.messages[1].isStreaming)
        XCTAssertNil(vm.messages[1].error)
        XCTAssertFalse(vm.isRunning)
    }

    func testAppCallsOnlyClaudeByDefault() async {
        // 박정욱 11-23 「클로드만 기준으로잡고 다른 cli는 사용하지말고」
        XCTAssertEqual(ModelKind.enabled, [.claude])
        let c = clock!
        let only = ChatViewModel(runner: runner, bridge: bridge, loginPath: { "/test/bin" },
                                 workDirectory: { URL(fileURLWithPath: "/tmp/work-test") }, now: { c.date })
        XCTAssertEqual(only.availableModels, [.claude])
        runner.setScript { _, emit in emit(claudeResultLine(text: "ok")); return .finished(code: 0) }
        for m in [ModelKind.gemini, .chatgpt] {
            only.model = m; only.webSearch = true
            only.input = "q"
            await only.send()?.value
        }
        XCTAssertEqual(runner.calls.map(\.executable), ["claude", "claude"], "agy · codex 는 부르지 않는다")
        XCTAssertEqual(only.model, .claude)
        XCTAssertNil(only.messages.last?.notice, "꺼 둔 ChatGPT 안내가 나오면 안 된다")
    }

    func testPlainModelsConcatenateChunksAsIs() async {
        vm.model = .gemini
        runner.setScript { _, emit in
            emit(.stdout(Data("안녕".utf8))); emit(.stdout(Data("하세요".utf8)))
            return .finished(code: 0)
        }
        await ask("hi")
        XCTAssertEqual(vm.messages.last?.text, "안녕하세요")
        XCTAssertEqual(runner.calls.first?.executable, "agy")
    }

    func testRunUsesLoginPathWorkDirAndTimeoutOffTheMainThread() async {
        runner.setScript { _, emit in emit(claudeResultLine(text: "ok")); return .finished(code: 0) }
        await ask("q")
        let c = runner.calls[0]
        XCTAssertEqual(c.path, "/test/bin")
        XCTAssertEqual(c.workDir.path, "/tmp/work-test")
        XCTAssertEqual(c.timeout, ProcessRunner.defaultTimeout)
        XCTAssertEqual(c.executable, "claude")
        XCTAssertEqual(pathOnMain.value, false, "로그인 PATH 읽기는 메인 스레드에서 하지 않는다")
    }

    func testEmptyQuestionOrBusyDoesNotSend() async {
        vm.input = "   \n "
        XCTAssertNil(vm.send())
        let gate = Gate()
        runner.setScript { _, _ in await gate.wait(); return .finished(code: 0) }
        vm.input = "첫째"
        let t = vm.send()
        vm.input = "둘째"
        XCTAssertNil(vm.send(), "답하는 동안엔 새 질문을 받지 않는다")
        XCTAssertEqual(vm.input, "둘째", "못 보낸 글은 입력 칸에 남는다")
        await gate.open(); await t?.value
        XCTAssertEqual(runner.calls.count, 1)
    }

    func testToolUseShowsActivityThenTextClearsIt() async throws {
        let gate = Gate()
        runner.setScript { _, emit in
            emit(.stdout(jsonLine(["type": "assistant", "session_id": "s",
                                   "message": ["content": [["type": "tool_use", "name": "WebSearch"]]]])))
            await gate.wait()
            emit(claudeAssistantLine("결과"))
            return .finished(code: 0)
        }
        vm.webSearch = true
        vm.input = "검색"
        let t = vm.send()
        try await waitUntil { self.vm.activity != nil }
        XCTAssertTrue(vm.activity?.contains("웹") == true)
        await gate.open(); await t?.value
        XCTAssertNil(vm.activity)
    }

    func testClaudeWebSearchToggleReachesCommand() async {
        vm.webSearch = true
        await ask("q")
        XCTAssertTrue(runner.calls[0].arguments.contains("WebSearch,WebFetch"))
        vm.webSearch = false
        await ask("q2")
        XCTAssertFalse(runner.calls[1].arguments.contains("WebSearch,WebFetch"))
    }

    func testChatGPTWebSearchShowsNotice() async {
        vm.model = .chatgpt; vm.webSearch = true
        runner.setScript { _, emit in emit(.stdout(Data("답".utf8))); return .finished(code: 0) }
        await ask("q")
        XCTAssertEqual(vm.messages.last?.notice, CommandBuilder.chatgptNoWebNotice)
        XCTAssertEqual(vm.messages.last?.text, "답")
    }

    // MARK: Claude 이어 묻기 · 모델 바꾸기

    func testClaudeSessionIDIsReusedOnNextSend() async {
        runner.setScript { _, emit in
            emit(claudeAssistantLine("하나", session: "sess-A")); emit(claudeResultLine(text: "하나", session: "sess-A"))
            return .finished(code: 0)
        }
        await ask("첫째")
        XCTAssertFalse(runner.calls[0].arguments.contains("--resume"))
        await ask("둘째")
        let a = runner.calls[1].arguments
        XCTAssertEqual(a.firstIndex(of: "--resume").map { a[$0 + 1] }, "sess-A")
        XCTAssertFalse(runner.calls[1].prompt.contains("[앞 대화]"), "이어 묻기엔 앞 대화를 또 붙이지 않는다")
    }

    func testSwitchingModelsKeepsHistoryAndGivesItToTheNewModel() async {
        runner.setScript { call, emit in
            if call.executable == "claude" { emit(claudeAssistantLine("클로드 답")); emit(claudeResultLine(text: "클로드 답")) }
            else { emit(.stdout(Data("제미나이 답".utf8))) }
            return .finished(code: 0)
        }
        await ask("첫 질문")
        vm.model = .gemini
        XCTAssertEqual(vm.messages.count, 2, "모델을 바꿔도 대화는 남는다")
        await ask("둘째 질문")
        XCTAssertEqual(vm.messages.count, 4)
        let prompt = runner.calls[1].prompt
        XCTAssertTrue(prompt.contains("[앞 대화]"))
        XCTAssertTrue(prompt.contains("첫 질문") && prompt.contains("클로드 답"))
        XCTAssertTrue(prompt.hasSuffix("둘째 질문"))
        // 다시 Claude 로: 제미나이 대화를 모르는 옛 session 대신 앞 대화를 붙인다.
        vm.model = .claude
        await ask("셋째 질문")
        let a = runner.calls[2].arguments
        XCTAssertFalse(a.contains("--resume"))
        XCTAssertTrue(runner.calls[2].prompt.contains("제미나이 답"))
        XCTAssertEqual(vm.messages.count, 6)
    }

    func testFailedAnswersAreNotInTheHistory() async {
        vm.model = .gemini
        runner.setScript { _, emit in emit(.stderr(Data("boom".utf8))); return .finished(code: 1) }
        await ask("실패할 질문")
        runner.setScript { _, emit in emit(.stdout(Data("답".utf8))); return .finished(code: 0) }
        await ask("다음 질문")
        XCTAssertFalse(runner.calls[1].prompt.contains("실패할 질문"))
    }

    func testNewChatDuringRunShowsStoppingStateAndSendWaitsUntilChildIsGone() async throws {
        runner.setScript { [runner = runner!] _, emit in
            emit(claudeAssistantLine("..."))
            for await _ in runner.stopEvents { break }
            return .stopped
        }
        vm.input = "첫 질문"
        let t = vm.send()
        try await waitUntil { self.vm.messages.last?.text == "..." }
        vm.newChat()
        XCTAssertTrue(vm.isStopping, "멈추는 중 표시")
        XCTAssertTrue(vm.messages.isEmpty)
        vm.input = "다음 질문"
        XCTAssertNil(vm.send(), "아직 자식이 있어 보내지 못한다")
        XCTAssertEqual(vm.input, "다음 질문", "글은 입력 칸에 남는다")
        await t?.value
        XCTAssertFalse(vm.isStopping); XCTAssertFalse(vm.isRunning)
        runner.setScript { _, emit in emit(claudeAssistantLine("됐다")); return .finished(code: 0) }
        await vm.send()?.value
        XCTAssertEqual(vm.messages.last?.text, "됐다")
        XCTAssertEqual(vm.messages.first?.text, "다음 질문")
    }

    func testStopButtonAlsoShowsStoppingState() async throws {
        runner.setScript { [runner = runner!] _, emit in
            emit(claudeAssistantLine("..."))
            for await _ in runner.stopEvents { break }
            return .stopped
        }
        vm.input = "q"
        let t = vm.send()
        try await waitUntil { self.vm.messages.last?.text == "..." }
        XCTAssertFalse(vm.isStopping)
        vm.stop()
        XCTAssertTrue(vm.isStopping)
        await t?.value
        XCTAssertFalse(vm.isStopping)
    }

    func testNewChatClearsMessagesAndClaudeSession() async {
        runner.setScript { _, emit in emit(claudeAssistantLine("a", session: "s9")); return .finished(code: 0) }
        await ask("q")
        vm.newChat()
        XCTAssertTrue(vm.messages.isEmpty)
        XCTAssertNil(vm.hint)
        await ask("q2")
        XCTAssertFalse(runner.calls[1].arguments.contains("--resume"))
    }

    // MARK: 멈춤 · 오류

    func testStopShowsStoppedAndKeepsPartialAnswer() async throws {
        runner.setScript { [runner = runner!] _, emit in
            emit(claudeAssistantLine("일부 답"))
            for await _ in runner.stopEvents { break }
            return .stopped
        }
        vm.input = "긴 질문"
        let t = vm.send()
        try await waitUntil { self.vm.messages.last?.text == "일부 답" }
        vm.stop()
        await t?.value
        XCTAssertEqual(runner.stopCount, 1)
        XCTAssertEqual(vm.messages.last?.status, "멈췄어요")
        XCTAssertEqual(vm.messages.last?.text, "일부 답")
        XCTAssertNil(vm.messages.last?.error, "멈춤은 오류가 아니다")
        XCTAssertFalse(vm.isRunning)
        XCTAssertFalse(vm.messages.last?.isStreaming ?? true)
    }

    func testStopWhileStillReadingThePageDoesNotStartTheCommand() async throws {
        bridge.tab = .success(TabReading(page: PageContext(title: "T", url: "https://a.example")))
        vm.attachPage = true
        vm.input = "q"
        let t = vm.send()
        vm.stop()   // 사파리 읽는 중에 멈춤
        await t?.value
        XCTAssertEqual(vm.messages.last?.status, "멈췄어요")
        XCTAssertTrue(runner.calls.isEmpty, "멈춘 뒤에는 명령을 띄우지 않는다")
        XCTAssertFalse(vm.isRunning)
    }

    func testCommandFailureShowsRedErrorLine() async {
        vm.model = .gemini
        runner.setScript { _, emit in emit(.stderr(Data("boom".utf8))); return .finished(code: 2) }
        await ask("q")
        let e = vm.messages.last?.error
        XCTAssertNotNil(e)
        XCTAssertTrue(e?.contains("종료 코드 2") == true)
        XCTAssertNil(vm.messages.last?.status)
        XCTAssertFalse(vm.isRunning)
    }

    func testCLINotFoundShowsFixHint() async {
        runner.setScript { _, _ in .notFound("claude") }
        await ask("q")
        XCTAssertEqual(vm.messages.last?.error, ModelKind.claude.notFoundMessage)
    }

    func testLoginNeededShowsFixHint() async {
        runner.setScript { _, emit in
            emit(claudeResultLine(isError: true, text: "Invalid API key · Please run /login"))
            return .finished(code: 1)
        }
        await ask("q")
        XCTAssertEqual(vm.messages.last?.error, ModelKind.claude.loginNeededMessage)
    }

    func testClaudeErrorResultIsShownOnce() async {
        runner.setScript { _, emit in
            emit(claudeResultLine(isError: true, text: "한도에 걸렸어요"))
            return .finished(code: 1)
        }
        await ask("q")
        XCTAssertEqual(vm.messages.last?.error, "한도에 걸렸어요")
    }

    func testTimeoutShowsMessageAndCanSendAgain() async {
        runner.setScript { _, _ in .timedOut }
        await ask("q")
        XCTAssertEqual(vm.messages.last?.error, ModelKind.claude.userMessage(for: .timedOut))
        runner.setScript { _, emit in emit(claudeAssistantLine("됐다")); return .finished(code: 0) }
        await ask("다시")
        XCTAssertEqual(vm.messages.last?.text, "됐다")
        XCTAssertNil(vm.messages.last?.error)
    }

    // MARK: 이 페이지 함께

    func testPageToggleOffNeverReadsSafari() async {
        bridge.tab = .success(TabReading(page: PageContext(title: "T", url: "https://a.example")))
        vm.attachPage = false
        await ask("q")
        XCTAssertEqual(bridge.tabCalls, 0, "토글이 꺼져 있으면 사파리 탭을 읽지 않는다")
        XCTAssertFalse(runner.calls[0].prompt.contains("[지금 사파리 탭]"))
    }

    func testPageToggleOnReadsOnceAtSendTimeOffMainAndAttaches() async {
        bridge.tab = .success(TabReading(page: PageContext(title: "제목 T", url: "https://a.example/x?q=1", selection: "고른 글입니다")))
        vm.attachPage = true
        await ask("이 글 요약해 줘")
        XCTAssertEqual(bridge.tabCalls, 1)
        XCTAssertEqual(bridge.tabCalledOnMain, false, "사파리 읽기는 메인 스레드에서 하지 않는다")
        let p = runner.calls[0].prompt
        XCTAssertTrue(p.contains("[지금 사파리 탭]\n제목: 제목 T\n주소: https://a.example/x?q=1\n고른 글: 고른 글입니다\n"))
        XCTAssertTrue(p.hasSuffix("이 글 요약해 줘"))
        XCTAssertEqual(vm.messages[0].pageTitle, "제목 T", "사용자 말풍선에 붙은 페이지가 보인다")
        XCTAssertTrue(vm.attachPage, "성공하면 토글은 그대로")
    }

    func testEmptyURLStartPageIsTreatedAsNoPage() async {
        bridge.tab = .success(TabReading(page: PageContext(title: "시작 페이지", url: "")))
        vm.attachPage = true
        await ask("q")
        XCTAssertFalse(runner.calls[0].prompt.contains("[지금 사파리 탭]"))
        XCTAssertNotNil(vm.hint)
        XCTAssertNil(vm.messages[0].pageTitle)
    }

    func testConsentDeniedTurnsToggleOffWithHintAndBacksOffThirtySeconds() async {
        bridge.tab = .failure(.automationDenied)
        vm.attachPage = true
        await ask("첫 질문")
        XCTAssertEqual(bridge.tabCalls, 1)
        XCTAssertFalse(vm.attachPage, "허락이 없으면 토글을 끈다")
        XCTAssertEqual(vm.hint, SafariBridgeError.automationDenied.hint)
        XCTAssertFalse(runner.calls[0].prompt.contains("[지금 사파리 탭]"), "질문은 페이지 없이 그대로 보낸다")

        // 30초 안에 다시 켜고 보내면 사파리를 또 건드리지 않는다.
        clock.advance(10)
        vm.attachPage = true
        await ask("둘째 질문")
        XCTAssertEqual(bridge.tabCalls, 1, "30초 안에는 다시 읽지 않는다")
        XCTAssertFalse(vm.attachPage)
        XCTAssertNotNil(vm.hint)
        XCTAssertEqual(runner.calls.count, 2, "질문 자체는 보낸다")

        clock.advance(21)   // 처음부터 31초
        vm.attachPage = true
        await ask("셋째 질문")
        XCTAssertEqual(bridge.tabCalls, 2, "30초가 지나면 다시 시도")
    }

    func testPendingConsentPromptShowsWaitingMessageNotTryAgainLater() async {
        bridge.tab = .failure(.timedOut)
        vm.attachPage = true
        await ask("q")
        XCTAssertEqual(vm.hint?.contains("사파리 허락을 기다리는 중이에요"), true)
        XCTAssertFalse(vm.hint?.contains("잠시 뒤") ?? true)
        XCTAssertEqual(runner.calls.count, 1)
    }

    func testJavaScriptOffStillAttachesTitleAndURL() async {
        bridge.tab = .success(TabReading(page: PageContext(title: "T", url: "https://a.example"), selectionIssue: .javaScriptDisabled))
        vm.attachPage = true
        await ask("q")
        XCTAssertTrue(runner.calls[0].prompt.contains("주소: https://a.example"))
        XCTAssertEqual(vm.hint, SafariBridgeError.javaScriptDisabled.hint)
    }

    // MARK: 끝낼 때 · 고정

    func testShutdownStopsRunningAnswer() async throws {
        runner.setScript { [runner = runner!] _, emit in
            emit(claudeAssistantLine("..."))
            for await _ in runner.stopEvents { break }
            return .stopped
        }
        vm.input = "q"
        let t = vm.send()
        try await waitUntil { self.vm.messages.last?.text == "..." }
        vm.shutdown()
        XCTAssertGreaterThanOrEqual(runner.stopCount, 1, "앱을 끝낼 때 돌고 있는 답을 멈춘다")
        await t?.value
        XCTAssertFalse(vm.isRunning)
    }

    func testPinnedNotifiesOwner() {
        var seen: [Bool] = []
        vm.onPinnedChange = { seen.append($0) }
        vm.setPinned(true); vm.setPinned(false)
        XCTAssertEqual(seen, [true, false])
        XCTAssertFalse(vm.pinned)
    }

    // MARK: 개발용 기록

    func testLastRunRecordKeepsOnlyHostAndNeverTheSelection() async throws {
        bridge.tab = .success(TabReading(page: PageContext(title: "비밀 제목", url: "https://secret.example/a/b?token=zzz", selection: "고른 글 비밀")))
        vm.attachPage = true
        runner.setScript { _, emit in emit(claudeAssistantLine("답입니다")); emit(claudeResultLine(text: "답입니다")); return .finished(code: 0) }
        await ask("질문입니다")
        let r = try XCTUnwrap(vm.lastRun)
        XCTAssertEqual(r.model, "claude"); XCTAssertEqual(r.question, "질문입니다"); XCTAssertEqual(r.answer, "답입니다")
        XCTAssertNil(r.error)
        XCTAssertEqual(r.attachedPage, RunRecord.AttachedPage(titlePresent: true, urlHost: "secret.example"))
        let json = String(decoding: try RunRecord.encoder.encode(r), as: UTF8.self)
        XCTAssertFalse(json.contains("고른 글 비밀")); XCTAssertFalse(json.contains("token")); XCTAssertFalse(json.contains("비밀 제목"))
    }

    func testLastRunRecordHasErrorAndStoppedState() async {
        runner.setScript { _, _ in .notFound("claude") }
        await ask("q")
        XCTAssertEqual(vm.lastRun?.error, ModelKind.claude.notFoundMessage)
        XCTAssertNil(vm.lastRun?.attachedPage)
    }
}
