import Combine
import Foundation
import UserNotifications
import StarlingsContracts

/// The owner's waiting room on the phone.
///
/// This polls rather than holding the lobby socket, which is what the Mac does
/// too (`MeetingViewController.startLobbyWatch`): one queue, one refresh rule,
/// two renderers. A knock has to appear within a couple of seconds of being
/// made — somebody is standing at a door looking at a spinner.
@MainActor
final class MobileLobbyWatch: ObservableObject {
    @Published private(set) var waiting: [LobbyRequestResponse] = []
    @Published private(set) var lurking: [GuestPresenceRow] = []
    @Published private(set) var people: [Peer] = []
    /// Set when the queue could not be read. The host surface says so rather
    /// than showing an empty waiting room, which would read as "nobody there".
    @Published private(set) var unavailable: String?
    /// Requests with a decision in flight, so a double tap cannot admit twice.
    @Published private(set) var deciding: Set<String> = []
    /// Ticks once per knock announced, for the haptic on the host's screen.
    /// The count, not the queue: a guest who gives up and leaves shrinks the
    /// queue, and that is nothing to buzz about.
    @Published private(set) var knockCount = 0
    /// An event session's second door (docs/SESSIONS.md §7): open while
    /// registration links let guests in without a knock.
    @Published private(set) var sessionDoorOpen = false
    @Published private(set) var closingSessionDoor = false

    private let api: StarlingsAPI
    private var credentials: MobileOwnerCredentials?
    private var room: String?
    private var poll: Task<Void, Never>?
    /// The open meeting on every poll, for the host to reconcile who hosts
    /// when a `host.v1` message was lost.
    var onMeeting: ((LobbySnapshotResponseMeeting?) async -> Void)?
    private var announced: Set<String> = []
    private var loadedPeople = false

    init(api: StarlingsAPI) {
        self.api = api
    }

    func start(credentials: MobileOwnerCredentials, room: String) {
        self.credentials = credentials
        self.room = room
        guard poll == nil else { return }
        poll = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(StarlingsPollingCadence.lobbyFallback))
            }
        }
    }

    func stop() {
        poll?.cancel()
        poll = nil
        waiting = []
        lurking = []
        people = []
        loadedPeople = false
        deciding = []
        announced = []
        knockCount = 0
        unavailable = nil
        sessionDoorOpen = false
        KnockNotices.withdraw()
    }

    /// Registration links stop admitting for the rest of the session. True
    /// when the control plane took it.
    @discardableResult
    func closeSessionDoor() async -> Bool {
        guard let credentials, let room, !closingSessionDoor else { return false }
        closingSessionDoor = true
        defer { closingSessionDoor = false }
        do {
            sessionDoorOpen = try await api.closeSessionDoor(credentials: credentials, room: room).sessionDoorOpen
            return true
        } catch {
            unavailable = (error as? StarlingsError)?.message ?? error.localizedDescription
            return false
        }
    }

    /// True when the control plane took the decision.
    @discardableResult
    func admit(_ guest: LobbyRequestResponse, onBehalfOf: String? = nil) async -> Bool {
        await decide(guest, admit: true, onBehalfOf: onBehalfOf)
    }

    @discardableResult
    func decline(_ guest: LobbyRequestResponse) async -> Bool { await decide(guest, admit: false) }

    private func decide(_ guest: LobbyRequestResponse, admit: Bool, onBehalfOf: String? = nil) async -> Bool {
        guard let credentials, let room, !deciding.contains(guest.id) else { return false }
        deciding.insert(guest.id)
        defer { deciding.remove(guest.id) }
        do {
            try await api.decideWaitingGuest(
                credentials: credentials,
                room: room,
                requestID: guest.id,
                admit: admit,
                onBehalfOf: onBehalfOf
            )
            // Drop the row now rather than waiting for the next poll: the host
            // just answered, and a row that lingers invites a second tap.
            waiting.removeAll { $0.id == guest.id }
            announced.remove(guest.id)
            if waiting.isEmpty { KnockNotices.withdraw() }
            return true
        } catch {
            unavailable = (error as? StarlingsError)?.message ?? error.localizedDescription
            return false
        }
    }

    private func refresh() async {
        guard let credentials, let room else { return }
        do {
            let snapshot = try await api.lobby(credentials: credentials, room: room)
            await onMeeting?(snapshot.meeting)
            let queue = snapshot.requests
                .filter(\.isWaiting)
                .sorted { $0.createdAt < $1.createdAt }
            unavailable = nil
            sessionDoorOpen = snapshot.meeting?.sessionDoorOpen == true
            waiting = queue
            lurking = snapshot.lurkers.sorted { $0.createdAt < $1.createdAt }
            if queue.contains(where: { $0.recording == true }) && !loadedPeople {
                if let roster = try? await api.peers(credentials: credentials) {
                    people = roster.people
                    loadedPeople = true
                }
            }
            await announceNewKnocks(in: queue)
        } catch {
            unavailable = (error as? StarlingsError)?.message ?? error.localizedDescription
        }
    }

    /// Announce a knock once. The queue holds a waiting row for as long as the
    /// guest stands there, so without the seen-set every poll would re-announce
    /// the same person — the same rule `RingNotices` follows.
    private func announceNewKnocks(in queue: [LobbyRequestResponse]) async {
        let ids = Set(queue.map(\.id))
        announced.formIntersection(ids)
        guard let next = queue.first(where: { !announced.contains($0.id) }) else { return }
        announced.insert(next.id)
        knockCount += 1
        guard let room else { return }
        await KnockNotices.deliver(guest: next, room: room, waiting: queue.count)
    }
}

