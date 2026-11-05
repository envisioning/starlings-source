package work.starlings.android.workspace.team

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import work.starlings.android.OwnerAccount
import work.starlings.android.api.StarlingsApiError
import work.starlings.android.api.TeamExtraRoutes
import work.starlings.android.api.TeamRoutes
import work.starlings.contracts.PeerWire
import java.time.ZoneId
import java.time.ZonedDateTime

/** A line Team shows in passing (iOS: a toast). */
sealed interface TeamNotice {
    data class Waved(val name: String) : TeamNotice
    data class Refused(val reason: CallRefusal, val name: String) : TeamNotice
    data class Failed(val message: String) : TeamNotice
}

/** The call notice row: asking, or nobody answered. */
sealed interface CallNotice {
    data class Asking(val name: String) : CallNotice
    data class NoAnswer(val name: String) : CallNotice
}

/** The English sentence a failed route is titled with (errors stay English, AGENTS.md). */
internal fun Throwable.teamMessage(): String = (this as? StarlingsApiError)?.sentence ?: (message ?: javaClass.simpleName)

/**
 * `iOS/MobileTeamStore.swift`: the roster, the conversation list and this
 * device's check-in. One per signed-in session, owned by the workspace
 * shell (`rememberTeamStore`), so the tab badge, Home and the message
 * banners follow it on every tab. [poll] runs while the app is started and
 * stops with it: presence published from a pocket is a lie. There is no
 * push, so polling is delivery.
 */
class TeamStore(internal val account: OwnerAccount) {
    var roster by mutableStateOf(PeerRoster.EMPTY)
        private set
    var threads by mutableStateOf(TeamThreads.EMPTY)
        private set
    var isLoading by mutableStateOf(false)
        private set
    /** Home waits for the first thread answer, an empty or failed one included, before it draws INBOX (`homeMessagesReady`). */
    var homeMessagesReady by mutableStateOf(false)
        private set
    /** Set only when the roster could not be read at all: a stale roster beats an empty screen. */
    var errorMessage by mutableStateOf<String?>(null)
        private set
    var callNotice by mutableStateOf<CallNotice?>(null)
        private set
    /** The clock a ring's liveness is read against, moved by each poll. */
    var nowMs by mutableStateOf(System.currentTimeMillis())
        private set

    /** Set by the screen: a toast, and the join flow for a room. */
    var onNotice: (TeamNotice) -> Unit = {}
    var onJoinRoom: (String) -> Unit = {}
    /** Set by the app-level session: the banners a poll decided (`MessageNotices`). */
    var onMessages: (List<MessageNotice>) -> Unit = {}
    /** Set by the app-level session: a ring to announce (`RingNotices`), and its withdrawal. */
    var onRing: (RingNotice) -> Unit = {}
    var onRingWithdrawn: () -> Unit = {}

    /** The ring last announced, so a poll announces each ring once. */
    private var announcedRing: String? = null

    /** Each thread's newest message as last seen, and when the list was last read: null until the first live poll. */
    private var seenMessageTimes: Map<String, Long> = emptyMap()
    private var lastThreadsObservedAt: Long? = null

    /** Team's unread conversations for the tab badge and Home; Work's subject channels are not Team's. */
    val unreadTeamCount: Int get() = threads.unread.count { !it.kind.isSubjectChannel }

    private data class PendingCall(val email: String, val slug: String, val name: String, val deadlineMs: Long)
    private var pendingCall: PendingCall? = null
    private var callGeneration = 0
    private var isSendingCall = false
    private var activeThreadId: String? = null
    private var lastThreads: List<work.starlings.contracts.ThreadSummaryWire> = emptyList()
    private var painted = false

    private val client get() = account.client

    /** Pictures and files: the byte half of the API. */
    val media = TeamMedia(account)

    val me: PeerWire? get() = roster.me
    val incomingRing get() = roster.liveRing(nowMs)

    /** Disk first: who is on the team, never who is around (docs/CACHING.md). */
    fun paintSnapshots() {
        if (painted) return
        painted = true
        if (roster.peers.isEmpty()) client.snapshot(TeamRoutes.peers)?.let { roster = PeerRoster.of(it.value).withoutPresence() }
        if (lastThreads.isEmpty()) client.snapshot(TeamRoutes.threads)?.let { sort(it.value.threads) }
    }

    /** Heartbeat each minute, roster each thirty seconds, conversations each minute. */
    suspend fun poll() {
        paintSnapshots()
        var beat = 0L
        var threadRead = 0L
        while (true) {
            val now = System.currentTimeMillis()
            if (now - beat >= TeamCadence.HEARTBEAT_MS) {
                beat = now
                checkIn()
            }
            refresh()
            if (now - threadRead >= TeamCadence.THREAD_LIST_POLL_MS) {
                threadRead = now
                refreshThreads()
            }
            delay(TeamCadence.ROSTER_POLL_MS)
        }
    }

    suspend fun refresh() {
        isLoading = roster.peers.isEmpty()
        try {
            roster = PeerRoster.of(client.call(TeamRoutes.peers))
            Faces.remember(roster.peers)
            errorMessage = null
            nowMs = System.currentTimeMillis()
            resolvePendingCall()
            announceRing()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            errorMessage = if (roster.peers.isEmpty()) e.teamMessage() else null
        }
        isLoading = false
    }

