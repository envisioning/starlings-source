package work.starlings.android.workspace.team

import work.starlings.contracts.IncomingRing
import work.starlings.contracts.PeerClientValue
import work.starlings.contracts.PeerIntent
import work.starlings.contracts.PeerKindValue
import work.starlings.contracts.PeerStatusValue
import work.starlings.contracts.PeerWire
import work.starlings.contracts.PeerWorkingHours
import work.starlings.contracts.PeersResponse
import work.starlings.contracts.RingKind
import work.starlings.contracts.ThreadKind
import work.starlings.contracts.ThreadPeer
import work.starlings.contracts.ThreadSummaryWire
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime

/*
 * Team presence and conversation addressing, from `Sources/PeerPresence.swift`
 * and `Sources/DirectMessages.swift`. Pure: no Android type, so the JVM tests
 * hold it. The words are the screen's (string resources); this file answers
 * which sentence and with which values.
 */

/** `PeerStatus`: the server's one status. An unknown value reads as offline. */
enum class PeerStatus(val wire: String) {
    DND("dnd"), IN_MEETING("in_meeting"), BUSY("busy"), AVAILABLE("available"), ACTIVE("active"), OFFLINE("offline");

    /** Only a live host lease can answer a knock, so `active` does not count. */
    val isReachable: Boolean get() = this == IN_MEETING || this == AVAILABLE

    companion object {
        fun of(value: PeerStatusValue): PeerStatus = entries.firstOrNull { it.wire == value.value } ?: OFFLINE
    }
}

/** `PeerDisplayState`: the evidence, or what they said about themselves. */
sealed interface PeerDisplay {
    val dot: PeerStatus

    data class Status(val status: PeerStatus) : PeerDisplay {
        override val dot get() = status
    }

    data class Intent(val intent: PeerIntent) : PeerDisplay {
        /** `dotEquivalent`: focused draws the busy dot, anything else the available one. */
        override val dot get() = if (intent == PeerIntent.FOCUSED) PeerStatus.BUSY else PeerStatus.AVAILABLE
    }
}

val PeerWire.presence: PeerStatus get() = PeerStatus.of(status)

/** An unfamiliar kind reads as a person. */
val PeerWire.isAgent: Boolean get() = kind == PeerKindValue.AGENT

/** An intent this build has not heard of decodes as none. */
val PeerWire.knownIntent: PeerIntent? get() = intent?.takeIf { it in PeerIntent.known }

val PeerWire.displayName: String
    get() = name?.takeIf { it.isNotBlank() } ?: email.substringBefore('@')

val PeerWire.shortName: String
    get() = displayName.split(' ').firstOrNull { it.isNotEmpty() } ?: displayName

/** `Peer.displayState`: dnd, a meeting and offline outrank intent; elsewhere intent wins. */
val PeerWire.displayState: PeerDisplay
    get() {
        val s = presence
        if (isAgent) return PeerDisplay.Status(s)
        if (invisible) return PeerDisplay.Status(PeerStatus.OFFLINE)
        return when (s) {
            PeerStatus.DND, PeerStatus.IN_MEETING, PeerStatus.OFFLINE -> PeerDisplay.Status(s)
            PeerStatus.BUSY, PeerStatus.AVAILABLE, PeerStatus.ACTIVE -> knownIntent?.let { PeerDisplay.Intent(it) } ?: PeerDisplay.Status(s)
        }
    }

val PeerWire.isCallable: Boolean get() = roomSlug != null && presence.isReachable && !isSelf && !isAgent

/** The room Join room opens: the one they stand in, else their own. Nil unless in a meeting. */
val PeerWire.joinRoomSlug: String? get() = if (presence == PeerStatus.IN_MEETING) inRoomSlug ?: roomSlug else null

/** A nudge needs somebody at a screen; never somebody who asked not to be disturbed. */
val PeerWire.isRingable: Boolean
    get() = !isSelf && !isAgent && presence != PeerStatus.OFFLINE && presence != PeerStatus.DND

/** `PeerCallPlan`: every Call ends in a room, a request, or a sentence that says why not. */
sealed interface CallPlan {
    data class Join(val slug: String) : CallPlan
    data class Ask(val slug: String) : CallPlan
    data class Unavailable(val reason: CallRefusal) : CallPlan
}

enum class CallRefusal { SELF, AGENT, NO_ROOM, NOT_REACHABLE }

