import Foundation

/// What a control asked the app to do. The control's intent runs in the
/// widget extension, which has no session and no navigation; it leaves the
/// verb here and opens the app, and the app performs it on becoming active.
/// One slot, replaced whole, cleared on read.
enum LaunchAction: String, Sendable {
    /// Open the next meeting's link, the way a tap on the Live Activity does.
    case joinNextMeeting
    /// Home, with the quick-note field open.
    case newQuickNote

    private static let key = "launchAction"

    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: WatchBridgeSnapshot.appGroup)
    }

    func post() {
        Self.defaults?.set(rawValue, forKey: Self.key)
    }

    /// The pending action, and no longer pending.
    static func take() -> LaunchAction? {
        guard let defaults, let raw = defaults.string(forKey: key) else { return nil }
        defaults.removeObject(forKey: key)
        return LaunchAction(rawValue: raw)
    }
}
