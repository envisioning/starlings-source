package work.starlings.android.workspace.work

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.api.WorkExtraRoutes
import work.starlings.contracts.InboxFollowUpItem
import work.starlings.contracts.InboxFollowUpItemMeeting
import work.starlings.contracts.InboxFollowUpItemTasksItem
import work.starlings.contracts.InboxSubjectRef
import work.starlings.contracts.MeetingFollowUpDraft

/** [FollowUpMail] as `Sources/FollowUpMail.swift` and `web/src/follow-up-mail.ts` decide it. */
class FollowUpMailTest {
    private val item = InboxFollowUpItem(
        key = "followup:m1", at = 1, meeting = InboxFollowUpItemMeeting("rosa", "m1", "Kickoff"),
        subject = InboxSubjectRef(work.starlings.contracts.InboxSubjectRefKind("project"), "p1", "Atlas"),
        recipients = emptyList(), draft = MeetingFollowUpDraft("Next steps", "Thanks"), revision = 3,
        tasks = listOf(InboxFollowUpItemTasksItem("t1", "Send deck"), InboxFollowUpItemTasksItem("t2", "Book room"), InboxFollowUpItemTasksItem("t3", "Ask legal")),
        expiresAt = 9,
    )

    @Test
    fun aShortDraftTravelsInTheLink() {
        val draft = FollowUpMail.draft(listOf("ada@example.com", "bo@example.com"), "Next steps & more", "Line one\nLine two")
        assertFalse(draft.bodyOnClipboard)
        assertEquals("mailto:ada@example.com,bo@example.com?subject=Next%20steps%20%26%20more&body=Line%20one%0ALine%20two", draft.url)
    }

    @Test
    fun aLongBodyGoesByClipboard() {
        val draft = FollowUpMail.draft(listOf("ada@example.com"), "Next", "x".repeat(FollowUpMail.LINK_MAX))
        assertTrue(draft.bodyOnClipboard)
        assertEquals("mailto:ada@example.com?subject=Next", draft.url)
    }

    @Test
    fun approveAcceptsTheKeptAndDeclinesTheRest() {
        assertEquals(listOf("t1", "t3") to listOf("t2"), FollowUpMail.split(item, setOf("t3", "t1")))
        val route = WorkExtraRoutes.approveFollowUp(item, listOf("t1"), listOf("t2", "t3"))
        assertEquals(listOf("rooms", "rosa", "meetings", "m1", "follow-up"), route.path)
        assertEquals("""{"revision":3,"subject":"Next steps","body":"Thanks","accept_task_ids":["t1"],"decline_task_ids":["t2","t3"]}""", route.body)
        assertEquals("DELETE", WorkExtraRoutes.dismissFollowUp(item).method)
    }
}
