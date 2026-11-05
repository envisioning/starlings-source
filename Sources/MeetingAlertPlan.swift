import Foundation

/// One meeting's warning, decided before any `UserNotifications` type exists —
/// so the rule can be unit-tested and so each request is built fresh at the
/// moment it is handed to the notification centre. The Mac and the phone
/// schedule from this one plan; `fixtures/meeting-alerts.json`
/// pins it for both test targets.
struct MeetingNotice: Equatable, Sendable {
    let eventID: String
    let title: String
    let start: Date
    let fireAt: Date
    let launchURL: URL?
}

/// What a plan needs of an event beyond what `UpcomingEvent` gives: where a
/// tap on the warning goes. Both wire rows conform in their own files.
protocol MeetingAlertEvent: UpcomingEvent {
    var alertLaunchURL: URL? { get }
}

enum MeetingAlertPlan {
    /// iOS keeps at most 64 pending local notifications per app and silently
    /// drops the rest, so stay well under it and let the nearest meetings win.
    /// The Mac has no such cap and takes the same number, so the two agree on
    /// how far ahead a warning exists.
    static let maxScheduled = 32

    /// Which meetings get a warning, and when. Pure.
    ///
    /// A demoted row never warns: "Hidden from Next" is the person saying this
    /// one is not theirs to be ready for. An all-day block has no minute to
    /// warn at. A meeting already inside the lead window would fire at once
    /// or in the past; the app is open and the card already says so.
    static func plan<Event: MeetingAlertEvent>(
        meetings: [Event],
        now: Date,
        lead: TimeInterval
    ) -> [MeetingNotice] {
        meetings
            .compactMap { event -> MeetingNotice? in
                guard !event.upcomingIsDemoted, !event.upcomingIsAllDay, let start = event.upcomingStart else { return nil }
                let fireAt = start.addingTimeInterval(-lead)
                guard fireAt > now else { return nil }
                return MeetingNotice(
                    eventID: event.upcomingID,
                    title: event.upcomingTitle,
                    start: start,
                    fireAt: fireAt,
                    launchURL: event.alertLaunchURL
                )
            }
            .sorted { $0.fireAt < $1.fireAt }
            .prefix(maxScheduled)
            .map { $0 }
    }

    /// The banner's second line, the same on both platforms.
    static func body(for notice: MeetingNotice) -> String {
        "Starting · " + StarlingsDateFormatting.time(notice.start)
    }
}

/// The device-local switches behind the warning and the Lock Screen
/// countdown. Same keys and choices on the Mac and the phone; nothing syncs
/// them, on purpose — a lead that suits a desk does not suit a pocket.
enum MeetingAlertSettings {
    enum Key {
        static let enabled = "meet.alerts.enabled"
        /// Minutes before the start the warning fires.
        static let leadMinutes = "meet.alerts.leadMinutes"
        static let countdownLeadMinutes = "meet.alerts.countdownLeadMinutes"
    }

    /// The warning's lead, in minutes. One is the habit the feature began
    /// as; longer than fifteen is what Calendar's own alerts already do.
    static let leadChoices = [1, 2, 5, 10, 15]
    static let defaultLeadMinutes = 1

    /// Options for how early the Live Activity appears. Anything much longer
    /// than a few hours turns the Lock Screen into wallpaper.
    static let countdownLeadChoices = [15, 30, 60, 120, 240]

    // The Notifications group's words, on the Mac and the phone.
    static let warningTitle = String(localized: "Meeting warning")
    static let leadTitle = String(localized: "Warn")
    static let openOnlyFooter = String(localized: "Only while Starlings is open.")

    /// A lead as a menu row says it: "5 min before", "2h before".
    static func leadLabel(minutes: Int) -> String {
        minutes < 60 ? String(localized: "\(minutes) min before") : String(localized: "\(minutes / 60)h before")
    }

    static var enabled: Bool {
        get {
            // Absent means "not configured yet"; default on, since the app is
            // useless as a meeting client if it stays quiet.
            UserDefaults.standard.object(forKey: Key.enabled) as? Bool ?? true
        }
        set { UserDefaults.standard.set(newValue, forKey: Key.enabled) }
    }

    static var leadMinutes: Int {
        get {
            let stored = UserDefaults.standard.object(forKey: Key.leadMinutes) as? Int
            return stored.flatMap { leadChoices.contains($0) ? $0 : nil } ?? defaultLeadMinutes
        }
        set { UserDefaults.standard.set(newValue, forKey: Key.leadMinutes) }
    }

    /// How long before the start the warning fires.
    static var noticeLead: TimeInterval { TimeInterval(leadMinutes * 60) }

    static var countdownLead: TimeInterval {
        let stored = UserDefaults.standard.object(forKey: Key.countdownLeadMinutes) as? Int
        return TimeInterval((stored ?? 60) * 60)
    }
}
