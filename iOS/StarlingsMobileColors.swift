import EnvisioningUI
import SwiftUI
import UIKit

/// Shared by the app and the Live Activity widget extension, which cannot see
/// the rest of `StarlingsMobileDesign` (WidgetKit rejects `Canvas`, so `StarlingsGlyphMark`
/// stays app-only).
enum StarlingsMobileColors {
    // The surface ladder is the estate's (`EnvisioningSurface`),
    // shared with the Mac and with CoreCRMUI; these names stay so call sites
    // keep reading naturally.
    static let canvas = EnvisioningSurface.canvas
    static let panel = EnvisioningSurface.panel
    static let elevated = EnvisioningSurface.elevated
    static let field = EnvisioningSurface.field
    static let border = contrasting(.border, alpha: 0.55)
    static let borderHover = contrasting(.borderHover, alpha: 0.8)
    static let primary = EnvisioningSurface.primaryText
    static let secondary = contrasting(.secondaryText, alpha: nil)

    /// Increase Contrast (Settings → Accessibility → Display & Text Size).
    /// The hairlines that encode depth at 10% become lines of ink at `alpha`;
    /// with `alpha` nil the token becomes the primary ink itself. The same
    /// values `StarlingsColors` uses on the Mac and the web's
    /// `prefers-contrast: more` block. Read from the trait collection, so it
    /// follows the switch live and works in the widget extension too.
    private static func contrasting(_ token: EnvisioningSurface.Token, alpha: CGFloat?) -> Color {
        Color(uiColor: UIColor { traits in
            let base = EnvisioningSurface.uiColor(token).resolvedColor(with: traits)
            guard traits.accessibilityContrast == .high else { return base }
            let ink = EnvisioningSurface.uiColor(.primaryText).resolvedColor(with: traits)
            return alpha.map { ink.withAlphaComponent($0) } ?? ink
        })
    }
    // The brand values live in EnvisioningUI, which CORE consumes too.
    //
    // The accent is one colour per scheme: the lime `#d6f249` on the dark
    // canvas, `#aacc00` on the light one — as a fill, as ink, as a dot. The
    // lime on a white page reads as a highlighter laid over it (and as ink
    // measures 1.26:1), so light steps the whole ramp down. The package's
    // `foreground` is exactly that pair; `fill` alone is the dark half and
    // is not adaptive, which is why it is not the alias here.
    /// A role of the accent, for `accentResolver`.
    enum AccentRole: Sendable {
        case fill, hover, down, ink, mark, focus
    }

    /// The workspace's shade for a role and appearance, in sRGB 0 to 1, or
    /// nil for the product's own. The app sets it at launch to the active
    /// workspace's palette (`WorkspaceAccent`). The widgets leave it nil;
    /// they read the app group's copy instead (`WidgetAccent`, `WidgetInk`).
    nonisolated(unsafe) static var accentResolver: (@Sendable (AccentRole, Bool) -> (red: Double, green: Double, blue: Double)?)?

