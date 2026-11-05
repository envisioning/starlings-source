import SwiftUI

/// The day and week grid: an hour ruler, one column per day, all-day events in a
/// strip above. Both modes are this view — a day is a week with one column.
///
/// The hour gutter deliberately lives outside the horizontal pager. This is a
/// little more structure than putting three complete calendar pages side by
/// side, but it gives the phone the stable frame of reference people expect:
/// the clock stays put and only the day surface pages. One vertical scroll view
/// contains both sides, so the ruler and day columns remain vertically aligned.
struct MobileCalendarTimeGrid: View {
    @ObservedObject var store: MobileCalendarStore
    let onSelect: (CalendarEventGroup) -> Void
    let onSelectLayer: (CalendarLayerItem) -> Void
    /// Tapping empty space is how a new event starts, at the hour tapped.
    let onCreate: (Date) -> Void

    /// A move is only armed after a deliberate long press. Ordinary drags keep
    /// belonging to the vertical scroll view or the horizontal period pager.
    @State private var moving: MobileCalendarMove?
    /// The drop: the card landed on a new time, and the store is writing it.
    /// A failed write is the store's `errorMessage`, buzzed by its alert.
    @State private var dropped = StarlingsHapticPulse()
    /// The hour height the current pinch started from, and the hour that was at
    /// the top of the screen when it did.
    @State private var zoomBase: CGFloat?
    @State private var zoomAnchorHour: Int?
    /// How far the grid is scrolled, so a zoom can put the day back where it was.
    @State private var scrollOffset: CGFloat = 0
    /// How tall the scrolling hours are on screen, so a zoom-out can tell when
    /// the whole day fits and 00:00 belongs at the top (#617).
    @State private var viewportHeight: CGFloat = 0
    /// One page offset for both strips: the dates above and the hours below are
    /// two views of the same period and must never disagree about where it is.
    @StateObject private var motion = MobileCalendarPageMotion()

    private var hourHeight: CGFloat { MobileCalendarChrome.hourHeight }
    /// The second clock, only while it differs from this one on the day on
    /// screen (compared on a real date, so a DST edge lands where it falls).
    /// Display only — the setting stays, and the column returns when you travel
    /// (#611; the same rule as the Mac's `secondaryHourLabels`).
    private var secondaryZone: StarlingsScheduleTimeZone? {
        guard let zone = CalendarWindowPreferences.secondaryTimeZone() else { return nil }
        let day = store.days.first ?? Date()
        guard zone.timeZone.secondsFromGMT(for: day) != Calendar.current.timeZone.secondsFromGMT(for: day) else { return nil }
        return zone
    }
    private var gutter: CGFloat {
        MobileCalendarChrome.gutterWidth(hasSecondaryTimeZone: secondaryZone != nil)
    }


    var body: some View {
        let _ = store.displayPreferencesRevision
        // Hour rows and day columns are fixed geometry; the type scales with
        // them up to xxxLarge and stops. The agenda view is the
        // accessibility-size reading of the same week.
        timeGrid.meetGridTypeSizeCap()
            // Each snap step ticks under the finger, so a quarter hour is
            // counted rather than read. Only a step: the lift buzzes in the
            // recognizer, and the drop below.
            .meetHaptic(trigger: moving) { old, new in
                guard let old, let new, old.eventID == new.eventID,
                      old.start != new.start || old.dayDelta != new.dayDelta
                else { return nil }
                return .step
            }
            .meetHaptics(dropped)
    }

