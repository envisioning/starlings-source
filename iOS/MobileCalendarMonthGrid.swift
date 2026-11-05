import EnvisioningUI
import SwiftUI

/// Six weeks of cells with the selected day's events listed underneath — the
/// shape iOS users already know, over the same 42-day grid the Mac draws.
struct MobileCalendarMonthGrid: View {
    @ObservedObject var store: MobileCalendarStore
    /// Passed in rather than read from the store: the pager builds the months
    /// either side too, and they are not the anchored one.
    let days: [Date]
    let monthAnchor: Date
    let onSelect: (CalendarEventGroup) -> Void
    let onSelectLayer: (CalendarLayerItem) -> Void

    var body: some View {
        VStack(spacing: 0) {
            // The cells cap at xxxLarge; the day list below scales
            // all the way, and is where an accessibility reader reads.
            VStack(spacing: 0) {
                weekdayHeader
                grid
            }
            .meetGridTypeSizeCap()
            Divider().overlay(StarlingsMobileColors.border)
            selectedDayList
        }
    }

    private var weekdayHeader: some View {
        HStack(spacing: 0) {
            ForEach(Array(days.prefix(7).enumerated()), id: \.offset) { _, day in
                Text(day.formatted(.dateTime.weekday(.narrow)))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, 6)
    }

    private var grid: some View {
        let rows = stride(from: 0, to: days.count, by: 7).map { Array(days[$0..<min($0 + 7, days.count)]) }
        return VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, week in
                HStack(spacing: 0) {
                    ForEach(week, id: \.timeIntervalSince1970) { day in
                        cell(day)
                    }
                }
            }
        }
    }

    private func cell(_ day: Date) -> some View {
        let calendar = Calendar.current
        let inMonth = calendar.isDate(day, equalTo: monthAnchor, toGranularity: .month)
        let isToday = calendar.isDateInToday(day)
        let isSelected = calendar.isDate(day, inSameDayAs: store.anchor)
        let groups = store.groups(on: day)
        let layers = store.layerItems(on: day)

        return VStack(spacing: 2) {
            Text(day.formatted(.dateTime.day()))
                .font(.caption.weight(isToday ? .bold : .regular))
                .foregroundStyle(
                    isToday
                        ? StarlingsMobileColors.accentInk
                        : (inMonth ? Color.primary : Color.secondary)
                )
                .frame(width: 22, height: 22)
                .background(isToday ? StarlingsMobileColors.accent : .clear, in: Circle())

            // Chips while they fit, then a count — a cell that tries to list ten
            // rows lists none of them legibly. Milestones come first: they are
            // what the day *is*, before they are something on it.
            ForEach(layers.prefix(1)) { item in
                MobileCalendarLayerBlock(item: item, isCompact: true).frame(height: 13)
            }
            ForEach(groups.prefix(layers.isEmpty ? 2 : 1), id: \.id) { group in
                MobileCalendarEventBlock(
                    group: group,
                    colors: store.colors(for: group),
                    isCompact: true
                )
                .frame(height: 13)
                .contextMenu { MobileCalendarEventMenu(store: store, group: group) { onSelect(group) } }
            }
            if overflow(groups: groups, layers: layers) > 0 {
                Text("+\(overflow(groups: groups, layers: layers))")
                    .font(.caption2).minimumScaleFactor(0.8)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 2)
        .padding(.top, 3)
        .frame(maxWidth: .infinity)
        .frame(height: 84)
        .background(isSelected ? StarlingsMobileColors.elevated : .clear)
        .overlay(alignment: .top) { Rectangle().fill(StarlingsMobileColors.border).frame(height: 1) }
        .contentShape(Rectangle())
        .onTapGesture { store.select(day: day) }
        // Square, as the grid is: the cells share their hairlines.
        .meetHoverLift(cornerRadius: 0)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(
            "\(day.formatted(.dateTime.weekday(.wide).month(.wide).day())), "
                + "\(groups.count) events, \(layers.count) other items"
        )
    }

    /// How many rows the cell could not draw.
    private func overflow(groups: [CalendarEventGroup], layers: [CalendarLayerItem]) -> Int {
        let drawn = min(layers.count, 1) + min(groups.count, layers.isEmpty ? 2 : 1)
        return max(0, groups.count + layers.count - drawn)
    }

    private var selectedDayList: some View {
        let groups = store.groups(on: store.anchor)
        let layers = store.layerItems(on: store.anchor)
        return ScrollView {
            LazyVStack(spacing: 8) {
                ForEach(layers) { item in
                    MobileCalendarLayerRow(item: item) { onSelectLayer(item) }
                }
                if groups.isEmpty, layers.isEmpty {
                    Text("Nothing on this day.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 18)
                } else {
                    ForEach(groups) { group in
                        MobileCalendarAgendaRow(
                            group: group,
                            colors: store.colors(for: group),
                            calendarTitle: store.calendarTitle(for: group.event.calendarID)
                        ) { onSelect(group) }
                        .contextMenu { MobileCalendarEventMenu(store: store, group: group) { onSelect(group) } }
                    }
                }
            }
            .padding(16)
        }
    }
}

/// The list view, and the row every list surface uses.
struct MobileCalendarAgendaList: View {
    @ObservedObject var store: MobileCalendarStore
    let days: [Date]
    let onSelect: (CalendarEventGroup) -> Void
    let onSelectLayer: (CalendarLayerItem) -> Void

    private var agenda: [MobileCalendarDaySection] { store.agenda(for: days) }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                if agenda.isEmpty {
                    Text("Nothing scheduled this week.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(.top, 24)
                }
                ForEach(agenda) { entry in
                    MobileCalendarDayDivider(day: entry.day)
                    ForEach(store.layerItems(on: entry.day)) { item in
                        MobileCalendarLayerRow(item: item) { onSelectLayer(item) }
                    }
                    ForEach(entry.groups) { group in
                        MobileCalendarAgendaRow(
                            group: group,
                            colors: store.colors(for: group),
                            calendarTitle: store.calendarTitle(for: group.event.calendarID)
                        ) { onSelect(group) }
                        .contextMenu { MobileCalendarEventMenu(store: store, group: group) { onSelect(group) } }
                    }
                }
            }
            .padding(16)
        }
    }
}

