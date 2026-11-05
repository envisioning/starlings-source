import EnvisioningUI
import SwiftUI

/// One row shape for every list in the Work sidebar — a subject-based unread
/// thread (folded into Mine here), a space (Envisioning/Projects/Sales),
/// Team builds from this same skeleton: a leading mark for ordinary rows, a
/// title/subtitle pair, and one trailing
/// accessory. Every row keeps the same left edge regardless of what it names
/// — a face for a person, the workspace's mark for the "Everyone" channel, a
/// plain SF Symbol (folder, flag) for a subject with neither. Mirrors the
/// Mac's sibling, `WorkSidebarRowView` (Sources/WorkSidebarRowView.swift).
///
/// This is label content only. Callers wrap it in whatever `NavigationLink`,
/// `.contextMenu`, or `.swipeActions` their own list needs — that wiring is
/// exactly what varies from one section to the next, and SwiftUI already has
/// an idiom for it.
struct WorkSidebarRow: View {
    enum Leading {
        case avatar(Peer)
        case channelMark
        /// A plain SF Symbol in the same well — what a subject row (no
        /// person, no channel) draws instead.
        case glyph(systemName: String)
        /// The related organization's logo — a project or lead with one on
        /// file. Shows `fallbackSystemName` immediately and while loading;
        /// swaps to the image on success, stays on the glyph on failure.
        case organizationLogo(URL, fallbackSystemName: String)
    }

    enum Trailing {
        case unreadDot
        /// A small row action, with the unread dot folded in beside it when
        /// both appear.
        case actions([AnyView])
    }

    let leading: Leading?
    var leadingShape: MobileWorkMarkShape = .round
    let title: String
    var hasUnread = false
    let subtitle: String
    var isSubdued = false
    var isStarred = false
    var trailing: Trailing?
    var accessibilityLabel: String?

    var body: some View {
        HStack(spacing: 12) {
            leadingView
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body.weight(hasUnread ? .semibold : (isSubdued ? .regular : .medium)))
                    .foregroundStyle(isSubdued && !hasUnread ? .secondary : .primary)
                // No second line when there is nothing to say.
                if !subtitle.isEmpty {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            trailingView
        }
        .accessibilityElement(children: .combine)
        .modifier(OptionalAccessibilityLabel(label: accessibilityLabel))
    }

    @ViewBuilder
    private var leadingView: some View {
        ZStack(alignment: .topLeading) {
            leadingContent
            if isStarred {
                FavoriteStarBadge()
                    .offset(x: -4, y: -4)
            }
        }
    }

    @ViewBuilder
    private var leadingContent: some View {
        switch leading {
        case .none:
            EmptyView()
        case .avatar(let peer):
            PeerAvatar(peer: peer)
        case .channelMark:
            WorkGlyphMark(content: .workspace)
        case .glyph(let systemName):
            WorkGlyphMark(content: .symbol(systemName), shape: leadingShape)
        case .organizationLogo(let url, let fallbackSystemName):
            WorkOrgLogoMark(url: url, fallbackSystemName: fallbackSystemName)
        }
    }

    @ViewBuilder
    private var trailingView: some View {
        switch trailing {
        case .none:
            EmptyView()
        case .unreadDot:
            UnreadDot()
        case .actions(let views):
            HStack(spacing: 8) {
                ForEach(Array(views.enumerated()), id: \.offset) { $0.element }
            }
        }
    }
}

/// `.accessibilityLabel` only accepts a concrete `String`, not an optional
/// one — this is the modifier form of "apply it only when there's something
/// truer to say than the combined title-and-subtitle SwiftUI reads by default".
private struct OptionalAccessibilityLabel: ViewModifier {
    let label: String?

    func body(content: Content) -> some View {
        if let label {
            content.accessibilityLabel(label)
        } else {
            content
        }
    }
}

/// Same dot the roster draws on a person: something new, said once.
struct UnreadDot: View {
    var body: some View {
        Circle()
            .fill(.primary)
            .frame(width: 9, height: 9)
            .accessibilityHidden(true)
    }
}

// MARK: - Unread & spaces

