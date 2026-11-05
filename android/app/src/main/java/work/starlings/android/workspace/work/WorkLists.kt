package work.starlings.android.workspace.work

import android.content.Context
import android.content.res.Resources
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import work.starlings.android.MineFilter
import work.starlings.android.MineOriginFilter
import work.starlings.android.MineSectionFilter
import work.starlings.android.R
import work.starlings.android.Search
import work.starlings.android.WorkPlan
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkFoldTitle
import work.starlings.android.ui.WorkIconButton
import work.starlings.android.ui.WorkMark
import work.starlings.android.ui.WorkMeta
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkRow
import work.starlings.android.ui.WorkSection
import work.starlings.contracts.CrmSubjectCountsResponse
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import work.starlings.contracts.CrmUnownedSubject
import work.starlings.contracts.InboxRecentEntry

/**
 * UNOWNED's filter (`UnownedSubjects`, Sources/MeetingCategory.swift): the
 * subject each row is on, the plan without the hidden subjects' rows, and
 * the subjects the menu offers. A row with no subject always stays.
 */
internal object UnownedSubjects {
    data class Choice(val key: String, val title: String, val count: Int)

    /** `kind:id` and the title, for a task from its keys, for an issue from the project it was read for. */
    fun subject(item: MineItem, issueSubjects: Map<String, CrmUnownedSubject>): Pair<String, String>? = when (item) {
        is MineItem.Task -> item.keys.subject(item.task.subjectTitle)?.let { "${it.kind.value}:${it.id}" to it.title }
        is MineItem.Issue -> issueSubjects[item.issue.id]?.let { "${it.kind.value}:${it.id}" to it.title }
    }

    fun shown(plan: WorkPlan<MineItem>, hidden: Set<String>, issueSubjects: Map<String, CrmUnownedSubject>): WorkPlan<MineItem> =
        if (hidden.isEmpty()) plan else plan.filtered { item -> subject(item, issueSubjects)?.let { it.first !in hidden } ?: true }

    /** Every subject with rows of [origin], hidden ones included, by title. */
    fun choices(plan: WorkPlan<MineItem>, origin: MineOriginFilter, issueSubjects: Map<String, CrmUnownedSubject>): List<Choice> {
        val found = linkedMapOf<String, Choice>()
        plan.order.filter { origin == MineOriginFilter.ALL || it.workOrigin.wire == origin.wire }.forEach { item ->
            val (key, title) = subject(item, issueSubjects) ?: return@forEach
            found[key] = found[key]?.let { it.copy(count = it.count + 1) } ?: Choice(key, title, 1)
        }
        return found.values.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.title })
    }

    /** `WorkSidebarPreferences.unownedOriginDefault`: tasks. */
    val defaultOrigin = MineOriginFilter.TASK
}

/** UNOWNED's choices on this device (`WorkSidebarPreferences.unownedOrigin`, `unownedHiddenSubjects`). */
internal class UnownedPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("work", Context.MODE_PRIVATE)

    var origin: MineOriginFilter
        get() = MineOriginFilter.entries.firstOrNull { it.wire == prefs.getString("unowned.origin", null) } ?: UnownedSubjects.defaultOrigin
        set(value) { prefs.edit().putString("unowned.origin", value.wire).apply() }

    var hidden: Set<String>
        get() = prefs.getStringSet("unowned.hiddenSubjects", null).orEmpty().toSet()
        set(value) { prefs.edit().putStringSet("unowned.hiddenSubjects", value).apply() }
}

