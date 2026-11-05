import DocsKit
import EnvisioningUI
import SwiftUI

/// Search on the phone — one list to find anything and jump anywhere
/// (AGENTS.md invariant 27). Home's magnifier and `Search
/// anything…` in the other tabs' surface menu present this sheet.
///
/// Hits come from `GET /api/search` in the contract's order; the Core
/// registry is this phone's (`CoreSession.contracts`), and doors and recents
/// are this device's. The same `Search.run` goes over all of them once more
/// so a recent row, a Core row and a door rank by the one rule. Document
/// titles are in the first answer; full text (`DocsSession.client.search`)
/// arrives after a pause, below. A person is one row; its Message / Wave /
/// Call sit behind a chevron rather than being three more rows.
struct MobileSearchView: View {
    @EnvironmentObject private var app: StarlingsAppModel
    @EnvironmentObject private var docs: DocsSession
    @EnvironmentObject private var core: CoreSession
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var hits: [SearchRow] = []
    /// The last hits came back without every source.
    @State private var hitsPartial = false
    @State private var docHits: [DocsSearchHit] = []
    @State private var recents: [SearchRow] = []
    /// The person or subject whose verbs are showing.
    @State private var verbsFor: SearchRow?

    private enum Entry: Identifiable {
        case row(SearchRow, recent: Bool)
        case docHit(DocsSearchHit)

        var id: String {
            switch self {
            case .row(let row, _): row.key
            case .docHit(let hit): "docs:\(hit.id)"
            }
        }
    }

    var body: some View {
        NavigationStack {
            StarlingsList {
                if query.trimmingCharacters(in: .whitespaces).isEmpty {
                    emptyQuerySections
                } else if entries.isEmpty {
                    Text(hitsPartial ? String(localized: "Some results are missing.") : String(localized: "Nothing matches.")).foregroundStyle(.secondary)
                } else {
                    Section { ForEach(entries) { entry in entryRow(entry) } }
                    if !docTail.isEmpty {
                        Section("Docs") { ForEach(docTail, id: \.id) { hit in docRow(hit) } }
                    }
                    if hitsPartial {
                        Text("Some results are missing.").foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: String(localized: "Search"))
            .autocorrectionDisabled()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(EnvisioningCopy.done) { dismiss() }
                }
            }
            .confirmationDialog(
                verbsFor?.title ?? "",
                isPresented: Binding(get: { verbsFor != nil }, set: { if !$0 { verbsFor = nil } }),
                titleVisibility: .visible
            ) {
                if let row = verbsFor {
                    ForEach(Search.rowVerbs(for: row), id: \.self) { verb in
                        Button(verb.title) { open(row, verb: verb) }
                    }
                }
            }
            .task(id: query) { await loadHits() }
            .task(id: query) { await loadDocHits() }
            // Recents are the signed-in owner's, so they wait for the model.
            .onAppear { recents = SearchRecents.load(owner: app.ownerCredentials?.owner.email ?? "") }
        }
        .neutralChrome()
    }

    // MARK: - The list

    private var ranked: [SearchRow] {
        let recentKeys = recents.map(\.key)
        let hitKeys = Set(hits.map(\.key))
        let pool = hits
            + recents.filter { !hitKeys.contains($0.key) }
            + coreRows
            + Search.doorRows(verbs: [.startRoom, .openInternalRoom])
        return Search.run(pool, query: query, scope: Search.Scope.palette.kinds, order: .rank, recents: recentKeys)
    }

    private var entries: [Entry] {
        let recentKeys = Set(recents.map(\.key))
        return ranked.map { .row($0, recent: recentKeys.contains($0.key)) }
    }

    /// Full text under the ranked run, minus a document already there.
    private var docTail: [DocsSearchHit] {
        let seen = Set(ranked.map(\.key))
        return docHits.filter { !seen.contains(Search.key(kind: .document, id: $0.id)) }
    }

