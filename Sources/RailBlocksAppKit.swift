import AppKit

/// The Mac's section of a rail, built from the shared table (`RailBlockRegistry`). AppKit only;
/// the table itself (`Sources/RailBlocks.swift`) is shared with iOS.
extension RailBlockRegistry {
    /// A section of a rail, its fold key and empty rule from the table; the title is the client's.
    @MainActor
    static func section(_ surface: RailSurface, _ id: String, title: String) -> SidebarSection {
        let block = block(surface, id)
        return SidebarSection(title: title, key: block.key, hidesWhenEmpty: block.hidesWhenEmpty)
    }
}
