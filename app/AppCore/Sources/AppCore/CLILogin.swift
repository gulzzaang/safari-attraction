import Foundation

/// 터미널을 열어 로그인하게 하는 `.command` 파일 — 앱 전용 환경 + 명령. (열기는 앱 쪽이 `NSWorkspace.open` 으로 — Apple 이벤트 없음)
public enum TerminalLogin {
    /// 작은따옴표로 안전하게 감싼다(`'` 는 `'\''`). 공백 · `$` · 따옴표가 있어도 글자 그대로.
    public static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// `#!/bin/zsh -l` + export 환경(이름순) + 명령 + 안내 한 줄.
    public static func script(environment: [String: String], command: [String]) -> String {
        var lines = ["#!/bin/zsh -l", "# 사파리-어트랙션 — 앱 전용 로그인(이 창에서 한 번만 하면 돼요)"]
        for key in environment.keys.sorted() {
            lines.append("export \(key)=\(shellQuote(environment[key] ?? ""))")
        }
        lines.append(command.map(shellQuote).joined(separator: " "))
        lines.append("echo")
        lines.append("echo \"끝나면 이 창을 닫으세요.\"")
        return lines.joined(separator: "\n") + "\n"
    }

    /// 파일을 쓰고 실행 권한(0755)을 준다. 같은 이름이 있으면 바꾼다. 돌려주는 것은 파일 주소.
    public static func writeCommandFile(directory: URL, name: String, environment: [String: String], command: [String]) throws -> URL {
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(name)
        try script(environment: environment, command: command).write(to: url, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        return url
    }

    /// 이 CLI 의 로그인 `.command` 파일을 지원 폴더에 쓴다(클로드 `claude auth login --claudeai` · codex `codex login --device-auth`).
    public static func writeLoginFile(kind: ModelKind, support: URL) throws -> URL {
        let cmd: CLICommands.Command
        let name: String
        switch kind {
        case .claude: cmd = CLICommands.claudeLogin; name = "login-claude.command"
        case .chatgpt: cmd = CLICommands.codexDeviceLogin; name = "login-codex.command"
        case .gemini: throw CocoaError(.featureUnsupported)
        }
        try CLIEnvironment.prepareDirectories(support: support)
        return try writeCommandFile(directory: support, name: name,
                                    environment: CLIEnvironment.environment(for: kind, support: support),
                                    command: [cmd.executable] + cmd.arguments)
    }
}

/// `codex login --device-auth` 출력에서 읽은 주소와 일회용 코드.
public struct DeviceAuthPrompt: Equatable, Sendable {
    public var url: URL
    public var code: String
    public init(url: URL, code: String) { self.url = url; self.code = code }
}

public enum DeviceAuthParser {
    /// 색 · 커서 제어 글자(ANSI)를 지운다.
    public static func stripANSI(_ s: String) -> String {
        s.replacingOccurrences(of: #"\x{1B}\[[0-9;?]*[ -/]*[@-~]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\x{1B}\][^\x{07}\x{1B}]*(\x{07}|\x{1B}\\)"#, with: "", options: .regularExpression)
    }

    /// 주소(https · openai.com / chatgpt.com 아래)와 코드(「ABCD-12345」 모양)를 둘 다 찾아야 돌려준다.
    public static func parse(_ raw: String) -> DeviceAuthPrompt? {
        let text = stripANSI(raw)
        guard let urlRange = text.range(of: #"https://[^\s)\]>"'<]+"#, options: .regularExpression) else { return nil }
        let urlText = String(text[urlRange]).trimmingCharacters(in: CharacterSet(charactersIn: ".,;"))
        guard let url = URL(string: urlText), url.scheme == "https", let host = url.host?.lowercased(),
              host == "openai.com" || host.hasSuffix(".openai.com") || host == "chatgpt.com" || host.hasSuffix(".chatgpt.com") else { return nil }
        let rest = text.replacingCharacters(in: urlRange, with: " ")
        guard let codeRange = rest.range(of: #"\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b"#, options: .regularExpression) else { return nil }
        return DeviceAuthPrompt(url: url, code: String(rest[codeRange]))
    }
}

public enum DeviceLoginState: Equatable, Sendable {
    case idle
    /// 띄웠고 주소 · 코드를 기다리는 중.
    case starting
    case waiting(DeviceAuthPrompt)
    case succeeded
    case failed(String)
    /// 출력 모양을 못 읽었다 — 같은 명령을 터미널로 연다.
    case needsTerminal
}

/// `codex login --device-auth` 를 앱이 띄워 주소 · 코드를 설정 창에 보여 주는 흐름.
/// 끝나면(프로세스 종료 0) `succeeded` — 부르는 쪽이 상태를 새로 고친다. 주소 · 코드 값은 기록하지 않는다.
@MainActor @Observable
public final class CodexDeviceLogin {
    public static let parseDeadline: TimeInterval = 10

    public private(set) var state: DeviceLoginState = .idle
    @ObservationIgnored public var onFinished: (@MainActor (_ success: Bool) -> Void)?

    @ObservationIgnored private let runner: CommandRunning
    @ObservationIgnored private let loginPath: @Sendable () -> String
    @ObservationIgnored private let workDirectory: @Sendable () throws -> URL
    @ObservationIgnored private let sleep: @Sendable (TimeInterval) async throws -> Void
    @ObservationIgnored private let timeout: TimeInterval
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var task: Task<Void, Never>?

    public init(runner: CommandRunning, loginPath: @escaping @Sendable () -> String,
                workDirectory: @escaping @Sendable () throws -> URL = { try AppPaths.workDirectory() },
                timeout: TimeInterval = CLICommands.deviceLoginTimeout,
                sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }) {
        self.runner = runner; self.loginPath = loginPath; self.workDirectory = workDirectory
        self.timeout = timeout; self.sleep = sleep
    }

    public var isActive: Bool {
        switch state { case .starting, .waiting: return true; default: return false }
    }

    private final class Collector: @unchecked Sendable {
        private let lock = NSLock()
        private var text = ""
        private var found = false
        /// 처음으로 주소 · 코드가 다 읽히면 돌려준다.
        func add(_ d: Data) -> DeviceAuthPrompt? {
            lock.withLock {
                text += String(decoding: d, as: UTF8.self)
                if text.count > 20_000 { text = String(text.suffix(10_000)) }
                guard !found, let p = DeviceAuthParser.parse(text) else { return nil }
                found = true
                return p
            }
        }
    }

    /// 로그인을 시작한다. 이미 도는 중이면 아무 일도 없다.
    public func start() {
        guard !isActive else { return }
        generation += 1
        let gen = generation
        state = .starting
        let collector = Collector()
        let runner = self.runner, loginPath = self.loginPath, workDirectory = self.workDirectory, timeout = self.timeout
        let sleep = self.sleep
        task = Task { [weak self] in
            let prepared: (String, URL)? = await Task.detached(priority: .userInitiated) {
                guard let dir = try? workDirectory() else { return nil }
                return (loginPath(), dir)
            }.value
            guard let (path, dir) = prepared else {
                await MainActor.run { self?.finish(gen, .failed("작업 폴더를 만들지 못했어요")) }
                return
            }
            // 주소 · 코드를 기다리는 10초는 로그인 PATH 를 읽은 뒤, 프로세스를 띄우기 직전부터 센다.
            let deadline = Task { [weak self] in
                do { try await sleep(Self.parseDeadline) } catch { return }
                await MainActor.run {
                    guard let self, self.generation == gen, self.state == .starting else { return }
                    self.state = .needsTerminal
                    self.runner.stop()
                }
            }
            let cmd = CLICommands.codexDeviceLogin
            let outcome = await runner.run(executable: cmd.executable, arguments: cmd.arguments, workDir: dir, path: path,
                                           timeout: timeout) { event in
                let data: Data
                switch event { case .stdout(let d), .stderr(let d): data = d }
                if let prompt = collector.add(data) {
                    Task { @MainActor in
                        guard let self, self.generation == gen, self.state == .starting else { return }
                        self.state = .waiting(prompt)
                    }
                }
            }
            deadline.cancel()
            await MainActor.run { self?.handleOutcome(outcome, gen) }
        }
    }

    /// 도는 중이면 멈춘다.
    public func cancel() {
        guard isActive else { return }
        generation += 1
        state = .idle
        runner.stop()
    }

    private func handleOutcome(_ outcome: RunOutcome, _ gen: Int) {
        guard generation == gen else { return }
        switch outcome {
        case .finished(let code) where code == 0:
            finish(gen, .succeeded)
        case .stopped:
            if state != .needsTerminal { state = .idle }
        case .notFound:
            finish(gen, .failed(ModelKind.chatgpt.notFoundMessage))
        case .timedOut:
            finish(gen, .failed("로그인이 끝나지 않아 멈췄어요 — 다시 시도해 주세요"))
        case .finished:
            switch state {
            case .needsTerminal: return
            case .starting:
                // 주소 · 코드를 읽기 전에 codex 가 오류로 끝났다(예: 계정에서 기기 코드 로그인을 안 켬) — 터미널로 열어 codex 자신의 안내를 보여 준다.
                state = .needsTerminal
            default:
                finish(gen, .failed("로그인이 끝나지 않았어요 — 다시 시도하거나 터미널로 해 주세요"))
            }
        case .failed:
            if state == .needsTerminal { return }
            finish(gen, .failed("로그인이 끝나지 않았어요 — 다시 시도하거나 터미널로 해 주세요"))
        }
    }

    private func finish(_ gen: Int, _ new: DeviceLoginState) {
        guard generation == gen else { return }
        state = new
        onFinished?(new == .succeeded)
    }
}
