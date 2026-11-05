import AppKit

@MainActor
final class CalendarWeekGridView: NSView {
    var days: [Date] = [] {
        didSet { needsDisplay = true }
    }
    var events: [StarlingsCalendarEvent] = [] {
        didSet { needsDisplay = true }
    }
    var colorForCalendar: ((String) -> StarlingsRGBColor) = { _ in StarlingsRGBColor.fallback(at: 0) }
    /// Event id → every calendar it appears on, for blocks merged from copies.
    var mergedCalendarIDs: [String: [String]] = [:] {
        didSet { needsDisplay = true }
    }
    var selectedEventID: String? {
        didSet { needsDisplay = true }
    }
    var onSelect: ((String?) -> Void)?
    /// Right-click's own selection. Separate from `onSelect` because marking
    /// the block a menu is about must not also open the inspector.
    var onHighlight: ((String) -> Void)?
    var onCreate: ((Date, Date) -> Void)?
    var onMove: ((StarlingsCalendarEvent, Date, Date) -> Void)?
    /// ⌘-drag: the original stays, a copy lands where the drag ends. Mac
    /// only, as in Calendar.app and Fantastical.
    var onDuplicate: ((StarlingsCalendarEvent, Date, Date) -> Void)?
    /// Reports whole days moved once a sideways scroll settles.
    var onScrollSettled: ((Int) -> Void)?
    /// Live sideways displacement, so the day header and the all-day band
    /// travel with the columns instead of jumping once the scroll settles.
    var onDayOffsetChange: ((CGFloat) -> Void)?
    /// A whole period back (`-1`) or on (`1`), from the mouse's own back and
    /// forward buttons.
    var onPagePeriod: ((Int) -> Void)?
    /// Builds the right-click menu for a block; `nil` for no menu.
    var onContextMenu: ((StarlingsCalendarEvent) -> NSMenu?)?
    /// Right-click on empty grid, with the slot it landed on. Empty space is
    /// where a new event goes, so the menu there is about making one.
    var onSlotContextMenu: ((Date, Date) -> NSMenu?)?
    var onLayerContextMenu: ((CalendarLayerItem) -> NSMenu?)?
    /// Other people's busy time, shaded behind the grid while you pick a slot.
    var busyIntervals: [DateInterval] = [] {
        didSet { needsDisplay = true }
    }
    /// Company rows — milestones, dated tasks, published events. Read-only.
    var layerItems: [CalendarLayerItem] = [] {
        didSet { needsDisplay = true }
    }

    /// How many of `days` sit before the visible window. Days are held either
    /// side of the viewport so a drag has something to reveal.
    var leadingPadDays: Int = 0 {
        didSet { needsDisplay = true }
    }
    /// How many columns fill the width.
    var visibleDayCount: Int = 7 {
        didSet { needsDisplay = true }
    }
    /// Live sideways displacement during a scroll, in points.
    var dayOffset: CGFloat = 0 {
        didSet {
            needsDisplay = true
            onDayOffsetChange?(dayOffset)
        }
    }

    var hourHeight: CGFloat = 48
    /// Reports a pinch so the height constraint and the stored preference
    /// follow the gesture.
    var onHourHeightChange: ((CGFloat) -> Void)?
    var gutterWidth: CGFloat = 54 {
        didSet { needsDisplay = true }
    }
    /// A second column of hours down the gutter, right of the local one and so
    /// nearest the grid — the zone you are reading the day *against*.
    var secondaryTimeZone: TimeZone? {
        didSet { needsDisplay = true }
    }
    /// The day is drawn whole, midnight to midnight. Cropping it to the
    /// working hours and widening for events saved space at the cost of the
    /// end of the day: the last hours were simply not in the view, and
    /// nothing on screen said so.
    let hourSpan = 24
    /// Snap step for drags, in minutes.
    var snapMinutes: Int = 15
    /// Length given to an event created without a drag, e.g. from the slot
    /// context menu. A click on empty grid no longer creates anything on its
    /// own — only a drag does, and its length is whatever was dragged.
    var defaultDuration: TimeInterval = 3_600

    private enum DragKind {
        case create
        case move
        case resize
    }

