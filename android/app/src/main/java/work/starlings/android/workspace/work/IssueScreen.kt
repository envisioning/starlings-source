package work.starlings.android.workspace.work

import android.content.Intent
import android.content.res.Resources
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.RadioButtonChecked
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.AddReaction
import androidx.compose.material.icons.filled.Celebration
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Mood
import androidx.compose.material.icons.filled.RocketLaunch
import androidx.compose.material.icons.filled.SentimentDissatisfied
import androidx.compose.material.icons.filled.ThumbDown
import androidx.compose.material.icons.filled.ThumbUp
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.api.WorkExtraRoutes
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkActionRow
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkHeaderTitle
import work.starlings.android.ui.WorkLabeledRow
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSheet
import work.starlings.android.ui.WorkTopBar
import work.starlings.android.workspace.team.MarkdownText
import work.starlings.contracts.CrmIssueDetailWire
import work.starlings.contracts.CrmIssueState
import work.starlings.contracts.CrmIssueUpdate
import work.starlings.contracts.CrmIssueUpdateStateReason
import work.starlings.contracts.CrmIssueWire
import work.starlings.contracts.Patch
import androidx.compose.ui.draw.alpha

/**
 * `MobileIssueDoor`: an issue named by `owner/repo#n` (a path, an INBOX
 * card), read first, then the reader. Said rather than drawn blank when it fails.
 */
@Composable
internal fun IssueDoor(store: WorkStore, owner: String, repo: String, number: Long, projectId: String?, onBack: () -> Unit) {
    val c = Starlings.colors
    var issue by remember(owner, repo, number) { mutableStateOf<CrmIssueWire?>(null) }
    var error by remember(owner, repo, number) { mutableStateOf<String?>(null) }
    LaunchedEffect(owner, repo, number) {
        try {
            issue = IssueThread.row(store.client.call(WorkExtraRoutes.issue(owner, repo, number)).issue)
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.workMessage()
        }
    }
    val read = issue
    if (read != null) {
        IssueScreen(store, read, projectId, onBack)
        return
    }
    Column(Modifier.fillMaxSize().background(c.canvas)) {
        WorkTopBar("$repo#$number", stringResource(R.string.work_back), onBack)
        WorkSection { error?.let { WorkErrorNotice(it) } ?: WorkPlaceholderRows() }
    }
}

/**
 * `MobileIssueView`: the issue read in the app. The row first, the detail
 * once it lands: title and description, GitHub's rail as About rows, the
 * comments and events in one chronological read, then a comment field,
 * Close or Reopen, Close as not planned, the title and description editor
 * and Open in GitHub. [projectId] lets the project's channel hear of a close.
 */
