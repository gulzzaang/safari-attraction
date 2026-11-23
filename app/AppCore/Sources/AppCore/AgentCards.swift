import Foundation

/// 카드 하나의 상태 — 처음엔 `pending`(사람의 답을 기다림), 답이 오면 바뀌고 다시 바뀌지 않는다.
public enum AgentCardState: Sendable, Equatable {
    case pending
    /// 사람이 허락했다(계획 승인 · 동작 허락 · 코드 허락).
    case approved
    /// 「이 사이트 늘 허락」 — 저장하고 허락했다.
    case alwaysAllowed
    /// 사람이 거절했다(계획 카드의 「그만」 포함).
    case rejected
    /// 계획 카드에서 「고쳐 줘」 — 사람이 쓴 글이 클로드에게 갔다.
    case revised(String)
    /// 300초 안에 답이 없어 거절했다.
    case expired
    /// 멈춤 · 일이 끝남으로 거절했다.
    case stopped
    /// 클로드나 관문 손님이 물음을 거뒀다(취소 요청 · 연결 끊김).
    case withdrawn

    public var isPending: Bool { self == .pending }
}

/// 화면이 카드에 보내는 답.
public enum AgentAnswer: Sendable, Equatable {
    case approve
    case reject
    /// 계획 카드 전용 — 고쳐 달라는 글.
    case revise(String)
    /// 동작 카드 전용 — 이 사이트를 「다 허락」 으로 저장하고 이번 동작도 허락.
    case alwaysAllowSite
}

/// 대화 목록의 한 칸 — 사람 글 · 클로드 글 · 안내 · 오류 · 카드 셋(계획 · 동작 · 코드).
public enum AgentMessageContent: Sendable, Equatable {
    case user(String)
    case assistant(String)
    /// 회색 한 줄(「멈췄어요」 · 「15분이 지나 멈췄어요」).
    case notice(String)
    /// 빨간 한 줄.
    case error(String)
    /// 작업 목록 승인 카드 — 클로드가 낸 계획(마크다운).
    case planCard(markdown: String, state: AgentCardState)
    /// 페이지를 바꾸는 동작 카드. `danger` 면 빨간 줄(되돌릴 수 없음 · 알 수 없음).
    case actionCard(host: String, action: String, target: String, value: String, danger: Bool, state: AgentCardState)
    /// 클로드가 짠 코드를 실행해도 되는지 묻는 빨간 카드(덧막이 낱말이 든 `repl` 코드).
    case codeCard(code: String, state: AgentCardState)
}

public struct AgentMessage: Identifiable, Equatable, Sendable {
    /// 카드의 id 도 이것 — `AgentSession.answer(cardID:_:)` 에 넘긴다.
    public let id: Int
    public var content: AgentMessageContent

    public init(id: Int, content: AgentMessageContent) {
        self.id = id; self.content = content
    }

    /// 카드면 그 상태(카드가 아니면 nil).
    public var cardState: AgentCardState? {
        switch content {
        case .planCard(_, let s), .actionCard(_, _, _, _, _, let s), .codeCard(_, let s): return s
        default: return nil
        }
    }

    var isPendingCard: Bool { cardState?.isPending ?? false }

    mutating func setCardState(_ s: AgentCardState) {
        switch content {
        case .planCard(let md, _): content = .planCard(markdown: md, state: s)
        case .actionCard(let h, let a, let t, let v, let d, _):
            content = .actionCard(host: h, action: a, target: t, value: v, danger: d, state: s)
        case .codeCard(let c, _): content = .codeCard(code: c, state: s)
        default: break
        }
    }
}

/// 카드 하나의 답을 기다리는 문 — 먼저 오는 한 가지가 이긴다(사람의 답 · 시간 초과 · 멈춤 · 거둠).
/// 어느 스레드에서 불러도 되고, `wait` 전에 `resolve` 가 와도 잃지 않는다.
final class CardWaiter: @unchecked Sendable {
    enum Resolution: Sendable, Equatable {
        case answer(AgentAnswer)
        case timedOut
        case stopped
        case withdrawn
    }

    private let lock = NSLock()
    private var result: Resolution?
    private var continuation: CheckedContinuation<Resolution, Never>?

    /// 이미 정해진 결과(아직이면 nil).
    var current: Resolution? { lock.withLock { result } }

    /// 처음 부른 `resolve` 면 true.
    @discardableResult
    func resolve(_ r: Resolution) -> Bool {
        lock.lock()
        if result != nil { lock.unlock(); return false }
        result = r
        let c = continuation
        continuation = nil
        lock.unlock()
        c?.resume(returning: r)
        return true
    }

    func wait() async -> Resolution {
        await withCheckedContinuation { (c: CheckedContinuation<Resolution, Never>) in
            lock.lock()
            if let r = result { lock.unlock(); c.resume(returning: r); return }
            continuation = c
            lock.unlock()
        }
    }

    /// 작업이 취소되면(관문 손님이 끊음) 거둔 것으로 풀린다.
    func waitHonoringCancellation() async -> Resolution {
        await withTaskCancellationHandler { await wait() } onCancel: { self.resolve(.withdrawn) }
    }
}
