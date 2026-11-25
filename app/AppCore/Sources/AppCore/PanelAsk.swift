import Foundation

/// 사파리 확장 패널이 보낸 지금 페이지 정보.
public struct PanelPage: Sendable, Equatable {
    public var title: String
    public var url: String
    public var selection: String
    public var text: String
    public init(title: String = "", url: String = "", selection: String = "", text: String = "") {
        self.title = title; self.url = url; self.selection = selection; self.text = text
    }
}

/// `POST /ask` 본문 — `{ question, page?: { title, url, selection, text } }` (`webSearch` 는 옛 확장 호환용으로 받아도 무시한다).
public struct PanelQuestion: Sendable, Equatable {
    public var question: String
    public var page: PanelPage?
    public var webSearch: Bool
    public init(question: String, page: PanelPage? = nil, webSearch: Bool = false) {
        self.question = question; self.page = page; self.webSearch = webSearch
    }

    /// 본문을 읽는다. 질문이 없거나 JSON 이 아니면 nil.
    public static func parse(_ body: Data) -> PanelQuestion? {
        guard let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              let q = obj["question"] as? String else { return nil }
        let question = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty else { return nil }
        var page: PanelPage?
        if let p = obj["page"] as? [String: Any] {
            page = PanelPage(title: p["title"] as? String ?? "", url: p["url"] as? String ?? "",
                             selection: p["selection"] as? String ?? "", text: p["text"] as? String ?? "")
        }
        return PanelQuestion(question: question, page: page, webSearch: obj["webSearch"] as? Bool ?? false)
    }
}

/// 질문 앞에 붙이는 페이지 머리 — 서버가 만든다(확장은 글만 보낸다).
public enum PanelPrompt {
    public static let selectionLimit = 2_000
    public static let textLimit = 4_000

    /// `[지금 사파리 탭]\n제목: …\n주소: …\n고른 글: …(2,000자 안)\n본문 앞부분: …(4,000자 안)\n\n` + 질문.
    /// 고른 글 · 본문이 비면 그 줄은 뺀다. 페이지가 없으면 질문만.
    public static func compose(_ q: PanelQuestion) -> String {
        guard let p = q.page else { return q.question }
        func oneLine(_ s: String) -> String {
            s.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        }
        var s = "[지금 사파리 탭]\n제목: \(oneLine(p.title))\n주소: \(oneLine(p.url))\n"
        let sel = p.selection.trimmingCharacters(in: .whitespacesAndNewlines)
        if !sel.isEmpty { s += "고른 글: \(String(sel.prefix(selectionLimit)))\n" }
        let text = p.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { s += "본문 앞부분: \(String(text.prefix(textLimit)))\n" }
        return s + "\n" + q.question
    }
}

/// `GET /info` 답 — 고른 CLI · 모델 · 생각 단계.
public struct PanelInfo: Sendable, Equatable {
    /// `ModelKind.rawValue`("claude" · "gemini" · "chatgpt" · "opencode").
    public var cli: String
    /// 화면에 보일 CLI 이름(옆 창 칩과 같은 이름).
    public var cliName: String
    /// 고른 모델의 화면 이름(목록에 없으면 id, 아무것도 못 정했으면 nil → JSON null).
    public var model: String?
    /// 고른 생각 단계의 한국어 이름(기본이면 nil → JSON null).
    public var effortLabel: String?
    /// 로그인돼 있으면 true, 안 돼 있으면 false, 아직 모르면 nil(JSON null).
    public var loggedIn: Bool?
    public init(cli: String, cliName: String, model: String?, effortLabel: String? = nil, loggedIn: Bool?) {
        self.cli = cli; self.cliName = cliName; self.model = model; self.effortLabel = effortLabel; self.loggedIn = loggedIn
    }

    public func jsonData() -> Data {
        let m: Any = model.map { $0 as Any } ?? NSNull()
        let e: Any = effortLabel.map { $0 as Any } ?? NSNull()
        let l: Any = loggedIn.map { $0 as Any } ?? NSNull()
        return PanelJSON.encode(["cli": cli, "cliName": cliName, "model": m, "effortLabel": e, "loggedIn": l])
    }
}

