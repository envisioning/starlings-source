package work.starlings.android.workspace.settings

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
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.EditCalendar
import androidx.compose.material.icons.outlined.EventAvailable
import androidx.compose.material.icons.outlined.EventRepeat
import androidx.compose.material.icons.outlined.Layers
import androidx.compose.material.icons.outlined.ViewWeek
import androidx.compose.material.icons.outlined.WbCloudy
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.unit.dp
import work.starlings.android.CalCalendar
import work.starlings.android.OwnerAccount
import work.starlings.android.R
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.workspace.calendar.CalendarBookingHours
import work.starlings.android.workspace.calendar.CalendarDisplaySections
import work.starlings.android.workspace.calendar.CalendarLayerSection
import work.starlings.android.workspace.calendar.CalendarNewEventsSection
import work.starlings.android.workspace.calendar.CalendarSourceGroups
import work.starlings.android.workspace.calendar.CalendarStore
import work.starlings.android.workspace.calendar.CalendarUpcomingSelection
import work.starlings.android.workspace.calendar.CalendarWeatherSettings
import work.starlings.android.workspace.calendar.DeviceCalendarSection
import work.starlings.android.workspace.calendar.SubscriptionSection
import work.starlings.android.workspace.calendar.rememberDeviceCalendarAccess

/**
 * Settings › Calendar (`MobileCalendarSettingsRootView`): an index of the
 * calendar choices, each its own page, because one screen of every control
 * makes the row a dead end. The state is [CalendarStore]'s, as iOS gives
 * the page its own `MobileCalendarStore`: hidden and disabled keys are
 * owner-wide, the layers and the new-events calendar are this device's.
 *
 * Every iOS pane, in its groups (`CalendarSettingsRegistry`): Accounts &
 * sources (Calendars in Starlings, with the feeds and the phone's own
 * calendars), Upcoming (Show in Upcoming), Display (Calendar display,
 * Weather), Calendar behavior (the layers, New events) and Booking (Booking
 * hours).
 */
enum class CalendarPane(val id: String) {
    SOURCES("calendar.sources"),
    UPCOMING("calendar.upcoming"),
    DISPLAY("calendar.display"),
    WEATHER("calendar.weather"),
    LAYERS("calendar.layers"),
    NEW_EVENTS("calendar.newEvents"),
    BOOKING("calendar.booking"),
    ;

    companion object {
        fun of(id: String?): CalendarPane? = entries.firstOrNull { it.id == id }
    }
}

/** The page and its panes share one store, made once for the Calendar page. */
@Composable
internal fun rememberSettingsCalendarStore(account: OwnerAccount): CalendarStore {
    val context = LocalContext.current.applicationContext
    val scope = rememberCoroutineScope()
    val store = remember(account) { CalendarStore(context, account, scope) }
    LaunchedEffect(store) { store.reload(force = true) }
    rememberDeviceCalendarAccess(store)
    return store
}

