import Foundation

/// Envisioning-only CRM filing for a live Meet session. The cases, their
/// words and their subject kinds are generated from
/// `packages/contracts/src/meeting-kinds.ts` into
/// `Generated/MeetingKindsRegistry.swift`.
extension MeetingCategoryKind {
    enum SubjectKind: String, CaseIterable, Sendable {
        case lead
        case project
        /// A CRM organization with `is_partner = true`, read as a Work subject
        /// (PARTNERS (HQ Docs)). Read-only in this slice: no thread, no tasks,
        /// no issues — History by organization and the Core record.
        case organization
        /// A CMS `events` row, read as a Work subject (docs/EVENTS.md,
        ///). Read-only as a record, edited under Website in Core;
        /// its Talk and Tasks are its own. Its one date is its status.
        case event

        /// ADR 0006 renames `partner` to `organization` on the wire. This
        /// build reads both, so it keeps working when the Worker switches.
        init?(rawValue: String) {
            switch rawValue {
            case "lead": self = .lead
            case "project": self = .project
            case "organization", "partner": self = .organization
            case "event": self = .event
            default: return nil
            }
        }
    }

    var needsSubject: Bool { subjectKind != nil }

    /// The kinds a filing menu offers. Event filing has no native picker
    /// yet, so `event` shows only on a meeting already filed that way.
    static func filingMenu(offersPartner: Bool, current: MeetingCategoryKind) -> [MeetingCategoryKind] {
        allCases.filter { kind in
            switch kind {
            case .partner: offersPartner || current == .partner
            case .event: current == .event
            default: true
            }
        }
    }
}

/// What a kind of subject can hold, from `packages/contracts/src/subject-kinds.ts`.
/// Ask `kind.can(_:)` instead of listing kinds. The table is generated from the
/// module (`pnpm registries:gen`), and a test compares it to the generated
/// `fixtures/subject-kinds.json`, so a kind gained in the registry fails here until
/// the `SubjectKind` and `SubjectCapability` cases are declared.
enum SubjectCapability: String, CaseIterable, Sendable {
    case tasks, issues, documents, meetings, hostedMeetings, calendarEvents, slack, granola, talk
}

extension MeetingCategoryKind.SubjectKind {
    // `capabilityTable` is the registry's `with` table: Sources/Generated/SubjectKindsRegistry.swift.

    func can(_ capability: SubjectCapability) -> Bool {
        Self.kinds(with: capability).contains(self)
    }

    static func kinds(with capability: SubjectCapability) -> [Self] {
        capabilityTable[capability] ?? []
    }
}

/// How a meeting is filed, as the app reads it: the kind as the closed
/// list the menu offers. Decodes through the generated `MeetingCategoryResponse`.
struct MeetingCategory: Decodable, Equatable, Sendable {
    let meetingKind: MeetingCategoryKind
    let leadID: String?
    let projectID: String?
    /// The partner's organization id, when filed as a partner.
    let partnerOrganizationID: String?
    /// The CMS event's id, when filed as an event.
    let eventID: String?
    let subjectTitle: String?
    let categorizedBy: String?
    let categorizedAt: Int?

    /// The id of whichever subject the kind names; nil for the kinds that
    /// carry none.
    var subjectID: String? {
        switch meetingKind {
        case .lead: leadID
        case .project: projectID
        case .partner: partnerOrganizationID
        case .event: eventID
        case .uncategorized, .status, .internal, .personal: nil
        }
    }

    init(
        meetingKind: MeetingCategoryKind,
        leadID: String?,
        projectID: String?,
        partnerOrganizationID: String? = nil,
        eventID: String? = nil,
        subjectTitle: String?,
        categorizedBy: String?,
        categorizedAt: Int?
    ) {
        self.meetingKind = meetingKind
        self.leadID = leadID
        self.projectID = projectID
        self.partnerOrganizationID = partnerOrganizationID
        self.eventID = eventID
        self.subjectTitle = subjectTitle
        self.categorizedBy = categorizedBy
        self.categorizedAt = categorizedAt
    }

    init(wire: MeetingCategoryResponse) {
        self.init(
            meetingKind: MeetingCategoryKind(rawValue: wire.meetingKind.rawValue) ?? .uncategorized,
            leadID: wire.leadID,
            projectID: wire.projectID,
            partnerOrganizationID: wire.partnerOrganizationID,
            eventID: wire.eventID,
            subjectTitle: wire.subjectTitle,
            categorizedBy: wire.categorizedBy,
            categorizedAt: wire.categorizedAt
        )
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try MeetingCategoryResponse(from: decoder))
    }
}

extension MeetingCategory {
    /// A filing on one subject: the kind decides which id field holds it.
    init(meetingKind: MeetingCategoryKind, subjectID: String?, subjectTitle: String?, categorizedBy: String? = nil, categorizedAt: Int? = nil) {
        let id = meetingKind.needsSubject ? subjectID : nil
        self.init(
            meetingKind: meetingKind,
            leadID: meetingKind == .lead ? id : nil,
            projectID: meetingKind == .project ? id : nil,
            partnerOrganizationID: meetingKind == .partner ? id : nil,
            eventID: meetingKind == .event ? id : nil,
            subjectTitle: subjectTitle,
            categorizedBy: categorizedBy,
            categorizedAt: categorizedAt
        )
    }
}

/// The generated `MeetingCategoryUpdate`, built from the app's kind. The kind
/// decides which id field carries the subject.
extension MeetingCategoryUpdate {
    init(meetingKind: MeetingCategoryKind, subjectID: String?, subjectTitle: String?) {
        let id = meetingKind.needsSubject ? subjectID : nil
        self.init(
            meetingKind: MeetingKind(rawValue: meetingKind.rawValue),
            leadID: .ifSome(meetingKind == .lead ? id : nil),
            projectID: .ifSome(meetingKind == .project ? id : nil),
            eventID: .ifSome(meetingKind == .event ? id : nil),
            partnerOrganizationID: .ifSome(meetingKind == .partner ? id : nil),
            subjectTitle: .ifSome(subjectTitle)
        )
    }
}

struct CrmSubject: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let kind: String
    let title: String
    let subtitle: String?
    /// Open tasks, so a row says where things stand without being opened.
    let openTasks: Int
    /// How many of those are past their date.
    let overdueTasks: Int
    /// Whether a repository is linked. Projects only.
    let hasRepo: Bool
    /// The one agent that works this project, by the address the roster knows
    /// it by. Core owns the edge; nil is the ordinary case, and a lead never
    /// has one. The board reads it to say which agent is holding a card.
    let agentEmail: String?
    /// Who answers for this project or lead, chosen by a person (,
    /// docs/OWNERSHIP.md). Nil: nobody chose; `Responsible.of` suggests one.
    let responsibleEmail: String?
    /// The related organization's logo, from Core's enrichment pipeline — a
    /// curated company logo, not a favicon. Nil when Core has none, or on a
    /// row built somewhere other than the list (a meeting's own filing).
    /// Meet fetches and caches this itself; nothing here is proxied.
    let organizationLogoURL: String?
    /// The organization this subject hangs off ( decision 1). A
    /// lead, the project that follows it and the partner it becomes share
    /// one id, which is what SUBJECTS groups by; a partner's is its own. Nil
    /// is a real value on historic Core rows — every new lead or project now
    /// requires a real organization, while older unfiled rows stay visible.
    let organizationID: String?
    let organizationName: String?
    /// Projects only: Envisioning's own work, as Core's `is_internal` flag.
    /// Decoded from `internal`; absent reads as nil so `isInternalProject`
    /// can tell "Core said no" from "Core predates the flag".
    let isInternal: Bool?
    /// When something last moved here, ISO ( slice 3c): the later
    /// of Core's answer and the channel's last message, folded by the
    /// Worker. Nil when nothing is known; SUBJECTS orders by it and puts
    /// those rows after the rest.
    let lastActivityAt: String?
    /// Events only: the CMS `YYYY-MM-DD`, or nil on an undated draft. The
    /// phase is `WorkItems.eventPhase`, computed here against today.
    let eventDate: String?
    /// Events only: whether the website lists it. Plays no part in Work.
    let published: Bool?
    /// A project's or lead's status, Core's word. Nil reads as open
    /// (`SubjectStatusRegistry.isClosed`).
    let status: String?

    init(wire: CrmSubjectWire) {
        self.init(
            id: wire.id,
            kind: wire.kind.rawValue,
            title: wire.title,
            subtitle: wire.subtitle,
            openTasks: wire.openTasks ?? 0,
            overdueTasks: wire.overdueTasks ?? 0,
            hasRepo: wire.hasRepo ?? false,
            agentEmail: wire.agentEmail ?? nil,
            responsibleEmail: wire.responsibleEmail,
            organizationLogoURL: wire.organizationLogoURL ?? nil,
            organizationID: wire.organizationID ?? nil,
            organizationName: wire.organizationName ?? nil,
            isInternal: wire.isInternal,
            lastActivityAt: wire.lastActivityAt ?? nil,
            eventDate: wire.eventDate ?? nil,
            published: wire.published,
            status: wire.status
        )
    }

    /// Decoding stays for the app's own persistence; the wire is
    /// `CrmSubjectWire`, read through `init(wire:)`.
    init(from decoder: Decoder) throws {
        self.init(wire: try CrmSubjectWire(from: decoder))
    }

    /// For a subject named by something other than the list — a meeting's own
    /// filing, say, which knows the title but has counted nothing.
    /// The subject an event carries on the wire: kind, id and title, nothing
    /// Core lists (task counts, organization). A row built from it draws the
    /// name and files under the id; the rest reads as unknown.
    init(wire: CalendarEventSubject) {
        self.init(id: wire.id, kind: wire.kind.rawValue, title: wire.title, subtitle: nil)
    }

    init(wire: InboxSubjectRef) {
        self.init(id: wire.id, kind: wire.kind.rawValue, title: wire.title, subtitle: nil)
    }

    init(
        id: String,
        kind: String,
        title: String,
        subtitle: String?,
        openTasks: Int = 0,
        overdueTasks: Int = 0,
        hasRepo: Bool = false,
        agentEmail: String? = nil,
        responsibleEmail: String? = nil,
        organizationLogoURL: String? = nil,
        organizationID: String? = nil,
        organizationName: String? = nil,
        isInternal: Bool? = nil,
        lastActivityAt: String? = nil,
        eventDate: String? = nil,
        published: Bool? = nil,
        status: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.subtitle = subtitle
        self.openTasks = openTasks
        self.overdueTasks = overdueTasks
        self.hasRepo = hasRepo
        self.agentEmail = agentEmail
        self.responsibleEmail = responsibleEmail
        self.organizationLogoURL = organizationLogoURL
        self.organizationID = organizationID
        self.organizationName = organizationName
        self.isInternal = isInternal
        self.lastActivityAt = lastActivityAt
        self.eventDate = eventDate
        self.published = published
        self.status = status
    }

    /// One line under the title: who it is for, then what is outstanding.
    var standing: String { standing(includeRepository: true) }

    /// The project list can replace the generic GitHub marker with the exact
    /// linked address once its repository links have loaded.
    func standing(includeRepository: Bool, eventLabel: String? = nil) -> String {
        var parts: [String] = []
        // An event's date is its standing (docs/EVENTS.md).
        if isEvent {
            parts.append(eventLabel ?? WorkItems.eventPhase(eventDate: eventDate, now: Date(), calendar: .current).label)
        }
        if let subtitle, !subtitle.isEmpty { parts.append(subtitle) }
        if openTasks > 0 { parts.append(String(localized: "\(openTasks) open")) }
        // Late is the part somebody needs at a glance: three open reads the
        // same whether they are due next month or were due last week.
        if overdueTasks > 0 { parts.append(String(localized: "\(overdueTasks) overdue")) }
        if includeRepository && hasRepo { parts.append(String(localized: "GitHub")) }
        return parts.joined(separator: " · ")
    }
}

