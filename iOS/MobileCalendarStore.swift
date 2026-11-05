import Combine
import Foundation
import UIKit
import StarlingsContracts

/// The calendar tab's view state.
///
/// Everything that decides *what* the calendar holds — caching, merging, writes,
/// EventKit — belongs to `CalendarWorkspace`, which is the same file the Mac app
/// compiles. This type owns only what a phone screen adds on top: which day is
/// anchored, which mode is showing, what is selected, and republishing the
/// workspace into SwiftUI.
@MainActor
final class MobileCalendarStore: ObservableObject {
    private static let modeDefaultsKey = "meet.calendar.mobileMode"

    @Published var layout: MobileCalendarLayout {
        didSet {
            guard layout != oldValue else { return }
            defaults.set(layout.rawValue, forKey: Self.modeDefaultsKey)
            Task { await reload() }
        }
    }

    /// What the shared week math is asked for. The agenda is a week's worth of
    /// events read as a list, so it borrows the week's period.
    var mode: CalendarViewMode { layout.mode }

    @Published private(set) var anchor: Date
    @Published private(set) var calendars: [StarlingsCalendar] = []
    /// Everything this phone and this account can see, including what the owner
    /// has taken out of Meet. Only the Calendars sheet wants it — it is the
    /// list you choose from, and the only way a switched-off account gets back.
    @Published private(set) var allCalendars: [StarlingsCalendar] = []
    @Published private(set) var events: [StarlingsCalendarEvent] = []
    @Published private(set) var visibleLayerItems: [CalendarLayerItem] = []
    /// Events that stand in for a published event; they draw the Events swatch.
    @Published private(set) var publishedEventIDs: Set<String> = []
    @Published private(set) var googleConnected = false
    /// False until the Worker has actually answered. The banner waits for it:
    /// "Google Calendar isn't connected" is a claim, and the app should not
    /// make it while it is still asking.
    @Published private(set) var googleConnectionKnown = false
    @Published private(set) var eventKitAccess: EventKitCalendarStore.Access = .unknown
    @Published private(set) var weather: [String: DailyForecast] = [:]
    @Published private(set) var weatherFailure: String?
    /// Preferences are device-local, so a small revision lets the calendar
    /// redraw immediately after the settings sheet changes them.
    @Published private(set) var displayPreferencesRevision = 0
    @Published private(set) var isLoading = false
    @Published private(set) var isSignedIn = false
    @Published private(set) var subscriptionErrorMessage: String?
    /// A refresh that failed while the cached period still drew. Shown as a
    /// banner over the grid, the way the Mac shows it in its status line.
    @Published private(set) var loadFailureMessage: String?
    @Published private(set) var room: OwnerRoomConfiguration?
    @Published var errorMessage: String?
    /// A confirmation, shown inline where the action happened rather than as an
    /// alert — nobody wants to dismiss a dialog to see the row they just added.
    @Published var searchText = ""

    /// Shared source groups for the Calendars sheet. The Mac Settings page
    /// consumes the same `CalendarWorkspace.sourceGroups` value.
    var sourceGroups: [CalendarSourceGroup] { workspace.sourceGroups }

