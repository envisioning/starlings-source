import EnvisioningUI
import SwiftUI

/// A partner's own page (PARTNERS (HQ Docs)): what the relationship
/// is — industry, website, description — and what hangs off it: projects and
/// leads as rows that open their subject, contacts as names. A partner is an
/// organization: Edit organization and Delete act on it over the Worker's
/// organization route.
struct MobilePartnerDetailView: View {
    let subject: CrmSubject
    /// The id was merged into another organization: the parent
    /// holds the survivor from here on.
    var onMerged: ((CrmSubject) -> Void)? = nil

    @EnvironmentObject private var app: StarlingsAppModel
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss
    @State private var detail: CrmSubjectDetail?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var isAddingContact = false
    @State private var isEditing = false
    @State private var isConfirmingDelete = false
    @State private var isDeleting = false
    @State private var isMerging = false

    var body: some View {
        StarlingsList {
            if let errorMessage {
                Section {
                    StarlingsErrorNotice(message: errorMessage) { Task { await load() } }
                }
            }
            if let subtitle = subject.subtitle, !subtitle.isEmpty {
                Section {
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            if detail == nil && isLoading {
                Section { EnvisioningPlaceholderRows() }
            }
            if let detail {
                aboutSection(detail)
                relatedSection(
                    title: String(localized: "Projects"),
                    rows: detail.related?.projects ?? [],
                    kind: .project,
                    empty: "No projects with this partner yet."
                )
                relatedSection(
                    title: String(localized: "Leads"),
                    rows: detail.related?.leads ?? [],
                    kind: .lead,
                    empty: "No open leads with this partner."
                )
                contactsSection(detail.related?.contacts ?? [])
                actionsSection
            }
        }
        .refreshable { await load() }
        .task(id: subject.id) { await load() }
        .sheet(isPresented: $isAddingContact) {
            MobileContactEditorView(
                contact: nil,
                organization: SubjectRelationOption(id: subject.id, name: subject.title)
            ) { _ in
                Task { await load() }
            }
        }
        .sheet(isPresented: $isEditing) {
            if let detail {
                MobileOrganizationEditorView(detail: detail) { saved in self.detail = saved }
            }
        }
        .sheet(isPresented: $isMerging) {
            MobileOrganizationMergeView(organization: subject) { kept in
                // The one on screen stayed: read it again. Otherwise it is gone.
                if kept == subject.id { Task { await load() } } else { dismiss() }
            }
        }
        .confirmationDialog(
            String(localized: "Delete “\(subject.title)”?"),
            isPresented: $isConfirmingDelete,
            titleVisibility: .visible
        ) {
            Button(String(localized: "Delete"), role: .destructive) {
                Task { await delete() }
            }
        } message: {
            Text("The organization is deleted. This can’t be undone.")
        }
    }

    /// Edit organization, Merge and Delete, under the page.
    private var actionsSection: some View {
        Section {
            Button {
                isEditing = true
            } label: {
                Label("Edit organization", systemImage: "pencil")
            }
            .buttonStyle(.meetPlain)
            Button {
                isMerging = true
            } label: {
                Label("Merge…", systemImage: "arrow.triangle.merge")
            }
            .buttonStyle(.meetPlain)
            Button(role: .destructive) {
                isConfirmingDelete = true
            } label: {
                Label(isDeleting ? String(localized: "Deleting…") : String(localized: "Delete"), systemImage: "trash")
                    .foregroundStyle(StarlingsMobileColors.danger)
            }
            .buttonStyle(.meetPlain)
            .disabled(isDeleting)
        }
    }

    /// The Worker refuses while a record still points at the organization,
    /// and its message names those records: that is the error shown.
    private func delete() async {
        guard let credentials = app.ownerCredentials, !isDeleting else { return }
        isDeleting = true
        defer { isDeleting = false }
        do {
            try await app.api.deleteCrmOrganization(credentials: credentials, id: subject.id)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @ViewBuilder
    private func aboutSection(_ detail: CrmSubjectDetail) -> some View {
        let industry = detail.industry?.trimmingCharacters(in: .whitespaces) ?? ""
        let website = detail.url?.trimmingCharacters(in: .whitespaces) ?? ""
        let description = detail.description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !industry.isEmpty || !website.isEmpty || !description.isEmpty {
            Section("About") {
                if !industry.isEmpty {
                    LabeledContent("Industry", value: industry)
                }
                if !website.isEmpty, let url = URL(string: website) {
                    Button { openURL(url) } label: {
                        LabeledContent("Website") {
                            Text(website).foregroundStyle(StarlingsMobileColors.accentMark).lineLimit(1)
                        }
                    }
                    .accessibilityLabel("Open website \(website)")
                }
                if !description.isEmpty {
                    Text(description).font(.body)
                }
            }
        }
    }

    @ViewBuilder
    private func relatedSection(
        title: String,
        rows: [CrmSubjectRelated.Row],
        kind: MeetingCategoryKind.SubjectKind,
        empty: String
    ) -> some View {
        Section(title) {
            if rows.isEmpty {
                Text(empty).font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(rows) { row in
                let related = CrmSubject(
                    id: row.id,
                    kind: kind.rawValue,
                    title: (row.title ?? "").isEmpty ? String(localized: "Untitled") : row.title!,
                    subtitle: row.status
                )
                NavigationLink(value: WorkDestination(subject: related, pane: .talk)) {
                    WorkSidebarRow.subject(related, showsLeading: kind == .project, isSubdued: kind == .lead)
                }
            }
        }
    }

    /// Its people: each opens their page; Add contact files one
    /// on this organization. The header folds, as every list header does.
    @ViewBuilder
    private func contactsSection(_ contacts: [CrmSubjectRelated.Contact]) -> some View {
        MobileRailSection(
            RailBlock(id: "contacts", key: "work.organization.contacts", hidesWhenEmpty: false),
            title: "Contacts"
        ) {
            if contacts.isEmpty {
                Text("No contacts yet.").font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(contacts) { contact in
                NavigationLink(value: WorkDestination.contact(id: contact.id)) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text((contact.name ?? "").isEmpty ? (contact.email ?? String(localized: "Unnamed")) : contact.name!)
                            .font(.body)
                        let meta = [contact.title, contact.email].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                        if !meta.isEmpty {
                            Text(meta).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            Button {
                isAddingContact = true
            } label: {
                Label("Add contact", systemImage: "plus")
            }
            .buttonStyle(.meetPlain)
        }
    }

    private func load() async {
        guard let credentials = app.ownerCredentials else { return }
        // Last known first (docs/CACHING.md): the page is read-only, so the
        // last copy of the partner is safe to paint before Core answers.
        if detail == nil,
           let cached = app.api.snapshot(
               StarlingsAPI.subjectDetailSnapshotKey(kind: .organization, id: subject.id),
               credentials: credentials, as: CrmSubjectDetailResponse.self
           ) {
            detail = cached.value.subject
        }
        isLoading = detail == nil
        defer { isLoading = false }
        do {
            let fresh = try await app.api.crmSubjectDetail(credentials: credentials, kind: .organization, id: subject.id, snapshotted: true)
            errorMessage = nil
            if let mergedID = fresh.mergedFrom, fresh.id != subject.id, let onMerged {
                let survivor = fresh.summary
                await app.adoptSurvivor(kind: subject.kind, mergedID: mergedID, survivor: SearchRow.subject(survivor), survivorID: survivor.id)
                onMerged(survivor)
                return
            }
            detail = fresh
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// Edit organization on the phone: name, the fields of
/// `OrganizationDraft`, and the three flags. Sends only what changed.
struct MobileOrganizationEditorView: View {
    let detail: CrmSubjectDetail
    let onSaved: (CrmSubjectDetail) -> Void

    @EnvironmentObject private var app: StarlingsAppModel
    @Environment(\.dismiss) private var dismiss
    @State private var initial: OrganizationDraft
    @State private var draft: OrganizationDraft
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(detail: CrmSubjectDetail, onSaved: @escaping (CrmSubjectDetail) -> Void) {
        self.detail = detail
        self.onSaved = onSaved
        let draft = OrganizationDraft(detail)
        _initial = State(initialValue: draft)
        _draft = State(initialValue: draft)
    }

    var body: some View {
        NavigationStack {
            StarlingsForm {
                Section {
                    TextField(String(localized: "Name") + FormFieldRegistry.requiredMark, text: $draft.name)
                        .textInputAutocapitalization(.words)
                }
                Section {
                    ForEach(OrganizationDraft.TextField.allCases, id: \.self) { field in
                        if field.isLong {
                            TextField(field.label, text: text(field), axis: .vertical)
                                .lineLimit(2...6)
                        } else {
                            TextField(field.label, text: text(field))
                                .keyboardType(field.isURL ? .URL : .default)
                                .textInputAutocapitalization(field.isURL || field == .domain ? .never : .words)
                                .autocorrectionDisabled(field.isURL || field == .domain)
                        }
                    }
                }
                Section {
                    ForEach(OrganizationDraft.Flag.allCases, id: \.self) { flag in
                        Toggle(flag.label, isOn: Binding(
                            get: { draft.flag(flag) },
                            set: { draft.flags[flag] = $0 }
                        ))
                        .meetToggleTint()
                    }
                }
                if let errorMessage {
                    Section { StarlingsErrorNotice(message: errorMessage) }
                }
            }
            .disabled(isSaving)
            .navigationTitle(String(localized: "Edit organization"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? String(localized: "Saving…") : String(localized: "Save")) { Task { await save() } }
                        .disabled(isSaving || !draft.canSave)
                        .meetToolbarConfirm()
                }
            }
        }
    }

    private func text(_ field: OrganizationDraft.TextField) -> Binding<String> {
        Binding(get: { draft.value(field) }, set: { draft.text[field] = $0 })
    }

    private func save() async {
        guard let credentials = app.ownerCredentials, draft.canSave else { return }
        guard let patch = draft.patch(from: initial) else {
            dismiss()
            return
        }
        isSaving = true
        defer { isSaving = false }
        do {
            let saved = try await app.api.updateCrmOrganization(credentials: credentials, id: detail.id, update: patch)
            onSaved(saved)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// Merge a duplicate into an organization on the phone: pick the
/// duplicate, confirm, and the Worker keeps the older one.
struct MobileOrganizationMergeView: View {
    let organization: CrmSubject
    let onMerged: (_ keptID: String) -> Void

    @EnvironmentObject private var app: StarlingsAppModel
    @Environment(\.dismiss) private var dismiss
    @State private var picked: [SubjectRelationOption] = []
    @State private var isConfirming = false
    @State private var isMerging = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            StarlingsForm {
                Section(String(localized: "Duplicate")) {
                    MobileRelationPicker(
                        placeholder: String(localized: "Search organizations"),
                        allowsMultiple: false,
                        search: search,
                        selected: $picked
                    )
                }
                if let errorMessage {
                    Section { StarlingsErrorNotice(message: errorMessage) }
                }
            }
            .disabled(isMerging)
            .navigationTitle(String(localized: "Merge organization"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isMerging ? String(localized: "Merging…") : String(localized: "Merge")) { isConfirming = true }
                        .disabled(isMerging || picked.isEmpty)
                        .meetToolbarConfirm()
                }
            }
            .confirmationDialog(
                String(localized: "Merge “\(organization.title)” and “\(picked.first?.name ?? "")”?"),
                isPresented: $isConfirming,
                titleVisibility: .visible
            ) {
                Button(String(localized: "Merge"), role: .destructive) {
                    Task { await merge() }
                }
            } message: {
                Text("The older one keeps every link, and the other is deleted for good.")
            }
        }
    }

    /// Organizations by name, without the one being merged into.
    private var search: ((String) async throws -> [SubjectRelationOption])? {
        guard let credentials = app.ownerCredentials else { return nil }
        let api = app.api
        let own = organization.id
        return { query in
            try await api.crmOrganizations(credentials: credentials, matching: query).filter { $0.id != own }
        }
    }

    private func merge() async {
        guard let credentials = app.ownerCredentials, let duplicate = picked.first, !isMerging else { return }
        isMerging = true
        defer { isMerging = false }
        do {
            let answer = try await app.api.mergeCrmOrganizations(credentials: credentials, ids: [organization.id, duplicate.id])
            dismiss()
            onMerged(answer.kept)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
