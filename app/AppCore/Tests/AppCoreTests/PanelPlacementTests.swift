import XCTest
import AppCore

final class PanelPlacementTests: XCTestCase {
    let screen = CGRect(x: 0, y: 0, width: 1920, height: 1080)

    func testOutsideRightWithGap() {
        let safari = CGRect(x: 100, y: 50, width: 1000, height: 900)
        XCTAssertEqual(PanelPlacement.frame(safari: safari, screens: [screen]), CGRect(x: 1108, y: 50, width: 380, height: 900))
    }
    func testExactlyFitsAtScreenEdge() {
        let safari = CGRect(x: 0, y: 0, width: 1920 - 388, height: 1000)
        XCTAssertEqual(PanelPlacement.frame(safari: safari, screens: [screen]).minX, 1540)
    }
    func testOneOffTheEdgeFallsInside() {
        let safari = CGRect(x: 0, y: 0, width: 1920 - 387, height: 1000)
        let f = PanelPlacement.frame(safari: safari, screens: [screen])
        XCTAssertEqual(f, CGRect(x: safari.maxX - 380, y: 0, width: 380, height: 1000))
    }
    func testSafariAtRightEdgeOverlapsInside() {
        let safari = CGRect(x: 500, y: 0, width: 1420, height: 1080)
        let f = PanelPlacement.frame(safari: safari, screens: [screen])
        XCTAssertEqual(f, CGRect(x: 1540, y: 0, width: 380, height: 1080))
        XCTAssertTrue(screen.contains(f))
    }
    func testNeverLeavesTheScreen() {
        for x in stride(from: -200.0, through: 2000.0, by: 37.0) {
            for w in [300.0, 700.0, 1400.0, 1920.0] {
                let safari = CGRect(x: x, y: 40, width: w, height: 900)
                let f = PanelPlacement.frame(safari: safari, screens: [screen])
                XCTAssertGreaterThanOrEqual(f.minX, screen.minX, "\(safari)")
                XCTAssertLessThanOrEqual(f.maxX, screen.maxX, "\(safari)")
            }
        }
    }
    func testTwoScreensWindowOnLeftScreenNearBoundaryDoesNotSpill() {
        let left = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        let right = CGRect(x: 1920, y: 0, width: 1920, height: 1080)
        let safari = CGRect(x: 600, y: 0, width: 1300, height: 1000) // 오른쪽 끝 1900, 이웃 화면 코앞
        let f = PanelPlacement.frame(safari: safari, screens: [left, right])
        XCTAssertTrue(left.contains(f), "옆 창이 두 화면에 걸침: \(f)")
        XCTAssertEqual(f.minX, 1900 - 380)
    }
    func testTwoScreensPlentyOfRoomOnLeftScreenStaysOutside() {
        let left = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        let right = CGRect(x: 1920, y: 0, width: 1920, height: 1080)
        let safari = CGRect(x: 100, y: 0, width: 800, height: 1000)
        XCTAssertEqual(PanelPlacement.frame(safari: safari, screens: [left, right]).minX, 908)
    }
    func testSafariOnRightScreenUsesRightScreenEdge() {
        let left = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        let right = CGRect(x: 1920, y: 0, width: 1920, height: 1080)
        let safari = CGRect(x: 2500, y: 0, width: 1300, height: 1000) // 오른쪽 끝 3800 > 3840-388
        let f = PanelPlacement.frame(safari: safari, screens: [left, right])
        XCTAssertTrue(right.contains(f))
        XCTAssertEqual(f.minX, 3800 - 380)
    }
    func testWindowStraddlingTwoScreensPicksLargerOverlap() {
        let left = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        let right = CGRect(x: 1920, y: 0, width: 1920, height: 1080)
        let safari = CGRect(x: 1500, y: 0, width: 900, height: 1000) // 왼쪽 420 · 오른쪽 480 걸침 → 오른쪽 화면
        let f = PanelPlacement.frame(safari: safari, screens: [left, right])
        XCTAssertTrue(right.contains(f) || left.contains(f))
        XCTAssertEqual(f.minX, 2400 + 8) // 오른쪽 화면 안에 자리 있음
    }
    func testVerticalClampToScreen() {
        let safari = CGRect(x: 100, y: -50, width: 800, height: 1300)
        let f = PanelPlacement.frame(safari: safari, screens: [screen])
        XCTAssertEqual(f.minY, 0); XCTAssertEqual(f.height, 1080)
    }
    func testNoScreensStillAnswers() {
        let safari = CGRect(x: 100, y: 50, width: 1000, height: 900)
        XCTAssertEqual(PanelPlacement.frame(safari: safari, screens: []), CGRect(x: 1108, y: 50, width: 380, height: 900))
    }
    func testCustomWidthAndGap() {
        let safari = CGRect(x: 0, y: 0, width: 500, height: 500)
        XCTAssertEqual(PanelPlacement.frame(safari: safari, screens: [screen], width: 200, gap: 20), CGRect(x: 520, y: 0, width: 200, height: 500))
    }
    func testDefaultFrameOnRightOfMainScreen() {
        XCTAssertEqual(PanelPlacement.defaultFrame(screens: [screen]), CGRect(x: 1540, y: 0, width: 380, height: 1080))
        XCTAssertEqual(PanelPlacement.defaultFrame(screens: []), CGRect(x: 0, y: 0, width: 380, height: 800))
    }
}
