import Foundation

/// 남은 양 한 줄 — 이름 · 사용 비율(0~1) · 초기화 시각.
public struct UsageWindow: Equatable, Sendable {
    public var name: String
    /// 0~1. 못 읽었으면 nil.
    public var usedFraction: Double?
    /// 초기화 시각(codex — 시각을 알 때).
    public var resetsAt: Date?
    /// 초기화 시각을 글로 받은 것(클로드 `/usage` 의 「Nov 24 at 6:30pm (Asia/Seoul)」).
    public var resetsText: String?
    /// 같은 CLI 안의 묶음(agy 「제미나이」 · 「클로드 · GPT」) — 옆 창 한 줄이 고른 모델의 묶음만 보이게.
    public var group: String?
    /// 초기화 시각이 1970-01-01 로 온 것 — 그 창이 아직 시작 안 됨(agy).
    public var notStarted: Bool
    public init(name: String, usedFraction: Double?, resetsAt: Date? = nil, resetsText: String? = nil,
                group: String? = nil, notStarted: Bool = false) {
        self.name = name; self.usedFraction = usedFraction; self.resetsAt = resetsAt; self.resetsText = resetsText
        self.group = group; self.notStarted = notStarted
    }
}

public struct UsageSnapshot: Equatable, Sendable {
    public var windows: [UsageWindow]
    /// codex `planType` 등.
    public var plan: String?
    /// 줄로 못 읽었을 때 받은 글 그대로(최대 세 줄).
    public var rawLines: [String]
    public init(windows: [UsageWindow] = [], plan: String? = nil, rawLines: [String] = []) {
        self.windows = windows; self.plan = plan; self.rawLines = rawLines
    }
    public var isEmpty: Bool { windows.isEmpty && rawLines.isEmpty }
}

public enum UsageFormat {
    /// 「23% 사용」 — 비율을 모르면 「알 수 없음」.
    public static func percentText(_ w: UsageWindow) -> String {
        guard let f = w.usedFraction else { return "알 수 없음" }
        return "\(Int((f * 100).rounded()))% 사용"
    }

    /// 「초기화 오늘 18:30」 · 「초기화 11월 25일 18:30」 · 글로 받은 건 그대로. 모르면 nil.
    public static func resetText(_ w: UsageWindow, now: Date = Date(), calendar: Calendar = .autoupdatingCurrent) -> String? {
        if w.notStarted { return "아직 시작 안 됨" }
        if let d = w.resetsAt {
            if d.timeIntervalSince(now) < 0 { return "이미 초기화됐어요" }
            var cal = calendar
            cal.locale = Locale(identifier: "ko_KR")
            let f = DateFormatter()
            f.calendar = cal; f.timeZone = cal.timeZone; f.locale = Locale(identifier: "ko_KR")
            f.dateFormat = cal.isDate(d, inSameDayAs: now) ? "'오늘' HH:mm" : "M월 d일 HH:mm"
            return "초기화 " + f.string(from: d)
        }
        if let t = w.resetsText, !t.isEmpty { return "초기화 " + t }
        return nil
    }

    /// 옆 창 입력 칸 아래 한 줄 — 「5시간 23% 사용 · 주간 48%」. 5시간 · 주간 창이 있으면 그 둘, 없으면 앞의 둘. `group` 이 있고 그 묶음의 창이 있으면 그것만.
    /// 사용 비율을 모르는 창은 뺀다. 보일 창이 없으면 nil(한 줄을 숨긴다).
    public static func oneLine(_ snap: UsageSnapshot, group: String? = nil) -> String? {
        var windows = snap.windows.filter { $0.usedFraction != nil }
        if let group, windows.contains(where: { $0.group == group }) { windows = windows.filter { $0.group == group } }
        guard !windows.isEmpty else { return nil }
        func label(_ w: UsageWindow) -> String {
            if let g = w.group, w.name.hasPrefix(g + " ") { return String(w.name.dropFirst(g.count + 1)) }
            switch w.name {
            case "현재 세션": return "5시간"
            case "이번 주 · 전체 모델": return "주간"
            default: return w.name
            }
        }
        let five = windows.first { label($0) == "5시간" }, week = windows.first { label($0) == "주간" }
        let picked: [UsageWindow] = (five != nil || week != nil) ? [five, week].compactMap { $0 } : Array(windows.prefix(2))
        let parts = picked.enumerated().map { i, w -> String in
            let pct = Int(((w.usedFraction ?? 0) * 100).rounded())
            return "\(label(w)) \(pct)%" + (i == 0 ? " 사용" : "")
        }
        return parts.joined(separator: " · ")
    }
}

