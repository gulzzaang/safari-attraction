import Foundation
import Observation

/// 한 번 실행해 나온 글을 모은 것(상태 · 목록 · 남은 양 읽기용).
public struct CapturedRun: Sendable {
    public var outcome: RunOutcome
    public var stdout: String
    public var stderr: String
}

private final class CaptureBox: @unchecked Sendable {
    private let lock = NSLock()
    private var out = Data(), err = Data()
    func add(_ e: RunEvent) {
        lock.withLock {
            switch e {
            case .stdout(let d): if out.count < 2_000_000 { out.append(d) }
            case .stderr(let d): if err.count < 200_000 { err.append(d) }
            }
        }
    }
    var result: (String, String) { lock.withLock { (String(decoding: out, as: UTF8.self), String(decoding: err, as: UTF8.self)) } }
}

public enum CLICapture {
    /// 명령을 한 번 돌려 글을 모은다(시간 상한 안에서 — 넘으면 `.timedOut`). 표준 입력은 `/dev/null`.
    public static func run(runner: CommandRunning, command: CLICommands.Command, workDir: URL, path: String,
                           timeout: TimeInterval = CLICommands.readTimeout) async -> CapturedRun {
        let box = CaptureBox()
        let outcome = await runner.run(executable: command.executable, arguments: command.arguments, workDir: workDir,
                                       path: path, timeout: timeout) { box.add($0) }
        let (o, e) = box.result
        return CapturedRun(outcome: outcome, stdout: o, stderr: e)
    }
}

/// 서비스가 띄울 실행기 — 읽기 작업마다 새로 만든다(`ProcessRunner` 는 한 번에 하나만 돌리므로, 돌고 있는 질문과 부딪히지 않게).
public typealias CLIRunner = CommandRunning & InteractiveRunning

/// CLI 하나의 지금 모습(설정 창 · 옆 창이 읽는다).
public struct CLIState: Equatable, Sendable {
    /// 로그인 셸 PATH 로 찾은 실행 파일 경로(없으면 nil — `installChecked` 로 「없음」 과 「아직」 을 가른다).
    public var installedPath: String?
    public var installChecked = false
    public var login: CLILoginState = .unknown
    /// 로그인 상태를 못 알아냈을 때의 이유(「알 수 없음」 옆 작은 글).
    public var loginNote: String?
    public var usage: UsageSnapshot?
    public var usageNote: String?
    /// 고를 수 있는 모델(codex 는 로그인 뒤 불러온 목록 · 클로드는 고정 목록).
    public var models: [ModelChoice] = []
    public var modelsNote: String?
    public var isRefreshing = false
    public var lastRefresh: Date?
    public init() {}

    public var isLoggedIn: Bool { if case .loggedIn = login { return true }; return false }
    public var isLoggedOut: Bool { login == .loggedOut }
}

/// CLI 마다 설치 여부 · 로그인 상태 · 모델 목록 · 남은 양을 모은다. **앱을 켤 때는 부르지 않고**, 설정 창 · 옆 창을 열 때만 부른다.
/// 읽기 하나당 20초 상한, 실패하면 「알 수 없음」. 같은 CLI 는 `minInterval`(5분) 안에 다시 읽지 않는다(`force` 면 읽는다).
@MainActor @Observable
public final class CLIStatusService {
    public static let minInterval: TimeInterval = 300

    public private(set) var states: [ModelKind: CLIState]

    @ObservationIgnored private let loginPath: @Sendable () -> String
    @ObservationIgnored private let runnerFactory: @Sendable () -> any CLIRunner
    @ObservationIgnored private let workDirectory: @Sendable () throws -> URL
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let timeout: TimeInterval
    @ObservationIgnored private let minInterval: TimeInterval
    @ObservationIgnored private var inFlight: Set<ModelKind> = []

