import AppKit
import EnvisioningUI
import StarlingsContracts
import ObjectiveC
import SwiftUI

/// The root of every SwiftUI tree Meet hosts in an AppKit window — Core's
/// entity views, Docs, the subject fields. One place sets the tint, so a
/// `List` selection, a `Toggle`, a `Picker` or a `Color.accentColor` inside
/// draws the lime rather than the system blue ( follow-up). The
/// Info.plist accent (`ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME`)
/// covers the same ground only while the person's system accent is
/// Multicolor; this covers it always.
@MainActor
func meetHosted<Content: View>(_ content: Content) -> AnyView {
    AnyView(content.tint(Color(nsColor: StarlingsColors.accentMark)))
}

enum StarlingsColors {
    // The surface ladder is the estate's, not Meet's: `EnvisioningSurface`
    // in envisioning-ui, which CoreCRMUI stands on too. The
    // constants below are that table's rungs resolved for one appearance,
    // kept for `palettePairs`, which needs both sides of every rung.
    private static func rung(_ token: EnvisioningSurface.Token, dark: Bool) -> NSColor {
        let v = token.rgba(dark: dark)
        return NSColor(srgbRed: v.red, green: v.green, blue: v.blue, alpha: v.alpha)
    }

    private static let darkCanvas = rung(.canvas, dark: true) // #202128
    private static let darkPanel = rung(.panel, dark: true) // #292a32
    private static let darkElevated = rung(.elevated, dark: true) // #343640
    private static let darkBorder = rung(.border, dark: true)
    private static let darkBorderHover = rung(.borderHover, dark: true)
    /// A half-step stronger than the house border, for the in-call control row
    /// only. That row is the busiest chrome in the app and the one place a
    /// pill has to read as a button at a glance, not just on hover.
    private static let darkControlBorder = rung(.controlBorder, dark: true)
    private static let darkField = rung(.field, dark: true) // #1a1b21
    private static let darkPrimaryText = rung(.primaryText, dark: true) // #fafafa
    private static let darkSecondaryText = rung(.secondaryText, dark: true) // #a3a3a3
    private static let darkAccent = EnvisioningAccent.nsFill
    private static let darkAccentHover = EnvisioningAccent.nsFillHover
    private static let darkAccentDown = EnvisioningAccent.nsFillPressed
    /// `#1a1a1a`, the web's `--on-accent`; the same in both appearances.
    private static let darkAccentInk = NSColor(srgbRed: 26.0 / 255, green: 26.0 / 255, blue: 26.0 / 255, alpha: 1)
    private static let darkWeekendColumn = darkField

    // Light is the same ladder in neutral grey. The rungs encode depth and
    // nothing else, so they carry no hue — the lime was leaking into every
    // surface and every word, which made the whole window read as tinted. The
    // brand fill stays lime; only the down/pressed state is deliberately
    // #aacc00.
    // The light ladder is the same table's other column: canvas #efefef,
    // panel #f6f6f6, elevated #ffffff, well #e4e4e4.
    private static let lightCanvas = rung(.canvas, dark: false)
    private static let lightPanel = rung(.panel, dark: false)
    private static let lightElevated = rung(.elevated, dark: false)
    private static let lightBorder = rung(.border, dark: false)
    private static let lightBorderHover = rung(.borderHover, dark: false)
    /// Light-mode partner to `darkControlBorder` — see its comment.
    private static let lightControlBorder = rung(.controlBorder, dark: false)
    private static let lightField = rung(.field, dark: false)
    private static let lightPrimaryText = rung(.primaryText, dark: false)
    private static let lightSecondaryText = rung(.secondaryText, dark: false)
    // The accent on a light page is #aacc00 — as a fill, as ink, as a dot —
    // and the whole ramp steps down with it. Brand lime on white reads as a
    // highlighter laid over the page rather than a control sitting in it, and
    // as ink it measures 1.26:1. The resting fill is what used to be the
    // pressed state, so press takes a rung of its own underneath. The same
    // rule on iOS (`StarlingsMobileColors.accent`) and web (`--accent-cta`,
    // `--accent-mark`); see docs/DESIGN.md.
    private static let lightAccent = EnvisioningAccent.nsFillPressed // #aacc00
    private static let lightAccentHover = NSColor(srgbRed: 0.749, green: 0.878, blue: 0.000, alpha: 1) // #bfe000
    private static let lightAccentDown = NSColor(srgbRed: 0.569, green: 0.678, blue: 0.000, alpha: 1) // #91ad00
    private static let lightAccentCTA = lightAccent
    private static let lightAccentCTAHover = lightAccentHover
    private static let lightAccentCTADown = lightAccentDown
    private static let lightAccentInk = darkAccentInk
    private static let lightWeekendColumn = lightField

    static func isDark(_ appearance: NSAppearance) -> Bool {
        // Put the dark candidate first. This matters for an appearance such as
        // `.vibrantDark`, where AppKit's best match is chosen from the order we
        // provide rather than from the order of the enum cases.
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    }

    private static func adaptive(dark: NSColor, light: NSColor) -> NSColor {
        NSColor(name: nil) { appearance in
            isDark(appearance) ? dark : light
        }
    }

    /// `adaptive`, with the active workspace's shade in place of the
    /// product's own when the workspace names an accent (`WorkspaceAccent`).
    private static func workspaceAdaptive(_ shade: WorkspaceAccent.Shade, dark: NSColor, light: NSColor) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = isDark(appearance)
            guard let rgb = WorkspaceAccent.rgb(shade, dark: isDark) else { return isDark ? dark : light }
            return NSColor(srgbRed: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
        }
    }

    static let canvas = EnvisioningSurface.nsColor(.canvas)
    static let panel = EnvisioningSurface.nsColor(.panel)
    static let elevated = EnvisioningSurface.nsColor(.elevated)
    static let border = contrasting(EnvisioningSurface.nsColor(.border), alpha: 0.55)
    /// Hairline under the pointer. Brightening the edge alongside the fill keeps
    /// a hovered shell from looking like it lost its border to the lift.
    static let borderHover = contrasting(EnvisioningSurface.nsColor(.borderHover), alpha: 0.8)
    /// See `darkControlBorder`. Used by the in-call control row's pills and the
    /// chevron shell that rides beside Mute and Camera.
    static let controlBorder = contrasting(EnvisioningSurface.nsColor(.controlBorder), alpha: 0.7)
    /// Sunken fill for typed inputs — reads as a well on both `panel` and `elevated` surfaces.
    static let field = EnvisioningSurface.nsColor(.field)
    static let primaryText = EnvisioningSurface.nsColor(.primaryText)
    static let secondaryText = contrasting(EnvisioningSurface.nsColor(.secondaryText), alpha: nil)
    /// Text-range selection stays quiet inside a field: a translucent neutral
    /// veil keeps the text ink stable and lets the focused field's border lead.
    static let textSelectionFill = NSColor(name: nil) { appearance in
        let dark = isDark(appearance)
        return dark
            ? NSColor.white.withAlphaComponent(0.18)
            : NSColor.black.withAlphaComponent(0.08)
    }
    static var textSelectionAttributes: [NSAttributedString.Key: Any] {
        [
            .backgroundColor: textSelectionFill,
            .foregroundColor: primaryText,
        ]
    }

    /// Increase Contrast (System Settings → Accessibility → Display). The
    /// hairlines that encode depth at 10% become lines of ink at `alpha`, and
    /// with `alpha` nil the colour becomes the primary ink itself. AppKit
    /// reports the setting as the appearance's high-contrast variant, so a
    /// dynamic colour reads it the same way it reads dark and light, and the
    /// change follows the preference live. The web's `prefers-contrast: more`
    /// block applies the same alphas.
    private static func contrasting(_ base: NSColor, alpha: CGFloat?) -> NSColor {
        NSColor(name: nil) { appearance in
            let match = appearance.bestMatch(from: [
                .accessibilityHighContrastDarkAqua,
                .accessibilityHighContrastAqua,
                .darkAqua,
                .aqua,
            ])
            let highContrast = match == .accessibilityHighContrastAqua || match == .accessibilityHighContrastDarkAqua
            guard highContrast else { return base }
            let ink = resolved(EnvisioningSurface.nsColor(.primaryText), for: appearance)
            return alpha.map { ink.withAlphaComponent($0) } ?? ink
        }
    }
    static let accent = workspaceAdaptive(.fill, dark: darkAccent, light: lightAccent) // #d6f249 / #aacc00
    /// Hovered accent. Kept in lockstep with the web `--accent-cta-hover` token so
    /// the same CTA lights up the same way on both surfaces.
    static let accentHover = workspaceAdaptive(.hover, dark: darkAccentHover, light: lightAccentHover) // #e0f76f / #bfe000
    static let accentDown = workspaceAdaptive(.down, dark: darkAccentDown, light: lightAccentDown) // #aacc00 / #91ad00
    static let accentPressed = accentDown
    static let accentInk = workspaceAdaptive(.ink, dark: darkAccentInk, light: lightAccentInk)
    /// The brand when it has to *be* the mark rather than sit under one — a
    /// word, a glyph, a hairline, a today ring. The same colour as `accent`
    /// now that the accent itself steps down in light; kept so a call site
    /// can still say which job it is doing. (#aacc00 as ink on white is
    /// 1.85:1 — a compromise; the first lime to clear 3:1 is #87992E, an
    /// olive rather than the brand. One more reason to spend the accent on a
    /// fill.) See docs/DESIGN.md.
    static let accentMark = workspaceAdaptive(.mark, dark: darkAccent, light: lightAccent)

    /// The accent as a *filled call to action*: `accent` and its ramp, named
    /// for the job.
    static let accentCTA = accent
    static let accentCTAHover = accentHover
    static let accentCTADown = accentDown
    /// Soft blue-gray fill for Saturday/Sunday columns when Weekends is on.
    static let weekendColumn = adaptive(dark: darkWeekendColumn, light: lightWeekendColumn)
    /// One danger red across appearances and clients. Soft states use alpha or
    /// compositing at the call site; the semantic colour itself never swaps.
    static let danger = NSColor(
        srgbRed: StarlingsSemanticColors.dangerRed,
        green: StarlingsSemanticColors.dangerGreen,
        blue: StarlingsSemanticColors.dangerBlue,
        alpha: 1
    )
    /// Presence dot for "busy" — their day is spoken for, but nothing is live
    /// in a room. A fixed step of the accent ramp, not adaptive, matching how
    /// `CalendarLayerPalette`'s shades are also non-adaptive lime tones.
    /// Mirrors web's `--presence-busy` and iOS's `StarlingsMobileColors.presenceBusy`.
    static let presenceBusy = NSColor(srgbRed: 0.612, green: 0.749, blue: 0.180, alpha: 1) // #9cbf2e
    /// Presence dot for "in a meeting" — a step further down the same ramp.
    /// Mirrors web's `--presence-in-meeting` and iOS's
    /// `StarlingsMobileColors.presenceInMeeting`.
    static let presenceInMeeting = NSColor(srgbRed: 0.400, green: 0.486, blue: 0.290, alpha: 1) // #667c4a
    /// Settings navigation is persistent chrome, so its category icons stay
    /// monochrome. The adaptive pair keeps the neutral tile and light glyph
    /// readable in both appearances without spending an accent on selection.

    /// Resolve a semantic colour against the surface that is actually drawing
    /// it. AppKit's dynamic NSColors consult `NSAppearance.currentAppearance`
    /// when converting to sRGB, so make the view's effective appearance current
    /// for that conversion rather than allowing a hover callback to retain the
    /// process's previous (usually dark) variant.
    static func resolved(_ color: NSColor, for appearance: NSAppearance) -> NSColor {
        var resolved = color
        appearance.performAsCurrentDrawingAppearance {
            resolved = color.usingColorSpace(.sRGB) ?? color
        }
        return resolved
    }

    static func resolved(_ color: NSColor, for view: NSView) -> NSColor {
        resolved(color, for: view.effectiveAppearance)
    }

    /// A well on glass. The opaque `field` rung punches a hole in a glass
    /// panel; Apple's wells there are a translucent tone one step up from the
    /// glass. Light ink at low alpha in dark, dark ink in light, so the glass
    /// still reads through the well.
    static let fieldOnGlass = NSColor(name: nil) { appearance in
        let dark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        return dark ? NSColor.white.withAlphaComponent(0.14) : NSColor.black.withAlphaComponent(0.07)
    }

    /// The well fill for `view`, resolved: `fieldOnGlass` when an ancestor is
    /// Liquid Glass (`StarlingsFloatingGlass`), `base` everywhere else — `field`
    /// for a well, `elevated` for a segmented track. Wells ask this on
    /// `viewDidMoveToWindow` as well as at init, because the glass is above
    /// them in a hierarchy they join later.
    static func fieldGround(for view: NSView, base: NSColor = field) -> CGColor {
        resolved(isOnGlass(view) ? fieldOnGlass : base, for: view).cgColor
    }

    /// A well's hairline on glass. The rung's resting hairline is white at
    /// 10% in dark, and the well on glass is white at 14%: dimmer than the
    /// fill it edges, so it vanished until hover took it to 20%. On glass
    /// the line has to clear the fill at rest, and hover steps up from there.
    static let hairlineOnGlass = NSColor(name: nil) { appearance in
        let dark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        return dark ? NSColor.white.withAlphaComponent(0.28) : NSColor.black.withAlphaComponent(0.22)
    }
    static let hairlineHoverOnGlass = NSColor(name: nil) { appearance in
        let dark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        return dark ? NSColor.white.withAlphaComponent(0.40) : NSColor.black.withAlphaComponent(0.32)
    }

    /// The well hairline for `view`, resolved: `border` or `borderHover` on
    /// a rung, the glass pair when an ancestor is Liquid Glass. Same rule as
    /// `fieldGround`; focus is the caller's, it outranks both.
    static func hairline(for view: NSView, hovered: Bool) -> CGColor {
        let color: NSColor
        if isOnGlass(view) {
            color = hovered ? hairlineHoverOnGlass : hairlineOnGlass
        } else {
            color = hovered ? borderHover : border
        }
        return resolved(color, for: view).cgColor
    }

    private static func isOnGlass(_ view: NSView) -> Bool {
        guard #available(macOS 26.0, *) else { return false }
        var ancestor = view.superview
        while let current = ancestor {
            if current is NSGlassEffectView { return true }
            ancestor = current.superview
        }
        return false
    }

    /// CALayer stores CGColors, so it cannot retain AppKit's dynamic colour
    /// provider. Resolve semantic colours against the window's effective
    /// appearance whenever a custom surface enters a window or the preference
    /// changes while that window is open.
    @MainActor
    static func refreshLayers(in view: NSView, toDark: Bool) {
        // Colour matching cannot tell one lime from another, and since a filled
        // CTA takes a different ramp per canvas, a control that knows how to
        // recolour itself is asked rather than guessed at.
        view.meetAppearanceRestyle?(view)
        refresh(layer: view.layer, toDark: toDark)
        for child in view.subviews {
            refreshLayers(in: child, toDark: toDark)
        }
    }

    private struct PalettePair {
        let dark: NSColor
        let light: NSColor
    }

    /// The fixed rungs, then the workspace's accent shades, so a layer drawn
    /// in the workspace's accent flips with the appearance too.
    private static var palettePairs: [PalettePair] {
        fixedPalettePairs + [WorkspaceAccent.Shade.fill, .hover, .down].compactMap { shade in
            guard let dark = WorkspaceAccent.rgb(shade, dark: true),
                  let light = WorkspaceAccent.rgb(shade, dark: false) else { return nil }
            return PalettePair(
                dark: NSColor(srgbRed: dark.red, green: dark.green, blue: dark.blue, alpha: 1),
                light: NSColor(srgbRed: light.red, green: light.green, blue: light.blue, alpha: 1)
            )
        }
    }

    private static let fixedPalettePairs: [PalettePair] = [
        .init(dark: darkCanvas, light: lightCanvas),
        .init(dark: darkPanel, light: lightPanel),
        .init(dark: darkElevated, light: lightElevated),
        .init(dark: darkBorder, light: lightBorder),
        .init(dark: darkBorderHover, light: lightBorderHover),
        .init(dark: darkControlBorder, light: lightControlBorder),
        .init(dark: darkField, light: lightField),
        .init(dark: darkPrimaryText, light: lightPrimaryText),
        .init(dark: darkSecondaryText, light: lightSecondaryText),
        .init(dark: darkAccent, light: lightAccent),
        .init(dark: darkAccentHover, light: lightAccentHover),
        .init(dark: darkAccentDown, light: lightAccentDown),
        .init(dark: darkWeekendColumn, light: lightWeekendColumn),
        // `danger`, `presenceBusy`, and `presenceInMeeting` are fixed semantic
        // values, so there is nothing for this table to swap.
    ]

    private static func refresh(layer: CALayer?, toDark: Bool) {
        guard let layer else { return }
        func replacement(_ color: CGColor?) -> CGColor? {
            guard let color,
                  let resolved = NSColor(cgColor: color)?.usingColorSpace(.sRGB) else {
                return color
            }

            guard let pair = palettePairs.first(where: { pair in
                guard let dark = pair.dark.usingColorSpace(.sRGB),
                      let light = pair.light.usingColorSpace(.sRGB) else { return false }
                return abs(resolved.redComponent - dark.redComponent) < 0.002
                    && abs(resolved.greenComponent - dark.greenComponent) < 0.002
                    && abs(resolved.blueComponent - dark.blueComponent) < 0.002
                    || abs(resolved.redComponent - light.redComponent) < 0.002
                    && abs(resolved.greenComponent - light.greenComponent) < 0.002
                    && abs(resolved.blueComponent - light.blueComponent) < 0.002
            }),
            let target = (toDark ? pair.dark : pair.light).usingColorSpace(.sRGB) else {
                return color
            }

            // Preserve alpha for derived fills such as `accent.withAlphaComponent`.
            return NSColor(
                srgbRed: target.redComponent,
                green: target.greenComponent,
                blue: target.blueComponent,
                alpha: resolved.alphaComponent
            ).cgColor
        }
        layer.backgroundColor = replacement(layer.backgroundColor)
        layer.borderColor = replacement(layer.borderColor)
        layer.shadowColor = replacement(layer.shadowColor)
        if let shape = layer as? CAShapeLayer {
            shape.fillColor = replacement(shape.fillColor)
            shape.strokeColor = replacement(shape.strokeColor)
        }
        for child in layer.sublayers ?? [] {
            refresh(layer: child, toDark: toDark)
        }
    }

    /// One rung up the surface ladder — the whole hover vocabulary, in one number.
    /// Mirrors `--hover-lift` on web so the two surfaces move by the same amount.
    static let hoverLift: CGFloat = 0.06
    /// A list row is a wide, chromeless strip; the full veil on that much area
    /// reads as a selection, not a lift. Rows take half.
    static let rowHoverLift: CGFloat = 0.03

    /// Composites a veil over `base` rather than looking up a per-surface hover
    /// colour, so the same call lifts correctly on canvas, panel, and elevated.
    /// A fully transparent base has nothing to lift, so it gets the veil instead —
    /// which is exactly what a chromeless row or icon button wants.
    ///
    /// The veil is white in dark and black in light: a white veil over a white
    /// panel moves nothing, so in light the rung goes down rather than up.
    static func lifted(_ base: NSColor, by amount: CGFloat = hoverLift) -> NSColor {
        let appearance = NSApplication.shared.effectiveAppearance
        let veil: CGFloat = isDark(appearance) ? 1 : 0
        let resolvedBase = resolved(base, for: appearance)
        guard let srgb = resolvedBase.usingColorSpace(.sRGB) else { return resolvedBase }
        guard srgb.alphaComponent > 0 else {
            return (veil == 1 ? NSColor.white : NSColor.black).withAlphaComponent(amount)
        }
        return NSColor(
            srgbRed: srgb.redComponent + (veil - srgb.redComponent) * amount,
            green: srgb.greenComponent + (veil - srgb.greenComponent) * amount,
            blue: srgb.blueComponent + (veil - srgb.blueComponent) * amount,
            alpha: srgb.alphaComponent
        )
    }
}

// MARK: - Hover

