package work.starlings.android.keep.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.VpnKey
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import work.starlings.android.R
import work.starlings.android.keep.KeepCryptoError
import work.starlings.android.keep.KeepDirectoryEntry
import work.starlings.android.keep.KeepPrivateKey
import work.starlings.android.keep.KeepRecoveryVaultEntry
import work.starlings.android.keep.KeepSession
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkLabeledRow
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkSheet

// Recovery, natively (core-kit `KeepUI/KeepRecoveryViews.swift`): the
// ceremony that makes the key and hands out the two shares, and the sheet
// where a person holding both shares opens a vault nobody else can. Both
// live under Keep's settings, with the key open.

/** The Recovery section of Keep's settings (`KeepRecoverySections`): status, the ceremony, and the door to recovering a vault. */
@Composable
internal fun KeepRecoverySections(session: KeepSession) {
    val c = Starlings.colors
    var ceremony by remember { mutableStateOf(false) }
    var recovering by remember { mutableStateOf(false) }
    LaunchedEffect(session) { if (!session.recoveryLoaded) session.loadRecoveryKey() }

    Column {
        ListSection(stringResource(R.string.keep_recovery)) {
            val key = session.recoveryKey
            when {
                !session.recoveryLoaded -> WorkPlaceholderRows()
                key != null -> {
                    ListRow(divider = true) {
                        Text(
                            stringResource(R.string.keep_recovery_held, holders(key.holders), key.createdBy, keepWhen(key.createdAt)),
                            style = StarlingsType.footnote,
                            color = c.secondary,
                        )
                        val uncovered = session.vaults.count { !it.recoveryWrapped }
                        Text(
                            if (uncovered == 0) stringResource(R.string.keep_recovery_all_covered) else stringResource(R.string.keep_recovery_uncovered, uncovered),
                            style = StarlingsType.footnote,
                            color = c.secondary,
                        )
                    }
                    ListRow { KeepLinkButton(stringResource(R.string.keep_recover_menu), Icons.Outlined.QrCodeScanner) { recovering = true } }
                }
                else -> {
                    ListRow(divider = true) { Text(stringResource(R.string.keep_recovery_none), style = StarlingsType.footnote, color = c.danger) }
                    ListRow { KeepLinkButton(stringResource(R.string.keep_recovery_create_menu), Icons.Outlined.VpnKey) { ceremony = true } }
                }
            }
        }
        Text(stringResource(R.string.keep_recovery_footer), Modifier.padding(horizontal = 16.dp, vertical = 6.dp), style = StarlingsType.footnote, color = c.secondary)
    }
    if (ceremony) KeepRecoveryCeremony(session) { ceremony = false }
    if (recovering) KeepRecoverVaultSheet(session) { recovering = false }
}

@Composable
private fun holders(list: List<String>): String = when (list.size) {
    2 -> stringResource(R.string.keep_recovery_and, list[0], list[1])
    else -> list.joinToString(", ")
}

/**
 * Make the key, split it, show each share once, publish the public half
 * (`KeepRecoveryCeremony`). The shares go to two people's own password
 * managers and nowhere near this system. The private key is gone when the
 * session call returns; the shares are gone when this sheet is.
 */
