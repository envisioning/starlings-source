import Combine
import Foundation
import UIKit

/// The team roster and this device's check-in.
///
/// Two jobs, one object, because they are two halves of the same fact: the app
/// tells the control plane it is open, and reads back who else is. Both stop
/// the moment the app leaves the screen — presence you keep publishing from
/// your pocket is a lie, and polling from the background is a battery bill for
/// a list nobody is looking at.
@MainActor
final class MobileTeamStore: ObservableObject {
    @Published private(set) var roster: PeerRoster = .empty
    /// Conversations with something new in them, newest first. The roster row,
    /// the tab badge, and Home all read this — the server decides unread,
    /// clients only draw it.
    @Published private(set) var unreadThreads: [ThreadSummary] = []
    /// Home waits for the first thread answer, including an empty one, before
    /// replacing its loading projection.
    @Published private(set) var homeMessagesReady = false
    /// Private conversations with several people in them, newest first.
    ///
    /// Kept from the same poll because a group hangs off nothing — no roster
    /// row, no subject — so without this list one that had gone quiet would be
    /// unreachable from the phone.
    @Published private(set) var groupThreads: [ThreadSummary] = []
    /// One-to-one conversations with something in them, newest first — what
    /// orders PEOPLE and AGENTS (`TeamRail.order`) and carries a conversation
    /// whose other side has left the roster.
    @Published private(set) var directThreads: [ThreadSummary] = []
    @Published private(set) var isLoading = false
    /// Set only when the roster could not be read at all. A stale roster is
    /// shown as-is: last-known-around beats an empty screen.
    @Published private(set) var errorMessage: String?

    @Published private(set) var callNotice: String?
    private var callGeneration = 0
    private var isSendingCall = false
    private var pendingCall: (email: String, slug: String, name: String, deadline: Date)?

    private weak var app: StarlingsAppModel?
    private var attached = false
    private var pollTask: Task<Void, Never>?
    private var cancellables: Set<AnyCancellable> = []
    private var seenMessageTimes: [String: Date] = [:]
    /// The ring already announced, keyed by caller and creation time. A ring
    /// appears on every poll inside its forty-five seconds, so without this one
    /// caller would produce two banners.
    private var announcedRing: String?
    /// When the last live thread list was requested — `nil` until the first
    /// one has been read, so the first poll after a launch records unread
    /// history instead of announcing it. After that it is what lets a
    /// brand-new conversation announce its first message
    /// (`MessageNotices.plan`).
    private var lastThreadsObservedAt: Date?
    private var hasObservedThreads: Bool { lastThreadsObservedAt != nil }
    /// The conversation on screen, so its arrivals are not also announced as
    /// banners over the top of themselves.
    private var activeThreadID: String?

    /// Conversations with something new, by the other person's address.
    ///
    /// One-to-one only. A group carries a `peerEmail` too — whichever member
    /// the index answered first — and letting that light up somebody's roster
    /// row would put a dot on a conversation they are not in.
    var unreadPeerEmails: Set<String> {
        Set(unreadThreads.filter { !$0.isGroup }.compactMap(\.peerEmail))
    }

    /// The same, for channels and groups — neither of which has one peer to
    /// key on. A group is keyed by id for exactly the reason a channel is.
    var unreadThreadIDs: Set<String> {
        Set(unreadThreads.filter { $0.kind.isChannel || $0.isGroup }.map(\.id))
    }

    /// Split by the door the conversation is behind, so a badge never counts a
    /// message the tab under it cannot open. People and Everyone are Team's;
    /// a project or lead channel is Work's, beside the tasks on the same
    /// subject.
    var unreadTeamCount: Int { unreadThreads.filter { !$0.kind.isSubjectChannel }.count }
    var unreadWorkCount: Int { unreadSubjectThreads.count }

    /// Project and lead channels with something new, newest first. Work lists
    /// these ahead of everything else on Mine.
    var unreadSubjectThreads: [ThreadSummary] { unreadThreads.filter(\.kind.isSubjectChannel) }

    /// Subjects with something new, by CRM id — what a dot on a Work row reads.
    var unreadSubjectIDs: Set<String> { Set(unreadSubjectThreads.compactMap(\.parentID)) }

    /// Somebody asked for you. Read off the roster poll — there is no push, so
    /// this only ever appears while the app is running. It no longer needs the
    /// Team tab to be the one you are looking at: `announceRing` raises a local
    /// notification from any tab.
    var incomingRing: PeerRing? { roster.liveRing }

