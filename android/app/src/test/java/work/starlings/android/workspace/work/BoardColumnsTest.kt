package work.starlings.android.workspace.work

import org.junit.Assert.assertEquals
import org.junit.Test
import work.starlings.android.WorkStage
import work.starlings.contracts.SubjectStateResponseWire
import work.starlings.contracts.WireJson
import work.starlings.contracts.WorkPreferencesUpdate

/** The Board's hidden columns as `MobileMyWorkStore.setBoardHiddenStages` and `crmSetWorkPreferences(boardHiddenStages:)` keep them. */
class BoardColumnsTest {
    private val state = WireJson.decodeFromString(
        SubjectStateResponseWire.serializer(),
        """{"role":"member","sales_enabled":false,"work_list":{"sort":"recent","group":"none","starred_only":false},""" +
            """"inbox_sources":{},"inbox_available_sources":[],"board_hidden_stages":["done","someday","queued"],"states":[]}""",
    )

    @Test
    fun aStageThisBuildDoesNotKnowIsDropped() {
        assertEquals(setOf(WorkStage.QUEUED, WorkStage.DONE), BoardColumns.hidden(state))
        assertEquals(emptySet<WorkStage>(), BoardColumns.hidden(null))
    }

    @Test
    fun aToggleShowsOrHidesOneColumn() {
        val hidden = setOf(WorkStage.DONE)
        assertEquals(setOf(WorkStage.DONE, WorkStage.REVIEW), BoardColumns.toggled(hidden, WorkStage.REVIEW, shown = false))
        assertEquals(emptySet<WorkStage>(), BoardColumns.toggled(hidden, WorkStage.DONE, shown = true))
    }

    @Test
    fun theSetGoesWholeInStageOrder() {
        val body = WireJson.encodeToString(WorkPreferencesUpdate.serializer(), BoardColumns.update(setOf(WorkStage.DROPPED, WorkStage.QUEUED)))
        assertEquals("""{"board_hidden_stages":["queued","dropped"]}""", body)
        assertEquals("""{"board_hidden_stages":[]}""", WireJson.encodeToString(WorkPreferencesUpdate.serializer(), BoardColumns.update(emptySet())))
    }

    @Test
    fun theAnswerTakesTheNewSetWhileTheWriteIsOut() {
        val next = BoardColumns.with(state, setOf(WorkStage.BLOCKED))
        assertEquals(setOf(WorkStage.BLOCKED), BoardColumns.hidden(next))
        assertEquals(state.workList, next.workList)
    }

    @Test
    fun hiddenCardsAreCountedOnlyInOfferedColumns() {
        val counts = mapOf(WorkStage.QUEUED to 3, WorkStage.DONE to 5, WorkStage.REVIEW to 2)
        val offered = WorkStage.entries.filter { !it.isFinished }
        assertEquals(3, BoardColumns.hiddenCount(offered, setOf(WorkStage.QUEUED, WorkStage.DONE)) { counts[it] ?: 0 })
        assertEquals(8, BoardColumns.hiddenCount(WorkStage.entries, setOf(WorkStage.QUEUED, WorkStage.DONE)) { counts[it] ?: 0 })
    }
}
