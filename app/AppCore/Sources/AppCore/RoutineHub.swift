import Foundation
import Observation

/// 맥 알림을 보내는 쪽 — 앱에서는 `UNUserNotificationCenter`, 시험에서는 가짜.
public protocol RoutineNotifying: AnyObject, Sendable {
    /// 알림 허락을 **묻는다**(허락 창이 뜰 수 있다). 사람이 「끝나면 알림」 을 켤 때만 부른다 — 앱을 켤 때나 루틴이 끝날 때는 부르지 않는다.
    func requestAuthorization() async -> Bool
    /// 알림을 보낸다. 이미 허락이 있을 때만 보내고, 허락이 없으면 아무 일도 하지 않는다(절대 묻지 않는다).
    func deliver(title: String, body: String)
}

/// 「끝나면 알림」 켬 여부를 기억하는 곳(앱에서는 UserDefaults, 시험에서는 가짜).
public protocol NotifyPreferenceStoring: AnyObject {
    var isOn: Bool { get set }
}

/// 맥 알림을 보낼 기록인지 — 끝남 · 일부만 됨 · 실패만. 건너뜀은 기록만 남기고 알리지 않는다.
public enum RoutineNotification {
    public static func shouldNotify(_ record: RoutineRecord) -> Bool {
        [RoutineRecord.statusDone, RoutineRecord.statusPartial, RoutineRecord.statusFailed].contains(record.status)
    }

    public static func title(for record: RoutineRecord) -> String { "루틴 「\(record.name)」 \(record.status)" }

    /// 답 앞부분을 한 줄로(없으면 안내 한 줄).
    public static func body(for record: RoutineRecord) -> String {
        let oneLine = record.answer.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }.joined(separator: " ")
        if oneLine.isEmpty { return "옆 창의 루틴 기록에서 볼 수 있어요" }
        return oneLine.count > 120 ? String(oneLine.prefix(120)) + "…" : oneLine
    }
}

/// 화면이 쓰는 한 덩어리 — 저장한 일 · 루틴 · 기록(`RoutineStore`)과 앱 안 시계(`RoutineScheduler`)를 묶고,
/// 시계가 「루틴이 하나라도 켜져 있을 때만」 돌게 하며, 「끝나면 알림」 을 다룬다. 화면은 `revision` 을 읽어 저장소가 바뀌면 다시 그린다.
///
/// 저장소 인스턴스는 폴더당 하나여야 하므로 앱은 이 `store` 하나만 쓴다.
@MainActor @Observable
public final class RoutineHub {
    public let store: RoutineStore
    public let scheduler: RoutineScheduler
    /// 저장소 · 기록이 바뀔 때마다 오른다 — 화면이 이 값을 읽으면 바뀐 뒤 다시 그려진다.
    public private(set) var revision = 0
    public private(set) var notifyEnabled: Bool
    /// 알림 허락을 못 받았을 때 보여 줄 한 줄.
    public private(set) var notifyProblem: String?

    public static let notifyDeniedMessage = "알림 허락이 없어서 켜지 못했어요 — 시스템 설정 ▸ 알림 에서 사파리-어트랙션을 허락한 뒤 다시 켜 주세요"

    @ObservationIgnored private let notifier: RoutineNotifying
    @ObservationIgnored private let preference: NotifyPreferenceStoring
    @ObservationIgnored private let clock: @MainActor () -> Date

    public init(store: RoutineStore, scheduler: RoutineScheduler, notifier: RoutineNotifying, preference: NotifyPreferenceStoring,
                clock: @escaping @MainActor () -> Date = { Date() }) {
        self.store = store
        self.scheduler = scheduler
        self.notifier = notifier
        self.preference = preference
        self.clock = clock
        self.notifyEnabled = preference.isOn
        scheduler.onFinished = { [weak self] record in self?.handleFinished(record) }
    }

    // MARK: 시계

    public var hasEnabledRoutine: Bool { store.routines.contains { $0.enabled } }

    /// 시계를 루틴 상태에 맞춘다 — 켜진 루틴이 하나라도 있으면 시작(곧바로 한 번 살핀다), 없으면 끈다.
    public func reconcile() {
        if hasEnabledRoutine { scheduler.start() } else { scheduler.stop() }
    }

    /// 앱을 켤 때 — 켜진 루틴이 있으면 시계를 시작한다(`start()` 가 곧바로 한 번 살피니 놓친 시각 처리도 여기서 된다). 알림 허락은 묻지 않는다.
    public func launch() { reconcile() }

    /// 잠에서 깰 때 — 켜진 루틴이 있을 때만 한 번 살핀다.
    public func handleWake() async {
        guard hasEnabledRoutine else { return }
        await scheduler.checkNow()
    }

    /// 앱을 끝낼 때.
    public func shutdown() { scheduler.stop() }

    // MARK: 저장한 일

    @discardableResult
    public func saveTask(_ task: SavedTask) throws -> SavedTask {
        defer { revision += 1 }
        return try store.upsertSavedTask(task)
    }

    /// 이 일을 지우면 함께 지워질 루틴 수(지우기 전 확인 글에 쓴다).
    public func routineCount(forTask id: UUID) -> Int { store.routines.filter { $0.taskID == id }.count }

    /// 저장한 일을 지운다 — 그 일의 루틴도 함께 지워진다. 켜진 루틴이 없어지면 시계를 끈다.
    public func deleteTask(id: UUID) throws {
        defer { revision += 1; reconcile() }
        try store.removeSavedTask(id: id)
    }

    // MARK: 루틴

    @discardableResult
    public func saveRoutine(_ routine: Routine) throws -> Routine {
        defer { revision += 1; reconcile() }
        return try store.saveRoutine(routine, now: clock())
    }

    public func setEnabled(_ enabled: Bool, routineID: UUID) throws {
        guard var r = store.routine(id: routineID), r.enabled != enabled else { return }
        r.enabled = enabled
        try saveRoutine(r)
    }

    public func deleteRoutine(id: UUID) throws {
        defer { revision += 1; reconcile() }
        try store.removeRoutine(id: id)
    }

    /// 「지금 한 번」 — 꺼진 루틴도 돌려 볼 수 있다. 시계가 꺼져 있으면(켜진 루틴이 없음) 잠깐 켰다가 끝나면 다시 맞춘다.
    @discardableResult
    public func runNow(routineID: UUID) async -> RoutineRecord? {
        if !scheduler.isTicking { scheduler.start() }   // stop() 뒤엔 runNow 가 아무것도 안 하므로 먼저 켠다(켜진 루틴이 없으니 살필 것은 없다)
        let record = await scheduler.runNow(routineID: routineID)
        revision += 1
        reconcile()
        return record
    }

    // MARK: 알림

    /// 「끝나면 알림」 켜기 · 끄기. 켤 때만 알림 허락을 묻는다(사람의 동작) — 허락을 못 받으면 켜지지 않고 안내 글이 남는다.
    public func setNotify(_ on: Bool) async {
        guard on else {
            notifyEnabled = false
            preference.isOn = false
            notifyProblem = nil
            return
        }
        if await notifier.requestAuthorization() {
            notifyEnabled = true
            preference.isOn = true
            notifyProblem = nil
        } else {
            notifyEnabled = false
            preference.isOn = false
            notifyProblem = Self.notifyDeniedMessage
        }
    }

    private func handleFinished(_ record: RoutineRecord) {
        revision += 1
        guard notifyEnabled, RoutineNotification.shouldNotify(record) else { return }
        notifier.deliver(title: RoutineNotification.title(for: record), body: RoutineNotification.body(for: record))
    }
}
