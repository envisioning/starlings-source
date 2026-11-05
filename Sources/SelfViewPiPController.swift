import AppKit
import LiveKit

/// Floating always-on-top self-view so the host can park their camera near the
/// laptop webcam while the main Meet window sits elsewhere (or behind other apps).
@MainActor
final class SelfViewPiPController: NSObject, NSWindowDelegate {
    var onClose: (() -> Void)?
    var onHide: (() -> Void)?
    var onDockToCorner: (() -> Void)?

    private let videoView = VideoView()
    private let avatar = ParticipantAvatarView()
    private var panel: NSPanel?
    private var localTrack: VideoTrack?
    private var displayName = "You"

    var isVisible: Bool { panel?.isVisible == true }

    func show(relativeTo anchor: NSWindow?) {
        let panel = panel ?? makePanel()
        self.panel = panel
        applyTrack()
        if !panel.isVisible {
            positionNearCamera(panel, relativeTo: anchor)
        }
        panel.orderFrontRegardless()
    }

    func hide() {
        panel?.orderOut(nil)
        videoView.track = nil
    }

    func setTrack(_ track: VideoTrack?) {
        localTrack = track
        guard isVisible else { return }
        applyTrack()
    }

    func setDisplayName(_ name: String) {
        displayName = name.isEmpty ? String(localized: "You") : name
        avatar.initials = ParticipantInitials.make(from: displayName)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hide()
        onClose?()
        return false
    }

    private func applyTrack() {
        if videoView.track !== localTrack {
            videoView.track = localTrack
        }
        videoView.isHidden = localTrack == nil
        avatar.isHidden = localTrack != nil
        avatar.initials = ParticipantInitials.make(from: displayName)
    }

    private func makePanel() -> NSPanel {
        let content = SelfViewContentView(
            avatar: avatar,
            onHide: { [weak self] in self?.onHide?() },
            onDockToCorner: { [weak self] in self?.onDockToCorner?() }
        )
        content.frame = NSRect(x: 0, y: 0, width: 280, height: 158)
        content.wantsLayer = true
        content.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.panel, for: content).cgColor

        videoView.layoutMode = .fill
        videoView.renderMode = .sampleBuffer
        videoView.mirrorMode = .mirror
        content.addSubview(videoView)
        videoView.translatesAutoresizingMaskIntoConstraints = false
        videoView.pinToEdges(of: content)

        avatar.isHidden = true
        content.addSubview(avatar)
        avatar.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            avatar.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            avatar.centerYAnchor.constraint(equalTo: content.centerYAnchor),
        ])
        content.bringControlsToFront()

        let panel = NSPanel(
            contentRect: content.bounds,
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .utilityWindow, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = String(localized: "You")
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        panel.contentView = content
        panel.contentMinSize = NSSize(width: 160, height: 90)
        panel.contentAspectRatio = NSSize(width: 16, height: 9)
        panel.setContentSize(NSSize(width: 280, height: 158))
        panel.backgroundColor = StarlingsColors.panel
        panel.hasShadow = true
        return panel
    }

    /// Prefer the top-center of the screen that owns the Meet window — closest
    /// to a built-in webcam / notch — falling back to the main display.
    private func positionNearCamera(_ panel: NSPanel, relativeTo anchor: NSWindow?) {
        let screen = anchor?.screen ?? NSScreen.main
        guard let visible = screen?.visibleFrame else {
            panel.center()
            return
        }
        let size = panel.frame.size
        let origin = NSPoint(
            x: visible.midX - size.width / 2,
            y: visible.maxY - size.height - 16
        )
        panel.setFrame(NSRect(origin: origin, size: size), display: false)
    }
}

/// The panel is freely resizable, so the avatar has to be re-proportioned on
/// every layout pass — the circle has no size of its own.
@MainActor
private final class SelfViewContentView: NSView {
    private let avatar: ParticipantAvatarView
    private let hideButton = NSButton()
    private let cornerButton = NSButton()
    private let actions = NSStackView()
    private let onHide: () -> Void
    private let onDockToCorner: () -> Void

    init(
        avatar: ParticipantAvatarView,
        onHide: @escaping () -> Void,
        onDockToCorner: @escaping () -> Void
    ) {
        self.avatar = avatar
        self.onHide = onHide
        self.onDockToCorner = onDockToCorner
        super.init(frame: .zero)

        configureButton(
            hideButton,
            symbolName: "eye.slash",
            accessibilityLabel: String(localized: "Hide your self-view"),
            action: #selector(hidePressed)
        )
        configureButton(
            cornerButton,
            symbolName: "arrow.down.left",
            accessibilityLabel: String(localized: "Put your self-view on the stage in the bottom-left corner"),
            action: #selector(dockToCornerPressed)
        )

        actions.addArrangedSubview(cornerButton)
        actions.addArrangedSubview(hideButton)
        actions.orientation = .horizontal
        actions.alignment = .centerY
        actions.spacing = 6
        addSubview(actions)
        actions.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            actions.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            actions.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            hideButton.widthAnchor.constraint(equalToConstant: 28),
            hideButton.heightAnchor.constraint(equalToConstant: 28),
            cornerButton.widthAnchor.constraint(equalToConstant: 28),
            cornerButton.heightAnchor.constraint(equalToConstant: 28),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layout() {
        super.layout()
        avatar.resize(forHost: bounds)
    }

    func bringControlsToFront() {
        addSubview(actions, positioned: .above, relativeTo: nil)
    }

    private func configureButton(
        _ button: NSButton,
        symbolName: String,
        accessibilityLabel: String,
        action: Selector
    ) {
        button.isBordered = false
        button.bezelStyle = .inline
        button.image = NSImage(
            systemSymbolName: symbolName,
            accessibilityDescription: accessibilityLabel
        )?.withSymbolConfiguration(.init(pointSize: 12, weight: .semibold))
        button.contentTintColor = .white
        StarlingsFloatingGlass.scrimButton(button, cornerRadius: 7)
        button.setAccessibilityLabel(accessibilityLabel)
        button.target = self
        button.action = action
    }

    @objc private func hidePressed() {
        onHide()
    }

    @objc private func dockToCornerPressed() {
        onDockToCorner()
    }
}
