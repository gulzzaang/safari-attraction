import Foundation

/// 구독 CLI 넷(클로드 · 제미나이(agy) · codex · opencode)을 앱 전용 환경으로 부르기 위한 값들 — 환경 · 명령줄 · 폴더.
public enum CLIEnvironment {
    /// 앱이 띄우는 모든 CLI 자식에 덮어쓰는 환경 — 클로드 `CLAUDE_CONFIG_DIR` · codex `CODEX_HOME`.
    /// 사용자 환경에 같은 이름이 있어도 이 값이 이긴다(`ProcessRunner.childEnvironment`).
    /// 두 값을 한 사전에 합쳐 두므로 어느 CLI 를 부르는 실행기든 같은 사전으로 만든다.
    public static func overrides(support: URL) -> [String: String] {
        [
            "CLAUDE_CONFIG_DIR": claudeConfigDirectory(support: support).path,
            "CODEX_HOME": codexHomeDirectory(support: support).path,
        ]
    }

    public static func claudeConfigDirectory(support: URL) -> URL {
        support.appendingPathComponent("claude-config", isDirectory: true)
    }

    public static func codexHomeDirectory(support: URL) -> URL {
        support.appendingPathComponent("codex-home", isDirectory: true)
    }

    /// agy 를 `--gemini_dir` 로 띄울 때의 설정 폴더.
    public static func agyGeminiDirectory(support: URL) -> URL {
        support.appendingPathComponent("agy-gemini", isDirectory: true)
    }

    /// opencode 의 `XDG_*` 폴더가 모이는 곳과 `config` · `state` · `cache`.
    /// `XDG_DATA_HOME` 은 지정하지 않는다 — 평소 `~/.local/share/opencode/opencode.db` 로그인 DB 를 함께 쓴다.
    public static func opencodeXDGRoot(support: URL) -> URL {
        support.appendingPathComponent("opencode-xdg", isDirectory: true)
    }
    public static func opencodeXDGDirectories(support: URL) -> [String: URL] {
        let root = opencodeXDGRoot(support: support)
        return [
            "XDG_CONFIG_HOME": root.appendingPathComponent("config", isDirectory: true),
            "XDG_STATE_HOME": root.appendingPathComponent("state", isDirectory: true),
            "XDG_CACHE_HOME": root.appendingPathComponent("cache", isDirectory: true),
        ]
    }

    /// opencode 의 앱 전용 환경 — `XDG_*` 셋 + 비활성 플래그 + `OPENCODE_CONFIG_CONTENT`.
    public static func opencodeEnvironment(support: URL) -> [String: String] {
        var env = opencodeXDGDirectories(support: support).mapValues(\.path)
        env["OPENCODE_DISABLE_CLAUDE_CODE"] = "1"
        env["OPENCODE_DISABLE_PROJECT_CONFIG"] = "1"
        env["OPENCODE_DISABLE_AUTOUPDATE"] = "1"
        env["OPENCODE_CONFIG_CONTENT"] = CLIManagedConfig.opencodeConfigJSON
        return env
    }

    /// 실행 파일 이름(경로 없이)에 맞춰 자식에 더할 환경 — `ProcessRunner` 가 띄우는 순간에 부른다.
    /// 클로드 · codex · agy 는 빈 값(agy 는 `--gemini_dir`, 클로드 · codex 는 `overrides`) — `HOME` · `XDG_*` 가 새지 않는다.
    public static func executableEnvironment(executable: String, support: URL) -> [String: String] {
        switch (executable as NSString).lastPathComponent {
        case "opencode": return opencodeEnvironment(support: support)
        default: return [:]
        }
    }

    /// 앱 전용 폴더들을 0700 으로 만든다(이미 있으면 그대로). 하나라도 못 만들면 던진다.
    public static func prepareDirectories(support: URL, resources: URL? = nil) throws {
        let agyDir = agyGeminiDirectory(support: support)
        var dirs = [claudeConfigDirectory(support: support), codexHomeDirectory(support: support),
                    agyDir, agyDir.appendingPathComponent("config", isDirectory: true),
                    opencodeXDGRoot(support: support)]
        dirs += opencodeXDGDirectories(support: support).values.sorted { $0.path < $1.path }
        for dir in dirs {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
        }
        try CLIManagedConfig.write(support: support, resources: resources)
    }

