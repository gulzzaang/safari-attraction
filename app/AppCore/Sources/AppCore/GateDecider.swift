import Foundation

/// 동작 관문 요청의 정책 판정 — 옆 창(`ChatViewModel`) · 페이지 패널 · 루틴(`AgentSession`)이 함께 쓴다.
public enum GateDecider {
    /// 한 칸 질문(옆 창 · 페이지 패널)은 계획 승인 단계가 없으므로 늘 `executing` 으로 판정한다.
    public static func outcome(_ req: GateRequest, siteModes: SiteModeStore) -> PolicyOutcome {
        outcome(req, siteModes: siteModes, phase: .executing)
    }

    /// 단계를 지정한 판정(`AgentSession` 호환용).
    public static func outcome(_ req: GateRequest, siteModes: SiteModeStore, phase: AgentPhase) -> PolicyOutcome {
        let mode = siteModes.mode(for: req.host)
        return ActionPolicy.decide(phase: phase, mode: mode, action: req.action, irreversible: req.irreversible)
    }
}
