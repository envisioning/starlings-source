import AppKit

/// The Mac's answer to Dynamic Type: four steps, one preference, this Mac
/// only. Every fixed point size in `Sources/` passes through
/// `StarlingsTypography.scaled`, so a row, a card and the meeting rail grow
/// together. Fixed wells — avatar initials, tile badges, the calendar month
/// and week grids — keep their geometry, the same rule iOS applies to its
/// dense grids: the list beside them is the large-type reading.
///
/// A view reads the scale when it draws its text, so the change reaches
/// windows opened after it and views that redraw; a window already open
/// keeps its size until it is reopened. Settings says so.
enum StarlingsTextSize: String, CaseIterable, Sendable {
    case standard
    case large
    case larger
    case largest

    var title: String {
        switch self {
        case .standard: String(localized: "Default")
        case .large: String(localized: "Large")
        case .larger: String(localized: "Larger")
        case .largest: String(localized: "Largest")
        }
    }

    var scale: CGFloat {
        switch self {
        case .standard: 1
        case .large: 1.15
        case .larger: 1.3
        case .largest: 1.5
        }
    }

    static let key = "meet.text.size"

    static func current(defaults: UserDefaults = .standard) -> StarlingsTextSize {
        guard let raw = defaults.string(forKey: key), let size = StarlingsTextSize(rawValue: raw) else {
            return .standard
        }
        return size
    }

    static func set(_ size: StarlingsTextSize, defaults: UserDefaults = .standard) {
        defaults.set(size.rawValue, forKey: key)
        StarlingsTypography.scale = size.scale
        NotificationCenter.default.post(name: .meetTextSizeDidChange, object: size)
    }
}

extension Notification.Name {
    static let meetTextSizeDidChange = Notification.Name("StarlingsTextSize.didChange")
}
