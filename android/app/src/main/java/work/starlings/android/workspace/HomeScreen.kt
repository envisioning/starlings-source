package work.starlings.android.workspace

import androidx.compose.ui.platform.LocalView
import work.starlings.android.ui.Haptic
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import work.starlings.android.ui.isRegularWidth
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import work.starlings.android.workspace.calendar.GoogleCalendarTarget
import work.starlings.android.workspace.calendar.rememberGoogleCalendarConnect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import androidx.compose.material3.Text
import androidx.compose.ui.text.style.TextAlign
import work.starlings.android.BuildConfig
import work.starlings.android.HomeLayout
import work.starlings.android.ui.StarlingsType
import work.starlings.android.OwnerAccount
import work.starlings.android.R
import work.starlings.android.Upcoming
import work.starlings.android.ui.HomeLoadingCard
import work.starlings.android.ui.NoticeRow
import work.starlings.android.ui.Starlings
import work.starlings.android.workspace.team.LocalTeamStore
import work.starlings.android.workspace.team.PeerStatus
import work.starlings.android.workspace.team.presence
import work.starlings.android.workspace.home.CommercialCard
import work.starlings.android.workspace.home.EventsCard
import work.starlings.android.workspace.home.FileQuickNoteSheet
import work.starlings.android.workspace.home.QuickNoteDrawer
import work.starlings.android.workspace.home.HomeFeed
import work.starlings.android.workspace.home.HomeHero
import work.starlings.android.workspace.home.HomeInbox
import work.starlings.android.workspace.home.HomeLinks
import work.starlings.android.workspace.home.HomeMine
import work.starlings.android.workspace.home.HomeModel
import work.starlings.android.workspace.home.HomeRecents
import work.starlings.android.workspace.home.InboxCard
import work.starlings.android.workspace.home.MineCard
import work.starlings.android.workspace.home.QuickAccessCard
import work.starlings.android.workspace.home.HomeSettingsSheet
import work.starlings.android.workspace.home.QuickNotesCard
import work.starlings.android.workspace.home.RoomCard
import work.starlings.android.workspace.home.UpcomingCard
import work.starlings.android.workspace.settings.SettingsButton
import work.starlings.android.workspace.settings.SettingsRequest
import work.starlings.android.workspace.home.HomeSetup
import work.starlings.android.workspace.home.SetupCard
import work.starlings.android.workspace.home.SetupChecklist
import work.starlings.android.workspace.search.LocalSearchOpener

