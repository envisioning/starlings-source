import EnvisioningUI
import SwiftUI

/// Support views for a peer or a channel row, shared by Team's People and
/// Agents sections (docs/AGENTS_SURFACE.md). The rows
/// themselves are `WorkSidebarRow.channel` and `.peer` now
/// (iOS/WorkSidebarRow.swift) — the one shape every list in the sidebar
/// builds from, the same way the Mac's `WorkSidebarRowView` does for its one
/// Work sidebar. What's left here is what those factories draw with: the
/// channel's mark, a peer's avatar, and a peer's device badges.

/// A glyph in the same well a person's face sits in — the workspace's mark
/// for the "Everyone" channel row, or a plain SF Symbol for a subject row
/// (no person, no channel).
///
/// Without it a row with no avatar started the list with a hanging indent
/// while every person under it was inset by one, so it read as a heading
/// rather than as a row. Mirrors the Mac's `WorkGlyphMarkView`, down to the
/// glyph being 52% of the well for the brand mark — every row should look
/// like the same row on two screens, whatever it's naming.
///
/// Deliberately not a presence dot, for the same reason a channel is not one
/// on the Mac: neither a channel nor a subject is somebody, and a green ring
/// on either would invite ringing it.
enum MobileWorkMarkShape {
    case round
    case square
}

struct WorkGlyphMark: View {
    enum Content {
        /// The current workspace's mark: the "Everyone" channel row.
        case workspace
        case symbol(String)
    }

    let content: Content
    var shape: MobileWorkMarkShape = .round
    /// Matches `PeerAvatar`, which is what this is lining up with.
    private let diameter: CGFloat = 40

    var body: some View {
        well
            .overlay { glyph }
            .frame(width: diameter, height: diameter)
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var well: some View {
        switch shape {
        case .round:
            Circle()
                .fill(StarlingsMobileColors.elevated)
                .overlay { Circle().stroke(StarlingsMobileColors.border, lineWidth: 1) }
        case .square:
            RoundedRectangle(cornerRadius: diameter * 0.25, style: .continuous)
                .fill(StarlingsMobileColors.elevated)
                .overlay {
                    RoundedRectangle(cornerRadius: diameter * 0.25, style: .continuous)
                        .stroke(StarlingsMobileColors.border, lineWidth: 1)
                }
        }
    }

    @ViewBuilder
    private var glyph: some View {
        switch content {
        case .workspace:
            StarlingsCurrentWorkspaceMark(size: diameter * 0.52, ink: StarlingsMobileColors.accentMark)
        case .symbol(let name):
            // Neutral ink, the accent budget's default for an icon; only
            // the workspace mark above is the accent.
            Image(systemName: name)
                .font(.system(size: diameter * 0.42, weight: .medium))
                .foregroundStyle(.secondary)
        }
    }
}

/// A compact mark for rows below the sidebar's 40pt avatar rhythm.
/// Actionable records get a square well; areas and providers stay round.
struct MobileCompactMark: View {
    /// A symbol, or a calendar event's platform — the same square well the
    /// Mac's `WorkGlyphMarkView.Content.platform` fills on its agenda rows.
    enum Content {
        case symbol(String)
        case platform(CalendarMeetingPlatform)
        /// The unboxed accent dot in Home's Messages mark slot.
        case unread
    }

    let content: Content
    var shape: MobileWorkMarkShape = .round
    var size: CGFloat = 24
    var color: Color = .secondary

    init(systemName: String, shape: MobileWorkMarkShape = .round, size: CGFloat = 24, color: Color = .secondary) {
        self.init(content: .symbol(systemName), shape: shape, size: size, color: color)
    }

    init(content: Content, shape: MobileWorkMarkShape = .round, size: CGFloat = 24, color: Color = .secondary) {
        self.content = content
        self.shape = shape
        self.size = size
        self.color = color
    }

