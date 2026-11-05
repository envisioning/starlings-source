import AppKit
import Combine
import DocsKit
import DocsUI
import EnvisioningUI
import SwiftUI

/// Documents open in windows of their own, beside whatever the day is on
///. One window per document, pinned above every app by default,
/// back where it was after a relaunch.
///
/// The registry is the one place that knows what floats, because a document
/// must never have two editors at once: Docs refuses a save whose
/// `content_hash` is stale, so an inspector and a window on the same
/// document would conflict with each other all day. While a document
/// floats, every inspector on it shows a way to the window instead.
@MainActor
final class FloatingDocuments {
    static let shared = FloatingDocuments()
    /// Posted when a document starts or stops floating; `userInfo["id"]` is
    /// the document.
    static let didChangeNotification = Notification.Name("MeetFloatingDocumentsDidChange")

    struct Entry: Codable, Equatable {
        let id: String
        var title: String
        var pinned: Bool
    }

    private static let defaultsKey = "meet.floatingDocuments"

    private var windows: [String: FloatingDocumentWindowController] = [:]
    /// Float order, so a relaunch stacks them the way they were opened.
    private var order: [String] = []
    private let inspectors = NSHashTable<WorkInspectorViewController>.weakObjects()
    private var api: MeetingControlAPI?
    private var docs: DocsSession?
    private var core: CoreSession?
    private var linkObserver: AnyCancellable?
    private var wasLinked = false
    /// Closing everything on Docs sign-out is not the person closing each
    /// window, so it must not rewrite the list one window at a time.
    private var closingAll = false

    private init() {
        // A rename anywhere retitles the window; an archive closes it.
        NotificationCenter.default.addObserver(
            forName: DocsOpenEditors.titleDidChangeNotification, object: nil, queue: .main
        ) { note in
            guard let id = note.userInfo?["id"] as? String, let title = note.userInfo?["title"] as? String else { return }
            MainActor.assumeIsolated { FloatingDocuments.shared.retitle(id, title) }
        }
        NotificationCenter.default.addObserver(
            forName: DocsOpenEditors.archivedNotification, object: nil, queue: .main
        ) { note in
            guard let id = note.userInfo?["id"] as? String else { return }
            MainActor.assumeIsolated { FloatingDocuments.shared.windows[id]?.close() }
        }
    }

