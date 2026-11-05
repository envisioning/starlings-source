package work.starlings.android.workspace.settings

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.text.format.DateUtils
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import work.starlings.android.AppEnvironment
import work.starlings.android.OwnerAccount
import work.starlings.android.R
import work.starlings.android.api.AccountRoutes
import work.starlings.android.api.StarlingsApiError
import work.starlings.android.api.TeamRoutes
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkActionRow
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.workspace.team.Faces
import work.starlings.android.workspace.team.LocalTeamStore
import work.starlings.android.workspace.team.PersonFace
import work.starlings.android.workspace.team.TeamMedia
import work.starlings.contracts.AvatarResponse
import work.starlings.contracts.McpCallEntry
import work.starlings.contracts.McpCallOutcome
import work.starlings.contracts.McpGrant
import work.starlings.contracts.McpScope

/**
 * `MobileProfilePicture`: what a person picked, as the Worker stores it. A
 * centred square at the shared edge (`avatarEdgePixels`), JPEG at 0.86.
 * Clients square it, not the Worker: a camera-roll photo is a
 * multi-megabyte download for every colleague who opens the roster.
 */
object ProfilePicture {
    /** `ContractConstants.avatarEdgePixels` (fixtures/shared-constants.json). */
    const val EDGE = 512
    const val JPEG_QUALITY = 86

    /** The centred square of a [width] × [height] picture: left, top, side. */
    fun square(width: Int, height: Int): Triple<Int, Int, Int> {
        val side = minOf(width, height)
        return Triple((width - side) / 2, (height - side) / 2, side)
    }

    /** Decoded at about the edge, squared, scaled to [EDGE] and encoded. Null when it is not a picture. */
    fun squareJpeg(context: Context, uri: Uri): ByteArray? = runCatching {
        val source = ImageDecoder.createSource(context.contentResolver, uri)
        val bitmap = ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            val short = minOf(info.size.width, info.size.height)
            if (short > EDGE * 2) {
                val scale = EDGE * 2.0 / short
                decoder.setTargetSize((info.size.width * scale).toInt().coerceAtLeast(1), (info.size.height * scale).toInt().coerceAtLeast(1))
            }
        }
        val (left, top, side) = square(bitmap.width, bitmap.height)
        val cropped = Bitmap.createBitmap(bitmap, left, top, side, side)
        val scaled = Bitmap.createScaledBitmap(cropped, EDGE, EDGE, true)
        java.io.ByteArrayOutputStream().use { out ->
            scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
            out.toByteArray()
        }
    }.getOrNull()
}

/**
 * `ProfilePictureSettingsSection`: your own picture, read from your own
 * roster row (the answer every client draws you from). The Team poll's row
 * stands in until this page's own read lands.
 */
@Composable
internal fun ProfilePictureSection(account: OwnerAccount) {
    val context = LocalContext.current
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    val owner = remember(account) { account.session.credentials() } ?: return
    val teamVersion = LocalTeamStore.current?.me?.avatarUpdatedAt
    var version by remember { mutableStateOf<Long?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val media = remember(account) { TeamMedia(account) }
    val shown = if (loaded) version else version ?: teamVersion
    val uploading = stringResource(R.string.account_picture_uploading)
    val removing = stringResource(R.string.account_picture_removing)
    val unreadable = stringResource(R.string.account_picture_unreadable)

    LaunchedEffect(account) {
        try {
            val roster = account.client.call(TeamRoutes.peers)
            Faces.remember(roster.peers)
            version = roster.peers.firstOrNull { it.email.equals(owner.email, ignoreCase = true) }?.avatarUpdatedAt
            loaded = true
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // The Team roster stays the fallback while offline; initials are the safe answer without one.
        }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        busy = true
        status = uploading
        scope.launch {
            try {
                val jpeg = withContext(Dispatchers.Default) { ProfilePicture.squareJpeg(context, uri) }
                if (jpeg == null) {
                    status = unreadable
                    return@launch
                }
                val answer = media.upload(AccountRoutes.uploadAvatar, AvatarResponse.serializer(), jpeg, "image/jpeg")
                version = answer.avatarUpdatedAt
                loaded = true
                Faces.pictures.forget(owner.email, answer.avatarUpdatedAt)
                status = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                status = (e as? StarlingsApiError)?.sentence ?: AccountRoutes.uploadAvatar.operation
            } finally {
                busy = false
            }
        }
    }

    fun remove() {
        busy = true
        status = removing
        scope.launch {
            try {
                account.client.call(AccountRoutes.removeAvatar)
                version = null
                loaded = true
                Faces.pictures.forget(owner.email)
                status = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                status = (e as? StarlingsApiError)?.sentence ?: AccountRoutes.removeAvatar.operation
            } finally {
                busy = false
            }
        }
    }

    SectionWithFooter(stringResource(R.string.account_picture_footer)) {
        ListSection(stringResource(R.string.account_picture)) {
            ListRow {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    PersonFace(owner.email, owner.name, shown, diameter = 56.dp)
                    Spacer(Modifier.width(14.dp))
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(owner.name, style = StarlingsType.body.copy(fontWeight = FontWeight.Medium), color = c.primary)
                        Text(
                            status ?: stringResource(if (shown == null) R.string.account_picture_initials else R.string.account_picture_visible),
                            style = StarlingsType.caption, color = c.secondary,
                        )
                    }
                }
            }
            WorkDivider()
            WorkActionRow(
                stringResource(if (shown == null) R.string.account_picture_choose else R.string.account_picture_change),
                onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                enabled = !busy, accent = true,
            )
            if (shown != null) {
                WorkDivider()
                WorkActionRow(stringResource(R.string.account_picture_remove), onClick = ::remove, enabled = !busy, danger = true)
            }
        }
    }
}