/// The editable projection of a Core subject. Meet deliberately keeps this a
/// flat wire shape: Core remains the source of truth for relations, policies,
/// and any fields not exposed by this focused editor.
/// What hangs off a partner: its projects and leads as openable subjects, and
/// its contacts as names. Core answers this beside the partner detail.
extension CrmSubjectRelated {
    typealias Row = CrmRelatedRow
    typealias Contact = CrmRelatedContact
}
extension CrmRelatedRow: Identifiable {}
extension CrmRelatedContact: Identifiable {}

extension CrmSubject {
    /// The wire kind as the enum every switch should read, so a partner can
    /// never fall into a project branch by being "not a lead".
    var subjectKind: MeetingCategoryKind.SubjectKind {
        MeetingCategoryKind.SubjectKind(rawValue: kind) ?? .project
    }

    var isPartner: Bool { kind == MeetingCategoryKind.SubjectKind.organization.rawValue }
    var isEvent: Bool { kind == MeetingCategoryKind.SubjectKind.event.rawValue }
    /// A lead not yet won or lost (ADR 0008 decision 10): the one Win takes.
    var isOpenLead: Bool { kind == MeetingCategoryKind.SubjectKind.lead.rawValue && !SubjectStatusRegistry.isClosed(kind: kind, status: status) }
}

struct CrmSubjectDetail: Decodable, Sendable {
    let id: String
    let kind: String
    let title: String
    let subtitle: String?
    let openTasks: Int
    let overdueTasks: Int
    let hasRepo: Bool
    let status: String
    let updatedAt: String?
    let description: String?
    let url: String?
    let organizationID: String?
    let organizationName: String?
    let contactID: String?
    let leadID: String?
    let licenseID: String?
    let contactIDs: [String]
    let evid: String?
    let startDate: String?
    let endDate: String?
    let notes: String?
    /// A lead's characteristics: the five qualification checks live here.
    let characteristics: [String: Bool]?
    /// Projects only: the workspace's own work (`internal` on the wire).
    let isInternal: Bool?
    /// Projects only: the spec notes the Fields pane edits.
    let specs: String?
    let technical: String?
    let research: String?
    let design: String?
    let contract: String?
    let analytics: String?
    let authentication: String?
    /// See `CrmSubject.organizationLogoURL`.
    let organizationLogoURL: String?
    /// See `CrmSubject.responsibleEmail`.
    let responsibleEmail: String?
    /// Partners only (PARTNERS (HQ Docs)): the organization's industry, and the
    /// projects, leads and contacts that hang off the relationship — so the
    /// shell can list them without one round trip per relation.
    let industry: String?
    let related: CrmSubjectRelated?
    /// Organizations only: the columns Edit organization changes.
    let legalName: String?
    let city: String?
    let country: String?
    let linkedinURL: String?
    let domain: String?
    let isPartner: Bool?
    let isAgency: Bool?
    let isExistingClient: Bool?
    /// Organizations only: what the organization is to the workspace —
    /// client, partner, prospect. Empty when the
    /// wire sends none.
    let relationships: [CrmSubjectDetailWireRelationshipsItem]
    /// The id the request named when it was merged into this record
    ///. The client holds `id` from then on.
    let mergedFrom: String?
    /// Events only (docs/EVENTS.md): where and when, from the CMS row. `host`
    /// and `partner` are free text there, not organizations.
    let eventDate: String?
    let startAt: String?
    let timezone: String?
    let location: String?
    let place: String?
    let imageURL: String?
    let host: String?
    let partner: String?
    let partnerURL: String?
    let published: Bool?

    init(wire: CrmSubjectDetailWire) {
        id = wire.id
        kind = wire.kind.rawValue
        title = wire.title
        subtitle = wire.subtitle
        openTasks = wire.openTasks ?? 0
        overdueTasks = wire.overdueTasks ?? 0
        hasRepo = wire.hasRepo ?? false
        status = wire.status
        updatedAt = wire.updatedAt
        description = wire.description ?? nil
        url = wire.url ?? nil
        organizationID = wire.organizationID ?? nil
        organizationName = wire.organizationName ?? nil
        contactID = wire.contactID ?? nil
        leadID = wire.leadID ?? nil
        licenseID = wire.licenseID ?? nil
        contactIDs = wire.contactIDs ?? []
        evid = wire.evid ?? nil
        startDate = wire.startDate ?? nil
        endDate = wire.endDate ?? nil
        notes = wire.notes ?? nil
        characteristics = wire.characteristics ?? nil
        isInternal = wire.isInternal
        specs = wire.specs ?? nil
        technical = wire.technical ?? nil
        research = wire.research ?? nil
        design = wire.design ?? nil
        contract = wire.contract ?? nil
        analytics = wire.analytics ?? nil
        authentication = wire.authentication ?? nil
        organizationLogoURL = wire.organizationLogoURL ?? nil
        responsibleEmail = wire.responsibleEmail
        industry = wire.industry ?? nil
        related = wire.related
        legalName = wire.legalName ?? nil
        city = wire.city ?? nil
        country = wire.country ?? nil
        linkedinURL = wire.linkedinURL ?? nil
        domain = wire.domain ?? nil
        isPartner = wire.isPartner
        isAgency = wire.isAgency
        isExistingClient = wire.isExistingClient
        relationships = wire.relationships ?? []
        mergedFrom = wire.mergedFrom
        eventDate = wire.eventDate ?? nil
        startAt = wire.startAt ?? nil
        timezone = wire.timezone ?? nil
        location = wire.location ?? nil
        place = wire.place ?? nil
        imageURL = wire.imageURL ?? nil
        host = wire.host ?? nil
        partner = wire.partner ?? nil
        partnerURL = wire.partnerURL ?? nil
        published = wire.published
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try CrmSubjectDetailWire(from: decoder))
    }

    /// An organization's Relationship block: the words in the contract's order,
    /// joined with " · ". Nil when the organization has none.
    var relationshipLine: String? {
        let words = CrmSubjectDetailWireRelationshipsItem.known
            .filter(relationships.contains)
            .compactMap { item -> String? in
                switch item {
                case .client: String(localized: "Client")
                case .partner: String(localized: "Partner")
                case .prospect: String(localized: "Prospect")
                default: nil
                }
            }
        return words.isEmpty ? nil : words.joined(separator: " · ")
    }

    var summary: CrmSubject {
        CrmSubject(
            id: id,
            kind: kind,
            title: title,
            subtitle: subtitle,
            openTasks: openTasks,
            overdueTasks: overdueTasks,
            hasRepo: hasRepo,
            responsibleEmail: responsibleEmail,
            organizationLogoURL: organizationLogoURL,
            organizationID: organizationID,
            organizationName: organizationName,
            eventDate: eventDate,
            published: published
        )
    }
}

/// One end of a relation a subject carries — an organization, a contact.
/// Shared rather than per-platform because the Mac's `RelationPickerView` and
/// the phone's `MobileRelationPicker` are the same two fields, searched the
/// same way, against the same Core.
struct SubjectRelationOption: Hashable, Sendable, Identifiable {
    let id: String
    let name: String
    var secondaryText: String? = nil
}

/// A contact as a relation picker and a row draw it, on Mac and iOS.
extension CrmContact {
    /// The name, else the primary address.
    var displayName: String {
        if let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty { return name }
        return email ?? String(localized: "Unnamed")
    }

    /// What they do and where: the second line of a row.
    var context: String {
        [title, organizationName].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    var relationOption: SubjectRelationOption {
        SubjectRelationOption(id: id, name: displayName, secondaryText: context.isEmpty ? email : context)
    }

    /// The most addresses one `GET /api/crm/contacts?emails=` read takes.
    static let attendeeLookupLimit = 25

    /// The addresses an event's detail asks the contacts about:
    /// every guest but you and the members, lower-cased, once each, at most
    /// `attendeeLookupLimit`. `emails` adds the addresses an event lists
    /// without a summary.
    static func attendeeLookupAddresses(_ attendees: [CalendarAttendeeSummary], emails: [String] = []) -> [String] {
        let yours = Set(attendees.filter(\.isSelf).map { $0.email.lowercased() })
        var seen = Set<String>()
        var out: [String] = []
        for raw in attendees.filter({ !$0.isSelf && !$0.isMember }).map(\.email) + emails {
            let email = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard email.contains("@"), !yours.contains(email),
                  !CalendarAttendeeSummary.isMemberAddress(email),
                  seen.insert(email).inserted else { continue }
            out.append(email)
            if out.count == attendeeLookupLimit { break }
        }
        return out
    }

    /// Each asked address to the contact that holds it. A contact matches on
    /// any address it holds; when two hold one address, the first wins.
    static func byAddress(_ contacts: [CrmContact], among addresses: [String]) -> [String: CrmContact] {
        let asked = Set(addresses.map { $0.lowercased() })
        var out: [String: CrmContact] = [:]
        for contact in contacts {
            for address in contact.emails + [contact.email].compactMap({ $0 }) {
                let key = address.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                guard asked.contains(key), out[key] == nil else { continue }
                out[key] = contact
            }
        }
        return out
    }
}

extension CrmContactDetail {
    var displayName: String {
        if let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty { return name }
        return email ?? String(localized: "Unnamed")
    }

