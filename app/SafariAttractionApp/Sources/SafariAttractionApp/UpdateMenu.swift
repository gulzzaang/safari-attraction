import AppKit
import AppCore

/// 메뉴 막대 나침반 아이콘에 업데이트 알림 점을 겹친 템플릿 이미지를 만든다(밝은 모드 · 어두운 모드 공용).
enum UpdateStatusIcon {
    static func make(symbolName: String, hasUpdateDot: Bool, accessibilityDescription: String) -> NSImage? {
        guard let base = NSImage(systemSymbolName: symbolName, accessibilityDescription: accessibilityDescription) else {
            return nil
        }
        guard hasUpdateDot else {
            base.isTemplate = true
            return base
        }

        let size = NSSize(width: max(18, ceil(base.size.width)), height: max(18, ceil(base.size.height)))
        let composed = NSImage(size: size, flipped: false) { rect in
            let drawRect = NSRect(
                x: (rect.width - base.size.width) / 2,
                y: (rect.height - base.size.height) / 2,
                width: base.size.width,
                height: base.size.height
            )
            base.draw(in: drawRect, from: .zero, operation: .sourceOver, fraction: 1.0)

            let dotCenter = NSPoint(x: rect.width - 3.0, y: rect.height - 3.0)
            let haloRadius: CGFloat = 3.2
            let dotRadius: CGFloat = 2.1

            // 점 둘레를 살짝 비워 나침반 선과 겹쳐도 또렷하게 보이도록 한다.
            NSGraphicsContext.current?.cgContext.setBlendMode(.clear)
            NSBezierPath(ovalIn: NSRect(
                x: dotCenter.x - haloRadius,
                y: dotCenter.y - haloRadius,
                width: haloRadius * 2,
                height: haloRadius * 2
            )).fill()

            NSGraphicsContext.current?.cgContext.setBlendMode(.normal)
            NSColor.black.setFill()
            NSBezierPath(ovalIn: NSRect(
                x: dotCenter.x - dotRadius,
                y: dotCenter.y - dotRadius,
                width: dotRadius * 2,
                height: dotRadius * 2
            )).fill()
            return true
        }
        composed.isTemplate = true
        composed.accessibilityDescription = accessibilityDescription
        return composed
    }
}

/// 메뉴 막대 메뉴 안의 업데이트 항목(상단 새 버전 안내 · 하단 업데이트 확인)을 관리한다.
@MainActor
final class UpdateMenuController: NSObject {
    private let service: UpdateService
    private let onTerminateForUpdate: @MainActor () -> Void

    // 상단 안내 항목(새 버전이 있거나 설치 중일 때만 보인다)
    private let topTitleItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let installItem = NSMenuItem(title: UpdateMessages.updateNow, action: nil, keyEquivalent: "")
    private let notesItem = NSMenuItem(title: UpdateMessages.viewReleaseNotes, action: nil, keyEquivalent: "")
    private let topSeparator = NSMenuItem.separator()

    // 하단 상태 한 줄 · 「업데이트 확인…」 항목
    private let statusItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let checkItem = NSMenuItem(title: UpdateMessages.checkForUpdates, action: nil, keyEquivalent: "")
    private let bottomSeparator = NSMenuItem.separator()

    init(service: UpdateService, onTerminateForUpdate: @escaping @MainActor () -> Void) {
        self.service = service
        self.onTerminateForUpdate = onTerminateForUpdate
        super.init()

        topTitleItem.isEnabled = false
        installItem.target = self
        installItem.action = #selector(installUpdate)
        notesItem.target = self
        notesItem.action = #selector(openReleaseNotes)

        statusItem.isEnabled = false
        checkItem.target = self
        checkItem.action = #selector(checkForUpdates)
    }

    /// 메뉴 맨 위에 새 버전 안내 항목을 붙인다.
    func attachTopItems(to menu: NSMenu) {
        menu.addItem(topTitleItem)
        menu.addItem(installItem)
        menu.addItem(notesItem)
        menu.addItem(topSeparator)
    }

    /// 메뉴 아래쪽(「종료」 바로 위)에 결과 한 줄과 「업데이트 확인…」 항목을 붙인다.
    func attachBottomItems(to menu: NSMenu) {
        menu.addItem(statusItem)
        menu.addItem(checkItem)
        menu.addItem(bottomSeparator)
    }

    /// 현재 `UpdateService.state` 에 맞게 메뉴 항목의 문구 · 보임 · 활성 상태를 갱신한다.
    func refresh() {
        switch service.state {
        case .idle:
            topTitleItem.isHidden = true
            installItem.isHidden = true
            notesItem.isHidden = true
            topSeparator.isHidden = true

            statusItem.isHidden = true
            checkItem.title = UpdateMessages.checkForUpdates
            checkItem.isEnabled = true

        case .checking:
            topTitleItem.isHidden = true
            installItem.isHidden = true
            notesItem.isHidden = true
            topSeparator.isHidden = true

            statusItem.isHidden = true
            checkItem.title = UpdateMessages.checkForUpdates
            checkItem.isEnabled = false

        case .available(let release):
            topTitleItem.title = UpdateMessages.newVersionAvailable(release.version)
            topTitleItem.isHidden = false
            installItem.title = UpdateMessages.updateNow
            installItem.isHidden = false
            installItem.isEnabled = true
            notesItem.title = UpdateMessages.viewReleaseNotes
            notesItem.isHidden = false
            notesItem.isEnabled = true
            topSeparator.isHidden = false

            statusItem.isHidden = true
            checkItem.title = UpdateMessages.checkForUpdates
            checkItem.isEnabled = true

        case .upToDate(let version):
            topTitleItem.isHidden = true
            installItem.isHidden = true
            notesItem.isHidden = true
            topSeparator.isHidden = true

            statusItem.title = UpdateMessages.upToDate(version)
            statusItem.isHidden = false
            checkItem.title = UpdateMessages.checkForUpdates
            checkItem.isEnabled = true

        case .failed(let message):
            topTitleItem.isHidden = true
            installItem.isHidden = true
            notesItem.isHidden = true
            topSeparator.isHidden = true

            statusItem.title = message
            statusItem.isHidden = false
            checkItem.title = UpdateMessages.checkForUpdates
            checkItem.isEnabled = true

        case .installing:
            topTitleItem.title = UpdateMessages.installing
            topTitleItem.isHidden = false
            installItem.isHidden = true
            notesItem.isHidden = true
            topSeparator.isHidden = false

            statusItem.isHidden = true
            checkItem.title = UpdateMessages.checkForUpdates
            checkItem.isEnabled = false
        }
    }

    var hasAvailableUpdate: Bool {
        if case .available = service.state { return true }
        return false
    }

    @objc private func checkForUpdates() {
        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.service.checkNow(userInitiated: true)
            self.refresh()
        }
    }

    @objc private func installUpdate() {
        Task { @MainActor [weak self] in
            guard let self else { return }
            let result = await self.service.install()
            self.refresh()
            if case .success = result {
                self.onTerminateForUpdate()
            }
        }
    }

    @objc private func openReleaseNotes() {
        guard case .available(let release) = service.state else { return }
        NSWorkspace.shared.open(release.pageURL)
    }
}
