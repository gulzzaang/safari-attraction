import Foundation

/// 로그인한 계정을 화면에 보일 만큼만(이메일 · 플랜). 토큰 · 키 값은 어디에도 담지 않는다.
public struct CLIAccountInfo: Equatable, Sendable {
    public var email: String?
    public var plan: String?
    public var detail: String?
    public init(email: String? = nil, plan: String? = nil, detail: String? = nil) {
        self.email = email; self.plan = plan; self.detail = detail
    }
    /// 「me@example.com · team」 · 없으면 「로그인됨」.
    public var summary: String {
        let parts = [email, plan, detail].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? "로그인됨" : parts.joined(separator: " · ")
    }
}

public enum CLILoginState: Equatable, Sendable {
    /// 아직 안 알아봤거나(또는 알 수 없음: 시간 초과 · 실행 못 함).
    case unknown
    case loggedOut
    case loggedIn(CLIAccountInfo)
    /// 로그인은 안 했지만 쓸 수 있다(opencode 의 무료 모델) — 칩을 흐리게 하지도 막지도 않는다.
    case freeOnly
}

/// 로그인 상태 출력 읽기 — 종료 코드가 먼저, 글은 이메일 · 플랜 · 고정 문구만 뽑고 나머지는 버린다.
public enum CLIAccountParser {
    /// `claude auth status` — 종료 1(또는 `loggedIn:false`)이면 안 됨. JSON 에서 `email` · `subscriptionType` 만.
    public static func parseClaudeStatus(stdout: String, exitCode: Int32) -> CLILoginState {
        if exitCode != 0 { return .loggedOut }
        guard let start = stdout.firstIndex(of: "{"),
              let data = String(stdout[start...]).data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .loggedIn(CLIAccountInfo())
        }
        if let li = obj["loggedIn"] as? Bool, !li { return .loggedOut }
        return .loggedIn(CLIAccountInfo(email: safeEmail(obj["email"]), plan: safePlan(obj["subscriptionType"])))
    }

    /// `codex login status` — 종료 1 이면 안 됨. 글(예: 「Logged in using ChatGPT」)은 고정 문구로만 바꿔 보인다.
    public static func parseCodexStatus(output: String, exitCode: Int32) -> CLILoginState {
        if exitCode != 0 { return .loggedOut }
        let low = output.lowercased()
        if low.contains("not logged in") { return .loggedOut }
        if low.contains("chatgpt") { return .loggedIn(CLIAccountInfo(detail: "ChatGPT 계정")) }
        if low.contains("api key") { return .loggedIn(CLIAccountInfo(detail: "API 키 로그인(구독 아님)")) }
        return .loggedIn(CLIAccountInfo())
    }

    /// `agy models` — 로그인 전용 명령이 없어서 이것으로 본다. 출력(stdout · stderr 합쳐서)에 「Please sign in」 류가 있으면 안 됨,
    /// 종료 0 이고 모델 목록이 나오면 됨. 그 밖(시간 초과 · 빈 목록 · 다른 오류)은 `.unknown`(막지 않음).
    public static func parseAgyStatus(stdout: String, stderr: String, exitCode: Int32) -> (state: CLILoginState, models: [ModelChoice]) {
        if LoginDetector.looksLikeLoginNeeded(stdout + "\n" + stderr) { return (.loggedOut, []) }
        guard exitCode == 0 else { return (.unknown, []) }
        let models = CLIModels.parseAgyModels(stdout)
        return models.isEmpty ? (.unknown, []) : (.loggedIn(CLIAccountInfo()), models)
    }

    /// `opencode auth list --standalone` — 「No authenticated…」 이면 로그인 안 함(무료 모델은 됨 → `.freeOnly`), 종료 0 이면 로그인됨. 목록 글은 버린다.
    public static func parseOpenCodeStatus(output: String, exitCode: Int32) -> CLILoginState {
        if output.lowercased().contains("no authenticated") { return .freeOnly }
        return exitCode == 0 ? .loggedIn(CLIAccountInfo()) : .unknown
    }

    static func safeEmail(_ any: Any?) -> String? {
        guard let s = any as? String else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.count <= 100, t.contains("@"), !t.contains(" "), !t.contains("\n") else { return nil }
        return t
    }

    static func safePlan(_ any: Any?) -> String? {
        guard let s = any as? String else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, t.count <= 24, t.unicodeScalars.allSatisfy({ ($0.value >= 0x30 && $0.value <= 0x39) || ($0.value >= 0x41 && $0.value <= 0x5A) || ($0.value >= 0x61 && $0.value <= 0x7A) || $0 == "_" || $0 == "-" }) else { return nil }
        return t
    }
}
