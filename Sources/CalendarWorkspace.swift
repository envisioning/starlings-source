import Foundation
import OSLog

/// The calendar's whole state and every write it can make, with no view layer
/// and no platform in it: the Mac window and the iOS calendar both drive this.
@MainActor
final class CalendarWorkspace {
    private static let writeDefaultsKey = "meet.calendar.writeId"
    /// How long a fetched month is trusted before it is re-read. Short enough
    /// that a stale week self-corrects, long enough that paging is instant.
    /// The Mac calendar polls on this interval, so a reload sooner is a no-op.
    static let monthTTL: TimeInterval = 120
    /// Waits between the quiet retries of a Google read that failed in a way a
    /// second try can fix (the device just woke, Wi-Fi is still coming back).
    /// Only when these have also failed does the banner appear.
    /// `CalendarRefreshRetry` owns the rule; tests shorten the waits.
    var transientRetryDelays: [Duration] = CalendarRefreshRetry.delays
    private static let calendarListTTL: TimeInterval = 600

    /// The same shape the disk cache stores, so a restored month and a freshly
    /// fetched one are the same value.
    private typealias CachedMonth = CalendarEventCache.Month

    private let backend: any CalendarBackend
    private let eventKit = EventKitCalendarStore()
    private let defaults: UserDefaults

    /// Called whenever `events`, `calendars`, or `layerItems` change — which is
    /// several times per `reload`, on purpose. A calendar that only draws once
    /// the last request has answered is a calendar that waits for its slowest
    /// source; this is how the cached and local halves get on screen first.
    var onChange: (() -> Void)?

    /// The calendars in play: everything discovered, minus what the owner has
    /// switched off in Settings. Every reader of the calendar wants this one.
    private(set) var calendars: [StarlingsCalendar] = []
    /// Everything the device and the account can see, disabled ones included.
    /// Only the Settings list wants this — it is the list you choose *from*.
    private(set) var allCalendars: [StarlingsCalendar] = []
    private(set) var events: [StarlingsCalendarEvent] = []
    /// Company-determined rows — published events, milestones, dated tasks.
    /// Read-only by construction: they are not `StarlingsCalendarEvent`s, so no write
    /// path can be handed one.
    private(set) var layerItems: [CalendarLayerItem] = []
    /// Three answers, not two: connected, not connected, and **not yet asked**.
    ///
    /// A boolean starting at `false` says "no Google Calendar" for the whole
    /// first second of every launch, which is how the calendar came to greet
    /// people with "Google Calendar isn't connected" before drawing their
    /// Google calendar. Unknown is its own state so a surface can hold its
    /// tongue until there is something true to say.
    enum GoogleConnection: Sendable {
        case unknown
        case connected
        case disconnected
    }

    private(set) var googleConnection: GoogleConnection = .unknown
    /// Convenience for the many call sites that only branch on "can we fetch".
    /// Unknown reads as not-connected here on purpose — it gates work, not copy.
    var googleConnected: Bool { googleConnection == .connected }
    private(set) var eventKitAccess: EventKitCalendarStore.Access = .unknown
    private(set) var lastError: String?
    /// The code and raw diagnostic behind `lastError`, for Copy. The status
    /// line reads the sentence; a pasted report without the code is a second
    /// round-trip.
    private(set) var lastErrorDetail: String?
    private(set) var requiresAuthentication = false

    /// Injectable so the connect grace can be tested without waiting it out.
    var now: () -> Date = Date.init

    private var googleMonths: [String: CachedMonth] = [:]
    private var cachedGoogleCalendars: [StarlingsCalendar] = []
    /// The wire entries behind `cachedGoogleCalendars`, kept so the list can be
    /// regrouped when a second account arrives. Empty when the calendars were
    /// restored from disk, which stores only the drawn form.
    private var cachedGoogleEntries: [GoogleCalendarListEntry] = []
    /// What a connect handed back, kept for the grace period so a listing that
    /// KV answers from before the write cannot drop the account just added.
    private var adoptedGoogleEntries: [GoogleCalendarListEntry] = []
    private var adoptedAccounts: [CalendarAccount] = []
    /// Subscribed calendars as they were on disk at launch. Only the first
    /// paint reads them; the live list replaces them moments later.
    private var cachedSubscriptionCalendars: [StarlingsCalendar] = []
    /// The last subscribed events fetched, whatever period they were for. Kept
    /// so paging redraws them from memory instead of blanking the feed for a
    /// frame while the request runs.
    private var cachedSubscribedEvents: [StarlingsCalendarEvent] = []
    /// The disk cache is a launch head start, not a live store: read once.
    private var restoredFromDisk = false
    /// Subscribed feeds. The server holds the list and caches the feeds
    /// themselves, so there is nothing to cache again here.
    private(set) var subscriptions: [CalendarSubscription] = []
    /// A subscription-list failure must not masquerade as a successfully
    /// loaded empty shelf. The calendar can still render without the feed, but
    /// Settings needs to explain why the shared list is absent.
    private(set) var subscriptionError: String?
    /// Connected Google accounts. The owner's own is first and cannot be removed
    /// here — disconnecting Calendar in Settings is what does that.
    private(set) var googleAccounts: [CalendarAccount] = []
    private var calendarListFetchedAt: Date?
    /// Keyed by `StarlingsCalendar.visibilityKey`, not by `id` — see the note there.
    /// `UserDefaults` is a cache for the first paint and for being offline; the
    /// owner's copy on the server is what the phone and the Mac agree on.
    private var sourceSettings: CalendarSourceSettings
    private var loadedRemotePreferences = false
    private var hiddenLayers: Set<CalendarLayerKind>
    private(set) var includesLocalCalendars: Bool
    private var demotedEventKeys: Set<String>
    /// The last demotion write. Each write waits for the one before, so two
    /// quick changes reach the Worker in the order they were made.
    private var demotionWrite: Task<Void, Never>?
    /// The project or lead each event is about, by demotion key. Remote only:
    /// it is read with the other preferences on every refresh, and a device
    /// with no session has nothing to file under.
    private var eventSubjects: [String: CrmSubject] = [:]
    /// Owner-wide display policy for the shared Upcoming feed.
    private(set) var upcomingPreferences: UpcomingPreferencesWire = .defaults
    /// Subscribed feed ids explicitly kept out of the shared Upcoming feed.
    private(set) var upcomingExcludedSubscriptionIDs: Set<String> = []
    var writeCalendarID: String? {
        didSet {
            defaults.set(writeCalendarID, forKey: Self.writeDefaultsKey)
        }
    }

    init(backend: any CalendarBackend, defaults: UserDefaults = .standard) {
        self.backend = backend
        self.defaults = defaults
        sourceSettings = CalendarSourceSettings(
            hiddenKeys: CalendarSourcePreferences.hidden(defaults: defaults),
            disabledKeys: CalendarSourcePreferences.disabled(defaults: defaults)
        )
        hiddenLayers = CalendarLayerPreferences.hidden(defaults: defaults)
        includesLocalCalendars = CalendarSourcePreferences.includesLocalCalendars(defaults: defaults)
        demotedEventKeys = CalendarEventPreferences.demoted(defaults: defaults)
        writeCalendarID = defaults.string(forKey: Self.writeDefaultsKey)
    }

    var visibleEvents: [StarlingsCalendarEvent] {
        let hidden = hiddenCalendarIDs
        return events.filter { !hidden.contains($0.calendarID) }
    }

    /// Resolved once per read: events carry calendar ids, preferences carry
    /// visibility keys, and an account can be off without its calendars being
    /// listed one by one.
    private var hiddenCalendarIDs: Set<String> {
        Set(calendars.filter { isHidden($0) }.map(\.id))
    }

    /// Settings and the calendar window can have separate workspace instances
    /// on macOS. UserDefaults is the local hand-off between them; refresh the
    /// value before a read so a toggle in the other window is not overwritten
    /// by this instance's older in-memory copy.
    private func refreshLocalSourceSettings() {
        let stored = CalendarSourceSettings(
            hiddenKeys: CalendarSourcePreferences.hidden(defaults: defaults),
            disabledKeys: CalendarSourcePreferences.disabled(defaults: defaults)
        )
        let storedIncludesLocal = CalendarSourcePreferences.includesLocalCalendars(defaults: defaults)
        let storedDemoted = CalendarEventPreferences.demoted(defaults: defaults)
        guard stored != sourceSettings
                || storedIncludesLocal != includesLocalCalendars
                || storedDemoted != demotedEventKeys
        else { return }
        sourceSettings = stored
        includesLocalCalendars = storedIncludesLocal
        demotedEventKeys = storedDemoted
        googleMonths.removeAll()
        calendars = allCalendars.filter { isIncluded($0) }
    }

