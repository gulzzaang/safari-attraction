import Foundation
import Observation

/// 화면에 쌓이는 말풍선 하나.
public struct ChatMessage: Identifiable, Equatable, Sendable {
    public let id: Int
    public var role: Turn.Role
    public var text: String
    /// 답한 모델(답 말풍선만).
    public var model: ModelKind?
    /// 이 질문에 붙인 페이지의 제목(사용자 말풍선만 — 「이 페이지 함께」).
    public var pageTitle: String?
    /// 답 앞에 보이는 회색 안내(예: ChatGPT 는 웹 검색을 못 한다).
    public var notice: String?
    /// 답 끝의 회색 한 줄(「멈췄어요」).
    public var status: String?
    /// 빨간 한 줄.
    public var error: String?
    public var isStreaming: Bool

    public init(id: Int, role: Turn.Role, text: String = "", model: ModelKind? = nil, pageTitle: String? = nil,
                notice: String? = nil, status: String? = nil, error: String? = nil, isStreaming: Bool = false) {
        self.id = id; self.role = role; self.text = text; self.model = model; self.pageTitle = pageTitle
        self.notice = notice; self.status = status; self.error = error; self.isStreaming = isStreaming
    }
}

/// 옆 창 대화의 두뇌 — 입력 · 모델 · 토글 · 대화 기록 · 한 번의 질문(사파리 읽기 → CLI 실행 → 흘러나오는 답)을 맡는다.
/// 화면(SwiftUI)은 이 객체를 그리기만 한다. 모든 상태 변경은 메인 액터에서 일어나고,
/// 막힐 수 있는 일(사파리 읽기 · 로그인 PATH 읽기 · CLI 실행)은 메인 밖에서 돈다.
@MainActor @Observable
public final class ChatViewModel {
    public static let stoppedStatus = "멈췄어요"
    public static let pageReadBackoff: TimeInterval = 30

    // 화면이 읽고 쓰는 것
    public var input = ""
    public var model: ModelKind = .claude
    public var webSearch = false
    public var attachPage = false
    public private(set) var pinned = false
    public private(set) var messages: [ChatMessage] = []
    public private(set) var isRunning = false
    /// 멈추라고 했지만 자식 프로세스가 아직 안 끝났다 — 그동안은 새 질문을 받지 않고 화면은 「멈추는 중…」.
    public private(set) var isStopping = false
    /// 답을 기다리는 동안 보이는 한 줄(예: 웹을 찾아보는 중).
    public private(set) var activity: String?
    /// 입력 칸 위에 보이는 안내(빨강 아님) — 사파리 허락 · 시작 페이지 등.
    public private(set) var hint: String?
    /// 가장 최근 질문의 결과(개발용 기록).
    public private(set) var lastRun: RunRecord?
    /// 옆 창이 열릴 때마다 늘어난다 — 화면이 입력 칸에 커서를 두는 신호.
    public private(set) var focusTick = 0

    /// 「고정」 이 바뀌면 알린다(따라가기에 전달).
    @ObservationIgnored public var onPinnedChange: (@MainActor (Bool) -> Void)?

    @ObservationIgnored private let runner: CommandRunning
    @ObservationIgnored private let bridge: SafariBridging
    @ObservationIgnored private let loginPath: @Sendable () -> String
    @ObservationIgnored private let workDirectory: @Sendable () throws -> URL
    @ObservationIgnored private let timeout: TimeInterval
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let enabledModels: [ModelKind]

    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var nextID = 0
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var claudeSessionID: String?
    @ObservationIgnored private var pageBlockedUntil: Date?

    public init(runner: CommandRunning, bridge: SafariBridging,
                loginPath: @escaping @Sendable () -> String,
                workDirectory: @escaping @Sendable () throws -> URL = { try AppPaths.workDirectory() },
                timeout: TimeInterval = ProcessRunner.defaultTimeout,
                now: @escaping @Sendable () -> Date = { Date() },
                enabledModels: [ModelKind] = ModelKind.enabled) {
        self.runner = runner; self.bridge = bridge; self.loginPath = loginPath
        self.workDirectory = workDirectory; self.timeout = timeout; self.now = now
        // 빈 목록은 부르는 쪽 실수 — 개발 중엔 바로 알리고, 출시 빌드에선 클로드로 둔다.
        assert(!enabledModels.isEmpty, "enabledModels 가 비어 있음")
        self.enabledModels = enabledModels.isEmpty ? [.claude] : enabledModels
    }

    /// 화면이 보여 줄 모델 목록(하나면 고르기 칸을 숨긴다).
    public var availableModels: [ModelKind] { enabledModels }

    // MARK: 화면이 부르는 것

