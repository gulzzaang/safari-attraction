import Foundation
import Observation

/// 사용자에게 그대로 보여 줄 업데이트 실패 메시지 오류.
public struct UpdateError: Error, Equatable, Sendable, LocalizedError, CustomStringConvertible, ExpressibleByStringLiteral {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public init(stringLiteral value: String) {
        self.message = value
    }

    public var description: String { message }
    public var errorDescription: String? { message }
}

/// 업데이트 확인 · 설치 진행 상태.
public enum UpdateState: Equatable, Sendable {
    case idle
    case checking
    case available(AppRelease)
    case upToDate(AppVersion)
    case failed(String)
    case installing
}

/// 리다이렉트 도착지 호스트와 최대 크기(200MB)를 확인하며 데이터를 받는 URLSession 대리자.
private final class UpdateDownloadDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let allowLocalhostHTTP: Bool
    private let allowGitHubAPI: Bool
    private let maxBytes: Int
    private let lock = NSLock()
    private var response: URLResponse?
    private var buffer = Data()
    private var rejectedError: Error?
    private var continuation: CheckedContinuation<(Data, URLResponse), Error>?

    init(allowLocalhostHTTP: Bool, allowGitHubAPI: Bool, maxBytes: Int) {
        self.allowLocalhostHTTP = allowLocalhostHTTP
        self.allowGitHubAPI = allowGitHubAPI
        self.maxBytes = maxBytes
    }

    func fetch(_ request: URLRequest, session: URLSession) async throws -> (Data, URLResponse) {
        try await withCheckedThrowingContinuation { cont in
            lock.withLock { self.continuation = cont }
            let task = session.dataTask(with: request)
            task.resume()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        guard let url = request.url, isAllowed(url) else {
            lock.withLock { rejectedError = URLError(.badURL) }
            task.cancel()
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if response.expectedContentLength > Int64(maxBytes) {
            lock.withLock { rejectedError = URLError(.dataLengthExceedsMaximum) }
            completionHandler(.cancel)
            return
        }
        lock.withLock { self.response = response }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let exceeded = lock.withLock { () -> Bool in
            if buffer.count + data.count > maxBytes {
                rejectedError = URLError(.dataLengthExceedsMaximum)
                return true
            }
            buffer.append(data)
            return false
        }
        if exceeded {
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let result: Result<(Data, URLResponse), Error> = lock.withLock {
            if let rejectedError { return .failure(rejectedError) }
            if let error { return .failure(error) }
            guard let response else { return .failure(URLError(.badServerResponse)) }
            return .success((buffer, response))
        }
        let cont = lock.withLock { () -> CheckedContinuation<(Data, URLResponse), Error>? in
            let c = continuation
            continuation = nil
            return c
        }
        cont?.resume(with: result)
    }

    private func isAllowed(_ url: URL) -> Bool {
        if UpdateVerifier.allowedDownloadURL(url, allowLocalhostHTTP: allowLocalhostHTTP) {
            return true
        }
        if allowGitHubAPI,
           url.scheme?.lowercased() == "https",
           url.host?.lowercased() == "api.github.com" {
            return true
        }
        return false
    }
}

/// GitHub 릴리스 확인 · 주기 실행 · 내려받기 · 검증 · 종료 후 바꿔 넣기 준비를 맡는다.
@MainActor
@Observable
public final class UpdateService {
    public typealias Fetch = @Sendable (URL) async throws -> (Data, URLResponse)
    public typealias ScriptLauncher = @Sendable (String) throws -> Void

    public private(set) var state: UpdateState = .idle {
        didSet {
            if state != oldValue {
                onStateChange?(state)
            }
        }
    }

    /// `install()` 이 모든 검증을 마친 뒤 종료 시점에 바꿔 넣을 준비된 새 앱 경로.
    public private(set) var pendingNewAppURL: URL?

    /// 상태가 바뀔 때 메뉴 막대 아이콘 · 메뉴를 갱신하기 위한 콜백.
    @ObservationIgnored
    public var onStateChange: (@MainActor (UpdateState) -> Void)?

    public let currentVersion: AppVersion
    public let currentAppURL: URL
    public let feedURL: URL
    public let allowLocalhostHTTP: Bool

    @ObservationIgnored private let publicKeyBase64: String
    @ObservationIgnored private let installer: UpdateInstaller
    @ObservationIgnored private let fetch: Fetch
    @ObservationIgnored private let launchScript: ScriptLauncher
    @ObservationIgnored private let initialDelay: TimeInterval
    @ObservationIgnored private let checkInterval: TimeInterval
    @ObservationIgnored private var scheduleTask: Task<Void, Never>?
    @ObservationIgnored private var isChecking = false

    public init(currentVersion: AppVersion,
                currentAppURL: URL,
                feedURL: URL = AppUpdate.defaultFeedURL,
                allowLocalhostHTTP: Bool = false,
                publicKeyBase64: String = UpdateVerifier.publicKeyBase64,
                installer: UpdateInstaller = UpdateInstaller(),
                initialDelay: TimeInterval = AppUpdate.initialCheckDelay,
                checkInterval: TimeInterval = AppUpdate.checkInterval,
                fetch: Fetch? = nil,
                launchScript: ScriptLauncher? = nil) {
        self.currentVersion = currentVersion
        self.currentAppURL = currentAppURL
        self.feedURL = feedURL
        self.allowLocalhostHTTP = allowLocalhostHTTP
        self.publicKeyBase64 = publicKeyBase64
        self.installer = installer
        self.initialDelay = initialDelay
        self.checkInterval = checkInterval
        self.fetch = fetch ?? Self.makeDefaultFetch(feedURL: feedURL, allowLocalhostHTTP: allowLocalhostHTTP)
        self.launchScript = launchScript ?? { script in try UpdateInstaller.spawnReplaceScript(script) }
    }

    /// 릴리스 목록을 확인한다. `userInitiated == false` 이면 실패해도 조용히 넘긴다.
    public func checkNow(userInitiated: Bool) async {
        guard !isChecking, state != .installing else { return }
        isChecking = true
        defer { isChecking = false }

        let previousState = state
        if userInitiated {
            state = .checking
        }

        do {
            let (data, response) = try await fetch(feedURL)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw URLError(.badServerResponse)
            }
            if let finalURL = http.url, !Self.isAllowedFeedURL(finalURL, allowLocalhostHTTP: allowLocalhostHTTP) {
                throw URLError(.badURL)
            }
            if let release = AppUpdate.pickLatest(data, newerThan: currentVersion, allowLocalhostHTTP: allowLocalhostHTTP) {
                state = .available(release)
            } else if userInitiated {
                state = .upToDate(currentVersion)
            } else {
                state = .idle
            }
        } catch {
            if userInitiated {
                state = .failed(UpdateMessages.checkFailed)
            } else {
                state = previousState
            }
        }
    }

    /// 앱 시작 뒤 `initialDelay`(기본 10초) 후 처음 확인하고, 이후 `checkInterval`(기본 6시간)마다 확인한다.
    public func startSchedule() {
        stopSchedule()
        let firstDelay = max(0, initialDelay)
        let interval = max(0.01, checkInterval)
        scheduleTask = Task { [weak self] in
            if firstDelay > 0 {
                try? await Task.sleep(nanoseconds: UInt64(firstDelay * 1_000_000_000))
            }
            while !Task.isCancelled {
                guard let self else { return }
                await self.checkNow(userInitiated: false)
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            }
        }
    }

    /// 주기 확인 작업을 멈춘다.
    public func stopSchedule() {
        scheduleTask?.cancel()
        scheduleTask = nil
    }

    /// 감지된 업데이트를 내려받고 서명 · 번들 · 버전 · 코드 서명 · 쓰기 권한을 모두 확인한다.
    /// 성공하면 `pendingNewAppURL` 을 채우고 `.success(())` 를 돌려준다.
    /// 실제 바꿔 넣기는 앱 종료 순서를 거친 뒤 `launchPendingReplacement(pid:)` 에서 실행한다.
    public func install() async -> Result<Void, UpdateError> {
        guard case .available(let release) = state else {
            return .failure(UpdateError(UpdateMessages.invalidFile))
        }
        guard UpdateVerifier.allowedDownloadURL(release.zipURL, allowLocalhostHTTP: allowLocalhostHTTP),
              UpdateVerifier.allowedDownloadURL(release.sigURL, allowLocalhostHTTP: allowLocalhostHTTP) else {
            state = .failed(UpdateMessages.invalidFile)
            return .failure(UpdateError(UpdateMessages.invalidFile))
        }

        pendingNewAppURL = nil
        state = .installing

        // 1. 서명 파일과 zip 내려받기(허용 호스트 · 리다이렉트 도착지 · 200MB 상한 확인)
        let sigData: Data
        let zipData: Data
        do {
            sigData = try await downloadVerified(url: release.sigURL, maxBytes: 4_096)
            zipData = try await downloadVerified(url: release.zipURL, maxBytes: AppUpdate.maxZipBytes)
        } catch {
            state = .failed(UpdateMessages.invalidFile)
            return .failure(UpdateError(UpdateMessages.invalidFile))
        }

        // 2. zip 바이트의 Ed25519 서명 확인 — 실패하면 압축을 풀지 않는다.
        let sigString = String(decoding: sigData, as: UTF8.self)
        guard UpdateVerifier.verifySignature(zip: zipData, signatureBase64: sigString, publicKeyBase64: publicKeyBase64) else {
            state = .failed(UpdateMessages.invalidFile)
            return .failure(UpdateError(UpdateMessages.invalidFile))
        }

        // 3. 임시 zip 파일로 저장 후 압축 풀기 · 번들 ID · 버전 · codesign · 인증서 일치 확인
        let tempZip = FileManager.default.temporaryDirectory
            .appendingPathComponent("SafariAttractionApp-\(release.version)-\(UUID().uuidString).zip")
        defer { try? FileManager.default.removeItem(at: tempZip) }

        let newAppURL: URL
        do {
            try zipData.write(to: tempZip, options: .atomic)
            newAppURL = try await installer.prepare(zip: tempZip, current: currentVersion, currentAppURL: currentAppURL)
        } catch {
            state = .failed(UpdateMessages.invalidFile)
            return .failure(UpdateError(UpdateMessages.invalidFile))
        }

        // 4. 앱 자리에 쓸 수 있는지 확인 — 권한이 없으면 앱을 끄지 않고 고정 문구를 보인다.
        guard installer.canReplace(at: currentAppURL) else {
            try? FileManager.default.removeItem(at: newAppURL.deletingLastPathComponent())
            state = .failed(UpdateMessages.notWritable)
            return .failure(UpdateError(UpdateMessages.notWritable))
        }

        pendingNewAppURL = newAppURL
        return .success(())
    }

    /// 앱 종료 직전(`applicationWillTerminate`)에 준비된 새 앱 바꿔 넣기 스크립트를 띄운다.
    /// 준비된 업데이트가 없으면 `false` 를 돌려준다.
    @discardableResult
    public func launchPendingReplacement(pid: Int32 = ProcessInfo.processInfo.processIdentifier) throws -> Bool {
        guard let newAppURL = pendingNewAppURL else { return false }
        pendingNewAppURL = nil
        let script = installer.replaceScript(oldApp: currentAppURL, newApp: newAppURL, pid: pid)
        try launchScript(script)
        return true
    }

    // MARK: - 내부

    private func downloadVerified(url: URL, maxBytes: Int) async throws -> Data {
        guard UpdateVerifier.allowedDownloadURL(url, allowLocalhostHTTP: allowLocalhostHTTP) else {
            throw URLError(.badURL)
        }
        let (data, response) = try await fetch(url)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        if let finalURL = http.url,
           !UpdateVerifier.allowedDownloadURL(finalURL, allowLocalhostHTTP: allowLocalhostHTTP) {
            throw URLError(.badURL)
        }
        if let contentLengthHeader = http.value(forHTTPHeaderField: "Content-Length"),
           let headerSize = Int64(contentLengthHeader),
           headerSize > Int64(maxBytes) {
            throw URLError(.dataLengthExceedsMaximum)
        }
        if http.expectedContentLength > Int64(maxBytes) || data.count > maxBytes {
            throw URLError(.dataLengthExceedsMaximum)
        }
        return data
    }

    private static func isAllowedFeedURL(_ url: URL, allowLocalhostHTTP: Bool) -> Bool {
        if UpdateVerifier.allowedDownloadURL(url, allowLocalhostHTTP: allowLocalhostHTTP) {
            return true
        }
        if url.scheme?.lowercased() == "https", url.host?.lowercased() == "api.github.com" {
            return true
        }
        return false
    }

    private static func makeDefaultFetch(feedURL: URL, allowLocalhostHTTP: Bool) -> Fetch {
        return { url in
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 30
            config.timeoutIntervalForResource = 180
            let isFeed = (url == feedURL)
            let delegate = UpdateDownloadDelegate(allowLocalhostHTTP: allowLocalhostHTTP,
                                                  allowGitHubAPI: isFeed,
                                                  maxBytes: AppUpdate.maxZipBytes)
            let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
            defer { session.finishTasksAndInvalidate() }

            var request = URLRequest(url: url)
            request.setValue("SafariAttractionApp", forHTTPHeaderField: "User-Agent")
            if isFeed {
                request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            }
            return try await delegate.fetch(request, session: session)
        }
    }
}
