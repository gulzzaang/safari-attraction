import Foundation

public enum StreamEvent: Sendable, Equatable {
    /// 답 글. Claude 는 말풍선(메시지) 단위로, agy · codex 는 받은 대로 나온다.
    case text(String)
    case toolUse(name: String)
    case sessionID(String)
    /// Claude 의 마지막 줄. `text` 는 앞서 나온 `.text` 와 같은 답을 한 번 더 담고 있으니
    /// 화면에는 `.text` 를 쌓고, `.result` 는 끝났다는 표시 · 오류 판단에만 쓴다(두 번 찍지 않기).
    case result(isError: Bool, text: String)
    case error(String)
    /// 이번 답에 쓴 양(토큰 수) — Claude 의 `result.usage` · codex 의 `turn.completed.usage`. 줄에 있을 때만 나온다.
    case usage(TokenUsage)
    /// 클로드 답 도중에 알려 준 한도(`rate_limit_event.rate_limit_info.unifiedWindows` 가 있을 때만) — 옆 창 남은 양 한 줄을 갱신한다.
    case rateLimits(UsageSnapshot)
}

public protocol StreamParsing: Sendable {
    mutating func feed(_ chunk: Data) -> [StreamEvent]
    /// 흐름이 끝났을 때 남은 것(줄바꿈 없이 끝난 마지막 줄 · 잘린 글자)을 내보낸다.
    mutating func finish() -> [StreamEvent]
}

/// `claude -p … --output-format stream-json --verbose` 의 줄 단위 JSON 을 읽는다.
/// 실제 표본(Tests/AppCoreTests/Fixtures)의 모양: hook_started · hook_response · init · thinking_tokens ·
/// assistant(thinking / text / tool_use) · rate_limit_event · result. 모든 줄에 session_id 가 있다.
/// 모르는 줄 · 깨진 줄은 조용히 건너뛴다(.error 를 내지 않는다).
public struct ClaudeStreamParser: StreamParsing {
    private var buffer = Data()
    private var lastSessionID: String?
    static let maxBufferedBytes = 8_000_000

    public init() {}

