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

    func frontWindowBounds() -> Result<CGRect, SafariBridgeError> {
        guard isSafariRunning() else { return .failure(.notRunning) }
        let r = runner.run(Self.boundsScript) { d -> [Double]? in
            guard d.numberOfItems == 4 else { return nil }
            return (1...4).map { Double(d.atIndex($0)?.int32Value ?? 0) }
        }
        switch r {
        case .failure(let f):
            return .failure(SafariBridgeError.classify(number: f.number, message: f.message))
        case .success(let list):
            guard let list, let rect = ScreenCoordinates.rect(appleScriptBounds: list) else { return .failure(.noWindow) }
            return .success(rect)
        }
    }

    /// 제목 · 주소 · 고른 글을 **스크립트 한 번**에 읽는다(두 번에 나눠 읽으면 그 사이 탭이 바뀔 수 있다).
    /// 고른 글(`do JavaScript`)만 실패하면 제목 · 주소는 그대로 주고 이유(JS 꺼짐 · 허락 없음)를 함께 돌려준다.
    func frontTab() -> Result<TabReading, SafariBridgeError> {
        guard isSafariRunning() else { return .failure(.notRunning) }
        let r = runner.run(Self.tabScript, backstop: 2.6) { d -> TabSnapshot? in
            guard d.numberOfItems == 5 else { return nil }
            return TabSnapshot(title: d.atIndex(1)?.stringValue ?? "", url: d.atIndex(2)?.stringValue ?? "",
                               selection: d.atIndex(3)?.stringValue ?? "",
                               jsErrorNumber: Int(d.atIndex(4)?.int32Value ?? 0), jsErrorMessage: d.atIndex(5)?.stringValue ?? "")
        }
        switch r {
        case .failure(let f):
            return .failure(SafariBridgeError.classify(number: f.number, message: f.message))
        case .success(let snap):
            guard let snap else { return .failure(.failed(number: 0, message: "탭 정보를 읽지 못함")) }
            var issue: SafariBridgeError?
            if snap.jsErrorNumber != 0 {
                let e = SafariBridgeError.classify(number: snap.jsErrorNumber, message: snap.jsErrorMessage, whileRunningJavaScript: true)
                if e == .javaScriptDisabled || e == .automationDenied { issue = e }
            }
            let page = PageContext(title: snap.title, url: snap.url, selection: snap.selection.isEmpty ? nil : snap.selection)
            return .success(TabReading(page: page, selectionIssue: issue))
        }
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

    /// 제목 · 주소 · 고른 글을 한 번에. 고른 글 읽기가 실패해도(JS 꺼짐 등) 오류는 안에서 받아 번호 · 문구로 돌려준다.
    private static let tabScript = """
    if application id "com.apple.Safari" is running then
        tell application id "com.apple.Safari"
            with timeout of 2 seconds
                set t to current tab of front window
                set tabTitle to name of t
                set tabURL to URL of t
                set tabSelection to ""
                set jsNumber to 0
                set jsMessage to ""
                try
                    set tabSelection to (do JavaScript "(window.getSelection ? window.getSelection().toString() : '').slice(0, 4000)" in t)
                on error errMessage number errNumber
                    set jsNumber to errNumber
                    set jsMessage to errMessage
                end try
                return {tabTitle, tabURL, tabSelection, jsNumber, jsMessage}
            end timeout
        end tell
    else
        error "Safari is not running" number -600
    end if
    """
}

struct TabSnapshot: Sendable {
    var title: String
    var url: String
    var selection: String
    var jsErrorNumber: Int
    var jsErrorMessage: String
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