val PeerWire.callPlan: CallPlan
    get() {
        if (isSelf) return CallPlan.Unavailable(CallRefusal.SELF)
        if (isAgent) return CallPlan.Unavailable(CallRefusal.AGENT)
        joinRoomSlug?.let { return CallPlan.Join(it) }
        val slug = roomSlug ?: return CallPlan.Unavailable(CallRefusal.NO_ROOM)
        if (!presence.isReachable) return CallPlan.Unavailable(CallRefusal.NOT_REACHABLE)
        return CallPlan.Ask(slug)
    }

/** One device in `devicesLine`: its client id (`mac`, `ios`, `web`) and the version it reported. */
data class PeerDevice(val client: String, val version: String?)

/** Every known device, in roster order; an unknown client name is dropped. */
val PeerWire.devices: List<PeerDevice>
    get() = clients.filter { it in PeerClientValue.known }.map { c ->
        val v = when (c) {
            PeerClientValue.MAC -> clientVersions?.mac
            PeerClientValue.IOS -> clientVersions?.ios
            PeerClientValue.WEB -> clientVersions?.web
            else -> null
        }
        PeerDevice(c.value, v)
    }

/**
 * `PeerWorkingHours.contains`: minutes from local midnight; `days` bit 0 is
 * Monday. A shift that ends before it starts crosses midnight.
 */
fun PeerWorkingHours.contains(minuteOfDay: Int, isoDayOfWeek: Int): Boolean {
    val bit = 1L shl (isoDayOfWeek - 1)
    if (days and bit == 0L) return false
    return if (endMinute >= startMinute) minuteOfDay >= startMinute && minuteOfDay < endMinute
    else minuteOfDay >= startMinute || minuteOfDay < endMinute
}

/** Their zone, or null when unknown or unreadable. */
val PeerWire.zone: ZoneId? get() = timezone?.let { runCatching { ZoneId.of(it) }.getOrNull() }

/** Null is undecidable (they never said), which a surface reports as silence. */
fun PeerWire.isWithinWorkingHours(now: Instant): Boolean? {
    val hours = workingHours ?: return null
    val at = ZonedDateTime.ofInstant(now, zone ?: return null)
    return hours.contains(at.hour * 60 + at.minute, at.dayOfWeek.value)
}

/** The same person with nothing time-bound: what a snapshot may paint (docs/CACHING.md). */
fun PeerWire.withoutPresence(): PeerWire = copy(
    favoriteRef = null, status = PeerStatusValue.OFFLINE, agentState = null, inRoomSlug = null, since = null,
    lastSeenAt = 0, lastClient = null, clients = emptyList(), clientVersions = null, busyUntil = null,
    dndUntil = null, intent = null, intentUntil = null, participants = 0, activity = null,
)

/** `teamPeerSubtitle`: which line a roster row says, and with what. Times are epoch ms. */
sealed interface PeerLine {
    /** An agent: "Working…" while a runtime accepted a hand-off, else nothing. */
    data class Agent(val working: Boolean) : PeerLine
    data class Intent(val intent: PeerIntent, val devices: List<PeerDevice>) : PeerLine
    data class FocusedUntil(val untilMs: Long) : PeerLine
    data class Unavailable(val untilMs: Long?) : PeerLine
    data class InMeeting(val participants: Long, val devices: List<PeerDevice>) : PeerLine
    data class Busy(val untilMs: Long?, val devices: List<PeerDevice>) : PeerLine
    data class Available(val slug: String?, val devices: List<PeerDevice>) : PeerLine
    data class Active(val devices: List<PeerDevice>) : PeerLine
    data class Offline(val lastSeenMs: Long?) : PeerLine
}

fun PeerWire.line(showsDevices: Boolean = true): PeerLine {
    if (isAgent) return PeerLine.Agent(presence == PeerStatus.BUSY)
    val d = if (showsDevices) devices else emptyList()
    val shown = displayState
    if (shown is PeerDisplay.Intent) {
        val until = intentUntil
        return if (shown.intent == PeerIntent.FOCUSED && until != null) PeerLine.FocusedUntil(until) else PeerLine.Intent(shown.intent, d)
    }
    return when (presence) {
        PeerStatus.DND -> PeerLine.Unavailable(dndUntil)
        PeerStatus.IN_MEETING -> PeerLine.InMeeting(participants, d)
        PeerStatus.BUSY -> PeerLine.Busy(busyUntil, d)
        PeerStatus.AVAILABLE -> PeerLine.Available(roomSlug, d)
        PeerStatus.ACTIVE -> PeerLine.Active(d)
        PeerStatus.OFFLINE -> PeerLine.Offline(lastSeenAt.takeIf { it > 0 })
    }
}

/** `PeerRingKind`: an unknown kind lands as a wave, the harmless one. */
val IncomingRing.ringKind: RingKind get() = kind.takeIf { it in RingKind.known } ?: RingKind.WAVE

