import EnvisioningUI
import SwiftUI

/// The Fields pane on Mac and iOS: every field of a project or a lead, read
/// with `GET /api/crm/subjects/:kind/:id` and written with the same path's
/// PATCH. The Worker sends each write to the workspace's store,
/// Core or D1, so a Core table that freezes for its move to D1 does not break
/// this pane. Nothing here holds a Core token.
///
/// Relations (organization, lead, contacts) show here as names; Edit details…
/// changes them. The license is not shown: no Worker route names a license.
/// An organization's pane is read-only: the Worker has no organization PATCH.
///
/// Each platform passes its own API call as `load` and `save`.
struct SubjectFieldsView: View {
    let subject: CrmSubject
    /// The workspace's work modules (docs/WORK_MODEL.md). Nil, from an older
    /// Worker, reads as every work module on.
    let workModules: [WorkModule]?
    let load: @MainActor () async throws -> CrmSubjectDetail
    let save: @MainActor (CrmSubjectUpdate) async throws -> CrmSubjectDetail
    let onSaved: (CrmSubjectDetail) -> Void
    let onToast: (String) -> Void

    @State private var detail: CrmSubjectDetail?
    @State private var saved = SubjectFieldsDraft()
    @State private var draft = SubjectFieldsDraft()
    @State private var loadError: String?
    @State private var saveError: String?
    @State private var isSaving = false

    private var kind: MeetingCategoryKind.SubjectKind { subject.subjectKind }
    private var isWritable: Bool { kind == .project || kind == .lead }
    /// The project spec fields and EVID are the `spec_fields` work module.
    private var showsSpecFields: Bool { workModules?.contains(.specFields) ?? true }
    private var isDirty: Bool { draft != saved }

    var body: some View {
        Group {
            if let detail {
                VStack(spacing: 0) {
                    if isWritable { actions }
                    EnvisioningForm { form(detail) }
                        .disabled(isSaving)
                }
            } else if let loadError {
                StarlingsRetryState(title: String(localized: "Couldn’t load the record"), message: loadError) {
                    Task { await reload() }
                }
            } else {
                StarlingsPlaceholderStack(count: 4)
            }
        }
        .task(id: subject.id) { await reload() }
    }

    // MARK: - Save and Revert