    private var dragKind: DragKind?
    private var dragEvent: StarlingsCalendarEvent?
    private var createStart: Date?
    private var createEnd: Date?
    private var grabOffset: TimeInterval = 0
    private var originalDuration: TimeInterval = 3_600
    private var tentativeStart: Date?
    private var tentativeEnd: Date?
    private var mouseDownPoint: NSPoint = .zero
    private var didDrag = false
    /// The drag began with ⌘ down, so it is a copy rather than a move. Decided
    /// on mouseDown: a modifier that changed its mind mid-drag would leave
    /// the ghost and the original swapping places under the pointer.
    private var isDuplicating = false
    private var settleTimer: Timer?
    /// Eases the leftover part-day back to zero after a settle, so the grid
    /// glides onto the day boundary instead of hopping onto it.
    private var glideTimer: Timer?
    private var glideFrom: CGFloat = 0
    private var glideStart: TimeInterval = 0

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { true }
    /// So arrow keys and Delete reach the view controller once the grid is
    /// clicked, instead of being swallowed by whatever held focus.
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

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: CGFloat(hourSpan) * hourHeight)
    }

    /// The shortest hour that still reaches the bottom of the scroll view.
    var fillingHourHeight: CGFloat {
        guard let clip = enclosingScrollView?.contentView, clip.bounds.height > 1 else {
            return CalendarWindowPreferences.hourHeightRange.lowerBound
        }
        return clip.bounds.height / CGFloat(hourSpan)
    }

    /// Vertical offset for a moment within its day.
    private func y(forHours hours: Double) -> CGFloat {
        CGFloat(hours) * hourHeight
    }

    override func draw(_ dirtyRect: NSRect) {
        StarlingsColors.canvas.setFill()
        bounds.fill()

        let dayWidth = columnWidth
        guard dayWidth > 0, !days.isEmpty else { return }
        let calendar = Calendar.current

        for (index, day) in days.enumerated() {
            let x = columnX(index, dayWidth: dayWidth)
            guard x + dayWidth > gutterWidth, x < bounds.maxX else { continue }
            drawDayRungs(day, x: x, width: dayWidth, calendar: calendar)
            CalendarGridInk.dayDivider.setStroke()
            let divider = NSBezierPath()
            divider.lineWidth = 1
            divider.move(to: NSPoint(x: x + 0.5, y: 0))
            divider.line(to: NSPoint(x: x + 0.5, y: bounds.height))
            divider.stroke()
        }

        drawBusyBands(dayWidth: dayWidth, calendar: calendar)

        let timed = displayedEvents.filter { !$0.isAllDay }
        let eventByID = Dictionary(uniqueKeysWithValues: timed.map { ($0.id, $0) })
        let timedLayers = layerItems.filter { !$0.isAllDay }
        let layerByID = Dictionary(uniqueKeysWithValues: timedLayers.map { ($0.id, $0) })
        for (index, day) in days.enumerated() {
            let x = columnX(index, dayWidth: dayWidth)
            guard x + dayWidth > gutterWidth, x < bounds.maxX else { continue }
            // Events and layers pack together: a task due at 15:00 should sit
            // beside the 15:00 meeting, not hidden under it.
            let segments = daySpans(day: day, calendar: calendar)
            let packed = CalendarWeekMath.pack(segments)
            let packByID = Dictionary(uniqueKeysWithValues: packed.map { ($0.id, $0) })
            for segment in laneOrder(segments, packByID: packByID) {
                guard let pack = packByID[segment.id] else { continue }
                let rect = eventRect(
                    span: segment,
                    dayStart: calendar.startOfDay(for: day),
                    columnX: x,
                    columnWidth: dayWidth,
                    pack: pack
                )
                // Only a cascading card needs to hide what it covers.
                let layered = pack.columnCount > 1
                if let event = eventByID[segment.id] {
                    drawEvent(event, in: rect, layered: layered)
                } else if let item = layerByID[segment.id] {
                    drawLayerItem(item, in: rect, layered: layered)
                }
            }
        }

        // Hour rules go on top of the events on purpose: the grid is how you
        // read an event's start and end at a glance, so it has to stay legible
        // through a block rather than being buried under it.
        drawHourRules()

        if dragKind == .create, didDrag, let createStart, let createEnd {
            let rect = createRect(from: createStart, to: createEnd)
            StarlingsColors.accent.withAlphaComponent(0.22).setFill()
            rect.fill()
            StarlingsColors.accent.withAlphaComponent(0.7).setStroke()
            NSBezierPath(rect: rect.insetBy(dx: 0.5, dy: 0.5)).stroke()
            drawCreateLabel(from: createStart, to: createEnd, in: rect)
        }

        drawNowLine(calendar: calendar, dayWidth: dayWidth)
        drawHourGutter()
    }

    /// Drawn last and opaque: the hour column stays put while days slide under
    /// it, so it has to cover whatever passes beneath.
    private func drawHourGutter() {
        StarlingsColors.canvas.setFill()
        NSRect(x: 0, y: 0, width: gutterWidth, height: bounds.height).fill()
        let secondaryLabels = secondaryHourLabels()
        // Local hours keep the left half; the second zone sits between them and
        // the grid, so a row reads local-then-theirs in the order you say it.
        let localWidth = secondaryLabels == nil ? gutterWidth - 8 : gutterWidth / 2 - 6
        for hour in 0..<hourSpan {
            let top = y(forHours: Double(hour)) + 2
            NSString(string: CalendarWeekMath.hourLabel(hour)).draw(
                in: NSRect(x: 0, y: top, width: localWidth, height: 16),
                withAttributes: [
                    .font: NSFont.systemFont(ofSize: CalendarGridTypography.scaled(10), weight: .medium),
                    .foregroundColor: StarlingsColors.secondaryText,
                    .paragraphStyle: trailingParagraph,
                ]
            )
            guard let label = secondaryLabels?[hour] else { continue }
            NSString(string: label).draw(
                in: NSRect(x: gutterWidth / 2, y: top, width: gutterWidth / 2 - 8, height: 16),
                withAttributes: [
                    .font: NSFont.systemFont(ofSize: CalendarGridTypography.scaled(10), weight: .medium),
                    // Dimmer than the local clock: it is the reference, not the
                    // time you are keeping.
                    .foregroundColor: StarlingsColors.secondaryText.withAlphaComponent(0.6),
                    .paragraphStyle: trailingParagraph,
                ]
            )
        }
    }

    /// The same instants read in the second zone, keyed by local hour. Built
    /// from real dates on the day on screen, so half-hour offsets and a
    /// daylight-saving change land where they actually fall instead of as an
    /// integer added to a number.
    private func secondaryHourLabels() -> [Int: String]? {
        guard let zone = secondaryTimeZone, let day = days.first else { return nil }
        let calendar = Calendar.current
        guard zone.secondsFromGMT(for: day) != calendar.timeZone.secondsFromGMT(for: day) else { return nil }
        var labels: [Int: String] = [:]
        let start = calendar.startOfDay(for: day)
        for hour in 0..<hourSpan {
            guard let moment = calendar.date(byAdding: .hour, value: hour, to: start) else { continue }
            labels[hour] = StarlingsDateFormatting.hour(moment, timeZone: zone)
        }
        return labels
    }

    /// Pinch scales time the way pinching a map scales ground: the hour under
    /// the fingers stays under them, so the gesture reads as pulling the day
    /// open rather than jumping somewhere else in it.
    override func magnify(with event: NSEvent) {
        guard event.magnification != 0 else { return }
        let pointer = convert(event.locationInWindow, from: nil)
        let hoursAtPointer = pointer.y / hourHeight
        let range = CalendarWindowPreferences.hourHeightRange
        // Never shorter than the hour that fills the view: the day ending
        // halfway up the window looks like the calendar stopping.
        let lower = max(range.lowerBound, fillingHourHeight)
        let ceiling = max(range.upperBound, lower)
        let next = min(ceiling, max(lower, hourHeight * (1 + event.magnification)))
        guard abs(next - hourHeight) > 0.01 else { return }
        hourHeight = next
        invalidateIntrinsicContentSize()
        needsDisplay = true
        // The controller owns the height constraint, so the grid is only its
        // new size once it has answered — which has to happen before the
        // scroll below, or it corrects for a height that is not there yet.
        onHourHeightChange?(next)
        guard let clip = enclosingScrollView?.contentView else { return }
        let drift = hoursAtPointer * next - pointer.y
        let limit = max(0, bounds.height - clip.bounds.height)
        clip.scroll(to: NSPoint(
            x: clip.bounds.origin.x,
            y: min(limit, max(0, clip.bounds.origin.y + drift))
        ))
        enclosingScrollView?.reflectScrolledClipView(clip)
    }

    /// Scrolling up and down always moves through the day; only a sideways
    /// gesture moves through the days. Shift is how a wheel asks for sideways,
    /// since it only has the one axis. The day used to take the vertical
    /// gesture too whenever it happened to fit the window, so the same scroll
    /// meant two different things depending on the zoom.
    override func scrollWheel(with event: NSEvent) {
        let horizontal = abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY)
        guard horizontal || event.modifierFlags.contains(.shift) else {
            super.scrollWheel(with: event)
            return
        }

        // Shift-wheel already arrives on the X axis; shift-trackpad does not.
        let raw = horizontal ? event.scrollingDeltaX : event.scrollingDeltaY
        guard raw != 0 else { return }
        // A wheel reports few coarse notches; scale them to feel like a swipe.
        let delta = event.hasPreciseScrollingDeltas ? raw : raw * 6
        // A new gesture owns the offset outright: leave a glide from the last
        // one running and the two fight over it, which reads as a stutter.
        cancelGlide()
        // Content follows the fingers, so moving left reveals later days.
        dayOffset -= delta
        clampOffset()

        // A trackpad says when the coasting stopped, so settle on that rather
        // than a beat after it. Fingers leaving only *might* be the end — the
        // momentum that follows arrives within a frame or two — so that gets a
        // short timer the momentum will cancel. A wheel reports no phase at
        // all, and falls back to waiting for the scrolling to go quiet.
        if event.momentumPhase == .ended || event.momentumPhase == .cancelled {
            settleTimer?.invalidate()
            settleTimer = nil
            settle()
        } else if event.momentumPhase == [] && (event.phase == .ended || event.phase == .cancelled) {
            scheduleSettle(after: 0.06)
        } else {
            scheduleSettle()
        }
    }

    /// A grid that has left the window has nothing to glide, and its timers
    /// would otherwise keep firing against a view nobody can see.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window == nil else { return }
        cancelGlide()
        settleTimer?.invalidate()
        settleTimer = nil
    }

    /// Never scroll past the days actually held, or the edge goes blank.
    private func clampOffset() {
        let dayWidth = columnWidth
        guard dayWidth > 0 else { return }
        let trailingPad = max(0, days.count - leadingPadDays - visibleDayCount)
        let minimum = -CGFloat(leadingPadDays) * dayWidth
        let maximum = CGFloat(trailingPad) * dayWidth
        dayOffset = min(maximum, max(minimum, dayOffset))
    }

    /// Settle on a whole day shortly after the scrolling stops. Days are the
    /// unit a calendar is read in; stopping halfway through one is never useful.
    private func scheduleSettle(after delay: TimeInterval = 0.12) {
        settleTimer?.invalidate()
        let timer = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.settle() }
        }
        // Common mode, or a menu or a live resize holds the settle back and the
        // grid sits stranded mid-day until the tracking ends.
        RunLoop.main.add(timer, forMode: .common)
        settleTimer = timer
    }

    private func settle() {
        settleTimer?.invalidate()
        settleTimer = nil
        let dayWidth = columnWidth
        guard dayWidth > 0, dayOffset != 0 else { return }
        let shift = Int((dayOffset / dayWidth).rounded())
        // Hand the whole days to the controller and keep only the part-day
        // left over. The controller re-anchors the window in this same turn, so
        // taking `shift` days out of the offset and putting them into the
        // anchor leaves the picture exactly where the fingers left it — no
        // frame is drawn in between. Zeroing the offset here instead is what
        // made the grid snap back to where the scroll began and then jump
        // forward again once the fetch landed.
        let residual = dayOffset - CGFloat(shift) * dayWidth
        if shift != 0 { onScrollSettled?(shift) }
        dayOffset = residual
        glide()
    }

    /// Ease the leftover part-day to zero. Short enough to feel like the same
    /// gesture finishing, long enough not to read as a jump.
    private func glide() {
        cancelGlide()
        guard abs(dayOffset) > 0.5 else {
            dayOffset = 0
            return
        }
        glideFrom = dayOffset
        glideStart = ProcessInfo.processInfo.systemUptime
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.stepGlide() }
        }
        RunLoop.main.add(timer, forMode: .common)
        glideTimer = timer
    }

    private func stepGlide() {
        let duration = 0.18
        let elapsed = ProcessInfo.processInfo.systemUptime - glideStart
        guard elapsed < duration else {
            cancelGlide()
            dayOffset = 0
            return
        }
        // Ease out: fastest where the gesture left off, slowest as it arrives.
        let t = elapsed / duration
        let eased = 1 - pow(1 - t, 3)
        dayOffset = glideFrom * CGFloat(1 - eased)
    }

    private func cancelGlide() {
        glideTimer?.invalidate()
        glideTimer = nil
    }

    /// Move the window a whole day and glide onto it. The keyboard's version of
    /// a one-day scroll: the anchor moves first and the offset absorbs the day,
    /// so the picture is still where it was, then the glide carries it across.
    func stepDays(_ shift: Int) {
        guard shift != 0 else { return }
        cancelGlide()
        settleTimer?.invalidate()
        settleTimer = nil
        let dayWidth = columnWidth
        onScrollSettled?(shift)
        dayOffset += CGFloat(shift) * dayWidth
        clampOffset()
        glide()
    }

    /// Drop any part-day displacement at once — for the jumps that are meant to
    /// be jumps: paging, Today, a mode switch.
    func resetDayOffset() {
        cancelGlide()
        settleTimer?.invalidate()
        settleTimer = nil
        dayOffset = 0
    }

    /// The back and forward buttons on a mouse page the period, the way they
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
        case 3: onPagePeriod?(-1)
        case 4: onPagePeriod?(1)
        default: super.otherMouseUp(with: event)
        }
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let point = convert(event.locationInWindow, from: nil)
        switch hitGridContent(at: point) {
        case .event(let hit):
            onHighlight?(hit.event.id)
            return onContextMenu?(hit.event)
        case .layer(let item):
            onHighlight?(item.id)
            return onLayerContextMenu?(item)
        case nil:
            break
        }
        guard let start = date(at: point).map({ CalendarWeekMath.snap($0, minutes: snapMinutes) })
        else { return nil }
        return onSlotContextMenu?(start, start.addingTimeInterval(defaultDuration))
    }

    // hover: a canvas grid that hit-tests its own drawing; per-cell hover is a redesign
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        let point = convert(event.locationInWindow, from: nil)
        mouseDownPoint = point
        didDrag = false
        isDuplicating = false
        tentativeStart = nil
        tentativeEnd = nil
        dragEvent = nil
        createStart = nil
        createEnd = nil

        switch hitGridContent(at: point) {
        case .event(let hit):
            let nsEvent = event
            let event = hit.event
            // One click marks the block; two open it. Opening on the first
            // click put an editor over the grid every time you pointed at
            // something, including while reading the week.
            guard nsEvent.clickCount < 2 else {
                onSelect?(event.id)
                dragKind = nil
                return
            }
            onHighlight?(event.id)
            guard event.isWritable else {
                dragKind = nil
                return
            }
            dragEvent = event
            originalDuration = max(15 * 60, event.end.timeIntervalSince(event.start))
            if isResizeHandle(point, hit: hit) {
                dragKind = .resize
            } else {
                dragKind = .move
                isDuplicating = nsEvent.modifierFlags.contains(.command)
                if isDuplicating { NSCursor.dragCopy.push() }
                let at = date(at: point) ?? event.start
                // Grab offset is measured against the visible block, so dragging
                // the second half of an overnight event does not teleport it.
                grabOffset = at.timeIntervalSince(hit.span.start)
                    + hit.span.start.timeIntervalSince(event.start)
            }
            return
        case .layer(let item):
            // Marked and opened like an event. The inspector
            // reads it; nothing drags, because the row is Core's.
            dragKind = nil
            if event.clickCount >= 2 {
                onSelect?(item.id)
            } else {
                onHighlight?(item.id)
            }
            return
        case nil:
            break
        }

        onSelect?(nil)
        // Armed on mouseDown like .move/.resize below, but nothing is visible
        // or created yet — createEnd tracks createStart until an actual drag
        // (see didDrag in mouseDragged) gives it a length.
        dragKind = .create
        createStart = date(at: point).map { CalendarWeekMath.snap($0, minutes: snapMinutes) }
        createEnd = createStart
    }

    override func mouseDragged(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if hypot(point.x - mouseDownPoint.x, point.y - mouseDownPoint.y) > 3 {
            didDrag = true
        }
        switch dragKind {
        case .create:
            guard let createStart else { return }
            let snapped = date(at: point).map { CalendarWeekMath.snap($0, minutes: snapMinutes) } ?? createStart
            createEnd = max(snapped, createStart.addingTimeInterval(15 * 60))
            needsDisplay = true
        case .move:
            guard let dragEvent, let at = date(at: point) else { return }
            let rawStart = at.addingTimeInterval(-grabOffset)
            let start = CalendarWeekMath.snap(rawStart, minutes: snapMinutes)
            tentativeStart = start
            tentativeEnd = start.addingTimeInterval(originalDuration)
            needsDisplay = true
        case .resize:
            guard let dragEvent, let at = date(at: point) else { return }
            let snapped = CalendarWeekMath.snap(at, minutes: snapMinutes)
            tentativeStart = dragEvent.start
            tentativeEnd = max(snapped, dragEvent.start.addingTimeInterval(15 * 60))
            needsDisplay = true
        case nil:
            break
        }
    }

    override func mouseUp(with event: NSEvent) {
        if isDuplicating { NSCursor.pop() }
        defer {
            dragKind = nil
            isDuplicating = false
            dragEvent = nil
            createStart = nil
            createEnd = nil
            tentativeStart = nil
            tentativeEnd = nil
            needsDisplay = true
        }
        switch dragKind {
        case .create:
            // A plain click, with no drag, must not create anything — only
            // dragging out a length does. (Right-click still gets a
            // default-length event via onSlotContextMenu, above.)
            guard didDrag, let createStart, let createEnd, createEnd > createStart else { return }
            onCreate?(createStart, createEnd)
        case .move, .resize:
            guard didDrag, let dragEvent, let tentativeStart, let tentativeEnd else { return }
            if abs(tentativeStart.timeIntervalSince(dragEvent.start)) < 1,
               abs(tentativeEnd.timeIntervalSince(dragEvent.end)) < 1 {
                return
            }
            if isDuplicating {
                onDuplicate?(dragEvent, tentativeStart, tentativeEnd)
            } else {
                onMove?(dragEvent, tentativeStart, tentativeEnd)
            }
        case nil:
            break
        }
    }

    private var displayedEvents: [StarlingsCalendarEvent] {
        guard let dragEvent, let tentativeStart, let tentativeEnd else { return events }
        if isDuplicating {
            // The original stays put; the copy is a ghost at the pointer.
            var copy = dragEvent.withSchedule(start: tentativeStart, end: tentativeEnd)
            copy = copy.withID("\(dragEvent.id)#copy")
            return events + [copy]
        }
        return events.map { event in
            event.id == dragEvent.id ? event.withSchedule(start: tentativeStart, end: tentativeEnd) : event
        }
    }

    private var columnWidth: CGFloat {
        max(0, (bounds.width - gutterWidth) / CGFloat(max(1, visibleDayCount)))
    }

    /// How many trailing day columns a panel `width` points wide, pinned to
    /// the grid's trailing edge, lies over.
    func daysCovered(byTrailing width: CGFloat) -> Int {
        let dayWidth = columnWidth
        guard dayWidth > 0 else { return 0 }
        return min(visibleDayCount, Int(ceil(width / dayWidth)))
    }

    /// Left edge of a day column, including anything scrolled off to the left.
    private func columnX(_ index: Int, dayWidth: CGFloat) -> CGFloat {
        gutterWidth + CGFloat(index - leadingPadDays) * dayWidth - dayOffset
    }

    /// Painting order for one day's cards. Cascading lanes overlap, so a lane
    /// has to be drawn after every lane behind it — sorting by start would not
    /// do, because the packer hands a freed lane to a later event.
    private func laneOrder(
        _ segments: [CalendarTimedSpan],
        packByID: [String: CalendarPackedSpan]
    ) -> [CalendarTimedSpan] {
        segments
            .enumerated()
            .sorted { left, right in
                let leftLane = packByID[left.element.id]?.column ?? 0
                let rightLane = packByID[right.element.id]?.column ?? 0
                if leftLane != rightLane { return leftLane < rightLane }
                return left.offset < right.offset
            }
            .map(\.element)
    }

    private func eventRect(
        span: CalendarTimedSpan,
        dayStart: Date,
        columnX: CGFloat,
        columnWidth: CGFloat,
        pack: CalendarPackedSpan
    ) -> NSRect {
        let startOffset = max(0, span.start.timeIntervalSince(dayStart) / 3_600)
        let durationHours = max(0.25, span.end.timeIntervalSince(span.start) / 3_600)
        let y = self.y(forHours: startOffset)
        let height = CGFloat(durationHours) * hourHeight
        let inset: CGFloat = 2
        let usable = max(0, columnWidth - inset * 2)
        let width = usable * CGFloat(pack.horizontalWidthFraction)
        let x = columnX + inset + usable * CGFloat(pack.horizontalLeadingFraction)
        return NSRect(x: x, y: y, width: max(1, width - 1), height: max(16, height - 1))
    }

    /// Guests' busy time, drawn under everything as hatched shade: it is
    /// context for choosing a slot, never something to click or move.
    private func drawBusyBands(dayWidth: CGFloat, calendar: Calendar) {
        guard !busyIntervals.isEmpty else { return }
        for (index, day) in days.enumerated() {
            let x = columnX(index, dayWidth: dayWidth)
            guard x + dayWidth > gutterWidth, x < bounds.maxX else { continue }
            let dayStart = calendar.startOfDay(for: day)
            guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else { continue }
            for interval in busyIntervals {
                guard interval.start < dayEnd, interval.end > dayStart else { continue }
                let from = max(interval.start, dayStart)
                let to = min(interval.end, dayEnd)
                let top = y(forHours: from.timeIntervalSince(dayStart) / 3_600)
                let bottom = y(forHours: to.timeIntervalSince(dayStart) / 3_600)
                let rect = NSRect(x: x + 1, y: top, width: dayWidth - 2, height: max(2, bottom - top))
                StarlingsColors.secondaryText.withAlphaComponent(0.16).setFill()
                rect.fill()
            }
        }
    }

    /// Timed spans for one day, events and layers together.
    private func daySpans(day: Date, calendar: Calendar) -> [CalendarTimedSpan] {
        let events = CalendarWeekMath.daySegments(
            displayedEvents.filter { !$0.isAllDay },
            day: day,
            calendar: calendar
        )
        let layers = layerItems
            .filter { !$0.isAllDay }
            .compactMap { item -> CalendarTimedSpan? in
                let dayStart = calendar.startOfDay(for: day)
                guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart),
                      item.start < dayEnd, item.end > dayStart
                else { return nil }
                return CalendarTimedSpan(
                    id: item.id,
                    start: max(item.start, dayStart),
                    end: min(item.end, dayEnd)
                )
            }
        return (events + layers).sorted { left, right in
            if left.start != right.start { return left.start < right.start }
            return left.end > right.end
        }
    }

    private func drawLayerItem(_ item: CalendarLayerItem, in rect: NSRect, layered: Bool) {
        CalendarEventChrome.draw(
            title: item.displayTitle,
            colors: [item.kind.color],
            in: rect,
            isSelected: selectedEventID == item.id,
            layered: layered,
            // Everyone's dated work is drawn; only yours is emphasised.
            dimmed: !item.isMine && item.kind == .tasks,
            struck: CalendarLayerItem.isFinished(item.status),
            past: item.isPast(),
            mark: true
        )
    }

    /// The hour keeps its rule; the half hour gets a hairline under it, at half
    /// the width and under half the ink, so it reads as a subdivision of the
    /// hour rather than as another one. Drawn only while there is room to tell
    /// the two apart: pinched down to the shortest hour, a line every twelve
    /// points is texture, not information.
    /// One column's place on the grid ladder: a weekend at the bottom rung, any
    /// other day at the top one. Flat for the column's whole length — the lift
    /// behind the working hours came off, so a day is one surface and the only
    /// thing drawn on it is what is on it.
    private func drawDayRungs(_ day: Date, x: CGFloat, width: CGFloat, calendar: Calendar) {
        let column = NSRect(x: x, y: 0, width: width, height: bounds.height)
        let rung = calendar.isDateInWeekend(day) ? CalendarGridInk.rungOff : CalendarGridInk.rungDay
        rung.setFill()
        column.fill()
    }

    private func drawHourRules() {
        let drawsHalfHours = hourHeight >= 40
        for hour in 0..<hourSpan {
            let top = y(forHours: Double(hour))
            CalendarGridInk.hourRule.setStroke()
            let line = NSBezierPath()
            line.lineWidth = 1
            line.move(to: NSPoint(x: gutterWidth, y: top + 0.5))
            line.line(to: NSPoint(x: bounds.maxX, y: top + 0.5))
            line.stroke()

            guard drawsHalfHours else { continue }
            let middle = (top + hourHeight / 2).rounded() + 0.25
            CalendarGridInk.halfHourRule.setStroke()
            let half = NSBezierPath()
            half.lineWidth = 0.5
            half.move(to: NSPoint(x: gutterWidth, y: middle))
            half.line(to: NSPoint(x: bounds.maxX, y: middle))
            half.stroke()
        }
    }

    private func drawEvent(_ event: StarlingsCalendarEvent, in rect: NSRect, layered: Bool) {
        CalendarEventChrome.draw(
            title: event.displayTitle,
            colors: colorsForEvent(event),
            in: rect,
            isSelected: selectedEventID == event.id,
            layered: layered,
            response: event.myResponse,
            demoted: event.isDemoted,
            past: event.isPast,
            mark: event.calendarRole == .globalInterest && event.meetingPlatform == .none,
            platform: event.meetingPlatform,
            attendance: event.attendance,
            detail: tileDetail(for: event)
        )
    }

    /// Formatted once per event and time, not on every frame of a drag.
    private var tileDetails: [String: CalendarTileDetail] = [:]

    private func tileDetail(for event: StarlingsCalendarEvent) -> CalendarTileDetail? {
        guard !event.isAllDay else { return nil }
        let key = "\(event.id)|\(event.start.timeIntervalSince1970)|\(event.end.timeIntervalSince1970)|\(event.location)|\(event.joinURL)|\(event.startTimeZone ?? "")"
        if let cached = tileDetails[key] { return cached }
        if tileDetails.count > 600 { tileDetails.removeAll() }
        let detail = CalendarTileDetail(event: event)
        tileDetails[key] = detail
        return detail
    }

    /// Every calendar carrying this block — more than one when copies merged.
    private func colorsForEvent(_ event: StarlingsCalendarEvent) -> [StarlingsRGBColor] {
        let ids = mergedCalendarIDs[event.id] ?? [event.calendarID]
        return ids.map(colorForCalendar)
    }

    private func drawNowLine(calendar: Calendar, dayWidth: CGFloat) {
        let now = Date()
        guard let index = days.firstIndex(where: { calendar.isDate($0, inSameDayAs: now) }) else { return }
        let minutes = calendar.dateComponents([.hour, .minute], from: now)
        let y = self.y(forHours: Double(minutes.hour ?? 0) + Double(minutes.minute ?? 0) / 60)
        let x = columnX(index, dayWidth: dayWidth)
        StarlingsColors.accent.setStroke()
        let line = NSBezierPath()
        line.lineWidth = 1.5
        line.move(to: NSPoint(x: x, y: y))
        line.line(to: NSPoint(x: x + dayWidth, y: y))
        line.stroke()
        let dot = NSBezierPath(ovalIn: NSRect(x: x - 3.5, y: y - 3.5, width: 7, height: 7))
        StarlingsColors.accent.setFill()
        dot.fill()
    }

    /// One drawn block: the event, the part of it shown in that day column, and
    /// where it landed. Resizing keys off the span so only the block carrying
    /// the real end offers a resize handle.
    private struct GridHit {
        let event: StarlingsCalendarEvent
        let span: CalendarTimedSpan
        let rect: NSRect
    }

    private enum GridContentHit {
        case event(GridHit)
        case layer(CalendarLayerItem)
    }

    /// Resolve the topmost card across events and work layers. Staggered cards
    /// overlap by design, so testing each kind separately could let a click
    /// punch through a later task into an earlier meeting beneath it.
    private func hitGridContent(at point: NSPoint) -> GridContentHit? {
        let calendar = Calendar.current
        let dayWidth = columnWidth
        guard dayWidth > 0 else { return nil }
        let timed = events.filter { !$0.isAllDay }
        let eventByID = Dictionary(uniqueKeysWithValues: timed.map { ($0.id, $0) })
        let layerByID = Dictionary(uniqueKeysWithValues: layerItems
            .filter { !$0.isAllDay }
            .map { ($0.id, $0) })
        for (index, day) in days.enumerated() {
            let x = columnX(index, dayWidth: dayWidth)
            let segments = daySpans(day: day, calendar: calendar)
            let packed = CalendarWeekMath.pack(segments)
            let packByID = Dictionary(uniqueKeysWithValues: packed.map { ($0.id, $0) })
            for segment in laneOrder(segments, packByID: packByID).reversed() {
                guard let pack = packByID[segment.id] else { continue }
                let rect = eventRect(
                    span: segment,
                    dayStart: calendar.startOfDay(for: day),
                    columnX: x,
                    columnWidth: dayWidth,
                    pack: pack
                )
                guard rect.contains(point) else { continue }
                if let event = eventByID[segment.id] {
                    return .event(GridHit(event: event, span: segment, rect: rect))
                }
                if let item = layerByID[segment.id] { return .layer(item) }
            }
        }
        return nil
    }

    /// Where a given event is drawn, so a popover can point at it. Uses the
    /// first segment, which is the one carrying the start.
    func rect(forEventID id: String) -> NSRect? {
        let calendar = Calendar.current
        let dayWidth = columnWidth
        guard dayWidth > 0 else { return nil }
        let timed = events.filter { !$0.isAllDay }
        for (index, day) in days.enumerated() {
            let segments = CalendarWeekMath.daySegments(timed, day: day, calendar: calendar)
            guard segments.contains(where: { $0.id == id }) else { continue }
            let packed = CalendarWeekMath.pack(segments)
            guard let pack = packed.first(where: { $0.id == id }),
                  let segment = segments.first(where: { $0.id == id })
            else { continue }
            return eventRect(
                span: segment,
                dayStart: calendar.startOfDay(for: day),
                columnX: columnX(index, dayWidth: dayWidth),
                columnWidth: dayWidth,
                pack: pack
            )
        }
        return nil
    }

    private func isResizeHandle(_ point: NSPoint, hit: GridHit) -> Bool {
        // A block clipped at midnight does not own the event's end.
        guard abs(hit.span.end.timeIntervalSince(hit.event.end)) < 1 else { return false }
        return point.y >= hit.rect.maxY - 8
    }

    private func date(at point: NSPoint) -> Date? {
        guard point.x >= gutterWidth, !days.isEmpty else { return nil }
        let dayWidth = columnWidth
        let column = (point.x - gutterWidth + dayOffset) / dayWidth + CGFloat(leadingPadDays)
        let index = min(days.count - 1, max(0, Int(floor(column))))
        let hours = min(23.75, max(0, Double(point.y / hourHeight)))
        let hour = Int(hours)
        let minute = Int((hours - Double(hour)) * 60)
        return Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: days[index])
    }

    private func createRect(from start: Date, to end: Date) -> NSRect {
        let calendar = Calendar.current
        guard let index = days.firstIndex(where: { calendar.isDate($0, inSameDayAs: start) }) else { return .zero }
        let dayStart = calendar.startOfDay(for: start)
        let y = self.y(forHours: start.timeIntervalSince(dayStart) / 3_600)
        let height = CGFloat(max(0.25, end.timeIntervalSince(start) / 3_600)) * hourHeight
        let x = columnX(index, dayWidth: columnWidth) + 2
        return NSRect(x: x, y: y, width: columnWidth - 4, height: height)
    }

    /// Live length readout on the create ghost — the whole point of dragging
    /// instead of clicking is seeing how long the block is before you let go.
    private func drawCreateLabel(from start: Date, to end: Date, in rect: NSRect) {
        let duration = CalendarWeekMath.durationLabel(end.timeIntervalSince(start))
        // A tall enough block earns the actual time range; a short drag only
        // has room for the duration itself.
        let text = rect.height >= 28
            ? "\(CalendarWeekMath.timeLabel(start)) – \(CalendarWeekMath.timeLabel(end)) · \(duration)"
            : duration
        let textRect = rect.insetBy(dx: 6, dy: 2)
        guard textRect.width > 4, textRect.height > 4 else { return }
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: CalendarGridTypography.scaled(11), weight: .semibold),
            .foregroundColor: StarlingsColors.primaryText,
        ]
        NSString(string: text).draw(in: textRect, withAttributes: attributes)
    }

    private var trailingParagraph: NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.alignment = .right
        return style
    }

    // MARK: - Accessibility
    //
    // The grid is one drawn surface, so without this VoiceOver sees an empty
    // rectangle. Each drawn block gets a proxy element at the same frame.

    override func isAccessibilityElement() -> Bool { false }

    override func accessibilityRole() -> NSAccessibility.Role? { .group }

    override func accessibilityLabel() -> String? { "Calendar grid" }

    override func accessibilityChildren() -> [Any]? {
        guard let window, !days.isEmpty else { return nil }
        let calendar = Calendar.current
        let dayWidth = columnWidth
        guard dayWidth > 0 else { return nil }

        let timed = events.filter { !$0.isAllDay }
        let byID = Dictionary(uniqueKeysWithValues: timed.map { ($0.id, $0) })
        var elements: [Any] = []

        for (index, day) in days.enumerated() {
            let x = gutterWidth + CGFloat(index) * dayWidth
            let segments = CalendarWeekMath.daySegments(timed, day: day, calendar: calendar)
            let packed = CalendarWeekMath.pack(segments)
            let packByID = Dictionary(uniqueKeysWithValues: packed.map { ($0.id, $0) })
            for segment in segments {
                guard let pack = packByID[segment.id], let event = byID[segment.id] else { continue }
                let rect = eventRect(
                    span: segment,
                    dayStart: calendar.startOfDay(for: day),
                    columnX: x,
                    columnWidth: dayWidth,
                    pack: pack
                )
                let screen = window.convertToScreen(convert(rect, to: nil))
                elements.append(NSAccessibilityElement.element(
                    withRole: .button,
                    frame: screen,
                    label: CalendarAccessibility.describe(event, calendarName: nil),
                    parent: self
                ))
            }
        }
        return elements
    }
}

