import AppKit
import Combine
import CoreCRMUI
import DocsKit
import DocsUI
import EnvisioningUI
import SwiftUI

/// Docs is the Mac destination for the corpus: everything Envisioning has
/// written, in one window on the shared shell. Work keeps the contextual
/// slice — the Documents pane on a subject — and this window is the rest:
/// views on the rail, a list in the middle, the editor in the inspector.
/// See docs/DOCS.md.
extension NSToolbarItem.Identifier {
    static let docsSearch = NSToolbarItem.Identifier("meet.docs.search")
}

@MainActor
final class DocsWindowController: NSWindowController, NSToolbarDelegate {
    let docsViewController: DocsViewController
    private let surfaceSwitcher = StarlingsSurfaceSwitcher(surface: .docs)

    init(api: MeetingControlAPI, docs: DocsSession, core: CoreSession, favorites: StarredWatch) {
        let viewController = DocsViewController(api: api, docs: docs, core: core, favorites: favorites)
        docsViewController = viewController
        let window = NSWindow(contentViewController: viewController)
        window.setContentSize(StarlingsSurface.docs.openingContentSize)
        super.init(window: window)
        StarlingsWindowChrome.apply(
            to: window,
            surface: .docs,
            toolbarIdentifier: "MeetDocsToolbar",
            delegate: self
        )
        shouldCascadeWindows = false
        windowFrameAutosaveName = "MeetDocsWindow"
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        StarlingsShellViewController.leadingToolbarItems
            + [.flexibleSpace, .meetNew, .docsSearch]
            + StarlingsShellViewController.trailingToolbarItems
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }

