import Foundation

/// The phone's view of `MeetingFocus`.
///
/// The rules themselves are shared with the Mac in `Sources/MeetingFocus.swift`
/// and pinned to `fixtures/upcoming-tiers.json`; what lives here is the mapping
/// from this app's decoded event onto them, plus the two lists that are about
/// joining rather than about time — meetings you can open, and meetings worth
/// interrupting for.
///
/// Before, each surface filtered the raw feed itself, and the app went blank
/// every evening. Then it stopped going blank and started doing the opposite:
/// putting tomorrow's first meeting in the countdown card at seven in the
/// evening as though it were about to start. `focus` is the answer to both.
enum MeetingFeed {
    /// How far ahead a meeting may start and still be worth showing.
    static var horizon: TimeInterval { MeetingFocus.horizon }

    /// Everything at once: the agenda, where each row sits in the day, and the
    /// one meeting — if any — being counted down to. Surfaces take the whole
    /// plan rather than three separate calls that could disagree.
    static func plan(
        _ events: [MobileCalendarEvent],
        now: Date = Date(),
        preferences: UpcomingPreferencesWire = .defaults
    ) -> UpcomingPlan<MobileCalendarEvent> {
        MeetingFocus.classify(events, now: now, preferences: preferences)
    }

    /// Everything still relevant, soonest first — the Calendar tab's list.
    static func agenda(
        _ events: [MobileCalendarEvent],
        now: Date = Date(),
        preferences: UpcomingPreferencesWire = .defaults
    ) -> [MobileCalendarEvent] {
        plan(events, now: now, preferences: preferences).agenda
    }

    /// The agenda narrowed to meetings you can actually join — anything with a
    /// video link, whether that is an Envisioning room, Google Meet, or Zoom.
    static func meetings(
        _ events: [MobileCalendarEvent],
        now: Date = Date(),
        preferences: UpcomingPreferencesWire = .defaults
    ) -> [MobileCalendarEvent] {
        agenda(events, now: now, preferences: preferences).filter { $0.isVideoMeeting && $0.startDate != nil }
    }

    /// The hero. `nil` is a closed day, and a closed day is an answer: the card
    /// says so instead of reaching into tomorrow for something to count down to.
    static func focus(
        _ events: [MobileCalendarEvent],
        now: Date = Date(),
        preferences: UpcomingPreferencesWire = .defaults
    ) -> MobileCalendarEvent? {
        plan(events, now: now, preferences: preferences).focus
    }

    /// Joinable rows that are personally relevant enough to interrupt. Not
    /// limited to today: a notification one minute before tomorrow's standup is
    /// scheduled tonight and is right to be. Only the *hero* is a claim about
    /// now, and only the hero is day-bound.
    static func alertableMeetings(
        _ events: [MobileCalendarEvent],
        now: Date = Date(),
        preferences: UpcomingPreferencesWire = .defaults
    ) -> [MobileCalendarEvent] {
        meetings(events, now: now, preferences: preferences).filter { !$0.demoted }
    }

    /// The instant at which the plan would come out different — the earliest end
    /// still ahead of us, the next start, the moment a later event slides into
    /// the horizon, or midnight, when every tier shifts by a day. Callers arm a
    /// single timer for this rather than polling.
    static func nextBoundary(
        _ events: [MobileCalendarEvent],
        now: Date = Date(),
        calendar: Calendar = .current,
        preferences: UpcomingPreferencesWire = .defaults
    ) -> Date? {
        var boundaries: [Date] = []
        // Tiers are civil-day based, so the answer changes at midnight even when
        // no event does anything.
        if let midnight = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) {
            boundaries.append(midnight)
        }
        for event in events {
            if let end = event.endDate, end > now { boundaries.append(end) }
            if let start = event.startDate {
                if start > now { boundaries.append(start) }
                let entersHorizon = start.addingTimeInterval(-preferences.horizon)
                if entersHorizon > now { boundaries.append(entersHorizon) }
            }
        }
        return boundaries.min()
    }
}
