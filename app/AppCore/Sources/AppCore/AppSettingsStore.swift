import Foundation

/// 앱 설정(`settings.json`) — 고른 CLI · CLI 마다 고른 모델 · 생각 단계 · 마지막 실행 앱 버전.
public struct AppSettings: Codable, Equatable, Sendable {
    /// `ModelKind.rawValue`("claude" · "chatgpt").
    public var selectedCLI: String
    /// CLI(`ModelKind.rawValue`) → 고른 모델 id.
    public var models: [String: String]
    /// CLI(`ModelKind.rawValue`) → 고른 생각 단계(기본은 키 없음).
    public var efforts: [String: String]
    /// 마지막으로 실행한 앱 버전(`CFBundleShortVersionString`). 바뀌면 사파리 확장을 한 번 다시 등록한다.
    public var lastLaunchedVersion: String?

    public init(selectedCLI: String = ModelKind.claude.rawValue, models: [String: String] = [:],
                efforts: [String: String] = [:], lastLaunchedVersion: String? = nil) {
        self.selectedCLI = selectedCLI; self.models = models; self.efforts = efforts
        self.lastLaunchedVersion = lastLaunchedVersion
    }

    /// 옛 파일(`agyMode` · `webSearch` · `attachPage` 키가 있거나 `efforts` · `lastLaunchedVersion` 이 없는)도 깨진 파일로 보지 않고 읽는다. 모르는 키는 무시한다.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        selectedCLI = try c.decodeIfPresent(String.self, forKey: .selectedCLI) ?? ModelKind.claude.rawValue
        models = try c.decodeIfPresent([String: String].self, forKey: .models) ?? [:]
        efforts = try c.decodeIfPresent([String: String].self, forKey: .efforts) ?? [:]
        lastLaunchedVersion = try c.decodeIfPresent(String.self, forKey: .lastLaunchedVersion)
    }
}

/// `settings.json` 읽고 쓰기. 파일이 없거나 깨졌거나 못 읽으면 기본값(앱이 죽지 않는다).
/// 쓸 때는 atomic, 깨졌거나 못 읽은 파일은 처음 덮어쓰기 전에 `settings.json.bak` 으로 남긴다.
public final class AppSettingsStore: @unchecked Sendable {
    public static let fileName = "settings.json"
    private let directory: URL
    private let lock = NSLock()
    private var settings = AppSettings()
    private var loadedCorrupt = false

    public init(directory: URL) {
        self.directory = directory
        load()
    }

    private var fileURL: URL { directory.appendingPathComponent(Self.fileName) }
    private var backupURL: URL { directory.appendingPathComponent(Self.fileName + ".bak") }

    public var current: AppSettings { lock.withLock { settings } }

    public func update(_ change: (inout AppSettings) -> Void) throws {
        try lock.withLock {
            var next = settings
            change(&next)
            try write(next)
            settings = next
        }
    }

    private func load() {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? JSONDecoder().decode(AppSettings.self, from: data) else {
            loadedCorrupt = true
            return
        }
        settings = decoded
    }

    private func write(_ next: AppSettings) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        if loadedCorrupt {
            if fm.fileExists(atPath: fileURL.path) {
                try? fm.removeItem(at: backupURL)
                try fm.copyItem(at: fileURL, to: backupURL)
            }
            loadedCorrupt = false
        }
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try enc.encode(next).write(to: fileURL, options: .atomic)
    }
}
