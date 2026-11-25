import XCTest
@testable import AppCore

final class AgentCommandBuilderTests: XCTestCase {
    let res = URL(fileURLWithPath: "/Applications/Safari Attraction.app/Contents/Resources")
    let home = URL(fileURLWithPath: "/Users/x/Library/Application Support/SafariAttractionApp/memory")
    let token = String(repeating: "ab", count: 32)
    var gate: GateInfo { GateInfo(socketPath: "/Users/x/Library/Application Support/SafariAttractionApp/gate/g.sock", token: token) }

    func mcpJSON(_ args: [String]) -> [String: Any] {
        let i = args.firstIndex(of: "--mcp-config")!
        return try! JSONSerialization.jsonObject(with: Data(args[i + 1].utf8)) as! [String: Any]
    }

    func testExecutableIsClaudeByName() {
        XCTAssertEqual(AgentCommandBuilder.build(resources: res, gate: gate, memoryHome: home, resumeSessionID: nil).executable, "claude")
    }
    func testArgumentOrderIsExactlyTheDesign() {
        let (_, a) = AgentCommandBuilder.build(resources: res, gate: gate, memoryHome: home, resumeSessionID: nil)
        XCTAssertEqual(a.count, 19)
        XCTAssertEqual(Array(a[0..<8]), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "sonnet"])
        XCTAssertEqual(Array(a[8..<11]), ["--setting-sources", "", "--strict-mcp-config"])
        XCTAssertEqual(a[11], "--mcp-config")
        // a[12] 는 MCP JSON(아래에서 따로 확인)
        XCTAssertEqual(Array(a[13...]), ["--tools", "ExitPlanMode,Write", "--permission-prompt-tool", "stdio", "--permission-mode", "plan"])
    }
    func testSettingSourcesIsAnEmptyArgumentNotDropped() {
        let (_, a) = AgentCommandBuilder.build(resources: res, gate: gate, memoryHome: home, resumeSessionID: nil)
        let i = a.firstIndex(of: "--setting-sources")!
        XCTAssertEqual(a[i + 1], "")
    }
    func testModelComesFromCommandBuilderConstant() {
        XCTAssertEqual(CommandBuilder.claudeModel, "sonnet")
    }
    func testMcpJSONShape() {
        let (_, a) = AgentCommandBuilder.build(resources: res, gate: gate, memoryHome: home, resumeSessionID: nil)
        let json = mcpJSON(a)
        XCTAssertEqual(Set(json.keys), ["mcpServers"])
        let servers = json["mcpServers"] as! [String: Any]
        XCTAssertEqual(Set(servers.keys), ["safari-attraction"])
        let s = servers["safari-attraction"] as! [String: Any]
        XCTAssertEqual(s["command"] as? String, "/bin/sh")
        XCTAssertEqual(s["args"] as? [String], ["/Applications/Safari Attraction.app/Contents/Resources/safari-attraction/run.sh"])
        XCTAssertEqual(s["env"] as? [String: String], [
            "SAFARI_ATTRACTION_GATE": "/Users/x/Library/Application Support/SafariAttractionApp/gate/g.sock",
            "SAFARI_ATTRACTION_GATE_TOKEN": token,
            "SAFARI_ATTRACTION_NO_PERMISSION_PROMPTS": "1",
            "SAFARI_ATTRACTION_HOME": "/Users/x/Library/Application Support/SafariAttractionApp/memory",
        ])
        XCTAssertEqual(Set(s.keys), ["command", "args", "env"])
    }
    func testMcpJSONIsOneArgumentAndStableAcrossCalls() {
        let a1 = AgentCommandBuilder.build(resources: res, gate: gate, memoryHome: home, resumeSessionID: nil).arguments
        let a2 = AgentCommandBuilder.build(resources: res, gate: gate, memoryHome: home, resumeSessionID: nil).arguments
        XCTAssertEqual(a1, a2) // 키 정렬 — 시험이 흔들리지 않는다
        XCTAssertFalse(a1[12].contains("\n"))
        XCTAssertFalse(a1[12].contains(" /Applications")) // 한 덩어리 JSON 이지 셸 문자열이 아니다
    }
    func testNastyValuesStayDataInsideJSON() {
        let nastyRes = URL(fileURLWithPath: "/tmp/we\"ird $(rm -rf x) 'q'\\/Res")
        let nastyGate = GateInfo(socketPath: "/tmp/a\"b/g\nsock", token: "t\"\\ok")
        let nastyHome = URL(fileURLWithPath: "/tmp/h\"ome; echo pwned")
        let (_, a) = AgentCommandBuilder.build(resources: nastyRes, gate: nastyGate, memoryHome: nastyHome, resumeSessionID: nil)
        let s = (mcpJSON(a)["mcpServers"] as! [String: Any])["safari-attraction"] as! [String: Any]
        XCTAssertEqual((s["args"] as! [String])[0], nastyRes.path + "/safari-attraction/run.sh")
        let env = s["env"] as! [String: String]
        XCTAssertEqual(env["SAFARI_ATTRACTION_GATE"], "/tmp/a\"b/g\nsock")
        XCTAssertEqual(env["SAFARI_ATTRACTION_GATE_TOKEN"], "t\"\\ok")
        XCTAssertEqual(env["SAFARI_ATTRACTION_HOME"], nastyHome.path)
        XCTAssertEqual(a.count, 19)
    }
    func testResumeIsAppendedAtTheEnd() {
        let (_, a) = AgentCommandBuilder.build(resources: res, gate: gate, memoryHome: home, resumeSessionID: "sess-123")
        XCTAssertEqual(Array(a.suffix(2)), ["--resume", "sess-123"])
        XCTAssertEqual(a.count, 21)
        let base = AgentCommandBuilder.build(resources: res, gate: gate, memoryHome: home, resumeSessionID: nil).arguments
        XCTAssertEqual(Array(a.dropLast(2)), base)
    }
    func testEmptyResumeIDIsIgnored() {
        let a = AgentCommandBuilder.build(resources: res, gate: gate, memoryHome: home, resumeSessionID: "").arguments
        XCTAssertFalse(a.contains("--resume"))
    }
    func testNoPromptInArguments() {
        // 사용자 입력은 명령줄이 아니라 표준 입력(user 줄)으로만 간다.
        let a = AgentCommandBuilder.build(resources: res, gate: gate, memoryHome: home, resumeSessionID: nil).arguments
        XCTAssertEqual(a.first, "-p")
        XCTAssertFalse(a.contains("--allowedTools"))
    }
    // MARK: 사람 없는 루틴

    func testUnattendedArgumentOrderIsExactlyTheDesign() {
        let (exe, a) = AgentCommandBuilder.buildUnattended(resources: res, gate: gate, memoryHome: home)
        XCTAssertEqual(exe, "claude")
        XCTAssertEqual(a.count, 19)
        XCTAssertEqual(Array(a[0..<8]), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "sonnet"])
        XCTAssertEqual(Array(a[8..<11]), ["--setting-sources", "", "--strict-mcp-config"])
        XCTAssertEqual(a[11], "--mcp-config")
        XCTAssertEqual(Array(a[13...]), ["--tools", "", "--permission-prompt-tool", "stdio", "--permission-mode", "manual"])
    }
    func testUnattendedHasNoBuiltInToolsNoPlanModeNoResume() {
        let a = AgentCommandBuilder.buildUnattended(resources: res, gate: gate, memoryHome: home).arguments
        XCTAssertEqual(a[a.firstIndex(of: "--tools")! + 1], "")
        XCTAssertFalse(a.contains("ExitPlanMode,Write"))
        XCTAssertFalse(a.contains("plan"))
        XCTAssertFalse(a.contains("--resume"))
    }
    func testUnattendedMcpEnvAddsTheUnattendedFlagAndKeepsTheRest() {
        let a = AgentCommandBuilder.buildUnattended(resources: res, gate: gate, memoryHome: home).arguments
        let s = (mcpJSON(a)["mcpServers"] as! [String: Any])["safari-attraction"] as! [String: Any]
        XCTAssertEqual(s["env"] as? [String: String], [
            "SAFARI_ATTRACTION_GATE": "/Users/x/Library/Application Support/SafariAttractionApp/gate/g.sock",
            "SAFARI_ATTRACTION_GATE_TOKEN": token,
            "SAFARI_ATTRACTION_NO_PERMISSION_PROMPTS": "1",
            "SAFARI_ATTRACTION_HOME": "/Users/x/Library/Application Support/SafariAttractionApp/memory",
            "SAFARI_ATTRACTION_UNATTENDED": "1",
        ])
        XCTAssertEqual(s["command"] as? String, "/bin/sh")
    }
    func testAttendedMcpEnvHasNoUnattendedFlag() {
        let a = AgentCommandBuilder.build(resources: res, gate: gate, memoryHome: home, resumeSessionID: nil).arguments
        let s = (mcpJSON(a)["mcpServers"] as! [String: Any])["safari-attraction"] as! [String: Any]
        XCTAssertNil((s["env"] as! [String: String])["SAFARI_ATTRACTION_UNATTENDED"])
    }
    func testUnattendedAppliesModelAndEffortWhenProvided() {
        let a = AgentCommandBuilder.buildUnattended(resources: res, gate: gate, memoryHome: home, model: "opus", effort: "high").arguments
        XCTAssertEqual(a[a.firstIndex(of: "--model")! + 1], "opus")
        XCTAssertEqual(a[a.firstIndex(of: "--effort")! + 1], "high")
        let noEffort = AgentCommandBuilder.buildUnattended(resources: res, gate: gate, memoryHome: home, model: nil, effort: nil).arguments
        XCTAssertEqual(noEffort[noEffort.firstIndex(of: "--model")! + 1], "sonnet")
        XCTAssertFalse(noEffort.contains("--effort"))
    }
}
