import XCTest
@testable import AppCore

final class AppUpdateTests: XCTestCase {
    private func fixtureData() throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "github-releases-sample", withExtension: "json", subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    func testAppVersionParsingValidAndInvalid() {
        XCTAssertEqual(AppVersion("0.2.0")?.description, "0.2.0")
        XCTAssertEqual(AppVersion("1.10.3")?.description, "1.10.3")
        XCTAssertEqual(AppVersion("0.0.0")?.description, "0.0.0")

        let invalid = [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "v0.2.0",
            "app-v0.2.0",
            "0.2.x",
            "app-vx",
            "-1.0.0",
            "01.2.3",
            "0.02.0",
            "0.2.0 ",
            " 0.2.0",
            "1.+2.3",
            "1.2.3-rc1",
        ]
        for s in invalid {
            XCTAssertNil(AppVersion(s), "깨진 버전 문자열은 거절해야 한다: \(s)")
        }
    }

    func testAppVersionComparison() throws {
        let v020 = try XCTUnwrap(AppVersion("0.2.0"))
        let v021 = try XCTUnwrap(AppVersion("0.2.1"))
        let v0100 = try XCTUnwrap(AppVersion("0.10.0"))
        let v100 = try XCTUnwrap(AppVersion("1.0.0"))

        XCTAssertLessThan(v020, v021)
        XCTAssertLessThan(v021, v0100)
        XCTAssertLessThan(v0100, v100)
        XCTAssertFalse(v020 < v020)
        XCTAssertEqual(v020, AppVersion("0.2.0"))
    }

    func testPickLatestFiltersMixedDraftPrereleaseMissingAssetsAndBrokenTags() throws {
        let data = try fixtureData()
        let current = try XCTUnwrap(AppVersion("0.2.0"))

        let picked = AppUpdate.pickLatest(data, newerThan: current)
        let release = try XCTUnwrap(picked)
        XCTAssertEqual(release.version, AppVersion("0.3.0"))
        XCTAssertEqual(release.tag, "app-v0.3.0")
        XCTAssertEqual(release.zipURL.absoluteString,
                       "https://github.com/gulzzaang/safari-attraction/releases/download/app-v0.3.0/SafariAttractionApp-0.3.0.zip")
        XCTAssertEqual(release.sigURL.absoluteString,
                       "https://github.com/gulzzaang/safari-attraction/releases/download/app-v0.3.0/SafariAttractionApp-0.3.0.zip.sig")
        XCTAssertEqual(release.pageURL.absoluteString,
                       "https://github.com/gulzzaang/safari-attraction/releases/tag/app-v0.3.0")
    }

    func testPickLatestReturnsNilForSameOrHigherVersion() throws {
        let data = try fixtureData()
        XCTAssertNil(AppUpdate.pickLatest(data, newerThan: try XCTUnwrap(AppVersion("0.3.0"))))
        XCTAssertNil(AppUpdate.pickLatest(data, newerThan: try XCTUnwrap(AppVersion("0.4.0"))))
        XCTAssertNil(AppUpdate.pickLatest(Data("not json".utf8), newerThan: try XCTUnwrap(AppVersion("0.1.0"))))
    }

    func testPickLatestLocalhostOnlyAllowedWhenExplicitlyEnabled() throws {
        let json = """
        [
          {
            "tag_name": "app-v0.4.0",
            "draft": false,
            "prerelease": false,
            "html_url": "http://127.0.0.1:8080/releases/app-v0.4.0",
            "assets": [
              {
                "name": "SafariAttractionApp-0.4.0.zip",
                "browser_download_url": "http://127.0.0.1:8080/SafariAttractionApp-0.4.0.zip",
                "size": 100
              },
              {
                "name": "SafariAttractionApp-0.4.0.zip.sig",
                "browser_download_url": "http://127.0.0.1:8080/SafariAttractionApp-0.4.0.zip.sig",
                "size": 88
              }
            ]
          }
        ]
        """
        let data = Data(json.utf8)
        let current = try XCTUnwrap(AppVersion("0.2.0"))

        XCTAssertNil(AppUpdate.pickLatest(data, newerThan: current))
        let devPicked = AppUpdate.pickLatest(data, newerThan: current, allowLocalhostHTTP: true)
        XCTAssertEqual(devPicked?.version, AppVersion("0.4.0"))
    }
}
