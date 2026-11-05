import EnvisioningUI
import SwiftUI
import WidgetKit

/// The Home Screen and Lock Screen widget: Home's UPCOMING card, read from
/// the agenda file the app writes into the shared group. It has no session
/// and makes no requests. The hero is the plan's `focus` and nothing else;
/// a closed day says so, the way Home does, and never counts down to
/// tomorrow. A tap goes where a tap on the Live Activity goes.
struct NextMeetingWidget: Widget {
    static let kind = "\(ContractConstants.nativeAppBundleID).next"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: NextMeetingProvider()) { entry in
            NextMeetingView(entry: entry)
                // A tap lands on the meeting: its link, or the meeting in the
                // app when it has none — never on Home.
                .widgetURL(entry.glance?.tapURL)
                .containerBackground(WidgetInk.panel, for: .widget)
        }
        .configurationDisplayName("Upcoming")
        .description("What is next in Starlings.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryCircular, .accessoryInline])
    }
}

struct NextMeetingEntry: TimelineEntry {
    let date: Date
    /// Home's plan at `date`: the same classification, from the same feed.
    let plan: UpcomingPlan<WatchBridgeSnapshot.Meeting>

    /// The hero, as the row draws it; nil on a closed day.
    var glance: StarlingsGlance? {
        plan.focus.map { StarlingsGlance(meeting: $0, plan: plan) }
    }
}

/// The plan is a function of the clock, so the timeline carries entries for
/// every moment the answer changes: each start and end (the hero, the tiers),
/// midnight (today becomes yesterday), and the minutes in between at the
/// pace the countdown wording moves. Nothing here needs the app running.
struct NextMeetingProvider: TimelineProvider {
    func placeholder(in context: Context) -> NextMeetingEntry {
        let now = Date()
        let meeting = WatchBridgeSnapshot.Meeting(
            id: "placeholder",
            title: String(localized: "Weekly sync"),
            start: now.addingTimeInterval(1_800),
            end: now.addingTimeInterval(5_400),
            calendarName: "",
            isVideo: true,
            launchURL: nil,
            calendarID: nil,
            isAllDay: false,
            isDemoted: false,
            attendees: ["Ana", "Bruno"]
        )
        return Self.entry(at: now, from: WatchBridgeSnapshot.Agenda(meetings: [meeting], preferences: .defaults))
    }

    func getSnapshot(in context: Context, completion: @escaping (NextMeetingEntry) -> Void) {
        completion(Self.entry(at: Date(), from: AgendaFile.read()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<NextMeetingEntry>) -> Void) {
        let now = Date()
        let agenda = AgendaFile.read()
        let dates = AgendaFile.entryDates(from: now, agenda: agenda)
        completion(Timeline(entries: dates.map { Self.entry(at: $0, from: agenda) }, policy: .atEnd))
    }

    static func entry(at date: Date, from agenda: WatchBridgeSnapshot.Agenda) -> NextMeetingEntry {
        NextMeetingEntry(date: date, plan: MeetingFocus.classify(agenda.meetings, now: date, preferences: agenda.preferences))
    }
}

private struct NextMeetingView: View {
    @Environment(\.widgetFamily) private var family
    let entry: NextMeetingEntry

    private var plan: UpcomingPlan<WatchBridgeSnapshot.Meeting> { entry.plan }
    private var glance: StarlingsGlance? { entry.glance }

    var body: some View {
        switch family {
        case .systemSmall:
            small
        case .systemMedium:
            medium
        case .accessoryRectangular:
            rectangular
        case .accessoryInline:
            inline
        default:
            circular
        }
    }

    /// A countdown belongs to today, as on Home's following rows.
    private func showsCountdown(_ meeting: WatchBridgeSnapshot.Meeting) -> Bool {
        !meeting.isAllDay && (plan.tier(of: meeting) == .now || plan.tier(of: meeting) == .today)
    }

    private func countdown(_ meeting: WatchBridgeSnapshot.Meeting) -> String {
        StarlingsDateFormatting.relativeCountdown(start: meeting.start, end: meeting.end, now: entry.date)
    }

    // MARK: Home Screen

    /// Never empty: a closed day says so and shows what is next, as Home does.
    private var closedDay: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: "video.fill")
                    .font(.caption2)
                    .foregroundStyle(WidgetInk.accent)
                    .accessibilityHidden(true)
                Text(plan.heroLabel)
                    .font(.caption2.bold())
                    .foregroundStyle(WidgetInk.secondary)
            }
            Spacer(minLength: 0)
            Text(MeetingFocus.closedDaySummary(plan))
                .font(.subheadline)
                .foregroundStyle(WidgetInk.secondary)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private var small: some View {
        Group {
            if let glance {
                StarlingsGlanceRow(glance: glance, now: entry.date, layout: .small)
            } else {
                closedDay
            }
        }
    }

    private var medium: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let glance {
                StarlingsGlanceRow(glance: glance, now: entry.date, layout: .wide)
            } else {
                closedDay
            }
            ForEach(plan.homeRows) { meeting in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(meeting.title)
                        .font(.subheadline)
                        .foregroundStyle(WidgetInk.primary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(showsCountdown(meeting) ? countdown(meeting) : StarlingsDateFormatting.dayTime(meeting.start))
                        .font(.caption)
                        .foregroundStyle(WidgetInk.secondary)
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // MARK: Lock Screen

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            if let glance {
                Text(glance.title)
                    .font(.headline)
                    .lineLimit(1)
                    .widgetAccentable()
                Text(glance.clockLine(at: entry.date))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let countdown = glance.countdownText(at: entry.date) {
                    Text(countdown)
                        .font(.footnote.monospacedDigit())
                        .lineLimit(1)
                }
            } else {
                Text("Starlings")
                    .font(.headline)
                    .widgetAccentable()
                Text(MeetingFocus.closedDaySummary(plan))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var inline: some View {
        Group {
            if let glance {
                Text("\(StarlingsDateFormatting.time(glance.start)) \(glance.title)")
            } else {
                Text("Nothing left today")
            }
        }
    }

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            if let glance {
                VStack(spacing: 0) {
                    Image(systemName: StarlingsGlyphMark.meeting(isVideo: glance.isVideo))
                        .font(.caption2)
                    Text(StarlingsDateFormatting.time(glance.start))
                        .font(.caption2.monospacedDigit())
                }
                .widgetAccentable()
            } else {
                Image(systemName: "video")
                    .font(.title3)
            }
        }
    }
}
