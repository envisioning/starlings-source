package work.starlings.android.keep.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.keep.KeepItemBody
import work.starlings.android.keep.KeepItemKind
import work.starlings.android.keep.KeepSession
import work.starlings.android.keep.KeepTOTP
import work.starlings.android.keep.KeepVaultDetail
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkIconButton
import work.starlings.android.ui.WorkMark
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkTopBar

/** One entry of a bar's More menu. */
internal class KeepMenuEntry(val title: String, val action: () -> Unit)

/** The bar's More: the secondary actions iOS folds into its toolbar's `…`. */
@Composable
internal fun KeepMoreMenu(entries: List<KeepMenuEntry>) {
    val c = Starlings.colors
    var open by remember { mutableStateOf(false) }
    Box {
        WorkIconButton(Icons.Filled.MoreHoriz, stringResource(R.string.more), { open = true })
        DropdownMenu(open, { open = false }, containerColor = c.elevated) {
            entries.forEach { entry ->
                DropdownMenuItem(
                    text = { Text(entry.title, style = StarlingsType.body, color = c.primary) },
                    onClick = { open = false; entry.action() },
                )
            }
        }
    }
}

/** A list row: the glyph well, the name, a caption, and a trailing caption. */
@Composable
private fun KeepRow(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, subtitle: String, trailing: String? = null, onClick: () -> Unit) {
    val c = Starlings.colors
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WorkMark(icon, size = 40.dp, glyphScale = 0.42f)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = StarlingsType.body, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(subtitle, style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        trailing?.let { Text(it, style = StarlingsType.caption, color = c.secondary) }
    }
}

/** The search well over a list (`.searchable(prompt:)`). */
@Composable
private fun KeepSearch(value: String, onChange: (String) -> Unit, prompt: String) {
    Box(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) { StarlingsField(value, onChange, placeholder = prompt) }
}

/**
 * The vault list (`KeepVaultsView`), with the lock and the way to a new
 * vault. Every appearance re-reads the list.
 */
@Composable
internal fun KeepVaultsScreen(session: KeepSession, onBack: () -> Unit, push: (KeepPage) -> Unit) {
    val c = Starlings.colors
    var creating by remember { mutableStateOf(false) }
    var filter by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(Unit) {
        session.touch()
        session.loadVaults()
    }
    val needle = filter.trim().lowercase()
    val shown = if (needle.isEmpty()) session.vaults else session.vaults.filter { it.name.lowercase().contains(needle) }
    Column(Modifier.fillMaxSize().background(c.canvas)) {
        WorkTopBar(stringResource(R.string.keep_title), stringResource(R.string.back), onBack) {
            WorkIconButton(Icons.Filled.Add, stringResource(R.string.keep_new_vault), { creating = true }, tint = c.accent)
            KeepMoreMenu(
                listOf(
                    KeepMenuEntry(stringResource(R.string.keep_settings)) { push(KeepPage.Settings) },
                    KeepMenuEntry(stringResource(R.string.keep_lock)) { session.lock() },
                ),
            )
        }
        KeepSearch(filter, { filter = it }, stringResource(R.string.keep_vaults_search))
        LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            item {
                WorkSection(Modifier.padding(top = 8.dp)) {
                    val error = session.vaultsError
                    when {
                        error != null -> WorkErrorNotice(error)
                        !session.vaultsLoaded -> WorkPlaceholderRows()
                        session.vaults.isEmpty() -> WorkNote(stringResource(R.string.keep_no_vaults))
                    }
                    shown.forEachIndexed { index, vault ->
                        if (index > 0) WorkDivider()
                        val items = pluralStringResource(R.plurals.keep_items_count, vault.itemCount, vault.itemCount)
                        val members = pluralStringResource(R.plurals.keep_members_count, vault.memberCount, vault.memberCount)
                        KeepRow(vaultIcon(vault.icon), vault.name, "$items · $members") { push(KeepPage.Vault(vault.id)) }
                    }
                }
            }
        }
    }
    if (creating) KeepNewVaultSheet(session, onDismiss = { creating = false }) { creating = false }
}

