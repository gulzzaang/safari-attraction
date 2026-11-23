import Foundation
import Observation

/// 동작 관문 서버 — 실제로는 `GateServer`, 시험에서는 가짜.
public protocol GateServing: AnyObject, Sendable {
    var info: GateInfo { get }
    func start(onRequest: @escaping @Sendable (GateRequest) async -> GateDecision)
    func stop()
}

extension GateServer: GateServing {}

/// 「일 맡기기」 — 옆 창에서 클로드에게 사파리 일을 맡기는 한 대화(두뇌).
///
/// - 입력 하나 = 클로드 프로세스 하나 + 관문 서버 하나. 사람 글은 표준 입력의 user 줄로 가고(`initialLines`),
///   `result` 가 오면 입력을 닫아 끝낸다. 세션 ID 를 기억해 다음 입력은 `--resume` 을 붙인 새 프로세스(다시 계획 모드).
/// - 클로드는 계획 모드로 시작한다. `ExitPlanMode` 는 작업 목록 카드로 사람이 승인해야 하고(승인 = 허락 + 계획 모드 해제,
///   `phase` 가 `executing` 으로), 그 전에는 관문이 이동 말고 모든 동작을 거절한다.
/// - `mcp__safari-attraction__*` 도구는 늘 허락(`repl` 은 덧막이 낱말이 든 코드만 빨간 코드 카드), 그 밖 도구는 거절.
/// - 관문 요청은 `ActionPolicy` 로 판정 — 허락 · 거절은 바로, 카드면 동작 카드를 띄우고 답을 기다린다(300초 넘으면 거절).
/// - 멈춤: 기다리는 카드 모두 거절 · 입력 닫기 · 프로세스 멈춤 · 관문 닫기. 일 하나가 900초를 넘으면 멈춤과 같게 + 안내.
///
/// 모든 상태 변경은 메인 액터. 막힐 수 있는 일(로그인 PATH · 폴더 만들기 · 클로드 입력 쓰기)은 메인 밖에서 돈다.
/// `ChatViewModel`(묻기)과는 따로다 — 화면이 모드에 따라 둘 중 하나를 보여 준다.
@MainActor @Observable
public final class AgentSession {
    public static let cardTimeout: TimeInterval = 300
    public static let jobTimeout: TimeInterval = 900
    public static let stoppedNotice = "멈췄어요"
    public static let jobTimeoutNotice = "15분이 지나 일을 멈췄어요 — 다시 시도해 주세요"
    public static let cardExpiredReason = "시간이 지나 거절했어요"
    public static let cardRejectedReason = "카드에서 거절했어요"
    public static let toolNotAllowedMessage = "이 도구는 쓸 수 없어요"
    public static let unsupportedRequestMessage = "지원하지 않는 요청이에요"
    public static let replToolName = "mcp__\(AgentCommandBuilder.mcpServerName)__repl"
    static let mcpToolPrefix = "mcp__\(AgentCommandBuilder.mcpServerName)__"
    /// 이 낱말이 든 `repl` 코드는 빨간 코드 카드로 묻는다(계획 8 Global Constraints — 관문은 실수 · 보통의 속임을 막는 장치).
    static let codeWrapperPattern = "constructor|process|require|child_process|import\\(|Function|eval|globalThis|__proto__|prototype"

    // 화면이 읽고 쓰는 것
    public var input = ""
    public private(set) var messages: [AgentMessage] = []
    public private(set) var isRunning = false
    /// 멈추라고 했지만 프로세스가 아직 안 끝났다 — 화면은 「멈추는 중…」, 새 입력은 받지 않는다.
    public private(set) var isStopping = false
    /// 진행 한 줄(예: 사파리 click 하는 중이에요…).
    public private(set) var activity: String?
    /// 계획 승인 전(planning) · 승인 뒤(executing).
    public private(set) var phase: AgentPhase = .planning

    /// 사람의 답을 기다리는 카드가 있다 — 화면 · 메뉴 막대 「기다림」.
    public var hasPendingCard: Bool { messages.contains { $0.isPendingCard } }

