import Foundation

/// 한 번의 답에 쓴 양(토큰 수). 못 읽은 항목은 0.
public struct TokenUsage: Equatable, Sendable {
    public var input: Int
    public var cachedInput: Int
    public var output: Int
    public var reasoning: Int
    public init(input: Int = 0, cachedInput: Int = 0, output: Int = 0, reasoning: Int = 0) {
        self.input = input; self.cachedInput = cachedInput; self.output = output; self.reasoning = reasoning
    }
    /// 입력 + 출력(캐시에서 읽은 입력은 따로 보인다).
    public var total: Int { input + output }

    /// 「쓴 양 1,234 토큰 (입력 1,000 · 출력 234)」
    public var summary: String {
        func n(_ v: Int) -> String {
            let f = NumberFormatter(); f.numberStyle = .decimal; f.locale = Locale(identifier: "en_US")
            return f.string(from: NSNumber(value: v)) ?? "\(v)"
        }
        var s = "쓴 양 \(n(total)) 토큰 (입력 \(n(input)) · 출력 \(n(output))"
        if cachedInput > 0 { s += " · 캐시 \(n(cachedInput))" }
        return s + ")"
    }

    static func int(_ any: Any?) -> Int {
        if let i = any as? Int { return max(0, i) }
        if let d = any as? Double { return max(0, Int(d)) }
        return 0
    }
}

/// `codex exec --json` 의 줄 단위 JSON 을 읽는다.
/// 줄 모양: `thread.started` · `turn.started` · `item.completed{item:{type:"agent_message", text}}` · `turn.completed{usage}` ·
/// 오류(`error{message}` · `turn.failed{error:{message}}`). 모르는 줄 · 깨진 줄은 조용히 건너뛴다.
/// 도중의 `error` 줄(재연결 안내 등)은 바로 보이지 않고 쥐고 있다가, 답이 하나도 없이 끝날 때만 `finish()` 에서 내보낸다.
public struct CodexStreamParser: StreamParsing {
    private var buffer = Data()
    private var pendingError: String?
    private var sawAnswer = false
    private var sawFailure = false
    static let maxBufferedBytes = 8_000_000
    static let errorLimit = 300

    public init() {}

    public mutating func feed(_ chunk: Data) -> [StreamEvent] {
        buffer.append(chunk)
        var events: [StreamEvent] = []
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = Data(buffer[buffer.startIndex..<nl])
            buffer = Data(buffer[buffer.index(after: nl)...])
            events += parse(line: line)
        }
        if buffer.count > Self.maxBufferedBytes { buffer = Data() }
        return events
    }

    public mutating func finish() -> [StreamEvent] {
        let rest = buffer
        buffer = Data()
        var events = parse(line: rest)
        if !sawAnswer, !sawFailure, let e = pendingError {
            events.append(.error(Self.userError(e)))
            pendingError = nil
        }
        return events
    }

    private mutating func parse(line raw: Data) -> [StreamEvent] {
        var line = raw
        if line.last == 0x0D { line.removeLast() }
        guard !line.isEmpty else { return [] }
        guard let obj = try? JSONSerialization.jsonObject(with: line), let d = obj as? [String: Any] else {
            if let s = String(data: line, encoding: .utf8), LoginDetector.looksLikeLoginNeeded(s) {
                sawFailure = true
                return [.error(ModelKind.chatgpt.loginNeededMessage)]
            }
            return []
        }
        switch d["type"] as? String {
        case "item.completed":
            guard let item = d["item"] as? [String: Any], (item["type"] as? String) == "agent_message",
                  let text = item["text"] as? String, !text.isEmpty else { return [] }
            sawAnswer = true
            return [.text(text)]
        case "turn.completed":
            guard let u = d["usage"] as? [String: Any] else { return [] }
            return [.usage(TokenUsage(input: TokenUsage.int(u["input_tokens"]), cachedInput: TokenUsage.int(u["cached_input_tokens"]),
                                      output: TokenUsage.int(u["output_tokens"]), reasoning: TokenUsage.int(u["reasoning_output_tokens"])))]
        case "turn.failed":
            sawFailure = true
            return [.error(Self.userError(Self.message(in: d) ?? "답을 받지 못했어요"))]
        case "error":
            if let m = Self.message(in: d), !m.lowercased().hasPrefix("reconnecting") { pendingError = m }
            return []
        default:
            return []
        }
    }

    /// `message` 또는 `error.message`.
    static func message(in d: [String: Any]) -> String? {
        if let m = d["message"] as? String, !m.isEmpty { return m }
        if let e = d["error"] as? [String: Any], let m = e["message"] as? String, !m.isEmpty { return m }
        if let m = d["error"] as? String, !m.isEmpty { return m }
        return nil
    }

    /// 로그인 문제로 보이면 안내 한 줄, 아니면 받은 글을 짧게.
    static func userError(_ message: String) -> String {
        if LoginDetector.looksLikeLoginNeeded(message) { return ModelKind.chatgpt.loginNeededMessage }
        let t = message.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.count > errorLimit ? String(t.prefix(errorLimit)) + "…" : t
    }
}