    private func isIncluded(_ calendar: StarlingsCalendar) -> Bool {
        !sourceSettings.isDisabled(calendar)
            && (calendar.source != .eventKit || includesLocalCalendars)
    }

    /// Calendars and accounts kept out of the app entirely. Read through on
    /// every ask rather than cached, because Settings writes to the same store
    /// and a stale copy here would be a list that disagrees with itself.
    var disabledKeys: Set<String> {
        sourceSettings.disabledKeys
    }

    func isDisabled(_ calendar: StarlingsCalendar) -> Bool {
        sourceSettings.isDisabled(calendar)
    }

    func isDisabled(calendarID: String) -> Bool {
        guard let calendar = allCalendars.first(where: { $0.id == calendarID }) else { return false }
        return isDisabled(calendar)
    }

    /// A whole account out of the app — the answer to a Mac that carries three
    /// accounts when only one of them is anybody's work.
    func isAccountDisabled(_ group: String) -> Bool {
        sourceSettings.isAccountDisabled(group, calendars: allCalendars)
    }

    func setDisabled(_ calendar: StarlingsCalendar, disabled: Bool) {
        sourceSettings.setDisabled(calendar, disabled: disabled, calendars: allCalendars)
        // Whichever way it went, the owner has now had their say about this
        // one, so it is no longer a calendar we could call new.
        CalendarSourcePreferences.markLocalKnown([calendar.visibilityKey], defaults: defaults)
        persistDisabledKeys(sourceSettings.disabledKeys)
    }

    func setAccountDisabled(_ group: String, disabled: Bool) {
        let members = allCalendars.filter { $0.groupTitle == group }
        sourceSettings.setAccountDisabled(group, disabled: disabled, calendars: allCalendars)
        CalendarSourcePreferences.markLocalKnown(Set(members.map(\.visibilityKey)), defaults: defaults)
        persistDisabledKeys(sourceSettings.disabledKeys)
    }

    private func persistDisabledKeys(_ keys: Set<String>) {
        CalendarSourcePreferences.setDisabled(keys, defaults: defaults)
        // Months were fetched for the old list, so a calendar coming back on
        // would otherwise show an empty week until the TTL ran out.
        googleMonths.removeAll()
        calendars = allCalendars.filter { isIncluded($0) }
        // Fire and forget, like the hidden keys: the local copy already answers
        // every read, and a failed sync is not worth an alert over a switch.
        Task { [backend] in
            guard (try? await backend.setDisabledCalendarKeys(keys.sorted())) != nil else { return }
            NotificationCenter.default.post(name: CalendarSourcePreferences.didChange, object: nil)
        }
    }

    /// One master decision before the per-calendar EventKit choices. It is
    /// owner-wide so Mac and iPhone do not disagree about whether local
    /// calendars belong in Meet, and starts false for records that predate it.
    func setIncludesLocalCalendars(_ included: Bool) {
        guard includesLocalCalendars != included else { return }
        includesLocalCalendars = included
        CalendarSourcePreferences.setIncludesLocalCalendars(included, defaults: defaults)
        calendars = allCalendars.filter { isIncluded($0) }
        Task { [backend] in _ = try? await backend.setIncludesLocalCalendars(included) }
    }

    func isDemoted(_ event: StarlingsCalendarEvent) -> Bool {
        event.isDemoted || demotedEventKeys.contains(event.demotionKey)
    }

    func setDemoted(_ event: StarlingsCalendarEvent, demoted: Bool) {
        if demoted {
            demotedEventKeys.insert(event.demotionKey)
        } else {
            demotedEventKeys.remove(event.demotionKey)
        }
        CalendarEventPreferences.setDemoted(demotedEventKeys, defaults: defaults)
        for index in events.indices where events[index].demotionKey == event.demotionKey {
            events[index].isDemoted = demoted
        }
        let keys = demotedEventKeys.sorted()
        let previous = demotionWrite
        demotionWrite = Task { [backend] in
            await previous?.value
            _ = try? await backend.setDemotedEventKeys(keys)
        }
    }

    /// The project or lead an event is about. Owner-wide like demotion, and
    /// keyed the same way, so the phone files a room started from this event
    /// under the same subject. Nil unfiles it.
    func setSubject(_ event: StarlingsCalendarEvent, _ subject: CrmSubject?) {
        if let subject {
            eventSubjects[event.demotionKey] = subject
        } else {
            eventSubjects.removeValue(forKey: event.demotionKey)
        }
        for index in events.indices where events[index].demotionKey == event.demotionKey {
            events[index].subject = subject
        }
        notifyChanged()
        let map = eventSubjects
        Task { [backend] in _ = try? await backend.setEventSubjects(map) }
    }

    /// Projects or leads to file an event under. Empty on any failure — the
    /// picker says "nothing found" rather than the inspector failing to open.
    /// Quick add's fallback: the grammar's draft stands unless the
    /// notes engine read the sentence. Nil on any failure.
    func quickAddFallback(_ sentence: String, now: String, defaultDurationMinutes: Int) async -> CalendarQuickAddDraft? {
        let request = CalendarQuickAddRequest(sentence: sentence, now: now, timeZone: TimeZone.current.identifier, defaultDurationMinutes: defaultDurationMinutes)
        guard let answer = try? await backend.quickAdd(request), answer.source == .model else { return nil }
        return answer.draft.draft
    }

    func searchSubjects(kind: MeetingCategoryKind.SubjectKind, query: String = "") async -> [CrmSubject] {
        (try? await backend.crmSubjects(kind: kind, query: query)) ?? []
    }

    /// A local calendar this app has not seen before starts switched off — see
    /// `CalendarSourcePreferences.adoptLocal`, which owns that rule.
    private func applyLocalDefaults(_ local: [StarlingsCalendar]) {
        // System availability is a deliberately selected read-only feed, not
        // a newly discovered personal calendar. Keep it out of the local
        // calendar seen-marker entirely, or it would make the first real local
        // calendar read look like a later incremental discovery.
        let fresh = CalendarSourcePreferences.adoptLocal(
            keys: Set(local.map(\.visibilityKey)),
            defaults: defaults
        )
        guard !fresh.isEmpty else { return }
        sourceSettings.disabledKeys.formUnion(fresh)
        persistDisabledKeys(sourceSettings.disabledKeys)
    }

    var visibleLayerItems: [CalendarLayerItem] {
        mirrorSplit.layers
    }

    /// Events on the owner's own calendars that stand in for a published
    /// event. The grids add the Events swatch to these.
    var publishedEventIDs: Set<String> {
        mirrorSplit.publishedEventIDs
    }

    private var mirrorSplit: CalendarLayerItem.MirrorSplit {
        CalendarLayerItem.splitMirrored(
            layerItems.filter { !hiddenLayers.contains($0.kind) },
            of: visibleEvents
        )
    }

    /// A pseudo calendar id the grids put beside an event's real calendars
    /// when the event stands in for a published event, so the block draws the
    /// Events swatch through the same colour path as a merged copy.
    static let publishedSwatchCalendarID = "layer:publicEvents"

    func isHidden(_ layer: CalendarLayerKind) -> Bool {
        hiddenLayers.contains(layer)
    }

    func setHidden(_ layer: CalendarLayerKind, hidden: Bool) {
        if hidden {
            hiddenLayers.insert(layer)
        } else {
            hiddenLayers.remove(layer)
        }
        CalendarLayerPreferences.setHidden(hiddenLayers, defaults: defaults)
    }

    func isHidden(_ calendarID: String) -> Bool {
        guard let calendar = calendars.first(where: { $0.id == calendarID }) else { return false }
        return isHidden(calendar)
    }

    func isHidden(_ calendar: StarlingsCalendar) -> Bool {
        sourceSettings.isHidden(calendar)
    }

    func setHidden(_ calendarID: String, hidden: Bool) {
        guard let calendar = calendars.first(where: { $0.id == calendarID }) else { return }
        sourceSettings.setHidden(calendar, hidden: hidden, calendars: calendars)
        persistHiddenKeys()
    }

    /// A whole account off in one move — the answer to the same Google account
    /// arriving twice, once over OAuth and once through macOS.
    func isAccountHidden(_ group: String) -> Bool {
        sourceSettings.isAccountHidden(group, calendars: calendars)
    }

