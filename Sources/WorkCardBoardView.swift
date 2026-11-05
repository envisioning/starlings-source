import AppKit

/// The card board — every open task and issue on every subject, in the six
/// stage columns of `WorkStage`, with agents holding cards the way people do.
///
/// The subject board (`WorkBoardView`) answers "where is this project". This
/// one answers "where is this piece of work, and who is holding it", and it is
/// a projection and nothing more: two stores read through one vocabulary. The
/// only things it can write are the stage a card was dropped into and a
/// hand-off to an agent, and both go through the controller. See
/// docs/BOARD.md.
///
/// Columns are dealt by the shared `WorkItems.board`, so the Mac, the web and
/// the fixture agree about which column a card is in and in what order.
@MainActor
final class WorkCardBoardView: NSView {
    /// A card was clicked: read it in the inspector, beside the board.
    var onSelect: ((BoardCard) -> Void)?
    /// A card was dropped into another column. The board has already moved it
    /// and will be told to put it back if the write is refused.
    var onMove: ((BoardCard, WorkStage) -> Void)?
    /// The last line on a card was clicked: open its channel there.
    var onOpenTrace: ((BoardCard) -> Void)?
    /// Hand the card to an agent, from the card's menu.
    var onHandOff: ((BoardCard, Peer) -> Void)?
    var onOpenSubject: ((CrmSubject) -> Void)?
    /// The person hid or showed a column: the whole set, to store.
    var onHiddenStagesChange: ((Set<WorkStage>) -> Void)?
    /// Read the board again, after a subject's read failed.
    var onRetry: (() -> Void)?
    /// Delete a task card, from the card's menu. The controller asks first.
    var onDeleteTask: ((BoardCard) -> Void)?

    private let scroll = NSScrollView()
    private let columnsStack = NSStackView()
    private let messageLabel = StarlingsTypography.wrappingLabel("")
    private let subjectPicker = StarlingsSearchablePickerField(frame: .zero)
    private let holderPicker = StarlingsSearchablePickerField(frame: .zero)
    private let duePicker = StarlingsSearchablePickerField(frame: .zero)
    private let sidePicker = StarlingsSearchablePickerField(frame: .zero)
    private let partialLabel = StarlingsNoticeView()
    private let retryButton = NSButton(title: String(localized: "Retry"), target: nil, action: nil)
    /// Which columns show: one menu item per stage.
    private let columnsButton: NSButton = {
        let button = NSButton()
        button.bezelStyle = .inline
        SettingsChrome.applyQuietButton(button)
        button.image = NSImage(systemSymbolName: "rectangle.split.3x1", accessibilityDescription: String(localized: "Columns"))
        button.imagePosition = .imageOnly
        button.contentTintColor = StarlingsColors.secondaryText
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.setAccessibilityLabel(String(localized: "Columns"))
        button.toolTip = String(localized: "Columns")
        return button
    }()
    private var columns: [WorkStage: WorkBoardColumnView] = [:]