    /// Wired once, by the main window, when the sessions exist. Restores
    /// what floated last time as soon as Docs is linked, and closes every
    /// window when it stops being.
    func configure(api: MeetingControlAPI, docs: DocsSession, core: CoreSession) {
        guard self.docs == nil else { return }
        self.api = api
        self.docs = docs
        self.core = core
        linkObserver = docs.$owner
            .map { $0 != nil }
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] linked in Task { @MainActor in self?.linkChanged(linked) } }
    }

    func register(_ inspector: WorkInspectorViewController) {
        inspectors.add(inspector)
    }

    func isFloating(_ id: String) -> Bool {
        windows[id] != nil
    }

    /// Float a document, or bring its window forward if it already floats.
    func float(id: String, title: String) {
        if let existing = windows[id] {
            existing.bringForward()
            return
        }
        guard docs?.isLinked == true else { return }
        let handoff = inspectors.allObjects.contains { $0.editingDocumentID == id }
        open(Entry(id: id, title: title, pinned: true), handoff: handoff, near: NSApp.keyWindow)
        persist()
        // Inspectors on this document let go of their editor now.
        announce(id)
    }

    func bringForward(_ id: String) {
        windows[id]?.bringForward()
    }

    // MARK: - Private

    private func linkChanged(_ linked: Bool) {
        if linked, !wasLinked {
            restore()
        } else if !linked, wasLinked {
            closeAll()
        }
        wasLinked = linked
    }

    private func retitle(_ id: String, _ title: String) {
        guard let window = windows[id] else { return }
        window.retitle(title)
        persist()
    }

    private func open(_ entry: Entry, handoff: Bool, near host: NSWindow?) {
        guard let docs, let api else { return }
        let directory: SubjectDirectory? = core.flatMap { core in
            core.isLinked ? CoreSubjectDirectory(repository: core.repository, contracts: core.contracts) : nil
        }
        let controller = FloatingDocumentWindowController(
            entry: entry,
            editor: {
                AnyView(DocumentEditor(
                    documentID: entry.id, client: docs.client, directory: directory,
                    // Read again goes through the Worker's page reader.
                    linkRefetch: { documentID in try await api.refetchDocsLink(documentID: documentID) },
                    onToast: { message in
                        MainActor.assumeIsolated {
                            StarlingsToast.show(message, in: FloatingDocuments.shared.windows[entry.id]?.window)
                        }
                    },
                    // A wikilink opens its document in Docs, the palette's door.
                    onOpenDocument: { id, title in
                        MainActor.assumeIsolated {
                            (NSApp.delegate as? AppDelegate)?.mainWindowController?.openDocument(id: id, title: title)
                        }
                    }
                ))
            }
        )
        controller.onClose = { [weak self] closed in self?.closed(closed) }
        controller.onPinChanged = { [weak self] in self?.persist() }
        windows[entry.id] = controller
        order.append(entry.id)
        // A hand-off waits for the inspector's last save, so the window's
        // editor reads the hash that save produced.
        controller.show(near: host, cascadeIndex: order.count - 1, handoff: handoff)
    }

    private func closed(_ controller: FloatingDocumentWindowController) {
        guard !closingAll else { return }
        let id = controller.entry.id
        windows[id] = nil
        order.removeAll { $0 == id }
        persist()
        announce(id)
    }

    private func restore() {
        let entries = Self.stored()
        for entry in entries where windows[entry.id] == nil {
            open(entry, handoff: false, near: nil)
        }
        guard !entries.isEmpty, let client = docs?.client else { return }
        // The stored title is what the window was called when it closed; a
        // rename since then shows once the document answers. A document
        // that does not answer keeps its window, where the editor says why.
        Task { @MainActor [weak self] in
            for entry in entries {
                guard let detail = try? await client.document(id: entry.id) else { continue }
                self?.windows[entry.id]?.retitle(detail.title)
            }
            self?.persist()
        }
    }

    private func closeAll() {
        closingAll = true
        let ids = Array(windows.keys)
        for controller in windows.values { controller.close() }
        windows.removeAll()
        order.removeAll()
        closingAll = false
        UserDefaults.standard.removeObject(forKey: Self.defaultsKey)
        ids.forEach(announce)
    }

    private func persist() {
        let entries = order.compactMap { windows[$0]?.entry }
        guard let data = try? JSONEncoder().encode(entries) else { return }
        UserDefaults.standard.set(data, forKey: Self.defaultsKey)
    }

    private static func stored() -> [Entry] {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey) else { return [] }
        return (try? JSONDecoder().decode([Entry].self, from: data)) ?? []
    }

    private func announce(_ id: String) {
        NotificationCenter.default.post(name: Self.didChangeNotification, object: self, userInfo: ["id": id])
    }
}

/// One floating document: its title, a pin, and the editor. No rail, no
/// list, no surface switcher — the window is the document.
@MainActor
final class FloatingDocumentWindowController: NSWindowController, NSWindowDelegate {
    private(set) var entry: FloatingDocuments.Entry
    var onClose: ((FloatingDocumentWindowController) -> Void)?
    var onPinChanged: (() -> Void)?

    private let makeEditor: () -> AnyView
    private let host = NSHostingView(rootView: AnyView(EmptyView()))
    private let pinButton = NSButton()
    private var unsavedObserver: AnyCancellable?

    init(entry: FloatingDocuments.Entry, editor: @escaping () -> AnyView) {
        self.entry = entry
        makeEditor = editor
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 640),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = entry.title
        window.minSize = NSSize(width: 360, height: 280)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.backgroundColor = StarlingsColors.canvas
        super.init(window: window)
        window.delegate = self

        let container = StarlingsShellBackdrop(ground: StarlingsColors.canvas)
        // The window decides the size, never the editor inside it (AGENTS #21).
        host.sizingOptions = []
        host.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(host)
        host.pinToEdges(of: container)
        window.contentView = container

