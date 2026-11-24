import AppKit
import AppCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem?
    private var toggleItem: NSMenuItem?
    private var viewModel: ChatViewModel?
    private var agent: AgentSession?
    private var hub: RoutineHub?
    private var controller: SidePanelController?
    private var hotKeys: HotKeys?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 로그인 셸 PATH(`zsh -lic` 는 사용자 rc 를 실행한다)는 앱이 켜질 때 읽지 않는다 —
        // 사용자가 첫 질문을 보낼 때 ChatViewModel 이 메인 밖에서 처음 읽고 캐시한다.
        let bridge = AppleScriptSafariBridge()
        // 앱이 띄우는 모든 claude(묻기 · 일 맡기기 · 루틴)는 앱 전용 설정 폴더(CLAUDE_CONFIG_DIR)를 쓴다 —
        // 사용자 클로드 설정이 문서 폴더 경로를 가리켜 맥이 문서 폴더 허락 창을 띄우는 것을 피한다.
        // 같은 값을 묻기 · 일 맡기기(루틴은 일 맡기기 세션을 탄다)가 함께 쓴다.
        let claudeEnv: [String: String]
        if let dir = try? AppPaths.claudeConfigDirectory() {
            claudeEnv = ProcessRunner.claudeEnvironmentOverrides(configDirectory: dir)
        } else {
            claudeEnv = [:]
            NSLog("사파리-어트랙션: 앱 전용 클로드 설정 폴더를 만들지 못했어요 — 사용자 클로드 설정을 그대로 써요")
        }
        let vm = ChatViewModel(runner: ProcessRunner(environmentOverrides: claudeEnv), bridge: bridge, loginPath: { ShellPath.loginPath() })
        // 일 맡기기 — 서버 묶음은 앱 안(Resources/safari-attraction), 기억 · 사이트 허락 · 관문 소켓은 앱 지원 폴더.
        // 이 시점엔 폴더만 준비하고 클로드 · 사파리는 건드리지 않는다(첫 일 맡기기 때 시작).
        let support = (try? AppPaths.supportDirectory()) ?? FileManager.default.temporaryDirectory
        let siteModes = SiteModeStore(directory: support)
        let agent = AgentSession(
            resources: Bundle.main.resourceURL ?? URL(fileURLWithPath: Bundle.main.bundlePath),
            memoryHome: support.appendingPathComponent("memory", isDirectory: true),
            siteModes: siteModes,
            gateFactory: { try GateServer(directory: try AppPaths.supportDirectory()) },
            runnerFactory: { ProcessRunner(environmentOverrides: claudeEnv) },
            loginPath: { ShellPath.loginPath() })
        // 자주 하는 일 · 루틴 — 저장소는 폴더당 인스턴스 하나(화면과 시계가 같은 것을 쓴다). 시계는 루틴이 하나라도 켜져 있을 때만 돈다.
        // 알림 허락은 여기서 묻지 않는다(「끝나면 알림」 을 켤 때만).
        let routineStore = RoutineStore(directory: support)
        let scheduler = RoutineScheduler(store: routineStore, runner: agent)
        let hub = RoutineHub(store: routineStore, scheduler: scheduler, notifier: SystemRoutineNotifier(), preference: DefaultsNotifyPreference(),
                             warmUpLoginPath: { _ = ShellPath.loginPath() })   // 루틴을 켤 때 · 「지금 한 번」 때 메인 밖에서 미리 읽는다
        let controller = SidePanelController(viewModel: vm, agent: agent, siteModes: siteModes, hub: hub, bridge: bridge)
        agent.onPendingCardChange = { [weak self] waiting in
            self?.controller?.setCardWaiting(waiting)
            self?.setWaitingIcon(waiting)
        }
        self.viewModel = vm
        self.agent = agent
        self.hub = hub
        self.controller = controller

        let keys = HotKeys { [weak self] in self?.controller?.toggle() }
        keys.start()
        hotKeys = keys

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: Self.idleSymbol, accessibilityDescription: "사파리-어트랙션")
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

        // 잠에서 깰 때 — 켜진 루틴이 있으면 놓친 시각을 한 번 살핀다(60분 안이면 돌고, 넘으면 건너뜀 기록).
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.hub?.handleWake() }
        }
        // 앱을 켤 때 — 켜진 루틴이 있으면 시계를 시작하고 곧바로 한 번 살핀다.
        hub.launch()
    }

    private static let idleSymbol = "safari"
    private static let waitingSymbol = "bell.badge.fill"

    /// 승인 카드가 답을 기다리는 동안 메뉴 막대 아이콘을 「기다림」 모양으로.
    private var isWaiting = false
    private func setWaitingIcon(_ waiting: Bool) {
        isWaiting = waiting
        let symbol = waiting ? Self.waitingSymbol : Self.idleSymbol
        let label = waiting ? "사파리-어트랙션 — 승인을 기다리는 카드가 있어요" : "사파리-어트랙션"
        if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label) {
            statusItem?.button?.image = image
        }
        statusItem?.button?.toolTip = label
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        var title = "옆 창 열기 · 닫기"
        title += hotKeys?.statusSuffix ?? ""
        if isWaiting { title += " — 승인 기다리는 카드가 있어요" }
        toggleItem?.title = title
    }

    @objc private func togglePanel() { controller?.toggle() }
    @objc private func quitApp() { NSApplication.shared.terminate(nil) }

    // MARK: 끝낼 때

    /// 답하는 중(묻기 · 일 맡기기)이면 CLI 를 먼저 멈춘다 — 멈춤은 SIGTERM, 2초 뒤 SIGKILL 이라 정리될 때까지 잠깐(최대 3초) 기다린다.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        hub?.shutdown()   // 끝내는 중에 새 루틴이 시작되지 않게 시계부터 끈다
        let vm = viewModel, agent = agent
        guard (vm?.isRunning ?? false) || (agent?.isRunning ?? false) else { return .terminateNow }
        vm?.shutdown()
        agent?.shutdown()
        Task { @MainActor in
            for _ in 0..<30 where (vm?.isRunning ?? false) || (agent?.isRunning ?? false) {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        hub?.shutdown()
        viewModel?.shutdown()
        agent?.shutdown()
        controller?.shutdown()
        hotKeys?.shutdown()
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