@Composable
internal fun IssueScreen(store: WorkStore, issue: CrmIssueWire, projectId: String?, onBack: () -> Unit) {
    val context = LocalContext.current
    val r = context.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var detail by remember(issue.id) { mutableStateOf<CrmIssueDetailWire?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var working by remember { mutableStateOf(false) }
    var comment by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf(false) }

    // The freshest issue we know: the detail once it arrives, the row until then.
    val shown = detail?.let(IssueThread::row) ?: issue
    val open = shown.state == CrmIssueState.OPEN
    val reference = "#${shown.number}"

    // What this repository would accept: a nicety. An issue whose facets cannot be read still reads.
    var facets by remember(issue.id) { mutableStateOf(IssueFacets.NONE) }
    var pickingPeople by remember { mutableStateOf(false) }
    LaunchedEffect(issue.id) { facets = store.issueFacets(issue.owner, issue.repo) }

    LaunchedEffect(issue.id) {
        try {
            detail = store.client.call(WorkExtraRoutes.issue(issue.owner, issue.repo, issue.number)).issue
            error = null
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.workMessage()
        }
    }

    fun write(update: CrmIssueUpdate) {
        if (working) return
        working = true
        scope.launch {
            try {
                detail = store.client.call(WorkExtraRoutes.updateIssue(update)).issue
                comment = ""
                error = null
                store.refreshMine()
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                error = e.workMessage()
            } finally {
                working = false
            }
        }
    }
    fun base() = CrmIssueUpdate(owner = issue.owner, repo = issue.repo, number = issue.number, projectId = projectId)

    Column(Modifier.fillMaxSize().background(c.canvas)) {
        WorkTopBar(reference, stringResource(R.string.work_back), onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            WorkSection(
                header = { WorkHeaderTitle("${shown.owner}/${shown.repo} $reference") },
                footer = openedLine(r, shown),
            ) {
                SelectionContainer {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(shown.title, style = StarlingsType.headline, color = c.primary)
                        val description = detail?.body?.trim().orEmpty()
                        if (description.isEmpty()) {
                            Text(stringResource(R.string.work_no_description), style = StarlingsType.body, color = c.secondary)
                        } else {
                            MarkdownText(description, emptyList())
                        }
                    }
                }
            }

            // GitHub's right-hand rail, as rows; a row with nothing to say is absent.
            WorkSection(header = { WorkHeaderTitle(stringResource(R.string.work_about)) }) {
                WorkLabeledRow(r.getString(R.string.work_state), issueStateSummary(r, shown))
                // Editable where the repository said what it accepts; a plain row where it did not.
                val owners = IssueThread.owners(shown)
                if (facets.assignees.isNotEmpty()) {
                    WorkDivider()
                    Box(Modifier.alpha(if (working) 0.45f else 1f)) {
                        WorkLabeledRow(
                            r.getString(R.string.work_assignees),
                            owners.takeIf { it.isNotEmpty() }?.joinToString(", ") ?: r.getString(R.string.work_nobody),
                        ) { if (!working) pickingPeople = true }
                    }
                } else if (owners.isNotEmpty()) {
                    WorkDivider(); WorkLabeledRow(r.getString(R.string.work_assignees), owners.joinToString(", "))
                }
                val drawable = IssueLabels.drawable(shown)
                if (facets.labels.isNotEmpty()) {
                    WorkDivider()
                    LabelsBlock(r.getString(R.string.work_labels), drawable) {
                        LabelsMenuRow(
                            facets, shown.labels, enabled = !working,
                            summary = if (shown.labels.isEmpty()) r.getString(R.string.work_none) else r.getString(R.string.work_n_chosen, shown.labels.size),
                        ) { write(base().copy(labels = it)) }
                    }
                } else if (drawable.isNotEmpty()) {
                    WorkDivider(); LabelsBlock(r.getString(R.string.work_labels), drawable)
                }
                val milestone = milestoneSummary(r, shown)
                if (facets.milestones.isNotEmpty()) {
                    WorkDivider()
                    MilestoneMenuRow(
                        facets, shown.milestoneDetail?.number, enabled = !working,
                        summary = milestone ?: r.getString(R.string.work_none), noneTitle = r.getString(R.string.work_none),
                    ) { number -> write(base().copy(milestone = number?.let { Patch.Value(it) } ?: Patch.Null)) }
                } else if (milestone != null) {
                    WorkDivider(); WorkLabeledRow(r.getString(R.string.work_milestone), milestone)
                }
                shown.issueType?.let { WorkDivider(); WorkLabeledRow(r.getString(R.string.work_issue_type), it) }
                // Named children beat a count of them: the count only while the list is unknown.
                val children = detail?.subIssueList.orEmpty()
                if (children.isNotEmpty()) {
                    WorkDivider()
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            r.getString(R.string.work_sub_issues_named, children.count { it.state != CrmIssueState.OPEN }, children.size),
                            style = StarlingsType.caption, color = c.secondary,
                        )
                        children.forEach { child ->
                            val childOpen = child.state == CrmIssueState.OPEN
                            Row(
                                Modifier.fillMaxWidth().clickable(role = Role.Button) { openUrl(context, child.url) }.padding(vertical = 2.dp),
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Icon(if (childOpen) Icons.Filled.RadioButtonChecked else Icons.Filled.CheckCircle, null, Modifier.size(12.dp), tint = c.secondary)
                                Text("#${child.number}  ${child.title}", style = StarlingsType.caption, color = if (childOpen) c.primary else c.secondary, maxLines = 1)
                            }
                        }
                    }
                } else {
                    shown.subIssues?.let { sub ->
                        WorkDivider()
                        WorkLabeledRow(r.getString(R.string.work_sub_issues), r.getString(R.string.work_sub_issues_done, sub.completed.toInt(), sub.total.toInt()))
                    }
                }
                TaskDates.parse(shown.closedAt)?.let { WorkDivider(); WorkLabeledRow(r.getString(R.string.work_closed), WorkFormat.dateTime(it)) }
            }

            val read = detail
            if (read != null) {
                val entries = IssueThread.entries(read)
                if (entries.isNotEmpty()) {
                    // Comments and events in one chronological read: the order the thread happened in.
                    WorkSection(header = { WorkHeaderTitle(stringResource(R.string.work_activity)) }) {
                        entries.forEachIndexed { index, entry ->
                            if (index > 0) WorkDivider()
                            when (entry) {
                                is IssueEntry.Comment -> CommentRow(entry)
                                is IssueEntry.Event -> EventRow(entry)
                            }
                        }
                        if (read.commentsList.size < read.comments) {
                            WorkNote(r.getString(R.string.work_showing_comments, read.commentsList.size, read.comments.toInt()))
                        }
                    }
                }
            } else if (error == null) {
                WorkSection { WorkPlaceholderRows() }
            }

            WorkSection {
                // Send sits inside the field, on its right edge.
                Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                    StarlingsField(comment, { comment = it }, placeholder = stringResource(R.string.work_write_comment), singleLine = false, maxLines = 6, trailingInset = 40.dp)
                    val canSend = comment.isNotBlank() && !working
                    val commentLabel = stringResource(R.string.work_comment)
                    Box(
                        Modifier
                            .align(Alignment.CenterEnd)
                            .padding(end = 6.dp)
                            .size(36.dp)
                            .clickable(enabled = canSend, role = Role.Button) { write(base().copy(comment = comment.trim())) }
                            .clearAndSetSemantics { contentDescription = commentLabel; role = Role.Button },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Filled.ArrowUpward, null, tint = if (canSend) c.accent else c.secondary)
                    }
                }
                WorkDivider()
                WorkActionRow(
                    stringResource(if (open) R.string.work_close_issue else R.string.work_reopen_issue),
                    { write(base().copy(state = CrmIssueState(if (open) "closed" else "open"))) },
                    enabled = !working,
                )
                if (open) {
                    // Deciding against work is not finishing it, and GitHub draws the two differently.
                    WorkDivider()
                    WorkActionRow(
                        stringResource(R.string.work_close_not_planned),
                        { write(base().copy(state = CrmIssueState.CLOSED, stateReason = CrmIssueUpdateStateReason.NOT_PLANNED)) },
                        enabled = !working,
                    )
                }
                WorkDivider()
                WorkActionRow(stringResource(R.string.work_edit_issue), { editing = true }, enabled = !working && detail != null)
                WorkDivider()
                WorkActionRow(stringResource(R.string.work_open_in_github), { openUrl(context, issue.url) }, accent = true)
            }

            error?.let { WorkSection { WorkErrorNotice(it) } }
        }
    }

    if (pickingPeople) {
        val owners = IssueThread.owners(shown)
        AssigneePickerSheet(facets.assignees, owners) { chosen ->
            pickingPeople = false
            if (chosen.toSet() != owners.toSet()) write(base().copy(assignees = chosen))
        }
    }

    if (editing) {
        var title by remember { mutableStateOf(shown.title) }
        var body by remember { mutableStateOf(detail?.body.orEmpty()) }
        WorkSheet(
            r.getString(R.string.work_edit_named, reference), stringResource(R.string.work_cancel), { editing = false },
            confirm = stringResource(R.string.work_save),
            confirmEnabled = title.isNotBlank(),
            onConfirm = {
                editing = false
                IssueThread.edits(title, body, shown.title, detail?.body.orEmpty())?.let { (t, b) ->
                    if (t != null || b != null) write(base().copy(title = t, body = b))
                }
            },
        ) {
            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                StarlingsField(title, { title = it }, placeholder = stringResource(R.string.work_title_field))
                StarlingsField(body, { body = it }, placeholder = stringResource(R.string.work_description), singleLine = false, maxLines = 20)
                Text(stringResource(R.string.work_written_in_your_name), style = StarlingsType.footnote, color = c.secondary)
            }
        }
    }
}