/// Pointer tracking for any view, without that view having to subclass `NSView`
/// or hand-roll `updateTrackingAreas`. `.inVisibleRect` lets AppKit keep the area
/// in step with layout, so this installs once and then looks after itself.
///
/// `NSTrackingArea` does not retain its owner, so the monitor is parked on the
/// view as an associated object by `trackMeetHover`.
@MainActor
final class StarlingsHoverMonitor: NSResponder {
    private weak var trackedView: NSView?
    private let onChange: (Bool) -> Void
    /// Mutable so a view whose clickability changes — the self-inset, which is
    /// only draggable while it is the inset — can drop the hand again. The
    /// `.cursorUpdate` option is installed from the cursor passed at init, so a
    /// view that will ever want one has to start with one.
    var cursor: NSCursor?
    private var area: NSTrackingArea?
    private(set) var isHovered = false
    private var appearanceObservation: NSKeyValueObservation?

    /// A disabled control that still lights up reads as clickable, so callers
    /// mirror their enabled state here and the monitor stops responding.
    var isEnabled = true {
        didSet {
            guard !isEnabled, isHovered else { return }
            isHovered = false
            onChange(false)
        }
    }

    init(view: NSView, cursor: NSCursor?, onChange: @escaping (Bool) -> Void) {
        self.trackedView = view
        self.cursor = cursor
        self.onChange = onChange
        super.init()
        install(on: view)
        observeLostExits()
        observeAppearance(of: view)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    /// The colours `onChange` paints are resolved against the view's
    /// appearance at the moment it runs. `applyMeetHoverLift` runs it once
    /// when applied, usually before the view has a window; a window whose
    /// appearance differs then showed a hairline in the wrong colour until
    /// the first hover repainted it. `effectiveAppearance` changes exactly
    /// then — on joining such a window, and on a light/dark switch — so the
    /// resting state is replayed against the appearance that now holds.
    private func observeAppearance(of view: NSView) {
        appearanceObservation = view.observe(\.effectiveAppearance) { [weak self] _, _ in
            guard let self else { return }
            MainActor.assumeIsolated { self.onChange(self.isHovered) }
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func install(on view: NSView) {
        var options: NSTrackingArea.Options = [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect]
        if cursor != nil { options.insert(.cursorUpdate) }
        let area = NSTrackingArea(rect: .zero, options: options, owner: self, userInfo: nil)
        view.addTrackingArea(area)
        self.area = area
    }

    /// The moments AppKit swallows a `mouseExited`: the app deactivates with
    /// the pointer still over the view, or a menu takes over event tracking
    /// while the pointer leaves. Each one left a lit row behind. After any of
    /// them the monitor re-reads where the pointer really is.
    private func observeLostExits() {
        let center = NotificationCenter.default
        let names: [Notification.Name] = [
            NSApplication.didResignActiveNotification,
            NSApplication.didBecomeActiveNotification,
            NSMenu.didEndTrackingNotification,
        ]
        for name in names {
            center.addObserver(self, selector: #selector(lostExitPosted), name: name, object: nil)
        }
    }

    @objc private func lostExitPosted(_ note: Notification) {
        resync()
    }

    /// Re-reads the pointer against the view and corrects `isHovered` to
    /// match. Tracking areas only report *changes*, so a view that is removed
    /// from the window while hovered, scrolled out from under a still pointer,
    /// or re-added under one never hears about it. Views call this from
    /// `updateTrackingAreas`, which AppKit runs on every such move.
    func resync() {
        let inside: Bool
        if isEnabled,
           let view = trackedView,
           let window = view.window,
           window.isVisible,
           NSApp.isActive,
           !view.isHiddenOrHasHiddenAncestor {
            let point = view.convert(window.mouseLocationOutsideOfEventStream, from: nil)
            inside = view.visibleRect.contains(point)
        } else {
            inside = false
        }
        guard inside != isHovered else { return }
        isHovered = inside
        onChange(inside)
    }

    /// Called when a second `trackMeetHover` replaces this monitor — without it
    /// the orphaned area keeps firing into a handler nobody owns any more.
    func invalidate() {
        if let area, let trackedView {
            trackedView.removeTrackingArea(area)
        }
        area = nil
        if isHovered {
            isHovered = false
            onChange(false)
        }
    }

    override func mouseEntered(with event: NSEvent) {
        guard isEnabled, !isHovered else { return }
        isHovered = true
        onChange(true)
    }

    override func mouseExited(with event: NSEvent) {
        guard isHovered else { return }
        isHovered = false
        onChange(false)
    }

    override func cursorUpdate(with event: NSEvent) {
        guard isEnabled, let cursor else {
            super.cursorUpdate(with: event)
            return
        }
        cursor.set()
    }
}

/// A one-byte allocation used purely for its address. Taking `&` of a global `var`
/// hands `objc_setAssociatedObject` a pointer it outlives, which Swift rightly
/// complains about; a real allocation is the address-stable version of that trick.
/// `nonisolated(unsafe)` because the pointer is only ever read: it is allocated
/// once, never written through, and never freed.
private nonisolated(unsafe) let meetHoverMonitorKey = UnsafeRawPointer(
    UnsafeMutableRawPointer.allocate(byteCount: 1, alignment: 1)
)

/// Address-stable key for the restyle closure, same trick as the hover monitor.
private nonisolated(unsafe) let meetAppearanceRestyleKey = UnsafeRawPointer(
    UnsafeMutableRawPointer.allocate(byteCount: 1, alignment: 1)
)

/// Address-stable key for the width a padded button asks for, same trick again.
private nonisolated(unsafe) let meetShoulderConstraintKey = UnsafeRawPointer(
    UnsafeMutableRawPointer.allocate(byteCount: 1, alignment: 1)
)

/// Boxed so an associated object can hold a closure.
private final class StarlingsAppearanceRestyle {
    let run: (NSView) -> Void
    init(_ run: @escaping (NSView) -> Void) { self.run = run }
}

extension NSView {
    /// What to re-run when the window flips light/dark.
    ///
    /// A CALayer holds a resolved CGColor, and `refreshLayers` recolours it by
    /// matching values — which works only while a colour means one thing. The
    /// filled CTA broke that: its lime and the accent's lime are the same value
    /// in dark and different ones in light. A control that registers here is
    /// asked to restyle itself instead of being pattern-matched.
    func onMeetAppearanceChange(_ restyle: @escaping (NSView) -> Void) {
        objc_setAssociatedObject(
            self,
            meetAppearanceRestyleKey,
            StarlingsAppearanceRestyle(restyle),
            .OBJC_ASSOCIATION_RETAIN_NONATOMIC
        )
    }

    var meetAppearanceRestyle: ((NSView) -> Void)? {
        (objc_getAssociatedObject(self, meetAppearanceRestyleKey) as? StarlingsAppearanceRestyle)?.run
    }

    /// The monitor installed by `trackMeetHover`, if any. Callers keep a handle so
    /// they can gate it on `isEnabled` as their own state changes.
    var meetHoverMonitor: StarlingsHoverMonitor? {
        objc_getAssociatedObject(self, meetHoverMonitorKey) as? StarlingsHoverMonitor
    }

    /// Raw hover tracking. Prefer `applyMeetHoverLift` — this is for the handful of
    /// controls whose hover is something other than a fill change.
    @discardableResult
    func trackMeetHover(cursor: NSCursor? = nil, onChange: @escaping (Bool) -> Void) -> StarlingsHoverMonitor {
        meetHoverMonitor?.invalidate()
        let monitor = StarlingsHoverMonitor(view: self, cursor: cursor, onChange: onChange)
        objc_setAssociatedObject(self, meetHoverMonitorKey, monitor, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        return monitor
    }

    /// The house hover: whatever is under the pointer steps one rung up the surface
    /// ladder. `base` is the resting fill — pass `.clear` for chromeless controls
    /// (quiet icon buttons, list rows), which pick up a translucent well instead.
    ///
    /// Everything clickable on the Mac gets this. AppKit hands out no hover feedback
    /// of its own, so a control without it is genuinely inert under the pointer.
    @discardableResult
    func applyMeetHoverLift(
        base: NSColor = .clear,
        border: NSColor? = nil,
        cornerRadius: CGFloat? = nil,
        amount: CGFloat = StarlingsColors.hoverLift,
        cursor: NSCursor? = nil
    ) -> StarlingsHoverMonitor {
        wantsLayer = true
        if let cornerRadius {
            layer?.cornerRadius = cornerRadius
            layer?.cornerCurve = .continuous
        }
        layer?.backgroundColor = StarlingsColors.resolved(base, for: self).cgColor
        if let border {
            layer?.borderColor = StarlingsColors.resolved(border, for: self).cgColor
        }
        return trackMeetHover(cursor: cursor) { [weak self] hovered in
            guard let self, let layer = self.layer else { return }
            let resolvedBase = StarlingsColors.resolved(base, for: self)
            layer.backgroundColor = (hovered ? StarlingsColors.lifted(resolvedBase, by: amount) : resolvedBase).cgColor
            if let border {
                let resolvedBorder = StarlingsColors.resolved(border, for: self)
                let resolvedHoverBorder = StarlingsColors.resolved(StarlingsColors.borderHover, for: self)
                layer.borderColor = (hovered ? resolvedHoverBorder : resolvedBorder).cgColor
            }
        }
    }
}

enum StarlingsBrand {
    /// Envisioning Octa, for Home's clock only. Every other line, the date
    /// under the clock included, is the system face; the product wordmark is `StarlingsWordmark`. The face
    /// ships in EnvisioningUI and registers itself, so nothing here has to be
    /// bundled or listed in a plist.
    static func homeClockFont(ofSize size: CGFloat, weight: NSFont.Weight = .semibold) -> NSFont {
        EnvisioningFont.register()
        let face: EnvisioningFont.Weight
        switch weight {
        case .bold, .heavy, .black: face = .bold
        case .semibold: face = .semiBold
        case .medium: face = .medium
        default: face = .regular
        }
        return NSFont(name: face.postScriptName, size: size)
            ?? .systemFont(ofSize: size, weight: weight)
    }

    /// The Starlings glyph (`StarlingsGlyph`, still), in a 28×28 design
    /// space. Geometry comes from the dots registry, so the Mac is not another
    /// place the mark is written down. Nothing here knows which way up it is
    /// drawn. No workspace's mark is drawn from code: a workspace's mark is its
    /// upload (`StarlingsWorkspaceMarkView`).
    private static func glyphPaths() -> [NSBezierPath] {
        let box = CGRect(x: 0, y: 0, width: 28, height: 28)
        return [NSBezierPath(cgPath: StarlingsGlyph().path(in: box).cgPath)]
    }

    /// Stamp the mark straight into the current context, right way up whichever
    /// way the destination runs. An `NSImage` drawn into a flipped view comes
    /// out mirrored — every calendar grid is flipped, which is how the badge on
    /// an event card ended up upside down — and no amount of care in how the
    /// image is *authored* fixes it, because the mirroring happens at the draw.
    /// So a view that draws its own content draws the geometry, not a picture.
    static func drawGlyph(in rect: NSRect, color: NSColor = StarlingsColors.accentMark, fraction: CGFloat = 1) {
        guard rect.width > 0, rect.height > 0 else { return }
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }

        // The design space is y-down. A flipped context already runs that way;
        // an unflipped one is met at the top of the rect and walked back down.
        let flipped = NSGraphicsContext.current?.isFlipped ?? false
        let transform = NSAffineTransform()
        transform.translateX(by: rect.minX, yBy: flipped ? rect.minY : rect.maxY)
        transform.scaleX(by: rect.width / 28, yBy: (flipped ? 1 : -1) * rect.height / 28)
        transform.concat()

        (fraction < 1 ? color.withAlphaComponent(fraction) : color).setFill()
        for path in glyphPaths() { path.fill() }
    }

    /// The Starlings glyph as a picture. For the places that need a picture: an image view, a status item, a text
    /// attachment. A view drawing its own content wants `drawGlyph` instead.
    static func glyphImage(size: CGFloat = 18, color: NSColor = StarlingsColors.accentMark) -> NSImage {
        let image = NSImage(size: NSSize(width: size, height: size), flipped: true) { bounds in
            color.setFill()
            let scale = AffineTransform(scaleByX: bounds.width / 28, byY: bounds.height / 28)
            for path in glyphPaths() {
                path.transform(using: scale)
                path.fill()
            }
            return true
        }
        image.isTemplate = false
        return image
    }

    /// The menu bar glyph. Black or white with the bar, never accented: a
    /// template image the system tints. A `badge` colour adds a small dot at
    /// the bottom-right for a state the bar must show (recording, alarm);
    /// the glyph then draws in `labelColor` at draw time so it still follows
    /// the bar's appearance while the dot keeps its colour. The glyph is the
    /// Starlings flock (`StarlingsGlyph`): even dots when still, the thinking
    /// wave at `thinkingAt` while an agent works. `inactive` (signed out or
    /// offline) draws the dots in `tertiaryLabelColor`, the system's inactive
    /// grey, resolved against the bar at draw time: a template image with
    /// `appearsDisabled` stayed full white in the menu bar.
    static func statusBarGlyphImage(size: CGFloat = 18, badge: NSColor? = nil, thinkingAt: TimeInterval? = nil, inactive: Bool = false) -> NSImage {
        let template = badge == nil && !inactive
        let image = NSImage(size: NSSize(width: size, height: size), flipped: true) { bounds in
            (template ? NSColor.black : inactive && badge == nil ? NSColor.tertiaryLabelColor : NSColor.labelColor).setFill()
            NSBezierPath(cgPath: StarlingsGlyph(flock: thinkingAt.map { .thinking(at: $0) } ?? .even).path(in: bounds).cgPath).fill()
            guard let badge else { return true }
            let diameter = (bounds.width * 0.4).rounded()
            let dot = NSRect(x: bounds.maxX - diameter, y: bounds.maxY - diameter, width: diameter, height: diameter)
            badge.setFill()
            NSBezierPath(ovalIn: dot).fill()
            return true
        }
        image.isTemplate = template
        return image
    }
}

/// The two label roles that sit above content. Keep them here so screens can't
/// re-invent a caption with a slightly different size or weight.
@MainActor
enum StarlingsTypography {
    /// The Text size preference as a factor. Read once at launch from
    /// `StarlingsTextSize`, written by Settings; a static rather than a defaults
    /// read so a row with six labels does not ask UserDefaults six times.
    nonisolated(unsafe) static var scale: CGFloat = StarlingsTextSize.current().scale

    /// A point size under the Text size preference. Whole points: a 12 at
    /// Large is 14, not 13.8, so baselines still line up across a row.
    nonisolated static func scaled(_ size: CGFloat) -> CGFloat {
        (size * scale).rounded()
    }

    /// Uppercase rail header — IDENTITY, PARTICIPANTS, UPCOMING, WAITING ROOM.
    static var sectionLabelFont: NSFont { .monospacedSystemFont(ofSize: scaled(10), weight: .semibold) }
    /// Sentence-case caption directly above a form control — When, Guests, Agenda.
    static var fieldCaptionFont: NSFont { .systemFont(ofSize: scaled(11), weight: .semibold) }

    /// Display-only text is not a document. Keep labels and wrapped status
    /// copy out of the text-selection system; editable fields opt in through
    /// `StarlingsTextField` instead.
    static func applyStaticLabel(_ label: NSTextField) {
        label.isEditable = false
        label.isSelectable = false
    }

    static func wrappingLabel(_ text: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        applyStaticLabel(label)
        return label
    }

    static func applySectionLabel(_ label: NSTextField) {
        applyStaticLabel(label)
        label.font = sectionLabelFont
        label.textColor = StarlingsColors.secondaryText
    }

    static func applyFieldCaption(_ label: NSTextField) {
        applyStaticLabel(label)
        label.font = fieldCaptionFont
        label.textColor = StarlingsColors.secondaryText
    }

    static func sectionLabel(_ title: String) -> NSTextField {
        let label = NSTextField(labelWithString: title)
        applySectionLabel(label)
        return label
    }

    static func fieldCaption(_ title: String) -> NSTextField {
        let label = NSTextField(labelWithString: title)
        applyFieldCaption(label)
        return label
    }
}

/// The filled call to action in the SwiftUI views the Mac hosts:
/// the geometry of EnvisioningUI's `EnvisioningFilledButtonStyle`, drawn in
/// the workspace's accent (`StarlingsColors.accent` and its shades) instead
/// of the package's fixed lime. EnvisioningUI takes no brand profile yet; this
/// adapter stands in for one, so Core's pinned Envisioning values stay as
/// they are. The phone's spelling is `StarlingsFilledButtonStyle`.
struct StarlingsCTAButtonStyle: ButtonStyle {
    private let minHeight: CGFloat
    private let expands: Bool

    init(minHeight: CGFloat = 48, expands: Bool = true) {
        self.minHeight = minHeight
        self.expands = expands
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(Color(nsColor: StarlingsColors.accentInk))
            .padding(.horizontal, expands ? 0 : 20)
            .frame(maxWidth: expands ? .infinity : nil, minHeight: minHeight)
            // hover: StarlingsCTAFill swaps to accentHover.
            .modifier(StarlingsCTAFill(pressed: configuration.isPressed))
    }
}

/// Swaps the fill rather than veiling it. Press outranks hover.
private struct StarlingsCTAFill: ViewModifier {
    let pressed: Bool
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovered = false

    func body(content: Content) -> some View {
        content
            .background(
                Color(nsColor: fill),
                in: RoundedRectangle(cornerRadius: EnvisioningRadius.control, style: .continuous)
            )
            .onHover { hovered = $0 }
    }

    private var fill: NSColor {
        if pressed { return StarlingsColors.accentDown }
        return hovered && isEnabled ? StarlingsColors.accentHover : StarlingsColors.accent
    }
}

enum StarlingsFilledButtonStyle {
    case accent
    case danger
    /// The same frame without the accent: a card's primary action on a
    /// screen where something else holds the one accent (docs/DESIGN.md,
    /// "One accent per screen state"). Surface ladder plus hairline, like
    /// the phone's `StarlingsBorderedButtonStyle`.
    case neutral
}

private let meetFilledButtonHorizontalPadding: CGFloat = 14
private let meetFilledButtonWidthConstraintIdentifier = "meet.filled-button.horizontal-padding"

extension NSButton {
    /// Borderless Meet CTAs do not get a bezel to supply their horizontal
    /// breathing room. Keep the intrinsic width, plus the same 14pt each side
    /// used by the web CTA, as their preferred minimum.
    fileprivate func applyMeetFilledHorizontalPadding() {
        let contentWidth = intrinsicContentSize.width
        guard contentWidth.isFinite, contentWidth > 0 else { return }

        let paddedWidth = contentWidth + meetFilledButtonHorizontalPadding * 2
        if let paddingConstraint = constraints.first(where: {
            $0.identifier == meetFilledButtonWidthConstraintIdentifier
        }) {
            paddingConstraint.constant = paddedWidth
        } else {
            let paddingConstraint = widthAnchor.constraint(greaterThanOrEqualToConstant: paddedWidth)
            paddingConstraint.identifier = meetFilledButtonWidthConstraintIdentifier
            paddingConstraint.priority = .defaultHigh
            paddingConstraint.isActive = true
        }
    }
}

/// Filled CTA that keeps ink color stable while pressed (AppKit's default highlight
/// flips accent titles to white). Height matches the launch / onboarding CTAs.
final class StarlingsFilledButton: NSButton {
    private var meetStyle: StarlingsFilledButtonStyle = .accent
    private var meetTitle = ""
    private var meetFont = NSFont.systemFont(ofSize: StarlingsTypography.scaled(14), weight: .semibold)
    private var meetCornerRadius: CGFloat = 8
    private var meetSymbolName: String?
    private var meetLeadingImage: NSImage?
    private var heightConstraint: NSLayoutConstraint?
    private var isHovered = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        configureCell()
        installHover()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configureCell()
        installHover()
    }

    convenience init(style: StarlingsFilledButtonStyle, title: String) {
        self.init(frame: .zero)
        apply(style, title: title)
    }

    override var isHighlighted: Bool {
        didSet { refreshChrome() }
    }

    /// Hover and press are the only things that refresh the fill otherwise, and
    /// the accent ramp is no longer the same on both canvases — so a theme flip
    /// has to re-ask rather than leave a light fill on a dark window.
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        refreshChrome()
    }

    override var isEnabled: Bool {
        didSet {
            meetHoverMonitor?.isEnabled = isEnabled
            refreshChrome()
        }
    }

    private func installHover() {
        trackMeetHover { [weak self] hovered in
            guard let self else { return }
            isHovered = hovered
            refreshChrome()
        }
    }

    func apply(
        _ style: StarlingsFilledButtonStyle,
        title: String? = nil,
        font: NSFont = .systemFont(ofSize: StarlingsTypography.scaled(14), weight: .semibold),
        cornerRadius: CGFloat? = nil,
        height: CGFloat = 44,
        symbolName: String? = nil,
        leadingImage: NSImage? = nil
    ) {
        let cornerRadius = cornerRadius ?? StarlingsRadius.control(height: height)
        meetStyle = style
        meetTitle = title ?? self.title
        meetFont = font
        meetCornerRadius = cornerRadius
        meetLeadingImage = leadingImage
        meetSymbolName = leadingImage == nil ? symbolName : nil
        configureCell()
        self.font = font
        isBordered = false
        wantsLayer = true
        layer?.cornerRadius = cornerRadius
        layer?.cornerCurve = .continuous
        layer?.masksToBounds = true
        if let heightConstraint {
            heightConstraint.constant = height
        } else {
            let constraint = heightAnchor.constraint(equalToConstant: height)
            constraint.isActive = true
            heightConstraint = constraint
        }
        refreshChrome()
        applyMeetShoulder()
        applyMeetFilledHorizontalPadding()
    }

    private func configureCell() {
        if let cell = cell as? NSButtonCell {
            // Prevents the system highlight from whitening the attributed title.
            cell.highlightsBy = []
            cell.showsStateBy = []
        }
    }

    private func refreshChrome() {
        let rawTextColor: NSColor
        let rawBackground: NSColor
        // Press wins over hover: the pointer is by definition still inside the
        // button while it is being clicked, so the darker pressed fill has to be
        // checked first or it would never show.
        let lit = isHovered && isEnabled
        switch meetStyle {
        case .accent:
            rawTextColor = StarlingsColors.accentInk
            if isHighlighted {
                rawBackground = StarlingsColors.accentCTADown
            } else {
                rawBackground = lit ? StarlingsColors.accentCTAHover : StarlingsColors.accentCTA
            }
        case .danger:
            rawTextColor = .white
            let fill = lit ? StarlingsColors.lifted(StarlingsColors.danger) : StarlingsColors.danger
            rawBackground = fill.withAlphaComponent(isHighlighted ? 0.85 : 1)
        case .neutral:
            rawTextColor = StarlingsColors.primaryText
            let fill = lit ? StarlingsColors.lifted(StarlingsColors.elevated) : StarlingsColors.elevated
            rawBackground = fill.withAlphaComponent(isHighlighted ? 0.7 : 1)
        }
        let textColor = StarlingsColors.resolved(rawTextColor, for: self)
        let background = StarlingsColors.resolved(rawBackground, for: self)
        layer?.backgroundColor = background.withAlphaComponent(isEnabled ? 1 : 0.45).cgColor
        layer?.borderWidth = meetStyle == .neutral ? 1 : 0
        layer?.borderColor = StarlingsColors.resolved(StarlingsColors.controlBorder, for: self).cgColor
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        // imageHugsTitle sits flush — en space matches ~web Button gap.
        let displayTitle = (meetSymbolName == nil && meetLeadingImage == nil)
            ? meetTitle
            : Self.leadingSymbolTitleGap + meetTitle
        attributedTitle = NSAttributedString(string: displayTitle, attributes: [
            .foregroundColor: textColor,
            .font: meetFont,
            .paragraphStyle: paragraph,
        ])
        if let meetLeadingImage {
            image = meetLeadingImage
            imagePosition = .imageLeading
            imageHugsTitle = true
        } else {
            Self.applyLeadingSymbol(
                to: self,
                symbolName: meetSymbolName,
                tint: textColor,
                accessibilityDescription: meetTitle
            )
        }
    }

    /// AppKit puts a leading SF Symbol flush against the title; pad to match web `gap: 8px`.
    fileprivate static let leadingSymbolTitleGap = "\u{2002}"

    fileprivate static func applyLeadingSymbol(
        to button: NSButton,
        symbolName: String?,
        tint: NSColor,
        accessibilityDescription: String
    ) {
        if let symbolName,
           let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: accessibilityDescription) {
            let config = NSImage.SymbolConfiguration(pointSize: 14, weight: .semibold)
            button.image = image.withSymbolConfiguration(config)
            button.imagePosition = .imageLeading
            button.imageHugsTitle = true
            button.contentTintColor = tint
        } else {
            button.image = nil
            button.imagePosition = .noImage
        }
    }
}

extension NSButton {
    /// One line, truncated, whatever the width.
    ///
    /// AppKit's default for a squeezed title is to *wrap* it, and a title in a
    /// row that has run out of room wraps to one letter per line — the
    /// transcript heading in a narrow meeting window came out reading
    /// vertically. Rows that shed their contents (`applyControlBarDensity`,
    /// `applyTranscriptHeaderDensity`) decide what is on screen; this is the
    /// floor under them, so the worst a row can do is an ellipsis.
    func applySingleLineTitle() {
        guard let cell else { return }
        cell.usesSingleLineMode = true
        cell.wraps = false
        cell.lineBreakMode = .byTruncatingTail
        cell.truncatesLastVisibleLine = true
    }

