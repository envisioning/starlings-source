import SwiftUI

/// Choosing who is in a private conversation.
///
/// One decision, made once, in one sheet — a flow that asked for each name
/// separately would make starting a conversation feel like building something.
/// Two people is the floor: one is the direct message their roster row already
/// opens, and offering the same thing twice is how a surface gets confusing.
///
/// Nothing is created here. The sheet answers who was chosen, and the caller
/// opens the conversation — which is find-or-create at the Worker, so choosing
/// the same people twice reopens what exists rather than making a second one.
struct MobileGroupPicker: View {
    let candidates: [Peer]
    /// How many others one conversation holds. Past this the thing being asked
    /// for is Everyone, which already exists.
    let maximum: Int
    let onChoose: ([Peer]) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var chosen: Set<String> = []

    var body: some View {
        NavigationStack {
            StarlingsList {
                Section {
                    ForEach(candidates) { peer in
                        Button {
                            if chosen.contains(peer.email) {
                                chosen.remove(peer.email)
                            } else if chosen.count < maximum {
                                chosen.insert(peer.email)
                            }
                        } label: {
                            HStack {
                                Text(peer.displayName)
                                    .foregroundStyle(.primary)
                                Spacer()
                                if chosen.contains(peer.email) {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(StarlingsMobileColors.accent)
                                }
                            }
                        }
                        // At the ceiling the unchosen rows go quiet rather than
                        // the choice being refused after the fact: a limit that
                        // only speaks when you hit it reads as a bug.
                        .disabled(!chosen.contains(peer.email) && chosen.count >= maximum)
                    }
                    if candidates.isEmpty {
                        Text("Nobody else has signed in yet.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } footer: {
                    Text("Everyone you choose can read it.")
                }
            }
            .navigationTitle("New group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Open") {
                        onChoose(candidates.filter { chosen.contains($0.email) })
                        dismiss()
                    }
                    .disabled(chosen.count < 2)
                    .meetToolbarConfirm()
                }
            }
        }
        .meetHalfSheet()
    }
}
