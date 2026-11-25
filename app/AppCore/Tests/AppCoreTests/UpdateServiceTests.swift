import XCTest
import CryptoKit
@testable import AppCore

@MainActor
final class UpdateServiceTests: XCTestCase {
    private final class FakeRunner: CommandRunning, @unchecked Sendable {
        let lock = NSLock()
        private var _called = false
        var wasCalled: Bool { lock.withLock { _called } }
        let bundleID: String
        let version: String
        let codesignOK: Bool

        init(bundleID: String = AppUpdate.bundleIdentifier, version: String = "0.3.0", codesignOK: Bool = true) {
            self.bundleID = bundleID
            self.version = version
            self.codesignOK = codesignOK
        }

        func run(executable: String, arguments: [String], workDir: URL, path: String, timeout: TimeInterval,
                 environment: [String: String], onEvent: @escaping @Sendable (RunEvent) -> Void) async -> RunOutcome {
            lock.withLock { _called = true }
            if executable.hasSuffix("ditto"), let destPath = arguments.last {
                let app = URL(fileURLWithPath: destPath).appendingPathComponent("SafariAttractionApp.app", isDirectory: true)
                let contents = app.appendingPathComponent("Contents", isDirectory: true)
                try? FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
                let plist: [String: Any] = ["CFBundleIdentifier": bundleID, "CFBundleShortVersionString": version]
                if let data = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0) {
                    try? data.write(to: contents.appendingPathComponent("Info.plist"))
                }
                return .finished(code: 0)
            }
            if executable.hasSuffix("codesign") {
                if arguments.first == "-d" {
                    onEvent(.stdout(Data("designated => cdhash H\"abc\"\n".utf8)))
                    return .finished(code: 0)
                }
                return .finished(code: codesignOK ? 0 : 1)
            }
            return .finished(code: 0)
        }

