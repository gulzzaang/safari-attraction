import XCTest
@testable import AppCore

/// codex 앱서버 · CLI 읽기용 가짜 실행기 — 명령(`실행파일 인자…`)마다 대본을 달아 둔다.
final class ScriptedCLIRunner: CommandRunning, InteractiveRunning, @unchecked Sendable {
    typealias Reply = (outcome: RunOutcome, stdout: String, stderr: String)
    private let lock = NSLock()
    private var replies: [String: Reply] = [:]
    private var _commands: [String] = []
    private var _written: [String] = []
    private var _stops = 0
    private var _onEvent: (@Sendable (RunEvent) -> Void)?
    private let stopGate = Gate()
    /// 앱서버 대본: initialize 응답과 rateLimits 응답(nil 이면 그 응답을 안 낸다).
    var initResponse: String? = #"{"id":1,"result":{"userAgent":"codex"}}"#
    var rateLimitsResponse: String? = #"{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":42.5,"windowDurationMins":300,"resetsAt":1798013770},"secondary":{"usedPercent":11,"windowDurationMins":10080,"resetsAt":1798500000},"planType":"plus"}}}"#

    func reply(_ command: String, outcome: RunOutcome = .finished(code: 0), stdout: String = "", stderr: String = "") {
        lock.withLock { replies[command] = (outcome, stdout, stderr) }
    }
    var commands: [String] { lock.withLock { _commands } }
    var written: [String] { lock.withLock { _written } }
    var stops: Int { lock.withLock { _stops } }

    func run(executable: String, arguments: [String], workDir: URL, path: String, timeout: TimeInterval,
             environment: [String: String], onEvent: @escaping @Sendable (RunEvent) -> Void) async -> RunOutcome {
        let key = ([executable] + arguments).joined(separator: " ")
        let r: Reply? = lock.withLock { _commands.append(key); return replies[key] }
        guard let r else { return .failed("대본 없음: \(key)") }
        if !r.stdout.isEmpty { onEvent(.stdout(Data(r.stdout.utf8))) }
        if !r.stderr.isEmpty { onEvent(.stderr(Data(r.stderr.utf8))) }
        return r.outcome
    }

    func runInteractive(executable: String, arguments: [String], workDir: URL, path: String, timeout: TimeInterval,
                        initialLines: [String], onEvent: @escaping @Sendable (RunEvent) -> Void) async -> RunOutcome {
        lock.withLock { _commands.append(([executable] + arguments).joined(separator: " ")); _written += initialLines; _onEvent = onEvent }
        if initialLines.contains(where: { $0.contains("\"initialize\"") }), let r = initResponse { onEvent(.stdout(Data((r + "\n").utf8))) }
        await stopGate.wait()
        return .stopped
    }

    func write(_ line: String) throws {
        let (resp, cb): (String?, (@Sendable (RunEvent) -> Void)?) = lock.withLock {
            _written.append(line)
            return (line.contains("account/rateLimits/read") ? rateLimitsResponse : nil, _onEvent)
        }
        if let resp { cb?(.stdout(Data((resp + "\n").utf8))) }
    }
    func closeInput() {}
    func stop() { lock.withLock { _stops += 1 }; Task { await stopGate.open() } }
}

final class CLIUsageTests: XCTestCase {
    // MARK: 클로드 /usage
    let claudeResult = "Current session: 8% used · resets Nov 24 at 6:30pm (Asia/Seoul)\\nCurrent week (all models): 48% used · resets Nov 28 at 3am (Asia/Seoul)\\nCurrent week (Fable): 47% used\\n\\nYour usage patterns this week: you mostly use Claude in the morning"

    func testClaudeUsageFirstThreeLines() throws {
        let json = #"{"type":"result","subtype":"success","is_error":false,"num_turns":0,"result":"\#(claudeResult)"}"#
        let snap = try XCTUnwrap(ClaudeUsageParser.parse(jsonOutput: json))
        XCTAssertEqual(snap.windows, [
            UsageWindow(name: "현재 세션", usedFraction: 0.08, resetsText: "Nov 24 at 6:30pm (Asia/Seoul)"),
            UsageWindow(name: "이번 주 · 전체 모델", usedFraction: 0.48, resetsText: "Nov 28 at 3am (Asia/Seoul)"),
            UsageWindow(name: "이번 주 · Fable", usedFraction: 0.47, resetsText: nil),
        ])
        XCTAssertEqual(snap.rawLines, [])
        XCTAssertEqual(UsageFormat.percentText(snap.windows[0]), "8% 사용")
        XCTAssertEqual(UsageFormat.resetText(snap.windows[0]), "초기화 Nov 24 at 6:30pm (Asia/Seoul)")
        XCTAssertNil(UsageFormat.resetText(snap.windows[2]), "초기화 줄이 없는 세 번째 줄도 읽는다")
    }

    func testClaudeUsageUnknownFormatFallsBackToRawThreeLines() throws {
        let json = #"{"type":"result","is_error":false,"result":"첫 줄\n둘째 줄\n셋째 줄\n넷째 줄"}"#
        let snap = try XCTUnwrap(ClaudeUsageParser.parse(jsonOutput: json))
        XCTAssertEqual(snap.windows, [])
        XCTAssertEqual(snap.rawLines, ["첫 줄", "둘째 줄", "셋째 줄"])
    }

    func testClaudeUsageUnreadableIsNil() {
        for bad in ["", "not json", #"{"type":"result","result":""}"#, #"{"type":"result","is_error":true,"result":"Not logged in"}"#, #"{"a":1}"#] {
            XCTAssertNil(ClaudeUsageParser.parse(jsonOutput: bad), bad)
        }
    }