    @ObservationIgnored private let runnerFactory: @Sendable () -> InteractiveRunning
    @ObservationIgnored private let gateFactory: @MainActor () throws -> GateServing
    @ObservationIgnored private let siteModes: SiteModeStore
    @ObservationIgnored private let resources: URL
    @ObservationIgnored private let memoryHome: URL
    @ObservationIgnored private let loginPath: @Sendable () -> String
    @ObservationIgnored private let workDirectory: @Sendable () throws -> URL
    @ObservationIgnored private let sleep: @Sendable (TimeInterval) async throws -> Void

    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var nextID = 0
    @ObservationIgnored private var nextRunID = 0
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var sessionID: String?
    @ObservationIgnored private var run: Run?
    @ObservationIgnored private var waiters: [Int: CardWaiter] = [:]
    @ObservationIgnored private var cardTimers: [Int: Task<Void, Never>] = [:]

    /// - Parameters:
    ///   - resources: 앱의 Resources 폴더(안에 `safari-attraction/run.sh`) — Task 6 이 `Bundle.main.resourceURL` 을 넣는다.
    ///   - memoryHome: MCP 서버의 기억 폴더(`~/Library/Application Support/SafariAttractionApp/memory`) — 없으면 0700 으로 만든다.
    ///   - gateFactory: 일 하나마다 새 관문 서버를 만든다(실제로는 `{ try GateServer(directory: AppPaths.supportDirectory()) }`).
    ///   - sleep: 300초 · 900초 시계(시험은 가짜로).
    public init(resources: URL, memoryHome: URL, siteModes: SiteModeStore,
                gateFactory: @escaping @MainActor () throws -> GateServing,
                runnerFactory: @escaping @Sendable () -> InteractiveRunning = { ProcessRunner() },
                loginPath: @escaping @Sendable () -> String,
                workDirectory: @escaping @Sendable () throws -> URL = { try AppPaths.workDirectory() },
                sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }) {
        self.resources = resources; self.memoryHome = memoryHome; self.siteModes = siteModes
        self.gateFactory = gateFactory; self.runnerFactory = runnerFactory
        self.loginPath = loginPath; self.workDirectory = workDirectory; self.sleep = sleep
    }

    // MARK: 화면이 부르는 것

    /// 입력 칸의 글로 일을 시작한다. 보낼 것이 없거나 아직 일하는 중이면 nil. 돌려주는 Task 는 그 일(프로세스)이 끝나면 끝난다.
    @discardableResult
    public func send() -> Task<Void, Never>? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isRunning else { return nil }
        input = ""
        append(.user(text))
        let run = Run(id: newRunID(), generation: generation, runner: runnerFactory(), resumed: sessionID != nil)
        self.run = run
        isRunning = true
        isStopping = false
        phase = .planning
        activity = "작업 목록을 만드는 중이에요…"
        let t = Task { [self] in await perform(run, text: text) }
        task = t
        return t
    }

    /// 카드에 답한다. 이미 답했거나(시간 초과 · 멈춤 포함) 없는 카드이거나 그 카드에 맞지 않는 답이면 false(아무 일도 없다).
    /// 계획 카드: approve · reject(그만 = 멈춤) · revise(고쳐 줘). 동작 카드: approve · reject · alwaysAllowSite. 코드 카드: approve · reject.
    @discardableResult
    public func answer(cardID: Int, _ answer: AgentAnswer) -> Bool {
        guard let index = messages.firstIndex(where: { $0.id == cardID }), messages[index].isPendingCard,
              let waiter = waiters[cardID] else { return false }
        let isPlan: Bool
        switch messages[index].content {
        case .planCard: isPlan = true
        case .actionCard: isPlan = false
        case .codeCard: isPlan = false
        default: return false
        }
        var revisedText: String?
        switch answer {
        case .approve, .reject: break
        case .revise(let text):
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard isPlan, !t.isEmpty else { return false }
            revisedText = t
        case .alwaysAllowSite:
            guard case .actionCard = messages[index].content else { return false }
        }
        let resolved = revisedText.map { AgentAnswer.revise($0) } ?? answer
        guard waiter.resolve(.answer(resolved)) else { return false }
        closeCard(cardID, fallback: .answer(resolved))
        if isPlan, answer == .approve { phase = .executing }
        if let revisedText { append(.user(revisedText)) }
        if isPlan, answer == .reject { stop() }
        return true
    }

    /// 일하는 중이면 멈춘다 — 기다리는 카드 모두 거절 · 입력 닫기 · 프로세스 멈춤 · 관문 닫기.
    public func stop() {
        guard isRunning, let run else { return }
        beginClosing(run, reason: .user)
    }

    /// 앱을 끝낼 때.
    public func shutdown() {
        if let run { beginClosing(run, reason: .user) }
        task?.cancel()
    }

    /// 대화를 비우고 처음부터(세션 ID 도 잊는다). 일하는 중이었으면 멈춘다.
    public func newTask() {
        stop()
        generation += 1
        messages = []
        sessionID = nil
        activity = nil
    }

    // MARK: 한 번의 일(입력 하나)

    private enum StopReason { case none, user, timeout }

    private final class Run {
        let id: Int
        let generation: Int
        let runner: InteractiveRunning
        let resumed: Bool
        var gate: GateServing?
        var closing = false
        var stopReason = StopReason.none
        var sessionID: String?
        var sawError = false
        var sawAssistantText = false
        var jobTimer: Task<Void, Never>?
        /// 클로드의 물음 번호 → 카드 번호(취소 요청이 오면 그 카드를 거둔다).
        var requestCards: [String: Int] = [:]
        init(id: Int, generation: Int, runner: InteractiveRunning, resumed: Bool) {
            self.id = id; self.generation = generation; self.runner = runner; self.resumed = resumed
        }
    }

    private enum AgentEvent: Sendable {
        case stream(StreamEvent)
        case control(ControlEvent)
        case cancel(requestID: String)
    }

    /// 한 프로세스의 출력 줄을 읽는 쪽(전용 큐에서 불리므로 잠근다). 줄마다 제어 줄이면 제어 이벤트로,
    /// 아니면 `ModelOutputReader` 로 — 순서를 그대로 지킨다.
    private final class ReaderBox: @unchecked Sendable {
        private let lock = NSLock()
        private var reader = ModelOutputReader(model: .claude)
        private var buffer = Data()
        static let maxBufferedBytes = 8_000_000

        func handle(_ event: RunEvent) -> [AgentEvent] {
            lock.withLock {
                guard case .stdout(let chunk) = event else {
                    return reader.handle(event).map { .stream($0) }
                }
                buffer.append(chunk)
                var out: [AgentEvent] = []
                while let nl = buffer.firstIndex(of: 0x0A) {
                    let line = Data(buffer[buffer.startIndex...nl])   // 줄바꿈 포함
                    buffer = Data(buffer[buffer.index(after: nl)...])
                    out += route(line)
                }
                if buffer.count > Self.maxBufferedBytes { buffer = Data() }
                return out
            }
        }

        func finish(_ outcome: RunOutcome) -> [AgentEvent] {
            lock.withLock {
                var out: [AgentEvent] = []
                if !buffer.isEmpty { out += route(buffer); buffer = Data() }
                return out + reader.finish(outcome: outcome).map { .stream($0) }
            }
        }

        private func route(_ line: Data) -> [AgentEvent] {
            if let control = ClaudeControl.parse(line) { return [.control(control)] }
            if let id = ClaudeControl.cancelledRequestID(line) { return [.cancel(requestID: id)] }
            return reader.handle(.stdout(line)).map { .stream($0) }
        }
    }

    private func perform(_ run: Run, text: String) async {
        // 막힐 수 있는 일(로그인 셸 PATH · 폴더 만들기)은 메인 밖에서.
        let loginPath = self.loginPath, workDirectory = self.workDirectory, memoryHome = self.memoryHome
        let prepared: Result<(path: String, dir: URL), Error> = await Task.detached(priority: .userInitiated) {
            do {
                let dir = try workDirectory()
                try ensurePrivateDirectory(memoryHome)
                return .success((loginPath(), dir))
            } catch { return .failure(error) }
        }.value

        if run.closing || Task.isCancelled { finishRun(run, outcome: .stopped); return }
        let path: String, dir: URL
        switch prepared {
        case .failure(let e):
            if run.generation == generation { append(.error("작업 폴더를 만들지 못했어요 — \(e.localizedDescription)")) }
            finishRun(run, outcome: .failed("작업 폴더"), reportsOutcome: false)
            return
        case .success(let p): path = p.path; dir = p.dir
        }

        // 관문 서버(메인 액터에서 만들고 시작 — start · stop 은 한 줄로 이어서 부른다).
        let gate: GateServing
        do { gate = try gateFactory() } catch {
            if run.generation == generation { append(.error("동작 관문을 열지 못했어요 — \(error.localizedDescription)")) }
            finishRun(run, outcome: .failed("동작 관문"), reportsOutcome: false)
            return
        }
        run.gate = gate
        let runID = run.id
        gate.start { [weak self] request in
            guard let self else { return .deny(GateServer.stoppedReason) }
            return await self.handleGate(request, runID: runID)
        }

        let (exe, args) = AgentCommandBuilder.build(resources: resources, gate: gate.info, memoryHome: memoryHome,
                                                    resumeSessionID: sessionID)
        run.jobTimer = Task { [self] in
            do { try await sleep(Self.jobTimeout) } catch { return }
            jobTimedOut(runID: runID)
        }

        let box = ReaderBox()
        let (stream, cont) = AsyncStream.makeStream(of: AgentEvent.self)
        let consumer = Task { [self] in
            for await e in stream { handle(e, run: run) }
        }
        let outcome = await run.runner.runInteractive(
            executable: exe, arguments: args, workDir: dir, path: path, timeout: Self.jobTimeout + 60,
            initialLines: [ClaudeControl.userMessage(text)]
        ) { event in
            for e in box.handle(event) { cont.yield(e) }
        }
        for e in box.finish(outcome) { cont.yield(e) }
        cont.finish()
        await consumer.value
        finishRun(run, outcome: outcome)
    }

    private func finishRun(_ run: Run, outcome: RunOutcome, reportsOutcome: Bool = true) {
        run.jobTimer?.cancel()
        run.jobTimer = nil
        run.closing = true
        resolveAllWaiters(.stopped)       // 프로세스가 끝났으니 더 기다릴 카드는 없다
        run.gate?.stop()
        run.gate = nil
        if run.generation == generation {
            switch run.stopReason {
            case .user: append(.notice(Self.stoppedNotice))
            case .timeout: append(.notice(Self.jobTimeoutNotice))
            case .none:
                if case .stopped = outcome, reportsOutcome { append(.notice(Self.stoppedNotice)) }
            }
            // 이어 하기: 오류 없이 끝났으면 세션을 기억, 이어 하던 일이 오류로 끝났으면 잊는다.
            if run.sawError { if run.resumed { sessionID = nil } }
            else if let s = run.sessionID { sessionID = s }
        }
        activity = nil
        isRunning = false
        isStopping = false
        phase = .planning
        if self.run === run { self.run = nil }
        task = nil
    }

    private func handle(_ event: AgentEvent, run: Run) {
        guard run.generation == generation else { return }
        switch event {
        case .stream(let e): apply(e, run: run)
        case .control(.permission(let req)): startPermission(req, run: run)
        case .control(.unsupported(let id, _)):
            reply(ClaudeControl.error(requestID: id, message: Self.unsupportedRequestMessage), run: run)
        case .cancel(let id):
            if let cardID = run.requestCards[id], let w = waiters[cardID] {
                w.resolve(.withdrawn)
                closeCard(cardID, fallback: .withdrawn)
            }
        }
    }

    private func apply(_ event: StreamEvent, run: Run) {
        switch event {
        case .text(let t):
            activity = nil
            run.sawAssistantText = true
            appendAssistant(t)
        case .toolUse(let name):
            activity = Self.progressLine(toolName: name)
        case .sessionID(let id):
            run.sessionID = id
        case .result(let isError, let text):
            activity = nil
            if isError {
                run.sawError = true
                append(.error(text.isEmpty ? "오류가 났어요" : text))
            } else if !run.sawAssistantText, !text.isEmpty {
                appendAssistant(text)
            }
            closeInputInBackground(run)   // 클로드가 한 턴을 마쳤다 — 입력을 닫으면 프로세스가 끝난다
        case .error(let msg):
            run.sawError = true
            if messages.last?.content != .error(msg) { append(.error(msg)) }
        }
    }

    static func progressLine(toolName name: String) -> String {
        if name == "ExitPlanMode" { return "작업 목록을 정리하는 중이에요…" }
        if name.hasPrefix(mcpToolPrefix) { return "사파리 \(name.dropFirst(mcpToolPrefix.count)) 하는 중이에요…" }
        return "\(name) 쓰는 중이에요…"
    }

    // MARK: 클로드의 도구 물음(can_use_tool)

    private func startPermission(_ req: PermissionRequest, run: Run) {
        guard !run.closing else { return }   // 멈추는 중 — 더 묻지 않는다(프로세스는 곧 끝난다)
        let input = req.input
        if req.toolName == "ExitPlanMode" {
            let plan = (input["plan"] as? String) ?? ""
            let (id, waiter) = openCard(.planCard(markdown: plan, state: .pending))
            run.requestCards[req.requestID] = id
            Task { [self] in
                let r = await waiter.wait()
                closeCard(id, fallback: r)
                guard run.generation == generation, !run.closing else { return }
                switch r {
                case .answer(.approve):
                    reply(ClaudeControl.allow(requestID: req.requestID, updatedInput: input, setModeManual: true), run: run)
                case .answer(.revise(let text)):
                    reply(ClaudeControl.deny(requestID: req.requestID, message: text), run: run)
                case .timedOut:
                    reply(ClaudeControl.deny(requestID: req.requestID, message: Self.cardExpiredReason), run: run)
                default: break   // 그만(멈춤은 answer 에서) · 멈춤 · 거둠 — 더 답하지 않는다
                }
            }
        } else if req.toolName == Self.replToolName {
            let code = (input["code"] as? String) ?? ""
            guard Self.hasWrapperWord(code) else {
                reply(ClaudeControl.allow(requestID: req.requestID, updatedInput: input, setModeManual: false), run: run)
                return
            }
            let (id, waiter) = openCard(.codeCard(code: code, state: .pending))
            run.requestCards[req.requestID] = id
            Task { [self] in
                let r = await waiter.wait()
                closeCard(id, fallback: r)
                guard run.generation == generation, !run.closing else { return }
                switch r {
                case .answer(.approve):
                    reply(ClaudeControl.allow(requestID: req.requestID, updatedInput: input, setModeManual: false), run: run)
                case .answer:
                    reply(ClaudeControl.deny(requestID: req.requestID, message: "사용자가 코드 실행을 거절했어요"), run: run)
                case .timedOut:
                    reply(ClaudeControl.deny(requestID: req.requestID, message: Self.cardExpiredReason), run: run)
                default: break
                }
            }
        } else if req.toolName.hasPrefix(Self.mcpToolPrefix) {
            reply(ClaudeControl.allow(requestID: req.requestID, updatedInput: input, setModeManual: false), run: run)
        } else {
            reply(ClaudeControl.deny(requestID: req.requestID, message: Self.toolNotAllowedMessage), run: run)
        }
    }

    static func hasWrapperWord(_ code: String) -> Bool {
        code.range(of: codeWrapperPattern, options: .regularExpression) != nil
    }

    // MARK: 동작 관문 요청

    /// 관문 서버가 부른다(어느 스레드에서든 — 메인 액터로 건너와 판정한다). 손님이 답 전에 끊으면 이 작업이 취소되어 카드를 거둔다.
    private func handleGate(_ req: GateRequest, runID: Int) async -> GateDecision {
        guard let run, run.id == runID, !run.closing else { return .deny(GateServer.stoppedReason) }
        let mode = siteModes.mode(for: req.host)
        switch ActionPolicy.decide(phase: phase, mode: mode, action: req.action, irreversible: req.irreversible) {
        case .allow: return .allow
        case .deny(let reason): return .deny(reason)
        case .card(let danger):
            let (id, waiter) = openCard(.actionCard(host: req.host, action: req.action, target: req.target,
                                                   value: req.value, danger: danger, state: .pending))
            let r = await waiter.waitHonoringCancellation()
            closeCard(id, fallback: r)
            switch r {
            case .answer(.approve): return .allow
            case .answer(.alwaysAllowSite):
                do { try siteModes.setMode(.allowAll, for: req.host) }
                catch { append(.notice("이 사이트 허락을 저장하지 못했어요 — 이번 한 번만 허락했어요")) }
                return .allow
            case .answer: return .deny(Self.cardRejectedReason)
            case .timedOut: return .deny(Self.cardExpiredReason)
            case .stopped: return .deny(GateServer.stoppedReason)
            case .withdrawn: return .deny(Self.cardRejectedReason)
            }
        }
    }

    // MARK: 카드 · 멈춤

    /// 카드를 목록에 올리고 300초 시계를 켠다.
    private func openCard(_ content: AgentMessageContent) -> (id: Int, waiter: CardWaiter) {
        let id = append(content)
        let waiter = CardWaiter()
        waiters[id] = waiter
        let sleep = self.sleep
        cardTimers[id] = Task {
            do { try await sleep(Self.cardTimeout) } catch { return }
            waiter.resolve(.timedOut)
        }
        return (id, waiter)
    }

    /// 카드를 닫는다 — 시계 끄기 · 기다림 지우기 · 아직 `pending` 이면 결과대로 상태 바꾸기. 여러 번 불려도 된다.
    private func closeCard(_ id: Int, fallback: CardWaiter.Resolution) {
        let resolution = waiters[id]?.current ?? fallback
        waiters[id] = nil
        cardTimers[id]?.cancel()
        cardTimers[id] = nil
        guard let i = messages.firstIndex(where: { $0.id == id }), messages[i].isPendingCard else { return }
        let state: AgentCardState
        switch resolution {
        case .answer(.approve): state = .approved
        case .answer(.alwaysAllowSite): state = .alwaysAllowed
        case .answer(.reject): state = .rejected
        case .answer(.revise(let t)): state = .revised(t)
        case .timedOut: state = .expired
        case .stopped: state = .stopped
        case .withdrawn: state = .withdrawn
        }
        messages[i].setCardState(state)
    }

    private func resolveAllWaiters(_ r: CardWaiter.Resolution) {
        for (id, w) in waiters {
            w.resolve(r)
            closeCard(id, fallback: r)
        }
    }

    private func beginClosing(_ run: Run, reason: StopReason) {
        guard !run.closing else { return }
        run.closing = true
        run.stopReason = reason
        isStopping = true
        run.jobTimer?.cancel()
        run.jobTimer = nil
        resolveAllWaiters(.stopped)
        closeInputInBackground(run)
        run.runner.stop()
        run.gate?.stop()
        task?.cancel()
    }

    private func jobTimedOut(runID: Int) {
        guard let run, run.id == runID else { return }
        beginClosing(run, reason: .timeout)
    }

    // MARK: 도우미

    private func newRunID() -> Int { nextRunID += 1; return nextRunID }

    @discardableResult
    private func append(_ content: AgentMessageContent) -> Int {
        nextID += 1
        messages.append(AgentMessage(id: nextID, content: content))
        return nextID
    }

    private func appendAssistant(_ text: String) {
        if let last = messages.last, case .assistant(let prev) = last.content {
            messages[messages.count - 1].content = .assistant(prev + "\n\n" + text)
        } else {
            append(.assistant(text))
        }
    }

    /// 클로드 입력에 답 한 줄을 쓴다 — `write` 가 막힐 수 있어 메인 밖에서(순서가 필요한 줄은 없다).
    private func reply(_ line: String, run: Run) {
        let runner = run.runner
        Task.detached(priority: .userInitiated) { try? runner.write(line) }
    }

    /// `closeInput` 도 쓰기와 같은 자물쇠를 쓰므로 메인 밖에서.
    private func closeInputInBackground(_ run: Run) {
        let runner = run.runner
        Task.detached(priority: .userInitiated) { runner.closeInput() }
    }
}

/// 폴더를 0700 으로 만든다(이미 있어도 권한을 조인다).
private func ensurePrivateDirectory(_ url: URL) throws {
    let fm = FileManager.default
    try fm.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
}
