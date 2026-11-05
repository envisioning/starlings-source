import Combine
import Foundation
import UIKit
import StarlingsContracts

/// Hosting the owner's own room from the phone.
///
/// The Mac has always been the host, and the control plane never required that:
/// the room, the lease, and every host control key on the Google `sub`, so a
/// verified owner hosts from whatever device they are holding. What the phone
/// does not inherit is the Mac's process lifecycle, which is why the two things
/// this object owns are the lease and the idle timer.
///
/// Captions and the artifact come from whichever device holds the host — this
/// phone included, when it hosts and no companion Mac is around
/// (docs/IOS_HOST.md).
@MainActor
final class MobileRoomHost: ObservableObject {
    enum Phase: Equatable {
        case idle
        case starting
        case hosting
        case ending
        /// The meeting is over and this screen has nothing left to show.
        /// Distinct from `.idle`, which means "not started yet" — sharing one
        /// case left the host watching an opening spinner after ending.
        case ended
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle {
        didSet {
            switch phase {
            case .starting, .hosting, .ending: MobileCallActivity.report(self, live: true)
            case .idle, .ended, .failed: MobileCallActivity.report(self, live: false)
            }
        }
    }
    /// When the room stops admitting guests unless a heartbeat lands first.
    @Published private(set) var leaseExpiresAt: Date?
    /// True once a heartbeat has failed for longer than the lease allows. The
    /// meeting is still on screen — media outlives the lease — but nobody new
    /// can be let in, so the surface has to say so rather than look healthy.
    @Published private(set) var leaseLapsed = false
    @Published private(set) var holdsHost = false
    @Published private(set) var room: String?
    @Published private(set) var meetingID: String?
    /// What the transcriber is doing, in the host's own words. Nil when this
    /// device is not transcribing, which is the normal case for a companion.
    @Published private(set) var transcriptionStatus: String?
    /// Tasks the meeting proposed and nobody has answered yet.
    @Published private(set) var proposedTasks: [TaskSuggestion] = []
    /// Why there are no suggestions, when that is worth saying — no model, an
    /// unsupported device, or the feature switched off.
    @Published private(set) var suggestionNote: String?
    /// Set when a segment could not be uploaded. The text is safe on this phone
    /// and retries on its own — the surface says so rather than implying loss.
    @Published private(set) var transcriptUploadPending = false

    /// Media is the same object a guest uses. The difference between hosting
    /// and joining is the credentials it connects with, not the pipeline.
    let media = MobileGuestSession()

    private let api: StarlingsAPI
    /// Readable so the participants panel can authorize moderation with the
    /// same owner session that started the meeting.
    private(set) var credentials: MobileOwnerCredentials?
    private var heartbeat: Task<Void, Never>?
    /// The same actor the Mac uses. Text only, crash-safe, idempotent by
    /// segment UUID — one queue so the artifact means the same thing whichever
    /// device hosted (docs/TRANSCRIPTION.md). The app's one instance, handed
    /// in: recovery drains the same object this host writes to.
    private let outbox: MeetingArtifactOutbox
    /// True from `beginTranscription` to `end`: whether this meeting's
    /// artifact goes through the outbox or straight to finalize.
    private var isTranscribing = false
    /// Proposes tasks from what people actually said. Local to this device
    /// until the owner accepts one; nothing here is written to Core on its own
    /// (docs/TASK_SUGGESTIONS.md).
    private var suggestions: TaskSuggestionEngine?
    /// True while `mediaDidFail` is tearing down and retrying, so a second
    /// failure report from the session cannot start a second recovery.
    private var isRecoveringMedia = false

    init(api: StarlingsAPI, outbox: MeetingArtifactOutbox) {
        self.api = api
        self.outbox = outbox
        // Media and the lease must not fail independently. LiveKit gives up
        // reconnecting → the session reports failure → without this, the
        // heartbeat kept renewing the lease and the lobby kept admitting
        // guests into a room whose host could not be seen or heard — while
        // this screen said "Waiting for someone to join".
        media.onMediaFailure = { [weak self] message in
            guard let self else { return }
            Task { await self.mediaDidFail(message) }
        }
    }

    /// This device's LiveKit identity suffix. Without it the phone would
    /// connect as the bare account address and evict the owner's Mac from its
    /// own meeting — LiveKit drops the older of two equal identities.
    static var device: EnvisioningIdentity.HostDevice {
        UIDevice.current.userInterfaceIdiom == .pad ? .ipad : .iphone
    }

