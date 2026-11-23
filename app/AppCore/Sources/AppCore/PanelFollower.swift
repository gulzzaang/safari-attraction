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

    private let bridge: SafariBridging
    private let scheduler: TickScheduling
    private let geometry: @Sendable () -> ScreenGeometry
    private let ownAppIsActive: @Sendable () -> Bool
    private let onCommand: @Sendable (PanelCommand) -> Void
    private let width: CGFloat
    private let gap: CGFloat

    private let lock = NSLock()
    private var timer: TickCancelling?
    private var open: Bool
    private var pinned = false
    private var shownFrame: CGRect?     // 지금 보이는 자리(숨김이면 nil)
    private var lastFrame: CGRect?      // 마지막으로 보인 자리
    private var failedReads = 0

    public init(bridge: SafariBridging, scheduler: TickScheduling,
                geometry: @escaping @Sendable () -> ScreenGeometry,
                ownAppIsActive: @escaping @Sendable () -> Bool,
                startsOpen: Bool = true, width: CGFloat = 380, gap: CGFloat = 8,
                onCommand: @escaping @Sendable (PanelCommand) -> Void) {
        self.bridge = bridge; self.scheduler = scheduler; self.geometry = geometry
        self.ownAppIsActive = ownAppIsActive; self.open = startsOpen
        self.width = width; self.gap = gap; self.onCommand = onCommand
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

    /// 사용자가 옆 창을 열었다/닫았다(⌥⌘Space · 메뉴).
    public func setOpen(_ value: Bool) { lock.withLock { open = value } }
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
        if bridge.isFrontmost() {
            if let raw = bridge.frontWindowBounds() {
                lock.withLock { failedReads = 0 }
                let g = geometry()
                let safari = g.appKitRect(fromTopLeft: raw)
                emit(.show(PanelPlacement.frame(safari: safari, screens: g.visibleFrames, width: width, gap: gap)))
            } else {
                let n = lock.withLock { failedReads += 1; return failedReads }
                if n >= Self.failedReadsBeforeDefault || lock.withLock({ lastFrame == nil }) {
                    emit(.show(defaultFrame()))
                } else {
                    keepOrShowLast()
                }
            }
        } else if ownAppIsActive() {
            keepOrShowLast()
        } else if isPinned {
            keepOrShowLast()
        } else {
            emit(.hide)
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
    private func emit(_ cmd: PanelCommand) {
        let changed: Bool = lock.withLock {
            switch cmd {
            case .show(let f):
                guard shownFrame != f else { return false }
                shownFrame = f; lastFrame = f; return true
            case .hide:
                guard shownFrame != nil else { return false }
                shownFrame = nil; return true
            }
        }
        if changed { onCommand(cmd) }
    }
}
