import EnvisioningUI
import SwiftUI

/// A contact's page on iPhone and iPad (docs/RELATIONSHIPS.md
/// slice 2): who they are and where, their addresses, the projects and leads
/// they are on, the calls they were in and the members who met them. Pushed
/// from an organization's page or from search. Every block folds, the fold
/// kept per block, as the Mac's and the web's do. Merge… and Delete act on
/// the contact over the Worker's contact routes.
struct MobileContactView: View {
    let contactID: String

    @EnvironmentObject private var app: StarlingsAppModel
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss
    @State private var contact: CrmContactDetail?
    @State private var errorMessage: String?
    @State private var isEditing = false
    @State private var isMerging = false
    @State private var isConfirmingDelete = false
    @State private var isDeleting = false
    /// The survivor's id once a read says `contactID` was merged into it
    ///. Every later read asks for it.
    @State private var survivorID: String?

    var body: some View {
        StarlingsList {
            if let errorMessage {
                Section {
                    StarlingsErrorNotice(message: errorMessage) { Task { await load() } }
                }
            }
            if let contact {
                if !contact.context.isEmpty || contact.organizationSubject != nil {
                    Section {
                        if !contact.context.isEmpty {
                            Text(contact.context).font(.footnote).foregroundStyle(.secondary)
                        }
                        if let organization = contact.organizationSubject {
                            NavigationLink(value: WorkDestination(subject: organization)) {
                                Label(organization.title, systemImage: "building.2")
                            }
                        }
                    }
                }
                profileSection(contact)
                MobileRailSection(Self.block("addresses"), title: "Addresses") {
                    if contact.emails.isEmpty {
                        Text("No addresses.").font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(Array(contact.emails.enumerated()), id: \.element) { index, email in
                        Button {
                            if let url = URL(string: "mailto:\(email)") { openURL(url) }
                        } label: {
                            LabeledContent(email) {
                                if index == 0 && contact.emails.count > 1 { Text("Primary") }
                            }
                        }
                        .buttonStyle(.meetPlain)
                        .accessibilityLabel(String(localized: "Write to \(email)"))
                    }
                }
                subjectsSection(key: "projects", title: "Projects", rows: contact.projects, kind: .project, empty: "On no project.")
                subjectsSection(key: "leads", title: "Leads", rows: contact.leads, kind: .lead, empty: "On no lead.")
                MobileRailSection(Self.block("calls"), title: "Calls") {
                    if contact.interactions.isEmpty {
                        Text("No calls yet.").font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(contact.interactions, id: \.id) { interaction in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(interaction.displayTitle).font(.body)
                            Text(interaction.metadataLabel).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                if !contact.metBy.isEmpty {
                    MobileRailSection(Self.block("met-by"), title: "Met by") {
                        ForEach(contact.metBy, id: \.email) { member in
                            LabeledContent(member.name ?? member.email, value: String(localized: "\(member.calls) calls"))
                        }
                    }
                }
                actionsSection
            } else if errorMessage == nil {
                Section { EnvisioningPlaceholderRows() }
            }
        }
        .navigationTitle(contact?.displayName ?? String(localized: "Contact"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if contact != nil {
                ToolbarItem(placement: .primaryAction) {
                    Button(String(localized: "Edit")) { isEditing = true }
                }
            }
        }
        .sheet(isPresented: $isEditing) {
            if let contact {
                MobileContactEditorView(contact: contact, organization: nil) { saved in
                    self.contact = saved
                    NotificationCenter.default.post(name: .mobileContactsDidChange, object: nil)
                }
            }
        }
        .sheet(isPresented: $isMerging) {
            if let contact {
                MobileContactMergeView(contact: contact) { kept in
                    // The Worker keeps the older one, which can be the duplicate: read the one that stayed.
                    if kept != contact.id { survivorID = kept }
                    NotificationCenter.default.post(name: .mobileContactsDidChange, object: nil)
                    Task { await load() }
                }
            }
        }
        .confirmationDialog(
            String(localized: "Delete “\(contact?.displayName ?? "")”?"),
            isPresented: $isConfirmingDelete,
            titleVisibility: .visible
        ) {
            Button(String(localized: "Delete"), role: .destructive) {
                Task { await delete() }
            }
        } message: {
            Text("Its leads and projects stay. This can’t be undone.")
        }
        .refreshable { await load() }
        .task(id: contactID) { await load() }
    }

    /// A block's fold key, the same names the Mac and the web keep.
    private static func block(_ id: String) -> RailBlock {
        RailBlock(id: id, key: "work.contact.\(id)", hidesWhenEmpty: false)
    }

    /// Birthday, Language, Signals status and Characteristics, each only when set.
    @ViewBuilder
    private func profileSection(_ contact: CrmContactDetail) -> some View {
        let birthday = ContactFieldText.birthday(month: contact.birthdayMonth, day: contact.birthdayDay, year: contact.birthdayYear)
        let language = ContactListFilter.trimmed(contact.preferredLanguage)
        let status = ContactListFilter.trimmed(contact.signalsOutreachStatus)
        let traits = (contact.characteristics ?? [:]).filter(\.value).keys.sorted().map(ContactFieldText.characteristic)
        if birthday != nil || language != nil || status != nil || !traits.isEmpty {
            MobileRailSection(Self.block("details"), title: "Details") {
                if let birthday {
                    LabeledContent(String(localized: "Birthday"), value: birthday)
                }
                if let language {
                    LabeledContent(String(localized: "Language"), value: ContactFieldText.language(language))
                }
                if let status {
                    LabeledContent(String(localized: "Signals status"), value: ContactFieldText.outreach(status))
                }
                if !traits.isEmpty {
                    LabeledContent(String(localized: "Characteristics"), value: traits.joined(separator: ", "))
                }
            }
        }
    }

    /// Merge and Delete, under the page.
    private var actionsSection: some View {
        Section {
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

    /// The Worker refuses while a call or a task references the contact,
    /// and its message names them: that is the error shown.
    private func delete() async {
        guard let credentials = app.ownerCredentials, let contact, !isDeleting else { return }
        isDeleting = true
        defer { isDeleting = false }
        do {
            try await app.api.deleteCrmContact(credentials: credentials, id: contact.id)
            NotificationCenter.default.post(name: .mobileContactsDidChange, object: nil)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @ViewBuilder
    private func subjectsSection(
        key: String,
        title: LocalizedStringKey,
        rows: [CrmRelatedRow],
        kind: MeetingCategoryKind.SubjectKind,
        empty: LocalizedStringKey
    ) -> some View {
        MobileRailSection(Self.block(key), title: title) {
            if rows.isEmpty {
                Text(empty).font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(rows, id: \.id) { row in
                let related = CrmSubject(
                    id: row.id,
                    kind: kind.rawValue,
                    title: (row.title ?? "").isEmpty ? String(localized: "Untitled") : row.title!,
                    subtitle: row.status
                )
                NavigationLink(value: WorkDestination(subject: related, pane: .overview)) {
                    WorkSidebarRow.subject(related, showsLeading: kind == .project, isSubdued: kind == .lead)
                }
            }
        }
    }

    private func load() async {
        guard let credentials = app.ownerCredentials else { return }
        do {
            let fresh = try await app.api.crmContact(credentials: credentials, id: survivorID ?? contactID)
            if let mergedID = fresh.mergedFrom, fresh.id != (survivorID ?? contactID) {
                survivorID = fresh.id
                SearchRecents.replace(mergedID: mergedID, with: nil, owner: credentials.owner.email)
            }
            contact = fresh
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// Add a contact, or edit one, on iPhone and iPad: name, title,
/// organization, and addresses one per line, the primary first. Adding from
/// an organization's page chooses the organization. The birthday, language,
/// Signals status and characteristics are `ContactProfileDraft`.
struct MobileContactEditorView: View {
    let contact: CrmContactDetail?
    let organization: SubjectRelationOption?
    let onSaved: (CrmContactDetail) -> Void

    @EnvironmentObject private var app: StarlingsAppModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var title = ""
    @State private var addresses = ""
    @State private var organizations: [SubjectRelationOption] = []
    @State private var profile = ContactProfileDraft()
    /// What the contact carried when the editor opened; nil for a new contact.
    @State private var initialProfile: ContactProfileDraft?
    /// The characteristic names and languages the workspace offers. Nil
    /// until they load, or when they fail: the editor still edits what the
    /// contact carries.
    @State private var options: CrmContactOptionsResponse?
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            StarlingsForm {
                Section {
                    TextField(fields.name.caption, text: $name)
                        .textInputAutocapitalization(.words)
                    TextField(fields.title.caption, text: $title)
                }
                Section(fields.organization.caption) {
                    MobileRelationPicker(
                        placeholder: String(localized: "Search organizations"),
                        allowsMultiple: false,
                        search: organizationSearch,
                        create: organizationCreate,
                        selected: $organizations
                    )
                }
                Section(fields.emails.caption) {
                    TextField("name@example.com", text: $addresses, axis: .vertical)
                        .lineLimit(2...6)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section(String(localized: "Birthday")) {
                    Picker(String(localized: "Month"), selection: monthBinding) {
                        Text("None").tag(Int?.none)
                        ForEach(Array(Self.monthNames.enumerated()), id: \.offset) { index, month in
                            Text(verbatim: month).tag(Int?.some(index + 1))
                        }
                    }
                    if profile.birthdayMonth != nil {
                        Picker(String(localized: "Day"), selection: $profile.birthdayDay) {
                            ForEach(1...31, id: \.self) { day in
                                Text(verbatim: "\(day)").tag(Int?.some(day))
                            }
                        }
                        TextField(String(localized: "Year"), text: yearBinding)
                            .keyboardType(.numberPad)
                    }
                }
                Section {
                    Picker(String(localized: "Language"), selection: $profile.preferredLanguage) {
                        ForEach(languages, id: \.self) { code in
                            Text(verbatim: ContactFieldText.language(code)).tag(code)
                        }
                    }
                    Picker(String(localized: "Signals status"), selection: $profile.signalsOutreachStatus) {
                        Text("None").tag(String?.none)
                        ForEach(outreachStatuses, id: \.self) { status in
                            Text(verbatim: ContactFieldText.outreach(status)).tag(String?.some(status))
                        }
                    }
                }
                if !characteristicNames.isEmpty {
                    Section(String(localized: "Characteristics")) {
                        ForEach(characteristicNames, id: \.self) { name in
                            Toggle(ContactFieldText.characteristic(name), isOn: characteristicBinding(name))
                                .meetToggleTint()
                        }
                    }
                }
                if let errorMessage {
                    Section { StarlingsErrorNotice(message: errorMessage) }
                }
            }
            .disabled(isSaving)
            .navigationTitle(contact == nil ? String(localized: "Add contact") : String(localized: "Edit contact"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? String(localized: "Saving…") : String(localized: "Save")) { Task { await save() } }
                        .disabled(isSaving || trimmedName.isEmpty)
                        .meetToolbarConfirm()
                }
            }
            .onAppear(perform: fill)
            .task { await loadOptions() }
        }
    }

    /// The months in the reader's language, January first.
    private static var monthNames: [String] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = .current
        return calendar.standaloneMonthSymbols
    }

    /// No month clears the whole birthday; a month starts the day at 1.
    private var monthBinding: Binding<Int?> {
        Binding(
            get: { profile.birthdayMonth },
            set: { month in
                profile.birthdayMonth = month
                if month == nil {
                    profile.birthdayDay = nil
                    profile.birthdayYear = nil
                } else if profile.birthdayDay == nil {
                    profile.birthdayDay = 1
                }
            }
        )
    }

    /// The year as digits; an empty field is no year.
    private var yearBinding: Binding<String> {
        Binding(
            get: { profile.birthdayYear.map { String($0) } ?? "" },
            set: { text in
                let digits = text.filter(\.isNumber)
                profile.birthdayYear = digits.isEmpty ? nil : Int(digits.prefix(4))
            }
        )
    }

    /// The workspace's languages and the one the contact carries, by name.
    private var languages: [String] {
        Array(Set(options?.languages ?? []).union([profile.preferredLanguage]))
            .sorted { ContactFieldText.language($0).localizedStandardCompare(ContactFieldText.language($1)) == .orderedAscending }
    }

    /// The five Signals states, and a state this build does not know when the contact carries one.
    private var outreachStatuses: [String] {
        let known = CrmContactsQuerySignalsOutreachStatus.known.map(\.rawValue)
        guard let current = profile.signalsOutreachStatus, !known.contains(current) else { return known }
        return known + [current]
    }

    private var characteristicNames: [String] {
        ContactProfileDraft.characteristicNames(
            options: options?.characteristics ?? [],
            contact: (initialProfile?.characteristics ?? [:]).merging(profile.characteristics) { _, new in new }
        )
    }

    /// Off drops a name the contact did not carry, so an unchanged set sends nothing.
    private func characteristicBinding(_ name: String) -> Binding<Bool> {
        Binding(
            get: { profile.characteristics[name] ?? false },
            set: { on in
                if on || initialProfile?.characteristics[name] != nil {
                    profile.characteristics[name] = on
                } else {
                    profile.characteristics.removeValue(forKey: name)
                }
            }
        )
    }

    private func loadOptions() async {
        guard options == nil, let credentials = app.ownerCredentials else { return }
        options = try? await app.api.crmContactOptions(credentials: credentials)
    }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var fields: ContactFormFields { FormFieldRegistry.contact }

    private func fill() {
        guard name.isEmpty, organizations.isEmpty else { return }
        name = contact?.name ?? ""
        title = contact?.title ?? ""
        addresses = (contact?.emails ?? []).joined(separator: "\n")
        if let contact {
            let carried = ContactProfileDraft(contact: contact)
            profile = carried
            initialProfile = carried
        }
        if let id = contact?.organizationID {
            organizations = [SubjectRelationOption(id: id, name: contact?.organizationName ?? id)]
        } else if let organization {
            organizations = [organization]
        }
    }

    private var organizationSearch: ((String) async throws -> [SubjectRelationOption])? {
        guard let credentials = app.ownerCredentials else { return nil }
        let api = app.api
        return { query in try await api.crmOrganizations(credentials: credentials, matching: query) }
    }

    private var organizationCreate: ((String) async throws -> SubjectRelationOption)? {
        guard let credentials = app.ownerCredentials else { return nil }
        let api = app.api
        return { name in try await api.crmCreateOrganization(credentials: credentials, named: name) }
    }

    /// One address per line (or comma), lower case, the primary first.
    private var emails: [String] { FormFieldRegistry.emails(addresses) }

    private func save() async {
        guard let credentials = app.ownerCredentials, !trimmedName.isEmpty else { return }
        if let problem = FormFieldRegistry.problem([(fields.name, trimmedName), (fields.title, title)]) {
            errorMessage = problem
            return
        }
        if let problem = profile.birthdayProblem {
            errorMessage = problem
            return
        }
        isSaving = true
        defer { isSaving = false }
        let organizationID = organizations.first?.id
        do {
            let saved: CrmContactDetail
            if let contact {
                var update = CrmContactUpdate(
                    name: trimmedName,
                    title: fields.title.patch(title, .update),
                    organizationID: fields.organization.patch(organizationID, .update),
                    emails: fields.emails.list(emails, .update)
                )
                profile.apply(to: &update, from: initialProfile)
                saved = try await app.api.updateCrmContact(credentials: credentials, id: contact.id, body: update)
            } else {
                var create = CrmContactCreate(
                    name: trimmedName,
                    title: fields.title.patch(title, .create),
                    organizationID: fields.organization.patch(organizationID, .create),
                    emails: fields.emails.list(emails, .create)
                )
                profile.apply(to: &create)
                saved = try await app.api.createCrmContact(credentials: credentials, body: create)
            }
            onSaved(saved)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// Merge a duplicate into a contact on the phone: pick the
/// duplicate, confirm, and the Worker keeps the older one.
struct MobileContactMergeView: View {
    let contact: CrmContactDetail
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
                        placeholder: String(localized: "Search contacts"),
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
            .navigationTitle(String(localized: "Merge contact"))
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
                String(localized: "Merge “\(contact.displayName)” and “\(picked.first?.name ?? "")”?"),
                isPresented: $isConfirming,
                titleVisibility: .visible
            ) {
                Button(String(localized: "Merge"), role: .destructive) {
                    Task { await merge() }
                }
            } message: {
                Text("The older one keeps every link and address, and the other is deleted for good.")
            }
        }
    }

    /// Contacts by name, address, title or organization, without the one being merged into.
    private var search: ((String) async throws -> [SubjectRelationOption])? {
        guard let credentials = app.ownerCredentials else { return nil }
        let api = app.api
        let own = contact.id
        return { query in
            try await api.crmContacts(credentials: credentials, matching: query)
                .filter { $0.id != own }
                .map(\.relationOption)
        }
    }

    private func merge() async {
        guard let credentials = app.ownerCredentials, let duplicate = picked.first, !isMerging else { return }
        isMerging = true
        defer { isMerging = false }
        do {
            let answer = try await app.api.mergeCrmContacts(credentials: credentials, ids: [contact.id, duplicate.id])
            dismiss()
            onMerged(answer.kept)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
