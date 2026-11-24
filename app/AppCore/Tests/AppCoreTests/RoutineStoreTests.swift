import XCTest
@testable import AppCore

final class RoutineStoreTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("rs-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    private var file: URL { dir.appendingPathComponent("routines.json") }
    private var bak: URL { dir.appendingPathComponent("routines.json.bak") }
    private var historyFile: URL { dir.appendingPathComponent("routines/history.jsonl") }
    private var historyBak: URL { dir.appendingPathComponent("routines/history.jsonl.bak") }

    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    private func makeRoutine(_ task: SavedTask, sites: [String] = ["coupang.com"], schedule: RoutineSchedule = .daily(hour: 9, minute: 0)) -> Routine {
        Routine(taskID: task.id, schedule: schedule, sites: sites, enabled: true, lastRun: nil, createdAt: t0)
    }
    private func record(_ i: Int, answer: String = "답", routine: UUID = UUID()) -> RoutineRecord {
        RoutineRecord(at: t0.addingTimeInterval(Double(i)), routineID: routine, name: "일 \(i)", status: RoutineRecord.statusDone, answer: answer)
    }

    // 저장한 일 · 루틴

    func testEmptyStoreHasNothingAndWritesNothing() {
        let s = RoutineStore(directory: dir)
        XCTAssertEqual(s.savedTasks, [])
        XCTAssertEqual(s.routines, [])
        XCTAssertEqual(s.history(), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    func testSavedTaskAndRoutineRoundTripAcrossInstances() throws {
        let s = RoutineStore(directory: dir)
        let task = try s.upsertSavedTask(SavedTask(name: "쿠팡 사과", text: "쿠팡에서 사과 값 알려 줘"))
        var r = makeRoutine(task, schedule: .weekdays([2, 4], hour: 8, minute: 15))
        r.lastRun = t0.addingTimeInterval(60)
        try s.upsertRoutine(r)
        let s2 = RoutineStore(directory: dir)
        XCTAssertEqual(s2.savedTasks, [task])
        XCTAssertEqual(s2.routines, [r])
        XCTAssertEqual(s2.routine(id: r.id)?.schedule, .weekdays([2, 4], hour: 8, minute: 15))
        XCTAssertEqual(s2.savedTask(id: task.id)?.name, "쿠팡 사과")
    }

    func testUpsertReplacesSameIdAndKeepsOrder() throws {
        let s = RoutineStore(directory: dir)
        let a = try s.upsertSavedTask(SavedTask(name: "a", text: "A"))
        let b = try s.upsertSavedTask(SavedTask(name: "b", text: "B"))
        var a2 = a; a2.text = "A 고침"
        try s.upsertSavedTask(a2)
        XCTAssertEqual(s.savedTasks.map(\.id), [a.id, b.id])
        XCTAssertEqual(s.savedTasks.first?.text, "A 고침")
    }

    func testNameIsTrimmedAndEmptyNameOrTextRejected() throws {
        let s = RoutineStore(directory: dir)
        XCTAssertEqual(try s.upsertSavedTask(SavedTask(name: "  이름  ", text: "내용")).name, "이름")
        XCTAssertThrowsError(try s.upsertSavedTask(SavedTask(name: "  ", text: "내용"))) { XCTAssertEqual($0 as? RoutineStoreError, .emptyName) }
        XCTAssertThrowsError(try s.upsertSavedTask(SavedTask(name: "이름2", text: " \n "))) { XCTAssertEqual($0 as? RoutineStoreError, .emptyText) }
        XCTAssertEqual(s.savedTasks.count, 1)
    }

    func testRoutineNeedsAnExistingTaskAndSitesAreCleaned() throws {
        let s = RoutineStore(directory: dir)
        let ghost = SavedTask(name: "없음", text: "x")
        XCTAssertThrowsError(try s.upsertRoutine(makeRoutine(ghost))) { XCTAssertEqual($0 as? RoutineStoreError, .unknownTask) }
        let task = try s.upsertSavedTask(SavedTask(name: "t", text: "x"))
        let saved = try s.upsertRoutine(makeRoutine(task, sites: [" Coupang.COM. ", "coupang.com", "", "naver.com"]))
        XCTAssertEqual(saved.sites, ["coupang.com", "naver.com"])
        XCTAssertEqual(s.routines.first?.sites, ["coupang.com", "naver.com"])
    }

    func testSitesDropBareWordsAndPublicSuffixes() throws {
        let s = RoutineStore(directory: dir)
        let task = try s.upsertSavedTask(SavedTask(name: "t", text: "x"))
        let saved = try s.upsertRoutine(makeRoutine(task, sites: ["co.kr", "com", "CO.UK.", "shop.co.kr", "localhost", "naver.com"]))
        XCTAssertEqual(saved.sites, ["shop.co.kr", "naver.com"])
        let updated = try s.updateRoutine(id: saved.id) { $0.sites = ["com", "a.com"] }
        XCTAssertEqual(updated.sites, ["a.com"])
    }

    func testLastHandledIsSavedSeparatelyFromLastRunAndOldFilesStillLoad() throws {
        let s = RoutineStore(directory: dir)
        let task = try s.upsertSavedTask(SavedTask(name: "t", text: "x"))
        let r = try s.upsertRoutine(makeRoutine(task))
        XCTAssertNil(r.lastHandled)
        let handled = t0.addingTimeInterval(9 * 3600)
        try s.updateRoutine(id: r.id) { $0.lastHandled = handled }   // 건너뜀: lastRun 은 그대로
        let back = RoutineStore(directory: dir).routine(id: r.id)
        XCTAssertEqual(back?.lastHandled, handled)
        XCTAssertNil(back?.lastRun)
        // lastHandled 키가 없던 예전 파일도 읽힌다.
        var obj = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        var routines = obj["routines"] as! [[String: Any]]
        routines[0].removeValue(forKey: "lastHandled")
        obj["routines"] = routines
        try JSONSerialization.data(withJSONObject: obj).write(to: file)
        XCTAssertEqual(RoutineStore(directory: dir).routines.count, 1)
        XCTAssertNil(RoutineStore(directory: dir).routines.first?.lastHandled)
    }

    func testUpdateRoutineChangesOneFieldAndKeepsTheRest() throws {
        let s = RoutineStore(directory: dir)
        let task = try s.upsertSavedTask(SavedTask(name: "t", text: "x"))
        let r = try s.upsertRoutine(makeRoutine(task))
        let ran = t0.addingTimeInterval(3600)
        let out = try s.updateRoutine(id: r.id) { $0.lastRun = ran }
        XCTAssertEqual(out.lastRun, ran)
        XCTAssertEqual(RoutineStore(directory: dir).routine(id: r.id)?.lastRun, ran)
        XCTAssertEqual(RoutineStore(directory: dir).routine(id: r.id)?.sites, ["coupang.com"])
        XCTAssertThrowsError(try s.updateRoutine(id: UUID()) { $0.enabled = false }) { XCTAssertEqual($0 as? RoutineStoreError, .unknownRoutine) }
    }

    func testRemovingATaskRemovesItsRoutinesOnly() throws {
        let s = RoutineStore(directory: dir)
        let a = try s.upsertSavedTask(SavedTask(name: "a", text: "A"))
        let b = try s.upsertSavedTask(SavedTask(name: "b", text: "B"))
        let ra = try s.upsertRoutine(makeRoutine(a))
        let rb = try s.upsertRoutine(makeRoutine(b))
        try s.removeSavedTask(id: a.id)
        XCTAssertEqual(s.savedTasks.map(\.id), [b.id])
        XCTAssertEqual(s.routines.map(\.id), [rb.id])
        XCTAssertNil(s.routine(id: ra.id))
        XCTAssertEqual(RoutineStore(directory: dir).routines.map(\.id), [rb.id])
        try s.removeSavedTask(id: UUID())   // 없는 것을 지워도 괜찮다
    }

    func testRemoveRoutineKeepsTaskAndHistory() throws {
        let s = RoutineStore(directory: dir)
        let a = try s.upsertSavedTask(SavedTask(name: "a", text: "A"))
        let r = try s.upsertRoutine(makeRoutine(a))
        try s.appendHistory(record(1, routine: r.id))
        try s.removeRoutine(id: r.id)
        XCTAssertEqual(s.routines, [])
        XCTAssertEqual(s.savedTasks.count, 1)
        XCTAssertEqual(s.history().count, 1)
        try s.removeRoutine(id: r.id)
    }

    func testWrittenFileIsWellFormedAndDatesAreIso() throws {
        let s = RoutineStore(directory: dir)
        let task = try s.upsertSavedTask(SavedTask(name: "t", text: "x"))
        try s.upsertRoutine(makeRoutine(task))
        let obj = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        XCTAssertNotNil(obj?["savedTasks"] as? [Any])
        let routine = (obj?["routines"] as? [[String: Any]])?.first
        XCTAssertTrue((routine?["createdAt"] as? String)?.hasPrefix("2027-") ?? false)
        XCTAssertEqual(routine?["enabled"] as? Bool, true)
    }

    func testMissingDirectoryIsCreatedOnWrite() throws {
        let nested = dir.appendingPathComponent("deep/er", isDirectory: true)
        let s = RoutineStore(directory: nested)
        let task = try s.upsertSavedTask(SavedTask(name: "t", text: "x"))
        try s.appendHistory(record(1))
        XCTAssertEqual(RoutineStore(directory: nested).savedTasks, [task])
        XCTAssertEqual(RoutineStore(directory: nested).history().count, 1)
    }

    func testNoTemporaryFilesLeftBehind() throws {
        let s = RoutineStore(directory: dir)
        _ = try s.upsertSavedTask(SavedTask(name: "t", text: "x"))
        try s.appendHistory(record(1))
        let top = try FileManager.default.contentsOfDirectory(atPath: dir.path).sorted()
        XCTAssertEqual(top, ["routines", "routines.json"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("routines").path), ["history.jsonl"])
    }

    func testConcurrentWritesDoNotLoseEntries() throws {
        let s = RoutineStore(directory: dir)
        DispatchQueue.concurrentPerform(iterations: 20) { i in
            _ = try? s.upsertSavedTask(SavedTask(name: "t\(i)", text: "x"))
            try? s.appendHistory(record(i))
        }
        XCTAssertEqual(RoutineStore(directory: dir).savedTasks.count, 20)
        XCTAssertEqual(RoutineStore(directory: dir).history().count, 20)
    }

    // 깨진 파일 · 못 읽는 파일

    func testCorruptFileIsEmptyAndBackedUpBeforeOverwrite() throws {
        let junk = Data("{ not json ]".utf8)
        try junk.write(to: file)
        let s = RoutineStore(directory: dir)
        XCTAssertEqual(s.savedTasks, [])
        XCTAssertEqual(s.routines, [])
        XCTAssertEqual(try Data(contentsOf: file), junk, "읽기만으로는 파일을 건드리지 않는다")
        let task = try s.upsertSavedTask(SavedTask(name: "t", text: "x"))
        XCTAssertEqual(try Data(contentsOf: bak), junk, "덮어쓰기 전에 .bak 으로 남긴다")
        XCTAssertEqual(RoutineStore(directory: dir).savedTasks, [task])
    }

    func testWrongShapeFileIsTreatedAsCorrupt() throws {
        try Data("[1,2,3]".utf8).write(to: file)
        let s = RoutineStore(directory: dir)
        XCTAssertEqual(s.savedTasks, [])
        try s.upsertSavedTask(SavedTask(name: "t", text: "x"))
        XCTAssertEqual(try Data(contentsOf: bak), Data("[1,2,3]".utf8))
    }

    func testUnreadableFileIsEmptyAndNeverOverwrittenWithoutABackup() throws {
        let seed = RoutineStore(directory: dir)
        let task = try seed.upsertSavedTask(SavedTask(name: "원래", text: "x"))
        let original = try Data(contentsOf: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: file.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path) }
        let s = RoutineStore(directory: dir)
        XCTAssertEqual(s.savedTasks, [], "못 읽었으면 빈 것으로")
        XCTAssertThrowsError(try s.upsertSavedTask(SavedTask(name: "새것", text: "y")))
        XCTAssertEqual(s.savedTasks, [], "실패하면 메모리도 바뀌지 않는다")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
        try s.upsertSavedTask(SavedTask(name: "새것", text: "y"))
        XCTAssertEqual(try Data(contentsOf: bak), original)
        XCTAssertNotEqual(task.id, s.savedTasks.first?.id)
    }

    func testCleanFileDoesNotCreateABackup() throws {
        let s = RoutineStore(directory: dir)
        try s.upsertSavedTask(SavedTask(name: "a", text: "A"))
        try s.upsertSavedTask(SavedTask(name: "b", text: "B"))
        try s.appendHistory(record(1))
        XCTAssertFalse(FileManager.default.fileExists(atPath: bak.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: historyBak.path))
    }

    // 기록

    func testHistoryIsNewestFirstAndLimited() throws {
        let s = RoutineStore(directory: dir)
        for i in 1...5 { try s.appendHistory(record(i)) }
        XCTAssertEqual(s.history().map(\.name), ["일 5", "일 4", "일 3", "일 2", "일 1"])
        XCTAssertEqual(s.history(limit: 2).map(\.name), ["일 5", "일 4"])
        XCTAssertEqual(s.history(limit: 0), [])
        XCTAssertEqual(RoutineStore(directory: dir).history(limit: 3).map(\.name), ["일 5", "일 4", "일 3"])
    }

    func testHistoryKeepsOnlyTheLast200() throws {
        let s = RoutineStore(directory: dir)
        for i in 1...201 { try s.appendHistory(record(i)) }
        let h = s.history()
        XCTAssertEqual(h.count, 200)
        XCTAssertEqual(h.first?.name, "일 201")
        XCTAssertEqual(h.last?.name, "일 2", "가장 오래된 1개가 밀려난다")
        let lines = try String(contentsOf: historyFile, encoding: .utf8).split(separator: "\n")
        XCTAssertEqual(lines.count, 200)
        XCTAssertEqual(RoutineStore(directory: dir).history().count, 200)
    }

    func testExactly200IsKept() throws {
        let s = RoutineStore(directory: dir)
        for i in 1...200 { try s.appendHistory(record(i)) }
        XCTAssertEqual(s.history().count, 200)
        XCTAssertEqual(s.history().last?.name, "일 1")
    }

    func testAnswerIsCutAt4000Characters() throws {
        let s = RoutineStore(directory: dir)
        try s.appendHistory(record(1, answer: String(repeating: "가", count: 4001)))
        try s.appendHistory(record(2, answer: String(repeating: "나", count: 4000)))
        try s.appendHistory(record(3, answer: "짧음"))
        let h = s.history()
        XCTAssertEqual(h[2].answer.count, 4000)
        XCTAssertEqual(h[2].answer, String(repeating: "가", count: 4000))
        XCTAssertEqual(h[1].answer.count, 4000)
        XCTAssertEqual(h[0].answer, "짧음")
        XCTAssertEqual(RoutineStore(directory: dir).history()[2].answer.count, 4000)
    }

    func testHistoryFileIsOneJsonObjectPerLineEvenWithNewlinesInTheAnswer() throws {
        let s = RoutineStore(directory: dir)
        try s.appendHistory(record(1, answer: "첫 줄\n둘째 줄\n\n"))
        try s.appendHistory(record(2, answer: "x"))
        let lines = try String(contentsOf: historyFile, encoding: .utf8).split(separator: "\n")
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(RoutineStore(directory: dir).history().last?.answer, "첫 줄\n둘째 줄\n\n")
    }

    func testHistoryFieldsRoundTrip() throws {
        let id = UUID()
        let rec = RoutineRecord(at: t0, routineID: id, name: "쿠팡 사과", status: RoutineRecord.statusSkipped("사파리가 켜져 있지 않아 건너뛰었어요"), answer: "")
        try RoutineStore(directory: dir).appendHistory(rec)
        XCTAssertEqual(RoutineStore(directory: dir).history(), [rec])
        XCTAssertEqual(RoutineRecord.statusDone, "끝남")
        XCTAssertEqual(RoutineRecord.statusPartial, "일부만 됨")
        XCTAssertEqual(RoutineRecord.statusFailed, "실패")
    }

    func testCorruptHistoryLinesAreSkippedAndFileBackedUpBeforeRewrite() throws {
        let s0 = RoutineStore(directory: dir)
        try s0.appendHistory(record(1))
        try s0.appendHistory(record(2))
        var raw = try Data(contentsOf: historyFile)
        raw.append(Data("{ broken\n".utf8))
        try raw.write(to: historyFile)
        let s = RoutineStore(directory: dir)
        XCTAssertEqual(s.history().map(\.name), ["일 2", "일 1"], "깨진 줄만 건너뛴다")
        try s.appendHistory(record(3))
        XCTAssertEqual(try Data(contentsOf: historyBak), raw, "고쳐 쓰기 전에 .bak 으로 남긴다")
        XCTAssertEqual(RoutineStore(directory: dir).history().map(\.name), ["일 3", "일 2", "일 1"])
    }

    func testUnreadableHistoryIsEmptyAndBackedUp() throws {
        let s0 = RoutineStore(directory: dir)
        try s0.appendHistory(record(1))
        let original = try Data(contentsOf: historyFile)
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: historyFile.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: historyFile.path) }
        let s = RoutineStore(directory: dir)
        XCTAssertEqual(s.history(), [])
        XCTAssertThrowsError(try s.appendHistory(record(2)))
        XCTAssertEqual(s.history(), [])
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: historyFile.path)
        try s.appendHistory(record(2))
        XCTAssertEqual(try Data(contentsOf: historyBak), original)
    }
}
