import Foundation

/// The status words a project or a lead can hold, and the choices built from
/// them, decided once in `packages/contracts/src/subject-status.ts`. The table
/// is generated from it (`pnpm registries:gen`); `fixtures/subject-status.json`
/// is generated too and pins it (`SubjectStatusFixtureTests`).
///
/// Core owns the words. Labels stay with each client (`CrmSubjectStatusOption`);
/// a status is a wire value and stays English on the wire. A partner and an
/// event have no status.
struct SubjectStatusChoices: Equatable, Sendable {
    /// Core's own words, in its order: the editor's dropdown.
    let statuses: [String]
    /// Where the subject is still work.
    let open: [String]
    /// Where the work is done: every status not in `open`. A closed lead
    /// (won or lost, ADR 0008 decision 10) leaves the default lists and Win.
    let closed: [String]
    /// Browse's status filter. `open` and `all` are product choices, not Core statuses.
    let filter: [String]
    /// What Browse opens on until the person picks another.
    let defaultFilter: String
    /// What a new subject starts as.
    let defaultStatus: String
}

enum SubjectStatusRegistry {
    // `project` and `lead` are the table: Sources/Generated/SubjectStatusRegistry.swift.

    /// Whether a project or lead is closed. An absent status reads as open.
    static func isClosed(kind: String, status: String?) -> Bool {
        guard let status, let kind = MeetingCategoryKind.SubjectKind(rawValue: kind), let choices = choices(for: kind) else { return false }
        return choices.closed.contains(status)
    }

    /// Nil for a partner and an event.
    static func choices(for kind: MeetingCategoryKind.SubjectKind) -> SubjectStatusChoices? {
        switch kind {
        case .project: project
        case .lead: lead
        case .organization, .event: nil
        }
    }
}