/// 줄바꿈으로 끊어 한 줄씩 넘겨 주는 작은 도우미(agy · opencode 파서가 같이 쓴다).
struct LineSplitter {
    private var buffer = Data()
    static let maxBufferedBytes = 8_000_000

    /// 새로 끝난 줄들(`\r` 는 뗀다).
    mutating func feed(_ chunk: Data) -> [Data] {
        buffer.append(chunk)
        var lines: [Data] = []
        while let nl = buffer.firstIndex(of: 0x0A) {
            var line = Data(buffer[buffer.startIndex..<nl])
            buffer = Data(buffer[buffer.index(after: nl)...])
            if line.last == 0x0D { line.removeLast() }
            lines.append(line)
        }
        if buffer.count > Self.maxBufferedBytes { buffer = Data() }
        return lines
    }

    /// 줄바꿈 없이 끝난 마지막 조각.
    mutating func rest() -> Data? {
        var line = buffer
        buffer = Data()
        if line.last == 0x0D { line.removeLast() }
        return line.isEmpty ? nil : line
    }
}

/// `agy -p … --output-format stream-json` 의 줄 단위 JSON 을 읽는다.
/// 줄 모양: `init` · `step_update{step_update:{step_index, step_type:"agent_response", text_delta, usage?}}` ·
/// `result{result:{status, response, usage}}`. 글 조각(`text_delta`)이 있으면 그것을 이어 붙이고, 없을 때만 `result.response` 를 쓴다.
/// 모르는 줄은 건너뛰고, JSON 이 아닌 줄(`{` 로 시작하지 않는 것)은 받은 글 그대로 낸다 — 로그인 안내 판정은 끝에서 `ModelOutputReader` 가 한다.
public struct AgyStreamParser: StreamParsing {
    private var lines = LineSplitter()
    private var sawDelta = false
    private var lastStepIndex: Int?
    private var lastStepUsage: TokenUsage?
    private var sawResultUsage = false
    private var sawFailure = false
    static let errorLimit = 300

    public init() {}

    public mutating func feed(_ chunk: Data) -> [StreamEvent] {
        var events: [StreamEvent] = []
        for line in lines.feed(chunk) { events += parse(line: line, terminated: true) }
        return events
    }

    public mutating func finish() -> [StreamEvent] {
        var events: [StreamEvent] = []
        if let rest = lines.rest() { events += parse(line: rest, terminated: false) }
        if !sawResultUsage, let u = lastStepUsage { events.append(.usage(u)); lastStepUsage = nil }
        return events
    }

    private mutating func parse(line: Data, terminated: Bool) -> [StreamEvent] {
        guard !line.isEmpty else { return [] }
        guard let obj = try? JSONSerialization.jsonObject(with: line), let d = obj as? [String: Any] else {
            guard let s = String(data: line, encoding: .utf8), !s.hasPrefix("{") else { return [] }   // 깨진 JSON 줄은 건너뜀
            return [.text(terminated ? s + "\n" : s)]
        }
        switch d["event"] as? String {
        case "step_update":
            guard let su = d["step_update"] as? [String: Any] else { return [] }
            var events: [StreamEvent] = []
            if (su["step_type"] as? String) == "agent_response", let t = su["text_delta"] as? String, !t.isEmpty {
                let idx = su["step_index"] as? Int
                if sawDelta, let idx, let last = lastStepIndex, idx != last { events.append(.text("\n\n")) }   // 새 단계(도구를 쓴 뒤 이어지는 답)
                if let idx { lastStepIndex = idx }
                sawDelta = true
                events.append(.text(t))
            }
            if let u = su["usage"] as? [String: Any] { lastStepUsage = Self.usage(u) }
            return events
        case "result":
            guard let r = d["result"] as? [String: Any] else { return [] }
            var events: [StreamEvent] = []
            let status = r["status"] as? String
            let response = (r["response"] as? String) ?? ""
            if let status, status.uppercased() != "SUCCESS" {
                sawFailure = true
                let msg = Self.message(in: r) ?? (response.isEmpty ? "제미나이가 답을 끝내지 못했어요" : response)
                events.append(.error(Self.userError(msg)))
            } else if !sawDelta, !response.isEmpty {
                sawDelta = true
                events.append(.text(response))
            }
            if let u = r["usage"] as? [String: Any] { sawResultUsage = true; events.append(.usage(Self.usage(u))) }
            return events
        case "error":
            sawFailure = true
            return [.error(Self.userError(Self.message(in: d) ?? "제미나이가 오류를 냈어요"))]
        default:
            return []
        }
    }

