import AppKit
import AppCore
import SwiftUI

/// 설정 창 — CLI 마다 설치 · 로그인 상태 · 로그인 단추 · 남은 양. 앱을 켤 때는 아무 CLI 도 부르지 않고, 이 창을 열 때만 읽는다.
@MainActor
final class SettingsWindowController: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private let status: CLIStatusService
    private let login: CodexDeviceLogin
    private let support: URL

    init(status: CLIStatusService, login: CodexDeviceLogin, support: URL) {
        self.status = status; self.login = login; self.support = support
        super.init()
        // 기기 코드 로그인이 끝나면 상태를 새로 읽는다.
        login.onFinished = { [status] success in
            if success { Task { await status.refresh(.chatgpt, force: true) } }
        }
    }

    func show() {
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 560),
                             styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            w.title = "사파리-어트랙션 설정"
            w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: SettingsView(status: status, login: login, support: support))
            w.delegate = self
            w.center()
            window = w
        }
        NSApp.activate()
        window?.makeKeyAndOrderFront(nil)
        Task { await status.refreshAll(force: false) }
    }

    /// 창을 닫으면 도는 로그인을 멈춘다(기기 코드 로그인은 몇 분을 기다리므로).
    func windowWillClose(_ notification: Notification) { login.cancel() }

    func shutdown() { login.cancel() }
}

struct SettingsView: View {
    let status: CLIStatusService
    @Bindable var login: CodexDeviceLogin
    let support: URL

    /// 터미널로 로그인을 열었던 CLI — 창이 다시 앞으로 오면 상태를 새로 읽는다.
    @State private var terminalOpenedFor: Set<ModelKind> = []
    @State private var notice: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("구독 CLI").font(.title3.weight(.semibold))
                ForEach(ModelKind.subscriptionCLIs, id: \.self) { kind in
                    CLIRowView(kind: kind, state: status.state(kind), login: login,
                               onLogin: { startLogin(kind) },
                               onRefresh: { Task { await status.refresh(kind, force: true) } })
                    Divider()
                }
                ForEach(["제미나이(agy)", "opencode"], id: \.self) { name in
                    HStack {
                        Text(name).font(.headline)
                        Spacer()
                        Text("곧 지원").font(.callout).foregroundStyle(.secondary)
                    }
                    .opacity(0.45)
                    Divider()
                }
                if let notice {
                    Text(notice).font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                }
                Text("앱은 CLI 마다 앱 전용 설정 폴더를 써요 — 사용자 설정 · 문서 폴더를 건드리지 않으려고. 그래서 여기서 한 번씩 따로 로그인해요.")
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Text("남은 양은 CLI 가 알려 주는 값이에요(버전이 바뀌면 안 보일 수 있어요). 읽지 못하면 「알 수 없음」 으로 보여요.")
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            .padding(20)
        }
        .frame(minWidth: 520, minHeight: 420)
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
        switch kind {
        case .claude: openTerminal(.claude)
        case .chatgpt: login.start()
        case .gemini: break
        }
    }

    /// 지원 폴더에 `.command` 파일을 쓰고 연다(Apple 이벤트 없이 `NSWorkspace.open`). 끝나면 창으로 돌아와 새로 고침.
    private func openTerminal(_ kind: ModelKind) {
        do {
            let url = try TerminalLogin.writeLoginFile(kind: kind, support: support)
            NSWorkspace.shared.open(url)
            terminalOpenedFor.insert(kind)
            if notice == nil { notice = "터미널 창에서 로그인을 마치고, 이 창으로 돌아오면 상태를 새로 읽어요." }
        } catch {
            notice = "터미널 로그인 파일을 만들지 못했어요 — \(error.localizedDescription)"
        }
    }
}

private struct CLIRowView: View {
    let kind: ModelKind
    let state: CLIState
    @Bindable var login: CodexDeviceLogin
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
        case .loggedOut: return "로그인 상태: 로그인이 안 돼 있어요"
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
        if let u = state.usage, !u.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                if let plan = u.plan { Text("플랜: \(plan)").font(.caption).foregroundStyle(.secondary) }
                ForEach(Array(u.windows.enumerated()), id: \.offset) { _, w in usageLine(w) }
                ForEach(Array(u.rawLines.enumerated()), id: \.offset) { _, l in Text(l).font(.caption).foregroundStyle(.secondary) }
            }
        } else if let note = state.usageNote {
            Text("남은 양: \(note)").font(.caption).foregroundStyle(.secondary)
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
