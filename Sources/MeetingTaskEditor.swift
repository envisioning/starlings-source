import AppKit
import StarlingsContracts

/// New/edit task sheet for live-meeting CRM (Envisioning-only).
///
/// Main-actor isolated: it builds AppKit views and runs a sheet, so it was
/// already only ever called from the main actor — saying so is what lets the
/// sheet own the controls it wires up.
@MainActor
enum MeetingTaskEditor {
    struct Draft {
        var title: String
        var notes: String
        var status: CrmTaskStatus
        var responsible: CrmTaskResponsible
        /// Which person, once `responsible` says the team owes it. Nil is
        /// nobody yet, which is a real answer rather than a missing one.
        var assignedTo: String?
        /// Nil is undated, and undated work never reaches the calendar.
        var dueDate: Date?
        /// Where the task is filed. Core refuses a task without exactly one
        /// project, lead or partner, so this is never nil on save — Save stays disabled
        /// until a subject is chosen.
        var subject: CrmSubject?
        /// The goal this task serves. Nil is none.
        var goalID: String?

        init(
            title: String,
            notes: String,
            status: CrmTaskStatus,
            responsible: CrmTaskResponsible,
            assignedTo: String? = nil,
            dueDate: Date? = nil,
            subject: CrmSubject? = nil,
            goalID: String? = nil
        ) {
            self.title = title
            self.notes = notes
            self.status = status
            self.responsible = responsible
            self.assignedTo = assignedTo
            self.dueDate = dueDate
            self.subject = subject
            self.goalID = goalID
        }
    }

    /// Whether the sheet lets the subject be chosen. A subject page fixes it;
    /// a meeting offers a choice, defaulting to the meeting's own filing — so a
    /// meeting nobody has categorized can still accept a task, instead of the
    /// suggestion being lost until somebody files the meeting first.
    enum SubjectField {
        case fixed
        case choose(
            initial: CrmSubject?,
            options: [CrmSubject],
            search: ((String) async -> [CrmSubject])?
        )
    }

    /// `team` is the roster from Core, not Meet's presence list — a colleague
    /// who has never opened Meet is still assignable work. Empty means the
    /// roster could not be read, and the sheet simply does not offer a name.
    ///
    /// Presented as a document-modal sheet, so it returns immediately and
    /// answers through `onSave`; every call site already took a closure.
    static func present(
        over window: NSWindow?,
        title: String,
        initial: Draft,
        team: [CrmTeamMember] = [],
        /// The project's live goals, and the one the task already serves.
        /// Empty means no Goal row: off a project there is nothing to pick.
        goals: [CrmGoal] = [],
        subjectField: SubjectField = .fixed,
        selfMemberID: String? = nil,
        isNew: Bool = false,
        onSave: @escaping (Draft) -> Void
    ) {
        let controller = TaskSheetController(
            heading: title,
            initial: initial,
            team: team,
            goals: goals,
            subjectField: subjectField,
            selfMemberID: selfMemberID,
            isNew: isNew,
            onSave: onSave
        )
        controller.run(over: window)
    }
}

// MARK: - Sheet

/// The form itself. A view controller rather than an `NSAlert` accessory view:
/// an alert is for a question with an answer, and this is a form with six
/// fields, two of which appear only when they mean something.
@MainActor
private final class TaskSheetController: NSViewController, NSTextFieldDelegate {
    private enum Metrics {
        static let width: CGFloat = 420
        static let padding: CGFloat = 20
        static let rowGap: CGFloat = 14
        static let captionGap: CGFloat = 6
        static let buttonHeight: CGFloat = 32
    }

    private let heading: String
    private let initial: MeetingTaskEditor.Draft
    private let team: [CrmTeamMember]
    private let goals: [CrmGoal]
    private let onSave: (MeetingTaskEditor.Draft) -> Void

    private let titleField = StarlingsTextField(placeholder: String(localized: "What needs doing"))
    private let notesField = StarlingsTextField(placeholder: String(localized: "Notes (optional)"))
    private let responsibleField = StarlingsPopUpField(frame: .zero)
    private let statusField = StarlingsPopUpField(frame: .zero)
    private let assigneeField = StarlingsSearchablePickerField(frame: .zero)
    private let goalField = StarlingsSearchablePickerField(frame: .zero)
    private let duePicker = StarlingsDatePickerField(frame: .zero)
    private let dueToggle = NSButton(checkboxWithTitle: "Has a due date", target: nil, action: nil)
    private let saveButton = StarlingsFilledButton(frame: .zero)
    private var assigneeGroup = NSView()
    private let subjectField = StarlingsSearchablePickerField(frame: .zero)
    private var subjectGroup = NSView()
    private var subjectOptions: [CrmSubject] = []
    private var selectedAssigneeID: String?
    private var selectedGoalID: String?

