package work.starlings.android.workspace.work

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.api.Answer
import work.starlings.android.api.Route
import work.starlings.android.api.TeamMediaRoutes
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkActionRow
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkHeaderTitle
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkSection
import work.starlings.android.workspace.team.isWithdrawn
import work.starlings.contracts.CardLinesResponse
import work.starlings.contracts.ThreadMessageType
import work.starlings.contracts.ThreadMessageWire
import work.starlings.contracts.ThreadQuestionAnswer
import work.starlings.contracts.ThreadQuestionMode

/** `StarlingsThreadRoutes.cardLines`: what was said about one task or issue, across the threads the member can read, oldest first. */
internal object CardLines {
    fun route(kind: String, id: String): Route<CardLinesResponse> = Route(
        "GET", listOf("card-lines"), query = listOf("kind" to kind, "id" to id),
        answer = Answer.Wire(CardLinesResponse.serializer()), operation = "Couldn’t load what was said about this",
    )

    /** The latest answer to each question, by the question's id. */
    fun answers(lines: List<ThreadMessageWire>): Map<String, ThreadQuestionAnswer> =
        lines.mapNotNull { line -> line.questionAnswer?.let { it.questionMessageId to it } }.toMap()

    /** Every line but the answers: an answer shows under its question. */
    fun shown(lines: List<ThreadMessageWire>): List<ThreadMessageWire> = lines.filter { it.questionAnswer == null }
}

/**
 * `MobileCardActivitySection`: the hand-off with its brief, the agent's
 * steps and answers, its questions, the event lines. A question with one
 * answer is answered here; the answer clears Inbox and Talk too.
 */
@Composable
internal fun CardActivitySection(store: WorkStore, refKind: String, refId: String) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var lines by remember(refId) { mutableStateOf<List<ThreadMessageWire>?>(null) }
    var error by remember(refId) { mutableStateOf<String?>(null) }
    var submitting by remember { mutableStateOf<Set<String>>(emptySet()) }

    LaunchedEffect(refId) {
        try {
            lines = store.client.call(CardLines.route(refKind, refId)).lines
            error = null
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.workMessage()
        }
    }

    fun answer(line: ThreadMessageWire, optionId: String) {
        submitting = submitting + line.id
        scope.launch {
            try {
                val result = store.client.call(TeamMediaRoutes.answerQuestion(line.threadId, line.id, listOf(optionId)))
                lines = lines.orEmpty() + result.message
                store.questionResolved()
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                error = e.workMessage()
            } finally {
                submitting = submitting - line.id
            }
        }
    }

    WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_activity)) }) {
        val read = lines
        when {
            error != null -> WorkErrorNotice(error!!)
            read == null -> WorkPlaceholderRows()
            else -> {
                val answers = CardLines.answers(read)
                val shown = CardLines.shown(read)
                if (shown.isEmpty()) WorkNote(r.getString(R.string.work_nothing_said))
                shown.forEachIndexed { index, line ->
                    if (index > 0) WorkDivider()
                    val withdrawn = line.isWithdrawn
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("${line.senderName ?: line.senderEmail} · ${WorkFormat.dateTime(line.sentAt)}", style = StarlingsType.caption, color = c.secondary)
                        SelectionContainer {
                            Text(
                                if (withdrawn) r.getString(R.string.work_withdrawn_line) else line.text,
                                style = StarlingsType.subheadline,
                                color = if (line.type == ThreadMessageType.EVENT) c.secondary else c.primary,
                            )
                        }
                        val question = line.question
                        if (question != null && !withdrawn) {
                            val answered = answers[line.id]
                            when {
                                answered != null -> Text(r.getString(R.string.work_answered_options, answered.optionLabels.joinToString(", ")), style = StarlingsType.footnote, color = c.secondary)
                                question.mode == ThreadQuestionMode.SINGLE -> question.options.forEach { option ->
                                    WorkActionRow(option.label, { answer(line, option.id) }, enabled = line.id !in submitting, accent = true)
                                }
                                else -> Text(r.getString(R.string.work_answer_in_talk), style = StarlingsType.footnote, color = c.secondary)
                            }
                        }
                    }
                }
            }
        }
    }
}
