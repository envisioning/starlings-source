import AppKit
import SwiftUI

/// Icon button that spells its verb out while the pointer is over it — a lone
/// glyph beside a field reads as decoration, and the tooltip lands too late to
/// tell anyone what it does.
final class HoverTitleButton: NSButton {
    /// Word shown next to the glyph on hover. Empty means icon-only, always.
    var hoverTitle = "" { didSet { applyHoverState() } }
    var titleColor: NSColor = .secondaryLabelColor { didSet { applyHoverState() } }

    private var hovering = false
    private var hoverTracking: NSTrackingArea?

    override var isEnabled: Bool {
        didSet {
            if !isEnabled { hovering = false }
            applyHoverState()
        }
    }

    /// Width this button needs with its word showing — pin the layout to this so
    /// hover is a reveal, not a reflow.
    func widthShowingTitle() -> CGFloat {
        let wasHovering = hovering
        hovering = true
        applyHoverState()
        let width = ceil(intrinsicContentSize.width)
        hovering = wasHovering
        applyHoverState()
        return width
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverTracking { removeTrackingArea(hoverTracking) }
        let area = NSTrackingArea(
            rect: .zero,
            options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect],
            owner: self
        )
        addTrackingArea(area)
        hoverTracking = area
    }

    override func mouseEntered(with event: NSEvent) {
        super.mouseEntered(with: event)
        hovering = true
        applyHoverState()
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        hovering = false
        applyHoverState()
    }

    private func applyHoverState() {
        let showsTitle = hovering && isEnabled && !hoverTitle.isEmpty
        imagePosition = showsTitle ? .imageLeading : .imageOnly
        attributedTitle = NSAttributedString(
            string: showsTitle ? hoverTitle : "",
            attributes: [
                .font: NSFont.systemFont(ofSize: StarlingsTypography.scaled(11), weight: .medium),
                .foregroundColor: titleColor,
            ]
        )
    }
}

@MainActor
final class OnboardingViewController: NSViewController {
    var onSignedIn: ((OwnerSessionCredentials) -> Void)?
    var onContinueAsGuest: ((String, String, String) -> Void)?

    private let authenticator: GoogleOwnerAuthenticator
    private let nameField = StarlingsTextField(placeholder: String(localized: "Your name"))
    private let emailField = StarlingsTextField(placeholder: String(localized: "Email address"))
    private let roomField = StarlingsTextField(placeholder: String(localized: "Room name"))
    private let pasteRoomButton = HoverTitleButton(frame: .zero)
    private let continueGuestButton = NSButton(title: String(localized: "Continue"), target: nil, action: nil)
    /// The workspaces this Mac has signed in to, each one press from its
    /// sign-in, then Enter an address.
    private let workspaceStore = StarlingsWorkspaceStore.shared
    private let door = WorkspaceDoorModel()
    private var doorHost: NSView = NSView()
    private let statusLabel = StarlingsNoticeView(wrapping: true)
    private let lede = StarlingsTypography.wrappingLabel(OnboardingViewController.ledeIdle)
    /// Same sentences as the web room entry: the one thing a guest reads about
    /// why the meeting runs here, before they type their name.
    private let privacyNote = StarlingsTypography.wrappingLabel(
        "Starlings does not record audio or video. Your host’s device writes a transcript, and only that text is kept."
    )
    /// Guest half of the card — dimmed while the browser holds the sign-in.
    private var guestControls: [NSView] = []

    private static let ledeIdle = "Enter your name, email, and room to join."
    private static let ledeWaiting = "Finish signing in in your browser, then come back here."

    init(authenticator: GoogleOwnerAuthenticator = GoogleOwnerAuthenticator()) {
        self.authenticator = authenticator
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func loadView() {
        view = NSView()
        view.wantsLayer = true
        view.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.canvas, for: view).cgColor
        buildInterface()
    }

