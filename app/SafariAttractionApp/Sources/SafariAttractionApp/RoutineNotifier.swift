import AppCore
import Foundation
import UserNotifications

/// 「끝나면 알림」 을 켰는지 — 이 앱 자신의 설정 도메인에 한 칸만 적는다.
final class DefaultsNotifyPreference: NotifyPreferenceStoring {
    private static let key = "RoutineNotifyOnFinish"
    var isOn: Bool {
        get { UserDefaults.standard.bool(forKey: Self.key) }
        set { UserDefaults.standard.set(newValue, forKey: Self.key) }
    }
}

/// 맥 알림 — `requestAuthorization` 은 사람이 「끝나면 알림」 을 켤 때(`RoutineHub.setNotify(true)`)만 부른다.
/// 앱을 켤 때 · 루틴이 끝날 때는 허락을 묻지 않고, 허락이 없으면 `deliver` 는 아무것도 하지 않는다(기록만 남는다).
final class SystemRoutineNotifier: RoutineNotifying, @unchecked Sendable {
    /// 앱이 앞에 있을 때도 알림이 뜨게 하는 받는 쪽. 처음 쓸 때만 단다(앱을 켤 때 달지 않는다).
    private final class Presenter: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
        func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
            [.banner, .sound]
        }
    }
    private static let presenter = Presenter()

    private var center: UNUserNotificationCenter? {
        guard Bundle.main.bundleIdentifier != nil else { return nil }   // 묶음 없이 돌 때(개발 실행)는 알림 센터가 없다
        let c = UNUserNotificationCenter.current()
        c.delegate = Self.presenter
        return c
    }

    func requestAuthorization() async -> Bool {
        guard let center else { return false }
        return (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
    }

    func deliver(title: String, body: String) {
        guard let center else { return }
        Task {
            let status = await center.notificationSettings().authorizationStatus
            guard status == .authorized || status == .provisional else { return }   // 허락이 없으면 묻지 않고 기록만
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            try? await center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }
}
