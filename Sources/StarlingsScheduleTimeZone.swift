import Foundation

/// Host schedule timezone presets — city labels for the sheet toggle, IANA ids for
/// Google Calendar `timeZone` and agenda math. The cases, `cityLabel`,
/// `shortLabel` and `identifier` are `SCHEDULE_TIME_ZONES` in
/// `packages/contracts/src/calendar-values.ts` (Generated/CalendarValuesRegistry.swift).
extension StarlingsScheduleTimeZone {
    static let defaultsKey = "meet.schedule.timeZone"

    static var offered: [StarlingsScheduleTimeZone] {
        guard let ids = StarlingsWorkspace.active.workspaceDefaults?.timeZones else { return allCases }
        let chosen = allCases.filter { zone in ids.contains { $0.rawValue == zone.rawValue } }
        return chosen.isEmpty ? allCases : chosen
    }

    var timeZone: TimeZone {
        TimeZone(identifier: identifier) ?? .gmt
    }

    var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        calendar.locale = Locale(identifier: "en_US_POSIX")
        return calendar
    }

    static func loadPreferred(defaults: UserDefaults = .standard) -> StarlingsScheduleTimeZone {
        if let raw = defaults.string(forKey: defaultsKey),
           let stored = StarlingsScheduleTimeZone(rawValue: raw), offered.contains(stored) {
            return stored
        }
        let system = matchingSystem()
        return system.flatMap { offered.contains($0) ? $0 : nil } ?? (offered.contains(.amsterdam) ? .amsterdam : offered[0])
    }

    func savePreferred(defaults: UserDefaults = .standard) {
        defaults.set(rawValue, forKey: Self.defaultsKey)
    }

    /// Best preset for the Mac’s current timezone, if any.
    static func matchingSystem(system: TimeZone = .autoupdatingCurrent) -> StarlingsScheduleTimeZone? {
        let systemID = system.identifier
        if let exact = allCases.first(where: { $0.identifier == systemID }) {
            return exact
        }
        // Common aliases / city zones that should map onto a preset.
        let aliases: [String: StarlingsScheduleTimeZone] = [
            "US/Eastern": .newYork,
            "America/Toronto": .newYork,
            "America/Montreal": .newYork,
            "Brazil/East": .saoPaulo,
            "America/Argentina/Buenos_Aires": .saoPaulo,
            "Europe/Dublin": .london,
            "GB": .london,
            "Europe/Brussels": .amsterdam,
            "Europe/Berlin": .amsterdam,
            "Europe/Paris": .amsterdam,
            "Asia/Kuwait": .riyadh,
            "Asia/Qatar": .riyadh,
            "Asia/Bahrain": .riyadh,
            "Asia/Muscat": .dubai,
            "Asia/Abu_Dhabi": .dubai,
            "US/Pacific": .losAngeles,
            "America/Vancouver": .losAngeles,
            "America/Tijuana": .losAngeles,
            "Asia/Calcutta": .mumbai,
            "Asia/Colombo": .mumbai,
            "Japan": .tokyo,
            "Asia/Seoul": .tokyo,
        ]
        if let mapped = aliases[systemID] { return mapped }
        // Same current offset as a preset (rough fallback when traveling).
        let offset = system.secondsFromGMT()
        return allCases.first { $0.timeZone.secondsFromGMT() == offset }
    }
}
