import Foundation

/// 페이지 패널 서버 + 연결 파일을 한 덩어리로 켜고 끈다 — 앱이 켜질 때 `start`, 꺼질 때 `shutdown`.
/// 켜질 때마다 새 토큰 · 새 포트로 `<지원 폴더>/panel-link.json` 을 쓰고, 꺼질 때(`shutdown`) 지운다.
public final class PanelHost: @unchecked Sendable {
    private let directory: URL
    private let backend: PanelBackend
    private let alerts: PanelAlertHandling?
    private let lock = NSLock()
    private var server: PanelServer?
    private var stopped = false

    /// `directory` 는 앱 지원 폴더(`AppPaths.supportDirectory()`) — 시험은 임시 폴더를 넘긴다.
    /// `alerts` — 사이트 알림 길(`/alert-hosts` · `/alert`)을 받는 쪽(앱에서는 `PanelAlertRelay`).
    public init(directory: URL, backend: PanelBackend, alerts: PanelAlertHandling? = nil) {
        self.directory = directory; self.backend = backend; self.alerts = alerts
    }

    /// 서버가 듣고 있는 포트(켜지기 전 · 멈춘 뒤엔 nil).
    public var port: UInt16? { lock.withLock { server }?.port }

    /// 서버를 켜고 연결 파일을 쓴다. 이미 `shutdown` 이 불렸으면 아무것도 남기지 않고 `PanelServerError.stopped`.
    public func start() async throws {
        let token = try PanelLink.makeToken()
        let server = PanelServer(token: token, backend: backend, alerts: alerts)
        let alreadyStopped: Bool = lock.withLock {
            if stopped { return true }
            self.server = server
            return false
        }
        if alreadyStopped { throw PanelServerError.stopped }
        PanelLink.remove(in: directory)   // 지난번에 죽으며 남은 옛 파일
        do {
            let port = try await server.start()
            try lock.withLock {
                guard !stopped else { throw PanelServerError.stopped }
                try PanelLink.write(port: port, token: token, in: directory)
            }
        } catch {
            server.stop()
            throw error
        }
    }

    /// 서버를 멈추고(도는 질문의 실행기도 멈춘다) 연결 파일을 지운다. 켜지는 중이어도 된다.
    public func shutdown() {
        let s: PanelServer? = lock.withLock {
            stopped = true
            let s = server; server = nil
            PanelLink.remove(in: directory)
            return s
        }
        s?.stop()
    }
}
