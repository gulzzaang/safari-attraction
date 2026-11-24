import Foundation

/// 루틴을 언제 돌릴지. 요일은 `Calendar` 기준(1 = 일요일 … 7 = 토요일).
public enum RoutineSchedule: Codable, Equatable, Sendable {
    case daily(hour: Int, minute: Int)
    case weekdays(Set<Int>, hour: Int, minute: Int)
    case everyHours(Int)
    /// 사이트 알림이 오면 — 시계로는 돌지 않는다(`decide` 는 늘 `.notYet(next: .distantFuture)`). 사파리 확장이 `host`(와 그 하위 도메인)의
    /// 알림을 알아채 앱에 알리면 `RoutineHub.handleSiteAlert` 가 돌린다. `keyword` 가 있으면 알림 제목 + 내용에 그 글이 있을 때만(대소문자 무시).
    case siteAlert(host: String, keyword: String?)

    /// 알림 루틴이면 지켜볼 호스트 · 키워드, 아니면 nil.
    public var alertWatch: (host: String, keyword: String?)? {
        if case let .siteAlert(host, keyword) = self { return (host, keyword) }
        return nil
    }

    /// 지금 무엇을 할지 — 한 곳에서 일정 · 지나침 규칙을 다 판단한다.
    ///
    /// 기준 = `lastHandled ?? createdAt`(돌렸거나 건너뛴 마지막 **예정 시각**, 없으면 만든 시각).
    /// 기준 뒤 ~ `now` 사이의 **가장 최근** 예정 시각 하나만 본다(잠자는 동안 여러 번 지나도 몰려 돌지 않는다).
    /// - 그런 시각이 없으면 `.notYet(next:)` — 기준 뒤 첫 예정 시각.
    /// - 있고 `now` 가 그 시각에서 60분 안(정각 포함)이면 `.run(scheduled:)`, 넘으면 `.skipMissed(scheduled:)`.
    /// 부르는 쪽은 `.run` · `.skipMissed` 둘 다 `lastHandled = scheduled` 로 저장해야 한다
    /// (그래야 몰려 돌지도, 영원히 건너뛰지도 않는다). 실제로 돈 시각 표시는 `lastRun` 이 따로 맡는다.
    public func decide(now: Date, lastHandled: Date?, createdAt: Date, calendar: Calendar) -> ScheduleDecision {
        if case .siteAlert = self { return .notYet(next: .distantFuture) }   // 시계 · 잠 깸 · 앱 켬으로는 돌지 않는다
        let base = lastHandled ?? createdAt
        let first = nextOccurrence(after: base, anchor: base, calendar: calendar)
        guard first <= now else { return .notYet(next: first) }
        let scheduled = latestOccurrence(atOrBefore: now, base: base, first: first, calendar: calendar)
        return now.timeIntervalSince(scheduled) <= routineMissedLimit ? .run(scheduled: scheduled) : .skipMissed(scheduled: scheduled)
    }

    /// `after` 보다 **뒤**의 첫 예정 시각(정각이면 다음). 화면에 보일 「다음 시각」 은 `after` 에 지금을 넣는다.
    /// - `daily` · `weekdays`: 달력 기준. 시간대 · 여름시간은 `calendar` 에 맡긴다(없는 시각이면 바로 뒤 첫 시각으로 밀림 — 예: 2:30 이 없는 날은 3:00).
    /// - `everyHours`: `anchor` + k × N시간(k ≥ 1, N 은 1…24 로 맞춤) 중 `after` 뒤 첫 칸.
    /// - 요일이 하나도 없는 `weekdays` · `siteAlert` 는 `Date.distantFuture`(시계로는 돌지 않음).
    public func nextOccurrence(after: Date, anchor: Date, calendar: Calendar) -> Date {
        switch self {
        case let .daily(hour, minute):
            return Self.next(after: after, calendar: calendar, hour: hour, minute: minute, weekday: nil) ?? .distantFuture
        case let .weekdays(days, hour, minute):
            let candidates = days.filter { (1...7).contains($0) }
                .compactMap { Self.next(after: after, calendar: calendar, hour: hour, minute: minute, weekday: $0) }
            return candidates.min() ?? .distantFuture
        case let .everyHours(n):
            let step = Self.step(n)
            let k = max(1, Int((after.timeIntervalSince(anchor) / step).rounded(.down)) + 1)
            return anchor.addingTimeInterval(Double(k) * step)
        case .siteAlert:
            return .distantFuture
        }
    }

    private func latestOccurrence(atOrBefore now: Date, base: Date, first: Date, calendar: Calendar) -> Date {
        switch self {
        case .everyHours(let n):
            let step = Self.step(n)
            let k = max(1, Int((now.timeIntervalSince(base) / step).rounded(.down)))
            return base.addingTimeInterval(Double(k) * step)
        case .siteAlert:
            return first
        case .daily, .weekdays:
            // 기준이 아주 옛날이어도 마지막 8일만 훑으면 가장 최근 칸을 찾는다(요일이 있으면 늦어도 7일 안에 한 번).
            var latest: Date?
            var cursor = max(base, now.addingTimeInterval(-8 * 24 * 3600))
            while true {
                let n = nextOccurrence(after: cursor, anchor: base, calendar: calendar)
                if n > now || n <= cursor { break }
                latest = n
                cursor = n
            }
            return latest ?? first
        }
    }

    private static func step(_ n: Int) -> TimeInterval { Double(min(24, max(1, n))) * 3600 }

    private static func next(after: Date, calendar: Calendar, hour: Int, minute: Int, weekday: Int?) -> Date? {
        var comps = DateComponents(hour: min(23, max(0, hour)), minute: min(59, max(0, minute)), second: 0)
        comps.weekday = weekday
        return calendar.nextDate(after: after, matching: comps, matchingPolicy: .nextTime)
    }
}

/// `RoutineSchedule.decide` 의 답.
public enum ScheduleDecision: Equatable, Sendable {
    /// 아직 때가 아님 — 다음 예정 시각.
    case notYet(next: Date)
    /// 지금 돈다 — 정해진 시각에서 60분 안.
    case run(scheduled: Date)
    /// 60분을 넘겨 건너뛴다.
    case skipMissed(scheduled: Date)
}

/// 지나침 규칙 — 정해진 시각에서 60분(정각 포함) 안이면 돈다.
public let routineMissedLimit: TimeInterval = 60 * 60

extension RoutineSchedule {
    private static let weekdayNames = ["일", "월", "화", "수", "목", "금", "토"]

    /// 화면에 보일 한 줄 — 「매일 09:00」 · 「매주 월 · 수 09:00」 · 「3시간마다」. 요일이 하나도 없으면 「요일을 고르지 않았어요」.
    public var summary: String {
        func clock(_ h: Int, _ m: Int) -> String {
            String(format: "%02d:%02d", min(23, max(0, h)), min(59, max(0, m)))
        }
        switch self {
        case let .daily(h, m):
            return "매일 \(clock(h, m))"
        case let .weekdays(days, h, m):
            let names = days.filter { (1...7).contains($0) }.sorted().map { Self.weekdayNames[$0 - 1] }
            guard !names.isEmpty else { return "요일을 고르지 않았어요" }
            return "매주 \(names.joined(separator: " · ")) \(clock(h, m))"
        case let .everyHours(n):
            return "\(min(24, max(1, n)))시간마다"
        case let .siteAlert(host, keyword):
            guard let keyword, !keyword.isEmpty else { return "\(host) 알림이 오면" }
            return "\(host) 알림에 ‘\(keyword)’ 가 있으면"
        }
    }
}
