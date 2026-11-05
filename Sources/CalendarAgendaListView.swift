import AppKit

/// A grouped "what's next" list: day headers, then one row per event.
///
/// Shared by the calendar sidebar and the menu bar panel so the two never
/// drift into describing the same day differently.
@MainActor
final class CalendarAgendaListView: NSView {
    var onSelect: ((String) -> Void)?
    /// The reader scrolled the list to a different day. Reported once the
    /// scroll settles, never mid-flick: a scroll through three weeks would
    /// otherwise drag the grid across every period on the way past.
    var onFocusDay: ((Date) -> Void)?
    /// Double-click, or the join affordance on an event that has a link.
    var onActivate: ((StarlingsCalendarEvent) -> Void)?
    var colorForCalendar: ((String) -> StarlingsRGBColor) = { _ in StarlingsRGBColor.fallback(at: 0) }
    var selectedEventID: String? {
        didSet { refreshSelection() }
    }
    /// Shown when there is nothing in range.
    var emptyMessage = String(localized: "Nothing scheduled")

    private let scrollView = NSScrollView()
    private let stack = NSStackView()
    private var rows: [CalendarAgendaRowView] = []
    /// What the last `render` actually drew. A load publishes several times —
    /// what was cached, then what is local, then what the network says — and
    /// most of those say nothing new about the agenda. Rebuilding an identical
    /// list is pure flicker: every row is torn down and made again.
    private var renderedSignature: Int?
    /// Each day header that got drawn, in order, so pointing the calendar at a
    /// day can scroll to it rather than redraw the list around it.
    private var dayAnchors: [(day: Date, view: NSView)] = []
    /// Nothing has been drawn yet, so there is no position to glide from.
    private var hasRendered = false
    /// Whether the movement being watched is the reader's own hand. Only a
    /// live scroll — trackpad, wheel, scroller — sets this; nothing this view
    /// does to its own scroll position ever will. That asymmetry is the whole
    /// safeguard: a flag saying "I am scrolling right now" cannot survive two
    /// overlapping animations, and a missed reset turns the grid's own scroll
    /// into a report that moves the grid again.
    private var sawLiveScroll = false
    private var settleTask: Task<Void, Never>?
    /// The day this list just told the grid about. The grid answers by pointing
    /// at it, which comes straight back here as "scroll to that day" — and the
    /// reader, who put the list exactly where they wanted it, would watch it
    /// snap somewhere else. Consumed once, then forgotten.
    private var dayReportedFromScroll: Date?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 2
        stack.edgeInsets = NSEdgeInsets(top: 4, left: 0, bottom: 8, right: 0)
        stack.translatesAutoresizingMaskIntoConstraints = false

        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.borderType = .noBorder
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        let clip = AgendaFlippedClipView()
        clip.drawsBackground = false
        clip.postsBoundsChangedNotifications = true
        scrollView.contentView = clip
        scrollView.documentView = stack
        let center = NotificationCenter.default
        center.addObserver(
            self,
            selector: #selector(liveScrollBegan),
            name: NSScrollView.willStartLiveScrollNotification,
            object: scrollView
        )
        center.addObserver(
            self,
            selector: #selector(clipBoundsChanged),
            name: NSView.boundsDidChangeNotification,
            object: clip
        )
        center.addObserver(
            self,
            selector: #selector(clipBoundsChanged),
            name: NSScrollView.didEndLiveScrollNotification,
            object: scrollView
        )

