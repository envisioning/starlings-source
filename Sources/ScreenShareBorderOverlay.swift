import AppKit
import LiveKit

/// A coloured frame drawn around whatever this Mac is sharing, for as long as
/// it is sharing it.
///
/// The point is the accident this prevents: the sharer's own stage tile is a
/// thumbnail among other thumbnails, and macOS's menu-bar recording indicator
/// says only that *something* is being captured. Neither answers the question
/// that actually matters mid-meeting — "is this window I just switched to going
/// out to the room?" A border traced around the shared surface itself answers
/// it without looking away from the work.
///
/// The overlay never appears in the shared video. A window share captures one
/// window (`SCContentFilter(desktopIndependentWindow:)`), and a display share
/// excludes Meet's own application, since LiveKit leaves
/// `ScreenShareCaptureOptions.includeCurrentApplication` off — so in both cases
/// the border is visible locally and absent from the stream.
@MainActor
final class ScreenShareBorderOverlay {
    /// Redraw cadence for a window share. A window can be dragged, resized, or
    /// sent to another display at any moment, and a border that lags behind the
    /// window is worse than none — it points at the wrong thing. Cheap enough
    /// at 4 Hz: one `CGWindowListCopyWindowInfo` lookup per tick.
    private static let trackingInterval: TimeInterval = 0.25

    private var overlay: BorderWindow?
    private var tracking: Timer?

    var isVisible: Bool { overlay != nil }

    /// Frames whichever surface the picker handed back. Sources LiveKit does not
    /// give geometry for are simply not framed — a missing border is a smaller
    /// problem than one drawn around the wrong rectangle.
    func show(for source: MacOSScreenCaptureSource?) {
        switch source {
        case let display as MacOSDisplay:
            show(frame: screenFrame(displayID: display.displayID) ?? appKitFrame(display.frame))
        case let window as MacOSWindow:
            trackWindow(windowID: window.windowID)
            startTracking(windowID: window.windowID)
        default:
            // No source means LiveKit's own "share the main display" path.
            show(frame: NSScreen.main?.frame)
        }
    }

    func hide() {
        tracking?.invalidate()
        tracking = nil
        overlay?.orderOut(nil)
        overlay = nil
    }

    private func show(frame: NSRect?) {
        guard let frame, frame.width > 1, frame.height > 1 else {
            hide()
            return
        }
        let window = overlay ?? BorderWindow()
        overlay = window
        window.setFrame(frame, display: true)
        window.orderFrontRegardless()
    }

    /// One tick of window-share tracking: follow the window, and take the
    /// border away while something is in front of it.
    ///
    /// Stacking cannot express this. Ordering the border below ordinary windows
    /// hides it under the shared window's own drop shadow, which is far wider
    /// than the gutter it is drawn in — the frontmost window, the one case that
    /// matters most, ends up with no visible border at all. So the border stays
    /// on top and is instead *withdrawn* when the window it frames is covered,
    /// which is the same thing to look at and does not depend on shadow
    /// geometry.
    private func trackWindow(windowID: CGWindowID) {
        guard let bounds = Self.liveWindowFrame(windowID) else {
            // The window closed while it was being shared. The share is over as
            // far as anyone watching is concerned, so stop claiming a rectangle
            // that no longer exists.
            hide()
            return
        }
        if isCovered(windowID: windowID, bounds: bounds) {
            overlay?.orderOut(nil)
            return
        }
        show(frame: windowBorderFrame(bounds))
    }