        pinButton.bezelStyle = .inline
        pinButton.isBordered = false
        pinButton.target = self
        pinButton.action = #selector(pinPressed)
        SettingsChrome.applyQuietButton(pinButton)
        pinButton.translatesAutoresizingMaskIntoConstraints = false
        let accessoryView = NSView(frame: NSRect(x: 0, y: 0, width: 40, height: 28))
        accessoryView.addSubview(pinButton)
        NSLayoutConstraint.activate([
            pinButton.centerYAnchor.constraint(equalTo: accessoryView.centerYAnchor),
            pinButton.trailingAnchor.constraint(equalTo: accessoryView.trailingAnchor, constant: -8),
            pinButton.widthAnchor.constraint(equalToConstant: 26),
            pinButton.heightAnchor.constraint(equalToConstant: 22),
        ])
        let accessory = NSTitlebarAccessoryViewController()
        accessory.view = accessoryView
        accessory.layoutAttribute = .trailing
        window.addTitlebarAccessoryViewController(accessory)
        applyPin()

        // Where it was, per document, across quits.
        shouldCascadeWindows = false
        windowFrameAutosaveName = "MeetFloatingDoc.\(entry.id)"

        // The close button's dot while an edit has not reached the server.
        let id = entry.id
        unsavedObserver = DocsOpenEditors.shared.$unsaved
            .map { $0.contains(id) }
            .removeDuplicates()
            .sink { [weak window] unsaved in window?.isDocumentEdited = unsaved }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Shows the window. `handoff` holds the editor back until an
    /// inspector's editor on the same document has finished its last save.
    func show(near host: NSWindow?, cascadeIndex: Int, handoff: Bool) {
        guard let window else { return }
        if !window.setFrameUsingName(windowFrameAutosaveName) {
            place(window, near: host, cascadeIndex: cascadeIndex)
        }
        if handoff {
            self.host.rootView = meetHosted(EnvisioningLoadingState(String(localized: "Opening…")))
            let id = entry.id
            Task { @MainActor [weak self] in
                await DocsOpenEditors.shared.flush(id)
                self?.mountEditor()
            }
        } else {
            mountEditor()
        }
        showWindow(nil)
        window.makeKeyAndOrderFront(nil)
    }

    func bringForward() {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func retitle(_ title: String) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        entry.title = trimmed
        window?.title = trimmed
    }

    func windowWillClose(_ notification: Notification) {
        // The editor flushes on disappear; tearing it down is what saves.
        host.rootView = meetHosted(EmptyView())
        onClose?(self)
    }

    private func mountEditor() {
        host.rootView = meetHosted(
            makeEditor()
                .id(entry.id)
                .background(Color(nsColor: StarlingsColors.canvas))
        )
    }

    private func place(_ window: NSWindow, near host: NSWindow?, cascadeIndex: Int) {
        let offset = CGFloat(cascadeIndex % 8) * 24
        guard let host else {
            window.center()
            window.setFrameTopLeftPoint(NSPoint(x: window.frame.minX + offset, y: window.frame.maxY - offset))
            return
        }
        // Off the trailing edge of the window it came from, the way Chat
        // opens beside a meeting, and back inside the screen if that is off it.
        var frame = window.frame
        frame.origin = NSPoint(x: host.frame.maxX - frame.width / 3 + offset, y: host.frame.maxY - frame.height - offset)
        if let visible = (host.screen ?? NSScreen.main)?.visibleFrame {
            frame.origin.x = min(max(frame.minX, visible.minX), visible.maxX - frame.width)
            frame.origin.y = min(max(frame.minY, visible.minY), visible.maxY - frame.height)
        }
        window.setFrame(frame, display: false)
    }

    @objc private func pinPressed() {
        entry.pinned.toggle()
        applyPin()
        onPinChanged?()
    }

    /// Pinned is above every app and on every Space, full-screen ones
    /// included; unpinned is an ordinary window.
    private func applyPin() {
        guard let window else { return }
        window.level = entry.pinned ? .floating : .normal
        window.collectionBehavior = entry.pinned
            ? [.canJoinAllSpaces, .fullScreenAuxiliary]
            : [.managed, .fullScreenAuxiliary]
        let label = entry.pinned ? String(localized: "Unpin from Top") : String(localized: "Keep on Top")
        pinButton.image = NSImage(systemSymbolName: entry.pinned ? "pin.fill" : "pin", accessibilityDescription: label)
        pinButton.contentTintColor = entry.pinned ? StarlingsColors.primaryText : StarlingsColors.secondaryText
        pinButton.toolTip = label
        pinButton.setAccessibilityLabel(label)
    }
}