    /// A control that may be squeezed, down to a width it is still worth
    /// hitting.
    ///
    /// `applySingleLineTitle` stops a squeezed title wrapping; this is what
    /// lets the control *be* squeezed at all. At the default compression
    /// resistance a pop-up holds its whole title against the column it sits
    /// in, so one long device name or one long project name became the real
    /// minimum width of the rail around it — and a divider pinned against a
    /// minimum it cannot satisfy does not move. Work's section headers had the
    /// same fault; this is the shape of the fix, in one place.
    ///
    /// `floor` is where the squeeze stops, because a control shed to a sliver
    /// is a control nobody can hit.
    func allowSqueezing(toAtLeast floor: CGFloat) {
        applySingleLineTitle()
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(greaterThanOrEqualToConstant: floor).isActive = true
    }

    /// Borderless filled CTA. Prefer `StarlingsFilledButton` for accent CTAs so press
    /// keeps black ink; this helper still configures plain `NSButton`s used elsewhere.
    func applyMeetFilledStyle(
        _ style: StarlingsFilledButtonStyle,
        title: String? = nil,
        font: NSFont = .systemFont(ofSize: StarlingsTypography.scaled(14), weight: .semibold),
        cornerRadius: CGFloat? = nil,
        height: CGFloat = 44,
        symbolName: String? = nil
    ) {
        let cornerRadius = cornerRadius ?? StarlingsRadius.control(height: height)
        if let meet = self as? StarlingsFilledButton {
            meet.apply(
                style,
                title: title,
                font: font,
                cornerRadius: cornerRadius,
                height: height,
                symbolName: symbolName
            )
            return
        }

        let title = title ?? self.title
        let rawTextColor: NSColor
        let rawBackground: NSColor
        switch style {
        case .accent:
            rawTextColor = StarlingsColors.accentInk
            rawBackground = StarlingsColors.accentCTA
        case .danger:
            rawTextColor = .white
            rawBackground = StarlingsColors.danger
        case .neutral:
            rawTextColor = StarlingsColors.primaryText
            rawBackground = StarlingsColors.elevated
        }
        let textColor = StarlingsColors.resolved(rawTextColor, for: self)
        let background = StarlingsColors.resolved(rawBackground, for: self)

        isBordered = false
        wantsLayer = true
        layer?.backgroundColor = background.cgColor
        layer?.borderWidth = style == .neutral ? 1 : 0
        layer?.borderColor = StarlingsColors.resolved(StarlingsColors.controlBorder, for: self).cgColor
        onMeetAppearanceChange { view in
            view.layer?.backgroundColor = StarlingsColors.resolved(rawBackground, for: view).cgColor
        }
        // `isEnabled` is read at hover time rather than mirrored onto the monitor:
        // a plain NSButton gives no hook to notice it changing.
        trackMeetHover { [weak self] hovered in
            guard let self, let layer else { return }
            let lit = hovered && isEnabled
            let resolvedBackground = StarlingsColors.resolved(rawBackground, for: self)
            let hoverBackground: NSColor
            switch style {
            case .accent:
                hoverBackground = StarlingsColors.resolved(StarlingsColors.accentCTAHover, for: self)
            case .danger, .neutral:
                hoverBackground = StarlingsColors.lifted(resolvedBackground)
            }
            layer.backgroundColor = (lit ? hoverBackground : resolvedBackground).cgColor
        }
        layer?.cornerRadius = cornerRadius
        layer?.cornerCurve = .continuous
        layer?.masksToBounds = true
        self.font = font
        if let cell = cell as? NSButtonCell {
            cell.highlightsBy = []
            cell.showsStateBy = []
        }

        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let displayTitle = symbolName == nil ? title : StarlingsFilledButton.leadingSymbolTitleGap + title
        attributedTitle = NSAttributedString(string: displayTitle, attributes: [
            .foregroundColor: textColor,
            .font: font,
            .paragraphStyle: paragraph,
        ])
        StarlingsFilledButton.applyLeadingSymbol(
            to: self,
            symbolName: symbolName,
            tint: textColor,
            accessibilityDescription: title
        )

        let existing = constraints.first {
            $0.firstAttribute == .height && $0.firstItem as? NSButton == self && $0.relation == .equal
        }
        if let existing {
            existing.constant = height
        } else {
            heightAnchor.constraint(equalToConstant: height).isActive = true
        }
        applyMeetFilledHorizontalPadding()
    }

    /// The in-call control bar — Mute, Camera, Share, Chat, React. AppKit gives a
    /// `.rounded` push button no pointer feedback whatsoever, which left the busiest
    /// row in the app as the one place you could not tell what was clickable.
    ///
    /// `bezelColor` tints the system bezel rather than replacing it, so the lift
    /// lands on the same surface ladder as everything else while AppKit keeps the
    /// padding, the focus ring, and the title layout it already gets right. Titles
    /// here flip constantly (Mute ↔ Unmute, Share ↔ Stop sharing) and stay plain
    /// `title` strings so call sites never have to re-apply chrome.
    func applyMeetControlStyle(
        base: NSColor = StarlingsColors.elevated,
        titleColor: NSColor? = nil,
        height: CGFloat = 44
    ) {
        // Do not use AppKit's rounded bezel for meeting controls. Its bezel is
        // sized from the button cell's intrinsic content, not the button's
        // frame, so an image-above control paints a short pill while the
        // neighbouring chooser paints the full-height frame. The meeting
        // family owns its surface as a layer so every cell has one geometry.
        isBordered = false
        bezelStyle = .regularSquare
        imagePosition = image == nil ? .noImage : .imageLeading
        font = StarlingsMeetingControlButton.titleFont
        applySingleLineTitle()
        if let titleColor {
            setMeetControlTitle(title, color: titleColor)
        }
        wantsLayer = true
        layer?.cornerRadius = StarlingsRadius.control(height: height)
        layer?.cornerCurve = .continuous
        layer?.masksToBounds = true
        layer?.borderWidth = 1
        layer?.borderColor = StarlingsColors.resolved(StarlingsColors.controlBorder, for: self).cgColor
        applyMeetHoverLift(
            base: base,
            border: StarlingsColors.controlBorder,
            cornerRadius: StarlingsRadius.control(height: height),
            // The house lift (0.06) reads fine on a settings row you glance at
            // once; this row gets grabbed without looking, so hovering it needs
            // to be unmistakable rather than a shade darker.
            amount: StarlingsColors.hoverLift * 1.6
        )
    }

    func setMeetControlTitle(_ title: String, color: NSColor? = nil) {
        self.title = title
        guard let color else { return }
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        attributedTitle = NSAttributedString(string: title, attributes: [
            .foregroundColor: StarlingsColors.resolved(color, for: self),
            .font: font ?? NSFont.systemFont(ofSize: StarlingsTypography.scaled(13), weight: .medium),
            .paragraphStyle: paragraph,
        ])
        contentTintColor = StarlingsColors.resolved(color, for: self)
    }
}

extension NSView {
    func pinToEdges(of other: NSView, insets: NSEdgeInsets = .init()) {
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            leadingAnchor.constraint(equalTo: other.leadingAnchor, constant: insets.left),
            trailingAnchor.constraint(equalTo: other.trailingAnchor, constant: -insets.right),
            topAnchor.constraint(equalTo: other.topAnchor, constant: insets.top),
            bottomAnchor.constraint(equalTo: other.bottomAnchor, constant: -insets.bottom),
        ])
    }
}

extension NSScrollView {
    /// Rebuild the document without moving the reader. Tearing a stack's rows
    /// out and putting new ones back shrinks the document for one layout pass;
    /// the clip view clamps to the shorter document and stays there when the
    /// rows return, which is the "scrolled to the bottom, then hopped back up"
    /// the Team rail used to do on every poll. Runs `body`, lays out, then
    /// scrolls back to where the reader was, clamped to the new length.
    func preservingScrollOffset(_ body: () -> Void) {
        let origin = contentView.bounds.origin
        body()
        layoutSubtreeIfNeeded()
        guard let document = documentView else { return }
        let maxY = max(0, document.frame.height - contentView.bounds.height)
        let target = NSPoint(x: origin.x, y: min(max(0, origin.y), maxY))
        guard target != contentView.bounds.origin else { return }
        contentView.scroll(to: target)
        reflectScrolledClipView(contentView)
    }
}

/// Vertically pads single-line text inside taller `StarlingsTextField`s (AppKit’s default
/// drawing rect stays control-size-tight even when Auto Layout stretches the view).
private final class StarlingsTextFieldCell: NSTextFieldCell {
    /// Breathing room between text and the field shell / focus border.
    static let contentInsets = NSEdgeInsets(top: 10, left: 8, bottom: 10, right: 8)

    /// Static (persistent) presentation drops the padding so the text lines up
    /// with the section labels above it instead of sitting 8pt in.
    private var activeInsets: NSEdgeInsets {
        var insets = isEditable ? Self.contentInsets : NSEdgeInsets()
        if isEditable { insets.right += trailingAccessoryWidth }
        return insets
    }

    /// Room kept clear at the trailing edge for a control drawn inside the
    /// field (a round send button), so text never runs under it.
    var trailingAccessoryWidth: CGFloat = 0

    /// One line of the cell's own font — what the field editor lays out too, so
    /// the text does not shift when the field takes focus.
    private var lineHeight: CGFloat {
        let font = self.font ?? StarlingsTextField.fieldFont
        return ceil(font.ascender - font.descender + font.leading)
    }

    /// AppKit top-aligns the single line inside the drawing rect, so whatever
    /// height the insets leave over lifts the glyphs above the shell's centre.
    /// Handing back a rect exactly one line tall, centred in what's left, puts
    /// them on the middle line instead.
    private func textRect(forBounds rect: NSRect) -> NSRect {
        let inset = activeInsets
        var body = NSRect(
            x: rect.origin.x + inset.left,
            y: rect.origin.y + inset.bottom,
            width: max(0, rect.width - inset.left - inset.right),
            height: max(0, rect.height - inset.top - inset.bottom)
        )
        let line = lineHeight
        guard body.height > line else { return body }
        // Shifting the origin and clamping the height trims both edges evenly,
        // which centres the line whichever way the control view is flipped.
        body.origin.y += ((body.height - line) / 2).rounded(.down)
        body.size.height = line
        return body
    }

    override func drawingRect(forBounds rect: NSRect) -> NSRect {
        textRect(forBounds: rect)
    }

    override func setUpFieldEditorAttributes(_ textObj: NSText) -> NSText {
        let text = super.setUpFieldEditorAttributes(textObj)
        StarlingsTextField.styleFieldEditor(text, font: font)
        return text
    }

    override func drawInterior(withFrame cellFrame: NSRect, in controlView: NSView) {
        // Editable fields stay on brand white even if a caller reset `textColor`.
        if isEditable {
            textColor = StarlingsColors.primaryText
        }
        super.drawInterior(withFrame: cellFrame, in: controlView)
    }

    override func edit(
        withFrame rect: NSRect,
        in controlView: NSView,
        editor textObj: NSText,
        delegate: Any?,
        event: NSEvent?
    ) {
        StarlingsTextField.styleFieldEditor(textObj, font: font)
        super.edit(
            withFrame: textRect(forBounds: rect),
            in: controlView,
            editor: textObj,
            delegate: delegate,
            event: event
        )
    }

    override func select(
        withFrame rect: NSRect,
        in controlView: NSView,
        editor textObj: NSText,
        delegate: Any?,
        start selStart: Int,
        length selLength: Int
    ) {
        StarlingsTextField.styleFieldEditor(textObj, font: font)
        super.select(
            withFrame: textRect(forBounds: rect),
            in: controlView,
            editor: textObj,
            delegate: delegate,
            start: selStart,
            length: selLength
        )
    }
}

extension NSTextField {
    /// A label that truncates *and* agrees to be truncated.
    ///
    /// `lineBreakMode` says what a squeezed label draws; it does not make the
    /// label accept being squeezed. At the default resistance of 750 — well
    /// above a split view item's holding priority of 260 — one long project
    /// title or one long email address sets the minimum width of the column it
    /// is in, and a column that cannot be narrowed cannot be dragged. Every
    /// label in a rail row wants this.
    func allowSqueezing() {
        lineBreakMode = .byTruncatingTail
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }
}

/// The round accent button a message or note field carries inside its right
/// edge: send, or add. The field gives up the room under it, so the
/// button never wraps below the field or covers text.
@MainActor
enum StarlingsFieldButton {
    static let diameter: CGFloat = 28

    static func make(symbol: String, label: String) -> NSButton {
        let button = NSButton(title: "", target: nil, action: nil)
        button.isBordered = false
        button.imagePosition = .imageOnly
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)?
            .withSymbolConfiguration(.init(pointSize: 13, weight: .bold))
        button.contentTintColor = StarlingsColors.accentInk
        button.toolTip = label
        button.setAccessibilityLabel(label)
        button.wantsLayer = true
        button.layer?.cornerRadius = diameter / 2
        button.layer?.masksToBounds = true
        button.applyMeetHoverLift(base: StarlingsColors.accentCTA, amount: StarlingsColors.hoverLift)
        button.translatesAutoresizingMaskIntoConstraints = false
        return button
    }

    /// Seats `button` inside `field`'s trailing edge, vertically centred.
    static func seat(_ button: NSButton, in field: StarlingsTextField) {
        field.trailingAccessoryWidth = diameter + 4
        field.addSubview(button)
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(equalToConstant: diameter),
            button.heightAnchor.constraint(equalToConstant: diameter),
            button.trailingAnchor.constraint(equalTo: field.trailingAnchor, constant: -6),
            button.centerYAnchor.constraint(equalTo: field.centerYAnchor),
        ])
    }
}

/// Stock AppKit text field with a constant-width accent focus ring (color only changes).
final class StarlingsTextField: NSTextField {
    /// Width of a control the caller seats inside the field's trailing edge.
    var trailingAccessoryWidth: CGFloat {
        get { (cell as? StarlingsTextFieldCell)?.trailingAccessoryWidth ?? 0 }
        set { (cell as? StarlingsTextFieldCell)?.trailingAccessoryWidth = newValue; needsDisplay = true }
    }

    static let fieldHeight: CGFloat = 40
    static let fieldCornerRadius: CGFloat = StarlingsRadius.field
    static let borderWidth: CGFloat = 2
    /// Every typed input in the app renders at this size — do not override per screen.
    static let fieldFont = NSFont.systemFont(ofSize: StarlingsTypography.scaled(13))
    /// Static identity text once the field stops being editable.
    static let persistentFont = NSFont.systemFont(ofSize: StarlingsTypography.scaled(14), weight: .medium)
    static let persistentSecondaryFont = NSFont.systemFont(ofSize: StarlingsTypography.scaled(13))

    /// Rank of a field rendered as static text — the sole supported way to dim one.
    enum PersistentEmphasis {
        case primary
        case secondary
    }

    private var heightConstraint: NSLayoutConstraint?
    private var isRefreshingPlaceholder = false
    private var isFocused = false
    private var isHovered = false

    override var placeholderString: String? {
        didSet { refreshPlaceholder() }
    }

    override class var cellClass: AnyClass? {
        get { StarlingsTextFieldCell.self }
        set {}
    }

