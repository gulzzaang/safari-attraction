import XCTest
@testable import AppCore

final class PanelToggleTests: XCTestCase {
    func testNotOpenOpens() { XCTAssertEqual(PanelToggle.action(isOpen: false, isVisible: false), .open) }
    func testOpenAndVisibleCloses() { XCTAssertEqual(PanelToggle.action(isOpen: true, isVisible: true), .close) }
    func testOpenButHiddenByFollowerOpensAgainInsteadOfClosing() {
        // 다른 앱으로 옮겨 가 따라가기가 숨겼다 — 단축키 한 번에 다시 떠야 한다(닫기가 아니다).
        XCTAssertEqual(PanelToggle.action(isOpen: true, isVisible: false), .open)
    }
    func testClosingInFlightOpens() { XCTAssertEqual(PanelToggle.action(isOpen: false, isVisible: true), .open) }
}

final class ReturnKeyTests: XCTestCase {
    func testPlainReturnSubmits() {
        XCTAssertEqual(ReturnKey.action(hasMarkedText: false, shiftOrOption: false), .submit)
    }
    func testReturnWhileComposingHangulNeverSubmits() {
        XCTAssertEqual(ReturnKey.action(hasMarkedText: true, shiftOrOption: false), .letInputMethodHandle)
        XCTAssertEqual(ReturnKey.action(hasMarkedText: true, shiftOrOption: true), .letInputMethodHandle)
    }
    func testShiftOrOptionReturnInsertsNewline() {
        XCTAssertEqual(ReturnKey.action(hasMarkedText: false, shiftOrOption: true), .newline)
    }
}
