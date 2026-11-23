import AppKit
import ApplicationServices
import AppCore

/// 사파리를 AppleScript 로 읽는 다리 — **읽기 전용**: 사파리를 앞으로 가져오지 않고(`activate` 없음),
/// 탭 · 창을 열지 않고, 창을 움직이지 않는다. 사파리가 안 떠 있으면 켜지 않는다(떠 있는지부터 확인).
///
/// 스레드: NSAppleScript 는 전용 직렬 큐 하나에서만 만들고 돌린다. 한 번에 한 호출만 — 이전 호출이 아직
/// 안 끝났으면(허락 창이 떠서 막힘 등) 새 호출은 줄 서지 않고 바로 `timedOut` 으로 돌려준다.
/// 시간 상한: 스크립트 안 `with timeout of 1 seconds` + 바깥 기다림 1.6초.
/// **메인 스레드에서 부르지 말 것.**
final class AppleScriptSafariBridge: SafariBridging, @unchecked Sendable {
    static let bundleID = "com.apple.Safari"
    private let runner = ScriptRunner()

    func isSafariRunning() -> Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleID).isEmpty
    }

    func isFrontmost() -> Bool {
        NSWorkspace.shared.frontmostApplication?.bundleIdentifier == Self.bundleID
    }

    func frontWindowBounds() -> CGRect? {
        guard isSafariRunning() else { return nil }
        let r = runner.run(Self.boundsScript) { d -> [Double]? in
            guard d.numberOfItems == 4 else { return nil }
            return (1...4).map { Double(d.atIndex($0)?.int32Value ?? 0) }
        }
        guard case .success(let list) = r, let list else { return nil }
        return ScreenCoordinates.rect(appleScriptBounds: list)
    }

    func frontTab() -> Result<TabReading, SafariBridgeError> {
        guard isSafariRunning() else { return .failure(.notRunning) }
        let tab = runner.run(Self.tabScript) { d -> (String, String)? in
            guard d.numberOfItems == 2 else { return nil }
            return (d.atIndex(1)?.stringValue ?? "", d.atIndex(2)?.stringValue ?? "")
        }
        let title: String, url: String
        switch tab {
        case .failure(let f): return .failure(SafariBridgeError.classify(number: f.number, message: f.message))
        case .success(let t):
            guard let t else { return .failure(.failed(number: 0, message: "탭 정보를 읽지 못함")) }
            (title, url) = t
        }
        // 고른 글: 실패해도 제목 · 주소는 돌려준다(빈 글). 이유가 허락 없음 · JS 꺼짐이면 함께 알린다.
        let sel = runner.run(Self.selectionScript) { $0.stringValue ?? "" }
        var selection: String?
        var issue: SafariBridgeError?
        switch sel {
        case .success(let s): selection = s.isEmpty ? nil : s
        case .failure(let f):
            let e = SafariBridgeError.classify(number: f.number, message: f.message, whileRunningJavaScript: true)
            if e == .javaScriptDisabled || e == .automationDenied { issue = e }
        }
        return .success(TabReading(page: PageContext(title: title, url: url, selection: selection), selectionIssue: issue))
    }

    /// 자동화 허락 상태를 **창을 띄우지 않고** 본다(`askUser: false`). 0 = 허락됨, -1744 = 물어봐야 함(아직 안 정함),
    /// -1743 = 거부됨, -600 = 사파리 꺼짐. 사파리가 꺼져 있으면 -600 을 돌려줄 뿐 켜지 않는다.
    func automationStatus(askUser: Bool = false) -> OSStatus {
        guard isSafariRunning() else { return OSStatus(procNotFound) }
        var addr = AEAddressDesc()
        let id = Self.bundleID
        let made = id.withCString { AECreateDesc(DescType(typeApplicationBundleID), $0, strlen($0), &addr) }
        guard made == noErr else { return OSStatus(made) }
        defer { AEDisposeDesc(&addr) }
        return AEDeterminePermissionToAutomateTarget(&addr, AEEventClass(typeWildCard), AEEventID(typeWildCard), askUser)
    }

    // MARK: 스크립트(둘 다 「떠 있을 때만」, 1초 시간 상한)

    private static let boundsScript = """
    if application id "com.apple.Safari" is running then
        tell application id "com.apple.Safari"
            with timeout of 1 seconds
                return bounds of front window
            end timeout
        end tell
    else
        error "Safari is not running" number -600
    end if
    """

    private static let tabScript = """
    if application id "com.apple.Safari" is running then
        tell application id "com.apple.Safari"
            with timeout of 1 seconds
                set t to current tab of front window
                return {name of t, URL of t}
            end timeout
        end tell
    else
        error "Safari is not running" number -600
    end if
    """

    private static let selectionScript = """
    if application id "com.apple.Safari" is running then
        tell application id "com.apple.Safari"
            with timeout of 1 seconds
                return (do JavaScript "(window.getSelection ? window.getSelection().toString() : '').slice(0, 4000)" in current tab of front window)
            end timeout
        end tell
    else
        error "Safari is not running" number -600
    end if
    """
}

struct ScriptFailure: Error, Sendable { var number: Int; var message: String }

/// NSAppleScript 를 직렬 큐 하나에서만 돌리고, 바깥 기다림에 시간 상한을 둔다.
final class ScriptRunner: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.gulzzaang.SafariAttractionApp.applescript")
    private let lock = NSLock()
    private var busy = false
    private var compiled: [String: NSAppleScript] = [:]   // queue 안에서만 접근

    private final class Box<T: Sendable>: @unchecked Sendable {
        private let lock = NSLock()
        private var value: Result<T, ScriptFailure>?
        func set(_ v: Result<T, ScriptFailure>) { lock.withLock { value = v } }
        func get() -> Result<T, ScriptFailure>? { lock.withLock { value } }
    }

    func run<T: Sendable>(_ source: String, backstop: TimeInterval = 1.6,
                          parse: @escaping @Sendable (NSAppleEventDescriptor) -> T) -> Result<T, ScriptFailure> {
        let timedOut = ScriptFailure(number: -1712, message: "AppleScript 시간 초과")
        let gotSlot: Bool = lock.withLock { if busy { return false }; busy = true; return true }
        guard gotSlot else { return .failure(timedOut) }

        let box = Box<T>()
        let sem = DispatchSemaphore(value: 0)
        queue.async { [self] in
            box.set(execute(source, parse: parse))
            lock.withLock { busy = false }
            sem.signal()
        }
        if sem.wait(timeout: .now() + backstop) == .timedOut { return .failure(timedOut) }
        return box.get() ?? .failure(timedOut)
    }

    private func execute<T: Sendable>(_ source: String, parse: (NSAppleEventDescriptor) -> T) -> Result<T, ScriptFailure> {
        let script: NSAppleScript
        if let s = compiled[source] { script = s } else {
            guard let s = NSAppleScript(source: source) else { return .failure(ScriptFailure(number: 0, message: "스크립트를 만들지 못함")) }
            compiled[source] = s; script = s
        }
        var err: NSDictionary?
        let desc = script.executeAndReturnError(&err)
        if let err {
            let n = (err["NSAppleScriptErrorNumber"] as? Int) ?? 0
            let m = (err["NSAppleScriptErrorMessage"] as? String) ?? ""
            return .failure(ScriptFailure(number: n, message: m))
        }
        return .success(parse(desc))
    }
}
