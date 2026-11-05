import Foundation

#if canImport(ActivityKit)
import ActivityKit

/// The contract between the app and the Live Activity widget extension. Both
/// targets compile this file.
///
/// Everything the lock-screen view needs to render for the entire life of the
/// meeting lives in `ContentState`, because on-device Live Activities cannot be
/// updated while the app is suspended. The countdown itself is drawn with
/// `Text(.currentDate, format: .offset(...))` in minutes, which the system
/// ticks without waking anyone, and the
/// hand-off from "starts in" to "in progress" rides on `staleDate` — ActivityKit
/// re-renders the view when that instant passes.
struct MeetingActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var title: String
        var start: Date
        var end: Date
        var calendarName: String
        var travelTimeMinutes: Int?
        var launchURL: URL?
        /// A call gets the camera glyph; an in-person meeting gets the pin.
        var isVideo: Bool
        /// The other people, by first name. Optional so a state
        /// archived before the field decodes.
        var attendees: [String]? = nil
    }

    /// Identity, so a refresh updates the running activity instead of stacking
    /// a second pill next to it.
    var eventID: String
}
#endif