/**
 * The connector a member gives Claude or any MCP client: the name the
 * server gives itself, the address, and the help page
 * (`StarlingsWorkspace.mcpServerName`, `mcpAddress`, `mcpConnectHelpURL`).
 */
object McpConnector {
    /** `ContractConstants.mcpServerNamePrefix`, `mcpPath`, `mcpConnectHelpPath` (fixtures/shared-constants.json). */
    const val SERVER_NAME_PREFIX = "Starlings · "
    const val PATH = "/mcp"
    const val HELP_PATH = "/help/howto/connect-claude"

    fun name(workspace: String = AppEnvironment.WORKSPACE_NAME): String = SERVER_NAME_PREFIX + workspace
    fun address(webOrigin: String = work.starlings.android.Workspaces.active.webOrigin): String = webOrigin.trimEnd('/') + PATH
    fun helpUrl(publicOrigin: String = work.starlings.android.Workspaces.active.webOrigin): String = publicOrigin.trimEnd('/') + HELP_PATH
}

/** `McpGrant` and `McpCallEntry` as Settings reads them (`Sources/McpGrants.swift`). */
object McpGrantLines {
    fun writes(grant: McpGrant): Boolean = McpScope.WRITE in grant.scopes
    fun paused(grant: McpGrant): Boolean = grant.pausedAt != null

    /** The trailing words of a call that did not go through: the outcome, then its detail. Null for one that did. */
    fun refusal(call: McpCallEntry): String? {
        if (call.outcome == McpCallOutcome.OK) return null
        val detail = call.detail?.takeIf { it.isNotEmpty() }
        return if (detail != null) "${call.outcome.value} · $detail" else call.outcome.value
    }
}

/**
 * `MobileConnectedClaudesSection` (docs/MCP.md §The record): your own
 * pairings, each with its scope and last call; open one for the tail of its
 * record, Pause or Resume and Revoke. Then the connector's name and address
 * with Copy, and the help page.
 */
