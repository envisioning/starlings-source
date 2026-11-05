import EnvisioningUI
import SwiftUI
import WidgetKit

/// Two more Home Screen widgets beside Next meeting, both read
/// from the agenda file the app writes into the shared group — never a
/// token, never a body:
///
/// - **Today's agenda**: what is left of today, the rows Home draws under
///   the hero, each a `StarlingsGlance` line that opens the meeting.
/// - **Today's work**: overdue and due today, the block Home's WORK card
///   and the Mac menu bar show, planned once on the phone by `WorkItems.focus`
///   and written as rows; each opens its subject on Tasks, or Mine.
///
/// Same words and glyphs as Home, no explainer line. Both follow the glance
/// contract: `WidgetInk`, `StarlingsGlyphMark`, and nothing decided here
/// that Home decides elsewhere.

// MARK: - Today's agenda

struct TodayAgendaWidget: Widget {
    static let kind = WatchBridgeSnapshot.todayAgendaWidgetKind

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: NextMeetingProvider()) { entry in
            TodayAgendaView(entry: entry)
                .containerBackground(WidgetInk.panel, for: .widget)
        }
        .configurationDisplayName("Today’s agenda")
        .description("What is left of today in Starlings.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

private struct TodayAgendaView: View {
    @Environment(\.widgetFamily) private var family
    let entry: NextMeetingEntry

    /// The meeting under way, then the ones still to come — what the Mac's
    /// launch card calls `remainingToday`. The plan already dropped what has
    /// ended, every placeholder, and everything on another day.
    private var rows: [WatchBridgeSnapshot.Meeting] {
        entry.plan.events(in: .now) + entry.plan.events(in: .today)
    }

    private var limit: Int { family == .systemLarge ? 8 : 3 }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Image(systemName: "calendar")
                    .font(.caption2)
                    .foregroundStyle(WidgetInk.accent)
                    .accessibilityHidden(true)
                Text("TODAY")
                    .font(.caption2.bold())
                    .foregroundStyle(WidgetInk.secondary)
                Spacer()
                if rows.count > limit {
                    Text("+\(rows.count - limit)")
                        .font(.caption2)
                        .foregroundStyle(WidgetInk.secondary)
                }
            }
            if rows.isEmpty {
                Spacer(minLength: 0)
                Text(MeetingFocus.closedDaySummary(entry.plan))
                    .font(.subheadline)
                    .foregroundStyle(WidgetInk.secondary)
                    .lineLimit(2)
            } else {
                ForEach(rows.prefix(limit)) { meeting in
                    let glance = StarlingsGlance(meeting: meeting, plan: entry.plan)
                    // A row is a door: `Link` gives every row its own, where
                    // the tile's `widgetURL` would give all of them one.
                    Link(destination: glance.tapURL ?? URL(string: "\(StarlingsGlance.eventScheme)://calendar")!) {
                        TodayAgendaRow(glance: glance, now: entry.date)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct TodayAgendaRow: View {
    let glance: StarlingsGlance
    let now: Date

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: StarlingsGlyphMark.meeting(isVideo: glance.isVideo))
                .font(.caption2)
                .foregroundStyle(glance.hasStarted(at: now) ? WidgetInk.accent : WidgetInk.secondary)
                .accessibilityHidden(true)
            Text(glance.title)
                .font(.subheadline.weight(glance.hasStarted(at: now) ? .semibold : .regular))
                .foregroundStyle(WidgetInk.primary)
                .lineLimit(1)
            Spacer(minLength: 4)
            Text(glance.isAllDay ? String(localized: "All day") : StarlingsDateFormatting.time(glance.start))
                .font(.caption.monospacedDigit())
                .foregroundStyle(WidgetInk.secondary)
                .lineLimit(1)
                .fixedSize()
        }
    }
}

// MARK: - Today's work

struct TodayWorkWidget: Widget {
    static let kind = WatchBridgeSnapshot.todayWorkWidgetKind

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: TodayWorkProvider()) { entry in
            TodayWorkView(entry: entry)
                .containerBackground(WidgetInk.panel, for: .widget)
        }
        .configurationDisplayName("Today’s work")
        .description("What is overdue and due today.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct TodayWorkEntry: TimelineEntry {
    let date: Date
    let rows: [WatchBridgeSnapshot.WorkRow]
}

/// The rows are planned on the phone when its task list changes and the
/// store reloads this widget; the timeline itself only has to cross
/// midnight, when "today" moves and the file is stale until the app runs.
struct TodayWorkProvider: TimelineProvider {
    func placeholder(in context: Context) -> TodayWorkEntry {
        TodayWorkEntry(date: Date(), rows: [
            WatchBridgeSnapshot.WorkRow(id: "a", title: String(localized: "Send the proposal"), subjectTitle: "Acme rollout", subjectKind: "project", subjectID: "a", due: Date(), overdue: false),
            WatchBridgeSnapshot.WorkRow(id: "b", title: String(localized: "Review the deck"), subjectTitle: "Globex", subjectKind: "lead", subjectID: "b", due: Date().addingTimeInterval(-86_400), overdue: true),
        ])
    }

    func getSnapshot(in context: Context, completion: @escaping (TodayWorkEntry) -> Void) {
        completion(TodayWorkEntry(date: Date(), rows: AgendaFile.read().work ?? []))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TodayWorkEntry>) -> Void) {
        let now = Date()
        let rows = AgendaFile.read().work ?? []
        var entries = [TodayWorkEntry(date: now, rows: rows)]
        if let midnight = Calendar.current.nextDate(after: now, matching: DateComponents(hour: 0, minute: 0, second: 0), matchingPolicy: .nextTime) {
            entries.append(TodayWorkEntry(date: midnight.addingTimeInterval(1), rows: rows))
        }
        completion(Timeline(entries: entries, policy: .atEnd))
    }
}

