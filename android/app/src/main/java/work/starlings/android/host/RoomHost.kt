package work.starlings.android.host

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import work.starlings.android.api.StarlingsApiError
import work.starlings.contracts.HostDevice
import work.starlings.contracts.HostMessageWire
import work.starlings.contracts.HostMessageWireType
import work.starlings.contracts.HostMutationResponseStatus
import work.starlings.contracts.LobbySnapshotResponseMeeting
import work.starlings.contracts.MeetingCategoryUpdate
import work.starlings.contracts.OwnerHostSessionResponse

enum class HostPhase {
    IDLE,
    STARTING,
    HOSTING,
    ENDING,

    /** The meeting is over and the host surface has nothing left to show. Not [IDLE], which is "not started yet". */
    ENDED,
    FAILED,
}

data class HostState(
    val phase: HostPhase = HostPhase.IDLE,
    /** Why the room did not open, in English (an error), when [phase] is [HostPhase.FAILED]. */
    val failure: String? = null,
    val room: String? = null,
    val meetingId: String? = null,
    /** This connection's LiveKit identity, the one `host.v1` names. */
    val ownIdentity: String? = null,
    /** This device holds the host: it publishes the microphone, renews the lease and transcribes. */
    val holdsHost: Boolean = false,
    /** When the room stops admitting unless a heartbeat lands first (epoch ms). */
    val leaseExpiresAtMs: Long? = null,
    /**
     * The lease ran out. Media outlives it, so the meeting is still on
     * screen, but nobody new can be let in and the surface must say so.
     */
    val leaseLapsed: Boolean = false,
    val transcribing: Boolean = false,
    /** A colleague's room, hosted on their offer: the way out is Leave, never End. */
    val colleaguesRoom: Boolean = false,
    /** The name of the device this one asked to host (Move host…), until it answers. */
    val pendingHostOffer: String? = null,
    /** What the last host move did, for the line under the call header. */
    val notice: HostNotice? = null,
) {
    /** In the call on another device's host: microphone hard off, no transcription. */
    val isCompanion: Boolean get() = phase == HostPhase.HOSTING && !holdsHost

    /** `/room/team` is nobody's room: the host's way out is Leave. */
    val isInternalRoom: Boolean get() = room == RoomHost.INTERNAL_ROOM

    /** The way out reads End (closes the room for everyone), else Leave, as `MobileCallView`. */
    val exitEndsMeeting: Boolean get() = holdsHost && !isInternalRoom && !colleaguesRoom

    /** `/room/team` only: there Leave drops nobody, so ending it for the people still in it is its own act. */
    val offersEndForEveryone: Boolean get() = phase == HostPhase.HOSTING && holdsHost && isInternalRoom

    /** Take host in More: any device in the call that does not hold the host may ask for it. */
    val offersTakeHost: Boolean get() = phase == HostPhase.HOSTING && !holdsHost
}

/** The host moves `MobileRoomHost` reports in the call: its `transcriptionStatus` and moderation failures. */
sealed interface HostNotice {
    /** Move host… sent: "Asked Ana to host…". */
    data class Asked(val name: String) : HostNotice

    /** The offer lapsed and this device still hosts. */
    data class NotTaken(val name: String) : HostNotice

    /** Take host sent; the host hands over first. */
    data object AwaitingHandOver : HostNotice
    data object MoveFailed : HostNotice
    data object TakeFailed : HostNotice
    data object HandOverFailed : HostNotice

    /** Meet about this could not file the room under its subject. */
    data object FilingFailed : HostNotice
}

/**
 * Hosting the owner's own room, as `iOS/MobileRoomHost.swift` (docs/IOS_HOST.md).
 *
 * - [start] opens or resumes the meeting (`POST /api/owner/host-session`),
 *   connects [media] and, when the Worker says this device holds the host,
 *   renews the 30-second lease at the Worker's own pacing.
 * - The lease renews only while [media] is [HostMediaState.Live]. Android
 *   has no grace period (invariant 6): an interruption lets the lease lapse,
 *   and a media failure stops renewing at once, so a host nobody can see or
 *   hear never keeps a room open to new guests.
 * - A device that arrives where the owner already hosts is a companion: the
 *   microphone stays off and it never transcribes.
 * - [end] closes the room on the Worker first, then tears down local media,
 *   then finalizes off the critical path.
 *
 * [scope] must outlive the host screen (the app owns it, as it owns
 * `CallSession`): finalization runs after the screen has gone.
 */
