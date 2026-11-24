import AppCore
import SwiftUI

/// 일 맡기기 대화의 한 칸 — 사람 글 · 클로드 글 · 안내 · 오류 · 카드 셋.
struct AgentMessageView: View {
    let message: AgentMessage
    let agent: AgentSession

    var body: some View {
        switch message.content {
        case .user(let text):
            Text(text)
                .textSelection(.enabled)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(Color.accentColor.opacity(0.18), in: RoundedRectangle(cornerRadius: 10))
                .frame(maxWidth: .infinity, alignment: .trailing)
        case .assistant(let text):
            MarkdownView(text: text)
        case .notice(let text):
            Text(text).font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .error(let text):
            Text(text).font(.callout).foregroundStyle(.red).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .planCard(let markdown, let state):
            PlanCardView(id: message.id, markdown: markdown, state: state, agent: agent)
        case .actionCard(let host, let action, let target, let value, let danger, let state):
            ActionCardView(id: message.id, host: host, action: action, target: target, value: value,
                           danger: danger, state: state, agent: agent)
        case .codeCard(let code, let state):
            CodeCardView(id: message.id, code: code, state: state, agent: agent)
        }
    }
}

/// 카드 겉틀 — 색 테두리 · 제목 줄 · (답한 뒤) 결과 줄. 빨간 카드는 왼쪽에 굵은 빨간 줄.
private struct CardFrame<Content: View, Buttons: View>: View {
    let color: Color
    let title: String
    let titleSymbol: String
    var stripe = false
    let state: AgentCardState
    let resultText: String
    @ViewBuilder var content: Content
    @ViewBuilder var buttons: Buttons

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: titleSymbol)
                .font(.caption.weight(.semibold))
                .foregroundStyle(color)
            content
            if state.isPending {
                buttons
            } else {
                Text(resultText).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .padding(.leading, stripe ? 4 : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(state.isPending ? 0.08 : 0.04), in: RoundedRectangle(cornerRadius: 10))
        .overlay(alignment: .leading) {
            if stripe {
                UnevenRoundedRectangle(topLeadingRadius: 10, bottomLeadingRadius: 10)
                    .fill(color).frame(width: 5)
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(color.opacity(state.isPending ? 0.7 : 0.3), lineWidth: 1))
        .opacity(state.isPending ? 1 : 0.85)
    }
}

/// 답한 카드에 남기는 한 줄.
private func resultText(_ state: AgentCardState, isPlan: Bool = false) -> String {
    switch state {
    case .pending: return ""
    case .approved: return isPlan ? "이대로 진행하기로 했어요" : "허락함"
    case .alwaysAllowed: return "허락함 · 이 사이트는 앞으로 늘 허락"
    case .rejected: return isPlan ? "그만두었어요" : "거절함"
    case .revised(let t): return "고쳐 달라고 했어요 — \(t)"
    case .expired: return "시간이 지나 거절했어요"
    case .stopped: return "멈춰서 거절했어요"
    case .withdrawn: return "클로드가 물음을 거두었어요"
    }
}

// MARK: - 작업 목록(파란 테두리)

private struct PlanCardView: View {
    let id: Int
    let markdown: String
    let state: AgentCardState
    let agent: AgentSession
    @State private var revision = ""

    private var planIsBlank: Bool { markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        CardFrame(color: .blue, title: "작업 목록 — 이대로 진행할까요?", titleSymbol: "list.bullet.rectangle",
                  state: state, resultText: resultText(state, isPlan: true)) {
            if planIsBlank {
                Text("(계획 글이 비어 있어요 — 「고쳐 줘」로 계획을 목록으로 써 달라고 해 주세요)")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                MarkdownView(text: markdown, links: false)   // 링크는 누를 수 없게 — 허락 전에 읽는 글
            }
        } buttons: {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Button("이대로 진행") { agent.answer(cardID: id, .approve) }
                        .buttonStyle(.borderedProminent)
                        .disabled(planIsBlank)   // 보여 줄 계획이 없으면 승인할 수 없다
                    Button("그만") { agent.answer(cardID: id, .reject) }
                    Spacer(minLength: 0)
                }
                HStack(spacing: 6) {
                    TextField("고칠 점을 한 줄로", text: $revision)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(sendRevision)
                    Button("고쳐 줘", action: sendRevision)
                        .disabled(revision.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .controlSize(.small)
        }
    }

    private func sendRevision() {
        let t = revision.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        agent.answer(cardID: id, .revise(t))
    }
}

// MARK: - 동작(주황) · 위험(빨간 줄)

private struct ActionCardView: View {
    let id: Int
    let host: String
    let action: String
    let target: String
    let value: String
    let danger: Bool
    let state: AgentCardState
    let agent: AgentSession

    private var dangerLabel: String {
        action == "evaluate" ? "알 수 없는 페이지 코드" : "되돌릴 수 없어 보이는 일"
    }

    var body: some View {
        CardFrame(color: danger ? .red : .orange,
                  title: danger ? dangerLabel : "사이트에서 할 일 — 허락할까요?",
                  titleSymbol: danger ? "exclamationmark.triangle.fill" : "hand.raised",
                  stripe: danger, state: state, resultText: resultText(state)) {
            VStack(alignment: .leading, spacing: 4) {
                row("사이트", host)
                row("동작", AgentActionLabel.noun(action))
                if !target.isEmpty { row("대상", target) }
                if !value.isEmpty { row("값", value) }
            }
        } buttons: {
            HStack {
                Button("허락") { agent.answer(cardID: id, .approve) }
                    .buttonStyle(.borderedProminent)
                Button("거절") { agent.answer(cardID: id, .reject) }
                if !danger {   // 빨간 카드는 「늘 허락」 으로 묶지 않는다 — 그때그때 본다
                    Button("이 사이트 늘 허락") { agent.answer(cardID: id, .alwaysAllowSite) }
                        .help("이 사이트를 「다 허락」 으로 저장해요. 다 허락이면 코드 실행(evaluate)도 묻지 않아요 — 결제 · 삭제처럼 되돌릴 수 없어 보이는 낱말이 있으면 물어요.")
                }
                Spacer(minLength: 0)
            }
            .controlSize(.small)
        }
    }

    private func row(_ label: String, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(label).font(.caption).foregroundStyle(.secondary).frame(width: 40, alignment: .leading)
            Text(text).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - 코드(빨간)

private struct CodeCardView: View {
    let id: Int
    let code: String
    let state: AgentCardState
    let agent: AgentSession

    var body: some View {
        CardFrame(color: .red, title: "이 코드를 실행해도 될까요?", titleSymbol: "exclamationmark.triangle.fill",
                  stripe: true, state: state, resultText: resultText(state)) {
            VStack(alignment: .leading, spacing: 6) {
                Text("클로드가 짠 코드에 주의할 낱말이 들어 있어요. 내용을 읽고 정해 주세요.")
                    .font(.caption).foregroundStyle(.secondary)
                ScrollView([.vertical, .horizontal]) {
                    Text(code)
                        .font(.system(.callout, design: .monospaced))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 180)
                .padding(8)
                .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 6))
            }
        } buttons: {
            HStack {
                Button("허락") { agent.answer(cardID: id, .approve) }
                    .buttonStyle(.borderedProminent)
                Button("거절") { agent.answer(cardID: id, .reject) }
                Spacer(minLength: 0)
            }
            .controlSize(.small)
        }
    }
}
