import EnvisioningUI
import StarlingsContracts
import SwiftUI

/// A task can be read from Mine or its subject without first opening its editor.
struct MobileTaskView: View {
    let subject: CrmSubject?
    /// Set only when `subject` is nil: Core named this task's subject without
    /// sending an id Mine's `CrmMyTask.subject` can resolve (a registry
    /// subject, not a project or lead). The row already shows this string —
    /// the reader should still say it, just without a link.
    private let unresolvedSubjectTitle: String?
    @State private var task: CrmTask
    @State private var isCompleteRecord: Bool
    @State private var error: String?
    @State private var busy = false
    @State private var editing: CrmTaskDraft?
    @State private var moving = false
    @State private var team: [CrmTeamMember] = []
    @State private var goals: [CrmGoal] = []
    @State private var teamError: String?
    @State private var haptic = StarlingsHapticPulse()
    /// The delete question, while it is asked.
    @State private var deleting: MobileTaskDeletion?
    /// The list behind this screen drops the row when the task is deleted.
    private let onDeleted: (String) -> Void
    @EnvironmentObject private var app: StarlingsAppModel
    @EnvironmentObject private var work: MobileMyWorkStore
    @Environment(\.dismiss) private var dismiss

    init(task: CrmTask, subject: CrmSubject?, onDeleted: @escaping (String) -> Void = { _ in }) {
        self.subject = subject
        self.onDeleted = onDeleted
        unresolvedSubjectTitle = nil
        _task = State(initialValue: task)
        _isCompleteRecord = State(initialValue: true)
    }

    init(summary: CrmMyTask, onDeleted: @escaping (String) -> Void = { _ in }) {
        subject = summary.subject
        self.onDeleted = onDeleted
        unresolvedSubjectTitle = summary.subject == nil ? summary.subjectTitle : nil
        _task = State(initialValue: Self.partial(summary))
        _isCompleteRecord = State(initialValue: false)
    }

    /// What Mine knows, with every subject key it carries — a partner task
    /// has only the organization, and `load()` needs it to ask Core for the
    /// full record.
    private static func partial(_ summary: CrmMyTask) -> CrmTask {
        CrmTask(
            id: summary.id, title: summary.title, status: summary.status, priority: summary.priority,
            githubOwner: summary.githubOwner, githubRepo: summary.githubRepo, githubIssueNumber: summary.githubIssueNumber,
            dueDate: summary.dueDate, projectID: summary.projectID, leadID: summary.leadID, eventID: summary.eventID,
            organizationID: summary.organizationID, meetingID: summary.meetingID
        )
    }

    /// "Partner · Echos", "Project · X", "Meeting", "No subject". Falls back to
    /// the kind alone when the name is not in hand.
    private var whereText: String {
        MobileTaskWhere.text(task: task, subject: subject, name: unresolvedSubjectTitle)
    }

