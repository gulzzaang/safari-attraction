import AppKit
import AppCore
import SwiftUI

/// 설정 창 — CLI 넷(클로드 · 제미나이 · ChatGPT · opencode)마다 설치 · 로그인 상태 · 로그인 단추 · 남은 양. 앱을 켤 때는 아무 CLI 도 부르지 않고, 이 창을 열 때만 읽는다.
@MainActor
final class SettingsWindowController: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private let status: CLIStatusService
    private let login: CodexDeviceLogin
    private let support: URL
    private let settings: AppSettingsStore
    private let blockedMessage: String?

    init(status: CLIStatusService, login: CodexDeviceLogin, support: URL, settings: AppSettingsStore, blockedMessage: String? = nil) {
        self.status = status; self.login = login; self.support = support; self.settings = settings; self.blockedMessage = blockedMessage
        super.init()
        // 기기 코드 로그인이 끝나면 상태를 새로 읽는다.
        login.onFinished = { [status] success in
            if success { Task { await status.refresh(.chatgpt, force: true) } }
        }
    }

    func show() {
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 580, height: 680),
                             styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            w.title = "사파리-어트랙션 설정"
            w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: SettingsView(status: status, login: login, support: support, settings: settings, blockedMessage: blockedMessage))
            w.delegate = self
            w.center()
            window = w
        }
        NSApp.activate()
        window?.makeKeyAndOrderFront(nil)
        // 앱 전용 HOME 방식의 제미나이는 `agy models` 가 키체인 창을 띄울 수 있어서 자동으로 읽지 않는다(새로 고침 · 로그인을 누를 때만).
        let agyAutoRead = settings.current.agyMode == .shared
        Task { await status.refreshAll(force: false, agyAutoRead: agyAutoRead) }
    }

    /// 창을 닫으면 도는 로그인을 멈춘다(기기 코드 로그인은 몇 분을 기다리므로).
    func windowWillClose(_ notification: Notification) { login.cancel() }

    func shutdown() { login.cancel() }
}

struct SettingsView: View {
    let status: CLIStatusService
    @Bindable var login: CodexDeviceLogin
    let support: URL
    let settings: AppSettingsStore
    /// 앱 전용 설정 폴더를 못 만들었을 때의 안내 — 있으면 터미널 로그인도 열지 않는다(임시 폴더로 로그인하는 길을 막는다).
    var blockedMessage: String?

    /// 제미나이(agy)를 띄우는 방식 — 설정에서 읽어 오고, 바꾸면 저장한다.
    @State private var agyMode: AgyMode = .isolated
    @State private var copiedDisableLine = false
    /// 터미널로 로그인을 열었던 CLI — 창이 다시 앞으로 오면 상태를 새로 읽는다.
    @State private var terminalOpenedFor: Set<ModelKind> = []
    @State private var notice: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("구독 CLI").font(.title3.weight(.semibold))
                ForEach(ModelKind.subscriptionCLIs, id: \.self) { kind in
                    CLIRowView(kind: kind, state: status.state(kind), login: login,
                               unreadHint: kind == .gemini && agyMode == .isolated && status.state(kind).lastRefresh == nil
                                   ? "앱 전용 폴더 방식은 키체인 창을 피하려고 열 때 자동으로 읽지 않아요 — [새로 고침] 이나 [로그인] 을 누르면 읽어요." : nil,
                               onLogin: { startLogin(kind) },
                               onRefresh: { Task { await status.refresh(kind, force: true) } })
                    if kind == .gemini { agySection }
                    if kind == .opencode {
                        Text("로그인 없이 쓰는 무료 사용량은 금방 막혀요 — opencode 는 로그인해서 쓰세요. 구독 남은 양은 알려 주는 명령이 없어서 이 맥에서 쓴 양만 보여요.")
                            .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    Divider()
                }
                if let notice {
                    Text(notice).font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                }
                Text("앱은 CLI 마다 앱 전용 설정 폴더(또는 환경)로 띄워요 — 사용자 설정 · 문서 폴더를 건드리지 않으려고. 그래서 여기서 한 번씩 따로 로그인해요. 제미나이 · opencode 는 터미널 창이 열려요(제미나이는 로그인 뒤 /quit 으로 끝내고 창을 닫으세요).")
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Text("남은 양은 CLI 가 알려 주는 값이에요(버전이 바뀌면 안 보일 수 있어요). 읽지 못하면 「알 수 없음」 으로 보여요. 옆 창 입력 칸 아래 한 줄은 고른 CLI 의 값이고, 옆 창을 열 때 5분에 한 번까지만 읽어요.")
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            .padding(20)
        }
        .frame(minWidth: 540, minHeight: 440)
        .onAppear { agyMode = settings.current.agyMode }
        .onChange(of: login.state) { _, new in
            if new == .needsTerminal {
                notice = "주소와 코드를 읽지 못해 터미널로 같은 로그인을 열었어요."
                openTerminal(.chatgpt)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
            let pending = terminalOpenedFor
            guard !pending.isEmpty else { return }
            terminalOpenedFor = []
            Task { for k in pending { await status.refresh(k, force: true) } }
        }
    }

