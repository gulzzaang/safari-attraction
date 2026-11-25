import AppKit
import AppCore
import SwiftUI

extension ModelKind {
    /// 고르는 칸에 보이는 이름.
    var pickerLabel: String {
        switch self {
        case .claude: return "Claude"
        case .gemini: return "제미나이"
        case .chatgpt: return "ChatGPT"
        case .opencode: return "opencode"
        }
    }
}

/// 링크는 사용자가 눌렀을 때만, 사파리에서(앞으로) 연다. 웹 주소 · 메일이 아니면 열지 않는다.
@MainActor
func openInSafari(_ url: URL) {
    guard MarkdownBlocks.isOpenable(url) else { return }
    let ws = NSWorkspace.shared
    if let safari = ws.urlForApplication(withBundleIdentifier: "com.apple.Safari"), url.scheme != "mailto" {
        ws.open([url], withApplicationAt: safari, configuration: NSWorkspace.OpenConfiguration())
    } else {
        ws.open(url)
    }
}

/// 옆 창에서 대화 대신 여는 하위 화면.
enum AgentScreen: Equatable {
    case none, sites, saved
    /// 루틴 화면 — 「루틴으로」 로 들어오면 그 일로 새 루틴을 시작한다.
    case routines(startWith: UUID?)
}

struct ChatView: View {
    @Bindable var vm: ChatViewModel
    @Bindable var agent: AgentSession
    let siteModes: SiteModeStore
    let hub: RoutineHub
    var onClose: () -> Void

