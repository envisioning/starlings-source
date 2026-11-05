import CoreGraphics
import Foundation

enum StageGridLayout {
    enum ScreenShareLayoutChoice: String, CaseIterable, Hashable {
        case automatic
        case overlay
        case rail

        var title: String {
            switch self {
            case .automatic: String(localized: "Automatic")
            case .overlay: String(localized: "Over the share")
            case .rail: String(localized: "Beside or below")
            }
        }
    }

    enum ScreenShareLayoutPreferences {
        static let defaultsKey = "meet.screenShareLayout"

        static var choice: ScreenShareLayoutChoice {
            get {
                guard let raw = UserDefaults.standard.string(forKey: defaultsKey),
                      let choice = ScreenShareLayoutChoice(rawValue: raw) else {
                    return .automatic
                }
                return choice
            }
            set { UserDefaults.standard.set(newValue.rawValue, forKey: defaultsKey) }
        }
    }

    /// The stage's share, participant rail, and the rail's content all come
    /// from one plan. Rectangles use a top-left origin so AppKit and SwiftUI
    /// can render the same decision without repeating the placement rules.
    struct ScreenSharePlan: Equatable {
        enum RailMode: Equatable {
            case none
            case overlay
            case horizontal
            case vertical
        }

        let shareFrame: CGRect
        let railFrame: CGRect
        let railContentSize: CGSize
        let participantFrames: [CGRect]
        let railMode: RailMode
    }

    private static let overlayRailTileSide: CGFloat = 76
    private static let dockedHorizontalTileSide: CGFloat = 76
    private static let dockedVerticalTileSide: CGFloat = 112
    private static let dockedVerticalRailWidth: CGFloat = 144
    private static let dockedHorizontalRailHeight: CGFloat = 100
    private static let maxOverlayParticipants = 4
    private static let minimumShareWidthBesideRail: CGFloat = 480

    /// Screen-share framing policy shared by the Mac and iOS renderers.
    ///
    /// A short overlay is useful while the room is small. Once it becomes
    /// crowded, the rail gets its own space: beside a landscape share, or at
    /// the edge opposite the local inset in a compact stage. Content beyond
    /// the viewport scrolls at a fixed, readable tile size instead of
    /// shrinking every participant.
    ///
    /// `localInset` and all returned rectangles are relative to a top-left
    /// origin at `(0, 0)`. The inset is supplied by the renderer because its
    /// size and saved placement are platform-specific; the decision about
    /// avoiding it and placing the rail is not.
    static func screenSharePlan(
        in size: CGSize,
        participantCount: Int,
        localInset: CGRect? = nil,
        choice: ScreenShareLayoutChoice = .automatic,
        spacing: CGFloat = 12
    ) -> ScreenSharePlan {
        let bounds = CGRect(origin: .zero, size: size)
        guard size.width > 0, size.height > 0, participantCount > 0 else {
            return ScreenSharePlan(
                shareFrame: bounds,
                railFrame: .zero,
                railContentSize: .zero,
                participantFrames: [],
                railMode: .none
            )
        }

        let shouldTryOverlay = choice == .overlay
            || (choice == .automatic && participantCount <= maxOverlayParticipants)
        if shouldTryOverlay,
           size.height >= overlayRailTileSide + spacing,
           let overlay = overlayParticipantFrames(
                count: participantCount,
                in: size,
                localInset: localInset,
                spacing: spacing,
                allowsOverflow: choice == .overlay
           ) {
            let railHeight = overlayRailTileSide + spacing
            return ScreenSharePlan(
                shareFrame: bounds,
                railFrame: CGRect(x: 0, y: overlay.y, width: size.width, height: railHeight),
                railContentSize: CGSize(width: overlay.contentWidth, height: railHeight),
                participantFrames: overlay.frames,
                railMode: .overlay
            )
        }

        let canDockBeside = size.width >= size.height * 1.25
            && size.width - dockedVerticalRailWidth - spacing >= minimumShareWidthBesideRail
        if canDockBeside {
            // Keep a user-placed inset clear of the rail. Centre placements
            // leave either side available, so the trailing side is the default.
            let railOnLeading = localInset.map { $0.midX > size.width * 0.7 } ?? false
            let shareWidth = size.width - dockedVerticalRailWidth - spacing
            let railFrame = CGRect(
                x: railOnLeading ? 0 : shareWidth + spacing,
                y: 0,
                width: dockedVerticalRailWidth,
                height: size.height
            )
            let shareFrame = CGRect(
                x: railOnLeading ? dockedVerticalRailWidth + spacing : 0,
                y: 0,
                width: shareWidth,
                height: size.height
            )
            let side = min(dockedVerticalTileSide, dockedVerticalRailWidth - spacing * 2)
            let contentHeight = max(
                size.height,
                CGFloat(participantCount) * side + CGFloat(participantCount + 1) * spacing
            )
            let frames = (0..<participantCount).map { index in
                CGRect(
                    x: (dockedVerticalRailWidth - side) / 2,
                    y: spacing + CGFloat(index) * (side + spacing),
                    width: side,
                    height: side
                )
            }
            return ScreenSharePlan(
                shareFrame: shareFrame,
                railFrame: railFrame,
                railContentSize: CGSize(width: dockedVerticalRailWidth, height: contentHeight),
                participantFrames: frames,
                railMode: .vertical
            )
        }

        let railHeight = min(dockedHorizontalRailHeight, max(1, size.height - spacing - 1))
        let shareHeight = max(1, size.height - railHeight - spacing)
        let railOnTop = localInset.map { $0.midY > size.height * 0.7 } ?? false
        let railFrame = CGRect(
            x: 0,
            y: railOnTop ? 0 : shareHeight + spacing,
            width: size.width,
            height: railHeight
        )
        let shareFrame = CGRect(
            x: 0,
            y: railOnTop ? railHeight + spacing : 0,
            width: size.width,
            height: shareHeight
        )
        let side = max(1, min(dockedHorizontalTileSide, railHeight - spacing))
        let contentWidth = max(
            size.width,
            CGFloat(participantCount) * side + CGFloat(participantCount + 1) * spacing
        )
        let frames = (0..<participantCount).map { index in
            CGRect(
                x: spacing + CGFloat(index) * (side + spacing),
                y: (railHeight - side) / 2,
                width: side,
                height: side
            )
        }
        return ScreenSharePlan(
            shareFrame: shareFrame,
            railFrame: railFrame,
            railContentSize: CGSize(width: contentWidth, height: railHeight),
            participantFrames: frames,
            railMode: .horizontal
        )
    }