@Composable
internal fun CalendarSettingsPage(store: CalendarStore, open: (CalendarPane) -> Unit) {
    store.loadFailure?.let { failure -> ListSection(null) { WorkErrorNotice(failure) } }
    ListSection(stringResource(R.string.settings_cal_accounts_and_sources)) {
        PaneRow(Icons.Outlined.CalendarMonth, stringResource(R.string.settings_cal_sources), stringResource(R.string.settings_cal_sources_detail)) { open(CalendarPane.SOURCES) }
    }
    // How many rows Upcoming shows lives under Settings › Home; what feeds it is a calendar choice.
    ListSection(stringResource(R.string.settings_cal_upcoming)) {
        PaneRow(Icons.Outlined.EventRepeat, stringResource(R.string.settings_cal_show_in_upcoming), stringResource(R.string.settings_cal_upcoming_detail)) { open(CalendarPane.UPCOMING) }
    }
    ListSection(stringResource(R.string.settings_cal_display)) {
        PaneRow(Icons.Outlined.ViewWeek, stringResource(R.string.cal_display_title), stringResource(R.string.settings_cal_display_detail)) { open(CalendarPane.DISPLAY) }
        WorkDivider()
        PaneRow(Icons.Outlined.WbCloudy, stringResource(R.string.cal_weather_title), stringResource(R.string.settings_cal_weather_detail)) { open(CalendarPane.WEATHER) }
    }
    ListSection(stringResource(R.string.settings_cal_behavior)) {
        PaneRow(Icons.Outlined.Layers, layersTitle(), stringResource(R.string.settings_cal_layers_detail, workspaceName())) { open(CalendarPane.LAYERS) }
        WorkDivider()
        PaneRow(Icons.Outlined.EditCalendar, stringResource(R.string.cal_new_events), stringResource(R.string.settings_cal_new_events_detail)) { open(CalendarPane.NEW_EVENTS) }
    }
    // The hours guests book you in, owner-synced with the Mac and the web.
    ListSection(stringResource(R.string.settings_cal_booking)) {
        PaneRow(Icons.Outlined.EventAvailable, stringResource(R.string.booking_title), stringResource(R.string.settings_cal_booking_detail)) { open(CalendarPane.BOOKING) }
    }
}

/** One pane of Settings › Calendar. */
@Composable
internal fun CalendarSettingsPane(store: CalendarStore, pane: CalendarPane, close: () -> Unit) {
    when (pane) {
        CalendarPane.SOURCES -> {
            // A connect or remove that failed; the Calendar tab says it in its alert.
            store.errorMessage?.let { failure -> ListSection(null) { WorkErrorNotice(failure) } }
            CalendarSourceGroups(store)
            SubscriptionSection(store)
            DeviceCalendarSection(store)
        }
        CalendarPane.UPCOMING -> CalendarUpcomingSelection(store, onSaved = close)
        CalendarPane.DISPLAY -> CalendarDisplaySections(store)
        CalendarPane.WEATHER -> CalendarWeatherSettings(store)
        CalendarPane.LAYERS -> CalendarLayerSection(store)
        CalendarPane.NEW_EVENTS -> CalendarNewEventsSection(store)
        CalendarPane.BOOKING -> CalendarBookingHours(store)
    }
}

@Composable
internal fun calendarPaneTitle(pane: CalendarPane): String = when (pane) {
    CalendarPane.SOURCES -> stringResource(R.string.settings_cal_sources)
    CalendarPane.UPCOMING -> stringResource(R.string.settings_cal_show_in_upcoming)
    CalendarPane.DISPLAY -> stringResource(R.string.cal_display_title)
    CalendarPane.WEATHER -> stringResource(R.string.cal_weather_title)
    CalendarPane.LAYERS -> layersTitle()
    CalendarPane.NEW_EVENTS -> stringResource(R.string.cal_new_events)
    CalendarPane.BOOKING -> stringResource(R.string.booking_title)
}

/** The workspace the layers are named after, as the Calendar tab names them. */
private fun workspaceName(): String = CalCalendar.GLOBAL_INTEREST_TITLE.removeSuffix(" Internal")

@Composable
private fun layersTitle(): String = stringResource(R.string.cal_workspace_layers, workspaceName())

/** `calendarLinkLabel`: icon, title, the one-line detail, and the way in. */
@Composable
private fun PaneRow(icon: ImageVector, title: String, detail: String, action: () -> Unit) {
    val c = Starlings.colors
    val hint = stringResource(R.string.settings_opens, title)
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = action)
            .clearAndSetSemantics { contentDescription = "$title. $detail. $hint"; role = Role.Button; onClick { action(); true } }
            .padding(horizontal = 16.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(20.dp), tint = c.accent)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = StarlingsType.body, color = c.primary)
            Text(detail, style = StarlingsType.caption2, color = c.secondary)
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(18.dp), tint = c.secondary)
    }
}
