import AppKit

/// The identity every person-facing surface should carry.
///
/// Email is the stable key; the display name is presentation only. Keeping the
/// two together means a future profile-picture source can be added once and
/// threaded through Work, chat, tasks, and Team without each surface inventing
/// its own fallback rules.
struct StarlingsAvatarIdentity: Equatable, Sendable {
    let displayName: String
    let email: String?
    /// When this person's picture last changed, straight off the roster. Nil
    /// means initials — for somebody who never uploaded one, and for a surface
    /// that knows a name but has no roster row behind it.
    let avatarUpdatedAt: Date?
    let agentAvatar: AgentAvatarIdentityWire?
    let isInMeeting: Bool

    init(
        displayName: String,
        email: String? = nil,
        avatarUpdatedAt: Date? = nil,
        agentAvatar: AgentAvatarIdentityWire? = nil,
        isInMeeting: Bool = false
    ) {
        self.displayName = displayName
        self.email = email
        self.avatarUpdatedAt = avatarUpdatedAt
        self.agentAvatar = agentAvatar
        self.isInMeeting = isInMeeting
    }

    /// The roster's own answer about a person, so no surface assembles this
    /// three different ways.
    init(peer: Peer) {
        self.init(
            displayName: peer.displayName,
            email: peer.email,
            avatarUpdatedAt: peer.avatarUpdatedAt,
            agentAvatar: peer.agentAvatar,
            isInMeeting: peer.status == .inMeeting
        )
    }

    var initials: String {
        let source = displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? (email ?? "?")
            : displayName
        return ParticipantInitials.make(from: source)
    }

    var accessibilityName: String {
        let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let email, !email.isEmpty else { return name.isEmpty ? String(localized: "Person") : name }
        return name.isEmpty ? email : "\(name), \(email)"
    }
}

/// A small, reusable person marker for the Work sidebar and its content.
///
/// Draws the person's picture when the roster says they have one, and their
/// initials — the same two letters, in the same well — when it does not. The
/// initials are not a placeholder to be replaced: they are what a person
/// without a picture looks like, permanently, so a picture arriving late (or
/// never) is the same drawing either way. GitHub issue avatars keep using
/// `StarlingsLoginAvatar`, which enforces the Worker proxy/privacy boundary for
/// that separate identity system.
@MainActor
final class StarlingsPersonAvatarView: NSView {
    /// Where pictures come from. One per process, and settable so a test or a
    /// preview can draw this view without a session.
    static var avatarSource: PersonAvatarSource = MeetingControlAPI()

