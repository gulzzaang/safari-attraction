import Foundation

/// 제미나이(agy)를 어떻게 띄울지 — 앱 전용 폴더(시험판) 또는 사용자 설정을 함께 쓰기.
/// agy 는 전용 설정 폴더 환경값이 없어서 `HOME` 을 바꾸는 방식뿐인데, 그러면 맥 키체인을 못 찾아 로그인이 될지 아직 모른다.
public enum AgyMode: String, Codable, CaseIterable, Sendable {
    /// `HOME=<지원>/agy-home` (시험판).
    case isolated
    /// 사용자 HOME 그대로 — 앱이 사용자 설정을 바꾸지 않는다.
    case shared

    public var label: String {
        switch self {
        case .isolated: return "앱 전용 폴더(시험판)"
        case .shared: return "내 설정 함께 쓰기"
        }
    }

    /// 「내 설정 함께 쓰기」 일 때 보이는 경고와, 그 끄는 줄.
    public static let sharedWarning = "내 제미나이 설정의 MCP 가 문서 폴더 안이면 허락 창이 뜰 수 있어요 — 터미널에서 `agy mcp disable safari-attraction` 으로 끌 수 있어요"
    public static let disableMCPCommand = "agy mcp disable safari-attraction"
}

/// 구독 CLI 넷(클로드 · 제미나이(agy) · codex · opencode)을 앱 전용 환경으로 부르기 위한 값들 — 환경 · 명령줄 · 폴더.
public enum CLIEnvironment {
    /// 앱이 띄우는 모든 CLI 자식에 덮어쓰는 환경 — 클로드 `CLAUDE_CONFIG_DIR` · codex `CODEX_HOME`.
    /// 사용자 환경에 같은 이름이 있어도 이 값이 이긴다(`ProcessRunner.childEnvironment`).
    /// 두 값을 한 사전에 합쳐 두므로 어느 CLI 를 부르는 실행기든 같은 사전으로 만든다.
    /// agy(`HOME`) · opencode(`XDG_*`)는 다른 CLI 의 자식에 새면 안 되므로 여기에 넣지 않고 `executableEnvironment` 로 따로 준다.
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

    /// agy 를 「앱 전용 폴더」 방식으로 띄울 때의 `HOME`.
    public static func agyHomeDirectory(support: URL) -> URL {
        support.appendingPathComponent("agy-home", isDirectory: true)
    }

    /// opencode 의 `XDG_*` 네 폴더가 모이는 곳과 그 아래 넷.
    public static func opencodeXDGRoot(support: URL) -> URL {
        support.appendingPathComponent("opencode-xdg", isDirectory: true)
    }
    public static func opencodeXDGDirectories(support: URL) -> [String: URL] {
        let root = opencodeXDGRoot(support: support)
        return [
            "XDG_CONFIG_HOME": root.appendingPathComponent("config", isDirectory: true),
            "XDG_DATA_HOME": root.appendingPathComponent("data", isDirectory: true),
            "XDG_STATE_HOME": root.appendingPathComponent("state", isDirectory: true),
            "XDG_CACHE_HOME": root.appendingPathComponent("cache", isDirectory: true),
        ]
    }

    /// opencode 의 앱 전용 환경 — `XDG_*` 넷 + Claude Code 설정 · 프로젝트 설정 · 자동 업데이트 끄기.
    public static func opencodeEnvironment(support: URL) -> [String: String] {
        var env = opencodeXDGDirectories(support: support).mapValues(\.path)
        env["OPENCODE_DISABLE_CLAUDE_CODE"] = "1"
        env["OPENCODE_DISABLE_PROJECT_CONFIG"] = "1"
        env["OPENCODE_DISABLE_AUTOUPDATE"] = "1"
        return env
    }

    /// agy 의 환경 — 앱 전용 폴더 방식이면 `HOME` 하나, 「내 설정 함께 쓰기」 면 없음(사용자 HOME 그대로).
    public static func agyEnvironment(support: URL, mode: AgyMode) -> [String: String] {
        mode == .isolated ? ["HOME": agyHomeDirectory(support: support).path] : [:]
    }

    /// 실행 파일 이름(경로 없이)에 맞춰 자식에 더할 환경 — `ProcessRunner` 가 띄우는 순간에 부른다.
    /// 클로드 · codex 는 빈 값(그 둘은 `overrides` 로 이미 간다) — `HOME` · `XDG_*` 가 새지 않는다.
    public static func executableEnvironment(executable: String, support: URL, agyMode: AgyMode) -> [String: String] {
        switch (executable as NSString).lastPathComponent {
        case "agy": return agyEnvironment(support: support, mode: agyMode)
        case "opencode": return opencodeEnvironment(support: support)
        default: return [:]
        }
    }

