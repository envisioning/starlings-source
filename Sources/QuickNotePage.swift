import CoreGraphics

/// Home's Quick Notes card shows a page of notes: the leading notes whose
/// rows fit in a set height, by each row's own measured height. Short notes
/// give a page more rows, long notes fewer. The page is a share of the
/// viewport's height, so a taller window or phone shows more. It never
/// depends on where the card sits or on the scroll position: an earlier rule
/// measured the room under the list's top, and on the phone the count changed
/// as Home scrolled. See more unfolds one more page.
///
/// One rule for the Mac (`MacQuickNotesPanel`) and the phone
/// (`MobileQuickNotesCard`); the web's `quickNotesPageCount` in
/// `web/src/quick-notes-page.ts` is the same rule with the same numbers.
enum QuickNotePage {
    /// The floor: a page of long notes still shows this many.
    static let minimumNotes = 3
    /// One page, as a share of the viewport's height.
    static let viewportShare: CGFloat = 0.4

    /// How many leading notes `pages` pages hold. `height` is nil for a note
    /// not measured yet: it counts at the median of the notes that are, so a
    /// note just added at the top does not shrink the page and then re-decide
    /// on the next pass. With nothing measured at all, the first
    /// unmeasured note is shown so it can be, and the count stops there.
    ///
    /// `floor` is how many the card must keep showing: the count on screen
    /// plus the notes just added, so adding a note never hides one that was
    /// visible. The caller clears it when the page itself changes.
    static func count<ID>(
        of ids: [ID],
        viewport: CGFloat,
        pages: Int,
        spacing: CGFloat,
        floor: Int = 0,
        height: (ID) -> CGFloat?
    ) -> Int {
        let budget = viewport * viewportShare * CGFloat(max(1, pages))
        let estimate = median(ids.compactMap(height))
        let kept = max(minimumNotes, floor)
        var used: CGFloat = 0
        var count = 0
        for id in ids {
            guard let rowHeight = height(id) ?? estimate else {
                return min(ids.count, max(kept, count + 1))
            }
            used += rowHeight + (count == 0 ? 0 : spacing)
            if used > budget { break }
            count += 1
        }
        return min(ids.count, max(kept, count))
    }

    /// The middle measured height; nil when nothing is measured.
    static func median(_ heights: [CGFloat]) -> CGFloat? {
        guard !heights.isEmpty else { return nil }
        let sorted = heights.sorted()
        let middle = sorted.count / 2
        return sorted.count.isMultiple(of: 2) ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
    }

    /// The floor after the list changed from `old` to `new` with `shown` on
    /// screen: what was visible plus every note that is new at the top.
    static func floor<ID: Hashable>(old: [ID], new: [ID], shown: Int, current: Int) -> Int {
        guard !old.isEmpty else { return current }
        let before = Set(old)
        let added = new.filter { !before.contains($0) }.count
        guard added > 0 else { return min(current, new.count) }
        return min(new.count, max(current, shown) + added)
    }
}
