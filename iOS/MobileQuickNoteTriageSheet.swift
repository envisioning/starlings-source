import DocsKit
import SwiftUI

/// Work's triage sheet for one Quick Note: where does this go?
///
/// Four destinations, one form. Task and Issue need a subject (Meet's
/// exactly-one-subject invariant), Message needs a conversation, Doc needs
/// only a title. The form shows what the chosen destination needs and
/// nothing else. Make the thing first, then point the note at it: the Worker
/// accepts the same promotion twice, so a lost second write can be retried
/// without making a second task.
struct MobileQuickNoteTriageSheet: View {
    let note: QuickNote

    @EnvironmentObject private var app: StarlingsAppModel
    @EnvironmentObject private var notes: MobileQuickNotesStore
    @EnvironmentObject private var docs: DocsSession
    @Environment(\.dismiss) private var dismiss

    @State private var kind: QuickNotePromotionKind = .task
    @State private var subjects: [CrmSubject] = []
    /// `stateKey`s of the subjects this person starred; they list first.
    @State private var starred: Set<String> = []
    @State private var threads: [ThreadSummary] = []
    @State private var destinationOptions: QuickNoteDestinationOptions?
    @State private var subjectID = ""
    @State private var threadID = ""
    @State private var title = ""
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var kinds: [QuickNotePromotionKind] {
        [.task, .issue, .message] + (docs.isLinked ? [.doc] : [])
    }

    private var needsSubject: Bool { kind == .task || kind == .issue }
    private var needsTitle: Bool { kind != .message }

    private var offeredSubjects: [StarlingsSearchablePickerOption] {
        // Built here, not by the shared options type: it labels anything that
        // is not a project "Lead", and a partner is neither.
        subjects
            .filter { kind != .issue || $0.kind == "project" }
            .map(subjectPickerOption)
    }

    private var canSearchCurrentSubjects: Bool {
        kind == .issue ? destinationOptions?.projectsHaveMore == true : destinationOptions?.subjectsHaveMore == true
    }

    private var chosenSubject: CrmSubject? {
        subjects.first { "\($0.kind):\($0.id)" == subjectID }
    }

    private var canFile: Bool {
        guard !isSaving, !isLoading else { return false }
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        switch kind {
        case .task, .issue: return !subjectID.isEmpty && !cleanTitle.isEmpty
        case .message: return !threadID.isEmpty
        case .doc: return !cleanTitle.isEmpty
        case .retainedNote: return false
        }
    }