    /// 앱 전용 폴더들을 0700 으로 만든다(이미 있으면 그대로). 하나라도 못 만들면 던진다.
    public static func prepareDirectories(support: URL) throws {
        var dirs = [claudeConfigDirectory(support: support), codexHomeDirectory(support: support), agyHomeDirectory(support: support),
                    opencodeXDGRoot(support: support)]
        dirs += opencodeXDGDirectories(support: support).values.sorted { $0.path < $1.path }
        dirs.append(CLIManagedConfig.opencodeConfigDirectory(support: support))
        for dir in dirs {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
        }
        try CLIManagedConfig.write(support: support)
    }

    /// 이 CLI 의 자식에 들어갈 환경 한 줄들(`.command` 파일 · 시험용).
    public static func environment(for kind: ModelKind, support: URL, agyMode: AgyMode = .isolated) -> [String: String] {
        switch kind {
        case .claude: return ["CLAUDE_CONFIG_DIR": claudeConfigDirectory(support: support).path]
        case .chatgpt: return ["CODEX_HOME": codexHomeDirectory(support: support).path]
        case .gemini: return agyEnvironment(support: support, mode: agyMode)
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

    /// `codex exec` — 읽기 전용 · 세션 파일 없음 · 인증은 앱 전용 폴더의 파일. 질문은 늘 마지막 인자.
    /// `modelID` 가 비었거나 안전하지 않은 글자가 있으면 `-m` 을 빼고 codex 기본 모델에 맡긴다.
    public static func codexExec(prompt: String, modelID: String?) -> Command {
        var args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "read-only",
                    "-c", "cli_auth_credentials_store=file"]
        // 도구 끄기(config.toml 의 [features] 와 이중). `--disable <이름>` 은 모르는 이름이면 종료 1 이라 쓰지 않고, `-c features.<이름>=false` 는 모르는 이름도 오류 없이 넘어간다.
        for feature in CLIManagedConfig.codexDisabledFeatures { args += ["-c", "features.\(feature)=false"] }
        if let id = modelID, CLIModels.isSafeID(id) { args += ["-m", id] }
        args.append(prompt)
        return ("codex", args)
    }

    // 제미나이(agy) — 로그인 상태는 전용 명령이 없어 `agy models` 로 본다(목록이 나오면 로그인됨).
    /// agy 의 도구 막기 — `--settings` 의 금지 규칙(파일 읽기 · 쓰기 · 명령 · 주소 읽기 · 실행 · MCP). 웹 검색을 켰을 때만 `read_url` 을 열어 검색 결과 페이지를 읽게 한다.
    /// (박정욱 agy 로 확인: `--mode plan --sandbox` 로는 도구 목록이 그대로였고, 이 금지 규칙은 먹혔다.)
    public static func agySettingsJSON(webSearch: Bool) -> String {
        let denies = ["read_file(*)", "write_file(*)", "command(*)"] + (webSearch ? [] : ["read_url(*)"]) + ["execute_url(*)", "mcp(*)"]
        return #"{"permissions":{"deny":["# + denies.map { "\"\($0)\"" }.joined(separator: ",") + "]}}"
    }

    public static let agyModels: Command = ("agy", ["models", "--settings", agySettingsJSON(webSearch: false)])
    public static let agyUsage: Command = ("agy", ["-p", "/usage", "--output-format", "stream-json", "--settings", agySettingsJSON(webSearch: false)])
    /// 로그인은 터미널에서 `agy` 를 인자 없이(TUI).
    public static let agyLogin: Command = ("agy", [])

    /// `agy -p "<질문>" --model <id> --output-format stream-json --settings <금지 규칙>` — 질문은 `-p` 바로 뒤. `modelID` 가 비었거나 안전하지 않으면 기본 모델.
    public static func agyAsk(prompt: String, modelID: String?, webSearch: Bool = false) -> Command {
        let id = (modelID.flatMap { CLIModels.isSafeID($0) ? $0 : nil }) ?? CommandBuilder.geminiModel
        return ("agy", ["-p", prompt, "--model", id, "--output-format", "stream-json", "--settings", agySettingsJSON(webSearch: webSearch)])
    }

    // opencode — **모든 명령에 `--standalone`**(없으면 이 맥의 공용 상주 서버로 가서 앱 전용 폴더를 안 쓴다).
    public static let opencodeAuthList: Command = ("opencode", ["auth", "list", "--standalone"])
    public static let opencodeModels: Command = ("opencode", ["models", "--standalone"])
    public static let opencodeStats: Command = ("opencode", ["stats", "--json", "--days", "7", "--standalone"])
    public static let opencodeLogin: Command = ("opencode", ["auth", "login", "--standalone"])

    /// `opencode run "<질문>" -m <공급자/모델> --format json --archived --standalone` — 질문은 `run` 바로 뒤.
    /// `modelID` 가 비었거나 안전하지 않으면 `-m` 을 빼고 opencode 기본 모델에 맡긴다.
    public static func opencodeRun(prompt: String, modelID: String?) -> Command {
        var args = ["run", prompt]
        if let id = modelID, CLIModels.isSafeProviderModelID(id) { args += ["-m", id] }
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
