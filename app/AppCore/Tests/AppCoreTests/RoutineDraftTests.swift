import XCTest
@testable import AppCore

final class RoutineDraftTests: XCTestCase {
    func testNewDraftExtractsSitesAndSelectsFirstAsDefaultAlertHost() {
        let taskID = UUID()
        var draft = RoutineDraft(taskID: taskID, taskText: "https://www.coupang.com 과 naver.com 확인해 줘")
        XCTAssertEqual(draft.sites, ["coupang.com", "naver.com"])
        XCTAssertEqual(draft.alertHost, "coupang.com")
        draft.setKind(.siteAlert)
        XCTAssertEqual(draft.schedule, .siteAlert(host: "coupang.com", keyword: nil))
    }

    func testSiteAlertScheduleTrimsKeywordAndNormalizesHost() {
        var draft = RoutineDraft(taskID: UUID(), taskText: "example.com 확인")
        draft.setKind(.siteAlert)
        draft.alertHost = "  Shop.Example.COM. "
        draft.alertKeyword = "  세일  "
        XCTAssertEqual(draft.schedule, .siteAlert(host: "shop.example.com", keyword: "세일"))

        draft.alertKeyword = "   \n\t "
        XCTAssertEqual(draft.schedule, .siteAlert(host: "shop.example.com", keyword: nil))
    }

    func testRoundTripFromExistingSiteAlertRoutinePreservesSubdomainAndKeyword() {
        let routine = Routine(
            taskID: UUID(),
            schedule: .siteAlert(host: "mail.example.com", keyword: "긴급"),
            sites: ["example.com", "other.com"],
            enabled: true
        )
        let draft = RoutineDraft(routine)
        XCTAssertEqual(draft.kind, .siteAlert)
        XCTAssertEqual(draft.alertHost, "mail.example.com")
        XCTAssertEqual(draft.alertKeyword, "긴급")
        XCTAssertEqual(draft.schedule, .siteAlert(host: "mail.example.com", keyword: "긴급"))
        XCTAssertEqual(draft.alertHostOptions, ["mail.example.com", "example.com", "other.com"])
        XCTAssertTrue(draft.isAlertHostAllowed)
    }

    func testRemovingAndAddingSitesReconcilesAlertHost() {
        var draft = RoutineDraft(taskID: UUID(), taskText: "a.com 과 b.com")
        draft.setKind(.siteAlert)
        XCTAssertEqual(draft.alertHost, "a.com")

        draft.removeSite("a.com")
        XCTAssertEqual(draft.sites, ["b.com"])
        XCTAssertEqual(draft.alertHost, "b.com")

        draft.removeSite("b.com")
        XCTAssertEqual(draft.sites, [])
        XCTAssertEqual(draft.alertHost, "")
        XCTAssertFalse(draft.isAlertHostAllowed)

        draft.addSite("c.com")
        XCTAssertEqual(draft.sites, ["c.com"])
        XCTAssertEqual(draft.alertHost, "c.com")
        XCTAssertTrue(draft.isAlertHostAllowed)
    }

    func testTaskChangeAndResetSitesUpdateAlertHostWhenUnedited() {
        var draft = RoutineDraft(taskID: UUID(), taskText: "first.com 확인")
        draft.setKind(.siteAlert)
        XCTAssertEqual(draft.alertHost, "first.com")

        draft.applyTaskChange(taskID: UUID(), taskText: "second.com 확인")
        XCTAssertEqual(draft.sites, ["second.com"])
        XCTAssertEqual(draft.alertHost, "second.com")

        draft.addSite("manual.com")
        draft.applyTaskChange(taskID: UUID(), taskText: "third.com 확인")
        XCTAssertEqual(draft.sites, ["second.com", "manual.com"], "손댄 목록은 일을 바꿔도 덮어쓰지 않는다")

        draft.resetSites(from: "third.com 확인")
        XCTAssertEqual(draft.sites, ["third.com"])
        XCTAssertEqual(draft.alertHost, "third.com")
    }

    func testSwitchingToSiteAlertReconcilesStaleHost() {
        let routine = Routine(
            taskID: UUID(),
            schedule: .daily(hour: 9, minute: 0),
            sites: ["example.com"],
            enabled: true
        )
        var draft = RoutineDraft(routine)
        draft.alertHost = "outside.com"
        draft.setKind(.siteAlert)
        XCTAssertEqual(draft.alertHost, "example.com")
    }

    func testSaveErrorMessageForAlertHostOutsideSitesMatchesSpec() {
        XCTAssertEqual(
            RoutineDraft.saveErrorMessage(for: RoutineStoreError.alertHostOutsideSites),
            "알림을 볼 사이트는 갈 수 있는 사이트 안에 있어야 해요"
        )
        XCTAssertTrue(RoutineDraft.saveErrorMessage(for: RoutineStoreError.unknownTask).hasPrefix("저장하지 못했어요 — "))
    }

    func testSiteAlertHintMatchesSpec() {
        XCTAssertEqual(
            RoutineDraft.siteAlertHint,
            "사파리에서 그 사이트 탭이 열려 있고 확장이 켜져 있을 때만 알아채요 — 탭 밖에서 오는 푸시 알림은 못 봐요"
        )
    }

    func testSavingSiteAlertOutsideSitesThroughStoreThrowsExpectedMessage() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rdraft-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let store = RoutineStore(directory: dir)
        let task = try store.upsertSavedTask(SavedTask(name: "알림", text: "글에 주소 없음"))
        var draft = RoutineDraft(taskID: task.id, taskText: task.text)
        draft.setKind(.siteAlert)
        XCTAssertTrue(draft.canSave)

        let routine = Routine(taskID: task.id, schedule: draft.schedule, sites: draft.sites, enabled: draft.enabled)
        do {
            _ = try store.saveRoutine(routine, now: Date())
            XCTFail("사이트 목록이 비어 있으므로 alertHostOutsideSites 가 나야 한다")
        } catch {
            XCTAssertEqual(RoutineDraft.saveErrorMessage(for: error), "알림을 볼 사이트는 갈 수 있는 사이트 안에 있어야 해요")
        }
    }
}
