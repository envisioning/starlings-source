import Foundation

/// How a subject row reads, decided once for the Mac's `WorkSidebarRowView`
/// and the phone's `WorkSidebarRow` ( slice 7, from #120): the
/// title's weight and ink, the favorite badge, trailing mark, and label a screen
/// reader gets. Both row views build from this, and both platforms' tests
/// run `fixtures/work-rows.json` against it — so the pairing is enforced,
/// not documented.
///
/// Rules, in the order they win: unread is bold and dotted unless muted;
/// muted is quiet and never bold; a starred row carries a top-left badge;
/// subdued (a lead) is quiet ink too.
struct WorkSubjectRowSpec: Equatable, Sendable {
    enum Weight: String, Codable, Sendable { case semibold, medium, regular }
    enum Ink: String, Codable, Sendable { case primary, secondary }
    enum Trailing: String, Codable, Sendable { case unreadDot, none }

    let showsUnread: Bool
    let showsStarBadge: Bool
    let weight: Weight
    let ink: Ink
    let trailing: Trailing
    let accessibilityLabel: String

    init(title: String, hasUnread: Bool, isStarred: Bool, isMuted: Bool, isSubdued: Bool) {
        let showsUnread = hasUnread && !isMuted
        let quiet = isSubdued || isMuted
        self.showsUnread = showsUnread
        weight = showsUnread ? .semibold : (quiet ? .regular : .medium)
        ink = quiet && !showsUnread ? .secondary : .primary
        showsStarBadge = isStarred
        trailing = showsUnread ? .unreadDot : .none
        var label = title
        if showsUnread { label += ", unread message" }
        if isStarred { label += ", starred" }
        if isMuted { label += ", muted" }
        accessibilityLabel = label
    }
}