/** `unownedFilterMenu`: Type with each count, then one tick per subject, then Show all subjects. */
@Composable
internal fun UnownedFilterMenu(
    all: WorkPlan<MineItem>,
    origin: MineOriginFilter,
    hidden: Set<String>,
    issueSubjects: Map<String, CrmUnownedSubject>,
    onOrigin: (MineOriginFilter) -> Unit,
    onHidden: (Set<String>) -> Unit,
) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    var open by remember { mutableStateOf(false) }
    val now = System.currentTimeMillis()
    val zone = java.time.ZoneId.systemDefault()
    val shown = UnownedSubjects.shown(all, hidden, issueSubjects)
    val subjects = UnownedSubjects.choices(all, origin, issueSubjects)
    Box {
        WorkIconButton(
            Icons.Filled.FilterList, r.getString(R.string.work_filter_unowned), { open = true },
            tint = if (origin == UnownedSubjects.defaultOrigin && hidden.isEmpty()) c.secondary else c.accent,
        )
        DropdownMenu(open, { open = false }, containerColor = c.elevated, shape = RoundedCornerShape(14.dp)) {
            MenuHeader(r.getString(R.string.work_type))
            MineOriginFilter.entries.forEach { option ->
                val count = shown.count(MineFilter(MineSectionFilter.ALL, option), now, zone)
                MenuChoice(r.getString(R.string.work_counted, originTitle(r, option), count), option == origin) { onOrigin(option); open = false }
            }
            if (subjects.isNotEmpty()) {
                HorizontalDivider(color = c.border)
                MenuHeader(r.getString(R.string.work_subjects_header))
                subjects.forEach { subject ->
                    MenuChoice(r.getString(R.string.work_counted, subject.title, subject.count), subject.key !in hidden) {
                        onHidden(if (subject.key in hidden) hidden - subject.key else hidden + subject.key)
                    }
                }
            }
            if (hidden.isNotEmpty()) {
                HorizontalDivider(color = c.border)
                DropdownMenuItem(
                    text = { Text(r.getString(R.string.work_show_all_subjects), style = StarlingsType.body, color = c.primary) },
                    onClick = { onHidden(emptySet()); open = false },
                )
            }
        }
    }
}

internal fun originTitle(r: Resources, filter: MineOriginFilter): String = r.getString(
    when (filter) {
        MineOriginFilter.ALL -> R.string.work_filter_all_work
        MineOriginFilter.TASK -> R.string.work_filter_tasks
        MineOriginFilter.ISSUE -> R.string.work_filter_issues
    },
)

/** Overview's Activity (`activitySection`): what happened on listed subjects this week, as the Worker caps it. */
internal object WorkActivity {
    fun matches(entry: InboxRecentEntry, query: String): Boolean =
        query.isBlank() || Search.matches(query, entry.title, entry.subject.title)

    /** "Acme · 29 Oct 2026, 14:05": the subject, then when. */
    fun detail(entry: InboxRecentEntry): String =
        listOfNotNull(entry.subject.title, TaskDates.parse(entry.date)?.let { WorkFormat.dateTime(it) }).joinToString(" · ")
}

/**
 * `activitySection`: "Latest 30 entries · Past 7 days", then each entry
 * opening its subject's History. A source the Worker could not read says
 * so, with Retry.
 */
@Composable
internal fun ActivityBlock(store: WorkStore, query: String, folded: Boolean, onFold: () -> Unit, onOpen: (SubjectRef) -> Unit) {
    val r = LocalContext.current.resources
    val inbox = store.inbox
    val entries = inbox?.recent.orEmpty().filter { WorkActivity.matches(it, query) }
    WorkSection(header = { WorkFoldTitle(r.getString(R.string.work_activity), folded, r.getString(R.string.work_folded), r.getString(R.string.work_open), onFold) }) {
        if (folded) return@WorkSection
        WorkNote(r.getString(R.string.work_activity_window))
        entries.forEach { entry ->
            WorkRow(entry.title, onClick = { onOpen(SubjectRef(entry.subject.kind, entry.subject.id, entry.subject.title)) }, leading = { WorkMark(Icons.Outlined.Schedule) }) {
                WorkMeta(WorkActivity.detail(entry))
            }
        }
        if (store.isLoading && entries.isEmpty()) WorkNote(r.getString(R.string.work_loading))
        val partial = inbox?.recentPartial.orEmpty().isNotEmpty() || store.inboxError != null
        if (entries.isEmpty() && !partial && !store.isLoading) {
            WorkNote(r.getString(if (query.isBlank()) R.string.work_no_activity_week else R.string.work_nothing_matches))
        }
        if (partial) WorkErrorNotice(r.getString(R.string.work_activity_partial), retry = r.getString(R.string.work_retry), onRetry = { store.act { store.refreshInbox() } })
    }
}

