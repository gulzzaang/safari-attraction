import XCTest
@testable import AppCore

/// 시험용 알림 처리기 — 받은 것을 적어 두고 정해 둔 수를 돌려준다.
final class StubAlerts: PanelAlertHandling, @unchecked Sendable {
    private let lock = NSLock()
    private var _received: [SiteAlert] = []
    var hosts: [String] = ["example.com", "shop.other.com"]
    var accepted = 1
    var received: [SiteAlert] { lock.withLock { _received } }

    func alertHosts() async -> [String] { hosts }
    func handleSiteAlert(host: String, kind: SiteAlert.Kind, title: String, body: String) async -> Int {
        lock.withLock { _received.append(SiteAlert(host: host, kind: kind, title: title, body: body)) }
        return accepted
    }
}

final class PanelAlertTests: XCTestCase {
    private func start(alerts: PanelAlertHandling?, backend: PanelBackend = StubBackend()) async throws -> UInt16 {
        let server = PanelServer(token: PanelTest.token, backend: backend, alerts: alerts)
        let port = try await server.start()
        addTeardownBlock { server.stop() }
        return port
    }

    private func alertBody(_ o: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: o) }
    private let good: [String: Any] = ["host": "example.com", "kind": "notification", "title": "택배", "body": "도착"]

    // MARK: GET /alert-hosts

    func testAlertHostsShape() async throws {
        let alerts = StubAlerts()
        let port = try await start(alerts: alerts)
        let r = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/alert-hosts", port: port, origin: PanelTest.extensionOrigin))
        XCTAssertEqual(r?.status, 200)
        XCTAssertEqual(r?.headers["content-type"], "application/json; charset=utf-8")
        XCTAssertEqual(r?.headers["access-control-allow-origin"], PanelTest.extensionOrigin)
        let obj = try JSONSerialization.jsonObject(with: r!.body) as! [String: Any]
        XCTAssertEqual(Set(obj.keys), ["hosts"])
        XCTAssertEqual(obj["hosts"] as? [String], ["example.com", "shop.other.com"])
        alerts.hosts = []
        let empty = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/alert-hosts", port: port))
        XCTAssertEqual((try JSONSerialization.jsonObject(with: empty!.body) as! [String: Any])["hosts"] as? [String], [])
    }

    func testAlertRoutesUseTheSameAuthRules() async throws {
        let alerts = StubAlerts()
        let port = try await start(alerts: alerts)
        for token in [nil, "", String(repeating: "cd", count: 32)] {
            let g = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/alert-hosts", port: port, token: token))
            XCTAssertEqual(g?.status, 403, "GET token=\(token ?? "nil")")
            XCTAssertFalse(g?.text.contains("example.com") ?? true, "403 답에 호스트 목록이 새지 않는다")
            let p = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/alert", port: port, token: token, body: alertBody(good)))
            XCTAssertEqual(p?.status, 403, "POST token=\(token ?? "nil")")
        }
        for host in ["localhost:\(port)", "127.0.0.1", "evil.example"] {
            let g = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/alert-hosts", port: port, host: host))
            XCTAssertEqual(g?.status, 403)
            let p = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/alert", port: port, host: host, body: alertBody(good)))
            XCTAssertEqual(p?.status, 403)
        }
        // 웹 페이지(다른 Origin)는 토큰이 맞아도 403
        for origin in ["https://example.com", "null", "http://127.0.0.1:\(port)"] {
            let g = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/alert-hosts", port: port, origin: origin))
            XCTAssertEqual(g?.status, 403, "origin=\(origin)")
            let p = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/alert", port: port, origin: origin, body: alertBody(good)))
            XCTAssertEqual(p?.status, 403, "origin=\(origin)")
        }
        XCTAssertEqual(alerts.received.count, 0, "막힌 요청은 처리기에 닿지 않는다")
    }

    // MARK: POST /alert

    func testAlertIs202WithAcceptedCountAndReachesTheHandler() async throws {
        let alerts = StubAlerts()
        alerts.accepted = 1
        let port = try await start(alerts: alerts)
        let r = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/alert", port: port, origin: PanelTest.extensionOrigin, body: alertBody(good)))
        XCTAssertEqual(r?.status, 202)
        XCTAssertEqual(r?.headers["access-control-allow-origin"], PanelTest.extensionOrigin)
        let obj = try JSONSerialization.jsonObject(with: r!.body) as! [String: Any]
        XCTAssertEqual(Set(obj.keys), ["accepted"])
        XCTAssertEqual(obj["accepted"] as? Int, 1)
        XCTAssertEqual(alerts.received, [SiteAlert(host: "example.com", kind: .notification, title: "택배", body: "도착")])

        alerts.accepted = 0
        let none = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/alert", port: port, body: alertBody(["host": "Example.com", "kind": "badge", "title": "(3) 받은편지함", "body": ""])))
        XCTAssertEqual(none?.status, 202)
        XCTAssertEqual((try JSONSerialization.jsonObject(with: none!.body) as! [String: Any])["accepted"] as? Int, 0)
        XCTAssertEqual(alerts.received.last, SiteAlert(host: "example.com", kind: .badge, title: "(3) 받은편지함", body: ""))
    }

    func testAlertTitleAndBodyAreCutAt200And500() async throws {
        let alerts = StubAlerts()
        let port = try await start(alerts: alerts)
        let body = alertBody(["host": "example.com", "kind": "notification", "title": String(repeating: "가", count: 400), "body": String(repeating: "나", count: 900)])
        let r = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/alert", port: port, body: body))
        XCTAssertEqual(r?.status, 202)
        XCTAssertEqual(alerts.received.first?.title.count, 200)
        XCTAssertEqual(alerts.received.first?.body.count, 500)
    }

    func testBadAlertBodiesAre400() async throws {
        let alerts = StubAlerts()
        let port = try await start(alerts: alerts)
        let bodies: [Data] = [
            Data("not json".utf8), Data("{}".utf8), Data("[]".utf8),
            alertBody(["kind": "badge"]),
            alertBody(["host": "", "kind": "badge"]),
            alertBody(["host": "example.com", "kind": "push"]),
            alertBody(["host": "example.com"]),
            alertBody(["host": "ex ample.com", "kind": "badge"]),
            alertBody(["host": "example.com/x", "kind": "badge"]),
            alertBody(["host": 5, "kind": "badge"]),
            alertBody(["host": "example.com", "kind": "badge", "title": 3]),
        ]
        for body in bodies {
            let r = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/alert", port: port, body: body))
            XCTAssertEqual(r?.status, 400, String(decoding: body, as: UTF8.self))
        }
        XCTAssertEqual(alerts.received.count, 0)
        let noLength = await PanelTest.roundTrip(port: port, Data("POST /alert HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\nX-SA-Token: \(PanelTest.token)\r\n\r\n".utf8))
        XCTAssertEqual(noLength?.status, 411)
    }

    func testAlertBodyOver256KBIs413() async throws {
        let alerts = StubAlerts()
        let port = try await start(alerts: alerts)
        let r = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/alert", port: port, body: nil, lengthOverride: PanelServer.maxBodyBytes + 1))
        XCTAssertEqual(r?.status, 413)
        XCTAssertEqual(alerts.received.count, 0)
    }

    func testWrongMethodsAre405() async throws {
        let port = try await start(alerts: StubAlerts())
        let a = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/alert", port: port))
        XCTAssertEqual(a?.status, 405)
        let b = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/alert-hosts", port: port, body: Data()))
        XCTAssertEqual(b?.status, 405)
    }

    func testWithoutAlertHandlerHostsAreEmptyAndNothingIsAccepted() async throws {
        let port = try await start(alerts: nil)
        let g = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/alert-hosts", port: port))
        XCTAssertEqual(g?.status, 200)
        XCTAssertEqual((try JSONSerialization.jsonObject(with: g!.body) as! [String: Any])["hosts"] as? [String], [])
        let p = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/alert", port: port, body: alertBody(good)))
        XCTAssertEqual(p?.status, 202)
        XCTAssertEqual((try JSONSerialization.jsonObject(with: p!.body) as! [String: Any])["accepted"] as? Int, 0)
    }

    func testAlertDoesNotUseAnAskSlot() async throws {
        let backend = StubBackend()
        backend.holdAsks = true
        let alerts = StubAlerts()
        let port = try await start(alerts: alerts, backend: backend)
        // 묻기 두 개가 붙들려 있어도 알림은 받는다(서로 길을 막지 않는다)
        let holders = (0..<PanelServer.maxConcurrentAsks).map { _ in
            Task.detached { await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/ask", port: port, body: PanelTest.askBody()), timeout: 3) }
        }
        let started = await PanelTest.waitUntil { backend.started == PanelServer.maxConcurrentAsks }
        XCTAssertTrue(started)
        let r = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/alert", port: port, body: alertBody(good)))
        XCTAssertEqual(r?.status, 202)
        await backend.gate.open()
        for h in holders { _ = await h.value }
    }

    // MARK: 닫힘 — 앱에서 허브를 늦게 잇는 길

    func testRelayForwardsOnceAttachedAndIsEmptyBefore() async {
        let relay = PanelAlertRelay()
        let before = await relay.alertHosts()
        XCTAssertEqual(before, [])
        let n0 = await relay.handleSiteAlert(host: "example.com", kind: .badge, title: "", body: "")
        XCTAssertEqual(n0, 0)
        let alerts = StubAlerts()
        relay.attach(alerts)
        let hosts = await relay.alertHosts()
        XCTAssertEqual(hosts, ["example.com", "shop.other.com"])
        let n1 = await relay.handleSiteAlert(host: "example.com", kind: .badge, title: "t", body: "b")
        XCTAssertEqual(n1, 1)
        XCTAssertEqual(alerts.received.count, 1)
    }
}