    private let defaults: UserDefaults
    private var workspace: CalendarWorkspace
    private weak var app: StarlingsAppModel?
    /// Which owner the current workspace was built for, so a sign-in or a
    /// sign-out swaps the backend instead of leaving a stale one in place.
    private var backendToken: String?
    private var eventKitWatcher: Task<Void, Never>?
    private var weatherTask: Task<Void, Never>?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // A phone can only really read one day at a time; an iPad has the width
        // for three. Seven columns on a hand-held device is a week you cannot
        // read, so the phone and the pad stop at three days and the Mac keeps
        // the week — a stored "week" from an older build lands on the fallback.
        let fallback: MobileCalendarLayout = UIDevice.current.userInterfaceIdiom == .phone ? .day : .threeDay
        let sharedDefault: MobileCalendarLayout = {
            switch CalendarWindowPreferences.defaultView(defaults) {
            case .day: return .day
            case .week: return .threeDay
            case .month: return .month
            }
        }()
        // The exact layout the owner picked wins. The shared preference only
        // knows day, week, and month, so a stored "2 Days" or "List" cannot
        // survive a round trip through it.
        let preferred = MobileCalendarLayout.storedDefault(defaults)
            ?? (CalendarWindowPreferences.hasStoredDefaultView(defaults) ? sharedDefault : fallback)
        layout = defaults.string(forKey: Self.modeDefaultsKey)
            .flatMap(MobileCalendarLayout.init(rawValue:)) ?? preferred
        anchor = Date()
        workspace = CalendarWorkspace(backend: DisconnectedCalendarBackend(), defaults: defaults)
        bindWorkspace()
    }

    /// The workspace publishes several times per load — what was on disk, then
    /// what EventKit holds, then what the network says. Each is a screen worth
    /// showing rather than a spinner held until the slowest source answers.
    private func bindWorkspace() {
        workspace.onChange = { [weak self] in self?.publish() }
    }

    // MARK: - Wiring

    /// Called from the view with the current credentials. Rebuilds the backend
    /// only when the owner actually changed.
    /// True once `attach` has a workspace for the current session. A reveal
    /// that arrives before that waits for the attach to finish and run it.
    private(set) var isAttached = false

    func attach(to app: StarlingsAppModel) async {
        self.app = app
        isAttached = false
        let token = app.ownerCredentials?.accessToken
        if token != backendToken {
            backendToken = token
            isSignedIn = token != nil
            workspace = CalendarWorkspace(
                backend: app.ownerCredentials.map {
                    MobileCalendarBackend(environment: .configured(), credentials: $0)
                } ?? DisconnectedCalendarBackend(),
                defaults: defaults
            )
            bindWorkspace()
        }
        startWatchingEventKit()
        await loadRoom()
        await reload()
        isAttached = true
    }

    /// Stopping the watcher is what tearing down the tab means; `deinit` cannot
    /// touch main-actor state, and the loop already exits once `self` is gone.
    func detach() {
        eventKitWatcher?.cancel()
        eventKitWatcher = nil
        weatherTask?.cancel()
        weatherTask = nil
    }

    /// Another process — Calendar.app, an iCloud push, a Mac — changed the local
    /// store, so what is on screen is stale.
    private func startWatchingEventKit() {
        guard eventKitWatcher == nil else { return }
        eventKitWatcher = Task { [weak self] in
            for await _ in EventKitCalendarStore.externalChanges {
                guard let self else { return }
                await self.reload()
            }
        }
    }

    private func loadRoom() async {
        guard let app, let credentials = app.ownerCredentials else {
            room = nil
            return
        }
        room = try? await app.api.ownerRoom(credentials: credentials)
    }

    // MARK: - Period on screen

    var days: [Date] {
        layout.days(anchor: anchor)
    }

    /// The days of a neighbouring period, for the pages either side of the one
    /// being read.
    func days(offset: Int) -> [Date] {
        guard offset != 0 else { return days }
        return layout.days(anchor: layout.stepAnchor(from: anchor, direction: offset))
    }

    /// The days a paging grid actually builds: what is on screen, plus one day
    /// of runway at each end.
    ///
    /// The multi-day grids move one column at a time, so any day can sit in any
    /// position — a 2-day window is free to show Tue/Wed and then Wed/Thu. That
    /// makes a step one day, not one period, so the runway is a single day
    /// either side rather than a whole second window.
    var runDays: [Date] {
        let calendar = Calendar.current
        let days = days
        guard let first = days.first,
              let start = calendar.date(byAdding: .day, value: -1, to: calendar.startOfDay(for: first))
        else { return days }
        return CalendarWeekMath.days(ofWeekStarting: start, count: days.count + 2, calendar: calendar)
    }

    /// What is actually fetched: the period on screen **and one either side**.
    ///
    /// A swipe shows the next period arriving while this one leaves, so both
    /// have to be real before the gesture starts. Loading only what is on
    /// screen is what made the old swipe read as a data swap — the neighbour
    /// was empty until the animation finished.
    var loadedRange: DateInterval {
        let calendar = Calendar.current
        let spread = (-1...1).flatMap { days(offset: $0) }
        let start = spread.map { calendar.startOfDay(for: $0) }.min() ?? calendar.startOfDay(for: anchor)
        let lastDay = spread.map { calendar.startOfDay(for: $0) }.max() ?? start
        let end = calendar.date(byAdding: .day, value: 1, to: lastDay) ?? start.addingTimeInterval(86_400)
        return DateInterval(start: start, end: end)
    }

    /// The period the workspace is asked for: the days on screen, plus the tail
    /// of the last one so an event ending at midnight is still fetched.
    var visibleRange: DateInterval {
        let calendar = Calendar.current
        let days = days
        let start = calendar.startOfDay(for: days.first ?? anchor)
        let end = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: days.last ?? anchor))
            ?? start.addingTimeInterval(86_400)
        return DateInterval(start: start, end: end)
    }

    var periodTitle: String {
        let days = days
        switch layout {
        case .day:
            return anchor.formatted(.dateTime.weekday(.wide).month(.wide).day())
        case .twoDay, .threeDay:
            let first = days.first ?? anchor
            return CalendarPeriodTitle.months(first: first, last: days.last ?? first)
        case .agenda:
            // The list has no columns to read a date off, so it keeps the span.
            guard let first = days.first, let last = days.last else { return "" }
            let sameMonth = Calendar.current.isDate(first, equalTo: last, toGranularity: .month)
            let left = first.formatted(.dateTime.month(.abbreviated).day())
            let right = sameMonth
                ? last.formatted(.dateTime.day())
                : last.formatted(.dateTime.month(.abbreviated).day())
            return String(localized: "\(left) – \(right)")
        case .month:
            return anchor.formatted(.dateTime.month(.wide).year())
        }
    }

    func step(_ direction: Int) {
        anchor = layout.stepAnchor(from: anchor, direction: direction)
        Task { await reload() }
    }

    func goToToday() {
        anchor = Date()
        Task { await reload() }
    }

    func select(day: Date) {
        anchor = day
        Task { await reload() }
    }

    /// Page to the day a Home row's event falls on and find it there. The
    /// feed and the workspace address the same Google event differently
    /// (`calendarId:rawId` against `g:calendarId:rawId`), so the match is on
    /// the raw id, the way the Mac's reveal does it. A merged group is found
    /// through its fingerprint: the lead may be the copy on another calendar.
    func reveal(_ event: MobileCalendarEvent) async -> CalendarEventGroup? {
        guard let start = CalendarDateParsing.parse(event.start) else { return nil }
        anchor = start
        await reload()
        let rawID = event.rawEventID
        guard let match = events.first(where: { $0.rawEventID == rawID || $0.rawEventID.hasSuffix(rawID) }) else {
            return nil
        }
        let key = CalendarWeekMath.fingerprint(match)
        return groups(on: start).first { CalendarWeekMath.fingerprint($0.event) == key }
    }

    /// The ⌘K palette's event door: `<calendarId>:<eventId>` as the Worker
    /// spells it, with no date. The match is on the raw Google id, as above.
    /// An event outside the loaded period is looked for across the window the
    /// Worker searched (a week back, five ahead) before giving up; that read
    /// is by month, so it is cached for the paging that follows.
    func reveal(eventReference: String) async -> CalendarEventGroup? {
        guard let colon = eventReference.lastIndex(of: ":") else { return nil }
        let rawID = String(eventReference[eventReference.index(after: colon)...])
        func match() -> StarlingsCalendarEvent? {
            workspace.visibleEvents.first { $0.rawEventID == rawID || $0.rawEventID.hasSuffix(rawID) }
        }
        if match() == nil {
            let now = Date()
            let window = DateInterval(start: now.addingTimeInterval(-7 * 86_400), end: now.addingTimeInterval(38 * 86_400))
            isLoading = true
            await workspace.reload(range: window)
            isLoading = false
        }
        guard let found = match() else { return nil }
        anchor = found.start
        await reload()
        let key = CalendarWeekMath.fingerprint(found)
        return groups(on: found.start).first { CalendarWeekMath.fingerprint($0.event) == key }
    }

    // MARK: - Reading

    func reload(force: Bool = false) async {
        let range = loadedRange
        if force || !workspace.isCached(range) { isLoading = true }
        await workspace.reload(range: range)
        publish()
        isLoading = false
        refreshWeather()
        // One period further out again, so the page after the next one is warm
        // by the time a second swipe reaches it.
        await workspace.prefetch(range: horizon)
    }

    /// Two periods either side — cached, not published.
    private var horizon: DateInterval {
        let calendar = Calendar.current
        let outer = [-2, 2].flatMap { days(offset: $0) }
        let range = loadedRange
        let start = min(range.start, outer.map { calendar.startOfDay(for: $0) }.min() ?? range.start)
        let end = max(range.end, outer.map { calendar.startOfDay(for: $0) }.max() ?? range.end)
        return DateInterval(start: start, end: end)
    }

    // MARK: - Layers

    func isHidden(_ layer: CalendarLayerKind) -> Bool { workspace.isHidden(layer) }

    func setHidden(_ layer: CalendarLayerKind, hidden: Bool) {
        workspace.setHidden(layer, hidden: hidden)
        objectWillChange.send()
        Task { await reload(force: true) }
    }

    private func publish() {
        calendars = workspace.calendars
        allCalendars = workspace.allCalendars
        events = displayedEvents(workspace.visibleEvents)
        visibleLayerItems = workspace.visibleLayerItems
        publishedEventIDs = workspace.publishedEventIDs
        googleConnected = workspace.googleConnected
        googleConnectionKnown = workspace.googleConnection != .unknown
        eventKitAccess = workspace.eventKitAccess
        subscriptionErrorMessage = workspace.subscriptionError
        if workspace.requiresAuthentication {
            app?.handleExpiredOwnerSession()
        } else {
            // Assigned every time, including nil: this is the state of the last
            // read, and a read that worked has to be able to clear it. It is
            // deliberately not `errorMessage` — the weeks on screen drew from
            // the cache, so nothing is waiting on a dialog being dismissed.
            loadFailureMessage = workspace.lastError
        }
    }

    private func displayedEvents(_ candidates: [StarlingsCalendarEvent]) -> [StarlingsCalendarEvent] {
        let showsDeclined = CalendarWindowPreferences.showsDeclined(defaults)
        let showsHidden = CalendarWindowPreferences.showsHidden(defaults)
        return candidates.filter {
            (showsDeclined || $0.myResponse != .declined) && (showsHidden || !$0.isDemoted)
        }
    }

    /// Weather is deliberately independent of calendar loading: a slow or
    /// unavailable forecast must never make the owner's events wait.
    func refreshWeather() {
        weatherTask?.cancel()
        guard let place = WeatherPreferences.activePlace(defaults) else {
            weather = [:]
            weatherFailure = nil
            return
        }
        weatherTask = Task { [weak self] in
            let outcome = await WeatherForecastService.forecast(for: place)
            guard let self,
                  WeatherPreferences.activePlace(self.defaults) == place else { return }
            self.weather = outcome.days
            self.weatherFailure = outcome.failure
        }
    }

    /// A pinch changes only how tall an hour is drawn. Nothing is refetched or
    /// refiltered — this runs on every frame of the gesture.
    func refreshGridScale() {
        displayPreferencesRevision += 1
    }

    func refreshDisplayPreferences() {
        displayPreferencesRevision += 1
        refreshWeather()
        publish()
    }

    func googleCalendarEntries() async throws -> [GoogleCalendarListEntry] {
        try await workspace.googleCalendarEntries()
    }

    func setGoogleCalendarSelection(_ ids: [String]) async throws {
        try await workspace.setGoogleCalendarSelection(ids)
    }

    /// Timed rows on `day` — events merged across duplicate subscriptions, plus
    /// any task due at a time — packed into overlap columns in **one** pass, so
    /// a task due at 15:00 and a meeting at 15:00 share the width instead of
    /// covering each other.
    func timedLayout(for day: Date) -> [MobileCalendarTimedBlock] {
        let groups = CalendarWeekMath.consolidate(events.filter { !$0.isAllDay })
        let groupsByID = Dictionary(uniqueKeysWithValues: groups.map { ($0.id, $0) })
        let timedLayers = visibleLayerItems.filter { !$0.isAllDay }
        let layersByID = Dictionary(uniqueKeysWithValues: timedLayers.map { ($0.id, $0) })

        // Layer rows are given the same clipping treatment as events so one
        // running past midnight still appears on the day it runs through.
        let layerSpans = timedLayers.compactMap { item -> CalendarTimedSpan? in
            let calendar = Calendar.current
            let dayStart = calendar.startOfDay(for: day)
            guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart),
                  item.start < dayEnd, item.end > dayStart
            else { return nil }
            return CalendarTimedSpan(
                id: item.id,
                start: max(item.start, dayStart),
                end: min(item.end, dayEnd)
            )
        }

        let spans = (CalendarWeekMath.daySegments(groups.map(\.event), day: day) + layerSpans)
            .sorted { left, right in
                if left.start != right.start { return left.start < right.start }
                return left.end > right.end
            }
        let packs = Dictionary(uniqueKeysWithValues: CalendarWeekMath.pack(spans).map { ($0.id, $0) })

        return spans.compactMap { span in
            guard let pack = packs[span.id] else { return nil }
            if let group = groupsByID[span.id] {
                return MobileCalendarTimedBlock(content: .event(group), span: span, pack: pack)
            }
            if let item = layersByID[span.id] {
                return MobileCalendarTimedBlock(content: .layer(item), span: span, pack: pack)
            }
            return nil
        }
    }

    /// The all-day band: all-day events, milestones, and dated public events,
    /// stacked together so their rows cannot collide.
    func allDayLayout(for days: [Date]) -> [MobileCalendarAllDayBlock] {
        let groups = CalendarWeekMath.consolidate(events.filter(\.isAllDay))
        let groupsByID = Dictionary(uniqueKeysWithValues: groups.map { ($0.id, $0) })
        let datedLayers = visibleLayerItems.filter(\.isAllDay)
        let layersByID = Dictionary(uniqueKeysWithValues: datedLayers.map { ($0.id, $0) })

        let spans = groups.map { CalendarAllDaySpan(id: $0.id, start: $0.event.start, end: $0.event.end) }
            + datedLayers.map { CalendarAllDaySpan(id: $0.id, start: $0.start, end: $0.end) }

        return CalendarWeekMath.packAllDay(spans, days: days).compactMap { layout in
            if let group = groupsByID[layout.id] {
                return MobileCalendarAllDayBlock(content: .event(group), layout: layout)
            }
            if let item = layersByID[layout.id] {
                return MobileCalendarAllDayBlock(content: .layer(item), layout: layout)
            }
            return nil
        }
    }

    /// Layer rows touching `day`, for the month cells and the list.
    func layerItems(on day: Date) -> [CalendarLayerItem] {
        let calendar = Calendar.current
        let dayStart = calendar.startOfDay(for: day)
        guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else { return [] }
        return visibleLayerItems
            .filter { $0.start < dayEnd && $0.end > dayStart }
            .sorted { left, right in
                if left.isAllDay != right.isAllDay { return left.isAllDay }
                return left.start < right.start
            }
    }

    /// Everything touching `day`, all-day first then by start — for the month
    /// grid's chips and the day list under it.
    func groups(on day: Date) -> [CalendarEventGroup] {
        let calendar = Calendar.current
        let dayStart = calendar.startOfDay(for: day)
        guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else { return [] }
        let touching = events.filter { event in
            if event.isAllDay {
                return CalendarWeekMath.allDayDayRange(event, days: [day]) != nil
            }
            return event.start < dayEnd && event.end > dayStart
        }
        return CalendarWeekMath.consolidate(touching).sorted { left, right in
            if left.event.isAllDay != right.event.isAllDay { return left.event.isAllDay }
            return left.event.start < right.event.start
        }
    }

    /// Agenda for a period, grouped by day and skipping empty days. A day
    /// carrying only a milestone is not empty.
    func agenda(for days: [Date]) -> [MobileCalendarDaySection] {
        days
            .map { MobileCalendarDaySection(day: $0, groups: groups(on: $0)) }
            .filter { !$0.groups.isEmpty || !layerItems(on: $0.day).isEmpty }
    }

    var agenda: [MobileCalendarDaySection] { agenda(for: days) }

    /// Search reaches past the period on screen into every month already
    /// fetched, so a title you half-remember is findable without paging to it.
    var searchResults: [CalendarEventGroup] {
        let needle = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return [] }
        var byID: [String: StarlingsCalendarEvent] = [:]
        for event in displayedEvents(events + workspace.cachedEvents)
        where !workspace.isHidden(event.calendarID) {
            byID[event.id] = event
        }
        let matches = byID.values.filter { event in
            event.displayTitle.lowercased().contains(needle)
                || event.location.lowercased().contains(needle)
                || event.notes.lowercased().contains(needle)
                || event.attendeeEmails.contains { $0.lowercased().contains(needle) }
        }
        return CalendarWeekMath.consolidate(matches.sorted { $0.start < $1.start })
    }

    func color(for calendarID: String) -> StarlingsRGBColor { workspace.color(for: calendarID) }

    func colors(for group: CalendarEventGroup) -> [StarlingsRGBColor] {
        let own = group.calendarIDs.map { workspace.color(for: $0) }
        return publishedEventIDs.contains(group.event.id) ? own + [CalendarLayerKind.publicEvents.color] : own
    }

    func calendarTitle(for calendarID: String) -> String {
        calendars.first { $0.id == calendarID }?.title ?? ""
    }

    // MARK: - Visibility and defaults

    func isHidden(_ calendarID: String) -> Bool { workspace.isHidden(calendarID) }

    func setHidden(_ calendarID: String, hidden: Bool) {
        workspace.setHidden(calendarID, hidden: hidden)
        publish()
    }

    var removableAccounts: [String: String] { workspace.removableAccounts }

    /// The exchange just said Google is connected; take its word over the next
    /// status read — see `CalendarWorkspace.noteGoogleConnected`.
    func noteGoogleConnected(email: String?) {
        workspace.noteGoogleConnected(CalendarConnectionStatus(connected: true, email: email))
        publish()
    }

    func noteGoogleAccountAdded(_ account: CalendarAccount) {
        workspace.noteGoogleAccountAdded(account, calendars: nil)
        publish()
    }

    func removeGoogleAccount(_ id: String) async throws {
        let email = workspace.googleAccounts.first(where: { $0.id == id })?.email ?? String(localized: "that account")
        try await workspace.removeGoogleAccount(id)
        await reload(force: true)
        notice(String(localized: "Removed \(email)"))
    }

    func subscribe(to url: String) async throws {
        let subscription = try await workspace.subscribe(to: url)
        await reload(force: true)
        notice(String(localized: "Subscribed to \(subscription.title)"))
    }

    func unsubscribe(_ id: String) async throws {
        let title = workspace.subscriptions.first(where: { $0.id == id })?.title ?? String(localized: "that calendar")
        try await workspace.unsubscribe(id)
        await reload(force: true)
        notice(String(localized: "Unsubscribed from \(title)"))
    }

    /// After a save with guests: what went out. The Worker asks Google to
    /// mail the guests when the list changed or the meeting moved; the
    /// person who pressed Save otherwise has no way to know an invite left.
    /// The same three lines the Mac's status line uses.
    func noticeInvites(count: Int, isNew: Bool, moved: Bool) {
        guard count > 0 else { return }
        let verb = isNew ? String(localized: "Invites sent") : (moved ? String(localized: "Updates sent") : String(localized: "Invites updated"))
        notice(String(localized: "\(verb) · \(count) guests"))
    }

    /// A confirmation is a toast, so it cannot sit there looking like state.
    func notice(_ message: String) {
        StarlingsToastCenter.shared.show(message)
    }

    /// In Meet at all, as opposed to drawn today. Switching one off takes the
    /// calendar out of every list and stops it being fetched, so it needs a
    /// reload rather than a redraw — and switching one back on needs the
    /// events it never fetched.
    func isDisabled(_ calendar: StarlingsCalendar) -> Bool { workspace.isDisabled(calendar) }

    func setDisabled(_ calendar: StarlingsCalendar, disabled: Bool) {
        workspace.setDisabled(calendar, disabled: disabled)
        publish()
        Task { await reload(force: true) }
    }

    func isAccountDisabled(_ group: String) -> Bool { workspace.isAccountDisabled(group) }

    func setAccountDisabled(_ group: String, disabled: Bool) {
        workspace.setAccountDisabled(group, disabled: disabled)
        publish()
        Task { await reload(force: true) }
    }

    func isAccountHidden(_ group: String) -> Bool { workspace.isAccountHidden(group) }

    func setAccountHidden(_ group: String, hidden: Bool) {
        workspace.setAccountHidden(group, hidden: hidden)
        publish()
    }

    var includesLocalCalendars: Bool { workspace.includesLocalCalendars }

    var upcomingPreferences: UpcomingPreferencesWire { workspace.upcomingPreferences }
    var upcomingExcludedSubscriptionIDs: Set<String> { workspace.upcomingExcludedSubscriptionIDs }
    var upcomingSubscriptions: [CalendarSubscription] {
        let enabledIDs = Set(calendars.filter { $0.source == .subscription }.map(\.rawID))
        return workspace.subscriptions.filter { enabledIDs.contains($0.id) }
    }

    func setUpcomingPreferences(_ preferences: UpcomingPreferencesWire) async throws {
        try await workspace.setUpcomingPreferences(preferences)
        publish()
        objectWillChange.send()
        await app?.upcoming.refresh(force: true)
    }

    func setUpcomingExcludedSubscriptionIDs(_ ids: Set<String>) async throws {
        try await workspace.setUpcomingExcludedSubscriptionIDs(ids)
        publish()
        objectWillChange.send()
    }

    func refreshSources() async {
        await workspace.refreshSources()
        publish()
    }

    func setIncludesLocalCalendars(_ included: Bool) {
        workspace.setIncludesLocalCalendars(included)
        publish()
        Task { await reload(force: true) }
    }

    func setDemoted(_ event: StarlingsCalendarEvent, demoted: Bool) async -> Bool {
        workspace.setDemoted(event, demoted: demoted)
        publish()
        await app?.upcoming.refresh(force: true)
        return true
    }

    /// File the event under a project or lead, or unfile it. Home's next
    /// meeting re-reads so the subject shows under the title at once.
    func setSubject(_ event: StarlingsCalendarEvent, _ subject: CrmSubject?) async {
        workspace.setSubject(event, subject)
        publish()
        await app?.upcoming.refresh(force: true)
    }

    func searchSubjects(kind: MeetingCategoryKind.SubjectKind, query: String) async -> [CrmSubject] {
        await workspace.searchSubjects(kind: kind, query: query)
    }

    /// Quick add's fallback: the sentence to the notes engine,
    /// through the signed-in backend. Nil when signed out or the Worker did
    /// not answer; the grammar's draft stands then.
    func quickAddFallback(_ sentence: String, now: String, defaultDurationMinutes: Int) async -> CalendarQuickAddDraft? {
        await workspace.quickAddFallback(sentence, now: now, defaultDurationMinutes: defaultDurationMinutes)
    }

    var writeCalendarID: String? {
        get { workspace.writeCalendarID }
        set {
            workspace.writeCalendarID = newValue
            objectWillChange.send()
        }
    }

    var defaultWriteCalendar: StarlingsCalendar? { workspace.defaultWriteCalendar() }

    var writableCalendars: [StarlingsCalendar] { calendars.filter(\.isWritable) }

    /// Calendar choices for an existing event. The current shared calendar is
    /// retained so the editor can show its stable home, while other shared
    /// calendars never appear as move destinations.
    func calendarChoices(for event: StarlingsCalendarEvent) -> [StarlingsCalendar] {
        workspace.moveMenuCalendars(for: event)
    }

    func moveTargets(for event: StarlingsCalendarEvent) -> [StarlingsCalendar] {
        workspace.moveTargets(for: event)
    }

    /// What the default-calendar picker offers. Narrower than `writableCalendars`
    /// on purpose: an event can still be *put* on the internal company calendar,
    /// but new events never land there on their own.
    var defaultCalendarChoices: [StarlingsCalendar] { calendars.filter(CalendarWorkspace.canBeWriteTarget) }

    var defaultCalendarPickerOptions: [StarlingsSearchablePickerOption] {
        defaultCalendarChoices.map { calendar in
            StarlingsSearchablePickerOption(
                id: calendar.id,
                title: calendar.title,
                context: calendar.groupTitle,
                subtitle: calendar.accountEmail,
                colorHex: String(format: "#%02X%02X%02X", Int(calendar.displayColor.red * 255), Int(calendar.displayColor.green * 255), Int(calendar.displayColor.blue * 255))
            )
        }
    }

    /// Guests' busy time across `day`, for picking a slot in the editor.
    ///
    /// Only while an event is open, same as the Mac: this is help for choosing
    /// a time, not a standing view of other people's calendars.
    func freeBusy(for emails: [String], on day: Date) async -> [CalendarFreeBusyPerson] {
        let calendar = Calendar.current
        let start = calendar.startOfDay(for: day)
        guard let end = calendar.date(byAdding: .day, value: 1, to: start) else { return [] }
        return await workspace.freeBusy(for: emails, range: DateInterval(start: start, end: end))
    }

    // MARK: - Writing

    func create(_ draft: MobileCalendarDraft) async -> Bool {
        await perform {
            try await self.workspace.create(
                title: draft.title,
                start: draft.start,
                end: draft.end,
                calendarID: draft.calendarID,
                joinURL: draft.joinURL,
                roomSlug: draft.roomSlug,
                attendees: draft.attendees,
                notes: draft.notes.isEmpty ? nil : draft.notes,
                location: draft.location.isEmpty ? nil : draft.location,
                travelTimeMinutes: draft.travelTimeMinutes > 0 ? draft.travelTimeMinutes : nil
            )
        }
    }

    func update(_ event: StarlingsCalendarEvent, with draft: MobileCalendarDraft, span: CalendarEditSpan) async -> Bool {
        await perform {
            try await self.workspace.update(
                event,
                title: draft.title,
                start: draft.start,
                end: draft.end,
                joinURL: draft.joinURL,
                roomSlug: draft.roomSlug,
                // nil, not an echo: a reschedule must not rewrite the guest list.
                attendees: draft.attendeesChanged ? draft.attendees : nil,
                notes: draft.notes,
                location: draft.location,
                travelTimeMinutes: event.source == .google && draft.travelTimeMinutes != (event.travelTimeMinutes ?? 0)
                    ? draft.travelTimeMinutes
                    : nil,
                span: span
            )
        }
    }

    func delete(_ event: StarlingsCalendarEvent, span: CalendarEditSpan) async -> Bool {
        await perform { try await self.workspace.delete(event, span: span) }
    }

    func move(_ event: StarlingsCalendarEvent, to calendarID: String) async -> Bool {
        await perform { try await self.workspace.move(event, to: calendarID) }
    }

    func duplicate(_ event: StarlingsCalendarEvent, to calendarID: String) async -> Bool {
        await perform { try await self.workspace.duplicate(event, to: calendarID) }
    }

    func respond(to event: StarlingsCalendarEvent, as response: CalendarRSVP) async -> Bool {
        await perform { try await self.workspace.respond(to: event, as: response) }
    }

    /// Long-press movement uses the same optimistic workspace path as the Mac:
    /// the block follows the finger immediately, and a failed write restores
    /// the old schedule rather than leaving the grid lying about the event.
    func reschedule(_ event: StarlingsCalendarEvent, start: Date, end: Date) async {
        guard let previous = workspace.applyLocalSchedule(eventID: event.id, start: start, end: end) else { return }
        publish()
        do {
            try await workspace.update(
                event,
                title: event.title,
                start: start,
                end: end,
                joinURL: event.joinURL.isEmpty ? nil : event.joinURL,
                roomSlug: event.roomSlug.isEmpty ? nil : event.roomSlug,
                attendees: nil,
                notes: event.notes,
                location: event.location,
                span: .thisEvent
            )
        } catch {
            workspace.revertLocalSchedule(to: previous)
            publish()
            errorMessage = Self.describe(error)
            return
        }
        await reload(force: true)
        await app?.upcoming.refresh(force: true)
    }

    private func perform(_ work: () async throws -> Void) async -> Bool {
        do {
            try await work()
        } catch {
            errorMessage = Self.describe(error)
            return false
        }
        await reload(force: true)
        await app?.upcoming.refresh(force: true)
        return true
    }

    /// `StarlingsError` is the shared calendar's own failure type and is not a
    /// `LocalizedError`, so it needs unwrapping before it reads as a sentence.
    /// Nil for cancellation, which has no sentence worth showing: the work was
    /// dropped because the screen went away, and `errorMessage` is optional
    /// precisely so nothing is said in that case.
    /// Nonisolated: turning an error into text touches no state.
    nonisolated static func describe(_ error: Error) -> String? {
        if error is CancellationError { return nil }
        if let meet = error as? StarlingsError {
            return meet.message.isEmpty ? meet.title : meet.message
        }
        return error.localizedDescription
    }
}

