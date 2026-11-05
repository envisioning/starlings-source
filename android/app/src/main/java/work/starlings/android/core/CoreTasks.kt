package work.starlings.android.core

import kotlinx.serialization.json.JsonObject
import java.text.Collator
import java.time.LocalDate
import java.util.Locale

/**
 * The tasks checklist's rules (core-kit `EntityListView.taskChecklist`): a
 * section per project, A to Z, "No Project" last; open tasks first by due
 * day (undated last), done ones at the bottom by recent activity; cancelled
 * ones never; done ones only with Show Completed, or for the few seconds a
 * task just ticked off lingers.
 */
object CoreTasks {
    /** `@AppStorage("crm.tasks.showCompleted")`, in the `core` preferences. */
    const val SHOW_COMPLETED_KEY = "crm.tasks.showCompleted"

    /** `scheduleLingerRemoval`: how long a ticked-off task stays, crossed out. */
    const val LINGER_MS = 3_000L

    /** `TaskProjectSection`. [title] is null for "No Project"; [projectId] prefills a new task there. */
    data class Section(val id: String, val title: String?, val projectId: String?, val records: List<JsonObject>)

    fun isDone(record: JsonObject): Boolean = record["status"].coreString() == "completed"

    /** The status a tick writes (`toggleTask`). */
    fun toggledStatus(record: JsonObject): String = if (isDone(record)) "pending" else "completed"

    private fun projectName(record: JsonObject): String? =
        record["project"].coreObject()?.get("title").coreString()?.takeIf { it.isNotEmpty() }

    /** `taskProjectSections`. */
    fun sections(records: List<JsonObject>, showCompleted: Boolean, lingering: Set<String>, locale: Locale = Locale.getDefault()): List<Section> {
        val visible = records.filter { record ->
            when (record["status"].coreString().orEmpty()) {
                "cancelled" -> false
                "completed" -> showCompleted || record.coreId in lingering
                else -> true
            }
        }
        val grouped = visible.groupBy { projectName(it).orEmpty() }
        val collator = Collator.getInstance(locale).apply { strength = Collator.SECONDARY }
        val named = grouped.keys.filter { it.isNotEmpty() }.sortedWith(collator)
        val sections = named.map { title ->
            val sorted = sorted(grouped[title].orEmpty(), lingering)
            Section(title, title, sorted.firstOrNull()?.get("project_id").coreString(), sorted)
        }.toMutableList()
        grouped[""]?.takeIf { it.isNotEmpty() }?.let { sections += Section(NO_PROJECT_ID, null, null, sorted(it, lingering)) }
        return sections
    }

    private const val NO_PROJECT_ID = "￿no-project"

    /** `sortedTasks`. A lingering task keeps its open place until it fades out. */
    fun sorted(records: List<JsonObject>, lingering: Set<String>): List<JsonObject> {
        fun done(r: JsonObject) = isDone(r) && r.coreId !in lingering
        fun due(r: JsonObject) = r["due_date"].coreString()?.takeIf { it.isNotEmpty() }
        fun recency(r: JsonObject) = r["completed_at"].coreString() ?: r["created_at"].coreString().orEmpty()
        return records.sortedWith { left, right ->
            val leftDone = done(left)
            val rightDone = done(right)
            if (leftDone != rightDone) return@sortedWith if (leftDone) 1 else -1
            if (!leftDone) {
                val l = due(left)
                val r = due(right)
                if (l != r) {
                    when {
                        l != null && r != null -> return@sortedWith l.compareTo(r)
                        l != null -> return@sortedWith -1
                        r != null -> return@sortedWith 1
                    }
                }
            }
            recency(right).compareTo(recency(left))
        }
    }

    /** `taskDueLabel`: the due day as a word when it is near, else the day. */
    sealed interface Due {
        data object Today : Due
        data object Tomorrow : Due
        data object Yesterday : Due
        data class Day(val date: LocalDate) : Due
    }

    fun due(record: JsonObject, today: LocalDate = LocalDate.now()): Due? {
        val raw = record["due_date"].coreString()?.takeIf { it.isNotEmpty() } ?: return null
        val date = runCatching { LocalDate.parse(raw) }.getOrNull() ?: return null
        return when (date) {
            today -> Due.Today
            today.plusDays(1) -> Due.Tomorrow
            today.minusDays(1) -> Due.Yesterday
            else -> Due.Day(date)
        }
    }

    /** `taskResponsibleLabel`: team work by its assignee (else Envisioning), client work as Client; unassigned says nothing. */
    sealed interface Responsible {
        data class Named(val name: String) : Responsible
        data object Envisioning : Responsible
        data object Client : Responsible
    }

    fun responsible(record: JsonObject): Responsible? = when (record["responsible_party"].coreString()) {
        "team" -> assigneeName(record)?.let(Responsible::Named) ?: Responsible.Envisioning
        "client" -> Responsible.Client
        else -> null
    }

    private fun assigneeName(record: JsonObject): String? {
        val assignee = record["assignee"].coreObject()
        return listOf(assignee?.get("name"), record["assignee_name"], assignee?.get("email"))
            .firstNotNullOfOrNull { it.coreString()?.takeIf { v -> v.isNotEmpty() } }
    }

    /** `taskCreatePrefill`: a section's + sets the new task's project. */
    fun prefill(section: Section): Map<String, String> = section.projectId?.let { mapOf("project_id" to it) }.orEmpty()
}