    func setAccountHidden(_ group: String, hidden: Bool) {
        sourceSettings.setAccountHidden(group, hidden: hidden, calendars: calendars)
        persistHiddenKeys()
    }

    private func persistHiddenKeys() {
        let keys = sourceSettings.hiddenKeys
        CalendarSourcePreferences.setHidden(keys, defaults: defaults)
        // Fire and forget: the local copy already answers every read, and a
        // failed sync is not worth an alert over a checkbox.
        Task { [backend] in _ = try? await backend.setHiddenCalendarKeys(keys.sorted()) }
    }

    /// Adopt the owner's stored choices once per session. After that the device
    /// leads and every toggle is pushed, so a slow round trip cannot undo a
    /// checkbox the reader just clicked.
    private func adoptRemotePreferences() async {
        guard !loadedRemotePreferences else { return }
        guard let prefs = try? await backend.calendarPreferences() else { return }
        loadedRemotePreferences = true
        let remoteHidden = Set(prefs.hiddenCalendarKeys)
        if remoteHidden != sourceSettings.hiddenKeys {
            sourceSettings.hiddenKeys = remoteHidden
            CalendarSourcePreferences.setHidden(remoteHidden, defaults: defaults)
        }
        // Adopted before anything is discovered, so this session's own
        // auto-disabling of newly-appeared calendars lands on top of the
        // owner's list rather than under it.
        var remoteDisabled = Set(prefs.disabledCalendarKeys)
        let legacySubscriptionGroupKey = "account:\(StarlingsCalendar.subscriptionGroupTitle.lowercased())"
        if legacySubscriptionGroupKey != "account:subscribed",
           remoteDisabled.remove(legacySubscriptionGroupKey) != nil {
            remoteDisabled.insert("account:subscribed")
            let migratedKeys = remoteDisabled.sorted()
            Task { [backend, migratedKeys] in _ = try? await backend.setDisabledCalendarKeys(migratedKeys) }
        }
        if remoteDisabled != sourceSettings.disabledKeys {
            sourceSettings.disabledKeys = remoteDisabled
            CalendarSourcePreferences.setDisabled(remoteDisabled, defaults: defaults)
            googleMonths.removeAll()
        }
        let remoteDemoted = Set(prefs.demotedEventKeys)
        if remoteDemoted != demotedEventKeys {
            demotedEventKeys = remoteDemoted
            CalendarEventPreferences.setDemoted(remoteDemoted, defaults: defaults)
        }
        if prefs.eventSubjects != eventSubjects {
            eventSubjects = prefs.eventSubjects
        }
        if prefs.includesLocalCalendars != includesLocalCalendars {
            includesLocalCalendars = prefs.includesLocalCalendars
            CalendarSourcePreferences.setIncludesLocalCalendars(includesLocalCalendars, defaults: defaults)
        }
        upcomingPreferences = prefs.upcoming
        upcomingExcludedSubscriptionIDs = Set(prefs.upcomingExcludedSubscriptionIds)
    }

    /// Save the one Upcoming display policy used by Mac, iOS, and web.
    func setUpcomingPreferences(_ preferences: UpcomingPreferencesWire) async throws {
        upcomingPreferences = preferences
        notifyChanged()
        let saved = try await backend.setUpcomingPreferences(preferences)
        upcomingPreferences = saved.upcoming
        notifyChanged()
    }

    func setUpcomingExcludedSubscriptionIDs(_ ids: Set<String>) async throws {
        let saved = try await backend.setUpcomingExcludedSubscriptionIds(ids.sorted())
        upcomingExcludedSubscriptionIDs = Set(saved.upcomingExcludedSubscriptionIds)
        notifyChanged()
        NotificationCenter.default.post(name: CalendarSourcePreferences.upcomingDidChange, object: nil)
    }

    func refreshUpcomingSubscriptionSelection() async {
        guard let preferences = try? await backend.calendarPreferences() else { return }
        upcomingExcludedSubscriptionIDs = Set(preferences.upcomingExcludedSubscriptionIds)
        notifyChanged()
    }

    func color(for calendarID: String) -> StarlingsRGBColor {
        if calendarID == Self.publishedSwatchCalendarID { return CalendarLayerKind.publicEvents.color }
        return calendars.first(where: { $0.id == calendarID })?.displayColor ?? StarlingsRGBColor.fallback(at: 0)
    }

    func defaultWriteCalendar() -> StarlingsCalendar? {
        if let writeCalendarID, let match = calendars.first(where: { $0.id == writeCalendarID && Self.canBeWriteTarget($0) }) {
            return match
        }
        return calendars.first(where: Self.canBeWriteTarget)
    }

    /// Where a new event goes by default. Writable is not enough: the internal
    /// company calendar is editable on purpose, but it is shared context, and
    /// nobody means to put their dentist appointment on it. It stays a calendar
    /// you can write to when you say so — never the one that gets picked for
    /// you.
    static func canBeWriteTarget(_ calendar: StarlingsCalendar) -> Bool {
        calendar.isWritable && calendar.role != .globalInterest
    }

    /// A shared calendar can be selected explicitly when creating an event,
    /// but it is never a destination for moving an existing one.
    static func canBeMoveTarget(_ calendar: StarlingsCalendar) -> Bool {
        calendar.canBeMoveTarget
    }

    func moveTargets(for event: StarlingsCalendarEvent) -> [StarlingsCalendar] {
        guard event.canMoveBetweenCalendars else { return [] }
        return calendars.filter { $0.id != event.calendarID && Self.canBeMoveTarget($0) }
    }

    /// The Move to submenu on Mac and iPhone: the destinations and the event's
    /// own calendar, in calendar order, so the menu ticks where it is now.
    func moveMenuCalendars(for event: StarlingsCalendarEvent) -> [StarlingsCalendar] {
        let targets = Set(moveTargets(for: event).map(\.id))
        return calendars.filter { $0.id == event.calendarID || targets.contains($0.id) }
    }

    /// Read the period and publish it.
    ///
    /// Two things here matter as much as the result. The grid is painted before
    /// a single request goes out — from the months held on disk and from
    /// EventKit, which is local — so a cold launch shows the week it last knew
    /// instead of an empty one. And the requests go out in two waves rather than
    /// in a chain: nothing in the first needs another member's answer, and
    /// nothing in the second needs more than the first.
    func reload(range: DateInterval) async {
        lastError = nil
        lastErrorDetail = nil
        subscriptionError = nil
        requiresAuthentication = false
        refreshLocalSourceSettings()
        await restoreFromDisk()
        publishWhatIsAlreadyHeld(in: range)

        let sources = await discoverSources()
        if writeCalendarID == nil || !calendars.contains(where: { $0.id == writeCalendarID && Self.canBeWriteTarget($0) }) {
            writeCalendarID = calendars.first(where: Self.canBeWriteTarget)?.id
        }

        // Only the enabled ones are fetched. A calendar switched off in
        // Settings is not a row that gets filtered later — nothing asks for it.
        let googleCalendars = sources.google.filter { !isDisabled($0) }
        let localCalendars = sources.local.filter { !isDisabled($0) }
        let subscribedCalendars = sources.subscribed.filter { !isDisabled($0) }

        // Second wave: the events and the read-only layers. Each of these needs
        // the calendar list and nothing else, so they run together.
        async let googleEvents: Void = refreshGoogleMonths(
            Self.monthKeys(in: range),
            calendars: googleCalendars,
            force: false
        )
        async let subscribed = subscribedEvents(in: range, calendars: subscribedCalendars)
        async let layers = fetchedLayers(range: range)

        // EventKit is a local database, so it is read fresh every time; only the
        // Google round trip is worth caching.
        let localEvents = eventKit.events(from: range.start, to: range.end, calendars: localCalendars)
        _ = await googleEvents
        publishEvents(in: range, local: localEvents, subscribed: await subscribed)
        layerItems = await layers
        notifyChanged()
        persistToDisk()
    }

    /// Compose what is known right now into `events` and tell the view. Called
    /// more than once per `reload` by design.
    private func publishEvents(
        in range: DateInterval,
        local: [StarlingsCalendarEvent],
        subscribed: [StarlingsCalendarEvent]
    ) {
        events = (cachedGoogleEvents(in: range) + subscribed + local)
            .map { event in
                var event = event
                event.isDemoted = event.isDemoted || demotedEventKeys.contains(event.demotionKey)
                // The Worker files Google events; local ones are matched here,
                // against the same owner-wide map, by the same key.
                event.subject = event.subject ?? eventSubjects[event.demotionKey]
                return event
            }
            .sorted { $0.start < $1.start }
        notifyChanged()
    }

