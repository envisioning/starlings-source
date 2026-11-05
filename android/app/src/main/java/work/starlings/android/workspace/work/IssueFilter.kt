package work.starlings.android.workspace.work

import work.starlings.contracts.CrmIssueFacetsResponse
import work.starlings.contracts.CrmIssueQuery
import work.starlings.contracts.CrmIssueQueryDirection
import work.starlings.contracts.CrmIssueQueryState
import work.starlings.contracts.CrmIssueSort
import work.starlings.contracts.CrmIssueWire

/**
 * `CrmIssueFilter` (`Sources/MeetingCategory.swift`): how a project's issue
 * list is narrowed. Every field but [search] is a question for the server
 * ([query]); [search] narrows the rows already in hand ([matches]).
 */
data class IssueFilter(
    val state: State = State.OPEN,
    val labels: List<String> = emptyList(),
    /** A GitHub login, or `none` for issues nobody owns. */
    val assignee: String? = null,
    /** GitHub takes a milestone by number, or `none`. Not a title. */
    val milestone: String? = null,
    val sort: Sort = Sort.UPDATED,
    val ascending: Boolean = false,
    val search: String = "",
) {
    enum class State(val wire: String) { OPEN("open"), CLOSED("closed"), ALL("all") }

    enum class Sort(val wire: String) { UPDATED("updated"), CREATED("created"), COMMENTS("comments") }

    /** Anything but the default is on, so the bar can offer Clear filters. */
    val isNarrowed: Boolean
        get() = state != State.OPEN || labels.isNotEmpty() || assignee != null || milestone != null ||
            sort != Sort.UPDATED || ascending || search.isNotEmpty()

    /** The generated query. GitHub ANDs a comma-separated label list; page 1 is left out. */
    fun query(projectId: String, page: Int = 1): CrmIssueQuery = CrmIssueQuery(
        projectId = projectId,
        state = CrmIssueQueryState(state.wire),
        labels = labels.takeIf { it.isNotEmpty() }?.joinToString(","),
        assignee = assignee,
        milestone = milestone,
        sort = CrmIssueSort(sort.wire),
        direction = CrmIssueQueryDirection(if (ascending) "asc" else "desc"),
        page = page.takeIf { it > 1 }?.toLong(),
    )

    /** The server would be asked something else than for [other]; [search] never leaves. */
    fun asksServerDifferently(other: IssueFilter): Boolean = query("") != other.query("")

    /** Title, `#n`, the bare number, or a label: how somebody looks for an issue they know. */
    fun matches(issue: CrmIssueWire): Boolean {
        val wanted = search.trim()
        if (wanted.isEmpty()) return true
        return issue.title.contains(wanted, ignoreCase = true) ||
            "#${issue.number}".contains(wanted) ||
            issue.number.toString() == wanted ||
            issue.labels.any { it.contains(wanted, ignoreCase = true) }
    }

    /** What the filter menu offers, read from the rows that came back (`MobileIssueFilterBar`). */
    data class Choices(val labels: List<String>, val logins: List<String>, val milestones: List<Pair<String, String>>)

    fun choices(issues: List<CrmIssueWire>): Choices {
        val labels = (issues.flatMap { it.labels } + this.labels).toSortedSet().toList()
        val logins = (issues.flatMap { it.assignees.orEmpty().map { a -> a.login } } + issues.mapNotNull { it.assigneeLogin }).toSortedSet().toList()
        // A title shows, a number travels.
        val milestones = sortedMapOf<String, String>()
        issues.forEach { issue ->
            val m = issue.milestoneDetail ?: return@forEach
            val number = m.number ?: return@forEach
            milestones[m.title] = number.toString()
        }
        return Choices(labels, logins, milestones.map { it.key to it.value })
    }

    companion object {
        /** A set with one member in or out, sorted (`toggled(_:in:)`). */
        fun toggled(one: String, current: List<String>): List<String> =
            (if (one in current) current - one else current + one).toSortedSet().toList()

        /** A page boundary can repeat a row when something is filed between two reads: keep it once. */
        fun appending(known: List<CrmIssueWire>, page: List<CrmIssueWire>): List<CrmIssueWire> {
            val ids = known.map { it.id }.toSet()
            return known + page.filter { it.id !in ids }
        }
    }
}

/** `CrmIssueFacets`: what an issue in one repository can be set to. Empty when it could not be read. */
data class IssueFacets(
    val labels: List<work.starlings.contracts.CrmIssueLabel> = emptyList(),
    val milestones: List<work.starlings.contracts.CrmIssueMilestone> = emptyList(),
    val assignees: List<work.starlings.contracts.CrmIssueUser> = emptyList(),
) {
    val isEmpty: Boolean get() = labels.isEmpty() && milestones.isEmpty() && assignees.isEmpty()

    /** The milestones a picker can send: GitHub takes a number. */
    val numbered: List<Pair<Long, String>> get() = milestones.mapNotNull { m -> m.number?.let { it to m.title } }

    companion object {
        val NONE = IssueFacets()

        fun of(response: CrmIssueFacetsResponse) = IssueFacets(response.labels, response.milestones, response.assignees)
    }
}
