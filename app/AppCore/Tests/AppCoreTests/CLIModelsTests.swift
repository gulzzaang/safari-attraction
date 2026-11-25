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
        XCTAssertEqual(CLIModels.codexLoadFailureNote, "모델 목록을 못 불러왔어요 — 로그인했는지, codex 가 최신인지 확인해 주세요(지금은 기본 모델로 물어요)")
    }

    func testUnsafeAndDuplicateSlugsAreDropped() {
        let j = #"[{"slug":"-bad","visibility":"list"},{"slug":"ok","visibility":"list"},{"slug":"ok","visibility":"list"},{"slug":"a b","visibility":"list"}]"#
        XCTAssertEqual(CLIModels.parseCodexModels(j).map(\.id), ["ok"])
    }

    func testAgyFamilies27ModelsAndSplitAndModelID() {
        let ids = [
            "gemini-4-neon-low", "gemini-4-neon-medium", "gemini-4-neon-high", "gemini-4-neon-xhigh",
            "gemini-4-carbon-low", "gemini-4-carbon-medium", "gemini-4-carbon-high",
            "gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high",
            "gemini-4-hydrogen-low", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-high", "gemini-4-hydrogen-xhigh",
            "gemini-pro-orchestrator-neon", "gemini-pro-orchestrator", "gemini-pro-orchestrator-argon",
            "gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high",
            "claude-opus-5-5-low", "claude-opus-5-5-medium", "claude-opus-5-5-high",
            "claude-sonnet-5-5-low", "claude-sonnet-5-5-medium", "claude-sonnet-5-5-high",
            "gpt-oss-120b-medium",
        ]
        XCTAssertEqual(ids.count, 27)
        let families = CLIModels.agyFamilies(ids)
        XCTAssertEqual(families.map(\.base), [
            "gemini-4-neon", "gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen",
            "gemini-pro-orchestrator-neon", "gemini-pro-orchestrator", "gemini-pro-orchestrator-argon",
            "gemini-3.8-flash", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-oss-120b",
        ])
        XCTAssertEqual(families.first { $0.base == "gemini-4-neon" }?.levels, ["low", "medium", "high", "xhigh"])
        XCTAssertEqual(families.first { $0.base == "gemini-pro-orchestrator" }?.levels, [])
        XCTAssertEqual(families.first { $0.base == "gpt-oss-120b" }?.levels, ["medium"])

        // agyModelID 기본 단계 규칙: nil 이면 medium 우선, 없으면 첫 단계, 단계 없으면 base
        let neon = families.first { $0.base == "gemini-4-neon" }!
        XCTAssertEqual(CLIModels.agyModelID(family: neon, level: "xhigh"), "gemini-4-neon-xhigh")
        XCTAssertEqual(CLIModels.agyModelID(family: neon, level: nil), "gemini-4-neon-medium")
        let noMed = AgyFamily(base: "m", levels: ["low", "high"])
        XCTAssertEqual(CLIModels.agyModelID(family: noMed, level: nil), "m-low")
        let noLevels = families.first { $0.base == "gemini-pro-orchestrator" }!
        XCTAssertEqual(CLIModels.agyModelID(family: noLevels, level: nil), "gemini-pro-orchestrator")
        XCTAssertEqual(CLIModels.agyModelID(family: noLevels, level: "high"), "gemini-pro-orchestrator")

        let split1 = CLIModels.agySplit("gemini-4-neon-xhigh")
        XCTAssertEqual(split1.base, "gemini-4-neon")
        XCTAssertEqual(split1.level, "xhigh")
        let split2 = CLIModels.agySplit("gemini-pro-orchestrator")
        XCTAssertEqual(split2.base, "gemini-pro-orchestrator")
        XCTAssertNil(split2.level)
    }

    func testParseCodexEffortsAndEffortChoices() {
        let cache = """
        {
          "models": [
            {
              "slug": "gpt-6-luna",
              "supported_reasoning_levels": [
                {"effort": "low", "description": "fast"},
                {"effort": "medium", "description": "balanced"},
                {"effort": "high", "description": "deep"},
                {"effort": "xhigh", "description": "extra"},
                {"effort": "max", "description": "max"}
              ]
            },
            {
              "slug": "gpt-5.6-terra",
              "supported_reasoning_levels": [
                {"effort": "low"},
                {"effort": "ultra"}
              ]
            }
          ]
        }
        """
        let efforts = CLIModels.parseCodexEfforts(Data(cache.utf8))
        XCTAssertEqual(efforts["gpt-6-luna"], ["low", "medium", "high", "xhigh", "max"])
        XCTAssertEqual(efforts["gpt-5.6-terra"], ["low", "ultra"])
        XCTAssertEqual(CLIModels.parseCodexEfforts(Data("bad".utf8)), [:])

        let agyFams = CLIModels.agyFamilies(["gemini-4-neon-low", "gemini-4-neon-xhigh", "gemini-pro-orchestrator"])
        XCTAssertEqual(CLIModels.effortChoices(kind: .claude, modelID: "sonnet", codexEfforts: efforts, agyFamilies: agyFams),
                       ["low", "medium", "high", "xhigh", "max"])
        XCTAssertEqual(CLIModels.effortChoices(kind: .chatgpt, modelID: "gpt-6-luna", codexEfforts: efforts, agyFamilies: agyFams),
                       ["low", "medium", "high", "xhigh", "max"])
        XCTAssertEqual(CLIModels.effortChoices(kind: .chatgpt, modelID: "unknown", codexEfforts: efforts, agyFamilies: agyFams),
                       ["low", "medium", "high"])
        XCTAssertEqual(CLIModels.effortChoices(kind: .gemini, modelID: "gemini-4-neon-low", codexEfforts: efforts, agyFamilies: agyFams),
                       ["low", "xhigh"])
        XCTAssertEqual(CLIModels.effortChoices(kind: .gemini, modelID: "gemini-pro-orchestrator", codexEfforts: efforts, agyFamilies: agyFams),
                       [])
        XCTAssertEqual(CLIModels.effortChoices(kind: .opencode, modelID: "opencode-go/deepseek-v4.1-flash", codexEfforts: efforts, agyFamilies: agyFams),
                       ["low", "medium", "high", "xhigh", "max"])
    }
}