    public init(loginPath: @escaping @Sendable () -> String,
                runnerFactory: @escaping @Sendable () -> any CLIRunner,
                workDirectory: @escaping @Sendable () throws -> URL = { try AppPaths.workDirectory() },
                now: @escaping @Sendable () -> Date = { Date() },
                timeout: TimeInterval = CLICommands.readTimeout,
                minInterval: TimeInterval = CLIStatusService.minInterval) {
        self.loginPath = loginPath; self.runnerFactory = runnerFactory; self.workDirectory = workDirectory
        self.now = now; self.timeout = timeout; self.minInterval = minInterval
        var s: [ModelKind: CLIState] = [:]
        for k in ModelKind.subscriptionCLIs { s[k] = CLIState() }
        s[.claude]?.models = CLIModels.claudeChoices
        states = s
    }

    public func state(_ kind: ModelKind) -> CLIState { states[kind] ?? CLIState() }

    /// 고를 수 있는 모델 목록.
    public func models(for kind: ModelKind) -> [ModelChoice] {
        kind == .claude ? CLIModels.claudeChoices : state(kind).models
    }

    /// 옆 창을 열 때 — **고른 CLI 만** 읽는다(5분 안이면 읽지 않음). 쓰지 않는 CLI 를 띄우지 않으려고(agy · opencode 는 상태를 읽는 것만으로도 프로세스를 띄운다).
    /// 설정 창은 `refreshAll` 로 넷 모두 읽는다.
    public func refreshForPanel(selected: ModelKind) async {
        await refresh(selected, force: false)
    }

    /// 클로드 답 도중에 받은 한도(`rate_limit_event`)를 지금 값에 합친다 — 같은 이름의 창은 바꾸고, 없던 창은 더한다. 읽는 시각 · 5분 간격은 건드리지 않는다.
    public func applyLiveUsage(_ kind: ModelKind, _ snapshot: UsageSnapshot) {
        guard ModelKind.subscriptionCLIs.contains(kind), !snapshot.windows.isEmpty else { return }
        var s = states[kind] ?? CLIState()
        var merged = s.usage ?? UsageSnapshot()
        for w in snapshot.windows {
            if let i = merged.windows.firstIndex(where: { $0.name == w.name }) { merged.windows[i] = w } else { merged.windows.append(w) }
        }
        s.usage = merged
        s.usageNote = nil
        states[kind] = s
    }

    public func refreshAll(force: Bool) async {
        await withTaskGroup(of: Void.self) { group in
            for k in ModelKind.subscriptionCLIs { group.addTask { await self.refresh(k, force: force) } }
        }
    }

    /// 한 CLI 를 새로 읽는다. 5분 안이면(force 가 아니면) 아무것도 하지 않는다. 이미 읽는 중이어도 마찬가지.
    public func refresh(_ kind: ModelKind, force: Bool) async {
        guard ModelKind.subscriptionCLIs.contains(kind), !inFlight.contains(kind) else { return }
        if !force, let last = states[kind]?.lastRefresh, now().timeIntervalSince(last) < minInterval { return }
        inFlight.insert(kind)
        states[kind]?.isRefreshing = true
        defer { inFlight.remove(kind); states[kind]?.isRefreshing = false }

        let loginPath = self.loginPath, workDirectory = self.workDirectory, factory = self.runnerFactory, timeout = self.timeout
        let result = await Task.detached(priority: .userInitiated) {
            await Self.read(kind: kind, loginPath: loginPath, workDirectory: workDirectory, runnerFactory: factory, timeout: timeout)
        }.value
        var s = states[kind] ?? CLIState()
        s.installChecked = true
        s.installedPath = result.installedPath
        s.login = result.login
        s.loginNote = result.loginNote
        s.usage = result.usage
        s.usageNote = result.usageNote
        if kind != .claude { s.models = result.models; s.modelsNote = result.modelsNote }
        s.lastRefresh = now()
        states[kind] = s
    }

    struct ReadResult: Sendable {
        var installedPath: String?
        var login: CLILoginState = .unknown
        var loginNote: String?
        var usage: UsageSnapshot?
        var usageNote: String?
        var models: [ModelChoice] = []
        var modelsNote: String?
    }

