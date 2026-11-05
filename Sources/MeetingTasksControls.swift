import AppKit
import StarlingsContracts

/// Envisioning-only open tasks for the categorized lead/project, plus the
/// tasks this meeting proposed but nobody has accepted yet.
///
/// Suggested rows sit above the real ones and are drawn one step quieter: they
/// are not tasks until the owner says so. See `docs/TASK_SUGGESTIONS.md`.
///
/// Every row marks with a **toggle**, because that is what marking work is
/// during a call: tick a suggestion and it becomes a task, tick a task and it
/// is done, untick either one and it is not. Nothing here opens a sheet — the
/// title still does, for when accepting deserves a read rather than a tick.
final class MeetingTasksControls: NSView {
    var favorites: StarredWatch?
    var onNewTask: (() -> Void)?
    var onEditTask: ((CrmTask) -> Void)?
    /// The shared row menu's intent is handed back to the owning Work window;
    /// this control only knows how to draw it.
    var onTaskAction: ((WorkRowAction) -> Void)?
    /// Who a task row can be handed to. Empty in a call: the
    /// meeting window hands nothing off.
    var agents: [Peer] = []
    /// `true` when the owner just ticked it done, `false` when they took it back.
    var onToggleTaskDone: ((CrmTask, Bool) -> Void)?
    /// A Core-proposed task: `true` accepts it onto the plate as
    /// pending, `false` declines it. Nil hides the buttons (a surface that
    /// cannot write, such as a guest's view).
    var onDecideProposal: ((CrmTask, Bool) -> Void)?
    var onAcceptSuggestion: ((TaskSuggestion) -> Void)?
    var onEditSuggestion: ((TaskSuggestion) -> Void)?
    var onDismissSuggestion: ((TaskSuggestion) -> Void)?

    /// Lives on the rail's TASKS header rather than inside this view — the
    /// section owns the title row so every block in the sidebar folds the same
    /// way. See `SidebarSection`.
    let newTaskButton = NSButton(title: String(localized: "New Task"), target: nil, action: nil)
    private let statusLabel = NSTextField(labelWithString: "")
    private let suggestionHeader = NSTextField(labelWithString: String(localized: "SUGGESTED"))
    private let suggestionNoteLabel = NSTextField(labelWithString: "")
    private let suggestionStack = NSStackView()
    private let listStack = NSStackView()
    private let stack = NSStackView()
    /// Server order, kept so a tick can redraw the list without reordering it.
    private var orderedTasks: [CrmTask] = []
    private var subject: CrmSubject?
    private var subjectTitle: String?
    private var suggestionsByID: [String: TaskSuggestion] = [:]
    /// Ticked here but not reloaded from Core yet. Kept so the row stays on
    /// screen, ticked, for the rest of the call — an untick has to be possible
    /// right after the tick or it is not a toggle.
    private var locallyDoneTaskIDs: Set<String> = []
    /// Suggestions whose accept is in flight, so the row reads as ticked while
    /// Core catches up instead of sitting there looking ignored.
    private var acceptingSuggestionIDs: Set<String> = []
    /// The subject task being read in the adjacent inspector. Selection is
    /// paint-only; the row stays the same height whether it is selected or not.
    private var selectedTaskID: String?
    /// An organization's Tasks By project: what is drawn while
    /// the grouping is on, kept so a tick or a selection redraws the groups.
    private var projectGroups: ProjectGroups?
    /// Where a project's header goes when its Open is pressed.
    var onOpenProject: ((CrmSubject) -> Void)?
    /// A partial By project read, red with Copy.
    private let groupNotice = StarlingsNoticeView(wrapping: true)

    private struct ProjectGroups {
        let organizationID: String
        let projects: [CrmOrganizationProjectTaskGroups.Project]
        let failureLine: String?
    }

    var hasSuggestions: Bool { !suggestionsByID.isEmpty }

    /// The rail is a glance, not a backlog. Past this the answer is Work.
    private static let visibleTaskLimit = 12

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false

        newTaskButton.bezelStyle = .inline
        newTaskButton.controlSize = .small
        SettingsChrome.applyQuietButton(newTaskButton)
        newTaskButton.target = self
        newTaskButton.action = #selector(newTaskPressed)

        statusLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        statusLabel.textColor = StarlingsColors.secondaryText
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        statusLabel.stringValue = String(localized: "Pick a lead or project to see tasks.")