    /// True when an ordinary window sits above the shared one and overlaps it.
    ///
    /// Deliberately coarse: any overlap at all counts, because a border drawn
    /// around a window that is half behind a text editor points at the editor as
    /// much as at the share. Menu bar, Dock, and other system layers are
    /// excluded (`kCGWindowLayer` 0 only), as is the border itself, which is
    /// above the shared window by construction.
    private func isCovered(windowID: CGWindowID, bounds: CGRect) -> Bool {
        let borderNumber = overlay.map { CGWindowID($0.windowNumber) }
        let options: CGWindowListOption = [.optionOnScreenAboveWindow, .excludeDesktopElements]
        guard let above = CGWindowListCopyWindowInfo(options, windowID) as? [[String: Any]] else {
            return false
        }
        for entry in above {
            if let number = entry[kCGWindowNumber as String] as? CGWindowID, number == borderNumber {
                continue
            }
            guard (entry[kCGWindowLayer as String] as? Int) == 0 else { continue }
            if let alpha = entry[kCGWindowAlpha as String] as? Double, alpha < 0.05 { continue }
            guard let boundsDictionary = entry[kCGWindowBounds as String] as? [String: Any],
                  let frame = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary)
            else { continue }
            if frame.intersects(bounds) { return true }
        }
        return false
    }

    /// The shared window's frame grown by the stroke width, so the border lands
    /// in the shadow gutter around the window rather than over its own top few
    /// pixels — covering a title bar is exactly what an indicator must not do.
    private func windowBorderFrame(_ frame: CGRect) -> NSRect {
        appKitFrame(frame).insetBy(dx: -BorderView.thickness, dy: -BorderView.thickness)
    }

    private func startTracking(windowID: CGWindowID) {
        tracking?.invalidate()
        let timer = Timer(timeInterval: Self.trackingInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.trackWindow(windowID: windowID)
            }
        }
        // `.common` so the border keeps up while a menu is open or a window is
        // mid-drag — exactly the moments someone is moving what they share.
        RunLoop.main.add(timer, forMode: .common)
        tracking = timer
    }

    private static func liveWindowFrame(_ windowID: CGWindowID) -> CGRect? {
        guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]],
              let entry = list.first,
              let bounds = entry[kCGWindowBounds as String] as? [String: Any]
        else { return nil }
        return CGRect(dictionaryRepresentation: bounds as CFDictionary)
    }

    private func screenFrame(displayID: CGDirectDisplayID) -> NSRect? {
        NSScreen.screens.first { screen in
            let number = screen.deviceDescription[.init("NSScreenNumber")] as? NSNumber
            return number?.uint32Value == displayID
        }?.frame
    }

    /// ScreenCaptureKit and Core Graphics measure the desktop from the top-left
    /// of the primary display; AppKit measures it from the bottom-left. Placing
    /// a window from a CG rect without this flip puts the border on the wrong
    /// half of the screen — and looks right on a single centred display, which
    /// is what makes it worth naming.
    private func appKitFrame(_ frame: CGRect) -> NSRect {
        guard let primary = NSScreen.screens.first else { return frame }
        return NSRect(
            x: frame.minX,
            y: primary.frame.maxY - frame.maxY,
            width: frame.width,
            height: frame.height
        )
    }
}

/// Click-through, always-on-top, present on every Space: the border must never
/// take a click away from the app being demonstrated, and must not vanish when
/// the sharer switches Space mid-share. A window share hides it by ordering it
/// out while the shared window is covered, not by lowering it.
private final class BorderWindow: NSWindow {
    init() {
        super.init(
            contentRect: .zero,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        contentView = BorderView()
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class BorderView: NSView {
    /// Thick enough to read at a glance from across a desk, thin enough not to
    /// cover the edge of what is being shared.
    static let thickness: CGFloat = 5
    private static let cornerRadius: CGFloat = 8

    override func draw(_ dirtyRect: NSRect) {
        let inset = Self.thickness / 2
        let path = NSBezierPath(
            roundedRect: bounds.insetBy(dx: inset, dy: inset),
            xRadius: Self.cornerRadius,
            yRadius: Self.cornerRadius
        )
        path.lineWidth = Self.thickness
        // The border itself is the affordance — it does not need its own hue
        // on top of that to read as "you are sharing."
        StarlingsColors.primaryText.setStroke()
        path.stroke()
    }
}
