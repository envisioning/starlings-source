import EnvisioningUI
import SwiftUI

/// How this meeting is filed in Core: a status call, a lead, a project, a
/// partner, or internal. Envisioning-only — a guest never sees this, and the Worker holds
/// the Core credentials, so nothing here talks to Core directly.
///
/// Filing early matters more than filing perfectly: the CRM row opens when the
/// meeting starts, so a meeting that is never finalized still shows on the
/// timeline with whatever it was filed as.
struct MobileMeetingFilingView: View {
    @ObservedObject var host: MobileRoomHost
    let api: StarlingsAPI
    let credentials: MobileOwnerCredentials
    @Environment(\.dismiss) private var dismiss

    @State private var kind: MeetingCategoryKind = .uncategorized
    @State private var subject: CrmSubject?
    @State private var query = ""
    @State private var matches: [CrmSubject] = []
    @State private var isSearching = false
    @State private var isSaving = false
    @State private var failure: String?
    @State private var searchTask: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            StarlingsForm {
                Section("Filed as") {
                    Picker("Kind", selection: $kind) {
                        ForEach(MeetingCategoryKind.filingMenu(offersPartner: true, current: kind), id: \.self) { kind in
                            Text(kind.menuTitle).tag(kind)
                        }
                    }
                    .pickerStyle(.menu)
                }

                if kind.needsSubject {
                    Section(kind.menuTitle) {
                        if let subject {
                            LabeledContent(subject.title, value: "Selected")
                            // Pushed inside this sheet: leaving the call for the Work
                            // tab would end the meeting, so the subject opens here.
                            NavigationLink("Open in Work") { MobileSubjectView(subject: subject) }
                            Button("Choose a different one") { self.subject = nil }
                        } else {
                            TextField("Search", text: $query)
                                .autocorrectionDisabled()
                            if isSearching && matches.isEmpty {
                                EnvisioningPlaceholderRows(count: 2)
                            }
                            ForEach(matches) { match in
                                Button {
                                    subject = match
                                } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(match.title)
                                        if let subtitle = match.subtitle {
                                            Text(subtitle)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                }
                            }
                            if !isSearching && matches.isEmpty && !query.isEmpty {
                                Text("Nothing matches that.").foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                if let failure {
                    Section { StarlingsErrorNotice(message: failure, font: .body) }
                }
            }
            .navigationTitle("File this meeting")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(isSaving || (kind.needsSubject && subject == nil))
                        .meetToolbarConfirm()
                }
            }
            .task { await load() }
            // Debounced rather than per-keystroke: this is a network search
            // against Core, and the Worker is not a typeahead cache.
            .onChange(of: query) { _, text in
                searchTask?.cancel()
                guard kind.needsSubject, text.count >= 2 else {
                    matches = []
                    return
                }
                searchTask = Task {
                    try? await Task.sleep(for: .milliseconds(300))
                    guard !Task.isCancelled else { return }
                    await search(text)
                }
            }
            .onChange(of: kind) { _, _ in
                subject = nil
                matches = []
                query = ""
            }
        }
    }

    private func load() async {
        guard let room = host.room, let meetingID = host.meetingID else { return }
        do {
            let category = try await api.meetingCategory(
                credentials: credentials,
                room: room,
                meetingID: meetingID
            )
            kind = category.meetingKind
            if let title = category.subjectTitle {
                subject = CrmSubject(
                    id: category.subjectID ?? title,
                    kind: kind.subjectKind?.rawValue ?? kind.rawValue,
                    title: title,
                    subtitle: nil
                )
            }
        } catch {
            failure = (error as? StarlingsError)?.message ?? error.localizedDescription
        }
    }

    private func search(_ text: String) async {
        guard let subjectKind = kind.subjectKind else { return }
        isSearching = true
        defer { isSearching = false }
        do {
            matches = try await api.crmSubjects(
                credentials: credentials,
                kind: subjectKind,
                query: text
            )
        } catch {
            failure = (error as? StarlingsError)?.message ?? error.localizedDescription
        }
    }

    private func save() async {
        guard let room = host.room, let meetingID = host.meetingID else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await api.setMeetingCategory(
                credentials: credentials,
                room: room,
                meetingID: meetingID,
                update: MeetingCategoryUpdate(meetingKind: kind, subjectID: subject?.id, subjectTitle: subject?.title)
            )
            dismiss()
        } catch {
            failure = (error as? StarlingsError)?.message ?? error.localizedDescription
        }
    }
}
