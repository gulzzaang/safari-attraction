import XCTest
@testable import AppCore

final class AppCoreVersionTests: XCTestCase {
    func testVersionValue() {
        XCTAssertEqual(AppCoreVersion.value, "0.1.0")
    }
}
