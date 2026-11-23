import XCTest
import AppCore

final class FakeBridge: SafariBridging, @unchecked Sendable {
    var running = true
    var frontmost = true
    var bounds: CGRect? = nil
    var boundsReads = 0
    var tab: Result<TabReading, SafariBridgeError> = .failure(.notRunning)
    func isSafariRunning() -> Bool { running }
    func isFrontmost() -> Bool { frontmost }
    func frontWindowBounds() -> CGRect? { boundsReads += 1; return bounds }
    func frontTab() -> Result<TabReading, SafariBridgeError> { tab }
}

final class FakeScheduler: TickScheduling, @unchecked Sendable {
    var interval: TimeInterval?
    var fire: (@Sendable () -> Void)?
    var cancelled = false
    func every(_ interval: TimeInterval, _ fire: @escaping @Sendable () -> Void) -> TickCancelling {
        self.interval = interval; self.fire = fire; cancelled = false
        return Cancel { [weak self] in self?.cancelled = true; self?.fire = nil }
    }
    func tick(_ n: Int = 1) { for _ in 0..<n { fire?() } }
    struct Cancel: TickCancelling { let onCancel: @Sendable () -> Void; func cancel() { onCancel() } }
}

final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _commands: [PanelCommand] = []
    private var _ownActive = false
    var commands: [PanelCommand] { lock.withLock { _commands } }
    var ownActive: Bool { get { lock.withLock { _ownActive } } set { lock.withLock { _ownActive = newValue } } }
    func record(_ c: PanelCommand) { lock.withLock { _commands.append(c) } }
}

final class PanelFollowerTests: XCTestCase {
    // AppKit 좌표(왼쪽 아래 기준): 높이 1000 한 화면.
    let geometry = ScreenGeometry(primaryHeight: 1000, visibleFrames: [CGRect(x: 0, y: 0, width: 1920, height: 1000)])
    var bridge: FakeBridge!
    var scheduler: FakeScheduler!
    var rec: Recorder!
    var follower: PanelFollower!
    var commands: [PanelCommand] { rec.commands }

    override func setUp() {
        bridge = FakeBridge(); scheduler = FakeScheduler(); rec = Recorder()
        let g = geometry, r = rec!
        follower = PanelFollower(bridge: bridge, scheduler: scheduler, geometry: { g },
                                 ownAppIsActive: { r.ownActive }, onCommand: { r.record($0) })
    }

    // 사파리 왼쪽 위 기준 (100,50) 1000x900 → AppKit (100, 50) 1000x900 (1000-950=50) → 옆 창 x 1108.
    let safariBounds = CGRect(x: 100, y: 50, width: 1000, height: 900)
    let placed = CGRect(x: 1108, y: 50, width: 380, height: 900)
    let defaultFrame = CGRect(x: 1540, y: 0, width: 380, height: 1000)

