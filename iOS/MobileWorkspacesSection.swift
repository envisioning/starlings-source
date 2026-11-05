import EnvisioningUI
import SwiftUI

/// Settings › Workspaces (slice G): every workspace signed in
/// to on this phone, the active one checked, and Add workspace. A tap
/// switches: the app rebuilds on that workspace (slice E); a signed-out row
/// signs in first. Any other row can be signed out of or removed from here,
/// without switching to it. Off during a call.
struct MobileWorkspacesSection: View {
    @EnvironmentObject private var app: StarlingsAppModel
    @ObservedObject private var store = StarlingsWorkspaceStore.shared
    @State private var isAdding = false
    /// Who is signed in to each workspace, by web origin, read from the Keychain.
    @State private var addresses: [String: String] = [:]

    var body: some View {
        let inCall = MobileCallActivity.isLive
        Section {
            ForEach(store.known, id: \.webOrigin) { workspace in
                let isCurrent = workspace.webOrigin == store.current.webOrigin
                let email = addresses[workspace.webOrigin]
                Button {
                    Task { await MobileWorkspaceSwitch.open(workspace, app: app) }
                } label: {
                    MobileWorkspaceRow(
                        workspace: workspace,
                        mark: store.mark(for: workspace),
                        email: email,
                        isCurrent: isCurrent
                    )
                }
                .buttonStyle(.meetPlain)
                .disabled(inCall)
                .swipeActions(edge: .trailing) {
                    if !isCurrent { rowActions(workspace, signedIn: email != nil) }
                }
                .contextMenu {
                    if !isCurrent { rowActions(workspace, signedIn: email != nil) }
                }
                .task(id: workspace.webOrigin) {
                    addresses[workspace.webOrigin] = MobileWorkspaceSwitch.address(for: workspace)
                }
            }
            Button("Add workspace") { isAdding = true }
                .buttonStyle(.meetPlain)
                .disabled(inCall)
                // On the one row, not the Section: a Section hands its
                // modifiers to every row, and two presenters of one sheet
                // dismiss it as soon as it shows.
                .sheet(isPresented: $isAdding) {
                    MobileAddWorkspaceSheet(app: app)
                }
        } header: {
            Text("Workspaces")
        } footer: {
            if inCall { Text("Leave the call to switch.") }
        }
        .task(id: store.known.map(\.webOrigin)) { await store.loadMarks() }
    }

    /// Sign out keeps the row, signed out; Remove takes it off this phone.
    @ViewBuilder
    private func rowActions(_ workspace: StarlingsWorkspace, signedIn: Bool) -> some View {
        Button("Remove", role: .destructive) {
            app.remove(workspace)
            addresses[workspace.webOrigin] = nil
        }
        if signedIn {
            Button("Sign out") {
                app.signOut(of: workspace)
                addresses[workspace.webOrigin] = nil
            }
        }
    }
}

/// One workspace in a switcher: its mark, its name, its address,
/// and the account signed in to it, or Signed out, dimmed.
struct MobileWorkspaceRow: View {
    let workspace: StarlingsWorkspace
    let mark: Data?
    let email: String?
    let isCurrent: Bool

