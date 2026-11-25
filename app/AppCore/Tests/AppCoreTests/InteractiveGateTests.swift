import XCTest
@testable import AppCore

@MainActor
final class InteractiveGateTests: XCTestCase {
    private var support: URL!

    override func setUp() async throws {
        support = FileManager.default.temporaryDirectory.appendingPathComponent("ig-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: support)
    }

    private func sampleRequest(id: String = "r1", action: String = "click", host: String = "www.example.com") -> GateRequest {
        GateRequest(id: id, host: host, url: "https://\(host)/", action: action, target: "담기", value: "", irreversible: false)
    }

    func testOnlyOneLeaseAtATime() throws {
        let fake = FakeGate()
        let gate = InteractiveGate(support: support, makeServer: { fake }, routineName: { nil })
        try gate.start()
        defer { gate.shutdown() }

        let lease1 = gate.acquire { _ in .allow }
        XCTAssertNotNil(lease1)
        XCTAssertEqual(gate.holder, .lease(lease1!.id))

        let lease2 = gate.acquire { _ in .allow }
        XCTAssertNil(lease2, "이미 다른 질문이 자리를 쥐고 있으면 두 번째 자리는 못 얻는다")

        lease1?.release()
        XCTAssertNil(gate.holder)

        let lease3 = gate.acquire { _ in .allow }
        XCTAssertNotNil(lease3, "앞 자리가 풀리면 다시 얻을 수 있다")
        lease3?.release()
    }

    func testRequestGoesToLeaseHolder() async throws {
        let fake = FakeGate()
        let gate = InteractiveGate(support: support, makeServer: { fake }, routineName: { nil })
        try gate.start()
        defer { gate.shutdown() }

        var seen: [GateRequest] = []
        let lease = try XCTUnwrap(gate.acquire { req in
            seen.append(req)
            return .allow
        })
        let req = sampleRequest(id: "g42", host: "shop.example.com")
        let decision = await fake.request(req).value
        XCTAssertEqual(decision, .allow)
        XCTAssertEqual(seen, [req])
        lease.release()
    }

    func testNoHolderDenies() async throws {
        let fake = FakeGate()
        let gate = InteractiveGate(support: support, makeServer: { fake }, routineName: { nil })
        try gate.start()
        defer { gate.shutdown() }

        let decision = await fake.request(sampleRequest()).value
        XCTAssertEqual(decision, .deny("지금 사파리를 움직이는 질문이 없어요"))
    }

    func testRoutineRunningBlocksAcquire() throws {
        @MainActor final class RoutineBox { var name: String? = "아침 브리핑" }
        let fake = FakeGate()
        let box = RoutineBox()
        let gate = InteractiveGate(support: support, makeServer: { fake }, routineName: { box.name })
        try gate.start()
        defer { gate.shutdown() }

        XCTAssertNil(gate.acquire { _ in .allow })
        XCTAssertEqual(gate.holder, .routine("아침 브리핑"))

        box.name = nil
        let lease = gate.acquire { _ in .allow }
        XCTAssertNotNil(lease)
        lease?.release()
    }

    func testReleaseIsIdempotent() throws {
        let fake = FakeGate()
        let gate = InteractiveGate(support: support, makeServer: { fake }, routineName: { nil })
        try gate.start()
        defer { gate.shutdown() }

        let lease1 = try XCTUnwrap(gate.acquire { _ in .allow })
        lease1.release()
        let lease2 = try XCTUnwrap(gate.acquire { _ in .allow })
        // 옛 자리를 한 번 더 풀어도 새 자리가 풀리지 않아야 한다.
        lease1.release()
        XCTAssertEqual(gate.holder, .lease(lease2.id))
        XCTAssertNil(gate.acquire { _ in .allow })
        lease2.release()
        XCTAssertNil(gate.holder)
    }

    func testStartWritesAndShutdownRemovesGateLink() throws {
        let dir = support!
        let gate = InteractiveGate(support: dir, makeServer: { try GateServer(directory: dir) }, routineName: { nil })
        let linkURL = GateLink.url(support: dir)
        XCTAssertFalse(FileManager.default.fileExists(atPath: linkURL.path))

        try gate.start()
        XCTAssertTrue(FileManager.default.fileExists(atPath: linkURL.path))
        let perms = (try FileManager.default.attributesOfItem(atPath: linkURL.path)[.posixPermissions] as? NSNumber)?.intValue
        XCTAssertEqual(perms, 0o600)
        let obj = try JSONSerialization.jsonObject(with: Data(contentsOf: linkURL)) as? [String: String]
        XCTAssertFalse((obj?["socket"] ?? "").isEmpty)
        XCTAssertEqual((obj?["token"] ?? "").count, 64)

        gate.shutdown()
        XCTAssertFalse(FileManager.default.fileExists(atPath: linkURL.path))
    }

    func testShutdownDeniesPendingRequest() async throws {
        let fake = FakeGate()
        let gate = InteractiveGate(support: support, makeServer: { fake }, routineName: { nil })
        try gate.start()

        let entered = Gate()
        let neverOpen = Gate()
        let lease = try XCTUnwrap(gate.acquire { _ in
            await entered.open()
            await neverOpen.wait()
            return .allow
        })
        let task = fake.request(sampleRequest())
        await entered.wait()

        gate.shutdown()
        let decision = await task.value
        XCTAssertEqual(decision, .deny(GateServer.stoppedReason))
        XCTAssertGreaterThanOrEqual(fake.stopCount, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: GateLink.url(support: support).path))
        lease.release()
    }
}

final class GateDeciderTests: XCTestCase {
    private var dir: URL!
    private var siteModes: SiteModeStore!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("gd-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        siteModes = SiteModeStore(directory: dir)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func req(host: String = "www.example.com", action: String = "click", irreversible: Bool? = false) -> GateRequest {
        GateRequest(id: "1", host: host, url: "https://\(host)/", action: action, target: "버튼", value: "", irreversible: irreversible)
    }

    func testOutcomeUsesExecutingPhaseAndSiteModes() throws {
        XCTAssertEqual(GateDecider.outcome(req(action: "goto"), siteModes: siteModes), .allow)
        XCTAssertEqual(GateDecider.outcome(req(action: "click", irreversible: false), siteModes: siteModes), .card(danger: false))
        XCTAssertEqual(GateDecider.outcome(req(action: "click", irreversible: true), siteModes: siteModes), .card(danger: true))
        XCTAssertEqual(GateDecider.outcome(req(action: "code", irreversible: false), siteModes: siteModes), .card(danger: true))

        try siteModes.setMode(.allowAll, for: "www.example.com")
        XCTAssertEqual(GateDecider.outcome(req(action: "click", irreversible: false), siteModes: siteModes), .allow)
        XCTAssertEqual(GateDecider.outcome(req(action: "click", irreversible: true), siteModes: siteModes), .card(danger: true))
        XCTAssertEqual(GateDecider.outcome(req(action: "code", irreversible: false), siteModes: siteModes), .card(danger: true))

        try siteModes.setMode(.readOnly, for: "www.example.com")
        XCTAssertEqual(GateDecider.outcome(req(action: "click", irreversible: false), siteModes: siteModes), .deny(ActionPolicy.readOnlyReason))
        XCTAssertEqual(GateDecider.outcome(req(action: "code", irreversible: false), siteModes: siteModes), .card(danger: true))
    }
}
