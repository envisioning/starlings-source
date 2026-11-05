package work.starlings.android.workspace.team

import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import work.starlings.android.OwnerAccount

/** The signed-in session's one [TeamStore], for any tab that shows Team's state (Home's messages, the badge). */
val LocalTeamStore = staticCompositionLocalOf<TeamStore?> { null }

/**
 * The app-level Team session, as iOS starts `MobileTeamStore` with the app:
 * the roster, the conversation list and the message banners poll while the
 * app is in front, whichever tab is on screen. Called once, from the shell.
 */
@Composable
fun rememberTeamStore(account: OwnerAccount, onJoinRoom: (String) -> Unit): TeamStore {
    val store = remember(account) { TeamStore(account).also { it.paintSnapshots() } }
    val context = LocalContext.current.applicationContext
    store.onJoinRoom = onJoinRoom
    store.onMessages = { notices -> MessageNotifier.deliver(context, notices) }
    store.onRing = { notice -> RingNotifier.deliver(context, notice) }
    store.onRingWithdrawn = { RingNotifier.withdraw(context) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(store) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { store.poll() }
    }
    return store
}

/** The Team tab's mark with its unread count, as the iOS tab badge. The count is read with the tab's label. */
@Composable
fun TeamTabBadge(store: TeamStore, icon: @Composable () -> Unit) {
    val count = store.unreadTeamCount
    if (count == 0) {
        icon()
        return
    }
    BadgedBox(badge = { Badge { Text(if (count > 99) "99+" else "$count") } }) { icon() }
}
