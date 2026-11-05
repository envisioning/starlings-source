import AppKit

/// Where your own camera parks on your own stage, and what a drag of the inset
/// snaps to.
///
/// Local to this Mac and remembered across meetings: moving your own head is a
/// preference about your own window — nothing is published, and nobody else's
/// stage moves. Top centre is the default, under the built-in camera, so
/// looking at yourself stays as close as this gets to looking down the lens.
/// The other five exist for the meeting where your own face is sitting on the
/// part of somebody's shared screen you are trying to read.
enum SelfViewPlacement: String, CaseIterable, Sendable {
    case topLeft
    case top
    case topRight
    case bottomLeft
    case bottom
    case bottomRight

    /// Under the built-in camera, which is where self-view has always sat.
    static let underTheCamera = SelfViewPlacement.top

    private var isTop: Bool {
        switch self {
        case .topLeft, .top, .topRight: true
        case .bottomLeft, .bottom, .bottomRight: false
        }
    }

    /// Flush with the stage's own padded edges — the inset rides over the grid
    /// rather than beside it, so it needs no margin of its own.
    ///
    /// `bounds` is unflipped AppKit space, the same as `MeetingStageView`.
    func frame(for size: NSSize, in bounds: NSRect) -> NSRect {
        let x: CGFloat = switch self {
        case .topLeft, .bottomLeft: bounds.minX
        case .top, .bottom: bounds.midX - size.width / 2
        case .topRight, .bottomRight: bounds.maxX - size.width
        }
        let y = isTop ? bounds.maxY - size.height : bounds.minY
        return NSRect(x: x, y: y, width: size.width, height: size.height)
    }

    /// Which of the six a dragged inset lands on: the nearest by centre point,
    /// so the tile goes where it was let go of rather than where it started.
    static func nearest(to frame: NSRect, in bounds: NSRect) -> SelfViewPlacement {
        let dropped = NSPoint(x: frame.midX, y: frame.midY)
        return allCases.min { first, second in
            distance(from: dropped, to: first.frame(for: frame.size, in: bounds))
                < distance(from: dropped, to: second.frame(for: frame.size, in: bounds))
        } ?? underTheCamera
    }

    private static func distance(from point: NSPoint, to frame: NSRect) -> CGFloat {
        // Squared: the comparison is all this is for, and hypot on every
        // candidate of every drop is a square root nobody reads.
        let dx = frame.midX - point.x
        let dy = frame.midY - point.y
        return dx * dx + dy * dy
    }
}

/// How big your own camera draws on your own stage. Three steps, not a
/// slider: the inset is a reference, and the choice people make is "smaller,
/// it is in the way" or "bigger, I am checking my framing", never a number.
///
/// Every step scales with the stage width and clamps to a range, so a step
/// means the same thing on a laptop and on a display.
enum SelfViewSize: String, CaseIterable, Sendable {
    case small
    case medium
    case large

    /// The size the inset has always been.
    static let standard = SelfViewSize.medium

    var title: String {
        switch self {
        case .small: String(localized: "Small")
        case .medium: String(localized: "Medium")
        case .large: String(localized: "Large")
        }
    }

    /// Fraction of the stage width the inset asks for, before clamping.
    var widthFraction: CGFloat {
        switch self {
        case .small: 0.12
        case .medium: 0.17
        case .large: 0.24
        }
    }

    var minWidth: CGFloat {
        switch self {
        case .small: 96
        case .medium: 132
        case .large: 180
        }
    }

    var maxWidth: CGFloat {
        switch self {
        case .small: 180
        case .medium: 260
        case .large: 380
        }
    }
}

enum SelfViewPreferences {
    private static let placementKey = "meet.selfViewPlacement"
    private static let sizeKey = "meet.selfViewSize"

    /// Survives quit: somebody who moved their face out of the way of a shared
    /// screen once meant it, and should not have to do it again next Monday.
    static var placement: SelfViewPlacement {
        get {
            guard let raw = UserDefaults.standard.string(forKey: placementKey),
                  let placement = SelfViewPlacement(rawValue: raw) else {
                return .underTheCamera
            }
            return placement
        }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: placementKey)
        }
    }

    /// Same persistence as `placement`, for the same reason.
    static var size: SelfViewSize {
        get {
            guard let raw = UserDefaults.standard.string(forKey: sizeKey),
                  let size = SelfViewSize(rawValue: raw) else {
                return .standard
            }
            return size
        }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: sizeKey)
        }
    }
}
