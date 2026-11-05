package work.starlings.android.workspace.home

import work.starlings.android.HomeLayout
import work.starlings.android.WorkItemOrigin
import work.starlings.android.WorkItems
import work.starlings.android.WorkSection
import work.starlings.android.WorkStage
import work.starlings.android.workspace.work.MineItem
import work.starlings.android.workspace.work.MineWork
import work.starlings.contracts.CrmIssueWire
import work.starlings.contracts.CrmMyTaskWire
import work.starlings.contracts.InboxBookingItem
import work.starlings.contracts.InboxCardItem
import work.starlings.contracts.InboxCommentItem
import work.starlings.contracts.InboxCommercialItem
import work.starlings.contracts.InboxDecisionItem
import work.starlings.contracts.InboxFollowUpItem
import work.starlings.contracts.InboxForwardedItem
import work.starlings.contracts.InboxInterestItem
import work.starlings.contracts.InboxInvitationItem
import work.starlings.contracts.InboxItem
import work.starlings.contracts.InboxQuestionItem
import work.starlings.contracts.InboxSalesItem
import work.starlings.contracts.InboxSubmissionItem
import work.starlings.contracts.InboxTaskItem
import work.starlings.contracts.ThreadSummaryWire
import java.time.ZoneId

/**
 * Home's INBOX and MINE modules, with no Android in them: the rows and their
 * order. `MobileHomeInboxCard.rows` and `HomeMine` (Sources/WorkSurface.swift).
 */
object HomeInbox {
    /** One card row: an unread conversation, or an INBOX item. */
    sealed interface Row {
        val key: String
        val at: Double
        /** Invitations and decisions lead, in INBOX's order (`HomeLayout.orderInbox`). */
        val pinned: Boolean

        data class Thread(val thread: ThreadSummaryWire) : Row {
            override val key get() = "thread:${thread.id}"
            override val at get() = (thread.lastMessageAt ?: 0L).toDouble()
            override val pinned get() = false
        }

        data class Item(val item: InboxItem) : Row {
            override val key get() = key(item)
            override val at get() = at(item).toDouble()
            override val pinned get() = item is InboxInvitationItem || item is InboxDecisionItem
        }
    }

    /**
     * `itemsForHomeCard`: INBOX less unread talk (the thread poll draws it
     * live) and less Quick Notes (their own card). The kinds iOS does not
     * draw (guest, support, a kind this build does not know) stay in Work.
     */
    fun forHomeCard(items: List<InboxItem>): List<InboxItem> = items.filter {
        it is InboxTaskItem || it is InboxCardItem || it is InboxFollowUpItem || it is InboxSalesItem ||
            it is InboxCommentItem || it is InboxBookingItem || it is InboxInvitationItem || it is InboxForwardedItem ||
            it is InboxInterestItem || it is InboxSubmissionItem || it is InboxCommercialItem || it is InboxDecisionItem || it is InboxQuestionItem
    }

    /** [threads] is the TeamStore's unread list (`TeamThreads.unread`, `MobileTeamStore.unreadThreads`). */
    fun rows(threads: List<ThreadSummaryWire>, items: List<InboxItem>): List<Row> =
        HomeLayout.orderInbox(threads.map(Row::Thread) + forHomeCard(items).map(Row::Item), pinned = { it.pinned }, at = { it.at })

    /** How many rows the card lists before "and N more in Work". */
    val cap: Int get() = HomeLayout.definition("messages").rows ?: 3

    fun key(item: InboxItem): String = when (item) {
        is InboxTaskItem -> item.key
        is InboxCardItem -> item.key
        is InboxFollowUpItem -> item.key
        is InboxSalesItem -> item.key
        is InboxCommentItem -> item.key
        is InboxBookingItem -> item.key
        is InboxInvitationItem -> item.key
        is InboxForwardedItem -> item.key
        is InboxInterestItem -> item.key
        is InboxSubmissionItem -> item.key
        is InboxCommercialItem -> item.key
        is InboxDecisionItem -> item.key
        is InboxQuestionItem -> item.key
        else -> item.hashCode().toString()
    }