    /// 실제 읽기(메인 밖). 각 단계가 실패해도 다음 단계로 — 모두 「알 수 없음」 으로 끝난다.
    nonisolated static func read(kind: ModelKind, loginPath: @Sendable () -> String, workDirectory: @Sendable () throws -> URL,
                                 runnerFactory: @Sendable () -> any CLIRunner, timeout: TimeInterval) async -> ReadResult {
        var r = ReadResult()
        let path = loginPath()
        let name = kind.cliName
        r.installedPath = ProcessRunner.resolve(name, path: path)
        guard r.installedPath != nil else {
            r.loginNote = "\(name) 를 찾지 못했어요 — 설치돼 있는지 확인해 주세요"
            r.usageNote = "알 수 없음"
            if kind != .claude { r.modelsNote = Self.modelsNote(kind) }
            return r
        }
        guard let dir = try? workDirectory() else {
            r.loginNote = "작업 폴더를 만들지 못했어요"; r.usageNote = "알 수 없음"
            return r
        }
        switch kind {
        case .claude, .chatgpt: await readClaudeOrCodex(kind, into: &r, path: path, dir: dir, runnerFactory: runnerFactory, timeout: timeout)
        case .gemini: await readAgy(into: &r, path: path, dir: dir, runnerFactory: runnerFactory, timeout: timeout)
        case .opencode: await readOpenCode(into: &r, path: path, dir: dir, runnerFactory: runnerFactory, timeout: timeout)
        }
        return r
    }

    nonisolated static func modelsNote(_ kind: ModelKind) -> String {
        kind == .opencode ? "모델 목록을 불러오지 못했어요 — 새로 고침을 눌러 주세요" : CLIModels.codexLoadFailureNote
    }

    nonisolated static func readClaudeOrCodex(_ kind: ModelKind, into r: inout ReadResult, path: String, dir: URL,
                                              runnerFactory: @Sendable () -> any CLIRunner, timeout: TimeInterval) async {
        // 1) 로그인 상태
        let statusCmd = kind == .claude ? CLICommands.claudeAuthStatus : CLICommands.codexLoginStatus
        let status = await CLICapture.run(runner: runnerFactory(), command: statusCmd, workDir: dir, path: path, timeout: timeout)
        switch status.outcome {
        case .finished(let code):
            r.login = kind == .claude
                ? CLIAccountParser.parseClaudeStatus(stdout: status.stdout, exitCode: code)
                : CLIAccountParser.parseCodexStatus(output: status.stdout + "\n" + status.stderr, exitCode: code)
        case .timedOut: r.loginNote = "알 수 없음 — \(Int(timeout))초 안에 답이 없었어요"
        default: r.loginNote = "알 수 없음 — 상태를 읽지 못했어요"
        }
        guard r.login != .unknown else { r.usageNote = "알 수 없음"; if kind == .chatgpt { r.modelsNote = CLIModels.codexLoadFailureNote }; return }
        guard case .loggedIn = r.login else {
            r.usageNote = "로그인하면 보여요"
            if kind == .chatgpt { r.modelsNote = CLIModels.codexLoadFailureNote }
            return
        }

        // 2) 모델 목록(codex 만 — 로그인 뒤에 불러야 계정에 맞는 목록이 나온다)
        if kind == .chatgpt {
            let m = await CLICapture.run(runner: runnerFactory(), command: CLICommands.codexModels, workDir: dir, path: path, timeout: timeout)
            if case .finished(0) = m.outcome { r.models = CLIModels.parseCodexModels(m.stdout) }
            if r.models.isEmpty { r.modelsNote = CLIModels.codexLoadFailureNote }
        }

        // 3) 남은 양
        if kind == .claude {
            let u = await CLICapture.run(runner: runnerFactory(), command: CLICommands.claudeUsage, workDir: dir, path: path, timeout: timeout)
            if case .finished(0) = u.outcome, let snap = ClaudeUsageParser.parse(jsonOutput: u.stdout) { r.usage = snap }
        } else {
            r.usage = await CodexUsageClient().fetch(runner: runnerFactory(), path: path, workDir: dir, timeout: timeout)
            if case .loggedIn(var info) = r.login, let plan = r.usage?.plan, info.plan == nil {
                info.plan = plan
                r.login = .loggedIn(info)
            }
        }
        if r.usage == nil { r.usageNote = "알 수 없음" }
    }

