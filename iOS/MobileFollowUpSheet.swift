import EnvisioningUI
import StarlingsContracts
import SwiftUI

/// After the call, on the phone: the follow-up drafted for the
/// people outside, the call's tasks with a switch each, and Approve. Approve
/// accepts the switched-on tasks, declines the rest, and opens the draft in
/// the host's own mail app, where it is edited and sent. Starlings sends
/// nothing. The Mac's `FollowUpSheet`.
struct MobileFollowUpSheet: View {
    let item: InboxFollowUpItem
    let onApprove: (_ accept: [String], _ decline: [String]) -> Void
    let onDismiss: () -> Void

    @State private var kept: Set<String>
    @Environment(\.dismiss) private var dismiss

    init(item: InboxFollowUpItem, onApprove: @escaping (_ accept: [String], _ decline: [String]) -> Void, onDismiss: @escaping () -> Void) {
        self.item = item
        self.onApprove = onApprove
        self.onDismiss = onDismiss
        _kept = State(initialValue: Set(item.tasks.map(\.id)))
    }

    var body: some View {
        NavigationStack {
            StarlingsForm {
                Section {
                    Text("To \(item.recipients.map(\.name).joined(separator: ", "))")
                        .font(.subheadline.weight(.semibold))
                    Text(item.draft.subject)
                        .font(.headline)
                    Text(item.draft.body)
                        .font(.callout)
                        .textSelection(.enabled)
                }
                if !item.tasks.isEmpty {
                    Section("Tasks from this call") {
                        ForEach(item.tasks, id: \.id) { task in
                            Toggle(task.title, isOn: Binding(
                                get: { kept.contains(task.id) },
                                set: { on in if on { kept.insert(task.id) } else { kept.remove(task.id) } }
                            ))
                        }
                    }
                }
                Section {
                    Text("Approve opens this in your mail app. Edit it there, then send it.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button("Approve") {
                        onApprove(
                            item.tasks.filter { kept.contains($0.id) }.map(\.id),
                            item.tasks.filter { !kept.contains($0.id) }.map(\.id)
                        )
                        dismiss()
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                    .meetHoverLift(cornerRadius: EnvisioningRadius.control)
                    Button("Dismiss", role: .destructive) {
                        onDismiss()
                        dismiss()
                    }
                }
            }
            .navigationTitle("Follow-up")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { dismiss() }
                }
            }
        }
    }
}

extension InboxFollowUpItem: @retroactive Identifiable {
    public var id: String { key }
}