    private var timeGrid: some View {
        GeometryReader { proxy in
            let pageWidth = max(1, proxy.size.width - gutter)
            let columnWidth = pageWidth / CGFloat(max(1, store.days.count))
            VStack(spacing: 0) {
                // The dates and the all-day band are what the hours below are
                // *about*, so they stay put: scrolling to another hour must not
                // scroll away the answer to which day you are looking at. They
                // still page sideways, on the same offset as the grid.
                HStack(alignment: .top, spacing: 0) {
                    // The gutter's head belongs to the hours, not to a day.
                    Color.clear.frame(width: gutter, height: crownHeight)
                    crownStrip(pageWidth: pageWidth, columnWidth: columnWidth)
                        .frame(width: pageWidth, height: crownHeight)
                }
                .frame(width: proxy.size.width, alignment: .leading)
                Rectangle()
                    .fill(StarlingsMobileColors.border)
                    .frame(height: 1)
                ScrollViewReader { scrollProxy in
                    ScrollView(.vertical) {
                        HStack(alignment: .top, spacing: 0) {
                            hourGutter
                                .frame(width: gutter)
                            columnStrip(pageWidth: pageWidth, columnWidth: columnWidth) {
                                dayColumns(for: spanDays, columnWidth: columnWidth)
                            }
                            .frame(width: pageWidth, height: hourHeight * 24)
                        }
                        .frame(width: proxy.size.width, alignment: .leading)
                        .padding(.bottom, 24)
                        .background(scrollOffsetReader)
                        .background(MobileCalendarNoBounce())
                    }
                    .background(GeometryReader { scrollProxy in
                        Color.clear.onAppear { viewportHeight = scrollProxy.size.height }
                            .onChange(of: scrollProxy.size.height) { _, height in viewportHeight = height }
                    })
                    .coordinateSpace(name: Self.scrollSpace)
                    .onPreferenceChange(MobileCalendarScrollOffset.self) { scrollOffset = $0 }
                    // Two fingers zoom; one finger still scrolls and pages.
                    .simultaneousGesture(zoom(scrollProxy))
                    .onAppear {
                        // Open on the working day rather than at midnight.
                        scrollProxy.scrollTo(scrollAnchorHour, anchor: .top)
                    }
                }
            }
        }
    }

    /// The run of days, moved as one by `motion`. Both the fixed crown and the
    /// scrolling hours are built through this, so a swipe anywhere on either
    /// carries both.
    ///
    /// One continuous run rather than three windows side by side, because a
    /// step here is a single day: windows built a day apart would overlap, and
    /// the seam between two of them would show the same column twice. The run
    /// carries one day of runway at each end, and a swipe travels one column.
    private func columnStrip<Content: View>(
        pageWidth: CGFloat,
        columnWidth: CGFloat,
        @ViewBuilder content: () -> Content
    ) -> some View {
        content()
            .frame(width: columnWidth * CGFloat(spanDays.count), alignment: .topLeading)
            .offset(x: -columnWidth + motion.drag)
            // The run is wider than the window, so it has to be pinned to the
            // leading edge and clipped there; centring it shows the runway.
            .frame(width: pageWidth, alignment: .leading)
            .clipped()
            .background(MobileCalendarPageDrag(
                onChanged: { motion.dragged($0, width: columnWidth) },
                onEnded: { translation, velocity in
                    motion.finished(
                        translation,
                        velocity: velocity,
                        width: columnWidth,
                        onSettle: { store.step($0) }
                    )
                }
            ))
    }

    /// The fixed head, drawn once across the whole run instead of once per
    /// column. An all-day bar spans days, so cutting it at a column boundary
    /// would turn one five-day event into a row of stubs.
    private func crownStrip(pageWidth: CGFloat, columnWidth: CGFloat) -> some View {
        columnStrip(pageWidth: pageWidth, columnWidth: columnWidth) {
            crown(for: spanDays)
                .frame(height: crownHeight)
        }
        .animation(.easeInOut(duration: 0.18), value: crownHeight)
    }

    /// Which days these are, and what is true all day.
    private func crown(for days: [Date]) -> some View {
        VStack(spacing: 0) {
            dayHeader(for: days)
            allDayStrip(for: days)
                .frame(height: allDayHeight, alignment: .top)
                // A runway day's rows are laid out but must not spill past the
                // band the visible days asked for.
                .clipped()
        }
    }

    // MARK: - Zoom

    private static let scrollSpace = "meet.calendar.grid"

    private var scrollOffsetReader: some View {
        GeometryReader { geometry in
            Color.clear.preference(
                key: MobileCalendarScrollOffset.self,
                value: -geometry.frame(in: .named(Self.scrollSpace)).minY
            )
        }
    }

