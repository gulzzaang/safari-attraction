import XCTest
@testable import AppCore

/// 시험용 손님 — 유닉스 소켓에 붙어 줄을 보내고 줄을 읽는다.
final class TestClient {
    let fd: Int32
    private var buffer = Data()

    init?(path: String) {
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { close(fd); return nil }
        withUnsafeMutableBytes(of: &addr.sun_path) { buf in
            for (i, b) in bytes.enumerated() { buf[i] = b }
            buf[bytes.count] = 0
        }
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if rc != 0 { close(fd); return nil }
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    }
    deinit { close(fd) }

    func sendRaw(_ s: String) {
        let d = Array(s.utf8)
        var off = 0
        while off < d.count {
            let n = d.withUnsafeBytes { send(fd, $0.baseAddress! + off, d.count - off, 0) }
            if n <= 0 { return }
            off += n
        }
    }
    func sendObject(_ o: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: o, options: [.withoutEscapingSlashes])
        sendRaw(String(decoding: data, as: UTF8.self) + "\n")
    }
    func closeWrite() { shutdown(fd, SHUT_WR) }

    /// 한 줄을 읽는다. 시간 안에 줄이 없으면 nil, 끊겼으면 빈 문자열.
    func readLine(timeout: TimeInterval = 5) -> String? {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            if let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer[buffer.startIndex..<nl]
                buffer = Data(buffer[(nl + 1)...])
                return String(decoding: line, as: UTF8.self)
            }
            let remaining = deadline.timeIntervalSinceNow
            if remaining <= 0 { return nil }
            var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let pr = poll(&p, 1, Int32(min(remaining, 0.2) * 1000))
            if pr < 0 { if errno == EINTR { continue }; return "" }
            if pr == 0 { continue }
            var tmp = [UInt8](repeating: 0, count: 4096)
            let n = read(fd, &tmp, tmp.count)
            if n == 0 { return "" }
            if n < 0 { if errno == EINTR || errno == EAGAIN { continue }; return "" }
            buffer.append(contentsOf: tmp[0..<n])
        }
    }
    func readReply(timeout: TimeInterval = 5) -> [String: Any]? {
        guard let line = readLine(timeout: timeout), !line.isEmpty,
              let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { return nil }
        return obj
    }
    /// 서버가 연결을 끊었는가(EOF).
    func isClosedByServer(timeout: TimeInterval = 3) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let pr = poll(&p, 1, 100)
            if pr > 0 {
                var tmp = [UInt8](repeating: 0, count: 256)
                let n = read(fd, &tmp, tmp.count)
                if n == 0 { return true }
                if n < 0 && errno != EINTR && errno != EAGAIN { return true }
            }
        }
        return false
    }
}

/// 잠금으로 지키는 작은 상자(시험 전용).
private final class Locked<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ v: T) { value = v }
    func with<R>(_ f: (inout T) -> R) -> R { lock.lock(); defer { lock.unlock() }; return f(&value) }
}

private final class WaitSignal: @unchecked Sendable {
    private let sem = DispatchSemaphore(value: 0)
    func signal() { sem.signal() }
    func wait(_ t: TimeInterval = 5) -> Bool { sem.wait(timeout: .now() + t) == .success }
}

final class GateServerTests: XCTestCase {
    private var dir: URL!
    private var servers: [GateServer] = []

    override func setUpWithError() throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        dir = base.appendingPathComponent("gt-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    override func tearDown() {
        servers.forEach { $0.stop() }
        servers = []
        try? FileManager.default.removeItem(at: dir)
    }

    private func makeServer(at d: URL? = nil) throws -> GateServer {
        let s = try GateServer(directory: d ?? dir)
        servers.append(s)
        return s
    }
    private func request(_ s: GateServer, id: String = "r1", extra: [String: Any] = [:]) -> [String: Any] {
        var o: [String: Any] = ["v": 1, "token": s.info.token, "id": id, "host": "www.coupang.com", "url": "https://www.coupang.com/cart",
                                "action": "click", "target": "장바구니", "value": "", "irreversible": false]
        for (k, v) in extra { o[k] = v }
        return o
    }

    // MARK: 자리 · 토큰