        suggestionHeader.font = StarlingsTypography.sectionLabelFont
        suggestionHeader.textColor = StarlingsColors.secondaryText
        suggestionHeader.isHidden = true

        suggestionNoteLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        suggestionNoteLabel.textColor = StarlingsColors.secondaryText
        suggestionNoteLabel.lineBreakMode = .byTruncatingTail
        suggestionNoteLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        suggestionNoteLabel.isHidden = true

        suggestionStack.orientation = .vertical
        suggestionStack.alignment = .leading
        suggestionStack.spacing = 4

        listStack.orientation = .vertical
        listStack.alignment = .leading
        listStack.spacing = 6

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(suggestionHeader)
        stack.addArrangedSubview(suggestionStack)
        stack.addArrangedSubview(groupNotice)
        stack.addArrangedSubview(listStack)
        stack.addArrangedSubview(suggestionNoteLabel)
        stack.addArrangedSubview(statusLabel)
        addSubview(stack)
        stack.pinToEdges(of: self)
        suggestionStack.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        listStack.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        groupNotice.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        groupNotice.clear()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    /// Rows are built while the meeting runs, long after the window resolved
    /// its own appearance, so a CGColor set at creation is the one that goes
    /// stale. Re-resolve the whole subtree when the window flips.
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        StarlingsColors.refreshLayers(in: self, toDark: StarlingsColors.isDark(effectiveAppearance))
    }

    func setUnavailable(_ message: String) {
        clearRows()
        newTaskButton.isEnabled = false
        statusLabel.stringValue = message
        statusLabel.textColor = StarlingsColors.secondaryText
    }

    /// The refresh failed but the rows on screen are the last good list
    /// (docs/CACHING.md): keep them, say so in red, leave New enabled.
    func setRefreshFailed(_ message: String) {
        // With no last good list, the rows on screen are placeholders.
        if orderedTasks.isEmpty { clearRows() }
        statusLabel.stringValue = message
        statusLabel.textColor = StarlingsColors.danger
    }

    func setSelectedTaskID(_ id: String?) {
        guard selectedTaskID != id else { return }
        selectedTaskID = id
        if let projectGroups { drawProjectGroups(projectGroups) } else { setTasks(orderedTasks, subject: subject) }
    }

    func setLoading() {
        clearRows()
        newTaskButton.isEnabled = false
        statusLabel.stringValue = ""
        for row in StarlingsPlaceholderRowView.rows() {
            listStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: listStack.widthAnchor).isActive = true
        }
    }

    func setTasks(_ tasks: [CrmTask], subject: CrmSubject?) {
        setTasks(tasks, subject: subject, subjectTitle: subject?.title)
    }

    /// The live meeting knows the filed subject's title but does not carry the
    /// full Work subject record. Its rows keep the shared menu; the doors that
    /// need the record (Open in Core) drop out.
    func setTasks(_ tasks: [CrmTask], subjectTitle: String?) {
        setTasks(tasks, subject: nil, subjectTitle: subjectTitle)
    }

    private func setTasks(_ tasks: [CrmTask], subject: CrmSubject?, subjectTitle: String?) {
        projectGroups = nil
        groupNotice.clear()
        clearRows()
        newTaskButton.isEnabled = true
        statusLabel.textColor = StarlingsColors.secondaryText
        self.subject = subject
        self.subjectTitle = subjectTitle
        orderedTasks = tasks
        if tasks.isEmpty {
            statusLabel.stringValue = subjectTitle.map { "No open tasks for \($0)." } ?? String(localized: "No open tasks.")
            return
        }
        // Proposals first, apart from the open list: they are questions Core
        // is asking, not work anybody committed to, and they should be
        // answered before the list below is read as the whole plate.
        let proposed = tasks.filter(\.status.isProposed)
        for task in proposed {
            let row = proposedRow(task, subject: subject)
            listStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: listStack.widthAnchor).isActive = true
        }
        let committed = tasks.filter { !$0.status.isProposed }
        // A list that stops at twelve and says nothing reads as all of them.
        let shown = committed.prefix(Self.visibleTaskLimit)
        statusLabel.stringValue = [
            proposed.isEmpty ? nil : "\(proposed.count) proposed",
            committed.count > shown.count ? String(localized: "\(shown.count) of \(committed.count) open") : String(localized: "\(committed.count) open"),
        ].compactMap { $0 }.joined(separator: " · ")
        for task in shown {
            let row = taskRow(task, subject: subject)
            listStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: listStack.widthAnchor).isActive = true
        }
    }

    private func proposedRow(_ task: CrmTask, subject: CrmSubject?) -> NSView {
        MeetingProposedTaskRowView(
            task: task,
            favorites: favorites,
            onAccept: { [weak self] task in self?.onDecideProposal?(task, true) },
            onDecline: { [weak self] task in self?.onDecideProposal?(task, false) },
            onEdit: { [weak self] task in self?.onEditTask?(task) },
            menuActions: task.proposedRowActions(subject: subject),
            onMenuAction: { [weak self] action in self?.onTaskAction?(action) }
        )
    }

    private func taskRow(_ task: CrmTask, subject: CrmSubject?) -> NSView {
        MeetingTaskRowView(
            task: task,
            favorites: favorites,
            isDone: isDone(task),
            isSelected: task.id == selectedTaskID,
            onToggleDone: { [weak self] task, done in
                self?.toggleTaskDone(task, done: done)
            },
            onEdit: { [weak self] task in
                self?.onEditTask?(task)
            },
            menuActions: task.rowActions(subject: subject, agents: agents),
            onMenuAction: { [weak self] action in self?.onTaskAction?(action) }
        )
    }

    /// An organization's Tasks By project: one folding section
    /// per project, its fold remembered, with the same rows and menus as the
    /// flat list. The project is each row's subject, so its doors are the
    /// project's. `projects` arrive already narrowed by the pane's filters.
    func setProjectGroups(
        _ projects: [CrmOrganizationProjectTaskGroups.Project],
        organizationID: String,
        failureLine: String?
    ) {
        drawProjectGroups(ProjectGroups(organizationID: organizationID, projects: projects, failureLine: failureLine))
    }

    private func drawProjectGroups(_ groups: ProjectGroups) {
        clearRows()
        projectGroups = groups
        newTaskButton.isEnabled = true
        statusLabel.textColor = StarlingsColors.secondaryText
        if let failureLine = groups.failureLine {
            groupNotice.showError(failureLine)
        } else {
            groupNotice.clear()
        }
        orderedTasks = groups.projects.flatMap(\.tasks)
        let open = orderedTasks.filter { !$0.status.isProposed }.count
        statusLabel.stringValue = groups.projects.isEmpty
            ? String(localized: "No open tasks.")
            : String(localized: "\(open) open")
        for project in groups.projects {
            let subject = project.subject
            let openButton = WorkTaskGroupOpenButton(title: String(localized: "Open")) { [weak self] in
                self?.onOpenProject?(subject)
            }
            openButton.setAccessibilityLabel(String(localized: "Open \(project.title)"))
            let section = SidebarSection(
                title: project.title,
                key: CrmOrganizationProjectTaskGroups.foldKey(organizationID: groups.organizationID, projectID: project.id),
                accessory: openButton,
                hidesWhenEmpty: false
            )
            let rows = project.tasks.filter(\.status.isProposed).map { proposedRow($0, subject: subject) }
                + project.tasks.filter { !$0.status.isProposed }.map { taskRow($0, subject: subject) }
            section.setRows(rows, count: project.tasks.count)
            section.translatesAutoresizingMaskIntoConstraints = false
            listStack.addArrangedSubview(section)
            section.widthAnchor.constraint(equalTo: listStack.widthAnchor).isActive = true
        }
    }

    private func isDone(_ task: CrmTask) -> Bool {
        task.status == .completed || locallyDoneTaskIDs.contains(task.id)
    }

    /// The write failed, so the tick has to come off — otherwise the row sits
    /// there ticked and disabled for a task that was never created.
    func clearAcceptingSuggestion(_ id: UUID) {
        acceptingSuggestionIDs.remove(id.uuidString)
    }

    /// Unresolved suggestions, newest last. `canAccept` is false until a lead
    /// or project is filed — the rows still show, because hiding them would
    /// throw away everything said before the meeting was categorized.
    func setSuggestions(_ suggestions: [TaskSuggestion], canAccept: Bool) {
        suggestionStack.arrangedSubviews.forEach {
            suggestionStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        suggestionsByID = Dictionary(uniqueKeysWithValues: suggestions.map { ($0.id.uuidString, $0) })
        acceptingSuggestionIDs.formIntersection(suggestionsByID.keys)
        suggestionHeader.isHidden = suggestions.isEmpty
        guard !suggestions.isEmpty else { return }
        for suggestion in suggestions {
            let row = makeSuggestionRow(suggestion, canAccept: canAccept)
            suggestionStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: suggestionStack.widthAnchor).isActive = true
        }
    }

    /// Why suggestions are not running, when that is worth saying.
    func setSuggestionNote(_ note: String?) {
        suggestionNoteLabel.stringValue = note ?? ""
        suggestionNoteLabel.isHidden = note == nil
    }

    private func makeSuggestionRow(_ suggestion: TaskSuggestion, canAccept: Bool) -> NSView {
        let id = suggestion.id.uuidString
        let accepting = acceptingSuggestionIDs.contains(id)

        let row = NSView()
        row.translatesAutoresizingMaskIntoConstraints = false
        row.wantsLayer = true
        row.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: row).cgColor
        row.layer?.cornerRadius = 6
        row.layer?.borderWidth = 1
        row.layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: row).cgColor

        // The diamond is the same mark the caption panel puts on the line that
        // produced this row, so the toggle and the provenance are one symbol.
        let toggle = toggleButton(
            on: accepting,
            onSymbol: "checkmark.diamond.fill",
            offSymbol: "diamond",
            label: "Add to tasks",
            action: #selector(acceptSuggestionPressed(_:))
        )
        toggle.identifier = NSUserInterfaceItemIdentifier(id)
        toggle.isEnabled = canAccept && !accepting
        toggle.contentTintColor = accepting ? StarlingsColors.accentMark : StarlingsColors.secondaryText
        toggle.toolTip = canAccept
            ? String(localized: "Add to tasks")
            : "Pick a lead or project to accept."

        let title = NSButton(title: suggestion.title, target: self, action: #selector(editSuggestionPressed(_:)))
        title.bezelStyle = .inline
        title.controlSize = .small
        SettingsChrome.applyQuietButton(title)
        title.alignment = .left
        title.identifier = NSUserInterfaceItemIdentifier(id)
        title.isEnabled = canAccept && !accepting

        let dismiss = symbolButton("xmark", label: "Dismiss suggestion", action: #selector(dismissSuggestionPressed(_:)))
        dismiss.identifier = NSUserInterfaceItemIdentifier(id)
        dismiss.toolTip = String(localized: "Dismiss — this one won’t come back")
        dismiss.isEnabled = !accepting

        let content = NSStackView(views: [toggle, title, dismiss])
        content.orientation = .horizontal
        content.alignment = .centerY
        content.spacing = 6
        content.translatesAutoresizingMaskIntoConstraints = false
        content.setHuggingPriority(.defaultLow, for: .horizontal)
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        row.addSubview(content)

        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 6),
            content.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -6),
            content.topAnchor.constraint(equalTo: row.topAnchor, constant: 4),
            content.bottomAnchor.constraint(equalTo: row.bottomAnchor, constant: -4),
        ])

        return row
    }

    private func toggleButton(
        on: Bool,
        onSymbol: String,
        offSymbol: String,
        label: String,
        action: Selector
    ) -> NSButton {
        let button = symbolButton(on ? onSymbol : offSymbol, label: label, action: action)
        button.setAccessibilityRole(.checkBox)
        button.setAccessibilityValue(on)
        return button
    }

    /// `label` is what a screen reader says — never the symbol's own name
    ///.
    private func symbolButton(_ symbol: String, label: String, action: Selector) -> NSButton {
        let button = NSButton(title: "", target: self, action: action)
        button.bezelStyle = .inline
        button.controlSize = .small
        button.imagePosition = .imageOnly
        button.setAccessibilityLabel(label)
        button.image = NSImage(
            systemSymbolName: symbol,
            accessibilityDescription: label
        )?.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 10, weight: .semibold))
        SettingsChrome.applyQuietButton(button)
        button.setContentHuggingPriority(.required, for: .horizontal)
        return button
    }

    private func clearRows() {
        orderedTasks = []
        listStack.arrangedSubviews.forEach {
            listStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
    }

    @objc private func newTaskPressed() {
        onNewTask?()
    }

    private func toggleTaskDone(_ task: CrmTask, done desiredDone: Bool) {
        setTaskDoneLocally(task, done: desiredDone)
        onToggleTaskDone?(task, desiredDone)
    }

    /// Reflect a completion chosen from the row menu as promptly as the
    /// checkbox does. The menu's owner still performs the write and refresh.
    func setTaskDoneLocally(_ task: CrmTask, done: Bool) {
        let id = task.id
        if done {
            locallyDoneTaskIDs.insert(id)
        } else {
            locallyDoneTaskIDs.remove(id)
        }
        // Redraw from the rows we already hold: the panel must not wait on Core
        // to show a tick, and reloading here would drop a just-completed row
        // out of the open list before the owner could take it back.
        if let projectGroups { drawProjectGroups(projectGroups) } else { setTasks(orderedTasks, subject: subject) }
    }

    @objc private func acceptSuggestionPressed(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue,
              let suggestion = suggestionsByID[id] else { return }
        acceptingSuggestionIDs.insert(id)
        sender.image = NSImage(
            systemSymbolName: "checkmark.diamond.fill",
            accessibilityDescription: "checkmark.diamond.fill"
        )?.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 10, weight: .semibold))
        sender.contentTintColor = StarlingsColors.accentMark
        sender.isEnabled = false
        onAcceptSuggestion?(suggestion)
    }

    @objc private func editSuggestionPressed(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue,
              let suggestion = suggestionsByID[id] else { return }
        onEditSuggestion?(suggestion)
    }

    @objc private func dismissSuggestionPressed(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue,
              let suggestion = suggestionsByID[id] else { return }
        onDismissSuggestion?(suggestion)
    }
}

