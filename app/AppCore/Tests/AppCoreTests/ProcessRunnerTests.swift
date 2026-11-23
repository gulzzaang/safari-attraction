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
        XCTAssertEqual(errno, ESRCH, file: file, line: line)
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