    func testSocketPathTokenAndPermissions() throws {
        let s = try makeServer()
        let expected = dir.appendingPathComponent("gate/s.sock").path
        XCTAssertEqual(s.info.socketPath, expected)
        let gate = dir.appendingPathComponent("gate").path
        let attrs = try FileManager.default.attributesOfItem(atPath: gate)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        XCTAssertTrue(FileManager.default.fileExists(atPath: expected))
        XCTAssertEqual(s.info.token.count, 64)
        XCTAssertNotNil(s.info.token.range(of: "^[0-9a-f]{64}$", options: .regularExpression))
        let s2 = try GateServer(directory: dir.appendingPathComponent("other", isDirectory: true))
        servers.append(s2)
        XCTAssertNotEqual(s.info.token, s2.info.token, "인스턴스마다 새 토큰")
    }

    func testExistingGateDirectoryWithLooseModeIsTightenedTo0700() throws {
        let gate = dir.appendingPathComponent("gate", isDirectory: true)
        try FileManager.default.createDirectory(at: gate, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
        _ = try makeServer()
        let attrs = try FileManager.default.attributesOfItem(atPath: gate.path)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o700)
    }

    func testStaleSocketFileIsReplaced() throws {
        let gate = dir.appendingPathComponent("gate", isDirectory: true)
        try FileManager.default.createDirectory(at: gate, withIntermediateDirectories: true)
        try Data("stale".utf8).write(to: gate.appendingPathComponent("s.sock"))
        let first = try GateServer(directory: dir)   // 새로 만들면 옛 파일 위에 묶는다
        servers.append(first)
        first.start { _ in .allow }
        let c = try XCTUnwrap(TestClient(path: first.info.socketPath))
        c.sendObject(request(first))
        XCTAssertEqual(c.readReply()?["allow"] as? Bool, true)
    }

