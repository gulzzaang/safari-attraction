import Foundation

/// 질문을 보낼 모델 — 각각 사용자 맥에 깔린 CLI 하나에 대응한다.
public enum ModelKind: String, CaseIterable, Sendable, Equatable {
    case claude, gemini, chatgpt

    /// 앱이 실제로 부르는 CLI. 계획 10 — 클로드와 ChatGPT(codex)만(앱 전용 설정 폴더로 띄운다).
    /// 제미나이(agy) · opencode 는 아직 부르지 않는다(코드는 남겨 두고 여기에 더하면 켜짐).
    public static let enabled: [ModelKind] = [.claude, .chatgpt]

    public var koreanName: String {
        switch self {
        case .claude: return "클로드"
        case .gemini: return "제미나이"
        case .chatgpt: return "ChatGPT"
        }
    }

    /// 부르는 CLI 실행 파일 이름(경로 없이 — ProcessRunner 가 PATH 로 찾는다).
    public var cliName: String {
        switch self {
        case .claude: return "claude"
        case .gemini: return "agy"
        case .chatgpt: return "codex"
        }
    }

    /// 로그인이 풀렸을 때 보여 줄 한 줄(고치는 법 포함).
    /// agy 에는 `login` 하위 명령이 없어서(`agy --help` 확인) 「agy 를 열어」 로만 안내한다.
    public var loginNeededMessage: String {
        switch self {
        case .claude: return "앱 전용 클로드 로그인이 필요해요 — 터미널에서 한 번: CLAUDE_CONFIG_DIR=\"$HOME/Library/Application Support/SafariAttractionApp/claude-config\" claude auth login"
        case .gemini: return "로그인이 필요해요 — 터미널에서 agy 를 열어 로그인해 주세요"
        case .chatgpt: return "설정에서 ChatGPT 로그인을 해 주세요"
        }
    }

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
