import Foundation

/// 앱이 앱 전용 폴더 안에 직접 쓰는 설정 파일 — codex `config.toml`(인증 저장 · 도구 끄기)과 opencode `opencode.json`(도구 · 권한 끄기).
/// 앱은 대화만 시키므로 CLI 가 셸 · 파일 · 브라우저 같은 도구를 쓰지 못하게 한다.
public enum CLIManagedConfig {
    /// codex 가 도구를 못 쓰게 끄는 기능 이름들 — `codex exec -c features.<이름>=false` 와 `config.toml` 의 `[features]` 가 같은 목록을 쓴다.
    /// (박정욱 codex 로 확인: 모두 끄면 답은 되고 「파일 목록을 명령으로」 는 「못 합니다」.)
    public static let codexDisabledFeatures: [String] = [
        "shell_tool", "unified_exec", "unified_exec_tty", "shell_snapshot", "computer_use", "browser_use", "browser_use_external",
        "browser_use_full_cdp_access", "in_app_browser", "apps", "plugins", "remote_plugin", "hooks", "multi_agent", "view_image",
        "image_generation", "skill_mcp_dependency_install", "workspace_dependencies", "worktrees",
    ]

    /// opencode 의 도구 · 권한을 모두 끈다(기본 설정).
    public static let opencodeConfigJSON = #"{"$schema":"https://opencode.ai/config.json","permission":{"*":"deny","edit":"deny","bash":"deny","webfetch":"deny","read":"deny","external_directory":"deny"},"tools":{"bash":false,"read":false,"write":false,"edit":false,"list":false,"glob":false,"grep":false,"webfetch":false,"patch":false,"task":false,"todowrite":false,"todoread":false}}"#

    /// `OPENCODE_CONFIG_CONTENT` 에 넣을 JSON — `safariTools` 가 있으면 `safari-attraction_*` 허용과 로컬 MCP 서버를 더한다.
    public static func opencodeConfigJSON(safariTools: SafariTools?) -> String {
        guard let tools = safariTools else { return opencodeConfigJSON }
        let obj: [String: Any] = [
            "$schema": "https://opencode.ai/config.json",
            "permission": [
                "*": "deny",
                "edit": "deny",
                "bash": "deny",
                "webfetch": "deny",
                "read": "deny",
                "external_directory": "deny",
                "\(AgentCommandBuilder.mcpServerName)_*": "allow",
            ],
            "tools": [
                "bash": false, "read": false, "write": false, "edit": false,
                "list": false, "glob": false, "grep": false, "webfetch": false,
                "patch": false, "task": false, "todowrite": false, "todoread": false,
            ],
            "mcp": [
                AgentCommandBuilder.mcpServerName: [
                    "type": "local",
                    "command": ["/bin/sh", tools.runScript],
                    "environment": [
                        "SAFARI_ATTRACTION_GATE_FILE": tools.gateFile,
                        "SAFARI_ATTRACTION_NO_PERMISSION_PROMPTS": "1",
                        "SAFARI_ATTRACTION_HOME": tools.memoryHome,
                    ],
                ],
            ],
        ]
        return ClaudeControl.json(obj)
    }

    public static func agyMCPConfigURL(support: URL) -> URL {
        CLIEnvironment.agyGeminiDirectory(support: support)
            .appendingPathComponent("config", isDirectory: true)
            .appendingPathComponent("mcp_config.json")
    }

    /// `<지원>/agy-gemini/config/mcp_config.json` 에 쓸 내용 — `safari-attraction` 서버 하나, 토큰은 넣지 않는다.
    public static func agyMCPConfigJSON(support: URL, resources: URL) -> String {
        let runSh = resources.appendingPathComponent("safari-attraction/run.sh").path
        let gateFile = GateLink.url(support: support).path
        let memoryHome = support.appendingPathComponent("memory", isDirectory: true).path
        let obj: [String: Any] = [
            "mcpServers": [
                AgentCommandBuilder.mcpServerName: [
                    "command": "/bin/sh",
                    "args": [runSh],
                    "env": [
                        "SAFARI_ATTRACTION_GATE_FILE": gateFile,
                        "SAFARI_ATTRACTION_NO_PERMISSION_PROMPTS": "1",
                        "SAFARI_ATTRACTION_HOME": memoryHome,
                    ],
                ],
            ],
        ]
        return ClaudeControl.json(obj)
    }

    static let topBegin = "# >>> safari-attraction:top"
    static let topEnd = "# <<< safari-attraction:top"
    static let featuresBegin = "# >>> safari-attraction:features"
    static let featuresEnd = "# <<< safari-attraction:features"
    static let note = " (앱이 관리하는 줄 — 고쳐도 다시 맞춰져요)"

    public static func codexConfigURL(support: URL) -> URL {
        CLIEnvironment.codexHomeDirectory(support: support).appendingPathComponent("config.toml")
    }

