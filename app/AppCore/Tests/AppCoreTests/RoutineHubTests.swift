import XCTest
@testable import AppCore

// MARK: 가짜들

private final class HubSafari: SafariRunningChecking, @unchecked Sendable {
    func isSafariRunning() -> Bool { true }
}

private final class HubAutomation: SafariAutomationChecking, @unchecked Sendable {
    var askArguments: [Bool] = []
    func permissionStatus(askUserIfNeeded: Bool) -> OSStatus { askArguments.append(askUserIfNeeded); return noErr }
}

private final class FakeNotifier: RoutineNotifying, @unchecked Sendable {
    var grant = true
    var requestCount = 0
    var delivered: [(title: String, body: String)] = []
    func requestAuthorization() async -> Bool { requestCount += 1; return grant }
    func deliver(title: String, body: String) { delivered.append((title, body)) }
}

private final class FakePreference: NotifyPreferenceStoring {
    var isOn = false
}

@MainActor
private final class HubClock {
    var now: Date
    init(_ now: Date) { self.now = now }
}

@MainActor
private final class HubRunner: RoutineRunning {
    var calls = 0
    var outcome = RoutineOutcome(status: RoutineRecord.statusDone, answer: "사과 3000원")
    var isBusy: Bool { false }
    func runRoutine(text: String, sites: [String]) async -> RoutineOutcome { calls += 1; return outcome }
}

final class RoutineHubTests: XCTestCase {
    private var dir: URL!
    private var store: RoutineStore!
    private let notifier = FakeNotifier()
    private let preference = FakePreference()
    private let automation = HubAutomation()
    private var calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()
    // 1_800_000_000 = 2027-01-15 08:00:00 UTC
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    private var hubs: [RoutineHub] = []

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("rhub-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        store = RoutineStore(directory: dir)
    }

    @MainActor
    override func tearDown() async throws {
        for h in hubs { h.shutdown() }
        hubs = []
        try? FileManager.default.removeItem(at: dir)
    }

    @MainActor
    private func makeHub(now: Date) -> (hub: RoutineHub, clock: HubClock, runner: HubRunner) {
        let clock = HubClock(now)
        let runner = HubRunner()
        let scheduler = RoutineScheduler(
            store: store, runner: runner,
            preflight: RoutinePreflight(safari: HubSafari(), automation: automation),
            calendar: calendar,
            clock: { clock.now },
            sleep: { _ in try? await Task.sleep(nanoseconds: 3_600_000_000_000) })   // 시험 안에서는 틱이 한 번 뒤엔 잠들어 있다
        let hub = RoutineHub(store: store, scheduler: scheduler, notifier: notifier, preference: preference, clock: { clock.now })
        hubs.append(hub)
        return (hub, clock, runner)
    }

    private func addTask(_ name: String = "쿠팡 사과") throws -> SavedTask {
        try store.upsertSavedTask(SavedTask(name: name, text: "쿠팡에서 사과 값 알려 줘"))
    }

    private func routine(_ task: SavedTask, enabled: Bool = true, schedule: RoutineSchedule = .daily(hour: 9, minute: 0),
                         createdAt: Date, lastHandled: Date? = nil) -> Routine {
        Routine(taskID: task.id, schedule: schedule, sites: ["coupang.com"], enabled: enabled, lastHandled: lastHandled, createdAt: createdAt)
    }

    // MARK: 켜는 순간 기준 맞추기 (R4 d) — 저장소

    func testSaveRoutineCreatedEnabledSetsLastHandledToNow() throws {
        let task = try addTask()
        let now = t0.addingTimeInterval(86_400 * 30)
        let saved = try store.saveRoutine(routine(task, createdAt: t0), now: now)
        XCTAssertEqual(saved.lastHandled, now)
        XCTAssertEqual(store.routine(id: saved.id)?.lastHandled, now)
    }

    func testSaveRoutineCreatedDisabledLeavesLastHandled() throws {
        let task = try addTask()
        let saved = try store.saveRoutine(routine(task, enabled: false, createdAt: t0), now: t0.addingTimeInterval(1000))
        XCTAssertNil(saved.lastHandled)
    }

