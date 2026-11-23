import AppKit
import AppCore
import SwiftUI

/// 입력 칸 — AppKit 글 상자. SwiftUI `TextField` 는 한글 조합 중(밑줄 친 글자)인지 알 수 없어서,
/// 조합 중 Return 이 질문을 보내 버리는 문제를 피하려고 `NSTextView` 를 쓴다.
/// Return = 보내기(조합 중이면 보내지 않고 입력기에 맡김), Shift/Option+Return = 줄바꿈.
struct InputTextView: NSViewRepresentable {
    @Binding var text: String
    /// 바뀔 때마다 입력 칸에 커서를 둔다.
    var focusTick: Int
    var onSubmit: () -> Void

    static let minHeight: CGFloat = 30
    static let maxHeight: CGFloat = 130
    /// 글 상자 안쪽 여백(가로 · 세로)과 줄 앞 여백 — 안내 글자(placeholder)가 같은 자리에 오도록 ChatView 가 같은 값을 쓴다.
    static let insetX: CGFloat = 4
    static let insetY: CGFloat = 6
    static let linePadding: CGFloat = 5

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let tv = FocusableTextView()
        tv.delegate = context.coordinator
        tv.isRichText = false
        tv.allowsUndo = true
        tv.font = .systemFont(ofSize: 13)
        tv.textColor = .labelColor
        tv.drawsBackground = false
        tv.isAutomaticQuoteSubstitutionEnabled = false
        tv.isAutomaticDashSubstitutionEnabled = false
        tv.textContainerInset = NSSize(width: Self.insetX, height: Self.insetY)
        tv.isVerticallyResizable = true
        tv.isHorizontallyResizable = false
        // 글이 길어져도 상자가 자라고(위아래) 스크롤되게 — 끝없이 큰 최대 크기가 있어야 한다.
        tv.minSize = NSSize(width: 0, height: Self.minHeight)
        tv.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        tv.textContainer?.lineFragmentPadding = Self.linePadding
        tv.autoresizingMask = [.width]
        tv.textContainer?.widthTracksTextView = true
        tv.string = text

        let scroll = NSScrollView()
        scroll.documentView = tv
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        context.coordinator.textView = tv
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let tv = scroll.documentView as? NSTextView else { return }
        // 조합 중에는 글을 덮어쓰지 않는다(조합이 깨진다).
        if tv.string != text && !tv.hasMarkedText() { tv.string = text }
        if context.coordinator.lastFocusTick != focusTick {
            context.coordinator.lastFocusTick = focusTick
            DispatchQueue.main.async { tv.window?.makeFirstResponder(tv) }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSScrollView, context: Context) -> CGSize? {
        guard let tv = nsView.documentView as? NSTextView,
              let container = tv.textContainer, let layout = tv.layoutManager else { return nil }
        let width = proposal.width ?? 300
        container.containerSize = NSSize(width: max(width - 2 * tv.textContainerInset.width, 10), height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        let used = layout.usedRect(for: container).height + 2 * tv.textContainerInset.height
        return CGSize(width: width, height: min(max(used, Self.minHeight), Self.maxHeight))
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: InputTextView
        weak var textView: NSTextView?
        var lastFocusTick = 0
        init(_ p: InputTextView) { parent = p }

        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            if parent.text != tv.string { parent.text = tv.string }
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard selector == #selector(NSResponder.insertNewline(_:)) else { return false }
            let flags = NSApp.currentEvent?.modifierFlags ?? []
            switch ReturnKey.action(hasMarkedText: textView.hasMarkedText(),
                                    shiftOrOption: flags.contains(.shift) || flags.contains(.option)) {
            case .submit:
                parent.text = textView.string
                parent.onSubmit()
                return true
            case .newline:
                textView.insertNewlineIgnoringFieldEditor(nil)
                return true
            case .letInputMethodHandle:
                return false
            }
        }
    }
}

/// 첫 클릭에 바로 입력되게(창이 키 창이 아니어도).
private final class FocusableTextView: NSTextView {
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
