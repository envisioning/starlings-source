import Foundation

/// The active workspace's accent shades (docs/TENANCY_READINESS.md
/// §Brand rule). The Worker derives every shade from the one colour a
/// workspace names (`accentPalette` in packages/contracts/src/workspace-accent.ts)
/// and sends them in the descriptor's `accent_palette`; the apps read them
/// and never copy the rule. A workspace with no accent, Envisioning among
/// them, keeps the product's own lime.
///
/// Read at every resolve: the Mac's and the phone's accent colours are
/// dynamic, and a change of workspace rebuilds the app (slice E) anyway.
enum WorkspaceAccent {
    enum Shade {
        /// The fill a call to action sits on, and its pointer states.
        case fill, hover, down
        /// What sits on the fill.
        case ink
        /// The accent as a mark: a glyph, a dot, a today ring.
        case mark
        /// A ring that shows on the light canvas.
        case focus
    }

    typealias RGB = (red: Double, green: Double, blue: Double)

    /// The shade in sRGB, 0 to 1, or nil to keep the product's own colour.
    static func rgb(_ shade: Shade, dark: Bool) -> RGB? {
        guard let palette = StarlingsWorkspace.active.accentPalette else { return nil }
        let hex = switch shade {
        case .fill: dark ? palette.dark.accent : palette.light.cta
        case .hover: dark ? palette.dark.hover : palette.light.ctaHover
        case .down: dark ? palette.dark.down : palette.light.ctaDown
        case .ink: palette.dark.onAccent
        case .mark: dark ? palette.dark.accent : palette.light.mark
        case .focus: dark ? palette.dark.accent : palette.light.focus
        }
        return parse(hex)
    }

    /// `#rrggbb`, or nil.
    static func parse(_ hex: String) -> RGB? {
        let digits = hex.hasPrefix("#") ? hex.dropFirst() : Substring(hex)
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
        return (
            Double((value >> 16) & 0xff) / 255,
            Double((value >> 8) & 0xff) / 255,
            Double(value & 0xff) / 255
        )
    }
}
