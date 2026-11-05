import AppKit
import DocsKit

/// Where a search row goes. `MainWindowController` answers: it is the one
/// object that can reach every window, the settings, and the meeting.
@MainActor
protocol SearchNavigating: AnyObject {
    func searchOpen(_ row: SearchRow, verb: SearchRowVerb?)
}

/// ⌘K — one palette to find anything and jump anywhere (AGENTS.md
/// invariant 27). An `NSPanel` over the key window: a `StarlingsSearchField` on
/// top, one ranked list under it.
///
/// Hits come from `GET /api/search` in the contract's order; the Core
/// registry is this Mac's (`CoreSession.contracts`, no Worker route), and
/// doors and recents are this device's. The same `Search.run` goes over all
/// of them once more so a recent row, a Core row and a door rank by the one
/// rule. Document titles are in the first answer; full text
/// (`DocsSession.client.search`) arrives after a pause, below.
///
/// ↑↓ moves, Enter opens, → or ⌘-Enter on a person shows Message / Wave /
/// Call, ← comes back, Esc closes. ⌘F stays each window's own field.
@MainActor
final class SearchPanelController: NSWindowController, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate {
    private enum Row {
        case heading(String)
        case row(SearchRow, recent: Bool)
        case docHit(DocsSearchHit)
        case verb(SearchRowVerb)

        var isSelectable: Bool {
            if case .heading = self { return false }
            return true
        }
    }

    private static let width: CGFloat = 620
    private static let listHeight: CGFloat = 420
    private static let rowHeight: CGFloat = 40
    private static let headingHeight: CGFloat = 26
    /// Titles answer on the first keystroke; this is the wait before full text.
    private static let docsDebounce: Duration = .milliseconds(400)
    /// The Worker fan-out is eight upstream reads; a keystroke should not fire it.
    private static let hitsDebounce: Duration = .milliseconds(150)

    private let api: MeetingControlAPI
    private let docs: DocsSession
    private let core: CoreSession
    private weak var navigator: SearchNavigating?

    private let field = StarlingsSearchField()
    private let table = NSTableView()
    private let scroll = NSScrollView()
    private let empty = NSTextField(labelWithString: "")

    private var query = ""
    private var hits: [SearchRow] = []
    /// The last hits came back without every source (`SearchResponse.partial`).
    private var hitsPartial = false
    private var docHits: [DocsSearchHit] = []
    private var recents: [SearchRow] = []
    /// The person or subject whose verbs are showing, once → or ⌘-Enter asked for them.
    private var verbsFor: SearchRow?
    private var rows: [Row] = []
    private var hitsTask: Task<Void, Never>?
    private var docsTask: Task<Void, Never>?