    /// Your own row, which is where your status is set and read.
    var me: Peer? { roster.me }

    /// Called by the open conversation. Opening one is reading it, so the dot
    /// clears here rather than waiting for the next poll to confirm what the
    /// person is already looking at.
    func setActiveThread(_ threadID: String?, peerEmail: String?) {
        activeThreadID = threadID
        if let peerEmail { unreadThreads.removeAll { $0.peerEmail == peerEmail } }
        // A channel is cleared by its own id: there is no peer on it to match.
        if let threadID { unreadThreads.removeAll { $0.id == threadID } }
    }

    /// Whose roster and threads are drawn: the owner painted at attach,
    /// then each sign-in.
    private var paintedOwner: String?

    func attach(to app: StarlingsAppModel) {
        guard !attached else { return }
        attached = true
        self.app = app
        // Disk first, synchronously, before the sink hops and the heartbeat
        // goes out (docs/CACHING.md): MESSAGES and the faces are
        // in the first frame.
        paintedOwner = app.ownerCredentials?.owner.email
        if let credentials = app.ownerCredentials {
            paintRosterSnapshot(credentials: credentials)
            paintThreadsSnapshot(credentials: credentials)
        }

        // See UpcomingMeetingsStore: `@Sendable` keeps a notification posted
        // off the main thread from tripping the isolation assertion.
        app.$ownerCredentials
            .map { @Sendable in $0?.owner.email }
            .removeDuplicates()
            .sink { @Sendable email in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    // Only a different owner clears what is drawn.
                    if email != self.paintedOwner {
                        self.paintedOwner = email
                        self.roster = .empty
                        self.homeMessagesReady = false
                    }
                    // The poll's first pass is the read; see MobileMyWorkStore.
                    self.stop()
                    if self.app?.ownerCredentials != nil {
                        self.start()
                    } else {
                        await self.refresh()
                        await self.refreshThreads()
                    }
                }
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)
            .map { @Sendable _ in () }
            .sink { @Sendable in Task { @MainActor [weak self] in self?.start() } }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)
            .map { @Sendable _ in () }
            .sink { @Sendable in Task { @MainActor [weak self] in self?.stop() } }
            .store(in: &cancellables)
        // No `start()` here: the credentials sink above fires with the
        // current session and starts the poll.
    }

    /// Runs for as long as the app is in front — not for as long as the Team
    /// tab is. A ring lives forty-five seconds and a message arrives whenever
    /// it arrives; both have to reach somebody who is looking at Home. Stopped
    /// on background by `attach`, because presence you keep publishing from
    /// your pocket is a lie. The roster is cached for ten seconds at the
    /// Worker, so a faster poll would re-read the same object.
    func start() {
        guard let credentials = app?.ownerCredentials else { return }
        guard pollTask == nil else { return }
        paintRosterSnapshot(credentials: credentials)
        paintThreadsSnapshot(credentials: credentials)
        pollTask = Task { [weak self] in
            var beat = Date.distantPast
            var lastThreadRead = Date.distantPast
            while !Task.isCancelled {
                guard let self else { return }
                if Date().timeIntervalSince(beat) >= PeerPresenceCadence.heartbeat {
                    beat = Date()
                    await self.checkIn()
                }
                await self.refresh()
                if Date().timeIntervalSince(lastThreadRead) >= DirectMessageCadence.threadListPoll {
                    lastThreadRead = Date()
                    await self.refreshThreads()
                }
                try? await Task.sleep(for: .seconds(PeerPresenceCadence.rosterPoll))
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    func refresh() async {
        guard let app, let credentials = app.ownerCredentials else {
            roster = .empty
            cancelCall()
            errorMessage = nil
            return
        }
        paintRosterSnapshot(credentials: credentials)
        isLoading = roster.peers.isEmpty
        do {
            roster = try await app.api.peers(credentials: credentials)
            // The roster is the only thing that knows whose picture changed,
            // so it is what tells the avatar store; everything else asks by
            // address. See `PersonAvatarStore`.
            let people = roster.peers
            Task { await PersonAvatarStore.shared.remember(people) }
            errorMessage = nil
            resolvePendingCall()
            announceRing(webOrigin: app.api.environment.webOrigin)
        } catch {
            // Keep whatever roster is already on screen.
            errorMessage = roster.peers.isEmpty ? error.localizedDescription : nil
        }
        isLoading = false
    }

    /// The conversation list is what makes an unread dot possible without
    /// opening anything. It is also the only thing that can notice a message
    /// arriving while you are looking at another tab — there is no push.
    /// Last known first: the team, nobody's state. Called from `start` so
    /// the names and pictures are on screen before the heartbeat goes out,
    /// not after it comes back; the live read says who is around
    /// (docs/CACHING.md).
    private func paintRosterSnapshot(credentials: MobileOwnerCredentials) {
        guard roster.peers.isEmpty, let app,
              let cached = app.api.snapshot(StarlingsAPI.peersSnapshotKey, credentials: credentials, as: PeerRoster.self)
        else { return }
        roster = cached.value.withoutPresence
        Task { await PersonAvatarStore.shared.remember(roster.peers) }
    }

    func refreshThreads() async {
        guard let app, let credentials = app.ownerCredentials else {
            unreadThreads = []
            groupThreads = []
            directThreads = []
            homeMessagesReady = false
            return
        }
        paintThreadsSnapshot(credentials: credentials)
        // Taken before the request, so a message written while it is in
        // flight still counts as after this observation next time.
        let observedAt = Date()
        guard let threads = try? await app.api.threads(credentials: credentials) else {
            homeMessagesReady = true
            return
        }

        sortThreads(threads)
        let planned = MessageNotices.plan(
            threads: threads,
            seen: seenMessageTimes,
            activeThreadID: activeThreadID,
            previousObservation: lastThreadsObservedAt,
            notifyOnAllChannelMessages: MessageNotificationPreferences.notifiesOnAllChannelMessages()
        )
        seenMessageTimes = planned.seen
        lastThreadsObservedAt = observedAt
        await MessageNotices.deliver(planned.notices)
    }

    /// Painted without notices: the snapshot is not an observation, so the
    /// first live poll is still the first one (docs/CACHING.md). Called from
    /// `start` too, because the poll reads threads only after the heartbeat
    /// and the roster, and Home's MESSAGES card should not wait for either.
    private func paintThreadsSnapshot(credentials: MobileOwnerCredentials) {
        guard !hasObservedThreads, !homeMessagesReady, let app,
              let cached = app.api.snapshot(StarlingsAPI.threadsSnapshotKey, credentials: credentials, as: ThreadListResponse.self)
        else { return }
        sortThreads(cached.value.threads)
    }

    private func sortThreads(_ threads: [ThreadSummary]) {
        // The open conversation is being read: a list poll that lands before
        // its read receipt must not paint its dot back.
        unreadThreads = threads
            .filter { $0.unread && $0.id != activeThreadID }
            .sorted { ($0.lastMessageAt ?? .distantPast) > ($1.lastMessageAt ?? .distantPast) }
        groupThreads = threads
            .filter(\.isGroup)
            .sorted { ($0.lastMessageAt ?? .distantPast) > ($1.lastMessageAt ?? .distantPast) }
        directThreads = threads
            .filter { $0.kind == .dm && !$0.isGroup }
            .sorted { ($0.lastMessageAt ?? .distantPast) > ($1.lastMessageAt ?? .distantPast) }
        homeMessagesReady = true
    }

    /// Somebody asked for you while you were on another tab. There is still no
    /// push behind this — it announces a ring the poll has already read, so it
    /// only ever fires with the app open.
    private func announceRing(webOrigin: String) {
        let planned = RingNotices.plan(
            ring: roster.liveRing,
            announced: announcedRing,
            webOrigin: webOrigin
        )
        announcedRing = planned.announced
        if planned.announced == nil { RingNotices.withdraw() }
        guard let notice = planned.notice else { return }
        Task { await RingNotices.deliver(notice) }
    }

    /// Ring a colleague. Deliberately quiet: no push, and no promise it
    /// arrived — it shows on their next poll, and is announced there, only if
    /// Meet is running. Returns the message to show, whether it worked or not.
    /// A wave has no row of its own to answer on, so the result is a toast:
    /// the landed wave in passing, the failure red with Copy.
    func ring(_ peer: Peer) async {
        guard let app, let credentials = app.ownerCredentials else {
            StarlingsToastCenter.shared.show(String(localized: "Sign in first"), tone: .danger)
            return
        }
        do {
            try await app.api.ring(credentials: credentials, peerEmail: peer.email)
            StarlingsHaptics.success.play()
            StarlingsToastCenter.shared.show(String(localized: "Waved at \(peer.shortName)"))
        } catch {
            StarlingsToastCenter.shared.show(error.localizedDescription, tone: .danger)
        }
    }

    /// Every plan ends in a room, a request, or a toast that says why not
    ///. The notice row lives on the roster, which a pushed
    /// conversation covers, so a failure is a toast like a wave's.
    func call(_ peer: Peer) async {
        guard let app, let credentials = app.ownerCredentials else {
            StarlingsToastCenter.shared.show(String(localized: "Sign in first"), tone: .danger)
            return
        }
        let slug: String
        switch peer.callPlan {
        case .join(let joinSlug):
            joinCall(joinSlug)
            return
        case .unavailable(let reason):
            StarlingsToastCenter.shared.show(reason, tone: .danger)
            return
        case .ask(let askSlug):
            slug = askSlug
        }
        guard pendingCall == nil, !isSendingCall else {
            if let callNotice { StarlingsToastCenter.shared.show(callNotice) }
            return
        }
        isSendingCall = true
        callGeneration += 1
        let generation = callGeneration
        defer { isSendingCall = false }
        do {
            try await app.api.callPeer(credentials: credentials, peerEmail: peer.email)
            guard generation == callGeneration else { return }
            pendingCall = (peer.email, slug, peer.shortName, Date().addingTimeInterval(PeerPresenceCadence.ringLife))
            callNotice = "Asking \(peer.shortName) to open their room…"
            await refresh()
        } catch {
            StarlingsToastCenter.shared.show(error.localizedDescription, tone: .danger)
        }
    }

    func joinRoom(_ peer: Peer) {
        guard let slug = peer.joinRoomSlug else { return }
        joinCall(slug)
    }

    private func joinCall(_ slug: String) {
        app?.pendingCallRoom = slug
        app?.selectTab(.home)
    }

    private func resolvePendingCall() {
        guard let pending = pendingCall else { return }
        guard Date() < pending.deadline else {
            pendingCall = nil
            callNotice = "No answer from \(pending.name)."
            return
        }
        if roster.peers.contains(where: { $0.email == pending.email && $0.status == .inMeeting }) {
            pendingCall = nil
            callNotice = nil
            joinCall(pending.slug)
        }
    }

    func cancelCall() {
        callGeneration += 1
        pendingCall = nil
        callNotice = nil
    }

    func answerCall() async {
        // Refresh before opening a microphone: a notification can outlive its ask.
        await refresh()
        guard incomingRing?.kind == .call, let app else { return }
        await clearRing()
        app.selectTab(.home)
        app.pendingWalkUp = true
    }

    /// Your own Claude asked to open your room and you said yes.
    /// The same shape as `answerCall`, down the transcribing path.
    func answerAgentAsk() async {
        // Refresh before opening a microphone: a notification can outlive its ask.
        await refresh()
        guard incomingRing?.kind == .agentStart, let app else { return }
        await clearRing()
        app.selectTab(.home)
        app.pendingAgentStart = true
    }

    /// Answered or dismissed. Clearing locally as well as at the Worker keeps
    /// the banner from flashing back for one poll.
    func clearRing() async {
        guard let app, let credentials = app.ownerCredentials else { return }
        announcedRing = nil
        RingNotices.withdraw()
        try? await app.api.clearRing(credentials: credentials)
        await refresh()
    }

    /// The whole status question answered in one choice — the same
    /// `PeerStatusOption` the Mac's control offers, with the same rules:
    /// unavailable and intent are set one at a time, and visibility rides
    /// every answer (hiding hides; anything else means you can be seen).
    /// Refreshes immediately: your own status is the one nobody will
    /// tolerate lagging.
    func applyStatus(_ option: PeerStatusOption) async {
        guard let app, let credentials = app.ownerCredentials else { return }
        let resolved = option.resolve()
        do {
            if resolved.setsDND {
                try await app.api.setDoNotDisturb(credentials: credentials, until: resolved.dndUntil)
            }
            if resolved.dndUntil == nil && resolved.setsDND {
                try await app.api.setIntent(credentials: credentials, intent: resolved.intent, until: resolved.intentUntil)
            }
            try await app.api.setAppearOffline(credentials: credentials, invisible: option.invisible)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        await refresh()
    }

    /// Where this device reads pictures. Nil while signed out — there is no
    /// unauthenticated form of the call. Changing your own picture lives in
    /// Settings → Account, which reads and writes it directly.
    var avatarSource: PersonAvatarSource? {
        guard let app, let credentials = app.ownerCredentials else { return nil }
        return MobileAvatarSource(api: app.api, credentials: credentials)
    }

    /// Best-effort by design: a dropped beat costs one status for one minute.
    private func checkIn() async {
        guard let app, let credentials = app.ownerCredentials else { return }
        try? await app.api.heartbeat(credentials: credentials)
    }
}
