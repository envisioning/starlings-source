import AppKit

/// The team roster, watched for the life of the app rather than for the life of
/// the Work window.
///
/// Presence used to be polled by a separate Team surface alone, which stopped the
/// moment that window closed — and it is closed by default. A Ring lives for
/// forty-five seconds and is delivered on a roster poll, so in practice it
/// reached nobody. This runs wherever the app is: it heartbeats this Mac,
/// hands the roster to whoever draws it, and announces an incoming ring once.
///
/// Running everywhere is not the same as running at one rate. The brisk
/// cadence exists so a roster somebody is *watching* looks live; a ring only
/// needs to be read twice inside RING_TTL_MILLISECONDS. So the poll follows
/// attention — see `Attention` — and stops outright behind a locked screen,
/// where a nudge could not be seen and a client that stops beating is
/// correctly shown as away rather than wrongly shown as around.
///
/// Envisioning-only by construction: `GET /api/peers` refuses anyone without a
/// verified member session, and this skips the request entirely when nobody is
/// signed in. See docs/PRIVACY.md.
/// A registered observer and the centre that has to be asked to forget it —
/// the three centres involved here are not interchangeable.
private struct LifecycleObserver {
    let center: NotificationCenter
    let token: NSObjectProtocol
}

@MainActor
final class PeerWatch {
    private(set) var roster: PeerRoster = .empty
    /// Conversations with something new in them, newest first. Polled here
    /// rather than by the Work window for the same reason presence is: the
    /// window is shut by default, and the launch surface has to be able to say
    /// "somebody wrote to you" without it. The server decides unread; every
    /// surface only draws it.
    private(set) var unreadThreads: [ThreadSummary] = []
    /// Every channel this member can read, newest first. Read off the same poll
    /// as unread — a channel is open to the whole company, so this is the same
    /// list for everybody, and one that nobody has opened does not exist yet.
    private(set) var channelThreads: [ThreadSummary] = []
    /// Every private conversation with more than one other person in it, newest
    /// first. Read off the same poll for the same reason a channel is: a group
    /// has no roster row and no subject to hang off, so without this list a
    /// quiet one would be unreachable until somebody spoke in it.
    private(set) var groupThreads: [ThreadSummary] = []
    /// Every one-to-one conversation that has something in it, newest first.
    /// A DM used to be reachable only through its person's roster row, which
    /// made the roster the only door: hiding somebody in Admin, or a colleague
    /// going cold, took the conversation with them. The Worker drops the empty
    /// and the archived, so what arrives here is the list as drawn.
    private(set) var directThreads: [ThreadSummary] = []
    /// Set only when the roster has never been read. A stale roster is left
    /// alone: last-known-around beats an empty screen, and the surfaces need
    /// something to say only when there has never been one.
    private(set) var lastErrorMessage: String?
    /// Whether the last roster read reached the Worker: false after a failed
    /// read, true again after a good one. The menu bar greys on false.
    private(set) var isReachable = true

    /// Answering a ring from wherever it was announced — the Work window, the
    /// menu bar, or a notification action.
    var onJoinRing: ((String) -> Void)?
    /// Progress on a call this Mac placed: asking, answered, or nobody there.
    /// One line of prose and its tone; `.danger` is a call that failed. The
    /// surfaces that draw it decide where it goes.
    var onCallProgress: ((String, StarlingsToastTone) -> Void)?
    /// A wave that failed, placed from a surface that has no local status
    /// line, such as the menu bar.
    var onWaveProgress: ((String) -> Void)?
    /// A wave that landed — a passing word, not a status.
    var onWaved: ((String) -> Void)?

    /// A call this Mac placed and is waiting on. Held here rather than in a
    /// window because the roster poll is what notices the answer, and that runs
    /// whether or not the window that placed the call is still open.
    private var pendingCall: (email: String, slug: String, name: String, deadline: Date)?

