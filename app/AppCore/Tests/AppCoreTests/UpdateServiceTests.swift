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

        // 답하는 질문 · 루틴이 정리되는 applicationShouldTerminate → applicationWillTerminate 순서 흉내.
        box.events.append("shouldTerminateCleanupDone")
        let launched = try svc.launchPendingReplacement(pid: 9876)
        XCTAssertTrue(launched)
        XCTAssertEqual(box.events, ["shouldTerminateCleanupDone", "launchReplace"])
        XCTAssertTrue(box.launchedScript?.contains("9876") == true)
        XCTAssertNil(svc.pendingNewAppURL)
        // 두 번 불러도 중복 실행하지 않는다.
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
}
