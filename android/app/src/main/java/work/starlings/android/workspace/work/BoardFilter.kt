package work.starlings.android.workspace.work

import android.content.res.Resources
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FilterAlt
import androidx.compose.material.icons.outlined.FilterAlt
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.WorkCard
import work.starlings.android.WorkDueFilter
import work.starlings.android.WorkHolderChoice
import work.starlings.android.WorkItems
import work.starlings.android.WorkSideFilter
import work.starlings.android.WorkStage
import work.starlings.android.ui.Starlings
import work.starlings.contracts.CrmTeamMemberKind
import work.starlings.contracts.SubjectStateResponseWire
import work.starlings.contracts.SubjectStateResponseWireBoardHiddenStagesItem
import work.starlings.contracts.WorkPreferencesUpdate
import work.starlings.contracts.WorkPreferencesUpdateBoardHiddenStagesItem
import java.time.ZoneId

/**
 * The project board's filter (`MobileProjectBoardView.filterMenu`): who
 * holds the cards shown (`WORK_HOLDER_CHOICES`, then each agent as
 * `agent:<email>`), the due filter and the side filter. It
 * narrows what is drawn, never what is stored, and lasts while the page is open.
 */
class BoardFilter {
    var holder by mutableStateOf(WorkHolderChoice.ANYONE.wire)
    var due by mutableStateOf(WorkDueFilter.ANY)
    var side by mutableStateOf(WorkSideFilter.ANY)
    /** The project's own agent, for `agent:<email>` (`subject.agentEmail`). */
    var agentEmail by mutableStateOf<String?>(null)
    /** A column change the Worker refused: the board draws it as its error. */
    var error by mutableStateOf<String?>(null)

    val isNarrowed: Boolean get() = holder != WorkHolderChoice.ANYONE.wire || due != WorkDueFilter.ANY || side != WorkSideFilter.ANY

    /** `passesHolderFilter && passesTaskFilter`, the shared rules. */
    fun passes(card: WorkCard, now: Long, zone: ZoneId): Boolean =
        WorkItems.passesHolderFilter(card, holder, agentEmail) && WorkItems.passesTaskFilter(card, due, side, now, zone)
}

/**
 * The Board's hidden columns: the person's own, kept by the
 * Worker in `board_hidden_stages` with their other Work preferences, so
 * every project and device hides the same ones
 * (`SubjectStateResponse.boardHiddenStages`, `MobileMyWorkStore.setBoardHiddenStages`).
 * They narrow what is drawn, never what is stored.
 */
object BoardColumns {
    /** The stages the answer hides. A value this build does not know is dropped. */
    fun hidden(state: SubjectStateResponseWire?): Set<WorkStage> =
        state?.boardHiddenStages.orEmpty().mapNotNull { item -> WorkStage.entries.firstOrNull { it.wire == item.value } }.toSet()

    /** One column shown or hidden. */
    fun toggled(hidden: Set<WorkStage>, stage: WorkStage, shown: Boolean): Set<WorkStage> = if (shown) hidden - stage else hidden + stage

    /** The whole set, in stage order, as Swift sends it. */
    fun update(stages: Set<WorkStage>): WorkPreferencesUpdate = WorkPreferencesUpdate(
        boardHiddenStages = WorkStage.entries.filter { it in stages }.map { WorkPreferencesUpdateBoardHiddenStagesItem(it.wire) },
    )

    /** The answer with the set swapped, while the write is out (`SubjectStateResponse.with(boardHiddenStages:)`). */
    fun with(state: SubjectStateResponseWire, stages: Set<WorkStage>): SubjectStateResponseWire =
        state.copy(boardHiddenStages = WorkStage.entries.filter { it in stages }.map { SubjectStateResponseWireBoardHiddenStagesItem(it.wire) })

    /** The cards in hidden columns among the columns offered, for "n cards in hidden columns". */
    fun hiddenCount(offered: List<WorkStage>, hidden: Set<WorkStage>, count: (WorkStage) -> Int): Int =
        offered.filter { it in hidden }.sumOf(count)
}

