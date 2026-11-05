import EnvisioningUI
import SwiftUI

struct MobileAttentionQuestionSheet: View {
    @StateObject private var state: AttentionQuestionState
    @EnvironmentObject private var app: StarlingsAppModel
    @EnvironmentObject private var work: MobileMyWorkStore
    @Environment(\.dismiss) private var dismiss

    init(request: AttentionRequest) { _state = StateObject(wrappedValue: AttentionQuestionState(request)) }
    private var email: String? { app.ownerCredentials?.owner.email }
    var body: some View {
        NavigationStack {
            StarlingsForm {
                Section {
                    Text(state.request.prompt).font(.headline).textSelection(.enabled)
                    Text("Asked by \(state.request.askedBy)").font(.subheadline.weight(.semibold))
                    if let context = state.request.subject?.title ?? state.request.context {
                        Text(context).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if let status = state.request.terminalLabel {
                    Section {
                        Text(status)
                        if let answer = state.request.answer { Text(answer.optionLabels.joined(separator: ", ")) }
                    }
                } else if state.fresh && email?.lowercased() != state.request.recipientEmail.lowercased() {
                    Section { Text("Waiting on \(state.request.recipientEmail)") }
                } else {
                    Section {
                        ForEach(state.request.options, id: \.id) { option in
                            Button {
                                state.toggle(option.id)
                                if state.request.selectionMode == .single { resolve(.answer) }
                            } label: {
                                HStack {
                                    Text(option.label); Spacer()
                                    if state.selected.contains(option.id) { Image(systemName: "checkmark") }
                                }
                                .frame(minHeight: 44)
                            }
                            .buttonStyle(.bordered)
                            .meetHoverLift(cornerRadius: EnvisioningRadius.control)
                            .disabled(!state.canAnswer(as: email))
                            .accessibilityAddTraits(state.selected.contains(option.id) ? .isSelected : [])
                        }
                        if state.request.selectionMode == .multiple {
                            Button("Submit answer") { resolve(.answer) }
                                .buttonStyle(.bordered)
                                .meetHoverLift(cornerRadius: EnvisioningRadius.control)
                                .disabled(!state.canAnswer(as: email) || state.selected.isEmpty)
                        }
                        Button("Dismiss") { resolve(.dismiss) }
                            .buttonStyle(.bordered)
                            .meetHoverLift(cornerRadius: EnvisioningRadius.control)
                            .disabled(!state.canAnswer(as: email))
                    }
                }
                if let error = state.error { Section { Text(error).foregroundStyle(StarlingsMobileColors.danger) } }
            }
            .navigationTitle("Question")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { StarlingsSheetCloseButton { dismiss() }.disabled(state.busy) } }
        }
        .interactiveDismissDisabled(state.busy)
        .task {
            await state.poll(read: {
                guard let credentials = app.ownerCredentials else { throw CancellationError() }
                return try await app.api.attentionRequest(credentials: credentials, id: state.request.id)
            }, onResolved: { _ in Task { await work.refreshInbox() } })
        }
    }
    private func resolve(_ action: AttentionResolveInputAction) {
        Task {
            await state.resolve(action: action, email: email, send: { command in
                guard let credentials = app.ownerCredentials else { throw CancellationError() }
                return try await app.api.resolveAttention(credentials: credentials, id: state.request.id, command: command)
            })
            if state.request.state != .open { await work.refreshInbox() }
        }
    }
}
