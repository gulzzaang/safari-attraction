import Foundation

public enum MarkdownBlock: Equatable, Sendable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case listItem(marker: String, text: String)
    case code(language: String?, text: String)
}

/// 답 글을 화면에 그릴 덩어리로 나눈다. 새 패키지 없이 쓰려고 블록은 직접 나누고(문단 · 제목 · 목록 · 코드 상자),
/// 줄 안 서식(굵게 · 기울임 · 코드 · 링크)만 `AttributedString(markdown:)` 에 맡긴다.
/// 흘러나오는 도중의 반쪽 글(닫히지 않은 ``` 등)도 깨지지 않게 읽는다.
public enum MarkdownBlocks {
    public static func parse(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var para: [String] = []
        var code: (lang: String?, lines: [String])?

        func flushPara() {
            if !para.isEmpty { blocks.append(.paragraph(para.joined(separator: "\n"))); para = [] }
        }

        for raw in text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            if code != nil {
                if trimmed.hasPrefix("```") {
                    blocks.append(.code(language: code!.lang, text: code!.lines.joined(separator: "\n")))
                    code = nil
                } else {
                    code!.lines.append(raw)
                }
                continue
            }
            if trimmed.hasPrefix("```") {
                flushPara()
                let lang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                code = (lang.isEmpty ? nil : lang, [])
                continue
            }
            if trimmed.isEmpty { flushPara(); continue }
            if let (level, rest) = heading(trimmed) {
                flushPara(); blocks.append(.heading(level: level, text: rest)); continue
            }
            if let (marker, rest) = listItem(trimmed) {
                flushPara(); blocks.append(.listItem(marker: marker, text: rest)); continue
            }
            para.append(raw)
        }
        if let c = code { blocks.append(.code(language: c.lang, text: c.lines.joined(separator: "\n"))) }
        flushPara()
        return blocks
    }

    private static func heading(_ s: String) -> (Int, String)? {
        var n = 0
        for ch in s { if ch == "#" { n += 1 } else { break } }
        guard (1...6).contains(n), s.dropFirst(n).first == " " else { return nil }
        return (n, String(s.dropFirst(n + 1)).trimmingCharacters(in: .whitespaces))
    }

    private static func listItem(_ s: String) -> (String, String)? {
        if let f = s.first, "-*+".contains(f), s.dropFirst().first == " " {
            return ("•", String(s.dropFirst(2)).trimmingCharacters(in: .whitespaces))
        }
        let digits = s.prefix { $0.isNumber && $0.isASCII }
        guard !digits.isEmpty, digits.count <= 3 else { return nil }
        let rest = s.dropFirst(digits.count)
        guard let p = rest.first, p == "." || p == ")", rest.dropFirst().first == " " else { return nil }
        return ("\(digits).", String(rest.dropFirst(2)).trimmingCharacters(in: .whitespaces))
    }

    /// 줄 안 서식을 입힌다. 파싱이 안 되면 그냥 글로. 마크다운 링크가 아닌 맨 주소도 링크로 만든다.
    public static func attributed(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible)
        var a = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        linkBareURLs(in: &a)
        return a
    }

    /// `attributed` 와 같되 누를 수 있는 링크는 만들지 않는다 — 링크는 글자만 보이고 주소는 괄호로 덧붙인다
    /// (계획 카드처럼 클로드가 쓴 글을 사람이 허락하기 전에 읽는 자리용: 눌러서 열리지 않게).
    public static func attributedWithoutLinks(_ text: String) -> AttributedString {
        let a = attributed(text)
        var out = AttributedString()
        for run in a.runs {
            var piece = AttributedString(a[run.range])
            guard let url = run.link else { out += piece; continue }
            piece.link = nil
            out += piece
            let shown = String(a[run.range].characters)
            if !url.absoluteString.contains(shown) { out += AttributedString(" (\(url.absoluteString))") }
        }
        return out
    }

    private static func linkBareURLs(in a: inout AttributedString) {
        let plain = String(a.characters)
        guard plain.contains("://") || plain.contains("@"), let detector = linkDetector else { return }
        let ns = plain as NSString
        for m in detector.matches(in: plain, range: NSRange(location: 0, length: ns.length)) {
            guard let url = m.url, let r = Range(m.range, in: plain) else { continue }
            let start = plain.distance(from: plain.startIndex, to: r.lowerBound)
            let len = plain.distance(from: r.lowerBound, to: r.upperBound)
            let chars = a.characters
            guard let lo = chars.index(chars.startIndex, offsetBy: start, limitedBy: chars.endIndex),
                  let hi = chars.index(lo, offsetBy: len, limitedBy: chars.endIndex) else { continue }
            if a[lo..<hi].runs.contains(where: { $0.link != nil }) { continue }
            a[lo..<hi].link = url
        }
    }

    private static let linkDetector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    /// 답 안의 링크를 열어도 되는가 — 웹 주소와 메일만(`file:` · 시스템 설정 같은 것은 막는다).
    public static func isOpenable(_ url: URL) -> Bool {
        guard let s = url.scheme?.lowercased() else { return false }
        return s == "https" || s == "http" || s == "mailto"
    }
}