    private static func overlayParticipantFrames(
        count: Int,
        in size: CGSize,
        localInset: CGRect?,
        spacing: CGFloat,
        allowsOverflow: Bool
    ) -> (y: CGFloat, contentWidth: CGFloat, frames: [CGRect])? {
        let side = overlayRailTileSide
        let insetExclusion = localInset?.insetBy(dx: -spacing / 2, dy: -spacing / 2)
        let contentWidth = max(
            size.width,
            CGFloat(count) * side + CGFloat(count + 1) * spacing
        )
        let rowWidth = CGFloat(count) * side + CGFloat(count - 1) * spacing
        let firstTileX = contentWidth <= size.width
            ? max(spacing, (size.width - rowWidth) / 2)
            : spacing
        let railHeight = side + spacing
        let yCandidates = [CGFloat.zero, max(0, size.height - railHeight)]
        let candidates = yCandidates.map { y in
            (y, (0..<count).map { index in
                CGRect(
                    x: firstTileX + CGFloat(index) * (side + spacing),
                    y: spacing / 2,
                    width: side,
                    height: side
                )
            })
        }
        if let clear = candidates.first(where: { candidate in
            let insetInRail = insetExclusion?.offsetBy(dx: 0, dy: -candidate.0)
            let fitsWidth = allowsOverflow || contentWidth <= size.width
            let fitsHeight = candidate.0 + railHeight <= size.height
            let clearsInset = candidate.1.allSatisfy { insetInRail?.intersects($0) != true }
            return fitsWidth && fitsHeight && clearsInset
        }) {
            return (clear.0, contentWidth, clear.1)
        }
        guard allowsOverflow, let leastOverlap = candidates.min(by: { left, right in
            let leftInset = insetExclusion?.offsetBy(dx: 0, dy: -left.0)
            let rightInset = insetExclusion?.offsetBy(dx: 0, dy: -right.0)
            let leftCount = left.1.filter { leftInset?.intersects($0) == true }.count
            let rightCount = right.1.filter { rightInset?.intersects($0) == true }.count
            return leftCount < rightCount
        }) else { return nil }
        return (leastOverlap.0, contentWidth, leastOverlap.1)
    }

    /// The shape an equal peer grid takes in a given stage. Camera and avatar
    /// tiles use this square cell on every native surface; source media keeps
    /// its own aspect ratio inside the cell.
    struct EqualGridPlan: Equatable {
        let columns: Int
        let rows: Int
        let cell: CGSize
    }

    /// The square-cell grid shape that gives every tile the most area inside
    /// `size`. The stage's shape and the head count still decide the number of
    /// columns, but no camera's reported aspect ratio can reflow the grid.
    static func equalGridPlan(
        tileCount: Int,
        in size: CGSize,
        spacing: CGFloat
    ) -> EqualGridPlan {
        let count = max(tileCount, 1)
        var columns = count
        var rows = 1
        var cell = CGSize.zero

        for candidateColumns in 1...count {
            let candidateRows = Int(ceil(Double(count) / Double(candidateColumns)))
            let slotWidth = (size.width - CGFloat(candidateColumns - 1) * spacing) / CGFloat(candidateColumns)
            let slotHeight = (size.height - CGFloat(candidateRows - 1) * spacing) / CGFloat(candidateRows)
            guard slotWidth > 0, slotHeight > 0 else { continue }
            let side = min(slotWidth, slotHeight)
            guard side * side > cell.width * cell.height else { continue }
            columns = candidateColumns
            rows = candidateRows
            cell = CGSize(width: side, height: side)
        }

        guard cell.width > 0, cell.height > 0 else {
            // Stage too small for any grid of this many tiles — hand back one
            // row of the largest square cells we can still draw.
            let side = max(1, min(size.width / CGFloat(count), size.height))
            return EqualGridPlan(
                columns: count,
                rows: 1,
                cell: CGSize(width: side, height: side)
            )
        }

        return EqualGridPlan(columns: columns, rows: rows, cell: cell)
    }

