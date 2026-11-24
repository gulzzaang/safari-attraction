import XCTest
@testable import AppCore

// MARK: 가짜들

private final class FakeSafariCheck: SafariRunningChecking, @unchecked Sendable {
    var running = true
    var calls = 0
    func isSafariRunning() -> Bool { calls += 1; return running }
}

private final class FakeAutomationCheck: SafariAutomationChecking, @unchecked Sendable {
    var status: OSStatus = noErr
    var askArguments: [Bool] = []
    func permissionStatus(askUserIfNeeded: Bool) -> OSStatus {
        askArguments.append(askUserIfNeeded)
        return status
    }
}

@MainActor
private final class FakeSchedClock {
    var now: Date
    init(_ now: Date) { self.now = now }
}

@MainActor
private final class FakeRoutineRunner: RoutineRunning {
    var busy = false
    var calls: [(text: String, sites: [String])] = []
    var outcome = RoutineOutcome(status: RoutineRecord.statusDone, answer: "사과 3000원")
    var inRun = 0
    var maxInRun = 0
    var onRun: (@MainActor () async -> Void)?
    var isBusy: Bool { busy }
    func runRoutine(text: String, sites: [String]) async -> RoutineOutcome {
        calls.append((text, sites))
        inRun += 1
        maxInRun = max(maxInRun, inRun)
        busy = true
        await Task.yield()
        if let onRun { await onRun() }
        busy = false
        inRun -= 1
        return outcome
    }
}

final class RoutineSchedulerTests: XCTestCase {
    private var dir: URL!
    private var store: RoutineStore!
    private let safari = FakeSafariCheck()
    private let automation = FakeAutomationCheck()
    private var calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()
    // 1_800_000_000 = 2027-01-15 08:00:00 UTC. 매일 09:00 루틴의 첫 예정 시각은 09:00.
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    private let nine = Date(timeIntervalSince1970: 1_800_000_000 + 3600)

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("rsch-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        store = RoutineStore(directory: dir)
    }
    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    @discardableResult
    private func addRoutine(name: String = "쿠팡 사과", text: String = "쿠팡에서 사과 값 알려 줘", sites: [String] = ["coupang.com"],
                            schedule: RoutineSchedule = .daily(hour: 9, minute: 0), enabled: Bool = true) throws -> Routine {
        let task = try store.upsertSavedTask(SavedTask(name: name, text: text))
        return try store.upsertRoutine(Routine(taskID: task.id, schedule: schedule, sites: sites, enabled: enabled, createdAt: t0))
    }

    @MainActor
    private struct Rig {
        let scheduler: RoutineScheduler
        let clock: FakeSchedClock
        let runner: FakeRoutineRunner
        let sleeps: SleepLog
    }

    @MainActor
    private final class SleepLog {
        var durations: [TimeInterval] = []
        var onSleep: (@MainActor (Int) -> Void)?
        var total: TimeInterval { durations.reduce(0, +) }
    }

    @MainActor
    private func makeRig(now: Date) -> Rig {
        let clock = FakeSchedClock(now)
        let runner = FakeRoutineRunner()
        let log = SleepLog()
        let scheduler = RoutineScheduler(
            store: store, runner: runner,
            preflight: RoutinePreflight(safari: safari, automation: automation),
            calendar: calendar,
            clock: { clock.now },
            sleep: { seconds in
                log.durations.append(seconds)
                clock.now = clock.now.addingTimeInterval(seconds)   // 진짜로 자지 않고 시계만 간다
                log.onSleep?(log.durations.count)
                await Task.yield()
            })
        return Rig(scheduler: scheduler, clock: clock, runner: runner, sleeps: log)
    }

    // MARK: 돌기 전 확인

