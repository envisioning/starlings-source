import CoreGraphics
import Foundation

/// Geometry and timing for the Home grid, shared by the Mac launch surface
/// (`BrandGridBackground`) and the iOS Home tab (`MobileHomeGridBackground`).
///
/// Home has to look like one place on both clients, and a lattice defined twice
/// is how the two drift apart — so the pitch, the baked variation, the seed and
/// the motion timings all live here and nowhere else.
///
/// **The lattice is anchored to the centre of the view, not to its edges.**
/// Laying out whole cells and centring the leftover keeps every cell square,
/// but it also re-flows: each time a dimension crosses a multiple of `pitch`,
/// the origin snaps back by a cell and the whole field slides half a cell
/// sideways. During a live window resize that reads as the grid stuttering
/// under the cursor. Drawing outward from the centre instead means a line's
/// position never depends on how many other lines there are: cells stay 1:1,
/// and a resize only reveals new lines at the edges, where the fade swallows
/// them.
enum HomeGridLattice {
    /// Picked to sit between the 28pt control height and the 40pt field height,
    /// so the grid rhymes with the existing rhythm of the design.
    static let pitch: CGFloat = 32

    /// Per-line variation: each line gets a multiplier in this range, so the
    /// field reads as varied rather than uniform.
    static let multiplierMin: CGFloat = 0.7
    static let multiplierMax: CGFloat = 1.0

    /// Resting line strength for the Home lattice. The web twin keeps its
    /// `BASE_ALPHA_DARK` value in step with this native source of truth.
    static let darkBaseAlpha: CGFloat = 0.09
    static let lightBaseAlpha: CGFloat = 0.10

    /// Length of the atmospheric fade at each edge of the field. These are
    /// deliberately longer than a border vignette: the outer cells should
    /// disappear gradually, rather than stay fully present until the frame.
    static let verticalFadeFraction: CGFloat = 0.10
    static let horizontalFadeFraction: CGFloat = 0.08

    /// Baked variation for indices `-bakedLines / 2 ..< bakedLines / 2`, which
    /// covers a 2560pt span at `pitch`. Lines past the end fall back to the
    /// average — a window that wide has bigger problems than an even grid.
    static let bakedLines = 80

    /// Same seed on both clients: the field is identical on the Mac and the
    /// phone, and identical across launches, so the eye learns the pattern.
    static let seed: UInt32 = 0x5EED1

    // MARK: - Lattice

    /// Signed line indices covering `span`, where index 0 is the centre line.
    /// One extra on each side so a line is always present past the edge and the
    /// field never ends short of the fade.
    static func indices(span: CGFloat) -> ClosedRange<Int> {
        guard span > 0, pitch > 0 else { return 0...0 }
        let reach = Int((span / 2 / pitch).rounded(.up)) + 1
        return (-reach)...reach
    }

    /// Where line `index` sits in a span of `span`. Depends only on the centre,
    /// so growing the view slides every line by exactly half the delta rather
    /// than re-flowing the lattice.
    static func position(of index: Int, span: CGFloat) -> CGFloat {
        span / 2 + CGFloat(index) * pitch
    }

    /// Alpha for a signed line index. The lookup is keyed off the index and not
    /// off the line's ordinal position, so a given line keeps its brightness
    /// while the window resizes around it.
    static func alpha(_ multipliers: [CGFloat], index: Int, base: CGFloat) -> CGFloat {
        let slot = index + bakedLines / 2
        let multiplier = multipliers.indices.contains(slot) ? multipliers[slot] : 1
        return multiplier * base
    }

    /// Columns and rows draw from separate sequences. Sharing one array made
    /// column *n* and row *n* the same brightness, which the eye picks up as a
    /// diagonal running through the field.
    static func bakeMultipliers() -> (columns: [CGFloat], rows: [CGFloat]) {
        var rng = HomeGridNoise(seed: seed)
        func bake() -> [CGFloat] {
            (0..<bakedLines).map { _ in
                multiplierMin + rng.next() * (multiplierMax - multiplierMin)
            }
        }
        return (bake(), bake())
    }

    // MARK: - Motion

    /// Long enough to read as a fade rather than a cut, short enough that Home
    /// is not still settling when somebody reaches for Start.
    static let fadeDuration: CFTimeInterval = 0.4

    /// Home resolving outward from its centre instead of fading in flat. Held
    /// under a second so it lands as the surface arriving, not as a title
    /// sequence.
    static let revealDuration: CFTimeInterval = 0.6
}

/// Cheap seedable PRNG for visual noise. Same seed → same field across
/// launches and across clients.
struct HomeGridNoise {
    private var state: UInt32

    init(seed: UInt32) {
        self.state = seed
    }

    /// Returns a value in [0, 1).
    mutating func next() -> Double {
        state = state &* UInt32(1103515245) &+ UInt32(12345)
        return Double(state >> 16) / Double(UInt32(1 << 16))
    }
}