    init(api: MeetingControlAPI, docs: DocsSession, core: CoreSession, navigator: SearchNavigating) {
        self.api = api
        self.docs = docs
        self.core = core
        self.navigator = navigator
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: Self.width, height: 60 + Self.listHeight),
            styleMask: [.titled, .fullSizeContentView],
            backing: .buffered,
            defer: true
        )
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.isMovableByWindowBackground = true
        panel.isReleasedWhenClosed = false
        panel.level = .floating
        panel.backgroundColor = StarlingsColors.panel
        panel.animationBehavior = .utilityWindow
        super.init(window: panel)
        panel.delegate = self
        shouldCascadeWindows = false
        buildContent(in: panel)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: - Showing

    func toggle(over host: NSWindow?) {
        if window?.isVisible == true {
            close()
        } else {
            show(over: host)
        }
    }

    func show(over host: NSWindow?) {
        guard let panel = window else { return }
        recents = SearchRecents.load(owner: api.signedInOwnerEmail ?? "")
        query = ""
        field.stringValue = ""
        hits = []
        docHits = []
        verbsFor = nil
        rebuild()
        let anchor = host?.frame ?? NSScreen.main?.visibleFrame ?? .zero
        let size = panel.frame.size
        panel.setFrameOrigin(NSPoint(
            x: anchor.midX - size.width / 2,
            y: anchor.maxY - size.height - anchor.height * 0.14
        ))
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeFirstResponder(field)
    }

    func windowDidResignKey(_ notification: Notification) {
        close()
    }

    override func close() {
        hitsTask?.cancel()
        docsTask?.cancel()
        super.close()
    }

    // MARK: - Content

    /// The glass shape's corner; the window's own corners stay the system's.
    private static let cornerRadius: CGFloat = 16

    private func buildContent(in panel: NSPanel) {
        let content = NSView()
        content.wantsLayer = true
        // A transient panel over the key window is the floating layer:
        // glass on macOS 26, the panel rung below it.
        StarlingsFloatingGlass.dress(panel, content: content, cornerRadius: Self.cornerRadius)

        field.configure(placeholder: String(localized: "Search"), target: self, action: #selector(queryChanged(_:)))
        field.delegate = self
        field.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(field)

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("row"))
        column.resizingMask = .autoresizingMask
        table.addTableColumn(column)
        table.headerView = nil
        table.backgroundColor = .clear
        // `.regular`, not `.none`: with `.none` AppKit never calls the row
        // view's `drawSelection(in:)`, so ↑/↓ moved a selection nobody could
        // see. `SearchRowView` draws the lift itself in place of the system
        // highlight.
        table.selectionHighlightStyle = .regular
        table.intercellSpacing = NSSize(width: 0, height: 2)
        table.rowHeight = Self.rowHeight
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.action = #selector(rowClicked(_:))
        table.style = .plain
        table.refusesFirstResponder = true

        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.contentInsets = NSEdgeInsets(top: 4, left: 0, bottom: 8, right: 0)
        content.addSubview(scroll)

        empty.font = StarlingsTextField.fieldFont
        empty.textColor = StarlingsColors.secondaryText
        empty.alignment = .center
        empty.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(empty)

        NSLayoutConstraint.activate([
            field.topAnchor.constraint(equalTo: content.topAnchor, constant: 14),
            field.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 14),
            field.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -14),
            field.heightAnchor.constraint(equalToConstant: 32),
            scroll.topAnchor.constraint(equalTo: field.bottomAnchor, constant: 8),
            scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 8),
            scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -8),
            scroll.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            empty.centerXAnchor.constraint(equalTo: scroll.centerXAnchor),
            empty.topAnchor.constraint(equalTo: scroll.topAnchor, constant: 24),
        ])
    }

    // MARK: - Sources

    @objc private func queryChanged(_ sender: Any?) {
        let next = field.stringValue
        guard next != query else { return }
        query = next
        verbsFor = nil
        rebuild()
        scheduleHits()
        scheduleDocs()
    }

    private func scheduleHits() {
        hitsTask?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            hits = []
            hitsPartial = false
            rebuild()
            return
        }
        hitsTask = Task { [weak self] in
            try? await Task.sleep(for: Self.hitsDebounce)
            guard !Task.isCancelled, let self else { return }
            let found = try? await api.search(query: trimmed, timeZone: TimeZone.current.identifier)
            guard !Task.isCancelled, query.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed else { return }
            hits = found?.rows ?? []
            hitsPartial = !(found?.partial.isEmpty ?? true)
            rebuild()
        }
    }

    private func scheduleDocs() {
        docsTask?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2, docs.isLinked else {
            docHits = []
            return
        }
        docsTask = Task { [weak self] in
            try? await Task.sleep(for: Self.docsDebounce)
            guard !Task.isCancelled, let self else { return }
            let found = (try? await docs.client.search(trimmed, limit: 20)) ?? []
            guard !Task.isCancelled, query.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed else { return }
            docHits = found
            rebuild()
        }
    }

    /// Core's registry as rows: one per entity Core publishes to this account.
    private var coreRows: [SearchRow] {
        guard core.isLinked else { return [] }
        return core.entities.map { contract in
            let count = core.recordCounts[contract.id]
            return SearchRow(
                kind: .core,
                id: contract.id,
                title: contract.pluralLabel,
                subtitle: count.map { String(localized: "\($0) records") } ?? String(localized: "Records"),
                door: .core(id: contract.id)
            )
        }
    }

    // MARK: - The list

    private func rebuild() {
        let previous = selectedRowIndex
        if let verbsFor {
            rows = [.heading(verbsFor.title)] + Search.rowVerbs(for: verbsFor).map(Row.verb)
        } else {
            let recentKeys = recents.map(\.key)
            let hitKeys = Set(hits.map(\.key))
            let pool = hits
                + recents.filter { !hitKeys.contains($0.key) }
                + coreRows
                + Search.doorRows()
            let ranked = Search.run(pool, query: query, scope: Search.Scope.palette.kinds, order: .rank, recents: recentKeys)
            let seen = Set(ranked.map(\.key))
            let isEmpty = query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            var built: [Row] = []
            var section: String?
            for row in ranked {
                let recent = recentKeys.contains(row.key)
                // With no query the list is Recent, then Go to, then Do — the
                // fixture's empty-query order made visible. With a query the
                // list is one ranked run: a heading per kind would have to
                // reorder what the contract already ordered.
                if isEmpty {
                    let name = recent ? String(localized: "RECENT") : row.kind == .verb ? String(localized: "DO") : String(localized: "GO TO")
                    if name != section {
                        built.append(.heading(name))
                        section = name
                    }
                }
                built.append(.row(row, recent: recent))
            }
            let tail = docHits.filter { !seen.contains(Search.key(kind: .document, id: $0.id)) }
            if !tail.isEmpty {
                built.append(.heading("DOCS"))
                built.append(contentsOf: tail.map(Row.docHit))
            }
            // A source the Worker could not read: said under the list, the
            // same one line the web shows.
            if hitsPartial && !isEmpty && built.contains(where: \.isSelectable) {
                built.append(.heading("SOME RESULTS ARE MISSING"))
            }
            rows = built
        }
        table.reloadData()
        let selectable = rows.indices.filter { rows[$0].isSelectable }
        let wanted = previous.flatMap { selectable.contains($0) && verbsFor == nil ? $0 : nil } ?? selectable.first
        if let wanted {
            table.selectRowIndexes([wanted], byExtendingSelection: false)
            table.scrollRowToVisible(wanted)
        }
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        empty.stringValue = selectable.isEmpty
            ? (trimmed.isEmpty ? String(localized: "Type to search.") : hitsPartial ? String(localized: "Some results are missing.") : String(localized: "Nothing matches."))
            : ""
    }

    private var selectedRowIndex: Int? {
        let index = table.selectedRow
        return index >= 0 ? index : nil
    }

    private func move(by delta: Int) {
        let selectable = rows.indices.filter { rows[$0].isSelectable }
        guard !selectable.isEmpty else { return }
        let current = selectedRowIndex.flatMap { selectable.firstIndex(of: $0) } ?? 0
        let next = selectable[(current + delta + selectable.count) % selectable.count]
        table.selectRowIndexes([next], byExtendingSelection: false)
        table.scrollRowToVisible(next)
    }

    private func openSelected(showingVerbs: Bool) {
        guard let index = selectedRowIndex else { return }
        switch rows[index] {
        case .heading:
            return
        case .verb(let verb):
            guard let verbsFor else { return }
            open(verbsFor, verb: verb)
        case .docHit(let hit):
            let row = SearchRow(kind: .document, id: hit.id, title: hit.title, subtitle: "", door: .document(id: hit.id))
            open(row, verb: nil)
        case .row(let row, _):
            if showingVerbs {
                showVerbs(for: row)
            } else {
                open(row, verb: nil)
            }
        }
    }

    private func showVerbs(for row: SearchRow) {
        guard !Search.rowVerbs(for: row).isEmpty else { return }
        verbsFor = row
        rebuild()
    }

    private func open(_ row: SearchRow, verb: SearchRowVerb?) {
        SearchRecents.remember(row, owner: api.signedInOwnerEmail ?? "")
        close()
        navigator?.searchOpen(row, verb: verb)
    }

    @objc private func rowClicked(_ sender: Any?) {
        let index = table.clickedRow
        guard index >= 0, rows[index].isSelectable else { return }
        table.selectRowIndexes([index], byExtendingSelection: false)
        openSelected(showingVerbs: false)
    }

    // MARK: - Keys, through the field editor

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        switch commandSelector {
        case #selector(NSResponder.moveDown(_:)):
            move(by: 1)
            return true
        case #selector(NSResponder.moveUp(_:)):
            move(by: -1)
            return true
        case #selector(NSResponder.insertNewline(_:)):
            let command = NSApp.currentEvent?.modifierFlags.contains(.command) ?? false
            openSelected(showingVerbs: command && verbsFor == nil)
            return true
        case #selector(NSResponder.moveRight(_:)):
            // → only asks for verbs from the end of the text; inside it, it
            // is the caret's.
            guard verbsFor == nil, textView.selectedRange().location == (textView.string as NSString).length else { return false }
            openSelected(showingVerbs: true)
            return verbsFor != nil
        case #selector(NSResponder.moveLeft(_:)):
            guard verbsFor != nil else { return false }
            verbsFor = nil
            rebuild()
            return true
        case #selector(NSResponder.cancelOperation(_:)):
            if verbsFor != nil {
                verbsFor = nil
                rebuild()
            } else {
                close()
            }
            return true
        default:
            return false
        }
    }

    // MARK: - Table

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        if case .heading = rows[row] { return Self.headingHeight }
        return Self.rowHeight
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        rows[row].isSelectable
    }

    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        SearchRowView()
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        switch rows[row] {
        case .heading(let title):
            return SearchHeadingCell(title: title)
        case .row(let item, _):
            let verbs = !Search.rowVerbs(for: item).isEmpty
            return SearchRowCell(title: item.title, subtitle: item.subtitle, kind: item.kind.label, chevron: verbs)
        case .docHit(let hit):
            return SearchRowCell(title: hit.title, subtitle: Self.snippetText(hit.snippet), kind: SearchKind.document.label, chevron: false)
        case .verb(let verb):
            return SearchRowCell(title: verb.title, subtitle: "", kind: "", chevron: false)
        }
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

