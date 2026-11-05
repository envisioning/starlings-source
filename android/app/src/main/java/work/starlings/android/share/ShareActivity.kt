package work.starlings.android.share

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import work.starlings.android.AppEnvironment
import work.starlings.android.R
import work.starlings.android.StarlingsApp
import work.starlings.android.StarlingsTheme
import work.starlings.android.share.ShareIntake.Shared
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.FormSheetBar
import work.starlings.android.ui.ListFooter
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsSpacing
import work.starlings.android.ui.StarlingsType
import java.util.UUID

/**
 * The share target (`iOSShare/ShareViewController.swift`): a sheet over the
 * app that shared. A link saves to Docs with a title and a note; other text
 * is kept as a Quick Note. The share goes to the outbox first and is sent at
 * once; offline it waits there for the app's next start.
 */
class ShareActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val shared = read(intent)
        val app = application as StarlingsApp
        setContent {
            StarlingsTheme {
                ShareSheet(app, shared, onClose = ::finish)
            }
        }
    }

    private fun read(intent: Intent?): Shared {
        if (intent?.action != Intent.ACTION_SEND) return Shared.Empty
        return ShareIntake.read(intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString(), intent.getStringExtra(Intent.EXTRA_SUBJECT))
    }
}

private enum class Phase { READY, SAVING, SENT, QUEUED }

