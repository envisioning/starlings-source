package work.starlings.android.workspace

import work.starlings.android.ui.Haptic
import work.starlings.android.ui.HapticWhenSet
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CalendarViewDay
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.PostAdd
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.VideoCall
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.Today
import androidx.compose.material.icons.filled.ViewDay
import androidx.compose.material.icons.filled.ViewList
import androidx.compose.material.icons.filled.ViewModule
import androidx.compose.material.icons.filled.ViewWeek
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import work.starlings.android.CalEvent
import work.starlings.android.CalGroup
import work.starlings.android.CalendarLayout
import work.starlings.android.CalendarPacking
import work.starlings.android.OwnerAccount
import work.starlings.android.R
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.workspace.calendar.CalendarAgendaList
import work.starlings.android.workspace.calendar.CalendarChrome
import work.starlings.android.workspace.calendar.CalendarEditor
import work.starlings.android.workspace.calendar.CalendarEventDetail
import work.starlings.android.workspace.calendar.CalendarLayerDetail
import work.starlings.android.workspace.calendar.CalendarLayerItem
import work.starlings.android.workspace.calendar.CalendarMonthGrid
import work.starlings.android.workspace.calendar.CalendarPager
import work.starlings.android.workspace.calendar.CalendarQuickAddView
import work.starlings.android.workspace.calendar.CalendarScheduleComposer
import work.starlings.android.workspace.calendar.CalendarSourcesSheet
import work.starlings.android.workspace.calendar.rememberDeviceCalendarAccess
import work.starlings.android.workspace.calendar.CalendarRoute
import work.starlings.android.workspace.calendar.CalendarStore
import work.starlings.android.workspace.calendar.CalendarTimeGrid
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import kotlin.math.abs

/** What is presented over the grid: one at a time, so a slot tap and an event tap cannot both win. */
private sealed interface CalendarSheet {
    data class Create(val start: Long, val end: Long) : CalendarSheet
    data class Detail(val group: CalGroup) : CalendarSheet
    data class Edit(val event: CalEvent) : CalendarSheet
    data class Layer(val item: CalendarLayerItem) : CalendarSheet
    /** One sentence that opens New Event filled in. */
    data object QuickAdd : CalendarSheet
    /** The meeting composer, which schedules against the owner's room. */
    data object Schedule : CalendarSheet
    /** Which calendars Starlings reads and shows, the layers, and the default calendar. */
    data object Sources : CalendarSheet
}

/**
 * The Calendar tab: `iOS/MobileCalendarScreen.swift`. Day, 2 Days, 3 Days,
 * Month and List over the owner's Google calendars and subscribed feeds.
 * The period's title rides in the bar; a sideways swipe pages; the View
 * menu changes the layout and goes to today. An event opens its sheet, a
 * Starlings room joins through [onJoinRoom].
 */
