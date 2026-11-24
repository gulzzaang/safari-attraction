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
        XCTAssertEqual(c.arguments, ["-p", "질문", "--output-format", "stream-json", "--verbose", "--model", "sonnet", "--tools", "", "--allowedTools", "", "--strict-mcp-config", "--safe-mode"])
    }
    func testClaudeWebSearchOn() {
        let c = CommandBuilder.build(req(.claude, web: true), workDir: work)
        XCTAssertEqual(c.arguments, ["-p", "질문", "--output-format", "stream-json", "--verbose", "--model", "sonnet", "--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch", "--strict-mcp-config", "--safe-mode"])
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
                                     "--strict-mcp-config", "--safe-mode", "--resume", "abc-123"])
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
        XCTAssertEqual(c.arguments, ["-p", "질문", "--model", "gemini-3.8-flash-medium", "--output-format", "stream-json",
                                     "--settings", CLICommands.agySettingsJSON(webSearch: false)])
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
    /// 계획 10 — 읽기 전용 · 세션 없음 · 앱 전용 폴더의 파일 인증. 질문은 늘 마지막 인자.
    /// 도구를 끄는 `--disable` 이 기능마다 붙는다(`CLIManagedConfig.codexDisabledFeatures`).
    let codexBase = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-c", "cli_auth_credentials_store=file"]
        + CLIManagedConfig.codexDisabledFeatures.flatMap { ["--disable", $0] }
    func testChatGPTPlain() {
        let c = CommandBuilder.build(req(.chatgpt), workDir: work)
        XCTAssertEqual(c.executable, "codex")
        XCTAssertEqual(c.arguments, codexBase + ["질문"])
    }
    func testChatGPTModelIDGoesInDashM() {
        var r = req(.chatgpt)
        r.modelID = "gpt-5.6-luna"
        XCTAssertEqual(CommandBuilder.build(r, workDir: work).arguments, codexBase + ["-m", "gpt-5.6-luna", "질문"])
        r.modelID = "--dangerously-bypass-approvals-and-sandbox"
        XCTAssertEqual(CommandBuilder.build(r, workDir: work).arguments, codexBase + ["질문"], "옵션처럼 생긴 모델 id 는 쓰지 않는다")
        r.modelID = "a b"
        XCTAssertEqual(CommandBuilder.build(r, workDir: work).arguments, codexBase + ["질문"])
    }
    func testClaudeModelIDGoesInDashDashModel() {
        var r = req(.claude)
        XCTAssertTrue(CommandBuilder.build(r, workDir: work).arguments.starts(with: ["-p", "질문", "--output-format", "stream-json", "--verbose", "--model", "sonnet"]))
        r.modelID = "opus"
        XCTAssertTrue(CommandBuilder.build(r, workDir: work).arguments.starts(with: ["-p", "질문", "--output-format", "stream-json", "--verbose", "--model", "opus"]))
        r.modelID = "-p"
        XCTAssertTrue(CommandBuilder.build(r, workDir: work).arguments.contains("sonnet"), "이상한 모델 id 는 기본으로")
    }
    func testChatGPTWebSearchOnlyNotice() {
        let r = req(.chatgpt, web: true)
        XCTAssertEqual(CommandBuilder.build(r, workDir: work).arguments, codexBase + ["질문"])
        XCTAssertEqual(CommandBuilder.notice(for: r), "이 CLI 는 웹 검색을 못 해요 — 검색 없이 답해요")
        XCTAssertNil(CommandBuilder.notice(for: req(.chatgpt)))
        XCTAssertNil(CommandBuilder.notice(for: req(.claude, web: true)))
        XCTAssertNil(CommandBuilder.notice(for: req(.gemini, web: true)))
    }
    func testChatGPTHistoryAndPage() {
        let h = [Turn(role: .user, text: "Q1"), Turn(role: .assistant, text: "A1")]
        let c = CommandBuilder.build(req(.chatgpt, page: page, history: h), workDir: work)
        XCTAssertEqual(c.arguments, codexBase + ["[앞 대화]\n사용자: Q1\n답: A1\n\n[지금 사파리 탭]\n제목: 제목\n주소: https://example.com/a\n\n질문"])
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
        let q = CommandBuilder.build(req(.chatgpt, history: h), workDir: work).arguments.last!
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
            let promptArg = model == .chatgpt ? c.arguments.last! : c.arguments[1]
            XCTAssertFalse(promptArg.hasPrefix("-"), "\(model)")
            XCTAssertTrue(promptArg.hasSuffix("--dangerously-skip-permissions"))
        }
    }
    func testClaudeWithoutSessionGetsHistory() {
        let h = [Turn(role: .user, text: "Q1"), Turn(role: .assistant, text: "A1")]
        let c = CommandBuilder.build(req(.claude, history: h, session: nil), workDir: work)
        XCTAssertEqual(c.arguments[1], "[앞 대화]\n사용자: Q1\n답: A1\n\n질문")
        let c2 = CommandBuilder.build(req(.claude, history: h, session: ""), workDir: work)
        XCTAssertEqual(c2.arguments[1], "[앞 대화]\n사용자: Q1\n답: A1\n\n질문")
        XCTAssertFalse(c.arguments.contains("--resume"))
    }
    func testClaudeNeverLoadsMCPAndModelConstant() {
        XCTAssertEqual(CommandBuilder.claudeModel, "sonnet")
        for web in [false, true] {
            let a = CommandBuilder.build(req(.claude, web: web), workDir: work).arguments
            XCTAssertTrue(a.contains("--strict-mcp-config"))
            XCTAssertFalse(a.contains("--mcp-config"))
            // 사용자 훅 · 플러그인을 불러오지 않아야 맥 허락 창(문서 폴더)이 앱 이름으로 뜨지 않는다.
            XCTAssertTrue(a.contains("--safe-mode"))
        }
    }
    func testModelKindBasics() {
        XCTAssertEqual(ModelKind.allCases, [.claude, .gemini, .chatgpt, .opencode])
        XCTAssertEqual(ModelKind.claude.koreanName, "클로드")
        XCTAssertEqual(ModelKind.gemini.koreanName, "제미나이")
        XCTAssertEqual(ModelKind.chatgpt.koreanName, "ChatGPT")
    }
    func testPromptLengthLimitIsTwoHundredThousandUTF8Bytes() {
        XCTAssertEqual(CommandBuilder.maxPromptBytes, 200_000)
        let atLimit = AskRequest(question: String(repeating: "a", count: 200_000), model: .claude)
        XCTAssertFalse(CommandBuilder.exceedsPromptLimit(atLimit), "정확히 상한이면 통과")
        let over = AskRequest(question: String(repeating: "a", count: 200_001), model: .claude)
        XCTAssertTrue(CommandBuilder.exceedsPromptLimit(over))
        // 글자 수가 아니라 UTF-8 바이트 — 한글 6만 7천 자(약 20만 1천 바이트).
        XCTAssertTrue(CommandBuilder.exceedsPromptLimit(AskRequest(question: String(repeating: "가", count: 67_000), model: .claude)))
        XCTAssertFalse(CommandBuilder.exceedsPromptLimit(AskRequest(question: String(repeating: "가", count: 66_000), model: .claude)))
        // 페이지 글(고른 글은 2,000자까지만 붙는다)을 합친 전체 프롬프트가 기준.
        XCTAssertTrue(CommandBuilder.promptTooLongMessage.contains("너무 길어요"))
    }
}
