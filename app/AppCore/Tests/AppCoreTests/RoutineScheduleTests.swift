import XCTest
@testable import AppCore

final class RoutineScheduleTests: XCTestCase {
    private func cal(_ tz: String = "Asia/Seoul") -> Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: tz)!
        return c
    }
    private func date(_ c: Calendar, _ y: Int, _ mo: Int, _ d: Int, _ h: Int, _ mi: Int, _ s: Int = 0) -> Date {
        c.date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi, second: s))!
    }
    private func decide(_ s: RoutineSchedule, now: Date, handled: Date? = nil, created: Date, _ c: Calendar) -> ScheduleDecision {
        s.decide(now: now, lastHandled: handled, createdAt: created, calendar: c)
    }

    // 매일

    func testDailyBeforeAndAfterTodaysTime() {
        let c = cal()
        let s = RoutineSchedule.daily(hour: 9, minute: 0)
        let created = date(c, 2026, 11, 24, 8, 0)
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 24, 8, 59), created: created, c), .notYet(next: date(c, 2026, 11, 24, 9, 0)))
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 24, 9, 0), created: created, c), .run(scheduled: date(c, 2026, 11, 24, 9, 0)))
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 24, 9, 1), created: created, c), .run(scheduled: date(c, 2026, 11, 24, 9, 0)))
    }

    func testDailyMissedSixtyMinuteRuleAt59And60And61() {
        let c = cal()
        let s = RoutineSchedule.daily(hour: 9, minute: 0)
        let created = date(c, 2026, 11, 24, 8, 0)
        let nine = date(c, 2026, 11, 24, 9, 0)
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 24, 9, 59), created: created, c), .run(scheduled: nine))
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 24, 10, 0), created: created, c), .run(scheduled: nine), "60분 정각까지는 돈다")
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 24, 10, 1), created: created, c), .skipMissed(scheduled: nine))
    }

    func testDailyHandledMovesOnToTomorrow() {
        let c = cal()
        let s = RoutineSchedule.daily(hour: 9, minute: 0)
        let created = date(c, 2026, 11, 20, 8, 0)
        let nine = date(c, 2026, 11, 24, 9, 0)
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 24, 9, 5), handled: nine, created: created, c), .notYet(next: date(c, 2026, 11, 25, 9, 0)))
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 25, 8, 59), handled: nine, created: created, c), .notYet(next: date(c, 2026, 11, 25, 9, 0)))
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 25, 9, 1), handled: nine, created: created, c), .run(scheduled: date(c, 2026, 11, 25, 9, 0)))
    }

    func testCreatedAfterTodaysSlotWaitsForTomorrow() {
        let c = cal()
        let s = RoutineSchedule.daily(hour: 9, minute: 0)
        let created = date(c, 2026, 11, 24, 10, 0)
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 24, 10, 30), created: created, c), .notYet(next: date(c, 2026, 11, 25, 9, 0)))
    }

    func testSlept2DaysWakesAt0920RunsTodaysSlotOnly() {
        let c = cal()
        let s = RoutineSchedule.daily(hour: 9, minute: 0)
        let handled = date(c, 2026, 11, 22, 9, 0)
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 24, 9, 20), handled: handled, created: handled, c), .run(scheduled: date(c, 2026, 11, 24, 9, 0)),
                       "지난 이틀 치가 몰려 돌지 않고 가장 최근 한 번만")
    }

    func testSlept2DaysWakesAt1100SkipsThenWaitsForTomorrow() {
        let c = cal()
        let s = RoutineSchedule.daily(hour: 9, minute: 0)
        let handled = date(c, 2026, 11, 22, 9, 0)
        let now = date(c, 2026, 11, 24, 11, 0)
        let d = decide(s, now: now, handled: handled, created: handled, c)
        XCTAssertEqual(d, .skipMissed(scheduled: date(c, 2026, 11, 24, 9, 0)))
        // 호출 쪽이 건너뛴 예정 시각을 저장하면 다시 건너뛰지 않고 내일을 기다린다.
        XCTAssertEqual(decide(s, now: now, handled: date(c, 2026, 11, 24, 9, 0), created: handled, c), .notYet(next: date(c, 2026, 11, 25, 9, 0)))
    }

    func testAYearAsleepStillGivesTheMostRecentSlotOnly() {
        let c = cal()
        let s = RoutineSchedule.daily(hour: 9, minute: 0)
        let handled = date(c, 2025, 11, 24, 9, 0)
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 24, 9, 10), handled: handled, created: handled, c), .run(scheduled: date(c, 2026, 11, 24, 9, 0)))
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 24, 12, 0), handled: handled, created: handled, c), .skipMissed(scheduled: date(c, 2026, 11, 24, 9, 0)))
    }

    func testDailyAcrossMonthAndYearEnd() {
        let c = cal()
        let s = RoutineSchedule.daily(hour: 23, minute: 30)
        let created = date(c, 2026, 12, 31, 23, 45)
        XCTAssertEqual(decide(s, now: date(c, 2026, 12, 31, 23, 50), created: created, c), .notYet(next: date(c, 2027, 1, 1, 23, 30)))
    }

    // 요일

    func testWeekdaysMondayAndWednesdayOnly() {
        let c = cal()
        let s = RoutineSchedule.weekdays([2, 4], hour: 9, minute: 30)   // 월 · 수
        XCTAssertEqual(c.component(.weekday, from: date(c, 2026, 11, 24, 12, 0)), 3, "2026-11-24 는 화요일")
        let created = date(c, 2026, 11, 24, 12, 0)
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 24, 13, 0), created: created, c), .notYet(next: date(c, 2026, 11, 25, 9, 30)))   // 수
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 25, 9, 40), created: created, c), .run(scheduled: date(c, 2026, 11, 25, 9, 30)))
        let wed = date(c, 2026, 11, 25, 9, 30)
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 25, 9, 40), handled: wed, created: created, c), .notYet(next: date(c, 2026, 11, 30, 9, 30)))   // 다음 월
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 30, 9, 30), handled: wed, created: created, c), .run(scheduled: date(c, 2026, 11, 30, 9, 30)))
        let mon = date(c, 2026, 11, 30, 9, 30)
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 30, 9, 31), handled: mon, created: created, c), .notYet(next: date(c, 2026, 12, 2, 9, 30)))
    }

    func testWeekdaysCatchUpTakesOnlyTheMostRecentSlot() {
        let c = cal()
        let s = RoutineSchedule.weekdays([2, 4], hour: 9, minute: 30)
        let handled = date(c, 2026, 11, 18, 9, 30)   // 지난 수요일
        // 화요일 낮에 깸 → 가장 최근 칸은 월요일(11-23) 9:30, 60분 넘음
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 24, 12, 0), handled: handled, created: handled, c), .skipMissed(scheduled: date(c, 2026, 11, 23, 9, 30)))
        // 수요일 9:40 에 깸 → 오늘 칸 하나만 돈다
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 25, 9, 40), handled: handled, created: handled, c), .run(scheduled: date(c, 2026, 11, 25, 9, 30)))
    }

    func testWeekdaysSundayIsOne() {
        let c = cal()
        let s = RoutineSchedule.weekdays([1], hour: 7, minute: 0)
        let created = date(c, 2026, 11, 24, 12, 0)
        let d = decide(s, now: date(c, 2026, 11, 24, 13, 0), created: created, c)
        XCTAssertEqual(d, .notYet(next: date(c, 2026, 11, 29, 7, 0)))
        XCTAssertEqual(c.component(.weekday, from: date(c, 2026, 11, 29, 7, 0)), 1)
    }

    func testWeekdaysEmptyOrInvalidNeverFires() {
        let c = cal()
        let created = date(c, 2026, 11, 24, 12, 0)
        let now = date(c, 2026, 12, 24, 12, 0)
        XCTAssertEqual(decide(.weekdays([], hour: 9, minute: 0), now: now, created: created, c), .notYet(next: .distantFuture))
        XCTAssertEqual(decide(.weekdays([0, 8], hour: 9, minute: 0), now: now, created: created, c), .notYet(next: .distantFuture))
    }

    // N시간

    func testEveryHoursCountsFromHandledElseCreatedAt() {
        let c = cal()
        let s = RoutineSchedule.everyHours(3)
        let created = date(c, 2026, 11, 24, 8, 0)
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 24, 10, 59, 59), created: created, c), .notYet(next: date(c, 2026, 11, 24, 11, 0)))
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 24, 11, 0), created: created, c), .run(scheduled: date(c, 2026, 11, 24, 11, 0)))
        let handled = date(c, 2026, 11, 24, 11, 0)
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 24, 11, 5), handled: handled, created: created, c), .notYet(next: date(c, 2026, 11, 24, 14, 0)))
    }

    func testEveryHoursOffForTenHoursTakesOnlyTheMostRecentSlot() {
        let c = cal()
        let s = RoutineSchedule.everyHours(3)
        let handled = date(c, 2026, 11, 24, 8, 0)
        // 8:00 기준 칸: 11 · 14 · 17 · 20. 18:00 에 켬 → 가장 최근 칸은 17:00(1시간 늦음)
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 24, 18, 0), handled: handled, created: handled, c), .run(scheduled: date(c, 2026, 11, 24, 17, 0)))
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 24, 18, 1), handled: handled, created: handled, c), .skipMissed(scheduled: date(c, 2026, 11, 24, 17, 0)))
        // 건너뜀을 저장하면 다음 칸(20:00)을 기다린다.
        XCTAssertEqual(decide(s, now: date(c, 2026, 11, 24, 18, 1), handled: date(c, 2026, 11, 24, 17, 0), created: handled, c), .notYet(next: date(c, 2026, 11, 24, 20, 0)))
    }

    func testEveryHoursIsClampedTo1Through24() {
        let c = cal()
        let t = date(c, 2026, 11, 24, 8, 0)
        XCTAssertEqual(decide(.everyHours(0), now: date(c, 2026, 11, 24, 8, 30), created: t, c), .notYet(next: date(c, 2026, 11, 24, 9, 0)))
        XCTAssertEqual(decide(.everyHours(99), now: date(c, 2026, 11, 24, 8, 30), created: t, c), .notYet(next: date(c, 2026, 11, 25, 8, 0)))
    }

    // 다음 시각 보이기

    func testNextOccurrenceForDisplay() {
        let c = cal()
        let daily = RoutineSchedule.daily(hour: 9, minute: 0)
        XCTAssertEqual(daily.nextOccurrence(after: date(c, 2026, 11, 24, 8, 59), anchor: Date(timeIntervalSince1970: 0), calendar: c), date(c, 2026, 11, 24, 9, 0))
        XCTAssertEqual(daily.nextOccurrence(after: date(c, 2026, 11, 24, 9, 0), anchor: Date(timeIntervalSince1970: 0), calendar: c), date(c, 2026, 11, 25, 9, 0), "정각이면 다음 날")
        let every = RoutineSchedule.everyHours(3)
        let anchor = date(c, 2026, 11, 24, 8, 0)
        XCTAssertEqual(every.nextOccurrence(after: date(c, 2026, 11, 24, 18, 0), anchor: anchor, calendar: c), date(c, 2026, 11, 24, 20, 0))
        XCTAssertEqual(every.nextOccurrence(after: date(c, 2026, 11, 24, 17, 0), anchor: anchor, calendar: c), date(c, 2026, 11, 24, 20, 0))
        XCTAssertEqual(every.nextOccurrence(after: anchor.addingTimeInterval(-3600), anchor: anchor, calendar: c), date(c, 2026, 11, 24, 11, 0))
    }

    func testRoutineConvenienceUsesLastHandledElseCreatedAt() {
        let c = cal()
        let created = date(c, 2026, 11, 24, 8, 0)
        var r = Routine(taskID: UUID(), schedule: .everyHours(3), sites: ["a.com"], createdAt: created)
        XCTAssertEqual(r.decide(now: date(c, 2026, 11, 24, 9, 0), calendar: c), .notYet(next: date(c, 2026, 11, 24, 11, 0)))
        r.lastHandled = date(c, 2026, 11, 24, 11, 0)
        XCTAssertEqual(r.nextOccurrence(after: date(c, 2026, 11, 24, 12, 0), calendar: c), date(c, 2026, 11, 24, 14, 0))
    }

    // 여름시간 (America/New_York — 2026-03-08 02:00 → 03:00 건너뜀, 2026-11-01 02:00 → 01:00 되돌림)

    func testDailyKeepsWallClockAcrossSpringForward() {
        let c = cal("America/New_York")
        let s = RoutineSchedule.daily(hour: 9, minute: 0)
        let handled = date(c, 2026, 3, 7, 9, 0)
        let scheduled = date(c, 2026, 3, 8, 9, 0)
        XCTAssertEqual(scheduled.timeIntervalSince(handled), 23 * 3600, "그날은 24시간이 아니라 벽시계 기준 9시(EDT)")
        XCTAssertEqual(decide(s, now: date(c, 2026, 3, 8, 9, 10), handled: handled, created: handled, c), .run(scheduled: scheduled))
        XCTAssertEqual(decide(s, now: date(c, 2026, 3, 8, 9, 10), handled: scheduled, created: handled, c), .notYet(next: date(c, 2026, 3, 9, 9, 0)))
    }

    func testDailyAtANonexistentTimeMovesToJustAfter() {
        let c = cal("America/New_York")
        let s = RoutineSchedule.daily(hour: 2, minute: 30)   // 3월 8일에는 2:30 이 없다
        let handled = date(c, 2026, 3, 7, 2, 30)
        let d = decide(s, now: date(c, 2026, 3, 8, 3, 10), handled: handled, created: handled, c)
        guard case let .run(scheduled) = d else { return XCTFail("\(d)") }
        XCTAssertEqual(c.component(.day, from: scheduled), 8)
        XCTAssertEqual(c.component(.hour, from: scheduled), 3)
        XCTAssertEqual(c.component(.minute, from: scheduled), 0, "없는 시각은 바로 뒤 첫 시각(3:00)으로")
        XCTAssertEqual(decide(s, now: date(c, 2026, 3, 8, 3, 10), handled: scheduled, created: handled, c), .notYet(next: date(c, 2026, 3, 9, 2, 30)))
    }

    func testDailyAtARepeatedTimeFiresOncePerDay() {
        let c = cal("America/New_York")
        let s = RoutineSchedule.daily(hour: 1, minute: 30)   // 11월 1일에는 1:30 이 두 번
        let handled = date(c, 2026, 10, 31, 1, 30)
        let firstPass = s.nextOccurrence(after: handled, anchor: handled, calendar: c)
        XCTAssertEqual(c.component(.day, from: firstPass), 1)
        XCTAssertEqual(decide(s, now: firstPass.addingTimeInterval(600), handled: handled, created: handled, c), .run(scheduled: firstPass))
        // 되돌림 뒤 두 번째 1:30 대가 되어도, 이미 처리했으면 또 돌지 않고 다음 날을 기다린다.
        XCTAssertEqual(decide(s, now: firstPass.addingTimeInterval(3600 + 600), handled: firstPass, created: handled, c), .notYet(next: date(c, 2026, 11, 2, 1, 30)))
    }

    func testEveryHoursIsAbsoluteAcrossDst() {
        let c = cal("America/New_York")
        let base = date(c, 2026, 3, 8, 0, 0)   // EST, 이날 새벽 2시에 한 시간 건너뜀
        XCTAssertEqual(decide(.everyHours(3), now: base.addingTimeInterval(3 * 3600 + 60), handled: base, created: base, c), .run(scheduled: base.addingTimeInterval(3 * 3600)))
    }

    func testWeekdaysAcrossDst() {
        let c = cal("America/New_York")
        let s = RoutineSchedule.weekdays([1], hour: 8, minute: 0)   // 일요일 8시, 3월 8일 일요일 = 여름시간 바뀌는 날
        let created = date(c, 2026, 3, 7, 12, 0)
        XCTAssertEqual(decide(s, now: date(c, 2026, 3, 7, 13, 0), created: created, c), .notYet(next: date(c, 2026, 3, 8, 8, 0)))
        XCTAssertEqual(decide(s, now: date(c, 2026, 3, 8, 8, 5), created: created, c), .run(scheduled: date(c, 2026, 3, 8, 8, 0)))
    }

    // 저장 모양

    func testCodableRoundTripForEveryKind() throws {
        let all: [RoutineSchedule] = [.daily(hour: 9, minute: 5), .weekdays([2, 4], hour: 7, minute: 30), .everyHours(6)]
        for s in all {
            let data = try JSONEncoder().encode(s)
            XCTAssertEqual(try JSONDecoder().decode(RoutineSchedule.self, from: data), s)
        }
    }
}
