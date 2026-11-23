import XCTest
@testable import AppCore

final class ClaudeControlTests: XCTestCase {
    func data(_ s: String) -> Data { Data(s.utf8) }
    func obj(_ s: String) -> NSDictionary {
        try! JSONSerialization.jsonObject(with: Data(s.utf8)) as! NSDictionary
    }

    // MARK: 읽기

    func testParsesExitPlanModeRequest() {
        let line = #"{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","input":{"plan":"1. 쿠팡 열기\n2. 가격 읽기"},"tool_use_id":"toolu_9","display_name":"x","description":"y","permission_suggestions":[]}}"#
        guard case .permission(let p)? = ClaudeControl.parse(data(line)) else { return XCTFail("권한 묻기로 읽히지 않음") }
        XCTAssertEqual(p.requestID, "req-1")
        XCTAssertEqual(p.toolName, "ExitPlanMode")
        XCTAssertEqual(p.toolUseID, "toolu_9")
        XCTAssertEqual(p.input["plan"] as? String, "1. 쿠팡 열기\n2. 가격 읽기")
    }
    func testParsesMcpToolRequestWithNestedInput() {
        let line = #"{"type":"control_request","request_id":"r2","request":{"subtype":"can_use_tool","tool_name":"mcp__safari-attraction__repl","input":{"code":"await tab.click(\"a\")","opts":{"n":[1,2,{"k":null}],"b":true}},"tool_use_id":"t"}}"#
        guard case .permission(let p)? = ClaudeControl.parse(data(line)) else { return XCTFail() }
        XCTAssertEqual(p.toolName, "mcp__safari-attraction__repl")
        XCTAssertEqual(p.input["code"] as? String, "await tab.click(\"a\")")
        // 입력은 그대로 되돌려 보낼 수 있어야 한다(updatedInput).
        let echoed = ClaudeControl.allow(requestID: p.requestID, updatedInput: p.input, setModeManual: false)
        let back = (obj(echoed)["response"] as! NSDictionary)["response"] as! NSDictionary
        XCTAssertEqual(back["updatedInput"] as? NSDictionary, obj(line)["request"].flatMap { ($0 as! NSDictionary)["input"] as? NSDictionary })
    }
    func testPermissionRequestIsEquatableAndSendable() {
        let line = #"{"type":"control_request","request_id":"a","request":{"subtype":"can_use_tool","tool_name":"T","input":{"x":1,"y":2},"tool_use_id":"u"}}"#
        let a = ClaudeControl.parse(data(line)), b = ClaudeControl.parse(data(line))
        XCTAssertEqual(a, b)
    }
    func testMissingToolUseIDBecomesEmpty() {
        let line = #"{"type":"control_request","request_id":"a","request":{"subtype":"can_use_tool","tool_name":"T","input":{}}}"#
        guard case .permission(let p)? = ClaudeControl.parse(data(line)) else { return XCTFail() }
        XCTAssertEqual(p.toolUseID, "")
        XCTAssertTrue(p.input.isEmpty)
    }
    func testOtherSubtypeIsReportedAsUnsupportedSoCallerCanAnswer() {
        let line = #"{"type":"control_request","request_id":"z","request":{"subtype":"hook_callback"}}"#
        XCTAssertEqual(ClaudeControl.parse(data(line)), .unsupported(requestID: "z", subtype: "hook_callback"))
    }
    func testMalformedCanUseToolIsUnsupported() {
        let line = #"{"type":"control_request","request_id":"z","request":{"subtype":"can_use_tool","input":{}}}"#
        XCTAssertEqual(ClaudeControl.parse(data(line)), .unsupported(requestID: "z", subtype: "can_use_tool"))
    }
    func testNonControlLinesAreNil() {
        XCTAssertNil(ClaudeControl.parse(data(#"{"type":"assistant","message":{"content":[]}}"#)))
        XCTAssertNil(ClaudeControl.parse(data(#"{"type":"result","subtype":"success","is_error":false,"result":"끝"}"#)))
        XCTAssertNil(ClaudeControl.parse(data(#"{"type":"control_response","response":{}}"#)))
        XCTAssertNil(ClaudeControl.parse(data("not json")))
        XCTAssertNil(ClaudeControl.parse(data("")))
        XCTAssertNil(ClaudeControl.parse(data("[1,2]")))
        XCTAssertNil(ClaudeControl.parse(data(#"{"type":"control_request","request":{"subtype":"can_use_tool"}}"#))) // request_id 없음
    }
    func testParsesLineWithTrailingNewlineAndCR() {
        let line = #"{"type":"control_request","request_id":"a","request":{"subtype":"can_use_tool","tool_name":"T","input":{},"tool_use_id":"u"}}"# + "\r\n"
        XCTAssertNotNil(ClaudeControl.parse(data(line)))
    }

    // MARK: 쓰기

    func testAllowPlain() {
        let s = ClaudeControl.allow(requestID: "req-1", updatedInput: ["plan": "계획"], setModeManual: false)
        XCTAssertFalse(s.contains("\n"))
        XCTAssertEqual(obj(s), obj(#"{"type":"control_response","response":{"subtype":"success","request_id":"req-1","response":{"behavior":"allow","updatedInput":{"plan":"계획"}}}}"#))
    }
    func testAllowWithSetModeManualMatchesRealShape() {
        let s = ClaudeControl.allow(requestID: "req-1", updatedInput: ["plan": "계획"], setModeManual: true)
        XCTAssertFalse(s.contains("\n"))
        XCTAssertEqual(obj(s), obj(#"{"type":"control_response","response":{"subtype":"success","request_id":"req-1","response":{"behavior":"allow","updatedInput":{"plan":"계획"},"updatedPermissions":[{"type":"setMode","mode":"manual","destination":"session"}]}}}"#))
    }
    func testDeny() {
        let s = ClaudeControl.deny(requestID: "r9", message: "사용자가 거절했어요: \"위험\"\n줄바꿈")
        XCTAssertFalse(s.contains("\n"))
        XCTAssertEqual(obj(s), obj(#"{"type":"control_response","response":{"subtype":"success","request_id":"r9","response":{"behavior":"deny","message":"사용자가 거절했어요: \"위험\"\n줄바꿈"}}}"#))
    }
    func testErrorResponse() {
        let s = ClaudeControl.error(requestID: "z", message: "지원하지 않아요")
        XCTAssertEqual(obj(s), obj(#"{"type":"control_response","response":{"subtype":"error","request_id":"z","error":"지원하지 않아요"}}"#))
    }
    func testUserMessage() {
        let s = ClaudeControl.userMessage("쿠팡에서 \"물\" 가격 찾아줘\n둘째 줄 / 슬래시")
        XCTAssertFalse(s.contains("\n"))
        XCTAssertEqual(obj(s), obj(#"{"type":"user","message":{"role":"user","content":"쿠팡에서 \"물\" 가격 찾아줘\n둘째 줄 / 슬래시"}}"#))
    }
    func testOutputIsDeterministicSortedKeys() {
        let a = ClaudeControl.allow(requestID: "r", updatedInput: ["b": 1, "a": 2, "c": 3], setModeManual: true)
        for _ in 0..<5 { XCTAssertEqual(a, ClaudeControl.allow(requestID: "r", updatedInput: ["c": 3, "a": 2, "b": 1], setModeManual: true)) }
        XCTAssertTrue(a.contains(#""a":2,"b":1,"c":3"#))
    }
    func testWrittenLinesRoundTripThroughParserShape() {
        // 우리가 쓴 사용자 줄은 한 줄 JSON 이다(여러 줄이면 클로드가 깨진 줄로 읽음).
        let s = ClaudeControl.userMessage("가\u{2028}나\u{2029}다\r\n라")
        XCTAssertEqual(s.split(whereSeparator: { $0 == "\n" || $0 == "\r" }).count, 1)
        XCTAssertFalse(s.contains("\u{2028}")); XCTAssertFalse(s.contains("\u{2029}"))
        XCTAssertEqual(s.components(separatedBy: .newlines).count, 1) // U+2028 · 2029 · NEL 포함 어떤 줄바꿈도 없다
        // 이스케이프로 바뀌어도 읽으면 원래 글이다.
        let back = (obj(s)["message"] as! NSDictionary)["content"] as? String
        XCTAssertEqual(back, "가\u{2028}나\u{2029}다\r\n라")
    }

    func testCancelRequestIDIsReadFromCancelLinesOnly() {
        let cancel = Data(#"{"type":"control_cancel_request","request_id":"req-9"}"#.utf8) + Data([0x0A])
        XCTAssertEqual(ClaudeControl.cancelledRequestID(cancel), "req-9")
        XCTAssertNil(ClaudeControl.cancelledRequestID(Data(#"{"type":"control_cancel_request"}"#.utf8)))
        XCTAssertNil(ClaudeControl.cancelledRequestID(Data(#"{"type":"control_request","request_id":"a","request":{}}"#.utf8)))
        XCTAssertNil(ClaudeControl.cancelledRequestID(Data("not json".utf8)))
        XCTAssertNil(ClaudeControl.parse(cancel), "취소 줄은 물음이 아니다")
    }
}
