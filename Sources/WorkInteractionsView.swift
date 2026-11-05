import AppKit

/// Read-only history for the selected Work subject — user-facing name
/// **History** (docs/TIMELINE.md Phase 1); the type keeps its original name
/// since Core's `interactions` is still the primary data source. This is a
/// subject pane, not a second chat: Core interactions are durable records,
/// the subject's quiet event trail (`postSubjectEvent`, docs/WORK.md §3b) is
/// folded in alongside them, and the project/lead conversation itself stays
/// in Talk. An event row here is display-only today — refs are not yet
/// clickable, same as in Talk (docs/WORK.md §3b).
///
/// Built on the same row shell as Tasks and Issues (`WorkListRowView`) rather
/// than its own `NSTableView` — one list of entries, one way to lay it out.
/// An `NSTableView` here used to paint AppKit's own default background
/// (`.controlBackgroundColor`) instead of the app's themed canvas, since
/// nothing overrode it, which is what made the pane read as a boxed-off
/// iframe next to Talk/Tasks/Issues; a stack of rows has no such background
/// to get wrong.
@MainActor
final class WorkInteractionsView: NSView {
    var onSelect: ((CrmInteraction) -> Void)?
    /// So the tab bar's own "(n)" can follow this list without polling it —
    /// fired whenever the loaded interaction count changes, including back to
    /// zero. Deliberately counts interactions only, not events: the badge
    /// means "how much is behind this subject", and an event line is already
    /// counted wherever it came from (a task, an issue).
    var onCountChange: ((Int) -> Void)?

    /// One thing this pane can show, ordered by when it happened.
    private enum TimelineEntry {
        case interaction(CrmInteraction)
        case event(ThreadMessage)

        /// Nil for an undated interaction; an event always has a `sentAt`.
        var date: Date? {
            switch self {
            case .interaction(let interaction): interaction.date
            case .event(let message): message.sentAt
            }
        }

        var sortDate: Date { date ?? .distantPast }
    }

    private let api: MeetingControlAPI
    /// When the list last came back from Core, or the age of the snapshot it
    /// painted from — read into the header when a refresh fails.
    private var updatedAt: Date?
    private let interactionsStack = NSStackView()
    private let scrollView = NSScrollView()
    private let statusLabel = StarlingsNoticeView()
    private let filterButton = NSPopUpButton(frame: .zero, pullsDown: false)
    /// Log a call, meeting or note by hand.
    private let logButton = NSButton(title: String(localized: "Log"), target: nil, action: nil)
    private let headerRow = NSStackView()
    private let emptyLabel = StarlingsTypography.wrappingLabel(String(localized: "Nothing filed under this subject yet."))
    private var subject: CrmSubject?
    private var allInteractions: [CrmInteraction] = []
    /// The subject's event trail, fetched best-effort alongside interactions.
    /// A failure here never blocks the pane — see `fetchEvents`.
    private var events: [ThreadMessage] = []
    private var filter: CrmInteractionFilter = .all
    private var selectedID: String?
    private var loadTask: Task<Void, Never>?

