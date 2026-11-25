import AppCore
import SwiftUI

/// 「저장한 일」 — 입력 칸에 쓴 글에 이름을 붙여 둔 것. 다시 부르기 · 고치기 · 지우기 · 「루틴으로」.
/// 허락 창 · 확인 창을 쓰지 않고 목록 안에서 바로 묻는다(옆 창은 테두리 없는 창이라 시트가 어색하다).
struct SavedTasksView: View {
    let hub: RoutineHub
    let isBusy: Bool
    var onClose: () -> Void
    /// 「불러오기」 — 입력 칸에 글을 넣고 이 화면을 닫는다.
    var onLoad: (SavedTask) -> Void
    /// 「루틴으로」 — 루틴 화면을 열고 이 일로 새 루틴을 시작한다.
    var onMakeRoutine: (SavedTask) -> Void

    @State private var editingID: UUID?
    @State private var editName = ""
    @State private var editText = ""
    @State private var confirmDeleteID: UUID?
    @State private var error: String?

    var body: some View {
        let _ = hub.revision
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("저장한 일").font(.subheadline.weight(.semibold))
                Spacer()
                Button("돌아가기", action: onClose).controlSize(.small)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    Text("자주 맡기는 일을 이름 붙여 저장해 두고 다시 불러요. 불러와도 바로 시작하지 않고 입력 칸에 글만 들어가요.")
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if hub.store.savedTasks.isEmpty {
                        Text("저장한 일이 없어요. 입력 칸에 글을 쓰고 「저장」 을 눌러 보세요.")
                            .font(.callout).foregroundStyle(.secondary).padding(.top, 4)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    ForEach(hub.store.savedTasks) { task in
                        row(task)
                        Divider()
                    }
                    if let error {
                        Text(error).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(12)
            }
        }
    }

    @ViewBuilder
    private func row(_ task: SavedTask) -> some View {
        let count = hub.routineCount(forTask: task.id)
        if editingID == task.id {
            VStack(alignment: .leading, spacing: 6) {
                TextField("이름", text: $editName).textFieldStyle(.roundedBorder)
                TextEditor(text: $editText)
                    .font(.system(size: 13))
                    .frame(minHeight: 70, maxHeight: 140)
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.primary.opacity(0.2)))
                HStack {
                    Button("저장") { saveEdit(task) }
                        .disabled(editName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                  || editText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("취소") { editingID = nil }
                }
                .controlSize(.small)
            }
        } else {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(task.name).font(.callout.weight(.semibold)).lineLimit(1)
                    if count > 0 {
                        Text("루틴 \(count)개").font(.caption2).foregroundStyle(.secondary)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.primary.opacity(0.08), in: Capsule())
                    }
                }
                Text(task.text).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                if confirmDeleteID == task.id {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(count > 0 ? "「\(task.name)」 을 지우면 이 일의 루틴 \(count)개도 함께 지워져요. 지울까요?" : "「\(task.name)」 을 지울까요?")
                            .font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                        HStack {
                            Button("지우기", role: .destructive) { delete(task) }
                            Button("취소") { confirmDeleteID = nil }
                        }
                        .controlSize(.small)
                    }
                } else {
                    FlowLayout(spacing: 6, lineSpacing: 6) {
                        Button("불러오기") { onLoad(task) }
                            .disabled(isBusy)
                            .help(isBusy ? "답하는 중에는 입력 칸을 바꿀 수 없어요" : "입력 칸에 이 글을 넣어요")
                        Button("루틴으로") { onMakeRoutine(task) }
                        Button("고치기") { startEdit(task) }
                        Button("지우기") { confirmDeleteID = task.id }
                    }
                    .controlSize(.small)
                }
            }
        }
    }

    private func startEdit(_ task: SavedTask) {
        editName = task.name
        editText = task.text
        editingID = task.id
        confirmDeleteID = nil
        error = nil
    }

    private func saveEdit(_ task: SavedTask) {
        do {
            try hub.saveTask(SavedTask(id: task.id, name: editName, text: editText))
            editingID = nil
            error = nil
        } catch {
            self.error = "저장하지 못했어요 — \(error.localizedDescription)"
        }
    }

    private func delete(_ task: SavedTask) {
        do {
            try hub.deleteTask(id: task.id)
            confirmDeleteID = nil
            error = nil
        } catch {
            self.error = "지우지 못했어요 — \(error.localizedDescription)"
        }
    }
}
