import AppKit

/// Calendar's sidebar: the same rail of foldable blocks Work and the meeting
/// window carry, filled with Calendar's three. MONTH is the way to move,
/// AGENDA is what you actually read, CALENDARS is triage you do occasionally
/// — which is why it ships folded, where Events used to be the default face
/// of a two-faced control. The calendar new events land on stays pinned
/// under all three, in both states, so it is never a surprise where
/// something was just created.
@MainActor
final class CalendarSidebarView: NSView {
    var onToggle: ((String, Bool) -> Void)?
    /// Switch a whole account off — the one move that answers the same Google
    /// account arriving twice, once over OAuth and once through macOS Calendar.
    var onToggleAccount: ((String, Bool) -> Void)?
    var onSetWriteCalendar: ((String) -> Void)?
    var onRequestEventKit: (() -> Void)?
    var onSelectEvent: ((String) -> Void)?
    /// Show or hide a company layer. A view preference, not a subscription.
    var onToggleLayer: ((CalendarLayerKind, Bool) -> Void)?
    var isLayerHidden: ((CalendarLayerKind) -> Bool) = { _ in false }
    var onActivateEvent: ((StarlingsCalendarEvent) -> Void)?
    /// Remove an extra Google account, by the id `removableAccounts` gave it.
    var onRemoveGoogleAccount: ((String) -> Void)?
    /// Remove a subscribed feed, by calendar id.
    var onRemoveSubscription: ((String) -> Void)?

    let miniMonth: CalendarMiniMonthView
    let agenda: CalendarAgendaListView

    private enum SectionKey {
        static let month = "calendar.month"
        static let agenda = "calendar.agenda"
        static let calendars = "calendar.calendars"
        static let envisioning = "calendar.envisioning"
    }

    private let monthSection: SidebarSection
    private let agendaSection: SidebarSection
    private let calendarsSection: SidebarSection
    private let calendarsStack = NSStackView()
    private let calendarsScroll: NSScrollView
    /// The company's rows, in a fold of their own (asked for 2026-09-13):
    /// the editable Envisioning calendar and Core's read-only layers. Short
    /// enough to stand without a scroll view; the accounts above scroll.
    private let envisioningSection: SidebarSection
    private let envisioningStack: NSStackView
    /// AGENDA and CALENDARS both scroll, and neither has a height of its own.
    /// While both are open they halve what the rail has left; fold one and
    /// the other takes it all. Removing a folded body from the hierarchy
    /// takes this constraint with it, so every fold puts it back.
    private var equalSplit: NSLayoutConstraint?
    private let writeCalendarSwatch = NSView()
    private let writeCalendarLabel = NSTextField(labelWithString: String(localized: "No calendar selected"))
    private let writeCalendarButton = NSButton()
    private var calendars: [StarlingsCalendar] = []
    private var writeCalendarID: String?
    private var hiddenAccounts: Set<String> = []
    /// Group title → account id, for the extra Google accounts that can be
    /// removed. The owner's own account is never in here.
    private var removableAccounts: [String: String] = [:]
    /// What the source list last drew, for the same reason the agenda keeps
    /// one: a load renders several times and the calendars rarely differ
    /// between them, so rebuilding every row each time is only flicker.
    private var renderedSignature: Int?

