package work.starlings.android

import java.time.LocalDate
import java.time.ZoneId

/**
 * What "my work" is and the order it is owed: `Sources/WorkItems.swift` and
 * `packages/contracts/src/work-items.ts`, held to `fixtures/work-items.json`.
 * A task from Core and an issue from GitHub answer one question, so the plan
 * is computed here once. Change the rules in the fixture first.
 */
enum class WorkItemOrigin(val wire: String) { TASK("task"), ISSUE("issue") }

/**
 * Where a row sits in the plan, in plan order. `INBOX` is unfiled work, whatever
 * its date. The date sections compare civil days. Every issue is `UNDATED`.
 */
enum class WorkSection(val wire: String) { INBOX("inbox"), LATE("late"), TODAY("today"), SOON("soon"), UNDATED("undated") }

/** Mine's section menu (`MINE_SECTION_FILTERS`). `FOCUS` is Home's slice, not a section. */
enum class MineSectionFilter(val wire: String, val title: String) {
    ALL("all", "All open"),
    FOCUS("focus", "Focus"),
    INBOX("inbox", "Unfiled"),
    LATE("late", "Late"),
    TODAY("today", "Today"),
    SOON("soon", "Soon"),
    UNDATED("undated", "Undated");

    /** The plan section this filter keeps; null for `ALL` and `FOCUS`. */
    val section: WorkSection? get() = WorkSection.entries.firstOrNull { it.wire == wire }
}

/** Mine's origin menu (`MINE_ORIGIN_FILTERS`). */
enum class MineOriginFilter(val wire: String, val title: String) {
    ALL("all", "All work"),
    TASK("task", "Tasks"),
    ISSUE("issue", "GitHub issues"),
}

/** Mine's two contextual axes. A filter narrows the plan and never reorders it. */
data class MineFilter(val section: MineSectionFilter = MineSectionFilter.ALL, val origin: MineOriginFilter = MineOriginFilter.ALL) {
    val isDefault: Boolean get() = this == MineFilter()
}

/**
 * Where a piece of work sits in the pipeline, whichever store holds it
 * (docs/BOARD.md). `title` is the column label (`WORK_STAGE_TITLES`).
 */
enum class WorkStage(val wire: String, val title: String, internal val taskStatus: String, internal val issueLabel: String?) {
    QUEUED("queued", "QUEUED", "pending", null),
    DOING("doing", "DOING", "in_progress", "agent:building"),
    REVIEW("review", "REVIEW", "review", "agent:review"),
    BLOCKED("blocked", "BLOCKED", "blocked", "agent:failed"),
    DONE("done", "DONE", "completed", null),
    DROPPED("dropped", "DROPPED", "cancelled", null);

    val isFinished: Boolean get() = this == DONE || this == DROPPED

    companion object {
        /** Every label that means a stage, so a write can take all of them off. */
        internal val allIssueLabels = setOf("agent:queued", "agent:building", "agent:review", "agent:failed")
    }
}

/** The board's holder menu (`WORK_HOLDER_CHOICES`). `agent:<email>` filters are built at runtime. */
enum class WorkHolderChoice(val wire: String, val title: String) {
    ANYONE("anyone", "Anyone"),
    PEOPLE("people", "People"),
    AGENTS("agents", "Any agent"),
}

/** The task due filter (`WORK_DUE_CHOICES`). */
enum class WorkDueFilter(val wire: String, val title: String) { ANY("any", "Any date"), OVERDUE("overdue", "Overdue") }

/** The task side filter (`WORK_SIDE_CHOICES`). */
enum class WorkSideFilter(val wire: String, val title: String) {
    ANY("any", "Any side"),
    TEAM("team", "Team"),
    CLIENT("client", "Client"),
    UNASSIGNED("unassigned", "Unassigned"),
}

/** The phase of an event subject (docs/EVENTS.md). Upcoming and live are open; past is closed. */
enum class EventPhase(val wire: String, val label: String) {
    UPCOMING("upcoming", "Upcoming"),
    LIVE("live", "Today"),
    PAST("past", "Past");

    val isOpen: Boolean get() = this != PAST
}

/**
 * The little a row exposes to be planned, staged and held: Swift's
 * `WorkItem`, `WorkCard` and `WorkHeldCard` in one. Each surface adapts its
 * own task and issue shapes. Task fields are read for a task, issue fields
 * for an issue. Dates are epoch ms; null is undated, and so is a date nobody
 * could parse.
 */