    /// The title and the organization, for the head of the page.
    var context: String {
        [title, organizationName].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// The organization as a subject to open, when there is one.
    var organizationSubject: CrmSubject? {
        guard let organizationID else { return nil }
        return CrmSubject(id: organizationID, kind: "organization", title: organizationName ?? String(localized: "Organization"), subtitle: nil)
    }
}

/// The deliberately small common editor payload. Relation ids come from
/// Core-backed pickers in Work (or from a prefilled sales touch); UUID text
/// boxes would make the current create flow actively worse. On the wire it
/// is the generated `CrmSubjectCreate`: one of two bodies, by kind.
struct CrmSubjectDraft: Sendable {
    let kind: MeetingCategoryKind.SubjectKind
    var title: String
    var status: String
    var startDate: String?
    var endDate: String?
    var description: String?
    var url: String?
    var notes: String?
    /// Relations a subject is born with. A lead takes one organization and
    /// one contact — "Start a lead" from the Sales inbox prefills both. A
    /// project may have one organization and many contacts. Nil
    /// is omitted: the Worker refuses an empty string as an invalid UUID.
    var organizationID: String?
    var contactID: String? = nil
    var contactIDs: [String] = []
    /// A lead's characteristics, qualification checks included. Nil sends none.
    var characteristics: [String: Bool]? = nil

    /// The body Core is sent, each field as `FormFieldRegistry` says: a
    /// blank is left out, never `""`. A lead's start date is required there;
    /// an empty one goes as today.
    var create: CrmSubjectCreate {
        switch kind {
        case .lead:
            let fields = FormFieldRegistry.lead
            return .lead(CrmLeadCreate(
                title: fields.title.patch(title, .create),
                organizationID: fields.organization.patch(organizationID, .create),
                contactID: fields.contact.patch(contactID, .create),
                status: CrmLeadStatus(rawValue: status),
                startDate: fields.startDate.optional(startDate) ?? CrmTaskDate.civilDay(Date()),
                notes: fields.notes.patch(notes, .create),
                characteristics: .ifSome(characteristics)
            ))
        case .project, .organization, .event:
            let fields = FormFieldRegistry.project
            return .project(CrmProjectCreate(
                title: fields.title.optional(title) ?? title,
                description: fields.description.patch(description, .create),
                url: fields.url.patch(url, .create),
                organizationID: fields.organization.patch(organizationID, .create),
                // Omitted rather than sent empty, so a project created
                // without the picker touched does not assert "no contacts".
                contactIDs: fields.contacts.list(contactIDs, .create),
                startDate: fields.startDate.patch(startDate, .create),
                endDate: fields.endDate.patch(endDate, .create),
                status: CrmProjectStatus(rawValue: status)
            ))
        }
    }
}

/// A subject edit, as the generated per-kind body. The editor sends the
/// complete state so clearing a field clears Core's value too; a rename
/// sends the title alone, so Core metadata the editor never showed stays.
enum CrmSubjectUpdate: Encodable, Sendable {
    case lead(CrmLeadUpdate)
    case project(CrmProjectUpdate)

    init(
        kind: MeetingCategoryKind.SubjectKind,
        title: String,
        status: String,
        startDate: String?,
        endDate: String?,
        description: String?,
        url: String?,
        notes: String?,
        /// The picker's organization; none clears it, as `FormFieldRegistry` says.
        organizationID: String?,
        contactID: String? = nil,
        /// A project's contacts, in full. Unlike create this is sent even
        /// when empty: the editor showed the whole list, so an empty one is
        /// the person saying "nobody", not "I didn't look".
        contactIDs: [String] = [],
        /// A lead's characteristics in full — the record as read with the
        /// qualification checks changed — or nil to leave them alone.
        characteristics: [String: Bool]? = nil
    ) {
        switch kind {
        case .lead:
            let fields = FormFieldRegistry.lead
            self = .lead(CrmLeadUpdate(
                title: fields.title.patch(title, .update),
                organizationID: fields.organization.patch(organizationID, .update),
                contactID: fields.contact.patch(contactID, .update),
                status: CrmLeadStatus(rawValue: status),
                startDate: fields.startDate.optional(startDate),
                notes: fields.notes.patch(notes, .update),
                characteristics: .ifSome(characteristics)
            ))
        case .project, .organization, .event:
            let fields = FormFieldRegistry.project
            self = .project(CrmProjectUpdate(
                title: fields.title.optional(title),
                description: fields.description.patch(description, .update),
                url: fields.url.patch(url, .update),
                organizationID: fields.organization.patch(organizationID, .update),
                contactIDs: fields.contacts.list(contactIDs, .update),
                startDate: fields.startDate.patch(startDate, .update),
                endDate: fields.endDate.patch(endDate, .update),
                status: CrmProjectStatus(rawValue: status)
            ))
        }
    }

    /// The narrow PATCH used by the Work list's quick Rename action.
    static func rename(kind: MeetingCategoryKind.SubjectKind, title: String) -> CrmSubjectUpdate {
        switch kind {
        case .lead: .lead(CrmLeadUpdate(title: .value(title)))
        case .project, .organization, .event: .project(CrmProjectUpdate(title: title))
        }
    }

    func encode(to encoder: Encoder) throws {
        switch self {
        case .lead(let body): try body.encode(to: encoder)
        case .project(let body): try body.encode(to: encoder)
        }
    }
}

/// A repository link is a Core decision, not a GitHub object copied into Meet.
/// The owner/repo pair is the stable display address users need at a glance.
extension CrmGithubRepo: Identifiable {
    var address: String { "@\(owner)/\(repo)" }

    /// A link the app names itself, before Core has an id for it.
    init(owner: String, repo: String, label: String? = nil, milestone: String? = nil, isPrimary: Bool = false) {
        self.init(id: "\(owner)/\(repo)", owner: owner, repo: repo, label: label, milestone: milestone, isPrimary: isPrimary)
    }
}

extension CrmProjectRepoCreate {
    init(projectID: String, owner: String, repo: String, label: String?, milestone: String?, isPrimary: Bool?) {
        self.init(projectID: projectID, owner: owner, repo: repo, label: .ifSome(label), milestone: .ifSome(milestone), isPrimary: isPrimary)
    }
}

/// The list as the app holds it: the rows are `CrmSubject`, built from the
/// generated `CrmSubjectsResponse`. `hasMore`: more exist than came back. A
/// list this long is a browse, not a search — past it the answer is to type,
/// and the screens say so rather than letting the list read as everything.
struct CrmSubjectsResponse: Decodable, Sendable {
    let subjects: [CrmSubject]
    let hasMore: Bool
    /// Organizations only: every industry and country, for the filter menus.
    let facets: CrmSubjectsResponseFacets?

    init(from decoder: Decoder) throws {
        let wire = try StarlingsContracts.CrmSubjectsResponse(from: decoder)
        subjects = wire.subjects.map(CrmSubject.init(wire:))
        hasMore = wire.hasMore
        facets = wire.facets
    }
}

/// Core's organization list filters, as the Organizations group
/// holds them. Partner is on by default, so the default view is the
/// partners. The web's `OrganizationListFilter` is the same; the fixture
/// `subject-query.json` pins what both send.
struct OrganizationListFilter: Codable, Equatable, Sendable {
    var partner = true
    var agency = false
    var existingClient = false
    var industry: String?
    var country: String?

    static let `default` = OrganizationListFilter()

    /// True when the filter is the default view, the partners.
    var isDefault: Bool {
        partner && !agency && !existingClient && Self.trimmed(industry) == nil && Self.trimmed(country) == nil
    }

    /// The wire parameters that differ from the default, in the contract's order.
    var wireValues: (partner: Bool?, agency: Bool?, existingClient: Bool?, industry: String?, country: String?) {
        (partner ? nil : false, agency ? true : nil, existingClient ? true : nil, Self.trimmed(industry), Self.trimmed(country))
    }

    /// A snapshot key's discriminator: nil for the default, so the partners
    /// keep the snapshot they always had.
    var snapshotTag: String? {
        guard !isDefault else { return nil }
        return CrmSubjectsQuery.browse(kind: .organization, query: "", organizations: self).queryItems
            .dropFirst()
            .map { "\($0.name)=\($0.value ?? "")" }
            .joined(separator: "&")
    }