    var body: some View {
        mark
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var mark: some View {
        switch content {
        case .symbol(let systemName):
            well.overlay {
                Image(systemName: systemName)
                    .font(.system(size: size * 0.5, weight: .medium))
                    .foregroundStyle(color)
            }
        case .platform(let platform):
            well.overlay {
                MobileMeetingPlatformMark(platform: platform, size: size * 0.5, color: color)
            }
        case .unread:
            Circle()
                .fill(StarlingsMobileColors.accentMark)
                .frame(width: 8, height: 8)
        }
    }

    @ViewBuilder
    private var well: some View {
        switch shape {
        case .round:
            Circle()
                .fill(StarlingsMobileColors.elevated)
                .overlay { Circle().stroke(StarlingsMobileColors.border, lineWidth: 1) }
        case .square:
            RoundedRectangle(cornerRadius: size * 0.25, style: .continuous)
                .fill(StarlingsMobileColors.elevated)
                .overlay {
                    RoundedRectangle(cornerRadius: size * 0.25, style: .continuous)
                        .stroke(StarlingsMobileColors.border, lineWidth: 1)
                }
        }
    }
}

extension View {
    /// Centres a leading mark on the first line of the text beside it: the
    /// mark sits in a slot one `font` line tall, so a one-line title and the
    /// first line of a wrapped one share the mark's vertical centre.
    func meetFirstLineMark(_ font: Font) -> some View {
        ZStack {
            Text(verbatim: "M").font(font).hidden()
            self
        }
        .accessibilityHidden(true)
    }
}

/// An organization's logo, in the same well a face or a glyph occupies.
/// Shows the fallback glyph immediately and while loading — an organization
/// logo is a slower fetch than a colleague's avatar, and a row that already
/// has a title should never wait on a picture to be legible — and swaps to
/// the image on success. Stays on the glyph on failure; never a blank well.
/// Mirrors the Mac's `WorkOrgLogoMarkView`.
struct WorkOrgLogoMark: View {
    let url: URL
    let fallbackSystemName: String
    /// Matches `PeerAvatar`/`WorkGlyphMark`.
    private let diameter: CGFloat = 40

    var body: some View {
        AsyncImage(url: url) { phase in
            if case .success(let image) = phase {
                image
                    .resizable()
                    .scaledToFill()
                    .frame(width: diameter, height: diameter)
                    .clipShape(Circle())
                    .accessibilityHidden(true)
            } else {
                WorkGlyphMark(content: .symbol(fallbackSystemName))
            }
        }
    }
}

/// Somebody asked for you. A banner rather than a ringing screen: there is no
/// push behind it, so it is a note that a person wanted you.
struct RingBanner: View {
    @EnvironmentObject private var app: StarlingsAppModel
    @EnvironmentObject private var team: MobileTeamStore
    let ring: PeerRing

