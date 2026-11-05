import AppKit

/// The five places this app has, and the only five windows that are a
/// *destination* rather than a sheet, a panel, or Settings.
///
/// Home is *today* and owns the room/Meet flow, Calendar is the *when*, Work is
/// the *what*, Team the *who*, and Docs what was written down. Each is its
/// own window on purpose — Calendar beside a live call is the reason this is
/// not one tabbed shell — but five windows only read as one app if they wear
/// the same chrome and each one can say where else you could be. That is what
/// this file is: one dresser (`StarlingsWindowChrome`), one switcher
/// (`StarlingsSurfaceSwitcher`), one route (`StarlingsSurfaces`).
///
/// See docs/SURFACES.md §Window chrome.
enum StarlingsSurface: Int, CaseIterable, Sendable {
    case meet
    case calendar
    case work
    case team
    case docs

    /// The shared destination; its order and title are `MEMBER_SURFACES`
    /// (Generated/MemberSurfacesRegistry.swift). The window is `meet` in code
    /// and Home everywhere else.
    var memberSurface: MemberSurface {
        switch self {
        case .meet: .home
        case .calendar: .calendar
        case .work: .work
        case .team: .team
        case .docs: .docs
        }
    }

    var title: String { memberSurface.title }

    /// The surfaces the switcher lists in `window`'s toolbar, in their fixed
    /// order (`SurfaceVisibility`). The window's own
    /// surface is always listed: a link can open Calendar while it is hidden,
    /// and a window always names where it is. Segments are indexed in this
    /// list, never by `rawValue`.
    static func offered(in window: StarlingsSurface) -> [StarlingsSurface] {
        allCases.filter { $0 == window || SurfaceVisibility.isVisible($0.memberSurface) }
    }

    /// SF Symbols, drawn at the toolbar's own size. These are the same semantic
    /// destinations the iOS tab bar and web workspace nav represent: home,
    /// calendar, the work graph, and people.
    var symbolName: String {
        switch self {
        case .meet: return "house.fill"
        case .calendar: return "calendar"
        case .work: return "tray.full.fill"
        case .team: return "person.2.fill"
        case .docs: return "doc.text.fill"
        }
    }

    /// The size a surface *opens* at the first time, before there is a saved
    /// frame to restore. Not a floor — the floor is `StarlingsWindowSizing`, which
    /// each surface answers from what it currently has on screen. This is only
    /// where a window starts.
    var openingContentSize: NSSize {
        switch self {
        case .meet: return NSSize(width: 1180, height: 760)
        case .calendar: return NSSize(width: 1120, height: 720)
        case .work: return NSSize(width: 1120, height: 700)
        case .team: return NSSize(width: 1120, height: 700)
        case .docs: return NSSize(width: 1240, height: 760)
        }
    }

    /// The surface id `docs/help/surfaces/<id>.md` is keyed on. Home is `home`
    /// there, because that is what the window is called everywhere but code.
    var helpID: String {
        switch self {
        case .meet: return "home"
        case .calendar: return "calendar"
        case .work: return "work"
        case .team: return "team"
        case .docs: return "docs"
        }
    }

    /// ⌘ + this digit, from anywhere in the app. The Window menu binds them;
    /// nothing else in Meet may spend ⌘1 to ⌘5, because on this Mac they mean
    /// *which of the five places am I in*. Calendar's day/week/month, which
    /// used to hold them, moved down a tier to ⌃⌘1/⌃⌘2/⌃⌘3.
    var shortcut: String {
        switch self {
        case .meet: return "1"
        case .calendar: return "2"
        case .work: return "3"
        case .team: return "4"
        case .docs: return "5"
        }
    }
}

/// Whether a call is live right now, in the one window that can start or end
/// one. `MeetingViewController.render(phase:)` is the single place a phase
/// change lands, so it is the single writer here; every `StarlingsSurfaceSwitcher`
/// — one per window — reads it to badge Home when a meeting is live, which is how
/// Calendar and Work learn a meeting is running without either being handed a
/// reference to the meeting window.
@MainActor
enum StarlingsSurfaceActivity {
    static let didChangeNotification = Notification.Name("MeetSurfaceActivityDidChange")

    private(set) static var isMeetLive = false

    static func setMeetLive(_ live: Bool) {
        guard isMeetLive != live else { return }
        isMeetLive = live
        NotificationCenter.default.post(name: didChangeNotification, object: nil)
    }
}