    private let initialsLabel = NSTextField(labelWithString: "")
    private let well = NSView()
    private let pictureView = NSImageView()
    private let agentArtwork = StarlingsAgentAvatarArtworkView()
    private var identityIsInMeeting: Bool
    private var status: PeerStatus?
    private var isInMeeting: Bool { identityIsInMeeting || status == .inMeeting }
    private var pictureLoad: Task<Void, Never>?
    private var presenceDot: NSView?
    init(identity: StarlingsAvatarIdentity, diameter: CGFloat, status: PeerStatus? = nil) {
        identityIsInMeeting = identity.isInMeeting
        self.status = status
        super.init(frame: .zero)
        wantsLayer = true

        well.wantsLayer = true
        well.translatesAutoresizingMaskIntoConstraints = false
        well.layer?.cornerRadius = diameter / 2
        well.layer?.cornerCurve = .continuous
        addSubview(well)

        initialsLabel.font = .systemFont(ofSize: max(9, diameter * 0.36), weight: .semibold)
        initialsLabel.alignment = .center
        initialsLabel.translatesAutoresizingMaskIntoConstraints = false
        well.addSubview(initialsLabel)

        // Over the initials rather than instead of them: nothing has to be
        // unwound when a picture fails to arrive, and the well is never empty.
        pictureView.wantsLayer = true
        pictureView.imageScaling = .scaleProportionallyUpOrDown
        pictureView.layer?.cornerRadius = diameter / 2
        pictureView.layer?.cornerCurve = .continuous
        pictureView.layer?.masksToBounds = true
        pictureView.isHidden = true
        pictureView.translatesAutoresizingMaskIntoConstraints = false
        well.addSubview(pictureView)

        agentArtwork.isHidden = true
        agentArtwork.translatesAutoresizingMaskIntoConstraints = false
        well.addSubview(agentArtwork)

        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: diameter),
            heightAnchor.constraint(equalToConstant: diameter),
            well.leadingAnchor.constraint(equalTo: leadingAnchor),
            well.trailingAnchor.constraint(equalTo: trailingAnchor),
            well.topAnchor.constraint(equalTo: topAnchor),
            well.bottomAnchor.constraint(equalTo: bottomAnchor),
            initialsLabel.centerXAnchor.constraint(equalTo: well.centerXAnchor),
            initialsLabel.centerYAnchor.constraint(equalTo: well.centerYAnchor),
            pictureView.leadingAnchor.constraint(equalTo: well.leadingAnchor),
            pictureView.trailingAnchor.constraint(equalTo: well.trailingAnchor),
            pictureView.topAnchor.constraint(equalTo: well.topAnchor),
            pictureView.bottomAnchor.constraint(equalTo: well.bottomAnchor),
            agentArtwork.leadingAnchor.constraint(equalTo: well.leadingAnchor),
            agentArtwork.trailingAnchor.constraint(equalTo: well.trailingAnchor),
            agentArtwork.topAnchor.constraint(equalTo: well.topAnchor),
            agentArtwork.bottomAnchor.constraint(equalTo: well.bottomAnchor),
        ])

        setIdentity(identity)
        setStatus(status)
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setIdentity(_ identity: StarlingsAvatarIdentity) {
        identityIsInMeeting = identity.isInMeeting
        initialsLabel.stringValue = identity.initials
        toolTip = identity.accessibilityName
        setAccessibilityLabel(identity.accessibilityName)
        agentArtwork.identity = identity.agentAvatar
        agentArtwork.isHidden = identity.agentAvatar == nil
        initialsLabel.isHidden = identity.agentAvatar != nil
        recolour()
        renderPresenceDot()
        loadPicture(for: identity)
    }

    private func loadPicture(for identity: StarlingsAvatarIdentity) {
        pictureLoad?.cancel()
        guard identity.agentAvatar == nil else {
            pictureView.image = nil
            pictureView.isHidden = true
            return
        }
        guard let email = identity.email else {
            pictureView.image = nil
            pictureView.isHidden = true
            return
        }
        // Drawn before anything is awaited. `PersonAvatarStore` is an actor, so
        // even a cache hit costs a hop — and a hop is a frame of initials. The
        // roster redraws its rows every poll, so that frame was a visible flash
        // on every face, every thirty seconds, and again on every sidebar click.
        if let ready = StarlingsAvatarImageCache.shared.image(email: email, version: identity.avatarUpdatedAt) {
            pictureView.image = ready
            pictureView.isHidden = false
        } else {
            // A different person in a recycled view must not keep the old face.
            pictureView.image = nil
            pictureView.isHidden = true
        }
        // No version here is not "no picture": a message row or a task
        // assignee knows an address and nothing else, and the store answers
        // from the version the roster last published for that person.
        let version = identity.avatarUpdatedAt
        let source = Self.avatarSource
        pictureLoad = Task { [weak self] in
            let data = await PersonAvatarStore.shared.avatar(email: email, version: version, from: source)
            guard !Task.isCancelled, let self else { return }
            guard let data, let image = NSImage(data: data) else {
                // Still initials. Not an error state — see the type comment.
                self.pictureView.image = nil
                self.pictureView.isHidden = true
                return
            }
            let square = StarlingsProfilePicture.squareCropped(image)
            StarlingsAvatarImageCache.shared.store(square, email: email, version: version)
            self.pictureView.image = square
            self.pictureView.isHidden = false
        }
    }

    func setStatus(_ status: PeerStatus?) {
        self.status = status
        renderPresenceDot()
    }

    private func renderPresenceDot() {
        presenceDot?.removeFromSuperview()
        presenceDot = nil
        guard let status else { return }
        let color = isInMeeting ? StarlingsColors.presenceInMeeting : Self.dotColor(for: status)
        guard let color else { return }

        let dot = NSView()
        dot.wantsLayer = true
        dot.layer?.backgroundColor = StarlingsColors.resolved(color, for: self).cgColor
        let diameter: CGFloat = isInMeeting ? 15 : 10
        dot.layer?.cornerRadius = diameter / 2
        dot.layer?.borderWidth = 2
        dot.layer?.borderColor = StarlingsColors.resolved(StarlingsColors.canvas, for: self).cgColor
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.toolTip = isInMeeting ? String(localized: "In a meeting") : status.label
        if isInMeeting {
            let video = NSImageView()
            video.image = NSImage(systemSymbolName: "video.fill", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 7, weight: .semibold))
            video.contentTintColor = StarlingsColors.canvas
            video.translatesAutoresizingMaskIntoConstraints = false
            dot.addSubview(video)
            NSLayoutConstraint.activate([
                video.centerXAnchor.constraint(equalTo: dot.centerXAnchor),
                video.centerYAnchor.constraint(equalTo: dot.centerYAnchor),
                video.widthAnchor.constraint(equalToConstant: 8),
                video.heightAnchor.constraint(equalToConstant: 7),
            ])
        }
        addSubview(dot)
        NSLayoutConstraint.activate([
            dot.widthAnchor.constraint(equalToConstant: diameter),
            dot.heightAnchor.constraint(equalToConstant: diameter),
            dot.trailingAnchor.constraint(equalTo: trailingAnchor, constant: 2),
            dot.bottomAnchor.constraint(equalTo: bottomAnchor, constant: 2),
        ])
        presenceDot = dot
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        recolour()
    }

    private func recolour() {
        well.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: self).cgColor
        well.layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor
        well.layer?.borderWidth = 1
        initialsLabel.textColor = StarlingsColors.primaryText
        if let presenceDot {
            presenceDot.layer?.borderColor = StarlingsColors.resolved(StarlingsColors.canvas, for: self).cgColor
        }
    }

    private static func dotColor(for status: PeerStatus) -> NSColor? {
        switch status {
        // A step below active, mixed opaque: a dot is never translucent.
        case .doNotDisturb: StarlingsColors.secondaryText.blended(withFraction: 0.5, of: StarlingsColors.canvas) ?? StarlingsColors.secondaryText
        case .inMeeting: StarlingsColors.presenceInMeeting
        case .busy: StarlingsColors.presenceBusy
        case .available: StarlingsColors.accent
        case .active: StarlingsColors.accent
        case .offline: nil
        }
    }
}

