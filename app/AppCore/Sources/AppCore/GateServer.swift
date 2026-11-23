import Foundation
import Security

/// 관문 손님(MCP 서버)이 보낸 동작 허락 요청 한 건.
public struct GateRequest: Sendable, Equatable {
    public let id: String
    public let host: String
    public let url: String
    public let action: String
    public let target: String
    public let value: String
    /// 되돌릴 수 없으면 true, 아니면 false, 알 수 없으면 nil.
    public let irreversible: Bool?

    public init(id: String, host: String, url: String, action: String, target: String, value: String, irreversible: Bool?) {
        self.id = id; self.host = host; self.url = url; self.action = action
        self.target = target; self.value = value; self.irreversible = irreversible
    }
}

/// 요청에 대한 답.
public struct GateDecision: Sendable, Equatable {
    public let allow: Bool
    public let reason: String?

    public init(allow: Bool, reason: String? = nil) {
        self.allow = allow; self.reason = reason
    }
    public static let allow = GateDecision(allow: true)
    public static func deny(_ reason: String) -> GateDecision { GateDecision(allow: false, reason: reason) }
}

public enum GateServerError: Error, Equatable {
    case randomFailed
    case pathTooLong(String)
    case socketFailed(String)
}

/// 동작 관문 — 유닉스 소켓 서버. MCP 서버가 페이지를 바꾸는 동작 직전에 한 줄 JSON 으로 묻고 답 한 줄을 기다린다.
///
/// - 자리: `<directory>/gate/s.sock`(`gate/` 는 0700). 경로가 103바이트를 넘으면(`sun_path` 한계) `NSTemporaryDirectory()` 아래 새 0700 폴더를 쓴다.
///   `directory` 는 앱 지원 폴더(`AppPaths.supportDirectory()`).
/// - 인스턴스마다 새 토큰(32바이트 무작위 → 소문자 16진 64자). 틀린 토큰 · 깨진 줄은 거절(id 를 읽을 수 있으면 id 를 붙여)하고 그 연결을 끊는다.
/// - 한 연결 = 한 요청. 요청마다 따로 기다리고(동시 요청 가능) 시간 상한은 부르는 쪽(뷰모델)이 둔다.
///   기다리는 동안 손님이 끊으면 `onRequest` 를 돌리는 Task 를 취소한다(`Task.isCancelled` · `withTaskCancellationHandler` 로 알 수 있음).
///   손님은 요청을 보낸 뒤 연결을 닫지 말아야 한다(반쪽 닫기도 끊김으로 본다).
/// - `stop()`: 기다리는 요청은 `{"allow":false,"reason":"멈췄어요"}`, 소켓 닫기 · 파일 지우기. 이후 새 연결은 거절된다.
public final class GateServer: @unchecked Sendable {
    public static let stoppedReason = "멈췄어요"
    static let maxSunPathBytes = 103
    static let maxLineBytes = 64 * 1024
    static let maxConnections = 64
    static let requestReadTimeout: TimeInterval = 5

    public let info: GateInfo

    private let socketURL: URL
    private let ownedTempDirectory: URL?
    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSource?
    private let acceptQueue = DispatchQueue(label: "SafariAttraction.GateServer.accept")
    private let lock = NSLock()
    private var handler: (@Sendable (GateRequest) async -> GateDecision)?
    private var connections: [ObjectIdentifier: Connection] = [:]
    private var started = false
    private var stopped = false

