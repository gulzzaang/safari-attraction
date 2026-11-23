import AppKit
import AppCore
import SwiftUI

/// 테두리 없는 옆 창. 일반 층(다른 앱 위에 떠 있지 않는다), 키 창이 될 수 있다(입력 칸), 앱이 뒤로 가도 숨지 않는다
/// (숨기고 보이는 것은 오직 따라가기의 명령으로).
final class SidePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    init(content: NSView) {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 380, height: 700),
                   styleMask: [.borderless, .resizable], backing: .buffered, defer: false)
        isFloatingPanel = false
        level = .normal
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isMovable = false // 사파리 따라 움직인다 — 손으로 옮기지 않는다
        collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        title = "사파리-어트랙션"
        contentView = content
        minSize = NSSize(width: 280, height: 320)
    }
}

/// 옆 창 하나 + 따라가기 + 대화 두뇌를 묶는다. 보이고 숨기는 일은 모두 따라가기를 거친다.
@MainActor
final class SidePanelController {
    let viewModel: ChatViewModel
    private let follower: PanelFollower
    private let panel: SidePanel
    private(set) var isOpen = false
    private var activateOnNextShow = false

    init(viewModel: ChatViewModel, bridge: SafariBridging) {
        self.viewModel = viewModel
        let hosting = NSHostingView(rootView: AnyView(EmptyView()))
        hosting.sizingOptions = []       // 크기는 따라가기가 정한다 — 안쪽 내용이 창 크기를 바꾸지 않게
        panel = SidePanel(content: hosting)
        // 따라가기는 전용 큐에서 명령을 보낸다 — 화면은 메인에서만 만진다. (순서는 따라가기가 보장)
        let box = WeakBox()
        follower = PanelFollower.live(bridge: bridge, startsOpen: false) { cmd in
            DispatchQueue.main.async { MainActor.assumeIsolated { box.value?.apply(cmd) } }
        }
        box.value = self
        hosting.rootView = AnyView(ChatView(vm: viewModel, onClose: { [weak self] in self?.close() }))
        viewModel.onPinnedChange = { [follower] pinned in follower.setPinned(pinned) }

        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                               object: nil, queue: .main) { [follower] _ in
            follower.invalidate() // 화면 배치가 바뀌면 다음 틱이 같은 자리여도 다시 알린다
        }
    }

    private final class WeakBox: @unchecked Sendable {
        weak var value: SidePanelController?
    }

    func toggle() { isOpen ? close() : open() }

    /// 연다 — 사용자가 눌렀으니 우리 앱을 앞으로 가져와 바로 입력할 수 있게 한다(사파리 창은 안 건드린다).
    func open() {
        guard !isOpen else { NSApp.activate(); panel.makeKeyAndOrderFront(nil); viewModel.requestFocus(); return }
        isOpen = true
        activateOnNextShow = true
        viewModel.requestFocus()
        follower.setOpen(true)
    }

    func close() {
        guard isOpen else { return }
        isOpen = false
        activateOnNextShow = false
        follower.setOpen(false)
        if NSApp.isActive { NSApp.deactivate() } // 앞에 있던 앱(사파리)에게 돌려준다
    }

    /// 앱을 끝낼 때.
    func shutdown() { follower.stop() }

    private func apply(_ cmd: PanelCommand) {
        switch cmd {
        case .show(let frame):
            guard isOpen else { return } // 닫은 뒤에 늦게 온 명령
            panel.setFrame(frame, display: true)
            if activateOnNextShow {
                activateOnNextShow = false
                NSApp.activate()
                panel.makeKeyAndOrderFront(nil)
            } else {
                panel.orderFrontRegardless()
            }
        case .hide:
            panel.orderOut(nil)
        }
    }
}
