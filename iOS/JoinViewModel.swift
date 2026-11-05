import Combine
import Foundation
import StarlingsContracts

@MainActor
final class JoinViewModel: ObservableObject {
    struct EndedSummary: Equatable {
        let roomSlug: String
        let duration: TimeInterval?
        /// Why the meeting ended, when this phone was not the one that left.
        /// Nil for an ordinary Leave — the screen already says that.
        var reason: String?
        /// A drop rather than an ending: the meeting may well still be running
        /// without this phone, so the screen reads as a failure.
        var isFailure = false
    }

    enum Surface: Equatable {
        case roomEntry
        case prejoin
        case waitingRoom
        case meeting
        case ended
    }

    @Published var surface: Surface = .roomEntry
    @Published var roomInput = ""
    @Published var name = UserDefaults.standard.string(forKey: "meet.guest.name") ?? ""
    @Published var email = UserDefaults.standard.string(forKey: "meet.guest.email") ?? ""
    @Published var waitingCount = 1
    @Published var status = ""
    @Published var errorMessage: String?
    @Published var ownerName: String?
    @Published var bookingCard: MobileBookingCard?
    @Published var isLoadingRoomContext = false
    @Published private(set) var isInternalRoom = false
    @Published private(set) var internalIdentity: MobileGuestIdentity?
    @Published var endedSummary: EndedSummary?
    /// Who asked this member to host the meeting they are a guest in.
    @Published var hostOfferFrom: String?

    let session = MobileGuestSession()
    private var room: MobileRoomPath?
    private var receipt: JoinRequestReceipt?
    private var admissionTask: Task<Void, Never>?
    private var roomContextTask: Task<Void, Never>?
    private var presenceTask: Task<Void, Never>?
    private var presenceRoom: MobileRoomPath?
    private var presenceID = ""
    /// Leaving a meeting returns to the room flow, but is not a new visit to
    /// the waiting room. The next explicit Continue starts presence again.
    private var guestPresenceSuppressed = false
    /// Kept from the first call that carries it: presence has to start and stop
    /// on screen transitions the views drive without an API in hand.
    private var api: StarlingsAPI?
    private var meetingStartedAt: Date?
    private var cancellables: Set<AnyCancellable> = []

    init() {
        // A meeting can end without this phone asking: the host ends the room,
        // the host removes this guest, or LiveKit gives up for good. Only the
        // session hears any of that, so the surface follows its phase —
        // otherwise MobileCallView sits over an empty stage until somebody
        // presses Leave.
        session.$phase
            .removeDuplicates()
            .sink { @Sendable [weak self] phase in
                Task { @MainActor in self?.meetingPhaseChanged(phase) }
            }
            .store(in: &cancellables)
    }

    deinit {
        admissionTask?.cancel()
        roomContextTask?.cancel()
        presenceTask?.cancel()
    }

    var parsedRoomInput: MobileRoomPath? { MobileRoomPath(input: roomInput) }

    func apply(input: String) {
        roomInput = input
        isInternalRoom = false
        internalIdentity = nil
        if surface == .roomEntry, let parsed = MobileRoomPath(input: input) {
            roomInput = parsed.canonicalURL
        }
    }

    /// Carried over from the first screen, which asks for the same three things
    /// the Mac's onboarding card does.
    func apply(identity: MobileGuestIdentity) {
        let normalized = identity.normalized
        if !normalized.name.isEmpty { name = normalized.name }
        if !normalized.email.isEmpty { email = normalized.email }
    }