    private func startLogin(_ kind: ModelKind) {
        notice = nil
        if let blockedMessage { notice = blockedMessage; return }
        switch kind {
        case .chatgpt: login.start()
        case .claude, .gemini, .opencode: openTerminal(kind)
        }
    }

    /// 제미나이 줄 아래 — 앱 전용 폴더(시험판) / 내 설정 함께 쓰기. 바꾸면 저장하고 제미나이 상태를 새로 읽는다.
    private var agySection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Picker("제미나이 방식", selection: Binding(get: { agyMode }, set: { setAgyMode($0) })) {
                ForEach(AgyMode.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .controlSize(.small)
            if agyMode == .isolated {
                Text("앱 전용 폴더(시험판) — 앱이 HOME 을 앱 전용 폴더로 바꿔 agy 를 띄워요. 이 방식은 맥 키체인을 못 찾아 로그인이 될지 아직 확인 전이에요. 안 되면 「내 설정 함께 쓰기」 로 바꿔 보세요.")
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else {
                Text("내 설정 함께 쓰기 — 터미널에서 쓰던 제미나이 로그인 · 설정을 그대로 써요(앱이 설정을 바꾸지 않아요).")
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Text(AgyMode.sharedWarning)
                    .font(.footnote).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Text(AgyMode.disableMCPCommand).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                    Button(copiedDisableLine ? "복사했어요" : "줄 복사") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(AgyMode.disableMCPCommand, forType: .string)
                        copiedDisableLine = true
                    }
                    .controlSize(.small)
                }
            }
        }
    }

    private func setAgyMode(_ mode: AgyMode) {
        guard mode != agyMode else { return }
        agyMode = mode
        copiedDisableLine = false
        do { try settings.update { $0.agyMode = mode } } catch {
            notice = "제미나이 방식을 저장하지 못했어요 — \(error.localizedDescription)"
        }
        Task { await status.refresh(.gemini, force: true) }
    }

    /// 지원 폴더에 `.command` 파일을 쓰고 연다(Apple 이벤트 없이 `NSWorkspace.open`). 끝나면 창으로 돌아와 새로 고침.
    private func openTerminal(_ kind: ModelKind) {
        if let blockedMessage { notice = blockedMessage; return }   // 폴더를 못 만들었으면 터미널 로그인도 안 연다
        let support = self.support, mode = agyMode
        // 로그인 PATH 읽기는 로그인 셸을 돌려 몇 초 걸릴 수 있어서 메인 밖에서 — `.command` 가 그 PATH 와 찾은 절대 경로를 쓴다.
        Task {
            let path = await Task.detached(priority: .userInitiated) { ShellPath.loginPath() }.value
            do {
                let url = try TerminalLogin.writeLoginFile(kind: kind, support: support, agyMode: mode, loginPath: path)
                NSWorkspace.shared.open(url)
                terminalOpenedFor.insert(kind)
                if notice == nil { notice = "터미널 창에서 로그인을 마치고, 이 창으로 돌아오면 상태를 새로 읽어요." }
            } catch {
                notice = "터미널 로그인 파일을 만들지 못했어요 — \(error.localizedDescription)"
            }
        }
    }
}