/// Static vector avatar shared by Mac and iOS through the canonical paths in
/// `AgentAvatarIdentityWire`. The only depth cue is a soft cast shadow; the
/// body stays one flat roster color and the projected eye shapes stay white.
@MainActor
private final class StarlingsAgentAvatarArtworkView: NSView {
    var identity: AgentAvatarIdentityWire? {
        didSet { needsDisplay = true }
    }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        guard let identity,
              let context = NSGraphicsContext.current?.cgContext,
              let color = MeetingPlatformMarkGeometry.color(hex: identity.color) else { return }
        let bounds = self.bounds
        let bodyRect = bounds.insetBy(dx: bounds.width * 0.025, dy: bounds.height * 0.025)
        guard let body = MeetingPlatformMarkGeometry.agentAvatarPath(identity.bodyPath, in: bodyRect) else { return }

        context.saveGState()
        context.setShadow(offset: CGSize(width: 0, height: 2), blur: max(1, bounds.width * 0.045), color: NSColor.black.withAlphaComponent(0.18).cgColor)
        context.addPath(body)
        context.setFillColor(color)
        context.fillPath()
        context.restoreGState()

        if let eyes = MeetingPlatformMarkGeometry.agentAvatarPath(identity.eyesPath, in: bodyRect) {
            context.addPath(eyes)
            context.setFillColor(NSColor.white.cgColor)
            context.fillPath()
        }
    }
}

/// Turning whatever a person picked into what the Worker stores.
///
/// The clients do this, not the Worker: a Mac, a phone and a browser all have
/// the image decoded already, and the alternative is an image pipeline in a
/// Worker that would exist only to shrink pictures nobody needed to send at
/// full size. Centre-cropped so a landscape photo lands in a round well the
/// same way a portrait one does.
enum StarlingsProfilePicture {
    /// The edge every client uploads at (`AVATAR_EDGE_PIXELS`).
    static let edge = ContractConstants.avatarEdgePixels

    /// The centre square of an image, at the source's pixels. An
    /// `NSImageView` has no aspect-fill mode, so a round well fills the way
    /// the phone's `scaledToFill` and the web's `object-fit: cover` do by
    /// cropping first. A square image comes back as itself.
    static func squareCropped(_ image: NSImage) -> NSImage {
        guard let source = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
              source.width != source.height,
              let cropped = centreSquare(of: source) else { return image }
        let side = CGFloat(cropped.width)
        return NSImage(cgImage: cropped, size: NSSize(width: side, height: side))
    }

    private static func centreSquare(of source: CGImage) -> CGImage? {
        let side = min(source.width, source.height)
        return source.cropping(to: CGRect(
            x: (source.width - side) / 2,
            y: (source.height - side) / 2,
            width: side,
            height: side
        ))
    }

