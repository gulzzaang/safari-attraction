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

struct ChatView: View {
    @Bindable var vm: ChatViewModel
    var onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            messageList
            Divider()
            composer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.primary.opacity(0.15)))
        .onExitCommand(perform: onClose)
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
                Button("새 대화") { vm.newChat() }
                    .controlSize(.small)
                    .disabled(vm.messages.isEmpty && !vm.isRunning)
                Button(action: onClose) { Image(systemName: "xmark") }
                    .buttonStyle(.borderless)
                    .help("닫기 (\(HotKey.toggleLabel))")
            }
            Picker("모델", selection: $vm.model) {
                ForEach(ModelKind.allCases, id: \.self) { Text($0.pickerLabel).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .disabled(vm.isRunning)
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
                            Text("모델을 고르고 질문을 입력하면 답이 흘러나와요. 「이 페이지 함께」를 켜면 지금 보는 사파리 탭의 제목 · 주소 · 고른 글을 같이 보내요.")
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
        .padding(12)
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
private struct MarkdownView: View {
    let text: String

    var body: some View {
        let blocks = MarkdownBlocks.parse(text)
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let t):
                    Text(MarkdownBlocks.attributed(t))
                case .heading(let level, let t):
                    Text(MarkdownBlocks.attributed(t)).font(level <= 1 ? .title3.bold() : .headline)
                case .listItem(let marker, let t):
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(marker).foregroundStyle(.secondary)
                        Text(MarkdownBlocks.attributed(t))
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
