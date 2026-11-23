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
        case "result":
            let isError = (d["is_error"] as? Bool) ?? false
            let text = (d["result"] as? String) ?? ""
            if isError && LoginDetector.looksLikeLoginNeeded(text) {
                events.append(.error(ModelKind.claude.loginNeededMessage))
            } else {
                events.append(.result(isError: isError, text: text))
            }
        default: break
        }
        return events
    }
}

/// 제미나이(agy) · ChatGPT(codex) 는 받은 글을 그대로 `.text` 로 낸다.
/// 글자(UTF-8) 한가운데서 chunk 가 잘려도 깨지지 않게 끝의 덜 온 바이트는 다음 chunk 와 합친다.
/// 로그인 문구는 출력이 짧을 때(400자 안)만 오류로 본다 — 긴 답이 로그인 얘기를 해도 오류가 아니다.
public struct PlainStreamParser: StreamParsing {
    public static let loginCheckLimit = 400
    private let model: ModelKind
    private var pending = Data()
    private var seen = ""
    private var loginReported = false

    public init(model: ModelKind) { self.model = model }

    public mutating func feed(_ chunk: Data) -> [StreamEvent] {
        pending.append(chunk)
        guard let s = decodeReadyPrefix() else { return [] }
        return emit(s)
    }

    public mutating func finish() -> [StreamEvent] {
        guard !pending.isEmpty else { return [] }
        let s = String(decoding: pending, as: UTF8.self)
        pending = Data()
        return emit(s)
    }

    private mutating func emit(_ s: String) -> [StreamEvent] {
        if loginReported || s.isEmpty { return [] }
        if seen.count <= Self.loginCheckLimit {
            seen += s
            if seen.count <= Self.loginCheckLimit, LoginDetector.looksLikeLoginNeeded(seen) {
                loginReported = true
                return [.error(model.loginNeededMessage)]
            }
        }
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
public struct ModelOutputReader: Sendable {
    private let model: ModelKind
    private var claude = ClaudeStreamParser()
    private var plain: PlainStreamParser
    private var stderrText = ""
    private var loginReported = false
    private var sawError = false

    public init(model: ModelKind) {
        self.model = model
        self.plain = PlainStreamParser(model: model)
    }

    public mutating func handle(_ event: RunEvent) -> [StreamEvent] {
        switch event {
        case .stdout(let d):
            return track(model == .claude ? claude.feed(d) : plain.feed(d))
        case .stderr(let d):
            stderrText += String(decoding: d, as: UTF8.self)
            if stderrText.count > 4_000 { stderrText = String(stderrText.suffix(2_000)) }
            if !loginReported && LoginDetector.looksLikeLoginNeeded(stderrText) {
                loginReported = true
                sawError = true
                return [.error(model.loginNeededMessage)]
            }
            return []
        }
    }

    /// 실행이 끝났을 때 한 번 부른다. 남은 글 + 결과에 맞는 한국어 안내를 돌려준다.
    public mutating func finish(outcome: RunOutcome) -> [StreamEvent] {
        var events = track(model == .claude ? claude.finish() : plain.finish())
        if sawError || loginReported { return events }
        let tail = String(stderrText.suffix(300))
        if let msg = model.userMessage(for: outcome, stderrTail: tail) {
            events.append(.error(msg))
        }
        return events
    }

    private mutating func track(_ events: [StreamEvent]) -> [StreamEvent] {
        for e in events {
            switch e {
            case .error: sawError = true
            case .result(let isError, _): if isError { sawError = true }
            default: break
            }
        }
        return events
    }
}