    public init(directory: URL) throws {
        let token = try Self.makeToken()
        let fm = FileManager.default
        var gateDir = directory.appendingPathComponent("gate", isDirectory: true)
        var owned: URL? = nil
        if gateDir.appendingPathComponent("s.sock").path.utf8.count > Self.maxSunPathBytes {
            let tmp = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            var template = Array(tmp.appendingPathComponent("sa-gate-XXXXXX").path.utf8CString)
            guard mkdtemp(&template) != nil else { throw GateServerError.socketFailed("임시 폴더를 만들지 못했어요") }
            gateDir = URL(fileURLWithPath: String(decoding: template.dropLast().map { UInt8(bitPattern: $0) }, as: UTF8.self), isDirectory: true)
            owned = gateDir
            if gateDir.appendingPathComponent("s.sock").path.utf8.count > Self.maxSunPathBytes {
                try? fm.removeItem(at: gateDir)
                throw GateServerError.pathTooLong(gateDir.path)
            }
        } else {
            try fm.createDirectory(at: gateDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        // 이미 있던 폴더도 0700 으로 조인다.
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: gateDir.path)
        let sock = gateDir.appendingPathComponent("s.sock")
        self.socketURL = sock
        self.ownedTempDirectory = owned
        self.info = GateInfo(socketPath: sock.path, token: token)
        do {
            try bindAndListen()
        } catch {
            if let owned { try? fm.removeItem(at: owned) }
            throw error
        }
    }

    deinit { stop() }

    // MARK: 시작 · 멈춤

    /// 연결을 받기 시작한다. 요청마다 `onRequest` 가 따로 불리고, 돌려준 답이 손님에게 간다.
    public func start(onRequest: @escaping @Sendable (GateRequest) async -> GateDecision) {
        lock.lock()
        if started || stopped { lock.unlock(); return }
        started = true
        handler = onRequest
        let fd = listenFD
        lock.unlock()

        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: acceptQueue)
        source.setEventHandler { [weak self] in self?.acceptReady(fd) }
        source.setCancelHandler { close(fd) }
        lock.lock()
        acceptSource = source as? DispatchSource
        lock.unlock()
        source.resume()
    }

    public func stop() {
        lock.lock()
        if stopped { lock.unlock(); return }
        stopped = true
        let conns = Array(connections.values)
        let source = acceptSource
        acceptSource = nil
        let fd = listenFD
        listenFD = -1
        handler = nil
        lock.unlock()

        // 새 연결이 더 못 들어오게 파일부터 지운다.
        unlink(socketURL.path)
        if let source {
            source.cancel()          // 취소 처리기가 소켓을 닫는다
        } else if fd >= 0 {
            close(fd)                // start 전에 멈춘 경우
        }
        for c in conns { c.stop() }
        if let owned = ownedTempDirectory { try? FileManager.default.removeItem(at: owned) }
    }

    // MARK: 소켓