/// Shared event chrome. The body stays a light tint so the hour rules read
/// through a block; the calendar's colour is carried by a stripe on the
/// leading edge instead of by a fully saturated fill.
@MainActor
enum CalendarEventChrome {
    static let stripeWidth: CGFloat = 3
    static let pastOpacity: CGFloat = 0.72
    /// Hidden from Next: a ghost of the block, there if you look for it.
    static let demotedOpacity: CGFloat = 0.4
    /// Two rows of 14pt marks with their insets and a gap between. Below
    /// this the guest mark stays on the title row. Same number on the phone
    /// and the web.
    static let cornerMarkMinHeight: CGFloat = 36

    static func draw(
        title: String,
        colors: [StarlingsRGBColor],
        in rect: NSRect,
        isSelected: Bool,
        /// This card is one of a cascade and may be sitting on another.
        layered: Bool = false,
        response: CalendarRSVP? = nil,
        /// Present but not yours to act on — a colleague's task, say.
        dimmed: Bool = false,
        /// Finished work, or an invitation you turned down.
        struck: Bool = false,
        /// Hidden from Next — still on the calendar, barely inked.
        demoted: Bool = false,
        /// Finished events stay visible as context, but recede slightly.
        past: Bool = false,
        /// Envisioning's own context — a global-interest event, or a row from
        /// the company layers. It carries the Starlings glyph in the top-right corner,
        /// the same answer the phone gives, where it cannot be mistaken for
        /// part of the title.
        mark: Bool = false,
        /// The provider destination, shown as a small platform mark on event
        /// cards. Layers leave this nil and keep their Envisioning context mark.
        platform: CalendarMeetingPlatform? = nil,
        /// Other people on the event and whether they all said yes. The
        /// top-right corner answers "where" (platform, Starlings glyph);
        /// this answers "who" and takes the bottom-right corner when the
        /// block is tall enough for two rows of marks. Shorter blocks and
        /// single-line chips keep it inline after the other marks.
        attendance: CalendarAttendance? = nil,
        /// Location and time under the title, as the block grows.
        /// Nil for layers, chips and all-day bars.
        detail: CalendarTileDetail? = nil,
        cornerRadius: CGFloat = 5,
        font: NSFont = .systemFont(ofSize: CalendarGridTypography.scaled(11), weight: .semibold)
    ) {
        guard rect.width > 0, rect.height > 0 else { return }
        let primary = colors.first ?? StarlingsRGBColor.fallback(at: 0)
        let declined = (response == .declined) || struck || dimmed
        let unanswered = response == .needsAction
        let path = NSBezierPath(roundedRect: rect, xRadius: cornerRadius, yRadius: cornerRadius)
        let fade = (past ? pastOpacity : 1) * (demoted ? demotedOpacity : 1)

        // A card in a cascade covers part of the card behind it, and the tint
        // below is translucent by design — so it needs the canvas under it
        // first. Without that, the covered title reads straight through this
        // one and both become unreadable.
        if layered {
            StarlingsColors.canvas.setFill()
            path.fill()
        }

        // A declined event stays visible but recedes; it is still on the day.
        primary.nsColor
            .withAlphaComponent((isSelected ? 0.32 : (declined ? 0.07 : 0.18)) * fade)
            .setFill()
        path.fill()

        // An unanswered invitation reads as an outline: on the calendar, not
        // yet agreed to.
        if unanswered {
            let dashed = NSBezierPath(
                roundedRect: rect.insetBy(dx: 0.5, dy: 0.5),
                xRadius: cornerRadius,
                yRadius: cornerRadius
            )
            primary.nsColor.withAlphaComponent(0.8 * fade).setStroke()
            dashed.lineWidth = 1
            dashed.setLineDash([3, 2], count: 2, phase: 0)
            dashed.stroke()
        }

        // Stripe split between every calendar carrying this event, so a merged
        // block still shows which subscriptions it came from.
        NSGraphicsContext.saveGraphicsState()
        path.setClip()
        let stripe = min(stripeWidth, rect.width)
        let painted = colors.isEmpty ? [primary] : colors
        let segment = rect.height / CGFloat(painted.count)
        for (index, color) in painted.enumerated() {
            color.nsColor.withAlphaComponent((declined ? 0.45 : 1) * fade).setFill()
            NSRect(
                x: rect.minX,
                y: rect.minY + CGFloat(index) * segment,
                width: stripe,
                height: segment
            ).fill()
        }
        NSGraphicsContext.restoreGraphicsState()

        if isSelected {
            StarlingsColors.borderHover.withAlphaComponent(fade).setStroke()
            path.lineWidth = 2
            path.stroke()
        }

        // The mark is drawn before the title so the title can be given the
        // width that is left. A block too small to hold both keeps the title:
        // what a thing is beats whose it is.
        var reserved: CGFloat = 0
        let markSize = min(14, rect.height - 4)
        let wantsPlatform = platform.map { $0 != .none } ?? false
        let guestsInCorner = attendance != nil && rect.height >= cornerMarkMinHeight
        let markCount = (wantsPlatform ? 1 : 0) + (mark ? 1 : 0)
            + (attendance != nil && !guestsInCorner ? 1 : 0)
        let markGap: CGFloat = 4
        let totalMarkWidth = CGFloat(markCount) * markSize + CGFloat(max(0, markCount - 1)) * markGap
        if markCount > 0, markSize >= 7, rect.width > totalMarkWidth + 26 {
            var markX = rect.maxX - markSize - 3
            if let platform, wantsPlatform {
                CalendarMeetingPlatformMark.draw(
                    for: platform,
                    in: NSRect(x: markX, y: rect.minY + 2, width: markSize, height: markSize),
                    color: platform == .starlings ? StarlingsColors.accentMark : StarlingsColors.primaryText,
                    fraction: fade
                )
                markX -= markSize + markGap
            }
            if mark {
                StarlingsBrand.drawGlyph(
                    in: NSRect(x: markX, y: rect.minY + 2, width: markSize, height: markSize),
                    color: declined ? StarlingsColors.secondaryText : StarlingsColors.primaryText,
                    fraction: fade
                )
                markX -= markSize + markGap
            }
            if let attendance, !guestsInCorner {
                CalendarAttendanceMark.draw(
                    for: attendance,
                    in: NSRect(x: markX, y: rect.minY + 2, width: markSize, height: markSize),
                    color: CalendarAttendanceMark.color(for: attendance, declined: declined),
                    fraction: fade
                )
            }
            reserved = totalMarkWidth + 5
        }

        // The guest mark in the bottom-right corner. The title gives up that
        // last row so a long one wraps above the mark, never through it.
        var textBottomInset: CGFloat = 0
        if let attendance, guestsInCorner, rect.width > markSize + 26 {
            CalendarAttendanceMark.draw(
                for: attendance,
                in: NSRect(
                    x: rect.maxX - markSize - 3,
                    y: rect.maxY - markSize - 2,
                    width: markSize,
                    height: markSize
                ),
                color: CalendarAttendanceMark.color(for: attendance, declined: declined),
                fraction: fade
            )
            textBottomInset = markSize + 2
        }

        // The rows the block is tall enough for: time first, then location,
        // never half a line. Measured from the fonts, so a larger grid type
        // size asks for more room before a row appears.
        let rowFont = NSFont.systemFont(ofSize: CalendarGridTypography.scaled(10))
        let rowHeight = ceil(rowFont.ascender - rowFont.descender + rowFont.leading)
        let titleHeight = ceil(font.ascender - font.descender + font.leading)
        let shown = detail.map {
            CalendarTileDetail.rows(
                height: rect.height,
                titleHeight: titleHeight,
                rowHeight: rowHeight,
                padding: 4,
                hasLocation: $0.location != nil
            )
        }
        let showsRows = shown?.time == true

        let textRect = NSRect(
            x: rect.minX + stripeWidth + 5,
            y: rect.minY + 2,
            width: rect.width - stripeWidth - 8 - reserved,
            height: showsRows ? titleHeight : rect.height - 4 - textBottomInset
        )
        guard textRect.width > 4, textRect.height > 4 else { return }
        var attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            // Reads against the canvas now, not against a saturated fill.
            .foregroundColor: (declined ? StarlingsColors.secondaryText : StarlingsColors.primaryText)
                .withAlphaComponent(fade),
        ]
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .left
        paragraph.lineBreakMode = .byTruncatingTail
        attributes[.paragraphStyle] = paragraph
        if response == .declined || struck {
            attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
        }
        // A multi-day block may continue beyond the visible week, and a long
        // title may be wider than a narrow collision lane. Clip both to the
        // card before drawing so neither case can paint over the next column.
        NSGraphicsContext.saveGraphicsState()
        path.setClip()
        NSString(string: title).draw(in: textRect, withAttributes: attributes)
        if let detail, showsRows {
            var rowY = textRect.maxY
            // The guest mark owns the bottom-right corner when it has one.
            let rowWidth = rect.width - stripeWidth - 8 - (textBottomInset > 0 ? markSize + 4 : 0)
            var rowsToDraw: [(symbol: String, text: String)] = []
            if shown?.location == true, let place = detail.location { rowsToDraw.append(("mappin", place)) }
            rowsToDraw.append(("clock", detail.time))
            let rowAttributes: [NSAttributedString.Key: Any] = [
                .font: rowFont,
                .foregroundColor: StarlingsColors.secondaryText.withAlphaComponent(fade),
                .paragraphStyle: paragraph,
            ]
            for row in rowsToDraw {
                let symbolSide: CGFloat = 9
                if let symbol = Self.rowSymbol(row.symbol, side: symbolSide, color: StarlingsColors.secondaryText) {
                    symbol.draw(
                        in: NSRect(x: textRect.minX, y: rowY + (rowHeight - symbolSide) / 2, width: symbolSide, height: symbolSide),
                        from: .zero,
                        operation: .sourceOver,
                        fraction: fade,
                        respectFlipped: true,
                        hints: nil
                    )
                }
                NSString(string: row.text).draw(
                    in: NSRect(x: textRect.minX + symbolSide + 3, y: rowY, width: max(0, rowWidth - symbolSide - 3), height: rowHeight),
                    withAttributes: rowAttributes
                )
                rowY += rowHeight
            }
        }
        NSGraphicsContext.restoreGraphicsState()
    }

    /// A small SF Symbol inked in `color`, for the tile's metadata rows.
    private static func rowSymbol(_ name: String, side: CGFloat, color: NSColor) -> NSImage? {
        guard let source = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: side, weight: .medium))
        else { return nil }
        let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { bounds in
            source.draw(in: bounds, from: .zero, operation: .sourceOver, fraction: 1)
            color.setFill()
            bounds.fill(using: .sourceIn)
            return true
        }
        image.isTemplate = false
        return image
    }
}

