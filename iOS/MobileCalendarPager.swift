import SwiftUI

/// Three periods side by side, moved by the finger.
///
/// The point is that a swipe is never a data swap. The previous and next
/// periods are built and laid out before the gesture starts, so what arrives
/// during the drag is the real thing — half of next week visible next to half
/// of this one — and letting go only finishes a movement that already happened.
/// The page either side is why `MobileCalendarStore.loadedRange` covers three
/// periods rather than one.
///
/// After a page settles, the anchor moves and the strip re-centres in the same
/// frame with animation explicitly off, so the recentre is invisible.
struct MobileCalendarPager<Page: View>: View {
    /// Builds the period `offset` steps from the anchor: -1, 0, or 1.
    @ViewBuilder let page: (Int) -> Page
    /// Called once a page has settled, with the direction travelled.
    let onSettle: (Int) -> Void

    @StateObject private var motion = MobileCalendarPageMotion()

    var body: some View {
        GeometryReader { proxy in
            MobileCalendarPageStrip(
                motion: motion,
                width: proxy.size.width,
                onSettle: onSettle,
                page: page
            )
        }
        .clipped()
    }
}

/// The three built pages, laid side by side and moved by `motion`.
///
/// Separate from the pager so the motion can be owned from outside — the strip
/// is only ever the moving part, never the thing that decides where a period is.
struct MobileCalendarPageStrip<Page: View>: View {
    @ObservedObject var motion: MobileCalendarPageMotion
    let width: CGFloat
    let onSettle: (Int) -> Void
    @ViewBuilder let page: (Int) -> Page

    var body: some View {
        HStack(spacing: 0) {
            page(-1).frame(width: width)
            page(0).frame(width: width)
            page(1).frame(width: width)
        }
        .offset(x: -width + motion.drag)
        // The strip is three pages wide, so it has to be pinned to the leading
        // edge of a one-page window and clipped there. Centring it — which is
        // what a bare width frame does — shows the wrong page and lets the
        // neighbours bleed out either side.
        .frame(width: width, alignment: .leading)
        .clipped()
        .background(MobileCalendarPageDrag(
            onChanged: { motion.dragged($0, width: width) },
            onEnded: { translation, velocity in
                motion.finished(translation, velocity: velocity, width: width, onSettle: onSettle)
            }
        ))
    }
}

/// The page gesture, as a UIKit pan.
///
/// A SwiftUI `DragGesture` here claims the touch as soon as it passes its
/// minimum distance, whatever direction it went — and a vertical drag it then
/// ignores is a vertical drag the scroll view never gets. That is what made
/// scrolling the grid feel spotty: a quick flick beat the gesture, a slower
/// drag did not. A `UIPanGestureRecognizer` can decline the touch outright when
/// the movement is more vertical than horizontal, which leaves the scroll view
/// to do what it was always going to do.
struct MobileCalendarPageDrag: UIViewRepresentable {
    let onChanged: (CGFloat) -> Void
    let onEnded: (CGFloat, CGFloat) -> Void

    func makeUIView(context: Context) -> HostReporter {
        // Never a touch target itself: the recognizer goes on the view above,
        // so cards keep their own taps and presses.
        let view = HostReporter()
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = false
        let coordinator = context.coordinator
        // Attaching when SwiftUI updates is too early — there is no superview
        // yet, and no second chance. Entering the hierarchy is the moment.
        view.onEnterHierarchy = { [weak coordinator] host in
            coordinator?.attach(to: host)
        }
        return view
    }

    func updateUIView(_ uiView: HostReporter, context: Context) {
        context.coordinator.owner = self
        context.coordinator.attach(to: uiView.superview)
    }

    /// Says when it has a superview to hang a recognizer on.
    final class HostReporter: UIView {
        var onEnterHierarchy: ((UIView) -> Void)?

