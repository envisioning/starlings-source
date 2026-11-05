import AppKit
import QuartzCore

/// Brand-tinged grid behind the Mac launch surface and meeting Stage. It is
/// off entirely when `HomeTexturePreferences` says so.
///
/// Every cell is a square of `HomeGridLattice.pitch`, always, and the lattice is
/// anchored to the centre of the view — see `HomeGridLattice` for why that is
/// what keeps a live resize from stuttering. The ragged part-cells at the
/// margins are handled by the edge fade rather than by drawing them, which is
/// why the fade runs on all four sides.
///
/// Each line carries a baked-in alpha so the field reads as varied rather than
/// uniform. One thing moves: the field resolves outward from its centre when
/// Home comes back. Reduce Motion drops it.
///
/// Home uses the mark's accent at low alpha in dark mode and monochrome ink in
/// light. The meeting Stage switches this same field to neutral text in both
/// appearances so the call controls and participants keep the visual priority.
@MainActor
final class BrandGridBackground: NSView {
    /// Masked radially for the reveal; holds the field, which is masked
    /// horizontally; which holds the grid, masked vertically. One-axis
    /// gradients nested is the cheapest way to fade all four sides.
    private let revealLayer = CALayer()
    private let fieldLayer = CALayer()
    private let gridLayer = GridLinesLayer()
    private let horizontalFade = CAGradientLayer()
    private let verticalFade = CAGradientLayer()
    private let revealMask = CAGradientLayer()

    /// Whether the meeting phase currently allows the texture. Kept so a
    /// preference change can be re-evaluated without waiting for a phase change.
    private var phaseAllowsTexture = true
    /// Home earns the brand-tinted field; a live meeting uses neutral lines so
    /// the stage does not compete with the command row or speaking state.
    private var usesMeetingPalette = false
    /// The first visibility application is instant — Home should open with the
    /// grid already there, not materialise in the user's face at launch.
    private var hasAppliedVisibility = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = .clear

        // Plain `CALayer`s with a custom `draw(in:)` do not redraw on a
        // bounds change by default — Core Animation just stretches the
        // existing rasterized content to fill the new frame, non-uniformly
        // whenever a live resize isn't proportional. That is what turned the
        // "always square" lattice into a visibly deforming one: `layout()`
        // resizes `gridLayer` every tick but never told them to
        // redraw. Opting in here makes the resize synchronous instead —
        // cells stay the fixed `HomeGridLattice.pitch` square the geometry
        // already promises.
        gridLayer.needsDisplayOnBoundsChange = true

        gridLayer.mask = verticalFade
        fieldLayer.mask = horizontalFade
        fieldLayer.addSublayer(gridLayer)
        revealLayer.mask = revealMask
        revealLayer.addSublayer(fieldLayer)
        layer?.addSublayer(revealLayer)

        configureFades()
        configureReveal()
        bakeMultipliers()