/** One thing somebody wrote: who and when, quiet, then what they said; reactions are a door to GitHub. */
@Composable
private fun CommentRow(entry: IssueEntry.Comment) {
    val context = LocalContext.current
    val r = context.resources
    val c = Starlings.colors
    val comment = entry.comment
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        val byline = listOfNotNull(
            comment.author,
            entry.at?.let(WorkFormat::dateTime),
            comment.updatedAt?.let { r.getString(R.string.work_edited) },
        ).joinToString(" · ")
        Text(byline, style = StarlingsType.caption.copy(fontWeight = FontWeight.SemiBold), color = c.secondary)
        SelectionContainer { MarkdownText(comment.body, emptyList(), style = StarlingsType.callout) }
        val reactions = comment.reactions.orEmpty().filterValues { it > 0 }.toSortedMap()
        if (reactions.isNotEmpty()) {
            // Read here, added on GitHub: the app writes as the GitHub App, so the tally is the door there.
            val label = r.getString(R.string.work_react_on_github)
            Row(
                Modifier
                    .clickable(role = Role.Button) { openUrl(context, comment.url) }
                    .clearAndSetSemantics { contentDescription = label; role = Role.Button },
                horizontalArrangement = Arrangement.spacedBy(7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                reactions.forEach { (name, count) ->
                    Icon(reactionIcon(name), null, Modifier.size(12.dp), tint = c.secondary)
                    Text("$count", style = StarlingsType.caption, color = c.secondary)
                }
            }
        }
    }
}

