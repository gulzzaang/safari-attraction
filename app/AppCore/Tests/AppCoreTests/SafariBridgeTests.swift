import XCTest
import AppCore

final class SafariBridgeErrorTests: XCTestCase {
    func testClassifyByNumber() {
        XCTAssertEqual(SafariBridgeError.classify(number: -1743, message: "x"), .automationDenied)
        XCTAssertEqual(SafariBridgeError.classify(number: -1744, message: "x"), .automationDenied)
        XCTAssertEqual(SafariBridgeError.classify(number: -600, message: "x"), .notRunning)
        XCTAssertEqual(SafariBridgeError.classify(number: -1728, message: "x"), .noWindow)
        XCTAssertEqual(SafariBridgeError.classify(number: -1719, message: "x"), .noWindow)
        XCTAssertEqual(SafariBridgeError.classify(number: -1712, message: "x"), .timedOut)
    }
    func testUnknownKeepsNumberAndMessage() {
        XCTAssertEqual(SafariBridgeError.classify(number: -9999, message: "boom"), .failed(number: -9999, message: "boom"))
    }
    func testJavaScriptDisabledMessageDetected() {
        let m = "Safari에서 오류 발생: Allow JavaScript from Apple Events in the Develop menu"
        XCTAssertEqual(SafariBridgeError.classify(number: 8, message: m, whileRunningJavaScript: true), .javaScriptDisabled)
        // 영어 문구가 아니어도(현지화) 숫자 없이 JavaScript + Apple 이벤트 문구면 잡는다.
        XCTAssertEqual(SafariBridgeError.classify(number: 8, message: "Apple 이벤트의 JavaScript 허용 필요", whileRunningJavaScript: true), .javaScriptDisabled)
    }
    func testOtherJavaScriptFailureIsNotTheDisabledReason() {
        XCTAssertEqual(SafariBridgeError.classify(number: -10006, message: "boom", whileRunningJavaScript: true),
                       .failed(number: -10006, message: "boom"))
    }
    func testDeniedStaysDeniedEvenForJavaScript() {
        XCTAssertEqual(SafariBridgeError.classify(number: -1743, message: "", whileRunningJavaScript: true), .automationDenied)
    }
    func testEveryReasonHasKoreanHint() {
        let all: [SafariBridgeError] = [.automationDenied, .javaScriptDisabled, .notRunning, .noWindow, .timedOut, .failed(number: 1, message: "m")]
        for e in all {
            XCTAssertFalse(e.hint.isEmpty)
            XCTAssertTrue(e.hint.unicodeScalars.contains { (0xAC00...0xD7A3).contains($0.value) }, "한국어 아님: \(e.hint)")
        }
        XCTAssertTrue(SafariBridgeError.automationDenied.hint.contains("자동화"))
    }
}

final class PageAttachmentTests: XCTestCase {
    let page = PageContext(title: "T", url: "https://a.example", selection: "고른 글")

    func testSuccessAttachesPage() {
        let a = PageAttachment.resolve(.success(TabReading(page: page)))
        XCTAssertEqual(a.page, page); XCTAssertNil(a.hint); XCTAssertFalse(a.turnOffToggle)
    }
    func testAutomationDeniedTurnsOffWithHint() {
        let a = PageAttachment.resolve(.failure(.automationDenied))
        XCTAssertNil(a.page); XCTAssertTrue(a.turnOffToggle)
        XCTAssertEqual(a.hint, SafariBridgeError.automationDenied.hint)
    }
    func testSafariNotRunningTurnsOffWithHint() {
        let a = PageAttachment.resolve(.failure(.notRunning))
        XCTAssertNil(a.page); XCTAssertTrue(a.turnOffToggle); XCTAssertNotNil(a.hint)
    }
    func testPendingConsentPromptSaysWaitingAndKeepsToggle() {
        let a = PageAttachment.resolve(.failure(.timedOut))
        XCTAssertNil(a.page); XCTAssertFalse(a.turnOffToggle)
        XCTAssertEqual(a.hint, "사파리 허락을 기다리는 중이에요 — 맥이 띄운 허락 창에서 허용을 눌러 주세요.")
    }
    func testEmptyURLIsTreatedAsNoPage() {
        let a = PageAttachment.resolve(.success(TabReading(page: PageContext(title: "시작 페이지", url: ""))))
        XCTAssertNil(a.page); XCTAssertFalse(a.turnOffToggle); XCTAssertNotNil(a.hint)
    }
    func testJavaScriptOffKeepsTitleAndURLButExplains() {
        let p = PageContext(title: "T", url: "https://a.example", selection: nil)
        let a = PageAttachment.resolve(.success(TabReading(page: p, selectionIssue: .javaScriptDisabled)))
        XCTAssertEqual(a.page, p); XCTAssertFalse(a.turnOffToggle)
        XCTAssertEqual(a.hint, SafariBridgeError.javaScriptDisabled.hint)
    }
}