    private let subjectMode: MeetingTaskEditor.SubjectField
    /// Preselects the signed-in member on a fresh team task: work accepted or
    /// typed by somebody is theirs until they hand it off, and an unassigned
    /// task appears on nobody's plate. Never applied to an edit — an existing
    /// task with nobody named is a decision, not a gap.
    private let selfMemberID: String?
    private let isNew: Bool

    init(
        heading: String,
        initial: MeetingTaskEditor.Draft,
        team: [CrmTeamMember],
        goals: [CrmGoal],
        subjectField subjectMode: MeetingTaskEditor.SubjectField,
        selfMemberID: String?,
        isNew: Bool,
        onSave: @escaping (MeetingTaskEditor.Draft) -> Void
    ) {
        self.heading = heading
        self.initial = initial
        self.team = team
        self.goals = goals
        self.subjectMode = subjectMode
        self.selfMemberID = selfMemberID
        self.isNew = isNew
        self.onSave = onSave
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: Layout

    override func loadView() {
        let root = NSView()
        root.wantsLayer = true
        root.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.panel, for: root).cgColor

        let headingLabel = NSTextField(labelWithString: heading)
        headingLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(15), weight: .semibold)
        headingLabel.textColor = StarlingsColors.primaryText

        titleField.stringValue = initial.title
        titleField.delegate = self
        notesField.stringValue = initial.notes

        let parties: [Choice] = CrmTaskResponsible.allCases.map { Choice($0.title, $0.rawValue) }
        configureChoice(responsibleField, cases: parties, selecting: initial.responsible.rawValue)
        responsibleField.popup.target = self
        responsibleField.popup.action = #selector(responsibleChanged)

        // All four, because the table has four and Core offers four. Offering
        // three here made cancelling a task something only the web could do.
        let statuses: [Choice] = CrmTaskStatus.editable.map { Choice($0.menuTitle, $0.rawValue) }
        configureChoice(statusField, cases: statuses, selecting: initial.status.rawValue)

        // Only the team has members: a client task is owed by the client, and
        // naming one of us on it would be a lie about who is doing the work.
        // A fresh team task lands on the person creating it. Work you accept
        // is yours until you hand it off, and a task assigned to nobody appears
        // on nobody's plate.
        let assignee = initial.assignedTo
            ?? (isNew && initial.responsible == .team ? selfMemberID : nil)
        selectedAssigneeID = assignee
        let assigneeOptions = [StarlingsSearchablePickerOption(id: "", title: String(localized: "Nobody yet"))]
            + team.assigneeOptions
        assigneeField.setOptions(assigneeOptions, placeholder: String(localized: "Nobody yet"), selectedID: assignee ?? "")
        assigneeField.onSelection = { [weak self] id in self?.selectedAssigneeID = id.isEmpty ? nil : id }

        // The subject is a field, not a precondition for opening the sheet.
        switch subjectMode {
        case .fixed:
            subjectOptions = []
        case .choose(let initialSubject, let options, let search):
            subjectOptions = options
            subjectField.setOptions(
                options.map(subjectPickerOption),
                placeholder: String(localized: "Choose a project, lead or partner"),
                selectedID: initialSubject.map(subjectPickerID)
            )
            subjectField.onSelection = { [weak self] _ in self?.saveButton.isEnabled = self?.canSave ?? false }
            if let search {
                subjectField.search = { [weak self] query in
                    let matches = await search(query)
                    guard let self else { return [] }
                    // Merge, never replace: a subject picked from the first
                    // list after a search must still resolve on Save.
                    let known = Set(subjectOptions.map(subjectPickerID))
                    subjectOptions += matches.filter { !known.contains(subjectPickerID($0)) }
                    return matches.map(subjectPickerOption)
                }
            }
        }

        duePicker.picker.datePickerElements = [.yearMonthDay]
        duePicker.picker.dateValue = initial.dueDate ?? Date()
        // Undated is the honest default for a task nobody has committed to a
        // day, so the picker only counts once somebody says it does.
        duePicker.isHidden = initial.dueDate == nil
        dueToggle.attributedTitle = NSAttributedString(string: "Has a due date", attributes: [
            .font: NSFont.systemFont(ofSize: StarlingsTypography.scaled(13)),
            .foregroundColor: StarlingsColors.primaryText,
        ])
        dueToggle.state = initial.dueDate == nil ? .off : .on
        dueToggle.applyMeetCheckboxStyle()
        dueToggle.target = self
        dueToggle.action = #selector(dueToggled)

