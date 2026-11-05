import XCTest
@testable import Starlings

/// The shared tile table, run against the Swift implementation. The web runs
/// the same file (`web/src/calendar-tile.test.ts`). A failure here is a
/// question about `fixtures/calendar-tile.json` first.
final class CalendarTileFixtureTests: XCTestCase {
    func testTimeLabels() throws {
        let table = try loadTable()
        XCTAssertEqual(table.version, 1)
        for row in table.timeLabels {
            let label = CalendarTileDetail.timeLabel(
                start: try XCTUnwrap(ISODate.parse(row.start), row.name),
                end: try XCTUnwrap(ISODate.parse(row.end), row.name),
                originZone: row.originZone.flatMap(TimeZone.init(identifier:)),
                viewerZone: try XCTUnwrap(TimeZone(identifier: row.viewerZone), row.name)
            )
            XCTAssertEqual(label, row.expect, row.name)
        }
    }

    func testRows() throws {
        for row in try loadTable().rows {
            let rows = CalendarTileDetail.rows(
                height: row.height,
                titleHeight: row.titleHeight,
                rowHeight: row.rowHeight,
                padding: row.padding,
                hasLocation: row.hasLocation
            )
            XCTAssertEqual(rows.time, row.expect.time, row.name)
            XCTAssertEqual(rows.location, row.expect.location, row.name)
        }
    }

    func testPlaces() throws {
        for row in try loadTable().places {
            XCTAssertEqual(
                CalendarTileDetail.place(location: row.location, platform: CalendarMeetingPlatform(rawValue: row.platform)),
                row.expect,
                row.name
            )
        }
    }

    private func loadTable() throws -> Table {
        let url = try XCTUnwrap(
            Bundle(for: type(of: self)).url(forResource: "calendar-tile", withExtension: "json"),
            "fixtures/calendar-tile.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(Table.self, from: Data(contentsOf: url))
    }

    private struct Table: Decodable {
        let version: Int
        let timeLabels: [TimeLabel]
        let rows: [Rows]
        let places: [Place]
    }

    private struct TimeLabel: Decodable {
        let name: String
        let start: String
        let end: String
        let originZone: String?
        let viewerZone: String
        let expect: String
    }

    private struct Rows: Decodable {
        let name: String
        let height: CGFloat
        let titleHeight: CGFloat
        let rowHeight: CGFloat
        let padding: CGFloat
        let hasLocation: Bool
        let expect: Expect

        struct Expect: Decodable {
            let time: Bool
            let location: Bool
        }
    }

    private struct Place: Decodable {
        let name: String
        let location: String
        let platform: String
        let expect: String?
    }
}
