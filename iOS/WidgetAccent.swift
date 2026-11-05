import Foundation
import WidgetKit

/// The active workspace's accent, handed to the widget extension.
/// The extension cannot read the workspace, only the app group, so the app
/// writes the dark mark shade there in sRGB, and `WidgetInk` reads it. A
/// workspace with no accent writes nothing, and the widgets keep the lime.
enum WidgetAccent {
    private static let key = "widget.accent.mark.dark"
    private static var defaults: UserDefaults? { UserDefaults(suiteName: WatchBridgeSnapshot.appGroup) }

    /// The shade in sRGB, 0 to 1, or nil for the product's own.
    static var rgb: (red: Double, green: Double, blue: Double)? {
        guard let values = defaults?.array(forKey: key) as? [Double], values.count == 3 else { return nil }
        return (values[0], values[1], values[2])
    }

    /// Writes the shade and, when it changed, reloads every widget, so a
    /// switch of workspace or a new accent shows without a reinstall.
    static func publish(_ rgb: (red: Double, green: Double, blue: Double)?) {
        guard let defaults else { return }
        let values = rgb.map { [$0.red, $0.green, $0.blue] }
        guard defaults.array(forKey: key) as? [Double] != values else { return }
        if let values { defaults.set(values, forKey: key) } else { defaults.removeObject(forKey: key) }
        WidgetCenter.shared.reloadAllTimelines()
    }
}
