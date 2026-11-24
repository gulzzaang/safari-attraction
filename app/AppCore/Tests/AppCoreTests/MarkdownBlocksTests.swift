import XCTest
@testable import AppCore

final class MarkdownBlocksTests: XCTestCase {
    func testParagraphsSplitOnBlankLines() {
        XCTAssertEqual(MarkdownBlocks.parse("첫 줄\n이어서\n\n둘째 문단"), [.paragraph("첫 줄\n이어서"), .paragraph("둘째 문단")])
    }
    func testHeadingsAndLists() {
        let b = MarkdownBlocks.parse("## 제목\n- 하나\n* 둘\n1. 셋\n본문")
        XCTAssertEqual(b, [.heading(level: 2, text: "제목"), .listItem(marker: "•", text: "하나"), .listItem(marker: "•", text: "둘"),
                           .listItem(marker: "1.", text: "셋"), .paragraph("본문")])
    }
    func testFencedCodeKeepsContentVerbatim() {
        let b = MarkdownBlocks.parse("앞\n```swift\nlet a = 1\n\n  # not heading\n```\n뒤")
        XCTAssertEqual(b, [.paragraph("앞"), .code(language: "swift", text: "let a = 1\n\n  # not heading"), .paragraph("뒤")])
    }
    func testUnclosedFenceWhileStreamingIsStillCode() {
        XCTAssertEqual(MarkdownBlocks.parse("```\nlet a"), [.code(language: nil, text: "let a")])
    }
    func testEmptyAndWhitespace() {
        XCTAssertEqual(MarkdownBlocks.parse(""), [])
        XCTAssertEqual(MarkdownBlocks.parse("\n\n  \n"), [])
    }
    func testInlineMarkdownProducesLinkAttribute() {
        let a = MarkdownBlocks.attributed("**굵게** [사이트](https://example.com/a)")
        let links = a.runs.compactMap(\.link)
        XCTAssertEqual(links, [URL(string: "https://example.com/a")!])
        XCTAssertTrue(String(a.characters).contains("굵게"))
    }
    func testLinkPolicyAllowsOnlyWebAndMail() {
        XCTAssertTrue(MarkdownBlocks.isOpenable(URL(string: "https://a.example")!))
        XCTAssertTrue(MarkdownBlocks.isOpenable(URL(string: "http://a.example")!))
        XCTAssertTrue(MarkdownBlocks.isOpenable(URL(string: "mailto:a@b.c")!))
        XCTAssertFalse(MarkdownBlocks.isOpenable(URL(string: "file:///etc/passwd")!))
        XCTAssertFalse(MarkdownBlocks.isOpenable(URL(string: "x-apple.systempreferences:")!))
    }
}

final class MarkdownBareLinkTests: XCTestCase {
    func testBareURLBecomesLink() {
        let a = MarkdownBlocks.attributed("자세히: https://example.com/x 를 보세요")
        XCTAssertEqual(a.runs.compactMap(\.link), [URL(string: "https://example.com/x")!])
    }
    func testBrokenMarkdownFallsBackToPlainText() {
        let a = MarkdownBlocks.attributed("[열린 괄호 (https://a.example")
        XCTAssertTrue(String(a.characters).contains("열린 괄호"))
    }

    func testAttributedWithoutLinksKeepsTextAndShowsAddressInParentheses() {
        let a = MarkdownBlocks.attributedWithoutLinks("**굵게** [사이트](https://example.com/a) 끝")
        XCTAssertTrue(a.runs.compactMap(\.link).isEmpty)
        XCTAssertEqual(String(a.characters), "굵게 사이트 (https://example.com/a) 끝")
    }
    func testAttributedWithoutLinksDoesNotRepeatABareAddress() {
        let a = MarkdownBlocks.attributedWithoutLinks("자세히: https://example.com/x 를 보세요")
        XCTAssertTrue(a.runs.compactMap(\.link).isEmpty)
        XCTAssertEqual(String(a.characters), "자세히: https://example.com/x 를 보세요")
    }
}