extension NSToolbarItem.Identifier {
    /// The switcher. Same identifier, **first item**, in all five windows —
    /// that repetition is the whole point of it.
    ///
    /// First, against the traffic lights, which is the one x every window
    /// shares and nothing inside them can push. Two things had to go for it:
    /// the visible window title, which owns the leading slot in a `.unified`
    /// toolbar and is a different width in each window (`Meet`, `Calendar`,
    /// `Work`, and a subtitle that changes under it), and the sidebar's
    /// tracking separator, which pins what precedes it to the sidebar's
    /// trailing edge and so moved with every collapse. Neither is worth a
    /// switcher that lands somewhere else in every window. What is left is the
    /// iOS tab bar: a strip at one edge, in one order, never rearranged by the
    /// screen it happens to be showing — and the selected segment *is* the
    /// title, exactly as a tab bar's selected item is.
    static let meetSurfaces = NSToolbarItem.Identifier("meet.surfaces")
    /// The hairline after the switcher, before the sidebar toggle — the
    /// switcher is the app's tab bar, and the toggle belongs to the window;
    /// without a line between them the toggle reads as a fifth surface.
    static let meetSurfacesDivider = NSToolbarItem.Identifier("meet.surfaces.divider")
    /// The one `+` a surface gets: first in the trailing run, before
    /// the window's search field, in every window that creates things. The
    /// same identifier in all of them, so the item is at one x the way the
    /// switcher is, and Home, which creates nothing, has no `+` at all.
    static let meetNew = NSToolbarItem.Identifier("meet.new")
}

/// The one place a Meet window is dressed.
///
/// Before this existed each window had grown its own answer: the meeting window
/// drew to the top edge with a hidden title and a gear smuggled into a titlebar
/// accessory, Calendar was a bare box with its own navigation row smuggled into
/// the *content*, and Work was the only one wearing a real unified toolbar. Four
/// windows, four idioms, one app. Everything here is what they now share; a
/// window that wants something else asks for it after `apply`, and says why.
@MainActor
enum StarlingsWindowChrome {
    /// All five surfaces share a tabbing identity, so ⌘-merging them produces
    /// one tabbed window when Use tabs is enabled. Settings and document
    /// pop-outs keep their own independent windows.
    static let tabbingIdentifier = "\(ContractConstants.nativeAppBundleID).surface"

    private static let usesTabsKey = "meet.windows.useTabs"

    static func usesTabs(defaults: UserDefaults = .standard) -> Bool {
        guard defaults.object(forKey: usesTabsKey) != nil else { return true }
        return defaults.bool(forKey: usesTabsKey)
    }

