import Combine
import Foundation
import UIKit
import WidgetKit

/// The single source of truth for the agenda and the next meeting.
///
/// Home and Calendar each used to fetch and filter the feed themselves, once per
/// sign-in, with no reason to ever look again — so the app showed a meeting that
/// ended an hour ago, went blank every evening, and never noticed one scheduled
/// from the Mac. This store owns the fetch, keeps a last-good copy on disk, and
/// re-derives on a timer armed for the exact instant the answer changes.
@MainActor
final class UpcomingMeetingsStore: ObservableObject {
    /// The whole answer, so a view never has to combine two of these itself:
    /// the agenda, where each row sits in the day, and the hero.
    @Published private(set) var plan: UpcomingPlan<MobileCalendarEvent> = .empty
    /// The owner-wide display policy used by Home and Calendar on every surface.
    @Published private(set) var preferences: UpcomingPreferencesWire = .defaults
    /// Everything still ahead, soonest first — the Calendar tab's list.
    @Published private(set) var agenda: [MobileCalendarEvent] = []
    /// Joinable meetings only, soonest first.
    @Published private(set) var meetings: [MobileCalendarEvent] = []
    /// The one being counted down to: in progress if one is, else the soonest
    /// still to come *today*. `nil` is a closed day, and Home says so rather
    /// than promoting tomorrow's first meeting into the countdown.
    @Published private(set) var focus: MobileCalendarEvent?
    /// Today's meetings about a subject — Work's Overview TODAY block.
    @Published private(set) var todayMeetings: [WorkTodayMeetings.Row] = []
    @Published private(set) var isRefreshing = false
    @Published private(set) var lastRefreshed: Date?
    /// Set only when the network failed *and* there was nothing cached, so the
    /// UI can tell "nothing scheduled" apart from "couldn't look".
    @Published private(set) var isUnavailable = false
    /// The Worker answered `calendar_not_connected`: a settled state with a
    /// next step, so Home offers Connect Google Calendar, as on the Mac and web.
    @Published private(set) var isCalendarNotConnected = false
    /// Home waits for the cached or live agenda answer before replacing its
    /// fixed-height AGENDA loading card.
    @Published private(set) var homeReady = false

    /// Refresh cadence while the app is on screen. The feed is small and the
    /// Worker caches Google's response, so this is cheap insurance against a
    /// meeting moved from another device.
    private let foregroundRefreshInterval: TimeInterval = 300
    /// Re-fetch on becoming active only if the data has gone cold; returning
    /// from a two-second app switch should not hit the network.
    private let staleAfter: TimeInterval = 60
    private weak var app: StarlingsAppModel?
    private var attached = false
    private var inFlight: Task<Void, Never>?
    private var boundaryTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var cancellables: Set<AnyCancellable> = []
    private var raw: [MobileCalendarEvent] = []
    private let cache = MeetingFeedCache()
    /// Whose agenda is drawn; set by `paintSnapshot`, which `StarlingsAppModel`
    /// calls at init, before the first frame.
    private var paintedOwner: String?
    private var hasPainted = false

    /// Called once from the root scene. Installs every trigger that can change
    /// the answer, then shows the cached agenda before the network replies.
    func attach(to app: StarlingsAppModel) {
        guard !attached else { return }
        attached = true
        self.app = app
        // Disk first, synchronously: the saved agenda and the policy it was
        // drawn under, before the sink below hops and the feed is asked
        // (docs/CACHING.md).
        let owner = app.ownerCredentials?.owner.email
        if !hasPainted || paintedOwner != owner { paintSnapshot(owner: owner) }

        // Every closure below is `@Sendable` on purpose. Closures written
        // inside a @MainActor method inherit that isolation, and a notification
        // posted from a background thread — `UserDefaults` does exactly that —
        // then trips the isolation assertion and traps. `@Sendable` opts them
        // out, and each one hops to the main actor itself.
        app.$ownerCredentials
            .map { @Sendable in $0?.owner.email }
            .removeDuplicates()
            .sink { @Sendable email in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    // A different owner than the one painted at attach (a
                    // sign-in, a sign-out): theirs, from disk, first.
                    if email != self.paintedOwner {
                        self.paintSnapshot(owner: email)
                    }
                    await self.refresh(force: true)
                }
            }
            .store(in: &cancellables)

