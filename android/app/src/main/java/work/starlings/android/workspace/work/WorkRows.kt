package work.starlings.android.workspace.work

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Business
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.RadioButtonChecked
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import work.starlings.android.R
import work.starlings.android.WorkSubjectRowSpec
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkMark
import work.starlings.android.ui.WorkMeta
import work.starlings.android.ui.WorkRow
import work.starlings.android.ui.WorkSidebarRow
import work.starlings.android.ui.WorkSwipeRow
import work.starlings.contracts.CrmIssueState
import work.starlings.contracts.CrmIssueWire
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire

/** The symbol for a subject's kind (`WorkSidebarRow.subjectLeading`), Material for SF. */
internal fun subjectIcon(kind: CrmSubjectKind): ImageVector = when (kind) {
    CrmSubjectKind.PROJECT -> Icons.Filled.Folder
    CrmSubjectKind.LEAD -> Icons.Filled.Flag
    CrmSubjectKind.ORGANIZATION -> Icons.Filled.Business
    CrmSubjectKind.EVENT -> Icons.Filled.Campaign
    else -> Icons.Filled.Folder
}

/**
 * `MyTaskRow`: the square check mark, the title, then the due day (bold
 * when overdue, no tint), the subject and the issue number.
 */
@Composable
internal fun MineTaskRow(item: MineItem.Task, now: Long, onLongClick: (() -> Unit)? = null, onOpen: () -> Unit) {
    val task = item.task
    val taskLabel = stringResource(R.string.work_task)
    WorkRow(
        task.title,
        onClick = onOpen,
        onLongClick = onLongClick,
        leading = {
            Box(Modifier.semantics { this.contentDescription = taskLabel }) { WorkMark(Icons.Filled.Check, size = 18.dp) }
        },
    ) {
        val due = item.workDueDate
        if (due != null) {
            WorkMeta(WorkFormat.day(due), strong = TaskDates.isOverdue(task.dueDate, now))
            WorkMeta("·")
        }
        task.subjectTitle?.let { WorkMeta(it) }
        task.githubIssueNumber?.let { WorkMeta("·"); WorkMeta("#$it") }
    }
}

/**
 * Mine's task row with its trailing swipe: Done, the one edit worth a
 * swipe, as on iOS. TalkBack gets Done as a custom action.
 */
@Composable
internal fun SwipeDoneRow(
    doneLabel: String,
    onDone: () -> Unit,
    leading: work.starlings.android.ui.WorkRowAction? = null,
    leadingIcon: androidx.compose.ui.graphics.vector.ImageVector? = null,
    content: @Composable () -> Unit,
) {
    Box(Modifier.semantics { customActions = listOf(CustomAccessibilityAction(doneLabel) { onDone(); true }) }) {
        WorkSwipeRow(doneLabel, Icons.Filled.CheckCircle, onDone, leading = leading, leadingIcon = leadingIcon) { content() }
    }
}

/** `IssueRow`: the state mark, then repo and number, author, opened, owners, milestone, sub-issues. */
@Composable
internal fun MineIssueRow(issue: CrmIssueWire, onLongClick: (() -> Unit)? = null, onOpen: () -> Unit) {
    val r = LocalContext.current.resources
    val open = issue.state == CrmIssueState.OPEN
    WorkRow(
        issue.title,
        onClick = onOpen,
        onLongClick = onLongClick,
        leading = {
            WorkMark(
                when {
                    open -> Icons.Filled.RadioButtonChecked
                    issue.stateReason == "not_planned" -> Icons.Filled.Block
                    else -> Icons.Filled.CheckCircle
                },
                size = 18.dp,
            )
        },
    ) {
        val parts = buildList {
            add("${issue.repo} #${issue.number}")
            issue.author?.login?.let { add(r.getString(R.string.work_issue_by, it)) }
            TaskDates.parse(issue.createdAt)?.let { add(WorkFormat.day(it)) }
            val owners = issue.assignees?.map { it.login }?.takeIf { it.isNotEmpty() } ?: listOfNotNull(issue.assigneeLogin)
            if (owners.isNotEmpty()) add(r.getString(R.string.work_issue_owners, owners.joinToString(", ")))
            issue.milestone?.let(::add)
            issue.subIssues?.let { add(r.getString(R.string.work_issue_sub_done, it.completed.toInt(), it.total.toInt())) }
        }
        WorkMeta(parts.joinToString(" · "))
    }
}

/** `WorkSidebarRow.subject`: how the row reads is `WorkSubjectRowSpec`'s, decided once for every client. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun SubjectRow(
    subject: CrmSubjectWire,
    state: ResolvedSubjectState,
    detail: String,
    hasUnread: Boolean,
    selected: Boolean = false,
    menu: List<work.starlings.android.ui.WorkRowAction> = emptyList(),
    onOpen: () -> Unit,
) = work.starlings.android.ui.WorkRowMenu(menu) { long ->
    val title = WorkFormat.displayTitle(subject)
    val spec = WorkSubjectRowSpec.of(title, hasUnread, state.starred, state.muted, isSubdued = false)
    WorkSidebarRow(
        onLongClick = long,
        icon = subjectIcon(subject.kind),
        title = title,
        subtitle = detail,
        onClick = onOpen,
        // The rail row the detail column shows, on a regular width.
        modifier = if (selected) Modifier.background(Starlings.colors.selected) else Modifier,
        weight = when (spec.weight) {
            WorkSubjectRowSpec.Weight.SEMIBOLD -> FontWeight.SemiBold
            WorkSubjectRowSpec.Weight.MEDIUM -> FontWeight.Medium
            WorkSubjectRowSpec.Weight.REGULAR -> FontWeight.Normal
        },
        subdued = spec.ink == WorkSubjectRowSpec.Ink.SECONDARY,
        starred = spec.showsStarBadge,
        unreadDot = spec.trailing == WorkSubjectRowSpec.Trailing.UNREAD_DOT,
        label = spec.accessibilityLabel.takeIf { it != title }?.let { "$it, $detail" },
    )
}
