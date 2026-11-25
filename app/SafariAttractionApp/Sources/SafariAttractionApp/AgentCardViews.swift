import AppCore
import SwiftUI

/// 좁은 폭(280pt)에서도 단추 글자가 잘리지 않게 자연스럽게 다음 줄로 감싸는 배치.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .greatestFiniteMagnitude
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var usedWidth: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
            if x > 0 && x + size.width > maxWidth {
                x = 0
                y += rowHeight + lineSpacing
                rowHeight = 0
            }
            x += size.width + spacing
            usedWidth = max(usedWidth, x - spacing)
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: proposal.width ?? usedWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            if x > bounds.minX && x + size.width > bounds.maxX + 0.5 {
                x = bounds.minX
                y += rowHeight + lineSpacing
                rowHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

/// 옆 창 대화에 뜨는 허락 카드 — 주황(동작) · 빨강(위험 · 코드 실행).
struct ChatCardView: View {
    let card: AgentMessageContent
    let onAnswer: (AgentAnswer) -> Void

    var body: some View {
        switch card {
        case .actionCard(let host, let action, let target, let value, let danger, let state):
            ActionCardView(host: host, action: action, target: target, value: value,
                           danger: danger, state: state, onAnswer: onAnswer)
        case .codeCard(let code, let state):
            CodeCardView(code: code, state: state, onAnswer: onAnswer)
        default:
            EmptyView()
        }
    }
}

/// 카드 겉틀 — 12pt continuous 모서리 · 옅은 색 바탕 · 같은 색 테두리. 빨간 카드는 왼쪽 강조 띠.
private struct CardFrame<Content: View, Buttons: View>: View {
    let color: Color
    let title: String
    let titleSymbol: String
    var stripe = false
    let state: AgentCardState
    let resultText: String
    @ViewBuilder var content: Content
    @ViewBuilder var buttons: Buttons

    private let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: titleSymbol)
                .font(.caption.weight(.semibold))
                .foregroundStyle(color)
                .fixedSize(horizontal: false, vertical: true)
            content
            if state.isPending {
                buttons
            } else {
                Text(resultText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .padding(.leading, stripe ? 4 : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(state.isPending ? 0.10 : 0.05), in: shape)
        .overlay(alignment: .leading) {
            if stripe {
                UnevenRoundedRectangle(topLeadingRadius: 12, bottomLeadingRadius: 12, style: .continuous)
                    .fill(color)
                    .frame(width: 5)
            }
        }
        .overlay(shape.strokeBorder(color.opacity(state.isPending ? 0.65 : 0.30), lineWidth: 1))
        .opacity(state.isPending ? 1 : 0.85)
    }
}

/// 채운 알약 [허락] · 빈 알약 [거절] / [이 사이트 늘 허락] 단추.
private struct CardPillButton: View {
    let title: String
    let color: Color
    var filled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.caption.weight(filled ? .semibold : .medium))
                .foregroundStyle(filled ? Color.white : Color.primary)
                .padding(.horizontal, 12)
                .padding(.vertical, 5)
                .background(filled ? color : Color.clear, in: Capsule())
                .overlay(Capsule().strokeBorder(filled ? Color.clear : Color.primary.opacity(0.22), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

/// 답한 카드에 남기는 한 줄.
private func cardResultText(_ state: AgentCardState) -> String {
    switch state {
    case .pending: return ""
    case .approved: return "허락함"
    case .alwaysAllowed: return "허락함 · 이 사이트는 앞으로 늘 허락"
    case .rejected: return "거절함"
    case .revised(let t): return "고쳐 달라고 했어요 — \(t)"
    case .expired: return "시간이 지나 거절했어요"
    case .stopped: return "멈춰서 거절했어요"
    case .withdrawn: return "AI가 물음을 거두었어요"
    }
}

// MARK: - 동작(주황) · 위험(빨강)

private struct ActionCardView: View {
    let host: String
    let action: String
    let target: String
    let value: String
    let danger: Bool
    let state: AgentCardState
    let onAnswer: (AgentAnswer) -> Void

    private var accent: Color { danger ? .red : .orange }

    private var dangerLabel: String {
        action == "evaluate" ? "알 수 없는 페이지 코드" : "되돌릴 수 없어 보이는 일"
    }

    var body: some View {
        CardFrame(color: accent,
                  title: danger ? dangerLabel : "사이트에서 할 일 — 허락할까요?",
                  titleSymbol: danger ? "exclamationmark.triangle.fill" : "hand.raised",
                  stripe: danger, state: state, resultText: cardResultText(state)) {
            VStack(alignment: .leading, spacing: 4) {
                row("사이트", host)
                row("동작", AgentActionLabel.noun(action))
                if !target.isEmpty { row("대상", target) }
                if !value.isEmpty { row("값", value) }
            }
        } buttons: {
            FlowLayout(spacing: 6, lineSpacing: 6) {
                CardPillButton(title: "허락", color: accent, filled: true) { onAnswer(.approve) }
                CardPillButton(title: "거절", color: accent, filled: false) { onAnswer(.reject) }
                if !danger {
                    CardPillButton(title: "이 사이트 늘 허락", color: accent, filled: false) { onAnswer(.alwaysAllowSite) }
                        .help("이 사이트를 「다 허락」 으로 저장해요. 다 허락이면 코드 실행(evaluate)도 묻지 않아요 — 결제 · 삭제처럼 되돌릴 수 없어 보이는 낱말이 있으면 물어요.")
                }
            }
        }
    }

    private func row(_ label: String, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(label).font(.caption).foregroundStyle(.secondary).frame(width: 40, alignment: .leading)
            Text(text).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - 코드(빨강)

private struct CodeCardView: View {
    let code: String
    let state: AgentCardState
    let onAnswer: (AgentAnswer) -> Void

    var body: some View {
        CardFrame(color: .red, title: "이 코드를 실행해도 될까요?", titleSymbol: "exclamationmark.triangle.fill",
                  stripe: true, state: state, resultText: cardResultText(state)) {
            VStack(alignment: .leading, spacing: 6) {
                Text("AI가 짠 코드에 주의할 낱말이 들어 있어요. 내용을 읽고 정해 주세요.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                ScrollView([.vertical, .horizontal]) {
                    Text(code)
                        .font(.system(.callout, design: .monospaced))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 180)
                .padding(8)
                .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
        } buttons: {
            FlowLayout(spacing: 6, lineSpacing: 6) {
                CardPillButton(title: "허락", color: .red, filled: true) { onAnswer(.approve) }
                CardPillButton(title: "거절", color: .red, filled: false) { onAnswer(.reject) }
            }
        }
    }
}