    private static func trimmed(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static let defaultsKey = "meet.workSidebar.filter.organizations"

    /// The filter this device last chose, or the default.
    static func saved(_ defaults: UserDefaults = .standard) -> OrganizationListFilter {
        guard let data = defaults.data(forKey: defaultsKey),
              let filter = try? JSONDecoder().decode(OrganizationListFilter.self, from: data) else { return .default }
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

struct CrmSubjectDetailResponse: Decodable, Sendable {
    let subject: CrmSubjectDetail
}

typealias CrmSubjectMutationResponse = CrmSubjectDetailResponse

// `CrmTaskStatus` and `CrmTaskResponsible`, their cases and their words, are
// generated from `packages/contracts/src/task-values.ts` into
// `Generated/TaskValuesRegistry.swift`. `review` and `blocked` are the two
// columns the board has that Core's task table did not (docs/BOARD.md);
// `proposed` and `declined` are a proposal's states.
extension CrmTaskStatus {
    var isFinished: Bool { self == .completed || self == .cancelled || self == .declined }
    var isProposed: Bool { self == .proposed }

    /// What a person may set by hand. Proposed and declined are outcomes of
    /// Accept / Decline on a proposal, never a choice in an editor.
    static var editable: [CrmTaskStatus] {
        allCases.filter { $0 != .proposed && $0 != .declined }
    }
}

struct CrmTask: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let title: String
    let notes: String?
    let status: CrmTaskStatus
    let responsibleParty: CrmTaskResponsible
    let priority: String?
    /// Free-form CRM labels, the counterpart of an issue's.
    let tags: [String]
    /// What this task became, if it was promoted. A pointer only — closing one
    /// does not close the other.
    let githubOwner: String?
    let githubRepo: String?
    let githubIssueNumber: Int?
    /// Who owes the work. Nil until somebody is named — `responsible_party`
    /// says which side owes it, this says which person.
    let assigneeID: String?
    let assigneeName: String?
    let assigneeEmail: String?
    let dueDate: String?
    let projectID: String?
    let leadID: String?
    /// The third subject: a CMS event (docs/EVENTS.md). Nil from a Core that
    /// predates it.
    let eventID: String?
    /// The partner's CRM organization. Core also echoes it on a task that
    /// hangs off a project, lead or event, so read it through
    /// `partnerOrganizationID`, never on its own.
    let organizationID: String?
    /// The fourth: a Meet meeting, by Meet's id. Nil from a Core
    /// that predates it.
    let meetingID: String?
    /// The goal this task serves. Nil from a Core that predates
    /// goals, or when it serves none.
    let goalID: String?
    let updatedAt: String?

    /// Past its date. Undated work is never late; it was never promised for a
    /// day. Same rule as `CrmMyTask.isOverdue` — a task must not read as late
    /// in one list and on time in another.
    var isOverdue: Bool {
        CrmTaskDate.isOverdue(dueDate)
    }

    init(wire: CrmTaskWire) {
        self.init(
            id: wire.id,
            title: wire.title,
            notes: wire.notes,
            status: CrmTaskStatus(rawValue: wire.status) ?? .pending,
            responsibleParty: CrmTaskResponsible(rawValue: wire.responsibleParty) ?? .unassigned,
            priority: wire.priority ?? nil,
            tags: wire.tags ?? [],
            githubOwner: wire.githubOwner ?? nil,
            githubRepo: wire.githubRepo ?? nil,
            githubIssueNumber: wire.githubIssueNumber ?? nil,
            assigneeID: wire.assigneeID,
            assigneeName: wire.assigneeName,
            assigneeEmail: wire.assigneeEmail,
            dueDate: wire.dueDate,
            projectID: wire.projectID,
            leadID: wire.leadID,
            eventID: wire.eventID ?? nil,
            organizationID: wire.organizationID ?? nil,
            meetingID: wire.meetingID ?? nil,
            goalID: wire.goalID ?? nil,
            updatedAt: wire.updatedAt
        )
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try CrmTaskWire(from: decoder))
    }

    init(
        id: String,
        title: String,
        notes: String? = nil,
        status: CrmTaskStatus = .pending,
        responsibleParty: CrmTaskResponsible = .unassigned,
        priority: String? = nil,
        tags: [String] = [],
        githubOwner: String? = nil,
        githubRepo: String? = nil,
        githubIssueNumber: Int? = nil,
        assigneeID: String? = nil,
        assigneeName: String? = nil,
        assigneeEmail: String? = nil,
        dueDate: String? = nil,
        projectID: String? = nil,
        leadID: String? = nil,
        eventID: String? = nil,
        organizationID: String? = nil,
        meetingID: String? = nil,
        goalID: String? = nil,
        updatedAt: String? = nil
    ) {
        self.id = id
        self.title = title
        self.notes = notes
        self.status = status
        self.responsibleParty = responsibleParty
        self.priority = priority
        self.tags = tags
        self.githubOwner = githubOwner
        self.githubRepo = githubRepo
        self.githubIssueNumber = githubIssueNumber
        self.assigneeID = assigneeID
        self.assigneeName = assigneeName
        self.assigneeEmail = assigneeEmail
        self.dueDate = dueDate
        self.projectID = projectID
        self.leadID = leadID
        self.eventID = eventID
        self.organizationID = organizationID
        self.meetingID = meetingID
        self.goalID = goalID
        self.updatedAt = updatedAt
    }
}

struct CrmTasksResponse: Decodable, Sendable {
    let tasks: [CrmTask]
}

struct CrmTaskEnvelope: Decodable, Sendable {
    let task: CrmTask
}

/// The generated `CrmTaskCreate`, from the app's own values. Exactly one of
/// the four subject ids is set; a `meetingID` alone files on the meeting.
/// `source` is `suggestion` when the meeting proposed it and the owner
/// accepted — the only kind of task the Worker reports into the channel.
extension CrmTaskCreate {
    init(
        title: String,
        notes: String?,
        status: String?,
        responsibleParty: String,
        /// Absent is the creator: the Worker assigns them.
        /// `.null` is nobody, which an editor sends when Nobody is chosen.
        assignedTo: Patch<String> = .omit,
        dueDate: String? = nil,
        projectID: String?,
        leadID: String?,
        eventID: String? = nil,
        organizationID: String? = nil,
        meetingID: String? = nil,
        source: String? = nil,
        goalID: String? = nil
    ) {
        self.init(
            title: title,
            notes: .ifSome(notes),
            status: status.map(CrmTaskStatusValue.init(rawValue:)),
            responsibleParty: CrmResponsiblePartyValue(rawValue: responsibleParty),
            assignedTo: assignedTo,
            dueDate: .ifSome(dueDate),
            projectID: .ifSome(projectID),
            leadID: .ifSome(leadID),
            eventID: .ifSome(eventID),
            organizationID: .ifSome(organizationID),
            source: source.map(CrmTaskCreateSource.init(rawValue:)),
            meetingID: meetingID,
            goalID: .ifSome(goalID)
        )
    }
}

/// Somebody work can be assigned to. Core is the roster: a colleague who has
/// never opened Meet is still assignable, so this is not the presence list.
/// A GitHub issue on a project's linked repositories.
///
/// Read only: an issue stays GitHub's row, and Meet links out rather than
/// copying it into a task. See docs/CHANNELS.md.
struct CrmIssue: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let number: Int
    let owner: String
    let repo: String
    let title: String
    let state: String
    let url: String
    /// Label names. `labelDetails` is the same set with GitHub's colours; a
    /// Core that has not been updated sends only this, so the two are kept
    /// apart rather than one being derived and then trusted.
    let labels: [String]
    let labelDetails: [CrmIssueLabel]
    let assigneeLogin: String?
    let assignees: [CrmIssueUser]
    let author: CrmIssueUser?
    let createdAt: String?
    let updatedAt: String?
    let closedAt: String?
    /// Why it closed: `completed`, `not_planned`, `duplicate`, `reopened`.
    let stateReason: String?
    /// GitHub Issue Types, where the repository defines them.
    let issueType: String?
    let milestone: String?
    let milestoneDetail: CrmIssueMilestone?
    let comments: Int
    let reactions: [String: Int]
    let subIssues: CrmIssueSubIssues?

    var isOpen: Bool { state == "open" }
    /// `owner/repo#142` is too long for a row; the number is what people say.
    var shortReference: String { "#\(number)" }

    /// The labels with whatever colour is known. A Core that only sends names
    /// still draws, in the app's own grey, rather than not drawing at all.
    var drawableLabels: [CrmIssueLabel] {
        labelDetails.isEmpty
            ? labels.map { CrmIssueLabel(name: $0, color: nil, description: nil) }
            : labelDetails
    }

    /// "Open", "Closed", or the one closure GitHub distinguishes and people
    /// act on differently: something decided against rather than finished.
    var stateSummary: String {
        if isOpen { return "Open" }
        return switch stateReason {
        case "not_planned": String(localized: "Closed as not planned")
        case "duplicate": String(localized: "Closed as duplicate")
        default: String(localized: "Closed")
        }
    }

    init(wire: CrmIssueWire) {
        id = wire.id
        number = wire.number
        owner = wire.owner
        repo = wire.repo
        title = wire.title
        state = wire.state.rawValue
        url = wire.url
        labels = wire.labels
        labelDetails = wire.labelDetails ?? []
        assigneeLogin = wire.assigneeLogin
        assignees = wire.assignees ?? []
        author = wire.author ?? nil
        createdAt = wire.createdAt ?? nil
        updatedAt = wire.updatedAt
        closedAt = wire.closedAt ?? nil
        stateReason = wire.stateReason ?? nil
        issueType = wire.issueType ?? nil
        milestone = wire.milestone
        milestoneDetail = wire.milestoneDetail ?? nil
        comments = wire.comments
        reactions = wire.reactions ?? [:]
        subIssues = wire.subIssues ?? nil
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try CrmIssueWire(from: decoder))
    }
}

extension CrmIssueEvent: Identifiable {
    var summary: String? {
        let who = actor ?? String(localized: "Somebody")
        return switch kind {
        case "labeled": "\(who) added \(subject ?? label?.name ?? String(localized: "a label"))"
        case "unlabeled": "\(who) removed \(label?.name ?? String(localized: "a label"))"
        case "assigned": "\(who) assigned \(subject ?? "somebody")"
        case "unassigned": "\(who) unassigned \(subject ?? "somebody")"
        case "milestoned": "\(who) added this to \(subject ?? String(localized: "a milestone"))"
        case "demilestoned": "\(who) removed this from \(subject ?? String(localized: "a milestone"))"
        case "renamed": String(localized: "\(who) changed the title")
        case "closed":
            switch stateReason {
            case "not_planned": String(localized: "\(who) closed this as not planned")
            case "duplicate": String(localized: "\(who) closed this as a duplicate")
            default: String(localized: "\(who) closed this")
            }
        case "reopened": String(localized: "\(who) reopened this")
        case "referenced": String(localized: "\(who) referenced this")
        case "cross-referenced": "\(who) mentioned this in \(subject ?? String(localized: "somewhere else"))"
        case "connected": "\(who) linked \(subject ?? String(localized: "a pull request"))"
        case "disconnected": "\(who) unlinked \(subject ?? String(localized: "a pull request"))"
        case "marked_as_duplicate": String(localized: "\(who) marked this a duplicate")
        case "unmarked_as_duplicate": String(localized: "\(who) unmarked this as a duplicate")
        case "sub_issue_added": "\(who) added \(subject ?? String(localized: "a sub-issue"))"
        case "sub_issue_removed": "\(who) removed \(subject ?? String(localized: "a sub-issue"))"
        case "parent_issue_added": "\(who) made this part of \(subject ?? String(localized: "another issue"))"
        case "parent_issue_removed": "\(who) took this out of \(subject ?? String(localized: "another issue"))"
        case "locked": String(localized: "\(who) locked the conversation")
        case "unlocked": String(localized: "\(who) unlocked the conversation")
        case "pinned": String(localized: "\(who) pinned this")
        case "unpinned": String(localized: "\(who) unpinned this")
        case "transferred": String(localized: "\(who) transferred this from another repository")
        default: nil
        }
    }
}

/// A task on your plate, wherever it came from.
struct CrmMyTask: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let title: String
    let status: CrmTaskStatus
    let dueDate: String?
    let priority: String?
    let projectID: String?
    let leadID: String?
    /// The third subject: a CMS event (docs/EVENTS.md).
    let eventID: String?
    /// The partner's CRM organization; see `CrmTask.organizationID`.
    let organizationID: String?
    let meetingID: String?
    /// Which project, lead, event or partner it belongs to — a cross-subject list needs it.
    let subjectTitle: String?
    /// What this task became, if it was promoted. Read together as
    /// `owner/repo#number`, which is how the work plan tells a promoted task
    /// and its issue to be the same row. See `WorkItems`.
    let githubOwner: String?
    let githubRepo: String?
    let githubIssueNumber: Int?
    let updatedAt: String?

