package work.starlings.android.workspace

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * How one tab opens another: Home's Inbox opens Work, an Upcoming row opens
 * Calendar. A route is the web path of the destination (`/work`, `/calendar`,
 * then whatever that surface's own web path says), so a link copied from the
 * web and a tap inside the app name the same place. The target tab reads it
 * once with [rememberWorkspaceRoute] and clears it.
 */
class WorkspaceNavigator internal constructor(
    private val select: (MemberSurface) -> Unit,
) {
    private val pending = mutableMapOf<MemberSurface, String>()
    private var version by mutableStateOf(0)

    /** Selects [surface]; [route], when given, is handed to that tab. */
    fun open(surface: MemberSurface, route: String? = null) {
        if (route != null) pending[surface] = route else pending.remove(surface)
        version++
        select(surface)
    }

    internal fun take(surface: MemberSurface): String? = pending.remove(surface)

    internal val changes: Int get() = version
}

val LocalWorkspaceNavigator = staticCompositionLocalOf<WorkspaceNavigator?> { null }

/** The route this tab was opened with, delivered once to [onRoute]. */
@Composable
fun rememberWorkspaceRoute(surface: MemberSurface, onRoute: (String) -> Unit) {
    val navigator = LocalWorkspaceNavigator.current ?: return
    val changes = navigator.changes
    LaunchedEffect(changes) { navigator.take(surface)?.let(onRoute) }
}

@Composable
internal fun rememberNavigator(select: (MemberSurface) -> Unit): WorkspaceNavigator = remember { WorkspaceNavigator(select) }
