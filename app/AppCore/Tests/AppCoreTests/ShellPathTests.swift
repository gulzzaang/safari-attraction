import XCTest
import AppCore

final class ShellPathTests: XCTestCase {
    func testFallbackExpandsHome() {
        XCTAssertEqual(ShellPath.fallback(home: "/Users/x"),
                       "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/x/.local/bin")
        XCTAssertFalse(ShellPath.fallback().contains("$HOME"))
    }
    func testParsesBetweenMarkersIgnoringNoise() {
        let out = "motd 소음\n__SAPATH__/a:/b/c__SAPATH__\n꼬리\n"
        XCTAssertEqual(ShellPath.parse(output: out), "/a:/b/c")
        XCTAssertNil(ShellPath.parse(output: "no markers"))
        XCTAssertNil(ShellPath.parse(output: "__SAPATH____SAPATH__"))
    }
    func testResolveFromInjectedShell() {
        let p = ShellPath.resolve(shell: "/bin/sh", arguments: ["-c", "echo noise; printf '__SAPATH__%s__SAPATH__' /x:/y; echo tail"], timeout: 5)
        XCTAssertEqual(p, "/x:/y")
    }
    func testResolveFailsForMissingShell() {
        XCTAssertNil(ShellPath.resolve(shell: "/no/such/shell", arguments: [], timeout: 2))
    }
    func testResolveGivesUpOnHang() {
        let t0 = Date()
        XCTAssertNil(ShellPath.resolve(shell: "/bin/sleep", arguments: ["30"], timeout: 1))
        XCTAssertLessThan(Date().timeIntervalSince(t0), 6)
    }
    func testLoginPathIsCachedAndUsable() {
        let a = ShellPath.loginPath(), b = ShellPath.loginPath()
        XCTAssertEqual(a, b)
        XCTAssertTrue(a.contains("/usr/bin"))
    }
    func testWorkDirectoryIsCreated() throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("appsup-\(UUID().uuidString)")
        let dir = try AppPaths.workDirectory(applicationSupport: base)
        XCTAssertEqual(dir.path, base.appendingPathComponent("SafariAttractionApp/work").path)
        var isDir: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir) && isDir.boolValue)
        XCTAssertEqual(try AppPaths.workDirectory(applicationSupport: base), dir) // 두 번째도 문제없음
    }

    func testFailedReadIsRetriedAfterIntervalButSuccessIsCachedForever() {
        final class Counter: @unchecked Sendable { var n = 0; var ok = false }
        let c = Counter()
        let cache = LoginPathCache(failureRetryInterval: 30) { c.n += 1; return c.ok ? "/real:/path" : nil }
        let t0 = Date()
        XCTAssertEqual(cache.path(now: t0), ShellPath.fallback())
        XCTAssertEqual(cache.path(now: t0.addingTimeInterval(10)), ShellPath.fallback())
        XCTAssertEqual(c.n, 1) // 30초 안에는 다시 안 읽음
        c.ok = true
        XCTAssertEqual(cache.path(now: t0.addingTimeInterval(31)), "/real:/path")
        XCTAssertEqual(c.n, 2)
        c.ok = false
        XCTAssertEqual(cache.path(now: t0.addingTimeInterval(500)), "/real:/path") // 성공은 영구
        XCTAssertEqual(c.n, 2)
    }
}
