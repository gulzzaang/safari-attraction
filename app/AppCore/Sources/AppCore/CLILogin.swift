import Foundation

/// 터미널을 열어 로그인하게 하는 `.command` 파일 — 앱 전용 환경 + 명령. (열기는 앱 쪽이 `NSWorkspace.open` 으로 — Apple 이벤트 없음)
public enum TerminalLogin {
    /// 작은따옴표로 안전하게 감싼다(`'` 는 `'\''`). 공백 · `$` · 따옴표가 있어도 글자 그대로.
    public static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// `echo "글"` — 따옴표 · `$` · 역따옴표 · 역슬래시가 든 글이면 작은따옴표로 감싼다.
    static func echoLine(_ text: String) -> String {
        let special = CharacterSet(charactersIn: "\"$`\\")
        return text.rangeOfCharacter(from: special) == nil ? "echo \"\(text)\"" : "echo \(shellQuote(text))"
    }

    /// `#!/bin/zsh -l` + export 환경(이름순) + (명령 전에 보일 안내) + 명령 + 안내 한 줄.
    /// `beforeNote` 는 명령 **앞에** 찍는다 — agy 처럼 명령이 창을 통째로 차지하는 TUI 면 뒤에 찍은 안내는 늦게 보이기 때문이다.
    public static func script(environment: [String: String], command: [String], beforeNote: String? = nil,
                              closingNote: String = "끝나면 이 창을 닫으세요.", unsetVariables: [String] = []) -> String {
        var lines = ["#!/bin/zsh -l", "# 사파리-어트랙션 — 앱 전용 로그인(이 창에서 한 번만 하면 돼요)"]
        if !unsetVariables.isEmpty { lines.append("unset " + unsetVariables.sorted().joined(separator: " ")) }   // 로그인 셸이 키를 내보냈어도 구독 로그인이 키로 바뀌지 않게
        for key in environment.keys.sorted() {
            lines.append("export \(key)=\(shellQuote(environment[key] ?? ""))")
        }
        if let beforeNote {
            lines.append(echoLine(beforeNote))
            lines.append("echo")
        }
        lines.append(command.map(shellQuote).joined(separator: " "))
        lines.append("echo")
        lines.append(echoLine(closingNote))
        return lines.joined(separator: "\n") + "\n"
    }

    /// 파일을 쓰고 실행 권한(0755)을 준다. 같은 이름이 있으면 바꾼다. 돌려주는 것은 파일 주소.
    public static func writeCommandFile(directory: URL, name: String, environment: [String: String], command: [String],
                                        beforeNote: String? = nil, closingNote: String = "끝나면 이 창을 닫으세요.",
                                        unsetVariables: [String] = []) throws -> URL {
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(name)
        try script(environment: environment, command: command, beforeNote: beforeNote, closingNote: closingNote, unsetVariables: unsetVariables)
            .write(to: url, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        return url
    }

    /// agy 는 로그인 명령이 없어 `agy` 를 인자 없이 띄우면 TUI 가 창을 차지한다 — 띄우기 전에 끝내는 법을 알린다.
    public static let agyBeforeNote = "제미나이(agy) 로그인 — 곧 agy 화면이 열려요. 로그인을 마친 뒤 /quit 을 입력해 끝내고 이 창을 닫으세요."
    public static let agyClosingNote = "agy 를 끝냈다면 이 창을 닫으세요. 설정 창으로 돌아가면 로그인 상태를 새로 읽어요."
    /// opencode 는 평소 로그인 DB(`~/.local/share/opencode/opencode.db`)를 함께 쓴다.
    public static let opencodeBeforeNote = "로그인할 때 OpenCode Go 를 고르세요. 이 로그인은 터미널의 opencode 에도 그대로 남아요"

    /// 이 CLI 의 로그인 `.command` 파일을 지원 폴더에 쓴다(클로드 `claude auth login --claudeai` · codex `codex login --device-auth` ·
    /// 제미나이 `agy`(인자 없이, 평소 HOME) · opencode `opencode auth login --standalone`(평소 로그인 DB 함께 씀)).
    /// `loginPath`(앱이 읽은 로그인 PATH)가 있으면 `.command` 가 그 PATH 를 export 하고, 찾은 절대 경로로 부른다(터미널 PATH 가 달라도 같은 CLI 가 돈다).
    /// 키 값 환경변수는 `unset` 한다.
    public static func writeLoginFile(kind: ModelKind, support: URL, loginPath: String? = nil) throws -> URL {
        let cmd: CLICommands.Command
        let name: String
        var before: String?
        var closing = "끝나면 이 창을 닫으세요."
        switch kind {
        case .claude: cmd = CLICommands.claudeLogin; name = "login-claude.command"
        case .chatgpt: cmd = CLICommands.codexDeviceLogin; name = "login-codex.command"
        case .gemini:
            cmd = CLICommands.agyLogin; name = "login-agy.command"
            before = agyBeforeNote; closing = agyClosingNote
        case .opencode:
            cmd = CLICommands.opencodeLogin; name = "login-opencode.command"
            before = opencodeBeforeNote
        }
        try CLIEnvironment.prepareDirectories(support: support)
        var env = CLIEnvironment.environment(for: kind, support: support)
        var executable = cmd.executable
        if let loginPath, !loginPath.isEmpty {
            env["PATH"] = loginPath
            if let found = ProcessRunner.resolve(cmd.executable, path: loginPath) { executable = found }
        }
        return try writeCommandFile(directory: support, name: name, environment: env,
                                    command: [executable] + cmd.arguments, beforeNote: before, closingNote: closing,
                                    unsetVariables: ProcessRunner.strippedAPIKeyVariables.sorted())
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