/** The bar's filter button and its menu: Held by, Due and Side, each a picker with a tick, then Columns. */
@Composable
internal fun BoardFilterButton(store: WorkStore, filter: BoardFilter) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var open by remember { mutableStateOf(false) }
    val label = r.getString(R.string.work_filter_board)
    val hidden = store.boardHiddenStages
    val narrowed = filter.isNarrowed || hidden.isNotEmpty()
    Box {
        Box(
            Modifier
                .size(44.dp)
                .clickable(role = Role.Button) { open = true }
                .clearAndSetSemantics { contentDescription = label; role = Role.Button },
            contentAlignment = Alignment.Center,
        ) {
            Icon(if (narrowed) Icons.Filled.FilterAlt else Icons.Outlined.FilterAlt, null, Modifier.size(22.dp), tint = if (narrowed) c.accent else c.primary)
        }
        val agents = store.team.filter { it.kind == CrmTeamMemberKind.AGENT && !it.email.isNullOrBlank() }
        val choices = buildList {
            add(MenuChoice(r.getString(R.string.work_held_by), header = true))
            WorkHolderChoice.entries.forEach { choice ->
                add(MenuChoice(holderTitle(r, choice), checked = filter.holder == choice.wire) { filter.holder = choice.wire })
            }
            agents.forEach { agent ->
                val wire = "agent:${agent.email}"
                add(MenuChoice(agent.name, checked = filter.holder == wire) { filter.holder = wire })
            }
            add(MenuChoice(r.getString(R.string.work_due), startsGroup = true, header = true))
            WorkDueFilter.entries.forEach { choice ->
                add(MenuChoice(dueTitle(r, choice), checked = filter.due == choice) { filter.due = choice })
            }
            add(MenuChoice(r.getString(R.string.work_side), startsGroup = true, header = true))
            WorkSideFilter.entries.forEach { choice ->
                add(MenuChoice(sideTitle(r, choice), checked = filter.side == choice) { filter.side = choice })
            }
            // A tick is a column shown; a tap shows or hides it on every project.
            add(MenuChoice(r.getString(R.string.work_columns), startsGroup = true, header = true))
            WorkStage.entries.forEach { stage ->
                val shown = stage !in hidden
                add(
                    MenuChoice(WorkFormat.stageTitle(r, stage), checked = shown) {
                        scope.launch {
                            try {
                                store.setBoardHiddenStages(BoardColumns.toggled(hidden, stage, !shown))
                                filter.error = null
                            } catch (e: Exception) {
                                if (e is CancellationException) throw e
                                filter.error = e.workMessage()
                            }
                        }
                    },
                )
            }
        }
        ChoiceMenu(open, { open = false }, choices)
    }
}

/**
 * A subject's Tasks filter (`MobileSubjectTasksView.filterMenu`):
 * Due and Side, the same choices as the board's. It lasts the session.
 */
@Composable
internal fun TaskFilterButton(due: WorkDueFilter, side: WorkSideFilter, onDue: (WorkDueFilter) -> Unit, onSide: (WorkSideFilter) -> Unit) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    var open by remember { mutableStateOf(false) }
    val label = r.getString(R.string.work_filter_the_tasks)
    val narrowed = due != WorkDueFilter.ANY || side != WorkSideFilter.ANY
    Box {
        Box(
            Modifier
                .size(44.dp)
                .clickable(role = Role.Button) { open = true }
                .clearAndSetSemantics { contentDescription = label; role = Role.Button },
            contentAlignment = Alignment.Center,
        ) {
            Icon(if (narrowed) Icons.Filled.FilterAlt else Icons.Outlined.FilterAlt, null, Modifier.size(22.dp), tint = if (narrowed) c.accent else c.primary)
        }
        val choices = buildList {
            add(MenuChoice(r.getString(R.string.work_due), header = true))
            WorkDueFilter.entries.forEach { choice -> add(MenuChoice(dueTitle(r, choice), checked = due == choice) { onDue(choice) }) }
            add(MenuChoice(r.getString(R.string.work_side), startsGroup = true, header = true))
            WorkSideFilter.entries.forEach { choice -> add(MenuChoice(sideTitle(r, choice), checked = side == choice) { onSide(choice) }) }
        }
        ChoiceMenu(open, { open = false }, choices)
    }
}

private fun holderTitle(r: Resources, choice: WorkHolderChoice): String = r.getString(
    when (choice) {
        WorkHolderChoice.ANYONE -> R.string.work_anyone
        WorkHolderChoice.PEOPLE -> R.string.work_people
        WorkHolderChoice.AGENTS -> R.string.work_any_agent
    },
)

private fun dueTitle(r: Resources, choice: WorkDueFilter): String = r.getString(
    when (choice) {
        WorkDueFilter.ANY -> R.string.work_any_date
        WorkDueFilter.OVERDUE -> R.string.work_overdue
    },
)

private fun sideTitle(r: Resources, choice: WorkSideFilter): String = r.getString(
    when (choice) {
        WorkSideFilter.ANY -> R.string.work_any_side
        WorkSideFilter.TEAM -> R.string.work_side_team
        WorkSideFilter.CLIENT -> R.string.work_side_client
        WorkSideFilter.UNASSIGNED -> R.string.work_unassigned
    },
)
