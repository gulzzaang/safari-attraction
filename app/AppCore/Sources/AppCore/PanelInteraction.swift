import Foundation

/// 단축키 · 메뉴로 옆 창을 눌렀을 때 열지 닫을지. 「열려 있음」(사용자가 원함)과 「보임」은 다르다 —
/// 다른 앱으로 옮겨 가면 따라가기가 숨기지만 열린 상태는 그대로라서, 그때 누르면 닫는 게 아니라 다시 띄운다.
public enum PanelToggle {
    public enum Action: Sendable, Equatable { case open, close }
    public static func action(isOpen: Bool, isVisible: Bool) -> Action {
        (isOpen && isVisible) ? .close : .open
    }
}

/// 입력 칸에서 Return 을 눌렀을 때. 한글 조합 중(밑줄 친 글자가 있는 중)의 Return 은 조합을 확정하는 키라 보내면 안 된다.
public enum ReturnKey {
    public enum Action: Sendable, Equatable { case submit, newline, letInputMethodHandle }
    public static func action(hasMarkedText: Bool, shiftOrOption: Bool) -> Action {
        if hasMarkedText { return .letInputMethodHandle }
        return shiftOrOption ? .newline : .submit
    }
}
