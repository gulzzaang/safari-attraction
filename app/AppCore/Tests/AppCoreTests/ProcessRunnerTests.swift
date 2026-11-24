import XCTest
import Darwin
import AppCore

final class Collector: @unchecked Sendable {
    private let lock = NSLock()
    private var out = Data(), err = Data()
    func handle(_ e: RunEvent) {
        lock.withLock {
            switch e {
            case .stdout(let d): out.append(d)
            case .stderr(let d): err.append(d)
            }
        }
    }
    var stdout: String { lock.withLock { String(decoding: out, as: UTF8.self) } }
    var stderr: String { lock.withLock { String(decoding: err, as: UTF8.self) } }
}

final class ProcessRunnerTests: XCTestCase {
    let sysPath = "/bin:/usr/bin"
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory())

    func run(_ r: ProcessRunner, _ exe: String, _ args: [String], timeout: TimeInterval = 20, _ c: Collector = Collector()) async -> RunOutcome {
        await r.run(executable: exe, arguments: args, workDir: tmp, path: sysPath, timeout: timeout, onEvent: { c.handle($0) })
    }
    func assertGone(_ pid: pid_t, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertGreaterThan(pid, 0, file: file, line: line)
        errno = 0
        XCTAssertEqual(kill(pid, 0), -1, "pid \(pid) 가 아직 살아 있음(좀비 포함)", file: file, line: line)
        XCTAssertEqual(errno, ESRCH, file: file, line: line)
        errno = 0
        XCTAssertEqual(kill(-pid, 0), -1, "프로세스 그룹 \(pid) 가 아직 있음", file: file, line: line)
        // EPERM = 그 그룹 번호를 다른 사람의 프로세스가 다시 쓰는 중(우리 것은 이미 없다) — 사라진 것으로 본다.
        XCTAssertTrue(errno == ESRCH || errno == EPERM, "errno=\(errno)", file: file, line: line)
    }

    func testEchoFinishesWithAllOutput() async {
        let c = Collector(); let r = ProcessRunner()
        let o = await run(r, "echo", ["hello", "세계"], c)
        XCTAssertEqual(o, .finished(code: 0))
        XCTAssertEqual(c.stdout, "hello 세계\n")
        assertGone(r.lastPID)
    }
    func testNonZeroExitCode() async {
        let o = await run(ProcessRunner(), "/bin/sh", ["-c", "echo oops >&2; exit 7"])
        XCTAssertEqual(o, .finished(code: 7))
    }
    func testStderrIsSeparate() async {
        let c = Collector()
        _ = await run(ProcessRunner(), "/bin/sh", ["-c", "echo out; echo err >&2"], c)
        XCTAssertEqual(c.stdout, "out\n"); XCTAssertEqual(c.stderr, "err\n")
    }
    func testMissingExecutableIsNotFound() async {
        let o = await run(ProcessRunner(), "definitely-not-a-cli-xyz", ["a"])
        XCTAssertEqual(o, .notFound("definitely-not-a-cli-xyz"))
    }
    func testBareNameOnlyFoundOnGivenPath() async {
        let r = ProcessRunner()
        let o = await r.run(executable: "echo", arguments: [], workDir: tmp, path: "/nonexistent-dir", timeout: 5, onEvent: { _ in })
        XCTAssertEqual(o, .notFound("echo"))
    }
    func testBadWorkDirFailsWithoutCrash() async {
        let r = ProcessRunner()
        let o = await r.run(executable: "echo", arguments: [], workDir: URL(fileURLWithPath: "/no/such/dir"), path: sysPath, timeout: 5, onEvent: { _ in })
        if case .failed = o {} else { XCTFail("\(o)") }
    }
    func testWorkDirIsUsed() async {
        let c = Collector()
        let dir = tmp.appendingPathComponent("runner-wd-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        _ = await ProcessRunner().run(executable: "pwd", arguments: [], workDir: dir, path: sysPath, timeout: 5, onEvent: { c.handle($0) })
        XCTAssertEqual(URL(fileURLWithPath: c.stdout.trimmingCharacters(in: .whitespacesAndNewlines)).resolvingSymlinksInPath().path,
                       dir.resolvingSymlinksInPath().path)
    }
    func testChildGetsGivenPATH() async {
        let c = Collector()
        _ = await ProcessRunner().run(executable: "/bin/sh", arguments: ["-c", "printf %s \"$PATH\""], workDir: tmp, path: "/a/b:/c", timeout: 5, onEvent: { c.handle($0) })
        XCTAssertEqual(c.stdout, "/a/b:/c")
    }

    // Review Focus 3 — 셸을 거치지 않는다
    func testArgumentsArriveVerbatim() async {
        let nasty = ["\"$(rm -rf /)\"", "it's \"quoted\" `x` $HOME \\n", "줄\n바꿈\n\n끝", "", "-n", "--help", "*", "; echo pwned"]
        for a in nasty {
            let c = Collector()
            let o = await run(ProcessRunner(), "/usr/bin/printf", ["%s", a], c)
            XCTAssertEqual(o, .finished(code: 0))
            XCTAssertEqual(c.stdout, a, "인자가 바뀜: \(a.debugDescription)")
        }
    }
    func testEmptyArgumentIsKeptAsAnArgument() async {
        let c = Collector()
        _ = await run(ProcessRunner(), "/usr/bin/printf", ["[%s]", ""], c)
        XCTAssertEqual(c.stdout, "[]")
        let c2 = Collector()
        _ = await run(ProcessRunner(), "/usr/bin/printf", ["%s|%s|%s", "a", "", "b"], c2)
        XCTAssertEqual(c2.stdout, "a||b")
    }

    // Review Focus 2 — 시간 상한 · 멈춤이 프로세스를 실제로 끝낸다
    func testTimeoutKillsChild() async {
        let r = ProcessRunner(); let t0 = Date()
        let o = await run(r, "/bin/sleep", ["5"], timeout: 1)
        XCTAssertEqual(o, .timedOut)
        XCTAssertLessThan(Date().timeIntervalSince(t0), 4)
        assertGone(r.lastPID)
    }
    func testStopKillsChild() async {
        let r = ProcessRunner(); let t0 = Date()
        Task.detached { try? await Task.sleep(nanoseconds: 500_000_000); r.stop() }
        let o = await run(r, "/bin/sleep", ["5"])
        XCTAssertEqual(o, .stopped)
        XCTAssertLessThan(Date().timeIntervalSince(t0), 3)
        assertGone(r.lastPID)
    }
    func testSIGKILLLegForChildIgnoringTERM() async {
        let r = ProcessRunner(); let t0 = Date()
        let o = await run(r, "/bin/sh", ["-c", "trap '' TERM; while :; do /bin/sleep 1; done"], timeout: 1)
        let dt = Date().timeIntervalSince(t0)
        XCTAssertEqual(o, .timedOut)
        XCTAssertGreaterThan(dt, 2.5, "SIGTERM 만으로 끝났다면 TERM 을 무시하는 시험이 아님")
        XCTAssertLessThan(dt, 6)
        assertGone(r.lastPID)
    }
    func testGrandchildHoldingPipeDoesNotHangAndIsKilled() async {
        let r = ProcessRunner(); let t0 = Date()
        let c = Collector()
        let o = await run(r, "/bin/sh", ["-c", "/bin/sleep 30 & wait"], timeout: 1, c)
        XCTAssertEqual(o, .timedOut)
        XCTAssertLessThan(Date().timeIntervalSince(t0), 6)
        assertGone(r.lastPID) // 그룹 전체(손자 포함)가 사라졌는지
    }
    func testOrphanedBackgroundChildKilledAfterNormalExit() async {
        let r = ProcessRunner(); let t0 = Date()
        let o = await run(r, "/bin/sh", ["-c", "/bin/sleep 30 & echo started"], timeout: 10)
        XCTAssertEqual(o, .finished(code: 0))
        XCTAssertLessThan(Date().timeIntervalSince(t0), 6)
        assertGone(r.lastPID)
    }
    func testEndlessOutputIsStoppedByTimeoutWithoutBuffering() async {
        let r = ProcessRunner()
        let o = await run(r, "/usr/bin/yes", ["가나다"], timeout: 1, Collector())
        XCTAssertEqual(o, .timedOut)
        assertGone(r.lastPID)
    }
    func testTaskCancellationStopsChild() async {
        let r = ProcessRunner()
        let dir = tmp
        let task = Task { await r.run(executable: "/bin/sleep", arguments: ["5"], workDir: dir, path: "/bin:/usr/bin", timeout: 20, onEvent: { _ in }) }
        try? await Task.sleep(nanoseconds: 400_000_000)
        task.cancel()
        let o = await task.value
        XCTAssertEqual(o, .stopped)
        assertGone(r.lastPID)
    }
    func testRunnerIsReusableAfterStop() async {
        let r = ProcessRunner()
        Task.detached { try? await Task.sleep(nanoseconds: 300_000_000); r.stop() }
        _ = await run(r, "/bin/sleep", ["5"])
        let o = await run(r, "echo", ["again"])
        XCTAssertEqual(o, .finished(code: 0))
    }
    func testStopWhenIdleIsHarmless() async {
        let r = ProcessRunner(); r.stop()
        let o = await run(r, "echo", ["x"])
        XCTAssertEqual(o, .finished(code: 0))
    }

    func testChildEnvironmentDropsClaudeInternalsKeepsRest() {
        let base = ["CLAUDECODE": "1", "CLAUDE_CODE_ENTRYPOINT": "cli", "CLAUDE_CODE_OAUTH_TOKEN": "x",
                    "CLAUDE_CONFIG_DIR": "/keep", "HOME": "/h", "PATH": "/old", "ANTHROPIC_API_KEY": "k"]
        let env = ProcessRunner.childEnvironment(base: base, path: "/new:/p")
        XCTAssertEqual(env, ["CLAUDE_CONFIG_DIR": "/keep", "HOME": "/h", "PATH": "/new:/p", "ANTHROPIC_API_KEY": "k"])
    }
    func testChildEnvironmentOverridesBeatUserValue() {
        let base = ["CLAUDE_CONFIG_DIR": "/user", "HOME": "/h"]
        let env = ProcessRunner.childEnvironment(base: base, path: "/p",
                                                 overrides: ProcessRunner.claudeEnvironmentOverrides(configDirectory: URL(fileURLWithPath: "/app/claude-config")))
        XCTAssertEqual(env["CLAUDE_CONFIG_DIR"], "/app/claude-config")
        XCTAssertEqual(env["HOME"], "/h")
        let none = ProcessRunner.childEnvironment(base: ["A": "1"], path: "/p")
        XCTAssertNil(none["CLAUDE_CONFIG_DIR"])
    }
    /// 묻기(run) · 일 맡기기와 루틴(runInteractive) 두 길 모두 자식이 앱 전용 설정 폴더를 본다 — 사용자 환경에 값이 있어도.
    func testChildSeesAppConfigDirOnRunAndRunInteractive() async {
        setenv("CLAUDE_CONFIG_DIR", "/user/own", 1)
        defer { unsetenv("CLAUDE_CONFIG_DIR") }
        let o = ProcessRunner.claudeEnvironmentOverrides(configDirectory: URL(fileURLWithPath: "/app/claude-config"))
        let c1 = Collector()
        _ = await run(ProcessRunner(environmentOverrides: o), "/usr/bin/env", [], c1)
        XCTAssertTrue(c1.stdout.contains("CLAUDE_CONFIG_DIR=/app/claude-config\n"))
        XCTAssertFalse(c1.stdout.contains("/user/own"))
        let c2 = Collector()
        let r = ProcessRunner(environmentOverrides: o)
        let out = await r.runInteractive(executable: "/usr/bin/env", arguments: [], workDir: URL(fileURLWithPath: NSTemporaryDirectory()),
                                         path: "/bin:/usr/bin", timeout: 20, initialLines: [], onEvent: { c2.handle($0) })
        XCTAssertEqual(out, .finished(code: 0))
        XCTAssertTrue(c2.stdout.contains("CLAUDE_CONFIG_DIR=/app/claude-config\n"))
    }
    func testClaudeConfigDirectoryIsCreatedPrivate() throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("sa-cfg-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: base) }
        let dir = try AppPaths.claudeConfigDirectory(supportDirectory: base)
        XCTAssertEqual(dir.lastPathComponent, "claude-config")
        let perms = try FileManager.default.attributesOfItem(atPath: dir.path)[.posixPermissions] as? Int
        XCTAssertEqual(perms, 0o700)
    }
    func testChildActuallyDoesNotSeeClaudeCodeVars() async {
        setenv("CLAUDECODE", "1", 1); setenv("CLAUDE_CODE_TEST_X", "1", 1)
        defer { unsetenv("CLAUDECODE"); unsetenv("CLAUDE_CODE_TEST_X") }
        let c = Collector()
        _ = await run(ProcessRunner(), "/usr/bin/env", [], c)
        XCTAssertFalse(c.stdout.contains("CLAUDECODE"))
        XCTAssertFalse(c.stdout.contains("CLAUDE_CODE_TEST_X"))
        XCTAssertTrue(c.stdout.contains("PATH="))
    }
    /// SIGCHLD 를 무시하면 자식이 자동으로 거두어져 waitid 가 ECHILD 로 실패한다 — 0 으로 끝난 것처럼 보고하면 안 된다.
    func testWaitErrorIsNotReportedAsSuccess() async {
        let old = signal(SIGCHLD, SIG_IGN)
        defer { signal(SIGCHLD, old) }
        let r = ProcessRunner()
        let o = await run(r, "echo", ["x"])
        if case .failed = o {} else { XCTFail("기다리기 오류가 \(o) 로 보고됨") }
    }
}

