import CoreGraphics

/// 사파리(AppleScript)의 창 좌표는 **주 화면 왼쪽 위가 원점, 아래로 갈수록 y 가 커진다**.
/// AppKit(`NSScreen.frame` · `visibleFrame` · `NSWindow.frame`)은 **주 화면 왼쪽 아래가 원점, 위로 갈수록 y 가 커진다**.
/// 둘을 바꿀 때 기준은 늘 **주 화면의 전체 높이(`frame.height`, visibleFrame 아님)** 하나다 —
/// 다른 화면의 높이나 위치와는 상관없다(주 화면 위의 화면은 왼쪽 위 기준에서 y 가 음수).
public enum ScreenCoordinates {
    /// AppleScript `bounds`(`{왼쪽, 위, 오른쪽, 아래}`)를 왼쪽 위 기준 사각형으로. 값이 이상하면 nil.
    public static func rect(appleScriptBounds b: [Double]) -> CGRect? {
        guard b.count == 4, b.allSatisfy({ $0.isFinite }), b[2] > b[0], b[3] > b[1] else { return nil }
        return CGRect(x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1])
    }

    /// 왼쪽 위 기준 → AppKit(왼쪽 아래 기준).
    public static func appKitRect(fromTopLeft r: CGRect, primaryScreenHeight h: CGFloat) -> CGRect {
        CGRect(x: r.minX, y: h - r.maxY, width: r.width, height: r.height)
    }

    /// AppKit(왼쪽 아래 기준) → 왼쪽 위 기준.
    public static func topLeftRect(fromAppKit r: CGRect, primaryScreenHeight h: CGFloat) -> CGRect {
        CGRect(x: r.minX, y: h - r.maxY, width: r.width, height: r.height)
    }
}

/// 따라가기에 필요한 화면 정보(AppKit 좌표). `visibleFrames[0]` 이 주 화면(`NSScreen.screens[0]`).
public struct ScreenGeometry: Sendable, Equatable {
    /// 주 화면의 전체 높이(`NSScreen.screens[0].frame.height`) — 좌표 뒤집기 기준.
    public var primaryHeight: CGFloat
    /// 각 화면의 `visibleFrame`(메뉴 막대 · 독 뺀 영역), AppKit 좌표.
    public var visibleFrames: [CGRect]
    public init(primaryHeight: CGFloat, visibleFrames: [CGRect]) {
        self.primaryHeight = primaryHeight; self.visibleFrames = visibleFrames
    }
    public func appKitRect(fromTopLeft r: CGRect) -> CGRect {
        ScreenCoordinates.appKitRect(fromTopLeft: r, primaryScreenHeight: primaryHeight)
    }
}