        override func didMoveToSuperview() {
            super.didMoveToSuperview()
            guard let superview else { return }
            onEnterHierarchy?(superview)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var owner: MobileCalendarPageDrag?
        private weak var host: UIView?
        private weak var pan: UIPanGestureRecognizer?
        private weak var heldScrollView: UIScrollView?

        func attach(to view: UIView?) {
            // The scroll view is the one ancestor guaranteed to contain every
            // card and every empty patch of the grid, so a swipe that starts on
            // any of them reaches this. Outside a scroll view — the fixed date
            // strip — the immediate host does the same job for its own area.
            guard let host = view.flatMap({ Self.enclosingScrollView(of: $0) ?? $0 }),
                  self.host !== host
            else { return }
            if let pan { self.host?.removeGestureRecognizer(pan) }
            let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
            pan.delegate = self
            host.addGestureRecognizer(pan)
            self.pan = pan
            self.host = host
        }

        /// Sideways only. Anything more vertical than horizontal is the grid
        /// being scrolled, and declining it here is what hands the touch back.
        nonisolated func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            MainActor.assumeIsolated {
                guard let pan = recognizer as? UIPanGestureRecognizer else { return true }
                let velocity = pan.velocity(in: pan.view)
                return abs(velocity.x) > abs(velocity.y)
            }
        }

        nonisolated func gestureRecognizer(
            _ recognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool {
            true
        }

        @objc func panned(_ pan: UIPanGestureRecognizer) {
            let translation = pan.translation(in: pan.view).x
            switch pan.state {
            case .began:
                // One axis at a time: a page turn must not also scroll the day.
                if let scroll = Self.enclosingScrollView(of: pan.view) {
                    heldScrollView = scroll
                    scroll.isScrollEnabled = false
                }
                owner?.onChanged(translation)
            case .changed:
                owner?.onChanged(translation)
            case .ended, .cancelled, .failed:
                heldScrollView?.isScrollEnabled = true
                heldScrollView = nil
                owner?.onEnded(translation, pan.velocity(in: pan.view).x)
            default:
                break
            }
        }

        private static func enclosingScrollView(of view: UIView?) -> UIScrollView? {
            var next = view
            while let current = next {
                if let scroll = current as? UIScrollView { return scroll }
                next = current.superview
            }
            return nil
        }
    }
}

/// Where a strip has been dragged to, and the physics that put it back.
@MainActor
final class MobileCalendarPageMotion: ObservableObject {
    @Published var drag: CGFloat = 0

    private var isSettling = false

    /// Carry the strip with the finger.
    func dragged(_ translation: CGFloat, width: CGFloat) {
        guard !isSettling else { return }
        // Rubber-band at the edges of the three built pages so a fast flick
        // cannot drag emptiness into view.
        drag = Self.rubberBanded(translation, width: width)
    }

    /// Let go: past a third of a page, or thrown hard enough, the period moves.
    func finished(
        _ translation: CGFloat,
        velocity: CGFloat,
        width: CGFloat,
        onSettle: @escaping (Int) -> Void
    ) {
        guard !isSettling else { return }
        // A short flick counts: pick up the throw, not just the distance.
        let direction: Int
        if translation < -width / 3 || velocity < -600 {
            direction = 1
        } else if translation > width / 3 || velocity > 600 {
            direction = -1
        } else {
            direction = 0
        }
        settle(direction: direction, width: width, onSettle: onSettle)
    }

    private func settle(direction: Int, width: CGFloat, onSettle: @escaping (Int) -> Void) {
        guard direction != 0 else {
            withAnimation(.interactiveSpring(response: 0.28, dampingFraction: 0.86)) { drag = 0 }
            return
        }
        isSettling = true
        withAnimation(.interactiveSpring(response: 0.32, dampingFraction: 0.88)) {
            drag = -CGFloat(direction) * width
        }
        // Re-anchor once the movement has played, then put the strip back to
        // centre with animation off — the same content, in the same place.
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(320))
            onSettle(direction)
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { drag = 0 }
            isSettling = false
        }
    }

    /// Past a whole page in either direction the strip has nothing more to show,
    /// so it resists rather than tearing.
    private static func rubberBanded(_ translation: CGFloat, width: CGFloat) -> CGFloat {
        guard abs(translation) > width else { return translation }
        let overshoot = abs(translation) - width
        return (translation < 0 ? -1 : 1) * (width + overshoot * 0.25)
    }
}