val IncomingRing.callerDisplayName: String
    get() = callerName?.takeIf { it.isNotBlank() } ?: callerEmail.substringBefore('@')

/** `PeerRoster`: the team, you, and a ring for you alone. */
data class PeerRoster(val peers: List<PeerWire>, val incomingRing: IncomingRing? = null) {
    /** Everyone but you, in the server's order. */
    val others: List<PeerWire> get() = peers.filterNot { it.isSelf }
    val me: PeerWire? get() = peers.firstOrNull { it.isSelf }
    val people: List<PeerWire> get() = others.filterNot { it.isAgent }
    val agents: List<PeerWire> get() = others.filter { it.isAgent }

    /** An expired ring is nothing, not a missed call. */
    fun liveRing(nowMs: Long): IncomingRing? = incomingRing?.takeIf { it.expiresAt > nowMs }

    fun withoutPresence(): PeerRoster = PeerRoster(peers.map { it.withoutPresence() }, null)

    companion object {
        val EMPTY = PeerRoster(emptyList())
        fun of(wire: PeersResponse) = PeerRoster(wire.peers, wire.incomingRing)
    }
}

/** `PeerStatusOption`: one menu, one answer, most open at the top. */
enum class PeerStatusOption {
    AVAILABLE, FOCUSED, UNAVAILABLE, OFFLINE;

    /** Whether choosing this hides you. Every other answer un-hides. */
    val invisible: Boolean get() = this == OFFLINE

    /** What to send. Focused and unavailable end at the end of today, computed now. */
    data class Resolved(val intent: PeerIntent?, val intentUntil: Instant?, val dndUntil: Instant?, val setsDnd: Boolean)

    fun resolve(now: ZonedDateTime): Resolved = when (this) {
        AVAILABLE -> Resolved(PeerIntent.AVAILABLE, null, null, true)
        FOCUSED -> Resolved(PeerIntent.FOCUSED, endOfDay(now), null, true)
        UNAVAILABLE -> Resolved(null, null, endOfDay(now), true)
        OFFLINE -> Resolved(null, null, null, false)
    }

    companion object {
        fun endOfDay(now: ZonedDateTime): Instant = now.withHour(23).withMinute(59).withSecond(59).withNano(0).toInstant()

        /** Which row a peer's current state stands on. */
        fun selected(peer: PeerWire?): PeerStatusOption = when {
            peer == null -> AVAILABLE
            peer.invisible -> OFFLINE
            peer.presence == PeerStatus.DND -> UNAVAILABLE
            peer.intent == PeerIntent.FOCUSED -> FOCUSED
            else -> AVAILABLE
        }
    }
}

/** Polling cadences: `PeerPresenceCadence` and `DirectMessageCadence`, in milliseconds. */
object TeamCadence {
    /** PEER_HEARTBEAT_INTERVAL_MILLISECONDS. */
    const val HEARTBEAT_MS = 60_000L
    /** The roster somebody is looking at. */
    const val ROSTER_POLL_MS = 30_000L
    /** RING_TTL_MILLISECONDS: how long a placed call waits for the other room to open. */
    const val RING_LIFE_MS = 45_000L
    const val THREAD_LIST_POLL_MS = 60_000L
    const val OPEN_THREAD_POLL_MS = 4_000L
    /** AGENT_TURN_POLL_SECONDS (fixtures/shared-constants.json). */
    const val AGENT_TURN_POLL_MS = 1_000L
    /** THREAD_BACKGROUND_POLL_SECONDS. */
    const val BACKGROUND_THREAD_POLL_MS = 30_000L
    /** AGENT_ACCEPT_GRACE_SECONDS. */
    const val AGENT_ACCEPT_GRACE_MS = 20_000L
    const val MAX_CHARACTERS = 4_000
    /** A mute ends after a week: one with no end is one nobody remembers setting. */
    const val MUTE_MS = 7L * 24 * 3600 * 1000
}

// Conversations

val ThreadPeer.shortName: String
    get() = name?.takeIf { it.isNotBlank() }?.trim()?.split(' ')?.firstOrNull { it.isNotEmpty() } ?: email.substringBefore('@')

/** A private conversation with more than one other person. */
val ThreadSummaryWire.isGroup: Boolean get() = (peers?.size ?: 0) > 1

/** The list's name for it, or null for "Conversation". */
val ThreadSummaryWire.displayTitle: String?
    get() {
        title?.takeIf { it.isNotBlank() }?.let { return it }
        val others = peers.orEmpty()
        if (others.size > 1) return others.joinToString(", ") { it.shortName }
        peerName?.takeIf { it.isNotBlank() }?.let { return it }
        return peerEmail?.substringBefore('@')
    }

