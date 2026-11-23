import Foundation
import Darwin

public enum RunEvent: Sendable, Equatable {
    case stdout(Data)
    case stderr(Data)
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
/// - 표준 입력은 `/dev/null`. 표준 출력 · 오류는 모아 두지 않고 읽는 대로 `onEvent` 로 넘기므로
///   끝없는 출력도 메모리를 키우지 않는다. `onEvent` 는 내부의 한 줄짜리 큐에서 순서대로 불린다
///   (`run` 이 돌아오기 전에 모두 전달됨).
/// - 한 객체로 한 번에 하나만 돌린다(끝난 뒤 다시 `run` 가능).
public final class ProcessRunner: @unchecked Sendable {
    /// 시간 상한(초) — 설계 값.
    public static let defaultTimeout: TimeInterval = 180

    private enum Reason { case timedOut, stopped }

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

    public init(killGrace: TimeInterval = 2) { self.killGrace = killGrace }

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

    public func run(executable: String, arguments: [String], workDir: URL, path: String,
                    timeout: TimeInterval, onEvent: @escaping @Sendable (RunEvent) -> Void) async -> RunOutcome {
        guard begin() else { return .failed("이미 실행 중이에요") }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (cont: CheckedContinuation<RunOutcome, Never>) in
                DispatchQueue.global(qos: .userInitiated).async {
                    cont.resume(returning: self.execute(executable: executable, arguments: arguments, workDir: workDir,
                                                        path: path, timeout: timeout, onEvent: onEvent))
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
        return execute(executable: executable, arguments: arguments, workDir: workDir, path: path,
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

    private func execute(executable: String, arguments: [String], workDir: URL, path: String,
                         timeout: TimeInterval, onEvent: @escaping @Sendable (RunEvent) -> Void) -> RunOutcome {
        defer { finishRun() }
        guard let exe = Self.resolve(executable, path: path) else { return .notFound(executable) }

        var outFds: [Int32] = [-1, -1], errFds: [Int32] = [-1, -1]
        guard pipe(&outFds) == 0 else { return .failed("파이프를 만들지 못했어요") }
        guard pipe(&errFds) == 0 else { close(outFds[0]); close(outFds[1]); return .failed("파이프를 만들지 못했어요") }
        for fd in outFds + errFds { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }

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

        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&actions, outFds[1], 1)
        posix_spawn_file_actions_adddup2(&actions, errFds[1], 2)
        let chdirRC = posix_spawn_file_actions_addchdir_np(&actions, workDir.path)

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = path
        let argv = ([exe] + arguments).map { strdup($0) } + [nil]
        let envp = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { argv.forEach { free($0) }; envp.forEach { free($0) } }

        var child: pid_t = 0
        let rc = chdirRC == 0 ? posix_spawn(&child, exe, &actions, &attr, argv, envp) : chdirRC
        close(outFds[1]); close(errFds[1])
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

        // 자식이 끝나길 기다림(거두지는 않고) → 그룹에 남은 것 정리 → 거둠.
        var info = siginfo_t()
        while waitid(P_PID, id_t(child), &info, WEXITED | WNOWAIT) == -1 && errno == EINTR {}
        var status: Int32 = 0
        lock.withLock {
            exited = true
            kill(-child, SIGKILL) // 손자 · 백그라운드 프로세스(좀비가 아직 pid 를 쥐고 있어 안전)
            while waitpid(child, &status, 0) == -1 && errno == EINTR {}
            reaped = true
        }
        timeoutItem?.cancel()
        readers.wait()
        deliver.sync {}

        let why = lock.withLock { reason }
        switch why {
        case .timedOut: return .timedOut
        case .stopped: return .stopped
        case nil:
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
