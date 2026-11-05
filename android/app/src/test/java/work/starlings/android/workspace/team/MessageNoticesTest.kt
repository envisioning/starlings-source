package work.starlings.android.workspace.team

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.ThreadAudience
import work.starlings.contracts.ThreadKind
import work.starlings.contracts.ThreadSummaryWire

class MessageNoticesTest {
    private fun thread(id: String, at: Long?, kind: ThreadKind = ThreadKind.DM, unread: Boolean = true, mention: Boolean = false) = ThreadSummaryWire(
        id = id, kind = kind, audience = ThreadAudience.known.first(), peerEmail = "rosa@x.co", peerName = "Rosa",
        lastMessageAt = at, lastMessagePreview = "hi", unread = unread, lastReadAt = 0, hasMention = mention,
    )

    @Test
    fun firstPollRecordsAndAnnouncesNothing() {
        val plan = MessageNotices.plan(listOf(thread("a", 100)), emptyMap(), null, null)
        assertTrue(plan.notices.isEmpty())
        assertEquals(mapOf("a" to 100L), plan.seen)
    }

    @Test
    fun aNewerMessageAnnounces() {
        val plan = MessageNotices.plan(listOf(thread("a", 200)), mapOf("a" to 100L), null, 150)
        assertEquals(listOf("a"), plan.notices.map { it.threadId })
        // The tap opens the conversation at its web path.
        assertEquals("/team/thread/a", plan.notices.single().path)
        assertEquals("Rosa", plan.notices.single().title)
    }

    @Test
    fun theOpenConversationAndReadOnesStayQuiet() {
        assertTrue(MessageNotices.plan(listOf(thread("a", 200)), mapOf("a" to 100L), "a", 150).notices.isEmpty())
        assertTrue(MessageNotices.plan(listOf(thread("a", 200, unread = false)), mapOf("a" to 100L), null, 150).notices.isEmpty())
    }

    @Test
    fun aNewThreadAnnouncesOnlyWhenItsMessageIsRecent() {
        val recent = MessageNotices.plan(listOf(thread("b", 100_000)), emptyMap(), null, 120_000)
        assertEquals(1, recent.notices.size)
        val history = MessageNotices.plan(listOf(thread("b", 10_000)), emptyMap(), null, 120_000)
        assertTrue(history.notices.isEmpty())
    }

    @Test
    fun aChannelNeedsAMentionUnlessWidened() {
        val channel = thread("t", 200, kind = ThreadKind.TEAM)
        assertTrue(MessageNotices.plan(listOf(channel), mapOf("t" to 100L), null, 150).notices.isEmpty())
        assertEquals(1, MessageNotices.plan(listOf(channel.copy(hasMention = true)), mapOf("t" to 100L), null, 150).notices.size)
        assertEquals(1, MessageNotices.plan(listOf(channel), mapOf("t" to 100L), null, 150, notifyOnAllChannelMessages = true).notices.size)
    }
}
