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
        var environment: [String: String] = [:]
        /// `-p` 다음에 오는 질문(프롬프트) 전체.
        var prompt: String { arguments.firstIndex(of: "-p").map { arguments[$0 + 1] } ?? (arguments.last ?? "") }
    }
    typealias Script = @Sendable (Call, @escaping @Sendable (RunEvent) -> Void) async -> RunOutcome

    private let lock = NSLock()
    private var _calls: [Call] = []
    private var _stopCount = 0
    private var _extendedBy: [TimeInterval] = []
    private var _script: Script = { _, _ in .finished(code: 0) }
    let stopEvents: AsyncStream<Void>
    private let stopCont: AsyncStream<Void>.Continuation

    init() { (stopEvents, stopCont) = AsyncStream.makeStream(of: Void.self) }

    var calls: [Call] { lock.withLock { _calls } }
    var stopCount: Int { lock.withLock { _stopCount } }
    var extendedBy: [TimeInterval] { lock.withLock { _extendedBy } }
    func setScript(_ s: @escaping Script) { lock.withLock { _script = s } }

    func run(executable: String, arguments: [String], workDir: URL, path: String, timeout: TimeInterval,
             environment: [String: String], onEvent: @escaping @Sendable (RunEvent) -> Void) async -> RunOutcome {
        let call = Call(executable: executable, arguments: arguments, workDir: workDir, path: path, timeout: timeout, environment: environment)
        let script = lock.withLock { _calls.append(call); return _script }
        return await script(call, onEvent)
    }
    func stop() { lock.withLock { _stopCount += 1 }; stopCont.yield() }
    func extendDeadline(by seconds: TimeInterval) { lock.withLock { _extendedBy.append(seconds) } }
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