private struct CLIRowView: View {
    let kind: ModelKind
    let state: CLIState
    @Bindable var login: CodexDeviceLogin
    var unreadHint: String?
    let onLogin: () -> Void
    let onRefresh: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(CLICommands.displayName(kind)).font(.headline)
                Spacer()
                if state.isRefreshing { ProgressView().controlSize(.small) }
                Button("로그인", action: onLogin)
                    .controlSize(.small)
                    .disabled(state.installChecked && state.installedPath == nil || (kind == .chatgpt && login.isActive))
                Button("새로 고침", action: onRefresh).controlSize(.small).disabled(state.isRefreshing)
            }
            Text(installText).font(.callout).foregroundStyle(.secondary).lineLimit(2).truncationMode(.middle)
            Text(loginText).font(.callout)
            if let unreadHint { Text(unreadHint).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            if kind == .chatgpt { deviceLoginView }
            usageView
        }
    }

    private var installText: String {
        if !state.installChecked { return "설치 여부 확인 전" }
        if let p = state.installedPath { return "설치됨 · \(p)" }
        return "설치돼 있지 않아요"
    }

    private var loginText: String {
        switch state.login {
        case .unknown: return "로그인 상태: " + (state.loginNote ?? (state.installChecked ? "알 수 없음" : "아직 안 읽었어요"))
        case .loggedOut:
            return kind == .opencode ? "로그인 상태: 로그인 필요 — 로그인 없이 쓰는 무료 사용량은 금방 막혀요" : "로그인 상태: 로그인이 안 돼 있어요"
        case .loggedIn(let info): return "로그인 상태: " + info.summary
        }
    }

    @ViewBuilder private var deviceLoginView: some View {
        switch login.state {
        case .idle, .succeeded, .needsTerminal:
            EmptyView()
        case .starting:
            HStack(spacing: 6) { ProgressView().controlSize(.small); Text("주소와 코드를 기다리는 중이에요…").font(.callout).foregroundStyle(.secondary) }
        case .waiting(let prompt):
            VStack(alignment: .leading, spacing: 6) {
                Text("1. 아래 [주소 열기] 를 눌러 브라우저에서 로그인해 주세요").font(.callout)
                Text("2. 이 일회용 코드를 입력해 주세요").font(.callout)
                Text(prompt.code).font(.system(.title2, design: .monospaced).weight(.semibold)).textSelection(.enabled)
                HStack {
                    Button("주소 열기") { NSWorkspace.shared.open(prompt.url) }.controlSize(.small)
                    Button("취소") { login.cancel() }.controlSize(.small)
                }
            }
            .padding(10)
            .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        case .failed(let msg):
            Text(msg).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder private var usageView: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let u = state.usage, !u.isEmpty {
                if let plan = u.plan { Text("플랜: \(plan)").font(.caption).foregroundStyle(.secondary) }
                ForEach(Array(u.windows.enumerated()), id: \.offset) { _, w in usageLine(w) }
                ForEach(Array(u.rawLines.enumerated()), id: \.offset) { _, l in Text(l).font(.caption).foregroundStyle(.secondary) }
            }
            if let note = state.usageNote {
                // opencode 는 남은 양을 못 얻어서 늘 이 안내가 붙는다(이 맥에서 쓴 양이 있으면 위에 같이).
                Text(kind == .opencode ? note : "남은 양: \(note)").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func usageLine(_ w: UsageWindow) -> some View {
        HStack(spacing: 8) {
            Text(w.name).font(.caption).frame(width: 110, alignment: .leading).lineLimit(1)
            if let f = w.usedFraction {
                ProgressView(value: f).tint(f >= 0.95 ? .red : (f >= 0.8 ? .orange : .accentColor)).frame(width: 100)
            }
            Text(UsageFormat.percentText(w)).font(.caption.monospacedDigit())
            if let r = UsageFormat.resetText(w) { Text(r).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
        }
    }
}
