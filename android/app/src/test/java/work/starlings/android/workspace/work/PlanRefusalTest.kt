package work.starlings.android.workspace.work

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import work.starlings.android.api.StarlingsApiError
import work.starlings.contracts.ControlErrorCodeValue

/** The subject editor's save reads a plan refusal as the plan's line, not an error (`MobileSubjectEditorView.save`). */
class PlanRefusalTest {
    private fun refused(code: String?) = StarlingsApiError.Service("Couldn’t save", 403, code?.let(::ControlErrorCodeValue), null, "Your plan holds one project.")

    @Test
    fun theTwoPlanCodesReadAsTheirLine() {
        assertEquals(WorkspacePlanNotice.Refusal.LIMIT, WorkspacePlanNotice.refusal(refused(WorkspacePlanNotice.PROJECT_LIMIT_CODE)))
        assertEquals(WorkspacePlanNotice.Refusal.FROZEN, WorkspacePlanNotice.refusal(refused(WorkspacePlanNotice.PROJECT_FROZEN_CODE)))
    }

    @Test
    fun anyOtherFailureStaysAnError() {
        assertNull(WorkspacePlanNotice.refusal(refused("forbidden")))
        assertNull(WorkspacePlanNotice.refusal(refused(null)))
        assertNull(WorkspacePlanNotice.refusal(StarlingsApiError.SignedOut("Couldn’t save")))
        assertNull(WorkspacePlanNotice.refusal(IllegalStateException("x")))
    }
}
