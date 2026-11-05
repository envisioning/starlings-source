import CoreGraphics

/// The macOS Screen Recording TCC gate used by both the picker and the CLI.
///
/// ScreenCaptureKit does not provide a useful user-facing permission state:
/// source enumeration and stream start can fail with framework errors, and the
/// app must already carry `NSScreenCaptureUsageDescription` for the system to
/// explain the request. Keep this check before any picker, thumbnail, or
/// LiveKit track is created so a denied share cannot affect the meeting.
enum ScreenCaptureAccess {
    static var isGranted: Bool {
        CGPreflightScreenCaptureAccess()
    }

    static func ensurePermission() -> Bool {
        if isGranted {
            return true
        }

        // On first use this asks macOS to show its Screen Recording consent
        // flow. A newly granted access may still require an app relaunch;
        // callers deliberately show that recovery when this returns false.
        return CGRequestScreenCaptureAccess()
    }
}
