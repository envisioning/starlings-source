import AppKit
import Combine
import DocsKit
import DocsUI
import EnvisioningUI
import SwiftUI

/// The Docs window's state: what is chosen on the rail, what the middle
/// column lists for it, and which document is open beside it. One object,
/// owned by the window, read by two hosted SwiftUI columns. See docs/DOCS.md.
@MainActor
final class DocsBrowserModel: ObservableObject {
    /// One row of the rail. Search is not a row — the toolbar field puts the
    /// browser into `.search` and clearing it puts it back where it was.
    enum Selection: Hashable {
        case graph
        case recent
        /// Documents nobody filed.
        case unfiled
        /// Link saves: marked by `source_kind`, drawn as cards.
        case links
        /// One category on one half of the rail: Core's briefs and a person's
        /// briefs are two rows (docs/DOCS.md, "The rail").
        case category(DocsCategory, DocsRailHalf)
        /// Every document about one project or lead — a By project / By lead row.
        case subject(kind: String, id: String, title: String)
        case folder(String)
        case search(String)

        var title: String {
            switch self {
            case .graph: DocsSelectionWords.graphTitle
            case .recent: DocsSelectionWords.recentTitle
            case .unfiled: DocsSelectionWords.unfiledTitle
            case .links: DocsSelectionWords.linksTitle
            case .category(let category, _): category.fallbackLabel
            case .subject(_, _, let title): title
            case .folder(let path): path.split(separator: "/").last.map(String.init)?.capitalized ?? String(localized: "Docs")
            case .search(let query): "“\(query)”"
            }
        }

        /// A safe label for diagnostics; it intentionally excludes search
        /// text, subject IDs, folder paths, and document titles.
        var diagnosticKind: String {
            switch self {
            case .graph: "graph"
            case .recent: "recent"
            case .unfiled: "unfiled"
            case .links: "links"
            case .category(_, _): "category"
            case .subject(_, _, _): "subject"
            case .folder(_): "folder"
            case .search(_): "search"
            }
        }

        /// The list read behind the row, or nil for a search, which is
        /// never snapshotted: a query is typed, not returned to.
        var read: DocsListRead? {
            switch self {
            case .graph: nil
            case .recent: .recent(limit: 200)
            case .unfiled: .unfiled()
            case .links: .links()
            case .category(let category, let half): .categoryOnHalf(category, half)
            case .subject(let kind, let id, _): .about(DocsSubject(kind: kind, subjectId: id))
            case .folder(let path): .underPrefix(path)
            case .search: nil
            }
        }
    }

    /// The projects and leads the rail can name, from the CRM through the Worker.
    typealias SubjectSource = @Sendable (MeetingCategoryKind.SubjectKind) async throws -> [CrmSubject]
    /// The same, from the last snapshot, without a request (docs/CACHING.md).
    typealias SubjectSnapshot = @MainActor (MeetingCategoryKind.SubjectKind) -> [CrmSubject]?
    /// Saves a URL through Meet's Worker, which reads the page (
    /// decision 13): the URL, the folder (nil for Docs' default) and the subjects.
    typealias LinkSaver = @Sendable (URL, String?, [DocsSubject]) async throws -> DocsDocumentDetail

    let session: DocsSession
    private let subjectSource: SubjectSource?
    private let subjectSnapshot: SubjectSnapshot?
    private let linkSaver: LinkSaver?
    @Published var selection: Selection = .recent
    @Published private(set) var summary: DocsSummary?
    @Published private(set) var folders: [DocsFolder] = []
    /// By project / By lead, from Meet's own documents and the CRM's names.
    @Published private(set) var projectGroups: [DocsSubjectGroup] = []
    @Published private(set) var leadGroups: [DocsSubjectGroup] = []
    @Published private(set) var partnerGroups: [DocsSubjectGroup] = []
    /// Every project and lead the CRM names: what the File menu files onto.
    @Published private(set) var projects: [CrmSubject] = []
    @Published private(set) var leads: [CrmSubject] = []
    /// Partners are organizations to Docs: filed and read as `organization`.
    @Published private(set) var partners: [CrmSubject] = []
    @Published private(set) var documents: [DocsDocumentSummary] = []
    @Published private(set) var loading = false
    /// The list's last failure. The rail's is `railErrorMessage`: a list
    /// that loads must not clear what the summary said.
    @Published private(set) var errorMessage: String?
    @Published private(set) var railErrorMessage: String?
    @Published var openDocumentID: String?
    /// The list rows chosen for a bulk act. Cleared when the rail
    /// changes; trimmed to what the list still holds when it reloads.
    @Published var chosenIDs: Set<String> = []
    /// A paste or a drop is being read by Docs; the page fetch takes seconds.
    @Published private(set) var savingLink = false
    /// Where the rail was before a search, so clearing the field goes back.
    private var beforeSearch: Selection = .recent
    private var cancellables: Set<AnyCancellable> = []

