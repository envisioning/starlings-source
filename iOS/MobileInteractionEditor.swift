import EnvisioningUI
import StarlingsContracts
import SwiftUI

/// Log and edit sheet for a call, meeting or note on a subject's History
///. The Mac twin is `WorkInteractionEditor`; both read and write
/// `CrmInteractionDraft`. The sheet owns the write: a failure stays on the
/// sheet in red with Copy, with the draft intact.
struct MobileInteractionEditor: View {
    @State var draft: CrmInteractionDraft
    /// The row the Worker answered, after the sheet closes.
    let onSaved: (CrmInteraction) -> Void

    @EnvironmentObject private var app: StarlingsAppModel
    @Environment(\.dismiss) private var dismiss
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            StarlingsForm {
                Section {
                    Picker("Type", selection: $draft.type) {
                        ForEach(draft.typeOptions, id: \.self) { type in
                            Text(type.editorTitle).tag(type)
                        }
                    }
                    TextField("Title", text: $draft.title, axis: .vertical)
                        .meetSingleLine($draft.title)
                    DatePicker("Date and time", selection: $draft.occurredAt, displayedComponents: [.date, .hourAndMinute])
                }
                Section {
                    TextField("Summary", text: $draft.summary, axis: .vertical)
                        .lineLimit(3...10)
                }
                Section {
                    TextField("Link", text: $draft.url)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section("Organization") {
                    MobileRelationPicker(
                        placeholder: String(localized: "Search organizations"),
                        emptyText: String(localized: "No organizations match"),
                        allowsMultiple: false,
                        search: organizationSearch,
                        selected: single(\.organization)
                    )
                }
                Section("Lead") {
                    MobileRelationPicker(
                        placeholder: String(localized: "Search leads"),
                        emptyText: String(localized: "No leads match"),
                        allowsMultiple: false,
                        search: subjectSearch(.lead),
                        selected: single(\.lead)
                    )
                }
                Section("Project") {
                    MobileRelationPicker(
                        placeholder: String(localized: "Search projects"),
                        emptyText: String(localized: "No projects match"),
                        allowsMultiple: false,
                        search: subjectSearch(.project),
                        selected: single(\.project)
                    )
                }
                Section("Contacts") {
                    MobileRelationPicker(
                        placeholder: String(localized: "Search contacts"),
                        emptyText: String(localized: "No contacts match"),
                        allowsMultiple: true,
                        search: contactSearch,
                        selected: $draft.contacts
                    )
                }
                if let errorMessage {
                    Section {
                        StarlingsErrorNotice(message: errorMessage)
                    }
                }
            }
            .navigationTitle(draft.isNew ? String(localized: "Log") : String(localized: "Edit"))
            .navigationBarTitleDisplayMode(.inline)
            .task { await resolveNames() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task { await save() }
                    }
                    .disabled(!draft.canSave || isSaving)
                    .meetToolbarConfirm()
                }
            }
        }
    }

    /// One optional relation as the picker's list of at most one.
    private func single(
        _ keyPath: WritableKeyPath<CrmInteractionDraft, SubjectRelationOption?>
    ) -> Binding<[SubjectRelationOption]> {
        Binding(
            get: { draft[keyPath: keyPath].map { [$0] } ?? [] },
            set: { draft[keyPath: keyPath] = $0.last }
        )
    }

    /// The Worker's organization search, as the subject editor reads it.
    private var organizationSearch: ((String) async throws -> [SubjectRelationOption])? {
        guard let credentials = app.ownerCredentials else { return nil }
        let api = app.api
        return { query in try await api.crmOrganizations(credentials: credentials, matching: query) }
    }

    /// Leads or projects by name.
    private func subjectSearch(
        _ kind: MeetingCategoryKind.SubjectKind
    ) -> ((String) async throws -> [SubjectRelationOption])? {
        guard let credentials = app.ownerCredentials else { return nil }
        let api = app.api
        return { query in
            try await api.crmSubjects(credentials: credentials, kind: kind, query: query).map {
                SubjectRelationOption(id: $0.id, name: $0.title, secondaryText: $0.subtitle)
            }
        }
    }

    /// The workspace's contacts, through the Worker, as the contact pages read them.
    private var contactSearch: ((String) async throws -> [SubjectRelationOption])? {
        guard let credentials = app.ownerCredentials else { return nil }
        let api = app.api
        return { query in
            try await api.crmContacts(credentials: credentials, matching: query).map(\.relationOption)
        }
    }

    /// An edited row names its organization, lead and project by id. Read
    /// each once and draw its name; a failure leaves the id, which still saves.
    private func resolveNames() async {
        guard let credentials = app.ownerCredentials else { return }
        for link in draft.unnamedLinks {
            guard let detail = try? await app.api.crmSubjectDetail(credentials: credentials, kind: link.kind, id: link.id) else { continue }
            draft.name(link.kind, id: link.id, as: detail.title)
        }
    }

    private func save() async {
        guard draft.canSave, !isSaving, let credentials = app.ownerCredentials else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            let saved: CrmInteraction
            if let original = draft.original {
                saved = try await app.api.updateInteraction(credentials: credentials, id: original.id, update: draft.update)
            } else {
                saved = try await app.api.createInteraction(credentials: credentials, draft.create)
            }
            errorMessage = nil
            onSaved(saved)
            dismiss()
        } catch {
            errorMessage = (error as? StarlingsError)?.message ?? error.localizedDescription
        }
    }
}