    static func setUsesTabs(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: usesTabsKey)
        let keyWindow = NSApp.keyWindow
        let windows = NSApp.windows.filter {
            $0.tabbingIdentifier == tabbingIdentifier
                && ($0.isVisible || $0.isMiniaturized || ($0.tabbedWindows?.count ?? 0) > 1)
        }
        if !enabled {
            for window in windows {
                // Read only when already tabbed: asking for tabGroup on an
                // independent window can create a group as a side effect.
                if (window.tabbedWindows?.count ?? 0) > 1 {
                    window.tabGroup?.removeWindow(window)
                    window.orderFront(nil)
                }
            }
        }
        for window in NSApp.windows where window.tabbingIdentifier == tabbingIdentifier {
            window.tabbingMode = enabled ? .preferred : .disallowed
        }
        if enabled, let anchor = windows.first(where: { !$0.isMiniaturized }) {
            for window in windows where window !== anchor && !window.isMiniaturized {
                guard !(anchor.tabbedWindows?.contains(where: { $0 === window }) ?? false) else { continue }
                anchor.addTabbedWindow(window, ordered: .above)
            }
        }
        keyWindow?.makeKeyAndOrderFront(nil)
    }

    /// `contentUnderToolbar`: the window's content reaches the top edge and
    /// scrolls under the unified toolbar. A surface that takes this lays its
    /// top out against `safeAreaLayoutGuide`, and its scroll views get their
    /// top inset from AppKit. On macOS 26 the toolbar's glass draws the soft
    /// edge over what scrolls under it; below 26 the surface draws its own
    /// (`StarlingsSoftEdgeView`). Home takes it; the other four still start their
    /// content at the toolbar's bottom edge.
    static func apply(
        to window: NSWindow,
        surface: StarlingsSurface,
        toolbarIdentifier: String,
        delegate: NSToolbarDelegate,
        contentUnderToolbar: Bool = false
    ) {
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        if contentUnderToolbar {
            window.styleMask.insert(.fullSizeContentView)
        }
        window.backgroundColor = StarlingsColors.canvas
        // Still set, and still worth setting: the contextual title and
        // subtitle are what the Window menu, the ⌘-merged tab bar, and Mission
        // Control read. They are only not *drawn* in the titlebar.
        window.title = surface.title
        // Hidden so the toolbar starts at the traffic lights and the switcher
        // is the first thing in it, at the same x in all five windows. A
        // visible unified title takes that slot and is a different width in
        // each — see `.meetSurfaces`. The switcher says which surface this is,
        // the way a tab bar's selected item does.
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = titlebarAppearsTransparent(for: window)
        // Unified: the toolbar is the titlebar's own row rather than a band
        // under it, which is what makes these read as chrome instead of as a
        // band of buttons.
        window.toolbarStyle = .unified
        window.titlebarSeparatorStyle = .automatic
        // A tab group's minimum size is the union of every surface's floor.
        // Keep each pane compressible even when the person chooses tabs.
        window.tabbingMode = usesTabs() ? .preferred : .disallowed
        window.tabbingIdentifier = tabbingIdentifier
        // Both bounds, on every window, always — but neither number is written
        // here. `StarlingsWindowMetrics` asks the surface what it needs right now
        // and asks the screen what there is, because both answers change while
        // the window is open. Applied once here so a window is never briefly
        // unbounded, and again by everything that moves either input.
        // A window with a titlebar is dragged by its titlebar. Only the
        // immersive meeting window, which has none, is dragged by its body.
        window.isMovableByWindowBackground = false

        let toolbar = NSToolbar(identifier: toolbarIdentifier)
        toolbar.delegate = delegate
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        window.toolbar = toolbar
        StarlingsWindowMetrics.refresh(window)
    }

    /// A tab keeps its surface name and adds the selected destination when
    /// there is one: `Work — Project`, `Team — Person`, and so on. The
    /// switcher remains the fixed name of the surface; this title tells the
    /// person which item that surface is currently showing.
    static func setContextTitle(for window: NSWindow?, surface: StarlingsSurface, context: String?) {
        guard let window else { return }
        let context = context?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !context.isEmpty, context != surface.title else {
            window.title = surface.title
            return
        }
        window.title = "\(surface.title) — \(context)"
    }

    /// Whether the native scroll-edge effect exists: macOS 26's Liquid Glass
    /// toolbar draws content passing under it blurred and faded. Below 26 a
    /// surface whose content runs under the toolbar draws its own edge
    /// (`StarlingsSoftEdgeView`).
    static var hasNativeScrollEdge: Bool {
        if #available(macOS 26.0, *) { return true }
        return false
    }

    /// Whether the titlebar lets the window's canvas through.
    ///
    /// Below 26, yes: with an opaque titlebar AppKit paints its own dark
    /// material there, leaving a second shade above the canvas below it. On
    /// 26 a window whose content runs under the toolbar keeps the titlebar
    /// opaque: the toolbar is glass over the content, so the canvas shows
    /// through anyway — and a transparent titlebar is what stops AppKit
    /// from drawing the scroll-edge effect under the toolbar items
    /// (WWDC25 310 "Build an AppKit app with the new design"; the effect
    /// is applied "automatically underneath toolbar items" only when the
    /// titlebar composites over the content).
    static func titlebarAppearsTransparent(for window: NSWindow) -> Bool {
        !(hasNativeScrollEdge && window.styleMask.contains(.fullSizeContentView))
    }

    /// The tab bar wears the canvas, not AppKit's grey.
    ///
    /// On macOS 26 the window tab bar is a glass track
    /// (`NSSubduedGlassEffectView`). Its floor is a `CALayer` named `fill`
    /// under `kCUIVariantContentBackgroundMaterial`, painted a fixed neutral
    /// (#1e1e1e dark) at 0.85 over a blur of the window. Replacing just its
    /// color left that opacity in place, letting page content bleed through the
    /// tab row. Make the fill fully opaque as well, so the tab bar reads as the
    /// canvas between the toolbar and page. `titlebarAppearsTransparent`
    /// and `backgroundColor` do not reach it, and the track has no tint API.
    ///
    /// Repaint that one layer with `StarlingsColors.canvas`, without implicit layer
    /// animations. AppKit rebuilds the track on key changes and appearance
    /// flips, so this runs synchronously from
    /// `StarlingsMacAppearanceController.apply(to:)` before the selected tab draws.
    /// A miss is silent: no tab bar, or a different layer tree on another
    /// macOS, leaves the system look.
    static func tintTabBar(of window: NSWindow) {
        guard let frame = window.contentView?.superview,
              let tabBar = firstView(named: "NSTabBar", under: frame),
              let fill = firstLayer(named: "fill", underParentNamed: "kCUIVariantContentBackgroundMaterial", in: tabBar.layer)
        else { return }
        let canvas = StarlingsColors.resolved(StarlingsColors.canvas, for: window.effectiveAppearance).cgColor
        paint(fill, canvas)
        // Guard the layer itself: AppKit re-sets its grey on the same layer
        // (hover, selection, activation) without any window notification.
        // Observing the fill puts the slate back synchronously, in the same
        // transaction, so the grey is never committed to the screen.
        if tabBarGuard?.layer !== fill {
            tabBarGuard = TabBarFillGuard(layer: fill, window: window)
        }
    }

    fileprivate static func paint(_ fill: CALayer, _ canvas: CGColor) {
        guard fill.backgroundColor != canvas || fill.opacity != 1 else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        fill.backgroundColor = canvas
        fill.opacity = 1
        CATransaction.commit()
    }

    private static var tabBarGuard: TabBarFillGuard?

    private final class TabBarFillGuard {
        weak var layer: CALayer?
        private var observations: [NSKeyValueObservation] = []

        init(layer: CALayer, window: NSWindow) {
            self.layer = layer
            observations = [
                layer.observe(\.backgroundColor, options: [.new]) { [weak window] _, _ in
                    Self.repaint(window)
                },
                layer.observe(\.opacity, options: [.new]) { [weak window] _, _ in
                    Self.repaint(window)
                },
            ]
        }

        private nonisolated static func repaint(_ window: NSWindow?) {
            MainActor.assumeIsolated {
                guard let window, let layer = StarlingsWindowChrome.tabBarGuard?.layer else { return }
                let canvas = StarlingsColors.resolved(StarlingsColors.canvas, for: window.effectiveAppearance).cgColor
                StarlingsWindowChrome.paint(layer, canvas)
            }
        }
    }

    private static func firstView(named name: String, under view: NSView) -> NSView? {
        if String(describing: type(of: view)) == name { return view }
        for subview in view.subviews {
            if let found = firstView(named: name, under: subview) { return found }
        }
        return nil
    }

    private static func firstLayer(named name: String, underParentNamed parent: String, in layer: CALayer?) -> CALayer? {
        guard let layer else { return nil }
        if layer.name == name, layer.superlayer?.name == parent { return layer }
        for sublayer in layer.sublayers ?? [] {
            if let found = firstLayer(named: name, underParentNamed: parent, in: sublayer) { return found }
        }
        return nil
    }

    /// Focus: the stage takes the window, chrome included.
    ///
    /// Deliberately **not** driven by `MeetingPhase`. Being in a meeting is
    /// when you most want the calendar you are talking about and the notes you
    /// are taking, so a call that silently deleted the switcher took the app's
    /// five places away exactly when they were most useful — and made the
    /// window jump twice per meeting. Immersion is a gesture instead: Focus
    /// (⌥⌘F) and Hide Meeting Panel (⌥⌘S) already mean *give the stage the
    /// whole window*, and Full Screen (⌃⌘F) is the real immersive mode and
    /// hides this chrome on its own. This is what Focus does to the titlebar.
    ///
    /// Nothing outside the meeting window may call it: a window with no
    /// switcher cannot say where else you could be, which is only acceptable
    /// while you have asked for exactly that.
    ///
    /// The style mask is not touched: the meeting window has
    /// `.fullSizeContentView` from `apply` in every state, and the stage
    /// answers Focus by moving its top from the safe area to the window's
    /// edge (`MeetingViewController.applyFocusChrome`).
    static func setImmersive(_ immersive: Bool, on window: NSWindow?) {
        guard let window else { return }
        if immersive {
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.isMovableByWindowBackground = true
            window.toolbar?.isVisible = false
        } else {
            // Back to what `apply` chose, not blindly true or false: false
            // painted AppKit's gray titlebar material over the slate canvas
            // on the idle Meet window below 26, and true on 26 removes the
            // scroll-edge effect. This runs on every phase change.
            window.titlebarAppearsTransparent = titlebarAppearsTransparent(for: window)
            window.titleVisibility = .hidden
            window.isMovableByWindowBackground = false
            window.toolbar?.isVisible = true
        }
    }
}

