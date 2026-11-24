import XCTest
import AppCore

final class HotKeyPolicyTests: XCTestCase {
    let own = "com.gulzzaang.SafariAttractionApp"

    func testSafariFrontRegisters() {
        XCTAssertTrue(HotKeyPolicy.shouldRegisterCommandE(frontmostBundleID: "com.apple.Safari", ownBundleID: own))
    }
    func testOwnAppFrontRegisters() {
        XCTAssertTrue(HotKeyPolicy.shouldRegisterCommandE(frontmostBundleID: own, ownBundleID: own))
    }
    func testOtherAppFrontUnregisters() {
        XCTAssertFalse(HotKeyPolicy.shouldRegisterCommandE(frontmostBundleID: "com.apple.finder", ownBundleID: own))
        XCTAssertFalse(HotKeyPolicy.shouldRegisterCommandE(frontmostBundleID: "com.google.Chrome", ownBundleID: own))
    }
    func testUnknownFrontUnregisters() {
        XCTAssertFalse(HotKeyPolicy.shouldRegisterCommandE(frontmostBundleID: nil, ownBundleID: own))
    }
    func testNoOwnBundleIDStillFollowsSafariOnly() {
        XCTAssertTrue(HotKeyPolicy.shouldRegisterCommandE(frontmostBundleID: "com.apple.Safari", ownBundleID: nil))
        XCTAssertFalse(HotKeyPolicy.shouldRegisterCommandE(frontmostBundleID: "com.apple.finder", ownBundleID: nil))
    }
}
