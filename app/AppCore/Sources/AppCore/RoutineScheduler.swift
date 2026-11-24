import Foundation
import Observation

/// 루틴을 실제로 한 번 도는 쪽 — 앱에서는 `AgentSession`, 시험에서는 가짜.
@MainActor
public protocol RoutineRunning: AnyObject {
    /// 사람 일 맡기기든 다른 루틴이든 뭔가 돌고 있으면 true.
    var isBusy: Bool { get }
    func runRoutine(text: String, sites: [String]) async -> RoutineOutcome
}

extension AgentSession: RoutineRunning {
    public var isBusy: Bool { isRunning }
    public func runRoutine(text: String, sites: [String]) async -> RoutineOutcome {
        await runUnattended(text: text, sites: sites)
    }
}

/// 앱 안 시계 — 켜져 있는 루틴을 살펴 때가 되면 한 번에 하나씩 돌린다. launchd · 로그인 항목은 쓰지 않는다(앱이 꺼져 있으면 안 돈다).
///
/// - 일정 · 지나침 판단은 전부 `Routine.decide`(→ `RoutineSchedule.decide`) 한 곳. `.run` · `.skipMissed` 둘 다 끝나면 `lastHandled = 예정 시각` 으로 저장한다.
/// - `.skipMissed`(60분 넘게 지나침): 돌리지 않고 `건너뜀(지나침)` 기록만.
/// - `.run`: 돌기 전 확인 ① 사파리 떠 있음 ② 자동화 허락(허락 창 없이) → ③ 다른 일이 돌면 1800초까지 기다림(넘으면 건너뜀) → `runner` 로 한 번 돈다 → 기록.
///   기다린 뒤엔 ①②를 한 번 더 본다.
/// - 한 번에 하나: 한 점검(`checkNow`) 안에서 같이 때가 된 루틴은 차례로. 이미 점검 중이면 `checkNow` 는 바로 돌아온다(돌던 점검이 계속 이어 살핀다).
/// - 모든 시간은 주입한 `clock`, 기다림은 주입한 `sleep` — 시험은 진짜로 자지 않는다.
/// - 기록(`RoutineRecord`)은 건너뜀 · 실패 · 끝남 모두 `onFinished` 로 알린다(알림은 Task 5 가 이 콜백에 연결).
@MainActor @Observable
public final class RoutineScheduler {
    public static let busyWaitLimit: TimeInterval = 1800
    public static let busyPollInterval: TimeInterval = 5
    public static let tickInterval: TimeInterval = 30

    public static let busyWaitSkipReason = "다른 일이 길어져 건너뛰었어요"
    public static let missedSkipReason = "지나침"
    public static let missingTaskReason = "저장한 일을 찾을 수 없어요"

    /// 지금 루틴을 돌고 있으면 그 루틴(화면 표시용). 기다리는 중에는 비어 있다.
    public private(set) var activeRoutineID: UUID?
    /// 돌기 전 다른 일이 끝나기를 기다리는 루틴.
    public private(set) var waitingRoutineID: UUID?
    /// 점검 중(루틴을 돌거나 기다리는 중 포함).
    public private(set) var isChecking = false

    /// 기록이 남을 때마다(건너뜀 포함) 부른다. 이미 저장소에 기록 · `lastHandled` 가 들어간 뒤다.
    @ObservationIgnored public var onFinished: (@MainActor (RoutineRecord) -> Void)?

    @ObservationIgnored private let store: RoutineStore
    @ObservationIgnored private let runner: RoutineRunning
    @ObservationIgnored private let preflight: RoutinePreflight
    @ObservationIgnored private let clock: @MainActor () -> Date
    @ObservationIgnored private let sleep: @MainActor (TimeInterval) async -> Void
    @ObservationIgnored private var calendar: Calendar
    @ObservationIgnored private var tickTask: Task<Void, Never>?

    public init(store: RoutineStore,
                runner: RoutineRunning,
                preflight: RoutinePreflight = RoutinePreflight(),
                calendar: Calendar = .current,
                clock: @escaping @MainActor () -> Date = { Date() },
                sleep: @escaping @MainActor (TimeInterval) async -> Void = { seconds in try? await Task.sleep(for: .seconds(seconds)) }) {
        self.store = store
        self.runner = runner
        self.preflight = preflight
        self.calendar = calendar
        self.clock = clock
        self.sleep = sleep
    }

    // MARK: 시계

    /// 시계를 켠다 — 곧바로 한 번 살피고(앱 켬), 그 뒤 `tickInterval` 마다 살핀다. 이미 켜져 있으면 아무 일도 없다.
    public func start() {
        guard tickTask == nil else { return }
        tickTask = Task { [self] in
            while !Task.isCancelled {
                await checkNow()
                if Task.isCancelled { break }
                await sleep(Self.tickInterval)
            }
        }
    }

    /// 시계를 끈다. 이미 돌고 있는 루틴은 멈추지 않는다(`AgentSession.stop()` 몫).
    public func stop() {
        tickTask?.cancel()
        tickTask = nil
    }

    public var isTicking: Bool { tickTask != nil }

    // MARK: 살피기