    /// Shared field-editor chrome: primary ink and a quiet neutral selection.
    static func styleFieldEditor(_ textObj: NSText, font: NSFont?) {
        let textColor = StarlingsColors.primaryText
        let resolvedFont = font ?? fieldFont
        textObj.textColor = textColor
        textObj.font = resolvedFont
        guard let editor = textObj as? NSTextView else { return }
        editor.drawsBackground = false
        editor.insertionPointColor = textColor
        editor.typingAttributes = [
            .font: resolvedFont,
            .foregroundColor: textColor,
        ]
        editor.selectedTextAttributes = StarlingsColors.textSelectionAttributes
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        installMeetCellIfNeeded()
        configureChrome()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        installMeetCellIfNeeded()
        configureChrome()
    }

    convenience init(placeholder: String) {
        self.init(frame: .zero)
        placeholderString = placeholder
    }

    override var intrinsicContentSize: NSSize {
        var size = super.intrinsicContentSize
        size.height = max(size.height, Self.fieldHeight)
        return size
    }

    override func layout() {
        super.layout()
        layer?.cornerRadius = bounds.height / 2
    }

    /// `applyPersistentAppearance(true)` turns the field into a label with no
    /// well; joining a window must not paint one back.
    private var isPersistent = false

    /// The fill and the hairline resolve against the window the field is in.
    /// Resolved at `init` alone they take the app's appearance, not the
    /// window's, and the resting hairline was invisible until the first
    /// hover re-resolved it — an outline that appeared only after the
    /// pointer had been there.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard !isPersistent else { return }
        layer?.backgroundColor = StarlingsColors.fieldGround(for: self)
        refreshBorder()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        guard !isPersistent else { return }
        layer?.backgroundColor = StarlingsColors.fieldGround(for: self)
        refreshBorder()
    }

    private func installMeetCellIfNeeded() {
        if !(cell is StarlingsTextFieldCell) {
            let replacement = StarlingsTextFieldCell(textCell: stringValue)
            replacement.placeholderString = placeholderString
            replacement.isEditable = isEditable
            replacement.isSelectable = isSelectable
            replacement.isBezeled = isBezeled
            replacement.bezelStyle = bezelStyle
            replacement.font = font
            replacement.textColor = StarlingsColors.primaryText
            replacement.backgroundColor = backgroundColor
            replacement.drawsBackground = drawsBackground
            replacement.controlSize = controlSize
            replacement.focusRingType = focusRingType
            replacement.stringValue = stringValue
            cell = replacement
        }

        // StarlingsTextField is a one-line control. AppKit otherwise wraps the
        // shared field editor inside the fixed-height well when a long value
        // reaches its edge, leaving the last line clipped by the shell.
        guard let meetCell = cell as? StarlingsTextFieldCell else { return }
        meetCell.usesSingleLineMode = true
        meetCell.wraps = false
        meetCell.lineBreakMode = .byTruncatingTail
        meetCell.truncatesLastVisibleLine = true
    }

    private func configureChrome() {
        isEditable = true
        isSelectable = true
        // The shell is drawn on our own layer so the fill comes from StarlingsColors
        // rather than whatever `.roundedBezel` renders for the system appearance.
        isBezeled = false
        drawsBackground = false
        controlSize = .large
        font = Self.fieldFont
        textColor = StarlingsColors.primaryText
        allowsEditingTextAttributes = false
        focusRingType = .none
        wantsLayer = true
        // Keep width constant — changing borderWidth on focus shifts the field editor.
        layer?.cornerRadius = Self.fieldCornerRadius
        layer?.cornerCurve = .continuous
        layer?.backgroundColor = StarlingsColors.fieldGround(for: self)
        layer?.borderWidth = Self.borderWidth
        applyFocusBorder(false)
        trackMeetHover { [weak self] hovered in
            self?.isHovered = hovered
            self?.refreshBorder()
        }
        refreshPlaceholder()
        if let heightConstraint {
            heightConstraint.constant = Self.fieldHeight
            heightConstraint.isActive = true
        } else {
            let constraint = heightAnchor.constraint(equalToConstant: Self.fieldHeight)
            constraint.isActive = true
            heightConstraint = constraint
        }
    }

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became {
            applyFocusBorder(true)
            if let editor = currentEditor() {
                Self.styleFieldEditor(editor, font: font)
            }
        }
        return became
    }

    override func textDidBeginEditing(_ notification: Notification) {
        super.textDidBeginEditing(notification)
        applyFocusBorder(true)
        if let editor = currentEditor() {
            Self.styleFieldEditor(editor, font: font)
        }
    }

    override func textDidEndEditing(_ notification: Notification) {
        super.textDidEndEditing(notification)
        applyFocusBorder(false)
        textColor = StarlingsColors.primaryText
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned, currentEditor() == nil {
            applyFocusBorder(false)
        }
        return resigned
    }

    private func applyFocusBorder(_ focused: Bool) {
        isFocused = focused
        refreshBorder()
    }

    /// An input is a well, so it is the one control that does *not* lift its fill on
    /// hover — the hairline brightens instead. Focus still outranks hover: the accent
    /// ring has to stay the loudest thing on the field.
    private func refreshBorder() {
        if isFocused {
            layer?.borderColor = StarlingsColors.resolved(StarlingsColors.accent, for: self).cgColor
            return
        }
        layer?.borderColor = StarlingsColors.hairline(for: self, hovered: isHovered && isEditable)
    }

    /// Placeholders are brand grey at the field's own size — never AppKit's default.
    /// Guarded because assigning the attributed form can clear `placeholderString`.
    private func refreshPlaceholder() {
        guard !isRefreshingPlaceholder else { return }
        let text = placeholderString ?? placeholderAttributedString?.string
        guard let text, !text.isEmpty else { return }
        isRefreshingPlaceholder = true
        defer { isRefreshingPlaceholder = false }
        placeholderAttributedString = NSAttributedString(string: text, attributes: [
            .font: font ?? Self.fieldFont,
            .foregroundColor: StarlingsColors.secondaryText,
        ])
    }

    /// Renders as static identity text (no shell / focus ring). Static labels
    /// stay non-selectable; only the editable field state accepts text selection.
    func applyPersistentAppearance(_ persistent: Bool, emphasis: PersistentEmphasis = .primary) {
        isPersistent = persistent
        isEditable = !persistent
        isSelectable = !persistent
        isBezeled = false
        drawsBackground = false
        focusRingType = .none
        if persistent {
            layer?.borderWidth = 0
            layer?.borderColor = NSColor.clear.cgColor
            layer?.backgroundColor = NSColor.clear.cgColor
            layer?.cornerRadius = 0
            backgroundColor = .clear
            controlSize = .regular
            switch emphasis {
            case .primary:
                font = Self.persistentFont
                textColor = StarlingsColors.primaryText
            case .secondary:
                font = Self.persistentSecondaryFont
                textColor = StarlingsColors.secondaryText
            }
            heightConstraint?.isActive = false
        } else {
            textColor = StarlingsColors.primaryText
            controlSize = .large
            layer?.cornerRadius = Self.fieldCornerRadius
            layer?.backgroundColor = StarlingsColors.fieldGround(for: self)
            layer?.borderWidth = Self.borderWidth
            font = Self.fieldFont
            heightConstraint?.constant = Self.fieldHeight
            heightConstraint?.isActive = true
            applyFocusBorder(currentEditor() != nil)
        }
        refreshPlaceholder()
    }
}

/// `NSSearchFieldCell` laid out by hand instead of by the stock bezel math.
/// The stock cell positions its icon, cancel button and text-edit rect off
/// the standard bezeled search field's own metrics; ours draws no bezel at
/// all, so those rects land wrong — text sits above the shell's centre, and
/// the field-editor's rect (used for the caret and click hit-testing) starts
/// further left than the icon actually drawn. Same fix `StarlingsTextFieldCell`
/// applies for the 40pt fields, extended to also own the icon/cancel rects
/// the search cell adds.
private final class StarlingsSearchFieldCell: NSSearchFieldCell {
    /// Matches `StarlingsTextFieldCell`'s left inset, so the icon sits the same
    /// distance from the shell edge that our other fields' text does.
    private static let horizontalInset: CGFloat = 8

    private var lineHeight: CGFloat {
        let font = self.font ?? StarlingsSearchField.fieldFont
        return ceil(font.ascender - font.descender + font.leading)
    }

    private func verticallyCentered(_ rect: NSRect) -> NSRect {
        let line = lineHeight
        guard rect.height > line else { return rect }
        var body = rect
        body.origin.y += ((body.height - line) / 2).rounded(.down)
        body.size.height = line
        return body
    }

    override func searchButtonRect(forBounds rect: NSRect) -> NSRect {
        var button = super.searchButtonRect(forBounds: rect)
        button.origin.x = rect.origin.x + Self.horizontalInset
        button.origin.y = rect.origin.y + ((rect.height - button.height) / 2).rounded(.down)
        return button
    }

    override func cancelButtonRect(forBounds rect: NSRect) -> NSRect {
        var button = super.cancelButtonRect(forBounds: rect)
        guard button.width > 0 else { return button }
        button.origin.x = rect.maxX - Self.horizontalInset - button.width
        button.origin.y = rect.origin.y + ((rect.height - button.height) / 2).rounded(.down)
        return button
    }

    /// The field editor's frame — what places the caret and decides where a
    /// click lands in the text versus the icon. Deriving it from the same
    /// icon/cancel rects the cell draws is what keeps the two in agreement.
    override func searchTextRect(forBounds rect: NSRect) -> NSRect {
        let icon = searchButtonRect(forBounds: rect)
        let cancel = cancelButtonRect(forBounds: rect)
        let left = icon.maxX + Self.horizontalInset
        let right = cancel.width > 0 ? cancel.minX - Self.horizontalInset : rect.maxX - Self.horizontalInset
        let body = NSRect(x: left, y: rect.origin.y, width: max(0, right - left), height: rect.height)
        return verticallyCentered(body)
    }

    override func drawingRect(forBounds rect: NSRect) -> NSRect {
        searchTextRect(forBounds: rect)
    }

    override func setUpFieldEditorAttributes(_ textObj: NSText) -> NSText {
        let text = super.setUpFieldEditorAttributes(textObj)
        StarlingsTextField.styleFieldEditor(text, font: font)
        return text
    }

    override func edit(
        withFrame rect: NSRect,
        in controlView: NSView,
        editor textObj: NSText,
        delegate: Any?,
        event: NSEvent?
    ) {
        StarlingsTextField.styleFieldEditor(textObj, font: font)
        super.edit(
            withFrame: searchTextRect(forBounds: rect),
            in: controlView,
            editor: textObj,
            delegate: delegate,
            event: event
        )
    }

    override func select(
        withFrame rect: NSRect,
        in controlView: NSView,
        editor textObj: NSText,
        delegate: Any?,
        start selStart: Int,
        length selLength: Int
    ) {
        StarlingsTextField.styleFieldEditor(textObj, font: font)
        super.select(
            withFrame: searchTextRect(forBounds: rect),
            in: controlView,
            editor: textObj,
            delegate: delegate,
            start: selStart,
            length: selLength
        )
    }
}

/// `NSSearchField` wearing the `StarlingsTextField` shell: same fill, radius and accent
/// focus ring, so a search box reads as one of our inputs rather than as system
/// chrome with a blue system focus ring around it.
final class StarlingsSearchField: NSSearchField {
    /// Search sits in toolbars beside 28pt controls, not in 40pt form stacks.
    static let fieldHeight: CGFloat = 28
    /// One width for every toolbar search item. The placeholder is a single
    /// word, so the field needs room for a query, not for a sentence.
    static let toolbarWidth: CGFloat = 140
    static let fieldFont = StarlingsTextField.fieldFont

    /// The toolbar item for a surface search field. A plain view item, not
    /// `NSSearchToolbarItem`: that one hands the field a frame padded for
    /// the system bezel, clips it to the glass capsule, and grows it to the
    /// space the toolbar has. So the shell drew as a wide rounded rect with
    /// its ends cut off. Here the field is the item, at its own size.
    static func toolbarItem(
        _ identifier: NSToolbarItem.Identifier,
        field: StarlingsSearchField,
        toolTip: String
    ) -> NSToolbarItem {
        let item = NSToolbarItem(itemIdentifier: identifier)
        field.translatesAutoresizingMaskIntoConstraints = false
        // Height comes from the constraint every StarlingsSearchField carries.
        field.widthAnchor.constraint(equalToConstant: toolbarWidth).isActive = true
        item.view = field
        item.label = String(localized: "Search")
        item.toolTip = toolTip
        return item
    }

    private var heightConstraint: NSLayoutConstraint?
    private var isFocused = false
    private var isHovered = false
    private var isRefreshingPlaceholder = false
    /// Watches for a click outside the field while it holds the caret. Rows
    /// in this app are plain views that select themselves on `mouseDown`
    /// without ever becoming first responder, so nothing else would resign
    /// us and drop the selection the way clicking away from a search box
    /// does everywhere else on the Mac.
    // Removed in a nonisolated deinit; the token itself is never touched off-main.
    nonisolated(unsafe) private var outsideClickMonitor: Any?

    override var placeholderString: String? {
        didSet { refreshPlaceholder() }
    }

    override class var cellClass: AnyClass? {
        get { StarlingsSearchFieldCell.self }
        set {}
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        configureChrome()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configureChrome()
    }

    deinit {
        if let outsideClickMonitor {
            NSEvent.removeMonitor(outsideClickMonitor)
        }
    }

    convenience init(placeholder: String) {
        self.init(frame: .zero)
        placeholderString = placeholder
    }

    /// Apply the one live-search policy used by every Meet search field.
    /// `NSSearchField` sends the action as the query changes, so screens only
    /// provide their placeholder and destination instead of each wiring its
    /// own notification observer.
    func configure(placeholder: String, target: AnyObject, action: Selector) {
        placeholderString = placeholder
        sendsWholeSearchString = false
        sendsSearchStringImmediately = true
        self.target = target
        self.action = action
    }

    override var intrinsicContentSize: NSSize {
        var size = super.intrinsicContentSize
        size.height = max(size.height, Self.fieldHeight)
        return size
    }

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became {
            applyFocusBorder(true)
            if let editor = currentEditor() {
                StarlingsTextField.styleFieldEditor(editor, font: font)
            }
            installOutsideClickMonitor()
        }
        return became
    }

    override func textDidBeginEditing(_ notification: Notification) {
        super.textDidBeginEditing(notification)
        applyFocusBorder(true)
        if let editor = currentEditor() {
            StarlingsTextField.styleFieldEditor(editor, font: font)
        }
        installOutsideClickMonitor()
    }

    override func textDidEndEditing(_ notification: Notification) {
        super.textDidEndEditing(notification)
        applyFocusBorder(false)
        removeOutsideClickMonitor()
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned, currentEditor() == nil {
            applyFocusBorder(false)
            removeOutsideClickMonitor()
        }
        return resigned
    }

    private func installOutsideClickMonitor() {
        guard outsideClickMonitor == nil else { return }
        outsideClickMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
            guard let self, let window = self.window, event.window === window else { return event }
            let point = self.convert(event.locationInWindow, from: nil)
            if !self.bounds.contains(point) {
                window.makeFirstResponder(nil)
            }
            return event
        }
    }

    private func removeOutsideClickMonitor() {
        guard let outsideClickMonitor else { return }
        NSEvent.removeMonitor(outsideClickMonitor)
        self.outsideClickMonitor = nil
    }

    private func configureChrome() {
        // The shell is ours, so the stock bezel and its system-blue focus ring
        // both have to go — the magnifier and cancel buttons are drawn by the
        // cell either way.
        isBezeled = false
        isBordered = false
        drawsBackground = false
        focusRingType = .none
        font = Self.fieldFont
        textColor = StarlingsColors.primaryText
        wantsLayer = true
        // A stadium, not the control rung: the toolbar wraps the field in a
        // glass pill on macOS 26, and a smaller radius inside it reads as a
        // second shape. `layout` keeps it half the height the toolbar gives.
        layer?.cornerRadius = Self.fieldHeight / 2
        layer?.cornerCurve = .circular
        layer?.backgroundColor = StarlingsColors.fieldGround(for: self)
        // Constant width — changing it on focus would shift the field editor.
        layer?.borderWidth = StarlingsTextField.borderWidth
        applyFocusBorder(false)
        trackMeetHover { [weak self] hovered in
            self?.isHovered = hovered
            self?.refreshBorder()
        }
        refreshPlaceholder()
        // Below `required`, so a host that sizes the field itself wins.
        let constraint = heightAnchor.constraint(equalToConstant: Self.fieldHeight)
        constraint.priority = .defaultHigh
        constraint.isActive = true
        heightConstraint = constraint
    }

    private func applyFocusBorder(_ focused: Bool) {
        isFocused = focused
        refreshBorder()
    }

    private func refreshBorder() {
        if isFocused {
            layer?.borderColor = StarlingsColors.resolved(StarlingsColors.accent, for: self).cgColor
            return
        }
        layer?.borderColor = StarlingsColors.hairline(for: self, hovered: isHovered && isEditable)
    }

    /// Placeholders are brand grey at the field's own size — never AppKit's default.
    private func refreshPlaceholder() {
        guard !isRefreshingPlaceholder else { return }
        guard let text = placeholderString ?? placeholderAttributedString?.string,
              !text.isEmpty else { return }
        isRefreshingPlaceholder = true
        defer { isRefreshingPlaceholder = false }
        placeholderAttributedString = NSAttributedString(string: text, attributes: [
            .font: font ?? Self.fieldFont,
            .foregroundColor: StarlingsColors.secondaryText,
        ])
    }

    override func updateLayer() {
        super.updateLayer()
        layer?.backgroundColor = StarlingsColors.fieldGround(for: self)
        refreshBorder()
    }
}

/// `NSDatePicker` wearing the `StarlingsTextField` shell: same fill, radius, height,
/// and accent focus border. The picker keeps its natural size inside the shell so
/// its component layout stays correct.
final class StarlingsDatePickerField: NSView {
    let picker = StarlingsDatePicker()
    private var isFocused = false
    private var isHovered = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = StarlingsTextField.fieldCornerRadius
        layer?.cornerCurve = .continuous
        layer?.backgroundColor = StarlingsColors.fieldGround(for: self)
        layer?.borderWidth = StarlingsTextField.borderWidth
        applyFocusBorder(false)

        picker.onFocusChange = { [weak self] focused in
            self?.applyFocusBorder(focused)
        }
        trackMeetHover { [weak self] hovered in
            self?.isHovered = hovered
            self?.refreshBorder()
        }
        picker.translatesAutoresizingMaskIntoConstraints = false
        addSubview(picker)
        NSLayoutConstraint.activate([
            picker.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            picker.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -8),
            picker.centerYAnchor.constraint(equalTo: centerYAnchor),
            heightAnchor.constraint(equalToConstant: StarlingsTextField.fieldHeight),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func applyFocusBorder(_ focused: Bool) {
        isFocused = focused
        refreshBorder()
    }

    /// See `StarlingsTextField.viewDidMoveToWindow`: fill and hairline resolve
    /// against the window, not at `init`.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        layer?.backgroundColor = StarlingsColors.fieldGround(for: self)
        refreshBorder()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        layer?.backgroundColor = StarlingsColors.fieldGround(for: self)
        refreshBorder()
    }

    /// Same rule as `StarlingsTextField`: the well keeps its fill, the hairline answers
    /// the pointer, and focus outranks hover.
    private func refreshBorder() {
        if isFocused {
            layer?.borderColor = StarlingsColors.resolved(StarlingsColors.accent, for: self).cgColor
            return
        }
        layer?.borderColor = StarlingsColors.hairline(for: self, hovered: isHovered)
    }
}

/// Chromeless date picker — the surrounding `StarlingsDatePickerField` draws the shell.
final class StarlingsDatePicker: NSDatePicker, NSDatePickerCellDelegate {
    var onFocusChange: ((Bool) -> Void)?

    /// Minutes the stepper and the arrow keys move the clock by.
    /// 1 is AppKit's own step. Typed digits stay exact, so an event on an odd
    /// minute keeps it until someone steps it.
    var minuteStep: Int = 1 {
        didSet { delegate = minuteStep > 1 ? self : nil }
    }

    /// The minute one step up or down the grid, wrapping inside the hour the
    /// way AppKit's stepper does. An odd minute lands on the grid first.
    nonisolated static func stepped(minute: Int, by direction: Int, step: Int) -> Int {
        let step = max(1, step)
        let next: Int
        if minute % step == 0 {
            next = minute + direction * step
        } else {
            next = direction > 0 ? (minute / step + 1) * step : (minute / step) * step
        }
        return ((next % 60) + 60) % 60
    }

