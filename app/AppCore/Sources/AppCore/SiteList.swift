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
            guard let tld = host.split(separator: ".").last, !fileExtensions.contains(String(tld)) else { continue }
            if seen.insert(host).inserted { out.append(host) }
        }
        return out
    }

    /// `host` 가 목록의 어느 항목과 같거나 그 아래 도메인이면 true.
    /// 목록의 `coupang.com` 은 `coupang.com` · `www.coupang.com` · `m.coupang.com` 을 허락하고 `evilcoupang.com` 은 허락하지 않는다.
    /// 대소문자 · 끝 점은 무시하고, 빈 호스트는 언제나 false.
    public static func allows(host: String, list: [String]) -> Bool {
        let h = normalize(host)
        guard !h.isEmpty else { return false }
        for entry in list {
            let e = normalize(entry)
            if e.isEmpty { continue }
            if h == e || h.hasSuffix("." + e) { return true }
        }
        return false
    }

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
    ]

    // 주소(스킴 · 호스트 · 포트 · 길 전부) 한 덩어리로 먹어서 길 안의 도메인을 또 뽑지 않는다. 캡처 1 = 호스트.
    // 앞에 영문 · 숫자 · @ · . · _ · - 가 붙어 있으면(이메일 · 긴 낱말 한가운데) 뽑지 않는다.
    private static let hostPattern: NSRegularExpression = {
        let label = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
        let pattern = "(?<![A-Za-z0-9@._-])(?:https?://)?((?:\(label)\\.)+[a-z]{2,24})(?![A-Za-z0-9-])(?::\\d{1,5})?(?:[/?#]\\S*)?"
        return try! NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
    }()
}
