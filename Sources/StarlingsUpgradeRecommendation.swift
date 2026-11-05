import Combine
import Foundation

/// Holds the Worker's advisory update response for the Mac and iPhone banners,
/// and the routes that told this build it is too old (`client_update_required`,
///). An error that says so offers Update, never Retry.
@MainActor
final class StarlingsUpgradeRecommendation: ObservableObject {
    static let shared = StarlingsUpgradeRecommendation()
    static let didChangeNotification = Notification.Name("MeetUpgradeRecommendationDidChange")
    /// Posted when a person presses Update on an error; the app opens its update.
    static let updateRequestedNotification = Notification.Name("StarlingsUpdateRequested")
    nonisolated static let dismissalInterval: TimeInterval = 24 * 60 * 60

    private static let recommendedKey = "recommendedMeetUpgrade"
    private static let updateURLKey = "recommendedMeetUpgradeURL"
    private static let dismissedUntilKey = "recommendedMeetUpgradeDismissedUntil"

    /// Drives the Mac's update banner only. The iPhone draws no banner: TestFlight
    /// and the App Store announce updates, and an error from a route that refuses
    /// the build offers Update (`requires(_:)`).
    @Published private(set) var isVisible = false
    @Published private(set) var updateURL: URL?
    /// What the Worker said with `client_update_required`, this launch. Kept in
    /// memory only: the installed version changes only by a relaunch.
    @Published private(set) var requiredMessages: Set<String> = []

    private let defaults: UserDefaults
    private var dismissalTask: Task<Void, Never>?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        updateURL = Self.validUpdateURL(defaults.string(forKey: Self.updateURLKey))
        refreshVisibility()
    }

    /// A native response without the recommendation means its version is
    /// supported now, or the server has disabled the floor.
    func receive(recommended: Bool, updateURL rawURL: String?) {
        defaults.set(recommended, forKey: Self.recommendedKey)
        if recommended, let rawURL, Self.validUpdateURL(rawURL) != nil {
            defaults.set(rawURL, forKey: Self.updateURLKey)
            updateURL = Self.validUpdateURL(rawURL)
        } else {
            defaults.removeObject(forKey: Self.updateURLKey)
            updateURL = nil
        }
        refreshVisibility()
        NotificationCenter.default.post(name: Self.didChangeNotification, object: self)
    }

    /// The workspace descriptor's `min_client` for this build.
    /// Below the floor shows the banner and keeps any update link a response
    /// named. At or above it, the banner clears: the Worker's response header
    /// reads the same floor, so the two never disagree.
    func receiveFloor(below: Bool) {
        guard below != defaults.bool(forKey: Self.recommendedKey) else { return }
        receive(recommended: below, updateURL: below ? defaults.string(forKey: Self.updateURLKey) : nil)
    }

    /// A route refused this build as too old. The banner shows, and the error
    /// that carries `message` offers Update.
    func receiveRequired(message: String?) {
        let text = message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let (inserted, _) = requiredMessages.insert(text.isEmpty ? Self.requiredTitle : text)
        guard inserted else { return }
        refreshVisibility()
        NotificationCenter.default.post(name: Self.didChangeNotification, object: self)
    }

    /// The title `StarlingsError` gives a `client_update_required` refusal.
    nonisolated static var requiredTitle: String { String(localized: "Update Starlings") }

    /// True when `text` is an error a route sent because this build is too
    /// old: the error views put Update where Retry would be.
    func requires(_ text: String) -> Bool {
        guard !requiredMessages.isEmpty else { return false }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return requiredMessages.contains(trimmed) || trimmed == Self.requiredTitle
    }

    /// Update pressed on an error. The Mac runs its update; the iPhone opens
    /// the update link, or TestFlight.
    func requestUpdate() {
        NotificationCenter.default.post(name: Self.updateRequestedNotification, object: self)
    }

    /// This build's marketing version.
    nonisolated static var installedVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }

    /// True when `installed` is older than `floor`. No floor, or a version
    /// that does not parse, sets no floor.
    nonisolated static func isBelow(floor: String?, installed: String = installedVersion) -> Bool {
        guard let floor else { return false }
        return StarlingsVersionOrder.isNewer(floor, than: installed) ?? false
    }

    func dismiss() {
        let until = Date().addingTimeInterval(Self.dismissalInterval)
        defaults.set(until, forKey: Self.dismissedUntilKey)
        refreshVisibility()
        NotificationCenter.default.post(name: Self.didChangeNotification, object: self)
        dismissalTask?.cancel()
        dismissalTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.dismissalInterval))
            guard !Task.isCancelled else { return }
            self?.refreshVisibility()
        }
    }

    nonisolated static func shouldShow(recommended: Bool, dismissedUntil: Date?, now: Date = .now) -> Bool {
        guard recommended else { return false }
        guard let dismissedUntil else { return true }
        return dismissedUntil <= now
    }

    private func refreshVisibility() {
        let dismissedUntil = defaults.object(forKey: Self.dismissedUntilKey) as? Date
        isVisible = Self.shouldShow(
            recommended: defaults.bool(forKey: Self.recommendedKey) || !requiredMessages.isEmpty,
            dismissedUntil: dismissedUntil
        )
        if let dismissedUntil, dismissedUntil <= .now {
            defaults.removeObject(forKey: Self.dismissedUntilKey)
        }
    }

    private static func validUpdateURL(_ rawURL: String?) -> URL? {
        guard let rawURL, let url = URL(string: rawURL),
              url.scheme?.lowercased() == "https", url.host != nil,
              url.user == nil, url.password == nil
        else { return nil }
        return url
    }
}

/// Dotted-integer version order, the one compare for the updater and the
/// descriptor's client floor.
enum StarlingsVersionOrder {
    /// True when `candidate` is newer than `reference`. Nil when a side is
    /// not numeric: decline rather than guess. Missing parts read as 0.
    static func isNewer(_ candidate: String, than reference: String) -> Bool? {
        guard let left = numericComponents(candidate),
              let right = numericComponents(reference) else { return nil }
        for index in 0..<max(left.count, right.count) {
            let lhs = index < left.count ? left[index] : 0
            let rhs = index < right.count ? right[index] : 0
            if lhs != rhs { return lhs > rhs }
        }
        return false
    }

    private static func numericComponents(_ version: String) -> [Int]? {
        let parts = version.split(separator: ".", omittingEmptySubsequences: false)
        guard !parts.isEmpty else { return nil }
        var values: [Int] = []
        for part in parts {
            guard let value = Int(part), value >= 0 else { return nil }
            values.append(value)
        }
        return values
    }
}
