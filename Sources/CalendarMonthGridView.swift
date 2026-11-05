import AppKit

/// Six weeks of day cells. Unlike the week grid there is no time axis, so
/// events are chips ordered all-day first, then by start.
@MainActor
final class CalendarMonthGridView: NSView {
    /// Three months' grids end to end — previous, focused, next — so a sideways
    /// scroll reveals the real neighbouring month rather than swapping the data
    /// once the gesture ends. `leadingPadCells` says where the focused one
    /// starts, the same way `leadingPadDays` does in the week grid.
    var days: [Date] = [] {
        didSet { needsDisplay = true }
    }
    var leadingPadCells: Int = 0 {
        didSet { needsDisplay = true }
    }
    /// How many cells make one page. Six weeks, always.
    private let cellsPerPage = 42
    var events: [StarlingsCalendarEvent] = [] {
        didSet { needsDisplay = true }
    }
    var colorForCalendar: ((String) -> StarlingsRGBColor) = { _ in StarlingsRGBColor.fallback(at: 0) }
    var mergedCalendarIDs: [String: [String]] = [:] {
        didSet { needsDisplay = true }
    }
    var selectedEventID: String? {
        didSet { needsDisplay = true }
    }
    /// The month the grid is *about*; neighbouring days are dimmed.
    var focusedMonth: Date = Date() {
        didSet { needsDisplay = true }
    }
    /// The single day the window is pointed at, as against `focusedMonth`,
    /// which is the page. Washed so the month and the sidebar agree on a day.
    var focusedDay: Date? {
        didSet { needsDisplay = true }
    }

    var onSelect: ((String?) -> Void)?
    /// See `CalendarWeekGridView.onHighlight`.
    var onHighlight: ((String) -> Void)?
    var onCreate: ((Date, Date) -> Void)?
    /// Asks to open a day that has more events than its cell can show.
    var onOpenDay: ((Date) -> Void)?
    /// A plain click on a day cell: point the window at that day without
    /// opening it.
    var onSelectDay: ((Date) -> Void)?
    /// A settled scroll, or a mouse's back / forward button: `-1` back a
    /// month, `1` on.
    var onPage: ((Int) -> Void)?
    /// Builds the right-click menu for a chip; `nil` for no menu.
    var onContextMenu: ((StarlingsCalendarEvent) -> NSMenu?)?
    /// See `CalendarWeekGridView.onSlotContextMenu`. A month cell is a whole
    /// day, so the slot it offers is the default hour on that day.
    var onSlotContextMenu: ((Date, Date) -> NSMenu?)?
    var onLayerContextMenu: ((CalendarLayerItem) -> NSMenu?)?
    var layerItems: [CalendarLayerItem] = [] {
        didSet { needsDisplay = true }
    }

    private let chipHeight: CGFloat = 16
    private let chipSpacing: CGFloat = 2
    private let headerHeight: CGFloat = 18
    /// Displacement along `pagesVertically` while a scroll is in progress.
    /// Zero at rest.
    private var monthOffset: CGFloat = 0 {
        didSet { needsDisplay = true }
    }
    /// Which way the pages travel. Six weeks always fit, so there is nothing
    /// to scroll inside a month and both axes page — but the page has to move
    /// the way the hand did, or the gesture and the picture disagree.
    private var pagesVertically = false
    private var settleTimer: Timer?

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        clipsToBounds = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draw(_ dirtyRect: NSRect) {
        StarlingsColors.canvas.setFill()
        bounds.fill()
        guard !days.isEmpty else { return }
        let calendar = Calendar.current

        for (index, day) in days.enumerated() {
            let cell = cellRect(at: index)
            // Two pages are visible mid-scroll at most; the rest is off screen.
            guard cell.intersects(bounds) else { continue }
            // Each page dims against its own month, so the one arriving is not
            // greyed out for the crime of not being the anchored one.
            let inFocus = calendar.isDate(day, equalTo: pageMonth(for: index), toGranularity: .month)

            // The same two rungs the week grid uses. Out of focus the rung is
            // drawn thin over the canvas, which is how a page dims against its
            // own month.
            let rung = calendar.isDateInWeekend(day)
                ? CalendarGridInk.rungOff
                : CalendarGridInk.rungDay
            rung.withAlphaComponent(inFocus ? 1 : 0.45).setFill()
            cell.fill()
            if let focusedDay, calendar.isDate(day, inSameDayAs: focusedDay) {
                StarlingsColors.accent.withAlphaComponent(0.12).setFill()
                cell.fill()
            }

            CalendarGridInk.dayDivider.setStroke()
            let border = NSBezierPath(rect: cell)
            border.lineWidth = 1
            border.stroke()

            drawDayNumber(day, in: cell, inFocus: inFocus, isToday: calendar.isDateInToday(day))
            drawChips(for: day, in: cell, calendar: calendar)
        }
    }