    /// 이 CLI 의 자식에 들어갈 환경 한 줄들(`.command` 파일 · 시험용).
    public static func environment(for kind: ModelKind, support: URL) -> [String: String] {
        switch kind {
        case .claude: return ["CLAUDE_CONFIG_DIR": claudeConfigDirectory(support: support).path]
        case .chatgpt: return ["CODEX_HOME": codexHomeDirectory(support: support).path]
        case .gemini: return [:]
        case .opencode: return opencodeEnvironment(support: support)
        }
    }
}

/// CLI 마다 부르는 명령줄(셸을 거치지 않고 인자 배열로만 넘긴다).
public enum CLICommands {
    public typealias Command = (executable: String, arguments: [String])

    /// 시간 상한(초) — 설정 창의 읽기 작업 하나당.
    public static let readTimeout: TimeInterval = 20
    /// 기기 코드 로그인을 기다리는 최대 시간(초).
    public static let deviceLoginTimeout: TimeInterval = 900

    public static let claudeAuthStatus: Command = ("claude", ["auth", "status"])
    public static let claudeUsage: Command = ("claude", ["-p", "/usage", "--output-format", "json"])
    public static let claudeLogin: Command = ("claude", ["auth", "login", "--claudeai"])

    public static let codexLoginStatus: Command = ("codex", ["login", "status"])
    public static let codexModels: Command = ("codex", ["debug", "models"])
    public static let codexAppServer: Command = ("codex", ["app-server"])
    public static let codexDeviceLogin: Command = ("codex", ["login", "--device-auth"])

    private static func tomlString(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }

    /// `codex exec` — 읽기 전용 · 세션 파일 없음 · 인증은 앱 전용 폴더의 파일 · 웹 검색 늘 켬. 질문은 늘 마지막 인자.
    /// `modelID` 가 비었거나 안전하지 않은 글자가 있으면 `-m` 을 빼고 codex 기본 모델에 맡긴다.
    public static func codexExec(prompt: String, modelID: String?, effort: String? = nil, safariTools: SafariTools? = nil) -> Command {
        var args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "read-only",
                    "-c", "cli_auth_credentials_store=file"]
        // 도구 끄기(config.toml 의 [features] 와 이중). `--disable <이름>` 은 모르는 이름이면 종료 1 이라 쓰지 않고, `-c features.<이름>=false` 는 모르는 이름도 오류 없이 넘어간다.
        for feature in CLIManagedConfig.codexDisabledFeatures { args += ["-c", "features.\(feature)=false"] }
        args += ["-c", #"web_search="live""#]
        if let effort, !effort.isEmpty, CLIModels.isSafeID(effort) {
            args += ["-c", "model_reasoning_effort=\"\(effort)\""]
        }
        if let tools = safariTools {
            args += [
                "-c", #"mcp_servers.safari-attraction.command="/bin/sh""#,
                "-c", "mcp_servers.safari-attraction.args=[\"\(tomlString(tools.runScript))\"]",
                "-c", "mcp_servers.safari-attraction.env={SAFARI_ATTRACTION_GATE_FILE=\"\(tomlString(tools.gateFile))\",SAFARI_ATTRACTION_HOME=\"\(tomlString(tools.memoryHome))\",SAFARI_ATTRACTION_NO_PERMISSION_PROMPTS=\"1\"}",
                "-c", #"mcp_servers.safari-attraction.default_tools_approval_mode="approve""#,
            ]
        }
        if let id = modelID, CLIModels.isSafeID(id) { args += ["-m", id] }
        args.append(prompt)
        return ("codex", args)
    }