// 양방향 실행(표준 입력 파이프) — 시스템 도구(cat · sh)만 쓴다.
final class ProcessRunnerInteractiveTests: XCTestCase {
    let sysPath = "/bin:/usr/bin"
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory())

    func startInteractive(_ r: ProcessRunner, _ exe: String, _ args: [String], timeout: TimeInterval = 20,
                          initial: [String] = [], _ c: Collector = Collector()) -> Task<RunOutcome, Never> {
        let dir = tmp, path = sysPath
        return Task {
            await r.runInteractive(executable: exe, arguments: args, workDir: dir, path: path, timeout: timeout,
                                   initialLines: initial, onEvent: { c.handle($0) })
        }
    }
    /// 작업이 실제로 시작될 때까지(자식이 떴을 때까지) 기다린다 — 이 전의 write 는 설계상 무시된다.
    func started(_ r: ProcessRunner, after old: pid_t = 0) async {
        await waitUntil { r.lastPID != old && r.lastPID > 0 }
        try? await Task.sleep(nanoseconds: 100_000_000)
    }
    /// 조건이 될 때까지 최대 5초 기다린다.
    func waitUntil(_ cond: @escaping () -> Bool) async {
        for _ in 0..<100 { if cond() { return }; try? await Task.sleep(nanoseconds: 50_000_000) }
    }
    func assertGone(_ pid: pid_t, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertGreaterThan(pid, 0, file: file, line: line)
        errno = 0
        XCTAssertEqual(kill(pid, 0), -1, "pid \(pid) 가 아직 살아 있음", file: file, line: line)
        XCTAssertEqual(errno, ESRCH, file: file, line: line)
    }

    func testWriteReachesChildAndCloseInputEndsIt() async throws {
        let r = ProcessRunner(); let c = Collector()
        let t = startInteractive(r, "/bin/cat", [], c)
        await started(r)
        try r.write("첫째 줄")
        try r.write("{\"a\":1}\n")
        await waitUntil { c.stdout.contains("{\"a\":1}") }
        XCTAssertEqual(c.stdout, "첫째 줄\n{\"a\":1}\n") // 줄바꿈이 없으면 붙이고, 있으면 겹치지 않는다
        r.closeInput()
        let o = await t.value
        XCTAssertEqual(o, .finished(code: 0))
        assertGone(r.lastPID)
    }
    func testChildSeesEOFOnlyAfterCloseInput() async throws {
        let r = ProcessRunner(); let c = Collector()
        let t = startInteractive(r, "/bin/sh", ["-c", "read a; echo got:$a; read b || echo eof"], c)
        await started(r)
        try r.write("hi")
        await waitUntil { c.stdout.contains("got:hi") }
        XCTAssertFalse(c.stdout.contains("eof"))
        r.closeInput()
        let o = await t.value
        XCTAssertEqual(o, .finished(code: 0))
        XCTAssertEqual(c.stdout, "got:hi\neof\n")
    }
    func testCloseInputTwiceIsHarmless() async {
        let r = ProcessRunner()
        let t = startInteractive(r, "/bin/cat", [])
        try? await Task.sleep(nanoseconds: 200_000_000)
        r.closeInput(); r.closeInput()
        let o = await t.value
        XCTAssertEqual(o, .finished(code: 0))
    }
    func testStopKillsChildWaitingOnInputAndLaterWritesAreIgnored() async throws {
        let r = ProcessRunner(); let t0 = Date()
        let t = startInteractive(r, "/bin/cat", [])
        await started(r)
        r.stop()
        let o = await t.value
        XCTAssertEqual(o, .stopped)
        XCTAssertLessThan(Date().timeIntervalSince(t0), 3)
        assertGone(r.lastPID)
        XCTAssertNoThrow(try r.write("끝난 뒤"))
        r.closeInput()
    }
    func testTimeoutKillsChildWaitingOnInput() async throws {
        let r = ProcessRunner()
        let t = startInteractive(r, "/bin/cat", [], timeout: 1)
        let o = await t.value
        XCTAssertEqual(o, .timedOut)
        assertGone(r.lastPID)
        XCTAssertNoThrow(try r.write("x"))
    }
    func testWriteAfterNormalFinishIsIgnoredWithoutError() async throws {
        let r = ProcessRunner()
        let o = await r.runInteractive(executable: "echo", arguments: ["x"], workDir: tmp, path: sysPath, timeout: 5, onEvent: { _ in })
        XCTAssertEqual(o, .finished(code: 0))
        XCTAssertNoThrow(try r.write("late"))
        r.closeInput()
    }
    func testWriteToChildThatAlreadyExitedDoesNotCrashOrThrow() async throws {
        // 자식은 입력을 안 읽고 끝난다 — 끊긴 파이프에 써도 앱이 SIGPIPE 로 죽지 않아야 한다.
        let r = ProcessRunner()
        let t = startInteractive(r, "/bin/sh", ["-c", "exit 3"])
        let o = await t.value
        XCTAssertEqual(o, .finished(code: 3))
        for _ in 0..<5 { XCTAssertNoThrow(try r.write("x")) }
    }
    func testInitialLinesAreDeliveredFirstWithoutRacing() async throws {
        let r = ProcessRunner(); let c = Collector()
        let t = startInteractive(r, "/bin/cat", [], initial: ["하나", "둘"], c)
        await waitUntil { c.stdout == "하나\n둘\n" }
        try r.write("셋")
        await waitUntil { c.stdout.hasSuffix("셋\n") }
        r.closeInput()
        let o = await t.value
        XCTAssertEqual(o, .finished(code: 0))
        XCTAssertEqual(c.stdout, "하나\n둘\n셋\n")
    }
    // 입력을 안 읽는 자식 — 파이프가 꽉 찬다(큰 줄).
    func testStalledWriteThrowsAndClosesInputSoLaterWritesAreIgnored() async throws {
        let r = ProcessRunner(writeStallLimit: 0.5)
        let t = startInteractive(r, "/bin/sh", ["-c", "/bin/sleep 4"], timeout: 20)
        await started(r)
        let big = String(repeating: "x", count: 2_000_000)
        var thrown: Error?
        do { try r.write(big) } catch { thrown = error }
        XCTAssertEqual(thrown as? RunnerWriteError, .stalled)
        // 입력이 닫혔으니 다음 쓰기는 기다리지도 던지지도 않고 무시된다(이어 붙은 깨진 줄도 없음).
        let t0 = Date()
        XCTAssertNoThrow(try r.write("{\"next\":1}"))
        XCTAssertLessThan(Date().timeIntervalSince(t0), 0.3)
        r.stop()
        _ = await t.value
        assertGone(r.lastPID)
    }
    func testStalledInitialLineStopsTheRunAndFails() async {
        let r = ProcessRunner(killGrace: 0.5, writeStallLimit: 0.5); let t0 = Date()
        let big = String(repeating: "x", count: 2_000_000)
        let t = startInteractive(r, "/bin/sh", ["-c", "/bin/sleep 30"], timeout: 60, initial: [big, "둘째"])
        let o = await t.value
        if case .failed(let m) = o { XCTAssertTrue(m.contains("입력"), m) } else { XCTFail("\(o)") }
        XCTAssertLessThan(Date().timeIntervalSince(t0), 8)
        assertGone(r.lastPID)
    }
    func testWriteWithoutRunIsIgnored() {
        let r = ProcessRunner()
        XCTAssertNoThrow(try r.write("nothing running"))
        r.closeInput()
    }
    func testLargeWritesAreDeliveredInFull() async throws {
        let r = ProcessRunner(); let c = Collector()
        let t = startInteractive(r, "/bin/cat", [], c)
        await started(r)
        let line = String(repeating: "가나다라", count: 40_000) // 약 480KB — 파이프 한 번 크기보다 큼
        try r.write(line)
        r.closeInput()
        let o = await t.value
        XCTAssertEqual(o, .finished(code: 0))
        XCTAssertEqual(c.stdout, line + "\n")
    }
    func testDefaultRunStillGivesDevNullStdin() async {
        // 기본 실행은 그대로 /dev/null — cat 이 바로 끝난다. 쓰기는 무시.
        let r = ProcessRunner(); let c = Collector()
        let o = await r.run(executable: "/bin/cat", arguments: [], workDir: tmp, path: sysPath, timeout: 5, onEvent: { c.handle($0) })
        XCTAssertEqual(o, .finished(code: 0))
        XCTAssertEqual(c.stdout, "")
        XCTAssertNoThrow(try r.write("ignored"))
    }
    func testRunnerIsReusableForInteractiveAfterInteractive() async throws {
        let r = ProcessRunner(); let c = Collector()
        let t1 = startInteractive(r, "/bin/cat", [], c)
        try? await Task.sleep(nanoseconds: 200_000_000)
        r.closeInput()
        _ = await t1.value
        let c2 = Collector()
        let old = r.lastPID
        let t2 = startInteractive(r, "/bin/cat", [], c2)
        await started(r, after: old)
        try r.write("again")
        await waitUntil { c2.stdout.contains("again") }
        r.closeInput()
        let o = await t2.value
        XCTAssertEqual(o, .finished(code: 0))
        XCTAssertEqual(c2.stdout, "again\n")
    }
}
