import XCTest
import AppCore

final class FakeBridge: SafariBridging, @unchecked Sendable {
    var running = true
    var frontmost = true
    var bounds: CGRect? = nil
    var boundsReads = 0
    var boundsError: SafariBridgeError = .noWindow
    var onBoundsRead: (@Sendable () -> Void)?
    var tab: Result<TabReading, SafariBridgeError> = .failure(.notRunning)
    var tabCalls = 0
    var tabCalledOnMain: Bool?
    func isSafariRunning() -> Bool { running }
    func isFrontmost() -> Bool { frontmost }
    func frontWindowBounds() -> Result<CGRect, SafariBridgeError> {
        boundsReads += 1
        onBoundsRead?()
        if let b = bounds { return .success(b) }
        return .failure(boundsError)
    }
    func frontTab() -> Result<TabReading, SafariBridgeError> {
        tabCalls += 1; tabCalledOnMain = Thread.isMainThread
        return tab
    }
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
        follower.setOpen(true)
        XCTAssertEqual(commands, [.show(defaultFrame)], "열자마자 기본 자리에 먼저 보인다")
        scheduler.tick()
        XCTAssertEqual(commands, [.show(defaultFrame), .show(placed)])
    }
    func testSetOpenFalseHidesImmediatelyAndStopsTheTimer() {
        bridge.bounds = safariBounds
        follower.start(); scheduler.tick()
        follower.setOpen(false)
        XCTAssertEqual(commands, [.show(placed), .hide], "틱을 기다리지 않고 바로 숨긴다")
        XCTAssertTrue(scheduler.cancelled, "닫혀 있는 동안 타이머를 멈춘다")
        let reads = bridge.boundsReads
        scheduler.tick(3)
        XCTAssertEqual(bridge.boundsReads, reads, "닫혀 있는 동안 사파리를 읽지 않는다")
    }
    func testSetOpenTrueRestartsTheTimerAndShowsLastFrameAtOnce() {
        bridge.bounds = safariBounds
        follower.start(); scheduler.tick()
        follower.setOpen(false)
        follower.setOpen(true)
        XCTAssertEqual(commands, [.show(placed), .hide, .show(placed)])
        XCTAssertFalse(scheduler.cancelled)
        XCTAssertNotNil(scheduler.fire, "다시 열면 타이머가 다시 돈다")
    }
    func testSetOpenTrueReemitsEvenIfAlreadyShown() {
        // 어딘가에서 창이 숨겨졌는데 따라가기는 「보이는 중」 이라고 기억하는 경우 — 열기가 다시 보이게 한다.
        bridge.bounds = safariBounds
        follower.start(); scheduler.tick()
        follower.setOpen(true)
        XCTAssertEqual(commands, [.show(placed), .show(placed)])
    }
    func testInvalidateMakesTheNextTickReemit() {
        bridge.bounds = safariBounds
        follower.start(); scheduler.tick(2)
        follower.invalidate()
        scheduler.tick()
        XCTAssertEqual(commands, [.show(placed), .show(placed)], "화면이 바뀐 뒤엔 같은 자리여도 다시 알린다")
    }
    func testStaleTickCannotShowAfterClose() {
        // 틱이 사파리를 읽는 동안 사용자가 닫으면, 그 틱이 닫힌 뒤에 보이게 하면 안 된다.
        bridge.bounds = safariBounds
        let f = follower!
        bridge.onBoundsRead = { f.setOpen(false) }
        follower.start(); scheduler.tick()
        XCTAssertEqual(commands, [], "닫힌 뒤엔 보이는 명령이 나가지 않는다")
    }
    // 사파리가 앞인 채 ⌥⌘Space 로 열면, 우리 앱이 앞으로 와서(activate) 첫 틱에는 사파리가 더는 앞이 아니다.
    // 그래도 열 때 한 번은 사파리 창 옆 자리를 읽어 붙어야 한다(기본 자리에 멈춰 있으면 안 된다).
    func testOpeningWithSafariFrontPlacesBesideSafariEvenAfterOwnAppActivates() {
        let g = geometry, r = rec!
        let f = PanelFollower(bridge: bridge, scheduler: scheduler, geometry: { g },
                              ownAppIsActive: { r.ownActive }, startsOpen: false, onCommand: { r.record($0) })
        bridge.bounds = safariBounds
        f.setOpen(true)                                   // 이때는 아직 사파리가 앞
        bridge.frontmost = false; rec.ownActive = true    // 우리 앱이 앞으로 왔다
        scheduler.tick()
        XCTAssertEqual(commands, [.show(defaultFrame), .show(placed)], "열 때 한 번 사파리 창 옆으로 붙는다")
        scheduler.tick(3)
        XCTAssertEqual(bridge.boundsReads, 1, "열 때 한 번만 읽는다 — 우리 앱이 앞인 동안 계속 읽지 않는다")
        XCTAssertEqual(commands, [.show(defaultFrame), .show(placed)])
        f.stop()
    }
    func testOpenPlacementReadHappensOnlyOncePerOpenEvenIfItFails() {
        let g = geometry, r = rec!
        let f = PanelFollower(bridge: bridge, scheduler: scheduler, geometry: { g },
                              ownAppIsActive: { r.ownActive }, startsOpen: false, onCommand: { r.record($0) })
        bridge.bounds = nil; bridge.boundsError = .noWindow
        f.setOpen(true)
        bridge.frontmost = false; rec.ownActive = true
        scheduler.tick(4)
        XCTAssertEqual(bridge.boundsReads, 1)
        XCTAssertEqual(commands, [.show(defaultFrame)])
        f.setOpen(false); f.setOpen(true)                 // 다시 열면 또 한 번
        scheduler.tick()
        XCTAssertEqual(bridge.boundsReads, 2)
        f.stop()
    }
    func testOpeningWithSafariNotRunningNeverReadsSafari() {
        let g = geometry, r = rec!
        let f = PanelFollower(bridge: bridge, scheduler: scheduler, geometry: { g },
                              ownAppIsActive: { r.ownActive }, startsOpen: false, onCommand: { r.record($0) })
        bridge.running = false; bridge.frontmost = false; rec.ownActive = true
        f.setOpen(true); scheduler.tick(2)
        XCTAssertEqual(bridge.boundsReads, 0)
        XCTAssertEqual(commands, [.show(defaultFrame)])
        f.stop()
    }
    func testJustOpenedPanelIsNotHiddenWhileAnotherAppStillFront() {
        let clock = TestClock()
        let g = geometry, r = rec!
        let f = PanelFollower(bridge: bridge, scheduler: scheduler, geometry: { g }, ownAppIsActive: { false },
                              startsOpen: false, now: { clock.date }, onCommand: { r.record($0) })
        bridge.frontmost = false          // 터미널 같은 다른 앱이 앞, 사파리는 뒤에서 돎
        f.setOpen(true)
        scheduler.tick()
        XCTAssertEqual(commands, [.show(defaultFrame)], "막 열었으면 잠깐은 숨기지 않는다")
        clock.advance(PanelFollower.openGrace + 0.1)
        scheduler.tick()
        XCTAssertEqual(commands, [.show(defaultFrame), .hide], "그 뒤에도 다른 앱이 앞이면 숨긴다")
        f.stop()
    }
    func testDeniedBoundsBacksOffThirtySeconds() {
        let clock = TestClock()
        let g = geometry, r = rec!
        let f = PanelFollower(bridge: bridge, scheduler: scheduler, geometry: { g }, ownAppIsActive: { false },
                              now: { clock.date }, onCommand: { r.record($0) })
        bridge.bounds = nil; bridge.boundsError = .automationDenied
        f.start(); scheduler.tick()
        XCTAssertEqual(bridge.boundsReads, 1)
        XCTAssertEqual(commands, [.show(defaultFrame)], "허락이 없으면 바로 기본 자리")
        scheduler.tick(20)   // 10초
        XCTAssertEqual(bridge.boundsReads, 1, "30초 동안은 다시 읽지 않는다")
        clock.advance(29); scheduler.tick()
        XCTAssertEqual(bridge.boundsReads, 1)
        clock.advance(2); scheduler.tick()
        XCTAssertEqual(bridge.boundsReads, 2, "30초가 지나면 한 번 더 시도")
        f.stop()
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

/// 시험용 시계 — 손으로 앞으로 돌린다.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var _date = Date(timeIntervalSince1970: 1_800_000_000)
    var date: Date { lock.withLock { _date } }
    func advance(_ seconds: TimeInterval) { lock.withLock { _date = _date.addingTimeInterval(seconds) } }
}