    private var ringTitle: String {
        switch ring.kind {
        case .call: return String(localized: "\(ring.callerDisplayName) wants to talk")
        case .agentStart: return String(localized: "\(ring.callerDisplayName) asks to open your room")
        case .wave: return String(localized: "\(ring.callerDisplayName) waved at you")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(ringTitle)
                .font(.body.weight(.semibold))
            HStack(spacing: 10) {
                if ring.kind == .call {
                    Button("Open room") { Task { await team.answerCall() } }
                        .buttonStyle(StarlingsBorderedButtonStyle.compact).meetHoverLift(cornerRadius: EnvisioningRadius.control)
                }
                if ring.kind == .agentStart {
                    Button("Open room") { Task { await team.answerAgentAsk() } }
                        .buttonStyle(StarlingsBorderedButtonStyle.compact).meetHoverLift(cornerRadius: EnvisioningRadius.control)
                }
                if ring.kind == .wave, let slug = ring.roomSlug, let room = MobileRoomPath(input: slug) {
                    Button("Join") {
                        Task { await team.clearRing() }
                        if let owner = app.ownerCredentials?.owner {
                            app.pendingGuestIdentity = MobileGuestIdentity(
                                name: owner.name,
                                email: owner.email
                            ).normalized
                        }
                        app.pendingJoinInput = room.canonicalURL
                        app.selectTab(.home)
                    }
                    .buttonStyle(StarlingsFilledButtonStyle.compact)
                }
                Button(ring.kind == .wave ? String(localized: "Dismiss") : String(localized: "Not now")) { Task { await team.clearRing() } }
                    .buttonStyle(StarlingsBorderedButtonStyle.compact(foreground: .secondary))
            }
        }
        // One rung up from an ordinary row: somebody is calling.
        .listRowBackground(StarlingsMobileColors.elevated)
    }
}

struct PeerAvatar: View {
    let peer: Peer
    /// Read from the store rather than threaded through every row: the source
    /// is one member session, and it is nil only while signed out — which is
    /// also the only state in which there is nothing to fetch, since the
    /// roster itself is member-gated.
    @EnvironmentObject private var team: MobileTeamStore
    /// Differentiate Without Color: the dot gains a shape per state, so the
    /// hue is never the only signal.
    @Environment(\.accessibilityDifferentiateWithoutColor) private var shapes

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            if let identity = peer.agentAvatar {
                AgentAvatarImage(identity: identity, diameter: 40)
            } else {
                PersonAvatarImage(
                    email: peer.email,
                    displayName: peer.displayName,
                    version: peer.avatarUpdatedAt,
                    diameter: 40,
                    source: team.avatarSource
                )
            }
            // No presence dot on an agent. The dot is evidence about a device,
            // and an agent has none.
            // Painted over the panel first: a dot is never translucent, and
            // `doNotDisturb` is a half-strength grey that would otherwise
            // show the row through it.
            Circle()
                .fill(StarlingsMobileColors.panel)
                .overlay { Circle().fill(dot) }
                .overlay {
                    if peer.status == .inMeeting {
                        Image(systemName: "video.fill")
                            .font(.system(size: 6, weight: .semibold))
                            .foregroundStyle(StarlingsMobileColors.panel)
                    } else if shapes {
                        mark
                    }
                }
                .frame(width: 12, height: 12)
                // Punches the dot out of the row it sits on, so this has to track
                // the row background rather than name a colour of its own.
                .overlay { Circle().stroke(StarlingsMobileColors.panel, lineWidth: 2) }
                .opacity(peer.status == .offline || peer.isAgent ? 0 : 1)
                .accessibilityLabel(peer.status.label)
                .accessibilityHidden(peer.status == .offline || peer.isAgent)
        }
        .frame(width: 40, height: 40)
    }

    /// One mark per state, in the panel colour so it punches out of the dot:
    /// available is the plain dot, active a hollow ring, busy a bar, in a
    /// unavailable a cross. The meeting mark is its video symbol at every setting.
    @ViewBuilder
    private var mark: some View {
        switch peer.status {
        case .available, .offline:
            EmptyView()
        case .active:
            Circle().fill(StarlingsMobileColors.panel).frame(width: 5, height: 5)
        case .busy:
            Rectangle().fill(StarlingsMobileColors.panel).frame(width: 6, height: 1.6)
        case .inMeeting:
            EmptyView()
        case .doNotDisturb:
            Image(systemName: "xmark")
                .font(.system(size: 6, weight: .black))
                .foregroundStyle(StarlingsMobileColors.panel)
        }
    }

    private var dot: Color {
        switch peer.status {
        case .inMeeting: return StarlingsMobileColors.presenceInMeeting
        case .busy: return StarlingsMobileColors.presenceBusy
        case .available: return StarlingsMobileColors.accent
        case .active: return StarlingsMobileColors.accent
        // A step below active: they are there, and the point of the row is
        // that you should not act on it. Opaque once painted over the panel.
        case .doNotDisturb: return Color.secondary.opacity(0.5)
        case .offline: return .clear
        }
    }
}
