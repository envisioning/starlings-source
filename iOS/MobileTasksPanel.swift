import SwiftUI

/// Tasks the meeting proposed, and the one control that matters: accept or
/// dismiss.
///
/// A suggestion is local to this device until it is accepted. Accepting writes
/// a CRM row through the same path a hand-typed task takes, carrying the quote
/// as provenance; dismissing is local and final for this meeting. Core requires
/// every task to belong to a project or lead, so accepting opens a small sheet
/// where the filing happens — and the task defaults to the person accepting it,
/// because work accepted by somebody is theirs until they hand it off. Nothing
/// here writes to Core on its own — see docs/TASK_SUGGESTIONS.md.
struct MobileTasksPanel: View {
    @ObservedObject var host: MobileRoomHost
    @Environment(\.dismiss) private var dismiss
    @State private var editing: TaskSuggestion?
    @State private var draftTitle = ""
    @State private var draftNotes = ""
    @State private var busy: Set<UUID> = []
    @State private var options: MobileRoomHost.TaskFilingOptions?
    @State private var draftSubjectID: String?
    @State private var draftAssigneeID: String?
    /// The subject the meeting is filed under, and what is open on it — the Mac's TASKS block
    /// lists these beside the suggestions.
    @State private var filedTitle: String?
    @State private var filedTasks: [CrmTask] = []
    @State private var filedError: String?

