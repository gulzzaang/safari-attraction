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

    // 공개 접미사 · 속임 주소

    func testPublicSuffixesAreNeitherExtractedNorAllowed() {
        XCTAssertEqual(SiteList.extractHosts(from: "co.kr 사이트 와 www.co.kr 와 m.co.uk 와 com.au"), [])
        for suffix in ["co.kr", "or.kr", "go.kr", "ne.kr", "re.kr", "pe.kr", "ac.kr", "co.uk", "org.uk", "ac.uk", "com.au", "net.au",
                       "co.jp", "ne.jp", "or.jp", "com.cn", "com.tw", "com.hk", "com.sg", "co.nz", "com.br"] {
            XCTAssertFalse(SiteList.allows(host: "evil.\(suffix)", list: [suffix]), suffix)
            XCTAssertFalse(SiteList.allows(host: suffix, list: [suffix]), suffix)
            XCTAssertFalse(SiteList.allows(host: "evil.\(suffix)", list: [suffix.uppercased() + "."]), suffix)
            XCTAssertEqual(SiteList.extractHosts(from: "https://\(suffix)/x"), [], suffix)
        }
        XCTAssertEqual(SiteList.extractHosts(from: "https://shop.co.kr 과 coupang.co.kr"), ["shop.co.kr", "coupang.co.kr"], "그 아래 사이트는 뽑힌다")
        XCTAssertTrue(SiteList.allows(host: "www.shop.co.kr", list: ["shop.co.kr"]))
        XCTAssertFalse(SiteList.allows(host: "other.co.kr", list: ["shop.co.kr"]))
    }

    func testSingleWordEntriesAreIgnored() {
        XCTAssertFalse(SiteList.allows(host: "evil.com", list: ["com"]))
        XCTAssertFalse(SiteList.allows(host: "com", list: ["com"]))
        XCTAssertFalse(SiteList.allows(host: "localhost", list: ["localhost"]))
        XCTAssertTrue(SiteList.allows(host: "evil.com", list: ["com", "evil.com"]))
    }

    func testHostsWithSeparatorsOrSpacesAreRejected() {
        let list = ["coupang.com"]
        for bad in ["coupang.com/x", "coupang.com?x", "coupang.com#x", "evil.com@coupang.com", "coupang.com@evil.com", "coupang.com:8080",
                    "coupang.com evil", "coupang.com\nevil.com", "https://coupang.com", "a.coupang.com/path"] {
            XCTAssertFalse(SiteList.allows(host: bad, list: list), bad)
        }
        XCTAssertTrue(SiteList.allows(host: " Coupang.com. ", list: list), "앞뒤 공백 · 끝 점은 무시")
    }

    func testUserinfoUrlGivesTheRealHost() {
        XCTAssertEqual(SiteList.extractHosts(from: "https://coupang.com@evil.com/"), ["evil.com"])
        XCTAssertEqual(SiteList.extractHosts(from: "http://user:pw@www.example.org:8080/x"), ["example.org"])
        XCTAssertEqual(SiteList.extractHosts(from: "쿠팡 https://www.coupang.com@evil.com/path 그리고 naver.com"), ["evil.com", "naver.com"])
        XCTAssertEqual(SiteList.extractHosts(from: "coupang.com@evil.com"), [], "스킴 없는 `a@b` 꼴은 어느 쪽도 뽑지 않는다")
    }

    func testMoreFileNamesAreNotHosts() {
        XCTAssertEqual(SiteList.extractHosts(from: "index.html style.css main.php lib.rs App.kt Main.java Cargo.toml a.rtf b.xml c.cpp x.htm"), [])
    }

    func testEntryFromUserInput() {
        XCTAssertEqual(SiteList.entry(fromUserInput: "coupang.com"), "coupang.com")
        XCTAssertEqual(SiteList.entry(fromUserInput: "  WWW.Coupang.com. "), "coupang.com")
        XCTAssertEqual(SiteList.entry(fromUserInput: "https://www.coupang.com/np/search?q=a"), "coupang.com")
        XCTAssertEqual(SiteList.entry(fromUserInput: "docs.rs"), "docs.rs")            // 글에서는 안 뽑는 .rs 도 사람이 치면 받는다
        XCTAssertEqual(SiteList.entry(fromUserInput: "https://docs.rs/serde"), "docs.rs")
        XCTAssertEqual(SiteList.entry(fromUserInput: "example.com:8080"), "example.com")
        XCTAssertEqual(SiteList.entry(fromUserInput: "https://coupang.com@evil.com/"), "evil.com")   // 실제 호스트
        XCTAssertNil(SiteList.entry(fromUserInput: "coupang.com@evil.com"))
        XCTAssertNil(SiteList.entry(fromUserInput: ""))
        XCTAssertNil(SiteList.entry(fromUserInput: "com"))
        XCTAssertNil(SiteList.entry(fromUserInput: "co.kr"))
        XCTAssertNil(SiteList.entry(fromUserInput: "a b.com"))
        XCTAssertNil(SiteList.entry(fromUserInput: "javascript:alert(1)"))
        XCTAssertNil(SiteList.entry(fromUserInput: "..com"))
    }
}
