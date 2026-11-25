import Foundation

/// 세 자리 앱 버전(`major.minor.patch`, 예: `0.2.0`).
public struct AppVersion: Comparable, Equatable, Hashable, Sendable, CustomStringConvertible {
    public let major: Int
    public let minor: Int
    public let patch: Int

    public init(major: Int, minor: Int, patch: Int) {
        self.major = major
        self.minor = minor
        self.patch = patch
    }

    /// `"0.2.0"` 처럼 정확히 세 개의 음수 아닌 10진 정수일 때만 만든다.
    public init?(_ s: String) {
        let parts = s.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        var nums: [Int] = []
        nums.reserveCapacity(3)
        for p in parts {
            guard !p.isEmpty else { return nil }
            // 앞자리 0 중복(`01` 등)과 숫자가 아닌 글자(`+`, `-`, 공백 등)는 거절한다.
            if p.count > 1 && p.first == "0" { return nil }
            guard p.allSatisfy({ $0 >= "0" && $0 <= "9" }) else { return nil }
            guard let n = Int(p) else { return nil }
            nums.append(n)
        }
        self.major = nums[0]
        self.minor = nums[1]
        self.patch = nums[2]
    }

    public var description: String { "\(major).\(minor).\(patch)" }

    public static func < (lhs: AppVersion, rhs: AppVersion) -> Bool {
        if lhs.major != rhs.major { return lhs.major < rhs.major }
        if lhs.minor != rhs.minor { return lhs.minor < rhs.minor }
        return lhs.patch < rhs.patch
    }
}

/// GitHub 릴리스에서 고른 앱 업데이트 정보.
public struct AppRelease: Equatable, Sendable {
    public let version: AppVersion
    public let tag: String
    public let zipURL: URL
    public let sigURL: URL
    public let pageURL: URL

    public init(version: AppVersion, tag: String, zipURL: URL, sigURL: URL, pageURL: URL) {
        self.version = version
        self.tag = tag
        self.zipURL = zipURL
        self.sigURL = sigURL
        self.pageURL = pageURL
    }
}

/// 화면에 보이는 업데이트 고정 문구.
public enum UpdateMessages {
    public static func newVersionAvailable(_ version: AppVersion) -> String { "새 버전 \(version) 이 있어요" }
    public static let updateNow = "지금 업데이트"
    public static let viewReleaseNotes = "변경 내용 보기"
    public static let checkForUpdates = "업데이트 확인…"
    public static func upToDate(_ version: AppVersion) -> String { "최신 버전이에요(\(version))" }
    public static let checkFailed = "업데이트를 확인하지 못했어요 — 인터넷 연결을 확인해 주세요"
    public static let invalidFile = "업데이트 파일이 올바르지 않아 설치하지 않았어요"
    public static let installing = "업데이트하는 중이에요…"
    public static let notWritable = "앱 자리에 쓸 수 없어 업데이트하지 못했어요 — 새 앱을 직접 옮겨 주세요"
}

/// 앱 업데이트 상수와 GitHub 릴리스 목록에서 최신 앱 릴리스 고르기.
public enum AppUpdate {
    public static let repository = "gulzzaang/safari-attraction"
    public static let defaultFeedURL = URL(string: "https://api.github.com/repos/gulzzaang/safari-attraction/releases?per_page=30")!
    public static let bundleIdentifier = "com.gulzzaang.SafariAttractionApp"
    public static let extensionBundleIdentifier = "com.gulzzaang.SafariAttractionApp.Extension"
    public static let extensionRelativePath = "Contents/PlugIns/SafariAttractionExtension.appex"
    public static let tagPrefix = "app-v"
    public static let checkInterval: TimeInterval = 6 * 60 * 60
    public static let initialCheckDelay: TimeInterval = 10
    public static let maxZipBytes = 200 * 1024 * 1024

    private struct GitHubRelease: Decodable {
        let tag_name: String?
        let draft: Bool?
        let prerelease: Bool?
        let html_url: String?
        let assets: [GitHubAsset]?
    }

    private struct GitHubAsset: Decodable {
        let name: String?
        let browser_download_url: String?
        let size: Int?
    }

    /// GitHub 릴리스 목록 JSON 에서 `app-v*` 정식 릴리스 가운데 `newerThan` 보다 높은 가장 최신 릴리스를 고른다.
    /// draft · prerelease · 깨진 태그 · zip/sig 자산 빠짐 · 허용되지 않은 호스트는 건너뛴다.
    public static func pickLatest(_ json: Data, newerThan: AppVersion, allowLocalhostHTTP: Bool = false) -> AppRelease? {
        guard let list = try? JSONDecoder().decode([GitHubRelease].self, from: json) else { return nil }
        var best: AppRelease?

        for item in list {
            if item.draft == true || item.prerelease == true { continue }
            guard let tag = item.tag_name, tag.hasPrefix(tagPrefix) else { continue }
            let versionString = String(tag.dropFirst(tagPrefix.count))
            guard let version = AppVersion(versionString), version > newerThan else { continue }
            guard let pageRaw = item.html_url, let pageURL = URL(string: pageRaw),
                  allowedPageURL(pageURL, allowLocalhostHTTP: allowLocalhostHTTP) else { continue }

            let assets = item.assets ?? []
            let zipName = "SafariAttractionApp-\(version).zip"
            let sigName = "SafariAttractionApp-\(version).zip.sig"

            guard let zipAsset = assets.first(where: { $0.name == zipName }),
                  let sigAsset = assets.first(where: { $0.name == sigName }),
                  let zipRaw = zipAsset.browser_download_url, let zipURL = URL(string: zipRaw),
                  let sigRaw = sigAsset.browser_download_url, let sigURL = URL(string: sigRaw),
                  UpdateVerifier.allowedDownloadURL(zipURL, allowLocalhostHTTP: allowLocalhostHTTP),
                  UpdateVerifier.allowedDownloadURL(sigURL, allowLocalhostHTTP: allowLocalhostHTTP) else {
                continue
            }

            if let size = zipAsset.size, size > maxZipBytes { continue }

            let candidate = AppRelease(version: version, tag: tag, zipURL: zipURL, sigURL: sigURL, pageURL: pageURL)
            if let currentBest = best {
                if candidate.version > currentBest.version { best = candidate }
            } else {
                best = candidate
            }
        }

        return best
    }

    private static func allowedPageURL(_ url: URL, allowLocalhostHTTP: Bool) -> Bool {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return false }
        if scheme == "https" { return host == "github.com" }
        if allowLocalhostHTTP && scheme == "http" { return host == "127.0.0.1" }
        return false
    }
}
