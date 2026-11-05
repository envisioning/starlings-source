import Foundation
import StarlingsContracts

/// The compact filter shared by the Mac, iOS and web interaction readers.
/// `all` is the default because the history is the object; filtering is a
/// temporary way of finding a kind inside it.
enum CrmInteractionFilter: String, CaseIterable, Identifiable, Sendable {
    case all
    case meeting
    case email
    case call
    case web
    case note

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: String(localized: "All types")
        case .meeting: String(localized: "Meetings")
        case .email: String(localized: "Emails")
        case .call: String(localized: "Calls")
        case .web: String(localized: "Web")
        case .note: String(localized: "Notes")
        }
    }

    func matches(_ interaction: CrmInteraction) -> Bool {
        self == .all || rawValue == interaction.type.rawValue
    }
}

extension CrmInteraction: Identifiable {
    var date: Date? {
        let value = [occurredAt, createdAt]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? ""
        return ISODate.parse(value)
    }

    /// Titles and compact previews are authored as Markdown by Core, but the
    /// list is not a Markdown editor. Keep source marks out of its hierarchy.
    var displayTitle: String {
        let cleaned = ThreadMarkdown.plainText(title).trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? String(localized: "Untitled interaction") : cleaned
    }

    var typeLabel: String { Self.typeLabel(forType: type.rawValue) }

    static func typeLabel(forType type: String) -> String {
        switch type {
        case "meeting": String(localized: "Meeting")
        case "email": String(localized: "Email")
        case "call": String(localized: "Call")
        case "web": String(localized: "Web")
        default: String(localized: "Note")
        }
    }

    var metadataLabel: String {
        // A project's History carries the lead it was won from (ADR 0008).
        var parts = fromLead == true ? [String(localized: "From the lead"), typeLabel] : [typeLabel]
        if let date { parts.append(date.meetDateTimeString(dateStyle: .abbreviated)) }
        if let durationMinutes { parts.append(String(localized: "\(durationMinutes) min")) }
        if let peopleLabel { parts.append(peopleLabel) }
        if let status, !status.isEmpty { parts.append(status.capitalized) }
        return parts.joined(separator: " · ")
    }

    var symbolName: String { Self.symbolName(forType: type.rawValue) }

    /// Shared with INBOX's RECENT tail, which carries the type and not the row.
    static func symbolName(forType type: String) -> String {
        switch type {
        case "meeting": "video.fill"
        case "email": "envelope.fill"
        case "call": "phone.fill"
        case "web": "globe"
        default: "pencil"
        }
    }

    var preview: String? { rawPreview.map(ThreadMarkdown.plainText) }

    /// The source retained for a full reader. Compact rows use `preview`, so
    /// they never expose Markdown syntax; readers may render this value.
    var rawPreview: String? {
        [summaryPreview, transcriptPreview]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
    }

    /// What a reader draws: the whole summary when Core sent it, else the
    /// same one-line preview the row shows. Markdown; render, do not label.
    var readerBody: String? {
        if let summaryMarkdown = summaryMarkdown?.trimmingCharacters(in: .whitespacesAndNewlines),
           !summaryMarkdown.isEmpty {
            return summaryMarkdown
        }
        return rawPreview
    }

    var previewLabel: String {
        if let summaryPreview, !summaryPreview.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return String(localized: "Summary")
        }
        return String(localized: "Transcript preview")
    }

    var accessibilityLabel: String {
        var parts = [typeLabel, displayTitle]
        if let date { parts.append(date.meetDateTimeString(dateStyle: .abbreviated)) }
        if let peopleLabel { parts.append(String(localized: "with \(peopleLabel)")) }
        if let status, !status.isEmpty { parts.append(status.capitalized) }
        return parts.joined(separator: ", ") + ". Open interaction."
    }

    var peopleLabel: String? {
        let names = contacts.compactMap { contact -> String? in
            let name = contact.name?.trimmingCharacters(in: .whitespacesAndNewlines)
            return name?.isEmpty == false ? name : contact.email
        }
        guard !names.isEmpty else { return nil }
        let shown = names.prefix(3).joined(separator: ", ")
        return names.count > 3 ? "\(shown) +\(names.count - 3)" : shown
    }
}

/// A call, meeting or note logged by hand on a subject's History
///: the editor's fields on the Mac and the phone, and the two
/// writes they become. The relations carry names so a picker can draw them;
/// an id nobody has named yet draws as itself until the client resolves it.
struct CrmInteractionDraft: Identifiable {
    /// The kinds a member logs by hand (`CRM_INTERACTION_MANUAL_TYPES`).
    static let loggableTypes: [CrmInteractionType] = [.call, .meeting, .note]

    /// The row being edited. Nil on a new one.
    let original: CrmInteraction?
    var type: CrmInteractionType
    var title: String
    var occurredAt: Date
    var summary: String
    var url: String
    var organization: SubjectRelationOption?
    var lead: SubjectRelationOption?
    var project: SubjectRelationOption?
    var contacts: [SubjectRelationOption]

    var id: String { original?.id ?? "new" }
    var isNew: Bool { original == nil }

    /// A new one, filed where the History is: a project fills its project
    /// and its organization, a lead its lead and organization, an
    /// organization itself.
    init(subject: CrmSubject?, now: Date = Date()) {
        original = nil
        type = .call
        title = ""
        occurredAt = now
        summary = ""
        url = ""
        contacts = []
        organization = nil
        lead = nil
        project = nil
        guard let subject else { return }
        let own = SubjectRelationOption(id: subject.id, name: subject.title)
        let parent = subject.organizationID.flatMap { id -> SubjectRelationOption? in
            id.isEmpty ? nil : SubjectRelationOption(id: id, name: subject.organizationName ?? id)
        }
        switch subject.subjectKind {
        case .project: project = own; organization = parent
        case .lead: lead = own; organization = parent
        case .organization: organization = own
        case .event: break
        }
    }

