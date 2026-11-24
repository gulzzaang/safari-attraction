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

/// 입력 칸 위의 두 칸 — 묻기(질문에 답) · 일 맡기기(클로드가 사파리를 움직임).
enum ChatMode: String, CaseIterable {
    case ask, agent
    var label: String { self == .ask ? "묻기" : "일 맡기기" }
}

/// 일 맡기기 칸에서 입력 대신 보이는 화면.
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

    @State private var mode: ChatMode = .ask
    @State private var screen: AgentScreen = .none
    /// 「저장」 을 눌러 이름을 받는 중이면 그 이름(nil 이면 아님).
    @State private var savingName: String?
    @State private var saveNotice: String?

    /// 사람이 하는 일(묻기 · 일 맡기기)이 도는 중. 배경에서 도는 루틴은 모드 바꾸기를 막지 않는다(일 맡기기 입력만 잠근다).
    private var busy: Bool { vm.isRunning || (agent.isRunning && !agent.isRoutineRunning) }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if mode == .agent && screen != .none {
                agentScreenView
            } else {
                if mode == .ask { messageList } else { agentMessageList }
                Divider()
                composer
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.primary.opacity(0.15)))
        .onExitCommand(perform: onClose)
        .onChange(of: agent.hasPendingCard) { _, pending in
            if pending { screen = .none }   // 허락을 기다리는 카드가 생기면 사이트 허락 · 저장한 일 · 루틴 화면을 닫아 카드를 보이게
        }
        .environment(\.openURL, OpenURLAction { url in
            if MarkdownBlocks.isOpenable(url) { openInSafari(url); return .handled }
            return .discarded
        })
    }

    @ViewBuilder
    private var agentScreenView: some View {
        switch screen {
        case .none:
            EmptyView()
        case .sites:
            SiteModesView(store: siteModes, onClose: { screen = .none })
        case .saved:
            SavedTasksView(hub: hub, agent: agent, onClose: { screen = .none },
                           onLoad: { task in
                               if !agent.isRunning { agent.input = task.text }
                               screen = .none
                           },
                           onMakeRoutine: { task in screen = .routines(startWith: task.id) })
        case .routines(let startWith):
            RoutinesView(hub: hub, agent: agent, startWithTaskID: startWith, onClose: { screen = .none })
        }
    }

    /// 루틴이 도는 중이면 그 루틴의 이름 — 도는 중에는 일 맡기기 입력을 막고 한 줄로 알린다.
    private var runningRoutineName: String? {
        guard agent.isRoutineRunning else { return nil }
        if let id = hub.scheduler.activeRoutineID, let r = hub.store.routine(id: id), let t = hub.store.savedTask(id: r.taskID) { return t.name }
        return "…"
    }

    // MARK: 머리줄

    private var header: some View {
        VStack(spacing: 8) {
            HStack {
                Text("사파리-어트랙션").font(.headline)
                Spacer()
                Button("새 대화") { if mode == .ask { vm.newChat() } else { agent.newTask() } }
                    .controlSize(.small)
                    .disabled(mode == .ask ? (vm.messages.isEmpty && !vm.isRunning) : (agent.messages.isEmpty && !agent.isRunning))
                Button(action: onClose) { Image(systemName: "xmark") }
                    .buttonStyle(.borderless)
                    .help("닫기 (\(HotKey.toggleLabel))")
            }
            if mode == .ask, vm.availableModels.count > 1 {
                Picker("모델", selection: $vm.model) {
                    ForEach(vm.availableModels, id: \.self) { Text($0.pickerLabel).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .disabled(vm.isRunning)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }

    // MARK: 대화

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if vm.messages.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("무엇이든 물어보세요").font(.subheadline.weight(.semibold))
                            Text("질문을 입력하면 클로드의 답이 흘러나와요. 「이 페이지 함께」를 켜면 지금 보는 사파리 탭의 제목 · 주소 · 고른 글을 같이 보내요.")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                        .padding(.top, 8)
                    }
                    ForEach(vm.messages) { MessageView(message: $0, activity: vm.activity) }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(12)
            }
            .onChange(of: vm.messages.count) { proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: vm.messages.last?.text) { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    // MARK: 입력

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("모드", selection: $mode) {
                ForEach(ChatMode.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .disabled(busy)
            .help(busy ? "답하는 중에는 바꿀 수 없어요" : "묻기: 질문에 답해요 · 일 맡기기: 클로드가 사파리를 직접 움직여요")
            if mode == .ask { askComposer } else { agentComposer }
        }
        .padding(12)
    }

    private var askComposer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Toggle("웹 검색", isOn: $vm.webSearch)
                Toggle("이 페이지 함께", isOn: $vm.attachPage)
                Toggle("고정", isOn: Binding(get: { vm.pinned }, set: { vm.setPinned($0) }))
                    .help("켜면 사파리가 앞이 아니어도 옆 창이 숨지 않아요")
            }
            .toggleStyle(.checkbox)
            .controlSize(.small)

            if let hint = vm.hint {
                Text(hint).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }

            HStack(alignment: .bottom, spacing: 8) {
                InputTextView(text: $vm.input, focusTick: vm.focusTick, onSubmit: { vm.send() })
                    .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(alignment: .topLeading) {
                        if vm.input.isEmpty {
                            Text("질문을 입력하세요 (Return 보내기 · Option+Return 줄바꿈)")
                                .font(.system(size: 13)).foregroundStyle(.tertiary)
                                .padding(.horizontal, InputTextView.insetX + InputTextView.linePadding)
                                .padding(.vertical, InputTextView.insetY)
                                .allowsHitTesting(false)
                        }
                    }
                if vm.isStopping {
                    HStack(spacing: 4) { ProgressView().controlSize(.small); Text("멈추는 중…").font(.caption) }
                        .foregroundStyle(.secondary)
                } else if vm.isRunning {
                    Button(action: vm.stop) { Image(systemName: "stop.circle.fill").font(.title2) }
                        .buttonStyle(.borderless).help("멈춤")
                } else {
                    Button { vm.send() } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                        .buttonStyle(.borderless).help("보내기 (Return)")
                        .disabled(vm.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    // MARK: 일 맡기기

    private var agentMessageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if agent.messages.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("사파리 일을 맡겨 보세요").font(.subheadline.weight(.semibold))
                            Text("클로드가 먼저 작업 목록을 보여 드려요. 「이대로 진행」을 눌러야 사파리를 움직이고, 페이지를 바꾸는 동작은 사이트마다 정한 허락(「사이트 허락」)대로 물어봐요.")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                        .padding(.top, 8)
                    }
                    ForEach(agent.messages) { AgentMessageView(message: $0, agent: agent) }
                    if agent.isRunning, !agent.isRoutineRunning, !agent.hasPendingCard {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text(agent.activity ?? "일하는 중이에요…").font(.caption).foregroundStyle(.secondary)
                        }
                    } else if agent.hasPendingCard {
                        Label("위 카드에 답해 주세요", systemImage: "hourglass").font(.caption).foregroundStyle(.orange)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(12)
            }
            .onChange(of: agent.messages.count) { proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: agent.messages.last) { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    private var agentComposer: some View {
        let routineName = runningRoutineName
        let inputBlocked = agent.isRoutineRunning
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Button { screen = .sites } label: { Label("사이트 허락", systemImage: "checkmark.shield") }
                    .controlSize(.small)
                    .disabled(agent.isRunning || agent.hasPendingCard)   // 일하는 중 · 카드가 기다리는 중엔 가리지 않게 끈다
                    .help(agent.isRunning ? "일하는 중에는 고를 수 없어요" : "")
                Button("저장한 일") { screen = .saved }
                    .controlSize(.small)
                    .disabled(agent.hasPendingCard)
                Button("루틴") { screen = .routines(startWith: nil) }
                    .controlSize(.small)
                    .disabled(agent.hasPendingCard)
                Toggle("고정", isOn: Binding(get: { vm.pinned }, set: { vm.setPinned($0) }))
                    .toggleStyle(.checkbox).controlSize(.small)
                    .help("켜면 사파리가 앞이 아니어도 옆 창이 숨지 않아요")
                Spacer(minLength: 0)
            }
            if let routineName {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("루틴 '\(routineName)' 도는 중").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 0)
                    if agent.isStopping {
                        Text("멈추는 중…").font(.caption).foregroundStyle(.secondary)
                    } else {
                        Button("멈추기", action: agent.stop).controlSize(.small)
                    }
                }
            }
            if let name = savingName {
                HStack(spacing: 6) {
                    TextField("저장할 이름", text: Binding(get: { name }, set: { savingName = $0 }))
                        .textFieldStyle(.roundedBorder).onSubmit(commitSave)
                    Button("저장", action: commitSave)
                        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("취소") { savingName = nil }
                }
                .controlSize(.small)
            } else if let saveNotice {
                Text(saveNotice).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack(alignment: .bottom, spacing: 8) {
                InputTextView(text: $agent.input, focusTick: vm.focusTick, onSubmit: { agent.send() })
                    .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(alignment: .topLeading) {
                        if agent.input.isEmpty {
                            Text(inputBlocked ? "루틴이 도는 동안에는 일을 맡길 수 없어요" : "맡길 일을 입력하세요 (Return 보내기 · Option+Return 줄바꿈)")
                                .font(.system(size: 13)).foregroundStyle(.tertiary)
                                .padding(.horizontal, InputTextView.insetX + InputTextView.linePadding)
                                .padding(.vertical, InputTextView.insetY)
                                .allowsHitTesting(false)
                        }
                    }
                    .disabled(inputBlocked)
                    .opacity(inputBlocked ? 0.5 : 1)
                Button("저장") { startSave() }
                    .controlSize(.small)
                    .disabled(inputBlocked || agent.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .help("지금 입력한 글을 이름 붙여 저장해요(보내지는 않아요)")
                if inputBlocked {
                    EmptyView()
                } else if agent.isStopping {
                    HStack(spacing: 4) { ProgressView().controlSize(.small); Text("멈추는 중…").font(.caption) }
                        .foregroundStyle(.secondary)
                } else if agent.isRunning {
                    Button(action: agent.stop) { Image(systemName: "stop.circle.fill").font(.title2) }
                        .buttonStyle(.borderless).help("멈춤")
                } else {
                    Button { agent.send() } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                        .buttonStyle(.borderless).help("보내기 (Return)")
                        .disabled(agent.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func startSave() {
        let text = agent.input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        savingName = String(text.split(whereSeparator: \.isNewline).first?.prefix(20) ?? "")
        saveNotice = nil
    }

    private func commitSave() {
        guard let name = savingName else { return }
        do {
            let saved = try hub.saveTask(SavedTask(name: name, text: agent.input))
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

    var body: some View {
        switch message.role {
        case .user: userBubble
        case .assistant: assistantBubble
        }
    }

    private var userBubble: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if let title = message.pageTitle {
                Label(title, systemImage: "doc.text").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Text(message.text)
                .textSelection(.enabled)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(Color.accentColor.opacity(0.18), in: RoundedRectangle(cornerRadius: 10))
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var assistantBubble: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let m = message.model { Text(m.pickerLabel).font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
            if let notice = message.notice { Text(notice).font(.caption).foregroundStyle(.secondary) }
            if !message.text.isEmpty { MarkdownView(text: message.text) }
            if message.isStreaming {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(activity ?? (message.text.isEmpty ? "생각하는 중이에요…" : "")).font(.caption).foregroundStyle(.secondary)
                }
            }
            if let status = message.status { Text(status).font(.caption).foregroundStyle(.secondary) }
            if let error = message.error {
                Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// 답 글 그리기 — 문단 · 제목 · 목록 · 코드 상자. 줄 안 서식은 `AttributedString(markdown:)`.
struct MarkdownView: View {
    let text: String
    /// false 면 링크를 누를 수 없게(글로만) 보인다 — 계획 카드.
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
                case .heading(let level, let t):
                    Text(inline(t)).font(level <= 1 ? .title3.bold() : .headline)
                case .listItem(let marker, let t):
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(marker).foregroundStyle(.secondary)
                        Text(inline(t))
                    }
                case .code(_, let t):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(t).font(.system(.callout, design: .monospaced)).fixedSize(horizontal: true, vertical: false)
                    }
                    .padding(8)
                    .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 6))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }
}