/// A task row with the same bounded, two-line grammar as a GitHub issue row.
/// The shell gives a list of tasks a finite rhythm; the circle remains the one
/// direct action and the row itself remains the place to read or edit the task.
/// One Core-proposed task: title, why it was proposed, and the two
/// answers. Not a `MeetingTaskRowView` — a proposal has no done tick, and
/// drawing one would promise a state the task is not in.
@MainActor
private final class MeetingProposedTaskRowView: NSView {
    private let task: CrmTask
    private let favorites: StarredWatch?
    private let onAccept: (CrmTask) -> Void
    private let onDecline: (CrmTask) -> Void
    private let onEdit: (CrmTask) -> Void
    private let menuActions: [[WorkRowAction]]
    private let onMenuAction: (WorkRowAction) -> Void

    init(
        task: CrmTask,
        favorites: StarredWatch?,
        onAccept: @escaping (CrmTask) -> Void,
        onDecline: @escaping (CrmTask) -> Void,
        onEdit: @escaping (CrmTask) -> Void,
        menuActions: [[WorkRowAction]],
        onMenuAction: @escaping (WorkRowAction) -> Void
    ) {
        self.task = task
        self.favorites = favorites
        self.onAccept = onAccept
        self.onDecline = onDecline
        self.onEdit = onEdit
        self.menuActions = menuActions
        self.onMenuAction = onMenuAction
        super.init(frame: .zero)

        let badge = NSTextField(labelWithString: String(localized: "PROPOSED"))
        badge.font = .systemFont(ofSize: StarlingsTypography.scaled(9), weight: .semibold)
        badge.textColor = StarlingsColors.accentInk
        badge.wantsLayer = true
        badge.layer?.cornerRadius = 6
        badge.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.accent, for: badge).cgColor
        badge.stringValue = String(localized: "  PROPOSED  ")
        badge.setContentHuggingPriority(.required, for: .horizontal)