    func toolbar(
        _ toolbar: NSToolbar,
        itemForItemIdentifier identifier: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar flag: Bool
    ) -> NSToolbarItem? {
        switch identifier {
        case .meetSurfaces:
            return surfaceSwitcher.item()
        case .meetSurfacesDivider:
            return StarlingsSurfaceSwitcher.dividerItem()
        case .meetNew:
            let item = NSToolbarItem(itemIdentifier: identifier)
            item.image = NSImage(systemSymbolName: "plus", accessibilityDescription: String(localized: "New document"))
            item.label = String(localized: "New")
            item.toolTip = String(localized: "New document in the open folder (⌘N)")
            item.target = docsViewController
            item.action = #selector(DocsViewController.newDocumentPressed)
            return item
        case .docsSearch:
            return StarlingsSearchField.toolbarItem(identifier, field: docsViewController.searchField, toolTip: String(localized: "Search every document, title and text (⌘F). ⌘K searches anything."))
        default:
            return nil
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show(relativeTo host: NSWindow? = nil) {
        guard let window else { return }
        DocsDiagnostics.event("window show requested")
        if !window.setFrameUsingName(windowFrameAutosaveName), let host {
            window.setFrameOrigin(NSPoint(
                x: host.frame.midX - window.frame.width / 2,
                y: host.frame.midY - window.frame.height / 2
            ))
        }
        StarlingsWindowMetrics.refresh(window)
        docsViewController.prepareForOpening(in: window)
        showWindow(nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        docsViewController.windowDidOpen()
    }
}

@MainActor
final class DocsViewController: StarlingsShellViewController {
    let searchField = StarlingsSearchField()

    private let docs: DocsSession
    private let core: CoreSession
    private let model: DocsBrowserModel
    private let favorites: StarredWatch
    /// The rail column: the AppKit rail while Docs is linked, the SwiftUI
    /// connect card otherwise. One container so the shell's column never
    /// changes view identity when the link state does.
    private let railContainer = NSView()
    private lazy var rail = DocsRailView(model: model, favorites: favorites)
    private let railHost = NSHostingView(rootView: AnyView(EmptyView()))
    private let listHost = NSHostingView(rootView: AnyView(EmptyView()))
    private lazy var inspector = WorkInspectorViewController(api: api, ground: StarlingsColors.canvas, emptyMessage: String(localized: "Choose a document to read or edit it here."))
    private let api: MeetingControlAPI
    private var docsObserver: AnyCancellable?
    private var newSheet: NSWindow?
    private var currentDocumentTitle: String?

    init(api: MeetingControlAPI, docs: DocsSession, core: CoreSession, favorites: StarredWatch) {
        self.api = api
        self.docs = docs
        self.core = core
        self.favorites = favorites
        model = DocsBrowserModel(
            session: docs,
            subjectSource: { [api] kind in try await api.crmSubjects(kind: kind, query: "") },
            subjectSnapshot: { [api] kind in
                api.snapshot(MeetingControlAPI.subjectsSnapshotKey(kind: kind, query: "", status: nil), as: CrmSubjectsResponse.self)?.value.subjects
            },
            linkSaver: { [api] url, folder, subjects in
                try await api.saveDocsLink(url: url, folderPath: folder, subjects: subjects)
            })
        super.init(nibName: nil, bundle: nil)
        // The hosted list is expensive to rebuild: `objectWillChange` also
        // fires for transient linking and error state.
        // Recreate its root only when Docs changes between linked and
        // unlinked; the connect card observes the rest of DocsSession itself.
        docsObserver = docs.$owner
            .map { $0 != nil }
            .removeDuplicates()
            .dropFirst()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in Task { @MainActor in self?.render() } }
        // A rename in the editor, or anywhere, retitles the window and the row.
        NotificationCenter.default.addObserver(
            self, selector: #selector(documentTitleDidChange(_:)),
            name: DocsOpenEditors.titleDidChangeNotification, object: nil
        )
    }

    @objc private func documentTitleDidChange(_ note: Notification) {
        guard let id = note.userInfo?["id"] as? String, let title = note.userInfo?["title"] as? String else { return }
        if model.openDocumentID == id {
            currentDocumentTitle = title
            StarlingsWindowChrome.setContextTitle(for: view.window, surface: .docs, context: title)
        }
        if model.documents.contains(where: { $0.id == id }) {
            Task { await model.loadList() }
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var surfaceSearchField: NSSearchField? { searchField }
    override var documentInspector: WorkInspectorViewController? { inspector }
    override var openingFirstResponder: NSView? { docs.isLinked ? rail : railHost }
    override class var minimumContentHeight: CGFloat { 480 }

    override func viewDidLoad() {
        super.viewDidLoad()
        DocsDiagnostics.event("view controller loaded")
        // The columns size the hosts, never the SwiftUI inside them (AGENTS.md #21).
        railHost.sizingOptions = []
        listHost.sizingOptions = []
        inspector.docsSession = docs
        inspector.coreSession = core

        searchField.configure(placeholder: String(localized: "Search"), target: self, action: #selector(searchChanged(_:)))

        let detail = StarlingsShellPaneViewController(view: StarlingsShellBackdrop(ground: StarlingsColors.canvas))
        listHost.translatesAutoresizingMaskIntoConstraints = false
        detail.view.addSubview(listHost)
        listHost.pinToEdges(of: detail.view)

        railHost.translatesAutoresizingMaskIntoConstraints = false
        rail.translatesAutoresizingMaskIntoConstraints = false
        railContainer.addSubview(railHost)
        railContainer.addSubview(rail)
        railHost.pinToEdges(of: railContainer)
        rail.pinToEdges(of: railContainer)
        railContainer.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        installColumns(sidebar: railContainer, detail: detail, inspector: inspector, columnsName: "MeetDocsSplit")
        render()
    }

    func windowDidOpen() {
        DocsDiagnostics.event("window opened")
        StarlingsWindowChrome.setContextTitle(for: view.window, surface: .docs, context: currentDocumentTitle)
        render()
    }

    /// Both columns are rebuilt from the one model; Docs being unconnected
    /// is a state of the rail, not an empty list.
    private func render() {
        DocsDiagnostics.event("hosted views refreshed; linked=\(docs.isLinked)")
        guard docs.isLinked else {
            railHost.rootView = meetHosted(DocsRailConnect(session: docs))
            railHost.isHidden = false
            rail.isHidden = true
            listHost.rootView = meetHosted(EmptyView())
            return
        }
        railHost.isHidden = true
        rail.isHidden = false
        listHost.rootView = meetHosted(DocsListColumn(
            model: model,
            favorites: favorites,
            onOpen: { [weak self] document in MainActor.assumeIsolated { self?.open(document) } },
            onSaveLink: { [weak self] url in MainActor.assumeIsolated { self?.saveLink(url) } },
            onFloat: { document in MainActor.assumeIsolated { FloatingDocuments.shared.float(id: document.id, title: document.title) } }
        ).environment(\.meetToast, StarlingsToastAction(windowOf: view)))
    }

    /// One document by id — the ⌘K palette's document door. The list keeps
    /// whatever it was on; the inspector reads the document.
    func open(documentID: String, title: String) {
        currentDocumentTitle = title
        model.openDocumentID = documentID
        inspector.show(.document(id: documentID, title: title))
        setInspector(visible: true)
        StarlingsWindowChrome.setContextTitle(for: view.window, surface: .docs, context: title)
    }

    /// Resolve a favorite's durable folder id through Docs' current tree;
    /// the path is mutable and never belongs in the favorite reference.
    func open(folderID: String) {
        Task { @MainActor in
            await model.loadRail()
            guard let folder = model.folders.first(where: { $0.id == folderID }) else { return }
            model.selection = .folder(folder.path)
            currentDocumentTitle = folder.title
            setInspector(visible: false)
            StarlingsWindowChrome.setContextTitle(for: view.window, surface: .docs, context: folder.title)
        }
    }

    private func open(_ document: DocsDocumentSummary) {
        currentDocumentTitle = document.title
        model.openDocumentID = document.id
        inspector.show(.document(id: document.id, title: document.title))
        setInspector(visible: true)
        StarlingsWindowChrome.setContextTitle(for: view.window, surface: .docs, context: document.title)
        // Opened by hand: into the device's recents, the list Home's Quick Access
        // module and the ⌘K palette share.
        SearchRecents.remember(.document(document), owner: api.signedInOwnerEmail ?? "")
    }

    private func toast(_ message: String, tone: StarlingsToastTone = .neutral) {
        StarlingsToast.show(message, tone: tone, in: view.window)
    }

    /// ⌘V with the rail or the list focused: a link on the clipboard becomes
    /// a link save. Inside the editor the text view takes the paste first.
    @objc func paste(_ sender: Any?) {
        guard let url = DocsLinkPasteboard.url() else { NSSound.beep(); return }
        saveLink(url)
    }

    override func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(paste(_:)) {
            return docs.isLinked && !model.savingLink && DocsLinkPasteboard.url() != nil
        }
        return super.validateMenuItem(menuItem)
    }

    /// Docs comes with the owner session. Before it is confirmed, say so and
    /// ask again; a failure shows on the rail beside Retry.
    private func notConnected() {
        toast(String(localized: "Docs isn’t connected."))
        Task { await docs.ensureLinked() }
    }

    private func saveLink(_ url: URL) {
        guard docs.isLinked else { notConnected(); return }
        Task {
            do {
                let saved = try await model.saveLink(url)
                open(saved)
                if saved.link?.fetchStatus == "failed" {
                    toast(String(localized: "Saved. The page did not load."), tone: .danger)
                } else {
                    toast(String(localized: "Link saved"))
                }
            } catch {
                toast(error.localizedDescription, tone: .danger)
            }
        }
    }

    @objc func searchChanged(_ sender: NSSearchField) {
        model.search(sender.stringValue)
    }

    @objc func newDocumentPressed() {
        guard docs.isLinked else { notConnected(); return }
        // The sheet closes itself through this controller. core-kit's
        // `NewDocumentSheet` closes with SwiftUI's `dismiss`, which does
        // nothing under an AppKit `presentAsSheet`: Create left the sheet up and
        // Cancel and Esc were dead.
        var sheet: NSViewController?
        let close = { [weak self] in
            guard let sheet else { return }
            self?.dismiss(sheet)
        }
        let host = NSHostingController(rootView: meetHosted(DocsNewSheet(
            folder: model.newDocumentFolder,
            categories: model.summary?.categoryList ?? [],
            cancel: close
        ) { [weak self] title, category in
            close()
            guard let self else { return }
            Task {
                do {
                    let created = try await self.model.create(title: title, category: category)
                    self.open(created)
                } catch {
                    self.toast(error.localizedDescription, tone: .danger)
                }
            }
        }))
        sheet = host
        presentAsSheet(host)
    }
}

/// Docs' rail before the owner session is confirmed. Docs comes with the
/// Starlings session, so the rail asks on appear; Retry asks again when
/// that fails.
private struct DocsRailConnect: View {
    @ObservedObject var session: DocsSession

    var body: some View {
        DocsLinkStatusView(session: session)
    }
}

/// New, from the toolbar: title and category, filed in the open folder.
/// Cancel, Esc, and Create all end the sheet through the closures the
/// presenter gives it, never through `@Environment(\.dismiss)`.
private struct DocsNewSheet: View {
    let folder: String
    /// The workspace's categories; none is picked unless the person picks one.
    let categories: [DocsCategoryInfo]
    let cancel: () -> Void
    let create: (String, DocsCategory?) -> Void
    @State private var title = ""
    @State private var category: DocsCategory?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("New document").font(.headline)
            TextField("Title", text: $title)
                .coreField()
                .onSubmit { if canCreate { submit() } }
            HStack {
                Text("Category").foregroundStyle(.secondary)
                CategoryPicker(category: $category)
            }
            Text(String(localized: "Filed in \(folder).")).font(.footnote).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("Cancel") { cancel() }
                    .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 32, expands: false))
                    .keyboardShortcut(.cancelAction)
                Button("Create") { submit() }
                    .buttonStyle(StarlingsCTAButtonStyle(minHeight: 32, expands: false))
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canCreate)
            }
        }
        .padding(20)
        .frame(minWidth: 380)
        .environment(\.docsCategories, categories)
    }

    private var canCreate: Bool { !title.trimmingCharacters(in: .whitespaces).isEmpty }

    private func submit() { create(title, category) }
}
