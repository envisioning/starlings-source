import XCTest
@testable import Starlings

/// An uploaded SVG mark read as one outline (MZ, 2026-10-05).
final class WorkspaceMarkVectorTests: XCTestCase {
    func testReadsShapesTransformsAndArcsInsideTheViewBox() throws {
        let svg = """
        <?xml version="1.0"?>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="#e30613">
          <defs><clipPath id="c"><rect width="1000" height="1000"/></clipPath></defs>
          <g transform="translate(10 10)">
            <rect x="0" y="0" width="20" height="20" rx="4"/>
          </g>
          <circle cx="70" cy="30" r="10"/>
          <path d="M10 80a10 10 0 1 0 20 0a10 10 0 1 0-20 0z"/>
          <line x1="50" y1="90" x2="90" y2="90" stroke="#000" stroke-width="2" fill="none"/>
        </svg>
        """
        let outline = try XCTUnwrap(WorkspaceMarkVector.outline(from: Data(svg.utf8)))
        XCTAssertEqual(outline.viewBox, CGRect(x: 0, y: 0, width: 100, height: 100))
        let box = outline.path.boundingBoxOfPath
        // The rect is moved by its group, the defs' clip rect is not drawn,
        // the arc closes a circle around (20, 80), and the stroked line counts.
        XCTAssertEqual(box.minX, 10, accuracy: 0.5)
        XCTAssertEqual(box.minY, 10, accuracy: 0.5)
        XCTAssertEqual(box.maxX, 90, accuracy: 1.5)
        XCTAssertEqual(box.maxY, 91, accuracy: 0.5)
        XCTAssertTrue(outline.path.contains(CGPoint(x: 20, y: 80)))
        XCTAssertTrue(outline.path.contains(CGPoint(x: 70, y: 30)))
        XCTAssertFalse(outline.path.contains(CGPoint(x: 50, y: 50)))
    }

    func testTellsSVGFromRasterAndRefusesEmptyDocuments() {
        XCTAssertTrue(WorkspaceMarkVector.isSVG(Data("<svg viewBox='0 0 1 1'/>".utf8)))
        XCTAssertFalse(WorkspaceMarkVector.isSVG(Data([0x89, 0x50, 0x4e, 0x47])))
        XCTAssertNil(WorkspaceMarkVector.outline(from: Data("<svg viewBox='0 0 10 10'></svg>".utf8)))
    }
}
