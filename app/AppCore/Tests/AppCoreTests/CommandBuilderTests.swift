import XCTest
import AppCore

final class CommandBuilderTests: XCTestCase {
    let work = URL(fileURLWithPath: "/tmp/work")
    let page = PageContext(title: "제목", url: "https://example.com/a", selection: nil)

    func req(_ model: ModelKind, web: Bool = false, page: PageContext? = nil,
             history: [Turn] = [], session: String? = nil, q: String = "질문") -> AskRequest {
        AskRequest(question: q, model: model, webSearch: web, page: page, history: history, claudeSessionID: session)
    }

    // MARK: Claude
    func testClaudeNoToolsNoPage() {
        let c = CommandBuilder.build(req(.claude), workDir: work)
        XCTAssertEqual(c.executable, "claude")
        XCTAssertEqual(c.arguments, ["-p", "질문", "--output-format", "stream-json", "--verbose", "--model", "sonnet", "--tools", "", "--allowedTools", "", "--strict-mcp-config"])
    }
    func testClaudeWebSearchOn() {
        let c = CommandBuilder.build(req(.claude, web: true), workDir: work)
        XCTAssertEqual(c.arguments, ["-p", "질문", "--output-format", "stream-json", "--verbose", "--model", "sonnet", "--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch", "--strict-mcp-config"])
    }
    func testClaudeWithPage() {
        let c = CommandBuilder.build(req(.claude, page: page), workDir: work)
        XCTAssertEqual(c.arguments[1], "[지금 사파리 탭]\n제목: 제목\n주소: https://example.com/a\n\n질문")
    }
    func testClaudeWithPageAndSelection() {
        let p = PageContext(title: "T", url: "U", selection: "고른 부분")
        let c = CommandBuilder.build(req(.claude, page: p), workDir: work)
        XCTAssertEqual(c.arguments[1], "[지금 사파리 탭]\n제목: T\n주소: U\n고른 글: 고른 부분\n\n질문")
    }
    func testSelectionCappedAt2000Characters() {
        let p = PageContext(title: "T", url: "U", selection: String(repeating: "가", count: 2500))
        let c = CommandBuilder.build(req(.claude, page: p), workDir: work)
        XCTAssertTrue(c.arguments[1].contains("고른 글: " + String(repeating: "가", count: 2000) + "\n"))
        XCTAssertFalse(c.arguments[1].contains(String(repeating: "가", count: 2001)))
    }
    func testClaudeResumeAppended() {
        let c = CommandBuilder.build(req(.claude, web: true, session: "abc-123"), workDir: work)
        XCTAssertEqual(c.arguments, ["-p", "질문", "--output-format", "stream-json", "--verbose", "--model", "sonnet",
                                     "--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch",
                                     "--strict-mcp-config", "--resume", "abc-123"])
    }
    func testClaudeIgnoresHistoryWhenResuming() {
        let h = [Turn(role: .user, text: "앞 질문"), Turn(role: .assistant, text: "앞 답")]
        let c = CommandBuilder.build(req(.claude, history: h, session: "s"), workDir: work)
        XCTAssertEqual(c.arguments[1], "질문")
    }

    // MARK: Gemini
    func testGeminiPlain() {
        let c = CommandBuilder.build(req(.gemini), workDir: work)
        XCTAssertEqual(c.executable, "agy")
        XCTAssertEqual(c.arguments, ["-p", "질문", "--model", "gemini-3.8-flash-medium", "--print-timeout", "120s"])
    }
    func testGeminiWebSearchPrefix() {
        let c = CommandBuilder.build(req(.gemini, web: true), workDir: work)
        XCTAssertEqual(c.arguments[1], "웹에서 찾아서 답해 줘. 출처 주소도 적어 줘.\n\n질문")
    }
    func testGeminiAllPartsOrder() {
        let h = [Turn(role: .user, text: "앞 질문"), Turn(role: .assistant, text: "앞 답")]
        let c = CommandBuilder.build(req(.gemini, web: true, page: page, history: h), workDir: work)
        XCTAssertEqual(c.arguments[1],
            "웹에서 찾아서 답해 줘. 출처 주소도 적어 줘.\n\n[앞 대화]\n사용자: 앞 질문\n답: 앞 답\n\n[지금 사파리 탭]\n제목: 제목\n주소: https://example.com/a\n\n질문")
    }

