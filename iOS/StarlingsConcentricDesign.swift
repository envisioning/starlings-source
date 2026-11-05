import SwiftUI
import EnvisioningUI

/// The Envisioning corner scale, drawn as a fixed continuous radius.
///
/// This started as iOS 26's `ConcentricRectangle(corners: .concentric(minimum:))`
/// with the fixed radius as the pre-26 fallback. On device the concentric
/// shape rendered square for any control that sits farther inside its
/// container than the container's own radius — which is every field and
/// button in Meet, since cards pad by 16–28 and the card radius is 18. The
/// `minimum` did not floor it (first-run card, September 2026). The fixed
/// scale is what the design asks for in that geometry anyway, so it is now
/// the contract on every OS version. `fallbackRadius` keeps its name so the
/// call sites did not have to change.
struct StarlingsConcentricFill<Style: ShapeStyle>: View {
    let style: Style
    let fallbackRadius: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: fallbackRadius, style: .continuous)
            .fill(style)
    }
}

struct StarlingsConcentricStroke<Style: ShapeStyle>: View {
    let style: Style
    let fallbackRadius: CGFloat
    let lineWidth: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: fallbackRadius, style: .continuous)
            .stroke(style, lineWidth: lineWidth)
    }
}

/// Local iOS button styles keep the shared Envisioning typography and accent
/// ramp while allowing the button shell to use Apple's concentric geometry.
/// The package styles predate the iOS 26 shape APIs and intentionally remain
/// unchanged for the Mac client.
///
/// Every button on iOS wears one of these two. The system `.bordered` and
/// `.borderedProminent` styles carry their own radius and their own gray, so
/// a row of them next to a Meet field reads as two products. `.compact` is
/// the inline size for a row of actions inside a card or a chip.
struct StarlingsFilledButtonStyle: ButtonStyle {
    let minHeight: CGFloat
    let expands: Bool
    let font: Font

    init(minHeight: CGFloat = 48, expands: Bool = true, font: Font = .headline) {
        self.minHeight = minHeight
        self.expands = expands
        self.font = font
    }

    static var compact: StarlingsFilledButtonStyle {
        StarlingsFilledButtonStyle(minHeight: 36, expands: false, font: .subheadline.weight(.semibold))
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(font)
            .foregroundStyle(StarlingsMobileColors.accentInk)
            .padding(.horizontal, expands ? 0 : (minHeight < 44 ? 14 : 20))
            .frame(maxWidth: expands ? .infinity : nil, minHeight: minHeight)
            // hover: StarlingsFilledButtonFill swaps to accentHover.
            .modifier(StarlingsFilledButtonFill(pressed: configuration.isPressed))
    }
}

/// The filled call to action in views the Mac and the phone share.
/// The Mac's is `StarlingsCTAButtonStyle` in DesignSystem.swift; here it is
/// the phone's own filled style.
typealias StarlingsCTAButtonStyle = StarlingsFilledButtonStyle

struct StarlingsBorderedButtonStyle: ButtonStyle {
    let minHeight: CGFloat
    let expands: Bool
    let font: Font
    /// Label colour. Nil is `.primary`; a chip that is "mine" passes the accent.
    let foreground: Color?
    /// Icon-only: as wide as it is tall, no text padding.
    let square: Bool

    init(minHeight: CGFloat = 46, expands: Bool = true, font: Font = .headline, foreground: Color? = nil, square: Bool = false) {
        self.minHeight = minHeight
        self.expands = expands
        self.font = font
        self.foreground = foreground
        self.square = square
    }

    static var compact: StarlingsBorderedButtonStyle { compact() }

    static func compact(foreground: Color? = nil) -> StarlingsBorderedButtonStyle {
        StarlingsBorderedButtonStyle(minHeight: 36, expands: false, font: .subheadline.weight(.semibold), foreground: foreground)
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(font)
            .foregroundStyle(foreground ?? Color.primary)
            .padding(.horizontal, (expands || square) ? 0 : (minHeight < 44 ? 14 : 20))
            .frame(width: square ? minHeight : nil)
            .frame(maxWidth: expands ? .infinity : nil, minHeight: minHeight)
            // hover: StarlingsBorderedButtonShell lifts the rung.
            .modifier(StarlingsBorderedButtonShell(pressed: configuration.isPressed))
    }
}