/**
 * The Home tab: `MobileHomeView.ownerHome` (iOS/MobileHomeView.swift). The
 * clock, then the person's modules in the person's order (`HomeLayout`,
 * fixtures/home-layout.json, the list the Mac and the browser read). Until a
 * module's first answer it draws a loading shell; once every visible module
 * has answered, or ten seconds have passed, a module with nothing to show
 * draws nothing.
 *
 * INBOX, MINE, COMMERCIAL and QUICK ACCESS hand over to the other tabs
 * through the workspace navigator, by web path ([HomeLinks]). QUICK ACCESS
 * spans the width below the other modules, as on iOS.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(account: OwnerAccount, onJoinRoom: (String?) -> Unit, onStartRoom: () -> Unit) {
    val context = LocalContext.current
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    val view = LocalView.current
    val favorites = LocalFavorites.current
    val model = remember(account, favorites) { HomeModel(account, favorites).also { it.paintSnapshots() } }
    var settled by remember { mutableStateOf(false) }
    // The setup checklist (not a module) and the Settings page a step asks for.
    val setup = remember(account) { HomeSetup(account, work.starlings.android.Workspaces.active.webOrigin) }
    val settingsRequest = remember { SettingsRequest() }
    var settingsOpen by rememberSaveable { mutableStateOf(false) }
    // The Quick Note in the drawer, and the one being filed: a sheet cannot open a sheet of its own.
    var editingNote by rememberSaveable { mutableStateOf<String?>(null) }
    var filingNote by rememberSaveable { mutableStateOf<String?>(null) }
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val ownerEmail = remember(account) { account.session.credentials()?.email.orEmpty() }
    // Upcoming's Connect Google Calendar (iOS `connectCalendar`): the failure is said under the button.
    var connectError by remember { mutableStateOf<String?>(null) }
    val calendarConnect = rememberGoogleCalendarConnect(
        account,
        onFailure = { connectError = it },
        onConnected = { model.read(context, force = true) },
    )

    // The plan follows the clock: a meeting that starts or ends while Home is open moves without a read.
    LaunchedEffect(Unit) {
        while (true) {
            delay(15_000)
            nowMs = System.currentTimeMillis()
        }
    }

    val navigator = LocalWorkspaceNavigator.current
    // Unread talk comes from the app-level Team session, the poll the tab badge reads: Home asks nothing twice.
    val team = LocalTeamStore.current
    val openPath: (String) -> Unit = { path -> HomeLinks.surface(path)?.let { navigator?.open(it, path) } }

    val visible = HomeLayout.visible(model.layout, model.workModules).filter { it in DRAWN }
    fun answered(id: String): Boolean = model.layoutReady && when (id) {
        "messages" -> model.messagesReady(team?.homeMessagesReady == true)
        "work" -> model.workReady
        "commercial" -> model.commercialReady
        "agenda" -> model.upcomingReady
        "notes" -> model.notesReady
        "events" -> model.eventsReady
        "room" -> model.roomReady
        "recent" -> true
        else -> false
    }

    val unread = team?.threads?.unread.orEmpty()
    val inboxRows = HomeInbox.rows(unread, model.inbox)
    val mine = remember(model.mineTasks, model.mineIssues, nowMs / 60_000) { HomeMine.plan(model.mineTasks, model.mineIssues, nowMs) }
    val recentsVersion = HomeRecents.changes.intValue
    val recents = remember(ownerEmail, recentsVersion) { HomeRecents.homeRows(context, ownerEmail) }
    val quickRows = HomeLayout.mergeRecent(recents, model.starred) { it.key }
    val starredKeys = model.starred.map { it.key }.toSet()
    fun hasContent(id: String): Boolean = when (id) {
        "messages" -> inboxRows.isNotEmpty()
        "work" -> !mine.isEmpty
        "commercial" -> model.commercial != null
        "events" -> model.events.isNotEmpty()
        "recent" -> quickRows.isNotEmpty()
        else -> false
    }

    LaunchedEffect(account) {
        val reads = launch { model.read(context) }
        launch { setup.load(context) }
        val deadline = System.currentTimeMillis() + 10_000
        while (!settled && System.currentTimeMillis() < deadline && !HomeLayout.visible(model.layout, model.workModules).filter { it in DRAWN }.all(::answered)) {
            delay(50)
        }
        settled = true
        reads.join()
    }

    val plan = Upcoming.classify(model.raw.map(HomeFeed::upcoming), nowMs, preferences = model.preferences)
    val ownSlug = model.room?.slug

    // Two columns on a regular width (`MobileHomeView.twoColumns`, ui/SizeClass.kt).
    val twoColumns = isRegularWidth()
    val density = LocalDensity.current
    // `drawnModules`: every visible module while loading (each a shell), only those with content once settled.
    val drawnModules = visible.filter { id -> if (answered(id)) HomeLayout.draws(id, hasContent(id)) else !settled }
    val columnModules = drawnModules.filter { it != "recent" }
    // Each module's drawn height in dp, and which sit in the right column: null is the alternating first placement.
    val heights = remember { mutableStateMapOf<String, Double>() }
    var columnAssignment by remember { mutableStateOf<Map<String, Boolean>?>(null) }
    fun isRight(id: String): Boolean = columnAssignment?.let { it[id] ?: false } ?: (columnModules.indexOf(id) % 2 == 1)
    // Decided once per layout or column mode from measured heights, then held: a late answer moves no card
    // under the reader's finger unless it leaves the columns lopsided (`balanceColumns`, `repackIfLopsided`).
    LaunchedEffect(twoColumns, visible) { columnAssignment = null }
    LaunchedEffect(twoColumns, settled, columnAssignment == null) {
        if (!twoColumns || !settled || columnAssignment != null) return@LaunchedEffect
        delay(120)
        if (heights.values.none { it > 0 }) return@LaunchedEffect
        columnAssignment = HomeLayout.packColumns(columnModules, heights.toMap(), PACK_GAP)
    }
    LaunchedEffect(twoColumns, settled) {
        if (!twoColumns || !settled) return@LaunchedEffect
        snapshotFlow { heights.toMap() }.collect { measured ->
            val held = columnAssignment ?: return@collect
            if (HomeLayout.columnsLopsided(columnModules, measured, held, PACK_GAP)) {
                columnAssignment = HomeLayout.packColumns(columnModules, measured, PACK_GAP)
            }
        }
    }

    PullToRefreshBox(
        isRefreshing = model.refreshing,
        onRefresh = {
            scope.launch {
                launch { team?.refreshThreads() }
                launch { setup.load(context) }
                model.read(context, force = true)
            }
        },
        modifier = Modifier.fillMaxSize(),
    ) {
        // The grid is decoration: no hit testing, hidden from TalkBack, gone when Grid texture is off.
        work.starlings.android.ui.HomeGridBackground(Modifier.fillMaxSize())
        // A regular width: the hero spans the screen and the modules pack side by side, as iPad.
        val outer = if (twoColumns) Modifier.fillMaxWidth() else Modifier.widthIn(max = 760.dp).fillMaxWidth()
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(SIDE_MARGIN),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(outer, verticalArrangement = Arrangement.spacedBy(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                // The header, as iOS Home's toolbar: which workspace this is and who is
                // signed in (`MobileWorkspaceSwitcher`), then the buttons.
                Box(Modifier.fillMaxWidth().heightIn(min = 32.dp)) {
                    work.starlings.android.workspace.home.HomeWorkspaceSwitcher(Modifier.align(Alignment.CenterStart).padding(end = 108.dp))
                    val label = stringResource(R.string.home_settings)
                    // Settings, left of Home's own gear; Settings › Home opens Home's sheet.
                    SettingsButton(account, openHomeSettings = { settingsOpen = true }, modifier = Modifier.align(Alignment.TopEnd).padding(end = 36.dp), request = settingsRequest)
                    Box(
                        Modifier
                            .align(Alignment.TopEnd)
                            .size(32.dp)
                            .clickable(role = Role.Button) { settingsOpen = true }
                            .clearAndSetSemantics { contentDescription = label; role = Role.Button; onClick { settingsOpen = true; true } },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Outlined.Settings, null, Modifier.size(20.dp), tint = c.secondary)
                    }
                    // Search on the phone (iOS Home's magnifier), left of Settings: gear, Settings, Search, 36 dp apart.
                    LocalSearchOpener.current?.let { openSearch ->
                        val searchLabel = stringResource(R.string.search_open)
                        Box(
                            Modifier
                                .align(Alignment.TopEnd)
                                .padding(end = 72.dp)
                                .size(32.dp)
                                .clickable(role = Role.Button) { openSearch() }
                                .clearAndSetSemantics { contentDescription = searchLabel; role = Role.Button; onClick { openSearch(); true } },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(Icons.Outlined.Search, null, Modifier.size(20.dp), tint = c.secondary)
                        }
                    }
                }
                TickingHero()

                model.alert?.let { NoticeRow(it, dismiss = stringResource(R.string.home_dismiss), onDismiss = { model.alert = null }) }

                // The setup checklist: not a module, so not in the person's order; it draws above them
                // until its steps are done, hidden or turned off (docs/ONBOARDING.md).
                if (setup.draws) {
                    Box(Modifier.widthIn(max = COLUMN_WIDTH * 2 + COLUMN_GAP).fillMaxWidth()) {
                        SetupCard(
                            card = setup.card(),
                            canTurnOff = setup.setup?.canTurnOff ?: false,
                            error = setup.error,
                            open = { step ->
                                when (val door = SetupChecklist.destination(step, work.starlings.android.Workspaces.active.webOrigin)) {
                                    is SetupChecklist.Destination.Settings -> settingsRequest.open(door.page)
                                    SetupChecklist.Destination.Work -> openPath(HomeLinks.WORK)
                                    SetupChecklist.Destination.Room -> if (model.room != null) onStartRoom()
                                    is SetupChecklist.Destination.Web -> open(context, door.url)
                                }
                            },
                            skip = { step -> scope.launch { setup.skip(context, step) } },
                            hide = { setup.hide() },
                            turnOff = { scope.launch { setup.turnOff(context) } },
                            retry = { scope.launch { setup.load(context) } },
                        )
                    }
                }

                // One module: its loading shell until it answers, then its card, measured for the columns.
                val moduleView: @Composable (String) -> Unit = { id ->
                    Box(Modifier.fillMaxWidth().onSizeChanged { size -> heights[id] = with(density) { size.height.toDp().value.toDouble() } }) {
                        if (!answered(id)) {
                            LoadingShell(id)
                        } else {
                            when (id) {
                                "messages" -> InboxCard(
                                    unread, model.inbox, nowMs, openPath,
                                    answeringKey = model.answeringKey,
                                    agenda = model.raw,
                                    respond = { item, reply -> scope.launch { model.respond(item, reply) } },
                                    answerForwarded = { item, add -> scope.launch { model.answerForwarded(item, add) } },
                                )
                                "work" -> MineCard(mine, openPath)
                                "commercial" -> model.commercial?.let { CommercialCard(it, openPath) }
                                "recent" -> QuickAccessCard(quickRows, starredKeys) { row -> HomeLinks.door(row.door, ownSlug)?.let(openPath) }
                                "agenda" -> UpcomingCard(
                                    plan, model.raw, nowMs, ownSlug,
                                    unavailable = model.calendarUnavailable,
                                    notConnected = model.calendarNotConnected,
                                    connecting = calendarConnect.busy != null,
                                    connectError = connectError,
                                    onConnect = { connectError = null; calendarConnect.start(GoogleCalendarTarget.OWN) },
                                    onJoin = { target -> join(context, target, onJoinRoom) },
                                    onDemote = { event, demoted -> scope.launch { model.setDemoted(context, event, demoted) } },
                                    onOpen = { event -> openPath(HomeLinks.calendarEvent(event.id, event.start)) },
                                )
                                "notes" -> QuickNotesCard(
                                    model.notes, model.noteSaving, model.noteError, nowMs,
                                    create = { model.createNote(it) },
                                    delete = { note -> scope.launch { if (model.deleteNote(note)) Haptic.DESTRUCTIVE.play(view) } },
                                    edit = { note -> editingNote = note.id },
                                    fileNote = { note -> filingNote = note.id },
                                )
                                "events" -> EventsCard(model.events, nowMs) { url -> open(context, url) }
                                "room" -> RoomCard(model.room, model.roomLoading, model.roomUnmapped, ownerEmail, onStartRoom, open = team?.me?.presence == PeerStatus.IN_MEETING)
                            }
                        }
                    }
                }

                if (twoColumns) {
                    // `moduleColumn`: the person's order inside each column, the columns close in height.
                    Row(Modifier.widthIn(max = COLUMN_WIDTH * 2 + COLUMN_GAP).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(COLUMN_GAP)) {
                        listOf(false, true).forEach { right ->
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                                columnModules.filter { isRight(it) == right }.forEach { moduleView(it) }
                            }
                        }
                    }
                } else {
                    columnModules.forEach { moduleView(it) }
                }
                // Quick Access spans the width below the others, whatever its place in the order.
                if ("recent" in drawnModules) {
                    Box(Modifier.widthIn(max = COLUMN_WIDTH * 2 + COLUMN_GAP).fillMaxWidth()) { moduleView("recent") }
                }

                // The line the Mac prints under its launch surface: "which build am I on" without opening Settings.
                Text(
                    stringResource(R.string.home_version, BuildConfig.VERSION_NAME.substringBefore('-'), BuildConfig.VERSION_CODE.toString()),
                    Modifier.fillMaxWidth().padding(top = 4.dp),
                    style = StarlingsType.footnote.copy(textAlign = TextAlign.Center),
                    color = c.secondary,
                )
            }
        }
    }

    model.notes.firstOrNull { it.id == editingNote }?.let { note ->
        QuickNoteDrawer(
            note, model.noteSaving, model.noteError,
            save = { body -> model.updateNote(note, body) },
            file = { filingNote = note.id },
            delete = { scope.launch { if (model.deleteNote(note)) Haptic.DESTRUCTIVE.play(view) } },
            dismiss = { editingNote = null },
        )
    }
    model.notes.firstOrNull { it.id == filingNote && editingNote == null }?.let { note ->
        FileQuickNoteSheet(
            note,
            load = { model.loadFilingOptions() },
            file = { kind, subject, thread, title -> model.file(note, kind, subject, thread, title) },
            dismiss = { filingNote = null },
        )
    }

    if (settingsOpen) {
        HomeSettingsSheet(
            layout = model.layout,
            workModules = model.workModules,
            saving = model.layoutSaving,
            error = model.layoutError,
            followingRows = model.preferences.homeFollowingRows,
            followingLoaded = model.preferencesLoaded,
            save = { next -> scope.launch { model.saveLayout(next) } },
            setFollowingRows = { count -> scope.launch { model.setFollowingRows(count) } },
            dismiss = { settingsOpen = false },
        )
    }
}

/** The Mac's `OwnerLaunchView` numbers, as `MobileHomeView`: a column is never wider than 420. */
private val COLUMN_WIDTH = 420.dp
private val COLUMN_GAP = 16.dp
private val SIDE_MARGIN = 20.dp
/** The gap `HomeLayout.packColumns` counts between modules, as iOS passes it. */
private const val PACK_GAP = 20.0

