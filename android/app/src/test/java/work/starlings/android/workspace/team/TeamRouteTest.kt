package work.starlings.android.workspace.team

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import work.starlings.android.workspace.home.HomeLinks
import work.starlings.contracts.PeerKindValue
import work.starlings.contracts.PeerStatusValue
import work.starlings.contracts.PeerWire
import work.starlings.contracts.ThreadAudience
import work.starlings.contracts.ThreadKind
import work.starlings.contracts.ThreadPeer
import work.starlings.contracts.ThreadSummaryWire

/** [TeamRoute] reads the paths [HomeLinks] and Search write. */
class TeamRouteTest {
    private fun peer(email: String, kind: PeerKindValue = PeerKindValue.HUMAN) = PeerWire(
        email = email, kind = kind, status = PeerStatusValue("available"), lastSeenAt = 0, clients = emptyList(),
        invisible = false, participants = 0, isSelf = false,
    )

    private fun thread(id: String, peers: List<ThreadPeer>?, peerEmail: String? = null) = ThreadSummaryWire(
        id = id, kind = ThreadKind.DM, audience = ThreadAudience.known.first(), peerEmail = peerEmail, peers = peers,
        unread = false, lastReadAt = 0, hasMention = false,
    )

    @Test
    fun pathsParse() {
        assertEquals(TeamRoute.Roster, TeamRoute.parse("/team"))
        assertEquals(TeamRoute.Peer("ada", agent = false), TeamRoute.parse(HomeLinks.peer("Ada@x.co", agent = false)))
        assertEquals(TeamRoute.Peer("vocab", agent = true), TeamRoute.parse(HomeLinks.peer("vocab@x.co", agent = true)))
        assertEquals(TeamRoute.Peer("ada", agent = false, verb = "wave"), TeamRoute.parse("/team/person/ada?do=wave"))
        assertEquals(TeamRoute.Thread("t 1"), TeamRoute.parse(HomeLinks.teamThread("t 1")))
        assertEquals(TeamRoute.Roster, TeamRoute.parse("/team/thread/%zz"))
        assertNull(TeamRoute.parse("/teams"))
        assertNull(TeamRoute.parse("/work"))
    }

    @Test
    fun peersResolveByLocalPartAndKind() {
        val ada = peer("ada@x.co")
        val bot = peer("ada@agents.x.co", PeerKindValue.AGENT)
        assertEquals(ada, TeamRoute.peer(TeamRoute.Peer("ADA", agent = false), listOf(bot, ada)))
        assertEquals(bot, TeamRoute.peer(TeamRoute.Peer("ada", agent = true), listOf(ada, bot)))
        assertNull(TeamRoute.peer(TeamRoute.Peer("rosa", agent = false), listOf(ada)))
    }

    @Test
    fun threadsResolveToTheirAddress() {
        val ada = peer("ada@x.co")
        val direct = thread("d1", listOf(ThreadPeer("ada@x.co", "Ada")), "ada@x.co")
        val group = thread("g1", listOf(ThreadPeer("b@x.co"), ThreadPeer("a@x.co")))
        val threads = TeamThreads.of(listOf(direct, group), null)
        assertEquals(ThreadAddress.team, TeamRoute.address(TeamRoute.Thread(ThreadAddress.TEAM_THREAD_ID), threads, emptyList()))
        assertEquals(ThreadAddress.peer(ada), TeamRoute.address(TeamRoute.Thread("d1"), threads, listOf(ada)))
        assertEquals("peer:ada@x.co", TeamRoute.address(TeamRoute.Thread("d1"), threads, emptyList())?.id)
        assertEquals("group:a@x.co,b@x.co", TeamRoute.address(TeamRoute.Thread("g1"), threads, emptyList())?.id)
        assertNull(TeamRoute.address(TeamRoute.Thread("nope"), threads, listOf(ada)))
    }
}