    init(
        session: DocsSession,
        subjectSource: SubjectSource? = nil,
        subjectSnapshot: SubjectSnapshot? = nil,
        linkSaver: LinkSaver? = nil
    ) {
        self.session = session
        self.subjectSource = subjectSource
        self.subjectSnapshot = subjectSnapshot
        self.linkSaver = linkSaver
        $selection
            .removeDuplicates()
            .sink { [weak self] _ in
                self?.chosenIDs = []
                Task { await self?.loadList() }
            }
            .store(in: &cancellables)
    }

    /// The rail's counts and the folders Move to offers, one request each.
    /// Called on open and after anything that changes counts.
    func loadRail() async {
        DocsDiagnostics.event("rail load started")
        // Last known first (docs/CACHING.md): the counts and the groups paint
        // from the last snapshot before Docs and Core answer.
        if summary == nil, let cached = session.client.cachedSummary() {
            summary = cached
            DocsDiagnostics.event("rail summary cache applied")
        }
        if projectGroups.isEmpty, leadGroups.isEmpty, partnerGroups.isEmpty, let subjectSnapshot,
           let written = session.client.cachedDocuments(.written()) {
            if let projects = subjectSnapshot(.project) {
                self.projects = projects
                projectGroups = DocsRailGroups.groups(written: written, subjects: projects, kind: .project)
                DocsDiagnostics.count("cached project groups", projectGroups.count)
            }
            if let leads = subjectSnapshot(.lead) {
                self.leads = leads
                leadGroups = DocsRailGroups.groups(written: written, subjects: leads, kind: .lead)
                DocsDiagnostics.count("cached lead groups", leadGroups.count)
            }
            if let partners = subjectSnapshot(.organization) {
                self.partners = partners
                partnerGroups = DocsRailGroups.groups(written: written, subjects: partners, kind: .organization)
            }
        }
        do {
            async let summary = session.client.summary()
            async let folders = session.client.tree()
            self.summary = try await summary
            self.folders = try await folders
            railErrorMessage = nil
            DocsDiagnostics.count("rail folders loaded", self.folders.count)
        } catch {
            railErrorMessage = error.localizedDescription
            DocsDiagnostics.failure("Docs rail metadata", error: error)
        }
        // Best effort: a CRM that is off leaves the rail with Recent and the
        // categories, nothing worse.
        guard let subjectSource else {
            DocsDiagnostics.event("rail CRM source unavailable")
            return
        }
        DocsDiagnostics.event("rail CRM refresh started")
        do {
            async let written = session.client.allDocuments(.written())
            async let projects = subjectSource(.project)
            async let leads = subjectSource(.lead)
            async let partners = subjectSource(.organization)
            let documents = try await written
            self.projects = try await projects
            self.leads = try await leads
            // Partners are best effort on their own: a Worker that predates
            // them must not blank the project and lead rows.
            self.partners = (try? await partners) ?? []
            projectGroups = DocsRailGroups.groups(written: documents, subjects: self.projects, kind: .project)
            leadGroups = DocsRailGroups.groups(written: documents, subjects: self.leads, kind: .lead)
            partnerGroups = DocsRailGroups.groups(written: documents, subjects: self.partners, kind: .organization)
            DocsDiagnostics.count("rail written documents", documents.count)
            DocsDiagnostics.count("rail CRM projects", self.projects.count)
            DocsDiagnostics.count("rail CRM leads", self.leads.count)
            DocsDiagnostics.count("rail project groups", projectGroups.count)
            DocsDiagnostics.count("rail lead groups", leadGroups.count)
        } catch {
            projectGroups = []
            leadGroups = []
            partnerGroups = []
            DocsDiagnostics.failure("Docs rail CRM refresh", error: error)
        }
        DocsDiagnostics.event("rail load finished")
    }

