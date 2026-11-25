import XCTest
@testable import AppCore

final class ActionPolicyTests: XCTestCase {
    private let planningReason = "계획 승인 전이라 읽기만 돼요"
    private let readOnlyReason = "이 사이트는 읽기만 허락했어요"
    private let changing = ["click", "fill", "check", "uncheck", "select", "press", "type", "evaluate", "fetch"]

    func testReasonsAreTheKoreanSentencesFromThePlan() {
        XCTAssertEqual(ActionPolicy.planningReason, planningReason)
        XCTAssertEqual(ActionPolicy.readOnlyReason, readOnlyReason)
    }

    // 계획 승인 전: 모든 동작 거절(모드 · 되돌릴 수 없음과 상관없이), 이동만 늘 허락
    func testPlanningDeniesEveryChangingActionInEveryModeAndIrreversibility() {
        for mode in SiteMode.allCases {
            for action in changing {
                for irr in [true, false, nil] as [Bool?] {
                    XCTAssertEqual(ActionPolicy.decide(phase: .planning, mode: mode, action: action, irreversible: irr),
                                   .deny(planningReason), "\(mode) \(action) \(String(describing: irr))")
                }
            }
        }
    }

    func testNavigationIsAlwaysAllowed() {
        for phase in [AgentPhase.planning, .executing] {
            for mode in SiteMode.allCases {
                for action in ["goto", "nav"] {
                    for irr in [true, false, nil] as [Bool?] {
                        XCTAssertEqual(ActionPolicy.decide(phase: phase, mode: mode, action: action, irreversible: irr),
                                       .allow, "\(phase) \(mode) \(action)")
                    }
                }
            }
        }
    }

    // 승인 뒤 · 읽기만: 전부 거절
    func testExecutingReadOnlyDeniesEverything() {
        for action in changing {
            for irr in [true, false, nil] as [Bool?] {
                XCTAssertEqual(ActionPolicy.decide(phase: .executing, mode: .readOnly, action: action, irreversible: irr),
                               .deny(readOnlyReason), "\(action) \(String(describing: irr))")
            }
        }
    }

    // 승인 뒤 · 묻고 하기: 되돌릴 수 있으면 보통 카드, 되돌릴 수 없음 · 모름은 빨간 카드
    func testExecutingAskGivesCardsAndRedWhenIrreversibleOrUnknown() {
        for action in changing {
            XCTAssertEqual(ActionPolicy.decide(phase: .executing, mode: .ask, action: action, irreversible: false), .card(danger: false), action)
            XCTAssertEqual(ActionPolicy.decide(phase: .executing, mode: .ask, action: action, irreversible: true), .card(danger: true), action)
            XCTAssertEqual(ActionPolicy.decide(phase: .executing, mode: .ask, action: action, irreversible: nil), .card(danger: true), action)
        }
    }

    // 승인 뒤 · 다 허락: 되돌릴 수 있으면 · 모르면 허락, 되돌릴 수 없음만 빨간 카드
    func testExecutingAllowAll() {
        for action in changing {
            XCTAssertEqual(ActionPolicy.decide(phase: .executing, mode: .allowAll, action: action, irreversible: false), .allow, action)
            XCTAssertEqual(ActionPolicy.decide(phase: .executing, mode: .allowAll, action: action, irreversible: nil), .allow, action)
            XCTAssertEqual(ActionPolicy.decide(phase: .executing, mode: .allowAll, action: action, irreversible: true), .card(danger: true), action)
        }
    }

    func testUnknownActionNamesAreTreatedLikeAChangingAction() {
        XCTAssertEqual(ActionPolicy.decide(phase: .planning, mode: .allowAll, action: "teleport", irreversible: false), .deny(planningReason))
        XCTAssertEqual(ActionPolicy.decide(phase: .executing, mode: .readOnly, action: "teleport", irreversible: false), .deny(readOnlyReason))
        XCTAssertEqual(ActionPolicy.decide(phase: .executing, mode: .ask, action: "teleport", irreversible: false), .card(danger: false))
        XCTAssertEqual(ActionPolicy.decide(phase: .executing, mode: .allowAll, action: "", irreversible: nil), .allow)
        // 대소문자가 다른 이동 이름은 이동이 아니다(서버는 소문자만 보낸다)
        XCTAssertEqual(ActionPolicy.decide(phase: .planning, mode: .allowAll, action: "GOTO", irreversible: false), .deny(planningReason))
    }

    func testCodeActionIsDangerCardInEveryMode() {
        for mode in SiteMode.allCases {
            for irr in [true, false, nil] as [Bool?] {
                XCTAssertEqual(ActionPolicy.decide(phase: .executing, mode: mode, action: "code", irreversible: irr),
                               .card(danger: true), "\(mode) \(String(describing: irr))")
                XCTAssertEqual(ActionPolicy.decide(phase: .planning, mode: mode, action: "code", irreversible: irr),
                               .deny(planningReason), "planning \(mode)")
            }
        }
    }
}