    /// 지금 켜진 루틴을 살펴 때가 된 것을 처리한다 — 앱을 켤 때 · 잠에서 깰 때(`NSWorkspace.didWakeNotification`) 부른다.
    /// 처리가 끝날 때까지(루틴을 도는 동안 포함) 돌아오지 않는다. 이미 점검 중이면 바로 돌아온다.
    public func checkNow() async {
        guard !isChecking else { return }
        isChecking = true
        defer { isChecking = false }
        var handled = Set<UUID>()   // 한 점검에서 루틴마다 한 번만 — 저장이 실패해도 되풀이로 돌지 않게
        while !Task.isCancelled, let (routine, decision) = nextDue(excluding: handled) {
            handled.insert(routine.id)
            switch decision {
            case .skipMissed(let scheduled):
                finish(routine: routine, status: RoutineRecord.statusSkipped(Self.missedSkipReason), answer: "", scheduled: scheduled)
            case .run(let scheduled):
                await runDue(routine, scheduled: scheduled)
            case .notYet:
                break
            }
        }
    }

    private func nextDue(excluding handled: Set<UUID>) -> (Routine, ScheduleDecision)? {
        let now = clock()
        for r in store.routines where r.enabled && !handled.contains(r.id) {
            let d = r.decide(now: now, calendar: calendar)
            switch d {
            case .notYet: continue
            case .run, .skipMissed: return (r, d)
            }
        }
        return nil
    }

    private func runDue(_ routine: Routine, scheduled: Date) async {
        if case .skip(let reason) = preflight.check() {
            finish(routine: routine, status: RoutineRecord.statusSkipped(reason), answer: "", scheduled: scheduled)
            return
        }
        // ③ 다른 일이 돌면 기다린다(최대 1800초)
        if runner.isBusy {
            waitingRoutineID = routine.id
            defer { if waitingRoutineID == routine.id { waitingRoutineID = nil } }
            let startedWaiting = clock()
            while runner.isBusy {
                if clock().timeIntervalSince(startedWaiting) >= Self.busyWaitLimit {
                    finish(routine: routine, status: RoutineRecord.statusSkipped(Self.busyWaitSkipReason), answer: "", scheduled: scheduled)
                    return
                }
                await sleep(Self.busyPollInterval)
                if Task.isCancelled { return }   // 시계를 껐다 — 기록 없이 둔다(다시 켜면 처음부터 판단)
            }
            if case .skip(let reason) = preflight.check() {   // 기다린 사이 사파리가 꺼졌을 수 있다
                finish(routine: routine, status: RoutineRecord.statusSkipped(reason), answer: "", scheduled: scheduled)
                return
            }
        }
        // 기다린 사이 고치거나 끄거나 지웠을 수 있다 — 저장소에서 다시 읽는다.
        guard let fresh = store.routine(id: routine.id), fresh.enabled else { return }
        guard let task = store.savedTask(id: fresh.taskID) else {
            finish(routine: fresh, status: RoutineRecord.statusSkipped(Self.missingTaskReason), answer: "", scheduled: scheduled)
            return
        }
        activeRoutineID = fresh.id
        let outcome = await runner.runRoutine(text: task.text, sites: fresh.sites)
        activeRoutineID = nil
        finish(routine: fresh, taskName: task.name, status: outcome.status, answer: outcome.answer, scheduled: scheduled)
    }

    // MARK: 지금 한 번

    /// 「지금 한 번」 — 일정은 보지 않고 곧바로 돈다. 돌기 전 확인 ①②는 거친다(건너뛰면 `건너뜀(이유)` 기록).
    /// 기다리지 않는다: 이미 다른 일이 돌면 그 사실이 `건너뜀(다른 일이 도는 중이에요)` 로 기록된다.
    /// 일정 기준(`lastHandled`)은 건드리지 않는다. 루틴 · 저장한 일이 없으면 nil.
    @discardableResult
    public func runNow(routineID: UUID) async -> RoutineRecord? {
        guard let routine = store.routine(id: routineID) else { return nil }
        guard let task = store.savedTask(id: routine.taskID) else {
            return finish(routine: routine, status: RoutineRecord.statusSkipped(Self.missingTaskReason), answer: "", scheduled: nil)
        }
        if case .skip(let reason) = preflight.check() {
            return finish(routine: routine, taskName: task.name, status: RoutineRecord.statusSkipped(reason), answer: "", scheduled: nil)
        }
        let claimed = !runner.isBusy
        if claimed { activeRoutineID = routine.id }
        let outcome = await runner.runRoutine(text: task.text, sites: routine.sites)
        if claimed { activeRoutineID = nil }
        return finish(routine: routine, taskName: task.name, status: outcome.status, answer: outcome.answer, scheduled: nil)
    }

    // MARK: 기록

    /// 기록을 남기고 `lastHandled`(예정 시각이 있을 때) · `lastRun`(실제로 돈 경우만)을 저장한 뒤 `onFinished` 를 부른다.
    @discardableResult
    private func finish(routine: Routine, taskName: String? = nil, status: String, answer: String, scheduled: Date?) -> RoutineRecord {
        let now = clock()
        let name = taskName ?? store.savedTask(id: routine.taskID)?.name ?? "(지운 일)"
        let record = RoutineRecord(at: now, routineID: routine.id, name: name, status: status, answer: answer)
        try? store.appendHistory(record)
        let ran = !status.hasPrefix("건너뜀")
        if scheduled != nil || ran {
            _ = try? store.updateRoutine(id: routine.id) { r in
                if let scheduled { r.lastHandled = scheduled }
                if ran { r.lastRun = now }
            }
        }
        onFinished?(record)
        return record
    }
}
