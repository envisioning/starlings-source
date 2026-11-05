import AppKit

/// Work's triage sheet for one Quick Note: where does this go?
///
/// Four destinations, one sheet. Task and Issue need a subject (Meet's
/// exactly-one-subject invariant), Message needs a conversation, Doc needs
/// only a title. The sheet collects what the chosen
/// destination needs and nothing else; the caller owns the network calls and
/// reports back through `completion`, so a failed filing keeps the sheet open
/// with the choice intact.
@MainActor
enum QuickNoteTriage {
    /// What the owner decided. The note's body travels with the note itself.
    enum Choice {
        case task(subject: CrmSubject, title: String)
        case issue(project: CrmSubject, title: String)
        case message(thread: ThreadSummary)
        case doc(title: String)
    }

    /// Everything the chooser can offer, loaded before the sheet opens.
    struct Options {
        /// Starred first, then the caller's order; a starred row carries a
        /// star so the menu reads like SUBJECTS.
        var subjects: [CrmSubject]
        /// `stateKey`s of the subjects this person starred.
        var starred: Set<String> = []
        var threads: [ThreadSummary]
        var projectsHaveMore = false
        var leadsHaveMore = false
        var partnersHaveMore = false
        var subjectsHaveMore: Bool { projectsHaveMore || leadsHaveMore || partnersHaveMore }
        /// Docs is an optional integration; without a credential the Doc
        /// segment is not offered rather than failing on Save.
        var canFileDocument: Bool
    }

    static func present(
        over window: NSWindow?,
        note: QuickNote,
        load: @escaping () async throws -> Options,
        searchSubjects: @escaping (String, Bool) async throws -> [CrmSubject],
        onFile: @escaping (Choice, @escaping (String?) -> Void) -> Void
    ) {
        QuickNoteTriageSheetController(note: note, load: load, searchSubjects: searchSubjects, onFile: onFile).run(over: window)
    }

    /// The same form without the sheet, for a column to host. It takes the
    /// column's width and ground; `onClose` is Cancel or a filing that landed.
    static func panel(
        note: QuickNote,
        load: @escaping () async throws -> Options,
        searchSubjects: @escaping (String, Bool) async throws -> [CrmSubject],
        onFile: @escaping (Choice, @escaping (String?) -> Void) -> Void,
        onClose: @escaping () -> Void
    ) -> NSViewController {
        QuickNoteTriageSheetController(note: note, load: load, searchSubjects: searchSubjects, onFile: onFile, onClose: onClose)
    }
}

@MainActor
private final class QuickNoteTriageSheetController: NSViewController, NSTextFieldDelegate {
    private enum Metrics {
        static let width: CGFloat = 500
        static let padding: CGFloat = 20
        static let gap: CGFloat = 14
        static let captionGap: CGFloat = 6
        static let buttonHeight: CGFloat = 32
    }

    /// The segments, in the order they are drawn. Doc drops out when Docs is
    /// not connected, so the index into this array is the selected kind.
    /// `.retainedNote` is never offered: it only decodes rows filed before
    /// Keep was removed.
    private var kinds: [QuickNotePromotionKind] = [.task, .issue, .message, .doc]

    private let note: QuickNote
    private let load: () async throws -> QuickNoteTriage.Options
    private let searchSubjects: (String, Bool) async throws -> [CrmSubject]
    private let onFile: (QuickNoteTriage.Choice, @escaping (String?) -> Void) -> Void
    /// Set when a column hosts the form rather than a sheet.
    private let onClose: (() -> Void)?
    private var isEmbedded: Bool { onClose != nil }

    private var options = QuickNoteTriage.Options(subjects: [], threads: [], canFileDocument: false)
    private var isLoading = true
    private var isSaving = false