    func testSaveRoutineTurningOnSetsLastHandledButKeepingOnOrOffDoesNot() throws {
        let task = try addTask()
        let old = t0.addingTimeInterval(-86_400 * 20)
        var r = try store.saveRoutine(routine(task, enabled: false, createdAt: old, lastHandled: old), now: old)
        XCTAssertEqual(r.lastHandled, old)   // 꺼진 채 저장 — 그대로
        let now = t0.addingTimeInterval(3 * 3600)
        r.enabled = true
        r = try store.saveRoutine(r, now: now)
        XCTAssertEqual(r.lastHandled, now)   // off → on
        let later = now.addingTimeInterval(500)
        r.sites = ["coupang.com", "naver.com"]
        r = try store.saveRoutine(r, now: later)
        XCTAssertEqual(r.lastHandled, now)   // 켜진 채 다른 칸만 고침 — 기준 그대로
        r.enabled = false
        r = try store.saveRoutine(r, now: later)
        XCTAssertEqual(r.lastHandled, now)   // on → off — 그대로
    }

    func testSaveRoutineScheduleChangeWhileEnabledResetsLastHandled() throws {
        let task = try addTask()
        var r = try store.saveRoutine(routine(task, createdAt: t0), now: t0)
        let now = t0.addingTimeInterval(5 * 3600)
        r.schedule = .daily(hour: 8, minute: 0)
        r = try store.saveRoutine(r, now: now)
        XCTAssertEqual(r.lastHandled, now)
    }

    @MainActor
    func testReEnablingLongOffRoutineDoesNotRecordBogusMissedSlot() async throws {
        let task = try addTask()
        // 3주 전에 만들어 꺼 둔 루틴 — 기준이 옛날이라 그대로 켜면 지난 칸이 60분을 넘겨 「건너뜀(지나침)」 이 생긴다.
        let old = t0.addingTimeInterval(-86_400 * 21)
        let r = try store.upsertRoutine(routine(task, enabled: false, createdAt: old, lastHandled: old))
        let (hub, _, runner) = makeHub(now: t0.addingTimeInterval(5 * 3600))   // 13:00
        try hub.setEnabled(true, routineID: r.id)
        await hub.scheduler.checkNow()
        XCTAssertEqual(store.history(), [])      // 건너뜀(지나침) 도 없고
        XCTAssertEqual(runner.calls, 0)          // 돌지도 않는다(다음 09:00 을 기다린다)
        XCTAssertEqual(store.routine(id: r.id)?.lastHandled, t0.addingTimeInterval(5 * 3600))
    }

    // MARK: 시계는 켜진 루틴이 있을 때만

    @MainActor
    func testSchedulerRunsOnlyWhileAnyRoutineIsEnabled() throws {
        let task = try addTask()
        let (hub, _, _) = makeHub(now: t0)
        hub.launch()
        XCTAssertFalse(hub.scheduler.isTicking)          // 루틴이 없으면 안 돈다
        let r1 = try hub.saveRoutine(routine(task, createdAt: t0))
        XCTAssertTrue(hub.scheduler.isTicking)           // 켜진 루틴이 생기면 돈다
        let r2 = try hub.saveRoutine(routine(task, createdAt: t0))
        try hub.setEnabled(false, routineID: r1.id)
        XCTAssertTrue(hub.scheduler.isTicking)           // 하나라도 켜져 있으면 계속
        try hub.setEnabled(false, routineID: r2.id)
        XCTAssertFalse(hub.scheduler.isTicking)          // 마지막이 꺼지면 선다
        try hub.setEnabled(true, routineID: r1.id)
        XCTAssertTrue(hub.scheduler.isTicking)
        try hub.deleteRoutine(id: r1.id)
        XCTAssertFalse(hub.scheduler.isTicking)          // 켜진 것을 지워도 선다
    }

    @MainActor
    func testLaunchStartsSchedulerWhenARoutineIsEnabledAndNotOtherwise() throws {
        let task = try addTask()
        try store.upsertRoutine(routine(task, enabled: false, createdAt: t0))
        let (hub, _, _) = makeHub(now: t0)
        hub.launch()
        XCTAssertFalse(hub.scheduler.isTicking)
        try store.upsertRoutine(routine(task, createdAt: t0))
        hub.launch()
        XCTAssertTrue(hub.scheduler.isTicking)
        XCTAssertEqual(notifier.requestCount, 0)         // 켤 때 알림 허락을 묻지 않는다
    }