interface WorkCard {
    /** Stable identity; for an issue, its `owner/repo#number`. */
    val workId: String
    val workOrigin: WorkItemOrigin
    /** Completed/cancelled task, or closed issue. Done work is never planned. */
    val workIsDone: Boolean
    /** Belongs to a subject. Every issue is filed by construction. */
    val workIsFiled: Boolean
    val workDueDate: Long?
    val workUpdatedAt: Long?
    /** `owner/repo#number` a promoted task points at. */
    val workGithubRef: String?
    /** Task: Core's status string, verbatim. */
    val workTaskStatus: String? get() = null
    /** Issue: `open` or `closed`. */
    val workIssueState: String? get() = null
    /** Issue: `completed`, `not_planned`, `duplicate`, `reopened`, or null. */
    val workIssueStateReason: String? get() = null
    /** Issue: label names as GitHub returns them. */
    val workLabels: List<String> get() = emptyList()
    /** Task: the Core person it is assigned to; null when nobody. */
    val workAssignee: String? get() = null
    /** Task: `team`, `client` or `unassigned`. */
    val workResponsibleParty: String? get() = null
    /** Issue: the GitHub logins assigned. */
    val workAssignees: List<String> get() = emptyList()
}

/** Every planned row, sections concatenated in section order. */
data class WorkPlan<T : WorkCard>(
    val order: List<T>,
    val sections: Map<WorkSection, List<T>>,
    val sectionOf: Map<String, WorkSection>,
) {
    /** Planned rows after dedupe: the honest size of the plate. */
    val openCount: Int get() = order.size
    val lateCount: Int get() = count(WorkSection.LATE)

    fun items(section: WorkSection): List<T> = sections[section] ?: emptyList()
    fun count(section: WorkSection): Int = items(section).size

    /** Narrow a planned pile without re-running its rules: search runs after promotion dedupe. */
    fun filtered(include: (T) -> Boolean): WorkPlan<T> {
        val kept = WorkSection.entries.associateWith { items(it).filter(include) }.filterValues { it.isNotEmpty() }
        val sectionOf = kept.flatMap { (s, rows) -> rows.map { it.workId to s } }.toMap()
        return WorkPlan(WorkSection.entries.flatMap { kept[it] ?: emptyList() }, kept, sectionOf)
    }

    /**
     * Mine's contextual filter after planning. `FOCUS` keeps the rows
     * `WorkItems.focus` puts first, without its Next fill.
     */
    fun filtered(filter: MineFilter, now: Long, zone: ZoneId): WorkPlan<T> {
        val focused = if (filter.section == MineSectionFilter.FOCUS) WorkItems.focusRows(this, now, zone).map { it.workId }.toSet() else null
        return filtered { item ->
            val sectionMatches = focused?.contains(item.workId) ?: (filter.section.section?.let { sectionOf[item.workId] == it } ?: true)
            val originMatches = filter.origin == MineOriginFilter.ALL || item.workOrigin.wire == filter.origin.wire
            sectionMatches && originMatches
        }
    }

    /** How many rows a filter would leave, for the count beside a menu row. */
    fun count(filter: MineFilter, now: Long, zone: ZoneId): Int = filtered(filter, now, zone).openCount

    companion object {
        fun <T : WorkCard> empty() = WorkPlan<T>(emptyList(), emptyMap(), emptyMap())
    }
}

/**
 * The slice of Mine that Home shows (docs/WORK.md §1): late, then due today,
 * then started work. When all three are empty, `next` is true and `rows`
 * holds the first soon rows.
 */
data class MineFocus<T : WorkCard>(val rows: List<T>, val next: Boolean, val lateCount: Int, val todayCount: Int) {
    val isEmpty: Boolean get() = rows.isEmpty()

    /** "2 overdue · 1 due today", or null when nothing is late or due today. */
    val summary: String?
        get() = listOfNotNull(
            if (lateCount > 0) "$lateCount overdue" else null,
            if (todayCount > 0) "$todayCount due today" else null,
        ).takeIf { it.isNotEmpty() }?.joinToString(" · ")

    /** Whether a row is late, for the emphasis Home gives it. */
    fun isLate(item: T): Boolean = rows.take(lateCount).any { it.workId == item.workId }
}

/** The one write a stage move makes. An issue write carries the whole label set (GitHub replaces on PATCH). */
sealed interface WorkStageWrite {
    data class Task(val status: String) : WorkStageWrite
    data class Issue(val state: String, val stateReason: String?, val labels: List<String>) : WorkStageWrite
}

