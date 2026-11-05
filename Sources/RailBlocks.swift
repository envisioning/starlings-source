import Foundation

/// The blocks of Docs' and Team's rails, in order, decided once in
/// `packages/contracts/src/rail-blocks.ts`. The table is generated from it
/// (`pnpm registries:gen`); `fixtures/rail-blocks.json` is generated too and pins it
/// (`RailBlocksFixtureTests`).
///
/// Which blocks there are, in what order, the key each fold is saved under, and whether a
/// block draws nothing while it has no rows. Titles, rows and menus stay with each client.
struct RailBlock: Equatable, Sendable {
    let id: String
    /// The key the fold is saved under.
    let key: String
    /// Draws nothing at all while it has no rows.
    let hidesWhenEmpty: Bool

    /// Where a fold is kept in `UserDefaults`: the Mac's `MeetingSidebarFoldPreferences` and
    /// iOS's `MobileRailSection` write the same key, so a block has one name on both.
    static let foldDefaultsPrefix = "meet.sidebarFold."
    var foldDefaultsKey: String { Self.foldDefaultsPrefix + key }
}

enum RailSurface: String, CaseIterable, Sendable {
    case docs
    case team
    case workOverview
}

enum RailBlockRegistry {
    // `blocks` is the table: Sources/Generated/RailBlocksRegistry.swift.

    /// One block of a rail. An unknown id is a bug in the caller.
    static func block(_ surface: RailSurface, _ id: String) -> RailBlock {
        guard let block = blocks[surface]?.first(where: { $0.id == id }) else {
            preconditionFailure("No \(surface.rawValue) rail block named \(id).")
        }
        return block
    }
}
