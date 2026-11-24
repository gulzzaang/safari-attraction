import XCTest
@testable import AppCore

final class CLIModelsTests: XCTestCase {
    func testClaudeFixedList() {
        XCTAssertEqual(CLIModels.claudeChoices.map(\.id), ["sonnet", "opus", "haiku", "fable"])
        XCTAssertEqual(CLIModels.claudeChoices.map(\.label), ["Sonnet", "Opus", "Haiku", "Fable"])
        XCTAssertEqual(CLIModels.resolve(selected: nil, in: CLIModels.claudeChoices), "sonnet", "기본은 Sonnet")
        XCTAssertEqual(CLIModels.resolve(selected: "opus", in: CLIModels.claudeChoices), "opus")
        XCTAssertEqual(CLIModels.resolve(selected: "gpt-5", in: CLIModels.claudeChoices), "sonnet", "목록에 없으면 기본")
    }

    let arrayJSON = """
    [{"slug":"gpt-6-luna","display_name":"GPT-6 Luna","visibility":"list","default_reasoning_level":"medium"},
     {"slug":"gpt-6-astra","display_name":"GPT-6 Astra","visibility":"hide"},
     {"slug":"gpt-5.6-terra","display_name":"GPT-5.6 Terra","visibility":"list"},
     {"slug":"gpt-5.6-luna","visibility":"list"}]
    """

    func testOnlyVisibleListModelsInOrderAndFirstIsDefault() {
        let m = CLIModels.parseCodexModels(arrayJSON)
        XCTAssertEqual(m.map(\.id), ["gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-luna"])
        XCTAssertEqual(m[0].label, "GPT-6 Luna")
        XCTAssertEqual(m[2].label, "gpt-5.6-luna", "표시 이름이 없으면 슬러그")
        XCTAssertEqual(CLIModels.resolve(selected: nil, in: m), "gpt-6-luna")
        XCTAssertEqual(CLIModels.resolve(selected: "gpt-5.6-terra", in: m), "gpt-5.6-terra")
        XCTAssertEqual(CLIModels.resolve(selected: "사라진모델", in: m), "gpt-6-luna")
    }

    func testObjectWrapperAndLeadingNoise() {
        let wrapped = "{\"models\":" + arrayJSON + "}"
        XCTAssertEqual(CLIModels.parseCodexModels(wrapped).count, 3)
        XCTAssertEqual(CLIModels.parseCodexModels("warning: something\n" + arrayJSON).count, 3)
    }

    func testUnreadableGivesEmptyListAndNoDefault() {
        for bad in ["", "not json", "[]", "{}", "{\"a\":1}", "[1,2,3]", "[{\"slug\":\"x\"}]"] {
            XCTAssertEqual(CLIModels.parseCodexModels(bad), [], bad)
        }
        XCTAssertNil(CLIModels.resolve(selected: "x", in: []))
        XCTAssertEqual(CLIModels.codexLoadFailureNote, "설정에서 로그인 뒤 다시 불러와요")
    }

    func testUnsafeAndDuplicateSlugsAreDropped() {
        let j = #"[{"slug":"-bad","visibility":"list"},{"slug":"ok","visibility":"list"},{"slug":"ok","visibility":"list"},{"slug":"a b","visibility":"list"}]"#
        XCTAssertEqual(CLIModels.parseCodexModels(j).map(\.id), ["ok"])
    }
}