    private var actions: some View {
        HStack(spacing: 8) {
            if let saveError {
                StarlingsErrorNotice(message: saveError)
            }
            Spacer(minLength: 8)
            Button(String(localized: "Revert")) {
                draft = saved
                saveError = nil
            }
            .buttonStyle(EnvisioningBorderedButtonStyle())
            .disabled(!isDirty || isSaving)
            Button(isSaving ? String(localized: "Saving…") : String(localized: "Save")) {
                Task { await commit() }
            }
            .buttonStyle(StarlingsCTAButtonStyle())
            .disabled(!isDirty || isSaving || !draft.canSave(kind: kind))
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
    }

    // MARK: - The form

    @ViewBuilder
    private func form(_ detail: CrmSubjectDetail) -> some View {
        switch kind {
        case .project: projectSections(detail)
        case .lead: leadSections(detail)
        case .organization, .event: readOnlySections(detail)
        }
    }

    @ViewBuilder
    private func projectSections(_ detail: CrmSubjectDetail) -> some View {
        Section("Basic information") {
            TextField("Title", text: $draft.title)
            TextField("Description", text: $draft.description, axis: .vertical)
                .lineLimit(2...8)
            TextField("URL", text: $draft.url)
                .autocorrectionDisabled()
            if showsSpecFields {
                TextField("EVID", text: $draft.evid)
                    .autocorrectionDisabled()
            }
            Toggle("Internal", isOn: $draft.isInternal)
        }
        Section("Relationships") {
            relationRows(detail)
        }
        Section("Timeline") {
            statusPicker
            optionalDate("Start date", date: $draft.startDate)
            optionalDate("End date", date: $draft.endDate)
        }
        if showsSpecFields {
            Section("Project notes") {
                notesField("Contract", text: $draft.contract)
                notesField("Analytics", text: $draft.analytics)
                notesField("Authentication", text: $draft.authentication)
                notesField("Specs", text: $draft.specs)
                notesField("Technical", text: $draft.technical)
                notesField("Research", text: $draft.research)
                notesField("Design", text: $draft.design)
            }
        }
    }

    @ViewBuilder
    private func leadSections(_ detail: CrmSubjectDetail) -> some View {
        Section {
            ForEach(LeadQualification.checks) { check in
                Toggle(check.title, isOn: Binding(
                    get: { LeadQualification.isSet(check.key, in: draft.characteristics) },
                    set: { draft.characteristics = LeadQualification.merged(draft.characteristics, key: check.key, value: $0) }
                ))
            }
        } header: {
            Text("Qualification")
        } footer: {
            Text(LeadQualification.summary(draft.characteristics))
        }
        Section("Lead") {
            TextField("Title", text: $draft.title)
            statusPicker
            DatePicker("Start date", selection: Binding(
                get: { draft.startDate ?? Date() },
                set: { draft.startDate = $0 }
            ), displayedComponents: .date)
            relationRows(detail)
            notesField("Notes", text: $draft.notes)
        }
    }

    /// An organization or an event: what the Worker reads, no write.
    @ViewBuilder
    private func readOnlySections(_ detail: CrmSubjectDetail) -> some View {
        Section {
            LabeledContent("Name", value: detail.title)
            if let industry = detail.industry, !industry.isEmpty {
                LabeledContent("Industry", value: industry)
            }
            if let url = detail.url, !url.isEmpty {
                LabeledContent("URL", value: url)
            }
        }
    }

    /// The relations as names. Edit details… changes them.
    @ViewBuilder
    private func relationRows(_ detail: CrmSubjectDetail) -> some View {
        LabeledContent("Organization", value: detail.organizationName ?? String(localized: "None"))
        if kind == .project {
            LabeledContent("Lead", value: detail.related?.leads.first?.title ?? String(localized: "None"))
            LabeledContent("Contacts", value: contactNames(detail))
        } else {
            LabeledContent("Contact", value: contactNames(detail))
        }
    }

    private func contactNames(_ detail: CrmSubjectDetail) -> String {
        let ids = kind == .lead ? [detail.contactID].compactMap { $0 } : detail.contactIDs
        guard !ids.isEmpty else { return String(localized: "None") }
        let names = (detail.related?.contacts ?? [])
            .filter { ids.contains($0.id) }
            .compactMap { $0.name ?? $0.email }
        if names.count == ids.count { return names.joined(separator: ", ") }
        return ids.count == 1 ? String(localized: "1 contact") : String(localized: "\(ids.count) contacts")
    }

    private var statusPicker: some View {
        Picker("Status", selection: $draft.status) {
            ForEach(statusChoices, id: \.self) { value in
                Text(value).tag(value)
            }
        }
        .pickerStyle(.menu)
    }

    /// The registry's statuses, plus the record's own if it is not one of them.
    private var statusChoices: [String] {
        let known = SubjectStatusRegistry.choices(for: kind)?.statuses ?? []
        return known.contains(draft.status) || draft.status.isEmpty ? known : [draft.status] + known
    }

    private func notesField(_ title: LocalizedStringKey, text: Binding<String>) -> some View {
        TextField(title, text: text, axis: .vertical)
            .lineLimit(2...12)
    }

    @ViewBuilder
    private func optionalDate(_ title: LocalizedStringKey, date: Binding<Date?>) -> some View {
        Toggle(title, isOn: Binding(
            get: { date.wrappedValue != nil },
            set: { date.wrappedValue = $0 ? (date.wrappedValue ?? Date()) : nil }
        ))
        if date.wrappedValue != nil {
            DatePicker(title, selection: Binding(
                get: { date.wrappedValue ?? Date() },
                set: { date.wrappedValue = $0 }
            ), displayedComponents: .date)
            .labelsHidden()
        }
    }

    // MARK: - Load and save

    private func reload() async {
        do {
            let loaded = try await load()
            apply(loaded)
            loadError = nil
        } catch is CancellationError {
            return
        } catch {
            if detail == nil { loadError = error.localizedDescription }
        }
    }

    private func apply(_ loaded: CrmSubjectDetail) {
        detail = loaded
        saved = SubjectFieldsDraft(loaded)
        draft = saved
    }

    private func commit() async {
        guard let update = draft.update(from: saved, kind: kind) else {
            draft = saved
            return
        }
        isSaving = true
        saveError = nil
        defer { isSaving = false }
        do {
            let written = try await save(update)
            apply(written)
            onToast(String(localized: "Saved"))
            onSaved(written)
        } catch is CancellationError {
            return
        } catch {
            saveError = error.localizedDescription
        }
    }
}

/// What the Fields pane edits, as the form holds it. Text is the empty
/// string for none; a date is nil for none.
struct SubjectFieldsDraft: Equatable {
    var title = ""
    var status = ""
    var description = ""
    var url = ""
    var evid = ""
    var isInternal = false
    var startDate: Date?
    var endDate: Date?
    var notes = ""
    var characteristics: [String: Bool]?
    var specs = ""
    var technical = ""
    var research = ""
    var design = ""
    var contract = ""
    var analytics = ""
    var authentication = ""

