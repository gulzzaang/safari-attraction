import XCTest
@testable import AppCore

final class SiteListTests: XCTestCase {
    func testExtractsHostFromUrlAndStripsWww() {
        XCTAssertEqual(SiteList.extractHosts(from: "쿠팡 https://www.coupang.com/np/search?q=a 에서 사과 값 알려 줘"), ["coupang.com"])
    }

    func testExtractsBareDomain() {
        XCTAssertEqual(SiteList.extractHosts(from: "naver.com 뉴스 읽어 줘"), ["naver.com"])
        XCTAssertEqual(SiteList.extractHosts(from: "naver.com에서 뉴스"), ["naver.com"])
    }

    func testDedupesKeepsFirstAppearanceOrderAndLowercases() {
        let t = "https://WWW.Coupang.com/a 그리고 naver.com 그리고 http://m.coupang.com/b 그리고 coupang.com, NAVER.COM."
        XCTAssertEqual(SiteList.extractHosts(from: t), ["coupang.com", "naver.com"])
    }

    func testKeepsOtherSubdomainsAndMultiPartTlds() {
        XCTAssertEqual(SiteList.extractHosts(from: "https://news.naver.com/x 와 www.bbc.co.uk"), ["news.naver.com", "bbc.co.uk"])
    }

    func testUrlPathAndQueryDoNotYieldExtraHosts() {
        XCTAssertEqual(SiteList.extractHosts(from: "https://a.com/redirect?to=evil.com&x=b.org/y"), ["a.com"])
    }

    func testPortIsDroppedAndEmailIsNotAHost() {
        XCTAssertEqual(SiteList.extractHosts(from: "http://shop.example.com:8080/x"), ["shop.example.com"])
        XCTAssertEqual(SiteList.extractHosts(from: "메일은 me@mail.example.com 으로"), [])
    }

    func testNoHostsInPlainTextFilesAndNumbers() {
        XCTAssertEqual(SiteList.extractHosts(from: ""), [])
        XCTAssertEqual(SiteList.extractHosts(from: "그냥 글이에요. 3.14 와 report.pdf 와 v1.2.3"), [])
    }

    func testWwwOrMAloneKeepsTheDomain() {
        XCTAssertEqual(SiteList.extractHosts(from: "www.com 과 m.org"), ["www.com", "m.org"])
    }

    // allows

    func testAllowsExactAndSubdomains() {
        let list = ["coupang.com"]
        XCTAssertTrue(SiteList.allows(host: "coupang.com", list: list))
        XCTAssertTrue(SiteList.allows(host: "www.coupang.com", list: list))
        XCTAssertTrue(SiteList.allows(host: "m.coupang.com", list: list))
        XCTAssertTrue(SiteList.allows(host: "a.b.coupang.com", list: list))
    }

    func testDoesNotAllowLookalikeOrParentDomains() {
        XCTAssertFalse(SiteList.allows(host: "evilcoupang.com", list: ["coupang.com"]))
        XCTAssertFalse(SiteList.allows(host: "coupang.com.evil.com", list: ["coupang.com"]))
        XCTAssertFalse(SiteList.allows(host: "coupang.co", list: ["coupang.com"]))
        XCTAssertFalse(SiteList.allows(host: "com", list: ["coupang.com"]))
        XCTAssertFalse(SiteList.allows(host: "coupang.com", list: ["www.coupang.com"]), "위 도메인은 아래 항목으로 허락되지 않는다")
    }

    func testCaseAndTrailingDotAreIgnored() {
        XCTAssertTrue(SiteList.allows(host: "WWW.Coupang.COM.", list: ["coupang.com"]))
        XCTAssertTrue(SiteList.allows(host: "m.coupang.com", list: ["Coupang.Com."]))
    }

    func testEmptyHostIsNeverAllowed() {
        XCTAssertFalse(SiteList.allows(host: "", list: ["coupang.com"]))
        XCTAssertFalse(SiteList.allows(host: "  ", list: ["coupang.com"]))
        XCTAssertFalse(SiteList.allows(host: ".", list: ["coupang.com", ""]))
        XCTAssertFalse(SiteList.allows(host: "", list: [""]))
        XCTAssertFalse(SiteList.allows(host: "", list: []))
    }

    func testEmptyListAllowsNothingAndBlankEntriesAreIgnored() {
        XCTAssertFalse(SiteList.allows(host: "coupang.com", list: []))
        XCTAssertFalse(SiteList.allows(host: "coupang.com", list: ["", " ", "."]))
    }
}