/// 클로드 `/usage` 읽기 — `claude -p "/usage" --output-format json` 의 `result` 첫 세 줄.
public enum ClaudeUsageParser {
    /// 못 읽으면(JSON 아님 · 글 없음) nil. 「N% used」 줄이 하나도 없으면 글 그대로 세 줄(`rawLines`).
    public static func parse(jsonOutput: String) -> UsageSnapshot? {
        var text: String?
        if let start = jsonOutput.firstIndex(of: "{"), let data = String(jsonOutput[start...]).data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            text = obj["result"] as? String
            if (obj["is_error"] as? Bool) == true { return nil }
        }
        guard let text else { return nil }
        let lines = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !lines.isEmpty else { return nil }
        let head = Array(lines.prefix(3))
        let windows = head.compactMap(parseLine)
        if windows.isEmpty { return UsageSnapshot(rawLines: head) }
        return UsageSnapshot(windows: windows)
    }

    /// 답 도중의 `rate_limit_event` — `rate_limit_info.unifiedWindows.{five_hour, seven_day}.{utilization 0~1, resetsAt 초}`. 창이 없으면 nil.
    /// 이름은 `/usage` 와 같게(「현재 세션」 · 「이번 주 · 전체 모델」) 써서 설정 창의 줄과 합쳐진다.
    public static func parse(rateLimitEvent d: [String: Any]) -> UsageSnapshot? {
        guard let info = d["rate_limit_info"] as? [String: Any], let uw = info["unifiedWindows"] as? [String: Any] else { return nil }
        var windows: [UsageWindow] = []
        for (key, name) in [("five_hour", "현재 세션"), ("seven_day", "이번 주 · 전체 모델")] {
            guard let w = uw[key] as? [String: Any],
                  let u = (w["utilization"] as? Double) ?? (w["utilization"] as? Int).map(Double.init) else { continue }
            var at: Date?
            if let secs = (w["resetsAt"] as? Double) ?? (w["resetsAt"] as? Int).map(Double.init), secs > 0 { at = Date(timeIntervalSince1970: secs) }
            windows.append(UsageWindow(name: name, usedFraction: min(max(u, 0), 1), resetsAt: at))
        }
        return windows.isEmpty ? nil : UsageSnapshot(windows: windows)
    }

    /// 「Current session: 8% used · resets Nov 24 at 6:30pm (Asia/Seoul)」 · 「Current week (Fable): 47% used」
    static func parseLine(_ line: String) -> UsageWindow? {
        guard let re = try? NSRegularExpression(pattern: #"^(.+?):\s*(\d+(?:\.\d+)?)\s*%\s*used(?:\s*[·•|\-–—]\s*resets?\s+(.+))?$"#,
                                                options: [.caseInsensitive]) else { return nil }
        let ns = line as NSString
        guard let m = re.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { return nil }
        let name = ns.substring(with: m.range(at: 1))
        guard let pct = Double(ns.substring(with: m.range(at: 2))) else { return nil }
        var reset: String?
        if m.range(at: 3).location != NSNotFound { reset = ns.substring(with: m.range(at: 3)).trimmingCharacters(in: .whitespaces) }
        return UsageWindow(name: koreanName(name), usedFraction: min(max(pct / 100, 0), 1), resetsText: reset)
    }

    static func koreanName(_ s: String) -> String {
        let low = s.lowercased()
        if low == "current session" { return "현재 세션" }
        if low.hasPrefix("current week") {
            guard let open = s.firstIndex(of: "("), let close = s.lastIndex(of: ")"), open < close else { return "이번 주" }
            let inner = String(s[s.index(after: open)..<close])
            return inner.lowercased() == "all models" ? "이번 주 · 전체 모델" : "이번 주 · \(inner)"
        }
        return s
    }
}