    private func bindAndListen() throws {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw GateServerError.socketFailed("socket: \(String(cString: strerror(errno)))") }
        func fail(_ what: String) -> GateServerError {
            let e = GateServerError.socketFailed("\(what): \(String(cString: strerror(errno)))")
            close(fd)
            return e
        }
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        let flags = fcntl(fd, F_GETFL)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
        guard var addr = Self.makeAddress(socketURL.path) else { close(fd); throw GateServerError.pathTooLong(socketURL.path) }
        unlink(socketURL.path)   // 남은 옛 파일 치우기
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        if rc != 0 { throw fail("bind") }
        chmod(socketURL.path, 0o600)
        if listen(fd, 64) != 0 { unlink(socketURL.path); throw fail("listen") }
        listenFD = fd
    }

    static func makeAddress(_ path: String) -> sockaddr_un? {
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count <= maxSunPathBytes else { return nil }
        withUnsafeMutableBytes(of: &addr.sun_path) { buf in
            for (i, b) in bytes.enumerated() { buf[i] = b }
            buf[bytes.count] = 0
        }
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        return addr
    }

    private func acceptReady(_ lfd: Int32) {
        while true {
            let cfd = accept(lfd, nil, nil)
            if cfd < 0 { return }   // EAGAIN 이면 다 받음, 닫혔으면 끝
            var one: Int32 = 1
            setsockopt(cfd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            _ = fcntl(cfd, F_SETFD, FD_CLOEXEC)
            // 같은 사용자의 연결만(폴더가 0700 이라 이미 막히지만 한 번 더).
            var uid: uid_t = 0, gid: gid_t = 0
            guard getpeereid(cfd, &uid, &gid) == 0, uid == geteuid() else { close(cfd); continue }
            var send = timeval(tv_sec: 5, tv_usec: 0)
            setsockopt(cfd, SOL_SOCKET, SO_SNDTIMEO, &send, socklen_t(MemoryLayout<timeval>.size))

            let conn = Connection(fd: cfd)
            lock.lock()
            if stopped || connections.count >= Self.maxConnections {
                lock.unlock()
                close(cfd)
                continue
            }
            connections[ObjectIdentifier(conn)] = conn
            lock.unlock()
            Thread.detachNewThread { [self] in
                serve(conn)
                lock.lock(); connections[ObjectIdentifier(conn)] = nil; lock.unlock()
            }
        }
    }

    // MARK: 연결 하나

    private enum ParseResult {
        case request(GateRequest)
        case malformed(id: String?, reason: String)
    }

    private func serve(_ conn: Connection) {
        defer { conn.finish() }
        switch conn.readLine(maxBytes: Self.maxLineBytes, timeout: Self.requestReadTimeout) {
        case .line(let data):
            switch parse(data) {
            case .malformed(let id, let reason):
                conn.reply(id: id, .deny(reason))
            case .request(let req):
                lock.lock(); let h = handler; lock.unlock()
                guard let h else { conn.reply(id: req.id, .deny(Self.stoppedReason)); return }
                let task = Task.detached { [conn] in
                    let decision = await h(req)
                    conn.reply(id: req.id, decision)
                }
                if !conn.attach(task: task, id: req.id) { return }   // 이미 멈춤
                conn.waitUntilRepliedOrGone()
            }
        case .stopped:
            break   // stop() 이 이미 거절을 보냈다
        case .tooLong:
            conn.reply(id: nil, .deny("요청이 너무 길어요"))
        case .closed, .failed:
            break
        }
    }

    private func parse(_ data: Data) -> ParseResult {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .malformed(id: nil, reason: "요청을 읽지 못했어요")
        }
        let id = obj["id"] as? String
        let token = obj["token"] as? String ?? ""
        guard Self.constantTimeEquals(token, info.token) else {
            return .malformed(id: id, reason: "허락되지 않은 연결이에요")
        }
        guard let v = obj["v"] as? NSNumber, CFGetTypeID(v) != CFBooleanGetTypeID(), v.intValue == 1 else {
            return .malformed(id: id, reason: "모르는 요청 형식이에요")
        }
        guard let id, !id.isEmpty, let action = obj["action"] as? String else {
            return .malformed(id: id, reason: "요청을 읽지 못했어요")
        }
        func text(_ key: String) -> String? {
            guard let v = obj[key] else { return "" }
            if v is NSNull { return "" }
            return v as? String
        }
        guard let host = text("host"), let url = text("url"), let target = text("target"), let value = text("value") else {
            return .malformed(id: id, reason: "요청을 읽지 못했어요")
        }
        var irreversible: Bool? = nil
        if let raw = obj["irreversible"], !(raw is NSNull) {
            guard let n = raw as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else {
                return .malformed(id: id, reason: "요청을 읽지 못했어요")
            }
            irreversible = n.boolValue
        }
        return .request(GateRequest(id: id, host: host, url: url, action: action, target: target, value: value, irreversible: irreversible))
    }

    // MARK: 도우미

    static func makeToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw GateServerError.randomFailed }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// 길이가 달라도 끝까지 훑는 비교(시간으로 토큰을 알아내지 못하게).
    static func constantTimeEquals(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        var diff = x.count ^ y.count
        for i in 0..<max(x.count, y.count) {
            let p: UInt8 = i < x.count ? x[i] : 0
            let q: UInt8 = i < y.count ? y[i] : 0
            diff |= Int(p ^ q)
        }
        return diff == 0
    }
}

/// 연결 하나 — 답은 한 번만 쓰고, 답 · 끊김 · 멈춤이 겹쳐도 안전하게 정리한다.
private final class Connection: @unchecked Sendable {
    enum ReadResult { case line(Data), tooLong, closed, stopped, failed }

    private let fd: Int32
    private let lock = NSLock()
    private var requestID: String?
    private var replied = false
    private var finished = false
    private var stopRequested = false
    private var task: Task<Void, Never>?

