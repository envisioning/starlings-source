import Foundation
import StarlingsContracts

/// Edit organization on the Mac and the phone: the fields the
/// the Core host form edits most. `PATCH
/// /api/crm/subjects/organization/:id` writes Core while the subjects group
/// is there and D1 once it has moved. The other Core columns are on the
/// Fields pane. The web's editor is `OrganizationEditor` in
/// `web/src/WorkOrganization.tsx`.
struct OrganizationDraft: Equatable, Sendable {
    enum TextField: CaseIterable, Sendable {
        case url, industry, legalName, city, country, linkedinURL, domain, notes

        var label: String {
            switch self {
            case .url: String(localized: "Website")
            case .industry: String(localized: "Industry")
            case .legalName: String(localized: "Legal name")
            case .city: String(localized: "City")
            case .country: String(localized: "Country")
            case .linkedinURL: String(localized: "LinkedIn")
            case .domain: String(localized: "Domain")
            case .notes: String(localized: "Notes")
            }
        }

        var isURL: Bool { self == .url || self == .linkedinURL }
        var isLong: Bool { self == .notes }
    }

    enum Flag: CaseIterable, Sendable {
        case partner, agency, existingClient

        var label: String {
            switch self {
            case .partner: String(localized: "Partner")
            case .agency: String(localized: "Agency")
            case .existingClient: String(localized: "Existing client")
            }
        }
    }

    /// The cap the Worker puts on a name.
    static let nameLimit = 200

    var name: String
    var text: [TextField: String]
    var flags: [Flag: Bool]

    init(_ detail: CrmSubjectDetail) {
        name = detail.title
        text = [
            .url: detail.url ?? "",
            .industry: detail.industry ?? "",
            .legalName: detail.legalName ?? "",
            .city: detail.city ?? "",
            .country: detail.country ?? "",
            .linkedinURL: detail.linkedinURL ?? "",
            .domain: detail.domain ?? "",
            .notes: detail.notes ?? "",
        ]
        flags = [
            .partner: detail.isPartner == true,
            .agency: detail.isAgency == true,
            .existingClient: detail.isExistingClient == true,
        ]
    }

    var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    var canSave: Bool { !trimmedName.isEmpty && trimmedName.count <= Self.nameLimit }

    func value(_ field: TextField) -> String { text[field] ?? "" }
    func flag(_ flag: Flag) -> Bool { flags[flag] ?? false }

    /// The fields that changed since `before`: a blank text clears, a name is
    /// never blanked. Nil when nothing changed.
    func patch(from before: OrganizationDraft) -> CrmOrganizationUpdate? {
        var patch = CrmOrganizationUpdate()
        var changed = false
        if !trimmedName.isEmpty, trimmedName != before.trimmedName {
            patch.name = trimmedName
            changed = true
        }
        for field in TextField.allCases {
            let after = value(field).trimmingCharacters(in: .whitespacesAndNewlines)
            guard after != before.value(field).trimmingCharacters(in: .whitespacesAndNewlines) else { continue }
            let clean = field.isURL ? FormFieldRegistry.normalizedURL(after) : after
            let sent: Patch<String> = clean.isEmpty ? .null : .value(clean)
            switch field {
            case .url: patch.url = sent
            case .industry: patch.industry = sent
            case .legalName: patch.legalName = sent
            case .city: patch.city = sent
            case .country: patch.country = sent
            case .linkedinURL: patch.linkedinURL = sent
            case .domain: patch.domain = sent
            case .notes: patch.notes = sent
            }
            changed = true
        }
        for flag in Flag.allCases where self.flag(flag) != before.flag(flag) {
            switch flag {
            case .partner: patch.isPartner = self.flag(flag)
            case .agency: patch.isAgency = self.flag(flag)
            case .existingClient: patch.isExistingClient = self.flag(flag)
            }
            changed = true
        }
        return changed ? patch : nil
    }
}