    /// 입력 칸의 글을 보낸다. 보낼 것이 없거나 아직 답하는 중이면 nil. 돌려주는 Task 는 답이 끝나면 끝난다.
    @discardableResult
    public func send() -> Task<Void, Never>? {
        let question = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, !isRunning else { return nil }
        // 꺼 둔 모델(개발용 주소 등으로 들어온 것)은 절대 부르지 않는다 — 첫 번째 켜진 모델로 바꾼다.
        if !enabledModels.contains(model) { model = enabledModels[0] }
        input = ""
        hint = nil
        activity = nil

        let job = Job(question: question, model: model, webSearch: webSearch, wantPage: attachPage,
                      history: makeHistory(), sessionID: model == .claude ? claudeSessionID : nil,
                      userID: newID(), answerID: newID(), generation: generation)
        messages.append(ChatMessage(id: job.userID, role: .user, text: question))
        messages.append(ChatMessage(id: job.answerID, role: .assistant, model: model, isStreaming: true))
        isRunning = true
        let t = Task { [self] in await perform(job) }
        task = t
        return t
    }

    /// 답하는 중이면 멈춘다(자식 프로세스까지 — SIGTERM, 2초 뒤 SIGKILL).
    public func stop() {
        guard isRunning else { return }
        isStopping = true
        task?.cancel()
        runner.stop()
    }

    /// 앱을 끝낼 때 — 돌고 있는 답을 멈춘다.
    public func shutdown() {
        if isRunning { isStopping = true }
        task?.cancel()
        runner.stop()
    }

    /// 대화를 비우고 처음부터. 답하는 중이었으면 멈춘다.
    public func newChat() {
        stop()
        generation += 1
        messages = []
        claudeSessionID = nil
        hint = nil
        activity = nil
    }

    public func setPinned(_ value: Bool) {
        guard pinned != value else { return }
        pinned = value
        onPinnedChange?(value)
    }

    /// 옆 창이 열렸을 때 — 입력 칸에 커서를 두게 한다.
    public func requestFocus() { focusTick += 1 }

    // MARK: 한 번의 질문

    private struct Job: Sendable {
        var question: String
        var model: ModelKind
        var webSearch: Bool
        var wantPage: Bool
        var history: [Turn]
        var sessionID: String?
        var userID: Int
        var answerID: Int
        var generation: Int
    }

    /// 한 번의 실행 동안 CLI 가 내는 이벤트를 읽는 쪽(전용 큐에서 불리므로 잠근다).
    private final class ReaderBox: @unchecked Sendable {
        private let lock = NSLock()
        private var reader: ModelOutputReader
        init(model: ModelKind) { reader = ModelOutputReader(model: model) }
        func handle(_ e: RunEvent) -> [StreamEvent] { lock.withLock { reader.handle(e) } }
        func finish(_ o: RunOutcome) -> [StreamEvent] { lock.withLock { reader.finish(outcome: o) } }
    }

    private func perform(_ job: Job) async {
        let started = now()
        var page: PageContext?
        var outcome: RunOutcome = .stopped
        var turnSession: String?

        if !Task.isCancelled {
            if job.wantPage { page = await readPage() }
            if let page { setPageTitle(page, on: job.userID) }
        }

        if !Task.isCancelled {
            let request = AskRequest(question: job.question, model: job.model, webSearch: job.webSearch,
                                     page: page, history: job.history, claudeSessionID: job.sessionID)
            if let notice = CommandBuilder.notice(for: request) { update(job.answerID) { $0.notice = notice } }

            if CommandBuilder.exceedsPromptLimit(request) {
                // 너무 긴 질문은 CLI 를 띄우지 않고 그 답 말풍선에 한 줄로 알린다.
                update(job.answerID) { $0.error = CommandBuilder.promptTooLongMessage }
                finish(job, outcome: .failed(CommandBuilder.promptTooLongMessage), page: page, session: nil, started: started)
                return
            }

            // 막힐 수 있는 일(로그인 셸 PATH 는 앱이 켜진 뒤 첫 질문에서 처음 읽고 캐시 — 최대 8초)은 메인 밖에서.
            let loginPath = self.loginPath, workDirectory = self.workDirectory
            let prepared: Result<(path: String, dir: URL), Error> = await Task.detached(priority: .userInitiated) {
                do { return .success((loginPath(), try workDirectory())) } catch { return .failure(error) }
            }.value

            if Task.isCancelled {
                outcome = .stopped
            } else {
                switch prepared {
                case .failure(let e):
                    outcome = .failed("작업 폴더를 만들지 못했어요(\(e.localizedDescription))")
                    update(job.answerID) { $0.error = "작업 폴더를 만들지 못했어요 — \(e.localizedDescription)" }
                case .success(let p):
                    let (exe, args) = CommandBuilder.build(request, workDir: p.dir)
                    let box = ReaderBox(model: job.model)
                    let (stream, cont) = AsyncStream.makeStream(of: StreamEvent.self)
                    let consumer = Task { [self] in
                        var session: String?
                        for await e in stream { if let s = apply(e, to: job) { session = s } }
                        return session
                    }
                    outcome = await runner.run(executable: exe, arguments: args, workDir: p.dir, path: p.path,
                                               timeout: timeout) { event in
                        for e in box.handle(event) { cont.yield(e) }
                    }
                    for e in box.finish(outcome) { cont.yield(e) }
                    cont.finish()
                    turnSession = await consumer.value
                }
            }
        }
        finish(job, outcome: outcome, page: page, session: turnSession, started: started)
    }

