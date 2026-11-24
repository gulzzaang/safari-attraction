import Foundation

/// 루틴 편집 화면의 초안 값(아직 저장 전)과 `RoutineSchedule` 변환 · 사이트 목록 연동 순수 로직.
public struct RoutineDraft: Equatable, Sendable {
    public enum Kind: String, CaseIterable, Sendable {
        case daily
        case weekdays
        case everyHours
        case siteAlert
    }

    public static let siteAlertHint = "사파리에서 그 사이트 탭이 열려 있고 확장이 켜져 있을 때만 알아채요 — 탭 밖에서 오는 푸시 알림은 못 봐요"

    public var id: UUID?                  // nil 이면 새 루틴
    public var taskID: UUID?
    public var kind: Kind = .daily
    public var hour = 9
    public var minute = 0
    public var weekdays: Set<Int> = [2, 3, 4, 5, 6]   // 월~금
    public var hours = 6
    public var alertHost = ""
    public var alertKeyword = ""
    public var sites: [String] = []
    public var sitesEdited = false        // 사람이 목록을 손대면 일을 바꿔도 다시 뽑지 않는다
    public var enabled = true

    public init(taskID: UUID?, taskText: String?) {
        self.taskID = taskID
        if let taskText {
            self.sites = SiteList.extractHosts(from: taskText)
            self.alertHost = self.sites.first ?? ""
        }
    }

    public init(_ r: Routine) {
        id = r.id
        taskID = r.taskID
        sites = r.sites
        sitesEdited = true
        enabled = r.enabled
        switch r.schedule {
        case let .daily(h, m):
            kind = .daily
            hour = h
            minute = m
            alertHost = r.sites.first ?? ""
        case let .weekdays(d, h, m):
            kind = .weekdays
            weekdays = d
            hour = h
            minute = m
            alertHost = r.sites.first ?? ""
        case let .everyHours(n):
            kind = .everyHours
            hours = n
            alertHost = r.sites.first ?? ""
        case let .siteAlert(host, keyword):
            kind = .siteAlert
            alertHost = host
            alertKeyword = keyword ?? ""
        }
    }

    /// 초안 → 저장할 일정. `.siteAlert` 는 호스트를 소문자 · 공백 · 끝 점 없이 맞추고, 빈 키워드는 `nil` 로 만든다.
    public var schedule: RoutineSchedule {
        switch kind {
        case .daily: return .daily(hour: hour, minute: minute)
        case .weekdays: return .weekdays(weekdays, hour: hour, minute: minute)
        case .everyHours: return .everyHours(hours)
        case .siteAlert:
            let host = SiteList.normalize(alertHost)
            let trimmed = alertKeyword.trimmingCharacters(in: .whitespacesAndNewlines)
            return .siteAlert(host: host, keyword: trimmed.isEmpty ? nil : trimmed)
        }
    }

    /// 호스트 고르기 Picker 에 보여 줄 후보 목록 — 기본은 `sites`.
    /// 기존 알림 루틴의 `alertHost` 가 `sites` 항목의 하위 도메인(예: `mail.example.com` ⊂ `example.com`)이면
    /// 선택이 풀리지 않게 맨 앞에 넣는다.
    public var alertHostOptions: [String] {
        let host = SiteList.normalize(alertHost)
        guard !host.isEmpty, !sites.contains(host), SiteList.allows(host: host, list: sites) else {
            return sites
        }
        return [host] + sites
    }

    /// 저장 단추 활성화 여부(돌릴 일을 골랐고, 요일이면 요일이 하나 이상).
    public var canSave: Bool {
        guard taskID != nil else { return false }
        if kind == .weekdays, weekdays.isEmpty { return false }
        return true
    }

    /// 현재 `alertHost` 가 `sites` 안에 드는지(`SiteList.allows`).
    public var isAlertHostAllowed: Bool {
        SiteList.allows(host: alertHost, list: sites)
    }

    /// 종류를 바꾼다 — `.siteAlert` 로 바꿀 때 호스트가 비어 있거나 `sites` 밖이면 첫 사이트로 맞춘다.
    public mutating func setKind(_ next: Kind) {
        kind = next
        if next == .siteAlert {
            reconcileAlertHost()
        }
    }

    /// 새 루틴에서 돌릴 일을 바꿀 때(목록을 손대지 않았으면) 새 일 글에서 사이트를 다시 뽑는다.
    public mutating func applyTaskChange(taskID: UUID?, taskText: String?) {
        self.taskID = taskID
        if id == nil, !sitesEdited, let taskText {
            sites = SiteList.extractHosts(from: taskText)
            reconcileAlertHost()
        }
    }

    /// 갈 수 있는 사이트를 하나 추가한다(중복 제외). 알림 호스트가 비었거나 목록 밖이면 첫 사이트로 맞춘다.
    public mutating func addSite(_ host: String) {
        if !sites.contains(host) { sites.append(host) }
        sitesEdited = true
        reconcileAlertHost()
    }

    /// 갈 수 있는 사이트에서 하나를 뺀다. 알림 호스트가 남은 사이트 밖이면 첫 남은 사이트(없으면 빈 글)로 맞춘다.
    public mutating func removeSite(_ host: String) {
        sites.removeAll { $0 == host }
        sitesEdited = true
        reconcileAlertHost()
    }

    /// 저장한 일 글에서 사이트 목록을 다시 뽑는다.
    public mutating func resetSites(from taskText: String) {
        sites = SiteList.extractHosts(from: taskText)
        sitesEdited = false
        reconcileAlertHost()
    }

    /// `alertHost` 가 현재 `sites` 에서 허락되지 않으면 첫 사이트(없으면 빈 글)로 맞춘다.
    public mutating func reconcileAlertHost() {
        if !SiteList.allows(host: alertHost, list: sites) {
            alertHost = sites.first ?? ""
        }
    }

    /// 저장 오류를 화면에 보일 한국어 안내로 바꾼다.
    public static func saveErrorMessage(for error: Error) -> String {
        if let storeError = error as? RoutineStoreError, storeError == .alertHostOutsideSites {
            return storeError.errorDescription ?? "알림을 볼 사이트는 갈 수 있는 사이트 안에 있어야 해요"
        }
        return "저장하지 못했어요 — \(error.localizedDescription)"
    }
}
