import Foundation

/// 앱은 로그인 셸이 아니라서 PATH 가 짧다 — 사용자의 로그인 셸에서 PATH 를 한 번 읽어 캐시한다.
public enum ShellPath {
    static let marker = "__SAPATH__"
    private static let cache = Cache()

    private final class Cache: @unchecked Sendable {
        let lock = NSLock()
        var value: String?
    }

    /// 로그인 셸(`/bin/zsh -lic`)의 PATH. 처음 한 번만 읽고, 못 읽으면 `fallback()`.
    public static func loginPath() -> String {
        cache.lock.lock(); defer { cache.lock.unlock() }
        if let v = cache.value { return v }
        let v = resolve(shell: "/bin/zsh",
                        arguments: ["-lic", "printf '\(marker)%s\(marker)' \"$PATH\""],
                        timeout: 8) ?? fallback()
        cache.value = v
        return v
    }

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

public enum AppPaths {
    /// `~/Library/Application Support/SafariAttractionApp/work` — CLI 를 돌릴 앱 전용 빈 폴더(없으면 만든다).
    public static func workDirectory(applicationSupport: URL? = nil) throws -> URL {
        let base = try applicationSupport ?? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let dir = base.appendingPathComponent("SafariAttractionApp/work", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}
