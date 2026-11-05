import AppKit

/// Applies the preference to the AppKit process and nudges custom layer-backed
/// surfaces to resolve their semantic colours again after a live switch.
@MainActor
final class StarlingsMacAppearanceController {
    private var preferenceObserver: NSObjectProtocol?
    private var windowObserver: NSObjectProtocol?
    private var systemObserver: NSObjectProtocol?
    private var tabBarObservers: [NSObjectProtocol] = []
    private var mode: StarlingsAppearanceMode = .auto

    func start() {
        apply(StarlingsAppearanceSettings.mode())
        guard preferenceObserver == nil, windowObserver == nil, systemObserver == nil else { return }

        preferenceObserver = NotificationCenter.default.addObserver(
            forName: .meetAppearanceDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.apply(StarlingsAppearanceSettings.mode())
            }
        }

        // Main, Calendar, Work, Settings, and transient OAuth windows are
        // created lazily. A newly-created window may have already resolved its
        // custom layers against the process default before it becomes visible,
        // so give every window the same treatment as a live mode switch.
        windowObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didBecomeKeyNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            // AppKit can rebuild the macOS 26 tab bar as part of selecting a
            // tab. Repaint in this notification, before the first frame; a
            // Task hop lets its neutral default fill show through.
            MainActor.assumeIsolated {
                self?.refreshAllWindows()
            }
        }

        // AppKit rebuilds the tab track (and repaints its neutral grey fill)
        // for reasons key-window changes never see: tab selection, ⌘-merge,
        // hover, resize, the window going inactive. `didUpdate` is the
        // per-event-loop-pass hook that runs before the frame is drawn, so
        // the slate is put back in the same pass. `tintTabBar` is a no-op
        // when the fill is already right or the window has no bar. It never reads
        // `window.tabGroup`: that getter can create a group and change tabbing.
        let tabBarEvents: [Notification.Name] = [
            NSWindow.didUpdateNotification,
            NSWindow.didResizeNotification,
            NSWindow.didBecomeMainNotification,
            NSWindow.didResignKeyNotification,
            NSWindow.didResignMainNotification,
            NSWindow.didChangeScreenNotification,
        ]
        tabBarObservers = tabBarEvents.map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { note in
                guard let window = note.object as? NSWindow else { return }
                MainActor.assumeIsolated {
                    StarlingsWindowChrome.tintTabBar(of: window)
                }
            }
        }

        // AppKit does not expose a public application-level appearance-change
        // notification on every macOS SDK we build with. This is the system
        // notification emitted when Auto follows the user's macOS setting.
        systemObserver = DistributedNotificationCenter.default.addObserver(
            forName: Notification.Name("AppleInterfaceThemeChangedNotification"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard self?.mode == .auto else { return }
                self?.refreshAllWindows()
            }
        }
    }

    /// Apply the already-selected mode before a newly-created window is shown.
    ///
    /// The key-window notification is intentionally kept as a safety net for
    /// lazily-created surfaces, but it is too late for the first frame: custom
    /// Meet layers are otherwise born with the process's previous appearance
    /// and visibly catch up after the launch window is on screen.
    func prepare(window: NSWindow?) {
        guard let window else { return }
        apply(to: window)
    }

    private func apply(_ mode: StarlingsAppearanceMode) {
        self.mode = mode
        switch mode {
        case .auto:
            NSApp.appearance = nil
        case .light:
            NSApp.appearance = NSAppearance(named: .aqua)
        case .dark:
            NSApp.appearance = NSAppearance(named: .darkAqua)
        }
        refreshAllWindows()
    }

    private func refreshAllWindows() {
        for window in NSApp.windows {
            apply(to: window)
        }
    }

    private func apply(to window: NSWindow) {
        let override: NSAppearance?
        switch mode {
        case .auto:
            override = nil
        case .light:
            override = NSAppearance(named: .aqua)
        case .dark:
            override = NSAppearance(named: .darkAqua)
        }

        // Window-level inheritance is the important part here. AppKit controls
        // and dynamic NSColors resolve from the window, while a number of Meet
        // views also hold fixed CGColors in their layers.
        window.appearance = override
        window.contentView?.appearance = override
        guard let contentView = window.contentView else { return }
        StarlingsColors.refreshLayers(
            in: contentView,
            toDark: StarlingsColors.isDark(window.effectiveAppearance)
        )
        contentView.needsDisplay = true
        contentView.needsLayout = true
        // The tab bar sits above `contentView`, in the titlebar; see
        // `StarlingsWindowChrome.tintTabBar`.
        StarlingsWindowChrome.tintTabBar(of: window)
    }
}