/// 페이지 패널에 띄우는 허락 카드 한 장 — `kind` 는 `"action"` · `"danger"` · `"code"`.
public struct PanelCard: Sendable, Equatable {
    public var id: String
    public var kind: String
    public var title: String
    public var detail: String
    public var host: String
    public var canAlwaysAllow: Bool

    public init(id: String, kind: String, title: String, detail: String, host: String, canAlwaysAllow: Bool) {
        self.id = id; self.kind = kind; self.title = title
        self.detail = detail; self.host = host; self.canAlwaysAllow = canAlwaysAllow
    }

    /// 관문 요청과 위험 여부로부터 패널 카드 한 장을 만든다.
    public static func from(id: String, request req: GateRequest, danger: Bool) -> PanelCard {
        if req.action == "code" {
            return PanelCard(id: id, kind: "code", title: "이 코드를 실행해도 될까요?",
                             detail: req.value, host: req.host, canAlwaysAllow: false)
        }
        let noun = AgentActionLabel.noun(req.action)
        var parts = [noun]
        if !req.target.isEmpty { parts.append(req.target) }
        var detail = parts.joined(separator: " · ")
        if !req.value.isEmpty { detail += "\n값: \(req.value)" }
        let title: String
        if danger {
            title = req.action == "evaluate" ? "알 수 없는 페이지 코드" : "되돌릴 수 없어 보이는 일"
        } else {
            title = "사이트에서 할 일 — 허락할까요?"
        }
        return PanelCard(id: id, kind: danger ? "danger" : "action", title: title,
                         detail: detail, host: req.host, canAlwaysAllow: !danger)
    }
}

/// `POST /approve` 답 종류.
public enum PanelApproveAnswer: String, Sendable, Equatable {
    case allow
    case deny
    case always
}

/// `POST /approve` 본문 — `{"cardId": string, "answer": "allow"|"deny"|"always"}`.
public struct PanelApproveRequest: Sendable, Equatable {
    public var cardId: String
    public var answer: PanelApproveAnswer

    public init(cardId: String, answer: PanelApproveAnswer) {
        self.cardId = cardId; self.answer = answer
    }

    public static func parse(_ body: Data) -> PanelApproveRequest? {
        guard let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              let id = obj["cardId"] as? String,
              let raw = obj["answer"] as? String,
              let answer = PanelApproveAnswer(rawValue: raw) else { return nil }
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 100 else { return nil }
        return PanelApproveRequest(cardId: trimmed, answer: answer)
    }
}

/// `/ask` 응답의 한 줄(NDJSON) — `delta` · `status` · `card` · `card-closed` · `done` · `error`.
public enum PanelLine: Sendable, Equatable {
    case delta(String)
    case status(String)
    case card(PanelCard)
    case cardClosed(id: String, result: String)
    case done(TokenUsage?)
    case error(String)

    /// 끝에 줄바꿈이 붙은 한 줄 — `t` 가 맨 앞에 온다.
    public func ndjson() -> Data {
        let body: String
        switch self {
        case .delta(let text):
            body = "\"t\":\"delta\",\"text\":\(PanelJSON.string(text))"
        case .status(let text):
            body = "\"t\":\"status\",\"text\":\(PanelJSON.string(text))"
        case .card(let c):
            let obj: [String: Any] = [
                "id": c.id,
                "kind": c.kind,
                "title": c.title,
                "detail": c.detail,
                "host": c.host,
                "canAlwaysAllow": c.canAlwaysAllow,
            ]
            let cardJSON = String(decoding: PanelJSON.encode(obj), as: UTF8.self)
            body = "\"t\":\"card\",\"card\":\(cardJSON)"
        case .cardClosed(let id, let result):
            body = "\"t\":\"card-closed\",\"id\":\(PanelJSON.string(id)),\"result\":\(PanelJSON.string(result))"
        case .error(let message):
            body = "\"t\":\"error\",\"message\":\(PanelJSON.string(message))"
        case .done(let u):
            let usage: String
            if let u {
                let o: [String: Any] = ["input": u.input, "cachedInput": u.cachedInput, "output": u.output,
                                        "reasoning": u.reasoning, "total": u.total, "summary": u.summary]
                usage = String(decoding: PanelJSON.encode(o), as: UTF8.self)
            } else { usage = "null" }
            body = "\"t\":\"done\",\"usage\":\(usage)"
        }
        return Data(("{" + body + "}\n").utf8)
    }
}

