import XCTest
import AppCore

final class ModelOutputReaderTests: XCTestCase {
    func testClaudeStreamThenCleanFinish() {
        var r = ModelOutputReader(model: .claude)
        var ev = r.handle(.stdout(Data((#"{"type":"assistant","message":{"content":[{"type":"text","text":"안녕"}]}}"# + "\n").utf8)))
        ev += r.finish(outcome: .finished(code: 0))
        XCTAssertEqual(ev, [.text("안녕")])
    }
    func testLoginTextOnStderrBecomesKoreanErrorOnce() {
        var r = ModelOutputReader(model: .gemini)
        let e1 = r.handle(.stderr(Data("Error: not logged in, please login\n".utf8)))
        let e2 = r.handle(.stderr(Data("not logged in again\n".utf8)))
        let e3 = r.finish(outcome: .finished(code: 1))
        XCTAssertEqual(e1, [.error(ModelKind.gemini.loginNeededMessage)])
        XCTAssertEqual(e2, []); XCTAssertEqual(e3, [])
    }
    func testNonZeroExitShowsStderrTail() {
        var r = ModelOutputReader(model: .chatgpt)
        _ = r.handle(.stderr(Data("boom happened\n".utf8)))
        let ev = r.finish(outcome: .finished(code: 2))
        XCTAssertEqual(ev.count, 1)
        guard case .error(let m) = ev[0] else { return XCTFail() }
        XCTAssertTrue(m.contains("2") && m.contains("boom happened") && m.contains("codex"))
    }
    func testNotFoundAndTimeoutAreKoreanErrors() {
        var r = ModelOutputReader(model: .gemini)
        XCTAssertEqual(r.finish(outcome: .notFound("agy")),
                       [.error("agy 를 찾지 못했어요 — 설치돼 있는지, 터미널에서 agy 가 실행되는지 확인해 주세요")])
        var r2 = ModelOutputReader(model: .claude)
        XCTAssertEqual(r2.finish(outcome: .timedOut), [.error("180초가 지나 멈췄어요 — 질문을 줄이거나 다시 시도해 주세요")])
        var r3 = ModelOutputReader(model: .claude)
        XCTAssertEqual(r3.finish(outcome: .stopped), [])
    }
    func testClaudeErrorResultNotDuplicatedOnNonZeroExit() {
        var r = ModelOutputReader(model: .claude)
        var ev = r.handle(.stdout(Data((#"{"type":"result","is_error":true,"result":"Please run /login"}"# + "\n").utf8)))
        ev += r.finish(outcome: .finished(code: 1))
        XCTAssertEqual(ev, [.error(ModelKind.claude.loginNeededMessage)])
    }
    func testUserMessagesForOutcomes() {
        XCTAssertNil(ModelKind.claude.userMessage(for: .finished(code: 0)))
        XCTAssertNil(ModelKind.claude.userMessage(for: .stopped))
        XCTAssertNotNil(ModelKind.claude.userMessage(for: .failed("x")))
    }
}