    init(api: MeetingControlAPI) {
        self.api = api
        super.init(frame: .zero)

        interactionsStack.orientation = .vertical
        interactionsStack.alignment = .leading
        interactionsStack.spacing = 6
        interactionsStack.translatesAutoresizingMaskIntoConstraints = false
        interactionsStack.setAccessibilityLabel(String(localized: "History"))

        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.borderType = .noBorder
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        let clip = WorkFlippedClipView()
        clip.drawsBackground = false
        scrollView.contentView = clip
        scrollView.documentView = interactionsStack

        statusLabel.hidesWhenEmpty = false
        statusLabel.label.allowSqueezing()
        statusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        filterButton.controlSize = .small
        filterButton.bezelStyle = .inline
        filterButton.isBordered = false
        filterButton.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        filterButton.target = self
        filterButton.action = #selector(filterChanged(_:))
        filterButton.setAccessibilityLabel(String(localized: "Filter interactions"))
        SettingsChrome.applyQuietButton(filterButton)
        for option in CrmInteractionFilter.allCases {
            filterButton.addItem(withTitle: option.title)
            filterButton.lastItem?.representedObject = option.rawValue
        }
        filterButton.selectItem(at: 0)

        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.spacing = 8
        headerRow.addArrangedSubview(statusLabel)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        headerRow.addArrangedSubview(spacer)
        headerRow.addArrangedSubview(filterButton)

        logButton.bezelStyle = .inline
        logButton.controlSize = .small
        SettingsChrome.applyQuietButton(logButton)
        logButton.target = self
        logButton.action = #selector(logPressed)
        logButton.isHidden = true
        headerRow.addArrangedSubview(logButton)
        headerRow.translatesAutoresizingMaskIntoConstraints = false

        emptyLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        emptyLabel.textColor = StarlingsColors.secondaryText
        emptyLabel.alignment = .center
        emptyLabel.translatesAutoresizingMaskIntoConstraints = false

        addSubview(headerRow)
        addSubview(scrollView)
        addSubview(emptyLabel)
        NSLayoutConstraint.activate([
            headerRow.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            headerRow.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
            headerRow.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
            scrollView.topAnchor.constraint(equalTo: headerRow.bottomAnchor, constant: 8),
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
            interactionsStack.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor),
            emptyLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
            emptyLabel.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -64),
        ])

        render()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show(_ subject: CrmSubject) {
        loadTask?.cancel()
        self.subject = subject
        selectedID = nil
        // An event has no History yet (docs/EVENTS.md slice 3): nothing to file on.
        logButton.isHidden = subject.isEvent
        allInteractions = []
        events = []
        onCountChange?(0)
        let (projectID, leadID, organizationID) = MeetingControlAPI.interactionsQuery(for: subject)
        // Last known first (docs/CACHING.md): History paints from its
        // snapshot before Core answers; the event trail follows the live read.
        if let cached = api.snapshot(
            MeetingControlAPI.interactionsSnapshotKey(projectID: projectID, leadID: leadID, organizationID: organizationID),
            as: CrmInteractionsResponse.self
        ) {
            allInteractions = cached.value.interactions
            updatedAt = cached.savedAt
            onCountChange?(allInteractions.count)
            emptyLabel.isHidden = true
            render()
        } else {
            statusLabel.setText("")
            emptyLabel.isHidden = true
            interactionsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
            for row in StarlingsPlaceholderRowView.rows() {
                row.translatesAutoresizingMaskIntoConstraints = false
                interactionsStack.addArrangedSubview(row)
                row.widthAnchor.constraint(equalTo: interactionsStack.widthAnchor).isActive = true
            }
        }
        loadTask = Task { [weak self] in
            guard let self else { return }
            do {
                let interactions = try await api.crmInteractions(projectID: projectID, leadID: leadID, organizationID: organizationID)
                guard !Task.isCancelled else { return }
                allInteractions = interactions
                updatedAt = Date()
                onCountChange?(interactions.count)
            } catch {
                guard !Task.isCancelled else { return }
                let message = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t load interactions")
                if allInteractions.isEmpty {
                    render(error: message)
                } else {
                    // The snapshot stays up; the header says it is old.
                    render()
                    statusLabel.showError(updatedAt.map { "\(message) · \(SnapshotStore.updatedLabel($0))" } ?? message)
                }
                return
            }
            // Best-effort and after the interactions read, deliberately: the
            // pane's contract is the Core history above, and a slow or
            // failing event fetch must never hold that back or replace it.
            // A partner has no thread in this slice (PARTNERS (HQ Docs)), so
            // there is no event trail to fold in.
            events = subject.isPartner ? [] : await fetchEvents(subject)
            guard !Task.isCancelled else { return }
            render()
        }
    }

    /// The subject's quiet event trail (docs/WORK.md §3b) — the same lines
    /// Talk draws, read here independently so History doesn't need Talk to
    /// have been opened first. A thread that fails to open or fetch just
    /// means no events show up this time; it never surfaces as this pane's
    /// error state, which stays reserved for the interactions read above.
    private func fetchEvents(_ subject: CrmSubject) async -> [ThreadMessage] {
        do {
            let thread = try await api.openSubjectThread(kind: subject.kind, subjectID: subject.id)
            let page = try await api.messages(threadID: thread.id, limit: 50)
            return page.messages.filter(\.isEvent)
        } catch {
            return []
        }
    }

    /// Read the History again after a write here or in the inspector, and
    /// keep `id` marked when it is still there.
    func reload(selecting id: String? = nil) {
        guard let subject else { return }
        show(subject)
        selectedID = id
    }

    /// Log a call, meeting or note on this subject. The new row
    /// opens in the inspector, as a chosen row does.
    @objc private func logPressed() {
        guard let subject else { return }
        WorkInteractionEditor.present(
            over: window,
            api: api,
            draft: CrmInteractionDraft(subject: subject)
        ) { [weak self] saved in
            guard let self else { return }
            reload(selecting: saved.id)
            onSelect?(saved)
        }
    }

    func stop() {
        loadTask?.cancel()
        loadTask = nil
        allInteractions = []
        events = []
        onCountChange?(0)
    }

    @objc private func filterChanged(_ sender: NSPopUpButton) {
        guard let raw = sender.selectedItem?.representedObject as? String,
              let chosen = CrmInteractionFilter(rawValue: raw)
        else { return }
        filter = chosen
        render()
    }

    private var visibleInteractions: [CrmInteraction] {
        allInteractions.filter { filter.matches($0) }
    }

    /// Interactions the filter matches, plus events — but only under **All
    /// types**. A filter narrowed to one interaction kind (Meetings, say) is
    /// asking for that kind specifically; showing every event beside it would
    /// answer a different question than the one being asked.
    private var visibleEntries: [TimelineEntry] {
        var entries = visibleInteractions.map(TimelineEntry.interaction)
        if filter == .all {
            entries += events.map(TimelineEntry.event)
        }
        return entries.sorted { $0.sortDate > $1.sortDate }
    }

    private func render() {
        interactionsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let interactionRows = visibleInteractions
        let total = allInteractions.count
        statusLabel.setText(total == interactionRows.count
            ? countLabel(interactionRows.count)
            : "\(interactionRows.count) of \(countLabel(total))")

        let entries = visibleEntries
        var lastGroupTitle: String?
        for entry in entries {
            let title = groupTitle(for: entry.date)
            if title != lastGroupTitle {
                let header = WorkInteractionGroupRowView(title: title)
                header.translatesAutoresizingMaskIntoConstraints = false
                interactionsStack.addArrangedSubview(header)
                header.widthAnchor.constraint(equalTo: interactionsStack.widthAnchor).isActive = true
                lastGroupTitle = title
            }
            switch entry {
            case .interaction(let interaction):
                let row = WorkInteractionRowView(
                    interaction: interaction,
                    isSelected: interaction.id == selectedID
                ) { [weak self] chosen in
                    self?.select(chosen)
                }
                row.translatesAutoresizingMaskIntoConstraints = false
                interactionsStack.addArrangedSubview(row)
                row.widthAnchor.constraint(equalTo: interactionsStack.widthAnchor).isActive = true
            case .event(let message):
                let row = WorkInteractionEventRowView(message: message)
                row.translatesAutoresizingMaskIntoConstraints = false
                interactionsStack.addArrangedSubview(row)
                row.widthAnchor.constraint(equalTo: interactionsStack.widthAnchor).isActive = true
            }
        }

        if entries.isEmpty {
            if total == 0 && events.isEmpty {
                emptyLabel.stringValue = subject.map {
                    "Nothing filed under \($0.title) yet."
                } ?? String(localized: "Nothing filed under this subject yet.")
            } else {
                emptyLabel.stringValue = String(localized: "No \(filter.title.lowercased()) match this subject.")
            }
        }
        emptyLabel.isHidden = !entries.isEmpty
    }

    private func render(error: String) {
        statusLabel.showError(error)
        emptyLabel.stringValue = String(localized: "History is unavailable right now.")
        emptyLabel.isHidden = false
        interactionsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
    }

    private func select(_ interaction: CrmInteraction) {
        guard selectedID != interaction.id else { return }
        selectedID = interaction.id
        onSelect?(interaction)
        render()
    }

    private func countLabel(_ count: Int) -> String {
        String(localized: "\(count) interactions")
    }

    private func groupTitle(for date: Date?) -> String {
        guard let date else { return "Undated" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return String(localized: "Today") }
        if calendar.isDateInYesterday(date) { return String(localized: "Yesterday") }
        return date.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted).locale(StarlingsDateFormatting.locale))
    }
}

