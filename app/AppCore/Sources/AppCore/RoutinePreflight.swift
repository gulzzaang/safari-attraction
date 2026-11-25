import AppKit
import ApplicationServices
import Foundation

/// 사파리가 이미 떠 있는지 — 켜지 않고 보기만 한다.
public protocol SafariRunningChecking: Sendable {
    func isSafariRunning() -> Bool
}

/// 사파리 자동화(제어) 허락이 이미 있는지. `askUserIfNeeded` 를 받는 건 시험이 「물음 창을 띄우는 쪽으로는 한 번도 안 불렸다」 를 보려는 것 —
/// 돌기 전 확인은 **항상 false** 로만 부른다(허락 창이 뜨지 않게). 돌려주는 값은 `OSStatus`(`noErr` 만 허락 있음).
public protocol SafariAutomationChecking: Sendable {
    func permissionStatus(askUserIfNeeded: Bool) -> OSStatus
}

/// 실제 구현 — `NSRunningApplication`. 시험에서는 쓰지 않는다(가짜를 넣는다).
public struct SystemSafariRunningCheck: SafariRunningChecking {
    public static let bundleID = "com.apple.Safari"
    public init() {}
    public func isSafariRunning() -> Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleID).isEmpty
    }
}

/// 실제 구현 — `AEDeterminePermissionToAutomateTarget`. 시험에서는 절대 부르지 않는다(가짜를 넣는다).
/// 앱이 부르는 쪽(`RoutinePreflight`)이 `askUserIfNeeded` 로 false 만 넘긴다.
public struct SystemSafariAutomationCheck: SafariAutomationChecking {
    public init() {}
    public func permissionStatus(askUserIfNeeded: Bool) -> OSStatus {
        var target = AEAddressDesc()
        let bundle = Array(SystemSafariRunningCheck.bundleID.utf8)
        let created = bundle.withUnsafeBufferPointer { buf in
            AECreateDesc(DescType(typeApplicationBundleID), buf.baseAddress, buf.count, &target)
        }
        guard created == noErr else { return OSStatus(created) }
        defer { AEDisposeDesc(&target) }
        return AEDeterminePermissionToAutomateTarget(&target, AEEventClass(typeWildCard), AEEventID(typeWildCard), askUserIfNeeded)
    }
}

/// 루틴이 돌기 전 확인 ①② — 사람이 맥 앞에 없어도 허락 창이 뜨지 않는다. 순서: ① 사파리가 이미 떠 있음 ② 자동화 허락이 이미 있음.
/// (③ 다른 일이 도는 중이면 기다림 — `RoutineScheduler` 몫.)
public struct RoutinePreflight: Sendable {
    public enum Result: Equatable, Sendable {
        case ok
        /// 건너뛴다 — `reason` 은 `건너뜀(…)` 괄호 안 글.
        case skip(reason: String)
    }

    public static let safariNotRunningReason = "사파리가 켜져 있지 않아 건너뛰었어요"
    public static let automationMissingReason = "사파리 제어 허락이 아직 없어요 — 맥 앞에서 AI에게 사파리 일을 한 번 시켜 주세요"

    private let safari: SafariRunningChecking
    private let automation: SafariAutomationChecking

    public init(safari: SafariRunningChecking = SystemSafariRunningCheck(), automation: SafariAutomationChecking = SystemSafariAutomationCheck()) {
        self.safari = safari
        self.automation = automation
    }

    public func check() -> Result {
        guard safari.isSafariRunning() else { return .skip(reason: Self.safariNotRunningReason) }   // ① 사파리를 켜지 않는다
        guard automation.permissionStatus(askUserIfNeeded: false) == noErr else { return .skip(reason: Self.automationMissingReason) }   // ② 허락 창 없이
        return .ok
    }
}
