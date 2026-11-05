import SwiftUI
#if canImport(AppKit)
import AppKit
#endif

/// Semantic colours are shared by the Mac, iOS, and SwiftUI surfaces.
///
/// Danger intentionally has one value in every appearance. Alpha and the
/// surface underneath may change how it is presented, but a light-mode swap
/// would make the same failure or destructive action look like a different
/// product state on another surface.
enum StarlingsSemanticColors {
    static let dangerRed = 1.0
    static let dangerGreen = 0.39
    static let dangerBlue = 0.38

    static let danger = Color(
        .sRGB,
        red: dangerRed,
        green: dangerGreen,
        blue: dangerBlue,
        opacity: 1
    )

    // This file also compiles into the iOS target, which has no AppKit.
    #if canImport(AppKit)
    /// The same red as an AppKit mark — the menu-bar glyph in the alarm
    /// state, an inline alarm line.
    static let dangerMark = NSColor(srgbRed: dangerRed, green: dangerGreen, blue: dangerBlue, alpha: 1)

    /// A recording in progress: the menu-bar glyph while ambient capture
    /// runs. Subtle, not the alarm red — a state, not a fault.
    static let recordingMark = NSColor(srgbRed: 0.93, green: 0.27, blue: 0.27, alpha: 1)
    #endif
}