    @MainActor
    func testNotYetDoesNothing() async throws {
        let r = try addRoutine()
        let rig = makeRig(now: t0.addingTimeInterval(59 * 60))   // 08:59
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 0)
        XCTAssertEqual(safari.calls, 0)
        XCTAssertEqual(store.history(), [])
        XCTAssertNil(store.routine(id: r.id)?.lastHandled)
    }

    @MainActor
    func testRunsWhenDueAndRecordsOutcome() async throws {
        let r = try addRoutine(text: "사과 값", sites: ["coupang.com", "naver.com"])
        let rig = makeRig(now: nine.addingTimeInterval(60))   // 09:01
        var finished: [RoutineRecord] = []
        rig.scheduler.onFinished = { finished.append($0) }
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 1)
        XCTAssertEqual(rig.runner.calls.first?.text, "사과 값")
        XCTAssertEqual(rig.runner.calls.first?.sites, ["coupang.com", "naver.com"])
        let h = store.history()
        XCTAssertEqual(h.count, 1)
        XCTAssertEqual(h.first?.status, RoutineRecord.statusDone)
        XCTAssertEqual(h.first?.answer, "사과 3000원")
        XCTAssertEqual(h.first?.name, "쿠팡 사과")
        XCTAssertEqual(h.first?.routineID, r.id)
        XCTAssertEqual(h.first?.at, nine.addingTimeInterval(60))
        XCTAssertEqual(finished, h)   // 알림 콜백에 같은 기록
        let saved = store.routine(id: r.id)
        XCTAssertEqual(saved?.lastHandled, nine)          // 예정 시각
        XCTAssertEqual(saved?.lastRun, nine.addingTimeInterval(60))   // 실제 돈 시각
        // 같은 때에 또 점검해도 다시 안 돈다
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 1)
    }

    @MainActor
    func testSafariNotRunningSkipsWithoutRunningAndWithoutAskingPermission() async throws {
        let r = try addRoutine()
        safari.running = false
        let rig = makeRig(now: nine)
        var finished: [RoutineRecord] = []
        rig.scheduler.onFinished = { finished.append($0) }
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 0)
        XCTAssertEqual(automation.askArguments, [])   // ①에서 걸리면 ②는 보지도 않는다
        XCTAssertEqual(store.history().first?.status, "건너뜀(사파리가 켜져 있지 않아 건너뛰었어요)")
        XCTAssertEqual(finished.count, 1)
        let saved = store.routine(id: r.id)
        XCTAssertEqual(saved?.lastHandled, nine)   // 건너뛰어도 예정 시각은 처리됨 — 되풀이로 안 돈다
        XCTAssertNil(saved?.lastRun)
        await rig.scheduler.checkNow()
        XCTAssertEqual(store.history().count, 1)
    }

    @MainActor
    func testMissingAutomationPermissionSkipsAndNeverAsksUser() async throws {
        try addRoutine()
        automation.status = OSStatus(-1744)   // errAEEventWouldRequireUserConsent
        let rig = makeRig(now: nine)
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 0)
        XCTAssertEqual(store.history().first?.status, "건너뜀(사파리 제어 허락이 아직 없어요 — 맥 앞에서 일 맡기기를 한 번 써 주세요)")
        XCTAssertFalse(automation.askArguments.isEmpty)
        XCTAssertTrue(automation.askArguments.allSatisfy { $0 == false })   // 허락 창을 띄우는 쪽으로는 한 번도 안 부름
    }

    @MainActor
    func testPermissionCheckedWithAskFalseAlsoWhenRunning() async throws {
        try addRoutine()
        let rig = makeRig(now: nine)
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 1)
        XCTAssertEqual(automation.askArguments, [false])
    }

    // MARK: 바쁨

    @MainActor
    func testWaitsForBusyThenRuns() async throws {
        try addRoutine()
        let rig = makeRig(now: nine)
        rig.runner.busy = true   // 사람이 일 맡기기를 하는 중
        rig.sleeps.onSleep = { n in if n == 3 { rig.runner.busy = false } }
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.sleeps.durations, [5, 5, 5])
        XCTAssertEqual(rig.runner.calls.count, 1)
        XCTAssertEqual(store.history().first?.status, RoutineRecord.statusDone)
        XCTAssertNil(rig.scheduler.waitingRoutineID)
        XCTAssertNil(rig.scheduler.activeRoutineID)
    }

    @MainActor
    func testGivesUpAfter1800SecondsOfBusy() async throws {
        let r = try addRoutine()
        let rig = makeRig(now: nine)
        rig.runner.busy = true   // 끝없이 바쁨
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 0)
        XCTAssertEqual(rig.sleeps.total, 1800)
        XCTAssertEqual(store.history().first?.status, "건너뜀(다른 일이 길어져 건너뛰었어요)")
        XCTAssertEqual(store.routine(id: r.id)?.lastHandled, nine)
        XCTAssertNil(store.routine(id: r.id)?.lastRun)
        XCTAssertNil(rig.scheduler.waitingRoutineID)
    }

    @MainActor
    func testBusyUntilJustBefore1800StillRuns() async throws {
        try addRoutine()
        let rig = makeRig(now: nine)
        rig.runner.busy = true
        rig.sleeps.onSleep = { n in if n == 359 { rig.runner.busy = false } }   // 359 × 5 = 1795 초
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 1)
    }

    @MainActor
    func testSafariClosedDuringWaitSkipsAfterWaiting() async throws {
        try addRoutine()
        let rig = makeRig(now: nine)
        rig.runner.busy = true
        rig.sleeps.onSleep = { n in if n == 2 { rig.runner.busy = false; self.safari.running = false } }
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 0)
        XCTAssertEqual(store.history().first?.status, "건너뜀(사파리가 켜져 있지 않아 건너뛰었어요)")
    }

    @MainActor
    func testRoutineRemovedOrDisabledWhileWaitingIsDroppedQuietly() async throws {
        let r = try addRoutine()
        let rig = makeRig(now: nine)
        rig.runner.busy = true
        rig.sleeps.onSleep = { n in
            if n == 2 {
                rig.runner.busy = false
                _ = try? self.store.updateRoutine(id: r.id) { $0.enabled = false }
            }
        }
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 0)
        XCTAssertEqual(store.history(), [])
    }

    // MARK: 한 번에 하나

    @MainActor
    func testTwoRoutinesDueTogetherRunOneAtATimeInOrder() async throws {
        try addRoutine(name: "일 A", text: "A 해 줘")
        try addRoutine(name: "일 B", text: "B 해 줘")
        let rig = makeRig(now: nine.addingTimeInterval(10))
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.map(\.text), ["A 해 줘", "B 해 줘"])
        XCTAssertEqual(rig.runner.maxInRun, 1)
        XCTAssertEqual(store.history().map(\.name), ["일 B", "일 A"])   // 새것부터
    }

    @MainActor
    func testCheckNowWhileCheckingReturnsImmediatelyAndDoesNotDoubleRun() async throws {
        try addRoutine()
        let rig = makeRig(now: nine)
        rig.runner.onRun = { await rig.scheduler.checkNow() }   // 도는 중에 깨어남 알림이 또 옴
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 1)
        XCTAssertEqual(rig.runner.maxInRun, 1)
    }

    // MARK: 지나침

    @MainActor
    func testWakeThirtyMinutesLateRunsOnce() async throws {
        let r = try addRoutine()
        let rig = makeRig(now: nine.addingTimeInterval(30 * 60))   // 잠자고 깨어남 09:30
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 1)
        XCTAssertEqual(store.routine(id: r.id)?.lastHandled, nine)
        await rig.scheduler.checkNow()   // 깨어남 알림이 또 와도
        XCTAssertEqual(rig.runner.calls.count, 1)
    }

    @MainActor
    func testWakeThreeHoursLateSkipsAndRecordsOnly() async throws {
        let r = try addRoutine()
        let rig = makeRig(now: nine.addingTimeInterval(3 * 3600))   // 12:00
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 0)
        XCTAssertEqual(safari.calls, 0)   // 돌 일이 아니니 확인도 안 한다
        XCTAssertEqual(store.history().first?.status, "건너뜀(지나침)")
        XCTAssertEqual(store.routine(id: r.id)?.lastHandled, nine)
        XCTAssertNil(store.routine(id: r.id)?.lastRun)
        await rig.scheduler.checkNow()
        XCTAssertEqual(store.history().count, 1)   // 영원히 건너뛰지 않는다
    }

    @MainActor
    func testSeveralDaysAsleepRunsAtMostOnceNotABurst() async throws {
        try addRoutine()
        let rig = makeRig(now: nine.addingTimeInterval(3 * 86400 + 600))   // 사흘 뒤 09:10 — 가장 최근 칸만
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 1)
        XCTAssertEqual(store.history().count, 1)
    }

    @MainActor
    func testDisabledRoutineNeverRuns() async throws {
        try addRoutine(enabled: false)
        let rig = makeRig(now: nine.addingTimeInterval(60))
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 0)
        XCTAssertEqual(store.history(), [])
        XCTAssertEqual(safari.calls, 0)
    }

    @MainActor
    func testFailedAndPartialOutcomesAreRecordedAsIs() async throws {
        let r = try addRoutine()
        let rig = makeRig(now: nine)
        rig.runner.outcome = RoutineOutcome(status: RoutineRecord.statusPartial, answer: "일부만")
        await rig.scheduler.checkNow()
        XCTAssertEqual(store.history().first?.status, RoutineRecord.statusPartial)
        XCTAssertNotNil(store.routine(id: r.id)?.lastRun)   // 돌았으니 lastRun
        // 다음 날 — 실패
        rig.runner.outcome = RoutineOutcome(status: RoutineRecord.statusFailed, answer: "오류")
        rig.clock.now = nine.addingTimeInterval(86400)
        await rig.scheduler.checkNow()
        XCTAssertEqual(store.history().first?.status, RoutineRecord.statusFailed)
        XCTAssertEqual(store.history().count, 2)
    }

    @MainActor
    func testRunnerSkipOutcomeDoesNotSetLastRun() async throws {
        let r = try addRoutine()
        let rig = makeRig(now: nine)
        rig.runner.outcome = RoutineOutcome(status: RoutineRecord.statusSkipped(AgentSession.routineBusyReason), answer: "")
        await rig.scheduler.checkNow()
        XCTAssertNil(store.routine(id: r.id)?.lastRun)
        XCTAssertEqual(store.routine(id: r.id)?.lastHandled, nine)
    }

    // MARK: 지금 한 번

    @MainActor
    func testEmptySiteListSkipsWithoutRunningClaudeOnSchedule() async throws {
        let r = try addRoutine(sites: [])
        let rig = makeRig(now: nine.addingTimeInterval(60))
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 0, "사이트가 없으면 클로드를 띄우지 않는다")
        XCTAssertEqual(safari.calls, 0)
        XCTAssertEqual(store.history().map(\.status), [RoutineRecord.statusSkipped(RoutineScheduler.noSitesSkipReason)])
        XCTAssertEqual(RoutineScheduler.noSitesSkipReason, "갈 수 있는 사이트가 없어요")
        let saved = store.routine(id: r.id)
        XCTAssertEqual(saved?.lastHandled, nine, "일정 기준은 건너뜀도 저장한다")
        XCTAssertNil(saved?.lastRun)
        await rig.scheduler.checkNow()
        XCTAssertEqual(store.history().count, 1, "같은 칸은 다시 처리하지 않는다")
    }

    @MainActor
    func testEmptySiteListSkipsRunNow() async throws {
        let r = try addRoutine(sites: [])
        let rig = makeRig(now: t0)
        let rec = await rig.scheduler.runNow(routineID: r.id)
        XCTAssertEqual(rec?.status, RoutineRecord.statusSkipped(RoutineScheduler.noSitesSkipReason))
        XCTAssertEqual(rig.runner.calls.count, 0)
        XCTAssertNil(store.routine(id: r.id)?.lastHandled)
        XCTAssertNil(store.routine(id: r.id)?.lastRun)
    }

    @MainActor
    func testDefaultCalendarIsAutoupdatingCurrent() throws {
        let s = RoutineScheduler(store: store, runner: FakeRoutineRunner())
        XCTAssertEqual(s.calendarForTesting, Calendar.autoupdatingCurrent)
    }

    @MainActor
    func testRunNowGoesThroughPreflightThenRunsIgnoringSchedule() async throws {
        let r = try addRoutine()
        let rig = makeRig(now: t0)   // 08:00 — 아직 때가 아님
        let rec = await rig.scheduler.runNow(routineID: r.id)
        XCTAssertEqual(rec?.status, RoutineRecord.statusDone)
        XCTAssertEqual(rig.runner.calls.count, 1)
        XCTAssertEqual(automation.askArguments, [false])
        let saved = store.routine(id: r.id)
        XCTAssertNil(saved?.lastHandled)   // 일정 기준은 그대로
        XCTAssertEqual(saved?.lastRun, t0)
        XCTAssertEqual(store.history().count, 1)
        XCTAssertNil(rig.scheduler.activeRoutineID)
    }

    @MainActor
    func testRunNowSkipsWhenSafariNotRunningOrPermissionMissing() async throws {
        let r = try addRoutine()
        let rig = makeRig(now: t0)
        safari.running = false
        var rec = await rig.scheduler.runNow(routineID: r.id)
        XCTAssertEqual(rec?.status, "건너뜀(사파리가 켜져 있지 않아 건너뛰었어요)")
        safari.running = true
        automation.status = OSStatus(-1744)
        rec = await rig.scheduler.runNow(routineID: r.id)
        XCTAssertEqual(rec?.status, "건너뜀(사파리 제어 허락이 아직 없어요 — 맥 앞에서 일 맡기기를 한 번 써 주세요)")
        XCTAssertEqual(rig.runner.calls.count, 0)
        XCTAssertTrue(automation.askArguments.allSatisfy { $0 == false })
        XCTAssertNil(store.routine(id: r.id)?.lastRun)
        XCTAssertEqual(store.history().count, 2)
    }

    @MainActor
    func testRunNowDoesNotWaitWhenBusy() async throws {
        let r = try addRoutine()
        let rig = makeRig(now: t0)
        rig.runner.busy = true
        rig.runner.outcome = RoutineOutcome(status: RoutineRecord.statusSkipped(AgentSession.routineBusyReason), answer: "")
        let rec = await rig.scheduler.runNow(routineID: r.id)
        XCTAssertEqual(rec?.status, "건너뜀(다른 일이 도는 중이에요)")
        XCTAssertEqual(rig.sleeps.durations, [])
        XCTAssertNil(rig.scheduler.activeRoutineID)
    }

    @MainActor
    func testRunNowUnknownRoutineReturnsNil() async {
        let rig = makeRig(now: t0)
        let rec = await rig.scheduler.runNow(routineID: UUID())
        XCTAssertNil(rec)
        XCTAssertEqual(store.history(), [])
    }

    @MainActor
    func testActiveRoutineIDIsSetWhileRunning() async throws {
        let r = try addRoutine()
        let rig = makeRig(now: nine)
        var seen: UUID?
        rig.runner.onRun = { seen = rig.scheduler.activeRoutineID }
        await rig.scheduler.checkNow()
        XCTAssertEqual(seen, r.id)
        XCTAssertNil(rig.scheduler.activeRoutineID)
    }

    // MARK: 시계 켜고 끄기

    @MainActor
    func testStartChecksImmediatelyThenTicksAndStopEndsIt() async throws {
        try addRoutine(schedule: .everyHours(1))   // 만든 시각(08:00)부터 1시간마다
        let rig = makeRig(now: t0.addingTimeInterval(3600))   // 09:00 — 켜자마자 때
        let done = expectation(description: "두 칸 점검")
        rig.sleeps.onSleep = { n in
            if n == 2 { rig.scheduler.stop(); done.fulfill() }
        }
        rig.scheduler.start()
        XCTAssertTrue(rig.scheduler.isTicking)
        await fulfillment(of: [done], timeout: 5)
        XCTAssertFalse(rig.scheduler.isTicking)
        XCTAssertEqual(rig.runner.calls.count, 1)         // 켜자마자 한 번
        XCTAssertEqual(rig.sleeps.durations, [30, 30])    // 30초마다 살핌
        let count = rig.sleeps.durations.count
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(rig.sleeps.durations.count, count)  // 끈 뒤엔 더 안 돈다
    }

    @MainActor
    func testStartTwiceDoesNotDoubleTick() async throws {
        try addRoutine()
        let rig = makeRig(now: t0)
        rig.scheduler.start()
        rig.scheduler.start()
        rig.scheduler.stop()
        XCTAssertFalse(rig.scheduler.isTicking)
    }

    // MARK: 계획 9 Task 5 판정 R4 — 저장 실패 · 약한 참조 · 끈 뒤

    /// 저장소 폴더를 같은 이름의 파일로 바꿔 쓰기가 모두 실패하게 한다(메모리 사본은 그대로).
    private func breakStorage() throws {
        try FileManager.default.removeItem(at: dir)
        try Data("x".utf8).write(to: dir)
    }

    @MainActor
    func testStorageFailureDoesNotRerunSameSlotAndIsReported() async throws {
        let r = try addRoutine()
        try breakStorage()
        let rig = makeRig(now: nine.addingTimeInterval(600))   // 09:10
        var finished: [RoutineRecord] = []
        rig.scheduler.onFinished = { finished.append($0) }
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 1)
        // 원래 기록 하나 + 저장 실패 알림 기록 하나
        XCTAssertEqual(finished.count, 2)
        XCTAssertEqual(finished[0].status, RoutineRecord.statusDone)
        XCTAssertEqual(finished[1].status, RoutineRecord.statusFailed)
        XCTAssertTrue(finished[1].answer.contains("저장 실패"))
        XCTAssertNil(store.routine(id: r.id)?.lastHandled)   // 정말로 저장은 안 됐다
        // 다음 틱들에서도 같은 칸이 또 돌지 않는다
        rig.clock.now = rig.clock.now.addingTimeInterval(30)
        await rig.scheduler.checkNow()
        rig.clock.now = rig.clock.now.addingTimeInterval(30)
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 1)
        XCTAssertEqual(finished.count, 2)
    }

    @MainActor
    func testStorageFailureOnSkippedSlotAlsoDoesNotRepeat() async throws {
        try addRoutine()
        safari.running = false
        try breakStorage()
        let rig = makeRig(now: nine)
        var finished: [RoutineRecord] = []
        rig.scheduler.onFinished = { finished.append($0) }
        await rig.scheduler.checkNow()
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 0)
        XCTAssertEqual(finished.filter { $0.status.hasPrefix("건너뜀") }.count, 1)   // 건너뜀 기록은 한 번만
        XCTAssertEqual(finished.filter { $0.answer.contains("저장 실패") }.count, 1)
    }

    @MainActor
    func testNextSlotStillRunsAfterStorageFailure() async throws {
        try addRoutine()
        try breakStorage()
        let rig = makeRig(now: nine)
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 1)
        rig.clock.now = nine.addingTimeInterval(24 * 3600)   // 다음 날 09:00
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 2)
    }

    @MainActor
    func testTickTaskDoesNotRetainScheduler() async throws {
        weak var weakScheduler: RoutineScheduler?
        do {
            let rig = makeRig(now: t0)   // 09:00 전 — 할 일 없음
            weakScheduler = rig.scheduler
            rig.scheduler.start()
            XCTAssertTrue(rig.scheduler.isTicking)
        }
        for _ in 0..<500 where weakScheduler != nil { await Task.yield() }
        XCTAssertNil(weakScheduler)   // 시계를 안 끄고 놓아도 스케줄러가 풀려난다
    }

    @MainActor
    func testStopMakesCheckNowAndRunNowDoNothingUntilStartedAgain() async throws {
        let r = try addRoutine()
        let rig = makeRig(now: nine)
        rig.scheduler.start()
        rig.scheduler.stop()
        await rig.scheduler.checkNow()
        let rec = await rig.scheduler.runNow(routineID: r.id)
        XCTAssertNil(rec)
        XCTAssertEqual(rig.runner.calls.count, 0)
        XCTAssertEqual(store.history(), [])
        XCTAssertEqual(safari.calls, 0)
        rig.scheduler.start()    // 다시 켜면 다시 일한다
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 1)
        rig.scheduler.stop()
    }

    @MainActor
    func testStopDuringBusyWaitEndsWithoutRecord() async throws {
        try addRoutine()
        let rig = makeRig(now: nine)
        rig.runner.busy = true
        rig.sleeps.onSleep = { n in if n == 2 { rig.scheduler.stop() } }
        await rig.scheduler.checkNow()
        XCTAssertEqual(rig.runner.calls.count, 0)
        XCTAssertEqual(store.history(), [])
    }

    // MARK: 돌기 전 확인(순수)

    func testPreflightOrderAndTexts() {
        let s = FakeSafariCheck(), a = FakeAutomationCheck()
        let p = RoutinePreflight(safari: s, automation: a)
        XCTAssertEqual(p.check(), .ok)
        s.running = false
        XCTAssertEqual(p.check(), .skip(reason: "사파리가 켜져 있지 않아 건너뛰었어요"))
        s.running = true
        a.status = OSStatus(-1743)
        XCTAssertEqual(p.check(), .skip(reason: "사파리 제어 허락이 아직 없어요 — 맥 앞에서 일 맡기기를 한 번 써 주세요"))
        XCTAssertTrue(a.askArguments.allSatisfy { $0 == false })
    }
}