    // 제미나이(agy) — 늘 `--gemini_dir <지원>/agy-gemini` 를 붙이고, 로그인 상태는 `agy models` 로 본다(목록이 나오면 로그인됨).
    /// agy 의 도구 막기 — `safariTools` 가 있으면 `safari-attraction` MCP 만 허용하고 파일 · 셸 · URL 실행을 막는다. 없으면 `mcp(*)` 도 막는다.
    public static func agySettingsJSON(safariTools: Bool) -> String {
        if safariTools {
            return #"{"permissions":{"allow":["mcp(safari-attraction/*)"],"deny":["read_file(*)","write_file(*)","command(*)","execute_url(*)"]}}"#
        }
        return #"{"permissions":{"deny":["read_file(*)","write_file(*)","command(*)","execute_url(*)","mcp(*)"]}}"#
    }

    /// `agy models` 는 `--settings` 를 모르는 플래그로 거절(종료 1)하고 도구도 안 쓰므로 붙이지 않는다.
    public static func agyModels(geminiDir: URL) -> Command {
        ("agy", ["--gemini_dir", geminiDir.path, "models"])
    }
    public static func agyUsage(geminiDir: URL) -> Command {
        ("agy", ["--gemini_dir", geminiDir.path, "-p", "/usage", "--output-format", "stream-json", "--settings", agySettingsJSON(safariTools: false)])
    }
    /// 로그인은 터미널에서 `agy` 를 인자 없이(TUI).
    public static let agyLogin: Command = ("agy", [])

    /// `agy --gemini_dir <dir> -p "<질문>" --model <id> --output-format stream-json --settings <권한 규칙>` — `--effort` 는 쓰지 않는다.
    public static func agyAsk(prompt: String, modelID: String?, safariTools: Bool = false, geminiDir: URL) -> Command {
        let id = (modelID.flatMap { CLIModels.isSafeID($0) ? $0 : nil }) ?? CommandBuilder.geminiModel
        return ("agy", ["--gemini_dir", geminiDir.path, "-p", prompt, "--model", id, "--output-format", "stream-json",
                        "--settings", agySettingsJSON(safariTools: safariTools)])
    }

    // opencode — **모든 명령에 `--standalone`**(없으면 이 맥의 공용 상주 서버로 가서 앱 전용 폴더를 안 쓴다).
    public static let opencodeAuthList: Command = ("opencode", ["auth", "list", "--standalone"])
    public static let opencodeModels: Command = ("opencode", ["models", "--standalone"])
    public static let opencodeStats: Command = ("opencode", ["stats", "--json", "--days", "7", "--standalone"])
    public static let opencodeLogin: Command = ("opencode", ["auth", "login", "--standalone"])

    /// `opencode run "<질문>" [-m <공급자/모델[#변형]>] --format json --archived --standalone` — 질문은 `run` 바로 뒤.
    /// `modelID` 가 비었거나 안전하지 않으면 `-m` 을 빼고 opencode 기본 모델에 맡긴다.
    public static func opencodeRun(prompt: String, modelID: String?, effort: String? = nil) -> Command {
        var args = ["run", prompt]
        if let id = modelID, CLIModels.isSafeProviderModelID(id) {
            let base = id.split(separator: "#", maxSplits: 1).first.map(String.init) ?? id
            let full = (effort.flatMap { !$0.isEmpty && CLIModels.isSafeID($0) ? "\(base)#\($0)" : nil }) ?? id
            args += ["-m", full]
        }
        args += ["--format", "json", "--archived", "--standalone"]
        return ("opencode", args)
    }

    /// 사용자에게 보일 CLI 이름.
    public static func displayName(_ kind: ModelKind) -> String {
        switch kind {
        case .claude: return "클로드"
        case .chatgpt: return "ChatGPT(codex)"
        case .gemini: return "제미나이(agy)"
        case .opencode: return "opencode"
        }
    }
}

/// 이 앱이 구독 CLI 로 다루는 것들(설정 창 · CLI 고르기).
public extension ModelKind {
    /// 로그인 · 사용량을 다루는 CLI(설정 창 줄 순서).
    static let subscriptionCLIs: [ModelKind] = [.claude, .gemini, .chatgpt, .opencode]
}