@MainActor
final class CalendarAllDayStripView: NSView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        clipsToBounds = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    var days: [Date] = [] {
        didSet { invalidateLayout() }
    }
    var events: [StarlingsCalendarEvent] = [] {
        didSet { invalidateLayout() }
    }
    var colorForCalendar: ((String) -> StarlingsRGBColor) = { _ in StarlingsRGBColor.fallback(at: 0) }
    var mergedCalendarIDs: [String: [String]] = [:] {
        didSet { needsDisplay = true }
    }
    var selectedEventID: String? {
        didSet { needsDisplay = true }
    }
    var onSelect: ((String) -> Void)?
    /// See `CalendarWeekGridView.onHighlight`.
    var onHighlight: ((String) -> Void)?

    var gutterWidth: CGFloat = 54
    /// Mirrors the timed grid so all-day bars slide with the columns.
    var leadingPadDays: Int = 0 {
        didSet { invalidateLayout() }
    }
    var visibleDayCount: Int = 7 {
        didSet { invalidateLayout() }
    }
    var dayOffset: CGFloat = 0 {
        didSet { invalidateLayout() }
    }
    var onContextMenu: ((StarlingsCalendarEvent) -> NSMenu?)?
    var onLayerContextMenu: ((CalendarLayerItem) -> NSMenu?)?
    /// All-day company rows: milestones, published events.
    var layerItems: [CalendarLayerItem] = [] {
        didSet { invalidateLayout() }
    }

    override var isFlipped: Bool { true }

    /// How many rows fit depends on the height the band was given, so a resize
    /// has to redraw and not just stretch what was there.
    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        needsDisplay = true
    }

    /// Row count follows the days on screen, so a redraw and a resize travel
    /// together.
    private func invalidateLayout() {
        invalidateIntrinsicContentSize()
        needsDisplay = true
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: 8 + CGFloat(rowCount) * 22)
    }

    /// Rows the bars want.
    private var rowCount: Int {
        max(1, (layouts.map(\.row).max() ?? -1) + 1)
    }

    /// Rows the band's current height can actually show. It matches `rowCount`
    /// unless something squeezed the band shorter than it asked to be; a row
    /// past this one is dropped rather than drawn out over the grid below.
    private var drawableRowCount: Int {
        max(1, Int((bounds.height - 8) / 22))
    }

    private func columnX(_ index: Int, dayWidth: CGFloat) -> CGFloat {
        gutterWidth + CGFloat(index - leadingPadDays) * dayWidth - dayOffset
    }

    private func barRect(row: Int, from first: Int, to last: Int, dayWidth: CGFloat) -> NSRect {
        NSRect(
            x: columnX(first, dayWidth: dayWidth) + 3,
            y: 4 + CGFloat(row) * 22,
            width: max(12, CGFloat(last - first + 1) * dayWidth - 6),
            height: 18
        )
    }

    /// The band paints between the gutter and its own bottom edge. A bar that
    /// starts on a padded day runs off to the left, and one on a row the band
    /// cannot fit runs off the bottom; both would otherwise paint over their
    /// neighbours.
    private var paintArea: NSRect {
        NSRect(
            x: gutterWidth,
            y: 0,
            width: max(0, bounds.width - gutterWidth),
            height: min(bounds.height, 8 + CGFloat(drawableRowCount) * 22)
        )
    }

    override func draw(_ dirtyRect: NSRect) {
        StarlingsColors.panel.setFill()
        bounds.fill()
        let dayWidth = columnWidth
        guard dayWidth > 0 else { return }
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        NSBezierPath(rect: paintArea).setClip()

        let byID = Dictionary(uniqueKeysWithValues: events.map { ($0.id, $0) })
        let layersByID = Dictionary(uniqueKeysWithValues: layerItems.map { ($0.id, $0) })
        for layout in layouts where layout.row < drawableRowCount {
            let rect = barRect(
                row: layout.row,
                from: layout.startIndex,
                to: layout.endIndex,
                dayWidth: dayWidth
            )
            guard rect.maxX > gutterWidth, rect.minX < bounds.maxX else { continue }
            if let event = byID[layout.id] {
                CalendarEventChrome.draw(
                    title: event.displayTitle,
                    colors: (mergedCalendarIDs[event.id] ?? [event.calendarID]).map(colorForCalendar),
                    in: rect,
                    isSelected: selectedEventID == event.id,
                    response: event.myResponse,
                    demoted: event.isDemoted,
                    past: event.isPast,
                    mark: event.calendarRole == .globalInterest && event.meetingPlatform == .none,
                    platform: event.meetingPlatform,
                    attendance: event.attendance,
                    cornerRadius: 4,
                    font: .systemFont(ofSize: CalendarGridTypography.scaled(11), weight: .medium)
                )
            } else if let item = layersByID[layout.id] {
                CalendarEventChrome.draw(
                    title: item.displayTitle,
                    colors: [item.kind.color],
                    in: rect,
                    isSelected: selectedEventID == item.id,
                    dimmed: !item.isMine && item.kind == .tasks,
                    struck: CalendarLayerItem.isFinished(item.status),
                    past: item.isPast(),
                    mark: true,
                    cornerRadius: 4,
                    font: .systemFont(ofSize: CalendarGridTypography.scaled(11), weight: .medium)
                )
            }
        }
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard let id = hitID(at: point) else { return }
        if event.clickCount >= 2 {
            onSelect?(id)
        } else {
            onHighlight?(id)
        }
    }

    /// Only what the band drew can be hit: a clipped bar is not there to
    /// click. Events and layer rows share the band, so either answers.
    private func hitID(at point: NSPoint) -> String? {
        guard paintArea.contains(point) else { return nil }
        let dayWidth = columnWidth
        for layout in layouts.reversed() where layout.row < drawableRowCount {
            let rect = barRect(
                row: layout.row,
                from: layout.startIndex,
                to: layout.endIndex,
                dayWidth: dayWidth
            )
            if rect.contains(point) { return layout.id }
        }
        return nil
    }

    /// The day indices on screen. `days` carries a padded week either side so a
    /// sideways scroll reveals real days rather than empty space — but an event
    /// parked out there must not claim a row, which left the band standing tall
    /// and blank with only its first row carrying anything.
    private var visibleDayRange: ClosedRange<Int> {
        let width = columnWidth
        let scrolled = width > 0 ? Int((dayOffset / width).rounded(.down)) : 0
        let first = leadingPadDays + scrolled
        // A column of slack on each side covers the half-scrolled edge days.
        return (first - 1)...(first + max(1, visibleDayCount))
    }

    /// Events and layer rows are packed in one pass, so a milestone on a free
    /// day takes the gap beside a bar rather than a line of its own — the band
    /// stays as short as the spans allow.
    private var layouts: [CalendarAllDayLayout] {
        let window = visibleDayRange
        func onScreen(start: Date, end: Date) -> Bool {
            guard let range = CalendarWeekMath.allDayDayRange(start: start, end: end, days: days)
            else { return false }
            return range.lowerBound <= window.upperBound && range.upperBound >= window.lowerBound
        }
        let spans = events.filter(\.isAllDay)
            .filter { onScreen(start: $0.start, end: $0.end) }
            .map { CalendarAllDaySpan(id: $0.id, start: $0.start, end: $0.end) }
            + layerItems.filter(\.isAllDay)
            .filter { onScreen(start: $0.start, end: $0.end) }
            .map { CalendarAllDaySpan(id: $0.id, start: $0.start, end: $0.end) }
        return CalendarWeekMath.packAllDay(spans, days: days)
    }

    private var columnWidth: CGFloat {
        max(0, (bounds.width - gutterWidth) / CGFloat(max(1, visibleDayCount)))
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let point = convert(event.locationInWindow, from: nil)
        guard let id = hitID(at: point) else { return nil }
        onHighlight?(id)
        if let item = events.first(where: { $0.id == id }) { return onContextMenu?(item) }
        if let item = layerItems.first(where: { $0.id == id }) { return onLayerContextMenu?(item) }
        return nil
    }
}

