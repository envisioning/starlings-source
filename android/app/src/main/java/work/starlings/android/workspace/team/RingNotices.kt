package work.starlings.android.workspace.team

import work.starlings.contracts.IncomingRing
import work.starlings.contracts.RingKind

/** One "somebody asked for you" notification, decided before any Android notification type exists. */
data class RingNotice(
    /** Caller and creation time: a ring stays in the roster for its whole life, so every poll would announce it again. */
    val key: String,
    val callerName: String,
    val roomSlug: String?,
    /** A wave's room link: the tap opens the join flow there. */
    val joinUrl: String?,
    val isCall: Boolean = false,
    /** Your own agent asking to open your room. */
    val isAgentAsk: Boolean = false,
)

/**
 * `RingNotices.plan` of `iOS/RingNotices.swift`. These fire only while the
 * app runs and polls (the roster poll, from any tab); there is no push, so
 * never call them push in copy.
 */
object RingNotices {
    data class Plan(val notice: RingNotice?, val announced: String?)

    /**
     * What to announce, given what has already been announced. No live ring
     * clears the record, and the caller withdraws the notification. [roomLink]
     * is the workspace's room link for a slug (`MeetingInvite.absoluteURL`).
     */
    fun plan(ring: IncomingRing?, announced: String?, roomLink: (String) -> String): Plan {
        ring ?: return Plan(null, null)
        val key = "${ring.callerEmail}#${ring.createdAt / 1000}"
        if (key == announced) return Plan(null, announced)
        val kind = ring.ringKind
        return Plan(
            RingNotice(
                key = key,
                callerName = ring.callerDisplayName,
                roomSlug = ring.roomSlug,
                joinUrl = ring.roomSlug?.takeIf { kind == RingKind.WAVE }?.let(roomLink),
                isCall = kind == RingKind.CALL,
                isAgentAsk = kind == RingKind.AGENT_START,
            ),
            key,
        )
    }
}