/// What a drawn row actually is. The grid packs both kinds together, but they
/// are never interchangeable: only an event can be opened for editing.
enum MobileCalendarSlot: Identifiable {
    case event(CalendarEventGroup)
    case layer(CalendarLayerItem)

    var id: String {
        switch self {
        case .event(let group): return group.id
        case .layer(let item): return item.id
        }
    }

    var eventGroup: CalendarEventGroup? {
        if case .event(let group) = self { return group }
        return nil
    }
}

/// Laid-out rows the views iterate. These are structs rather than tuples
/// because `ForEach(_:id:)` needs a key path, and Swift has none into a tuple.
struct MobileCalendarTimedBlock: Identifiable {
    let content: MobileCalendarSlot
    let span: CalendarTimedSpan
    let pack: CalendarPackedSpan

    var id: String { content.id }
}

struct MobileCalendarAllDayBlock: Identifiable {
    let content: MobileCalendarSlot
    let layout: CalendarAllDayLayout

    var id: String { content.id }
}

struct MobileCalendarDaySection: Identifiable {
    let day: Date
    let groups: [CalendarEventGroup]

    var id: Date { day }
}

/// How the period on screen is drawn. A superset of the Mac's `CalendarViewMode`
/// because a phone earns a list view the Mac window does not need — the shared
/// enum stays exactly what the week math understands.
enum MobileCalendarLayout: String, CaseIterable, Identifiable, Sendable {
    case day
    case twoDay
    case threeDay
    case month
    case agenda