/** The project door (`KeepProjectVaultView`): find or make the project's vault, then show it. */
@Composable
internal fun KeepProjectVault(session: KeepSession, landing: KeepLanding.Project, onBack: () -> Unit, push: (KeepPage) -> Unit) {
    var vaultId by remember(landing) { mutableStateOf<String?>(null) }
    var error by remember(landing) { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }
    LaunchedEffect(landing, attempt) {
        error = null
        try {
            vaultId = session.ensureVault(landing.id, landing.name)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message
        }
    }
    val id = vaultId
    if (id != null) {
        KeepVaultScreen(session, id, onBack, push)
        return
    }
    Column(Modifier.fillMaxSize().background(Starlings.colors.canvas)) {
        WorkTopBar(landing.name, stringResource(R.string.back), onBack)
        val message = error
        if (message != null) {
            KeepGate(landing.name, message) {
                KeepAsyncButton(stringResource(R.string.keep_try_again), filled = false) { attempt++ }
            }
        } else {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(stringResource(R.string.keep_opening_vault), style = StarlingsType.body, color = Starlings.colors.secondary)
            }
        }
    }
}

/** Reads one vault, again whenever [reload] changes. */
@Composable
private fun rememberVault(session: KeepSession, vaultId: String, reload: Int): Pair<KeepVaultDetail?, String?> {
    var vault by remember(vaultId) { mutableStateOf<KeepVaultDetail?>(null) }
    var error by remember(vaultId) { mutableStateOf<String?>(null) }
    LaunchedEffect(vaultId, reload) {
        try {
            vault = session.client.vault(vaultId)
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message
        }
    }
    return vault to error
}

private enum class VaultSheet { NEW_ITEM, MEMBERS, ACTIVITY }

/** One vault (`KeepVaultView`): its items, and the doors to members, activity and a new item. */
@Composable
internal fun KeepVaultScreen(session: KeepSession, vaultId: String, onBack: () -> Unit, push: (KeepPage) -> Unit) {
    val c = Starlings.colors
    val context = LocalContext.current
    var reload by remember { mutableStateOf(0) }
    val (vault, error) = rememberVault(session, vaultId, reload)
    var sheet by remember { mutableStateOf<VaultSheet?>(null) }
    var filter by rememberSaveable(vaultId) { mutableStateOf("") }
    LaunchedEffect(vaultId) { session.touch() }
    val needle = filter.trim().lowercase()
    val items = vault?.items.orEmpty().let { all ->
        if (needle.isEmpty()) all else all.filter { it.name.lowercase().contains(needle) || it.kind.label.lowercase().contains(needle) }
    }
    val core = vault?.projectId?.let { project -> session.me?.coreWebOrigin?.let { "$it/dashboard/projects/$project" } }
    Column(Modifier.fillMaxSize().background(c.canvas)) {
        WorkTopBar(vault?.name ?: stringResource(R.string.keep_vault), stringResource(R.string.back), onBack) {
            if (vault != null) WorkIconButton(Icons.Filled.Add, stringResource(R.string.keep_new_item), { sheet = VaultSheet.NEW_ITEM }, tint = c.accent)
            KeepMoreMenu(
                buildList {
                    add(KeepMenuEntry(stringResource(R.string.keep_vault_settings)) { if (vault != null) sheet = VaultSheet.MEMBERS })
                    add(KeepMenuEntry(stringResource(R.string.keep_activity)) { sheet = VaultSheet.ACTIVITY })
                    if (core != null) {
                        add(KeepMenuEntry(stringResource(R.string.keep_open_in_core)) {
                            runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(core))) }
                        })
                    }
                },
            )
        }
        KeepSearch(filter, { filter = it }, stringResource(R.string.keep_items_search))
        LazyColumn(Modifier.fillMaxSize()) {
            item {
                WorkSection(Modifier.padding(top = 8.dp)) {
                    when {
                        vault == null && error != null -> WorkErrorNotice(error)
                        vault == null -> WorkPlaceholderRows()
                        vault.items.isEmpty() -> WorkNote(stringResource(R.string.keep_nothing_here))
                    }
                    items.forEachIndexed { index, item ->
                        if (index > 0) WorkDivider()
                        KeepRow(kindIcon(item.kind), item.name, item.kind.label, keepWhen(item.updatedAt)) { push(KeepPage.Item(vaultId, item.id)) }
                    }
                }
            }
        }
    }
    val open = vault
    when (sheet) {
        VaultSheet.NEW_ITEM -> if (open != null) KeepItemEditor(session, open, null, KeepItemBody(), onDismiss = { sheet = null }) {
            sheet = null
            reload++
        }
        VaultSheet.MEMBERS -> if (open != null) KeepMembersSheet(session, open, onDismiss = { sheet = null }, onChanged = { reload++ }) {
            sheet = null
            onBack()
        }
        VaultSheet.ACTIVITY -> KeepActivitySheet(session, vaultId) { sheet = null }
        null -> Unit
    }
}

