import SwiftUI
import UIKit

/// The passing word on the phone: one glass capsule at the bottom of the
/// screen, gone on its own. See docs/DESIGN.md, "Toast — the passing word",
/// for when a toast is the right thing to say.
///
/// One at a time: a second toast replaces the first rather than stacking.
/// Neutral toasts last `neutralDuration`; a danger toast draws through
/// `StarlingsErrorNotice`, so it reads red with Copy, and stays `dangerDuration`.
/// A tap dismisses either.
///
/// Views say it through the environment (`@Environment(\.meetToast)`), which
/// the app root binds to `StarlingsToastCenter.shared`. Stores and other non-view
/// code call the center directly.
@MainActor
final class StarlingsToastCenter: ObservableObject {
    static let shared = StarlingsToastCenter()

    static let neutralDuration: Duration = .seconds(3)
    static let dangerDuration: Duration = .seconds(8)
    /// Long enough to read the line and reach for the button.
    static let actionDuration: Duration = .seconds(6)

    /// A word on the capsule that does something, such as Open on "Sent to
    /// Vocab". Tapping it runs `run` and dismisses the toast.
    struct Action {
        let title: String
        let run: @MainActor () -> Void
    }

    struct Item: Identifiable, Equatable {
        let id = UUID()
        let text: String
        let tone: StarlingsToastTone
        var action: Action?

        static func == (lhs: Item, rhs: Item) -> Bool { lhs.id == rhs.id }
    }

    @Published private(set) var current: Item?

    /// Depths of the hosts currently mounted — the same ladder
    /// `MobileAlertHost` climbs, and for the same reason: a sheet inherits the
    /// environment, and the deepest host on screen is the one that presents.
    private var hostDepths: [Int: Int] = [:]
    var topHostDepth: Int? { hostDepths.keys.max() }

    func show(_ text: String, tone: StarlingsToastTone = .neutral, action: Action? = nil) {
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty else { return }
        current = Item(text: line, tone: tone, action: action)
        // Announced once, here, rather than by each host: every tab keeps a
        // host mounted, and five announcements are not one toast.
        UIAccessibility.post(notification: .announcement, argument: line)
    }

    func dismiss(_ item: Item) {
        if current == item { current = nil }
    }

    func registerHost(depth: Int) { hostDepths[depth, default: 0] += 1 }

    func unregisterHost(depth: Int) {
        guard let count = hostDepths[depth] else { return }
        if count <= 1 { hostDepths[depth] = nil } else { hostDepths[depth] = count - 1 }
    }
}

extension StarlingsToastAction {
    static let platformDefault = StarlingsToastAction { text, tone in
        StarlingsToastCenter.shared.show(text, tone: tone)
    }
}

/// Where a toast is allowed to appear. Applied at every root that presents —
/// each tab's content (so the capsule sits above the tab bar, not on it), and
/// the root of every sheet and cover (`meetAlertHost` applies it for you).
/// Exactly one presents: the deepest host currently on screen.
private struct StarlingsToastHost: ViewModifier {
    @ObservedObject private var center = StarlingsToastCenter.shared
    @Environment(\.meetAlertDepth) private var depth
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .onAppear { center.registerHost(depth: depth) }
            .onDisappear { center.unregisterHost(depth: depth) }
            .overlay(alignment: .bottom) {
                if let item = center.current, center.topHostDepth == depth {
                    StarlingsToastCapsule(item: item)
                        .padding(.bottom, 24)
                        .padding(.horizontal, 24)
                        .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                        .id(item.id)
                }
            }
            .animation(.default, value: center.current)
            .task(id: center.current?.id) {
                guard let item = center.current else { return }
                try? await Task.sleep(for: item.tone == .danger
                    ? StarlingsToastCenter.dangerDuration
                    : item.action != nil ? StarlingsToastCenter.actionDuration : StarlingsToastCenter.neutralDuration)
                center.dismiss(item)
            }
    }
}

private struct StarlingsToastCapsule: View {
    let item: StarlingsToastCenter.Item
    @ObservedObject private var center = StarlingsToastCenter.shared

    var body: some View {
        Group {
            switch item.tone {
            case .neutral:
                HStack(spacing: 12) {
                    Text(item.text)
                        .font(.footnote.weight(.medium))
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                    if let action = item.action {
                        Button(action.title) {
                            center.dismiss(item)
                            action.run()
                        }
                        .font(.footnote.weight(.semibold))
                        .buttonStyle(.meetPlain)
                        .foregroundStyle(StarlingsMobileColors.accent)
                    }
                }
            case .danger:
                StarlingsErrorNotice(message: item.text, alignment: .center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .meetFloatingGlass(.regularMaterial, in: Capsule())
        .contentShape(Capsule())
        .onTapGesture { center.dismiss(item) } // hover: tap-anywhere dismiss is a convenience, not a control; the action inside is .meetPlain
        .accessibilityAddTraits(.updatesFrequently)
    }
}

extension View {
    func meetToastHost() -> some View { modifier(StarlingsToastHost()) }
}