enum PanelJSON {
    /// JSON 문자열 한 개(따옴표 포함).
    static func string(_ s: String) -> String {
        let d = (try? JSONSerialization.data(withJSONObject: s, options: [.fragmentsAllowed, .withoutEscapingSlashes])) ?? Data("\"\"".utf8)
        return String(decoding: d, as: UTF8.self)
    }
    static func encode(_ object: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data("{}".utf8)
    }
}

/// 서버가 부르는 두뇌.
public protocol PanelBackend: Sendable {
    func info() async -> PanelInfo
    /// 줄을 순서대로 `emit` 으로 내고 끝나면 돌아온다. 작업이 취소되면(손님이 끊음 · 서버가 멈춤) 실행기를 멈추고 서둘러 돌아온다.
    func ask(_ question: PanelQuestion, emit: @escaping @Sendable (PanelLine) -> Void) async
    /// 패널에서 허락 카드 단추를 눌렀을 때 — 카드를 찾아 답을 넘겼으면 true, 모르는 카드면 false(404).
    func approve(cardID: String, answer: PanelApproveAnswer) async -> Bool
}

public extension PanelBackend {
    func approve(cardID: String, answer: PanelApproveAnswer) async -> Bool { false }
}

/// 지금 고른 CLI · 모델 · 생각 단계(옆 창과 같은 값).
public struct PanelSelection: Sendable, Equatable {
    public var kind: ModelKind
    public var modelID: String?
    /// 화면에 보일 모델 이름(없으면 nil).
    public var modelName: String?
    public var login: CLILoginState
    /// 고른 생각 단계(기본이면 nil).
    public var effort: String?
    public init(kind: ModelKind, modelID: String?, modelName: String? = nil, login: CLILoginState = .unknown, effort: String? = nil) {
        self.kind = kind; self.modelID = modelID; self.modelName = modelName; self.login = login; self.effort = effort
    }
}

/// 페이지 패널의 한 칸 질문 — 옆 창과 같은 `AskFlow` · `InteractiveGate` · `GateDecider` 를 쓰되 질문마다 새 실행기로 돈다.
/// 사파리 도구 자리(`InteractiveGate.acquire`)를 얻은 질문의 관문 요청만 이 패널 스트림에 카드로 나가고 `/approve` 를 기다린다.
public final class PanelAskService: PanelBackend, @unchecked Sendable {
    public static let defaultCardTimeout: TimeInterval = 300
    public static let nodeMissingNotice = "사파리 도구를 못 켰어요(Node 18 이상 필요) — 답만 해요"
    public static let waitingCardActivity = "허락 기다리는 중 …"
    public static let cardRejectedReason = "카드에서 거절했어요"
    public static let cardExpiredReason = "시간이 지나 거절했어요"

    private let selection: @Sendable (_ waitForStatus: Bool) async -> PanelSelection
    private let runnerFactory: @Sendable () -> CommandRunning
    private let loginPath: @Sendable () -> String
    private let workDirectory: @Sendable () throws -> URL
    private let supportDirectory: (@Sendable () throws -> URL)?
    private let timeout: TimeInterval
    private let cardTimeout: TimeInterval
    private let geminiLoggedOut: @Sendable () async -> Bool
    private let onRateLimits: (@Sendable (UsageSnapshot) -> Void)?
    private let interactiveGate: InteractiveGate?
    private let siteModes: SiteModeStore?
    private let safariResources: URL?
    private let nodeCheck: @Sendable (String) -> Bool
    private let now: @Sendable () -> Date
    private let sleep: @Sendable (TimeInterval) async throws -> Void
    private let runningLock = NSLock()
    private var runningCount = 0

    private struct PendingCard {
        let askToken: UUID
        let waiter: CardWaiter
        let canAlwaysAllow: Bool
    }
    private let cardsLock = NSLock()
    private var pendingCards: [String: PendingCard] = [:]

    /// 도는 질문이 하나라도 있나 — `ask` 에 들어와서 나갈 때까지(손님이 끊거나 서버가 멈춰도 실행기가 정리돼 돌아올 때까지 true).
    /// 앱을 끌 때 정리를 기다리는 데 쓴다.
    public var isRunning: Bool { runningLock.withLock { runningCount > 0 } }

