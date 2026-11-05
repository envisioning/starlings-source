package work.starlings.android.workspace.calendar

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.outlined.RemoveCircleOutline
import androidx.compose.material.icons.outlined.EditCalendar
import androidx.compose.material.icons.outlined.PersonAddAlt
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import kotlinx.coroutines.launch
import work.starlings.android.CalSource
import work.starlings.android.ui.ListActionRow
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.AddCircleOutline
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import work.starlings.android.CalCalendar
import work.starlings.android.R
import work.starlings.android.ui.ListFooter
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.SheetHeader
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType
import work.starlings.contracts.CalendarSemanticRole

/**
 * `MobileCalendarSourcesView`, the part Android reads: each Google account
 * as a section, with the account in or out of Starlings, each calendar shown
 * or hidden, and Remove this account for an extra one; the subscribed feeds
 * with a field to subscribe to a URL; the phone's own calendars behind
 * Include local calendars; then View (Calendar display and Weather, pushed),
 * the layers and the calendar new events land on. Hidden and disabled keys
 * are owner-wide (`CalendarKeys`). A long press on a calendar offers Not in
 * Starlings and, on a feed, Unsubscribe: the two swipes iOS has. Under the
 * accounts, Google Calendar offers Connect, or Add another Google account
 * once connected ([GoogleCalendarConnect]).
 */
@Composable
fun CalendarSourcesSheet(store: CalendarStore, onDone: () -> Unit) {
    // A View page pushed over the sheet: "display" or "weather".
    var pushed by rememberSaveable { mutableStateOf<String?>(null) }
    if (pushed != null) {
        BackHandler { pushed = null }
        Column(Modifier.fillMaxSize()) {
            val weather = pushed == PUSHED_WEATHER
            SheetHeader(
                stringResource(if (weather) R.string.cal_weather_title else R.string.cal_display_title),
                stringResource(R.string.cal_done),
                onDone = { pushed = null },
            )
            if (weather) {
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding().padding(horizontal = 16.dp, vertical = 8.dp)) {
                    CalendarWeatherSettings(store)
                }
            } else {
                CalendarDisplaySettings(store)
            }
        }
        return
    }
    val c = Starlings.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // Opening it is the moment the owner expects current data (a feed added on the Mac).
    LaunchedEffect(Unit) { store.reload(force = true) }
    Column(Modifier.fillMaxSize()) {
        SheetHeader(stringResource(R.string.cal_calendars), stringResource(R.string.cal_done), onDone)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding().padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            CalendarSourceGroups(store)

            SubscriptionSection(store)

            DeviceCalendarSection(store)

            Column {
                Text(stringResource(R.string.cal_view), Modifier.padding(start = 16.dp, bottom = 6.dp), style = StarlingsType.footnote, color = c.secondary)
                ListSection(null) {
                    PushRow(stringResource(R.string.cal_display_title)) { pushed = PUSHED_DISPLAY }
                    HorizontalDivider(Modifier.padding(start = 16.dp), thickness = 1.dp, color = c.border)
                    PushRow(stringResource(R.string.cal_weather_title)) { pushed = PUSHED_WEATHER }
                }
            }

            CalendarLayerSection(store)
            CalendarNewEventsSection(store)
            Spacer(Modifier.height(24.dp))
        }
    }
}

private const val PUSHED_DISPLAY = "display"
private const val PUSHED_WEATHER = "weather"

@Composable
private fun PushRow(title: String, onClick: () -> Unit) {
    val c = Starlings.colors
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick).padding(horizontal = 16.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, Modifier.weight(1f), style = StarlingsType.body, color = c.primary)
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(18.dp), tint = c.secondary)
    }
}

/**
 * `deviceSection`: Include local calendars, off until turned on. Once on and
 * allowed, one section per account on the phone with Show all or Hide all,
 * the account in or out of Starlings, and each calendar; else what access
 * says (checking, allow in Settings, or none found). The prompt itself is
 * [rememberDeviceCalendarAccess]'s.
 */
