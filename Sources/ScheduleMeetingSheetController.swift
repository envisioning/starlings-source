import AppKit

@MainActor
final class ScheduleMeetingSheetController: NSViewController, NSTextFieldDelegate {
    var onSchedule: ((ScheduleMeetingDraft) -> Void)?

    private let titleField = StarlingsTextField(placeholder: String(localized: "Meeting title"))
    private let startField = StarlingsDatePickerField()
    private var startPicker: StarlingsDatePicker { startField.picker }
    private let durationStack = NSStackView()
    private let endsLabel = NSTextField(labelWithString: "")
    private let guestChipsStack = NSStackView()
    private let guestsField = StarlingsTextField(placeholder: String(localized: "Type a name or email, then Enter"))
    private let suggestionsStack = NSStackView()
    private let joinLinkRow = CopyableURLRow()
    private let cancelButton = NSButton(title: String(localized: "Cancel"), target: nil, action: nil)
    private let createButton = StarlingsFilledButton(style: .accent, title: String(localized: "Add to Calendar"))
    private let agendaScroll = HorizontalWheelScrollView()
    private let agendaStack = NSStackView()
    private var agendaColumns: [AgendaDayColumnView] = []

    private let joinURL: String
    private let roomSlug: String
    private let agendaEvents: [CalendarEventSummary]
    private var publicEvents: [PublicEventsCalendar.Event] = []

    private var selectedDurationMinutes = 60
    private var contactEntries: [ContactEmailDirectory.Entry] = []
    private var guestInvites: [GuestInvite] = []
    private var activeSuggestions: [ContactEmailDirectory.Entry] = []
    private var durationButtons: [NSButton] = []
    private var agendaBuilt = false
    private var agendaStackWidthConstraint: NSLayoutConstraint?
    private let showWeekendsButton = NSButton(title: String(localized: "Weekends"), target: nil, action: nil)
    private let agendaLegend = AgendaLegendView()
    private let timezoneStack = NSStackView()
    private var timezoneButtons: [NSButton] = []
    private var selectedTimeZone: StarlingsScheduleTimeZone = .loadPreferred()

    private static let durationPresets = [30, 45, 60, 90]
    private static let showWeekendsDefaultsKey = "meet.schedule.showWeekends"

    private var scheduleCalendar: Calendar { selectedTimeZone.calendar }
    /// Weekdays-only horizon (Sat/Sun collapsed to `||`).
    private static let agendaWeekdayCount = 30
    /// Inclusive Sat/Sun horizon (~same six weeks as 30 weekdays).
    private static let agendaDayCountWithWeekends = 42
    private static let agendaColumnWidth: CGFloat = 132
    private static let agendaColumnSpacing: CGFloat = 8
    /// Extra gap for the Fri→Mon weekend marker (beyond normal column spacing).
    fileprivate static let weekendSeparatorWidth: CGFloat = 14

    private var showWeekends: Bool {
        get { UserDefaults.standard.bool(forKey: Self.showWeekendsDefaultsKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.showWeekendsDefaultsKey) }
    }

    private static func agendaContentWidth(columnCount: Int, weekendBreaks: Int) -> CGFloat {
        CGFloat(columnCount) * agendaColumnWidth
            + CGFloat(max(0, columnCount - 1)) * agendaColumnSpacing
            + CGFloat(weekendBreaks) * weekendSeparatorWidth
    }