    @MainActor
    func testDeletingTaskDeletesItsRoutinesAndStopsSchedulerWhenNoneLeft() throws {
        let task = try addTask()
        let other = try addTask("다른 일")
        let (hub, _, _) = makeHub(now: t0)
        try hub.saveRoutine(routine(task, createdAt: t0))
        try hub.saveRoutine(routine(task, enabled: false, createdAt: t0))
        try hub.saveRoutine(routine(other, enabled: false, createdAt: t0))
        XCTAssertEqual(hub.routineCount(forTask: task.id), 2)
        XCTAssertEqual(hub.routineCount(forTask: other.id), 1)
        XCTAssertTrue(hub.scheduler.isTicking)
        try hub.deleteTask(id: task.id)
        XCTAssertEqual(store.routines.count, 1)
        XCTAssertFalse(hub.scheduler.isTicking)
    }

    @MainActor
    func testWakeChecksOnlyWhenARoutineIsEnabled() async throws {
        let task = try addTask()
        let (hub, clock, runner) = makeHub(now: t0.addingTimeInterval(3600))   // 09:00
        try store.upsertRoutine(routine(task, enabled: false, createdAt: t0))
        await hub.handleWake()
        XCTAssertEqual(runner.calls, 0)
        try store.upsertRoutine(routine(task, createdAt: t0))
        hub.shutdown()                                   // 시계는 꺼진 상태 — 깨어남 점검은 시계가 켜져 있을 때만 일한다
        await hub.handleWake()
        XCTAssertEqual(runner.calls, 0)
        hub.reconcile()
        await hub.handleWake()
        XCTAssertEqual(runner.calls, 1)
        _ = clock
    }

    // MARK: 지금 한 번

    @MainActor
    func testRunNowWorksForDisabledRoutineWhenSchedulerIsStoppedAndThenStopsAgain() async throws {
        let task = try addTask()
        let r = try store.upsertRoutine(routine(task, enabled: false, createdAt: t0))
        let (hub, _, runner) = makeHub(now: t0.addingTimeInterval(3600))
        hub.launch()
        XCTAssertFalse(hub.scheduler.isTicking)
        let rec = await hub.runNow(routineID: r.id)
        XCTAssertEqual(rec?.status, RoutineRecord.statusDone)
        XCTAssertEqual(runner.calls, 1)
        XCTAssertFalse(hub.scheduler.isTicking)          // 끝나면 다시 꺼진다
        XCTAssertEqual(automation.askArguments.allSatisfy { $0 == false }, true)   // 같은 돌기 전 확인(허락 창 없음)
        XCTAssertEqual(store.history().count, 1)
    }

    // MARK: 알림 (R4 e)

    func testNotificationPolicyOnlyForDonePartialFailed() {
        func rec(_ status: String) -> RoutineRecord { RoutineRecord(at: Date(), routineID: UUID(), name: "일", status: status, answer: "a") }
        XCTAssertTrue(RoutineNotification.shouldNotify(rec(RoutineRecord.statusDone)))
        XCTAssertTrue(RoutineNotification.shouldNotify(rec(RoutineRecord.statusPartial)))
        XCTAssertTrue(RoutineNotification.shouldNotify(rec(RoutineRecord.statusFailed)))
        XCTAssertFalse(RoutineNotification.shouldNotify(rec(RoutineRecord.statusSkipped("지나침"))))
        XCTAssertFalse(RoutineNotification.shouldNotify(rec(RoutineRecord.statusSkipped("다른 일이 도는 중이에요"))))
    }

    func testNotificationTextIsOneLineAndShort() {
        let long = String(repeating: "가", count: 300)
        let rec = RoutineRecord(at: Date(), routineID: UUID(), name: "쿠팡 사과", status: "끝남", answer: "첫 줄\n\n둘째 줄 " + long)
        XCTAssertEqual(RoutineNotification.title(for: rec), "루틴 「쿠팡 사과」 끝남")
        let body = RoutineNotification.body(for: rec)
        XCTAssertFalse(body.contains("\n"))
        XCTAssertTrue(body.hasPrefix("첫 줄 둘째 줄"))
        XCTAssertLessThanOrEqual(body.count, 121)
        XCTAssertEqual(RoutineNotification.body(for: RoutineRecord(at: Date(), routineID: UUID(), name: "a", status: "끝남", answer: "")),
                       "옆 창의 루틴 기록에서 볼 수 있어요")
    }