/// The bordered shell, with the house hover: the veil over the elevated rung
/// and the brighter hairline (docs/DESIGN.md, "Hover: the house rule"). Press
/// outranks hover; a disabled button does not respond.
private struct StarlingsBorderedButtonShell: ViewModifier {
    let pressed: Bool
    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovered = false

    func body(content: Content) -> some View {
        let lifted = isHovered && isEnabled && !pressed
        content
            .meetContainerShape(cornerRadius: EnvisioningRadius.control)
            // The surface ladder, not a system fill: a system gray reads as
            // foreign next to the slate rungs. The veil sits on the fill,
            // under the label.
            .background {
                ZStack {
                    StarlingsConcentricFill(
                        style: StarlingsMobileColors.elevated.opacity(pressed ? 0.7 : 1),
                        fallbackRadius: EnvisioningRadius.control
                    )
                    StarlingsConcentricFill(
                        style: lifted ? StarlingsMobileColors.hoverLift : Color.clear,
                        fallbackRadius: EnvisioningRadius.control
                    )
                }
            }
            .meetConcentricBorder(
                lifted ? StarlingsMobileColors.borderHover : StarlingsMobileColors.border,
                fallbackRadius: EnvisioningRadius.control
            )
            .onHover { isHovered = $0 }
    }
}

private struct StarlingsFilledButtonFill: ViewModifier {
    let pressed: Bool
    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovered = false

    func body(content: Content) -> some View {
        content
            .meetContainerShape(cornerRadius: EnvisioningRadius.control)
            .meetConcentricBackground(
                pressed
                    ? StarlingsMobileColors.accentPressed
                    : (isHovered && isEnabled ? StarlingsMobileColors.accentHover : StarlingsMobileColors.accent),
                fallbackRadius: EnvisioningRadius.control
            )
            .onHover { isHovered = $0 }
    }
}

private struct StarlingsConcentricClip: ViewModifier {
    let fallbackRadius: CGFloat

    func body(content: Content) -> some View {
        content.clipShape(
            RoundedRectangle(cornerRadius: fallbackRadius, style: .continuous)
        )
    }
}

private struct StarlingsContainerShape: ViewModifier {
    let radius: CGFloat

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.containerShape(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
            )
        } else {
            content
        }
    }
}

/// The drawer's close: an `xmark` in the cancellation slot, not the word
/// "Cancel". iOS 26 draws the system close glyph from the role; below it the
/// symbol stands in.
struct StarlingsSheetCloseButton: View {
    let action: () -> Void

    /// Esc on a hardware keyboard closes the sheet, as the button does.
    var body: some View {
        button.keyboardShortcut(.cancelAction)
    }

    @ViewBuilder private var button: some View {
        if #available(iOS 26.0, *) {
            Button(role: .close, action: action)
        } else {
            Button(action: action) {
                Label("Close", systemImage: "xmark")
            }
            .labelStyle(.iconOnly)
        }
    }
}

extension View {
    /// The toolbar `+` in the Meet accent, whether it is a `Button` or a
    /// `Menu`. The toolbar draws its own round glass around the item on
    /// iOS 26, so the button paints no surface of its own — a filled style
    /// here draws a circle inside the circle. Prominent bordered below 26.
    /// `menuStyle(.button)` is what lets a `Menu` take the button style at
    /// all; without it Work's and Calendar's `+` stayed plain glass beside
    /// Team's and Docs' filled one.
    func meetToolbarProminent() -> some View {
        // `.circle`: a Menu sizes its glass to the content and lands a
        // capsule; the bar's own Buttons are circles.
        meetToolbarProminent(shape: .circle)
    }

    /// The sheet's confirm button (Save, Create task, Done) in the Meet
    /// accent: a filled capsule, never plain glass, so the one action that
    /// commits the drawer reads as such. Pair with `StarlingsSheetCloseButton`.
    func meetToolbarConfirm() -> some View {
        meetToolbarProminent(shape: .capsule)
    }