    init(
        joinURL: String,
        roomSlug: String,
        agendaEvents: [CalendarEventSummary] = [],
        publicEvents: [PublicEventsCalendar.Event] = []
    ) {
        self.joinURL = joinURL
        self.roomSlug = roomSlug
        self.agendaEvents = agendaEvents
        self.publicEvents = publicEvents
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 920, height: 640))
        view.wantsLayer = true

        let heading = NSTextField(labelWithString: String(localized: "Schedule meeting"))
        heading.font = .systemFont(ofSize: StarlingsTypography.scaled(17), weight: .semibold)
        heading.textColor = StarlingsColors.primaryText

        titleField.stringValue = String(localized: "Starlings")
        titleField.delegate = self

        applyScheduleTimeZoneToPicker()
        let start = MeetingInvite.nextQuarterHour()
        startPicker.datePickerElements = [.yearMonthDay, .hourMinute]
        startPicker.minuteStep = 5
        startPicker.dateValue = start
        startPicker.target = self
        startPicker.action = #selector(startChanged)

        durationStack.orientation = .horizontal
        durationStack.spacing = 6
        durationStack.alignment = .centerY
        durationStack.distribution = .fillEqually
        for minutes in Self.durationPresets {
            let button = NSButton(title: String(localized: "\(minutes)m"), target: self, action: #selector(durationTapped(_:)))
            button.tag = minutes
            button.setButtonType(.momentaryPushIn)
            button.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold)
            button.heightAnchor.constraint(equalToConstant: 30).isActive = true
            // These chips repaint from `refreshDurationChrome`, so hover cannot own
            // the layer directly — it flips the flag and asks for a repaint.
            button.trackMeetHover { [weak self] _ in self?.refreshDurationChrome() }
            durationButtons.append(button)
            durationStack.addArrangedSubview(button)
        }
        refreshDurationChrome()

        timezoneStack.orientation = .horizontal
        // Ten cities share this row, so it buys the width back from the gaps
        // rather than from the names.
        timezoneStack.spacing = 4
        timezoneStack.alignment = .centerY
        timezoneStack.distribution = .fillEqually
        for (index, zone) in StarlingsScheduleTimeZone.offered.enumerated() {
            let button = NSButton(title: zone.cityLabel, target: self, action: #selector(timezoneTapped(_:)))
            button.tag = index
            button.setButtonType(.momentaryPushIn)
            button.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold)
            button.heightAnchor.constraint(equalToConstant: 28).isActive = true
            button.trackMeetHover { [weak self] _ in self?.refreshTimezoneChrome() }
            timezoneButtons.append(button)
            timezoneStack.addArrangedSubview(button)
        }
        refreshTimezoneChrome()

        endsLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        endsLabel.textColor = StarlingsColors.secondaryText
        refreshEndsLabel()

        guestsField.delegate = self
        guestChipsStack.orientation = .vertical
        guestChipsStack.alignment = .leading
        guestChipsStack.spacing = 6
        guestChipsStack.isHidden = true
        suggestionsStack.orientation = .vertical
        suggestionsStack.alignment = .leading
        suggestionsStack.spacing = 4
        suggestionsStack.isHidden = true

        joinLinkRow.displayString = joinURL
        joinLinkRow.clipboardString = joinURL

        cancelButton.target = self
        cancelButton.action = #selector(cancel)
        // A sheet window has no close button, so Escape is the only way out
        // that isn't aiming at one button.
        cancelButton.keyEquivalent = "\u{1b}"
        SettingsChrome.applySecondaryButton(cancelButton, title: String(localized: "Cancel"))
        createButton.target = self
        createButton.action = #selector(create)
        createButton.apply(.accent, title: String(localized: "Add to Calendar"), font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold))

        let whenCard = makeWhenCard()
        let titleBlock = labeled(String(localized: "Title"), titleField)
        let guestsComposer = NSStackView(views: [guestChipsStack, guestsField])
        guestsComposer.orientation = .vertical
        guestsComposer.alignment = .leading
        guestsComposer.spacing = 8
        let guestsBlock = labeled(String(localized: "Guests"), guestsComposer)

        let form = NSStackView(views: [
            titleBlock,
            whenCard,
            guestsBlock,
            suggestionsStack,
            joinLinkRow,
        ])
        form.orientation = .vertical
        form.alignment = .leading
        form.spacing = 16
        form.setCustomSpacing(20, after: titleBlock)
        form.setCustomSpacing(6, after: guestsBlock)
        form.setCustomSpacing(18, after: suggestionsStack)
        form.translatesAutoresizingMaskIntoConstraints = false
        form.widthAnchor.constraint(equalToConstant: 300).isActive = true

        agendaStack.orientation = .horizontal
        agendaStack.alignment = .top
        agendaStack.spacing = Self.agendaColumnSpacing
        // Inset so selected-column layer borders are not clipped by the scroll clip view.
        agendaStack.edgeInsets = NSEdgeInsets(top: 3, left: 0, bottom: 3, right: 0)
        agendaStack.translatesAutoresizingMaskIntoConstraints = false

        agendaScroll.drawsBackground = false
        agendaScroll.backgroundColor = .clear
        agendaScroll.borderType = .noBorder
        agendaScroll.hasHorizontalScroller = true
        agendaScroll.hasVerticalScroller = false
        agendaScroll.autohidesScrollers = true
        agendaScroll.horizontalScrollElasticity = .allowed
        agendaScroll.scrollerStyle = .overlay
        agendaScroll.documentView = agendaStack
        agendaScroll.translatesAutoresizingMaskIntoConstraints = false

        let agendaHeader = StarlingsTypography.fieldCaption(String(localized: "Agenda"))
        showWeekendsButton.setButtonType(.pushOnPushOff)
        showWeekendsButton.state = showWeekends ? .on : .off
        showWeekendsButton.isBordered = false
        showWeekendsButton.wantsLayer = true
        showWeekendsButton.layer?.cornerRadius = 6
        showWeekendsButton.layer?.cornerCurve = .continuous
        showWeekendsButton.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold)
        showWeekendsButton.target = self
        showWeekendsButton.action = #selector(toggleShowWeekends)
        showWeekendsButton.setContentHuggingPriority(.required, for: .horizontal)
        showWeekendsButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        showWeekendsButton.heightAnchor.constraint(equalToConstant: 22).isActive = true
        showWeekendsButton.trackMeetHover { [weak self] _ in self?.refreshWeekendsButtonChrome() }
        refreshWeekendsButtonChrome()
        agendaLegend.setPublicEventCount(publicEvents.count)
        let agendaHeaderRow = NSStackView(views: [agendaHeader, showWeekendsButton, NSView(), agendaLegend])
        agendaHeaderRow.orientation = .horizontal
        agendaHeaderRow.alignment = .centerY
        agendaHeaderRow.spacing = 10
        agendaHeaderRow.setCustomSpacing(12, after: agendaHeader)

        let timeGutter = AgendaTimeGutterView()
        let agendaBand = NSStackView(views: [timeGutter, agendaScroll])
        agendaBand.orientation = .horizontal
        agendaBand.alignment = .top
        agendaBand.spacing = 4

        let agendaColumn = NSStackView(views: [agendaHeaderRow, agendaBand])
        agendaColumn.orientation = .vertical
        agendaColumn.alignment = .leading
        agendaColumn.spacing = 8
        agendaHeaderRow.widthAnchor.constraint(equalTo: agendaColumn.widthAnchor).isActive = true

        let body = NSStackView(views: [form, agendaColumn])
        body.orientation = .horizontal
        body.alignment = .top
        body.spacing = 28
        body.setContentHuggingPriority(.defaultLow, for: .vertical)

        let actions = NSStackView(views: [NSView(), cancelButton, createButton])
        actions.orientation = .horizontal
        actions.spacing = 10
        actions.alignment = .centerY

        let stack = NSStackView(views: [heading, body, actions])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 18
        view.addSubview(stack)
        stack.pinToEdges(of: view, insets: NSEdgeInsets(top: 22, left: 22, bottom: 22, right: 22))
        body.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        actions.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        agendaColumn.widthAnchor.constraint(equalTo: body.widthAnchor, constant: -328).isActive = true
        agendaColumn.heightAnchor.constraint(equalTo: body.heightAnchor).isActive = true
        agendaColumn.setContentHuggingPriority(.defaultLow, for: .vertical)
        agendaBand.widthAnchor.constraint(equalTo: agendaColumn.widthAnchor).isActive = true
        agendaBand.setContentHuggingPriority(.defaultLow, for: .vertical)
        agendaScroll.widthAnchor.constraint(equalTo: agendaBand.widthAnchor, constant: -AgendaTimelineMetrics.gutterWidth - 4).isActive = true
        agendaScroll.setContentHuggingPriority(.defaultLow, for: .vertical)
        let minAgendaHeight = AgendaTimelineMetrics.columnChromeHeight + AgendaTimelineMetrics.timelineHeight
        agendaScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: minAgendaHeight).isActive = true
        agendaScroll.topAnchor.constraint(equalTo: agendaBand.topAnchor).isActive = true
        agendaScroll.bottomAnchor.constraint(equalTo: agendaBand.bottomAnchor).isActive = true
        timeGutter.topAnchor.constraint(equalTo: agendaBand.topAnchor).isActive = true
        timeGutter.bottomAnchor.constraint(equalTo: agendaBand.bottomAnchor).isActive = true
        agendaBand.bottomAnchor.constraint(equalTo: agendaColumn.bottomAnchor).isActive = true
        titleField.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
        whenCard.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
        guestChipsStack.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
        guestsField.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
        suggestionsStack.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
        joinLinkRow.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
        startField.widthAnchor.constraint(equalTo: whenCard.widthAnchor, constant: -24).isActive = true
        durationStack.widthAnchor.constraint(equalTo: whenCard.widthAnchor, constant: -24).isActive = true
        timezoneStack.widthAnchor.constraint(equalTo: whenCard.widthAnchor, constant: -24).isActive = true

        // Pin stack height to the clip view so columns stretch vertically; width is set when columns build.
        let widthConstraint = agendaStack.widthAnchor.constraint(equalToConstant: 1)
        agendaStackWidthConstraint = widthConstraint
        NSLayoutConstraint.activate([
            agendaStack.leadingAnchor.constraint(equalTo: agendaScroll.contentView.leadingAnchor),
            agendaStack.topAnchor.constraint(equalTo: agendaScroll.contentView.topAnchor),
            agendaStack.heightAnchor.constraint(equalTo: agendaScroll.contentView.heightAnchor),
            widthConstraint,
        ])

        let sheetHeight = 200 + minAgendaHeight
        preferredContentSize = NSSize(width: 920, height: sheetHeight)
        view.setFrameSize(preferredContentSize)
    }

    private func makeWhenCard() -> NSView {
        let card = NSView()
        card.wantsLayer = true
        card.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: card).cgColor
        card.layer?.cornerRadius = 12
        card.layer?.borderWidth = 1
        card.layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: card).cgColor
        card.layer?.cornerCurve = .continuous

        let whenLabel = StarlingsTypography.fieldCaption(String(localized: "When"))
        let zoneLabel = StarlingsTypography.fieldCaption(String(localized: "Timezone"))

        let stack = NSStackView(views: [whenLabel, startField, durationStack, endsLabel, zoneLabel, timezoneStack])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.setCustomSpacing(6, after: durationStack)
        stack.setCustomSpacing(12, after: endsLabel)
        stack.setCustomSpacing(6, after: zoneLabel)
        card.addSubview(stack)
        stack.pinToEdges(of: card, insets: NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12))
        return card
    }

    private func applyScheduleTimeZoneToPicker() {
        let zone = selectedTimeZone.timeZone
        startPicker.timeZone = zone
        var calendar = startPicker.calendar ?? Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        startPicker.calendar = calendar
    }

    @objc private func timezoneTapped(_ sender: NSButton) {
        let zones = StarlingsScheduleTimeZone.offered
        guard zones.indices.contains(sender.tag) else { return }
        let next = zones[sender.tag]
        guard next != selectedTimeZone else { return }
        selectedTimeZone = next
        selectedTimeZone.savePreferred()
        applyScheduleTimeZoneToPicker()
        refreshTimezoneChrome()
        refreshEndsLabel()
        rebuildAgenda()
        refreshAgendaSelection(scrollIntoView: true)
    }

    private func refreshTimezoneChrome() {
        let zones = StarlingsScheduleTimeZone.offered
        for button in timezoneButtons {
            let zone = zones.indices.contains(button.tag) ? zones[button.tag] : nil
            let selected = zone == selectedTimeZone
            let hovered = button.meetHoverMonitor?.isHovered ?? false
            button.wantsLayer = true
            button.isBordered = false
            button.layer?.cornerRadius = 8
            button.layer?.cornerCurve = .continuous
            button.layer?.backgroundColor = StarlingsColors.resolved(
                Self.chipFill(selected: selected, hovered: hovered),
                for: button
            ).cgColor
            button.layer?.borderWidth = selected ? 0 : 1
            button.layer?.borderColor = StarlingsColors.resolved(
                hovered ? StarlingsColors.borderHover : StarlingsColors.border,
                for: button
            ).cgColor
            if let cell = button.cell as? NSButtonCell {
                cell.highlightsBy = []
                cell.showsStateBy = []
            }
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = .center
            let title = zone?.cityLabel ?? button.title
            // Compact labels so ten cities fit the 300pt form column.
            let short = zone?.shortLabel ?? title
            button.attributedTitle = NSAttributedString(
                string: short,
                attributes: [
                    .foregroundColor: selected ? StarlingsColors.accentInk : StarlingsColors.primaryText,
                    .font: NSFont.systemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold),
                    .paragraphStyle: paragraph,
                ]
            )
        }
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        if !agendaBuilt {
            rebuildAgenda()
            agendaBuilt = true
        }
        refreshAgendaDraft()
        refreshAgendaSelection(scrollIntoView: true)
        Task { await loadContacts() }
        Task { await loadPublicEvents() }
    }

    private func loadPublicEvents() async {
        let events = await PublicEventsCalendar.load()
        publicEvents = events
        agendaLegend.setPublicEventCount(events.count)
        rebuildAgenda()
        refreshAgendaSelection(scrollIntoView: false)
    }

    private func labeled(_ title: String, _ control: NSView) -> NSView {
        let column = NSStackView(views: [StarlingsTypography.fieldCaption(title), control])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 4
        return column
    }

    @objc private func toggleShowWeekends() {
        showWeekends = showWeekendsButton.state == .on
        refreshWeekendsButtonChrome()
        rebuildAgenda()
        refreshAgendaSelection(scrollIntoView: true)
    }

    /// Selected chips are already accent, so their hover is the accent's own hover
    /// rather than another rung of grey — the same pair the filled CTA uses.
    private static func chipFill(selected: Bool, hovered: Bool) -> NSColor {
        if selected {
            return hovered ? StarlingsColors.accentHover : StarlingsColors.accent
        }
        return hovered ? StarlingsColors.lifted(StarlingsColors.elevated) : StarlingsColors.elevated
    }

    private func refreshWeekendsButtonChrome() {
        let on = showWeekendsButton.state == .on
        let hovered = showWeekendsButton.meetHoverMonitor?.isHovered ?? false
        showWeekendsButton.attributedTitle = NSAttributedString(
            string: "  Weekends  ",
            attributes: [
                .font: NSFont.systemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold),
                .foregroundColor: on ? StarlingsColors.accentInk : StarlingsColors.primaryText,
            ]
        )
        let restingFill = on ? StarlingsColors.accent : StarlingsColors.panel
        let hoveredFill = on ? StarlingsColors.accentHover : StarlingsColors.lifted(restingFill)
        showWeekendsButton.layer?.backgroundColor = StarlingsColors.resolved(
            hovered ? hoveredFill : restingFill,
            for: showWeekendsButton
        ).cgColor
        showWeekendsButton.layer?.borderWidth = 1
        let restingBorder = on ? StarlingsColors.borderHover : StarlingsColors.border
        showWeekendsButton.layer?.borderColor = StarlingsColors.resolved(
            hovered && !on ? StarlingsColors.borderHover : restingBorder,
            for: showWeekendsButton
        ).cgColor
    }

    private func rebuildAgenda() {
        agendaStack.arrangedSubviews.forEach {
            agendaStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        agendaColumns.removeAll(keepingCapacity: true)
        let calendar = scheduleCalendar
        let selectedDay = calendar.startOfDay(for: startPicker.dateValue)
        let includeWeekends = showWeekends
        let days = Self.upcomingAgendaDays(includeWeekends: includeWeekends, calendar: calendar)
        var weekendBreaks = 0
        for (index, day) in days.enumerated() {
            if !includeWeekends, index > 0, Self.isWeekendBreak(from: days[index - 1], to: day, calendar: calendar) {
                let separator = AgendaWeekendSeparatorView()
                agendaStack.addArrangedSubview(separator)
                separator.heightAnchor.constraint(equalTo: agendaStack.heightAnchor).isActive = true
                weekendBreaks += 1
            }
            let column = AgendaDayColumnView(
                day: day,
                events: events(on: day),
                publicEvents: publicInfoEvents(on: day),
                columnWidth: Self.agendaColumnWidth,
                isWeekend: Self.isWeekend(day, calendar: calendar),
                isSelected: calendar.isDate(day, inSameDayAs: selectedDay),
                calendar: calendar,
                durationMinutes: { [weak self] in self?.selectedDurationMinutes ?? 60 },
                onSelectSlot: { [weak self] start in
                    self?.setStart(to: start)
                }
            )
            agendaColumns.append(column)
            agendaStack.addArrangedSubview(column)
            column.heightAnchor.constraint(equalTo: agendaStack.heightAnchor).isActive = true
        }
        agendaStackWidthConstraint?.constant = Self.agendaContentWidth(
            columnCount: agendaColumns.count,
            weekendBreaks: weekendBreaks
        )
        refreshAgendaDraft()
    }

    /// True when adjacent weekday columns skip Sat/Sun (Fri → Mon).
    private static func isWeekendBreak(from earlier: Date, to later: Date, calendar: Calendar) -> Bool {
        let earlierWeekday = calendar.component(.weekday, from: earlier)
        let laterWeekday = calendar.component(.weekday, from: later)
        // Gregorian: Friday = 6, Monday = 2
        return earlierWeekday == 6 && laterWeekday == 2
    }

    private static func isWeekend(_ day: Date, calendar: Calendar) -> Bool {
        let weekday = calendar.component(.weekday, from: day)
        // Gregorian: 1 = Sunday, 7 = Saturday
        return weekday == 1 || weekday == 7
    }

    private func currentDraftPreview() -> AgendaDraftPreview {
        let title = titleField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let start = startPicker.dateValue
        let end = start.addingTimeInterval(TimeInterval(selectedDurationMinutes * 60))
        return AgendaDraftPreview(
            title: title.isEmpty ? String(localized: "New meeting") : title,
            start: start,
            end: end
        )
    }

    private func refreshAgendaDraft() {
        let draft = currentDraftPreview()
        for column in agendaColumns {
            column.updateSchedulingState(draft: draft, durationMinutes: selectedDurationMinutes)
        }
    }

    /// Agenda day strip: weekdays only by default, or consecutive days including weekends.
    private static func upcomingAgendaDays(includeWeekends: Bool, calendar: Calendar) -> [Date] {
        let startOfToday = calendar.startOfDay(for: Date())
        if includeWeekends {
            return (0..<agendaDayCountWithWeekends).compactMap {
                calendar.date(byAdding: .day, value: $0, to: startOfToday)
            }
        }
        var days: [Date] = []
        var offset = 0
        while days.count < agendaWeekdayCount, offset < agendaWeekdayCount * 3 {
            defer { offset += 1 }
            guard let day = calendar.date(byAdding: .day, value: offset, to: startOfToday) else { continue }
            let weekday = calendar.component(.weekday, from: day)
            // Gregorian: 1 = Sunday, 7 = Saturday
            guard weekday != 1, weekday != 7 else { continue }
            days.append(day)
        }
        return days
    }

    private func refreshAgendaSelection(scrollIntoView: Bool) {
        let calendar = scheduleCalendar
        let selectedDay = calendar.startOfDay(for: startPicker.dateValue)
        var selectedColumn: AgendaDayColumnView?
        for column in agendaColumns {
            let selected = calendar.isDate(column.day, inSameDayAs: selectedDay)
            column.setSelected(selected)
            if selected { selectedColumn = column }
        }
        guard scrollIntoView, let selectedColumn else { return }
        selectedColumn.layoutSubtreeIfNeeded()
        let rect = selectedColumn.frame.insetBy(dx: -Self.agendaColumnSpacing, dy: 0)
        agendaStack.scrollToVisible(rect)
    }

    private func events(on day: Date) -> [CalendarEventSummary] {
        let calendar = scheduleCalendar
        let dayStart = calendar.startOfDay(for: day)
        guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else { return [] }
        return agendaEvents
            .filter { event in
                guard let start = AgendaEventInstant.parse(event.start, calendar: calendar) else { return false }
                if start.isAllDay {
                    let end = AgendaEventInstant.parse(event.end, calendar: calendar)?.date
                        ?? calendar.date(byAdding: .day, value: 1, to: start.date)
                        ?? start.date
                    // Google all-day `end` is exclusive.
                    return start.date < dayEnd && end > dayStart
                }
                return start.date >= dayStart && start.date < dayEnd
            }
            .sorted {
                let lhs = AgendaEventInstant.parse($0.start, calendar: calendar)?.date ?? .distantPast
                let rhs = AgendaEventInstant.parse($1.start, calendar: calendar)?.date ?? .distantPast
                return lhs < rhs
            }
    }

    private func publicInfoEvents(on day: Date) -> [PublicEventsCalendar.Event] {
        let calendar = scheduleCalendar
        let dayStart = calendar.startOfDay(for: day)
        guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else { return [] }
        return publicEvents
            .filter { event in
                guard let start = AgendaEventInstant.parse(event.start, calendar: calendar) else { return false }
                if start.isAllDay {
                    let end = AgendaEventInstant.parse(event.end, calendar: calendar)?.date
                        ?? calendar.date(byAdding: .day, value: 1, to: start.date)
                        ?? start.date
                    // ICS all-day DTEND is exclusive, same as Google.
                    return start.date < dayEnd && end > dayStart
                }
                return start.date >= dayStart && start.date < dayEnd
            }
            .sorted {
                let lhs = AgendaEventInstant.parse($0.start, calendar: calendar)?.date ?? .distantPast
                let rhs = AgendaEventInstant.parse($1.start, calendar: calendar)?.date ?? .distantPast
                return lhs < rhs
            }
    }

    private func setStart(to date: Date) {
        startPicker.dateValue = date
        refreshEndsLabel()
        refreshAgendaDraft()
        refreshAgendaSelection(scrollIntoView: true)
    }

    private func refreshEndsLabel() {
        let end = startPicker.dateValue.addingTimeInterval(TimeInterval(selectedDurationMinutes * 60))
        endsLabel.stringValue = String(localized: "Ends at \(StarlingsDateFormatting.time(end, timeZone: selectedTimeZone.timeZone)) · \(selectedTimeZone.cityLabel)")
    }

    private func refreshDurationChrome() {
        for button in durationButtons {
            let selected = button.tag == selectedDurationMinutes
            let hovered = button.meetHoverMonitor?.isHovered ?? false
            button.wantsLayer = true
            button.isBordered = false
            button.layer?.cornerRadius = 8
            button.layer?.cornerCurve = .continuous
            button.layer?.backgroundColor = StarlingsColors.resolved(
                Self.chipFill(selected: selected, hovered: hovered),
                for: button
            ).cgColor
            button.layer?.borderWidth = selected ? 0 : 1
            button.layer?.borderColor = StarlingsColors.resolved(
                hovered ? StarlingsColors.borderHover : StarlingsColors.border,
                for: button
            ).cgColor
            if let cell = button.cell as? NSButtonCell {
                cell.highlightsBy = []
                cell.showsStateBy = []
            }
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = .center
            button.attributedTitle = NSAttributedString(
                string: "\(button.tag)m",
                attributes: [
                    .foregroundColor: selected ? StarlingsColors.accentInk : StarlingsColors.primaryText,
                    .font: NSFont.systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold),
                    .paragraphStyle: paragraph,
                ]
            )
        }
    }

    private func loadContacts() async {
        let allowed = await ContactEmailDirectory.requestAccessIfNeeded()
        guard allowed else {
            guestsField.placeholderString = String(localized: "Type an email, then Enter")
            return
        }
        contactEntries = ContactEmailDirectory.loadEntries()
        if guestsField.currentEditor() != nil {
            refreshSuggestions(showWhenEmpty: false)
        }
    }

    private func refreshSuggestions(showWhenEmpty: Bool = false) {
        suggestionsStack.arrangedSubviews.forEach {
            suggestionsStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }

        let token = guestsField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let invited = Set(guestInvites.map(\.email))
        let matches = ContactEmailDirectory.suggestions(matching: token, in: contactEntries)
            .filter { !invited.contains($0.email) }
        activeSuggestions = matches

        let shouldShow = !matches.isEmpty
            && (showWhenEmpty || !token.isEmpty)
            && guestsField.currentEditor() != nil
        guard shouldShow else {
            suggestionsStack.isHidden = true
            return
        }

        for entry in matches.prefix(6) {
            let button = ContactSuggestionButton(entry: entry)
            button.target = self
            button.action = #selector(suggestionTapped(_:))
            suggestionsStack.addArrangedSubview(button)
            button.widthAnchor.constraint(lessThanOrEqualTo: suggestionsStack.widthAnchor).isActive = true
        }
        suggestionsStack.isHidden = false
    }

    private func refreshGuestChips() {
        guestChipsStack.arrangedSubviews.forEach {
            guestChipsStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        guestChipsStack.isHidden = guestInvites.isEmpty
        for invite in guestInvites {
            let chip = GuestChipView(invite: invite)
            chip.onRemove = { [weak self] email in
                self?.removeGuest(email)
            }
            guestChipsStack.addArrangedSubview(chip)
            chip.widthAnchor.constraint(equalTo: guestChipsStack.widthAnchor).isActive = true
        }
    }

    private func parsedAttendees() -> [String] {
        guestInvites.map(\.email)
    }

    private func appendGuest(_ invite: GuestInvite) {
        let normalized = invite.email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard normalized.contains("@") else { return }
        guard !guestInvites.contains(where: { $0.email == normalized }) else {
            guestsField.stringValue = ""
            refreshSuggestions(showWhenEmpty: false)
            return
        }
        guestInvites.append(GuestInvite(name: invite.name, email: normalized))
        guestsField.stringValue = ""
        refreshGuestChips()
        refreshSuggestions(showWhenEmpty: false)
    }

    private func removeGuest(_ email: String) {
        guestInvites.removeAll { $0.email == email }
        refreshGuestChips()
        refreshSuggestions(showWhenEmpty: guestsField.currentEditor() != nil)
    }

    /// Enter commits the top Contacts match, or a typed email address.
    @discardableResult
    private func commitGuestFromField() -> Bool {
        let token = guestsField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if let top = activeSuggestions.first {
            appendGuest(GuestInvite(name: top.name, email: top.email))
            return true
        }
        if token.contains("@") {
            let matched = contactEntries.first { $0.email == token.lowercased() }
            appendGuest(GuestInvite(name: matched?.name ?? "", email: token))
            return true
        }
        if token.isEmpty { return false }
        // Partial name with no match — keep typing.
        NSSound.beep()
        return false
    }

    @objc private func durationTapped(_ sender: NSButton) {
        selectedDurationMinutes = sender.tag
        refreshDurationChrome()
        refreshEndsLabel()
        refreshAgendaDraft()
    }

    @objc private func startChanged() {
        refreshEndsLabel()
        refreshAgendaDraft()
        refreshAgendaSelection(scrollIntoView: true)
    }

    func controlTextDidChange(_ obj: Notification) {
        if obj.object as AnyObject === guestsField {
            refreshSuggestions(showWhenEmpty: false)
            return
        }
        if obj.object as AnyObject === titleField {
            refreshAgendaDraft()
        }
    }

    func controlTextDidBeginEditing(_ obj: Notification) {
        guard obj.object as AnyObject === guestsField else { return }
        refreshSuggestions(showWhenEmpty: false)
    }

    func controlTextDidEndEditing(_ obj: Notification) {
        guard obj.object as AnyObject === guestsField else { return }
        suggestionsStack.isHidden = true
    }

    func control(
        _ control: NSControl,
        textView: NSTextView,
        doCommandBy commandSelector: Selector
    ) -> Bool {
        guard control === guestsField else { return false }
        if commandSelector == #selector(NSResponder.insertNewline(_:))
            || commandSelector == #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:))
        {
            return commitGuestFromField()
        }
        if commandSelector == #selector(NSResponder.insertTab(_:)) {
            // Tab also commits when there's a clear match, then moves on.
            if !guestsField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return commitGuestFromField()
            }
            return false
        }
        if commandSelector == #selector(NSResponder.deleteBackward(_:)) {
            // Empty field + backspace removes the last chip.
            if guestsField.stringValue.isEmpty, let last = guestInvites.last {
                removeGuest(last.email)
                return true
            }
        }
        return false
    }

    @objc private func suggestionTapped(_ sender: ContactSuggestionButton) {
        appendGuest(GuestInvite(name: sender.entry.name, email: sender.entry.email))
    }

    @objc private func cancel() {
        closeSheet()
    }

    @objc private func create() {
        let title = titleField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        // Flush a typed email that wasn't committed with Enter.
        let pending = guestsField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if pending.contains("@") {
            appendGuest(GuestInvite(name: "", email: pending))
        }
        let start = startPicker.dateValue
        let end = start.addingTimeInterval(TimeInterval(selectedDurationMinutes * 60))
        onSchedule?(ScheduleMeetingDraft(
            title: title,
            start: start,
            end: end,
            attendees: parsedAttendees().filter { $0.contains("@") },
            joinURL: joinURL,
            roomSlug: roomSlug,
            timeZoneIdentifier: selectedTimeZone.identifier
        ))
        closeSheet()
    }

    private func closeSheet() {
        closeSheetWindow()
    }
}