@Composable
internal fun ConnectedAgentsSection(account: OwnerAccount) {
    val context = LocalContext.current
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var grants by remember { mutableStateOf<List<McpGrant>?>(null) }
    val calls = remember { mutableStateMapOf<String, List<McpCallEntry>>() }
    var open by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    fun failed(e: Exception, fallback: String) {
        error = (e as? StarlingsApiError)?.sentence ?: fallback
    }

    LaunchedEffect(account) {
        try {
            grants = account.client.call(AccountRoutes.mcpGrants).grants
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failed(e, AccountRoutes.mcpGrants.operation)
        }
    }

    fun toggle(id: String) {
        open = if (open == id) null else id
        if (open == id && calls[id] == null) {
            scope.launch {
                try {
                    calls[id] = account.client.call(AccountRoutes.mcpGrantCalls(id)).calls
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    failed(e, AccountRoutes.mcpGrantCalls(id).operation)
                }
            }
        }
    }

    fun write(route: work.starlings.android.api.Route<work.starlings.contracts.McpGrantsResponse>, closes: String? = null) {
        error = null
        scope.launch {
            try {
                grants = account.client.call(route).grants
                if (closes != null && open == closes) open = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failed(e, route.operation)
            }
        }
    }

    val paused = stringResource(R.string.account_agents_paused)
    ListSection(stringResource(R.string.account_agents)) {
        val list = grants
        when {
            list == null -> WorkPlaceholderRows()
            list.isEmpty() -> ListRow(divider = true) { Text(stringResource(R.string.account_agents_none), style = StarlingsType.body, color = c.secondary) }
        }
        list?.forEach { grant ->
            val expanded = open == grant.id
            val scopeText = stringResource(if (McpGrantLines.writes(grant)) R.string.account_agents_reads_writes else R.string.account_agents_reads)
            val now = System.currentTimeMillis()
            val base = grant.lastCallAt?.let { stringResource(R.string.account_agents_joined, scopeText, relative(it, now)) }
                ?: stringResource(R.string.account_agents_scope_no_calls, scopeText)
            val detail = if (McpGrantLines.paused(grant)) stringResource(R.string.account_agents_joined, paused, base) else base
            Row(
                Modifier.fillMaxWidth().clickable(role = Role.Button) { toggle(grant.id) }.padding(horizontal = 16.dp, vertical = 11.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(grant.clientName, style = StarlingsType.body, color = c.primary)
                    Text(detail, style = StarlingsType.footnote, color = c.secondary)
                }
                Icon(
                    if (expanded) Icons.Filled.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    null, Modifier.size(18.dp), tint = c.secondary,
                )
            }
            if (expanded) {
                val record = calls[grant.id]
                record?.forEach { call -> CallLine(call, now) }
                if (record?.isEmpty() == true) {
                    Text(stringResource(R.string.account_agents_no_calls), Modifier.padding(horizontal = 16.dp, vertical = 6.dp), style = StarlingsType.footnote, color = c.secondary)
                }
                if (McpGrantLines.paused(grant)) {
                    WorkActionRow(stringResource(R.string.account_agents_resume), onClick = { write(AccountRoutes.setMcpGrantPaused(grant.id, false)) }, accent = true)
                } else {
                    WorkActionRow(stringResource(R.string.account_agents_pause), onClick = { write(AccountRoutes.setMcpGrantPaused(grant.id, true)) }, accent = true)
                }
                WorkActionRow(stringResource(R.string.account_agents_revoke), onClick = { write(AccountRoutes.revokeMcpGrant(grant.id), closes = grant.id) }, danger = true)
            }
            WorkDivider()
        }
        CopyValueRow(stringResource(R.string.account_connector_name), McpConnector.name())
        WorkDivider()
        CopyValueRow(stringResource(R.string.account_connector_address), McpConnector.address())
        WorkDivider()
        WorkActionRow(stringResource(R.string.account_connect_claude), onClick = {
            runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(McpConnector.helpUrl())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }, accent = true)
        error?.let { WorkErrorNotice(it) }
    }
}

/** One call of the record: the tool in monospace, its arguments, then when, or why it did not go through. */
@Composable
private fun CallLine(call: McpCallEntry, now: Long) {
    val c = Starlings.colors
    val outcome = McpGrantLines.refusal(call) ?: relative(call.ts, now)
    val trailing = if (call.replayed == true) stringResource(R.string.account_agents_joined, outcome, stringResource(R.string.account_agents_replayed)) else outcome
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(call.name, style = StarlingsType.footnote.copy(fontFamily = FontFamily.Monospace), color = c.primary)
        Text(call.args.orEmpty(), Modifier.weight(1f), style = StarlingsType.footnote, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(trailing, style = StarlingsType.footnote, color = c.secondary)
    }
}

/** `CopyValueRow`: the label, the value in monospace, then Copy, which reads Copied for a moment. */
@Composable
private fun CopyValueRow(title: String, value: String) {
    val context = LocalContext.current
    val c = Starlings.colors
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) { delay(1_500); copied = false }
    }
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = StarlingsType.body, color = c.primary)
            Text(value, style = StarlingsType.footnote.copy(fontFamily = FontFamily.Monospace), color = c.secondary)
        }
        Spacer(Modifier.width(12.dp))
        Text(
            stringResource(if (copied) R.string.account_copied else R.string.account_copy),
            Modifier.clickable(enabled = !copied, role = Role.Button) {
                context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(title, value))
                copied = true
            }.padding(vertical = 6.dp),
            style = StarlingsType.body,
            color = if (copied) c.secondary else c.accent,
        )
    }
}

/** Clamped forward: clock skew must never read as "in 3 minutes". */
private fun relative(at: Long, now: Long): String =
    DateUtils.getRelativeTimeSpanString(minOf(at, now), now, DateUtils.MINUTE_IN_MILLIS).toString()