/// One interaction row, built on the same shell Tasks and Issues use.
@MainActor
private final class WorkInteractionRowView: WorkListRowView {
    private let interaction: CrmInteraction

    init(interaction: CrmInteraction, isSelected: Bool, onSelect: @escaping (CrmInteraction) -> Void) {
        self.interaction = interaction

        let icon: NSView
        if interaction.type.rawValue == "note" {
            let mark = WorkGlyphMarkView(
                diameter: 18,
                content: .symbol(interaction.symbolName),
                accessibilityLabel: "",
                shape: .square
            )
            mark.setAccessibilityElement(false)
            icon = mark
        } else {
            let imageView = NSImageView()
            imageView.image = NSImage(
                systemSymbolName: interaction.symbolName,
                accessibilityDescription: interaction.typeLabel
            )
            imageView.contentTintColor = StarlingsColors.secondaryText
            imageView.imageScaling = .scaleProportionallyDown
            icon = imageView
        }
        icon.setContentHuggingPriority(.required, for: .horizontal)
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 18).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 18).isActive = true

        let title = NSTextField(labelWithString: interaction.displayTitle)
        title.font = WorkListRowView.titleFont()
        title.textColor = StarlingsColors.primaryText
        title.maximumNumberOfLines = 1
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let metadata = NSTextField(labelWithString: interaction.metadataLabel)
        metadata.font = WorkListRowView.detailFont()
        metadata.textColor = StarlingsColors.secondaryText
        metadata.maximumNumberOfLines = 1
        metadata.lineBreakMode = .byTruncatingTail
        metadata.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let text = NSStackView(views: [title, metadata])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = WorkListRowView.textSpacing
        text.translatesAutoresizingMaskIntoConstraints = false

        let row = WorkListRowView.content(leading: icon, text: text)

        super.init(
            content: row,
            isSelected: isSelected,
            accessibilityLabel: interaction.accessibilityLabel,
            onActivate: { onSelect(interaction) }
        )
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