    static func usage(_ u: [String: Any]) -> TokenUsage {
        TokenUsage(input: TokenUsage.int(u["input_tokens"]), cachedInput: TokenUsage.int(u["cached_input_tokens"] ?? u["cache_read_input_tokens"]),
                   output: TokenUsage.int(u["output_tokens"]), reasoning: TokenUsage.int(u["reasoning_tokens"] ?? u["thinking_tokens"]))
    }

    static func message(in d: [String: Any]) -> String? {
        for key in ["error", "message", "error_message"] {
            if let m = d[key] as? String, !m.isEmpty { return m }
            if let e = d[key] as? [String: Any], let m = e["message"] as? String, !m.isEmpty { return m }
        }
        return nil
    }

    static func userError(_ message: String) -> String {
        if LoginDetector.looksLikeLoginNeeded(message) { return ModelKind.gemini.loginNeededMessage }
        let t = message.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.count > errorLimit ? String(t.prefix(errorLimit)) + "…" : t
    }
}

/// `opencode run … --format json` 의 줄 단위 JSON 을 읽는다.
/// 줄 모양: `step_start` · `text{part:{text}}` · `step_finish{part:{tokens:{input, output, reasoning, cache:{read, write}}, cost}}` · `error`.
/// 단계(`step_finish`)가 여러 번이면 쓴 양은 합쳐서 끝에 한 번 낸다. 모르는 줄 · 깨진 줄은 조용히 건너뛴다.
public struct OpenCodeStreamParser: StreamParsing {
    private var lines = LineSplitter()
    private var tokens = TokenUsage()
    private var sawTokens = false
    static let errorLimit = 300

    public init() {}

    public mutating func feed(_ chunk: Data) -> [StreamEvent] {
        var events: [StreamEvent] = []
        for line in lines.feed(chunk) { events += parse(line: line) }
        return events
    }

    public mutating func finish() -> [StreamEvent] {
        var events: [StreamEvent] = []
        if let rest = lines.rest() { events += parse(line: rest) }
        if sawTokens { events.append(.usage(tokens)); sawTokens = false }
        return events
    }

    private mutating func parse(line: Data) -> [StreamEvent] {
        guard !line.isEmpty else { return [] }
        guard let obj = try? JSONSerialization.jsonObject(with: line), let d = obj as? [String: Any] else {
            if let s = String(data: line, encoding: .utf8) {
                if Self.looksLikeFreeLimit(s) { return [.error(ModelKind.opencodeFreeLimitMessage)] }
                if LoginDetector.looksLikeLoginNeeded(s) { return [.error(ModelKind.opencode.loginNeededMessage)] }
            }
            return []
        }
        switch d["type"] as? String {
        case "text":
            guard let part = d["part"] as? [String: Any], let t = part["text"] as? String,
                  !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
            return [.text(t)]
        case "step_finish":
            guard let part = d["part"] as? [String: Any], let tk = part["tokens"] as? [String: Any] else { return [] }
            let cache = tk["cache"] as? [String: Any]
            tokens.input += TokenUsage.int(tk["input"]) + TokenUsage.int(cache?["write"])
            tokens.cachedInput += TokenUsage.int(cache?["read"])
            tokens.output += TokenUsage.int(tk["output"])
            tokens.reasoning += TokenUsage.int(tk["reasoning"])
            sawTokens = true
            return []
        case "error":
            // 거절 이름(`provider.free-limit`)이 어느 필드에 있어도 알아보게 오류 줄 전체 글에서 찾는다.
            if Self.looksLikeFreeLimit(String(decoding: line, as: UTF8.self)) { return [.error(ModelKind.opencodeFreeLimitMessage)] }
            return [.error(Self.userError(Self.message(in: d) ?? "opencode 가 오류를 냈어요"))]
        default:
            return []
        }
    }

    /// 로그인 없이 쓰는 무료 사용량이 찼다는 거절.
    static func looksLikeFreeLimit(_ text: String) -> Bool {
        let low = text.lowercased()
        return low.contains("free-limit") || low.contains("free usage limit")
    }

    /// `error.data.message` · `error.message` · `message` · `error.name`.
    static func message(in d: [String: Any]) -> String? {
        if let e = d["error"] as? [String: Any] {
            if let data = e["data"] as? [String: Any], let m = data["message"] as? String, !m.isEmpty { return m }
            if let m = e["message"] as? String, !m.isEmpty { return m }
            if let n = e["name"] as? String, !n.isEmpty { return n }
        }
        if let m = d["error"] as? String, !m.isEmpty { return m }
        if let m = d["message"] as? String, !m.isEmpty { return m }
        return nil
    }

    static func userError(_ message: String) -> String {
        if LoginDetector.looksLikeLoginNeeded(message) { return ModelKind.opencode.loginNeededMessage }
        let t = message.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.count > errorLimit ? String(t.prefix(errorLimit)) + "…" : t
    }
}
