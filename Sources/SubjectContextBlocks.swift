import Foundation

/// The blocks of a subject's context, and their order, decided once in
/// `packages/contracts/src/subject-context.ts`. The table is generated from it
/// (`pnpm registries:gen`); `fixtures/subject-context.json` is generated too and pins it
/// (`SubjectContextFixtureTests`).
///
/// The Mac draws them in the Work inspector, iOS above the groups of Subject
/// Overview. Labels and what a block says stay with each client; a block with
/// nothing to say draws nothing.
enum SubjectContextBlock: String, CaseIterable, Sendable {
    case team
    case agents
    case when
    case `where`
    case links
    case website
    case work
    case goals
    case relationship
    case about
    case email
}

enum SubjectContextClient: String, CaseIterable, Sendable {
    case mac
    case ios
    case web
}

enum SubjectContextRegistry {
    // `layout` and `notOn` are the table: Sources/Generated/SubjectContextRegistry.swift.

    /// The blocks one client draws for one kind, in order.
    static func blocks(for kind: MeetingCategoryKind.SubjectKind, client: SubjectContextClient) -> [SubjectContextBlock] {
        (layout[kind] ?? []).filter { !(notOn[$0]?.contains(client) ?? false) }
    }
}