class RoomHost(
    private val api: HostApi,
    private val media: HostMedia,
    private val scope: CoroutineScope,
    private val device: HostDevice,
    /** A room other than the owner's own: the internal room, or a colleague's on their offer. Null is "my room". */
    private val requestedRoom: String? = null,
    /** This device accepted an offer to host a colleague's meeting: it arrives as a companion, then takes the host. */
    private var claimsHostOnJoin: Boolean = false,
    private val transcriber: HostTranscriber? = null,
    /**
     * Meet about this: the subject the room is started about, filed as soon
     * as the meeting exists, so it opens already filed. Best effort; a
     * refusal does not stop the room. Used once, so a reconnect does not
     * file again.
     */
    private var filing: MeetingCategoryUpdate? = null,
    /**
     * A meeting this device hosted in the owner's own room ended here: the
     * filing nudge (`UnfiledMeetingNotice`), read after the end call so a
     * filing made in the last seconds counts. Not for another room: a meeting
     * on `/room/team` is internal by definition.
     */
    private val onOwnMeetingEnded: (room: String, meetingId: String) -> Unit = { _, _ -> },
    private val clock: () -> Long = System::currentTimeMillis,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
    lobbyPollMs: Long = LobbyWatch.POLL_MS,
) {
    private val _state = MutableStateFlow(HostState())
    val state: StateFlow<HostState> = _state.asStateFlow()

    /** The waiting room. It polls while the host surface is open, admit and decline included. */
    val lobby = LobbyWatch(api, scope, sleep, lobbyPollMs).also { watch ->
        watch.onMeeting = { meeting -> reconcile(meeting) }
    }

    private var session: OwnerHostSessionResponse? = null
    private var renewMs = DEFAULT_RENEW_MS
    private var opening: Job? = null
    private var heartbeat: Job? = null
    private var mediaWatch: Job? = null
    private var recovering = false
    private var handOverRetryAfter: Long? = null
    private var lastVacantClaimAt: Long? = null
    private val colleaguesRoom = requestedRoom != null && requestedRoom != INTERNAL_ROOM

    private val _waitingRoomRequested = MutableStateFlow(false)

    /** A knock notification asked for the waiting room. The host surface opens it and calls [waitingRoomShown]. */
    val waitingRoomRequested: StateFlow<Boolean> = _waitingRoomRequested.asStateFlow()

    fun showWaitingRoom() {
        if (_state.value.phase == HostPhase.HOSTING) _waitingRoomRequested.value = true
    }

    fun waitingRoomShown() {
        _waitingRoomRequested.value = false
    }

    /** Opens the room, or resumes the open meeting: the Worker never starts a second one, so this is also the reconnect path. */
    fun start(): Job {
        opening?.takeIf { it.isActive }?.let { return it }
        return scope.launch { open() }.also { opening = it }
    }

    /** End for everyone, or Leave for a companion and on `/room/team` (where [everyone] ends it for all). */
    fun end(everyone: Boolean = false): Job = scope.launch { close(everyone) }

    /** The confirmed End: for everyone in a personal room by definition, and by request on `/room/team`. Nothing once the host has moved. */
    fun endForEveryone(): Job = scope.launch {
        val s = _state.value
        if (s.holdsHost) close(everyone = s.isInternalRoom)
    }

    /** Move host…: ask another device in the call to take the host. This device keeps it until that one answers. */
    fun offerHost(identity: String, name: String): Job = scope.launch {
        val s = _state.value
        val room = s.room ?: return@launch
        val meetingId = s.meetingId ?: return@launch
        if (s.phase != HostPhase.HOSTING || !s.holdsHost) return@launch
        try {
            api.offer(room, meetingId, identity)
            _state.update { it.copy(pendingHostOffer = name, notice = HostNotice.Asked(name)) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            note(HostNotice.MoveFailed)
        }
    }

    /** Take host: at once when it is vacant, else the host is asked to hand over and its `changed` makes this device the host. */
    fun takeHost(): Job = scope.launch { claimHost(ifVacant = false) }

    fun dismissNotice() {
        _state.update { it.copy(notice = null) }
    }

    /** True when the control plane took the decision. */
    fun admit(requestId: String, onBehalfOf: String? = null): Deferred<Boolean> = scope.async {
        _state.value.phase == HostPhase.HOSTING && lobby.admit(requestId, onBehalfOf)
    }

    fun deny(requestId: String): Deferred<Boolean> = scope.async {
        _state.value.phase == HostPhase.HOSTING && lobby.decline(requestId)
    }

    /** A `host.v1` message from the media session. */
    fun receive(message: HostMessageWire): Job = scope.launch { receiveHostMessage(message) }

    private suspend fun open() {
        val phase = _state.value.phase
        if (phase == HostPhase.HOSTING || phase == HostPhase.ENDING) return
        _state.value = HostState(phase = HostPhase.STARTING, colleaguesRoom = colleaguesRoom)
        try {
            val s = api.hostSession(device, requestedRoom)
            session = s
            renewMs = s.lease.renewAfterMs.coerceAtLeast(MIN_RENEW_MS)
            // A missing flag is a Worker from before the host existed: the starter hosts.
            val holds = s.connection.isHost ?: true
            _state.update {
                it.copy(
                    room = s.room.slug,
                    meetingId = s.connection.meetingId,
                    ownIdentity = s.connection.ownerIdentity ?: s.captions.publisherIdentity,
                    holdsHost = holds,
                    leaseExpiresAtMs = s.lease.hostLeaseExpiresAt,
                )
            }
            var filingFailed = false
            filing?.let { update ->
                filing = null
                try {
                    api.setCategory(s.room.slug, s.connection.meetingId, update)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    filingFailed = true
                }
            }
            media.connect(s.room.slug, s.connection, microphoneAllowed = holds)
            (media.hostState.value as? HostMediaState.Failed)?.let { throw MediaFailed(it.message) }
            if (holds) media.setHoldsHost(true, unmute = false)
            _state.update { it.copy(phase = HostPhase.HOSTING) }
            // Said once the call is up, as iOS: before it there is no screen to say it on.
            if (filingFailed) note(HostNotice.FilingFailed)
            watchMedia()
            if (holds) {
                beginHeartbeat()
                beginTranscription()
            } else if (claimsHostOnJoin) {
                claimsHostOnJoin = false
                claimHost(ifVacant = false)
            }
            lobby.start(s.room.slug)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            stopHosting()
            lobby.stop()
            _state.value = HostState(phase = HostPhase.FAILED, failure = describe(e))
        }
    }

    private suspend fun close(everyone: Boolean) {
        val before = _state.value.phase
        if (before != HostPhase.HOSTING && before != HostPhase.STARTING) return
        // Ending while the room opens: stop the opening where it stands, then end what exists.
        opening?.takeIf { it.isActive }?.let { it.cancel(); it.join() }
        // A colleague's room hosted on their offer: leave the host for a companion to take, and the meeting to its owner.
        if (before == HostPhase.HOSTING && _state.value.holdsHost && colleaguesRoom && !everyone) {
            if (!handOver()) return
            lobby.stop()
            stopHosting()
            session = null
            _state.value = HostState(phase = HostPhase.ENDED)
            return
        }
        lobby.stop()
        val s = _state.value
        val room = s.room
        val meetingId = s.meetingId
        if (!s.holdsHost || room == null || meetingId == null) {
            stopHosting()
            _state.value = HostState(phase = HostPhase.ENDED)
            return
        }
        _state.update { it.copy(phase = HostPhase.ENDING) }
        val transcribed = s.transcribing

        // 1. Guests drop now, not when this device has caught up.
        attempt { api.end(room, meetingId, everyone) }

        // 2. Local teardown: heartbeat, media, transcriber drain.
        stopHosting()

        // 3. The artifact, off the critical path: the screen does not wait for it.
        scope.launch {
            val queue = transcriber
            if (transcribed && queue != null) attempt { queue.requestFinalization(room, meetingId) }
            else attempt { api.finalize(room, meetingId) }
        }
        // 4. The filing nudge, also off the critical path.
        if (requestedRoom == null) onOwnMeetingEnded(room, meetingId)
        session = null
        _state.value = HostState(phase = HostPhase.ENDED)
    }

    private fun watchMedia() {
        mediaWatch?.cancel()
        mediaWatch = scope.launch {
            var live = media.hostState.value == HostMediaState.Live
            media.hostState.collect { m ->
                when (m) {
                    HostMediaState.Live -> if (!live) {
                        live = true
                        // Back from an interruption or a reconnect: renew now, not at the next tick.
                        beat()
                    }
                    is HostMediaState.Failed -> {
                        live = false
                        scope.launch { mediaDidFail(m.message) }
                    }
                    HostMediaState.Ended -> {
                        live = false
                        scope.launch { roomClosed() }
                    }
                    else -> live = false
                }
            }
        }
    }

    /**
     * LiveKit has exhausted its own reconnects. Stop renewing first, so the
     * room stops admitting within one lease window, then try once to resume
     * the same meeting. If that fails too the surface shows the failure.
     */
    private suspend fun mediaDidFail(message: String) {
        if (_state.value.phase != HostPhase.HOSTING || recovering) return
        recovering = true
        try {
            stopHosting()
            _state.update { it.copy(phase = HostPhase.IDLE) }
            open()
            if (_state.value.phase == HostPhase.FAILED && _state.value.failure == null) {
                _state.update { it.copy(failure = message) }
            }
        } finally {
            recovering = false
        }
    }

    /** The room closed under this device (ended elsewhere, removed): nothing to end, nothing to finalize here. */
    private suspend fun roomClosed() {
        if (_state.value.phase != HostPhase.HOSTING) return
        lobby.stop()
        stopHosting()
        session = null
        _state.value = HostState(phase = HostPhase.ENDED)
    }

    private suspend fun stopHosting() {
        heartbeat?.cancel()
        heartbeat = null
        mediaWatch?.cancel()
        mediaWatch = null
        if (_state.value.transcribing) attempt { transcriber?.drain() }
        _state.update { it.copy(holdsHost = false, leaseExpiresAtMs = null, transcribing = false) }
        attempt { media.disconnect() }
    }

    // Lease

    private fun beginHeartbeat() {
        heartbeat?.cancel()
        heartbeat = scope.launch {
            while (isActive) {
                sleep(renewMs)
                if (media.hostState.value == HostMediaState.Live) beat() else checkLapse()
            }
        }
    }

    /**
     * One renewal. A failed beat says nothing until the expiry the Worker
     * last granted has passed: a lift ride is not a lost room.
     */
    private suspend fun beat() {
        val s = _state.value
        val room = s.room ?: return
        val meetingId = s.meetingId ?: return
        if (!s.holdsHost || s.phase != HostPhase.HOSTING || media.hostState.value != HostMediaState.Live) return
        try {
            val lease = api.heartbeat(room, meetingId)
            if (!lease.ok) return checkLapse()
            renewMs = lease.renewAfterMs.coerceAtLeast(MIN_RENEW_MS)
            _state.update { it.copy(leaseExpiresAtMs = lease.hostLeaseExpiresAt, leaseLapsed = false) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            checkLapse()
        }
    }

    private fun checkLapse() {
        val expires = _state.value.leaseExpiresAtMs ?: return
        if (expires <= clock()) _state.update { it.copy(leaseLapsed = true) }
    }

    // Transcription: the host only

    private suspend fun beginTranscription() {
        val s = _state.value
        val queue = transcriber ?: return
        val room = s.room ?: return
        val meetingId = s.meetingId ?: return
        if (!s.holdsHost || s.transcribing) return
        attempt {
            queue.begin(room, meetingId, session?.connection?.startedAt ?: clock())
            _state.update { it.copy(transcribing = true) }
        }
    }

    // Host handover

    private suspend fun receiveHostMessage(message: HostMessageWire) {
        val s = _state.value
        val mine = s.ownIdentity ?: return
        if (s.phase != HostPhase.HOSTING) return
        when (message.type) {
            HostMessageWireType.RELEASE_REQUESTED -> if (message.hostIdentity == mine && s.holdsHost) handOver()
            HostMessageWireType.CHANGED -> {
                val host = message.hostIdentity
                when {
                    host == mine && !s.holdsHost -> becomeHost(null)
                    host != null && host != mine && s.holdsHost -> stopBeingHost()
                    host == null && !s.holdsHost -> claimHost(ifVacant = true)
                }
                if (host != null && host != mine) _state.update { it.copy(pendingHostOffer = null) }
            }
            // An offer reaches a hosting session only for another device of this member: take it.
            HostMessageWireType.OFFERED -> if (message.targetIdentity == mine && !s.holdsHost) claimHost(ifVacant = false)
        }
    }

    /** The lobby poll's view of who hosts, for when a `host.v1` message did not arrive. The same rules, throttled. */
    internal suspend fun reconcile(meeting: LobbySnapshotResponseMeeting?) {
        val s = _state.value
        val mine = s.ownIdentity ?: return
        if (s.phase != HostPhase.HOSTING || meeting == null || meeting.id != s.meetingId) return
        val host = meeting.hostIdentity
        val now = clock()
        when {
            host == mine && !s.holdsHost -> becomeHost(meeting.hostLeaseExpiresAt)
            host == mine && meeting.pendingHostIdentity != null && (handOverRetryAfter?.let { it <= now } ?: true) ->
                if (!handOver()) handOverRetryAfter = now + HAND_OVER_RETRY_MS
            host != mine && host != null && s.holdsHost -> stopBeingHost()
            !s.holdsHost && host != mine -> {
                val vacant = host == null || meeting.hostLeaseExpiresAt <= now
                if (vacant && (lastVacantClaimAt?.let { now - it >= VACANT_CLAIM_MS } ?: true)) {
                    lastVacantClaimAt = now
                    claimHost(ifVacant = true)
                }
            }
        }
        // The offer lapsed or was declined: say so while this device still hosts.
        val asked = _state.value.pendingHostOffer
        if (asked != null && meeting.hostOfferIdentity == null && meeting.pendingHostIdentity == null) {
            _state.update { it.copy(pendingHostOffer = null, notice = if (it.holdsHost) HostNotice.NotTaken(asked) else it.notice) }
        }
    }

    private suspend fun claimHost(ifVacant: Boolean) {
        val s = _state.value
        val room = s.room ?: return
        val meetingId = s.meetingId ?: return
        if (s.phase != HostPhase.HOSTING || s.holdsHost) return
        try {
            val result = api.claim(room, meetingId, device, ifVacant)
            if (result.status == HostMutationResponseStatus.HOST) becomeHost(result.hostLeaseExpiresAt)
            else if (!ifVacant) note(HostNotice.AwaitingHandOver)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // A vacant claim is the device's own housekeeping: only a person's Take host hears about a failure.
            if (!ifVacant) note(HostNotice.TakeFailed)
        }
    }

    private fun note(notice: HostNotice) {
        _state.update { it.copy(notice = notice) }
    }

    private suspend fun becomeHost(leaseExpiresAtMs: Long?) {
        val s = _state.value
        if (s.holdsHost || s.phase != HostPhase.HOSTING) return
        _state.update {
            it.copy(holdsHost = true, leaseLapsed = false, leaseExpiresAtMs = leaseExpiresAtMs ?: it.leaseExpiresAtMs, notice = null)
        }
        media.setHoldsHost(true, unmute = true)
        beginHeartbeat()
        beginTranscription()
    }

    /** Another device took the host without asking (this one had lost the call): stop the lease and the transcriber, stay in the call. */
    private suspend fun stopBeingHost() {
        heartbeat?.cancel()
        heartbeat = null
        if (_state.value.transcribing) attempt { transcriber?.drain() }
        _state.update { it.copy(holdsHost = false, transcribing = false) }
        media.setHoldsHost(false, unmute = false)
    }

    /**
     * Hand the host over: mute, drain the transcriber, upload its text, then
     * release. False, and still hosting, when the text is not up yet or the
     * Worker kept this device the host.
     */
    private suspend fun handOver(): Boolean {
        val s = _state.value
        val room = s.room ?: return false
        val meetingId = s.meetingId ?: return false
        if (!s.holdsHost) return false
        media.setHoldsHost(false, unmute = false)
        val queue = transcriber
        if (s.transcribing && queue != null) {
            queue.drain()
            _state.update { it.copy(transcribing = false) }
            if (!queue.flush(room, meetingId)) return resumeHosting()
        }
        return try {
            var result = api.release(room, meetingId)
            // `host`: the device that asked has left. Leaving, release again with no request, so a companion can take it.
            if (result.status == HostMutationResponseStatus.HOST && (_state.value.phase == HostPhase.ENDING || colleaguesRoom)) {
                result = api.release(room, meetingId)
            }
            if (result.status == HostMutationResponseStatus.HOST) return resumeHosting()
            heartbeat?.cancel()
            heartbeat = null
            _state.update { it.copy(holdsHost = false) }
            true
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            note(HostNotice.HandOverFailed)
            resumeHosting()
        }
    }

    private suspend fun resumeHosting(): Boolean {
        media.setHoldsHost(true, unmute = true)
        beginTranscription()
        return false
    }

    private class MediaFailed(message: String) : Exception(message)

    companion object {
        /** `MeetingInvite.internalRoomSlug`. */
        const val INTERNAL_ROOM = "team"

        /** The Worker's `HOST_HEARTBEAT_INTERVAL_MILLISECONDS`, until the session names its own. */
        const val DEFAULT_RENEW_MS = 10_000L
        const val MIN_RENEW_MS = 1_000L
        const val HAND_OVER_RETRY_MS = 30_000L
        const val VACANT_CLAIM_MS = 10_000L

        /**
         * The device name the Worker scopes the LiveKit identity with
         * (`hostDeviceSchema`): `android`, phone or tablet. A distinct name
         * plus the install id is what keeps it from evicting the owner's Mac
         * or iPhone; the host rules themselves are the lease and the claim.
         */
        @Suppress("UNUSED_PARAMETER")
        fun device(smallestWidthDp: Int): HostDevice = HostDevice.ANDROID

        internal inline fun attempt(block: () -> Unit) {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
        }

        internal fun describe(e: Exception): String = when (e) {
            is StarlingsApiError -> e.message ?: e.operation
            else -> e.message ?: e.javaClass.simpleName
        }
    }
}
