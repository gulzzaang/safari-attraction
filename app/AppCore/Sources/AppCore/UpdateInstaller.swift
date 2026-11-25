import Foundation

/// 업데이트 압축 풀기 · 검증 · 바꿔 넣기 준비 중 생기는 오류.
public enum UpdateInstallError: Error, Equatable, Sendable {
    case unzipFailed
    case appBundleNotFound
    case invalidInfoPlist
    case invalidBundleID
    case notNewerVersion
    case codesignFailed
    case certificateMismatch
    case notWritable
    case scriptLaunchFailed
}

/// 검증된 업데이트 zip 을 임시 폴더에 풀고 번들 · 버전 · 코드 서명을 확인하며,
/// 앱 종료 뒤 실행할 바꿔 넣기 `/bin/sh` 스크립트를 만든다.
public final class UpdateInstaller: Sendable {
    private let runnerFactory: @Sendable () -> CommandRunning
    private let stagingRoot: URL
    private let expectedBundleID: String
    private let systemPath: String

    public init(runnerFactory: @escaping @Sendable () -> CommandRunning = { ProcessRunner() },
                stagingRoot: URL = FileManager.default.temporaryDirectory,
                expectedBundleID: String = AppUpdate.bundleIdentifier,
                systemPath: String = "/usr/bin:/bin") {
        self.runnerFactory = runnerFactory
        self.stagingRoot = stagingRoot
        self.expectedBundleID = expectedBundleID
        self.systemPath = systemPath
    }

    public convenience init(runner: CommandRunning,
                            stagingRoot: URL = FileManager.default.temporaryDirectory,
                            expectedBundleID: String = AppUpdate.bundleIdentifier) {
        self.init(runnerFactory: { runner }, stagingRoot: stagingRoot, expectedBundleID: expectedBundleID)
    }

    /// zip 을 임시 폴더에 풀고 번들 ID · 버전 · `codesign --verify --strict` · 인증서 일치를 확인한 새 `.app` 경로를 돌려준다.
    public func prepare(zip: URL, current: AppVersion, currentAppURL: URL) async throws -> URL {
        let fm = FileManager.default
        let stageDir = stagingRoot.appendingPathComponent("sa-update-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: stageDir, withIntermediateDirectories: true)

        do {
            // 1. 압축 풀기(ditto -x -k)
            let unzip = await runCommand(executable: "/usr/bin/ditto",
                                         arguments: ["-x", "-k", zip.path, stageDir.path],
                                         workDir: stageDir)
            guard unzip.code == 0 else { throw UpdateInstallError.unzipFailed }

            // 2. 풀린 .app 찾기
            let newAppURL = try findAppBundle(in: stageDir)

            // 3. Info.plist 확인 — CFBundleIdentifier 와 CFBundleShortVersionString
            let plistURL = newAppURL.appendingPathComponent("Contents/Info.plist")
            guard let plistData = try? Data(contentsOf: plistURL),
                  let plist = try? PropertyListSerialization.propertyList(from: plistData, format: nil) as? [String: Any] else {
                throw UpdateInstallError.invalidInfoPlist
            }
            guard let bundleID = plist["CFBundleIdentifier"] as? String, bundleID == expectedBundleID else {
                throw UpdateInstallError.invalidBundleID
            }
            guard let versionStr = plist["CFBundleShortVersionString"] as? String,
                  let newVersion = AppVersion(versionStr),
                  newVersion > current else {
                throw UpdateInstallError.notNewerVersion
            }

            // 4. 새 앱 코드 서명 확인(`codesign --verify --strict`)
            let verify = await runCommand(executable: "/usr/bin/codesign",
                                          arguments: ["--verify", "--strict", newAppURL.path],
                                          workDir: stageDir)
            guard verify.code == 0 else { throw UpdateInstallError.codesignFailed }

            // 5. 지금 앱의 designated requirement 에 `certificate leaf` 가 있으면 새 앱도 같은 인증서인지 확인
            if let requirement = try await currentCertificateLeafRequirement(for: currentAppURL, workDir: stageDir) {
                let reqVerify = await runCommand(executable: "/usr/bin/codesign",
                                                 arguments: ["--verify", "--strict", "-R", "=\(requirement)", newAppURL.path],
                                                 workDir: stageDir)
                guard reqVerify.code == 0 else { throw UpdateInstallError.certificateMismatch }
            }

            return newAppURL
        } catch {
            try? fm.removeItem(at: stageDir)
            throw error
        }
    }

    /// 지금 앱 자리에 백업 이동과 새 앱 복사가 가능한지 확인한다.
    public func canReplace(at appURL: URL) -> Bool {
        let fm = FileManager.default
        let parent = appURL.deletingLastPathComponent()
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: parent.path, isDirectory: &isDir), isDir.boolValue else { return false }
        guard fm.isWritableFile(atPath: parent.path) else { return false }
        if fm.fileExists(atPath: appURL.path) && !fm.isWritableFile(atPath: appURL.path) {
            return false
        }
        // 실제 쓰기 권한(ACL · 읽기 전용 볼륨 등)을 빈 임시 파일로 확인하고 바로 지운다.
        let probe = parent.appendingPathComponent(".sa-update-write-probe-\(UUID().uuidString)")
        do {
            try Data().write(to: probe, options: .withoutOverwriting)
            try? fm.removeItem(at: probe)
            return true
        } catch {
            try? fm.removeItem(at: probe)
            return false
        }
    }