    /// opencode 는 `XDG_CONFIG_HOME/opencode/opencode.json` 을 읽는다.
    public static func opencodeConfigDirectory(support: URL) -> URL {
        CLIEnvironment.opencodeXDGDirectories(support: support)["XDG_CONFIG_HOME"]!.appendingPathComponent("opencode", isDirectory: true)
    }
    public static func opencodeConfigURL(support: URL) -> URL {
        opencodeConfigDirectory(support: support).appendingPathComponent("opencode.json")
    }

    /// 표 머리줄(`[이름]`)이면 그 안 글(`#` 앞 · 공백 뺀)을, 아니면 nil. `[features] # 설명` 도 같은 표로 읽는다.
    static func tableHeader(_ trimmedLine: String) -> String? {
        guard trimmedLine.hasPrefix("[") else { return nil }
        let head = (trimmedLine.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? trimmedLine)
            .trimmingCharacters(in: .whitespaces)
        return head.hasPrefix("[") && head.hasSuffix("]") ? head : nil
    }

    /// `키 = 값` 줄의 키(앞뒤 공백 뺀). `=` 가 없으면 nil.
    static func keyName(_ line: String) -> String? {
        guard let eq = line.firstIndex(of: "=") else { return nil }
        return line[line.startIndex..<eq].trimmingCharacters(in: .whitespaces)
    }

    /// 앱 전용 `config.toml` 글 — 맨 위에 `cli_auth_credentials_store = "file"`, 맨 아래에 `[features]`(도구 끄기).
    /// 앱이 관리하는 두 덩어리(표시줄로 감쌈)만 맞추고 그 사이의 다른 줄은 그대로 둔다.
    /// - 최상위의 `cli_auth_credentials_store = …` 줄(키 이름이 정확히 같은 것)은 겹치지 않게 뺀다.
    /// - 사용자가 따로 둔 `[features]` 표(`[features] # …` 도 같은 표)의 **다른 키는 지우지 않고** 앱 관리 덩어리 안으로 옮겨 남긴다(앱 목록과 같은 이름이면 앱 값이 이긴다).
    public static func codexConfig(merging existing: String?) -> String {
        let appKeys = Set(codexDisabledFeatures)
        var body: [String] = []
        var userFeatures: [String] = []
        // 0 보통 · 1 앱 top 덩어리 안 · 2 앱 features 덩어리 안 · 3 사용자 [features] 표 안
        var mode = 0
        var seenHeader = false
        func collect(_ line: String) {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { return }
            if let k = keyName(t), appKeys.contains(k) { return }
            userFeatures.append(line)
        }
        for line in (existing ?? "").split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let t = line.trimmingCharacters(in: .whitespaces)
            if mode == 1 { if t.hasPrefix(topEnd) { mode = 0 }; continue }
            if mode == 2 {
                if t.hasPrefix(featuresEnd) { mode = 0 } else if tableHeader(t) != "[features]" { collect(line) }
                continue
            }
            if t.hasPrefix(topBegin) { mode = 1; continue }
            if t.hasPrefix(featuresBegin) { mode = 2; continue }
            if let head = tableHeader(t) {
                seenHeader = true
                if head == "[features]" { mode = 3; continue }
                mode = 0
                body.append(line)
                continue
            }
            if mode == 3 { collect(line); continue }
            if !seenHeader, keyName(t) == "cli_auth_credentials_store" { continue }
            body.append(line)
        }
        let bodyText = body.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        let top = [topBegin + note, "cli_auth_credentials_store = \"file\"", topEnd].joined(separator: "\n")
        let features = ([featuresBegin + note, "[features]"] + codexDisabledFeatures.map { "\($0) = false" } + userFeatures + [featuresEnd]).joined(separator: "\n")
        return ([top] + (bodyText.isEmpty ? [] : [bodyText]) + [features]).joined(separator: "\n\n") + "\n"
    }

    /// 앱 설정 파일(`codex config.toml` · `agy-gemini/config/mcp_config.json`)을 쓴다. 내용이 같으면 건드리지 않고, 쓰면 0600. 못 쓰면 던진다.
    /// `opencode.json` 은 더 이상 쓰지 않는다(`OPENCODE_CONFIG_CONTENT` 사용, 옛 파일은 지우지 않음).
    public static func write(support: URL, resources: URL? = nil) throws {
        let codexURL = codexConfigURL(support: support)
        try writeIfChanged(codexConfig(merging: try? String(contentsOf: codexURL, encoding: .utf8)), to: codexURL)
        if let resources {
            let mcpURL = agyMCPConfigURL(support: support)
            try FileManager.default.createDirectory(at: mcpURL.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            try writeIfChanged(agyMCPConfigJSON(support: support, resources: resources) + "\n", to: mcpURL)
        }
    }

    private static func writeIfChanged(_ text: String, to url: URL) throws {
        if let cur = try? String(contentsOf: url, encoding: .utf8), cur == text { return }
        try text.write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
