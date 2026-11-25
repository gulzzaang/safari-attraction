import Foundation

/// 지금 사파리 도구 자리(관문)를 쥐고 있는 쪽 — 안내 문구를 고르는 데 쓴다.
public enum GateHolder: Sendable, Equatable {
    case routine(String)
    case lease(UUID)

    /// 자리를 얻지 못한 질문에 보일 고정 안내 문구.
    public var busyNotice: String {
        switch self {
        case .routine(let name):
            return "루틴 「\(name)」 이 도는 중이라 이번 답은 사파리를 움직이지 않아요"
        case .lease:
            return "다른 질문이 사파리를 쓰는 중이라 이번 답은 사파리를 움직이지 않아요"
        }
    }
}

/// 사파리 도구 자리 하나 — 끝나면(정상 · 오류 · 멈춤 · 취소) 반드시 `release()` 한다. 두 번 불러도 안전하다.
public final class GateLease: Sendable {
    public let id: UUID
    private let lock = NSLock()
    private nonisolated(unsafe) var released = false
    private let onRelease: @Sendable () -> Void

    init(id: UUID, onRelease: @escaping @Sendable () -> Void) {
        self.id = id
        self.onRelease = onRelease
    }

    deinit {
        release()
    }

    public func release() {
        let shouldRun = lock.withLock { () -> Bool in
            guard !released else { return false }
            released = true
            return true
        }
        if shouldRun { onRelease() }
    }
}

/// 앱이 켜져 있는 동안 띄우는 공용 동작 관문 — 한 번에 질문 하나만 사파리 도구 자리(`GateLease`)를 쥔다.
/// 소켓 경로와 토큰은 `gate-link.json`(0600)으로만 넘기고, 앱을 끌 때 지운다.
@MainActor
public final class InteractiveGate {
    public nonisolated static let noHolderReason = "지금 사파리를 움직이는 질문이 없어요"

    private typealias RequestHandler = @MainActor (GateRequest) async -> GateDecision

    /// `GateLease.release()` 가 어느 스레드에서 불려도 즉시 자리를 풀 수 있게 잠금으로 보호하는 상태.
    private final class LeaseBox: @unchecked Sendable {
        private let lock = NSLock()
        private var activeID: UUID?
        private var activeHandler: RequestHandler?
        private var shutDown = false

        var currentID: UUID? { lock.withLock { activeID } }
        var currentHandler: RequestHandler? { lock.withLock { shutDown ? nil : activeHandler } }
        var isShutDown: Bool { lock.withLock { shutDown } }

        func acquire(handler: @escaping RequestHandler) -> UUID? {
            lock.withLock {
                guard !shutDown, activeID == nil else { return nil }
                let id = UUID()
                activeID = id
                activeHandler = handler
                return id
            }
        }

        func release(id: UUID) {
            lock.withLock {
                guard activeID == id else { return }
                activeID = nil
                activeHandler = nil
            }
        }

        func markShutDown() {
            lock.withLock {
                shutDown = true
                activeID = nil
                activeHandler = nil
            }
        }
    }

    /// 기다리는 관문 요청 하나 — 핸들러 답 · 앱 종료 · 손님 끊김 중 먼저 오는 쪽으로 한 번만 끝낸다.
    private final class PendingRequest: @unchecked Sendable {
        private let lock = NSLock()
        private var result: GateDecision?
        private var continuation: CheckedContinuation<GateDecision, Never>?
        private var task: Task<Void, Never>?

        func setTask(_ t: Task<Void, Never>) {
            let cancelNow = lock.withLock { () -> Bool in
                if result != nil { return true }
                task = t
                return false
            }
            if cancelNow { t.cancel() }
        }

        func resolve(_ decision: GateDecision) {
            let (cont, t) = lock.withLock { () -> (CheckedContinuation<GateDecision, Never>?, Task<Void, Never>?) in
                guard result == nil else { return (nil, nil) }
                result = decision
                let c = continuation; continuation = nil
                let t = task; task = nil
                return (c, t)
            }
            t?.cancel()
            cont?.resume(returning: decision)
        }

        func wait() async -> GateDecision {
            await withCheckedContinuation { c in
                let ready = lock.withLock { () -> GateDecision? in
                    if let r = result { return r }
                    continuation = c
                    return nil
                }
                if let ready { c.resume(returning: ready) }
            }
        }
    }

    private let support: URL
    private let makeServer: @MainActor () throws -> GateServing
    private let routineName: @MainActor () -> String?
    private let leaseBox = LeaseBox()
    private var server: GateServing?
    private var pending: [UUID: PendingRequest] = [:]

    public init(support: URL,
                makeServer: @escaping @MainActor () throws -> GateServing,
                routineName: @escaping @MainActor () -> String? = { nil }) {
        self.support = support
        self.makeServer = makeServer
        self.routineName = routineName
    }

    /// 지금 사파리 도구 자리를 쥔 쪽(루틴 우선). 없으면 nil.
    public var holder: GateHolder? {
        if let name = routineName() { return .routine(name) }
        if let id = leaseBox.currentID { return .lease(id) }
        return nil
    }

    /// 관문 서버를 켜고 `gate-link.json`(0600)을 쓴다.
    public func start() throws {
        guard server == nil, !leaseBox.isShutDown else { return }
        let s = try makeServer()
        do {
            try GateLink.write(s.info, support: support)
        } catch {
            s.stop()
            throw error
        }
        server = s
        s.start { [weak self] req in
            guard let self else { return .deny(GateServer.stoppedReason) }
            return await self.route(req)
        }
    }

    /// 기다리는 요청을 모두 거절하고 서버를 멈춘 뒤 `gate-link.json` 을 지운다.
    public func shutdown() {
        leaseBox.markShutDown()
        let active = Array(pending.values)
        pending.removeAll()
        for item in active { item.resolve(.deny(GateServer.stoppedReason)) }
        server?.stop()
        server = nil
        GateLink.remove(support: support)
    }

    /// 사파리 도구 자리를 얻는다. 루틴이 돌거나 다른 질문이 이미 쥐고 있거나 닫혔으면 nil.
    public func acquire(handler: @escaping @MainActor (GateRequest) async -> GateDecision) -> GateLease? {
        guard routineName() == nil else { return nil }
        guard let id = leaseBox.acquire(handler: handler) else { return nil }
        let box = leaseBox
        return GateLease(id: id) { box.release(id: id) }
    }

    private nonisolated func route(_ req: GateRequest) async -> GateDecision {
        let entry: (id: UUID, pending: PendingRequest)? = await MainActor.run {
            guard !self.leaseBox.isShutDown else { return nil }
            guard let handler = self.leaseBox.currentHandler else { return nil }
            let id = UUID()
            let p = PendingRequest()
            self.pending[id] = p
            let task = Task { @MainActor in
                let decision = await handler(req)
                p.resolve(decision)
            }
            p.setTask(task)
            return (id, p)
        }
        guard let entry else {
            return leaseBox.isShutDown ? .deny(GateServer.stoppedReason) : .deny(Self.noHolderReason)
        }
        let decision = await withTaskCancellationHandler {
            await entry.pending.wait()
        } onCancel: {
            entry.pending.resolve(.deny(GateServer.stoppedReason))
        }
        await MainActor.run {
            _ = self.pending.removeValue(forKey: entry.id)
        }
        return decision
    }
}
