import SwiftUI

/// The blocks of Docs' and Team's rails on iOS, drawn from the shared table
/// (`RailBlockRegistry`, decided in `packages/contracts/src/rail-blocks.ts`).
///
/// The table fixes which blocks there are, their order, the key each fold is saved
/// under and whether a block draws nothing while it has no rows. This file reads it;
/// `MobileDocsView` and `MobileTeamView` keep the words, the rows and the menus. iOS has
/// no sidebar, so a block is a `Section` of a list and a pushed pane per row.

/// The ids of one rail's blocks that iOS knows how to draw. An enum rather than strings so a
/// `switch` over it is exhaustive; `MobileRailBlocksTests` fails when it and the table differ.
protocol MobileRailBlockID: Hashable, CaseIterable, RawRepresentable where RawValue == String {
    static var surface: RailSurface { get }
}

enum MobileDocsBlock: String, MobileRailBlockID {
    case explore, work, projects, leads, partners, folders, library
    static var surface: RailSurface { .docs }
}

enum MobileTeamBlock: String, MobileRailBlockID {
    case you, groups, people, agents
    static var surface: RailSurface { .team }
}

/// One block a rail draws: what the view switches on, and the table's row for it.
struct MobileRailEntry<ID: MobileRailBlockID>: Identifiable {
    let kind: ID
    let block: RailBlock
    var id: String { block.id }
}

enum MobileRail {
    /// The blocks to draw, top to bottom, in the table's order. A block that hides while empty
    /// is left out when `empty` holds it; every other block stays, empty or not.
    /// `table` is the registry's unless a test hands in another order.
    static func blocks<ID: MobileRailBlockID>(
        _ type: ID.Type,
        empty: Set<ID> = [],
        table: [RailBlock]? = nil
    ) -> [MobileRailEntry<ID>] {
        let rows = table ?? RailBlockRegistry.blocks[ID.surface] ?? []
        return rows.compactMap { block in
            guard let kind = ID(rawValue: block.id) else { return nil }
            if block.hidesWhenEmpty, empty.contains(kind) { return nil }
            return MobileRailEntry(kind: kind, block: block)
        }
    }
}

/// One block of a rail as a list section: a header that folds it, the fold kept under the
/// table's key (the Mac's `SidebarSection` and the web's `RailSection` fold the same way).
struct MobileRailSection<Content: View, Footer: View>: View {
    let title: LocalizedStringKey
    @AppStorage private var folded: Bool
    private let content: Content
    private let footer: Footer

    init(
        _ block: RailBlock,
        title: LocalizedStringKey,
        @ViewBuilder content: () -> Content,
        @ViewBuilder footer: () -> Footer
    ) {
        self.title = title
        _folded = AppStorage(wrappedValue: false, block.foldDefaultsKey)
        self.content = content()
        self.footer = footer()
    }

    var body: some View {
        Section {
            if !folded { content }
        } header: {
            Button {
                withAnimation(.snappy) { folded.toggle() }
            } label: {
                HStack {
                    Text(title)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .rotationEffect(.degrees(folded ? 0 : 90))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.meetPlain)
            .accessibilityAddTraits(.isHeader)
            .accessibilityValue(folded ? Text("Collapsed") : Text("Expanded"))
        } footer: {
            if !folded { footer }
        }
    }
}

extension MobileRailSection where Footer == EmptyView {
    init(_ block: RailBlock, title: LocalizedStringKey, @ViewBuilder content: () -> Content) {
        self.init(block, title: title, content: content, footer: { EmptyView() })
    }
}
