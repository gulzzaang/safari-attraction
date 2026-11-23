import Foundation

/// 개발 · 시험 전용 열쇠 — `DEV=1 app/scripts/build.sh` 로 만든 빌드에서만 앱이 받는다(파서 · 설정 읽기는 AppCore 에 남아 있음). 평소에도 꺼져 있다. 앱의 번들 ID 는 `com.gulzzaang.SafariAttractionApp`(a 둘) 이라
/// `defaults write com.gulzzaang.SafariAttractionApp DevHooks -int 1` 로 켠다.
///
/// - `safariattraction://toggle` — 옆 창 열기 · 닫기
/// - `safariattraction://ask?model=claude|gemini|chatgpt&q=…&web=1&page=1[&open=1]` — 질문을 친 것처럼 보내고,
///   끝나면 `~/Library/Application Support/SafariAttractionApp/dev-last.json` 에 결과를 적는다.
public enum DevHooks {
    public static let defaultsKey = "DevHooks"
    public static let scheme = "safariattraction"
    public static let fileName = "dev-last.json"

    /// 읽어 보는 설정 도메인 — 앱 자신의 번들 ID 하나.
    public static let domains = ["com.gulzzaang.SafariAttractionApp"]

    public static func isEnabled(defaults: UserDefaults = .standard) -> Bool {
        defaults.integer(forKey: defaultsKey) == 1
    }

    /// 어느 도메인에서든 1 이 켜져 있으면 켜진다.
    public static func isEnabled(in all: [UserDefaults]) -> Bool { all.contains { isEnabled(defaults: $0) } }

    /// 앱 자신의 설정 도메인(`domains`) 하나만 읽는다 — 전역 도메인 · 실행 인자(`-DevHooks 1`)는 읽지 않는다.
    /// `reader` 는 도메인 이름 → 그 도메인의 설정 사전(없으면 nil). 값은 숫자(또는 불리언) 1 일 때만 켜진다.
    public static func isEnabled(readingDomain reader: (String) -> [String: Any]?) -> Bool {
        domains.contains { domain in
            guard let n = reader(domain)?[defaultsKey] as? NSNumber else { return false }
            return n.intValue == 1
        }
    }

    /// 평소 쓰는 확인 — `defaults write com.gulzzaang.SafariAttractionApp DevHooks -int 1` 로 쓴 값만 본다.
    /// 열쇠를 쓸 때마다 읽는다(앱을 다시 켜지 않아도 된다).
    public static func isEnabled() -> Bool {
        isEnabled(readingDomain: { UserDefaults.standard.persistentDomain(forName: $0) })
    }

    public static func parse(url: URL) -> DevCommand? {
        guard url.scheme?.lowercased() == scheme else { return nil }
        switch url.host?.lowercased() {
        case "toggle":
            return .toggle
        case "ask":
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            func value(_ n: String) -> String? { items.first { $0.name == n }?.value }
            guard let q = value("q"), !q.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            var model = ModelKind.claude
            if let m = value("model") {
                guard let k = ModelKind(rawValue: m.lowercased()) else { return nil }
                model = k
            }
            return .ask(DevAsk(model: model, question: q, webSearch: value("web") == "1",
                               attachPage: value("page") == "1", openPanel: value("open") == "1"))
        default:
            return nil
        }
    }

    public static func resultFile() throws -> URL {
        try AppPaths.supportDirectory().appendingPathComponent(fileName)
    }
}

public struct DevAsk: Equatable, Sendable {
    public var model: ModelKind
    public var question: String
    public var webSearch: Bool
    public var attachPage: Bool
    public var openPanel: Bool
    public init(model: ModelKind, question: String, webSearch: Bool, attachPage: Bool, openPanel: Bool) {
        self.model = model; self.question = question; self.webSearch = webSearch
        self.attachPage = attachPage; self.openPanel = openPanel
    }
}

public enum DevCommand: Equatable, Sendable {
    case toggle
    case ask(DevAsk)
}

/// 한 번 묻고 답한 결과 — `dev-last.json`. 고른 글 · 전체 주소 · 페이지 제목은 담지 않는다(제목은 있었는지만, 주소는 호스트만).
public struct RunRecord: Codable, Equatable, Sendable {
    public struct AttachedPage: Codable, Equatable, Sendable {
        public var titlePresent: Bool
        public var urlHost: String
        public init(titlePresent: Bool, urlHost: String) { self.titlePresent = titlePresent; self.urlHost = urlHost }
        public static func from(_ p: PageContext) -> AttachedPage {
            AttachedPage(titlePresent: !p.title.isEmpty, urlHost: URL(string: p.url)?.host?.lowercased() ?? "")
        }
    }

    public static let answerLimit = 2_000

    public var model: String
    public var question: String
    public var answer: String
    public var error: String?
    public var durationMs: Int
    public var attachedPage: AttachedPage?

    public init(model: String, question: String, answer: String, error: String?, durationMs: Int, attachedPage: AttachedPage?) {
        self.model = model; self.question = question; self.answer = String(answer.prefix(Self.answerLimit))
        self.error = error; self.durationMs = durationMs; self.attachedPage = attachedPage
    }

    private enum CodingKeys: String, CodingKey { case model, question, answer, error, durationMs, attachedPage }

    /// 없는 값도 `null` 로 적는다(키가 늘 같다).
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(model, forKey: .model); try c.encode(question, forKey: .question)
        try c.encode(answer, forKey: .answer); try c.encode(error, forKey: .error)
        try c.encode(durationMs, forKey: .durationMs); try c.encode(attachedPage, forKey: .attachedPage)
    }

    public static var encoder: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return e
    }

    public func write(to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Self.encoder.encode(self).write(to: url, options: .atomic)
    }

    public static func remove(at url: URL) { try? FileManager.default.removeItem(at: url) }
}
