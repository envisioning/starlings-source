import AppKit

/// Initials in a circle — what a video surface shows while the camera is off.
///
/// Every surface that can show a person shares it (stage tiles, floating
/// self-view), so your own camera-off tile looks the same as the one everyone
/// else is seeing of you. The web guest draws the same circle as
/// `.meet-avatar`; the proportions here are that stylesheet's.
@MainActor
final class ParticipantAvatarView: NSView {
    private let label = NSTextField(labelWithString: "")
    private lazy var widthConstraint = widthAnchor.constraint(equalToConstant: 0)
    private lazy var heightConstraint = heightAnchor.constraint(equalToConstant: 0)

    /// Diameter as a fraction of the host view's short side, and the cap past
    /// which a large surface stops growing the circle.
    private static let hostFraction: CGFloat = 0.46
    private static let maximumDiameter: CGFloat = 128
    /// Cap-height that keeps two initials comfortably inside the circle.
    private static let textFraction: CGFloat = 0.34

    var initials: String {
        get { label.stringValue }
        set { label.stringValue = newValue }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: self).cgColor
        layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor
        layer?.borderWidth = 1

        label.alignment = .center
        label.textColor = StarlingsColors.primaryText
        addSubview(label)
        label.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: centerXAnchor),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            widthConstraint,
            heightConstraint,
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Called from the host's own layout pass — the circle has no intrinsic
    /// size, it is always a proportion of the surface behind it.
    func resize(forHost bounds: NSRect) {
        let diameter = min(min(bounds.width, bounds.height) * Self.hostFraction, Self.maximumDiameter)
        guard abs(diameter - widthConstraint.constant) > 0.5 else { return }
        widthConstraint.constant = diameter
        heightConstraint.constant = diameter
        layer?.cornerRadius = diameter / 2
        label.font = .systemFont(ofSize: max(11, diameter * Self.textFraction), weight: .semibold)
    }
}
