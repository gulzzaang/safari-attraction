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

struct ChatView: View {
    @Bindable var vm: ChatViewModel
    @Bindable var agent: AgentSession
    let siteModes: SiteModeStore
    var onClose: () -> Void

    @State private var mode: ChatMode = .ask
    @State private var showingSites = false

    private var busy: Bool { vm.isRunning || agent.isRunning }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if mode == .agent && showingSites {
                SiteModesView(store: siteModes, onClose: { showingSites = false })
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
            if pending { showingSites = false }   // 허락을 기다리는 카드가 생기면 사이트 허락 화면을 닫아 카드를 보이게
        }
        .environment(\.openURL, OpenURLAction { url in
            if MarkdownBlocks.isOpenable(url) { openInSafari(url); return .handled }
            return .discarded
        })
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
                    if agent.isRunning, !agent.hasPendingCard {
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
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Button { showingSites = true } label: { Label("사이트 허락", systemImage: "checkmark.shield") }
                    .controlSize(.small)
                    .disabled(agent.isRunning || agent.hasPendingCard)   // 일하는 중 · 카드가 기다리는 중엔 가리지 않게 끈다
                    .help(agent.isRunning ? "일하는 중에는 고를 수 없어요" : "")
                Toggle("고정", isOn: Binding(get: { vm.pinned }, set: { vm.setPinned($0) }))
                    .toggleStyle(.checkbox).controlSize(.small)
                    .help("켜면 사파리가 앞이 아니어도 옆 창이 숨지 않아요")
                Spacer(minLength: 0)
            }
            HStack(alignment: .bottom, spacing: 8) {
                InputTextView(text: $agent.input, focusTick: vm.focusTick, onSubmit: { agent.send() })
                    .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(alignment: .topLeading) {
                        if agent.input.isEmpty {
                            Text("맡길 일을 입력하세요 (Return 보내기 · Option+Return 줄바꿈)")
                                .font(.system(size: 13)).foregroundStyle(.tertiary)
                                .padding(.horizontal, InputTextView.insetX + InputTextView.linePadding)
                                .padding(.vertical, InputTextView.insetY)
                                .allowsHitTesting(false)
                        }
                    }
                if agent.isStopping {
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
