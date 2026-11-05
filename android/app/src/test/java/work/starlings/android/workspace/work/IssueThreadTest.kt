package work.starlings.android.workspace.work

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import work.starlings.contracts.CrmIssueDetailWire
import work.starlings.contracts.CrmIssueEvent
import work.starlings.contracts.CrmIssueState
import work.starlings.contracts.WireJson

/** [IssueThread]: the reader's thread, event phrases, state and edits, as `CrmIssueDetail` and `CrmIssueEvent.summary`. */
class IssueThreadTest {
    private val detail = WireJson.decodeFromString(
        CrmIssueDetailWire.serializer(),
        """{"id":"o/r#7","number":7,"owner":"o","repo":"r","title":"Bug","state":"open","url":"u","labels":[],"comments":3,"body":"b",
           "comments_list":[
             {"id":2,"author":"ada","body":"second","created_at":"2026-10-02T10:00:00Z","url":"c2"},
             {"id":1,"author":"bob","body":"first","created_at":"2026-10-01T10:00:00Z","url":"c1"}],
           "timeline":[
             {"id":"e0","kind":"subscribed","actor":"ada","created_at":"2026-09-30T10:00:00Z"},
             {"id":"e1","kind":"labeled","actor":"ada","created_at":"2026-10-01T12:00:00Z","label":{"name":"bug","color":"ff0000"}},
             {"id":"e2","kind":"closed","state_reason":"not_planned"}]}""",
    )

    @Test
    fun oneChronologicalThreadWithUndatedLast() {
        val entries = IssueThread.entries(detail)
        assertEquals(
            listOf("c:1", "e:e1", "c:2", "e:e2"),
            entries.map { if (it is IssueEntry.Comment) "c:${it.comment.id}" else "e:${(it as IssueEntry.Event).event.id}" },
        )
    }

    @Test
    fun eventsSayWhatHappened() {
        fun event(kind: String, reason: String? = null, subject: String? = null) =
            CrmIssueEvent(id = "x", kind = kind, actor = "ada", stateReason = reason, subject = subject)
        assertEquals(IssueThread.Summary(IssueThread.Phrase.CLOSED_NOT_PLANNED, "ada", null), IssueThread.summary(event("closed", "not_planned")))
        assertEquals(IssueThread.Phrase.CLOSED_DUPLICATE, IssueThread.summary(event("closed", "duplicate"))?.phrase)
        assertEquals(IssueThread.Phrase.CLOSED, IssueThread.summary(event("closed"))?.phrase)
        assertEquals(IssueThread.Summary(IssueThread.Phrase.MENTIONED, "ada", "#277"), IssueThread.summary(event("cross-referenced", subject = "#277")))
        assertNull(IssueThread.summary(event("subscribed")))
    }

    @Test
    fun stateAndEdits() {
        assertEquals(IssueThread.State.OPEN, IssueThread.state(CrmIssueState.OPEN, "not_planned"))
        assertEquals(IssueThread.State.NOT_PLANNED, IssueThread.state(CrmIssueState.CLOSED, "not_planned"))
        assertEquals(IssueThread.State.CLOSED, IssueThread.state(CrmIssueState.CLOSED, "completed"))
        assertEquals(null to null, IssueThread.edits(" Bug ", "b", "Bug", "b"))
        assertEquals("Bugs" to "new", IssueThread.edits("Bugs", "new", "Bug", "b"))
        assertNull(IssueThread.edits("  ", "b", "Bug", "b"))
        assertEquals(listOf<String>(), IssueThread.owners(IssueThread.row(detail)))
    }
}
