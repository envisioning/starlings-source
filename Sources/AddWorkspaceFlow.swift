import EnvisioningUI
import Foundation

/// Add a workspace: one address field, a lookup while the person
/// types, one button that signs in to the workspace found, and a switch only
/// once its session is in the workspace's own Keychain scope. A cancelled or
/// refused sign-in leaves the person where they were, with the reason and
/// Retry.
///
/// The iPhone sheet (`MobileAddWorkspaceSheet`) and the Mac sheet
/// (`AddWorkspaceSheet`) draw it. Each supplies its own sign-in; the steps,
/// the words and the failures live here once. The lookup is
/// `StarlingsWorkspaceDirectory.lookUp`, the same one the sign-in screens use.
@MainActor
final class AddWorkspaceFlow: ObservableObject {
    /// What the address names, as far as the lookup knows.
    enum Lookup: Equatable {
        /// Nothing typed, or not an address yet. Nothing to say.
        case idle
        case looking
        case found(StarlingsWorkspace)
        case failed(Failure)
    }

    /// Where the button is, after it was pressed.
    enum Step: Equatable {
        case ready
        case signingIn
        /// Signed in; the app is switching to the workspace.
        case opening
    }

    enum Failure: Equatable {
        case invalidAddress
        case notFound
        case notInvited
        case cancelled
        case network
        case other(String)

        var message: String {
            switch self {
            case .invalidAddress: StarlingsWorkspaceLookupError.invalidAddress.errorDescription ?? ""
            case .notFound: StarlingsWorkspaceLookupError.notFound.errorDescription ?? ""
            case .network: StarlingsWorkspaceLookupError.unreachable.errorDescription ?? ""
            case .notInvited: WorkspaceSignInAttempt.Failure.notInvited.errorDescription ?? ""
            case .cancelled: String(localized: "Sign-in cancelled.")
            case .other(let text): text
            }
        }

        /// A failure of the lookup or of the sign-in, in plain words.
        static func reading(_ error: Error) -> Failure {
            if SignInOutcome.isCancel(error) { return .cancelled }
            if let lookup = error as? StarlingsWorkspaceLookupError {
                switch lookup {
                case .invalidAddress: return .invalidAddress
                case .notFound: return .notFound
                case .unreachable: return .network
                case .updateRequired: return .other(lookup.errorDescription ?? "")
                }
            }
            if let failure = error as? WorkspaceSignInAttempt.Failure, failure == .notInvited { return .notInvited }
            if error is URLError { return .network }
            return .other(SignInOutcome.plainMessage(for: error).text)
        }
    }

    @Published private(set) var address = ""
    @Published private(set) var lookup: Lookup = .idle
    /// The found workspace's mark, once read.
    @Published private(set) var mark: Data?
    @Published private(set) var step: Step = .ready
    /// Why the last press did not land. Cleared by an edit or Retry.
    @Published private(set) var failure: Failure?

    /// Signs in to the workspace without making it active, and keeps the
    /// session in that workspace's scope. Throws to stay on the sheet.
    private let signIn: @MainActor (StarlingsWorkspace) async throws -> Void
    /// True when the workspace already has a session on this device: the
    /// button switches without signing in again.
    private let hasSession: @MainActor (StarlingsWorkspace) -> Bool
    /// True while a switch must wait (a live call).
    private let isLocked: @MainActor () -> Bool
    private let store: StarlingsWorkspaceStore
    /// Runs once the workspace is entered: the sheet closes.
    var onEntered: (() -> Void)?
    /// The door's sign-in to the current workspace. Set only
    /// where the current workspace is signed out: typing its address there
    /// signs in to it instead of saying "You're in this workspace".
    var onSignInCurrent: (() -> Void)?

    private var lookupTask: Task<Void, Never>?
    private var submitTask: Task<Void, Never>?
    private var generation = 0

    /// How long typing rests before the lookup runs.
    static let debounce: Duration = .milliseconds(400)

    init(
        store: StarlingsWorkspaceStore = .shared,
        signIn: @escaping @MainActor (StarlingsWorkspace) async throws -> Void,
        hasSession: @escaping @MainActor (StarlingsWorkspace) -> Bool,
        isLocked: @escaping @MainActor () -> Bool
    ) {
        self.store = store
        self.signIn = signIn
        self.hasSession = hasSession
        self.isLocked = isLocked
    }

    // MARK: - What the sheet draws

    /// The `.<suffix>` suffix after the field, while the person types
    /// a bare name. A pasted host or link carries its own.
    var showsSuffix: Bool {
        !address.contains(".") && !address.contains(":") && !address.contains("/")
    }

    static let suffix = ".\(ContractConstants.workspaceHostSuffix)"

    var foundWorkspace: StarlingsWorkspace? {
        if case .found(let workspace) = lookup { return workspace }
        return nil
    }