/** `isAskingLogin`: "Your GitHub username", "Finds the issues assigned to you.", Cancel and Save. */
@Composable
internal fun GithubLoginDialog(onDismiss: () -> Unit, onSave: (String) -> Unit) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    var draft by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.elevated,
        title = { Text(r.getString(R.string.work_your_github_username), style = StarlingsType.headline, color = c.primary) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(r.getString(R.string.work_finds_issues), style = StarlingsType.footnote, color = c.secondary)
                StarlingsField(draft, { draft = it.replace('\n', ' ') }, placeholder = r.getString(R.string.work_github_placeholder))
            }
        },
        confirmButton = { TextButton({ onSave(draft); onDismiss() }) { Text(r.getString(R.string.work_save), color = c.primary) } },
        dismissButton = { TextButton(onDismiss) { Text(r.getString(R.string.work_cancel), color = c.primary) } },
    )
}

/** `CrmSubjectSortOption`: how a Browse group orders its rows. A choice never asks Core again. */
internal enum class SubjectSort(val id: String) {
    BUSIEST("busiest"), ALPHABETICAL("alphabetical");

    /** Overdue first, then open count, then title; or the title alone. */
    fun sorted(subjects: List<CrmSubjectWire>): List<CrmSubjectWire> = when (this) {
        ALPHABETICAL -> subjects.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.title })
        BUSIEST -> subjects.sortedWith(
            compareByDescending<CrmSubjectWire> { it.overdueTasks ?: 0 }.thenByDescending { it.openTasks ?: 0 }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.title },
        )
    }

    companion object {
        /** Anything unrecognized is Busiest First, never the server's order. */
        fun of(id: String?): SubjectSort = entries.firstOrNull { it.id == id } ?: BUSIEST
    }
}

/** The Browse status filters (`SubjectStatusRegistry.<kind>.filter`) and their badges (`CrmSubjectCountsResponse`). */
internal object SubjectStatusFilter {
    const val DEFAULT = "open"
    val project = listOf("open", "Active", "Paused", "Archived", "all")
    val lead = listOf("open") + LeadForm.statuses + "all"

    fun options(kind: CrmSubjectKind): List<String> = if (kind == CrmSubjectKind.LEAD) lead else project

    /** One badge per option, from one bucket; a status with no rows is zero. */
    fun badges(bucket: Map<String, Long>?, kind: CrmSubjectKind): Map<String, Int> = options(kind).associateWith { (bucket?.get(it) ?: 0L).toInt() }

    fun internal(counts: CrmSubjectCountsResponse) = badges(counts.isInternal, CrmSubjectKind.PROJECT)
    fun client(counts: CrmSubjectCountsResponse) = badges(counts.client, CrmSubjectKind.PROJECT)
    fun leads(counts: CrmSubjectCountsResponse) = badges(counts.counts, CrmSubjectKind.LEAD)

    /** `CrmSubjectStatusOption.title(for:)`, the filter's own two words included. */
    fun title(r: Resources, id: String): String = when (id) {
        "open" -> r.getString(R.string.work_open_menu)
        "all" -> r.getString(R.string.work_status_all)
        else -> subjectStatusTitle(r, id)
    }
}

/**
 * Browse's organization buckets (`organizationBuckets`): rows by
 * organization, a bucket keeping the place of its first row. A line is
 * drawn above an organization with more than one row, and above NO
 * ORGANIZATION when there are organizations above it.
 */
internal object OrganizationBuckets {
    data class Bucket(val key: String, val name: String?, val named: Boolean, val rows: List<CrmSubjectWire>)

    fun of(subjects: List<CrmSubjectWire>): List<Bucket> {
        val order = mutableListOf<String>()
        val named = mutableMapOf<String, MutableList<CrmSubjectWire>>()
        val loose = mutableListOf<CrmSubjectWire>()
        subjects.forEach { subject ->
            val id = subject.organizationId?.takeIf { it.isNotEmpty() }
            if (id == null) { loose += subject; return@forEach }
            if (id !in named) order += id
            named.getOrPut(id) { mutableListOf() } += subject
        }
        val buckets = order.map { id ->
            val rows = named.getValue(id)
            Bucket(id, rows.first().organizationName ?: rows.first().subtitle, rows.size > 1, rows)
        }
        return if (loose.isEmpty()) buckets else buckets + Bucket("none", null, order.isNotEmpty(), loose)
    }
}

@Composable
internal fun BucketLine(text: String) {
    Text(
        text.uppercase(),
        Modifier.padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 2.dp),
        style = StarlingsType.caption2.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold),
        color = Starlings.colors.secondary,
    )
}