/// The leading toolbar section every surface carries, and its selection.
///
/// One per window, holding which surface that window *is*. Picking another
/// opens it and puts the selection straight back: the control says where you
/// are, and a window whose segment had moved on to somewhere else would be
/// lying about itself.
///
/// It is the **invariant** half of every Meet toolbar and goes first, against
/// the traffic lights. Everything a surface owns for itself — the sidebar and
/// inspector toggles, Today and the chevrons, search — is the variant half and
/// sits after it. Nothing may be added before `.meetSurfaces`, and no tracking
/// separator may precede it.
@MainActor
final class StarlingsSurfaceSwitcher: NSObject {
    private let surface: StarlingsSurface
    /// The live group, kept only to badge Home in place when
    /// `StarlingsSurfaceActivity` changes — `item()` itself is asked for again
    /// only when a toolbar is rebuilt from scratch, not on every phase change.
    private weak var group: NSToolbarItemGroup?
    /// The surfaces `group`'s segments stand for, in segment order.
    private var listed: [StarlingsSurface] = []

    init(surface: StarlingsSurface) {
        self.surface = surface
        super.init()
        // A calendar connected or removed, or Apple Calendar switched, can
        // change which surfaces are listed.
        for name in [StarlingsCalendarSources.didChangeNotification, CalendarSourcePreferences.didChange] {
            NotificationCenter.default.addObserver(self, selector: #selector(surfacesMayHaveChanged), name: name, object: nil)
        }
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(meetActivityDidChange),
            name: StarlingsSurfaceActivity.didChangeNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(meetAppearanceDidChange),
            name: .meetAppearanceDidChange,
            object: nil
        )

        // Auto follows the system appearance without going through Meet's
        // UserDefaults preference notification.
        DistributedNotificationCenter.default.addObserver(
            self,
            selector: #selector(systemAppearanceDidChange),
            name: Notification.Name("AppleInterfaceThemeChangedNotification"),
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        DistributedNotificationCenter.default.removeObserver(self)
    }

    func item() -> NSToolbarItemGroup {
        let listed = StarlingsSurface.offered(in: surface)
        let group = NSToolbarItemGroup(
            itemIdentifier: .meetSurfaces,
            images: listed.map(Self.image(for:)),
            selectionMode: .selectOne,
            labels: listed.map(\.title),
            target: self,
            action: #selector(pick(_:))
        )
        group.label = String(localized: "Surface")
        for (index, destination) in listed.enumerated() {
            group.subitems[index].toolTip = Self.tooltip(for: destination)
        }
        group.selectedIndex = listed.firstIndex(of: surface) ?? -1
        self.group = group
        self.listed = listed
        return group
    }

    /// `.meetSurfacesDivider`: a vertical hairline the height of a toolbar
    /// glyph. A view item rather than `.sidebarTrackingSeparator`, which would
    /// pin the switcher to the sidebar's edge — see
    /// `StarlingsShellViewController.leadingToolbarItems`.
    static func dividerItem() -> NSToolbarItem {
        let line = NSBox()
        line.boxType = .separator
        line.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            line.widthAnchor.constraint(equalToConstant: 1),
            line.heightAnchor.constraint(equalToConstant: 20),
        ])
        let item = NSToolbarItem(itemIdentifier: .meetSurfacesDivider)
        item.view = line
        item.label = ""
        item.isNavigational = false
        return item
    }

    @objc private func pick(_ sender: NSToolbarItemGroup) {
        let picked = listed.indices.contains(sender.selectedIndex) ? listed[sender.selectedIndex] : surface
        sender.selectedIndex = listed.firstIndex(of: surface) ?? -1
        guard picked != surface else { return }
        StarlingsSurfaces.open(picked)
    }

    /// Puts a new switcher in place when the listed surfaces changed: the
    /// toolbar asks its delegate for `.meetSurfaces` again, which is `item()`.
    @objc private func surfacesMayHaveChanged() {
        guard let group, let toolbar = group.toolbar,
              StarlingsSurface.offered(in: surface) != listed,
              let index = toolbar.items.firstIndex(where: { $0.itemIdentifier == .meetSurfaces }) else { return }
        toolbar.removeItem(at: index)
        toolbar.insertItem(withItemIdentifier: .meetSurfaces, at: index)
    }

    /// Fires in every window's switcher, not only the one on screen — a
    /// meeting started while Work is in front still has to show up there.
    @objc private func meetActivityDidChange() {
        refreshMeetImage()
    }

    @objc private func meetAppearanceDidChange() {
        refreshMeetImage()
    }

    @objc private func systemAppearanceDidChange() {
        refreshMeetImage()
    }

    private func refreshMeetImage() {
        guard let group, let meetIndex = listed.firstIndex(of: .meet) else { return }
        let item = group.subitems[meetIndex]
        item.image = Self.image(for: .meet)
        item.toolTip = Self.tooltip(for: .meet)
    }

    private static func tooltip(for destination: StarlingsSurface) -> String {
        let base = "\(destination.title) (⌘\(destination.shortcut))"
        guard destination == .meet, StarlingsSurfaceActivity.isMeetLive else { return base }
        return String(localized: "\(base) — Live")
    }

    private static func image(for destination: StarlingsSurface) -> NSImage {
        let base = NSImage(systemSymbolName: destination.symbolName, accessibilityDescription: destination.title)
            ?? NSImage()
        guard destination == .meet, StarlingsSurfaceActivity.isMeetLive else { return base }
        return liveBadged(base)
    }

    /// A fixed red dot at the glyph's top-trailing corner, the same read as a
    /// phone's in-call status pill. It is baked onto the glyph rather than
    /// added as a sibling view because `NSToolbarItemGroup` only takes one
    /// image per segment — and it is not itself a template image: the dot
    /// stays red whether or not the segment is selected, the way an unread
    /// badge never picks up the control's own tint. iconOnly segmented
    /// controls render every glyph in the same fixed tint regardless of
    /// selection (only the background pill changes), so recoloring the whole
    /// glyph to `labelColor` here reads the same as the untouched template
    /// glyphs beside it.
    private static func liveBadged(_ base: NSImage) -> NSImage {
        let size = base.size
        let result = NSImage(size: size)
        result.lockFocus()
        // `lockFocus()` rasterizes the image outside the toolbar's drawing
        // context. Resolve the dynamic colour explicitly; otherwise
        // `labelColor` can resolve to black even while the window is dark.
        StarlingsColors.resolved(NSColor.labelColor, for: NSApp.effectiveAppearance).set()
        NSRect(origin: .zero, size: size).fill()
        base.draw(at: .zero, from: .zero, operation: .destinationIn, fraction: 1)
        let diameter = max(5, size.width * 0.34)
        let dot = NSRect(
            x: size.width - diameter,
            y: size.height - diameter,
            width: diameter,
            height: diameter
        )
        // A clear ring cut out of the glyph around the dot, so the dot reads
        // as its own chip and never as part of the icon, the way
        // the web's badge wears a ring in the bar's colour.
        if let context = NSGraphicsContext.current {
            let previous = context.compositingOperation
            context.compositingOperation = .clear
            NSBezierPath(ovalIn: dot.insetBy(dx: -1.5, dy: -1.5)).fill()
            context.compositingOperation = previous
        }
        StarlingsColors.danger.set()
        NSBezierPath(ovalIn: dot).fill()
        result.unlockFocus()
        return result
    }
}

/// The one route between surfaces.
///
/// `MainWindowController` owns all five windows, so it is the router whether
/// or not anything says so. This names it, and resolves it the way
/// `MeetingMenuTarget` already resolves the meeting: through the app delegate,
/// so a toolbar item does not have to be handed a controller reference it would
/// then have to keep weak.
@MainActor
enum StarlingsSurfaces {
    private static var controller: MainWindowController? {
        (NSApp.delegate as? AppDelegate)?.mainWindowController
    }

    static func open(_ surface: StarlingsSurface) {
        guard let controller else { return }
        switch surface {
        case .meet: controller.showHome()
        case .calendar: controller.showCalendar(nil)
        case .work: controller.showWork(nil)
        case .team: controller.showTeam(nil)
        case .docs: controller.showDocs(nil)
        }
    }
}