/// Weekday above, date number below. Today gets an accent disc on the number.
@MainActor
final class CalendarDayHeaderView: NSView {
    private let weekdayLabel = NSTextField(labelWithString: "")
    private let numberLabel = NSTextField(labelWithString: "")
    private let todayBadge = NSView()

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: 52)
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        weekdayLabel.font = CalendarGridTypography.sectionLabelFont
        weekdayLabel.alignment = .center
        weekdayLabel.translatesAutoresizingMaskIntoConstraints = false

        numberLabel.font = .systemFont(ofSize: CalendarGridTypography.scaled(17), weight: .semibold)
        numberLabel.alignment = .center
        numberLabel.translatesAutoresizingMaskIntoConstraints = false

        todayBadge.wantsLayer = true
        todayBadge.layer?.cornerRadius = 13
        todayBadge.translatesAutoresizingMaskIntoConstraints = false
        todayBadge.isHidden = true

        addSubview(weekdayLabel)
        addSubview(todayBadge)
        addSubview(numberLabel)

        NSLayoutConstraint.activate([
            weekdayLabel.topAnchor.constraint(equalTo: topAnchor, constant: 2),
            weekdayLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
            weekdayLabel.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor),
            weekdayLabel.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            todayBadge.centerXAnchor.constraint(equalTo: centerXAnchor),
            todayBadge.centerYAnchor.constraint(equalTo: numberLabel.centerYAnchor),
            todayBadge.widthAnchor.constraint(equalToConstant: 26),
            todayBadge.heightAnchor.constraint(equalToConstant: 26),
            numberLabel.topAnchor.constraint(equalTo: weekdayLabel.bottomAnchor, constant: 2),
            numberLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
            numberLabel.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(day: Date, isToday: Bool) {
        let weekday = DateFormatter()
        weekday.locale = StarlingsDateFormatting.locale
        weekday.dateFormat = "EEE"
        weekdayLabel.stringValue = weekday.string(from: day).uppercased()
        numberLabel.stringValue = String(Calendar.current.component(.day, from: day))
        todayBadge.isHidden = !isToday
        if isToday {
            todayBadge.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.accent, for: todayBadge).cgColor
            weekdayLabel.textColor = StarlingsColors.accentMark
            numberLabel.textColor = StarlingsColors.accentInk
        } else {
            weekdayLabel.textColor = StarlingsColors.secondaryText
            numberLabel.textColor = StarlingsColors.primaryText
        }
    }
}