    /// The subject this room is being started *about*, from Work. Filed
    /// through the same category write the filing sheet makes, as soon as the
    /// meeting exists — so the CRM row opens already filed. Best effort, like
    /// every CRM write: a refusal must not stop the room. Cleared once used,
    /// so a reconnect does not re-file.
    var filing: CrmSubject?

    /// Safe to call again: the Worker resumes the open meeting rather than
    /// starting a second one, so this doubles as the reconnect path.
    @Published private(set) var notesAreOffForCall = false
    var isWalkUp = false
    /// A room other than the owner's own — the internal room, from Team. Nil
    /// means "my room", which the Worker resolves from `OWNER_ROOM_MAP`.
    var requestedRoom: String?
    /// Set when this phone accepted an offer to host a colleague's meeting:
    /// it arrives as a companion and then takes the host.
    var claimsHostOnJoin = false
    /// The device this phone asked to host, and its name, until it answers.
    @Published private(set) var pendingHostOffer: String?
    private var activeHostSession: OwnerHostSessionResponse?

    func enableCallNotes() {
        guard holdsHost, let credentials, let session = activeHostSession, phase == .hosting else { return }
        isWalkUp = false
        notesAreOffForCall = false
        Task { await beginTranscription(credentials: credentials, session: session) }
    }

    func start(credentials: MobileOwnerCredentials) async {
        guard phase != .starting, phase != .hosting else { return }
        self.credentials = credentials
        phase = .starting
        leaseLapsed = false
        do {
            let session = try await api.ownerHostSession(
                credentials: credentials,
                device: Self.device,
                room: requestedRoom
            )
            activeHostSession = session
            holdsHost = session.connection.isHost ?? true
            room = session.room.slug
            meetingID = session.connection.meetingID
            leaseExpiresAt = session.lease.expiresAt
            var filingFailed = false
            if let filing {
                self.filing = nil
                do {
                    _ = try await api.setMeetingCategory(
                        credentials: credentials,
                        room: session.room.slug,
                        meetingID: session.connection.meetingID,
                        update: filing.meetingFiling
                    )
                } catch {
                    filingFailed = true
                }
            }
            media.onHostMessage = { [weak self] message in
                await self?.receiveHostMessage(message)
            }
            await media.connect(room: session.room.slug, details: session.connection)
            if case .failed(let message) = media.phase {
                throw StarlingsError.local(message)
            }
            if holdsHost { await media.setHoldsHost(true, unmute: false) }
            phase = .hosting
            // Said once the call screen is up: `media.connect` clears the
            // banner, so a notice raised before it would never be seen.
            if filingFailed {
                media.reportModerationFailure(String(localized: "Couldn’t file this meeting"))
            }
            // The screen going dark does not end a meeting, but the phone
            // locking itself mid-sentence looks exactly like a crash to the
            // people still in the room.
            UIApplication.shared.isIdleTimerDisabled = true
            if holdsHost {
                beginHeartbeat(every: session.lease.renewInterval)
                await beginTranscription(credentials: credentials, session: session)
            } else {
                transcriptionStatus = "Another device is taking the notes."
                if claimsHostOnJoin {
                    claimsHostOnJoin = false
                    await claimHost(ifVacant: false)
                }
            }
        } catch {
            await stopHosting()
            phase = .failed((error as? StarlingsError)?.message ?? error.localizedDescription)
        }
    }

    /// End for everyone.
    ///
    /// Order matters, and it is the Mac's order: **close the SFU first**, then
    /// tear down local media, then hand the artifact to the queue. Draining the
    /// transcriber before closing the room leaves every guest in a hostless
    /// meeting while this phone finishes recognizing the last sentence —
    /// seconds of on-device inference nobody else should wait through.
    ///
    /// Finalization does not block this call. The outbox is crash-safe and
    /// idempotent by segment UUID, so the upload finishes after the screen has
    /// gone, and whatever is still pending is retried by
    /// `StarlingsAppModel.retryPendingArtifacts` on the next launch or foreground.
    /// Clear the whole queue.
    ///
    /// Owner-only, checked server-side. A host who has just answered six people
    /// should not be lowering six hands one at a time, and a queue nobody can
    /// reset is a queue that stops meaning anything by the second meeting.
    /// Nothing is assumed locally: the hands come down when the room says they
    /// did, which is also what puts every raiser's own button back.
    func lowerAllHands() async {
        guard let credentials, let room, let meetingID else { return }
        do {
            try await api.lowerAllHands(credentials: credentials, room: room, meetingID: meetingID)
        } catch {
            // Reported through the media session's own notice, which is the
            // banner the call screen already watches — a host has no second
            // error surface, and inventing one for this would be a third place
            // to look when something goes wrong mid-meeting.
            media.reportModerationFailure(String(localized: "Couldn’t lower the hands."))
        }
    }