    /// Past its civil day, the same rule `WorkItems` plans by: work due
    /// earlier today is due today, not late. Undated work is never late; it
    /// was never promised.
    var isOverdue: Bool {
        CrmTaskDate.isOverdue(dueDate)
    }

    /// The subject it came from, as something openable.
    var subject: CrmSubject? {
        guard let title = subjectTitle else { return nil }
        if let projectID {
            return CrmSubject(id: projectID, kind: "project", title: title, subtitle: nil)
        }
        if let leadID {
            return CrmSubject(id: leadID, kind: "lead", title: title, subtitle: nil)
        }
        if let eventID {
            return CrmSubject(id: eventID, kind: "event", title: title, subtitle: nil)
        }
        if let partnerOrganizationID {
            return CrmSubject(id: partnerOrganizationID, kind: "organization", title: title, subtitle: nil)
        }
        return nil
    }

    init(wire: CrmMyTaskWire) {
        self.init(
            id: wire.id,
            title: wire.title,
            status: CrmTaskStatus(rawValue: wire.status) ?? .pending,
            dueDate: wire.dueDate,
            priority: wire.priority,
            projectID: wire.projectID,
            leadID: wire.leadID,
            eventID: wire.eventID ?? nil,
            organizationID: wire.organizationID ?? nil,
            meetingID: wire.meetingID ?? nil,
            subjectTitle: wire.subjectTitle,
            githubOwner: wire.githubOwner,
            githubRepo: wire.githubRepo,
            githubIssueNumber: wire.githubIssueNumber,
            updatedAt: wire.updatedAt
        )
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try CrmMyTaskWire(from: decoder))
    }

    init(
        id: String,
        title: String,
        status: CrmTaskStatus = .pending,
        dueDate: String? = nil,
        priority: String? = nil,
        projectID: String? = nil,
        leadID: String? = nil,
        eventID: String? = nil,
        organizationID: String? = nil,
        meetingID: String? = nil,
        subjectTitle: String? = nil,
        githubOwner: String? = nil,
        githubRepo: String? = nil,
        githubIssueNumber: Int? = nil,
        updatedAt: String? = nil
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.dueDate = dueDate
        self.priority = priority
        self.projectID = projectID
        self.leadID = leadID
        self.eventID = eventID
        self.organizationID = organizationID
        self.meetingID = meetingID
        self.subjectTitle = subjectTitle
        self.githubOwner = githubOwner
        self.githubRepo = githubRepo
        self.githubIssueNumber = githubIssueNumber
        self.updatedAt = updatedAt
    }
}

struct CrmMyWorkResponse: Decodable, Sendable {
    let tasks: [CrmMyTask]
    /// Issues assigned to you, once your GitHub username is known.
    let issues: [CrmIssue]
    /// False when no member matches the address: an empty list, not an error.
    let matched: Bool
    /// Nil until somebody says who they are on GitHub, which is why the issues
    /// half can be empty while the tasks half is not.
    let githubLogin: String?

    init(from decoder: Decoder) throws {
        let wire = try StarlingsContracts.CrmMyWorkResponse(from: decoder)
        tasks = wire.tasks.map(CrmMyTask.init(wire:))
        issues = wire.issues.map(CrmIssue.init(wire:))
        matched = wire.matched
        githubLogin = wire.githubLogin
    }
}

enum CrmRecentlyClosedKind: String, Equatable, Sendable {
    case task
    case issue
}

struct CrmRecentlyClosedItem: Decodable, Equatable, Identifiable, Sendable {
    let kind: CrmRecentlyClosedKind
    let id: String
    let title: String
    let subjectTitle: String?
    let projectID: String?
    let updatedAt: String?
    let issue: CrmIssue?

    init(wire: StarlingsContracts.CrmRecentlyClosedItemWire) {
        kind = switch wire.kind {
        case .task: .task
        case .issue: .issue
        }
        id = wire.id
        title = wire.title
        subjectTitle = wire.subjectTitle
        projectID = wire.projectID
        updatedAt = wire.updatedAt
        issue = wire.issue.map(CrmIssue.init(wire:))
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try StarlingsContracts.CrmRecentlyClosedItemWire(from: decoder))
    }
}

struct CrmRecentlyClosedWorkResponse: Decodable, Sendable {
    let items: [CrmRecentlyClosedItem]
    let partial: [String]

    init(from decoder: Decoder) throws {
        let wire = try StarlingsContracts.CrmRecentlyClosedWorkResponse(from: decoder)
        items = wire.items.map(CrmRecentlyClosedItem.init(wire:))
        partial = wire.partial
    }
}

/// Open work nobody on our side holds, on every subject (docs/BOARD.md
/// §Unowned). Mine's shapes, already through the shared rule at the Worker:
/// planned and drawn the way Mine is, never filtered again here.
struct CrmUnownedWorkResponse: Decodable, Sendable {
    /// `var` so a row acted on leaves the list at once, before the re-read.
    var tasks: [CrmMyTask]
    var issues: [CrmIssue]
    /// The project each issue was read for, by issue id: a task names its
    /// own subject, an issue does not.
    let issueSubjects: [String: UnownedSubjects.Subject]
    /// Subjects whose work could not be read, by title.
    let partial: [String]
    /// The read's gaps, told apart: a failure and a cap hit.
    let gaps: WorkReadGaps

    init(from decoder: Decoder) throws {
        let wire = try StarlingsContracts.CrmUnownedWorkResponse(from: decoder)
        tasks = wire.tasks.map(CrmMyTask.init(wire:))
        issues = wire.issues.map(CrmIssue.init(wire:))
        issueSubjects = (wire.issueSubjects ?? [:]).mapValues {
            UnownedSubjects.Subject(key: "\($0.kind.rawValue):\($0.id)", title: $0.title)
        }
        partial = wire.partial
        gaps = WorkReadGaps(partial: wire.partial, truncated: wire.truncated, failed: wire.failed)
    }
}

/// What a Work read could not give in full, in words. A failure
/// is red with its cause and a Retry; a subject that only hit the row cap is
/// quiet grey copy, not an error. The web says the same in `read-gaps.ts`.
/// An organization's Tasks By project: each of its projects with
/// open tasks, in the Worker's order. `partial` says a project's read failed;
/// the surfaces say so with `failureLine`.
struct CrmOrganizationProjectTaskGroups: Equatable, Sendable {
    struct Project: Identifiable, Equatable, Sendable {
        let id: String
        let title: String
        let status: String?
        let tasks: [CrmTask]

        /// The project, as something a header can open.
        var subject: CrmSubject { CrmSubject(id: id, kind: "project", title: title, subtitle: status) }
    }

    let projects: [Project]
    let partial: Bool

    init(_ response: CrmOrganizationProjectTasksResponse) {
        projects = response.projects.map {
            Project(
                id: $0.id,
                title: $0.title ?? String(localized: "Untitled project"),
                status: $0.status,
                tasks: $0.tasks.map(CrmTask.init(wire:))
            )
        }
        partial = response.partial
    }

    private init(projects: [Project], partial: Bool) {
        self.projects = projects
        self.partial = partial
    }

    /// The groups without one task (a delete); an emptied project leaves.
    func removing(taskID: String) -> CrmOrganizationProjectTaskGroups {
        CrmOrganizationProjectTaskGroups(
            projects: projects.compactMap { project in
                let tasks = project.tasks.filter { $0.id != taskID }
                guard !tasks.isEmpty else { return nil }
                return Project(id: project.id, title: project.title, status: project.status, tasks: tasks)
            },
            partial: partial
        )
    }

    /// The same red line every partial read draws, naming the projects.
    var failureLine: String? {
        guard partial else { return nil }
        return WorkReadGaps(partial: [String(localized: "Projects")], truncated: nil, failed: nil).failureLine
    }

    /// The device's choice for an organization's Tasks (`work.organization.byProject`).
    static let byProjectDefaultsKey = "work.organization.byProject"

    /// Each project section's remembered fold.
    static func foldKey(organizationID: String, projectID: String) -> String {
        "work.organization.byProject.\(organizationID).\(projectID)"
    }
}

struct WorkReadGaps: Equatable, Sendable {
    let failed: [StarlingsContracts.CrmReadFailure]
    let truncated: [String]

    init(partial: [String], truncated: [String]?, failed: [StarlingsContracts.CrmReadFailure]?) {
        // A Worker from before the split sends only names.
        self.failed = failed ?? partial.map { StarlingsContracts.CrmReadFailure(subject: $0, cause: .upstream) }
        self.truncated = truncated ?? []
    }

    static let none = WorkReadGaps(partial: [], truncated: [], failed: [])

    /// "Couldn’t read Envisioning Core: busy, try again in a moment (429)." Nil when nothing failed.
    var failureLine: String? {
        guard !failed.isEmpty else { return nil }
        let list = failed.map { failure in
            let code = failure.status.map { " (\($0))" } ?? ""
            return String(localized: "\(failure.subject): \(Self.label(failure.cause))\(code)")
        }.joined(separator: "; ")
        return String(localized: "Couldn’t read \(list).")
    }

    /// "Showing the first rows of Envisioning Meet." Nil when nothing hit the cap.
    var truncatedLine: String? {
        guard !truncated.isEmpty else { return nil }
        return String(localized: "Showing the first rows of \(truncated.joined(separator: ", ")).")
    }