@Composable
private fun ShareSheet(app: StarlingsApp, shared: Shared, onClose: () -> Unit) {
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    val signedIn = remember { app.account.session.credentials() != null }
    var phase by rememberSaveable { mutableStateOf(Phase.READY) }
    var title by rememberSaveable { mutableStateOf((shared as? Shared.Link)?.title.orEmpty()) }
    var note by rememberSaveable { mutableStateOf("") }
    var body by rememberSaveable { mutableStateOf((shared as? Shared.Note)?.body.orEmpty()) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }

    val isNote = shared is Shared.Note
    val canSave = phase == Phase.READY && signedIn && when (shared) {
        is Shared.Link -> true
        is Shared.Note -> body.isNotBlank()
        Shared.Empty -> false
    }
    val keepFailure = if (isNote) "Couldn’t save as Quick Note" else "Couldn’t keep the page for Starlings."

    fun save() {
        if (!canSave) return
        val outbox = ShareDrain.outbox(app) ?: return
        val item = when (shared) {
            is Shared.Link -> ShareOutboxItem(
                id = UUID.randomUUID().toString().lowercase(), createdAt = System.currentTimeMillis(), workspaceOrigin = work.starlings.android.Workspaces.active.webOrigin,
                kind = ShareOutboxItem.Kind.LINK, url = shared.url, title = title.trim().ifEmpty { null }, note = note.trim(),
            )
            is Shared.Note -> ShareOutboxItem(
                id = UUID.randomUUID().toString().lowercase(), createdAt = System.currentTimeMillis(), workspaceOrigin = work.starlings.android.Workspaces.active.webOrigin,
                kind = ShareOutboxItem.Kind.NOTE, body = body.trim().take(ShareIntake.NOTE_MAX_CHARS),
            )
            Shared.Empty -> return
        }
        try {
            outbox.write(item)
        } catch (_: Exception) {
            error = keepFailure
            return
        }
        error = null
        phase = Phase.SAVING
        scope.launch {
            val outcome = runCatching { ShareDrain.drain(app).await()[item.id] }.getOrNull()
            when (outcome) {
                ShareOutbox.Outcome.SENT -> phase = Phase.SENT
                ShareOutbox.Outcome.REFUSED -> {
                    phase = Phase.READY
                    error = if (isNote) "Couldn’t save Quick Note" else "Couldn’t save that link"
                }
                ShareOutbox.Outcome.KEPT, null -> phase = Phase.QUEUED
            }
        }
    }

    // A scrim over the sharing app, the sheet at the foot, as iOS presents an extension.
    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.4f))
            .clickable(remember { MutableInteractionSource() }, indication = null, onClick = onClose),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Column(
            Modifier
                .widthIn(max = 600.dp)
                .fillMaxWidth()
                .background(c.canvas, RoundedCornerShape(topStart = StarlingsRadius.card, topEnd = StarlingsRadius.card))
                .clickable(remember { MutableInteractionSource() }, indication = null) {}
                .navigationBarsPadding()
                .imePadding()
                .padding(bottom = StarlingsSpacing.screen),
        ) {
            FormSheetBar(
                title = stringResource(if (isNote) R.string.sharesheet_quick_note else R.string.sharesheet_save_to_docs),
                closeLabel = stringResource(R.string.sharesheet_close),
                onClose = onClose,
                confirm = stringResource(R.string.sharesheet_save),
                confirmEnabled = canSave,
                onConfirm = { save() },
            )
            Column(
                Modifier.verticalScroll(rememberScrollState()).padding(horizontal = StarlingsSpacing.screen),
                verticalArrangement = Arrangement.spacedBy(StarlingsSpacing.fields),
            ) {
                when {
                    phase == Phase.SENT || phase == Phase.QUEUED -> {
                        val said = when {
                            isNote && phase == Phase.SENT -> R.string.sharesheet_note_saved
                            isNote -> R.string.sharesheet_note_later
                            phase == Phase.SENT -> R.string.sharesheet_saved
                            else -> R.string.sharesheet_saved_later
                        }
                        Text(stringResource(said), style = StarlingsType.body, color = c.primary)
                        FilledButton(stringResource(R.string.sharesheet_done), onClose)
                    }
                    shared == Shared.Empty -> Secondary(stringResource(R.string.sharesheet_not_a_page))
                    !signedIn -> Secondary(stringResource(R.string.sharesheet_sign_in_first))
                    shared is Shared.Link -> {
                        Text(
                            ShareIntake.host(shared.url),
                            Modifier.padding(start = 16.dp),
                            style = StarlingsType.footnote, color = c.secondary,
                        )
                        StarlingsField(title, { title = it }, stringResource(R.string.sharesheet_title), capitalization = KeyboardCapitalization.Sentences)
                        StarlingsField(
                            note, { note = it }, stringResource(R.string.sharesheet_note),
                            capitalization = KeyboardCapitalization.Sentences, singleLine = false, maxLines = 8,
                        )
                        ListFooter(stringResource(R.string.sharesheet_saves_to, AppEnvironment.WORKSPACE_NAME))
                    }
                    shared is Shared.Note -> {
                        StarlingsField(
                            body, { body = it }, stringResource(R.string.sharesheet_quick_note),
                            capitalization = KeyboardCapitalization.Sentences, singleLine = false, maxLines = 10,
                        )
                        ListFooter(stringResource(R.string.sharesheet_saves_to, AppEnvironment.WORKSPACE_NAME))
                    }
                }
                error?.let { ShareErrorLine(it) }
            }
        }
    }
}

@Composable
private fun Secondary(text: String) {
    Text(text, Modifier.padding(vertical = 8.dp), style = StarlingsType.body, color = Starlings.colors.secondary)
}

/** `ShareErrorLine` (iOSShare/ShareSheet.swift): the error in danger ink, with Copy. */
@Composable
private fun ShareErrorLine(message: String) {
    val c = Starlings.colors
    val clipboard = LocalClipboardManager.current
    var copied by remember(message) { mutableStateOf(false) }
    val copyLabel = stringResource(R.string.sharesheet_copy_error)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
        Text(message, Modifier.weight(1f), style = StarlingsType.footnote, color = c.danger)
        Text(
            stringResource(if (copied) R.string.sharesheet_copied else R.string.sharesheet_copy),
            Modifier
                .clickable(role = Role.Button) {
                    clipboard.setText(AnnotatedString(message))
                    copied = true
                }
                .semantics { contentDescription = copyLabel },
            style = StarlingsType.footnote.copy(fontWeight = FontWeight.SemiBold),
            color = c.danger,
        )
    }
}
