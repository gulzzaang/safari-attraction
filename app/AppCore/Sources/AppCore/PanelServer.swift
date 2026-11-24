import Foundation
import Network

public enum PanelServerError: Error, Equatable {
    case startFailed(String)
    case stopped
}

/// 사파리 확장 패널이 부르는 앱 로컬 서버 — `127.0.0.1` 에만 열리는 최소 HTTP/1.1(`GET /info` · `POST /ask`).
///
/// - 요청은 `X-SA-Token`(상수 시간 비교) · `Host` 가 `127.0.0.1:<포트>` 일 때만, 아니면 403.
///   `Origin` 이 있는데 `safari-web-extension://` 로 시작하지 않아도 403(웹 페이지는 토큰도 모르고 Origin 도 다르다).
///   `Origin` 이 없는 요청은 토큰만 맞으면 받는다.
/// - CORS: `Origin` 이 `safari-web-extension://` 로 시작할 때만 그 값을 그대로 `Access-Control-Allow-Origin` 에 돌려준다
///   (사파리가 실행마다 UUID 를 바꾼다). 403 · 429 · 413 에도 붙여서 확장이 한국어 안내를 읽을 수 있게 한다.
///   OPTIONS 미리 확인은 토큰 없이 Host · Origin 만 본다.
/// - 본문은 256KB 까지(넘으면 413 — 본문은 읽지 않는다), `/ask` 는 동시에 2개까지(셋째는 429).
/// - `/ask` 답은 `Transfer-Encoding: chunked` 로 한 줄(NDJSON)씩 흘린다. 손님이 끊으면 그 질문의 일을 취소한다(실행기 stop).
public final class PanelServer: @unchecked Sendable {
    public static let tokenHeader = "X-SA-Token"
    public static let originPrefix = "safari-web-extension://"
    public static let maxBodyBytes = 256 * 1024
    public static let maxConcurrentAsks = 2
    static let maxHeadBytes = 16 * 1024
    public static let defaultReadTimeout: TimeInterval = 10
    public static let defaultMaxConnections = 64
    static let drainTimeout: TimeInterval = 2
    public static let busyMessage = "다른 질문이 끝나면 다시 시도해 주세요"

