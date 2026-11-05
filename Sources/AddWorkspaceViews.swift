import EnvisioningUI
import SwiftUI

/// What the add flow's lookup knows, drawn the same on the
/// iPhone sheet and the Mac sheet: nothing yet, looking, the workspace found
/// with its mark, address and who may sign in, or the failure in red with
/// Copy and Retry.
struct AddWorkspaceLookupView: View {
    @ObservedObject var flow: AddWorkspaceFlow

    var body: some View {
        switch flow.lookup {
        case .idle:
            EmptyView()
        case .looking:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Looking up…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        case .found(let workspace):
            HStack(alignment: .top, spacing: 10) {
                StarlingsWorkspaceMarkView(workspace: workspace, data: flow.mark, size: 32)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(verbatim: workspace.name)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.secondary)
                            .accessibilityLabel(String(localized: "Found"))
                    }
                    Text(verbatim: workspace.address)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let access = flow.accessLine {
                        Text(access)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: EnvisioningRadius.field, style: .continuous)
                    .fill(EnvisioningSurface.elevated)
            )
            .overlay(
                RoundedRectangle(cornerRadius: EnvisioningRadius.field, style: .continuous)
                    .strokeBorder(EnvisioningSurface.border, lineWidth: 1)
            )
            .accessibilityElement(children: .combine)
        case .failed(let failure):
            StarlingsErrorNotice(message: failure.message, font: .footnote, retry: flow.retry)
        }
    }
}

/// The sign-in failure under the button, with Retry: not invited, cancelled,
/// network.
struct AddWorkspaceFailureView: View {
    @ObservedObject var flow: AddWorkspaceFlow

    var body: some View {
        if let failure = flow.failure {
            StarlingsErrorNotice(message: failure.message, font: .footnote, retry: flow.retry)
        }
    }
}