        addSubview(scrollView)
        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Group `events` by day, starting at `start`, for `days` days.
    func render(events: [StarlingsCalendarEvent], start: Date, days: Int) {
        let signature = Self.signature(
            events: events,
            start: start,
            days: days,
            empty: emptyMessage,
            color: colorForCalendar
        )
        guard signature != renderedSignature else {
            refreshSelection()
            return
        }
        renderedSignature = signature
        dayAnchors = []
        // A rebuilt list is a different list; wherever the reader had it is
        // gone, so it does need positioning at the focused day.
        dayReportedFromScroll = nil

        // Emptying the stack collapses it to nothing for one layout pass, and
        // the clip view clamps its origin to zero while there is nothing to
        // scroll. Put the reader back where they were afterwards rather than
        // snapping them to the top of the list.
        let origin = scrollView.contentView.bounds.origin
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        rows = []

        let calendar = Calendar.current
        let from = calendar.startOfDay(for: start)
        var shown = 0

        for offset in 0..<max(1, days) {
            guard let day = calendar.date(byAdding: .day, value: offset, to: from) else { continue }
            let onThisDay = events
                .filter { event in
                    if event.isAllDay {
                        return CalendarWeekMath.allDayDayRange(event, days: [day], calendar: calendar) != nil
                    }
                    return CalendarWeekMath.daySegment(for: event, day: day, calendar: calendar) != nil
                }
                .sorted { left, right in
                    if left.isAllDay != right.isAllDay { return left.isAllDay }
                    return left.start < right.start
                }
            guard !onThisDay.isEmpty else { continue }

            let header = makeDayHeader(day, calendar: calendar)
            dayAnchors.append((day, header))
            stack.addArrangedSubview(header)
            for event in onThisDay {
                let row = CalendarAgendaRowView(
                    event: event,
                    color: colorForCalendar(event.calendarID),
                    day: day
                )
                row.onSelect = { [weak self] id in self?.onSelect?(id) }
                row.onActivate = { [weak self] item in self?.onActivate?(item) }
                stack.addArrangedSubview(row)
                row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
                rows.append(row)
                shown += 1
            }
        }

        if shown == 0 {
            let empty = NSTextField(labelWithString: emptyMessage)
            empty.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
            empty.textColor = StarlingsColors.secondaryText
            stack.addArrangedSubview(empty)
        }
        refreshSelection()
        layoutSubtreeIfNeeded()
        beginProgrammaticScroll()
        scrollView.contentView.scroll(to: origin)
        scrollView.reflectScrolledClipView(scrollView.contentView)
        hasRendered = true
    }


    /// Everything that decides what the list looks like — which events, in
    /// which order, at which heights, in which colours. Deliberately not the
    /// selection: that is a property with its own `didSet` and does not need a
    /// rebuild to show.
    private static func signature(
        events: [StarlingsCalendarEvent],
        start: Date,
        days: Int,
        empty: String,
        color: (String) -> StarlingsRGBColor
    ) -> Int {
        var hasher = Hasher()
        hasher.combine(start)
        hasher.combine(days)
        hasher.combine(empty)
        for event in events {
            hasher.combine(event.id)
            hasher.combine(event.start)
            hasher.combine(event.end)
            hasher.combine(event.isAllDay)
            hasher.combine(event.displayTitle)
            // A row with either of these is two lines tall rather than one.
            hasher.combine(event.location)
            hasher.combine(event.joinURL)
            hasher.combine(event.travelTimeMinutes)
            hasher.combine(event.myResponse?.rawValue)
            hasher.combine(event.isDemoted)
            let rgb = color(event.calendarID)
            hasher.combine(rgb.red)
            hasher.combine(rgb.green)
            hasher.combine(rgb.blue)
        }
        return hasher.finalize()
    }