/** `GitHubReactions.symbol`: the glyph for a reaction name, never the emoji itself (docs/DESIGN.md). */
private fun reactionIcon(name: String): androidx.compose.ui.graphics.vector.ImageVector = when (name) {
    "+1" -> Icons.Filled.ThumbUp
    "-1" -> Icons.Filled.ThumbDown
    "laugh" -> Icons.Filled.Mood
    "hooray" -> Icons.Filled.Celebration
    "confused" -> Icons.Filled.SentimentDissatisfied
    "heart" -> Icons.Filled.Favorite
    "rocket" -> Icons.Filled.RocketLaunch
    "eyes" -> Icons.Filled.Visibility
    else -> Icons.Filled.AddReaction
}

/** Something that happened, as one quiet line; a reference opens where it points. */
@Composable
private fun EventRow(entry: IssueEntry.Event) {
    val context = LocalContext.current
    val r = context.resources
    val c = Starlings.colors
    val line = listOfNotNull(eventText(r, entry.summary), entry.at?.let(WorkFormat::day)).joinToString(" · ")
    val url = entry.event.url
    Row(
        Modifier.fillMaxWidth().then(if (url != null) Modifier.clickable(role = Role.Button) { openUrl(context, url) } else Modifier).padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.AutoMirrored.Filled.ArrowForward, null, Modifier.size(12.dp), tint = c.secondary)
        Text(line, style = StarlingsType.caption, color = c.secondary)
    }
}

