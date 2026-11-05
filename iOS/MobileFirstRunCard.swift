import EnvisioningUI
import SwiftUI

/// The first thing anyone sees. The shared Envisioning shell owns the glyph,
/// wordmark, card geometry, version line, and sign-in wording; Meet contributes
/// the guest fields and its secondary owner action.
struct MobileFirstRunCard: View {
    @EnvironmentObject private var app: StarlingsAppModel

    @State private var name = UserDefaults.standard.string(forKey: "meet.guest.name") ?? ""
    @State private var email = UserDefaults.standard.string(forKey: "meet.guest.email") ?? ""
    @State private var room = ""
    @State private var status: String?
    @State private var isAddingAddress = false
    /// The workspaces this phone has signed in to.
    @StateObject private var door = WorkspaceDoorModel()
    @FocusState private var focus: Field?

    private enum Field: Hashable { case name, email, room }

    var body: some View {
        EnvisioningWelcomeShell(
            productName: "Starlings",
            subtitle: String(localized: "Join a meeting or sign in to your workspace."),
            environment: StarlingsAppVersion.environment.capitalized,
            // The Starlings flock, never another organization's mark.
            // It rests while sign-in runs: the button's spinner is then the
            // one moving element.
            mark: AnyView(GatheringDotsView(side: 44, ink: .primary, motion: app.isSigningIn ? .still : .drift))
        ) {
            // The shell declares the card's container shape; the fields and
            // buttons resolve their concentric corners from it.
            VStack(spacing: 12) {
                TextField("Your name", text: $name)
                    .textContentType(.name)
                    .textInputAutocapitalization(.words)
                    .submitLabel(.next)
                    .focused($focus, equals: .name)
                    .onSubmit { focus = .email }
                    .meetField()

                TextField("Email address", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.next)
                    .focused($focus, equals: .email)
                    .onSubmit { focus = .room }
                    .meetField()

                HStack(spacing: 6) {
                    TextField("Room name", text: $room)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .focused($focus, equals: .room)
                        .onSubmit(continueAsGuest)
                        .meetField()
                    Button(action: pasteRoom) {
                        Image(systemName: "doc.on.clipboard")
                            .foregroundStyle(.secondary)
                            .frame(width: 40, height: 48)
                    }
                    .accessibilityLabel("Paste")
                    .accessibilityHint("Pastes a meeting room from the clipboard")
                }
                .padding(.bottom, 4)

                Button(action: continueAsGuest) {
                    Text(EnvisioningCopy.continueLabel)
                }
                .buttonStyle(StarlingsFilledButtonStyle())
                .disabled(app.isSigningIn)

                // Same sentences as the Mac door and the web room entry.
                Text("Starlings does not record audio or video. Your host’s device writes a transcript, and only that text is kept.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                Text(EnvisioningCopy.orLabel)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 2)

                // Every workspace this phone has signed in to, one tap
                // from its sign-in, then Enter an address.
                WorkspaceDoorView(model: door)
                    .onAppear(perform: configureDoor)
                    .sheet(isPresented: $isAddingAddress) {
                        MobileAddWorkspaceSheet(app: app) { signInToCurrent() }
                    }

                if let status {
                    StarlingsErrorNotice(message: status, font: .caption, alignment: .center)
                        .padding(.top, 4)
                        .accessibilityLabel("Unable to continue: \(status)")
                }
            }
        }
    }

    // MARK: - Actions

    private func configureDoor() {
        door.email = { MobileWorkspaceSwitch.address(for: $0) }
        door.onPick = { pick($0) }
        door.onEnterAddress = {
            status = nil
            isAddingAddress = true
        }
    }

    /// A row on the door: the current workspace signs in as before; a
    /// workspace this phone holds a session for opens; any other signs in
    /// into its own scope first, then opens. A cancel leaves the door as it was.
    private func pick(_ workspace: StarlingsWorkspace) {
        status = nil
        let store = StarlingsWorkspaceStore.shared
        if workspace.webOrigin == store.current.webOrigin {
            signInToCurrent()
            return
        }
        door.busyOrigin = workspace.webOrigin
        Task {
            defer { door.busyOrigin = nil }
            if !MobileWorkspaceSwitch.hasSession(workspace) {
                do {
                    try await app.signIn(into: workspace)
                } catch {
                    guard !SignInOutcome.isCancel(error) else { return }
                    status = AddWorkspaceFlow.Failure.reading(error).message
                    return
                }
            }
            store.enter(workspace)
        }
    }

    private func signInToCurrent() {
        guard door.busyOrigin == nil else { return }
        status = nil
        door.busyOrigin = StarlingsWorkspaceStore.shared.current.webOrigin
        Task {
            await app.signIn()
            door.busyOrigin = nil
        }
    }

    /// The three checks in the Mac's order, with the sentences in
    /// `GuestEntryWords`: a person who has used both learns one vocabulary.
    private func continueAsGuest() {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else {
            status = GuestEntryWords.nameMissing
            focus = .name
            return
        }
        let identity = MobileGuestIdentity(name: trimmedName, email: email)
        guard identity.isValid else {
            status = GuestEntryWords.emailInvalid
            focus = .email
            return
        }
        // A link for another workspace opens there, with the same guest
        // details, which are kept below and read again after the change.
        if !StarlingsWorkspaceLink.isActive(room) {
            let normalized = identity.normalized
            UserDefaults.standard.set(normalized.name, forKey: "meet.guest.name")
            UserDefaults.standard.set(normalized.email, forKey: "meet.guest.email")
            app.pendingGuestIdentity = normalized
            app.open(link: room)
            return
        }
        guard let parsed = MobileRoomPath(input: room) else {
            status = GuestEntryWords.roomInvalid
            focus = .room
            return
        }
        room = parsed.slug
        status = nil
        focus = nil

        let normalized = identity.normalized
        UserDefaults.standard.set(normalized.name, forKey: "meet.guest.name")
        UserDefaults.standard.set(normalized.email, forKey: "meet.guest.email")
        app.pendingGuestIdentity = normalized
        app.pendingJoinInput = parsed.canonicalURL
    }

    /// Prefer a `/room/…` slug out of pasted invite text; otherwise paste as-is,
    /// which is what the Mac's paste button does.
    private func pasteRoom() {
        guard let raw = UIPasteboard.general.string?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !raw.isEmpty
        else { return }
        room = MobileRoomPath(input: raw)?.slug ?? raw
        status = nil
        focus = .room
    }

}