/** Every card in its column. */
data class WorkBoard<T : WorkCard>(val columns: Map<WorkStage, List<T>>, val stageOf: Map<String, WorkStage>) {
    fun items(stage: WorkStage): List<T> = columns[stage] ?: emptyList()
}

object WorkItems {
    /** How many soon rows fill Home when nothing is late, due today or started. */
    const val FOCUS_NEXT_ROWS = 3

    /** The started stages: work a person picked up stays in view without a date. */
    private val focusStages = setOf(WorkStage.DOING, WorkStage.REVIEW, WorkStage.BLOCKED)

    /**
     * Plan a mixed pile. A live task with a `githubRef` claims that issue: the
     * task is the one row. A done task claims nothing. Late, today and soon
     * sort by due ascending; inbox and undated by recent movement.
     */
    fun <T : WorkCard> plan(items: List<T>, now: Long, zone: ZoneId): WorkPlan<T> = plan(items, now, zone) { it.workIsDone }

    /** `plan` with the open test supplied: the board and Unowned hand in their own. */
    private fun <T : WorkCard> plan(items: List<T>, now: Long, zone: ZoneId, isDone: (T) -> Boolean): WorkPlan<T> {
        val claimed = items.filter { it.workOrigin == WorkItemOrigin.TASK && !isDone(it) }.mapNotNull { it.workGithubRef }.toSet()
        val rows = items.filter { !isDone(it) && !(it.workOrigin == WorkItemOrigin.ISSUE && it.workId in claimed) }
        val sectionOf = rows.associate { it.workId to classify(it, now, zone) }
        val sections = WorkSection.entries.associateWith { s ->
            val inSection = rows.filter { classify(it, now, zone) == s }
            when (s) {
                WorkSection.INBOX, WorkSection.UNDATED -> inSection.sortedWith(byRecentMovement)
                else -> inSection.sortedWith(byDue)
            }
        }.filterValues { it.isNotEmpty() }
        return WorkPlan(WorkSection.entries.flatMap { sections[it] ?: emptyList() }, sections, sectionOf)
    }

    private fun classify(item: WorkCard, now: Long, zone: ZoneId): WorkSection =
        if (!item.workIsFiled) WorkSection.INBOX else dateSection(item.workDueDate, now, zone)

    /**
     * Where a due date falls, with filing left out: the one civil-day rule.
     * Work due earlier today is due today, not late.
     */
    fun dateSection(due: Long?, now: Long, zone: ZoneId): WorkSection {
        due ?: return WorkSection.UNDATED
        val day = Upcoming.civilDay(due, zone)
        val today = Upcoming.civilDay(now, zone)
        return when {
            day < today -> WorkSection.LATE
            day == today -> WorkSection.TODAY
            else -> WorkSection.SOON
        }
    }

    // Focus (docs/WORK.md §1)

    /**
     * Plan Home from Mine's plan. Dates ignore filing, so an unfiled late task
     * is late on Home. Late and today keep due order; started rows follow by
     * recent movement.
     */
    fun <T : WorkCard> focus(plan: WorkPlan<T>, now: Long, zone: ZoneId): MineFocus<T> {
        val late = mutableListOf<T>()
        val today = mutableListOf<T>()
        val started = mutableListOf<T>()
        val soon = mutableListOf<T>()
        for (item in plan.order) {
            when (val section = dateSection(item.workDueDate, now, zone)) {
                WorkSection.LATE -> late += item
                WorkSection.TODAY -> today += item
                else -> {
                    if (stage(item) in focusStages) started += item
                    else if (section == WorkSection.SOON) soon += item
                }
            }
        }
        val rows = late.sortedWith(byDue) + today.sortedWith(byDue) + started.sortedWith(byRecentMovement)
        if (rows.isNotEmpty()) return MineFocus(rows, next = false, lateCount = late.size, todayCount = today.size)
        return MineFocus(soon.sortedWith(byDue).take(FOCUS_NEXT_ROWS), next = true, lateCount = 0, todayCount = 0)
    }

    /** The focus rows without the Next fill, for Mine's Focus filter. */
    fun <T : WorkCard> focusRows(plan: WorkPlan<T>, now: Long, zone: ZoneId): List<T> =
        focus(plan, now, zone).let { if (it.next) emptyList() else it.rows }

    // Events (docs/EVENTS.md)

