import AppKit
import AppCore
import SwiftUI

/// 테두리 없는 옆 창. 일반 층(다른 앱 위에 떠 있지 않는다), 키 창이 될 수 있다(입력 칸), 앱이 뒤로 가도 숨지 않는다
/// (숨기고 보이는 것은 오직 따라가기의 명령으로).
final class SidePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    /// 고정이 아니면 떠 있는 층, 고정이면 일반 층(`PanelLayer`).
    static func windowLevel(pinned: Bool) -> NSWindow.Level {
        PanelLayer.level(pinned: pinned) == .floating ? .floating : .normal
    }

    init(content: NSView) {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 380, height: 700),
                   styleMask: [.borderless, .resizable], backing: .buffered, defer: false)
        isFloatingPanel = false
        becomesKeyOnlyIfNeeded = false // 눌리면 키 창이 된다(입력 칸)
        level = Self.windowLevel(pinned: false)
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
    let agent: AgentSession
    private let follower: PanelFollower
    private let panel: SidePanel
    private(set) var isOpen = false
    private var activateOnNextShow = false
    /// 사용자가 켠 「고정」 · 기다리는 카드가 있다 — 둘 중 하나면 따라가기가 옆 창을 숨기지 않는다.
    private var userPinned = false
    private var cardWaiting = false

    init(viewModel: ChatViewModel, agent: AgentSession, siteModes: SiteModeStore, hub: RoutineHub, bridge: SafariBridging) {
        self.viewModel = viewModel
        self.agent = agent
        let hosting = NSHostingView(rootView: AnyView(EmptyView()))
        hosting.sizingOptions = []       // 크기는 따라가기가 정한다 — 안쪽 내용이 창 크기를 바꾸지 않게
        panel = SidePanel(content: hosting)
        // 따라가기는 전용 큐에서 명령을 보낸다 — 화면은 메인에서만 만진다. (순서는 따라가기가 보장)
        let box = WeakBox()
        follower = PanelFollower.live(bridge: bridge, startsOpen: false) { cmd in
            DispatchQueue.main.async { MainActor.assumeIsolated { box.value?.apply(cmd) } }
        }
        box.value = self
        hosting.rootView = AnyView(ChatView(vm: viewModel, agent: agent, siteModes: siteModes, hub: hub,
                                            onClose: { [weak self] in self?.close() }))
        viewModel.onPinnedChange = { [weak self, panel] pinned in
            panel.level = SidePanel.windowLevel(pinned: pinned)
            self?.userPinned = pinned
            self?.refreshFollowerPin()
        }

        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                               object: nil, queue: .main) { [follower] _ in
            follower.invalidate() // 화면 배치가 바뀌면 다음 틱이 같은 자리여도 다시 알린다
        }
    }

    private final class WeakBox: @unchecked Sendable {
        weak var value: SidePanelController?
    }

    /// 카드가 사람의 답을 기다리는 동안은 사파리가 뒤로 가도 옆 창을 숨기지 않는다.
    /// 앞으로 가져오지도, 포커스를 뺏지도, 사파리를 건드리지도 않는다(따라가기가 「고정」 처럼 그 자리에 둘 뿐).
    /// 사용자가 옆 창을 닫아 둔 경우는 열지 않는다(메뉴 막대 아이콘이 기다림을 알린다).
    func setCardWaiting(_ waiting: Bool) {
        cardWaiting = waiting
        refreshFollowerPin()
    }

    private func refreshFollowerPin() {
        follower.setPinned(userPinned || cardWaiting)
    }

    /// 열려 있어도 안 보이면(다른 앱으로 옮겨 가 따라가기가 숨김) 닫지 않고 다시 띄운다.
    func toggle() {
        switch PanelToggle.action(isOpen: isOpen, isVisible: panel.isVisible) {
        case .open: open()
        case .close: close()
        }
    }

    /// 연다 — 사용자가 눌렀으니 우리 앱을 앞으로 가져와 바로 입력할 수 있게 한다(사파리 창은 안 건드린다).
    /// 이미 열려 있었어도(숨겨진 상태 포함) 따라가기를 다시 무장한다(보임 기억 지움 · 막 연 유예 · 새 자리 읽기).
    func open() {
        isOpen = true
        activateOnNextShow = true
        viewModel.requestFocus()
        follower.setOpen(true)
        // 로그인 상태 · 모델 목록 · 남은 양은 옆 창을 열 때 읽는다(5분 안에는 다시 읽지 않는다 — 메인 밖).
        if let status = viewModel.status { Task { await status.refreshAll(force: false) } }
    }

    func close() {
        guard isOpen else { return }
        isOpen = false
        activateOnNextShow = false
        follower.setOpen(false)
        if NSApp.isActive { NSApp.deactivate() } // 앞에 있던 앱(사파리)에게 돌려준다
    }

    /// 앞으로 가져오기 — 협력형 활성화가 먹히지 않으면(`LSUIElement` 앱은 단축키 뒤에 안 올 수 있다) 150ms 뒤 한 번 더.
    private func activateAndFocus() {
        NSApp.activate()
        panel.makeKeyAndOrderFront(nil)
        viewModel.requestFocus()
        NSLog("사파리-어트랙션: 옆 창 열기 — activate() 직후 앱 활성=%@ 키 창=%@",
              NSApp.isActive ? "예" : "아니오", panel.isKeyWindow ? "예" : "아니오")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self, isOpen else { return }
            if !NSApp.isActive {
                NSLog("사파리-어트랙션: 150ms 뒤에도 앱이 활성이 아님 — 한 번 더 활성화(대비책)")
                forceActivate()
                panel.makeKeyAndOrderFront(nil)
                viewModel.requestFocus()
            }
            NSLog("사파리-어트랙션: 옆 창 열기 결과 — 앱 활성=%@ 키 창=%@",
                  NSApp.isActive ? "예" : "아니오", panel.isKeyWindow ? "예" : "아니오")
        }
    }

    /// 앱을 끝낼 때.
    func shutdown() { follower.stop() }

    private func apply(_ cmd: PanelCommand) {
        switch cmd {
        case .show(let frame):
            guard isOpen else { return } // 닫은 뒤에 늦게 온 명령
            panel.setFrame(frame, display: true)
            if activateOnNextShow && PanelLayer.activatesOurApp(for: .userOpened) {
                activateOnNextShow = false
                activateAndFocus()
            } else {
                // 보이거나 자리만 옮길 때는 활성화 없이 앞으로(사파리 포커스를 뺏지 않는다).
                panel.orderFrontRegardless()
            }
        case .hide:
            panel.orderOut(nil)
        }
    }
}

/// 협력형 `activate()` 가 먹히지 않을 때의 대비책(옵션을 주는 옛 방식).
@MainActor
private func forceActivate() {
    NSRunningApplication.current.activate(options: [.activateAllWindows])
}