// MARK: - Horizontal wheel scroll

/// Maps vertical mouse-wheel / trackpad swipes onto horizontal agenda scrolling.
private final class HorizontalWheelScrollView: NSScrollView {
    override func scrollWheel(with event: NSEvent) {
        // Native horizontal gestures (shift-wheel, sideways trackpad) keep their axis.
        if abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY) {
            super.scrollWheel(with: event)
            return
        }
        guard event.scrollingDeltaY != 0, let documentView else {
            super.scrollWheel(with: event)
            return
        }

        let clip = contentView
        var origin = clip.bounds.origin
        let delta = event.hasPreciseScrollingDeltas ? event.scrollingDeltaY : event.scrollingDeltaY * 12
        origin.x -= delta
        let maxX = max(0, documentView.bounds.width - clip.bounds.width)
        origin.x = min(max(origin.x, 0), maxX)
        origin.y = 0
        clip.scroll(to: origin)
        reflectScrolledClipView(clip)
    }
}

// MARK: - Guest chips

private struct GuestInvite: Equatable {
    let name: String
    let email: String
}

@MainActor
private final class GuestChipView: NSView {
    var onRemove: ((String) -> Void)?
    private let email: String

    init(invite: GuestInvite) {
        self.email = invite.email
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: self).cgColor
        layer?.cornerRadius = 8
        layer?.cornerCurve = .continuous
        layer?.borderWidth = 1
        layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor

        let title = NSTextField(labelWithString: invite.name.isEmpty ? invite.email : invite.name)
        title.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold)
        title.textColor = StarlingsColors.primaryText
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let detail = NSTextField(labelWithString: invite.name.isEmpty ? "" : invite.email)
        detail.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        detail.textColor = StarlingsColors.secondaryText
        detail.lineBreakMode = .byTruncatingTail
        detail.isHidden = invite.name.isEmpty
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let labels = NSStackView(views: invite.name.isEmpty ? [title] : [title, detail])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 0
        labels.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let remove = NSButton(title: "", target: self, action: #selector(removeTapped))
        SettingsChrome.applyQuietButton(remove)
        remove.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: String(localized: "Remove"))
        remove.imageScaling = .scaleProportionallyDown
        remove.contentTintColor = StarlingsColors.secondaryText
        remove.toolTip = String(localized: "Remove")
        remove.setContentHuggingPriority(.required, for: .horizontal)
        remove.widthAnchor.constraint(equalToConstant: 22).isActive = true
        remove.heightAnchor.constraint(equalToConstant: 22).isActive = true

        let row = NSStackView(views: [labels, remove])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        addSubview(row)
        row.pinToEdges(of: self, insets: NSEdgeInsets(top: 6, left: 10, bottom: 6, right: 6))
        heightAnchor.constraint(greaterThanOrEqualToConstant: 34).isActive = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    @objc private func removeTapped() {
        onRemove?(email)
    }
}

// MARK: - Contact suggestion

@MainActor
private final class ContactSuggestionButton: NSButton {
    let entry: ContactEmailDirectory.Entry