    /// 이벤트 하나를 답 말풍선에 반영한다. Claude session_id 가 나오면 돌려준다.
    private func apply(_ event: StreamEvent, to job: Job) -> String? {
        switch event {
        case .text(let t):
            activity = nil
            update(job.answerID) { m in
                // Claude 는 말풍선 단위로 오니 사이를 한 줄 띄운다. agy · codex 는 받은 대로 이어 붙인다.
                if job.model == .claude && !m.text.isEmpty { m.text += "\n\n" }
                m.text += t
            }
        case .toolUse(let name):
            activity = (name == "WebSearch" || name == "WebFetch") ? "웹을 찾아보는 중이에요…" : "\(name) 쓰는 중이에요…"
        case .sessionID(let id):
            if job.model == .claude { return id }
        case .result(let isError, let text):
            update(job.answerID) { m in
                if isError {
                    if m.error == nil { m.error = text.isEmpty ? "오류가 났어요" : text }
                } else if m.text.isEmpty && !text.isEmpty {
                    m.text = text
                }
            }
        case .error(let msg):
            update(job.answerID) { if $0.error == nil { $0.error = msg } }
        }
        return nil
    }

    private func finish(_ job: Job, outcome: RunOutcome, page: PageContext?, session: String?, started: Date) {
        update(job.answerID) { m in
            m.isStreaming = false
            if case .stopped = outcome { m.status = Self.stoppedStatus }
        }
        activity = nil
        isRunning = false
        isStopping = false
        task = nil

        let answer = messages.first { $0.id == job.answerID }
        if generation == job.generation {
            if job.model == .claude {
                if answer?.error == nil { if let session { claudeSessionID = session } }
                else if job.sessionID != nil { claudeSessionID = nil } // 이어 묻기가 실패했을 수 있다 — 다음엔 앞 대화를 붙여 새로
            } else if answer?.error == nil, !(answer?.text.isEmpty ?? true) {
                // Claude 가 모르는 대화가 생겼다 — 다음 Claude 질문엔 session 대신 앞 대화를 붙인다.
                claudeSessionID = nil
            }
        }
        lastRun = RunRecord(model: job.model.rawValue, question: job.question, answer: answer?.text ?? "",
                            error: answer?.error, durationMs: max(0, Int(now().timeIntervalSince(started) * 1000)),
                            attachedPage: page.map(RunRecord.AttachedPage.from))
    }

    // MARK: 사파리 읽기

    /// 「이 페이지 함께」 가 켜져 있을 때만, 보내는 순간에 한 번(제목 · 주소 · 고른 글이 한 번에 — 탭이 사이에 바뀌지 않는다).
    private func readPage() async -> PageContext? {
        if let until = pageBlockedUntil, now() < until {
            attachPage = false
            hint = SafariBridgeError.automationDenied.hint
            return nil
        }
        let bridge = self.bridge
        let result = await Task.detached(priority: .userInitiated) { bridge.frontTab() }.value
        if case .failure(.automationDenied) = result { pageBlockedUntil = now().addingTimeInterval(Self.pageReadBackoff) }
        let attachment = PageAttachment.resolve(result)
        if attachment.turnOffToggle { attachPage = false }
        hint = attachment.hint
        return attachment.page
    }

    private func setPageTitle(_ page: PageContext, on id: Int) {
        let title = page.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = title.isEmpty ? (URL(string: page.url)?.host ?? page.url) : title
        update(id) { $0.pageTitle = label }
    }

    // MARK: 도우미

    private func newID() -> Int { nextID += 1; return nextID }

    /// 말풍선은 늘 (질문, 답) 짝으로 쌓인다. 답이 오류 없이 글이 있는 짝만 앞 대화로 쓴다.
    private func makeHistory() -> [Turn] {
        var turns: [Turn] = []
        var i = 0
        while i + 1 < messages.count {
            let q = messages[i], a = messages[i + 1]
            if q.role == .user, a.role == .assistant, !a.isStreaming, a.error == nil,
               !a.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                turns.append(Turn(role: .user, text: q.text))
                turns.append(Turn(role: .assistant, text: a.text))
            }
            i += 2
        }
        return turns
    }

    /// 대화를 비운 뒤 늦게 도착한 일은 조용히 버린다(없는 id).
    private func update(_ id: Int, _ change: (inout ChatMessage) -> Void) {
        guard let i = messages.firstIndex(where: { $0.id == id }) else { return }
        change(&messages[i])
    }
}
