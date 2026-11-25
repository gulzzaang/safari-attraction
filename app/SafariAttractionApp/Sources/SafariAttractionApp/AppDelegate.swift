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
    private var settingsWindow: SettingsWindowController?
    private var deviceLogin: CodexDeviceLogin?
    private var status: CLIStatusService?
    private var panelHost: PanelHost?
    private var panelService: PanelAskService?
    private var interactiveGate: InteractiveGate?
    private var updateService: UpdateService?
    private var updateMenu: UpdateMenuController?
    /// 사이트 알림 길(`/alert-hosts` · `/alert`) — 서버가 허브보다 먼저 만들어져서, 허브를 만든 뒤 이 다리에 잇는다.
    private let alertRelay = PanelAlertRelay()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 로그인 셸 PATH(`zsh -lic` 는 사용자 rc 를 실행한다)는 앱이 켜질 때 읽지 않는다 —
        // 사용자가 첫 질문을 보낼 때 ChatViewModel 이 메인 밖에서 처음 읽고 캐시한다.
        let bridge = AppleScriptSafariBridge()
        let resources = Bundle.main.resourceURL ?? URL(fileURLWithPath: Bundle.main.bundlePath)
        // 앱이 띄우는 모든 CLI 는 앱 전용 설정 폴더를 쓴다 —
        // 사용자 설정이 문서 폴더 경로를 가리켜 맥이 문서 폴더 허락 창을 띄우는 것을 피한다.
        // 덮어쓰기 사전(경로 글자)은 폴더를 만들었든 못 만들었든 **늘** 적용한다. 폴더를 못 만들었으면 CLI 를 하나도 띄우지 않는다
        // (안 그러면 사용자 `~/.codex` · `~/.claude` 로 되돌아가 문서 폴더 허락 창이 뜰 수 있다) — 묻기 · 상태 · 로그인이 이유를 한국어로 알린다.
        var folderError: String?
        var supportFailed = false
        let support: URL
        do { support = try AppPaths.supportDirectory() } catch {
            support = FileManager.default.temporaryDirectory
            folderError = error.localizedDescription
            supportFailed = true
        }
        if folderError == nil {
            do { try CLIEnvironment.prepareDirectories(support: support, resources: resources) } catch { folderError = error.localizedDescription }
        }
        if let folderError { NSLog("사파리-어트랙션: 앱 전용 CLI 설정 폴더를 만들지 못했어요 — CLI 를 띄우지 않아요 (%@)", folderError) }
        let blocked: FolderBlockedRunner? = folderError.map { FolderBlockedRunner(reason: $0) }
        let claudeEnv = CLIEnvironment.overrides(support: support)
        let cliEnv = claudeEnv
        let settings = AppSettingsStore(directory: support)
        let siteModes = SiteModeStore(directory: support)
        // opencode 의 `XDG_*` 는 그 CLI 를 띄울 때만 — 다른 CLI 의 자식에는 안 샌다.
        let executableEnv: @Sendable (String) -> [String: String] = { exe in
            CLIEnvironment.executableEnvironment(executable: exe, support: support)
        }
        if !supportFailed {
            let gate = InteractiveGate(
                support: support,
                makeServer: { try GateServer(directory: support) },
                routineName: { [weak self] in self?.runningRoutineName() })
            do {
                try gate.start()
                self.interactiveGate = gate
            } catch {
                NSLog("사파리-어트랙션: 공용 동작 관문을 켜지 못했어요 (%@)", error.localizedDescription)
            }
        }
        // 로그인 상태 · 모델 목록 · 남은 양은 읽는 일마다 새 실행기로(질문이 도는 중에도 부딪히지 않게). 앱을 켤 때는 읽지 않는다.
        let status = CLIStatusService(loginPath: { ShellPath.loginPath() },
                                      runnerFactory: { () -> any CLIRunner in
                                          if let blocked { return blocked }
                                          return ProcessRunner(environmentOverrides: cliEnv, executableEnvironment: executableEnv)
                                      },
                                      supportDirectory: { support })
        self.status = status
        let askRunner: CommandRunning = blocked ?? ProcessRunner(environmentOverrides: claudeEnv, executableEnvironment: executableEnv)
        let vm = ChatViewModel(runner: askRunner, bridge: bridge, loginPath: { ShellPath.loginPath() },
                               supportDirectory: { support },
                               settings: settings, status: status,
                               interactiveGate: interactiveGate, siteModes: siteModes, safariResources: resources)
        // 페이지 패널(사파리 확장)이 묻는 로컬 서버 — 127.0.0.1 에만 열고 연결 파일(`panel-link.json`)을 쓴다. 지원 폴더가 없으면 연결 파일 자리가 없으니 켜지 않는다.
        // 질문마다 새 실행기를 같은 공장으로 만든다(옆 창 질문과 부딪히지 않게). 폴더를 못 만들었으면 막힌 실행기가 그대로 안내를 낸다.
        if !supportFailed {
            let panelService = PanelAskService(
                selection: { waitForStatus in await vm.panelSelection(waitForStatus: waitForStatus) },
                runnerFactory: { () -> CommandRunning in
                    if let blocked { return blocked }
                    return ProcessRunner(environmentOverrides: claudeEnv, executableEnvironment: executableEnv)
                },
                loginPath: { ShellPath.loginPath() },
                workDirectory: { try AppPaths.workDirectory() },
                supportDirectory: { support },
                geminiLoggedOut: { await vm.loginState(for: .gemini) == .loggedOut },
                onRateLimits: { snap in Task { @MainActor in status.applyLiveUsage(.claude, snap) } },
                interactiveGate: interactiveGate,
                siteModes: siteModes,
                safariResources: resources)
            let host = PanelHost(directory: support, backend: panelService, alerts: alertRelay)
            self.panelService = panelService
            panelHost = host
            Task {
                do { try await host.start() } catch { NSLog("사파리-어트랙션: 페이지 패널 서버를 켜지 못했어요 (%@)", error.localizedDescription) }
            }
        }
        let loginRunner: CommandRunning = blocked ?? ProcessRunner(environmentOverrides: cliEnv)
        let deviceLogin = CodexDeviceLogin(runner: loginRunner, loginPath: { ShellPath.loginPath() })
        self.deviceLogin = deviceLogin
        settingsWindow = SettingsWindowController(status: status, login: deviceLogin, support: support, blockedMessage: blocked?.message)
        // 루틴 실행용 세션 — 서버 묶음은 앱 안(Resources/safari-attraction), 기억 · 사이트 허락 · 관문 소켓은 앱 지원 폴더.
        let agent = AgentSession(
            resources: resources,
            memoryHome: support.appendingPathComponent("memory", isDirectory: true),
            siteModes: siteModes,
            gateFactory: { try GateServer(directory: support) },
            runnerFactory: { () -> InteractiveRunning in
                if let blocked { return blocked }
                return ProcessRunner(environmentOverrides: claudeEnv)
            },
            claudeModel: { [vm] in vm.selectedModelID(for: .claude) },
            claudeEffort: { [vm] in vm.selectedEffort(for: .claude) },
            loginPath: { ShellPath.loginPath() })
        // 자주 하는 일 · 루틴 — 저장소는 폴더당 인스턴스 하나(화면과 시계가 같은 것을 쓴다). 시계는 루틴이 하나라도 켜져 있을 때만 돈다.
        // 알림 허락은 여기서 묻지 않는다(「끝나면 알림」 을 켤 때만).
        let routineStore = RoutineStore(directory: support)
        let scheduler = RoutineScheduler(store: routineStore, runner: agent)
        let hub = RoutineHub(store: routineStore, scheduler: scheduler, notifier: SystemRoutineNotifier(), preference: DefaultsNotifyPreference(),
                             warmUpLoginPath: { _ = ShellPath.loginPath() })   // 루틴을 켤 때 · 「지금 한 번」 때 메인 밖에서 미리 읽는다
        let controller = SidePanelController(viewModel: vm, agent: agent, siteModes: siteModes, hub: hub, bridge: bridge)
        vm.onPendingCardChange = { [weak self] _ in self?.refreshCardWaiting() }
        agent.onPendingCardChange = { [weak self] _ in self?.refreshCardWaiting() }
        self.viewModel = vm
        self.agent = agent
        self.hub = hub
        alertRelay.attach(hub)
        self.controller = controller

        let keys = HotKeys { [weak self] in self?.controller?.toggle() }
        keys.start()
        hotKeys = keys

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = UpdateStatusIcon.make(symbolName: Self.idleSymbol, hasUpdateDot: false, accessibilityDescription: "사파리-어트랙션")
        item.button?.toolTip = "사파리-어트랙션"

        // 자동 업데이트 서비스 — 앱 시작 10초 뒤 처음 확인하고, 이후 6시간마다 확인한다.
        let updateSvc = Self.makeUpdateService()
        let updateMenu = UpdateMenuController(service: updateSvc) {
            NSApplication.shared.terminate(nil)
        }
        updateSvc.onStateChange = { [weak self] _ in
            self?.updateMenu?.refresh()
            self?.refreshStatusBarIcon()
        }
        self.updateService = updateSvc
        self.updateMenu = updateMenu

        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = self
        updateMenu.attachTopItems(to: menu)
        let toggle = NSMenuItem(title: "옆 창 열기", action: #selector(togglePanel), keyEquivalent: "")
        toggle.target = self
        menu.addItem(toggle)
        toggleItem = toggle
        let settingsItem = NSMenuItem(title: "설정…", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)
        menu.addItem(.separator())
        updateMenu.attachBottomItems(to: menu)
        let quit = NSMenuItem(title: "종료", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        updateMenu.refresh()
        item.menu = menu
        statusItem = item
        // 사파리는 여기서 읽지 않는다 — 옆 창을 처음 연 뒤에야 읽기 시작한다(맥의 자동화 허락 창이 그때 뜬다).

        // 잠에서 깰 때 — 켜진 루틴이 있으면 놓친 시각을 한 번 살핀다(60분 안이면 돌고, 넘으면 건너뜀 기록).
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.hub?.handleWake() }
        }
        // 앱을 켤 때 — 켜진 루틴이 있으면 시계를 시작하고 곧바로 한 번 살핀다.
        hub.launch()
        // 버전이 바뀌었으면 자기 사파리 확장을 백그라운드에서 한 번 다시 등록한다(실패해도 조용히).
        if !supportFailed {
            Self.registerExtensionIfVersionChanged(settings: settings)
        }
        updateSvc.startSchedule()
    }

    private static let idleSymbol = "safari"
    private static let waitingSymbol = "bell.badge.fill"

    /// 승인 카드가 답을 기다리는 동안 메뉴 막대 아이콘을 「기다림」 모양으로.
    private var isWaiting = false
    private func refreshCardWaiting() {
        let waiting = (viewModel?.hasPendingCard ?? false) || (agent?.hasPendingCard ?? false)
        controller?.setCardWaiting(waiting)
        setWaitingIcon(waiting)
    }

    private func runningRoutineName() -> String? {
        guard let agent, agent.isRoutineRunning else { return nil }
        if let id = hub?.scheduler.activeRoutineID,
           let r = hub?.store.routine(id: id),
           let t = hub?.store.savedTask(id: r.taskID) {
            return t.name
        }
        return "루틴"
    }

    private func setWaitingIcon(_ waiting: Bool) {
        isWaiting = waiting
        refreshStatusBarIcon()
    }

    private func refreshStatusBarIcon() {
        let hasUpdate = updateMenu?.hasAvailableUpdate ?? false
        let symbol = isWaiting ? Self.waitingSymbol : Self.idleSymbol
        let label: String
        if isWaiting {
            label = "사파리-어트랙션 — 승인을 기다리는 카드가 있어요"
        } else if case .available(let release) = updateService?.state {
            label = "사파리-어트랙션 — \(UpdateMessages.newVersionAvailable(release.version))"
        } else {
            label = "사파리-어트랙션"
        }
        if let image = UpdateStatusIcon.make(symbolName: symbol,
                                             hasUpdateDot: !isWaiting && hasUpdate,
                                             accessibilityDescription: label) {
            statusItem?.button?.image = image
        }
        statusItem?.button?.toolTip = label
    }

    private static func makeUpdateService() -> UpdateService {
        let versionRaw = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let currentVersion = AppVersion(versionRaw) ?? AppVersion(major: 0, minor: 0, patch: 0)
        var feedURL = AppUpdate.defaultFeedURL
        var allowLocalhostHTTP = false

        #if SA_DEV_HOOKS
        if let raw = ProcessInfo.processInfo.environment["SAFARI_ATTRACTION_UPDATE_FEED"],
           !raw.isEmpty,
           let custom = URL(string: raw) {
            let scheme = custom.scheme?.lowercased()
            let host = custom.host?.lowercased()
            if scheme == "http" && host == "127.0.0.1" {
                feedURL = custom
                allowLocalhostHTTP = true
            } else if scheme == "https" && (host == "api.github.com" || UpdateVerifier.allowedDownloadURL(custom)) {
                feedURL = custom
            }
        }
        #endif

        return UpdateService(currentVersion: currentVersion,
                             currentAppURL: Bundle.main.bundleURL,
                             feedURL: feedURL,
                             allowLocalhostHTTP: allowLocalhostHTTP)
    }

    /// 지금 앱 버전이 `settings.json` 의 `lastLaunchedVersion` 과 다르면 `pluginkit -a` 로 확장을 한 번 다시 등록한다.
    private static func registerExtensionIfVersionChanged(settings: AppSettingsStore) {
        guard let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
              !version.isEmpty else {
            return
        }
        guard settings.current.lastLaunchedVersion != version else { return }
        try? settings.update { $0.lastLaunchedVersion = version }

        let appex = Bundle.main.bundleURL.appendingPathComponent(AppUpdate.extensionRelativePath, isDirectory: true)
        guard FileManager.default.fileExists(atPath: appex.path) else { return }
        let appexPath = appex.path
        Task.detached(priority: .utility) {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/pluginkit")
            process.arguments = ["-a", appexPath]
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try? process.run()
            process.waitUntilExit()
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        var title = "옆 창 열기 · 닫기"
        title += hotKeys?.statusSuffix ?? ""
        if isWaiting { title += " — 승인 기다리는 카드가 있어요" }
        toggleItem?.title = title
        updateMenu?.refresh()
    }

    @objc private func togglePanel() { controller?.toggle() }
    @objc private func openSettings() { settingsWindow?.show() }
    @objc private func quitApp() { NSApplication.shared.terminate(nil) }

    // MARK: 끝낼 때

    /// 답하는 중(옆 창 · 루틴 · 페이지 패널 질문)이면 CLI 를 먼저 멈춘다 — 멈춤은 SIGTERM, 2초 뒤 SIGKILL 이라 정리될 때까지 잠깐(최대 3초) 기다린다.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        updateService?.stopSchedule()
        hub?.shutdown()   // 끝내는 중에 새 루틴이 시작되지 않게 시계부터 끈다
        interactiveGate?.shutdown()   // 기다리는 관문 요청을 거절하고 gate-link.json 을 지운다
        panelHost?.shutdown()   // 페이지 패널 질문의 CLI 도 멈추고 연결 파일을 지운다
        let vm = viewModel, agent = agent, panel = panelService
        guard (vm?.isRunning ?? false) || (agent?.isRunning ?? false) || (panel?.isRunning ?? false) else { return .terminateNow }
        vm?.shutdown()
        agent?.shutdown()
        Task { @MainActor in
            for _ in 0..<30 where (vm?.isRunning ?? false) || (agent?.isRunning ?? false) || (panel?.isRunning ?? false) {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        updateService?.stopSchedule()
        hub?.shutdown()
        interactiveGate?.shutdown()
        panelHost?.shutdown()   // 두 끝내기 길 모두에서(여러 번 불려도 된다)
        viewModel?.shutdown()
        agent?.shutdown()
        settingsWindow?.shutdown()   // 도는 기기 코드 로그인을 멈춘다
        status?.shutdown()           // 상태 · 목록 · 남은 양을 읽는 중인 CLI 도 멈춘다
        controller?.shutdown()
        hotKeys?.shutdown()
        // 답하는 질문 · 루틴 정리가 끝난 뒤 준비된 업데이트가 있으면 바꿔 넣기 스크립트를 띄운다.
        _ = try? updateService?.launchPendingReplacement()
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
        vm.model = a.model
        vm.input = a.question
        guard let task = vm.send() else { return }
        Task { @MainActor in
            await task.value
            if let record = vm.lastRun { try? record.write(to: file) }
        }
    }
#endif
}
