import SwiftUI

/// The flock: the Starlings mark's 4 × 4 dots, drawn from the registry the web
/// draws too (`GatheringDotsRegistry`, generated from
/// `packages/contracts/src/gathering-dots.ts`). It is the only animated loader
/// on every client; each `Motion` is one meaning (docs/DESIGN.md, "Waiting").
/// Reduce Motion stops every mode at the resting radii.
struct GatheringDotsView: View {
    enum Motion {
        /// The resting radii.
        case still
        /// Each dot breathes a little around its own radius, each on its own
        /// clock, so the dots never move in step and the shape holds: the
        /// wordmark, and a mark with nothing to show (camera off).
        case drift
        /// The slow wave: connecting, waiting at the door.
        case murmuration
        /// The agent's wave: an agent works.
        case thinking
        /// The fast wave: a short wait on a control.
        case busy

        /// The wave's period, for the three modes that sweep all four radii.
        var sweepSeconds: Double? {
            switch self {
            case .murmuration: GatheringDotsRegistry.murmurationSeconds
            case .thinking: GatheringDotsRegistry.thinkingSeconds
            case .busy: GatheringDotsRegistry.busySeconds
            case .still, .drift: nil
            }
        }
    }

    var side: CGFloat
    var ink: Color
    var motion: Motion = .drift
    /// Names the wait for VoiceOver. Without one the flock is decoration.
    var label: Text? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if motion != .still && !reduceMotion {
            TimelineView(.animation) { timeline in
                flock(at: timeline.date.timeIntervalSinceReferenceDate)
            }
        } else {
            flock(at: nil)
        }
    }

    @ViewBuilder
    private func flock(at time: TimeInterval?) -> some View {
        let canvas = Canvas { context, size in
            let scale = min(size.width, size.height) / GatheringDotsRegistry.viewBox
            for dot in GatheringDotsRegistry.dots {
                let radius = Self.radius(of: dot, motion: motion, at: time) * scale
                let rect = CGRect(
                    x: dot.x * scale - radius,
                    y: dot.y * scale - radius,
                    width: radius * 2,
                    height: radius * 2
                )
                context.fill(Path(ellipseIn: rect), with: .color(ink))
            }
        }
        .frame(width: side, height: side)
        if let label {
            canvas.accessibilityElement().accessibilityLabel(label)
        } else {
            canvas.accessibilityHidden(true)
        }
    }

    /// A dot's radius now, in the registry's square. `nil` time is the rest.
    private static func radius(of dot: GatheringDotsRegistry.Dot, motion: Motion, at time: TimeInterval?) -> Double {
        guard let time else { return dot.radius }
        if let period = motion.sweepSeconds {
            return GatheringDotsRegistry.sweepRadius(of: dot, at: time, period: period)
        }
        return motion == .drift ? dot.radius * breath(at: time, of: dot) : dot.radius
    }

    /// The share of its resting radius a drifting dot has now: low at the
    /// start of its cycle, high halfway, eased like the web's `ease-in-out`
    /// keyframes.
    private static func breath(at time: TimeInterval, of dot: GatheringDotsRegistry.Dot) -> Double {
        let period = GatheringDotsRegistry.driftSeconds * dot.driftFactor
        let progress = (time / period + dot.driftPhase).truncatingRemainder(dividingBy: 1)
        let eased = 0.5 - 0.5 * cos(2 * .pi * progress)
        let low = GatheringDotsRegistry.driftLow
        return low + (GatheringDotsRegistry.driftHigh - low) * eased
    }
}

/// The Starlings wordmark: lowercase `starlings`, the flock after it. The
/// product's name wherever no workspace is in view (first run, About). The
/// web draws it in Inter; native has no Inter, so the word is the system face
/// at the registry's weight. Gap, tracking and flock scale with `size`.
struct StarlingsWordmark: View {
    var size: CGFloat
    var ink: Color
    var motion: GatheringDotsView.Motion = .drift

    var body: some View {
        HStack(spacing: size * GatheringDotsRegistry.gapEm) {
            Text(verbatim: GatheringDotsRegistry.word)
                .font(.system(size: size, weight: Self.weight))
                .tracking(size * GatheringDotsRegistry.trackingEm)
                .foregroundStyle(ink)
            GatheringDotsView(side: size * GatheringDotsRegistry.flockEm, ink: ink, motion: motion)
        }
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "Starlings"))
    }

    /// The registry's CSS weight on the system face's steps.
    private static var weight: Font.Weight {
        switch GatheringDotsRegistry.weight {
        case ..<550: .medium
        case ..<675: .semibold
        default: .bold
        }
    }
}
