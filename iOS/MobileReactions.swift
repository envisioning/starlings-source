import SwiftUI

/// One reaction in flight. Identity is per-appearance rather than per-reaction: two
/// people clapping at once are two things crossing the stage, not one.
struct MobileFlyingReaction: Identifiable, Equatable, Sendable {
    let id = UUID()
    let reaction: MeetingReaction
    let senderName: String
    /// Horizontal lane, so a burst fans out instead of stacking in a column.
    /// Fixed at creation because a lane that moved on redraw would jitter.
    let lane = Double.random(in: 0.12...0.88)
    let flight = MeetingReaction.flightDuration
        + Double.random(in: -MeetingReaction.flightJitter...MeetingReaction.flightJitter)
}

/// The palette, as a row of buttons.
///
/// Six pictures and nothing else. An open text field on a topic every client
/// renders large across the meeting would be a broadcast channel with no
/// composer and no history — see `packages/contracts/src/reactions.ts`.
struct MobileReactionPalette: View {
    let send: (MeetingReaction) async -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        HStack(spacing: 6) {
            ForEach(MeetingReaction.allCases, id: \.self) { reaction in
                Button {
                    // Played directly: the palette dismisses in the same beat.
                    StarlingsHaptics.tap.play()
                    Task { await send(reaction) }
                    dismiss()
                } label: {
                    Image(systemName: reaction.systemSymbolName)
                        .font(.system(size: 24, weight: .semibold))
                        .frame(width: 48, height: 48)
                }
                .buttonStyle(.meetPlain)
                .accessibilityLabel(reaction.accessibilityName)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .meetFloatingGlass(.thinMaterial, in: Capsule())
    }
}

/// A reaction crossing the stage, captioned with whoever sent it.
///
/// Purely decorative and deliberately unmissable-but-brief: it sits over the
/// stage, ignores hit testing so it can never swallow a tap meant for a
/// control, and each emoji removes itself when its flight ends.
struct MobileReactionOverlay: View {
    let reactions: [MobileFlyingReaction]
    let retire: (UUID) -> Void

    var body: some View {
        GeometryReader { proxy in
            ForEach(reactions) { reaction in
                MobileFlyingReactionView(reaction: reaction, size: proxy.size) {
                    retire(reaction.id)
                }
            }
        }
        .allowsHitTesting(false)
    }
}

private struct MobileFlyingReactionView: View {
    let reaction: MobileFlyingReaction
    let size: CGSize
    let onFinish: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var rise = false

    var body: some View {
        VStack(spacing: 2) {
            Image(systemName: reaction.reaction.systemSymbolName)
                .font(.system(size: 120, weight: .bold))
                .foregroundStyle(reactionForeground)
                .shadow(color: reactionOutline, radius: 0, x: 1, y: 0)
                .shadow(color: reactionOutline, radius: 0, x: -1, y: 0)
                .shadow(color: reactionOutline, radius: 0, x: 0, y: 1)
                .shadow(color: reactionOutline, radius: 0, x: 0, y: -1)
            Text(reaction.senderName)
                .font(.caption2)
                .foregroundStyle(.white)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.black.opacity(0.5), in: Capsule())
        }
        // Reduce Motion: the reaction still appears, captioned, but
        // fades in place near the bottom instead of climbing the stage.
        .position(
            x: size.width * reaction.lane,
            y: rise && !reduceMotion ? size.height * 0.12 : size.height * 0.92
        )
        .opacity(rise ? 0 : 1)
        .onAppear {
            withAnimation(.easeOut(duration: reaction.flight)) { rise = true }
            Task {
                try? await Task.sleep(for: .seconds(reaction.flight))
                onFinish()
            }
        }
        .accessibilityHidden(true)
    }

    private var reactionForeground: Color {
        colorScheme == .dark ? .white : .black
    }

    private var reactionOutline: Color {
        colorScheme == .dark ? .black : .white
    }
}
