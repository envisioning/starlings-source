import EnvisioningUI
import SwiftUI

/// The shared visual grammar for a row in Work. Tasks and issues keep their
/// own adapters and actions, but the list should not reveal two competing row
/// components through different padding or title alignment. A standard
/// `List` row: no card background of its own, so the row reads the same as
/// every other row in Work (`WorkSidebarRow`'s sections included) and the
/// list's own separators and insets do the only bounding.
struct MobileWorkRow<Leading: View, Metadata: View>: View {
    let title: String
    private let leading: Leading
    private let metadata: Metadata

    init(
        title: String,
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder metadata: () -> Metadata
    ) {
        self.title = title
        self.leading = leading()
        self.metadata = metadata()
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            leading
                .frame(width: 18, alignment: .center)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body)
                    .meetLineLimit(1)
                metadata
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .meetLineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 2)
    }
}

/// A single-line clamp that gives way at accessibility text sizes.
/// One line of 34pt body text holds four words; a row that truncates the
/// fifth is a row nobody can read. Below the accessibility sizes the layout
/// keeps its rhythm; above them a title may take two lines, a caption three.
struct StarlingsLineLimit: ViewModifier {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let compact: Int

    func body(content: Content) -> some View {
        content.lineLimit(dynamicTypeSize.isAccessibilitySize ? compact + 2 : compact)
    }
}

extension View {
    /// `lineLimit(n)` that relaxes to `n + 2` at accessibility text sizes.
    func meetLineLimit(_ compact: Int) -> some View {
        modifier(StarlingsLineLimit(compact: compact))
    }

    /// Dense grids (calendar month and week cells) scale with the type size up
    /// to the largest non-accessibility size and stop there: a 22pt day cell
    /// cannot hold 40pt digits, and a grid that overflows is worse than one
    /// that stays at xxxLarge. The agenda list beside it scales all the way.
    func meetGridTypeSizeCap() -> some View {
        dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }
}

// StarlingsMobileColors lives in StarlingsMobileColors.swift — the widget extension
// compiles that file too, and cannot compile this one.

/// The Starlings glyph, still (`StarlingsGlyph`), the Mac's `StarlingsBrand.glyphImage`.
/// A thin wrapper so the call sites keep their spelling while the geometry
/// lives once, in the dots registry.
struct StarlingsGlyphMark: View {
    var size: CGFloat = 18
    var color: Color = .primary

    var body: some View {
        StarlingsGlyph()
            .fill(color)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

struct MobileMeetHero: View {
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { timeline in
            VStack(alignment: .center, spacing: 6) {
                // Octa sets Home's clock only; the date under it and every other line is the system face.
                Text(timeline.date, format: StarlingsDateFormatting.timeStyle)
                    .font(EnvisioningFont.octa(56))
                    .foregroundStyle(.primary)
                    .accessibilityLabel(timeline.date.meetTimeString())
                Text(StarlingsDateFormatting.homeDate(timeline.date))
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .center)
            .multilineTextAlignment(.center)
        }
        .padding(.vertical, 6)
    }
}

struct StarlingsCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            // Panel fill and the `border` hairline, as web's `.today-card`.
            // Fill alone carried the edge on the dark canvas; on the light
            // one the Panel rung is three per cent off the canvas and the
            // card dissolved without the line.
            .meetContainerShape(cornerRadius: EnvisioningRadius.card)
            .meetConcentricBackground(
                StarlingsMobileColors.panel,
                fallbackRadius: EnvisioningRadius.card
            )
            .meetConcentricBorder(
                StarlingsMobileColors.border,
                fallbackRadius: EnvisioningRadius.card
            )
    }
}

/// The Home row (docs/DESIGN.md, "Home rows"): the one shell every row on
/// Home wears, on every surface. Elevated on the card's panel, radius `field`,
/// 12 of padding, and a lifted fill where a pointer exists. Web spells
/// it `.home-row`; the Mac's `LaunchUpcomingRow` and its siblings draw the
/// same layer.
private struct StarlingsHomeRow: ViewModifier {
    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .meetContainerShape(cornerRadius: EnvisioningRadius.field)
            .meetConcentricBackground(
                StarlingsMobileColors.elevated,
                fallbackRadius: EnvisioningRadius.field
            )
            .meetHoverLift(cornerRadius: EnvisioningRadius.field)
    }
}

extension View {
    func meetHomeRow() -> some View {
        modifier(StarlingsHomeRow())
    }
}

