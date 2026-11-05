import SwiftUI

extension StarlingsRGBColor {
    var swiftUIColor: Color {
        Color(.sRGB, red: red, green: green, blue: blue, opacity: 1)
    }

    /// Ink that stays readable on this colour — the SwiftUI twin of
    /// `contrastingText` on Mac, using the same threshold.
    var contrastingInk: Color {
        luminance > 0.62 ? Color.black.opacity(0.82) : .white
    }
}

/// Metrics and the event-block look, kept in one place so the day, week, and
/// month views cannot drift apart. The colour policy is the same one
/// `CalendarEventChrome` draws on Mac: a light tint so hour rules read through
/// the block, with the calendar's colour carried by a leading stripe.
enum MobileCalendarChrome {
    static var hourHeight: CGFloat { CalendarWindowPreferences.hourHeight() }
    static let baseGutterWidth: CGFloat = 32
    static let stripeWidth: CGFloat = 3
    static let cornerRadius: CGFloat = 6
    static let allDayRowHeight: CGFloat = 22
    /// Two rows of 14pt marks with insets. Below this the guest mark stays
    /// on the title row; at or above, it takes the bottom-right corner.
    static let cornerMarkMinHeight: CGFloat = 36
    /// What a tile's rows cost, for `CalendarTileDetail.rows`: the title line,
    /// one 10pt row under it, and the tile's top and bottom inset together.
    static let tileTitleHeight: CGFloat = 15
    static let tileRowHeight: CGFloat = 12
    static let tileRowsPadding: CGFloat = 4
    static let pastOpacity = 0.72
    /// Hidden from Next: a ghost of the block, there if you look for it.
    static let demotedOpacity = 0.4

    static func gutterWidth(hasSecondaryTimeZone: Bool) -> CGFloat {
        hasSecondaryTimeZone ? 48 : baseGutterWidth
    }

    /// A card in a cascade covers part of the card behind it, and the fill
    /// above is translucent by design — so it needs the page under it first.
    /// Without that, the covered title reads straight through this one.
    @ViewBuilder
    static func layerBase(_ isLayered: Bool) -> some View {
        if isLayered { StarlingsMobileColors.canvas } else { Color.clear }
    }

    static func fillOpacity(response: CalendarRSVP?, isSelected: Bool) -> Double {
        if isSelected { return 0.32 }
        // A declined event stays on the day but recedes.
        return response == .declined ? 0.07 : 0.18
    }

    /// Minutes from midnight, for placing a block in a day column.
    static func minutesFromMidnight(_ date: Date, day: Date, calendar: Calendar = .current) -> Double {
        date.timeIntervalSince(calendar.startOfDay(for: day)) / 60
    }

    static func timeRangeLabel(_ event: StarlingsCalendarEvent) -> String {
        guard !event.isAllDay else { return "All day" }
        let start = event.start.meetTimeString()
        let end = event.end.meetTimeString()
        return String(localized: "\(start) – \(end)")
    }
}

/// The provider mark shared by iOS Upcoming and Calendar. External marks keep
/// their familiar brand shapes; our own room uses the same Starlings glyph as
/// the rest of Meet and receives the caller's accent/neutral ink.
struct MobileMeetingPlatformMark: View {
    let platform: CalendarMeetingPlatform
    var size: CGFloat = 14
    var color: Color = .secondary

    var body: some View {
        Group {
            switch platform {
            case .starlings:
                // The brand paths below sit inset in their viewBox (Zoom and
                // Teams fill ~72% of it); the Starlings glyph fills its square. Draw
                // it at that same fraction so it reads the same size as them.
                // A room is the workspace's own: its mark.
                StarlingsCurrentWorkspaceMark(size: size * 0.72, ink: color)
                    .frame(width: size, height: size)
            case .none:
                Image(systemName: "calendar")
                    .font(.system(size: size * 0.82, weight: .medium))
                    .foregroundStyle(color)
                    .frame(width: size, height: size)
            default:
                MeetingPlatformVectorMark(platform: platform, size: size, color: color)
            }
        }
        .accessibilityHidden(true)
    }
}

