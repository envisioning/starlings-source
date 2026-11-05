import EnvisioningUI
import StarlingsContracts
import SwiftUI

/// Win on an open lead (ADR 0008 decisions 6-7): the member edits the
/// project's title and checks which of the lead's open tasks move. The
/// Worker creates the project, moves the checked tasks, then closes the lead.
struct MobileLeadWinView: View {
    let lead: CrmSubject
    let onWon: (CrmLeadWinResponse) -> Void

    @EnvironmentObject private var app: StarlingsAppModel
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var tasks: [CrmTask] = []
    @State private var moving: Set<String> = []
    @State private var isLoading = false
    @State private var isSaving = false
    @State private var errorMessage: String?

    /// The statuses that move with a win. Proposed work is not yet accepted
    /// and finished work stays where it was done.
    private static let movable: Set<CrmTaskStatus> = [.pending, .inProgress, .review, .blocked]

    init(lead: CrmSubject, onWon: @escaping (CrmLeadWinResponse) -> Void) {
        self.lead = lead
        self.onWon = onWon
        _title = State(initialValue: lead.title)
    }

    var body: some View {
        NavigationStack {
            StarlingsForm {
                Section {
                    TextField("Name", text: $title)
                        .textInputAutocapitalization(.sentences)
                } header: {
                    Text("Project")
                }

                if !tasks.isEmpty {
                    Section("Open tasks") {
                        ForEach(tasks) { task in
                            Toggle(task.title, isOn: Binding(
                                get: { moving.contains(task.id) },
                                set: { isOn in
                                    if isOn { moving.insert(task.id) } else { moving.remove(task.id) }
                                }
                            ))
                            .meetToggleTint()
                        }
                    }
                }

                if let errorMessage {
                    Section {
                        StarlingsErrorNotice(message: errorMessage)
                    }
                }
            }
            .disabled(isLoading || isSaving)
            .navigationTitle(String(localized: "Win lead"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isLoading {
                        ProgressView().controlSize(.small)
                    } else {
                        Button(isSaving ? String(localized: "Winning…") : String(localized: "Win")) { Task { await win() } }
                            .disabled(isSaving || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .meetToolbarConfirm()
                    }
                }
            }
            .task(id: lead.id) { await loadTasks() }
        }
    }

    private func loadTasks() async {
        guard let credentials = app.ownerCredentials else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let open = try await app.api.crmTasks(credentials: credentials, projectID: nil, leadID: lead.id)
                .filter { Self.movable.contains($0.status) }
            tasks = open
            moving = Set(open.map(\.id))
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func win() async {
        guard let credentials = app.ownerCredentials else { return }
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanTitle.isEmpty else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            // Ids in list order, so the request reads the way the sheet does.
            let taskIDs = tasks.map(\.id).filter { moving.contains($0) }
            let response = try await app.api.winLead(
                credentials: credentials,
                id: lead.id,
                body: CrmLeadWin(title: .value(cleanTitle), taskIDs: taskIDs)
            )
            errorMessage = nil
            onWon(response)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