    func loadList() async {
        let diagnosticKind = selection.diagnosticKind
        DocsDiagnostics.event("list load started: \(diagnosticKind)")
        // The row's last list, or nothing: the previous row's documents are
        // not this row's.
        documents = selection.read.flatMap { session.client.cachedDocuments($0) } ?? []
        loading = true
        defer { loading = false }
        // Every row of the read, not the first page: Docs caps one list at
        // 200 and a Recent of five hundred transcripts stopped at that.
        do {
            documents = switch selection {
            case .graph: []
            case .search(let query): try await session.client.search(query, limit: 100).map(\.summary)
            default: try await session.client.allDocuments(selection.read!)
            }
            chosenIDs.formIntersection(documents.map(\.id))
            errorMessage = nil
            DocsDiagnostics.count("list rows loaded", documents.count)
        } catch {
            errorMessage = error.localizedDescription
            DocsDiagnostics.failure("Docs list load: \(diagnosticKind)", error: error)
        }
        DocsDiagnostics.event("list load finished: \(diagnosticKind)")
    }

    func search(_ query: String) {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            if case .search = selection { selection = beforeSearch }
            return
        }
        if case .search = selection {} else { beforeSearch = selection }
        selection = .search(trimmed)
    }

    /// Where New files a document: the chosen folder, under the chosen subject
    /// (docs/DOCS.md, "Default path"), or `/work` for a view.
    var newDocumentFolder: String {
        switch selection {
        case .folder(let path): path
        case .subject(let kind, _, let title): DocsRailGroups.folderPath(kind: kind, title: title)
        default: "/work"
        }
    }

    /// What New attaches: the chosen subject, when the list is a subject's.
    private var newDocumentSubjects: [DocsSubject] {
        if case .subject(let kind, let id, _) = selection { return [DocsSubject(kind: kind, subjectId: id)] }
        return []
    }

    func create(title: String, category: DocsCategory?) async throws -> DocsDocumentSummary {
        let created = try await session.client.create(
            DocsCreateDocument(
                title: title, folderPath: newDocumentFolder, category: category,
                subjects: newDocumentSubjects, message: String(localized: "Created from Starlings")))
        await loadList()
        await loadRail()
        return created.summary
    }

    /// Save a URL as a link save. On a subject's list it is filed on that
    /// subject, in the subject's folder; anywhere else Docs files it under
    /// `DocsLinks.folder`. Saving a page saved before answers that save.
    func saveLink(_ url: URL) async throws -> DocsDocumentSummary {
        guard let linkSaver else { throw StarlingsError.invalidResponse(operation: String(localized: "Couldn’t save that link")) }
        savingLink = true
        defer { savingLink = false }
        let folder: String? = if case .subject = selection { newDocumentFolder } else { nil }
        let saved = try await linkSaver(url, folder, newDocumentSubjects)
        await loadList()
        await loadRail()
        return saved.summary
    }

    func archive(_ documents: [DocsDocumentSummary]) async throws {
        do {
            for document in documents {
                // Through the open editors: one open on this document saves
                // first, and every window and inspector on it closes.
                try await DocsOpenEditors.shared.archive(document.id, client: session.client)
                if openDocumentID == document.id { openDocumentID = nil }
            }
        } catch {
            await reloadAfterFiling()
            throw error
        }
        await reloadAfterFiling()
    }

    /// An open editor takes the new title and saves it with its own hash, so
    /// the rename never conflicts with it; the windows retitle on the notice.
    func rename(_ document: DocsDocumentSummary, to title: String) async throws {
        try await DocsOpenEditors.shared.rename(document.id, to: title, client: session.client)
        await loadList()
    }

    /// Folders that could hold a moved document: every one but the mirrored shelves.
    var moveTargets: [DocsFolder] {
        DocsRailGroups.moveTargets(folders)
    }

    /// The rail's FOLDERS rows.
    var railFolders: [DocsSummary.FolderCount] {
        DocsRailGroups.folders(summary: summary?.folders ?? [], tree: folders)
    }

    // MARK: Filing

    /// The chosen documents, in list order, when more than one is chosen.
    var chosen: [DocsDocumentSummary] {
        chosenIDs.count > 1 ? documents.filter { chosenIDs.contains($0.id) } : []
    }

    /// What a dragged list row carries: the row, or every chosen document
    /// Meet can change when the row is one of them. A mirrored row does not drag.
    func dragToken(_ document: DocsDocumentSummary) -> String? {
        guard document.editable else { return nil }
        let ids = chosenIDs.contains(document.id) && chosenIDs.count > 1
            ? chosen.filter(\.editable).map(\.id)
            : [document.id]
        return Self.dragPrefix + ids.joined(separator: ",")
    }

    private static let dragPrefix = "meet-docs-document:"

    /// The listed documents a drag token names, when they can be filed on
    /// the row `onto` names; empty when they cannot.
    func documentsForDrop(_ token: String, onto target: Selection) -> [DocsDocumentSummary] {
        guard token.hasPrefix(Self.dragPrefix), accepts(target) else { return [] }
        let ids = Set(token.dropFirst(Self.dragPrefix.count).split(separator: ",").map(String.init))
        return documents.filter { ids.contains($0.id) && $0.editable }
    }

    private func accepts(_ target: Selection) -> Bool {
        switch target {
        case .folder(let path): moveTargets.contains { $0.path == path }
        case .subject, .category(_, .work): true
        default: false
        }
    }

    /// Files documents on a rail row: a folder moves them, a
    /// subject is attached (the path stays; the subject is the relation), a
    /// WORK category is set.
    func file(_ documents: [DocsDocumentSummary], onto target: Selection) async throws -> String? {
        guard accepts(target), let act = Self.act(target) else { return nil }
        return try await file(documents, act)
    }

    private static func act(_ target: Selection) -> DocsFilingAct? {
        switch target {
        case .folder(let path): .folder(path)
        case .subject(let kind, let id, _): .addSubject(DocsSubject(kind: kind, subjectId: id))
        case .category(let category, .work): .category(category)
        default: nil
        }
    }

    /// Files documents by one act — a rail drop or the File menu.
    /// Answers what it did, or nil when every document was already so.
    func file(_ documents: [DocsDocumentSummary], _ act: DocsFilingAct) async throws -> String? {
        let changed: Int
        do {
            changed = try await session.client.file(documents, act)
        } catch {
            await reloadAfterFiling()
            throw error
        }
        guard changed > 0 else { return nil }
        await reloadAfterFiling()
        return DocsRailGroups.filedMessage(act, changed: changed, choices: filingChoices)
    }

    /// What the File menu offers.
    /// The open view's title; a category takes the label Docs gave it.
    var selectionTitle: String {
        if case .category(let category, _) = selection { return categoryLabel(category) }
        return selection.title
    }

    func categoryLabel(_ category: DocsCategory) -> String {
        summary?.label(for: category) ?? category.fallbackLabel
    }

    var filingChoices: DocsFilingChoices {
        DocsRailGroups.filingChoices(
            tree: folders, categories: summary?.categoryList ?? [], projects: projects, leads: leads, partners: partners
        )
    }

    private func reloadAfterFiling() async {
        await loadList()
        await loadRail()
    }
}

