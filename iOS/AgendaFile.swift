import Foundation
import StarlingsContracts

/// The agenda on disk in the shared group, for the widgets. On the phone the
/// app writes it and the Home Screen widget and the controls read it; on the
/// watch the watch app writes what the phone sent and the complication reads
/// it. Meetings only — never the token.
enum AgendaFile {
    /// `now`, then the boundaries, then a tick per minute for the first hour,
    /// per five minutes to ten hours, per hour to the day after — the steps
    /// `StarlingsDateFormatting.compactDuration` moves in. Capped so WidgetKit
    /// keeps the whole timeline.
    static func entryDates(from now: Date, agenda: WatchBridgeSnapshot.Agenda, calendar: Calendar = .current) -> [Date] {
        let live = agenda.meetings.filter { $0.end > now }
        var dates: Set<Date> = [now]
        for meeting in live {
            for boundary in [meeting.start.addingTimeInterval(-StarlingsGlance.countdownLead), meeting.start, meeting.end] where boundary > now {
                dates.insert(boundary.addingTimeInterval(1))
            }
        }
        if let midnight = calendar.nextDate(after: now, matching: DateComponents(hour: 0, minute: 0, second: 0), matchingPolicy: .nextTime) {
            dates.insert(midnight.addingTimeInterval(1))
        }
        let minute: TimeInterval = 60
        var tick = now.addingTimeInterval(minute)
        while tick < now.addingTimeInterval(24 * 60 * minute) {
            dates.insert(tick)
            let ahead = tick.timeIntervalSince(now)
            tick = tick.addingTimeInterval(ahead < 60 * minute ? minute : ahead < 10 * 60 * minute ? 5 * minute : 60 * minute)
        }
        return Array(dates.sorted().prefix(240))
    }

    private static var url: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: WatchBridgeSnapshot.appGroup)?
            .appending(path: WatchBridgeSnapshot.agendaFile)
    }

    static func write(_ agenda: WatchBridgeSnapshot.Agenda) {
        guard let url, let data = try? JSONEncoder().encode(agenda) else { return }
        try? data.write(to: url, options: .atomic)
    }

    /// The meetings half, keeping whatever work rows are on disk: two stores
    /// write one file, each its own half.
    static func writeMeetings(_ meetings: [WatchBridgeSnapshot.Meeting], preferences: UpcomingPreferencesWire) {
        var agenda = WatchBridgeSnapshot.Agenda(meetings: meetings, preferences: preferences)
        agenda.work = read().work
        write(agenda)
    }

    /// The work half, keeping the meetings.
    static func writeWork(_ work: [WatchBridgeSnapshot.WorkRow]) {
        var agenda = read()
        agenda.work = work
        write(agenda)
    }

    static func read() -> WatchBridgeSnapshot.Agenda {
        guard let url, let data = try? Data(contentsOf: url) else { return .empty }
        return (try? JSONDecoder().decode(WatchBridgeSnapshot.Agenda.self, from: data)) ?? .empty
    }

    /// The meeting to show or join at `date`: Home's focus, from the one rule
    /// (`MeetingFocus`). A demoted row, a placeholder or an all-day
    /// block is not "next" here any more than it is on Home.
    static func next(at date: Date = Date(), in agenda: WatchBridgeSnapshot.Agenda) -> WatchBridgeSnapshot.Meeting? {
        MeetingFocus.classify(agenda.meetings, now: date, preferences: agenda.preferences).focus
    }
}