    var body: some View {
        StarlingsList {
            Section {
                Text(task.title).font(.headline).textSelection(.enabled)
                if isCompleteRecord {
                    Text(task.notes?.isEmpty == false ? task.notes! : "No notes.")
                        .textSelection(.enabled)
                } else if let unresolvedSubjectTitle {
                    // Not a failure to retry — Core never sends an id for
                    // this task's subject, so there is nothing more to load.
                    Text("Open this task from \(unresolvedSubjectTitle) in Work.")
                        .foregroundStyle(.secondary)
                } else if subject == nil {
                    // No subject at all, not even a name — distinct from the
                    // case above, and just as unable to load more.
                    Text("This task has no subject.")
                        .foregroundStyle(.secondary)
                } else {
                    Text("Full details are not loaded yet.").foregroundStyle(.secondary)
                }
            }
            if let error {
                Section {
                    StarlingsErrorNotice(message: error, font: .body)
                    Button("Retry") { Task { await load() } }.meetHoverLift(cornerRadius: EnvisioningRadius.control)
                }
            }
            Section("Details") {
                // The one "Where": always present, so a task never leaves the
                // reader guessing what it hangs off. Tappable when the
                // subject is in hand.
                if let subject {
                    NavigationLink {
                        MobileSubjectView(subject: subject, initialPane: .tasks)
                    } label: { LabeledContent("Where", value: whereText) }
                } else {
                    LabeledContent("Where", value: whereText)
                }
                LabeledContent("Status", value: task.status.menuTitle)
                if isCompleteRecord {
                    LabeledContent("Responsible", value: task.responsibleParty.title)
                    if let name = task.assigneeName { LabeledContent("Assigned to", value: name) }
                    if let email = task.assigneeEmail { LabeledContent("Email", value: email) }
                    if let goal = task.goalID.flatMap({ id in goals.first { $0.id == id } }) {
                        LabeledContent("Goal", value: goal.title)
                    }
                }
                // Parsed and formatted like the list row and the web reader,
                // not the wire string (#228). Due is a day; Updated is a clock.
                if let due = CrmTaskDate.date(task.dueDate) {
                    LabeledContent("Due", value: StarlingsDateFormatting.date(due))
                }
                if let priority = task.priority { LabeledContent("Priority", value: priority) }
                if !task.tags.isEmpty { LabeledContent("Tags", value: task.tags.joined(separator: ", ")) }
                if let updated = CrmTaskDate.date(task.updatedAt) {
                    LabeledContent("Updated", value: updated.meetDateTimeString(dateStyle: .abbreviated))
                }
                if let owner = task.githubOwner, let repo = task.githubRepo, let number = task.githubIssueNumber,
                   let url = URL(string: "https://github.com/\(owner)/\(repo)/issues/\(number)") {
                    Link("GitHub issue #\(number)", destination: url).meetHoverLift(cornerRadius: EnvisioningRadius.control)
                }
            }
            Section {
                Button("Edit task") { editing = CrmTaskDraft(task: task) }
                    .disabled(!isCompleteRecord || busy).meetHoverLift(cornerRadius: EnvisioningRadius.control)
                if let subject, subject.kind == "project", task.githubIssueNumber == nil {
                    Button("File on GitHub") { Task { await fileOnGitHub(subject) } }
                        .disabled(busy || !isCompleteRecord).meetHoverLift(cornerRadius: EnvisioningRadius.control)
                }
                if task.status != .completed {
                    Button("Done") { Task { await complete() } }.disabled(busy).meetHoverLift(cornerRadius: EnvisioningRadius.control)
                }
                // Move to…: onto another project, lead, partner or event.
                // The task leaves this list, so the view goes with it.
                Button("Move to…") { moving = true }
                    .disabled(busy).meetHoverLift(cornerRadius: EnvisioningRadius.control)
                // Delete: asks first; the screen closes after.
                Button(TaskDeleteCopy.confirm, role: .destructive) {
                    deleting = MobileTaskDeletion(id: task.id, title: task.title)
                }
                .disabled(busy).meetHoverLift(cornerRadius: EnvisioningRadius.control)
            }
            // What was said about it: the hand-off, the agent's work, its questions.
            MobileCardActivitySection(refKind: "task", refID: task.id)
        }
        .sheet(isPresented: $moving) {
            MobileSubjectPicker(kinds: MeetingCategoryKind.SubjectKind.kinds(with: .tasks), search: { kind, query in
                guard let credentials = app.ownerCredentials else { return [] }
                return (try? await app.api.crmSubjects(credentials: credentials, kind: kind, query: query)) ?? []
            }, onPick: { picked in
                Task { await move(to: picked) }
            })
            .meetAlertHost()
        }
        .navigationTitle("Task")
        .navigationBarTitleDisplayMode(.inline)
        .taskDeleteConfirmation($deleting) { _ in
            Task { await delete() }
        }
        .meetHaptics(haptic)
        .meetHaptic(.error, whenSet: error)
        .task { await load() }
        .sheet(item: $editing) { draft in
            MobileTaskEditor(
                draft: draft, team: team, teamError: teamError,
                goals: GoalsDecisions.sorted(goals.filter { GoalsDecisions.isLive($0) || $0.id == draft.goalID }),
                whereText: whereText
            ) { next in
                Task { await save(next) }
            }.meetAlertHost()
        }
    }

