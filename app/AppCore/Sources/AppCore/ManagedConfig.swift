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

    /// opencode 의 도구 · 권한을 모두 끈다. 실제로 막히는지는 로그인 뒤 맥 앞 확인.
    public static let opencodeConfigJSON = #"{"$schema":"https://opencode.ai/config.json","permission":{"*":"deny","edit":"deny","bash":"deny","webfetch":"deny","read":"deny","external_directory":"deny"},"tools":{"bash":false,"read":false,"write":false,"edit":false,"list":false,"glob":false,"grep":false,"webfetch":false,"patch":false,"task":false,"todowrite":false,"todoread":false}}"#

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

    /// `begin` 로 시작하는 줄부터 `end` 로 시작하는 줄까지(둘 다)를 뺀 글.
    static func removeBlock(_ text: String, begin: String, end: String) -> String {
        var out: [Substring] = []
        var skipping = false
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let t = line.trimmingCharacters(in: .whitespaces)
            if skipping { if t.hasPrefix(end) { skipping = false }; continue }
            if t.hasPrefix(begin) { skipping = true; continue }
            out.append(line)
        }
        return out.joined(separator: "\n")
    }

    /// 표 머리줄(`[features]`)부터 다음 표 머리줄 앞까지를 뺀다 — 앱이 `[features]` 를 관리하므로 표시줄 밖에 있는 같은 표는 겹치지 않게 뺀다.
    static func removeTable(_ text: String, header: String) -> String {
        var out: [Substring] = []
        var skipping = false
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("[") { skipping = (t == header) }
            if !skipping { out.append(line) }
        }
        return out.joined(separator: "\n")
    }

    /// 앱 전용 `config.toml` 글 — 맨 위에 `cli_auth_credentials_store = "file"`, 맨 아래에 `[features]`(도구 끄기).
    /// 앱이 관리하는 두 덩어리(표시줄로 감쌈)만 맞추고 그 사이의 다른 줄은 그대로 둔다(단 `cli_auth_credentials_store` 를 따로 적은 줄은 겹치지 않게 뺀다).
    public static func codexConfig(merging existing: String?) -> String {
        var body = removeBlock(existing ?? "", begin: topBegin, end: topEnd)
        body = removeBlock(body, begin: featuresBegin, end: featuresEnd)
        body = removeTable(body, header: "[features]")
        body = body.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("cli_auth_credentials_store") }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let top = [topBegin + note, "cli_auth_credentials_store = \"file\"", topEnd].joined(separator: "\n")
        let features = ([featuresBegin + note, "[features]"] + codexDisabledFeatures.map { "\($0) = false" } + [featuresEnd]).joined(separator: "\n")
        return ([top] + (body.isEmpty ? [] : [body]) + [features]).joined(separator: "\n\n") + "\n"
    }

    /// 두 파일을 쓴다(폴더는 `prepareDirectories` 가 먼저 만든다). 내용이 같으면 건드리지 않고, 쓰면 0600. 못 쓰면 던진다.
    static func write(support: URL) throws {
        let codexURL = codexConfigURL(support: support)
        try writeIfChanged(codexConfig(merging: try? String(contentsOf: codexURL, encoding: .utf8)), to: codexURL)
        try writeIfChanged(opencodeConfigJSON + "\n", to: opencodeConfigURL(support: support))
    }

    private static func writeIfChanged(_ text: String, to url: URL) throws {
        if let cur = try? String(contentsOf: url, encoding: .utf8), cur == text { return }
        try text.write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