@Composable
internal fun DeviceCalendarSection(store: CalendarStore) {
    val c = Starlings.colors
    val context = LocalContext.current
    val included = store.includesLocalCalendars
    Column {
        Text(stringResource(R.string.cal_local_calendars), Modifier.padding(start = 16.dp, bottom = 6.dp), style = StarlingsType.footnote, color = c.secondary)
        ListSection(null) {
            ListRow {
                StarlingsToggle(stringResource(R.string.cal_include_local), included, { store.includeLocalCalendars(it) })
            }
        }
        if (!included) ListFooter(stringResource(R.string.cal_local_off))
    }
    if (!included) return
    val groups = store.sourceGroups.filter { (_, members) -> members.first().source == CalSource.DEVICE }
    if (store.deviceAccess == DeviceCalendars.Access.GRANTED && groups.isNotEmpty()) {
        groups.forEach { (group, members) ->
            val disabled = store.isAccountDisabled(group)
            Column {
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(group, Modifier.weight(1f), style = StarlingsType.footnote, color = c.secondary)
                    if (!disabled) {
                        val hidden = store.isAccountHidden(group)
                        Text(
                            stringResource(if (hidden) R.string.cal_show_all else R.string.cal_hide_all),
                            Modifier.clickable(role = Role.Button) { store.setAccountHidden(group, !hidden) },
                            style = StarlingsType.caption,
                            color = c.accent,
                        )
                    }
                }
                ListSection(null) {
                    ListRow(divider = !disabled) {
                        StarlingsToggle(stringResource(R.string.cal_show_in_starlings), !disabled, { store.setAccountDisabled(group, !it) })
                        if (disabled) Text(stringResource(R.string.cal_account_not_in_starlings), style = StarlingsType.caption2, color = c.secondary)
                    }
                    if (!disabled) members.forEach { calendar -> SourceRow(store, calendar) }
                }
                if (!disabled) ListFooter(stringResource(R.string.cal_local_new_hidden))
            }
        }
        return
    }
    Column {
        Text(stringResource(R.string.cal_on_this_device), Modifier.padding(start = 16.dp, bottom = 6.dp), style = StarlingsType.footnote, color = c.secondary)
        ListSection(null) {
            when (store.deviceAccess) {
                DeviceCalendars.Access.GRANTED -> Text(
                    stringResource(R.string.cal_no_device_calendars),
                    Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                    style = StarlingsType.subheadline,
                    color = c.secondary,
                )
                DeviceCalendars.Access.DENIED -> ListActionRow(
                    stringResource(R.string.cal_allow_calendar_access),
                    Icons.Outlined.Settings,
                    onClick = { openAppSettings(context) },
                )
                DeviceCalendars.Access.UNKNOWN -> Text(
                    stringResource(R.string.cal_checking_calendar_access),
                    Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                    style = StarlingsType.subheadline,
                    color = c.secondary,
                )
            }
        }
    }
}

/**
 * The Google accounts, one section each, then Google Calendar's Connect or
 * Add another Google account (`googleSection`). Settings › Calendar ›
 * Calendars in Starlings draws it too.
 */
@Composable
internal fun CalendarSourceGroups(store: CalendarStore) {
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    // Google accounts here; the subscribed feeds have their own section.
    store.sourceGroups.filter { (_, members) -> members.first().source == CalSource.GOOGLE }.forEach { (group, members) ->
        val disabled = store.isAccountDisabled(group)
        val removable = store.removableAccounts[group]
        Column {
            Text(group, Modifier.padding(start = 16.dp, bottom = 6.dp), style = StarlingsType.footnote, color = c.secondary)
            ListSection(null) {
                ListRow(divider = !disabled || removable != null) {
                    StarlingsToggle(stringResource(R.string.cal_show_in_starlings), !disabled, { store.setAccountDisabled(group, !it) })
                    if (disabled) Text(stringResource(R.string.cal_account_not_in_starlings), style = StarlingsType.caption2, color = c.secondary)
                }
                if (!disabled) members.forEach { calendar -> SourceRow(store, calendar) }
                if (removable != null) {
                    ListActionRow(
                        stringResource(R.string.cal_remove_account), Icons.Outlined.RemoveCircleOutline,
                        onClick = { scope.launch { store.removeAccount(removable) } }, tint = c.danger,
                    )
                }
            }
        }
    }
    GoogleCalendarSection(store)
}

/**
 * `googleSection`'s last section: Connect Google Calendar until Google is
 * connected, then Add another Google account. Nothing while the status is
 * unknown, so it never claims a state it has not read. A failure is the
 * store's alert, as every other Calendar failure.
 */
@Composable
private fun GoogleCalendarSection(store: CalendarStore) {
    val connect = rememberGoogleCalendarConnect(
        store.account,
        onFailure = { store.errorMessage = it },
        onConnected = { outcome ->
            when (outcome) {
                is GoogleCalendarConnected.Own -> store.noteGoogleConnected()
                is GoogleCalendarConnected.Account -> store.noteGoogleAccountAdded(outcome.response.account)
            }
        },
    )
    val connected = store.googleConnected ?: return
    val c = Starlings.colors
    val busy = connect.busy != null
    Column {
        Text(stringResource(R.string.cal_google_calendar), Modifier.padding(start = 16.dp, bottom = 6.dp), style = StarlingsType.footnote, color = c.secondary)
        ListSection(null) {
            if (connected) {
                ListActionRow(
                    stringResource(if (busy) R.string.cal_adding_account else R.string.cal_add_google_account),
                    Icons.Outlined.PersonAddAlt,
                    onClick = { store.errorMessage = null; connect.start(GoogleCalendarTarget.ACCOUNT) },
                    enabled = !busy,
                )
            } else {
                ListActionRow(
                    stringResource(if (busy) R.string.cal_connecting else R.string.cal_connect_google),
                    Icons.Outlined.EditCalendar,
                    onClick = { store.errorMessage = null; connect.start(GoogleCalendarTarget.OWN) },
                    enabled = !busy,
                )
            }
        }
    }
}

