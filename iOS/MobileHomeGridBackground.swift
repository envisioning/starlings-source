import SwiftUI

/// The iOS brand lattice, used behind Home and the meeting Stage. Same rules
/// as `BrandGridBackground`, off the same `HomeGridLattice`: a centre-anchored
/// lattice of 32pt squares, a hairline per line with baked-in variation, a fade
/// on all four sides, and the field resolving outward when a surface appears.
///
/// Home and the Stage have to look like the same product on every client, so
/// the pitch, the alpha range, the seed and the motion timings are the ones the
/// Mac uses.
///
/// The preference is shared too, but stored per device — `@AppStorage` on this
/// phone, `UserDefaults` on that Mac.
struct MobileHomeGridBackground: View {
    /// Home keeps the brand-tinted field; the meeting Stage asks for neutral
    /// lines so the grid does not compete with the call controls or speaking
    /// state.
    private let meetingMode: Bool
    @AppStorage(HomeTexturePreferences.key) private var showsTexture = HomeTexturePreferences.defaultValue
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var displayScale
    @State private var hasAppeared = false

    init(meetingMode: Bool = false) {
        self.meetingMode = meetingMode
    }

    /// Baked once, in the same order the Mac bakes them, off the same seed.
    private static let multipliers = HomeGridLattice.bakeMultipliers()

    var body: some View {
        if showsTexture {
            GeometryReader { proxy in
                let size = proxy.size
                lattice(alpha: baseAlpha, in: size)
                    .mask { edgeFade }
                .mask { reveal(in: size) }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .onAppear { startMotion() }
            .onDisappear { hasAppeared = false }
        }
    }

    /// Home uses the mark's lime at low alpha in dark mode and monochrome ink
    /// in light. The meeting Stage stays neutral in both appearances.
    private var baseColor: Color {
        meetingMode
            ? StarlingsMobileColors.secondary
            : (colorScheme == .dark ? StarlingsMobileColors.accent : StarlingsMobileColors.primary)
    }

    private var baseAlpha: CGFloat {
        colorScheme == .dark ? HomeGridLattice.darkBaseAlpha : HomeGridLattice.lightBaseAlpha
    }

    private func lattice(alpha: CGFloat, in size: CGSize) -> some View {
        Canvas { context, canvasSize in
            let hairline = 1 / max(displayScale, 1)

            for index in HomeGridLattice.indices(span: canvasSize.width) {
                let x = HomeGridLattice.position(of: index, span: canvasSize.width)
                var path = Path()
                path.move(to: CGPoint(x: x, y: 0))
                path.addLine(to: CGPoint(x: x, y: canvasSize.height))
                context.stroke(
                    path,
                    with: .color(baseColor.opacity(
                        HomeGridLattice.alpha(Self.multipliers.columns, index: index, base: alpha)
                    )),
                    lineWidth: hairline
                )
            }

            for index in HomeGridLattice.indices(span: canvasSize.height) {
                let y = HomeGridLattice.position(of: index, span: canvasSize.height)
                var path = Path()
                path.move(to: CGPoint(x: 0, y: y))
                path.addLine(to: CGPoint(x: canvasSize.width, y: y))
                context.stroke(
                    path,
                    with: .color(baseColor.opacity(
                        HomeGridLattice.alpha(Self.multipliers.rows, index: index, base: alpha)
                    )),
                    lineWidth: hairline
                )
            }
        }
        .frame(width: size.width, height: size.height)
    }

    /// Four-sided fade: the part-cells outside the lattice go quiet rather than
    /// reading as a ragged edge. On Home this also keeps the grid off the
    /// navigation and tab bars; on the Stage it softens the meeting boundary.
    private var edgeFade: some View {
        LinearGradient(
            stops: [
                .init(color: .clear, location: 0),
                .init(color: .black, location: HomeGridLattice.verticalFadeFraction),
                .init(color: .black, location: 1 - HomeGridLattice.verticalFadeFraction),
                .init(color: .clear, location: 1),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
        .mask {
            LinearGradient(
                stops: [
                    .init(color: .clear, location: 0),
                    .init(color: .black, location: HomeGridLattice.horizontalFadeFraction),
                    .init(color: .black, location: 1 - HomeGridLattice.horizontalFadeFraction),
                    .init(color: .clear, location: 1),
                ],
                startPoint: .leading,
                endPoint: .trailing
            )
        }
    }

    /// The field resolves outward from its centre instead of fading up flat.
    /// The circle is sized past the corners and blurred so the advancing front
    /// is a soft edge rather than a visible rim, and so the finished state is a
    /// plain opaque mask with no vignette left behind.
    private func reveal(in size: CGSize) -> some View {
        let diagonal = (size.width * size.width + size.height * size.height).squareRoot()
        return Circle()
            .fill(.black)
            .frame(width: diagonal * 1.2, height: diagonal * 1.2)
            .blur(radius: 24)
            .scaleEffect(hasAppeared ? 1 : 0.02)
    }

    private func startMotion() {
        guard !reduceMotion else {
            hasAppeared = true
            return
        }
        withAnimation(.easeOut(duration: HomeGridLattice.revealDuration)) {
            hasAppeared = true
        }
    }
}
