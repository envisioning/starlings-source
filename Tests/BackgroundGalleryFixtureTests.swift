import XCTest
@testable import Starlings

/// The background gallery's drawing rule (meet#862), run against the Swift
/// port. The web runs the same file (`web/src/background-gallery.test.ts`). A
/// failure here is a question about `fixtures/background-gallery.json` first.
final class BackgroundGalleryFixtureTests: XCTestCase {
    func testRandomMatchesTheContract() throws {
        for row in try loadTable().random {
            var random = SeededRandom(seed: row.seed)
            XCTAssertEqual(row.values.map { _ in random.next() }, row.values, "seed \(row.seed)")
        }
    }

    func testCellsMatchTheContract() throws {
        for row in try loadTable().cells {
            let cells = PixelField.cells(width: row.width, height: row.height, seed: row.seed)
            let name = "seed \(row.seed) \(row.width)x\(row.height)"
            XCTAssertEqual(cells.count, row.count, name)
            XCTAssertEqual(Self.digest(cells), row.digest, name)
            XCTAssertEqual(Array(cells.prefix(3)), row.first.map {
                PixelField.Cell(x: $0.x, y: $0.y, width: $0.width, height: $0.height, alpha: $0.alpha)
            }, name)
        }
    }

    func testNewGeneratorsMatchTheContract() throws {
        for row in try loadTable().generatedCells {
            let generator = try XCTUnwrap(BackgroundGenerator(rawValue: row.generator!))
            let cells = GalleryField.cells(generator: generator, width: row.width, height: row.height, seed: row.seed)
            XCTAssertEqual(cells.count, row.count)
            XCTAssertEqual(Self.digest(cells), row.digest)
            XCTAssertEqual(Array(cells.prefix(3)), row.first.map {
                PixelField.Cell(x: $0.x, y: $0.y, width: $0.width, height: $0.height, alpha: $0.alpha)
            })
        }
    }

    func testOldPlateNamesReadAsTheSamePlate() {
        XCTAssertEqual(BackgroundChoice(plate: "night")?.tone, .dark)
        XCTAssertEqual(BackgroundChoice(plate: "Lime")?.tone, .accent)
        XCTAssertEqual(BackgroundChoice(plate: "ice")?.tone, .bright)
        XCTAssertEqual(BackgroundChoice(plate: "bright")?.tone, .bright)
        XCTAssertNil(BackgroundChoice(plate: "stars"))
    }

    func testGalleryStepsThroughEveryEntryThenStops() {
        var seen: [BackgroundChoice] = []
        var entry: BackgroundChoice? = .first
        while let current = entry {
            seen.append(current)
            entry = current.next
        }
        XCTAssertEqual(seen, BackgroundChoice.all)
    }

    /// The contract's `pixelCellsDigest`: FNV-1a over x, y, width, height and
    /// opacity in ten-thousandths, four bytes each, low byte first.
    private static func digest(_ cells: [PixelField.Cell]) -> UInt32 {
        var hash: UInt32 = 0x811c9dc5
        for cell in cells {
            for value in [cell.x, cell.y, cell.width, cell.height, Int((cell.alpha * 10000).rounded())] {
                let bits = UInt32(truncatingIfNeeded: value)
                for shift in stride(from: 0, to: 32, by: 8) {
                    hash ^= (bits >> UInt32(shift)) & 0xFF
                    hash = hash &* 0x01000193
                }
            }
        }
        return hash
    }

    private func loadTable() throws -> Table {
        let url = try XCTUnwrap(
            Bundle(for: type(of: self)).url(forResource: "background-gallery", withExtension: "json"),
            "fixtures/background-gallery.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(Table.self, from: Data(contentsOf: url))
    }

    private struct Table: Decodable {
        let random: [RandomRow]
        let cells: [CellsRow]
        let generatedCells: [CellsRow]
    }

    private struct RandomRow: Decodable {
        let seed: UInt32
        let values: [Double]
    }

    private struct CellsRow: Decodable {
        let generator: String?
        let seed: UInt32
        let width: Int
        let height: Int
        let count: Int
        let digest: UInt32
        let first: [FixtureCell]
    }

    private struct FixtureCell: Decodable {
        let x: Int
        let y: Int
        let width: Int
        let height: Int
        let alpha: Double
    }
}
