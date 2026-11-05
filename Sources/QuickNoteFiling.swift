import AppKit
import DocsKit

/// The one filing path for a Quick Note on the Mac: open the triage sheet,
/// make the thing the owner chose, then point the note at it. Home's card
/// and Work's rail both come here, so a note files the same way wherever it
/// was clicked.
///
/// Two writes, in that order: a note that says "filed" with nothing behind
/// it is a lie, and a task with a note still open beside it is only untidy —
/// and the Worker accepts the same promotion twice, so the second write can
/// be retried.
@MainActor
enum QuickNoteFiling {
    static func present(
        over window: NSWindow?,
        note: QuickNote,
        api: MeetingControlAPI,
        docs: DocsSession,
        onFiled: @escaping (QuickNote, QuickNotePromotionKind) -> Void
    ) {
        QuickNoteTriage.present(
            over: window,
            note: note,
            load: { try await options(api: api, docs: docs) },
            searchSubjects: { query, projectsOnly in
                try await searchSubjects(query: query, projectsOnly: projectsOnly, api: api)
            },
            onFile: filer(for: note, api: api, docs: docs, onFiled: onFiled)
        )
    }

    /// The same form, for a column to host instead of a sheet: Work's
    /// inspector, where a note opens like a task or an issue. `onClose` is
    /// Cancel, or a filing that landed.
    static func panel(
        note: QuickNote,
        api: MeetingControlAPI,
        docs: DocsSession,
        onFiled: @escaping (QuickNote, QuickNotePromotionKind) -> Void,
        onClose: @escaping () -> Void
    ) -> NSViewController {
        QuickNoteTriage.panel(
            note: note,
            load: { try await options(api: api, docs: docs) },
            searchSubjects: { query, projectsOnly in
                try await searchSubjects(query: query, projectsOnly: projectsOnly, api: api)
            },
            onFile: filer(for: note, api: api, docs: docs, onFiled: onFiled),
            onClose: onClose
        )
    }

    private static func options(api: MeetingControlAPI, docs: DocsSession) async throws -> QuickNoteTriage.Options {
        let owner = api.signedInOwnerEmail
        if let owner, let cached = QuickNoteDestinationOptionsCache.shared.load(owner: owner) {
            return QuickNoteTriage.Options(
                subjects: cached.subjects,
                starred: cached.starred,
                threads: cached.threads,
                projectsHaveMore: cached.projectsHaveMore,
                leadsHaveMore: cached.leadsHaveMore,
                partnersHaveMore: cached.partnersHaveMore,
                canFileDocument: docs.isLinked
            )
        }
        async let projects = api.crmSubjectPage(kind: .project, query: "")
        async let leads = api.crmSubjectPage(kind: .lead, query: "")
        async let partners = api.crmSubjectPage(kind: .organization, query: "")
        async let threads = api.threads()
        async let state = api.crmSubjectState()
        // Starred first, alphabetical within; the star is a hint,
        // so a failed read leaves the list plain rather than empty.
        let starred = Set((try? await state)?.states.filter(\.starred).map(\.subjectKey) ?? [])
        let pages = try await (projects, leads, partners)
        let subjects = (pages.0.subjects + pages.1.subjects + pages.2.subjects).sorted {
            let (a, b) = (starred.contains($0.stateKey), starred.contains($1.stateKey))
            if a != b { return a }
            return $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
        }
        let conversations = try await threads
        if let owner {
            QuickNoteDestinationOptionsCache.shared.store(
                QuickNoteDestinationOptions(
                    subjects: subjects,
                    starred: starred,
                    threads: conversations,
                    projectsHaveMore: pages.0.hasMore,
                    leadsHaveMore: pages.1.hasMore,
                    partnersHaveMore: pages.2.hasMore
                ),
                owner: owner
            )
        }
        return QuickNoteTriage.Options(
            subjects: subjects,
            starred: starred,
            threads: conversations,
            projectsHaveMore: pages.0.hasMore,
            leadsHaveMore: pages.1.hasMore,
            partnersHaveMore: pages.2.hasMore,
            canFileDocument: docs.isLinked
        )
    }

    private static func searchSubjects(
        query: String,
        projectsOnly: Bool,
        api: MeetingControlAPI
    ) async throws -> [CrmSubject] {
        let owner = api.signedInOwnerEmail
        if let owner,
           let cached = QuickNoteDestinationOptionsCache.shared.loadSearch(owner: owner, query: query, projectsOnly: projectsOnly) {
            return cached
        }
        let projects = try await api.crmSubjectPage(kind: .project, query: query)
        let subjects: [CrmSubject]
        if projectsOnly {
            subjects = projects.subjects
        } else {
            async let leads = api.crmSubjectPage(kind: .lead, query: query)
            async let partners = api.crmSubjectPage(kind: .organization, query: query)
            subjects = projects.subjects + (try await leads).subjects + (try await partners).subjects
        }
        if let owner {
            QuickNoteDestinationOptionsCache.shared.storeSearch(
                subjects,
                owner: owner,
                query: query,
                projectsOnly: projectsOnly
            )
        }
        return subjects
    }

    private static func filer(
        for note: QuickNote,
        api: MeetingControlAPI,
        docs: DocsSession,
        onFiled: @escaping (QuickNote, QuickNotePromotionKind) -> Void
    ) -> (QuickNoteTriage.Choice, @escaping (String?) -> Void) -> Void {
        { choice, completion in
            Task {
                do {
                    let promote = try await make(choice, for: note, api: api, docs: docs)
                    let filed = try await api.promoteQuickNote(id: note.id, promote)
                    completion(nil)
                    onFiled(filed, promote.kind)
                } catch {
                    completion((error as? StarlingsError)?.message ?? error.localizedDescription)
                }
            }
        }
    }

    private static func make(
        _ choice: QuickNoteTriage.Choice,
        for note: QuickNote,
        api: MeetingControlAPI,
        docs: DocsSession
    ) async throws -> QuickNotePromote {
        switch choice {
        case .task(let subject, let title):
            let task = try await api.createCrmTask(CrmTaskCreate(
                title: title,
                notes: note.body == title ? nil : note.body,
                status: "pending",
                // No assignee: a filed note is the filer's task.
                responsibleParty: "team",
                dueDate: nil,
                projectID: subject.kind == "project" ? subject.id : nil,
                leadID: subject.kind == "lead" ? subject.id : nil,
                organizationID: subject.kind == "organization" ? subject.id : nil
            ))
            return QuickNotePromote(kind: .task, id: task.id)
        case .issue(let project, let title):
            let issue = try await api.createCrmIssue(CrmIssueCreate(
                projectID: project.id,
                title: title,
                body: note.body
            ))
            return QuickNotePromote(kind: .issue, id: issue.id)
        case .message(let thread):
            let message = try await api.sendMessage(threadID: thread.id, text: note.body)
            return QuickNotePromote(kind: .message, id: message.id)
        case .doc(let title):
            let created = try await docs.client.create(DocsCreateDocument(
                title: title,
                folderPath: "/work",
                bodyMd: note.body,
                message: String(localized: "Filed from a Quick Note")
            ))
            return QuickNotePromote(kind: .doc, id: created.id)
        }
    }
}
