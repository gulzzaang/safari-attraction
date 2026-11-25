import XCTest
@testable import AppCore

final class AppSettingsStoreTests: XCTestCase {
    func tempDir() -> URL {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("settings-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: u) }
        return u
    }

    func testDefaultsWhenNoFile() {
        let s = AppSettingsStore(directory: tempDir())
        XCTAssertEqual(s.current, AppSettings(selectedCLI: "claude", models: [:]))
    }

    func testSaveAndLoadAgain() throws {
        let dir = tempDir()
        let s = AppSettingsStore(directory: dir)
        try s.update { $0.selectedCLI = "chatgpt"; $0.models["chatgpt"] = "gpt-6-luna"; $0.models["claude"] = "opus" }
        let again = AppSettingsStore(directory: dir)
        XCTAssertEqual(again.current.selectedCLI, "chatgpt")
        XCTAssertEqual(again.current.models, ["chatgpt": "gpt-6-luna", "claude": "opus"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("settings.json").path))
    }

    func testCorruptFileGivesDefaultsAndIsBackedUpBeforeOverwrite() throws {
        let dir = tempDir()
        let file = dir.appendingPathComponent("settings.json")
        try Data("{깨진".utf8).write(to: file)
        let s = AppSettingsStore(directory: dir)
        XCTAssertEqual(s.current.selectedCLI, "claude")
        try s.update { $0.selectedCLI = "chatgpt" }
        XCTAssertEqual(try String(contentsOf: dir.appendingPathComponent("settings.json.bak"), encoding: .utf8), "{깨진")
        XCTAssertEqual(AppSettingsStore(directory: dir).current.selectedCLI, "chatgpt")
    }

    func testNothingElseIsWrittenButTheSettingsFile() throws {
        let dir = tempDir()
        try AppSettingsStore(directory: dir).update { $0.models["claude"] = "haiku" }
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        XCTAssertEqual(names, ["settings.json"])
    }

    func testOldKeysIgnoredAndEffortsDefaultEmpty() throws {
        let dir = tempDir()
        let raw = """
        {
          "selectedCLI": "gemini",
          "models": { "gemini": "gemini-4-neon-xhigh" },
          "agyMode": "isolated",
          "webSearch": true,
          "attachPage": true
        }
        """
        try Data(raw.utf8).write(to: dir.appendingPathComponent("settings.json"))
        let store = AppSettingsStore(directory: dir)
        XCTAssertEqual(store.current.selectedCLI, "gemini")
        XCTAssertEqual(store.current.models["gemini"], "gemini-4-neon-xhigh")
        XCTAssertEqual(store.current.efforts, [:])
        // 깨진 파일로 보지 않으므로 저장해도 백업이 생기지 않는다.
        try store.update { $0.efforts["claude"] = "high" }
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("settings.json.bak").path))
        XCTAssertEqual(AppSettingsStore(directory: dir).current.efforts, ["claude": "high"])
        let savedText = try String(contentsOf: dir.appendingPathComponent("settings.json"), encoding: .utf8)
        XCTAssertFalse(savedText.contains("agyMode"), "옛 설정 키 agyMode 는 다시 저장하지 않는다")
    }
}
