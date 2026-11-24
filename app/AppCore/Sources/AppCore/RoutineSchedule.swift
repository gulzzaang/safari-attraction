import Foundation

/// 루틴을 언제 돌릴지. 요일은 `Calendar` 기준(1 = 일요일 … 7 = 토요일).
public enum RoutineSchedule: Codable, Equatable, Sendable {
    case daily(hour: Int, minute: Int)
    case weekdays(Set<Int>, hour: Int, minute: Int)
    case everyHours(Int)

    /// 다음에 돌 시각.
    /// - `daily` · `weekdays`: `after` 보다 **뒤**의 첫 해당 시각(정각이면 다음 날 · 다음 요일). 시간대 · 여름시간은 `calendar` 에 맡긴다
    ///   (없는 시각이면 바로 뒤 첫 시각으로 밀림 — 예: 2:30 이 없는 날은 3:00).
    ///   지나침을 따라잡을 때는 `after` 에 「마지막 실행 또는 만든 시각」, 화면에 보일 다음 시각은 `after` 에 지금을 넣는다.
    /// - `everyHours`: (`lastRun` 없으면 `createdAt`) + N시간(1…24 으로 맞춤). `after` 는 쓰지 않으며, 이미 지난 시각도 그대로 돌려줘 `dueAction` 이 판정한다.
    /// - 요일이 하나도 없는 `weekdays` 는 `Date.distantFuture`(돌지 않음).
    public func nextFire(after: Date, lastRun: Date?, createdAt: Date, calendar: Calendar) -> Date {
        switch self {
        case let .daily(hour, minute):
            return Self.next(after: after, calendar: calendar, hour: hour, minute: minute, weekday: nil) ?? .distantFuture
        case let .weekdays(days, hour, minute):
            let valid = days.filter { (1...7).contains($0) }
            let candidates = valid.compactMap { Self.next(after: after, calendar: calendar, hour: hour, minute: minute, weekday: $0) }
            return candidates.min() ?? .distantFuture
        case let .everyHours(n):
            let hours = min(24, max(1, n))
            let base = lastRun ?? createdAt
            return calendar.date(byAdding: .hour, value: hours, to: base) ?? base.addingTimeInterval(Double(hours) * 3600)
        }
    }

    private static func next(after: Date, calendar: Calendar, hour: Int, minute: Int, weekday: Int?) -> Date? {
        var comps = DateComponents(hour: min(23, max(0, hour)), minute: min(59, max(0, minute)), second: 0)
        comps.weekday = weekday
        return calendar.nextDate(after: after, matching: comps, matchingPolicy: .nextTime)
    }
}

/// 정해진 시각이 지난 뒤 어떻게 할지.
public enum DueAction: Equatable, Sendable {
    case run
    case skipMissed
}

/// 지나침 규칙 — 정해진 시각에서 60분 안(60분 정각 포함)이면 돌고, 넘으면 건너뛴다(잠자기 · 앱 꺼짐 뒤 몰려 도는 것을 막는다).
/// 늦은 정도만 본다 — 시각이 아직 안 됐는지(`scheduled` > `now`)는 부르는 쪽이 먼저 확인한다.
public let routineMissedLimit: TimeInterval = 60 * 60

public func dueAction(now: Date, scheduled: Date) -> DueAction {
    now.timeIntervalSince(scheduled) <= routineMissedLimit ? .run : .skipMissed
}