    /// 기본값을 두지 않는다 — 시험이 실제 폴더 · 로그인 셸에 닿지 않게 부르는 쪽이 다 넘긴다.
    /// `selection(waitForStatus)` — `/info` 는 `false`(기다리지 않고 지금 아는 값), 묻기는 `true`(모델 목록을 읽는 중이면 끝나길 기다린다).
    public init(selection: @escaping @Sendable (_ waitForStatus: Bool) async -> PanelSelection,
                runnerFactory: @escaping @Sendable () -> CommandRunning,
                loginPath: @escaping @Sendable () -> String,
                workDirectory: @escaping @Sendable () throws -> URL,
                supportDirectory: (@Sendable () throws -> URL)? = nil,
                timeout: TimeInterval = ProcessRunner.defaultTimeout,
                cardTimeout: TimeInterval = PanelAskService.defaultCardTimeout,
                geminiLoggedOut: @escaping @Sendable () async -> Bool,
                onRateLimits: (@Sendable (UsageSnapshot) -> Void)? = nil,
                interactiveGate: InteractiveGate? = nil,
                siteModes: SiteModeStore? = nil,
                safariResources: URL? = nil,
                nodeCheck: @escaping @Sendable (String) -> Bool = { NodeCheck.hasNode18(path: $0) },
                now: @escaping @Sendable () -> Date = { Date() },
                sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }) {
        self.selection = selection; self.runnerFactory = runnerFactory; self.loginPath = loginPath
        self.workDirectory = workDirectory; self.supportDirectory = supportDirectory; self.timeout = timeout
        self.cardTimeout = cardTimeout; self.geminiLoggedOut = geminiLoggedOut; self.onRateLimits = onRateLimits
        self.interactiveGate = interactiveGate; self.siteModes = siteModes; self.safariResources = safariResources
        self.nodeCheck = nodeCheck; self.now = now; self.sleep = sleep
    }

    public func info() async -> PanelInfo {
        let s = await selection(false)
        let loggedIn: Bool?
        switch s.login { case .loggedIn: loggedIn = true; case .loggedOut: loggedIn = false; case .unknown: loggedIn = nil }
        return PanelInfo(cli: s.kind.rawValue, cliName: s.kind.koreanName, model: s.modelName ?? s.modelID,
                         effortLabel: s.effort.map(Effort.label), loggedIn: loggedIn)
    }

    public func approve(cardID: String, answer: PanelApproveAnswer) async -> Bool {
        let entry: PendingCard? = cardsLock.withLock { pendingCards[cardID] }
        guard let entry else { return false }
        let mapped: AgentAnswer
        switch answer {
        case .allow: mapped = .approve
        case .deny: mapped = .reject
        case .always:
            guard entry.canAlwaysAllow else { return false }
            mapped = .alwaysAllowSite
        }
        return entry.waiter.resolve(.answer(mapped))
    }

    /// 한 질문 동안 모이는 것 — 실행기의 전용 큐에서 불리므로 잠근다.
    private final class Pending: @unchecked Sendable {
        private let lock = NSLock()
        private var hasText = false
        private(set) var error: String?
        private(set) var usage: TokenUsage?
        func setError(_ m: String) { lock.withLock { if error == nil { error = m } } }
        func setUsage(_ u: TokenUsage) { lock.withLock { usage = u } }
        /// 글이 이미 있었는지 알려 주고 있다고 표시한다.
        func markText() -> Bool { lock.withLock { let had = hasText; hasText = true; return had } }
        func hadText() -> Bool { lock.withLock { hasText } }
    }

    private final class LeaseBox: @unchecked Sendable {
        private let lock = NSLock()
        private var lease: GateLease?
        func set(_ l: GateLease?) { lock.withLock { lease = l } }
        func release() {
            let l: GateLease? = lock.withLock { let cur = lease; lease = nil; return cur }
            l?.release()
        }
    }

    public func ask(_ q: PanelQuestion, emit: @escaping @Sendable (PanelLine) -> Void) async {
        runningLock.withLock { runningCount += 1 }
        defer { runningLock.withLock { runningCount -= 1 } }
        let sel = await selection(true)
        if Task.isCancelled { return }
        let model = sel.kind
        let askToken = UUID()
        let runner = runnerFactory()   // 질문마다 새 실행기 — 옆 창 질문과 부딪히지 않는다
        let leaseBox = LeaseBox()
        defer {
            withdrawCards(for: askToken)
            leaseBox.release()
        }

        var safariTools: SafariTools?
        var effectiveLoginPath = loginPath

        if let gate = interactiveGate {
            let acquired: GateLease? = await MainActor.run {
                gate.acquire { [weak self] req in
                    guard let self else { return .deny(GateServer.stoppedReason) }
                    return await self.handleGate(req, askToken: askToken, runner: runner, emit: emit)
                }
            }
            if let acquired {
                leaseBox.set(acquired)
                let prepared = await prepareSafariTools()
                if Task.isCancelled { return }
                if let cachedPath = prepared.path {
                    effectiveLoginPath = { cachedPath }
                }
                if let tools = prepared.tools {
                    safariTools = tools
                } else {
                    leaseBox.release()
                    emit(.status(Self.nodeMissingNotice))
                }
            } else {
                let busy: String = await MainActor.run {
                    gate.holder?.busyNotice ?? GateHolder.lease(UUID()).busyNotice
                }
                emit(.status(busy))
            }
        }
        if Task.isCancelled { return }

        let chosenEffort = model == .gemini ? nil : sel.effort
        let request = AskRequest(question: PanelPrompt.compose(q), model: model,
                                 page: nil, history: [], claudeSessionID: nil,
                                 modelID: sel.modelID, effort: chosenEffort, safariTools: safariTools)
        let pending = Pending()
        let onRateLimits = self.onRateLimits
        let outcome = await withTaskCancellationHandler {
            await AskFlow.run(request: request, runner: runner, loginPath: effectiveLoginPath, workDirectory: workDirectory,
                              supportDirectory: supportDirectory, timeout: timeout, geminiLoggedOut: geminiLoggedOut) { step in
                switch step {
                case .notice(let n):
                    emit(.status(n))
                case .failure(let m):
                    pending.setError(m)
                case .event(let e):
                    switch e {
                    case .text(let t):
                        // 옆 창과 같게 — 클로드 · codex · opencode 는 말풍선 사이를 한 줄 띄운다. agy 는 받은 대로 이어 붙인다.
                        let had = pending.markText()
                        emit(.delta((model != .gemini && had ? "\n\n" : "") + t))
                    case .toolUse(let name):
                        emit(.status(ToolActivity.label(for: name)))
                    case .result(let isError, let text):
                        if isError { pending.setError(text.isEmpty ? "오류가 났어요" : text) }
                        else if !pending.hadText() && !text.isEmpty { _ = pending.markText(); emit(.delta(text)) }
                    case .error(let m): pending.setError(m)
                    case .usage(let u): pending.setUsage(u)
                    case .rateLimits(let snap): if model == .claude { onRateLimits?(snap) }
                    case .sessionID: break
                    }
                }
            }
        } onCancel: {
            self.withdrawCards(for: askToken)
            leaseBox.release()
            runner.stop()
        }
        // 손님이 끊었거나 서버가 멈췄다 — 아무에게도 안 보인다.
        if Task.isCancelled { return }
        if let message = pending.error { emit(.error(message)); return }
        if case .stopped = outcome { return }   // 앱이 꺼지는 중 등 — done 을 내지 않는다(확장은 「연결이 끊겼어요」)
        emit(.done(pending.usage))
    }

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

    private func handleGate(_ req: GateRequest, askToken: UUID, runner: CommandRunning,
                            emit: @escaping @Sendable (PanelLine) -> Void) async -> GateDecision {
        let outcome: PolicyOutcome
        if let siteModes {
            outcome = GateDecider.outcome(req, siteModes: siteModes)
        } else {
            outcome = ActionPolicy.decide(phase: .executing, mode: .ask, action: req.action, irreversible: req.irreversible)
        }
        switch outcome {
        case .allow:
            emit(.status(AgentActionLabel.progress(host: req.host, action: req.action, target: req.target)))
            return .allow
        case .deny(let reason):
            return .deny(reason)
        case .card(let danger):
            let cardID = UUID().uuidString
            let card = PanelCard.from(id: cardID, request: req, danger: danger)
            let waiter = CardWaiter()
            cardsLock.withLock {
                pendingCards[cardID] = PendingCard(askToken: askToken, waiter: waiter, canAlwaysAllow: card.canAlwaysAllow)
            }
            let sleep = self.sleep
            let cardTimeout = self.cardTimeout
            let timer = Task {
                do { try await sleep(cardTimeout) } catch { return }
                waiter.resolve(.timedOut)
            }
            emit(.card(card))
            emit(.status(Self.waitingCardActivity))
            let waitStart = now()
            let resolution = await waiter.waitHonoringCancellation()
            timer.cancel()
            _ = cardsLock.withLock { pendingCards.removeValue(forKey: cardID) }
            let waited = max(0, now().timeIntervalSince(waitStart))
            if waited > 0 { runner.extendDeadline(by: waited) }
            switch resolution {
            case .answer(.approve):
                emit(.cardClosed(id: cardID, result: "allowed"))
                emit(.status(AgentActionLabel.progress(host: req.host, action: req.action, target: req.target)))
                return .allow
            case .answer(.alwaysAllowSite):
                if let siteModes {
                    do { try siteModes.setMode(.allowAll, for: req.host) }
                    catch { emit(.status("이 사이트 허락을 저장하지 못했어요 — 이번 한 번만 허락했어요")) }
                }
                emit(.cardClosed(id: cardID, result: "allowed"))
                emit(.status(AgentActionLabel.progress(host: req.host, action: req.action, target: req.target)))
                return .allow
            case .answer:
                emit(.cardClosed(id: cardID, result: "denied"))
                return .deny(Self.cardRejectedReason)
            case .timedOut:
                emit(.cardClosed(id: cardID, result: "withdrawn"))
                return .deny(Self.cardExpiredReason)
            case .stopped, .withdrawn:
                emit(.cardClosed(id: cardID, result: "withdrawn"))
                return .deny(GateServer.stoppedReason)
            }
        }
    }

    private func withdrawCards(for askToken: UUID) {
        let targets: [CardWaiter] = cardsLock.withLock {
            var matched: [CardWaiter] = []
            for (id, entry) in pendingCards where entry.askToken == askToken {
                matched.append(entry.waiter)
                pendingCards.removeValue(forKey: id)
            }
            return matched
        }
        for w in targets { w.resolve(.withdrawn) }
    }
}