/// iPad with a trackpad or mouse is a pointer surface, so its controls owe the
/// same answer Mac and web give: one rung up the surface ladder. On a plain touch
/// iPhone `onHover` never fires, so this costs nothing there.
///
/// The veil is laid *over* whatever the view already draws rather than replacing
/// its fill, which is how `StarlingsColors.lifted` behaves on Mac and how the
/// `--hover-lift` gradient behaves on web. `border` opts the hairline in.
private struct StarlingsHoverLift: ViewModifier {
    let cornerRadius: CGFloat
    let border: Bool

    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovered = false

    /// A disabled control does not respond (docs/DESIGN.md, "Precedence").
    private var lifted: Bool { isHovered && isEnabled }

    func body(content: Content) -> some View {
        content
            .overlay {
                StarlingsConcentricFill(
                    style: lifted ? StarlingsMobileColors.hoverLift : Color.clear,
                    fallbackRadius: cornerRadius
                )
                    .allowsHitTesting(false)
            }
            .overlay {
                if border {
                    StarlingsConcentricStroke(
                        style: lifted ? StarlingsMobileColors.borderHover : StarlingsMobileColors.border,
                        fallbackRadius: cornerRadius,
                        lineWidth: 1
                    )
                }
            }
            .onHover { isHovered = $0 }
    }
}

/// An input is a well: it keeps its fill and answers on the hairline instead — the
/// same exception `StarlingsTextField` makes on Mac and `input:hover` makes on web.
private struct StarlingsHoverBorder: ViewModifier {
    let cornerRadius: CGFloat

    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovered = false

    func body(content: Content) -> some View {
        content
            .meetConcentricBorder(
                isHovered && isEnabled ? StarlingsMobileColors.borderHover : StarlingsMobileColors.border,
                fallbackRadius: cornerRadius
            )
        .onHover { isHovered = $0 }
    }
}

/// For fills that hover to a named colour rather than a veil — the accent CTA,
/// whose hovered value is pinned across all three surfaces. It has to swap the
/// background rather than overlay it: an opaque veil would bury the label.
private struct StarlingsHoverFill: ViewModifier {
    let cornerRadius: CGFloat
    let resting: Color
    let hovered: Color

    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovered = false

    func body(content: Content) -> some View {
        content
            .background {
                StarlingsConcentricFill(
                    style: isHovered && isEnabled ? hovered : resting,
                    fallbackRadius: cornerRadius
                )
            }
            .onHover { isHovered = $0 }
    }
}

/// A chromeless control — a row in a picker or settings list, an icon, an
/// inline word — owns no shell for the veil to sit on, so the pointer answers
/// the way iPadOS answers it everywhere else: the highlight platter. `.plain`
/// on its own answers nothing to a trackpad, which made every one of these
/// inert on iPad (AGENTS.md invariant 18). Disabled controls stay inert.
private struct StarlingsPointerHighlight<S: Shape>: ViewModifier {
    let shape: S

    @Environment(\.isEnabled) private var isEnabled

    func body(content: Content) -> some View {
        content
            .contentShape(.hoverEffect, shape)
            .hoverEffect(.highlight, isEnabled: isEnabled)
    }
}

/// `.plain` with the pointer wired in: the label draws and presses exactly as
/// `.plain` does (it *is* a plain button inside), plus `meetPointerHighlight`.
/// Use it for any chromeless button. A button that owns a shell (card, tile,
/// chip, Home row) keeps `.plain` and lifts with `.meetHoverLift` instead —
/// the veil, not the platter, is the answer for a surface.
struct StarlingsPlainButtonStyle: PrimitiveButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button(configuration)
            .buttonStyle(.plain)
            .meetPointerHighlight()
    }
}

extension PrimitiveButtonStyle where Self == StarlingsPlainButtonStyle {
    /// `.plain` that answers the pointer. See `StarlingsPlainButtonStyle`.
    static var meetPlain: StarlingsPlainButtonStyle { StarlingsPlainButtonStyle() }
}