    static func squareJPEG(from image: NSImage) -> Data? {
        guard let source = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        let cropped = centreSquare(of: source) ?? source

        guard let context = CGContext(
            data: nil,
            width: edge,
            height: edge,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { return nil }
        context.interpolationQuality = .high
        context.draw(cropped, in: CGRect(x: 0, y: 0, width: edge, height: edge))
        guard let scaled = context.makeImage() else { return nil }

        let representation = NSBitmapImageRep(cgImage: scaled)
        return representation.representation(using: .jpeg, properties: [.compressionFactor: 0.86])
    }
}

/// The fixed identity/status shelf at the foot of the Work sidebar.
///
/// It is intentionally outside the scroll view: identity and interruption
/// state are chrome, not another item in the navigable work list.
@MainActor
final class WorkProfileFooter: NSView {
    /// The whole status question, answered in one choice. See
    /// `PeerStatusOption` for why unavailable and intent share one control.
    var onChange: ((PeerStatusOption) -> Void)?

    private let owner: OwnerProfile?
    private let avatar: StarlingsPersonAvatarView
    /// The identity currently drawn. The picture itself is changed in
    /// Settings → Account, which is where somebody goes looking for it; this
    /// shelf draws who you are and what you are doing, and nothing here is a
    /// control.
    private var identity: StarlingsAvatarIdentity
    private let nameLabel = NSTextField(labelWithString: "")
    private let emailLabel = NSTextField(labelWithString: "")
    private let popup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let statusMenu = NSStackView()
    private let statusChevron = NSImageView()
    private let separator = SettingsChrome.hairline()

    init(owner: OwnerProfile?) {
        self.owner = owner
        let identity = StarlingsAvatarIdentity(
            displayName: owner?.name ?? String(localized: "Not signed in"),
            email: owner?.email
        )
        avatar = StarlingsPersonAvatarView(identity: identity, diameter: 32)
        self.identity = identity
        super.init(frame: .zero)

        nameLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold)
        nameLabel.lineBreakMode = .byTruncatingTail
        emailLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        emailLabel.textColor = StarlingsColors.secondaryText
        emailLabel.lineBreakMode = .byTruncatingTail
        // Truncating says what a squeezed label *draws*; it does not make the
        // label agree to be squeezed. Set on the labels themselves, because
        // the priority set on the stack below them does not reach them — the
        // stack's fitting width is still whatever its children insist on, and
        // A long address insists on 111pt at a priority above the split
        // view's, which put a floor under this whole rail.
        nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        emailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let identityText = NSStackView(views: [nameLabel, emailLabel])
        identityText.orientation = .vertical
        identityText.alignment = .leading
        identityText.spacing = 2
        identityText.translatesAutoresizingMaskIntoConstraints = false

        if let cell = popup.cell as? NSPopUpButtonCell {
            cell.arrowPosition = .noArrow
        }
        let chevronConfiguration = NSImage.SymbolConfiguration(pointSize: 10, weight: .semibold)
        statusChevron.image = NSImage(
            systemSymbolName: "chevron.down",
            accessibilityDescription: String(localized: "Change status")
        )?.withSymbolConfiguration(chevronConfiguration)
        statusChevron.contentTintColor = StarlingsColors.secondaryText
        statusChevron.isEnabled = false
        statusChevron.translatesAutoresizingMaskIntoConstraints = false

        statusMenu.orientation = .horizontal
        statusMenu.alignment = .centerY
        statusMenu.spacing = 2
        statusMenu.addArrangedSubview(popup)
        statusMenu.addArrangedSubview(statusChevron)
        statusMenu.translatesAutoresizingMaskIntoConstraints = false
        statusMenu.setContentHuggingPriority(.required, for: .horizontal)
        // **Not `.required`.** It was, and at a priority above the sidebar
        // item's holding priority of 260 the status alone decided how narrow
        // Work's rail could be dragged. The status still never *stretches* —
        // that is what the hugging above is for — it only agrees to be
        // shortened.
        statusMenu.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let identityRow = NSStackView(views: [avatar, identityText, NSView(), statusMenu])
        identityRow.orientation = .horizontal
        identityRow.alignment = .centerY
        identityRow.spacing = 8
        identityRow.translatesAutoresizingMaskIntoConstraints = false
        identityText.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        for option in PeerStatusOption.allCases {
            popup.addItem(withTitle: option.label)
        }
        popup.bezelStyle = .inline
        popup.isBordered = false
        popup.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .medium)
        popup.contentTintColor = StarlingsColors.secondaryText
        popup.target = self
        popup.action = #selector(statusChanged)
        popup.translatesAutoresizingMaskIntoConstraints = false
        SettingsChrome.applyQuietButton(popup)
        // Far enough to read "Available" whole and to stay worth clicking; the
        // longer statuses truncate.
        popup.allowSqueezing(toAtLeast: 80)