    var id: String { rawValue }

    var mode: CalendarViewMode {
        switch self {
        case .day, .twoDay, .threeDay: return .day
        case .agenda: return .week
        case .month: return .month
        }
    }

    /// What this layout means to the surfaces that only know day/week/month —
    /// the shared default-view preference the Mac window also reads. A hand-held
    /// multi-day grid is that surface's week.
    var defaultViewMode: CalendarViewMode {
        switch self {
        case .day: return .day
        case .twoDay, .threeDay, .agenda: return .week
        case .month: return .month
        }
    }

    /// Where this device's chosen opening layout is kept. Written beside the
    /// shared `defaultView` rather than instead of it: the Mac keeps reading
    /// the coarse value, and the phone keeps the layout it was actually given.
    private static let defaultLayoutKey = "meet.calendar.mobileDefaultView"

    static func storedDefault(_ defaults: UserDefaults = .standard) -> MobileCalendarLayout? {
        defaults.string(forKey: defaultLayoutKey).flatMap(MobileCalendarLayout.init(rawValue:))
    }

    static func setStoredDefault(_ layout: MobileCalendarLayout, _ defaults: UserDefaults = .standard) {
        defaults.set(layout.rawValue, forKey: defaultLayoutKey)
        CalendarWindowPreferences.setDefaultView(layout.defaultViewMode, defaults)
    }

