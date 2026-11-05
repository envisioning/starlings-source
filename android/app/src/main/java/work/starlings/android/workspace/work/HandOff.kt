package work.starlings.android.workspace.work

import android.content.res.Resources
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import work.starlings.android.MentionMatching
import work.starlings.android.R
import work.starlings.android.api.TeamRoutes
import work.starlings.android.ui.PickerOption
import work.starlings.android.ui.SearchablePickerRow
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkHeaderTitle
import work.starlings.android.ui.WorkRowAction
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSheet
import work.starlings.android.workspace.team.displayName
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.PeerWire
import work.starlings.contracts.ThreadHandoff
import work.starlings.contracts.ThreadMessageRefKind
import work.starlings.contracts.ThreadSendRef

/**
 * What a hand-off names (`HandOffTarget`, Sources/WorkItems.swift): the
 * card's title, its issue number when it is one, and the ref the runtime
 * reads its ticket from. The subject is where it is said: its
 * channel. A card with no subject goes to the agent's direct
 * conversation.
 */
internal data class HandOffTarget(
    val title: String,
    val issueNumber: Long?,
    val refKind: String,
    val refId: String,
    val subjectKind: CrmSubjectKind? = null,
    val subjectId: String? = null,
) {
    val inChannel: Boolean get() = subjectKind != null && subjectId != null

    companion object {
        fun task(id: String, title: String, subject: SubjectRef?) =
            HandOffTarget(title, null, "task", id, subject?.kind, subject?.id)

        /** An issue is a project's: the hand-off is said in that project's channel. */
        fun issue(id: String, number: Long, title: String, projectId: String?) =
            HandOffTarget(title, number, "issue", id, projectId?.let { CrmSubjectKind.PROJECT }, projectId)
    }
}

/** `HandOffText`: the text of a Hand off message, the same on the Mac, the phone and the web. */
internal object HandOffText {
    /** "Take #142: Fix the login" for an issue, "Take this task: …" for a task. */
    fun cardLine(r: Resources, issueNumber: Long?, title: String): String =
        issueNumber?.let { "Take #$it: $title" } ?: r.getString(R.string.work_take_this_task, title)

    /** In a channel the message opens with the agent's @mention: the Worker refuses a hand-off without it. */
    fun addressed(text: String, agentEmail: String): String = "@${MentionMatching.localPart(agentEmail)} $text"

    fun message(r: Resources, cardLine: String, doneWhen: String, deliverable: String): String =
        listOf(cardLine, r.getString(R.string.work_done_when_line, doneWhen), r.getString(R.string.work_deliverable_line, deliverable)).joinToString("\n")
}

/** A row's "Hand off to …" waiting for its brief (`MobileHandOffRequest`). */
internal data class HandOffRequest(val target: HandOffTarget, val agent: PeerWire?)

/**
 * `MobileHandOff.send`: the one write a hand-off makes on the phone. A
 * message in the subject's channel, @mentioning the agent, that carries the
 * card's ref and the brief.
 */
internal suspend fun WorkStore.handOff(r: Resources, target: HandOffTarget, agent: PeerWire, handoff: ThreadHandoff) {
    val thread = if (target.subjectKind != null && target.subjectId != null) {
        client.call(TeamRoutes.openSubject(target.subjectKind, target.subjectId)).thread
    } else {
        client.call(TeamRoutes.open(agent.email)).thread
    }
    val text = HandOffText.message(r, HandOffText.cardLine(r, target.issueNumber, target.title), handoff.doneWhen, handoff.deliverable)
    client.call(
        TeamRoutes.send(
            thread.id,
            if (target.inChannel) HandOffText.addressed(text, agent.email) else text,
            refs = listOf(ThreadSendRef(ThreadMessageRefKind(target.refKind), target.refId)),
            mentions = if (target.inChannel) listOf(agent.email) else emptyList(),
            handoff = handoff,
        ),
    )
}

/** One Hand off to with the agents: a caption, then each agent's name. */
internal fun handOffActions(r: Resources, target: HandOffTarget, agents: List<PeerWire>, pick: (HandOffRequest) -> Unit): List<WorkRowAction> =
    if (agents.isEmpty()) emptyList()
    else listOf(WorkRowAction(r.getString(R.string.work_hand_off_to), header = true)) +
        agents.map { agent -> WorkRowAction(agent.displayName) { pick(HandOffRequest(target, agent)) } }

/**
 * A screen's `.sheet(item: $handingOff)`: the editor over [request], then
 * the send. [onResult] gets the agent and null when it landed, else the
 * sentence to show where the screen shows a failed write.
 */
@Composable
internal fun HandOffHost(
    store: WorkStore,
    request: HandOffRequest?,
    agents: List<PeerWire>,
    onDismiss: () -> Unit,
    onResult: (PeerWire, String?) -> Unit,
) {
    val r = LocalContext.current.resources
    val scope = rememberCoroutineScope()
    val wanted = request ?: return
    HandOffSheet(wanted.target.title, agents, wanted.agent, onDismiss) { agent, handoff ->
        scope.launch {
            val failure = try {
                store.handOff(r, wanted.target, agent, handoff)
                null
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                e.workMessage()
            }
            onResult(agent, failure)
        }
    }
}

/**
 * `MobileHandOffEditor`: the agent, what done looks like and what comes
 * back. Both are required, as on the Mac and the web.
 */
@Composable
internal fun HandOffSheet(
    cardTitle: String,
    agents: List<PeerWire>,
    preselected: PeerWire?,
    onDismiss: () -> Unit,
    onHandOff: (PeerWire, ThreadHandoff) -> Unit,
) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    var agentEmail by remember { mutableStateOf("") }
    var doneWhen by remember { mutableStateOf("") }
    var deliverable by remember { mutableStateOf("") }
    val agent = agents.firstOrNull { it.email == agentEmail } ?: preselected ?: agents.firstOrNull()
    val done = doneWhen.trim()
    val back = deliverable.trim()
    WorkSheet(
        r.getString(R.string.work_hand_off), r.getString(R.string.work_close), onDismiss,
        confirm = r.getString(R.string.work_hand_off),
        confirmEnabled = agent != null && done.isNotEmpty() && back.isNotEmpty(),
        onConfirm = {
            val chosen = agent ?: return@WorkSheet
            onHandOff(chosen, ThreadHandoff(doneWhen = done, deliverable = back))
            onDismiss()
        },
    ) {
        WorkSection {
            Text(cardTitle, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), style = StarlingsType.footnote, color = c.secondary)
        }
        WorkSection {
            SearchablePickerRow(
                label = r.getString(R.string.work_agent),
                placeholder = agent?.displayName.orEmpty(),
                options = agents.map { PickerOption(it.email, it.displayName) },
                selection = agent?.email.orEmpty(),
                onPick = { agentEmail = it },
                emptyMessage = r.getString(R.string.work_no_options_match),
            )
        }
        WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_done_when)) }) {
            Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                StarlingsField(doneWhen, { doneWhen = it }, r.getString(R.string.work_done_when_placeholder), singleLine = false, maxLines = 4)
            }
        }
        WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_deliverable)) }) {
            Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                StarlingsField(deliverable, { deliverable = it.replace('\n', ' ') }, r.getString(R.string.work_deliverable_placeholder))
            }
        }
    }
}
