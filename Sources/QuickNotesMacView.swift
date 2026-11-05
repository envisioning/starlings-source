import AppKit

/// Home's low-friction Quick Notes card. The composer only captures; a
/// click on a note opens its popover (`QuickNotePopover`), which is where it
/// is rewritten, filed, copied or deleted — the phone's drawer, anchored.
@MainActor
final class MacQuickNotesPanel: NSView, NSTextFieldDelegate {
    var onCreate: ((String) -> Void)?
    /// The popover, saving over an existing note.
    var onUpdate: ((QuickNote, String) -> Void)?
    var onDelete: ((QuickNote) -> Void)?
    /// Move to ▸ another workspace this Mac is signed in to.
    var onMove: ((QuickNote, StarlingsWorkspace) -> Void)?
    /// File… in the popover opens the filing sheet — the same one Work opens.
    var onSelect: ((QuickNote) -> Void)?

    private let titleLabel = StarlingsTypography.sectionLabel(String(localized: "QUICK NOTES"))
    private let countLabel = NSTextField(labelWithString: "")
    private lazy var addButton = StarlingsPanelHeader.actionButton(
        symbolName: "plus", accessibilityLabel: String(localized: "Add Quick Note"), target: self, action: #selector(addTapped)
    )
    private let inputField = StarlingsTextField(placeholder: String(localized: "What’s on your mind?"))
    private let saveButton = StarlingsFieldButton.make(symbol: "plus", label: String(localized: "Add"))
    /// A failed save, in red with Copy.
    private let statusLabel = StarlingsNoticeView(wrapping: true)
    private let composer = NSStackView()
    private let notesStack = NSStackView()
    private let foldButton = NSButton(title: "", target: nil, action: nil)
    private var isExpanded = false
    private var isSaving = false
    /// How many pages of notes are unfolded; one page is the card at rest.
    /// Per launch, not stored.
    private var pages = 1
    /// Each note's row height, measured when its row was on screen.
    private var rowHeights: [QuickNote.ID: CGFloat] = [:]
    /// The count the rows on screen were drawn for, so a layout pass re-draws
    /// them only when the page holds a different count.
    private var renderedFitCount = 0
    /// How many notes the card keeps showing after an add (`QuickNotePage`):
    /// the count on screen plus the new notes. Cleared when the page changes.
    private var noteFloor = 0
    private var isRendering = false
    private var isRenderScheduled = false
    /// The viewport the page was last sized against, and the scroll view whose
    /// height changes we are watching for it.
    private var observedViewportHeight: CGFloat = 0
    private weak var observedClipView: NSClipView?
    /// The popover open on a note, so a save can lock it and close it.
    private var popover: QuickNotePopover?
    private var notes: [QuickNote] = []
    /// Notes still on this Mac, not on the Worker.
    private var unsent: [QuickNote.ID: QuickNotePending] = [:]

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)

        // The same count every Home card prints: 11 semibold primary ink.
        countLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold)
        countLabel.textColor = StarlingsColors.primaryText
        countLabel.alignment = .right
        StarlingsTypography.applyStaticLabel(countLabel)

        let heading = StarlingsPanelHeader.row(title: titleLabel, count: countLabel, action: addButton)

        inputField.delegate = self
        inputField.target = self
        inputField.action = #selector(saveTapped)
        inputField.setContentHuggingPriority(.defaultLow, for: .horizontal)

        saveButton.target = self
        saveButton.action = #selector(saveTapped)
        StarlingsFieldButton.seat(saveButton, in: inputField)

        composer.addArrangedSubview(inputField)
        composer.orientation = .horizontal
        composer.alignment = .centerY
        composer.spacing = 8

        statusLabel.label.maximumNumberOfLines = 2

        notesStack.orientation = .vertical
        notesStack.alignment = .leading
        notesStack.spacing = 8

        // The same quiet toggle the launch surface's "See rest of day" draws.
        foldButton.bezelStyle = .inline
        SettingsChrome.applyQuietButton(foldButton)
        foldButton.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold)
        foldButton.contentTintColor = StarlingsColors.secondaryText
        foldButton.setContentHuggingPriority(.required, for: .horizontal)
        foldButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        foldButton.target = self
        foldButton.action = #selector(foldTapped)
        foldButton.isHidden = true

        let column = NSStackView(views: [heading, composer, statusLabel, notesStack, foldButton])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 8
        addSubview(column)
        column.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: leadingAnchor),
            column.trailingAnchor.constraint(equalTo: trailingAnchor),
            column.topAnchor.constraint(equalTo: topAnchor),
            column.bottomAnchor.constraint(equalTo: bottomAnchor),
            heading.widthAnchor.constraint(equalTo: column.widthAnchor),
            composer.widthAnchor.constraint(equalTo: column.widthAnchor),
            statusLabel.widthAnchor.constraint(equalTo: column.widthAnchor),
            notesStack.widthAnchor.constraint(equalTo: column.widthAnchor),
        ])

        setExpanded(false)
        setNotes([])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setNotes(_ notes: [QuickNote], unsent: [QuickNote.ID: QuickNotePending] = [:]) {
        self.unsent = unsent
        // Home is the capture surface: what is still unfiled. A note that has
        // become a task or a message has left this card; Work lists it.
        let open = notes.filter(\.isOpen)
        noteFloor = QuickNotePage.floor(
            old: self.notes.map(\.id), new: open.map(\.id), shown: renderedFitCount, current: noteFloor
        )
        self.notes = open
        countLabel.stringValue = open.isEmpty ? "" : "\(open.count)"
        renderNotes()
    }

    /// The launch viewport's height: the page is a share of it. Zero until the
    /// card is in a scroll view or window, and a page sized against zero is
    /// the floor, so callers wait for a real height.
    private var viewportHeight: CGFloat {
        enclosingScrollView?.contentView.bounds.height ?? window?.contentLayoutRect.height ?? 0
    }

    /// How many notes a page holds (`QuickNotePage`), against the launch
    /// viewport's height. A note not measured yet is shown once so that it
    /// can be; the pass after that decides whether it stays.
    private var fittingNoteCount: Int {
        QuickNotePage.count(
            of: notes.map(\.id),
            viewport: viewportHeight,
            pages: pages,
            spacing: notesStack.spacing,
            floor: noteFloor
        ) { rowHeights[$0] }
    }

    /// The viewport only exists once the card is in the window, and its height
    /// changes without this view's own size changing, so `layout()` alone never
    /// hears about either. Watch the clip view, and check again on arrival.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observeViewport()
        scheduleFitCheck()
    }

    private func observeViewport() {
        let clip = window == nil ? nil : enclosingScrollView?.contentView
        guard clip !== observedClipView else { return }
        if let observedClipView {
            NotificationCenter.default.removeObserver(self, name: NSView.boundsDidChangeNotification, object: observedClipView)
        }
        observedClipView = clip
        guard let clip else { return }
        clip.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(
            self, selector: #selector(viewportChanged), name: NSView.boundsDidChangeNotification, object: clip
        )
    }

    /// Bounds change on every scroll too; only a different height matters.
    @objc private func viewportChanged() {
        let height = viewportHeight
        guard height != observedViewportHeight else { return }
        if observedViewportHeight > 0 { noteFloor = 0 }
        observedViewportHeight = height
        scheduleFitCheck()
    }

    /// A layout pass measures the rows on screen, and the window's height
    /// sets the page. When the page then holds a different count, the rows
    /// re-draw. The check and the redraw run after the pass, never inside it:
    /// `renderNotes()` replaces rows and constraints, and AppKit throws on a
    /// constraint change during layout (the 4.4.2 launch crash).
    override func layout() {
        super.layout()
        scheduleFitCheck()
    }

    private func scheduleFitCheck() {
        guard !isRendering, !isRenderScheduled, !notes.isEmpty else { return }
        isRenderScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            isRenderScheduled = false
            observeViewport()
            observedViewportHeight = viewportHeight
            measureRows()
            if fittingNoteCount != renderedFitCount { renderNotes() }
        }
    }

    private func measureRows() {
        for row in notesStack.arrangedSubviews where row.frame.height > 0 {
            guard let id = row.identifier?.rawValue else { continue }
            rowHeights[id] = row.frame.height
        }
    }

    /// Each listed row's "when" line, which the launch clock refreshes.
    private var detailLabels: [String: (note: QuickNote, label: NSTextField)] = [:]

    /// "3 minutes ago" keeps counting on the launch clock's tick, as the
    /// INBOX card's message times do.
    func refreshRelativeTime() {
        for (note, label) in detailLabels.values {
            let next = detailText(note)
            if label.stringValue != next { label.stringValue = next }
        }
    }

    /// When it was written, or that it has not left this Mac yet.
    private func detailText(_ note: QuickNote) -> String {
        unsent[note.id] == nil ? note.detailLabel : String(localized: "Not sent yet")
    }

    private func renderNotes() {
        isRendering = true
        defer { isRendering = false }
        let open = notes
        let fits = fittingNoteCount
        renderedFitCount = fits
        let listed = Array(open.prefix(fits))
        let hidden = open.count - listed.count
        foldButton.isHidden = hidden == 0 && pages == 1
        foldButton.title = hidden > 0
            ? String(localized: "See \(hidden) more")
            : String(localized: "Show fewer")

        notesStack.arrangedSubviews.forEach {
            notesStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        detailLabels = [:]
        // Read once per draw, not per row: each is a Keychain read.
        let moveTargets = QuickNoteMove.targets { (try? OwnerSessionStore(scope: WorkspaceScope($0)).load()) != nil }
        for note in listed {
            // The Home row (docs/DESIGN.md): the note is a tile like every
            // other row on the launch surface. Clicking it opens the popover.
            // The content is pinned inside the tile with the Home row inset,
            // as LaunchWorkRow does: a centred stack's own edgeInsets are weak
            // vertically, so the tile hugged the text and sat shorter than
            // every other card's row.
            let row = NSView()
            SettingsChrome.applyHomeRow(row, interactive: true)
            let content = NSStackView()
            content.orientation = .horizontal
            content.alignment = .top
            // `.fill`, not the default gravity areas: gravity packs the views
            // at the leading edge and leaves the slack on the right, so the
            // body never widened and the trash sat wherever the text ended.
            content.distribution = .fill
            content.spacing = 10

            let icon = WorkGlyphMarkView(
                diameter: 24,
                content: .symbol("pencil"),
                accessibilityLabel: "",
                shape: .square
            )
            icon.setAccessibilityElement(false)
            icon.setContentHuggingPriority(.required, for: .horizontal)

            // The Home row's two lines: the note as its title, in
            // the title face every other card uses, and when it was written
            // under it, as the phone and the browser draw a note.
            let title = StarlingsTypography.wrappingLabel(note.body)
            title.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold)
            title.textColor = StarlingsColors.primaryText
            title.maximumNumberOfLines = 2
            title.lineBreakMode = .byTruncatingTail
            title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            let detail = NSTextField(labelWithString: detailText(note))
            detail.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
            detail.textColor = StarlingsColors.secondaryText
            detail.lineBreakMode = .byTruncatingTail
            detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            detail.isHidden = detailText(note).isEmpty
            detailLabels[note.id] = (note, detail)
            let body = NSStackView(views: [title, detail])
            // The Worker refused it: its words, in red with Copy,
            // until the note is deleted.
            if let refusal = unsent[note.id]?.lastError {
                detail.isHidden = true
                let notice = StarlingsNoticeView(wrapping: true)
                notice.label.maximumNumberOfLines = 2
                notice.showError(refusal)
                body.addArrangedSubview(notice)
            }
            body.orientation = .vertical
            body.alignment = .leading
            body.spacing = 3
            body.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            // The text takes the width; the trash sits at the trailing edge
            // rather than wherever the sentence happens to end.
            body.setContentHuggingPriority(.defaultLow, for: .horizontal)

            content.addArrangedSubview(icon)
            content.addArrangedSubview(body)
            row.addSubview(content)
            content.pinToEdges(of: row, insets: SettingsChrome.homeRowInset)
            let click = NSClickGestureRecognizer(target: self, action: #selector(rowClicked(_:)))
            row.addGestureRecognizer(click)
            // Right-click: the same list every note row draws, plus Edit.
            row.menu = NSMenu.workRow(note.rowActions(editable: true, moveTargets: moveTargets)) { [weak self, weak row] action in
                guard let self, let row else { return }
                switch action {
                case .editNote(let note): beginEdit(note, from: row)
                case .fileNote(let note): onSelect?(note)
                case .moveNote(let note, let workspace): onMove?(note, workspace)
                case .deleteNote(let note): onDelete?(note)
                default: break
                }
            }
            row.identifier = NSUserInterfaceItemIdentifier(note.id)
            row.setAccessibilityElement(true)
            row.setAccessibilityRole(.button)
            row.setAccessibilityLabel(String(localized: "\(note.firstLine). Open this note."))

            notesStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: notesStack.widthAnchor).isActive = true
        }
    }

    func setSaving(_ saving: Bool, error: String? = nil) {
        isSaving = saving
        if let popover, popover.isShown {
            // The write came from the popover; it shows the state, and the
            // composer stays as it was.
            popover.setSaving(saving, error: error)
            return
        }
        inputField.isEnabled = !saving
        saveButton.isEnabled = !saving && canSave
        saveButton.alphaValue = saveButton.isEnabled ? 1 : 0.4
        let message = error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if message.isEmpty { statusLabel.clear() } else { statusLabel.showError(message) }
    }

    func markSaved() {
        if let popover, popover.isShown {
            popover.close()
            self.popover = nil
            isSaving = false
            return
        }
        inputField.stringValue = ""
        setSaving(false)
        setExpanded(false)
    }

    private var canSave: Bool {
        !inputField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func controlTextDidChange(_ notification: Notification) {
        saveButton.isEnabled = !isSaving && canSave
        saveButton.alphaValue = saveButton.isEnabled ? 1 : 0.4
    }

    /// Esc folds the composer. The draft stays in the field for the next `+`.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard commandSelector == #selector(NSResponder.cancelOperation(_:)), !isSaving else { return false }
        window?.makeFirstResponder(nil)
        setExpanded(false)
        return true
    }

    /// See more unfolds one more page; Show fewer goes back to one.
    @objc private func foldTapped() {
        let hidden = notes.count - renderedFitCount
        pages = hidden > 0 ? pages + 1 : 1
        noteFloor = 0
        renderNotes()
    }

    @objc private func addTapped() {
        setExpanded(true)
        window?.makeFirstResponder(inputField)
    }

    /// A click on a row opens its popover, anchored to the row.
    private func beginEdit(_ note: QuickNote, from row: NSView) {
        guard !isSaving else { return }
        popover?.close()
        let popover = QuickNotePopover(note: note)
        popover.onSave = { [weak self] note, body in self?.onUpdate?(note, body) }
        popover.onFile = { [weak self] note in self?.onSelect?(note) }
        popover.onDelete = { [weak self] note in self?.onDelete?(note) }
        self.popover = popover
        popover.show(relativeTo: row)
    }

    private func setExpanded(_ expanded: Bool) {
        isExpanded = expanded
        addButton.isHidden = expanded
        inputField.isHidden = !expanded
        saveButton.isHidden = !expanded
    }

    @objc private func saveTapped() {
        let body = inputField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, !isSaving else { return }
        onCreate?(body)
    }

    @objc private func rowClicked(_ sender: NSClickGestureRecognizer) {
        guard let row = sender.view,
              let id = row.identifier?.rawValue,
              let note = notes.first(where: { $0.id == id }) else { return }
        beginEdit(note, from: row)
    }
}
