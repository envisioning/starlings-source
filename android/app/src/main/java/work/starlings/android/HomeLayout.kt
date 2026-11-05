package work.starlings.android

/**
 * What Home is made of and the order it is drawn in:
 * `Sources/HomeLayout.swift` and `web/src/home-layout.ts`, held to
 * `fixtures/home-layout.json`. The person owns order and visibility; the
 * Worker stores the list behind `/api/home/preferences`.
 */
data class HomeModule(
    val id: String,
    val title: String,
    val detail: String,
    val enabledByDefault: Boolean,
    /** Rows a list module draws, and its placeholders while it waits. Null: not a capped list. */
    val rows: Int?,
    val canHide: Boolean,
    /** True when the card draws with nothing to list. */
    val showsEmpty: Boolean,
)

/** One row of the stored list, and of the resolved one. */
data class HomeModuleSetting(val id: String, val enabled: Boolean)

object HomeLayout {
    const val RECENT = "recent"

    /** The table, in default order. */
    val modules = listOf(
        HomeModule("messages", "Inbox", "What is new: unread conversations, decisions, requests and invitations", true, 3, canHide = true, showsEmpty = false),
        HomeModule("work", "Work", "Everything assigned to you", true, 5, canHide = true, showsEmpty = false),
        HomeModule("commercial", "Commercial", "Offers, sales, pipeline, and new licenses", true, null, canHide = true, showsEmpty = false),
        HomeModule("notes", "Quick Notes", "Capture now, file later", true, null, canHide = true, showsEmpty = true),
        HomeModule("agenda", "Upcoming", "What is next, and the rest of today", true, null, canHide = true, showsEmpty = true),
        HomeModule("events", "Events", "Upcoming events", true, 3, canHide = true, showsEmpty = false),
        HomeModule("room", "Your room", "Start, join, and share the room", true, null, canHide = false, showsEmpty = true),
        HomeModule(RECENT, "Quick access", "Starred and recently opened items", true, null, canHide = true, showsEmpty = false),
    )

    /** A module that draws a work module's data shows only while one of those is on. */
    val workModules = mapOf(
        "events" to listOf("events"),
        "commercial" to listOf("offers", "licenses"),
    )

    /** At most this many device recents join Quick Access. */
    const val MAX_RECENT_ROWS = 8

    private val byId = modules.associateBy { it.id }

    val defaults: List<HomeModuleSetting> = modules.map { HomeModuleSetting(it.id, it.enabledByDefault) }

    fun definition(id: String): HomeModule = byId[id] ?: error("home-layout: no module $id")

    /** SHOW: a visible module draws when it has content or draws empty by design. */
    fun draws(id: String, hasContent: Boolean): Boolean = hasContent || definition(id).showsEmpty

    /**
     * RESOLVE: stored order wins for the ids it names; unknown ids and later
     * duplicates go; legacy `starred` folds into `recent` with OR; a missing
     * module goes after its nearest present default predecessor; a module
     * that cannot hide is enabled; `recent` is last.
     */
    fun resolve(stored: List<HomeModuleSetting>?): List<HomeModuleSetting> {
        val result = mutableListOf<HomeModuleSetting>()
        val firstStoredId = mutableMapOf<String, String>()
        for (row in stored.orEmpty()) {
            val id = if (row.id == "starred") RECENT else row.id.takeIf { it in byId } ?: continue
            val index = result.indexOfFirst { it.id == id }
            if (index >= 0) {
                if (id == RECENT && firstStoredId[id] != row.id) {
                    result[index] = result[index].copy(enabled = result[index].enabled || row.enabled)
                }
                continue
            }
            firstStoredId[id] = row.id
            result += HomeModuleSetting(id, if (definition(id).canHide) row.enabled else true)
        }
        modules.forEachIndexed { index, module ->
            if (result.any { it.id == module.id }) return@forEachIndexed
            val at = (index - 1 downTo 0)
                .map { back -> result.indexOfFirst { it.id == modules[back].id } }
                .firstOrNull { it >= 0 }?.plus(1) ?: 0
            result.add(at, HomeModuleSetting(module.id, module.enabledByDefault))
        }
        val recent = result.indexOfFirst { it.id == RECENT }
        if (recent >= 0 && recent != result.lastIndex) result += result.removeAt(recent)
        return result
    }