    private func load() async {
        guard let credentials = app.ownerCredentials else { return }
        // The full record by id, whatever the task is filed on: Mine's summary
        // carries no responsible party or assignee, so the reader and editor
        // must never run on it. Falls back to the subject's list when the
        // by-id read fails and a subject key can ask for it.
        if !isCompleteRecord {
            do {
                task = try await app.api.crmTask(credentials: credentials, id: task.id)
                isCompleteRecord = true; error = nil
            } catch {
                await loadFromSubjectList(credentials, failure: error)
            }
        } else if task.projectID != nil || task.leadID != nil || task.eventID != nil || task.partnerOrganizationID != nil || task.meetingID != nil {
            // Already complete (opened from a subject list): refresh it.
            if let full = try? await app.api.crmTask(credentials: credentials, id: task.id) { task = full }
        }
        do { team = try await app.api.crmTeam(credentials: credentials); teamError = nil }
        catch { teamError = error.localizedDescription }
        // Goals for the sheet's picker; a failure hides the row.
        if let projectID = task.projectID {
            goals = (try? await app.api.crmGoals(credentials: credentials, projectID: projectID, includeClosed: true)) ?? goals
        }
    }

    private func loadFromSubjectList(_ credentials: MobileOwnerCredentials, failure: Error) async {
        guard task.projectID != nil || task.leadID != nil || task.eventID != nil || task.partnerOrganizationID != nil || task.meetingID != nil else {
            self.error = failure.localizedDescription
            return
        }
        do {
            let rows = try await app.api.crmTasks(credentials: credentials,
                projectID: task.projectID, leadID: task.leadID, eventID: task.eventID,
                organizationID: task.partnerOrganizationID, meetingID: task.meetingID)
            if let full = rows.first(where: { $0.id == task.id }) {
                task = full; isCompleteRecord = true; error = nil
            } else { error = failure.localizedDescription }
        } catch { self.error = error.localizedDescription }
    }