    init(entry: ContactEmailDirectory.Entry) {
        self.entry = entry
        super.init(frame: .zero)
        bezelStyle = .inline
        SettingsChrome.applyQuietButton(self)
        font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        contentTintColor = StarlingsColors.primaryText
        title = entry.label
        alignment = .left
        heightAnchor.constraint(equalToConstant: 22).isActive = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

// MARK: - Timeline metrics

private enum AgendaTimelineMetrics {
    static let dayStartHour = 8
    static let dayEndHour = 20
    static let slotMinutes = 30
    static let hourHeight: CGFloat = 40
    static let gutterWidth: CGFloat = 36
    static let headerHeight: CGFloat = 44
    static let allDayHeight: CGFloat = 20
    static let columnInsets: CGFloat = 20 // top+bottom padding inside column

    static var hourCount: Int { dayEndHour - dayStartHour }
    static var slotCount: Int { hourCount * (60 / slotMinutes) }
    static var timelineHeight: CGFloat { CGFloat(hourCount) * hourHeight }
    static var columnChromeHeight: CGFloat {
        // top/bottom insets + header + spacings + all-day
        columnInsets + headerHeight + 8 + allDayHeight + 8
    }

    /// Height of the fixed chrome above the hour grid (for gutter alignment).
    static var gutterTopChrome: CGFloat {
        10 + headerHeight + 8 + allDayHeight + 8
    }

    static var gutterBottomChrome: CGFloat {
        10
    }

    static func yOffset(
        for date: Date,
        on day: Date,
        timelineHeight: CGFloat? = nil,
        calendar: Calendar = .current
    ) -> CGFloat {
        let gridHeight = timelineHeight ?? Self.timelineHeight
        let dayStart = calendar.startOfDay(for: day)
        guard let gridStart = calendar.date(byAdding: .hour, value: dayStartHour, to: dayStart) else {
            return 0
        }
        let minutes = date.timeIntervalSince(gridStart) / 60
        let clamped = min(max(minutes, 0), Double(hourCount * 60))
        return CGFloat(clamped / (Double(hourCount * 60))) * gridHeight
    }

    static func blockHeight(
        from start: Date,
        to end: Date,
        on day: Date,
        timelineHeight: CGFloat? = nil,
        calendar: Calendar = .current
    ) -> CGFloat {
        let gridHeight = timelineHeight ?? Self.timelineHeight
        let minBlock = gridHeight / CGFloat(hourCount) * 0.45
        let top = yOffset(for: start, on: day, timelineHeight: gridHeight, calendar: calendar)
        let bottom = yOffset(
            for: max(end, start.addingTimeInterval(15 * 60)),
            on: day,
            timelineHeight: gridHeight,
            calendar: calendar
        )
        return max(minBlock, bottom - top)
    }
}

private struct AgendaEventInstant {
    let date: Date
    let isAllDay: Bool

    static func parse(_ value: String, calendar: Calendar = .current) -> AgendaEventInstant? {
        if let date = ISODate.parse(value) {
            return AgendaEventInstant(date: date, isAllDay: false)
        }
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        guard let date = formatter.date(from: value) else { return nil }
        return AgendaEventInstant(date: date, isAllDay: true)
    }
}

private enum AgendaEventMatch {
    /// Google-subscribed `events.ics` copies — same title on the same local day is enough.
    /// (A tight start-time window missed real feed hits when Google rewrote DTSTART.)
    static func overlaps(
        calendarTitle: String,
        calendarStart: Date,
        publicEvent: PublicEventsCalendar.Event,
        calendar: Calendar
    ) -> Bool {
        guard titlesMatch(calendarTitle, publicEvent.title) else { return false }
        guard let publicStart = AgendaEventInstant.parse(publicEvent.start, calendar: calendar) else { return false }
        return calendar.isDate(calendarStart, inSameDayAs: publicStart.date)
    }

    static func titlesMatch(_ lhs: String, _ rhs: String) -> Bool {
        normalizeTitle(lhs) == normalizeTitle(rhs)
    }

    private static func normalizeTitle(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    }
}

extension CalendarEventSummary {
    /// True when this Google calendar is the subscribed Envisioning public feed.
    var belongsToEnvisioningPublicFeed: Bool {
        let summary = calendarSummary.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if summary == "envisioning events" || summary.contains("envisioning events") {
            return true
        }
        // Some Google ICS subscriptions keep the filename / URL slug as the calendar name.
        if summary.contains("envisioning") && (summary.contains("event") || summary.contains("ics")) {
            return true
        }
        let link = htmlLink.lowercased()
        let conference = conferenceUrl.lowercased()
        return link.contains(EnvisioningDeployment.eventsLinkFragment)
            || conference.contains(EnvisioningDeployment.eventsLinkFragment)
    }
}

private struct AgendaDraftPreview: Equatable {
    let title: String
    let start: Date
    let end: Date
}

// MARK: - Weekend break

/// Double vertical rule between Friday and Monday when weekends are collapsed.
@MainActor
private final class AgendaWeekendSeparatorView: NSView {
    private let leftLine = NSView()
    private let rightLine = NSView()

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        widthAnchor.constraint(equalToConstant: ScheduleMeetingSheetController.weekendSeparatorWidth).isActive = true

        for line in [leftLine, rightLine] {
            line.wantsLayer = true
            line.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.secondaryText, for: line).withAlphaComponent(0.45).cgColor
            line.translatesAutoresizingMaskIntoConstraints = false
            addSubview(line)
            NSLayoutConstraint.activate([
                line.topAnchor.constraint(equalTo: topAnchor, constant: 4),
                line.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
                line.widthAnchor.constraint(equalToConstant: 1.5),
            ])
        }
        NSLayoutConstraint.activate([
            leftLine.centerXAnchor.constraint(equalTo: centerXAnchor, constant: -2),
            rightLine.centerXAnchor.constraint(equalTo: centerXAnchor, constant: 2),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

@MainActor
private final class AgendaLegendView: NSView {
    private let publicLabel = NSTextField(labelWithString: PublicEventsCalendar.legendCaption)

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        let calendar = swatchRow(color: StarlingsColors.secondaryText, title: String(localized: "Calendar"))
        let publicInfo = glyphRow(label: publicLabel)
        let stack = NSStackView(views: [calendar, publicInfo])
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 12
        addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setPublicEventCount(_ count: Int) {
        publicLabel.stringValue = count > 0
            ? "\(PublicEventsCalendar.legendCaption) · \(count)"
            : PublicEventsCalendar.legendCaption
        // A count worth mentioning is said by ink, not hue.
        publicLabel.textColor = count > 0 ? StarlingsColors.primaryText : StarlingsColors.secondaryText
    }

    private func swatchRow(color: NSColor, title: String) -> NSView {
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(10), weight: .medium)
        label.textColor = StarlingsColors.secondaryText
        return swatchRow(color: color, label: label)
    }

    private func swatchRow(color: NSColor, label: NSTextField) -> NSView {
        let swatch = NSView()
        swatch.wantsLayer = true
        swatch.layer?.backgroundColor = color.withAlphaComponent(0.55).cgColor
        swatch.layer?.borderWidth = 1
        swatch.layer?.borderColor = color.cgColor
        swatch.layer?.cornerRadius = 2
        swatch.translatesAutoresizingMaskIntoConstraints = false
        swatch.widthAnchor.constraint(equalToConstant: 10).isActive = true
        swatch.heightAnchor.constraint(equalToConstant: 10).isActive = true

        label.font = .systemFont(ofSize: StarlingsTypography.scaled(10), weight: .medium)
        if label.textColor == nil || label.stringValue == PublicEventsCalendar.legendCaption {
            label.textColor = StarlingsColors.secondaryText
        }

        let row = NSStackView(views: [swatch, label])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 5
        return row
    }

    /// The legend's public-events entry, in the same Starlings glyph
    /// `CalendarSidebarView` badges the global-interest calendar with,
    /// rather than a colour swatch — a public event is neutral now, not blue.
    private func glyphRow(label: NSTextField) -> NSView {
        let glyph = NSImageView()
        glyph.image = StarlingsBrand.glyphImage(size: 10, color: StarlingsColors.primaryText)
        glyph.imageScaling = .scaleProportionallyDown
        glyph.setAccessibilityLabel(PublicEventsCalendar.displayName)
        glyph.setContentHuggingPriority(.required, for: .horizontal)

        label.font = .systemFont(ofSize: StarlingsTypography.scaled(10), weight: .medium)
        if label.textColor == nil {
            label.textColor = StarlingsColors.secondaryText
        }

        let row = NSStackView(views: [glyph, label])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 5
        return row
    }
}

// MARK: - Agenda day column

@MainActor
private final class AgendaDayColumnView: NSView {
    let day: Date
    private let timeline: AgendaDayTimelineView
    private let header = NSView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let subtitleLabel = NSTextField(labelWithString: "")
    private let isWeekend: Bool
    private let calendar: Calendar
    private var isSelected = false

    init(
        day: Date,
        events: [CalendarEventSummary],
        publicEvents: [PublicEventsCalendar.Event],
        columnWidth: CGFloat,
        isWeekend: Bool,
        isSelected: Bool,
        calendar: Calendar,
        durationMinutes: @escaping () -> Int,
        onSelectSlot: @escaping (Date) -> Void
    ) {
        self.day = day
        self.isWeekend = isWeekend
        self.calendar = calendar
        self.isSelected = isSelected
        let timed = events.filter { AgendaEventInstant.parse($0.start, calendar: calendar)?.isAllDay != true }
        let timedPublic = publicEvents.filter { !$0.isAllDay }
        timeline = AgendaDayTimelineView(
            day: day,
            events: timed,
            publicEvents: timedPublic,
            calendar: calendar,
            durationMinutes: durationMinutes,
            onSelectSlot: onSelectSlot
        )
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = (isWeekend ? StarlingsColors.weekendColumn : StarlingsColors.elevated).cgColor
        layer?.cornerRadius = 12
        layer?.cornerCurve = .continuous
        // Border is set by `applySelectionChrome()` below, which runs at the
        // end of `init` and is the only place it needs to be set.

        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        widthAnchor.constraint(equalToConstant: columnWidth).isActive = true

        let weekday = DateFormatter()
        weekday.locale = StarlingsDateFormatting.locale
        weekday.dateFormat = "EEE"
        weekday.timeZone = calendar.timeZone
        let dayNum = DateFormatter()
        dayNum.locale = StarlingsDateFormatting.locale
        dayNum.setLocalizedDateFormatFromTemplate("d MMM")
        dayNum.timeZone = calendar.timeZone

        titleLabel.stringValue = weekday.string(from: day)
        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold)
        subtitleLabel.stringValue = dayNum.string(from: day)
        subtitleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))

        header.wantsLayer = true
        header.layer?.cornerRadius = 8
        header.layer?.cornerCurve = .continuous
        let headerStack = NSStackView(views: [titleLabel, subtitleLabel])
        headerStack.orientation = .vertical
        headerStack.alignment = .leading
        headerStack.spacing = 0
        header.addSubview(headerStack)
        headerStack.pinToEdges(of: header, insets: NSEdgeInsets(top: 6, left: 8, bottom: 6, right: 8))
        header.heightAnchor.constraint(equalToConstant: AgendaTimelineMetrics.headerHeight).isActive = true

        let allDayCalendar = events.filter { AgendaEventInstant.parse($0.start, calendar: calendar)?.isAllDay == true }
        let allDayPublic = publicEvents.filter(\.isAllDay)
        let (calendarAllDay, publicAllDay) = Self.partitionAllDayEvents(
            calendarEvents: allDayCalendar,
            publicEvents: allDayPublic,
            scheduleCalendar: calendar
        )

        let allDayStrip = AgendaAllDayStripView(events: calendarAllDay, publicEvents: publicAllDay)
        allDayStrip.heightAnchor.constraint(equalToConstant: AgendaTimelineMetrics.allDayHeight).isActive = true

        timeline.setContentHuggingPriority(.defaultLow, for: .vertical)
        timeline.setContentCompressionResistancePriority(.defaultLow, for: .vertical)

        let stack = NSStackView(views: [header, allDayStrip, timeline])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        addSubview(stack)
        stack.pinToEdges(of: self, insets: NSEdgeInsets(top: 10, left: 8, bottom: 10, right: 8))
        header.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        allDayStrip.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        timeline.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        applySelectionChrome()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setSelected(_ selected: Bool) {
        guard isSelected != selected else { return }
        isSelected = selected
        applySelectionChrome()
    }

    func updateSchedulingState(draft: AgendaDraftPreview, durationMinutes: Int) {
        timeline.updateSchedulingState(draft: draft, durationMinutes: durationMinutes)
    }

    private func applySelectionChrome() {
        let isToday = calendar.isDateInToday(day)
        let emphasizeHeader = isToday || isSelected
        layer?.borderWidth = isSelected ? 1.5 : 1
        // Weekend used to borrow the public-event blue for this border — an
        // unrelated meaning collision, not a public event. The weekend fill
        // below already carries the distinction, so the border is the same
        // neutral hairline as any other day.
        layer?.borderColor = isSelected
            ? StarlingsColors.resolved(StarlingsColors.accent, for: self).cgColor
            : StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor
        layer?.backgroundColor = (isWeekend ? StarlingsColors.weekendColumn : StarlingsColors.elevated).cgColor
        header.layer?.backgroundColor = (emphasizeHeader ? StarlingsColors.accent : NSColor.clear).cgColor
        titleLabel.textColor = emphasizeHeader ? StarlingsColors.accentInk : StarlingsColors.primaryText
        subtitleLabel.textColor = emphasizeHeader
            ? StarlingsColors.accentInk.withAlphaComponent(0.75)
            : StarlingsColors.secondaryText
    }

    /// Move Google-subscribed public-feed all-day events into the blue strip list.
    private static func partitionAllDayEvents(
        calendarEvents: [CalendarEventSummary],
        publicEvents: [PublicEventsCalendar.Event],
        scheduleCalendar: Calendar
    ) -> (calendar: [CalendarEventSummary], publicEvents: [PublicEventsCalendar.Event]) {
        var remainingPublic = publicEvents
        var calendarOnly: [CalendarEventSummary] = []
        var promoted: [PublicEventsCalendar.Event] = []

        for event in calendarEvents {
            let matchedIndex = remainingPublic.firstIndex { pub in
                guard let start = AgendaEventInstant.parse(event.start, calendar: scheduleCalendar)?.date else { return false }
                return AgendaEventMatch.overlaps(
                    calendarTitle: event.title,
                    calendarStart: start,
                    publicEvent: pub,
                    calendar: scheduleCalendar
                )
            }
            if let matchedIndex {
                promoted.append(remainingPublic.remove(at: matchedIndex))
            } else if event.belongsToEnvisioningPublicFeed {
                promoted.append(
                    PublicEventsCalendar.Event(
                        id: event.id,
                        title: event.title,
                        start: event.start,
                        end: event.end,
                        url: event.htmlLink,
                        location: ""
                    )
                )
            } else {
                calendarOnly.append(event)
            }
        }
        return (calendarOnly, promoted + remainingPublic)
    }
}

// MARK: - Time gutter + day timeline

@MainActor
private final class AgendaTimeGutterView: NSView {
    private var hourLabels: [NSTextField] = []

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: AgendaTimelineMetrics.gutterWidth).isActive = true