    private func buildInterface() {
        // No workspace is in view yet, so the product names itself.
        let brand = NSHostingView(rootView: StarlingsWordmark(size: 32, ink: Color(nsColor: StarlingsColors.primaryText)))
        brand.setContentHuggingPriority(.required, for: .horizontal)
        brand.setContentHuggingPriority(.required, for: .vertical)

        lede.font = .systemFont(ofSize: StarlingsTypography.scaled(15))
        lede.textColor = StarlingsColors.secondaryText
        lede.alignment = .center
        lede.maximumNumberOfLines = 3
        lede.isEditable = false

        privacyNote.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        privacyNote.textColor = StarlingsColors.secondaryText
        privacyNote.alignment = .center
        privacyNote.maximumNumberOfLines = 3
        privacyNote.isEditable = false

        configureField(nameField)
        configureField(emailField)
        configureField(roomField)

        let pasteImage = NSImage(
            systemSymbolName: "doc.on.clipboard",
            accessibilityDescription: String(localized: "Paste")
        )
        pasteRoomButton.image = pasteImage
        pasteRoomButton.imageScaling = .scaleProportionallyDown
        pasteRoomButton.setButtonType(.momentaryChange)
        pasteRoomButton.bezelStyle = .inline
        pasteRoomButton.isBordered = false
        pasteRoomButton.alignment = .left
        pasteRoomButton.contentTintColor = StarlingsColors.secondaryText
        pasteRoomButton.titleColor = StarlingsColors.secondaryText
        pasteRoomButton.hoverTitle = "Paste"
        pasteRoomButton.target = self
        pasteRoomButton.action = #selector(pasteRoomName)
        pasteRoomButton.setContentHuggingPriority(.required, for: .horizontal)
        pasteRoomButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        // Reserve the hovered width up front so the word arriving never nudges
        // the room field sideways.
        pasteRoomButton.widthAnchor
            .constraint(equalToConstant: pasteRoomButton.widthShowingTitle())
            .isActive = true
        // The word says what it does; the well under it is the hover every
        // other icon button gives.
        pasteRoomButton.applyMeetHoverLift(cornerRadius: 6)

        let roomRow = NSStackView(views: [roomField, pasteRoomButton])

        roomRow.orientation = .horizontal
        roomRow.alignment = .centerY
        roomRow.spacing = 6
        roomField.setContentHuggingPriority(.defaultLow, for: .horizontal)

        continueGuestButton.controlSize = .large
        continueGuestButton.applyMeetFilledStyle(.accent, title: String(localized: "Continue"))
        continueGuestButton.target = self
        continueGuestButton.action = #selector(continueAsGuest)

        let divider = NSTextField(labelWithString: "or")
        divider.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .medium)
        divider.textColor = StarlingsColors.secondaryText
        divider.alignment = .center
        divider.isSelectable = false

        door.email = { WorkspaceAccounts.email($0) }
        door.onPick = { [weak self] workspace in self?.pick(workspace) }
        door.onEnterAddress = { [weak self] in self?.enterAddress() }
        let doorView = NSHostingView(rootView: meetHosted(WorkspaceDoorView(model: door)))
        doorView.sizingOptions = [.intrinsicContentSize]
        doorView.setContentHuggingPriority(.required, for: .vertical)
        doorHost = doorView

        statusLabel.label.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        statusLabel.label.alignment = .center