        let title = NSTextField(labelWithString: task.title)
        title.font = WorkListRowView.titleFont()
        title.textColor = StarlingsColors.primaryText
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        var parts = [String(localized: "Proposed")]
        if let due = CrmTaskDate.date(task.dueDate) {
            parts.append(String(localized: "due \(StarlingsDateFormatting.date(due))"))
        }
        if let priority = task.priority, priority != "medium" { parts.append(priority) }
        let detail = NSTextField(labelWithString: parts.joined(separator: " · "))
        detail.font = WorkListRowView.detailFont()
        detail.textColor = StarlingsColors.secondaryText
        detail.lineBreakMode = .byTruncatingTail
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let titleRow = NSStackView(views: [badge, title])
        titleRow.orientation = .horizontal
        titleRow.alignment = .centerY
        titleRow.spacing = 6
        let text = NSStackView(views: [titleRow, detail])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = WorkListRowView.textSpacing
        text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let accept = NSButton(title: String(localized: "Accept"), target: self, action: #selector(acceptPressed))
        accept.bezelStyle = .rounded
        accept.controlSize = .small
        accept.keyEquivalent = ""
        let decline = NSButton(title: String(localized: "Decline"), target: self, action: #selector(declinePressed))
        decline.bezelStyle = .rounded
        decline.controlSize = .small
        for button in [accept, decline] { button.setContentHuggingPriority(.required, for: .horizontal) }

        let row = NSStackView(views: [text, NSView(), decline, accept])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            heightAnchor.constraint(equalToConstant: 56),
        ])

