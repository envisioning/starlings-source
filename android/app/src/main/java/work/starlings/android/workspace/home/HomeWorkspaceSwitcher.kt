package work.starlings.android.workspace.home

import work.starlings.android.ui.ToastTone
import work.starlings.android.ui.toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import work.starlings.android.AddWorkspaceFlow
import work.starlings.android.AddWorkspaceSheet
import work.starlings.android.R
import work.starlings.android.StarlingsApp
import work.starlings.android.WorkspaceMark
import work.starlings.android.pickOnDoor
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType

/**
 * `MobileWorkspaceSwitcher`: Home's header badge, the mark, the
 * workspace's name and who is signed in. A tap lists every workspace on this
 * phone, the active one checked and the others with their mark, then Add
 * workspace. A pick switches as Settings › Workspaces does; a signed-out
 * row signs in first. Off during a call.
 */
@Composable
fun HomeWorkspaceSwitcher(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val app = context.applicationContext as StarlingsApp
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    val known by app.workspaces.known.collectAsStateWithLifecycle()
    val current by app.workspaces.current.collectAsStateWithLifecycle()
    var open by remember { mutableStateOf(false) }
    var adding by rememberSaveable { mutableStateOf(false) }
    val inCall = app.isCallLive
    val address = remember(current) { app.signedInEmail(current) }
    val signedOut = stringResource(R.string.workspaces_signed_out)
    val active = stringResource(R.string.workspaces_active)
    // Every row's mark, read once (`loadMarks`).
    LaunchedEffect(known) { known.forEach(app.marks::load) }

    Box(modifier) {
        // `StarlingsWorkspaceBadge`: the mark, the name, the address under it; read as one.
        Row(
            Modifier
                .widthIn(max = 220.dp)
                .clickable(role = Role.Button) { open = true }
                .semantics(mergeDescendants = true) { }
                .padding(horizontal = 6.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            WorkspaceMark(current, 20.dp)
            Column {
                Text(
                    current.name, style = StarlingsType.footnote.copy(fontWeight = FontWeight.SemiBold, fontSize = 13.sp),
                    color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                address?.let {
                    Text(it, style = StarlingsType.caption2.copy(fontSize = 11.sp), color = c.secondary, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                }
            }
        }
        DropdownMenu(open, onDismissRequest = { open = false }) {
            known.forEach { workspace ->
                val isCurrent = workspace.webOrigin == current.webOrigin
                val email = remember(workspace, open) { app.signedInEmail(workspace) }
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(workspace.name, style = StarlingsType.body, color = c.primary, maxLines = 1)
                            Text(workspace.rowDetail(email, signedOut), style = StarlingsType.caption, color = c.secondary, maxLines = 1)
                        }
                    },
                    trailingIcon = {
                        if (isCurrent) Icon(Icons.Filled.Check, active, Modifier.size(18.dp), tint = c.primary)
                        else if (app.marks.mark(workspace) != null) WorkspaceMark(workspace, 20.dp)
                    },
                    enabled = !inCall,
                    onClick = {
                        open = false
                        if (isCurrent) return@DropdownMenuItem
                        scope.launch {
                            pickOnDoor(app, workspace, context)?.let { failure ->
                                toast(context.getString(AddWorkspaceFlow.message(failure)), ToastTone.DANGER)
                            }
                        }
                    },
                )
            }
            HorizontalDivider()
            DropdownMenuItem(
                text = { Text(stringResource(R.string.workspaces_add), style = StarlingsType.body, color = c.primary) },
                enabled = !inCall,
                onClick = { open = false; adding = true },
            )
        }
    }
    if (adding) AddWorkspaceSheet(app, onDismiss = { adding = false })
}