    override func scrollWheel(with event: NSEvent) {
        // A month grid never scrolls vertically: the six weeks always fit, so
        // every scroll is free to move through the months. It follows the
        // fingers rather than counting them up and jumping at a threshold —
        // what arrives during the gesture is the real next month. Up and down
        // page upward and downward, sideways pages sideways: the month leaves
        // along the axis you pushed it.
        guard !days.isEmpty else {
            super.scrollWheel(with: event)
            return
        }
        let horizontal = abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY)
        let raw = horizontal ? event.scrollingDeltaX : event.scrollingDeltaY
        guard raw != 0 else { return }
        // The axis is decided by the movement that starts the gesture and kept
        // until it settles, so a drift off the axis cannot flip the page
        // sideways halfway through.
        if monthOffset == 0 {
            pagesVertically = !horizontal && !event.modifierFlags.contains(.shift)
        }
        // A wheel reports few coarse notches; scale them to feel like a swipe.
        let delta = event.hasPreciseScrollingDeltas ? raw : raw * 6
        // Content follows the fingers, so moving left — or up — reveals later
        // months.
        monthOffset -= delta
        clampOffset()
        scheduleSettle()
    }

    /// The back and forward buttons on a mouse page the months, the way they
    /// page a browser. AppKit reports them as buttons 3 and 4, and the down is
    /// claimed here so the release that acts on it lands on this view too.
    override func otherMouseDown(with event: NSEvent) {
        guard event.buttonNumber == 3 || event.buttonNumber == 4 else {
            super.otherMouseDown(with: event)
            return
        }
    }

    override func otherMouseUp(with event: NSEvent) {
        switch event.buttonNumber {
        case 3: onPage?(-1)
        case 4: onPage?(1)
        default: super.otherMouseUp(with: event)
        }
    }

    /// How far a whole page moves, along the axis it is moving on.
    private var pageSpan: CGFloat {
        pagesVertically ? bounds.height : bounds.width
    }

    /// Never past the pages actually held, or the edge goes blank.
    private func clampOffset() {
        monthOffset = min(pageSpan, max(-pageSpan, monthOffset))
    }

    private func scheduleSettle() {
        settleTimer?.invalidate()
        settleTimer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.settle() }
        }
    }

    /// Settle on a whole month shortly after the scrolling stops, then let the
    /// controller re-anchor: the same picture, expressed as a month.
    private func settle() {
        settleTimer?.invalidate()
        settleTimer = nil
        guard pageSpan > 0, monthOffset != 0 else { return }
        let shift = Int((monthOffset / pageSpan).rounded())
        monthOffset = 0
        if shift != 0 { onPage?(shift) }
    }

    // hover: a canvas grid that hit-tests its own drawing; per-cell hover is a redesign
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        let point = convert(event.locationInWindow, from: nil)
        guard let index = cellIndex(at: point) else { return }
        let day = days[index]
        let cell = cellRect(at: index)
        let calendar = Calendar.current

        let visible = chips(for: day, calendar: calendar)
        let capacity = chipCapacity(in: cell)
        for (slot, chip) in visible.prefix(capacity).enumerated() {
            if chipRect(in: cell, slot: slot).contains(point) {
                if event.clickCount >= 2 {
                    onSelect?(chip.id)
                } else {
                    onHighlight?(chip.id)
                }
                return
            }
        }
        if let item = layerChip(at: point, day: day, cell: cell, calendar: calendar) {
            if event.clickCount >= 2 {
                onSelect?(item.id)
            } else {
                onHighlight?(item.id)
            }
            return
        }
        // The overflow row is a way into the day, not a dead label.
        if visible.count > capacity, overflowRect(in: cell, capacity: capacity).contains(point) {
            onOpenDay?(day)
            return
        }

        // Empty space in a cell is still that day: point at it.
        onSelectDay?(day)
        onSelect?(nil)
        if event.clickCount >= 2 {
            let start = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: day) ?? day
            onCreate?(start, start.addingTimeInterval(3_600))
        }
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let point = convert(event.locationInWindow, from: nil)
        guard let index = cellIndex(at: point) else { return nil }
        let cell = cellRect(at: index)
        let calendar = Calendar.current
        let visible = chips(for: days[index], calendar: calendar)
        let capacity = chipCapacity(in: cell)
        for (slot, chip) in visible.prefix(capacity).enumerated()
        where chipRect(in: cell, slot: slot).contains(point) {
            onHighlight?(chip.id)
            return onContextMenu?(chip)
        }
        if let item = layerChip(at: point, day: days[index], cell: cell, calendar: calendar) {
            onHighlight?(item.id)
            return onLayerContextMenu?(item)
        }
        // Empty part of a day cell: offer to fill it, at the hour a
        // double-click there would have used.
        guard let start = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: days[index])
        else { return nil }
        return onSlotContextMenu?(start, start.addingTimeInterval(3_600))
    }

    // MARK: - Accessibility

    override func isAccessibilityElement() -> Bool { false }

    override func accessibilityRole() -> NSAccessibility.Role? { .group }

    override func accessibilityLabel() -> String? { "Month grid" }

    override func accessibilityChildren() -> [Any]? {
        guard let window, !days.isEmpty else { return nil }
        let calendar = Calendar.current
        var elements: [Any] = []
        for (index, day) in days.enumerated() {
            let cell = cellRect(at: index)
            // Only what is on screen: the months held either side are for the
            // scroll to reveal, not for VoiceOver to read out in advance.
            guard cell.intersects(bounds) else { continue }
            let visible = chips(for: day, calendar: calendar)
            let capacity = chipCapacity(in: cell)
            for (slot, event) in visible.prefix(capacity).enumerated() {
                let screen = window.convertToScreen(convert(chipRect(in: cell, slot: slot), to: nil))
                elements.append(NSAccessibilityElement.element(
                    withRole: .button,
                    frame: screen,
                    label: CalendarAccessibility.describe(event, calendarName: nil),
                    parent: self
                ))
            }
            if visible.count > capacity {
                let screen = window.convertToScreen(
                    convert(overflowRect(in: cell, capacity: capacity), to: nil)
                )
                elements.append(NSAccessibilityElement.element(
                    withRole: .button,
                    frame: screen,
                    label: "\(visible.count - capacity) more events, open this day",
                    parent: self
                ))
            }
        }
        return elements
    }

    /// Where a chip is drawn, so a popover can point at it.
    func rect(forEventID id: String) -> NSRect? {
        let calendar = Calendar.current
        for (index, day) in days.enumerated() {
            let cell = cellRect(at: index)
            // A popover has to point at something the reader can see, so an
            // off-screen page is not an answer.
            guard cell.intersects(bounds) else { continue }
            let visible = chips(for: day, calendar: calendar)
            let capacity = chipCapacity(in: cell)
            if let slot = visible.prefix(capacity).firstIndex(where: { $0.id == id }) {
                return chipRect(in: cell, slot: slot)
            }
        }
        return nil
    }

    private func drawDayNumber(_ day: Date, in cell: NSRect, inFocus: Bool, isToday: Bool) {
        let calendar = Calendar.current
        let number = String(calendar.component(.day, from: day))
        let box = NSRect(x: cell.minX + 4, y: cell.minY + 2, width: cell.width - 8, height: headerHeight - 2)

        if isToday {
            let badge = NSRect(x: box.minX - 1, y: box.minY - 1, width: 20, height: 16)
            StarlingsColors.accent.setFill()
            NSBezierPath(roundedRect: badge, xRadius: 8, yRadius: 8).fill()
        }
        let color: NSColor = isToday
            ? StarlingsColors.accentInk
            : (inFocus ? StarlingsColors.primaryText : StarlingsColors.secondaryText)
        NSString(string: number).draw(
            in: box,
            withAttributes: [
                .font: NSFont.systemFont(ofSize: CalendarGridTypography.scaled(11), weight: isToday ? .bold : .medium),
                .foregroundColor: color,
            ]
        )
    }

    private func drawChips(for day: Date, in cell: NSRect, calendar: Calendar) {
        let visible = chips(for: day, calendar: calendar)
        guard !visible.isEmpty else { return }
        let capacity = chipCapacity(in: cell)

        for (slot, event) in visible.prefix(capacity).enumerated() {
            CalendarEventChrome.draw(
                title: chipTitle(for: event, day: day, calendar: calendar),
                colors: (mergedCalendarIDs[event.id] ?? [event.calendarID]).map(colorForCalendar),
                in: chipRect(in: cell, slot: slot),
                isSelected: selectedEventID == event.id,
                response: event.myResponse,
                demoted: event.isDemoted,
                past: event.isPast,
                mark: event.calendarRole == .globalInterest && event.meetingPlatform == .none,
                platform: event.meetingPlatform,
                attendance: event.attendance,
                cornerRadius: 3,
                font: .systemFont(ofSize: CalendarGridTypography.scaled(10), weight: .medium)
            )
        }

        // Layer rows fill whatever the events left, so a month never hides a
        // meeting behind a milestone.
        let layers = layersOn(day, calendar: calendar)
        var slot = min(capacity, visible.count)
        for item in layers where slot < capacity {
            CalendarEventChrome.draw(
                title: item.displayTitle,
                colors: [item.kind.color],
                in: chipRect(in: cell, slot: slot),
                isSelected: selectedEventID == item.id,
                dimmed: !item.isMine && item.kind == .tasks,
                struck: CalendarLayerItem.isFinished(item.status),
                past: item.isPast(),
                mark: true,
                cornerRadius: 3,
                font: .systemFont(ofSize: CalendarGridTypography.scaled(10), weight: .medium)
            )
            slot += 1
        }

        let overflow = (visible.count + layers.count) - capacity
        if overflow > 0 {
            let hidden = overflow
            NSString(string: "\(hidden) more").draw(
                in: overflowRect(in: cell, capacity: capacity).insetBy(dx: 4, dy: 0),
                withAttributes: [
                    .font: NSFont.systemFont(ofSize: CalendarGridTypography.scaled(10), weight: .medium),
                    .foregroundColor: StarlingsColors.secondaryText,
                ]
            )
        }
    }

    /// The layer chip under the pointer, in the slots `drawChips` gave the
    /// layers: whatever the events left.
    private func layerChip(at point: NSPoint, day: Date, cell: NSRect, calendar: Calendar) -> CalendarLayerItem? {
        let capacity = chipCapacity(in: cell)
        var slot = min(capacity, chips(for: day, calendar: calendar).count)
        for item in layersOn(day, calendar: calendar) where slot < capacity {
            if chipRect(in: cell, slot: slot).contains(point) { return item }
            slot += 1
        }
        return nil
    }

    private func layersOn(_ day: Date, calendar: Calendar) -> [CalendarLayerItem] {
        let dayStart = calendar.startOfDay(for: day)
        guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else { return [] }
        return layerItems
            .filter { $0.start < dayEnd && $0.end > dayStart }
            .sorted { $0.start < $1.start }
    }

    /// All-day bars first, then by start — the order the day actually reads in.
    private func chips(for day: Date, calendar: Calendar) -> [StarlingsCalendarEvent] {
        events
            .filter { event in
                if event.isAllDay {
                    return CalendarWeekMath.allDayDayRange(event, days: [day], calendar: calendar) != nil
                }
                return CalendarWeekMath.daySegment(for: event, day: day, calendar: calendar) != nil
            }
            .sorted { left, right in
                if left.isAllDay != right.isAllDay { return left.isAllDay }
                if left.start != right.start { return left.start < right.start }
                return left.displayTitle < right.displayTitle
            }
    }

    private func chipTitle(for event: StarlingsCalendarEvent, day: Date, calendar: Calendar) -> String {
        guard !event.isAllDay else { return event.displayTitle }
        // A continuing event has no start to show on this day.
        guard calendar.isDate(event.start, inSameDayAs: day) else { return event.displayTitle }
        return String(localized: "\(StarlingsDateFormatting.time(event.start))  \(event.displayTitle)")
    }

    private var columnWidth: CGFloat {
        max(0, bounds.width / 7)
    }

    private var rowHeight: CGFloat {
        // Six, from one page — not from `days.count`, which now holds three
        // months and would divide the height by eighteen.
        max(0, bounds.height / CGFloat(cellsPerPage / 7))
    }

    private func cellRect(at index: Int) -> NSRect {
        let page = index / cellsPerPage
        let withinPage = index % cellsPerPage
        let row = withinPage / 7
        let column = withinPage % 7
        let pageIndex = CGFloat(page - leadingPage)
        let travel = pageIndex * pageSpan - monthOffset
        return NSRect(
            x: (pagesVertically ? 0 : travel) + CGFloat(column) * columnWidth,
            y: (pagesVertically ? travel : 0) + CGFloat(row) * rowHeight,
            width: columnWidth,
            height: rowHeight
        )
    }

    /// Which held page is the focused month.
    private var leadingPage: Int { leadingPadCells / cellsPerPage }

    /// The month a page is about — its own, not the anchored one.
    private func pageMonth(for index: Int) -> Date {
        let page = index / cellsPerPage
        // The middle of a six-week grid is always inside the month it draws.
        let middle = page * cellsPerPage + 21
        return days.indices.contains(middle) ? days[middle] : focusedMonth
    }

    private func cellIndex(at point: NSPoint) -> Int? {
        guard columnWidth > 0, rowHeight > 0, bounds.width > 0 else { return nil }
        // Walk the pages rather than dividing: mid-scroll the hit can land on
        // either of the two on screen.
        for index in days.indices where cellRect(at: index).contains(point) {
            return index
        }
        return nil
    }

    /// How many chips fit, always leaving room for the overflow row.
    private func chipCapacity(in cell: NSRect) -> Int {
        let usable = cell.height - headerHeight - chipHeight
        guard usable > 0 else { return 0 }
        return max(0, Int(usable / (chipHeight + chipSpacing)))
    }

    private func chipRect(in cell: NSRect, slot: Int) -> NSRect {
        NSRect(
            x: cell.minX + 3,
            y: cell.minY + headerHeight + CGFloat(slot) * (chipHeight + chipSpacing),
            width: cell.width - 6,
            height: chipHeight
        )
    }

    private func overflowRect(in cell: NSRect, capacity: Int) -> NSRect {
        NSRect(
            x: cell.minX + 3,
            y: cell.minY + headerHeight + CGFloat(capacity) * (chipHeight + chipSpacing),
            width: cell.width - 6,
            height: chipHeight
        )
    }
}
