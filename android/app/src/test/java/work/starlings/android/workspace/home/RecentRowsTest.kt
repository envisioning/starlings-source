package work.starlings.android.workspace.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import work.starlings.android.SearchKind
import work.starlings.contracts.PeerKindValue
import work.starlings.contracts.ThreadAudience
import work.starlings.contracts.ThreadKind
import work.starlings.contracts.ThreadPeer
import work.starlings.contracts.ThreadSummaryWire

/** [RecentRows] writes the rows `Sources/SearchRecentRows.swift` writes. */
class RecentRowsTest {
    private val labels = RecentRows.ThreadLabels("Agent", "Group", "Direct message", "Team Room", "Channel", "Conversation")

    private fun thread(
        id: String,
        kind: ThreadKind = ThreadKind.DM,
        peers: List<ThreadPeer>? = null,
        peerEmail: String? = null,
        peerName: String? = null,
        title: String? = null,
        parentId: String? = null,
    ) = ThreadSummaryWire(
        id = id, kind = kind, parentId = parentId, audience = ThreadAudience.known.first(), title = title,
        peerEmail = peerEmail, peerName = peerName, peers = peers, unread = false, lastReadAt = 0, hasMention = false,
    )

    @Test
    fun subjects() {
        val row = RecentRows.subject("project", "p1", "Atlas")!!
        assertEquals("subject:p1", row.key)
        assertEquals("Project", row.subtitle)
        assertEquals("subject:project:p1", row.doorString)
        assertEquals("Lead · Acme", RecentRows.subject("lead", "l1", "Acme deal", subtitle = "Acme")!!.subtitle)
        assertEquals("subject:organization:o1", RecentRows.subject("partner", "o1", "Acme")!!.doorString)
        assertNull(RecentRows.subject("widget", "w1", "W"))
    }

    @Test
    fun aOneToOneIsThePeer() {
        val person = RecentRows.thread(thread("d1", peers = listOf(ThreadPeer("ada@x.co", "Ada"))), labels)
        assertEquals(SearchKind.PERSON, person.kind)
        assertEquals("Ada", person.title)
        assertEquals("ada@x.co", person.subtitle)
        assertEquals("person:ada@x.co", person.doorString)
        val agent = RecentRows.thread(thread("d2", peers = listOf(ThreadPeer("bot@x.co", null, PeerKindValue.AGENT))), labels)
        assertEquals("agent:bot@x.co", agent.doorString)
        assertEquals("bot@x.co", agent.title)
        assertEquals("Agent", agent.subtitle)
        assertEquals("person:old@x.co", RecentRows.thread(thread("d3", peerEmail = "old@x.co"), labels).doorString)
    }

    @Test
    fun groupsChannelsAndSubjectChannels() {
        val group = RecentRows.thread(thread("g1", peers = listOf(ThreadPeer("a@x.co", "Ada Lovelace"), ThreadPeer("b@x.co", "Bo Li"))), labels)
        assertEquals("thread:g1", group.doorString)
        assertEquals("Group", group.subtitle)
        assertEquals("Team Room", RecentRows.thread(thread("team", ThreadKind.TEAM, title = "Everyone"), labels).subtitle)
        val channel = RecentRows.thread(thread("c1", ThreadKind("project"), title = "Atlas", parentId = "p1"), labels)
        assertEquals("subject:project:p1", channel.doorString)
        assertEquals("Atlas", channel.title)
    }

    @Test
    fun documents() {
        val row = RecentRows.document("d1", "Plan")
        assertEquals("document:d1", row.doorString)
        assertEquals("Document", row.subtitle)
    }
}
