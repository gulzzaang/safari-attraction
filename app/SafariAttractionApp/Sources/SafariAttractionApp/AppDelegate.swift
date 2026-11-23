import AppKit
import AppCore
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var popover: NSPopover?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "safari", accessibilityDescription: "사파리-어트랙션")
        item.button?.toolTip = "사파리-어트랙션"

        let menu = NSMenu()
        let toggle = NSMenuItem(title: "패널 열기 · 닫기", action: #selector(togglePanel), keyEquivalent: "")
        toggle.target = self
        menu.addItem(toggle)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "종료", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        statusItem = item

        let pop = NSPopover()
        pop.behavior = .transient
        pop.contentViewController = NSHostingController(rootView: PlaceholderPanel())
        popover = pop
    }

    @objc private func togglePanel() {
        guard let popover, let button = statusItem?.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
    }

    @objc private func quitApp() {
        NSApplication.shared.terminate(nil)
    }
}

struct PlaceholderPanel: View {
    var body: some View {
        VStack(spacing: 8) {
            Text("사파리-어트랙션")
                .font(.headline)
            Text("옆 창은 아직 준비 중이에요.")
                .foregroundStyle(.secondary)
            Text("v\(AppCoreVersion.value)")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(20)
        .frame(width: 260)
    }
}
