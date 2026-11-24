import AppKit
import AppCore
import Carbon.HIToolbox

/// 전역 단축키 하나 — Carbon `RegisterEventHotKey`. 손쉬운 사용 권한이 필요 없다.
/// 등록 · 해제를 되풀이할 수 있다(⌘E 는 사파리가 앞일 때만 등록해 둔다).
@MainActor
final class HotKey {
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private let keyCode: UInt32
    private let modifiers: UInt32
    private let id: UInt32
    private let label: String
    private let action: @MainActor () -> Void
    /// 등록이 안 됐으면(다른 앱 · 시스템이 같은 조합을 쓰는 중 등) 그 상태 코드. 등록에 성공하거나 해제하면 nil.
    private(set) var registrationError: OSStatus?
    var isRegistered: Bool { hotKeyRef != nil }

    init(id: UInt32, keyCode: UInt32, modifiers: UInt32, label: String, action: @escaping @MainActor () -> Void) {
        self.id = id; self.keyCode = keyCode; self.modifiers = modifiers; self.label = label; self.action = action
    }

    private static let signature = OSType(0x53414154) // 'SAAT'

    func register() {
        guard hotKeyRef == nil else { return }
        if handlerRef == nil {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            var handler: EventHandlerRef?
            let installed = InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
                guard let userData, let event else { return OSStatus(eventNotHandledErr) }
                let hotKey = Unmanaged<HotKey>.fromOpaque(userData).takeUnretainedValue()
                var pressed = EventHotKeyID()
                let got = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                            nil, MemoryLayout<EventHotKeyID>.size, nil, &pressed)
                // 단축키가 둘 이상이라 처리기마다 자기 것인지 본다 — 남의 것이면 다음 처리기에 넘긴다.
                guard got == noErr, pressed.signature == HotKey.signature, pressed.id == hotKey.id else { return OSStatus(eventNotHandledErr) }
                // 응용 프로그램 이벤트 대상은 메인 스레드에서 불린다.
                MainActor.assumeIsolated { hotKey.action() }
                return noErr
            }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), &handler)
            guard installed == noErr else {
                registrationError = installed
                NSLog("사파리-어트랙션: 단축키 처리기를 달지 못함(상태 \(installed)) — 메뉴 막대로 열 수 있어요")
                return
            }
            handlerRef = handler
        }
        let hotKeyID = EventHotKeyID(signature: Self.signature, id: id)
        var ref: EventHotKeyRef?
        let registered = RegisterEventHotKey(keyCode, modifiers, hotKeyID, GetApplicationEventTarget(), 0, &ref)
        if registered == noErr {
            hotKeyRef = ref
            registrationError = nil
        } else {
            registrationError = registered
            NSLog("사파리-어트랙션: 전역 단축키 \(label) 등록 실패(상태 \(registered)) — 메뉴 막대로 열 수 있어요")
        }
    }

    /// 단축키를 푼다(처리기는 남겨 두어 다시 등록할 수 있다).
    func unregister() {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef); self.hotKeyRef = nil }
        registrationError = nil
    }

    /// 완전히 끝낼 때 — 단축키와 처리기를 모두 치운다.
    func shutdown() {
        unregister()
        if let handlerRef { RemoveEventHandler(handlerRef); self.handlerRef = nil }
    }
}

/// 열기 · 닫기 단축키 모음 — 키 · 조합 · 화면에 보이는 이름은 여기서만 바꾼다.
/// - ⌘E: **사파리(또는 이 앱)가 맨 앞일 때만** 등록한다(어사이드와 같은 방식). 다른 앱이 앞이면 풀어서 그 앱의 ⌘E 를 빼앗지 않는다.
/// - ⌥⇧S: 어느 앱이 앞이어도 되는 전역 예비.
@MainActor
final class HotKeys {
    static let primaryLabel = "⌘E"
    static let backupLabel = "⌥⇧S"
    /// 메뉴 · 도움말에 보이는 안내.
    static let toggleLabel = "⌘E(사파리가 앞일 때) · \(backupLabel)"

    private let commandE: HotKey
    private let backup: HotKey
    private let ownBundleID = Bundle.main.bundleIdentifier
    private var observer: NSObjectProtocol?

    init(action: @escaping @MainActor () -> Void) {
        commandE = HotKey(id: 1, keyCode: UInt32(kVK_ANSI_E), modifiers: UInt32(cmdKey), label: Self.primaryLabel, action: action)
        backup = HotKey(id: 2, keyCode: UInt32(kVK_ANSI_S), modifiers: UInt32(optionKey | shiftKey), label: Self.backupLabel, action: action)
    }

    func start() {
        backup.register()
        applyFrontmost(NSWorkspace.shared.frontmostApplication?.bundleIdentifier)
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            let id = app?.bundleIdentifier
            Task { @MainActor in self?.applyFrontmost(id) }
        }
    }

    private func applyFrontmost(_ bundleID: String?) {
        if HotKeyPolicy.shouldRegisterCommandE(frontmostBundleID: bundleID, ownBundleID: ownBundleID) {
            commandE.register()
        } else {
            commandE.unregister()
        }
    }

    /// 메뉴에 보일 한 줄 — 둘 다 못 쓰면 알린다.
    var statusSuffix: String {
        (backup.registrationError == nil && commandE.registrationError == nil) ? " (\(Self.toggleLabel))" : " (단축키 일부를 못 써요 — \(Self.toggleLabel))"
    }

    func shutdown() {
        if let observer { NSWorkspace.shared.notificationCenter.removeObserver(observer); self.observer = nil }
        commandE.shutdown()
        backup.shutdown()
    }
}
