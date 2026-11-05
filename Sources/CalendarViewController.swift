import AppKit

@MainActor
final class CalendarViewController: StarlingsShellViewController {
    /// A month grid stops reading before a task list does: six week rows and
    /// a day header need the height, so Calendar keeps a taller floor than the
    /// shell's default.
    override class var minimumContentHeight: CGFloat { 560 }

    var roomContext: (() -> (slug: String, joinURL: String)?)?
    /// A layer row's way into Work. The window that owns Work
    /// opens the destination; Calendar only names it.
    var onOpenWork: ((WorkDestination) -> Void)? {
        didSet { inspectorHost.layerDetail.onOpenWork = onOpenWork }
    }
    /// The people the invite field completes from — the Envisioning roster
    /// and known contacts. Owned by the app, which has the roster; the
    /// calendar only asks.
    var inviteeSuggestions: (() -> [(email: String, name: String)])? {
        didSet { inspector.inviteeSuggestions = inviteeSuggestions }
    }
    /// The workspace's contacts that hold any of these addresses,
    /// nil when the read failed. Owned by the app, which has the session.
    var contactLookup: (([String]) async -> [CrmContact]?)? {
        didSet { inspector.contactLookup = contactLookup }
    }

    private let workspace: CalendarWorkspace
    private let sidebar = CalendarSidebarView()
    /// The third column, and the form inside it.
    private let inspectorHost = CalendarInspectorViewController()
    private var inspector: CalendarInspectorView { inspectorHost.inspector }
    private let grid = CalendarWeekGridView()
    private let monthGrid = CalendarMonthGridView()
    private let monthWeekdayStack = NSStackView()
    /// Day / Week / Month, as a toolbar item rather than a control in the
    /// content. Owned here because the state it shows is here: `show(mode:)`
    /// is the one place that moves the selection, whether the request came
    /// from this control, from ⌘1/⌘2/⌘3, or from opening a day in month view.
    /// Labels and shortcuts come from `CalendarViewMode`, so this control and
    /// the View menu cannot disagree about what a mode is called.
    private(set) lazy var modeToolbarItem: NSToolbarItemGroup = {
        let group = NSToolbarItemGroup(
            itemIdentifier: .calendarMode,
            titles: CalendarViewMode.allCases.map(\.label),
            selectionMode: .selectOne,
            labels: CalendarViewMode.allCases.map(\.label),
            target: self,
            action: #selector(modeChanged(_:))
        )
        group.label = String(localized: "View")
        group.selectedIndex = CalendarViewMode.allCases.firstIndex(of: mode) ?? 1
        return group
    }()
    private let allDay = CalendarAllDayStripView()
    private let statusLabel = StarlingsNoticeView()
    /// A confirmation that clears itself; outranked only by a real error.
    private let searchField = StarlingsSearchField()
    /// Handed to the window's toolbar item. The field itself stays
    /// this controller's — ⌘F and Return-to-next-match both talk to it.
    var eventSearchField: StarlingsSearchField { searchField }
    private var searchQuery = ""
    private let dayHeader = CalendarDayHeaderStripView()
    private let scrollView = NSScrollView()
    private var gridHeight: NSLayoutConstraint?
    private var mode: CalendarViewMode = .week
    /// Start of the period on screen. Its meaning follows `mode`.
    private var anchor: Date
    /// The one day the window is pointed at. The grid shows a period; this is
    /// the day inside it the sidebar is about, and it is always one of the days
    /// on screen — that invariant is what keeps the two in step.
    private var focusedDay: Date
    /// The day the agenda was last built from, so a re-render for any other
    /// reason does not yank the list out from under a reader's scroll.
    private var selectedEventID: String?
    private var editingEvent: StarlingsCalendarEvent?
    private var nowTimer: Timer?
    private var pollTimer: Timer?
    private var wakeObservers: [NSObjectProtocol] = []
    private var externalChangeTask: Task<Void, Never>?
    private var weatherTask: Task<Void, Never>?
    /// Shown in the status line only when nothing more important is there.
    private var weatherStatus: String?
    /// Kept so a weather result landing between renders can rebuild the
    /// status line without forcing a full re-render.
    private var lastMatchCount = 0
    private var weatherObserver: NSObjectProtocol?
    private var sourcesObserver: NSObjectProtocol?
    private var mergedCalendarIDs: [String: [String]] = [:]
    /// Held so month mode can hide the timed-view chrome.
    private var headerRow: NSStackView?
    /// Selection to apply once the reload that will contain it finishes.
    private var pendingSelectionID: String?

    init(workspace: CalendarWorkspace) {
        self.workspace = workspace
        mode = CalendarWindowPreferences.defaultView()
        anchor = Calendar.current.startOfDay(for: Date())
        focusedDay = Calendar.current.startOfDay(for: Date())
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// The shell's three columns: Calendar's rail, the period on screen, and
    /// the event being read. Everything built here is the middle one.
    override func viewDidLoad() {
        super.viewDidLoad()
        let detail = NSView()
        detail.wantsLayer = true
        detail.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.canvas, for: detail).cgColor

        statusLabel.hidesWhenEmpty = false
        statusLabel.label.allowSqueezing()
        statusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        // "Search", in both windows — what it searches is the window you are
        // in, and the tooltip says it. See docs/SURFACES.md §Window chrome.
        searchField.configure(
            placeholder: String(localized: "Search"),
            target: self,
            action: #selector(searchChanged)
        )

        // Search summaries, weather, and the confirmations that clear
        // themselves. It reads under the calendar rather than beside the
        // navigation now, which is where a Mac keeps a status line — and where
        // it no longer competes with the controls for the top of the window.
        let status = NSStackView(views: [statusLabel, NSView()])
        status.orientation = .horizontal
        status.alignment = .centerY
        status.spacing = 0

        monthWeekdayStack.orientation = .horizontal
        monthWeekdayStack.distribution = .fillEqually
        monthWeekdayStack.spacing = 0
        monthWeekdayStack.heightAnchor.constraint(equalToConstant: 18).isActive = true
        renderMonthWeekdayHeader()

        // The header strip draws its own gutter column so it can slide with the
        // grid instead of being a stack pinned beside one.
        let headerRow = NSStackView(views: [dayHeader])
        self.headerRow = headerRow
        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.spacing = 0
        dayHeader.heightAnchor.constraint(equalToConstant: 52).isActive = true

        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        let clip = CalendarFlippedClipView()
        clip.drawsBackground = false
        scrollView.contentView = clip
        scrollView.documentView = grid
        grid.translatesAutoresizingMaskIntoConstraints = false

        // The other half of the tie: the grid moves the list when it crosses a
        // day, and the list moves the grid when the reader scrolls it. Reported
        // on settle, so a flick lands on one period rather than paging through
        // every week it passed.
        sidebar.agenda.onFocusDay = { [weak self] day in
            self?.focus(day)
        }
        sidebar.onToggleAccount = { [weak self] group, hidden in
            guard let self else { return }
            self.workspace.setAccountHidden(group, hidden: hidden)
            self.render()
        }
        sidebar.onToggle = { [weak self] id, hidden in
            self?.workspace.setHidden(id, hidden: hidden)
            self?.render()
        }
        sidebar.onSetWriteCalendar = { [weak self] id in
            self?.workspace.writeCalendarID = id
            self?.render()
        }
        sidebar.onRequestEventKit = { [weak self] in
            Task { await self?.reload() }
        }
        sidebar.onRemoveGoogleAccount = { [weak self] id in
            Task { await self?.confirmRemoveGoogleAccount(id: id) }
        }
        sidebar.onRemoveSubscription = { [weak self] id in
            Task { await self?.confirmUnsubscribe(id: id) }
        }
        sidebar.agenda.colorForCalendar = { [weak self] id in
            self?.workspace.color(for: id) ?? StarlingsRGBColor.fallback(at: 0)
        }
        // The agenda does not move the day it is showing: the list would jump
        // out from under the very click that picked a row on it.
        sidebar.onSelectEvent = { [weak self] id in self?.highlightEvent(id: id, followDay: false) }
        sidebar.isLayerHidden = { [weak self] kind in self?.workspace.isHidden(kind) ?? false }
        sidebar.onToggleLayer = { [weak self] kind, hidden in
            guard let self else { return }
            self.workspace.setHidden(kind, hidden: hidden)
            // Hiding a layer stops fetching it, so this needs a reload.
            Task { await self.reload() }
        }
        sidebar.onActivateEvent = { [weak self] event in
            // Double-click on an agenda row: go to the day it lives on, and
            // open it there — anchored to the real block rather than to the
            // middle of a grid it might not even be on.
            self?.show(mode: .day, anchor: event.start)
            self?.selectEvent(id: event.id)
        }

        grid.colorForCalendar = { [weak self] id in
            self?.workspace.color(for: id) ?? StarlingsRGBColor.fallback(at: 0)
        }
        grid.onSelect = { [weak self] id in self?.selectEvent(id: id) }
        grid.onCreate = { [weak self] start, end in self?.beginCreate(start: start, end: end) }
        grid.onMove = { [weak self] event, start, end in
            Task { await self?.persistMove(event, start: start, end: end) }
        }
        grid.onDuplicate = { [weak self] event, start, end in
            Task { await self?.persistDuplicate(event, start: start, end: end) }
        }
        grid.onScrollSettled = { [weak self] shiftDays in self?.shiftDays(shiftDays) }
        grid.onDayOffsetChange = { [weak self] offset in
            // The columns, their headers and the all-day band are one picture;
            // sliding the grid alone left the dates behind the wrong days.
            self?.dayHeader.dayOffset = offset
            self?.allDay.dayOffset = offset
        }
        grid.onPagePeriod = { [weak self] direction in self?.page(direction) }
        grid.onContextMenu = { [weak self] event in self?.contextMenu(for: event) }
        grid.onHighlight = { [weak self] id in self?.highlightEvent(id: id) }
        grid.onSlotContextMenu = { [weak self] start, end in self?.slotContextMenu(start: start, end: end) }
        dayHeader.onSelectDay = { [weak self] day in self?.focus(day) }
        dayHeader.onOpenDay = { [weak self] day in self?.show(mode: .day, anchor: day) }
        dayHeader.onSecondaryZoneChange = { [weak self] zone in
            CalendarWindowPreferences.setSecondaryTimeZone(zone)
            self?.applySecondaryTimeZone()
        }
        monthGrid.onSlotContextMenu = { [weak self] start, end in self?.slotContextMenu(start: start, end: end) }
        grid.onLayerContextMenu = { [weak self] item in self?.layerContextMenu(for: item) }
        allDay.onLayerContextMenu = grid.onLayerContextMenu
        monthGrid.onLayerContextMenu = grid.onLayerContextMenu
        allDay.onHighlight = { [weak self] id in self?.highlightEvent(id: id) }
        monthGrid.onHighlight = { [weak self] id in self?.highlightEvent(id: id) }
        grid.onHourHeightChange = { [weak self] height in
            guard let self else { return }
            // Explicit `self.`: `viewDidLoad` has a local `gridHeight` of its own.
            self.gridHeight?.constant = CGFloat(grid.hourSpan) * height
            view.layoutSubtreeIfNeeded()
            CalendarWindowPreferences.setHourHeight(height)
        }
        allDay.onContextMenu = { [weak self] event in self?.contextMenu(for: event) }
        monthGrid.onPage = { [weak self] direction in self?.page(direction) }
        monthGrid.onContextMenu = { [weak self] event in self?.contextMenu(for: event) }
        allDay.colorForCalendar = grid.colorForCalendar
        allDay.onSelect = { [weak self] id in self?.selectEvent(id: id) }

        inspector.onSave = { [weak self] draft in
            Task { await self?.save(draft) }
        }
        inspector.onValidationError = { [weak self] message in
            self?.statusLabel.showError(message)
        }
        inspectorHost.onClose = { [weak self] in
            self?.hideInspector()
        }
        inspector.onCancel = { [weak self] in
            self?.hideInspector()
        }
        inspector.onRespond = { [weak self] response in
            Task { await self?.respond(response) }
        }
        inspector.onGuestsChanged = { [weak self] emails in
            Task { await self?.showBusy(for: emails) }
        }
        // Filing is a preference about the event, written at once — not a
        // field that waits on Save and a calendar round trip.
        inspector.onSubjectChanged = { [weak self] subject in
            guard let self, let event = editingEvent else { return }
            workspace.setSubject(event, subject)
            editingEvent?.subject = subject
        }
        // A guest who is a contact opens their page in Work.
        inspector.onOpenContact = { [weak self] contact in
            self?.onOpenWork?(.contact(id: contact.id, name: contact.displayName))
        }
        inspector.onSubjectsNeeded = { [weak self] kind in
            await self?.workspace.searchSubjects(kind: kind) ?? []
        }
        inspector.onDescribeFallback = { [weak self] sentence, now, duration in
            await self?.workspace.quickAddFallback(sentence, now: now, defaultDurationMinutes: duration)
        }

        monthGrid.colorForCalendar = grid.colorForCalendar
        monthGrid.onSelect = { [weak self] id in self?.selectEvent(id: id) }
        monthGrid.onCreate = { [weak self] start, end in self?.beginCreate(start: start, end: end) }
        monthGrid.onOpenDay = { [weak self] day in self?.show(mode: .day, anchor: day) }
        monthGrid.onSelectDay = { [weak self] day in self?.focus(day, reveal: false) }
        monthGrid.translatesAutoresizingMaskIntoConstraints = false

        // Picking a day keeps the current mode: it moves you, not the view.
        sidebar.miniMonth.onPick = { [weak self] day in self?.focus(day) }

        // The band is exactly its rows. Left at the default hugging it shared
        // the stack's spare height with the grid below, so a week with one
        // all-day event drew a strip deep enough for four.
        allDay.setContentHuggingPriority(.required, for: .vertical)
        allDay.setContentCompressionResistancePriority(.required, for: .vertical)

        let main = NSStackView(views: [
            headerRow, allDay, scrollView, monthWeekdayStack, monthGrid, status,
        ])
        main.orientation = .vertical
        main.spacing = 8
        main.translatesAutoresizingMaskIntoConstraints = false

        detail.addSubview(main)

        // macOS 14 stopped clipping a view to its bounds by default, and the
        // calendar column deliberately draws the day either side of the
        // visible week so a sideways scroll has somewhere to come from. Left
        // unclipped, those padded columns — a day heading, an all-day bar —
        // paint past the column's edge. Each surface clips itself; this is
        // the column-wide backstop for anything added here later.
        main.clipsToBounds = true

        let gridHeight = grid.heightAnchor.constraint(equalToConstant: 24 * grid.hourHeight)
        self.gridHeight = gridHeight

        NSLayoutConstraint.activate([
            main.leadingAnchor.constraint(equalTo: detail.leadingAnchor, constant: Self.mainInset),
            main.topAnchor.constraint(equalTo: detail.topAnchor, constant: Self.mainInset),
            main.bottomAnchor.constraint(equalTo: detail.bottomAnchor, constant: -Self.mainInset),
            main.trailingAnchor.constraint(equalTo: detail.trailingAnchor, constant: -Self.mainInset),
            // These drawn surfaces have no intrinsic width. Pin them to the
            // calendar column so an off-screen event cannot size a surface
            // wider than the window and carry its title past the edge.
            headerRow.widthAnchor.constraint(equalTo: main.widthAnchor),
            allDay.widthAnchor.constraint(equalTo: main.widthAnchor),
            scrollView.widthAnchor.constraint(equalTo: main.widthAnchor),
            monthWeekdayStack.widthAnchor.constraint(equalTo: main.widthAnchor),
            monthGrid.widthAnchor.constraint(equalTo: main.widthAnchor),
            status.widthAnchor.constraint(equalTo: main.widthAnchor),
            grid.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor),
            gridHeight,
        ])

