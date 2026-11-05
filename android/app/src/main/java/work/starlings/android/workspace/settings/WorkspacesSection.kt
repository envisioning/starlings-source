package work.starlings.android.workspace.settings

import work.starlings.android.ui.ToastTone
import work.starlings.android.ui.toast
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import work.starlings.android.AddWorkspaceFlow
import work.starlings.android.AddWorkspaceSheet
import work.starlings.android.R
import work.starlings.android.StarlingsApp
import work.starlings.android.StarlingsWorkspace
import work.starlings.android.WorkspaceMark
import work.starlings.android.pickOnDoor
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkActionRow
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkRowAction
import work.starlings.android.ui.WorkRowMenu

/**
 * Settings › Workspaces (`MobileWorkspacesSection`, slice G): every
 * workspace signed in to on this phone, the active one checked, and Add
 * workspace. A tap switches: the app rebuilds on that workspace; a
 * signed-out row signs in first. Any other row can be signed out of or
 * removed here, without switching to it. Off during a call.
 */
@Composable
fun WorkspacesSection() {
    val context = LocalContext.current
    val app = context.applicationContext as StarlingsApp
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    val known by app.workspaces.known.collectAsStateWithLifecycle()
    val current by app.workspaces.current.collectAsStateWithLifecycle()
    // Rows read the vault again after a Sign out or a Remove.
    var reads by remember { mutableIntStateOf(0) }
    var adding by rememberSaveable { mutableStateOf(false) }
    val inCall = app.isCallLive
    val signedOut = stringResource(R.string.workspaces_signed_out)
    val active = stringResource(R.string.workspaces_active)
    val remove = stringResource(R.string.workspaces_remove)
    val signOut = stringResource(R.string.workspaces_sign_out)
    Column {
        ListSection(stringResource(R.string.workspaces_title)) {
            known.forEach { workspace ->
                val isCurrent = workspace.webOrigin == current.webOrigin
                val email = remember(workspace, reads) { app.signedInEmail(workspace) }
                val actions = if (isCurrent) emptyList() else listOfNotNull(
                    WorkRowAction(remove, danger = true) { app.remove(workspace); reads++ },
                    if (email != null) WorkRowAction(signOut) { app.signOut(of = workspace); reads++ } else null,
                )
                WorkRowMenu(actions) { onLongClick ->
                    WorkspaceRow(
                        workspace, email, isCurrent, signedOut, active, enabled = !inCall,
                        onClick = {
                            if (isCurrent) return@WorkspaceRow
                            scope.launch {
                                pickOnDoor(app, workspace, context)?.let { failure ->
                                    toast(context.getString(AddWorkspaceFlow.message(failure)), ToastTone.DANGER)
                                }
                            }
                        },
                        onLongClick = onLongClick,
                    )
                }
                WorkDivider()
            }
            WorkActionRow(stringResource(R.string.workspaces_add), onClick = { adding = true }, enabled = !inCall, accent = true)
        }
        if (inCall) {
            Text(stringResource(R.string.workspaces_leave_call), Modifier.padding(horizontal = 16.dp, vertical = 6.dp), style = StarlingsType.footnote, color = c.secondary)
        }
    }
    if (adding) AddWorkspaceSheet(app, onDismiss = { adding = false })
}

/** `MobileWorkspaceRow`: the mark, the name, the address and who is signed in, or Signed out, dimmed. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun WorkspaceRow(
    workspace: StarlingsWorkspace,
    email: String?,
    isCurrent: Boolean,
    signedOut: String,
    active: String,
    enabled: Boolean,
    onClick: () -> Unit,
    onLongClick: (() -> Unit)?,
) {
    val c = Starlings.colors
    Row(
        Modifier
            .fillMaxWidth()
            .combinedClickable(enabled = enabled, role = Role.Button, onClick = onClick, onLongClick = onLongClick)
            .alpha(if (enabled) 1f else 0.5f)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WorkspaceMark(workspace, 28.dp, signedOut = email == null)
        Column(Modifier.weight(1f).alpha(if (email == null && !isCurrent) 0.6f else 1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(workspace.name, style = StarlingsType.body, color = c.primary, maxLines = 1)
            Text(workspace.rowDetail(email, signedOut), style = StarlingsType.caption, color = c.secondary, maxLines = 1)
        }
        if (isCurrent) Icon(Icons.Filled.Check, active, Modifier.size(18.dp), tint = c.accent)
    }
}