    static let accent = Color(uiColor: accentUIColor)
    /// What sits on an accent fill: `#1a1a1a` in both appearances, the web's
    /// `--on-accent` and the Mac's `accentInk`. The package's
    /// `EnvisioningAccent.ink` is pure black and is Core's; Meet's three
    /// clients agree on this one.
    static let accentInk = workspace(.ink, dark: (26.0 / 255, 26.0 / 255, 26.0 / 255), light: (26.0 / 255, 26.0 / 255, 26.0 / 255))
    /// `accent` for UIKit appearance proxies. `UIColor(Color)` flattens a
    /// dynamic colour to the trait in force when it is called, so a proxy
    /// set at launch would freeze one scheme; this stays dynamic.
    /// The active workspace's accent when it names one (`accentResolver`).
    static let accentUIColor = UIColor { traits in
        let dark = traits.userInterfaceStyle == .dark
        if let rgb = accentResolver?(.fill, dark) {
            return UIColor(red: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
        }
        return UIColor(dark ? EnvisioningAccent.foregroundOnDark : EnvisioningAccent.foregroundOnLight)
    }
    /// One step up under the pointer: `#e0f76f` dark, `#bfe000` light.
    static let accentHover = workspace(.hover, dark: (0.878, 0.969, 0.435), light: (0.749, 0.878, 0.000))
    /// Pressed: `#aacc00` dark, `#91ad00` light. Light rests on the dark
    /// pressed value, so its own press is one rung further.
    static let accentPressed = workspace(.down, dark: (0.667, 0.800, 0.000), light: (0.569, 0.678, 0.000))
    /// The accent as *ink*. The same colour as `accent` now that the accent
    /// is adaptive; kept so a call site can still say which job it is doing.
    /// The Mac's `StarlingsColors.accentMark`, the web's `--accent-mark`.
    static let accentMark = Color(uiColor: UIColor { traits in
        let dark = traits.userInterfaceStyle == .dark
        // A workspace's own accent: its mark, and under Increase Contrast on
        // a light page the ring shade that clears 3:1 on the canvas.
        if let rgb = accentResolver?(traits.accessibilityContrast == .high ? .focus : .mark, dark) {
            return UIColor(red: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
        }
        let base = dark ? EnvisioningAccent.foregroundOnDark : EnvisioningAccent.foregroundOnLight
        // As ink on a light page the lime measures 1.85:1. Under Increase
        // Contrast it steps to the olive the web's focus ring uses, `#6d8500`,
        // the first rung of the ramp that reads as text. Dark keeps the lime:
        // `#d6f249` on the dark canvas already clears 12:1.
        guard traits.accessibilityContrast == .high, traits.userInterfaceStyle != .dark else { return UIColor(base) }
        return UIColor(red: 0.427, green: 0.522, blue: 0.000, alpha: 1)
    })
    /// A chosen row, day, or "mine" bubble: a neutral step, not an accent
    /// veil. A lime tint under a whole row spends the accent on a state that
    /// is not a call to action, and on a light page it reads as a marker
    /// pen. Web's `--selected`: `#3f414d` dark, one rung above Elevated on the
    /// same hue, and `#dcdcdc` light (`fixtures/color-tokens.json`).
    static let selected = adaptive(dark: (63.0 / 255, 65.0 / 255, 77.0 / 255), light: (220.0 / 255, 220.0 / 255, 220.0 / 255))

    /// `adaptive`, with the active workspace's shade in place of the
    /// product's own when the workspace names an accent.
    private static func workspace(_ shade: AccentRole, dark: (Double, Double, Double), light: (Double, Double, Double)) -> Color {
        Color(uiColor: UIColor { traits in
            let isDark = traits.userInterfaceStyle == .dark
            let v = accentResolver?(shade, isDark).map { ($0.red, $0.green, $0.blue) } ?? (isDark ? dark : light)
            return UIColor(red: v.0, green: v.1, blue: v.2, alpha: 1)
        })
    }

    private static func adaptive(dark: (Double, Double, Double), light: (Double, Double, Double)) -> Color {
        Color(uiColor: UIColor { traits in
            let v = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: v.0, green: v.1, blue: v.2, alpha: 1)
        })
    }
    /// One rung up the surface ladder — the shared hover step. Composited as a
    /// white veil so a call site never has to name the colour it is lifting.
    static let hoverLift = EnvisioningSurface.hoverLift
    /// One fixed danger red across appearances and clients. Alpha and the
    /// surface underneath provide soft treatments without another red token.
    static let danger = StarlingsSemanticColors.danger
    /// Presence "busy" — a fixed shade of the accent ramp, not a hue of its
    /// own (see `docs/DESIGN.md`'s "The accent budget"). Same value dark and
    /// light, matching how `CalendarLayerPalette`'s shades are also
    /// non-adaptive lime tones.
    static let presenceBusy = Color(.sRGB, red: 0.612, green: 0.749, blue: 0.180, opacity: 1)
    /// Presence "in a meeting" — the other fixed shade of the accent ramp.
    static let presenceInMeeting = Color(.sRGB, red: 0.400, green: 0.486, blue: 0.290, opacity: 1)
    /// The calendar grid's background ladder — one channel for "how much does
    /// this time matter". Two rungs: a weekend, and every other day. Mirrors
    /// `CalendarGridInk.rungOff/rungDay`.
    static let rungOff = field
    static let rungDay = panel
}