    /// The first frame: everything drawable without a request. Access is read
    /// and never asked for — a permission dialog has no business appearing
    /// before the calendar has drawn anything.
    private func publishWhatIsAlreadyHeld(in range: DateInterval) {
        // Nothing to add, and something to lose: an edit drops the month it
        // touched, so drawing from the cache here would blank the week that is
        // already on screen until the refetch lands.
        guard events.isEmpty || isCached(range) else { return }

        // A cold workspace has no calendar list yet. Seed one from disk, or the
        // restored events draw in the fallback colour and a hidden calendar
        // does not stay hidden — a worse flash than not painting at all.
        if calendars.isEmpty {
            var local: [StarlingsCalendar] = []
            if eventKit.adoptExistingAccess() == .granted {
                // Only calendars this app has already had its say about. One
                // that appeared since the last launch has not been through
                // `applyLocalDefaults` yet and may not belong on screen.
                let known = CalendarSourcePreferences.knownLocal(defaults: defaults)
                local = includesLocalCalendars
                    ? eventKit.calendars().filter { known.contains($0.visibilityKey) }
                    : []
            }
            allCalendars = cachedGoogleCalendars + cachedSubscriptionCalendars + local
            calendars = allCalendars.filter { isIncluded($0) }
        }
        let localCalendars = calendars.filter { $0.source == .eventKit && !isDisabled($0) }
        publishEvents(
            in: range,
            local: eventKit.events(from: range.start, to: range.end, calendars: localCalendars),
            subscribed: cachedSubscribedEvents.filter { $0.start < range.end && $0.end > range.start }
        )
    }

    private func notifyChanged() {
        onChange?()
    }

    /// Adopt the last launch's months and calendar list. Once per session: this
    /// is a head start, not a store, and everything in it is replaced by the
    /// requests that follow.
    private func restoreFromDisk() async {
        guard !restoredFromDisk else { return }
        restoredFromDisk = true
        guard let snapshot = await CalendarEventCache.load() else { return }
        if googleMonths.isEmpty { googleMonths = snapshot.months }
        // Optimistic, and corrected by `calendarStatus` in the same breath.
        // Without it the restored months are held back by a flag that is only
        // false because nothing has asked yet. A snapshot that says nothing
        // leaves the state unknown rather than asserting a disconnect.
        if snapshot.googleConnected { googleConnection = .connected }
        if cachedGoogleCalendars.isEmpty {
            cachedGoogleCalendars = snapshot.calendars.filter { $0.source == .google }
        }
        cachedSubscriptionCalendars = snapshot.calendars.filter { $0.source == .subscription }
    }

    private func persistToDisk() {
        CalendarEventCache.save(
            months: googleMonths,
            calendars: allCalendars,
            googleConnected: googleConnected
        )
    }

    /// Published events, Core's dated work, and Core's bookable hours.
    ///
    /// None can fail the calendar: the Worker already answers work items and
    /// availability with an empty list when Core is unreachable, and a
    /// published-events outage is not a reason to stop showing someone their
    /// week. So all are swallowed rather than reported — there is nothing the
    /// reader could do about any of them.
    private func fetchedLayers(range: DateInterval) async -> [CalendarLayerItem] {
        // Unrelated sources, so the published feed does not wait on Core and
        // Core's two answers do not wait on each other.
        async let published = publishedEventLayer(range: range)
        async let work = workItemLayer(range: range)
        async let open = availabilityLayer(range: range)
        let feed = await published
        let core = await work
        let hours = await open
        return (feed + core + hours).sorted { $0.start < $1.start }
    }

    private func publishedEventLayer(range: DateInterval) async -> [CalendarLayerItem] {
        guard !hiddenLayers.contains(.publicEvents) else { return [] }
        return await PublicEventsCalendar.load()
            .compactMap(CalendarLayerItem.init(publicEvent:))
            .filter { $0.start < range.end && $0.end > range.start }
    }

    /// One request covers both kinds; Core decides which is which. Gated on
    /// neither sign-in nor Google — work items need only an owner token, and a
    /// backend without one answers empty.
    private func workItemLayer(range: DateInterval) async -> [CalendarLayerItem] {
        guard !hiddenLayers.isSuperset(of: [.milestones, .tasks]) else { return [] }
        let fetched = (try? await backend.calendarWorkItems(
            from: range.start,
            to: range.end,
            includeDone: false
        )) ?? []
        return fetched.compactMap(CalendarLayerItem.init(workItem:))
    }

    /// Core's answer to "when could a guest book me", already unioned into
    /// blocks. Clipped to the range because Core rounds to whole days.
    private func availabilityLayer(range: DateInterval) async -> [CalendarLayerItem] {
        guard !hiddenLayers.contains(.availability) else { return [] }
        let fetched = (try? await backend.calendarAvailability(
            from: range.start,
            to: range.end
        )) ?? []
        return fetched
            .compactMap(CalendarLayerItem.init(availability:))
            .filter { $0.start < range.end && $0.end > range.start }
    }

    /// The source list alone: every calendar this device and this account can
    /// see, no events. Settings needs the list to offer the choice, and has no
    /// week on screen to fill.
    func refreshSources() async {
        subscriptionError = nil
        requiresAuthentication = false
        refreshLocalSourceSettings()
        _ = await discoverSources()
        notifyChanged()
    }

    /// The selection screen uses the same backend and wire contract as the Mac
    /// sidebar. Keeping these forwards here prevents an iOS-only API model from
    /// becoming a second source-selection implementation.
    func googleCalendarEntries() async throws -> [GoogleCalendarListEntry] {
        try await backend.listCalendars()
    }

    func setGoogleCalendarSelection(_ ids: [String]) async throws {
        guard !ids.isEmpty else {
            throw CalendarSettingsError.atLeastOneGoogleCalendar
        }
        _ = try await backend.setSelectedCalendarIds(ids)
        calendarListFetchedAt = nil
        cachedGoogleCalendars.removeAll()
        googleMonths.removeAll()
        NotificationCenter.default.post(name: CalendarSourcePreferences.didChange, object: nil)
    }

    /// Everything the app can see right now, filed by where it came from, with
    /// `allCalendars` and `calendars` left holding the full list and the
    /// enabled one.
    private func discoverSources() async -> (
        google: [StarlingsCalendar],
        subscribed: [StarlingsCalendar],
        local: [StarlingsCalendar]
    ) {
        // First wave. The owner's preferences, the Google calendar list, and the
        // subscribed feeds are three unrelated reads; running them one after
        // another was most of the wait before anything could be drawn.
        async let googleCalendars = refreshGoogleCalendars()
        async let subscribedCalendars = refreshSubscriptions()
        await adoptRemotePreferences()

        // Local, and the one call that may put a permission dialog on screen,
        // so it happens while the two requests above are still in flight.
        eventKitAccess = await eventKit.refreshAccess(requestIfNeeded: includesLocalCalendars)
        let discoveredLocal = eventKitAccess == .granted ? eventKit.calendars() : []
        let local = includesLocalCalendars ? discoveredLocal : []
        applyLocalDefaults(local)

        let google = await googleCalendars
        let subscribed = await subscribedCalendars
        allCalendars = google + subscribed + local
        calendars = allCalendars.filter { isIncluded($0) }
        return (google, subscribed, local)
    }

    /// Warm a period without publishing it — used to prefetch the weeks either
    /// side of the one on screen so paging does not wait on the network.
    func prefetch(range: DateInterval) async {
        await refreshGoogleMonths(
            Self.monthKeys(in: range),
            calendars: calendars,
            force: false,
            silent: true
        )
    }

    /// True when a period can be drawn immediately from what is already held.
    func isCached(_ range: DateInterval) -> Bool {
        guard googleConnected else { return true }
        return Self.monthKeys(in: range).allSatisfy { googleMonths[$0] != nil }
    }

    /// Every Google event held in the cache, for searching beyond one screen.
    var cachedEvents: [StarlingsCalendarEvent] {
        var byID: [String: StarlingsCalendarEvent] = [:]
        for month in googleMonths.values {
            for event in month.events { byID[event.id] = event }
        }
        return Array(byID.values)
    }