fun ThreadSummaryWire.isMuted(nowMs: Long): Boolean = (mutedUntil ?: 0) > nowMs

/** `ThreadKind.isSubjectChannel`: Work's conversations, not Team's. */
val ThreadKind.isSubjectChannel: Boolean
    get() = this == ThreadKind.PROJECT || this == ThreadKind.LEAD || this == ThreadKind.ORGANIZATION || this == ThreadKind.EVENT

val ThreadKind.isChannel: Boolean get() = isSubjectChannel || this == ThreadKind.TEAM

/** `ThreadAddress.Target`: a conversation named before it exists. */
sealed interface ThreadTarget {
    data class Peer(val email: String) : ThreadTarget
    /** Sorted, so two people who pick one group in another order address one conversation. */
    data class Group(val emails: List<String>) : ThreadTarget
    data object Team : ThreadTarget
    /** A CRM subject's channel (`Target.subject`), find-or-created by the Worker on open. */
    data class Subject(val kind: work.starlings.contracts.CrmSubjectKind, val id: String) : ThreadTarget
}

/**
 * `ThreadAddress`: the target, and what the screen names it from. The
 * sentences are resolved by the screen; [naming] says which.
 */
data class ThreadAddress(val target: ThreadTarget, val naming: Naming) {
    sealed interface Naming {
        /** A roster person or agent, you included. */
        data class OfPeer(val peer: PeerWire) : Naming
        /** First names in email order, and the head count with you. */
        data class OfGroup(val names: String, val people: Int) : Naming
        data object Everyone : Naming
        /** A one-to-one conversation whose other side left the roster. */
        data class OfDirect(val title: String, val shortName: String, val preview: String?) : Naming
        /** A subject's channel: Core's title, and its kind for "Message the project channel". */
        data class OfSubject(val title: String, val kind: work.starlings.contracts.CrmSubjectKind) : Naming
    }

    /** Stable per conversation, as Swift's `id`. */
    val id: String
        get() = when (val t = target) {
            is ThreadTarget.Peer -> "peer:${t.email}"
            is ThreadTarget.Group -> "group:${t.emails.joinToString(",")}"
            ThreadTarget.Team -> "team"
            is ThreadTarget.Subject -> "${t.kind.value}:${t.id}"
        }

    val peerEmail: String? get() = (target as? ThreadTarget.Peer)?.email

    companion object {
        /** THREAD_GROUP_MAX_MEMBERS, less yourself. */
        const val GROUP_MAXIMUM_OTHERS = 11
        const val TEAM_THREAD_ID = "team"

        val team = ThreadAddress(ThreadTarget.Team, Naming.Everyone)

        fun peer(peer: PeerWire) = ThreadAddress(ThreadTarget.Peer(peer.email), Naming.OfPeer(peer))

        /** `ThreadAddress.subject`: a subject's channel, titled by Core's name until the Worker answers. */
        fun subject(kind: work.starlings.contracts.CrmSubjectKind, id: String, title: String) =
            ThreadAddress(ThreadTarget.Subject(kind, id), Naming.OfSubject(title, kind))

        fun group(peers: List<PeerWire>): ThreadAddress {
            val sorted = peers.sortedBy { it.email }
            return ThreadAddress(
                ThreadTarget.Group(sorted.map { it.email }),
                Naming.OfGroup(sorted.joinToString(", ") { it.shortName }, sorted.size + 1),
            )
        }

        fun group(summary: ThreadSummaryWire): ThreadAddress? {
            if (!summary.isGroup) return null
            val others = summary.peers.orEmpty()
            return ThreadAddress(
                ThreadTarget.Group(others.map { it.email }.sorted()),
                Naming.OfGroup(others.joinToString(", ") { it.shortName }, others.size + 1),
            )
        }

        /** Addressed from what the server says is in it, for a person the roster no longer lists. */
        fun direct(summary: ThreadSummaryWire): ThreadAddress? {
            if (summary.kind != ThreadKind.DM || summary.isGroup) return null
            val peer = summary.peers?.firstOrNull() ?: summary.peerEmail?.let { ThreadPeer(it, summary.peerName) } ?: return null
            val full = peer.name?.trim().orEmpty()
            return ThreadAddress(
                ThreadTarget.Peer(peer.email),
                Naming.OfDirect(full.ifEmpty { peer.shortName }, peer.shortName, summary.lastMessagePreview),
            )
        }
    }
}