        wantsLayer = true
        applyMeetHoverLift(base: StarlingsColors.elevated, cornerRadius: 8)
        setAccessibilityElement(true)
        setAccessibilityRole(.row)
        setAccessibilityLabel(String(localized: "Proposed task: \(task.title). Accept or decline."))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func mouseDown(with event: NSEvent) {
        onEdit(task)
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu.workRow(menuActions, perform: onMenuAction) ?? NSMenu()
        if let favorites {
            if !menu.items.isEmpty { menu.addItem(.separator()) }
            menu.addFavoriteAction(
                FavoriteTarget(kind: .crmTask, targetRef: task.id.lowercased()),
                watch: favorites,
                window: window
            )
        }
        return menu.items.isEmpty ? nil : menu
    }

    @objc private func acceptPressed() { onAccept(task) }
    @objc private func declinePressed() { onDecline(task) }
}

@MainActor
private final class MeetingTaskRowView: WorkListRowView {
    private let task: CrmTask
    private let favorites: StarredWatch?
    private let isDone: Bool
    private let onToggleDone: (CrmTask, Bool) -> Void
    private let menuActions: [[WorkRowAction]]
    private let onMenuAction: (WorkRowAction) -> Void

    init(
        task: CrmTask,
        favorites: StarredWatch?,
        isDone: Bool,
        isSelected: Bool = false,
        onToggleDone: @escaping (CrmTask, Bool) -> Void,
        onEdit: @escaping (CrmTask) -> Void,
        menuActions: [[WorkRowAction]],
        onMenuAction: @escaping (WorkRowAction) -> Void
    ) {
        self.task = task
        self.favorites = favorites
        self.isDone = isDone
        self.onToggleDone = onToggleDone
        self.menuActions = menuActions
        self.onMenuAction = onMenuAction

        // The same scan order as the issue list: ownership first, then the
        // date and the pointer to GitHub when one exists.
        var parts = [task.assigneeName ?? task.responsibleParty.title]
        if let due = CrmTaskDate.date(task.dueDate) {
            parts.append(StarlingsDateFormatting.date(due))
        }
        if let priority = task.priority, priority != "medium" {
            parts.append(priority)
        }
        if let number = task.githubIssueNumber {
            parts.append("#\(number)")
        }

        let (content, toggle) = WorkTaskRowContent.build(
            title: task.title,
            isDone: isDone,
            isLate: task.isOverdue && !isDone,
            detailParts: parts
        )
        super.init(
            content: content,
            isSelected: isSelected,
            accessibilityLabel: isDone ? String(localized: "\(task.title), done") : task.title,
            onActivate: { onEdit(task) }
        )
        toggle.target = self
        toggle.action = #selector(togglePressed)
        toggle.toolTip = isDone ? String(localized: "Mark as still open") : String(localized: "Done")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu.workRow(menuActions, perform: onMenuAction) ?? NSMenu()
        if let favorites {
            if !menu.items.isEmpty { menu.addItem(.separator()) }
            menu.addFavoriteAction(
                FavoriteTarget(kind: .crmTask, targetRef: task.id.lowercased()),
                watch: favorites,
                window: window
            )
        }
        return menu.items.isEmpty ? nil : menu
    }

    @objc private func togglePressed() {
        onToggleDone(task, !isDone)
    }

}

/// The Open on a By project header: quiet, like the other
/// header links, with its action as a closure.
private final class WorkTaskGroupOpenButton: NSButton {
    private let onPress: () -> Void

    init(title: String, onPress: @escaping () -> Void) {
        self.onPress = onPress
        super.init(frame: .zero)
        self.title = title
        bezelStyle = .inline
        isBordered = false
        font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .medium)
        contentTintColor = StarlingsColors.secondaryText
        target = self
        action = #selector(pressed)
        SettingsChrome.applyQuietButton(self)
        setContentHuggingPriority(.required, for: .horizontal)
    }

    @objc private func pressed() { onPress() }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}