/// One metadata row under a tile's title: a small symbol, then one truncated
/// line (#610). Symbols, never emoji.
struct MobileCalendarTileRow: View {
    let symbol: String
    let text: String

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: symbol)
                .font(.system(size: 8, weight: .medium))
                .frame(width: 9)
                .accessibilityHidden(true)
            Text(text)
                .font(.system(size: 10))
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .foregroundStyle(.secondary)
        .frame(height: MobileCalendarChrome.tileRowHeight, alignment: .leading)
    }
}

/// The guest mark: a person with the answer the guests gave. Same corner as
/// the platform mark, same size, so a card reads "where" and "who" in one look.
struct MobileCalendarAttendanceMark: View {
    let attendance: CalendarAttendance
    var size: CGFloat = 14
    var declined = false

    var body: some View {
        Image(systemName: attendance.symbolName)
            .font(.system(size: size * 0.82, weight: .medium))
            .foregroundStyle(
                declined || attendance != .confirmed ? Color.secondary : Color.primary
            )
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

private struct MeetingPlatformVectorMark: View {
    let platform: CalendarMeetingPlatform
    let size: CGFloat
    let color: Color

    var body: some View {
        MeetingPlatformVectorShape(platform: platform)
            .fill(color)
        .frame(width: size, height: size)
    }
}

private struct MeetingPlatformVectorShape: Shape {
    let platform: CalendarMeetingPlatform

    func path(in rect: CGRect) -> Path {
        guard let path = MeetingPlatformMarkGeometry.path(for: platform, in: rect) else {
            return Path()
        }
        return Path(path)
    }
}

/// One drawn layer row: a published event, a milestone, a dated task.
///
/// All three come from Envisioning rather than from a calendar you keep, so
/// they carry our mark in the corner — and only there. The title starts where
/// every other title starts, because a symbol in front of it makes these rows
/// read as a different species of thing at exactly the moment you are scanning
/// the day for what is on it.
///
/// A published event is a place to be, so it is drawn like one: title in the
/// top-left with its time under it, same as an event block. A milestone or a
/// task is *true* of the day rather than sitting inside it, so it keeps the
/// centred marker shape. Work that is not yours is dimmed rather than hidden.
struct MobileCalendarLayerBlock: View {
    let item: CalendarLayerItem
    var isCompact = false
    /// One of a cascade of colliding cards, so it may be sitting on another.
    var isLayered = false
    /// See `MobileCalendarEventBlock.titleInset` — same job, same reason.
    var titleInset: CGFloat = 0
    @ScaledMetric(relativeTo: .caption2) var compactTitleSize: CGFloat = 9

    private var tint: Color { item.kind.color.swiftUIColor }
    private var emphasis: Double { item.kind == .tasks && !item.isMine ? 0.55 : 1 }
    private var isEventLike: Bool { item.kind == .publicEvents }
    /// A block's time is its whole content, so it is written out like an event's.
    private var showsTime: Bool { isEventLike || item.kind == .availability }

    /// Past rows recede like past events, checked once a minute.
    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { timeline in
            block.opacity(item.isPast(at: timeline.date) ? MobileCalendarChrome.pastOpacity : 1)
        }
    }

    private var block: some View {
        HStack(alignment: .top, spacing: 5) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 5) {
                    Text(item.displayTitle)
                        .font(titleFont)
                        .lineLimit(isCompact ? 1 : (isEventLike ? 2 : 1))
                        .foregroundStyle(Color.primary.opacity(emphasis))
                    if !isCompact, !isEventLike, !item.assignee.isEmpty, !item.isMine {
                        Text(item.assignee)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                if !isCompact, showsTime, !item.isAllDay {
                    Text(timeLine)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 2)
            StarlingsCurrentWorkspaceMark(
                size: isCompact ? 9 : 11,
                ink: Color.primary.opacity(emphasis)
            )
        }
        .padding(.horizontal, 5)
        .padding(.leading, titleInset)
        .padding(.vertical, isCompact ? 1 : 3)
        .frame(
            maxWidth: .infinity,
            maxHeight: .infinity,
            // A tall block (a day of availability) reads from its top edge
            // like every event; only a one-line chip centres.
            alignment: isCompact ? .leading : .topLeading
        )
        .background(tint.opacity(isCompact ? 0.10 : 0.13))
        // Behind the tint, not in front of it: a later background is further back.
        .background(MobileCalendarChrome.layerBase(isLayered))
        .overlay(alignment: .leading) {
            Rectangle().fill(tint.opacity(emphasis)).frame(width: MobileCalendarChrome.stripeWidth)
        }
        .clipShape(RoundedRectangle(cornerRadius: MobileCalendarChrome.cornerRadius, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(MobileCalendarChrome.describe(item))
    }

    private var titleFont: Font {
        if isCompact { return .system(size: compactTitleSize) }
        return isEventLike ? .caption.weight(.semibold) : .caption
    }

    private var timeLine: String {
        let start = item.start.meetTimeString()
        guard item.kind == .availability else { return start }
        return String(localized: "\(start) – \(item.end.meetTimeString())")
    }
}

extension MobileCalendarChrome {
    /// Spoken form, matching the phrasing `CalendarAccessibility` uses for
    /// events so a day reads consistently.
    static func describe(_ item: CalendarLayerItem) -> String {
        var parts: [String] = [item.displayTitle]
        switch item.kind {
        case .milestones: parts.append("milestone")
        case .tasks: parts.append("task")
        case .publicEvents: parts.append(String(localized: "\(StarlingsWorkspace.active.name) event"))
        case .availability: parts.append(String(localized: "open for booking"))
        }
        if item.kind == .availability {
            parts.append(
                "\(item.start.meetDateTimeString(dateStyle: .abbreviated)) to "
                + item.end.meetTimeString()
            )
        } else if item.isAllDay {
            parts.append(item.start.formatted(date: .abbreviated, time: .omitted))
        } else {
            parts.append(String(localized: "due \(item.start.meetDateTimeString(dateStyle: .abbreviated))"))
        }
        if !item.detail.isEmpty { parts.append(item.detail) }
        if !item.assignee.isEmpty { parts.append(item.isMine ? "yours" : item.assignee) }
        return parts.joined(separator: ", ")
    }
}

/// One drawn event. Used by the day/week grid at full height and by the month
/// grid and agenda as a single-line chip.
struct MobileCalendarEventBlock: View {
    let group: CalendarEventGroup
    let colors: [StarlingsRGBColor]
    var isSelected = false
    var isCompact = false
    /// One of a cascade of colliding cards, so it may be sitting on another.
    var isLayered = false
    /// How far in the title starts. A multi-day all-day card is drawn once
    /// across every day it covers, so on the second day of a trip its title sat
    /// off the left of the screen. The card keeps its full run — the words move.
    var titleInset: CGFloat = 0

    private var event: StarlingsCalendarEvent { group.event }
    private var primary: StarlingsRGBColor { colors.first ?? StarlingsRGBColor.fallback(at: 0) }
    private var declined: Bool { event.myResponse == .declined }

    /// `guestsInCorner`: the block is tall enough that "who" gets its own
    /// corner, bottom-right, and the title row keeps only the "where" marks.
    private func eventBody(guestsInCorner: Bool, height: CGFloat? = nil) -> some View {
        // Location and time under the title as the tile grows (#610): the same
        // rows, order and fit rule as the Mac and the web (`CalendarTileDetail`).
        let detail = (isCompact || event.isAllDay) ? nil : CalendarTileDetail(event: event)
        let rows = height.flatMap { height in
            detail.map {
                CalendarTileDetail.rows(
                    height: height,
                    titleHeight: MobileCalendarChrome.tileTitleHeight,
                    rowHeight: MobileCalendarChrome.tileRowHeight,
                    padding: MobileCalendarChrome.tileRowsPadding,
                    hasLocation: $0.location != nil
                )
            }
        }
        let showsRows = rows?.time == true
        return HStack(spacing: 0) {
            stripe
            VStack(alignment: .leading, spacing: showsRows ? 0 : 1) {
                // Our mark rides in the corner, not in front of the title: the
                // title is what the card is read for, and a badge that pushes
                // it right costs every event a few characters. Top-aligned so
                // it stays put whether the title wraps to one line or two.
                HStack(alignment: .top, spacing: 3) {
                    Text(event.displayTitle)
                        .font(isCompact ? .caption2 : .caption.weight(.semibold))
                        .lineLimit(isCompact || showsRows ? 1 : 2)
                        .strikethrough(declined, color: Color.secondary)
                    if event.meetingPlatform != .none {
                        Spacer(minLength: 2)
                        MobileMeetingPlatformMark(
                            platform: event.meetingPlatform,
                            size: 14,
                            color: event.meetingPlatform == .starlings
                                ? (declined ? Color.secondary : StarlingsMobileColors.accent)
                                : Color.secondary
                        )
                    }
                    if event.calendarRole == .globalInterest && event.meetingPlatform == .none {
                        Spacer(minLength: 2)
                        MobileMeetingPlatformMark(
                            platform: .starlings,
                            size: 14,
                            color: declined ? Color.secondary : Color.primary
                        )
                    }
                    if let attendance = event.attendance, !guestsInCorner {
                        Spacer(minLength: 2)
                        MobileCalendarAttendanceMark(attendance: attendance, size: 14, declined: declined)
                    }
                }
                if let detail, showsRows {
                    // The guest mark owns the bottom-right corner when it has one.
                    let clearOfMark: CGFloat = guestsInCorner && event.attendance != nil ? 16 : 0
                    if rows?.location == true, let place = detail.location {
                        MobileCalendarTileRow(symbol: "mappin", text: place)
                            .padding(.trailing, clearOfMark)
                    }
                    MobileCalendarTileRow(symbol: "clock", text: detail.time)
                        .padding(.trailing, clearOfMark)
                }
            }
            .foregroundStyle(declined ? Color.secondary : Color.primary)
            .padding(.leading, 5 + titleInset)
            .padding(.vertical, isCompact ? 1 : (showsRows ? MobileCalendarChrome.tileRowsPadding / 2 : 3))
            .padding(.trailing, 4)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .overlay(alignment: .bottomTrailing) {
            if let attendance = event.attendance, guestsInCorner {
                MobileCalendarAttendanceMark(attendance: attendance, size: 14, declined: declined)
                    .padding(.trailing, 4)
                    .padding(.bottom, 3)
            }
        }
        .background(
            primary.swiftUIColor.opacity(
                MobileCalendarChrome.fillOpacity(response: event.myResponse, isSelected: isSelected)
            )
        )
        // Behind the tint, not in front of it: a later background is further back.
        .background(MobileCalendarChrome.layerBase(isLayered))
        .clipShape(RoundedRectangle(cornerRadius: MobileCalendarChrome.cornerRadius, style: .continuous))
        .overlay {
            // An unanswered invitation reads as an outline: on the calendar, not
            // yet agreed to.
            if event.myResponse == .needsAction {
                RoundedRectangle(cornerRadius: MobileCalendarChrome.cornerRadius, style: .continuous)
                    .strokeBorder(
                        primary.swiftUIColor.opacity(0.8),
                        style: StrokeStyle(lineWidth: 1, dash: [3, 2])
                    )
            }
        }
        .overlay {
            if isSelected {
                RoundedRectangle(cornerRadius: MobileCalendarChrome.cornerRadius, style: .continuous)
                    .strokeBorder(StarlingsMobileColors.borderHover, lineWidth: 2)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            CalendarAccessibility.describe(event, calendarName: nil)
                + (event.isDemoted ? String(localized: ", hidden from Next") : "")
        )
        .accessibilityAddTraits(.isButton)
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { timeline in
            let fade = (event.isDemoted ? MobileCalendarChrome.demotedOpacity : 1)
                * (event.isPast(at: timeline.date) ? MobileCalendarChrome.pastOpacity : 1)
            if isCompact {
                // A chip is one line; there is no corner to give.
                eventBody(guestsInCorner: false).opacity(fade)
            } else {
                // The grid hands the block its frame, so reading the height
                // here costs nothing and lets a short block keep the mark on
                // the title row.
                GeometryReader { proxy in
                    eventBody(
                        guestsInCorner: proxy.size.height >= MobileCalendarChrome.cornerMarkMinHeight,
                        height: proxy.size.height
                    )
                }
                .opacity(fade)
            }
        }
    }

    /// Split between every calendar carrying this event, so a merged block still
    /// shows which subscriptions it came from.
    private var stripe: some View {
        GeometryReader { proxy in
            VStack(spacing: 0) {
                let painted = colors.isEmpty ? [primary] : colors
                ForEach(Array(painted.enumerated()), id: \.offset) { _, color in
                    color.swiftUIColor
                        .opacity(declined ? 0.45 : 1)
                        .frame(height: proxy.size.height / CGFloat(painted.count))
                }
            }
        }
        .frame(width: MobileCalendarChrome.stripeWidth)
    }
}

/// Move to, grouped by account, the event's own calendar ticked and inert.
/// The Mac's submenu (`CalendarViewController.contextMenu(for:)`) reads the
/// same `moveMenuCalendars(for:)`. Draw it only when the event can move:
/// `isWritable && canMoveBetweenCalendars`.
struct MobileCalendarMoveMenu: View {
    @ObservedObject var store: MobileCalendarStore
    let event: StarlingsCalendarEvent
    /// Moves the event to the chosen calendar, by id.
    var move: (String) -> Void

    var body: some View {
        let choices = store.calendarChoices(for: event)
        Menu {
            ForEach(StarlingsCalendar.orderedGroups(of: choices), id: \.self) { group in
                Section(group) {
                    ForEach(choices.filter { $0.groupTitle == group }) { calendar in
                        if calendar.id == event.calendarID {
                            Label(calendar.title, systemImage: "checkmark")
                        } else {
                            Button(calendar.title) { move(calendar.id) }
                        }
                    }
                }
            }
        } label: {
            Label("Move to", systemImage: "tray.and.arrow.down")
        }
    }
}

/// An event's long-press menu in the month grid and the agenda: open it,
/// move it, and hide it from Next. The day and week grid keep long-press for
/// dragging a card to a new time, so they have no menu.
struct MobileCalendarEventMenu: View {
    @ObservedObject var store: MobileCalendarStore
    let group: CalendarEventGroup
    let open: () -> Void

    private var event: StarlingsCalendarEvent { group.event }

    var body: some View {
        Button(action: open) { Label("Open", systemImage: "arrow.up.right.square") }
        if event.isWritable, event.canMoveBetweenCalendars {
            MobileCalendarMoveMenu(store: store, event: event) { calendarID in
                Task { _ = await store.move(event, to: calendarID) }
            }
        }
        Button {
            Task { _ = await store.setDemoted(event, demoted: !event.isDemoted) }
        } label: {
            Label(
                event.isDemoted ? String(localized: "Show in Next") : String(localized: "Hide from Next"),
                systemImage: event.isDemoted ? "eye" : "eye.slash"
            )
        }
    }
}
