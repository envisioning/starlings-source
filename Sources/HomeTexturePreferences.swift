import Foundation

/// Whether Meet draws the brand grid behind its decorative surfaces.
///
/// The grid is texture, not information: nothing on the launch surface depends
/// on it being there, so somebody who wants a plain canvas is not asking for a
/// degraded app. That makes it a preference rather than a constant.
///
/// Shared between the Mac and iOS clients, because the background treatment has
/// to look like one product on both, and two definitions of "show the texture"
/// would eventually disagree the way two definitions of "auto" would.
enum HomeTexturePreferences {
    /// Also the `@AppStorage` key on the phone. Never change it — this is
    /// where the saved answer lives.
    static let key = "meet.home.showsTexture"

    static let didChangeNotification = Notification.Name("MeetHomeTextureDidChange")

    /// On. The grid is the decorative surface ground; somebody who does not
    /// want it goes and says so, the same way `StarlingsAppearanceSettings` ships
    /// dark and waits to be asked for anything else.
    static let defaultValue = true

    static func showsTexture(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: key) as? Bool ?? defaultValue
    }

    static func setShowsTexture(_ value: Bool, _ defaults: UserDefaults = .standard) {
        defaults.set(value, forKey: key)
        NotificationCenter.default.post(name: didChangeNotification, object: nil)
    }
}