// MARK: - Middle column

/// What the rail chose, as a list. A header names it; the rows are the one
/// renderer every list shares; a row's menu holds the things done to a file.
struct DocsListColumn: View {
    @ObservedObject var model: DocsBrowserModel
    @ObservedObject var favorites: StarredWatch
    let onOpen: (DocsDocumentSummary) -> Void
    /// A URL pasted or dropped here becomes a link save; the host saves it.
    let onSaveLink: (URL) -> Void
    /// Open a document in a window of its own. Nil offers nothing.
    var onFloat: ((DocsDocumentSummary) -> Void)?
    @Environment(\.meetToast) private var toast

    @State private var renaming: DocsDocumentSummary?
    @State private var newTitle = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(model.selectionTitle).font(.title3.weight(.semibold))
                Text(countLine).foregroundStyle(.secondary).font(.footnote)
                Spacer()
                if model.savingLink {
                    ProgressView().controlSize(.small)
                }
                if model.selection == .links {
                    Button(String(localized: "Paste link")) {
                        if let url = DocsLinkPasteboard.url() { onSaveLink(url) } else { toast(String(localized: "Copy a link first.")) }
                    }
                    .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 28, expands: false))
                    .disabled(model.savingLink)
                    .help(String(localized: "Save the link on the clipboard (⌘V)"))
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            Divider()
            if model.selection == .graph {
                DocsGraphPane(client: model.session.client, selectedID: model.openDocumentID, onOpen: onOpen)
            } else if let errorMessage = model.errorMessage {
                EnvisioningRetryState(String(localized: "Couldn’t load"), message: errorMessage) { Task { await model.loadList() } }
            } else if model.loading && model.documents.isEmpty {
                StarlingsPlaceholderStack()
            } else if model.documents.isEmpty {
                EnvisioningEmptyState(String(localized: "Nothing here"), systemImage: model.selection == .links ? "link" : "doc.text", message: emptyMessage)
            } else if model.selection == .links {
                LinkGrid(
                    documents: model.documents,
                    client: model.session.client,
                    selectedID: model.openDocumentID,
                    cardMenu: { document in AnyView(rowMenu(document)) },
                    onOpen: onOpen
                )
            } else {
                DocumentList(
                    documents: model.documents,
                    selectedID: model.openDocumentID,
                    rowMenu: { document in
                        model.chosen.contains(where: { $0.id == document.id }) ? AnyView(chosenMenu) : AnyView(rowMenu(document))
                    },
                    dragToken: { model.dragToken($0) },
                    selection: $model.chosenIDs,
                    onOpen: onOpen
                )
            }
        }
        // A link dragged in from a browser saves, on any list: on a subject's
        // it is filed on that subject.
        .dropDestination(for: URL.self) { urls, _ in
            guard let url = urls.first(where: { DocsLinks.url(fromPasted: $0.absoluteString) != nil }) else { return false }
            onSaveLink(url)
            return true
        }
        .environment(\.docsCategories, model.summary?.categoryList ?? [])
        .alert("Rename", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Title", text: $newTitle)
            Button("Rename") {
                guard let document = renaming else { return }
                let title = newTitle
                Task { do { try await model.rename(document, to: title) } catch { toast(error.localizedDescription, tone: .danger) } }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var countLine: String {
        if model.loading { return "" }
        let chosen = model.chosen.count
        return chosen > 1 ? String(localized: "\(chosen) selected") : "\(model.documents.count)"
    }

    /// The menu over a chosen row: the acts that apply to every chosen
    /// document Meet can change — File and Archive.
    @ViewBuilder
    private var chosenMenu: some View {
        let documents = model.chosen.filter(\.editable)
        if documents.isEmpty {
            Text("Mirrored documents can’t be changed")
        } else {
            DocumentFileMenu(documents: documents, choices: model.filingChoices) { file(documents, $0) }
            Divider()
            Button("Archive \(documents.count)", role: .destructive) {
                Task {
                    do {
                        try await model.archive(documents)
                        model.chosenIDs = []
                    } catch {
                        toast(error.localizedDescription, tone: .danger)
                    }
                }
            }
        }
    }

    private func file(_ documents: [DocsDocumentSummary], _ act: DocsFilingAct) {
        Task {
            do {
                if let done = try await model.file(documents, act) { toast(done) }
            } catch {
                toast(error.localizedDescription, tone: .danger)
            }
        }
    }

    private var emptyMessage: String {
        switch model.selection {
        case .graph: DocsSelectionWords.graphEmpty
        case .search(let query): String(localized: "No document mentions “\(query)”.")
        case .recent: DocsSelectionWords.recentEmpty
        case .unfiled: DocsSelectionWords.unfiledEmpty
        case .links: DocsSelectionWords.linksEmpty
        case .category(let category, _): String(localized: "No \(model.categoryLabel(category).lowercased()) yet.")
        case .subject: DocsSelectionWords.subjectEmpty
        case .folder: DocsSelectionWords.folderEmpty
        }
    }

    @ViewBuilder
    private func rowMenu(_ document: DocsDocumentSummary) -> some View {
        Button("Open") { onOpen(document) }
        Divider()
        let target = FavoriteTarget(kind: .docsDocument, targetRef: document.id)
        Button(String(localized: favorites.contains(target) ? "Unstar" : "Star")) {
            let starred = !favorites.contains(target)
            Task {
                do { try await favorites.setFavorite(target, starred: starred) }
                catch { toast(error.localizedDescription) }
            }
        }
        if let onFloat {
            Button("Open in Floating Window") { onFloat(document) }
        }
        if let page = document.link?.openURL {
            Button("Open page") { NSWorkspace.shared.open(page) }
            Button("Copy page link") {
                DocsPasteboard.copy(page.absoluteString)
                toast(String(localized: "Link copied"))
            }
        } else {
            Button("Copy link") {
                DocsPasteboard.copy(DocsClient.publicLink(path: document.path))
                toast(String(localized: "Link copied"))
            }
        }
        if document.editable {
            Divider()
            DocumentFileMenu(documents: [document], choices: model.filingChoices) { file([document], $0) }
            Button("Rename…") { newTitle = document.title; renaming = document }
            Divider()
            Button("Archive", role: .destructive) {
                Task { do { try await model.archive([document]) } catch { toast(error.localizedDescription, tone: .danger) } }
            }
        }
    }
}


/// The one http(s) link on the general pasteboard, if that is what it holds:
/// a URL object (a browser's copy) or text that is one link and nothing else.
/// A file URL is not a link save.
enum DocsLinkPasteboard {
    static func url(_ pasteboard: NSPasteboard = .general) -> URL? {
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL],
           let url = urls.first(where: { !$0.isFileURL }).flatMap({ DocsLinks.url(fromPasted: $0.absoluteString) }) {
            return url
        }
        return pasteboard.string(forType: .string).flatMap(DocsLinks.url(fromPasted:))
    }
}
