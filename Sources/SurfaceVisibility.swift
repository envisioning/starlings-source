import EventKit
import Foundation

/// Which member destinations a client lists: the Mac's switcher, Window menu
/// and search doors, and the phone's tab bar. The member does not
/// choose; a destination with nothing to show is not listed, and a link to it
/// still opens it. The Swift half of
/// `packages/contracts/src/surface-visibility.ts`; both answer to
/// `fixtures/surface-visibility.json` (`RuleFixtureTests`).
enum SurfaceVisibility {
    /// `calendarSources` is nil while unknown. Unknown shows Calendar, so a
    /// slow or failed status read never hides it from a member who has one.
    static func isVisible(_ surface: MemberSurface, calendarSources: Bool?, docs: Bool) -> Bool {
        switch surface {
        case .calendar: calendarSources != false
        case .docs: docs
        case .home, .work, .team: true
        }
    }

    static func visible(calendarSources: Bool?, docs: Bool) -> [MemberSurface] {
        MemberSurface.allCases.filter { isVisible($0, calendarSources: calendarSources, docs: docs) }
    }

    /// The rule with this device's answers: the workspace's Docs
    /// and `StarlingsCalendarSources`.
    static func isVisible(_ surface: MemberSurface) -> Bool {
        isVisible(surface, calendarSources: StarlingsCalendarSources.known, docs: StarlingsWorkspace.active.has(.docs))
    }
}

/// Whether the member has a calendar source, for every window and tab bar on
/// this device: `sources` from `GET /api/calendar/status`, or Apple Calendar
/// switched on with access granted, which the server cannot see. Kept in
/// defaults so the first frame lists what it will keep. Nil while unknown.
///
/// Home's calendar read writes the server half (`record(server:)`); a connect
/// or a new subscription writes `true` at once (`noteAdded()`), and a removal
/// is caught by the next read.
enum StarlingsCalendarSources {
    static let didChangeNotification = Notification.Name("MeetCalendarSourcesDidChange")

    /// UserDefaults is the whole store, so any thread may read it: Search's
    /// doors are built off the main actor.
    private static let key = "meet.calendar.hasSources"

    static var known: Bool? {
        if localCalendarsOn { return true }
        return UserDefaults.standard.object(forKey: key) as? Bool
    }

    static func record(server value: Bool?) {
        let defaults = UserDefaults.standard
        guard defaults.object(forKey: key) as? Bool != value else { return }
        if let value {
            defaults.set(value, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
        NotificationCenter.default.post(name: didChangeNotification, object: nil)
    }

    static func noteAdded() {
        record(server: true)
    }

    /// Apple Calendar counts once it is switched on and access is granted.
    /// Reading this never asks for access.
    private static var localCalendarsOn: Bool {
        CalendarSourcePreferences.includesLocalCalendars()
            && EKEventStore.authorizationStatus(for: .event) == .fullAccess
    }
}