// MARK: - Cells

/// The selected row wears the house hover lift (invariant 18), so the
/// keyboard and the pointer say the same thing.
private final class SearchRowView: NSTableRowView {
    override func drawSelection(in dirtyRect: NSRect) {
        guard isSelected else { return }
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 2, dy: 0), xRadius: 8, yRadius: 8)
        StarlingsColors.lifted(StarlingsColors.resolved(StarlingsColors.panel, for: self)).setFill()
        path.fill()
    }

    override func drawBackground(in dirtyRect: NSRect) {}
}

private final class SearchHeadingCell: NSTableCellView {
    init(title: String) {
        super.init(frame: .zero)
        let label = NSTextField(labelWithString: title)
        label.font = StarlingsTypography.sectionLabelFont
        label.textColor = StarlingsColors.secondaryText
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

private final class SearchRowCell: NSTableCellView {
    init(title: String, subtitle: String, kind: String, chevron: Bool) {
        super.init(frame: .zero)
        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = StarlingsTextField.persistentFont
        titleLabel.textColor = StarlingsColors.primaryText
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        titleLabel.setContentHuggingPriority(.defaultHigh, for: .horizontal)

        let subtitleLabel = NSTextField(labelWithString: subtitle)
        subtitleLabel.font = StarlingsTextField.persistentSecondaryFont
        subtitleLabel.textColor = StarlingsColors.secondaryText
        subtitleLabel.lineBreakMode = .byTruncatingTail
        subtitleLabel.setContentCompressionResistancePriority(.defaultLow - 1, for: .horizontal)
        subtitleLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        subtitleLabel.isHidden = subtitle.isEmpty

        let kindLabel = NSTextField(labelWithString: kind.uppercased())
        kindLabel.font = StarlingsTypography.sectionLabelFont
        kindLabel.textColor = StarlingsColors.secondaryText
        kindLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        kindLabel.isHidden = kind.isEmpty

        let stack = NSStackView(views: [titleLabel, subtitleLabel, kindLabel])
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 10
        stack.setClippingResistancePriority(.defaultLow, for: .horizontal)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        if chevron {
            let arrow = NSImageView(image: NSImage(systemSymbolName: "chevron.right", accessibilityDescription: String(localized: "Message, Wave, Call"))!)
            arrow.contentTintColor = StarlingsColors.secondaryText
            arrow.symbolConfiguration = .init(pointSize: 11, weight: .semibold)
            stack.addArrangedSubview(arrow)
        }

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}
