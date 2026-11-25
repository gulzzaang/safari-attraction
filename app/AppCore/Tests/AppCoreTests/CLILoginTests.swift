import XCTest
@testable import AppCore

final class TerminalLoginTests: XCTestCase {
    func tempDir() -> URL {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("login-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: u) }
        return u
    }

    func testShellQuote() {
        XCTAssertEqual(TerminalLogin.shellQuote("abc"), "'abc'")
        XCTAssertEqual(TerminalLogin.shellQuote("a b"), "'a b'")
        XCTAssertEqual(TerminalLogin.shellQuote("it's"), "'it'\\''s'")
        XCTAssertEqual(TerminalLogin.shellQuote("$(rm -rf /)"), "'$(rm -rf /)'")
    }

    func testScriptContentForPathWithSpace() {
        let s = TerminalLogin.script(environment: ["CLAUDE_CONFIG_DIR": "/Users/me/Library/Application Support/SafariAttractionApp/claude-config"],
                                     command: ["claude", "auth", "login", "--claudeai"])
        XCTAssertEqual(s, """
        #!/bin/zsh -l
        # 사파리-어트랙션 — 앱 전용 로그인(이 창에서 한 번만 하면 돼요)
        export CLAUDE_CONFIG_DIR='/Users/me/Library/Application Support/SafariAttractionApp/claude-config'
        'claude' 'auth' 'login' '--claudeai'
        echo
        echo "끝나면 이 창을 닫으세요."

        """)
    }

    func testWriteLoginFilesAreExecutableAndHoldTheAppOnlyEnvironment() throws {
        let support = tempDir()
        let claude = try TerminalLogin.writeLoginFile(kind: .claude, support: support)
        let codex = try TerminalLogin.writeLoginFile(kind: .chatgpt, support: support)
        XCTAssertEqual(claude.lastPathComponent, "login-claude.command")
        XCTAssertEqual(codex.lastPathComponent, "login-codex.command")
        for url in [claude, codex] {
            let perm = (try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue
            XCTAssertEqual(perm, 0o755)
        }
        let c = try String(contentsOf: claude, encoding: .utf8)
        XCTAssertTrue(c.contains("export CLAUDE_CONFIG_DIR='\(support.path)/claude-config'"))
        XCTAssertTrue(c.contains("'claude' 'auth' 'login' '--claudeai'"))
        XCTAssertFalse(c.contains("CODEX_HOME"))
        let x = try String(contentsOf: codex, encoding: .utf8)
        XCTAssertTrue(x.contains("export CODEX_HOME='\(support.path)/codex-home'"))
        XCTAssertTrue(x.contains("'codex' 'login' '--device-auth'"))
        XCTAssertTrue(x.hasPrefix("#!/bin/zsh -l\n"))
        XCTAssertTrue(x.contains("끝나면 이 창을 닫으세요."))
    }

    func testAgyLoginFileDoesNotOverrideHome() throws {
        let support = tempDir()
        let url = try TerminalLogin.writeLoginFile(kind: .gemini, support: support)
        XCTAssertEqual(url.lastPathComponent, "login-agy.command")
        let content = try String(contentsOf: url, encoding: .utf8)
        XCTAssertFalse(content.contains("export HOME="))
        XCTAssertFalse(content.contains("agy-home"))
        XCTAssertTrue(content.contains("\n'agy'\n"))
        XCTAssertTrue(content.contains("/quit"))
    }

    func testOpencodeLoginFileHasNoXdgDataHome() throws {
        let support = tempDir()
        let url = try TerminalLogin.writeLoginFile(kind: .opencode, support: support)
        XCTAssertEqual(url.lastPathComponent, "login-opencode.command")
        let content = try String(contentsOf: url, encoding: .utf8)
        XCTAssertFalse(content.contains("XDG_DATA_HOME"))
        XCTAssertTrue(content.contains("export XDG_CONFIG_HOME='\(support.path)/opencode-xdg/config'"))
        XCTAssertTrue(content.contains("'opencode' 'auth' 'login' '--standalone'"))
        XCTAssertTrue(content.contains("로그인할 때 OpenCode Go 를 고르세요. 이 로그인은 터미널의 opencode 에도 그대로 남아요"))
    }
}

final class DeviceAuthParserTests: XCTestCase {
    func testPlainOutput() {
        let out = """
        Welcome to Codex [v0.167.2]

        1. Open this link in your browser and sign in to your account
           https://auth.openai.com/codex/device

        2. Enter this one-time code (expires in 15 minutes)
           ABCD-12345

        Device codes are a common phishing target. Never share this code.
        """
        let p = DeviceAuthParser.parse(out)
        XCTAssertEqual(p?.url.absoluteString, "https://auth.openai.com/codex/device")
        XCTAssertEqual(p?.code, "ABCD-12345")
    }

    func testAnsiColoredOutputIsStripped() {
        let out = "Open \u{1B}[94mhttps://chatgpt.com/device\u{1B}[0m\nCode: \u{1B}[1mWXYZ-9876\u{1B}[0m\n"
        let p = DeviceAuthParser.parse(out)
        XCTAssertEqual(p?.url.absoluteString, "https://chatgpt.com/device")
        XCTAssertEqual(p?.code, "WXYZ-9876")
    }

    func testNeedsBothAndOnlyOpenAIHttps() {
        XCTAssertNil(DeviceAuthParser.parse("https://auth.openai.com/codex/device\n"), "코드가 없다")
        XCTAssertNil(DeviceAuthParser.parse("ABCD-12345\n"), "주소가 없다")
        XCTAssertNil(DeviceAuthParser.parse("https://evil.example.com/x\nABCD-12345"), "다른 사이트 주소는 열지 않는다")
        XCTAssertNil(DeviceAuthParser.parse("http://auth.openai.com/x\nABCD-12345"), "https 만")
        XCTAssertNil(DeviceAuthParser.parse("https://notopenai.com/x\nABCD-12345"))
        XCTAssertNil(DeviceAuthParser.parse(""))
    }
}

@MainActor
final class CodexDeviceLoginTests: XCTestCase {
    func make(runner: FakeRunner, sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }) -> CodexDeviceLogin {
        CodexDeviceLogin(runner: runner, loginPath: { "/test/bin" }, workDirectory: { URL(fileURLWithPath: "/tmp/work-test") }, timeout: 30, sleep: sleep)
    }

    func waitUntil(_ cond: @escaping () -> Bool) async throws {
        let end = Date().addingTimeInterval(3)
        while !cond() {
            if Date() > end { return XCTFail("기다리던 상태가 안 옴") }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    func testShowsAddressAndCodeThenSucceeds() async throws {
        let gate = Gate()
        let runner = FakeRunner()
        runner.setScript { _, emit in
            emit(.stdout(Data("1. Open https://auth.openai.com/codex/device\n".utf8)))
            emit(.stdout(Data("2. code ABCD-12345\n".utf8)))
            await gate.wait()
            return .finished(code: 0)
        }
        let login = make(runner: runner)
        var finished: [Bool] = []
        login.onFinished = { finished.append($0) }
        login.start()
        XCTAssertEqual(login.state, .starting)
        try await waitUntil { if case .waiting = login.state { return true }; return false }
        XCTAssertEqual(login.state, .waiting(DeviceAuthPrompt(url: URL(string: "https://auth.openai.com/codex/device")!, code: "ABCD-12345")))
        XCTAssertEqual(runner.calls.first?.executable, "codex")
        XCTAssertEqual(runner.calls.first?.arguments, ["login", "--device-auth"])
        await gate.open()
        try await waitUntil { login.state == .succeeded }
        XCTAssertEqual(finished, [true], "끝나면 상태를 새로 고치게 알린다")
    }

    func testUnreadableOutputFallsBackToTerminal() async throws {
        let gate = Gate()
        let runner = FakeRunner()
        runner.setScript { _, emit in
            emit(.stdout(Data("뭔가 알 수 없는 안내\n".utf8)))
            await gate.wait()
            return .stopped
        }
        let login = make(runner: runner, sleep: { _ in })       // 10초를 바로 지난 것으로
        login.start()
        try await waitUntil { login.state == .needsTerminal }
        XCTAssertGreaterThanOrEqual(runner.stopCount, 1, "프로세스는 멈춘다")
        await gate.open()
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(login.state, .needsTerminal)
    }

    func testNonZeroExitBeforeAnythingWasReadOpensTerminalInstead() async throws {
        let runner = FakeRunner()
        runner.setScript { _, emit in
            emit(.stderr(Data("Error: device code login is not enabled for this account\n".utf8)))
            return .finished(code: 1)
        }
        let login = make(runner: runner)
        var finished: [Bool] = []
        login.onFinished = { finished.append($0) }
        login.start()
        try await waitUntil { login.state == .needsTerminal }
        XCTAssertEqual(finished, [], "끝난 게 아니라 터미널로 넘긴다")
    }

    func testParseDeadlineStartsOnlyAfterLoginPathIsResolved() async throws {
        let gate = Gate()
        let runner = FakeRunner()
        runner.setScript { _, _ in await gate.wait(); return .stopped }
        let slept = CallCounter()
        let login = CodexDeviceLogin(runner: runner, loginPath: { Thread.sleep(forTimeInterval: 0.3); return "/test/bin" },
                                     workDirectory: { URL(fileURLWithPath: "/tmp/work-test") }, timeout: 30, sleep: { _ in slept.hit() })
        login.start()
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(slept.count, 0, "로그인 PATH 를 읽는 동안에는 10초 시계가 돌지 않는다")
        XCTAssertEqual(login.state, .starting)
        try await waitUntil { login.state == .needsTerminal }
        XCTAssertEqual(slept.count, 1)
        await gate.open()
    }

    func testFailureNonZeroExit() async throws {
        let runner = FakeRunner()
        runner.setScript { _, emit in
            emit(.stdout(Data("https://auth.openai.com/codex/device\nABCD-12345\n".utf8)))
            return .finished(code: 1)
        }
        let login = make(runner: runner)
        var finished: [Bool] = []
        login.onFinished = { finished.append($0) }
        login.start()
        try await waitUntil { if case .failed = login.state { return true }; return false }
        XCTAssertEqual(finished, [false])
    }

    func testCancelStopsTheProcess() async throws {
        let gate = Gate()
        let runner = FakeRunner()
        runner.setScript { _, emit in
            emit(.stdout(Data("https://auth.openai.com/codex/device\nABCD-12345\n".utf8)))
            await gate.wait()
            return .stopped
        }
        let login = make(runner: runner)
        login.start()
        try await waitUntil { if case .waiting = login.state { return true }; return false }
        login.cancel()
        XCTAssertEqual(login.state, .idle)
        XCTAssertEqual(runner.stopCount, 1)
        await gate.open()
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(login.state, .idle)
    }

    func testNotInstalled() async throws {
        let runner = FakeRunner()
        runner.setScript { _, _ in .notFound("codex") }
        let login = make(runner: runner)
        login.start()
        try await waitUntil { if case .failed = login.state { return true }; return false }
        XCTAssertEqual(login.state, .failed(ModelKind.chatgpt.notFoundMessage))
    }
}