    /// Bring `day` to the top of the list.
    ///
    /// The list spans the whole loaded period, not the pointed-at day forward,
    /// so moving between days inside it is a scroll and not a rebuild. That is
    /// the difference between the sidebar following the grid sideways and the
    /// sidebar flickering every time the grid crosses midnight.
    func focus(day: Date) {
        layoutSubtreeIfNeeded()
        let calendar = Calendar.current
        let target = calendar.startOfDay(for: day)
        // The day itself when it has anything on it, otherwise the next day
        // that does — an empty Tuesday should not scroll the list to nowhere.
        let anchor = dayAnchors.first { $0.day >= target } ?? dayAnchors.last
        let top = anchor.map { $0.view.frame.minY } ?? 0
        let clip = scrollView.contentView
        let maximum = max(0, stack.frame.height - clip.bounds.height)
        let destination = NSPoint(x: 0, y: min(max(0, top), maximum))
        if dayReportedFromScroll == target {
            dayReportedFromScroll = nil
            return
        }
        guard abs(destination.y - clip.bounds.origin.y) > 0.5 else { return }

        // Nothing on screen to glide from on the very first draw.
        beginProgrammaticScroll()
        guard hasRendered else {
            clip.scroll(to: destination)
            scrollView.reflectScrolledClipView(clip)
            return
        }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.22
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            context.allowsImplicitAnimation = true
            clip.animator().setBoundsOrigin(destination)
            // Inside the group, not after it: this is what keeps the scroller
            // travelling with the content instead of snapping at the end.
            scrollView.reflectScrolledClipView(clip)
        }, completionHandler: { [weak self] in
            guard let self else { return }
            scrollView.reflectScrolledClipView(clip)
        })
    }

    /// A hand scroll. Reported only once it settles — during a flick the day
    /// under the top edge changes every frame, and every one of those would be
    /// a period change and a fetch for the grid.
    @objc private func liveScrollBegan() {
        sawLiveScroll = true
    }

    /// Restarted by every frame of the reader's scroll, including the momentum
    /// after they let go, so the grid is told once — where they landed — and
    /// not once per week they passed on the way.
    @objc private func clipBoundsChanged() {
        guard sawLiveScroll, onFocusDay != nil else { return }
        settleTask?.cancel()
        settleTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(140))
            guard !Task.isCancelled, let self else { return }
            sawLiveScroll = false
            reportDayAtTop()
        }
    }

    /// This view is about to move its own scroll position. Anything the reader
    /// was in the middle of is over, and nothing that follows is theirs.
    private func beginProgrammaticScroll() {
        settleTask?.cancel()
        settleTask = nil
        sawLiveScroll = false
    }

    private func reportDayAtTop() {
        guard !dayAnchors.isEmpty else { return }
        // The last header at or above the top edge — the day whose events the
        // reader is looking at, not the next one coming up.
        let top = scrollView.contentView.bounds.origin.y
        let landed = dayAnchors.last { $0.view.frame.minY <= top + 1 } ?? dayAnchors[0]
        dayReportedFromScroll = landed.day
        onFocusDay?(landed.day)
    }

    private func refreshSelection() {
        for row in rows { row.setSelected(row.eventID == selectedEventID) }
    }

    func refreshPastState() {
        for row in rows { row.refreshPastState() }
    }

    private func makeDayHeader(_ day: Date, calendar: Calendar) -> NSView {
        let name: String
        if calendar.isDateInToday(day) {
            name = "TODAY"
        } else if calendar.isDateInTomorrow(day) {
            name = "TOMORROW"
        } else {
            let formatter = DateFormatter()
            formatter.locale = .current
            formatter.setLocalizedDateFormatFromTemplate("EEEE")
            name = formatter.string(from: day).uppercased()
        }

        let dateFormatter = DateFormatter()
        dateFormatter.locale = .current
        dateFormatter.setLocalizedDateFormatFromTemplate("d MMM")

        let title = NSTextField(labelWithString: name)
        title.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .bold)
        title.textColor = calendar.isDateInToday(day) ? StarlingsColors.accentMark : StarlingsColors.primaryText

        let date = NSTextField(labelWithString: dateFormatter.string(from: day))
        date.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        date.textColor = StarlingsColors.secondaryText

        let row = NSStackView(views: [title, date, NSView()])
        row.orientation = .horizontal
        row.spacing = 6
        row.alignment = .firstBaseline
        row.edgeInsets = NSEdgeInsets(top: 10, left: 0, bottom: 2, right: 0)
        return row
    }
}

/// One event line: colour dot, time, title, and where it is.
@MainActor
final class CalendarAgendaRowView: NSView {
    let eventID: String
    var onSelect: ((String) -> Void)?
    var onActivate: ((StarlingsCalendarEvent) -> Void)?

    private let event: StarlingsCalendarEvent
    private let dot = NSView()
    private var isSelected = false

    init(event: StarlingsCalendarEvent, color: StarlingsRGBColor, day: Date) {
        self.event = event
        eventID = event.id
        super.init(frame: .zero)
        refreshPastState()
        wantsLayer = true
        layer?.cornerRadius = 5
        trackMeetHover { [weak self] _ in self?.paint() }

        dot.wantsLayer = true
        dot.layer?.cornerRadius = 5
        dot.translatesAutoresizingMaskIntoConstraints = false
        // A hollow dot reads as "not answered", matching the grid's outline.
        if event.myResponse == .needsAction {
            dot.layer?.borderWidth = 2
            dot.layer?.borderColor = color.nsColor.cgColor
            dot.layer?.backgroundColor = NSColor.clear.cgColor
        } else {
            dot.layer?.backgroundColor = color.nsColor
                .withAlphaComponent(event.myResponse == .declined ? 0.4 : 1)
                .cgColor
        }
        NSLayoutConstraint.activate([
            dot.widthAnchor.constraint(equalToConstant: 10),
            dot.heightAnchor.constraint(equalToConstant: 10),
        ])

        let time = NSTextField(labelWithString: Self.timeLabel(event, day: day))
        time.font = .monospacedDigitSystemFont(ofSize: StarlingsTypography.scaled(11), weight: .medium)
        time.textColor = StarlingsColors.secondaryText

        let title = NSTextField(labelWithString: event.displayTitle)
        title.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .medium)
        title.textColor = event.myResponse == .declined ? StarlingsColors.secondaryText : StarlingsColors.primaryText
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let platformIcon = NSImageView()
        platformIcon.image = CalendarMeetingPlatformMark.image(
            for: event.meetingPlatform,
            size: 14,
            color: event.meetingPlatform == .starlings ? StarlingsColors.accentMark : StarlingsColors.secondaryText
        )
        platformIcon.isHidden = event.meetingPlatform == .none
        platformIcon.setContentHuggingPriority(.required, for: .horizontal)
        platformIcon.setContentCompressionResistancePriority(.required, for: .horizontal)