    var label: String {
        switch self {
        case .day: return "Day"
        case .twoDay: return "2 Days"
        case .threeDay: return "3 Days"
        case .month: return "Month"
        case .agenda: return "List"
        }
    }

    var symbolName: String {
        switch self {
        case .day: return "calendar.day.timeline.left"
        case .twoDay: return "calendar.badge.clock"
        case .threeDay: return "calendar.badge.clock"
        case .month: return "square.grid.3x3"
        case .agenda: return "list.bullet"
        }
    }

    func days(anchor: Date, calendar: Calendar = .current) -> [Date] {
        switch self {
        case .day, .twoDay, .threeDay:
            let count: Int
            switch self {
            case .day: count = 1
            case .twoDay: count = 2
            case .threeDay: count = 3
            case .month, .agenda: count = 1
            }
            return CalendarWeekMath.days(
                ofWeekStarting: calendar.startOfDay(for: anchor),
                count: count,
                calendar: calendar
            )
        case .month:
            return CalendarWeekMath.days(for: .month, anchor: anchor, calendar: calendar)
        case .agenda:
            // The same rolling seven days the Mac grid and the web page show.
            return CalendarWeekMath.days(
                ofWeekStarting: calendar.startOfDay(for: anchor),
                calendar: calendar
            )
        }
    }