    /// The subscribed feeds, as calendars. A failure here is non-fatal to the
    /// week, but it is retained for Settings: an empty list must not look like
    /// the owner has no shared subscriptions when the request actually failed.
    private func refreshSubscriptions() async -> [StarlingsCalendar] {
        do {
            subscriptions = try await backend.calendarSubscriptions()
            subscriptionError = nil
        } catch {
            if error is CalendarAuthenticationRequiredError {
                requiresAuthentication = true
                subscriptionError = "Your Starlings sign-in expired. Sign in again."
            } else {
                subscriptionError = error.localizedDescription
            }
        }
        return subscriptions.enumerated().map { index, subscription in
            StarlingsCalendar(
                id: StarlingsCalendar.subscriptionID(subscription.id),
                source: .subscription,
                rawID: subscription.id,
                title: subscription.title,
                groupTitle: StarlingsCalendar.subscriptionGroupTitle,
                isWritable: false,
                color: StarlingsRGBColor.hex(subscription.color) ?? StarlingsRGBColor.fallback(at: index + 7)
            )
        }
    }

    private func subscribedEvents(
        in range: DateInterval,
        calendars: [StarlingsCalendar]
    ) async -> [StarlingsCalendarEvent] {
        guard !calendars.isEmpty else {
            cachedSubscribedEvents = []
            return []
        }
        let summaries = (try? await backend.subscriptionEvents(from: range.start, to: range.end)) ?? []
        let events = summaries.compactMap { Self.subscribedEvent(from: $0, calendars: calendars) }
        cachedSubscribedEvents = events
        return events
    }

    private static func subscribedEvent(
        from summary: SubscriptionEventSummary,
        calendars: [StarlingsCalendar]
    ) -> StarlingsCalendarEvent? {
        let calendarID = StarlingsCalendar.subscriptionID(summary.subscriptionID)
        guard calendars.contains(where: { $0.id == calendarID }) else { return nil }
        guard let start = CalendarDateParsing.parse(summary.start) else { return nil }
        let parsedEnd = CalendarDateParsing.parse(summary.end) ?? start.addingTimeInterval(3_600)
        return StarlingsCalendarEvent(
            id: summary.id,
            calendarID: calendarID,
            rawEventID: summary.id,
            title: summary.title,
            start: start,
            end: max(parsedEnd, start.addingTimeInterval(60)),
            isAllDay: summary.allDay,
            isWritable: false,
            isRecurring: summary.recurring,
            joinURL: summary.url.hasPrefix("http") ? summary.url : "",
            roomSlug: MeetingInvite.roomSlug(fromJoinURL: summary.url) ?? "",
            attendeeEmails: [],
            source: .subscription,
            notes: summary.description,
            location: summary.location,
            myResponse: nil
        )
    }

    /// Which sidebar headings name an extra Google account, and the account id
    /// behind each — the owner's own account is not among them, because removing
    /// it is disconnecting Calendar rather than dropping an extra address.
    var removableAccounts: [String: String] {
        var byGroup: [String: String] = [:]
        for account in googleAccounts where !account.primary {
            byGroup[account.email] = account.id
        }
        return byGroup
    }

    /// Extra accounts whose refresh token has died. Nothing of theirs can be
    /// listed, so Settings shows them by name with a way to reconnect or remove.
    var accountsNeedingReconnect: [CalendarAccount] {
        googleAccounts.filter { !$0.primary && !$0.connected }
    }

    /// The exchange just said Google is connected — take its word over the
    /// next status read, for as long as `CalendarSourcePreferences.googleConnectionGrace`.
    func noteGoogleConnected(_ status: CalendarConnectionStatus) {
        CalendarSourcePreferences.assertGoogleConnected(defaults: defaults, now: now())
        StarlingsCalendarSources.noteAdded()
        googleConnection = .connected
        if let email = status.email {
            let primary = CalendarAccount(id: CalendarAccount.primaryID, email: email, primary: true)
            adoptedAccounts.removeAll { $0.primary }
            adoptedAccounts.append(primary)
            googleAccounts = Self.merged(accounts: googleAccounts, with: [primary])
        }
        if let entries = status.calendars {
            adoptGoogleCalendars(entries)
        }
        // Whatever months were held were fetched for the old account set.
        googleMonths.removeAll()
        calendarListFetchedAt = nil
        notifyChanged()
    }

    /// An extra account was attached, or reattached. Same grace as above.
    func noteGoogleAccountAdded(_ account: CalendarAccount, calendars entries: [GoogleCalendarListEntry]?) {
        CalendarSourcePreferences.assertGoogleConnected(defaults: defaults, now: now())
        StarlingsCalendarSources.noteAdded()
        googleConnection = .connected
        adoptedAccounts.removeAll { $0.id == account.id }
        adoptedAccounts.append(account)
        googleAccounts = Self.merged(accounts: googleAccounts, with: [account])
        if let entries {
            adoptGoogleCalendars(entries)
        } else {
            // Two accounts name their groups by address; one said "Google".
            cachedGoogleCalendars = googleCalendars(from: cachedGoogleEntries)
            allCalendars = cachedGoogleCalendars + allCalendars.filter { $0.source != .google }
            calendars = allCalendars.filter { isIncluded($0) }
        }
        googleMonths.removeAll()
        calendarListFetchedAt = nil
        notifyChanged()
    }

    /// Calendar was disconnected in Settings: the grace is over and nothing
    /// Google should survive the next paint.
    func noteGoogleDisconnected() {
        CalendarSourcePreferences.clearGoogleConnectionAssertion(defaults: defaults)
        googleConnection = .disconnected
        googleAccounts = []
        adoptedAccounts = []
        adoptedGoogleEntries = []
        cachedGoogleEntries = []
        cachedGoogleCalendars = []
        googleMonths.removeAll()
        calendarListFetchedAt = nil
        allCalendars = allCalendars.filter { $0.source != .google }
        calendars = allCalendars.filter { isIncluded($0) }
        notifyChanged()
    }

    private func adoptGoogleCalendars(_ entries: [GoogleCalendarListEntry]) {
        adoptedGoogleEntries = Self.merged(entries: entries, with: adoptedGoogleEntries)
        cachedGoogleEntries = Self.merged(entries: entries, with: cachedGoogleEntries)
        // The disk snapshot has calendars but no entries; keep what it had that
        // this connect did not cover, in the colours it was drawn in.
        let fresh = googleCalendars(from: cachedGoogleEntries)
        let known = Set(fresh.map(\.id))
        cachedGoogleCalendars = fresh + cachedGoogleCalendars.filter { !known.contains($0.id) }
        allCalendars = cachedGoogleCalendars + allCalendars.filter { $0.source != .google }
        calendars = allCalendars.filter { isIncluded($0) }
    }

    /// `preferred` wins on a shared id; the rest of `others` follows.
    private static func merged(
        entries preferred: [GoogleCalendarListEntry],
        with others: [GoogleCalendarListEntry]
    ) -> [GoogleCalendarListEntry] {
        let known = Set(preferred.map(\.id))
        return preferred + others.filter { !known.contains($0.id) }
    }

    private static func merged(accounts listed: [CalendarAccount], with adopted: [CalendarAccount]) -> [CalendarAccount] {
        let known = Set(listed.map(\.id))
        let extra = adopted.filter { !known.contains($0.id) }
        // The owner's own account leads the list wherever it came from.
        return (listed + extra).sorted { $0.primary && !$1.primary }
    }

    /// The Google list as `StarlingsCalendar`s, grouped the way the sidebar reads
    /// them: with one account the heading is just "Google", which is what it
    /// has always said; with more, the address is the only thing that tells
    /// two "Primary" rows apart, so each account is named.
    private func googleCalendars(from entries: [GoogleCalendarListEntry]) -> [StarlingsCalendar] {
        let namesAccounts = googleAccounts.count > 1
        return entries.enumerated().map { index, entry in
            StarlingsCalendar(
                id: StarlingsCalendar.googleID(entry.id),
                source: .google,
                rawID: entry.id,
                title: entry.summary,
                groupTitle: namesAccounts && !entry.accountEmail.isEmpty ? entry.accountEmail : "Google",
                isWritable: entry.writable,
                color: StarlingsRGBColor.hex(entry.backgroundColor ?? "") ?? StarlingsRGBColor.fallback(at: index),
                accountEmail: entry.accountEmail.isEmpty ? nil : entry.accountEmail
            )
        }
    }

    func removeGoogleAccount(_ id: String) async throws {
        try await backend.removeCalendarAccount(id: id)
        googleAccounts.removeAll { $0.id == id }
        adoptedAccounts.removeAll { $0.id == id }
        adoptedGoogleEntries.removeAll { $0.accountID == id }
        cachedGoogleEntries.removeAll { $0.accountID == id }
        // The calendar list is per-account, so it cannot be trusted after one
        // goes away.
        calendarListFetchedAt = nil
        cachedGoogleCalendars = []
        googleMonths.removeAll()
    }

