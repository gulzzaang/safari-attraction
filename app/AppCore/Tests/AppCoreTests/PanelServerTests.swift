import XCTest
import Darwin
@testable import AppCore

// MARK: - 시험 도구

/// 시험용 손님 — 127.0.0.1 에 날것 소켓으로 붙는다(Host · Origin · 본문 크기를 마음대로 하려고).
final class RawClient: @unchecked Sendable {
    /// 닫으면 -1 — 같은 번호를 두 번 닫아 다른 곳이 쓰는 번호를 닫는 일이 없게(실패한 init 뒤의 deinit 도 같다).
    private(set) var fd: Int32

    init?(host: String = "127.0.0.1", port: UInt16) {
        fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        guard inet_pton(AF_INET, host, &addr.sin_addr) == 1 else { closeFD(); return nil }
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        if rc != 0 { closeFD(); return nil }
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    }
    deinit { closeFD() }

    private func closeFD() {
        if fd >= 0 { close(fd); fd = -1 }
    }

    func send(_ data: Data) {
        var off = 0
        let bytes = [UInt8](data)
        while off < bytes.count {
            let n = bytes.withUnsafeBytes { Darwin.send(fd, $0.baseAddress! + off, bytes.count - off, 0) }
            if n <= 0 { return }
            off += n
        }
    }
    func send(_ s: String) { send(Data(s.utf8)) }

    /// 끊길 때까지(또는 시간 안에 `until` 이 참이 될 때까지) 읽은 것을 모두 돌려준다.
    func read(timeout: TimeInterval = 5, until: ((Data) -> Bool)? = nil) -> Data {
        var all = Data()
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            if let until, until(all) { return all }
            let remaining = deadline.timeIntervalSinceNow
            if remaining <= 0 { return all }
            var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let pr = poll(&p, 1, Int32(min(remaining, 0.2) * 1000))
            if pr < 0 { if errno == EINTR { continue }; return all }
            if pr == 0 { continue }
            var buf = [UInt8](repeating: 0, count: 16 * 1024)
            let n = recv(fd, &buf, buf.count, 0)
            if n <= 0 { return all }
            all.append(contentsOf: buf[0..<n])
        }
    }
    func closeNow() {
        if fd >= 0 { Darwin.shutdown(fd, SHUT_RDWR) }
        closeFD()
    }
}

struct HTTPReply {
    var status: Int
    var headers: [String: String]   // 이름은 소문자
    var body: Data                  // 청크는 풀어 놓은 것
    var chunked: Bool
    var text: String { String(decoding: body, as: UTF8.self) }
    var lines: [String] { text.split(separator: "\n").map(String.init) }

    static func parse(_ raw: Data) -> HTTPReply? {
        guard let r = raw.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: raw[raw.startIndex..<r.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
        guard let first = head.first, let code = Int(first.split(separator: " ")[1]) else { return nil }
        var headers: [String: String] = [:]
        for l in head.dropFirst() {
            guard let c = l.firstIndex(of: ":") else { continue }
            headers[l[..<c].lowercased()] = l[l.index(after: c)...].trimmingCharacters(in: .whitespaces)
        }
        var rest = Data(raw[r.upperBound...])
        let chunked = headers["transfer-encoding"] == "chunked"
        var body = Data()
        if chunked {
            while let crlf = rest.range(of: Data("\r\n".utf8)) {
                let sizeText = String(decoding: rest[rest.startIndex..<crlf.lowerBound], as: UTF8.self)
                guard let size = Int(sizeText, radix: 16) else { break }
                if size == 0 { break }
                let start = crlf.upperBound
                guard rest.count >= start + size else { break }
                body.append(rest[start..<(start + size)])
                rest = Data(rest[(start + size + 2)...])
            }
        } else {
            body = rest
        }
        return HTTPReply(status: code, headers: headers, body: body, chunked: chunked)
    }
}

enum PanelTest {
    static let token = String(repeating: "ab", count: 32)
    static let extensionOrigin = "safari-web-extension://9F2C6B1E-0000-4D5A-8E11-AAAAAAAAAAAA"