@Composable
fun CalendarScreen(account: OwnerAccount, onJoinRoom: (String?) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val store = remember(account) { CalendarStore(context.applicationContext, account, scope) }
    val c = Starlings.colors
    var sheet by remember { mutableStateOf<CalendarSheet?>(null) }
    val navigator = LocalWorkspaceNavigator.current

    LaunchedEffect(store) { store.reload() }
    // The phone's own calendars: the READ_CALENDAR prompt and the change watch.
    rememberDeviceCalendarAccess(store)
    // Home, Work and Search open an event by its web path (`/calendar/event/<id>?day=`).
    rememberWorkspaceRoute(MemberSurface.CALENDAR) { path ->
        val route = CalendarRoute.parse(path) ?: return@rememberWorkspaceRoute
        scope.launch { store.reveal(route)?.let { sheet = CalendarSheet.Detail(it) } }
    }

    Column(Modifier.fillMaxSize().background(c.canvas)) {
        CalendarBar(
            store,
            onNewEvent = { sheet = newEventSheet(store) },
            onQuickAdd = { sheet = CalendarSheet.QuickAdd },
            onSchedule = { sheet = CalendarSheet.Schedule },
            onSources = { sheet = CalendarSheet.Sources },
        )
        if (store.isLoading) LinearProgressIndicator(Modifier.fillMaxWidth(), color = c.accent, trackColor = c.panel)
        // `connectBanner`: a tap opens the sources, where Connect Google Calendar is.
        if (store.googleConnected == false) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable(role = Role.Button) { sheet = CalendarSheet.Sources }
                    .background(c.panel)
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.ErrorOutline, null, Modifier.size(16.dp), tint = c.secondary)
                Text(stringResource(R.string.cal_google_not_connected), Modifier.weight(1f), style = StarlingsType.caption, color = c.secondary)
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(14.dp), tint = c.secondary)
            }
        }
        store.loadFailure?.let { RefreshBanner(it) { store.reload(force = true) } }

        val previous = stringResource(R.string.cal_previous)
        val next = stringResource(R.string.cal_next)
        // The day grids page by a column inside the grid; Month and List page whole periods in the pager.
        Box(
            Modifier
                .fillMaxSize()
                .semantics {
                    customActions = listOf(
                        CustomAccessibilityAction(previous) { store.step(-1); true },
                        CustomAccessibilityAction(next) { store.step(1); true },
                    )
                },
        ) {
            val open: (CalGroup) -> Unit = { sheet = CalendarSheet.Detail(it) }
            val openLayer: (CalendarLayerItem) -> Unit = { sheet = CalendarSheet.Layer(it) }
            when (store.layout) {
                CalendarLayout.DAY, CalendarLayout.TWO_DAY, CalendarLayout.THREE_DAY -> CalendarTimeGrid(
                    store,
                    onSelect = open,
                    onSelectLayer = openLayer,
                    onCreate = if (store.writableCalendars.isEmpty()) null else { start ->
                        sheet = CalendarSheet.Create(start, start + store.display.durationMinutes * 60_000L)
                    },
                )
                CalendarLayout.MONTH -> CalendarPager(onSettle = { store.step(it) }) { offset ->
                    CalendarMonthGrid(store, store.days(offset), onSelect = open, onSelectLayer = openLayer, anchor = store.anchor(offset))
                }
                CalendarLayout.AGENDA -> CalendarPager(onSettle = { store.step(it) }) { offset ->
                    CalendarAgendaList(store, store.days(offset), onSelect = open, onSelectLayer = openLayer)
                }
            }
        }
    }

    sheet?.let { current ->
        Dialog(
            onDismissRequest = { sheet = null },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Box(Modifier.fillMaxSize().background(c.canvas).padding(top = 8.dp)) {
                when (current) {
                    is CalendarSheet.Detail -> CalendarEventDetail(
                        store,
                        current.group,
                        onDone = { sheet = null },
                        // The editor is a push from the detail: closing it comes back here.
                        onEdit = { sheet = CalendarSheet.Edit(it) },
                        onJoinRoom = { room -> sheet = null; onJoinRoom(room) },
                        // The sheet goes first; Work takes the tab after.
                        onOpenWork = { path -> sheet = null; navigator?.open(MemberSurface.WORK, path) },
                    )
                    is CalendarSheet.Layer -> CalendarLayerDetail(
                        current.item,
                        store.zone,
                        onDone = { sheet = null },
                        // The sheet goes first; Work takes the tab after.
                        onOpenWork = { path -> sheet = null; navigator?.open(MemberSurface.WORK, path) },
                    )
                    CalendarSheet.Sources -> CalendarSourcesSheet(store, onDone = { sheet = null })
                    CalendarSheet.Schedule -> CalendarScheduleComposer(store, onClose = { sheet = null })
                    CalendarSheet.QuickAdd -> CalendarQuickAddView(store, onClose = { sheet = null }, onSaved = { sheet = null })
                    is CalendarSheet.Create -> CalendarEditor(store, null, current.start, current.end, onClose = { sheet = null }, onSaved = { sheet = null })
                    is CalendarSheet.Edit -> {
                        val back = store.groupsOn(work.starlings.android.CalendarDates.day(current.event.start, store.zone))
                            .firstOrNull { it.id == current.event.id }
                        BackHandler { sheet = back?.let { CalendarSheet.Detail(it) } }
                        CalendarEditor(
                            store, current.event, null, null,
                            onClose = { sheet = back?.let { CalendarSheet.Detail(it) } },
                            onSaved = { sheet = null },
                        )
                    }
                }
                store.errorMessage?.let { ErrorAlert(it) { store.errorMessage = null } }
            }
        }
    }
    // One error alert shows at a time, over the sheet or the screen (`CalendarErrorAlert`): it buzzes once.
    HapticWhenSet(Haptic.ERROR, store.errorMessage)
    if (sheet == null) store.errorMessage?.let { ErrorAlert(it) { store.errorMessage = null } }
}

