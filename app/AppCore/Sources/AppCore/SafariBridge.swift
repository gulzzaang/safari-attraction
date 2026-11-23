import CoreGraphics

/// 사파리 읽기 실패의 종류 — 화면이 이유에 맞는 한국어 안내를 보일 수 있게 한다.
public enum SafariBridgeError: Error, Sendable, Equatable {
    /// 자동화 허락 없음(AppleEvent -1743 · -1744).
    case automationDenied
    /// 사파리의 「Apple 이벤트에서 JavaScript 허용」이 꺼져 있음(고른 글을 못 읽는다).
    case javaScriptDisabled
    case notRunning
    case noWindow
    case timedOut
    case failed(number: Int, message: String)

    /// AppleScript 오류 번호 · 문구를 이유로 바꾼다. 문구는 현지화될 수 있어 번호를 먼저 본다.
    /// `whileRunningJavaScript` 가 true 면(`do JavaScript` 단계) 「JavaScript + Apple 이벤트」 문구도 꺼짐으로 읽는다.
    public static func classify(number: Int, message: String, whileRunningJavaScript: Bool = false) -> SafariBridgeError {
        switch number {
        case -1743, -1744: return .automationDenied
        case -600: return .notRunning
        case -1728, -1719: return .noWindow
        case -1712: return .timedOut
        default: break
        }
        if whileRunningJavaScript {
            let m = message.lowercased()
            if m.contains("javascript") && (m.contains("apple event") || m.contains("apple 이벤트") || m.contains("develop") || m.contains("개발")) {
                return .javaScriptDisabled
            }
        }
        return .failed(number: number, message: message)
    }

    /// 사용자에게 보이는 한 줄(고치는 법 포함).
    public var hint: String {
        switch self {
        case .automationDenied:
            return "사파리를 읽을 권한이 없어요. 시스템 설정 → 개인정보 보호 및 보안 → 자동화에서 사파리-어트랙션의 Safari 를 켜 주세요. 그동안 「이 페이지 함께」는 꺼 둘게요."
        case .javaScriptDisabled:
            return "고른 글을 읽으려면 사파리 개발자 메뉴에서 「Apple 이벤트에서 JavaScript 허용」을 켜 주세요. 제목 · 주소는 그대로 붙어요."
        case .notRunning:
            return "사파리가 꺼져 있어서 지금 페이지를 붙일 수 없어요."
        case .noWindow:
            return "열린 사파리 창이 없어서 지금 페이지를 붙일 수 없어요."
        case .timedOut:
            return "사파리가 바로 답하지 않아 지금 페이지를 붙이지 못했어요. 잠시 뒤 다시 해 보세요."
        case .failed:
            return "사파리에서 지금 페이지를 읽지 못했어요."
        }
    }
}

/// 지금 탭을 읽은 결과. JS 가 꺼져 고른 글만 못 읽었으면 `selectionIssue` 에 이유가 담기고 제목 · 주소는 그대로 온다.
public struct TabReading: Sendable, Equatable {
    public var page: PageContext
    public var selectionIssue: SafariBridgeError?
    public init(page: PageContext, selectionIssue: SafariBridgeError? = nil) {
        self.page = page; self.selectionIssue = selectionIssue
    }
}

/// 사파리를 읽는 다리. 구현은 읽기 전용이어야 한다(사파리를 앞으로 가져오지 않고, 탭 · 창을 열지 않고, 움직이지 않는다).
/// 모든 호출은 막힐 수 있다(시간 상한은 구현 몫) — **메인 스레드에서 부르지 말 것.**
public protocol SafariBridging: Sendable {
    /// 사파리가 떠 있나(AppleEvent 없이 확인 — 사파리를 켜지 않는다).
    func isSafariRunning() -> Bool
    /// 사파리가 가장 앞 앱인가(AppleEvent 없이 확인).
    func isFrontmost() -> Bool
    /// 사파리 앞 창의 위치 — **왼쪽 위 기준 전역 좌표**(`ScreenCoordinates` 로 AppKit 좌표로 바꾼다). 못 읽으면 nil.
    func frontWindowBounds() -> CGRect?
    /// 앞 창의 지금 탭(제목 · 주소 · 고른 글).
    func frontTab() -> Result<TabReading, SafariBridgeError>
}

/// 「이 페이지 함께」를 켜고 질문을 보낼 때 쓰는 결과 — 화면은 이걸 그대로 따른다.
public struct PageAttachment: Sendable, Equatable {
    /// 붙일 페이지(못 붙이면 nil).
    public var page: PageContext?
    /// 한국어 안내(없으면 nil).
    public var hint: String?
    /// true 면 「이 페이지 함께」 를 끈다.
    public var turnOffToggle: Bool

    public static func resolve(_ result: Result<TabReading, SafariBridgeError>) -> PageAttachment {
        switch result {
        case .success(let r):
            return PageAttachment(page: r.page, hint: r.selectionIssue?.hint, turnOffToggle: false)
        case .failure(let e):
            return PageAttachment(page: nil, hint: e.hint, turnOffToggle: true)
        }
    }
}