    public mutating func feed(_ chunk: Data) -> [StreamEvent] {
        buffer.append(chunk)
        var events: [StreamEvent] = []
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = Data(buffer[buffer.startIndex..<nl])
            buffer = Data(buffer[buffer.index(after: nl)...])
            events += parse(line: line)
        }
        if buffer.count > Self.maxBufferedBytes { buffer = Data() } // 줄바꿈 없이 끝없이 오는 경우 — 메모리 보호
        return events
    }

    public mutating func finish() -> [StreamEvent] {
        let rest = buffer
        buffer = Data()
        return parse(line: rest)
    }

    private mutating func parse(line raw: Data) -> [StreamEvent] {
        var line = raw
        if line.last == 0x0D { line.removeLast() }
        guard !line.isEmpty else { return [] }
        guard let obj = try? JSONSerialization.jsonObject(with: line), let d = obj as? [String: Any] else {
            // JSON 이 아닌 줄(예: CLI 가 직접 찍은 「Please run /login」) — 로그인 문구만 알아본다.
            if let s = String(data: line, encoding: .utf8), LoginDetector.looksLikeLoginNeeded(s) {
                return [.error(ModelKind.claude.loginNeededMessage)]
            }
            return []
        }
        var events: [StreamEvent] = []
        let type = d["type"] as? String
        if let sid = d["session_id"] as? String, !sid.isEmpty, sid != lastSessionID {
            lastSessionID = sid
            events.append(.sessionID(sid))
        }
        switch type {
        case "assistant":
            if (d["error"] as? String) == "authentication_failed" {
                return events + [.error(ModelKind.claude.loginNeededMessage)]
            }
            let content = (d["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
            for block in content {
                switch block["type"] as? String {
                case "text":
                    if let t = block["text"] as? String, !t.isEmpty { events.append(.text(t)) }
                case "tool_use":
                    if let n = block["name"] as? String { events.append(.toolUse(name: n)) }
                default: break // thinking 등
                }
            }
        case "rate_limit_event":
            if let snap = ClaudeUsageParser.parse(rateLimitEvent: d) { events.append(.rateLimits(snap)) }
        case "result":
            let isError = (d["is_error"] as? Bool) ?? false
            let text = (d["result"] as? String) ?? ""
            if isError && LoginDetector.looksLikeLoginNeeded(text) {
                events.append(.error(ModelKind.claude.loginNeededMessage))
            } else {
                events.append(.result(isError: isError, text: text))
            }
            if let u = d["usage"] as? [String: Any] {
                events.append(.usage(TokenUsage(input: TokenUsage.int(u["input_tokens"]) + TokenUsage.int(u["cache_creation_input_tokens"]),
                                                cachedInput: TokenUsage.int(u["cache_read_input_tokens"]),
                                                output: TokenUsage.int(u["output_tokens"]))))
            }
        default: break
        }
        return events
    }
}

/// 받은 글을 그대로 `.text` 로 낸다.
/// 글자(UTF-8) 한가운데서 chunk 가 잘려도 깨지지 않게 끝의 덜 온 바이트는 다음 chunk 와 합친다.
/// 받는 도중에는 글을 바꾸거나 막지 않는다 — 로그인 필요 판정은 끝난 뒤 `ModelOutputReader.finish` 가 한다.
public struct PlainStreamParser: StreamParsing {
    private var pending = Data()

    public init(model: ModelKind) { _ = model }

    public mutating func feed(_ chunk: Data) -> [StreamEvent] {
        pending.append(chunk)
        guard let s = decodeReadyPrefix(), !s.isEmpty else { return [] }
        return [.text(s)]
    }

    public mutating func finish() -> [StreamEvent] {
        guard !pending.isEmpty else { return [] }
        let s = String(decoding: pending, as: UTF8.self)
        pending = Data()
        return [.text(s)]
    }

    private mutating func decodeReadyPrefix() -> String? {
        for k in 0...min(3, pending.count) {
            let end = pending.count - k
            if let s = String(data: pending.prefix(end), encoding: .utf8) {
                pending = Data(pending.suffix(k))
                return s
            }
        }
        let s = String(decoding: pending, as: UTF8.self) // 중간이 깨진 바이트 — 대체 문자로
        pending = Data()
        return s
    }
}

/// 한 번의 실행 동안 ProcessRunner 의 이벤트(stdout · stderr)를 받아 화면용 StreamEvent 로 바꾸는 접착제.
/// 로그인 필요 · CLI 없음 · 시간 초과 · 비정상 종료를 한국어 `.error` 한 줄로 만든다(Review Focus 1).
///
/// 로그인 필요 판정(agy · codex · Claude 의 구조 밖 출력)은 **끝에서만** 한다 — 흘러나온 답을 중간에 바꾸거나 막지 않는다.
/// 종료 코드가 0 이 아니거나 stdout 에 답이 하나도 없을 때만, stderr(와 짧은 stdout)에서 문구를 찾는다.
/// 그래서 종료 코드 0 으로 답을 낸 경우, 답이나 stderr 에 「Please log in」 이 있어도 오류가 아니다.
/// Claude 의 구조화된 줄(`result` is_error · authentication_failed)은 파서가 그대로 `.error` 로 낸다.
public struct ModelOutputReader: Sendable {
    private static let shortStdoutLimit = 400
    private let model: ModelKind
    private var claude = ClaudeStreamParser()
    private var codex = CodexStreamParser()
    private var agy = AgyStreamParser()
    private var opencode = OpenCodeStreamParser()
    private var stderrText = ""
    private var stdoutHead = ""
    private var sawAnswer = false
    private var sawError = false

    public init(model: ModelKind) {
        self.model = model
    }

    public mutating func handle(_ event: RunEvent) -> [StreamEvent] {
        switch event {
        case .stdout(let d):
            return track(feedStdout(d))
        case .stderr(let d):
            stderrText += String(decoding: d, as: UTF8.self)
            if stderrText.count > 4_000 { stderrText = String(stderrText.suffix(2_000)) }
            return []
        }
    }

    /// 실행이 끝났을 때 한 번 부른다. 남은 글 + 결과에 맞는 한국어 안내를 돌려준다.
    public mutating func finish(outcome: RunOutcome) -> [StreamEvent] {
        var events = track(finishStdout())
        if sawError { return events }
        if case .finished(let code) = outcome, code != 0 || !sawAnswer {
            let shortStdout = stdoutHead.count <= Self.shortStdoutLimit ? stdoutHead : ""
            if LoginDetector.looksLikeLoginNeeded(stderrText) || LoginDetector.looksLikeLoginNeeded(shortStdout) {
                events.append(.error(model.loginNeededMessage))
                return events
            }
        }
        let tail = String(stderrText.suffix(300))
        if let msg = model.userMessage(for: outcome, stderrTail: tail) {
            events.append(.error(msg))
        }
        return events
    }

    private mutating func feedStdout(_ d: Data) -> [StreamEvent] {
        switch model {
        case .claude: return claude.feed(d)
        case .chatgpt: return codex.feed(d)
        case .gemini: return agy.feed(d)
        case .opencode: return opencode.feed(d)
        }
    }

    private mutating func finishStdout() -> [StreamEvent] {
        switch model {
        case .claude: return claude.finish()
        case .chatgpt: return codex.finish()
        case .gemini: return agy.finish()
        case .opencode: return opencode.finish()
        }
    }

    private mutating func track(_ events: [StreamEvent]) -> [StreamEvent] {
        for e in events {
            switch e {
            case .error: sawError = true
            case .result(let isError, _): if isError { sawError = true }
            case .text(let t):
                sawAnswer = true
                if stdoutHead.count <= Self.shortStdoutLimit { stdoutHead += t }
            default: break
            }
        }
        return events
    }
}