@Composable
private fun CalendarBar(store: CalendarStore, onNewEvent: () -> Unit, onQuickAdd: () -> Unit, onSchedule: () -> Unit, onSources: () -> Unit) {
    val c = Starlings.colors
    var viewMenu by remember { mutableStateOf(false) }
    var addMenu by remember { mutableStateOf(false) }
    val title = periodTitle(store)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            BarButton(Icons.Filled.MoreHoriz, stringResource(R.string.cal_view)) { viewMenu = true }
            DropdownMenu(viewMenu, onDismissRequest = { viewMenu = false }) {
                CalendarLayout.entries.forEach { layout ->
                    DropdownMenuItem(
                        text = { Text(stringResource(layoutLabel(layout))) },
                        leadingIcon = { Icon(layoutIcon(layout), null) },
                        trailingIcon = { if (layout == store.layout) Icon(Icons.Filled.Check, null) },
                        onClick = { viewMenu = false; store.choose(layout) },
                    )
                }
                HorizontalDivider(color = c.border)
                // Reselecting the tab is Today on iOS; the shell's tab bar is not this screen's, so it is here.
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.cal_today)) },
                    leadingIcon = { Icon(Icons.Filled.Today, null) },
                    onClick = { viewMenu = false; store.goToToday() },
                )
                // Settings holds these on iOS; Android's Settings has no Calendar page, so the View menu does.
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.cal_calendars)) },
                    leadingIcon = { Icon(Icons.Filled.Tune, null) },
                    onClick = { viewMenu = false; onSources() },
                )
            }
        }
        Text(
            title,
            Modifier.weight(1f).semantics { heading() },
            style = StarlingsType.headline.copy(textAlign = androidx.compose.ui.text.style.TextAlign.Center),
            color = c.primary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Box {
            BarButton(Icons.Filled.Add, stringResource(R.string.cal_add)) { addMenu = true }
            DropdownMenu(addMenu, onDismissRequest = { addMenu = false }) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.cal_new_event_menu)) },
                    leadingIcon = { Icon(Icons.Filled.CalendarViewDay, null) },
                    enabled = store.writableCalendars.isNotEmpty(),
                    onClick = { addMenu = false; onNewEvent() },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.cal_quick_add_menu)) },
                    leadingIcon = { Icon(Icons.Filled.PostAdd, null) },
                    enabled = store.writableCalendars.isNotEmpty(),
                    onClick = { addMenu = false; onQuickAdd() },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.cal_schedule_menu)) },
                    leadingIcon = { Icon(Icons.Filled.VideoCall, null) },
                    enabled = store.room != null,
                    onClick = { addMenu = false; onSchedule() },
                )
            }
        }
    }
}

@Composable
private fun BarButton(icon: ImageVector, label: String, onClick: () -> Unit) {
    val c = Starlings.colors
    Box(
        Modifier
            .size(42.dp)
            .background(c.elevated, androidx.compose.foundation.shape.CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = label; role = Role.Button },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, Modifier.size(20.dp), tint = c.primary)
    }
}

