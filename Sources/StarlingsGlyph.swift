import SwiftUI

/// The Starlings glyph at small sizes, where a picture file cannot follow the
/// tint. The registry's square is fitted to the shorter side and centred.
///
/// `.brand` is the still glyph at `GatheringDotsRegistry.glyphRadii`, the
/// shape the app icons and the favicons draw (`STARLINGS_GLYPH_RADII` in
/// packages/contracts/src/gathering-dots.ts); the watch complications draw
/// it. The Mac menu bar draws `.even` when nothing works and `.thinking`
/// while an agent works: the brand glyph's uneven dots read as a frozen
/// frame of motion there, so still has to look still.
struct StarlingsGlyph: Shape {
    enum Flock {
        case brand
        /// Every dot at the mean resting radius: the wave's average shape.
        case even
        /// A moment in the thinking wave.
        case thinking(at: TimeInterval)
    }

    var flock: Flock = .brand

    func path(in rect: CGRect) -> Path {
        let side = min(rect.width, rect.height)
        let scale = side / GatheringDotsRegistry.viewBox
        let dx = rect.minX + (rect.width - side) / 2
        let dy = rect.minY + (rect.height - side) / 2
        var path = Path()
        for (index, dot) in GatheringDotsRegistry.dots.enumerated() {
            let radius = switch flock {
            case .brand: GatheringDotsRegistry.glyphRadii[index]
            case .even: GatheringDotsRegistry.evenRadius
            case .thinking(let time): GatheringDotsRegistry.thinkingRadius(of: dot, at: time)
            }
            path.addEllipse(in: CGRect(
                x: dx + (dot.x - radius) * scale,
                y: dy + (dot.y - radius) * scale,
                width: radius * 2 * scale,
                height: radius * 2 * scale
            ))
        }
        return path
    }
}

extension GatheringDotsRegistry {
    /// The four resting radii (`GATHERING_RADII`), smallest first. Every dot
    /// rests at one of them, so the dots carry the whole set.
    static let restingRadii: [Double] = Set(dots.map(\.radius)).sorted()

    /// The mean resting radius. The thinking wave passes through each
    /// resting radius once per cycle, so this is its average size.
    static let evenRadius: Double = restingRadii.reduce(0, +) / Double(max(restingRadii.count, 1))

    /// A moment in the `thinking` wave.
    static func thinkingRadius(of dot: Dot, at time: TimeInterval) -> Double {
        sweepRadius(of: dot, at: time, period: thinkingSeconds)
    }

    /// The web's `gathering-radius` keyframes (web/src/gathering-dots.css),
    /// which `murmuration`, `thinking` and `busy` share at their own periods:
    /// the dot steps through resting radii 0, 1, 3, 2 and back, eased, offset
    /// by its phase so neighbours move as one wave.
    static func sweepRadius(of dot: Dot, at time: TimeInterval, period: Double) -> Double {
        let radii = restingRadii
        guard radii.count == 4 else { return evenRadius }
        let stops: [(at: Double, radius: Double)] = [(0, radii[0]), (0.24, radii[1]), (0.49, radii[3]), (0.74, radii[2]), (1, radii[0])]
        let progress = (time / period + dot.phase).truncatingRemainder(dividingBy: 1)
        guard let next = stops.firstIndex(where: { $0.at >= progress }), next > 0 else { return radii[0] }
        let from = stops[next - 1], to = stops[next]
        let local = (progress - from.at) / (to.at - from.at)
        let eased = 0.5 - 0.5 * cos(.pi * local)
        return from.radius + (to.radius - from.radius) * eased
    }
}