        let card = NSView()
        card.wantsLayer = true
        card.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.panel, for: card).cgColor
        card.layer?.cornerRadius = 22
        card.layer?.borderWidth = 1
        card.layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: card).cgColor

        let versionLabel = NSTextField(labelWithString: StarlingsVersionLine.text)
        versionLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        versionLabel.textColor = StarlingsColors.secondaryText
        versionLabel.alignment = .center
        versionLabel.isSelectable = false

        let stack = NSStackView(views: [
            brand, lede,
            nameField, emailField, roomRow, continueGuestButton, privacyNote,
            divider,
            doorHost, statusLabel,
        ])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 12
        stack.setCustomSpacing(14, after: brand)
        stack.setCustomSpacing(24, after: lede)
        stack.setCustomSpacing(10, after: nameField)
        stack.setCustomSpacing(10, after: emailField)
        stack.setCustomSpacing(16, after: roomRow)
        stack.setCustomSpacing(10, after: continueGuestButton)
        stack.setCustomSpacing(18, after: privacyNote)
        stack.setCustomSpacing(18, after: divider)
        stack.setCustomSpacing(10, after: doorHost)
        guestControls = [nameField, emailField, roomRow, continueGuestButton, privacyNote, divider]
        card.addSubview(stack)
        stack.pinToEdges(of: card, insets: NSEdgeInsets(top: 36, left: 40, bottom: 36, right: 40))

        view.addSubview(card)
        card.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(versionLabel)
        versionLabel.translatesAutoresizingMaskIntoConstraints = false

        let fieldWidth: CGFloat = 300
        for control in [nameField, emailField, roomRow, continueGuestButton, doorHost] as [NSView] {
            control.widthAnchor.constraint(equalToConstant: fieldWidth).isActive = true
        }
        lede.widthAnchor.constraint(equalToConstant: 340).isActive = true
        privacyNote.widthAnchor.constraint(equalToConstant: fieldWidth).isActive = true
        statusLabel.widthAnchor.constraint(equalToConstant: fieldWidth).isActive = true

        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.widthAnchor.constraint(equalToConstant: 460),
            versionLabel.centerXAnchor.constraint(equalTo: card.centerXAnchor),
            versionLabel.topAnchor.constraint(equalTo: card.bottomAnchor, constant: 10),
        ])
    }

    private func configureField(_ field: StarlingsTextField) {
        field.target = self
        field.action = #selector(continueAsGuest)
    }

    /// A row on the door: the current workspace signs in as before; a
    /// workspace this Mac holds a session for opens; any other signs in
    /// into its own scope first, then opens. Opening relaunches the app on
    /// it (slice E). A cancel leaves the door as it was.
    private func pick(_ workspace: StarlingsWorkspace) {
        if workspace.webOrigin == workspaceStore.current.webOrigin {
            continueWithGoogle()
            return
        }
        statusLabel.clear()
        if WorkspaceAccounts.hasSession(workspace) {
            workspaceStore.enter(workspace)
            return
        }
        guard let window = view.window else { return }
        setBusy(true, origin: workspace.webOrigin)
        Task {
            defer { setBusy(false) }
            do {
                _ = try await GoogleOwnerAuthenticator(store: WorkspaceAccounts.sessions(workspace)).authenticate(workspace, in: window, requireActive: false)
                workspaceStore.enter(workspace)
            } catch {
                showSignInFailure(error)
            }
        }
    }

    /// The add flow, the one place an address is typed.
    private func enterAddress() {
        statusLabel.clear()
        AddWorkspaceSheet.present(over: view.window) { [weak self] in self?.continueWithGoogle() }
    }

    private func showSignInFailure(_ error: Error) {
        // Cancelling the browser sheet is a choice, not a failure.
        guard !SignInOutcome.isCancel(error) else { return }
        if let failure = error as? WorkspaceSignInAttempt.Failure, failure == .notInvited {
            statusLabel.showError(failure.errorDescription ?? "")
            return
        }
        let plain = SignInOutcome.plainMessage(for: error)
        statusLabel.showError(plain.text, detail: plain.detail)
    }

    private func continueWithGoogle() {
        guard let window = view.window, door.busyOrigin == nil else { return }
        setBusy(true, origin: workspaceStore.current.webOrigin)
        statusLabel.clear()
        Task {
            defer { setBusy(false) }
            do {
                let credentials = try await authenticator.authenticate(in: window)
                onSignedIn?(credentials)
            } catch {
                showSignInFailure(error)
            }
        }
    }

    @objc private func pasteRoomName() {
        guard let raw = NSPasteboard.general.string(forType: .string)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else { return }
        statusLabel.clear()
        // A link for another workspace stays whole: it names where it opens.
        if let link = Self.foreignLink(in: raw) {
            roomField.stringValue = link
            Task { _ = await LinkWorkspaceOffer.handle(link, in: view.window) }
            return
        }
        roomField.stringValue = Self.roomNameFromPasteboard(raw)
        view.window?.makeFirstResponder(roomField)
    }

    /// The first http(s) link in pasted text, when it is on another
    /// workspace's host.
    private static func foreignLink(in raw: String) -> String? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue),
              let match = detector.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw)),
              let url = match.url,
              url.scheme == "https" || url.scheme == "http"
        else { return nil }
        return StarlingsWorkspaceLink.isActive(url.absoluteString) ? nil : url.absoluteString
    }

    /// Puts a link carried across a change of workspace in the room field.
    func applyCarriedLink(_ link: String) {
        roomField.stringValue = MeetingInvite.roomSlug(fromJoinURL: link) ?? link
    }

    /// Prefer a `/room/…` slug from invite text or URLs; otherwise paste as-is.
    private static func roomNameFromPasteboard(_ raw: String) -> String {
        let pattern = #"(?i)(?:https?://[^\s]+)?/room/([a-z0-9-]{2,40})"#
        if let regex = try? NSRegularExpression(pattern: pattern),
           let match = regex.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw)),
           let range = Range(match.range(at: 1), in: raw) {
            return String(raw[range]).lowercased()
        }
        if let url = URL(string: raw),
           url.pathComponents.count >= 3,
           url.pathComponents[1].lowercased() == "room" {
            return url.pathComponents[2].lowercased()
        }
        return raw
    }

    @objc private func continueAsGuest() {
        let name = nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let email = emailField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            statusLabel.showError(GuestEntryWords.nameMissing)
            view.window?.makeFirstResponder(nameField)
            return
        }
        let identity = MeetingIdentity(name: name, email: email)
        guard identity.isValidGuest else {
            statusLabel.showError(GuestEntryWords.emailInvalid)
            view.window?.makeFirstResponder(emailField)
            return
        }
        let typed = roomField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if !StarlingsWorkspaceLink.isActive(typed) {
            Task { _ = await LinkWorkspaceOffer.handle(typed, in: view.window) }
            return
        }
        guard let room = RoomSlug(rawValue: MeetingInvite.roomSlug(fromJoinURL: typed) ?? typed) else {
            statusLabel.showError(GuestEntryWords.roomInvalid)
            view.window?.makeFirstResponder(roomField)
            return
        }
        roomField.stringValue = room.rawValue
        statusLabel.clear()
        onContinueAsGuest?(name, email, room.rawValue)
    }

    private func setBusy(_ busy: Bool, origin: String? = nil) {
        door.busyOrigin = busy ? origin : nil
        continueGuestButton.isEnabled = !busy
        nameField.isEnabled = !busy
        emailField.isEnabled = !busy
        roomField.isEnabled = !busy
        pasteRoomButton.isEnabled = !busy
        lede.stringValue = busy ? Self.ledeWaiting : Self.ledeIdle
        lede.textColor = busy ? StarlingsColors.primaryText : StarlingsColors.secondaryText
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.2
            context.allowsImplicitAnimation = true
            for control in guestControls {
                control.animator().alphaValue = busy ? 0.35 : 1
            }
        }
    }
}
