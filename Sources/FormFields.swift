import Foundation

/// One field of a Work create or edit form, decided once in
/// `packages/contracts/src/form-fields.ts`: its wire key, its caption, whether
/// the form requires it, and what a blank sends. The table is generated
/// (`Generated/FormFieldsRegistry.swift`, `pnpm registries:gen`) and
/// `fixtures/form-fields.json` pins it (`FormFieldsFixtureTests`). The Worker's
/// suite holds the same table to the zod schemas, so a field's required state
/// and wire shape cannot drift from the contract again: the Mac and the phone
/// once sent `organization_id: ""` for a project with no organization, which
/// zod refuses as an invalid UUID.
struct FormFieldSpec: Equatable, Sendable {
    let id: String
    let wire: String
    /// The caption, localized.
    let label: String
    let required: FormFieldRequired
    let format: FormFieldFormat
    let create: FormFieldBlank
    let update: FormFieldBlank
    /// The schema's cap on a text field.
    let maxLength: Int?

    var isRequired: Bool { required != .optional }

    /// The caption as every client draws it: the label, and the mark when required.
    var caption: String { isRequired ? label + FormFieldRegistry.requiredMark : label }

    /// A text value as the wire takes it: trimmed, a URL given its scheme, and
    /// a blank sent as the table says. Never `""`.
    func patch(_ value: String?, _ write: FormWrite) -> Patch<String> {
        guard let clean = clean(value) else {
            return blank(write) == .null ? .null : .omit
        }
        return .value(clean)
    }

    /// For a key the generated body types as `String?` (not nullable): a blank
    /// is left out.
    func optional(_ value: String?) -> String? { clean(value) }

    /// A list: an empty one is left out or sent as `[]`, as the table says.
    func list(_ values: [String], _ write: FormWrite) -> [String]? {
        if !values.isEmpty { return values }
        return blank(write) == .send ? [] : nil
    }

    func isBlank(_ value: String?) -> Bool { clean(value) == nil }

    func isTooLong(_ value: String?) -> Bool {
        guard let maxLength, let value = clean(value) else { return false }
        return value.count > maxLength
    }

    private func blank(_ write: FormWrite) -> FormFieldBlank {
        switch write {
        case .create: create
        case .update: update
        }
    }

    private func clean(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return format == .url ? FormFieldRegistry.normalizedURL(trimmed) : trimmed
    }
}

enum FormWrite: Sendable {
    case create
    case update
}

enum FormFieldRegistry {
    // `requiredMark` and the four forms are the table: Sources/Generated/FormFieldsRegistry.swift.

    /// `example.com` as `https://example.com`: zod's `.url()` refuses a bare host.
    static func normalizedURL(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        if trimmed.range(of: "^[A-Za-z][A-Za-z0-9+.-]*:", options: .regularExpression) != nil { return trimmed }
        return "https://" + trimmed
    }

    /// Addresses one per line, or split by a comma or semicolon, lower case, blanks dropped.
    static func emails(_ text: String) -> [String] {
        text.components(separatedBy: CharacterSet(charactersIn: "\n,;"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty }
    }

    /// What stops a save, as a sentence: the first required field left blank,
    /// or the first text over its cap. `lacking` holds the ids the stored
    /// record already has blank; an edit does not ask for those.
    static func problem(_ values: [(FormFieldSpec, String?)], lacking: Set<String> = []) -> String? {
        for (spec, value) in values where spec.isRequired && !lacking.contains(spec.id) && spec.isBlank(value) {
            return String(localized: "\(spec.label) is required.")
        }
        for (spec, value) in values where spec.isTooLong(value) {
            return String(localized: "\(spec.label) is at most \(spec.maxLength ?? 0) characters.")
        }
        return nil
    }
}

/// The fields both subject forms draw, from the lead's table or the
/// project's. `text` is a lead's notes and a project's description.
struct SubjectFormFields {
    let title: FormFieldSpec
    let status: FormFieldSpec
    let organization: FormFieldSpec
    let contact: FormFieldSpec
    let startDate: FormFieldSpec
    let text: FormFieldSpec

    init(_ kind: MeetingCategoryKind.SubjectKind) {
        switch kind {
        case .lead:
            let lead = FormFieldRegistry.lead
            self.init(title: lead.title, status: lead.status, organization: lead.organization, contact: lead.contact, startDate: lead.startDate, text: lead.notes)
        case .project, .organization, .event:
            let project = FormFieldRegistry.project
            self.init(title: project.title, status: project.status, organization: project.organization, contact: project.contacts, startDate: project.startDate, text: project.description)
        }
    }

    private init(title: FormFieldSpec, status: FormFieldSpec, organization: FormFieldSpec, contact: FormFieldSpec, startDate: FormFieldSpec, text: FormFieldSpec) {
        self.title = title
        self.status = status
        self.organization = organization
        self.contact = contact
        self.startDate = startDate
        self.text = text
    }
}
