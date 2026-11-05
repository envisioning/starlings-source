import SwiftUI
import CoreKit

struct MobileSubjectEditorTarget: Identifiable {
    /// What a *new* subject's sheet opens with when something else already
    /// knows part of the answer — "Start a lead" from the Sales inbox. The
    /// ids ride onto the created lead; the names are in `notes` for the reader.
    struct Prefill {
        var title: String
        var notes: String
        var organizationID: String?
        var contactID: String?
    }

    let id: String
    let kind: MeetingCategoryKind.SubjectKind
    let subject: CrmSubject?
    let prefill: Prefill?

    init(kind: MeetingCategoryKind.SubjectKind, subject: CrmSubject? = nil, prefill: Prefill? = nil) {
        self.kind = kind
        self.subject = subject
        self.prefill = prefill
        id = subject.map { "\($0.kind)-\($0.id)" } ?? "new-\(kind.rawValue)-\(UUID().uuidString)"
    }
}

extension MeetingCategoryKind.SubjectKind {
    var editorTitle: String { rawValue == "project" ? String(localized: "Project") : String(localized: "Lead") }

    /// What a new subject starts as: a wire value, never the localized word.
    var defaultStatus: String { SubjectStatusRegistry.choices(for: self)?.defaultStatus ?? "" }
}

/// The focused Meet editor for the fields people can reasonably maintain in a
/// meeting workflow. The Worker validates and stores the result. Contacts are
/// a typeahead over the workspace's contacts through the Worker
/// (`MobileRelationPicker`).
struct MobileSubjectEditorView: View {
    let target: MobileSubjectEditorTarget
    let onSaved: (CrmSubjectDetail) -> Void

    @EnvironmentObject private var app: StarlingsAppModel
    /// For the signed-in person's role: an admin gets Upgrade at the plan limit.
    @EnvironmentObject private var work: MobileMyWorkStore
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var status: String
    @State private var startDate: Date
    @State private var hasStartDate: Bool
    @State private var endDate: Date
    @State private var hasEndDate: Bool
    @State private var description: String
    @State private var url: String
    @State private var notes: String
    /// The lead's characteristics as read; the five qualification checks change in it, the rest stay.
    @State private var characteristics: [String: Bool] = [:]
    @State private var isLoading = false
    @State private var isSaving = false
    @State private var errorMessage: String?
    /// The plan's limit or read-only line, in place of an error.
    @State private var planMessage: String?
    @State private var organization: [SubjectRelationOption]
    @State private var contacts: [SubjectRelationOption] = []
    @State private var repos: [CrmGithubRepo] = []
    @State private var showsRepoPicker = false

    /// This kind's captions and rules, from `FormFieldRegistry`.
    private var fields: SubjectFormFields { SubjectFormFields(target.kind) }

    init(target: MobileSubjectEditorTarget, onSaved: @escaping (CrmSubjectDetail) -> Void) {
        self.target = target
        self.onSaved = onSaved
        let summary = target.subject
        _title = State(initialValue: summary?.title ?? target.prefill?.title ?? "")
        _status = State(initialValue: target.kind.defaultStatus)
        _startDate = State(initialValue: .now)
        _hasStartDate = State(initialValue: target.kind == .lead)
        _endDate = State(initialValue: .now)
        _hasEndDate = State(initialValue: false)
        _description = State(initialValue: "")
        _url = State(initialValue: "")
        _notes = State(initialValue: target.prefill?.notes ?? "")
        let organizationID = summary?.organizationID ?? target.prefill?.organizationID
        let organizationName = summary?.organizationName ?? organizationID
        _organization = State(initialValue: organizationID.map {
            [SubjectRelationOption(id: $0, name: organizationName ?? $0)]
        } ?? [])
    }

