import Combine
import Foundation
import WatchConnectivity

/// The phone's half of `WatchBridgeSnapshot`: whenever the session, the
/// upcoming list, or today's work changes, the latest snapshot goes to the watch.
///
/// The watch talks to the Worker itself with the lent token. The one thing
/// that comes back over this channel is a request for a session, sent when
/// the Worker refused that token. `updateApplicationContext` is the right
/// primitive for the snapshot — the system delivers the newest value when the
/// watch is reachable and drops the ones it superseded — and it needs no
/// watch app in the foreground.
@MainActor
final class WatchBridgeSession: NSObject, ObservableObject {
    static let shared = WatchBridgeSession()

    private weak var app: StarlingsAppModel?
    private var cancellables: Set<AnyCancellable> = []
    private var attached = false
    /// Today's work as `MobileMyWorkStore` last planned it.
    private var work: [WatchBridgeSnapshot.WorkRow] = []

    /// How many meetings the wrist holds. The face shows two; a spare covers
    /// one ending between snapshots.
    private static let meetingLimit = 3

    func attach(to app: StarlingsAppModel) {
        guard !attached, WCSession.isSupported() else { return }
        attached = true
        self.app = app
        let session = WCSession.default
        session.delegate = self
        session.activate()

        // `@Sendable` for the same reason `UpcomingMeetingsStore` says: the
        // publishers can fire off the main actor, and each hop is explicit.
        app.$ownerCredentials
            .removeDuplicates()
            .sink { @Sendable _ in
                Task { @MainActor [weak self] in self?.push() }
            }
            .store(in: &cancellables)
        app.upcoming.$meetings
            .removeDuplicates()
            .sink { @Sendable _ in
                Task { @MainActor [weak self] in self?.push() }
            }
            .store(in: &cancellables)
    }

    /// The work store's rows, for the watch's work complication.
    func updateWork(_ rows: [WatchBridgeSnapshot.WorkRow]) {
        guard rows != work else { return }
        work = rows
        push()
    }

    /// The watch's token was refused. The phone's own token renews here if it
    /// is near its end; the snapshot goes again either way, because the
    /// watch may never have received the last one.
    private func watchRequestedSession() async {
        guard let app else { return }
        await app.renewSessionIfNeeded()
        push(force: true)
    }

    private func push(force: Bool = false) {
        guard let app else { return }
        let session = WCSession.default
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
        let snapshot = Self.snapshot(
            credentials: app.ownerCredentials,
            meetings: app.upcoming.meetings,
            work: work,
            environment: .configured()
        )
        // Equal context is a no-op on the system side too, but the encode is
        // ours to skip.
        if !force, let current = WatchBridgeSnapshot.decode(context: session.applicationContext),
           current.session == snapshot.session, current.meetings == snapshot.meetings,
           current.work == snapshot.work {
            return
        }
        try? session.updateApplicationContext(try snapshot.encodedContext())
    }

    /// Pure, so the shape the watch gets can be checked without a session.
    static func snapshot(
        credentials: MobileOwnerCredentials?,
        meetings: [MobileCalendarEvent],
        work: [WatchBridgeSnapshot.WorkRow] = [],
        environment: StarlingsEnvironment,
        now: Date = Date()
    ) -> WatchBridgeSnapshot {
        let session = credentials.map {
            WatchBridgeSnapshot.Session(
                accessToken: $0.accessToken,
                ownerName: $0.owner.name,
                apiEndpoint: environment.apiBaseURL.absoluteString,
                ownerEmail: $0.owner.email,
                workspaceName: StarlingsWorkspace.active.name
            )
        }
        let upcoming = WatchBridgeSnapshot.Meeting.upcoming(from: meetings, now: now).prefix(meetingLimit)
        return WatchBridgeSnapshot(
            session: session,
            meetings: Array(upcoming),
            sentAt: now,
            work: session == nil ? nil : work
        )
    }
}

extension WatchBridgeSession: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        Task { @MainActor in self.push() }
    }

    /// A watch paired or the app installed after launch: send what we have.
    nonisolated func sessionWatchStateDidChange(_ session: WCSession) {
        Task { @MainActor in self.push() }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard message[WatchBridgeSnapshot.sessionRequestKey] != nil else { return }
        Task { @MainActor in await self.watchRequestedSession() }
    }

    // iOS requires both; a phone with one watch never sees them do anything.
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }
}

extension WatchBridgeSnapshot.Meeting {
    /// The bridge shape of one calendar event, or nil once it has ended.
    init?(event: MobileCalendarEvent, now: Date) {
        guard let start = event.startDate, let end = event.endDate, end > now else { return nil }
        self.init(
            id: event.id,
            title: event.title,
            start: start,
            end: end,
            calendarName: event.calendarSummary,
            isVideo: event.isVideoMeeting,
            launchURL: event.conferenceLink?.absoluteString,
            calendarID: event.calendarId,
            isAllDay: event.isAllDay,
            isDemoted: event.demoted,
            attendees: event.attendees.filter { !$0.isSelf }.map { StarlingsGlance.firstName($0.name, email: $0.email) }
        )
    }

    /// What is still ahead, soonest first. The watch and the phone widgets
    /// read the same list, so a meeting cannot be "next" on one and not the
    /// other.
    static func upcoming(from events: [MobileCalendarEvent], now: Date = Date()) -> [WatchBridgeSnapshot.Meeting] {
        // The snapshot carries no guest list, so the member rule runs here,
        // on the feed rows, before the widgets and the watch classify it.
        events
            .filter { MeetingFocus.isMemberEvent($0) }
            .compactMap { WatchBridgeSnapshot.Meeting(event: $0, now: now) }
            .sorted { $0.start < $1.start }
    }
}
