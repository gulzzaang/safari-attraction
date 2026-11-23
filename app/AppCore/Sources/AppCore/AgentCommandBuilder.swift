import Foundation

/// 동작 관문(유닉스 소켓)의 자리와 토큰 — MCP 서버에 환경값으로 넘어간다.
public struct GateInfo: Sendable, Equatable {
    public let socketPath: String
    public let token: String
    public init(socketPath: String, token: String) {
        self.socketPath = socketPath
        self.token = token
    }
}

/// 「일 맡기기」용 클로드 명령줄(양방향 stream-json · 계획 모드 · 사파리 MCP 서버만).
/// 셸을 거치지 않고 인자 배열로만 넘기며, MCP JSON 은 JSONSerialization 으로 만든다(값을 글자로 이어 붙이지 않는다).
/// 사용자 입력은 명령줄에 넣지 않는다 — 표준 입력의 user 줄(`ClaudeControl.userMessage`)로 간다.
public enum AgentCommandBuilder {
    public static let mcpServerName = "safari-attraction"

    public static func build(resources: URL, gate: GateInfo, memoryHome: URL,
                             resumeSessionID: String?) -> (executable: String, arguments: [String]) {
        var args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                    "--model", CommandBuilder.claudeModel,
                    "--setting-sources", "", "--strict-mcp-config",
                    "--mcp-config", mcpConfigJSON(resources: resources, gate: gate, memoryHome: memoryHome),
                    "--tools", "ExitPlanMode",
                    "--permission-prompt-tool", "stdio", "--permission-mode", "plan"]
        if let id = resumeSessionID, !id.isEmpty { args += ["--resume", id] }
        return ("claude", args)
    }

    static func mcpConfigJSON(resources: URL, gate: GateInfo, memoryHome: URL) -> String {
        let runSh = resources.appendingPathComponent("safari-attraction/run.sh").path
        let config: [String: Any] = [
            "mcpServers": [
                mcpServerName: [
                    "command": "/bin/sh",
                    "args": [runSh],
                    "env": [
                        "SAFARI_ATTRACTION_GATE": gate.socketPath,
                        "SAFARI_ATTRACTION_GATE_TOKEN": gate.token,
                        "SAFARI_ATTRACTION_NO_PERMISSION_PROMPTS": "1",
                        "SAFARI_ATTRACTION_HOME": memoryHome.path,
                    ],
                ],
            ],
        ]
        return ClaudeControl.json(config)
    }
}
