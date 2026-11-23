import Foundation

/// 옆 창이 어느 층에 뜨고, 언제 우리 앱을 앞으로 가져오는지.
/// 옆 창은 사파리(또는 우리 앱)가 앞일 때나 「고정」 일 때만 보인다(다른 앱이 앞이면 따라가기가 숨긴다).
public enum PanelLayer {
    public enum Level: Sendable, Equatable { case normal, floating }
    public enum Trigger: Sendable, Equatable {
        /// 사용자가 단축키 · 메뉴로 열었다.
        case userOpened
        /// 사용자가 옆 창 안을 눌렀다.
        case userClicked
        /// 따라가기가 보이거나 자리만 옮긴다.
        case followerShowOrMove
    }

    /// 고정이 아니면 떠 있는 층(겹친 사파리를 눌러도 안 묻힌다), 고정이면 일반 층(모든 앱 위에 떠 있지 않게).
    public static func level(pinned: Bool) -> Level { pinned ? .normal : .floating }

    /// 사용자가 직접 열거나 누를 때만 우리 앱을 앞으로 — 보이기 · 옮기기는 사파리의 포커스를 뺏지 않는다.
    public static func activatesOurApp(for trigger: Trigger) -> Bool { trigger != .followerShowOrMove }
}