    private let token: String
    fileprivate let readTimeout: TimeInterval
    private let maxConnections: Int
    private let backend: PanelBackend
    private let queue = DispatchQueue(label: "SafariAttraction.PanelServer")
    // 아래는 모두 `queue` 에서만 만진다(`port` 읽기만 잠금).
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: Connection] = [:]
    private var activeAsks = 0
    private var stopped = false
    private let portLock = NSLock()
    private var boundPort: UInt16?

    /// `readTimeout` — 연결한 뒤 요청(머리 · 본문)을 이 시간 안에 다 못 보내면 끊는다. `maxConnections` — 동시 연결 수 상한(넘으면 바로 끊는다). 시험이 낮춰 쓴다.
    public init(token: String, backend: PanelBackend, readTimeout: TimeInterval = PanelServer.defaultReadTimeout,
                maxConnections: Int = PanelServer.defaultMaxConnections) {
        self.token = token; self.backend = backend; self.readTimeout = readTimeout; self.maxConnections = maxConnections
    }

    /// `safari-web-extension://` 뒤가 호스트 글자(`A-Z a-z 0-9 . -`)에 선택 `:포트`일 때만 — 값을 응답 머리에 되돌려 주므로 CR · LF 나 다른 글자가 있으면 거절한다.
    static func isExtensionOrigin(_ origin: String) -> Bool {
        guard origin.hasPrefix(originPrefix) else { return false }
        let rest = origin.dropFirst(originPrefix.count)
        let parts = rest.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard let host = parts.first, !host.isEmpty, parts.count <= 2 else { return false }
        func ok(_ c: Character) -> Bool { c.isASCII && (c.isLetter || c.isNumber || c == "." || c == "-") }
        guard host.allSatisfy(ok) else { return false }
        if parts.count == 2 {
            let port = parts[1]
            guard !port.isEmpty, port.count <= 5, port.allSatisfy({ $0.isASCII && $0.isNumber }) else { return false }
        }
        return true
    }

    /// 켜진 뒤의 포트(켜지기 전 · 멈춘 뒤엔 nil).
    public var port: UInt16? { portLock.withLock { boundPort } }

    /// 127.0.0.1 의 빈 포트에서 듣기 시작하고, 준비되면 포트를 돌려준다.
    @discardableResult
    public func start() async throws -> UInt16 {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: NWEndpoint.Host("127.0.0.1"), port: .any)
        let listener: NWListener
        do { listener = try NWListener(using: params) } catch { throw PanelServerError.startFailed(error.localizedDescription) }
        listener.newConnectionHandler = { [weak self] c in self?.accept(c) }
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<UInt16, Error>) in
            let once = Once()
            listener.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    guard let p = listener.port?.rawValue else {
                        if once.take() { cont.resume(throwing: PanelServerError.startFailed("포트를 못 받았어요")) }
                        return
                    }
                    self?.portLock.withLock { self?.boundPort = p }
                    if once.take() { cont.resume(returning: p) }
                case .failed(let e):
                    if once.take() { cont.resume(throwing: PanelServerError.startFailed(e.localizedDescription)) }
                case .cancelled:
                    if once.take() { cont.resume(throwing: PanelServerError.stopped) }
                default: break
                }
            }
            // `stop()` 과 같은 큐에서 확인하고 시작한다 — 멈춘 뒤에 시작하거나, 시작한 뒤 멈추거나 둘 중 하나다.
            queue.sync {
                if stopped { cont.resume(throwing: PanelServerError.stopped); return }
                self.listener = listener
                listener.start(queue: queue)
            }
        }
    }

    /// 듣기를 멈추고 돌고 있는 질문을 모두 취소한다(실행기도 멈춘다). 여러 번 불러도 된다.
    public func stop() {
        let (l, conns): (NWListener?, [Connection]) = queue.sync {
            stopped = true
            let l = listener; listener = nil
            let c = Array(connections.values)
            return (l, c)
        }
        portLock.withLock { boundPort = nil }
        l?.cancel()
        for c in conns { c.shutDown() }
    }

    /// 지금 도는 `/ask` 수(시험용).
    var activeAskCount: Int { queue.sync { activeAsks } }

    fileprivate final class WeakBox: @unchecked Sendable {
        weak var value: Connection?
        init(_ v: Connection) { value = v }
    }

    private final class Once: @unchecked Sendable {
        private let lock = NSLock(); private var used = false
        func take() -> Bool { lock.withLock { if used { return false }; used = true; return true } }
    }

    // MARK: 연결

    private func accept(_ nw: NWConnection) {
        // newConnectionHandler 는 `queue` 에서 불린다.
        if stopped || connections.count >= maxConnections { nw.cancel(); return }
        let c = Connection(server: self, nw: nw)
        connections[ObjectIdentifier(c)] = c
        c.start()
    }

    fileprivate func remove(_ c: Connection) {
        connections[ObjectIdentifier(c)] = nil
    }

    fileprivate func reserveAskSlot() -> Bool {
        if activeAsks >= Self.maxConcurrentAsks { return false }
        activeAsks += 1
        return true
    }
    fileprivate func releaseAskSlot() { activeAsks = max(0, activeAsks - 1) }

    // MARK: 요청 머리

    fileprivate struct Head {
        var method: String
        var path: String
        var headers: [String: String]   // 이름은 소문자
    }

    fileprivate static func parseHead(_ data: Data) -> Head? {
        let text = String(decoding: data, as: UTF8.self)
        var lines = text.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }
        let first = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: true)
        guard first.count == 3, first[2].hasPrefix("HTTP/1.") else { return nil }
        var path = String(first[1])
        if let q = path.firstIndex(where: { $0 == "?" || $0 == "#" }) { path = String(path[..<q]) }
        var headers: [String: String] = [:]
        for line in lines where !line.isEmpty {
            guard let colon = line.firstIndex(of: ":") else { return nil }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty else { return nil }
            headers[name] = value
        }
        return Head(method: String(first[0]).uppercased(), path: path, headers: headers)
    }

    /// 헤더만으로 가려낸다 — 통과하면 nil, 아니면 보낼 상태 코드.
    fileprivate func authorize(_ head: Head, port: UInt16?) -> (status: Int, message: String)? {
        guard let port, head.headers["host"]?.lowercased() == "127.0.0.1:\(port)" else { return (403, "허락되지 않은 요청이에요") }
        if let origin = head.headers["origin"], !Self.isExtensionOrigin(origin) { return (403, "허락되지 않은 요청이에요") }
        let given = head.headers[Self.tokenHeader.lowercased()] ?? ""
        guard PanelLink.constantTimeEquals(given, token) else { return (403, "허락되지 않은 요청이에요") }
        return nil
    }

    fileprivate func corsHeaders(for head: Head) -> [(String, String)] {
        guard let origin = head.headers["origin"], Self.isExtensionOrigin(origin) else { return [] }
        return [("Access-Control-Allow-Origin", origin), ("Vary", "Origin")]
    }

    // MARK: 연결 하나

    /// 연결 하나의 상태 — 모든 메서드는 서버 `queue` 에서만 불린다.
    fileprivate final class Connection: @unchecked Sendable {
        enum Phase { case head, body, responding, draining, closed }

        let server: PanelServer   // 연결이 닫힐 때 서버 목록에서 빠지므로 순환은 끊긴다
        let nw: NWConnection
        var phase: Phase = .head
        var buffer = Data()
        var head: Head?
        var cors: [(String, String)] = []
        var expectedBody = 0
        var holdsSlot = false
        var askTask: Task<Void, Never>?
        var timer: DispatchWorkItem?

        init(server: PanelServer, nw: NWConnection) { self.server = server; self.nw = nw }

        func start() {
            nw.stateUpdateHandler = { [weak self] state in
                switch state {
                case .failed, .cancelled: self?.gone()
                default: break
                }
            }
            nw.start(queue: server.queue)
            armTimer(server.readTimeout) { [weak self] in self?.cancelAll() }
            receive()
        }

        /// 서버가 멈출 때.
        func shutDown() {
            server.queue.sync { cancelAll() }
        }

        func armTimer(_ seconds: TimeInterval, _ work: @escaping () -> Void) {
            timer?.cancel()
            let item = DispatchWorkItem(block: work)
            timer = item
            server.queue.asyncAfter(deadline: .now() + seconds, execute: item)
        }

        func receive() {
            nw.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
                guard let self else { return }
                if self.phase == .closed { return }
                if let data, !data.isEmpty { self.onData(data) }
                if self.phase == .closed { return }
                if error != nil || isComplete {
                    // 손님이 끊었다(또는 반쪽을 닫았다).
                    self.cancelAll()
                    return
                }
                self.receive()
            }
        }

        func onData(_ data: Data) {
            switch phase {
            case .head:
                buffer.append(data)
                tryParseHead()
            case .body:
                buffer.append(data)
                tryFinishBody()
            case .responding, .draining, .closed:
                break   // 더 받을 것이 없다 — 버린다(끊김은 receive 가 안다)
            }
        }

        func tryParseHead() {
            guard let range = buffer.range(of: Data("\r\n\r\n".utf8)) else {
                if buffer.count > PanelServer.maxHeadBytes { respond(431, "요청 머리가 너무 커요") }
                return
            }
            let headData = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
            buffer = Data(buffer.suffix(from: range.upperBound))
            if headData.count > PanelServer.maxHeadBytes { respond(431, "요청 머리가 너무 커요"); return }
            guard let h = PanelServer.parseHead(headData) else {
                respond(400, "요청을 읽지 못했어요"); return
            }
            head = h
            cors = server.corsHeaders(for: h)
            let port = server.port

            if h.method == "OPTIONS" {
                // 미리 확인 — 토큰은 없다. Host · Origin 만 본다.
                let hostOK = port != nil && h.headers["host"]?.lowercased() == "127.0.0.1:\(port!)"
                guard hostOK, !cors.isEmpty else { respond(403, "허락되지 않은 요청이에요"); return }
                respond(204, nil, extra: [("Access-Control-Allow-Methods", "GET, POST"),
                                          ("Access-Control-Allow-Headers", "X-SA-Token, Content-Type"),
                                          ("Access-Control-Max-Age", "600")])
                return
            }
            if let denied = server.authorize(h, port: port) { respond(denied.status, denied.message); return }

            switch (h.method, h.path) {
            case ("GET", "/info"):
                answerInfo()
            case ("POST", "/ask"):
                if h.headers["transfer-encoding"] != nil { respond(411, "Content-Length 로 보내 주세요"); return }
                guard let length = Int(h.headers["content-length"] ?? ""), length >= 0 else { respond(411, "Content-Length 로 보내 주세요"); return }
                if length > PanelServer.maxBodyBytes { respond(413, "질문이 너무 길어요"); return }
                guard server.reserveAskSlot() else { respond(429, PanelServer.busyMessage); return }
                holdsSlot = true
                expectedBody = length
                phase = .body
                tryFinishBody()
            case (_, "/info"), (_, "/ask"):
                respond(405, "허락되지 않은 방식이에요")
            default:
                respond(404, "없는 주소예요")
            }
        }

        func tryFinishBody() {
            guard phase == .body, buffer.count >= expectedBody else { return }
            let body = buffer.prefix(expectedBody)
            buffer = Data()
            guard let question = PanelQuestion.parse(Data(body)) else { respond(400, "질문을 읽지 못했어요"); return }
            answerAsk(question)
        }

        // MARK: 답

        func answerInfo() {
            phase = .responding
            timer?.cancel()
            let backend = server.backend
            let box = WeakBox(self)
            let queue = server.queue
            askTask = Task {
                let info = await backend.info()
                queue.async {
                    guard let c = box.value, c.phase != .closed else { return }
                    c.respondJSON(200, info.jsonData())
                }
            }
        }

        func answerAsk(_ question: PanelQuestion) {
            phase = .responding
            timer?.cancel()
            var lines = "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson; charset=utf-8\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n"
            for (k, v) in cors { lines += "\(k): \(v)\r\n" }
            lines += "\r\n"
            send(Data(lines.utf8), final: false)
            let backend = server.backend
            let queue = server.queue
            let box = WeakBox(self)
            askTask = Task {
                await backend.ask(question) { line in
                    queue.async { box.value?.sendChunk(line.ndjson()) }
                }
                queue.async { box.value?.endChunks() }
            }
        }

        func sendChunk(_ data: Data) {
            guard phase == .responding else { return }
            var out = Data(String(data.count, radix: 16).utf8)
            out.append(contentsOf: [0x0D, 0x0A]); out.append(data); out.append(contentsOf: [0x0D, 0x0A])
            send(out, final: false)
        }

        func endChunks() {
            guard phase == .responding else { return }
            send(Data("0\r\n\r\n".utf8), final: true)
            beginDraining()
        }

        func respondJSON(_ status: Int, _ body: Data) {
            writeResponse(status, body: body, contentType: "application/json; charset=utf-8", extra: [])
        }

        func respond(_ status: Int, _ message: String?, extra: [(String, String)] = []) {
            guard phase != .closed else { return }
            if let message {
                writeResponse(status, body: PanelJSON.encode(["error": message]), contentType: "application/json; charset=utf-8", extra: extra)
            } else {
                writeResponse(status, body: Data(), contentType: nil, extra: extra)
            }
        }

        func writeResponse(_ status: Int, body: Data, contentType: String?, extra: [(String, String)]) {
            guard phase != .closed else { return }
            var s = "HTTP/1.1 \(status) \(PanelServer.reason(status))\r\n"
            if let contentType { s += "Content-Type: \(contentType)\r\n" }
            s += "Content-Length: \(body.count)\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n"
            for (k, v) in cors + extra { s += "\(k): \(v)\r\n" }
            s += "\r\n"
            var out = Data(s.utf8); out.append(body)
            phase = .responding
            send(out, final: true)
            beginDraining()
        }

        func send(_ data: Data, final: Bool) {
            nw.send(content: data, contentContext: final ? .finalMessage : .defaultMessage, isComplete: true,
                    completion: .contentProcessed { [weak self] error in
                        guard error != nil, let self else { return }
                        self.server.queue.async { self.cancelAll() }
                    })
        }

        /// 답을 다 보냈다 — 손님이 안 읽은 요청 글이 남아 있을 때 바로 닫으면 답이 날아갈 수 있어서, 손님이 닫을 때까지(최대 2초) 읽어 버린다.
        func beginDraining() {
            phase = .draining
            releaseSlot()
            armTimer(PanelServer.drainTimeout) { [weak self] in self?.cancelAll() }
        }

        func releaseSlot() {
            if holdsSlot { holdsSlot = false; server.releaseAskSlot() }
        }

        /// 손님이 끊었거나 오류 — 하던 질문을 취소하고(실행기 stop) 정리한다.
        func gone() {
            server.queue.async { [self] in cancelAll() }
        }

        func cancelAll() {
            if phase == .closed { return }
            phase = .closed
            timer?.cancel(); timer = nil
            askTask?.cancel(); askTask = nil
            releaseSlot()
            nw.cancel()
            server.remove(self)
        }
    }

    fileprivate static func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 204: return "No Content"
        case 400: return "Bad Request"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        case 411: return "Length Required"
        case 413: return "Payload Too Large"
        case 429: return "Too Many Requests"
        case 431: return "Request Header Fields Too Large"
        default: return "Error"
        }
    }
}
