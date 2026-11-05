import Foundation

/// True while this phone is in a call, as host or guest (slice G,
///). The workspace switcher reads it: a switch rebuilds every
/// store, so it never happens under a live call. The phone's twin of the
/// Mac's `StarlingsSurfaceActivity.isMeetLive`.
@MainActor
enum MobileCallActivity {
    /// Held weakly: a session that goes away while live stops counting.
    private static let live = NSHashTable<AnyObject>.weakObjects()

    static var isLive: Bool { !live.allObjects.isEmpty }

    /// Each call session reports itself on every phase change.
    static func report(_ session: AnyObject, live isLive: Bool) {
        if isLive {
            live.add(session)
        } else {
            live.remove(session)
        }
    }
}
