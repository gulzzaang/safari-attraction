import Foundation

/// 클로드가 도구를 쓰기 전에 앱에 묻는 것(`--permission-prompt-tool stdio` 의 `control_request` / `can_use_tool`).
/// 입력은 JSON 데이터로 들고 있다(`[String: Any]` 는 Sendable · Equatable 이 아니라서) — `input` 으로 읽는다.
public struct PermissionRequest: Sendable, Equatable {
    public let requestID: String
    public let toolName: String
    public let toolUseID: String
    /// 도구 입력(JSON 객체) — 키를 정렬해 직렬화한 데이터.
    public let inputData: Data

    public init(requestID: String, toolName: String, toolUseID: String, input: [String: Any]) {
        self.requestID = requestID
        self.toolName = toolName
        self.toolUseID = toolUseID
        self.inputData = ClaudeControl.serialize(input) ?? Data("{}".utf8)
    }

    public var input: [String: Any] {
        (try? JSONSerialization.jsonObject(with: inputData)) as? [String: Any] ?? [:]
    }
}

public enum ControlEvent: Sendable, Equatable {
    case permission(PermissionRequest)
    /// 우리가 모르는 `control_request`(다른 subtype · 모양이 깨진 `can_use_tool`). 클로드가 답을 기다릴 수 있으니
    /// 부르는 쪽이 `ClaudeControl.error` 로 답해야 한다.
    case unsupported(requestID: String, subtype: String)
}

/// `claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio` 의 제어 줄.
/// 읽기는 클로드 표준 출력의 한 줄, 쓰기는 표준 입력으로 보낼 한 줄(줄바꿈은 붙이지 않음 — `ProcessRunner.write` 가 붙인다).
/// assistant · result 같은 다른 줄은 `ClaudeStreamParser` 의 몫이라 여기서는 nil.
public enum ClaudeControl {
    public static func parse(_ line: Data) -> ControlEvent? {
        var raw = line
        while let last = raw.last, last == 0x0A || last == 0x0D { raw.removeLast() }
        guard !raw.isEmpty,
              let obj = try? JSONSerialization.jsonObject(with: raw), let d = obj as? [String: Any],
              d["type"] as? String == "control_request",
              let requestID = d["request_id"] as? String, !requestID.isEmpty,
              let req = d["request"] as? [String: Any] else { return nil }
        let subtype = req["subtype"] as? String ?? ""
        guard subtype == "can_use_tool", let tool = req["tool_name"] as? String, !tool.isEmpty else {
            return .unsupported(requestID: requestID, subtype: subtype)
        }
        return .permission(PermissionRequest(requestID: requestID, toolName: tool,
                                             toolUseID: req["tool_use_id"] as? String ?? "",
                                             input: req["input"] as? [String: Any] ?? [:]))
    }

    /// 허락. `setModeManual` 이면 계획 모드에서 빠져나오게 한다(ExitPlanMode 승인 때) —
    /// `updatedPermissions: [{"type":"setMode","mode":"manual","destination":"session"}]`.
    public static func allow(requestID: String, updatedInput: [String: Any], setModeManual: Bool) -> String {
        var inner: [String: Any] = ["behavior": "allow", "updatedInput": updatedInput]
        if setModeManual {
            inner["updatedPermissions"] = [["type": "setMode", "mode": "manual", "destination": "session"]]
        }
        return controlResponse(["subtype": "success", "request_id": requestID, "response": inner])
    }

    public static func deny(requestID: String, message: String) -> String {
        controlResponse(["subtype": "success", "request_id": requestID,
                         "response": ["behavior": "deny", "message": message]])
    }

    /// 지원하지 않는 요청에 대한 오류 답.
    public static func error(requestID: String, message: String) -> String {
        controlResponse(["subtype": "error", "request_id": requestID, "error": message])
    }

    /// 사용자 한 턴: `{"type":"user","message":{"role":"user","content":"…"}}`.
    public static func userMessage(_ text: String) -> String {
        json(["type": "user", "message": ["role": "user", "content": text]])
    }

    // MARK: - 내부

    private static func controlResponse(_ response: [String: Any]) -> String {
        json(["type": "control_response", "response": response])
    }

    /// 한 줄 JSON — 키 정렬(시험이 흔들리지 않게), 슬래시는 그대로. 값은 전부 JSONSerialization 이 이스케이프한다.
    static func json(_ obj: [String: Any]) -> String {
        String(decoding: serialize(obj) ?? Data("{}".utf8), as: UTF8.self)
    }

    static func serialize(_ obj: [String: Any]) -> Data? {
        guard JSONSerialization.isValidJSONObject(obj) else { return nil }
        return try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes])
    }
}