    /// With no query the list is Recent, then Go to, then Do — the fixture's
    /// empty-query order made visible.
    @ViewBuilder
    private var emptyQuerySections: some View {
        let rows = ranked
        let recentKeys = Set(recents.map(\.key))
        let recent = rows.filter { recentKeys.contains($0.key) }
        let goTo = rows.filter { !recentKeys.contains($0.key) && $0.kind != .verb }
        let verbs = rows.filter { $0.kind == .verb }
        if !recent.isEmpty {
            Section("Recent") { ForEach(recent) { row in searchRow(row) } }
        }
        Section("Go to") { ForEach(goTo) { row in searchRow(row) } }
        if !verbs.isEmpty {
            Section("Do") { ForEach(verbs) { row in searchRow(row) } }
        }
    }

    @ViewBuilder
    private func entryRow(_ entry: Entry) -> some View {
        switch entry {
        case .row(let row, _): searchRow(row)
        case .docHit(let hit): docRow(hit)
        }
    }

    private func searchRow(_ row: SearchRow) -> some View {
        let verbs = Search.rowVerbs(for: row)
        return Button {
            open(row, verb: nil)
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title).lineLimit(1).foregroundStyle(StarlingsMobileColors.primary)
                    if !row.subtitle.isEmpty {
                        Text(row.subtitle).font(.footnote).lineLimit(1).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                Text(row.kind.label.uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                if !verbs.isEmpty {
                    Button {
                        verbsFor = row
                    } label: {
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.meetPlain)
                    .accessibilityLabel("Message, Wave, Call")
                }
            }
        }
        .buttonStyle(.plain)
        .meetHoverLift(cornerRadius: EnvisioningRadius.control)
    }

    private func docRow(_ hit: DocsSearchHit) -> some View {
        Button {
            open(SearchRow(kind: .document, id: hit.id, title: hit.title, subtitle: "", door: .document(id: hit.id)), verb: nil)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(hit.title).lineLimit(1).foregroundStyle(StarlingsMobileColors.primary)
                Text(Self.snippetText(hit.snippet)).font(.footnote).lineLimit(2).foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
        .meetHoverLift(cornerRadius: EnvisioningRadius.control)
    }

    // MARK: - Sources

    /// The registry's tables with no subject door, as rows (`CoreSession.entities`).
    private var coreRows: [SearchRow] {
        guard core.isLinked else { return [] }
        return core.entities.map { contract in
            let count = core.recordCounts[contract.id]
            return SearchRow(kind: .core, id: contract.id, title: contract.pluralLabel, subtitle: count.map { String(localized: "\($0) records") } ?? String(localized: "Records"), door: .core(id: contract.id))
        }
    }

    private func loadHits() async {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, let credentials = app.ownerCredentials else {
            hits = []
            return
        }
        // The Worker fan-out is eight upstream reads; a keystroke should not fire it.
        try? await Task.sleep(for: .milliseconds(150))
        guard !Task.isCancelled else { return }
        let found = try? await app.api.search(query: trimmed, timeZone: TimeZone.current.identifier, credentials: credentials)
        guard !Task.isCancelled else { return }
        hits = found?.rows ?? []
        hitsPartial = !(found?.partial.isEmpty ?? true)
    }

    private func loadDocHits() async {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2, docs.isLinked else {
            docHits = []
            return
        }
        // Titles answer on the first keystroke; this is the wait before full text.
        try? await Task.sleep(for: .milliseconds(400))
        guard !Task.isCancelled else { return }
        let found = (try? await docs.client.search(trimmed, limit: 20)) ?? []
        guard !Task.isCancelled else { return }
        docHits = found
    }

    private func open(_ row: SearchRow, verb: SearchRowVerb?) {
        SearchRecents.remember(row, owner: app.ownerCredentials?.owner.email ?? "")
        verbsFor = nil
        dismiss()
        app.openSearch(row, verb: verb)
    }

    /// The FTS snippet without its `<mark>` tags — the row is text, not HTML.
    private static func snippetText(_ snippet: String) -> String {
        snippet
            .replacingOccurrences(of: "<mark>", with: "")
            .replacingOccurrences(of: "</mark>", with: "")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

extension View {
    /// The search sheet, mounted once per tab so it opens over whichever
    /// tab asked for it.
    func meetSearchSheet() -> some View {
        modifier(MobileSearchSheet())
    }
}

private struct MobileSearchSheet: ViewModifier {
    @EnvironmentObject private var app: StarlingsAppModel

    func body(content: Content) -> some View {
        content.sheet(isPresented: $app.isSearchPresented) {
            MobileSearchView().meetAlertHost()
        }
    }
}

