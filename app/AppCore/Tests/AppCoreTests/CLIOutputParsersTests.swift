import XCTest
@testable import AppCore

final class CLIOutputParsersTests: XCTestCase {
    func line(_ s: String) -> Data { Data((s + "\n").utf8) }

    /// 조사 문서(cli-research.md)의 실제 출력 모양.
    let sample = [
        #"{"type":"thread.started","thread_id":"t-1"}"#,
        #"{"type":"turn.started"}"#,
        #"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"안녕하세요"}}"#,
        #"{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":800,"output_tokens":34,"reasoning_output_tokens":10}}"#,
    ]

    func testRealShapeGivesTextAndUsage() {
        var p = CodexStreamParser()
        var all: [StreamEvent] = []
        for l in sample { all += p.feed(line(l)) }
        all += p.finish()
        XCTAssertEqual(all, [.text("안녕하세요"), .usage(TokenUsage(input: 1200, cachedInput: 800, output: 34, reasoning: 10))])
    }

    func testUsageSummaryText() {
        XCTAssertEqual(TokenUsage(input: 1200, cachedInput: 800, output: 34).summary, "쓴 양 1,234 토큰 (입력 1,200 · 출력 34 · 캐시 800)")
        XCTAssertEqual(TokenUsage(input: 5, output: 7).summary, "쓴 양 12 토큰 (입력 5 · 출력 7)")
    }

    func testTwoAgentMessagesAreTwoTextEvents() {
        var p = CodexStreamParser()
        let ev = p.feed(line(#"{"type":"item.completed","item":{"type":"agent_message","text":"a"}}"#)
            + line(#"{"type":"item.completed","item":{"type":"agent_message","text":"b"}}"#))
        XCTAssertEqual(ev, [.text("a"), .text("b")])
    }

    func testOtherItemsAndUnknownLinesAreSkipped() {
        var p = CodexStreamParser()
        var ev = p.feed(line(#"{"type":"item.started","item":{"type":"command_execution","command":"ls"}}"#))
        ev += p.feed(line(#"{"type":"item.completed","item":{"type":"reasoning","text":"생각"}}"#))
        ev += p.feed(line(#"{"type":"something.new"}"#))
        ev += p.feed(line("Reading additional input from stdin..."))
        ev += p.feed(line("{깨진 json"))
        ev += p.finish()
        XCTAssertEqual(ev, [])
    }

    func testChunkSplitInsideAHangulCharacterAndLastLineWithoutNewline() {
        var p = CodexStreamParser()
        let full = Data(Array(#"{"type":"item.completed","item":{"type":"agent_message","text":"가나다"}}"#.utf8))
        let cut = full.firstIndex(of: 0xEA)! + 1
        XCTAssertEqual(p.feed(full[..<cut]), [])
        XCTAssertEqual(p.feed(full[cut...]), [])
        XCTAssertEqual(p.finish(), [.text("가나다")], "줄바꿈 없이 끝난 마지막 줄도 finish 에서 읽는다")
    }

    // MARK: 오류 줄
    func testTurnFailedWithNestedMessage() {
        var p = CodexStreamParser()
        let ev = p.feed(line(#"{"type":"turn.failed","error":{"message":"모델을 쓸 수 없어요"}}"#))
        XCTAssertEqual(ev, [.error("모델을 쓸 수 없어요")])
    }

    func testErrorLineWithTopLevelMessageIsHeldUntilFinishAndDroppedWhenAnswerCame() {
        var p = CodexStreamParser()
        XCTAssertEqual(p.feed(line(#"{"type":"error","message":"stream disconnected"}"#)), [], "도중의 오류 줄은 바로 보이지 않는다")
        XCTAssertEqual(p.finish(), [.error("stream disconnected")])

        var q = CodexStreamParser()
        _ = q.feed(line(#"{"type":"error","message":"Reconnecting... 1/5"}"#))
        _ = q.feed(line(#"{"type":"error","message":"stream disconnected"}"#))
        XCTAssertEqual(q.feed(line(#"{"type":"item.completed","item":{"type":"agent_message","text":"됐어요"}}"#)), [.text("됐어요")])
        XCTAssertEqual(q.finish(), [], "답이 왔으면 앞의 오류 줄은 버린다")

        var r = CodexStreamParser()
        XCTAssertEqual(r.feed(line(#"{"type":"error","message":"Reconnecting... 2/5"}"#)), [])
        XCTAssertEqual(r.finish(), [], "재연결 안내는 오류로 보이지 않는다")
    }

    func testLoginProblemBecomesTheKoreanLoginLine() {
        var p = CodexStreamParser()
        let ev = p.feed(line(#"{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Not logged in"}}"#))
        XCTAssertEqual(ev, [.error(ModelKind.chatgpt.loginNeededMessage)])
        XCTAssertEqual(ModelKind.chatgpt.loginNeededMessage, "설정에서 ChatGPT 로그인을 해 주세요")
    }

    func testLongErrorIsCut() {
        var p = CodexStreamParser()
        let ev = p.feed(line(#"{"type":"turn.failed","error":{"message":"\#(String(repeating: "x", count: 1000))"}}"#))
        guard case .error(let m)? = ev.first else { return XCTFail() }
        XCTAssertLessThanOrEqual(m.count, 301)
    }

    // MARK: ModelOutputReader 와 이어서(Review Focus 2 · 3)
    func testReaderCodexHappyPath() {
        var r = ModelOutputReader(model: .chatgpt)
        var ev: [StreamEvent] = []
        for l in sample { ev += r.handle(.stdout(line(l))) }
        ev += r.finish(outcome: .finished(code: 0))
        XCTAssertEqual(ev.count, 2)
        XCTAssertEqual(ev.first, .text("안녕하세요"))
    }

    func testReaderCodexNonZeroWithLoginPhraseOnStderr() {
        var r = ModelOutputReader(model: .chatgpt)
        _ = r.handle(.stderr(Data("401 Unauthorized\n".utf8)))
        XCTAssertEqual(r.finish(outcome: .finished(code: 1)), [.error(ModelKind.chatgpt.loginNeededMessage)])
    }

    func testReaderCodexBrokenOutputDoesNotCrashAndShowsKoreanNothingFound() {
        var r = ModelOutputReader(model: .chatgpt)
        _ = r.handle(.stdout(Data("\u{0}\u{1}}}{{ garbage\n".utf8)))
        let ev = r.finish(outcome: .finished(code: 0))
        XCTAssertEqual(ev, [])
    }

    func testClaudeResultUsageBecomesUsageEvent() {
        var p = ClaudeStreamParser()
        let ev = p.feed(line(#"{"type":"result","is_error":false,"result":"파랑","usage":{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":100,"output_tokens":7}}"#))
        XCTAssertEqual(ev, [.result(isError: false, text: "파랑"), .usage(TokenUsage(input: 15, cachedInput: 100, output: 7))])
    }
}