    var body: some View {
        HStack(spacing: 10) {
            StarlingsWorkspaceMarkView(workspace: workspace, data: mark, size: 28, signedOut: email == nil)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: workspace.name)
                    .lineLimit(1)
                Text(verbatim: workspace.rowDetail(email: email, saysSignedOut: true))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .opacity(email == nil && !isCurrent ? 0.6 : 1)
            Spacer(minLength: 8)
            if isCurrent {
                Image(systemName: "checkmark")
                    .foregroundStyle(.tint)
                    .accessibilityLabel("Active")
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// Add a workspace: the heading, one address field with the
/// `.<suffix>` suffix, what the lookup found as the person types, one
/// line on what happens next, and one full-width button. The steps and
/// the words are `AddWorkspaceFlow`'s, shared with the Mac.
struct MobileAddWorkspaceSheet: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var flow: AddWorkspaceFlow
    @FocusState private var fieldFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Add a workspace")
                    .font(.title3.weight(.semibold))
                    .padding(.top, 8)

                VStack(alignment: .leading, spacing: 6) {
                    Text("Workspace address")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                    HStack(spacing: 0) {
                        TextField("your-team", text: Binding(get: { flow.address }, set: { flow.setAddress($0) }))
                            .textContentType(.URL)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.go)
                            .focused($fieldFocused)
                            .onSubmit { flow.submit() }
                            .disabled(flow.isBusy)
                        if flow.showsSuffix {
                            Text(verbatim: AddWorkspaceFlow.suffix)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .fixedSize()
                        }
                    }
                    .meetField()
                }

                AddWorkspaceLookupView(flow: flow)

                Text(AddWorkspaceFlow.nextStep)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Button(action: flow.submit) {
                    HStack(spacing: 8) {
                        if flow.isBusy {
                            ProgressView().tint(StarlingsMobileColors.accentInk)
                        }
                        Text(flow.buttonTitle)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                }
                .buttonStyle(StarlingsFilledButtonStyle())
                .disabled(!flow.canSubmit)

                AddWorkspaceFailureView(flow: flow)
            }
            .padding(20)
        }
        .scrollBounceBehavior(.basedOnSize)
        .presentationDetents([.medium, .large])
        .presentationBackground(StarlingsMobileColors.panel)
        .meetAlertHost()
        .onAppear {
            fieldFocused = true
            flow.onEntered = { dismiss() }
        }
        .onDisappear { flow.cancel() }
        .interactiveDismissDisabled(flow.isBusy)
    }

    /// The sign-in is the app model's: the same browser sheet and redeem as
    /// the sign-in screen, for a workspace that is not active yet.
    /// `signInCurrent`: the door's, where the current workspace is signed
    /// out. Its address then signs in to it.
    init(app: StarlingsAppModel, signInCurrent: (() -> Void)? = nil) {
        let flow = AddWorkspaceFlow(
            signIn: { [weak app] workspace in
                guard let app else { throw CancellationError() }
                try await app.signIn(into: workspace)
            },
            hasSession: { MobileWorkspaceSwitch.hasSession($0) },
            isLocked: { MobileCallActivity.isLive }
        )
        flow.onSignInCurrent = signInCurrent
        _flow = StateObject(wrappedValue: flow)
    }
}

/// The rules every workspace switcher shares: a switch is off during a
/// call, a signed-out row signs in before it opens, and each
/// row names who is signed in to it.
@MainActor
enum MobileWorkspaceSwitch {
    /// Switches, and the rebuilt app says "You're in <name>". A cancel stays put.
    static func open(_ workspace: StarlingsWorkspace, app: StarlingsAppModel) async {
        let store = StarlingsWorkspaceStore.shared
        guard !MobileCallActivity.isLive, workspace.webOrigin != store.current.webOrigin else { return }
        if !hasSession(workspace) {
            do {
                try await app.signIn(into: workspace)
            } catch {
                guard !SignInOutcome.isCancel(error) else { return }
                app.alertMessage = AddWorkspaceFlow.Failure.reading(error).message
                return
            }
            guard !MobileCallActivity.isLive else { return }
        }
        store.enter(workspace)
    }

    static func address(for workspace: StarlingsWorkspace) -> String? {
        (try? MobileOwnerSessionStore().load(workspace: workspace))?.owner.email
    }

    static func hasSession(_ workspace: StarlingsWorkspace) -> Bool {
        address(for: workspace) != nil
    }
}

/// Home's header badge as a switcher: tap for every workspace
/// on this phone, the active one checked, then Add workspace.
struct MobileWorkspaceSwitcher: View {
    let address: String
    @EnvironmentObject private var app: StarlingsAppModel
    @ObservedObject private var store = StarlingsWorkspaceStore.shared
    @State private var isAdding = false
    @State private var addresses: [String: String] = [:]

    var body: some View {
        let inCall = MobileCallActivity.isLive
        Menu {
            ForEach(store.known, id: \.webOrigin) { workspace in
                Button {
                    Task { await MobileWorkspaceSwitch.open(workspace, app: app) }
                } label: {
                    Text(workspace.name)
                    Text(verbatim: workspace.rowDetail(email: addresses[workspace.webOrigin], saysSignedOut: true))
                    if workspace.webOrigin == store.current.webOrigin {
                        Image(systemName: "checkmark")
                    } else if let mark = StarlingsWorkspaceMarkView.image(workspace: workspace, data: store.mark(for: workspace), size: 20) {
                        Image(uiImage: mark)
                    }
                }
                .disabled(inCall)
            }
            Divider()
            Button("Add workspace") { isAdding = true }
                .disabled(inCall)
        } label: {
            StarlingsWorkspaceBadge(address: address, markSize: 20)
        }
        .foregroundStyle(.primary)
        .task(id: store.known.map(\.webOrigin)) {
            for workspace in store.known {
                addresses[workspace.webOrigin] = MobileWorkspaceSwitch.address(for: workspace)
            }
            await store.loadMarks()
        }
        .sheet(isPresented: $isAdding) {
            MobileAddWorkspaceSheet(app: app)
        }
    }
}
