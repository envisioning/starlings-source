import AppKit

/// What one colleague owes and what you share with them.
///
/// The right column of a conversation. The middle column is the talk; this is
/// the reason for it — the IA decision was that a person surface is a work
/// surface with a message box, and this is the work half.
///
/// Ordered by the questions somebody actually asks, top down: can I reach them
/// right now, what is between us, what are we both on. A section that can only
/// be read and not acted on earns less space than one that can.
@MainActor
final class WorkPersonPanelView: NSView {
    /// What the panel needs beyond the roster row. Loaded once per person and
    /// handed in whole, so the view never waits on anything itself.
    struct Work: Equatable, Sendable {
        var theirs: [CrmMyTask] = []
        var theirsIssues: [CrmIssue] = []
        var mine: [CrmMyTask] = []
        var workLoading = false
        /// False when Core has no member at that address — an empty answer
        /// rather than a failure, and worth saying out loud so nobody reads it
        /// as "nothing to do".
        var matched = true
        var failed = false
        /// Today's Google free/busy, kept opaque and shared by all native
        /// surfaces. It starts loading when a person is opened.
        var todaySchedule: [PeerScheduleBlock] = []
        var calendarLoading = false
        var calendarUnavailable = false
        /// Why the day is not shown, when that is something to say.
        var calendarNote: String?

        /// Subjects you both have open work on. The intersection is the whole
        /// definition of "shared" that this surface can honestly claim: two
        /// people with tasks on one project are working together on it.
        var sharedSubjects: [(id: String, title: String, theirs: Int, mine: Int)] {
            let ours = Dictionary(grouping: mine.filter(Work.isOpen), by: subjectKey)
            let hers = Dictionary(grouping: theirs.filter(Work.isOpen), by: subjectKey)
            return hers.keys.compactMap { key -> (String, String, Int, Int)? in
                guard let key, let mineHere = ours[key], let theirsHere = hers[key] else { return nil }
                let title = theirsHere.first?.subjectTitle ?? mineHere.first?.subjectTitle ?? String(localized: "Untitled")
                return (key, title, theirsHere.count, mineHere.count)
            }
            .sorted { $0.2 + $0.3 > $1.2 + $1.3 }
            .map { (id: $0.0, title: $0.1, theirs: $0.2, mine: $0.3) }
        }

        private func subjectKey(_ task: CrmMyTask) -> String? {
            task.projectID ?? task.leadID ?? task.partnerOrganizationID
        }

        /// Still owed. Cancelled counts as finished: it is work nobody is
        /// waiting on, and listing it beside live work would inflate every
        /// count on this panel.
        static func isOpen(_ task: CrmMyTask) -> Bool {
            !task.status.isFinished
        }
    }

    /// Open a subject you share. The middle column already knows how.
    var onOpenSubject: ((String) -> Void)?
    var onOpenTask: ((CrmMyTask) -> Void)?
    var onOpenIssue: ((CrmIssue) -> Void)?
    var onNewTask: ((Peer) -> Void)?