    /// 앱 종료 뒤 실행할 바꿔 넣기 `/bin/sh` 스크립트를 만든다.
    /// 모든 경로는 작은따옴표로 안전하게 감싼다.
    public func replaceScript(oldApp: URL, newApp: URL, pid: Int32) -> String {
        let qOld = Self.shellQuote(oldApp.path)
        let qNew = Self.shellQuote(newApp.path)
        let stageDir = newApp.standardizedFileURL.deletingLastPathComponent()
        let oldParent = oldApp.standardizedFileURL.deletingLastPathComponent()
        let hasManagedStageDir = stageDir.lastPathComponent.hasPrefix("sa-update-") && stageDir.path != oldParent.path
        let stageSetupBlock: String
        if hasManagedStageDir {
            let qStage = Self.shellQuote(stageDir.path)
            stageSetupBlock = """

            STAGE_DIR=\(qStage)
            cleanup() {
              rm -rf "$STAGE_DIR" 2>/dev/null || true
            }
            trap cleanup EXIT
            """
        } else {
            stageSetupBlock = ""
        }
        return """
        #!/bin/sh
        OLD_APP=\(qOld)
        NEW_APP=\(qNew)\(stageSetupBlock)
        BACKUP_APP="${OLD_APP}.backup-$$"
        APPEX="${OLD_APP}/\(AppUpdate.extensionRelativePath)"
        PID=\(pid)

        i=0
        while [ "$i" -lt 60 ]; do
          if ! kill -0 "$PID" 2>/dev/null; then
            break
          fi
          sleep 0.5
          i=$((i + 1))
        done
        if kill -0 "$PID" 2>/dev/null; then
          exit 1
        fi

        rollback() {
          if [ -e "$BACKUP_APP" ]; then
            rm -rf "$OLD_APP" 2>/dev/null || true
            mv "$BACKUP_APP" "$OLD_APP" 2>/dev/null || true
          fi
          env -i HOME="$HOME" USER="$USER" PATH=/usr/bin:/bin open "$OLD_APP" >/dev/null 2>&1 || true
          exit 1
        }

        rm -rf "$BACKUP_APP" 2>/dev/null || true
        mv "$OLD_APP" "$BACKUP_APP" || exit 1
        /usr/bin/ditto "$NEW_APP" "$OLD_APP" || rollback
        /usr/bin/xattr -cr "$OLD_APP" || rollback
        if [ -d "$APPEX" ]; then
          /usr/bin/pluginkit -a "$APPEX" || rollback
        fi
        env -i HOME="$HOME" USER="$USER" PATH=/usr/bin:/bin open "$OLD_APP" || rollback
        rm -rf "$BACKUP_APP" 2>/dev/null || true
        """
    }