    func roomInputChanged(api: StarlingsAPI, member: MobileOwnerCredentials? = nil) {
        self.api = api
        roomContextTask?.cancel()
        guard surface == .roomEntry, let parsed = parsedRoomInput else {
            ownerName = nil
            bookingCard = nil
            isInternalRoom = false
            internalIdentity = nil
            isLoadingRoomContext = false
            syncGuestPresence()
            return
        }
        syncGuestPresence()
        isLoadingRoomContext = true
        roomContextTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(300)) }
            catch { return }
            guard let self, !Task.isCancelled else { return }
            async let publicRoom = try? api.publicRoom(parsed, member: member)
            async let projection = api.bookingProjection(parsed)
            let (room, booking) = await (publicRoom, projection)
            guard !Task.isCancelled, self.parsedRoomInput == parsed else { return }
            ownerName = room?.ownerName
            isInternalRoom = room?.isInternal == true
            internalIdentity = room?.you.map { MobileGuestIdentity(name: $0.name, email: $0.email) }
            if let identity = internalIdentity { apply(identity: identity) }
            // An invite minted for one person names them; it wins over what
            // this phone remembers and stays editable.
            if let invited = booking?.invitedIdentity { apply(identity: invited) }
            bookingCard = booking?.card
            isLoadingRoomContext = false
        }
    }

    func continueToPrejoin() async {
        let identity = MobileGuestIdentity(name: name, email: email)
        guard let parsed = MobileRoomPath(input: roomInput) else {
            errorMessage = "Enter a valid room name or Starlings link."
            return
        }
        guard identity.isValid else {
            errorMessage = "Add your name and a valid email address."
            return
        }
        room = parsed
        guestPresenceSuppressed = false
        UserDefaults.standard.set(identity.normalized.name, forKey: "meet.guest.name")
        UserDefaults.standard.set(identity.normalized.email, forKey: "meet.guest.email")
        do {
            try await session.preparePreview()
            surface = .prejoin
        } catch {
            // Camera denial should not prevent an audio-only join.
            await session.toggleCamera()
            errorMessage = error.localizedDescription
            surface = .prejoin
        }
        syncGuestPresence()
    }

    func askToJoin(api: StarlingsAPI, member: MobileOwnerCredentials? = nil) {
        guard let room else { return }
        self.api = api
        admissionTask?.cancel()
        status = "Requesting admission…"
        surface = .waitingRoom
        // Hand the knock the row this phone has been heartbeating, so the owner
        // sees one visitor rather than a lurker beside a waiting guest.
        let presenceID = presenceRoom == room ? self.presenceID : nil
        stopGuestPresence()
        admissionTask = Task { [weak self] in
            guard let self else { return }
            do {
                let identity = MobileGuestIdentity(
                    name: name,
                    email: email
                )
                let receipt = try await api.requestJoin(
                    room: room,
                    identity: identity,
                    presenceID: presenceID,
                    member: member
                )
                self.receipt = receipt
                waitingCount = receipt.waitingCount
                status = waitingLabel
                while !Task.isCancelled {
                    let current = try await api.joinStatus(room: room, receipt: receipt)
                    waitingCount = current.waitingCount
                    status = waitingLabel
                    switch current.status {
                    case .admitted, .joined:
                        status = "Joining meeting…"
                        let details = try await api.exchangeAdmission(room: room, receipt: receipt)
                        session.onHostMessage = { [weak self] message in
                            guard let self, message.type == .offered,
                                  message.targetIdentity == self.session.ownIdentity else { return }
                            self.hostOfferFrom = message.fromName ?? String(localized: "Someone")
                        }
                        await session.connect(room: room.slug, details: details)
                        if session.phase == .connected {
                            meetingStartedAt = .now
                            surface = .meeting
                        } else if case .failed(let reason) = session.phase {
                            throw StarlingsError.local(reason)
                        }
                        return
                    case .rejected:
                        throw StarlingsError.local(String(localized: "The room owner declined this request."))
                    case .expired:
                        throw StarlingsError.local(String(localized: "The room is no longer available."))
                    default:
                        try await Task.sleep(for: .seconds(StarlingsPollingCadence.lobbyFallback))
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.localizedDescription
                surface = .prejoin
                status = ""
                // A knock refused because the owner is away is the common case.
                // Go back to heartbeating so this phone is still at the door
                // when they open the app.
                syncGuestPresence()
            }
        }
    }

    func cancelWaiting() {
        admissionTask?.cancel()
        admissionTask = nil
        receipt = nil
        status = ""
        surface = .prejoin
        syncGuestPresence()
    }

    /// Pre-knock presence while the guest is on the room-entry or prejoin
    /// screen, mirroring the browser join page's heartbeat.
    private func syncGuestPresence() {
        let wantsPresence = surface == .roomEntry || surface == .prejoin
        guard !guestPresenceSuppressed, wantsPresence, let api, let parsed = room ?? parsedRoomInput else {
            stopGuestPresence()
            return
        }
        // Same room, beat already running: only the stage changed, and the next
        // beat carries it. Restarting would orphan the row already on file.
        if presenceRoom == parsed, presenceTask != nil { return }
        stopGuestPresence()
        presenceRoom = parsed
        // Fresh id per room so two rooms in one sitting are two visitors.
        presenceID = UUID().uuidString.lowercased()
        let beatID = presenceID
        presenceTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.touchGuestPresence(api: api, room: parsed, presenceID: beatID)
                try? await Task.sleep(for: .seconds(PeerPresenceCadence.guestPresenceHeartbeat))
            }
        }
    }

    private func touchGuestPresence(api: StarlingsAPI, room: MobileRoomPath, presenceID: String) async {
        let stage: GuestPresenceStage = surface == .prejoin ? .preview : .visit
        let typed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try await api.touchGuestPresence(
                room: room,
                presenceID: presenceID,
                stage: stage,
                name: typed.isEmpty ? nil : typed
            )
        } catch {
            // Best-effort, like the browser's: the owner simply does not see
            // this phone until a later beat lands.
        }
    }

    private func stopGuestPresence() {
        presenceTask?.cancel()
        presenceTask = nil
        presenceRoom = nil
    }

    /// Answer an offer to host, signed in as this member. On yes, leave as a
    /// guest and answer the room's slug: the caller opens it as its host.
    func answerHostOffer(accept: Bool, credentials: MobileOwnerCredentials?) async -> String? {
        hostOfferFrom = nil
        guard let context = session.meetingContext, let api, let credentials else { return nil }
        do {
            _ = try await api.answerHostOffer(
                credentials: credentials,
                room: context.room,
                meetingID: context.meetingID,
                accept: accept
            )
        } catch {
            if accept { errorMessage = (error as? StarlingsError)?.message ?? error.localizedDescription }
            return nil
        }
        guard accept else { return nil }
        await leave()
        return context.room
    }

    func leave() async {
        guestPresenceSuppressed = true
        stopGuestPresence()
        finishMeeting(reason: nil, isFailure: false)
        await tearDownMeeting()
    }

    /// Only meaningful while the meeting is the surface: `leave()` has already
    /// closed the meeting out by the time its own disconnect reports `.ended`,
    /// and a failure during admission belongs to the waiting room's loop.
    private func meetingPhaseChanged(_ phase: MobileGuestSession.Phase) {
        guard surface == .meeting else { return }
        // A removal has already named who did it and why. That notice is the
        // whole reason this screen is about to appear, so it comes along
        // rather than being left behind on a stage nobody can see any more.
        let reason = session.moderationNotice?.text ?? session.endingReason
        switch phase {
        case .ended:
            finishMeeting(reason: reason, isFailure: false)
            Task { await tearDownMeeting() }
        case .failed(let message):
            finishMeeting(reason: reason ?? message, isFailure: true)
            Task { await tearDownMeeting() }
        case .idle, .connecting, .connected:
            break
        }
    }

    /// The summary and the surface move first, synchronously, so a second
    /// phase change arriving mid-teardown finds the meeting already closed out.
    private func finishMeeting(reason: String?, isFailure: Bool) {
        if let room {
            endedSummary = EndedSummary(
                roomSlug: room.slug,
                duration: meetingStartedAt.map { Date.now.timeIntervalSince($0) },
                reason: reason,
                isFailure: isFailure
            )
        }
        meetingStartedAt = nil
        surface = .ended
    }

    /// Idempotent. After a disconnect the room decided this is mostly already
    /// done, but it still clears the chat and captions a rejoin would inherit.
    private func tearDownMeeting() async {
        admissionTask?.cancel()
        admissionTask = nil
        stopGuestPresence()
        await session.disconnect()
    }

    /// Close the Home-owned room flow without leaving a presence row or a
    /// pending admission task behind. The full-screen cover calls this when
    /// the member chooses Close; visitor mode uses the same cleanup inline.
    func close() async {
        guestPresenceSuppressed = true
        admissionTask?.cancel()
        admissionTask = nil
        receipt = nil
        stopGuestPresence()
        await session.stopPreview()
        await session.disconnect()
        room = nil
        status = ""
        endedSummary = nil
        surface = .roomEntry
    }

    func backToRoom() async {
        receipt = nil
        if let room { roomInput = room.canonicalURL }
        room = nil
        status = ""
        endedSummary = nil
        surface = .roomEntry
        syncGuestPresence()
    }

    func startAnother() async {
        room = nil
        receipt = nil
        roomInput = ""
        status = ""
        ownerName = nil
        bookingCard = nil
        endedSummary = nil
        meetingStartedAt = nil
        surface = .roomEntry
        stopGuestPresence()
    }

    var waitingLabel: String {
        if waitingCount <= 1 { return "The room owner will admit you." }
        return "You’re in the waiting room with \(waitingCount - 1) other guest\(waitingCount == 2 ? "" : "s")."
    }
}
