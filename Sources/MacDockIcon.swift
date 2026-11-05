import AppKit
import Combine
import SwiftUI

/// The Dock icon while Meet runs: the still Starlings glyph in the ink on the
/// workspace's accent (docs/TENANCY_READINESS.md §Brand rule). A workspace
/// with no accent, Envisioning among them, keeps the bundle's icon. AppKit
/// shows this image only while the app runs; Finder, Launchpad and a quit
/// app's Dock tile show `Resources/starlings.icon`.
@MainActor
enum MacDockIcon {
    private static var subscription: AnyCancellable?
    private static var drawn: WorkspaceDescriptorAccentPalette?

    /// Follows the shared store's workspace. `$current` publishes the new
    /// value before `StarlingsWorkspace.active` moves, so this reads the
    /// palette it is handed, not `WorkspaceAccent`.
    static func install() {
        subscription = StarlingsWorkspaceStore.shared.$current
            .map(\.accentPalette)
            .removeDuplicates()
            .sink { apply($0) }
    }

    private static func apply(_ palette: WorkspaceDescriptorAccentPalette?) {
        guard palette != drawn else { return }
        drawn = palette
        guard let palette,
              let fill = WorkspaceAccent.parse(palette.dark.accent),
              let ink = WorkspaceAccent.parse(palette.dark.onAccent)
        else {
            NSApp.applicationIconImage = nil
            return
        }
        NSApp.applicationIconImage = image(fill: color(fill), ink: color(ink))
    }

    /// The macOS icon grid on a 1024 canvas: an 824 tile, 100 in from each
    /// edge, with the glyph's square at `glyphSpan` of the tile.
    static func image(fill: NSColor, ink: NSColor) -> NSImage {
        let canvas = CGSize(width: 1024, height: 1024)
        return NSImage(size: canvas, flipped: true) { _ in
            let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
            fill.setFill()
            NSBezierPath(roundedRect: tile, xRadius: 185.4, yRadius: 185.4).fill()
            let side = tile.width * GatheringDotsRegistry.glyphSpan
            let glyph = CGRect(x: tile.midX - side / 2, y: tile.midY - side / 2, width: side, height: side)
            ink.setFill()
            NSBezierPath(cgPath: StarlingsGlyph().path(in: glyph).cgPath).fill()
            return true
        }
    }

    private static func color(_ rgb: WorkspaceAccent.RGB) -> NSColor {
        NSColor(srgbRed: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
    }
}
