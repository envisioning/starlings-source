import AppKit

extension NSToolbarItem.Identifier {
    static let calendarPrevious = NSToolbarItem.Identifier("meet.calendar.previous")
    static let calendarToday = NSToolbarItem.Identifier("meet.calendar.today")
    static let calendarNext = NSToolbarItem.Identifier("meet.calendar.next")
    static let calendarMode = NSToolbarItem.Identifier("meet.calendar.mode")
    static let calendarSearch = NSToolbarItem.Identifier("meet.calendar.search")
}

@MainActor
final class CalendarWindowController: NSWindowController, NSToolbarDelegate {
    let calendarViewController: CalendarViewController
    private let surfaceSwitcher = StarlingsSurfaceSwitcher(surface: .calendar)

    init(workspace: CalendarWorkspace) {
        let viewController = CalendarViewController(workspace: workspace)
        calendarViewController = viewController
        let window = NSWindow(contentViewController: viewController)
        window.setContentSize(StarlingsSurface.calendar.openingContentSize)
        super.init(window: window)
        StarlingsWindowChrome.apply(
            to: window,
            surface: .calendar,
            toolbarIdentifier: "MeetCalendarToolbar",
            delegate: self
        )
        shouldCascadeWindows = false
        windowFrameAutosaveName = "MeetCalendarWindow"
    }

    /// The shell's bookends — switcher then sidebar toggle leading, inspector
    /// toggle trailing — with Calendar's own items between them. Today, the
    /// view picker and search were once a row *inside* the calendar column,
    /// under an empty titlebar; they are chrome, and they sit in the chrome.
    ///
    /// Which period is on screen is still the window's subtitle, written by
    /// `CalendarViewController.render()`. The titlebar no longer draws it —
    /// the switcher took that slot — but the Window menu, the ⌘-merged tab
    /// bar and Mission Control all read it, so it stays written.
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        StarlingsShellViewController.leadingToolbarItems
            + [.calendarPrevious, .calendarToday, .calendarNext, .flexibleSpace, .calendarMode, .meetNew, .calendarSearch]
            + StarlingsShellViewController.trailingToolbarItems
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }

    func toolbar(
        _ toolbar: NSToolbar,
        itemForItemIdentifier identifier: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar flag: Bool
    ) -> NSToolbarItem? {
        switch identifier {
        case .meetSurfaces:
            return surfaceSwitcher.item()
        case .meetSurfacesDivider:
            return StarlingsSurfaceSwitcher.dividerItem()
        // Previous, Today and Next are icons, as on the web: the day header
        // already says which days are on screen.
        case .calendarPrevious:
            return pagingItem(identifier, symbol: "chevron.left", label: String(localized: "Previous"), toolTip: String(localized: "Previous (⌘←)"), action: #selector(CalendarViewController.goToPreviousPeriod(_:)))
        case .calendarToday:
            return pagingItem(identifier, symbol: "smallcircle.filled.circle", label: String(localized: "Today"), toolTip: String(localized: "Today (⌘T)"), action: #selector(CalendarViewController.goToToday(_:)))
        case .calendarNext:
            return pagingItem(identifier, symbol: "chevron.right", label: String(localized: "Next"), toolTip: String(localized: "Next (⌘→)"), action: #selector(CalendarViewController.goToNextPeriod(_:)))
        case .calendarMode:
            return calendarViewController.modeToolbarItem
        case .meetNew:
            // A click is a new event at the next slot; the menu beside it
            // holds Quick add, which fills one in from a sentence.
            let item = NSMenuToolbarItem(itemIdentifier: identifier)
            item.image = NSImage(systemSymbolName: "plus", accessibilityDescription: String(localized: "New event"))
            item.label = String(localized: "New")
            item.toolTip = String(localized: "New event at the next slot (⌘N)")
            item.target = calendarViewController
            item.action = #selector(CalendarViewController.newEventPressed(_:))
            item.showsIndicator = true
            let menu = NSMenu()
            menu.addItem(
                withTitle: String(localized: "New Event…"),
                action: #selector(CalendarViewController.newEventPressed(_:)),
                keyEquivalent: ""
            ).symbol(.newEvent).target = calendarViewController
            menu.addItem(
                withTitle: String(localized: "Quick Add Event…"),
                action: #selector(CalendarViewController.quickAddPressed(_:)),
                keyEquivalent: ""
            ).symbol(.edit).target = calendarViewController
            item.menu = menu
            return item
        case .calendarSearch:
            return StarlingsSearchField.toolbarItem(identifier, field: calendarViewController.eventSearchField, toolTip: String(localized: "Search events (⌘F). ⌘K searches anything."))
        default:
            return nil
        }
    }

    private func pagingItem(
        _ identifier: NSToolbarItem.Identifier,
        symbol: String,
        label: String,
        toolTip: String,
        action: Selector
    ) -> NSToolbarItem {
        let item = NSToolbarItem(itemIdentifier: identifier)
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
        item.label = label
        item.toolTip = toolTip
        item.target = calendarViewController
        item.action = action
        return item
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// `revealing` opens the window on that event's day with the event
    /// selected; it wins over `createEvent` and `focusToday`.
    func show(
        relativeTo host: NSWindow? = nil,
        createEvent: Bool = false,
        focusToday: Bool = false,
        revealing event: CalendarEventSummary? = nil
    ) {
        guard let window else { return }
        if !window.setFrameUsingName(windowFrameAutosaveName), let host {
            var frame = window.frame
            frame.origin = NSPoint(x: host.frame.maxX + 12, y: host.frame.maxY - frame.height)
            window.setFrame(frame, display: false)
        }
        // Calendar restored a saved frame and checked nothing about it. A
        // frame saved on a display this Mac no longer has came back whole.
        StarlingsWindowMetrics.refresh(window)
        calendarViewController.prepareForOpening(in: window)
        showWindow(nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if let event {
            calendarViewController.reveal(event)
        } else {
            calendarViewController.reloadAndShow(create: createEvent, focusToday: focusToday)
        }
    }
}