extension WorkSidebarRow {
    /// A subject in a space (Envisioning/Projects/Sales), or a subject-based
    /// unread thread above Mine. `detail` replaces the standing line when the
    /// caller knows something truer than the counts — a row built from a
    /// thread has counted nothing, and "No open tasks" there would be a guess
    /// dressed as a fact.
    static func subject(
        _ subject: CrmSubject,
        hasUnread: Bool = false,
        detail: String? = nil,
        showsLeading: Bool = true,
        isSubdued: Bool = false,
        isStarred: Bool = false,
        isMuted: Bool = false
    ) -> WorkSidebarRow {
        // How the row reads is decided once for both platforms
        // (`WorkSubjectRowSpec`, fixtures/work-rows.json).
        let spec = WorkSubjectRowSpec(
            title: subject.displayTitle, hasUnread: hasUnread, isStarred: isStarred,
            isMuted: isMuted, isSubdued: isSubdued
        )
        let trailing: Trailing? = switch spec.trailing {
        case .unreadDot: .unreadDot
        case .none: nil
        }
        return WorkSidebarRow(
            leading: showsLeading ? subjectLeading(subject) : nil,
            title: subject.displayTitle,
            hasUnread: spec.showsUnread,
            subtitle: detail ?? subject.standing,
            isSubdued: isSubdued || isMuted,
            isStarred: spec.showsStarBadge,
            trailing: trailing,
            accessibilityLabel: spec.accessibilityLabel == subject.displayTitle ? nil : spec.accessibilityLabel
        )
    }

    /// The well a subject row leads with: the organization's logo, or the
    /// kind's glyph. Also drawn on its own by Overview's tiles.
    static func subjectLeading(_ subject: CrmSubject) -> Leading {
        let fallbackSystemName = switch subject.subjectKind {
        case .project: "folder.fill"
        case .lead: "flag.fill"
        case .organization: "building.2.fill"
        case .event: "megaphone"
        }
        if let logoURLString = subject.organizationLogoURL, let logoURL = URL(string: logoURLString) {
            return .organizationLogo(logoURL, fallbackSystemName: fallbackSystemName)
        }
        return .glyph(systemName: fallbackSystemName)
    }

    /// The well alone, for a tile.
    @ViewBuilder
    static func subjectLeading(_ subject: CrmSubject, diameter: CGFloat) -> some View {
        switch subjectLeading(subject) {
        case .organizationLogo(let url, let fallbackSystemName):
            WorkOrgLogoMark(url: url, fallbackSystemName: fallbackSystemName)
        case .glyph(let systemName):
            WorkGlyphMark(content: .symbol(systemName))
        default:
            EmptyView()
        }
    }
}

/// The small, neutral star that marks a favorite at the leading mark's
/// top-left corner on Home and in the Work sidebar.
/// The star on a starred row or tile, the one iOS copy. `compact` sits on a
/// sidebar row; `tile` on Home's Quick Access mark.
struct FavoriteStarBadge: View {
    enum Size { case compact, tile }
    var size: Size = .compact

    var body: some View {
        Image(systemName: "star.fill")
            .font(.system(size: size == .compact ? 9 : 12, weight: .medium))
            .foregroundStyle(size == .compact ? AnyShapeStyle(.secondary) : AnyShapeStyle(StarlingsMobileColors.secondary))
            .frame(width: size == .compact ? 16 : 20, height: size == .compact ? 16 : 20)
            .background(size == .compact ? AnyShapeStyle(.background) : AnyShapeStyle(StarlingsMobileColors.panel), in: Circle())
            .accessibilityHidden(true)
    }
}

// MARK: - Team & Agents

extension WorkSidebarRow {
    /// The "Everyone" channel row atop Team. No avatar and no presence — a
    /// channel is not somebody, and drawing it like a person would invite
    /// ringing it.
    static func channel(
        title: String,
        subtitle: String,
        hasUnread: Bool
    ) -> WorkSidebarRow {
        WorkSidebarRow(
            leading: .channelMark,
            title: title,
            hasUnread: hasUnread,
            subtitle: subtitle,
            trailing: hasUnread ? .unreadDot : nil,
            accessibilityLabel: hasUnread ? String(localized: "\(title), unread message") : nil
        )
    }

    /// One person — colleague or agent — in Team. `preview` is an agent's
    /// last line in your conversation with it, its second line unless it is
    /// working.
    static func peer(
        _ peer: Peer,
        hasUnread: Bool = false,
        preview: String? = nil,
        /// A word before presence: "Responsible" on a subject's people block.
        note: String? = nil
    ) -> WorkSidebarRow {
        var actions: [AnyView] = []
        if hasUnread {
            actions.append(AnyView(UnreadDot()))
        }

        // Nothing to badge on an agent: it has no devices, and an empty row
        // of them reads as a colleague who is offline.
        let line = peer.isAgent && peer.status != .busy ? (preview ?? "") : teamPeerSubtitle(for: peer)
        let subtitle = [note, line].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        let described = [peer.displayName, peer.isAgent ? line : peer.status.label]
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
        return WorkSidebarRow(
            leading: .avatar(peer),
            title: peer.displayName,
            hasUnread: hasUnread,
            subtitle: subtitle,
            trailing: actions.isEmpty ? nil : .actions(actions),
            accessibilityLabel: hasUnread
                ? String(localized: "\(described), unread message")
                : described
        )
    }
}