/// "Somebody is at the door", while the app is running.
///
/// **This is not push.** There is no APNs registration anywhere in Meet, so a
/// knock that arrives while the app is closed is not announced. Hosting from
/// the phone keeps the app alive — the meeting holds the audio session — which
/// is the only reason a local notification is worth posting at all. Do not
/// describe this as push in user-facing copy.
enum KnockNotices {
    static let categoryIdentifier = "MEET_KNOCK"
    static let admitAction = "MEET_KNOCK_ADMIT"
    static let openAction = "MEET_KNOCK_OPEN"
    static let roomKey = "room"
    static let requestIDKey = "requestId"
    static let nameKey = "name"
    private static let identifier = "meet.knock"
    private static let failureIdentifier = "meet.knock.failed"

    /// Admit runs in the background — no `.foreground` — so the phone answers
    /// without unlocking, and so the action works from the watch, where this
    /// banner mirrors. Decline is deliberately not here: the one decision
    /// that sends someone away is made looking at the waiting room.
    static var category: UNNotificationCategory {
        UNNotificationCategory(
            identifier: categoryIdentifier,
            actions: [
                UNNotificationAction(identifier: admitAction, title: String(localized: "Admit"), options: []),
                UNNotificationAction(identifier: openAction, title: String(localized: "Open"), options: [.foreground]),
            ],
            intentIdentifiers: [],
            options: []
        )
    }

    /// The banner names one guest and Admit is bound to that guest's request
    /// id, never to "whoever is first": the queue can change between the
    /// banner and the tap, and admitting the wrong person is worse than a
    /// second banner.
    static func deliver(guest: LobbyRequestResponse, room: String, waiting: Int) async {
        guard await MeetingNotices.requestAuthorization() else { return }
        let content = UNMutableNotificationContent()
        content.title = String(localized: "\(guest.name) is waiting to join")
        content.body = waiting > 1 ? String(localized: "\(waiting) people are at the door") : String(localized: "Admit, or open Home to decline")
        content.sound = .default
        content.categoryIdentifier = categoryIdentifier
        content.userInfo = [roomKey: room, requestIDKey: guest.id, nameKey: guest.name]
        // One identifier: a second knock replaces the banner rather than
        // stacking, and the body carries the count instead.
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(
            identifier: identifier,
            content: content,
            trigger: nil
        ))
    }

    /// Admit from the banner failed. The banner is gone by now, so this is
    /// the only way the host learns the guest is still at the door.
    static func deliverFailure(name: String) async {
        let content = UNMutableNotificationContent()
        content.title = String(localized: "Couldn’t admit \(name)")
        content.body = String(localized: "Still at the door")
        content.sound = .default
        content.categoryIdentifier = categoryIdentifier
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(
            identifier: failureIdentifier,
            content: content,
            trigger: nil
        ))
    }

    static func withdraw() {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [identifier])
    }
}
