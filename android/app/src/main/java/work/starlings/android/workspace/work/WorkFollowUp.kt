package work.starlings.android.workspace.work

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import work.starlings.android.ui.toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.ui.BorderedButton
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkActionRow
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkHeaderTitle
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSheet
import work.starlings.contracts.InboxFollowUpItem

/**
 * `MobileFollowUpSheet`: after the call, the follow-up drafted
 * for the people outside, the call's tasks with a switch each, and
 * Approve. Approve accepts the switched-on tasks, declines the rest, and
 * opens the draft in the host's own mail app, where it is edited and sent.
 * Starlings sends nothing. Dismiss drops the draft; its tasks stay in INBOX.
 */
@Composable
internal fun FollowUpSheet(store: WorkStore, item: InboxFollowUpItem, onClose: () -> Unit) {
    val context = LocalContext.current
    val r = context.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var kept by remember(item.key) { mutableStateOf(item.tasks.map { it.id }.toSet()) }

    WorkSheet(r.getString(R.string.work_follow_up), r.getString(R.string.work_close), onClose) {
        WorkSection {
            SelectionContainer {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        r.getString(R.string.work_follow_up_to, item.recipients.joinToString(", ") { it.name }),
                        style = StarlingsType.subheadline.copy(fontWeight = FontWeight.SemiBold), color = c.primary,
                    )
                    Text(item.draft.subject, style = StarlingsType.headline, color = c.primary)
                    Text(item.draft.body, style = StarlingsType.callout, color = c.primary)
                }
            }
        }
        if (item.tasks.isNotEmpty()) {
            WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_follow_up_tasks)) }) {
                item.tasks.forEachIndexed { index, task ->
                    if (index > 0) WorkDivider()
                    StarlingsToggle(
                        task.title, task.id in kept,
                        { on -> kept = if (on) kept + task.id else kept - task.id },
                        Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                    )
                }
            }
        }
        WorkSection(footer = null) {
            Text(r.getString(R.string.work_follow_up_footer), Modifier.padding(horizontal = 16.dp, vertical = 10.dp), style = StarlingsType.footnote, color = c.secondary)
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 8.dp)) {
                BorderedButton(
                    r.getString(R.string.work_approve),
                    {
                        val (accept, decline) = FollowUpMail.split(item, kept)
                        onClose()
                        scope.launch {
                            try {
                                val mail = store.approveFollowUp(item, accept, decline)
                                openDraft(context, mail.to, mail.subject, mail.body)
                            } catch (e: Exception) {
                                if (e is CancellationException) throw e
                                store.errorMessage = e.workMessage()
                            }
                        }
                    },
                    Modifier.fillMaxWidth(),
                )
            }
            WorkDivider()
            WorkActionRow(r.getString(R.string.work_dismiss), { onClose(); store.dismissFollowUp(item) }, danger = true)
        }
    }
}

/** The draft in the mail app; a body too long for the link goes to the clipboard, and a toast says so. */
private fun openDraft(context: Context, to: List<String>, subject: String, body: String) {
    val draft = FollowUpMail.draft(to, subject, body)
    if (draft.bodyOnClipboard) {
        (context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager)?.setPrimaryClip(ClipData.newPlainText(subject, body))
    }
    runCatching { context.startActivity(Intent(Intent.ACTION_SENDTO, Uri.parse(draft.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    if (draft.bodyOnClipboard) toast(context.getString(R.string.work_follow_up_on_clipboard))
}