    var isBusy: Bool { step != .ready }

    /// The one button: what it does.
    var buttonTitle: String {
        switch step {
        case .signingIn: return EnvisioningCopy.signingIn
        case .opening: return String(localized: "Opening workspace…")
        case .ready:
            if let found = foundWorkspace, hasSession(found) {
                return String(localized: "Switch to \(found.name)")
            }
            return String(localized: "Continue to sign in")
        }
    }

    var canSubmit: Bool {
        guard step == .ready, !address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if let found = foundWorkspace, found.webOrigin == store.current.webOrigin {
            return signsInToCurrent(found)
        }
        return true
    }

    /// The line under the found workspace: who may sign in.
    var accessLine: String? {
        guard let found = foundWorkspace else { return nil }
        if found.webOrigin == store.current.webOrigin, !signsInToCurrent(found) {
            return String(localized: "You’re in this workspace.")
        }
        let domains = found.resolvedIdentity.domains
        guard !domains.isEmpty else { return nil }
        if let email = store.signedInAddress?.lowercased(),
           !domains.contains(where: { email.hasSuffix("@\($0)") }) {
            return String(localized: "Your account needs an invite to this workspace.")
        }
        return String(localized: "For accounts on \(domains.joined(separator: ", ")).")
    }

    /// One line on what happens next, before the button is pressed.
    static let nextStep = String(localized: "A browser window opens to sign in, then brings you back here.")

    // MARK: - Actions

    /// Every keystroke. The lookup runs once typing rests.
    func setAddress(_ value: String) {
        guard value != address else { return }
        address = value
        failure = nil
        scheduleLookup(after: Self.debounce)
    }

    /// Retry: the lookup again, or the press again when the lookup had landed.
    func retry() {
        failure = nil
        if foundWorkspace != nil {
            submit()
        } else {
            scheduleLookup(after: .zero)
        }
    }

    /// The button, and Return in the field.
    func submit() {
        guard step == .ready, submitTask == nil else { return }
        let input = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty else {
            failure = .invalidAddress
            return
        }
        failure = nil
        submitTask = Task { [weak self] in
            await self?.run(input: input)
            self?.submitTask = nil
        }
    }

    private func run(input: String) async {
        // Return before the lookup rested: look up now.
        var workspace = foundWorkspace
        if workspace == nil {
            lookupTask?.cancel()
            generation += 1
            lookup = .looking
            do {
                let found = try await store.lookUp(input)
                guard address.trimmingCharacters(in: .whitespacesAndNewlines) == input else { return }
                lookup = .found(found)
                Task { await loadMark(of: found) }
                workspace = found
            } catch {
                let reason = Failure.reading(error)
                lookup = .failed(reason)
                return
            }
        }
        guard let workspace else { return }
        if workspace.webOrigin == store.current.webOrigin {
            guard signsInToCurrent(workspace), let signIn = onSignInCurrent else { return }
            onEntered?()
            signIn()
            return
        }
        if isLocked() {
            failure = .other(String(localized: "Leave the call to switch."))
            return
        }
        if !hasSession(workspace) {
            step = .signingIn
            do {
                try await signIn(workspace)
            } catch {
                step = .ready
                failure = Failure.reading(error)
                return
            }
        }
        guard !isLocked() else {
            step = .ready
            failure = .other(String(localized: "Leave the call to switch."))
            return
        }
        step = .opening
        onEntered?()
        store.enter(workspace)
    }

    /// The current workspace, signed out, on the door: the button signs in to it.
    private func signsInToCurrent(_ workspace: StarlingsWorkspace) -> Bool {
        onSignInCurrent != nil && !hasSession(workspace)
    }

    private func scheduleLookup(after delay: Duration) {
        lookupTask?.cancel()
        generation += 1
        let ticket = generation
        let input = address.trimmingCharacters(in: .whitespacesAndNewlines)
        mark = nil
        guard !input.isEmpty, StarlingsWorkspaceAddress.origin(for: input) != nil else {
            lookup = .idle
            return
        }
        lookup = .looking
        lookupTask = Task { [weak self] in
            if delay > .zero {
                try? await Task.sleep(for: delay)
            }
            guard !Task.isCancelled, let self else { return }
            do {
                let found = try await self.store.lookUp(input)
                guard ticket == self.generation else { return }
                self.lookup = .found(found)
                await self.loadMark(of: found)
            } catch {
                guard ticket == self.generation, !Task.isCancelled else { return }
                self.lookup = .failed(Failure.reading(error))
            }
        }
    }

    private func loadMark(of workspace: StarlingsWorkspace) async {
        let data = await StarlingsWorkspaceDirectory.markData(for: workspace)
        guard foundWorkspace == workspace else { return }
        mark = data
    }

    func cancel() {
        lookupTask?.cancel()
        submitTask?.cancel()
    }
}