    fun at(item: InboxItem): Long = when (item) {
        is InboxTaskItem -> item.at
        is InboxCardItem -> item.at
        is InboxFollowUpItem -> item.at
        is InboxSalesItem -> item.at
        is InboxCommentItem -> item.at
        is InboxBookingItem -> item.at
        is InboxInvitationItem -> item.at
        is InboxForwardedItem -> item.at
        is InboxInterestItem -> item.at
        is InboxSubmissionItem -> item.at
        is InboxCommercialItem -> item.at
        is InboxDecisionItem -> item.at
        is InboxQuestionItem -> item.at
        else -> 0L
    }

    /** `glanceUsesSquareMark`: work records square; places, people and calendar entries round. */
    fun squareMark(item: InboxItem): Boolean =
        item is InboxTaskItem || item is InboxCardItem || item is InboxFollowUpItem || item is InboxCommentItem ||
            item is InboxDecisionItem || item is InboxQuestionItem || item is InboxCommercialItem
}

/**
 * `HomeMine`: all of Mine, in Mine's order, with each row's due date read
 * against today, filing left out, so an unfiled late task reads as late.
 */
class HomeMine private constructor(val rows: List<MineItem>, private val due: Map<String, WorkSection>) {
    /** What a row says on its right. */
    sealed interface When {
        data class Late(val dueMs: Long?) : When
        data object Today : When
        data class Soon(val dueMs: Long) : When
        data class Stage(val stage: WorkStage) : When
        data object None : When
    }

    val isEmpty: Boolean get() = rows.isEmpty()
    val lateCount: Int get() = due.values.count { it == WorkSection.LATE }
    val todayCount: Int get() = due.values.count { it == WorkSection.TODAY }

    fun isLate(item: MineItem): Boolean = due[item.workId] == WorkSection.LATE

    fun whenOf(item: MineItem): When = when (due[item.workId]) {
        WorkSection.LATE -> When.Late(item.workDueDate)
        WorkSection.TODAY -> When.Today
        WorkSection.SOON -> item.workDueDate?.let { When.Soon(it) } ?: When.None
        else -> when (val stage = WorkItems.stage(item)) {
            WorkStage.DOING, WorkStage.REVIEW, WorkStage.BLOCKED -> When.Stage(stage)
            else -> When.None
        }
    }

    companion object {
        /** How many rows the card lists before "and N more in Work". */
        val cap: Int get() = HomeLayout.definition("work").rows ?: 5

        fun plan(tasks: List<CrmMyTaskWire>, issues: List<CrmIssueWire>, now: Long, zone: ZoneId = ZoneId.systemDefault()): HomeMine {
            val rows = MineWork.plan(tasks, issues, "", now, zone).order
            return HomeMine(rows, rows.associate { it.workId to WorkItems.dateSection(it.workDueDate, now, zone) })
        }

        /** `PlannedWorkItem.homeDetail`: the subject for a task, `repo#n` for an issue. */
        fun detail(item: MineItem): String = when (item) {
            is MineItem.Task -> item.task.subjectTitle.orEmpty()
            is MineItem.Issue -> "${item.issue.repo}#${item.issue.number}"
        }

        fun title(item: MineItem): String = when (item) {
            is MineItem.Task -> item.task.title
            is MineItem.Issue -> item.issue.title
        }

        /** Where a row opens: the task in Work, or the issue in Work's reader (`taskHref`, `issueHref`). */
        fun link(item: MineItem): String = when (item) {
            is MineItem.Task -> HomeLinks.task(item.task.id)
            is MineItem.Issue -> HomeLinks.issue(item.issue.id)
        }

        fun isIssue(item: MineItem): Boolean = item.workOrigin == WorkItemOrigin.ISSUE
    }
}
