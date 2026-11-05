import Foundation

/// The Sales inbox (docs/WORK.md "Channels on the work itself";
///, native parity #67): CRM-originated touches with no
/// Meet subject yet — contact form, support case, pricing request, Future
/// Readiness Assessment. Read through the Worker's `/api/crm/sales-inbox`,
/// which reads Core's `/api/agent/untriaged-touches`. Read-only plus
/// dismiss/undo; "Start a lead" opens the ordinary New Lead editor
/// pre-filled from `prefill`. Same projection the web draws.
struct UntriagedTouch: Decodable, Identifiable, Hashable, Sendable {
    enum Source: String, Sendable {
        case contact
        case supportCase = "support_case"
        case pricingRequest = "pricing_request"
        case readinessAssessment = "readiness_assessment"
        // `label` is generated from `UNTRIAGED_TOUCH_SOURCE_LABELS` (Generated/SalesValuesRegistry.swift).
    }

    struct Contact: Decodable, Hashable, Sendable {
        let id: String?
        let name: String
        let email: String?
    }

    struct Organization: Decodable, Hashable, Sendable {
        let id: String?
        let name: String
    }

    /// What "Start a lead" hands the New Lead editor. The ids ride onto the
    /// created lead; the names are folded into its notes so a person reading
    /// the sheet sees who this is.
    struct Prefill: Decodable, Hashable, Sendable {
        let title: String
        let notes: String
        let organizationID: String?
        let organizationName: String?
        let contactID: String?
        let contactName: String?
        let contactEmail: String?

        enum CodingKeys: String, CodingKey {
            case title, notes
            case organizationID = "organization_id"
            case organizationName = "organization_name"
            case contactID = "contact_id"
            case contactName = "contact_name"
            case contactEmail = "contact_email"
        }
    }

    let id: String
    let source: Source
    let occurredAt: Date?
    let organization: Organization?
    let contact: Contact
    let preview: String
    let dismissed: Bool
    let prefill: Prefill
    /// Set when this touch already produced a real lead/offer under the hood.
    /// A hint on the row, never a filter —'s open note.
    let existingLeadID: String?
    let existingOfferID: String?

    init(wire: UntriagedTouchWire) {
        id = wire.id
        // A source this build has not heard of reads as a contact-form touch
        // rather than failing the inbox — the row still names and dates it.
        source = Source(rawValue: wire.source.rawValue) ?? .contact
        occurredAt = ISODate.parse(wire.occurredAt)
        organization = wire.organization.map { Organization(id: $0.id, name: $0.name) }
        contact = Contact(id: wire.contact.id, name: wire.contact.name, email: wire.contact.email)
        preview = wire.preview
        dismissed = wire.dismissed
        prefill = Prefill(
            title: wire.prefill.title, notes: wire.prefill.notes,
            organizationID: wire.prefill.organizationID, organizationName: wire.prefill.organizationName,
            contactID: wire.prefill.contactID, contactName: wire.prefill.contactName, contactEmail: wire.prefill.contactEmail
        )
        existingLeadID = wire.existingLeadID
        existingOfferID = wire.existingOfferID
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try UntriagedTouchWire(from: decoder))
    }

    var displayTitle: String {
        let cleaned = preview.trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? source.label : cleaned
    }

    /// Source, who, and when — the row's one-line meta, same as the web's.
    var metadataLabel: String {
        var parts = [source.label]
        parts.append(organization.map { "\(contact.name) · \($0.name)" } ?? contact.name)
        if let occurredAt { parts.append(occurredAt.meetDateTimeString(dateStyle: .abbreviated)) }
        return parts.joined(separator: " · ")
    }

    var hasExistingSubject: Bool { existingLeadID != nil || existingOfferID != nil }

    /// The notes the New Lead editor opens with: what Core proposed, then the
    /// organization and contact by name so the sheet reads as a person.
    var draftNotes: String {
        var lines = [prefill.notes]
        if let organizationName = prefill.organizationName, !organizationName.isEmpty {
            lines.append("Organization: \(organizationName)")
        }
        let contactBits = [prefill.contactName, prefill.contactEmail].compactMap { $0 }.filter { !$0.isEmpty }
        if !contactBits.isEmpty { lines.append("Contact: \(contactBits.joined(separator: " · "))") }
        return lines.filter { !$0.isEmpty }.joined(separator: "\n")
    }
}

struct SalesInboxResponse: Decodable, Sendable {
    let touches: [UntriagedTouch]
    let total: Int

    init(from decoder: Decoder) throws {
        let wire = try UntriagedTouchesResponse(from: decoder)
        // A touch that already produced a lead is not untriaged — the lead is
        // in Sales. Decided 2026-09-13; the feed still returns them.
        touches = wire.data.map(UntriagedTouch.init(wire:)).filter { !$0.hasExistingSubject }
        total = touches.count
    }
}