/**
 * Reveal (`KeepItemView`): one fetch (audited), opened in [KeepSession],
 * shown until the screen goes away. The plaintext lives in this screen's
 * state and nowhere else, and is dropped when it leaves.
 */
@Composable
internal fun KeepItemScreen(session: KeepSession, vaultId: String, itemId: String, onBack: () -> Unit) {
    val c = Starlings.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var reload by remember { mutableStateOf(0) }
    val (vault, vaultError) = rememberVault(session, vaultId, reload)
    val item = vault?.items?.firstOrNull { it.id == itemId }
    var body by remember(itemId) { mutableStateOf<KeepItemBody?>(null) }
    var error by remember(itemId) { mutableStateOf<String?>(null) }
    var showPassword by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf<String?>(null) }
    var copyTick by remember { mutableLongStateOf(0L) }

    LaunchedEffect(vault, item) {
        if (vault == null || item == null || body != null) return@LaunchedEffect
        try {
            body = session.open(item, vault)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message
        }
    }
    DisposableEffect(itemId) { onDispose { body = null } }
    LaunchedEffect(copyTick) {
        if (copyTick == 0L) return@LaunchedEffect
        delay(1800)
        copied = null
    }
    fun copy(label: String, value: String, notice: String) {
        session.touch()
        copySecret(context, label, value)
        copied = notice
        copyTick++
    }

    Box(Modifier.fillMaxSize().background(c.canvas)) {
        Column(Modifier.fillMaxSize()) {
            WorkTopBar(item?.name ?: "", stringResource(R.string.back), onBack) {
                WorkIconButton(Icons.Filled.Edit, stringResource(R.string.keep_edit), { if (body != null) editing = true })
                WorkIconButton(Icons.Outlined.Delete, stringResource(R.string.keep_delete), { confirmDelete = true }, tint = c.danger)
            }
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                val open = body
                val shownError = error ?: vaultError
                when {
                    open != null && item != null -> {
                        val rows = buildList<@Composable () -> Unit> {
                            if (open.username.isNotEmpty()) add { KeepField(stringResource(R.string.keep_username), open.username) { l -> copy(l, open.username, context.getString(R.string.keep_copied, l)) } }
                            if (open.password.isNotEmpty()) {
                                val label = stringResource(if (item.kind == KeepItemKind.API_KEY) R.string.keep_key else R.string.keep_password)
                                add {
                                    KeepField(label, open.password, masked = !showPassword, toggle = { showPassword = !showPassword }) { l ->
                                        copy(l, open.password, context.getString(R.string.keep_copied, l))
                                    }
                                }
                            }
                            if (open.url.isNotEmpty()) add { KeepField(stringResource(R.string.keep_url), open.url) { l -> copy(l, open.url, context.getString(R.string.keep_copied, l)) } }
                            if (open.totp.isNotEmpty()) {
                                val totp = KeepTOTP.parse(open.totp)
                                if (totp != null) {
                                    add { KeepTOTPRow(totp) { code -> copy(context.getString(R.string.keep_one_time_code), code, context.getString(R.string.keep_code_copied)) } }
                                } else {
                                    add { KeepField(stringResource(R.string.keep_one_time_code), open.totp, masked = true) { l -> copy(l, open.totp, context.getString(R.string.keep_copied, l)) } }
                                }
                            }
                            if (open.notes.isNotEmpty()) add { KeepField(stringResource(R.string.keep_notes), open.notes) { l -> copy(l, open.notes, context.getString(R.string.keep_copied, l)) } }
                        }
                        if (rows.isNotEmpty()) {
                            ListSection(null, Modifier.padding(horizontal = 16.dp)) {
                                rows.forEachIndexed { index, row -> ListRow(divider = index < rows.lastIndex) { row() } }
                            }
                        }
                        Text(
                            stringResource(R.string.keep_item_footer, item.kind.label, item.createdBy, keepWhen(item.createdAt)),
                            Modifier.padding(horizontal = 32.dp),
                            style = StarlingsType.footnote,
                            color = c.secondary,
                        )
                    }
                    shownError != null -> WorkSection { WorkErrorNotice(shownError) }
                    else -> WorkSection { WorkPlaceholderRows() }
                }
            }
        }
        copied?.let { notice ->
            Text(
                notice,
                Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 24.dp)
                    .background(c.elevated, CircleShape)
                    .border(1.dp, c.border, CircleShape)
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                style = StarlingsType.footnote,
                color = c.primary,
            )
        }
    }

    if (confirmDelete && item != null && vault != null) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            containerColor = c.elevated,
            title = { Text(stringResource(R.string.keep_delete_item_title, item.name), style = StarlingsType.headline, color = c.primary) },
            text = { Text(stringResource(R.string.keep_delete_item_message), style = StarlingsType.body, color = c.secondary) },
            confirmButton = {
                TextButton({
                    confirmDelete = false
                    scope.launch {
                        try {
                            session.deleteItem(item, vault)
                            onBack()
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            error = e.message
                        }
                    }
                }) { Text(stringResource(R.string.keep_delete), color = c.danger) }
            },
            dismissButton = { TextButton({ confirmDelete = false }) { Text(stringResource(R.string.keep_cancel), color = c.primary) } },
        )
    }
    val open = body
    if (editing && open != null && item != null && vault != null) {
        KeepItemEditor(session, vault, item, open, onDismiss = { editing = false }) {
            editing = false
            // As iOS: a saved edit goes back to the vault, which reads its list again.
            onBack()
        }
    }
}