        let choices = NSStackView(views: [
            field(caption: String(localized: "Responsible"), control: responsibleField),
            field(caption: String(localized: "Status"), control: statusField),
        ])
        choices.orientation = .horizontal
        choices.distribution = .fillEqually
        choices.alignment = .top
        choices.spacing = 12

        assigneeGroup = field(caption: String(localized: "Assignee"), control: assigneeField)
        assigneeGroup.isHidden = initial.responsible != .team || team.isEmpty

        // Where the work points. Only on a project with goals.
        selectedGoalID = initial.goalID
        let goalOptions = [StarlingsSearchablePickerOption(id: "", title: String(localized: "None"))]
            + goals.map { StarlingsSearchablePickerOption(id: $0.id, title: $0.title) }
        goalField.setOptions(goalOptions, placeholder: String(localized: "None"), selectedID: initial.goalID ?? "")
        goalField.onSelection = { [weak self] id in self?.selectedGoalID = id.isEmpty ? nil : id }
        let goalGroup = field(caption: String(localized: "Goal"), control: goalField)
        goalGroup.isHidden = goals.isEmpty

        subjectGroup = field(caption: String(localized: "File under"), control: subjectField)
        if case .fixed = subjectMode { subjectGroup.isHidden = true }

        // A date needs a date's worth of room and no more, so the slack at the
        // end of the row is slack rather than a very wide picker.
        let dueTail = NSView()
        dueTail.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        let dueRow = NSStackView(views: [dueToggle, duePicker, dueTail])
        dueRow.orientation = .horizontal
        dueRow.alignment = .centerY
        dueRow.spacing = 12
        dueToggle.setContentHuggingPriority(.required, for: .horizontal)
        duePicker.widthAnchor.constraint(equalToConstant: 150).isActive = true

        let rows: [NSView] = [
            headingLabel,
            field(caption: String(localized: "Title"), control: titleField),
            field(caption: String(localized: "Notes"), control: notesField),
            subjectGroup,
            choices,
            assigneeGroup,
            goalGroup,
            dueRow,
        ]
        let form = NSStackView(views: rows)
        form.orientation = .vertical
        form.alignment = .leading
        form.spacing = Metrics.rowGap
        form.setCustomSpacing(Metrics.padding, after: headingLabel)
        // Every row spans the sheet. Without this a `.leading` stack lets each
        // row hug its own content, which is how the fields ended up narrower
        // than the captions naming them.
        for row in rows where row !== headingLabel {
            row.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
        }

        let cancelButton = NSButton(title: String(localized: "Cancel"), target: self, action: #selector(cancel))
        SettingsChrome.applySecondaryButton(cancelButton, height: Metrics.buttonHeight)
        cancelButton.keyEquivalent = "\u{1b}"

        saveButton.target = self
        saveButton.action = #selector(save)
        saveButton.apply(
            .accent,
            title: String(localized: "Save"),
            font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold),
            height: Metrics.buttonHeight
        )
        saveButton.keyEquivalent = "\r"
        // A task with no title is not a task, and Core refuses one with no
        // subject; the button says so rather than the save silently doing
        // nothing or eating a 400.
        saveButton.isEnabled = canSave

        let spacer = NSView()
        spacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        let footer = NSStackView(views: [spacer, cancelButton, saveButton])
        footer.orientation = .horizontal
        footer.alignment = .centerY
        footer.spacing = 10

        let divider = SettingsChrome.hairline()