/** The workspace layers, each shown or hidden on this device (Settings › Calendar › layers too). */
@Composable
internal fun CalendarLayerSection(store: CalendarStore) {
    val c = Starlings.colors
    val context = LocalContext.current
    Column {
        Text(layersTitle(), Modifier.padding(start = 16.dp, bottom = 6.dp), style = StarlingsType.footnote, color = c.secondary)
        ListSection(null) {
            CalendarLayerKind.entries.forEach { layer ->
                val shown = !store.isHidden(layer)
                val title = CalendarLayerChrome.title(context, layer)
                val shownWord = stringResource(if (shown) R.string.cal_shown else R.string.cal_hidden)
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable(role = Role.Button) { store.setHidden(layer, shown) }
                        .clearAndSetSemantics { contentDescription = title; stateDescription = shownWord; role = Role.Button }
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(CalendarLayerChrome.icon(layer), null, Modifier.size(18.dp), tint = c.accent)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                        Text(title, style = StarlingsType.body, color = c.primary)
                        Text(CalendarLayerChrome.caption(context, layer), style = StarlingsType.caption2, color = c.secondary)
                    }
                    if (shown) Icon(Icons.Filled.Check, null, Modifier.size(18.dp), tint = c.primary)
                }
            }
        }
    }
}

/** The calendar new events land on (Settings › Calendar › New events too). */
@Composable
internal fun CalendarNewEventsSection(store: CalendarStore) {
    val c = Starlings.colors
    val choices = store.writableCalendars.filter { it.canBeWriteTarget }
    if (choices.isNotEmpty()) {
        Column {
            Text(stringResource(R.string.cal_new_events), Modifier.padding(start = 16.dp, bottom = 6.dp), style = StarlingsType.footnote, color = c.secondary)
            ListSection(null) {
                var open by remember { mutableStateOf(false) }
                Box {
                    Row(
                        Modifier.fillMaxWidth().clickable(role = Role.Button) { open = true }.padding(horizontal = 16.dp, vertical = 13.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(stringResource(R.string.cal_default_calendar), Modifier.weight(1f), style = StarlingsType.body, color = c.primary)
                        Text(store.defaultWriteCalendar?.title ?: stringResource(R.string.cal_choose_calendar), style = StarlingsType.body, color = c.secondary, maxLines = 1)
                    }
                    DropdownMenu(open, onDismissRequest = { open = false }) {
                        choices.forEach { calendar ->
                            DropdownMenuItem(
                                text = { Text(calendar.title) },
                                leadingIcon = { Dot(calendar) },
                                trailingIcon = { if (calendar.id == store.defaultWriteCalendar?.id) Icon(Icons.Filled.Check, null) },
                                onClick = { open = false; store.setDefaultWriteCalendar(calendar) },
                            )
                        }
                    }
                }
            }
        }
    }
}

/** The layers heading: `"\(workspace) layers"`, named after the workspace the build serves. */
@Composable
private fun layersTitle(): String =
    stringResource(R.string.cal_workspace_layers, CalCalendar.GLOBAL_INTEREST_TITLE.removeSuffix(" Internal"))

@Composable
private fun Dot(calendar: CalCalendar) {
    Box(Modifier.size(11.dp).background(CalendarChrome.color(calendar.displayColor), CircleShape))
}

/** One calendar: shown or hidden when it is in Starlings, the way back in when it is not. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SourceRow(store: CalendarStore, calendar: CalCalendar) {
    val c = Starlings.colors
    if (store.isDisabled(calendar)) {
        val notIn = stringResource(R.string.cal_not_in_starlings)
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button) { store.setDisabled(calendar, false) }
                .clearAndSetSemantics { contentDescription = "${calendar.title}, $notIn"; role = Role.Button }
                .padding(horizontal = 16.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Outlined.AddCircleOutline, null, Modifier.size(14.dp), tint = c.secondary)
            Text(calendar.title, Modifier.weight(1f), style = StarlingsType.body, color = c.secondary)
            Text(notIn, style = StarlingsType.caption2, color = c.secondary)
        }
        return
    }
    val hidden = store.isHidden(calendar)
    val notIn = stringResource(R.string.cal_not_in_starlings)
    val unsubscribeTitle = stringResource(R.string.cal_unsubscribe)
    val state = stringResource(if (hidden) R.string.cal_hidden else R.string.cal_shown)
    val scope = rememberCoroutineScope()
    val feed = calendar.source == CalSource.SUBSCRIPTION
    var menu by remember { mutableStateOf(false) }
    val unsubscribe = { scope.launch { store.unsubscribe(calendar) }; Unit }
    Box {
    DropdownMenu(menu, onDismissRequest = { menu = false }) {
        DropdownMenuItem(
            text = { Text(notIn) },
            leadingIcon = { Icon(Icons.Outlined.RemoveCircleOutline, null) },
            onClick = { menu = false; store.setDisabled(calendar, true) },
        )
        if (feed) {
            DropdownMenuItem(
                text = { Text(unsubscribeTitle, color = c.danger) },
                leadingIcon = { Icon(Icons.Outlined.RemoveCircleOutline, null, tint = c.danger) },
                onClick = { menu = false; unsubscribe() },
            )
        }
    }
    Row(
        Modifier
            .fillMaxWidth()
            .combinedClickable(
                role = Role.Button,
                onClick = { store.setHidden(calendar, !hidden) },
                onLongClick = { menu = true },
            )
            .clearAndSetSemantics {
                contentDescription = calendar.title
                stateDescription = state
                role = Role.Button
                customActions = listOfNotNull(
                    CustomAccessibilityAction(notIn) { store.setDisabled(calendar, true); true },
                    if (feed) CustomAccessibilityAction(unsubscribeTitle) { unsubscribe(); true } else null,
                )
            }
            .padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Dot(calendar)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(calendar.title, style = StarlingsType.body, color = c.primary)
            if (calendar.role == CalendarSemanticRole.GLOBAL_INTEREST) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    WorkspaceMark(CalendarChrome.color(calendar.displayColor), 11)
                    Text(stringResource(R.string.cal_editable_global), style = StarlingsType.caption2, color = CalendarChrome.color(calendar.displayColor))
                }
            }
            if (!calendar.writable) Text(stringResource(R.string.cal_read_only), style = StarlingsType.caption2, color = c.secondary)
        }
        if (!hidden) Icon(Icons.Filled.Check, null, Modifier.size(18.dp).width(18.dp), tint = c.primary)
    }
    }
}

/**
 * Subscribed feeds, above View because they are the owner's choice: each
 * feed, then the URL field that subscribes (`subscriptionSection`). The
 * footer says why the list could not be read, else what to paste.
 */
@Composable
internal fun SubscriptionSection(store: CalendarStore) {
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var address by rememberSaveable { mutableStateOf("") }
    var subscribing by remember { mutableStateOf(false) }
    val feeds = store.allCalendars.filter { it.source == CalSource.SUBSCRIPTION }
    val fieldLabel = stringResource(R.string.cal_paste_url)
    fun subscribe() {
        if (address.isBlank() || subscribing) return
        subscribing = true
        scope.launch {
            if (store.subscribe(address)) address = ""
            subscribing = false
        }
    }
    Column {
        Text(CalendarStore.SUBSCRIBED, Modifier.padding(start = 16.dp, bottom = 6.dp), style = StarlingsType.footnote, color = c.secondary)
        ListSection(null) {
            feeds.forEach { calendar ->
                SourceRow(store, calendar)
                HorizontalDivider(Modifier.padding(start = 16.dp), thickness = 1.dp, color = c.border)
            }
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Link, null, Modifier.size(18.dp), tint = c.primary)
                Box(Modifier.weight(1f)) {
                    BasicTextField(
                        value = address,
                        onValueChange = { address = it },
                        singleLine = true,
                        enabled = !subscribing,
                        textStyle = StarlingsType.body.copy(color = c.primary),
                        cursorBrush = SolidColor(c.accent),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false, imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { subscribe() }),
                        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp).semantics { contentDescription = fieldLabel },
                    )
                    if (address.isEmpty()) {
                        Text(stringResource(R.string.cal_subscription_placeholder), Modifier.padding(vertical = 8.dp), style = StarlingsType.body, color = c.secondary.copy(alpha = 0.7f))
                    }
                }
                if (subscribing) {
                    CircularProgressIndicator(Modifier.size(18.dp), color = c.secondary, strokeWidth = 2.dp)
                } else if (address.isNotBlank()) {
                    Text(
                        stringResource(R.string.cal_add),
                        Modifier.clickable(role = Role.Button) { subscribe() }.padding(4.dp),
                        style = StarlingsType.body,
                        color = c.accent,
                    )
                }
            }
        }
        val failure = store.subscriptionError
        if (failure != null) {
            Text(failure, Modifier.padding(start = 16.dp, end = 16.dp, top = 6.dp), style = StarlingsType.footnote, color = c.danger)
        } else {
            ListFooter(stringResource(R.string.cal_paste_url))
        }
    }
}