@Composable
private fun KeepRecoveryCeremony(session: KeepSession, onDismiss: () -> Unit) {
    val c = Starlings.colors
    var directory by remember { mutableStateOf<List<KeepDirectoryEntry>>(emptyList()) }
    var holderA by remember { mutableStateOf("") }
    var holderB by remember { mutableStateOf("") }
    var shares by remember { mutableStateOf<KeepSession.RecoveryShares?>(null) }
    var acknowledged by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        directory = try {
            session.client.directory()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyList()
        }
        val me = session.me?.email
        if (holderA.isEmpty() && me != null && directory.any { it.email == me }) holderA = me
    }
    val shown = shares
    // Closing with the shares on screen and not yet stored would lose them.
    val dismiss = { if (shown == null || acknowledged) onDismiss() }

    WorkSheet(
        title = stringResource(R.string.keep_recovery_key),
        closeLabel = stringResource(if (shown == null) R.string.keep_cancel else R.string.done),
        onDismiss = dismiss,
    ) {
        if (shown != null) {
            ListSection(null, Modifier.padding(horizontal = 16.dp)) {
                ListRow { Text(stringResource(R.string.keep_recovery_shown_once), style = StarlingsType.footnote, color = c.danger) }
            }
            ShareSection(stringResource(R.string.keep_share_a), holderA, shown.a)
            ShareSection(stringResource(R.string.keep_share_b), holderB, shown.b)
            ListSection(null, Modifier.padding(horizontal = 16.dp)) {
                ListRow(divider = true) { StarlingsToggle(stringResource(R.string.keep_shares_stored), acknowledged, { acknowledged = it }) }
                ListRow {
                    KeepAsyncButton(stringResource(R.string.done), enabled = acknowledged) { onDismiss() }
                }
            }
        } else {
            Column {
                ListSection(stringResource(R.string.keep_holders), Modifier.padding(horizontal = 16.dp)) {
                    HolderPicker(stringResource(R.string.keep_holder_a), holderA, directory) { holderA = it }
                    HolderPicker(stringResource(R.string.keep_holder_b), holderB, directory.filter { it.email != holderA }) { holderB = it }
                    WorkNote(stringResource(R.string.keep_holders_footnote))
                }
            }
            error?.let { Column(Modifier.fillMaxWidth().padding(horizontal = 32.dp)) { KeepErrorText(it) } }
            ListSection(null, Modifier.padding(horizontal = 16.dp)) {
                ListRow {
                    KeepAsyncButton(
                        stringResource(R.string.keep_generate_publish),
                        icon = Icons.Outlined.VpnKey,
                        enabled = holderA.isNotEmpty() && holderB.isNotEmpty() && holderA != holderB,
                    ) {
                        error = null
                        try {
                            shares = session.createRecoveryKey(listOf(holderA, holderB))
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            error = e.message
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun HolderPicker(label: String, chosen: String, directory: List<KeepDirectoryEntry>, onChoose: (String) -> Unit) {
    val c = Starlings.colors
    var open by remember { mutableStateOf(false) }
    Box {
        WorkLabeledRow(label, directory.firstOrNull { it.email == chosen }?.name ?: stringResource(R.string.keep_choose)) { open = true }
        DropdownMenu(open, { open = false }, containerColor = c.elevated) {
            directory.forEach { entry ->
                DropdownMenuItem(
                    text = { Text(entry.name, style = StarlingsType.body, color = c.primary) },
                    trailingIcon = if (entry.email == chosen) ({ Icon(Icons.Filled.Check, null, tint = c.accent) }) else null,
                    onClick = { onChoose(entry.email); open = false },
                )
            }
        }
    }
}

@Composable
private fun ShareSection(title: String, holder: String, value: String) {
    val c = Starlings.colors
    val context = LocalContext.current
    ListSection(stringResource(R.string.keep_share_holder, title, holder), Modifier.padding(horizontal = 16.dp)) {
        ListRow(divider = true) {
            SelectionContainer { Text(value, style = StarlingsType.footnote.copy(fontFamily = FontFamily.Monospace), color = c.primary) }
        }
        ListRow {
            KeepLinkButton(stringResource(R.string.keep_copy_share, title.lowercase()), Icons.Outlined.ContentCopy) {
                copySecret(context, title, value)
            }
        }
    }
}

/**
 * Both shares in, the recovery key checked against the published public
 * key, then every covered vault: join the one that is needed
 * (`KeepRecoverVaultSheet`). Each step is written to the audit log by the
 * server. The recovery private key lives only in this sheet's state.
 */
@Composable
private fun KeepRecoverVaultSheet(session: KeepSession, onDismiss: () -> Unit) {
    val c = Starlings.colors
    var shareA by remember { mutableStateOf("") }
    var shareB by remember { mutableStateOf("") }
    var recoveryKey by remember { mutableStateOf<KeepPrivateKey?>(null) }
    var vaults by remember { mutableStateOf<List<KeepRecoveryVaultEntry>>(emptyList()) }
    var joined by remember { mutableStateOf(setOf<String>()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val wrongShares = stringResource(R.string.keep_shares_wrong)

    WorkSheet(title = stringResource(R.string.keep_recover_title), closeLabel = stringResource(R.string.done), onDismiss = onDismiss) {
        val key = recoveryKey
        if (key == null) {
            Column {
                ListSection(stringResource(R.string.keep_shares), Modifier.padding(horizontal = 16.dp)) {
                    WorkNote(stringResource(R.string.keep_paste_shares))
                    ListRow(divider = true) { KeepSecretField(stringResource(R.string.keep_share_a), shareA, { shareA = it }) }
                    ListRow(divider = true) { KeepSecretField(stringResource(R.string.keep_share_b), shareB, { shareB = it }) }
                    ListRow {
                        KeepAsyncButton(stringResource(R.string.keep_open_recovery_key), icon = Icons.Outlined.Key, enabled = shareA.isNotEmpty() && shareB.isNotEmpty() && !busy) {
                            busy = true
                            error = null
                            try {
                                recoveryKey = session.recoveryPrivateKey(shareA, shareB)
                                shareA = ""
                                shareB = ""
                                vaults = session.recoveryVaults()
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: KeepCryptoError) {
                                error = if (e.kind == KeepCryptoError.Kind.CANNOT_OPEN) wrongShares else e.message
                            } catch (e: Exception) {
                                error = e.message
                            } finally {
                                busy = false
                            }
                        }
                    }
                }
                Text(stringResource(R.string.keep_recover_footer), Modifier.padding(horizontal = 32.dp, vertical = 6.dp), style = StarlingsType.footnote, color = c.secondary)
            }
        } else {
            ListSection(stringResource(R.string.keep_recovery_vaults), Modifier.padding(horizontal = 16.dp)) {
                if (vaults.isEmpty()) WorkNote(stringResource(R.string.keep_none))
                vaults.forEachIndexed { index, entry ->
                    ListRow(divider = index < vaults.lastIndex) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(vaultIcon(entry.icon), null, Modifier.size(20.dp), tint = c.secondary)
                            Box(Modifier.width(10.dp))
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(entry.name, style = StarlingsType.body, color = c.primary)
                                Text(
                                    if (entry.members.isEmpty()) stringResource(R.string.keep_no_members) else entry.members.joinToString(", "),
                                    style = StarlingsType.footnote,
                                    color = c.secondary,
                                )
                            }
                            when {
                                entry.id in joined -> Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Icon(Icons.Filled.Check, null, Modifier.size(14.dp), tint = c.secondary)
                                    Text(stringResource(R.string.keep_joined), style = StarlingsType.footnote, color = c.secondary)
                                }
                                entry.members.contains(session.me?.email.orEmpty()) ->
                                    Text(stringResource(R.string.keep_member), style = StarlingsType.footnote, color = c.secondary)
                                else -> KeepAsyncButton(stringResource(R.string.keep_join), enabled = !busy) {
                                    busy = true
                                    error = null
                                    try {
                                        session.recover(entry, key)
                                        joined = joined + entry.id
                                    } catch (e: CancellationException) {
                                        throw e
                                    } catch (e: Exception) {
                                        error = e.message
                                    } finally {
                                        busy = false
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        error?.let { Column(Modifier.fillMaxWidth().padding(horizontal = 32.dp)) { KeepErrorText(it) } }
    }
}
