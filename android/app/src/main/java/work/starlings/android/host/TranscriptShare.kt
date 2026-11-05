package work.starlings.android.host

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import work.starlings.android.ui.ToastTone
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Notes
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import work.starlings.android.R
import work.starlings.android.TranscriptExport
import work.starlings.android.ui.HeaderCircleButton
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import java.io.File

/**
 * `MobileTranscriptShareMenu`: while this device hosts, the
 * transcript's bar gets the record out. The link is the meeting's page on
 * the public origin with no token in it: it grants nothing. The text is the
 * record as the Worker serves it, not the captions on screen, formatted by
 * [TranscriptExport].
 */
@Composable
fun TranscriptShareMenu(host: RoomHost, api: MeetingOwnerApi, modifier: Modifier = Modifier) {
    val state by host.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var open by remember { mutableStateOf(false) }
    var working by remember { mutableStateOf(false) }
    val room = state.room
    val meetingId = state.meetingId
    val link = if (room != null && meetingId != null) TranscriptExport.permalink(work.starlings.android.Workspaces.active.webOrigin, room, meetingId) else null
    val untitled = stringResource(R.string.transcript_untitled)
    val subjectLine = stringResource(R.string.transcript_subject)

    /** The record, fetched now; null after saying why it could not be. */
    suspend fun record(): TranscriptExport.Input? {
        if (room == null || meetingId == null) return null
        working = true
        return try {
            TranscriptExport.input(api.transcript(room, meetingId), untitled, work.starlings.android.Workspaces.active.webOrigin)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            toast(context, context.getString(R.string.transcript_load_failed), ToastTone.DANGER)
            null
        } finally {
            working = false
        }
    }

    Box(modifier.alpha(if (link == null) 0.45f else 1f)) {
        if (working) {
            CircularProgressIndicator(Modifier.size(24.dp), color = Starlings.colors.secondary, strokeWidth = 2.dp)
        } else {
            HeaderCircleButton(Icons.Filled.Share, stringResource(R.string.transcript_share), { if (link != null) open = true })
        }
        DropdownMenu(open, { open = false }) {
            @Composable
            fun item(text: String, icon: ImageVector, onClick: () -> Unit) = DropdownMenuItem(
                text = { Text(text, style = StarlingsType.body) },
                leadingIcon = { Icon(icon, null) },
                onClick = { open = false; onClick() },
            )
            if (link != null) {
                item(stringResource(R.string.transcript_share_link), Icons.Filled.Link) {
                    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link).putExtra(Intent.EXTRA_SUBJECT, subjectLine)
                    runCatching { context.startActivity(Intent.createChooser(send, null)) }
                }
                item(stringResource(R.string.transcript_copy_link), Icons.Filled.ContentCopy) {
                    copy(context, link)
                    toast(context, context.getString(R.string.transcript_link_copied))
                }
            }
            item(stringResource(R.string.transcript_share_file), Icons.Filled.Share) {
                scope.launch {
                    val input = record() ?: return@launch
                    val file = runCatching { writeMarkdown(context, input) }.getOrNull()
                    if (file == null) {
                        toast(context, context.getString(R.string.transcript_file_failed), ToastTone.DANGER)
                        return@launch
                    }
                    val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
                    val send = Intent(Intent.ACTION_SEND)
                        .setType("text/markdown")
                        .putExtra(Intent.EXTRA_STREAM, uri)
                        .putExtra(Intent.EXTRA_SUBJECT, subjectLine)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    runCatching { context.startActivity(Intent.createChooser(send, null)) }
                }
            }
            item(stringResource(R.string.transcript_copy), Icons.AutoMirrored.Filled.Notes) {
                scope.launch {
                    val input = record() ?: return@launch
                    copy(context, TranscriptExport.format(input, TranscriptExport.Format.TEXT))
                    toast(context, context.getString(R.string.transcript_copied))
                }
            }
        }
    }
}

private fun copy(context: Context, text: String) {
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(null, text))
}

/** A failure is a danger toast (`fail`): red, with Copy. */
private fun toast(context: Context, text: String, tone: ToastTone = ToastTone.NEUTRAL) {
    work.starlings.android.ui.toast(text, tone)
}

/**
 * The `.md` file in `cache/transcripts/`, which the FileProvider shares. Android
 * does not say when the share sheet closes, so the folder is emptied before
 * each new file instead: one transcript at most stays on the device.
 */
private suspend fun writeMarkdown(context: Context, input: TranscriptExport.Input): File = withContext(Dispatchers.IO) {
    val dir = File(context.cacheDir, "transcripts").apply { mkdirs() }
    dir.listFiles()?.forEach { it.delete() }
    val name = TranscriptExport.fileName(input.title, input.startedAt, input.timeZone, TranscriptExport.Format.MARKDOWN)
    File(dir, name).apply { writeText(TranscriptExport.format(input, TranscriptExport.Format.MARKDOWN)) }
}
