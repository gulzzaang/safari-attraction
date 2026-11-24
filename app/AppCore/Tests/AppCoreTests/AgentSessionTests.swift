import XCTest
@testable import AppCore

// MARK: - 시험 도구

/// 가짜 양방향 실행기 — 부른 명령 · 쓴 줄 · 입력 닫기 · 멈춤을 적어 두고, 시험이 정한 줄을 내보낸다.
/// `finish` 를 부르거나 멈추면(또 `exitsWhenInputCloses` 일 때 입력을 닫으면) 끝난다.
final class FakeInteractiveRunner: InteractiveRunning, @unchecked Sendable {
    struct Call: Sendable {
        var executable: String
        var arguments: [String]
        var path: String
        var timeout: TimeInterval
        var initialLines: [String]
    }

    private let lock = NSLock()
    private var _call: Call?
    private var _writes: [String] = []
    private var _closeCount = 0
    private var _stopCount = 0
    private var onEvent: (@Sendable (RunEvent) -> Void)?
    private var continuation: CheckedContinuation<RunOutcome, Never>?
    private var pendingOutcome: RunOutcome?
    private var _mainThreadCalls = 0
    var exitsWhenInputCloses = true
    /// `write` · `closeInput` 이 메인 스레드에서 불린 횟수 — 0 이어야 한다(막힐 수 있는 일은 메인 밖에서).
    var mainThreadCalls: Int { lock.withLock { _mainThreadCalls } }

    var call: Call? { lock.withLock { _call } }
    var writes: [String] { lock.withLock { _writes } }
    var closeCount: Int { lock.withLock { _closeCount } }
    var stopCount: Int { lock.withLock { _stopCount } }

    func runInteractive(executable: String, arguments: [String], workDir: URL, path: String, timeout: TimeInterval,
                        initialLines: [String], onEvent: @escaping @Sendable (RunEvent) -> Void) async -> RunOutcome {
        await withCheckedContinuation { (c: CheckedContinuation<RunOutcome, Never>) in
            lock.lock()
            _call = Call(executable: executable, arguments: arguments, path: path, timeout: timeout, initialLines: initialLines)
            self.onEvent = onEvent
            if let o = pendingOutcome { pendingOutcome = nil; lock.unlock(); c.resume(returning: o); return }
            continuation = c
            lock.unlock()
        }
    }

    func write(_ line: String) throws {
        lock.withLock { _writes.append(line); if Thread.isMainThread { _mainThreadCalls += 1 } }
    }

    func closeInput() {
        lock.withLock { _closeCount += 1; if Thread.isMainThread { _mainThreadCalls += 1 } }
        if exitsWhenInputCloses { finish(.finished(code: 0)) }
    }

    func stop() {
        lock.withLock { _stopCount += 1 }
        finish(.stopped)
    }

    func finish(_ outcome: RunOutcome) {
        lock.lock()
        guard let c = continuation else { if pendingOutcome == nil { pendingOutcome = outcome }; lock.unlock(); return }
        continuation = nil
        lock.unlock()
        c.resume(returning: outcome)
    }

    func emit(_ obj: [String: Any]) {
        let cb = lock.withLock { onEvent }
        cb?(.stdout(jsonLine(obj)))
    }
    func emit(raw event: RunEvent) {
        let cb = lock.withLock { onEvent }
        cb?(event)
    }
}

/// 가짜 관문 서버 — 시험이 요청을 직접 넣는다.
final class FakeGate: GateServing, @unchecked Sendable {
    let info = GateInfo(socketPath: "/tmp/fake-gate/s.sock", token: String(repeating: "ab", count: 32))
    private let lock = NSLock()
    private var handler: (@Sendable (GateRequest) async -> GateDecision)?
    private var _stopCount = 0
    var stopCount: Int { lock.withLock { _stopCount } }
    var started: Bool { lock.withLock { handler != nil } }

    func start(onRequest: @escaping @Sendable (GateRequest) async -> GateDecision) { lock.withLock { handler = onRequest } }
    func stop() { lock.withLock { _stopCount += 1 } }

    /// 요청 하나를 따로 도는 작업으로 넣는다 — 취소하면 손님이 끊은 것과 같다.
    func request(_ r: GateRequest) -> Task<GateDecision, Never> {
        let h = lock.withLock { handler }
        return Task.detached { await h?(r) ?? .deny("no handler") }
    }
}

/// 손으로 돌리는 시계 — `advance` 로 시간을 보내면 그만큼 지난 잠이 깬다. 취소하면 잠에서 오류로 나온다.
final class ManualSleeper: @unchecked Sendable {
    private let lock = NSLock()
    private var now: TimeInterval = 0
    private var nextID = 0
    private var waiters: [Int: (deadline: TimeInterval, cont: CheckedContinuation<Void, Error>)] = [:]
    private var cancelled: Set<Int> = []
    private var _requested: [TimeInterval] = []
    var requested: [TimeInterval] { lock.withLock { _requested } }
    /// 지금 자고 있는(시계가 등록된) 것의 수.
    var sleepingCount: Int { lock.withLock { waiters.count } }

    func sleep(_ seconds: TimeInterval) async throws {
        let id = lock.withLock { () -> Int in nextID += 1; _requested.append(seconds); return nextID }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                lock.lock()
                if cancelled.contains(id) { lock.unlock(); c.resume(throwing: CancellationError()); return }
                waiters[id] = (now + seconds, c)
                lock.unlock()
            }
        } onCancel: {
            lock.lock()
            if let w = waiters.removeValue(forKey: id) { lock.unlock(); w.cont.resume(throwing: CancellationError()) }
            else { cancelled.insert(id); lock.unlock() }
        }
    }

    func advance(_ seconds: TimeInterval) {
        lock.lock()
        now += seconds
        let due = waiters.filter { $0.value.deadline <= now }
        for k in due.keys { waiters.removeValue(forKey: k) }
        lock.unlock()
        for w in due.values { w.cont.resume() }
    }
}

final class RunnerFactoryBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _made: [FakeInteractiveRunner] = []
    var made: [FakeInteractiveRunner] { lock.withLock { _made } }
    func make() -> FakeInteractiveRunner {
        let r = FakeInteractiveRunner()
        lock.withLock { _made.append(r) }
        return r
    }
}

@MainActor
final class AgentSessionTests: XCTestCase {
    var tmp: URL!
    var memoryHome: URL!
    var siteModes: SiteModeStore!
    var sleeper: ManualSleeper!
    var runners: RunnerFactoryBox!
    var gates: [FakeGate] = []
    var session: AgentSession!

