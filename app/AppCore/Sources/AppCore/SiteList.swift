import Foundation

/// 루틴이 갈 수 있는 사이트 목록 — 글에서 호스트 뽑기 · 호스트가 목록에 드는지 비교.
public enum SiteList {
    /// 글 속 주소(`https://www.coupang.com/np/search`)와 맨 도메인(`naver.com`)에서 호스트를 뽑는다.
    /// 소문자, 앞의 `www.` · `m.` 떼기, 중복 없음, 처음 나온 차례. 주소의 길 · 쿼리 안에 든 도메인은 따로 뽑지 않는다.
    public static func extractHosts(from text: String) -> [String] {
        let range = NSRange(text.startIndex..., in: text)
        var out: [String] = []
        var seen = Set<String>()
        for m in hostPattern.matches(in: text, range: range) {
            guard m.numberOfRanges > 1, let r = Range(m.range(at: 1), in: text) else { continue }
            let host = stripPrefixes(normalize(String(text[r])))
            guard isUsableEntry(host), let tld = host.split(separator: ".").last, !fileExtensions.contains(String(tld)) else { continue }
            if seen.insert(host).inserted { out.append(host) }
        }
        return out
    }

    /// 사람이 목록 칸에 직접 친 한 줄(`docs.rs` · `https://www.coupang.com/np/search`)을 목록 항목으로. 쓸 수 없으면 nil.
    /// 글에서 도메인을 찾는 `extractHosts` 와 달리 파일 확장자처럼 보이는 끝(`.rs` 등)도 받는다(사람이 직접 쳤으니). 주소의 길 · 쿼리 · 포트는 떼고,
    /// 스킴 뒤 사용자 정보(`https://a.com@evil.com`)는 실제 호스트(`evil.com`)를 쓴다. 스킴 없는 `a.com@b.com` · 공백 · 점 없는 낱말 · 공개 접미사(`co.kr`)는 nil.
    public static func entry(fromUserInput text: String) -> String? {
        var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasScheme = t.range(of: "://") != nil
        if let r = t.range(of: "://") { t = String(t[r.upperBound...]) }
        if let end = t.firstIndex(where: { "/?#".contains($0) }) { t = String(t[..<end]) }
        if let at = t.lastIndex(of: "@") {
            guard hasScheme else { return nil }
            t = String(t[t.index(after: at)...])
        }
        if let colon = t.lastIndex(of: ":"), !t[t.index(after: colon)...].isEmpty, t[t.index(after: colon)...].allSatisfy(\.isASCII), t[t.index(after: colon)...].allSatisfy(\.isNumber) {
            t = String(t[..<colon])
        }
        let host = stripPrefixes(normalize(t))
        guard isUsableEntry(host), host.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") }),
              !host.hasPrefix("."), !host.contains("..") else { return nil }
        return host
    }

    /// `host` 가 목록의 어느 항목과 같거나 그 아래 도메인이면 true.
    /// 목록의 `coupang.com` 은 `coupang.com` · `www.coupang.com` · `m.coupang.com` 을 허락하고 `evilcoupang.com` 은 허락하지 않는다.
    /// 대소문자 · 끝 점은 무시하고, 빈 호스트 · `/ ? # @ :` 나 공백이 든 호스트는 언제나 false.
    /// 점 없는 낱말(`com`)과 흔한 공개 접미사(`co.kr` 등)인 목록 항목은 허락에 쓰지 않는다(`*.co.kr` 전부가 열리지 않게).
    public static func allows(host: String, list: [String]) -> Bool {
        let h = normalize(host)
        guard !h.isEmpty, h.rangeOfCharacter(from: forbiddenHostCharacters) == nil else { return false }
        for entry in list {
            let e = normalize(entry)
            guard isUsableEntry(e) else { continue }
            if h == e || h.hasSuffix("." + e) { return true }
        }
        return false
    }

    /// 목록 항목으로 쓸 수 있는지 — 비어 있거나 · 점 없는 한 낱말이거나 · 흔한 공개 접미사면 false. (`normalize` 를 거친 값을 받는다)
    static func isUsableEntry(_ entry: String) -> Bool {
        !entry.isEmpty && entry.contains(".") && !publicSuffixes.contains(entry)
    }

    private static let forbiddenHostCharacters = CharacterSet(charactersIn: "/?#@:").union(.whitespacesAndNewlines)

    /// 한 사이트 전체가 아니라 나라별 묶음을 통째로 여는 흔한 두 낱말 공개 접미사(짧은 목록 — 완전한 공개 접미사 목록은 아니다).
    private static let publicSuffixes: Set<String> = [
        "co.kr", "or.kr", "go.kr", "ne.kr", "re.kr", "pe.kr", "ac.kr", "co.uk", "org.uk", "ac.uk", "com.au", "net.au",
        "co.jp", "ne.jp", "or.jp", "com.cn", "com.tw", "com.hk", "com.sg", "co.nz", "com.br",
    ]

    /// 소문자 · 앞뒤 공백 · 끝 점 떼기(목록 저장 때도 같은 모양으로 맞춘다).
    static func normalize(_ host: String) -> String {
        var h = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while h.hasSuffix(".") { h.removeLast() }
        return h
    }

    private static func stripPrefixes(_ host: String) -> String {
        var h = host
        while true {
            if h.hasPrefix("www."), h.dropFirst(4).contains(".") { h.removeFirst(4) }
            else if h.hasPrefix("m."), h.dropFirst(2).contains(".") { h.removeFirst(2) }
            else { return h }
        }
    }

    /// 글 속 파일 이름(`report.txt`)을 도메인으로 잘못 뽑지 않게 하는 흔한 확장자.
    private static let fileExtensions: Set<String> = [
        "txt", "pdf", "png", "jpg", "jpeg", "gif", "webp", "svg", "md", "json", "csv", "xlsx", "xls", "docx", "doc",
        "pptx", "zip", "mp4", "mp3", "mov", "swift", "js", "ts", "py", "sh", "log", "yml", "yaml", "plist",
        "html", "htm", "css", "php", "rs", "kt", "java", "toml", "rtf", "xml", "cpp",
    ]

    // 주소(스킴 · 호스트 · 포트 · 길 전부) 한 덩어리로 먹어서 길 안의 도메인을 또 뽑지 않는다. 캡처 1 = 호스트.
    // 앞에 영문 · 숫자 · @ · . · _ · - 가 붙어 있으면(이메일 · 긴 낱말 한가운데) 뽑지 않는다.
    // `https://coupang.com@evil.com/` 처럼 스킴 뒤에 사용자 정보(`…@`)가 있으면 그것을 건너뛰고 실제 호스트(`evil.com`)를 뽑는다.
    // 스킴 없이 `coupang.com@evil.com` 이면 둘 다 뽑지 않는다(호스트 뒤에 @ 가 오면 안 뽑음).
    private static let hostPattern: NSRegularExpression = {
        let label = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
        let pattern = "(?<![A-Za-z0-9@._-])(?:https?://(?:[^\\s/?#@]*@)?)?((?:\(label)\\.)+[a-z]{2,24})(?![A-Za-z0-9@-])(?::\\d{1,5})?(?:[/?#]\\S*)?"
        return try! NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
    }()
}