/// codex 한도 읽기 — 앱서버 JSON-RPC `account/rateLimits/read` 의 결과.
public enum CodexUsageParser {
    /// `result` 객체(`{"rateLimits":{"primary":…,"secondary":…,"planType":…}}`) → 스냅샷. 창이 하나도 없으면 nil.
    public static func parse(result: [String: Any]) -> UsageSnapshot? {
        guard let limits = result["rateLimits"] as? [String: Any] else { return nil }
        var windows: [UsageWindow] = []
        for key in ["primary", "secondary"] {
            guard let w = limits[key] as? [String: Any] else { continue }
            let used = (w["usedPercent"] as? Double) ?? (w["usedPercent"] as? Int).map(Double.init)
            let mins = (w["windowDurationMins"] as? Int) ?? (w["windowDurationMins"] as? Double).map { Int($0) }
            var at: Date?
            if let secs = (w["resetsAt"] as? Double) ?? (w["resetsAt"] as? Int).map(Double.init), secs > 0 {
                at = Date(timeIntervalSince1970: secs)
            }
            windows.append(UsageWindow(name: windowName(mins, fallback: key == "primary" ? "기본 한도" : "보조 한도"),
                                       usedFraction: used.map { min(max($0 / 100, 0), 1) }, resetsAt: at))
        }
        guard !windows.isEmpty else { return nil }
        let plan = (limits["planType"] as? String).flatMap { CLIAccountParser.safePlan($0) }
        return UsageSnapshot(windows: windows, plan: plan)
    }

    static func windowName(_ mins: Int?, fallback: String) -> String {
        guard let m = mins, m > 0 else { return fallback }
        if m == 300 { return "5시간" }
        if m == 10_080 { return "주간" }
        if m % 1440 == 0 { return "\(m / 1440)일" }
        if m % 60 == 0 { return "\(m / 60)시간" }
        return "\(m)분"
    }
}

/// codex 앱서버(stdio JSON-RPC)에 한 번 물어 한도를 읽는 손님.
/// 순서: `initialize`(id 1) → 응답을 받으면 `initialized` 알림 + `account/rateLimits/read`(id 2) → 응답을 받으면 입력을 닫고 프로세스를 멈춘다.
/// 앱서버는 스스로 끝나지 않으므로 응답을 받은 뒤 `stop()` 으로 정리하고, 시간 상한(기본 20초) 안에 못 받으면 nil.
public struct CodexUsageClient: Sendable {
    public static let clientName = "safari-attraction"

