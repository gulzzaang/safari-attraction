import AppKit
import Carbon.HIToolbox

/// 전역 단축키(앱이 뒤에 있어도 눌린다) — Carbon `RegisterEventHotKey`. 손쉬운 사용 권한이 필요 없다.
@MainActor
final class HotKey {
    /// 열기 · 닫기: ⌥⌘Space.
    static let toggleKeyCode = UInt32(kVK_Space)
    static let toggleModifiers = UInt32(cmdKey | optionKey)

    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private let action: @MainActor () -> Void
    /// 등록이 안 됐으면(다른 앱 · 시스템이 같은 조합을 쓰는 중 등) 그 상태 코드.
    private(set) var registrationError: OSStatus?

    init(keyCode: UInt32, modifiers: UInt32, action: @escaping @MainActor () -> Void) {
        self.action = action

        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        var handler: EventHandlerRef?
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
            guard let userData else { return OSStatus(eventNotHandledErr) }
            let hotKey = Unmanaged<HotKey>.fromOpaque(userData).takeUnretainedValue()
            // 응용 프로그램 이벤트 대상은 메인 스레드에서 불린다.
            MainActor.assumeIsolated { hotKey.action() }
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), &handler)
        guard installed == noErr else { registrationError = installed; return }
        handlerRef = handler

        let id = EventHotKeyID(signature: OSType(0x53414154), id: 1) // 'SAAT'
        var ref: EventHotKeyRef?
        let registered = RegisterEventHotKey(keyCode, modifiers, id, GetApplicationEventTarget(), 0, &ref)
        if registered == noErr { hotKeyRef = ref } else { registrationError = registered }
    }

    func unregister() {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef); self.hotKeyRef = nil }
        if let handlerRef { RemoveEventHandler(handlerRef); self.handlerRef = nil }
    }
}