    /// Subscribe to a published feed. The address is checked by the server —
    /// it is the side that will be fetching it.
    func subscribe(to url: String, title: String? = nil) async throws -> CalendarSubscription {
        let subscription = try await backend.addCalendarSubscription(url: url, title: title)
        StarlingsCalendarSources.noteAdded()
        subscriptions.append(subscription)
        NotificationCenter.default.post(name: CalendarSourcePreferences.didChange, object: nil)
        return subscription
    }

    func unsubscribe(_ id: String) async throws {
        try await backend.removeCalendarSubscription(id: id)
        subscriptions.removeAll { $0.id == id }
        NotificationCenter.default.post(name: CalendarSourcePreferences.didChange, object: nil)
    }

    /// Nobody can write back to somebody else's published feed, so every write
    /// path answers the same way rather than each inventing its own wording.
    private static func readOnlySubscription() -> StarlingsError {
        StarlingsError(
            code: "calendar.subscription.readOnly",
            title: String(localized: "That calendar is read-only"),
            message: String(localized: "This calendar is subscribed. Copy the event to edit it."),
            severity: .notice
        )
    }

    private func refreshGoogleCalendars() async -> [StarlingsCalendar] {
        // A connect made moments ago outranks the status for a while — KV can
        // still be serving the miss it cached before the token was written.
        let asserted = CalendarSourcePreferences.googleConnectionRecentlyAsserted(defaults: defaults, now: now())
        do {
            // The same quiet retry as the events read: a wake reaches this call
            // first, and a network still coming back must not draw a banner.
            let status = try await withTransientRetry(silent: false) { try await backend.calendarStatus() }
            if status.connected || asserted {
                googleConnection = .connected
            } else {
                googleConnection = .disconnected
                cachedGoogleCalendars = []
                cachedGoogleEntries = []
                // Restored months can outlive a disconnect made elsewhere.
                // A failed request keeps them — being offline is not the same
                // as having no Google account — but this answer is definite.
                googleMonths.removeAll()
                return []
            }
            // The calendar list barely changes; re-reading it on every page turn
            // is a round trip for nothing. Except right after a connect, when
            // the list is what is waiting on KV — then every reload asks again.
            if !asserted,
               let fetchedAt = calendarListFetchedAt,
               now().timeIntervalSince(fetchedAt) < Self.calendarListTTL,
               !cachedGoogleCalendars.isEmpty {
                return cachedGoogleCalendars
            }
            async let entries = backend.listCalendars()
            async let accounts = backend.calendarAccounts()
            var listed = try await entries
            var fetchedAccounts = (try? await accounts) ?? []
            if asserted {
                // A stale listing must not drop what the connect handed back.
                listed = Self.merged(entries: listed, with: adoptedGoogleEntries)
                fetchedAccounts = Self.merged(accounts: fetchedAccounts, with: adoptedAccounts)
            }
            googleAccounts = fetchedAccounts
            cachedGoogleEntries = listed
            cachedGoogleCalendars = googleCalendars(from: listed)
            calendarListFetchedAt = now()
            return cachedGoogleCalendars
        } catch {
            // Deliberately not a disconnect. The comment above says it plainly
            // for the months, and it is just as true for the flag: a request
            // that failed proves nothing about whether an account is attached,
            // and downgrading here is what turned a dropped connection into
            // "Google Calendar isn't connected".
            if error is CalendarAuthenticationRequiredError {
                requiresAuthentication = true
                lastError = "Your Starlings sign-in expired. Sign in again."
                lastErrorDetail = Self.detail(of: error)
            } else if !asserted {
                // Used to be silent, which is how a calendar that failed to
                // list drew nothing and said nothing. Not during the grace: a
                // "not connected" there is KV catching up, not news.
                lastError = (error as? StarlingsError)?.message ?? error.localizedDescription
                lastErrorDetail = Self.detail(of: error)
            }
            return cachedGoogleCalendars
        }
    }

    /// Fetch only the months that are missing or past their TTL, as one request
    /// spanning them, then file the results per month.
    ///
    /// `silent` is for the speculative reads. A prefetch asks for months nobody
    /// is looking at yet, over a range wide enough to be the slowest request the
    /// calendar makes; when it fails, the period on screen is unaffected and
    /// saying so would report a problem the owner does not have.
    private func refreshGoogleMonths(
        _ keys: [String],
        calendars: [StarlingsCalendar],
        force: Bool,
        silent: Bool = false
    ) async {
        guard googleConnected else { return }
        let now = Date()
        let stale = keys.filter { key in
            guard let cached = googleMonths[key] else { return true }
            return force || now.timeIntervalSince(cached.fetchedAt) > Self.monthTTL
        }
        guard !stale.isEmpty else { return }
        let intervals = stale.compactMap { Self.monthInterval(forKey: $0) }
        guard let start = intervals.map(\.start).min(),
              let end = intervals.map(\.end).max()
        else { return }

        do {
            let summaries = try await withTransientRetry(silent: silent) {
                try await backend.calendarEvents(from: start, to: end)
            }
            let fetched = summaries.compactMap { Self.googleEvent(from: $0, calendars: calendars) }
            for key in stale {
                guard let interval = Self.monthInterval(forKey: key) else { continue }
                googleMonths[key] = CachedMonth(
                    // An event is filed under every month it touches, so a trip
                    // spanning a boundary shows up in both.
                    events: fetched.filter { $0.start < interval.end && $0.end > interval.start },
                    fetchedAt: now
                )
            }
        } catch {
            // Cancellation means the load was abandoned, not that it failed —
            // and a speculative prefetch has nothing to report either way. Both
            // leave the cached months, and the screen drawn from them, intact.
            if silent || error is CancellationError || Task.isCancelled { return }
            // `service.cancelled` is the transport's word for the same thing.
            switch CalendarRefreshFailure.classify(error) {
            case .cancelled:
                return
            case .signInExpired:
                // Meet's own session, not Google's: the same answer the
                // calendar list gives, rather than a refresh that "failed".
                requiresAuthentication = true
                lastError = "Your Starlings sign-in expired. Sign in again."
            case .googleExpired:
                lastError = "Google Calendar access expired. Reconnect it in Settings."
            case .transient, .other:
                // The cached months stay drawn; only the sentence changes.
                lastError = "Google events didn’t refresh"
            }
            lastErrorDetail = Self.detail(of: error)
        }
    }

    /// Runs `operation`, and when it fails in a way a second try can fix, tries
    /// again after each delay in `transientRetryDelays` before letting the
    /// failure out (`CalendarRefreshRetry`). A speculative read is not worth a
    /// wait.
    private func withTransientRetry<T>(
        silent: Bool,
        _ operation: () async throws -> T
    ) async throws -> T {
        let delays = silent ? [] : transientRetryDelays
        var attempt = 0
        while true {
            do {
                return try await operation()
            } catch {
                guard !Task.isCancelled,
                      let delay = CalendarRefreshRetry.delay(after: error, attempt: attempt, delays: delays)
                else { throw error }
                attempt += 1
                try await Task.sleep(for: delay)
            }
        }
    }

    /// What Copy adds to the sentence: a `StarlingsError`'s code and diagnostic,
    /// or the raw description of anything else.
    private static func detail(of error: Error) -> String {
        let cause = "cause: \(String(describing: CalendarRefreshFailure.classify(error)))"
        let text: String
        if let failure = error as? CalendarServiceFailure, !failure.calendarDiagnostic.isEmpty {
            text = failure.calendarDiagnostic
        } else {
            text = String(describing: error)
        }
        // One line per shown banner, so the next occurrence is diagnosable
        // from Console without the person having to copy anything. Class, code,
        // status and request id only: no calendar, event or address.
        Logger(subsystem: ContractConstants.nativeAppBundleID, category: "CalendarRefresh")
            .error("calendar read failed: \(cause, privacy: .public) \(text, privacy: .public)")
        return "\(text) · \(cause)"
    }

    private func cachedGoogleEvents(in range: DateInterval) -> [StarlingsCalendarEvent] {
        var byID: [String: StarlingsCalendarEvent] = [:]
        for key in Self.monthKeys(in: range) {
            for event in googleMonths[key]?.events ?? [] where
                event.start < range.end && event.end > range.start {
                byID[event.id] = event
            }
        }
        return Array(byID.values)
    }

