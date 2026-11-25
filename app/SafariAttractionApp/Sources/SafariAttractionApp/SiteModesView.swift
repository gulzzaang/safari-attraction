import AppCore
import SwiftUI

extension SiteMode {
    /// 고르는 칸에 보이는 이름.
    var pickerLabel: String {
        switch self {
        case .readOnly: return "읽기만"
        case .ask: return "묻고 하기"
        case .allowAll: return "다 허락"
        }
    }
}

/// 「사이트 허락」 — 사이트(호스트)마다 AI가 어디까지 하게 할지 고른다. 저장한 적 없는 사이트는 「묻고 하기」.
struct SiteModesView: View {
    let store: SiteModeStore
    var onClose: () -> Void

    @State private var entries: [(host: String, mode: SiteMode)] = []
    @State private var newHost = ""
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("사이트 허락").font(.subheadline.weight(.semibold))
                Spacer()
                Button("돌아가기", action: onClose).controlSize(.small)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("저장하지 않은 사이트는 「묻고 하기」예요. 되돌릴 수 없어 보이는 일(결제 · 삭제 · 보내기 등)은 「다 허락」이어도 늘 물어요.")
                        Text("다 허락이면 코드 실행(evaluate)도 묻지 않아요 — 결제 · 삭제처럼 되돌릴 수 없어 보이는 낱말이 있으면 물어요.")
                        Text("사이트는 주소가 똑같아야 해요 — coupang.com 과 www.coupang.com 은 서로 다른 사이트예요.")
                    }
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    if entries.isEmpty {
                        Text("저장한 사이트가 없어요").font(.callout).foregroundStyle(.secondary).padding(.top, 4)
                    }
                    ForEach(entries, id: \.host) { entry in
                        HStack(spacing: 8) {
                            Text(entry.host).font(.callout).lineLimit(1).truncationMode(.middle)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Picker("", selection: Binding(get: { entry.mode }, set: { set(entry.host, $0) })) {
                                ForEach(SiteMode.allCases, id: \.self) { Text($0.pickerLabel).tag($0) }
                            }
                            .labelsHidden().fixedSize()
                            Button { remove(entry.host) } label: { Image(systemName: "trash") }
                                .buttonStyle(.borderless).help("지우기 — 다시 「묻고 하기」")
                        }
                    }
                    Divider()
                    HStack(spacing: 6) {
                        TextField("사이트 주소 (예: www.coupang.com)", text: $newHost)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit(add)
                        Button("추가", action: add)
                            .disabled(Self.hostName(from: newHost) == nil)
                    }
                    .controlSize(.small)
                    if let error {
                        Text(error).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(12)
            }
        }
        .onAppear(perform: reload)
    }

    private func reload() {
        entries = store.all.map { (host: $0.key, mode: $0.value) }.sorted { $0.host < $1.host }
    }

    private func set(_ host: String, _ mode: SiteMode) {
        do { try store.setMode(mode, for: host); error = nil }
        catch { self.error = "저장하지 못했어요 — \(error.localizedDescription)" }
        reload()
    }

    private func remove(_ host: String) {
        do { try store.removeMode(for: host); error = nil }
        catch { self.error = "지우지 못했어요 — \(error.localizedDescription)" }
        reload()
    }

    private func add() {
        guard let host = Self.hostName(from: newHost) else { return }
        guard store.all[host] == nil else { newHost = ""; return }
        set(host, .ask)
        newHost = ""
    }

    /// 입력 글에서 사이트 이름만 — 주소 전체를 붙여 넣어도 되고, 빈 글 · 공백이 든 글은 nil.
    static func hostName(from text: String) -> String? {
        var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.contains("://"), let h = URL(string: t)?.host { t = h }
        t = t.lowercased()
        if let slash = t.firstIndex(of: "/") { t = String(t[..<slash]) }
        guard !t.isEmpty, !t.contains(where: { $0.isWhitespace }) else { return nil }
        return t
    }
}