    private var cards: [BoardCard] = []
    private var subjects: [CrmSubject] = []
    private var agents: [Peer] = []
    private var gaps = WorkReadGaps.none
    private var loaded = false
    /// Cards moved on screen ahead of the write, by id. Cleared when the
    /// board is read again, which is what confirms the move.
    private var overrides: [String: WorkStage] = [:]
    private var subjectFilter: String?
    /// `anyone`, `people`, `agents` or `agent:<email>` (`passesHolderFilter`).
    private var holderFilter = WorkHolderChoice.anyone.rawValue
    /// The task filters beside it (`passesTaskFilter`). They last the session.
    private var dueFilter = WorkDueFilter.any
    private var sideFilter = WorkSideFilter.any
    /// The columns this person hides, on every project (`board_hidden_stages`).
    private var hiddenStages: Set<WorkStage> = []

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)

        columnsStack.orientation = .horizontal
        columnsStack.alignment = .top
        columnsStack.spacing = 12
        columnsStack.translatesAutoresizingMaskIntoConstraints = false

        scroll.drawsBackground = false
        scroll.hasHorizontalScroller = true
        scroll.hasVerticalScroller = false
        scroll.borderType = .noBorder
        let clip = WorkBoardClipView()
        clip.drawsBackground = false
        scroll.contentView = clip
        scroll.documentView = columnsStack
        scroll.translatesAutoresizingMaskIntoConstraints = false

        subjectPicker.setOptions([], placeholder: String(localized: "Every subject"), selectedID: "")
        subjectPicker.onSelection = { [weak self] id in
            guard let self else { return }
            subjectFilter = id.isEmpty ? nil : id
            render()
        }
        holderPicker.setOptions([], placeholder: WorkHolderChoice.anyone.title, selectedID: WorkHolderChoice.anyone.rawValue)
        holderPicker.onSelection = { [weak self] id in
            guard let self else { return }
            holderFilter = id.isEmpty ? WorkHolderChoice.anyone.rawValue : id
            render()
        }
        duePicker.onSelection = { [weak self] id in
            guard let self else { return }
            dueFilter = WorkDueFilter(rawValue: id) ?? .any
            render()
        }
        sidePicker.onSelection = { [weak self] id in
            guard let self else { return }
            sideFilter = WorkSideFilter(rawValue: id) ?? .any
            render()
        }

        partialLabel.label.lineBreakMode = .byTruncatingTail
        // Truncation needs somewhere to truncate *to*. Without this the label's
        // intrinsic width is a requirement, so a list of eleven unreadable
        // subjects pushed the column, the split view and the window itself out
        // past the screen. A status line reports; it does not get a vote on how
        // wide the window is.
        for view in [partialLabel, partialLabel.label] as [NSView] {
            view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        }

        retryButton.bezelStyle = .inline
        SettingsChrome.applyQuietButton(retryButton)
        retryButton.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold)
        retryButton.setContentHuggingPriority(.required, for: .horizontal)
        retryButton.target = self
        retryButton.action = #selector(retryTapped)
        retryButton.isHidden = true

        columnsButton.target = self
        columnsButton.action = #selector(showColumnsMenu(_:))
        let filters = NSStackView(views: [subjectPicker, holderPicker, duePicker, sidePicker, partialLabel, retryButton, NSView(), columnsButton])
        filters.orientation = .horizontal
        filters.alignment = .centerY
        filters.spacing = 8
        filters.translatesAutoresizingMaskIntoConstraints = false

        messageLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        messageLabel.textColor = StarlingsColors.secondaryText
        messageLabel.alignment = .center
        messageLabel.translatesAutoresizingMaskIntoConstraints = false
        messageLabel.isHidden = true

        addSubview(filters)
        addSubview(scroll)
        addSubview(messageLabel)
        NSLayoutConstraint.activate([
            filters.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            filters.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
            filters.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
            scroll.topAnchor.constraint(equalTo: filters.bottomAnchor, constant: 8),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
            columnsStack.heightAnchor.constraint(equalTo: scroll.contentView.heightAnchor),
            messageLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
            messageLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
            messageLabel.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -64),
        ])

        for stage in WorkStage.allCases {
            let column = WorkBoardColumnView(
                id: stage.rawValue,
                title: stage.columnLabel,
                foldKey: "work.cards.\(stage.rawValue)",
                startsCollapsed: stage.isFinished,
                dragType: .workCard
            )
            column.onDrop = { [weak self] token, target in
                guard let self, let card = card(forToken: token),
                      let stage = WorkStage(rawValue: target),
                      self.stage(of: card) != stage
                else { return }
                move(card, to: stage)
                onMove?(card, stage)
            }
            column.onFoldChange = { [weak self] in self?.render() }
            columns[stage] = column
            columnsStack.addArrangedSubview(column)
            column.heightAnchor.constraint(equalTo: columnsStack.heightAnchor).isActive = true
        }
        fillFilters()
        setLoading()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: - What the board is showing

    func setLoading() {
        messageLabel.isHidden = true
        scroll.isHidden = false
        if !loaded { for column in columns.values { column.setLoading() } }
    }

    /// The whole board could not be read. One sentence, not six empty columns.
    func setMessage(_ message: String?) {
        messageLabel.stringValue = message ?? ""
        messageLabel.isHidden = message == nil
        scroll.isHidden = message != nil
    }

    func setAgents(_ agents: [Peer]) {
        guard agents.map(\.email) != self.agents.map(\.email) else { return }
        self.agents = agents
        fillFilters()
        render()
    }

    /// A fresh read. Every card comes from it; nothing on the board waits on a
    /// second request to be drawn, and the last thing that happened to a card
    /// is on its face from `card_trace`.
    func setBoard(_ response: CrmBoardResponse) {
        let subjectsByID = Dictionary(response.subjects.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let traces = Dictionary(response.traces.map { ("\($0.refKind):\($0.refID)", $0) }, uniquingKeysWith: { _, last in last })
        var out: [BoardCard] = []
        for task in response.tasks {
            let subject = (task.projectID ?? task.leadID ?? task.partnerOrganizationID).flatMap { subjectsByID[$0] }
            out.append(BoardCard(source: .task(task), subject: subject, trace: traces["task:\(task.id)"]))
        }
        for issue in response.issues {
            // An issue is filed by construction: the read names the project it
            // was fetched for, because the wire row only names its repository.
            let subject = response.issueProjects[issue.id].flatMap { subjectsByID[$0] }
            out.append(BoardCard(source: .issue(issue), subject: subject, trace: traces["issue:\(issue.id)"]))
        }
        cards = out
        subjects = response.subjects
        gaps = response.gaps
        overrides = [:]
        loaded = true
        setMessage(nil)
        fillFilters()
        render()
    }

    /// Forget the cards on screen: the next read is another project's.
    func clear() {
        cards = []
        subjects = []
        gaps = .none
        overrides = [:]
        loaded = false
        setLoading()
    }

    /// A project's board: the project is the scope, so the
    /// subject filter has nothing to choose.
    func setScopedToProject(_ scoped: Bool) {
        subjectPicker.isHidden = scoped
        if scoped { subjectFilter = nil }
    }

    /// Move a card between columns without asking anybody. Used twice: on the
    /// drop, and again with the old stage if the write is refused.
    func move(_ card: BoardCard, to stage: WorkStage) {
        overrides[card.id] = stage
        render()
    }

    func stage(of card: BoardCard) -> WorkStage? {
        overrides[card.id] ?? (cards.contains(where: { $0.id == card.id }) ? WorkItems.stage(of: card) : nil)
    }

    /// A task was deleted: its card leaves before the re-read.
    func remove(cardID: String) {
        guard cards.contains(where: { $0.id == cardID }) else { return }
        cards.removeAll { $0.id == cardID }
        overrides[cardID] = nil
        render()
    }

    /// The card a pasteboard token names. The token is `kind:id`, never a
    /// copy of the record.
    func card(forToken token: String) -> BoardCard? {
        cards.first { $0.dragToken == token }
    }

    // MARK: - Filters

    private func fillFilters() {
        let chosenSubject = subjectFilter
        let projects = subjects.filter { $0.kind == "project" }.sorted { $0.title < $1.title }
        let leads = subjects.filter { $0.kind == "lead" }.sorted { $0.title < $1.title }
        let partners = subjects.filter { $0.kind == "organization" }.sorted { $0.title < $1.title }
        let subjectOptions = [StarlingsSearchablePickerOption(id: "", title: String(localized: "Every subject"))]
            + (projects + leads + partners).map { subject in
                StarlingsSearchablePickerOption(
                    id: subject.id,
                    title: subject.title,
                    context: subject.pickerKindLabel,
                    subtitle: subject.subtitle
                )
            }
        let selectedSubject = chosenSubject.flatMap { id in subjectOptions.contains(where: { $0.id == id }) ? id : nil }
        subjectFilter = selectedSubject?.isEmpty == false ? selectedSubject : nil
        subjectPicker.setOptions(subjectOptions, placeholder: String(localized: "Every subject"), selectedID: selectedSubject ?? "")

        let holderOptions = WorkHolderChoice.allCases.map { StarlingsSearchablePickerOption(id: $0.rawValue, title: $0.title) }
            + agents.map { StarlingsSearchablePickerOption(id: "agent:\($0.email)", title: $0.displayName, subtitle: $0.email) }
        // An agent who left the roster takes their filter with them.
        if !holderOptions.contains(where: { $0.id.caseInsensitiveCompare(holderFilter) == .orderedSame }) {
            holderFilter = WorkHolderChoice.anyone.rawValue
        }
        let selectedHolderID = holderOptions.first { $0.id.caseInsensitiveCompare(holderFilter) == .orderedSame }?.id ?? WorkHolderChoice.anyone.rawValue
        holderPicker.setOptions(holderOptions, placeholder: WorkHolderChoice.anyone.title, selectedID: selectedHolderID)

        duePicker.setOptions(
            WorkDueFilter.allCases.map { StarlingsSearchablePickerOption(id: $0.rawValue, title: $0.title) },
            placeholder: WorkDueFilter.any.title,
            selectedID: dueFilter.rawValue
        )
        sidePicker.setOptions(
            WorkSideFilter.allCases.map { StarlingsSearchablePickerOption(id: $0.rawValue, title: $0.label) },
            placeholder: WorkSideFilter.any.title,
            selectedID: sideFilter.rawValue
        )
    }

    // MARK: - Columns

    /// The columns this person hides, from their stored preference.
    func setHiddenStages(_ stages: Set<WorkStage>) {
        guard stages != hiddenStages else { return }
        hiddenStages = stages
        columnsButton.contentTintColor = stages.isEmpty ? StarlingsColors.secondaryText : StarlingsColors.accent
        render()
    }

    @objc private func retryTapped() {
        onRetry?()
    }

    @objc private func showColumnsMenu(_ sender: NSButton) {
        let menu = NSMenu()
        for stage in WorkStage.allCases {
            let item = NSMenuItem(title: stage.columnLabel.capitalized, action: #selector(toggleColumn(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = stage.rawValue
            item.state = hiddenStages.contains(stage) ? .off : .on
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
    }

    @objc private func toggleColumn(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let stage = WorkStage(rawValue: raw) else { return }
        var next = hiddenStages
        if next.contains(stage) { next.remove(stage) } else { next.insert(stage) }
        setHiddenStages(next)
        onHiddenStagesChange?(next)
    }

    private func passesFilters(_ card: BoardCard) -> Bool {
        if let subjectFilter, card.subject?.id != subjectFilter { return false }
        guard WorkItems.passesHolderFilter(card, filter: holderFilter, agentEmail: card.subject?.agentEmail) else { return false }
        return WorkItems.passesTaskFilter(card, due: dueFilter, side: sideFilter)
    }

    // MARK: - Drawing

    private func render() {
        guard loaded else { return }
        let shown = cards.filter(passesFilters)
        let plan = WorkItems.board(shown)
        let hiddenCount = hiddenStages.reduce(0) { $0 + plan.items(in: $1).count }
        // A failed read is red with Copy and Retry, naming each source and
        // its cause; a subject that hit the row cap is quiet copy.
        if let failure = gaps.failureLine {
            partialLabel.setText(failure, tone: .danger)
        } else {
            let quiet = [
                gaps.truncatedLine,
                hiddenCount > 0 ? String(localized: "\(hiddenCount) cards in hidden columns") : nil,
            ].compactMap { $0 }
            partialLabel.setText(quiet.isEmpty ? nil : quiet.joined(separator: " · "), tone: .neutral)
        }
        retryButton.isHidden = gaps.failureLine == nil
        for stage in WorkStage.allCases {
            guard let column = columns[stage] else { continue }
            // A hidden column takes no drop and draws nothing.
            column.isHidden = hiddenStages.contains(stage)
            // The plan's own order, then whatever was dragged in ahead of the
            // write, on top — it is the thing the person just did.
            var rows = plan.items(in: stage).filter { overrides[$0.id] == nil || overrides[$0.id] == stage }
            let arrivals = shown.filter { overrides[$0.id] == stage && !rows.contains($0) }
            rows = arrivals + rows
            column.setCards(rows.map { card in
                BoardCardView(
                    card: card,
                    stage: stage,
                    agents: agents,
                    onSelect: { [weak self] card in self?.onSelect?(card) },
                    onOpenTrace: { [weak self] card in self?.onOpenTrace?(card) },
                    onHandOff: { [weak self] card, agent in self?.onHandOff?(card, agent) },
                    onMoveTo: { [weak self] card, target in
                        guard let self, self.stage(of: card) != target else { return }
                        move(card, to: target)
                        onMove?(card, target)
                    },
                    onOpenSubject: { [weak self] subject in self?.onOpenSubject?(subject) },
                    onDelete: { [weak self] card in self?.onDeleteTask?(card) }
                )
            }, hasMore: false)
        }
    }
}

// MARK: - The card model

/// One card on the board: a task or an issue, what it is about, and the last
/// thing that happened to it.
struct BoardCard: ProjectedWorkCard, Identifiable, Equatable {
    enum Source: Equatable {
        case task(CrmTask)
        case issue(CrmIssue)
    }

    let source: Source
    let subject: CrmSubject?
    let trace: CardTrace?

    var id: String { workID }

    var title: String {
        switch source {
        case .task(let task): task.title
        case .issue(let issue): issue.title
        }
    }

    var refKind: String {
        switch source {
        case .task: "task"
        case .issue: "issue"
        }
    }

    var ref: ThreadMessageRef { ThreadMessageRef(kind: refKind, id: workID) }
    /// What rides the pasteboard: the identity, never a copy of the record.
    var dragToken: String { "\(refKind):\(workID)" }

    var task: CrmTask? { if case .task(let task) = source { task } else { nil } }
    var issue: CrmIssue? { if case .issue(let issue) = source { issue } else { nil } }

    var workTask: (any WorkTaskFields)? { task }
    var workIssue: CrmIssue? { issue }

    /// Who owes it, for the face. A task names its assignee; an issue names
    /// its first assignee by login, which is the most GitHub tells us.
    var holder: StarlingsAvatarIdentity? {
        switch source {
        case .task(let task):
            guard let name = task.assigneeName ?? task.assigneeEmail else { return nil }
            return StarlingsAvatarIdentity(displayName: name, email: task.assigneeEmail)
        case .issue(let issue):
            guard let login = issue.assigneeLogin else { return nil }
            return StarlingsAvatarIdentity(displayName: login)
        }
    }

    /// The machine has it (`WorkItems.isHeldByAgent`): an open issue with
    /// any stage label. A task is a person's until Core has agent team rows.
    var isHeldByAgent: Bool { WorkItems.isHeldByAgent(self) }

}

/// The task filters read who holds a card and which side owes it.
extension BoardCard: WorkHeldCard {
    var workAssignee: String? { task.flatMap { $0.assigneeID ?? $0.assigneeEmail } }
    var workResponsibleParty: String? { task?.responsibleParty.rawValue }
    var workAssignees: [String] { issue?.assignees.map(\.login) ?? [] }
}

/// The pasteboard type a dragged card writes. Private to Meet: a card id is
/// meaningless anywhere else, and must not be droppable into Finder.
extension NSPasteboard.PasteboardType {
    static let workCard = NSPasteboard.PasteboardType("\(ContractConstants.nativeAppBundleID).work.card")
}

// MARK: - Cards

/// One card. Title, what it is about, who holds it, when it is due, and the
/// last thing that happened to it — everything from the one board read.
@MainActor
private final class BoardCardView: NSView, NSDraggingSource {
    private let card: BoardCard
    private let stage: WorkStage
    private let agents: [Peer]
    private let onSelect: (BoardCard) -> Void
    private let onOpenTrace: (BoardCard) -> Void
    private let onHandOff: (BoardCard, Peer) -> Void
    private let onMoveTo: (BoardCard, WorkStage) -> Void
    private let onOpenSubject: (CrmSubject) -> Void
    private let onDelete: (BoardCard) -> Void
    private var didDrag = false

    init(
        card: BoardCard,
        stage: WorkStage,
        agents: [Peer],
        onSelect: @escaping (BoardCard) -> Void,
        onOpenTrace: @escaping (BoardCard) -> Void,
        onHandOff: @escaping (BoardCard, Peer) -> Void,
        onMoveTo: @escaping (BoardCard, WorkStage) -> Void,
        onOpenSubject: @escaping (CrmSubject) -> Void,
        onDelete: @escaping (BoardCard) -> Void
    ) {
        self.card = card
        self.stage = stage
        self.agents = agents
        self.onSelect = onSelect
        self.onOpenTrace = onOpenTrace
        self.onHandOff = onHandOff
        self.onMoveTo = onMoveTo
        self.onOpenSubject = onOpenSubject
        self.onDelete = onDelete
        super.init(frame: .zero)
        wantsLayer = true

        let title = NSTextField(labelWithString: card.title)
        title.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .medium)
        title.textColor = StarlingsColors.primaryText
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        title.maximumNumberOfLines = 2
        title.cell?.usesSingleLineMode = false
        title.preferredMaxLayoutWidth = 210

        var rows: [NSView] = [title]
        if let subject = card.subject {
            let about = NSTextField(labelWithString: subject.title)
            about.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            about.textColor = StarlingsColors.secondaryText
            about.lineBreakMode = .byTruncatingTail
            about.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            rows.append(about)
        }
        rows.append(metaRow())
        if let trace = card.trace {
            rows.append(traceRow(trace))
        }

        let column = NSStackView(views: rows)
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 4
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            column.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            column.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            column.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
        ])

        applyMeetHoverLift(base: StarlingsColors.panel, border: StarlingsColors.border, cornerRadius: 8)
        layer?.borderWidth = 1
        setAccessibilityLabel("\(card.title), \(stage.columnLabel.capitalized)")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Source mark, due date, and who holds it. The date takes the same rule
    /// the plan uses, so a card reads late here exactly when Mine says so.
    private func metaRow() -> NSView {
        var pills: [NSView] = []
        let source = NSTextField(labelWithString: card.issue.map { "#\($0.number)" } ?? String(localized: "Task"))
        source.font = .monospacedDigitSystemFont(ofSize: StarlingsTypography.scaled(10), weight: .medium)
        source.textColor = StarlingsColors.secondaryText
        pills.append(source)

        if let due = card.workDueDate {
            let section = WorkItems.dateSection(due: due, now: Date(), calendar: .current)
            let isLate = section == .late && !stage.isFinished
            let label = NSTextField(labelWithString: StarlingsDateFormatting.date(due))
            label.font = isLate ? .systemFont(ofSize: StarlingsTypography.scaled(10), weight: .bold) : .systemFont(ofSize: StarlingsTypography.scaled(10))
            label.textColor = StarlingsColors.secondaryText
            pills.append(label)
        }

        pills.append(NSView())

        if card.isHeldByAgent {
            let glyph = NSImageView()
            glyph.image = NSImage(systemSymbolName: "cpu", accessibilityDescription: String(localized: "An agent"))?
                .withSymbolConfiguration(.init(pointSize: 10, weight: .medium))
            glyph.contentTintColor = StarlingsColors.secondaryText
            glyph.toolTip = card.subject?.agentEmail.map { "Held by \($0)" } ?? String(localized: "Held by an agent")
            pills.append(glyph)
        } else if let holder = card.holder {
            let face = StarlingsPersonAvatarView(identity: holder, diameter: 18)
            face.toolTip = holder.displayName
            pills.append(face)
        }

        let row = NSStackView(views: pills)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.translatesAutoresizingMaskIntoConstraints = false
        row.widthAnchor.constraint(equalToConstant: 224).isActive = true
        return row
    }

    /// The last event line naming this card, and a way into the channel at
    /// that line. A label with a pointer, not a button: the line is the
    /// content, and a bordered control would out-shout the title above it.
    private func traceRow(_ trace: CardTrace) -> NSView {
        let line = NSTextField(labelWithString: trace.text)
        line.font = .systemFont(ofSize: StarlingsTypography.scaled(10))
        line.textColor = StarlingsColors.secondaryText
        line.lineBreakMode = .byTruncatingTail
        line.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        line.maximumNumberOfLines = 2
        line.cell?.usesSingleLineMode = false
        line.preferredMaxLayoutWidth = 210
        let holder = TraceRowView { [weak self] in
            guard let self else { return }
            onOpenTrace(card)
        }
        line.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(line)
        NSLayoutConstraint.activate([
            line.topAnchor.constraint(equalTo: holder.topAnchor),
            line.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
            line.leadingAnchor.constraint(equalTo: holder.leadingAnchor),
            line.trailingAnchor.constraint(equalTo: holder.trailingAnchor),
        ])
        return holder
    }

    // MARK: Clicking and dragging

    override func mouseDown(with event: NSEvent) {
        didDrag = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard !didDrag else { return }
        didDrag = true
        let item = NSPasteboardItem()
        item.setString(card.dragToken, forType: .workCard)
        let dragItem = NSDraggingItem(pasteboardWriter: item)
        dragItem.setDraggingFrame(bounds, contents: snapshot())
        beginDraggingSession(with: [dragItem], event: event, source: self)
    }

    override func mouseUp(with event: NSEvent) {
        guard !didDrag else { return }
        onSelect(card)
    }

    private func snapshot() -> NSImage {
        guard let rep = bitmapImageRepForCachingDisplay(in: bounds) else { return NSImage() }
        cacheDisplay(in: bounds, to: rep)
        let image = NSImage(size: bounds.size)
        image.addRepresentation(rep)
        return image
    }

    func draggingSession(
        _ session: NSDraggingSession,
        sourceOperationMaskFor context: NSDraggingContext
    ) -> NSDragOperation {
        context == .withinApplication ? .move : []
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu()
        let open = menu.addItem(withTitle: String(localized: "Open"), action: #selector(openPressed), keyEquivalent: "").symbol(.open)
        open.target = self
        if card.issue != nil {
            let github = menu.addItem(withTitle: String(localized: "Open on GitHub"), action: #selector(openGitHubPressed), keyEquivalent: "").symbol(.openExternal)
            github.target = self
        }
        if card.subject != nil {
            let subject = menu.addItem(withTitle: String(localized: "Open \(card.subject?.kind == "lead" ? "lead" : card.subject?.kind == "organization" ? "partner" : "project")"), action: #selector(openSubjectPressed), keyEquivalent: "").symbol(.open)
            subject.target = self
        }
        if card.trace != nil {
            let trace = menu.addItem(withTitle: String(localized: "Open in the conversation"), action: #selector(openTracePressed), keyEquivalent: "").symbol(.talk)
            trace.target = self
        }
        menu.addItem(.separator())
        let moveMenu = NSMenu()
        for target in WorkStage.allCases where target != stage {
            let item = moveMenu.addItem(withTitle: target.columnLabel.capitalized, action: #selector(moveToPressed(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = target.rawValue
        }
        let move = menu.addItem(withTitle: String(localized: "Move to"), action: nil, keyEquivalent: "").symbol(.moveStage)
        move.submenu = moveMenu
        // Hand off: a Message to the agent carrying the card (docs/SURFACES.md).
        // Offered for every agent, because which agent works a project is
        // Core's edge and not every project has said.
        // One Hand off to ▸ with the agents, as on a row.
        if !agents.isEmpty, !stage.isFinished {
            menu.addItem(.separator())
            let handOffMenu = NSMenu()
            for agent in agents {
                let item = handOffMenu.addItem(withTitle: agent.displayName, action: #selector(handOffPressed(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = agent.email
            }
            let handOff = menu.addItem(withTitle: String(localized: "Hand off to"), action: nil, keyEquivalent: "").symbol(.handOff)
            handOff.submenu = handOffMenu
        }
        // Delete: a task only; an issue is GitHub's to close.
        if card.task != nil {
            menu.addItem(.separator())
            let delete = menu.addItem(withTitle: TaskDeleteCopy.confirm, action: #selector(deletePressed), keyEquivalent: "").symbol(.delete)
            delete.target = self
        }
        return menu
    }

    @objc private func openPressed() { onSelect(card) }
    @objc private func deletePressed() { onDelete(card) }
    @objc private func openTracePressed() { onOpenTrace(card) }
    @objc private func openSubjectPressed() { if let subject = card.subject { onOpenSubject(subject) } }
    @objc private func openGitHubPressed() {
        if let issue = card.issue, let url = URL(string: issue.url) { NSWorkspace.shared.open(url) }
    }
    @objc private func moveToPressed(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let target = WorkStage(rawValue: raw) else { return }
        onMoveTo(card, target)
    }
    @objc private func handOffPressed(_ sender: NSMenuItem) {
        guard let email = sender.representedObject as? String,
              let agent = agents.first(where: { $0.email == email }) else { return }
        onHandOff(card, agent)
    }
}

/// A row that answers a click without being a button. The card underneath
/// selects on mouse-up; this one takes the click before it gets there.
private final class TraceRowView: NSView {
    private let onClick: () -> Void

    init(onClick: @escaping () -> Void) {
        self.onClick = onClick
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func mouseDown(with event: NSEvent) {}
    override func mouseUp(with event: NSEvent) { onClick() }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
}