    func stepAnchor(from anchor: Date, direction: Int, calendar: Calendar = .current) -> Date {
        switch self {
        case .day:
            return calendar.date(byAdding: .day, value: direction, to: anchor) ?? anchor
        case .twoDay, .threeDay:
            // One day, not one window. Paging by the width of the window would
            // fix which days can share a screen — a 2-day view would only ever
            // show the same pairs — and there is nothing about Tue/Wed that
            // makes it a period. Any day can lead any window.
            return calendar.date(byAdding: .day, value: direction, to: anchor) ?? anchor
        case .month:
            return CalendarWeekMath.step(mode, from: anchor, direction: direction, calendar: calendar)
        case .agenda:
            return CalendarWeekMath.step(.week, from: anchor, direction: direction, calendar: calendar)
        }
    }
}

/// What the editor sheet hands back. Deliberately not `StarlingsCalendarEvent`: a
/// draft is text being typed, not something that exists on a calendar yet.
struct MobileCalendarDraft: Equatable {
    var title = ""
    var start = Date()
    var end = Date().addingTimeInterval(
        TimeInterval(CalendarWindowPreferences.defaultDurationMinutes() * 60)
    )
    var isAllDay = false
    var calendarID = ""
    var location = ""
    var notes = ""
    var attendees: [String] = []
    var attendeesChanged = false
    var joinURL: String?
    var roomSlug: String?
    /// Minutes to get there; 0 is Off. Written to Google only.
    var travelTimeMinutes = 0

    /// The travel row's choices, the same five on Mac, iOS and web.
    static let travelChoices = CalendarValues.travelMinutes

    var isValid: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !calendarID.isEmpty
            && end > start
    }
}
