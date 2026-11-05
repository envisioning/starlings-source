import Foundation
import StarlingsContracts

extension UpcomingPreferencesWire {
    static var defaults: Self {
        Self(
            horizonDays: UpcomingConfiguration.current.horizonDays,
            homeFollowingRows: UpcomingConfiguration.current.homeFollowingRows,
            showTomorrow: UpcomingConfiguration.current.showTomorrow
        )
    }

    var horizon: TimeInterval {
        TimeInterval(UpcomingConfiguration.current.horizonDays) * 24 * 60 * 60
    }

    var requestHours: Int {
        (UpcomingConfiguration.current.horizonDays + UpcomingConfiguration.current.requestSlackDays) * 24
    }

    /// Old saved values cannot restore the multi-day Home range.
    var normalizedForHome: Self {
        Self(
            horizonDays: UpcomingConfiguration.current.horizonDays,
            homeFollowingRows: min(max(homeFollowingRows, 0), 5),
            showTomorrow: true
        )
    }
}

/// The product-level knobs for the shared Upcoming feed.
///
/// The JSON beside the TypeScript contracts is the source of truth. It is
/// bundled into both native apps so changing the horizon, fetch slack, Home
/// density, or tomorrow policy cannot silently make Mac and iOS disagree with
/// the web.
struct UpcomingConfiguration: Codable, Equatable, Sendable {
    let version: Int
    let sectionTitle: String
    let horizonDays: Int
    let requestSlackDays: Int
    let homeFollowingRows: Int
    /// How long before the start the hero grows its button.
    let joinWindowMinutes: Int
    let showTomorrow: Bool
    let maxAgendaEvents: Int
    let placeholderTitles: [String]

    static let current: UpcomingConfiguration = load()

    var horizon: TimeInterval {
        TimeInterval(horizonDays) * 24 * 60 * 60
    }

    var requestHours: Int {
        (horizonDays + requestSlackDays) * 24
    }

    private static let fallback = UpcomingConfiguration(
        version: 1,
        sectionTitle: "UPCOMING",
        horizonDays: 2,
        requestSlackDays: 1,
        homeFollowingRows: 2,
        joinWindowMinutes: 10,
        showTomorrow: true,
        maxAgendaEvents: 40,
        placeholderTitles: ["", "block", "blank", "(no title)"]
    )

    private static func load() -> UpcomingConfiguration {
        let bundles = [Bundle.main, Bundle(for: UpcomingConfigurationResourceAnchor.self)]
        for bundle in bundles {
            guard let url = bundle.url(forResource: "upcoming-config", withExtension: "json"),
                  let data = try? Data(contentsOf: url),
                  let configuration = try? JSONDecoder().decode(UpcomingConfiguration.self, from: data),
                  configuration.isValid
            else { continue }
            return configuration
        }
        return fallback
    }

    private var isValid: Bool {
        version > 0
            && !sectionTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && horizonDays > 0
            && requestSlackDays >= 0
            && homeFollowingRows >= 0
            && joinWindowMinutes >= 0
            && maxAgendaEvents > 0
            && !placeholderTitles.isEmpty
    }
}

private final class UpcomingConfigurationResourceAnchor: NSObject {}