    init(fd: Int32) { self.fd = fd }

    /// 한 줄을 읽는다(처음 줄바꿈까지). 100ms 마다 멈춤 요청을 본다.
    func readLine(maxBytes: Int, timeout: TimeInterval) -> ReadResult {
        let deadline = Date().addingTimeInterval(timeout)
        var buffer = Data()
        var tmp = [UInt8](repeating: 0, count: 4096)
        while true {
            if isStopRequested { return .stopped }
            if Date() >= deadline { return .failed }
            var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let pr = poll(&p, 1, 100)
            if pr < 0 { if errno == EINTR { continue }; return .failed }
            if pr == 0 { continue }
            let n = read(fd, &tmp, tmp.count)
            if n == 0 { return .closed }
            if n < 0 { if errno == EINTR || errno == EAGAIN { continue }; return .failed }
            if let nl = tmp[0..<n].firstIndex(of: 0x0A) {
                buffer.append(contentsOf: tmp[0..<nl])
                return buffer.count > maxBytes ? .tooLong : .line(buffer)
            }
            buffer.append(contentsOf: tmp[0..<n])
            if buffer.count > maxBytes { return .tooLong }
        }
    }

    private var isStopRequested: Bool { lock.lock(); defer { lock.unlock() }; return stopRequested }

    /// 요청 처리 Task 를 붙인다. 이미 멈췄으면 거절을 보내고 false.
    func attach(task: Task<Void, Never>, id: String) -> Bool {
        lock.lock()
        requestID = id
        if stopRequested {
            lock.unlock()
            task.cancel()
            return false
        }
        self.task = task
        lock.unlock()
        return true
    }

    /// 답이 나가거나 손님이 끊거나 멈출 때까지 기다린다. 손님이 답 전에 끊으면 Task 를 취소한다.
    func waitUntilRepliedOrGone() {
        var tmp = [UInt8](repeating: 0, count: 256)
        while true {
            lock.lock(); let done = replied || stopRequested; lock.unlock()
            if done { return }
            var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let pr = poll(&p, 1, 200)
            if pr < 0 { if errno == EINTR { continue }; break }
            if pr == 0 { continue }
            let n = read(fd, &tmp, tmp.count)
            if n > 0 { continue }   // 군더더기는 버린다
            if n < 0 && (errno == EINTR || errno == EAGAIN) { continue }
            break                   // EOF · 오류 = 끊김
        }
        lock.lock(); let t = task; lock.unlock()
        t?.cancel()
    }

    /// 답 한 줄을 쓴다(한 번만). id 를 모르면 생략한다.
    func reply(id: String?, _ decision: GateDecision) {
        lock.lock(); defer { lock.unlock() }
        guard !replied, !finished else { return }
        replied = true
        var obj: [String: Any] = ["allow": decision.allow]
        if let id = id ?? requestID { obj["id"] = id }
        if !decision.allow { obj["reason"] = decision.reason ?? "허락하지 않았어요" }
        guard var data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes]) else { return }
        data.append(0x0A)
        data.withUnsafeBytes { raw in
            var off = 0
            while off < raw.count {
                let n = send(fd, raw.baseAddress! + off, raw.count - off, 0)
                if n > 0 { off += n; continue }
                if n < 0 && errno == EINTR { continue }
                return   // 끊겼거나 쓰기 시간 초과 — 포기
            }
        }
    }

    /// stop() — 아직 답이 안 나갔으면 「멈췄어요」 거절을 보내고 Task 를 취소한다.
    func stop() {
        lock.lock(); stopRequested = true; let t = task; lock.unlock()
        reply(id: nil, .deny(GateServer.stoppedReason))
        t?.cancel()
    }

    /// 읽는 쪽이 끝날 때 — 더는 쓰지 못하게 하고 닫는다.
    func finish() {
        lock.lock()
        finished = true
        let t = task
        lock.unlock()
        // 답 없이 끝나는 경우(끊김 · 거절을 이미 보낸 경우)에는 남은 Task 를 정리한다.
        t?.cancel()
        close(fd)
    }
}
