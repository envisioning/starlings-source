package work.starlings.android.workspace.work

import work.starlings.contracts.CrmIssueComment
import work.starlings.contracts.CrmIssueDetailWire
import work.starlings.contracts.CrmIssueEvent
import work.starlings.contracts.CrmIssueState
import work.starlings.contracts.CrmIssueWire

/**
 * The native issue reader's rules (`CrmIssueDetail`, `CrmIssueEvent.summary`
 * in Sources/MeetingCategory.swift): one chronological thread of comments
 * and events, what each event says, and the state line. Words are resources.
 */
sealed interface IssueEntry {
    val at: Long?

    data class Comment(val comment: CrmIssueComment, override val at: Long?) : IssueEntry
    data class Event(val event: CrmIssueEvent, val summary: IssueThread.Summary, override val at: Long?) : IssueEntry
}

object IssueThread {
    /** What an event says: the phrase, who did it, and the thing it names when Core sent one. */
    data class Summary(val phrase: Phrase, val who: String?, val what: String?)

    enum class Phrase {
        ADDED_LABEL, REMOVED_LABEL, ASSIGNED, UNASSIGNED, MILESTONED, DEMILESTONED, RENAMED,
        CLOSED, CLOSED_NOT_PLANNED, CLOSED_DUPLICATE, REOPENED, REFERENCED, MENTIONED, LINKED, UNLINKED,
        MARKED_DUPLICATE, UNMARKED_DUPLICATE, SUB_ADDED, SUB_REMOVED, PARENT_ADDED, PARENT_REMOVED,
        LOCKED, UNLOCKED, PINNED, UNPINNED, TRANSFERRED,
    }

    /** `CrmIssueEvent.summary`: null for a kind the reader does not say, which is left out. */
    fun summary(event: CrmIssueEvent): Summary? {
        val who = event.actor
        val phrase = when (event.kind) {
            "labeled" -> return Summary(Phrase.ADDED_LABEL, who, event.subject ?: event.label?.name)
            "unlabeled" -> return Summary(Phrase.REMOVED_LABEL, who, event.label?.name)
            "assigned" -> Phrase.ASSIGNED
            "unassigned" -> Phrase.UNASSIGNED
            "milestoned" -> Phrase.MILESTONED
            "demilestoned" -> Phrase.DEMILESTONED
            "renamed" -> Phrase.RENAMED
            "closed" -> when (event.stateReason) {
                "not_planned" -> Phrase.CLOSED_NOT_PLANNED
                "duplicate" -> Phrase.CLOSED_DUPLICATE
                else -> Phrase.CLOSED
            }
            "reopened" -> Phrase.REOPENED
            "referenced" -> Phrase.REFERENCED
            "cross-referenced" -> Phrase.MENTIONED
            "connected" -> Phrase.LINKED
            "disconnected" -> Phrase.UNLINKED
            "marked_as_duplicate" -> Phrase.MARKED_DUPLICATE
            "unmarked_as_duplicate" -> Phrase.UNMARKED_DUPLICATE
            "sub_issue_added" -> Phrase.SUB_ADDED
            "sub_issue_removed" -> Phrase.SUB_REMOVED
            "parent_issue_added" -> Phrase.PARENT_ADDED
            "parent_issue_removed" -> Phrase.PARENT_REMOVED
            "locked" -> Phrase.LOCKED
            "unlocked" -> Phrase.UNLOCKED
            "pinned" -> Phrase.PINNED
            "unpinned" -> Phrase.UNPINNED
            "transferred" -> Phrase.TRANSFERRED
            else -> return null
        }
        return Summary(phrase, who, event.subject)
    }

    /**
     * `CrmIssueDetail.thread`: comments and the events that say something,
     * in the order they happened; an undated entry sorts last, not to 1970.
     */
    fun entries(detail: CrmIssueDetailWire): List<IssueEntry> {
        val comments = detail.commentsList.map { IssueEntry.Comment(it, TaskDates.parse(it.createdAt)) }
        val events = detail.timeline.orEmpty().mapNotNull { event -> summary(event)?.let { IssueEntry.Event(event, it, TaskDates.parse(event.createdAt)) } }
        return (comments + events).sortedWith(compareBy<IssueEntry> { it.at == null }.thenBy { it.at ?: 0L })
    }

    /** `stateSummary`'s reason: open, or closed as completed, not planned or duplicate. */
    enum class State { OPEN, CLOSED, NOT_PLANNED, DUPLICATE }

    fun state(state: CrmIssueState, reason: String?): State = when {
        state == CrmIssueState.OPEN -> State.OPEN
        reason == "not_planned" -> State.NOT_PLANNED
        reason == "duplicate" -> State.DUPLICATE
        else -> State.CLOSED
    }

    /** The detail read as the list row it extends, so a page can open on the row and fill in. */
    fun row(detail: CrmIssueDetailWire): CrmIssueWire = CrmIssueWire(
        id = detail.id, number = detail.number, owner = detail.owner, repo = detail.repo, title = detail.title,
        state = detail.state, url = detail.url, labels = detail.labels, labelDetails = detail.labelDetails,
        assigneeLogin = detail.assigneeLogin, assignees = detail.assignees, author = detail.author,
        createdAt = detail.createdAt, updatedAt = detail.updatedAt, closedAt = detail.closedAt, stateReason = detail.stateReason,
        issueType = detail.issueType, milestone = detail.milestone, milestoneDetail = detail.milestoneDetail,
        comments = detail.comments, reactions = detail.reactions, subIssues = detail.subIssues,
    )

    /** `owners`: the plural list when GitHub sent it, else the legacy single login. */
    fun owners(issue: CrmIssueWire): List<String> =
        issue.assignees?.map { it.login }?.takeIf { it.isNotEmpty() } ?: listOfNotNull(issue.assigneeLogin)

    /** `saveEdits`: only what changed travels; an untouched body is not rewritten (a rewrite re-stamps its attribution). */
    fun edits(title: String, body: String, shownTitle: String, shownBody: String): Pair<String?, String?>? {
        val wanted = title.trim()
        if (wanted.isEmpty()) return null
        return (if (wanted == shownTitle) null else wanted) to (if (body == shownBody) null else body)
    }
}