    // MARK: codex 한도
    func rateLimits(_ s: String) -> [String: Any] {
        (try! JSONSerialization.jsonObject(with: Data(s.utf8))) as! [String: Any]
    }

    func testCodexRateLimitsFreePlanMonthWindow() throws {
        // 조사 문서의 실제 응답(무료 플랜: primary 만, secondary null)
        let r = rateLimits(#"{"rateLimits":{"limitId":"codex","primary":{"usedPercent":0,"windowDurationMins":43200,"resetsAt":1798013770},"secondary":null,"planType":"free"}}"#)
        let snap = try XCTUnwrap(CodexUsageParser.parse(result: r))
        XCTAssertEqual(snap.plan, "free")
        XCTAssertEqual(snap.windows.count, 1)
        XCTAssertEqual(snap.windows[0].name, "30일")
        XCTAssertEqual(snap.windows[0].usedFraction, 0)
        XCTAssertEqual(snap.windows[0].resetsAt, Date(timeIntervalSince1970: 1_798_013_770))
    }

    func testCodexRateLimitsPaidTwoWindows() throws {
        let r = rateLimits(#"{"rateLimits":{"primary":{"usedPercent":42.5,"windowDurationMins":300,"resetsAt":1798013770},"secondary":{"usedPercent":11,"windowDurationMins":10080,"resetsAt":1798500000},"planType":"plus"}}"#)
        let snap = try XCTUnwrap(CodexUsageParser.parse(result: r))
        XCTAssertEqual(snap.windows.map(\.name), ["5시간", "주간"])
        XCTAssertEqual(snap.windows[0].usedFraction ?? 0, 0.425, accuracy: 0.0001)
        XCTAssertEqual(snap.windows[1].usedFraction ?? 0, 0.11, accuracy: 0.0001)
        XCTAssertEqual(UsageFormat.percentText(snap.windows[0]), "43% 사용")
    }

    func testCodexRateLimitsOddShapesGiveNil() {
        for s in [#"{}"#, #"{"rateLimits":{}}"#, #"{"rateLimits":{"primary":null,"secondary":null}}"#, #"{"rateLimits":5}"#] {
            XCTAssertNil(CodexUsageParser.parse(result: rateLimits(s)), s)
        }
        XCTAssertEqual(UsageFormat.percentText(UsageWindow(name: "x", usedFraction: nil)), "알 수 없음")
    }

    func testResetTextTodayAndLaterWithFixedTimeZone() {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "Asia/Seoul")!
        let now = Date(timeIntervalSince1970: 1_798_000_000)           // 한국 시각 2026-12-23 13:26
        let today = UsageWindow(name: "a", usedFraction: 0, resetsAt: now.addingTimeInterval(3600))
        XCTAssertEqual(UsageFormat.resetText(today, now: now, calendar: cal), "초기화 오늘 14:26")
        let later = UsageWindow(name: "a", usedFraction: 0, resetsAt: now.addingTimeInterval(3 * 86_400))
        XCTAssertEqual(UsageFormat.resetText(later, now: now, calendar: cal), "초기화 12월 26일 13:26")
        let past = UsageWindow(name: "a", usedFraction: 0, resetsAt: now.addingTimeInterval(-5))
        XCTAssertEqual(UsageFormat.resetText(past, now: now, calendar: cal), "이미 초기화됐어요")
    }

    // MARK: JSON-RPC
    func testRPCLines() throws {
        let init1 = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(CodexUsageClient.initializeLine().utf8)) as? [String: Any])
        XCTAssertEqual(init1["method"] as? String, "initialize")
        XCTAssertEqual(init1["id"] as? Int, 1)
        XCTAssertNotNil((init1["params"] as? [String: Any])?["clientInfo"])
        XCTAssertEqual(CodexUsageClient.initializedLine, #"{"method":"initialized"}"#)
        XCTAssertEqual(CodexUsageClient.rateLimitsLine(), #"{"method":"account/rateLimits/read","id":2}"#)
        XCTAssertNotNil(CodexUsageClient.response(line: #"{"id":2,"result":{"a":1}}"#, id: 2))
        XCTAssertNil(CodexUsageClient.response(line: #"{"id":3,"result":{}}"#, id: 2))
        XCTAssertNil(CodexUsageClient.response(line: "not json", id: 1))
        XCTAssertEqual(CodexUsageClient.response(line: #"{"id":2,"error":{"code":-1}}"#, id: 2)?.isError, true)
    }

    func testClientTalksInOrderAndStopsTheServer() async {
        let runner = ScriptedCLIRunner()
        let snap = await CodexUsageClient().fetch(runner: runner, path: "/bin", workDir: URL(fileURLWithPath: "/tmp"), timeout: 5)
        XCTAssertEqual(snap?.plan, "plus")
        XCTAssertEqual(snap?.windows.count, 2)
        XCTAssertEqual(runner.commands, ["codex app-server"])
        XCTAssertEqual(runner.written.count, 3)
        XCTAssertTrue(runner.written[0].contains("\"initialize\""))
        XCTAssertEqual(runner.written[1], CodexUsageClient.initializedLine, "응답을 받은 뒤에 initialized")
        XCTAssertTrue(runner.written[2].contains("account/rateLimits/read"))
        XCTAssertEqual(runner.stops, 1, "응답을 받으면 프로세스를 정리한다")
    }

    func testClientErrorResponseGivesNil() async {
        let runner = ScriptedCLIRunner()
        runner.rateLimitsResponse = #"{"id":2,"error":{"code":-32600,"message":"nope"}}"#
        let snap = await CodexUsageClient().fetch(runner: runner, path: "/bin", workDir: URL(fileURLWithPath: "/tmp"), timeout: 5)
        XCTAssertNil(snap)
        XCTAssertEqual(runner.stops, 1)
    }
}