        // Everything that can move "now" out from under an already-derived
        // answer: coming back on screen, a day rolling over, landing in a new
        // time zone, the user changing the clock.
        for name: Notification.Name in [
            UIApplication.didBecomeActiveNotification,
            UIApplication.significantTimeChangeNotification,
            .NSSystemTimeZoneDidChange,
            .NSCalendarDayChanged,
        ] {
            NotificationCenter.default.publisher(for: name)
                .map { @Sendable _ in () }
                .sink { @Sendable in Task { @MainActor [weak self] in self?.wake() } }
                .store(in: &cancellables)
        }

        // Last moment the app is sure to run: stop polling, and give the
        // system the dismissal of an in-progress countdown so it does not sit
        // at 0:00 after the meeting while Meet is suspended.
        NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)
            .map { @Sendable _ in () }
            .sink { @Sendable in
                Task { @MainActor [weak self] in self?.pollTask?.cancel() }
                Task { await MeetingLiveActivity.handOffForSuspension() }
            }
            .store(in: &cancellables)

        // The alert settings drive both the notifications and the activity.
        NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification)
            .map { @Sendable _ in () }
            .debounce(for: .milliseconds(250), scheduler: RunLoop.main)
            .sink { @Sendable in Task { @MainActor [weak self] in self?.applyAlerts() } }
            .store(in: &cancellables)

        for name in [CalendarSourcePreferences.didChange, CalendarSourcePreferences.upcomingDidChange] {
            NotificationCenter.default.publisher(for: name)
                .map { @Sendable _ in () }
                .sink { @Sendable in Task { @MainActor [weak self] in await self?.refresh(force: true) } }
                .store(in: &cancellables)
        }

        startPolling()
    }

    /// Last known first: the saved agenda and the policy it was drawn under
    /// paint before the network answers. A saved empty day is an answer too.
    /// No request.
    func paintSnapshot(owner: String?) {
        hasPainted = true
        paintedOwner = owner
        let saved = owner.flatMap { cache.load(owner: $0) }
        raw = saved?.events ?? []
        if let preferences = saved?.preferences { self.preferences = preferences }
        // The answer only: the widget file, alerts and the boundary timer are
        // re-armed by the refresh that follows, which derives in full.
        derive(publishing: false)
        homeReady = saved != nil
    }

    /// Pull-to-refresh, post-create, and the periodic loop. `force` skips the
    /// staleness check.
    func refresh(force: Bool = false) async {
        guard let app, let credentials = app.ownerCredentials else {
            raw = []
            preferences = .defaults
            lastRefreshed = nil
            cache.clear()
            derive()
            homeReady = false
            await MeetingNotices.cancelAll()
            await MeetingLiveActivity.endAll()
            return
        }
        if !force, let lastRefreshed, Date().timeIntervalSince(lastRefreshed) < staleAfter { return }
        // Four triggers can fire at once on a cold foreground. Let them share
        // one refresh instead of stacking four. The guard covers the whole
        // refresh, preferences included: it used to be set after the
        // preferences read, so every trigger passed it and each sent both
        // requests.
        if let inFlight {
            await inFlight.value
            return
        }
        let task = Task { await self.load(credentials: credentials, api: app.api) }
        inFlight = task
        isRefreshing = true
        await task.value
        isRefreshing = false
        inFlight = nil
    }

    /// The display policy and the feed, read side by side. The feed asks for
    /// the horizon of the policy already in hand; the rare answer that widens
    /// it reads the feed once more, so the common case costs one round trip,
    /// not two in a row.
    private func load(credentials: MobileOwnerCredentials, api: StarlingsAPI) async {
        let backend = MobileCalendarBackend(environment: .configured(), credentials: credentials)
        let requestedHours = preferences.requestHours
        async let remotePreferences = try? backend.calendarPreferences()
        async let feed = Self.upcoming(api: api, credentials: credentials, hours: requestedHours)
        if let remote = await remotePreferences {
            preferences = remote.upcoming
        }
        var outcome = await feed
        if case .success = outcome, preferences.requestHours > requestedHours {
            outcome = await Self.upcoming(api: api, credentials: credentials, hours: preferences.requestHours)
        }

        if case .success(let answer) = outcome {
            raw = answer
            lastRefreshed = Date()
            isUnavailable = false
            isCalendarNotConnected = false
            // An answer means Google or a subscription is there.
            StarlingsCalendarSources.record(server: true)
            cache.save(raw, preferences: preferences, owner: credentials.owner.email)
        } else if case .failure(let error) = outcome,
                  (error as? StarlingsError)?.serverCode == "calendar_not_connected" {
            raw = []
            isUnavailable = false
            isCalendarNotConnected = true
            StarlingsCalendarSources.record(server: false)
            cache.save(raw, preferences: preferences, owner: credentials.owner.email)
        } else {
            // Keep the last good agenda on screen. A flaky network must not
            // look identical to an empty calendar.
            isUnavailable = raw.isEmpty
        }
        derive()
        homeReady = true
    }

    private static func upcoming(
        api: StarlingsAPI,
        credentials: MobileOwnerCredentials,
        hours: Int
    ) async -> Result<[MobileCalendarEvent], any Error> {
        do {
            return .success(try await api.upcoming(credentials: credentials, hours: hours))
        } catch {
            return .failure(error)
        }
    }

    /// The nuisance action lives beside the nuisance: Home can demote a row
    /// without making the owner hunt for it again in Calendar. The same
    /// owner-wide preference is consumed by the full calendar workspace.
    func setDemoted(_ event: MobileCalendarEvent, demoted: Bool) async {
        guard let app, let credentials = app.ownerCredentials else { return }
        let previous = raw.first(where: { $0.demotionKey == event.demotionKey })?.demoted ?? event.demoted
        for index in raw.indices where raw[index].demotionKey == event.demotionKey {
            raw[index] = raw[index].withDemoted(demoted)
        }
        // Re-derive before touching the network: hiding the current focus must
        // immediately promote the next answer on the screen.
        derive()
        let backend = MobileCalendarBackend(environment: .configured(), credentials: credentials)
        do {
            let preferences = try await backend.calendarPreferences()
            var keys = Set(preferences.demotedEventKeys)
            if demoted {
                keys.insert(event.demotionKey)
            } else {
                keys.remove(event.demotionKey)
            }
            _ = try await backend.setDemotedEventKeys(keys.sorted())
            cache.save(raw, preferences: self.preferences, owner: credentials.owner.email)
        } catch {
            // Do not leave an optimistic Home card visible after the write was
            // rejected. Only roll back rows that still carry this action; a
            // concurrent refresh may already have supplied newer server state.
            for index in raw.indices where raw[index].demotionKey == event.demotionKey && raw[index].demoted == demoted {
                raw[index] = raw[index].withDemoted(previous)
            }
            derive()
            app.alertMessage = "Couldn’t change this meeting’s Next status."
        }
    }

    /// The Upcoming editor writes the same owner preference as Mac and web.
    func setUpcomingPreferences(_ value: UpcomingPreferencesWire) async {
        guard let app, let credentials = app.ownerCredentials else { return }
        let backend = MobileCalendarBackend(environment: .configured(), credentials: credentials)
        do {
            let saved = try await backend.setUpcomingPreferences(value)
            preferences = saved.upcoming
            derive()
        } catch {
            app.alertMessage = "Couldn’t save your Upcoming settings."
        }
    }

    /// Recompute from the current instant and re-arm everything downstream.
    private func derive(publishing: Bool = true) {
        let now = Date()
        plan = MeetingFeed.plan(raw, now: now, preferences: preferences)
        agenda = plan.agenda
        meetings = MeetingFeed.meetings(raw, now: now, preferences: preferences)
        focus = plan.focus
        todayMeetings = WorkTodayMeetings.rows(
            raw, now: now,
            id: \.upcomingID, title: \.upcomingTitle, start: \.upcomingStart, isAllDay: \.upcomingIsAllDay, subject: \.subject
        )
        guard publishing else { return }
        // The Home Screen widget and the controls read the agenda from the
        // shared group, never from a session. The raw feed and the
        // preferences, not the plan: the widget runs `MeetingFocus` itself
        // at each timeline entry, so it agrees with Home at midnight and at
        // every start and end without the app in front.
        AgendaFile.writeMeetings(
            WatchBridgeSnapshot.Meeting.upcoming(from: raw, now: now),
            preferences: preferences
        )
        WidgetCenter.shared.reloadAllTimelines()
        armBoundary(now: now)
        applyAlerts()
    }

    /// One timer, set for the exact instant the derived answer changes — a
    /// meeting ending, starting, or entering the horizon — instead of polling.
    private func armBoundary(now: Date) {
        boundaryTask?.cancel()
        guard let boundary = MeetingFeed.nextBoundary(raw, now: now, preferences: preferences) else { return }
        let delay = max(1, boundary.timeIntervalSince(now)) + 1
        boundaryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.derive()
        }
    }

    private func applyAlerts() {
        let scheduled = MeetingFeed.alertableMeetings(raw, preferences: preferences)
        // The Lock Screen countdown follows the hero: an activity that sat there
        // all evening ticking down to tomorrow's standup is the same mistake as
        // the card that did.
        let upNext = focus
        Task {
            await MeetingNotices.synchronize(meetings: scheduled)
            await MeetingLiveActivity.synchronize(next: upNext)
        }
    }

    /// Foreground refresh loop. Cancelled on background — iOS would suspend it
    /// anyway, and `wake()` covers the return.
    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let interval = self?.foregroundRefreshInterval else { return }
                try? await Task.sleep(for: .seconds(interval))
                guard !Task.isCancelled else { return }
                await self?.refresh()
            }
        }
    }

    private func wake() {
        derive()
        startPolling()
        Task { await refresh() }
    }
}

