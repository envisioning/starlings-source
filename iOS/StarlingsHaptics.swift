import SwiftUI
import UIKit

/// The one vocabulary for touch feedback on the phone.
///
/// Every haptic in the app is one of these seven, so a light tap means the
/// same thing on a reaction as on a knock, and nothing chooses its own weight.
/// Views attach them with `.sensoryFeedback` — the declarative API, driven by
/// state — so a haptic says what *happened*, not what was pressed: the mic
/// buzzes when `microphoneEnabled` flips, a task ticks when the write lands.
/// The exceptions are a view that leaves the hierarchy in the same beat (it
/// calls `play()`), and UIKit gesture code (`impactGenerator`).
enum StarlingsHaptics: Equatable, Sendable {
    /// Something small arrived or was sent: a reaction, a message, a knock.
    case tap
    /// A control changed state under the finger: mic, camera, hand, record.
    case toggle
    /// Something left or was taken away: a participant removed, a note
    /// deleted, the call ended, a proposal declined.
    case destructive
    /// One step of a drag snapping to its grid.
    case step
    case success
    case warning
    case error

    var feedback: SensoryFeedback {
        switch self {
        case .tap: .impact(weight: .light)
        case .toggle: .impact(weight: .medium)
        case .destructive: .impact(flexibility: .rigid)
        case .step: .selection
        case .success: .success
        case .warning: .warning
        case .error: .error
        }
    }

    /// Fire now, outside SwiftUI's trigger model. For a sheet that dismisses
    /// on success, where a `.sensoryFeedback` on the view would be torn down
    /// before it played. `view` anchors the haptic on iOS 17.5+, which plays
    /// on whichever screen that view is on.
    @MainActor
    func play(in view: UIView? = nil) {
        switch self {
        case .tap: Self.impactGenerator(.light, in: view).impactOccurred()
        case .toggle: Self.impactGenerator(.medium, in: view).impactOccurred()
        case .destructive: Self.impactGenerator(.rigid, in: view).impactOccurred()
        case .step:
            if #available(iOS 17.5, *), let view {
                UISelectionFeedbackGenerator(view: view).selectionChanged()
            } else {
                UISelectionFeedbackGenerator().selectionChanged()
            }
        case .success: Self.notificationGenerator(in: view).notificationOccurred(.success)
        case .warning: Self.notificationGenerator(in: view).notificationOccurred(.warning)
        case .error: Self.notificationGenerator(in: view).notificationOccurred(.error)
        }
    }

    /// A generator to keep for the life of a gesture, so `prepare()` has
    /// somewhere to go and the first impact is not late.
    @MainActor
    static func impactGenerator(
        _ style: UIImpactFeedbackGenerator.FeedbackStyle,
        in view: UIView?
    ) -> UIImpactFeedbackGenerator {
        if #available(iOS 17.5, *), let view {
            return UIImpactFeedbackGenerator(style: style, view: view)
        }
        return UIImpactFeedbackGenerator(style: style)
    }

    @MainActor
    private static func notificationGenerator(in view: UIView?) -> UINotificationFeedbackGenerator {
        if #available(iOS 17.5, *), let view {
            return UINotificationFeedbackGenerator(view: view)
        }
        return UINotificationFeedbackGenerator()
    }
}

/// A haptic fired from code, carried as state so `.sensoryFeedback` can play
/// it. For an outcome no published value expresses on its own — "the admit
/// went through" when the row would also leave on the next poll.
///
///     @State private var haptic = StarlingsHapticPulse()
///     ...
///     haptic.fire(.success)
///     ...
///     .meetHaptics(haptic)
struct StarlingsHapticPulse: Equatable {
    private(set) var count = 0
    private(set) var kind: StarlingsHaptics?

    mutating func fire(_ kind: StarlingsHaptics) {
        self.kind = kind
        count += 1
    }
}

extension View {
    /// Plays `kind` every time `trigger` changes.
    func meetHaptic<T: Equatable>(_ kind: StarlingsHaptics, trigger: T) -> some View {
        sensoryFeedback(kind.feedback, trigger: trigger)
    }

    /// Plays `kind` when `trigger` becomes non-nil, and stays quiet when it
    /// clears. For notices and error strings: showing one deserves a buzz,
    /// dismissing it does not.
    func meetHaptic<T: Equatable>(_ kind: StarlingsHaptics, whenSet trigger: T?) -> some View {
        sensoryFeedback(trigger: trigger) { _, new in new == nil ? nil : kind.feedback }
    }

    /// Plays the haptic `kind` chooses for a change of `trigger`, or nothing.
    /// For a phase enum where only some transitions are felt.
    func meetHaptic<T: Equatable>(
        trigger: T,
        _ kind: @escaping (_ old: T, _ new: T) -> StarlingsHaptics?
    ) -> some View {
        sensoryFeedback(trigger: trigger) { old, new in kind(old, new)?.feedback }
    }

    /// Plays whatever `pulse` last fired.
    func meetHaptics(_ pulse: StarlingsHapticPulse) -> some View {
        sensoryFeedback(trigger: pulse) { _, new in new.kind?.feedback }
    }
}