    public static func initializeLine() -> String {
        #"{"method":"initialize","id":1,"params":{"clientInfo":{"name":"safari-attraction","title":"Safari Attraction","version":"0.1"}}}"#
    }
    public static let initializedLine = #"{"method":"initialized"}"#
    public static func rateLimitsLine() -> String { #"{"method":"account/rateLimits/read","id":2}"# }

    /// 한 줄이 `id` 에 대한 응답이면 그 `result`(없으면 빈 객체, 오류 응답이면 nil → `isError` 로 구분).
    static func response(line: String, id: Int) -> (result: [String: Any]?, isError: Bool)? {
        guard let data = line.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (obj["id"] as? Int) == id else { return nil }
        if obj["error"] != nil { return (nil, true) }
        return (obj["result"] as? [String: Any] ?? [:], false)
    }

    private final class State: @unchecked Sendable {
        private let lock = NSLock()
        private var buffer = ""
        private(set) var sentFollowUp = false
        private(set) var result: [String: Any]?
        private(set) var failed = false
        /// 줄을 모아 새로 완성된 줄들을 돌려준다.
        func append(_ d: Data) -> [String] {
            lock.withLock {
                buffer += String(decoding: d, as: UTF8.self)
                if buffer.count > 4_000_000 { buffer = "" }
                var lines: [String] = []
                while let nl = buffer.firstIndex(of: "\n") {
                    lines.append(String(buffer[buffer.startIndex..<nl]))
                    buffer = String(buffer[buffer.index(after: nl)...])
                }
                return lines
            }
        }
        func markFollowUp() -> Bool { lock.withLock { if sentFollowUp { return false }; sentFollowUp = true; return true } }
        func setResult(_ r: [String: Any]?, failed: Bool) { lock.withLock { result = r; self.failed = failed } }
        var snapshot: ([String: Any]?, Bool) { lock.withLock { (result, failed) } }
    }

    public init() {}

    /// 읽은 한도. 못 읽으면 nil(실행 못 함 · 시간 초과 · 응답 오류 · 모양 다름).
    public func fetch(runner: InteractiveRunning, path: String, workDir: URL,
                      timeout: TimeInterval = CLICommands.readTimeout) async -> UsageSnapshot? {
        let state = State()
        let cmd = CLICommands.codexAppServer
        _ = await runner.runInteractive(executable: cmd.executable, arguments: cmd.arguments, workDir: workDir, path: path,
                                        timeout: timeout, initialLines: [Self.initializeLine()]) { event in
            guard case .stdout(let d) = event else { return }
            for line in state.append(d) {
                if Self.response(line: line, id: 1) != nil, state.markFollowUp() {
                    try? runner.write(Self.initializedLine)
                    try? runner.write(Self.rateLimitsLine())
                } else if let r = Self.response(line: line, id: 2) {
                    state.setResult(r.result, failed: r.isError)
                    runner.closeInput()
                    runner.stop()   // 앱서버는 스스로 끝나지 않는다
                }
            }
        }
        let (result, failed) = state.snapshot
        guard !failed, let result else { return nil }
        return CodexUsageParser.parse(result: result)
    }
}


/// agy `/usage` 읽기 — `agy -p "/usage" --output-format stream-json` 첫 줄의 `command_result.command.data.groups[].buckets[]`.
/// `remaining_fraction`(남은 비율) → 사용 비율 = 1 − 남은 값. `reset_time` 이 `1970-01-01` 이면 「아직 시작 안 됨」.
public enum AgyUsageParser {
    public static let geminiGroup = "제미나이"
    public static let otherGroup = "클로드 · GPT"

    /// 고른 모델 id 가 어느 묶음인지(`gemini…` 면 제미나이, 그 밖은 클로드 · GPT). id 를 모르면 제미나이.
    public static func group(forModelID id: String?) -> String {
        guard let id, !id.isEmpty else { return geminiGroup }
        return id.hasPrefix("gemini") ? geminiGroup : otherGroup
    }

    static func groupName(_ raw: String) -> String {
        let low = raw.lowercased()
        if low.contains("gemini") { return geminiGroup }
        if low.contains("claude") || low.contains("gpt") { return otherGroup }
        return raw
    }

    static func windowName(_ raw: String) -> String {
        switch raw.lowercased() {
        case "5h": return "5시간"
        case "weekly", "7d": return "주간"
        case "daily", "1d": return "하루"
        case "monthly": return "월간"
        default: return raw
        }
    }

    private static func rank(_ raw: String) -> Int {
        switch raw.lowercased() { case "5h": return 0; case "weekly", "7d": return 1; default: return 2 }
    }

    static func parseDate(_ text: String) -> Date? {
        let a = ISO8601DateFormatter()
        if let d = a.date(from: text) { return d }
        let b = ISO8601DateFormatter()
        b.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return b.date(from: text)
    }

    /// 못 읽으면(모양이 다름 · 로그인 안내) nil.
    public static func parse(streamOutput: String) -> UsageSnapshot? {
        for raw in streamOutput.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("{"), let data = line.data(using: .utf8),
                  let d = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (d["event"] as? String) == "command_result",
                  let groups = ((d["command"] as? [String: Any])?["data"] as? [String: Any])?["groups"] as? [[String: Any]] else { continue }
            var windows: [UsageWindow] = []
            for g in groups {
                let group = groupName((g["name"] as? String) ?? "")
                let buckets = (g["buckets"] as? [[String: Any]] ?? []).enumerated()
                    .sorted { (a, b) in
                        let ra = rank((a.element["window"] as? String) ?? ""), rb = rank((b.element["window"] as? String) ?? "")
                        return ra != rb ? ra < rb : a.offset < b.offset
                    }.map(\.element)
                for b in buckets {
                    guard let remaining = (b["remaining_fraction"] as? Double) ?? (b["remaining_fraction"] as? Int).map(Double.init) else { continue }
                    let win = (b["window"] as? String) ?? (b["id"] as? String) ?? ""
                    var at: Date?, notStarted = false
                    if let t = b["reset_time"] as? String, let date = parseDate(t) {
                        if date.timeIntervalSince1970 <= 86_400 { notStarted = true } else { at = date }   // 1970-01-01 = 아직 시작 안 됨
                    }
                    windows.append(UsageWindow(name: "\(group) \(windowName(win))", usedFraction: min(max(1 - remaining, 0), 1),
                                               resetsAt: at, group: group, notStarted: notStarted))
                }
            }
            return windows.isEmpty ? nil : UsageSnapshot(windows: windows)
        }
        return nil
    }
}