        // Who else is coming, beside the platform: the row answers both
        // questions before the title is read.
        let guests = NSImageView()
        if let attendance = event.attendance {
            guests.image = CalendarAttendanceMark.image(
                for: attendance,
                size: 14,
                color: CalendarAttendanceMark.color(for: attendance, declined: event.myResponse == .declined)
            )
            guests.setAccessibilityLabel(attendance.label)
        }
        guests.isHidden = event.attendance == nil
        guests.setContentHuggingPriority(.required, for: .horizontal)
        guests.setContentCompressionResistancePriority(.required, for: .horizontal)

        let heading = NSStackView(views: [time, platformIcon, guests, title])
        heading.orientation = .horizontal
        heading.spacing = 6
        heading.alignment = .firstBaseline

        var column: [NSView] = [heading]
        let detail = event.location.isEmpty ? event.joinURL : event.location
        let subtitleText = [detail, CalendarTravelTime.label(minutes: event.travelTimeMinutes)]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
        if !subtitleText.isEmpty {
            let subtitle = NSTextField(labelWithString: subtitleText)
            subtitle.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            subtitle.textColor = StarlingsColors.secondaryText
            subtitle.lineBreakMode = .byTruncatingTail
            subtitle.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            column.append(subtitle)
        }

        let text = NSStackView(views: column)
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 1

        // Ours carries our mark in the corner here too, so a global-interest
        // event is the same thing in the agenda as it is in the grid.
        var trailing: [NSView] = []
        if event.calendarRole == .globalInterest && event.meetingPlatform == .none {
            let glyph = NSImageView()
            glyph.image = StarlingsBrand.glyphImage(size: 14, color: StarlingsColors.primaryText)
            glyph.imageScaling = .scaleProportionallyDown
            glyph.setContentHuggingPriority(.required, for: .horizontal)
            glyph.setAccessibilityLabel(CalendarSemanticRole.globalInterest.title)
            trailing = [NSView(), glyph]
        }

        let row = NSStackView(views: [dot, text] + trailing)
        row.orientation = .horizontal
        row.alignment = .top
        row.spacing = 8
        row.edgeInsets = NSEdgeInsets(top: 5, left: 6, bottom: 5, right: 6)
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(CalendarAccessibility.describe(event, calendarName: nil))
        alphaValue = event.isDemoted ? CalendarEventChrome.demotedOpacity : 1
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setSelected(_ selected: Bool) {
        isSelected = selected
        paint()
    }

    /// Rows lift by half under the pointer (DESIGN.md), over the selected
    /// tint or over nothing.
    private func paint() {
        let base = isSelected
            ? StarlingsColors.resolved(StarlingsColors.accent, for: self).withAlphaComponent(0.16)
            : NSColor.clear
        let hovered = meetHoverMonitor?.isHovered ?? false
        layer?.backgroundColor = (hovered ? StarlingsColors.lifted(base, by: StarlingsColors.rowHoverLift) : base).cgColor
    }

    func refreshPastState() {
        alphaValue = (event.isPast ? CalendarEventChrome.pastOpacity : 1)
            * (event.isDemoted ? CalendarEventChrome.demotedOpacity : 1)
    }

    override func mouseDown(with nsEvent: NSEvent) {
        if nsEvent.clickCount >= 2 {
            onActivate?(event)
        } else {
            onSelect?(eventID)
        }
    }

    private static func timeLabel(_ event: StarlingsCalendarEvent, day: Date) -> String {
        guard !event.isAllDay else { return "all-day" }
        let calendar = Calendar.current
        // A continuing event has no start on this day to report.
        guard calendar.isDate(event.start, inSameDayAs: day) else { return "cont." }
        return StarlingsDateFormatting.time(event.start)
    }
}

private final class AgendaFlippedClipView: NSClipView {
    override var isFlipped: Bool { true }
}
