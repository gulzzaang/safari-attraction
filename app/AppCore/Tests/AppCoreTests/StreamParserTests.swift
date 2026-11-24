import XCTest
import AppCore

final class StreamParserTests: XCTestCase {
    func line(_ s: String) -> Data { Data((s + "\n").utf8) }

    func fixtureLines() throws -> [String] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "claude-stream-sample", withExtension: "jsonl", subdirectory: "Fixtures"))
        return try String(contentsOf: url, encoding: .utf8).split(separator: "\n").map(String.init)
    }

    // MARK: Claude
    func testRealSampleProducesSessionTextResult() throws {
        var p = ClaudeStreamParser()
        var all: [StreamEvent] = []
        for l in try fixtureLines() { all += p.feed(line(l)) }
        XCTAssertEqual(all, [
            .sessionID("11111111-2222-4333-8444-555555555555"),
            .text("파랑"),
            .result(isError: false, text: "파랑"),
        ])
    }
    func testSessionIDEmittedOnceFromInit() {
        var p = ClaudeStreamParser()
        let e1 = p.feed(line(#"{"type":"system","subtype":"init","session_id":"S1","tools":[]}"#))
        let e2 = p.feed(line(#"{"type":"system","subtype":"thinking_tokens","session_id":"S1"}"#))
        XCTAssertEqual(e1, [.sessionID("S1")])
        XCTAssertEqual(e2, [])
    }
    func testToolUseAndText() {
        var p = ClaudeStreamParser()
        let ev = p.feed(line(#"{"type":"assistant","message":{"content":[{"type":"text","text":"찾아볼게요"},{"type":"tool_use","id":"t1","name":"WebSearch","input":{"query":"x"}}]}}"#))
        XCTAssertEqual(ev, [.text("찾아볼게요"), .toolUse(name: "WebSearch")])
    }
    func testResultError() {
        var p = ClaudeStreamParser()
        let ev = p.feed(line(#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"뭔가 잘못됨"}"#))
        XCTAssertEqual(ev, [.result(isError: true, text: "뭔가 잘못됨")])
    }
    func testResultWithoutResultKeyIsTolerated() {
        var p = ClaudeStreamParser()
        let ev = p.feed(line(#"{"type":"result","subtype":"error_max_turns","is_error":true}"#))
        XCTAssertEqual(ev, [.result(isError: true, text: "")])
    }
    func testPartialLineJoinedAcrossChunks() {
        var p = ClaudeStreamParser()
        let full = Data(Array(#"{"type":"assistant","message":{"content":[{"type":"text","text":"가나다"}]}}"#.utf8) + [10])
        // 한글 한 글자(3바이트) 한가운데서 자른다
        let cut = full.firstIndex(of: 0xEA)! + 1
        XCTAssertEqual(p.feed(full[..<cut]), [])
        XCTAssertEqual(p.feed(full[cut...]), [.text("가나다")])
    }
    func testTwoLinesInOneChunkAndLastLineWithoutNewlineOnFinish() {
        var p = ClaudeStreamParser()
        let chunk = Data((#"{"type":"assistant","message":{"content":[{"type":"text","text":"a"}]}}"# + "\n"
            + #"{"type":"assistant","message":{"content":[{"type":"text","text":"b"}]}}"#).utf8)
        XCTAssertEqual(p.feed(chunk), [.text("a")])
        XCTAssertEqual(p.finish(), [.text("b")])
    }
    func testBrokenAndUnknownLinesSkippedSilently() {
        var p = ClaudeStreamParser()
        XCTAssertEqual(p.feed(line("{깨진 줄")), [])
        XCTAssertEqual(p.feed(line("")), [])
        XCTAssertEqual(p.feed(line("[1,2,3]")), [])
        XCTAssertEqual(p.feed(line(#"{"type":"mystery"}"#)), [])
        XCTAssertEqual(p.feed(line(#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"..."}]}}"#)), [])
        XCTAssertEqual(p.feed(Data([0xFF, 0xFE, 10])), [])
    }
    func testCRLFLines() {
        var p = ClaudeStreamParser()
        let ev = p.feed(Data((#"{"type":"result","is_error":false,"result":"ok"}"# + "\r\n").utf8))
        XCTAssertEqual(ev, [.result(isError: false, text: "ok")])
    }

    // MARK: Login needed (Review Focus 1)
    func testClaudeLoginResultBecomesKoreanError() {
        var p = ClaudeStreamParser()
        let ev = p.feed(line(#"{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login"}"#))
        XCTAssertEqual(ev, [.error(ModelKind.claude.loginNeededMessage)])
    }
    func testClaudeNotLoggedInPlainLine() {
        var p = ClaudeStreamParser()
        XCTAssertEqual(p.feed(line("Not logged in · Please run /login")), [.error(ModelKind.claude.loginNeededMessage)])
    }
    func testClaudeAuthFailedAssistantMessage() {
        var p = ClaudeStreamParser()
        let ev = p.feed(line(#"{"type":"assistant","error":"authentication_failed","message":{"content":[{"type":"text","text":"Please run /login"}]}}"#))
        XCTAssertEqual(ev, [.error(ModelKind.claude.loginNeededMessage)])
    }
    func testHookTextMentioningLoginIsNotAnError() throws {
        // 실제 흐름의 hook_response 에 "Please run /login" 이 들어 있어도 오류가 아니다.
        var p = ClaudeStreamParser()
        let ev = p.feed(line(try fixtureLines()[1]))
        XCTAssertEqual(ev, [.sessionID("11111111-2222-4333-8444-555555555555")])
    }
    func testNormalAnswerAboutLoginIsNotAnError() {
        var p = ClaudeStreamParser()
        let ev = p.feed(line(#"{"type":"assistant","message":{"content":[{"type":"text","text":"터미널에서 Please run /login 이라고 치면 돼요"}]}}"#))
        XCTAssertEqual(ev, [.text("터미널에서 Please run /login 이라고 치면 돼요")])
    }
    func testLoginMessagesPerModel() {
        XCTAssertEqual(ModelKind.claude.loginNeededMessage, "앱 전용 클로드 로그인이 필요해요 — 터미널에서 한 번: CLAUDE_CONFIG_DIR=\"$HOME/Library/Application Support/SafariAttractionApp/claude-config\" claude auth login")
        XCTAssertEqual(ModelKind.chatgpt.loginNeededMessage, "설정에서 ChatGPT 로그인을 해 주세요")
        XCTAssertTrue(ModelKind.gemini.loginNeededMessage.hasPrefix("로그인이 필요해요 — 터미널에서 agy"))
        XCTAssertFalse(ModelKind.gemini.loginNeededMessage.contains("agy login"))
    }
    func testLoginDetectorPhrases() {
        for s in ["Please run /login", "not logged in", "Error: Not authenticated", "Please log in to continue",
                  "authentication required", "OAuth token has expired", "401 Unauthorized"] {
            XCTAssertTrue(LoginDetector.looksLikeLoginNeeded(s), s)
        }
        for s in ["파랑", "hello world", "the login page of the site"] {
            XCTAssertFalse(LoginDetector.looksLikeLoginNeeded(s), s)
        }
    }

    // MARK: Plain (agy · codex)
    func testPlainPassesTextThrough() {
        var p = PlainStreamParser(model: .gemini)
        XCTAssertEqual(p.feed(Data("안녕".utf8)), [.text("안녕")])
        XCTAssertEqual(p.feed(Data(" 하세요\n".utf8)), [.text(" 하세요\n")])
        XCTAssertEqual(p.finish(), [])
    }
    func testPlainHoldsBackSplitUTF8() {
        var p = PlainStreamParser(model: .chatgpt)
        let bytes = Array("가".utf8)
        XCTAssertEqual(bytes.count, 3)
        var out: [StreamEvent] = []
        out += p.feed(Data(bytes[0..<2]))
        out += p.feed(Data(bytes[2...]))
        out += p.finish()
        XCTAssertEqual(out, [.text("가")])
    }
    func testPlainFinishFlushesDanglingBytes() {
        var p = PlainStreamParser(model: .gemini)
        XCTAssertEqual(p.feed(Data([0xEA, 0xB0])), [])
        XCTAssertEqual(p.finish().count, 1) // 깨진 끝은 대체 문자로라도 내보낸다
    }
    func testPlainNeverSwallowsShortAnswerMentioningLogin() {
        var p = PlainStreamParser(model: .gemini)
        let t = "'Please log in' 이라고 안내하고 있어요"
        XCTAssertEqual(p.feed(Data(t.utf8)), [.text(t)])
        XCTAssertEqual(p.feed(Data(" 더".utf8)), [.text(" 더")])
    }
    func testPlainLongAnswerMentioningLoginIsNotError() {
        var p = PlainStreamParser(model: .gemini)
        let long = String(repeating: "가", count: 500) + " Please run /login"
        XCTAssertEqual(p.feed(Data(long.utf8)), [.text(long)])
    }
}