struct MobileCalendarDayDivider: View {
    let day: Date

    private var title: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(day) { return "TODAY" }
        if calendar.isDateInTomorrow(day) { return "TOMORROW" }
        return day.formatted(.dateTime.weekday(.wide).month(.wide).day()).uppercased()
    }

    var body: some View {
        HStack(spacing: 10) {
            Text(title)
                .font(.caption.bold())
                .foregroundStyle(
                    Calendar.current.isDateInToday(day)
                        ? StarlingsMobileColors.accent
                        : Color.secondary
                )
            Rectangle().fill(StarlingsMobileColors.border).frame(height: 1)
        }
        .padding(.top, 8)
    }
}

/// A layer row in a list. Built on the same bones as ``MobileCalendarAgendaRow``
/// — colour bar, title, one secondary line, same card — because a day's list is
/// read top to bottom and two different row shapes make that scan work harder
/// than it should. What marks these apart is the mark: they come from
/// Envisioning, so they carry our glyph in the corner instead of a symbol in
/// front of the title. Whose task it is now rides in the secondary line, where
/// the event row keeps its own second line.
struct MobileCalendarLayerRow: View {
    let item: CalendarLayerItem
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 12) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(item.kind.color.swiftUIColor)
                    .frame(width: 3)
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.displayTitle)
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    if !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                MobileMeetingPlatformMark(platform: .starlings, size: 14, color: Color.primary)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .meetContainerShape(cornerRadius: EnvisioningRadius.control)
            .meetConcentricBackground(
                StarlingsMobileColors.elevated,
                fallbackRadius: EnvisioningRadius.control
            )
            .meetHoverLift(cornerRadius: EnvisioningRadius.control, border: true)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(MobileCalendarChrome.describe(item))
    }

    private var subtitle: String {
        var parts: [String] = []
        if !item.isAllDay { parts.append(item.start.meetTimeString()) }
        if !item.detail.isEmpty { parts.append(item.detail) }
        if !item.assignee.isEmpty { parts.append(item.isMine ? String(localized: "You") : item.assignee) }
        return parts.joined(separator: " · ")
    }
}

struct MobileCalendarAgendaRow: View {
    let group: CalendarEventGroup
    let colors: [StarlingsRGBColor]
    let calendarTitle: String
    let action: () -> Void

    private var event: StarlingsCalendarEvent { group.event }

    private var eventBody: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 2)
                    .fill((colors.first ?? StarlingsRGBColor.fallback(at: 0)).swiftUIColor)
                    .frame(width: 3)
                VStack(alignment: .leading, spacing: 3) {
                    Text(event.displayTitle)
                        .font(.headline)
                        .lineLimit(1)
                        .strikethrough(event.myResponse == .declined, color: Color.secondary)
                    Text(MobileCalendarChrome.timeRangeLabel(event))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    let detail = [event.location.isEmpty ? calendarTitle : event.location,
                                  CalendarTravelTime.label(minutes: event.travelTimeMinutes)]
                        .compactMap { $0 }
                        .filter { !$0.isEmpty }
                        .joined(separator: " · ")
                    if !detail.isEmpty {
                        Text(detail)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if event.meetingPlatform != .none {
                    MobileMeetingPlatformMark(
                        platform: event.meetingPlatform,
                        size: 14,
                        color: event.meetingPlatform == .starlings ? StarlingsMobileColors.accent : .secondary
                    )
                }
                if let attendance = event.attendance {
                    MobileCalendarAttendanceMark(
                        attendance: attendance,
                        size: 14,
                        declined: event.myResponse == .declined
                    )
                }
                // Same answer the block in the grid gives: ours, marked in the
                // corner rather than in front of the title.
                if event.calendarRole == .globalInterest && event.meetingPlatform == .none {
                    // The row's other parts sit centred; the mark rides the top
                    // corner, so it lands in the same place on every card.
                    MobileMeetingPlatformMark(platform: .starlings, size: 14, color: Color.primary)
                        .frame(maxHeight: .infinity, alignment: .top)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .meetContainerShape(cornerRadius: EnvisioningRadius.control)
            .meetConcentricBackground(
                StarlingsMobileColors.elevated,
                fallbackRadius: EnvisioningRadius.control
            )
            .meetHoverLift(cornerRadius: EnvisioningRadius.control, border: true)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(CalendarAccessibility.describe(event, calendarName: calendarTitle))
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { timeline in
            eventBody.opacity(
                (event.isDemoted ? MobileCalendarChrome.demotedOpacity : 1)
                    * (event.isPast(at: timeline.date) ? MobileCalendarChrome.pastOpacity : 1)
            )
        }
    }
}
