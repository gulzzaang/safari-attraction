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

    /// 알림 본문은 늘 같은 안내 한 줄 — 제목에 루틴 이름과 상태가 있고, 클로드 답 · 읽은 내용은 알림(잠금 화면 · 알림 센터)에 싣지 않는다.
    public static func body(for record: RoutineRecord) -> String { "옆 창의 루틴 기록에서 볼 수 있어요" }
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
    /// 로그인 셸 PATH 를 미리 읽어 캐시해 두는 일(메인 밖에서 부른다). 사람 없는 시각의 첫 실행이 `zsh -lic` 를 처음 부르지 않게.
    @ObservationIgnored private let warmUpLoginPath: @Sendable () -> Void
    /// `shutdown()` 뒤에는 시계를 되살리거나 루틴을 돌리지 않는다.
    @ObservationIgnored private var isShutDown = false

    public init(store: RoutineStore, scheduler: RoutineScheduler, notifier: RoutineNotifying, preference: NotifyPreferenceStoring,
                clock: @escaping @MainActor () -> Date = { Date() },
                warmUpLoginPath: @escaping @Sendable () -> Void = {}) {
        self.warmUpLoginPath = warmUpLoginPath
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
        guard !isShutDown else { return }
        if hasEnabledRoutine { scheduler.start() } else { scheduler.stop() }
    }

    /// 앱을 켤 때 — 켜진 루틴이 있으면 시계를 시작한다(`start()` 가 곧바로 한 번 살피니 놓친 시각 처리도 여기서 된다). 알림 허락은 묻지 않는다.
    public func launch() { reconcile() }

    /// 잠에서 깰 때 — 켜진 루틴이 있을 때만 한 번 살핀다.
    public func handleWake() async {
        guard !isShutDown, hasEnabledRoutine else { return }
        await scheduler.checkNow()
    }

    /// 앱을 끝낼 때.
    public func shutdown() {
        isShutDown = true
        scheduler.stop()
    }

    /// 로그인 셸 PATH 를 메인 밖에서 읽어 둔다(이미 캐시돼 있으면 `ShellPath` 가 다시 읽지 않는다). 사람이 루틴을 켜거나 「지금 한 번」 을 누를 때만 부른다.
    private func warmUp() {
        let work = warmUpLoginPath
        Task.detached(priority: .utility) { work() }
    }

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
        let routineIDs = store.routines.filter { $0.taskID == id }.map(\.id)
        try store.removeSavedTask(id: id)
        routineIDs.forEach { scheduler.forgetAlertState(routineID: $0) }
    }

    // MARK: 루틴

    @discardableResult
    public func saveRoutine(_ routine: Routine) throws -> Routine {
        defer { revision += 1; reconcile() }
        let saved = try store.saveRoutine(routine, now: clock())
        if saved.enabled && !isShutDown { warmUp() }
        return saved
    }

    public func setEnabled(_ enabled: Bool, routineID: UUID) throws {
        guard var r = store.routine(id: routineID), r.enabled != enabled else { return }
        r.enabled = enabled
        try saveRoutine(r)
    }

    public func deleteRoutine(id: UUID) throws {
        defer { revision += 1; reconcile() }
        try store.removeRoutine(id: id)
        scheduler.forgetAlertState(routineID: id)
    }

    /// 「지금 한 번」 — 꺼진 루틴도 돌려 볼 수 있다. 시계가 꺼져 있으면(켜진 루틴이 없음) 잠깐 켰다가 끝나면 다시 맞춘다.
    @discardableResult
    public func runNow(routineID: UUID) async -> RoutineRecord? {
        guard !isShutDown else { return nil }
        warmUp()
        if !scheduler.isTicking { scheduler.start() }   // stop() 뒤엔 runNow 가 아무것도 안 하므로 먼저 켠다(켜진 루틴이 없으니 살필 것은 없다)
        let record = await scheduler.runNow(routineID: routineID)
        revision += 1
        reconcile()
        return record
    }

    // MARK: 사이트 알림

    /// 같은 루틴이 알림으로 또 돌지 않는 시간 — `lastRun`(예약 · 「지금 한 번」 · 알림 어느 쪽이든 실제로 돈 시각)에서 이만큼 지나야 한다.
    public static let alertCooldown: TimeInterval = 600

    /// 지켜볼 호스트 — 켜진 알림 루틴들의 host(루틴의 갈 수 있는 사이트 안에 드는 것만), 중복 없이 처음 나온 차례. 앱을 끝낸 뒤에는 비어 있다.
    public func alertHosts() -> [String] {
        guard !isShutDown else { return [] }
        var seen = Set<String>()
        var out: [String] = []
        for r in store.routines where r.enabled {
            guard let watch = r.schedule.alertWatch, SiteList.allows(host: watch.host, list: r.sites) else { continue }
            let host = SiteList.normalize(watch.host)
            if seen.insert(host).inserted { out.append(host) }
        }
        return out
    }

    /// 사파리 확장이 알아챈 사이트 알림 — 맞는 루틴을 사람 없이 **시작**하고 시작한 수를 돌려준다(루틴이 끝나기를 기다리지 않는다).
    /// 맞는 루틴: 켜져 있고 · 알림 호스트가 루틴 host 와 같거나 그 하위 도메인이고 · 키워드가 있으면 `제목 + " " + 내용` 에 대소문자 무시로 들어 있음.
    /// - 쿨다운: `lastRun` 이 `alertCooldown`(10분) 안이면 조용히 버린다(기록도 없음).
    /// - 한 번에 하나: 맞는 루틴이 여럿이어도 첫 하나만 돌고, 나머지는 바쁨 규칙대로 `건너뜀(다른 일이 도는 중이에요)` 기록(스케줄러가 같은 루틴의 건너뜀 기록은 10분에 한 줄로 줄인다).
    /// - 사파리 꺼짐 · 허락 없음 · 사이트 없음 · 다른 일이 도는 중 → `건너뜀(이유)` 기록(예약 루틴과 같은 돌기 전 확인, 기다리지 않음).
    /// - 일 글은 저장한 일 글 + 알림 머리(`SiteAlert.promptNote`). 시계의 `lastHandled` 는 건드리지 않는다.
    @discardableResult
    public func handleSiteAlert(host: String, kind: SiteAlert.Kind, title: String, body: String) async -> Int {
        guard !isShutDown else { return 0 }
        let alert = SiteAlert(host: host, kind: kind, title: title, body: body)
        let now = clock()
        var started = 0
        for r in store.routines where r.enabled {
            guard let watch = r.schedule.alertWatch, SiteList.allows(host: watch.host, list: r.sites),
                  alert.matches(routineHost: watch.host, keyword: watch.keyword) else { continue }
            if let last = r.lastRun, now.timeIntervalSince(last) < Self.alertCooldown { continue }
            if scheduler.startAlertRun(routineID: r.id, note: alert.promptNote) { started += 1 }
        }
        if started > 0 { revision += 1 }
        return started
    }

    /// 알림으로 시작한 루틴이 끝날 때까지 기다린다(시험용).
    public func waitForAlertRuns() async {
        await scheduler.waitForAlertRun()
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

/// 사파리 확장의 알림 길을 받는다 — 서버(`PanelServer`)는 이 닫힘으로만 허브에 닿는다.
extension RoutineHub: PanelAlertHandling {}