extension ChatViewModel {
    /// 페이지 패널이 쓸 「지금 고른 CLI · 모델 · 생각 단계」 — 옆 창과 같은 값(`model` · `selectedModelID` · `selectedEffort`).
    /// 모델 목록은 옆 창을 열 때 읽는 것이라, 페이지 패널만 쓰면 비어 있을 수 있다 — 그 CLI 의 상태 읽기를 시작한다(5분 안이면 읽지 않음).
    /// `waitForStatus` 가 true 면 읽는 중인 동안 최대 `maxWait` 초 기다린다(저장해 둔 모델이 목록에 없다고 버려지지 않게).
    /// 클로드는 모델 목록이 고정이라(묻기가 상태 읽기에 기대는 것이 없다) 기다리지 않는다 — 옆 창의 보내기도 기다리지 않는다.
    public func panelSelection(waitForStatus: Bool, maxWait: TimeInterval = 25) async -> PanelSelection {
        let kind = model
        if waitForStatus {
            guard kind != .claude else { return currentPanelSelection(kind) }
            await refreshStatus(for: kind)
            let deadline = Date().addingTimeInterval(maxWait)
            // 취소되면(손님이 끊음 · 서버가 멈춤) 바로 끝낸다 — 취소된 `Task.sleep` 은 곧바로 돌아와 메인 액터에서 바쁜 루프가 된다.
            while status?.state(kind).isRefreshing == true, Date() < deadline, !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 100_000_000) } catch { break }
            }
        } else if status != nil {
            Task { [self] in await refreshStatus(for: kind) }   // 기다리지 않는다 — 열자마자 보이는 이름이 늦지 않게
        }
        return currentPanelSelection(kind)
    }

    private func currentPanelSelection(_ kind: ModelKind) -> PanelSelection {
        let id = selectedModelID(for: kind)
        let name: String?
        if kind == .gemini {
            name = selectedDisplayModelID(for: .gemini) ?? id
        } else {
            name = id.flatMap { id in modelChoices(for: kind).first { $0.id == id }?.label } ?? id
        }
        return PanelSelection(kind: kind, modelID: id, modelName: name, login: loginState(for: kind), effort: selectedEffort(for: kind))
    }
}
