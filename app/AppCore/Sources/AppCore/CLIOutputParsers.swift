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
