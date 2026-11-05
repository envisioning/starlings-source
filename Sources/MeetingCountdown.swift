import Foundation

/// One spelling of "how far off is this meeting", shared by the Launch surface's
/// upcoming rows and the live sidebar's NEXT row, so the host reads the same
/// words before a call and during one.
///
/// Deliberately denser than the web invite card's "in 25 minutes"
/// (`web/src/meeting-time.ts`): these labels sit in 330pt of sidebar beside a
/// running meeting clock, where a glance has to be enough.
enum MeetingCountdown {
    /// Countdown to start, or time remaining once the meeting is underway.
    /// `nil` after it has ended, or when the dates do not parse — callers hide
    /// the label rather than print a placeholder.
    static func timeLeft(startISO: String, endISO: String, now: Date = Date()) -> String? {
        let start = ISODate.parse(startISO)
        let end = ISODate.parse(endISO)
        let target: Date
        if let start, start > now {
            target = start
        } else if let end, end > now {
            target = end
        } else {
            return nil
        }
        return naturalDuration(until: target, now: now)
    }

    /// Whole minutes until the start — negative once it has started, `nil` when
    /// the start does not parse. Drives the "starting soon" tint, which must not
    /// fire for a meeting that is already running.
    static func minutesUntilStart(startISO: String, now: Date = Date()) -> Int? {
        guard let start = ISODate.parse(startISO) else { return nil }
        return Int((start.timeIntervalSince(now) / 60).rounded(.down))
    }

    /// Coarse, readable remaining time — more precision when closer.
    static func naturalDuration(until target: Date, now: Date = Date()) -> String {
        StarlingsDateFormatting.compactDuration(until: target, from: now)
    }

    /// Clock time alone. Every surface that lists calendar events lists today's,
    /// so the date would be the same word on every row.
    ///
    /// Empty when the stamp does not parse: an all-day event's start is a bare
    /// date, and printing it raw put "2026-09-07" where a time belongs.
    static func clockTime(_ iso: String) -> String {
        guard let date = ISODate.parse(iso) else { return "" }
        return StarlingsDateFormatting.time(date)
    }

    /// The span a meeting occupies — "14:00 – 14:30". A list of upcoming
    /// meetings is read for where the day's holes are, which the start alone
    /// cannot say. An all-day block has no clock to print, so it says that in
    /// words rather than falling back to its date.
    static func clockRange(startISO: String, endISO: String, isAllDay: Bool) -> String {
        if isAllDay { return "All day" }
        let start = clockTime(startISO)
        guard !start.isEmpty else { return "" }
        let end = clockTime(endISO)
        guard !end.isEmpty, end != start else { return start }
        return String(localized: "\(start) – \(end)")
    }

}