    /** The date is the status: earlier day is past, same day is live, later or undated is upcoming. */
    fun eventPhase(eventDate: String?, now: Long, zone: ZoneId): EventPhase {
        val days = eventDaysUntil(eventDate, now, zone) ?: return EventPhase.UPCOMING
        return when {
            days < 0 -> EventPhase.PAST
            days == 0 -> EventPhase.LIVE
            else -> EventPhase.UPCOMING
        }
    }

    /** Civil days from today in `zone` to a CMS `YYYY-MM-DD`; null when undated or not a real date. */
    fun eventDaysUntil(eventDate: String?, now: Long, zone: ZoneId): Int? {
        val day = civilDay(eventDate) ?: return null
        return (day.toEpochDay() - Upcoming.civilDay(now, zone)).toInt()
    }

    /** The sidebar's countdown: days left, or the phase wording for today, past and undated. */
    fun eventCountdownLabel(eventDate: String?, now: Long, zone: ZoneId): String {
        val days = eventDaysUntil(eventDate, now, zone) ?: return EventPhase.UPCOMING.label
        return when {
            days < 0 -> EventPhase.PAST.label
            days == 0 -> EventPhase.LIVE.label
            days == 1 -> "1 day left"
            else -> "$days days left"
        }
    }

    private val civilDate = Regex("""^(\d{4})-(\d{2})-(\d{2})""")

    /** A plain `YYYY-MM-DD` as a Gregorian day, with no zone to apply. `2026-02-31` is nothing. */
    fun civilDay(date: String?): LocalDate? {
        val m = civilDate.find(date ?: return null) ?: return null
        val (y, mo, d) = m.destructured
        return runCatching { LocalDate.of(y.toInt(), mo.toInt(), d.toInt()) }.getOrNull()
    }

    // Stages (docs/BOARD.md)

    /**
     * The stage of one row. A task maps its status; an unknown status is
     * queued. A closed issue is dropped for not_planned or duplicate, else
     * done. An open issue's stage label decides: blocked over review over doing.
     */
    fun stage(item: WorkCard): WorkStage = when (item.workOrigin) {
        WorkItemOrigin.TASK -> when (item.workTaskStatus ?: "") {
            "pending", "proposed" -> WorkStage.QUEUED
            "in_progress" -> WorkStage.DOING
            "review" -> WorkStage.REVIEW
            "blocked" -> WorkStage.BLOCKED
            "completed" -> WorkStage.DONE
            "cancelled", "declined" -> WorkStage.DROPPED
            else -> WorkStage.QUEUED
        }
        WorkItemOrigin.ISSUE -> if (item.workIssueState == "closed") {
            val reason = item.workIssueStateReason
            if (reason == "not_planned" || reason == "duplicate") WorkStage.DROPPED else WorkStage.DONE
        } else {
            val labels = item.workLabels.map { it.lowercase() }.toSet()
            when {
                WorkStage.BLOCKED.issueLabel in labels -> WorkStage.BLOCKED
                WorkStage.REVIEW.issueLabel in labels -> WorkStage.REVIEW
                WorkStage.DOING.issueLabel in labels -> WorkStage.DOING
                else -> WorkStage.QUEUED
            }
        }
    }

    /**
     * The write a stage move makes. A task sends the stage's status verbatim.
     * An issue drops every stage label, keeps the rest in order, and appends the
     * stage's own label; done and dropped close it.
     */
    fun write(stage: WorkStage, item: WorkCard): WorkStageWrite {
        if (item.workOrigin == WorkItemOrigin.TASK) return WorkStageWrite.Task(stage.taskStatus)
        val kept = item.workLabels.filter { it.lowercase() !in WorkStage.allIssueLabels }
        return when (stage) {
            WorkStage.DONE -> WorkStageWrite.Issue("closed", "completed", kept)
            WorkStage.DROPPED -> WorkStageWrite.Issue("closed", "not_planned", kept)
            WorkStage.QUEUED -> WorkStageWrite.Issue("open", null, kept)
            else -> WorkStageWrite.Issue("open", null, kept + stage.issueLabel!!)
        }
    }

    /** An open issue with any stage label, `agent:queued` included, is an agent's. Every task is a person's. */
    fun isHeldByAgent(item: WorkCard): Boolean {
        if (item.workOrigin != WorkItemOrigin.ISSUE || stage(item).isFinished) return false
        return item.workLabels.any { it.lowercase() in WorkStage.allIssueLabels }
    }

