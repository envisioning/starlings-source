import SwiftUI
import WidgetKit

/// The complication: the next meeting, read from the file the watch app
/// writes into the shared group. It has no session and makes no requests.
/// Which meeting is next is Home's rule (`MeetingFocus`, through
/// `AgendaFile.next`) and the words are `StarlingsGlance`'s, so the wrist agrees
/// with the phone's tiles. The drawing stays the system's: a
/// complication is tinted by the face, not by an ink table.
@main
struct StarlingsWatchWidgets: WidgetBundle {
    var body: some Widget {
        NextMeetingComplication()
        TodayWorkComplication()
    }
}

struct NextMeetingEntry: TimelineEntry {
    let date: Date
    let glance: StarlingsGlance?
}

/// The complication's timeline: the steps `AgendaFile.entryDates` gives.
struct NextMeetingProvider: TimelineProvider {
    func placeholder(in context: Context) -> NextMeetingEntry {
        NextMeetingEntry(
            date: Date(),
            glance: Self.entry(at: Date(), from: WatchBridgeSnapshot.Agenda(
                meetings: [WatchBridgeSnapshot.Meeting(
                    id: "placeholder",
                    title: String(localized: "Weekly sync"),
                    start: Date().addingTimeInterval(1_800),
                    end: Date().addingTimeInterval(5_400),
                    calendarName: "",
                    isVideo: true,
                    launchURL: nil,
                    calendarID: nil,
                    isAllDay: false,
                    isDemoted: false
                )],
                preferences: .defaults
            )).glance
        )
    }

    func getSnapshot(in context: Context, completion: @escaping (NextMeetingEntry) -> Void) {
        completion(Self.entry(at: Date(), from: AgendaFile.read()))
    }

    /// One entry per step of the rounded number, the phone widget's steps,
    /// so the face is right without the app running.
    func getTimeline(in context: Context, completion: @escaping (Timeline<NextMeetingEntry>) -> Void) {
        let agenda = AgendaFile.read()
        let dates = AgendaFile.entryDates(from: Date(), agenda: agenda)
        completion(Timeline(entries: dates.map { Self.entry(at: $0, from: agenda) }, policy: .atEnd))
    }

    static func entry(at date: Date, from agenda: WatchBridgeSnapshot.Agenda) -> NextMeetingEntry {
        let plan = MeetingFocus.classify(agenda.meetings, now: date, preferences: agenda.preferences)
        return NextMeetingEntry(date: date, glance: plan.focus.map { StarlingsGlance(meeting: $0, plan: plan) })
    }
}

struct NextMeetingComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "\(ContractConstants.nativeAppBundleID).watch.next", provider: NextMeetingProvider()) { entry in
            NextMeetingView(entry: entry)
                .containerBackground(.background, for: .widget)
        }
        .configurationDisplayName("Next meeting")
        .description("What is next in Starlings.")
        .supportedFamilies([.accessoryRectangular, .accessoryCircular, .accessoryInline, .accessoryCorner])
    }
}

private struct NextMeetingView: View {
    @Environment(\.widgetFamily) private var family
    let entry: NextMeetingEntry

    var body: some View {
        switch family {
        case .accessoryRectangular:
            rectangular
        case .accessoryInline:
            inline
        default:
            circular
        }
    }

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            if let glance = entry.glance {
                Text(glance.title)
                    .font(.headline)
                    .lineLimit(1)
                    .widgetAccentable()
                if let countdown = glance.countdownText(at: entry.date) {
                    Text(countdown)
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else {
                    Text("All day")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("Starlings")
                    .font(.headline)
                    .widgetAccentable()
                Text("Nothing scheduled")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var inline: some View {
        Group {
            if let glance = entry.glance {
                Text("\(StarlingsDateFormatting.time(glance.start)) \(glance.title)")
            } else {
                Text("No meetings")
            }
        }
    }

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            if let glance = entry.glance, glance.isImminent(at: entry.date),
               let countdown = glance.countdownText(at: entry.date) {
                Text(countdown)
                    .font(.headline.monospacedDigit())
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                    .widgetAccentable()
            } else {
                // The glyph opens Meet on Watch Home; the countdown is the meeting.
                StarlingsGlyph()
                    .fill(.primary)
                    .frame(width: 20, height: 20)
                    .widgetAccentable()
            }
        }
    }
}

struct TodayWorkEntry: TimelineEntry {
    let date: Date
    let rows: [WatchBridgeSnapshot.WorkRow]
}

/// The phone plans today's rows (`WorkItems.focus`) and sends them in the
/// snapshot; the watch app writes them to the agenda file and reloads. The
/// timeline only has to cross midnight, as the phone's widget does.
struct TodayWorkProvider: TimelineProvider {
    func placeholder(in context: Context) -> TodayWorkEntry {
        TodayWorkEntry(date: Date(), rows: [
            WatchBridgeSnapshot.WorkRow(id: "a", title: String(localized: "Send the proposal"), subjectTitle: "Acme rollout", subjectKind: nil, subjectID: nil, due: Date(), overdue: false),
            WatchBridgeSnapshot.WorkRow(id: "b", title: String(localized: "Review the deck"), subjectTitle: "Globex", subjectKind: nil, subjectID: nil, due: Date().addingTimeInterval(-86_400), overdue: true),
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

struct TodayWorkComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "\(ContractConstants.nativeAppBundleID).watch.work", provider: TodayWorkProvider()) { entry in
            TodayWorkView(entry: entry)
                .containerBackground(.background, for: .widget)
                .widgetURL(WatchBridgeSnapshot.watchWorkURL)
        }
        .configurationDisplayName("Today’s work")
        .description("What is overdue and due today.")
        .supportedFamilies([.accessoryRectangular, .accessoryCircular, .accessoryInline, .accessoryCorner])
    }
}

private struct TodayWorkView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TodayWorkEntry

    private var summary: String { WatchBridgeSnapshot.WorkRow.summary(entry.rows) }

    var body: some View {
        switch family {
        case .accessoryRectangular:
            rectangular
        case .accessoryInline:
            Text(entry.rows.isEmpty ? String(localized: "Nothing due today") : summary)
        default:
            circular
        }
    }

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                StarlingsGlyph()
                    .fill(.primary)
                    .frame(width: 12, height: 12)
                Text("Today")
                    .font(.headline)
            }
            .widgetAccentable()
            if let first = entry.rows.first {
                Text(first.title)
                    .font(.footnote)
                    .lineLimit(1)
                Text(summary)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            } else {
                Text("Nothing due today")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 1) {
                StarlingsGlyph()
                    .fill(.primary)
                    .frame(width: 11, height: 11)
                Text("\(entry.rows.count)")
                    .font(.headline.monospacedDigit())
            }
            .widgetAccentable()
        }
    }
}

