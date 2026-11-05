import XCTest
@testable import Starlings

/// Web and both native clients use the same corpus limit, folder palette,
/// layout knobs and graph cases. A port that drifts fails against this table.
final class DocsGraphFixtureTests: XCTestCase {
    func testEverySurfaceReadsTheSharedGraphConfiguration() {
        let config = DocsGraphConfiguration.current

        XCTAssertEqual(config.version, 2)
        XCTAssertEqual(config.pageSize, 200)
        XCTAssertEqual(config.maxDocuments, 5_000)
        XCTAssertEqual(config.linkBatchSize, 8)
        XCTAssertEqual(config.zoom.min, 0.25)
        XCTAssertEqual(config.zoom.max, 4)
        XCTAssertEqual(config.zoom.bounded(-1), 0.25)
        XCTAssertEqual(config.zoom.bounded(100), 4)
        XCTAssertEqual(config.folderColors.count, 8)
        XCTAssertEqual(config.layout.linkLength, 40)
        XCTAssertEqual(config.layout.chargeStrength, -120)
        XCTAssertEqual(config.fit.padding, 90)
    }

    func testSharedFoldersEdgesAndLinkAwareLayout() throws {
        let fixture = try loadFixture()
        XCTAssertEqual(fixture.version, 1)

        let groupByID = Dictionary(uniqueKeysWithValues: fixture.documents.map {
            ($0.id, DocsGraphLayout.groupName(for: $0.path))
        })
        XCTAssertEqual(groupByID, fixture.expect.groups)

        let documentIDs = Set(fixture.documents.map(\.id))
        var seen = Set<String>()
        let edges = fixture.links.compactMap {
            DocsGraphEdge.resolve(
                sourceID: $0.source,
                targetID: $0.target,
                documentIDs: documentIDs,
                seenKeys: &seen
            )
        }
        XCTAssertEqual(edges.map { FixtureEdge(source: $0.sourceID, target: $0.targetID) }, fixture.expect.edges)

        let documents = fixture.documents.map { DocsGraphNode(id: $0.id, path: $0.path, title: $0.title) }
        let linked = DocsGraphLayout.positions(documents: documents, edges: edges)
        let unlinked = DocsGraphLayout.positions(documents: documents, edges: [])
        let linkedDistance = distance(try XCTUnwrap(linked["a"]), try XCTUnwrap(linked["b"]))
        let unlinkedDistance = distance(try XCTUnwrap(unlinked["a"]), try XCTUnwrap(unlinked["b"]))
        XCTAssertLessThan(linkedDistance, unlinkedDistance)

        let visible = try fixture.expect.visibleIds.map { try XCTUnwrap(linked[$0]) }
        let fit = DocsGraphLayout.fitBounds(visible)
        let padding = Double(DocsGraphConfiguration.current.fit.padding)
        XCTAssertLessThanOrEqual(fit.x, visible.map(\.x).min()! - padding)
        XCTAssertGreaterThanOrEqual(fit.x + fit.width, visible.map(\.x).max()! + padding)
        XCTAssertLessThanOrEqual(fit.y, visible.map(\.y).min()! - padding)
        XCTAssertGreaterThanOrEqual(fit.y + fit.height, visible.map(\.y).max()! + padding)
    }

    private func distance(_ lhs: DocsGraphPoint, _ rhs: DocsGraphPoint) -> Double {
        hypot(lhs.x - rhs.x, lhs.y - rhs.y)
    }

    private func loadFixture() throws -> GraphFixture {
        let url = try XCTUnwrap(
            Bundle(for: type(of: self)).url(forResource: "docs-graph", withExtension: "json"),
            "fixtures/docs-graph.json must be in the StarlingsTests bundle."
        )
        return try JSONDecoder().decode(GraphFixture.self, from: Data(contentsOf: url))
    }
}

private struct GraphFixture: Decodable {
    struct Document: Decodable {
        let id: String
        let path: String
        let title: String
    }

    struct Expect: Decodable {
        let groups: [String: String]
        let edges: [FixtureEdge]
        let visibleIds: [String]
    }

    let version: Int
    let documents: [Document]
    let links: [FixtureEdge]
    let expect: Expect
}

private struct FixtureEdge: Decodable, Equatable {
    let source: String
    let target: String
}