/** `CrmIssueEvent.summary`, in words. */
internal fun eventText(r: Resources, summary: IssueThread.Summary): String {
    val who = summary.who ?: r.getString(R.string.work_somebody)
    fun what(fallback: Int) = summary.what ?: r.getString(fallback)
    val somebody = r.getString(R.string.work_somebody_lower)
    return when (summary.phrase) {
        IssueThread.Phrase.ADDED_LABEL -> r.getString(R.string.work_ev_added, who, what(R.string.work_a_label))
        IssueThread.Phrase.REMOVED_LABEL -> r.getString(R.string.work_ev_removed, who, what(R.string.work_a_label))
        IssueThread.Phrase.ASSIGNED -> r.getString(R.string.work_ev_assigned, who, summary.what ?: somebody)
        IssueThread.Phrase.UNASSIGNED -> r.getString(R.string.work_ev_unassigned, who, summary.what ?: somebody)
        IssueThread.Phrase.MILESTONED -> r.getString(R.string.work_ev_milestoned, who, what(R.string.work_a_milestone))
        IssueThread.Phrase.DEMILESTONED -> r.getString(R.string.work_ev_demilestoned, who, what(R.string.work_a_milestone))
        IssueThread.Phrase.RENAMED -> r.getString(R.string.work_ev_renamed, who)
        IssueThread.Phrase.CLOSED -> r.getString(R.string.work_ev_closed, who)
        IssueThread.Phrase.CLOSED_NOT_PLANNED -> r.getString(R.string.work_ev_closed_not_planned, who)
        IssueThread.Phrase.CLOSED_DUPLICATE -> r.getString(R.string.work_ev_closed_duplicate, who)
        IssueThread.Phrase.REOPENED -> r.getString(R.string.work_ev_reopened, who)
        IssueThread.Phrase.REFERENCED -> r.getString(R.string.work_ev_referenced, who)
        IssueThread.Phrase.MENTIONED -> r.getString(R.string.work_ev_mentioned, who, what(R.string.work_somewhere_else))
        IssueThread.Phrase.LINKED -> r.getString(R.string.work_ev_linked, who, what(R.string.work_a_pull_request))
        IssueThread.Phrase.UNLINKED -> r.getString(R.string.work_ev_unlinked, who, what(R.string.work_a_pull_request))
        IssueThread.Phrase.MARKED_DUPLICATE -> r.getString(R.string.work_ev_marked_duplicate, who)
        IssueThread.Phrase.UNMARKED_DUPLICATE -> r.getString(R.string.work_ev_unmarked_duplicate, who)
        IssueThread.Phrase.SUB_ADDED -> r.getString(R.string.work_ev_added, who, what(R.string.work_a_sub_issue))
        IssueThread.Phrase.SUB_REMOVED -> r.getString(R.string.work_ev_removed, who, what(R.string.work_a_sub_issue))
        IssueThread.Phrase.PARENT_ADDED -> r.getString(R.string.work_ev_parent_added, who, what(R.string.work_another_issue))
        IssueThread.Phrase.PARENT_REMOVED -> r.getString(R.string.work_ev_parent_removed, who, what(R.string.work_another_issue))
        IssueThread.Phrase.LOCKED -> r.getString(R.string.work_ev_locked, who)
        IssueThread.Phrase.UNLOCKED -> r.getString(R.string.work_ev_unlocked, who)
        IssueThread.Phrase.PINNED -> r.getString(R.string.work_ev_pinned, who)
        IssueThread.Phrase.UNPINNED -> r.getString(R.string.work_ev_unpinned, who)
        IssueThread.Phrase.TRANSFERRED -> r.getString(R.string.work_ev_transferred, who)
    }
}

internal fun issueStateSummary(r: Resources, issue: CrmIssueWire): String = when (IssueThread.state(issue.state, issue.stateReason)) {
    IssueThread.State.OPEN -> r.getString(R.string.work_issue_open)
    IssueThread.State.NOT_PLANNED -> r.getString(R.string.work_issue_closed_not_planned)
    IssueThread.State.DUPLICATE -> r.getString(R.string.work_issue_closed_duplicate)
    IssueThread.State.CLOSED -> r.getString(R.string.work_closed)
}

/** "Opened by ada on 7 Oct 2026". */
private fun openedLine(r: Resources, issue: CrmIssueWire): String {
    val line = issue.author?.let { r.getString(R.string.work_opened_by, it.login) } ?: r.getString(R.string.work_opened)
    return TaskDates.parse(issue.createdAt)?.let { r.getString(R.string.work_opened_on, line, WorkFormat.day(it)) } ?: line
}

private fun milestoneSummary(r: Resources, issue: CrmIssueWire): String? {
    val milestone = issue.milestoneDetail ?: return issue.milestone
    val due = TaskDates.parse(milestone.dueOn) ?: return milestone.title
    return r.getString(R.string.work_milestone_due, milestone.title, WorkFormat.day(due))
}

private fun openUrl(context: android.content.Context, url: String) {
    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
}