    @ViewBuilder
    private func meetToolbarProminent(shape: ButtonBorderShape) -> some View {
        if #available(iOS 26.0, *) {
            menuStyle(.button)
                .buttonStyle(.glassProminent)
                .buttonBorderShape(shape)
                .tint(StarlingsMobileColors.accent)
                .foregroundStyle(StarlingsMobileColors.accentInk)
        } else {
            menuStyle(.button)
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(shape)
                .tint(StarlingsMobileColors.accent)
                .foregroundStyle(StarlingsMobileColors.accentInk)
        }
    }

    /// Declares the view as a container for descendants that ask for a
    /// container-relative shape. The fills above no longer consult it (see
    /// `StarlingsConcentricFill`); it stays so system controls inside a Meet card
    /// still get a sensible container on iOS 26.
    func meetContainerShape(cornerRadius: CGFloat) -> some View {
        modifier(StarlingsContainerShape(radius: cornerRadius))
    }

    /// Draws a surface at `fallbackRadius`, continuous corners.
    func meetConcentricBackground<Style: ShapeStyle>(
        _ style: Style,
        fallbackRadius: CGFloat
    ) -> some View {
        background {
            StarlingsConcentricFill(style: style, fallbackRadius: fallbackRadius)
        }
    }

    func meetConcentricBorder<Style: ShapeStyle>(
        _ style: Style,
        fallbackRadius: CGFloat,
        lineWidth: CGFloat = 1
    ) -> some View {
        overlay {
            StarlingsConcentricStroke(
                style: style,
                fallbackRadius: fallbackRadius,
                lineWidth: lineWidth
            )
        }
    }

    func meetConcentricClip(fallbackRadius: CGFloat) -> some View {
        modifier(StarlingsConcentricClip(fallbackRadius: fallbackRadius))
    }
}

// MARK: - Glass, the floating layer

/// Liquid Glass on iOS 26, the opaque `fallback` below it (docs/DESIGN.md,
/// "Glass — the floating layer"). Glass is for a control that floats over
/// content that moves beneath it — a tile label over video, the call
/// controls over the stage, a toast over a list. A ladder rung is never
/// glass, and glass never sits on glass. `tint` is the accent budget's
/// concern: only the `+` and End carry one.
private struct StarlingsFloatingGlass<Fallback: ShapeStyle, S: Shape>: ViewModifier {
    let fallback: Fallback
    let shape: S
    let tint: Color?
    let interactive: Bool

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(glass, in: shape)
        } else {
            content.background(fallback, in: shape)
        }
    }

    @available(iOS 26.0, *)
    private var glass: Glass {
        var glass: Glass = .regular
        if let tint { glass = glass.tint(tint) }
        if interactive { glass = glass.interactive() }
        return glass
    }
}

/// A row of glass shapes must share one `GlassEffectContainer`, or each one
/// samples its neighbours and the row shimmers. Plain content below 26.
struct StarlingsGlassGroup<Content: View>: View {
    var spacing: CGFloat? = nil
    @ViewBuilder let content: () -> Content

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing, content: content)
        } else {
            content()
        }
    }
}

extension View {
    /// Glass in `shape` on iOS 26; `fallback` filled in the same shape below.
    /// `interactive` is for a button: the glass answers the press.
    func meetFloatingGlass<Fallback: ShapeStyle, S: Shape>(
        _ fallback: Fallback,
        in shape: S,
        tint: Color? = nil,
        interactive: Bool = false
    ) -> some View {
        modifier(StarlingsFloatingGlass(fallback: fallback, shape: shape, tint: tint, interactive: interactive))
    }

    /// The tab bar shrinks to the selected tab while the person scrolls down
    /// and returns on the way up. Work, Docs and Calendar are dense lists,
    /// and the room is worth more than five glyphs that are one thumb away.
    @ViewBuilder
    func meetTabBarMinimizes() -> some View {
        if #available(iOS 26.0, *) {
            tabBarMinimizeBehavior(.onScrollDown)
        } else {
            self
        }
    }
}
