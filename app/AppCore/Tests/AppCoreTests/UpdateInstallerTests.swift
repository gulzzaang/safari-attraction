import XCTest
@testable import AppCore

final class UpdateInstallerTests: XCTestCase {
    private struct CommandCall: Equatable {
        let executable: String
        let arguments: [String]
    }

    private final class FakeInstallerRunner: CommandRunning, @unchecked Sendable {
        private let lock = NSLock()
        private var _calls: [CommandCall] = []
        var calls: [CommandCall] { lock.withLock { _calls } }

        let handler: @Sendable (String, [String], @escaping @Sendable (RunEvent) -> Void) -> RunOutcome

        init(handler: @escaping @Sendable (String, [String], @escaping @Sendable (RunEvent) -> Void) -> RunOutcome) {
            self.handler = handler
        }

        func run(executable: String, arguments: [String], workDir: URL, path: String, timeout: TimeInterval,
                 environment: [String: String], onEvent: @escaping @Sendable (RunEvent) -> Void) async -> RunOutcome {
            lock.withLock { _calls.append(CommandCall(executable: executable, arguments: arguments)) }
            return handler(executable, arguments, onEvent)
        }

        func stop() {}
    }

    private func tempDir() throws -> URL {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("update-inst-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: u) }
        return u
    }

    private static func writeFakeApp(in dir: URL, bundleID: String, version: String) throws -> URL {
        let app = dir.appendingPathComponent("SafariAttractionApp.app", isDirectory: true)
        let contents = app.appendingPathComponent("Contents", isDirectory: true)
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        let plist: [String: Any] = [
            "CFBundleIdentifier": bundleID,
            "CFBundleShortVersionString": version,
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: contents.appendingPathComponent("Info.plist"))
        return app
    }

    func testPrepareSucceedsForAdHocCurrentApp() async throws {
        let dir = try tempDir()
        let zip = dir.appendingPathComponent("SafariAttractionApp-0.3.0.zip")
        try Data("zip".utf8).write(to: zip)
        let currentApp = dir.appendingPathComponent("Current.app", isDirectory: true)

        let runner = FakeInstallerRunner { exe, args, onEvent in
            if exe.hasSuffix("ditto") {
                let dest = URL(fileURLWithPath: args.last!)
                _ = try? Self.writeFakeApp(in: dest, bundleID: AppUpdate.bundleIdentifier, version: "0.3.0")
                return .finished(code: 0)
            }
            if exe.hasSuffix("codesign") && args.first == "-d" {
                onEvent(.stdout(Data("designated => cdhash H\"abcdef1234\"\n".utf8)))
                return .finished(code: 0)
            }
            return .finished(code: 0)
        }

        let installer = UpdateInstaller(runnerFactory: { runner }, stagingRoot: dir)
        let prepared = try await installer.prepare(zip: zip, current: try XCTUnwrap(AppVersion("0.2.0")), currentAppURL: currentApp)
        XCTAssertTrue(FileManager.default.fileExists(atPath: prepared.path))
        // ad-hoc 인 지금 앱이면 -R 검사는 건너뛴다.
        XCTAssertFalse(runner.calls.contains { $0.arguments.contains("-R") })
    }

    func testPrepareEnforcesCertificateLeafRequirementAndRejectsDifferentCert() async throws {
        let dir = try tempDir()
        let zip = dir.appendingPathComponent("SafariAttractionApp-0.3.0.zip")
        try Data("zip".utf8).write(to: zip)
        let currentApp = dir.appendingPathComponent("Current.app", isDirectory: true)
        let leafReq = #"identifier "com.gulzzaang.SafariAttractionApp" and certificate leaf = H"4d51c8d70785df740a67b2ac197e235bf76fee4d""#

        // 같은 인증서면 통과
        let okRunner = FakeInstallerRunner { exe, args, onEvent in
            if exe.hasSuffix("ditto") {
                _ = try? Self.writeFakeApp(in: URL(fileURLWithPath: args.last!), bundleID: AppUpdate.bundleIdentifier, version: "0.3.0")
                return .finished(code: 0)
            }
            if exe.hasSuffix("codesign") && args.first == "-d" {
                onEvent(.stdout(Data("designated => \(leafReq)\n".utf8)))
                return .finished(code: 0)
            }
            return .finished(code: 0)
        }
        let okInstaller = UpdateInstaller(runnerFactory: { okRunner }, stagingRoot: dir)
        _ = try await okInstaller.prepare(zip: zip, current: try XCTUnwrap(AppVersion("0.2.0")), currentAppURL: currentApp)
        let reqCall = try XCTUnwrap(okRunner.calls.first { $0.arguments.contains("-R") })
        XCTAssertTrue(reqCall.arguments.contains("=\(leafReq)"), "codesign -R 리터럴 요구 조건은 '=' 로 시작해야 한다")

        // 다른 인증서면 실패
        let badCertRunner = FakeInstallerRunner { exe, args, onEvent in
            if exe.hasSuffix("ditto") {
                _ = try? Self.writeFakeApp(in: URL(fileURLWithPath: args.last!), bundleID: AppUpdate.bundleIdentifier, version: "0.3.0")
                return .finished(code: 0)
            }
            if exe.hasSuffix("codesign") && args.first == "-d" {
                onEvent(.stdout(Data("designated => \(leafReq)\n".utf8)))
                return .finished(code: 0)
            }
            if exe.hasSuffix("codesign") && args.contains("-R") {
                onEvent(.stderr(Data("test-requirement: code failed to satisfy specified code requirement(s)\n".utf8)))
                return .finished(code: 3)
            }
            return .finished(code: 0)
        }
        let badInstaller = UpdateInstaller(runnerFactory: { badCertRunner }, stagingRoot: dir)
        do {
            _ = try await badInstaller.prepare(zip: zip, current: try XCTUnwrap(AppVersion("0.2.0")), currentAppURL: currentApp)
            XCTFail("다른 인증서로 서명된 앱은 거절해야 한다")
        } catch let error as UpdateInstallError {
            XCTAssertEqual(error, .certificateMismatch)
        }
    }

    func testPrepareRejectsWrongBundleIDLowerVersionAndCodesignFailure() async throws {
        let dir = try tempDir()
        let zip = dir.appendingPathComponent("update.zip")
        try Data("zip".utf8).write(to: zip)
        let currentApp = dir.appendingPathComponent("Current.app", isDirectory: true)
        let current = try XCTUnwrap(AppVersion("0.2.0"))

        // 1. 번들 ID 다름
        let wrongBundleRunner = FakeInstallerRunner { exe, args, _ in
            if exe.hasSuffix("ditto") {
                _ = try? Self.writeFakeApp(in: URL(fileURLWithPath: args.last!), bundleID: "com.other.App", version: "0.3.0")
            }
            return .finished(code: 0)
        }
        do {
            _ = try await UpdateInstaller(runnerFactory: { wrongBundleRunner }, stagingRoot: dir)
                .prepare(zip: zip, current: current, currentAppURL: currentApp)
            XCTFail("번들 ID 가 다르면 실패해야 한다")
        } catch let error as UpdateInstallError {
            XCTAssertEqual(error, .invalidBundleID)
        }

        // 2. 버전이 같거나 낮음
        for v in ["0.2.0", "0.1.9"] {
            let lowVerRunner = FakeInstallerRunner { exe, args, _ in
                if exe.hasSuffix("ditto") {
                    _ = try? Self.writeFakeApp(in: URL(fileURLWithPath: args.last!), bundleID: AppUpdate.bundleIdentifier, version: v)
                }
                return .finished(code: 0)
            }
            do {
                _ = try await UpdateInstaller(runnerFactory: { lowVerRunner }, stagingRoot: dir)
                    .prepare(zip: zip, current: current, currentAppURL: currentApp)
                XCTFail("버전이 높지 않으면 실패해야 한다: \(v)")
            } catch let error as UpdateInstallError {
                XCTAssertEqual(error, .notNewerVersion)
            }
        }

        // 3. codesign --verify --strict 실패
        let badSignRunner = FakeInstallerRunner { exe, args, _ in
            if exe.hasSuffix("ditto") {
                _ = try? Self.writeFakeApp(in: URL(fileURLWithPath: args.last!), bundleID: AppUpdate.bundleIdentifier, version: "0.3.0")
                return .finished(code: 0)
            }
            if exe.hasSuffix("codesign") && args.contains("--verify") {
                return .finished(code: 1)
            }
            return .finished(code: 0)
        }
        do {
            _ = try await UpdateInstaller(runnerFactory: { badSignRunner }, stagingRoot: dir)
                .prepare(zip: zip, current: current, currentAppURL: currentApp)
            XCTFail("codesign 실패 시 오류를 던져야 한다")
        } catch let error as UpdateInstallError {
            XCTAssertEqual(error, .codesignFailed)
        }
    }

    func testCanReplaceDetectsReadOnlyDirectory() throws {
        let dir = try tempDir()
        let app = dir.appendingPathComponent("SafariAttractionApp.app", isDirectory: true)
        try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)

        let installer = UpdateInstaller()
        XCTAssertTrue(installer.canReplace(at: app))

        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: dir.path)
        addTeardownBlock {
            try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path)
        }
        XCTAssertFalse(installer.canReplace(at: app))
    }

    func testReplaceScriptQuotesPathsAndIncludesRollback() {
        let installer = UpdateInstaller()
        let oldApp = URL(fileURLWithPath: "/Users/test user/Applications/Safari's App.app")
        let newApp = URL(fileURLWithPath: "/tmp/stage dir/SafariAttractionApp.app")
        let script = installer.replaceScript(oldApp: oldApp, newApp: newApp, pid: 4242)

        XCTAssertTrue(script.hasPrefix("#!/bin/sh\n"))
        XCTAssertTrue(script.contains("'/Users/test user/Applications/Safari'\\''s App.app'"))
        XCTAssertTrue(script.contains("'/tmp/stage dir/SafariAttractionApp.app'"))
        XCTAssertTrue(script.contains("4242"))
        XCTAssertTrue(script.contains("kill -0"))
        XCTAssertTrue(script.contains("ditto"))
        XCTAssertTrue(script.contains("xattr -cr"))
        XCTAssertTrue(script.contains("pluginkit -a"))
        XCTAssertTrue(script.contains(#"env -i HOME="$HOME" USER="$USER" PATH=/usr/bin:/bin open "$OLD_APP""#))
        XCTAssertTrue(script.contains("rollback"))
        // 옛 앱을 백업으로 옮기지 못해도 옛 앱을 다시 켠다(앱이 꺼진 채 남지 않게).
        XCTAssertTrue(script.contains(#"if ! mv "$OLD_APP" "$BACKUP_APP"; then"#))
        XCTAssertTrue(script.contains(#"mv "$BACKUP_APP" "$OLD_APP""#))
        XCTAssertTrue(script.contains(#"rm -rf "$BACKUP_APP""#))
        // `sa-update-*` 임시 폴더가 아닌 임의의 상위 폴더는 지우지 않는다.
        XCTAssertFalse(script.contains("STAGE_DIR="))
    }

    func testReplaceScriptCleansUpManagedStageDirOnAllExitPaths() throws {
        let installer = UpdateInstaller()
        let oldApp = URL(fileURLWithPath: "/Users/test user/Applications/SafariAttractionApp.app")
        let stageDirPath = "/tmp/my's dir/sa-update-1234-ABCD"
        let newApp = URL(fileURLWithPath: "\(stageDirPath)/SafariAttractionApp.app")
        let script = installer.replaceScript(oldApp: oldApp, newApp: newApp, pid: 4242)

        XCTAssertTrue(script.contains("STAGE_DIR='/tmp/my'\\''s dir/sa-update-1234-ABCD'"))
        XCTAssertTrue(script.contains(#"rm -rf "$STAGE_DIR" 2>/dev/null || true"#))
        XCTAssertTrue(script.contains("trap cleanup EXIT"), "성공 · 되돌리기 · PID 대기 실패 모든 종료 경로에서 STAGE_DIR 을 정리해야 한다")

        // 생성된 스크립트가 /bin/sh 문법을 통과하고, 조기 실패(mv 실패) 종료에서도 STAGE_DIR 을 지운다.
        let dir = try tempDir()
        let managedStage = dir.appendingPathComponent("sa-update-\(UUID().uuidString)", isDirectory: true)
        let stagedApp = managedStage.appendingPathComponent("SafariAttractionApp.app", isDirectory: true)
        try FileManager.default.createDirectory(at: stagedApp, withIntermediateDirectories: true)
        let missingOldApp = dir.appendingPathComponent("MissingOld.app", isDirectory: true)
        let realScript = installer.replaceScript(oldApp: missingOldApp, newApp: stagedApp, pid: 999_999)
        let scriptFile = dir.appendingPathComponent("check.sh")
        try Data(realScript.utf8).write(to: scriptFile)

        let syntax = Process()
        syntax.executableURL = URL(fileURLWithPath: "/bin/sh")
        syntax.arguments = ["-n", scriptFile.path]
        try syntax.run()
        syntax.waitUntilExit()
        XCTAssertEqual(syntax.terminationStatus, 0)

        let run = Process()
        run.executableURL = URL(fileURLWithPath: "/bin/sh")
        run.arguments = [scriptFile.path]
        run.standardInput = FileHandle.nullDevice
        run.standardOutput = FileHandle.nullDevice
        run.standardError = FileHandle.nullDevice
        try run.run()
        run.waitUntilExit()
        XCTAssertEqual(run.terminationStatus, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: managedStage.path),
                       "조기 종료 경로에서도 STAGE_DIR 을 정리해야 한다")
    }

    func testSpawnReplaceScriptRemovesTemporaryScriptFileAfterExit() async throws {
        let dir = try tempDir()

        for (name, exitCode) in [("ok", 0), ("fail", 1)] {
            let marker = dir.appendingPathComponent("marker-\(name)")
            let script = """
            #!/bin/sh
            printf '%s' '\(name)' > \(UpdateInstaller.shellQuote(marker.path))
            exit \(exitCode)
            """
            try UpdateInstaller.spawnReplaceScript(script, in: dir)

            var finished = false
            for _ in 0..<60 {
                let hasMarker = FileManager.default.fileExists(atPath: marker.path)
                let leftovers = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil))?
                    .filter { $0.lastPathComponent.hasPrefix("sa-replace-") } ?? []
                if hasMarker && leftovers.isEmpty {
                    finished = true
                    break
                }
                try await Task.sleep(nanoseconds: 25_000_000)
            }
            XCTAssertTrue(finished, "실행이 끝난 sa-replace-*.sh 임시 스크립트 파일이 정리되어야 한다(\(name))")
        }
    }
}