/// The system switch derives its thumb colour from the track colour. Meet's
/// toggle contract changes the track only, so the thumb stays the same white
/// nudge in both states.
private struct StarlingsToggleStyle: ToggleStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        Button {
            withAnimation(.easeOut(duration: 0.15)) {
                configuration.isOn.toggle()
            }
        } label: {
            HStack(spacing: 12) {
                configuration.label
                Spacer(minLength: 12)
                Capsule()
                    .fill(configuration.isOn
                        ? StarlingsMobileColors.accent
                        : StarlingsMobileColors.secondary)
                    .frame(width: 51, height: 31)
                    .overlay(alignment: configuration.isOn ? .trailing : .leading) {
                        Circle()
                            .fill(Color.white)
                            .frame(width: 27, height: 27)
                            .padding(2)
                    }
            }
        }
        .buttonStyle(.meetPlain)
        .opacity(isEnabled ? 1 : 0.45)
        .accessibilityValue(configuration.isOn ? String(localized: "On") : String(localized: "Off"))
        .accessibilityHint("Double-tap to toggle")
    }
}

extension View {
    /// The one canvas every top-level destination owns.
    ///
    /// SwiftUI's grouped List otherwise paints its own system background over
    /// the view behind it. Top-level surfaces all use this modifier, so Home,
    /// Calendar, Work, and Team cannot grow separate canvas colours by accident.
    ///
    /// Apply it to the root content *inside* a `NavigationStack`, never to the
    /// stack itself: the stack's root hosts an opaque system background
    /// (black in dark) over anything behind it, and the canvas never shows.
    func meetSurfaceBackground() -> some View {
        self
            .scrollContentBackground(.hidden)
            .background(StarlingsMobileColors.canvas.ignoresSafeArea())
    }

    /// The rows of a List, on the ladder: `EnvisioningUI`'s
    /// `envisioningListRows()`, named for this app. `listRowBackground` is a
    /// row trait, so it has to sit on the content inside the List — on the
    /// List itself it does nothing. `StarlingsList` applies this for you; use it
    /// directly only on a List that needs its own init (a selection List).
    func meetListRows() -> some View {
        envisioningListRows()
    }
}

/// The one grouped List every surface draws: `EnvisioningList`, which
/// core-kit's panes draw too, so a Core list inside Work and Work's own list
/// are the same list. Radius is the system's: SwiftUI has no API for a List
/// group's corner radius (see docs/DESIGN.md, "Lists").
typealias StarlingsList = EnvisioningList

/// `StarlingsList` for a `Form`: every editor sheet builds one of these, never a
/// raw `Form`. A row's fill is a trait the container's content has to set;
/// no environment value reaches it, so a raw `Form` comes out in UIKit's
/// grouped grey however the app around it is coloured.
typealias StarlingsForm = EnvisioningForm

extension View {

    /// The house hover for anything clickable that owns a shell.
    func meetHoverLift(cornerRadius: CGFloat, border: Bool = false) -> some View {
        modifier(StarlingsHoverLift(cornerRadius: cornerRadius, border: border))
    }

    /// The pointer highlight for a chromeless tappable that is not a `Button`
    /// (a tap gesture, a UIKit recognizer). Prefer `.buttonStyle(.meetPlain)`
    /// on a real button.
    func meetPointerHighlight() -> some View {
        meetPointerHighlight(RoundedRectangle(cornerRadius: EnvisioningRadius.control, style: .continuous))
    }

    func meetPointerHighlight<S: Shape>(_ shape: S) -> some View {
        modifier(StarlingsPointerHighlight(shape: shape))
    }

    func meetHoverFill(cornerRadius: CGFloat, resting: Color, hovered: Color) -> some View {
        modifier(StarlingsHoverFill(cornerRadius: cornerRadius, resting: resting, hovered: hovered))
    }

    /// `capitalization` is `.never` because most fields take an address, a
    /// slug or a title the owner spells; prose fields pass `.sentences`.
    func meetField(
        capitalization: TextInputAutocapitalization = .never,
        cornerRadius: CGFloat = EnvisioningRadius.field
    ) -> some View {
        self
            .textInputAutocapitalization(capitalization)
            .autocorrectionDisabled()
            .padding(.horizontal, 14)
            .frame(minHeight: 48)
            .meetContainerShape(cornerRadius: cornerRadius)
            .meetConcentricBackground(
                StarlingsMobileColors.field,
                fallbackRadius: cornerRadius
            )
            // The caret is the focus channel, which the app-level neutral tint
            // would otherwise wash out.
            .tint(StarlingsMobileColors.accent)
            .modifier(StarlingsHoverBorder(cornerRadius: cornerRadius))
    }

    /// A boolean control owns the accent when it is on. Keep this local to the
    /// toggle so the app's neutral chrome does not turn every control on a form
    /// lime as a side effect.
    func meetToggleTint() -> some View {
        toggleStyle(StarlingsToggleStyle())
    }

}