    private let kindControl = StarlingsSegmentedControl(labels: [])
    private let targetCaption = StarlingsTypography.fieldCaption(String(localized: "File under"))
    private let targetField = StarlingsSearchablePickerField(frame: .zero)
    private let titleCaption = StarlingsTypography.fieldCaption(String(localized: "Task title"))
    private let titleField = StarlingsTextField(placeholder: String(localized: "Title"))
    private let saveButton = StarlingsFilledButton(frame: .zero)
    private let cancelButton = NSButton(title: String(localized: "Cancel"), target: nil, action: nil)
    private let errorLabel = StarlingsNoticeView(wrapping: true)
    private var targetGroup: NSView!
    private var titleGroup: NSView!

    init(
        note: QuickNote,
        load: @escaping () async throws -> QuickNoteTriage.Options,
        searchSubjects: @escaping (String, Bool) async throws -> [CrmSubject],
        onFile: @escaping (QuickNoteTriage.Choice, @escaping (String?) -> Void) -> Void,
        onClose: (() -> Void)? = nil
    ) {
        self.note = note
        self.load = load
        self.searchSubjects = searchSubjects
        self.onFile = onFile
        self.onClose = onClose
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private var selectedKind: QuickNotePromotionKind {
        let index = kindControl.selectedSegment
        return kinds.indices.contains(index) ? kinds[index] : .task
    }

    override func loadView() {
        let root = NSView()
        if !isEmbedded {
            root.wantsLayer = true
            root.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.panel, for: root).cgColor
        }

        let headingLabel = NSTextField(labelWithString: String(localized: "File Quick Note"))
        headingLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(15), weight: .semibold)
        headingLabel.textColor = StarlingsColors.primaryText

        // The note itself, read-only: the sheet is about where it goes, and a
        // body that could be edited here would be a second capture surface.
        let bodyLabel = StarlingsTypography.wrappingLabel(note.body)
        bodyLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        bodyLabel.textColor = StarlingsColors.secondaryText
        bodyLabel.maximumNumberOfLines = 6

        kindControl.target = self
        kindControl.action = #selector(kindChanged)
        rebuildSegments()

        titleField.stringValue = note.body.components(separatedBy: .newlines).first ?? note.body
        titleField.delegate = self

        targetField.onSelection = { [weak self] _ in self?.updateSaveEnabled() }
        targetField.search = { [weak self] query in
            await self?.searchSubjectOptions(query) ?? []
        }

        targetGroup = field(caption: targetCaption, control: targetField)
        titleGroup = field(caption: titleCaption, control: titleField)

        let rows: [NSView] = [headingLabel, bodyLabel, kindControl, targetGroup, titleGroup]
        let form = NSStackView(views: rows)
        form.orientation = .vertical
        form.alignment = .leading
        form.spacing = Metrics.gap
        form.setCustomSpacing(Metrics.padding, after: headingLabel)
        for row in rows where row !== headingLabel {
            row.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
        }

        cancelButton.target = self
        cancelButton.action = #selector(cancel)
        SettingsChrome.applySecondaryButton(cancelButton, height: Metrics.buttonHeight)
        // A sheet owns the keyboard; a column shares its window with a
        // composer that Return must not file a note from.
        if !isEmbedded { cancelButton.keyEquivalent = "\u{1b}" }

        saveButton.target = self
        saveButton.action = #selector(save)
        if !isEmbedded { saveButton.keyEquivalent = "\r" }

        errorLabel.label.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        errorLabel.label.maximumNumberOfLines = 3

        let spacer = NSView()
        spacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        let footer = NSStackView(views: [spacer, cancelButton, saveButton])
        footer.orientation = .horizontal
        footer.alignment = .centerY
        footer.spacing = 10

        let divider = SettingsChrome.hairline()
        let column = NSStackView(views: [form, divider, errorLabel, footer])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = Metrics.padding
        errorLabel.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        root.addSubview(column)
        column.pinToEdges(of: root, insets: NSEdgeInsets(
            top: Metrics.padding,
            left: Metrics.padding,
            bottom: Metrics.padding,
            right: Metrics.padding
        ))
        NSLayoutConstraint.activate([
            form.widthAnchor.constraint(equalTo: column.widthAnchor),
            divider.widthAnchor.constraint(equalTo: column.widthAnchor),
            footer.widthAnchor.constraint(equalTo: column.widthAnchor),
        ])
        if !isEmbedded {
            root.widthAnchor.constraint(equalToConstant: Metrics.width).isActive = true
        }
        view = root

