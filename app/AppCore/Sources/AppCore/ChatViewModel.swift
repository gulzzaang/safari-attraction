import Foundation
import Observation

/// Node 18 이상이 로그인 셸 PATH 에 있는지 확인한다(경로당 한 번만 실행해 캐시).
public enum NodeCheck {
    private final class Cache: @unchecked Sendable {
        private let lock = NSLock()
        private var entries: [String: Bool] = [:]
        func get(_ path: String) -> Bool? { lock.withLock { entries[path] } }
        func set(_ path: String, _ value: Bool) { lock.withLock { entries[path] = value } }
    }
    private static let cache = Cache()

    /// `node -v` 출력(예: `v22.12.0\n`)에서 주 버전이 18 이상인지 본다.
    public static func isVersionAtLeast18(_ output: String) -> Bool {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = trimmed.hasPrefix("v") || trimmed.hasPrefix("V") ? String(trimmed.dropFirst()) : trimmed
        guard let majorText = body.split(separator: ".").first, let major = Int(majorText) else { return false }
        return major >= 18
    }

    public static func hasNode18(path: String) -> Bool {
        guard let exe = ProcessRunner.resolve("node", path: path) else { return false }
        if let cached = cache.get(exe) { return cached }
        final class Box: @unchecked Sendable {
            private let lock = NSLock()
            private var data = Data()
            func append(_ d: Data) { lock.withLock { if data.count < 256 { data.append(d) } } }
            var text: String { lock.withLock { String(decoding: data, as: UTF8.self) } }
        }
        let box = Box()
        let outcome = ProcessRunner().runBlocking(
            executable: exe, arguments: ["-v"],
            workDir: FileManager.default.temporaryDirectory, path: path, timeout: 3,
            onEvent: { if case .stdout(let d) = $0 { box.append(d) } }
        )
        let ok: Bool
        if case .finished(0) = outcome { ok = isVersionAtLeast18(box.text) } else { ok = false }
        cache.set(exe, ok)
        return ok
    }
}

/// 화면에 쌓이는 말풍선 또는 허락 카드 하나.
public struct ChatMessage: Identifiable, Equatable, Sendable {
    public let id: Int
    public var role: Turn.Role
    public var text: String
    /// 답한 모델(답 말풍선만).
    public var model: ModelKind?
    /// 이 질문에 붙인 페이지의 제목(사용자 말풍선만).
    public var pageTitle: String?
    /// 답 앞에 보이는 회색 안내(예: 사파리 도구 미사용 안내).
    public var notice: String?
    /// 답 끝의 회색 한 줄(「멈췄어요」).
    public var status: String?
    /// 빨간 한 줄.
    public var error: String?
    public var isStreaming: Bool
    /// 이 답에 쓴 양(토큰 수) — CLI 가 알려 준 경우만.
    public var usage: TokenUsage?
    /// 허락 카드(동작 · 코드 카드)의 식별자 — `ChatViewModel.answerCard(id:_:)` 에 넘긴다.
    public var cardID: UUID?
    /// 허락 카드 내용(`.actionCard` · `.codeCard`). 일반 말풍선이면 nil.
    public var card: AgentMessageContent?

    public init(id: Int, role: Turn.Role, text: String = "", model: ModelKind? = nil, pageTitle: String? = nil,
                notice: String? = nil, status: String? = nil, error: String? = nil, isStreaming: Bool = false,
                cardID: UUID? = nil, card: AgentMessageContent? = nil) {
        self.id = id; self.role = role; self.text = text; self.model = model; self.pageTitle = pageTitle
        self.notice = notice; self.status = status; self.error = error; self.isStreaming = isStreaming
        self.cardID = cardID; self.card = card
    }

    public var cardState: AgentCardState? {
        guard let card else { return nil }
        switch card {
        case .planCard(_, let s), .actionCard(_, _, _, _, _, let s), .codeCard(_, let s): return s
        default: return nil
        }
    }

    public var isPendingCard: Bool { cardState?.isPending ?? false }

    mutating func setCardState(_ s: AgentCardState) {
        guard let card else { return }
        switch card {
        case .planCard(let md, _): self.card = .planCard(markdown: md, state: s)
        case .actionCard(let h, let a, let t, let v, let d, _):
            self.card = .actionCard(host: h, action: a, target: t, value: v, danger: d, state: s)
        case .codeCard(let c, _): self.card = .codeCard(code: c, state: s)
        default: break
        }
    }
}

