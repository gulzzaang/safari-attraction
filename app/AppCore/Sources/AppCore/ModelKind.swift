import Foundation

/// 질문을 보낼 모델 — 각각 사용자 맥에 깔린 CLI 하나에 대응한다.
public enum ModelKind: String, CaseIterable, Sendable, Equatable {
    case claude, gemini, chatgpt, opencode

    /// 앱이 실제로 부르는 CLI(옆 창 칩 순서). 계획 10 — 네 CLI 모두 앱 전용 환경으로 띄운다.
    public static let enabled: [ModelKind] = [.claude, .gemini, .chatgpt, .opencode]

    public var koreanName: String {
        switch self {
        case .claude: return "클로드"
        case .gemini: return "제미나이"
        case .chatgpt: return "ChatGPT"
        case .opencode: return "opencode"
        }
    }

    /// 부르는 CLI 실행 파일 이름(경로 없이 — ProcessRunner 가 PATH 로 찾는다).
    public var cliName: String {
        switch self {
        case .claude: return "claude"
        case .gemini: return "agy"
        case .chatgpt: return "codex"
        case .opencode: return "opencode"
        }
    }

    /// 로그인이 풀렸을 때 보여 줄 한 줄(고치는 법 포함).
    public var loginNeededMessage: String {
        switch self {
        case .claude: return "앱 전용 클로드 로그인이 필요해요 — 터미널에서 한 번: CLAUDE_CONFIG_DIR=\"$HOME/Library/Application Support/SafariAttractionApp/claude-config\" claude auth login"
        case .gemini: return "설정에서 제미나이 로그인을 해 주세요"
        case .chatgpt: return "설정에서 ChatGPT 로그인을 해 주세요"
        case .opencode: return "설정에서 opencode 로그인을 해 주세요 — 로그인 없이 쓰는 무료 사용량은 금방 막혀요"
        }
    }

    /// opencode 가 `provider.free-limit` · 「Free usage limit reached」 · 「Insufficient balance」 로 거절했을 때.
    public static let opencodeFreeLimitMessage = "무료 한도가 찼어요 — OpenCode Go 로 로그인하면 계속 쓸 수 있어요"

    public var notFoundMessage: String {
        "\(cliName) 를 찾지 못했어요 — 설치돼 있는지, 터미널에서 \(cliName) 가 실행되는지 확인해 주세요"
    }

    /// 실행 결과를 사용자에게 보일 한국어 한 줄로. 보일 것이 없으면(정상 · 사용자가 멈춤) nil.
    public func userMessage(for outcome: RunOutcome, stderrTail: String = "") -> String? {
        switch outcome {
        case .finished(let code):
            if code == 0 { return nil }
            let tail = stderrTail.trimmingCharacters(in: .whitespacesAndNewlines)
            return "\(cliName) 가 오류로 끝났어요 (종료 코드 \(code))" + (tail.isEmpty ? "" : " — \(tail)")
        case .timedOut:
            return "\(Int(ProcessRunner.defaultTimeout))초가 지나 멈췄어요 — 질문을 줄이거나 다시 시도해 주세요"
        case .stopped:
            return nil
        case .notFound:
            return notFoundMessage
        case .failed(let why):
            return "\(cliName) 를 실행하지 못했어요 — \(why)"
        }
    }
}