    private static func label(_ cause: StarlingsContracts.CrmReadFailureCause) -> String {
        switch cause {
        case .rateLimited: String(localized: "busy, try again in a moment")
        case .auth: String(localized: "access refused")
        case .timeout: String(localized: "no answer in time")
        default: String(localized: "the read failed")
        }
    }
}

/// UNOWNED's Subjects menu: which subject a row is on, the choices with
/// their counts, and the plan with hidden subjects taken out. Mac and iOS
/// draw the same menu from this; the web's twin is in `WorkPage.tsx`.
enum UnownedSubjects {
    struct Subject: Equatable, Sendable {
        /// `kind:id`, the key a hidden subject is remembered by.
        let key: String
        let title: String
    }

    struct Choice: Identifiable, Equatable, Sendable {
        let key: String
        let title: String
        var count: Int
        var id: String { key }
    }

    static func subject(of item: PlannedWorkItem, issueSubjects: [String: Subject]) -> Subject? {
        switch item {
        case .task(let task):
            return task.subject.map { Subject(key: "\($0.kind):\($0.id)", title: $0.title) }
        case .issue(let issue):
            return issueSubjects[issue.id]
        case .subjectTask:
            return nil
        }
    }

    /// The plan without the hidden subjects' rows; a row with no subject stays.
    static func shown(
        _ plan: WorkPlan<PlannedWorkItem>,
        hidden: Set<String>,
        issueSubjects: [String: Subject]
    ) -> WorkPlan<PlannedWorkItem> {
        guard !hidden.isEmpty else { return plan }
        return plan.filtered { item in
            subject(of: item, issueSubjects: issueSubjects).map { !hidden.contains($0.key) } ?? true
        }
    }

    /// Every subject with rows of `origin`, hidden ones included, by title.
    static func choices(
        _ plan: WorkPlan<PlannedWorkItem>,
        origin: MineOriginFilter,
        issueSubjects: [String: Subject]
    ) -> [Choice] {
        var found: [String: Choice] = [:]
        for item in plan.order where origin == .all || item.workOrigin.rawValue == origin.rawValue {
            guard let subject = subject(of: item, issueSubjects: issueSubjects) else { continue }
            found[subject.key, default: Choice(key: subject.key, title: subject.title, count: 0)].count += 1
        }
        return found.values.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    }
}

struct CrmIssueComment: Decodable, Equatable, Identifiable, Sendable {
    let id: Int
    let author: String
    let authorAvatarURL: String?
    let body: String
    let createdAt: String
    /// Nil unless somebody edited it, so "edited" can be said honestly.
    let updatedAt: String?
    let url: String
    let reactions: [String: Int]

    init(wire: StarlingsContracts.CrmIssueComment) {
        id = wire.id
        author = wire.author
        authorAvatarURL = wire.authorAvatarURL ?? nil
        body = wire.body
        createdAt = wire.createdAt
        updatedAt = wire.updatedAt ?? nil
        url = wire.url
        reactions = wire.reactions ?? [:]
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try StarlingsContracts.CrmIssueComment(from: decoder))
    }
}

struct CrmIssueDetail: Decodable, Equatable, Identifiable, Sendable {
    let issue: CrmIssue
    let body: String
    let comments: [CrmIssueComment]
    /// What happened to it that nobody typed. Empty where Core is older than
    /// this field, or where GitHub refused the timeline — the issue still reads.
    let timeline: [CrmIssueEvent]
    /// The children themselves, where `subIssues` only counted them. Empty for
    /// the ordinary issue that has none.
    let subIssues: [CrmSubIssue]

    var id: String { issue.id }

    /// Comments and events in one chronological read, which is the order the
    /// thread actually happened in. GitHub's own reading view does this; two
    /// separate lists would make a label change look like it came last.
    var thread: [CrmIssueThreadEntry] {
        let entries = comments.map(CrmIssueThreadEntry.comment)
            + timeline.filter { $0.summary != nil }.map(CrmIssueThreadEntry.event)
        return entries.sorted { left, right in
            // Undated sorts last rather than to 1970: an unknown time is not
            // the beginning of the thread.
            switch (left.date, right.date) {
            case let (lhs?, rhs?): lhs < rhs
            case (nil, _?): false
            case (_?, nil): true
            case (nil, nil): false
            }
        }
    }

    init(wire: CrmIssueDetailWire) {
        // The detail is the issue with more; the generated row is the same
        // fields, so the issue reads from the detail's own values.
        issue = CrmIssue(wire: CrmIssueWire(
            id: wire.id, number: wire.number, owner: wire.owner, repo: wire.repo, title: wire.title,
            state: wire.state, url: wire.url, labels: wire.labels, labelDetails: wire.labelDetails,
            assigneeLogin: wire.assigneeLogin, assignees: wire.assignees, author: wire.author,
            createdAt: wire.createdAt, updatedAt: wire.updatedAt, closedAt: wire.closedAt,
            stateReason: wire.stateReason, issueType: wire.issueType, milestone: wire.milestone,
            milestoneDetail: wire.milestoneDetail, comments: wire.comments, reactions: wire.reactions,
            subIssues: wire.subIssues
        ))
        body = wire.body
        comments = wire.commentsList.map(CrmIssueComment.init(wire:))
        timeline = wire.timeline ?? []
        subIssues = wire.subIssueList ?? []
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try CrmIssueDetailWire(from: decoder))
    }
}

extension CrmSubIssue: Identifiable {
    public var id: Int { number }
    var isOpen: Bool { state == .open }
}

/// One entry under an issue's body: something somebody wrote, or something
/// that happened to it.
enum CrmIssueThreadEntry: Equatable, Identifiable, Sendable {
    case comment(CrmIssueComment)
    case event(CrmIssueEvent)

    var id: String {
        switch self {
        case .comment(let comment): "comment-\(comment.id)"
        case .event(let event): "event-\(event.id)"
        }
    }

    var date: Date? {
        switch self {
        case .comment(let comment): CrmTaskDate.date(comment.createdAt)
        case .event(let event): CrmTaskDate.date(event.createdAt)
        }
    }
}

struct CrmIssueEnvelope: Decodable, Sendable {
    let issue: CrmIssue
}

struct CrmIssueDetailEnvelope: Decodable, Sendable {
    let issue: CrmIssueDetail
}

/// The generated `CrmIssueCreate`: the author is added by the Worker from
/// the session, so a client cannot write into the record as somebody else.
extension CrmIssueCreate {
    /// The same hand-off from Core task to GitHub issue, used by Work and the
    /// task readers on both native clients.
    static func promotion(projectID: String, taskID: String, title: String, body: String?) -> CrmIssueCreate {
        CrmIssueCreate(projectID: projectID, taskID: taskID, title: title, body: body)
    }
}

/// The generated `CrmIssueUpdate`, from the strings the editors carry.
/// `labels` and `assignees` are the whole set the issue should end up with,
/// not an addition — GitHub replaces on PATCH. `milestone` is a `Patch`:
/// `.omit` leaves it, `.null` takes it off, `.value` sets it.
extension CrmIssueUpdate {
    init(
        owner: String,
        repo: String,
        number: Int,
        projectID: String? = nil,
        title: String? = nil,
        body: String? = nil,
        state: String?,
        stateReason: String? = nil,
        labels: [String]? = nil,
        assignees: [String]? = nil,
        milestone: Patch<Int> = .omit,
        comment: String? = nil
    ) {
        self.init(
            owner: owner,
            repo: repo,
            number: number,
            projectID: projectID,
            title: title,
            body: body,
            state: state.map(CrmIssueState.init(rawValue:)),
            stateReason: stateReason.map(CrmIssueUpdateStateReason.init(rawValue:)),
            labels: labels,
            assignees: assignees,
            milestone: milestone,
            comment: comment
        )
    }
}

/// What an issue in a repository could be set to.
///
/// A picker has to offer real values: free text would let somebody invent a
/// label GitHub then creates, or type a login GitHub silently ignores — both
/// look like they worked.
struct CrmIssueFacets: Decodable, Equatable, Sendable {
    let labels: [CrmIssueLabel]
    let milestones: [CrmIssueMilestone]
    let assignees: [CrmIssueUser]

    static let none = CrmIssueFacets(labels: [], milestones: [], assignees: [])

    init(labels: [CrmIssueLabel], milestones: [CrmIssueMilestone], assignees: [CrmIssueUser]) {
        self.labels = labels
        self.milestones = milestones
        self.assignees = assignees
    }

    init(from decoder: Decoder) throws {
        let wire = try CrmIssueFacetsResponse(from: decoder)
        self.init(labels: wire.labels, milestones: wire.milestones, assignees: wire.assignees)
    }

    var isEmpty: Bool { labels.isEmpty && milestones.isEmpty && assignees.isEmpty }
}

struct CrmIssuesResponse: Decodable, Sendable {
    let issues: [CrmIssue]
    /// False means this project's work does not live in GitHub, which is not
    /// the same as having no issues.
    let linked: Bool
    /// A linked repository had more than this page. The list on screen is a
    /// prefix of the truth, and says so rather than pretending to be all of it.
    let hasMore: Bool

    init(from decoder: Decoder) throws {
        let wire = try StarlingsContracts.CrmIssuesResponse(from: decoder)
        issues = wire.issues.map(CrmIssue.init(wire:))
        linked = wire.linked
        hasMore = wire.hasMore ?? false
    }
}

/// How an issue list is narrowed and ordered. GitHub's own vocabulary, so
/// nothing has to be translated on the way out and a reader who knows GitHub
/// already knows what these do.
///
/// Everything here goes to the server rather than filtering what is in hand:
/// a repository can hold more issues than one page, and a filter applied to a
/// page would quietly hide the matches that did not fit in it.
struct CrmIssueFilter: Equatable, Sendable {
    enum State: String, CaseIterable, Sendable {
        case open, closed, all

        var menuTitle: String {
            switch self {
            case .open: String(localized: "Open")
            case .closed: String(localized: "Closed")
            case .all: String(localized: "All")
            }
        }
    }

    enum Sort: String, CaseIterable, Sendable {
        case updated, created, comments

        var menuTitle: String {
            switch self {
            case .updated: String(localized: "Recently updated")
            case .created: String(localized: "Newest")
            case .comments: String(localized: "Most commented")
            }
        }
    }