        applyKind()
        Task { await loadOptions() }
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        view.window?.makeFirstResponder(titleField)
    }

    private func loadOptions() async {
        isLoading = true
        applyKind()
        do {
            options = try await load()
            errorLabel.clear()
        } catch {
            errorLabel.showError((error as? StarlingsError)?.message ?? String(localized: "Couldn’t load places to file this note."))
        }
        isLoading = false
        rebuildSegments()
        applyKind()
        resizeToFit()
    }

    private func rebuildSegments() {
        let current = selectedKind
        kinds = [.task, .issue, .message] + (options.canFileDocument ? [.doc] : [])
        kindControl.segmentCount = kinds.count
        for (index, kind) in kinds.enumerated() {
            kindControl.setLabel(Self.segmentLabel(kind), forSegment: index)
        }
        kindControl.selectedSegment = kinds.firstIndex(of: current) ?? 0
    }

    /// The words are `QUICK_NOTE_TRIAGE` (Generated/QuickNoteValuesRegistry.swift).
    private static func segmentLabel(_ kind: QuickNotePromotionKind) -> String {
        kind.triageLabel
    }

    /// Show the fields the chosen destination needs and repopulate the
    /// target list for it. Task and Issue share the subject list; Issue only
    /// takes projects because an issue lives in a repository, and leads have
    /// none.
    @objc private func kindChanged() {
        targetField.selectedID = nil
        applyKind()
        resizeToFit()
    }

    private func applyKind() {
        let kind = selectedKind
        var pickerOptions: [StarlingsSearchablePickerOption] = []
        var pickerPlaceholder = ""
        switch kind {
        case .task, .issue:
            targetCaption.stringValue = kind == .issue ? String(localized: "File under (project)") : String(localized: "File under")
            let subjects = options.subjects.filter { kind == .task || $0.kind == "project" }
            pickerPlaceholder = isLoading ? String(localized: "Loading…") : String(localized: "Choose a \(kind == .issue ? "project" : "project, lead or partner")")
            pickerOptions = subjects.map(subjectOption)
        case .message:
            targetCaption.stringValue = String(localized: "Send to")
            pickerPlaceholder = isLoading ? String(localized: "Loading…") : String(localized: "Choose a conversation")
            pickerOptions = options.threads.map { thread in
                StarlingsSearchablePickerOption(id: thread.id, title: thread.title, context: nil, subtitle: nil, isStarred: false)
            }
        case .doc, .retainedNote:
            break
        }
        targetField.setOptions(pickerOptions, placeholder: pickerPlaceholder, selectedID: targetField.selectedID)
        let canSearch = kind == .issue ? options.projectsHaveMore : options.subjectsHaveMore
        targetField.isEnabled = !isLoading && (!pickerOptions.isEmpty || canSearch)
        targetGroup.isHidden = kind == .doc || kind == .retainedNote
        titleGroup.isHidden = kind == .message
        titleCaption.stringValue = kind.triageTitleCaption
        applySaveTitle(actionTitle(for: kind))
        updateSaveEnabled()
    }

    private func actionTitle(for kind: QuickNotePromotionKind) -> String {
        kind.triageAction
    }

    func controlTextDidChange(_ notification: Notification) {
        updateSaveEnabled()
    }

    private var chosenSubject: CrmSubject? {
        options.subjects.first { "\($0.kind):\($0.id)" == targetField.selectedID }
    }

    private var chosenThread: ThreadSummary? {
        options.threads.first { $0.id == targetField.selectedID }
    }

    private func updateSaveEnabled() {
        guard !isSaving, !isLoading else {
            saveButton.isEnabled = false
            return
        }
        let title = trimmedTitle
        saveButton.isEnabled = switch selectedKind {
        case .task, .issue: chosenSubject != nil && !title.isEmpty
        case .message: chosenThread != nil
        case .doc: !title.isEmpty
        case .retainedNote: false
        }
    }

    private var trimmedTitle: String {
        titleField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func choice() -> QuickNoteTriage.Choice? {
        switch selectedKind {
        case .task:
            guard let subject = chosenSubject, !trimmedTitle.isEmpty else { return nil }
            return .task(subject: subject, title: trimmedTitle)
        case .issue:
            guard let project = chosenSubject, !trimmedTitle.isEmpty else { return nil }
            return .issue(project: project, title: trimmedTitle)
        case .message:
            guard let thread = chosenThread else { return nil }
            return .message(thread: thread)
        case .doc:
            guard !trimmedTitle.isEmpty else { return nil }
            return .doc(title: trimmedTitle)
        case .retainedNote:
            return nil
        }
    }

    private func subjectOption(_ subject: CrmSubject) -> StarlingsSearchablePickerOption {
        StarlingsSearchablePickerOption(
            id: "\(subject.kind):\(subject.id)",
            title: subject.title,
            context: subject.pickerKindLabel,
            subtitle: subject.subtitle,
            isStarred: options.starred.contains(subject.stateKey)
        )
    }

    private func searchSubjectOptions(_ query: String) async -> [StarlingsSearchablePickerOption] {
        let projectsOnly = selectedKind == .issue
        guard projectsOnly ? options.projectsHaveMore : options.subjectsHaveMore else { return [] }
        do {
            let found = try await searchSubjects(query, projectsOnly)
            var byID = Dictionary(options.subjects.map { ("\($0.kind):\($0.id)", $0) }, uniquingKeysWith: { first, _ in first })
            for subject in found { byID["\(subject.kind):\(subject.id)"] = subject }
            options.subjects = Array(byID.values).sorted {
                let (a, b) = (options.starred.contains($0.stateKey), options.starred.contains($1.stateKey))
                if a != b { return a }
                return $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
            }
            targetField.updateOptions(options.subjects
                .filter { selectedKind == .task || $0.kind == "project" }
                .map(subjectOption))
            return found.map(subjectOption)
        } catch {
            return []
        }
    }

    @objc private func cancel() { close() }

    @objc private func save() {
        guard !isSaving, let choice = choice() else { return }
        // Stay open until the filing lands, so a Core or Docs hiccup leaves
        // the choice where it was for another try.
        isSaving = true
        errorLabel.clear()
        kindControl.isEnabled = false
        applySaveTitle(String(localized: "Filing…"))
        updateSaveEnabled()
        onFile(choice) { [weak self] errorMessage in
            guard let self else { return }
            isSaving = false
            kindControl.isEnabled = true
            guard let errorMessage else {
                close()
                return
            }
            applySaveTitle(actionTitle(for: selectedKind))
            updateSaveEnabled()
            errorLabel.showError(errorMessage)
            resizeToFit()
        }
    }

    private func applySaveTitle(_ title: String) {
        saveButton.apply(
            .accent,
            title: title,
            font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold),
            height: Metrics.buttonHeight
        )
    }

    private func field(caption: NSTextField, control: NSView) -> NSView {
        let group = NSStackView(views: [caption, control])
        group.orientation = .vertical
        group.alignment = .leading
        group.spacing = Metrics.captionGap
        control.widthAnchor.constraint(equalTo: group.widthAnchor).isActive = true
        return group
    }

    private func resizeToFit() {
        guard !isEmbedded, let window = view.window else { return }
        view.layoutSubtreeIfNeeded()
        window.setContentSize(view.fittingSize)
    }

    func run(over parent: NSWindow?) {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: NSSize(width: Metrics.width, height: 100)),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.title = String(localized: "File Quick Note")
        window.isReleasedWhenClosed = false
        window.contentViewController = self
        guard let parent else {
            window.center()
            NSApp.runModal(for: window)
            window.orderOut(nil)
            return
        }
        parent.beginSheet(window) { _ in window.orderOut(nil) }
    }

    private func close() {
        if let onClose { onClose(); return }
        guard let window = view.window else { return }
        if let parent = window.sheetParent {
            parent.endSheet(window)
        } else {
            NSApp.stopModal()
            window.orderOut(nil)
        }
    }
}
