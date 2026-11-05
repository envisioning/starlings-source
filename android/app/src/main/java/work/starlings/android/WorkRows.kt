package work.starlings.android

import java.time.LocalDate
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * How a subject row reads on the Work rail: `Sources/WorkSubjectRowSpec.swift`,
 * held to `fixtures/work-rows.json`. Unread is bold and dotted unless muted;
 * muted or subdued is quiet; a starred row carries a badge. The label reads
 * the title, then unread, starred, muted.
 */
data class WorkSubjectRowSpec(
    val showsUnread: Boolean,
    val showsStarBadge: Boolean,
    val weight: Weight,
    val ink: Ink,
    val trailing: Trailing,
    val accessibilityLabel: String,
) {
    enum class Weight(val wire: String) { SEMIBOLD("semibold"), MEDIUM("medium"), REGULAR("regular") }
    enum class Ink(val wire: String) { PRIMARY("primary"), SECONDARY("secondary") }
    enum class Trailing(val wire: String) { UNREAD_DOT("unreadDot"), NONE("none") }

    companion object {
        fun of(title: String, hasUnread: Boolean, isStarred: Boolean, isMuted: Boolean, isSubdued: Boolean): WorkSubjectRowSpec {
            val unread = hasUnread && !isMuted
            val quiet = isSubdued || isMuted
            val label = buildString {
                append(title)
                if (unread) append(", unread message")
                if (isStarred) append(", starred")
                if (isMuted) append(", muted")
            }
            return WorkSubjectRowSpec(
                showsUnread = unread,
                showsStarBadge = isStarred,
                weight = if (unread) Weight.SEMIBOLD else if (quiet) Weight.REGULAR else Weight.MEDIUM,
                ink = if (quiet && !unread) Ink.SECONDARY else Ink.PRIMARY,
                trailing = if (unread) Trailing.UNREAD_DOT else Trailing.NONE,
                accessibilityLabel = label,
            )
        }
    }
}

/** A subject as the rail ranker reads it (`WorkRankSubjectShape`). */
data class WorkRankSubject(
    val id: String,
    val title: String,
    /** `lead`, `project`, `organization` or `event`. */
    val kind: String,
    val openTasks: Int = 0,
    val overdueTasks: Int = 0,
    val lastActivityAt: String? = null,
    /** CMS `YYYY-MM-DD`, read for an event only. */
    val eventDate: String? = null,
)

/** The per-person signals the subject list does not carry. */
data class WorkRankSignals(val starred: Boolean = false, val directAttention: Boolean = false, val unread: Boolean = false)

/** The ranker's points and caps (`DEFAULT_WORK_RANK_CRITERIA`), as data. */
data class WorkRankCriteria(
    val railLimit: Int = 12,
    val starred: Double = 1_000.0,
    val directAttention: Double = 500.0,
    val unread: Double = 150.0,
    val overduePerTask: Double = 90.0,
    val overdueCap: Int = 3,
    val eventToday: Double = 120.0,
    val eventSoonBase: Double = 90.0,
    val eventSoonDecayPerDay: Double = 10.0,
    val eventHorizonDays: Int = 14,
    val openWorkPerTask: Double = 18.0,
    val openWorkCap: Int = 5,
    val recentActivityMax: Double = 80.0,
    val activityHalfLifeMs: Long = 3L * 86_400_000,
    val staleAfterMs: Long = 7L * 86_400_000,
    val staleWork: Double = 24.0,
) {
    companion object {
        val DEFAULT = WorkRankCriteria()
    }
}

enum class WorkRankReasonCode(val wire: String) {
    STARRED("starred"),
    DIRECT_ATTENTION("direct_attention"),
    UNREAD("unread"),
    OVERDUE("overdue"),
    EVENT_TODAY("event_today"),
    EVENT_SOON("event_soon"),
    OPEN_WORK("open_work"),
    RECENT_ACTIVITY("recent_activity"),
    STALE_WORK("stale_work"),
}

data class WorkRankReason(val code: WorkRankReasonCode, val points: Double)

data class RankedWorkSubject(val subject: WorkRankSubject, val score: Double, val reasons: List<WorkRankReason>)

/**
 * What floats on the Work rail: `packages/contracts/src/work-ranker.ts` (the
 * source of truth) and `WorkSubjectRanker` in `Sources/WorkSurface.swift`,
 * held to `fixtures/work-ranker.json`.
 */
object WorkSubjectRanker {
    private const val DAY_MS = 86_400_000L