    var state: State = .open
    var labels: [String] = []
    /// A GitHub login, or `none` for issues nobody owns.
    var assignee: String?
    /// GitHub takes a milestone by **number**, or `none`. Not a title.
    var milestone: String?
    var sort: Sort = .updated
    var ascending = false
    /// Narrows what came back, by title and number. Local on purpose: this is
    /// a filter over the list on screen, not GitHub's search.
    var search = ""

    /// Whether anything but the default is on, so a bar can offer to clear.
    var isNarrowed: Bool {
        state != .open || !labels.isEmpty || assignee != nil || milestone != nil
            || sort != .updated || ascending || !search.isEmpty
    }

    /// What the server needs to hear, as the generated `CrmIssueQuery`.
    /// `search` is not here: it never leaves. GitHub ANDs a comma-separated
    /// label list. Narrowing happens at GitHub, not here: a repository can
    /// hold more issues than one page, and filtering a page hides what did
    /// not fit.
    func query(projectID: String, page: Int = 1) -> CrmIssueQuery {
        CrmIssueQuery(
            projectID: projectID,
            state: CrmIssueQueryState(rawValue: state.rawValue),
            labels: labels.isEmpty ? nil : labels.joined(separator: ","),
            assignee: assignee,
            milestone: milestone,
            sort: CrmIssueSort(rawValue: sort.rawValue),
            direction: ascending ? .asc : .desc,
            page: page > 1 ? page : nil
        )
    }

    /// Whether the server would be asked a different question than for
    /// `other`. `search` never leaves, so it does not count.
    func asksServerDifferently(from other: CrmIssueFilter) -> Bool {
        query(projectID: "") != other.query(projectID: "")
    }

    /// The one narrowing this side does. Number as well as title, because
    /// "276" is how somebody looks for an issue they already know.
    func matches(_ issue: CrmIssue) -> Bool {
        let wanted = search.trimmingCharacters(in: .whitespaces)
        guard !wanted.isEmpty else { return true }
        return issue.title.localizedCaseInsensitiveContains(wanted)
            || issue.shortReference.contains(wanted)
            || String(issue.number) == wanted
            || issue.labels.contains { $0.localizedCaseInsensitiveContains(wanted) }
    }
}

/// How a task list is narrowed and ordered. Tasks arrive as one complete
/// subject list, so these choices stay local: changing a filter never turns a
/// small list into a round trip or makes a row disappear while it is being
/// edited.
struct CrmTaskFilter: Equatable, Sendable {
    enum State: String, CaseIterable, Sendable {
        case open, completed, all

        var menuTitle: String {
            switch self {
            case .open: String(localized: "Open")
            case .completed: String(localized: "Done")
            case .all: String(localized: "All")
            }
        }
    }

    enum Due: String, CaseIterable, Sendable {
        case any, overdue, undated, scheduled

        var menuTitle: String {
            switch self {
            case .any: String(localized: "Any due date")
            case .overdue: String(localized: "Overdue")
            case .undated: String(localized: "Undated")
            case .scheduled: String(localized: "Scheduled")
            }
        }
    }

    enum Sort: String, CaseIterable, Sendable {
        case updated, due, title

        var menuTitle: String {
            switch self {
            case .updated: String(localized: "Recently updated")
            case .due: String(localized: "Due soonest")
            case .title: String(localized: "Title")
            }
        }
    }

    var state: State = .open
    var responsible: CrmTaskResponsible?
    var assigneeID: String?
    var due: Due = .any
    var sort: Sort = .updated
    var ascending = false
    var search = ""

    var isNarrowed: Bool {
        state != .open || responsible != nil || assigneeID != nil || due != .any
            || sort != .updated || ascending || !search.isEmpty
    }

    func matches(_ task: CrmTask) -> Bool {
        let stateMatches: Bool = switch state {
        case .open: !task.status.isFinished
        case .completed: task.status == .completed
        case .all: true
        }
        guard stateMatches else { return false }
        // The side and Overdue are the shared task filters (`passesTaskFilter`).
        if let responsible,
           !WorkItems.passesTaskFilter(task, due: .any, side: WorkSideFilter(rawValue: responsible.rawValue) ?? .any) {
            return false
        }
        if let assigneeID, task.assigneeID != assigneeID { return false }
        switch due {
        case .any: break
        case .overdue: guard WorkItems.passesTaskFilter(task, due: .overdue, side: .any) else { return false }
        case .undated: guard task.dueDate == nil else { return false }
        case .scheduled: guard task.dueDate != nil else { return false }
        }
        let wanted = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !wanted.isEmpty else { return true }
        return task.title.localizedCaseInsensitiveContains(wanted)
            || task.notes?.localizedCaseInsensitiveContains(wanted) == true
            || task.assigneeName?.localizedCaseInsensitiveContains(wanted) == true
    }
}