    private let api: MeetingControlAPI
    private let ownerSessionStore: OwnerSessionStore
    private var observers: [(PeerRoster) -> Void] = []
    private var reachabilityObservers: [(Bool) -> Void] = []
    private var unreadObservers: [([ThreadSummary]) -> Void] = []
    private var channelObservers: [([ThreadSummary]) -> Void] = []
    private var groupObservers: [([ThreadSummary]) -> Void] = []
    private var directObservers: [([ThreadSummary]) -> Void] = []
    private var pollTask: Task<Void, Never>?
    /// The interval the running loop was started with, or `nil` when it is not
    /// running. Compared against, not read for its value.
    private var cadence: TimeInterval?
    /// Set by the lock and sleep notifications, which arrive in pairs and can
    /// overlap — locking the screen also sleeps the displays.
    private var isAway = false
    private var lifecycleObservers: [LifecycleObserver] = []
    private var lastHeartbeat = Date.distantPast
    private var lastThreadRead = Date.distantPast
    /// The ring already announced, keyed by caller and creation time. A ring
    /// sits in the roster for its whole life, so without this every poll would
    /// re-announce the same person for forty-five seconds.
    private var announcedRing: String?
    /// The newest message time already accounted for, per thread — so a
    /// message notification fires once, for what actually just arrived, not
    /// for the whole unread list on every poll. See `MessageNotices.plan`.
    private var seenMessageTimes: [String: Date] = [:]
    /// When the last thread list was requested — `nil` until the first one
    /// has been read, so the app's first poll after launch records the
    /// existing unread mail rather than announcing all of it at once. After
    /// that it is what lets a brand-new conversation announce its first
    /// message (`MessageNotices.plan`).
    private var lastMessagesObservedAt: Date?

    init(api: MeetingControlAPI, ownerSessionStore: OwnerSessionStore) {
        self.api = api
        self.ownerSessionStore = ownerSessionStore
    }

    /// Called back on every poll, and immediately with whatever is already
    /// known so a window that opens mid-cycle paints at once.
    func observe(_ observer: @escaping (PeerRoster) -> Void) {
        observers.append(observer)
        observer(roster)
    }

    /// Called back when `isReachable` flips, and immediately with its value.
    func observeReachability(_ observer: @escaping (Bool) -> Void) {
        reachabilityObservers.append(observer)
        observer(isReachable)
    }

    private func setReachable(_ reachable: Bool) {
        guard reachable != isReachable else { return }
        isReachable = reachable
        for observer in reachabilityObservers { observer(reachable) }
    }

    /// Called back on every poll, and immediately with whatever is already
    /// known — same contract as `observe`, for the surfaces that draw unread.
    func observeUnread(_ observer: @escaping ([ThreadSummary]) -> Void) {
        unreadObservers.append(observer)
        // Not with the empty start: Home draws placeholders until the first
        // answer — a snapshot or a poll — and "nothing" is an answer only
        // once read.
        if unreadAnswered { observer(unreadThreads) }
    }

    private var unreadAnswered = false

    /// Called back on every poll, and immediately — same contract again, for
    /// the surfaces that draw the channel list.
    func observeChannels(_ observer: @escaping ([ThreadSummary]) -> Void) {
        channelObservers.append(observer)
        observer(channelThreads)
    }

    /// The same, for the surfaces that draw private group conversations.
    func observeGroups(_ observer: @escaping ([ThreadSummary]) -> Void) {
        groupObservers.append(observer)
        observer(groupThreads)
    }

    /// The same, for one-to-one conversations.
    func observeDirects(_ observer: @escaping ([ThreadSummary]) -> Void) {
        directObservers.append(observer)
        observer(directThreads)
    }

    /// Opening a conversation is reading it. Clearing here rather than waiting
    /// for the next poll keeps a dot from outliving the window that answered
    /// it — the read receipt is already on its way to the Worker.
    func markRead(peerEmail: String) {
        // One-to-one only. A group carries a `peerEmail` too, and clearing on
        // it would take the dot off a conversation nobody opened.
        let next = unreadThreads.filter { $0.isGroup || $0.peerEmail != peerEmail }
        guard next.count != unreadThreads.count else { return }
        publishUnread(next)
    }