    static func request(_ method: String, _ path: String, port: UInt16, token: String? = PanelTest.token, host: String? = nil,
                        origin: String? = nil, body: Data? = nil, extra: [String: String] = [:], lengthOverride: Int? = nil) -> Data {
        var s = "\(method) \(path) HTTP/1.1\r\nHost: \(host ?? "127.0.0.1:\(port)")\r\n"
        if let token { s += "X-SA-Token: \(token)\r\n" }
        if let origin { s += "Origin: \(origin)\r\n" }
        for (k, v) in extra { s += "\(k): \(v)\r\n" }
        if method == "POST" { s += "Content-Type: application/json\r\nContent-Length: \(lengthOverride ?? body?.count ?? 0)\r\n" }
        s += "\r\n"
        var d = Data(s.utf8)
        if let body { d.append(body) }
        return d
    }

    static func askBody(_ question: String = "이게 뭐야?", page: [String: Any]? = ["title": "제목", "url": "https://example.com/a", "selection": "", "text": "본문"],
                        webSearch: Bool = false) -> Data {
        var o: [String: Any] = ["question": question, "webSearch": webSearch]
        if let page { o["page"] = page }
        return try! JSONSerialization.data(withJSONObject: o)
    }

    /// 한 번 보내고 끊길 때까지 읽는다.
    static func roundTrip(port: UInt16, _ data: Data, timeout: TimeInterval = 5) async -> HTTPReply? {
        await Task.detached {
            guard let c = RawClient(port: port) else { return nil }
            c.send(data)
            return HTTPReply.parse(c.read(timeout: timeout))
        }.value
    }

    static func waitUntil(timeout: TimeInterval = 5, _ cond: @escaping @Sendable () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if cond() { return true }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return cond()
    }
}

/// 시험용 두뇌 — 정해 둔 대로 답한다.
final class StubBackend: PanelBackend, @unchecked Sendable {
    private let lock = NSLock()
    private var _asks: [PanelQuestion] = []
    private var _started = 0
    var infoValue = PanelInfo(cli: "claude", cliName: "클로드", model: "Sonnet", loggedIn: true)
    let gate = Gate()
    var holdAsks = false
    var validCardIDs: Set<String> = []
    private var _approvals: [(cardID: String, answer: PanelApproveAnswer)] = []
    var asks: [PanelQuestion] { lock.withLock { _asks } }
    var started: Int { lock.withLock { _started } }
    var approvals: [(cardID: String, answer: PanelApproveAnswer)] { lock.withLock { _approvals } }

    func info() async -> PanelInfo { infoValue }
    func ask(_ question: PanelQuestion, emit: @escaping @Sendable (PanelLine) -> Void) async {
        lock.withLock { _asks.append(question); _started += 1 }
        emit(.delta("안녕"))
        if holdAsks { await gate.wait() }
        emit(.done(nil))
    }
    func approve(cardID: String, answer: PanelApproveAnswer) async -> Bool {
        lock.withLock {
            guard validCardIDs.contains(cardID) else { return false }
            validCardIDs.remove(cardID)
            _approvals.append((cardID, answer))
            return true
        }
    }
}

final class PanelServerTests: XCTestCase {
    private func start(_ backend: PanelBackend) async throws -> (PanelServer, UInt16) {
        let server = PanelServer(token: PanelTest.token, backend: backend)
        let port = try await server.start()
        addTeardownBlock { server.stop() }
        return (server, port)
    }

    // MARK: 막기

    func testWrongOrMissingTokenIs403() async throws {
        let (_, port) = try await start(StubBackend())
        for token in [String(repeating: "cd", count: 32), "", String(PanelTest.token.dropLast()), nil] {
            let r = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/info", port: port, token: token))
            XCTAssertEqual(r?.status, 403, "token=\(token ?? "nil")")
        }
        let ok = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/info", port: port))
        XCTAssertEqual(ok?.status, 200)
    }

