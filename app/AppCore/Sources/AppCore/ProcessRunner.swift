import Foundation
import Darwin

public enum RunEvent: Sendable, Equatable {
    case stdout(Data)
    case stderr(Data)
}

public enum RunnerWriteError: Error, Equatable {
    /// 자식이 표준 입력을 읽지 않아 파이프가 오래 꽉 차 있다.
    case stalled
}

public enum RunOutcome: Sendable, Equatable {
    /// 종료 코드. 신호로 죽었으면 128 + 신호 번호.
    case finished(code: Int32)
    case timedOut
    case stopped
    /// 실행 파일을 PATH 에서 못 찾음(이름).
    case notFound(String)
    case failed(String)
}

/// CLI 를 셸 없이(인자 배열 그대로) 띄우고, 시간 상한 · 멈춤 · 작업 취소로 확실히 끝낸다.
///
/// - 자식은 **자기만의 프로세스 그룹**으로 띄운다(`posix_spawn` + `POSIX_SPAWN_SETPGROUP`). 멈춤 · 시간 초과는
///   그룹 전체에 SIGTERM, `killGrace`(기본 2초) 뒤에도 남아 있으면 SIGKILL. 자식이 끝난 뒤(정상이어도)
///   그룹에 남은 손자 · 백그라운드 프로세스는 SIGKILL 로 치우고, 좀비는 `waitpid` 로 거둔다 — 고아 · 좀비 없음.
/// - 표준 입력은 기본이 `/dev/null`. `runInteractive` 로 띄우면 파이프를 열어 `write` · `closeInput` 으로
///   줄을 보낼 수 있다(클로드 stream-json 양방향용). 표준 출력 · 오류는 모아 두지 않고 읽는 대로 `onEvent` 로 넘기므로
///   끝없는 출력도 메모리를 키우지 않는다. `onEvent` 는 내부의 한 줄짜리 큐에서 순서대로 불린다
///   (`run` 이 돌아오기 전에 모두 전달됨).
/// - 한 객체로 한 번에 하나만 돌린다(끝난 뒤 다시 `run` 가능).
public final class ProcessRunner: @unchecked Sendable {
    /// 시간 상한(초) — 설계 값.
    public static let defaultTimeout: TimeInterval = 180

    private enum Reason { case timedOut, stopped, inputFailed }

    private let killGrace: TimeInterval
    private let lock = NSLock()
    private var active = false
    private var pid: pid_t = 0
    private var exited = false          // 자식이 끝남(아직 거두기 전일 수 있음)
    private var reaped = false          // waitpid 로 거둠 — 이후 pid 로 신호를 보내지 않는다
    private var reason: Reason?
    private var stopRequested = false
    private var killItem: DispatchWorkItem?
    private var _lastPID: pid_t = 0
    /// 자식 표준 입력으로 가는 파이프의 쓰기 끝(양방향으로 띄웠을 때만, 아니면 -1). `inputLock` 이 지킨다.
    /// 락 순서: `inputLock` 을 쥔 채 `lock` 을 잡지 않는다(그 반대도 마찬가지로 겹쳐 잡지 않음).
    private let inputLock = NSLock()
    private var inputFd: Int32 = -1

    /// 입력 파이프가 이만큼(초) 동안 조금도 비워지지 않으면 `write` 가 `.stalled` 를 던진다(기본 5초, 시험에서 줄일 수 있음).
    private let writeStallLimit: TimeInterval

    /// 자식 환경에 덮어쓸 값(사용자 환경에 같은 이름이 있어도 이 값이 이긴다) — 앱은 `CLAUDE_CONFIG_DIR` 하나를 넣는다.
    private let environmentOverrides: [String: String]
    /// 띄우는 순간 실행 파일 이름(경로 없이)에 맞춰 더 덮어쓸 값 — agy(`HOME`) · opencode(`XDG_*`)처럼 한 CLI 에만 줄 환경, 그리고 바뀔 수 있는 설정.
    /// `environmentOverrides` 위에 얹는다.
    private let executableEnvironment: @Sendable (String) -> [String: String]

    public init(killGrace: TimeInterval = 2, writeStallLimit: TimeInterval = 5, environmentOverrides: [String: String] = [:],
                executableEnvironment: @escaping @Sendable (String) -> [String: String] = { _ in [:] }) {
        self.killGrace = killGrace
        self.writeStallLimit = writeStallLimit
        self.environmentOverrides = environmentOverrides
        self.executableEnvironment = executableEnvironment
    }

