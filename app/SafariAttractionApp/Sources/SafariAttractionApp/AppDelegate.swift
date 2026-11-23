import AppKit
import AppCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem?
    private var toggleItem: NSMenuItem?
    private var viewModel: ChatViewModel?
    private var controller: SidePanelController?
    private var hotKey: HotKey?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 로그인 셸 PATH(`zsh -lic` 는 사용자 rc 를 실행한다)는 앱이 켜질 때 읽지 않는다 —
        // 사용자가 첫 질문을 보낼 때 ChatViewModel 이 메인 밖에서 처음 읽고 캐시한다.
        let bridge = AppleScriptSafariBridge()
        let vm = ChatViewModel(runner: ProcessRunner(), bridge: bridge, loginPath: { ShellPath.loginPath() })
        let controller = SidePanelController(viewModel: vm, bridge: bridge)
        self.viewModel = vm
        self.controller = controller

        hotKey = HotKey(keyCode: HotKey.toggleKeyCode, modifiers: HotKey.toggleModifiers) { [weak self] in
            self?.controller?.toggle()
        }

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "safari", accessibilityDescription: "사파리-어트랙션")
        item.button?.toolTip = "사파리-어트랙션"
        let menu = NSMenu()
        menu.delegate = self
        let toggle = NSMenuItem(title: "옆 창 열기", action: #selector(togglePanel), keyEquivalent: "")
        toggle.target = self
        menu.addItem(toggle)
        toggleItem = toggle
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "종료", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        statusItem = item
        // 사파리는 여기서 읽지 않는다 — 옆 창을 처음 연 뒤에야 읽기 시작한다(맥의 자동화 허락 창이 그때 뜬다).
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        var title = "옆 창 열기 · 닫기"
        title += (hotKey?.registrationError == nil) ? " (\(HotKey.toggleLabel))" : " (단축키를 못 써요)"
        toggleItem?.title = title
    }

    @objc private func togglePanel() { controller?.toggle() }
    @objc private func quitApp() { NSApplication.shared.terminate(nil) }

    // MARK: 끝낼 때

    /// 답하는 중이면 CLI 를 먼저 멈춘다 — 멈춤은 SIGTERM, 2초 뒤 SIGKILL 이라 정리될 때까지 잠깐(최대 3초) 기다린다.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let vm = viewModel, vm.isRunning else { return .terminateNow }
        vm.shutdown()
        Task { @MainActor in
            for _ in 0..<30 where vm.isRunning { try? await Task.sleep(nanoseconds: 100_000_000) }
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        viewModel?.shutdown()
        controller?.shutdown()
        hotKey?.unregister()
    }

    // MARK: 개발 · 시험용 열쇠 — `DEV=1 app/scripts/build.sh` 로 만든 빌드에서만 들어 있다(평소 빌드엔 주소 등록도 코드도 없음).
    // 켜려면 `defaults write com.gulzzaang.SafariAttractionApp DevHooks -int 1`.

#if SA_DEV_HOOKS

    func application(_ application: NSApplication, open urls: [URL]) {
        guard DevHooks.isEnabled() else { return }
        for url in urls {
            switch DevHooks.parse(url: url) {
            case .toggle: controller?.toggle()
            case .ask(let a): runDevAsk(a)
            case nil: break
            }
        }
    }

    private func runDevAsk(_ a: DevAsk) {
        guard let vm = viewModel, let controller, let file = try? DevHooks.resultFile() else { return }
        RunRecord.remove(at: file) // 옛 결과가 새 결과로 오해되지 않게
        guard !vm.isRunning else {
            try? RunRecord(model: a.model.rawValue, question: a.question, answer: "", error: "이미 답하는 중이라 건너뛰었어요",
                           durationMs: 0, attachedPage: nil).write(to: file)
            return
        }
        if a.openPanel { controller.open() }
        vm.model = a.model; vm.webSearch = a.webSearch; vm.attachPage = a.attachPage
        vm.input = a.question
        guard let task = vm.send() else { return }
        Task { @MainActor in
            await task.value
            if let record = vm.lastRun { try? record.write(to: file) }
        }
    }
#endif
}