    private func fileOnGitHub(_ subject: CrmSubject) async {
        guard !busy, let credentials = app.ownerCredentials else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await app.api.createCrmIssue(credentials: credentials,
                .promotion(projectID: subject.id, taskID: task.id, title: task.title, body: task.notes))
            await load()
            await work.refresh()
        } catch { self.error = error.localizedDescription }
    }

    private func complete() async {
        await write(.completion(true))
        if error == nil { haptic.fire(.success) }
    }

    private func save(_ draft: CrmTaskDraft) async {
        await write(CrmTaskUpdate(title: draft.title.trimmingCharacters(in: .whitespacesAndNewlines),
            notes: draft.notes, status: draft.status.rawValue, responsibleParty: draft.responsible.rawValue,
            assignedTo: Patch(draft.assignedTo), dueDate: Patch(draft.dueDate.map(CrmTaskDate.wire)),
            goalID: goals.isEmpty ? .omit : Patch(draft.goalID)))
        if error != nil { editing = draft }
    }

    private func move(to picked: CrmSubject) async {
        // A partner is its organization on the wire.
        guard let kind = picked.isPartner ? CrmTaskSubjectRef.Kind.organization : CrmTaskSubjectRef.Kind(rawValue: picked.kind) else { return }
        let destination = CrmTaskSubjectRef(kind: kind, id: picked.id)
        guard destination != CrmTaskSubjectRef(task: task) else { return }
        if await write(.move(task, to: destination)) { dismiss() }
    }

    /// Delete the task, then close: there is nothing left to read.
    private func delete() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            try await work.deleteTask(id: task.id)
            error = nil
            haptic.fire(.destructive)
            onDeleted(task.id)
            dismiss()
        } catch {
            self.error = (error as? StarlingsError)?.message ?? TaskDeleteCopy.failure
        }
    }

    /// True when Core took the change.
    @discardableResult
    private func write(_ update: CrmTaskUpdate) async -> Bool {
        guard !busy, let credentials = app.ownerCredentials else { return false }
        busy = true
        defer { busy = false }
        do {
            task = try await app.api.updateCrmTask(credentials: credentials, id: task.id, update: update)
            isCompleteRecord = true; error = nil
            await work.refresh()
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
}

/// Where a task lives, in words: kind, then name when it is known.
enum MobileTaskWhere {
    static func text(task: CrmTask?, subject: CrmSubject?, name: String?) -> String {
        let kind = kindTitle(task: task, subject: subject)
        let title = (subject?.title ?? name)?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let title, !title.isEmpty, kind != String(localized: "No subject") else { return kind }
        return kind + " · " + title
    }

    static func kindTitle(task: CrmTask?, subject: CrmSubject?) -> String {
        if let subject {
            if let kind = MeetingCategoryKind.SubjectKind(rawValue: subject.kind) { return kind.label }
            if subject.kind == "meeting" { return String(localized: "Meeting") }
        }
        if let task {
            if task.projectID != nil { return String(localized: "Project") }
            if task.leadID != nil { return String(localized: "Lead") }
            if task.eventID != nil { return String(localized: "Event") }
            if task.partnerOrganizationID != nil { return String(localized: "Partner") }
            if task.meetingID != nil { return String(localized: "Meeting") }
        }
        return subject == nil ? String(localized: "No subject") : String(localized: "Subject")
    }
}

/// One task by id, from a channel's chip: the line carries the id and nothing
/// else, so the record is read here and then shown by the reader a tap on a
/// task row opens.
struct MobileTaskDoor: View {
    let id: String
    let subject: CrmSubject?

    @EnvironmentObject private var app: StarlingsAppModel
    @State private var task: CrmTask?
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if let task {
                MobileTaskView(task: task, subject: subject)
            } else if let errorMessage {
                StarlingsErrorNotice(message: errorMessage)
                    .padding()
                    .navigationTitle("Task")
            } else {
                StarlingsList { Section { EnvisioningPlaceholderRows() } }
                    .navigationTitle("Task")
            }
        }
        .task {
            guard task == nil, let credentials = app.ownerCredentials else { return }
            do {
                task = try await app.api.crmTask(credentials: credentials, id: id)
            } catch {
                errorMessage = (error as? StarlingsError)?.message ?? error.localizedDescription
            }
        }
    }
}

/// A task someone asked to delete, while the question is up.
struct MobileTaskDeletion: Identifiable, Equatable {
    let id: String
    let title: String
}

extension View {
    /// The one task delete question on the phone: the title, the
    /// line that it can't be undone, a destructive Delete and Cancel.
    func taskDeleteConfirmation(
        _ pending: Binding<MobileTaskDeletion?>,
        onDelete: @escaping (MobileTaskDeletion) -> Void
    ) -> some View {
        confirmationDialog(
            pending.wrappedValue.map { TaskDeleteCopy.title($0.title) } ?? "",
            isPresented: Binding(
                get: { pending.wrappedValue != nil },
                set: { if !$0 { pending.wrappedValue = nil } }
            ),
            titleVisibility: .visible,
            presenting: pending.wrappedValue
        ) { deletion in
            Button(TaskDeleteCopy.confirm, role: .destructive) { onDelete(deletion) }
            Button(TaskDeleteCopy.cancel, role: .cancel) {}
        } message: { _ in
            Text(TaskDeleteCopy.message)
        }
    }
}
