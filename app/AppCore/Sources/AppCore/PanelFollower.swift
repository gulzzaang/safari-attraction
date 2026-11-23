import Foundation
import CoreGraphics

/// 따라가기가 옆 창에 내리는 명령(AppKit 좌표).
public enum PanelCommand: Sendable, Equatable {
    case show(CGRect)
    case hide
}

public protocol TickCancelling: Sendable { func cancel() }

/// 일정 간격으로 `fire` 를 부른다 — 시험에서는 가짜로 갈아 끼운다.
public protocol TickScheduling: Sendable {
    func every(_ interval: TimeInterval, _ fire: @escaping @Sendable () -> Void) -> TickCancelling
}

/// 0.5초마다 사파리를 살펴 옆 창이 있어야 할 자리 · 숨김 여부를 `onCommand` 로 알린다.
///
/// - 사파리가 앞일 때만 창 위치를 읽는다(앞이 아니면 AppleEvent 를 보내지 않는다).
/// - 사파리가 없으면 주 화면 오른쪽 기본 자리. 사파리가 앞인데 위치를 못 읽으면(허락 없음 · 창 없음) 연속으로
///   `failedReadsBeforeDefault` 번 못 읽을 때까지는 자리를 그대로 두고, 넘으면 기본 자리.
/// - 다른 앱이 앞이면 숨김(고정이면 그대로). 우리 앱이 앞(사용자가 옆 창을 누름)이면 그대로.
/// - `onCommand` 는 스케줄러가 부르는 스레드에서 불린다 — 화면에 닿는 쪽은 메인으로 넘길 것.
public final class PanelFollower: @unchecked Sendable {
    public static let interval: TimeInterval = 0.5
    public static let failedReadsBeforeDefault = 3
    /// 자동화 허락이 거부됐을 때 다시 읽어 보기까지 쉬는 시간(초).
    public static let deniedBackoff: TimeInterval = 30
    /// 사용자가 막 연 옆 창을 다른 앱이 앞이라고 바로 숨기지 않는 시간(초) — 우리 앱이 앞으로 오기까지의 틈.
    public static let openGrace: TimeInterval = 1.5

    private let bridge: SafariBridging
    private let scheduler: TickScheduling
    private let geometry: @Sendable () -> ScreenGeometry
    private let ownAppIsActive: @Sendable () -> Bool
    private let onCommand: @Sendable (PanelCommand) -> Void
    private let width: CGFloat
    private let gap: CGFloat
    private let now: @Sendable () -> Date

    private let lock = NSLock()
    /// 보이기 · 숨기기 명령을 만들고 내보내는 순서를 하나로 묶는다(틱과 열기 · 닫기가 서로 다른 스레드라서).
    private let deliveryLock = NSLock()
    private var timer: TickCancelling?
    private var open: Bool
    private var pinned = false
    private var shownFrame: CGRect?     // 지금 보이는 자리(숨김이면 nil)
    private var lastFrame: CGRect?      // 마지막으로 보인 자리
    private var failedReads = 0
    private var deniedUntil: Date?      // 허락 거부로 쉬는 동안 다시 읽지 않는다
    private var openedAt: Date?         // 사용자가 마지막으로 연 때
    private var needsPlacement = false  // 연 뒤 아직 사파리 창 옆 자리를 한 번도 못 읽었다

    public init(bridge: SafariBridging, scheduler: TickScheduling,
                geometry: @escaping @Sendable () -> ScreenGeometry,
                ownAppIsActive: @escaping @Sendable () -> Bool,
                startsOpen: Bool = true, width: CGFloat = 380, gap: CGFloat = 8,
                now: @escaping @Sendable () -> Date = { Date() },
                onCommand: @escaping @Sendable (PanelCommand) -> Void) {
        self.bridge = bridge; self.scheduler = scheduler; self.geometry = geometry
        self.ownAppIsActive = ownAppIsActive; self.open = startsOpen
        self.width = width; self.gap = gap; self.now = now; self.onCommand = onCommand
    }

    public func start() {
        lock.lock(); defer { lock.unlock() }
        guard timer == nil else { return }
        timer = scheduler.every(Self.interval) { [weak self] in self?.tick() }
    }

    public func stop() {
        lock.lock(); let t = timer; timer = nil; lock.unlock()
        t?.cancel()
    }

    /// 사용자가 옆 창을 열었다/닫았다(⌥⇧S · 메뉴). 옆 창을 보이고 숨기는 일은 모두 이 따라가기를 거친다.
    /// - 닫으면: 바로 숨기고(틱을 기다리지 않는다) 타이머를 멈춘다 — 닫힌 동안은 사파리를 읽지 않는다.
    /// - 열면: 「보이는 중」 기억을 지워(다른 곳에서 숨겨졌어도 다시 보이게) 마지막 자리(없으면 기본 자리)에
    ///   바로 보이고, 타이머를 다시 켠다. 첫 사파리 읽기(허락 창이 뜰 수 있다)는 이 뒤의 틱에서 일어난다.
    ///   메인 스레드에서 불러도 막히지 않는다(사파리를 읽지 않는다).
    public func setOpen(_ value: Bool) {
        lock.withLock { open = value; if value { openedAt = now(); needsPlacement = true } }
        if value {
            invalidate()
            start()
            emit(.show(lock.withLock { lastFrame } ?? defaultFrame()))
        } else {
            stop()
            emit(.hide)
        }
    }

