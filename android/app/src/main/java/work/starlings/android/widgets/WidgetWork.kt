package work.starlings.android.widgets

import work.starlings.android.WorkItems
import work.starlings.android.workspace.home.HomeLinks
import work.starlings.android.workspace.work.MineItem
import work.starlings.android.workspace.work.MineWork
import work.starlings.contracts.CrmIssueWire
import work.starlings.contracts.CrmMyTaskWire
import java.time.ZoneId

/**
 * One of today's tasks for the Today's work widget: `WatchBridgeSnapshot.WorkRow`,
 * planned the way `MobileMyWorkStore.publishTodayWork` plans it. Title,
 * subject and the web path a tap opens; never notes.
 */
data class WidgetWorkRow(
    val id: String,
    val title: String,
    val subjectTitle: String?,
    val overdue: Boolean,
    /** Where a tap goes: the subject on its Tasks pane, or the task for one Core kept without a subject. */
    val path: String,
)

object WidgetWork {
    /**
     * The late and due-today rows of Home's focus (`HomeFocus.datedRows`),
     * tasks only, because an issue has no due date. Nothing when Home's
     * focus falls back to Next: the widget's count line says nothing else.
     */
    fun rows(tasks: List<CrmMyTaskWire>, issues: List<CrmIssueWire>, now: Long, zone: ZoneId = ZoneId.systemDefault()): List<WidgetWorkRow> {
        val focus = WorkItems.focus(MineWork.plan(tasks, issues, "", now, zone), now, zone)
        if (focus.next) return emptyList()
        val late = focus.rows.take(focus.lateCount).map { it.workId }.toSet()
        return focus.rows.take(focus.lateCount + focus.todayCount)
            .filterIsInstance<MineItem.Task>()
            .map { item ->
                val t = item.task
                WidgetWorkRow(t.id, t.title, t.subjectTitle, overdue = t.id in late, path = door(t))
            }
    }

    /**
     * `TodayWorkView.door`: the subject on Tasks, or the task for one Core
     * kept without a subject. The subject is the project, then the lead,
     * then the partner organization, as iOS reads it.
     */
    fun door(t: CrmMyTaskWire): String {
        val subject = t.projectId?.let { "project" to it }
            ?: t.leadId?.let { "lead" to it }
            ?: t.organizationId?.let { "organization" to it }
        return subject?.let { (kind, id) -> HomeLinks.subject(kind, id, listOf("pane" to "tasks")) } ?: HomeLinks.task(t.id)
    }

    /** The two counts of the summary line, "2 overdue · 1 due today". */
    fun counts(rows: List<WidgetWorkRow>): Pair<Int, Int> {
        val overdue = rows.count { it.overdue }
        return overdue to rows.size - overdue
    }
}