    @State private var screen: AgentScreen = .none
    /// 「저장」 을 눌러 이름을 받는 중이면 그 이름(nil 이면 아님).
    @State private var savingName: String?
    @State private var saveNotice: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if screen != .none {
                subScreenView
            } else {
                messageList
                Divider()
                composer
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.primary.opacity(0.15)))
        .onExitCommand(perform: onClose)
        .onChange(of: vm.hasPendingCard) { _, pending in
            if pending { screen = .none }   // 허락 카드가 생기면 하위 화면을 닫아 카드를 보이게
        }
        .environment(\.openURL, OpenURLAction { url in
            if MarkdownBlocks.isOpenable(url) { openInSafari(url); return .handled }
            return .discarded
        })
    }

    @ViewBuilder
    private var subScreenView: some View {
        switch screen {
        case .none:
            EmptyView()
        case .sites:
            SiteModesView(store: siteModes, onClose: { screen = .none })
        case .saved:
            SavedTasksView(hub: hub, isBusy: vm.isRunning, onClose: { screen = .none },
                           onLoad: { task in
                               if !vm.isRunning { vm.input = task.text }
                               screen = .none
                           },
                           onMakeRoutine: { task in screen = .routines(startWith: task.id) })
        case .routines(let startWith):
            RoutinesView(hub: hub, agent: agent, startWithTaskID: startWith, onClose: { screen = .none })
        }
    }

    /// 루틴이 도는 중이면 그 루틴의 이름 — 도는 동안에도 입력을 잠그지 않고 띠 한 줄만 보인다.
    private var runningRoutineName: String? {
        guard agent.isRoutineRunning else { return nil }
        if let id = hub.scheduler.activeRoutineID, let r = hub.store.routine(id: id), let t = hub.store.savedTask(id: r.taskID) { return t.name }
        return "…"
    }

    // MARK: 머리줄

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("사파리-어트랙션")
                    .font(.headline)
                    .lineLimit(1)
                    .layoutPriority(1)
                Spacer(minLength: 4)
                headerPill("새 대화", active: false, disabled: vm.messages.isEmpty && !vm.isRunning) {
                    vm.newChat()
                }
                headerPill("고정", symbol: vm.pinned ? "pin.fill" : "pin", active: vm.pinned, disabled: false) {
                    vm.setPinned(!vm.pinned)
                }
                .help("켜면 사파리가 앞이 아니어도 옆 창이 숨지 않아요")
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.semibold))
                        .frame(width: 22, height: 22)
                        .background(Color.primary.opacity(0.07), in: Circle())
                }
                .buttonStyle(.plain)
                .help("닫기 (\(HotKeys.toggleLabel))")
            }

            if vm.availableModels.count > 1 {
                cliPicker
            }

            FlowLayout(spacing: 6, lineSpacing: 6) {
                headerPill("사이트 허락", symbol: "checkmark.shield", active: screen == .sites,
                           disabled: vm.hasPendingCard) {
                    screen = (screen == .sites) ? .none : .sites
                }
                headerPill("저장한 일", active: screen == .saved, disabled: vm.hasPendingCard) {
                    screen = (screen == .saved) ? .none : .saved
                }
                headerPill("루틴", active: isRoutinesScreen, disabled: vm.hasPendingCard) {
                    screen = isRoutinesScreen ? .none : .routines(startWith: nil)
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }

    private var isRoutinesScreen: Bool {
        if case .routines = screen { return true }
        return false
    }

    private func headerPill(_ title: String, symbol: String? = nil, active: Bool, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 3) {
                if let symbol { Image(systemName: symbol).font(.caption2) }
                Text(title).font(.caption.weight(active ? .semibold : .regular)).fixedSize()
            }
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(active ? Color.accentColor.opacity(0.20) : Color.primary.opacity(0.07), in: Capsule())
            .overlay(Capsule().strokeBorder(active ? Color.accentColor.opacity(0.8) : Color.primary.opacity(0.10), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.45 : 1)
    }

    /// 옆 창 위쪽 — CLI 알약 고르기. 로그인이 안 된 걸 아는 CLI 는 흐리게, 누르면 「설정에서 로그인」 안내.
    private var cliPicker: some View {
        FlowLayout(spacing: 6, lineSpacing: 6) {
            ForEach(vm.availableModels, id: \.self) { kind in
                cliChip(kind, selected: vm.model == kind, dimmed: vm.loginState(for: kind) == .loggedOut) {
                    // 바꿨으면 그 CLI 의 상태 · 목록 · 남은 양을 읽는다(5분 안에 읽었으면 다시 읽지 않는다 — 메인 밖).
                    if vm.selectCLI(kind) { Task { await vm.refreshStatus(for: kind) } }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .disabled(vm.isRunning)
    }

    private func cliChip(_ kind: ModelKind, selected: Bool, dimmed: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(kind.pickerLabel)
                .font(.callout.weight(selected ? .semibold : .regular))
                .fixedSize()
                .padding(.horizontal, 11).padding(.vertical, 4)
                .background(selected ? Color.accentColor.opacity(0.22) : Color.primary.opacity(0.07), in: Capsule())
                .overlay(Capsule().strokeBorder(selected ? Color.accentColor : Color.primary.opacity(0.08), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .opacity(dimmed ? 0.4 : 1)
        .help(dimmed ? "로그인이 안 돼 있어요 — 설정에서 로그인" : "")
    }

    // MARK: 대화

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if vm.messages.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("무엇이든 물어보거나 시켜 보세요").font(.subheadline.weight(.semibold))
                            Text("질문에 답하고, 필요하면 고른 AI가 지금 보는 사파리 탭을 읽거나 움직여요. 페이지를 바꾸는 동작은 사이트 허락 기준에 따라 카드로 먼저 물어봐요.")
                                .font(.callout).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.top, 8)
                    }
                    ForEach(vm.messages) { msg in
                        MessageView(message: msg, activity: vm.activity) { cardID, answer in
                            vm.answerCard(id: cardID, answer)
                        }
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(12)
            }
            .onChange(of: vm.messages.count) { proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: vm.messages.last?.text) { proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: vm.hasPendingCard) { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    // MARK: 입력(한 칸)

    private var composer: some View {
        let canSend = !vm.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return VStack(alignment: .leading, spacing: 8) {
            if let routineName = runningRoutineName {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("루틴 '\(routineName)' 도는 중").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 0)
                    if agent.isStopping {
                        Text("멈추는 중…").font(.caption).foregroundStyle(.secondary)
                    } else {
                        headerPill("멈추기", active: false, disabled: false, action: agent.stop)
                    }
                }
            }

            if let name = savingName {
                HStack(spacing: 6) {
                    TextField("저장할 이름", text: Binding(get: { name }, set: { savingName = $0 }))
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(commitSave)
                    headerPill("저장", active: true, disabled: name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, action: commitSave)
                    headerPill("취소", active: false, disabled: false) { savingName = nil }
                }
                .controlSize(.small)
            } else if let saveNotice {
                Text(saveNotice).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }

            if let hint = vm.hint {
                Text(hint).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }

            InputTextView(text: $vm.input, focusTick: vm.focusTick, onSubmit: { vm.send() })
                .padding(.horizontal, 4)
                .padding(.vertical, 2)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.primary.opacity(0.14), lineWidth: 1))
                .overlay(alignment: .topLeading) {
                    if vm.input.isEmpty {
                        Text("무엇이든 물어보거나 시키세요")
                            .font(.system(size: 13)).foregroundStyle(.tertiary)
                            .padding(.horizontal, InputTextView.insetX + InputTextView.linePadding + 4)
                            .padding(.vertical, InputTextView.insetY + 2)
                            .allowsHitTesting(false)
                    }
                }

            composerControls(canSend: canSend)

            if let usageLine = composerUsageLine {
                Text(usageLine)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help("CLI 가 알려 주는 값이에요(옆 창을 열 때 5분에 한 번 읽어요)")
            }
        }
        .padding(12)
    }

    private var composerUsageLine: String? {
        var parts: [String] = []
        if let remaining = vm.remainingUsageText {
            parts.append(vm.model == .opencode ? remaining : "남은 양 · " + remaining)
        }
        if let last = vm.lastUsageText {
            parts.append(last)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// 아래 줄: [모델 ▾] [생각: <이름> ▾] · 빈칸 · [저장] [보내기/멈춤] — 좁은 폭(280pt)에서는 두 줄로 접혀 잘리지 않는다.
    private func composerControls(canSend: Bool) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) {
                modelAndEffortMenus
                Spacer(minLength: 4)
                saveAndSendButtons(canSend: canSend)
            }
            VStack(alignment: .leading, spacing: 6) {
                FlowLayout(spacing: 6, lineSpacing: 6) {
                    modelAndEffortMenus
                }
                HStack(spacing: 6) {
                    Spacer(minLength: 0)
                    saveAndSendButtons(canSend: canSend)
                }
            }
        }
    }

    @ViewBuilder
    private var modelAndEffortMenus: some View {
        let kind = vm.model
        let choices = vm.displayModelChoices(for: kind)
        let efforts = vm.effortChoices(for: kind)

        if choices.isEmpty {
            Text(CLIModels.loadFailureNote(for: kind))
                .font(.caption2).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            let currentID = vm.selectedDisplayModelID(for: kind) ?? choices.first?.id ?? ""
            let currentLabel = choices.first(where: { $0.id == currentID })?.label ?? currentID
            Menu {
                ForEach(choices) { choice in
                    Button {
                        vm.setModelID(choice.id, for: kind)
                    } label: {
                        if choice.id == currentID {
                            Label(choice.label, systemImage: "checkmark")
                        } else {
                            Text(choice.label)
                        }
                    }
                }
            } label: {
                pillMenuLabel(currentLabel)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .disabled(vm.isRunning)
        }

        if Effort.shouldShowPicker(choices: efforts) {
            let currentEffort = vm.selectedEffort(for: kind)
            Menu {
                Button {
                    vm.setEffort(nil, for: kind)
                } label: {
                    if currentEffort == nil {
                        Label("기본", systemImage: "checkmark")
                    } else {
                        Text("기본")
                    }
                }
                Divider()
                ForEach(efforts, id: \.self) { level in
                    Button {
                        vm.setEffort(level, for: kind)
                    } label: {
                        if currentEffort == level {
                            Label(Effort.label(level), systemImage: "checkmark")
                        } else {
                            Text(Effort.label(level))
                        }
                    }
                }
            } label: {
                pillMenuLabel(Effort.pickerTitle(selected: currentEffort))
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .disabled(vm.isRunning)
        }
    }

    private func pillMenuLabel(_ title: String) -> some View {
        HStack(spacing: 4) {
            Text(title).font(.caption).lineLimit(1).fixedSize()
            Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10).padding(.vertical, 4)
        .background(Color.primary.opacity(0.07), in: Capsule())
        .overlay(Capsule().strokeBorder(Color.primary.opacity(0.12), lineWidth: 1))
    }

    @ViewBuilder
    private func saveAndSendButtons(canSend: Bool) -> some View {
        HStack(spacing: 6) {
            Button(action: startSave) {
                Text("저장")
                    .font(.caption.weight(.medium))
                    .fixedSize()
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(Color.primary.opacity(0.07), in: Capsule())
                    .overlay(Capsule().strokeBorder(Color.primary.opacity(0.12), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .opacity(canSend ? 1 : 0.45)
            .help("지금 입력한 글을 이름 붙여 저장해요(보내지는 않아요)")

            if vm.isStopping {
                HStack(spacing: 4) {
                    ProgressView().controlSize(.small)
                    Text("멈추는 중…").font(.caption).fixedSize()
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(Color.primary.opacity(0.06), in: Capsule())
            } else if vm.isRunning {
                Button(action: vm.stop) {
                    HStack(spacing: 4) {
                        Image(systemName: "stop.fill").font(.caption2)
                        Text("멈춤").font(.caption.weight(.semibold)).fixedSize()
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12).padding(.vertical, 5)
                    .background(Color.red, in: Capsule())
                }
                .buttonStyle(.plain)
                .help("멈춤")
            } else {
                Button { vm.send() } label: {
                    HStack(spacing: 4) {
                        Text("보내기").font(.caption.weight(.semibold)).fixedSize()
                        Image(systemName: "arrow.up").font(.caption2.weight(.bold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12).padding(.vertical, 5)
                    .background(canSend ? Color.accentColor : Color.accentColor.opacity(0.45), in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .help("보내기 (Return)")
            }
        }
    }

    private func startSave() {
        let text = vm.input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        savingName = String(text.split(whereSeparator: \.isNewline).first?.prefix(20) ?? "")
        saveNotice = nil
    }

    private func commitSave() {
        guard let name = savingName else { return }
        do {
            let saved = try hub.saveTask(SavedTask(name: name, text: vm.input))
            savingName = nil
            saveNotice = "「\(saved.name)」 으로 저장했어요 — 「저장한 일」 에서 다시 부르고 「루틴으로」 정해진 시각에 돌릴 수 있어요"
        } catch {
            saveNotice = "저장하지 못했어요 — \(error.localizedDescription)"
            savingName = nil
        }
    }
}

// MARK: - 말풍선

private struct MessageView: View {
    let message: ChatMessage
    let activity: String?
    let onAnswerCard: (UUID, AgentAnswer) -> Void

    var body: some View {
        if let cardID = message.cardID, let card = message.card {
            ChatCardView(card: card) { answer in
                onAnswerCard(cardID, answer)
            }
        } else {
            switch message.role {
            case .user: userBubble
            case .assistant: assistantBubble
            }
        }
    }

    private var userBubble: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if let title = message.pageTitle {
                Label(title, systemImage: "doc.text")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Text(message.text)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color.accentColor.opacity(0.16), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.accentColor.opacity(0.25), lineWidth: 1))
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var assistantBubble: some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        return VStack(alignment: .leading, spacing: 6) {
            if let m = message.model {
                Text(m.pickerLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            if let notice = message.notice {
                Text(notice)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !message.text.isEmpty {
                MarkdownView(text: message.text)
            }
            if message.isStreaming {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(activity ?? (message.text.isEmpty ? "생각하는 중이에요…" : ""))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let status = message.status {
                Text(status)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let error = message.error {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .textBackgroundColor), in: shape)
        .overlay(shape.strokeBorder(Color.primary.opacity(0.12), lineWidth: 1))
    }
}

/// 답 글 그리기 — 문단 · 제목 · 목록 · 코드 상자. 줄 안 서식은 `AttributedString(markdown:)`.
struct MarkdownView: View {
    let text: String
    /// false 면 링크를 누를 수 없게(글로만) 보인다.
    var links = true

    private func inline(_ t: String) -> AttributedString {
        links ? MarkdownBlocks.attributed(t) : MarkdownBlocks.attributedWithoutLinks(t)
    }

    var body: some View {
        let blocks = MarkdownBlocks.parse(text)
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let t):
                    Text(inline(t))
                        .fixedSize(horizontal: false, vertical: true)
                case .heading(let level, let t):
                    Text(inline(t))
                        .font(level <= 1 ? .title3.bold() : .headline)
                        .fixedSize(horizontal: false, vertical: true)
                case .listItem(let marker, let t):
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(marker).foregroundStyle(.secondary)
                        Text(inline(t)).fixedSize(horizontal: false, vertical: true)
                    }
                case .code(_, let t):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(t).font(.system(.callout, design: .monospaced)).fixedSize(horizontal: true, vertical: false)
                    }
                    .padding(8)
                    .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }
}