    func testLongDirectoryFallsBackToAFreshPrivateTempDirectory() throws {
        let long = dir.appendingPathComponent(String(repeating: "d", count: 120), isDirectory: true)
        let s = try makeServer(at: long)
        let path = s.info.socketPath
        XCTAssertLessThanOrEqual(path.utf8.count, 103)
        XCTAssertFalse(path.hasPrefix(long.path), "긴 자리는 임시 폴더로 옮긴다")
        let parent = (path as NSString).deletingLastPathComponent
        XCTAssertTrue(parent.contains("sa-gate-"))
        let attrs = try FileManager.default.attributesOfItem(atPath: parent)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        s.start { _ in .allow }
        let c = try XCTUnwrap(TestClient(path: path))
        c.sendObject(request(s))
        XCTAssertEqual(c.readReply()?["allow"] as? Bool, true)
        s.stop()
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: parent), "우리가 만든 임시 폴더도 치운다")
    }

    // MARK: 왕복

    func testRoundTripAllowAndFieldsArriveIntact() throws {
        let s = try makeServer()
        let seen = Locked<[GateRequest]>([])
        s.start { r in seen.with { $0.append(r) }; return .allow }
        let c = try XCTUnwrap(TestClient(path: s.info.socketPath))
        c.sendObject(request(s, id: "abc123", extra: ["action": "fill", "target": "이름", "value": "(비밀)", "irreversible": true]))
        let reply = try XCTUnwrap(c.readReply())
        XCTAssertEqual(reply["id"] as? String, "abc123")
        XCTAssertEqual(reply["allow"] as? Bool, true)
        XCTAssertNil(reply["reason"])
        XCTAssertEqual(seen.with { $0 }, [GateRequest(id: "abc123", host: "www.coupang.com", url: "https://www.coupang.com/cart",
                                                      action: "fill", target: "이름", value: "(비밀)", irreversible: true)])
        XCTAssertTrue(c.isClosedByServer(), "한 요청 한 연결 — 답한 뒤 닫는다")
    }

    func testDenyCarriesKoreanReason() throws {
        let s = try makeServer()
        s.start { _ in .deny("이 사이트는 읽기만 허락했어요") }
        let c = try XCTUnwrap(TestClient(path: s.info.socketPath))
        c.sendObject(request(s))
        let reply = try XCTUnwrap(c.readReply())
        XCTAssertEqual(reply["allow"] as? Bool, false)
        XCTAssertEqual(reply["reason"] as? String, "이 사이트는 읽기만 허락했어요")
        XCTAssertEqual(reply["id"] as? String, "r1")
    }

    func testIrreversibleNullAndMissingBecomeNil() throws {
        let s = try makeServer()
        let seen = Locked<[Bool?]>([])
        s.start { r in seen.with { $0.append(r.irreversible) }; return .allow }
        let a = try XCTUnwrap(TestClient(path: s.info.socketPath))
        a.sendObject(request(s, id: "n1", extra: ["irreversible": NSNull()]))
        XCTAssertNotNil(a.readReply())
        let b = try XCTUnwrap(TestClient(path: s.info.socketPath))
        var o = request(s, id: "n2"); o.removeValue(forKey: "irreversible")
        b.sendObject(o)
        XCTAssertNotNil(b.readReply())
        XCTAssertEqual(seen.with { $0.count }, 2)
        XCTAssertTrue(seen.with { $0.allSatisfy { $0 == nil } })
    }

    func testSlashesAndUnicodeSurviveInUrlAndTarget() throws {
        let s = try makeServer()
        let seen = Locked<GateRequest?>(nil)
        s.start { r in seen.with { $0 = r }; return .allow }
        let c = try XCTUnwrap(TestClient(path: s.info.socketPath))
        c.sendObject(request(s, extra: ["url": "https://a.com/x?y=1&z=\"q\"", "target": "결제하기 \n 줄바꿈 😀"]))
        XCTAssertNotNil(c.readReply())
        XCTAssertEqual(seen.with { $0?.url }, "https://a.com/x?y=1&z=\"q\"")
        XCTAssertEqual(seen.with { $0?.target }, "결제하기 \n 줄바꿈 😀")
    }

    // MARK: 거절 · 틀린 줄

    func testWrongTokenIsDeniedWithIdAndClosedWithoutCallingHandler() throws {
        let s = try makeServer()
        let calls = Locked(0)
        s.start { _ in calls.with { $0 += 1 }; return .allow }
        let c = try XCTUnwrap(TestClient(path: s.info.socketPath))
        c.sendObject(request(s, id: "bad1", extra: ["token": String(repeating: "0", count: 64)]))
        let reply = try XCTUnwrap(c.readReply())
        XCTAssertEqual(reply["allow"] as? Bool, false)
        XCTAssertEqual(reply["id"] as? String, "bad1")
        XCTAssertFalse((reply["reason"] as? String ?? "").isEmpty)
        XCTAssertTrue(c.isClosedByServer())
        XCTAssertEqual(calls.with { $0 }, 0)
    }

    func testMissingOrWrongTypeTokenIsDenied() throws {
        let s = try makeServer()
        let calls = Locked(0)
        s.start { _ in calls.with { $0 += 1 }; return .allow }
        for (i, tokenValue) in [nil, 7 as Any, "", String(s.info.token.prefix(63)), s.info.token + "0", s.info.token.uppercased()].enumerated() {
            let c = try XCTUnwrap(TestClient(path: s.info.socketPath))
            var o = request(s, id: "t\(i)")
            if let tv = tokenValue { o["token"] = tv } else { o.removeValue(forKey: "token") }
            c.sendObject(o)
            let reply = try XCTUnwrap(c.readReply(), "case \(i)")
            XCTAssertEqual(reply["allow"] as? Bool, false, "case \(i)")
            XCTAssertEqual(reply["id"] as? String, "t\(i)", "case \(i)")
        }
        XCTAssertEqual(calls.with { $0 }, 0)
    }

    func testMalformedLinesAreDeniedAndClosed() throws {
        let s = try makeServer()
        let calls = Locked(0)
        s.start { _ in calls.with { $0 += 1 }; return .allow }
        let lines = ["garbage\n", "\n", "[1,2]\n", "\"str\"\n", "{\"v\":1,\"token\":\"\(s.info.token)\"}\n",
                     "{\"v\":2,\"token\":\"\(s.info.token)\",\"id\":\"x\",\"action\":\"click\"}\n",
                     "{\"v\":1,\"token\":\"\(s.info.token)\",\"id\":\"x\",\"action\":5}\n",
                     "{\"v\":1,\"token\":\"\(s.info.token)\",\"id\":\"x\",\"action\":\"click\",\"irreversible\":\"yes\"}\n"]
        for (i, l) in lines.enumerated() {
            let c = try XCTUnwrap(TestClient(path: s.info.socketPath))
            c.sendRaw(l)
            let reply = try XCTUnwrap(c.readReply(), "case \(i)")
            XCTAssertEqual(reply["allow"] as? Bool, false, "case \(i)")
            XCTAssertTrue(c.isClosedByServer(), "case \(i)")
        }
        XCTAssertEqual(calls.with { $0 }, 0)
    }

    func testParseableIdIsEchoedOnMalformedRequest() throws {
        let s = try makeServer()
        s.start { _ in .allow }
        let c = try XCTUnwrap(TestClient(path: s.info.socketPath))
        c.sendRaw("{\"v\":1,\"token\":\"\(s.info.token)\",\"id\":\"keep-me\",\"action\":5}\n")
        XCTAssertEqual(c.readReply()?["id"] as? String, "keep-me")
    }

    func testClientThatClosesBeforeSendingALineDoesNotBreakTheServer() throws {
        let s = try makeServer()
        let calls = Locked(0)
        s.start { _ in calls.with { $0 += 1 }; return .allow }
        do {
            let c = try XCTUnwrap(TestClient(path: s.info.socketPath))
            c.sendRaw("{\"v\":1,\"tok")   // 줄바꿈 없이 끊김
        }
        let ok = try XCTUnwrap(TestClient(path: s.info.socketPath))
        ok.sendObject(request(s))
        XCTAssertEqual(ok.readReply()?["allow"] as? Bool, true)
        XCTAssertEqual(calls.with { $0 }, 1)
    }

    func testOversizedLineIsDenied() throws {
        let s = try makeServer()
        s.start { _ in .allow }
        let c = try XCTUnwrap(TestClient(path: s.info.socketPath))
        c.sendRaw(String(repeating: "a", count: 200_000))
        XCTAssertEqual(c.readReply()?["allow"] as? Bool, false)
    }

    // MARK: 동시 · 끊김

    func testTwoConcurrentRequestsAreAnsweredIndependently() throws {
        let s = try makeServer()
        let release = Locked<CheckedContinuation<Void, Never>?>(nil)
        let aWaiting = WaitSignal()
        s.start { r in
            if r.id == "A" {
                await withCheckedContinuation { (k: CheckedContinuation<Void, Never>) in
                    release.with { $0 = k }
                    aWaiting.signal()
                }
                return .deny("A 는 늦게 거절")
            }
            return .allow
        }
        let a = try XCTUnwrap(TestClient(path: s.info.socketPath))
        a.sendObject(request(s, id: "A"))
        XCTAssertTrue(aWaiting.wait(), "A 가 기다리는 중")
        let b = try XCTUnwrap(TestClient(path: s.info.socketPath))
        b.sendObject(request(s, id: "B"))
        let rb = try XCTUnwrap(b.readReply(timeout: 3), "A 가 막혀 있어도 B 는 답을 받는다")
        XCTAssertEqual(rb["id"] as? String, "B"); XCTAssertEqual(rb["allow"] as? Bool, true)
        XCTAssertNil(a.readLine(timeout: 0.3), "A 는 아직 답이 없다")
        release.with { $0 }?.resume()
        let ra = try XCTUnwrap(a.readReply())
        XCTAssertEqual(ra["id"] as? String, "A"); XCTAssertEqual(ra["allow"] as? Bool, false)
        XCTAssertEqual(ra["reason"] as? String, "A 는 늦게 거절")
    }

    func testDisconnectWhileWaitingCancelsTheHandlerAndServerKeepsWorking() throws {
        let s = try makeServer()
        let started = WaitSignal(), cancelled = WaitSignal()
        s.start { r in
            if r.id == "gone" {
                await withTaskCancellationHandler {
                    started.signal()
                    while !Task.isCancelled { try? await Task.sleep(nanoseconds: 20_000_000) }
                } onCancel: { cancelled.signal() }
                return .deny("끊김")
            }
            return .allow
        }
        do {
            let c = try XCTUnwrap(TestClient(path: s.info.socketPath))
            c.sendObject(request(s, id: "gone"))
            XCTAssertTrue(started.wait())
        }   // 손님이 끊는다
        XCTAssertTrue(cancelled.wait(5), "끊기면 기다리던 일을 취소한다")
        let ok = try XCTUnwrap(TestClient(path: s.info.socketPath))
        ok.sendObject(request(s, id: "after"))
        XCTAssertEqual(ok.readReply()?["allow"] as? Bool, true)
    }

    func testManyConcurrentRequests() throws {
        let s = try makeServer()
        s.start { r in
            try? await Task.sleep(nanoseconds: 30_000_000)
            return r.id.hasSuffix("0") ? .deny("영") : .allow
        }
        let results = Locked<[String: Bool]>([:])
        let path = s.info.socketPath
        let token = s.info.token
        DispatchQueue.concurrentPerform(iterations: 16) { i in
            guard let c = TestClient(path: path) else { return }
            c.sendObject(["v": 1, "token": token, "id": "c\(i)", "host": "h", "url": "u", "action": "click", "target": "t", "value": "", "irreversible": false])
            if let r = c.readReply(), let id = r["id"] as? String, let a = r["allow"] as? Bool { results.with { $0[id] = a } }
        }
        let got = results.with { $0 }
        XCTAssertEqual(got.count, 16)
        for i in 0..<16 { XCTAssertEqual(got["c\(i)"], !"c\(i)".hasSuffix("0"), "c\(i)") }
    }

    // MARK: stop

    func testStopDeniesWaitingRequestsRemovesSocketAndRefusesNewConnections() throws {
        let s = try makeServer()
        let waiting = WaitSignal()
        let cancelled = WaitSignal()
        s.start { _ in
            await withTaskCancellationHandler {
                waiting.signal()
                while !Task.isCancelled { try? await Task.sleep(nanoseconds: 20_000_000) }
            } onCancel: { cancelled.signal() }
            return .allow   // 취소돼도 허락을 돌려주려 하지만 이미 거절 답이 나갔다
        }
        let c1 = try XCTUnwrap(TestClient(path: s.info.socketPath))
        c1.sendObject(request(s, id: "w1"))
        let c2 = try XCTUnwrap(TestClient(path: s.info.socketPath))
        c2.sendObject(request(s, id: "w2"))
        XCTAssertTrue(waiting.wait()); XCTAssertTrue(waiting.wait())
        let path = s.info.socketPath
        s.stop()
        for (c, id) in [(c1, "w1"), (c2, "w2")] {
            let r = try XCTUnwrap(c.readReply(), id)
            XCTAssertEqual(r["allow"] as? Bool, false)
            XCTAssertEqual(r["reason"] as? String, "멈췄어요")
            XCTAssertEqual(r["id"] as? String, id)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: path), "소켓 파일을 지운다")
        XCTAssertNil(TestClient(path: path), "멈춘 뒤 새 연결은 거절")
        XCTAssertTrue(cancelled.wait(5), "기다리던 일도 취소")
        s.stop() // 두 번 불러도 안전
    }

    func testStopBeforeStartCleansUp() throws {
        let s = try GateServer(directory: dir)
        let path = s.info.socketPath
        XCTAssertTrue(FileManager.default.fileExists(atPath: path))
        s.stop()
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    }

    func testDeinitRemovesTheSocketFile() throws {
        var s: GateServer? = try GateServer(directory: dir)
        let path = s!.info.socketPath
        s!.start { _ in .allow }
        XCTAssertTrue(FileManager.default.fileExists(atPath: path))
        s = nil
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    }

    func testNewServerAfterStopGetsNewTokenAndWorks() throws {
        let s = try GateServer(directory: dir)
        let oldToken = s.info.token
        s.start { _ in .allow }
        s.stop()
        let s2 = try makeServer()
        s2.start { _ in .allow }
        XCTAssertNotEqual(oldToken, s2.info.token)
        let c = try XCTUnwrap(TestClient(path: s2.info.socketPath))
        c.sendObject(request(s2))
        XCTAssertEqual(c.readReply()?["allow"] as? Bool, true)
    }

    func testConstantTimeEquals() {
        XCTAssertTrue(GateServer.constantTimeEquals("abc", "abc"))
        XCTAssertFalse(GateServer.constantTimeEquals("abc", "abd"))
        XCTAssertFalse(GateServer.constantTimeEquals("abc", "abcd"))
        XCTAssertFalse(GateServer.constantTimeEquals("", "a"))
        XCTAssertTrue(GateServer.constantTimeEquals("", ""))
    }
}
