package work.starlings.android.workspace.work

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import work.starlings.android.R
import work.starlings.android.api.Answer
import work.starlings.android.api.Route
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.contracts.SubjectStateResponseWire
import work.starlings.contracts.WorkspacePlanResponse

/**
 * `WorkspacePlanNotice` (Sources/WorkspacePlanNotice.swift): what
 * a person reads at a plan limit. The words and codes are
 * `fixtures/workspace-plans.json`'s; an admin gets Upgrade, a member reads
 * who can lift it. No client changes the plan: web Admin and meetctl do.
 */
object WorkspacePlanNotice {
    const val PROJECT_LIMIT_CODE = "plan_project_limit"
    const val PROJECT_FROZEN_CODE = "plan_project_frozen"
    /** Where an admin's Upgrade goes, until Stripe Checkout. */
    const val UPGRADE_URL = "${work.starlings.android.Deployment.PRODUCT_SITE_ORIGIN}/pricing"

    /** `GET /api/workspace/plan` (`StarlingsWorkRoutes.workspacePlan`). */
    val route = Route(
        "GET", listOf("workspace", "plan"), answer = Answer.Wire(WorkspacePlanResponse.serializer()),
        operation = "Couldn’t load the workspace plan",
    )

    fun isProjectLimit(serverCode: String?): Boolean = serverCode == PROJECT_LIMIT_CODE
    fun isProjectFrozen(serverCode: String?): Boolean = serverCode == PROJECT_FROZEN_CODE

    /** Which plan line a refused write reads instead of an error: the limit, read-only, or none. */
    enum class Refusal { LIMIT, FROZEN }

    fun refusal(error: Throwable): Refusal? {
        val code = (error as? work.starlings.android.api.StarlingsApiError.Service)?.serverCode?.value
        return when {
            isProjectLimit(code) -> Refusal.LIMIT
            isProjectFrozen(code) -> Refusal.FROZEN
            else -> null
        }
    }

    /** The subject editor's line for [error] (`MobileSubjectEditorView.save`); null when it is a plain error. */
    fun refusalText(context: Context, error: Throwable, isAdmin: Boolean): String? = when (refusal(error)) {
        Refusal.LIMIT -> limitText(context, isAdmin)
        Refusal.FROZEN -> frozenText(context, isAdmin)
        null -> null
    }

    /** The Worker's rule, read here: a plan with a project limit and a kept project holds every other project read-only. */
    fun isFrozen(projectId: String, plan: WorkspacePlanResponse?): Boolean {
        val kept = plan?.keptProjectId ?: return false
        if (plan.projectLimit == null) return false
        return projectId != kept
    }

    /** `SubjectStateResponse.isWorkspaceAdmin`; an unread state reads as a member. */
    fun isAdmin(state: SubjectStateResponseWire?): Boolean = state?.role == "admin"

    /** The limit line; a member also reads who can lift it. */
    fun limitText(context: Context, isAdmin: Boolean): String = line(context, R.string.plan_project_limit, isAdmin)

    /** The read-only line; a member also reads who can lift it. */
    fun frozenText(context: Context, isAdmin: Boolean): String = line(context, R.string.plan_project_frozen, isAdmin)

    private fun line(context: Context, text: Int, isAdmin: Boolean): String =
        if (isAdmin) context.getString(text) else "${context.getString(text)} ${context.getString(R.string.plan_ask_admin)}"

    fun upgrade(context: Context) {
        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(UPGRADE_URL)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }
}

/** `MobileWorkspacePlanNotice`: the line in footnote secondary ink, and Upgrade for an admin. */
@Composable
fun WorkspacePlanNoticeRow(message: String, offersUpgrade: Boolean, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val c = Starlings.colors
    Row(
        modifier.fillMaxWidth().semantics(mergeDescendants = true) { },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Text(message, Modifier.weight(1f), style = StarlingsType.footnote, color = c.secondary)
        if (offersUpgrade) {
            val upgrade = stringResource(R.string.plan_upgrade)
            Text(
                upgrade,
                Modifier
                    .clickable(role = Role.Button) { WorkspacePlanNotice.upgrade(context) }
                    .clearAndSetSemantics { contentDescription = upgrade; role = Role.Button; onClick { WorkspacePlanNotice.upgrade(context); true } },
                style = StarlingsType.footnote.copy(fontWeight = FontWeight.SemiBold),
                color = c.primary,
            )
        }
    }
}

/**
 * `MobileSubjectView`'s read-only notice: a project the plan holds
 * read-only says so above its panes. A failed read draws nothing; the
 * Worker still refuses the write.
 */
@Composable
internal fun SubjectPlanNotice(store: WorkStore, subject: SubjectRef) {
    if (!subject.isProject) return
    val context = LocalContext.current
    var frozen by remember(subject.id) { mutableStateOf(false) }
    LaunchedEffect(subject.id) {
        val plan = runCatching { store.client.call(WorkspacePlanNotice.route) }.getOrNull()
        frozen = WorkspacePlanNotice.isFrozen(subject.id, plan)
    }
    if (!frozen) return
    val admin = WorkspacePlanNotice.isAdmin(store.subjectState)
    WorkspacePlanNoticeRow(WorkspacePlanNotice.frozenText(context, admin), admin, Modifier.padding(horizontal = 16.dp).padding(top = 8.dp))
}