    private let scroll = NSScrollView()
    private let stack = NSStackView()
    private var peer: Peer?
    private var work = Work()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        // A stack view spaces its arranged subviews with constraints of its
        // own; compression resistance on the stack does not reach them. This
        // is the knob that lets a CRM row clip instead of widening the pane.
        stack.setClippingResistancePriority(.defaultLow, for: .horizontal)

        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.borderType = .noBorder
        scroll.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let clip = PersonFlippedClipView()
        clip.drawsBackground = false
        scroll.contentView = clip
        scroll.documentView = stack
        scroll.translatesAutoresizingMaskIntoConstraints = false

        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: topAnchor, constant: 16),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -14),
            stack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// The person, drawn immediately. Work arrives separately and redraws only
    /// the sections that depend on it — nobody waits on Core to see who they
    /// are looking at.
    func show(_ peer: Peer, work: Work = Work()) {
        self.peer = peer
        self.work = work
        rebuild()
    }

    /// A fresher row for the person already on screen. Nothing happens for
    /// somebody else, or for a row that says the same thing — the roster is
    /// served from a ten-second cache, so most polls do.
    func update(_ peer: Peer) {
        guard let shown = self.peer, shown.email == peer.email, shown != peer else { return }
        self.peer = peer
        rebuild()
    }

    func setWork(_ work: Work) {
        self.work = Work(
            theirs: work.theirs,
            theirsIssues: work.theirsIssues,
            mine: work.mine,
            workLoading: work.workLoading,
            matched: work.matched,
            failed: work.failed,
            todaySchedule: self.work.todaySchedule,
            calendarLoading: self.work.calendarLoading,
            calendarUnavailable: self.work.calendarUnavailable,
            calendarNote: self.work.calendarNote
        )
        rebuild()
    }

    func setCalendar(schedule: [PeerScheduleBlock], unavailable: Bool = false, note: String? = nil) {
        work.todaySchedule = schedule
        work.calendarLoading = false
        work.calendarUnavailable = unavailable
        work.calendarNote = note
        rebuild()
    }

    private func rebuild() {
        scroll.preservingScrollOffset { rebuildBlocks() }
    }

    private func rebuildBlocks() {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        guard let peer else { return }

        add(identityBlock(peer))
        // An agent has no reachability to report and owes nothing in the CRM. A
        // manifest fills that space with what it says it is and can do, drawn
        // read-only as its own words — never markup, never an instruction. An
        // agent that serves none keeps today's near-empty panel.
        if peer.isAgent {
            // Counted by the Worker, not claimed by the runtime — the one
            // block here that is Meet's own knowledge of the agent, so it
            // comes first.
            if let activity = peer.activity {
                add(section(String(localized: "ACTIVITY"), lines: activity.lines))
            }
            if let manifest = peer.manifest {
                add(section("ABOUT", lines: [manifest.description]
                    + (manifest.model.map { ["Runs on \($0)"] } ?? [])
                    + (manifest.buildLine.map { [$0] } ?? [])))
                if !manifest.skills.isEmpty {
                    add(tileSection(String(localized: "WHAT IT CAN DO"), entries: manifest.skills.map { ($0.name, $0.description) }))
                }
                if !manifest.tools.isEmpty {
                    add(tileSection("TOOLS", entries: manifest.tools.map { ($0.requiresApproval ? "\($0.name) (asks first)" : $0.name, $0.description) }))
                }
                if !manifest.connections.isEmpty {
                    add(section(String(localized: "CONNECTIONS"), lines: manifest.connections.map(\.line)))
                }
                if !manifest.docs.isEmpty {
                    add(docsBlock(manifest.docs))
                }
                if !manifest.schedules.isEmpty {
                    add(section(String(localized: "SCHEDULES"), lines: manifest.schedules.map(\.line)))
                }
                if !manifest.keys.isEmpty {
                    add(keysBlock(manifest.keys))
                }
                if !manifest.links.isEmpty {
                    add(linksBlock(manifest.links))
                }
            }
            return
        }
        add(reachabilityBlock(peer))
        if !peer.isSelf {
            add(todayScheduleBlock())
        }
        add(assignedWorkBlock(peer))
        add(sharedBlock())
    }

    private func add(_ view: NSView) {
        view.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(view)
        view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }

    // MARK: - Blocks

    /// The runtime's environment keys as label chips — names and set/missing,
    /// never a value. A red chip here is the usual answer to "why is it not
    /// responding", which is why it is drawn rather than left to a log. One
    /// chip per line, a set key in the accent: a flowed row of near-identical
    /// green chips is read as one blob, and the missing one hides in it.
    private func keysBlock(_ keys: [AgentManifestKey]) -> NSView {
        let missing = keys.filter { !$0.set }.count
        let title = missing == 0
            ? String(localized: "KEYS")
            : String(localized: "KEYS · \(missing) MISSING")
        let header = sectionLabel(title)
        let chips = NSStackView(views: keys.map { StarlingsLabelChip($0.chip, ground: StarlingsColors.panel) })
        chips.orientation = .vertical
        chips.alignment = .leading
        chips.spacing = 4
        chips.setAccessibilityLabel(missing == 0
            ? String(localized: "\(keys.count) keys, all set")
            : String(localized: "\(keys.count) keys, \(missing) missing"))
        let column = NSStackView(views: [header, chips])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 6
        column.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for view in [header, chips] {
            view.translatesAutoresizingMaskIntoConstraints = false
            view.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        }
        return column
    }

    /// The house documents the runtime reads before it works, in its own
    /// words. A required doc — the VOICE.md a writer obeys on every job — is
    /// marked and listed first; each entry links out to read and to edit it,
    /// so "which rules did this follow, and where do I change them" is
    /// answered here.
    private func docsBlock(_ docs: [AgentManifestDoc]) -> NSView {
        var views: [NSView] = [sectionLabel(String(localized: "DOCS"))]
        let ordered = docs.filter(\.required) + docs.filter { !$0.required }
        for doc in ordered {
            var line = doc.displayTitle
            if doc.required { line += " · " + String(localized: "read on every job") }
            if let description = doc.description { line += " — \(description)" }
            let label = StarlingsTypography.wrappingLabel(line)
            label.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
            label.textColor = StarlingsColors.primaryText
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            views.append(label)
            if let source = doc.source {
                let sourceLabel = StarlingsTypography.wrappingLabel(source)
                sourceLabel.font = .monospacedSystemFont(ofSize: StarlingsTypography.scaled(11), weight: .regular)
                sourceLabel.textColor = StarlingsColors.secondaryText
                sourceLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
                views.append(sourceLabel)
            }
            var buttons: [NSView] = []
            if let view = doc.view {
                buttons.append(action(String(localized: "Read")) { NSWorkspace.shared.open(view) })
            }
            if let edit = doc.edit {
                buttons.append(action(String(localized: "Edit")) { NSWorkspace.shared.open(edit) })
            }
            if !buttons.isEmpty {
                let row = NSStackView(views: buttons)
                row.orientation = .horizontal
                row.spacing = 6
                views.append(row)
            }
        }
        let column = NSStackView(views: views)
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 4
        column.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for view in views {
            view.translatesAutoresizingMaskIntoConstraints = false
            if !(view is NSStackView) {
                view.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
            }
        }
        return column
    }

    private func identityBlock(_ peer: Peer) -> NSView {
        let avatar = StarlingsPersonAvatarView(
            identity: StarlingsAvatarIdentity(peer: peer),
            diameter: 44,
            status: peer.isAgent ? nil : peer.displayState.dot
        )
        avatar.translatesAutoresizingMaskIntoConstraints = false

        let name = NSTextField(labelWithString: peer.displayName)
        name.font = .systemFont(ofSize: StarlingsTypography.scaled(15), weight: .semibold)
        name.textColor = StarlingsColors.primaryText
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        // Title and pronouns are the two things a colleague already knows about
        // a colleague, and the two the roster row has never had space for.
        var second: [String] = []
        if let title = peer.title, !title.isEmpty { second.append(title) }
        if let pronouns = peer.pronouns, !pronouns.isEmpty { second.append(pronouns) }
        let detail = NSTextField(labelWithString: second.isEmpty ? peer.email : second.joined(separator: " · "))
        detail.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        detail.textColor = StarlingsColors.secondaryText
        detail.lineBreakMode = .byTruncatingTail
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let text = NSStackView(views: [name, detail])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 2
        text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let row = NSStackView(views: [avatar, text])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        row.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return row
    }

    /// Can I reach them right now — and *should* I. The clock is the field that
    /// changes the answer: "Available" and "Available, 23:10 their time" are
    /// the same status and opposite advice.
    private func reachabilityBlock(_ peer: Peer) -> NSView {
        var lines: [String] = [peer.displayState.label]
        if !peer.clients.isEmpty {
            lines.append(peer.devicesLine)
        }
        if let clock = peer.localTimeDescription {
            switch peer.isWithinWorkingHours {
            case true?: lines.append("\(clock) their time")
            case false?: lines.append("\(clock) their time · outside their hours")
            // Nobody has said when they work, which is silence rather than a
            // reason to discourage anybody from reaching them.
            case nil: lines.append("\(clock) their time")
            }
        }
        if let seen = peer.lastSeenDescription, peer.status == .offline {
            lines.append("Last seen \(seen)")
        }

        let body = section(String(localized: "REACHING THEM"), lines: lines)
        return body
    }

    /// The open work assigned to this person. Tasks and issues are deliberately
    /// one block: they are two systems answering the same question, and the
    /// person inspector should not make somebody visit Work to discover one
    /// half of the answer.
    private func assignedWorkBlock(_ peer: Peer) -> NSView {
        var views: [NSView] = [assignedWorkHeader()]
        if work.workLoading {
            views.append(contentsOf: placeholderLines())
            return verticalColumn(views)
        }
        if work.failed {
            views.append(contentsOf: plainLines(["Couldn’t reach the CRM."]))
            return verticalColumn(views)
        }
        if !work.matched {
            // An empty answer, not an empty plate. Saying "nothing open" here
            // would be a claim nobody checked.
            views.append(contentsOf: plainLines(["\(peer.shortName) has no record in the CRM."]))
            return verticalColumn(views)
        }

        let planned = WorkItems.planMine(tasks: work.theirs, issues: work.theirsIssues).order
        guard !planned.isEmpty else {
            views.append(contentsOf: plainLines(["Nothing open for \(peer.shortName)."]))
            return verticalColumn(views)
        }

        views += planned.prefix(8).compactMap { item -> NSView? in
            switch item {
            case .task(let task): taskRow(task)
            case .issue(let issue): issueRow(issue)
            case .subjectTask: nil
            }
        }
        if planned.count > 8 {
            views.append(contentsOf: plainLines([String(localized: "\(planned.count - 8) more")]))
        }

        return verticalColumn(views)
    }

    private func todayScheduleBlock() -> NSView {
        if work.calendarLoading {
            return placeholderSection(String(localized: "TODAY’S SCHEDULE"), glyph: false)
        }
        if work.calendarUnavailable {
            return section(String(localized: "TODAY’S SCHEDULE"), lines: [work.calendarNote ?? PeerScheduleNote.unreadable("")])
        }
        let lines = work.todaySchedule.map { block in
            "\(scheduleTime(block.start))–\(scheduleTime(block.end)) · \(block.kind.label)"
        }
        return section(String(localized: "TODAY’S SCHEDULE"), lines: lines.isEmpty ? ["No schedule available."] : lines)
    }

    private func scheduleTime(_ date: Date) -> String {
        let calendar = Calendar.current
        let dayEnd = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: Date()))
        if date == dayEnd { return "24:00" }
        return date.meetTimeString()
    }

    private func assignedWorkHeader() -> NSView {
        let title = sectionLabel(String(localized: "BETWEEN US"))
        let create = NSButton(title: String(localized: "New task"), target: self, action: #selector(newTaskPressed))
        create.bezelStyle = .inline
        create.controlSize = .small
        create.image = NSImage(systemSymbolName: "plus", accessibilityDescription: nil)
        create.imagePosition = .imageLeading
        create.applyMeetHoverLift(cornerRadius: StarlingsRadius.control(height: 24))
        create.setAccessibilityLabel(String(localized: "New task"))
        create.isEnabled = peer.map { !$0.isAgent && !$0.isSelf } == true

        let row = NSStackView(views: [title, NSView(), create])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        row.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return row
    }

    @objc private func newTaskPressed() {
        guard let peer, !peer.isAgent, !peer.isSelf else { return }
        onNewTask?(peer)
    }

    private func taskRow(_ task: CrmMyTask) -> NSView {
        var parts = [task.status.menuTitle]
        if let due = CrmTaskDate.date(task.dueDate) {
            parts.append(StarlingsDateFormatting.date(due))
            if task.isOverdue { parts.append(String(localized: "Late")) }
        }
        if let subject = task.subjectTitle { parts.append(subject) }
        return workRow(
            title: task.title,
            detail: parts.joined(separator: " · "),
            symbol: "checklist",
            onActivate: { [weak self] in self?.onOpenTask?(task) }
        )
    }

    private func issueRow(_ issue: CrmIssue) -> NSView {
        return workRow(
            title: issue.title,
            detail: issueDetail(issue),
            symbol: "number",
            onActivate: { [weak self] in self?.onOpenIssue?(issue) }
        )
    }

    private func workRow(title: String, detail: String, symbol: String, onActivate: @escaping () -> Void) -> NSView {
        let image = NSImageView(image: NSImage(systemSymbolName: symbol, accessibilityDescription: nil) ?? NSImage())
        image.contentTintColor = StarlingsColors.secondaryText
        image.imageScaling = .scaleProportionallyDown
        image.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            image.widthAnchor.constraint(equalToConstant: 16),
            image.heightAnchor.constraint(equalToConstant: 16),
        ])

        let titleLabel = StarlingsTypography.wrappingLabel(title)
        titleLabel.font = WorkListRowView.titleFont()
        titleLabel.textColor = StarlingsColors.primaryText
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let detailLabel = StarlingsTypography.wrappingLabel(detail)
        detailLabel.font = WorkListRowView.detailFont()
        detailLabel.textColor = StarlingsColors.secondaryText
        detailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let text = NSStackView(views: [titleLabel, detailLabel])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = WorkListRowView.textSpacing
        text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        return WorkListRowView(
            content: WorkListRowView.content(leading: image, text: text),
            isSelected: false,
            accessibilityLabel: "\(title), \(detail)",
            height: 62,
            onActivate: onActivate
        )
    }

    private func verticalColumn(_ views: [NSView]) -> NSView {
        let column = NSStackView(views: views)
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 4
        column.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for view in views {
            view.translatesAutoresizingMaskIntoConstraints = false
            view.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        }
        return column
    }

    private func plainLines(_ lines: [String]) -> [NSView] {
        lines.map { line in
            let label = StarlingsTypography.wrappingLabel(line)
            label.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
            label.textColor = StarlingsColors.primaryText
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            return label
        }
    }

    private func placeholderLines() -> [NSView] {
        StarlingsPlaceholderRowView.rows(2, glyph: false)
    }

    private func issueDetail(_ issue: CrmIssue) -> String {
        let labels = issue.labels.prefix(2).joined(separator: ", ")
        return ["\(issue.repo) \(issue.shortReference)", labels.isEmpty ? nil : labels]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    /// What you are both on. Clickable, because the point of naming a shared
    /// project beside a conversation is going to it.
    private func sharedBlock() -> NSView {
        let shared = work.sharedSubjects
        guard !shared.isEmpty else {
            return section(String(localized: "SHARED WORK"), lines: [String(localized: "No open work in common.")])
        }

        var views: [NSView] = [sectionLabel(String(localized: "SHARED WORK"))]
        for subject in shared.prefix(6) {
            let button = NSButton(
                title: "\(subject.title)  ·  them \(subject.theirs), you \(subject.mine)",
                target: self,
                action: #selector(subjectTapped(_:))
            )
            button.bezelStyle = .inline
            button.controlSize = .small
            button.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            button.alignment = .left
            button.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            button.identifier = NSUserInterfaceItemIdentifier(subject.id)
            views.append(button)
        }
        let column = NSStackView(views: views)
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 4
        column.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for view in views {
            view.translatesAutoresizingMaskIntoConstraints = false
            view.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        }
        return column
    }

    /// Which manifest tiles are unfolded, by name. Kept on the panel because
    /// `rebuild()` throws the views away on every roster tick.
    private var unfoldedManifestTiles: Set<String> = []

    /// Skills and tools are tiles, not lines: a name on the Home row shell
    /// (docs/DESIGN.md) that unfolds to its description on a click, so a
    /// list of ten reads as ten names first.
    private func tileSection(_ title: String, entries: [(name: String, detail: String?)]) -> NSView {
        var views: [NSView] = [sectionLabel(title)]
        for entry in entries {
            let tile = AgentManifestTileView(
                name: entry.name,
                detail: entry.detail,
                unfolded: unfoldedManifestTiles.contains(entry.name)
            )
            tile.onToggle = { [weak self] open in
                if open { self?.unfoldedManifestTiles.insert(entry.name) } else { self?.unfoldedManifestTiles.remove(entry.name) }
            }
            views.append(tile)
        }
        let column = NSStackView(views: views)
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 6
        column.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for view in views {
            view.translatesAutoresizingMaskIntoConstraints = false
            view.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        }
        return column
    }

    /// The manifest's links out — home, readme, repo. Clamped http(s) URLs
    /// from the contract, opened in the browser.
    private func linksBlock(_ links: [AgentManifestLink]) -> NSView {
        var views: [NSView] = [sectionLabel("LINKS")]
        let row = NSStackView(views: links.map { link in
            action(link.title) { NSWorkspace.shared.open(link.url) }
        })
        row.orientation = .horizontal
        row.spacing = 6
        views.append(row)
        let column = NSStackView(views: views)
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 4
        column.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for view in views {
            view.translatesAutoresizingMaskIntoConstraints = false
        }
        return column
    }

    @objc private func subjectTapped(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        onOpenSubject?(id)
    }

    // MARK: - Pieces

    private func sectionLabel(_ title: String) -> NSTextField {
        let label = NSTextField(labelWithString: title)
        StarlingsTypography.applySectionLabel(label)
        // This panel lives in a resizable inspector. A heading's intrinsic
        // width must not become the minimum width of the Team window.
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return label
    }

    private func section(_ title: String, lines: [String]) -> NSView {
        section(title, views: lines.map { line in
            let label = StarlingsTypography.wrappingLabel(line)
            label.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
            label.textColor = StarlingsColors.primaryText
            // Long presence/email text wraps inside the inspector instead of
            // asking NSSplitViewController to grow the outer window.
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            return label
        })
    }

    /// The section's title over placeholder rows while its answer is out.
    private func placeholderSection(_ title: String, glyph: Bool = true) -> NSView {
        section(title, views: StarlingsPlaceholderRowView.rows(2, glyph: glyph))
    }

    private func section(_ title: String, views body: [NSView]) -> NSView {
        let views: [NSView] = [sectionLabel(title)] + body
        let column = NSStackView(views: views)
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 3
        column.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        // The section is later given the full inspector width by `add(_:)`.
        // Keep every line tied to that width so its wrapping constraint is
        // real during the split view's minimum-size calculation as well.
        for view in views {
            view.translatesAutoresizingMaskIntoConstraints = false
            view.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        }
        return column
    }

    private func action(
        _ title: String,
        symbolName: String? = nil,
        accessibilityLabel: String? = nil,
        run: @escaping () -> Void
    ) -> NSButton {
        let button = NSButton(title: title, target: nil, action: nil)
        SettingsChrome.applySecondaryButton(button, title: title, symbolName: symbolName, height: 26)
        button.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        if symbolName != nil {
            button.imagePosition = .imageOnly
            button.widthAnchor.constraint(equalToConstant: 26).isActive = true
        }
        if let accessibilityLabel {
            button.setAccessibilityLabel(accessibilityLabel)
            button.toolTip = accessibilityLabel
        }
        button.target = ActionProxy.shared
        button.action = #selector(ActionProxy.fire(_:))
        ActionProxy.shared.register(button, run: run)
        return button
    }
}

