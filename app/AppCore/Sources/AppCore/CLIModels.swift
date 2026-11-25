import Foundation

/// 고를 수 있는 모델 하나.
public struct ModelChoice: Equatable, Sendable, Identifiable {
    public var id: String
    public var label: String
    public init(id: String, label: String) { self.id = id; self.label = label }
}

/// 제미나이(agy) 모델 묶음 — 모델 이름과 받는 생각 단계 목록.
public struct AgyFamily: Equatable, Sendable {
    public let base: String
    public let levels: [String]
    public init(base: String, levels: [String]) {
        self.base = base
        self.levels = levels
    }
}

public enum CLIModels {
    /// 클로드 — 고정 목록(명령으로 목록을 얻을 수 없다). 첫 것이 기본.
    public static let claudeChoices: [ModelChoice] = [
        ModelChoice(id: "sonnet", label: "Sonnet"),
        ModelChoice(id: "opus", label: "Opus"),
        ModelChoice(id: "haiku", label: "Haiku"),
        ModelChoice(id: "fable", label: "Fable"),
    ]

    public static let codexLoadFailureNote = "모델 목록을 못 불러왔어요 — 로그인했는지, codex 가 최신인지 확인해 주세요(지금은 기본 모델로 물어요)"
    public static let agyLoadFailureNote = "모델 목록을 못 불러왔어요 — 로그인했는지 확인해 주세요(지금은 기본 모델로 물어요)"
    public static let opencodeLoadFailureNote = "모델 목록을 못 불러왔어요 — 로그인했는지 확인하고 새로 고침을 눌러 주세요(지금은 opencode 기본 모델로 물어요)"

    /// 모델 목록을 못 불렀을 때 CLI 마다 보일 한 줄.
    public static func loadFailureNote(for kind: ModelKind) -> String {
        switch kind {
        case .chatgpt: return codexLoadFailureNote
        case .gemini: return agyLoadFailureNote
        case .opencode: return opencodeLoadFailureNote
        case .claude: return ""
        }
    }

    /// 모델 id 로 명령줄에 넣어도 되는 글자만(옵션으로 읽히거나 이상한 글자가 끼지 않게). 설정 파일을 손으로 고친 경우 대비.
    public static func isSafeID(_ id: String) -> Bool {
        guard !id.isEmpty, id.count <= 80, !id.hasPrefix("-") else { return false }
        return id.unicodeScalars.allSatisfy { s in
            (s.value >= 0x30 && s.value <= 0x39) || (s.value >= 0x41 && s.value <= 0x5A)
                || (s.value >= 0x61 && s.value <= 0x7A) || s == "." || s == "_" || s == "-" || s == ":" || s == "[" || s == "]"
        }
    }

    /// opencode 모델 id(`공급자/모델` · `공급자/모델#변형`) — `isSafeID` 의 글자에 `/` · `#` 를 더한다. `-` 나 `/` 로 시작하면 안 된다.
    public static func isSafeProviderModelID(_ id: String) -> Bool {
        guard !id.isEmpty, id.count <= 120, !id.hasPrefix("-"), !id.hasPrefix("/"), id.contains("/") else { return false }
        return id.unicodeScalars.allSatisfy { s in
            (s.value >= 0x30 && s.value <= 0x39) || (s.value >= 0x41 && s.value <= 0x5A)
                || (s.value >= 0x61 && s.value <= 0x7A) || s == "." || s == "_" || s == "-" || s == ":" || s == "/" || s == "#"
        }
    }