    /// The same thing for a channel, which has no peer to key on.
    func markRead(threadID: String) {
        let next = unreadThreads.filter { $0.id != threadID }
        guard next.count != unreadThreads.count else { return }
        publishUnread(next)
    }

    func start() {
        guard lifecycleObservers.isEmpty else { return }
        // The last unread list first (docs/CACHING.md), so Home's MESSAGES
        // is right in the first frame. No notices from a snapshot: the first
        // live poll is still the first observation.
        if unreadThreads.isEmpty,
           let cached = api.snapshot(MeetingControlAPI.threadsSnapshotKey, as: ThreadListResponse.self) {
            let unread = cached.value.threads
                .filter(\.unread)
                .sorted { ($0.lastMessageAt ?? .distantPast) > ($1.lastMessageAt ?? .distantPast) }
            // Nothing unread is an answer too: MESSAGES folds in
            // the first frame instead of holding placeholders for the poll.
            publishUnread(unread)
        }
        observeLifecycle()
        applyAttention()
    }

    func stop() {
        for token in lifecycleObservers { token.center.removeObserver(token.token) }
        lifecycleObservers = []
        pollTask?.cancel()
        pollTask = nil
        cadence = nil
    }

    /// How much of the machine's attention the app currently has, and what that
    /// is worth in requests.
    private enum Attention {
        /// Somebody is in the app. The roster is potentially on screen and has
        /// to look live.
        case attended
        /// The app is running behind something else. Rings still have to
        /// arrive — that is the whole reason this watch outlives the Work
        /// window — just not at the rate of a roster being watched.
        case background
        /// Screen locked, or the machine or its displays asleep. A ring
        /// announced now could not be seen, and dropping the heartbeat is the
        /// correct answer rather than a lost one: the roster shows this Mac as
        /// away, which is what it is.
        case away

        /// `nil` means "do not poll at all".
        var pollInterval: TimeInterval? {
            switch self {
            case .attended: PeerPresenceCadence.rosterPoll
            case .background: PeerPresenceCadence.backgroundRosterPoll
            case .away: nil
            }
        }
    }

    private var attention: Attention {
        if isAway { return .away }
        return NSApp.isActive ? .attended : .background
    }

    /// Restart the loop only when the cadence actually changed, so the stream
    /// of activation notifications macOS emits does not become a stream of
    /// requests. Restarting ticks immediately, which is what makes coming back
    /// to the app repaint the roster rather than wait out a poll.
    private func applyAttention() {
        let next = attention.pollInterval
        guard next != cadence else { return }
        cadence = next
        pollTask?.cancel()
        pollTask = nil
        guard let interval = next else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.tick()
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }

    private func observeLifecycle() {
        let workspace = NSWorkspace.shared.notificationCenter
        // Activation changes only re-rate the poll; they never make this Mac away.
        observe(NSApplication.didBecomeActiveNotification, on: .default, away: nil)
        observe(NSApplication.didResignActiveNotification, on: .default, away: nil)
        observe(NSWorkspace.willSleepNotification, on: workspace, away: true)
        observe(NSWorkspace.screensDidSleepNotification, on: workspace, away: true)
        observe(NSWorkspace.didWakeNotification, on: workspace, away: false)
        observe(NSWorkspace.screensDidWakeNotification, on: workspace, away: false)
        // Locking the screen is neither an app nor a workspace notification.
        let distributed = DistributedNotificationCenter.default()
        observe(Notification.Name("com.apple.screenIsLocked"), on: distributed, away: true)
        observe(Notification.Name("com.apple.screenIsUnlocked"), on: distributed, away: false)
    }

