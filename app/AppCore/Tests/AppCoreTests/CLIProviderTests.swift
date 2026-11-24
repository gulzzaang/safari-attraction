import XCTest
@testable import AppCore

final class CLIProviderTests: XCTestCase {
    func tempDir() -> URL {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("cli-provider-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: u) }
        return u
    }

    // MARK: 앱 전용 환경(Review Focus 1)
    func testOverridesHoldBothAppOnlyFolders() {
        let support = URL(fileURLWithPath: "/tmp/sa-support")
        let env = CLIEnvironment.overrides(support: support)
        XCTAssertEqual(env, ["CLAUDE_CONFIG_DIR": "/tmp/sa-support/claude-config", "CODEX_HOME": "/tmp/sa-support/codex-home"])
        XCTAssertEqual(CLIEnvironment.environment(for: .claude, support: support), ["CLAUDE_CONFIG_DIR": "/tmp/sa-support/claude-config"])
        XCTAssertEqual(CLIEnvironment.environment(for: .chatgpt, support: support), ["CODEX_HOME": "/tmp/sa-support/codex-home"])
    }

    func testOverridesBeatTheUsersOwnEnvironment() {
        let support = URL(fileURLWithPath: "/tmp/sa-support")
        let child = ProcessRunner.childEnvironment(
            base: ["CODEX_HOME": "/Users/me/.codex", "CLAUDE_CONFIG_DIR": "/Users/me/.claude", "HOME": "/Users/me"],
            path: "/bin", overrides: CLIEnvironment.overrides(support: support))
        XCTAssertEqual(child["CODEX_HOME"], "/tmp/sa-support/codex-home")
        XCTAssertEqual(child["CLAUDE_CONFIG_DIR"], "/tmp/sa-support/claude-config")
        XCTAssertEqual(child["HOME"], "/Users/me")
    }

    func testPrepareDirectoriesCreatesThem0700() throws {
        let support = tempDir()
        try CLIEnvironment.prepareDirectories(support: support)
        for dir in [CLIEnvironment.claudeConfigDirectory(support: support), CLIEnvironment.codexHomeDirectory(support: support)] {
            let attrs = try FileManager.default.attributesOfItem(atPath: dir.path)
            XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o700, dir.lastPathComponent)
        }
        try CLIEnvironment.prepareDirectories(support: support) // 두 번째도 문제없다
    }

    // MARK: 명령줄
    func testCommands() {
        XCTAssertEqual(CLICommands.claudeAuthStatus.arguments, ["auth", "status"])
        XCTAssertEqual(CLICommands.claudeUsage.arguments, ["-p", "/usage", "--output-format", "json"])
        XCTAssertEqual(CLICommands.claudeLogin.arguments, ["auth", "login", "--claudeai"])
        XCTAssertEqual(CLICommands.codexLoginStatus.arguments, ["login", "status"])
        XCTAssertEqual(CLICommands.codexModels.arguments, ["debug", "models"])
        XCTAssertEqual(CLICommands.codexAppServer.arguments, ["app-server"])
        XCTAssertEqual(CLICommands.codexDeviceLogin.arguments, ["login", "--device-auth"])
        XCTAssertEqual(CLICommands.readTimeout, 20)
    }

    func testCodexExecShape() {
        let c = CLICommands.codexExec(prompt: "안녕 $(x)", modelID: "gpt-5.6-luna")
        XCTAssertEqual(c.executable, "codex")
        XCTAssertEqual(c.arguments, ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "read-only",
                                     "-c", "cli_auth_credentials_store=file"]
                       + CLIManagedConfig.codexDisabledFeatures.flatMap { ["--disable", $0] } + ["-m", "gpt-5.6-luna", "안녕 $(x)"])
        XCTAssertEqual(CLICommands.codexExec(prompt: "q", modelID: nil).arguments.last, "q")
        XCTAssertFalse(CLICommands.codexExec(prompt: "q", modelID: nil).arguments.contains("-m"))
    }

    func testSafeModelIDs() {
        for ok in ["sonnet", "gpt-5.6-luna", "claude-sonnet-5-5", "sonnet[1m]", "gpt-6.1-sol"] { XCTAssertTrue(CLIModels.isSafeID(ok), ok) }
        for bad in ["", "-m", "a b", "a;b", "a$(x)", "한글", String(repeating: "a", count: 81)] { XCTAssertFalse(CLIModels.isSafeID(bad), bad) }
    }

    func testAllFourCLIsAreEnabled() {
        XCTAssertEqual(ModelKind.enabled, [.claude, .gemini, .chatgpt, .opencode])
        XCTAssertEqual(ModelKind.subscriptionCLIs, [.claude, .gemini, .chatgpt, .opencode])
    }

    // MARK: 일 맡기기 모델
    func testAgentCommandUsesChosenClaudeModelButRoutinesStayDefault() {
        let res = URL(fileURLWithPath: "/tmp/res"), mem = URL(fileURLWithPath: "/tmp/mem")
        let gate = GateInfo(socketPath: "/tmp/g.sock", token: "t")
        func model(_ a: [String]) -> String? { a.firstIndex(of: "--model").map { a[$0 + 1] } }
        XCTAssertEqual(model(AgentCommandBuilder.build(resources: res, gate: gate, memoryHome: mem, resumeSessionID: nil).arguments), "sonnet")
        XCTAssertEqual(model(AgentCommandBuilder.build(resources: res, gate: gate, memoryHome: mem, resumeSessionID: nil, model: "opus").arguments), "opus")
        XCTAssertEqual(model(AgentCommandBuilder.build(resources: res, gate: gate, memoryHome: mem, resumeSessionID: nil, model: "--evil").arguments), "sonnet")
        XCTAssertEqual(model(AgentCommandBuilder.buildUnattended(resources: res, gate: gate, memoryHome: mem).arguments), "sonnet", "루틴은 그대로")
    }
}