        onMeetAppearanceChange { [weak self] _ in self?.refreshAppearance() }
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(texturePreferenceChanged),
            name: HomeTexturePreferences.didChangeNotification,
            object: nil
        )
        refreshAppearance()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Texture, never a target. The surface's own controls sit above this view;
    /// nothing here should ever swallow a click meant for them.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    /// Phase-driven visibility for the launch-surface instance. `.connecting`
    /// and `.connected` hand that canvas back to the in-call chrome.
    func setVisible(for phase: MeetingPhase) {
        usesMeetingPalette = false
        phaseAllowsTexture = phase.isIdle
        refreshAppearance()
        applyVisibility()
    }

    /// The meeting Stage uses the same texture, but remains visible while the
    /// room is connected. The user's texture preference still applies.
    func setVisibleForMeeting() {
        usesMeetingPalette = true
        phaseAllowsTexture = true
        refreshAppearance()
        applyVisibility()
    }

    @objc private func texturePreferenceChanged() {
        applyVisibility()
    }

    private func applyVisibility() {
        let visible = phaseAllowsTexture && HomeTexturePreferences.showsTexture()
        // First pass lands instantly: opening Home is not a transition.
        let animated = hasAppliedVisibility && !prefersReducedMotion
        hasAppliedVisibility = true
        apply(visible: visible, animated: animated)
    }

    private var prefersReducedMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    private func apply(visible: Bool, animated: Bool) {
        guard let layer else { return }
        let target: Float = visible ? 1 : 0
        guard animated else {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            layer.opacity = target
            CATransaction.commit()
            isHidden = !visible
            return
        }
        // Coming back to Home, the field resolves outward from the middle
        // rather than fading up flat — the room being run up again. Leaving is
        // still a plain fade: a call is starting and nothing here should draw
        // the eye on the way out.
        guard visible else {
            fadeOut()
            return
        }
        isHidden = false
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.opacity = 1
        layer.removeAnimation(forKey: "meet.grid.fade")
        CATransaction.commit()
        runReveal()
    }

    private func fadeOut() {
        guard let layer else { return }
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in
            guard let self else { return }
            if self.layer?.opacity == 0 { self.isHidden = true }
        }
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = layer.presentation()?.opacity ?? layer.opacity
        fade.toValue = 0
        fade.duration = HomeGridLattice.fadeDuration
        fade.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        layer.opacity = 0
        layer.add(fade, forKey: "meet.grid.fade")
        CATransaction.commit()
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        revealLayer.frame = bounds
        fieldLayer.frame = bounds
        gridLayer.frame = bounds
        horizontalFade.frame = bounds
        verticalFade.frame = bounds
        layoutReveal()
        CATransaction.commit()
    }

    /// Hairlines are one device pixel, so the layer has to know the scale it is
    /// drawing at or a 2x display gets a soft grid.
    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        gridLayer.contentsScale = window?.backingScaleFactor ?? 2
        gridLayer.setNeedsDisplay()
    }

    /// Fade on every side: the same atmospheric edge treatment used by the iOS
    /// and web renderers, so the three surfaces leave the same amount of
    /// background visible around the lattice.
    private func configureFades() {
        let verticalFadeLength = Double(HomeGridLattice.verticalFadeFraction)
        verticalFade.colors = [
            NSColor.clear.cgColor,
            NSColor.black.cgColor,
            NSColor.black.cgColor,
            NSColor.clear.cgColor
        ]
        verticalFade.locations = [
            0,
            NSNumber(value: verticalFadeLength),
            NSNumber(value: 1 - verticalFadeLength),
            1
        ]
        verticalFade.startPoint = CGPoint(x: 0.5, y: 0)
        verticalFade.endPoint = CGPoint(x: 0.5, y: 1)

        let horizontalFadeLength = Double(HomeGridLattice.horizontalFadeFraction)
        horizontalFade.colors = [
            NSColor.clear.cgColor,
            NSColor.black.cgColor,
            NSColor.black.cgColor,
            NSColor.clear.cgColor
        ]
        horizontalFade.locations = [
            0,
            NSNumber(value: horizontalFadeLength),
            NSNumber(value: 1 - horizontalFadeLength),
            1
        ]
        horizontalFade.startPoint = CGPoint(x: 0, y: 0.5)
        horizontalFade.endPoint = CGPoint(x: 1, y: 0.5)
    }

    /// At rest the reveal mask is opaque everywhere — it only exists for the
    /// half-second the field takes to resolve, and an idle Home must not be
    /// wearing a vignette.
    private func configureReveal() {
        revealMask.type = .radial
        revealMask.colors = [
            NSColor.black.cgColor,
            NSColor.black.cgColor,
            NSColor.clear.cgColor
        ]
        revealMask.locations = [0, 1, 1]
        revealMask.startPoint = CGPoint(x: 0.5, y: 0.5)
        revealMask.endPoint = CGPoint(x: 1, y: 1)
    }

    /// A radial gradient's location 1 is the ellipse through the mid-edges, so
    /// the corners sit at √2 of that. Oversizing the mask by half the
    /// difference puts the corners back inside location 1, which is what lets
    /// the reveal finish as a plain opaque mask rather than a clipped circle.
    private func layoutReveal() {
        let overshoot: CGFloat = (CGFloat(2).squareRoot() - 1) / 2
        revealMask.frame = bounds.insetBy(
            dx: -bounds.width * overshoot,
            dy: -bounds.height * overshoot
        )
    }

    private func runReveal() {
        let grow = CABasicAnimation(keyPath: "locations")
        grow.fromValue = [0, 0, 0.06].map(NSNumber.init(value:))
        grow.toValue = [0, 1, 1].map(NSNumber.init(value:))
        grow.duration = HomeGridLattice.revealDuration
        grow.timingFunction = CAMediaTimingFunction(name: .easeOut)
        revealMask.add(grow, forKey: "meet.grid.reveal")
    }

    private func bakeMultipliers() {
        let baked = HomeGridLattice.bakeMultipliers()
        gridLayer.columnMultipliers = baked.columns
        gridLayer.rowMultipliers = baked.rows
    }

    private func refreshAppearance() {
        let dark = StarlingsColors.isDark(effectiveAppearance)
        // Home: dark uses the mark's lime at low alpha — one of the four
        // allowed accent meanings ("ours / the mark"). Light is monochrome so
        // the brand colour stays reserved for fills. A meeting is neutral in
        // both appearances: the stage is atmosphere, not a status signal.
        let baseColor = StarlingsColors.resolved(
            usesMeetingPalette
                ? StarlingsColors.secondaryText
                : (dark ? StarlingsColors.accentMark : StarlingsColors.primaryText),
            for: self
        )
        let baseAlpha = dark ? HomeGridLattice.darkBaseAlpha : HomeGridLattice.lightBaseAlpha
        gridLayer.lineColor = baseColor.cgColor
        gridLayer.baseAlpha = baseAlpha
        gridLayer.setNeedsDisplay()
    }
}