    func datePickerCell(
        _ datePickerCell: NSDatePickerCell,
        validateProposedDateValue proposedDateValue: AutoreleasingUnsafeMutablePointer<NSDate>,
        timeInterval proposedTimeInterval: UnsafeMutablePointer<TimeInterval>?
    ) {
        guard minuteStep > 1 else { return }
        // Only a step: a stepper click or an arrow key. A typed digit is the
        // person's exact minute.
        if let event = NSApp.currentEvent, event.type == .keyDown,
           let key = event.charactersIgnoringModifiers?.unicodeScalars.first,
           CharacterSet.decimalDigits.contains(key) {
            return
        }
        let calendar = Calendar.current
        let current = dateValue
        let proposed = proposedDateValue.pointee as Date
        let before = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: current)
        var after = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: proposed)
        guard before.year == after.year, before.month == after.month, before.day == after.day,
              before.hour == after.hour, let old = before.minute, let new = after.minute else { return }
        let direction: Int
        if new == (old + 1) % 60 { direction = 1 }
        else if new == (old + 59) % 60 { direction = -1 }
        else { return }
        after.minute = Self.stepped(minute: old, by: direction, step: minuteStep)
        if let snapped = calendar.date(from: after) {
            proposedDateValue.pointee = snapped as NSDate
        }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        configureChrome()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configureChrome()
    }

    private func configureChrome() {
        datePickerStyle = .textFieldAndStepper
        locale = StarlingsDateFormatting.locale
        isBezeled = false
        isBordered = false
        drawsBackground = false
        focusRingType = .none
        font = StarlingsTextField.fieldFont
        textColor = StarlingsColors.primaryText
    }

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became { onFocusChange?(true) }
        return became
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { onFocusChange?(false) }
        return resigned
    }
}

/// A menu wearing the same well as `StarlingsTextField` — same fill, hairline,
/// corner radius and height — so a form row of fields and menus reads as one
/// system rather than as our design plus AppKit's.
///
/// The bezel is ours because AppKit's is not tintable: a `.rounded` pop-up
/// paints its chevron well in `controlAccentColor`, which is whatever colour
/// the person picked in System Settings — blue on a stock Mac, and never the
/// brand's. Setting `AccentColor` in the catalogue does not win that argument.
@MainActor
final class StarlingsPopUpField: NSView {
    let popup = StarlingsPopUp(frame: .zero, pullsDown: false)
    private let chevron = NSImageView()
    private var isFocused = false
    private var isHovered = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = StarlingsTextField.fieldCornerRadius
        layer?.cornerCurve = .continuous
        layer?.backgroundColor = StarlingsColors.fieldGround(for: self)
        layer?.borderWidth = StarlingsTextField.borderWidth
        applyFocusBorder(false)

        popup.onFocusChange = { [weak self] focused in
            self?.applyFocusBorder(focused)
        }
        trackMeetHover { [weak self] hovered in
            self?.isHovered = hovered
            self?.refreshBorder()
        }

        let config = NSImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
        chevron.image = NSImage(
            systemSymbolName: "chevron.up.chevron.down",
            accessibilityDescription: nil
        )?.withSymbolConfiguration(config)
        chevron.contentTintColor = StarlingsColors.secondaryText
        // The chevron is decoration; the pop-up underneath answers the click.
        chevron.isEnabled = false

        popup.translatesAutoresizingMaskIntoConstraints = false
        chevron.translatesAutoresizingMaskIntoConstraints = false
        // Keep the decorative image behind the control. A subview on top of
        // an NSControl still participates in hit testing, so the old order
        // made the right side of every menu look enabled but swallow clicks.
        addSubview(chevron)
        addSubview(popup)
        NSLayoutConstraint.activate([
            popup.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            popup.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            popup.centerYAnchor.constraint(equalTo: centerYAnchor),
            chevron.leadingAnchor.constraint(greaterThanOrEqualTo: popup.trailingAnchor, constant: 4),
            chevron.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -11),
            chevron.centerYAnchor.constraint(equalTo: centerYAnchor),
            heightAnchor.constraint(equalToConstant: StarlingsTextField.fieldHeight),
        ])
        // The title is what should give way when the row is narrow, not the
        // chevron — a menu with no chevron does not look like a menu.
        popup.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func applyFocusBorder(_ focused: Bool) {
        isFocused = focused
        refreshBorder()
    }

    /// See `StarlingsTextField.viewDidMoveToWindow`: fill and hairline resolve
    /// against the window, not at `init`.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        layer?.backgroundColor = StarlingsColors.fieldGround(for: self)
        refreshBorder()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        layer?.backgroundColor = StarlingsColors.fieldGround(for: self)
        refreshBorder()
    }

    /// Same rule as `StarlingsTextField`: the well keeps its fill, the hairline
    /// answers the pointer, and focus outranks hover.
    private func refreshBorder() {
        if isFocused {
            layer?.borderColor = StarlingsColors.resolved(StarlingsColors.accent, for: self).cgColor
            return
        }
        layer?.borderColor = StarlingsColors.hairline(for: self, hovered: isHovered)
    }
}

/// Chromeless pop-up — the surrounding `StarlingsPopUpField` draws the shell. Menu
/// item titles stay in system ink so the drop-down itself renders the way
/// every other menu on the Mac does, including over the selection highlight.
@MainActor
final class StarlingsPopUp: NSPopUpButton {
    var onFocusChange: ((Bool) -> Void)?

    override init(frame frameRect: NSRect, pullsDown flag: Bool) {
        super.init(frame: frameRect, pullsDown: flag)
        configureChrome()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configureChrome()
    }

    private func configureChrome() {
        isBordered = false
        focusRingType = .none
        font = StarlingsTextField.fieldFont
        // The surrounding field owns the chevron. Borderless pop-ups still
        // draw AppKit's arrow unless the cell is explicitly told not to.
        if let popupCell = cell as? NSPopUpButtonCell {
            popupCell.arrowPosition = .noArrow
        }
        imagePosition = .noImage
    }

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became { onFocusChange?(true) }
        return became
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { onFocusChange?(false) }
        return resigned
    }
}

@MainActor
final class StatusRow: NSView {
    private let dot = NSView()
    private let titleLabel: NSTextField
    private let detailLabel = NSTextField(labelWithString: String(localized: "Not checked"))

    init(title: String) {
        titleLabel = NSTextField(labelWithString: title)
        super.init(frame: .zero)
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 4
        dot.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.secondaryText, for: dot).cgColor
        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .medium)
        titleLabel.textColor = StarlingsColors.primaryText
        detailLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        detailLabel.textColor = StarlingsColors.secondaryText

        let labels = NSStackView(views: [titleLabel, detailLabel])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 1
        let row = NSStackView(views: [dot, labels, NSView()])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        addSubview(row)
        row.pinToEdges(of: self)
        NSLayoutConstraint.activate([
            dot.widthAnchor.constraint(equalToConstant: 8),
            dot.heightAnchor.constraint(equalToConstant: 8),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 34),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func update(state: PermissionState, detail: String) {
        detailLabel.stringValue = detail
        dot.layer?.borderWidth = 0
        switch state {
        case .allowed:
            // Active/on is semantic: the dot takes the accent so "In meeting"
            // reads as live at a glance, matching the settings status rows.
            dot.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.accent, for: dot).cgColor
        case .unknown:
            // Not-asked is a hollow ring, not just a dimmer fill, so it reads
            // as a distinct third state rather than a muted "allowed."
            dot.layer?.backgroundColor = NSColor.clear.cgColor
            dot.layer?.borderWidth = 1.5
            dot.layer?.borderColor = StarlingsColors.resolved(StarlingsColors.secondaryText, for: dot).cgColor
        case .denied, .restricted:
            dot.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.danger, for: dot).cgColor
        }
    }

    func setTitle(_ title: String) {
        titleLabel.stringValue = title
    }
}

@MainActor
final class CopyableURLRow: NSView {
    private let urlLabel = NSTextField(labelWithString: "")
    private let copyButton = NSButton(title: "", target: nil, action: nil)
    private var clipboardValue = ""
    private var copyFlashWorkItem: DispatchWorkItem?

    private static let copySymbol = "doc.on.doc"
    private static let copiedSymbol = "checkmark"
    private static let symbolConfig = NSImage.SymbolConfiguration(pointSize: 11, weight: .semibold)

    var displayString: String {
        get { urlLabel.stringValue }
        set {
            urlLabel.stringValue = newValue
        }
    }

    var clipboardString: String {
        get { clipboardValue }
        set { clipboardValue = newValue }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        urlLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .medium)
        urlLabel.textColor = StarlingsColors.primaryText
        urlLabel.lineBreakMode = .byTruncatingMiddle
        urlLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        applyCopySymbol(Self.copySymbol)
        copyButton.imagePosition = .imageOnly
        copyButton.bezelStyle = .inline
        copyButton.isBordered = false
        copyButton.contentTintColor = StarlingsColors.secondaryText
        copyButton.toolTip = String(localized: "Copy link")
        copyButton.setAccessibilityLabel(String(localized: "Copy link"))
        copyButton.target = self
        copyButton.action = #selector(copyURL)
        copyButton.setContentHuggingPriority(.required, for: .horizontal)
        copyButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        SettingsChrome.applyQuietButton(copyButton)

        let row = NSStackView(views: [urlLabel, copyButton])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        addSubview(row)
        row.pinToEdges(of: self)
        heightAnchor.constraint(greaterThanOrEqualToConstant: 22).isActive = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setRoomPath(_ path: String, webOrigin: String = MeetingInvite.publicWebOrigin) {
        setInviteURL(
            MeetingInvite.absoluteURL(
                path: path,
                webOrigin: MeetingInvite.shareOrigin(configuredWebOrigin: webOrigin)
            )
        )
    }

    func setInviteURL(_ absoluteURL: String) {
        let canonical = MeetingInvite.canonicalJoinURL(absoluteURL)
        // Include non-default ports so Debug loopback shows :5173, not bare 127.0.0.1.
        displayString = MeetingInvite.displayJoinURL(canonical)
        clipboardString = canonical
    }

    @discardableResult
    func copyInviteLink() -> Bool {
        let value = clipboardValue.isEmpty ? urlLabel.stringValue : clipboardValue
        guard !value.isEmpty else { return false }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
        flashCopyConfirmation()
        return true
    }

    @objc private func copyURL() {
        _ = copyInviteLink()
    }

    private func applyCopySymbol(_ name: String) {
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil) else { return }
        copyButton.image = image.withSymbolConfiguration(Self.symbolConfig)
    }

    private func flashCopyConfirmation() {
        copyFlashWorkItem?.cancel()
        applyCopySymbol(Self.copiedSymbol)
        copyButton.toolTip = String(localized: "Copied")
        copyButton.setAccessibilityLabel(String(localized: "Copied"))
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.applyCopySymbol(Self.copySymbol)
            self.copyButton.contentTintColor = StarlingsColors.secondaryText
            self.copyButton.toolTip = String(localized: "Copy link")
            self.copyButton.setAccessibilityLabel(String(localized: "Copy link"))
        }
        copyFlashWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: work)
    }
}

@MainActor
final class LobbyGuestRow: NSView {
    let requestID: String
    private let detailLabel = StarlingsTypography.wrappingLabel("")
    private let clientImageView = NSImageView()
    private let admitButton = StarlingsFilledButton(style: .accent, title: String(localized: "Admit"))
    private let declineButton = NSButton(title: "", target: nil, action: nil)
    private var isRecordingNotetaker = false
    private var selectedOnBehalfOf: String?
    private let attributionPicker = NSPopUpButton()
    var onAdmit: ((String, String?) -> Void)?
    var onDecline: ((String) -> Void)?

    private static let declineSymbolConfig = NSImage.SymbolConfiguration(pointSize: 11, weight: .semibold)

    init(
        requestID: String,
        detail: String,
        client: GuestClient? = nil,
        recording: Bool = false,
        onBehalfOf: String? = nil,
        people: [Peer] = [],
        cardChrome: Bool = true
    ) {
        self.requestID = requestID
        isRecordingNotetaker = recording
        selectedOnBehalfOf = onBehalfOf
        super.init(frame: .zero)
        if cardChrome {
            wantsLayer = true
            layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: self).cgColor
            layer?.cornerRadius = 10
            layer?.borderWidth = 1
            layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor
        }

        detailLabel.stringValue = detail
        detailLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        detailLabel.textColor = StarlingsColors.primaryText
        detailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let detailView: NSView
        if let client {
            clientImageView.image = NSImage(
                systemSymbolName: client.systemSymbolName,
                accessibilityDescription: client.badge
            )?.withSymbolConfiguration(.init(pointSize: 12, weight: .semibold))
            clientImageView.contentTintColor = StarlingsColors.secondaryText
            clientImageView.toolTip = client.badge
            clientImageView.setAccessibilityLabel(client.badge)
            clientImageView.setContentHuggingPriority(.required, for: .horizontal)
            let detailStack = NSStackView(views: [clientImageView, detailLabel])
            detailStack.orientation = .horizontal
            detailStack.alignment = .centerY
            detailStack.spacing = 6
            detailView = detailStack
        } else {
            detailView = detailLabel
        }

        admitButton.apply(
            .accent,
            title: String(localized: "Admit"),
            font: .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold),
            cornerRadius: 7,
            height: 28
        )
        admitButton.target = self
        admitButton.action = #selector(admitTapped)
        admitButton.setContentHuggingPriority(.defaultHigh, for: .horizontal)

        // Decline is rare — quiet × on the trailing edge, not a second CTA.
        declineButton.image = NSImage(
            systemSymbolName: "xmark",
            accessibilityDescription: String(localized: "Decline")
        )?.withSymbolConfiguration(Self.declineSymbolConfig)
        declineButton.imagePosition = .imageOnly
        declineButton.bezelStyle = .inline
        declineButton.isBordered = false
        declineButton.contentTintColor = StarlingsColors.secondaryText
        declineButton.toolTip = String(localized: "Decline this guest")
        declineButton.setAccessibilityLabel(String(localized: "Decline"))
        declineButton.target = self
        declineButton.action = #selector(declineTapped)
        declineButton.setContentHuggingPriority(.required, for: .horizontal)
        declineButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        SettingsChrome.applyQuietButton(declineButton)
        declineButton.widthAnchor.constraint(equalToConstant: 22).isActive = true
        declineButton.heightAnchor.constraint(equalToConstant: 22).isActive = true

        let header = NSStackView(views: [detailView, declineButton])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = 8
        header.distribution = .fill

        let actions = NSStackView(views: [admitButton, NSView()])
        actions.orientation = .horizontal
        actions.alignment = .centerY
        actions.spacing = 6

        var arranged: [NSView] = [header]
        if recording && onBehalfOf == nil {
            attributionPicker.addItem(withTitle: String(localized: "Choose who sent this notetaker"))
            attributionPicker.lastItem?.isEnabled = false
            attributionPicker.lastItem?.tag = -1
            for person in people {
                let title = person.name?.trimmingCharacters(in: .whitespacesAndNewlines)
                attributionPicker.addItem(withTitle: title?.isEmpty == false ? title! : person.email)
                attributionPicker.lastItem?.representedObject = person.email
            }
            if let onBehalfOf,
               let item = attributionPicker.itemArray.first(where: { ($0.representedObject as? String)?.caseInsensitiveCompare(onBehalfOf) == .orderedSame }) {
                attributionPicker.select(item)
            }
            attributionPicker.target = self
            attributionPicker.action = #selector(attributionChanged)
            attributionPicker.setAccessibilityLabel(String(localized: "Choose who sent this notetaker"))
            attributionPicker.toolTip = String(localized: "Choose a person from the team roster before admitting this notetaker.")
            attributionPicker.isEnabled = !people.isEmpty
            arranged.append(attributionPicker)
        }
        arranged.append(actions)
        let stack = NSStackView(views: arranged)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        addSubview(stack)
        let inset = cardChrome
            ? NSEdgeInsets(top: 10, left: 10, bottom: 10, right: 10)
            : NSEdgeInsets()
        stack.pinToEdges(of: self, insets: inset)
        header.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        if arranged.count > 2 { attributionPicker.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        actions.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        admitButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 88).isActive = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// - Parameters:
    ///   - admitTitle: The visible label for the row-level admission action.
    ///   - admitVisible: Whether the row-level admission action is shown. Launch
    ///     hides it pre-live in favor of the primary Start & Admit action.
    ///   - isNext: Adds keyboard shortcut hints for the FIFO head of the queue.
    func configure(
        admitTitle: String,
        admitVisible: Bool,
        admitEnabled: Bool,
        isNext: Bool,
        busy: Bool
    ) {
        admitButton.apply(
            .accent,
            title: admitTitle,
            font: .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold),
            cornerRadius: 7,
            height: 28
        )
        admitButton.isHidden = !admitVisible
        admitButton.isEnabled = admitEnabled && !busy && (!isRecordingNotetaker || selectedOnBehalfOf != nil)
        declineButton.isEnabled = !busy
        declineButton.alphaValue = busy ? 0.4 : 1
        if isNext {
            if admitVisible {
            }
            declineButton.toolTip = String(localized: "Decline this guest (⌘⇧⌫)")
        } else {
            // Visible title already says "Admit" / "Start & Admit" — a tooltip
            // here would only repeat it (unlike the `isNext` branch above,
            // which earns its tooltip by naming a shortcut the title doesn't).
            declineButton.toolTip = String(localized: "Decline this guest")
        }
    }

    func setBusy(_ busy: Bool) {
        admitButton.isEnabled = !admitButton.isHidden && !busy && (!isRecordingNotetaker || selectedOnBehalfOf != nil)
        declineButton.isEnabled = !busy
        declineButton.alphaValue = busy ? 0.4 : 1
    }

    @objc private func admitTapped() {
        guard !isRecordingNotetaker || selectedOnBehalfOf != nil else { return }
        setBusy(true)
        // A booking projection supplied and verified this attribution before
        // the lobby row was built. Only send an attribution when the owner
        // actively chose one from the roster; the Worker preserves a verified
        // booking attribution when this field is omitted.
        let ownerSelectedSender = attributionPicker.numberOfItems > 1 ? selectedOnBehalfOf : nil
        onAdmit?(requestID, ownerSelectedSender)
    }

    @objc private func attributionChanged() {
        selectedOnBehalfOf = attributionPicker.selectedItem?.representedObject as? String
        admitButton.isEnabled = !isRecordingNotetaker || selectedOnBehalfOf != nil
    }

    @objc private func declineTapped() {
        setBusy(true)
        onDecline?(requestID)
    }
}

@MainActor
final class LobbyLurkerRow: NSView {
    let lurkerID: String
    private let detailLabel = StarlingsTypography.wrappingLabel("")
    private let countryFlagImageView = NSImageView()
    private let clientImageView = NSImageView()
    private let removeButton = NSButton(title: "", target: nil, action: nil)
    /// Closing this visitor's connection: drops them off the page and blocks
    /// their tab from re-announcing for a cooldown (see `removeGuestPresence`).
    var onRemove: ((String) -> Void)?

    private static let removeSymbolConfig = NSImage.SymbolConfiguration(pointSize: 11, weight: .semibold)

    /// A lurker's id is stable for their whole visit, so the row outlives every
    /// stage change. Its text has to be updatable in place or it freezes on
    /// whatever the guest was doing when they first appeared.
    func setDetail(_ detail: String) {
        guard detailLabel.stringValue != detail else { return }
        detailLabel.stringValue = detail
    }

    func setCountry(_ country: String?) {
        guard let image = StarlingsCountryFlag.image(for: country) else {
            countryFlagImageView.image = nil
            countryFlagImageView.isHidden = true
            return
        }
        countryFlagImageView.image = image
        countryFlagImageView.isHidden = false
        countryFlagImageView.toolTip = StarlingsCountryFlag.accessibilityLabel(for: country)
        countryFlagImageView.setAccessibilityLabel(
            StarlingsCountryFlag.accessibilityLabel(for: country) ?? String(localized: "Country")
        )
    }

    func setBusy(_ busy: Bool) {
        removeButton.isEnabled = !busy
        removeButton.alphaValue = busy ? 0.4 : 1
    }