        for hour in AgendaTimelineMetrics.dayStartHour..<AgendaTimelineMetrics.dayEndHour {
            let label = NSTextField(labelWithString: String(format: "%02d", hour))
            label.font = .systemFont(ofSize: StarlingsTypography.scaled(10), weight: .medium)
            label.textColor = StarlingsColors.secondaryText
            label.alignment = .right
            label.isBezeled = false
            label.drawsBackground = false
            label.isEditable = false
            label.isSelectable = false
            addSubview(label)
            hourLabels.append(label)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        let labelAreaTop = AgendaTimelineMetrics.gutterTopChrome
        let labelAreaHeight = max(
            AgendaTimelineMetrics.timelineHeight,
            bounds.height - AgendaTimelineMetrics.gutterTopChrome - AgendaTimelineMetrics.gutterBottomChrome
        )
        let hourHeight = labelAreaHeight / CGFloat(AgendaTimelineMetrics.hourCount)
        for (index, label) in hourLabels.enumerated() {
            label.frame = NSRect(
                x: 0,
                y: labelAreaTop + CGFloat(index) * hourHeight - 1,
                width: AgendaTimelineMetrics.gutterWidth - 2,
                height: 14
            )
        }
    }
}

@MainActor
private final class AgendaAllDayStripView: NSView {
    init(events: [CalendarEventSummary], publicEvents: [PublicEventsCalendar.Event] = []) {
        super.init(frame: .zero)
        wantsLayer = true
        let hasPublic = !publicEvents.isEmpty
        let hasCalendar = !events.isEmpty
        // Public used to fill and border this strip in its own blue; neutral
        // fill/border plus the Starlings glyph below carry the same information.
        layer?.backgroundColor = (hasPublic && !hasCalendar ? StarlingsColors.elevated : StarlingsColors.panel).cgColor
        layer?.cornerRadius = 5
        layer?.cornerCurve = .continuous
        if hasPublic {
            layer?.borderWidth = 1
            layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor
        }

        let label = NSTextField(labelWithString: stripLabel(events: events, publicEvents: publicEvents))
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(10), weight: .medium)
        if hasCalendar || hasPublic {
            label.textColor = StarlingsColors.secondaryText
        } else {
            label.textColor = .clear
            label.stringValue = " "
        }
        label.lineBreakMode = .byTruncatingTail
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        var rowViews: [NSView] = []
        if hasPublic && !hasCalendar {
            // The same Starlings glyph badge as the legend and the sidebar's
            // global-interest calendar, so a public event still reads apart
            // from an ordinary one without a hue of its own.
            let glyph = NSImageView()
            glyph.image = StarlingsBrand.glyphImage(size: 10, color: StarlingsColors.primaryText)
            glyph.imageScaling = .scaleProportionallyDown
            glyph.setAccessibilityLabel(PublicEventsCalendar.displayName)
            glyph.setContentHuggingPriority(.required, for: .horizontal)
            rowViews.append(glyph)
        }
        rowViews.append(label)
        let row = NSStackView(views: rowViews)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 4
        addSubview(row)
        row.pinToEdges(of: self, insets: NSEdgeInsets(top: 2, left: 6, bottom: 2, right: 6))
        alphaValue = (hasCalendar || hasPublic) ? 1 : 0.35
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func stripLabel(
        events: [CalendarEventSummary],
        publicEvents: [PublicEventsCalendar.Event]
    ) -> String {
        if events.isEmpty, publicEvents.count == 1 {
            return publicEvents[0].title
        }
        if events.isEmpty, publicEvents.count > 1 {
            return String(localized: "\(publicEvents.count) public")
        }
        if publicEvents.isEmpty, events.count == 1 {
            return events[0].title
        }
        if publicEvents.isEmpty {
            return String(localized: "\(events.count) all-day")
        }
        return String(localized: "\(events.count + publicEvents.count) all-day")
    }
}

@MainActor
private final class AgendaDayTimelineView: NSView {
    private struct TimedEvent {
        let title: String
        let start: Date
        let end: Date
        let kind: AgendaTimedEventBlock.Kind
        /// Only calendar events block scheduling.
        let blocksScheduling: Bool
    }