    /// Force the months an edit could have changed to refetch on the next
    /// read.
    ///
    /// This marks them stale rather than deleting them outright: the refetch
    /// that follows almost always lands, but when it doesn't (a transient
    /// network hiccup racing the edit itself), the old events stay on screen
    /// per `refreshGoogleMonths`'s contract instead of leaving a hole nothing
    /// short of relaunch would refill — nothing else retries on its own.
    private func invalidateGoogleCache(from start: Date, to end: Date) {
        let range = DateInterval(start: min(start, end), end: max(start, end))
        for key in Self.monthKeys(in: range) {
            googleMonths[key]?.fetchedAt = .distantPast
        }
    }

    private static func monthKey(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month], from: date)
        return String(format: "%04d-%02d", parts.year ?? 0, parts.month ?? 0)
    }

    private static func monthKeys(in range: DateInterval, calendar: Calendar = .current) -> [String] {
        var keys: [String] = []
        var cursor = CalendarWeekMath.startOfMonth(containing: range.start, calendar: calendar)
        while cursor < range.end {
            keys.append(monthKey(cursor, calendar: calendar))
            guard let next = calendar.date(byAdding: .month, value: 1, to: cursor) else { break }
            cursor = next
        }
        return keys.isEmpty ? [monthKey(range.start, calendar: calendar)] : keys
    }

    private static func monthInterval(forKey key: String, calendar: Calendar = .current) -> DateInterval? {
        let parts = key.split(separator: "-")
        guard parts.count == 2, let year = Int(parts[0]), let month = Int(parts[1]) else { return nil }
        var components = DateComponents()
        components.year = year
        components.month = month
        guard let start = calendar.date(from: components),
              let end = calendar.date(byAdding: .month, value: 1, to: start)
        else { return nil }
        return DateInterval(start: start, end: end)
    }

    func create(
        title: String,
        start: Date,
        end: Date,
        calendarID: String,
        joinURL: String?,
        roomSlug: String?,
        attendees: [String],
        notes: String? = nil,
        location: String? = nil,
        /// Minutes to get there; Google only, nil sends nothing.
        travelTimeMinutes: Int? = nil
    ) async throws {
        guard let calendar = calendars.first(where: { $0.id == calendarID }) else {
            throw StarlingsError(code: "calendar.missing", title: String(localized: "Pick a calendar"), message: String(localized: "Choose a calendar for this event."), severity: .notice)
        }
        // Creating in Internal is explicit and valid, but must not turn the
        // shared calendar into the default for the next personal event.
        if Self.canBeWriteTarget(calendar) {
            writeCalendarID = calendarID
        }
        let meetLink = try await mintedMeetLink(title: title, start: start, end: end, joinURL: joinURL, roomSlug: roomSlug)
        invalidateGoogleCache(from: start, to: end)
        switch calendar.source {
        case .google:
            _ = try await backend.createCalendarEvent(
                title: title,
                start: start,
                end: end,
                joinURL: meetLink ?? joinURL,
                roomSlug: roomSlug,
                attendees: attendees,
                description: notes,
                location: location,
                timeZone: StarlingsScheduleTimeZone.loadPreferred().identifier,
                calendarId: calendar.rawID,
                travelTimeMinutes: travelTimeMinutes
            )
        case .eventKit:
            _ = try eventKit.create(
                title: title,
                start: start,
                end: end,
                calendarRawID: calendar.rawID,
                location: Self.storedLocation(location ?? "", link: meetLink ?? joinURL),
                url: (meetLink ?? joinURL).flatMap(URL.init(string:)),
                notes: notes
            )
        case .subscription:
            throw Self.readOnlySubscription()
        }
    }

    func update(
        _ event: StarlingsCalendarEvent,
        title: String,
        start: Date,
        end: Date,
        joinURL: String?,
        roomSlug: String?,
        /// `nil` leaves the stored guest list untouched. A reschedule must pass
        /// `nil`, not an echo of the current attendees.
        attendees: [String]?,
        notes: String? = nil,
        location: String? = nil,
        /// nil leaves it alone, 0 clears it. Google only.
        travelTimeMinutes: Int? = nil,
        span: CalendarEditSpan = .thisEvent
    ) async throws {
        let meetLink = try await mintedMeetLink(title: title, start: start, end: end, joinURL: joinURL, roomSlug: roomSlug)
        // Both the slot it left and the one it lands in are now wrong.
        invalidateGoogleCache(from: min(start, event.start), to: max(end, event.end))
        switch event.source {
        case .google:
            _ = try await backend.patchCalendarEvent(
                calendarId: String(event.calendarID.dropFirst(2)),
                eventId: Self.googleTarget(event, span: span),
                title: title,
                start: start,
                end: end,
                attendees: attendees,
                timeZone: StarlingsScheduleTimeZone.loadPreferred().identifier,
                joinURL: meetLink ?? joinURL,
                roomSlug: roomSlug,
                notes: notes,
                location: location,
                travelTimeMinutes: travelTimeMinutes
            )
        case .eventKit:
            try eventKit.update(
                eventIdentifier: event.rawEventID,
                occurrenceStart: event.start,
                title: title,
                start: start,
                end: end,
                location: Self.storedLocation(location, link: meetLink ?? joinURL),
                url: (meetLink ?? joinURL).flatMap(URL.init(string:)),
                notes: notes,
                span: span
            )
        case .subscription:
            throw Self.readOnlySubscription()
        }
    }

    /// What EventKit stores as the location, the same rule the Worker applies
    /// to Google: a typed place wins; with none, the link takes the slot so
    /// Calendar.app shows Join. `nil` stays `nil` — the caller left it alone,
    /// and a reschedule must not put the link over an address.
    static func storedLocation(_ location: String?, link: String?) -> String? {
        guard let location else { return nil }
        if !location.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return location }
        return link ?? location
    }

    func delete(_ event: StarlingsCalendarEvent, span: CalendarEditSpan = .thisEvent) async throws {
        invalidateGoogleCache(from: event.start, to: event.end)
        switch event.source {
        case .google:
            try await backend.deleteCalendarEvent(
                calendarId: String(event.calendarID.dropFirst(2)),
                eventId: Self.googleTarget(event, span: span)
            )
        case .eventKit:
            try eventKit.delete(eventIdentifier: event.rawEventID, occurrenceStart: event.start, span: span)
        case .subscription:
            throw Self.readOnlySubscription()
        }
    }

    /// Which Google id an edit should address. Instances are listed expanded
    /// (`singleEvents=true`), so the instance id edits just this occurrence and
    /// the series id edits the whole series. Google has no cheap
    /// "this and following", which is why the Google UI offers "All events".
    private static func googleTarget(_ event: StarlingsCalendarEvent, span: CalendarEditSpan) -> String {
        guard span == .futureEvents, !event.recurringEventID.isEmpty else { return event.rawEventID }
        return event.recurringEventID
    }

    /// Re-file an event on another calendar.
    ///
    /// Within one source this keeps the event's identity, so guests keep their
    /// copies and their replies. Across sources there is nothing to preserve —
    /// Google and EventKit share no id space — so it copies and deletes, and
    /// says as much rather than pretending it was a move.
    func move(_ event: StarlingsCalendarEvent, to calendarID: String) async throws {
        guard let target = calendars.first(where: { $0.id == calendarID }) else {
            throw StarlingsError(
                code: "calendar.missing",
                title: String(localized: "Pick a calendar"),
                message: String(localized: "Choose a calendar to move this event to."),
                severity: .notice
            )
        }
        guard target.isWritable else {
            throw StarlingsError(
                code: "calendar.readOnly",
                title: String(localized: "That calendar is read-only"),
                message: String(localized: "Pick a calendar you can add events to."),
                severity: .notice
            )
        }
        // Caught here rather than in the copy-and-delete below: that path would
        // make the copy, fail to remove the original, and leave the event twice.
        guard event.source != .subscription else { throw Self.readOnlySubscription() }
        guard event.calendarRole.canMoveEventsOut else {
            throw StarlingsError(
                code: "calendar.shared.moveUnsupported",
                title: String(localized: "Keep shared events in Internal"),
                message: String(localized: "Internal is shared. Duplicate this event for a personal copy."),
                severity: .notice
            )
        }
        guard target.canBeMoveTarget else {
            throw StarlingsError(
                code: "calendar.shared.moveTargetUnsupported",
                title: String(localized: "Internal is a shared calendar"),
                message: String(localized: "Create or duplicate an event there instead of moving an existing event into Internal."),
                severity: .notice
            )
        }
        invalidateGoogleCache(from: event.start, to: event.end)

        // Google moves an event only within one account. Across accounts —
        // and across sources — the move is what Fantastical does: create the
        // copy on the target, then delete the original. The guests come
        // along: a move keeps the meeting, unlike Duplicate.
        let sourceCalendar = calendars.first { $0.id == event.calendarID }
        let sameGoogleAccount = sourceCalendar?.groupTitle == target.groupTitle
        switch (event.source, target.source) {
        case (.google, .google) where sameGoogleAccount:
            _ = try await backend.moveCalendarEvent(
                calendarId: String(event.calendarID.dropFirst(2)),
                eventId: event.rawEventID,
                // Additional Google accounts use an acct: prefix in the
                // transport id; rawID alone is ambiguous across accounts.
                destinationId: String(target.id.dropFirst(2))
            )
        case (.eventKit, .eventKit):
            try eventKit.move(
                eventIdentifier: event.rawEventID,
                occurrenceStart: event.start,
                toCalendarRawID: target.rawID
            )
        default:
            try await copy(event, to: target, carryingAttendees: true)
            try await delete(event)
        }
    }

    /// Leave the original alone and put a second copy on another calendar.
    /// A copy on the same calendar at another time — the ⌘-drag. Nothing
    /// invalidates the source's slot: the original did not move.
    func duplicate(_ event: StarlingsCalendarEvent, start: Date, end: Date) async throws {
        guard let target = calendars.first(where: { $0.id == event.calendarID }), target.isWritable else {
            throw StarlingsError(
                code: "calendar.readOnly",
                title: String(localized: "This calendar is read-only"),
                message: String(localized: "Duplicate onto a calendar you can add events to."),
                severity: .notice
            )
        }
        invalidateGoogleCache(from: start, to: end)
        try await copy(event.withSchedule(start: start, end: end), to: target)
    }

    func duplicate(_ event: StarlingsCalendarEvent, to calendarID: String) async throws {
        guard let target = calendars.first(where: { $0.id == calendarID }), target.isWritable else {
            throw StarlingsError(
                code: "calendar.readOnly",
                title: String(localized: "Pick a writable calendar"),
                message: String(localized: "Choose a calendar you can add events to."),
                severity: .notice
            )
        }
        invalidateGoogleCache(from: event.start, to: event.end)
        try await copy(event, to: target)
    }

    private func copy(_ event: StarlingsCalendarEvent, to target: StarlingsCalendar, carryingAttendees: Bool = false) async throws {
        switch target.source {
        case .google:
            _ = try await backend.createCalendarEvent(
                title: event.displayTitle,
                start: event.start,
                end: event.end,
                joinURL: event.joinURL.isEmpty ? nil : event.joinURL,
                roomSlug: event.roomSlug.isEmpty ? nil : event.roomSlug,
                // A duplicate is a structural copy, not a re-invite: carrying
                // the attendee list over would email everyone on the original
                // a second, spurious invite for a meeting they don't need. A
                // move is the meeting itself changing address, so it carries them.
                attendees: carryingAttendees ? event.attendeeEmails : [],
                description: event.notes.isEmpty ? nil : event.notes,
                location: event.location.isEmpty ? nil : event.location,
                timeZone: StarlingsScheduleTimeZone.loadPreferred().identifier,
                calendarId: target.rawID,
                // A copy keeps the way there.
                travelTimeMinutes: event.travelTimeMinutes
            )
        case .eventKit:
            _ = try eventKit.create(
                title: event.displayTitle,
                start: event.start,
                end: event.end,
                calendarRawID: target.rawID,
                location: event.location.isEmpty ? event.joinURL : event.location,
                notes: event.notes.isEmpty ? nil : event.notes
            )
        case .subscription:
            throw Self.readOnlySubscription()
        }
    }

    /// When the given people are busy, over a range.
    ///
    /// Deliberately not cached with the month store: availability changes under
    /// you while you are choosing a time, and a stale "free" is the one answer
    /// this must never give.
    func freeBusy(for emails: [String], range: DateInterval) async -> [CalendarFreeBusyPerson] {
        guard googleConnected, !emails.isEmpty else { return [] }
        do {
            return try await backend.calendarFreeBusy(
                from: range.start,
                to: range.end,
                emails: emails
            )
        } catch {
            return []
        }
    }

    /// Reply to an invitation. Google only — EventKit can read participant
    /// status but offers no public API to change it.
    func respond(to event: StarlingsCalendarEvent, as response: CalendarRSVP) async throws {
        guard event.source == .google else {
            throw StarlingsError(
                code: "calendar.rsvp.unsupported",
                title: String(localized: "Reply in Calendar"),
                message: String(localized: "Reply in Calendar for iCloud or On My Mac invitations."),
                severity: .notice
            )
        }
        invalidateGoogleCache(from: event.start, to: event.end)
        _ = try await backend.respondToCalendarEvent(
            calendarId: String(event.calendarID.dropFirst(2)),
            eventId: event.rawEventID,
            response: response
        )
    }

    /// Move an event in the in-memory week so a drag lands instantly. The
    /// server write follows; `revert` puts it back when that write fails.
    @discardableResult
    func applyLocalSchedule(eventID: String, start: Date, end: Date) -> StarlingsCalendarEvent? {
        guard let index = events.firstIndex(where: { $0.id == eventID }) else { return nil }
        let previous = events[index]
        events[index] = previous.withSchedule(start: start, end: end)
        events.sort { $0.start < $1.start }
        return previous
    }

    func revertLocalSchedule(to event: StarlingsCalendarEvent) {
        guard let index = events.firstIndex(where: { $0.id == event.id }) else { return }
        events[index] = event
        events.sort { $0.start < $1.start }
    }

    private func mintedMeetLink(
        title: String,
        start: Date,
        end: Date,
        joinURL: String?,
        roomSlug: String?
    ) async throws -> String? {
        guard let roomSlug = roomSlug ?? MeetingInvite.roomSlug(fromJoinURL: joinURL ?? ""),
              !roomSlug.isEmpty
        else { return joinURL }
        return try await backend.mintCalendarBooking(
            title: title,
            start: start,
            end: end,
            roomSlug: roomSlug,
            joinURL: joinURL
        ).joinURL
    }

    private static func googleEvent(from summary: CalendarEventSummary, calendars: [StarlingsCalendar]) -> StarlingsCalendarEvent? {
        let calendarID = StarlingsCalendar.googleID(summary.calendarId)
        guard let calendar = calendars.first(where: { $0.id == calendarID }) else { return nil }
        guard let start = CalendarDateParsing.parse(summary.start) else { return nil }
        let parsedEnd = CalendarDateParsing.parse(summary.end) ?? start.addingTimeInterval(3_600)
        let allDay = CalendarDateParsing.isAllDay(summary.start, flagged: summary.isAllDay)
        let rawEventID: String = {
            let prefix = "\(summary.calendarId):"
            if summary.id.hasPrefix(prefix) { return String(summary.id.dropFirst(prefix.count)) }
            return summary.id
        }()
        return StarlingsCalendarEvent(
            id: "g:\(summary.calendarId):\(rawEventID)",
            calendarID: calendar.id,
            rawEventID: rawEventID,
            title: summary.title,
            start: start,
            end: max(parsedEnd, start.addingTimeInterval(60)),
            isAllDay: allDay,
            isWritable: calendar.isWritable,
            isRecurring: summary.isRecurring,
            // `joinUrl` is Meet's own room field; external providers live in
            // `conferenceUrl`. The native calendar still needs the best
            // destination in `joinURL` so its provider mark and open action
            // agree with the web/iOS feed.
            joinURL: summary.launchURL,
            roomSlug: summary.roomSlug,
            attendeeEmails: summary.attendees.compactMap { attendee in
                let email = attendee.email.trimmingCharacters(in: .whitespacesAndNewlines)
                return email.isEmpty ? nil : email
            },
            attendees: summary.attendees,
            source: .google,
            recurringEventID: summary.recurringEventId,
            notes: summary.notes,
            location: summary.location,
            startTimeZone: summary.startTimeZone,
            travelTimeMinutes: summary.travelTimeMinutes,
            myResponse: summary.myResponse,
            isDemoted: summary.demoted,
            calendarRole: summary.calendarRole == .ordinary ? calendar.role : summary.calendarRole,
            subject: summary.subject
        )
    }
}