    /// agy — `agy models` 한 번이 로그인 상태이자 모델 목록이다. 로그인됐을 때만 `/usage`(모델 호출 아님)를 읽는다.
    nonisolated static func readAgy(into r: inout ReadResult, path: String, dir: URL,
                                    runnerFactory: @Sendable () -> any CLIRunner, timeout: TimeInterval) async {
        let m = await CLICapture.run(runner: runnerFactory(), command: CLICommands.agyModels, workDir: dir, path: path, timeout: timeout)
        switch m.outcome {
        case .finished(let code):
            let parsed = CLIAccountParser.parseAgyStatus(stdout: m.stdout, stderr: m.stderr, exitCode: code)
            r.login = parsed.state
            r.models = parsed.models
            if parsed.state == .unknown { r.loginNote = "알 수 없음 — 모델 목록을 읽지 못했어요" }
        case .timedOut: r.loginNote = "알 수 없음 — \(Int(timeout))초 안에 답이 없었어요"
        default: r.loginNote = "알 수 없음 — 상태를 읽지 못했어요"
        }
        if r.models.isEmpty { r.modelsNote = CLIModels.codexLoadFailureNote }
        guard case .loggedIn = r.login else {
            r.usageNote = r.login == .loggedOut ? "로그인하면 보여요" : "알 수 없음"
            return
        }
        let u = await CLICapture.run(runner: runnerFactory(), command: CLICommands.agyUsage, workDir: dir, path: path, timeout: timeout)
        if case .finished(0) = u.outcome, let snap = AgyUsageParser.parse(streamOutput: u.stdout) { r.usage = snap }
        if r.usage == nil { r.usageNote = "알 수 없음" }
    }

    /// opencode — 로그인 없이도 무료 모델은 되므로, 로그인 상태와 상관없이 모델 목록과 이 맥에서 쓴 양을 읽는다. 구독 남은 양은 못 얻는다.
    nonisolated static func readOpenCode(into r: inout ReadResult, path: String, dir: URL,
                                         runnerFactory: @Sendable () -> any CLIRunner, timeout: TimeInterval) async {
        let a = await CLICapture.run(runner: runnerFactory(), command: CLICommands.opencodeAuthList, workDir: dir, path: path, timeout: timeout)
        switch a.outcome {
        case .finished(let code): r.login = CLIAccountParser.parseOpenCodeStatus(output: a.stdout + "\n" + a.stderr, exitCode: code)
        case .timedOut: r.loginNote = "알 수 없음 — \(Int(timeout))초 안에 답이 없었어요"
        default: r.loginNote = "알 수 없음 — 상태를 읽지 못했어요"
        }
        if r.login == .unknown, r.loginNote == nil { r.loginNote = "알 수 없음 — 상태를 읽지 못했어요" }

        let m = await CLICapture.run(runner: runnerFactory(), command: CLICommands.opencodeModels, workDir: dir, path: path, timeout: timeout)
        if case .finished(0) = m.outcome { r.models = CLIModels.parseOpenCodeModels(m.stdout) }
        if r.models.isEmpty { r.modelsNote = modelsNote(.opencode) }

        let st = await CLICapture.run(runner: runnerFactory(), command: CLICommands.opencodeStats, workDir: dir, path: path, timeout: timeout)
        if case .finished(0) = st.outcome { r.usage = OpenCodeStatsParser.parse(jsonOutput: st.stdout) }
        r.usageNote = OpenCodeStatsParser.noteText
    }
}
