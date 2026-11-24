import AppCore
import SwiftUI

/// 루틴 하나를 고치는 중인 값(아직 저장 전).
private struct RoutineDraft: Equatable {
    enum Kind: String, CaseIterable { case daily, weekdays, everyHours }

    var id: UUID?                  // nil 이면 새 루틴
    var taskID: UUID?
    var kind: Kind = .daily
    var hour = 9
    var minute = 0
    var weekdays: Set<Int> = [2, 3, 4, 5, 6]   // 월~금
    var hours = 6
    var sites: [String] = []
    var sitesEdited = false        // 사람이 목록을 손대면 일을 바꿔도 다시 뽑지 않는다
    var enabled = true

    var schedule: RoutineSchedule {
        switch kind {
        case .daily: return .daily(hour: hour, minute: minute)
        case .weekdays: return .weekdays(weekdays, hour: hour, minute: minute)
        case .everyHours: return .everyHours(hours)
        }
    }

    init(taskID: UUID?, taskText: String?) {
        self.taskID = taskID
        if let taskText { sites = SiteList.extractHosts(from: taskText) }
    }

    init(_ r: Routine) {
        id = r.id
        taskID = r.taskID
        sites = r.sites
        sitesEdited = true
        enabled = r.enabled
        switch r.schedule {
        case let .daily(h, m): kind = .daily; hour = h; minute = m
        case let .weekdays(d, h, m): kind = .weekdays; weekdays = d; hour = h; minute = m
        case let .everyHours(n): kind = .everyHours; hours = n
        }
    }
}

/// 「루틴」 — 저장한 일을 정해진 시각에 사람 없이 돌린다. 루틴 목록(다음 시각 · 켜기/끄기 · 지금 한 번 · 고치기 · 지우기) · 기록 · 「끝나면 알림」.
struct RoutinesView: View {
    let hub: RoutineHub
    let agent: AgentSession
    /// 「저장한 일」 → 「루틴으로」 로 들어왔을 때 새 루틴을 시작할 일.
    let startWithTaskID: UUID?
    var onClose: () -> Void

    @State private var draft: RoutineDraft?
    @State private var confirmDeleteID: UUID?
    @State private var runningNowID: UUID?
    @State private var error: String?
    @State private var newSite = ""
    @State private var siteError: String?
    @State private var expandedRecords: Set<Int> = []