    /// `/room/team` is nobody's room: the host's way out is Leave, and the
    /// call stays up for the people still in it.
    var isInternalRoom: Bool { room == MeetingInvite.internalRoomSlug }

    /// A colleague's room, hosted on their offer: Leave, never End.
    var isHostingColleaguesRoom: Bool { requestedRoom != nil && !isInternalRoom }

    // MARK: Host handover

    private func receiveHostMessage(_ message: HostMessageWire) async {
        guard phase == .hosting, let mine = media.ownIdentity else { return }
        switch message.type {
        case .releaseRequested:
            guard message.hostIdentity == mine, holdsHost else { return }
            _ = await handOver()
        case .changed:
            if message.hostIdentity == mine, !holdsHost {
                await becomeHost()
            } else if let host = message.hostIdentity, host != mine, holdsHost {
                // Another device holds the host already: stop without a release.
                await stopBeingHost()
            } else if message.hostIdentity == nil, !holdsHost {
                await claimHost(ifVacant: true)
            }
            if message.hostIdentity != nil, message.hostIdentity != mine { pendingHostOffer = nil }
        case .offered:
            // An offer reaches a hosting session only for another device of
            // this member, or a member already let in: take it, no prompt.
            guard message.targetIdentity == mine, !holdsHost else { return }
            await claimHost(ifVacant: false)
        default:
            break
        }
    }

    /// Ask for the host. At once when it is vacant; otherwise the host is
    /// asked to hand over and its `changed` message makes this phone the host.
    func claimHost(ifVacant: Bool) async {
        guard let credentials, let room, let meetingID, phase == .hosting, !holdsHost else { return }
        do {
            let result = try await api.claimHost(
                credentials: credentials,
                room: room,
                meetingID: meetingID,
                device: Self.device,
                ifVacant: ifVacant
            )
            if result.status == .host {
                await becomeHost()
            } else if !ifVacant {
                transcriptionStatus = String(localized: "Waiting for the host to hand over…")
            }
        } catch {
            guard !ifVacant else { return }
            media.reportModerationFailure(String(localized: "Couldn’t take host"))
        }
    }

    private func becomeHost() async {
        guard !holdsHost, let credentials, let session = activeHostSession, phase == .hosting else { return }
        holdsHost = true
        await media.setHoldsHost(true)
        beginHeartbeat(every: session.lease.renewInterval)
        transcriptionStatus = nil
        await beginTranscription(credentials: credentials, session: session)
    }

    /// Another device took the host without asking this phone (it had lost
    /// the call): stop the lease and the transcriber, stay in the call.
    private func stopBeingHost() async {
        holdsHost = false
        heartbeat?.cancel()
        heartbeat = nil
        isTranscribing = false
        await media.setHoldsHost(false)
        transcriptionStatus = "Another device is taking the notes."
    }

    /// Hand the host over: mute, drain the transcriber, upload its text, then
    /// release. Answers false, and keeps hosting, when the text is not up yet
    /// or the Worker kept this phone the host.
    @discardableResult
    func handOver() async -> Bool {
        guard holdsHost, let credentials, let room, let meetingID, let session = activeHostSession else { return false }
        await media.setHoldsHost(false)
        isTranscribing = false
        let delivery = await outbox.flush(room: room, meetingID: meetingID)
        guard delivery.uploaded else {
            await resumeHosting(credentials: credentials, session: session)
            media.reportModerationFailure(String(localized: "Starlings kept this iPhone as host because its transcript has not reached the room yet."))
            return false
        }
        do {
            var result = try await api.releaseHost(credentials: credentials, room: room, meetingID: meetingID)
            // `host`: the device that asked has left. Leaving, release again
            // with no request, so a companion can take it.
            if result.status == .host, phase == .ending || isHostingColleaguesRoom {
                result = try await api.releaseHost(credentials: credentials, room: room, meetingID: meetingID)
            }
            if result.status == .host {
                await resumeHosting(credentials: credentials, session: session)
                return false
            }
            holdsHost = false
            heartbeat?.cancel()
            heartbeat = nil
            transcriptionStatus = "Another device is taking the notes."
            return true
        } catch {
            await resumeHosting(credentials: credentials, session: session)
            media.reportModerationFailure(String(localized: "Couldn’t hand over host"))
            return false
        }
    }