private struct TodayWorkView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TodayWorkEntry

    private var limit: Int { family == .systemSmall ? 3 : 5 }
    private var summary: String { WatchBridgeSnapshot.WorkRow.summary(entry.rows) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Image(systemName: "checkmark.circle")
                    .font(.caption2)
                    .foregroundStyle(WidgetInk.accent)
                    .accessibilityHidden(true)
                Text("WORK")
                    .font(.caption2.bold())
                    .foregroundStyle(WidgetInk.secondary)
                Spacer()
                if family != .systemSmall, !summary.isEmpty {
                    // The word "overdue" is already in the string — no tint on
                    // top of it (docs/DESIGN.md, "The accent budget").
                    Text(summary)
                        .font(.caption2.bold())
                        .foregroundStyle(WidgetInk.primary)
                }
            }
            if entry.rows.isEmpty {
                Spacer(minLength: 0)
                Text("Nothing due today.")
                    .font(.subheadline)
                    .foregroundStyle(WidgetInk.secondary)
            } else {
                ForEach(entry.rows.prefix(limit)) { row in
                    Link(destination: Self.door(for: row)) {
                        TodayWorkRow(row: row, compact: family == .systemSmall)
                    }
                }
                if entry.rows.count > limit {
                    Text("and \(entry.rows.count - limit) more in Work")
                        .font(.caption2)
                        .foregroundStyle(WidgetInk.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// The subject on Tasks, or Mine for a task Core kept without one — the
    /// doors Home's rows and Search use (`StarlingsAppModel.route`).
    static func door(for row: WatchBridgeSnapshot.WorkRow) -> URL {
        var components = URLComponents()
        components.scheme = StarlingsGlance.eventScheme
        components.host = "work"
        if let kind = row.subjectKind, let id = row.subjectID {
            components.path = "/subject/\(kind)/\(id)"
            components.queryItems = [URLQueryItem(name: "title", value: row.subjectTitle ?? "")]
        } else {
            components.path = "/task/\(row.id)"
        }
        return components.url ?? URL(string: "\(StarlingsGlance.eventScheme)://work")!
    }
}

private struct TodayWorkRow: View {
    let row: WatchBridgeSnapshot.WorkRow
    let compact: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "checkmark.circle")
                .font(.caption2)
                .foregroundStyle(row.overdue ? WidgetInk.primary : WidgetInk.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(row.title)
                    .font(.subheadline)
                    .foregroundStyle(WidgetInk.primary)
                    .lineLimit(1)
                if !compact, let subject = row.subjectTitle, !subject.isEmpty {
                    Text(subject)
                        .font(.caption2)
                        .foregroundStyle(WidgetInk.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            Text(row.overdue ? String(localized: "Overdue") : String(localized: "Today"))
                .font(.caption2)
                .foregroundStyle(WidgetInk.secondary)
                .fixedSize()
        }
        .accessibilityLabel([row.title, row.subjectTitle, row.overdue ? String(localized: "overdue") : String(localized: "due today")].compactMap { $0 }.joined(separator: ", "))
    }
}
