import AppKit
import CoreKit
import StarlingsContracts
import OSLog
import DocsUI
import SwiftUI
import UniformTypeIdentifiers

/// What the Work window's inspector column is showing.
enum WorkInspectorItem {
    case issue(CrmIssue)
    case interaction(CrmInteraction)
    /// `canFile` — a repository is linked and the task has not been filed yet.
    /// `subject` is the project or lead it belongs to, where that is known:
    /// a task read on its own says what it is about, and offers a way there.
    case task(CrmTask, canFile: Bool, subject: CrmSubject?)
    case newIssue(CrmSubject)
    /// A document from Docs, edited here beside the list it was chosen from.
    /// docs/DOCS.md: the middle column selects, this column edits.
    case document(id: String, title: String)
    /// An unfiled Quick Note, opened like a task or an issue: the filing
    /// form in this column rather than a sheet over the window.
    case quickNote(QuickNote)
    /// A contact's page, from an organization's page or search.
    /// `name` draws the head while the page loads.
    case contact(id: String, name: String)
}

/// Read-only context for a selection that is not itself an editable task or
/// issue. Team and Work use the same shape so the right sidebar never becomes
/// an empty dead end merely because the middle column is showing a list or a
/// conversation.
struct WorkInspectorInfo: Equatable {
    struct Section: Equatable {
        let title: String
        let lines: [String]

        init(_ title: String, lines: [String]) {
            self.title = title
            self.lines = lines
        }
    }

    let title: String
    let subtitle: String
    let sections: [Section]
    /// Who is on it, drawn first: a conversation's sidebar always says who
    /// is there. Nil for a selection that is not a conversation.
    var team: ConversationTeam? = nil
}

/// The third column of Work: the one task or issue somebody chose, read and
/// acted on beside the list it came from rather than in a sheet over it.
///
/// It never owns the list. Every write reports back so the subject's panes
/// can catch up, and the window decides when the column shows or hides —
/// the toolbar's inspector toggle is the way to put it away, like every
/// other Mac inspector.
///
/// Body and comments are markdown, rendered with the platform's own parser.
/// Anything it cannot represent stays visible as the markdown it is — legible,
/// and honest about what it is, which beats silently dropping a code block.
@MainActor
final class WorkInspectorViewController: NSViewController {
    private static let peerCalendarLog = Logger(subsystem: ContractConstants.nativeAppBundleID, category: "PeerCalendar")

    /// An issue was commented on, closed, or reopened.
    var onIssueChanged: (() -> Void)?
    /// A draft became an issue. The inspector moves on to the issue itself.
    var onIssueFiled: ((CrmIssue) -> Void)?
    /// The task form uses Core's roster for named assignment.
    var taskTeam: [CrmTeamMember] = []
    /// The selected project's live goals, for the task editor's
    /// Goal menu. Offered only to a task on that project: a Mine task from
    /// another project would be offered the wrong list.
    var taskGoals: [CrmGoal] = []
    /// A task was saved from the inline editor; the surrounding lists should
    /// refresh their summaries without replacing the form under the cursor.
    var onTaskChanged: (() -> Void)?
    var onToggleTaskDone: ((CrmTask, Bool) -> Void)?
    var onPromoteTask: ((CrmTask) -> Void)?
    /// Somebody asked for the project or lead a task is about. Only wired
    /// where there is somewhere to go: the column beside a subject's own list
    /// is already on it.
    var onOpenSubject: ((CrmSubject) -> Void)?
    /// The person is done with what was here — a draft discarded, a note
    /// filed or left.
    var onDismiss: (() -> Void)?
    /// A Quick Note shown here was filed; the lists it sat in re-read.
    var onQuickNoteFiled: ((QuickNote, QuickNotePromotionKind) -> Void)?
    /// Return from an item reader to the subject metadata behind it.
    var onReturnToContext: (() -> Void)?
    /// A contact was added or edited here; the organization page beside it re-reads.
    var onContactChanged: ((CrmContactDetail) -> Void)?
    /// A contact was merged away or deleted here; the lists that
    /// showed it re-read.
    var onContactRemoved: ((String) -> Void)?
    /// A task was deleted here; the lists that showed it drop
    /// the row. The inspector closes itself after.
    var onTaskDeleted: ((String) -> Void)?
    /// An interaction was edited here; History re-reads. The
    /// column shows the saved row.
    var onInteractionChanged: ((CrmInteraction) -> Void)?
    /// An interaction was deleted here; History re-reads. The
    /// inspector closes itself after.
    var onInteractionDeleted: ((String) -> Void)?
    /// A person in a context group's roster was chosen; the owning surface
    /// opens the corresponding direct message in Team.
    var onOpenPeer: ((String) -> Void)?
    /// A person row's menu on a project or lead: "Make responsible". Nil
    /// elsewhere; the controller owns the write (docs/OWNERSHIP.md).
    var onMakeResponsible: ((String) -> Void)?
    /// Start a task from a person's context; the Team surface supplies the
    /// searchable subject list and owns the resulting refresh.
    var onNewTaskForPeer: ((Peer) -> Void)?
    /// The project the list beside this column is on, when it is on one.
    ///
    /// Sent with a close or a reopen so the project's channel gets a line
    /// about it. GitHub's issue does not know which of our projects it belongs
    /// to, and an issue read from Mine belongs to no one project here — so
    /// this is nil there, and that change simply goes unreported.
    var subjectProjectID: String?
    /// This Mac's Docs session, for the document editor. Set by the window;
    /// a document cannot be shown without one.
    var docsSession: DocsSession?
    /// Core, for the editor's subject chips: names, and search to add one.
    /// Nil leaves the chips read-only.
    var coreSession: CoreSession?

    private let api: MeetingControlAPI
    /// The rung this column sits on. The inspector is a panel beside the
    /// content; the same view used *as* the content sits on the canvas.
    private let ground: NSColor
    private(set) var item: WorkInspectorItem?
    private let stack = NSStackView()
    /// The open task's Activity: what was said about it.
    private let taskActivity = NSStackView()
    private var taskActivityLoad: Task<Void, Never>?
    private var taskActivityLines: [ThreadMessage] = []
    private var taskActivitySelections: [String: Set<String>] = [:]
    private var taskActivitySubmitting: Set<String> = []
    private var taskActivityErrors: [String: String] = [:]
    private let returnContextButton = NSButton()
    /// The document editor takes the whole column, like the person panel:
    /// its own scrolling, its own title, none of the stack's insets.
    private let documentHost = NSHostingView(rootView: AnyView(EmptyView()))
    /// The document whose editor is mounted here, if any. Nil while the
    /// document floats in a window of its own.
    private(set) var editingDocumentID: String?
    /// Stands in for the editor while the document floats: one document,
    /// one editor, and a way to it.
    private let floatingNotice = NSStackView()
    private let emptyLabel: NSTextField
    private let statusLabel = StarlingsNoticeView()
    /// The person surface's right column. Built here rather than in its own
    /// split item so the inspector toggle keeps meaning one thing: a task, an
    /// issue, or a colleague — whichever the middle column is showing.
    private let personPanel = WorkPersonPanelView()
    private var personContext = false
    private var personLoad: Task<Void, Never>?
    private var personCalendarLoad: Task<Void, Never>?
    private var loadTask: Task<Void, Never>?
    private var taskWrite: Task<Void, Never>?
    /// The filing form on screen, held for as long as its view is.
    private var quickNotePanel: NSViewController?

    // Issue mode.
    private lazy var reading = WorkIssueReadingView(ground: ground, api: api)
    /// What each repository will accept, kept for the life of the column so
    /// reading five issues in one repository asks once.
    private var facetsByRepo: [String: CrmIssueFacets] = [:]
    /// The last detail drawn, so the rail can be redrawn when the pickers
    /// arrive without asking GitHub for the issue a second time.
    private var shownDetail: CrmIssueDetail?
    private let commentField = StarlingsTextField(placeholder: String(localized: "Write a comment"))
    /// Only offered while the issue is open: there is no reason to reopen with.
    private weak var closeReasonButton: NSButton?
    /// Built afresh with each issue: styling a button installs hover tracking,
    /// and styling the same one twice stacks it.
    private var stateButton = NSButton()
    private var isOpen = true

    // Draft mode.
    private let titleField = StarlingsTextField(placeholder: String(localized: "Title"))
    private let draftText = NSTextView()
    private var draft = CrmIssueDraftExtras()
    private var draftFacets = CrmIssueFacets.none
    private weak var draftRow: NSStackView?

    // Task editor mode. These are rebuilt with the selected task so a task
    // clicked from either Work list gets the same fields and save semantics.
    private var taskTitleEditorField: StarlingsTextField?
    private var taskNotesEditorField: NSTextView?
    private var taskResponsibleField: StarlingsPopUpField?
    private var taskStatusField: StarlingsPopUpField?
    private var taskAssigneeField: StarlingsSearchablePickerField?
    private var taskGoalField: StarlingsSearchablePickerField?
    private var taskAssigneeID: String?
    private var taskGoalID: String?
    private weak var taskAssigneeGroup: NSView?
    private var taskDuePicker: StarlingsDatePickerField?
    private var taskDueToggle: NSButton?
    private weak var taskSaveButton: NSButton?
    private weak var taskRetryButton: NSButton?
    /// The task on screen is only Mine's summary (no assignee or responsible
    /// party): read-only until the full record lands, so nothing is written
    /// from defaults. Set by the window before it shows the summary.
    var partialTaskID: String?
    var onRetryFullTask: (() -> Void)?