/// 옆 창 대화의 두뇌 — 입력 · CLI · 모델 · 생각 단계 · 대화 기록 · 사파리 도구 자리 · 허락 카드 · 한 번의 질문을 맡는다.
/// 화면(SwiftUI)은 이 객체를 그리기만 한다. 모든 상태 변경은 메인 액터에서 일어나고,
/// 막힐 수 있는 일(사파리 읽기 · 로그인 PATH 읽기 · Node 확인 · CLI 실행)은 메인 밖에서 돈다.
@MainActor @Observable
public final class ChatViewModel {
    public static let stoppedStatus = "멈췄어요"
    public static let pageReadBackoff: TimeInterval = 30
    public static let nodeMissingNotice = "사파리 도구를 못 켰어요(Node 18 이상 필요) — 답만 해요"
    public static let waitingCardActivity = "허락 기다리는 중 …"

    // 화면이 읽고 쓰는 것
    public var input = ""
    public var model: ModelKind = .claude
    public private(set) var pinned = false
    public private(set) var messages: [ChatMessage] = [] {
        didSet { notifyPendingCardChange() }
    }
    public private(set) var isRunning = false
    /// 멈추라고 했지만 자식 프로세스가 아직 안 끝났다 — 그동안은 새 질문을 받지 않고 화면은 「멈추는 중…」.
    public private(set) var isStopping = false
    /// 답을 기다리는 동안 보이는 한 줄(예: 검색 중 … · 사파리 보는 중 … · 허락 기다리는 중 …).
    public private(set) var activity: String?
    /// 입력 칸 위에 보이는 안내(빨강 아님) — 사파리 허락 · 로그인 필요 등.
    public private(set) var hint: String?
    /// 가장 최근 질문의 결과(개발용 기록).
    public private(set) var lastRun: RunRecord?
    /// 옆 창이 열릴 때마다 늘어난다 — 화면이 입력 칸에 커서를 두는 신호.
    public private(set) var focusTick = 0

    /// 사람의 답을 기다리는 카드가 있다 — 화면 · 메뉴 막대 「기다림」.
    public var hasPendingCard: Bool { messages.contains { $0.isPendingCard } }

    /// 「고정」 이 바뀌면 알린다(따라가기에 전달).
    @ObservationIgnored public var onPinnedChange: (@MainActor (Bool) -> Void)?
    /// 기다리는 카드가 생기거나 모두 사라질 때만 불린다(옆 창 고정 · 메뉴 막대 아이콘).
    @ObservationIgnored public var onPendingCardChange: (@MainActor (Bool) -> Void)?
    @ObservationIgnored private var lastNotifiedPending = false

    @ObservationIgnored private let runner: CommandRunning
    @ObservationIgnored private let bridge: SafariBridging
    @ObservationIgnored private let loginPath: @Sendable () -> String
    @ObservationIgnored private let workDirectory: @Sendable () throws -> URL
    @ObservationIgnored private let supportDirectory: (@Sendable () throws -> URL)?
    @ObservationIgnored private let timeout: TimeInterval
    @ObservationIgnored private let cardTimeout: TimeInterval
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let enabledModels: [ModelKind]
    @ObservationIgnored private let settings: AppSettingsStore?
    @ObservationIgnored private let interactiveGate: InteractiveGate?
    @ObservationIgnored private let siteModes: SiteModeStore?
    @ObservationIgnored private let safariResources: URL?
    @ObservationIgnored private let nodeCheck: @Sendable (String) -> Bool
    @ObservationIgnored private let sleep: @Sendable (TimeInterval) async throws -> Void

    /// CLI 마다 고른 모델 id(`settings.json` 과 같이 간다).
    public private(set) var modelIDs: [ModelKind: String] = [:]
    /// CLI 마다 고른 생각 단계(`settings.json` 의 `efforts` 와 같이 간다. 기본은 키 없음).
    public private(set) var efforts: [ModelKind: String] = [:]
    /// 로그인 상태 · 모델 목록(설정 창과 같은 것을 읽는다) — 없으면 고르기 칸은 고정 목록만.
    @ObservationIgnored public let status: CLIStatusService?

    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var nextID = 0
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var claudeSessionID: String?
    @ObservationIgnored private var pageBlockedUntil: Date?
    @ObservationIgnored private var activeLease: GateLease?
    @ObservationIgnored private var waiters: [UUID: CardWaiter] = [:]
    @ObservationIgnored private var cardTimers: [UUID: Task<Void, Never>] = [:]