    @MainActor
    func testAuthorizationIsAskedOnlyWhenUserTurnsNotificationsOn() async throws {
        let task = try addTask()
        let (hub, _, _) = makeHub(now: t0.addingTimeInterval(3600))
        hub.launch()
        XCTAssertEqual(notifier.requestCount, 0)
        let r = try hub.saveRoutine(routine(task, createdAt: t0))
        _ = r
        await hub.handleWake()
        XCTAssertEqual(notifier.requestCount, 0)           // 루틴이 돌고 끝나도 묻지 않는다
        await hub.setNotify(true)
        XCTAssertEqual(notifier.requestCount, 1)
        XCTAssertTrue(hub.notifyEnabled)
        XCTAssertTrue(preference.isOn)
        await hub.setNotify(false)
        XCTAssertEqual(notifier.requestCount, 1)           // 끌 때는 묻지 않는다
        XCTAssertFalse(hub.notifyEnabled)
        XCTAssertFalse(preference.isOn)
    }

    @MainActor
    func testDeniedAuthorizationKeepsItOffWithMessage() async {
        notifier.grant = false
        let (hub, _, _) = makeHub(now: t0)
        await hub.setNotify(true)
        XCTAssertFalse(hub.notifyEnabled)
        XCTAssertFalse(preference.isOn)
        XCTAssertEqual(hub.notifyProblem, RoutineHub.notifyDeniedMessage)
        notifier.grant = true
        await hub.setNotify(true)
        XCTAssertTrue(hub.notifyEnabled)
        XCTAssertNil(hub.notifyProblem)
    }

    @MainActor
    func testFinishedRoutinesNotifyOnlyWhenOnAndOnlyForRealResults() async throws {
        let task = try addTask()
        let r = try store.upsertRoutine(routine(task, enabled: false, createdAt: t0))
        let (hub, _, runner) = makeHub(now: t0.addingTimeInterval(3600))
        await hub.runNow(routineID: r.id)
        XCTAssertEqual(notifier.delivered.count, 0)        // 꺼져 있으면 기록만
        await hub.setNotify(true)
        await hub.runNow(routineID: r.id)
        XCTAssertEqual(notifier.delivered.count, 1)
        XCTAssertEqual(notifier.delivered.first?.title, "루틴 「쿠팡 사과」 끝남")
        runner.outcome = RoutineOutcome(status: RoutineRecord.statusPartial, answer: "일부")
        await hub.runNow(routineID: r.id)
        runner.outcome = RoutineOutcome(status: RoutineRecord.statusFailed, answer: "오류")
        await hub.runNow(routineID: r.id)
        XCTAssertEqual(notifier.delivered.count, 3)
        runner.outcome = RoutineOutcome(status: RoutineRecord.statusSkipped("다른 일이 도는 중이에요"), answer: "")
        await hub.runNow(routineID: r.id)
        XCTAssertEqual(notifier.delivered.count, 3)        // 건너뜀은 알리지 않고
        XCTAssertEqual(store.history().count, 5)           // 기록은 남는다
        XCTAssertEqual(notifier.requestCount, 1)           // 알림을 보낼 때 허락을 다시 묻지 않는다
    }

    @MainActor
    func testRestoredPreferenceDoesNotAskAtLaunch() throws {
        preference.isOn = true
        let (hub, _, _) = makeHub(now: t0)
        hub.launch()
        XCTAssertTrue(hub.notifyEnabled)
        XCTAssertEqual(notifier.requestCount, 0)
    }

    @MainActor
    func testRevisionBumpsOnChanges() throws {
        let task = try addTask()
        let (hub, _, _) = makeHub(now: t0)
        let r0 = hub.revision
        let r = try hub.saveRoutine(routine(task, createdAt: t0))
        XCTAssertGreaterThan(hub.revision, r0)
        let r1 = hub.revision
        try hub.setEnabled(false, routineID: r.id)
        XCTAssertGreaterThan(hub.revision, r1)
    }

    func testScheduleSummaryTexts() {
        XCTAssertEqual(RoutineSchedule.daily(hour: 9, minute: 5).summary, "매일 09:05")
        XCTAssertEqual(RoutineSchedule.weekdays([4, 2], hour: 18, minute: 30).summary, "매주 월 · 수 18:30")
        XCTAssertEqual(RoutineSchedule.weekdays([1, 7], hour: 0, minute: 0).summary, "매주 일 · 토 00:00")
        XCTAssertEqual(RoutineSchedule.weekdays([], hour: 9, minute: 0).summary, "요일을 고르지 않았어요")
        XCTAssertEqual(RoutineSchedule.everyHours(3).summary, "3시간마다")
        XCTAssertEqual(RoutineSchedule.everyHours(99).summary, "24시간마다")
    }
}