    private func resumeHosting(credentials: MobileOwnerCredentials, session: OwnerHostSessionResponse) async {
        await media.setHoldsHost(true)
        await beginTranscription(credentials: credentials, session: session)
    }

    private var handOverRetryAfter: Date?
    private var lastVacantClaimAt: Date?

    /// The lobby poll's view of who hosts, for when a `host.v1` message did
    /// not arrive. The same rules as the messages, throttled.
    func reconcile(_ meeting: LobbySnapshotResponseMeeting?) async {
        guard phase == .hosting, let meeting, meeting.id == meetingID, let mine = media.ownIdentity else { return }
        let host = meeting.hostIdentity
        if host == mine {
            if !holdsHost {
                await becomeHost()
            } else if meeting.pendingHostIdentity != nil, handOverRetryAfter.map({ $0 <= Date() }) ?? true {
                if !(await handOver()) { handOverRetryAfter = Date().addingTimeInterval(30) }
            }
        } else if holdsHost, host != nil {
            await stopBeingHost()
        } else if !holdsHost {
            let lapsed = Double(meeting.hostLeaseExpiresAt) <= Date().timeIntervalSince1970 * 1_000
            if host == nil || lapsed, lastVacantClaimAt.map({ Date().timeIntervalSince($0) >= 10 }) ?? true {
                lastVacantClaimAt = Date()
                await claimHost(ifVacant: true)
            }
        }
        if let name = pendingHostOffer, meeting.hostOfferIdentity == nil, meeting.pendingHostIdentity == nil {
            pendingHostOffer = nil
            if holdsHost { transcriptionStatus = String(localized: "\(name) didn’t take host.") }
        }
    }

    /// Hand the host to another device in the call (Move host…).
    func offerHost(to identity: String, name: String) async {
        guard holdsHost, let credentials, let room, let meetingID else { return }
        do {
            _ = try await api.offerHost(credentials: credentials, room: room, meetingID: meetingID, targetIdentity: identity)
            pendingHostOffer = name
            transcriptionStatus = String(localized: "Asked \(name) to host…")
        } catch {
            media.reportModerationFailure(String(localized: "Couldn’t move host"))
        }
    }

    /// End the host's part. On a personal room that closes the room for
    /// everyone; on `/room/team` only `everyone` does.
    func end(everyone: Bool = false) async {
        guard phase == .hosting || phase == .starting else { return }
        if !holdsHost {
            await stopHosting()
            phase = .ended
            return
        }
        // A colleague's room hosted on their offer: leave the host for a
        // companion to take, and the meeting to its owner.
        if isHostingColleaguesRoom, !everyone {
            guard await handOver() else { return }
            await stopHosting()
            phase = .ended
            return
        }
        phase = .ending
        let credentials = self.credentials
        let room = self.room
        let meetingID = self.meetingID
        let outbox = self.outbox
        let transcribed = self.isTranscribing

        // 1. Guests drop now, not when this device has caught up.
        if let credentials, let room, let meetingID {
            try? await api.endHostedMeeting(credentials: credentials, room: room, meetingID: meetingID, everyone: everyone)
        }

        // 2. Local teardown: heartbeat, idle timer, media, transcriber drain.
        await stopHosting()

        // 3. The artifact, off the critical path.
        if let credentials, let room, let meetingID {
            let api = self.api
            if transcribed {
                Task.detached {
                    _ = await outbox.requestFinalization(room: room, meetingID: meetingID)
                }
            } else {
                Task.detached {
                    try? await api.finalizeHostedMeeting(
                        credentials: credentials,
                        room: room,
                        meetingID: meetingID
                    )
                }
            }
        }

        // 4. The filing nudge, also off the critical path. Read after the end
        //    call so a filing made in the last seconds counts. Not for the
        //    internal room: a meeting there is internal by definition, and the
        //    Worker does not file it as such on its own.
        if requestedRoom == nil, let credentials, let room, let meetingID {
            let api = self.api
            Task.detached {
                await UnfiledMeetingNotice.deliverIfUnfiled(
                    api: api,
                    credentials: credentials,
                    room: room,
                    meetingID: meetingID
                )
            }
        }

        isTranscribing = false
        self.room = nil
        self.meetingID = nil
        phase = .ended
    }