    /// Pull the day open or squeeze it shut, the way the Mac grid answers a
    /// trackpad pinch — same limits, same stored height, so the scale you set on
    /// one follows you to the other.
    private func zoom(_ scrollProxy: ScrollViewProxy) -> some Gesture {
        MagnifyGesture(minimumScaleDelta: 0.01)
            .onChanged { value in
                let base = zoomBase ?? hourHeight
                if zoomBase == nil {
                    zoomBase = base
                    zoomAnchorHour = topHour(hourHeight: base)
                }
                setHourHeight(base * value.magnification)
            }
            .onEnded { _ in
                // The hours grew or shrank under a scroll offset measured in
                // points, so without this the day slides away as it opens.
                // When the whole day now fits, there is nothing to scroll to:
                // pin 00:00 to the top rather than leave the grid floating.
                if hourHeight * 24 + 24 <= viewportHeight {
                    scrollProxy.scrollTo(0, anchor: .top)
                } else if let hour = zoomAnchorHour {
                    scrollProxy.scrollTo(hour, anchor: .top)
                }
                zoomBase = nil
                zoomAnchorHour = nil
            }
    }

    /// The hour at the top of the screen, from how far the grid is scrolled.
    private func topHour(hourHeight: CGFloat) -> Int {
        let hours = scrollOffset / hourHeight
        return max(0, min(23, Int(hours.rounded(.down))))
    }

    private func setHourHeight(_ height: CGFloat) {
        let next = CalendarWindowPreferences.clampHourHeight(height)
        guard abs(next - hourHeight) > 0.5 else { return }
        CalendarWindowPreferences.setHourHeight(next)
        store.refreshGridScale()
    }

    /// Every day the grid builds: the window on screen with a day of runway at
    /// each end, so a swipe has real columns to move into.
    private var spanDays: [Date] {
        store.runDays
    }

    /// One row of day, or two when the sky has to wrap under it. Never three:
    /// the head is a label for the column, and every point it takes is a point
    /// the day itself does not get.
    private var headerHeight: CGFloat {
        spanDays.contains { store.weather[CalendarDateParsing.format(day: $0)] != nil } ? 46 : 30
    }

    /// Measured over the days on screen rather than over the whole run. The run
    /// carries a day of runway at each end, and measuring it reserved the band
    /// on a day with nothing all-day on it because the *next* day had a
    /// milestone. The cost is that the band opens and shuts as a swipe settles,
    /// which `crownStrip` animates.
    private var allDayHeight: CGFloat {
        let rows = allDayRows(for: store.days)
        return rows > 0
            ? CGFloat(rows) * MobileCalendarChrome.allDayRowHeight + 6
            : 0
    }

    /// What stays above the hours: the dates, and the all-day band under them.
    private var crownHeight: CGFloat {
        headerHeight + allDayHeight
    }

    private var scrollAnchorHour: Int {
        let now = Calendar.current.component(.hour, from: Date())
        let workingHour = CalendarWindowPreferences.dayStartHour()
        let days = store.days
        return max(0, min(20, days.contains { Calendar.current.isDateInToday($0) }
            ? max(workingHour, now - 1)
            : workingHour))
    }

    // MARK: - Header

    private func dayHeader(for days: [Date]) -> some View {
        HStack(spacing: 0) {
            ForEach(days, id: \.timeIntervalSince1970) { day in
                dayHead(day, isSingleDay: days.count == 1)
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                    .onTapGesture { store.select(day: day) }
                    .meetHoverLift(cornerRadius: MobileCalendarChrome.cornerRadius)
                    .accessibilityElement(children: .ignore)
                    .accessibilityAddTraits(.isButton)
                    .accessibilityLabel(spokenHead(day))
            }
        }
        .padding(.vertical, 4)
        .frame(height: headerHeight)
    }

