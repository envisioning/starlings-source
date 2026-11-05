package work.starlings.android.workspace.docs

import work.starlings.android.ui.ToastTone
import work.starlings.android.ui.toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Cancel
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Verified
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.ui.BorderedButton
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.SegmentedChoice
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType

/** One drawer for both sheets: the headline, the document under it, then the sheet's own rows. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DocsSheetFrame(title: String, documentTitle: String, onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val c = Starlings.colors
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = c.canvas) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().imePadding().verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, style = StarlingsType.headline, color = c.primary)
                Text(documentTitle, style = StarlingsType.footnote, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            content()
        }
    }
}

/** The error a failed write shows in passing (iOS `onToast`): the operation, in English. */
private fun Throwable.said(): String = DocsData.describe(this)

/**
 * DocsUI's `ShareSheet`: the www switch (one link, an email gate on the
 * other side, every visit logged to the CRM) and grants (a revocable link,
 * optionally bound to an address). [onVisibility] gets the detail Docs
 * returned after the switch moved, so the editor's copy agrees.
 */
@Composable
fun DocsShareSheet(
    documentId: String,
    documentTitle: String,
    visibility: String,
    data: DocsData,
    onVisibility: (DocsDocumentDetail) -> Unit,
    onDismiss: () -> Unit,
) {
    val c = Starlings.colors
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var shownVisibility by remember(documentId) { mutableStateOf(visibility) }
    var switching by remember { mutableStateOf(false) }
    var grants by remember { mutableStateOf<List<DocsGrant>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var role by remember { mutableStateOf(DocsShare.VIEWER) }
    var email by remember { mutableStateOf("") }
    var working by remember { mutableStateOf(false) }
    val copiedText = stringResource(R.string.docs_link_copied)
    val copyLabel = stringResource(R.string.docs_copy_link)
    val shared = DocsShare.isShared(shownVisibility)
    val wwwLink = DocsShare.www(documentId)

    fun toast(text: String, tone: ToastTone = ToastTone.NEUTRAL) = work.starlings.android.ui.toast(text, tone)
    fun copy(url: String) {
        clipboard.setText(AnnotatedString(url))
        toast(copiedText)
    }

    LaunchedEffect(documentId) {
        try {
            grants = data.grants(documentId)
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.said()
        }
        loaded = true
    }

    DocsSheetFrame(stringResource(R.string.docs_share), documentTitle, onDismiss) {
        // The www switch. On copies the link at once.
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            StarlingsToggle(stringResource(R.string.docs_share_www), shared, { on ->
                switching = true
                scope.launch {
                    try {
                        val updated = data.setVisibility(documentId, DocsShare.visibility(on))
                        shownVisibility = updated.visibility
                        onVisibility(updated)
                        if (on) copy(wwwLink)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        toast(e.said(), ToastTone.DANGER)
                    } finally {
                        switching = false
                    }
                }
            }, enabled = !switching)
            if (shared) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        wwwLink, Modifier.weight(1f), style = StarlingsType.footnote.copy(fontFamily = FontFamily.Monospace),
                        color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    IconButton(onClick = { copy(wwwLink) }) { Icon(Icons.Outlined.ContentCopy, copyLabel, tint = c.primary) }
                }
                Text(stringResource(R.string.docs_share_www_on), style = StarlingsType.footnote, color = c.secondary)
            } else {
                Text(stringResource(R.string.docs_share_www_off), style = StarlingsType.footnote, color = c.secondary)
            }
        }

        HorizontalDivider(thickness = 1.dp, color = c.border)

        // A new link: who may hold it, and what it lets them do.
        val roles = listOf(DocsShare.VIEWER, DocsShare.COMMENTER)
        SegmentedChoice(
            listOf(stringResource(R.string.docs_share_can_view), stringResource(R.string.docs_share_can_comment)),
            roles.indexOf(role), { role = roles[it] },
        )
        StarlingsField(email, { email = it }, stringResource(R.string.docs_share_address), keyboardType = KeyboardType.Email)
        val trimmed = email.trim()
        Text(
            if (trimmed.isEmpty()) stringResource(R.string.docs_share_anyone_note) else stringResource(R.string.docs_share_bound_note, trimmed),
            style = StarlingsType.footnote, color = c.secondary,
        )
        FilledButton(stringResource(R.string.docs_share_create), {
            working = true
            scope.launch {
                try {
                    val grant = data.createGrant(documentId, DocsShare.grant(role, email))
                    grants = listOf(grant) + grants
                    copy(grant.url)
                    email = ""
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    toast(e.said(), ToastTone.DANGER)
                } finally {
                    working = false
                }
            }
        }, enabled = !working, compact = true)

        HorizontalDivider(thickness = 1.dp, color = c.border)

        val live = DocsShare.live(grants)
        val failure = error
        when {
            failure != null -> Text(failure, style = StarlingsType.footnote, color = c.danger)
            !loaded -> CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = c.secondary)
            live.isEmpty() -> Text(stringResource(R.string.docs_share_none), style = StarlingsType.footnote, color = c.secondary)
            else -> live.forEach { grant ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(grant.email ?: stringResource(R.string.docs_share_anyone), style = StarlingsType.body, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(stringResource(R.string.docs_share_used, DocsShare.roleWord(grant.role), grant.useCount), style = StarlingsType.footnote, color = c.secondary)
                    }
                    IconButton(onClick = { copy(grant.url) }) { Icon(Icons.Outlined.ContentCopy, copyLabel, tint = c.primary) }
                    IconButton(onClick = {
                        scope.launch {
                            try {
                                data.revokeGrant(grant.id)
                                grants = grants.filterNot { it.id == grant.id }
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                toast(e.said(), ToastTone.DANGER)
                            }
                        }
                    }) { Icon(Icons.Outlined.Cancel, stringResource(R.string.docs_revoke), tint = c.primary) }
                }
            }
        }

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            BorderedButton(stringResource(R.string.done), onDismiss, compact = true)
        }
    }
}

