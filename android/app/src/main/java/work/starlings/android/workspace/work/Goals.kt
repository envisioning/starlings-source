package work.starlings.android.workspace.work

import work.starlings.android.WorkItems
import work.starlings.contracts.CrmGoal
import work.starlings.contracts.GoalStatus
import java.time.LocalDate

/**
 * `GoalsDecisions` (Sources/GoalsDecisions.swift), held to
 * `fixtures/goals-decisions.json`: which goals are live, which are late,
 * and the order a picker lists them in.
 */
object Goals {
    /** A goal is live while open; the task picker offers live goals only. */
    fun isLive(goal: CrmGoal): Boolean = goal.status == GoalStatus.OPEN

    /** A live goal whose target day is before [today], as civil days. Met and dropped goals are never late. */
    fun isLate(goal: CrmGoal, today: LocalDate): Boolean {
        if (!isLive(goal)) return false
        val day = civilDay(goal.targetDate) ?: return false
        return day < today
    }

    /** Open first, late before on-time, soonest target, undated last, ties by title; then met, then dropped, newest first. */
    fun sorted(goals: List<CrmGoal>, today: LocalDate): List<CrmGoal> = goals.sortedWith { a, b ->
        val rankA = rank(a.status)
        val rankB = rank(b.status)
        if (rankA != rankB) return@sortedWith rankA.compareTo(rankB)
        if (a.status == GoalStatus.OPEN) {
            val lateA = isLate(a, today)
            val lateB = isLate(b, today)
            if (lateA != lateB) return@sortedWith if (lateA) -1 else 1
            val dayA = civilDay(a.targetDate)
            val dayB = civilDay(b.targetDate)
            when {
                dayA != null && dayB != null && dayA != dayB -> return@sortedWith dayA.compareTo(dayB)
                dayA != null && dayB == null -> return@sortedWith -1
                dayA == null && dayB != null -> return@sortedWith 1
            }
            return@sortedWith String.CASE_INSENSITIVE_ORDER.compare(a.title, b.title)
        }
        (b.updatedAt ?: b.createdAt).compareTo(a.updatedAt ?: a.createdAt)
    }

    /** What the task editor's picker offers: live goals, and the one the task already cites. */
    fun offered(goals: List<CrmGoal>, current: String?, today: LocalDate): List<CrmGoal> =
        sorted(goals.filter { isLive(it) || it.id == current }, today)

    private fun rank(status: GoalStatus): Int = when (status) {
        GoalStatus.OPEN -> 0
        GoalStatus.MET -> 1
        GoalStatus.DROPPED -> 2
        else -> 3
    }

    private fun civilDay(wire: String?): LocalDate? = WorkItems.civilDay(wire)
}