    // MARK: ChatGPT
    func testChatGPTPlain() {
        let c = CommandBuilder.build(req(.chatgpt), workDir: work)
        XCTAssertEqual(c.executable, "codex")
        XCTAssertEqual(c.arguments, ["exec", "--skip-git-repo-check", "질문"])
    }
    func testChatGPTWebSearchOnlyNotice() {
        let r = req(.chatgpt, web: true)
        XCTAssertEqual(CommandBuilder.build(r, workDir: work).arguments, ["exec", "--skip-git-repo-check", "질문"])
        XCTAssertEqual(CommandBuilder.notice(for: r), "이 모델은 웹 검색을 못 해요 — 검색 없이 답해요")
        XCTAssertNil(CommandBuilder.notice(for: req(.chatgpt)))
        XCTAssertNil(CommandBuilder.notice(for: req(.claude, web: true)))
        XCTAssertNil(CommandBuilder.notice(for: req(.gemini, web: true)))
    }
    func testChatGPTHistoryAndPage() {
        let h = [Turn(role: .user, text: "Q1"), Turn(role: .assistant, text: "A1")]
        let c = CommandBuilder.build(req(.chatgpt, page: page, history: h), workDir: work)
        XCTAssertEqual(c.arguments, ["exec", "--skip-git-repo-check", "[앞 대화]\n사용자: Q1\n답: A1\n\n[지금 사파리 탭]\n제목: 제목\n주소: https://example.com/a\n\n질문"])
    }

    // MARK: History limits
    func testHistoryKeepsLastSixTurns() {
        let h = (1...10).map { Turn(role: $0 % 2 == 1 ? .user : .assistant, text: "t\($0)") }
        let q = CommandBuilder.build(req(.gemini, history: h), workDir: work).arguments[1]
        XCTAssertFalse(q.contains("t4"))
        XCTAssertTrue(q.contains("t5") && q.contains("t10"))
    }
    func testHistoryCappedAt4000Characters() {
        let long = String(repeating: "나", count: 3000)
        let h = [Turn(role: .user, text: "오래된 " + long), Turn(role: .assistant, text: long), Turn(role: .user, text: "마지막 질문")]
        let q = CommandBuilder.build(req(.chatgpt, history: h), workDir: work).arguments[2]
        let body = q.dropFirst("[앞 대화]\n".count).dropLast("\n질문".count)
        XCTAssertLessThanOrEqual(body.count, 4000 + 1)
        XCTAssertTrue(q.contains("마지막 질문"))
        XCTAssertFalse(q.contains("오래된"))
    }
    func testSingleHugeTurnIsTruncatedNotDropped() {
        let h = [Turn(role: .assistant, text: String(repeating: "다", count: 9000))]
        let q = CommandBuilder.build(req(.gemini, history: h), workDir: work).arguments[1]
        XCTAssertTrue(q.hasPrefix("[앞 대화]\n"))
        XCTAssertLessThan(q.count, 4200)
    }
    func testEmptyHistoryAddsNothing() {
        XCTAssertEqual(CommandBuilder.build(req(.gemini), workDir: work).arguments[1], "질문")
    }

    // MARK: Safety (Review Focus 3)
    func testDangerousTextPassesThroughUnchanged() {
        let q = "\"$(rm -rf /)\" 'a' `b` \\ \n두번째 줄"
        let c = CommandBuilder.build(req(.claude, q: q), workDir: work)
        XCTAssertEqual(c.arguments[1], q)
    }
    func testQuestionStartingWithDashCannotBecomeAFlag() {
        for model in ModelKind.allCases {
            let c = CommandBuilder.build(req(model, q: "--dangerously-skip-permissions"), workDir: work)
            let promptArg = model == .chatgpt ? c.arguments[2] : c.arguments[1]
            XCTAssertFalse(promptArg.hasPrefix("-"), "\(model)")
            XCTAssertTrue(promptArg.hasSuffix("--dangerously-skip-permissions"))
        }
    }
    func testClaudeNeverLoadsMCPAndModelConstant() {
        XCTAssertEqual(CommandBuilder.claudeModel, "sonnet")
        for web in [false, true] {
            let a = CommandBuilder.build(req(.claude, web: web), workDir: work).arguments
            XCTAssertTrue(a.contains("--strict-mcp-config"))
            XCTAssertFalse(a.contains("--mcp-config"))
        }
    }
    func testModelKindBasics() {
        XCTAssertEqual(ModelKind.allCases, [.claude, .gemini, .chatgpt])
        XCTAssertEqual(ModelKind.claude.koreanName, "클로드")
        XCTAssertEqual(ModelKind.gemini.koreanName, "제미나이")
        XCTAssertEqual(ModelKind.chatgpt.koreanName, "ChatGPT")
    }
}