    /** The holder filter: `anyone`, `people`, `agents`, or `agent:<email>` against the project's agent. Unknown shows all. */
    fun passesHolderFilter(item: WorkCard, filter: String, agentEmail: String?): Boolean = when {
        filter == WorkHolderChoice.PEOPLE.wire -> !isHeldByAgent(item)
        filter == WorkHolderChoice.AGENTS.wire -> isHeldByAgent(item)
        filter.startsWith("agent:") -> {
            val wanted = filter.removePrefix("agent:").trim().lowercase()
            isHeldByAgent(item) && (agentEmail ?: "").trim().lowercase() == wanted
        }
        else -> true
    }

    /**
     * The task filters. Overdue is open work in the `late` civil
     * day. An issue shows only while both filters are `ANY`. No side reads as
     * `unassigned`.
     */
    fun passesTaskFilter(item: WorkCard, due: WorkDueFilter, side: WorkSideFilter, now: Long, zone: ZoneId): Boolean {
        if (due == WorkDueFilter.ANY && side == WorkSideFilter.ANY) return true
        if (item.workOrigin != WorkItemOrigin.TASK) return false
        if (due == WorkDueFilter.OVERDUE) {
            if (stage(item).isFinished) return false
            if (dateSection(item.workDueDate, now, zone) != WorkSection.LATE) return false
        }
        if (side != WorkSideFilter.ANY) {
            val party = item.workResponsibleParty?.takeIf { it.isNotEmpty() } ?: WorkSideFilter.UNASSIGNED.wire
            if (party != side.wire) return false
        }
        return true
    }

    /** Finished rows, newest movement first. `finishedSince` drops older ones and keeps undated ones. */
    fun <T : WorkCard> recentlyClosed(items: List<T>, finishedSince: Long? = null): List<T> =
        items.filter { stage(it).isFinished }
            .filter { finishedSince == null || it.workUpdatedAt == null || it.workUpdatedAt!! >= finishedSince }
            .sortedWith(byRecentMovement)

    /**
     * Every card in its column. A live task with a `githubRef` claims its
     * issue, as in `plan`. Open columns keep the plan's order; finished
     * columns order by movement, newest first.
     */
    fun <T : WorkCard> board(items: List<T>, now: Long, zone: ZoneId, finishedSince: Long? = null): WorkBoard<T> {
        val stages = items.associate { it.workId to stage(it) }
        val columns = mutableMapOf<WorkStage, MutableList<T>>()
        val stageOf = mutableMapOf<String, WorkStage>()
        val open = items.filter { !stages.getValue(it.workId).isFinished }
        for (item in plan(open, now, zone) { false }.order + recentlyClosed(items, finishedSince)) {
            val s = stages.getValue(item.workId)
            columns.getOrPut(s) { mutableListOf() } += item
            stageOf[item.workId] = s
        }
        return WorkBoard(columns, stageOf)
    }

    // Unowned (docs/BOARD.md §Unowned)

    /**
     * Nobody on our side holds it. A task with no assignee, unless the client
     * owes it; an issue with no assignee and no stage label.
     */
    fun isUnowned(item: WorkCard): Boolean = when (item.workOrigin) {
        WorkItemOrigin.TASK -> (item.workAssignee ?: "").isBlank() && item.workResponsibleParty != "client"
        WorkItemOrigin.ISSUE -> item.workAssignees.all { it.isBlank() } &&
            item.workLabels.none { it.lowercase() in WorkStage.allIssueLabels }
    }

    /**
     * Every open card nobody holds, in the plan's order. A proposed task is
     * never a card. The plan dedupes first, so a claimed issue is never judged.
     */
    fun <T : WorkCard> unowned(items: List<T>, now: Long, zone: ZoneId): List<T> {
        val open = items.filter { !stage(it).isFinished && !(it.workOrigin == WorkItemOrigin.TASK && it.workTaskStatus == "proposed") }
        return plan(open, now, zone) { false }.order.filter { isUnowned(it) }
    }

    /** The oldest debt first; ties break on id. */
    private val byDue = compareBy<WorkCard>({ it.workDueDate ?: Long.MIN_VALUE }, { it.workId })

    /** Recent movement first, silence last; ties break on id. */
    private val byRecentMovement = compareBy<WorkCard>({ it.workUpdatedAt == null }, { -(it.workUpdatedAt ?: 0L) }, { it.workId })
}
