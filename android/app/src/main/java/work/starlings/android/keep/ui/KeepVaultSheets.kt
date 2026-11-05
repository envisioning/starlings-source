package work.starlings.android.keep.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.keep.KeepAuditEvent
import work.starlings.android.keep.KeepDirectoryEntry
import work.starlings.android.keep.KeepSession
import work.starlings.android.keep.KeepVaultDetail
import work.starlings.android.keep.KeepVaultMember
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkActionRow
import work.starlings.android.ui.WorkLabeledRow
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkSheet

private suspend fun <T> attempt(onError: (String?) -> Unit, block: suspend () -> T): T? = try {
    block()
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    onError(e.message)
    null
}

/**
 * A fresh vault key, wrapped to me, each chosen colleague and the recovery
 * key (`KeepNewVaultSheet`). The key bytes never leave [KeepSession].
 */
@Composable
internal fun KeepNewVaultSheet(session: KeepSession, onDismiss: () -> Unit, onCreated: (KeepVaultDetail) -> Unit) {
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var icon by remember { mutableStateOf<String?>(null) }
    var projectId by remember { mutableStateOf("") }
    var directory by remember { mutableStateOf<List<KeepDirectoryEntry>>(emptyList()) }
    var chosen by remember { mutableStateOf(setOf<String>()) }
    var hasRecovery by remember { mutableStateOf<Boolean?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        val me = session.me?.email
        directory = attempt({}) { session.client.directory() }.orEmpty().filter { it.email != me }
        hasRecovery = attempt({}) { session.client.recoveryKey() } != null
    }
    WorkSheet(
        title = stringResource(R.string.keep_new_vault),
        closeLabel = stringResource(R.string.keep_cancel),
        onDismiss = onDismiss,
        confirm = stringResource(R.string.keep_create),
        confirmEnabled = name.isNotBlank() && hasRecovery != null && !busy,
        onConfirm = {
            busy = true
            error = null
            scope.launch {
                val members = directory.filter { it.email in chosen }
                val project = projectId.trim().ifEmpty { null }
                attempt({ error = it }) { session.createVault(name.trim(), icon, project, members) }?.let(onCreated)
                busy = false
            }
        },
    ) {
        ListSection(null, Modifier.padding(horizontal = 16.dp)) {
            ListRow(divider = true) { StarlingsField(name, { name = it }, placeholder = stringResource(R.string.keep_name)) }
            ListRow { StarlingsField(projectId, { projectId = it }, placeholder = stringResource(R.string.keep_project_id)) }
        }
        ListSection(stringResource(R.string.keep_icon), Modifier.padding(horizontal = 16.dp)) { KeepIconPicker(icon) { icon = it } }
        ListSection(stringResource(R.string.keep_members), Modifier.padding(horizontal = 16.dp)) {
            if (directory.isEmpty()) WorkNote(stringResource(R.string.keep_nobody_enrolled))
            directory.forEachIndexed { index, entry ->
                ListRow(divider = index < directory.lastIndex) {
                    StarlingsToggle("${entry.name}\n${entry.email}", entry.email in chosen, { on -> chosen = if (on) chosen + entry.email else chosen - entry.email })
                }
            }
        }
        if (hasRecovery == false) {
            ListSection(null, Modifier.padding(horizontal = 16.dp)) {
                ListRow {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(Icons.Outlined.WarningAmber, null, Modifier.size(18.dp), tint = c.secondary)
                        Text(stringResource(R.string.keep_no_recovery), style = StarlingsType.footnote, color = c.primary)
                    }
                }
            }
        }
        error?.let { Column(Modifier.fillMaxWidth().padding(horizontal = 32.dp)) { KeepErrorText(it) } }
    }
}

/**
 * Vault settings (`KeepMembersSheet`): name and icon, members, and delete.
 * Adding wraps the vault key to them; removing re-seals every item under a
 * new key. Only others can be removed.
 */
