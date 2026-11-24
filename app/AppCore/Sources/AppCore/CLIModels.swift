import Foundation

/// 고를 수 있는 모델 하나.
public struct ModelChoice: Equatable, Sendable, Identifiable {
    public var id: String
    public var label: String
    public init(id: String, label: String) { self.id = id; self.label = label }
}

public enum CLIModels {
    /// 클로드 — 고정 목록(명령으로 목록을 얻을 수 없다). 첫 것이 기본.
    public static let claudeChoices: [ModelChoice] = [
        ModelChoice(id: "sonnet", label: "Sonnet"),
        ModelChoice(id: "opus", label: "Opus"),
        ModelChoice(id: "haiku", label: "Haiku"),
        ModelChoice(id: "fable", label: "Fable"),
    ]

    public static let codexLoadFailureNote = "설정에서 로그인 뒤 다시 불러와요"

    /// 모델 id 로 명령줄에 넣어도 되는 글자만(옵션으로 읽히거나 이상한 글자가 끼지 않게). 설정 파일을 손으로 고친 경우 대비.
    public static func isSafeID(_ id: String) -> Bool {
        guard !id.isEmpty, id.count <= 80, !id.hasPrefix("-") else { return false }
        return id.unicodeScalars.allSatisfy { s in
            (s.value >= 0x30 && s.value <= 0x39) || (s.value >= 0x41 && s.value <= 0x5A)
                || (s.value >= 0x61 && s.value <= 0x7A) || s == "." || s == "_" || s == "-" || s == ":" || s == "[" || s == "]"
        }
    }

    /// `codex debug models` 의 JSON — 맨 위가 배열이거나 배열 하나를 감싼 객체. `visibility == "list"` 만, 순서는 그대로.
    /// 앞뒤에 JSON 이 아닌 글이 붙어 있어도 첫 `[`·`{` 부터 읽는다. 못 읽으면 빈 목록.
    public static func parseCodexModels(_ output: String) -> [ModelChoice] {
        guard let start = output.firstIndex(where: { $0 == "[" || $0 == "{" }),
              let data = String(output[start...]).data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return [] }
        var items: [[String: Any]] = []
        if let arr = obj as? [[String: Any]] {
            items = arr
        } else if let dict = obj as? [String: Any] {
            if let arr = dict["models"] as? [[String: Any]] { items = arr }
            else if let arr = dict.values.compactMap({ $0 as? [[String: Any]] }).first { items = arr }
        }
        var seen = Set<String>()
        var out: [ModelChoice] = []
        for item in items {
            guard (item["visibility"] as? String) == "list",
                  let slug = item["slug"] as? String, isSafeID(slug), seen.insert(slug).inserted else { continue }
            let name = (item["display_name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            out.append(ModelChoice(id: slug, label: name.isEmpty ? slug : name))
        }
        return out
    }

    /// 저장해 둔 모델이 지금 목록에 있으면 그것, 아니면 목록의 첫 것(기본). 목록이 비면 nil.
    public static func resolve(selected: String?, in choices: [ModelChoice]) -> String? {
        if let s = selected, choices.contains(where: { $0.id == s }) { return s }
        return choices.first?.id
    }
}