/// The wire spelling of a due date, shared by both clients so a task written on
/// a phone and one written on a Mac land on the same day.
enum CrmTaskDate {
    /// Built per call rather than held as a shared static.
    ///
    /// `ISO8601DateFormatter` is not `Sendable`, so a `static let` is a Swift 6
    /// error the moment this file compiles into the iOS target as well as the
    /// Mac one. Allocation here is cheap next to the network call every caller
    /// is already making.
    private static func internetDateTime() -> ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }

    static func wire(_ date: Date) -> String { internetDateTime().string(from: date) }

    /// A day as the CMS spells one, `YYYY-MM-DD`, in this device's calendar.
    static func civilDay(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// Core stores a timestamp; the calendar draws a day. Anything it cannot
    /// parse is treated as no date rather than as today.
    static func date(_ wire: String?) -> Date? {
        guard let wire else { return nil }
        if let parsed = internetDateTime().date(from: wire) { return parsed }
        let lenient = ISO8601DateFormatter()
        lenient.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = lenient.date(from: wire) { return parsed }
        // A plain `2026-08-23` is what a date-only column hands back.
        let plain = DateFormatter()
        plain.calendar = Calendar(identifier: .iso8601)
        plain.timeZone = .current
        plain.dateFormat = "yyyy-MM-dd"
        return plain.date(from: wire)
    }

    /// A wire date as people read it ("28 Sep 2026"), through the shared Meet
    /// formatter. A date-only value stays that calendar day; anything that
    /// does not parse yields nil rather than leaking the raw string.
    static func display(_ wire: String?) -> String? {
        date(wire).map { StarlingsDateFormatting.date($0) }
    }

    /// The one overdue rule used by task rows, Home, and the work planner.
    /// Comparing civil days keeps a task due earlier today from being called
    /// late merely because its timestamp has passed.
    static func isOverdue(
        _ wire: String?,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> Bool {
        guard let due = date(wire) else { return false }
        return WorkItems.dateSection(due: due, now: now, calendar: calendar) == .late
    }
}

/// A lead's or an organization's offers and licenses as an Overview row says
/// them. Both clients draw these words; each
/// client colours a license that `renewsSoon`. `day` is the client's short
/// date style.
enum SubjectCommercial {
    static func offerTitle(_ offer: CrmOffer) -> String {
        trimmed(offer.title) ?? String(localized: "Untitled offer")
    }

    /// The status, the total, the day it is valid until.
    static func offerSubtitle(_ offer: CrmOffer, day: (String?) -> String?) -> String {
        let status = trimmed(offer.status).map { OfferValues.statusLabel($0) ?? capitalised($0) }
        let unsent = offer.hasUnsentChanges == true ? String(localized: "Unsent changes") : nil
        let total = offer.totalAmount.map { money($0, currency: offer.currency) }
        let valid = day(offer.validUntil).map { String(localized: "Valid until \($0)") }
        return [status, unsent, total, valid].compactMap { $0 }.joined(separator: " · ")
    }

    /// The product and its plan; "License" when the product is unnamed.
    static func licenseTitle(_ license: CrmLicense) -> String {
        guard let product = trimmed(license.product) else { return String(localized: "License") }
        return [LicenseText.product(product), trimmed(license.planType).map(LicenseText.plan)].compactMap { $0 }.joined(separator: " · ")
    }

    /// The seats, the amount in euros, the renewal day, and Inactive.
    static func licenseSubtitle(_ license: CrmLicense, day: (String?) -> String?) -> String {
        let seats = license.seats.map { String(localized: "\($0) seats") }
        let amount = license.amountEur.map { money($0, currency: "EUR") }
        let renews = day(license.renewalDate).map { String(localized: "Renews \($0)") }
        let inactive = license.isActive ? nil : String(localized: "Inactive")
        return [seats, amount, renews, inactive].compactMap { $0 }.joined(separator: " · ")
    }

    /// An active license whose renewal day is 30 days away or less, or has
    /// passed: someone has to act on it.
    static func renewsSoon(_ license: CrmLicense, now: Date = Date(), calendar: Calendar = .current) -> Bool {
        guard license.isActive, let renewal = CrmTaskDate.date(license.renewalDate) else { return false }
        guard let limit = calendar.date(byAdding: .day, value: 30, to: calendar.startOfDay(for: now)) else { return false }
        return renewal <= limit
    }

    /// An INBOX commercial row's title: "Offer
    /// expires 3 Nov", "License renews 3 Nov", or "License renewal passed
    /// 3 Nov" when `due` is before today.
    static func inboxTitle(
        _ item: InboxCommercialItem,
        day: (String?) -> String?,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> String {
        let date = day(item.due) ?? item.due
        if item.event == .offerExpiring { return String(localized: "Offer expires \(date)") }
        return CrmTaskDate.isOverdue(item.due, now: now, calendar: calendar)
            ? String(localized: "License renewal passed \(date)")
            : String(localized: "License renews \(date)")
    }

    /// An INBOX commercial row's subtitle: the subject, the offer's title or
    /// the license's product, and the amount.
    static func inboxDetail(_ item: InboxCommercialItem) -> String {
        var what: String?
        var amount: String?
        if item.event == .offerExpiring, let offer = item.offer {
            what = offerTitle(offer)
            amount = offer.totalAmount.map { money($0, currency: offer.currency) }
        } else if let license = item.license {
            what = trimmed(license.product) ?? String(localized: "License")
            amount = license.amountEur.map { money($0, currency: "EUR") }
        }
        return [trimmed(item.subject.title), what, amount].compactMap { $0 }.joined(separator: " · ")
    }

    private static func trimmed(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }

    /// A wire status as a word: `in_review` reads "In review".
    private static func capitalised(_ status: String) -> String {
        let words = status.replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// The amount in its currency; a bare number when the currency is unknown.
    static func money(_ amount: Double, currency: String?) -> String {
        let locale = StarlingsDateFormatting.locale
        guard let code = trimmed(currency)?.uppercased() else { return amount.formatted(.number.locale(locale)) }
        return amount.formatted(.currency(code: code).locale(locale))
    }
}

extension CrmTeamMember: Identifiable {
    var shortName: String {
        name.split(separator: " ").first.map(String.init) ?? name
    }
}

/// The generated `CrmTaskUpdate`, from the app's own values. A `Patch`
/// field says three things: `.omit` leaves it alone, `.null` hands the task
/// back to nobody or takes the date off, `.value` sets it.
extension CrmTaskUpdate {
    init(
        title: String?,
        notes: String?,
        status: String?,
        responsibleParty: String?,
        assignedTo: Patch<String> = .omit,
        dueDate: Patch<String> = .omit,
        goalID: Patch<String> = .omit
    ) {
        self.init(
            title: title,
            notes: .ifSome(notes),
            status: status.map(CrmTaskStatusValue.init(rawValue:)),
            responsibleParty: responsibleParty.map(CrmResponsiblePartyValue.init(rawValue:)),
            assignedTo: assignedTo,
            dueDate: dueDate,
            goalID: goalID
        )
    }

    /// Answer a Core-proposed task: accept → pending, decline →
    /// declined (kept, so the event cannot propose it again).
    static func proposalDecision(accepted: Bool) -> CrmTaskUpdate {
        CrmTaskUpdate(status: (accepted ? CrmTaskStatus.pending : .declined).wire)
    }

    /// Move to…: the one subject the task goes onto, and where it
    /// was, so the Worker drops that list from its cache.
    static func move(_ task: CrmTask, to destination: CrmTaskSubjectRef) -> CrmTaskUpdate {
        var update = CrmTaskUpdate(movedFrom: CrmTaskSubjectRef(task: task)?.wire)
        switch destination.kind {
        case .project: update.projectID = .value(destination.id)
        case .lead: update.leadID = .value(destination.id)
        case .event: update.eventID = .value(destination.id)
        case .organization: update.organizationID = .value(destination.id)
        case .meeting: update.meetingID = .value(destination.id)
        }
        return update
    }

    /// A completion toggle only changes status.
    static func completion(_ done: Bool) -> CrmTaskUpdate {
        CrmTaskUpdate(status: (done ? CrmTaskStatus.completed : .pending).wire)
    }

    /// Cancel from a row menu: the task will not be done. Status only.
    static let cancellation = CrmTaskUpdate(status: CrmTaskStatus.cancelled.wire)

    /// Board moves use the same minimal status-only PATCH as a completion.
    static func stage(_ status: String) -> CrmTaskUpdate {
        CrmTaskUpdate(status: CrmTaskStatusValue(rawValue: status))
    }

    /// Assign to… from a row menu: the person, and Envisioning's side,
    /// since one of us now owes it.
    static func assignment(to member: CrmTeamMember) -> CrmTaskUpdate {
        CrmTaskUpdate(
            responsibleParty: CrmResponsiblePartyValue(rawValue: "team"),
            assignedTo: .value(member.id)
        )
    }
}

extension CrmIssueUpdate {
    /// Close or reopen from a row menu. State only; `projectID` lets the
    /// project's channel hear about it when the list is one project's.
    static func stateChange(_ change: WorkIssueStateChange, issue: CrmIssue, projectID: String?) -> CrmIssueUpdate {
        var update = CrmIssueUpdate(owner: issue.owner, repo: issue.repo, number: issue.number)
        update.projectID = projectID
        update.state = CrmIssueState(rawValue: change.state)
        update.stateReason = change.stateReason.map(CrmIssueUpdateStateReason.init(rawValue:))
        return update
    }

    /// A board move (`WorkItems.write`): the state, its reason and the whole
    /// label set, since GitHub replaces labels on PATCH. `projectID` names
    /// the project whose channel hears about the move.
    static func stageMove(
        _ issue: CrmIssue,
        projectID: String?,
        state: String,
        stateReason: String?,
        labels: [String]
    ) -> CrmIssueUpdate {
        var update = CrmIssueUpdate(owner: issue.owner, repo: issue.repo, number: issue.number)
        update.projectID = projectID
        update.state = CrmIssueState(rawValue: state)
        update.stateReason = stateReason.map(CrmIssueUpdateStateReason.init(rawValue:))
        update.labels = labels
        return update
    }

    /// Assign to… from a row menu: the teammate's login becomes the whole
    /// assignee set. Nil when GitHub does not know them.
    static func assignment(_ issue: CrmIssue, to member: CrmTeamMember) -> CrmIssueUpdate? {
        guard let login = member.githubLogin, !login.isEmpty else { return nil }
        var update = CrmIssueUpdate(owner: issue.owner, repo: issue.repo, number: issue.number)
        update.assignees = [login]
        return update
    }
}

extension CrmTaskStatus {
    /// What the app's status writes.
    var wire: CrmTaskStatusValue { CrmTaskStatusValue(rawValue: rawValue) }
}

extension CrmTaskResponsible {
    var wire: CrmResponsiblePartyValue { CrmResponsiblePartyValue(rawValue: rawValue) }

    /// What people read: the workspace's own side is the workspace's name
    ///; the others are the contract's words.
    var title: String { self == .team ? StarlingsWorkspace.active.name : menuTitle }
}

extension WorkSideFilter {
    /// What the Side menu reads: the team side is the workspace's name, as
    /// `CrmTaskResponsible.title` says it; the rest are the registry's.
    var label: String { self == .team ? StarlingsWorkspace.active.name : title }
}

/// One of the five places a task can be: the partner is the
/// organization, by its CRM id.
struct CrmTaskSubjectRef: Equatable, Sendable {
    enum Kind: String, Sendable { case project, lead, event, organization, meeting }
    let kind: Kind
    let id: String

    /// Where a task is now, from its own row; nil when Core gave it none.
    init?(task: CrmTask) {
        if let id = task.projectID { self.init(kind: .project, id: id) }
        else if let id = task.leadID { self.init(kind: .lead, id: id) }
        else if let id = task.eventID { self.init(kind: .event, id: id) }
        else if let id = task.partnerOrganizationID { self.init(kind: .organization, id: id) }
        else if let id = task.meetingID { self.init(kind: .meeting, id: id) }
        else { return nil }
    }

    init(kind: Kind, id: String) {
        self.kind = kind
        self.id = id
    }

    /// As `moved_from`: the one key set, the others absent.
    var wire: CrmTaskSubjectRefWire {
        switch kind {
        case .project: CrmTaskSubjectRefWire(projectID: .value(id))
        case .lead: CrmTaskSubjectRefWire(leadID: .value(id))
        case .event: CrmTaskSubjectRefWire(eventID: .value(id))
        case .organization: CrmTaskSubjectRefWire(organizationID: .value(id))
        case .meeting: CrmTaskSubjectRefWire(meetingID: .value(id))
        }
    }
}

/// The last event line naming a card, out of the Worker's `card_trace`
/// index: what happened to it last, and where in which channel that line
/// is, so the card's face can say it and open there. See docs/BOARD.md.
struct CardTrace: Decodable, Equatable, Sendable {
    let refKind: String
    let refID: String
    let threadID: String
    let messageID: String
    let text: String
    let at: Date

    init(wire: StarlingsContracts.CardTrace) {
        refKind = wire.refKind.rawValue
        refID = wire.refID
        threadID = wire.threadID
        messageID = wire.messageID
        text = wire.text
        at = Date(timeIntervalSince1970: TimeInterval(wire.at) / 1000)
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try StarlingsContracts.CardTrace(from: decoder))
    }
}

/// GET /api/crm/board — every open card on every subject, and this week's
/// finished ones, in one read. The client deals them into columns with
/// `WorkItems.board`; nothing here is staged.
struct CrmBoardResponse: Decodable, Sendable {
    let subjects: [CrmSubject]
    let tasks: [CrmTask]
    let issues: [CrmIssue]
    let traces: [CardTrace]
    /// Which project each issue was read for, by issue id — the wire issue
    /// names its repository, and a repository can serve several projects.
    let issueProjects: [String: String]
    /// Subjects whose work could not be read, by title.
    let partial: [String]
    /// The read's gaps, told apart: a failure and a cap hit.
    let gaps: WorkReadGaps
    let finishedSince: String?

    init(from decoder: Decoder) throws {
        let wire = try StarlingsContracts.CrmBoardResponse(from: decoder)
        subjects = wire.subjects.map(CrmSubject.init(wire:))
        tasks = wire.tasks.map(CrmTask.init(wire:))
        issues = wire.issues.map(CrmIssue.init(wire:))
        traces = wire.traces.map(CardTrace.init(wire:))
        issueProjects = wire.issueProjects
        partial = wire.partial
        gaps = WorkReadGaps(partial: wire.partial, truncated: wire.truncated, failed: wire.failed)
        finishedSince = wire.finishedSince
    }
}

extension CrmSubjectsQuery {
    /// What a client sends to browse subjects: the query trimmed and left out
    /// when blank, a status only for the kinds that have one (a partner is an
    /// organization and has none), the reader's day only for an event, whose
    /// one date is its status (docs/EVENTS.md). The Mac and iOS both build it
    /// here; the web builds the same in `subjectsSearchParams`, and
    /// `fixtures/subject-query.json` pins both.
    static func browse(
        kind: MeetingCategoryKind.SubjectKind,
        query: String,
        status: String? = nil,
        today: String? = nil,
        organizations: OrganizationListFilter? = nil,
        leadSource: String? = nil
    ) -> CrmSubjectsQuery {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedStatus = status?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let hasStatus = kind != .organization
        // An organization filter sends only what differs from the default.
        let filter = kind == .organization ? organizations?.wireValues : nil
        return CrmSubjectsQuery(
            kind: CrmSubjectKind(rawValue: kind.rawValue),
            q: trimmedQuery.isEmpty ? nil : trimmedQuery,
            status: hasStatus && !trimmedStatus.isEmpty ? trimmedStatus : nil,
            today: kind == .event ? today : nil,
            partner: filter?.partner,
            agency: filter?.agency,
            existingClient: filter?.existingClient,
            industry: filter?.industry,
            country: filter?.country,
            source: kind == .lead ? leadSource : nil
        )
    }
}