/// One manifest skill or tool on the Home row shell: the name and a chevron,
/// and the description under them once unfolded. A click anywhere on the
/// tile toggles it. Shared by the inspector and the thread's agent card.
@MainActor
final class AgentManifestTileView: NSView {
    var onToggle: ((Bool) -> Void)?

    private let chevron = NSImageView()
    private let body: NSTextField?
    private var unfolded: Bool

    init(name: String, detail: String?, unfolded: Bool) {
        self.unfolded = unfolded
        if let detail {
            let label = StarlingsTypography.wrappingLabel(detail)
            label.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
            label.textColor = StarlingsColors.secondaryText
            body = label
        } else {
            body = nil
        }
        super.init(frame: .zero)
        SettingsChrome.applyHomeRow(self, interactive: body != nil)

        let title = StarlingsTypography.wrappingLabel(name)
        title.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold)
        title.textColor = StarlingsColors.primaryText
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        chevron.image = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil)
        chevron.symbolConfiguration = .init(pointSize: 10, weight: .semibold)
        chevron.contentTintColor = StarlingsColors.secondaryText
        chevron.isHidden = body == nil
        chevron.setContentHuggingPriority(.required, for: .horizontal)
        chevron.setContentCompressionResistancePriority(.required, for: .horizontal)

        let head = NSStackView(views: [title, chevron])
        head.orientation = .horizontal
        head.alignment = .firstBaseline
        head.spacing = 8
        head.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        var lines: [NSView] = [head]
        if let body { lines.append(body) }
        let column = NSStackView(views: lines)
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 4
        column.translatesAutoresizingMaskIntoConstraints = false
        for line in lines {
            line.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            line.translatesAutoresizingMaskIntoConstraints = false
            line.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        }
        addSubview(column)
        let inset = SettingsChrome.homeRowInset
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: leadingAnchor, constant: inset.left),
            column.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -inset.right),
            column.topAnchor.constraint(equalTo: topAnchor, constant: inset.top),
            column.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -inset.bottom),
        ])
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        if body != nil {
            addGestureRecognizer(NSClickGestureRecognizer(target: self, action: #selector(toggle)))
            setAccessibilityElement(true)
            setAccessibilityRole(.disclosureTriangle)
            setAccessibilityLabel(name)
        }
        apply()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    @objc private func toggle() {
        unfolded.toggle()
        apply()
        onToggle?(unfolded)
    }

    private func apply() {
        body?.isHidden = !unfolded
        chevron.image = NSImage(
            systemSymbolName: unfolded ? "chevron.down" : "chevron.right",
            accessibilityDescription: nil
        )
        setAccessibilityValue(unfolded ? "expanded" : "collapsed")
    }
}

/// Buttons built in a loop need somewhere for their closure to live. One proxy
/// rather than a subclass per button, keyed weakly so a rebuilt panel does not
/// keep the old rows alive.
@MainActor
private final class ActionProxy: NSObject {
    static let shared = ActionProxy()
    private let table = NSMapTable<NSButton, ActionBox>.weakToStrongObjects()

    func register(_ button: NSButton, run: @escaping () -> Void) {
        table.setObject(ActionBox(run: run), forKey: button)
    }

    @objc func fire(_ sender: NSButton) {
        table.object(forKey: sender)?.run()
    }
}

private final class ActionBox: NSObject {
    let run: () -> Void
    init(run: @escaping () -> Void) { self.run = run }
}

private final class PersonFlippedClipView: NSClipView {
    override var isFlipped: Bool { true }
}