    public init(runner: CommandRunning, bridge: SafariBridging,
                loginPath: @escaping @Sendable () -> String,
                workDirectory: @escaping @Sendable () throws -> URL = { try AppPaths.workDirectory() },
                supportDirectory: (@Sendable () throws -> URL)? = nil,
                timeout: TimeInterval = ProcessRunner.defaultTimeout,
                cardTimeout: TimeInterval = AgentSession.cardTimeout,
                now: @escaping @Sendable () -> Date = { Date() },
                enabledModels: [ModelKind] = ModelKind.enabled,
                settings: AppSettingsStore? = nil, status: CLIStatusService? = nil,
                interactiveGate: InteractiveGate? = nil,
                siteModes: SiteModeStore? = nil,
                safariResources: URL? = nil,
                nodeCheck: @escaping @Sendable (String) -> Bool = { NodeCheck.hasNode18(path: $0) },
                sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }) {
        self.runner = runner; self.bridge = bridge; self.loginPath = loginPath
        self.workDirectory = workDirectory; self.supportDirectory = supportDirectory
        self.timeout = timeout; self.cardTimeout = cardTimeout; self.now = now
        self.settings = settings; self.status = status
        self.interactiveGate = interactiveGate; self.siteModes = siteModes
        self.safariResources = safariResources; self.nodeCheck = nodeCheck; self.sleep = sleep
        // 빈 목록은 부르는 쪽 실수 — 개발 중엔 바로 알리고, 출시 빌드에선 클로드로 둔다.
        assert(!enabledModels.isEmpty, "enabledModels 가 비어 있음")
        self.enabledModels = enabledModels.isEmpty ? [.claude] : enabledModels
        if let saved = settings?.current {
            for (k, v) in saved.models { if let kind = ModelKind(rawValue: k) { modelIDs[kind] = v } }
            for (k, v) in saved.efforts { if let kind = ModelKind(rawValue: k), !v.isEmpty { efforts[kind] = v } }
            if let kind = ModelKind(rawValue: saved.selectedCLI), self.enabledModels.contains(kind) { model = kind }
        }
    }

    // MARK: CLI · 모델 · 생각 단계 고르기

    /// 고를 수 있는 원본 모델 목록(클로드는 고정 · 나머지는 불러온 것 — 못 불렀으면 빈 목록).
    public func modelChoices(for kind: ModelKind) -> [ModelChoice] {
        kind == .claude ? CLIModels.claudeChoices : (status?.models(for: kind) ?? [])
    }

    /// 제미나이(agy) 모델 묶음(생각 단계 접미사로 묶은 목록).
    public func agyFamilies() -> [AgyFamily] {
        CLIModels.agyFamilies(modelChoices(for: .gemini).map(\.id))
    }

    /// 화면의 모델 드롭다운에 보일 목록 — 제미나이는 단계를 떼고 묶음별로 한 번만 보인다.
    public func displayModelChoices(for kind: ModelKind) -> [ModelChoice] {
        guard kind == .gemini else { return modelChoices(for: kind) }
        return agyFamilies().map { ModelChoice(id: $0.base, label: $0.base) }
    }

    /// 화면의 모델 드롭다운에서 지금 선택된 id — 제미나이는 단계를 뗀 묶음 이름(예: `gemini-4-neon`).
    public func selectedDisplayModelID(for kind: ModelKind) -> String? {
        guard kind == .gemini else { return selectedModelID(for: kind) }
        return selectedModelID(for: .gemini).map { CLIModels.agySplit($0).base }
    }

    /// 지금 CLI 에 넘길 모델 id — 제미나이는 고른 묶음 + 생각 단계를 합친 id.
    /// 목록이 비면 nil(codex · opencode 는 `-m` 없이 CLI 기본 모델에 맡기고, agy 는 기본 모델 이름으로).
    public func selectedModelID(for kind: ModelKind) -> String? {
        guard kind == .gemini else {
            return CLIModels.resolve(kind: kind, selected: modelIDs[kind], in: modelChoices(for: kind))
        }
        let families = agyFamilies()
        guard !families.isEmpty else { return nil }
        if let saved = modelIDs[.gemini] {
            let split = CLIModels.agySplit(saved)
            if let fam = families.first(where: { $0.base == split.base }) {
                let level = efforts[.gemini] ?? split.level
                return CLIModels.agyModelID(family: fam, level: level)
            }
        }
        let defaultBase = CLIModels.agySplit(CommandBuilder.geminiModel).base
        let defaultFam = families.first(where: { $0.base == defaultBase }) ?? families[0]
        return CLIModels.agyModelID(family: defaultFam, level: efforts[.gemini])
    }

    /// 이 CLI · 모델이 받는 생각 단계 목록(비면 화면에서 생각 단계 고르기를 숨긴다).
    public func effortChoices(for kind: ModelKind) -> [String] {
        let modelID = selectedModelID(for: kind) ?? ""
        let codexEfforts = status?.state(.chatgpt).codexEfforts ?? [:]
        return CLIModels.effortChoices(kind: kind, modelID: modelID, codexEfforts: codexEfforts, agyFamilies: agyFamilies())
    }

    /// 지금 고른 생각 단계(nil 이면 「기본」 — 플래그를 붙이지 않는다).
    /// 옛 설정에 agy 모델 `gemini-4-neon-xhigh` 만 들어 있으면 `xhigh` 로 읽는다.
    public func selectedEffort(for kind: ModelKind) -> String? {
        let choices = effortChoices(for: kind)
        let candidate: String?
        if let saved = efforts[kind], !saved.isEmpty {
            candidate = saved
        } else if kind == .gemini, let savedModel = modelIDs[.gemini] {
            candidate = CLIModels.agySplit(savedModel).level
        } else {
            candidate = nil
        }
        guard let candidate else { return nil }
        if !choices.isEmpty && !choices.contains(candidate) { return nil }
        return candidate
    }

    /// 생각 단계를 바꾼다. `nil` 또는 빈 글은 「기본」(설정에서 키를 지운다).
    public func setEffort(_ level: String?, for kind: ModelKind) {
        let trimmed = level?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value = trimmed, !value.isEmpty else {
            efforts.removeValue(forKey: kind)
            if kind == .gemini, let cur = modelIDs[.gemini] {
                let base = CLIModels.agySplit(cur).base
                if base != cur { modelIDs[.gemini] = base }
            }
            persist { s in
                s.efforts.removeValue(forKey: kind.rawValue)
                if kind == .gemini, let cur = s.models[kind.rawValue] {
                    let base = CLIModels.agySplit(cur).base
                    if base != cur { s.models[kind.rawValue] = base }
                }
            }
            return
        }
        guard CLIModels.isSafeID(value) else { return }
        let choices = effortChoices(for: kind)
        guard choices.isEmpty || choices.contains(value) else { return }
        efforts[kind] = value
        persist { $0.efforts[kind.rawValue] = value }
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
        if kind == .gemini {
            let validRaw = modelChoices(for: .gemini).contains(where: { $0.id == id })
            let validFamily = agyFamilies().contains(where: { $0.base == id })
            guard validRaw || validFamily else { return }
            modelIDs[.gemini] = id
            persist { $0.models[kind.rawValue] = id }
            return
        }
        guard modelChoices(for: kind).contains(where: { $0.id == id }) else { return }
        modelIDs[kind] = id
        persist { $0.models[kind.rawValue] = id }
    }

    /// 제미나이 상태 읽기는 늘 자동으로 한다(평소 키체인 로그인 + `--gemini_dir`).
    public var agyAutoRead: Bool { true }

    /// 옆 창을 열 때 · CLI 칩을 바꿀 때 — 그 CLI 의 상태 · 목록 · 남은 양을 읽는다(5분 안이면 읽지 않음, 메인 밖).
    public func refreshStatus(for kind: ModelKind) async {
        await status?.refreshForPanel(selected: kind)
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
        guard let m = messages.last(where: { $0.card == nil && $0.role == .assistant }),
              !m.isStreaming, m.error == nil else { return nil }
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

        let chosenModelID = selectedModelID(for: model)
        let chosenEffort = model == .gemini ? nil : selectedEffort(for: model)
        let job = Job(question: question, model: model,
                      history: makeHistory(), sessionID: model == .claude ? claudeSessionID : nil,
                      userID: newID(), answerID: newID(), generation: generation,
                      modelID: chosenModelID, effort: chosenEffort)
        messages.append(ChatMessage(id: job.userID, role: .user, text: question))
        messages.append(ChatMessage(id: job.answerID, role: .assistant, model: model, isStreaming: true))
        isRunning = true
        let t = Task { [self] in await perform(job) }
        task = t
        return t
    }

    /// 허락 카드에 답한다. 이미 답했거나 없는 카드이거나 그 카드에 맞지 않는 답이면 false.
    @discardableResult
    public func answerCard(id: UUID, _ answer: AgentAnswer) -> Bool {
        guard let index = messages.firstIndex(where: { $0.cardID == id }), messages[index].isPendingCard,
              let waiter = waiters[id], let card = messages[index].card else { return false }
        switch answer {
        case .approve, .reject:
            break
        case .alwaysAllowSite:
            // 빨간 동작 카드와 코드 카드는 「늘 허락」 을 받지 않는다.
            guard case .actionCard(_, _, _, _, let danger, _) = card, !danger else { return false }
        case .revise:
            return false
        }
        guard waiter.resolve(.answer(answer)) else { return false }
        closeCard(id, fallback: .answer(answer))
        return true
    }

    /// 답하는 중이면 멈춘다 — 기다리는 카드 모두 거절 · 관문 자리 해제 · 자식 프로세스 멈춤.
    public func stop() {
        guard isRunning else { return }
        isStopping = true
        resolveAllWaiters(.stopped)
        releaseActiveLease()
        task?.cancel()
        runner.stop()
    }

    /// 앱을 끝낼 때 — 기다리는 카드 거절 · 관문 자리 해제 · 돌고 있는 답 멈춤.
    public func shutdown() {
        if isRunning { isStopping = true }
        resolveAllWaiters(.stopped)
        releaseActiveLease()
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
        var history: [Turn]
        var sessionID: String?
        var userID: Int
        var answerID: Int
        var generation: Int
        var modelID: String?
        var effort: String?
    }

    private func perform(_ job: Job) async {
        let started = now()
        var page: PageContext?
        var outcome: RunOutcome = .stopped
        var turnSession: String?
        var lease: GateLease?
        defer {
            resolveAllWaiters(.stopped)
            if let lease { releaseActiveLease(matching: lease.id) }
        }

        if !Task.isCancelled {
            page = await readPage()
            if let page { setPageTitle(page, on: job.userID) }
        }

        if !Task.isCancelled {
            var safariTools: SafariTools?
            var effectiveLoginPath = loginPath

            if let gate = interactiveGate {
                if let acquired = gate.acquire(handler: { [weak self] req in
                    guard let self else { return .deny(GateServer.stoppedReason) }
                    return await self.handleGate(req, job: job)
                }) {
                    lease = acquired
                    activeLease = acquired
                    let prepared = await prepareSafariTools()
                    if Task.isCancelled {
                        finish(job, outcome: .stopped, page: page, session: nil, started: started)
                        return
                    }
                    if let cachedPath = prepared.path {
                        effectiveLoginPath = { cachedPath }
                    }
                    if let tools = prepared.tools {
                        safariTools = tools
                    } else {
                        // 도구를 못 켰으면 자리를 바로 풀어 다른 질문이 막히지 않게 한다.
                        releaseActiveLease(matching: acquired.id)
                        lease = nil
                        appendNotice(Self.nodeMissingNotice, on: job.answerID)
                    }
                } else {
                    let busy = gate.holder?.busyNotice ?? GateHolder.lease(UUID()).busyNotice
                    appendNotice(busy, on: job.answerID)
                }
            }

            let request = AskRequest(question: job.question, model: job.model,
                                     page: page, history: job.history, claudeSessionID: job.sessionID,
                                     modelID: job.modelID, effort: job.effort, safariTools: safariTools)
            // 가운데(안내 · 상한 · 로그인 확인 · CLI 실행 · 출력 읽기)는 페이지 패널 서버와 같이 쓰는 `AskFlow` — 단계는 순서대로 이 메인 액터에서 반영한다.
            let (stream, cont) = AsyncStream.makeStream(of: AskFlow.Step.self)
            let consumer = Task { [self] in
                var session: String?
                for await step in stream {
                    switch step {
                    case .notice(let n): appendNotice(n, on: job.answerID)
                    case .failure(let message): update(job.answerID) { $0.error = message }
                    case .event(let e): if let s = apply(e, to: job) { session = s }
                    }
                }
                return session
            }
            outcome = await AskFlow.run(request: request, runner: runner, loginPath: effectiveLoginPath,
                                        workDirectory: workDirectory, supportDirectory: supportDirectory,
                                        timeout: timeout,
                                        geminiLoggedOut: { [self] in await loginState(for: .gemini) == .loggedOut },
                                        emit: { cont.yield($0) })
            cont.finish()
            turnSession = await consumer.value
        }
        finish(job, outcome: outcome, page: page, session: turnSession, started: started)
    }

    /// 메인 밖에서 `run.sh` · Node 18+ · 기억 폴더(0700)를 확인해 `SafariTools` 를 만든다.
    private func prepareSafariTools() async -> (path: String?, tools: SafariTools?) {
        let loginPath = self.loginPath
        let supportDir = self.supportDirectory
        let workDir = self.workDirectory
        let resources = self.safariResources
        let nodeCheck = self.nodeCheck
        return await Task.detached(priority: .userInitiated) {
            let path = loginPath()
            guard let resources else { return (path, nil) }
            let runScript = resources.appendingPathComponent("safari-attraction/run.sh").path
            guard FileManager.default.fileExists(atPath: runScript), nodeCheck(path) else {
                return (path, nil)
            }
            let support: URL
            if let s = try? supportDir?() {
                support = s
            } else if let w = try? workDir() {
                support = w.deletingLastPathComponent()
            } else {
                return (path, nil)
            }
            let memoryHome = support.appendingPathComponent("memory", isDirectory: true)
            try? FileManager.default.createDirectory(at: memoryHome, withIntermediateDirectories: true,
                                                     attributes: [.posixPermissions: 0o700])
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: memoryHome.path)
            let tools = SafariTools(runScript: runScript,
                                    gateFile: GateLink.url(support: support).path,
                                    memoryHome: memoryHome.path)
            return (path, tools)
        }.value
    }

    // MARK: 동작 관문 요청 · 허락 카드

    private func handleGate(_ req: GateRequest, job: Job) async -> GateDecision {
        guard isRunning, !isStopping, generation == job.generation else {
            return .deny(GateServer.stoppedReason)
        }
        let outcome: PolicyOutcome
        if let siteModes {
            outcome = GateDecider.outcome(req, siteModes: siteModes)
        } else {
            outcome = ActionPolicy.decide(phase: .executing, mode: .ask, action: req.action, irreversible: req.irreversible)
        }
        switch outcome {
        case .allow:
            activity = AgentActionLabel.progress(host: req.host, action: req.action, target: req.target)
            return .allow
        case .deny(let reason):
            return .deny(reason)
        case .card(let danger):
            let content: AgentMessageContent = req.action == "code"
                ? .codeCard(code: req.value, state: .pending)
                : .actionCard(host: req.host, action: req.action, target: req.target, value: req.value, danger: danger, state: .pending)
            let (cardID, waiter) = openCard(content, before: job.answerID)
            let waitStart = now()
            activity = Self.waitingCardActivity
            let resolution = await waiter.waitHonoringCancellation()
            let waited = max(0, now().timeIntervalSince(waitStart))
            if waited > 0 { runner.extendDeadline(by: waited) }
            closeCard(cardID, fallback: resolution)
            switch resolution {
            case .answer(.approve):
                if isRunning && !isStopping && generation == job.generation {
                    activity = AgentActionLabel.progress(host: req.host, action: req.action, target: req.target)
                }
                return .allow
            case .answer(.alwaysAllowSite):
                if let siteModes {
                    do { try siteModes.setMode(.allowAll, for: req.host) }
                    catch { appendNotice("이 사이트 허락을 저장하지 못했어요 — 이번 한 번만 허락했어요", on: job.answerID) }
                }
                if isRunning && !isStopping && generation == job.generation {
                    activity = AgentActionLabel.progress(host: req.host, action: req.action, target: req.target)
                }
                return .allow
            case .answer:
                return .deny(AgentSession.cardRejectedReason)
            case .timedOut:
                return .deny(AgentSession.cardExpiredReason)
            case .stopped:
                return .deny(GateServer.stoppedReason)
            case .withdrawn:
                return .deny(AgentSession.cardRejectedReason)
            }
        }
    }

    private func openCard(_ content: AgentMessageContent, before answerID: Int) -> (id: UUID, waiter: CardWaiter) {
        let cardID = UUID()
        let msg = ChatMessage(id: newID(), role: .assistant, cardID: cardID, card: content)
        if let idx = messages.firstIndex(where: { $0.id == answerID }) {
            messages.insert(msg, at: idx)
        } else {
            messages.append(msg)
        }
        let waiter = CardWaiter()
        waiters[cardID] = waiter
        let sleep = self.sleep
        let cardTimeout = self.cardTimeout
        cardTimers[cardID] = Task {
            do { try await sleep(cardTimeout) } catch { return }
            waiter.resolve(.timedOut)
        }
        return (cardID, waiter)
    }

    private func closeCard(_ id: UUID, fallback: CardWaiter.Resolution) {
        let resolution = waiters[id]?.current ?? fallback
        waiters[id] = nil
        cardTimers[id]?.cancel()
        cardTimers[id] = nil
        guard let i = messages.firstIndex(where: { $0.cardID == id }), messages[i].isPendingCard else { return }
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

    private func releaseActiveLease(matching id: UUID? = nil) {
        guard let lease = activeLease else { return }
        if let id, lease.id != id { return }
        activeLease = nil
        lease.release()
    }

    private func notifyPendingCardChange() {
        let now = hasPendingCard
        guard now != lastNotifiedPending else { return }
        lastNotifiedPending = now
        onPendingCardChange?(now)
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

    /// 지금 보고 있는 사파리 탭을 보내는 순간에 한 번 읽는다. 사파리 창이 없거나 일반 웹 페이지가 아니면 조용히 뺀다.
    private func readPage() async -> PageContext? {
        if let until = pageBlockedUntil, now() < until {
            return nil
        }
        let bridge = self.bridge
        let result = await Task.detached(priority: .userInitiated) { bridge.frontTab() }.value
        switch result {
        case .success(let reading):
            let trimmed = reading.page.url.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty,
                  let scheme = URL(string: trimmed)?.scheme?.lowercased(),
                  scheme == "http" || scheme == "https" else {
                return nil
            }
            if reading.selectionIssue == .javaScriptDisabled {
                hint = SafariBridgeError.javaScriptDisabled.hint
            }
            return reading.page
        case .failure(.automationDenied):
            pageBlockedUntil = now().addingTimeInterval(Self.pageReadBackoff)
            hint = SafariBridgeError.automationDenied.hint
            return nil
        case .failure(.timedOut):
            hint = SafariBridgeError.timedOut.hint
            return nil
        case .failure(.notRunning), .failure(.noWindow), .failure(.javaScriptDisabled), .failure(.failed):
            return nil
        }
    }

    private func setPageTitle(_ page: PageContext, on id: Int) {
        let title = page.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = title.isEmpty ? (URL(string: page.url)?.host ?? page.url) : title
        update(id) { $0.pageTitle = label }
    }

    private func appendNotice(_ text: String, on id: Int) {
        update(id) { m in
            if let existing = m.notice, !existing.isEmpty {
                m.notice = existing + "\n" + text
            } else {
                m.notice = text
            }
        }
    }

    // MARK: 도우미

    private func newID() -> Int { nextID += 1; return nextID }

    /// 말풍선(카드 제외)은 늘 (질문, 답) 짝으로 쌓인다. 답이 오류 없이 글이 있는 짝만 앞 대화로 쓴다.
    private func makeHistory() -> [Turn] {
        let chat = messages.filter { $0.card == nil }
        var turns: [Turn] = []
        var i = 0
        while i + 1 < chat.count {
            let q = chat[i], a = chat[i + 1]
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