    /// Day and sky on one line where the column is wide enough for it, and on
    /// two where it is not. A single day fits comfortably; three narrow columns
    /// wrap the temperatures under the date rather than shrinking them.
    private func dayHead(_ day: Date, isSingleDay: Bool) -> some View {
        let forecast = store.weather[CalendarDateParsing.format(day: day)]
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) {
                dayMark(day, isSingleDay: isSingleDay)
                skyMark(forecast)
            }
            VStack(spacing: 0) {
                dayMark(day, isSingleDay: isSingleDay)
                skyMark(forecast)
            }
        }
    }

    /// The accent marks *which* column is today, so it earns its place only in
    /// a run of them. A single day has nothing to be picked out from — the head
    /// is already the day you asked for — so both the weekday and the disc go
    /// neutral there, and the bold date carries it.
    private func dayMark(_ day: Date, isSingleDay: Bool) -> some View {
        let isToday = Calendar.current.isDateInToday(day)
        let marksToday = isToday && !isSingleDay
        return HStack(spacing: 4) {
            Text(day.formatted(.dateTime.weekday(.abbreviated)).uppercased())
                .font(.caption2)
                .foregroundStyle(marksToday ? StarlingsMobileColors.accent : Color.secondary)
            Text(day.formatted(.dateTime.day()))
                .font(.subheadline.weight(isToday ? .bold : .regular))
                .foregroundStyle(marksToday ? StarlingsMobileColors.accentInk : Color.primary)
                .frame(width: 22, height: 22)
                .background(marksToday ? StarlingsMobileColors.accent : .clear, in: Circle())
        }
        .lineLimit(1)
        .fixedSize()
    }

    @ViewBuilder
    private func skyMark(_ forecast: DailyForecast?) -> some View {
        if let forecast {
            HStack(spacing: 3) {
                Image(systemName: forecast.condition.symbolName)
                Text(forecast.summary)
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .fixedSize()
        }
    }

    private func spokenHead(_ day: Date) -> String {
        let spoken = day.formatted(.dateTime.weekday(.wide).month(.wide).day())
        guard let forecast = store.weather[CalendarDateParsing.format(day: day)] else { return spoken }
        return String(localized: "\(spoken), \(forecast.condition.label), \(forecast.summary)")
    }

    // MARK: - All-day strip

    private func allDayStrip(for days: [Date]) -> some View {
        let laid = store.allDayLayout(for: days)
        let rows = allDayRows(for: days)
        return Group {
            if rows > 0 {
                GeometryReader { proxy in
                    let columnWidth = max(0, proxy.size.width / CGFloat(days.count))
                    ZStack(alignment: .topLeading) {
                        ForEach(laid) { item in
                            let width = columnWidth * CGFloat(item.layout.endIndex - item.layout.startIndex + 1)
                            let event = item.content.eventGroup?.event
                            let activeMove = event.flatMap { moving?.eventID == $0.id ? moving : nil }
                            let start = item.layout.startIndex + (activeMove?.dayDelta ?? 0)
                            let base = slotView(
                                item.content,
                                isSelected: activeMove != nil,
                                isCompact: true,
                                titleInset: titleInset(
                                    start: start,
                                    width: width,
                                    days: days,
                                    columnWidth: columnWidth
                                )
                            )
                                .frame(
                                    width: max(0, width - 2),
                                    height: MobileCalendarChrome.allDayRowHeight - 2
                                )
                                .accessibilityAction { select(item.content) }
                                .meetHoverLift(cornerRadius: MobileCalendarChrome.cornerRadius)
                                .offset(
                                    x: columnWidth * CGFloat(start) + 1,
                                    y: CGFloat(item.layout.row) * MobileCalendarChrome.allDayRowHeight
                                )
                            base
                                .overlay(cardTouch(
                                    item.content,
                                    event: event,
                                    days: days,
                                    originIndex: item.layout.startIndex,
                                    columnWidth: columnWidth
                                ))
                                .zIndex(activeMove == nil ? 0 : 10)
                        }
                    }
                }
                .frame(height: CGFloat(rows) * MobileCalendarChrome.allDayRowHeight + 4)
                .padding(.bottom, 2)
            }
        }
    }

    /// How far into a spanning card its title has to start to be on screen.
    ///
    /// The all-day band is one strip drawn across the whole run, so a card that
    /// began before today starts off the left edge of the page and takes its
    /// title with it. Pushing the words to the first visible day puts the title
    /// back on the day you are reading, without cutting the card into stubs.
    private func titleInset(
        start: Int,
        width: CGFloat,
        days: [Date],
        columnWidth: CGFloat
    ) -> CGFloat {
        guard let onScreen = store.days.first else { return 0 }
        let visibleStart = dayIndex(of: onScreen, in: days)
        guard start < visibleStart else { return 0 }
        let shift = CGFloat(visibleStart - start) * columnWidth
        // Never past the card's own right edge: a one-day tail of a long event
        // keeps its title inside the tail.
        return max(0, min(shift, width - 40))
    }

    private func allDayRows(for days: [Date]) -> Int {
        let laid = store.allDayLayout(for: days)
        return (laid.map(\.layout.row).max() ?? -1) + 1
    }

    // MARK: - Grid

    private var hourGutter: some View {
        VStack(spacing: 0) {
            ForEach(0..<24, id: \.self) { hour in
                VStack(alignment: .trailing, spacing: 0) {
                    Text(CalendarWeekMath.hourLabel(hour))
                    if let secondaryZone {
                        Text(secondaryHourLabel(hour, zone: secondaryZone, days: store.days))
                            .font(.caption2).minimumScaleFactor(0.8)
                            .foregroundStyle(Color.secondary.opacity(0.72))
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                // Two-digit hours are still tight in the narrowed gutter.
                // Scaling them is cheaper than widening every column's left
                // margin for the whole day.
                .minimumScaleFactor(0.8)
                // The inset sits inside the measured width. Padding applied
                // after the frame made every label 5 points wider than the
                // gutter it was drawn in, so the hours overhung the seam.
                .padding(.trailing, 4)
                .frame(width: gutter, height: hourHeight, alignment: .topTrailing)
                    .id(hour)
            }
        }
        .frame(width: gutter)
    }

    private func dayColumns(for days: [Date], columnWidth: CGFloat) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(days, id: \.timeIntervalSince1970) { day in
                dayColumn(day, days: days)
                    .frame(width: columnWidth)
                    // The seam belongs to the column it opens rather than
                    // sitting between two of them: a run that slides a day at a
                    // time has to keep every column exactly one column wide, or
                    // the hours drift away from the dates above them.
                    .overlay(alignment: .leading) {
                        if day != days.first {
                            Rectangle()
                                .fill(StarlingsMobileColors.border)
                                .frame(width: 1)
                        }
                    }
            }
        }
        .frame(height: hourHeight * 24)
    }

    private func dayColumn(_ day: Date, days: [Date]) -> some View {
        GeometryReader { proxy in
            ZStack(alignment: .topLeading) {
                columnRungs(day)
                // The tap surface stays at the bottom of the stack: the hour
                // rules moved above the cards, and a rule that swallowed taps
                // would put a new event where you meant to open an old one.
                Color.clear
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .simultaneousGesture(
                        SpatialTapGesture().onEnded { value in
                            onCreate(slot(at: value.location.y, on: day))
                        }
                    )
                ForEach(store.timedLayout(for: day)) { item in
                    block(item, day: day, days: days, columnWidth: proxy.size.width)
                }
                // Over the cards, as on the Mac: the grid is how you read a
                // start and an end at a glance, so it has to stay legible
                // through a block rather than being buried under it.
                hourRules
                    .allowsHitTesting(false)
                    .zIndex(1_500)
                if Calendar.current.isDateInToday(day) {
                    nowLine.zIndex(2_000)
                }
            }
        }
        .frame(height: hourHeight * 24)
        .frame(maxWidth: .infinity)
    }

    /// One flat background per column: a weekend low, a weekday at rest.
    ///
    /// The working-hours band came off. On a wide Mac week it is a quiet
    /// reading aid; on a phone the column *is* the screen, so a lift over eight
    /// of its hours read as a block of shading with a hard edge at 08:00 and
    /// another at 20:00 — a second thing to interpret behind the events. The
    /// preference still decides where the view opens, which is what it is
    /// actually used for here.
    private func columnRungs(_ day: Date) -> some View {
        let weekend = Calendar.current.isDateInWeekend(day)
        return weekend ? StarlingsMobileColors.rungOff : StarlingsMobileColors.rungDay
    }

    /// Today's two rails. Both edges rather than one: a single rule reads as
    /// the boundary between two days, and it would be ambiguous which of them
    /// it meant. Bracketed, the column is named.
    private var hourRules: some View {
        // The same threshold the Mac uses: below it the half hour is a smudge
        // rather than a reading aid.
        let drawsHalfHours = hourHeight >= 40
        return VStack(spacing: 0) {
            ForEach(0..<24, id: \.self) { _ in
                ZStack(alignment: .top) {
                    Rectangle().fill(StarlingsMobileColors.border).frame(height: 1)
                    if drawsHalfHours {
                        Rectangle()
                            .fill(StarlingsMobileColors.border.opacity(0.5))
                            .frame(height: 0.5)
                            .offset(y: hourHeight / 2)
                    }
                }
                .frame(height: hourHeight, alignment: .top)
            }
        }
    }

    private var nowLine: some View {
        TimelineView(.periodic(from: .now, by: 60)) { timeline in
            let minutes = MobileCalendarChrome.minutesFromMidnight(timeline.date, day: timeline.date)
            Rectangle()
                .fill(StarlingsMobileColors.accent)
                .frame(height: 1)
                .offset(y: CGFloat(minutes / 60) * hourHeight)
                .accessibilityHidden(true)
        }
    }

    @ViewBuilder
    private func block(
        _ item: MobileCalendarTimedBlock,
        day: Date,
        days: [Date],
        columnWidth: CGFloat
    ) -> some View {
        let event = item.content.eventGroup?.event
        let activeMove = event.flatMap { moving?.eventID == $0.id ? moving : nil }
        let displayDay = activeMove.map {
            targetDay(originIndex: dayIndex(of: day, in: days), dayDelta: $0.dayDelta, in: days)
        } ?? day
        let displayStart = activeMove?.start ?? item.span.start
        let displayEnd = activeMove?.end ?? item.span.end
        let top = CGFloat(
            MobileCalendarChrome.minutesFromMidnight(displayStart, day: displayDay)
        ) / 60 * hourHeight
        let height = max(
            18,
            CGFloat(displayEnd.timeIntervalSince(displayStart) / 3_600) * hourHeight - 2
        )
        let usableWidth = max(0, columnWidth - 2)
        // Colliding cards cascade instead of sharing the column evenly, so a
        // lane runs from its own left edge to the right of the day. The card in
        // front is the one on top, and the ones behind it keep a visible,
        // tappable stub — which is also why the minimum width is clamped: a
        // narrow phone column must not push a card into the next day.
        let leading = usableWidth * CGFloat(item.pack.horizontalLeadingFraction)
        let width = min(usableWidth, max(24, usableWidth * CGFloat(item.pack.horizontalWidthFraction)))
        let x = min(1 + leading, max(1, columnWidth - 1 - width))
            + columnWidth * CGFloat(activeMove?.dayDelta ?? 0)

        // Lane order decides both what paints on top and what a tap lands on.
        let lane = Double(item.pack.column)
        slotView(
            item.content,
            isSelected: activeMove != nil,
            // Only a cascading card has to hide what it covers.
            isLayered: item.pack.columnCount > 1
        )
            .frame(width: width, height: height)
            .accessibilityAction { select(item.content) }
            .overlay(cardTouch(
                item.content,
                event: event,
                days: days,
                originIndex: dayIndex(of: day, in: days),
                columnWidth: columnWidth
            ))
            // On the card and its UIKit touch layer together, so the
            // recognizer view does not stand between the pointer and onHover.
            .meetHoverLift(cornerRadius: MobileCalendarChrome.cornerRadius)
            .offset(x: x, y: top)
            .zIndex(activeMove == nil ? lane : 1_000)
    }

    /// Tap to open, long press to pick up — both as UIKit recognizers. See
    /// `MobileCalendarCardTouch`: the SwiftUI pair took the grid's scrolling
    /// away with it.
    private func cardTouch(
        _ slot: MobileCalendarSlot,
        event: StarlingsCalendarEvent?,
        days: [Date],
        originIndex: Int,
        columnWidth: CGFloat
    ) -> some View {
        MobileCalendarCardTouch(
            canMove: event.map(canMove) ?? false,
            onTap: { select(slot) },
            onMoveChanged: { translation in
                guard let event else { return }
                moving = movePreview(
                    for: event,
                    days: days,
                    originIndex: originIndex,
                    translation: translation,
                    columnWidth: columnWidth
                )
            },
            onMoveEnded: { translation in
                moving = nil
                guard let event else { return }
                let preview = movePreview(
                    for: event,
                    days: days,
                    originIndex: originIndex,
                    translation: translation,
                    columnWidth: columnWidth
                )
                guard preview.start != event.start || preview.end != event.end else { return }
                dropped.fire(.tap)
                Task { await store.reschedule(event, start: preview.start, end: preview.end) }
            }
        )
    }

    @ViewBuilder
    private func slotView(
        _ slot: MobileCalendarSlot,
        isSelected: Bool = false,
        isCompact: Bool = false,
        isLayered: Bool = false,
        titleInset: CGFloat = 0
    ) -> some View {
        switch slot {
        case .event(let group):
            MobileCalendarEventBlock(
                group: group,
                colors: store.colors(for: group),
                isSelected: isSelected,
                isCompact: isCompact,
                isLayered: isLayered,
                titleInset: titleInset
            )
        case .layer(let item):
            MobileCalendarLayerBlock(
                item: item,
                isCompact: isCompact,
                isLayered: isLayered,
                titleInset: titleInset
            )
        }
    }

    private func select(_ slot: MobileCalendarSlot) {
        switch slot {
        case .event(let group): onSelect(group)
        case .layer(let item): onSelectLayer(item)
        }
    }

    /// Which quarter hour a tap at `y` landed on.
    private func slot(at y: CGFloat, on day: Date) -> Date {
        let minutes = max(0, min(24 * 60 - 30, Double(y / hourHeight) * 60))
        let start = Calendar.current.startOfDay(for: day).addingTimeInterval(minutes * 60)
        return CalendarWeekMath.snap(start, minutes: CalendarWindowPreferences.snapMinutes())
    }

    private func dayIndex(of day: Date, in days: [Date]) -> Int {
        days.firstIndex { Calendar.current.isDate($0, inSameDayAs: day) } ?? 0
    }

    private func targetDay(originIndex: Int, dayDelta: Int, in days: [Date]) -> Date {
        let index = max(0, min(days.count - 1, originIndex + dayDelta))
        return days[index]
    }

    private func canMove(_ event: StarlingsCalendarEvent) -> Bool {
        event.isWritable && event.source != .subscription
    }

    private func movePreview(
        for event: StarlingsCalendarEvent,
        days: [Date],
        originIndex: Int,
        translation: CGSize,
        columnWidth: CGFloat
    ) -> MobileCalendarMove {
        let calendar = Calendar.current
        let horizontalStep = max(1, columnWidth)
        let requestedDelta = Int((translation.width / horizontalStep).rounded())
        let dayDelta = max(-originIndex, min(days.count - 1 - originIndex, requestedDelta))
        let destination = targetDay(originIndex: originIndex, dayDelta: dayDelta, in: days)
        let destinationStart = calendar.startOfDay(for: destination)
        let duration = max(60, event.end.timeIntervalSince(event.start))

        let start: Date
        if event.isAllDay {
            start = destinationStart
        } else {
            let originalDay = calendar.startOfDay(for: event.start)
            let secondsIntoDay = event.start.timeIntervalSince(originalDay)
            let raw = destinationStart
                .addingTimeInterval(secondsIntoDay)
                .addingTimeInterval(Double(translation.height / hourHeight * 60) * 60)
            let snapped = CalendarWeekMath.snap(raw, minutes: CalendarWindowPreferences.snapMinutes())
            let latest = destinationStart.addingTimeInterval(max(0, 86_400 - duration))
            start = min(latest, max(destinationStart, snapped))
        }
        return MobileCalendarMove(
            eventID: event.id,
            start: start,
            end: start.addingTimeInterval(duration),
            dayDelta: dayDelta
        )
    }

    private func secondaryHourLabel(_ hour: Int, zone: StarlingsScheduleTimeZone, days: [Date]) -> String {
        let reference = Calendar.current.startOfDay(for: days.first ?? Date())
        let instant = Calendar.current.date(byAdding: .hour, value: hour, to: reference) ?? reference
        let hour = zone.calendar.component(.hour, from: instant)
        return CalendarWeekMath.hourLabel(hour)
    }
}

