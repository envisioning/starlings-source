import EnvisioningUI
import SwiftUI

/// The workspaces on the door: every row this device has signed
/// in to, then **Enter an address**, which opens the add flow. No address
/// field sits on the door itself, and nobody has to remember a slug to come
/// back. A row the device holds a session for opens it; any other row signs
/// in to it. The Mac's first run (`OnboardingViewController`) and the
/// iPhone's (`MobileFirstRunCard`) draw it; each supplies its own sign-in.
@MainActor
final class WorkspaceDoorModel: ObservableObject {
    /// The row whose sign-in is under way; every row waits while one is.
    @Published var busyOrigin: String?
    /// The account signed in to a workspace on this device, from its Keychain scope.
    var email: (StarlingsWorkspace) -> String? = { _ in nil }
    var onPick: (StarlingsWorkspace) -> Void = { _ in }
    var onEnterAddress: () -> Void = {}
}

struct WorkspaceDoorView: View {
    @ObservedObject var model: WorkspaceDoorModel
    @ObservedObject private var store = StarlingsWorkspaceStore.shared

    var body: some View {
        VStack(spacing: 8) {
            ForEach(store.known, id: \.webOrigin) { workspace in
                let email = model.email(workspace)
                WorkspaceDoorRow(
                    workspace: workspace,
                    mark: store.mark(for: workspace),
                    email: email,
                    isBusy: model.busyOrigin == workspace.webOrigin
                ) {
                    model.onPick(workspace)
                }
                .disabled(model.busyOrigin != nil)
            }
            Button(String(localized: "Enter an address")) { model.onEnterAddress() }
                .buttonStyle(WorkspaceDoorPressStyle())
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.secondary)
                .padding(.top, 2)
                .disabled(model.busyOrigin != nil)
        }
        .task(id: store.known.map(\.webOrigin)) { await store.loadMarks() }
    }
}

/// One workspace on the door: its mark, name and address, the account when
/// one is signed in, and what a press does.
struct WorkspaceDoorRow: View {
    let workspace: StarlingsWorkspace
    let mark: Data?
    let email: String?
    let isBusy: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                StarlingsWorkspaceMarkView(workspace: workspace, data: mark, size: 24, signedOut: email == nil)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: workspace.name)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(verbatim: workspace.rowDetail(email: email))
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                if isBusy {
                    ProgressView().controlSize(.small)
                } else {
                    Text(email == nil ? String(localized: "Sign in") : String(localized: "Open"))
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.primary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(
                RoundedRectangle(cornerRadius: EnvisioningRadius.field, style: .continuous)
                    .fill(EnvisioningSurface.elevated)
            )
            .overlay(
                RoundedRectangle(cornerRadius: EnvisioningRadius.field, style: .continuous)
                    .strokeBorder(EnvisioningSurface.border, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: EnvisioningRadius.field, style: .continuous))
        }
        .buttonStyle(WorkspaceDoorPressStyle())
        .accessibilityElement(children: .combine)
        .accessibilityHint(email == nil ? String(localized: "Sign in") : String(localized: "Open"))
    }
}

/// The door's press: the row dims under the finger or the pointer, and a
/// disabled row fades. No system chrome.
private struct WorkspaceDoorPressStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(!isEnabled ? 0.5 : configuration.isPressed ? 0.7 : 1)
    }
}

extension StarlingsWorkspace {
    /// A switcher row's second line: the address, then the account signed
    /// in to it, or that nobody is.
    func rowDetail(email: String?, saysSignedOut: Bool = false) -> String {
        if let email { return "\(address) · \(email)" }
        return saysSignedOut ? "\(address) · \(String(localized: "Signed out"))" : address
    }
}
