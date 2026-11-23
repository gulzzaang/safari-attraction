import Foundation

/// 로그아웃 상태에서 CLI 가 찍는 문구를 알아본다. 추측이 섞여 있으니 모자라면 `phrases` 에 더한다.
public enum LoginDetector {
    /// 소문자로 맞춰 「포함」 여부만 본다.
    public static let phrases: [String] = [
        "please run /login", "run /login", "not logged in", "not authenticated",
        "authentication required", "authentication_error", "authentication failed", "failed to authenticate",
        "invalid authentication credentials", "invalid api key", "oauth token has expired", "token has expired",
        "please log in", "please login", "login required", "you must log in", "you are not logged in",
        "sign in to continue", "please sign in", "401 unauthorized", "unauthenticated",
        "codex login", "run `codex login`",
    ]

    public static func looksLikeLoginNeeded(_ text: String) -> Bool {
        let low = text.lowercased()
        return phrases.contains { low.contains($0) }
    }
}
