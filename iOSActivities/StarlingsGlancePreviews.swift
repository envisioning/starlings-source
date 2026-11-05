import ActivityKit
import SwiftUI
import WidgetKit

/// Every layout the extension draws, in one place: a change to
/// `StarlingsGlanceRow` is seen on the Lock Screen, the three Island states, the
/// Smart Stack and both Home families before it ships. Xcode's canvas only;
/// nothing here is in the archive.

private enum GlanceFixture {
    static let now = Date()

    static let ahead = MeetingActivityAttributes.ContentState(
        title: String(localized: "Acme rollout: kickoff"),
        start: now.addingTimeInterval(25 * 60),
        end: now.addingTimeInterval(85 * 60),
        calendarName: "Envisioning",
        travelTimeMinutes: nil,
        launchURL: URL(string: "https://example.com/room/preview"),
        isVideo: true,
        attendees: ["Ana", "Bruno", "Carla"]
    )

    static let inProgress = MeetingActivityAttributes.ContentState(
        title: String(localized: "Board dinner"),
        start: now.addingTimeInterval(-20 * 60),
        end: now.addingTimeInterval(70 * 60),
        calendarName: "Personal",
        travelTimeMinutes: 15,
        launchURL: nil,
        isVideo: false,
        attendees: []
    )

    static let agenda = WatchBridgeSnapshot.Agenda(
        meetings: [
            WatchBridgeSnapshot.Meeting(
                id: "primary:kickoff",
                title: String(localized: "Acme rollout: kickoff"),
                start: now.addingTimeInterval(25 * 60),
                end: now.addingTimeInterval(85 * 60),
                calendarName: "Envisioning",
                isVideo: true,
                launchURL: "https://example.com/room/preview",
                calendarID: "primary",
                isAllDay: false,
                isDemoted: false,
                attendees: ["Ana", "Bruno", "Carla"]
            ),
            WatchBridgeSnapshot.Meeting(
                id: "primary:standup",
                title: String(localized: "Standup"),
                start: now.addingTimeInterval(3 * 3_600),
                end: now.addingTimeInterval(3 * 3_600 + 900),
                calendarName: "Envisioning",
                isVideo: true,
                launchURL: nil,
                calendarID: "primary",
                isAllDay: false,
                isDemoted: false
            ),
        ],
        preferences: .defaults
    )

    static let closedDay = WatchBridgeSnapshot.Agenda(meetings: [], preferences: .defaults)

    static let work: [WatchBridgeSnapshot.WorkRow] = [
        .init(id: "t1", title: String(localized: "Send the proposal"), subjectTitle: "Acme rollout", subjectKind: "project", subjectID: "p1", due: now, overdue: false),
        .init(id: "t2", title: String(localized: "Review the deck"), subjectTitle: "Globex", subjectKind: "lead", subjectID: "l1", due: now.addingTimeInterval(-86_400), overdue: true),
        .init(id: "t3", title: String(localized: "Book the venue"), subjectTitle: nil, subjectKind: nil, subjectID: nil, due: now, overdue: false),
    ]
}

#Preview("Lock Screen", as: .content, using: MeetingActivityAttributes(eventID: "primary:kickoff")) {
    MeetingActivityWidget()
} contentStates: {
    GlanceFixture.ahead
    GlanceFixture.inProgress
}

#Preview("Island expanded", as: .dynamicIsland(.expanded), using: MeetingActivityAttributes(eventID: "primary:kickoff")) {
    MeetingActivityWidget()
} contentStates: {
    GlanceFixture.ahead
    GlanceFixture.inProgress
}

#Preview("Island compact", as: .dynamicIsland(.compact), using: MeetingActivityAttributes(eventID: "primary:kickoff")) {
    MeetingActivityWidget()
} contentStates: {
    GlanceFixture.ahead
}

#Preview("Island minimal", as: .dynamicIsland(.minimal), using: MeetingActivityAttributes(eventID: "primary:kickoff")) {
    MeetingActivityWidget()
} contentStates: {
    GlanceFixture.ahead
}

#Preview("Home small", as: .systemSmall) {
    NextMeetingWidget()
} timeline: {
    NextMeetingProvider.entry(at: GlanceFixture.now, from: GlanceFixture.agenda)
    NextMeetingProvider.entry(at: GlanceFixture.now, from: GlanceFixture.closedDay)
}

#Preview("Home medium", as: .systemMedium) {
    NextMeetingWidget()
} timeline: {
    NextMeetingProvider.entry(at: GlanceFixture.now, from: GlanceFixture.agenda)
    NextMeetingProvider.entry(at: GlanceFixture.now, from: GlanceFixture.closedDay)
}

#Preview("Lock Screen rectangular", as: .accessoryRectangular) {
    NextMeetingWidget()
} timeline: {
    NextMeetingProvider.entry(at: GlanceFixture.now, from: GlanceFixture.agenda)
}

#Preview("Today’s agenda", as: .systemMedium) {
    TodayAgendaWidget()
} timeline: {
    NextMeetingProvider.entry(at: GlanceFixture.now, from: GlanceFixture.agenda)
    NextMeetingProvider.entry(at: GlanceFixture.now, from: GlanceFixture.closedDay)
}

#Preview("Today’s work", as: .systemMedium) {
    TodayWorkWidget()
} timeline: {
    TodayWorkEntry(date: GlanceFixture.now, rows: GlanceFixture.work)
    TodayWorkEntry(date: GlanceFixture.now, rows: [])
}