        let column = NSStackView(views: [form, divider, footer])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = Metrics.padding
        root.addSubview(column)
        column.pinToEdges(of: root, insets: NSEdgeInsets(
            top: Metrics.padding,
            left: Metrics.padding,
            bottom: Metrics.padding,
            right: Metrics.padding
        ))
        NSLayoutConstraint.activate([
            root.widthAnchor.constraint(equalToConstant: Metrics.width),
            form.widthAnchor.constraint(equalTo: column.widthAnchor),
            divider.widthAnchor.constraint(equalTo: column.widthAnchor),
            footer.widthAnchor.constraint(equalTo: column.widthAnchor),
        ])
        view = root
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        view.window?.makeFirstResponder(titleField)
    }

    /// Caption above the control it names — the house form idiom, and the one
    /// thing the old fixed-frame layout got backwards.
    private func field(caption: String, control: NSView) -> NSView {
        let group = NSStackView(views: [StarlingsTypography.fieldCaption(caption), control])
        group.orientation = .vertical
        group.alignment = .leading
        group.spacing = Metrics.captionGap
        control.setContentHuggingPriority(.defaultLow, for: .horizontal)
        NSLayoutConstraint.activate([
            control.widthAnchor.constraint(equalTo: group.widthAnchor),
        ])
        return group
    }

    /// One menu entry: what it says, and the wire value it stands for.
    private struct Choice {
        let title: String
        let value: String?

        init(_ title: String, _ value: String?) {
            self.title = title
            self.value = value
        }
    }

    private func configureChoice(
        _ field: StarlingsPopUpField,
        cases: [Choice],
        selecting selected: String?
    ) {
        let popup = field.popup
        popup.removeAllItems()
        for choice in cases {
            popup.addItem(withTitle: choice.title)
            popup.lastItem?.representedObject = choice.value
        }
        let index = cases.firstIndex { $0.value == selected }
        popup.selectItem(at: index ?? 0)
    }

    // MARK: Behaviour

    func controlTextDidChange(_ notification: Notification) {
        guard notification.object as? NSTextField === titleField else { return }
        saveButton.isEnabled = canSave
    }

    /// A title, and somewhere to file it. When the subject is fixed the second
    /// half is already answered.
    private var canSave: Bool {
        guard !trimmed(titleField).isEmpty else { return false }
        if case .choose = subjectMode { return chosenSubject != nil }
        return true
    }

    private var chosenSubject: CrmSubject? {
        guard case .choose = subjectMode else { return initial.subject }
        guard let id = subjectField.selectedID else { return nil }
        return subjectOptions.first { subjectPickerID($0) == id }
    }

    private func subjectPickerID(_ subject: CrmSubject) -> String {
        "\(subject.kind):\(subject.id)"
    }

    private func subjectPickerOption(_ subject: CrmSubject) -> StarlingsSearchablePickerOption {
        StarlingsSearchablePickerOption(
            id: subjectPickerID(subject),
            title: subject.title,
            context: subject.pickerKindLabel,
            subtitle: subject.subtitle
        )
    }

    /// The picker follows the party rather than waiting for the sheet to be
    /// reopened: choosing Envisioning and then not being offered a name reads
    /// as a missing feature.
    @objc private func responsibleChanged() {
        let raw = responsibleField.popup.selectedItem?.representedObject as? String
        let isTeam = CrmTaskResponsible(rawValue: raw ?? "") == .team
        setCollapsed(assigneeGroup, hidden: !isTeam || team.isEmpty)
    }

    @objc private func dueToggled() {
        setCollapsed(duePicker, hidden: dueToggle.state != .on)
    }

    /// A stack view drops a hidden arranged subview, so the sheet has to take
    /// back the height rather than leave a hole where the row was.
    private func setCollapsed(_ view: NSView, hidden: Bool) {
        guard view.isHidden != hidden else { return }
        view.isHidden = hidden
        resizeToFit()
    }

    private func resizeToFit() {
        guard let window = view.window else { return }
        view.layoutSubtreeIfNeeded()
        window.setContentSize(view.fittingSize)
    }

    private func trimmed(_ field: NSTextField) -> String {
        field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @objc private func cancel() {
        close()
    }

    @objc private func save() {
        let title = trimmed(titleField)
        guard !title.isEmpty, canSave else { return }
        let partyRaw = responsibleField.popup.selectedItem?.representedObject as? String
        let statusRaw = statusField.popup.selectedItem?.representedObject as? String
        let party = CrmTaskResponsible(rawValue: partyRaw ?? "") ?? .unassigned
        let draft = MeetingTaskEditor.Draft(
            title: title,
            notes: trimmed(notesField),
            status: CrmTaskStatus(rawValue: statusRaw ?? "") ?? .pending,
            responsible: party,
            // A task the client owes cannot also be owed by one of us.
            assignedTo: party == .team ? selectedAssigneeID : nil,
            dueDate: dueToggle.state == .on ? duePicker.picker.dateValue : nil,
            subject: chosenSubject,
            goalID: goals.isEmpty ? initial.goalID : selectedGoalID
        )
        close()
        onSave(draft)
    }

    // MARK: Presentation

    func run(over parent: NSWindow?) {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: NSSize(width: Metrics.width, height: 100)),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.title = heading
        window.isReleasedWhenClosed = false
        // Assigning the content view controller sizes the window to the form's
        // fitting height; the width is the constraint above.
        window.contentViewController = self
        guard let parent else {
            window.center()
            NSApp.runModal(for: window)
            window.orderOut(nil)
            return
        }
        parent.beginSheet(window) { _ in
            window.orderOut(nil)
        }
    }

    private func close() {
        guard let window = view.window else { return }
        if let parent = window.sheetParent {
            parent.endSheet(window)
        } else {
            NSApp.stopModal()
            window.orderOut(nil)
        }
    }
}