    func testWrongHostIs403() async throws {
        let (_, port) = try await start(StubBackend())
        for host in ["localhost:\(port)", "127.0.0.1:\(port &+ 1)", "127.0.0.1", "evil.example", "[::1]:\(port)"] {
            let r = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/info", port: port, host: host))
            XCTAssertEqual(r?.status, 403, "host=\(host)")
        }
        let ok = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/info", port: port, host: "127.0.0.1:\(port)"))
        XCTAssertEqual(ok?.status, 200)
    }

    func testForeignOriginIs403EvenWithRightToken() async throws {
        let (_, port) = try await start(StubBackend())
        for origin in ["https://evil.example", "http://127.0.0.1:\(port)", "null", "moz-extension://abc", "safari-web-extension:/x"] {
            let r = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/info", port: port, origin: origin))
            XCTAssertEqual(r?.status, 403, "origin=\(origin)")
            XCTAssertNil(r?.headers["access-control-allow-origin"], "다른 Origin 에는 CORS 허락을 주지 않는다")
        }
        let post = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/ask", port: port, origin: "https://evil.example", body: PanelTest.askBody()))
        XCTAssertEqual(post?.status, 403)
    }

    func testNoOriginWithTokenIsAllowed() async throws {
        let (_, port) = try await start(StubBackend())
        let r = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/info", port: port))
        XCTAssertEqual(r?.status, 200)
        XCTAssertNil(r?.headers["access-control-allow-origin"])
    }

    func testExtensionOriginGetsItsOriginEchoedAlsoOnErrors() async throws {
        let (_, port) = try await start(StubBackend())
        let ok = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/info", port: port, origin: PanelTest.extensionOrigin))
        XCTAssertEqual(ok?.status, 200)
        XCTAssertEqual(ok?.headers["access-control-allow-origin"], PanelTest.extensionOrigin)
        // 토큰이 틀려도 확장이 한국어 안내를 읽을 수 있게 CORS 머리가 붙는다.
        let bad = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/info", port: port, token: "x", origin: PanelTest.extensionOrigin))
        XCTAssertEqual(bad?.status, 403)
        XCTAssertEqual(bad?.headers["access-control-allow-origin"], PanelTest.extensionOrigin)
        XCTAssertFalse(bad?.text.contains(PanelTest.token) ?? true, "토큰이 답에 나오지 않는다")
    }

    func testOptionsPreflight() async throws {
        let (_, port) = try await start(StubBackend())
        // 토큰 없이도 확장 Origin + 맞는 Host 면 허락 머리를 준다.
        let r = await PanelTest.roundTrip(port: port, PanelTest.request("OPTIONS", "/ask", port: port, token: nil, origin: PanelTest.extensionOrigin,
                                                                        extra: ["Access-Control-Request-Method": "POST",
                                                                                "Access-Control-Request-Headers": "x-sa-token, content-type"]))
        XCTAssertEqual(r?.status, 204)
        XCTAssertEqual(r?.headers["access-control-allow-origin"], PanelTest.extensionOrigin)
        XCTAssertEqual(r?.headers["access-control-allow-headers"], "X-SA-Token, Content-Type")
        XCTAssertEqual(r?.headers["access-control-allow-methods"], "GET, POST")
        // 다른 Origin · 다른 Host · Origin 없음은 거절.
        let foreign = await PanelTest.roundTrip(port: port, PanelTest.request("OPTIONS", "/ask", port: port, token: nil, origin: "https://evil.example"))
        XCTAssertEqual(foreign?.status, 403)
        XCTAssertNil(foreign?.headers["access-control-allow-origin"])
        let badHost = await PanelTest.roundTrip(port: port, PanelTest.request("OPTIONS", "/ask", port: port, token: nil, host: "localhost:\(port)", origin: PanelTest.extensionOrigin))
        XCTAssertEqual(badHost?.status, 403)
        let noOrigin = await PanelTest.roundTrip(port: port, PanelTest.request("OPTIONS", "/ask", port: port, token: nil))
        XCTAssertEqual(noOrigin?.status, 403)
    }