    override init(frame frameRect: NSRect) {
        MeetingSidebarFoldPreferences.registerDefaultCollapsed([SectionKey.calendars])

        // The bodies are built before the sections that hold them, and the
        // sections before `self` exists — hence locals first.
        let miniMonth = CalendarMiniMonthView()
        let agenda = CalendarAgendaListView()
        let calendarsScroll = NSScrollView()
        self.miniMonth = miniMonth
        self.agenda = agenda
        self.calendarsScroll = calendarsScroll
        monthSection = SidebarSection(title: String(localized: "MONTH"), key: SectionKey.month, body: [miniMonth])
        agendaSection = SidebarSection(title: String(localized: "AGENDA"), key: SectionKey.agenda, body: [agenda])
        calendarsSection = SidebarSection(
            title: String(localized: "CALENDARS"), key: SectionKey.calendars, body: [calendarsScroll]
        )
        let envisioningStack = NSStackView()
        self.envisioningStack = envisioningStack
        envisioningSection = SidebarSection(
            title: StarlingsWorkspace.active.name.uppercased(), key: SectionKey.envisioning, body: [envisioningStack]
        )
        super.init(frame: frameRect)

        envisioningStack.orientation = .vertical
        envisioningStack.alignment = .leading
        envisioningStack.spacing = Metrics.rowGap
        envisioningStack.translatesAutoresizingMaskIntoConstraints = false

        miniMonth.translatesAutoresizingMaskIntoConstraints = false
        agenda.translatesAutoresizingMaskIntoConstraints = false

        calendarsStack.orientation = .vertical
        calendarsStack.alignment = .leading
        calendarsStack.spacing = Metrics.rowGap
        calendarsStack.translatesAutoresizingMaskIntoConstraints = false
        calendarsScroll.drawsBackground = false
        calendarsScroll.hasVerticalScroller = true
        calendarsScroll.borderType = .noBorder
        calendarsScroll.translatesAutoresizingMaskIntoConstraints = false
        let clip = SidebarFlippedClipView()
        clip.drawsBackground = false
        calendarsScroll.contentView = clip
        calendarsScroll.documentView = calendarsStack

        // Absorbs the rail when every scrolling block is folded, so the
        // footer stays at the foot instead of the folded headers spreading
        // out to fill the gap. Zero whenever anything else can take it.
        let slack = NSView()
        let slackHeight = slack.heightAnchor.constraint(equalToConstant: 0)
        slackHeight.priority = .defaultHigh
        slackHeight.isActive = true

        let footer = makeWriteCalendarFooter()
        let column = NSStackView(views: [monthSection, agendaSection, calendarsSection, envisioningSection, slack, footer])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 14
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)

        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: topAnchor),
            column.leadingAnchor.constraint(equalTo: leadingAnchor),
            column.trailingAnchor.constraint(equalTo: trailingAnchor),
            column.bottomAnchor.constraint(equalTo: bottomAnchor),
            monthSection.widthAnchor.constraint(equalTo: column.widthAnchor),
            agendaSection.widthAnchor.constraint(equalTo: column.widthAnchor),
            calendarsSection.widthAnchor.constraint(equalTo: column.widthAnchor),
            envisioningSection.widthAnchor.constraint(equalTo: column.widthAnchor),
            envisioningStack.widthAnchor.constraint(equalTo: envisioningSection.widthAnchor),
            slack.widthAnchor.constraint(equalTo: column.widthAnchor),
            footer.widthAnchor.constraint(equalTo: column.widthAnchor),
            calendarsStack.widthAnchor.constraint(equalTo: calendarsScroll.contentView.widthAnchor),
        ])
        for section in [monthSection, agendaSection, calendarsSection, envisioningSection] {
            section.onFoldChange = { [weak self] in self?.applySplit() }
        }
        applySplit()

        agenda.onSelect = { [weak self] id in self?.onSelectEvent?(id) }
        agenda.onActivate = { [weak self] event in self?.onActivateEvent?(event) }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Halve the rail between the two scrolling blocks while both are open.
    /// Below the fold's own `required`, so a rail with room for only one of
    /// them still lays out rather than reporting a conflict.
    private func applySplit() {
        guard agenda.isDescendant(of: self), calendarsScroll.isDescendant(of: self) else { return }
        if equalSplit == nil {
            let split = agenda.heightAnchor.constraint(equalTo: calendarsScroll.heightAnchor)
            split.priority = .defaultHigh
            equalSplit = split
        }
        equalSplit?.isActive = true
    }

    func render(
        calendars: [StarlingsCalendar],
        hiddenIDs: Set<String>,
        hiddenAccounts: Set<String>,
        removableAccounts: [String: String],
        writeCalendarID: String?,
        eventKitAccess: EventKitCalendarStore.Access
    ) {
        var hasher = Hasher()
        for calendar in calendars {
            hasher.combine(calendar.id)
            hasher.combine(calendar.title)
            hasher.combine(calendar.groupTitle)
            hasher.combine(calendar.isWritable)
            hasher.combine(calendar.role.rawValue)
            hasher.combine(hiddenIDs.contains(calendar.id))
        }
        hasher.combine(hiddenAccounts.sorted())
        hasher.combine(removableAccounts.keys.sorted())
        hasher.combine(writeCalendarID)
        hasher.combine(String(describing: eventKitAccess))
        for kind in CalendarLayerKind.allCases { hasher.combine(isLayerHidden(kind)) }
        let signature = hasher.finalize()

        self.calendars = calendars
        self.writeCalendarID = writeCalendarID
        self.hiddenAccounts = hiddenAccounts
        self.removableAccounts = removableAccounts
        guard signature != renderedSignature else {
            // Colours and titles are unchanged, but the write target's label
            // is the one thing here that reads from `calendars` after the fact.
            renderWriteCalendar(writeCalendarID)
            return
        }
        renderedSignature = signature
        let origin = calendarsScroll.contentView.bounds.origin
        calendarsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        // Groups are real account names now, so they cannot be a fixed list.
        let groups = Dictionary(grouping: calendars, by: \.groupTitle)
        for group in StarlingsCalendar.orderedGroups(of: calendars) where groups[group] != nil {
            addSectionHeader(
                group,
                account: (group, hiddenAccounts.contains(group)),
                removableAccountID: removableAccounts[group]
            )
            for calendar in groups[group] ?? [] where calendar.role == .ordinary {
                calendarsStack.addArrangedSubview(row(
                    for: calendar,
                    hidden: hiddenIDs.contains(calendar.id),
                    isWriteTarget: calendar.id == writeCalendarID
                ))
            }
        }

        if eventKitAccess != .granted {
            calendarsStack.addArrangedSubview(actionRow(
                title: eventKitAccess == .denied ? String(localized: "iCloud access denied in System Settings") : String(localized: "Show iCloud calendars…"),
                action: #selector(requestEventKit)
            ))
        }

        renderCompanyRows(
            calendars.filter { $0.role == .globalInterest },
            hiddenIDs: hiddenIDs,
            writeCalendarID: writeCalendarID
        )
        renderWriteCalendar(writeCalendarID)
        layoutSubtreeIfNeeded()
        calendarsScroll.contentView.scroll(to: origin)
        calendarsScroll.reflectScrolledClipView(calendarsScroll.contentView)
    }

    /// Company rows, in the ENVISIONING fold: the editable internal calendar
    /// and Core's read-only layers. The section title names whose rows these
    /// are, so there is no heading inside the fold; the marks still separate
    /// them, the brand glyph on the calendar you can write to and a kind
    /// glyph on the rows Core owns. What the old footnotes said lives in the
    /// tooltips, where it answers the one row you are asking about.
    private func renderCompanyRows(
        _ globalInterest: [StarlingsCalendar],
        hiddenIDs: Set<String>,
        writeCalendarID: String?
    ) {
        envisioningStack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        for calendar in globalInterest {
            envisioningStack.addArrangedSubview(row(
                for: calendar,
                hidden: hiddenIDs.contains(calendar.id),
                isWriteTarget: calendar.id == writeCalendarID
            ))
        }

        // The fold is the workspace's name, and it holds rows only where they
        // exist: the layers are Core's (#1187).
        let hasLayers = StarlingsWorkspace.active.has(.core)
        envisioningSection.isHidden = globalInterest.isEmpty && !hasLayers
        guard hasLayers else { return }
        for kind in CalendarLayerKind.allCases {
            let glyph = NSImageView()
            glyph.image = NSImage(systemSymbolName: kind.symbolName, accessibilityDescription: kind.title)?
                .withSymbolConfiguration(.init(pointSize: 11, weight: .semibold))
            glyph.contentTintColor = kind.color.nsColor
            glyph.imageScaling = .scaleProportionallyDown

            let checkbox = NSButton(
                checkboxWithTitle: Self.listTitle(kind.title),
                target: self,
                action: #selector(layerToggled(_:))
            )
            checkbox.state = isLayerHidden(kind) ? .off : .on
            checkbox.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
            checkbox.applyMeetCheckboxStyle()
            checkbox.identifier = NSUserInterfaceItemIdentifier(kind.rawValue)
            checkbox.lineBreakMode = .byTruncatingTail

            let row = NSStackView(views: [mark(glyph), checkbox])
            row.orientation = .horizontal
            row.alignment = .centerY
            row.spacing = Metrics.markGap
            checkbox.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            envisioningStack.addArrangedSubview(pinRowHeight(row))
        }
    }

    /// Nothing stands over this block naming the workspace any more, so the
    /// rows stop repeating it: `Envisioning Internal` reads as `Internal`,
    /// `Envisioning events` as `Events`. The full name stays in the tooltip.
    private static func listTitle(_ title: String) -> String {
        let prefix = "\(StarlingsWorkspace.active.name) "
        guard title.count > prefix.count,
              title.lowercased().hasPrefix(prefix.lowercased()) else { return title }
        let rest = title.dropFirst(prefix.count)
        return rest.prefix(1).uppercased() + rest.dropFirst()
    }

    /// One heading, one rhythm. Uppercase monospace is the rail header this app
    /// already uses everywhere else, and the gap above it is what turns a flat
    /// run of seventeen checkboxes into sections you can count.
    private func addSectionHeader(
        _ title: String,
        account: (group: String, hidden: Bool)? = nil,
        removableAccountID: String? = nil
    ) {
        let label = StarlingsTypography.sectionLabel(title.uppercased())
        label.lineBreakMode = .byTruncatingTail
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let header: NSView
        // The account row's eye button only sits at the trailing edge if the
        // header spans the list — but that constraint crosses into the stack,
        // so it can only be made once the header is *in* the stack. Activating
        // it here, before the header has a superview, throws.
        var spansWidth = false
        if let account {
            var marks: [NSView] = [label, NSView(), accountButton(for: account)]
            if let removableAccountID {
                marks.append(removeAccountButton(id: removableAccountID, group: account.group))
            }
            let stack = NSStackView(views: marks)
            stack.orientation = .horizontal
            stack.alignment = .centerY
            stack.spacing = Metrics.markGap
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            spansWidth = true
            header = stack
        } else {
            header = label
        }

        if let previous = calendarsStack.arrangedSubviews.last {
            calendarsStack.setCustomSpacing(Metrics.sectionGap, after: previous)
        }
        calendarsStack.addArrangedSubview(header)
        if spansWidth {
            header.widthAnchor.constraint(equalTo: calendarsStack.widthAnchor).isActive = true
        }
        calendarsStack.setCustomSpacing(Metrics.headerGap, after: header)
    }

    /// One account off in one click. Drawn as an eye rather than a checkbox so
    /// it cannot be misread as a calendar of its own — and left dim until the
    /// account is actually muted, because on a well-behaved list this is a
    /// control nobody needs to see.
    private func accountButton(for account: (group: String, hidden: Bool)) -> NSButton {
        let button = NSButton(title: "", target: self, action: #selector(accountToggled(_:)))
        button.bezelStyle = .inline
        button.isBordered = false
        button.identifier = NSUserInterfaceItemIdentifier(account.group)
        let symbol = account.hidden ? "eye.slash" : "eye"
        if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: String(localized: "Show or hide this account")) {
            button.image = image.withSymbolConfiguration(.init(pointSize: 10, weight: .medium))
            button.imagePosition = .imageOnly
        }
        button.contentTintColor = account.hidden ? StarlingsColors.primaryText : StarlingsColors.secondaryText
        button.alphaValue = account.hidden ? 1 : 0.45
        button.toolTip = account.hidden
            ? String(localized: "Show every calendar in \(account.group)")
            : "Hide every calendar in \(account.group)"
        SettingsChrome.applyQuietButton(button)
        button.widthAnchor.constraint(equalToConstant: 22).isActive = true
        button.heightAnchor.constraint(equalToConstant: 16).isActive = true
        return button
    }

    /// Removing an extra Google account only from a header that names one —
    /// the owner's own account has no such button, since removing it is
    /// disconnecting Calendar, not dropping an address.
    private func removeAccountButton(id: String, group: String) -> NSButton {
        let button = NSButton(title: "", target: self, action: #selector(removeAccountTapped(_:)))
        button.bezelStyle = .inline
        button.isBordered = false
        button.identifier = NSUserInterfaceItemIdentifier(id)
        if let image = NSImage(systemSymbolName: "minus.circle", accessibilityDescription: String(localized: "Remove account")) {
            button.image = image.withSymbolConfiguration(.init(pointSize: 10, weight: .medium))
            button.imagePosition = .imageOnly
        }
        button.contentTintColor = StarlingsColors.secondaryText
        button.alphaValue = 0.6
        button.toolTip = String(localized: "Remove \(group) — Starlings stops reading its calendars on every device")
        SettingsChrome.applyQuietButton(button)
        button.widthAnchor.constraint(equalToConstant: 18).isActive = true
        button.heightAnchor.constraint(equalToConstant: 16).isActive = true
        return button
    }

    /// Every row's leading mark sits in the same fixed box — colour chip, kind
    /// glyph, brand glyph alike — so the titles line up down the whole list
    /// however different the marks above them are.
    private func mark(_ view: NSView) -> NSView {
        let box = NSView()
        box.translatesAutoresizingMaskIntoConstraints = false
        view.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(view)
        NSLayoutConstraint.activate([
            box.widthAnchor.constraint(equalToConstant: Metrics.markSize),
            box.heightAnchor.constraint(equalToConstant: Metrics.markSize),
            view.centerXAnchor.constraint(equalTo: box.centerXAnchor),
            view.centerYAnchor.constraint(equalTo: box.centerYAnchor),
        ])
        return box
    }

    private enum Metrics {
        /// Wide enough for the tallest glyph, so nothing clips into the title.
        static let markSize: CGFloat = 14
        static let markGap: CGFloat = 6
        /// Pinned rather than intrinsic. A calendar row is as tall as its write
        /// pencil and a layer row only as tall as a checkbox, so left to size
        /// themselves the two halves of this list ran at different pitches —
        /// the company rows visibly tighter than the accounts above them.
        static let rowHeight: CGFloat = 24
        static let rowGap: CGFloat = 4
        /// Bigger than the gap between rows, or it is not a section break.
        static let sectionGap: CGFloat = 16
        static let headerGap: CGFloat = 6
    }

    /// One pitch for every row in the list, whatever it happens to contain.
    private func pinRowHeight(_ row: NSView) -> NSView {
        row.heightAnchor.constraint(equalToConstant: Metrics.rowHeight).isActive = true
        return row
    }

    @objc private func layerToggled(_ sender: NSButton) {
        guard let raw = sender.identifier?.rawValue,
              let kind = CalendarLayerKind(rawValue: raw)
        else { return }
        onToggleLayer?(kind, sender.state == .off)
    }

    /// The calendar new events land on, always visible in both modes so it is
    /// never a surprise where something was just created.
    private func renderWriteCalendar(_ writeCalendarID: String?) {
        guard let match = calendars.first(where: { $0.id == writeCalendarID }) else {
            writeCalendarLabel.stringValue = String(localized: "No calendar selected")
            writeCalendarSwatch.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.border, for: writeCalendarSwatch).cgColor
            return
        }
        writeCalendarLabel.stringValue = match.title
        writeCalendarSwatch.layer?.backgroundColor = match.displayColor.nsColor.cgColor
        writeCalendarButton.toolTip = String(localized: "New events go on \(match.groupTitle) — \(match.title)")
    }

    private func makeWriteCalendarFooter() -> NSView {
        let container = NSView()
        container.translatesAutoresizingMaskIntoConstraints = false
        container.wantsLayer = true

        let divider = NSView()
        divider.wantsLayer = true
        divider.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.border, for: divider).cgColor
        divider.translatesAutoresizingMaskIntoConstraints = false

        let caption = StarlingsTypography.sectionLabel(String(localized: "NEW EVENTS ON"))

        writeCalendarSwatch.wantsLayer = true
        writeCalendarSwatch.layer?.cornerRadius = 4
        writeCalendarSwatch.translatesAutoresizingMaskIntoConstraints = false

        writeCalendarLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .medium)
        writeCalendarLabel.textColor = StarlingsColors.primaryText
        writeCalendarLabel.lineBreakMode = .byTruncatingTail
        writeCalendarLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        writeCalendarButton.title = ""
        writeCalendarButton.bezelStyle = .inline
        writeCalendarButton.isBordered = false
        writeCalendarButton.target = self
        writeCalendarButton.action = #selector(pickWriteCalendar)
        if let image = NSImage(systemSymbolName: "chevron.up.chevron.down", accessibilityDescription: String(localized: "Change calendar")) {
            writeCalendarButton.image = image.withSymbolConfiguration(.init(pointSize: 9, weight: .semibold))
            writeCalendarButton.imagePosition = .imageOnly
        }
        writeCalendarButton.contentTintColor = StarlingsColors.secondaryText
        SettingsChrome.applyQuietButton(writeCalendarButton)

        let line = NSStackView(views: [writeCalendarSwatch, writeCalendarLabel, NSView(), writeCalendarButton])
        line.orientation = .horizontal
        line.alignment = .centerY
        line.spacing = 6

        let column = NSStackView(views: [caption, line])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 2
        column.translatesAutoresizingMaskIntoConstraints = false

        container.addSubview(divider)
        container.addSubview(column)
        NSLayoutConstraint.activate([
            divider.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            divider.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            divider.topAnchor.constraint(equalTo: container.topAnchor),
            divider.heightAnchor.constraint(equalToConstant: 1),
            column.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 10),
            column.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -10),
            column.topAnchor.constraint(equalTo: divider.bottomAnchor, constant: 8),
            column.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -10),
            line.widthAnchor.constraint(equalTo: column.widthAnchor),
            writeCalendarSwatch.widthAnchor.constraint(equalToConstant: 10),
            writeCalendarSwatch.heightAnchor.constraint(equalToConstant: 10),
        ])
        return container
    }

    private func row(for calendar: StarlingsCalendar, hidden: Bool, isWriteTarget: Bool) -> NSView {
        let sourceMark: NSView
        if calendar.role == .globalInterest {
            // The same Starlings glyph the phone badges these events with, in the
            // calendar's own colour where an ordinary calendar shows a swatch.
            let glyph = NSImageView()
            glyph.image = StarlingsBrand.glyphImage(size: 12, color: calendar.displayColor.nsColor)
            glyph.imageScaling = .scaleProportionallyDown
            glyph.setAccessibilityLabel(calendar.role.title)
            sourceMark = glyph
        } else {
            let swatch = NSView()
            swatch.wantsLayer = true
            swatch.layer?.backgroundColor = calendar.displayColor.nsColor.cgColor
            swatch.layer?.cornerRadius = 4
            swatch.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                swatch.widthAnchor.constraint(equalToConstant: 10),
                swatch.heightAnchor.constraint(equalToConstant: 10),
            ])
            sourceMark = swatch
        }

        let title = calendar.role == .globalInterest ? Self.listTitle(calendar.title) : calendar.title
        let checkbox = NSButton(checkboxWithTitle: title, target: self, action: #selector(toggled(_:)))
        checkbox.state = hidden ? .off : .on
        checkbox.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        // Neutral ticks: the swatch already carries the calendar's colour, and
        // the accent is kept for the Envisioning layers below.
        checkbox.applyMeetCheckboxStyle(mark: StarlingsColors.secondaryText)
        checkbox.identifier = NSUserInterfaceItemIdentifier(calendar.id)
        checkbox.lineBreakMode = .byTruncatingTail

        // The company calendar is editable, but new events never default onto
        // shared context — so it carries no write-target pencil to offer.
        var views: [NSView] = [mark(sourceMark), checkbox]
        if calendar.source == .subscription {
            views.append(removeSubscriptionButton(for: calendar))
        } else if calendar.role != .globalInterest {
            views.append(writeButton(for: calendar, isWriteTarget: isWriteTarget))
        }
        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = Metrics.markGap
        row.setHuggingPriority(.defaultHigh, for: .horizontal)
        checkbox.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return pinRowHeight(row)
    }

    /// A subscribed feed is never writable, so its row spends the pencil's
    /// spot on the one thing you can actually do to it: leave it.
    private func removeSubscriptionButton(for calendar: StarlingsCalendar) -> NSButton {
        let button = NSButton(title: "", target: self, action: #selector(removeSubscriptionTapped(_:)))
        button.bezelStyle = .inline
        button.isBordered = false
        button.identifier = NSUserInterfaceItemIdentifier(calendar.id)
        if let image = NSImage(systemSymbolName: "minus.circle", accessibilityDescription: String(localized: "Unsubscribe")) {
            button.image = image.withSymbolConfiguration(.init(pointSize: 12, weight: .medium))
            button.imagePosition = .imageOnly
        }
        button.contentTintColor = StarlingsColors.secondaryText
        button.alphaValue = 0.45
        button.toolTip = String(localized: "Unsubscribe from \(calendar.title)")
        SettingsChrome.applyQuietButton(button)
        button.widthAnchor.constraint(equalToConstant: 22).isActive = true
        button.heightAnchor.constraint(equalToConstant: 22).isActive = true
        return button
    }

    /// Which calendar new events land on — asked once per row, answered once
    /// per list.
    ///
    /// This used to draw a disabled pencil on every row, and most calendars here
    /// are read-only, so the list carried a column of a dozen greyed-out glyphs
    /// whose whole message was "not this one". A control that is never operable
    /// is not a control; it is texture. Read-only rows now keep the space and
    /// spend none of the ink, which leaves the filled pencil on the one row it
    /// means something about.
    private func writeButton(for calendar: StarlingsCalendar, isWriteTarget: Bool) -> NSButton {
        let write = NSButton(title: "", target: self, action: #selector(setWriteCalendar(_:)))
        write.bezelStyle = .inline
        write.isBordered = false
        write.identifier = NSUserInterfaceItemIdentifier(calendar.id)
        write.isEnabled = calendar.isWritable
        write.toolTip = calendar.isWritable ? String(localized: "New events go on this calendar") : String(localized: "This calendar is read-only")
        let symbol = isWriteTarget ? "pencil.circle.fill" : "pencil.circle"
        if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: String(localized: "Default calendar")) {
            write.image = image.withSymbolConfiguration(.init(pointSize: 12, weight: .medium))
            write.imagePosition = .imageOnly
        }
        write.contentTintColor = isWriteTarget ? StarlingsColors.accentMark : StarlingsColors.secondaryText
        // Invisible rather than absent: the pencils stay in one column, and the
        // titles beside them keep the same width whatever a calendar allows.
        write.alphaValue = calendar.isWritable ? (isWriteTarget ? 1 : 0.45) : 0
        SettingsChrome.applyQuietButton(write)
        write.widthAnchor.constraint(equalToConstant: 22).isActive = true
        write.heightAnchor.constraint(equalToConstant: 22).isActive = true
        return write
    }

    private func actionRow(title: String, action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .inline
        button.isBordered = false
        button.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .medium)
        button.contentTintColor = StarlingsColors.primaryText
        SettingsChrome.applyQuietButton(button)
        return button
    }

    /// The footer chevron is a shortcut into the calendar list, where the
    /// choice actually lives: unfold it if it is shut.
    /// The chevron reads as a dropdown, so it is one: every calendar new
    /// events may land on, grouped by account, with the current target ticked.
    /// Subscribed feeds and the company calendar never appear — neither is a
    /// place a new event defaults to.
    @objc private func pickWriteCalendar() {
        let menu = NSMenu()
        let groups = Dictionary(grouping: calendars, by: \.groupTitle)
        for group in StarlingsCalendar.orderedGroups(of: calendars) {
            let choices = (groups[group] ?? []).filter {
                $0.isWritable && $0.role == .ordinary && $0.source != .subscription
            }
            guard !choices.isEmpty else { continue }
            if !menu.items.isEmpty { menu.addItem(.separator()) }
            let header = NSMenuItem(title: group, action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)
            for calendar in choices {
                let item = NSMenuItem(title: calendar.title, action: #selector(writeCalendarChosen(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = calendar.id
                item.state = calendar.id == writeCalendarID ? .on : .off
                item.indentationLevel = 1
                menu.addItem(item)
            }
        }
        if menu.items.isEmpty {
            let empty = NSMenuItem(title: String(localized: "No writable calendars"), action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: writeCalendarButton.bounds.maxY), in: writeCalendarButton)
    }

    @objc private func writeCalendarChosen(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        onSetWriteCalendar?(id)
    }

    @objc private func toggled(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        onToggle?(id, sender.state == .off)
    }

    @objc private func accountToggled(_ sender: NSButton) {
        guard let group = sender.identifier?.rawValue else { return }
        onToggleAccount?(group, !hiddenAccounts.contains(group))
    }

    @objc private func setWriteCalendar(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        onSetWriteCalendar?(id)
    }

    @objc private func requestEventKit() {
        onRequestEventKit?()
    }

    @objc private func removeAccountTapped(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        onRemoveGoogleAccount?(id)
    }

    @objc private func removeSubscriptionTapped(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        onRemoveSubscription?(id)
    }
}

private final class SidebarFlippedClipView: NSClipView {
    override var isFlipped: Bool { true }
}
