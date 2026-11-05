package work.starlings.android.workspace.team

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
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
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.api.CalendarExtraRoutes
import work.starlings.android.api.WorkRoutes
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.workspace.MemberSurface
import work.starlings.android.workspace.WorkspaceNavigator
import work.starlings.android.workspace.work.MineItem
import work.starlings.android.workspace.work.MineWork
import work.starlings.android.workspace.work.TaskDates
import work.starlings.android.workspace.work.TaskStatus
import work.starlings.android.workspace.work.WorkFormat
import work.starlings.android.workspace.work.WorkRoute
import work.starlings.contracts.CalendarFreeBusyPerson
import work.starlings.contracts.CalendarFreeBusyRequest
import work.starlings.contracts.CrmMyWorkResponse
import work.starlings.contracts.PeerWire
import java.time.Instant
import java.time.ZoneId

/*
 * The colleague half of `MobilePeerInfoView`: Today's schedule, Between us
 * and Shared work. Read while the sheet is up and the app is in front, on the
 * roster's cadence, because neither read has a push.
 */

/** What the three sections read: the colleague's work, yours, and their day. */
@Stable
class PeerDetails {
    var theirs by mutableStateOf<CrmMyWorkResponse?>(null)
    var mine by mutableStateOf<CrmMyWorkResponse?>(null)
    var workLoading by mutableStateOf(false)
    var workError by mutableStateOf<String?>(null)

    var day by mutableStateOf<CalendarFreeBusyPerson?>(null)
    var dayLoading by mutableStateOf(false)
    var dayFailure by mutableStateOf<PeerScheduleNote.Failure?>(null)

    suspend fun loadWork(store: TeamStore, email: String) {
        val client = store.account.client
        if (mine == null) mine = client.snapshot(WorkRoutes.mine)?.value
        if (theirs == null) workLoading = true
        workError = null
        try {
            theirs = client.call(WorkRoutes.work(email))
            runCatching { client.call(WorkRoutes.mine) }.getOrNull()?.let { mine = it }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            workError = e.teamMessage()
        } finally {
            workLoading = false
        }
    }

    suspend fun loadDay(store: TeamStore, email: String, zone: ZoneId) {
        val window = PeerDaySchedule.window(java.time.LocalDate.now(zone), zone)
        if (day == null) dayLoading = true
        dayFailure = null
        try {
            val people = store.account.client.call(
                CalendarExtraRoutes.freeBusy(
                    CalendarFreeBusyRequest(Instant.ofEpochMilli(window.start).toString(), Instant.ofEpochMilli(window.end).toString(), listOf(email)),
                ),
            ).people
            day = people.firstOrNull { it.email.equals(email, ignoreCase = true) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            dayFailure = PeerScheduleNote.classify(e)
        } finally {
            dayLoading = false
        }
    }
}

/** The sheet's reads: work then the day, again every roster poll while the app is started. */
@Composable
fun rememberPeerDetails(store: TeamStore, peer: PeerWire): PeerDetails {
    val details = remember(peer.email) { PeerDetails() }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(peer.email) {
        if (peer.isAgent || peer.isSelf) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                details.loadWork(store, peer.email)
                details.loadDay(store, peer.email, ZoneId.systemDefault())
                delay(TeamCadence.ROSTER_POLL_MS)
            }
        }
    }
    return details
}

@Composable
fun TodayScheduleSection(details: PeerDetails) {
    ListSection(stringResource(R.string.team_today_schedule)) {
        val day = details.day
        when {
            details.dayLoading -> WorkPlaceholderRows()
            details.dayFailure == PeerScheduleNote.Failure.FAILED -> WorkErrorNotice(stringResource(R.string.team_schedule_failed))
            details.dayFailure != null -> Note(
                stringResource(
                    when (details.dayFailure) {
                        PeerScheduleNote.Failure.NOT_CONNECTED -> R.string.team_schedule_not_connected
                        PeerScheduleNote.Failure.GOOGLE_EXPIRED -> R.string.team_schedule_google_expired
                        else -> R.string.team_schedule_sign_in_expired
                    },
                ),
            )
            day != null && day.error.isEmpty() -> {
                val zone = ZoneId.systemDefault()
                val now = System.currentTimeMillis()
                val dayEnd = PeerDaySchedule.window(Instant.ofEpochMilli(now).atZone(zone).toLocalDate(), zone).end
                fun clock(ms: Long) = if (ms == dayEnd) "24:00" else WorkFormat.time(ms)
                val blocks = PeerDaySchedule.today(day, now, zone)
                blocks.forEachIndexed { index, block ->
                    val label = stringResource(if (block.kind == PeerScheduleBlock.Kind.BUSY) R.string.presence_busy else R.string.presence_available)
                    Labeled(label, "${clock(block.start)}–${clock(block.end)}", divider = index < blocks.lastIndex)
                }
            }
            else -> Note(
                stringResource(
                    if (PeerScheduleNote.unreadable(day?.error.orEmpty()) == PeerScheduleNote.Unreadable.NOT_SHARED) R.string.team_schedule_not_shared
                    else R.string.team_schedule_unavailable,
                ),
            )
        }
    }
}