    func testUnknownPathAndMethod() async throws {
        let (_, port) = try await start(StubBackend())
        let nf = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/nope", port: port))
        XCTAssertEqual(nf?.status, 404)
        let m = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/info", port: port, body: Data()))
        XCTAssertEqual(m?.status, 405)
        let m2 = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/ask", port: port))
        XCTAssertEqual(m2?.status, 405)
        // 토큰 없이 없는 주소를 물어도 403(주소가 있는지 알려 주지 않는다).
        let hidden = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/nope", port: port, token: nil))
        XCTAssertEqual(hidden?.status, 403)
    }

    func testOnlyLoopbackIsListening() async throws {
        let (_, port) = try await start(StubBackend())
        var addrs: [String] = []
        var ifap: UnsafeMutablePointer<ifaddrs>?
        if getifaddrs(&ifap) == 0 {
            var p = ifap
            while let cur = p {
                if let sa = cur.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET), cur.pointee.ifa_flags & UInt32(IFF_LOOPBACK) == 0,
                   cur.pointee.ifa_flags & UInt32(IFF_UP) != 0 {
                    var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                    sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { sin in
                        var a = sin.pointee.sin_addr
                        inet_ntop(AF_INET, &a, &buf, socklen_t(INET_ADDRSTRLEN))
                    }
                    addrs.append(String(cString: buf))
                }
                p = cur.pointee.ifa_next
            }
            freeifaddrs(ifap)
        }
        try XCTSkipIf(addrs.isEmpty, "루프백 말고 IPv4 주소가 없어요")
        // 연결을 시도하는 곳은 이 맥 자신의 주소(밖으로 나가지 않는다).
        for a in addrs { XCTAssertNil(RawClient(host: a, port: port), "\(a) 로는 연결되면 안 돼요") }
        XCTAssertNotNil(RawClient(port: port))
    }

    // MARK: 한도

    func testBodyOver256KBIs413WithoutReadingIt() async throws {
        let (_, port) = try await start(StubBackend())
        let tooBig = PanelServer.maxBodyBytes + 1
        // 머리만 보내고 읽는다(본문을 다 쓰다 서버가 닫아 ECONNRESET 이 나는 것을 피한다).
        let r = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/ask", port: port, origin: PanelTest.extensionOrigin, lengthOverride: tooBig))
        XCTAssertEqual(r?.status, 413)
        XCTAssertEqual(r?.headers["access-control-allow-origin"], PanelTest.extensionOrigin)
    }

    func testBodyAtExactlyTheLimitIsRead() async throws {
        let backend = StubBackend()
        let (_, port) = try await start(backend)
        // 큰 본문(256KB 딱 맞게) — 읽혀서 두뇌까지 간다.
        var question = "가"
        let base = try JSONSerialization.data(withJSONObject: ["question": ""]).count
        while question.utf8.count + base < PanelServer.maxBodyBytes - 3 { question += "가" }
        var body = try JSONSerialization.data(withJSONObject: ["question": question])
        while body.count < PanelServer.maxBodyBytes { body.append(0x20) }
        XCTAssertEqual(body.count, PanelServer.maxBodyBytes)
        let r = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/ask", port: port, body: body), timeout: 10)
        XCTAssertEqual(r?.status, 200)
        XCTAssertEqual(backend.asks.first?.question, question)
    }

