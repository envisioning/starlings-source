import XCTest
@testable import Starlings

/// The Markdown subset a conversation is written in. Tested here rather than by
/// eye in three clients: the Mac, the phone and the browser all draw from this
/// parser, so a rule that changes shape here changes it everywhere.
final class ThreadMarkdownTests: XCTestCase {
    private func plain(_ spans: [ThreadMarkdown.Span]) -> String {
        spans.map(\.text).joined()
    }

    func testBoldItalicAndCodeLoseTheirMarkers() {
        let spans = ThreadMarkdown.spans("a **bold** and *soft* and `code`")
        XCTAssertEqual(plain(spans), "a bold and soft and code")
        XCTAssertEqual(spans.filter(\.bold).map(\.text), ["bold"])
        XCTAssertEqual(spans.filter(\.italic).map(\.text), ["soft"])
        XCTAssertEqual(spans.filter(\.code).map(\.text), ["code"])
    }

    func testUnclosedMarkersStayLiteral() {
        let spans = ThreadMarkdown.spans("2 * 3 * 4 and snake_case_name")
        XCTAssertEqual(plain(spans), "2 * 3 * 4 and snake_case_name")
        XCTAssertTrue(spans.allSatisfy { !$0.bold && !$0.italic })
    }

    func testBareURLBecomesALink() {
        let spans = ThreadMarkdown.spans("read https://www.ben-evans.com/x, then stop")
        XCTAssertEqual(spans.compactMap(\.link), ["https://www.ben-evans.com/x"])
        // The comma is the sentence's, not the URL's.
        XCTAssertEqual(plain(spans), "read https://www.ben-evans.com/x, then stop")
    }

    func testLabelledLinkKeepsItsLabel() {
        let spans = ThreadMarkdown.spans("see [the essay](https://example.com/a)")
        XCTAssertEqual(plain(spans), "see the essay")
        XCTAssertEqual(spans.compactMap(\.link), ["https://example.com/a"])
    }

    func testOnlyWebAndMailSchemesLink() {
        XCTAssertNil(ThreadMarkdown.safeURL("javascript:alert(1)"))
        XCTAssertNil(ThreadMarkdown.safeURL("file:///etc/passwd"))
        XCTAssertNil(ThreadMarkdown.safeURL("/rooms/rosa"))
        XCTAssertEqual(ThreadMarkdown.safeURL("mailto:rosa@example.com"), "mailto:rosa@example.com")
        // A label with an unsafe target is text, never a link.
        let spans = ThreadMarkdown.spans("[click](javascript:alert(1))")
        XCTAssertTrue(spans.allSatisfy { $0.link == nil })
    }

    func testBlocksSplitByKind() {
        let blocks = ThreadMarkdown.parse("""
        # Heading

        A line.

        - one
        - two

        1. first

        > quoted

        ```
        code();
        ```
        """)
        XCTAssertEqual(blocks.map(\.kind), [
            .heading(1),
            .paragraph,
            .bullet(0),
            .bullet(0),
            .ordered(0, 1),
            .quote,
            .code("code();"),
        ])
    }

    func testHashWithoutASpaceIsATag() {
        let blocks = ThreadMarkdown.parse("#tag not a heading")
        XCTAssertEqual(blocks.map(\.kind), [.paragraph])
    }

    func testNestedBulletsKeepTheirLevel() {
        let blocks = ThreadMarkdown.parse("- one\n  - deeper")
        XCTAssertEqual(blocks.map(\.kind), [.bullet(0), .bullet(1)])
    }

    func testPlainMessageIsOneParagraph() {
        let blocks = ThreadMarkdown.parse("Hey hey\nsecond line")
        XCTAssertEqual(blocks.count, 1)
        XCTAssertEqual(blocks.first.map { plain($0.spans) }, "Hey hey\nsecond line")
    }

    func testPreviewDropsMarksAndCollapsesLines() {
        XCTAssertEqual(
            ThreadMarkdown.plainPreview("Building **Biomolecule Watermarking** now — the `general` technique\n\n- see [notes](https://example.com)  here"),
            "Building Biomolecule Watermarking now — the general technique • see notes here"
        )
        XCTAssertEqual(ThreadMarkdown.plainPreview("2 * 3 = 6"), "2 * 3 = 6")
    }
}