/// One row from the subject's event trail — the same text `ThreadEventLineView`
/// draws in Talk (docs/WORK.md §3b), here as a compact History row instead of
/// a centred transcript line. Deliberately a plain `NSView`, not a
/// `WorkListRowView`: an event isn't clickable yet (refs have no read path —
/// WORK.md §3b), so it carries none of the shell's hover/selection paint,
/// which would otherwise promise an interaction this row doesn't offer.
@MainActor
private final class WorkInteractionEventRowView: NSView {
    init(message: ThreadMessage) {
        super.init(frame: .zero)

        let icon: NSView
        if Self.usesSquareMark(for: message) {
            let mark = WorkGlyphMarkView(
                diameter: 18,
                content: .symbol(Self.symbolName(for: message)),
                accessibilityLabel: "",
                shape: .square
            )
            mark.setAccessibilityElement(false)
            icon = mark
        } else {
            let imageView = NSImageView()
            imageView.image = NSImage(
                systemSymbolName: Self.symbolName(for: message),
                accessibilityDescription: String(localized: "Update")
            )
            imageView.contentTintColor = StarlingsColors.secondaryText
            imageView.imageScaling = .scaleProportionallyDown
            icon = imageView
        }
        icon.setContentHuggingPriority(.required, for: .horizontal)
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 18).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 18).isActive = true

        let title = NSTextField(labelWithString: message.text)
        title.font = WorkListRowView.titleFont()
        title.textColor = StarlingsColors.primaryText
        title.maximumNumberOfLines = 1
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let metadataText = message.sentAt.meetDateTimeString(dateStyle: .abbreviated)
        let metadata = NSTextField(labelWithString: metadataText)
        metadata.font = WorkListRowView.detailFont()
        metadata.textColor = StarlingsColors.secondaryText
        metadata.maximumNumberOfLines = 1
        metadata.lineBreakMode = .byTruncatingTail
        metadata.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let text = NSStackView(views: [title, metadata])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = WorkListRowView.textSpacing
        text.translatesAutoresizingMaskIntoConstraints = false

        let row = WorkListRowView.content(leading: icon, text: text)

        addSubview(row)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 56),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])

        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityLabel("\(message.text). \(metadataText).")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private static func symbolName(for message: ThreadMessage) -> String {
        switch message.refs.first?.kind.rawValue {
        case "meeting": "video.fill"
        case "task": "checkmark"
        case "issue": "tag.fill"
        case "pull": "arrow.triangle.merge"
        case "commit": "point.3.connected.trianglepath.dotted"
        case "run": "gearshape.2"
        case "release": "shippingbox"
        default: "bolt.horizontal.circle"
        }
    }

    private static func usesSquareMark(for message: ThreadMessage) -> Bool {
        switch message.refs.first?.kind.rawValue {
        case "task", "issue": true
        default: false
        }
    }
}

