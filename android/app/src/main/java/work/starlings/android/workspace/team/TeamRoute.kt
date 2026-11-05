package work.starlings.android.workspace.team

import work.starlings.android.workspace.work.WorkRoute
import work.starlings.contracts.PeerWire
import work.starlings.contracts.ThreadSummaryWire

/**
 * What a web path asks the Team tab to open, over the permalink grammar in
 * `packages/contracts/src/permalinks.ts` (`team: person, agent, thread`):
 *
 * - `/team` is the roster.
 * - `/team/person/<local part>` and `/team/agent/<local part>` name one
 *   peer by the local part of the address (`peerHref`); `?do=wave` or
 *   `?do=call` runs that verb once the roster answers ( decision 7).
 * - `/team/thread/<id>` names one conversation.
 */
sealed interface TeamRoute {
    data object Roster : TeamRoute
    data class Peer(val localPart: String, val agent: Boolean, val verb: String? = null) : TeamRoute
    data class Thread(val id: String) : TeamRoute

    companion object {
        private val RECORD_PATH = Regex("^/team/(person|agent|thread)/([^/]+)/?$")

        /** The route a path names, or null when it is not a Team path. */
        fun parse(route: String): TeamRoute? {
            val noHash = route.substringBefore('#')
            val path = noHash.substringBefore('?')
            val query = noHash.substringAfter('?', "")
            if (!path.equals("/team", ignoreCase = true) && !path.startsWith("/team/", ignoreCase = true)) return null
            val match = RECORD_PATH.find(path) ?: return Roster
            val id = WorkRoute.decode(match.groupValues[2]) ?: return Roster
            return when (match.groupValues[1]) {
                "thread" -> Thread(id)
                else -> {
                    val verb = query.split('&').firstOrNull { it.startsWith("do=") }?.substringAfter('=')
                        ?.let { WorkRoute.decode(it, plus = true) }?.trim()?.takeIf { it.isNotEmpty() }
                    Peer(id, agent = match.groupValues[1] == "agent", verb = verb)
                }
            }
        }

        /** The roster's peer a [Peer] route names: the local part, any case, and the kind it says. */
        fun peer(route: Peer, peers: List<PeerWire>): PeerWire? =
            peers.firstOrNull { it.isAgent == route.agent && it.email.substringBefore('@').equals(route.localPart, ignoreCase = true) }
                ?: peers.firstOrNull { it.email.equals(route.localPart, ignoreCase = true) }

        /**
         * The conversation a [Thread] route names: Everyone, a one-to-one as
         * that person (the roster's naming first), or a group. Null while the
         * list does not hold it.
         */
        fun address(route: Thread, threads: TeamThreads, peers: List<PeerWire>): ThreadAddress? {
            if (route.id == ThreadAddress.TEAM_THREAD_ID) return ThreadAddress.team
            val summary: ThreadSummaryWire = (threads.directs + threads.groups + threads.unread).firstOrNull { it.id == route.id } ?: return null
            ThreadAddress.group(summary)?.let { return it }
            val email = summary.peerEmail ?: summary.peers?.singleOrNull()?.email
            peers.firstOrNull { email != null && it.email.equals(email, ignoreCase = true) }?.let { return ThreadAddress.peer(it) }
            return ThreadAddress.direct(summary)
        }
    }
}
