import EnvisioningUI
import StarlingsContracts
import SwiftUI

/// The one write a hand-off makes on the phone (docs/SURFACES.md):
/// a message in the subject's channel, @mentioning the agent, that carries the card's ref and the brief, the one
/// the Mac and the web send. The runtime reads the card from the ref and the
/// brief from `handoff`; the text repeats both for the person who reads the
/// conversation later. The Board and a subject's task rows both send it.
@MainActor
enum MobileHandOff {
    static func send(app: StarlingsAppModel, target: HandOffTarget, to agent: Peer, handoff: ThreadHandoff) async throws {
        guard let credentials = app.ownerCredentials else { return }
        let thread = if let kind = target.subjectKind, let id = target.subjectID {
            try await app.api.openSubjectThread(credentials: credentials, kind: kind, subjectID: id)
        } else {
            try await app.api.openThread(credentials: credentials, peerEmail: agent.email)
        }
        let line = HandOffText.cardLine(issueNumber: target.issueNumber, title: target.title)
        let text = HandOffText.message(cardLine: line, doneWhen: handoff.doneWhen, deliverable: handoff.deliverable)
        _ = try await app.api.sendMessage(
            credentials: credentials,
            threadID: thread.id,
            text: target.inChannel ? HandOffText.addressed(text, to: agent.email) : text,
            refs: [target.ref],
            mentions: target.inChannel ? [agent.email] : [],
            handoff: handoff
        )
    }
}

/// A row's "Hand off to …" waiting for its brief.
struct MobileHandOffRequest: Identifiable {
    let target: HandOffTarget
    let agent: Peer
    var id: String { "\(target.ref.kind):\(target.ref.id):\(agent.email)" }
}

/// Hand off on the phone: the agent, what done looks like and
/// what comes back. Both are required, as on the Mac and the web.
struct MobileHandOffEditor: View {
    let cardTitle: String
    let agents: [Peer]
    /// The agent chosen from a row's "Hand off to …"; the picker can change it.
    let preselected: Peer?
    let onHandOff: (Peer, ThreadHandoff) -> Void

    @State private var agentEmail = ""
    @State private var doneWhen = ""
    @State private var deliverable = ""
    @Environment(\.dismiss) private var dismiss

    private var trimmedDone: String { doneWhen.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedDeliverable: String { deliverable.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var agent: Peer? {
        agents.first { $0.email == agentEmail } ?? preselected ?? agents.first
    }

    var body: some View {
        NavigationStack {
            StarlingsForm {
                Section {
                    Text(cardTitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Section {
                    StarlingsSearchablePicker(
                        label: String(localized: "Agent"),
                        placeholder: agent?.displayName ?? "",
                        options: agents.map { StarlingsSearchablePickerOption(id: $0.email, title: $0.displayName) },
                        selection: Binding(get: { agent?.email ?? "" }, set: { agentEmail = $0 }),
                        emptyMessage: String(localized: "No options match that search.")
                    )
                }
                Section("Done when") {
                    TextField("What is true when this is finished", text: $doneWhen, axis: .vertical)
                        .lineLimit(1...4)
                }
                Section("Deliverable") {
                    TextField("A pull request, a document, a message", text: $deliverable, axis: .vertical)
                        .meetSingleLine($deliverable)
                }
            }
            .navigationTitle("Hand off")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Hand off") {
                        guard let agent else { return }
                        onHandOff(agent, ThreadHandoff(doneWhen: trimmedDone, deliverable: trimmedDeliverable))
                        dismiss()
                    }
                    .disabled(agent == nil || trimmedDone.isEmpty || trimmedDeliverable.isEmpty)
                    .meetToolbarConfirm()
                }
            }
        }
    }
}
