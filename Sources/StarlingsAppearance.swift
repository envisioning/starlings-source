import EnvisioningUI
import Foundation

/// Meet's appearance preference is the shared one — Core has the same three
/// modes, and two definitions of "auto" would eventually disagree.
///
/// The alias keeps every existing call site reading naturally, and the storage
/// key stays Meet's own so the saved preference survives and Core's is separate.
typealias StarlingsAppearanceMode = EnvisioningAppearanceMode

enum StarlingsAppearanceSettings {
    static let key = "meet.appearance.mode"

    /// Meet is a dark product that also has a light mode, not a system-following
    /// one. A new install opens dark on every surface; `Auto` and `Light` are
    /// there for the people who go and ask for them.
    ///
    /// Every surface reads its unset default from here — the Mac through
    /// `mode(defaults:)`, the phone through the `@AppStorage` seeds — so the
    /// three cannot drift apart.
    static let defaultMode: StarlingsAppearanceMode = .dark

    static func mode(defaults: UserDefaults = .standard) -> StarlingsAppearanceMode {
        guard let raw = defaults.string(forKey: key),
              let mode = StarlingsAppearanceMode(rawValue: raw) else {
            return defaultMode
        }
        return mode
    }

    static func setMode(_ mode: StarlingsAppearanceMode, defaults: UserDefaults = .standard) {
        defaults.set(mode.rawValue, forKey: key)
        NotificationCenter.default.post(
            name: .meetAppearanceDidChange,
            object: mode
        )
    }
}

extension Notification.Name {
    static let meetAppearanceDidChange = Notification.Name("StarlingsAppearance.didChange")
}
