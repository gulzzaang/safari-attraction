import XCTest
@testable import AppCore

final class PanelLinkTests: XCTestCase {
    private var dir: URL!

    override func setUp() async throws {
        // 실제 `~/Library/Application Support/SafariAttractionApp` 에는 절대 쓰지 않는다 — 임시 폴더만.
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("panel-link-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: dir) }

    private func permissions(_ url: URL) throws -> Int {
        (try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as! NSNumber).intValue
    }

    func testTokenIs64LowercaseHexAndDiffersEachTime() throws {
        let a = try PanelLink.makeToken(), b = try PanelLink.makeToken()
        XCTAssertEqual(a.count, 64)
        XCTAssertTrue(a.allSatisfy { "0123456789abcdef".contains($0) })
        XCTAssertNotEqual(a, b)
    }

    func testLinkFileIs0600WithPortAndTokenOnly() throws {
        try PanelLink.write(port: 51234, token: String(repeating: "0f", count: 32), in: dir)
        let url = PanelLink.fileURL(in: dir)
        XCTAssertEqual(url.lastPathComponent, "panel-link.json")
        XCTAssertEqual(try permissions(url), 0o600)
        let obj = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        XCTAssertEqual(Set(obj.keys), ["port", "token"])
        XCTAssertEqual(obj["port"] as? Int, 51234)
        XCTAssertEqual((obj["token"] as? String)?.count, 64)
        // 임시 파일이 남지 않는다.
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), ["panel-link.json"])
        // 다시 쓰면 바뀐다.
        try PanelLink.write(port: 1, token: String(repeating: "1a", count: 32), in: dir)
        let obj2 = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        XCTAssertEqual(obj2["port"] as? Int, 1)
        XCTAssertEqual(try permissions(url), 0o600)
        PanelLink.remove(in: dir)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        PanelLink.remove(in: dir)   // 없어도 오류 없음
    }

    func testHostWritesLinkThatWorksAndRemovesItOnShutdown() async throws {
        let backend = StubBackend()
        let host = PanelHost(directory: dir, backend: backend)
        try await host.start()
        let url = PanelLink.fileURL(in: dir)
        XCTAssertEqual(try permissions(url), 0o600)
        let obj = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        let port = UInt16(try XCTUnwrap(obj["port"] as? Int))
        let token = try XCTUnwrap(obj["token"] as? String)
        XCTAssertEqual(token.count, 64)
        XCTAssertEqual(host.port, port)
        // 파일의 토큰 · 포트로 부르면 열린다.
        let ok = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/info", port: port, token: token))
        XCTAssertEqual(ok?.status, 200)
        let bad = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/info", port: port, token: PanelTest.token))
        XCTAssertEqual(bad?.status, 403)

        host.shutdown()
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), "꺼질 때 지운다")
        let refused = await PanelTest.waitUntil { RawClient(port: port) == nil }
        XCTAssertTrue(refused)
    }

    func testEachStartUsesNewTokenAndReplacesStaleFile() async throws {
        let stale = PanelLink.fileURL(in: dir)
        try PanelLink.write(port: 9, token: String(repeating: "ee", count: 32), in: dir)
        var tokens: [String] = []
        for _ in 0..<2 {
            let host = PanelHost(directory: dir, backend: StubBackend())
            try await host.start()
            let obj = try JSONSerialization.jsonObject(with: Data(contentsOf: stale)) as! [String: Any]
            tokens.append(try XCTUnwrap(obj["token"] as? String))
            XCTAssertNotEqual(obj["port"] as? Int, 9)
            host.shutdown()
        }
        XCTAssertNotEqual(tokens[0], tokens[1])
        XCTAssertFalse(tokens.contains(String(repeating: "ee", count: 32)))
    }

    func testShutdownBeforeStartLeavesNothing() async throws {
        let host = PanelHost(directory: dir, backend: StubBackend())
        host.shutdown()
        do { try await host.start(); XCTFail("멈춘 뒤엔 켜지지 않아요") } catch { XCTAssertEqual(error as? PanelServerError, .stopped) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: PanelLink.fileURL(in: dir).path))
        XCTAssertNil(host.port)
    }

    func testShutdownMidStartLeavesNoFile() async throws {
        for _ in 0..<5 {
            let host = PanelHost(directory: dir, backend: StubBackend())
            let t = Task { try await host.start() }
            host.shutdown()
            _ = await t.result
            XCTAssertFalse(FileManager.default.fileExists(atPath: PanelLink.fileURL(in: dir).path))
        }
    }
}
