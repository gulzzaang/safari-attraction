import XCTest
@testable import AppCore

final class PanelLayerTests: XCTestCase {
    func testUnpinnedPanelFloatsSoAnOverlappedSafariCannotBuryIt() {
        XCTAssertEqual(PanelLayer.level(pinned: false), .floating)
    }
    func testPinnedPanelIsNormalSoItDoesNotFloatOverEveryApp() {
        XCTAssertEqual(PanelLayer.level(pinned: true), .normal)
    }
    func testOnlyOpeningExplicitlyActivatesOurApp() {
        XCTAssertTrue(PanelLayer.activatesOurApp(for: .userOpened))
        XCTAssertTrue(PanelLayer.activatesOurApp(for: .userClicked))
        XCTAssertFalse(PanelLayer.activatesOurApp(for: .followerShowOrMove), "그냥 보이거나 자리만 옮길 땐 사파리에서 포커스를 뺏지 않는다")
    }
}