    /// 스크립트 문자열을 임시 파일로 저장하고 `/bin/sh` 를 분리 실행한다(기다리지 않고 바로 돌아온다).
    /// 실행이 끝나면 성공 · 실패 여부와 관계없이 임시 `sa-replace-*.sh` 파일을 지운다.
    public static func spawnReplaceScript(_ script: String, in directory: URL = FileManager.default.temporaryDirectory) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let scriptURL = directory.appendingPathComponent("sa-replace-\(UUID().uuidString).sh")
        try Data(script.utf8).write(to: scriptURL, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: scriptURL.path)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [
            "-c",
            #"script_path="$1"; trap 'rm -f "$script_path" 2>/dev/null || true' EXIT; /bin/sh "$script_path""#,
            "_",
            scriptURL.path,
        ]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            try? fm.removeItem(at: scriptURL)
            throw UpdateInstallError.scriptLaunchFailed
        }
    }

    /// POSIX `/bin/sh` 용 작은따옴표 감싸기.
    public static func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    // MARK: - 내부

    private func findAppBundle(in stageDir: URL) throws -> URL {
        let preferred = stageDir.appendingPathComponent("SafariAttractionApp.app", isDirectory: true)
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: preferred.path, isDirectory: &isDir), isDir.boolValue {
            return preferred
        }
        let entries = (try? FileManager.default.contentsOfDirectory(at: stageDir, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
        if let app = entries.first(where: { $0.pathExtension == "app" }) {
            return app
        }
        throw UpdateInstallError.appBundleNotFound
    }

    private func currentCertificateLeafRequirement(for currentAppURL: URL, workDir: URL) async throws -> String? {
        let result = await runCommand(executable: "/usr/bin/codesign",
                                      arguments: ["-d", "-r-", currentAppURL.path],
                                      workDir: workDir)
        guard result.code == 0 else {
            // 서명되지 않은 개발 실행 파일이면 ad-hoc 과 마찬가지로 1~3 단계만 본다.
            if result.stderr.lowercased().contains("not signed") { return nil }
            throw UpdateInstallError.codesignFailed
        }
        let combined = result.stdout + "\n" + result.stderr
        for rawLine in combined.split(whereSeparator: \.isNewline) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let range = line.range(of: "designated =>") else { continue }
            let req = line[range.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
            if req.contains("certificate leaf") {
                return req
            }
            return nil
        }
        return nil
    }

    private struct CommandResult {
        let code: Int32
        let stdout: String
        let stderr: String
    }

    private func runCommand(executable: String, arguments: [String], workDir: URL) async -> CommandResult {
        final class OutputBox: @unchecked Sendable {
            private let lock = NSLock()
            private var out = Data()
            private var err = Data()
            func append(_ event: RunEvent) {
                lock.withLock {
                    switch event {
                    case .stdout(let d): out.append(d)
                    case .stderr(let d): err.append(d)
                    }
                }
            }
            func strings() -> (String, String) {
                lock.withLock {
                    (String(decoding: out, as: UTF8.self), String(decoding: err, as: UTF8.self))
                }
            }
        }

        let box = OutputBox()
        let runner = runnerFactory()
        let outcome = await runner.run(executable: executable,
                                       arguments: arguments,
                                       workDir: workDir,
                                       path: systemPath,
                                       timeout: 120,
                                       onEvent: { box.append($0) })
        let (stdout, stderr) = box.strings()
        switch outcome {
        case .finished(let code):
            return CommandResult(code: code, stdout: stdout, stderr: stderr)
        default:
            return CommandResult(code: -1, stdout: stdout, stderr: stderr)
        }
    }
}
