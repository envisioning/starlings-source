import CoreGraphics
import Foundation

/// The handful of calendar behaviours worth making personal. Deliberately
/// small: everything here is something you notice every time you open the
/// window, not an exhaustive mirror of Calendar.app's preferences.
enum CalendarWindowPreferences {
    private enum Key {
        static let dayStart = "meet.calendar.dayStartHour"
        static let dayEnd = "meet.calendar.dayEndHour"
        static let defaultView = "meet.calendar.defaultView"
        static let duration = "meet.calendar.defaultDurationMinutes"
        static let snap = "meet.calendar.snapMinutes"
        static let showsDeclined = "meet.calendar.showsDeclined"
        static let showsHidden = "meet.calendar.showsHidden"
        static let hourHeight = "meet.calendar.hourHeight"
        static let secondaryZone = "meet.calendar.secondaryTimeZone"
    }

    /// How tall one hour may be drawn. Below the floor a half-hour block has
    /// no room for its own title; above the ceiling a working day no longer
    /// fits on a screen, which is the thing a week view is for.
    static let hourHeightRange: ClosedRange<CGFloat> = 24...160

    /// The height "Actual Size" goes back to, and what an untouched calendar
    /// opens at: an hour tall enough for a half-hour block to name itself.
    static let defaultHourHeight: CGFloat = 48

    static let durationChoices = [15, 30, 45, 60, 90]
    static let snapChoices = [5, 10, 15, 30]

    /// The hour the day view opens on. The grid always draws midnight to
    /// midnight and no longer shades any part of it — this decides where the
    /// window lands, and where a new event on another day starts.
    static func dayStartHour(_ defaults: UserDefaults = .standard) -> Int {
        clampHour(defaults.object(forKey: Key.dayStart) as? Int ?? 8)
    }

    static func setDayStartHour(_ value: Int, _ defaults: UserDefaults = .standard) {
        defaults.set(clampHour(value), forKey: Key.dayStart)
    }

    /// The hour the day view closes on. Kept a full hour after the start so
    /// the pair stays coherent. Read by the availability bar, which draws this
    /// window widened to hold whatever slot is being proposed.
    static func dayEndHour(_ defaults: UserDefaults = .standard) -> Int {
        let stored = clampHour(defaults.object(forKey: Key.dayEnd) as? Int ?? 20)
        return max(stored, dayStartHour(defaults) + 1)
    }

    static func setDayEndHour(_ value: Int, _ defaults: UserDefaults = .standard) {
        defaults.set(clampHour(value), forKey: Key.dayEnd)
    }

    static func defaultView(_ defaults: UserDefaults = .standard) -> CalendarViewMode {
        guard let raw = defaults.string(forKey: Key.defaultView),
              let mode = CalendarViewMode(rawValue: raw)
        else { return .week }
        return mode
    }

    static func hasStoredDefaultView(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.string(forKey: Key.defaultView) != nil
    }

    static func setDefaultView(_ mode: CalendarViewMode, _ defaults: UserDefaults = .standard) {
        defaults.set(mode.rawValue, forKey: Key.defaultView)
    }

    static func defaultDurationMinutes(_ defaults: UserDefaults = .standard) -> Int {
        let stored = defaults.object(forKey: Key.duration) as? Int ?? 60
        return durationChoices.contains(stored) ? stored : 60
    }

    static func setDefaultDurationMinutes(_ value: Int, _ defaults: UserDefaults = .standard) {
        defaults.set(value, forKey: Key.duration)
    }

    static func snapMinutes(_ defaults: UserDefaults = .standard) -> Int {
        let stored = defaults.object(forKey: Key.snap) as? Int ?? 15
        return snapChoices.contains(stored) ? stored : 15
    }

    static func setSnapMinutes(_ value: Int, _ defaults: UserDefaults = .standard) {
        defaults.set(value, forKey: Key.snap)
    }

    /// Declined events stay visible by default: knowing you said no to
    /// something at 3pm is useful information about your day.
    static func showsDeclined(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: Key.showsDeclined) as? Bool ?? true
    }

    static func setShowsDeclined(_ value: Bool, _ defaults: UserDefaults = .standard) {
        defaults.set(value, forKey: Key.showsDeclined)
    }

    /// An event the owner hid ("Hide from Next") is gone from the grid unless
    /// asked back; then it is drawn faded so it can be un-hidden.
    /// What "hide" does to Next and Upcoming is not touched by this.
    static func showsHidden(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: Key.showsHidden) as? Bool ?? false
    }

    static func setShowsHidden(_ value: Bool, _ defaults: UserDefaults = .standard) {
        defaults.set(value, forKey: Key.showsHidden)
    }

    /// Height of one hour in the day and week grids — what pinch-to-zoom
    /// leaves behind, so a day opened tomorrow is as tall as you left it.
    static func hourHeight(_ defaults: UserDefaults = .standard) -> CGFloat {
        guard let stored = defaults.object(forKey: Key.hourHeight) as? Double else { return defaultHourHeight }
        return clampHourHeight(CGFloat(stored))
    }

    static func setHourHeight(_ value: CGFloat, _ defaults: UserDefaults = .standard) {
        defaults.set(Double(clampHourHeight(value)), forKey: Key.hourHeight)
    }

    static func clampHourHeight(_ value: CGFloat) -> CGFloat {
        min(hourHeightRange.upperBound, max(hourHeightRange.lowerBound, value))
    }

    /// A second clock down the gutter, for the zone the other half of the
    /// conversation is in. `nil` is the ordinary case: one set of hours.
    static func secondaryTimeZone(_ defaults: UserDefaults = .standard) -> StarlingsScheduleTimeZone? {
        guard let raw = defaults.string(forKey: Key.secondaryZone) else { return nil }
        return StarlingsScheduleTimeZone(rawValue: raw)
    }

    static func setSecondaryTimeZone(_ zone: StarlingsScheduleTimeZone?, _ defaults: UserDefaults = .standard) {
        if let zone {
            defaults.set(zone.rawValue, forKey: Key.secondaryZone)
        } else {
            defaults.removeObject(forKey: Key.secondaryZone)
        }
    }

    private static func clampHour(_ value: Int) -> Int {
        min(23, max(0, value))
    }
}