    var body: some View {
        NavigationStack {
            StarlingsList {
                if let note = host.suggestionNote {
                    // Why the panel is empty. Without this, "no suggestions"
                    // and "suggestions cannot run here" look identical.
                    Section { Text(note).font(.subheadline).foregroundStyle(.secondary) }
                }
                if host.proposedTasks.isEmpty && host.suggestionNote == nil {
                    Section {
                        Text("No suggestions yet.")
                            .foregroundStyle(.secondary)
                    }
                }
                ForEach(host.proposedTasks) { suggestion in
                    row(suggestion)
                }
                if let filedTitle {
                    Section {
                        if let filedError {
                            StarlingsErrorNotice(message: filedError, font: .body)
                        } else if filedTasks.isEmpty {
                            Text("Nothing open.").foregroundStyle(.secondary)
                        }
                        ForEach(filedTasks.prefix(10)) { task in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(task.title)
                                Text([task.status.menuTitle, MobileDayLabel.text(task.dueDate).map { String(localized: "Due \($0)") }, task.assigneeName]
                                    .compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption)
                                    .foregroundStyle(task.isOverdue ? StarlingsMobileColors.danger : Color.secondary)
                            }
                            .padding(.vertical, 2)
                        }
                    } header: {
                        Text("Open on \(filedTitle)")
                    }
                }
            }
            .navigationTitle("Tasks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .meetToolbarConfirm()
                }
            }
            .sheet(item: $editing) { suggestion in
                editor(suggestion)
            }
            // Fetched once for the panel's life: the sheet must open with the
            // projects already there, not with a spinner where filing goes.
            .task { options = await host.taskFilingOptions() }
            .task { await loadFiledTasks() }
        }
    }

    /// What is open on the subject this meeting is filed under; nothing while it is unfiled.
    private func loadFiledTasks() async {
        guard let credentials = host.credentials, let room = host.room, let meetingID = host.meetingID else { return }
        let api = StarlingsAPI(environment: .configured())
        guard let category = try? await api.meetingCategory(credentials: credentials, room: room, meetingID: meetingID),
              let kind = category.meetingKind.subjectKind,
              let subjectID = category.subjectID else { return }
        filedTitle = category.subjectTitle ?? String(localized: "this subject")
        do {
            filedTasks = try await api.crmTasks(
                credentials: credentials,
                projectID: kind == .project ? subjectID : nil,
                leadID: kind == .lead ? subjectID : nil,
                organizationID: kind == .organization ? subjectID : nil
            )
            filedError = nil
        } catch {
            filedError = (error as? StarlingsError)?.message ?? error.localizedDescription
        }
    }

    private func row(_ suggestion: TaskSuggestion) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(suggestion.title).font(.headline)
            // The verbatim span, always. It is the provenance and the check
            // that keeps an invented task off the screen.
            Text(suggestion.provenanceNote)
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                // One control, not two: a task cannot be written without a
                // subject, so there is no accept that skips the sheet.
                Button("Accept…") {
                    draftTitle = suggestion.title
                    draftNotes = suggestion.provenanceNote
                    editing = suggestion
                }
                .buttonStyle(StarlingsFilledButtonStyle.compact)
                Button("Dismiss") {
                    Task { await host.dismissTask(suggestion) }
                }
                .buttonStyle(StarlingsBorderedButtonStyle.compact)
            }
            .disabled(busy.contains(suggestion.id))
        }
        .padding(.vertical, 4)
    }

    /// Where the filing happens: title and notes to polish, a subject to file
    /// under, and who owes it — defaulting to the person accepting.
    private func editor(_ suggestion: TaskSuggestion) -> some View {
        let filing = options ?? .none
        return NavigationStack {
            StarlingsForm {
                Section("Task") {
                    TextField("Title", text: $draftTitle)
                    TextField("Notes", text: $draftNotes, axis: .vertical).lineLimit(3...6)
                }
                Section("File under") {
                    if filing.subjects.isEmpty {
                        // The honest reason Create is disabled, where it is
                        // noticed.
                        Text(
                            options == nil
                                ? String(localized: "Loading projects, leads and partners…")
                                : "No projects, leads or partners found."
                        )
                        .foregroundStyle(.secondary)
                    } else {
                        StarlingsSearchablePicker(
                            label: String(localized: "Subject"),
                            placeholder: String(localized: "Choose a project, lead or partner"),
                            options: filing.subjects.map { subject in
                                StarlingsSearchablePickerOption(
                                    id: "\(subject.kind):\(subject.id)",
                                    title: subject.title,
                                    context: subject.kind == "project" ? String(localized: "Project")
                                        : subject.isPartner ? String(localized: "Partner") : String(localized: "Lead"),
                                    subtitle: subject.subtitle
                                )
                            },
                            selection: Binding(
                                get: { draftSubjectID ?? "" },
                                set: { draftSubjectID = $0.isEmpty ? nil : $0 }
                            ),
                            emptyMessage: String(localized: "No options match that search.")
                        )
                    }
                }
                Section {
                    LabeledContent("Responsible", value: suggestion.responsibleGuess.rawValue.capitalized)
                    if !filing.team.isEmpty {
                        StarlingsSearchablePicker(
                            label: String(localized: "Assignee"),
                            placeholder: String(localized: "Nobody yet"),
                            options: [StarlingsSearchablePickerOption(id: "", title: String(localized: "Nobody yet"))]
                                + filing.team.assigneeOptions,
                            selection: Binding(
                                get: { draftAssigneeID ?? "" },
                                set: { draftAssigneeID = $0.isEmpty ? nil : $0 }
                            ),
                            emptyMessage: String(localized: "No options match that search.")
                        )
                    }
                }
            }
            .navigationTitle("Accept task")
            .navigationBarTitleDisplayMode(.inline)
            // Yours until you hand it off — but only ever as a starting point,
            // and never over a choice already made.
            .onAppear { if draftAssigneeID == nil { draftAssigneeID = filing.selfID } }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { editing = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        guard let subject = filing.subjects.first(where: { "\($0.kind):\($0.id)" == draftSubjectID }) else { return }
                        let title = draftTitle
                        let notes = draftNotes
                        let assignee = draftAssigneeID
                        editing = nil
                        Task { await accept(suggestion, title: title, notes: notes, subject: subject, assignee: assignee) }
                    }
                    .disabled(
                        draftTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || draftSubjectID == nil
                    )
                    .meetToolbarConfirm()
                }
            }
        }
    }

    private func accept(
        _ suggestion: TaskSuggestion,
        title: String,
        notes: String?,
        subject: CrmSubject,
        assignee: String?
    ) async {
        busy.insert(suggestion.id)
        defer { busy.remove(suggestion.id) }
        await host.acceptTask(suggestion, title: title, notes: notes, subject: subject, assignedTo: assignee)
    }
}