    /// The row as it is. Names come from the subject the History is on where
    /// the ids match; the rest are ids until resolved.
    init(editing interaction: CrmInteraction, subject: CrmSubject? = nil) {
        original = interaction
        type = interaction.type
        title = ThreadMarkdown.plainText(interaction.title).trimmingCharacters(in: .whitespacesAndNewlines)
        occurredAt = interaction.date ?? Date()
        summary = interaction.summaryMarkdown ?? ""
        url = interaction.url ?? ""
        func named(_ id: String?) -> SubjectRelationOption? {
            guard let id, !id.isEmpty else { return nil }
            if let subject, subject.id == id { return SubjectRelationOption(id: id, name: subject.title) }
            if let subject, subject.organizationID == id, let name = subject.organizationName {
                return SubjectRelationOption(id: id, name: name)
            }
            return SubjectRelationOption(id: id, name: id)
        }
        organization = named(interaction.organizationID)
        lead = named(interaction.leadID)
        project = named(interaction.projectID)
        contacts = interaction.contacts.map { contact in
            let name = contact.name?.trimmingCharacters(in: .whitespacesAndNewlines)
            return SubjectRelationOption(id: contact.id, name: name?.isEmpty == false ? name! : (contact.email ?? contact.id))
        }
    }

    /// Call, Meeting, Note, plus the row's own kind when a connector filed it
    /// (an email stays an email unless the edit names another).
    var typeOptions: [CrmInteractionType] {
        guard let own = original?.type, !Self.loggableTypes.contains(own) else { return Self.loggableTypes }
        return Self.loggableTypes + [own]
    }

    /// The relations whose name is still the id, by kind, for the client to
    /// read once and replace.
    var unnamedLinks: [(kind: MeetingCategoryKind.SubjectKind, id: String)] {
        let links: [(MeetingCategoryKind.SubjectKind, SubjectRelationOption?)] = [
            (.organization, organization), (.lead, lead), (.project, project),
        ]
        return links.compactMap { kind, option in
            guard let option, option.name == option.id else { return nil }
            return (kind: kind, id: option.id)
        }
    }

    /// Put a resolved name in place of its id.
    mutating func name(_ kind: MeetingCategoryKind.SubjectKind, id: String, as name: String) {
        let option = SubjectRelationOption(id: id, name: name)
        switch kind {
        case .organization: if organization?.id == id { organization = option }
        case .lead: if lead?.id == id { lead = option }
        case .project: if project?.id == id { project = option }
        case .event: break
        }
    }

    private static func trimmed(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func nonEmpty(_ value: String) -> String? {
        let value = trimmed(value)
        return value.isEmpty ? nil : value
    }

    /// Empty, or an http(s) address: the Worker refuses anything else.
    var hasValidLink: Bool {
        guard let link = Self.nonEmpty(url) else { return true }
        let lowered = link.lowercased()
        return (lowered.hasPrefix("http://") || lowered.hasPrefix("https://")) && URL(string: link)?.host != nil
    }

    /// A title, somewhere to file it, and a link the Worker takes.
    var canSave: Bool {
        !Self.trimmed(title).isEmpty
            && (organization != nil || lead != nil || project != nil)
            && hasValidLink
    }

    var create: CrmInteractionCreate {
        CrmInteractionCreate(
            type: CrmInteractionCreateType(rawValue: type.rawValue),
            title: Self.trimmed(title),
            occurredAt: ISODate.format(occurredAt),
            summaryMarkdown: .ifSome(Self.nonEmpty(summary)),
            url: .ifSome(Self.nonEmpty(url)),
            organizationID: .ifSome(organization?.id),
            leadID: .ifSome(lead?.id),
            projectID: .ifSome(project?.id),
            contactIDs: contacts.map(\.id)
        )
    }

    /// Only what changed against the row as it was opened. A summary Core
    /// sent only as a preview is not sent back, so an untouched field never
    /// clears it.
    var update: CrmInteractionUpdate {
        let before = original.map { CrmInteractionDraft(editing: $0) }
        func changed<T: Equatable>(_ now: T, _ was: T?) -> Bool { before == nil || now != was }
        let summaryNow = Self.nonEmpty(summary)
        let urlNow = Self.nonEmpty(url)
        return CrmInteractionUpdate(
            type: changed(type, before?.type) ? type : nil,
            title: changed(Self.trimmed(title), before.map { Self.trimmed($0.title) }) ? Self.trimmed(title) : nil,
            occurredAt: changed(occurredAt, before?.occurredAt) ? ISODate.format(occurredAt) : nil,
            summaryMarkdown: changed(summaryNow, before.map { Self.nonEmpty($0.summary) }) ? Patch(summaryNow) : .omit,
            url: changed(urlNow, before.map { Self.nonEmpty($0.url) }) ? Patch(urlNow) : .omit,
            organizationID: changed(organization?.id, before.map { $0.organization?.id }) ? Patch(organization?.id) : .omit,
            leadID: changed(lead?.id, before.map { $0.lead?.id }) ? Patch(lead?.id) : .omit,
            projectID: changed(project?.id, before.map { $0.project?.id }) ? Patch(project?.id) : .omit,
            contactIDs: changed(contacts.map(\.id), before.map { $0.contacts.map(\.id) }) ? contacts.map(\.id) : nil
        )
    }
}

extension CrmInteractionType {
    /// The editor's word for the kind: Call, Meeting, Note, Email, Web.
    var editorTitle: String { CrmInteraction.typeLabel(forType: rawValue) }
}
