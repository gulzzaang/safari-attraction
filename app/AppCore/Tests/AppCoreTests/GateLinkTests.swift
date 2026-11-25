import XCTest
@testable import AppCore

final class GateLinkTests: XCTestCase {
    private var dir: URL!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("gate-link-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func permissions(_ url: URL) throws -> Int {
        (try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as! NSNumber).intValue
    }

    func testWriteCreates0600JSONWithSocketAndToken() throws {
        let info = GateInfo(socketPath: "/tmp/gate/s.sock", token: String(repeating: "ab", count: 32))
        try GateLink.write(info, support: dir)
        let url = GateLink.url(support: dir)
        XCTAssertEqual(url.lastPathComponent, "gate-link.json")
        XCTAssertEqual(try permissions(url), 0o600)
        let obj = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        XCTAssertEqual(Set(obj.keys), ["socket", "token"])
        XCTAssertEqual(obj["socket"] as? String, info.socketPath)
        XCTAssertEqual(obj["token"] as? String, info.token)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), ["gate-link.json"])
    }

    func testRemoveDeletesFile() throws {
        let info = GateInfo(socketPath: "/tmp/gate/s.sock", token: "tok")
        try GateLink.write(info, support: dir)
        let url = GateLink.url(support: dir)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        GateLink.remove(support: dir)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        GateLink.remove(support: dir) // 없어도 오류 없음
    }

    func testWriteReplacesOldFile() throws {
        let first = GateInfo(socketPath: "/tmp/gate/1.sock", token: "old-token")
        let second = GateInfo(socketPath: "/tmp/gate/2.sock", token: "new-token")
        try GateLink.write(first, support: dir)
        try GateLink.write(second, support: dir)
        let url = GateLink.url(support: dir)
        XCTAssertEqual(try permissions(url), 0o600)
        let obj = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        XCTAssertEqual(obj["socket"] as? String, second.socketPath)
        XCTAssertEqual(obj["token"] as? String, second.token)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), ["gate-link.json"])
    }
}