    private let day: Date
    private let calendar: Calendar
    private let timedEvents: [TimedEvent]
    private let busyEvents: [TimedEvent]
    private let onSelectSlot: (Date) -> Void
    private var slotLines: [NSView] = []
    private var blocks: [AgendaTimedEventBlock] = []
    private var draftBlock: AgendaDraftEventBlock?
    private var hoverGhost: AgendaDraftEventBlock?
    private var nowLine: NSView?
    private var hoverSlotIndex: Int?
    private var trackingArea: NSTrackingArea?
    private var draftPreview: AgendaDraftPreview?
    private var schedulingDurationMinutes = 60

    init(
        day: Date,
        events: [CalendarEventSummary],
        publicEvents: [PublicEventsCalendar.Event] = [],
        calendar: Calendar,
        durationMinutes: @escaping () -> Int,
        onSelectSlot: @escaping (Date) -> Void
    ) {
        self.day = day
        self.calendar = calendar
        self.onSelectSlot = onSelectSlot
        self.schedulingDurationMinutes = durationMinutes()

        var remainingPublic = publicEvents
        var calendarTimed: [TimedEvent] = []
        var publicTimed: [TimedEvent] = []

        for event in events {
            guard let start = AgendaEventInstant.parse(event.start, calendar: calendar)?.date else { continue }
            let end = AgendaEventInstant.parse(event.end, calendar: calendar)?.date
                ?? start.addingTimeInterval(30 * 60)
            let matchedPublicIndex = remainingPublic.firstIndex { pub in
                AgendaEventMatch.overlaps(
                    calendarTitle: event.title,
                    calendarStart: start,
                    publicEvent: pub,
                    calendar: calendar
                )
            }
            let fromPublicCalendar = event.belongsToEnvisioningPublicFeed
            if let matchedPublicIndex {
                remainingPublic.remove(at: matchedPublicIndex)
            }

            if fromPublicCalendar || matchedPublicIndex != nil {
                // Subscribed ICS copy (or title/time match): paint blue, still busy.
                publicTimed.append(
                    TimedEvent(
                        title: event.title,
                        start: start,
                        end: end,
                        kind: .publicInfo,
                        blocksScheduling: true
                    )
                )
            } else {
                calendarTimed.append(
                    TimedEvent(
                        title: event.title,
                        start: start,
                        end: end,
                        kind: .calendar,
                        blocksScheduling: true
                    )
                )
            }
        }

        for event in remainingPublic {
            guard let start = AgendaEventInstant.parse(event.start, calendar: calendar)?.date else { continue }
            let end = AgendaEventInstant.parse(event.end, calendar: calendar)?.date
                ?? start.addingTimeInterval(60 * 60)
            publicTimed.append(
                TimedEvent(
                    title: event.title,
                    start: start,
                    end: end,
                    kind: .publicInfo,
                    blocksScheduling: false
                )
            )
        }

        // Lime calendar first, blue public on top so Google-subscribed copies don't hide the feed.
        self.timedEvents = calendarTimed + publicTimed
        self.busyEvents = (calendarTimed + publicTimed).filter(\.blocksScheduling)
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.panel, for: self).withAlphaComponent(0.55).cgColor
        layer?.cornerRadius = 8
        layer?.cornerCurve = .continuous
        layer?.masksToBounds = true
        translatesAutoresizingMaskIntoConstraints = false
        setContentHuggingPriority(.defaultLow, for: .vertical)
        setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        heightAnchor.constraint(greaterThanOrEqualToConstant: AgendaTimelineMetrics.timelineHeight).isActive = true

        for slotIndex in 0..<AgendaTimelineMetrics.slotCount {
            let line = NSView()
            line.wantsLayer = true
            line.layer?.backgroundColor = (slotIndex.isMultiple(of: 2)
                ? StarlingsColors.border
                : StarlingsColors.border.withAlphaComponent(0.45)).cgColor
            addSubview(line)
            slotLines.append(line)
        }

        for timed in timedEvents {
            let block = AgendaTimedEventBlock(
                title: timed.title,
                start: timed.start,
                end: timed.end,
                kind: timed.kind,
                timeZone: calendar.timeZone
            )
            blocks.append(block)
            addSubview(block)
        }

        let hover = AgendaDraftEventBlock(style: .ghost, timeZone: calendar.timeZone)
        hover.isHidden = true
        addSubview(hover)
        hoverGhost = hover

        let draft = AgendaDraftEventBlock(style: .selected, timeZone: calendar.timeZone)
        draft.isHidden = true
        addSubview(draft)
        draftBlock = draft

        if calendar.isDateInToday(day) {
            let line = NSView()
            line.wantsLayer = true
            line.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.accent, for: line).cgColor
            addSubview(line)
            nowLine = line
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var isFlipped: Bool { true }

    func updateSchedulingState(draft: AgendaDraftPreview, durationMinutes: Int) {
        draftPreview = draft
        schedulingDurationMinutes = durationMinutes
        needsLayout = true
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea {
            removeTrackingArea(trackingArea)
        }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.activeInKeyWindow, .mouseMoved, .mouseEnteredAndExited, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingArea = area
    }

    override func layout() {
        super.layout()
        let timelineHeight = bounds.height
        let width = bounds.width
        let slotHeight = timelineHeight / CGFloat(AgendaTimelineMetrics.slotCount)

        for slotIndex in 0..<AgendaTimelineMetrics.slotCount {
            slotLines[slotIndex].frame = NSRect(
                x: 0,
                y: CGFloat(slotIndex) * slotHeight,
                width: width,
                height: 1
            )
        }

        for (block, timed) in zip(blocks, timedEvents) {
            let top = AgendaTimelineMetrics.yOffset(for: timed.start, on: day, timelineHeight: timelineHeight, calendar: calendar)
            let height = AgendaTimelineMetrics.blockHeight(
                from: timed.start,
                to: timed.end,
                on: day,
                timelineHeight: timelineHeight,
                calendar: calendar
            )
            guard top < timelineHeight else {
                block.isHidden = true
                continue
            }
            block.isHidden = false
            // Nudge public info blocks so overlapping calendar events stay readable.
            let leading: CGFloat = timed.kind == .publicInfo ? 7 : 3
            let trailing: CGFloat = timed.kind == .publicInfo ? 3 : 6
            block.frame = NSRect(
                x: leading,
                y: top,
                width: max(24, width - leading - trailing),
                height: min(height, timelineHeight - top)
            )
        }

        layoutDraftBlock(width: width, timelineHeight: timelineHeight)
        layoutHoverGhost(width: width, timelineHeight: timelineHeight, slotHeight: slotHeight)

        if let nowLine {
            let y = AgendaTimelineMetrics.yOffset(for: Date(), on: day, timelineHeight: timelineHeight, calendar: calendar)
            nowLine.frame = NSRect(x: 0, y: y, width: width, height: 2)
            nowLine.isHidden = y > timelineHeight
            addSubview(nowLine, positioned: .above, relativeTo: nil)
        }
    }

    private func layoutDraftBlock(width: CGFloat, timelineHeight: CGFloat) {
        guard let draft = draftPreview,
              calendar.isDate(draft.start, inSameDayAs: day),
              let draftBlock else {
            draftBlock?.isHidden = true
            return
        }
        let top = AgendaTimelineMetrics.yOffset(for: draft.start, on: day, timelineHeight: timelineHeight, calendar: calendar)
        let height = AgendaTimelineMetrics.blockHeight(
            from: draft.start,
            to: draft.end,
            on: day,
            timelineHeight: timelineHeight,
            calendar: calendar
        )
        guard top < timelineHeight else {
            draftBlock.isHidden = true
            return
        }
        draftBlock.update(title: draft.title, start: draft.start, end: draft.end)
        draftBlock.frame = NSRect(x: 2, y: top, width: width - 4, height: min(height, timelineHeight - top))
        draftBlock.isHidden = false
        addSubview(draftBlock, positioned: .above, relativeTo: nil)
    }

    private func layoutHoverGhost(width: CGFloat, timelineHeight: CGFloat, slotHeight: CGFloat) {
        guard let hoverGhost,
              let slotIndex = hoverSlotIndex,
              let start = slotStart(forSlotIndex: slotIndex),
              isAvailable(start: start, durationMinutes: schedulingDurationMinutes),
              let end = calendar.date(byAdding: .minute, value: schedulingDurationMinutes, to: start)
        else {
            hoverGhost?.isHidden = true
            return
        }

        // If hovering the already-selected draft start, keep the draft block only.
        if let draft = draftPreview, abs(draft.start.timeIntervalSince(start)) < 1 {
            hoverGhost.isHidden = true
            return
        }

        let top = CGFloat(slotIndex) * slotHeight
        let height = durationHeight(slotHeight: slotHeight)
        hoverGhost.update(title: String(localized: "New meeting"), start: start, end: end)
        hoverGhost.frame = NSRect(x: 2, y: top, width: width - 4, height: min(height, timelineHeight - top))
        hoverGhost.isHidden = false
        addSubview(hoverGhost, positioned: .above, relativeTo: nil)
        if let draftBlock, !draftBlock.isHidden {
            addSubview(draftBlock, positioned: .above, relativeTo: hoverGhost)
        }
    }

    private func durationHeight(slotHeight: CGFloat) -> CGFloat {
        let slots = CGFloat(schedulingDurationMinutes) / CGFloat(AgendaTimelineMetrics.slotMinutes)
        return slots * slotHeight
    }