/// Last-good agenda on disk, keyed by owner so a sign-out and a different
/// sign-in never shows the previous account's meetings.
private struct MeetingFeedCache {
    /// The rows as the wire carries them: the one Codable shape of an event.
    private struct Payload: Codable {
        let owner: String
        let savedAt: Date
        let events: [CalendarEventWire]
        /// The policy the agenda was drawn under, so a cold start derives
        /// the same plan it showed last time. Absent in files written
        /// before it was kept.
        let preferences: UpcomingPreferencesWire?
    }

    struct Saved {
        let events: [MobileCalendarEvent]
        let preferences: UpcomingPreferencesWire?
    }

    private static let fileName = "upcoming-meetings.json"

    private var support: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
    }

    /// One file per workspace.
    private var url: URL? {
        support.map { WorkspaceScope.active.directory(in: $0).appending(path: Self.fileName) }
    }

    /// Nil when nothing was saved for this owner; an empty `events` is a
    /// day that was read and had nothing in it.
    func load(owner: String) -> Saved? {
        guard let url, let data = try? Data(contentsOf: url),
              let payload = try? JSONDecoder().decode(Payload.self, from: data),
              payload.owner == owner
        else { return nil }
        return Saved(events: payload.events.map(CalendarEventSummary.init(wire:)), preferences: payload.preferences)
    }

    func save(_ events: [MobileCalendarEvent], preferences: UpcomingPreferencesWire, owner: String) {
        let payload = Payload(owner: owner, savedAt: Date(), events: events.map(\.wire), preferences: preferences)
        guard let url,
              let data = try? JSONEncoder().encode(payload)
        else { return }
        // Someone else's meeting titles are on this disk: protect them the way
        // the rest of the account material is protected.
        // Until first unlock: a background refresh runs with the phone locked.
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// The workspace's file, and the one file from before the per-workspace
    /// folders.
    func clear() {
        if let url { try? FileManager.default.removeItem(at: url) }
        if let support { try? FileManager.default.removeItem(at: support.appending(path: Self.fileName)) }
    }
}