    /**
     * Score every subject and sort by score descending. Ties break on the
     * latest activity, then the title (case-insensitive, as Swift), then the id.
     */
    fun rank(
        subjects: List<WorkRankSubject>,
        signals: Map<String, WorkRankSignals> = emptyMap(),
        now: Long,
        criteria: WorkRankCriteria = WorkRankCriteria.DEFAULT,
    ): List<RankedWorkSubject> =
        subjects.map { rankOne(it, signals[it.id] ?: WorkRankSignals(), now, criteria) }.sortedWith(
            compareByDescending<RankedWorkSubject> { it.score }
                .thenByDescending { Upcoming.parse(it.subject.lastActivityAt) ?: Long.MIN_VALUE }
                .thenComparator { a, b -> a.subject.title.compareTo(b.subject.title, ignoreCase = true) }
                .thenBy { it.subject.id },
        )

    /**
     * The rail: the ranking cut to `railLimit`. `holding` keeps the open subject
     * at the index it had in `previous`, so reading it does not slide it away.
     */
    fun rail(
        subjects: List<WorkRankSubject>,
        signals: Map<String, WorkRankSignals> = emptyMap(),
        now: Long,
        criteria: WorkRankCriteria = WorkRankCriteria.DEFAULT,
        holding: String? = null,
        previous: List<String> = emptyList(),
    ): List<RankedWorkSubject> {
        val ranked = rank(subjects, signals, now, criteria).toMutableList()
        val from = ranked.indexOfFirst { it.subject.id == holding }
        val was = previous.indexOf(holding)
        if (holding != null && from >= 0 && was >= 0 && from != was) {
            val held = ranked.removeAt(from)
            ranked.add(min(was, ranked.size), held)
        }
        return ranked.take(max(0, criteria.railLimit))
    }

    /**
     * Points add up per reason: the three signals, overdue tasks to a cap, an
     * event today or within the horizon (decaying per day), open work to a cap,
     * activity halving every half-life, and old open work as stale.
     */
    private fun rankOne(subject: WorkRankSubject, signal: WorkRankSignals, now: Long, c: WorkRankCriteria): RankedWorkSubject {
        val reasons = mutableListOf<WorkRankReason>()
        var score = 0.0
        fun add(code: WorkRankReasonCode, points: Double) {
            if (points <= 0) return
            score += points
            reasons += WorkRankReason(code, points)
        }
        if (signal.starred) add(WorkRankReasonCode.STARRED, c.starred)
        if (signal.directAttention) add(WorkRankReasonCode.DIRECT_ATTENTION, c.directAttention)
        if (signal.unread) add(WorkRankReasonCode.UNREAD, c.unread)
        add(WorkRankReasonCode.OVERDUE, min(max(0, subject.overdueTasks), c.overdueCap) * c.overduePerTask)
        val event = if (subject.kind == "event") eventDay(subject.eventDate) else null
        if (event != null) {
            val daysUntil = event - Math.floorDiv(now, DAY_MS)
            if (daysUntil == 0L) add(WorkRankReasonCode.EVENT_TODAY, c.eventToday)
            else if (daysUntil > 0 && daysUntil <= c.eventHorizonDays) {
                add(WorkRankReasonCode.EVENT_SOON, max(0.0, c.eventSoonBase - (daysUntil - 1) * c.eventSoonDecayPerDay))
            }
        }
        val openTasks = min(max(0, subject.openTasks), c.openWorkCap)
        add(WorkRankReasonCode.OPEN_WORK, openTasks * c.openWorkPerTask)
        Upcoming.parse(subject.lastActivityAt)?.let { activity ->
            val age = max(0L, now - activity)
            add(WorkRankReasonCode.RECENT_ACTIVITY, c.recentActivityMax * 0.5.pow(age.toDouble() / c.activityHalfLifeMs))
            if (openTasks > 0 && age >= c.staleAfterMs) add(WorkRankReasonCode.STALE_WORK, c.staleWork)
        }
        return RankedWorkSubject(subject, score, reasons)
    }

    private val day = Regex("""^(\d{4})-(\d{2})-(\d{2})""")

    /** The event's UTC day number. Out-of-range parts roll over, as `Date.UTC` does. */
    private fun eventDay(value: String?): Long? {
        val (y, m, d) = day.find(value ?: return null)?.destructured ?: return null
        return LocalDate.of(y.toInt(), 1, 1).plusMonths(m.toLong() - 1).plusDays(d.toLong() - 1).toEpochDay()
    }
}
