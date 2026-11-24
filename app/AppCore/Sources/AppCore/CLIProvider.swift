import Foundation

/// 구독 CLI(클로드 · codex)를 앱 전용 환경으로 부르기 위한 값들 — 환경 · 명령줄 · 폴더.
/// 이번 범위는 클로드와 ChatGPT(codex) 둘. 제미나이(agy) · opencode 는 부르지 않는다.
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

    /// 앱 전용 폴더들을 0700 으로 만든다(이미 있으면 그대로). 하나라도 못 만들면 던진다.
    public static func prepareDirectories(support: URL) throws {
        for dir in [claudeConfigDirectory(support: support), codexHomeDirectory(support: support)] {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
        }
    }

    /// 이 CLI 의 자식에 들어갈 환경 한 줄들(`.command` 파일 · 시험용).
    public static func environment(for kind: ModelKind, support: URL) -> [String: String] {
        switch kind {
        case .claude: return ["CLAUDE_CONFIG_DIR": claudeConfigDirectory(support: support).path]
        case .chatgpt: return ["CODEX_HOME": codexHomeDirectory(support: support).path]
        case .gemini: return [:]
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
        if let id = modelID, CLIModels.isSafeID(id) { args += ["-m", id] }
        args.append(prompt)
        return ("codex", args)
    }

    /// 사용자에게 보일 CLI 이름.
    public static func displayName(_ kind: ModelKind) -> String {
        switch kind {
        case .claude: return "클로드"
        case .chatgpt: return "ChatGPT(codex)"
        case .gemini: return "제미나이"
        }
    }
}

/// 이 앱이 구독 CLI 로 다루는 것들(설정 창 · CLI 고르기).
public extension ModelKind {
    /// 이번 범위에서 로그인 · 사용량을 다루는 CLI.
    static let subscriptionCLIs: [ModelKind] = [.claude, .chatgpt]
}
