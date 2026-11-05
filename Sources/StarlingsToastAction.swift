import SwiftUI

/// The tone of a toast. Neutral is the rule; danger is the exception, for a
/// failure raised from a place that has no line of its own (a row action, a
/// context menu). A danger toast draws with the surface's error primitive, so
/// it reads red and carries Copy like every other failure (docs/ERRORS.md).
enum StarlingsToastTone: Equatable, Sendable {
    case neutral
    case danger
}

/// How a SwiftUI view says something in passing, on the Mac and on the phone:
///
///     @Environment(\.meetToast) private var toast
///     toast("Link copied")
///
/// Each platform installs the action once, at the root it presents from — a
/// window on the Mac, the screen or sheet on iOS — so a shared view never
/// threads an `onToast` closure to reach it. See docs/DESIGN.md, "Toast — the
/// passing word", for when a toast is the right thing to say.
struct StarlingsToastAction: Sendable {
    private let show: @MainActor @Sendable (String, StarlingsToastTone) -> Void

    init(_ show: @escaping @MainActor @Sendable (String, StarlingsToastTone) -> Void) {
        self.show = show
    }

    @MainActor
    func callAsFunction(_ text: String, tone: StarlingsToastTone = .neutral) {
        show(text, tone)
    }
}

private struct StarlingsToastActionKey: EnvironmentKey {
    static let defaultValue = StarlingsToastAction.platformDefault
}

extension EnvironmentValues {
    var meetToast: StarlingsToastAction {
        get { self[StarlingsToastActionKey.self] }
        set { self[StarlingsToastActionKey.self] = newValue }
    }
}