/** The modules this screen draws: every module of the registry. */
private val DRAWN = setOf("messages", "work", "commercial", "agenda", "notes", "events", "room", "recent")

/** The clock ticks on its own, so the second hand does not recompose the cards. */
@Composable
private fun TickingHero() {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1_000 - System.currentTimeMillis() % 1_000)
            now = System.currentTimeMillis()
        }
    }
    HomeHero(now)
}

/** `MobileHomeLoadingCard`'s rows and heights per module. */
@Composable
private fun LoadingShell(id: String) {
    when (id) {
        "notes" -> HomeLoadingCard(5, 60.dp)
        "agenda" -> HomeLoadingCard(4, 60.dp)
        "events" -> HomeLoadingCard(HomeLayout.definition("events").rows ?: 3, 60.dp)
        "room" -> HomeLoadingCard(3, 60.dp)
        "messages" -> HomeLoadingCard(HomeLayout.definition("messages").rows ?: 3, 54.dp)
        "work" -> HomeLoadingCard(HomeLayout.definition("work").rows ?: 5, 54.dp)
        "commercial" -> HomeLoadingCard(5, 54.dp)
        "recent" -> HomeLoadingCard(1, 54.dp)
    }
}

/**
 * `MobileHomeView.join`: never the browser for a Starlings room. Another
 * member's room is the knock, through the join flow; any other link goes to
 * the app that owns it.
 */
private fun join(context: Context, target: HomeFeed.JoinTarget, onJoinRoom: (String?) -> Unit) {
    when (target) {
        is HomeFeed.JoinTarget.Room -> onJoinRoom(target.link)
        is HomeFeed.JoinTarget.External -> open(context, target.url)
        // Hosting: not drawn, so never reached.
        HomeFeed.JoinTarget.OwnRoom -> Unit
    }
}

private fun open(context: Context, url: String) {
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: ActivityNotFoundException) {
        // No app answers the link; nothing to open.
    }
}