/// A date-group heading between runs of interactions — "Today", "Yesterday",
/// or an abbreviated date. Not selectable, so it lives outside `WorkListRowView`.
@MainActor
private final class WorkInteractionGroupRowView: NSView {
    init(title: String) {
        super.init(frame: .zero)
        let label = NSTextField(labelWithString: title)
        label.translatesAutoresizingMaskIntoConstraints = false
        StarlingsTypography.applySectionLabel(label)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        addSubview(label)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 28),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

/// The full interaction reader shown in Work's inspector after a row is
/// chosen. The projection is intentionally read-only; Core remains the record.
@MainActor
final class WorkInteractionReadingView: NSView {
    private let scroll = NSScrollView()
    private let column = NSStackView()

    init() {
        super.init(frame: .zero)
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 12
        column.translatesAutoresizingMaskIntoConstraints = false

        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.borderType = .noBorder
        let clip = WorkFlippedClipView()
        clip.drawsBackground = false
        scroll.contentView = clip
        scroll.documentView = column
        scroll.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll)
        scroll.pinToEdges(of: self)
        NSLayoutConstraint.activate([
            column.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show(_ interaction: CrmInteraction) {
        column.arrangedSubviews.forEach { $0.removeFromSuperview() }

        let summaryLabel = StarlingsTypography.wrappingLabel(interaction.previewLabel.uppercased())
        StarlingsTypography.applySectionLabel(summaryLabel)
        add(summaryLabel)

        if let markdown = interaction.readerBody {
            // The same renderer as chat: headings, lists and links drawn,
            // not their syntax. Editable attributes let the label follow a link.
            let body = StarlingsTypography.wrappingLabel("")
            body.attributedStringValue = ThreadMarkdownAppKit.attributed(
                markdown,
                font: .systemFont(ofSize: StarlingsTypography.scaled(13)),
                color: StarlingsColors.primaryText
            )
            body.isSelectable = true
            body.allowsEditingTextAttributes = true
            body.maximumNumberOfLines = 0
            add(body)
        } else {
            let none = StarlingsTypography.wrappingLabel(String(localized: "No summary was filed for this interaction."))
            none.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
            none.textColor = StarlingsColors.secondaryText
            add(none)
        }
        layoutSubtreeIfNeeded()
    }

    private func add(_ view: NSView) {
        view.translatesAutoresizingMaskIntoConstraints = false
        column.addArrangedSubview(view)
        view.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
    }
}
