import Foundation

/// 사이트별 허락 모드 — 읽기만 · 묻고 하기(모르는 사이트 기본) · 다 허락.
public enum SiteMode: String, Codable, Sendable, CaseIterable {
    case readOnly
    case ask
    case allowAll
}

public enum SiteModeError: Error, Equatable {
    case emptyHost
}

/// `<앱 지원 폴더>/site-modes.json`(호스트 → 모드) 저장소. 호스트 키는 소문자로 맞춘다.
/// 파일이 없으면 · 깨졌으면 빈 것으로 보고(앱이 죽지 않는다), 깨진 파일은 처음 덮어쓰기 전에 `site-modes.json.bak` 으로 남긴다.
/// `directory` 는 앱 지원 폴더(`AppPaths.supportDirectory()`) — 시험은 임시 폴더를 넣는다.
public final class SiteModeStore: @unchecked Sendable {
    public static let fileName = "site-modes.json"

    private let directory: URL
    private let lock = NSLock()
    private var modes: [String: SiteMode] = [:]
    private var loadedCorrupt = false

    public init(directory: URL) {
        self.directory = directory
        load()
    }

    private var fileURL: URL { directory.appendingPathComponent(Self.fileName) }
    private var backupURL: URL { directory.appendingPathComponent(Self.fileName + ".bak") }

    static func normalize(_ host: String) -> String {
        var h = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while h.hasSuffix(".") { h.removeLast() }
        return h
    }

    public func mode(for host: String) -> SiteMode {
        lock.lock(); defer { lock.unlock() }
        return modes[Self.normalize(host)] ?? .ask
    }

    /// 지금 저장된 모든 사이트(설정 화면용).
    public var all: [String: SiteMode] {
        lock.lock(); defer { lock.unlock() }
        return modes
    }

    public func setMode(_ mode: SiteMode, for host: String) throws {
        let key = Self.normalize(host)
        guard !key.isEmpty else { throw SiteModeError.emptyHost }
        lock.lock(); defer { lock.unlock() }
        var next = modes
        next[key] = mode
        try write(next)
        modes = next
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL) else { return }   // 없으면 빈 것
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            loadedCorrupt = true
            return
        }
        for (k, v) in obj {
            guard let s = v as? String, let m = SiteMode(rawValue: s) else { continue }
            let key = Self.normalize(k)
            if !key.isEmpty { modes[key] = m }
        }
    }

    private func write(_ next: [String: SiteMode]) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        if loadedCorrupt {
            // 깨진 파일은 덮어쓰기 전에 한 번 남긴다.
            if fm.fileExists(atPath: fileURL.path) {
                try? fm.removeItem(at: backupURL)
                try fm.copyItem(at: fileURL, to: backupURL)
            }
            loadedCorrupt = false
        }
        let raw = next.mapValues(\.rawValue)
        let data = try JSONSerialization.data(withJSONObject: raw, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        try data.write(to: fileURL, options: .atomic)
    }
}
