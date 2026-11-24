import Foundation

/// 앱은 로그인 셸이 아니라서 PATH 가 짧다 — 사용자의 로그인 셸에서 PATH 를 한 번 읽어 캐시한다.
public enum ShellPath {
    static let marker = "__SAPATH__"
    private static let shared = LoginPathCache(resolver: {
        resolve(shell: "/bin/zsh", arguments: ["-lic", "printf '\(marker)%s\(marker)' \"$PATH\""], timeout: 8)
    })

    /// 로그인 셸(`/bin/zsh -lic`)의 PATH. 읽기에 성공하면 영구 캐시, 실패하면 `fallback()` 을 주되
    /// 30초 뒤 다음 호출에서 다시 읽어 본다. **처음 읽을 때 최대 8초 막힐 수 있으니 메인 스레드에서 부르지 말 것.**
    public static func loginPath() -> String { shared.path() }

    /// 셸이 안 되거나 느릴 때 쓰는 기본 PATH(`$HOME` 은 코드에서 펼친다).
    public static func fallback(home: String = NSHomeDirectory()) -> String {
        "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\(home)/.local/bin"
    }

    /// 셸을 한 번 돌려 표식 사이의 PATH 를 읽는다. 실패 · 시간 초과 · 표식 없음이면 nil.
    /// (.zshrc 가 소음을 찍어도 표식 사이만 읽으므로 상관없다.)
    public static func resolve(shell: String, arguments: [String], timeout: TimeInterval) -> String? {
        let box = OutputBox()
        let outcome = ProcessRunner().runBlocking(
            executable: shell, arguments: arguments, workDir: URL(fileURLWithPath: NSTemporaryDirectory()),
            path: "/usr/bin:/bin", timeout: timeout,
            onEvent: { if case .stdout(let d) = $0 { box.append(d) } })
        guard case .finished = outcome else { return nil }
        return parse(output: box.string)
    }

    public static func parse(output: String) -> String? {
        let parts = output.components(separatedBy: marker)
        guard parts.count >= 3 else { return nil }
        let p = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
        return p.isEmpty ? nil : p
    }

    private final class OutputBox: @unchecked Sendable {
        private let lock = NSLock()
        private var data = Data()
        func append(_ d: Data) { lock.withLock { data.append(d) } }
        var string: String { lock.withLock { String(decoding: data, as: UTF8.self) } }
    }
}

/// 로그인 PATH 읽기 결과 캐시 — 성공은 영구, 실패(fallback)는 `failureRetryInterval` 동안만.
public final class LoginPathCache: @unchecked Sendable {
    private let lock = NSLock()
    private let resolver: @Sendable () -> String?
    private let failureRetryInterval: TimeInterval
    private var value: String?
    private var fallbackSince: Date?

    public init(failureRetryInterval: TimeInterval = 30, resolver: @escaping @Sendable () -> String?) {
        self.failureRetryInterval = failureRetryInterval
        self.resolver = resolver
    }

    public func path(now: Date = Date()) -> String {
        lock.lock(); defer { lock.unlock() }
        if let v = value { return v }
        if let since = fallbackSince, now.timeIntervalSince(since) < failureRetryInterval { return ShellPath.fallback() }
        if let v = resolver() { value = v; fallbackSince = nil; return v }
        fallbackSince = now
        return ShellPath.fallback()
    }
}

public enum AppPaths {
    /// `~/Library/Application Support/SafariAttractionApp` — 앱 전용 폴더(없으면 만든다).
    public static func supportDirectory(applicationSupport: URL? = nil) throws -> URL {
        let base = try applicationSupport ?? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let dir = base.appendingPathComponent("SafariAttractionApp", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// `~/Library/Application Support/SafariAttractionApp/work` — CLI 를 돌릴 앱 전용 빈 폴더(없으면 만든다).
    public static func workDirectory(applicationSupport: URL? = nil) throws -> URL {
        let base = try applicationSupport ?? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let dir = base.appendingPathComponent("SafariAttractionApp/work", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// `~/Library/Application Support/SafariAttractionApp/claude-config` — 앱이 띄우는 claude 만 쓰는 설정 폴더(`CLAUDE_CONFIG_DIR`).
    /// 없으면 0700 으로 만든다. 박정욱이 이 폴더로 한 번 로그인한다(`CLAUDE_CONFIG_DIR=… claude auth login`).
    public static func claudeConfigDirectory(supportDirectory: URL? = nil) throws -> URL {
        let support = try supportDirectory ?? Self.supportDirectory()
        let dir = support.appendingPathComponent("claude-config", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        return dir
    }
}
