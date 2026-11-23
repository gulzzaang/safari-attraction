import XCTest
import AppCore

final class ScreenCoordinatesTests: XCTestCase {
    func testAppleScriptBoundsListToTopLeftRect() {
        XCTAssertEqual(ScreenCoordinates.rect(appleScriptBounds: [100, 50, 1100, 950]),
                       CGRect(x: 100, y: 50, width: 1000, height: 900))
        XCTAssertNil(ScreenCoordinates.rect(appleScriptBounds: [1, 2, 3]))
        XCTAssertNil(ScreenCoordinates.rect(appleScriptBounds: [100, 50, 90, 950])) // 오른쪽 < 왼쪽
    }
    func testSingleScreenFlip() {
        // 높이 1080 주 화면, 사파리가 위에서 50 · 높이 900 → AppKit 에서는 아래에서 1080-950=130.
        let r = ScreenCoordinates.appKitRect(fromTopLeft: CGRect(x: 100, y: 50, width: 1000, height: 900), primaryScreenHeight: 1080)
        XCTAssertEqual(r, CGRect(x: 100, y: 130, width: 1000, height: 900))
    }
    func testFlipIsItsOwnInverse() {
        let r = CGRect(x: -300, y: -700, width: 800, height: 600)
        let back = ScreenCoordinates.topLeftRect(fromAppKit: ScreenCoordinates.appKitRect(fromTopLeft: r, primaryScreenHeight: 900), primaryScreenHeight: 900)
        XCTAssertEqual(back, r)
    }
    func testScreenAbovePrimaryHasNegativeTopLeftY() {
        // 주 화면 1440x900(AppKit 원점 0,0), 그 위에 1920x1080 보조 화면.
        // AppKit: 보조 화면은 y 900..1980. 사파리(왼쪽 위 기준)는 y -1080..0 영역.
        let safari = CGRect(x: 200, y: -1000, width: 800, height: 700) // 보조 화면 안, 위에서 80 아래
        let r = ScreenCoordinates.appKitRect(fromTopLeft: safari, primaryScreenHeight: 900)
        XCTAssertEqual(r, CGRect(x: 200, y: 1200, width: 800, height: 700)) // 보조 화면 윗변 1980 에서 80 아래 = 1900 → 아랫변 1200
        XCTAssertTrue(CGRect(x: 0, y: 900, width: 1920, height: 1080).contains(r))
    }
    func testScreenBelowPrimaryAndNonZeroX() {
        // 주 화면 1440x900, 그 아래 오른쪽으로 비껴 놓인 1280x800 화면: AppKit y -800..0, x 1440..2720.
        // 왼쪽 위 기준으로는 y 900..1700.
        let safari = CGRect(x: 1500, y: 1000, width: 600, height: 500)
        let r = ScreenCoordinates.appKitRect(fromTopLeft: safari, primaryScreenHeight: 900)
        XCTAssertEqual(r, CGRect(x: 1500, y: -600, width: 600, height: 500))
        XCTAssertTrue(CGRect(x: 1440, y: -800, width: 1280, height: 800).contains(r))
    }
    func testPlacementOnThreeMixedScreensEndToEnd() {
        let primary = CGRect(x: 0, y: 0, width: 1440, height: 900)          // 주 화면(메뉴 막대 무시한 단순형)
        let above = CGRect(x: 0, y: 900, width: 1920, height: 1080)
        let right = CGRect(x: 1440, y: -180, width: 2560, height: 1440)
        let screens = [primary, above, right]
        // 위 화면의 사파리: 왼쪽 위 기준 y=-1000..-300
        let safari = ScreenCoordinates.appKitRect(fromTopLeft: CGRect(x: 100, y: -1000, width: 900, height: 700), primaryScreenHeight: 900)
        let f = PanelPlacement.frame(safari: safari, screens: screens)
        XCTAssertEqual(f, CGRect(x: 1008, y: safari.minY, width: 380, height: 700))
        XCTAssertTrue(above.contains(f))
    }
    func testGeometryConvenience() {
        let g = ScreenGeometry(primaryHeight: 900, visibleFrames: [CGRect(x: 0, y: 0, width: 1440, height: 875)])
        XCTAssertEqual(g.appKitRect(fromTopLeft: CGRect(x: 0, y: 25, width: 500, height: 400)), CGRect(x: 0, y: 475, width: 500, height: 400))
    }
}
