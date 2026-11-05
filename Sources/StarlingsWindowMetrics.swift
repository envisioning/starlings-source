import AppKit

/// What a surface tells its window about how small it may become.
///
/// The floor is asked for, never stored: it changes when a panel opens, when a
/// panel is shed, when Meet swaps its launch card for a stage. A surface that
/// answers this owns *one* number and nothing else about its window.
@MainActor
protocol StarlingsWindowSizing: AnyObject {
    /// The smallest content rect this surface can honestly draw **as it is
    /// standing right now**.
    var minimumContentSize: NSSize { get }
}

/// The one place a Meet window's floor is written to the window.
///
/// Only the floor. The ceiling is the screen, and AppKit already holds a
/// window to the screen for every user-driven move and resize; a ceiling of
/// our own, and the "slide it back on screen" that came with it, is what made
/// a window that was half off the display jump into view whenever a column
/// laid itself out. Nothing else in the app sets `minSize`, `maxSize`, or
/// moves a frame the user placed.
@MainActor
enum StarlingsWindowMetrics {
    /// What a window that cannot name its own floor gets. Onboarding is the
    /// one such surface — a centred card that reads at any size.
    private static let unnamedFloor = NSSize(width: 480, height: 400)

    /// Re-read the surface's floor. Called when a panel opens or closes and
    /// when the surface inside the window is swapped.
    static func refresh(_ window: NSWindow?) {
        guard let window else { return }
        window.contentMinSize = (window.contentViewController as? StarlingsWindowSizing)?.minimumContentSize
            ?? unnamedFloor
    }
}