    /// How much of a camera frame the stage may throw away to fill a cell.
    /// This remains useful for callers that explicitly choose a non-square
    /// media presentation, such as a legacy preview or a future crop mode.
    static let maxCropFraction: CGFloat = 0.2

    /// Assumed frame shape for a track whose dimensions have not arrived yet.
    static let defaultSourceAspect: CGFloat = 16.0 / 9.0

    /// Where the crop window sits when nothing better is known: centred
    /// horizontally, biased towards the top vertically because faces sit above
    /// the middle of a camera frame.
    static let defaultCropAnchor = CGPoint(x: 0.5, y: 0.42)

    /// Turns one or more normalized face boxes into the point that should stay
    /// in the centre of a square camera tile. Larger faces contribute more so
    /// a small background face cannot pull the crop away from the speaker.
    static func faceAnchor(for faceBounds: [CGRect]) -> CGPoint? {
        let valid = faceBounds.filter { $0.width > 0 && $0.height > 0 }
        guard !valid.isEmpty else { return nil }
        let totalArea = valid.reduce(CGFloat.zero) { $0 + $1.width * $1.height }
        guard totalArea > 0 else { return nil }
        let weighted = valid.reduce(CGPoint.zero) { result, rect in
            let weight = rect.width * rect.height / totalArea
            return CGPoint(
                x: result.x + rect.midX * weight,
                y: result.y + rect.midY * weight
            )
        }
        return clampedCropAnchor(weighted)
    }

    static func clampedCropAnchor(_ anchor: CGPoint) -> CGPoint {
        CGPoint(
            x: min(max(anchor.x, 0.1), 0.9),
            y: min(max(anchor.y, 0.16), 0.84)
        )
    }

    /// The rect a tile occupies inside its grid cell: the cell itself while
    /// the crop stays within budget, and a letterboxed rect centred in the cell
    /// once it would not.
    static func tileRect(
        in cell: CGRect,
        sourceAspect: CGFloat,
        maxCropFraction: CGFloat = maxCropFraction
    ) -> CGRect {
        guard cell.width > 0, cell.height > 0, sourceAspect > 0 else { return cell }
        let visible = 1 - min(max(maxCropFraction, 0), 0.9)
        let cellAspect = cell.width / cell.height
        let aspect = min(max(cellAspect, sourceAspect * visible), sourceAspect / visible)

        var size = CGSize(width: cell.width, height: cell.width / aspect)
        if size.height > cell.height {
            size = CGSize(width: cell.height * aspect, height: cell.height)
        }
        return CGRect(
            x: cell.minX + (cell.width - size.width) / 2,
            y: cell.minY + (cell.height - size.height) / 2,
            width: size.width,
            height: size.height
        )
    }

    /// Where the video layer sits inside a tile that clips it — the aspect-fill
    /// size, offset so that `anchor` lands in the middle of the tile.
    ///
    /// `anchor` is a point of the source frame, normalised with the origin at
    /// its top-left. The offset is clamped to the slack the fill leaves, so an
    /// anchor near an edge pans as far as it can rather than exposing a band of
    /// bare tile. `bounds` is in AppKit's bottom-left origin.
    static func videoFrame(
        inTile bounds: CGRect,
        sourceSize: CGSize,
        anchor: CGPoint = defaultCropAnchor
    ) -> CGRect {
        guard bounds.width > 0, bounds.height > 0,
              sourceSize.width > 0, sourceSize.height > 0
        else { return bounds }

        let scale = max(bounds.width / sourceSize.width, bounds.height / sourceSize.height)
        let filled = CGSize(width: sourceSize.width * scale, height: sourceSize.height * scale)
        let slackX = max(0, filled.width - bounds.width)
        let slackY = max(0, filled.height - bounds.height)
        // Anchors count down from the top of the frame; AppKit counts up.
        let safeAnchor = clampedCropAnchor(anchor)
        let x = clamp(bounds.width / 2 - filled.width * safeAnchor.x, from: -slackX, to: 0)
        let y = clamp(bounds.height / 2 - filled.height * (1 - safeAnchor.y), from: -slackY, to: 0)

        return CGRect(
            origin: CGPoint(x: bounds.minX + x, y: bounds.minY + y),
            size: filled
        )
    }

    private static func clamp(_ value: CGFloat, from lower: CGFloat, to upper: CGFloat) -> CGFloat {
        min(max(value, lower), upper)
    }
}