/// opencode 는 구독 남은 양을 알려 주는 명령이 없다. `opencode stats --json --days 7` 의 이 맥에서 쓴 토큰 · 비용 합만 읽는다.
/// 모양을 모르므로 이름으로 느슨하게 찾고, 못 찾으면 nil(생략). 받은 글은 그대로 내보이지 않고 숫자만 고정 문구에 넣는다.
public enum OpenCodeStatsParser {
    public static let noteText = "구독 남은 양은 알 수 없어요 — 이 맥에서 쓴 양만"

    static func number(_ any: Any?) -> Double? {
        if let d = any as? Double { return d }
        if let i = any as? Int { return Double(i) }
        return nil
    }

    /// 깊이 우선(키 이름순)으로 처음 만나는 숫자.
    static func firstNumber(in any: Any, keys: Set<String>) -> Double? {
        if let dict = any as? [String: Any] {
            for k in dict.keys.sorted() {
                if keys.contains(k.lowercased()), let n = number(dict[k]) { return n }
            }
            for k in dict.keys.sorted() { if let n = firstNumber(in: dict[k] as Any, keys: keys) { return n } }
        } else if let arr = any as? [Any] {
            for e in arr { if let n = firstNumber(in: e, keys: keys) { return n } }
        }
        return nil
    }

    static func tokenTotal(_ root: Any) -> Double? {
        if let t = firstNumber(in: root, keys: ["totaltokens", "total_tokens"]) { return t }
        let parts = ["totalinputtokens", "totaloutputtokens", "totalreasoningtokens", "inputtokens", "outputtokens"]
        let sum = parts.compactMap { firstNumber(in: root, keys: [$0]) }
        if !sum.isEmpty { return sum.reduce(0, +) }
        if let tokens = firstTokensDict(in: root) {
            let cache = tokens["cache"] as? [String: Any]
            let vals = [tokens["input"], tokens["output"], tokens["reasoning"], cache?["read"], cache?["write"]].compactMap(number)
            if !vals.isEmpty { return vals.reduce(0, +) }
        }
        return nil
    }

    static func firstTokensDict(in any: Any) -> [String: Any]? {
        if let dict = any as? [String: Any] {
            if let t = dict["tokens"] as? [String: Any] { return t }
            for k in dict.keys.sorted() { if let t = firstTokensDict(in: dict[k] as Any) { return t } }
        } else if let arr = any as? [Any] {
            for e in arr { if let t = firstTokensDict(in: e) { return t } }
        }
        return nil
    }

    public static func parse(jsonOutput: String, days: Int = 7) -> UsageSnapshot? {
        guard let start = jsonOutput.firstIndex(where: { $0 == "{" || $0 == "[" }),
              let data = String(jsonOutput[start...]).data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) else { return nil }
        let tokens = tokenTotal(root)
        let cost = firstNumber(in: root, keys: ["totalcost", "total_cost"]) ?? firstNumber(in: root, keys: ["cost"])
        var parts: [String] = []
        if let t = tokens, t >= 0 {
            let f = NumberFormatter(); f.numberStyle = .decimal; f.locale = Locale(identifier: "en_US")
            parts.append("토큰 " + (f.string(from: NSNumber(value: Int(t))) ?? "\(Int(t))"))
        }
        if let c = cost, c >= 0 { parts.append("비용 $" + String(format: "%.2f", c)) }
        guard !parts.isEmpty else { return nil }
        return UsageSnapshot(rawLines: ["최근 \(days)일 이 맥에서 쓴 양 — " + parts.joined(separator: " · ")])
    }
}