@Composable
internal fun KeepMembersSheet(
    session: KeepSession,
    vault: KeepVaultDetail,
    onDismiss: () -> Unit,
    onChanged: () -> Unit,
    onDeleted: () -> Unit,
) {
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var current by remember { mutableStateOf(vault) }
    var name by remember { mutableStateOf(vault.name) }
    var icon by remember { mutableStateOf(vault.icon) }
    var directory by remember { mutableStateOf<List<KeepDirectoryEntry>>(emptyList()) }
    var adding by remember { mutableStateOf<KeepDirectoryEntry?>(null) }
    var picker by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var removing by remember { mutableStateOf<KeepVaultMember?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { directory = attempt({}) { session.client.directory() }.orEmpty() }

    val detailsChanged = name.trim() != current.name || icon != current.icon
    val members = current.members.map { it.email }.toSet()
    val candidates = directory.filter { it.email !in members }

    fun act(block: suspend () -> Unit) {
        busy = true
        error = null
        scope.launch {
            attempt({ error = it }) { block() }
            busy = false
        }
    }

    WorkSheet(title = current.name, closeLabel = stringResource(R.string.done), onDismiss = onDismiss) {
        ListSection(stringResource(R.string.keep_vault), Modifier.padding(horizontal = 16.dp)) {
            ListRow(divider = true) { StarlingsField(name, { name = it }, placeholder = stringResource(R.string.keep_name)) }
            KeepIconPicker(icon) { icon = it }
            if (detailsChanged) {
                WorkActionRow(stringResource(R.string.keep_save), onClick = {
                    act {
                        current = session.updateVault(current, name.trim(), icon, current.projectId)
                        onChanged()
                    }
                }, enabled = name.isNotBlank() && !busy, accent = true)
            }
        }
        ListSection(stringResource(R.string.keep_members), Modifier.padding(horizontal = 16.dp)) {
            current.members.forEachIndexed { index, member ->
                ListRow(divider = index < current.members.lastIndex) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(member.name, style = StarlingsType.body, color = c.primary)
                            Text(stringResource(R.string.keep_member_line, member.email, member.grantedBy), style = StarlingsType.footnote, color = c.secondary)
                        }
                        if (member.email != session.me?.email && current.members.size > 1) {
                            TextButton({ removing = member }, enabled = !busy) { Text(stringResource(R.string.keep_remove), color = c.accent) }
                        }
                    }
                }
            }
        }
        Column {
            ListSection(stringResource(R.string.keep_add), Modifier.padding(horizontal = 16.dp)) {
                if (candidates.isEmpty()) {
                    WorkNote(stringResource(R.string.keep_everyone_member))
                } else {
                    Box {
                        val chosen = adding
                        WorkLabeledRow(stringResource(R.string.keep_person), chosen?.let { "${it.name} (${it.email})" } ?: stringResource(R.string.keep_choose)) { picker = true }
                        DropdownMenu(picker, { picker = false }, containerColor = c.elevated) {
                            candidates.forEach { entry ->
                                DropdownMenuItem(
                                    text = { Text("${entry.name} (${entry.email})", style = StarlingsType.body, color = c.primary) },
                                    trailingIcon = if (entry == chosen) ({ Icon(Icons.Filled.Check, null, tint = c.accent) }) else null,
                                    onClick = { adding = entry; picker = false },
                                )
                            }
                        }
                    }
                    ListRow {
                        KeepLinkButton(stringResource(R.string.keep_add), Icons.Outlined.PersonAdd) {
                            val entry = adding ?: return@KeepLinkButton
                            if (busy) return@KeepLinkButton
                            act {
                                current = session.grant(current, entry)
                                adding = null
                                onChanged()
                            }
                        }
                    }
                }
            }
            Text(stringResource(R.string.keep_members_footnote), Modifier.padding(horizontal = 32.dp, vertical = 6.dp), style = StarlingsType.footnote, color = c.secondary)
        }
        ListSection(null, Modifier.padding(horizontal = 16.dp)) {
            WorkNote(
                stringResource(
                    if (current.recoveryWrapped) R.string.keep_key_version_recoverable else R.string.keep_key_version_unrecoverable,
                    current.keyVersion,
                ),
            )
            WorkActionRow(stringResource(R.string.keep_delete_vault_menu), onClick = { confirmDelete = true }, enabled = !busy, danger = true)
        }
        error?.let { Column(Modifier.fillMaxWidth().padding(horizontal = 32.dp)) { KeepErrorText(it) } }
    }

    removing?.let { member ->
        AlertDialog(
            onDismissRequest = { removing = null },
            containerColor = c.elevated,
            title = { Text(stringResource(R.string.keep_remove_title, member.name), style = StarlingsType.headline, color = c.primary) },
            text = { Text(stringResource(R.string.keep_remove_message), style = StarlingsType.body, color = c.secondary) },
            confirmButton = {
                TextButton({
                    removing = null
                    act {
                        current = session.revoke(current, member.email, directory)
                        onChanged()
                    }
                }) { Text(stringResource(R.string.keep_remove_and_rotate), color = c.danger) }
            },
            dismissButton = { TextButton({ removing = null }) { Text(stringResource(R.string.keep_cancel), color = c.primary) } },
        )
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            containerColor = c.elevated,
            title = { Text(stringResource(R.string.keep_delete_vault_title, current.name, current.items.size), style = StarlingsType.headline, color = c.primary) },
            text = { Text(stringResource(R.string.keep_delete_vault_message), style = StarlingsType.body, color = c.secondary) },
            confirmButton = {
                TextButton({
                    confirmDelete = false
                    act {
                        session.deleteVault(current)
                        onDeleted()
                    }
                }) { Text(stringResource(R.string.keep_delete_vault), color = c.danger) }
            },
            dismissButton = { TextButton({ confirmDelete = false }) { Text(stringResource(R.string.keep_cancel), color = c.primary) } },
        )
    }
}

/** Every reveal, grant, rotation and change on this vault, newest first (`KeepActivitySheet`). */
@Composable
internal fun KeepActivitySheet(session: KeepSession, vaultId: String, onDismiss: () -> Unit) {
    val c = Starlings.colors
    var events by remember { mutableStateOf<List<KeepAuditEvent>?>(null) }
    LaunchedEffect(vaultId) { events = attempt({}) { session.client.audit(vaultId) }.orEmpty() }
    WorkSheet(title = stringResource(R.string.keep_activity), closeLabel = stringResource(R.string.done), onDismiss = onDismiss) {
        ListSection(null, Modifier.padding(horizontal = 16.dp)) {
            val rows = events
            when {
                rows == null -> WorkPlaceholderRows()
                rows.isEmpty() -> WorkNote(stringResource(R.string.keep_nothing_yet))
                else -> rows.forEachIndexed { index, event ->
                    ListRow(divider = index < rows.lastIndex) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(event.kind, style = StarlingsType.footnote.copy(fontFamily = FontFamily.Monospace), color = c.primary)
                            event.itemName?.let { Text(it, style = StarlingsType.body, color = c.primary) }
                        }
                        Text(stringResource(R.string.keep_event_line, event.actor, keepWhen(event.createdAt)), style = StarlingsType.footnote, color = c.secondary)
                    }
                }
            }
        }
    }
}