    /// `away` is what this notification asserts about the machine, or `nil` when
    /// it asserts nothing and only the cadence needs re-reading.
    private func observe(_ name: Notification.Name, on center: NotificationCenter, away: Bool?) {
        let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if let away { self.isAway = away }
                self.applyAttention()
            }
        }
        lifecycleObservers.append(LifecycleObserver(center: center, token: token))
    }

    /// Your own status is the one nobody will tolerate lagging, so the surface
    /// that changed it re-reads rather than waiting for the next poll.
    func refreshNow() {
        Task { [weak self] in await self?.tick() }
    }

    /// Ask a colleague to open their room. There is nothing to join yet — that
    /// is the whole difference from calling somebody already in a meeting — so
    /// this asks, then watches the roster for their room going live and walks
    /// in by itself. A call nobody answers inside the ring's own life was not
    /// missed; they were not there.
    ///
    /// `slug` is the room `Peer.callPlan` chose for `.ask`; the caller has
    /// already handled every other plan.
    func call(_ peer: Peer, slug: String) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await api.callPeer(peerEmail: peer.email)
                pendingCall = (
                    email: peer.email.lowercased(),
                    slug: slug,
                    name: peer.shortName,
                    deadline: Date().addingTimeInterval(PeerPresenceCadence.ringLife)
                )
                onCallProgress?("Asking \(peer.shortName) to open their room…", .neutral)
                // Do not wait a whole poll to start looking.
                await tick()
            } catch {
                onCallProgress?((error as? StarlingsError)?.message ?? String(localized: "Couldn’t call them"), .danger)
            }
        }
    }

    /// Ask a colleague for their attention. A wave has no room to resolve and
    /// is intentionally best-effort: the other client's next roster poll may
    /// see it, or the 45-second row may simply expire.
    func wave(peerEmail: String) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await api.ring(peerEmail: peerEmail)
                let name = roster.peers.first(where: { $0.email.caseInsensitiveCompare(peerEmail) == .orderedSame })?.shortName ?? "them"
                onWaved?("Waved at \(name)")
            } catch {
                onWaveProgress?((error as? StarlingsError)?.message ?? String(localized: "Couldn’t wave at them"))
            }
        }
    }

    /// Their room went live, or it did not. Checked on the same poll that
    /// carries everything else, so a call costs no extra request.
    private func resolvePendingCall(_ next: PeerRoster) {
        guard let pending = pendingCall else { return }
        if let peer = next.peers.first(where: { $0.email.lowercased() == pending.email }),
           peer.status == .inMeeting {
            pendingCall = nil
            onCallProgress?("\(pending.name) opened their room", .neutral)
            onJoinRing?(pending.slug)
            return
        }
        guard Date() >= pending.deadline else { return }
        pendingCall = nil
        onCallProgress?("No answer from \(pending.name)", .neutral)
    }

    /// Answered or dismissed. Clearing locally as well as at the Worker keeps
    /// the banner from flashing back for one poll.
    func clearRing() async {
        try? await api.clearRing()
        announcedRing = nil
        RingNotices.withdraw()
        await tick()
    }

    private func tick() async {
        // Signed out is not an error state: publish nothing and stay cheap.
        // Sign-in is picked up on the next beat, which is why this loop is not
        // wired to the session store.
        guard (try? ownerSessionStore.load()) != nil else {
            if roster != .empty { publish(.empty) }
            if !unreadThreads.isEmpty { publishUnread([]) }
            return
        }
        if Date().timeIntervalSince(lastHeartbeat) >= PeerPresenceCadence.heartbeat {
            lastHeartbeat = Date()
            try? await api.heartbeat()
        }
        do {
            let next = try await api.peers()
            lastErrorMessage = nil
            setReachable(true)
            publish(next)
            resolvePendingCall(next)
            announceRingIfNeeded(next.liveRing, quiet: next.me?.intent == .focused)
            // Unread rides this loop but not its cadence. A roster has to look
            // live; a conversation list moves far less, and says so itself in
            // DirectMessageCadence. Reading it every beat made this watch cost
            // two requests where one was warranted.
            if Date().timeIntervalSince(lastThreadRead) >= DirectMessageCadence.threadListPoll {
                lastThreadRead = Date()
                await refreshUnread()
            }
        } catch {
            if !(error is CancellationError) { setReachable(false) }
            // Keep the last good roster on screen and republish it, so a
            // surface that has never had one can say why it is empty.
            // A call still times out while the roster cannot be read, so
            // "Asking…" never outlives the ring.
            resolvePendingCall(roster)
            if roster.peers.isEmpty {
                lastErrorMessage = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t load your team")
                publish(roster)
            }
        }
    }

    private func publish(_ next: PeerRoster) {
        roster = next
        // The roster is the only thing that knows whose picture changed, so it
        // is what tells the avatar store — every other surface asks by address.
        Task { await PersonAvatarStore.shared.remember(next.peers) }
        for observer in observers { observer(next) }
    }

    /// A failed read leaves the last known list alone: an unread dot that
    /// blinks off because one request timed out is worse than one that is a
    /// poll late.
    private func refreshUnread() async {
        // Taken before the request, so a message written while it is in
        // flight still counts as after this observation next time.
        let observedAt = Date()
        guard let threads = try? await api.threads() else { return }
        // Not suppressed for a conversation already open in a window — see
        // the note on `MessageNotices`.
        let planned = MessageNotices.plan(
            threads: threads,
            seen: seenMessageTimes,
            activeThreadID: nil,
            previousObservation: lastMessagesObservedAt,
            notifyOnAllChannelMessages: MessageNotificationPreferences.notifiesOnAllChannelMessages()
        )
        seenMessageTimes = planned.seen
        lastMessagesObservedAt = observedAt
        Task { await MessageNotices.deliver(planned.notices) }
        let unread = threads
            .filter(\.unread)
            .sorted { ($0.lastMessageAt ?? .distantPast) > ($1.lastMessageAt ?? .distantPast) }
        let channels = threads
            .filter { $0.kind.isChannel && $0.id != TeamThread.id }
            .sorted { ($0.lastMessageAt ?? .distantPast) > ($1.lastMessageAt ?? .distantPast) }
        let groups = threads
            .filter(\.isGroup)
            .sorted { ($0.lastMessageAt ?? .distantPast) > ($1.lastMessageAt ?? .distantPast) }
        // Notes to self belongs to the face in the self strip, not to a second
        // copy of that face in Conversations — see WorkLoungeView.
        let selfEmail = roster.me?.email
        let directs = threads
            .filter { $0.kind == .dm && !$0.isGroup && $0.peerEmail != selfEmail }
            .sorted { ($0.lastMessageAt ?? .distantPast) > ($1.lastMessageAt ?? .distantPast) }
        if channels != channelThreads {
            channelThreads = channels
            for observer in channelObservers { observer(channels) }
        }
        if groups != groupThreads {
            groupThreads = groups
            for observer in groupObservers { observer(groups) }
        }
        if directs != directThreads {
            directThreads = directs
            for observer in directObservers { observer(directs) }
        }
        guard !unreadAnswered || unread != unreadThreads else { return }
        publishUnread(unread)
    }

    private func publishUnread(_ next: [ThreadSummary]) {
        unreadThreads = next
        unreadAnswered = true
        for observer in unreadObservers { observer(next) }
    }

    /// `quiet` is read from the caller's *own* row in the roster that carried
    /// the ring, so the intent and the nudge are always the same snapshot —
    /// setting focused and being waved at in the same second cannot land on
    /// the wrong side of it.
    private func announceRingIfNeeded(_ ring: PeerRing?, quiet: Bool) {
        guard let ring else {
            if announcedRing != nil {
                announcedRing = nil
                RingNotices.withdraw()
            }
            return
        }
        let key = "\(ring.callerEmail)#\(Int(ring.createdAt.timeIntervalSince1970))"
        guard announcedRing != key else { return }
        announcedRing = key
        Task { await RingNotices.deliver(ring, quiet: quiet) }
    }
}