    init(
        api: MeetingControlAPI,
        ground: NSColor = StarlingsColors.panel,
        emptyMessage: String = "Select a task, issue, or interaction to see it here."
    ) {
        self.api = api
        self.ground = ground
        emptyLabel = StarlingsTypography.wrappingLabel(emptyMessage)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func loadView() {
        let root = StarlingsShellBackdrop(ground: ground)

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.distribution = .fill
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.setClippingResistancePriority(.defaultLow, for: .horizontal)
        root.addSubview(stack)
        stack.pinToEdges(of: root, insets: NSEdgeInsets(top: 16, left: 16, bottom: 14, right: 16))

        returnContextButton.image = NSImage(
            systemSymbolName: "arrow.left",
            accessibilityDescription: String(localized: "Back to subject")
        )
        returnContextButton.bezelStyle = .inline
        returnContextButton.isBordered = false
        returnContextButton.toolTip = String(localized: "Back to subject")
        returnContextButton.setAccessibilityLabel(String(localized: "Back to subject"))
        returnContextButton.target = self
        returnContextButton.action = #selector(returnToContextPressed)
        returnContextButton.isHidden = true
        SettingsChrome.applyQuietButton(returnContextButton)
        returnContextButton.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(returnContextButton)
        NSLayoutConstraint.activate([
            returnContextButton.topAnchor.constraint(equalTo: root.topAnchor, constant: 12),
            returnContextButton.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
            returnContextButton.widthAnchor.constraint(equalToConstant: 28),
            returnContextButton.heightAnchor.constraint(equalToConstant: 28),
        ])

        emptyLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        emptyLabel.textColor = StarlingsColors.secondaryText
        emptyLabel.alignment = .center
        emptyLabel.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(emptyLabel)
        NSLayoutConstraint.activate([
            emptyLabel.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            emptyLabel.widthAnchor.constraint(lessThanOrEqualTo: root.widthAnchor, constant: -48),
        ])

        statusLabel.hidesWhenEmpty = false
        statusLabel.label.allowSqueezing()
        statusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        commentField.target = self
        commentField.action = #selector(commentPressed)

        personPanel.isHidden = true
        hideDocument()
        personPanel.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(personPanel)
        NSLayoutConstraint.activate([
            personPanel.topAnchor.constraint(equalTo: root.topAnchor),
            personPanel.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            personPanel.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            personPanel.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])

        documentHost.isHidden = true
        documentHost.translatesAutoresizingMaskIntoConstraints = false
        // The column decides the width, not the SwiftUI inside it. With the
        // default sizing options the host adds min/max/intrinsic width
        // constraints from the editor's own layout, and the divider stops
        // moving — the inspector could only stay where it was or collapse.
        documentHost.sizingOptions = []
        root.addSubview(documentHost)
        NSLayoutConstraint.activate([
            documentHost.topAnchor.constraint(equalTo: root.topAnchor),
            documentHost.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            documentHost.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            documentHost.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])
        buildFloatingNotice(in: root)

        // Adding an existing subview again moves it above the document host,
        // which is pinned to the whole inspector.
        root.addSubview(returnContextButton)

        view = root
        personPanel.onOpenTask = { [weak self] task in self?.openPersonTask(task) }
        personPanel.onOpenIssue = { [weak self] issue in
            guard let self else { return }
            subjectProjectID = nil
            show(.issue(issue))
        }
        personPanel.onNewTask = { [weak self] peer in self?.onNewTaskForPeer?(peer) }
        FloatingDocuments.shared.register(self)
        // Selector-based, so it goes with the controller; posted on main.
        NotificationCenter.default.addObserver(
            self, selector: #selector(floatingDidChange(_:)),
            name: FloatingDocuments.didChangeNotification, object: nil
        )
        NotificationCenter.default.addObserver(
            self, selector: #selector(documentTitleDidChange(_:)),
            name: DocsOpenEditors.titleDidChangeNotification, object: nil
        )
        NotificationCenter.default.addObserver(
            self, selector: #selector(documentArchived(_:)),
            name: DocsOpenEditors.archivedNotification, object: nil
        )
    }

    // MARK: - What to show

    func show(_ item: WorkInspectorItem) {
        loadTask?.cancel()
        taskWrite?.cancel()
        personLoad?.cancel()
        personCalendarLoad?.cancel()
        personPanel.isHidden = true
        hideDocument()
        self.item = item
        returnContextButton.isHidden = false
        setReturnContextLabel(personContext ? String(localized: "Back to person") : String(localized: "Back to subject"))
        clearContent()
        statusLabel.clear()
        switch item {
        case .issue(let issue): buildIssue(issue)
        case .interaction(let interaction): buildInteraction(interaction)
        case .task(let task, let canFile, let subject): buildTask(task, canFile: canFile, subject: subject)
        case .newIssue(let subject): buildDraft(for: subject)
        case .document(let id, _): buildDocument(id: id)
        case .quickNote(let note): buildQuickNote(note)
        case .contact(let id, let name): buildContact(id: id, name: name)
        }
    }

    // MARK: - Contact

    /// The contact this column shows, once it has loaded; Edit opens it.
    private var shownContact: CrmContactDetail?
    /// Merge and Delete failures on the contact page, in red with Copy. A 409
    /// on Delete is the Worker's sentence naming the calls and tasks.
    private let contactNotice = StarlingsNoticeView(wrapping: true)

    private func buildContact(id: String, name: String) {
        shownContact = nil
        add(header(title: name, subtitle: ""))
        StarlingsPlaceholderRowView.rows(glyph: false).forEach { add($0) }
        loadTask = Task { [weak self] in
            guard let self else { return }
            do {
                let contact = try await api.crmContact(id: id)
                guard !Task.isCancelled, case .contact(let shown, _) = item, shown == id else { return }
                // A merged id: the column holds the survivor's id from here on.
                if let mergedID = contact.mergedFrom, contact.id != id {
                    SearchRecents.replace(mergedID: mergedID, with: nil, owner: api.signedInOwnerEmail ?? "")
                    item = .contact(id: contact.id, name: contact.displayName)
                }
                renderContact(contact)
            } catch {
                guard !Task.isCancelled, case .contact(let shown, _) = item, shown == id else { return }
                clearContent()
                add(header(title: name, subtitle: ""))
                statusLabel.showError((error as? StarlingsError)?.message ?? String(localized: "Couldn’t load that contact"))
                add(statusLabel)
            }
        }
    }

    private func renderContact(_ contact: CrmContactDetail) {
        clearContent()
        shownContact = contact
        add(header(title: contact.displayName, subtitle: contact.context))
        let edit = NSButton(title: String(localized: "Edit"), target: self, action: #selector(editContactPressed))
        SettingsChrome.applySecondaryButton(edit, title: String(localized: "Edit"), height: 28)
        var buttons = [edit]
        if contact.organizationSubject != nil {
            let organization = NSButton(title: String(localized: "Open organization"), target: self, action: #selector(openContactOrganization))
            SettingsChrome.applySecondaryButton(organization, title: String(localized: "Open organization"), height: 28)
            buttons.append(organization)
        }
        add(actionRow(buttons))
        let merge = NSButton(title: String(localized: "Merge…"), target: self, action: #selector(mergeContactPressed))
        SettingsChrome.applySecondaryButton(merge, symbolName: "arrow.triangle.merge", height: 28)
        let delete = NSButton(title: String(localized: "Delete"), target: self, action: #selector(deleteContactPressed))
        SettingsChrome.applySecondaryButton(delete, symbolName: "trash", height: 28)
        SettingsChrome.setSecondaryButtonTitle(delete, String(localized: "Delete"), color: StarlingsColors.danger)
        add(actionRow([merge, delete]))
        contactNotice.clear()
        add(contactNotice)
        let sections = WorkContactPage.sections(
            contact,
            onOpenSubject: { [weak self] subject in self?.onOpenSubject?(subject) },
            onOpenCall: { [weak self] interaction in self?.show(.interaction(interaction)) }
        )
        for section in sections { add(section) }
    }

    @objc private func editContactPressed() {
        guard let contact = shownContact else { return }
        WorkContactEditor.present(over: view.window, api: api, contact: contact) { [weak self] saved in
            guard let self, case .contact(let shown, _) = item, shown == saved.id else { return }
            renderContact(saved)
            onContactChanged?(saved)
        }
    }

    /// Merge a duplicate into this contact: the sheet picks it,
    /// a question confirms, then the contact that stayed opens. The oldest
    /// stays, so it can be the duplicate.
    @objc private func mergeContactPressed() {
        guard let contact = shownContact else { return }
        ContactMergeSheet.present(over: view.window, api: api, contact: contact) { [weak self] duplicate in
            self?.confirmMergeContact(contact, with: duplicate)
        }
    }

    private func confirmMergeContact(_ contact: CrmContactDetail, with duplicate: StarlingsSearchablePickerOption) {
        let alert = NSAlert()
        alert.messageText = String(localized: "Merge “\(contact.displayName)” and “\(duplicate.title)”?")
        alert.informativeText = String(localized: "The older one keeps every link and address, and the other is deleted for good.")
        alert.alertStyle = .warning
        alert.addButton(withTitle: String(localized: "Merge"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        alert.buttons.first?.hasDestructiveAction = true
        let proceed: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            self?.mergeContacts(contact, duplicate: duplicate)
        }
        if let window = view.window { alert.beginSheetModal(for: window, completionHandler: proceed) } else { proceed(alert.runModal()) }
    }

    private func mergeContacts(_ contact: CrmContactDetail, duplicate: StarlingsSearchablePickerOption) {
        contactNotice.clear()
        Task { [weak self] in
            guard let self else { return }
            do {
                let answer = try await api.mergeCrmContacts(ids: [contact.id, duplicate.id])
                for id in answer.merged { onContactRemoved?(id) }
                let keptName = answer.kept == contact.id ? contact.displayName : duplicate.title
                show(.contact(id: answer.kept, name: keptName))
            } catch {
                guard case .contact(let shown, _) = item, shown == contact.id else { return }
                contactNotice.showError(error)
            }
        }
    }

    /// Delete this contact, after a question. The Worker refuses
    /// while a call or a task references it; its message shows on the page.
    @objc private func deleteContactPressed() {
        guard let contact = shownContact else { return }
        let alert = NSAlert()
        alert.messageText = String(localized: "Delete “\(contact.displayName)”?")
        alert.informativeText = String(localized: "Its leads and projects stay. This can’t be undone.")
        alert.alertStyle = .warning
        alert.addButton(withTitle: String(localized: "Delete"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        alert.buttons.first?.hasDestructiveAction = true
        let proceed: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            self?.deleteContact(contact)
        }
        if let window = view.window { alert.beginSheetModal(for: window, completionHandler: proceed) } else { proceed(alert.runModal()) }
    }

    private func deleteContact(_ contact: CrmContactDetail) {
        contactNotice.clear()
        Task { [weak self] in
            guard let self else { return }
            do {
                try await api.deleteCrmContact(id: contact.id)
                onContactRemoved?(contact.id)
                guard case .contact(let shown, _) = item, shown == contact.id else { return }
                onDismiss?()
            } catch {
                guard case .contact(let shown, _) = item, shown == contact.id else { return }
                contactNotice.showError(error)
            }
        }
    }

    /// Delete the task shown, after a question. A refusal shows
    /// red with Copy on the page; a success tells the lists and closes.
    @objc private func deleteTaskPressed() {
        guard case .task(let task, _, _) = item else { return }
        TaskDeleteAlert.ask(title: task.title, over: view.window) { [weak self] in
            self?.deleteTask(task)
        }
    }

    private func deleteTask(_ task: CrmTask) {
        statusLabel.clear()
        Task { [weak self] in
            guard let self else { return }
            do {
                try await api.deleteCrmTask(id: task.id)
                onTaskDeleted?(task.id)
                closeIfShowing(taskID: task.id)
            } catch {
                guard case .task(let shown, _, _) = item, shown.id == task.id else { return }
                if let typed = error as? StarlingsError {
                    statusLabel.showError(typed)
                } else {
                    statusLabel.showError(TaskDeleteCopy.failure, detail: error.localizedDescription)
                }
            }
        }
    }

    /// The task shown here is gone: close, as a discarded draft does.
    func closeIfShowing(taskID: String) {
        guard case .task(let shown, _, _) = item, shown.id == taskID else { return }
        onDismiss?()
    }

    @objc private func openContactOrganization() {
        guard let subject = shownContact?.organizationSubject else { return }
        onOpenSubject?(subject)
    }

    // MARK: - Quick Note

    private func buildQuickNote(_ note: QuickNote) {
        guard let docsSession else {
            statusLabel.showError(String(localized: "Couldn’t open that note."))
            return
        }
        let panel = QuickNoteFiling.panel(
            note: note, api: api, docs: docsSession,
            onFiled: { [weak self] filed, kind in self?.onQuickNoteFiled?(filed, kind) },
            onClose: { [weak self] in
                guard let self, case .quickNote(let shown) = item, shown.id == note.id else { return }
                onDismiss?()
            }
        )
        quickNotePanel = panel
        add(panel.view)
    }

    // MARK: - Document

    /// The editor owns everything about the document — title, body, saving,
    /// conflicts — so this only hosts it. The host is rebuilt per document
    /// and torn down on leave so an editor never outlives what it was
    /// editing; the editor flushes on disappear.
    private func buildDocument(id: String) {
        guard let docsSession else {
            statusLabel.setText(String(localized: "Docs isn’t connected."))
            return
        }
        emptyLabel.isHidden = true
        guard !FloatingDocuments.shared.isFloating(id) else {
            floatingNotice.isHidden = false
            return
        }
        editingDocumentID = id
        // Keyed by id: two documents in a row are the same view type, and
        // without an explicit identity SwiftUI updates the first editor in
        // place — its state object, and the document it was on, survive.
        let directory: SubjectDirectory? = coreSession.flatMap { core in
            core.isLinked ? CoreSubjectDirectory(repository: core.repository, contracts: core.contracts) : nil
        }
        documentHost.rootView = meetHosted(
            DocumentEditor(
                documentID: id, client: docsSession.client, directory: directory,
                // Read again goes through the Worker's page reader.
                linkRefetch: { [api] documentID in try await api.refetchDocsLink(documentID: documentID) },
                onToast: { [weak self] message in
                    MainActor.assumeIsolated { StarlingsToast.show(message, in: self?.view.window) }
                },
                // A wikilink opens its document in Docs, the palette's door.
                onOpenDocument: { id, title in
                    MainActor.assumeIsolated {
                        (NSApp.delegate as? AppDelegate)?.mainWindowController?.openDocument(id: id, title: title)
                    }
                }
            )
                .id(id)
                .background(Color(nsColor: ground))
        )
        documentHost.isHidden = false
    }

    private func hideDocument() {
        floatingNotice.isHidden = true
        editingDocumentID = nil
        guard !documentHost.isHidden else { return }
        documentHost.isHidden = true
        documentHost.rootView = meetHosted(EmptyView())
    }

    // MARK: - Floating

    /// The document this column is on, floating or not.
    var openDocument: (id: String, title: String)? {
        if case .document(let id, let title) = item { return (id, title) }
        return nil
    }

    /// Float the document this column is on, or bring its window forward.
    func floatOpenDocument() {
        guard let openDocument else { return }
        FloatingDocuments.shared.float(id: openDocument.id, title: openDocument.title)
    }

    /// A document started or stopped floating. The column on it swaps its
    /// editor for the notice, or back; tearing the editor down is its save.
    @objc private func floatingDidChange(_ note: Notification) {
        guard let openDocument, openDocument.id == note.userInfo?["id"] as? String else { return }
        hideDocument()
        buildDocument(id: openDocument.id)
    }

    /// A rename, here or anywhere: the title Float and the host read follows.
    @objc private func documentTitleDidChange(_ note: Notification) {
        guard let openDocument, openDocument.id == note.userInfo?["id"] as? String,
              let title = note.userInfo?["title"] as? String else { return }
        item = .document(id: openDocument.id, title: title)
    }

    /// The document shown here was archived: the column lets it go.
    @objc private func documentArchived(_ note: Notification) {
        guard let openDocument, openDocument.id == note.userInfo?["id"] as? String else { return }
        if let onDismiss { onDismiss() } else { clear() }
    }

    private func buildFloatingNotice(in root: NSView) {
        let label = StarlingsTypography.wrappingLabel(String(localized: "This document is open in its own window."))
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        label.textColor = StarlingsColors.secondaryText
        label.alignment = .center
        let button = NSButton(title: String(localized: "Bring to Front"), target: self, action: #selector(bringFloatingForward))
        SettingsChrome.applySecondaryButton(button, title: String(localized: "Bring to Front"), symbolName: "macwindow.on.rectangle", height: 28)
        NSLayoutConstraint.activate([
            button.heightAnchor.constraint(equalToConstant: 28),
            button.widthAnchor.constraint(greaterThanOrEqualToConstant: 160),
        ])
        floatingNotice.orientation = .vertical
        floatingNotice.alignment = .centerX
        floatingNotice.spacing = 10
        floatingNotice.addArrangedSubview(label)
        floatingNotice.addArrangedSubview(button)
        floatingNotice.isHidden = true
        floatingNotice.translatesAutoresizingMaskIntoConstraints = false
        floatingNotice.setClippingResistancePriority(.defaultLow, for: .horizontal)
        root.addSubview(floatingNotice)
        NSLayoutConstraint.activate([
            floatingNotice.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            floatingNotice.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            floatingNotice.widthAnchor.constraint(lessThanOrEqualTo: root.widthAnchor, constant: -48),
        ])
    }

    @objc private func bringFloatingForward() {
        guard let openDocument else { return }
        FloatingDocuments.shared.bringForward(openDocument.id)
    }

    func clear() {
        loadTask?.cancel()
        taskWrite?.cancel()
        personLoad?.cancel()
        personCalendarLoad?.cancel()
        item = nil
        personContext = false
        setReturnContextLabel(String(localized: "Back to subject"))
        returnContextButton.isHidden = true
        personPanel.isHidden = true
        hideDocument()
        clearContent()
    }

    /// Show context for a list, channel, subject, or registry view. This is a
    /// separate mode from `item`: it has no editor and therefore cannot steal
    /// the task/issue callbacks or make the toolbar inspector look selected
    /// for something that is not actionable.
    func showInfo(_ info: WorkInspectorInfo) {
        loadTask?.cancel()
        taskWrite?.cancel()
        personLoad?.cancel()
        personCalendarLoad?.cancel()
        item = nil
        personContext = false
        setReturnContextLabel(String(localized: "Back to subject"))
        returnContextButton.isHidden = true
        personPanel.isHidden = true
        hideDocument()
        clearContent()
        emptyLabel.isHidden = true
        statusLabel.clear()
        add(header(title: info.title, subtitle: info.subtitle))
        if let team = info.team {
            for section in teamSections(team) { add(section) }
        }
        for section in info.sections where !section.lines.isEmpty {
            add(infoSection(section.title, lines: section.lines))
        }
    }

    /// The colleague whose conversation is open in the middle column.
    ///
    /// Drawn immediately from the roster row, which is already in hand, and
    /// filled in when Core answers — nobody waits on a CRM round trip to see
    /// who they are looking at. A failed read says so rather than reading as
    /// "nothing open", because those look identical and mean opposite things.
    func showPerson(_ peer: Peer, api: MeetingControlAPI, mine: [CrmMyTask]) {
        loadTask?.cancel()
        taskWrite?.cancel()
        personLoad?.cancel()
        personCalendarLoad?.cancel()
        item = nil
        personContext = true
        returnContextButton.isHidden = true
        setReturnContextLabel(String(localized: "Back to person"))
        clearContent()
        personPanel.show(
            peer,
            work: WorkPersonPanelView.Work(
                mine: mine,
                workLoading: !peer.isAgent && !peer.isSelf,
                calendarLoading: !peer.isAgent && !peer.isSelf
            )
        )
        emptyLabel.isHidden = true
        personPanel.isHidden = false

        // An agent has no CRM record and owes nothing: asking Core about one
        // would be a round trip whose only possible answer is "no such member".
        guard !peer.isAgent, !peer.isSelf else { return }
        personLoad = Task { [weak self] in
            do {
                let theirs = try await api.crmWork(assigneeEmail: peer.email)
                guard let self, !Task.isCancelled else { return }
                self.personPanel.setWork(WorkPersonPanelView.Work(
                    theirs: theirs.tasks,
                    theirsIssues: theirs.issues,
                    mine: mine,
                    workLoading: false,
                    matched: theirs.matched
                ))
            } catch {
                guard let self, !Task.isCancelled else { return }
                self.personPanel.setWork(WorkPersonPanelView.Work(mine: mine, workLoading: false, failed: true))
            }
        }

        personCalendarLoad = Task { [weak self] in
            guard let self else { return }
            do {
                let calendar = Calendar.current
                let start = calendar.startOfDay(for: Date())
                guard let end = calendar.date(byAdding: .day, value: 1, to: start) else { return }
                let people = try await api.calendarFreeBusy(
                    from: start,
                    to: end,
                    emails: [peer.email]
                )
                guard !Task.isCancelled else { return }
                let person = people.first { $0.email.caseInsensitiveCompare(peer.email) == .orderedSame }
                if let person, person.isReadable {
                    self.personPanel.setCalendar(schedule: PeerDaySchedule.today(for: person, now: Date(), calendar: calendar))
                } else {
                    self.personPanel.setCalendar(
                        schedule: [],
                        unavailable: true,
                        note: PeerScheduleNote.unreadable(person?.error ?? "")
                    )
                }
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                let failure = PeerScheduleNote.Failure.classify(error)
                if case .failed(let detail) = failure {
                    // The panel has no Copy; the log carries what Copy would.
                    Self.peerCalendarLog.error("free/busy failed: \(detail, privacy: .public)")
                }
                self.personPanel.setCalendar(
                    schedule: [],
                    unavailable: true,
                    note: PeerScheduleNote.message(for: failure)
                )
            }
        }
    }

    private func openPersonTask(_ summary: CrmMyTask) {
        loadTask?.cancel()
        loadTask = Task { [weak self] in
            guard let self else { return }
            do {
                async let taskRead = api.crmTask(id: summary.id)
                async let teamRead = api.crmTeam()
                let (task, team) = try await (taskRead, teamRead)
                guard !Task.isCancelled else { return }
                taskTeam = team
                taskGoals = if let projectID = task.projectID {
                    (try? await api.crmGoals(projectID: projectID, includeClosed: true)) ?? []
                } else {
                    []
                }
                subjectProjectID = task.projectID
                show(.task(
                    task,
                    canFile: task.projectID != nil && task.githubIssueNumber == nil,
                    subject: summary.subject
                ))
            } catch {
                guard !Task.isCancelled else { return }
                let alert = NSAlert()
                alert.messageText = String(localized: "Couldn’t open that task")
                alert.informativeText = (error as? StarlingsError)?.message ?? error.localizedDescription
                alert.alertStyle = .warning
                alert.addButton(withTitle: String(localized: "OK"))
                if let window = view.window { await alert.beginSheetModal(for: window) } else { alert.runModal() }
            }
        }
    }

    /// Wiring for the person panel, set once by the window.
    /// The same person, as the next roster poll describes them. Redraws the
    /// panel in place and leaves the Core and calendar reads alone — the
    /// poll is what carries an agent's activity and a colleague's status, and
    /// neither is a reason to ask Core again. Ignored when the panel is not
    /// showing that person.
    func updatePerson(_ peer: Peer) {
        guard !personPanel.isHidden else { return }
        personPanel.update(peer)
    }

    var onOpenSharedSubject: ((String) -> Void)? {
        get { personPanel.onOpenSubject }
        set { personPanel.onOpenSubject = newValue }
    }

    /// A task written elsewhere. Redrawn only when it is the one on screen.
    func refresh(task: CrmTask, canFile: Bool, subject: CrmSubject? = nil) {
        guard case .task(let shown, _, let known) = item, shown.id == task.id else { return }
        if partialTaskID == task.id { partialTaskID = nil }
        show(.task(task, canFile: canFile, subject: subject ?? known))
    }

    /// The issue on screen, if there is one.
    var shownIssueID: String? {
        if case .issue(let issue) = item { return issue.id }
        return nil
    }

    private func clearContent() {
        taskTitleEditorField = nil
        taskNotesEditorField = nil
        taskResponsibleField = nil
        taskStatusField = nil
        taskAssigneeField = nil
        taskGoalField = nil
        taskAssigneeID = nil
        taskGoalID = nil
        taskDuePicker = nil
        taskDueToggle = nil
        taskSaveButton = nil
        quickNotePanel = nil
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        emptyLabel.isHidden = item != nil
    }

    @objc private func returnToContextPressed() {
        onReturnToContext?()
    }

    private func setReturnContextLabel(_ label: String) {
        returnContextButton.toolTip = label
        returnContextButton.setAccessibilityLabel(label)
        returnContextButton.image = NSImage(systemSymbolName: "arrow.left", accessibilityDescription: label)
    }

    // MARK: - Issue

    private func buildInteraction(_ interaction: CrmInteraction) {
        add(header(title: interaction.displayTitle, subtitle: interaction.metadataLabel))

        // Edit and Delete: the same sheet that logs one; Delete
        // asks first, as a task's does.
        let edit = NSButton(title: String(localized: "Edit"), target: self, action: #selector(editInteractionPressed))
        SettingsChrome.applySecondaryButton(edit, title: String(localized: "Edit"), height: 28)
        let delete = NSButton(title: TaskDeleteCopy.confirm, target: self, action: #selector(deleteInteractionPressed))
        SettingsChrome.applySecondaryButton(delete, symbolName: "trash", height: 28)
        SettingsChrome.setSecondaryButtonTitle(delete, TaskDeleteCopy.confirm, color: StarlingsColors.danger)
        add(actionRow([edit, delete]))
        statusLabel.clear()
        add(statusLabel)

        let reader = WorkInteractionReadingView()
        reader.show(interaction)
        add(reader, flexible: true)

        if URL(string: interaction.url ?? "") != nil {
            let open = NSButton(title: String(localized: "Open source"), target: self, action: #selector(openInteractionSource))
            SettingsChrome.applySecondaryButton(open, title: String(localized: "Open source"), height: 28)
            add(open)
        }
    }

    @objc private func editInteractionPressed() {
        guard case .interaction(let interaction) = item else { return }
        WorkInteractionEditor.present(
            over: view.window,
            api: api,
            draft: CrmInteractionDraft(editing: interaction)
        ) { [weak self] saved in
            guard let self, case .interaction(let shown) = item, shown.id == saved.id else { return }
            show(.interaction(saved))
            onInteractionChanged?(saved)
        }
    }

    @objc private func deleteInteractionPressed() {
        guard case .interaction(let interaction) = item else { return }
        TaskDeleteAlert.ask(title: interaction.displayTitle, over: view.window) { [weak self] in
            self?.deleteInteraction(interaction)
        }
    }

    private func deleteInteraction(_ interaction: CrmInteraction) {
        statusLabel.clear()
        Task { [weak self] in
            guard let self else { return }
            do {
                try await api.deleteInteraction(id: interaction.id)
                onInteractionDeleted?(interaction.id)
                guard case .interaction(let shown) = item, shown.id == interaction.id else { return }
                onDismiss?()
            } catch {
                guard case .interaction(let shown) = item, shown.id == interaction.id else { return }
                statusLabel.showError(error)
            }
        }
    }

    private func buildIssue(_ issue: CrmIssue) {
        isOpen = issue.isOpen
        shownDetail = nil
        add(header(title: issue.title, subtitle: issueMeta(issue)))

        reading.show(issue, status: String(localized: "Loading…"))
        reading.onEditLabels = { [weak self] labels in
            self?.write(comment: nil, state: nil, labels: labels)
        }
        reading.onEditAssignees = { [weak self] assignees in
            self?.write(comment: nil, state: nil, assignees: assignees)
        }
        reading.onEditMilestone = { [weak self] number in
            self?.write(comment: nil, state: nil, milestone: Patch(number))
        }
        add(reading, flexible: true)
        loadFacets(for: issue)

        // Send sits inside the field, on its right edge.
        let commentButton = StarlingsFieldButton.make(symbol: "arrow.up", label: String(localized: "Comment"))
        commentButton.target = self
        commentButton.action = #selector(commentPressed)
        commentField.stringValue = ""
        StarlingsFieldButton.seat(commentButton, in: commentField)
        add(commentField)

        add(statusLabel)

        stateButton = NSButton(title: "", target: self, action: #selector(statePressed))
        SettingsChrome.applySecondaryButton(stateButton, title: stateButtonTitle, height: 28)
        // Closing something decided against is a different act from finishing
        // it, and GitHub keeps the two apart. So does this — behind the same
        // button rather than beside it, because the ordinary close is the one
        // somebody reaches for.
        let reasonButton = NSButton(
            image: NSImage(systemSymbolName: "chevron.down", accessibilityDescription: String(localized: "Close with a reason"))
                ?? NSImage(),
            target: self,
            action: #selector(closeReasonPressed)
        )
        reasonButton.bezelStyle = .inline
        reasonButton.isBordered = false
        reasonButton.imagePosition = .imageOnly
        reasonButton.contentTintColor = StarlingsColors.secondaryText
        reasonButton.toolTip = String(localized: "Close as not planned")
        SettingsChrome.applyQuietButton(reasonButton)
        reasonButton.isHidden = !isOpen
        closeReasonButton = reasonButton
        let edit = NSButton(title: "", target: self, action: #selector(editIssuePressed))
        SettingsChrome.applySecondaryButton(edit, title: String(localized: "Edit…"), height: 28)
        let openInBrowser = NSButton(title: String(localized: "Open in GitHub"), target: self, action: #selector(openInGitHub))
        SettingsChrome.applySecondaryButton(openInBrowser, title: String(localized: "Open in GitHub"), height: 28)
        add(actionRow([stateButton, reasonButton, edit, openInBrowser]))

        statusLabel.clear()
        loadTask = Task { [weak self] in
            guard let self else { return }
            do {
                let detail = try await api.crmIssue(owner: issue.owner, repo: issue.repo, number: issue.number)
                guard !Task.isCancelled else { return }
                render(detail)
            } catch {
                guard !Task.isCancelled else { return }
                // The list already knew the title, the labels and the state.
                // Losing the body is no reason to show none of that.
                reading.show(issue, status: (error as? StarlingsError)?.message ?? String(localized: "Couldn’t load that issue"), failed: true)
            }
        }
    }

    /// The subtitle over the reading view. Deliberately short: the rail inside
    /// the view carries the labels, the assignees and the milestone in full,
    /// and saying them twice makes a header into a wall.
    private func issueMeta(_ issue: CrmIssue) -> String {
        var parts = ["\(issue.owner)/\(issue.repo) \(issue.shortReference)", issue.stateSummary]
        if let type = issue.issueType { parts.append(type) }
        return parts.joined(separator: " · ")
    }

    private var stateButtonTitle: String { isOpen ? String(localized: "Close issue") : String(localized: "Reopen issue") }

    private func render(_ detail: CrmIssueDetail) {
        isOpen = detail.issue.isOpen
        SettingsChrome.setSecondaryButtonTitle(stateButton, stateButtonTitle, symbol: false)
        closeReasonButton?.isHidden = !isOpen
        statusLabel.clear()
        if let header = stack.arrangedSubviews.first as? NSStackView,
           let title = header.arrangedSubviews.first as? NSTextField,
           let subtitle = header.arrangedSubviews.last as? NSTextField {
            // A title renamed on GitHub since the list loaded is the one to
            // show; the row behind this catches up on the next read.
            title.stringValue = detail.issue.title
            subtitle.stringValue = issueMeta(detail.issue)
        }
        shownDetail = detail
        reading.render(detail)
    }

    @objc private func commentPressed() {
        let text = commentField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        commentField.stringValue = ""
        write(comment: text, state: nil)
    }

    @objc private func statePressed() {
        write(comment: nil, state: isOpen ? "closed" : "open")
    }

    /// The title and the body, in the column rather than in a browser tab.
    ///
    /// Editing turns the reading view into the draft fields it already owns,
    /// so there is no third layout and no sheet over the list.
    @objc private func editIssuePressed() {
        guard case .issue(let issue) = item else { return }
        let detail = shownDetail
        let sheet = NSAlert()
        sheet.messageText = String(localized: "Edit \(issue.shortReference)")
        sheet.informativeText = String(localized: "The change is written to GitHub in your name.")
        sheet.addButton(withTitle: String(localized: "Save"))
        sheet.addButton(withTitle: String(localized: "Cancel"))

        let title = StarlingsTextField(placeholder: String(localized: "Title"))
        title.stringValue = detail?.issue.title ?? issue.title
        let body = NSTextView()
        let scroll = makeTextScroll(body, editable: true, bezel: true)
        body.string = detail?.body ?? ""
        let form = NSStackView(views: [title, scroll])
        form.orientation = .vertical
        form.alignment = .leading
        form.spacing = 8
        form.frame = NSRect(x: 0, y: 0, width: 420, height: 240)
        title.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
        scroll.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
        sheet.accessoryView = form

        guard let window = view.window else { return }
        sheet.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            let wantedTitle = title.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !wantedTitle.isEmpty else { return }
            // Only what actually changed travels: an untouched body should not
            // be rewritten, because a rewrite re-stamps its attribution line.
            self?.write(
                comment: nil,
                state: nil,
                title: wantedTitle == (detail?.issue.title ?? issue.title) ? nil : wantedTitle,
                body: body.string == (detail?.body ?? "") ? nil : body.string
            )
        }
    }

    @objc private func closeReasonPressed(_ sender: NSButton) {
        let menu = NSMenu()
        let item = NSMenuItem(
            title: String(localized: "Close as not planned"),
            action: #selector(closeNotPlannedPressed),
            keyEquivalent: ""
        )
        item.target = self
        menu.addItem(item)
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 2), in: sender)
    }

    @objc private func closeNotPlannedPressed() {
        write(comment: nil, state: "closed", stateReason: "not_planned")
    }

    /// What this repository will accept, asked once and remembered for the
    /// life of the column. Opening issue after issue in one repository costs
    /// one call, and a failure simply leaves the rail read-only.
    private func loadFacets(for issue: CrmIssue) {
        let key = "\(issue.owner)/\(issue.repo)"
        if let known = facetsByRepo[key] {
            reading.facets = known
            return
        }
        Task { [weak self] in
            guard let self else { return }
            guard let found = try? await api.crmIssueFacets(owner: issue.owner, repo: issue.repo) else { return }
            facetsByRepo[key] = found
            // Still the same repository on screen? A slow read must not hand
            // one repository's labels to another's issue.
            guard case .issue(let current) = item, "\(current.owner)/\(current.repo)" == key else { return }
            reading.facets = found
            // The rail was drawn read-only; redraw it now that it can be used.
            if let detail = shownDetail { reading.render(detail) } else { reading.show(current, status: nil) }
        }
    }

    private func write(
        comment: String?,
        state: String?,
        title: String? = nil,
        body: String? = nil,
        stateReason: String? = nil,
        labels: [String]? = nil,
        assignees: [String]? = nil,
        milestone: Patch<Int> = .omit
    ) {
        guard case .issue(let issue) = item else { return }
        statusLabel.setText(String(localized: "Saving…"))
        Task { [weak self] in
            guard let self else { return }
            do {
                let detail = try await api.updateCrmIssue(CrmIssueUpdate(
                    owner: issue.owner,
                    repo: issue.repo,
                    number: issue.number,
                    projectID: subjectProjectID,
                    title: title,
                    body: body,
                    state: state,
                    stateReason: stateReason,
                    labels: labels,
                    assignees: assignees,
                    milestone: milestone,
                    comment: comment
                ))
                // Still the issue that was asked about? A slow write must not
                // paint over whatever was chosen since.
                guard shownIssueID == issue.id else { return }
                render(detail)
                onIssueChanged?()
            } catch {
                statusLabel.showError((error as? StarlingsError)?.message ?? String(localized: "Couldn’t update that issue"))
            }
        }
    }

    @objc private func openInGitHub() {
        guard case .issue(let issue) = item, let url = URL(string: issue.url) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func openInteractionSource() {
        guard case .interaction(let interaction) = item,
              let raw = interaction.url,
              let url = URL(string: raw)
        else { return }
        NSWorkspace.shared.open(url)
    }

    // MARK: - Task

    private func buildTask(_ task: CrmTask, canFile: Bool, subject: CrmSubject?) {
        var subtitle = [task.status.menuTitle]
        if let subject { subtitle.append(subject.title) }
        add(header(title: String(localized: "Edit task"), subtitle: subtitle.joined(separator: " · ")))

        // Where the task lives: always said, once, here. Named and openable
        // when the subject is in hand; the kind alone when it is not.
        let (whereText, whereSubject) = taskWhere(task, subject: subject)
        add(metaBlock([metaRow(String(localized: "Where"), whereText, opens: whereSubject)]))

        let title = StarlingsTextField(placeholder: String(localized: "What needs doing"))
        title.stringValue = task.title
        taskTitleEditorField = title
        add(taskField(caption: String(localized: "Title"), control: title))

        let notes = NSTextView()
        notes.string = task.notes ?? ""
        notes.allowsUndo = true
        taskNotesEditorField = notes
        let notesScroll = makeTextScroll(notes, editable: true, bezel: true, font: StarlingsTextField.fieldFont)
        notesScroll.heightAnchor.constraint(equalToConstant: 84).isActive = true
        add(taskField(caption: String(localized: "Notes (optional)"), control: notesScroll))

        let responsible = StarlingsPopUpField(frame: .zero)
        configureTaskChoice(
            responsible,
            choices: CrmTaskResponsible.allCases.map { ($0.title, $0.rawValue) },
            selecting: task.responsibleParty.rawValue
        )
        responsible.popup.target = self
        responsible.popup.action = #selector(taskResponsibleChanged)
        taskResponsibleField = responsible
        add(taskField(caption: String(localized: "Responsible"), control: responsible))

        let status = StarlingsPopUpField(frame: .zero)
        configureTaskChoice(
            status,
            choices: CrmTaskStatus.editable.map { ($0.menuTitle, $0.rawValue) },
            selecting: task.status.rawValue
        )
        taskStatusField = status
        add(taskField(caption: String(localized: "Status"), control: status))

        let assignee = StarlingsSearchablePickerField(frame: .zero)
        taskAssigneeID = task.assigneeID
        assignee.setOptions(
            [StarlingsSearchablePickerOption(id: "", title: String(localized: "Nobody yet"))]
                + taskTeam.map { StarlingsSearchablePickerOption(id: $0.id, title: $0.name) },
            placeholder: String(localized: "Nobody yet"),
            selectedID: task.assigneeID ?? ""
        )
        assignee.onSelection = { [weak self] id in self?.taskAssigneeID = id.isEmpty ? nil : id }
        taskAssigneeField = assignee
        let assigneeGroup = taskField(caption: String(localized: "Assignee"), control: assignee)
        assigneeGroup.isHidden = task.responsibleParty != .team || taskTeam.isEmpty
        taskAssigneeGroup = assigneeGroup
        add(assigneeGroup)

        // Where the work points: the project's live goals, plus
        // the one this task already serves if it has closed.
        let isPartial = partialTaskID == task.id
        if isPartial {
            responsible.popup.isEnabled = false
            status.popup.isEnabled = false
        }
        let goals = task.projectID != nil && task.projectID == subjectProjectID
            ? taskGoals.filter { GoalsDecisions.isLive($0) || $0.id == task.goalID }
            : []
        if !goals.isEmpty {
            let goal = StarlingsSearchablePickerField(frame: .zero)
            taskGoalID = task.goalID
            goal.setOptions(
                [StarlingsSearchablePickerOption(id: "", title: String(localized: "None"))]
                    + goals.map { StarlingsSearchablePickerOption(id: $0.id, title: $0.title) },
                placeholder: String(localized: "None"),
                selectedID: task.goalID ?? ""
            )
            goal.onSelection = { [weak self] id in self?.taskGoalID = id.isEmpty ? nil : id }
            taskGoalField = goal
            add(taskField(caption: String(localized: "Goal"), control: goal))
        }

        let duePicker = StarlingsDatePickerField(frame: .zero)
        duePicker.picker.datePickerElements = [.yearMonthDay]
        duePicker.picker.dateValue = CrmTaskDate.date(task.dueDate) ?? Date()
        duePicker.isHidden = task.dueDate == nil
        taskDuePicker = duePicker
        let dueToggle = NSButton(checkboxWithTitle: "Has a due date", target: self, action: #selector(taskDueToggled))
        dueToggle.state = task.dueDate == nil ? .off : .on
        dueToggle.attributedTitle = NSAttributedString(string: "Has a due date", attributes: [
            .font: NSFont.systemFont(ofSize: StarlingsTypography.scaled(13)),
            .foregroundColor: StarlingsColors.primaryText,
        ])
        dueToggle.applyMeetCheckboxStyle()
        taskDueToggle = dueToggle
        let dueRow = NSStackView(views: [dueToggle, duePicker])
        dueRow.orientation = .horizontal
        dueRow.alignment = .centerY
        dueRow.spacing = 10
        duePicker.widthAnchor.constraint(equalToConstant: 150).isActive = true
        add(dueRow)

        add(statusLabel)

        let close = NSButton(title: "", target: self, action: #selector(closeTaskEditorPressed))
        SettingsChrome.applySecondaryButton(close, title: String(localized: "Close"), height: 28)
        let save = StarlingsFilledButton(style: .accent, title: String(localized: "Save"))
        // The row it sits in is 28 tall; the convenience init's 44/14 made this
        // one button stand a head above the Close beside it.
        save.apply(.accent, title: String(localized: "Save"), font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold), height: 28)
        save.target = self
        save.action = #selector(saveTaskPressed)
        save.keyEquivalent = "\r"
        taskSaveButton = save
        save.isEnabled = !isPartial
        var buttons = [close, save]
        if canFile {
            let file = NSButton(title: "", target: self, action: #selector(promotePressed))
            SettingsChrome.applySecondaryButton(file, title: String(localized: "File on GitHub"), height: 28)
            buttons.insert(file, at: 0)
        }
        if isPartial {
            let retry = NSButton(title: "", target: self, action: #selector(retryFullTaskPressed))
            SettingsChrome.applySecondaryButton(retry, title: String(localized: "Retry"), height: 28)
            retry.isHidden = true
            taskRetryButton = retry
            buttons.insert(retry, at: 0)
        }
        // Move to…: the task onto another project or lead.
        let move = NSButton(title: "", target: self, action: #selector(movePressed))
        SettingsChrome.applySecondaryButton(move, title: String(localized: "Move to…"), height: 28)
        buttons.insert(move, at: 0)
        add(actionRow(buttons))
        // Delete: asks first, as the contact page does.
        let delete = NSButton(title: TaskDeleteCopy.confirm, target: self, action: #selector(deleteTaskPressed))
        SettingsChrome.applySecondaryButton(delete, symbolName: "trash", height: 28)
        SettingsChrome.setSecondaryButtonTitle(delete, TaskDeleteCopy.confirm, color: StarlingsColors.danger)
        delete.isEnabled = !isPartial
        add(actionRow([delete]))
        addTaskActivity(task)
        view.window?.makeFirstResponder(title)
    }

    // MARK: - Activity

    /// Everything said about the task in the threads this member can read:
    /// the hand-off, the agent's steps and answers, its questions, the event
    /// lines. A question answered here is answered everywhere.
    private func addTaskActivity(_ task: CrmTask) {
        let heading = NSTextField(labelWithString: String(localized: "ACTIVITY"))
        heading.font = StarlingsTypography.sectionLabelFont
        heading.textColor = StarlingsColors.secondaryText
        add(heading)
        taskActivity.orientation = .vertical
        taskActivity.alignment = .leading
        taskActivity.spacing = 10
        add(taskActivity)
        taskActivityLines = []
        taskActivitySelections = [:]
        taskActivitySubmitting = []
        taskActivityErrors = [:]
        renderTaskActivity(loading: true, error: nil)
        taskActivityLoad?.cancel()
        let id = task.id
        taskActivityLoad = Task { [weak self] in
            guard let self else { return }
            do {
                let lines = try await api.cardLines(kind: "task", id: id)
                guard !Task.isCancelled, case .task(let shown, _, _) = item, shown.id == id else { return }
                taskActivityLines = lines
                renderTaskActivity(loading: false, error: nil)
            } catch {
                guard !Task.isCancelled else { return }
                renderTaskActivity(loading: false, error: (error as? StarlingsError)?.message ?? error.localizedDescription)
            }
        }
    }

    private func renderTaskActivity(loading: Bool, error: String?) {
        taskActivity.arrangedSubviews.forEach { $0.removeFromSuperview() }
        func place(_ view: NSView) {
            view.translatesAutoresizingMaskIntoConstraints = false
            taskActivity.addArrangedSubview(view)
            view.widthAnchor.constraint(equalTo: taskActivity.widthAnchor).isActive = true
        }
        if let error {
            let notice = StarlingsNoticeView()
            notice.showError(error)
            place(notice)
            return
        }
        if loading {
            place(quietLine(String(localized: "Loading activity…")))
            return
        }
        let answers = Dictionary(
            taskActivityLines.compactMap { line in line.questionAnswer.map { ($0.questionMessageID, line) } },
            uniquingKeysWith: { _, latest in latest }
        )
        let shown = taskActivityLines.filter { $0.questionAnswer == nil }
        if shown.isEmpty {
            place(quietLine(String(localized: "Nothing said about this yet.")))
            return
        }
        for line in shown {
            let head = NSTextField(labelWithString: "\(line.senderName ?? line.senderEmail) · \(line.sentAt.meetDateTimeString(dateStyle: .abbreviated))")
            head.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .medium)
            head.textColor = StarlingsColors.secondaryText
            place(head)
            let body = StarlingsTypography.wrappingLabel(line.isWithdrawn ? String(localized: "Withdrawn.") : line.text)
            body.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
            body.textColor = line.isEvent ? StarlingsColors.secondaryText : StarlingsColors.primaryText
            body.isSelectable = true
            place(body)
            if let question = line.question, !line.isWithdrawn {
                let id = line.id
                let card = ThreadInteractiveQuestionView(
                    question: question,
                    askedBy: line.senderName ?? line.senderEmail,
                    answer: answers[id],
                    selectedOptionIDs: taskActivitySelections[id] ?? [],
                    isSubmitting: taskActivitySubmitting.contains(id),
                    error: taskActivityErrors[id],
                    onSelection: { [weak self] option, checked in self?.selectActivityOption(line, option: option, checked: checked) },
                    onSubmit: { [weak self] in self?.submitActivityAnswer(line) }
                )
                place(card)
            }
        }
    }

    private func quietLine(_ text: String) -> NSTextField {
        let label = StarlingsTypography.wrappingLabel(text)
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        label.textColor = StarlingsColors.secondaryText
        return label
    }

    private func selectActivityOption(_ line: ThreadMessage, option: String, checked: Bool) {
        guard let question = line.question else { return }
        if question.mode == .single {
            taskActivitySelections[line.id] = [option]
            submitActivityAnswer(line)
            return
        }
        var chosen = taskActivitySelections[line.id] ?? []
        if checked { chosen.insert(option) } else { chosen.remove(option) }
        taskActivitySelections[line.id] = chosen
        renderTaskActivity(loading: false, error: nil)
    }

    private func submitActivityAnswer(_ line: ThreadMessage) {
        let chosen = Array(taskActivitySelections[line.id] ?? [])
        guard !chosen.isEmpty, !taskActivitySubmitting.contains(line.id) else { return }
        taskActivitySubmitting.insert(line.id)
        taskActivityErrors[line.id] = nil
        renderTaskActivity(loading: false, error: nil)
        Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await api.answerQuestion(threadID: line.threadID, messageID: line.id, optionIDs: chosen)
                taskActivityLines.append(result.message)
                taskActivitySelections[line.id] = nil
            } catch {
                taskActivityErrors[line.id] = (error as? StarlingsError)?.message ?? error.localizedDescription
            }
            taskActivitySubmitting.remove(line.id)
            renderTaskActivity(loading: false, error: nil)
        }
    }

    /// "Partner · Echos", "Project · X", … and the subject to open on click.
    /// The kind comes from the task itself (a project, lead or event outranks
    /// the organization Core echoes as context); the name and the door come
    /// from `subject` only when it is that same record.
    private func taskWhere(_ task: CrmTask, subject: CrmSubject?) -> (String, CrmSubject?) {
        var kind = ""
        var subjectID: String?
        var subjectKind: String?
        if let id = task.projectID {
            (kind, subjectID, subjectKind) = (String(localized: "Project"), id, "project")
        } else if let id = task.leadID {
            (kind, subjectID, subjectKind) = (String(localized: "Lead"), id, "lead")
        } else if let id = task.eventID {
            (kind, subjectID, subjectKind) = (String(localized: "Event"), id, "event")
        } else if let id = task.partnerOrganizationID {
            (kind, subjectID, subjectKind) = (String(localized: "Partner"), id, "organization")
        } else if task.meetingID != nil {
            return (String(localized: "Meeting"), nil)
        } else {
            return (String(localized: "No subject"), nil)
        }
        if let subject, subject.id == subjectID, subject.kind == subjectKind {
            return ("\(kind) · \(subject.title)", subject)
        }
        return (kind, nil)
    }

    private func taskField(caption: String, control: NSView) -> NSView {
        let group = NSStackView(views: [StarlingsTypography.fieldCaption(caption), control])
        group.orientation = .vertical
        group.alignment = .leading
        group.spacing = 5
        control.setContentHuggingPriority(.defaultLow, for: .horizontal)
        control.widthAnchor.constraint(equalTo: group.widthAnchor).isActive = true
        return group
    }

    private func configureTaskChoice(
        _ field: StarlingsPopUpField,
        choices: [(String, String?)],
        selecting: String?
    ) {
        field.popup.removeAllItems()
        for (title, value) in choices {
            field.popup.addItem(withTitle: title)
            field.popup.lastItem?.representedObject = value
        }
        let index = choices.firstIndex { $0.1 == selecting } ?? 0
        field.popup.selectItem(at: index)
    }

    @objc private func taskResponsibleChanged() {
        let raw = taskResponsibleField?.popup.selectedItem?.representedObject as? String
        let isTeam = CrmTaskResponsible(rawValue: raw ?? "") == .team
        taskAssigneeGroup?.isHidden = !isTeam || taskTeam.isEmpty
    }

    @objc private func taskDueToggled() {
        taskDuePicker?.isHidden = taskDueToggle?.state != .on
    }

    @objc private func closeTaskEditorPressed() {
        onDismiss?()
    }

    @objc private func saveTaskPressed() {
        guard case .task(let task, let canFile, let subject) = item,
              let titleField = taskTitleEditorField,
              let notesField = taskNotesEditorField,
              let responsibleField = taskResponsibleField,
              let statusField = taskStatusField,
              let dueToggle = taskDueToggle
        else { return }

        let title = titleField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else {
            view.window?.makeFirstResponder(titleField)
            return
        }
        let responsible = CrmTaskResponsible(
            rawValue: responsibleField.popup.selectedItem?.representedObject as? String ?? ""
        ) ?? .unassigned
        let status = CrmTaskStatus(
            rawValue: statusField.popup.selectedItem?.representedObject as? String ?? ""
        ) ?? .pending
        let assignedTo = responsible == .team
            ? taskAssigneeID
            : nil
        let dueDate = dueToggle.state == .on ? taskDuePicker?.picker.dateValue : nil
        // No Goal menu means the row was not offered; leave the goal alone.
        let goalID: Patch<String> = taskGoalField.map { _ in Patch(taskGoalID) } ?? .omit

        statusLabel.setText(String(localized: "Saving…"))
        taskSaveButton?.isEnabled = false
        taskWrite?.cancel()
        taskWrite = Task { [weak self] in
            guard let self else { return }
            do {
                let updated = try await api.updateCrmTask(
                    id: task.id,
                    update: CrmTaskUpdate(
                        title: title,
                        notes: notesField.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            ? nil
                            : notesField.string.trimmingCharacters(in: .whitespacesAndNewlines),
                        status: status.rawValue,
                        responsibleParty: responsible.rawValue,
                        assignedTo: Patch(assignedTo),
                        dueDate: Patch(dueDate.map(CrmTaskDate.wire)),
                        goalID: goalID
                    )
                )
                guard !Task.isCancelled,
                      case .task(let shown, _, _) = item,
                      shown.id == task.id
                else { return }
                statusLabel.setText(String(localized: "Saved"))
                show(.task(updated, canFile: canFile && updated.githubIssueNumber == nil, subject: subject))
                onTaskChanged?()
            } catch {
                guard !Task.isCancelled else { return }
                taskSaveButton?.isEnabled = true
                statusLabel.showError((error as? StarlingsError)?.message ?? String(localized: "Couldn’t save that task"))
            }
        }
    }

    /// One label/value line. The label column is a fixed width so a run of
    /// them reads as a table rather than as ragged sentences.
    private func metaRow(
        _ label: String,
        _ value: String,
        tint: NSColor? = nil,
        opens subject: CrmSubject? = nil
    ) -> NSView {
        let name = NSTextField(labelWithString: label)
        name.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        name.textColor = StarlingsColors.secondaryText
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        name.translatesAutoresizingMaskIntoConstraints = false
        name.widthAnchor.constraint(equalToConstant: 76).isActive = true
        name.setContentHuggingPriority(.required, for: .horizontal)

        let content: NSView
        if subject != nil {
            let button = NSButton(title: value, target: self, action: #selector(openSubjectPressed))
            button.bezelStyle = .inline
            button.controlSize = .small
            SettingsChrome.applyQuietButton(button)
            button.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
            button.contentTintColor = StarlingsColors.primaryText
            button.alignment = .left
            content = button
        } else {
            let text = NSTextField(wrappingLabelWithString: value)
            text.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
            text.textColor = tint ?? StarlingsColors.primaryText
            text.isSelectable = true
            text.maximumNumberOfLines = 3
            content = text
        }
        content.translatesAutoresizingMaskIntoConstraints = false

        let row = NSStackView(views: [name, content])
        row.orientation = .horizontal
        row.alignment = .firstBaseline
        row.spacing = 8
        return row
    }

    private func metaBlock(_ rows: [NSView]) -> NSStackView {
        let block = NSStackView(views: rows)
        block.orientation = .vertical
        block.alignment = .leading
        block.spacing = 5
        for row in rows {
            row.translatesAutoresizingMaskIntoConstraints = false
            row.widthAnchor.constraint(equalTo: block.widthAnchor).isActive = true
        }
        return block
    }

    private func infoSection(_ title: String, lines: [String]) -> NSStackView {
        let body = NSStackView()
        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = 5
        for line in lines {
            let label = StarlingsTypography.wrappingLabel(line)
            label.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
            label.textColor = StarlingsColors.primaryText
            label.maximumNumberOfLines = 0
            label.translatesAutoresizingMaskIntoConstraints = false
            body.addArrangedSubview(label)
            label.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
        }
        return inspectorSection(key: "info.\(title.lowercased())", title: title, body: body)
    }

    /// The roster and its bound agent each get a foldable group. Rows open
    /// the same DM as the Team surface.
    private func teamSections(_ team: ConversationTeam) -> [NSView] {
        var summary = team.people.count == 1
            ? String(localized: "1 person")
            : String(localized: "\(team.people.count) people")
        summary += " · " + String(localized: "\(team.aroundCount) around")
        if let access = team.access {
            summary += " · " + access
        }
        let summaryLabel = StarlingsTypography.wrappingLabel(summary)
        summaryLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        summaryLabel.textColor = StarlingsColors.secondaryText
        summaryLabel.maximumNumberOfLines = 0
        let people = NSStackView()
        people.orientation = .vertical
        people.alignment = .leading
        people.spacing = 5
        people.addArrangedSubview(summaryLabel)

        let shown = 8
        for member in team.people.prefix(shown) {
            people.addArrangedSubview(teamRow(member, team: team))
        }
        if team.people.count > shown {
            let more = NSTextField(labelWithString: String(localized: "\(team.people.count - shown) more"))
            more.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            more.textColor = StarlingsColors.secondaryText
            people.addArrangedSubview(more)
        }

        let agents = NSStackView()
        agents.orientation = .vertical
        agents.alignment = .leading
        agents.spacing = 5
        if team.agents.isEmpty {
            let none = StarlingsTypography.wrappingLabel(String(localized: "None attached. @mention an agent to bring it in."))
            none.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            none.textColor = StarlingsColors.secondaryText
            none.maximumNumberOfLines = 0
            agents.addArrangedSubview(none)
        } else {
            for member in team.agents {
                agents.addArrangedSubview(teamRow(member, team: team))
            }
        }
        return [
            inspectorSection(key: "team.people", title: String(localized: "TEAM"), body: people),
            inspectorSection(key: "team.agents", title: String(localized: "AGENTS"), body: agents),
        ]
    }

    private func teamRow(_ member: ConversationTeam.Member, team: ConversationTeam) -> NSView {
        // Make responsible: a person on a project or lead who is not the one chosen.
        let chosen = team.responsible?.source == .chosen ? team.responsible?.email : nil
        let canChoose = team.canChooseResponsible && !member.isAgent && member.email.lowercased() != chosen && onMakeResponsible != nil
        let canMessage = !member.isSelf && !(member.isAgent && member.subtitle == String(localized: "Not in the roster"))
        let row = WorkSidebarRowView(
            leading: .avatar(
                StarlingsAvatarIdentity(
                    displayName: member.name,
                    email: member.email,
                    avatarUpdatedAt: member.avatarUpdatedAt,
                    agentAvatar: member.agentAvatar
                ),
                status: member.status
            ),
            title: member.name,
            subtitle: member.subtitle,
            isSubdued: member.isAgent,
            accessibilityLabel: canMessage ? String(localized: "Message \(member.name)") : member.name,
            onSelect: canMessage ? { [weak self] in self?.onOpenPeer?(member.email) } : nil,
            menuProvider: canChoose ? { [weak self] in
                let ids = WorkRowActionRegistry.groups(
                    kind: .person, context: member.isSelf ? WorkPersonMenuContext.selfContext.rawValue : WorkPersonMenuContext.peer.rawValue,
                    client: .mac, facts: WorkRowActionFacts(["canMakeResponsible": true])
                )
                guard ids.flatMap({ $0 }).contains(.makeResponsible) else { return nil }
                let menu = NSMenu()
                let item = NSMenuItem(title: String(localized: "Make responsible"), action: #selector(WorkInspectorViewController.makeResponsiblePressed(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = member.email
                item.image = NSImage(systemSymbolName: MenuSymbol.assign.rawValue, accessibilityDescription: nil)
                menu.addItem(item)
                return menu
            } : nil
        )
        row.toolTip = member.email
        return row
    }

    @objc fileprivate func makeResponsiblePressed(_ sender: NSMenuItem) {
        guard let email = sender.representedObject as? String else { return }
        onMakeResponsible?(email)
    }

    /// The inspector and left rail use the same folding component. Namespaced
    /// keys keep a right-side context fold independent from a left-rail fold.
    private func inspectorSection(key: String, title: String, body: NSView) -> SidebarSection {
        let section = SidebarSection(
            title: title,
            key: "work.inspector.\(key)",
            body: [body]
        )
        // These groups keep their intrinsic height in the full-height
        // inspector stack, leaving the unused space after the last group.
        section.setContentHuggingPriority(.required, for: .vertical)
        return section
    }

    @objc private func openSubjectPressed() {
        guard case .task(_, _, let subject) = item, let subject else { return }
        onOpenSubject?(subject)
    }

    @objc private func movePressed() {
        guard case .task(let task, _, _) = item else { return }
        TaskMoveSheet.present(over: view.window, task: task, api: api) { [weak self] _ in
            // The task left this subject: the window reloads its lists and
            // the inspector, which no longer has a row to show.
            self?.statusLabel.setText(String(localized: "Moved"))
            self?.onTaskChanged?()
        }
    }

    @objc private func promotePressed() {
        guard case .task(let task, _, _) = item else { return }
        statusLabel.setText(String(localized: "Filing…"))
        onPromoteTask?(task)
    }

    /// A write the window made on this task did not land. Said here, where
    /// the button that asked for it is.
    func setTaskError(_ message: String) {
        guard case .task = item else { return }
        statusLabel.showError(message)
        if case .task(let shown, _, _) = item, shown.id == partialTaskID {
            taskRetryButton?.isHidden = false
        }
    }

    @objc private func retryFullTaskPressed() {
        taskRetryButton?.isHidden = true
        statusLabel.setText("")
        onRetryFullTask?()
    }

    // MARK: - New issue

    private func buildDraft(for subject: CrmSubject) {
        // Nobody should be surprised about where this lands, or that their
        // name goes on it.
        add(header(
            title: String(localized: "New issue"),
            subtitle: String(localized: "Filed on \(subject.title)’s primary repository, in your name.")
        ))
        titleField.stringValue = ""
        add(titleField)
        draftText.string = ""
        let scroll = makeTextScroll(draftText, editable: true, bezel: true)
        add(scroll, flexible: true)

        // Filed finished: an issue that arrives bare is one whoever filed it
        // opens GitHub to complete, which is the trip filing here is for.
        draft = CrmIssueDraftExtras()
        draftRow = NSStackView(views: [
            draftChooser(#selector(draftLabelsPressed), "Labels"),
            draftChooser(#selector(draftAssigneesPressed), "Assignees"),
            draftChooser(#selector(draftMilestonePressed), "Milestone"),
        ])
        draftRow?.orientation = .horizontal
        draftRow?.alignment = .centerY
        draftRow?.spacing = 6
        draftRow?.isHidden = true
        if let draftRow { add(draftRow) }
        add(statusLabel)
        loadDraftFacets(for: subject)

        // The one filled control in the column: filing is what a draft is for.
        let file = StarlingsFilledButton(style: .accent, title: String(localized: "File"))
        file.apply(.accent, title: String(localized: "File"), font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold), height: 28)
        file.target = self
        file.action = #selector(filePressed)
        let cancel = NSButton(title: "", target: self, action: #selector(cancelPressed))
        SettingsChrome.applySecondaryButton(cancel, title: String(localized: "Cancel"), height: 28)
        let attach = NSButton(title: "", target: self, action: #selector(attachIssueImagePressed))
        SettingsChrome.applySecondaryButton(attach, title: String(localized: "Attach Image…"), height: 28)
        add(actionRow([attach, cancel, file]))
        view.window?.makeFirstResponder(titleField)
    }

    /// Attach a picture to the issue being drafted.
    ///
    /// GitHub has no public API for putting a file *in* an issue, so Meet keeps
    /// the bytes and the body gets a markdown image link. The address is
    /// readable without a session, because github.com renders an issue body for
    /// whoever is looking at it — see the Worker's `issue-images.ts`.
    ///
    /// Appended to the body rather than inserted at the caret: opening a panel
    /// takes first responder away from the text view, so there is no selection
    /// left to insert into, and guessing where somebody meant it is worse than
    /// putting it somewhere predictable.
    @objc private func attachIssueImagePressed() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = CrmIssueImage.allowedTypes
        panel.prompt = String(localized: "Attach")
        panel.message = "Pick a picture to attach to this issue."
        panel.begin { [weak self] response in
            guard let self, response == .OK, let url = panel.url else { return }
            Task { await self.attachIssueImage(at: url) }
        }
    }

    private func attachIssueImage(at url: URL) async {
        guard let data = try? Data(contentsOf: url) else {
            statusLabel.showError(String(localized: "Couldn’t read that file."))
            return
        }
        guard data.count <= CrmIssueImage.maxBytes else {
            statusLabel.showError(String(localized: "That image is too large — 8 MB is the limit."))
            return
        }
        statusLabel.setText(String(localized: "Attaching…"))
        do {
            let stored = try await api.uploadIssueImage(
                contentType: CrmIssueImage.contentType(for: url),
                data: data
            )
            draftText.string = CrmIssueImage.appending(
                CrmIssueImage.markdown(name: url.lastPathComponent, url: stored.url),
                to: draftText.string
            )
            statusLabel.clear()
        } catch {
            statusLabel.showError((error as? StarlingsError)?.message ?? String(localized: "Couldn’t attach that image"))
        }
    }

    /// What a draft carries beyond its title and body.
    private struct CrmIssueDraftExtras {
        var labels: [String] = []
        var assignees: [String] = []
        var milestone: Int?
    }

    private func draftChooser(_ action: Selector, _ title: String) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        button.controlSize = .small
        button.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        return button
    }

    /// The primary repository decides what a draft can be given, and only the
    /// Worker knows which repository that is — so the row appears once both
    /// answers are in, and stays away where a repository offers nothing.
    private func loadDraftFacets(for subject: CrmSubject) {
        loadTask = Task { [weak self] in
            guard let self else { return }
            guard let repos = try? await api.crmProjectRepos(projectID: subject.id),
                  let primary = repos.first(where: \.isPrimary) ?? repos.first,
                  let found = try? await api.crmIssueFacets(owner: primary.owner, repo: primary.repo)
            else { return }
            guard !Task.isCancelled, case .newIssue = item else { return }
            draftFacets = found
            draftRow?.isHidden = found.isEmpty
            redrawDraftChoosers()
        }
    }

    private func redrawDraftChoosers() {
        guard let row = draftRow else { return }
        let buttons = row.arrangedSubviews.compactMap { $0 as? NSButton }
        guard buttons.count == 3 else { return }
        buttons[0].title = draft.labels.isEmpty ? String(localized: "Labels") : draft.labels.joined(separator: ", ")
        buttons[1].title = draft.assignees.isEmpty ? String(localized: "Assignees") : draft.assignees.joined(separator: ", ")
        buttons[2].title = draftFacets.milestones
            .first { $0.number == draft.milestone }?.title ?? String(localized: "Milestone")
        buttons[0].isHidden = draftFacets.labels.isEmpty
        buttons[1].isHidden = draftFacets.assignees.isEmpty
        buttons[2].isHidden = draftFacets.milestones.isEmpty
    }

    @objc private func draftLabelsPressed(_ sender: NSButton) {
        let menu = NSMenu()
        for label in draftFacets.labels {
            let item = NSMenuItem(title: label.name, action: #selector(draftLabelToggled), keyEquivalent: "")
            item.target = self
            item.state = draft.labels.contains(label.name) ? .on : .off
            item.representedObject = label.name
            if let hue = StarlingsLabelChip.colour(from: label.color) {
                item.image = StarlingsLabelChip.swatch(hue)
            }
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 2), in: sender)
    }

    @objc private func draftLabelToggled(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        if let index = draft.labels.firstIndex(of: name) {
            draft.labels.remove(at: index)
        } else {
            draft.labels.append(name)
        }
        redrawDraftChoosers()
    }

    @objc private func draftAssigneesPressed(_ sender: NSButton) {
        let menu = NSMenu()
        for person in draftFacets.assignees {
            let item = NSMenuItem(title: person.login, action: #selector(draftAssigneeToggled), keyEquivalent: "")
            item.target = self
            item.state = draft.assignees.contains(person.login) ? .on : .off
            item.representedObject = person.login
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 2), in: sender)
    }

    @objc private func draftAssigneeToggled(_ sender: NSMenuItem) {
        guard let login = sender.representedObject as? String else { return }
        if let index = draft.assignees.firstIndex(of: login) {
            draft.assignees.remove(at: index)
        } else {
            draft.assignees.append(login)
        }
        redrawDraftChoosers()
    }

    @objc private func draftMilestonePressed(_ sender: NSButton) {
        let menu = NSMenu()
        let none = NSMenuItem(title: String(localized: "No milestone"), action: #selector(draftMilestoneChosen), keyEquivalent: "")
        none.target = self
        none.state = draft.milestone == nil ? .on : .off
        menu.addItem(none)
        menu.addItem(.separator())
        for milestone in draftFacets.milestones {
            guard let number = milestone.number else { continue }
            let item = NSMenuItem(title: milestone.title, action: #selector(draftMilestoneChosen), keyEquivalent: "")
            item.target = self
            item.state = number == draft.milestone ? .on : .off
            item.representedObject = number
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 2), in: sender)
    }

    @objc private func draftMilestoneChosen(_ sender: NSMenuItem) {
        draft.milestone = sender.representedObject as? Int
        redrawDraftChoosers()
    }

    @objc private func filePressed() {
        guard case .newIssue(let subject) = item else { return }
        let title = titleField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else {
            view.window?.makeFirstResponder(titleField)
            return
        }
        let body = draftText.string.trimmingCharacters(in: .whitespacesAndNewlines)
        statusLabel.setText(String(localized: "Filing…"))
        Task { [weak self] in
            guard let self else { return }
            do {
                let issue = try await api.createCrmIssue(CrmIssueCreate(
                    projectID: subject.id,
                    title: title,
                    body: body.isEmpty ? nil : body,
                    labels: draft.labels.isEmpty ? nil : draft.labels,
                    assignees: draft.assignees.isEmpty ? nil : draft.assignees,
                    milestone: draft.milestone
                ))
                onIssueFiled?(issue)
            } catch {
                statusLabel.showError((error as? StarlingsError)?.message ?? String(localized: "Couldn’t file that issue"))
            }
        }
    }

    @objc private func cancelPressed() {
        onDismiss?()
    }

    // MARK: - Furniture

    private func add(_ view: NSView, flexible: Bool = false) {
        view.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(view)
        view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        // **A row is bounded by the column, never the other way round.** Every
        // row is pinned to the stack's width at required priority, so a row
        // that will not compress — a button pair, a long unbroken word, a
        // person panel that just loaded — makes the pane's width its own and
        // pushes the window out from the inside. That is issue #22 seen from
        // the inspector. A row too wide for 280pt clips.
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        if let row = view as? NSStackView {
            // A stack view holds its arranged subviews apart with its own
            // constraints; content compression on the row itself does not
            // reach them.
            row.setClippingResistancePriority(.defaultLow, for: .horizontal)
            row.setHuggingPriority(.defaultLow, for: .horizontal)
        }
        if flexible {
            // The one thing that takes the height the column has; everything
            // else keeps to its own.
            view.setContentHuggingPriority(.init(1), for: .vertical)
            view.setContentCompressionResistancePriority(.init(1), for: .vertical)
        } else {
            view.setContentHuggingPriority(.required, for: .vertical)
        }
    }

    private func header(title: String, subtitle: String) -> NSStackView {
        let titleLabel = StarlingsTypography.wrappingLabel(title)
        titleLabel.font = NSFont.systemFont(ofSize: StarlingsTypography.scaled(15), weight: .semibold)
        titleLabel.textColor = StarlingsColors.primaryText
        titleLabel.maximumNumberOfLines = 4
        let subtitleLabel = StarlingsTypography.wrappingLabel(subtitle)
        subtitleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        subtitleLabel.textColor = StarlingsColors.secondaryText
        subtitleLabel.maximumNumberOfLines = 3
        let header = NSStackView(views: [titleLabel, subtitleLabel])
        header.orientation = .vertical
        header.alignment = .leading
        header.spacing = 3
        for label in [titleLabel, subtitleLabel] {
            label.translatesAutoresizingMaskIntoConstraints = false
            label.widthAnchor.constraint(equalTo: header.widthAnchor).isActive = true
        }
        return header
    }

    private func actionRow(_ buttons: [NSButton]) -> NSStackView {
        let row = NSStackView(views: buttons)
        row.orientation = .horizontal
        row.spacing = 8
        row.alignment = .centerY
        return row
    }

    /// A text view that fills its scroll view's width and grows downward —
    /// the setup every long text in the app needs and none gets by default.
    private func makeTextScroll(
        _ textView: NSTextView,
        editable: Bool,
        bezel: Bool,
        font: NSFont? = nil
    ) -> NSScrollView {
        let resolvedFont = font ?? .systemFont(ofSize: StarlingsTypography.scaled(12))
        textView.isEditable = editable
        textView.isRichText = false
        textView.drawsBackground = false
        textView.textColor = StarlingsColors.primaryText
        textView.font = resolvedFont
        textView.textContainerInset = NSSize(width: 2, height: 6)
        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        if editable {
            StarlingsTextField.styleFieldEditor(textView, font: resolvedFont)
        }
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.borderType = bezel ? .bezelBorder : .noBorder
        scroll.documentView = textView
        scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 80).isActive = true
        return scroll
    }
}

/// The one question a task delete asks on the Mac: a sheet on
/// the window when it is up, a modal otherwise, with Delete first and red.
@MainActor
enum TaskDeleteAlert {
    static func ask(title: String, over window: NSWindow?, then proceed: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = TaskDeleteCopy.title(title)
        alert.informativeText = TaskDeleteCopy.message
        alert.alertStyle = .warning
        alert.addButton(withTitle: TaskDeleteCopy.confirm)
        alert.addButton(withTitle: TaskDeleteCopy.cancel)
        alert.buttons.first?.hasDestructiveAction = true
        let answer: (NSApplication.ModalResponse) -> Void = { response in
            guard response == .alertFirstButtonReturn else { return }
            proceed()
        }
        if let window, window.isVisible {
            alert.beginSheetModal(for: window, completionHandler: answer)
        } else {
            answer(alert.runModal())
        }
    }
}