    var body: some View {
        NavigationStack {
            StarlingsForm {
                Section {
                    TextField(fields.title.caption, text: $title)
                        .textInputAutocapitalization(.sentences)
                    Picker(fields.status.caption, selection: $status) {
                        ForEach(CrmSubjectStatusOption.editable(for: target.kind)) { option in
                            Text(option.title).tag(option.id)
                        }
                    }
                } header: {
                    Text(target.subject == nil ? String(localized: "New \(target.kind.editorTitle)") : String(localized: "Edit \(target.kind.editorTitle)"))
                }

                Section("Dates") {
                    if target.kind == .lead {
                        DatePicker(fields.startDate.caption, selection: $startDate, displayedComponents: .date)
                    } else {
                        Toggle("Has a start date", isOn: $hasStartDate)
                            .meetToggleTint()
                        if hasStartDate {
                            DatePicker(fields.startDate.caption, selection: $startDate, displayedComponents: .date)
                        }
                        Toggle("Has an end date", isOn: $hasEndDate)
                            .meetToggleTint()
                        if hasEndDate {
                            DatePicker(FormFieldRegistry.project.endDate.caption, selection: $endDate, displayedComponents: .date)
                        }
                    }
                }

                if target.kind == .lead {
                    Section {
                        ForEach(LeadQualification.checks) { check in
                            Toggle(check.title, isOn: Binding(
                                get: { LeadQualification.isSet(check.key, in: characteristics) },
                                set: { characteristics = LeadQualification.merged(characteristics, key: check.key, value: $0) }
                            ))
                            .meetToggleTint()
                        }
                    } header: {
                        Text(FormFieldRegistry.lead.characteristics.caption)
                    } footer: {
                        Text(LeadQualification.summary(characteristics))
                    }
                }

                if target.kind == .project || target.kind == .lead {
                    Section(fields.organization.caption) {
                        MobileRelationPicker(
                            placeholder: String(localized: "Search organizations"),
                            emptyText: String(localized: "No organizations match"),
                            allowsMultiple: false,
                            search: organizationSearch,
                            create: organizationCreate,
                            selected: $organization
                        )
                    }
                }

                if target.kind == .project {
                    Section {
                        TextField(FormFieldRegistry.project.url.caption, text: $url)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextEditor(text: $description)
                            .frame(minHeight: 96)
                            .overlay(alignment: .topLeading) {
                                if description.isEmpty {
                                    Text(fields.text.caption)
                                        .foregroundStyle(.secondary)
                                        .padding(.top, 8)
                                        .padding(.leading, 5)
                                        .allowsHitTesting(false)
                                }
                            }
                    }
                } else {
                    Section {
                        TextEditor(text: $notes)
                            .frame(minHeight: 120)
                            .overlay(alignment: .topLeading) {
                                if notes.isEmpty {
                                    Text(fields.text.caption)
                                        .foregroundStyle(.secondary)
                                        .padding(.top, 8)
                                        .padding(.leading, 5)
                                        .allowsHitTesting(false)
                                }
                            }
                    }
                }

                // Leads and projects only: a partner is an organization and
                // an event is a CMS row, and the Worker keeps its subject
                // PATCH to those two kinds on purpose. A picker on either
                // would offer a write that cannot land. The contacts come
                // from the Worker on every workspace.
                if target.kind == .lead || target.kind == .project {
                    Section(fields.contact.caption) {
                        MobileRelationPicker(
                            placeholder: String(localized: "Search contacts"),
                            allowsMultiple: target.kind != .lead,
                            search: contactSearch,
                            selected: $contacts
                        )
                    }
                }

                // An existing project only: a new one has no id to link to.
                // The link lands on its own call, apart from Save.
                if target.kind == .project, target.subject != nil {
                    Section("Repository") {
                        ForEach(repos) { repo in
                            Text(repo.address)
                        }
                        Button {
                            showsRepoPicker = true
                        } label: {
                            Label("Link GitHub repository…", systemImage: "link")
                        }
                    }
                }

                if let errorMessage {
                    Section {
                        StarlingsErrorNotice(message: errorMessage)
                    }
                }

                if let planMessage {
                    Section {
                        MobileWorkspacePlanNotice(
                            message: planMessage,
                            offersUpgrade: work.subjectState.isWorkspaceAdmin
                        )
                    }
                }
            }
            .disabled(isLoading || isSaving)
            // The fields are the shape of the answer: while the live copy is
            // on its way they read as placeholders, and the wait sits in the
            // one control it holds back, Save. Nothing floats over the form.
            .redacted(reason: isLoading ? .placeholder : [])
            .navigationTitle(target.subject == nil ? String(localized: "New \(target.kind.editorTitle)") : String(localized: "Edit \(target.kind.editorTitle)"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isLoading {
                        ProgressView().controlSize(.small)
                    } else {
                        Button(isSaving ? String(localized: "Saving…") : String(localized: "Save")) { Task { await save() } }
                            .disabled(isSaving || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .meetToolbarConfirm()
                    }
                }
            }
            .task(id: target.id) { await loadDetailIfNeeded() }
            .sheet(isPresented: $showsRepoPicker) {
                if let subject = target.subject {
                    MobileProjectRepoPicker(subject: subject) { repo in
                        if !repos.contains(where: { $0.id == repo.id }) { repos.append(repo) }
                    }
                }
            }
        }
    }

    private func loadDetailIfNeeded() async {
        guard let subject = target.subject, let credentials = app.ownerCredentials else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let detail = try await app.api.crmSubjectDetail(
                credentials: credentials,
                kind: target.kind,
                id: subject.id
            )
            title = detail.title
            status = detail.status.isEmpty ? target.kind.defaultStatus : detail.status
            startDate = Self.date(from: detail.startDate) ?? .now
            hasStartDate = target.kind == .lead || detail.startDate != nil
            endDate = Self.date(from: detail.endDate) ?? .now
            hasEndDate = detail.endDate != nil
            description = detail.description ?? ""
            url = detail.url ?? ""
            notes = detail.notes ?? ""
            characteristics = detail.characteristics ?? [:]
            organization = Self.initialOrganization(detail: detail)
            contacts = Self.initialContacts(kind: target.kind, detail: detail)
            if target.kind == .project {
                repos = (try? await app.api.crmProjectRepos(credentials: credentials, projectID: subject.id)) ?? []
            }
            errorMessage = nil
            await resolveContactNames()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func save() async {
        guard let credentials = app.ownerCredentials else { return }
        planMessage = nil
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let organizationID = organization.first?.id
        // What the form requires is the registry's: a lead names its
        // organization, a project may have none. An edit keeps a
        // blank the record already had.
        let lacking: Set<String> = target.subject != nil && target.subject?.organizationID == nil ? [fields.organization.id] : []
        if let problem = FormFieldRegistry.problem([
            (fields.title, cleanTitle),
            (fields.organization, organizationID),
            (fields.text, target.kind == .project ? description : notes),
        ], lacking: lacking) {
            errorMessage = problem
            return
        }
        isSaving = true
        defer { isSaving = false }
        do {
            let start = target.kind == .lead || hasStartDate ? Self.day(startDate) : nil
            let end = target.kind == .project && hasEndDate ? Self.day(endDate) : nil
            let cleanDescription = description.trimmingCharacters(in: .whitespacesAndNewlines)
            let cleanURL = url.trimmingCharacters(in: .whitespacesAndNewlines)
            let cleanNotes = notes.trimmingCharacters(in: .whitespacesAndNewlines)
            let detail: CrmSubjectDetail
            if let subject = target.subject {
                detail = try await app.api.updateCrmSubject(
                    credentials: credentials,
                    kind: target.kind,
                    id: subject.id,
                    update: CrmSubjectUpdate(
                        kind: target.kind,
                        title: cleanTitle,
                        status: status,
                        startDate: start,
                        endDate: end,
                        description: target.kind == .project ? (cleanDescription.isEmpty ? nil : cleanDescription) : nil,
                        url: target.kind == .project ? (cleanURL.isEmpty ? nil : cleanURL) : nil,
                        notes: target.kind == .lead ? (cleanNotes.isEmpty ? nil : cleanNotes) : nil,
                        organizationID: organizationID,
                        contactID: target.kind == .lead ? contacts.first?.id : nil,
                        contactIDs: target.kind == .project ? contacts.map(\.id) : [],
                        characteristics: target.kind == .lead ? characteristics : nil
                    )
                )
            } else {
                detail = try await app.api.createCrmSubject(
                    credentials: credentials,
                    draft: CrmSubjectDraft(
                        kind: target.kind,
                        title: cleanTitle,
                        status: status,
                        startDate: start,
                        endDate: end,
                        description: target.kind == .project ? (cleanDescription.isEmpty ? nil : cleanDescription) : nil,
                        url: target.kind == .project ? (cleanURL.isEmpty ? nil : cleanURL) : nil,
                        notes: target.kind == .lead ? (cleanNotes.isEmpty ? nil : cleanNotes) : nil,
                        organizationID: organizationID,
                        contactID: target.kind == .lead
                            ? (contacts.first?.id ?? target.prefill?.contactID)
                            : nil,
                        contactIDs: target.kind == .project ? contacts.map(\.id) : [],
                        characteristics: target.kind == .lead ? characteristics : nil
                    )
                )
            }
            onSaved(detail)
            dismiss()
        } catch {
            let code = (error as? StarlingsError)?.serverCode
            let isAdmin = work.subjectState.isWorkspaceAdmin
            if WorkspacePlanNotice.isProjectLimit(code) {
                errorMessage = nil
                planMessage = WorkspacePlanNotice.limitText(isAdmin: isAdmin)
            } else if WorkspacePlanNotice.isProjectFrozen(code) {
                errorMessage = nil
                planMessage = WorkspacePlanNotice.frozenText(isAdmin: isAdmin)
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// The workspace's contacts, through the Worker as the Mac and the web
    /// read them: D1's own on a D1 workspace, Core's as the member
    /// on Core. It needs no Core link on this phone.
    private var contactSearch: ((String) async throws -> [SubjectRelationOption])? {
        guard let credentials = app.ownerCredentials else { return nil }
        let api = app.api
        return { query in
            try await api.crmContacts(credentials: credentials, matching: query).map(\.relationOption)
        }
    }

    /// The Worker's organization search only, as on the Mac and
    /// the web: Core while the subjects group is there, D1 after. A failure
    /// is an error the picker shows, never an empty list.
    private var organizationSearch: ((String) async throws -> [SubjectRelationOption])? {
        guard let credentials = app.ownerCredentials else { return nil }
        let api = app.api
        return { query in try await api.crmOrganizations(credentials: credentials, matching: query) }
    }

    /// Through the Worker, as on the Mac and the web: Core on a Core
    /// workspace, the workspace's own D1 otherwise.
    private var organizationCreate: ((String) async throws -> SubjectRelationOption)? {
        guard let credentials = app.ownerCredentials else { return nil }
        let api = app.api
        return { name in try await api.crmCreateOrganization(credentials: credentials, named: name) }
    }

    private static func initialOrganization(detail: CrmSubjectDetail) -> [SubjectRelationOption] {
        guard let id = detail.organizationID, !id.isEmpty else { return [] }
        return [.init(id: id, name: detail.organizationName ?? id)]
    }

    /// The ids a subject already carries, drawn as ids until Core names them.
    private static func initialContacts(
        kind: MeetingCategoryKind.SubjectKind,
        detail: CrmSubjectDetail
    ) -> [SubjectRelationOption] {
        let ids: [String] = kind == .lead
            ? [detail.contactID].compactMap { $0 }.filter { !$0.isEmpty }
            : detail.contactIDs.filter { !$0.isEmpty }
        return ids.map { .init(id: $0, name: $0) }
    }

    /// Replace those placeholders through the Worker (`GET /api/crm/contacts`,
    ///). A failure leaves the ids on screen: unlovely, but every one
    /// of them still saves.
    private func resolveContactNames() async {
        guard let credentials = app.ownerCredentials, !contacts.isEmpty else { return }
        guard let found = try? await app.api.crmContacts(credentials: credentials, ids: contacts.map(\.id)) else { return }
        let named = Dictionary(found.map { ($0.id, $0.relationOption) }, uniquingKeysWith: { first, _ in first })
        contacts = contacts.map { named[$0.id] ?? $0 }
    }

    private static func date(from value: String?) -> Date? {
        guard let value, value.count >= 10 else { return nil }
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: String(value.prefix(10)))
    }

    private static func day(_ value: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: value)
    }
}