    /// 앱이 띄우는 claude(묻기 · 일 맡기기 · 루틴)의 환경 덮어쓰기 — 앱 전용 클로드 설정 폴더.
    /// 사용자의 `~/.claude.json` · 플러그인 장터가 문서 폴더 경로를 가리켜서 claude 가 문서 폴더를 건드리고 맥이 허락 창을 띄우는 것을 피한다.
    public static func claudeEnvironmentOverrides(configDirectory: URL) -> [String: String] {
        ["CLAUDE_CONFIG_DIR": configDirectory.path]
    }

    /// 마지막으로 띄운 자식의 pid(시험 · 진단용). 아직 안 띄웠으면 0.
    public var lastPID: pid_t { lock.withLock { _lastPID } }

    /// 진행 중인 실행을 멈춘다(SIGTERM, 2초 뒤 SIGKILL). 돌고 있지 않으면 아무 일도 없다.
    public func stop() {
        lock.withLock {
            guard active else { return }
            if pid == 0 { stopRequested = true; return } // 아직 띄우는 중 — 띄운 직후에 처리
            terminateLocked(.stopped)
        }
    }

    /// 양방향으로 띄운 자식의 표준 입력에 한 줄을 쓴다(끝에 줄바꿈이 없으면 붙인다).
    /// 돌고 있지 않거나 이미 끝났거나 `closeInput` 뒤이거나 파이프가 끊겼으면 **오류 없이 무시**한다
    /// (끊긴 파이프로 앱이 SIGPIPE 를 받지 않는다). 파이프가 꽉 차 자식이 안 읽으면 `writeStallLimit`(기본 5초) 동안
    /// 기다린 뒤 `.stalled` 를 던지고, 그 순간 **입력을 닫는다**(반쯤 쓴 줄 뒤에 다른 줄이 이어 붙어 깨진 줄이 되지 않게 —
    /// 이후 쓰기는 무시).
    ///
    /// 주의: 이 함수는 호출 스레드를 최대 `writeStallLimit` 까지 막을 수 있다. **메인 스레드 · @MainActor 에서 부르지 말 것**
    /// (백그라운드 작업에서 부른다).
    public func write(_ line: String) throws {
        var bytes = Array(line.utf8)
        if bytes.last != 0x0A { bytes.append(0x0A) }
        try inputLock.withLock {
            guard inputFd >= 0 else { return }
            var offset = 0
            var deadline = Date().addingTimeInterval(writeStallLimit)
            while offset < bytes.count {
                let n = bytes[offset...].withUnsafeBytes { Darwin.write(inputFd, $0.baseAddress, $0.count) }
                if n > 0 { offset += n; deadline = Date().addingTimeInterval(writeStallLimit); continue }
                if n < 0 && errno == EINTR { continue }
                if n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
                    if Date() > deadline { closeInputLocked(); throw RunnerWriteError.stalled }
                    var p = pollfd(fd: inputFd, events: Int16(POLLOUT), revents: 0)
                    _ = poll(&p, 1, 100)
                    continue
                }
                return // EPIPE 등 — 자식이 더 이상 안 읽는다: 조용히 무시
            }
        }
    }

    /// 자식의 표준 입력을 닫는다(자식이 끝까지 읽었다는 신호, EOF). 이미 닫혔거나 양방향이 아니면 아무 일도 없다.
    public func closeInput() {
        inputLock.withLock { closeInputLocked() }
    }

    private func closeInputLocked() {
        if inputFd >= 0 { close(inputFd); inputFd = -1 }
    }


    /// `onEvent` 는 이 객체 안의 전용 직렬 큐에서 순서대로 불리고, `run` 이 돌아오기 전에 모두 전달된다.
    /// 메인 스레드가 아니므로 화면을 만지는 쪽은 스스로 스레드를 옮겨야 한다.
    public func run(executable: String, arguments: [String], workDir: URL, path: String,
                    timeout: TimeInterval, onEvent: @escaping @Sendable (RunEvent) -> Void) async -> RunOutcome {
        await runAsync(interactive: false, initialLines: [], executable: executable, arguments: arguments, workDir: workDir,
                       path: path, timeout: timeout, onEvent: onEvent)
    }

    /// `run` 과 같되 자식의 표준 입력이 `/dev/null` 이 아니라 파이프다 — `write` 로 줄을 보내고 `closeInput` 으로 닫는다.
    /// `run` 이 실제로 시작하기 전(작업이 아직 큐에 있을 때)에 한 `write` 는 무시되므로, 첫 줄(들)은 `initialLines` 로
    /// 넘긴다 — 자식을 띄운 직후 순서대로 쓴다. 자식이 끝나면(정상 · 멈춤 · 시간 초과) 파이프도 닫힌다.
    public func runInteractive(executable: String, arguments: [String], workDir: URL, path: String,
                               timeout: TimeInterval, initialLines: [String] = [],
                               onEvent: @escaping @Sendable (RunEvent) -> Void) async -> RunOutcome {
        await runAsync(interactive: true, initialLines: initialLines, executable: executable, arguments: arguments,
                       workDir: workDir, path: path, timeout: timeout, onEvent: onEvent)
    }

    private func runAsync(interactive: Bool, initialLines: [String], executable: String, arguments: [String], workDir: URL, path: String,
                          timeout: TimeInterval, onEvent: @escaping @Sendable (RunEvent) -> Void) async -> RunOutcome {
        guard begin() else { return .failed("이미 실행 중이에요") }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (cont: CheckedContinuation<RunOutcome, Never>) in
                DispatchQueue.global(qos: .userInitiated).async {
                    cont.resume(returning: self.execute(interactive: interactive, initialLines: initialLines, executable: executable, arguments: arguments,
                                                        workDir: workDir, path: path, timeout: timeout, onEvent: onEvent))
                }
            }
        } onCancel: {
            self.stop()
        }
    }

    /// 같은 일을 막고 기다리는 판 — 로그인 셸 PATH 읽기처럼 비동기 바깥에서 쓰는 곳용.
    func runBlocking(executable: String, arguments: [String], workDir: URL, path: String,
                     timeout: TimeInterval, onEvent: @escaping @Sendable (RunEvent) -> Void) -> RunOutcome {
        guard begin() else { return .failed("이미 실행 중이에요") }
        return execute(interactive: false, initialLines: [], executable: executable, arguments: arguments, workDir: workDir, path: path,
                       timeout: timeout, onEvent: onEvent)
    }

    // MARK: - 내부

    private func begin() -> Bool {
        lock.withLock {
            if active { return false }
            active = true; pid = 0; exited = false; reaped = false
            reason = nil; stopRequested = false; killItem = nil
            return true
        }
    }

    /// lock 을 쥔 채 부른다. 그룹 전체에 SIGTERM, grace 뒤 SIGKILL 예약.
    private func terminateLocked(_ why: Reason) {
        guard pid > 0, !exited, !reaped, reason == nil else { return }
        reason = why
        kill(-pid, SIGTERM)
        let target = pid
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.lock.withLock {
                if !self.reaped && self.pid == target { kill(-target, SIGKILL) }
            }
        }
        killItem = item
        DispatchQueue.global().asyncAfter(deadline: .now() + killGrace, execute: item)
    }

    private func finishRun() {
        lock.withLock { active = false; killItem?.cancel(); killItem = nil }
    }

    /// 자식 CLI 에 넘길 환경 — 이 앱을 띄운 Claude 의 내부 값(`CLAUDECODE` · `CLAUDE_CODE_*`)은 빼고 나머지는 그대로, PATH 는 지정값.
    /// `overrides` 는 사용자 환경에 같은 이름이 있어도 덮어쓴다.
    /// 자식에게 넘기지 않는 키 값 환경변수 — 구독 대신 키로 과금되는 일을 막는다(사용자 환경에 있어도 뺀다).
    public static let strippedAPIKeyVariables: Set<String> = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]

    public static func childEnvironment(base: [String: String], path: String, overrides: [String: String] = [:]) -> [String: String] {
        var env = base.filter { $0.key != "CLAUDECODE" && !$0.key.hasPrefix("CLAUDE_CODE_") && !strippedAPIKeyVariables.contains($0.key) }
        for (k, v) in overrides { env[k] = v }
        env["PATH"] = path
        return env
    }

    /// 쓰기 끝에 SIGPIPE 면제를 못 걸었을 때만 — 프로세스 전체에서 SIGPIPE 를 무시(한 번만).
    private static let ignoreSIGPIPEOnce: Void = { signal(SIGPIPE, SIG_IGN); return () }()
    private static func ignoreSIGPIPEProcessWide() { _ = ignoreSIGPIPEOnce }

    static func resolve(_ name: String, path: String) -> String? {
        let fm = FileManager.default
        if name.contains("/") { return fm.isExecutableFile(atPath: name) ? name : nil }
        for dir in path.split(separator: ":") where !dir.isEmpty {
            let full = String(dir) + "/" + name
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: full, isDirectory: &isDir), !isDir.boolValue, fm.isExecutableFile(atPath: full) { return full }
        }
        return nil
    }

    private func execute(interactive: Bool, initialLines: [String], executable: String, arguments: [String], workDir: URL, path: String,
                         timeout: TimeInterval, onEvent: @escaping @Sendable (RunEvent) -> Void) -> RunOutcome {
        defer { closeInput(); finishRun() }
        guard let exe = Self.resolve(executable, path: path) else { return .notFound(executable) }

        var outFds: [Int32] = [-1, -1], errFds: [Int32] = [-1, -1]
        guard pipe(&outFds) == 0 else { return .failed("파이프를 만들지 못했어요") }
        guard pipe(&errFds) == 0 else { close(outFds[0]); close(outFds[1]); return .failed("파이프를 만들지 못했어요") }
        for fd in outFds + errFds { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }

        // 양방향: 자식 표준 입력용 파이프. 쓰기 끝은 이 프로세스에만 남고(CLOEXEC · 끊긴 파이프에 SIGPIPE 안 받음 · 안 막힘).
        var inFds: [Int32] = [-1, -1]
        if interactive {
            guard pipe(&inFds) == 0 else {
                close(outFds[0]); close(outFds[1]); close(errFds[0]); close(errFds[1])
                return .failed("파이프를 만들지 못했어요")
            }
            for fd in inFds { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }
            if fcntl(inFds[1], F_SETNOSIGPIPE, 1) == -1 { Self.ignoreSIGPIPEProcessWide() } // 보험
            _ = fcntl(inFds[1], F_SETFL, fcntl(inFds[1], F_GETFL) | O_NONBLOCK)
            inputLock.withLock { inputFd = inFds[1] }
        }

        var attr: posix_spawnattr_t?
        var actions: posix_spawn_file_actions_t?
        posix_spawnattr_init(&attr); posix_spawn_file_actions_init(&actions)
        defer { posix_spawnattr_destroy(&attr); posix_spawn_file_actions_destroy(&actions) }

        var defaultSigs = sigset_t(); sigfillset(&defaultSigs)
        var noMask = sigset_t(); sigemptyset(&noMask)
        posix_spawnattr_setsigdefault(&attr, &defaultSigs)
        posix_spawnattr_setsigmask(&attr, &noMask)
        posix_spawnattr_setpgroup(&attr, 0)
        // 0x4000 = POSIX_SPAWN_CLOEXEC_DEFAULT: 아래에서 직접 지정한 fd 말고는 자식에게 물려주지 않는다.
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK | 0x4000))

        if interactive {
            posix_spawn_file_actions_adddup2(&actions, inFds[0], 0)
        } else {
            posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        }
        posix_spawn_file_actions_adddup2(&actions, outFds[1], 1)
        posix_spawn_file_actions_adddup2(&actions, errFds[1], 2)
        let chdirRC = posix_spawn_file_actions_addchdir_np(&actions, workDir.path)

        let overrides = environmentOverrides.merging(executableEnvironment((executable as NSString).lastPathComponent)) { _, new in new }
        let env = Self.childEnvironment(base: ProcessInfo.processInfo.environment, path: path, overrides: overrides)
        let argv = ([exe] + arguments).map { strdup($0) } + [nil]
        let envp = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { argv.forEach { free($0) }; envp.forEach { free($0) } }

        var child: pid_t = 0
        let rc = chdirRC == 0 ? posix_spawn(&child, exe, &actions, &attr, argv, envp) : chdirRC
        close(outFds[1]); close(errFds[1])
        if interactive { close(inFds[0]) }
        guard rc == 0 else {
            close(outFds[0]); close(errFds[0])
            return .failed("\(executable) 를 띄우지 못했어요(\(String(cString: strerror(rc))) — 작업 폴더: \(workDir.path))")
        }

        lock.withLock {
            pid = child; _lastPID = child
            if stopRequested { terminateLocked(.stopped) }
        }
        var timeoutItem: DispatchWorkItem?
        if timeout > 0 {
            let item = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.lock.withLock { self.terminateLocked(.timedOut) }
            }
            timeoutItem = item
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: item)
        }

        // 읽기: 두 줄기를 따로 읽어 한 줄짜리 큐로 순서 있게 전달.
        let deliver = DispatchQueue(label: "AppCore.ProcessRunner.deliver")
        let readers = DispatchGroup()
        for (fd, isErr) in [(outFds[0], false), (errFds[0], true)] {
            readers.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                self.pump(fd: fd, isErr: isErr, deliver: deliver, onEvent: onEvent)
                close(fd)
                readers.leave()
            }
        }

        // 읽는 쪽이 돌고 있으니 큰 줄도 막히지 않는다. 첫 줄을 못 보내면(자식이 입력을 안 읽음) 클로드는 입력을
        // 기다리며 멈출 테니 이 실행을 멈추고 실패로 끝낸다.
        for line in initialLines {
            do { try write(line) } catch {
                lock.withLock { terminateLocked(.inputFailed) }
                break
            }
        }

        // 자식이 끝나길 기다림(거두지는 않고) → 그룹에 남은 것 정리 → 거둠.
        var info = siginfo_t()
        var waitError: Int32 = 0
        while waitid(P_PID, id_t(child), &info, WEXITED | WNOWAIT) == -1 {
            if errno == EINTR { continue }
            waitError = errno; break
        }
        var status: Int32 = 0
        lock.withLock {
            exited = true
            kill(-child, SIGKILL) // 손자 · 백그라운드 프로세스(좀비가 아직 pid 를 쥐고 있어 안전)
            while waitpid(child, &status, 0) == -1 {
                if errno == EINTR { continue }
                if waitError == 0 { waitError = errno }
                break
            }
            reaped = true
        }
        closeInput() // 자식이 끝났으니 입력 파이프도 닫는다(이후 쓰기는 무시)
        timeoutItem?.cancel()
        readers.wait()
        deliver.sync {}

        let why = lock.withLock { reason }
        switch why {
        case .timedOut: return .timedOut
        case .stopped: return .stopped
        case .inputFailed: return .failed("\(executable) 에 첫 입력을 보내지 못했어요(입력을 읽지 않아요)")
        case nil:
            if waitError != 0 {
                return .failed("\(executable) 의 끝난 상태를 읽지 못했어요(\(String(cString: strerror(waitError))))")
            }
            if status & 0x7f == 0 { return .finished(code: (status >> 8) & 0xff) }
            return .finished(code: 128 + (status & 0x7f))
        }
    }

    private func pump(fd: Int32, isErr: Bool, deliver: DispatchQueue, onEvent: @escaping @Sendable (RunEvent) -> Void) {
        var buf = [UInt8](repeating: 0, count: 16_384)
        var exitedAt: Date?
        while true {
            var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let r = poll(&p, 1, 50)
            if r < 0 { if errno == EINTR { continue }; break }
            if r == 0 || (p.revents & Int16(POLLIN | POLLHUP | POLLERR)) == 0 {
                if lock.withLock({ exited }) { break } // 자식이 끝났고 더 올 것이 없다
                continue
            }
            let n = read(fd, &buf, buf.count)
            if n > 0 {
                let data = Data(buf[0..<n])
                deliver.async { onEvent(isErr ? .stderr(data) : .stdout(data)) }
                if lock.withLock({ exited }) {
                    // 자식이 끝난 뒤에도 파이프를 쥔 채 계속 쓰는 프로세스(그룹을 빠져나간 것)에 붙잡히지 않도록 2초 상한.
                    let t = exitedAt ?? Date(); exitedAt = t
                    if Date().timeIntervalSince(t) > 2 { break }
                }
                continue
            }
            if n == 0 { break }
            if errno == EINTR || errno == EAGAIN { continue }
            break
        }
    }
}
