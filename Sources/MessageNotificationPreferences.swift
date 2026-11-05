import Foundation

/// Whether Meet announces every channel message locally, not just the ones
/// that `@mention` you.
///
/// Off by default: a project or lead channel at team volume would otherwise
/// turn every local notification into the exact firehose the mentions feature
/// exists to fix (issue #100 — "channels at volume miss the person they are
/// for"). A direct message or group conversation is addressed to you by
/// construction and always notifies, on every platform, whatever this says —
/// see `ThreadSummary.shouldNotifyLocally`. This preference only widens or
/// narrows *channels*.
///
/// Shared between the Mac and iOS clients so the setting means the same thing
/// on both; the saved answer stays per device, the same as
/// `HomeTexturePreferences`.
enum MessageNotificationPreferences {
    /// Also the `@AppStorage` key on the phone. Never change it — this is
    /// where the saved answer lives.
    static let key = "meet.notifications.allChannelMessages"

    static let defaultValue = false

    static func notifiesOnAllChannelMessages(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: key) as? Bool ?? defaultValue
    }

    static func setNotifiesOnAllChannelMessages(_ value: Bool, _ defaults: UserDefaults = .standard) {
        defaults.set(value, forKey: key)
    }
}
