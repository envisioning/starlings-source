import AppKit
import QuartzCore

/// The soft edge under a toolbar, drawn by Meet.
///
/// A window whose content runs under its toolbar
/// (`StarlingsWindowChrome.apply(contentUnderToolbar:)`) needs the content to
/// leave gracefully as it scrolls up: blurred and faded into the canvas over
/// the toolbar's bottom edge, not clipped at the window's top. macOS 26's
/// glass toolbar draws that itself (`StarlingsWindowChrome.hasNativeScrollEdge`);
/// below 26 this view stands in: a Core Image blur on what lies under it,
/// masked so it ramps from full under the toolbar to nothing at the bottom,
/// and a canvas gradient over it for the fade. It spans the toolbar's height
/// plus `ramp`, takes no clicks, and follows the appearance.
///
/// Pin it to the top of the scroll view it covers; the owner sets `height`
/// from its `safeAreaInsets.top` plus `ramp` on layout.
@MainActor
final class StarlingsSoftEdgeView: NSView {
    /// How far below the toolbar the effect runs out.
    static let ramp: CGFloat = 36

    private let blur = CALayer()
    private let blurMask = CAGradientLayer()
    private let fade = CAGradientLayer()

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        layerUsesCoreImageFilters = true
        translatesAutoresizingMaskIntoConstraints = false

        if let filter = CIFilter(name: "CIGaussianBlur") {
            filter.setValue(14, forKey: kCIInputRadiusKey)
            blur.backgroundFilters = [filter]
        }
        // Layers are not flipped: (0, 0) is the bottom. Full at the top,
        // gone at the bottom, with the blur's own soft edge hidden under the
        // fade's last stretch.
        blurMask.startPoint = CGPoint(x: 0.5, y: 0)
        blurMask.endPoint = CGPoint(x: 0.5, y: 1)
        blurMask.colors = [NSColor.clear.cgColor, NSColor.white.cgColor, NSColor.white.cgColor]
        blurMask.locations = [0, 0.55, 1]
        blur.mask = blurMask

        fade.startPoint = CGPoint(x: 0.5, y: 0)
        fade.endPoint = CGPoint(x: 0.5, y: 1)
        fade.locations = [0, 0.45, 1]

        layer?.addSublayer(blur)
        layer?.addSublayer(fade)
        paintFade()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        blur.frame = bounds
        blurMask.frame = bounds
        fade.frame = bounds
        CATransaction.commit()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        paintFade()
    }

    /// Never in the way of the content it covers.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    private func paintFade() {
        let canvas = StarlingsColors.resolved(StarlingsColors.canvas, for: self)
        fade.colors = [
            canvas.withAlphaComponent(0).cgColor,
            canvas.withAlphaComponent(0.55).cgColor,
            canvas.withAlphaComponent(0.9).cgColor,
        ]
    }
}
