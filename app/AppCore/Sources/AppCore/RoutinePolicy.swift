import Foundation

/// 루틴 한 번의 결과 — 기록에 남는 상태(`RoutineRecord.status…`)와 답.
public struct RoutineOutcome: Equatable, Sendable {
    public var status: String
    public var answer: String
    public init(status: String, answer: String) {
        self.status = status
        self.answer = answer
    }
}

/// 루틴(사람 없이 도는 일)의 동작 관문 판정(순수 함수). 사람에게 묻지 않고 허락 · 거절만 한다.
///
/// - 호스트가 루틴의 「갈 수 있는 사이트」 목록에 없으면 거절(`SiteList.allows` — 빈 호스트 · 포트 · 사용자 정보가 든 호스트도 거절).
/// - 목록 안: `open` · `goto` · `nav` · GET/HEAD `fetch`(되돌릴 수 없음 false)만 허락, 그 밖은 모두 거절(루틴은 읽기만).
/// - 서버(사람 없음 모드)가 이미 모든 이동 · 새 탭 · fetch 를 묻고, 이 판정이 두 번째 문이다.
public enum RoutinePolicy {
    public static let notAllowedSiteReason = "이 루틴이 갈 수 있는 사이트가 아니에요"
    public static let readOnlyReason = "루틴은 읽기만 해요"
    /// 루틴 한 번의 시간 상한(초).
    public static let timeout: TimeInterval = 600

    static let readOnlyNavigation: Set<String> = ["open", "goto", "nav"]
    static let readMethods: Set<String> = ["GET", "HEAD"]

    /// - Parameter method: `fetch` 의 메서드(모르면 nil — 되돌릴 수 없음 값만 본다).
    public static func decide(action: String, host: String, irreversible: Bool?, method: String?, sites: [String]) -> GateDecision {
        guard SiteList.allows(host: host, list: sites) else { return .deny(notAllowedSiteReason) }
        if readOnlyNavigation.contains(action) {
            return irreversible == true ? .deny(readOnlyReason) : .allow
        }
        if action == "fetch", irreversible == false {
            if let method, !readMethods.contains(method.uppercased()) { return .deny(readOnlyReason) }
            return .allow
        }
        return .deny(readOnlyReason)
    }

    /// 서버가 fetch 를 물을 때 대상 글은 `GET https://…` 꼴이다 — 앞의 메서드 낱말(없으면 nil).
    static func fetchMethod(fromTarget target: String) -> String? {
        guard let first = target.split(whereSeparator: { $0 == " " || $0 == "\t" }).first else { return nil }
        let word = String(first)
        guard word.range(of: "^[A-Za-z]+$", options: .regularExpression) != nil else { return nil }
        return word.uppercased()
    }

    /// 질문 앞에 그대로 붙이는 글(끝의 빈 줄 포함).
    public static func promptPrefix(sites: [String]) -> String {
        "사람 없이 도는 루틴이에요. 읽기만 할 수 있고 누르기 · 입력은 거절돼요. 갈 수 있는 사이트: \(sites.joined(separator: ", ")). 되묻지 말고 읽은 것을 정리해 답하세요.\n\n"
    }
}