    var body: some View {
        NavigationStack {
            StarlingsForm {
                Section {
                    Text(note.body)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .meetLineLimit(6)
                }

                Section {
                    Picker("Destination", selection: $kind) {
                        ForEach(kinds, id: \.self) { kind in
                            Text(Self.segmentLabel(kind)).tag(kind)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .accessibilityLabel("Destination")
                    // The selector is its own control, not a row: no Panel
                    // around it, and the full width of the form.
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }

                if needsSubject {
                    Section(kind == .issue ? String(localized: "File under (project)") : String(localized: "File under")) {
                        StarlingsSearchablePicker(
                            label: String(localized: "Subject"),
                            placeholder: isLoading
                                ? String(localized: "Loading…")
                                : kind == .issue
                                    ? String(localized: "Choose a project")
                                    : String(localized: "Choose a project, lead or partner"),
                            options: offeredSubjects,
                            selection: $subjectID,
                            emptyMessage: String(localized: "No destinations match that search."),
                            search: canSearchCurrentSubjects ? { query in
                                await searchSubjectOptions(query, projectsOnly: kind == .issue)
                            } : nil
                        )
                        .disabled(isLoading || (offeredSubjects.isEmpty && !canSearchCurrentSubjects))
                    }
                }

                if kind == .message {
                    Section("Send to") {
                        StarlingsSearchablePicker(
                            label: String(localized: "Conversation"),
                            placeholder: isLoading ? String(localized: "Loading…") : String(localized: "Choose a conversation"),
                            options: destinationOptions?.threadOptions ?? [],
                            selection: $threadID,
                            emptyMessage: String(localized: "No conversations match that search.")
                        )
                        .disabled(isLoading || threads.isEmpty)
                    }
                }

                if needsTitle {
                    Section(titleCaption) {
                        TextField("Title", text: $title)
                    }
                }

                if let errorMessage {
                    Section {
                        StarlingsErrorNotice(message: errorMessage)
                    }
                }
            }
            .disabled(isSaving)
            .navigationTitle("File Quick Note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? String(localized: "Filing…") : actionTitle) { Task { await file() } }
                        .disabled(!canFile)
                        .meetToolbarConfirm()
                }
            }
            .onChange(of: kind) { _, _ in
                subjectID = ""
                threadID = ""
            }
            .meetHaptic(.error, whenSet: errorMessage)
            .task { await load() }
        }
        .onAppear {
            title = note.firstLine
        }
    }

    private var titleCaption: String { kind.triageTitleCaption }

    private var actionTitle: String { kind.triageAction }

    /// The words are `QUICK_NOTE_TRIAGE` (Generated/QuickNoteValuesRegistry.swift).
    private static func segmentLabel(_ kind: QuickNotePromotionKind) -> String {
        kind.triageLabel
    }

    private func load() async {
        guard app.ownerCredentials != nil else {
            isLoading = false
            return
        }
        isLoading = true
        defer { isLoading = false }
        do {
            guard let options = try await notes.loadFilingOptions() else { return }
            destinationOptions = options
            subjects = options.subjects
            starred = options.starred
            threads = options.threads
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func searchSubjectOptions(_ query: String, projectsOnly: Bool) async -> [StarlingsSearchablePickerOption] {
        guard let credentials = app.ownerCredentials else { return [] }
        let owner = credentials.owner.email
        if let cached = QuickNoteDestinationOptionsCache.shared.loadSearch(
            owner: owner,
            query: query,
            projectsOnly: projectsOnly
        ) {
            return cached.map(subjectPickerOption)
        }
        let projectRows: [CrmSubject]
        let leads: [CrmSubject]
        do {
            if projectsOnly {
                projectRows = try await app.api.crmSubjectPage(credentials: credentials, kind: .project, query: query).subjects
                leads = []
            } else {
                async let projectPage = app.api.crmSubjectPage(credentials: credentials, kind: .project, query: query)
                async let leadPage = app.api.crmSubjectPage(credentials: credentials, kind: .lead, query: query)
                // A partner takes a task by its organization; a failed
                // partner page must not blank the projects and leads.
                async let partnerPage = try? app.api.crmSubjectPage(credentials: credentials, kind: .organization, query: query)
                let pages = try await (projectPage, leadPage)
                projectRows = pages.0.subjects
                leads = pages.1.subjects + (await partnerPage?.subjects ?? [])
            }
        } catch {
            return []
        }
        guard let currentOwner = app.ownerCredentials?.owner.email,
              currentOwner.caseInsensitiveCompare(owner) == .orderedSame else { return [] }
        let stars = destinationOptions?.starred ?? starred
        let results = (projectRows + leads)
            .sorted { left, right in
                let (a, b) = (stars.contains(left.stateKey), stars.contains(right.stateKey))
                if a != b { return a }
                return left.title.localizedCaseInsensitiveCompare(right.title) == .orderedAscending
            }
        var byID = Dictionary(subjects.map { ("\($0.kind):\($0.id)", $0) }, uniquingKeysWith: { first, _ in first })
        for subject in results { byID["\(subject.kind):\(subject.id)"] = subject }
        subjects = Array(byID.values).sorted { left, right in
            let (a, b) = (stars.contains(left.stateKey), stars.contains(right.stateKey))
            if a != b { return a }
            return left.title.localizedCaseInsensitiveCompare(right.title) == .orderedAscending
        }
        if var destinationOptions {
            destinationOptions.subjects = subjects
            self.destinationOptions = destinationOptions
        }
        QuickNoteDestinationOptionsCache.shared.storeSearch(results, owner: owner, query: query, projectsOnly: projectsOnly)
        return results.map(subjectPickerOption)
    }

    private func subjectPickerOption(_ subject: CrmSubject) -> StarlingsSearchablePickerOption {
        let stars = destinationOptions?.starred ?? starred
        return StarlingsSearchablePickerOption(
            id: "\(subject.kind):\(subject.id)",
            title: subject.title,
            context: subject.kind == "project" ? String(localized: "Project")
                : subject.isPartner ? String(localized: "Partner") : String(localized: "Lead"),
            subtitle: subject.subtitle,
            isStarred: stars.contains(subject.stateKey)
        )
    }

    private func file() async {
        guard canFile, let credentials = app.ownerCredentials else { return }
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        isSaving = true
        defer { isSaving = false }
        do {
            // Before the task, issue, message or document is made: a note
            // still on this phone cannot be pointed at it.
            try await notes.ensureSent(note)
            let promote: QuickNotePromote
            switch kind {
            case .task:
                guard let subject = chosenSubject else { return }
                let task = try await app.api.createCrmTask(credentials: credentials, CrmTaskCreate(
                    title: cleanTitle,
                    notes: note.body == cleanTitle ? nil : note.body,
                    status: "pending",
                    // No assignee: a filed note is the filer's task.
                    responsibleParty: "team",
                    dueDate: nil,
                    projectID: subject.kind == "project" ? subject.id : nil,
                    leadID: subject.kind == "lead" ? subject.id : nil,
                    organizationID: subject.isPartner ? subject.id : nil
                ))
                promote = QuickNotePromote(kind: .task, id: task.id)
            case .issue:
                guard let subject = chosenSubject else { return }
                let issue = try await app.api.createCrmIssue(credentials: credentials, CrmIssueCreate(
                    projectID: subject.id,
                    title: cleanTitle,
                    body: note.body
                ))
                promote = QuickNotePromote(kind: .issue, id: issue.id)
            case .message:
                let message = try await app.api.sendMessage(credentials: credentials, threadID: threadID, text: note.body)
                promote = QuickNotePromote(kind: .message, id: message.id)
            case .doc:
                let created = try await docs.client.create(DocsCreateDocument(
                    title: cleanTitle,
                    folderPath: "/work",
                    bodyMd: note.body,
                    message: String(localized: "Filed from a Quick Note")
                ))
                promote = QuickNotePromote(kind: .doc, id: created.id)
            case .retainedNote:
                return
            }
            try await notes.promote(note, promote)
            errorMessage = nil
            // Played directly: the sheet is gone before a trigger could fire.
            StarlingsHaptics.success.play()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
