import Foundation

/// The Contacts group's filters, as Core's contact table has
/// them. The default lists every contact. The web's `ContactListFilter` is
/// the same; the fixture `contact-query.json` pins what both send.
struct ContactListFilter: Codable, Equatable, Sendable {
    var organizationID: String?
    /// Kept only to draw the choice.
    var organizationName: String?
    /// ISO 3166 alpha-2.
    var country: String?
    var partner = false
    var existingClient = false
    var signalsOutreachStatus: CrmContactsQuerySignalsOutreachStatus?
    var preferredLanguage: String?

    static let `default` = ContactListFilter()

    /// True when the filter lists every contact.
    var isDefault: Bool {
        organizationID == nil && Self.trimmed(country) == nil && !partner && !existingClient
            && signalsOutreachStatus == nil && Self.trimmed(preferredLanguage) == nil
    }

    static func trimmed(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static let defaultsKey = "meet.workSidebar.filter.contacts"

    /// The filter this device last chose, or the default.
    static func saved(_ defaults: UserDefaults = .standard) -> ContactListFilter {
        guard let data = defaults.data(forKey: defaultsKey),
              let filter = try? JSONDecoder().decode(ContactListFilter.self, from: data) else { return .default }
        return filter
    }

    func save(_ defaults: UserDefaults = .standard) {
        if isDefault {
            defaults.removeObject(forKey: Self.defaultsKey)
        } else if let data = try? JSONEncoder().encode(self) {
            defaults.set(data, forKey: Self.defaultsKey)
        }
    }
}

extension CrmContactsQuery {
    /// The query the Contacts group sends, in the contract's order: only a
    /// filter that is set, and always the facets. `contactListSearchParams`
    /// on the web builds the same; `fixtures/contact-query.json` pins both.
    static func list(query: String, filter: ContactListFilter) -> CrmContactsQuery {
        CrmContactsQuery(
            q: ContactListFilter.trimmed(query),
            organizationID: filter.organizationID,
            country: ContactListFilter.trimmed(filter.country)?.uppercased(),
            partner: filter.partner ? true : nil,
            existingClient: filter.existingClient ? true : nil,
            signalsOutreachStatus: filter.signalsOutreachStatus,
            preferredLanguage: ContactListFilter.trimmed(filter.preferredLanguage),
            facets: true
        )
    }
}

/// The words a contact's fields read in, one place
/// for the Mac and the iPhone. Wire values stay as the wire spells them.
enum ContactFieldText {
    /// Core's outreach states, in the words Core's contact form uses.
    static func outreach(_ status: String) -> String {
        switch status {
        case "to_notify": String(localized: "To notify")
        case "notified": String(localized: "Notified")
        case "replied": String(localized: "Replied")
        case "interested": String(localized: "Interested")
        case "not_interested": String(localized: "Not interested")
        default: status
        }
    }

    /// A country code as its name in the reader's language, else the code.
    static func country(_ code: String) -> String {
        Locale.current.localizedString(forRegionCode: code.uppercased()) ?? code
    }

    /// A language code as its name in the reader's language, else the code.
    static func language(_ code: String) -> String {
        Locale.current.localizedString(forLanguageCode: code) ?? code
    }

    /// A characteristic's stored name as a label: `board_member` reads "Board member".
    static func characteristic(_ name: String) -> String {
        let words = name.replacingOccurrences(of: "_", with: " ").trimmingCharacters(in: .whitespaces)
        guard let first = words.first else { return name }
        return first.uppercased() + words.dropFirst()
    }

    /// A birthday as the reader's locale writes a day and month, with the year when known.
    static func birthday(month: Int?, day: Int?, year: Int?) -> String? {
        guard let month, let day, (1...12).contains(month), (1...31).contains(day) else { return nil }
        var parts = DateComponents()
        parts.month = month
        parts.day = day
        parts.year = year ?? 2000
        guard let date = Calendar(identifier: .gregorian).date(from: parts) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.setLocalizedDateFormatFromTemplate(year == nil ? "dMMMM" : "dMMMMy")
        return formatter.string(from: date)
    }
}