        separator.translatesAutoresizingMaskIntoConstraints = false
        addSubview(separator)
        addSubview(identityRow)

        NSLayoutConstraint.activate([
            separator.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            separator.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            separator.topAnchor.constraint(equalTo: topAnchor),
            identityRow.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            identityRow.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            identityRow.topAnchor.constraint(equalTo: separator.bottomAnchor, constant: 8),
            identityRow.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            heightAnchor.constraint(equalToConstant: 64),
        ])

        setOwner(owner)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setPeer(_ peer: Peer?) {
        let identity = StarlingsAvatarIdentity(
            displayName: peer?.displayName ?? owner?.name ?? String(localized: "Not signed in"),
            email: peer?.email ?? owner?.email,
            // Your own row on the roster is what says whether you have a
            // picture, and when it last changed.
            avatarUpdatedAt: peer?.avatarUpdatedAt
        )
        self.identity = identity
        avatar.setIdentity(identity)
        avatar.setStatus(peer?.displayState.dot)
        popup.selectItem(at: PeerStatusOption.selectedIndex(for: peer))
        nameLabel.stringValue = identity.displayName
        // While hidden, the second line is the reminder rather than the
        // address: you already know your email; you may forget you are unseen.
        let hidden = peer?.invisible ?? false
        emailLabel.stringValue = hidden ? PeerStatusOption.appearOfflineReminder : (identity.email ?? "")
        emailLabel.textColor = hidden ? StarlingsColors.secondaryText : StarlingsColors.secondaryText
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        statusChevron.contentTintColor = StarlingsColors.secondaryText
    }

    private func setOwner(_ owner: OwnerProfile?) {
        let identity = StarlingsAvatarIdentity(
            displayName: owner?.name ?? String(localized: "Not signed in"),
            email: owner?.email,
            avatarUpdatedAt: self.identity.avatarUpdatedAt
        )
        self.identity = identity
        avatar.setIdentity(identity)
        nameLabel.stringValue = identity.displayName
        emailLabel.stringValue = identity.email ?? ""
        setAccessibilityLabel(String(localized: "Your profile, \(identity.accessibilityName)"))
    }

    @objc private func statusChanged() {
        let options = PeerStatusOption.allCases
        let index = popup.indexOfSelectedItem
        guard options.indices.contains(index) else { return }
        onChange?(options[index])
    }
}

/// Decoded faces, on the main actor, so a redraw can put one on screen without
/// awaiting anything.
///
/// Deliberately a second cache rather than a change to `PersonAvatarStore`:
/// that one owns bytes, versioning and the network, and it is an actor for good
/// reasons. This owns nothing but already-decoded `NSImage`s for the surface
/// that is drawing right now, which is the only thing a synchronous redraw can
/// use. Keyed by version, so a new picture never reads from the old key.
@MainActor
final class StarlingsAvatarImageCache {
    static let shared = StarlingsAvatarImageCache()

    /// A team's worth of faces, several versions deep. Small enough to ignore,
    /// bounded so a long session cannot grow without end.
    private static let maximumEntries = 128

    private var images: [String: NSImage] = [:]
    private var order: [String] = []

    func image(email: String, version: Date?) -> NSImage? {
        guard let key = Self.key(email: email, version: version) else { return nil }
        return images[key]
    }

    func store(_ image: NSImage, email: String, version: Date?) {
        guard let key = Self.key(email: email, version: version) else { return }
        if images[key] == nil { order.append(key) }
        images[key] = image
        while order.count > Self.maximumEntries {
            images.removeValue(forKey: order.removeFirst())
        }
    }

    /// Somebody's picture changed. Dropped here as well as in the store, or the
    /// old face would survive its own replacement.
    func forget(email: String) {
        let prefix = "\(email.lowercased())|"
        order.removeAll { $0.hasPrefix(prefix) }
        images = images.filter { !$0.key.hasPrefix(prefix) }
    }

    /// No version is no picture: the caller has nothing to key on, and guessing
    /// would serve a face that may already have been replaced.
    private static func key(email: String, version: Date?) -> String? {
        guard let version else { return nil }
        return String(localized: "\(email.lowercased())|\(Int(version.timeIntervalSince1970 * 1000))")
    }
}