    /** Settings offers every ungated row, enabled or not. Null work modules: an older Worker, all offered. */
    fun offered(layout: List<HomeModuleSetting>, workModules: List<String>?): List<HomeModuleSetting> =
        layout.filter { row ->
            val needs = workModules?.let { this.workModules[row.id] } ?: return@filter true
            needs.any { it in workModules }
        }

    /** What Home draws, in order. */
    fun visible(layout: List<HomeModuleSetting>, workModules: List<String>?): List<String> =
        offered(layout, workModules).filter { it.enabled }.map { it.id }

    /** One place up or down among the offered rows. Quick Access never moves and is never passed. */
    fun move(layout: List<HomeModuleSetting>, id: String, up: Boolean, workModules: List<String>?): List<HomeModuleSetting> {
        val offered = offered(layout, workModules)
        val at = offered.indexOfFirst { it.id == id }
        if (at < 0) return layout
        val target = if (up) at - 1 else at + 1
        if (id == RECENT || target !in offered.indices || offered[target].id == RECENT) return layout
        val from = layout.indexOfFirst { it.id == id }
        val to = layout.indexOfFirst { it.id == offered[target].id }
        if (from < 0 || to < 0) return layout
        return layout.toMutableList().apply { this[from] = layout[to]; this[to] = layout[from] }
    }

    /** Quick Access: starred rows lead in their order, then recent-only rows; each key once. */
    fun <R> mergeRecent(recent: List<R>, starred: List<R>, key: (R) -> String): List<R> {
        val seen = mutableSetOf<String>()
        return (starred + recent.take(MAX_RECENT_ROWS)).filter { seen.add(key(it)) }
    }

    /** Inbox: pinned rows (invitations, decisions, questions) in given order, then newest first; ties keep order. */
    fun <R> orderInbox(rows: List<R>, pinned: (R) -> Boolean, at: (R) -> Double): List<R> =
        rows.filter(pinned) + rows.filterNot(pinned).sortedByDescending(at)

    /** Two-column packing for wide layouts. `true` means right. */
    fun packColumns(modules: List<String>, heights: Map<String, Double>, gap: Double): Map<String, Boolean> {
        var left = 0.0
        var right = 0.0
        val assignment = mutableMapOf<String, Boolean>()
        modules.filter { (heights[it] ?: 0.0) > 0 }
            .sortedByDescending { heights.getValue(it) }
            .forEach { m ->
                val goesRight = right < left
                assignment[m] = goesRight
                if (goesRight) right += heights.getValue(m) + gap else left += heights.getValue(m) + gap
            }
        modules.forEach { if (it !in assignment) assignment[it] = right < left }
        return assignment
    }

    /** A placement to pack again: a taller-column card fits twice into the difference, or a measured card has no column. */
    fun columnsLopsided(modules: List<String>, heights: Map<String, Double>, assignment: Map<String, Boolean>, gap: Double): Boolean {
        var left = 0.0
        var right = 0.0
        val leftCards = mutableListOf<Double>()
        val rightCards = mutableListOf<Double>()
        for (m in modules) {
            val h = heights[m] ?: 0.0
            if (h <= 0) continue
            val goesRight = assignment[m] ?: return true
            if (goesRight) { right += h + gap; rightCards += h } else { left += h + gap; leftCards += h }
        }
        val difference = kotlin.math.abs(left - right)
        return (if (left >= right) leftCards else rightCards).any { 2 * (it + gap) <= difference }
    }
}
