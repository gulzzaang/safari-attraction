import Foundation

/// 일 맡기기의 단계 — 계획을 승인받기 전(planning)에는 읽기만, 승인 뒤(executing)에는 사이트 모드를 따른다.
public enum AgentPhase: Sendable, Equatable {
    case planning
    case executing
}

/// 판정표의 결과 — 바로 허락 · 거절(한국어 이유) · 카드를 띄워 사람에게 묻기(danger = 빨간 줄).
public enum PolicyOutcome: Sendable, Equatable {
    case allow
    case deny(String)
    case card(danger: Bool)
}

/// 동작 관문 판정표(순수 함수). 계획 8 Global Constraints 의 표 그대로.
///
/// - 이동(goto · nav)은 늘 허락(읽기일 뿐이고, 가는 곳의 동작은 그 사이트의 모드가 따로 막는다).
/// - 계획 승인 전: 나머지 모든 동작 거절.
/// - 승인 뒤 읽기만: 거절. 묻고 하기: 카드(되돌릴 수 없음 · 모름이면 빨간 줄). 다 허락: 허락, 되돌릴 수 없음(true)만 빨간 카드.
public enum ActionPolicy {
    public static let planningReason = "계획 승인 전이라 읽기만 돼요"
    public static let readOnlyReason = "이 사이트는 읽기만 허락했어요"

    /// 서버가 보내는 이동 동작 이름(소문자 그대로만).
    static let navigationActions: Set<String> = ["goto", "nav"]

    public static func decide(phase: AgentPhase, mode: SiteMode, action: String, irreversible: Bool?) -> PolicyOutcome {
        if navigationActions.contains(action) { return .allow }
        if phase == .planning { return .deny(planningReason) }
        switch mode {
        case .readOnly:
            return .deny(readOnlyReason)
        case .ask:
            return .card(danger: irreversible != false)
        case .allowAll:
            return irreversible == true ? .card(danger: true) : .allow
        }
    }
}
