import XCTest
@testable import AppCore

final class CLIAccountTests: XCTestCase {
    func testClaudeStatusTakesOnlyEmailAndPlan() {
        let out = """
        {"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"me@example.com","orgName":"Secret Org",
         "subscriptionType":"team","accessToken":"sk-ant-oat01-SECRETSECRET","apiKey":"sk-ant-api03-ABCDEF","loginExpiresAt":"2027-01-01"}
        """
        let st = CLIAccountParser.parseClaudeStatus(stdout: out, exitCode: 0)
        XCTAssertEqual(st, .loggedIn(CLIAccountInfo(email: "me@example.com", plan: "team")))
        guard case .loggedIn(let info) = st else { return XCTFail() }
        XCTAssertEqual(info.summary, "me@example.com · team")
        for secret in ["sk-ant", "SECRET", "Secret Org", "2027"] {
            XCTAssertFalse(info.summary.contains(secret), secret)
            XCTAssertFalse("\(st)".contains(secret), "상태 값 어디에도 \(secret) 가 없다")
        }
    }

    func testTokenLookingValuesInEmailOrPlanAreDropped() {
        let out = #"{"loggedIn":true,"email":"sk-ant-oat01-ABCDEF","subscriptionType":"sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWX"}"#
        XCTAssertEqual(CLIAccountParser.parseClaudeStatus(stdout: out, exitCode: 0), .loggedIn(CLIAccountInfo()))
    }

    func testClaudeExitOneOrLoggedInFalseIsLoggedOut() {
        XCTAssertEqual(CLIAccountParser.parseClaudeStatus(stdout: #"{"loggedIn":false}"#, exitCode: 1), .loggedOut)
        XCTAssertEqual(CLIAccountParser.parseClaudeStatus(stdout: "", exitCode: 1), .loggedOut)
        XCTAssertEqual(CLIAccountParser.parseClaudeStatus(stdout: #"{"loggedIn":false}"#, exitCode: 0), .loggedOut)
    }

    func testClaudeNonJSONWithExitZeroIsLoggedInWithoutDetails() {
        XCTAssertEqual(CLIAccountParser.parseClaudeStatus(stdout: "Logged in\n", exitCode: 0), .loggedIn(CLIAccountInfo()))
        XCTAssertEqual(CLIAccountInfo().summary, "로그인됨")
    }

    func testCodexStatusUsesFixedKoreanWordsNotTheRawText() {
        XCTAssertEqual(CLIAccountParser.parseCodexStatus(output: "Logged in using ChatGPT\n", exitCode: 0), .loggedIn(CLIAccountInfo(detail: "ChatGPT 계정")))
        let key = CLIAccountParser.parseCodexStatus(output: "Logged in using an API key - sk-proj-SECRET123", exitCode: 0)
        XCTAssertEqual(key, .loggedIn(CLIAccountInfo(detail: "API 키 로그인(구독 아님)")))
        XCTAssertFalse("\(key)".contains("SECRET"))
        XCTAssertEqual(CLIAccountParser.parseCodexStatus(output: "Not logged in", exitCode: 1), .loggedOut)
        XCTAssertEqual(CLIAccountParser.parseCodexStatus(output: "Not logged in", exitCode: 0), .loggedOut)
    }
}
