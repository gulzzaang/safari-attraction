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
    private func fire(_ s: RoutineSchedule, after: Date, lastRun: Date? = nil, createdAt: Date = Date(timeIntervalSince1970: 0), _ c: Calendar) -> Date {
        s.nextFire(after: after, lastRun: lastRun, createdAt: createdAt, calendar: c)
    }

    // 매일

    func testDailyBeforeAndAfterTodaysTime() {
        let c = cal()
        let s = RoutineSchedule.daily(hour: 9, minute: 0)
        XCTAssertEqual(fire(s, after: date(c, 2026, 11, 24, 8, 59), c), date(c, 2026, 11, 24, 9, 0))
        XCTAssertEqual(fire(s, after: date(c, 2026, 11, 24, 9, 1), c), date(c, 2026, 11, 25, 9, 0))
    }

    func testDailyExactlyAtTimeMovesToNextDay() {
        let c = cal()
        let s = RoutineSchedule.daily(hour: 9, minute: 0)
        XCTAssertEqual(fire(s, after: date(c, 2026, 11, 24, 9, 0), c), date(c, 2026, 11, 25, 9, 0))
    }

    func testDailyAcrossMonthAndYearEnd() {
        let c = cal()
        let s = RoutineSchedule.daily(hour: 23, minute: 30)
        XCTAssertEqual(fire(s, after: date(c, 2026, 12, 31, 23, 45), c), date(c, 2027, 1, 1, 23, 30))
    }

    func testDailyCatchUpFromCreatedAtGivesTodaysSlotWhenCreatedBefore() {
        let c = cal()
        let created = date(c, 2026, 11, 24, 8, 0)
        let s = RoutineSchedule.daily(hour: 9, minute: 0)
        XCTAssertEqual(fire(s, after: created, createdAt: created, c), date(c, 2026, 11, 24, 9, 0))
        let createdLate = date(c, 2026, 11, 24, 10, 0)
        XCTAssertEqual(fire(s, after: createdLate, createdAt: createdLate, c), date(c, 2026, 11, 25, 9, 0))
    }

    // 요일

    func testWeekdaysMondayAndWednesdayOnly() {
        let c = cal()
        let s = RoutineSchedule.weekdays([2, 4], hour: 9, minute: 30)   // 월 · 수
        // 2026-11-24 는 화요일
        XCTAssertEqual(c.component(.weekday, from: date(c, 2026, 11, 24, 12, 0)), 3)
        XCTAssertEqual(fire(s, after: date(c, 2026, 11, 24, 12, 0), c), date(c, 2026, 11, 25, 9, 30))   // 수
        XCTAssertEqual(fire(s, after: date(c, 2026, 11, 25, 9, 31), c), date(c, 2026, 11, 30, 9, 30))   // 다음 월
        XCTAssertEqual(fire(s, after: date(c, 2026, 11, 30, 9, 29), c), date(c, 2026, 11, 30, 9, 30))   // 월 오전, 아직
        XCTAssertEqual(fire(s, after: date(c, 2026, 11, 30, 9, 30), c), date(c, 2026, 12, 2, 9, 30))    // 정각이면 다음 수
    }

    func testWeekdaysSundayIsOne() {
        let c = cal()
        let s = RoutineSchedule.weekdays([1], hour: 7, minute: 0)
        let next = fire(s, after: date(c, 2026, 11, 24, 12, 0), c)
        XCTAssertEqual(next, date(c, 2026, 11, 29, 7, 0))
        XCTAssertEqual(c.component(.weekday, from: next), 1)
    }

    func testWeekdaysEmptyOrInvalidNeverFires() {
        let c = cal()
        XCTAssertEqual(fire(.weekdays([], hour: 9, minute: 0), after: Date(), c), .distantFuture)
        XCTAssertEqual(fire(.weekdays([0, 8], hour: 9, minute: 0), after: Date(), c), .distantFuture)
    }

    // N시간

    func testEveryHoursFromLastRunElseCreatedAt() {
        let c = cal()
        let created = date(c, 2026, 11, 24, 8, 0)
        let last = date(c, 2026, 11, 24, 10, 15)
        let s = RoutineSchedule.everyHours(3)
        XCTAssertEqual(fire(s, after: created, lastRun: nil, createdAt: created, c), date(c, 2026, 11, 24, 11, 0))
        XCTAssertEqual(fire(s, after: last, lastRun: last, createdAt: created, c), date(c, 2026, 11, 24, 13, 15))
    }

    func testEveryHoursReturnsAnOverdueTimeAsIs() {
        let c = cal()
        let created = date(c, 2026, 11, 24, 8, 0)
        let now = date(c, 2026, 11, 24, 20, 0)
        XCTAssertEqual(fire(.everyHours(2), after: now, createdAt: created, c), date(c, 2026, 11, 24, 10, 0))
    }

    func testEveryHoursIsClampedTo1Through24() {
        let c = cal()
        let t = date(c, 2026, 11, 24, 8, 0)
        XCTAssertEqual(fire(.everyHours(0), after: t, createdAt: t, c), date(c, 2026, 11, 24, 9, 0))
        XCTAssertEqual(fire(.everyHours(99), after: t, createdAt: t, c), date(c, 2026, 11, 25, 8, 0))
    }

    // 여름시간 (America/New_York — 2026-03-08 02:00 → 03:00 건너뜀, 2026-11-01 02:00 → 01:00 되돌림)

    func testDailyKeepsWallClockAcrossSpringForward() {
        let c = cal("America/New_York")
        let s = RoutineSchedule.daily(hour: 9, minute: 0)
        let before = date(c, 2026, 3, 7, 10, 0)
        let next = fire(s, after: before, c)
        XCTAssertEqual(next, date(c, 2026, 3, 8, 9, 0))
        XCTAssertEqual(next.timeIntervalSince(before), 22 * 3600, "그날은 23시간이 아니라 벽시계 기준 9시(EDT)")
        XCTAssertEqual(fire(s, after: next, c), date(c, 2026, 3, 9, 9, 0))
    }

    func testDailyAtANonexistentTimeMovesToJustAfter() {
        let c = cal("America/New_York")
        let s = RoutineSchedule.daily(hour: 2, minute: 30)   // 3월 8일에는 2:30 이 없다
        let next = fire(s, after: date(c, 2026, 3, 8, 0, 0), c)
        XCTAssertEqual(c.component(.day, from: next), 8)
        XCTAssertEqual(c.component(.hour, from: next), 3)
        XCTAssertEqual(c.component(.minute, from: next), 0, "없는 시각은 바로 뒤 첫 시각(3:00)으로")
        XCTAssertEqual(fire(s, after: next, c), date(c, 2026, 3, 9, 2, 30))
    }

    func testDailyAtARepeatedTimeFiresOncePerDay() {
        let c = cal("America/New_York")
        let s = RoutineSchedule.daily(hour: 1, minute: 30)   // 11월 1일에는 1:30 이 두 번
        let first = fire(s, after: date(c, 2026, 11, 1, 0, 0), c)
        let second = fire(s, after: first, c)
        XCTAssertEqual(c.component(.day, from: first), 1)
        XCTAssertEqual(second, date(c, 2026, 11, 2, 1, 30), "되돌림 날 1:30 이 두 번 도는 일은 없다")
    }

    func testEveryHoursIsAbsoluteAcrossDst() {
        let c = cal("America/New_York")
        let base = date(c, 2026, 3, 8, 0, 0)   // EST
        let next = fire(.everyHours(3), after: base, lastRun: base, c)
        XCTAssertEqual(next.timeIntervalSince(base), 3 * 3600)
    }

    func testWeekdaysAcrossDst() {
        let c = cal("America/New_York")
        let s = RoutineSchedule.weekdays([1], hour: 8, minute: 0)   // 일요일 8시
        let next = fire(s, after: date(c, 2026, 3, 7, 12, 0), c)    // 3월 8일 일요일 = 여름시간 바뀌는 날
        XCTAssertEqual(next, date(c, 2026, 3, 8, 8, 0))
    }

    // 지나침 규칙

    func testDueActionSixtyMinuteRule() {
        let scheduled = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(dueAction(now: scheduled, scheduled: scheduled), .run)
        XCTAssertEqual(dueAction(now: scheduled.addingTimeInterval(59 * 60), scheduled: scheduled), .run)
        XCTAssertEqual(dueAction(now: scheduled.addingTimeInterval(60 * 60), scheduled: scheduled), .run, "60분 정각까지는 돈다")
        XCTAssertEqual(dueAction(now: scheduled.addingTimeInterval(61 * 60), scheduled: scheduled), .skipMissed)
        XCTAssertEqual(dueAction(now: scheduled.addingTimeInterval(24 * 3600), scheduled: scheduled), .skipMissed)
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
