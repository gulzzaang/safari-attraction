import AppKit
import AppCore

/// 지정한 간격으로 전용 직렬 큐에서 `fire` 를 부른다(메인 스레드가 아니다 — 사파리 읽기가 막혀도 화면이 안 멈춘다).
final class DispatchTickScheduler: TickScheduling, @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.gulzzaang.SafariAttractionApp.follower")

    private final class Cancel: TickCancelling, @unchecked Sendable {
        let timer: DispatchSourceTimer
        init(_ t: DispatchSourceTimer) { timer = t }
        func cancel() { timer.cancel() }
    }

    func every(_ interval: TimeInterval, _ fire: @escaping @Sendable () -> Void) -> TickCancelling {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(50))
        t.setEventHandler(handler: fire)
        t.resume()
        return Cancel(t)
    }
}

enum LiveScreens {
    /// 지금 화면 배치(AppKit 좌표). 어느 스레드에서 불러도 된다(메인이 아니면 메인에 잠깐 물어본다).
    static func geometry() -> ScreenGeometry {
        if Thread.isMainThread { return MainActor.assumeIsolated { read() } }
        return DispatchQueue.main.sync { MainActor.assumeIsolated { read() } }
    }

    @MainActor private static func read() -> ScreenGeometry {
        let screens = NSScreen.screens // [0] 이 메뉴 막대가 있는 주 화면
        return ScreenGeometry(primaryHeight: screens.first?.frame.height ?? 0, visibleFrames: screens.map(\.visibleFrame))
    }

    /// 우리 앱이 가장 앞 앱인가(옆 창을 눌렀을 때).
    static func ownAppIsFrontmost() -> Bool {
        NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier
    }
}

extension PanelFollower {
    /// 실제 사파리 · 화면에 붙인 따라가기. `onCommand` 는 전용 큐에서 불리니 화면에 닿는 일은 메인으로 넘길 것.
    static func live(bridge: SafariBridging = AppleScriptSafariBridge(),
                     onCommand: @escaping @Sendable (PanelCommand) -> Void) -> PanelFollower {
        PanelFollower(bridge: bridge, scheduler: DispatchTickScheduler(),
                      geometry: { LiveScreens.geometry() },
                      ownAppIsActive: { LiveScreens.ownAppIsFrontmost() },
                      onCommand: onCommand)
    }
}
