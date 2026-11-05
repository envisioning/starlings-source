import Foundation
import Network
#if os(macOS)
import AppKit
#endif

/// Tells the outbox when a retry has a chance to succeed: the network path
/// became satisfied after it was not, or (Mac only) the Mac woke from sleep.
///
/// One rule for both clients ( on iOS on the Mac). The
/// trigger is an edge, not a level: the first path update after `start` is the
/// baseline, and a path that stays satisfied fires nothing. A meeting that ends
/// offline writes its row after the last read of the count, so the caller
/// retries every pending meeting, not only the ones it knows about.
@MainActor
final class ConnectivityRecovery {
    private let onRecover: @MainActor () -> Void
    // Cancelled in the nonisolated deinit; not touched elsewhere off-main.
    nonisolated(unsafe) private var monitor: NWPathMonitor?
    nonisolated(unsafe) private var wakeObserver: NSObjectProtocol?
    private var pathWasSatisfied = true

    init(onRecover: @escaping @MainActor () -> Void) {
        self.onRecover = onRecover
    }

    func start() {
        guard monitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            Task { @MainActor [weak self] in self?.pathChanged(satisfied: satisfied) }
        }
        monitor.start(queue: DispatchQueue(label: "meet.connectivity-recovery"))
        self.monitor = monitor
        #if os(macOS)
        // A Mac sleeps with the lid closed for hours and wakes on the same
        // network, so the path may never read unsatisfied. The wake is the
        // edge there.
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.onRecover() }
        }
        #endif
    }

    private func pathChanged(satisfied: Bool) {
        let recovered = satisfied && !pathWasSatisfied
        pathWasSatisfied = satisfied
        if recovered { onRecover() }
    }

    deinit {
        monitor?.cancel()
        #if os(macOS)
        if let wakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver)
        }
        #endif
    }
}