    init() {}

    init(_ detail: CrmSubjectDetail) {
        title = detail.title
        status = detail.status
        description = detail.description ?? ""
        url = detail.url ?? ""
        evid = detail.evid ?? ""
        isInternal = detail.isInternal ?? false
        startDate = CrmTaskDate.date(detail.startDate)
        endDate = CrmTaskDate.date(detail.endDate)
        notes = detail.notes ?? ""
        characteristics = detail.characteristics
        specs = detail.specs ?? ""
        technical = detail.technical ?? ""
        research = detail.research ?? ""
        design = detail.design ?? ""
        contract = detail.contract ?? ""
        analytics = detail.analytics ?? ""
        authentication = detail.authentication ?? ""
    }

    /// A project needs a title; a lead needs a start date.
    func canSave(kind: MeetingCategoryKind.SubjectKind) -> Bool {
        switch kind {
        case .project: !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .lead: startDate != nil
        case .organization, .event: false
        }
    }

    /// The PATCH body: only the fields that changed since `saved`, so a field
    /// another person changed meanwhile stays theirs. Nil when nothing changed.
    func update(from saved: SubjectFieldsDraft, kind: MeetingCategoryKind.SubjectKind) -> CrmSubjectUpdate? {
        guard self != saved else { return nil }
        func text(_ field: KeyPath<SubjectFieldsDraft, String>) -> Patch<String> {
            guard self[keyPath: field] != saved[keyPath: field] else { return .omit }
            let value = self[keyPath: field].trimmingCharacters(in: .whitespacesAndNewlines)
            return value.isEmpty ? .null : .value(value)
        }
        func day(_ field: KeyPath<SubjectFieldsDraft, Date?>) -> Patch<String> {
            guard self[keyPath: field] != saved[keyPath: field] else { return .omit }
            return Patch(self[keyPath: field].map { CrmTaskDate.civilDay($0) })
        }
        let title = self.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let titleChanged = self.title != saved.title && !title.isEmpty
        let statusChanged = status != saved.status
        switch kind {
        case .lead:
            return .lead(CrmLeadUpdate(
                title: titleChanged ? .value(title) : .omit,
                status: statusChanged ? CrmLeadStatus(rawValue: status) : nil,
                startDate: startDate != saved.startDate ? startDate.map { CrmTaskDate.civilDay($0) } : nil,
                notes: text(\.notes),
                characteristics: characteristics != saved.characteristics ? Patch(characteristics) : .omit
            ))
        case .project:
            return .project(CrmProjectUpdate(
                title: titleChanged ? title : nil,
                description: text(\.description),
                url: text(\.url),
                specs: text(\.specs),
                technical: text(\.technical),
                research: text(\.research),
                design: text(\.design),
                contract: text(\.contract),
                analytics: text(\.analytics),
                authentication: text(\.authentication),
                evid: text(\.evid),
                startDate: day(\.startDate),
                endDate: day(\.endDate),
                status: statusChanged ? CrmProjectStatus(rawValue: status) : nil,
                isInternal: isInternal != saved.isInternal ? isInternal : nil
            ))
        case .organization, .event:
            return nil
        }
    }
}