    var body: some View {
        let _ = hub.revision
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(draft == nil ? "루틴" : (draft?.id == nil ? "새 루틴" : "루틴 고치기")).font(.subheadline.weight(.semibold))
                Spacer()
                Button(draft == nil ? "돌아가기" : "취소") { if draft == nil { onClose() } else { draft = nil; error = nil } }
                    .controlSize(.small)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if draft != nil { editor } else { list }
                }
                .padding(12)
            }
        }
        .onAppear {
            if draft == nil, let id = startWithTaskID, let task = hub.store.savedTask(id: id) {
                draft = RoutineDraft(taskID: id, taskText: task.text)
            }
        }
    }

    // MARK: 목록

    private var list: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text("저장한 일을 정해진 시각에 사람 없이 돌려요. 앱이 켜져 있을 때만 돌고, 사파리가 이미 켜져 있고 사파리 제어 허락이 이미 있을 때만 돌아요(없으면 묻지 않고 건너뛰어요).")
                Text("루틴은 읽기만 하도록 막아 둬요 — 누르기 · 입력은 거절하고, 「갈 수 있는 사이트」 밖으로도 가지 않게 해요. 다만 실수와 보통의 속임을 막는 장치예요. 속임 글에 넘어간 클로드가 일부러 빠져나가면 못 막으니, 로그인해 둔 중요한 사이트(메일 · 은행 등)는 목록에 넣지 않는 것을 권해요.")
            }
            .font(.caption).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)

            Toggle("끝나면 알림 (끝남 · 일부만 됨 · 실패)", isOn: Binding(
                get: { hub.notifyEnabled },
                set: { on in Task { await hub.setNotify(on) } }))
                .toggleStyle(.checkbox).controlSize(.small)
            if let problem = hub.notifyProblem {
                Text(problem).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Text("루틴").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                Button { draft = RoutineDraft(taskID: hub.store.savedTasks.first?.id, taskText: hub.store.savedTasks.first?.text) } label: {
                    Label("새 루틴", systemImage: "plus")
                }
                .controlSize(.small)
                .disabled(hub.store.savedTasks.isEmpty)
            }
            if hub.store.savedTasks.isEmpty {
                Text("먼저 일 맡기기 입력 칸의 「저장」 으로 일을 저장해 주세요.").font(.callout).foregroundStyle(.secondary)
            } else if hub.store.routines.isEmpty {
                Text("루틴이 없어요").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(hub.store.routines) { r in
                routineRow(r)
                Divider()
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }

            Text("기록").font(.caption.weight(.semibold)).foregroundStyle(.secondary).padding(.top, 4)
            let records = hub.store.history(limit: 30)
            if records.isEmpty { Text("아직 기록이 없어요").font(.callout).foregroundStyle(.secondary) }
            ForEach(Array(records.enumerated()), id: \.offset) { index, record in recordRow(index, record) }
        }
    }

    private func routineRow(_ r: Routine) -> some View {
        let name = hub.store.savedTask(id: r.taskID)?.name ?? "(지운 일)"
        let active = hub.scheduler.activeRoutineID == r.id
        let waiting = hub.scheduler.waitingRoutineID == r.id
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(name).font(.callout.weight(.semibold)).lineLimit(1)
                Spacer()
                Toggle("", isOn: Binding(get: { r.enabled }, set: { setEnabled(r, $0) }))
                    .labelsHidden().toggleStyle(.switch).controlSize(.mini)
                    .help(r.enabled ? "끄기" : "켜기")
            }
            Text(r.schedule.summary).font(.caption)
            Text(nextText(r)).font(.caption).foregroundStyle(.secondary)
            Text(r.sites.isEmpty ? "갈 수 있는 사이트: 없음 — 이 루틴은 돌 때마다 건너뛰어요" : "갈 수 있는 사이트: " + r.sites.joined(separator: ", "))
                .font(.caption).foregroundStyle(r.sites.isEmpty ? Color.orange : Color.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if active {
                HStack(spacing: 6) { ProgressView().controlSize(.small); Text("도는 중이에요…").font(.caption) }
            } else if waiting {
                Label("다른 일이 끝나기를 기다리는 중이에요", systemImage: "hourglass").font(.caption).foregroundStyle(.orange)
            }
            if confirmDeleteID == r.id {
                VStack(alignment: .leading, spacing: 4) {
                    Text("이 루틴을 지울까요? (저장한 일과 기록은 남아요)").font(.caption).foregroundStyle(.orange)
                    HStack {
                        Button("지우기", role: .destructive) { deleteRoutine(r) }
                        Button("취소") { confirmDeleteID = nil }
                    }
                    .controlSize(.small)
                }
            } else {
                HStack(spacing: 8) {
                    Button("지금 한 번") { runNow(r) }
                        .disabled(agent.isRunning || runningNowID != nil || hub.scheduler.activeRoutineID != nil)
                        .help(agent.isRunning ? "다른 일이 도는 중에는 돌릴 수 없어요" : "일정과 상관없이 지금 한 번 돌려요(읽기만 · 같은 확인을 거쳐요)")
                    Button("고치기") { draft = RoutineDraft(r); error = nil }
                    Button("지우기") { confirmDeleteID = r.id }
                }
                .controlSize(.small)
            }
        }
    }

    private func recordRow(_ index: Int, _ record: RoutineRecord) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(record.name).font(.caption.weight(.semibold)).lineLimit(1)
                Text(record.status).font(.caption).foregroundStyle(Self.statusColor(record.status))
                Spacer()
                Text(Self.timeText(record.at)).font(.caption2).foregroundStyle(.secondary)
            }
            if !record.answer.isEmpty {
                if expandedRecords.contains(index) {
                    Text(record.answer).font(.caption).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Button("접기") { expandedRecords.remove(index) }.buttonStyle(.link).controlSize(.small)
                } else {
                    Text(record.answer).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    Button("펼치기") { expandedRecords.insert(index) }.buttonStyle(.link).controlSize(.small)
                }
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: 편집

    private var editor: some View {
        let tasks = hub.store.savedTasks
        return VStack(alignment: .leading, spacing: 10) {
            if tasks.isEmpty {
                Text("저장한 일이 없어요. 먼저 일을 저장해 주세요.").font(.callout).foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text("돌릴 일").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Picker("", selection: Binding(get: { draft?.taskID }, set: { setTask($0) })) {
                        ForEach(tasks) { Text($0.name).tag(Optional($0.id)) }
                    }
                    .labelsHidden()
                    if let id = draft?.taskID, let t = hub.store.savedTask(id: id) {
                        Text(t.text).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                    }
                }
                scheduleEditor
                sitesEditor
                Toggle("켜 두기", isOn: Binding(get: { draft?.enabled ?? true }, set: { draft?.enabled = $0 }))
                    .toggleStyle(.checkbox).controlSize(.small)
                if let error { Text(error).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
                HStack {
                    Button("저장", action: saveDraft).disabled(!canSave)
                    Button("취소") { draft = nil; error = nil }
                }
                .controlSize(.small)
            }
        }
    }

    private var scheduleEditor: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("언제").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Picker("", selection: Binding(get: { draft?.kind ?? .daily }, set: { draft?.kind = $0 })) {
                Text("매일").tag(RoutineDraft.Kind.daily)
                Text("요일").tag(RoutineDraft.Kind.weekdays)
                Text("N시간마다").tag(RoutineDraft.Kind.everyHours)
            }
            .pickerStyle(.segmented).labelsHidden()
            if draft?.kind == .weekdays {
                HStack(spacing: 4) {
                    ForEach([2, 3, 4, 5, 6, 7, 1], id: \.self) { day in
                        let on = draft?.weekdays.contains(day) ?? false
                        Button(Self.dayName(day)) {
                            if on { draft?.weekdays.remove(day) } else { draft?.weekdays.insert(day) }
                        }
                        .buttonStyle(.bordered).controlSize(.small)
                        .tint(on ? .accentColor : .secondary)
                    }
                }
            }
            if draft?.kind == .everyHours {
                Stepper(value: Binding(get: { draft?.hours ?? 6 }, set: { draft?.hours = min(24, max(1, $0)) }), in: 1...24) {
                    Text("\(draft?.hours ?? 6)시간마다").font(.callout)
                }
                .controlSize(.small)
                Text("만든 시각 · 켠 시각부터 셉니다.").font(.caption).foregroundStyle(.secondary)
            } else {
                HStack(spacing: 4) {
                    Picker("", selection: Binding(get: { draft?.hour ?? 9 }, set: { draft?.hour = $0 })) {
                        ForEach(0..<24, id: \.self) { Text(String(format: "%02d시", $0)).tag($0) }
                    }
                    .labelsHidden().fixedSize()
                    Picker("", selection: Binding(get: { draft?.minute ?? 0 }, set: { draft?.minute = $0 })) {
                        ForEach(0..<60, id: \.self) { Text(String(format: "%02d분", $0)).tag($0) }
                    }
                    .labelsHidden().fixedSize()
                }
            }
            if draft?.kind == .weekdays, draft?.weekdays.isEmpty ?? true {
                Text("요일을 하나 이상 골라 주세요.").font(.caption).foregroundStyle(.orange)
            }
        }
    }

    private var sitesEditor: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("갈 수 있는 사이트").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                if let id = draft?.taskID, let t = hub.store.savedTask(id: id) {
                    Button("글에서 다시 뽑기") {
                        draft?.sites = SiteList.extractHosts(from: t.text)
                        draft?.sitesEdited = false
                        siteError = nil
                    }
                    .buttonStyle(.link).controlSize(.small)
                }
            }
            Text("저장한 일 글에서 자동으로 뽑았어요. 맞는지 확인하고 고쳐 주세요. 목록의 coupang.com 은 www.coupang.com 같은 아래 주소도 허락해요. 이 밖의 사이트는 가지 않도록 막아 둬요(실수와 보통의 속임을 막는 장치예요). 로그인해 둔 중요한 사이트(메일 · 은행 등)는 넣지 않는 것을 권해요.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if draft?.sites.isEmpty ?? true {
                Label("사이트가 없으면 이 루틴은 클로드를 부르지 않고 돌 때마다 건너뛰어요", systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(draft?.sites ?? [], id: \.self) { site in
                HStack {
                    Text(site).font(.callout).lineLimit(1).truncationMode(.middle)
                    Spacer()
                    Button { draft?.sites.removeAll { $0 == site }; draft?.sitesEdited = true } label: { Image(systemName: "trash") }
                        .buttonStyle(.borderless).help("목록에서 빼기")
                }
            }
            HStack(spacing: 6) {
                TextField("사이트 주소 (예: coupang.com)", text: $newSite).textFieldStyle(.roundedBorder).onSubmit(addSite)
                Button("추가", action: addSite).disabled(newSite.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .controlSize(.small)
            if let siteError { Text(siteError).font(.caption).foregroundStyle(.red) }
        }
    }

    // MARK: 동작

    private var canSave: Bool {
        guard let d = draft, d.taskID != nil else { return false }
        if d.kind == .weekdays, d.weekdays.isEmpty { return false }
        return true
    }

    private func setTask(_ id: UUID?) {
        guard draft != nil else { return }
        draft?.taskID = id
        if draft?.id == nil, draft?.sitesEdited == false, let id, let t = hub.store.savedTask(id: id) {
            draft?.sites = SiteList.extractHosts(from: t.text)   // 새 루틴에서 일을 바꾸면(목록을 손대지 않았을 때) 사이트를 다시 뽑는다
        }
    }

    private func addSite() {
        guard let host = SiteList.entry(fromUserInput: newSite) else {
            siteError = "사이트 주소를 알아보지 못했어요 (예: coupang.com). co.kr 같은 끝 주소만으로는 추가할 수 없어요"
            return
        }
        if !(draft?.sites.contains(host) ?? true) { draft?.sites.append(host) }
        draft?.sitesEdited = true
        newSite = ""
        siteError = nil
    }

    private func saveDraft() {
        guard let d = draft, let taskID = d.taskID else { return }
        let existing = d.id.flatMap { hub.store.routine(id: $0) }
        let routine = Routine(id: d.id ?? UUID(), taskID: taskID, schedule: d.schedule, sites: d.sites, enabled: d.enabled,
                              lastRun: existing?.lastRun, lastHandled: existing?.lastHandled, createdAt: existing?.createdAt ?? Date())
        do {
            try hub.saveRoutine(routine)
            draft = nil
            error = nil
            siteError = nil
            newSite = ""
        } catch {
            self.error = "저장하지 못했어요 — \(error.localizedDescription)"
        }
    }

    private func setEnabled(_ r: Routine, _ on: Bool) {
        do { try hub.setEnabled(on, routineID: r.id); error = nil }
        catch { self.error = "바꾸지 못했어요 — \(error.localizedDescription)" }
    }

    private func deleteRoutine(_ r: Routine) {
        do { try hub.deleteRoutine(id: r.id); confirmDeleteID = nil; error = nil }
        catch { self.error = "지우지 못했어요 — \(error.localizedDescription)" }
    }

    private func runNow(_ r: Routine) {
        runningNowID = r.id
        Task {
            await hub.runNow(routineID: r.id)
            runningNowID = nil
        }
    }

    // MARK: 글

    private func nextText(_ r: Routine) -> String {
        guard r.enabled else { return "꺼져 있어요" }
        let next = r.nextOccurrence(after: Date(), calendar: .current)
        guard next != .distantFuture else { return "다음 시각 없음" }
        return "다음: " + Self.timeText(next)
    }

    private static func dayName(_ day: Int) -> String { ["일", "월", "화", "수", "목", "금", "토"][day - 1] }

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "ko_KR")
        f.dateFormat = "M월 d일 (E) HH:mm"
        return f
    }()

    private static func timeText(_ date: Date) -> String { timeFormatter.string(from: date) }

    private static func statusColor(_ status: String) -> Color {
        switch status {
        case RoutineRecord.statusDone: return .green
        case RoutineRecord.statusPartial: return .orange
        case RoutineRecord.statusFailed: return .red
        default: return .secondary
        }
    }
}