/// Two-axis hairline field on a centre-anchored lattice. Each line is drawn
/// individually with a baked-in alpha, so the field has variety without
/// animation.
private final class GridLinesLayer: CALayer {
    var lineColor: CGColor = NSColor.white.withAlphaComponent(HomeGridLattice.darkBaseAlpha).cgColor
    var baseAlpha: CGFloat = HomeGridLattice.darkBaseAlpha
    var columnMultipliers: [CGFloat] = []
    var rowMultipliers: [CGFloat] = []

    override class func defaultAction(forKey event: String) -> CAAction? {
        // Bounds changes are handled by the owning view; suppress implicit
        // animations on frame/bounds so layout stays silent.
        NSNull()
    }

    override func draw(in ctx: CGContext) {
        guard bounds.width > 0, bounds.height > 0 else { return }

        // One device pixel, wherever it lands. `contentsScale` is set by the
        // view whenever the backing store changes.
        let scale = max(contentsScale, 1)
        ctx.setLineWidth(1 / scale)

        /// Put the line's centre on a half-pixel so a one-pixel stroke fills
        /// exactly one device pixel instead of straddling two at half strength.
        func align(_ value: CGFloat) -> CGFloat {
            ((value * scale).rounded() + 0.5) / scale
        }

        func drawLine(from: CGPoint, to: CGPoint, alpha: CGFloat) {
            ctx.setStrokeColor(lineColor.copy(alpha: alpha) ?? lineColor)
            ctx.beginPath()
            ctx.move(to: from)
            ctx.addLine(to: to)
            ctx.strokePath()
        }

        for index in HomeGridLattice.indices(span: bounds.width) {
            let x = align(HomeGridLattice.position(of: index, span: bounds.width))
            drawLine(
                from: CGPoint(x: x, y: 0),
                to: CGPoint(x: x, y: bounds.height),
                alpha: HomeGridLattice.alpha(columnMultipliers, index: index, base: baseAlpha)
            )
        }

        for index in HomeGridLattice.indices(span: bounds.height) {
            let y = align(HomeGridLattice.position(of: index, span: bounds.height))
            drawLine(
                from: CGPoint(x: 0, y: y),
                to: CGPoint(x: bounds.width, y: y),
                alpha: HomeGridLattice.alpha(rowMultipliers, index: index, base: baseAlpha)
            )
        }
    }
}