/** Between us: what they owe, planned as Mine plans yours, with New task to file one for them. */
@Composable
fun BetweenUsSection(peer: PeerWire, details: PeerDetails, navigator: WorkspaceNavigator?, onLeave: () -> Unit) {
    val c = Starlings.colors
    val r = LocalContext.current.resources
    var choosing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val store = LocalTeamStore.current
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.team_between_us), Modifier.weight(1f), style = StarlingsType.footnote, color = c.secondary)
            if (navigator != null) {
                Row(
                    Modifier.clickable(role = Role.Button) { choosing = true }.padding(vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Filled.Add, null, Modifier.size(14.dp), tint = c.primary)
                    Text(stringResource(R.string.team_new_task), style = StarlingsType.footnote.copy(fontWeight = FontWeight.SemiBold), color = c.primary)
                }
            }
        }
        ListSection(null) {
            val theirs = details.theirs
            val error = details.workError
            when {
                details.workLoading -> WorkPlaceholderRows()
                error != null -> {
                    WorkErrorNotice(stringResource(R.string.team_crm_unreachable), stringResource(R.string.team_retry), {
                        if (store != null) scope.launch { details.loadWork(store, peer.email) }
                    })
                    ListRow { Text(error, style = StarlingsType.footnote, color = c.secondary) }
                }
                theirs == null -> Note(stringResource(R.string.team_work_unavailable))
                !theirs.matched -> Note(stringResource(R.string.team_no_crm_record, peer.shortName))
                else -> {
                    val zone = ZoneId.systemDefault()
                    val now = System.currentTimeMillis()
                    val planned = remember(theirs, now / 60_000) { MineWork.plan(theirs.tasks, theirs.issues, "", now, zone).order }
                    if (planned.isEmpty()) {
                        Note(stringResource(R.string.team_nothing_open_for, peer.shortName))
                    } else {
                        planned.take(8).forEachIndexed { index, item ->
                            WorkLine(item, divider = index < minOf(planned.size, 8) - 1 || planned.size > 8, now = now, r = r) {
                                navigator?.let { nav -> open(nav, item); onLeave() }
                            }
                        }
                        if (planned.size > 8) {
                            ListRow { Text(stringResource(R.string.team_more_count, planned.size - 8), style = StarlingsType.footnote, color = c.secondary) }
                        }
                    }
                }
            }
        }
    }
    if (choosing && store != null) {
        PeerTaskSubjectPicker(store.account.client, onDismiss = { choosing = false }) { subject ->
            choosing = false
            val base = WorkRoute.path(WorkRoute.Subject(subject.kind, subject.id, pane = "tasks"))
            navigator?.open(MemberSurface.WORK, "$base&new=task")
            onLeave()
        }
    }
}

/** Shared work: the subjects you both have open tasks on, and how many each. */
@Composable
fun SharedWorkSection(details: PeerDetails, navigator: WorkspaceNavigator?, onLeave: () -> Unit) {
    val shared = remember(details.theirs, details.mine) {
        val theirs = details.theirs?.tasks ?: return@remember emptyList()
        SharedWork.subjects(details.mine?.tasks.orEmpty(), theirs)
    }
    ListSection(stringResource(R.string.team_shared_work)) {
        if (shared.isEmpty()) {
            Note(stringResource(R.string.team_no_shared_work))
        } else {
            shared.forEachIndexed { index, item ->
                Labeled(
                    item.subject.title,
                    stringResource(R.string.team_shared_counts, item.theirs, item.mine),
                    divider = index < shared.lastIndex,
                    onClick = navigator?.let { nav ->
                        {
                            nav.open(MemberSurface.WORK, WorkRoute.path(WorkRoute.Subject(item.subject.kind, item.subject.id, pane = "tasks")))
                            onLeave()
                        }
                    },
                )
            }
        }
    }
}

private fun open(navigator: WorkspaceNavigator, item: MineItem) {
    val route = when (item) {
        is MineItem.Task -> WorkRoute.Task(item.task.id)
        is MineItem.Issue -> WorkRoute.Issue(item.issue.owner, item.issue.repo, item.issue.number)
    }
    navigator.open(MemberSurface.WORK, WorkRoute.path(route))
}

/** `workRow`: the title over its detail, an issue with the number mark. */
@Composable
private fun WorkLine(item: MineItem, divider: Boolean, now: Long, r: android.content.res.Resources, onClick: () -> Unit) {
    val c = Starlings.colors
    val (title, detail) = when (item) {
        is MineItem.Task -> item.task.title to taskDetail(r, item, now)
        is MineItem.Issue -> item.issue.title to buildList {
            add("${item.issue.repo} ${item.shortReference}")
            item.issue.labels.take(2).joinToString(", ").takeIf { it.isNotEmpty() }?.let(::add)
        }.joinToString(" · ")
    }
    ListRow(Modifier.clickable(role = Role.Button, onClick = onClick), divider = divider) {
        Row(Modifier.semantics(mergeDescendants = true) { }, horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
            if (item is MineItem.Issue) Icon(Icons.Filled.Tag, null, Modifier.size(20.dp).padding(2.dp), tint = c.secondary)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, style = StarlingsType.body.copy(fontWeight = FontWeight.Medium), color = c.primary)
                Text(detail, style = StarlingsType.caption, color = c.secondary)
            }
        }
    }
}

/** `taskDetail`: status, due day and Late, then the subject. */
private fun taskDetail(r: android.content.res.Resources, item: MineItem.Task, now: Long): String = buildList {
    add(WorkFormat.status(r, TaskStatus.of(item.task.status)))
    item.workDueDate?.let { due ->
        add(WorkFormat.day(due))
        if (TaskDates.isOverdue(item.task.dueDate, now)) add(r.getString(R.string.team_late))
    }
    item.task.subjectTitle?.let(::add)
}.joinToString(" · ")

@Composable
private fun Note(text: String) {
    ListRow { Text(text, style = StarlingsType.body, color = Starlings.colors.secondary) }
}