    /// `agy models` — 한 줄에 `id<TAB>이름`(탭이 없으면 공백으로 가른다). id 는 안전한 글자 · 하이픈이 든 것만(머리글 · 안내 줄은 버림).
    /// 로그인 안내 글이 섞여 있으면 빈 목록.
    public static func parseAgyModels(_ output: String) -> [ModelChoice] {
        if LoginDetector.looksLikeLoginNeeded(output) { return [] }
        var seen = Set<String>()
        var out: [ModelChoice] = []
        for raw in output.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty else { continue }
            var id: String, name: String
            if let tab = line.firstIndex(of: "\t") {
                id = String(line[line.startIndex..<tab]).trimmingCharacters(in: .whitespaces)
                name = String(line[line.index(after: tab)...]).trimmingCharacters(in: .whitespaces)
            } else {
                let parts = line.split(maxSplits: 1, whereSeparator: { $0 == " " })
                id = parts.first.map(String.init) ?? ""
                name = parts.count > 1 ? String(parts[1]).trimmingCharacters(in: .whitespaces) : ""
            }
            guard isSafeID(id), id.contains("-"), !id.hasSuffix(":"), seen.insert(id).inserted else { continue }
            out.append(ModelChoice(id: id, label: name.isEmpty ? id : name))
        }
        return out
    }

    /// `opencode models` — 한 줄에 `공급자/모델`. 안전한 id 가 아닌 줄(안내 · 장식)은 버린다.
    public static func parseOpenCodeModels(_ output: String) -> [ModelChoice] {
        var seen = Set<String>()
        var out: [ModelChoice] = []
        for raw in output.split(whereSeparator: \.isNewline) {
            let id = raw.trimmingCharacters(in: .whitespaces)
            guard isSafeProviderModelID(id), seen.insert(id).inserted else { continue }
            out.append(ModelChoice(id: id, label: id))
        }
        return out
    }

    /// CLI 마다 기본 모델 — 클로드 첫 것(sonnet) · codex 첫 것 · agy `gemini-3.8-flash-medium`(없으면 첫 것) · opencode `-free` 로 끝나는 첫 것(없으면 첫 것).
    public static func defaultID(for kind: ModelKind, in choices: [ModelChoice]) -> String? {
        switch kind {
        case .claude, .chatgpt: return choices.first?.id
        case .gemini: return choices.first(where: { $0.id == CommandBuilder.geminiModel })?.id ?? choices.first?.id
        case .opencode: return choices.first(where: { $0.id.hasSuffix("-free") })?.id ?? choices.first?.id
        }
    }

    /// 저장해 둔 모델이 목록에 있으면 그것, 아니면 그 CLI 의 기본. 목록이 비면 nil.
    public static func resolve(kind: ModelKind, selected: String?, in choices: [ModelChoice]) -> String? {
        if let s = selected, choices.contains(where: { $0.id == s }) { return s }
        return defaultID(for: kind, in: choices)
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

    private static let agyLevelSuffixes = ["low", "medium", "high", "xhigh"]

    /// `gemini-4-neon-xhigh` → `("gemini-4-neon", "xhigh")`, 접미사가 없으면 `(id, nil)`.
    public static func agySplit(_ id: String) -> (base: String, level: String?) {
        for suffix in agyLevelSuffixes {
            let tail = "-" + suffix
            if id.hasSuffix(tail), id.count > tail.count {
                return (String(id.dropLast(tail.count)), suffix)
            }
        }
        return (id, nil)
    }

    /// `agy models` id 목록을 접미사 `-(low|medium|high|xhigh)$` 로 묶는다. 순서는 처음 나온 순서.
    public static func agyFamilies(_ ids: [String]) -> [AgyFamily] {
        var order: [String] = []
        var levelsByBase: [String: [String]] = [:]
        for id in ids {
            let (base, level) = agySplit(id)
            if levelsByBase[base] == nil {
                order.append(base)
                levelsByBase[base] = []
            }
            if let level, !(levelsByBase[base]?.contains(level) ?? false) {
                levelsByBase[base]?.append(level)
            }
        }
        return order.map { AgyFamily(base: $0, levels: levelsByBase[$0] ?? []) }
    }

    /// 고른 단계가 있으면 `base-level`, nil 이면 `medium` 우선 없으면 첫 단계, 단계 없는 모델은 `base`.
    public static func agyModelID(family: AgyFamily, level: String?) -> String {
        guard !family.levels.isEmpty else { return family.base }
        if let level, family.levels.contains(level) {
            return "\(family.base)-\(level)"
        }
        let picked = family.levels.contains("medium") ? "medium" : family.levels[0]
        return "\(family.base)-\(picked)"
    }

    /// `<codex-home>/models_cache.json` 에서 모델 `slug` 별 `supported_reasoning_levels[].effort` 목록을 읽는다.
    public static func parseCodexEfforts(_ data: Data) -> [String: [String]] {
        guard let obj = try? JSONSerialization.jsonObject(with: data) else { return [:] }
        var items: [[String: Any]] = []
        if let dict = obj as? [String: Any], let arr = dict["models"] as? [[String: Any]] {
            items = arr
        } else if let arr = obj as? [[String: Any]] {
            items = arr
        }
        var result: [String: [String]] = [:]
        for item in items {
            guard let slug = item["slug"] as? String, isSafeID(slug),
                  let rawLevels = item["supported_reasoning_levels"] as? [[String: Any]] else { continue }
            var efforts: [String] = []
            for entry in rawLevels {
                if let e = entry["effort"] as? String, !e.isEmpty, isSafeID(e), !efforts.contains(e) {
                    efforts.append(e)
                }
            }
            if !efforts.isEmpty { result[slug] = efforts }
        }
        return result
    }

    /// CLI · 모델에 맞는 생각 단계 목록.
    public static func effortChoices(kind: ModelKind, modelID: String,
                                     codexEfforts: [String: [String]],
                                     agyFamilies: [AgyFamily]) -> [String] {
        switch kind {
        case .claude:
            return Effort.claudeLevels
        case .chatgpt:
            if let list = codexEfforts[modelID], !list.isEmpty { return list }
            return ["low", "medium", "high"]
        case .gemini:
            let base = agySplit(modelID).base
            return agyFamilies.first(where: { $0.base == base })?.levels ?? []
        case .opencode:
            return Effort.opencodeLevels
        }
    }
}
