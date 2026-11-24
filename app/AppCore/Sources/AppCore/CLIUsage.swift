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
    public init(name: String, usedFraction: Double?, resetsAt: Date? = nil, resetsText: String? = nil) {
        self.name = name; self.usedFraction = usedFraction; self.resetsAt = resetsAt; self.resetsText = resetsText
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
