package work.starlings.android.workspace

import work.starlings.android.widgets.LaunchAction
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import work.starlings.android.workspace.home.HomeLinks
import work.starlings.android.workspace.settings.LanguageLaunch
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import work.starlings.android.OwnerAccount
import work.starlings.android.StarlingsApp
import work.starlings.android.ui.Starlings
import work.starlings.android.workspace.search.LocalSearchOpener
import work.starlings.android.workspace.search.SearchSheet
import work.starlings.android.workspace.team.LocalTeamMedia
import work.starlings.android.workspace.team.LocalTeamStore
import work.starlings.android.workspace.team.TeamTabBadge
import work.starlings.android.workspace.team.rememberTeamStore

/**
 * The signed-in app: one tab per visible member surface, as the iOS
 * `TabView` over `app.tabs`. The selected tab survives rotation. A call
 * takes the whole screen above this (MainActivity), so leaving a call comes
 * back to the tab it left.
 */
@Composable
fun WorkspaceShell(
    account: OwnerAccount,
    onJoinRoom: (String?) -> Unit,
    onStartRoom: () -> Unit,
    incomingPath: String? = null,
    onPathTaken: () -> Unit = {},
) {
    // Calendar sources and Docs come from the workspace; unknown shows both, as iOS before its first answer.
    val tabs = SurfaceVisibility.visible(calendarSources = null, docs = true)
    var selected by rememberSaveable { mutableStateOf(MemberSurface.HOME) }
    val navigator = rememberNavigator { selected = it }
    // A web path from outside the tabs (a message notification's tap) goes to the tab that owns it.
    LaunchedEffect(incomingPath) {
        val path = incomingPath ?: return@LaunchedEffect
        onPathTaken()
        HomeLinks.surface(path)?.takeIf { it in tabs }?.let { navigator.open(it, path) }
    }
    // The Quick note tile lands on Home; the Quick Notes card opens its field (widgets/Controls.kt).
    val quickNote by LaunchAction.pendingQuickNote.collectAsStateWithLifecycle()
    LaunchedEffect(quickNote) { if (quickNote) navigator.open(MemberSurface.HOME) }
    var searchOpen by rememberSaveable { mutableStateOf(false) }
    val c = Starlings.colors
    // Team's roster, unread and message banners run at app level, not only while Team is on screen.
    val team = rememberTeamStore(account) { slug -> onJoinRoom(slug) }
    // The session's stars, one store for every tab (Favorites.kt).
    val favorites = rememberFavorites(account)
    // The owner's saved language, once per launch (workspace/settings/LanguageLaunch.kt).
    val context = LocalContext.current
    LaunchedEffect(account) { LanguageLaunch.apply(context.applicationContext, account) }
    CompositionLocalProvider(LocalWorkspaceNavigator provides navigator, LocalFavorites provides favorites, LocalTeamStore provides team, LocalTeamMedia provides team.media, LocalSearchOpener provides { searchOpen = true }) {
        Scaffold(
            containerColor = c.canvas,
            // The newer-version banner over the tabs, as the iOS workspace's top inset (#1237).
            topBar = { (context.applicationContext as? StarlingsApp)?.let { UpdateBanner(it.upgrade) } },
            bottomBar = {
                NavigationBar(containerColor = c.panel) {
                    tabs.forEach { tab ->
                        NavigationBarItem(
                            selected = tab == selected,
                            onClick = { navigator.open(tab) },
                            icon = { if (tab == MemberSurface.TEAM) TeamTabBadge(team) { Icon(tab.icon, null) } else Icon(tab.icon, null) },
                            label = { Text(stringResource(tab.titleResource)) },
                        )
                    }
                }
            },
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding)) {
                when (selected) {
                    MemberSurface.HOME -> HomeScreen(account, onJoinRoom, onStartRoom)
                    MemberSurface.CALENDAR -> CalendarScreen(account, onJoinRoom)
                    MemberSurface.WORK -> WorkScreen(account)
                    MemberSurface.TEAM -> TeamScreen(account, onJoinRoom)
                    MemberSurface.DOCS -> DocsScreen(account)
                }
                // Above the tab bar, not on it, as each iOS tab's `meetToastHost`.
                work.starlings.android.ui.StarlingsToastHost(work.starlings.android.ui.TOAST_DEPTH_SHELL)
            }
            if (searchOpen) SearchSheet(account, tabs, onStartRoom) { searchOpen = false }
        }
    }
}