    override func mouseMoved(with event: NSEvent) {
        updateHover(at: convert(event.locationInWindow, from: nil))
    }

    override func mouseExited(with event: NSEvent) {
        hoverSlotIndex = nil
        needsLayout = true
        NSCursor.arrow.set()
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard let slotIndex = slotIndex(at: point),
              let start = slotStart(forSlotIndex: slotIndex),
              isAvailable(start: start, durationMinutes: schedulingDurationMinutes) else {
            return
        }
        onSelectSlot(start)
    }

    private func updateHover(at point: NSPoint) {
        guard let slotIndex = slotIndex(at: point),
              let start = slotStart(forSlotIndex: slotIndex),
              isAvailable(start: start, durationMinutes: schedulingDurationMinutes) else {
            if hoverSlotIndex != nil {
                hoverSlotIndex = nil
                needsLayout = true
            }
            NSCursor.arrow.set()
            return
        }
        if hoverSlotIndex != slotIndex {
            hoverSlotIndex = slotIndex
            needsLayout = true
        }
        NSCursor.pointingHand.set()
    }

    private func slotIndex(at point: NSPoint) -> Int? {
        guard bounds.height > 0, point.y >= 0, point.y < bounds.height else { return nil }
        let slotHeight = bounds.height / CGFloat(AgendaTimelineMetrics.slotCount)
        let index = Int(point.y / slotHeight)
        guard index >= 0, index < AgendaTimelineMetrics.slotCount else { return nil }
        return index
    }

    private func slotStart(forSlotIndex slotIndex: Int) -> Date? {
        let dayStart = calendar.startOfDay(for: day)
        guard let gridStart = calendar.date(
            byAdding: .hour,
            value: AgendaTimelineMetrics.dayStartHour,
            to: dayStart
        ) else { return nil }
        return calendar.date(
            byAdding: .minute,
            value: slotIndex * AgendaTimelineMetrics.slotMinutes,
            to: gridStart
        )
    }

    /// Slot is free when the full meeting duration fits without overlapping busy calendar events.
    /// Public Envisioning events are info-only and do not block scheduling.
    private func isAvailable(start: Date, durationMinutes: Int) -> Bool {
        if start < Date() { return false }
        guard let end = calendar.date(byAdding: .minute, value: durationMinutes, to: start) else {
            return false
        }
        for busy in busyEvents {
            if start < busy.end && end > busy.start {
                return false
            }
        }
        return true
    }
}

@MainActor
private final class AgendaDraftEventBlock: NSView {
    enum Style {
        case selected
        case ghost
    }

    private let timeLabel = NSTextField(labelWithString: "")
    private let titleLabel = NSTextField(labelWithString: "")
    private let stack: NSStackView
    private let timeZone: TimeZone

    init(style: Style = .selected, timeZone: TimeZone = .autoupdatingCurrent) {
        self.timeZone = timeZone
        stack = NSStackView()
        super.init(frame: .zero)
        wantsLayer = true
        switch style {
        case .selected:
            layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.accent, for: self).withAlphaComponent(0.42).cgColor
            layer?.borderWidth = 2
            layer?.borderColor = StarlingsColors.resolved(StarlingsColors.accent, for: self).cgColor
        case .ghost:
            layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.accent, for: self).withAlphaComponent(0.18).cgColor
            layer?.borderWidth = 1.5
            layer?.borderColor = StarlingsColors.resolved(StarlingsColors.accent, for: self).withAlphaComponent(0.7).cgColor
        }
        layer?.cornerRadius = 4
        layer?.cornerCurve = .continuous

        timeLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(9), weight: .bold)
        timeLabel.textColor = StarlingsColors.accentInk
        timeLabel.lineBreakMode = .byTruncatingTail
        timeLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        timeLabel.isBezeled = false
        timeLabel.drawsBackground = false

        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(10), weight: .semibold)
        titleLabel.textColor = StarlingsColors.accentInk
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        titleLabel.maximumNumberOfLines = 2
        titleLabel.isBezeled = false
        titleLabel.drawsBackground = false

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 1
        stack.addArrangedSubview(timeLabel)
        stack.addArrangedSubview(titleLabel)
        addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 5),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -5),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 3),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -3),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        // Short blocks: title wins; position on the grid already implies the time.
        timeLabel.isHidden = bounds.height < 34
        titleLabel.maximumNumberOfLines = timeLabel.isHidden ? 1 : 2
    }

    func update(title: String, start: Date, end: Date) {
        let range = "\(StarlingsDateFormatting.time(start, timeZone: timeZone))–\(StarlingsDateFormatting.time(end, timeZone: timeZone))"
        timeLabel.stringValue = range
        titleLabel.stringValue = title
        needsLayout = true
    }
}

@MainActor
private final class AgendaTimedEventBlock: NSView {
    enum Kind {
        case calendar
        case publicInfo
    }

    private let timeLabel: NSTextField
    private let titleLabel: NSTextField

    init(
        title: String,
        start: Date,
        end: Date,
        kind: Kind = .calendar,
        timeZone: TimeZone = .autoupdatingCurrent
    ) {
        let range = "\(StarlingsDateFormatting.time(start, timeZone: timeZone))–\(StarlingsDateFormatting.time(end, timeZone: timeZone))"

        timeLabel = NSTextField(labelWithString: range)
        titleLabel = NSTextField(labelWithString: title)
        super.init(frame: .zero)
        wantsLayer = true
        // Public used to fill and border in its own blue; neutral chrome plus
        // the Starlings glyph badge below carry the same information without a hue.
        switch kind {
        case .calendar:
            layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: self).cgColor
            layer?.borderWidth = 1
        case .publicInfo:
            layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: self).cgColor
            layer?.borderWidth = 1.5
        }
        layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor
        timeLabel.textColor = StarlingsColors.secondaryText
        titleLabel.textColor = StarlingsColors.primaryText
        layer?.cornerRadius = 4
        layer?.cornerCurve = .continuous

        timeLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(9), weight: .semibold)
        timeLabel.lineBreakMode = .byTruncatingTail
        timeLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        timeLabel.isBezeled = false
        timeLabel.drawsBackground = false

        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(10), weight: .medium)
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        titleLabel.maximumNumberOfLines = 2
        titleLabel.isBezeled = false
        titleLabel.drawsBackground = false

        let topRow: NSView
        if kind == .publicInfo {
            let glyph = NSImageView()
            glyph.image = StarlingsBrand.glyphImage(size: 8, color: StarlingsColors.primaryText)
            glyph.imageScaling = .scaleProportionallyDown
            glyph.setAccessibilityLabel(PublicEventsCalendar.displayName)
            glyph.setContentHuggingPriority(.required, for: .horizontal)
            let glyphRow = NSStackView(views: [glyph, timeLabel])
            glyphRow.orientation = .horizontal
            glyphRow.alignment = .centerY
            glyphRow.spacing = 3
            topRow = glyphRow
        } else {
            topRow = timeLabel
        }

        let stack = NSStackView(views: [topRow, titleLabel])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 1
        addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 5),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -5),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 3),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -3),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        // 30-min (and other short) blocks: keep the title; time is readable from the grid.
        timeLabel.isHidden = bounds.height < 34
        titleLabel.maximumNumberOfLines = timeLabel.isHidden ? 1 : 2
    }
}

struct ScheduleMeetingDraft: Equatable, Sendable {
    let title: String
    let start: Date
    let end: Date
    let attendees: [String]
    let joinURL: String
    let roomSlug: String
    let timeZoneIdentifier: String
}

extension NSViewController {
    /// Presents a resizable sheet window.
    ///
    /// Deliberately *not* named `presentAsSheet`: that is AppKit's own method,
    /// and a same-module extension shadows it at every call site in this target.
    /// A caller who wrote the correct AppKit pairing — `presentAsSheet` then
    /// `dismiss(child)` — would land here instead and find `dismiss` a no-op,
    /// because the child lives in this window rather than in AppKit's
    /// presentation stack. Close it with `closeSheetWindow()`.
    func presentInSheetWindow(_ child: NSViewController) {
        guard let parentWindow = view.window else { return }
        let size = child.preferredContentSize == .zero
            ? NSSize(width: 920, height: 720)
            : child.preferredContentSize
        let sheetWindow = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        let sheetTitle = child.title ?? ""
        sheetWindow.title = sheetTitle.isEmpty ? String(localized: "Schedule meeting") : sheetTitle
        sheetWindow.contentViewController = child
        // Assigning a content view controller re-sizes the window to the
        // view's fitting size, so an under-constrained child gets to decide
        // the sheet is 40pt wide. The size asked for above is the one that
        // ships.
        sheetWindow.setContentSize(size)
        sheetWindow.isReleasedWhenClosed = false
        sheetWindow.minSize = NSSize(width: 780, height: 620)
        sheetWindow.center()
        parentWindow.beginSheet(sheetWindow) { _ in
            sheetWindow.orderOut(nil)
        }
    }

    /// The counterpart to `presentInSheetWindow`, callable on the child or on
    /// anything else inside the sheet. `dismiss` cannot close these sheets.
    func closeSheetWindow() {
        guard let sheetWindow = view.window else {
            dismiss(nil)
            return
        }
        if let parent = sheetWindow.sheetParent {
            parent.endSheet(sheetWindow)
        } else {
            sheetWindow.close()
        }
    }
}