    init(
        lurkerID: String,
        detail: String,
        country: String? = nil,
        client: GuestClient? = nil,
        cardChrome: Bool = true
    ) {
        self.lurkerID = lurkerID
        super.init(frame: .zero)
        if cardChrome {
            wantsLayer = true
            layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: self).cgColor
            layer?.cornerRadius = 10
            layer?.borderWidth = 1
            layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor
        }

        detailLabel.stringValue = detail
        detailLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        detailLabel.textColor = StarlingsColors.secondaryText
        detailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        countryFlagImageView.imageScaling = .scaleProportionallyUpOrDown
        countryFlagImageView.isHidden = true
        countryFlagImageView.setContentHuggingPriority(.required, for: .horizontal)
        countryFlagImageView.setContentCompressionResistancePriority(.required, for: .horizontal)
        countryFlagImageView.widthAnchor.constraint(equalToConstant: 18).isActive = true
        countryFlagImageView.heightAnchor.constraint(equalToConstant: 12).isActive = true
        setCountry(country)

        let detailView: NSView
        if let client {
            clientImageView.image = NSImage(
                systemSymbolName: client.systemSymbolName,
                accessibilityDescription: client.badge
            )?.withSymbolConfiguration(.init(pointSize: 12, weight: .semibold))
            clientImageView.contentTintColor = StarlingsColors.secondaryText
            clientImageView.toolTip = client.badge
            clientImageView.setAccessibilityLabel(client.badge)
            clientImageView.setContentHuggingPriority(.required, for: .horizontal)
            clientImageView.isHidden = false
        }
        clientImageView.isHidden = client == nil
        let detailStack = NSStackView(views: [countryFlagImageView, clientImageView, detailLabel])
        detailStack.orientation = .horizontal
        detailStack.alignment = .centerY
        detailStack.spacing = 6
        detailStack.distribution = .fill
        detailView = detailStack

        // Same quiet × as a knocked guest's decline — a lurker hasn't asked to
        // join, so there is nothing to admit, only somebody to send away.
        removeButton.image = NSImage(
            systemSymbolName: "xmark",
            accessibilityDescription: String(localized: "Remove")
        )?.withSymbolConfiguration(Self.removeSymbolConfig)
        removeButton.imagePosition = .imageOnly
        removeButton.bezelStyle = .inline
        removeButton.isBordered = false
        removeButton.contentTintColor = StarlingsColors.secondaryText
        removeButton.toolTip = String(localized: "Close this visitor’s connection")
        removeButton.setAccessibilityLabel(String(localized: "Remove"))
        removeButton.target = self
        removeButton.action = #selector(removeTapped)
        removeButton.setContentHuggingPriority(.required, for: .horizontal)
        removeButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        SettingsChrome.applyQuietButton(removeButton)
        removeButton.widthAnchor.constraint(equalToConstant: 22).isActive = true
        removeButton.heightAnchor.constraint(equalToConstant: 22).isActive = true

        let stack = NSStackView(views: [detailView, removeButton])
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 8
        stack.distribution = .fill
        addSubview(stack)
        let inset = cardChrome
            ? NSEdgeInsets(top: 10, left: 10, bottom: 10, right: 10)
            : NSEdgeInsets()
        stack.pinToEdges(of: self, insets: inset)
        heightAnchor.constraint(greaterThanOrEqualToConstant: 22).isActive = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    @objc private func removeTapped() {
        setBusy(true)
        onRemove?(lurkerID)
    }
}

enum LobbyLurkerCopy {
    static func detail(for lurker: GuestPresenceRow) -> String {
        let place = location(city: lurker.city)
        let who = lurker.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let named = (who?.isEmpty == false) ? who! : nil
        // Leads the row: which visitor this is matters more to the host than
        // what they are currently doing. Deliberately just a marker — the token
        // itself is CRM correlation data, not something to put on screen.
        let booked = (lurker.bookingToken?.isEmpty == false) ? String(localized: "Booked") : nil
        // Trails the row, next to the flag: same kind of fact as where they are.
        // Last, because it changes on its own every poll — put it after the
        // facts that only change when the visitor does something.
        let waiting = LobbyWaitCopy.elapsed(since: lurker.createdAt)
        switch lurker.stage {
        case .preview:
            // Still worth saying: they are at the device check, one click from
            // knocking. That is news the name doesn't already carry.
            return joinParts([booked, "Checking camera", named, place, waiting])
        case .naming:
            // The web only reports `naming` once a name exists, so "Entering
            // name" and the name itself were always the same fact printed twice.
            // The name alone says they are filling the form.
            return joinParts([booked, named ?? String(localized: "Entering name"), place, waiting])
        default:
            return joinParts([booked, "On the page", named, place, waiting])
        }
    }

    /// The country is represented by the flag leading the row. Keep only the
    /// city in the text so the same fact is not shown twice as artwork + code.
    private static func location(city: String?) -> String? {
        let cityPart = city?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (cityPart?.isEmpty == false) ? cityPart : nil
    }

    private static func joinParts(_ parts: [String?]) -> String {
        parts.compactMap { $0 }.joined(separator: " · ")
    }
}

/// One line per waiting knock, shared by the launch screen's waiting room and
/// the in-meeting lobby queue so the two never drift apart.
enum LobbyGuestCopy {
    static func detail(for request: LobbyRequestResponse, onBehalfOf override: String? = nil) -> String {
        let email = request.email.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts: [String?] = [
            request.name,
            email.isEmpty ? String(localized: "no email") : email,
            request.recording == true ? String(localized: "Recording") : nil,
            (override ?? request.onBehalfOf).map { String(localized: "Sent by \($0)") },
            (request.bookingToken?.isEmpty == false) ? String(localized: "has booking") : nil,
            LobbyWaitCopy.elapsed(since: request.createdAt),
        ]
        return parts.compactMap { $0 }.joined(separator: " · ")
    }
}

/// Shared "how long has this visitor been waiting" formatter — one clock for
/// both the pre-knock lurker row and the knocked-request row, so a host
/// reading down the queue sees the same units at every stage.
enum LobbyWaitCopy {
    static func elapsed(since createdAt: Int, now: Date = Date()) -> String? {
        let start = Date(timeIntervalSince1970: TimeInterval(createdAt) / 1000)
        let seconds = Int(now.timeIntervalSince(start))
        // A clock skew or brand-new row can read slightly negative — say
        // nothing rather than a confusing "-1s".
        guard seconds >= 0 else { return nil }
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        let remainingMinutes = minutes % 60
        return remainingMinutes == 0 ? String(localized: "\(hours)h") : String(localized: "\(hours)h \(remainingMinutes)m")
    }
}

// MARK: - Settings chrome (System Settings–style grouped lists)

/// The corner scale, taken from `EnvisioningUI` rather than restated here.
///
/// The package calls it "one corner scale for both apps" — field 12, control
/// 14, card 18 — and the iOS app has been drawing it all along. AppKit had its
/// own ladder (8 for a button, 9 for a field, 12 for a group), so the same
/// product rounded differently depending on which client you opened.
enum StarlingsRadius {
    static let field = EnvisioningRadius.field
    static let card = EnvisioningRadius.card

    /// The control rung is drawn for the 44–48pt button both apps use for a
    /// primary action. AppKit also has 32 and 28pt buttons, in footers and
    /// rows, and 14 flat on those is half their height — a stadium, not a
    /// corner. Holding the proportion the rung was drawn at keeps a compact
    /// button the same shape as the big one rather than a different one.
    static func control(height: CGFloat) -> CGFloat {
        min(EnvisioningRadius.control, height * (EnvisioningRadius.control / fullControlHeight))
    }

    /// The height the control rung is drawn for.
    private static let fullControlHeight: CGFloat = 44
}

/// The command-cell family used by the Mac meeting row. Keeping the geometry
/// and chrome here means a new in-meeting action cannot accidentally become a
/// different height, radius, font, or hover treatment from Mute and Camera.
@MainActor
final class StarlingsMeetingControlButton: NSButton {
    static let height: CGFloat = 68
    static let chooserWidth: CGFloat = 22
    /// Extra air between the glyph and its word. AppKit stacks the two almost
    /// touching in `.imageAbove`; the cell moves each half this far apart.
    static let imageTitleGap: CGFloat = 3

    override class var cellClass: AnyClass? {
        get { StarlingsMeetingControlCell.self }
        set {}
    }

    /// Width of whatever shares this button's shell on the trailing side
    /// (the chooser chevron and its separator). The button grows by this much
    /// when labelled and draws its content shifted by half of it, so the glyph
    /// and word sit centred on the whole shell, not on the button's own slice.
    var companionWidth: CGFloat = 0 {
        didSet {
            guard companionWidth != oldValue else { return }
            needsDisplay = true
            if let labelledWidthConstraint, labelledWidthConstraint.isActive {
                labelledWidthConstraint.constant = labelledWidth
            }
        }
    }

    /// `labelledWidth(forTitle:)` plus the room the companion takes.
    var labelledWidth: CGFloat {
        Self.labelledWidth(forTitle: title) + companionWidth
    }
    /// Room either side of a title. Borderless buttons reserve ~5pt in total,
    /// which drew "Share screen" tight against its own bezel.
    static let labelInset: CGFloat = 14
    /// The one font the row draws and measures with. `labelledWidth` in the
    /// density pass reads it back, so it must not be overridden per button.
    static let titleFont = NSFont.systemFont(ofSize: StarlingsTypography.scaled(13), weight: .medium)

    /// The width a labelled control asks for: never narrower than the icon-only
    /// square, and never tighter around its word than `labelInset` each side.
    /// The density pass uses the same formula, so what it budgets is what the
    /// row draws.
    static func labelledWidth(forTitle title: String) -> CGFloat {
        let text = (title as NSString).size(withAttributes: [.font: titleFont]).width
        return max(height, ceil(text) + labelInset * 2)
    }

    /// Exactly one of these is active at a time — see `setLabelled`.
    private var squareWidthConstraint: NSLayoutConstraint?
    private var labelledWidthConstraint: NSLayoutConstraint?

    init(title: String, symbol: String? = nil, danger: Bool = false) {
        super.init(frame: .zero)
        self.title = title
        configureMeetingControl(symbol: symbol, danger: danger)
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        configureMeetingControl(symbol: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// A click leaves the button first responder, and with Full Keyboard
    /// Access its focus ring stayed drawn, outside the bezel, until the window
    /// closed: the clicked controls looked outlined and taller than Mute,
    /// Camera and Leave. Hand focus back once the press is done;
    /// Tab still reaches every control with its ring.
    override func mouseDown(with event: NSEvent) {
        super.mouseDown(with: event)
        if window?.firstResponder === self {
            window?.makeFirstResponder(nil)
        }
    }

    /// Applies the shared in-meeting command-cell treatment. The caller still
    /// owns the action and any state-specific title or symbol.
    func configureMeetingControl(symbol: String?, danger: Bool = false) {
        controlSize = .large
        applyMeetControlStyle(
            base: danger ? StarlingsColors.danger : StarlingsColors.elevated,
            titleColor: danger ? .white : nil,
            height: Self.height
        )
        translatesAutoresizingMaskIntoConstraints = false
        setMeetingControlImage(symbol: symbol, accessibility: title)
        alignment = .center
        let existing = constraints.first {
            $0.firstAttribute == .height && $0.firstItem as? NSButton == self && $0.relation == .equal
        }
        if let existing {
            existing.constant = Self.height
        } else {
            heightAnchor.constraint(equalToConstant: Self.height).isActive = true
        }
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }

    /// Swaps the row's two densities. Icon-only pins to a fixed square:
    /// nothing about a bare glyph says how wide its button should be, and a
    /// row of differently-sized glyphs (a narrow mic, a wide two-up rectangle)
    /// reads as an unstyled row rather than one family of controls. Labelled
    /// is the same square, grown only when the word needs more — "Mute" and
    /// "Camera off" are supposed to be different widths, that's the word
    /// talking, but "You" is not supposed to be a sliver and "Share screen"
    /// is not supposed to touch its own bezel.
    ///
    /// Safe to call every layout pass: a repeat call with the same state and
    /// title changes nothing.
    func setLabelled(_ labelled: Bool) {
        let position: NSControl.ImagePosition = labelled ? .imageAbove : .imageOnly
        if imagePosition != position {
            imagePosition = position
        }
        imageHugsTitle = labelled
        if labelled {
            squareWidthConstraint?.isActive = false
            let wanted = labelledWidth
            if let existing = labelledWidthConstraint {
                if existing.constant != wanted { existing.constant = wanted }
                existing.isActive = true
            } else {
                labelledWidthConstraint = makeWidthConstraint(wanted)
            }
        } else {
            labelledWidthConstraint?.isActive = false
            if let existing = squareWidthConstraint {
                existing.isActive = true
            } else {
                squareWidthConstraint = makeWidthConstraint(Self.height)
            }
        }
    }

    private func makeWidthConstraint(_ constant: CGFloat) -> NSLayoutConstraint {
        let constraint = widthAnchor.constraint(equalToConstant: constant)
        // `.defaultHigh`, matching `applyMeetShoulder`: it wins over content
        // hugging but still yields rather than breaking layout outright if
        // the row is ever squeezed narrower than nine fixed squares.
        constraint.priority = .defaultHigh
        constraint.isActive = true
        return constraint
    }

    func setMeetingControlImage(symbol: String?, accessibility: String) {
        image = symbol.flatMap {
            NSImage(
                systemSymbolName: $0,
                accessibilityDescription: accessibility
            )?.withSymbolConfiguration(.init(pointSize: 16, weight: .semibold))
        }
        imageHugsTitle = true
        if imagePosition != .imageOnly {
            imagePosition = image == nil ? .noImage : .imageAbove
        }
    }

    /// Configures the small menu segment that shares a shell with a media
    /// command. It remains a member of the same family so its height, focus,
    /// and surface rules cannot drift from the button beside it.
    func configureMeetingChooser(label: String, target: AnyObject, action: Selector) {
        image = NSImage(
            systemSymbolName: "chevron.down",
            accessibilityDescription: label
        )?.withSymbolConfiguration(.init(pointSize: 9, weight: .bold))
        image?.isTemplate = true
        applyMeetControlStyle(height: Self.height)
        imagePosition = .imageOnly
        self.target = target
        self.action = action
        toolTip = label
        setAccessibilityLabel(label)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        widthAnchor.constraint(equalToConstant: Self.chooserWidth).isActive = true
    }
}

/// Draws the meeting control's glyph and word where the family wants them:
/// pushed apart by `imageTitleGap`, and shifted by half the button's
/// `companionWidth` so a control with a chevron riding beside it still reads
/// as centred on the shell the two share.
@MainActor
final class StarlingsMeetingControlCell: NSButtonCell {
    private var shift: CGFloat {
        ((controlView as? StarlingsMeetingControlButton)?.companionWidth ?? 0) / 2
    }

    private var stacked: Bool {
        imagePosition == .imageAbove
    }

    override func drawImage(_ image: NSImage, withFrame frame: NSRect, in controlView: NSView) {
        var frame = frame
        frame.origin.x += shift
        if stacked {
            let up = StarlingsMeetingControlButton.imageTitleGap
            frame.origin.y += controlView.isFlipped ? -up : up
        }
        super.drawImage(image, withFrame: frame, in: controlView)
    }

    override func drawTitle(_ title: NSAttributedString, withFrame frame: NSRect, in controlView: NSView) -> NSRect {
        var frame = frame
        frame.origin.x += shift
        if stacked {
            let down = StarlingsMeetingControlButton.imageTitleGap
            frame.origin.y += controlView.isFlipped ? down : -down
        }
        return super.drawTitle(title, withFrame: frame, in: controlView)
    }
}

extension NSButton {
    /// Gives a borderless button room either side of its own word.
    ///
    /// AppKit's bordered push button reserves about 20pt of shoulder; a
    /// borderless one reserves 4.7pt in total, so a Meet pill is drawn tight
    /// against its title and reads as a label someone tinted. No cell property
    /// exposes a horizontal inset, so the shoulder has to be a width the button
    /// asks for: whatever the title and its leading symbol already measure,
    /// plus the inset on both sides.
    ///
    /// `>=` at `defaultHigh` rather than `==` at `required`: it has to beat
    /// content hugging, which is what squeezes the title, while still yielding
    /// to a row that hands the button a width of its own — a footer button
    /// stretched to match its neighbour keeps the wider width, and a sheet
    /// dragged narrow bends instead of breaking.
    ///
    /// Call it last, once the title and image are set; re-titling a button that
    /// is already on screen re-measures rather than stacking a constraint.
    func applyMeetShoulder(inset: CGFloat = 14, minimumWidth: CGFloat = 0) {
        let wanted = max(minimumWidth, intrinsicContentSize.width + inset * 2)
        if let existing = objc_getAssociatedObject(self, meetShoulderConstraintKey) as? NSLayoutConstraint {
            existing.constant = wanted
            return
        }
        let constraint = widthAnchor.constraint(greaterThanOrEqualToConstant: wanted)
        constraint.priority = .defaultHigh
        constraint.isActive = true
        objc_setAssociatedObject(self, meetShoulderConstraintKey, constraint, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    }
}

enum SettingsChrome {
    static let groupCorner: CGFloat = StarlingsRadius.card
    static let rowInset = NSEdgeInsets(top: 11, left: 14, bottom: 11, right: 14)
    static let iconWellSize: CGFloat = 26

    /// The Home row (docs/DESIGN.md, "Home rows"): the one shell every row on
    /// the launch surface wears. Elevated on the card's panel, 1px border,
    /// radius `field`, 12 of padding (the caller's insets). `interactive`
    /// adds the hover lift and hairline — for a row that opens something,
    /// not for a tile you read. Web spells it `.home-row`; iOS `meetHomeRow()`.
    static let homeRowInset = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)

    static func applyHomeRow(_ view: NSView, interactive: Bool) {
        view.wantsLayer = true
        view.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: view).cgColor
        view.layer?.cornerRadius = StarlingsRadius.field
        view.layer?.cornerCurve = .continuous
        view.layer?.borderWidth = 1
        view.layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: view).cgColor
        view.layer?.masksToBounds = true
        if interactive {
            // Home rows keep their resting hairline under the pointer. A
            // brighter edge made one glance row read like a selection; the
            // lifted fill is enough feedback and leaves the border channel alone.
            view.applyMeetHoverLift(base: StarlingsColors.elevated)
        }
    }

    static func applyGroupSurface(_ view: NSView) {
        view.wantsLayer = true
        view.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.panel, for: view).cgColor
        view.layer?.cornerRadius = groupCorner
        view.layer?.borderWidth = 1
        view.layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: view).cgColor
        view.layer?.masksToBounds = true
        view.layer?.cornerCurve = .continuous
    }

    static func applySecondaryButton(
        _ button: NSButton,
        title: String? = nil,
        symbolName: String? = nil,
        height: CGFloat = 44
    ) {
        let title = title ?? button.title
        let font = NSFont.systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold)
        button.isBordered = false
        button.wantsLayer = true
        button.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: button).cgColor
        button.layer?.cornerRadius = StarlingsRadius.control(height: height)
        button.layer?.borderWidth = 1
        button.layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: button).cgColor
        button.layer?.cornerCurve = .continuous
        button.layer?.masksToBounds = true
        button.font = font
        if let cell = button.cell as? NSButtonCell {
            cell.highlightsBy = []
            cell.showsStateBy = []
        }
        button.applyMeetHoverLift(base: StarlingsColors.elevated, border: StarlingsColors.border)
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let displayTitle = symbolName == nil ? title : StarlingsFilledButton.leadingSymbolTitleGap + title
        button.attributedTitle = NSAttributedString(string: displayTitle, attributes: [
            .foregroundColor: StarlingsColors.primaryText,
            .font: font,
            .paragraphStyle: paragraph,
        ])
        if let symbolName,
           let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: title) {
            let config = NSImage.SymbolConfiguration(pointSize: 13, weight: .semibold)
            button.image = image.withSymbolConfiguration(config)
            button.imagePosition = .imageLeading
            button.imageHugsTitle = true
            button.contentTintColor = StarlingsColors.primaryText
        } else {
            button.image = nil
            button.imagePosition = .noImage
        }
        let existing = button.constraints.first {
            $0.firstAttribute == .height && $0.firstItem as? NSButton == button && $0.relation == .equal
        }
        if let existing {
            existing.constant = height
        } else {
            button.heightAnchor.constraint(equalToConstant: height).isActive = true
        }
        button.applyMeetShoulder()
    }

    /// Retitle a secondary button that is already on screen.
    ///
    /// `applySecondaryButton` installs hover tracking and a height constraint;
    /// calling it again just to change a word stacks a second tracking area on
    /// the button. This changes only what the button says, and the ink it says
    /// it in — accent when the word is carrying a count somebody should notice.
    static func setSecondaryButtonTitle(
        _ button: NSButton,
        _ title: String,
        symbol: Bool = true,
        color: NSColor = StarlingsColors.primaryText
    ) {
        let font = NSFont.systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold)
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        button.attributedTitle = NSAttributedString(
            string: symbol ? StarlingsFilledButton.leadingSymbolTitleGap + title : title,
            attributes: [.foregroundColor: color, .font: font, .paragraphStyle: paragraph]
        )
        if button.image != nil { button.contentTintColor = color }
        button.applyMeetShoulder()
    }

    /// Chromeless buttons — the icon-only and word-only ones tucked into a row or a
    /// header. They have no shell to lift, so hover gives them a well to sit in.
    static func applyQuietButton(_ button: NSButton, cornerRadius: CGFloat = 6) {
        button.isBordered = false
        // These are the buttons that live in rows — section headings, the
        // transcript disclosure, the readouts under the stage — which is
        // exactly where a squeezed title would otherwise stack vertically.
        button.applySingleLineTitle()
        button.applyMeetHoverLift(cornerRadius: cornerRadius)
        // Narrower than a pill's: these sit in headers and rows where the well
        // is the only chrome, and 14 either side would push their neighbours.
        button.applyMeetShoulder(inset: 8)
    }

    static func hairline() -> NSView {
        let line = NSView()
        line.wantsLayer = true
        line.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.border, for: line).cgColor
        line.translatesAutoresizingMaskIntoConstraints = false
        line.heightAnchor.constraint(equalToConstant: 1).isActive = true
        return line
    }
}