    /// The host transcribes; a companion does not. Two devices of one person
    /// listening to the same room would put every sentence in the artifact
    /// twice, in two voices, and burn a phone battery doing it.
    ///
    /// A phone with no models on disk hosts perfectly well and simply produces
    /// no notes — downloading half a gigabyte over cellular because somebody
    /// started a meeting is not a decision this code gets to make. Settings
    /// owns that choice.
    private func beginTranscription(credentials: MobileOwnerCredentials, session: OwnerHostSessionResponse) async {
        guard !isWalkUp else {
            notesAreOffForCall = true
            transcriptionStatus = "Notes are off for this call."
            return
        }
        guard !media.isCompanion else {
            transcriptionStatus = "Your other device is taking the notes."
            return
        }
        guard LocalTranscriptionModel.status() == .ready else {
            transcriptionStatus = "No notes: the speech model is not downloaded (Settings › Transcription)."
            return
        }
        isTranscribing = true
        let outbox = self.outbox
        let room = session.room.slug
        let meetingID = session.connection.meetingID
        media.onTranscriptionStatus = { [weak self] status in
            self?.transcriptionStatus = status
        }
        let engine = beginSuggestions(room: room, meetingID: meetingID, credentials: credentials)
        // The team's names, spelled Core's way, for the name pass.
        // Best effort: without them the pass still has the room's roster.
        Task { [api, media, engine] in
            guard let roster = try? await api.peers(credentials: credentials) else { return }
            let names = roster.peers.compactMap(\.name)
            media.knownNames = names
            await engine?.setKnownNames(names)
        }
        media.onTranscriptSegment = { [weak self] segment in
            let delivery = await outbox.enqueue(segment, room: room, meetingID: meetingID)
            // Pending means the Worker lacks text this phone has — not, as
            // before, that the meeting is still open.
            self?.transcriptUploadPending = delivery.isUploadPending
            // Suggestions ride behind the upload deliberately: the artifact is
            // the promise, and inference must never delay it.
            guard let engine else { return }
            let fresh = await engine.ingest(segment)
            guard !fresh.isEmpty else { return }
            self?.proposedTasks.append(contentsOf: fresh)
        }
        media.beginTranscription(
            meetingID: meetingID,
            owner: credentials.owner,
            startedAt: session.connection.startedDate
        )
    }

    /// Nil whenever suggestions cannot run — the feature is off, the device has
    /// no on-device model, or the OS is too old. The note explains which, once,
    /// rather than leaving an empty panel to be read as "nothing was said".
    private func beginSuggestions(
        room: String,
        meetingID: String,
        credentials: MobileOwnerCredentials
    ) -> TaskSuggestionEngine? {
        // The host's own API client, so a phone pointed at a development
        // server proposes against that server rather than production.
        let api = self.api
        let resolution = TaskSuggestionEngineFactory.resolve { [weak self] in
            MobileWorkerTaskExtractor(
                api: api,
                credentials: credentials,
                room: room,
                meetingID: meetingID
            ) { note in
                Task { @MainActor in
                    self?.suggestionNote = note
                }
            }
        }
        suggestionNote = resolution.note
        guard let extractor = resolution.extractor else { return nil }
        let engine = TaskSuggestionEngine(meetingID: meetingID, extractor: extractor)
        suggestions = engine
        return engine
    }

    /// Accepting is the only thing that writes to Core, and it writes through
    /// the same path a hand-typed task takes. The quote travels with it as
    /// provenance, so a task can always be traced back to what was said.
    /// What the accept sheet needs before it can file: somewhere to put the
    /// task, who it can be assigned to, and which member the host is.
    ///
    /// Core requires every task to be filed to exactly one project, lead or partner, and
    /// the Worker's schema says so too — the old subject-less accept below was
    /// refused on every try, which made the Accept button a 400 wearing a
    /// checkmark.
    struct TaskFilingOptions {
        let subjects: [CrmSubject]
        let team: [CrmTeamMember]
        /// The signed-in member's id, for the "yours until you hand it off"
        /// assignee default.
        let selfID: String?

        static let none = TaskFilingOptions(subjects: [], team: [], selfID: nil)
    }

