package work.starlings.android.workspace.team

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.ThreadMessageRef
import work.starlings.contracts.ThreadMessageRefKind
import work.starlings.contracts.ThreadMessageType
import work.starlings.contracts.ThreadMessageWire

/** A subject channel's replies and ref chips, as `ThreadReplyDraft` and `ThreadMessageRef` hold them on Swift. */
class ThreadRefsTest {
    private fun ref(kind: ThreadMessageRefKind, id: String) = ThreadMessageRef(kind, id)

    private fun message(id: String, type: ThreadMessageType = ThreadMessageType.TEXT, deletedAt: Long? = null, partial: Boolean? = null) = ThreadMessageWire(
        id = id, threadId = "t", sentAt = 1, senderEmail = "ada@x.co", text = "hi", isMine = false, type = type, deletedAt = deletedAt, partial = partial,
    )

    @Test
    fun aReplyDraftTakesFinishedTextOnly() {
        assertEquals("parent", ThreadReplyDraft().select(message("parent"))?.parentMessageId)
        assertNull(ThreadReplyDraft().select(message("e", ThreadMessageType.EVENT)))
        assertNull(ThreadReplyDraft().select(message("p", partial = true)))
        assertNull(ThreadReplyDraft().select(message("w", deletedAt = 2)))
        val draft = ThreadReplyDraft("parent")
        assertTrue(draft.isValid(listOf(message("parent"))))
        assertFalse("withdrawn since", draft.isValid(listOf(message("parent", deletedAt = 3))))
        assertFalse("gone from the page", draft.isValid(emptyList()))
        assertTrue(ThreadReplyDraft().isValid(emptyList()))
    }

    @Test
    fun repliesAndDecisionsAreASubjectChannels() {
        val subject = ThreadAddress(ThreadTarget.Subject(CrmSubjectKind.PROJECT, "p1"), ThreadAddress.Naming.OfSubject("Site", CrmSubjectKind.PROJECT))
        assertTrue(subject.supportsMessageReplies)
        assertEquals(ThreadTarget.Subject(CrmSubjectKind.PROJECT, "p1"), subject.decisionSubject)
        assertFalse(ThreadAddress.team.supportsMessageReplies)
        assertNull(ThreadAddress.team.decisionSubject)
    }

    @Test
    fun chipTitlesFollowSwift() {
        assertEquals(RefChips.Title.Task, RefChips.title(ref(ThreadMessageRefKind.TASK, "t1")))
        assertEquals(RefChips.Title.Literal("#147"), RefChips.title(ref(ThreadMessageRefKind.ISSUE, "envisioning/meet#147")))
        assertEquals(RefChips.Title.Literal("#9"), RefChips.title(ref(ThreadMessageRefKind.PULL, "o/r#9")))
        assertEquals(RefChips.Title.Literal("abcdef1"), RefChips.title(ref(ThreadMessageRefKind.COMMIT, "o/r@abcdef1234")))
        assertEquals(RefChips.Title.Literal("CI"), RefChips.title(ref(ThreadMessageRefKind.RUN, "o/r!42")))
        assertEquals(RefChips.Title.Literal("v1.2"), RefChips.title(ref(ThreadMessageRefKind.RELEASE, "o/r@v1.2")))
        assertEquals(RefChips.Title.Literal("Decision"), RefChips.title(ref(ThreadMessageRefKind.DECISION, "d1")))
    }

    @Test
    fun chipDoorsFollowSwift() {
        assertEquals(RefChips.Door.Task("t1"), RefChips.door(ref(ThreadMessageRefKind.TASK, "t1")))
        assertEquals(RefChips.Door.Issue("envisioning", "meet", 147), RefChips.door(ref(ThreadMessageRefKind.ISSUE, "envisioning/meet#147")))
        assertEquals(RefChips.Door.None, RefChips.door(ref(ThreadMessageRefKind.ISSUE, "meet#147")))
        assertEquals(RefChips.Door.Overview, RefChips.door(ref(ThreadMessageRefKind.GOAL, "g1")))
        assertEquals(RefChips.Door.None, RefChips.door(ref(ThreadMessageRefKind.MEETING, "m1")))
        assertEquals(RefChips.Door.Web("https://github.com/o/r/pull/9"), RefChips.door(ref(ThreadMessageRefKind.PULL, "o/r#9")))
        assertEquals("https://github.com/o/r/commit/abc", RefChips.githubUrl(ref(ThreadMessageRefKind.COMMIT, "o/r@abc")))
        assertEquals("https://github.com/o/r/actions/runs/42", RefChips.githubUrl(ref(ThreadMessageRefKind.RUN, "o/r!42")))
        assertEquals("https://github.com/o/r/releases/tag/v1%202", RefChips.githubUrl(ref(ThreadMessageRefKind.RELEASE, "o/r@v1 2")))
        assertNull(RefChips.githubUrl(ref(ThreadMessageRefKind.TASK, "t1")))
        assertNull(RefChips.githubUrl(ref(ThreadMessageRefKind.PULL, "#9")))
    }

    @Test
    fun saveAsQuickNoteIsYourOwnTextLine() {
        val mine = ThreadMessageWire(id = "m", threadId = "t", sentAt = 1, senderEmail = "me@x.co", text = "ship it", isMine = true, type = ThreadMessageType.TEXT)
        assertTrue(mine.offersSaveAsQuickNote)
        assertFalse("theirs", mine.copy(isMine = false).offersSaveAsQuickNote)
        assertFalse("an event", mine.copy(type = ThreadMessageType.EVENT).offersSaveAsQuickNote)
        assertFalse("no text", mine.copy(text = "").offersSaveAsQuickNote)
    }

    @Test
    fun teamChipsOpenTasksAndIssuesButHaveNoOverview() {
        val stack = androidx.compose.runtime.mutableStateListOf<TeamRefPage>()
        val doors = teamRefDoors(stack)
        assertNull("a decision or a goal stays a label outside its subject", doors.showOverview)
        doors.openTask("t1")
        doors.openIssue("envisioning", "meet", 147)
        assertEquals(listOf(TeamRefPage.TaskRef("t1"), TeamRefPage.IssueRef("envisioning", "meet", 147)), stack.toList())
    }
}