@MainActor
final class SettingsGroupView: NSView {
    private let stack = NSStackView()

    init(rows: [NSView] = []) {
        super.init(frame: .zero)
        SettingsChrome.applyGroupSurface(self)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 0
        addSubview(stack)
        stack.pinToEdges(of: self)
        setRows(rows)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setRows(_ rows: [NSView]) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for (index, row) in rows.enumerated() {
            if index > 0 {
                let separator = SettingsChrome.hairline()
                let wrap = NSView()
                wrap.addSubview(separator)
                NSLayoutConstraint.activate([
                    separator.leadingAnchor.constraint(equalTo: wrap.leadingAnchor, constant: 14),
                    separator.trailingAnchor.constraint(equalTo: wrap.trailingAnchor),
                    separator.topAnchor.constraint(equalTo: wrap.topAnchor),
                    separator.bottomAnchor.constraint(equalTo: wrap.bottomAnchor),
                ])
                stack.addArrangedSubview(wrap)
                wrap.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            }
            stack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
    }
}

@MainActor
final class SettingsInfoRow: NSView {
    private let dot = NSView()
    private let titleLabel: NSTextField
    private let detailLabel = StarlingsTypography.wrappingLabel("")
    private let trailingContainer = NSStackView()
    private var showsStatusDot: Bool

    init(title: String, showsStatusDot: Bool = true) {
        self.showsStatusDot = showsStatusDot
        titleLabel = NSTextField(labelWithString: title)
        super.init(frame: .zero)
        build(title: title)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func build(title: String) {
        titleLabel.stringValue = title
        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .medium)
        titleLabel.textColor = StarlingsColors.primaryText
        detailLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        detailLabel.textColor = StarlingsColors.secondaryText
        detailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        dot.wantsLayer = true
        dot.layer?.cornerRadius = 4
        dot.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.secondaryText, for: dot).cgColor
        dot.isHidden = !showsStatusDot

        trailingContainer.orientation = .horizontal
        trailingContainer.alignment = .centerY
        trailingContainer.spacing = 8

        let labels = NSStackView(views: [titleLabel, detailLabel])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 2

        let leading: [NSView] = showsStatusDot ? [dot, labels] : [labels]
        let row = NSStackView(views: leading + [NSView(), trailingContainer])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        addSubview(row)
        row.pinToEdges(of: self, insets: SettingsChrome.rowInset)

        NSLayoutConstraint.activate([
            dot.widthAnchor.constraint(equalToConstant: 8),
            dot.heightAnchor.constraint(equalToConstant: 8),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
            labels.widthAnchor.constraint(greaterThanOrEqualToConstant: 120),
        ])
        detailLabel.widthAnchor.constraint(equalTo: labels.widthAnchor).isActive = true
    }

    func update(state: PermissionState, detail: String) {
        detailLabel.stringValue = detail
        dot.layer?.borderWidth = 0
        titleLabel.textColor = StarlingsColors.primaryText
        switch state {
        case .allowed:
            // Connected, granted, signed in: the one state worth a colour.
            // The dot and the title both take the accent so the row reads
            // as live at a glance, not only on reading the detail line.
            dot.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.accent, for: dot).cgColor
            titleLabel.textColor = StarlingsColors.accent
        case .unknown:
            // Not-asked is a hollow ring, not just a dimmer fill, so it reads
            // as a distinct third state rather than a muted "allowed."
            dot.layer?.backgroundColor = NSColor.clear.cgColor
            dot.layer?.borderWidth = 1.5
            dot.layer?.borderColor = StarlingsColors.resolved(StarlingsColors.secondaryText, for: dot).cgColor
        case .denied, .restricted:
            dot.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.danger, for: dot).cgColor
        }
    }

    func setTrailing(_ view: NSView?) {
        trailingContainer.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if let view {
            trailingContainer.addArrangedSubview(view)
        }
    }

    func setTitle(_ title: String) {
        titleLabel.stringValue = title
    }
}

/// A Meet-owned switch instead of `NSSwitch`, whose on-state is always painted
/// with the user's macOS control accent (usually blue). The switch is deliberately
/// small and native-looking, but its state colour belongs to Meet's accent ramp.
@MainActor
final class StarlingsToggle: NSControl {
    var isOn = false {
        didSet {
            guard isOn != oldValue else { return }
            updateAccessibilityValue()
            needsDisplay = true
        }
    }

    private var isHovered = false

    override var intrinsicContentSize: NSSize {
        NSSize(width: 52, height: 30)
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.checkBox)
        updateAccessibilityValue()
        trackMeetHover(cursor: .pointingHand) { [weak self] hovered in
            self?.isHovered = hovered
            self?.needsDisplay = true
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        let trackRect = bounds.insetBy(dx: 1, dy: max(3, (bounds.height - 24) / 2))
        let trackColor: NSColor
        if isOn {
            trackColor = isHovered ? StarlingsColors.accentHover : StarlingsColors.accent
        } else {
            let resting = StarlingsColors.secondaryText.withAlphaComponent(0.38)
            trackColor = isHovered ? StarlingsColors.lifted(resting) : resting
        }
        let resolvedTrack = StarlingsColors.resolved(trackColor, for: self)
            .withAlphaComponent(isEnabled ? 1 : 0.45)
        resolvedTrack.setFill()
        NSBezierPath(
            roundedRect: trackRect,
            xRadius: trackRect.height / 2,
            yRadius: trackRect.height / 2
        ).fill()

        let thumbDiameter = trackRect.height - 4
        let thumbX = isOn
            ? trackRect.maxX - thumbDiameter - 2
            : trackRect.minX + 2
        let thumbRect = NSRect(
            x: thumbX,
            y: trackRect.midY - thumbDiameter / 2,
            width: thumbDiameter,
            height: thumbDiameter
        )
        // HIG: only the track changes colour. The thumb stays white in both
        // states, matching iOS's StarlingsToggleStyle.
        NSColor.white.withAlphaComponent(isEnabled ? 1 : 0.45).setFill()
        NSBezierPath(ovalIn: thumbRect).fill()
    }

    override var acceptsFirstResponder: Bool { true }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }
        window?.makeFirstResponder(self)
    }

    override func mouseUp(with event: NSEvent) {
        guard isEnabled, bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        toggle()
    }

    override func keyDown(with event: NSEvent) {
        guard event.keyCode == 36 || event.charactersIgnoringModifiers == " " else {
            super.keyDown(with: event)
            return
        }
        toggle()
    }

    private func toggle() {
        isOn.toggle()
        sendAction(action, to: target)
    }

    private func updateAccessibilityValue() {
        setAccessibilityValue(isOn ? String(localized: "On") : String(localized: "Off"))
    }
}

/// A `StarlingsToggle` with its label after it: the design system's
/// checkbox for a form. A system checkbox draws its empty box from the macOS
/// appearance, and on a dark sheet that box all but disappears (the New
/// Project dates, #1197). A click on the label switches it too.
@MainActor
final class StarlingsLabeledToggle: NSStackView {
    let toggle = StarlingsToggle()
    private let label = NSTextField(labelWithString: "")

    var isOn: Bool {
        get { toggle.isOn }
        set { toggle.isOn = newValue }
    }

    var title: String {
        get { label.stringValue }
        set {
            label.stringValue = newValue
            toggle.setAccessibilityLabel(newValue)
        }
    }

    init(title: String = "") {
        super.init(frame: .zero)
        orientation = .horizontal
        alignment = .centerY
        spacing = 8
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        label.textColor = StarlingsColors.primaryText
        toggle.setContentHuggingPriority(.required, for: .horizontal)
        label.setContentHuggingPriority(.required, for: .horizontal)
        label.addGestureRecognizer(NSClickGestureRecognizer(target: self, action: #selector(labelClicked)))
        addArrangedSubview(toggle)
        addArrangedSubview(label)
        self.title = title
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setAction(_ action: Selector, target: AnyObject?) {
        toggle.target = target
        toggle.action = action
    }

    @objc private func labelClicked() {
        guard toggle.isEnabled else { return }
        toggle.isOn.toggle()
        toggle.sendAction(toggle.action, to: toggle.target)
    }
}

@MainActor
final class SettingsToggleRow: NSView {
    private let iconView = NSImageView()
    private let titleLabel: NSTextField
    private let detailLabel = StarlingsTypography.wrappingLabel("")
    private let toggle = StarlingsToggle()
    var onChange: ((Bool) -> Void)?

    var isOn: Bool {
        get { toggle.isOn }
        set { toggle.isOn = newValue }
    }

    /// A row that cannot be switched right now: the switch stops taking
    /// clicks and the words dim, so the reason (another switch above it)
    /// reads from the page.
    var isEnabled: Bool {
        get { toggle.isEnabled }
        set {
            toggle.isEnabled = newValue
            alphaValue = newValue ? 1 : 0.5
        }
    }

    /// `image` is for marks we draw ourselves (the Starlings glyph); `symbolName` is
    /// the SF Symbol path. A row carries one or the other, image first.
    init(title: String, detail: String = "", symbolName: String? = nil, image: NSImage? = nil) {
        titleLabel = NSTextField(labelWithString: title)
        super.init(frame: .zero)
        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .medium)
        titleLabel.textColor = StarlingsColors.primaryText
        detailLabel.stringValue = detail
        detailLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        detailLabel.textColor = StarlingsColors.secondaryText
        detailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        detailLabel.isHidden = detail.isEmpty

        if let image {
            iconView.image = image
            iconView.imageScaling = .scaleProportionallyDown
            iconView.isHidden = false
        } else if let symbolName,
                  let symbol = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil) {
            let config = NSImage.SymbolConfiguration(pointSize: 14, weight: .medium)
            iconView.image = symbol.withSymbolConfiguration(config)
            iconView.contentTintColor = StarlingsColors.secondaryText
            iconView.isHidden = false
        } else {
            iconView.isHidden = true
        }
        iconView.setContentHuggingPriority(.required, for: .horizontal)

        toggle.setAccessibilityLabel(title)
        toggle.target = self
        toggle.action = #selector(toggled)
        toggle.setContentHuggingPriority(.required, for: .horizontal)

        let labels = NSStackView(views: [titleLabel, detailLabel])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 2

        var leading: [NSView] = []
        if !iconView.isHidden { leading.append(iconView) }
        leading.append(labels)
        let row = NSStackView(views: leading + [NSView(), toggle])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        addSubview(row)
        row.pinToEdges(of: self, insets: SettingsChrome.rowInset)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
            detailLabel.widthAnchor.constraint(equalTo: labels.widthAnchor),
            iconView.widthAnchor.constraint(equalToConstant: 20),
            iconView.heightAnchor.constraint(equalToConstant: 20),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setDetail(_ detail: String) {
        detailLabel.stringValue = detail
        detailLabel.isHidden = detail.isEmpty
    }

    @objc private func toggled() {
        onChange?(toggle.isOn)
    }
}

extension NSButton {
    /// Keep the checkbox mark on Meet's accent ramp without tinting the label.
    /// AppKit otherwise uses `controlAccentColor` for the mark and can make a
    /// checkbox look blue or disappear against a light surface. `mark` is the
    /// tick's colour; pass a neutral one where a column of accented ticks
    /// would compete with the rows that are meant to stand out.
    func applyMeetCheckboxStyle(mark: NSColor = StarlingsColors.accentMark) {
        let title = self.title
        let font = self.font ?? NSFont.systemFont(ofSize: StarlingsTypography.scaled(13))
        attributedTitle = NSAttributedString(string: title, attributes: [
            .font: font,
            .foregroundColor: StarlingsColors.primaryText,
        ])
        contentTintColor = mark
    }
}

@MainActor
final class SettingsActionRow: NSView {
    private let titleLabel: NSTextField
    private let detailLabel: NSTextField = NSTextField(labelWithString: "")
    private let chevron = NSImageView()
    var onClick: (() -> Void)?
    private(set) var isEnabled = true

    init(title: String, detail: String = "") {
        titleLabel = NSTextField(labelWithString: title)
        super.init(frame: .zero)
        wantsLayer = true
        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .medium)
        titleLabel.textColor = StarlingsColors.primaryText
        detailLabel.stringValue = detail
        detailLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        detailLabel.textColor = StarlingsColors.secondaryText
        detailLabel.isHidden = detail.isEmpty
        detailLabel.alignment = .right
        detailLabel.lineBreakMode = .byTruncatingMiddle
        detailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        if let image = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil) {
            let config = NSImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
            chevron.image = image.withSymbolConfiguration(config)
        }
        chevron.contentTintColor = StarlingsColors.secondaryText.withAlphaComponent(0.7)
        chevron.setContentHuggingPriority(.required, for: .horizontal)

        let row = NSStackView(views: [titleLabel, NSView(), detailLabel, chevron])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        addSubview(row)
        row.pinToEdges(of: self, insets: SettingsChrome.rowInset)
        heightAnchor.constraint(equalToConstant: 44).isActive = true

        // The row is the control — nothing inside it draws a shell, so the whole
        // strip picks up the well.
        applyMeetHoverLift()

        let click = NSClickGestureRecognizer(target: self, action: #selector(clicked))
        addGestureRecognizer(click)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setTitle(_ title: String) {
        titleLabel.stringValue = title
    }

    func setDetail(_ detail: String) {
        detailLabel.stringValue = detail
        detailLabel.isHidden = detail.isEmpty
    }

    func setEnabled(_ enabled: Bool) {
        isEnabled = enabled
        meetHoverMonitor?.isEnabled = enabled
        alphaValue = enabled ? 1 : 0.45
    }

    @objc private func clicked() {
        guard isEnabled else { return }
        onClick?()
    }
}

@MainActor
final class SettingsNavItemView: NSView {
    let pageTag: Int
    var onSelect: ((Int) -> Void)?

    private let iconWell = NSView()
    private let iconView = NSImageView()
    private let titleLabel: NSTextField
    private var selected = false
    private var isHovered = false

    init(tag: Int, title: String, symbolName: String) {
        self.pageTag = tag
        titleLabel = NSTextField(labelWithString: title)
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.cornerCurve = .continuous

        // The same well every rail row draws (`WorkGlyphMarkView`): a circle
        // on the elevated rung with a hairline, glyph in secondary ink, the
        // selected page's glyph in the accent mark. It used to be a filled
        // gray square with a white glyph — the one inverted tile in the app.
        iconWell.wantsLayer = true
        iconWell.layer?.cornerRadius = SettingsChrome.iconWellSize / 2
        iconWell.layer?.borderWidth = 1

        if let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: title) {
            let config = NSImage.SymbolConfiguration(pointSize: 12, weight: .semibold)
            iconView.image = image.withSymbolConfiguration(config)
        }
        iconView.contentTintColor = StarlingsColors.secondaryText
        iconView.imageScaling = .scaleProportionallyDown

        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .medium)
        titleLabel.textColor = StarlingsColors.primaryText
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        iconWell.addSubview(iconView)
        iconView.translatesAutoresizingMaskIntoConstraints = false

        let row = NSStackView(views: [iconWell, titleLabel, NSView()])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        addSubview(row)
        row.pinToEdges(of: self, insets: NSEdgeInsets(top: 5, left: 6, bottom: 5, right: 6))

        NSLayoutConstraint.activate([
            iconWell.widthAnchor.constraint(equalToConstant: SettingsChrome.iconWellSize),
            iconWell.heightAnchor.constraint(equalToConstant: SettingsChrome.iconWellSize),
            iconView.centerXAnchor.constraint(equalTo: iconWell.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: iconWell.centerYAnchor),
            iconView.widthAnchor.constraint(equalToConstant: 14),
            iconView.heightAnchor.constraint(equalToConstant: 14),
            heightAnchor.constraint(equalToConstant: 36),
        ])

        trackMeetHover { [weak self] hovered in
            self?.isHovered = hovered
            self?.refreshBackground()
        }

        let click = NSClickGestureRecognizer(target: self, action: #selector(clicked))
        addGestureRecognizer(click)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        refreshIconAppearance()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        refreshIconAppearance()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setSelected(_ isSelected: Bool) {
        selected = isSelected
        refreshBackground()
        refreshIconAppearance()
        // Keep selection out of the text metrics. A weight change alters glyph
        // widths and makes the navigation title shift when it is selected.
        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .medium)
        titleLabel.textColor = isSelected ? StarlingsColors.primaryText : StarlingsColors.secondaryText
    }

    /// Hover lifts from whatever the item's resting fill is, so the selected item
    /// still answers the pointer instead of looking stuck.
    private func refreshBackground() {
        let base: NSColor = selected ? StarlingsColors.elevated : .clear
        let resolvedBase = StarlingsColors.resolved(base, for: self)
        layer?.backgroundColor = (isHovered ? StarlingsColors.lifted(resolvedBase) : resolvedBase).cgColor
    }

    private func refreshIconAppearance() {
        iconWell.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: iconWell).cgColor
        iconWell.layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: iconWell).cgColor
        iconView.contentTintColor = StarlingsColors.resolved(
            selected ? StarlingsColors.accentMark : StarlingsColors.secondaryText, for: iconView
        )
    }

    @objc private func clicked() {
        onSelect?(pageTag)
    }
}

@MainActor
final class SettingsDevicePickerRow: NSView {
    private let titleLabel: NSTextField
    private let popup = NSPopUpButton(frame: .zero, pullsDown: false)
    var onSelectionChanged: ((String) -> Void)?

    init(title: String) {
        titleLabel = NSTextField(labelWithString: title)
        super.init(frame: .zero)
        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .medium)
        titleLabel.textColor = StarlingsColors.primaryText