/// A card's own gestures, as UIKit recognizers.
///
/// SwiftUI's `LongPressGesture.sequenced(before: DragGesture())` claims the
/// touch the moment a finger lands on a card, and the scroll view and the pager
/// never get the pan — so the day could not be scrolled or paged from anywhere
/// a card sat, which after cards started cascading to the full width of a
/// column was most of it. A `UILongPressGestureRecognizer` waits its turn the
/// way collection-view reordering does: movement cancels it and the grid
/// scrolls, stillness recognises it and the card comes up.
private struct MobileCalendarCardTouch: UIViewRepresentable {
    /// A read-only or subscribed event is tap-only; nothing arms.
    var canMove: Bool
    let onTap: () -> Void
    let onMoveChanged: (CGSize) -> Void
    let onMoveEnded: (CGSize) -> Void

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        view.addGestureRecognizer(UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.tapped)
        ))
        let press = UILongPressGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.pressed(_:))
        )
        // Long enough that an ordinary drag starting with a pause still
        // scrolls: below about half a second, a finger that settles before it
        // moves picks the card up instead, and the grid reads as stuck.
        press.minimumPressDuration = 0.5
        // Slop, not a drag: any real movement fails the press and the grid
        // scrolls. Tight on purpose — a still finger drifts a point or two.
        press.allowableMovement = 6
        press.isEnabled = canMove
        press.delegate = context.coordinator
        view.addGestureRecognizer(press)
        context.coordinator.owner = self
        context.coordinator.press = press
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.owner = self
        context.coordinator.press?.isEnabled = canMove
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var owner: MobileCalendarCardTouch?
        weak var press: UILongPressGestureRecognizer?
        /// Where the press began, and how far the finger has carried it since.
        private var origin: CGPoint = .zero
        private var translation: CGSize = .zero
        /// Held only while a card is up, to give the move the grid's full
        /// attention — and always handed back when the press ends.
        private weak var heldScrollView: UIScrollView?

        @objc func tapped() { owner?.onTap() }

        /// A finger landing on a grid that is already moving — mid-drag or
        /// still coasting — is there to stop it, not to reach for an event.
        /// Without this the pickup and the scroll race each other, and which
        /// one wins depends on how still the hand happens to be.
        nonisolated func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            MainActor.assumeIsolated {
                guard recognizer is UILongPressGestureRecognizer else { return true }
                guard let scroll = Self.enclosingScrollView(of: recognizer.view) else { return true }
                return !scroll.isDragging && !scroll.isDecelerating
            }
        }

        private static func enclosingScrollView(of view: UIView?) -> UIScrollView? {
            var next = view?.superview
            while let current = next {
                if let scroll = current as? UIScrollView { return scroll }
                next = current.superview
            }
            return nil
        }

        @objc func pressed(_ recognizer: UILongPressGestureRecognizer) {
            // In the window's space: the card itself moves under the finger.
            let point = recognizer.location(in: recognizer.view?.window)
            switch recognizer.state {
            case .began:
                origin = point
                translation = .zero
                // The card is now yours to place, and nothing else on screen
                // will move — say so, or a stuck-looking grid is all you get.
                StarlingsHaptics.toggle.play(in: recognizer.view)
                // And make that true: a card being placed must not also drag
                // the day out from under itself.
                if let scroll = Self.enclosingScrollView(of: recognizer.view) {
                    heldScrollView = scroll
                    scroll.isScrollEnabled = false
                }
                owner?.onMoveChanged(.zero)
            case .changed:
                translation = CGSize(width: point.x - origin.x, height: point.y - origin.y)
                owner?.onMoveChanged(translation)
            case .ended, .cancelled, .failed:
                // Every terminal state, so scrolling can never stay switched off.
                heldScrollView?.isScrollEnabled = true
                heldScrollView = nil
                owner?.onMoveEnded(translation)
                translation = .zero
            default:
                break
            }
        }
    }
}

/// The hour grid ends at 00:00 and 24:00. A rubber band there showed an empty
/// stripe between the date header and midnight (#617), so the scroll view it
/// sits in stops dead at its ends. Vertical only: the day paging is not a
/// scroll view scroll.
private struct MobileCalendarNoBounce: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView {
        let view = Probe()
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        (uiView as? Probe)?.apply()
    }

    private final class Probe: UIView {
        override func didMoveToWindow() {
            super.didMoveToWindow()
            apply()
        }

        func apply() {
            var next = superview
            while let current = next {
                if let scroll = current as? UIScrollView {
                    scroll.bounces = false
                    scroll.alwaysBounceVertical = false
                    return
                }
                next = current.superview
            }
        }
    }
}

/// How far the grid has scrolled, read back out of the scroll view so a pinch
/// can hold its place in the day.
private struct MobileCalendarScrollOffset: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private struct MobileCalendarMove: Equatable {
    let eventID: String
    let start: Date
    let end: Date
    let dayDelta: Int
}
