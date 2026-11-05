import Foundation

/// A lead's qualification checklist: the five checks Core's own New Lead form
/// has. Core keeps them in the lead's `characteristics` record, a
/// map of check key to boolean beside any other characteristic the lead
/// carries. A write replaces the whole record, so the editors send back the
/// record they read with the five keys changed (`merged`), never just the five.
///
/// The keys are the generated table (`Generated/LeadQualificationRegistry.swift`,
/// from `packages/contracts/src/lead-qualification.ts`); the words are here, so
/// they localize. A key this file has no word for shows as the key, which the
/// fixture test catches before it ships.
enum LeadQualification {
    struct Check: Identifiable, Hashable, Sendable {
        let key: String
        var id: String { key }
        var title: String { LeadQualification.title(for: key) }
    }

    static var checks: [Check] { keys.map(Check.init(key:)) }

    static var total: Int { keys.count }

    static func title(for key: String) -> String {
        switch key {
        case "budget_availability": String(localized: "Budget Availability")
        case "event_timeline": String(localized: "Event Timeline")
        case "previous_engagement": String(localized: "Previous Engagement")
        case "project_fit": String(localized: "Project Fit")
        case "stakeholder_buy_in": String(localized: "Stakeholder Buy In")
        default: key
        }
    }

    static func isSet(_ key: String, in characteristics: [String: Bool]?) -> Bool {
        characteristics?[key] == true
    }

    /// How many of the five are checked.
    static func count(_ characteristics: [String: Bool]?) -> Int {
        keys.filter { isSet($0, in: characteristics) }.count
    }

    /// "3/5 qualified", for a lead's header and inspector.
    static func summary(_ characteristics: [String: Bool]?) -> String {
        String(localized: "\(count(characteristics))/\(total) qualified")
    }

    /// `existing` with one check changed; every other characteristic stays.
    static func merged(_ existing: [String: Bool]?, key: String, value: Bool) -> [String: Bool] {
        var record = existing ?? [:]
        if keys.contains(key) { record[key] = value }
        return record
    }
}
