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
    /// 이 답에 쓴 양(토큰 수) — CLI 가 알려 준 경우만.
    public var usage: TokenUsage?

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
    @ObservationIgnored private let settings: AppSettingsStore?
    /// CLI 마다 고른 모델 id(`settings.json` 과 같이 간다).
    public private(set) var modelIDs: [ModelKind: String] = [:]
    /// 로그인 상태 · 모델 목록(설정 창과 같은 것을 읽는다) — 없으면 고르기 칸은 고정 목록만.
    @ObservationIgnored public let status: CLIStatusService?

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
                enabledModels: [ModelKind] = ModelKind.enabled,
                settings: AppSettingsStore? = nil, status: CLIStatusService? = nil) {
        self.runner = runner; self.bridge = bridge; self.loginPath = loginPath
        self.workDirectory = workDirectory; self.timeout = timeout; self.now = now
        self.settings = settings; self.status = status
        // 빈 목록은 부르는 쪽 실수 — 개발 중엔 바로 알리고, 출시 빌드에선 클로드로 둔다.
        assert(!enabledModels.isEmpty, "enabledModels 가 비어 있음")
        self.enabledModels = enabledModels.isEmpty ? [.claude] : enabledModels
        if let saved = settings?.current {
            for (k, v) in saved.models { if let kind = ModelKind(rawValue: k) { modelIDs[kind] = v } }
            if let kind = ModelKind(rawValue: saved.selectedCLI), self.enabledModels.contains(kind) { model = kind }
        }
    }

    // MARK: CLI · 모델 고르기

    /// 고를 수 있는 모델 목록(클로드는 고정 · 나머지는 불러온 것 — 못 불렀으면 빈 목록).
    public func modelChoices(for kind: ModelKind) -> [ModelChoice] {
        kind == .claude ? CLIModels.claudeChoices : (status?.models(for: kind) ?? [])
    }

    /// 지금 쓸 모델 id — 저장해 둔 것이 목록에 있으면 그것, 아니면 그 CLI 의 기본(클로드 sonnet · agy `gemini-3.8-flash-medium` · opencode 첫 `-free`…).
    /// 목록이 비면 nil(codex · opencode 는 `-m` 없이 CLI 기본 모델에 맡기고, agy 는 기본 모델 이름으로).
    public func selectedModelID(for kind: ModelKind) -> String? {
        CLIModels.resolve(kind: kind, selected: modelIDs[kind], in: modelChoices(for: kind))
    }

    /// 옆 창 입력 칸 아래 남은 양 한 줄(예: 「5시간 23% 사용 · 주간 48%」) — 고른 CLI 의 값. 못 읽었으면 nil(한 줄을 숨긴다).
    /// opencode 는 구독 남은 양이 없어서 이 맥에서 쓴 양 한 줄. agy 는 고른 모델 묶음(제미나이 · 클로드 · GPT)의 창만.
    public var remainingUsageText: String? {
        guard let snap = status?.state(model).usage else { return nil }
        if model == .opencode { return snap.rawLines.first }
        let group = model == .gemini ? AgyUsageParser.group(forModelID: selectedModelID(for: .gemini)) : nil
        return UsageFormat.oneLine(snap, group: group)
    }

    public func setModelID(_ id: String, for kind: ModelKind) {
        guard modelChoices(for: kind).contains(where: { $0.id == id }) else { return }
        modelIDs[kind] = id
        persist { $0.models[kind.rawValue] = id }
    }

    /// 앱 전용 HOME 방식의 제미나이는 키체인 창이 뜰 수 있어서 자동으로 읽지 않는다(「로그인」 · 「새로 고침」 을 누를 때만).
    public var agyAutoRead: Bool { (settings?.current.agyMode ?? .shared) == .shared }

    /// 옆 창을 열 때 · CLI 칩을 바꿀 때 — 그 CLI 의 상태 · 목록 · 남은 양을 읽는다(5분 안이면 읽지 않음, 메인 밖).
    public func refreshStatus(for kind: ModelKind) async {
        await status?.refreshForPanel(selected: kind, agyAutoRead: agyAutoRead)
    }

    /// 로그인 상태를 모르면 `.unknown`(막지 않는다).
    public func loginState(for kind: ModelKind) -> CLILoginState { status?.state(kind).login ?? .unknown }

    /// CLI 를 고른다. 로그인이 안 된 걸 아는 CLI 면 바꾸지 않고 안내만 띄운다. 바꿨으면 true.
    @discardableResult
    public func selectCLI(_ kind: ModelKind) -> Bool {
        guard enabledModels.contains(kind), !isRunning else { return false }
        if loginState(for: kind) == .loggedOut {
            hint = "\(CLICommands.displayName(kind)) 로그인이 안 돼 있어요 — 메뉴 막대 「설정…」 에서 로그인해 주세요"
            return false
        }
        model = kind
        hint = nil
        persist { $0.selectedCLI = kind.rawValue }
        return true
    }

    private func persist(_ change: @escaping (inout AppSettings) -> Void) {
        guard let settings else { return }
        do { try settings.update(change) } catch { NSLog("사파리-어트랙션: 설정을 저장하지 못했어요 — %@", error.localizedDescription) }
    }

    /// 마지막 답에 쓴 양 한 줄(답이 끝났고 CLI 가 알려 준 경우).
    public var lastUsageText: String? {
        guard let m = messages.last, m.role == .assistant, !m.isStreaming, m.error == nil else { return nil }
        return m.usage?.summary
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
                      userID: newID(), answerID: newID(), generation: generation, modelID: selectedModelID(for: model))
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
        var modelID: String?
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
            let request = AskRequest(question: job.question, model: job.model,
                                     page: page, history: job.history, claudeSessionID: job.sessionID, modelID: job.modelID)
            // 가운데(안내 · 상한 · 로그인 확인 · CLI 실행 · 출력 읽기)는 페이지 패널 서버와 같이 쓰는 `AskFlow` — 단계는 순서대로 이 메인 액터에서 반영한다.
            let (stream, cont) = AsyncStream.makeStream(of: AskFlow.Step.self)
            let consumer = Task { [self] in
                var session: String?
                for await step in stream {
                    switch step {
                    case .notice(let n): update(job.answerID) { $0.notice = n }
                    case .failure(let message): update(job.answerID) { $0.error = message }
                    case .event(let e): if let s = apply(e, to: job) { session = s }
                    }
                }
                return session
            }
            outcome = await AskFlow.run(request: request, runner: runner, loginPath: loginPath, workDirectory: workDirectory,
                                        timeout: timeout,
                                        geminiLoggedOut: { [self] in await loginState(for: .gemini) == .loggedOut },
                                        emit: { cont.yield($0) })
            cont.finish()
            turnSession = await consumer.value
        }
        finish(job, outcome: outcome, page: page, session: turnSession, started: started)
    }

    /// 이벤트 하나를 답 말풍선에 반영한다. Claude session_id 가 나오면 돌려준다.
    private func apply(_ event: StreamEvent, to job: Job) -> String? {
        switch event {
        case .text(let t):
            activity = nil
            update(job.answerID) { m in
                // Claude · codex 는 말풍선(메시지) 단위로 오니 사이를 한 줄 띄운다. agy 는 받은 대로 이어 붙인다.
                if job.model != .gemini && !m.text.isEmpty { m.text += "\n\n" }
                m.text += t
            }
        case .toolUse(let name):
            activity = ToolActivity.label(for: name)
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
        case .usage(let u):
            update(job.answerID) { $0.usage = u }
        case .rateLimits(let snap):
            if job.model == .claude { status?.applyLiveUsage(.claude, snap) }   // 답과 함께 온 한도 — 옆 창 한 줄을 바로 갱신
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
