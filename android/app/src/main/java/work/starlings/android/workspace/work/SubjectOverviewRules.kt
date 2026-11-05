package work.starlings.android.workspace.work

import work.starlings.contracts.CrmSubjectKind
import java.time.LocalDate

/**
 * `SubjectOverviewGroup` (Sources/Generated), held to
 * `fixtures/subject-overview-groups.json`: the groups a subject's Overview
 * draws, in order, what each needs, and the pane its Show all opens.
 */
enum class OverviewGroup(val id: String, val need: OverviewGroup.Need? = null, val showAll: SubjectPane? = null) {
    GOALS("goals"),
    SUBMISSION("submission"),
    TASKS("tasks", showAll = SubjectPane.TASKS),
    ISSUES("issues", Need.REPO, SubjectPane.ISSUES),
    CONTACTS("contacts"),
    OFFERS("offers", Need.OFFERS),
    LICENSES("licenses", Need.LICENSES),
    DECISIONS("decisions", showAll = SubjectPane.INTERACTIONS),
    DOCUMENTS("documents", Need.DOCS, SubjectPane.DOCUMENTS),
    HISTORY("history", showAll = SubjectPane.INTERACTIONS),
    RELATED("related"),
    ;

    enum class Need { REPO, DOCS, OFFERS, LICENSES }

    companion object {
        val layout: Map<String, List<OverviewGroup>> = mapOf(
            "project" to listOf(GOALS, TASKS, ISSUES, CONTACTS, DECISIONS, DOCUMENTS, HISTORY, RELATED),
            "lead" to listOf(SUBMISSION, TASKS, CONTACTS, OFFERS, LICENSES, DECISIONS, DOCUMENTS, HISTORY, RELATED),
            "organization" to listOf(TASKS, CONTACTS, OFFERS, LICENSES, DECISIONS, DOCUMENTS, HISTORY, RELATED),
            "event" to listOf(TASKS, DECISIONS),
        )

        /**
         * The needs the workspace's `work_modules` meet: Offers and Licenses
         * each wait for their module. An absent list means every module is on.
         */
        fun moduleNeeds(workModules: List<String>?): Set<Need> = buildSet {
            if (workModules == null || "offers" in workModules) add(Need.OFFERS)
            if (workModules == null || "licenses" in workModules) add(Need.LICENSES)
        }

        /** `SubjectOverviewGroup.groups(for:has:)`. */
        fun groups(kind: CrmSubjectKind, has: Set<Need>): List<OverviewGroup> =
            layout[kind.value].orEmpty().filter { group -> group.need?.let { it in has } ?: true }
    }
}

/**
 * The Offers and Licenses rows' one rule beyond wording: an active license
 * that renews within 30 days, or whose renewal day has passed, asks for
 * attention.
 */
internal object CommercialRows {
    const val RENEWAL_WINDOW_DAYS = 30L

    fun renewsSoon(isActive: Boolean, renewal: LocalDate?, today: LocalDate): Boolean =
        isActive && renewal != null && !renewal.isAfter(today.plusDays(RENEWAL_WINDOW_DAYS))
}

/**
 * `SubjectContextRegistry` (Sources/Generated), held to
 * `fixtures/subject-context.json`: the context blocks at the top of
 * Overview. Android draws what iOS draws (`client: .ios`), so Goals, a
 * group of the Overview body there, is not a block here either.
 */
enum class ContextBlock(val id: String) {
    TEAM("team"), AGENTS("agents"), WHEN("when"), WHERE("where"), LINKS("links"), WEBSITE("website"),
    WORK("work"), GOALS("goals"), RELATIONSHIP("relationship"), ABOUT("about"), EMAIL("email");

    companion object {
        val layout: Map<String, List<ContextBlock>> = mapOf(
            "project" to listOf(TEAM, AGENTS, WORK, GOALS, RELATIONSHIP, ABOUT, EMAIL),
            "lead" to listOf(TEAM, AGENTS, WORK, RELATIONSHIP, ABOUT, EMAIL),
            "organization" to listOf(TEAM, AGENTS, WORK, RELATIONSHIP, ABOUT, EMAIL),
            "event" to listOf(TEAM, AGENTS, WHEN, WHERE, LINKS, WEBSITE, WORK, EMAIL),
        )

        /** The blocks a client leaves out: `notOn`. */
        val notOn: Map<ContextBlock, Set<String>> = mapOf(GOALS to setOf("mac", "ios", "web"))

        /** `SubjectContextRegistry.blocks(for:client:)`; Android reads as iOS. */
        fun blocks(kind: CrmSubjectKind, client: String = "ios"): List<ContextBlock> =
            layout[kind.value].orEmpty().filter { client !in notOn[it].orEmpty() }
    }
}

/**
 * `Responsible` (Sources/Responsible.swift), held to `fixtures/responsible.json`:
 * who answers for a project or a lead (docs/OWNERSHIP.md). The chosen
 * person, else whoever holds the most open tasks, ties to the first address.
 */
data class Responsible(val email: String, val chosen: Boolean) {
    data class Task(val assigneeEmail: String?, val status: String)

    companion object {
        private val OPEN = setOf("pending", "in_progress", "review", "blocked")

        /** A person row's Make responsible: on a project or lead, for anyone but the person chosen. A suggestion can still be chosen. */
        fun offersChoice(kind: String, email: String, current: Responsible?): Boolean =
            (kind == "project" || kind == "lead") && email.trim().lowercase() != current?.takeIf { it.chosen }?.email

        fun of(kind: String, responsibleEmail: String?, tasks: List<Task>): Responsible? {
            if (kind != "project" && kind != "lead") return null
            responsibleEmail?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }?.let { return Responsible(it, chosen = true) }
            val counts = sortedMapOf<String, Int>()
            for (task in tasks) {
                if (task.status !in OPEN) continue
                val email = task.assigneeEmail?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: continue
                counts[email] = (counts[email] ?: 0) + 1
            }
            var best: String? = null
            var most = 0
            for ((email, count) in counts) if (count > most) { best = email; most = count }
            return best?.let { Responsible(it, chosen = false) }
        }
    }
}