    suspend fun refreshThreads() {
        // Taken before the request, so a message written while it is in flight counts as after this observation next time.
        val observedAt = System.currentTimeMillis()
        val answer = try {
            client.call(TeamRoutes.threads)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            homeMessagesReady = true
            return
        }
        sort(answer.threads)
        val planned = MessageNotices.plan(answer.threads, seenMessageTimes, activeThreadId, lastThreadsObservedAt, work.starlings.android.DeviceSettings.allChannelMessages.value)
        seenMessageTimes = planned.seen
        lastThreadsObservedAt = observedAt
        onMessages(planned.notices)
    }

    private fun sort(list: List<work.starlings.contracts.ThreadSummaryWire>) {
        lastThreads = list
        threads = TeamThreads.of(list, activeThreadId)
        homeMessagesReady = true
    }

    /** Opening a conversation is reading it: its dot clears now, not on the next poll. */
    fun setActiveThread(threadId: String?, peerEmail: String?) {
        activeThreadId = threadId
        val kept = lastThreads.map { t ->
            val read = (threadId != null && t.id == threadId) || (peerEmail != null && t.peerEmail == peerEmail && !t.isGroup)
            if (read) t.copy(unread = false) else t
        }
        sort(kept)
    }

    /** A wave is quiet: no push, no promise it arrived. */
    suspend fun ring(peer: PeerWire) {
        try {
            client.call(TeamExtraRoutes.ring(peer.email))
            onNotice(TeamNotice.Waved(peer.shortName))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            onNotice(TeamNotice.Failed(e.teamMessage()))
        }
    }

    /** Every plan ends in a room, a request, or a line that says why not. */
    suspend fun call(peer: PeerWire) {
        val slug = when (val plan = peer.callPlan) {
            is CallPlan.Join -> { onJoinRoom(plan.slug); return }
            is CallPlan.Unavailable -> { onNotice(TeamNotice.Refused(plan.reason, peer.shortName)); return }
            is CallPlan.Ask -> plan.slug
        }
        if (pendingCall != null || isSendingCall) return
        isSendingCall = true
        callGeneration += 1
        val generation = callGeneration
        try {
            client.call(TeamExtraRoutes.call(peer.email))
            if (generation != callGeneration) return
            pendingCall = PendingCall(peer.email, slug, peer.shortName, System.currentTimeMillis() + TeamCadence.RING_LIFE_MS)
            callNotice = CallNotice.Asking(peer.shortName)
            refresh()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            onNotice(TeamNotice.Failed(e.teamMessage()))
        } finally {
            isSendingCall = false
        }
    }

    fun joinRoom(peer: PeerWire) {
        peer.joinRoomSlug?.let(onJoinRoom)
    }

    private fun resolvePendingCall() {
        val pending = pendingCall ?: return
        if (System.currentTimeMillis() >= pending.deadlineMs) {
            pendingCall = null
            callNotice = CallNotice.NoAnswer(pending.name)
            return
        }
        if (roster.peers.any { it.email == pending.email && it.presence == PeerStatus.IN_MEETING }) {
            pendingCall = null
            callNotice = null
            onJoinRoom(pending.slug)
        }
    }

    fun cancelCall() {
        callGeneration += 1
        pendingCall = null
        callNotice = null
    }

    /**
     * `answerCall` and `answerAgentAsk`: read again first, since a banner can
     * outlive its ask, then cleared. True when a ring of [kind] still stood,
     * and the caller opens your own room.
     */
    suspend fun answerRing(kind: work.starlings.contracts.RingKind): Boolean {
        refresh()
        if (incomingRing?.ringKind != kind) return false
        clearRing()
        return true
    }

    /**
     * Somebody asked for you while you were on another tab: a local
     * notification from any tab, as iOS `announceRing`. It announces a ring
     * the poll already read, so it fires only while the app runs.
     */
    private fun announceRing() {
        val planned = RingNotices.plan(roster.liveRing(nowMs), announcedRing) { work.starlings.android.workspace.home.roomLink(it) }
        announcedRing = planned.announced
        if (planned.announced == null) onRingWithdrawn()
        planned.notice?.let(onRing)
    }

    /** Answered or dismissed, here and at the Worker, so the banner does not flash back. */
    suspend fun clearRing() {
        roster = roster.copy(incomingRing = null)
        announcedRing = null
        onRingWithdrawn()
        try {
            client.call(TeamExtraRoutes.clearRing)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Best effort: the ring lapses by itself.
        }
        refresh()
    }

    /** The whole status answer in one choice, as the Mac's `PeerStatusOption` control. */
    suspend fun applyStatus(option: PeerStatusOption) {
        val resolved = option.resolve(ZonedDateTime.now())
        try {
            if (resolved.setsDnd) client.call(TeamRoutes.doNotDisturb(resolved.dndUntil))
            if (resolved.dndUntil == null && resolved.setsDnd) client.call(TeamRoutes.intent(resolved.intent, resolved.intentUntil))
            client.call(TeamExtraRoutes.appearOffline(option.invisible))
            errorMessage = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            errorMessage = e.teamMessage()
        }
        refresh()
    }

    /** Best effort by design: a dropped beat costs one status for one minute. */
    private suspend fun checkIn() {
        try {
            client.call(TeamRoutes.heartbeat(ZoneId.systemDefault().id))
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }
}
