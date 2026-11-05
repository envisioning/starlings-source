package work.starlings.android.workspace.work

import org.junit.Assert.assertEquals
import org.junit.Test
import work.starlings.android.MineOriginFilter
import work.starlings.android.WorkItems
import work.starlings.android.WorkStage
import work.starlings.android.WorkStageWrite
import work.starlings.contracts.CrmIssueUpdate
import work.starlings.contracts.CrmIssueWire
import work.starlings.contracts.CrmRecentlyClosedItemWire
import work.starlings.contracts.WireJson

/** [IssueWrites] and [RecentlyFinished], as `CrmIssueUpdate.stateChange` and `finishedRows` read them. */
class WorkWritesTest {
    private val issue = WireJson.decodeFromString(
        CrmIssueWire.serializer(),
        """{"id":"o/r#7","owner":"o","repo":"r","number":7,"title":"Bug","state":"closed","url":"https://github.com/o/r/issues/7","labels":[],"comments":0}""",
    )

    @Test
    fun aStateChangeSendsStateAndReason() {
        assertEquals(
            """{"owner":"o","repo":"r","number":7,"project_id":"p1","state":"open"}""",
            WireJson.encodeToString(CrmIssueUpdate.serializer(), IssueWrites.stateChange(IssueStateChange.REOPEN, issue, "p1")),
        )
        assertEquals(
            """{"owner":"o","repo":"r","number":7,"state":"closed","state_reason":"not_planned"}""",
            WireJson.encodeToString(CrmIssueUpdate.serializer(), IssueWrites.stateChange(IssueStateChange.CLOSE_NOT_PLANNED, issue, null)),
        )
    }

    @Test
    fun recentlyFinishedFollowsTheTypeMenu() {
        val items = listOf(
            WireJson.decodeFromString(CrmRecentlyClosedItemWire.serializer(), """{"kind":"task","id":"t1","title":"Send deck"}"""),
            WireJson.decodeFromString(CrmRecentlyClosedItemWire.serializer(), """{"kind":"issue","id":"o/r#7","title":"Bug"}"""),
        )
        assertEquals(listOf("t1", "o/r#7"), RecentlyFinished.shown(items, MineOriginFilter.ALL).map { it.id })
        assertEquals(listOf("t1"), RecentlyFinished.shown(items, MineOriginFilter.TASK).map { it.id })
        assertEquals(listOf("o/r#7"), RecentlyFinished.shown(items, MineOriginFilter.ISSUE).map { it.id })
    }

    @Test
    fun aBoardMoveIsTheSharedWrite() {
        val open = WireJson.decodeFromString(
            CrmIssueWire.serializer(),
            """{"id":"o/r#7","owner":"o","repo":"r","number":7,"title":"Bug","state":"open","url":"u","labels":["bug","agent:building"],"comments":0}""",
        )
        val card = BoardItem.Issue(open, null)
        val write = WorkItems.write(WorkStage.REVIEW, card) as WorkStageWrite.Issue
        assertEquals(
            """{"owner":"o","repo":"r","number":7,"project_id":"p1","state":"open","labels":["bug","agent:review"]}""",
            WireJson.encodeToString(CrmIssueUpdate.serializer(), BoardMoves.issueUpdate(open, "p1", write)),
        )
        assertEquals(WorkStage.entries - WorkStage.DONE, BoardMoves.targets(WorkStage.DONE))
    }
}
