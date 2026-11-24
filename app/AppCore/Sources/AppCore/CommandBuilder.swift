import Foundation

/// 모델별 명령줄. 셸을 거치지 않고 인자 배열로만 넘기므로 따옴표 · `$(…)` · 줄바꿈은 해석되지 않는다.
public enum CommandBuilder {
    public static let historyTurnLimit = 6
    public static let historyCharLimit = 4_000
    public static let selectionCharLimit = 2_000
    public static let geminiModel = "gemini-3.8-flash-medium"
    /// 옆 창 Claude 의 기본 모델(빠르고 구독 한도를 덜 씀). 나중에 바꿀 땐 여기 한 곳만.
    public static let claudeModel = "sonnet"
    public static let claudeWebTools = "WebSearch,WebFetch"
    public static let webSearchPrefix = "웹에서 찾아서 답해 줘. 출처 주소도 적어 줘.\n\n"
    /// 프롬프트(앞 대화 · 페이지 글 · 질문을 합친 것) 상한 — UTF-8 바이트 기준. 넘으면 CLI 를 띄우지 않는다.
    public static let maxPromptBytes = 200_000
    public static let promptTooLongMessage = "질문이 너무 길어요 — 줄여서 다시 보내 주세요(한글 약 6만 자 · 20만 바이트까지)"
    public static let chatgptNoWebNotice = "이 CLI 는 웹 검색을 못 해요 — 검색 없이 답해요"

    /// 고른 클로드 모델 id — 안전한 글자뿐이고 비어 있지 않으면 그것, 아니면 기본(`claudeModel`).
    public static func claudeModelArgument(_ id: String?) -> String {
        if let id, CLIModels.isSafeID(id) { return id }
        return claudeModel
    }

    /// `workDir` 는 실행 쪽(ProcessRunner)이 작업 폴더로 쓴다 — 명령줄에는 들어가지 않는다.
    public static func build(_ r: AskRequest, workDir: URL) -> (executable: String, arguments: [String]) {
        _ = workDir
        let prompt = composedPrompt(r)
        switch r.model {
        case .claude:
            // --tools 로 쓸 수 있는 도구 자체를 줄이고(끔이면 "" = 없음), --allowedTools 로 -p 에서 허락 없이 돌게 한다.
            // --strict-mcp-config 만 주고 --mcp-config 는 안 줘서 사용자의 MCP 서버는 불러오지 않는다(대화만).
            // --safe-mode: 사용자 훅 · 플러그인 · CLAUDE.md 를 불러오지 않는다. 앱이 띄운 자식이 사용자 설정을 따라
            // 문서 폴더에 손대면 맥이 「앱이 문서 폴더에 접근」 허락 창을 앱 이름으로 띄우고, 아무도 안 누르면
            // 그 자리에서 멈춘다(2026-11-23 시험에서 겪음). 로그인(구독)은 그대로 된다.
            let tools = r.webSearch ? claudeWebTools : ""
            var args = ["-p", prompt, "--output-format", "stream-json", "--verbose",
                        "--model", claudeModelArgument(r.modelID),
                        "--tools", tools, "--allowedTools", tools,
                        "--strict-mcp-config", "--safe-mode"]
            if let id = r.claudeSessionID, !id.isEmpty { args += ["--resume", id] }
            return ("claude", args)
        case .gemini:
            // 출력은 stream-json(NDJSON) — 답 글 · 쓴 양을 `AgyStreamParser` 가 읽는다. 모델은 목록에서 고른 것(없으면 기본).
            let c = CLICommands.agyAsk(prompt: prompt, modelID: r.modelID)
            return (c.executable, c.arguments)
        case .chatgpt:
            let c = CLICommands.codexExec(prompt: prompt, modelID: r.modelID)
            return (c.executable, c.arguments)
        case .opencode:
            let c = CLICommands.opencodeRun(prompt: prompt, modelID: r.modelID)
            return (c.executable, c.arguments)
        }
    }

    /// 사용자에게 먼저 보일 안내(없으면 nil). 웹 검색을 못 하는 CLI(ChatGPT · opencode)에서 웹 검색을 켰을 때.
    public static func notice(for r: AskRequest) -> String? {
        ((r.model == .chatgpt || r.model == .opencode) && r.webSearch) ? chatgptNoWebNotice : nil
    }

    /// 합친 프롬프트가 `maxPromptBytes`(UTF-8)를 넘는가.
    public static func exceedsPromptLimit(_ r: AskRequest) -> Bool {
        composedPrompt(r).utf8.count > maxPromptBytes
    }

    /// 순서: 웹 검색 안내(제미나이만) → 앞 대화(클로드는 `--resume` 이 없을 때만 — 대화 도중 모델을 바꾼 경우) → 사파리 탭 → 질문.
    static func composedPrompt(_ r: AskRequest) -> String {
        var s = ""
        if r.model == .gemini && r.webSearch { s += webSearchPrefix }
        if r.model != .claude || (r.claudeSessionID ?? "").isEmpty { s += historyBlock(r.history) }
        if let page = r.page { s += pageBlock(page) }
        s += r.question
        // 「-」 로 시작하면 CLI 가 질문을 옵션으로 읽을 수 있다 — 형태는 그대로 두고 앞에 말머리를 붙인다.
        if s.hasPrefix("-") { s = "질문: " + s }
        return s
    }

    static func pageBlock(_ p: PageContext) -> String {
        var s = "[지금 사파리 탭]\n제목: \(p.title)\n주소: \(p.url)\n"
        if let sel = p.selection, !sel.isEmpty { s += "고른 글: \(String(sel.prefix(selectionCharLimit)))\n" }
        return s + "\n"
    }

    /// 최근 6턴, 합쳐서 4,000자(Character) 안 — 모자라면 오래된 턴부터 버리고, 한 턴만 남아도 넘치면 그 턴의 앞을 잘라 낸다.
    static func historyBlock(_ history: [Turn]) -> String {
        var lines = history.suffix(historyTurnLimit).map { t in
            (t.role == .user ? "사용자: " : "답: ") + t.text
        }
        guard !lines.isEmpty else { return "" }
        func joined() -> String { lines.joined(separator: "\n") }
        while joined().count > historyCharLimit && lines.count > 1 { lines.removeFirst() }
        var body = joined()
        if body.count > historyCharLimit { body = "…" + String(body.suffix(historyCharLimit - 1)) }
        return "[앞 대화]\n" + body + "\n\n"
    }
}
