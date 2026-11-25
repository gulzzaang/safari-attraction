import XCTest
@testable import AppCore

final class FakeClock: @unchecked Sendable {
    private let lock = NSLock()
    private var t = Date(timeIntervalSince1970: 1_800_000_000)
    var date: Date { lock.withLock { t } }
    func advance(_ s: TimeInterval) { lock.withLock { t = t.addingTimeInterval(s) } }
}

@MainActor
final class CLIStatusServiceTests: XCTestCase {
    let claudeStatus = #"{"loggedIn":true,"email":"me@example.com","subscriptionType":"team","accessToken":"sk-ant-oat01-SECRETVALUE"}"#
    let usageJSON = #"{"type":"result","is_error":false,"result":"Current session: 8% used · resets Nov 24 at 6:30pm (Asia/Seoul)\nCurrent week (all models): 48% used · resets Nov 28 at 3am (Asia/Seoul)\nCurrent week (Fable): 47% used"}"#
    let modelsJSON = #"[{"slug":"gpt-6-luna","display_name":"GPT-6 Luna","visibility":"list"},{"slug":"hidden","visibility":"hide"}]"#

    /// 이 맥의 PATH 와 상관없이 「설치됨」 으로 만들기 위해 `claude` · `codex` 라는 실행 파일을 임시 폴더에 둔다.
    func fakeBin(_ names: [String]) -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fakebin-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for n in names {
            let f = dir.appendingPathComponent(n)
            try! "#!/bin/sh\n".write(to: f, atomically: true, encoding: .utf8)
            try! FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: f.path)
        }
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir.path
    }

    func make(bin: [String] = ["claude", "codex"], runner: ScriptedCLIRunner, clock: FakeClock = FakeClock()) -> CLIStatusService {
        let path = fakeBin(bin)
        let c = clock
        return CLIStatusService(loginPath: { path }, runnerFactory: { runner },
                                workDirectory: { URL(fileURLWithPath: NSTemporaryDirectory()) }, now: { c.date }, timeout: 5)
    }

    func scriptAllLoggedIn(_ r: ScriptedCLIRunner) {
        r.reply("claude auth status", stdout: claudeStatus)
        r.reply("claude -p /usage --output-format json", stdout: usageJSON)
        r.reply("codex login status", stdout: "Logged in using ChatGPT\n")
        r.reply("codex debug models", stdout: modelsJSON)
    }

    func testRefreshAllLoggedIn() async throws {
        let r = ScriptedCLIRunner(); scriptAllLoggedIn(r)
        let svc = make(runner: r)
        await svc.refreshAll(force: false)

        let c = svc.state(.claude)
        XCTAssertTrue(c.installChecked)
        XCTAssertNotNil(c.installedPath)
        XCTAssertEqual(c.login, .loggedIn(CLIAccountInfo(email: "me@example.com", plan: "team")))
        XCTAssertEqual(c.usage?.windows.count, 3)
        XCTAssertFalse("\(c)".contains("SECRETVALUE"), "토큰 값은 상태 어디에도 없다")

        let x = svc.state(.chatgpt)
        XCTAssertEqual(x.login, .loggedIn(CLIAccountInfo(plan: "plus", detail: "ChatGPT 계정")), "앱서버가 알려 준 플랜을 로그인 줄에 붙인다")
        XCTAssertEqual(x.models.map(\.id), ["gpt-6-luna"])
        XCTAssertEqual(x.usage?.plan, "plus")
        XCTAssertEqual(svc.models(for: .claude).map(\.id), ["sonnet", "opus", "haiku", "fable"])
        XCTAssertFalse(r.commands.contains { $0.hasPrefix("agy") || $0.hasPrefix("opencode") })
    }

    func testNothingRunsAtConstruction() {
        let r = ScriptedCLIRunner()
        _ = make(runner: r)
        XCTAssertEqual(r.commands, [], "앱을 켤 때 · 만들 때는 아무 CLI 도 부르지 않는다")
    }

    func testNotInstalled() async {
        let r = ScriptedCLIRunner()
        let svc = make(bin: [], runner: r)
        await svc.refresh(.chatgpt, force: true)
        let s = svc.state(.chatgpt)
        XCTAssertTrue(s.installChecked)
        XCTAssertNil(s.installedPath)
        XCTAssertEqual(s.login, .unknown)
        XCTAssertEqual(r.commands, [], "없는 CLI 는 띄우지 않는다")
    }

    func testLoggedOutSkipsModelsAndUsage() async {
        let r = ScriptedCLIRunner()
        r.reply("codex login status", outcome: .finished(code: 1), stdout: "Not logged in\n")
        let svc = make(runner: r)
        await svc.refresh(.chatgpt, force: true)
        let s = svc.state(.chatgpt)
        XCTAssertEqual(s.login, .loggedOut)
        XCTAssertTrue(s.isLoggedOut)
        XCTAssertEqual(s.models, [])
        XCTAssertEqual(s.modelsNote, "모델 목록을 못 불러왔어요 — 로그인했는지, codex 가 최신인지 확인해 주세요(지금은 기본 모델로 물어요)")
        XCTAssertEqual(r.commands, ["codex login status"], "로그인 안 됐으면 모델 목록 · 앱서버를 부르지 않는다")
    }

    func testStatusTimeoutIsUnknownNotLoggedOut() async {
        let r = ScriptedCLIRunner()
        r.reply("claude auth status", outcome: .timedOut)
        let svc = make(runner: r)
        await svc.refresh(.claude, force: true)
        XCTAssertEqual(svc.state(.claude).login, .unknown)
        XCTAssertTrue(svc.state(.claude).loginNote?.hasPrefix("알 수 없음") == true)
        XCTAssertEqual(svc.state(.claude).usageNote, "알 수 없음")
    }

    func testUsageFailureIsUnknownButLoginStays() async {
        let r = ScriptedCLIRunner()
        r.reply("claude auth status", stdout: claudeStatus)
        r.reply("claude -p /usage --output-format json", outcome: .timedOut)
        let svc = make(runner: r)
        await svc.refresh(.claude, force: true)
        XCTAssertTrue(svc.state(.claude).isLoggedIn)
        XCTAssertNil(svc.state(.claude).usage)
        XCTAssertEqual(svc.state(.claude).usageNote, "알 수 없음")
    }

    func testNotReReadWithinFiveMinutesUnlessForced() async {
        let r = ScriptedCLIRunner(); scriptAllLoggedIn(r)
        let clock = FakeClock()
        let svc = make(runner: r, clock: clock)
        await svc.refresh(.claude, force: false)
        let first = r.commands.count
        XCTAssertGreaterThan(first, 0)
        clock.advance(299)
        await svc.refresh(.claude, force: false)
        XCTAssertEqual(r.commands.count, first, "5분 안에는 다시 부르지 않는다")
        await svc.refresh(.claude, force: true)
        XCTAssertGreaterThan(r.commands.count, first, "새로 고침은 읽는다")
        let second = r.commands.count
        clock.advance(301)
        await svc.refresh(.claude, force: false)
        XCTAssertGreaterThan(r.commands.count, second, "5분이 지나면 읽는다")
    }

    func testStatusAlwaysReadsAgy() async {
        let support = URL(fileURLWithPath: "/tmp/sa-status-agy-\(UUID().uuidString)")
        let gdir = CLIEnvironment.agyGeminiDirectory(support: support)
        let modelsKey = ([CLICommands.agyModels(geminiDir: gdir).executable] + CLICommands.agyModels(geminiDir: gdir).arguments).joined(separator: " ")
        let usageKey = ([CLICommands.agyUsage(geminiDir: gdir).executable] + CLICommands.agyUsage(geminiDir: gdir).arguments).joined(separator: " ")

        let r1 = ScriptedCLIRunner()
        r1.reply(modelsKey, stdout: "gemini-4-neon-high\tNeon High\n")
        r1.reply(usageKey, stdout: agyUsageSample)
        let path1 = fakeBin(["agy"])
        let svc1 = CLIStatusService(loginPath: { path1 }, runnerFactory: { r1 },
                                    workDirectory: { URL(fileURLWithPath: NSTemporaryDirectory()) },
                                    supportDirectory: { support }, timeout: 5)
        await svc1.refreshForPanel(selected: .gemini)
        XCTAssertTrue(svc1.state(.gemini).isLoggedIn, "옆 창 열 때 agy 를 처음부터 읽는다")
        XCTAssertEqual(r1.commands, [modelsKey, usageKey])

        let r2 = ScriptedCLIRunner()
        r2.reply(modelsKey, stdout: "gemini-4-neon-high\tNeon High\n")
        r2.reply(usageKey, stdout: agyUsageSample)
        let path2 = fakeBin(["agy"])
        let svc2 = CLIStatusService(loginPath: { path2 }, runnerFactory: { r2 },
                                    workDirectory: { URL(fileURLWithPath: NSTemporaryDirectory()) },
                                    supportDirectory: { support }, timeout: 5)
        await svc2.refreshAll(force: false)
        XCTAssertTrue(svc2.state(.gemini).isLoggedIn, "설정 창 열 때 agy 를 처음부터 읽는다")
        XCTAssertEqual(r2.commands, [modelsKey, usageKey])

        let vm = ChatViewModel(runner: FakeRunner(), bridge: FakeBridge(), loginPath: { path1 }, status: svc1)
        XCTAssertTrue(vm.agyAutoRead)
    }
}
