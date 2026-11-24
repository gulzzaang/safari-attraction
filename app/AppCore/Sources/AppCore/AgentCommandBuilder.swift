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
/// `--tools ExitPlanMode,Write` — 계획 모드에서 클로드는 계획 파일(`~/.claude/plans/…md`)을 Write 로 쓴 뒤 ExitPlanMode 를 부른다(묻지 않고 쓰이고,
/// 입력에 `plan` · `planFilePath` 가 온다). Write 가 없으면 입력이 `{}` 로 비어 계획 카드가 빈다. 승인 뒤의 Write 는 `AgentSession` 이 거절한다.
/// 사용자 입력은 명령줄에 넣지 않는다 — 표준 입력의 user 줄(`ClaudeControl.userMessage`)로 간다.
public enum AgentCommandBuilder {
    public static let mcpServerName = "safari-attraction"

    /// `model` — 설정에서 고른 클로드 모델 id(없으면 기본). 루틴(`buildUnattended`)은 늘 기본 모델.
    public static func build(resources: URL, gate: GateInfo, memoryHome: URL,
                             resumeSessionID: String?, model: String? = nil) -> (executable: String, arguments: [String]) {
        var args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                    "--model", CommandBuilder.claudeModelArgument(model),
                    "--setting-sources", "", "--strict-mcp-config",
                    "--mcp-config", mcpConfigJSON(resources: resources, gate: gate, memoryHome: memoryHome),
                    "--tools", "ExitPlanMode,Write",
                    "--permission-prompt-tool", "stdio", "--permission-mode", "plan"]
        if let id = resumeSessionID, !id.isEmpty { args += ["--resume", id] }
        return ("claude", args)
    }

    /// 사람 없이 도는 루틴용 명령줄 — 일 맡기기와 같되 내장 도구 없음(`--tools ""` — MCP 만) · 계획 모드 아님(`--permission-mode manual`) ·
    /// 이어 하기 없음, MCP 서버에 `SAFARI_ATTRACTION_UNATTENDED=1`(모든 이동 · fetch 를 관문에 묻고 사파리를 켜거나 새 창을 열지 않음).
    public static func buildUnattended(resources: URL, gate: GateInfo, memoryHome: URL) -> (executable: String, arguments: [String]) {
        let args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                    "--model", CommandBuilder.claudeModel,
                    "--setting-sources", "", "--strict-mcp-config",
                    "--mcp-config", mcpConfigJSON(resources: resources, gate: gate, memoryHome: memoryHome, unattended: true),
                    "--tools", "",
                    "--permission-prompt-tool", "stdio", "--permission-mode", "manual"]
        return ("claude", args)
    }

    static func mcpConfigJSON(resources: URL, gate: GateInfo, memoryHome: URL, unattended: Bool = false) -> String {
        let runSh = resources.appendingPathComponent("safari-attraction/run.sh").path
        var env = [
            "SAFARI_ATTRACTION_GATE": gate.socketPath,
            "SAFARI_ATTRACTION_GATE_TOKEN": gate.token,
            "SAFARI_ATTRACTION_NO_PERMISSION_PROMPTS": "1",
            "SAFARI_ATTRACTION_HOME": memoryHome.path,
        ]
        if unattended { env["SAFARI_ATTRACTION_UNATTENDED"] = "1" }
        let config: [String: Any] = [
            "mcpServers": [
                mcpServerName: [
                    "command": "/bin/sh",
                    "args": [runSh],
                    "env": env,
                ],
            ],
        ]
        return ClaudeControl.json(config)
    }
}
