import XCTest
@testable import AppCore

final class RoutinePolicyTests: XCTestCase {
    let sites = ["coupang.com", "naver.com"]

    func decide(_ action: String, host: String = "www.coupang.com", irreversible: Bool? = false,
                method: String? = nil, sites: [String]? = nil) -> GateDecision {
        RoutinePolicy.decide(action: action, host: host, irreversible: irreversible, method: method, sites: sites ?? self.sites)
    }

    func testReadActionsOnListedSitesAreAllowed() {
        for action in ["open", "goto", "nav"] {
            XCTAssertEqual(decide(action), .allow, action)
        }
        XCTAssertEqual(decide("fetch", method: "GET"), .allow)
        XCTAssertEqual(decide("fetch", method: "HEAD"), .allow)
        XCTAssertEqual(decide("fetch", method: nil), .allow)
        XCTAssertEqual(decide("fetch", method: "get"), .allow)
    }

    func testSubdomainsAndCaseOfListedSitesAreAllowed() {
        XCTAssertEqual(decide("goto", host: "coupang.com"), .allow)
        XCTAssertEqual(decide("goto", host: "m.coupang.com"), .allow)
        XCTAssertEqual(decide("goto", host: "WWW.Coupang.COM."), .allow)
    }

    func testHostsOutsideTheListAreDeniedForEveryAction() {
        for action in ["open", "goto", "nav", "fetch", "click"] {
            XCTAssertEqual(decide(action, host: "evil.com"), .deny(RoutinePolicy.notAllowedSiteReason), action)
        }
        XCTAssertEqual(decide("goto", host: "evilcoupang.com"), .deny(RoutinePolicy.notAllowedSiteReason))
        XCTAssertEqual(decide("goto", host: "coupang.com.evil.com"), .deny(RoutinePolicy.notAllowedSiteReason))
    }

    func testEmptyOrOddHostsAreDenied() {
        XCTAssertEqual(decide("goto", host: ""), .deny(RoutinePolicy.notAllowedSiteReason))
        XCTAssertEqual(decide("goto", host: "   "), .deny(RoutinePolicy.notAllowedSiteReason))
        XCTAssertEqual(decide("goto", host: "coupang.com:8080"), .deny(RoutinePolicy.notAllowedSiteReason))
        XCTAssertEqual(decide("goto", host: "coupang.com@evil.com"), .deny(RoutinePolicy.notAllowedSiteReason))
    }

    func testEmptyListDeniesEverything() {
        XCTAssertEqual(decide("goto", sites: []), .deny(RoutinePolicy.notAllowedSiteReason))
        XCTAssertEqual(decide("goto", sites: ["com", "co.kr"]), .deny(RoutinePolicy.notAllowedSiteReason))
    }

    func testWritingActionsAreDeniedEvenOnListedSites() {
        for action in ["click", "fill", "check", "uncheck", "select", "press", "type", "evaluate", "Goto", "GOTO", "", "something"] {
            XCTAssertEqual(decide(action, irreversible: false), .deny(RoutinePolicy.readOnlyReason), action)
        }
        XCTAssertEqual(decide("evaluate", irreversible: nil), .deny(RoutinePolicy.readOnlyReason))
        XCTAssertEqual(decide("click", irreversible: true), .deny(RoutinePolicy.readOnlyReason))
    }

    func testFetchThatChangesThingsIsDenied() {
        XCTAssertEqual(decide("fetch", irreversible: true, method: "POST"), .deny(RoutinePolicy.readOnlyReason))
        XCTAssertEqual(decide("fetch", irreversible: false, method: "POST"), .deny(RoutinePolicy.readOnlyReason))
        XCTAssertEqual(decide("fetch", irreversible: true, method: "GET"), .deny(RoutinePolicy.readOnlyReason))
        XCTAssertEqual(decide("fetch", irreversible: nil, method: "GET"), .deny(RoutinePolicy.readOnlyReason))
        XCTAssertEqual(decide("fetch", irreversible: false, method: "DELETE"), .deny(RoutinePolicy.readOnlyReason))
    }

    func testIrreversibleNavigationIsDenied() {
        for action in ["open", "goto", "nav"] {
            XCTAssertEqual(decide(action, irreversible: true), .deny(RoutinePolicy.readOnlyReason), action)
        }
    }

    func testFetchMethodIsReadFromTheTargetWhenTheServerSendsItThatWay() {
        XCTAssertEqual(RoutinePolicy.fetchMethod(fromTarget: "GET https://www.coupang.com/x"), "GET")
        XCTAssertEqual(RoutinePolicy.fetchMethod(fromTarget: "post https://a.com/"), "POST")
        XCTAssertNil(RoutinePolicy.fetchMethod(fromTarget: ""))
    }

    func testPromptPrefixIsExactlyTheDesign() {
        XCTAssertEqual(RoutinePolicy.promptPrefix(sites: ["coupang.com", "naver.com"]),
                       "사람 없이 도는 루틴이에요. 읽기만 할 수 있고 누르기 · 입력은 거절돼요. 갈 수 있는 사이트: coupang.com, naver.com. 되묻지 말고 읽은 것을 정리해 답하세요.\n\n")
    }

    func testTimeoutIs600Seconds() {
        XCTAssertEqual(RoutinePolicy.timeout, 600)
    }
}
