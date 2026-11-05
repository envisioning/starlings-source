import CoreKit
import DocsKit
import DocsUI
import EnvisioningUI
import StarlingsContracts
import SwiftUI

/// Docs on the phone and the iPad: the corpus, as a tab. WORK and LIBRARY
/// on the first screen; a list for whatever was chosen; the editor pushed
/// over it. The same store the Mac window shows (docs/DOCS.md).
struct MobileDocsView: View {
    @EnvironmentObject private var docs: DocsSession
    @EnvironmentObject private var core: CoreSession
    @EnvironmentObject private var app: StarlingsAppModel

    @State private var summary: DocsSummary?
    @State private var projectGroups: [DocsSubjectGroup] = []
    @State private var leadGroups: [DocsSubjectGroup] = []
    @State private var partnerGroups: [DocsSubjectGroup] = []
    /// The folder tree, for which empty top-level folders take a document.
    @State private var tree: [DocsFolder] = []
    /// Every project and lead the CRM names: what the File menu files onto.
    @State private var projects: [CrmSubject] = []
    @State private var leads: [CrmSubject] = []
    @State private var partners: [CrmSubject] = []

    private var filing: DocsFilingChoices {
        DocsRailGroups.filingChoices(
            tree: tree, categories: summary?.categoryList ?? [], projects: projects, leads: leads, partners: partners
        )
    }
    @State private var query = ""
    @State private var errorMessage: String?
    @State private var path = NavigationPath()
    @State private var creating = false
    @State private var savingLink = false
    @State private var newTitle = ""
    @State private var newCategory: DocsCategory?

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if !docs.isLinked {
                    connect
                } else if let errorMessage {
                    EnvisioningRetryState(String(localized: "Couldn’t load Docs"), message: errorMessage) { Task { await loadRail() } }
                } else if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                    MobileDocsListView(selection: .search(query.trimmingCharacters(in: .whitespaces)), filing: filing)
                } else {
                    rail
                }
            }
            .navigationTitle("Docs")
            .meetSurfaceBackground()
            .searchable(text: $query, prompt: String(localized: "Search"))
            .navigationDestination(for: MobileDocsSelection.self) { selection in
                if selection == .graph {
                    MobileDocsGraphScreen(onOpen: { path.append($0) })
                } else {
                    MobileDocsListView(selection: selection, filing: filing)
                }
            }
            .navigationDestination(for: DocsDocumentSummary.self) { document in
                MobileDocumentEditor(documentID: document.id, title: document.title)
            }
            // The palette's document door: one document by id, read where a
            // row would have read it.
            .navigationDestination(for: StarlingsAppModel.PendingDocument.self) { document in
                MobileDocumentEditor(documentID: document.id, title: document.title)
            }
            .onReceive(app.$pendingDocument) { document in
                guard let document, docs.isLinked else { return }
                app.pendingDocument = nil
                path = NavigationPath([document])
            }
            .onReceive(app.$pendingDocsFolderID) { folderID in
                guard let folderID, docs.isLinked else { return }
                app.pendingDocsFolderID = nil
                Task {
                    if tree.isEmpty { await loadRail() }
                    guard let folder = tree.first(where: { $0.id == folderID }) else { return }
                    path = NavigationPath([MobileDocsSelection.folder(folder.path, folder.title)])
                }
            }
            .meetSearchSheet()
            .meetSettingsSheet()
            // The bar every tab wears (`MobileSurfaceMenu`), and the `+`
            // every tab that creates wears. From the rail a document files
            // under `/work`; a list files under its own folder.
            .toolbar {
                MobileSurfaceMenu()
                if docs.isLinked, path.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { savingLink = true } label: { Image(systemName: "link") }
                            .accessibilityLabel("Save link")
                    }
                }
                if docs.isLinked, path.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { creating = true } label: { Image(systemName: "plus") }
                            .meetToolbarProminent()
                            .accessibilityLabel("New document")
                    }
                }
            }
            .sheet(isPresented: $creating) {
                NewDocumentSheet(title: $newTitle, category: $newCategory, note: String(localized: "Filed in /work.")) {
                    Task { await create() }
                }
                .environment(\.docsCategories, summary?.categoryList ?? [])
                .meetDrawer()
            }
            .sheet(isPresented: $savingLink) {
                MobileDocsLinkSaveSheet(folderPath: nil, subjects: []) { document in
                    path.append(document)
                    Task { await loadRail() }
                }
                .meetDrawer()
            }
        }
        .task(id: docs.isLinked) { if docs.isLinked { await loadRail() } }
    }

    private func create() async {
        let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        defer { newTitle = "" }
        do {
            let created = try await docs.client.create(
                DocsCreateDocument(
                    title: title, folderPath: "/work", category: newCategory, subjects: [],
                    message: String(localized: "Created from Starlings")))
            path.append(created.summary)
            await loadRail()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// WORK and LIBRARY — two halves of one corpus (docs/DOCS.md, "The
    /// rail") — with By project / By lead between them: one row per subject
    /// something is filed about. Folders holds the top-level folders
    ///, so a document with no category still has a row.
    private var rail: some View {
        // Two halves by source, not by category name: a brief Core
        // published sits in LIBRARY, a brief a person wrote in WORK.
        let work = summary?.categories(on: .work, includeEmpty: true) ?? []
        let library = summary?.categories(on: .library) ?? []
        let folders = DocsRailGroups.folders(summary: summary?.folders ?? [], tree: tree)
        // Which blocks there are, their order, each fold's key and which hide while empty come
        // from the shared table (`RailBlockRegistry`, via `MobileRail`); the rows are this view's.
        var empty = Set<MobileDocsBlock>()
        if projectGroups.isEmpty { empty.insert(.projects) }
        if leadGroups.isEmpty { empty.insert(.leads) }
        if partnerGroups.isEmpty { empty.insert(.partners) }
        if folders.isEmpty { empty.insert(.folders) }
        if library.isEmpty { empty.insert(.library) }
        return StarlingsList {
            ForEach(MobileRail.blocks(MobileDocsBlock.self, empty: empty)) { entry in
                railBlock(entry, work: work, library: library, folders: folders)
            }
        }
        .refreshable { await loadRail() }
    }

    @ViewBuilder
    private func railBlock(
        _ entry: MobileRailEntry<MobileDocsBlock>,
        work: [DocsSummary.CategoryCount],
        library: [DocsSummary.CategoryCount],
        folders: [DocsSummary.FolderCount]
    ) -> some View {
        switch entry.kind {
        case .explore:
            MobileRailSection(entry.block, title: "Explore") {
                NavigationLink(value: MobileDocsSelection.graph) {
                    Label("Graph", systemImage: "point.3.connected.trianglepath.dotted")
                }
            }
        case .work:
            MobileRailSection(entry.block, title: "Work") {
                NavigationLink(value: MobileDocsSelection.recent) {
                    Label("Recent", systemImage: "clock")
                }
                NavigationLink(value: MobileDocsSelection.links) {
                    HStack {
                        Label("Links", systemImage: "link")
                        Spacer()
                        Text("\(summary?.links ?? 0)").foregroundStyle(.secondary)
                    }
                }
                // Only while something is unfiled.
                if let unfiled = summary?.unfiled, unfiled > 0 {
                    NavigationLink(value: MobileDocsSelection.unfiled) {
                        Label {
                            HStack {
                                Text("Unfiled")
                                Spacer()
                                Text("\(unfiled)").foregroundStyle(.secondary)
                            }
                        } icon: {
                            Image(systemName: "tray")
                        }
                    }
                }
                ForEach(work) { category in categoryRow(category, on: .work) }
            }
        case .projects:
            MobileRailSection(entry.block, title: "By project") {
                ForEach(projectGroups) { group in subjectRow(group, systemImage: "folder") }
            }
        case .leads:
            MobileRailSection(entry.block, title: "By lead") {
                ForEach(leadGroups) { group in subjectRow(group, systemImage: "briefcase") }
            }
        case .partners:
            MobileRailSection(entry.block, title: "By partner") {
                ForEach(partnerGroups) { group in subjectRow(group, systemImage: "building.2") }
            }
        case .folders:
            MobileRailSection(entry.block, title: "Folders") {
                ForEach(folders) { folder in folderRow(folder) }
            }
        case .library:
            // Kept while empty (the table): a mirror that failed to load says so inside it.
            MobileRailSection(entry.block, title: "Library") {
                if library.isEmpty {
                    Text("Nothing mirrored here yet.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                ForEach(library) { category in categoryRow(category, on: .library) }
            }
        }
    }

    private func categoryRow(_ entry: DocsSummary.CategoryCount, on half: DocsRailHalf) -> some View {
        NavigationLink(value: MobileDocsSelection.category(entry.category, half)) {
            Label {
                HStack {
                    Text(entry.label)
                    Spacer()
                    Text("\(entry.count)").foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: entry.category.systemImage)
            }
        }
    }

    private func folderRow(_ folder: DocsSummary.FolderCount) -> some View {
        NavigationLink(value: MobileDocsSelection.folder(folder.path, folder.title)) {
            Label {
                HStack {
                    Text(folder.title)
                    Spacer()
                    Text("\(folder.count)").foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: "folder")
            }
        }
        .contextMenu {
            if let stableFolder = tree.first(where: { $0.path == folder.path }) {
                MobileFavoriteAction(target: FavoriteTarget(kind: .docsFolder, targetRef: stableFolder.id))
            }
        }
    }

    private func subjectRow(_ group: DocsSubjectGroup, systemImage: String) -> some View {
        NavigationLink(value: MobileDocsSelection.subject(
            group.subject.docsSubject?.kind ?? group.subject.kind, group.subject.id, group.subject.title
        )) {
            Label {
                HStack {
                    Text(group.subject.title)
                    Spacer()
                    Text("\(group.count)").foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: systemImage)
            }
        }
    }

    /// Docs comes with the Meet session: progress while it links, a red
    /// reason with Retry when it cannot.
    private var connect: some View {
        DocsLinkStatusView(session: docs)
    }

    private func loadRail() async {
        // Last known first (docs/CACHING.md): the counts and the groups paint
        // from the last snapshot before Docs and Core answer.
        if summary == nil, let cached = docs.client.cachedSummary() {
            summary = cached
        }
        if projectGroups.isEmpty, leadGroups.isEmpty, let credentials = app.ownerCredentials,
           let written = docs.client.cachedDocuments(.written()) {
            if let projects = cachedSubjects(.project, credentials: credentials) {
                projectGroups = DocsRailGroups.groups(written: written, subjects: projects, kind: .project)
            }
            if let leads = cachedSubjects(.lead, credentials: credentials) {
                leadGroups = DocsRailGroups.groups(written: written, subjects: leads, kind: .lead)
            }
        }
        do {
            summary = try await docs.client.summary()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        // Best effort: without the tree, Folders lists only folders that
        // hold something.
        tree = (try? await docs.client.tree()) ?? tree
        // Best effort: signed out of Meet, or a CRM that is off, leaves the
        // rail with Recent and the categories, nothing worse.
        guard let credentials = app.ownerCredentials else {
            projectGroups = []
            leadGroups = []
            partnerGroups = []
            return
        }
        do {
            async let written = docs.client.allDocuments(.written())
            async let projects = app.api.crmSubjects(credentials: credentials, kind: .project, query: "")
            async let leads = app.api.crmSubjects(credentials: credentials, kind: .lead, query: "")
            let documents = try await written
            self.projects = try await projects
            self.leads = try await leads
            projectGroups = DocsRailGroups.groups(written: documents, subjects: self.projects, kind: .project)
            leadGroups = DocsRailGroups.groups(written: documents, subjects: self.leads, kind: .lead)
            // Best effort beside the others: a partner is filed under its
            // organization, so Docs never sees the kind "partner".
            let partners = (try? await app.api.crmSubjects(credentials: credentials, kind: .organization, query: "")) ?? []
            self.partners = partners
            partnerGroups = Self.partnerGroups(written: documents, partners: partners)
        } catch {
            projectGroups = []
            leadGroups = []
            partnerGroups = []
        }
    }

    /// One row per partner something is written about. Docs holds the subject
    /// as `organization:<id>` (`CrmSubject.docsSubject`), so this counts by
    /// that kind rather than `DocsRailGroups.groups`, which matches on the
    /// Work kind.
    private static func partnerGroups(written: [DocsDocumentSummary], partners: [CrmSubject]) -> [DocsSubjectGroup] {
        var counts: [String: Int] = [:]
        for document in written {
            for subject in document.subjects where subject.kind == "organization" {
                counts[subject.subjectId, default: 0] += 1
            }
        }
        let byID = Dictionary(partners.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return counts
            .compactMap { id, count in byID[id].map { DocsSubjectGroup(subject: $0, count: count) } }
            .sorted { ($1.count, $0.subject.title.lowercased()) < ($0.count, $1.subject.title.lowercased()) }
    }

    private func cachedSubjects(_ kind: MeetingCategoryKind.SubjectKind, credentials: MobileOwnerCredentials) -> [CrmSubject]? {
        app.api.snapshot(
            StarlingsAPI.subjectsSnapshotKey(kind: kind, query: "", status: nil),
            credentials: credentials, as: CrmSubjectsResponse.self
        )?.value.subjects
    }
}

private struct MobileDocsGraphScreen: View {
    @EnvironmentObject private var docs: DocsSession
    let onOpen: (DocsDocumentSummary) -> Void

    var body: some View {
        DocsGraphPane(client: docs.client, onOpen: onOpen)
            .navigationTitle("Graph")
            .meetSurfaceBackground()
    }
}

enum MobileDocsSelection: Hashable {
    case graph
    case recent
    case links
    /// Documents nobody filed.
    case unfiled
    /// One category on one half of the rail (docs/DOCS.md, "The rail").
    case category(DocsCategory, DocsRailHalf)
    /// Every document about one project or lead: kind, id, title.
    case subject(String, String, String)
    case folder(String, String)
    case search(String)

    var title: String {
        switch self {
        case .graph: DocsSelectionWords.graphTitle
        case .recent: DocsSelectionWords.recentTitle
        case .links: DocsSelectionWords.linksTitle
        case .unfiled: DocsSelectionWords.unfiledTitle
        case .category(let category, _): category.fallbackLabel
        case .subject(_, _, let title): title
        case .folder(_, let title): title
        case .search(let query): "“\(query)”"
        }
    }

    /// The list read behind the row, or nil for a search, which is never
    /// snapshotted: a query is typed, not returned to.
    var read: DocsListRead? {
        switch self {
        case .graph: nil
        case .recent: .recent(limit: 200)
        case .links: .links()
        case .unfiled: .unfiled()
        case .category(let category, let half): .categoryOnHalf(category, half)
        case .subject(let kind, let id, _): .about(DocsSubject(kind: kind, subjectId: id))
        case .folder(let path, _): .underPrefix(path)
        case .search: nil
        }
    }
}

/// One view or folder as a list. New files into the folder when there is
/// one, `/work` otherwise.
struct MobileDocsListView: View {
    let selection: MobileDocsSelection
    /// What the File menu on a row files into.
    var filing = DocsFilingChoices()
    @EnvironmentObject private var docs: DocsSession
    @State private var documents: [DocsDocumentSummary] = []
    @State private var loaded = false
    @State private var errorMessage: String?
    @State private var creating = false
    @State private var newTitle = ""
    @State private var newCategory: DocsCategory?
    @State private var pushed: DocsDocumentSummary?
    @State private var renaming: DocsDocumentSummary?
    @State private var renameTitle = ""
    @State private var savingLink = false
    @Environment(\.meetToast) private var toast

    var body: some View {
        Group {
            if let errorMessage {
                EnvisioningRetryState(String(localized: "Couldn’t load"), message: errorMessage) { Task { await load() } }
            } else if !loaded {
                StarlingsList { EnvisioningPlaceholderRows(count: 5) }
            } else if documents.isEmpty {
                EnvisioningEmptyState(String(localized: "Nothing here"), systemImage: "doc.text", message: emptyMessage)
            } else {
                DocumentList(
                    documents: documents,
                    rowMenu: { document in
                        AnyView(Group {
                            DocumentRowMenu(
                            document: document, onOpen: { pushed = $0 }, onToast: { toast($0) },
                            onRename: { renameTitle = $0.title; renaming = $0 },
                            onArchive: { document in Task { await archive(document) } },
                            filing: filing,
                            onFile: { document, act in Task { await file(document, act) } })
                            MobileFavoriteAction(target: FavoriteTarget(kind: .docsDocument, targetRef: document.id))
                        })
                    },
                    onOpen: { pushed = $0 })
            }
        }
        .navigationTitle(title)
        .environment(\.docsCategories, categories)
        .meetSurfaceBackground()
        .toolbar {
            if canSaveLink {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { savingLink = true } label: { Image(systemName: "link") }
                        .accessibilityLabel("Save link")
                }
            }
            if canCreate {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { creating = true } label: { Image(systemName: "plus") }
                        .meetToolbarProminent()
                        .accessibilityLabel("New document")
                }
            }
        }
        .sheet(isPresented: $creating) {
            NewDocumentSheet(title: $newTitle, category: $newCategory, note: String(localized: "Filed in \(folderPath).")) {
                Task { await create() }
            }
            .environment(\.docsCategories, categories)
            .meetDrawer()
        }
        .sheet(isPresented: $savingLink) {
            MobileDocsLinkSaveSheet(folderPath: linkSaveFolderPath, subjects: linkSubjects) { document in
                pushed = document
                Task { await load() }
            }
            .meetDrawer()
        }
        .alert("Rename", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Title", text: $renameTitle)
            Button("Rename") {
                guard let document = renaming else { return }
                let title = renameTitle
                Task { await rename(document, to: title) }
            }
            Button("Cancel", role: .cancel) {}
        }
        .navigationDestination(item: $pushed) { document in
            MobileDocumentEditor(documentID: document.id, title: document.title)
        }
        .task(id: selection) { await load() }
        .refreshable { await load() }
    }

    /// The chosen folder, under the chosen subject (docs/DOCS.md, "Default
    /// path"), or `/work` for a view.
    private var folderPath: String {
        switch selection {
        case .folder(let path, _): path
        case .subject(let kind, _, let title): DocsRailGroups.folderPath(kind: kind, title: title)
        default: "/work"
        }
    }

    private var newSubjects: [DocsSubject] {
        if case .subject(let kind, let id, _) = selection { return [DocsSubject(kind: kind, subjectId: id)] }
        return []
    }

    /// Subject lists file a save there; other views use Docs' default link folder.
    private var linkSaveFolderPath: String? {
        if case .subject(let kind, _, let title) = selection {
            return DocsRailGroups.folderPath(kind: kind, title: title)
        }
        return nil
    }

    private var linkSubjects: [DocsSubject] { newSubjects }

    private var canSaveLink: Bool {
        if case .graph = selection { return false }
        if case .category(_, .library) = selection { return false }
        return true
    }

    private var canCreate: Bool {
        switch selection {
        case .search, .links, .graph: false
        // LIBRARY is a mirror: nothing is written there.
        case .category(_, let half): half == .work
        default: true
        }
    }

    /// The workspace's categories, from the summary the rail last loaded.
    private var categories: [DocsCategoryInfo] { docs.client.cachedSummary()?.categoryList ?? [] }

    private var title: String {
        if case .category(let category, _) = selection { return categories.label(for: category) }
        return selection.title
    }

    private var emptyMessage: String {
        switch selection {
        case .graph: DocsSelectionWords.graphEmpty
        case .search(let query): String(localized: "No document mentions “\(query)”.")
        case .recent: DocsSelectionWords.recentEmpty
        case .links: DocsSelectionWords.linksEmpty
        case .unfiled: DocsSelectionWords.unfiledEmpty
        case .category(let category, _): String(localized: "No \(categories.label(for: category).lowercased()) yet.")
        case .subject: DocsSelectionWords.subjectEmpty
        case .folder: DocsSelectionWords.folderEmpty
        }
    }

    private func load() async {
        // Last known first (docs/CACHING.md): the row's last list paints
        // before Docs answers.
        if !loaded, let read = selection.read, let cached = docs.client.cachedDocuments(read) {
            documents = cached
            loaded = true
        }
        do {
            if case .search(let query) = selection {
                documents = try await docs.client.search(query, limit: 100).map { hit in
                    DocsDocumentSummary(
                        id: hit.id, path: hit.path, slug: String(hit.path.split(separator: "/").last ?? ""), title: hit.title,
                        kind: hit.kind, visibility: "internal", status: "active", sourceSystem: hit.sourceSystem,
                        sourceKind: hit.sourceKind, sourceUrl: nil, editable: hit.sourceSystem == "native", version: 1,
                        byteSize: 0, contentHash: "", tags: [], category: nil, subjects: [], createdAt: hit.updatedAt,
                        updatedAt: hit.updatedAt, updatedBy: nil, excerpt: nil)
                }
            } else if let read = selection.read {
                documents = try await docs.client.allDocuments(read)
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        loaded = true
    }

    private func rename(_ document: DocsDocumentSummary, to title: String) async {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title != document.title else { return }
        do {
            _ = try await docs.client.update(id: document.id, DocsUpdateDocument(title: title))
            await load()
        } catch {
            toast(error.localizedDescription, tone: .danger)
        }
    }

    private func file(_ document: DocsDocumentSummary, _ act: DocsFilingAct) async {
        do {
            let changed = try await docs.client.file([document], act)
            guard changed > 0 else { return }
            toast(DocsRailGroups.filedMessage(act, changed: changed, choices: filing))
            await load()
        } catch {
            toast(error.localizedDescription, tone: .danger)
        }
    }

    private func archive(_ document: DocsDocumentSummary) async {
        do {
            _ = try await docs.client.archive(id: document.id)
            documents.removeAll { $0.id == document.id }
        } catch {
            toast(error.localizedDescription, tone: .danger)
        }
    }

    private func create() async {
        let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        defer { newTitle = "" }
        do {
            let created = try await docs.client.create(
                DocsCreateDocument(
                    title: title, folderPath: folderPath, category: newCategory, subjects: newSubjects,
                    message: String(localized: "Created from Starlings")))
            documents.insert(created.summary, at: 0)
            pushed = created.summary
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// A short, explicit capture flow for URLs. Meet's Worker reads page metadata
/// and the cover; the saved document keeps the member's notes, not page text.
private struct MobileDocsLinkSaveSheet: View {
    let folderPath: String?
    let subjects: [DocsSubject]
    let onSaved: (DocsDocumentSummary) -> Void

    @EnvironmentObject private var app: StarlingsAppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.meetToast) private var toast
    @State private var address = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var url: URL? {
        guard let url = DocsLinks.url(fromPasted: address),
              url.scheme?.lowercased() == "https",
              url.host != nil else { return nil }
        return url
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        TextField("Paste or enter an HTTPS link", text: $address)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityLabel("Link URL")
                        PasteButton(payloadType: String.self) { values in
                            if let pasted = values.first { address = pasted }
                        }
                        .accessibilityLabel("Paste link")
                    }
                } header: {
                    Text("Link")
                } footer: {
                    Text("Saved links are visible to everyone in the workspace.")
                }
                if let errorMessage {
                    Section {
                        Text(errorMessage).foregroundStyle(StarlingsMobileColors.danger)
                    }
                }
            }
            .navigationTitle("Save link")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if isSaving { ProgressView() } else { Text("Save") }
                    }
                    .disabled(isSaving || url == nil)
                }
            }
        }
        .disabled(isSaving)
    }

    private func save() async {
        guard let url else {
            errorMessage = String(localized: "Enter a valid HTTPS URL.")
            return
        }
        guard let owner = app.ownerCredentials else {
            errorMessage = String(localized: "Sign in to Starlings before saving a link.")
            return
        }
        isSaving = true
        defer { isSaving = false }
        do {
            let saved = try await app.api.saveDocsLink(
                url: url, folderPath: folderPath, subjects: subjects, credentials: owner
            )
            if saved.link?.fetchStatus == "failed" {
                toast(String(localized: "Saved. The page did not load."), tone: .danger)
            } else {
                toast(String(localized: "Link saved"))
            }
            onSaved(saved.summary)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// The editor, pushed. Core's registry names the subject chips when Core is
/// connected; otherwise they read by kind.
struct MobileDocumentEditor: View {
    let documentID: String
    let title: String
    @EnvironmentObject private var app: StarlingsAppModel
    @EnvironmentObject private var docs: DocsSession
    @EnvironmentObject private var core: CoreSession

    var body: some View {
        DocumentEditor(
            documentID: documentID,
            client: docs.client,
            directory: core.isLinked ? CoreSubjectDirectory(repository: core.repository, contracts: core.contracts) : nil
        )
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .meetSurfaceBackground()
        // The share sheet's "Share on the organisation's site" is a system Toggle,
        // and the app's neutral tint would paint it white on white.
        .meetToggleTint()
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                MobileFavoriteButton(target: FavoriteTarget(kind: .docsDocument, targetRef: documentID))
            }
        }
        // Opened by hand: into the device's recents, the list Home's Quick Access
        // module and the search sheet share. The editor knows the id and
        // the title; the palette's own door already wrote the same row.
        .onAppear {
            SearchRecents.remember(.document(id: documentID, title: title), owner: app.ownerCredentials?.owner.email ?? "")
        }
    }
}

/// Every document about a subject, on the subject page — the same pane the
/// Mac shows beside Fields.
struct MobileSubjectDocumentsView: View {
    let subject: CrmSubject
    @EnvironmentObject private var docs: DocsSession
    @State private var pushed: DocsDocumentSummary?
    @State private var savingLink = false
    @Environment(\.meetToast) private var toast

    var body: some View {
        Group {
            if docs.isLinked {
                DocumentsPane(
                    subject: subject.docsSubject ?? DocsSubject(kind: subject.kind, subjectId: subject.id),
                    subjectSlug: MobileDocsPaths.slug(subject.title),
                    client: docs.client,
                    onOpen: { pushed = $0 },
                    onToast: { toast($0) }
                )
            } else {
                DocsLinkStatusView(
                    session: docs,
                    headline: String(localized: "Documents about this \(subject.kind) live in Docs.")
                )
            }
        }
        .navigationDestination(item: $pushed) { document in
            MobileDocumentEditor(documentID: document.id, title: document.title)
        }
        .toolbar {
            if docs.isLinked {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { savingLink = true } label: { Image(systemName: "link") }
                        .accessibilityLabel("Save link")
                }
            }
        }
        .sheet(isPresented: $savingLink) {
            MobileDocsLinkSaveSheet(
                folderPath: DocsRailGroups.folderPath(kind: subject.docsSubject?.kind ?? subject.kind, title: subject.title),
                subjects: [subject.docsSubject ?? DocsSubject(kind: subject.kind, subjectId: subject.id)]
            ) { document in
                pushed = document
            }
            .meetDrawer()
        }
    }
}

enum MobileDocsPaths {
    /// One slug rule for every client: `DocsRailGroups.slug`.
    static func slug(_ title: String) -> String { DocsRailGroups.slug(title) }
}