    func testBadBodiesAre400() async throws {
        let backend = StubBackend()
        let (_, port) = try await start(backend)
        for body in [Data("not json".utf8), Data("{}".utf8), Data(#"{"question":"   "}"#.utf8), Data(#"{"question":5}"#.utf8)] {
            let r = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/ask", port: port, body: body))
            XCTAssertEqual(r?.status, 400, String(decoding: body, as: UTF8.self))
        }
        XCTAssertEqual(backend.started, 0)
        let noLength = await PanelTest.roundTrip(port: port, Data("POST /ask HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\nX-SA-Token: \(PanelTest.token)\r\n\r\n".utf8))
        XCTAssertEqual(noLength?.status, 411)
    }

    func testThirdSimultaneousAskIs429AndSlotsFreeAgain() async throws {
        let backend = StubBackend()
        backend.holdAsks = true
        let (server, port) = try await start(backend)
        let body = PanelTest.askBody()
        let first = RawClient(port: port)!, second = RawClient(port: port)!
        first.send(PanelTest.request("POST", "/ask", port: port, body: body))
        second.send(PanelTest.request("POST", "/ask", port: port, body: body))
        let both = await PanelTest.waitUntil { backend.started == 2 }
        XCTAssertTrue(both)

        let third = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/ask", port: port, origin: PanelTest.extensionOrigin, body: body))
        XCTAssertEqual(third?.status, 429)
        XCTAssertTrue(third?.text.contains("다른 질문이 끝나면 다시") ?? false)
        XCTAssertEqual(third?.headers["access-control-allow-origin"], PanelTest.extensionOrigin)
        // 질문이 아닌 /info 는 막지 않는다.
        let info = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/info", port: port))
        XCTAssertEqual(info?.status, 200)

        // 하나가 끝나면 자리가 난다.
        await backend.gate.open()
        let r1 = await Task.detached { HTTPReply.parse(first.read(timeout: 5)) }.value
        let r2 = await Task.detached { HTTPReply.parse(second.read(timeout: 5)) }.value
        XCTAssertEqual(r1?.lines.last, #"{"t":"done","usage":null}"#)
        XCTAssertEqual(r2?.status, 200)
        let freed = await PanelTest.waitUntil { server.activeAskCount == 0 }
        XCTAssertTrue(freed)
        let fourth = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/ask", port: port, body: body))
        XCTAssertEqual(fourth?.status, 200)
    }

    func testSlotIsFreedWhenAClientDisconnectsMidAsk() async throws {
        let backend = StubBackend()
        backend.holdAsks = true
        let (server, port) = try await start(backend)
        for _ in 0..<2 {
            let c = RawClient(port: port)!
            c.send(PanelTest.request("POST", "/ask", port: port, body: PanelTest.askBody()))
            let got = await Task.detached { c.read(timeout: 5) { String(decoding: $0, as: UTF8.self).contains("안녕") } }.value
            XCTAssertTrue(String(decoding: got, as: UTF8.self).contains("안녕"))
            c.closeNow()
        }
        let freed = await PanelTest.waitUntil { server.activeAskCount == 0 }
        XCTAssertTrue(freed, "끊긴 질문의 자리가 비어야 해요")
        await backend.gate.open()
    }

    // MARK: 모양

    func testInfoShapeAndNullWhenLoginUnknown() async throws {
        let backend = StubBackend()
        let (_, port) = try await start(backend)
        let r = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/info", port: port))
        XCTAssertEqual(r?.status, 200)
        XCTAssertEqual(r?.headers["content-type"], "application/json; charset=utf-8")
        let obj = try JSONSerialization.jsonObject(with: r!.body) as! [String: Any]
        XCTAssertEqual(Set(obj.keys), ["cli", "cliName", "model", "effortLabel", "loggedIn"])
        XCTAssertEqual(obj["cli"] as? String, "claude")
        XCTAssertEqual(obj["cliName"] as? String, "클로드")
        XCTAssertEqual(obj["model"] as? String, "Sonnet")
        XCTAssertTrue(obj["effortLabel"] is NSNull)
        XCTAssertEqual(obj["loggedIn"] as? Bool, true)

        backend.infoValue = PanelInfo(cli: "chatgpt", cliName: "ChatGPT", model: nil, effortLabel: "높음", loggedIn: nil)
        let r2 = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/info", port: port))
        let obj2 = try JSONSerialization.jsonObject(with: r2!.body) as! [String: Any]
        XCTAssertTrue(obj2["model"] is NSNull)
        XCTAssertEqual(obj2["effortLabel"] as? String, "높음")
        XCTAssertTrue(obj2["loggedIn"] is NSNull)
    }

    func testAskResponseIsChunkedNDJSONWithCORS() async throws {
        let backend = StubBackend()
        let (_, port) = try await start(backend)
        let r = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/ask", port: port, origin: PanelTest.extensionOrigin, body: PanelTest.askBody("안녕?")))
        XCTAssertEqual(r?.status, 200)
        XCTAssertEqual(r?.chunked, true)
        XCTAssertTrue(r?.headers["content-type"]?.hasPrefix("application/x-ndjson") ?? false)
        XCTAssertEqual(r?.headers["access-control-allow-origin"], PanelTest.extensionOrigin)
        XCTAssertEqual(r?.lines, [#"{"t":"delta","text":"안녕"}"#, #"{"t":"done","usage":null}"#])
        XCTAssertEqual(backend.asks.first, PanelQuestion(question: "안녕?", page: PanelPage(title: "제목", url: "https://example.com/a", selection: "", text: "본문"), webSearch: false))
    }

    func testStartAndStopAreIdempotentAndPortIsFreed() async throws {
        let server = PanelServer(token: PanelTest.token, backend: StubBackend())
        XCTAssertNil(server.port)
        let port = try await server.start()
        XCTAssertEqual(server.port, port)
        XCTAssertNotEqual(port, 0)
        server.stop(); server.stop()
        XCTAssertNil(server.port)
        let refused = await PanelTest.waitUntil { RawClient(port: port) == nil }
        XCTAssertTrue(refused)
        do { _ = try await server.start(); XCTFail("멈춘 서버는 다시 켜지지 않아요") } catch { XCTAssertEqual(error as? PanelServerError, .stopped) }
    }

    func testConstantTimeEquals() {
        XCTAssertTrue(PanelLink.constantTimeEquals("abc", "abc"))
        XCTAssertFalse(PanelLink.constantTimeEquals("abc", "abd"))
        XCTAssertFalse(PanelLink.constantTimeEquals("abc", "abcd"))
        // 길이 차이가 256 의 배수여도(하위 8비트만 접으면 0) 통과하지 않는다.
        XCTAssertFalse(PanelLink.constantTimeEquals(PanelTest.token, PanelTest.token + String(repeating: "\0", count: 256)))
        XCTAssertFalse(PanelLink.constantTimeEquals(PanelTest.token + String(repeating: "\0", count: 256), PanelTest.token))
        XCTAssertFalse(PanelLink.constantTimeEquals("", "a"))
        XCTAssertTrue(PanelLink.constantTimeEquals("", ""))
    }

    // MARK: 실제 HTTP 손님 · 쪼개 보낸 요청

    func testURLSessionReadsTheStreamLineByLine() async throws {
        let backend = StubBackend()
        let (_, port) = try await start(backend)
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/ask")!)
        req.httpMethod = "POST"
        req.setValue(PanelTest.token, forHTTPHeaderField: "X-SA-Token")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = PanelTest.askBody("안녕?")
        let (bytes, response) = try await URLSession(configuration: .ephemeral).bytes(for: req)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        var lines: [String] = []
        for try await line in bytes.lines { lines.append(line) }
        XCTAssertEqual(lines, [#"{"t":"delta","text":"안녕"}"#, #"{"t":"done","usage":null}"#])

        var info = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/info")!)
        info.setValue(PanelTest.token, forHTTPHeaderField: "X-SA-Token")
        let (data, r2) = try await URLSession(configuration: .ephemeral).data(for: info)
        XCTAssertEqual((r2 as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual((try JSONSerialization.jsonObject(with: data) as? [String: Any])?["cli"] as? String, "claude")
    }

    func testRequestSplitAcrossManyWritesIsAssembled() async throws {
        let backend = StubBackend()
        let (_, port) = try await start(backend)
        let whole = PanelTest.request("POST", "/ask", port: port, body: PanelTest.askBody("쪼개서"))
        let reply: HTTPReply? = await Task.detached {
            let c = RawClient(port: port)!
            var i = whole.startIndex
            while i < whole.endIndex {
                let j = whole.index(i, offsetBy: 7, limitedBy: whole.endIndex) ?? whole.endIndex
                c.send(whole[i..<j])
                i = j
                usleep(2_000)
            }
            return HTTPReply.parse(c.read(timeout: 5))
        }.value
        XCTAssertEqual(reply?.status, 200)
        XCTAssertEqual(backend.asks.first?.question, "쪼개서")
    }

    func testHugeHeadIs431() async throws {
        let (_, port) = try await start(StubBackend())
        let r = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/info", port: port, extra: ["X-Junk": String(repeating: "a", count: 20_000)]))
        XCTAssertEqual(r?.status, 431)
    }

    func testTokenWithTrailingNULsIsRejectedOverHTTP() async throws {
        let (_, port) = try await start(StubBackend())
        let nuls = String(repeating: "\0", count: 256)
        let r = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/info", port: port, token: PanelTest.token + nuls))
        XCTAssertEqual(r?.status, 403)
    }

    // MARK: Origin 모양 · 읽기 시간 · 연결 수

    func testOnlyHostShapedExtensionOriginsAreEchoed() async throws {
        for ok in [PanelTest.extensionOrigin, "safari-web-extension://abc.def-1", "safari-web-extension://abc:8080"] {
            XCTAssertTrue(PanelServer.isExtensionOrigin(ok), ok)
        }
        for bad in ["safari-web-extension://", "safari-web-extension://a/", "safari-web-extension://a b", "safari-web-extension://a\nSet-Cookie: x=1",
                    "safari-web-extension://a\rb", "safari-web-extension://a:", "safari-web-extension://a:99999x", "safari-web-extension://é",
                    "safari-web-extension://a:1:2", "safari-web-extension://a;b", "SAFARI-web-extension://a", "https://a"] {
            XCTAssertFalse(PanelServer.isExtensionOrigin(bad), bad)
        }
        // 머리에 줄바꿈을 끼워 넣은 Origin — 403 이고, 끼운 머리는 응답에 나오지 않는다.
        let (_, port) = try await start(StubBackend())
        let raw = "GET /info HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\nX-SA-Token: \(PanelTest.token)\r\nOrigin: safari-web-extension://abc\nSet-Cookie: x=1\r\n\r\n"
        let text: String = await Task.detached {
            let c = RawClient(port: port)!
            c.send(raw)
            return String(decoding: c.read(timeout: 5), as: UTF8.self)
        }.value
        XCTAssertTrue(text.hasPrefix("HTTP/1.1 403"), text)
        XCTAssertFalse(text.contains("Set-Cookie"))
        XCTAssertFalse(text.lowercased().contains("access-control-allow-origin"))
    }

    func testClientThatNeverFinishesTheHeadIsCutOffAfterTheReadTimeout() async throws {
        let server = PanelServer(token: PanelTest.token, backend: StubBackend(), readTimeout: 0.4)
        let port = try await server.start()
        addTeardownBlock { server.stop() }
        let started = Date()
        let took: TimeInterval = await Task.detached {
            let c = RawClient(port: port)!
            c.send("GET /info HTTP/1.1\r\nHost:")   // 머리를 끝내지 않는다
            _ = c.read(timeout: 5)                       // 서버가 끊으면 곧 돌아온다
            return Date().timeIntervalSince(started)
        }.value
        XCTAssertLessThan(took, 3, "읽기 시간이 지나면 서버가 끊어야 해요")
        XCTAssertGreaterThanOrEqual(took, 0.3)
        let ok = await PanelTest.roundTrip(port: port, PanelTest.request("GET", "/info", port: port))
        XCTAssertEqual(ok?.status, 200, "다른 손님은 영향 없음")
    }

    func testBodyThatNeverFillsIsCutOffAndReturnsItsAskSlot() async throws {
        let backend = StubBackend()
        let server = PanelServer(token: PanelTest.token, backend: backend, readTimeout: 0.4)
        let port = try await server.start()
        addTeardownBlock { server.stop() }
        let c = try XCTUnwrap(RawClient(port: port))
        c.send(PanelTest.request("POST", "/ask", port: port, body: Data("{\"quest".utf8), lengthOverride: 200))
        let reserved = await PanelTest.waitUntil { server.activeAskCount == 1 }
        XCTAssertTrue(reserved, "머리가 통과하면 자리를 잡는다")
        let freed = await PanelTest.waitUntil(timeout: 3) { server.activeAskCount == 0 }
        XCTAssertTrue(freed, "본문을 못 채운 연결은 시간이 지나면 자리를 돌려줘요")
        XCTAssertEqual(backend.started, 0)
        c.closeNow()
    }

    func testConnectionsOverTheCapAreDroppedAndSpaceFreesUp() async throws {
        let server = PanelServer(token: PanelTest.token, backend: StubBackend(), maxConnections: 2)
        let port = try await server.start()
        addTeardownBlock { server.stop() }
        let first = try XCTUnwrap(RawClient(port: port)), second = try XCTUnwrap(RawClient(port: port))
        // 둘이 서버 목록에 올라갈 때까지(아무것도 안 보낸 채 붙어 있다).
        try await Task.sleep(nanoseconds: 200_000_000)
        let third = try XCTUnwrap(RawClient(port: port))   // 연결은 되지만 서버가 바로 끊는다
        let thirdData = await Task.detached { third.read(timeout: 2) }.value
        XCTAssertTrue(thirdData.isEmpty)
        // 하나를 닫으면 다시 받는다.
        first.closeNow()
        let ok = await PanelTest.waitUntil(timeout: 3) {
            guard let c = RawClient(port: port) else { return false }
            c.send(PanelTest.request("GET", "/info", port: port))
            return HTTPReply.parse(c.read(timeout: 1))?.status == 200
        }
        XCTAssertTrue(ok)
        second.closeNow()
    }

    // MARK: 허락 카드 응답 (/approve)

    func testApproveRequiresToken() async throws {
        let backend = StubBackend()
        backend.validCardIDs = ["card-1"]
        let (_, port) = try await start(backend)
        let body = Data(#"{"cardId":"card-1","answer":"allow"}"#.utf8)
        for token in [nil, "", String(repeating: "cd", count: 32)] {
            let r = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/approve", port: port, token: token, body: body))
            XCTAssertEqual(r?.status, 403, "token=\(token ?? "nil")")
        }
        XCTAssertTrue(backend.approvals.isEmpty)
    }

    func testApproveRejectsBadOrigin() async throws {
        let backend = StubBackend()
        backend.validCardIDs = ["card-1"]
        let (_, port) = try await start(backend)
        let body = Data(#"{"cardId":"card-1","answer":"allow"}"#.utf8)
        let r = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/approve", port: port, origin: "https://evil.example", body: body))
        XCTAssertEqual(r?.status, 403)
        XCTAssertNil(r?.headers["access-control-allow-origin"])
        XCTAssertTrue(backend.approvals.isEmpty)
    }

    func testApproveUnknownCard404() async throws {
        let backend = StubBackend()
        let (_, port) = try await start(backend)
        let body = Data(#"{"cardId":"unknown-id","answer":"deny"}"#.utf8)
        let r = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/approve", port: port, origin: PanelTest.extensionOrigin, body: body))
        XCTAssertEqual(r?.status, 404)
        XCTAssertEqual(r?.headers["access-control-allow-origin"], PanelTest.extensionOrigin)
    }

    func testApproveResolvesCard() async throws {
        let backend = StubBackend()
        backend.validCardIDs = ["card-42"]
        let (_, port) = try await start(backend)
        let body = Data(#"{"cardId":"card-42","answer":"always"}"#.utf8)
        let r = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/approve", port: port, origin: PanelTest.extensionOrigin, body: body))
        XCTAssertEqual(r?.status, 200)
        XCTAssertEqual(r?.text, "{}")
        XCTAssertEqual(r?.headers["access-control-allow-origin"], PanelTest.extensionOrigin)
        XCTAssertEqual(backend.approvals.count, 1)
        XCTAssertEqual(backend.approvals.first?.cardID, "card-42")
        XCTAssertEqual(backend.approvals.first?.answer, .always)
        // 같은 카드를 다시 누르면 이미 닫혀 404
        let again = await PanelTest.roundTrip(port: port, PanelTest.request("POST", "/approve", port: port, body: body))
        XCTAssertEqual(again?.status, 404)
    }
}
