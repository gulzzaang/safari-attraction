import XCTest
@testable import AppCore

final class StepBox: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [AskFlow.Step] = []
    func add(_ s: AskFlow.Step) { lock.withLock { items.append(s) } }
    var all: [AskFlow.Step] { lock.withLock { items } }
}

final class AskFlowTests: XCTestCase {
    func testOpencodeVariantUnavailableRetriesOnceWithoutVariant() async {
        let runner = FakeRunner()
        runner.setScript { call, emit in
            let modelArg = call.arguments.firstIndex(of: "-m").map { call.arguments[$0 + 1] }
            if modelArg == "opencode-go/deepseek-v4.1-flash#high" {
                emit(.stdout(Data((#"{"type":"error","error":{"type":"provider.no-route","message":"Variant unavailable for opencode-go/deepseek-v4.1-flash: high"}}"# + "\n").utf8)))
                return .finished(code: 1)
            }
            emit(.stdout(Data((#"{"type":"text","part":{"text":"다시 물은 답"}}"# + "\n").utf8)))
            return .finished(code: 0)
        }
        let req = AskRequest(question: "안녕", model: .opencode, modelID: "opencode-go/deepseek-v4.1-flash", effort: "high")
        let box = StepBox()
        let outcome = await AskFlow.run(
            request: req,
            runner: runner,
            loginPath: { "/usr/bin:/bin" },
            workDirectory: { URL(fileURLWithPath: "/tmp/work") },
            timeout: 60,
            geminiLoggedOut: { false },
            emit: { box.add($0) }
        )
        XCTAssertEqual(outcome, .finished(code: 0))
        XCTAssertEqual(runner.calls.count, 2)
        XCTAssertTrue(runner.calls[0].arguments.contains("opencode-go/deepseek-v4.1-flash#high"))
        XCTAssertTrue(runner.calls[1].arguments.contains("opencode-go/deepseek-v4.1-flash"))
        XCTAssertFalse(runner.calls[1].arguments.contains(where: { $0.contains("#") }))

        let steps = box.all
        let notices = steps.compactMap { if case .notice(let s) = $0 { return s }; return nil }
        let errors = steps.compactMap { if case .event(.error(let e)) = $0 { return e }; return nil }
        let texts = steps.compactMap { if case .event(.text(let t)) = $0 { return t }; return nil }
        XCTAssertEqual(notices, ["이 모델은 「높음」 을 못 받아서 기본으로 물었어요"])
        XCTAssertEqual(errors, [])
        XCTAssertEqual(texts, ["다시 물은 답"])
    }

    func testToolActivityLabels() {
        XCTAssertEqual(ToolActivity.label(for: "WebSearch"), "검색 중 …")
        XCTAssertEqual(ToolActivity.label(for: "web_search"), "검색 중 …")
        XCTAssertEqual(ToolActivity.label(for: "search_web"), "검색 중 …")

        XCTAssertEqual(ToolActivity.label(for: "WebFetch"), "페이지 읽는 중 …")
        XCTAssertEqual(ToolActivity.label(for: "read_url_content"), "페이지 읽는 중 …")

        XCTAssertEqual(ToolActivity.label(for: "mcp__safari-attraction__repl"), "사파리 보는 중 …")
        XCTAssertEqual(ToolActivity.label(for: "safari-attraction/ping"), "사파리 보는 중 …")
        XCTAssertEqual(ToolActivity.label(for: "safari-attraction_ping"), "사파리 보는 중 …")
        XCTAssertEqual(ToolActivity.label(for: "repl"), "사파리 보는 중 …")
        XCTAssertEqual(ToolActivity.label(for: "snapshot"), "사파리 보는 중 …")

        XCTAssertEqual(ToolActivity.label(for: "call_mcp_tool"), "도구 쓰는 중 …")
    }

    func testEffortLabels() {
        XCTAssertEqual(Effort.label("low"), "낮음")
        XCTAssertEqual(Effort.label("medium"), "보통")
        XCTAssertEqual(Effort.label("high"), "높음")
        XCTAssertEqual(Effort.label("xhigh"), "매우 높음")
        XCTAssertEqual(Effort.label("max"), "최대")
        XCTAssertEqual(Effort.label("none"), "생각 안 함")
        XCTAssertEqual(Effort.label("minimal"), "아주 낮음")
        XCTAssertEqual(Effort.label("ultra"), "울트라")
        XCTAssertEqual(Effort.label("thinking"), "생각함")
        XCTAssertEqual(Effort.label("custom"), "custom")
    }
}