    func taskFilingOptions() async -> TaskFilingOptions {
        guard let credentials else { return .none }
        async let projectPage = api.crmSubjectPage(credentials: credentials, kind: .project, query: "")
        async let leadPage = api.crmSubjectPage(credentials: credentials, kind: .lead, query: "")
        async let partnerPage = api.crmSubjectPage(credentials: credentials, kind: .organization, query: "")
        async let roster = api.crmTeam(credentials: credentials)
        let subjects = ((try? await projectPage)?.subjects ?? []) + ((try? await leadPage)?.subjects ?? [])
            + ((try? await partnerPage)?.subjects ?? [])
        let team = (try? await roster) ?? []
        let email = credentials.owner.email.lowercased()
        return TaskFilingOptions(
            subjects: subjects,
            team: team,
            selfID: team.first { $0.email?.lowercased() == email }?.id
        )
    }

    func acceptTask(
        _ suggestion: TaskSuggestion,
        title: String,
        notes: String?,
        subject: CrmSubject,
        assignedTo: String?
    ) async {
        guard let credentials else { return }
        do {
            let task = try await api.createCrmTask(
                credentials: credentials,
                CrmTaskCreate(
                    title: title,
                    notes: notes ?? suggestion.provenanceNote,
                    status: nil,
                    responsibleParty: suggestion.responsibleGuess.rawValue,
                    assignedTo: .ifSome(assignedTo),
                    projectID: subject.kind == "project" ? subject.id : nil,
                    leadID: subject.kind == "lead" ? subject.id : nil,
                    organizationID: subject.isPartner ? subject.id : nil,
                    // Work the meeting produced, said so — the same mark the
                    // Mac puts on an accepted suggestion.
                    meetingID: meetingID,
                    source: "suggestion"
                )
            )
            await suggestions?.markAccepted(id: suggestion.id, crmTaskID: task.id)
            proposedTasks.removeAll { $0.id == suggestion.id }
        } catch {
            transcriptionStatus = (error as? StarlingsError)?.message ?? error.localizedDescription
        }
    }

    /// Dismissing is local and final for this meeting: the engine remembers, so
    /// the same sentence does not propose the same task again.
    func dismissTask(_ suggestion: TaskSuggestion) async {
        await suggestions?.markDismissed(id: suggestion.id)
        proposedTasks.removeAll { $0.id == suggestion.id }
    }

    /// LiveKit has exhausted its own reconnects mid-meeting. Stop renewing the
    /// lease first — a room whose host has no media must stop admitting within
    /// one lease window — then drain the transcriber, then try once to resume:
    /// `start` reopens the same meeting on the Worker, so a successful pass
    /// reconnects this device to the room the guests are still in. If that
    /// attempt fails too, the screen shows the failure instead of a healthy
    /// stage, and the lease lapses the way it would after a crash.
    private func mediaDidFail(_ message: String) async {
        guard phase == .hosting, !isRecoveringMedia else { return }
        isRecoveringMedia = true
        defer { isRecoveringMedia = false }
        // `stopHosting` cancels the heartbeat and disconnects media, which
        // drains and finalizes the local transcript queue — the segments
        // already recognized must not be lost to a dropped connection.
        await stopHosting()
        guard let credentials else {
            phase = .failed(message)
            return
        }
        // `.idle` so the cover shows the opening spinner, not a failure card,
        // for the beat the retry takes.
        phase = .idle
        await start(credentials: credentials)
    }

    private func stopHosting() async {
        heartbeat?.cancel()
        heartbeat = nil
        suggestions = nil
        proposedTasks = []
        leaseExpiresAt = nil
        holdsHost = false
        UIApplication.shared.isIdleTimerDisabled = false
        await media.disconnect()
    }

    /// One beat per interval the Worker asked for, and a beat that fails is
    /// retried on the next tick rather than abandoning the room: a phone loses
    /// the network for a few seconds all the time, and the lease survives a
    /// couple of missed beats. Only running past the expiry the Worker last
    /// granted means admission has actually stopped.
    private func beginHeartbeat(every interval: TimeInterval) {
        heartbeat?.cancel()
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                if Task.isCancelled { return }
                guard let self else { return }
                await self.beat()
            }
        }
    }

    private func beat() async {
        guard holdsHost, let credentials, let room, let meetingID, phase == .hosting else { return }
        do {
            let lease = try await api.hostHeartbeat(credentials: credentials, room: room, meetingID: meetingID)
            leaseExpiresAt = lease.expiresAt
            leaseLapsed = false
        } catch {
            // Say nothing until the promise the Worker made has actually run
            // out. Alarming on the first missed beat would make a lift ride
            // look like a lost room.
            if let leaseExpiresAt, leaseExpiresAt < Date() { leaseLapsed = true }
        }
    }
}
