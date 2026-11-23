import XCTest
@testable import AppCore

final class DevHooksTests: XCTestCase {
    func url(_ s: String) -> URL { URL(string: s)! }

    func testParseToggle() {
        XCTAssertEqual(DevHooks.parse(url: url("safariattraction://toggle")), .toggle)
    }
    func testParseAskWithAllParameters() {
        let c = DevHooks.parse(url: url("safariattraction://ask?model=gemini&q=%EC%95%88%EB%85%95%20%26%20%ED%95%98%EC%84%B8%EC%9A%94&web=1&page=1&open=1"))
        XCTAssertEqual(c, .ask(DevAsk(model: .gemini, question: "안녕 & 하세요", webSearch: true, attachPage: true, openPanel: true)))
    }
    func testParseAskDefaults() {
        let c = DevHooks.parse(url: url("safariattraction://ask?q=hi"))
        XCTAssertEqual(c, .ask(DevAsk(model: .claude, question: "hi", webSearch: false, attachPage: false, openPanel: false)))
    }
    func testParseRejectsBadInput() {
        XCTAssertNil(DevHooks.parse(url: url("safariattraction://ask")), "질문이 없다")
        XCTAssertNil(DevHooks.parse(url: url("safariattraction://ask?q=")), "빈 질문")
        XCTAssertNil(DevHooks.parse(url: url("safariattraction://ask?q=hi&model=gpt9")), "모르는 모델")
        XCTAssertNil(DevHooks.parse(url: url("safariattraction://reboot")))
        XCTAssertNil(DevHooks.parse(url: url("https://example.com/toggle")))
    }
    func testEnabledOnlyWhenDefaultIsOne() {
        let suite = "devhooks-test-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: suite)!
        defer { d.removePersistentDomain(forName: suite) }
        XCTAssertFalse(DevHooks.isEnabled(defaults: d), "기본은 꺼짐")
        d.set(0, forKey: DevHooks.defaultsKey); XCTAssertFalse(DevHooks.isEnabled(defaults: d))
        d.set(1, forKey: DevHooks.defaultsKey); XCTAssertTrue(DevHooks.isEnabled(defaults: d))
        d.set(true, forKey: DevHooks.defaultsKey); XCTAssertTrue(DevHooks.isEnabled(defaults: d))
        d.set(2, forKey: DevHooks.defaultsKey); XCTAssertFalse(DevHooks.isEnabled(defaults: d))
    }
    func testBothSpellingsOfTheBundleDomainEnableTheHooks() {
        // 번들 ID 는 com.gulzzaang(a 둘). 「com.gulzzang」(a 하나)로 켜도 켜진다 — 시험 · 작업 지시서에 두 가지가 섞여 있어서.
        XCTAssertEqual(DevHooks.domains, ["com.gulzzaang.SafariAttractionApp", "com.gulzzang.SafariAttractionApp"])
        let a = "devhooks-a-\(UUID().uuidString)", b = "devhooks-b-\(UUID().uuidString)"
        let da = UserDefaults(suiteName: a)!, db = UserDefaults(suiteName: b)!
        defer { da.removePersistentDomain(forName: a); db.removePersistentDomain(forName: b) }
        XCTAssertFalse(DevHooks.isEnabled(in: [da, db]))
        db.set(1, forKey: DevHooks.defaultsKey)
        XCTAssertTrue(DevHooks.isEnabled(in: [da, db]))
    }
    func testRecordJSONShape() throws {
        let r = RunRecord(model: "claude", question: "q", answer: String(repeating: "가", count: 2_500), error: nil, durationMs: 1234,
                          attachedPage: .init(titlePresent: true, urlHost: "a.example"))
        XCTAssertEqual(r.answer.count, 2_000, "답은 앞 2,000자만")
        let obj = try JSONSerialization.jsonObject(with: RunRecord.encoder.encode(r)) as! [String: Any]
        XCTAssertEqual(Set(obj.keys), ["model", "question", "answer", "error", "durationMs", "attachedPage"])
        XCTAssertEqual(obj["durationMs"] as? Int, 1234)
        XCTAssertTrue(obj["error"] is NSNull)
        let page = obj["attachedPage"] as! [String: Any]
        XCTAssertEqual(Set(page.keys), ["titlePresent", "urlHost"])
        XCTAssertEqual(page["urlHost"] as? String, "a.example")
    }
    func testRecordWithoutPageHasNullAndHostFromURL() throws {
        let r = RunRecord(model: "gemini", question: "q", answer: "", error: "x", durationMs: 1, attachedPage: nil)
        let obj = try JSONSerialization.jsonObject(with: RunRecord.encoder.encode(r)) as! [String: Any]
        XCTAssertTrue(obj["attachedPage"] is NSNull)
        XCTAssertEqual(RunRecord.AttachedPage.from(PageContext(title: "", url: "https://B.example:8080/p?x=1")),
                       RunRecord.AttachedPage(titlePresent: false, urlHost: "b.example"))
    }
    func testWriteAndRemove() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("devlast-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("dev-last.json")
        let r = RunRecord(model: "claude", question: "q", answer: "a", error: nil, durationMs: 5, attachedPage: nil)
        try r.write(to: file)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        RunRecord.remove(at: file)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }
}