final class CallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var _count = 0
    var count: Int { lock.withLock { _count } }
    func hit() { lock.withLock { _count += 1 } }
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

    func testAppCallsAllFourCLIsByDefaultButNotDisabledOnes() async {
        // 계획 10 조각 5 — 네 CLI 모두 켠다. `enabledModels` 에서 뺀 CLI 는 여전히 부르지 않는다.
        XCTAssertEqual(ModelKind.enabled, [.claude, .gemini, .chatgpt, .opencode])
        let c = clock!
        let all = ChatViewModel(runner: runner, bridge: bridge, loginPath: { "/test/bin" },
                                workDirectory: { URL(fileURLWithPath: "/tmp/work-test") }, now: { c.date })
        XCTAssertEqual(all.availableModels, [.claude, .gemini, .chatgpt, .opencode])
        let only = ChatViewModel(runner: runner, bridge: bridge, loginPath: { "/test/bin" },
                                 workDirectory: { URL(fileURLWithPath: "/tmp/work-test") }, now: { c.date },
                                 enabledModels: [.claude, .chatgpt])
        runner.setScript { _, emit in emit(claudeResultLine(text: "ok")); return .finished(code: 0) }
        only.model = .gemini; only.input = "q"
        await only.send()?.value
        XCTAssertEqual(runner.calls.map(\.executable), ["claude"], "꺼 둔 CLI 는 부르지 않는다")
        XCTAssertEqual(only.model, .claude)
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
        vm.input = "검색"
        let t = vm.send()
        try await waitUntil { self.vm.activity != nil }
        XCTAssertEqual(vm.activity, "검색 중 …")
        await gate.open(); await t?.value
        XCTAssertNil(vm.activity)
    }

    func testClaudeWebSearchAlwaysEnabledInCommand() async {
        await ask("q")
        XCTAssertTrue(runner.calls[0].arguments.contains("WebSearch,WebFetch"))
        XCTAssertNil(vm.messages.last?.notice)
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
        vm.input = "q"
        let t = vm.send()
        vm.stop()   // 사파리 읽는 중에 멈춤
        await t?.value
        XCTAssertEqual(vm.messages.last?.status, "멈췄어요")
        XCTAssertTrue(runner.calls.isEmpty, "멈춘 뒤에는 명령을 띄우지 않는다")
        XCTAssertFalse(vm.isRunning)
    }

    func testTooLongPromptNeverStartsTheCLIAndShowsKoreanError() async {
        // 한글은 글자당 3바이트 — 7만 자면 21만 바이트라 상한(20만 바이트)을 넘는다.
        await ask(String(repeating: "가", count: 70_000))
        XCTAssertTrue(runner.calls.isEmpty, "너무 긴 질문은 CLI 를 띄우지 않는다")
        let a = vm.messages.last
        XCTAssertEqual(a?.error, CommandBuilder.promptTooLongMessage)
        XCTAssertTrue(a?.error?.contains("너무 길어요") == true)
        XCTAssertFalse(a?.isStreaming ?? true)
        XCTAssertFalse(vm.isRunning)
        XCTAssertEqual(vm.lastRun?.error, CommandBuilder.promptTooLongMessage)
        // 줄여서 다시 보내면 된다.
        await ask("짧은 질문")
        XCTAssertEqual(runner.calls.count, 1)
    }

    func testLoginPathIsNotReadUntilTheFirstQuestionIsSent() async {
        let counter = CallCounter()
        let vm2 = ChatViewModel(runner: runner, bridge: bridge,
                                loginPath: { counter.hit(); return "/test/bin" },
                                workDirectory: { URL(fileURLWithPath: "/tmp/work-test") },
                                now: { [clock] in clock!.date }, enabledModels: ModelKind.allCases)
        XCTAssertEqual(counter.count, 0, "뷰모델을 만든 것만으로는 로그인 셸 PATH 를 읽지 않는다")
        vm2.setPinned(true); vm2.requestFocus()
        XCTAssertEqual(counter.count, 0, "사용자가 질문을 보내기 전에는 읽지 않는다")
        vm2.input = "질문"
        await vm2.send()?.value
        XCTAssertEqual(counter.count, 1, "첫 질문을 보낼 때 읽는다")
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

    func testTimeoutMessage() async {
        runner.setScript { _, _ in .timedOut }
        await ask("q")
        XCTAssertEqual(vm.messages.last?.error, "5분 안에 끝나지 않아 멈췄어요 — 생각 단계를 낮추거나 나눠서 시켜 보세요")
        runner.setScript { _, emit in emit(claudeAssistantLine("됐다")); return .finished(code: 0) }
        await ask("다시")
        XCTAssertEqual(vm.messages.last?.text, "됐다")
        XCTAssertNil(vm.messages.last?.error)
    }

    // MARK: 지금 사파리 탭 자동 첨부

    func testNoSafariWindowDropsPageSilently() async {
        bridge.tab = .failure(.noWindow)
        await ask("q")
        XCTAssertEqual(bridge.tabCalls, 1)
        XCTAssertFalse(runner.calls[0].prompt.contains("[지금 사파리 탭]"))
        XCTAssertNil(vm.hint, "사파리 창이 없으면 조용히 뺀다")
        XCTAssertNil(vm.messages[0].pageTitle)
    }

    func testPageAlwaysAttachedWhenSafariHasTab() async {
        bridge.tab = .success(TabReading(page: PageContext(title: "제목 T", url: "https://a.example/x?q=1", selection: "고른 글입니다")))
        await ask("이 글 요약해 줘")
        XCTAssertEqual(bridge.tabCalls, 1)
        XCTAssertEqual(bridge.tabCalledOnMain, false, "사파리 읽기는 메인 스레드에서 하지 않는다")
        let p = runner.calls[0].prompt
        XCTAssertTrue(p.contains("[지금 사파리 탭]\n제목: 제목 T\n주소: https://a.example/x?q=1\n고른 글: 고른 글입니다\n"))
        XCTAssertTrue(p.hasSuffix("이 글 요약해 줘"))
        XCTAssertEqual(vm.messages[0].pageTitle, "제목 T", "사용자 말풍선에 붙은 페이지가 보인다")
    }

    func testEmptyURLStartPageIsDroppedSilently() async {
        bridge.tab = .success(TabReading(page: PageContext(title: "시작 페이지", url: "")))
        await ask("q")
        XCTAssertFalse(runner.calls[0].prompt.contains("[지금 사파리 탭]"))
        XCTAssertNil(vm.hint, "시작 페이지 등은 조용히 뺀다")
        XCTAssertNil(vm.messages[0].pageTitle)
    }

    func testConsentDeniedShowsHintAndBacksOffThirtySeconds() async {
        bridge.tab = .failure(.automationDenied)
        await ask("첫 질문")
        XCTAssertEqual(bridge.tabCalls, 1)
        XCTAssertEqual(vm.hint, SafariBridgeError.automationDenied.hint)
        XCTAssertFalse(runner.calls[0].prompt.contains("[지금 사파리 탭]"), "질문은 페이지 없이 그대로 보낸다")

        // 30초 안에 다시 보내면 사파리를 또 건드리지 않는다.
        clock.advance(10)
        await ask("둘째 질문")
        XCTAssertEqual(bridge.tabCalls, 1, "30초 안에는 다시 읽지 않는다")
        XCTAssertEqual(runner.calls.count, 2, "질문 자체는 보낸다")

        clock.advance(21)   // 처음부터 31초
        await ask("셋째 질문")
        XCTAssertEqual(bridge.tabCalls, 2, "30초가 지나면 다시 시도")
    }

    func testPendingConsentPromptShowsWaitingMessageNotTryAgainLater() async {
        bridge.tab = .failure(.timedOut)
        await ask("q")
        XCTAssertEqual(vm.hint?.contains("사파리 허락을 기다리는 중이에요"), true)
        XCTAssertFalse(vm.hint?.contains("잠시 뒤") ?? true)
        XCTAssertEqual(runner.calls.count, 1)
    }

    func testJavaScriptOffStillAttachesTitleAndURL() async {
        bridge.tab = .success(TabReading(page: PageContext(title: "T", url: "https://a.example"), selectionIssue: .javaScriptDisabled))
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

    // MARK: 한 칸 질문 — 사파리 도구 · 관문 자리 · 허락 카드 · 생각 단계

    private func makeGateRig(routineName: @escaping @MainActor () -> String? = { nil },
                             hasNode: @escaping @Sendable (String) -> Bool = { _ in true },
                             createRunScript: Bool = true,
                             sleeper: ManualSleeper? = nil) throws -> (vm: ChatViewModel, fakeGate: FakeGate, gate: InteractiveGate, siteModes: SiteModeStore, support: URL, resources: URL) {
        let support = FileManager.default.temporaryDirectory.appendingPathComponent("vm-gate-\(UUID().uuidString)", isDirectory: true)
        let resources = support.appendingPathComponent("Resources", isDirectory: true)
        try FileManager.default.createDirectory(at: resources.appendingPathComponent("safari-attraction", isDirectory: true), withIntermediateDirectories: true)
        if createRunScript {
            try "#!/bin/sh\n".write(to: resources.appendingPathComponent("safari-attraction/run.sh"), atomically: true, encoding: .utf8)
        }
        addTeardownBlock { try? FileManager.default.removeItem(at: support) }
        let fakeGate = FakeGate()
        let ig = InteractiveGate(support: support, makeServer: { fakeGate }, routineName: routineName)
        try ig.start()
        addTeardownBlock { Task { @MainActor in ig.shutdown() } }
        let siteModes = SiteModeStore(directory: support)
        let settings = AppSettingsStore(directory: support)
        let c = clock!
        let sl = sleeper
        let vm = ChatViewModel(
            runner: runner, bridge: bridge,
            loginPath: { "/test/bin" },
            workDirectory: { support.appendingPathComponent("work", isDirectory: true) },
            supportDirectory: { support },
            now: { c.date },
            enabledModels: ModelKind.allCases,
            settings: settings,
            interactiveGate: ig,
            siteModes: siteModes,
            safariResources: resources,
            nodeCheck: hasNode,
            sleep: { sec in
                if let sl { try await sl.sleep(sec) }
                else { try await Task.sleep(nanoseconds: UInt64(sec * 1_000_000_000)) }
            }
        )
        return (vm, fakeGate, ig, siteModes, support, resources)
    }

    private func clickRequest(id: String = "g1", host: String = "www.example.com", action: String = "click",
                              target: String = "로그인", value: String = "", irreversible: Bool? = false) -> GateRequest {
        GateRequest(id: id, host: host, url: "https://\(host)/", action: action, target: target, value: value, irreversible: irreversible)
    }

    func testSendAttachesSafariToolsWhenLeaseFree() async throws {
        let rig = try makeGateRig()
        runner.setScript { _, emit in
            emit(claudeAssistantLine("완료"))
            emit(claudeResultLine(text: "완료"))
            return .finished(code: 0)
        }
        rig.vm.input = "사파리 열어 줘"
        await rig.vm.send()?.value
        let args = try XCTUnwrap(runner.calls.first?.arguments)
        let idx = try XCTUnwrap(args.firstIndex(of: "--mcp-config"))
        let mcp = args[idx + 1]
        XCTAssertTrue(mcp.contains(rig.resources.appendingPathComponent("safari-attraction/run.sh").path))
        XCTAssertTrue(mcp.contains(GateLink.url(support: rig.support).path))
        XCTAssertTrue(mcp.contains(rig.support.appendingPathComponent("memory").path))
        XCTAssertFalse(args.contains("--safe-mode"))
        XCTAssertNil(rig.vm.messages.last?.notice)
        XCTAssertNil(rig.gate.holder, "질문이 끝나면 관문 자리를 푼다")
    }

    func testSecondAskWithoutLeaseShowsNotice() async throws {
        let rig = try makeGateRig()
        let held = try XCTUnwrap(rig.gate.acquire { _ in .allow })
        defer { held.release() }
        runner.setScript { _, emit in
            emit(claudeAssistantLine("답만 했어요"))
            emit(claudeResultLine(text: "답만 했어요"))
            return .finished(code: 0)
        }
        rig.vm.input = "질문"
        await rig.vm.send()?.value
        XCTAssertEqual(rig.vm.messages.last?.notice, "다른 질문이 사파리를 쓰는 중이라 이번 답은 사파리를 움직이지 않아요")
        let args = try XCTUnwrap(runner.calls.first?.arguments)
        XCTAssertFalse(args.contains("--mcp-config"))
        XCTAssertTrue(args.contains("--safe-mode"))
    }

    func testRoutineRunningShowsNoticeAndSkipsSafariTools() async throws {
        let rig = try makeGateRig(routineName: { "아침 뉴스" })
        runner.setScript { _, emit in
            emit(claudeAssistantLine("답"))
            return .finished(code: 0)
        }
        rig.vm.input = "질문"
        await rig.vm.send()?.value
        XCTAssertEqual(rig.vm.messages.last?.notice, "루틴 「아침 뉴스」 이 도는 중이라 이번 답은 사파리를 움직이지 않아요")
        XCTAssertFalse(runner.calls[0].arguments.contains("--mcp-config"))
    }

    func testMissingNodeShowsNoticeAndReleasesLease() async throws {
        let rig = try makeGateRig(hasNode: { _ in false })
        runner.setScript { _, emit in
            emit(claudeAssistantLine("답"))
            return .finished(code: 0)
        }
        rig.vm.input = "질문"
        await rig.vm.send()?.value
        XCTAssertEqual(rig.vm.messages.last?.notice, "사파리 도구를 못 켰어요(Node 18 이상 필요) — 답만 해요")
        XCTAssertFalse(runner.calls[0].arguments.contains("--mcp-config"))
        XCTAssertNil(rig.gate.holder)
    }

    func testCardAllowResolvesGateAllow() async throws {
        let rig = try makeGateRig()
        let hold = Gate()
        runner.setScript { _, emit in
            await hold.wait()
            emit(claudeAssistantLine("눌렀어요"))
            emit(claudeResultLine(text: "눌렀어요"))
            return .finished(code: 0)
        }
        rig.vm.input = "로그인 눌러 줘"
        let sendTask = try XCTUnwrap(rig.vm.send())
        try await waitUntil("실행 시작") { self.runner.calls.count == 1 }

        let decisionTask = rig.fakeGate.request(clickRequest(target: "로그인"))
        try await waitUntil("카드 표시") { rig.vm.messages.contains { $0.cardID != nil } }
        let cardMsg = try XCTUnwrap(rig.vm.messages.first { $0.cardID != nil })
        let cardID = try XCTUnwrap(cardMsg.cardID)
        XCTAssertEqual(cardMsg.card, .actionCard(host: "www.example.com", action: "click", target: "로그인", value: "", danger: false, state: .pending))
        XCTAssertTrue(rig.vm.hasPendingCard)

        XCTAssertTrue(rig.vm.answerCard(id: cardID, .approve))
        let decision = await decisionTask.value
        XCTAssertEqual(decision, .allow)
        XCTAssertFalse(rig.vm.hasPendingCard)
        XCTAssertEqual(rig.vm.messages.first { $0.cardID == cardID }?.card,
                       .actionCard(host: "www.example.com", action: "click", target: "로그인", value: "", danger: false, state: .approved))

        await hold.open()
        await sendTask.value
        XCTAssertEqual(rig.vm.messages.last?.text, "눌렀어요")
    }

    func testCardDenyResolvesGateDeny() async throws {
        let rig = try makeGateRig()
        let hold = Gate()
        runner.setScript { _, emit in
            await hold.wait()
            emit(claudeAssistantLine("안 눌렀어요"))
            return .finished(code: 0)
        }
        rig.vm.input = "눌러 줘"
        let sendTask = try XCTUnwrap(rig.vm.send())
        try await waitUntil("실행 시작") { self.runner.calls.count == 1 }

        let decisionTask = rig.fakeGate.request(clickRequest())
        try await waitUntil("카드 표시") { rig.vm.messages.contains { $0.cardID != nil } }
        let cardID = try XCTUnwrap(rig.vm.messages.first { $0.cardID != nil }?.cardID)

        XCTAssertTrue(rig.vm.answerCard(id: cardID, .reject))
        let decision = await decisionTask.value
        XCTAssertEqual(decision, .deny(AgentSession.cardRejectedReason))
        XCTAssertEqual(rig.vm.messages.first { $0.cardID == cardID }?.card,
                       .actionCard(host: "www.example.com", action: "click", target: "로그인", value: "", danger: false, state: .rejected))

        await hold.open()
        await sendTask.value
    }

    func testCardAlwaysAllowSiteSavesMode() async throws {
        let rig = try makeGateRig()
        let hold = Gate()
        runner.setScript { _, emit in
            await hold.wait()
            emit(claudeAssistantLine("완료"))
            return .finished(code: 0)
        }
        rig.vm.input = "눌러 줘"
        let sendTask = try XCTUnwrap(rig.vm.send())
        try await waitUntil("실행 시작") { self.runner.calls.count == 1 }

        let decisionTask = rig.fakeGate.request(clickRequest(host: "shop.example.com"))
        try await waitUntil("카드 표시") { rig.vm.messages.contains { $0.cardID != nil } }
        let cardID = try XCTUnwrap(rig.vm.messages.first { $0.cardID != nil }?.cardID)

        XCTAssertTrue(rig.vm.answerCard(id: cardID, .alwaysAllowSite))
        let decision = await decisionTask.value
        XCTAssertEqual(decision, .allow)
        XCTAssertEqual(rig.siteModes.mode(for: "shop.example.com"), .allowAll)
        await hold.open()
        await sendTask.value
    }

    func testCodeCardFromGateResolvesAllowAndRejectsAlwaysAllow() async throws {
        let rig = try makeGateRig()
        let hold = Gate()
        runner.setScript { _, emit in await hold.wait(); emit(claudeAssistantLine("끝")); return .finished(code: 0) }
        rig.vm.input = "실행해 줘"
        let sendTask = try XCTUnwrap(rig.vm.send())
        try await waitUntil("실행 시작") { self.runner.calls.count == 1 }

        let decisionTask = rig.fakeGate.request(clickRequest(action: "code", target: "코드 실행", value: "require('child_process')", irreversible: true))
        try await waitUntil("코드 카드") { rig.vm.messages.contains { $0.cardID != nil } }
        let cardMsg = try XCTUnwrap(rig.vm.messages.first { $0.cardID != nil })
        let cardID = try XCTUnwrap(cardMsg.cardID)
        XCTAssertEqual(cardMsg.card, .codeCard(code: "require('child_process')", state: .pending))
        XCTAssertFalse(rig.vm.answerCard(id: cardID, .alwaysAllowSite), "코드 카드는 늘 허락 불가")
        XCTAssertTrue(rig.vm.answerCard(id: cardID, .approve))
        let d = await decisionTask.value
        XCTAssertEqual(d, .allow)
        await hold.open()
        await sendTask.value
    }

    func testStopWithdrawsPendingCardAndReleasesLease() async throws {
        let rig = try makeGateRig()
        runner.setScript { [runner = runner!] _, _ in
            for await _ in runner.stopEvents { break }
            return .stopped
        }
        rig.vm.input = "눌러 줘"
        let sendTask = try XCTUnwrap(rig.vm.send())
        try await waitUntil("실행 시작") { self.runner.calls.count == 1 }

        let decisionTask = rig.fakeGate.request(clickRequest())
        try await waitUntil("카드 표시") { rig.vm.messages.contains { $0.cardID != nil } }
        let cardID = try XCTUnwrap(rig.vm.messages.first { $0.cardID != nil }?.cardID)

        rig.vm.stop()
        let decision = await decisionTask.value
        XCTAssertEqual(decision, .deny(GateServer.stoppedReason))
        XCTAssertFalse(rig.vm.hasPendingCard)
        XCTAssertEqual(rig.vm.messages.first { $0.cardID == cardID }?.card,
                       .actionCard(host: "www.example.com", action: "click", target: "로그인", value: "", danger: false, state: .stopped))
        XCTAssertNil(rig.gate.holder, "멈추면 자리를 푼다")
        await sendTask.value
        XCTAssertFalse(rig.vm.isRunning)
    }

    func testCardWaitExtendsDeadline() async throws {
        let rig = try makeGateRig()
        let hold = Gate()
        runner.setScript { _, emit in
            await hold.wait()
            emit(claudeAssistantLine("완료"))
            return .finished(code: 0)
        }
        rig.vm.input = "눌러 줘"
        let sendTask = try XCTUnwrap(rig.vm.send())
        try await waitUntil("실행 시작") { self.runner.calls.count == 1 }

        let decisionTask = rig.fakeGate.request(clickRequest())
        try await waitUntil("카드 표시") { rig.vm.messages.contains { $0.cardID != nil } }
        let cardID = try XCTUnwrap(rig.vm.messages.first { $0.cardID != nil }?.cardID)

        clock.advance(42)
        XCTAssertTrue(rig.vm.answerCard(id: cardID, .approve))
        _ = await decisionTask.value
        XCTAssertEqual(runner.extendedBy, [42], "카드를 기다린 시간만큼 마감을 뒤로 민다")

        await hold.open()
        await sendTask.value
    }

    func testCardExpiresAfter300Seconds() async throws {
        let sl = ManualSleeper()
        let rig = try makeGateRig(sleeper: sl)
        let hold = Gate()
        runner.setScript { _, emit in await hold.wait(); emit(claudeAssistantLine("끝")); return .finished(code: 0) }
        rig.vm.input = "눌러 줘"
        let sendTask = try XCTUnwrap(rig.vm.send())
        try await waitUntil("실행 시작") { self.runner.calls.count == 1 }

        let decisionTask = rig.fakeGate.request(clickRequest())
        try await waitUntil("카드 시계") { sl.sleepingCount == 1 }
        XCTAssertEqual(sl.requested, [300])
        sl.advance(300)
        let decision = await decisionTask.value
        XCTAssertEqual(decision, .deny(AgentSession.cardExpiredReason))
        XCTAssertFalse(rig.vm.hasPendingCard)

        await hold.open()
        await sendTask.value
    }

    func testEffortSavedPerCLIAndDefaultRemovesKey() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("vm-effort-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }

        let store = AppSettingsStore(directory: dir)
        let c = clock!
        let vm = ChatViewModel(runner: runner, bridge: bridge, loginPath: { "/test/bin" },
                               workDirectory: { dir }, now: { c.date },
                               enabledModels: ModelKind.allCases, settings: store)

        XCTAssertEqual(vm.effortChoices(for: .claude), Effort.claudeLevels)
        XCTAssertNil(vm.selectedEffort(for: .claude))

        vm.setEffort("high", for: .claude)
        vm.setEffort("low", for: .opencode)
        XCTAssertEqual(vm.selectedEffort(for: .claude), "high")
        XCTAssertEqual(vm.selectedEffort(for: .opencode), "low")
        XCTAssertEqual(AppSettingsStore(directory: dir).current.efforts, ["claude": "high", "opencode": "low"])

        // 클로드 질문에 --effort high 가 들어간다.
        runner.setScript { _, emit in emit(claudeResultLine(text: "ok")); return .finished(code: 0) }
        vm.input = "질문"
        await vm.send()?.value
        let args = try XCTUnwrap(runner.calls.first?.arguments)
        XCTAssertEqual(args[try XCTUnwrap(args.firstIndex(of: "--effort")) + 1], "high")

        // 기본(nil)을 고르면 키가 지워진다.
        vm.setEffort(nil, for: .claude)
        XCTAssertNil(vm.selectedEffort(for: .claude))
        XCTAssertNil(AppSettingsStore(directory: dir).current.efforts["claude"])
        XCTAssertEqual(AppSettingsStore(directory: dir).current.efforts["opencode"], "low")
    }

    func testOldAgySettingsSplitsIntoModelAndEffort() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("vm-agy-old-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        try Data(#"{"selectedCLI":"gemini","models":{"gemini":"gemini-4-neon-xhigh"},"agyMode":"isolated","webSearch":true,"attachPage":true}"#.utf8)
            .write(to: dir.appendingPathComponent("settings.json"))

        let script = ScriptedCLIRunner()
        let gdir = CLIEnvironment.agyGeminiDirectory(support: dir)
        let cmd = CLICommands.agyModels(geminiDir: gdir)
        let key = ([cmd.executable] + cmd.arguments).joined(separator: " ")
        script.reply(key, stdout: "gemini-4-neon-low\tN Low\ngemini-4-neon-medium\tN Med\ngemini-4-neon-high\tN High\ngemini-4-neon-xhigh\tN XHigh\ngemini-pro-orchestrator\tOrch\n")
        let bin = FileManager.default.temporaryDirectory.appendingPathComponent("fakebin-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let agyBin = bin.appendingPathComponent("agy")
        try "#!/bin/sh\n".write(to: agyBin, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: agyBin.path)
        addTeardownBlock { try? FileManager.default.removeItem(at: bin) }

        let status = CLIStatusService(loginPath: { bin.path }, runnerFactory: { script }, workDirectory: { dir }, supportDirectory: { dir }, timeout: 5)
        await status.refresh(.gemini, force: true)

        let store = AppSettingsStore(directory: dir)
        let c = clock!
        let vm = ChatViewModel(runner: runner, bridge: bridge, loginPath: { bin.path },
                               workDirectory: { dir }, supportDirectory: { dir }, now: { c.date },
                               enabledModels: ModelKind.allCases, settings: store, status: status)

        XCTAssertEqual(vm.model, .gemini)
        XCTAssertEqual(vm.selectedDisplayModelID(for: .gemini), "gemini-4-neon")
        XCTAssertEqual(vm.selectedEffort(for: .gemini), "xhigh")
        XCTAssertEqual(Effort.label(vm.selectedEffort(for: .gemini)!), "매우 높음")
        XCTAssertEqual(vm.selectedModelID(for: .gemini), "gemini-4-neon-xhigh")
        XCTAssertEqual(vm.effortChoices(for: .gemini), ["low", "medium", "high", "xhigh"])
    }

    func testEffortPickerHelpers() {
        XCTAssertFalse(Effort.shouldShowPicker(choices: []))
        XCTAssertTrue(Effort.shouldShowPicker(choices: ["low", "high"]))
        XCTAssertEqual(Effort.pickerTitle(selected: nil), "생각: 기본")
        XCTAssertEqual(Effort.pickerTitle(selected: ""), "생각: 기본")
        XCTAssertEqual(Effort.pickerTitle(selected: "high"), "생각: 높음")
        XCTAssertEqual(Effort.pickerTitle(selected: "xhigh"), "생각: 매우 높음")
    }
}