/** One revealed field: the caption, the value in monospace (masked on demand), Show or Hide, and a copy. */
@Composable
private fun KeepField(label: String, value: String, masked: Boolean = false, toggle: (() -> Unit)? = null, onCopy: (String) -> Unit) {
    val c = Starlings.colors
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label.uppercase(), style = StarlingsType.caption, color = c.secondary)
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val text = if (masked) "•".repeat(minOf(value.length, 24)) else value
            Box(Modifier.weight(1f)) {
                if (masked) {
                    Text(text, style = StarlingsType.body.copy(fontFamily = FontFamily.Monospace), color = c.primary)
                } else {
                    SelectionContainer { Text(text, style = StarlingsType.body.copy(fontFamily = FontFamily.Monospace), color = c.primary) }
                }
            }
            if (toggle != null) {
                Text(
                    stringResource(if (masked) R.string.keep_show else R.string.keep_hide),
                    Modifier.clickable(role = Role.Button, onClick = toggle).padding(horizontal = 4.dp),
                    style = StarlingsType.body,
                    color = c.accent,
                )
            }
            KeepCopyButton { onCopy(label) }
        }
    }
}

@Composable
private fun KeepCopyButton(onClick: () -> Unit) {
    val label = stringResource(R.string.keep_copy)
    Box(
        Modifier.size(28.dp).clickable(role = Role.Button, onClick = onClick).clearAndSetSemantics { contentDescription = label; role = Role.Button },
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.Outlined.ContentCopy, null, Modifier.size(18.dp), tint = Starlings.colors.accent)
    }
}

/**
 * The current code, large, with the seconds left and a copy
 * (`KeepTOTPRow`). Ticks once a second; the secret never leaves the
 * [KeepTOTP] it was parsed into.
 */
@Composable
private fun KeepTOTPRow(totp: KeepTOTP, onCopy: (String) -> Unit) {
    val c = Starlings.colors
    var now by remember { mutableLongStateOf(System.currentTimeMillis() / 1000) }
    LaunchedEffect(totp) {
        while (true) {
            now = System.currentTimeMillis() / 1000
            delay(1000 - System.currentTimeMillis() % 1000)
        }
    }
    val code = totp.code(now)
    val remaining = totp.secondsRemaining(now)
    val spaced = if (code.length == 6) code.take(3) + " " + code.takeLast(3) else code
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(stringResource(R.string.keep_one_time_code).uppercase(), style = StarlingsType.caption, color = c.secondary)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            SelectionContainer {
                Text(spaced, style = StarlingsType.title2.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium), color = c.primary)
            }
            val secondsLabel = stringResource(R.string.keep_seconds_left, remaining)
            Box(Modifier.size(28.dp).clearAndSetSemantics { contentDescription = secondsLabel }, contentAlignment = Alignment.Center) {
                val ring = if (remaining <= 5) c.danger else c.accent
                val track = c.border
                androidx.compose.foundation.Canvas(Modifier.fillMaxSize()) {
                    val stroke = Stroke(width = 3.dp.toPx(), cap = StrokeCap.Round)
                    drawArc(track, 0f, 360f, false, style = Stroke(width = 3.dp.toPx()))
                    drawArc(ring, -90f, 360f * remaining / totp.period, false, style = stroke)
                }
                Text("$remaining", style = StarlingsType.caption2, color = c.secondary)
            }
            Spacer(Modifier.weight(1f))
            KeepCopyButton { onCopy(code) }
        }
        (totp.issuer ?: totp.account)?.let { Text(it, style = StarlingsType.footnote, color = c.secondary) }
    }
}
