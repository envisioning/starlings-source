import EnvisioningUI
import SwiftUI

/// Save to Docs, from the share sheet: the title, a note, and Save. The page
/// waits in the outbox until Starlings opens, so the confirmation says that.
struct ShareSheet: View {
    @ObservedObject var model: ShareModel

    var body: some View {
        NavigationStack {
            // `StarlingsForm` in the app: the same form, by its EnvisioningUI name.
            EnvisioningForm {
                content
            }
            .navigationTitle("Save to Docs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { model.close() }
                }
                if model.phase != .saved {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") { model.save() }
                            .disabled(!model.canSave)
                            .meetToolbarConfirm()
                    }
                }
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .reading:
            Section {
                EnvisioningLoadingState(String(localized: "Reading the page…"))
            }
        case .notAPage:
            Section {
                Text("Share a web page to save it.")
                    .foregroundStyle(.secondary)
            }
        case .saved:
            Section {
                Text("Saved. Starlings files it in Docs next time you open the app.")
                Button("Done") { model.close() }
            }
        case .ready:
            if let workspace = model.workspace {
                Section {
                    TextField("Title", text: $model.title, axis: .vertical)
                        .meetSingleLine($model.title)
                        .textInputAutocapitalization(.sentences)
                    TextField("Note", text: $model.note, axis: .vertical)
                        .lineLimit(3...8)
                        .textInputAutocapitalization(.sentences)
                } header: {
                    Text(model.page?.url.host() ?? "")
                } footer: {
                    Text("Saves to \(workspace.name).")
                }
            } else {
                Section {
                    Text("Open Starlings and sign in first.")
                        .foregroundStyle(.secondary)
                }
            }
            if let error = model.errorMessage {
                Section {
                    ShareErrorLine(message: error)
                }
            }
        }
    }
}

/// `StarlingsErrorNotice`'s look, red with Copy, for the one error the extension
/// has. The app's notice needs the app (its report, its snapshot store), so
/// the extension draws the line itself.
private struct ShareErrorLine: View {
    let message: String
    @State private var copied = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(message)
                .font(.footnote)
                .foregroundStyle(StarlingsSemanticColors.danger)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(copied ? String(localized: "Copied") : String(localized: "Copy")) {
                UIPasteboard.general.string = message
                copied = true
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(StarlingsSemanticColors.danger)
            .accessibilityLabel(String(localized: "Copy error"))
        }
        .accessibilityElement(children: .combine)
    }
}