    func testStartRunsEveryHalfSecond() {
        follower.start()
        XCTAssertEqual(scheduler.interval, 0.5)
        follower.stop()
        XCTAssertTrue(scheduler.cancelled)
    }
    func testSafariFrontmostPlacesBesideTheWindow() {
        bridge.bounds = safariBounds
        follower.start(); scheduler.tick()
        XCTAssertEqual(commands, [.show(placed)])
    }
    func testSameFrameIsNotEmittedAgain() {
        bridge.bounds = safariBounds
        follower.start(); scheduler.tick(3)
        XCTAssertEqual(commands, [.show(placed)])
    }
    func testFollowsWhenSafariMoves() {
        bridge.bounds = safariBounds
        follower.start(); scheduler.tick()
        bridge.bounds = CGRect(x: 200, y: 50, width: 1000, height: 900)
        scheduler.tick()
        XCTAssertEqual(commands, [.show(placed), .show(CGRect(x: 1208, y: 50, width: 380, height: 900))])
    }
    func testOtherAppFrontmostHidesAndDoesNotReadSafari() {
        bridge.bounds = safariBounds
        follower.start(); scheduler.tick()
        let reads = bridge.boundsReads
        bridge.frontmost = false
        scheduler.tick(4)
        XCTAssertEqual(commands, [.show(placed), .hide])
        XCTAssertEqual(bridge.boundsReads, reads, "사파리가 앞이 아니면 읽지 않는다")
    }
    func testPinnedStaysWhenOtherAppFrontmost() {
        bridge.bounds = safariBounds
        follower.start(); scheduler.tick()
        follower.setPinned(true)
        bridge.frontmost = false
        let reads = bridge.boundsReads
        scheduler.tick(3)
        XCTAssertEqual(commands, [.show(placed)])
        XCTAssertEqual(bridge.boundsReads, reads)
    }
    func testOwnAppFrontmostKeepsPanel() {
        bridge.bounds = safariBounds
        follower.start(); scheduler.tick()
        bridge.frontmost = false; rec.ownActive = true   // 사용자가 옆 창을 눌러 우리 앱이 앞
        scheduler.tick(3)
        XCTAssertEqual(commands, [.show(placed)])
    }
    func testBackToSafariShowsAgainAfterHide() {
        bridge.bounds = safariBounds
        follower.start(); scheduler.tick()
        bridge.frontmost = false; scheduler.tick()
        bridge.frontmost = true; scheduler.tick()
        XCTAssertEqual(commands, [.show(placed), .hide, .show(placed)])
    }
    func testSafariNotRunningUsesDefaultFrame() {
        bridge.running = false; bridge.frontmost = false
        follower.start(); scheduler.tick(2)
        XCTAssertEqual(commands, [.show(defaultFrame)])
        XCTAssertEqual(bridge.boundsReads, 0)
    }
    func testSafariFrontmostButNoBoundsUsesDefaultFrame() {
        bridge.bounds = nil
        follower.start(); scheduler.tick()
        XCTAssertEqual(commands, [.show(defaultFrame)])
    }
    func testOneFailedReadDoesNotYankPanelButRepeatedOnesDo() {
        bridge.bounds = safariBounds
        follower.start(); scheduler.tick()
        bridge.bounds = nil
        scheduler.tick(PanelFollower.failedReadsBeforeDefault - 1)
        XCTAssertEqual(commands, [.show(placed)])
        scheduler.tick()
        XCTAssertEqual(commands, [.show(placed), .show(defaultFrame)])
    }
    func testClosedPanelStaysHiddenAndQuiet() {
        bridge.bounds = safariBounds
        follower.setOpen(false)
        follower.start(); scheduler.tick(3)
        XCTAssertEqual(commands, [])
        XCTAssertEqual(bridge.boundsReads, 0)
        follower.setOpen(true); scheduler.tick()
        XCTAssertEqual(commands, [.show(placed)])
    }
    func testClosingWhileShownHidesOnce() {
        bridge.bounds = safariBounds
        follower.start(); scheduler.tick()
        follower.setOpen(false); scheduler.tick(2)
        XCTAssertEqual(commands, [.show(placed), .hide])
    }
    func testPlacementUsesPrimaryHeightFlipOnSecondScreenAbove() {
        // 주 화면 1440x900 + 위 보조 화면 1920x1080(AppKit y 900..1980).
        let g = ScreenGeometry(primaryHeight: 900, visibleFrames: [
            CGRect(x: 0, y: 0, width: 1440, height: 900), CGRect(x: 0, y: 900, width: 1920, height: 1080)])
        let r = rec!
        let f = PanelFollower(bridge: bridge, scheduler: scheduler, geometry: { g }, ownAppIsActive: { false },
                              onCommand: { r.record($0) })
        bridge.bounds = CGRect(x: 100, y: -1000, width: 900, height: 700) // 왼쪽 위 기준, 보조 화면 안
        f.start(); scheduler.tick()
        XCTAssertEqual(commands, [.show(CGRect(x: 1008, y: 1200, width: 380, height: 700))])
        f.stop()
    }
    func testPageAttachFailureGivesHintWithFakeBridge() {
        bridge.tab = .failure(.automationDenied)
        let a = PageAttachment.resolve(bridge.frontTab())
        XCTAssertTrue(a.turnOffToggle); XCTAssertNil(a.page); XCTAssertNotNil(a.hint)
    }
}
