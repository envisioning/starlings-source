import Foundation

/// The contact fields the editor adds beyond name, title, organization and
/// addresses: the birthday, the characteristics, the preferred
/// language and the Signals outreach status. One draft for the Mac and the
/// iPhone; it sends only what changed, as `formBody` does on the web.
struct ContactProfileDraft: Equatable, Sendable {
    var birthdayMonth: Int?
    var birthdayDay: Int?
    var birthdayYear: Int?
    /// Every name the contact carries, true or false; the editor toggles them.
    var characteristics: [String: Bool] = [:]
    var preferredLanguage = "en"
    var signalsOutreachStatus: String?

    init() {}

    init(contact: CrmContactDetail) {
        birthdayMonth = contact.birthdayMonth
        birthdayDay = contact.birthdayDay
        birthdayYear = contact.birthdayYear
        characteristics = contact.characteristics ?? [:]
        preferredLanguage = ContactListFilter.trimmed(contact.preferredLanguage) ?? "en"
        signalsOutreachStatus = ContactListFilter.trimmed(contact.signalsOutreachStatus)
    }

    /// The characteristic names the editor offers: the vocabulary and any other the contact carries, sorted.
    static func characteristicNames(options: [String], contact: [String: Bool]) -> [String] {
        Array(Set(options).union(contact.keys)).sorted()
    }

    /// A birthday needs a month and a day; the year is optional. Nil when it is valid.
    var birthdayProblem: String? {
        switch (birthdayMonth, birthdayDay) {
        case (nil, nil):
            return birthdayYear == nil ? nil : String(localized: "Choose a month and a day for the birthday.")
        case let (month?, day?):
            guard (1...12).contains(month), (1...31).contains(day) else { return String(localized: "That birthday is not a date.") }
            if let year = birthdayYear, !(1900...2100).contains(year) { return String(localized: "Use a year from 1900 to 2100.") }
            return nil
        default:
            return String(localized: "Choose a month and a day for the birthday.")
        }
    }

    /// The fields that differ from `original` (nil for a new contact: every field set), written into `update`.
    func apply(to update: inout CrmContactUpdate, from original: ContactProfileDraft?) {
        let base = original ?? ContactProfileDraft()
        if birthdayMonth != base.birthdayMonth { update.birthdayMonth = Patch(birthdayMonth) }
        if birthdayDay != base.birthdayDay { update.birthdayDay = Patch(birthdayDay) }
        if birthdayYear != base.birthdayYear { update.birthdayYear = Patch(birthdayYear) }
        if characteristics != base.characteristics { update.characteristics = characteristics.isEmpty ? .null : .value(characteristics) }
        if preferredLanguage != base.preferredLanguage { update.preferredLanguage = preferredLanguage }
        if signalsOutreachStatus != base.signalsOutreachStatus { update.signalsOutreachStatus = Patch(signalsOutreachStatus) }
    }

    /// The fields a new contact sets: only those the person filled in.
    func apply(to create: inout CrmContactCreate) {
        if let birthdayMonth { create.birthdayMonth = .value(birthdayMonth) }
        if let birthdayDay { create.birthdayDay = .value(birthdayDay) }
        if let birthdayYear { create.birthdayYear = .value(birthdayYear) }
        if !characteristics.isEmpty { create.characteristics = .value(characteristics) }
        if preferredLanguage != "en" { create.preferredLanguage = preferredLanguage }
        if let signalsOutreachStatus { create.signalsOutreachStatus = .value(signalsOutreachStatus) }
    }
}
