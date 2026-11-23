import XCTest
@testable import AppCore

final class SiteModeStoreTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("sm-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    private var file: URL { dir.appendingPathComponent("site-modes.json") }
    private var bak: URL { dir.appendingPathComponent("site-modes.json.bak") }

    func testUnknownHostIsAsk() {
        let s = SiteModeStore(directory: dir)
        XCTAssertEqual(s.mode(for: "www.coupang.com"), .ask)
        XCTAssertEqual(s.mode(for: ""), .ask)
    }

    func testSetAndGetRoundTripAcrossInstances() throws {
        let s = SiteModeStore(directory: dir)
        try s.setMode(.readOnly, for: "www.coupang.com")
        try s.setMode(.allowAll, for: "example.org")
        XCTAssertEqual(s.mode(for: "www.coupang.com"), .readOnly)
        let s2 = SiteModeStore(directory: dir)
        XCTAssertEqual(s2.mode(for: "www.coupang.com"), .readOnly)
        XCTAssertEqual(s2.mode(for: "example.org"), .allowAll)
        XCTAssertEqual(s2.mode(for: "other.com"), .ask)
    }

    func testHostKeysAreLowercasedAndTrimmed() throws {
        let s = SiteModeStore(directory: dir)
        try s.setMode(.allowAll, for: "  WWW.Coupang.COM. ")
        XCTAssertEqual(s.mode(for: "www.coupang.com"), .allowAll)
        XCTAssertEqual(s.mode(for: "WWW.COUPANG.COM"), .allowAll)
        let text = try String(contentsOf: file, encoding: .utf8)
        XCTAssertTrue(text.contains("\"www.coupang.com\""))
        XCTAssertFalse(text.contains("COUPANG"))
    }

    func testSettingBackToAskKeepsAnExplicitEntryButReadsAsAsk() throws {
        let s = SiteModeStore(directory: dir)
        try s.setMode(.readOnly, for: "a.com")
        try s.setMode(.ask, for: "a.com")
        XCTAssertEqual(SiteModeStore(directory: dir).mode(for: "a.com"), .ask)
    }

    func testEmptyHostIsRejected() {
        let s = SiteModeStore(directory: dir)
        XCTAssertThrowsError(try s.setMode(.allowAll, for: "  "))
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    func testCorruptFileIsEmptyAndBackedUpBeforeOverwrite() throws {
        let junk = Data("{ not json ]".utf8)
        try junk.write(to: file)
        let s = SiteModeStore(directory: dir)
        XCTAssertEqual(s.mode(for: "a.com"), .ask, "깨진 파일은 빈 것으로")
        XCTAssertEqual(try Data(contentsOf: file), junk, "읽기만으로는 파일을 건드리지 않는다")
        try s.setMode(.readOnly, for: "a.com")
        XCTAssertEqual(try Data(contentsOf: bak), junk, "덮어쓰기 전에 .bak 으로 남긴다")
        XCTAssertEqual(SiteModeStore(directory: dir).mode(for: "a.com"), .readOnly)
    }

    func testWrongShapeOrUnknownModeValuesAreIgnored() throws {
        try Data("[1,2,3]".utf8).write(to: file)
        XCTAssertEqual(SiteModeStore(directory: dir).mode(for: "a.com"), .ask)
        try Data(#"{"a.com":"readOnly","b.com":"zzz","c.com":7}"#.utf8).write(to: file)
        let s = SiteModeStore(directory: dir)
        XCTAssertEqual(s.mode(for: "a.com"), .readOnly)
        XCTAssertEqual(s.mode(for: "b.com"), .ask)
        XCTAssertEqual(s.mode(for: "c.com"), .ask)
    }

    func testCleanFileDoesNotCreateABackup() throws {
        let s = SiteModeStore(directory: dir)
        try s.setMode(.readOnly, for: "a.com")
        try s.setMode(.allowAll, for: "b.com")
        XCTAssertFalse(FileManager.default.fileExists(atPath: bak.path))
    }

    func testMissingDirectoryIsCreatedOnWrite() throws {
        let nested = dir.appendingPathComponent("deep/er", isDirectory: true)
        let s = SiteModeStore(directory: nested)
        try s.setMode(.readOnly, for: "a.com")
        XCTAssertEqual(SiteModeStore(directory: nested).mode(for: "a.com"), .readOnly)
    }

    func testConcurrentWritesDoNotLoseEntries() throws {
        let s = SiteModeStore(directory: dir)
        DispatchQueue.concurrentPerform(iterations: 20) { i in
            try? s.setMode(.allowAll, for: "h\(i).com")
        }
        let s2 = SiteModeStore(directory: dir)
        for i in 0..<20 { XCTAssertEqual(s2.mode(for: "h\(i).com"), .allowAll) }
    }

    func testRawValuesAreStableOnDisk() {
        XCTAssertEqual(SiteMode.readOnly.rawValue, "readOnly")
        XCTAssertEqual(SiteMode.ask.rawValue, "ask")
        XCTAssertEqual(SiteMode.allowAll.rawValue, "allowAll")
    }
}