        installColumns(
            sidebar: sidebar,
            detail: StarlingsShellPaneViewController(view: detail),
            inspector: inspectorHost,
            inspectorOverlays: true,
            columnsName: "MeetCalendarSplit"
        )
    }

    /// The calendar column's distance from the detail pane's edges.
    private static let mainInset = StarlingsShellViewController.Column.contentGutter

    override func viewDidLayout() {
        super.viewDidLayout()
        fillViewWithHours()
    }

    /// Zoomed far enough out, an hour gets short enough that the whole day ends
    /// partway up the window with nothing under it — which reads as the
    /// calendar stopping rather than as the hours being small. The shortest
    /// hour is therefore the one that still fills the view.
    private func fillViewWithHours() {
        let clip = scrollView.contentView
        let visible = clip.bounds.height
        guard visible > 1, grid.hourSpan > 0, !scrollView.isHidden else { return }
        let floor = visible / CGFloat(grid.hourSpan)
        guard grid.hourHeight < floor - 0.5 else { return }
        // Keep the hour that was at the top there. Scaling a whole day to a
        // resized window otherwise slides the view to a different time of day.
        let hoursAtTop = clip.bounds.origin.y / grid.hourHeight
        grid.hourHeight = floor
        gridHeight?.constant = CGFloat(grid.hourSpan) * floor
        view.layoutSubtreeIfNeeded()
        let limit = max(0, grid.bounds.height - clip.bounds.height)
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: min(limit, max(0, hoursAtTop * floor))))
        scrollView.reflectScrolledClipView(clip)
    }

    /// The grid, so the window opens on what it is for. Search is opt-in in
    /// every shell window — see `StarlingsShellViewController`.
    override var openingFirstResponder: NSView? { scrollView }
    override var surfaceSearchField: NSSearchField? { searchField }

    override func viewDidAppear() {
        super.viewDidAppear()
        applySecondaryTimeZone()
        applyModeVisibility()
        // The workspace publishes several times per load — cache, then local,
        // then the network — and each of those is a frame worth drawing rather
        // than an empty grid held back until the slowest source answers.
        workspace.onChange = { [weak self] in self?.render() }
        Task { await reload() }
        nowTimer?.invalidate()
        nowTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.grid.needsDisplay = true
                self?.allDay.needsDisplay = true
                self?.monthGrid.needsDisplay = true
                self?.sidebar.agenda.refreshPastState()
            }
        }
        nowTimer?.tolerance = 10
        DispatchQueue.main.async { [weak self] in
            self?.scrollToWorkingHours()
        }
        observeExternalChanges()
        observeWakeAndActivation()
        observeWeatherPreferences()
        observeSourcePreferences()
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: CalendarWorkspace.monthTTL, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.reload() }
        }
        pollTimer?.tolerance = 15
    }

    override func viewWillDisappear() {
        super.viewWillDisappear()
        nowTimer?.invalidate()
        nowTimer = nil
        pollTimer?.invalidate()
        pollTimer = nil
        for observer in wakeObservers {
            NotificationCenter.default.removeObserver(observer)
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
        wakeObservers = []
        externalChangeTask?.cancel()
        externalChangeTask = nil
        weatherTask?.cancel()
        weatherTask = nil
        if let weatherObserver {
            NotificationCenter.default.removeObserver(weatherObserver)
            self.weatherObserver = nil
        }
        if let sourcesObserver {
            NotificationCenter.default.removeObserver(sourcesObserver)
            self.sourcesObserver = nil
        }
    }

    /// Edit in Calendar.app or on a phone and the week here would otherwise sit
    /// stale until the next manual navigation.
    private func observeExternalChanges() {
        externalChangeTask?.cancel()
        externalChangeTask = Task { [weak self] in
            for await _ in EventKitCalendarStore.externalChanges {
                if Task.isCancelled { return }
                // EventKit fires a burst per sync; let it settle before refetching.
                try? await Task.sleep(for: .milliseconds(400))
                if Task.isCancelled { return }
                await self?.reload()
            }
        }
    }

    /// Google edits made on a phone or in a browser reach here only over the
    /// network, and the poll timer sleeps with the Mac. Read once on wake and
    /// on coming to the front so the week is current by the time it is looked at.
    private func observeWakeAndActivation() {
        guard wakeObservers.isEmpty else { return }
        let reload: (Notification) -> Void = { [weak self] _ in
            Task { @MainActor in await self?.reload() }
        }
        wakeObservers = [
            NotificationCenter.default.addObserver(
                forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main, using: reload
            ),
            NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didWakeNotification, object: nil, queue: .main, using: reload
            ),
        ]
    }

    /// Settings is its own window, so naming a city there has to reach a
    /// calendar that is already open.
    private func observeWeatherPreferences() {
        guard weatherObserver == nil else { return }
        weatherObserver = NotificationCenter.default.addObserver(
            forName: WeatherPreferences.didChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.refreshWeather() }
        }
    }

    /// Letting an account into the app, or taking one out, happens in Settings
    /// — another window. A reload rather than a re-render, because a calendar
    /// switched back on has no events fetched yet.
    private func observeSourcePreferences() {
        guard sourcesObserver == nil else { return }
        sourcesObserver = NotificationCenter.default.addObserver(
            forName: CalendarSourcePreferences.didChange,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            let justConnected = notification.userInfo?[CalendarSourcePreferences.googleConnectionAssertedKey] as? Bool ?? false
            Task { @MainActor in
                await self?.reload()
                // A connect's token can take KV up to a minute to serve. Read
                // the week once more after that so it fills in on its own
                // rather than waiting for the next click.
                guard justConnected else { return }
                try? await Task.sleep(for: .seconds(75))
                await self?.reload()
            }
        }
    }

    /// Cheap to call on every reload: the service holds half an hour of days
    /// in memory, so paging weeks costs nothing and only the first look at a
    /// new place reaches the network.
    private func refreshWeather() {
        weatherTask?.cancel()
        guard let place = WeatherPreferences.activePlace() else {
            dayHeader.forecast = [:]
            return
        }
        weatherTask = Task { [weak self] in
            let outcome = await WeatherForecastService.forecast(for: place)
            guard !Task.isCancelled else { return }
            self?.applyWeather(outcome)
        }
    }

    private func applyWeather(_ outcome: WeatherForecastOutcome) {
        dayHeader.forecast = outcome.days
        if let failure = outcome.failure {
            StarlingsDiagnosticsLog.shared.record(
                .weatherForecastUnavailable(failure),
                context: "calendar weather"
            )
        }
        // Only worth saying when it left the header actually empty; a stale
        // cache that still draws is not something to put in front of anyone.
        weatherStatus = (outcome.failure != nil && outcome.days.isEmpty) ? String(localized: "Weather unavailable") : nil
        updateStatusLabel()
    }

    func reloadAndShow(create: Bool, focusToday: Bool = false) {
        Task {
            if focusToday { pointAt(day: Date()) }
            await reload()
            if create { beginCreateNow() }
        }
    }

    /// A Home row named an event: page to its day, then select it so the
    /// inspector reads it. The feed's id carries the calendar ref in front
    /// of Google's own id, so the match is on the raw id — the same rule
    /// `reveal(eventReference:)` applies to a search row. The day is pointed
    /// at first because the event is not necessarily in the loaded window.
    func reveal(_ summary: CalendarEventSummary) {
        guard let start = CalendarDateParsing.parse(summary.start) else {
            reloadAndShow(create: false)
            return
        }
        pointAt(day: start)
        let rawID = summary.rawEventID
        Task {
            await reload()
            guard let event = workspace.visibleEvents.first(where: {
                $0.rawEventID == rawID || $0.rawEventID.hasSuffix(rawID)
            }) else { return }
            selectEvent(id: event.id)
        }
    }

    /// The toolbar's `+` and File › New Event… when this window is already
    /// up: an hour at the next slot from now.
    @objc func newEventPressed(_ sender: Any?) {
        beginCreateNow()
    }

    /// Quick add event…: one sentence, then the new event's form
    /// filled in from it for review. The + menu and File › Quick Add Event….
    @objc func quickAddPressed(_ sender: Any?) {
        let field = StarlingsTextField(placeholder: String(localized: "Coffee with Ana Thu 14:00 at Ground, 45 min"))
        field.frame = NSRect(x: 0, y: 0, width: 360, height: 28)
        let alert = NSAlert()
        alert.messageText = String(localized: "Quick add event")
        alert.informativeText = String(localized: "Say what, when and where. The new event opens filled in, for you to check and add.")
        alert.accessoryView = field
        alert.addButton(withTitle: String(localized: "Next"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let typed = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        beginCreateNow()
        if !typed.isEmpty { inspector.applyQuickAdd(typed) }
    }

    private func beginCreateNow() {
        // The next slot from now, never an odd minute.
        let start = CalendarWeekMath.snapUp(Date(), minutes: CalendarWindowPreferences.snapMinutes())
        beginCreate(start: start, end: start.addingTimeInterval(3_600))
    }

    /// Point the calendar at the civil day a Home card or Today just
    /// promised to show. It intentionally leaves the user's preferred
    /// day/week/month mode intact while making that day the first thing the
    /// calendar reads.
    private func pointAt(day: Date) {
        let target = Calendar.current.startOfDay(for: day)
        focusedDay = target
        anchor = mode == .month
            ? CalendarWeekMath.startOfMonth(containing: target, calendar: .current)
            : target
        grid.resetDayOffset()
        applyWindow()
        render()
    }

    /// Put the days on screen from the anchor alone, and say what range their
    /// events would need.
    ///
    /// Pure date maths, so it lands in the frame it is called in. That is the
    /// whole point: a sideways scroll can re-anchor the window the instant it
    /// settles rather than waiting on a fetch. It used to wait, which meant the
    /// grid spent a round trip drawing the *old* days at zero displacement —
    /// the jump back to where the scroll started, then the jump forward when
    /// the events arrived.
    @discardableResult
    private func applyWindow() -> DateInterval? {
        let calendar = Calendar.current
        let days = visibleDays(from: anchor, calendar: calendar)
        guard let first = days.first, let last = days.last else { return nil }
        // Month mode holds the grids either side, because a sideways scroll
        // shows the next month arriving rather than swapping it in at the end.
        let monthPages: [[Date]] = mode == .month
            ? [-1, 0, 1].map {
                CalendarWeekMath.days(
                    for: .month,
                    anchor: CalendarWeekMath.step(.month, from: anchor, direction: $0),
                    calendar: calendar
                )
            }
            : []

        // Week and day modes hold a padded window: the visible days plus a week
        // either side, so a scroll reveals real days rather than empty space.
        let padded: [Date]
        let leadingPad: Int
        if mode == .month {
            padded = []
            leadingPad = 0
        } else {
            let pad = Self.scrollPadDays
            let before = (1...pad).reversed().compactMap {
                calendar.date(byAdding: .day, value: -$0, to: first)
            }
            let after = (1...pad).compactMap { calendar.date(byAdding: .day, value: $0, to: last) }
            padded = before + days + after
            leadingPad = before.count
        }

        let timedDays = padded
        grid.days = timedDays
        grid.leadingPadDays = leadingPad
        grid.visibleDayCount = max(1, days.count)
        allDay.days = timedDays
        allDay.leadingPadDays = leadingPad
        allDay.visibleDayCount = max(1, days.count)
        dayHeader.days = timedDays
        dayHeader.leadingPadDays = leadingPad
        dayHeader.visibleDayCount = max(1, days.count)
        monthGrid.days = monthPages.flatMap { $0 }
        monthGrid.leadingPadCells = monthPages.first?.count ?? 0
        monthGrid.focusedMonth = anchor

        // Pad by a day on each side: an event that began before the window still
        // has to draw its tail inside it, and one running past the last midnight
        // still has to draw. A window of exactly the visible days misses both.
        let pad = mode == .month ? 1 : Self.scrollPadDays + 1
        let windowFirst = monthPages.first?.first ?? first
        let windowLast = monthPages.last?.last ?? last
        let fetchStart = calendar.date(byAdding: .day, value: -pad, to: windowFirst) ?? windowFirst
        let fetchEnd = calendar.date(byAdding: .day, value: pad + 1, to: windowLast) ?? windowLast
        return DateInterval(start: fetchStart, end: fetchEnd)
    }

    private func reload() async {
        let calendar = Calendar.current
        guard let range = applyWindow() else { return }
        // Draw what is already held before going to the network. The fetched
        // window runs a week past the visible days either way, so the day a
        // scroll just revealed is normally already in hand.
        render()
        await workspace.reload(range: range)
        refreshWeather()

        if let pending = pendingSelectionID {
            pendingSelectionID = nil
            selectEvent(id: pending)
        }

        // Warm the periods either side so paging does not wait on the network.
        let neighbours = [-1, 1].compactMap { direction -> DateInterval? in
            let shifted = CalendarWeekMath.step(mode, from: anchor, direction: direction)
            let span = visibleDays(from: shifted, calendar: calendar)
            guard let start = span.first, let last = span.last,
                  let end = calendar.date(byAdding: .day, value: 1, to: last)
            else { return nil }
            return DateInterval(start: start, end: end)
        }
        Task { [weak self] in
            for range in neighbours { await self?.workspace.prefetch(range: range) }
        }
    }

    /// Switch what is on screen. Reloads because each mode spans a different
    /// window, and month needs six weeks the week view never fetched.
    private func show(mode newMode: CalendarViewMode, anchor newAnchor: Date) {
        let calendar = Calendar.current
        mode = newMode
        anchor = {
            switch newMode {
            case .day: return calendar.startOfDay(for: newAnchor)
            case .week: return calendar.startOfDay(for: newAnchor)
            case .month: return CalendarWeekMath.startOfMonth(containing: newAnchor, calendar: calendar)
            }
        }()
        modeToolbarItem.selectedIndex = CalendarViewMode.allCases.firstIndex(of: newMode) ?? 1
        applyModeVisibility()
        grid.resetDayOffset()
        applyWindow()
        render()
        Task { await reload() }
    }

    /// The days on screen. A week is always seven days from the anchor rather
    /// than from the calendar's first weekday: the grid scrolls sideways by the
    /// day, so its left column is wherever you stopped, and opening the window,
    /// switching mode, or pressing Today all put the day you mean in the first
    /// column. iPhone and the web read the same rolling seven days, so what a
    /// week means does not depend on which surface you are looking at.
    private func visibleDays(from start: Date, calendar: Calendar = .current) -> [Date] {
        guard mode == .week else {
            return CalendarWeekMath.days(for: mode, anchor: start, calendar: calendar)
        }
        return CalendarWeekMath.days(ofWeekStarting: calendar.startOfDay(for: start), calendar: calendar)
    }

    /// Point the window at a day, bringing the grid along when that day is not
    /// on screen. The agenda, the mini month and the grid's own heading all
    /// read this one day, so they cannot end up describing different ones.
    private func focus(_ day: Date, reveal: Bool = true) {
        let calendar = Calendar.current
        let target = calendar.startOfDay(for: day)
        let onScreen = visibleDays(from: anchor, calendar: calendar)
            .contains { calendar.isDate($0, inSameDayAs: target) }
        guard target != focusedDay || !onScreen else { return }
        focusedDay = target
        if reveal, !onScreen {
            // `show` reloads, and the render that ends it reads this day.
            show(mode: mode, anchor: target)
            return
        }
        render()
    }

    /// Move the window without re-normalising the anchor, so a paged week keeps
    /// whatever alignment a sideways scroll left it on.
    private func goTo(_ newAnchor: Date) {
        anchor = Calendar.current.startOfDay(for: newAnchor)
        // A deliberate jump, so no glide: land flat on the day boundary. The
        // grid propagates the zero to the header and the all-day band.
        grid.resetDayOffset()
        applyWindow()
        render()
        Task { await reload() }
    }

    /// The gutter carries one clock or two, and is only as wide as it needs to
    /// be for the one it has.
    private func applySecondaryTimeZone() {
        let zone = CalendarWindowPreferences.secondaryTimeZone()
        let width: CGFloat = zone == nil ? 54 : 88
        grid.secondaryTimeZone = zone?.timeZone
        grid.gutterWidth = width
        allDay.gutterWidth = width
        allDay.needsDisplay = true
        dayHeader.gutterWidth = width
        dayHeader.secondaryZone = zone
    }

    private func applyModeVisibility() {
        let isMonth = mode == .month
        headerRow?.isHidden = isMonth
        allDay.isHidden = isMonth
        scrollView.isHidden = isMonth
        monthWeekdayStack.isHidden = !isMonth
        monthGrid.isHidden = !isMonth
    }

    private func render() {
        // The pointed-at day is always one of the days on screen: paging past it
        // drags it to the nearest day still visible, rather than leaving the two
        // halves of the window talking about different weeks.
        let calendar = Calendar.current
        let onScreen = visibleDays(from: anchor, calendar: calendar)
        if !onScreen.contains(where: { calendar.isDate($0, inSameDayAs: focusedDay) }),
           let nearest = CalendarWeekMath.nearestDay(to: focusedDay, in: onScreen, calendar: calendar) {
            focusedDay = nearest
        }
        dayHeader.focusedDay = focusedDay
        monthGrid.focusedDay = focusedDay

        let hidden = Set(workspace.calendars.map(\.id).filter(workspace.isHidden))
        let hiddenAccounts = Set(workspace.calendars.map(\.groupTitle).filter(workspace.isAccountHidden))
        sidebar.render(
            calendars: workspace.calendars,
            hiddenIDs: hidden,
            hiddenAccounts: hiddenAccounts,
            removableAccounts: workspace.removableAccounts,
            writeCalendarID: workspace.defaultWriteCalendar()?.id,
            eventKitAccess: workspace.eventKitAccess
        )
        // Collapse copies of one event that arrived on several calendars, so a
        // meeting you are subscribed to four times draws once rather than as
        // four unreadable slivers.
        let showsDeclined = CalendarWindowPreferences.showsDeclined()
        let showsHidden = CalendarWindowPreferences.showsHidden()
        let groups = CalendarWeekMath.consolidate(workspace.visibleEvents)
            .filter { showsDeclined || $0.event.myResponse != .declined }
            .filter { showsHidden || !$0.event.isDemoted }
            .filter { searchQuery.isEmpty || Self.matches($0.event, query: searchQuery) }
        let visible = groups.map(\.event)
        // A block that stands in for a published event carries the Events
        // swatch beside its own calendars; the layer row it replaces is gone.
        let published = workspace.publishedEventIDs
        let merged = Dictionary(
            groups.map { group in
                (group.id, published.contains(group.event.id)
                    ? group.calendarIDs + [CalendarWorkspace.publishedSwatchCalendarID]
                    : group.calendarIDs)
            },
            uniquingKeysWith: { first, _ in first }
        )
        let layers = workspace.visibleLayerItems
        grid.layerItems = layers
        allDay.layerItems = layers
        monthGrid.layerItems = layers
        grid.events = visible
        grid.mergedCalendarIDs = merged
        allDay.events = visible
        allDay.mergedCalendarIDs = merged
        monthGrid.events = visible
        monthGrid.mergedCalendarIDs = merged
        mergedCalendarIDs = merged
        applyGridPreferences()
        // The agenda spans the whole loaded period rather than starting at the
        // pointed-at day, so moving between days is a scroll and not a rebuild.
        // The scroll is what makes it read as the same list following the grid
        // sideways, instead of a new list arriving each time the day changes.
        let agendaWindow = agendaWindow(calendar: calendar)
        sidebar.agenda.render(
            events: workspace.visibleEvents,
            start: agendaWindow.start,
            days: agendaWindow.days
        )
        sidebar.agenda.focus(day: focusedDay)
        renderMiniMonth(visible)
        // The period on screen is the window's subtitle. It used to be a
        // 16pt label in the navigation row — which meant this window carried
        // its own heading while Work read its subject from the titlebar.
        view.window?.subtitle = periodTitle()
        updateWindowTitle()
        updateStatusLabel(matchCount: visible.count)
        invalidateAllDayHeight()
    }

    /// Days held either side of the viewport, so a horizontal drag has
    /// somewhere to go before the next fetch lands.
    /// The period the agenda lists. Deliberately the padded window the grid
    /// already holds — the pointed-at day is always inside it, so pointing at a
    /// different one is a scroll rather than a redraw, and the days either side
    /// are already fetched so scrolling back finds real events.
    private func agendaWindow(calendar: Calendar) -> (start: Date, days: Int) {
        let onScreen = visibleDays(from: anchor, calendar: calendar)
        guard let first = onScreen.first else {
            return (calendar.startOfDay(for: focusedDay), 14)
        }
        guard mode != .month else { return (first, onScreen.count) }
        let pad = Self.scrollPadDays
        let start = calendar.date(byAdding: .day, value: -pad, to: first) ?? first
        return (start, onScreen.count + pad * 2)
    }

    private static let scrollPadDays = 7

    /// Title, location, notes and guests — the fields you actually remember an
    /// event by.
    /// The one matcher (invariant 27): the title is the title, and the
    /// rest is the subtitle a token can still reach.
    private static func matches(_ event: StarlingsCalendarEvent, query: String) -> Bool {
        Search.matches(
            query: query,
            title: event.displayTitle,
            subtitle: [event.location, event.notes, event.attendeeEmails.joined(separator: " ")].joined(separator: " ")
        )
    }

    /// Event failures outrank a search summary, which outranks weather. The
    /// forecast is the least important thing on this screen and never displaces
    /// something the user is actively doing.
    /// Confirm an account that was attached from outside this controller — the
    /// OAuth sheet is owned by the window, which has no status line of its own.
    func confirmGoogleAccountAdded(_ email: String) {
        flashStatus(email.isEmpty ? String(localized: "Google account added") : String(localized: "Added \(email)"))
    }

    /// Say that something worked, briefly.
    ///
    /// An alert for a success is a dialog you have to dismiss to get back to the
    /// calendar you just changed. The toast says it and goes away on its own;
    /// the status line keeps the facts that stay (search, weather, errors).
    private func flashStatus(_ message: String) {
        StarlingsToast.show(message, in: view.window)
    }

    private func updateStatusLabel(matchCount: Int? = nil) {
        if let matchCount { lastMatchCount = matchCount }
        if let error = workspace.lastError {
            statusLabel.showError(error, detail: workspace.lastErrorDetail)
            return
        }
        let summary = searchSummary(showing: matchCount ?? lastMatchCount)
        statusLabel.setText(summary.isEmpty ? (weatherStatus ?? "") : summary)
    }

    /// Says plainly how far the search reached. Search covers what has been
    /// loaded, so claiming more than that would be a lie.
    private func searchSummary(showing count: Int) -> String {
        guard !searchQuery.isEmpty else { return "" }
        let elsewhere = workspace.cachedEvents
            .filter { Self.matches($0, query: searchQuery) }
            .count
        if count == 0, elsewhere == 0 { return "No matches in loaded range" }
        if elsewhere > count { return "\(count) here · \(elsewhere) loaded — ⏎ for next" }
        return String(localized: "\(count) matches")
    }

    /// Jump to the next match after the current period, wrapping around.
    private func jumpToNextMatch() {
        let matches = workspace.cachedEvents
            .filter { Self.matches($0, query: searchQuery) }
            .sorted { $0.start < $1.start }
        guard !matches.isEmpty else { return }
        let days = visibleDays(from: anchor)
        let after = days.last ?? anchor
        let target = matches.first { $0.start > after } ?? matches[0]
        // Selection has to wait for the reload that `show` kicks off.
        pendingSelectionID = target.id
        show(mode: mode, anchor: target.start)
    }

    private func periodTitle() -> String {
        let calendar = Calendar.current
        let formatter = DateFormatter()
        formatter.locale = .current

        switch mode {
        case .day:
            formatter.setLocalizedDateFormatFromTemplate("EEEE d MMMM yyyy")
            return formatter.string(from: anchor)
        case .month:
            formatter.setLocalizedDateFormatFromTemplate("LLLL yyyy")
            return formatter.string(from: anchor)
        case .week:
            // The day header carries the dates; the subtitle names the month.
            let days = visibleDays(from: anchor, calendar: calendar)
            guard let first = days.first, let last = days.last else { return "" }
            return CalendarPeriodTitle.months(first: first, last: last, calendar: calendar)
        }
    }

    /// Keep the sidebar month in step with the main grid and mark days that
    /// have something on them.
    private func renderMiniMonth(_ events: [StarlingsCalendarEvent]) {
        let calendar = Calendar.current
        let days = visibleDays(from: anchor, calendar: calendar)
        // The month shown is the pointed-at day's, not the anchor's: a week
        // that straddles two months must not hide the day it is pointed at.
        sidebar.miniMonth.show(month: focusedDay)
        sidebar.miniMonth.selectedDays = Set(days.map { calendar.startOfDay(for: $0) })
        sidebar.miniMonth.focusedDay = focusedDay

        var busy: Set<Date> = []
        for event in events {
            var cursor = calendar.startOfDay(for: event.start)
            let last = calendar.startOfDay(for: event.isAllDay
                ? CalendarWeekMath.allDayInclusiveEnd(event, calendar: calendar)
                : event.end)
            while cursor <= last {
                busy.insert(cursor)
                guard let next = calendar.date(byAdding: .day, value: 1, to: cursor) else { break }
                cursor = next
            }
        }
        sidebar.miniMonth.busyDays = busy
    }

    private func renderMonthWeekdayHeader() {
        monthWeekdayStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let calendar = Calendar.current
        for index in 0..<7 {
            let symbol = calendar.shortWeekdaySymbols[(calendar.firstWeekday - 1 + index) % 7]
            let label = NSTextField(labelWithString: symbol.uppercased())
            label.font = CalendarGridTypography.sectionLabelFont
            label.textColor = StarlingsColors.secondaryText
            label.alignment = .center
            monthWeekdayStack.addArrangedSubview(label)
        }
    }

    /// The ⌘K palette's event door: `<calendarId>:<eventId>` as the Worker
    /// spells it. The Mac's own ids are composed differently per source, so
    /// this matches on the raw Google id and lands on the event's day. An
    /// event outside what is loaded is looked for across the window the
    /// Worker searched — a week back, five ahead — before giving up;
    /// that read is by month, so the paging that follows is cached.
    func reveal(eventReference: String) {
        guard let colon = eventReference.lastIndex(of: ":") else { return }
        let rawID = String(eventReference[eventReference.index(after: colon)...])
        let match = { [workspace] in
            workspace.visibleEvents.first(where: { $0.rawEventID == rawID || $0.rawEventID.hasSuffix(rawID) })
        }
        if let event = match() {
            focus(event.start)
            highlightEvent(id: event.id)
            return
        }
        Task { [weak self] in
            guard let self else { return }
            let now = Date()
            let window = DateInterval(start: now.addingTimeInterval(-7 * 86_400), end: now.addingTimeInterval(38 * 86_400))
            await workspace.reload(range: window)
            guard let event = match() else { return }
            focus(event.start)
            highlightEvent(id: event.id)
        }
    }

    private func selectEvent(id: String?) {
        selectedEventID = id
        grid.selectedEventID = id
        monthGrid.selectedEventID = id
        allDay.selectedEventID = id
        sidebar.agenda.selectedEventID = id
        updateWindowTitle()
        if let id, let item = layerItem(id: id) {
            editingEvent = nil
            readInInspector(item)
            uncover(item.start)
            return
        }
        guard let id, let event = workspace.visibleEvents.first(where: { $0.id == id }) else {
            hideInspector()
            return
        }
        editingEvent = event
        readInInspector(event)
        uncover(event.start)
    }

    /// A drawn layer row by the id the grids hand back. Layer ids carry a
    /// prefix of their own (`wi:`, `pe:`, `av:`), so they never collide
    /// with an event's.
    private func layerItem(id: String) -> CalendarLayerItem? {
        workspace.visibleLayerItems.first { $0.id == id }
    }

    /// Read-only: a task or milestone is Core's, and the panel's buttons
    /// lead to where it lives in Work.
    private func readInInspector(_ item: CalendarLayerItem) {
        grid.busyIntervals = []
        showInspector()
        inspectorHost.showLayer(item)
    }

    /// The inspector floats over the grid's trailing edge, so the last day or
    /// two sit under it while it is open. An event chosen on one of those days
    /// is what the panel is about; scroll the week so its day is the last one
    /// still in the clear. Day has one column and month pages, so only week
    /// moves.
    private func uncover(_ start: Date) {
        let cover = inspectorOverlayWidth - Self.mainInset
        guard mode == .week, cover > 0 else { return }
        let calendar = Calendar.current
        let days = visibleDays(from: anchor, calendar: calendar)
        guard let index = days.firstIndex(where: { calendar.isDate($0, inSameDayAs: start) }) else { return }
        let covered = grid.daysCovered(byTrailing: cover)
        let shift = index - (days.count - covered) + 1
        guard shift > 0 else { return }
        shiftDays(shift)
    }

    private func readInInspector(_ event: StarlingsCalendarEvent) {
        showInspector()
        Task { await showBusy(for: event.attendeeEmails) }
        inspector.showEvent(
            event,
            calendars: workspace.calendars,
            includeMeetLink: currentRoom != nil,
            alsoOn: alsoOnCalendarNames(for: event)
        )
    }

    /// Right-click on empty grid. An empty slot has one obvious thing to do
    /// with it, and a menu that says which slot it means is worth more than a
    /// dead zone — the time is in the title, so a mis-aimed click is visible
    /// before it makes anything.
    private func slotContextMenu(start: Date, end: Date) -> NSMenu? {
        let formatter = DateFormatter()
        formatter.locale = .current
        if mode == .month {
            formatter.setLocalizedDateFormatFromTemplate("EEEd MMM")
        } else {
            formatter.setLocalizedDateFormatFromTemplate("HH:mm")
        }
        let menu = NSMenu()
        let item = menu.addItem(
            withTitle: String(localized: "New event \(mode == .month ? "on" : "at") \(formatter.string(from: start))"),
            action: #selector(newEventFromMenu(_:)),
            keyEquivalent: ""
        )
        item.symbol(.newEvent)
        item.representedObject = DateInterval(start: start, end: max(end, start.addingTimeInterval(60)))
        return menu
    }

    @objc private func newEventFromMenu(_ sender: Any?) {
        guard let slot = (sender as? NSMenuItem)?.representedObject as? DateInterval else { return }
        beginCreate(start: slot.start, end: slot.end)
    }

    /// A task or milestone is Core's, not ours: the menu offers the ways to
    /// where it lives, the same ones the inspector shows.
    private func layerContextMenu(for item: CalendarLayerItem) -> NSMenu? {
        let menu = NSMenu()
        for link in item.workLinks {
            menu.addItem(
                withTitle: link.title,
                action: #selector(openLayerWorkLinkFromMenu(_:)),
                keyEquivalent: ""
            ).representedObject = LayerWorkLinkBox(link.destination)
        }
        if !item.url.isEmpty {
            menu.addItem(
                withTitle: item.kind.openTitle,
                action: #selector(openLayerItemFromMenu(_:)),
                keyEquivalent: ""
            ).representedObject = item.url
        }
        return menu.items.isEmpty ? nil : menu
    }

    @objc private func openLayerItemFromMenu(_ sender: Any?) {
        guard let raw = (sender as? NSMenuItem)?.representedObject as? String,
              let url = URL(string: raw)
        else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func openLayerWorkLinkFromMenu(_ sender: Any?) {
        guard let box = (sender as? NSMenuItem)?.representedObject as? LayerWorkLinkBox else { return }
        onOpenWork?(box.destination)
    }

    /// Marks a block without opening it: one click, an arrow key, a right-click.
    ///
    /// Selection and editing used to be the same act, so pointing at anything
    /// opened the editor. Double-click, Return, and the menu's own Edit… are
    /// the ways in — but a column that is already open follows the selection,
    /// the way Work's does, rather than staying on an event you have left.
    private func highlightEvent(id: String, followDay: Bool = true) {
        if let item = layerItem(id: id) {
            highlightLayer(item, followDay: followDay)
            return
        }
        // Still the selected event, so Delete, Return and the menu act on it —
        // it just opens no editor of its own.
        editingEvent = workspace.visibleEvents.first { $0.id == id }
        selectedEventID = id
        grid.selectedEventID = id
        monthGrid.selectedEventID = id
        allDay.selectedEventID = id
        sidebar.agenda.selectedEventID = id
        updateWindowTitle()
        // Pointing at an event in the grid points the window at its day too.
        if followDay, let event = editingEvent {
            focus(event.start, reveal: false)
        }
        if isInspectorVisible, let event = editingEvent {
            readInInspector(event)
        }
    }

    /// The other calendars a merged block came from, named for the inspector so
    /// a collapsed duplicate is visible rather than silently hidden.
    private func alsoOnCalendarNames(for event: StarlingsCalendarEvent) -> [String] {
        guard let ids = mergedCalendarIDs[event.id], ids.count > 1 else { return [] }
        return ids
            .filter { $0 != event.calendarID }
            .compactMap { id in
                id == CalendarWorkspace.publishedSwatchCalendarID
                    ? PublicEventsCalendar.displayName
                    : workspace.calendars.first(where: { $0.id == id })?.title
            }
    }

    private func beginCreate(start: Date, end: Date) {
        selectedEventID = nil
        editingEvent = nil
        grid.selectedEventID = nil
        updateWindowTitle()
        showInspector()
        inspector.showCreate(
            start: start,
            end: end,
            calendars: workspace.calendars,
            selectedCalendarID: workspace.defaultWriteCalendar()?.id,
            roomJoinURL: currentRoom?.joinURL
        )
    }

    private func save(_ draft: CalendarInspectorDraft) async {
        let room = draft.includeMeetLink ? currentRoom : nil
        do {
            if let editingEvent {
                if draft.calendarID != editingEvent.calendarID {
                    try await workspace.move(editingEvent, to: draft.calendarID)
                }
                try await workspace.update(
                    editingEvent,
                    title: draft.title,
                    start: draft.start,
                    end: draft.end,
                    joinURL: room?.joinURL,
                    roomSlug: room?.slug,
                    attendees: draft.attendees,
                    notes: draft.notes,
                    location: draft.location,
                    travelTimeMinutes: draft.travelTimeMinutes,
                    span: draft.span
                )
            } else {
                try await workspace.create(
                    title: draft.title,
                    start: draft.start,
                    end: draft.end,
                    calendarID: draft.calendarID,
                    joinURL: room?.joinURL,
                    roomSlug: room?.slug,
                    attendees: draft.attendees ?? [],
                    notes: draft.notes,
                    location: draft.location,
                    travelTimeMinutes: draft.travelTimeMinutes
                )
            }
            hideInspector()
            await reload()
            // Say what went out. The Worker asks Google to mail the guests
            // when the list changed or the meeting moved; the person who
            // pressed Save otherwise has no way to know an invite left.
            let invited = draft.attendees?.filter { !$0.isEmpty } ?? []
            if !invited.isEmpty {
                let moved = editingEvent.map { $0.start != draft.start || $0.end != draft.end } ?? false
                let verb = editingEvent == nil ? String(localized: "Invites sent") : (moved ? String(localized: "Updates sent") : String(localized: "Invites updated"))
                flashStatus(String(localized: "\(verb) · \(invited.count) guests"))
            }
        } catch {
            statusLabel.showError(error)
        }
    }

    private func respond(_ response: CalendarRSVP) async {
        guard let editingEvent else { return }
        do {
            try await workspace.respond(to: editingEvent, as: response)
            await reload()
            // Keep the event open so the new reply is visible where it was made.
            selectEvent(id: editingEvent.id)
        } catch {
            statusLabel.showError(error)
            inspector.showEvent(editingEvent, calendars: workspace.calendars, includeMeetLink: currentRoom != nil)
        }
    }

    private func duplicateSelected() async {
        guard let editingEvent else { return }
        do {
            try await workspace.duplicate(editingEvent, to: inspector.selectedCalendarID ?? editingEvent.calendarID)
            hideInspector()
            await reload()
        } catch {
            statusLabel.showError(error)
        }
    }

    @discardableResult
    private func deleteSelected() async -> Bool {
        guard let editingEvent else { return false }
        do {
            try await workspace.delete(editingEvent, span: inspector.selectedSpan)
            hideInspector()
            await reload()
            return true
        } catch {
            statusLabel.showError(error)
            return false
        }
    }

    // MARK: - Copy and paste

    /// ⌘C copies the marked event. Copy and Paste in the Edit menu reach here
    /// through the responder chain, so a text field with the caret in it still
    /// answers first — this only runs when the calendar itself has focus.
    @objc func copy(_ sender: Any?) {
        guard let event = selectedEvent else { return }
        CalendarEventPasteboardItem.write(event)
        flashStatus(String(localized: "Copied \u{201C}\(event.displayTitle)\u{201D}"))
    }

    /// ⌘X copies the event and then removes it. The copy reaches the pasteboard
    /// before anything is deleted, so a cut that is never pasted is still a ⌘V
    /// away from coming back. Two cases are not fair to do silently — guests
    /// get a cancellation, and a recurring event loses only the one occurrence
    /// — so those ask first.
    @objc func cut(_ sender: Any?) {
        guard let event = selectedEvent, event.isWritable else { return }
        CalendarEventPasteboardItem.write(event)
        editingEvent = event
        Task { await cutSelected(event) }
    }

    private func cutSelected(_ event: StarlingsCalendarEvent) async {
        if !event.attendeeEmails.isEmpty || event.isRecurring {
            guard confirmCut(event) else { return }
        }
        guard await deleteSelected() else { return }
        flashStatus(String(localized: "Cut \u{201C}\(event.displayTitle)\u{201D} · ⌘V puts it back"))
    }

    private func confirmCut(_ event: StarlingsCalendarEvent) -> Bool {
        var reasons: [String] = []
        if !event.attendeeEmails.isEmpty {
            reasons.append(String(localized: "Guests are told it is cancelled, and a paste invites them again as new."))
        }
        if event.isRecurring {
            reasons.append(String(localized: "This removes the one occurrence, and a paste makes a single event, not a series."))
        }
        let alert = NSAlert()
        alert.messageText = String(localized: "Cut \u{201C}\(event.displayTitle)\u{201D}?")
        alert.informativeText = reasons.joined(separator: " ")
        alert.addButton(withTitle: String(localized: "Cut"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        alert.alertStyle = .warning
        return alert.runModal() == .alertFirstButtonReturn
    }

    @objc func paste(_ sender: Any?) {
        guard let item = CalendarEventPasteboardItem.read() else { return }
        Task { await pasteEvent(item) }
    }

    /// A paste makes a new event on the day the window points at, at the time
    /// of day it was copied from, on the calendar it came from while that one
    /// still accepts writes. It never re-files the original, so ⌘C ⌘V cannot
    /// move or destroy anything.
    private func pasteEvent(_ item: CalendarEventPasteboardItem) async {
        let slot = item.slot(on: focusedDay)
        let target = workspace.calendars.first { $0.id == item.calendarID && $0.isWritable }?.id
            ?? workspace.writeCalendarID
        guard let calendarID = target else {
            statusLabel.showError(String(localized: "No calendar here accepts new events."))
            return
        }
        do {
            try await workspace.create(
                title: item.title,
                start: slot.start,
                end: slot.end,
                calendarID: calendarID,
                joinURL: item.joinURL.isEmpty ? nil : item.joinURL,
                roomSlug: item.roomSlug.isEmpty ? nil : item.roomSlug,
                attendees: item.attendeeEmails,
                notes: item.notes.isEmpty ? nil : item.notes,
                location: item.location.isEmpty ? nil : item.location
            )
            await reload()
            flashStatus(String(localized: "Pasted \u{201C}\(item.title)\u{201D}"))
        } catch {
            statusLabel.showError(error)
        }
    }

    private func persistDuplicate(_ event: StarlingsCalendarEvent, start: Date, end: Date) async {
        do {
            try await workspace.duplicate(event, start: start, end: end)
            await reload()
        } catch {
            statusLabel.showError(error)
        }
    }

    private func persistMove(_ event: StarlingsCalendarEvent, start: Date, end: Date) async {
        // Land the move locally first so the block does not snap back to its old
        // slot for the length of a network round trip.
        let previous = workspace.applyLocalSchedule(eventID: event.id, start: start, end: end) ?? event
        render()
        registerMoveUndo(previous)
        do {
            try await workspace.update(
                event,
                title: event.title,
                start: start,
                end: end,
                joinURL: event.joinURL.isEmpty ? nil : event.joinURL,
                roomSlug: event.roomSlug.isEmpty ? nil : event.roomSlug,
                // A reschedule says nothing about the guest list. Echoing it back
                // would make the server rewrite every RSVP.
                attendees: nil,
                span: .thisEvent
            )
            await reload()
        } catch {
            workspace.revertLocalSchedule(to: previous)
            undoManager?.removeAllActions(withTarget: self)
            render()
            statusLabel.showError(error)
        }
    }

    /// Undo restores the previous times through the same write path, so ⌘Z is a
    /// real reschedule rather than a local-only illusion.
    private func registerMoveUndo(_ previous: StarlingsCalendarEvent) {
        guard let undoManager else { return }
        undoManager.registerUndo(withTarget: self) { controller in
            Task { @MainActor in
                let current = controller.workspace.visibleEvents.first { $0.id == previous.id } ?? previous
                await controller.persistMove(current, start: previous.start, end: previous.end)
            }
        }
        undoManager.setActionName(String(localized: "Move Event"))
    }

    private var currentRoom: (slug: String, joinURL: String)? {
        roomContext?() ?? nil
    }

    /// The inspector is the shell's floating placement: over the grid's
    /// trailing edge rather than beside it, so opening an event never narrows
    /// the days (`installColumns(inspectorOverlays:)`). `uncover` keeps the
    /// chosen block out from under it. Put away by the toolbar toggle like
    /// every other Mac inspector, and shut until something is chosen — a
    /// column of empty fields earns nothing.
    private func showInspector() {
        inspectorHost.setEmpty(false)
        // The form unless a layer row replaces it right after.
        inspectorHost.showForm()
        setInspector(visible: true)
    }

    private func hideInspector() {
        grid.busyIntervals = []
        editingEvent = nil
        selectedEventID = nil
        grid.selectedEventID = nil
        monthGrid.selectedEventID = nil
        allDay.selectedEventID = nil
        sidebar.agenda.selectedEventID = nil
        updateWindowTitle()
        inspectorHost.setEmpty(true)
        setInspector(visible: false)
    }

    /// A layer row marked the way an event is: the grids draw it selected,
    /// and an inspector already open follows it.
    private func highlightLayer(_ item: CalendarLayerItem, followDay: Bool) {
        editingEvent = nil
        selectedEventID = item.id
        grid.selectedEventID = item.id
        monthGrid.selectedEventID = item.id
        allDay.selectedEventID = item.id
        sidebar.agenda.selectedEventID = nil
        updateWindowTitle()
        if followDay { focus(item.start, reveal: false) }
        if isInspectorVisible { readInInspector(item) }
    }

    /// The grid is the whole day, midnight to midnight, and scrolls. Day start
    /// and end from settings no longer decide what exists, and no longer shade
    /// anything either — they decide where the view opens.
    private func applyGridPreferences() {
        grid.hourHeight = CalendarWindowPreferences.hourHeight()
        grid.snapMinutes = CalendarWindowPreferences.snapMinutes()
        grid.defaultDuration = TimeInterval(CalendarWindowPreferences.defaultDurationMinutes() * 60)
        gridHeight?.constant = CGFloat(grid.hourSpan) * grid.hourHeight
    }

    /// The day runs from midnight, but nobody opens a calendar to look at
    /// 03:00. Put the working hour at the top and leave the night above it for
    /// whoever scrolls up to it.
    private func scrollToWorkingHours() {
        let clip = scrollView.contentView
        let top = CGFloat(CalendarWindowPreferences.dayStartHour()) * grid.hourHeight
        // Not `scrollToVisible`: that moves the least it can, which lands the
        // working hour at the bottom of the view rather than the top of it.
        let limit = max(0, grid.bounds.height - clip.bounds.height)
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: min(limit, max(0, top))))
        scrollView.reflectScrolledClipView(clip)
    }

    private func invalidateAllDayHeight() {
        allDay.invalidateIntrinsicContentSize()
        view.needsLayout = true
    }

    @objc private func goToday() {
        // Today is the day it points at, not merely a period today falls in.
        // In week view, keep that day as the first column so Today means the
        // next seven days at a glance rather than the Monday containing today.
        pointAt(day: Date())
        Task { await reload() }
    }

    @objc private func previousWeek() {
        page(-1)
    }

    @objc private func nextWeek() {
        page(1)
    }

    override func keyDown(with event: NSEvent) {
        // Arrows move between events; ⌥-arrows move the window a day; Delete
        // removes; Return edits; Escape backs out. ⌘-arrows page the period and
        // are handled by the View menu.
        // ⌥-arrows walk the window sideways one day at a time — the keyboard
        // equivalent of a one-day scroll, for when a week is off by a day.
        if event.modifierFlags.contains(.option), event.keyCode == 123 || event.keyCode == 124 {
            // Month keeps whole months; only day and week walk by the day.
            if mode == .month {
                page(event.keyCode == 123 ? -1 : 1)
            } else {
                grid.stepDays(event.keyCode == 123 ? -1 : 1)
            }
            return
        }
        switch event.keyCode {
        case 123: // left
            stepSelection(-1)
        case 124: // right
            stepSelection(1)
        case 126: // up
            show(mode: mode, anchor: CalendarWeekMath.step(mode, from: anchor, direction: -1))
        case 125: // down
            show(mode: mode, anchor: CalendarWeekMath.step(mode, from: anchor, direction: 1))
        case 51, 117: // delete, forward delete
            Task { await confirmDeleteSelected() }
        case 36, 76: // return, enter
            focusInspectorTitle()
        case 53: // escape
            escape()
        default:
            super.keyDown(with: event)
        }
    }

    /// Move the selection to the neighbouring event in time, following the view
    /// to it when it sits outside the period on screen.
    private func stepSelection(_ direction: Int) {
        let ordered = workspace.visibleEvents.sorted { $0.start < $1.start }
        guard !ordered.isEmpty else {
            show(mode: mode, anchor: CalendarWeekMath.step(mode, from: anchor, direction: direction))
            return
        }
        guard let current = selectedEventID,
              let index = ordered.firstIndex(where: { $0.id == current })
        else {
            if let first = (direction > 0 ? ordered.first : ordered.last) {
                highlightEvent(id: first.id)
            }
            return
        }
        let next = index + direction
        guard ordered.indices.contains(next) else {
            // Off the end of what is loaded: page instead of stalling.
            show(mode: mode, anchor: CalendarWeekMath.step(mode, from: anchor, direction: direction))
            return
        }
        highlightEvent(id: ordered[next].id)
    }

    private func escape() {
        if !searchQuery.isEmpty {
            searchField.stringValue = ""
            searchQuery = ""
            render()
            return
        }
        hideInspector()
    }

    /// Return opens the marked event and puts the caret in its title. With
    /// selection no longer opening anything, this is the keyboard's way in.
    private func focusInspectorTitle() {
        guard let id = selectedEventID else { return }
        if !isInspectorVisible { selectEvent(id: id) }
        guard layerItem(id: id) == nil else { return }
        inspector.focusTitle()
    }

    private func confirmRemoveGoogleAccount(id: String) async {
        let email = workspace.googleAccounts.first(where: { $0.id == id })?.email ?? String(localized: "that account")
        let alert = NSAlert()
        alert.messageText = String(localized: "Remove \(email)?")
        alert.informativeText = String(localized: "Starlings stops reading its calendars on every device. The account itself is untouched.")
        alert.addButton(withTitle: String(localized: "Remove"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        alert.alertStyle = .warning
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        do {
            try await workspace.removeGoogleAccount(id)
            await reload()
            flashStatus(String(localized: "Removed \(email)"))
        } catch {
            presentSubscriptionFailure(error)
        }
    }

    private func confirmUnsubscribe(id: String) async {
        let title = workspace.subscriptions.first(where: { $0.id == id })?.title ?? String(localized: "this calendar")
        let alert = NSAlert()
        alert.messageText = String(localized: "Unsubscribe from “\(title)”?")
        alert.informativeText = String(localized: "Its events stop showing on every device. The calendar itself is untouched.")
        alert.addButton(withTitle: String(localized: "Unsubscribe"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        do {
            try await workspace.unsubscribe(id)
            await reload()
            flashStatus(String(localized: "Unsubscribed from \(title)"))
        } catch {
            presentSubscriptionFailure(error)
        }
    }

    private func presentSubscriptionFailure(_ error: any Error) {
        let alert = NSAlert()
        alert.messageText = (error as? StarlingsError)?.title ?? String(localized: "Couldn’t subscribe to that calendar")
        alert.informativeText = (error as? StarlingsError)?.message ?? error.localizedDescription
        alert.alertStyle = .warning
        alert.addButton(withTitle: String(localized: "OK"))
        let copyResponse = alert.addCopyErrorButton()
        if alert.runModal() == copyResponse {
            if let meetError = error as? StarlingsError {
                StarlingsErrorReport.copy(meetError)
            } else {
                StarlingsErrorReport.copy(message: alert.informativeText, detail: String(describing: error))
            }
        }
    }

    /// Deleting an event is not undoable here and may email guests, so it asks.
    private func confirmDeleteSelected() async {
        guard let editingEvent else { return }
        let alert = NSAlert()
        alert.messageText = String(localized: "Delete “\(editingEvent.displayTitle)”?")
        alert.informativeText = editingEvent.attendeeEmails.isEmpty
            ? String(localized: "This can’t be undone.")
            : String(localized: "Guests will be notified. This can’t be undone.")
        alert.addButton(withTitle: String(localized: "Delete"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        alert.alertStyle = .warning
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        await deleteSelected()
    }

    @objc func deleteSelectedEvent(_ sender: Any?) {
        Task { await confirmDeleteSelected() }
    }

    @objc private func searchChanged() {
        let query = searchField.stringValue
        // Enter on an unchanged query means "show me the next one".
        if query == searchQuery, !query.isEmpty {
            jumpToNextMatch()
            return
        }
        searchQuery = query
        render()
    }

    /// Right-click menu for a block. Everything here is reachable elsewhere,
    /// but not without first opening the event — which is the whole point.
    private func contextMenu(for event: StarlingsCalendarEvent) -> NSMenu? {
        let menu = NSMenu()

        if !event.joinURL.isEmpty {
            menu.addItem(withTitle: String(localized: "Join"), action: #selector(joinEventFromMenu(_:)), keyEquivalent: "")
                .symbol(.video).representedObject = event.id
            menu.addItem(.separator())
        }

        menu.addItem(withTitle: String(localized: "Edit…"), action: #selector(editEventFromMenu(_:)), keyEquivalent: "")
            .symbol(.edit).representedObject = event.id

        let priority = menu.addItem(
            withTitle: event.isDemoted ? String(localized: "Show in Next") : String(localized: "Hide from Next"),
            action: #selector(toggleDemotedFromMenu(_:)),
            keyEquivalent: ""
        )
        priority.symbol(event.isDemoted ? .seen : .hide)
        priority.representedObject = event.id

        if event.canRespond {
            let reply = NSMenuItem(title: String(localized: "Reply"), action: nil, keyEquivalent: "").symbol(.reply)
            let submenu = NSMenu()
            for response in CalendarRSVP.answers {
                let item = NSMenuItem(
                    title: response.label,
                    action: #selector(respondFromMenu(_:)),
                    keyEquivalent: ""
                )
                item.representedObject = "\(event.id)|\(response.rawValue)"
                item.state = event.myResponse == response ? .on : .off
                submenu.addItem(item)
            }
            reply.submenu = submenu
            menu.addItem(reply)
        }

        if event.isWritable {
            if event.canMoveBetweenCalendars {
                let move = NSMenuItem(title: String(localized: "Move to"), action: nil, keyEquivalent: "").symbol(.move)
                let submenu = NSMenu()
                // The event's own calendar is listed, ticked and inert, in its
                // group, as the Reply submenu ticks the current answer.
                let choices = workspace.moveMenuCalendars(for: event)
                for group in StarlingsCalendar.orderedGroups(of: choices) {
                    let header = NSMenuItem(title: group, action: nil, keyEquivalent: "")
                    header.isEnabled = false
                    submenu.addItem(header)
                    for calendar in choices where calendar.groupTitle == group {
                        let isCurrent = calendar.id == event.calendarID
                        let item = NSMenuItem(
                            title: calendar.title,
                            action: isCurrent ? nil : #selector(moveEventFromMenu(_:)),
                            keyEquivalent: ""
                        )
                        item.image = calendar.color.swatchImage()
                        item.indentationLevel = 1
                        item.representedObject = "\(event.id)|\(calendar.id)"
                        item.state = isCurrent ? .on : .off
                        item.isEnabled = !isCurrent
                        submenu.addItem(item)
                    }
                }
                move.submenu = submenu
                menu.addItem(move)
            }

            // The shortcut is shown here so the context menu teaches it; the
            // binding itself lives on the Event menu.
            menu.addItem(withTitle: String(localized: "Duplicate"), action: #selector(duplicateEventFromMenu(_:)), keyEquivalent: "d")
                .symbol(.duplicate).representedObject = event.id
        }

        if !event.joinURL.isEmpty {
            menu.addItem(.separator())
            menu.addItem(withTitle: String(localized: "Copy link"), action: #selector(copyLinkFromMenu(_:)), keyEquivalent: "")
                .symbol(.copyLink).representedObject = event.id
        }

        if event.isWritable {
            menu.addItem(.separator())
            menu.addItem(withTitle: String(localized: "Delete"), action: #selector(deleteEventFromMenu(_:)), keyEquivalent: "")
                .symbol(.delete).representedObject = event.id
        }
        return menu
    }

    private func event(from sender: Any?) -> StarlingsCalendarEvent? {
        guard let id = (sender as? NSMenuItem)?.representedObject as? String else { return nil }
        return workspace.visibleEvents.first { $0.id == id.split(separator: "|").first.map(String.init) ?? id }
    }

    @objc private func joinEventFromMenu(_ sender: Any?) {
        guard let event = event(from: sender), let url = URL(string: event.joinURL) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func editEventFromMenu(_ sender: Any?) {
        guard let event = event(from: sender) else { return }
        selectEvent(id: event.id)
    }

    @objc private func toggleDemotedFromMenu(_ sender: Any?) {
        guard let event = event(from: sender) else { return }
        workspace.setDemoted(event, demoted: !event.isDemoted)
        if editingEvent?.id == event.id {
            editingEvent = workspace.visibleEvents.first { $0.id == event.id }
        }
        render()
    }

    @objc private func copyLinkFromMenu(_ sender: Any?) {
        guard let event = event(from: sender) else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(event.joinURL, forType: .string)
    }

    @objc private func duplicateEventFromMenu(_ sender: Any?) {
        guard let event = event(from: sender) else { return }
        editingEvent = event
        Task { await duplicateSelected() }
    }

    @objc private func deleteEventFromMenu(_ sender: Any?) {
        guard let event = event(from: sender) else { return }
        editingEvent = event
        Task { await confirmDeleteSelected() }
    }

    @objc private func respondFromMenu(_ sender: Any?) {
        guard let raw = (sender as? NSMenuItem)?.representedObject as? String,
              let event = event(from: sender),
              let value = raw.split(separator: "|").last.map(String.init),
              let response = CalendarRSVP(rawValue: value)
        else { return }
        editingEvent = event
        Task { await respond(response) }
    }

    @objc private func moveEventFromMenu(_ sender: Any?) {
        guard let raw = (sender as? NSMenuItem)?.representedObject as? String,
              let event = event(from: sender),
              let target = raw.split(separator: "|").last.map(String.init)
        else { return }
        Task {
            do {
                try await workspace.move(event, to: target)
                await reload()
            } catch {
                statusLabel.showError(error)
            }
        }
    }

    /// Shade the guests' busy time over the days on screen.
    ///
    /// Only while an event is open: this is help for choosing a slot, not a
    /// permanent view of other people's calendars.
    private func showBusy(for emails: [String]) async {
        guard !emails.isEmpty else {
            grid.busyIntervals = []
            return
        }
        let calendar = Calendar.current
        let days = visibleDays(from: anchor, calendar: calendar)
        guard let first = days.first, let last = days.last,
              let end = calendar.date(byAdding: .day, value: 1, to: last)
        else { return }
        let people = await workspace.freeBusy(
            for: emails,
            range: DateInterval(start: calendar.startOfDay(for: first), end: end)
        )
        grid.busyIntervals = people
            .flatMap(\.busy)
            .compactMap { slot in
                guard let start = CalendarDateParsing.parse(slot.start),
                      let finish = CalendarDateParsing.parse(slot.end),
                      finish > start
                else { return nil }
                return DateInterval(start: start, end: finish)
            }

        // Say plainly when someone's calendar could not be read: "free" and
        // "not allowed to look" must never render the same.
        let unreadable = people.filter { !$0.isReadable }.map(\.email)
        if !unreadable.isEmpty {
            statusLabel.showError(String(localized: "No availability for \(unreadable.joined(separator: ", "))"))
        }
    }

    /// A settled horizontal scroll re-anchors by whole days.
    ///
    /// The window moves here and now, in the same turn the grid handed over the
    /// shift, so the days slide under the columns without the picture moving.
    /// The offsets are the grid's to zero — it is mid-glide onto the boundary,
    /// and clearing them here would cut that short.
    private func shiftDays(_ shift: Int) {
        guard shift != 0 else { return }
        let calendar = Calendar.current
        let moved = calendar.date(byAdding: .day, value: shift, to: anchor) ?? anchor
        // Day and week both move by days here; only their width differs. The
        // week is not re-snapped to its first weekday — scrolling one day
        // sideways that jumped back to Monday was the scroll doing nothing.
        anchor = calendar.startOfDay(for: moved)
        applyWindow()
        render()
        Task { await reload() }
    }

    private func page(_ direction: Int) {
        let stepped = CalendarWeekMath.step(mode, from: anchor, direction: direction)
        // Month keeps its own alignment rules; day and week just move.
        if mode == .month {
            show(mode: mode, anchor: stepped)
        } else {
            goTo(stepped)
        }
    }

    @objc private func modeChanged(_ sender: NSToolbarItemGroup) {
        let index = sender.selectedIndex
        guard CalendarViewMode.allCases.indices.contains(index) else { return }
        show(mode: CalendarViewMode.allCases[index], anchor: anchor)
    }

    /// Menu targets — `⌘1` / `⌘2` / `⌘3`, matching Calendar.app.
    @objc func showDayView(_ sender: Any?) { show(mode: .day, anchor: anchor) }
    @objc func showWeekView(_ sender: Any?) { show(mode: .week, anchor: anchor) }
    @objc func showMonthView(_ sender: Any?) { show(mode: .month, anchor: anchor) }
    @objc func goToToday(_ sender: Any?) { goToday() }
    @objc func goToPreviousPeriod(_ sender: Any?) { previousWeek() }
    @objc func goToNextPeriod(_ sender: Any?) { nextWeek() }

    /// The block the menu bar is talking about. Selection is the whole story:
    /// `editingEvent` also tracks what the inspector has open, and the Event
    /// menu acts on what is marked whether or not anything is open over it.
    private var selectedEvent: StarlingsCalendarEvent? {
        guard let selectedEventID else { return nil }
        return workspace.visibleEvents.first { $0.id == selectedEventID }
    }

    private func updateWindowTitle() {
        StarlingsWindowChrome.setContextTitle(
            for: view.window,
            surface: .calendar,
            context: selectedEvent?.displayTitle ?? selectedEventID.flatMap(layerItem(id:))?.displayTitle
        )
    }

    // MARK: - Event menu

    @objc func openSelectedEvent(_ sender: Any?) {
        focusInspectorTitle()
    }

    @objc func joinSelectedEvent(_ sender: Any?) {
        guard let event = selectedEvent, let url = URL(string: event.joinURL) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc func copySelectedEventLink(_ sender: Any?) {
        guard let event = selectedEvent, !event.joinURL.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(event.joinURL, forType: .string)
    }

    @objc func duplicateSelectedEvent(_ sender: Any?) {
        guard let event = selectedEvent else { return }
        editingEvent = event
        Task { await duplicateSelected() }
    }

    @objc func respondToSelectedEvent(_ sender: Any?) {
        guard let event = selectedEvent,
              let raw = (sender as? NSMenuItem)?.representedObject as? String,
              let response = CalendarRSVP(rawValue: raw)
        else { return }
        editingEvent = event
        Task { await respond(response) }
    }

    @objc func moveSelectedEvent(_ sender: Any?) {
        guard let event = selectedEvent,
              let target = (sender as? NSMenuItem)?.representedObject as? String
        else { return }
        Task { await move(event, to: target) }
    }

    /// The writable calendars, grouped by account, built when the submenu opens
    /// because the account list is not the menu bar's to cache.
    func populateMoveToMenu(_ menu: NSMenu) {
        menu.removeAllItems()
        guard let event = selectedEvent, event.isWritable else {
            let empty = NSMenuItem(title: String(localized: "No event selected"), action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
            return
        }
        let targets = workspace.moveTargets(for: event)
        guard !targets.isEmpty else {
            let empty = NSMenuItem(
                title: event.calendarRole.isShared
                    ? String(localized: "Shared events stay in their calendar")
                    : "No calendars available",
                action: nil,
                keyEquivalent: ""
            )
            empty.isEnabled = false
            menu.addItem(empty)
            return
        }
        for group in StarlingsCalendar.orderedGroups(of: targets) {
            let header = NSMenuItem(title: group, action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)
            for calendar in targets where calendar.groupTitle == group {
                let item = NSMenuItem(
                    title: calendar.title,
                    action: #selector(moveSelectedEvent(_:)),
                    keyEquivalent: ""
                )
                item.target = self
                item.image = calendar.color.swatchImage()
                item.indentationLevel = 1
                item.representedObject = calendar.id
                item.state = .off
                item.isEnabled = true
                menu.addItem(item)
            }
        }
    }

    // MARK: - View menu

    /// Jump to a date the grid may be months away from. Type it rather than
    /// paging: `⌘⇧T` is the way to a specific day, `⌘T` the way back to this one.
    @objc func goToDateFromMenu(_ sender: Any?) {
        let picker = NSDatePicker(frame: NSRect(x: 0, y: 0, width: 200, height: 24))
        picker.datePickerStyle = .textFieldAndStepper
        picker.datePickerElements = [.yearMonthDay]
        picker.dateValue = focusedDay
        let alert = NSAlert()
        alert.messageText = String(localized: "Go to Date")
        alert.accessoryView = picker
        alert.addButton(withTitle: String(localized: "Go"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        alert.window.initialFirstResponder = picker
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let day = Calendar.current.startOfDay(for: picker.dateValue)
        focusedDay = day
        show(mode: mode, anchor: day)
    }

    @objc func zoomInCalendar(_ sender: Any?) {
        setHourHeight(grid.hourHeight * 1.25)
    }

    @objc func zoomOutCalendar(_ sender: Any?) {
        setHourHeight(grid.hourHeight / 1.25)
    }

    @objc func resetCalendarZoom(_ sender: Any?) {
        setHourHeight(CalendarWindowPreferences.defaultHourHeight)
    }

    @objc func toggleShowDeclined(_ sender: Any?) {
        CalendarWindowPreferences.setShowsDeclined(!CalendarWindowPreferences.showsDeclined())
        render()
    }

    @objc func toggleCalendarLayer(_ sender: Any?) {
        guard let raw = (sender as? NSMenuItem)?.representedObject as? String,
              let kind = CalendarLayerKind(rawValue: raw)
        else { return }
        workspace.setHidden(kind, hidden: !workspace.isHidden(kind))
        // Hiding a layer stops fetching it, so this needs a reload.
        Task { await reload() }
    }

    @objc func refreshCalendar(_ sender: Any?) {
        Task { await reload() }
    }

    /// Zoom by the same rules the pinch obeys: never shorter than the hour that
    /// fills the view, never taller than a working day can stay on a screen.
    private func setHourHeight(_ value: CGFloat) {
        let range = CalendarWindowPreferences.hourHeightRange
        let floor = max(range.lowerBound, grid.fillingHourHeight)
        let next = min(max(range.upperBound, floor), max(floor, value))
        guard abs(next - grid.hourHeight) > 0.01 else { return }
        grid.hourHeight = next
        grid.invalidateIntrinsicContentSize()
        grid.needsDisplay = true
        gridHeight?.constant = CGFloat(grid.hourSpan) * next
        view.layoutSubtreeIfNeeded()
        CalendarWindowPreferences.setHourHeight(next)
    }

    private func move(_ event: StarlingsCalendarEvent, to calendarID: String) async {
        do {
            try await workspace.move(event, to: calendarID)
            await reload()
        } catch {
            statusLabel.showError(error)
        }
    }
}

/// What the menu bar can say about the calendar right now.
///
/// Without this the bar only knows whether a target exists, so Delete offered
/// itself over a read-only block and Join over an event with nowhere to go.
extension CalendarViewController {
    override func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        let event = selectedEvent
        let hasLink = !(event?.joinURL.isEmpty ?? true)
        switch menuItem.action {
        case #selector(openSelectedEvent(_:)):
            return event != nil
        case #selector(joinSelectedEvent(_:)), #selector(copySelectedEventLink(_:)):
            return hasLink
        case #selector(duplicateSelectedEvent(_:)), #selector(deleteSelectedEvent(_:)):
            return event?.isWritable == true
        case #selector(copy(_:)):
            return event != nil
        case #selector(cut(_:)):
            return event?.isWritable == true
        // Enabled by what is on the pasteboard, not by what is selected: a
        // paste needs a copy, not a marked event.
        case #selector(paste(_:)):
            return CalendarEventPasteboardItem.canRead()
        case #selector(respondToSelectedEvent(_:)):
            let raw = menuItem.representedObject as? String
            menuItem.state = raw != nil && raw == event?.myResponse?.rawValue ? .on : .off
            return event?.canRespond == true
        case #selector(moveSelectedEvent(_:)):
            guard let event, event.canMoveBetweenCalendars else { return false }
            let target = menuItem.representedObject as? String
            menuItem.state = .off
            return target.flatMap { targetID in
                workspace.moveTargets(for: event).contains { $0.id == targetID }
            } ?? false
        case #selector(showDayView(_:)):
            menuItem.state = mode == .day ? .on : .off
            return true
        case #selector(showWeekView(_:)):
            menuItem.state = mode == .week ? .on : .off
            return true
        case #selector(showMonthView(_:)):
            menuItem.state = mode == .month ? .on : .off
            return true
        case #selector(zoomInCalendar(_:)):
            return mode != .month && grid.hourHeight < CalendarWindowPreferences.hourHeightRange.upperBound
        case #selector(zoomOutCalendar(_:)):
            return mode != .month
                && grid.hourHeight > max(CalendarWindowPreferences.hourHeightRange.lowerBound, grid.fillingHourHeight)
        case #selector(resetCalendarZoom(_:)):
            return mode != .month
        case #selector(toggleShowDeclined(_:)):
            menuItem.state = CalendarWindowPreferences.showsDeclined() ? .on : .off
            return true
        case #selector(toggleCalendarLayer(_:)):
            guard let raw = menuItem.representedObject as? String,
                  let kind = CalendarLayerKind(rawValue: raw)
            else { return false }
            menuItem.state = workspace.isHidden(kind) ? .off : .on
            return true
        default:
            // The shell answers for the two columns; everything else is open.
            return super.validateMenuItem(menuItem)
        }
    }
}

private final class CalendarFlippedClipView: NSClipView {
    override var isFlipped: Bool { true }
}

/// A `WorkDestination` carried on an `NSMenuItem`, which holds objects only.
private final class LayerWorkLinkBox: NSObject {
    let destination: WorkDestination
    init(_ destination: WorkDestination) { self.destination = destination }
}