        popup.bezelStyle = .rounded
        popup.controlSize = .regular
        popup.target = self
        popup.action = #selector(selectionChanged)
        popup.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let column = NSStackView(views: [titleLabel, popup])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 6
        addSubview(column)
        column.pinToEdges(of: self, insets: SettingsChrome.rowInset)
        NSLayoutConstraint.activate([
            popup.widthAnchor.constraint(equalTo: column.widthAnchor),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 64),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func reload(devices: [MediaDevice], symbolName: String, selectedID: String?) {
        let menu = NSMenu()
        let icon = Self.menuIcon(symbolName: symbolName)
        if devices.isEmpty {
            let item = NSMenuItem(title: String(localized: "No devices available"), action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
            popup.menu = menu
            popup.isEnabled = false
            return
        }

        for device in devices {
            let item = NSMenuItem(title: device.name, action: nil, keyEquivalent: "")
            item.image = icon
            item.representedObject = device.id
            menu.addItem(item)
        }
        popup.menu = menu
        popup.imagePosition = .imageLeading
        popup.isEnabled = true

        if let selectedID, let index = devices.firstIndex(where: { $0.id == selectedID }) {
            popup.selectItem(at: index)
        } else {
            popup.selectItem(at: 0)
        }
    }

    private static func menuIcon(symbolName: String) -> NSImage? {
        guard let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil) else {
            return nil
        }
        let configured = image.withSymbolConfiguration(
            NSImage.SymbolConfiguration(pointSize: 12, weight: .medium)
        )
        configured?.isTemplate = true
        return configured
    }

    @objc private func selectionChanged() {
        guard let id = popup.selectedItem?.representedObject as? String else { return }
        onSelectionChanged?(id)
    }
}

/// A labelled popup over a fixed set of choices. Unlike the device picker,
/// the options are known up front and never reload.
@MainActor
final class SettingsChoiceRow: NSView {
    private let popup = NSPopUpButton(frame: .zero, pullsDown: false)
    var onSelect: ((Int) -> Void)?

    /// A choice that a switch above it governs greys out with it.
    var isEnabled: Bool {
        get { popup.isEnabled }
        set { popup.isEnabled = newValue }
    }

    init(title: String, options: [String], selectedIndex: Int) {
        let titleLabel = NSTextField(labelWithString: title)
        super.init(frame: .zero)
        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .medium)
        titleLabel.textColor = StarlingsColors.primaryText

        popup.bezelStyle = .rounded
        popup.controlSize = .regular
        popup.target = self
        popup.action = #selector(selectionChanged)
        popup.setContentHuggingPriority(.required, for: .horizontal)
        popup.addItems(withTitles: options)
        if options.indices.contains(selectedIndex) {
            popup.selectItem(at: selectedIndex)
        }

        // Title on the left, control on the right: the same list row as
        // `SettingsToggleRow`, with a popup where the switch would be.
        let row = NSStackView(views: [titleLabel, NSView(), popup])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        addSubview(row)
        row.pinToEdges(of: self, insets: SettingsChrome.rowInset)
        NSLayoutConstraint.activate([
            popup.widthAnchor.constraint(greaterThanOrEqualToConstant: 140),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func select(_ index: Int) {
        guard popup.numberOfItems > index, index >= 0 else { return }
        popup.selectItem(at: index)
    }

    @objc private func selectionChanged() {
        onSelect?(popup.indexOfSelectedItem)
    }
}

/// A settings row you type into. It commits on Return rather than per
/// keystroke, because what sits behind one of these is a lookup and not a
/// stored string — the detail line underneath is where the lookup answers.
@MainActor
final class SettingsTextEntryRow: NSView {
    private let field: StarlingsTextField
    private let detailLabel = StarlingsTypography.wrappingLabel("")
    var onCommit: ((String) -> Void)?

    var text: String {
        get { field.stringValue }
        set { field.stringValue = newValue }
    }

    init(title: String, placeholder: String, detail: String = "") {
        field = StarlingsTextField(placeholder: placeholder)
        super.init(frame: .zero)

        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .medium)
        titleLabel.textColor = StarlingsColors.primaryText

        field.target = self
        field.action = #selector(commit)

        detailLabel.stringValue = detail
        detailLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        detailLabel.textColor = StarlingsColors.secondaryText
        detailLabel.isHidden = detail.isEmpty
        detailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        // Title and detail on the left, the field on the right: the same
        // list row as `SettingsToggleRow`, with a field where the switch is.
        let labels = NSStackView(views: [titleLabel, detailLabel])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 2
        field.setContentHuggingPriority(.required, for: .horizontal)

        let row = NSStackView(views: [labels, NSView(), field])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        addSubview(row)
        row.pinToEdges(of: self, insets: SettingsChrome.rowInset)
        NSLayoutConstraint.activate([
            field.widthAnchor.constraint(equalToConstant: 200),
            labels.widthAnchor.constraint(greaterThanOrEqualToConstant: 120),
            detailLabel.widthAnchor.constraint(equalTo: labels.widthAnchor),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setDetail(_ detail: String) {
        detailLabel.stringValue = detail
        detailLabel.isHidden = detail.isEmpty
    }

    @objc private func commit() {
        onCommit?(field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

@MainActor
final class SettingsAudioMeterRow: NSView {
    private let titleLabel = NSTextField(labelWithString: String(localized: "Input level"))
    private let testButton = NSButton(title: String(localized: "Test microphone"), target: nil, action: nil)
    private let barsStack = NSStackView()
    private let statusLabel = NSTextField(labelWithString: String(localized: "Speak to check input"))
    private var bars: [NSView] = []
    private let monitor = MicrophoneLevelMonitor()
    private var currentDeviceID: String?

    private static let barCount = 12

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        build()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setDeviceID(_ deviceID: String?) {
        currentDeviceID = deviceID
        if monitor.isActive {
            monitor.start(deviceID: deviceID)
        }
    }

    func stop() {
        monitor.stop()
        applyTestingUI(active: false)
        applyLevel(0)
    }

    private func build() {
        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .medium)
        titleLabel.textColor = StarlingsColors.primaryText

        statusLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        statusLabel.textColor = StarlingsColors.secondaryText

        SettingsChrome.applySecondaryButton(testButton, title: String(localized: "Test microphone"))
        testButton.target = self
        testButton.action = #selector(toggleTest)
        testButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 140).isActive = true

        barsStack.orientation = .horizontal
        barsStack.alignment = .centerY
        barsStack.spacing = 3
        barsStack.translatesAutoresizingMaskIntoConstraints = false

        for _ in 0..<Self.barCount {
            let bar = NSView()
            bar.wantsLayer = true
            bar.layer?.cornerRadius = 2
            bar.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: bar).cgColor
            bar.translatesAutoresizingMaskIntoConstraints = false
            bar.widthAnchor.constraint(equalToConstant: 8).isActive = true
            bar.heightAnchor.constraint(equalToConstant: 18).isActive = true
            bars.append(bar)
            barsStack.addArrangedSubview(bar)
        }

        let meterRow = NSStackView(views: [testButton, barsStack, NSView()])
        meterRow.orientation = .horizontal
        meterRow.alignment = .centerY
        meterRow.spacing = 12

        let column = NSStackView(views: [titleLabel, meterRow, statusLabel])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 8
        addSubview(column)
        column.pinToEdges(of: self, insets: SettingsChrome.rowInset)

        monitor.onLevel = { [weak self] level in
            self?.applyLevel(level)
        }
        monitor.onError = { [weak self] message in
            self?.applyTestingUI(active: false)
            self?.statusLabel.stringValue = message
            self?.statusLabel.textColor = StarlingsColors.danger
        }

        NSLayoutConstraint.activate([
            meterRow.widthAnchor.constraint(equalTo: column.widthAnchor),
            statusLabel.widthAnchor.constraint(equalTo: column.widthAnchor),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 84),
        ])
    }

    @objc private func toggleTest() {
        if monitor.isActive {
            stop()
            statusLabel.stringValue = String(localized: "Speak to check input")
            statusLabel.textColor = StarlingsColors.secondaryText
            return
        }
        statusLabel.textColor = StarlingsColors.secondaryText
        statusLabel.stringValue = String(localized: "Listening… speak into your mic")
        applyTestingUI(active: true)
        monitor.start(deviceID: currentDeviceID)
    }

    private func applyTestingUI(active: Bool) {
        SettingsChrome.applySecondaryButton(
            testButton,
            title: active ? String(localized: "Stop test") : String(localized: "Test microphone")
        )
    }

    private func applyLevel(_ level: Float) {
        let lit = Int((level * Float(Self.barCount)).rounded(.down))
        for (index, bar) in bars.enumerated() {
            let active = index < lit
            if active {
                let hot = index >= Self.barCount - 2
                bar.layer?.backgroundColor = (hot ? StarlingsColors.danger : StarlingsColors.accent).cgColor
            } else {
                bar.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: bar).cgColor
            }
        }
    }
}

// MARK: - Segmented control

/// A row of choices where the chosen one is an accent pill.
///
/// Not `NSSegmentedControl`: its `selectedSegmentBezelColor` tints whichever
/// segment was selected when the color was set and never any segment chosen
/// afterward (see `WorkPaneButton`), so every "active tab" in the app drifted
/// to system blue. Plain buttons colored here have no such stale state. The
/// API mirrors the subset of `NSSegmentedControl` the app uses, so a site
/// swaps the type and drops its `segmentStyle` line.
@MainActor
final class StarlingsSegmentedControl: NSView {
    static let height: CGFloat = 28

    weak var target: AnyObject?
    var action: Selector?

    private let stack = NSStackView()
    private var buttons: [NSButton] = []
    private var widths: [Int: CGFloat] = [:]

    var isEnabled = true {
        didSet {
            for button in buttons { button.isEnabled = isEnabled }
            alphaValue = isEnabled ? 1 : 0.5
        }
    }

    var selectedSegment: Int = -1 {
        didSet { refreshChrome() }
    }

    var segmentCount: Int {
        get { buttons.count }
        set { rebuild(labels: (0..<max(0, newValue)).map { $0 < buttons.count ? buttons[$0].title : "" }) }
    }

    init(labels: [String]) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerCurve = .continuous
        layer?.borderWidth = 1
        stack.orientation = .horizontal
        stack.distribution = .fillEqually
        stack.spacing = 2
        stack.edgeInsets = NSEdgeInsets(top: 2, left: 2, bottom: 2, right: 2)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            heightAnchor.constraint(equalToConstant: Self.height),
        ])
        setAccessibilityRole(.radioGroup)
        rebuild(labels: labels)
        refreshChrome()
    }

    /// Signature-compatible with `NSSegmentedControl`; tracking is always
    /// select-one.
    convenience init(labels: [String], trackingMode: NSSegmentedControl.SwitchTracking, target: AnyObject?, action: Selector?) {
        self.init(labels: labels)
        self.target = target
        self.action = action
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setLabel(_ label: String, forSegment index: Int) {
        guard buttons.indices.contains(index) else { return }
        buttons[index].title = label
        refreshChrome()
    }

    func setEnabled(_ enabled: Bool, forSegment index: Int) {
        guard buttons.indices.contains(index) else { return }
        buttons[index].isEnabled = enabled && isEnabled
    }

    /// A fixed width for one segment; the row stops filling equally.
    func setWidth(_ width: CGFloat, forSegment index: Int) {
        widths[index] = width
        stack.distribution = .fill
        guard buttons.indices.contains(index) else { return }
        buttons[index].widthAnchor.constraint(equalToConstant: width).isActive = true
    }

    private func rebuild(labels: [String]) {
        for button in buttons { stack.removeArrangedSubview(button); button.removeFromSuperview() }
        buttons = labels.enumerated().map { index, label in
            let button = NSButton(title: label, target: self, action: #selector(segmentClicked(_:)))
            button.tag = index
            button.isBordered = false
            button.wantsLayer = true
            button.layer?.cornerCurve = .continuous
            button.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .medium)
            (button.cell as? NSButtonCell)?.highlightsBy = []
            button.setAccessibilityRole(.radioButton)
            button.isEnabled = isEnabled
            // The stack centers its buttons vertically, so without this the
            // pill is only as tall as the title and floats inside the track.
            button.heightAnchor.constraint(equalToConstant: Self.height - 4).isActive = true
            // The pill repaints from `refreshChrome`, so hover only asks for
            // a repaint and the fill is decided there with the selection.
            button.trackMeetHover { [weak self] _ in self?.refreshChrome() }
            return button
        }
        for button in buttons { stack.addArrangedSubview(button) }
        for (index, width) in widths where buttons.indices.contains(index) {
            buttons[index].widthAnchor.constraint(equalToConstant: width).isActive = true
        }
    }

    @objc private func segmentClicked(_ sender: NSButton) {
        guard sender.tag != selectedSegment else { return }
        selectedSegment = sender.tag
        if let action { NSApp.sendAction(action, to: target, from: self) }
    }

    override func layout() {
        super.layout()
        layer?.cornerRadius = bounds.height / 2
        for button in buttons { button.layer?.cornerRadius = button.bounds.height / 2 }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        refreshChrome()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        refreshChrome()
    }

    private func refreshChrome() {
        layer?.backgroundColor = StarlingsColors.fieldGround(for: self, base: StarlingsColors.elevated)
        layer?.borderColor = StarlingsColors.hairline(for: self, hovered: false)
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        for (index, button) in buttons.enumerated() {
            let selected = index == selectedSegment
            // A disabled segment that lights up reads as clickable.
            let hovered = button.isEnabled && (button.meetHoverMonitor?.isHovered ?? false)
            button.setAccessibilityValue(selected)
            // The selected pill is an accent fill, so it hovers to the named
            // brighter accent; the rest lift from clear to the veil.
            let fill: NSColor = selected
                ? (hovered ? StarlingsColors.accentHover : StarlingsColors.accent)
                : (hovered ? StarlingsColors.lifted(.clear) : .clear)
            button.layer?.backgroundColor = StarlingsColors.resolved(fill, for: self).cgColor
            button.attributedTitle = NSAttributedString(
                string: button.title,
                attributes: [
                    .foregroundColor: StarlingsColors.resolved(selected ? StarlingsColors.accentInk : StarlingsColors.primaryText, for: self),
                    .font: button.font as Any,
                    .paragraphStyle: paragraph,
                ]
            )
        }
    }
}

// MARK: - Panel header

/// The header row of a Home panel: an uppercase title, an optional count,
/// and one quiet action in a fixed trailing slot. Quick Notes' +, the waiting
/// room's copy-link, anything that comes later — same size, same place, so
/// the eye finds the action at the same spot on every panel. The row keeps
/// the slot's height even with no action, so titles line up across panels.
@MainActor
enum StarlingsPanelHeader {
    static let actionSize: CGFloat = 30

    static func actionButton(
        symbolName: String,
        accessibilityLabel: String,
        target: AnyObject?,
        action: Selector?
    ) -> NSButton {
        let button = NSButton(image: NSImage(), target: target, action: action)
        setSymbol(symbolName, on: button, accessibilityLabel: accessibilityLabel)
        button.imagePosition = .imageOnly
        button.bezelStyle = .inline
        SettingsChrome.applyQuietButton(button, cornerRadius: actionSize / 2)
        button.contentTintColor = StarlingsColors.secondaryText
        button.toolTip = accessibilityLabel
        button.setAccessibilityLabel(accessibilityLabel)
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(equalToConstant: actionSize),
            button.heightAnchor.constraint(equalToConstant: actionSize),
        ])
        return button
    }

    /// Swap the glyph (copy → checkmark after a copy, say) without touching the chrome.
    static func setSymbol(_ symbolName: String, on button: NSButton, accessibilityLabel: String? = nil) {
        button.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: accessibilityLabel)?
            .withSymbolConfiguration(.init(pointSize: 13, weight: .semibold))
    }

    static func row(title: NSTextField, count: NSTextField? = nil, action: NSView? = nil) -> NSStackView {
        var views: [NSView] = [title, NSView()]
        if let count { views.append(count) }
        if let action { views.append(action) }
        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.heightAnchor.constraint(equalToConstant: actionSize).isActive = true
        return row
    }
}

// MARK: - Field well

/// `StarlingsTextField`'s well for something that is not a text field: a
/// multi-line notes editor, say. Fill, hairline and radius from the same
/// constants, recoloured when the appearance changes, and the content pinned
/// inside the border. Used where a scroll view would otherwise have to carry
/// the chrome — NSScrollView repaints its own layer and drops it.
final class StarlingsFieldWell: NSView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = StarlingsTextField.fieldCornerRadius
        layer?.cornerCurve = .continuous
        layer?.borderWidth = StarlingsTextField.borderWidth
        layer?.masksToBounds = true
        translatesAutoresizingMaskIntoConstraints = false
        recolour()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func embed(_ content: NSView) {
        addSubview(content)
        content.translatesAutoresizingMaskIntoConstraints = false
        let inset = StarlingsTextField.borderWidth
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: leadingAnchor, constant: inset),
            content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -inset),
            content.topAnchor.constraint(equalTo: topAnchor, constant: inset),
            content.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -inset),
        ])
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        recolour()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        recolour()
    }

    private func recolour() {
        layer?.backgroundColor = StarlingsColors.fieldGround(for: self)
        layer?.borderColor = StarlingsColors.hairline(for: self, hovered: false)
    }
}

// MARK: - Glass, the floating layer

/// Liquid Glass on macOS 26, the opaque panel rung below it — the Mac twin of
/// iOS's `meetFloatingGlass` (docs/DESIGN.md, "Glass — the floating layer").
/// Glass is for what floats over content: the calendar's overlay inspector,
/// the toast, the Search panel, the in-call Chat window. Sidebars, columns,
/// split-item inspectors, Settings, cards and lists never wear it. Glass
/// never sits on glass, never carries state, and needs something under it:
/// a glass shape stands off the edges of what it floats over.
///
/// Every site keeps its opaque construction as the fallback and asks here
/// for the glass one; that is what keeps 14 and 26 one product.
@MainActor
enum StarlingsFloatingGlass {
    /// How far a wrapped panel leans toward its rung. 0 is clear glass;
    /// 1 is the opaque panel, at which point it is not glass.
    static let panelTint: CGFloat = 0.45

    /// `content` wrapped in glass of `cornerRadius`, or nil below macOS 26 —
    /// the caller then installs `content` on its own ground. `content`'s
    /// own ground must be clear for the glass to show; a `StarlingsShellBackdrop`
    /// is cleared here, anything else is the caller's.
    static func wrap(_ content: NSView, cornerRadius: CGFloat) -> NSView? {
        guard #available(macOS 26.0, *) else { return nil }
        (content as? StarlingsShellBackdrop)?.ground = .clear
        let glass = NSGlassEffectView()
        glass.cornerRadius = cornerRadius
        // A panel is read in, so it leans toward its rung: the panel colour
        // at this alpha darkens the glass in dark and lightens it in light,
        // and either way it shows less of what is under it. Untinted, the
        // grid read through the form.
        glass.tintColor = StarlingsColors.panel.withAlphaComponent(panelTint)
        glass.contentView = content
        return glass
    }

    /// A badge over video — a tile's name, a share mark, the stage readout,
    /// the self-view's own two buttons: glass on macOS 26, the 0.55 black
    /// scrim below it. The glass is a sublayer behind the badge's own
    /// drawing (`zPosition` -1), so a label or button keeps drawing itself
    /// and the caller's constraints stay as they are; it takes no clicks.
    /// A badge that carries state, like the raised hand, stays solid.
    static func scrim(_ badge: NSView, cornerRadius: CGFloat) {
        badge.wantsLayer = true
        badge.layer?.cornerRadius = cornerRadius
        guard #available(macOS 26.0, *) else {
            badge.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.55).cgColor
            return
        }
        badge.layer?.backgroundColor = nil
        let glass = StarlingsGlassScrim()
        glass.cornerRadius = cornerRadius
        badge.addSubview(glass, positioned: .below, relativeTo: nil)
        glass.pinToEdges(of: badge)
        glass.layer?.zPosition = -1
    }

    /// `scrim` for a button over video — the self-view's and a tile's own.
    /// The scrim is the resting fill the button lifts from, so it answers the
    /// pointer like any other control: the black scrim below 26, the veil over
    /// the glass on it.
    static func scrimButton(_ button: NSButton, cornerRadius: CGFloat) {
        scrim(button, cornerRadius: cornerRadius)
        let base = button.layer?.backgroundColor.flatMap { NSColor(cgColor: $0) } ?? .clear
        button.applyMeetHoverLift(base: base, cornerRadius: cornerRadius)
    }

    /// A floating window on glass: the frame goes clear and `content` sits in
    /// glass as the window's content view. Below 26 the window keeps its
    /// panel ground and `content` is installed as it was. Returns whether
    /// glass was used, so the caller can drop a border or shadow the glass
    /// already draws.
    @discardableResult
    static func dress(_ window: NSWindow, content: NSView, cornerRadius: CGFloat) -> Bool {
        guard let glass = wrap(content, cornerRadius: cornerRadius) else {
            window.contentView = content
            return false
        }
        window.backgroundColor = .clear
        window.isOpaque = false
        window.contentView = glass
        return true
    }
}

/// Glass that lets the badge above it take the click.
@available(macOS 26.0, *)
private final class StarlingsGlassScrim: NSGlassEffectView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