/** `StarlingsInlineRetry`: the refresh that did not land, and tapping it tries again. */
@Composable
private fun RefreshBanner(message: String, onRetry: () -> Unit) {
    val c = Starlings.colors
    val spoken = stringResource(R.string.cal_retry_label, message)
    Row(
        Modifier
            .fillMaxWidth()
            .background(c.panel)
            .clickable(role = Role.Button, onClick = onRetry)
            .clearAndSetSemantics { contentDescription = spoken; role = Role.Button }
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.Sync, null, Modifier.size(16.dp), tint = c.danger)
        Text(message, Modifier.weight(1f), style = StarlingsType.caption, color = c.danger)
        Text(stringResource(R.string.cal_try_again), style = StarlingsType.caption.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Medium), color = c.danger)
    }
}

/** The Calendar alert: the failure's sentence, Copy and OK. */
@Composable
private fun ErrorAlert(message: String, onDismiss: () -> Unit) {
    val c = Starlings.colors
    val context = LocalContext.current
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.cal_calendar)) },
        text = { Text(message) },
        confirmButton = { TextButton(onDismiss) { Text(stringResource(R.string.cal_ok), color = c.primary) } },
        dismissButton = {
            TextButton({
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText(message, message))
                onDismiss()
            }) { Text(stringResource(R.string.cal_copy), color = c.primary) }
        },
        containerColor = c.elevated,
        titleContentColor = c.primary,
        textContentColor = c.secondary,
    )
}

/** `MobileCalendarStore.periodTitle`. */
@Composable
private fun periodTitle(store: CalendarStore): String {
    val days = store.days
    val first = days.first()
    val last = days.last()
    return when (store.layout) {
        CalendarLayout.DAY -> CalendarChrome.date(store.anchor, "EEEEMMMMd")
        CalendarLayout.TWO_DAY, CalendarLayout.THREE_DAY -> when {
            first.month == last.month && first.year == last.year -> CalendarChrome.date(first, "MMMMyyyy")
            first.year == last.year -> "${CalendarChrome.date(first, "MMM")} – ${CalendarChrome.date(last, "MMMyyyy")}"
            else -> "${CalendarChrome.date(first, "MMMyyyy")} – ${CalendarChrome.date(last, "MMMyyyy")}"
        }
        CalendarLayout.AGENDA -> {
            val sameMonth = first.month == last.month && first.year == last.year
            "${CalendarChrome.date(first, "MMMd")} – ${if (sameMonth) CalendarChrome.date(last, "d") else CalendarChrome.date(last, "MMMd")}"
        }
        CalendarLayout.MONTH -> CalendarChrome.date(store.anchor, "MMMMyyyy")
    }
}

internal fun layoutLabel(layout: CalendarLayout): Int = when (layout) {
    CalendarLayout.DAY -> R.string.cal_layout_day
    CalendarLayout.TWO_DAY -> R.string.cal_layout_two_days
    CalendarLayout.THREE_DAY -> R.string.cal_layout_three_days
    CalendarLayout.MONTH -> R.string.cal_layout_month
    CalendarLayout.AGENDA -> R.string.cal_layout_list
}

private fun layoutIcon(layout: CalendarLayout): ImageVector = when (layout) {
    CalendarLayout.DAY -> Icons.Filled.ViewDay
    CalendarLayout.TWO_DAY, CalendarLayout.THREE_DAY -> Icons.Filled.ViewWeek
    CalendarLayout.MONTH -> Icons.Filled.ViewModule
    CalendarLayout.AGENDA -> Icons.Filled.ViewList
}

/** A new event from the bar lands on the day being read: the next half hour today, else the day's start hour. */
private fun newEventSheet(store: CalendarStore): CalendarSheet.Create {
    val zone = store.zone
    val start = if (store.anchor == LocalDate.now()) {
        CalendarPacking.snapUp(System.currentTimeMillis() + 1_800_000L, store.display.snapMinutes)
    } else {
        LocalDateTime.of(store.anchor, LocalTime.of(store.display.dayStartHour, 0)).atZone(zone).toInstant().toEpochMilli()
    }
    return CalendarSheet.Create(start, start + store.display.durationMinutes * 60_000L)
}