    /// 「보이는 중」 기억을 지운다 — 화면 배치가 바뀌었거나 창이 바깥에서 숨겨진 뒤, 다음 틱이 같은 자리여도 다시 알리게.
    public func invalidate() { lock.withLock { shownFrame = nil } }
    /// 「고정」 — 켜면 사파리가 앞이 아니어도 숨기지 않는다.
    public func setPinned(_ value: Bool) { lock.withLock { pinned = value } }

    /// 한 번 살펴본다(타이머가 부른다). 시험은 직접 부를 수 있다.
    public func tick() {
        let (isOpen, isPinned) = lock.withLock { (open, pinned) }
        guard isOpen else { emit(.hide); return }

        guard bridge.isSafariRunning() else {
            lock.withLock { failedReads = 0 }
            emit(.show(defaultFrame())); return
        }
        let ownAppOrJustOpened = ownAppIsActive()
            || lock.withLock({ openedAt.map { now().timeIntervalSince($0) < Self.openGrace } ?? false })
        if bridge.isFrontmost() {
            readAndPlace(oneShot: false)
        } else if ownAppOrJustOpened {
            // 사파리가 앞인 채 열었다면 우리 앱이 앞으로 오면서 사파리가 앞이 아니게 된다 —
            // 그래도 연 직후 한 번은 사파리 창 옆 자리를 읽어 붙는다(안 그러면 기본 자리에 멈춘다).
            if lock.withLock({ needsPlacement }) { readAndPlace(oneShot: true) } else { keepOrShowLast() }
        } else if isPinned {
            keepOrShowLast()
        } else {
            emit(.hide)
        }
    }

    /// 사파리 앞 창의 위치를 읽어 옆 자리를 낸다. `oneShot`(우리 앱이 앞인 때의 열기 직후 한 번)이면 못 읽어도
    /// 재시도 횟수를 세지 않고 있던 자리를 그대로 둔다.
    private func readAndPlace(oneShot: Bool) {
        let blocked = lock.withLock { (deniedUntil ?? .distantPast) > now() }
        let reading: Result<CGRect, SafariBridgeError> = blocked ? .failure(.automationDenied) : bridge.frontWindowBounds()
        lock.withLock { needsPlacement = false } // 어느 쪽이든 이번 열기의 읽기는 했다
        switch reading {
        case .success(let raw):
            lock.withLock { failedReads = 0; deniedUntil = nil }
            let g = geometry()
            let safari = g.appKitRect(fromTopLeft: raw)
            emit(.show(PanelPlacement.frame(safari: safari, screens: g.visibleFrames, width: width, gap: gap)))
        case .failure(.automationDenied):
            // 허락이 없다 — 0.5초마다 두드리지 않고 30초 쉰다. 그동안 옆 창은 기본 자리.
            if !blocked { lock.withLock { deniedUntil = now().addingTimeInterval(Self.deniedBackoff) } }
            emit(.show(defaultFrame()))
        case .failure:
            if oneShot { keepOrShowLast(); return }
            let n = lock.withLock { failedReads += 1; return failedReads }
            if n >= Self.failedReadsBeforeDefault || lock.withLock({ lastFrame == nil }) {
                emit(.show(defaultFrame()))
            } else {
                keepOrShowLast()
            }
        }
    }

    private func defaultFrame() -> CGRect {
        PanelPlacement.defaultFrame(screens: geometry().visibleFrames, width: width)
    }

    /// 그대로 둔다 — 아직 한 번도 안 보였으면 기본 자리로 보인다.
    private func keepOrShowLast() {
        let (shown, last) = lock.withLock { (shownFrame, lastFrame) }
        if shown == nil { emit(.show(last ?? defaultFrame())) }
    }

    /// 바뀐 것만 알린다(같은 자리 · 이미 숨김이면 조용히).
    /// 닫혀 있으면 보이는 명령은 나가지 않는다(틱이 사파리를 읽는 사이에 사용자가 닫은 경우).
    private func emit(_ cmd: PanelCommand) {
        deliveryLock.withLock {
            let changed: Bool = lock.withLock {
                switch cmd {
                case .show(let f):
                    guard open, shownFrame != f else { return false }
                    shownFrame = f; lastFrame = f; return true
                case .hide:
                    guard shownFrame != nil else { return false }
                    shownFrame = nil; return true
                }
            }
            if changed { onCommand(cmd) }
        }
    }
}