/**
 * DocsUI's `SignatureSheet`: one address per signer, a subject, a note.
 * Docs mails each signer their own link; they prove the address with a
 * code and sign the exact bytes on the server. After Send the sheet shows
 * who was asked and where each stands.
 */
@Composable
fun DocsSignatureSheet(documentId: String, documentTitle: String, data: DocsData, onDismiss: () -> Unit) {
    val c = Starlings.colors
    val context = LocalContext.current
    val resources = context.resources
    val scope = rememberCoroutineScope()
    var signers by remember { mutableStateOf("") }
    var subject by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("") }
    var working by remember { mutableStateOf(false) }
    var sent by remember { mutableStateOf<DocsSignatureRequest?>(null) }
    val parties = DocsShare.signers(signers)

    DocsSheetFrame(stringResource(R.string.docs_sign_title), documentTitle, onDismiss) {
        val request = sent
        if (request != null) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    // Decorative: the word beside it says the same.
                    Icon(Icons.Outlined.Verified, null, Modifier.size(18.dp), tint = c.primary)
                    Text(stringResource(R.string.docs_sign_sent), style = StarlingsType.body, color = c.primary)
                }
                request.parties.forEach { party ->
                    Row {
                        Text(party.email, Modifier.weight(1f), style = StarlingsType.footnote, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(DocsShare.statusWord(party.status), style = StarlingsType.footnote, color = c.secondary)
                    }
                }
                val day = DocsShare.expiryDay(request)
                Text(
                    if (day != null) stringResource(R.string.docs_sign_expires_on, day) else stringResource(R.string.docs_sign_expires_default),
                    style = StarlingsType.footnote, color = c.secondary,
                )
            }
        } else {
            StarlingsField(signers, { signers = it }, stringResource(R.string.docs_sign_signers), keyboardType = KeyboardType.Email, singleLine = false, maxLines = 5)
            StarlingsField(subject, { subject = it }, stringResource(R.string.docs_sign_subject))
            StarlingsField(message, { message = it }, stringResource(R.string.docs_sign_note), singleLine = false, maxLines = 4)
            Text(stringResource(R.string.docs_sign_version_note), style = StarlingsType.footnote, color = c.secondary)
        }

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            BorderedButton(stringResource(if (request == null) R.string.docs_cancel else R.string.done), onDismiss, compact = true)
            if (request == null) {
                FilledButton(stringResource(R.string.docs_send), {
                    working = true
                    val count = parties.size
                    scope.launch {
                        try {
                            sent = data.requestSignatures(documentId, DocsShare.signatureRequest(signers, subject, message))
                            toast(resources.getQuantityString(R.plurals.docs_sign_sent_to, count, count))
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            toast(e.said(), ToastTone.DANGER)
                        } finally {
                            working = false
                        }
                    }
                }, enabled = !working && parties.isNotEmpty(), compact = true)
            }
        }
    }
}