/** `TeamRailRules` (packages/contracts/src/team-rail.ts), held to fixtures/team-rail.json. */
object TeamRailRules {
    const val DIRECT_KIND = "dm"

    data class Direct(val kind: String, val isGroup: Boolean, val peerEmail: String?, val lastMessageAt: Double?) {
        val isOneToOne: Boolean get() = kind == DIRECT_KIND && !isGroup

        companion object {
            fun of(thread: ThreadSummaryWire) = Direct(
                if (thread.kind == ThreadKind.DM) DIRECT_KIND else "other", thread.isGroup, thread.peerEmail,
                thread.lastMessageAt?.toDouble(),
            )
        }
    }

    /** People you have talked with, latest message first, then the rest as they came. */
    fun order(emails: List<String>, directs: List<Direct>): List<String> {
        val latest = mutableMapOf<String, Double>()
        for (d in directs) {
            if (!d.isOneToOne) continue
            val email = d.peerEmail ?: continue
            val at = d.lastMessageAt ?: continue
            val known = latest[email]
            if (known != null && known >= at) continue
            latest[email] = at
        }
        val talked = emails.filter { it in latest }.sortedByDescending { latest[it] ?: 0.0 }
        return talked + emails.filter { it !in latest }
    }

    /** A conversation whose other side is not on the roster and is not you: it trails PEOPLE. */
    fun isStray(direct: Direct, rosterEmails: Set<String>, selfEmail: String?): Boolean {
        if (!direct.isOneToOne) return false
        val email = direct.peerEmail ?: return false
        return email != selfEmail && email !in rosterEmails
    }
}

/** `TeamRail`: the rules over roster rows and thread summaries. */
object TeamRail {
    fun order(peers: List<PeerWire>, directs: List<ThreadSummaryWire>): List<PeerWire> {
        val emails = TeamRailRules.order(peers.map { it.email }, directs.map(TeamRailRules.Direct::of))
        val byEmail = peers.associateBy { it.email }
        return emails.mapNotNull { byEmail[it] }
    }

    fun strays(directs: List<ThreadSummaryWire>, roster: List<PeerWire>, selfEmail: String?): List<ThreadSummaryWire> {
        val known = roster.map { it.email }.toSet()
        return directs.filter { TeamRailRules.isStray(TeamRailRules.Direct.of(it), known, selfEmail) }
    }
}

/**
 * Team's rail blocks, top to bottom: `RailBlockRegistry` for `team`
 * (fixtures/rail-blocks.json). Each folds under `meet.sidebarFold.<key>`.
 */
enum class TeamBlock(val id: String, val key: String, val hidesWhenEmpty: Boolean) {
    YOU("you", "team.you", true),
    GROUPS("groups", "team.groups", true),
    PEOPLE("people", "team.people", true),
    AGENTS("agents", "team.agents", true);

    val foldKey: String get() = FOLD_PREFIX + key

    companion object {
        const val FOLD_PREFIX = "meet.sidebarFold."

        /** The blocks to draw; one that hides while empty is left out when [empty] holds it. */
        fun visible(empty: Set<TeamBlock>): List<TeamBlock> = entries.filterNot { it.hidesWhenEmpty && it in empty }
    }
}

/** The thread lists Team draws from one poll, as `MobileTeamStore.sortThreads`. */
data class TeamThreads(val unread: List<ThreadSummaryWire>, val groups: List<ThreadSummaryWire>, val directs: List<ThreadSummaryWire>) {
    /** One-to-one only: a group's `peer_email` is whichever member the index answered first. */
    val unreadPeerEmails: Set<String> get() = unread.filterNot { it.isGroup }.mapNotNull { it.peerEmail }.toSet()

    /** Channels and groups, keyed by id. */
    val unreadThreadIds: Set<String> get() = unread.filter { it.kind.isChannel || it.isGroup }.map { it.id }.toSet()

    companion object {
        val EMPTY = TeamThreads(emptyList(), emptyList(), emptyList())

        /** Newest first. The open conversation is being read, so it never paints its dot back. */
        fun of(threads: List<ThreadSummaryWire>, activeThreadId: String?): TeamThreads {
            val newest = compareByDescending<ThreadSummaryWire> { it.lastMessageAt ?: Long.MIN_VALUE }
            return TeamThreads(
                unread = threads.filter { it.unread && it.id != activeThreadId }.sortedWith(newest),
                groups = threads.filter { it.isGroup }.sortedWith(newest),
                directs = threads.filter { it.kind == ThreadKind.DM && !it.isGroup }.sortedWith(newest),
            )
        }
    }
}