    override func setUp() async throws {
        tmp = FileManager.default.temporaryDirectory.appendingPathComponent("agent-session-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        memoryHome = tmp.appendingPathComponent("memory", isDirectory: true)
        siteModes = SiteModeStore(directory: tmp)
        sleeper = ManualSleeper()
        runners = RunnerFactoryBox()
        gates = []
        session = makeSession()
    }

    override func tearDown() async throws {
        for r in runners.made { XCTAssertEqual(r.mainThreadCalls, 0, "write · closeInput 은 메인 스레드에서 부르지 않는다") }
        session.shutdown()
        try? FileManager.default.removeItem(at: tmp)
    }

    func makeSession(gateFactory: (@MainActor () throws -> GateServing)? = nil) -> AgentSession {
        let box = runners!, sl = sleeper!
        return AgentSession(
            resources: URL(fileURLWithPath: "/tmp/test-resources"), memoryHome: memoryHome, siteModes: siteModes,
            gateFactory: gateFactory ?? { [unowned self] in let g = FakeGate(); self.gates.append(g); return g },
            runnerFactory: { box.make() },
            loginPath: { "/test/bin" },
            workDirectory: { URL(fileURLWithPath: "/tmp/work-test") },
            sleep: { try await sl.sleep($0) })
    }

    func waitUntil(_ what: String = "", timeout: TimeInterval = 3, _ cond: @escaping () -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while !cond() {
            if Date() > end { XCTFail("기다리던 상태가 안 옴 \(what)"); return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    /// 입력을 보내고 프로세스가 뜰 때까지 기다린다.
    @discardableResult
    func start(_ text: String, index: Int? = nil) async throws -> (runner: FakeInteractiveRunner, gate: FakeGate, task: Task<Void, Never>) {
        let i = index ?? runners.made.count
        session.input = text
        guard let t = session.send() else { XCTFail("send 가 nil"); fatalError() }
        try await waitUntil("프로세스 \(i)") { self.runners.made.count > i && self.runners.made[i].call != nil }
        return (runners.made[i], gates[i], t)
    }

    // 클로드가 내는 줄
    func canUseTool(_ id: String, _ tool: String, _ input: [String: Any] = [:]) -> [String: Any] {
        ["type": "control_request", "request_id": id,
         "request": ["subtype": "can_use_tool", "tool_name": tool, "tool_use_id": "tu-\(id)", "input": input]]
    }
    func assistant(_ text: String, session: String = "sess-1") -> [String: Any] {
        ["type": "assistant", "session_id": session, "message": ["content": [["type": "text", "text": text]]]]
    }
    func toolUse(_ name: String) -> [String: Any] {
        ["type": "assistant", "session_id": "sess-1", "message": ["content": [["type": "tool_use", "name": name]]]]
    }
    func result(isError: Bool = false, text: String = "", session: String = "sess-1") -> [String: Any] {
        ["type": "result", "session_id": session, "is_error": isError, "result": text]
    }

    func gateRequest(id: String = "g1", host: String = "www.example.com", action: String = "click",
                     target: String = "장바구니 담기", value: String = "", irreversible: Bool? = false) -> GateRequest {
        GateRequest(id: id, host: host, url: "https://\(host)/", action: action, target: target, value: value, irreversible: irreversible)
    }

    // 앱이 쓴 줄 읽기
    struct Reply { var subtype: String; var requestID: String; var behavior: String?; var message: String?; var setMode: Bool; var error: String? }
    func replies(_ r: FakeInteractiveRunner) -> [Reply] {
        r.writes.compactMap { line in
            guard let o = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  o["type"] as? String == "control_response", let resp = o["response"] as? [String: Any] else { return nil }
            let inner = resp["response"] as? [String: Any]
            let perms = inner?["updatedPermissions"] as? [[String: Any]]
            return Reply(subtype: resp["subtype"] as? String ?? "", requestID: resp["request_id"] as? String ?? "",
                         behavior: inner?["behavior"] as? String, message: inner?["message"] as? String,
                         setMode: perms?.first?["type"] as? String == "setMode" && perms?.first?["mode"] as? String == "manual",
                         error: resp["error"] as? String)
        }
    }
    func reply(_ r: FakeInteractiveRunner, _ id: String) -> Reply? { replies(r).first { $0.requestID == id } }

    var cards: [AgentMessage] { session.messages.filter { $0.cardState != nil } }
    var lastCard: AgentMessage? { cards.last }

    /// 계획 카드를 띄워 승인까지(단계 executing).
    func approvePlan(_ r: FakeInteractiveRunner, id: String = "plan1") async throws {
        r.emit(canUseTool(id, "ExitPlanMode", ["plan": "1. 쿠팡을 연다\n2. 담는다"]))
        try await waitUntil("계획 카드") { self.lastCard != nil }
        XCTAssertTrue(session.answer(cardID: lastCard!.id, .approve))
        XCTAssertEqual(session.phase, .executing)
    }

    // MARK: 명령 · 입력 · 이어 하기

    func testFirstInputBuildsPlanModeCommandAndPutsUserLineInInitialLines() async throws {
        let (r, gate, t) = try await start("쿠팡에서 우유 찾아 줘")
        let call = r.call!
        XCTAssertEqual(call.executable, "claude")
        XCTAssertTrue(call.arguments.contains("--permission-prompt-tool"))
        XCTAssertEqual(call.arguments[call.arguments.firstIndex(of: "--permission-mode")! + 1], "plan")
        XCTAssertFalse(call.arguments.contains("--resume"))
        XCTAssertFalse(call.arguments.joined(separator: " ").contains("우유"), "사람 글은 명령줄에 넣지 않는다")
        XCTAssertEqual(call.initialLines, [ClaudeControl.userMessage("쿠팡에서 우유 찾아 줘")])
        XCTAssertEqual(call.path, "/test/bin")
        let mcp = call.arguments[call.arguments.firstIndex(of: "--mcp-config")! + 1]
        XCTAssertTrue(mcp.contains(gate.info.token))
        XCTAssertTrue(mcp.contains(gate.info.socketPath))
        XCTAssertTrue(mcp.contains(memoryHome.path))
        XCTAssertTrue(gate.started)
        XCTAssertTrue(session.isRunning)
        XCTAssertEqual(session.phase, .planning)
        XCTAssertEqual(session.messages.first?.content, .user("쿠팡에서 우유 찾아 줘"))
        // 기억 폴더는 0700 으로 만들어 둔다.
        let perms = try FileManager.default.attributesOfItem(atPath: memoryHome.path)[.posixPermissions] as? Int
        XCTAssertEqual(perms, 0o700)
        r.finish(.finished(code: 0)); await t.value
    }

    func testSecondSendWhileRunningIsIgnored() async throws {
        let (r, _, t) = try await start("하나")
        session.input = "둘"
        XCTAssertNil(session.send())
        XCTAssertEqual(session.input, "둘")
        r.finish(.finished(code: 0)); await t.value
    }

    func testResultClosesInputAndNextInputResumesInNewProcessInPlanningAgain() async throws {
        let (r1, g1, t1) = try await start("첫 일")
        r1.emit(assistant("알겠어요"))
        try await waitUntil { self.session.messages.last?.content == .assistant("알겠어요") }
        try await approvePlan(r1)
        r1.emit(result(text: "알겠어요"))
        await t1.value                                  // 입력을 닫으면(가짜가) 끝난다
        XCTAssertGreaterThanOrEqual(r1.closeCount, 1)
        XCTAssertGreaterThanOrEqual(g1.stopCount, 1, "일이 끝나면 관문도 닫는다")
        XCTAssertFalse(session.isRunning)
        XCTAssertEqual(session.phase, .planning, "다음 입력은 다시 계획 모드")
        XCTAssertEqual(session.messages.filter { if case .assistant = $0.content { return true } else { return false } }.count, 1,
                       "result 글은 앞서 나온 답과 같으니 두 번 찍지 않는다")

        let (r2, g2, t2) = try await start("둘째 일")
        XCTAssertTrue(r2 !== r1)
        XCTAssertTrue(g2 !== g1, "일 하나마다 새 관문")
        let args = r2.call!.arguments
        XCTAssertEqual(args[args.firstIndex(of: "--resume")! + 1], "sess-1")
        XCTAssertEqual(args[args.firstIndex(of: "--permission-mode")! + 1], "plan")
        XCTAssertEqual(r2.call!.initialLines, [ClaudeControl.userMessage("둘째 일")])
        // 새 프로세스는 계획 전이라 동작을 거절한다.
        let d = await g2.request(gateRequest()).value
        XCTAssertEqual(d, .deny(ActionPolicy.planningReason))
        r2.finish(.finished(code: 0)); await t2.value
    }

    func testErroredResumedRunForgetsSessionSoNextStartsFresh() async throws {
        let (r1, _, t1) = try await start("첫 일")
        r1.emit(result()); await t1.value
        let (r2, _, t2) = try await start("둘째")
        XCTAssertTrue(r2.call!.arguments.contains("--resume"))
        r2.emit(result(isError: true, text: "세션을 찾지 못했어요", session: "sess-1")); await t2.value
        XCTAssertTrue(session.messages.contains { $0.content == .error("세션을 찾지 못했어요") })
        let (r3, _, t3) = try await start("셋째")
        XCTAssertFalse(r3.call!.arguments.contains("--resume"))
        r3.finish(.finished(code: 0)); await t3.value
    }

    func testToolUseShowsProgressLineAndTextClearsIt() async throws {
        let (r, _, t) = try await start("일")
        r.emit(toolUse("mcp__safari-attraction__click"))
        try await waitUntil { self.session.activity == "사파리 click 하는 중이에요…" }
        r.emit(assistant("눌렀어요"))
        try await waitUntil { self.session.activity == nil }
        r.finish(.finished(code: 0)); await t.value
    }

    func testRunnerFailureShowsKoreanError() async throws {
        let (r, _, t) = try await start("일")
        r.finish(.notFound("claude")); await t.value
        XCTAssertTrue(session.messages.contains { if case .error(let m) = $0.content { return m.contains("claude") } else { return false } })
        XCTAssertFalse(session.isRunning)
    }

    func testGateFactoryFailureShowsErrorAndDoesNotRun() async throws {
        struct Boom: Error, LocalizedError { var errorDescription: String? { "소켓 실패" } }
        session = makeSession(gateFactory: { throw Boom() })
        session.input = "일"
        let t = session.send()!
        await t.value
        XCTAssertTrue(runners.made.first?.call == nil)
        XCTAssertTrue(session.messages.contains { $0.content == .error("동작 관문을 열지 못했어요 — 소켓 실패") })
        XCTAssertFalse(session.isRunning)
    }

    // MARK: 계획 카드

    func testPlanCardApproveAllowsWithSetModeManualAndSwitchesPhase() async throws {
        let (r, _, t) = try await start("일")
        r.emit(canUseTool("plan1", "ExitPlanMode", ["plan": "1. 연다\n2. 담는다"]))
        try await waitUntil("계획 카드") { self.lastCard != nil }
        XCTAssertEqual(lastCard?.content, .planCard(markdown: "1. 연다\n2. 담는다", state: .pending))
        XCTAssertTrue(session.hasPendingCard)
        XCTAssertEqual(session.phase, .planning)
        XCTAssertTrue(replies(r).isEmpty, "답하기 전에는 아무것도 쓰지 않는다")
        XCTAssertTrue(session.answer(cardID: lastCard!.id, .approve))
        XCTAssertEqual(session.phase, .executing)
        XCTAssertFalse(session.hasPendingCard)
        XCTAssertEqual(lastCard?.content, .planCard(markdown: "1. 연다\n2. 담는다", state: .approved))
        try await waitUntil { self.reply(r, "plan1") != nil }
        let rep = reply(r, "plan1")!
        XCTAssertEqual(rep.behavior, "allow")
        XCTAssertTrue(rep.setMode)
        XCTAssertFalse(session.answer(cardID: lastCard!.id, .approve), "두 번 답할 수 없다")
        r.finish(.finished(code: 0)); await t.value
    }

    func testPlanCardReviseDeniesWithHumanTextAndStaysInPlanning() async throws {
        let (r, _, t) = try await start("일")
        r.emit(canUseTool("plan1", "ExitPlanMode", ["plan": "계획"]))
        try await waitUntil { self.lastCard != nil }
        let id = lastCard!.id
        XCTAssertFalse(session.answer(cardID: id, .revise("   ")), "빈 글은 고쳐 줘가 아니다")
        XCTAssertTrue(session.answer(cardID: id, .revise("쿠팡 말고 11번가로")))
        try await waitUntil { self.reply(r, "plan1") != nil }
        let rep = reply(r, "plan1")!
        XCTAssertEqual(rep.behavior, "deny")
        XCTAssertEqual(rep.message, "쿠팡 말고 11번가로")
        XCTAssertFalse(rep.setMode)
        XCTAssertEqual(session.phase, .planning)
        XCTAssertEqual(lastCard?.content, .planCard(markdown: "계획", state: .revised("쿠팡 말고 11번가로")))
        XCTAssertEqual(session.messages.last?.content, .user("쿠팡 말고 11번가로"))
        r.finish(.finished(code: 0)); await t.value
    }

    func testPlanCardRejectStopsEverything() async throws {
        let (r, g, t) = try await start("일")
        r.emit(canUseTool("plan1", "ExitPlanMode", ["plan": "계획"]))
        try await waitUntil { self.lastCard != nil }
        XCTAssertTrue(session.answer(cardID: lastCard!.id, .reject))
        await t.value
        XCTAssertEqual(lastCard?.content, .planCard(markdown: "계획", state: .rejected))
        XCTAssertGreaterThanOrEqual(r.stopCount, 1)
        XCTAssertGreaterThanOrEqual(r.closeCount, 1)
        XCTAssertGreaterThanOrEqual(g.stopCount, 1)
        XCTAssertEqual(session.messages.last?.content, .notice(AgentSession.stoppedNotice))
        XCTAssertFalse(session.isRunning)
    }

    func testPlanCardOnlyAcceptsPlanAnswers() async throws {
        let (r, _, t) = try await start("일")
        r.emit(canUseTool("plan1", "ExitPlanMode", ["plan": "계획"]))
        try await waitUntil { self.lastCard != nil }
        XCTAssertFalse(session.answer(cardID: lastCard!.id, .alwaysAllowSite))
        XCTAssertFalse(session.answer(cardID: 9999, .approve))
        XCTAssertTrue(session.hasPendingCard)
        r.finish(.finished(code: 0)); await t.value
    }

    func testPlanCardExpiresAfter300SecondsWithDeny() async throws {
        let (r, _, t) = try await start("일")
        r.emit(canUseTool("plan1", "ExitPlanMode", ["plan": "계획"]))
        try await waitUntil { self.lastCard != nil }
        try await waitUntil("시계 둘(일 · 카드)") { self.sleeper.sleepingCount == 2 }
        sleeper.advance(299)
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertTrue(session.hasPendingCard)
        sleeper.advance(1)
        try await waitUntil { self.reply(r, "plan1") != nil }
        XCTAssertEqual(reply(r, "plan1")?.behavior, "deny")
        XCTAssertEqual(reply(r, "plan1")?.message, AgentSession.cardExpiredReason)
        XCTAssertEqual(lastCard?.content, .planCard(markdown: "계획", state: .expired))
        r.finish(.finished(code: 0)); await t.value
    }

    // MARK: 빈 계획 카드(ExitPlanMode 입력에 plan 이 없을 때)

    func testPlanTextLadderFallsBackToLastAssistantText() async throws {
        let (r, _, t) = try await start("일")
        r.emit(assistant("먼저 이렇게 해요\n1. 연다\n2. 담는다"))
        r.emit(canUseTool("plan1", "ExitPlanMode", [:]))
        try await waitUntil("계획 카드") { self.lastCard != nil }
        XCTAssertEqual(lastCard?.content, .planCard(markdown: "먼저 이렇게 해요\n1. 연다\n2. 담는다", state: .pending))
        XCTAssertTrue(session.answer(cardID: lastCard!.id, .approve), "글이 있으면 승인할 수 있다")
        r.finish(.finished(code: 0)); await t.value
    }

    func testBlankPlanInputCountsAsMissingAndPlanInputWinsOverAssistantText() async throws {
        let (r, _, t) = try await start("일")
        r.emit(assistant("답 글"))
        r.emit(canUseTool("plan1", "ExitPlanMode", ["plan": "   \n "]))
        try await waitUntil("계획 카드") { self.lastCard != nil }
        XCTAssertEqual(lastCard?.content, .planCard(markdown: "답 글", state: .pending))
        r.emit(canUseTool("plan2", "ExitPlanMode", ["plan": "진짜 계획"]))
        try await waitUntil("두 번째 카드") { self.cards.count == 2 }
        XCTAssertEqual(lastCard?.content, .planCard(markdown: "진짜 계획", state: .pending))
        r.finish(.finished(code: 0)); await t.value
    }

    func testEmptyPlanIsDeniedTwiceAutomaticallyThenCardWithApproveBlocked() async throws {
        let (r, _, t) = try await start("일")
        r.emit(canUseTool("plan1", "ExitPlanMode", [:]))
        try await waitUntil { self.reply(r, "plan1") != nil }
        XCTAssertEqual(reply(r, "plan1")?.behavior, "deny")
        XCTAssertEqual(reply(r, "plan1")?.message, AgentSession.emptyPlanReason)
        XCTAssertTrue(cards.isEmpty, "자동으로 되돌릴 땐 카드를 띄우지 않는다")
        r.emit(canUseTool("plan2", "ExitPlanMode", ["plan": "  "]))
        try await waitUntil { self.reply(r, "plan2") != nil }
        XCTAssertEqual(reply(r, "plan2")?.behavior, "deny")
        XCTAssertTrue(cards.isEmpty)
        // 세 번째 — 카드는 띄우되 「이대로 진행」 은 막는다.
        r.emit(canUseTool("plan3", "ExitPlanMode", [:]))
        try await waitUntil("계획 카드") { self.lastCard != nil }
        XCTAssertEqual(lastCard?.content, .planCard(markdown: "", state: .pending))
        XCTAssertFalse(session.answer(cardID: lastCard!.id, .approve), "빈 계획은 승인할 수 없다")
        XCTAssertEqual(session.phase, .planning)
        XCTAssertTrue(session.hasPendingCard)
        XCTAssertNil(reply(r, "plan3"))
        // 고쳐 줘 · 그만은 된다.
        XCTAssertTrue(session.answer(cardID: lastCard!.id, .revise("계획을 목록으로 써 줘")))
        try await waitUntil { self.reply(r, "plan3") != nil }
        XCTAssertEqual(reply(r, "plan3")?.behavior, "deny")
        r.finish(.finished(code: 0)); await t.value
    }

    func testEmptyPlanDenialCountIsPerRun() async throws {
        let (r1, _, t1) = try await start("일")
        r1.emit(canUseTool("a", "ExitPlanMode", [:]))
        r1.emit(canUseTool("b", "ExitPlanMode", [:]))
        try await waitUntil { self.replies(r1).count == 2 }
        r1.finish(.finished(code: 0)); await t1.value
        let (r2, _, t2) = try await start("다음 일")
        r2.emit(canUseTool("c", "ExitPlanMode", [:]))
        try await waitUntil { self.reply(r2, "c") != nil }
        XCTAssertEqual(reply(r2, "c")?.behavior, "deny", "새 실행은 처음부터 센다")
        XCTAssertTrue(cards.isEmpty)
        r2.finish(.finished(code: 0)); await t2.value
    }

    func testWriteIsDeniedAfterApprovalToo() async throws {
        let (r, _, t) = try await start("일")
        try await approvePlan(r)
        r.emit(canUseTool("w1", "Write", ["file_path": "/tmp/x.md", "content": "x"]))
        try await waitUntil { self.reply(r, "w1") != nil }
        XCTAssertEqual(reply(r, "w1")?.behavior, "deny")
        XCTAssertEqual(reply(r, "w1")?.message, AgentSession.toolNotAllowedMessage)
        r.finish(.finished(code: 0)); await t.value
    }

    // MARK: 도구 물음

    func testSafariToolsAreAlwaysAllowedWithInputUnchanged() async throws {
        let (r, _, t) = try await start("일")
        r.emit(canUseTool("a", "mcp__safari-attraction__snapshot", ["x": 1]))
        try await waitUntil { self.reply(r, "a") != nil }
        XCTAssertEqual(reply(r, "a")?.behavior, "allow")
        XCTAssertFalse(reply(r, "a")!.setMode)
        XCTAssertTrue(cards.isEmpty)
        r.finish(.finished(code: 0)); await t.value
    }

    func testOtherToolsAreDenied() async throws {
        let (r, _, t) = try await start("일")
        r.emit(canUseTool("b", "Bash", ["command": "ls"]))
        r.emit(canUseTool("c", "mcp__other__thing", [:]))
        try await waitUntil { self.replies(r).count == 2 }
        XCTAssertEqual(reply(r, "b")?.behavior, "deny")
        XCTAssertEqual(reply(r, "b")?.message, AgentSession.toolNotAllowedMessage)
        XCTAssertEqual(reply(r, "c")?.behavior, "deny")
        r.finish(.finished(code: 0)); await t.value
    }

    func testReplWithoutWrapperWordsIsAllowedEvenBeforePlanApproval() async throws {
        let (r, _, t) = try await start("일")
        r.emit(canUseTool("r1", AgentSession.replToolName, ["code": "return await page.title()"]))
        try await waitUntil { self.reply(r, "r1") != nil }
        XCTAssertEqual(reply(r, "r1")?.behavior, "allow")
        XCTAssertTrue(cards.isEmpty)
        r.finish(.finished(code: 0)); await t.value
    }

    func testReplWithWrapperWordShowsCodeCardAndWaits() async throws {
        let (r, _, t) = try await start("일")
        let code = "const f = globalThis.fetch; return f('/x')"
        r.emit(canUseTool("r1", AgentSession.replToolName, ["code": code]))
        try await waitUntil { self.lastCard != nil }
        XCTAssertEqual(lastCard?.content, .codeCard(code: code, state: .pending))
        XCTAssertTrue(session.hasPendingCard)
        XCTAssertTrue(replies(r).isEmpty)
        XCTAssertFalse(session.answer(cardID: lastCard!.id, .alwaysAllowSite))
        XCTAssertTrue(session.answer(cardID: lastCard!.id, .approve))
        try await waitUntil { self.reply(r, "r1") != nil }
        XCTAssertEqual(reply(r, "r1")?.behavior, "allow")
        XCTAssertFalse(reply(r, "r1")!.setMode)
        XCTAssertEqual(lastCard?.content, .codeCard(code: code, state: .approved))
        r.finish(.finished(code: 0)); await t.value
    }

    func testReplCodeCardRejectDenies() async throws {
        let (r, _, t) = try await start("일")
        r.emit(canUseTool("r1", AgentSession.replToolName, ["code": "require('fs')"]))
        try await waitUntil { self.lastCard != nil }
        XCTAssertTrue(session.answer(cardID: lastCard!.id, .reject))
        try await waitUntil { self.reply(r, "r1") != nil }
        XCTAssertEqual(reply(r, "r1")?.behavior, "deny")
        XCTAssertEqual(lastCard?.cardState, .rejected)
        r.finish(.finished(code: 0)); await t.value
    }

    func testWrapperWordList() {
        for w in ["constructor", "process", "require", "child_process", "import(", "Function", "eval", "globalThis", "__proto__", "prototype"] {
            XCTAssertTrue(AgentSession.hasWrapperWord("a; \(w) ;b"), w)
        }
        XCTAssertFalse(AgentSession.hasWrapperWord("return document.title"))
        XCTAssertFalse(AgentSession.hasWrapperWord("await page.click('#buy')"))
    }

    func testWrapperWordsUseWordBoundaries() async throws {
        // page.evaluate 는 평범한 말 — eval 에 걸리면 안 된다.
        XCTAssertFalse(AgentSession.hasWrapperWord("page.evaluate(() => document.title)"))
        XCTAssertFalse(AgentSession.hasWrapperWord("const processed = 1; await page.evaluate(x => x)"))
        for code in ["eval('x')", "Function('x')", "this.constructor", "process.env", "require('fs')", "import('x')", "a.__proto__",
                     "globalThis.x", "Object.prototype", "child_process"] {
            XCTAssertTrue(AgentSession.hasWrapperWord(code), code)
        }
        XCTAssertFalse(AgentSession.hasWrapperWord("EVAL('x')"), "대소문자 구분")
        // 세션 수준: evaluate 만 든 코드는 카드 없이 허락, eval 은 코드 카드.
        let (r, _, t) = try await start("일")
        r.emit(canUseTool("r1", AgentSession.replToolName, ["code": "await page.evaluate(() => document.title)"]))
        try await waitUntil { self.reply(r, "r1") != nil }
        XCTAssertEqual(reply(r, "r1")?.behavior, "allow")
        XCTAssertTrue(cards.isEmpty)
        r.emit(canUseTool("r2", AgentSession.replToolName, ["code": "eval('x')"]))
        try await waitUntil { self.lastCard != nil }
        guard case .codeCard = lastCard!.content else { return XCTFail("코드 카드가 아님") }
        r.finish(.finished(code: 0)); await t.value
    }

    func testDangerActionCardRefusesAlwaysAllowSite() async throws {
        let (r, g, t) = try await start("일")
        try await approvePlan(r)
        let decision = g.request(gateRequest(action: "evaluate", target: "document.body", irreversible: nil))
        try await waitUntil { self.cards.count == 2 }
        guard case .actionCard(_, _, _, _, let danger, _) = lastCard!.content else { return XCTFail() }
        XCTAssertTrue(danger)
        XCTAssertFalse(session.answer(cardID: lastCard!.id, .alwaysAllowSite), "빨간 카드는 늘 허락을 받지 않는다")
        XCTAssertEqual(lastCard?.cardState, .pending)
        XCTAssertEqual(siteModes.mode(for: "www.example.com"), .ask)
        XCTAssertTrue(session.answer(cardID: lastCard!.id, .approve))
        let d = await decision.value
        XCTAssertEqual(d, .allow)
        XCTAssertEqual(siteModes.mode(for: "www.example.com"), .ask)
        r.finish(.finished(code: 0)); await t.value
    }

    func testIrreversibleCardAlsoRefusesAlwaysAllowSite() async throws {
        try siteModes.setMode(.allowAll, for: "www.example.com")
        let (r, g, t) = try await start("일")
        try await approvePlan(r)
        let decision = g.request(gateRequest(target: "결제하기", irreversible: true))
        try await waitUntil { self.cards.count == 2 }
        XCTAssertFalse(session.answer(cardID: lastCard!.id, .alwaysAllowSite))
        XCTAssertTrue(session.answer(cardID: lastCard!.id, .reject))
        let d = await decision.value
        XCTAssertEqual(d, .deny(AgentSession.cardRejectedReason))
        r.finish(.finished(code: 0)); await t.value
    }

    func testUnsupportedControlRequestAfterClosingGetsNoReply() async throws {
        let (r, _, t) = try await start("일")
        session.stop()
        // 멈추는 중에 도착한 모르는 요청 — 답을 쓰지 않는다(같은 메인 액터 턴 안이라 줄은 큐에 이미 들어갔다).
        r.emit(["type": "control_request", "request_id": "u9", "request": ["subtype": "mcp_message"]])
        await t.value
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertNil(reply(r, "u9"))
    }

    func testPendingCardCallbackFiresOnChangesOnly() async throws {
        var seen: [Bool] = []
        session.onPendingCardChange = { seen.append($0) }
        let (r, _, t) = try await start("일")
        r.emit(canUseTool("plan1", "ExitPlanMode", ["plan": "계획"]))
        try await waitUntil { self.lastCard != nil }
        r.emit(["type": "assistant", "session_id": "sess-1", "message": ["content": [["type": "text", "text": "글"]]]])
        try await waitUntil { self.session.messages.count >= 3 }
        XCTAssertEqual(seen, [true], "카드가 뜬 한 번만")
        XCTAssertTrue(session.answer(cardID: lastCard!.id, .approve))
        XCTAssertEqual(seen, [true, false])
        r.finish(.finished(code: 0)); await t.value
    }

    func testAllowedActionsShowAProgressLine() async throws {
        let (r, g, t) = try await start("일")
        try await approvePlan(r)
        let decision = g.request(gateRequest(host: "www.coupang.com"))
        try await waitUntil { self.cards.count == 2 }
        XCTAssertTrue(session.answer(cardID: lastCard!.id, .approve))
        _ = await decision.value
        XCTAssertEqual(session.activity, "www.coupang.com에서 '장바구니 담기' 누름")
        // 다 허락 사이트는 카드 없이 바로.
        try siteModes.setMode(.allowAll, for: "b.example.com")
        _ = await g.request(gateRequest(id: "g2", host: "b.example.com", action: "fill", target: "검색")).value
        XCTAssertEqual(session.activity, "b.example.com에서 '검색' 칸을 채움")
        r.finish(.finished(code: 0)); await t.value
        XCTAssertNil(session.activity)
    }

    func testActionLabels() {
        XCTAssertEqual(AgentActionLabel.noun("click"), "누르기")
        XCTAssertEqual(AgentActionLabel.noun("evaluate"), "페이지 코드 실행")
        XCTAssertEqual(AgentActionLabel.noun("weird"), "weird")
        XCTAssertEqual(AgentActionLabel.progress(host: "a.com", action: "goto", target: "https://a.com/x"), "a.com 이동")
        XCTAssertEqual(AgentActionLabel.progress(host: "a.com", action: "evaluate", target: "1+1"), "a.com에서 페이지 코드를 실행함")
        XCTAssertEqual(AgentActionLabel.progress(host: "a.com", action: "click", target: ""), "a.com에서 누름")
    }

    func testUnsupportedControlRequestGetsErrorReply() async throws {
        let (r, _, t) = try await start("일")
        r.emit(["type": "control_request", "request_id": "u1", "request": ["subtype": "mcp_message"]])
        try await waitUntil { self.reply(r, "u1") != nil }
        XCTAssertEqual(reply(r, "u1")?.subtype, "error")
        XCTAssertEqual(reply(r, "u1")?.error, AgentSession.unsupportedRequestMessage)
        r.finish(.finished(code: 0)); await t.value
    }

    func testControlCancelRequestWithdrawsTheCardAndSendsNothing() async throws {
        let (r, _, t) = try await start("일")
        r.emit(canUseTool("plan1", "ExitPlanMode", ["plan": "계획"]))
        try await waitUntil { self.lastCard != nil }
        let id = lastCard!.id
        r.emit(["type": "control_cancel_request", "request_id": "plan1"])
        try await waitUntil { self.lastCard?.cardState == .withdrawn }
        XCTAssertFalse(session.hasPendingCard)
        XCTAssertFalse(session.answer(cardID: id, .approve))
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertTrue(replies(r).isEmpty)
        XCTAssertEqual(session.phase, .planning)
        r.finish(.finished(code: 0)); await t.value
    }

    func testRequestAndCancelInTheSameChunkStillWithdraws() async throws {
        let (r, _, t) = try await start("일")
        var chunk = jsonLine(canUseTool("plan1", "ExitPlanMode", ["plan": "계획"]))
        chunk.append(jsonLine(["type": "control_cancel_request", "request_id": "plan1"]))
        r.emit(raw: .stdout(chunk))
        try await waitUntil { self.lastCard?.cardState == .withdrawn }
        r.finish(.finished(code: 0)); await t.value
    }

    func testLinesSplitAcrossChunksAreStillRead() async throws {
        let (r, _, t) = try await start("일")
        let line = jsonLine(canUseTool("a", "mcp__safari-attraction__snapshot"))
        r.emit(raw: .stdout(line.prefix(20)))
        r.emit(raw: .stdout(line.dropFirst(20)))
        try await waitUntil { self.reply(r, "a") != nil }
        r.finish(.finished(code: 0)); await t.value
    }

    // MARK: 동작 관문

    func testGateClickBeforePlanApprovalIsDeniedWithoutCard() async throws {
        let (r, g, t) = try await start("일")
        let d = await g.request(gateRequest()).value
        XCTAssertEqual(d, .deny(ActionPolicy.planningReason))
        XCTAssertTrue(cards.isEmpty)
        let nav = await g.request(gateRequest(action: "goto", target: "")).value
        XCTAssertEqual(nav, .allow, "이동은 계획 전에도 허락")
        r.finish(.finished(code: 0)); await t.value
    }

    func testAskSiteClickAfterApprovalShowsCardThenAllowsOnApprove() async throws {
        let (r, g, t) = try await start("일")
        try await approvePlan(r)
        let decision = g.request(gateRequest(target: "장바구니 담기", value: "(비밀)", irreversible: false))
        try await waitUntil("동작 카드") { self.cards.count == 2 }
        XCTAssertEqual(lastCard?.content, .actionCard(host: "www.example.com", action: "click", target: "장바구니 담기",
                                                       value: "(비밀)", danger: false, state: .pending))
        XCTAssertTrue(session.hasPendingCard)
        XCTAssertTrue(session.answer(cardID: lastCard!.id, .approve))
        let d = await decision.value
        XCTAssertEqual(d, .allow)
        XCTAssertEqual(lastCard?.cardState, .approved)
        XCTAssertFalse(session.hasPendingCard)
        r.finish(.finished(code: 0)); await t.value
    }

    func testActionCardRejectDeniesWithKoreanReason() async throws {
        let (r, g, t) = try await start("일")
        try await approvePlan(r)
        let decision = g.request(gateRequest())
        try await waitUntil { self.cards.count == 2 }
        XCTAssertFalse(session.answer(cardID: lastCard!.id, .revise("글")), "동작 카드엔 고쳐 줘가 없다")
        XCTAssertTrue(session.answer(cardID: lastCard!.id, .reject))
        let d = await decision.value
        XCTAssertEqual(d, .deny(AgentSession.cardRejectedReason))
        XCTAssertEqual(lastCard?.cardState, .rejected)
        r.finish(.finished(code: 0)); await t.value
    }

    func testUnknownIrreversibleOnAskSiteIsDangerCard() async throws {
        let (r, g, t) = try await start("일")
        try await approvePlan(r)
        let decision = g.request(gateRequest(action: "evaluate", irreversible: nil))
        try await waitUntil { self.cards.count == 2 }
        guard case .actionCard(_, _, _, _, let danger, _) = lastCard!.content else { return XCTFail() }
        XCTAssertTrue(danger)
        session.answer(cardID: lastCard!.id, .reject)
        _ = await decision.value
        r.finish(.finished(code: 0)); await t.value
    }

    func testAllowAllSiteClickIsAllowedImmediately() async throws {
        try siteModes.setMode(.allowAll, for: "www.example.com")
        let (r, g, t) = try await start("일")
        try await approvePlan(r)
        let d = await g.request(gateRequest()).value
        XCTAssertEqual(d, .allow)
        XCTAssertEqual(cards.count, 1, "계획 카드뿐")
        r.finish(.finished(code: 0)); await t.value
    }

    func testIrreversibleIsStillADangerCardOnAllowAllSite() async throws {
        try siteModes.setMode(.allowAll, for: "www.example.com")
        let (r, g, t) = try await start("일")
        try await approvePlan(r)
        let decision = g.request(gateRequest(target: "결제하기", irreversible: true))
        try await waitUntil { self.cards.count == 2 }
        guard case .actionCard(_, _, let target, _, let danger, _) = lastCard!.content else { return XCTFail() }
        XCTAssertEqual(target, "결제하기")
        XCTAssertTrue(danger)
        session.answer(cardID: lastCard!.id, .approve)
        let d = await decision.value
        XCTAssertEqual(d, .allow)
        r.finish(.finished(code: 0)); await t.value
    }

    func testReadOnlySiteIsDeniedAfterApproval() async throws {
        try siteModes.setMode(.readOnly, for: "www.example.com")
        let (r, g, t) = try await start("일")
        try await approvePlan(r)
        let d = await g.request(gateRequest()).value
        XCTAssertEqual(d, .deny(ActionPolicy.readOnlyReason))
        XCTAssertEqual(cards.count, 1)
        r.finish(.finished(code: 0)); await t.value
    }

    func testAlwaysAllowSiteSavesModeAndAllows() async throws {
        let (r, g, t) = try await start("일")
        try await approvePlan(r)
        let decision = g.request(gateRequest(host: "Shop.Example.com"))
        try await waitUntil { self.cards.count == 2 }
        XCTAssertTrue(session.answer(cardID: lastCard!.id, .alwaysAllowSite))
        let d = await decision.value
        XCTAssertEqual(d, .allow)
        XCTAssertEqual(lastCard?.cardState, .alwaysAllowed)
        XCTAssertEqual(siteModes.mode(for: "shop.example.com"), .allowAll)
        // 저장됐으니 다음 click 은 바로 허락.
        let again = await g.request(gateRequest(id: "g2", host: "shop.example.com")).value
        XCTAssertEqual(again, .allow)
        XCTAssertEqual(cards.count, 2)
        r.finish(.finished(code: 0)); await t.value
    }

    func testActionCardExpiresAfter300Seconds() async throws {
        let (r, g, t) = try await start("일")
        try await approvePlan(r)
        try await waitUntil("일 시계") { self.sleeper.sleepingCount == 1 }
        sleeper.advance(250)                         // 계획 카드를 띄운 뒤 흐른 시간 — 동작 카드의 300초와 상관없다
        let decision = g.request(gateRequest())
        try await waitUntil { self.cards.count == 2 }
        try await waitUntil("시계 둘(일 · 카드)") { self.sleeper.sleepingCount == 2 }
        XCTAssertEqual(sleeper.requested.filter { $0 == AgentSession.cardTimeout }.count, 2)
        XCTAssertEqual(AgentSession.cardTimeout, 300)
        sleeper.advance(299)
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertTrue(session.hasPendingCard)
        sleeper.advance(1)
        let d = await decision.value
        XCTAssertEqual(d, .deny("시간이 지나 거절했어요"))
        XCTAssertEqual(lastCard?.cardState, .expired)
        XCTAssertFalse(session.hasPendingCard)
        XCTAssertFalse(session.answer(cardID: lastCard!.id, .approve), "시간이 지난 카드에는 답할 수 없다")
        r.finish(.finished(code: 0)); await t.value
    }

    func testClientDisconnectCancelsTheRequestAndWithdrawsTheCard() async throws {
        let (r, g, t) = try await start("일")
        try await approvePlan(r)
        let decision = g.request(gateRequest())
        try await waitUntil { self.cards.count == 2 }
        decision.cancel()
        try await waitUntil { self.lastCard?.cardState == .withdrawn }
        XCTAssertFalse(session.hasPendingCard)
        r.finish(.finished(code: 0)); await t.value
    }

    // MARK: 멈춤 · 시간

    func testStopDeniesAllWaitingCardsClosesInputStopsProcessAndGate() async throws {
        let (r, g, t) = try await start("일")
        try await approvePlan(r)
        let d1 = g.request(gateRequest(id: "g1"))
        let d2 = g.request(gateRequest(id: "g2", target: "다른 버튼"))
        try await waitUntil { self.cards.count == 3 }
        r.emit(canUseTool("r1", AgentSession.replToolName, ["code": "eval('1')"]))
        try await waitUntil { self.cards.count == 4 }
        session.stop()
        XCTAssertTrue(session.isStopping)
        let a = await d1.value, b = await d2.value
        XCTAssertEqual(a, .deny(GateServer.stoppedReason))
        XCTAssertEqual(b, .deny(GateServer.stoppedReason))
        XCTAssertEqual(cards.suffix(3).map { $0.cardState }, [.stopped, .stopped, .stopped])
        XCTAssertFalse(session.hasPendingCard)
        await t.value
        XCTAssertGreaterThanOrEqual(r.stopCount, 1)
        XCTAssertGreaterThanOrEqual(r.closeCount, 1)
        XCTAssertGreaterThanOrEqual(g.stopCount, 1)
        XCTAssertFalse(session.isRunning)
        XCTAssertFalse(session.isStopping)
        XCTAssertEqual(session.messages.last?.content, .notice("멈췄어요"))
        XCTAssertNil(reply(r, "r1"), "멈춘 뒤에는 클로드에게 답을 쓰지 않는다")
        // 멈춘 뒤 새 일을 시작할 수 있다.
        let (r2, _, t2) = try await start("다시")
        r2.finish(.finished(code: 0)); await t2.value
    }

    func testStopBeforeProcessStartsDoesNotLaunch() async throws {
        session.input = "일"
        let t = session.send()!
        session.stop()
        await t.value
        XCTAssertFalse(session.isRunning)
        XCTAssertTrue(runners.made.first?.call == nil || runners.made.first!.stopCount >= 1)
        XCTAssertEqual(session.messages.last?.content, .notice("멈췄어요"))
    }

    func testStopWhenIdleDoesNothing() {
        session.stop()
        XCTAssertFalse(session.isStopping)
        XCTAssertTrue(session.messages.isEmpty)
    }

    func testJobTimeoutAfter900SecondsStopsLikeStopWithNotice() async throws {
        let (r, g, t) = try await start("일")
        try await approvePlan(r)
        XCTAssertTrue(sleeper.requested.contains(900))
        XCTAssertEqual(AgentSession.jobTimeout, 900)
        try await waitUntil("일 시계") { self.sleeper.sleepingCount == 1 }
        sleeper.advance(850)                         // 카드가 없는 동안 시간이 흐른다 — 그 뒤 뜬 카드의 300초는 아직 멀다
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertTrue(session.isRunning)
        let decision = g.request(gateRequest())
        try await waitUntil { self.cards.count == 2 }
        try await waitUntil("시계 둘(일 · 카드)") { self.sleeper.sleepingCount == 2 }
        sleeper.advance(49)
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertTrue(session.isRunning)
        XCTAssertEqual(r.stopCount, 0)
        sleeper.advance(1)
        await t.value
        let d = await decision.value
        XCTAssertEqual(d, .deny(GateServer.stoppedReason))
        XCTAssertGreaterThanOrEqual(r.stopCount, 1)
        XCTAssertGreaterThanOrEqual(g.stopCount, 1)
        XCTAssertEqual(lastCard?.cardState, .stopped)
        XCTAssertEqual(session.messages.last?.content, .notice(AgentSession.jobTimeoutNotice))
        XCTAssertFalse(session.isRunning)
    }

    func testNewTaskClearsMessagesAndForgetsSession() async throws {
        let (r1, _, t1) = try await start("첫 일")
        r1.emit(result()); await t1.value
        session.newTask()
        XCTAssertTrue(session.messages.isEmpty)
        let (r2, _, t2) = try await start("새 일")
        XCTAssertFalse(r2.call!.arguments.contains("--resume"))
        r2.finish(.finished(code: 0)); await t2.value
    }

    // MARK: 진짜 관문 서버와 함께

    private final class ClientBox: @unchecked Sendable {
        let client: TestClient
        init(_ c: TestClient) { client = c }
    }

    /// 시작한 일의 명령줄(MCP 설정)에서 관문 자리와 토큰을 꺼낸다.
    private func gateEnv(_ r: FakeInteractiveRunner) -> (socket: String, token: String) {
        let args = r.call!.arguments
        let json = try! JSONSerialization.jsonObject(with: Data(args[args.firstIndex(of: "--mcp-config")! + 1].utf8)) as! [String: Any]
        let env = ((json["mcpServers"] as! [String: Any])["safari-attraction"] as! [String: Any])["env"] as! [String: String]
        return (env["SAFARI_ATTRACTION_GATE"]!, env["SAFARI_ATTRACTION_GATE_TOKEN"]!)
    }

    private func sendClick(_ env: (socket: String, token: String), id: String = "x1") async -> ClientBox {
        await Task.detached {
            let c = TestClient(path: env.socket)!
            c.sendObject(["v": 1, "token": env.token, "id": id, "host": "www.example.com", "url": "https://www.example.com/",
                          "action": "click", "target": "담기", "value": "", "irreversible": false])
            return ClientBox(c)
        }.value
    }

    func testRealGateServerRoundTripThroughACard() async throws {
        let dir = tmp!
        session = makeSession(gateFactory: { try GateServer(directory: dir) })
        let (r, _, t) = try await startReal("일")
        try await approvePlan(r)
        let box = await sendClick(gateEnv(r))
        try await waitUntil("동작 카드") { self.cards.count == 2 }
        XCTAssertTrue(session.answer(cardID: lastCard!.id, .approve))
        let line = await Task.detached { box.client.readLine() }.value
        XCTAssertEqual(line.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? NSDictionary }?["allow"] as? Bool, true)
        r.finish(.finished(code: 0)); await t.value
    }

    func testRealGateClientDisconnectWithdrawsCard() async throws {
        let dir = tmp!
        session = makeSession(gateFactory: { try GateServer(directory: dir) })
        let (r, _, t) = try await startReal("일")
        try await approvePlan(r)
        let box = await sendClick(gateEnv(r))
        try await waitUntil("동작 카드") { self.cards.count == 2 }
        await Task.detached { _ = close(box.client.fd) }.value   // 손님이 답 전에 끊는다
        try await waitUntil("카드 거둠") { self.lastCard?.cardState == .withdrawn }
        XCTAssertFalse(session.hasPendingCard)
        r.finish(.finished(code: 0)); await t.value
    }

    func testRealGateStopAnswersWaitingClientWithStoppedReason() async throws {
        let dir = tmp!
        session = makeSession(gateFactory: { try GateServer(directory: dir) })
        let (r, _, t) = try await startReal("일")
        try await approvePlan(r)
        let box = await sendClick(gateEnv(r))
        try await waitUntil("동작 카드") { self.cards.count == 2 }
        session.stop()
        let line = await Task.detached { box.client.readLine() }.value
        let obj = line.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? NSDictionary }
        XCTAssertEqual(obj?["allow"] as? Bool, false)
        XCTAssertEqual(obj?["reason"] as? String, "멈췄어요")
        await t.value
    }

    /// `start` 와 같지만 진짜 관문을 쓰는 세션용(가짜 관문 목록을 쓰지 않는다).
    private func startReal(_ text: String) async throws -> (runner: FakeInteractiveRunner, gate: Void, task: Task<Void, Never>) {
        session.input = text
        guard let t = session.send() else { XCTFail("send 가 nil"); fatalError() }
        try await waitUntil("프로세스") { self.runners.made.first?.call != nil }
        return (runners.made[0], (), t)
    }

    // MARK: 사람 없는 실행(루틴)

    /// 루틴 하나를 시작하고 프로세스가 뜰 때까지 기다린다.
    @discardableResult
    func startRoutine(_ text: String = "쿠팡 우유 가격 알려 줘", sites: [String] = ["coupang.com"],
                      index: Int? = nil) async throws -> (runner: FakeInteractiveRunner, gate: FakeGate, task: Task<RoutineOutcome, Never>) {
        let i = index ?? runners.made.count
        let s = session!
        let t = Task { @MainActor in await s.runUnattended(text: text, sites: sites) }
        try await waitUntil("루틴 프로세스 \(i)") { self.runners.made.count > i && self.runners.made[i].call != nil && self.gates.count > i }
        return (runners.made[i], gates[i], t)
    }

    func testRoutineCommandIsUnattendedAndPrefixIsExactlyTheDesign() async throws {
        let (r, gate, t) = try await startRoutine("우유 가격 알려 줘", sites: ["coupang.com", "naver.com"])
        let call = r.call!
        let a = call.arguments
        XCTAssertEqual(a[a.firstIndex(of: "--tools")! + 1], "")
        XCTAssertEqual(a[a.firstIndex(of: "--permission-mode")! + 1], "manual")
        XCTAssertTrue(a.contains("--permission-prompt-tool"))
        XCTAssertFalse(a.contains("--resume"))
        let mcp = a[a.firstIndex(of: "--mcp-config")! + 1]
        XCTAssertTrue(mcp.contains("SAFARI_ATTRACTION_UNATTENDED"))
        XCTAssertTrue(mcp.contains(gate.info.token))
        XCTAssertTrue(mcp.contains(memoryHome.path))
        XCTAssertEqual(call.initialLines, [ClaudeControl.userMessage(
            "사람 없이 도는 루틴이에요. 읽기만 할 수 있고 누르기 · 입력은 거절돼요. 갈 수 있는 사이트: coupang.com, naver.com. 되묻지 말고 읽은 것을 정리해 답하세요.\n\n우유 가격 알려 줘")])
        XCTAssertEqual(call.timeout, 660, "프로세스 상한은 600초 + 여유 60초")
        XCTAssertTrue(sleeper.requested.contains(600))
        XCTAssertEqual(RoutinePolicy.timeout, 600)
        XCTAssertTrue(gate.started)
        XCTAssertTrue(session.isRunning)
        XCTAssertTrue(session.isRoutineRunning)
        XCTAssertTrue(session.messages.isEmpty, "루틴은 일 맡기기 대화에 아무것도 남기지 않는다")
        r.emit(result(text: "끝"))
        _ = await t.value
        XCTAssertFalse(session.isRunning)
        XCTAssertFalse(session.isRoutineRunning)
        XCTAssertGreaterThanOrEqual(gate.stopCount, 1)
    }

    func testRoutineGateAllowsReadsOnListedSitesAndDeniesTheRest() async throws {
        let (r, g, t) = try await startRoutine(sites: ["coupang.com"])
        let d1 = await g.request(gateRequest(host: "www.coupang.com", action: "goto", irreversible: false)).value
        XCTAssertEqual(d1, .allow)
        let d2 = await g.request(gateRequest(host: "www.coupang.com", action: "open", irreversible: false)).value
        XCTAssertEqual(d2, .allow)
        let d3 = await g.request(gateRequest(host: "www.coupang.com", action: "nav", irreversible: false)).value
        XCTAssertEqual(d3, .allow)
        let d4 = await g.request(gateRequest(host: "www.coupang.com", action: "fetch", target: "GET https://www.coupang.com/x", irreversible: false)).value
        XCTAssertEqual(d4, .allow)
        let d5 = await g.request(gateRequest(host: "evil.com", action: "goto", irreversible: false)).value
        XCTAssertEqual(d5, .deny(RoutinePolicy.notAllowedSiteReason))
        let d6 = await g.request(gateRequest(host: "www.coupang.com", action: "click", irreversible: false)).value
        XCTAssertEqual(d6, .deny(RoutinePolicy.readOnlyReason))
        let d7 = await g.request(gateRequest(host: "www.coupang.com", action: "fetch", target: "POST https://www.coupang.com/x", irreversible: true)).value
        XCTAssertEqual(d7, .deny(RoutinePolicy.readOnlyReason))
        let d8 = await g.request(gateRequest(host: "", action: "goto", irreversible: false)).value
        XCTAssertEqual(d8, .deny(RoutinePolicy.notAllowedSiteReason))
        XCTAssertTrue(cards.isEmpty, "루틴은 카드를 만들지 않는다")
        XCTAssertFalse(session.hasPendingCard)
        XCTAssertTrue(session.messages.isEmpty)
        r.finish(.finished(code: 0)); _ = await t.value
    }

    func testRoutineIgnoresSiteModesAndNeverAsksAHuman() async throws {
        try siteModes.setMode(.allowAll, for: "www.coupang.com")
        let (r, g, t) = try await startRoutine(sites: ["coupang.com"])
        let d = await g.request(gateRequest(host: "www.coupang.com", action: "click", irreversible: false)).value
        XCTAssertEqual(d, .deny(RoutinePolicy.readOnlyReason), "사이트가 다 허락이어도 루틴은 읽기만")
        XCTAssertTrue(cards.isEmpty)
        r.finish(.finished(code: 0)); _ = await t.value
    }

    func testRoutineExitPlanModeIsDeniedWithoutCardAndRunContinues() async throws {
        let (r, _, t) = try await startRoutine()
        r.emit(canUseTool("plan1", "ExitPlanMode", ["plan": "1. 간다"]))
        try await waitUntil("거절 답") { self.reply(r, "plan1") != nil }
        XCTAssertEqual(reply(r, "plan1")?.behavior, "deny")
        XCTAssertTrue(cards.isEmpty)
        XCTAssertFalse(reply(r, "plan1")?.setMode ?? true)
        XCTAssertTrue(session.isRunning)
        r.emit(result(text: "끝")); _ = await t.value
    }

    func testRoutineReplWrapperWordIsDeniedWithoutCardAndPlainReplAllowed() async throws {
        let (r, _, t) = try await startRoutine()
        r.emit(canUseTool("r1", AgentSession.replToolName, ["code": "return process.env"]))
        r.emit(canUseTool("r2", AgentSession.replToolName, ["code": "return await page.title()"]))
        r.emit(canUseTool("r3", "mcp__safari-attraction__status", [:]))
        r.emit(canUseTool("r4", "Bash", ["command": "ls"]))
        r.emit(canUseTool("r5", AgentSession.replToolName, ["code": "page.evaluate(() => 1)"]))
        try await waitUntil("답 다섯") { self.replies(r).count == 5 }
        XCTAssertEqual(reply(r, "r1")?.behavior, "deny")
        XCTAssertEqual(reply(r, "r2")?.behavior, "allow")
        XCTAssertEqual(reply(r, "r3")?.behavior, "allow")
        XCTAssertEqual(reply(r, "r4")?.behavior, "deny")
        XCTAssertEqual(reply(r, "r4")?.message, AgentSession.toolNotAllowedMessage)
        XCTAssertEqual(reply(r, "r5")?.behavior, "allow", "낱말 경계 — page.evaluate 는 eval 에 걸리지 않는다")
        XCTAssertTrue(cards.isEmpty)
        XCTAssertFalse(session.hasPendingCard)
        r.emit(result(text: "끝")); let o = await t.value
        XCTAssertEqual(o.status, RoutineRecord.statusPartial, "덧막이 repl 거절도 거절 한 번")
    }

    func testRoutineCleanRunIsDoneWithTheAnswer() async throws {
        let (r, g, t) = try await startRoutine()
        let d = await g.request(gateRequest(host: "www.coupang.com", action: "goto", irreversible: false)).value
        XCTAssertEqual(d, .allow)
        r.emit(toolUse("mcp__safari-attraction__repl"))
        r.emit(assistant("우유는 2,980원이에요"))
        r.emit(assistant("재고도 있어요"))
        r.emit(result(text: "우유는 2,980원이에요\n\n재고도 있어요"))
        let o = await t.value
        XCTAssertEqual(o, RoutineOutcome(status: RoutineRecord.statusDone, answer: "우유는 2,980원이에요\n\n재고도 있어요"))
        XCTAssertGreaterThanOrEqual(r.closeCount, 1)
    }

    func testRoutineWithoutAssistantTextUsesTheResultText() async throws {
        let (r, _, t) = try await startRoutine()
        r.emit(result(text: "정리한 글"))
        let o = await t.value
        XCTAssertEqual(o, RoutineOutcome(status: RoutineRecord.statusDone, answer: "정리한 글"))
    }

    func testRoutineWithAGateDenialIsPartialButKeepsTheAnswer() async throws {
        let (r, g, t) = try await startRoutine()
        let d = await g.request(gateRequest(host: "www.coupang.com", action: "click")).value
        XCTAssertFalse(d.allow)
        r.emit(assistant("가격만 읽었어요"))
        r.emit(result(text: "가격만 읽었어요"))
        let o = await t.value
        XCTAssertEqual(o, RoutineOutcome(status: RoutineRecord.statusPartial, answer: "가격만 읽었어요"))
    }

    func testRoutineAfterAPartialRunNextRoutineIsNormal() async throws {
        let (r1, g1, t1) = try await startRoutine(index: 0)
        _ = await g1.request(gateRequest(host: "evil.com", action: "goto", irreversible: false)).value
        r1.emit(result(text: "일부")); let o1 = await t1.value
        XCTAssertEqual(o1.status, RoutineRecord.statusPartial)
        let (r2, g2, t2) = try await startRoutine(index: 1)
        XCTAssertTrue(g2 !== g1, "루틴 하나마다 새 관문")
        let d = await g2.request(gateRequest(host: "www.coupang.com", action: "goto", irreversible: false)).value
        XCTAssertEqual(d, .allow)
        r2.emit(result(text: "정상")); let o2 = await t2.value
        XCTAssertEqual(o2, RoutineOutcome(status: RoutineRecord.statusDone, answer: "정상"))
    }

    func testRoutineTimesOutAt600SecondsAndFails() async throws {
        let (r, g, t) = try await startRoutine()
        try await waitUntil("루틴 시계") { self.sleeper.sleepingCount == 1 }
        sleeper.advance(599)
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertTrue(session.isRunning)
        XCTAssertEqual(r.stopCount, 0)
        r.emit(assistant("읽는 중"))
        sleeper.advance(1)
        let o = await t.value
        XCTAssertEqual(o.status, RoutineRecord.statusFailed)
        XCTAssertTrue(o.answer.contains("10분"), o.answer)
        XCTAssertGreaterThanOrEqual(r.stopCount, 1)
        XCTAssertGreaterThanOrEqual(g.stopCount, 1)
        XCTAssertFalse(session.isRunning)
        XCTAssertFalse(session.isRoutineRunning)
        XCTAssertTrue(session.messages.isEmpty)
    }

    func testRoutineErrorResultFails() async throws {
        let (r, _, t) = try await startRoutine()
        r.emit(result(isError: true, text: "로그인이 필요해요"))
        let o = await t.value
        XCTAssertEqual(o.status, RoutineRecord.statusFailed)
        XCTAssertTrue(o.answer.contains("로그인이 필요해요"), o.answer)
    }

    func testRoutineRunnerFailureFails() async throws {
        let (r, _, t) = try await startRoutine()
        r.finish(.notFound("claude"))
        let o = await t.value
        XCTAssertEqual(o.status, RoutineRecord.statusFailed)
        XCTAssertTrue(o.answer.contains("claude"), o.answer)
    }

    func testRoutineGateFactoryFailureFailsWithoutRunning() async throws {
        struct Boom: Error, LocalizedError { var errorDescription: String? { "소켓 실패" } }
        session = makeSession(gateFactory: { throw Boom() })
        let o = await session.runUnattended(text: "일", sites: ["coupang.com"])
        XCTAssertEqual(o.status, RoutineRecord.statusFailed)
        XCTAssertTrue(o.answer.contains("소켓 실패"), o.answer)
        XCTAssertTrue(runners.made.first?.call == nil)
        XCTAssertFalse(session.isRunning)
        XCTAssertFalse(session.isRoutineRunning)
    }

    func testStopDuringARoutineFailsWithStoppedAnswer() async throws {
        let (r, g, t) = try await startRoutine()
        session.stop()
        let o = await t.value
        XCTAssertEqual(o.status, RoutineRecord.statusFailed)
        XCTAssertTrue(o.answer.contains(AgentSession.stoppedNotice), o.answer)
        XCTAssertGreaterThanOrEqual(r.stopCount, 1)
        XCTAssertGreaterThanOrEqual(g.stopCount, 1)
    }

    func testRoutineGateRequestAfterStopIsDeniedAndNotCounted() async throws {
        let (r, g, t) = try await startRoutine()
        session.stop()
        let d = await g.request(gateRequest(host: "www.coupang.com", action: "click")).value
        XCTAssertEqual(d, .deny(GateServer.stoppedReason))
        let o = await t.value
        XCTAssertEqual(o.status, RoutineRecord.statusFailed)
        _ = r
    }

    func testRoutineDoesNotStartWhileAttendedRunIsActive() async throws {
        let (r, _, t) = try await start("사람 일")
        let o = await session.runUnattended(text: "루틴", sites: ["coupang.com"])
        XCTAssertTrue(o.status.hasPrefix("건너뜀"), o.status)
        XCTAssertEqual(runners.made.count, 1, "겹쳐 돌지 않는다")
        XCTAssertTrue(session.isRunning)
        r.finish(.finished(code: 0)); await t.value
    }

    func testAttendedSendIsIgnoredWhileARoutineRuns() async throws {
        let (r, _, t) = try await startRoutine()
        session.input = "사람 일"
        XCTAssertNil(session.send())
        XCTAssertEqual(session.input, "사람 일")
        r.emit(result(text: "끝")); _ = await t.value
        XCTAssertNotNil(session.send(), "루틴이 끝나면 사람 일을 받는다")
        try await waitUntil { self.runners.made.count > 1 && self.runners.made[1].call != nil }
        runners.made[1].finish(.finished(code: 0))
    }

    func testRoutineLeavesTheAttendedConversationAndSessionIDAlone() async throws {
        let (r1, _, t1) = try await start("사람 일")
        r1.emit(assistant("알겠어요")); r1.emit(result(text: "알겠어요")); await t1.value
        let before = session.messages
        let (r2, _, t2) = try await startRoutine(index: 1)
        r2.emit(assistant("루틴 답", session: "routine-sess")); r2.emit(result(text: "루틴 답", session: "routine-sess"))
        _ = await t2.value
        XCTAssertEqual(session.messages, before)
        let (r3, _, t3) = try await start("다음 사람 일", index: 2)
        let a = r3.call!.arguments
        XCTAssertEqual(a[a.firstIndex(of: "--resume")! + 1], "sess-1", "루틴의 세션이 아니라 사람 일의 세션을 이어 간다")
        XCTAssertEqual(a[a.firstIndex(of: "--permission-mode")! + 1], "plan")
        r3.finish(.finished(code: 0)); await t3.value
    }

    func testRoutineNeverFiresPendingCardCallbackAndNewTaskDoesNotStopIt() async throws {
        var fired = 0
        session.onPendingCardChange = { _ in fired += 1 }
        let (r, _, t) = try await startRoutine()
        session.newTask()
        XCTAssertTrue(session.isRunning, "새 일(대화 비우기)이 돌고 있는 루틴을 멈추지 않는다")
        XCTAssertEqual(r.stopCount, 0)
        r.emit(assistant("답")); r.emit(result(text: "답"))
        let o = await t.value
        XCTAssertEqual(o, RoutineOutcome(status: RoutineRecord.statusDone, answer: "답"))
        XCTAssertEqual(fired, 0)
    }

    func testRoutineErrorTakesPriorityOverPartial() async throws {
        let (r, g, t) = try await startRoutine()
        _ = await g.request(gateRequest(host: "evil.com", action: "goto", irreversible: false)).value
        r.emit(result(isError: true, text: "오류"))
        let o = await t.value
        XCTAssertEqual(o.status, RoutineRecord.statusFailed)
    }
}