        func stop() {}
    }

    private func tempDir() throws -> URL {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("update-svc-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: u) }
        return u
    }

    private func makeReleaseJSON(version: String = "0.3.0",
                                 zipURL: String = "https://github.com/gulzzaang/safari-attraction/releases/download/app-v0.3.0/SafariAttractionApp-0.3.0.zip",
                                 sigURL: String = "https://github.com/gulzzaang/safari-attraction/releases/download/app-v0.3.0/SafariAttractionApp-0.3.0.zip.sig") -> Data {
        let s = """
        [
          {
            "tag_name": "app-v\(version)",
            "draft": false,
            "prerelease": false,
            "html_url": "https://github.com/gulzzaang/safari-attraction/releases/tag/app-v\(version)",
            "assets": [
              { "name": "SafariAttractionApp-\(version).zip", "browser_download_url": "\(zipURL)", "size": 1024 },
              { "name": "SafariAttractionApp-\(version).zip.sig", "browser_download_url": "\(sigURL)", "size": 88 }
            ]
          }
        ]
        """
        return Data(s.utf8)
    }

    nonisolated private static func httpResponse(url: URL, status: Int = 200, headers: [String: String]? = nil) -> HTTPURLResponse {
        HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: headers)!
    }

    private func failureMessage(_ result: Result<Void, UpdateError>) -> String? {
        if case .failure(let err) = result { return err.message }
        return nil
    }

    private func isSuccess(_ result: Result<Void, UpdateError>) -> Bool {
        if case .success = result { return true }
        return false
    }

    func testCheckNowAutoFailureIsSilentAndUserFailureShowsFixedMessage() async throws {
        let current = try XCTUnwrap(AppVersion("0.2.0"))
        let svc = UpdateService(
            currentVersion: current,
            currentAppURL: URL(fileURLWithPath: "/tmp/Current.app"),
            fetch: { _ in throw URLError(.notConnectedToInternet) }
        )

        // 자동 확인 실패는 조용히 넘긴다.
        await svc.checkNow(userInitiated: false)
        XCTAssertEqual(svc.state, .idle)

        // 사용자가 누르면 고정 문구를 보인다.
        await svc.checkNow(userInitiated: true)
        XCTAssertEqual(svc.state, .failed("업데이트를 확인하지 못했어요 — 인터넷 연결을 확인해 주세요"))
    }

    func testCheckNowUpToDateAndAvailable() async throws {
        let current = try XCTUnwrap(AppVersion("0.2.0"))
        let feedJSON = makeReleaseJSON(version: "0.2.0")
        let upToDateSvc = UpdateService(
            currentVersion: current,
            currentAppURL: URL(fileURLWithPath: "/tmp/Current.app"),
            fetch: { url in (feedJSON, Self.httpResponse(url: url)) }
        )

        await upToDateSvc.checkNow(userInitiated: false)
        XCTAssertEqual(upToDateSvc.state, .idle)

        await upToDateSvc.checkNow(userInitiated: true)
        XCTAssertEqual(upToDateSvc.state, .upToDate(current))

        let newerJSON = makeReleaseJSON(version: "0.3.0")
        let availSvc = UpdateService(
            currentVersion: current,
            currentAppURL: URL(fileURLWithPath: "/tmp/Current.app"),
            fetch: { url in (newerJSON, Self.httpResponse(url: url)) }
        )
        await availSvc.checkNow(userInitiated: false)
        if case .available(let rel) = availSvc.state {
            XCTAssertEqual(rel.version, AppVersion("0.3.0"))
        } else {
            XCTFail("available 상태여야 한다: \(availSvc.state)")
        }
    }

    func testInstallRejectsTamperedZipBeforeUnzipping() async throws {
        let dir = try tempDir()
        let currentApp = dir.appendingPathComponent("SafariAttractionApp.app", isDirectory: true)
        try FileManager.default.createDirectory(at: currentApp, withIntermediateDirectories: true)

        let key = Curve25519.Signing.PrivateKey()
        let pubB64 = key.publicKey.rawRepresentation.base64EncodedString()
        let originalZip = Data("authentic-zip-bytes".utf8)
        let sigB64 = try key.signature(for: originalZip).base64EncodedString()
        let tamperedZip: Data = {
            var d = originalZip
            d[0] ^= 0xFF
            return d
        }()

        let feedJSON = makeReleaseJSON(version: "0.3.0")
        let runner = FakeRunner()
        let installer = UpdateInstaller(runnerFactory: { runner }, stagingRoot: dir)
        let svc = UpdateService(
            currentVersion: try XCTUnwrap(AppVersion("0.2.0")),
            currentAppURL: currentApp,
            publicKeyBase64: pubB64,
            installer: installer,
            fetch: { url in
                if url.absoluteString.hasSuffix(".sig") {
                    return (Data(sigB64.utf8), Self.httpResponse(url: url))
                }
                if url.absoluteString.hasSuffix(".zip") {
                    return (tamperedZip, Self.httpResponse(url: url))
                }
                return (feedJSON, Self.httpResponse(url: url))
            }
        )

        await svc.checkNow(userInitiated: true)
        let result = await svc.install()
        XCTAssertEqual(failureMessage(result), "업데이트 파일이 올바르지 않아 설치하지 않았어요")
        XCTAssertEqual(svc.state, .failed("업데이트 파일이 올바르지 않아 설치하지 않았어요"))
        XCTAssertFalse(runner.wasCalled, "서명이 틀리면 압축을 풀지 않아야 한다")
        XCTAssertNil(svc.pendingNewAppURL)
    }

    func testInstallRejectsDifferentCertificateWithFixedMessage() async throws {
        let dir = try tempDir()
        let currentApp = dir.appendingPathComponent("SafariAttractionApp.app", isDirectory: true)
        try FileManager.default.createDirectory(at: currentApp, withIntermediateDirectories: true)

        let key = Curve25519.Signing.PrivateKey()
        let pubB64 = key.publicKey.rawRepresentation.base64EncodedString()
        let zipData = Data("authentic-zip-bytes".utf8)
        let sigB64 = try key.signature(for: zipData).base64EncodedString()
        let feedJSON = makeReleaseJSON(version: "0.3.0")

        final class CertMismatchRunner: CommandRunning, @unchecked Sendable {
            func run(executable: String, arguments: [String], workDir: URL, path: String, timeout: TimeInterval,
                     environment: [String: String], onEvent: @escaping @Sendable (RunEvent) -> Void) async -> RunOutcome {
                if executable.hasSuffix("ditto"), let dest = arguments.last {
                    let app = URL(fileURLWithPath: dest).appendingPathComponent("SafariAttractionApp.app", isDirectory: true)
                    let contents = app.appendingPathComponent("Contents", isDirectory: true)
                    try? FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
                    let plist: [String: Any] = ["CFBundleIdentifier": AppUpdate.bundleIdentifier, "CFBundleShortVersionString": "0.3.0"]
                    if let d = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0) {
                        try? d.write(to: contents.appendingPathComponent("Info.plist"))
                    }
                    return .finished(code: 0)
                }
                if executable.hasSuffix("codesign") && arguments.first == "-d" {
                    let req = #"designated => identifier "com.gulzzaang.SafariAttractionApp" and certificate leaf = H"4d51c8d70785df740a67b2ac197e235bf76fee4d""#
                    onEvent(.stdout(Data((req + "\n").utf8)))
                    return .finished(code: 0)
                }
                if executable.hasSuffix("codesign") && arguments.contains("-R") {
                    return .finished(code: 3)
                }
                return .finished(code: 0)
            }
            func stop() {}
        }

        let svc = UpdateService(
            currentVersion: try XCTUnwrap(AppVersion("0.2.0")),
            currentAppURL: currentApp,
            publicKeyBase64: pubB64,
            installer: UpdateInstaller(runnerFactory: { CertMismatchRunner() }, stagingRoot: dir),
            fetch: { url in
                if url.absoluteString.hasSuffix(".sig") { return (Data(sigB64.utf8), Self.httpResponse(url: url)) }
                if url.absoluteString.hasSuffix(".zip") { return (zipData, Self.httpResponse(url: url)) }
                return (feedJSON, Self.httpResponse(url: url))
            }
        )

        await svc.checkNow(userInitiated: false)
        let result = await svc.install()
        XCTAssertEqual(failureMessage(result), "업데이트 파일이 올바르지 않아 설치하지 않았어요")
        XCTAssertEqual(svc.state, .failed("업데이트 파일이 올바르지 않아 설치하지 않았어요"))
        XCTAssertNil(svc.pendingNewAppURL)
    }

    func testInstallRejectsDisallowedRedirectAndOversizedZip() async throws {
        let dir = try tempDir()
        let currentApp = dir.appendingPathComponent("SafariAttractionApp.app", isDirectory: true)
        try FileManager.default.createDirectory(at: currentApp, withIntermediateDirectories: true)

        let key = Curve25519.Signing.PrivateKey()
        let pubB64 = key.publicKey.rawRepresentation.base64EncodedString()
        let zipData = Data("zip-bytes".utf8)
        let sigB64 = try key.signature(for: zipData).base64EncodedString()
        let feedJSON = makeReleaseJSON(version: "0.3.0")

        // 리다이렉트 도착지가 허용 호스트가 아닌 경우
        let runner1 = FakeRunner()
        let svc1 = UpdateService(
            currentVersion: try XCTUnwrap(AppVersion("0.2.0")),
            currentAppURL: currentApp,
            publicKeyBase64: pubB64,
            installer: UpdateInstaller(runnerFactory: { runner1 }, stagingRoot: dir),
            fetch: { url in
                if url.absoluteString.hasSuffix(".sig") {
                    return (Data(sigB64.utf8), Self.httpResponse(url: url))
                }
                if url.absoluteString.hasSuffix(".zip") {
                    let badRedirect = URL(string: "https://evil.example.com/payload.zip")!
                    return (zipData, Self.httpResponse(url: badRedirect))
                }
                return (feedJSON, Self.httpResponse(url: url))
            }
        )
        await svc1.checkNow(userInitiated: false)
        let r1 = await svc1.install()
        XCTAssertEqual(failureMessage(r1), "업데이트 파일이 올바르지 않아 설치하지 않았어요")
        XCTAssertFalse(runner1.wasCalled)

        // Content-Length 가 200MB 를 넘는 경우
        let runner2 = FakeRunner()
        let svc2 = UpdateService(
            currentVersion: try XCTUnwrap(AppVersion("0.2.0")),
            currentAppURL: currentApp,
            publicKeyBase64: pubB64,
            installer: UpdateInstaller(runnerFactory: { runner2 }, stagingRoot: dir),
            fetch: { url in
                if url.absoluteString.hasSuffix(".sig") {
                    return (Data(sigB64.utf8), Self.httpResponse(url: url))
                }
                if url.absoluteString.hasSuffix(".zip") {
                    let oversized = String(AppUpdate.maxZipBytes + 1)
                    return (zipData, Self.httpResponse(url: url, headers: ["Content-Length": oversized]))
                }
                return (feedJSON, Self.httpResponse(url: url))
            }
        )
        await svc2.checkNow(userInitiated: false)
        let r2 = await svc2.install()
        XCTAssertEqual(failureMessage(r2), "업데이트 파일이 올바르지 않아 설치하지 않았어요")
        XCTAssertFalse(runner2.wasCalled)
    }

    func testInstallFailsWithoutTerminatingWhenAppLocationIsNotWritable() async throws {
        let dir = try tempDir()
        let appDir = dir.appendingPathComponent("LockedApps", isDirectory: true)
        let currentApp = appDir.appendingPathComponent("SafariAttractionApp.app", isDirectory: true)
        try FileManager.default.createDirectory(at: currentApp, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: appDir.path)
        addTeardownBlock {
            try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: appDir.path)
        }

        let key = Curve25519.Signing.PrivateKey()
        let pubB64 = key.publicKey.rawRepresentation.base64EncodedString()
        let zipData = Data("valid-zip".utf8)
        let sigB64 = try key.signature(for: zipData).base64EncodedString()
        let feedJSON = makeReleaseJSON(version: "0.3.0")

        let stageDir = dir.appendingPathComponent("stage", isDirectory: true)
        try FileManager.default.createDirectory(at: stageDir, withIntermediateDirectories: true)

        let svc = UpdateService(
            currentVersion: try XCTUnwrap(AppVersion("0.2.0")),
            currentAppURL: currentApp,
            publicKeyBase64: pubB64,
            installer: UpdateInstaller(runnerFactory: { FakeRunner() }, stagingRoot: stageDir),
            fetch: { url in
                if url.absoluteString.hasSuffix(".sig") { return (Data(sigB64.utf8), Self.httpResponse(url: url)) }
                if url.absoluteString.hasSuffix(".zip") { return (zipData, Self.httpResponse(url: url)) }
                return (feedJSON, Self.httpResponse(url: url))
            }
        )

        await svc.checkNow(userInitiated: false)
        let result = await svc.install()
        XCTAssertEqual(failureMessage(result), "앱 자리에 쓸 수 없어 업데이트하지 못했어요 — 새 앱을 직접 옮겨 주세요")
        XCTAssertEqual(svc.state, .failed("앱 자리에 쓸 수 없어 업데이트하지 못했어요 — 새 앱을 직접 옮겨 주세요"))
        XCTAssertNil(svc.pendingNewAppURL)
    }

    func testInstallWaitsForAppTerminationOrderBeforeLaunchingReplaceScript() async throws {
        let dir = try tempDir()
        let currentApp = dir.appendingPathComponent("SafariAttractionApp.app", isDirectory: true)
        try FileManager.default.createDirectory(at: currentApp, withIntermediateDirectories: true)

        let key = Curve25519.Signing.PrivateKey()
        let pubB64 = key.publicKey.rawRepresentation.base64EncodedString()
        let zipData = Data("valid-zip".utf8)
        let sigB64 = try key.signature(for: zipData).base64EncodedString()
        let feedJSON = makeReleaseJSON(version: "0.3.0")

        final class Box: @unchecked Sendable {
            var events: [String] = []
            var launchedScript: String?
            var workRunning = true
            var replyContinuation: CheckedContinuation<Bool, Never>?
        }
        let box = Box()

        let svc = UpdateService(
            currentVersion: try XCTUnwrap(AppVersion("0.2.0")),
            currentAppURL: currentApp,
            publicKeyBase64: pubB64,
            installer: UpdateInstaller(runnerFactory: { FakeRunner() }, stagingRoot: dir),
            fetch: { url in
                if url.absoluteString.hasSuffix(".sig") { return (Data(sigB64.utf8), Self.httpResponse(url: url)) }
                if url.absoluteString.hasSuffix(".zip") { return (zipData, Self.httpResponse(url: url)) }
                return (feedJSON, Self.httpResponse(url: url))
            },
            launchScript: { script in
                box.events.append("launchReplace")
                box.launchedScript = script
            }
        )

        await svc.checkNow(userInitiated: false)
        let result = await svc.install()
        XCTAssertTrue(isSuccess(result))
        // 준비가 끝난 직후에는 아직 바꿔 넣기 스크립트를 띄우지 않는다 — 종료 순서를 먼저 거친다.
        XCTAssertTrue(box.events.isEmpty)
        XCTAssertNotNil(svc.pendingNewAppURL)

        // 답하는 질문 · 루틴이 돌고 있으면 beginTermination() 이 .terminateLater 를 돌려주고,
        // 작업이 정리된 뒤 replyShouldTerminate(true) → finishTermination() 순서로 바꿔 넣기 스크립트를 띄운다.
        let coordinator = UpdateTerminationCoordinator(
            updateService: svc,
            isWorkRunning: { box.workRunning },
            stopAcceptingNewWork: { box.events.append("stopAcceptingNewWork") },
            shutdownRunningWork: {
                box.events.append("shutdownRunningWork")
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 15_000_000)
                    box.workRunning = false
                    box.events.append("workStopped")
                }
            },
            shutdownRemaining: { box.events.append("shutdownRemaining") },
            replyShouldTerminate: { should in
                box.events.append("replyShouldTerminate(\(should))")
                box.replyContinuation?.resume(returning: should)
                box.replyContinuation = nil
            },
            pollIntervalNanoseconds: 5_000_000,
            maxWaitTicks: 20
        )

        let shouldTerminate: Bool = await withCheckedContinuation { cont in
            box.replyContinuation = cont
            let decision = coordinator.beginTermination()
            XCTAssertEqual(decision, .terminateLater)
            // 작업 정리 대기 중에는 아직 바꿔 넣기 스크립트를 띄우지 않는다.
            XCTAssertFalse(box.events.contains("launchReplace"))
            XCTAssertNotNil(svc.pendingNewAppURL)
        }
        XCTAssertTrue(shouldTerminate)
        XCTAssertFalse(box.events.contains("launchReplace"), "applicationWillTerminate 전에는 스크립트를 띄우지 않아야 한다")

        coordinator.finishTermination(pid: 9876)
        XCTAssertEqual(
            box.events,
            [
                "stopAcceptingNewWork",
                "shutdownRunningWork",
                "workStopped",
                "replyShouldTerminate(true)",
                "stopAcceptingNewWork",
                "shutdownRunningWork",
                "shutdownRemaining",
                "launchReplace",
            ]
        )
        XCTAssertTrue(box.launchedScript?.contains("9876") == true)
        XCTAssertNil(svc.pendingNewAppURL)
        // 두 번 불러도 중복 실행하지 않는다.
        XCTAssertFalse(try svc.launchPendingReplacement(pid: 9876))

        // 돌고 있는 작업이 없으면 .terminateNow 를 돌려준다.
        let idleCoordinator = UpdateTerminationCoordinator(
            updateService: svc,
            isWorkRunning: { false },
            stopAcceptingNewWork: {},
            shutdownRunningWork: { XCTFail("도는 작업이 없으면 shutdownRunningWork 를 부르지 않아야 한다") },
            shutdownRemaining: {},
            replyShouldTerminate: { _ in XCTFail("즉시 종료면 비동기 reply 를 부르지 않아야 한다") }
        )
        XCTAssertEqual(idleCoordinator.beginTermination(), .terminateNow)
    }

    func testAutoCheckFinishingDuringInstallDoesNotOverwriteInstallingOrAllowConcurrentInstall() async throws {
        final class Gate: @unchecked Sendable {
            private let lock = NSLock()
            private var feedContinuation: CheckedContinuation<Result<Data, Error>, Never>?
            private var zipContinuation: CheckedContinuation<Data, Never>?
            private var feedWaiters: [CheckedContinuation<Void, Never>] = []
            private var zipWaiters: [CheckedContinuation<Void, Never>] = []
            private var feedPaused = false
            private var zipPaused = false
            private var feedCallCount = 0
            private var zipCallCount = 0

            func nextFeedIndex() -> Int {
                lock.withLock {
                    feedCallCount += 1
                    return feedCallCount
                }
            }

            func nextZipIndex() -> Int {
                lock.withLock {
                    zipCallCount += 1
                    return zipCallCount
                }
            }

            func waitFeedRelease() async throws -> Data {
                let res: Result<Data, Error> = await withCheckedContinuation { cont in
                    let waiters = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
                        feedContinuation = cont
                        feedPaused = true
                        let w = feedWaiters
                        feedWaiters.removeAll()
                        return w
                    }
                    waiters.forEach { $0.resume() }
                }
                return try res.get()
            }

            func waitUntilFeedPaused() async {
                await withCheckedContinuation { cont in
                    let already = lock.withLock { () -> Bool in
                        if feedPaused { return true }
                        feedWaiters.append(cont)
                        return false
                    }
                    if already { cont.resume() }
                }
            }

            func releaseFeed(_ result: Result<Data, Error>) {
                let cont = lock.withLock { () -> CheckedContinuation<Result<Data, Error>, Never>? in
                    let c = feedContinuation
                    feedContinuation = nil
                    feedPaused = false
                    return c
                }
                cont?.resume(returning: result)
            }

            func waitZipRelease() async -> Data {
                await withCheckedContinuation { cont in
                    let waiters = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
                        zipContinuation = cont
                        zipPaused = true
                        let w = zipWaiters
                        zipWaiters.removeAll()
                        return w
                    }
                    waiters.forEach { $0.resume() }
                }
            }

            func waitUntilZipPaused() async {
                await withCheckedContinuation { cont in
                    let already = lock.withLock { () -> Bool in
                        if zipPaused { return true }
                        zipWaiters.append(cont)
                        return false
                    }
                    if already { cont.resume() }
                }
            }

            func releaseZip(_ data: Data) {
                let cont = lock.withLock { () -> CheckedContinuation<Data, Never>? in
                    let c = zipContinuation
                    zipContinuation = nil
                    zipPaused = false
                    return c
                }
                cont?.resume(returning: data)
            }

            var totalZipCalls: Int { lock.withLock { zipCallCount } }
        }

        // 시나리오 1: 자동 확인이 도는 도중에 install() 시작 → 자동 확인이 성공(.available)으로 끝나도 .installing 을 덮어쓰지 않는다.
        let dir1 = try tempDir()
        let currentApp1 = dir1.appendingPathComponent("SafariAttractionApp.app", isDirectory: true)
        try FileManager.default.createDirectory(at: currentApp1, withIntermediateDirectories: true)
        let stageRoot1 = dir1.appendingPathComponent("stage", isDirectory: true)
        try FileManager.default.createDirectory(at: stageRoot1, withIntermediateDirectories: true)

        let key = Curve25519.Signing.PrivateKey()
        let pubB64 = key.publicKey.rawRepresentation.base64EncodedString()
        let zipData = Data("valid-zip".utf8)
        let sigB64 = try key.signature(for: zipData).base64EncodedString()
        let feedJSON = makeReleaseJSON(version: "0.3.0")

        let gate1 = Gate()
        let svc1 = UpdateService(
            currentVersion: try XCTUnwrap(AppVersion("0.2.0")),
            currentAppURL: currentApp1,
            publicKeyBase64: pubB64,
            installer: UpdateInstaller(runnerFactory: { FakeRunner() }, stagingRoot: stageRoot1),
            fetch: { url in
                if url.absoluteString.hasSuffix(".sig") {
                    return (Data(sigB64.utf8), Self.httpResponse(url: url))
                }
                if url.absoluteString.hasSuffix(".zip") {
                    _ = gate1.nextZipIndex()
                    let d = await gate1.waitZipRelease()
                    return (d, Self.httpResponse(url: url))
                }
                if gate1.nextFeedIndex() == 1 {
                    return (feedJSON, Self.httpResponse(url: url))
                }
                let d = try await gate1.waitFeedRelease()
                return (d, Self.httpResponse(url: url))
            }
        )

        await svc1.checkNow(userInitiated: false)
        guard case .available = svc1.state else {
            return XCTFail("초기 확인 후 .available 상태여야 한다")
        }

        // 두 번째 자동 확인 시작(응답 대기 중)
        let autoCheckTask = Task { await svc1.checkNow(userInitiated: false) }
        await gate1.waitUntilFeedPaused()

        // 자동 확인이 도는 도중에 설치 시작
        let installTask = Task { await svc1.install() }
        await gate1.waitUntilZipPaused()
        XCTAssertEqual(svc1.state, .installing)

        // 자동 확인이 새 버전 응답으로 끝나도 .installing 을 덮어쓰지 않아야 한다.
        gate1.releaseFeed(.success(feedJSON))
        await autoCheckTask.value
        XCTAssertEqual(svc1.state, .installing)

        // 중복 설치 시도는 막혀야 한다.
        let duplicateResult = await svc1.install()
        XCTAssertEqual(failureMessage(duplicateResult), UpdateMessages.invalidFile)

        // 첫 번째 설치만 완료되고 임시 폴더도 하나만 만들어진다.
        gate1.releaseZip(zipData)
        let firstResult = await installTask.value
        XCTAssertTrue(isSuccess(firstResult))
        XCTAssertEqual(gate1.totalZipCalls, 1)
        XCTAssertNotNil(svc1.pendingNewAppURL)
        let stages = try FileManager.default.contentsOfDirectory(at: stageRoot1, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("sa-update-") }
        XCTAssertEqual(stages.count, 1)

        // 시나리오 2: 자동 확인이 도는 도중에 install() 시작 → 자동 확인이 실패로 끝나도 previousState 로 .installing 을 덮어쓰지 않는다.
        let gate2 = Gate()
        let svc2 = UpdateService(
            currentVersion: try XCTUnwrap(AppVersion("0.2.0")),
            currentAppURL: currentApp1,
            publicKeyBase64: pubB64,
            installer: UpdateInstaller(runnerFactory: { FakeRunner() }, stagingRoot: stageRoot1),
            fetch: { url in
                if url.absoluteString.hasSuffix(".sig") {
                    return (Data(sigB64.utf8), Self.httpResponse(url: url))
                }
                if url.absoluteString.hasSuffix(".zip") {
                    let d = await gate2.waitZipRelease()
                    return (d, Self.httpResponse(url: url))
                }
                if gate2.nextFeedIndex() == 1 {
                    return (feedJSON, Self.httpResponse(url: url))
                }
                let d = try await gate2.waitFeedRelease()
                return (d, Self.httpResponse(url: url))
            }
        )
        await svc2.checkNow(userInitiated: false)
        let failingCheckTask = Task { await svc2.checkNow(userInitiated: false) }
        await gate2.waitUntilFeedPaused()
        let installTask2 = Task { await svc2.install() }
        await gate2.waitUntilZipPaused()
        XCTAssertEqual(svc2.state, .installing)

        gate2.releaseFeed(.failure(URLError(.timedOut)))
        await failingCheckTask.value
        XCTAssertEqual(svc2.state, .installing)

        gate2.releaseZip(zipData)
        let result2 = await installTask2.value
        XCTAssertTrue(isSuccess(result2))
    }

    func testLaunchPendingReplacementPreservesPendingURLWhenScriptLaunchFails() async throws {
        let dir = try tempDir()
        let currentApp = dir.appendingPathComponent("SafariAttractionApp.app", isDirectory: true)
        try FileManager.default.createDirectory(at: currentApp, withIntermediateDirectories: true)

        let key = Curve25519.Signing.PrivateKey()
        let pubB64 = key.publicKey.rawRepresentation.base64EncodedString()
        let zipData = Data("valid-zip".utf8)
        let sigB64 = try key.signature(for: zipData).base64EncodedString()
        let feedJSON = makeReleaseJSON(version: "0.3.0")

        final class LauncherState: @unchecked Sendable {
            private let lock = NSLock()
            private var attempts = 0
            func nextAttempt() -> Int {
                lock.withLock {
                    attempts += 1
                    return attempts
                }
            }
        }
        let launcherState = LauncherState()

        let svc = UpdateService(
            currentVersion: try XCTUnwrap(AppVersion("0.2.0")),
            currentAppURL: currentApp,
            publicKeyBase64: pubB64,
            installer: UpdateInstaller(runnerFactory: { FakeRunner() }, stagingRoot: dir),
            fetch: { url in
                if url.absoluteString.hasSuffix(".sig") { return (Data(sigB64.utf8), Self.httpResponse(url: url)) }
                if url.absoluteString.hasSuffix(".zip") { return (zipData, Self.httpResponse(url: url)) }
                return (feedJSON, Self.httpResponse(url: url))
            },
            launchScript: { _ in
                if launcherState.nextAttempt() == 1 {
                    throw UpdateInstallError.scriptLaunchFailed
                }
            }
        )

        await svc.checkNow(userInitiated: false)
        let result = await svc.install()
        XCTAssertTrue(isSuccess(result))
        let preparedURL = try XCTUnwrap(svc.pendingNewAppURL)

        // 첫 실행이 실패하면 pendingNewAppURL 이 그대로 남아야 한다.
        XCTAssertThrowsError(try svc.launchPendingReplacement(pid: 9876)) { error in
            XCTAssertEqual(error as? UpdateInstallError, .scriptLaunchFailed)
        }
        XCTAssertEqual(svc.pendingNewAppURL, preparedURL)

        // 다시 시도해 성공하면 그제서야 pendingNewAppURL 을 비운다.
        XCTAssertTrue(try svc.launchPendingReplacement(pid: 9876))
        XCTAssertNil(svc.pendingNewAppURL)
        XCTAssertFalse(try svc.launchPendingReplacement(pid: 9876))
    }

    func testScheduleDefaultsAndPeriodicCheck() async throws {
        XCTAssertEqual(AppUpdate.checkInterval, 6 * 60 * 60)
        XCTAssertEqual(AppUpdate.initialCheckDelay, 10)

        final class Counter: @unchecked Sendable {
            let lock = NSLock()
            var count = 0
            func inc() { lock.withLock { count += 1 } }
            var value: Int { lock.withLock { count } }
        }
        let counter = Counter()
        let feedJSON = makeReleaseJSON(version: "0.2.0")

        let svc = UpdateService(
            currentVersion: try XCTUnwrap(AppVersion("0.2.0")),
            currentAppURL: URL(fileURLWithPath: "/tmp/Current.app"),
            initialDelay: 0.02,
            checkInterval: 0.05,
            fetch: { url in
                counter.inc()
                return (feedJSON, Self.httpResponse(url: url))
            }
        )

        svc.startSchedule()
        try await Task.sleep(nanoseconds: 150_000_000)
        svc.stopSchedule()
        let afterStop = counter.value
        XCTAssertGreaterThanOrEqual(afterStop, 2, "초기 확인과 주기 확인이 모두 돌아야 한다")

        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(counter.value, afterStop, "stopSchedule 뒤에는 더 확인하지 않아야 한다")
    }

    func testCheckNowRejectsDisallowedFeedURLBeforeFetching() async throws {
        final class Flag: @unchecked Sendable {
            private let lock = NSLock()
            private var _called = false
            var called: Bool { lock.withLock { _called } }
            func mark() { lock.withLock { _called = true } }
        }

        let current = try XCTUnwrap(AppVersion("0.2.0"))
        let flag1 = Flag()
        let evilSvc = UpdateService(
            currentVersion: current,
            currentAppURL: URL(fileURLWithPath: "/tmp/Current.app"),
            feedURL: URL(string: "https://evil.example.com/releases")!,
            fetch: { url in
                flag1.mark()
                return (Data("[]".utf8), Self.httpResponse(url: url))
            }
        )
        await evilSvc.checkNow(userInitiated: false)
        XCTAssertFalse(flag1.called, "허용되지 않은 feedURL 은 요청 전에 막아야 한다")
        XCTAssertEqual(evilSvc.state, .idle)

        await evilSvc.checkNow(userInitiated: true)
        XCTAssertFalse(flag1.called, "허용되지 않은 feedURL 은 사용자 확인에서도 요청을 보내지 않아야 한다")
        XCTAssertEqual(evilSvc.state, .failed(UpdateMessages.checkFailed))

        // 개발 모드 플래그가 꺼져 있으면 127.0.0.1 http feedURL 도 요청 전에 막는다.
        let flag2 = Flag()
        let localBlocked = UpdateService(
            currentVersion: current,
            currentAppURL: URL(fileURLWithPath: "/tmp/Current.app"),
            feedURL: URL(string: "http://127.0.0.1:8080/releases")!,
            allowLocalhostHTTP: false,
            fetch: { url in
                flag2.mark()
                return (Data("[]".utf8), Self.httpResponse(url: url))
            }
        )
        await localBlocked.checkNow(userInitiated: true)
        XCTAssertFalse(flag2.called)
        XCTAssertEqual(localBlocked.state, .failed(UpdateMessages.checkFailed))

        // 개발 모드(allowLocalhostHTTP == true)에서는 127.0.0.1 http feedURL 을 허용한다.
        let flag3 = Flag()
        let localAllowed = UpdateService(
            currentVersion: current,
            currentAppURL: URL(fileURLWithPath: "/tmp/Current.app"),
            feedURL: URL(string: "http://127.0.0.1:8080/releases")!,
            allowLocalhostHTTP: true,
            fetch: { url in
                flag3.mark()
                return (Data("[]".utf8), Self.httpResponse(url: url))
            }
        )
        await localAllowed.checkNow(userInitiated: true)
        XCTAssertTrue(flag3.called)
        XCTAssertEqual(localAllowed.state, .upToDate(current))
    }

    func testDownloadDelegateEnforcesRedirectAllowlistAndByteLimits() async throws {
        enum StubAction: Sendable {
            case redirect(to: URL)
            case response(status: Int, headers: [String: String]?, chunks: [Data])
        }

        final class DelegateStubProtocol: URLProtocol, @unchecked Sendable {
            static let lock = NSLock()
            nonisolated(unsafe) static var handler: (@Sendable (URL) -> StubAction)?
            nonisolated(unsafe) static var requestedURLs: [URL] = []

            static func reset() {
                lock.withLock {
                    handler = nil
                    requestedURLs = []
                }
            }

            static func snapshotURLs() -> [URL] {
                lock.withLock { requestedURLs }
            }

            override class func canInit(with request: URLRequest) -> Bool { true }
            override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

            override func startLoading() {
                guard let url = request.url else {
                    client?.urlProtocol(self, didFailWithError: URLError(.badURL))
                    return
                }
                let action: StubAction? = Self.lock.withLock {
                    Self.requestedURLs.append(url)
                    return Self.handler?(url)
                }
                guard let action else {
                    client?.urlProtocol(self, didFailWithError: URLError(.fileDoesNotExist))
                    return
                }
                switch action {
                case .redirect(let target):
                    let resp = HTTPURLResponse(url: url, statusCode: 302, httpVersion: "HTTP/1.1",
                                               headerFields: ["Location": target.absoluteString])!
                    client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: target), redirectResponse: resp)
                case .response(let status, let headers, let chunks):
                    let resp = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
                    client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
                    for chunk in chunks {
                        client?.urlProtocol(self, didLoad: chunk)
                    }
                    client?.urlProtocolDidFinishLoading(self)
                }
            }

            override func stopLoading() {}
        }

        addTeardownBlock { DelegateStubProtocol.reset() }

        let stubConfig: @Sendable () -> URLSessionConfiguration = {
            let cfg = URLSessionConfiguration.ephemeral
            cfg.protocolClasses = [DelegateStubProtocol.self]
            return cfg
        }

        // 1. 허용되지 않은 호스트로의 리다이렉트는 대리자의 willPerformHTTPRedirection 에서 거절되고 도착지로 요청이 나가지 않는다.
        DelegateStubProtocol.reset()
        let startZip = URL(string: "https://github.com/gulzzaang/safari-attraction/releases/download/app-v0.3.0/SafariAttractionApp-0.3.0.zip")!
        let evilTarget = URL(string: "https://evil.example.com/payload.zip")!
        DelegateStubProtocol.lock.withLock {
            DelegateStubProtocol.handler = { url in
                if url == startZip { return .redirect(to: evilTarget) }
                return .response(status: 200, headers: nil, chunks: [Data("evil".utf8)])
            }
        }
        let defaultFetch = UpdateService.makeDefaultFetch(feedURL: AppUpdate.defaultFeedURL,
                                                          allowLocalhostHTTP: false,
                                                          sessionConfiguration: stubConfig)
        do {
            _ = try await defaultFetch(startZip, AppUpdate.maxZipBytes)
            XCTFail("허용되지 않은 리다이렉트 도착지는 거절해야 한다")
        } catch let err as URLError {
            XCTAssertEqual(err.code, .badURL)
        }
        XCTAssertEqual(DelegateStubProtocol.snapshotURLs(), [startZip], "거절된 리다이렉트 도착지로는 실제 요청을 보내지 않아야 한다")

        // 2. 허용 호스트(objects.githubusercontent.com)로의 리다이렉트는 통과한다.
        DelegateStubProtocol.reset()
        let allowedTarget = URL(string: "https://objects.githubusercontent.com/github-production-release-asset/asset.zip")!
        DelegateStubProtocol.lock.withLock {
            DelegateStubProtocol.handler = { url in
                if url == startZip { return .redirect(to: allowedTarget) }
                return .response(status: 200, headers: ["Content-Length": "4"], chunks: [Data("ok!!".utf8)])
            }
        }
        let (okData, okResp) = try await defaultFetch(startZip, AppUpdate.maxZipBytes)
        XCTAssertEqual(okData, Data("ok!!".utf8))
        XCTAssertEqual(okResp.url, allowedTarget)
        XCTAssertEqual(DelegateStubProtocol.snapshotURLs(), [startZip, allowedTarget])

        // 3. 200MB 초과 Content-Length 는 대리자의 didReceive(response:) 에서 거절된다.
        DelegateStubProtocol.reset()
        DelegateStubProtocol.lock.withLock {
            DelegateStubProtocol.handler = { _ in
                .response(status: 200,
                          headers: ["Content-Length": String(AppUpdate.maxZipBytes + 1)],
                          chunks: [Data("small".utf8)])
            }
        }
        do {
            _ = try await defaultFetch(startZip, AppUpdate.maxZipBytes)
            XCTFail("200MB 를 넘는 응답은 거절해야 한다")
        } catch let err as URLError {
            XCTAssertEqual(err.code, .dataLengthExceedsMaximum)
        }

        // 4. Content-Length 없이 스트리밍되는 응답도 maxBytes(4KB 서명 상한)를 넘으면 내려받는 도중 대리자에서 중단된다.
        DelegateStubProtocol.reset()
        let dir = try tempDir()
        let currentApp = dir.appendingPathComponent("SafariAttractionApp.app", isDirectory: true)
        try FileManager.default.createDirectory(at: currentApp, withIntermediateDirectories: true)
        let feedJSON = makeReleaseJSON(version: "0.3.0")
        let sigURL = URL(string: "https://github.com/gulzzaang/safari-attraction/releases/download/app-v0.3.0/SafariAttractionApp-0.3.0.zip.sig")!
        DelegateStubProtocol.lock.withLock {
            DelegateStubProtocol.handler = { url in
                if url == AppUpdate.defaultFeedURL {
                    return .response(status: 200, headers: nil, chunks: [feedJSON])
                }
                if url == sigURL {
                    // Content-Length 없이 2KB × 3 = 6KB(> 4KB) 를 나눠 보낸다.
                    let chunk = Data(repeating: 0x41, count: 2_048)
                    return .response(status: 200, headers: nil, chunks: [chunk, chunk, chunk])
                }
                return .response(status: 200, headers: nil, chunks: [Data("zip".utf8)])
            }
        }
        let runner = FakeRunner()
        let svc = UpdateService(
            currentVersion: try XCTUnwrap(AppVersion("0.2.0")),
            currentAppURL: currentApp,
            installer: UpdateInstaller(runnerFactory: { runner }, stagingRoot: dir),
            sizedFetch: UpdateService.makeDefaultFetch(feedURL: AppUpdate.defaultFeedURL,
                                                       allowLocalhostHTTP: false,
                                                       sessionConfiguration: stubConfig)
        )
        await svc.checkNow(userInitiated: false)
        let installResult = await svc.install()
        XCTAssertEqual(failureMessage(installResult), UpdateMessages.invalidFile)
        XCTAssertFalse(runner.wasCalled)
        XCTAssertFalse(DelegateStubProtocol.snapshotURLs().contains(startZip),
                       "서명 파일이 4KB 상한을 넘으면 zip 내려받기로 넘어가지 않아야 한다")
    }
}
