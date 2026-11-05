package work.starlings.android.workspace.settings

import android.app.LocaleManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.LocaleList
import android.text.format.DateUtils
import androidx.activity.compose.BackHandler
import androidx.annotation.RequiresApi
import androidx.compose.foundation.background
import androidx.compose.material3.VerticalDivider
import work.starlings.android.ui.isRegularWidth
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.MeetingRoom
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.AppEnvironment
import work.starlings.android.BuildConfig
import work.starlings.android.MeetingAlertPlan
import work.starlings.android.MeetingWarnings
import work.starlings.android.widgets.MeetingCountdown
import work.starlings.android.widgets.MeetingCountdownRules
import work.starlings.android.OwnerAccount
import work.starlings.android.R
import work.starlings.android.api.HostRoutes
import work.starlings.android.api.SettingsExtraRoutes
import work.starlings.android.api.SettingsRoutes
import work.starlings.android.api.StarlingsApiError
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.SheetHeader
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkActionRow
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkLabeledRow
import work.starlings.android.ui.WorkNote
import work.starlings.contracts.InterfaceLanguage
import work.starlings.contracts.OwnerDeviceSummary

/**
 * The way into Settings from Home's header, beside the Home settings gear,
 * as iOS opens `MobileSettingsView` from the surface menu's `Settings…`.
 * [openHomeSettings] is Home's own sheet: Settings › Home links to it.
 */
@Composable
fun SettingsButton(account: OwnerAccount, openHomeSettings: () -> Unit, modifier: Modifier = Modifier, request: SettingsRequest? = null) {
    var open by rememberSaveable { mutableStateOf(false) }
    var initialPage by rememberSaveable { mutableStateOf<String?>(null) }
    // A page asked for from elsewhere on Home (a setup step: `app.openSettings(page:)`).
    val asked = request?.page
    LaunchedEffect(asked) {
        if (asked != null) {
            initialPage = asked
            open = true
            request.taken()
        }
    }
    val label = stringResource(R.string.settings_title)
    Box(
        modifier
            .size(32.dp)
            .clickable(role = Role.Button) { initialPage = null; open = true }
            .clearAndSetSemantics { contentDescription = label; role = Role.Button; onClick { initialPage = null; open = true; true } },
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.Outlined.AccountCircle, null, Modifier.size(20.dp), tint = Starlings.colors.secondary)
    }
    if (open) SettingsSheet(account, openHomeSettings = { open = false; openHomeSettings() }, dismiss = { open = false }, initialPage = initialPage)
}

/** A Settings page someone asked Home to open, taken once by [SettingsButton]. */
class SettingsRequest {
    var page by mutableStateOf<String?>(null)
        private set

    fun open(page: SettingsPages.Page) { this.page = page.id }

    internal fun taken() { page = null }
}

/**
 * `MobileSettingsView` on a phone: the index of groups and pages
 * ([SettingsPages], the shared table), and one page pushed over it. Back
 * returns to the index; Done closes the sheet.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsSheet(account: OwnerAccount, openHomeSettings: () -> Unit, dismiss: () -> Unit, initialPage: String? = null) {
    val c = Starlings.colors
    var pageId by rememberSaveable { mutableStateOf(initialPage) }
    // A pane pushed over a page: Settings › Calendar's own pages.
    var paneId by rememberSaveable { mutableStateOf<String?>(null) }
    val page = SettingsPages.page(pageId)
    val pane = CalendarPane.of(paneId).takeIf { page == SettingsPages.Page.CALENDAR }
    val calendarStore = if (page == SettingsPages.Page.CALENDAR) rememberSettingsCalendarStore(account) else null
    // A regular width (ui/SizeClass.kt): the index beside the page, as iOS `NavigationSplitView`.
    val split = isRegularWidth()
    fun back() {
        if (pane != null) paneId = null else if (!split) pageId = null
    }
    // `selectInitialPaneIfNeeded`: iPad keeps a page beside the index; the phone starts at the index.
    LaunchedEffect(split) { if (split && pageId == null) pageId = firstPage().id }
    BackHandler(enabled = pane != null || (page != null && !split)) { back() }
    val openPage: (SettingsPages.Page) -> Unit = { next -> if (next == SettingsPages.Page.HOME) openHomeSettings() else { pageId = next.id; paneId = null } }
    val content: @Composable () -> Unit = {
        when (page) {
            null -> Index(open = openPage)
            SettingsPages.Page.ACCOUNT -> AccountPage(account)
            SettingsPages.Page.HOME -> Unit
            SettingsPages.Page.WORK -> WorkSettingsPage(account)
            SettingsPages.Page.CALENDAR -> calendarStore?.let { store ->
                if (pane != null) CalendarSettingsPane(store, pane) { paneId = null } else CalendarSettingsPage(store) { paneId = it.id }
            }
            SettingsPages.Page.APP_LOCK -> AppLockPage()
            SettingsPages.Page.ROOM -> RoomPage(account)
            SettingsPages.Page.NOTIFICATIONS -> NotificationsPage()
            SettingsPages.Page.CALLS -> CallsPage()
            SettingsPages.Page.APPEARANCE -> AppearancePage(account)
            SettingsPages.Page.ABOUT -> AboutPage()
        }
    }
    ModalBottomSheet(onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = c.canvas) {
        val heading = pane?.let { calendarPaneTitle(it) } ?: page?.let { stringResource(title(it)) } ?: stringResource(R.string.settings_title)
        if (split) {
            Row(Modifier.navigationBarsPadding()) {
                Column(Modifier.width(SIDEBAR_WIDTH)) {
                    Text(
                        stringResource(R.string.settings_title),
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 16.dp),
                        style = StarlingsType.headline,
                        color = c.primary,
                    )
                    Column(
                        Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 12.dp).padding(bottom = 16.dp),
                        verticalArrangement = Arrangement.spacedBy(20.dp),
                    ) {
                        Index(current = page, open = openPage)
                    }
                }
                VerticalDivider(color = c.border)
                Column(Modifier.weight(1f)) {
                    Box {
                        SheetHeader(heading, stringResource(R.string.settings_done), dismiss)
                        if (pane != null) BackButton(Modifier.align(Alignment.CenterStart).padding(start = 8.dp), ::back)
                    }
                    Column(
                        Modifier.verticalScroll(rememberScrollState()).padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(20.dp),
                    ) {
                        content()
                    }
                }
            }
        } else {
            Column(Modifier.navigationBarsPadding()) {
                Box {
                    SheetHeader(heading, stringResource(R.string.settings_done), dismiss)
                    if (page != null) BackButton(Modifier.align(Alignment.CenterStart).padding(start = 8.dp), ::back)
                }
                Column(
                    Modifier.verticalScroll(rememberScrollState()).padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(20.dp),
                ) {
                    content()
                }
            }
        }
    }
}

/** The index column beside the page on a regular width (`navigationSplitViewColumnWidth(ideal: 220)`). */
private val SIDEBAR_WIDTH = 220.dp

/** The page a regular width opens with: the index's first page that is a page of this sheet. */
private fun firstPage(): SettingsPages.Page =
    SettingsPages.groups(languageAvailable).flatMap { it.second }.first { it != SettingsPages.Page.HOME }

private fun title(page: SettingsPages.Page): Int = when (page) {
    SettingsPages.Page.ACCOUNT -> R.string.settings_page_account
    SettingsPages.Page.HOME -> R.string.settings_page_home
    SettingsPages.Page.WORK -> R.string.settings_page_work
    SettingsPages.Page.CALENDAR -> R.string.settings_page_calendar
    SettingsPages.Page.ROOM -> R.string.settings_page_room
    SettingsPages.Page.NOTIFICATIONS -> R.string.settings_page_notifications
    SettingsPages.Page.CALLS -> R.string.settings_page_calls
    SettingsPages.Page.APPEARANCE -> R.string.settings_page_appearance
    SettingsPages.Page.APP_LOCK -> R.string.lock_title
    SettingsPages.Page.ABOUT -> R.string.settings_page_about
}

private fun icon(page: SettingsPages.Page): ImageVector = when (page) {
    SettingsPages.Page.ACCOUNT -> Icons.Outlined.AccountCircle
    SettingsPages.Page.HOME -> Icons.Outlined.Home
    SettingsPages.Page.WORK -> Icons.Outlined.Inbox
    SettingsPages.Page.CALENDAR -> Icons.Outlined.CalendarMonth
    SettingsPages.Page.ROOM -> Icons.Outlined.MeetingRoom
    SettingsPages.Page.NOTIFICATIONS -> Icons.Outlined.Notifications
    SettingsPages.Page.CALLS -> Icons.Outlined.Call
    SettingsPages.Page.APPEARANCE -> Icons.Outlined.Palette
    SettingsPages.Page.APP_LOCK -> Icons.Outlined.Lock
    SettingsPages.Page.ABOUT -> Icons.Outlined.Info
}

private fun groupTitle(group: SettingsPages.Group): Int = when (group) {
    SettingsPages.Group.ACCOUNT -> R.string.settings_group_account
    SettingsPages.Group.PREFERENCES -> R.string.settings_group_preferences
    SettingsPages.Group.SECURITY -> R.string.settings_group_security
    SettingsPages.Group.SYSTEM -> R.string.settings_group_system
}

/** Android has a per-app language from Android 13 (`LocaleManager`). minSdk is 31. */
private val languageAvailable: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU

@Composable
private fun BackButton(modifier: Modifier, action: () -> Unit) {
    val label = stringResource(R.string.settings_back)
    Box(
        modifier
            .size(40.dp)
            .clickable(role = Role.Button, onClick = action)
            .clearAndSetSemantics { contentDescription = label; role = Role.Button; onClick { action(); true } },
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.AutoMirrored.Filled.ArrowBack, null, tint = Starlings.colors.primary)
    }
}

/** The groups and their pages. [current] marks the page beside the index on a regular width. */
@Composable
private fun Index(current: SettingsPages.Page? = null, open: (SettingsPages.Page) -> Unit) {
    val c = Starlings.colors
    SettingsPages.groups(languageAvailable).forEach { (group, pages) ->
        ListSection(stringResource(groupTitle(group))) {
            pages.forEachIndexed { index, page ->
                val name = stringResource(title(page))
                val hint = stringResource(R.string.settings_opens, name)
                val on = page == current
                Row(
                    Modifier
                        .fillMaxWidth()
                        .then(if (on) Modifier.background(c.selected) else Modifier)
                        .clickable(role = Role.Button) { open(page) }
                        .clearAndSetSemantics { contentDescription = "$name. $hint"; role = Role.Button; if (current != null) selected = on; onClick { open(page); true } }
                        .padding(horizontal = 16.dp, vertical = 11.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(icon(page), null, Modifier.size(20.dp), tint = c.accent)
                    Spacer(Modifier.width(12.dp))
                    Text(name, Modifier.weight(1f), style = StarlingsType.body, color = c.primary)
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(18.dp), tint = c.secondary)
                }
                if (index < pages.lastIndex) WorkDivider()
            }
        }
    }
    // Last: a workspace with no session can still switch back to one that has one.
    WorkspacesSection()
}

@Composable
private fun Footer(text: String) {
    Text(text, Modifier.padding(horizontal = 16.dp, vertical = 6.dp), style = StarlingsType.footnote, color = Starlings.colors.secondary)
}

/** One choice of a picker, as a row with a check: TalkBack reads it as a selected radio button. */
@Composable
private fun ChoiceRow(text: String, chosen: Boolean, enabled: Boolean = true, divider: Boolean, choose: () -> Unit) {
    val c = Starlings.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, role = Role.RadioButton, onClick = choose)
            .clearAndSetSemantics {
                contentDescription = text
                role = Role.RadioButton
                selected = chosen
                if (enabled) onClick { choose(); true }
            }
            .padding(horizontal = 16.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, Modifier.weight(1f), style = StarlingsType.body, color = if (enabled) c.primary else c.secondary)
        if (chosen) Icon(Icons.Filled.Check, null, Modifier.size(18.dp), tint = c.accent)
    }
    if (divider) WorkDivider()
}

/** The failure title the route names; errors stay English. */
private fun Throwable.operation(fallback: String): String = (this as? StarlingsApiError)?.sentence ?: fallback

// MARK: Account

/** The Account page: who is signed in, Picture, Core, Keep, Connected agents, Devices and Sign out (`MobileSettingsView.account`). */
@Composable
private fun AccountPage(account: OwnerAccount) {
    val owner = remember(account) { account.session.credentials() }
    if (owner != null) {
        ListSection(stringResource(R.string.settings_account)) {
            WorkLabeledRow(stringResource(R.string.settings_name), owner.name)
            WorkDivider()
            WorkLabeledRow(stringResource(R.string.settings_email), owner.email)
        }
    }
    ProfilePictureSection(account)
    // Core: the token's account and expiry, Reconnect, Disconnect; nothing where the workspace has no Core.
    work.starlings.android.core.ui.CoreSettingsSection()
    // Keep's unlock methods once the token is there; nothing where the workspace has no Keep.
    work.starlings.android.keep.ui.KeepSettingsSections()
    ConnectedAgentsSection(account)
    DevicesSection(account)
    Column {
        ListSection(null) {
            WorkActionRow(stringResource(R.string.settings_sign_out), onClick = { account.signOut() }, danger = true)
            // Shown when more than one workspace is signed in.
            val app = LocalContext.current.applicationContext as work.starlings.android.StarlingsApp
            if (remember(app) { app.workspaces.known.value.count(app::hasSession) } > 1) {
                WorkDivider()
                WorkActionRow(stringResource(R.string.workspaces_sign_out_all), onClick = { app.signOutOfAllWorkspaces() }, danger = true)
            }
        }
        Footer(stringResource(R.string.settings_sign_out_footer, AppEnvironment.WORKSPACE_NAME))
    }
}

/**
 * `MobileDevicesSection`: the person's signed-in Macs and phones, this one
 * marked, each with Sign out. The current device's Sign out is the app's
 * own sign-out, which tells the Worker itself: one path.
 */
@Composable
private fun DevicesSection(account: OwnerAccount) {
    val scope = rememberCoroutineScope()
    var devices by remember { mutableStateOf<List<OwnerDeviceSummary>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(account) {
        try {
            devices = account.client.call(SettingsRoutes.devices).devices
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.operation(SettingsRoutes.devices.operation)
        }
    }
    fun signOut(device: OwnerDeviceSummary) {
        error = null
        if (device.current) {
            account.signOut()
            return
        }
        scope.launch {
            try {
                devices = account.client.call(SettingsRoutes.revokeDevice(device.deviceId)).devices
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.operation(SettingsRoutes.revokeDevice(device.deviceId).operation)
            }
        }
    }
    Column {
        ListSection(stringResource(R.string.settings_devices)) {
            val rows = devices
            if (rows != null && rows.isEmpty()) WorkNote(stringResource(R.string.settings_devices_none))
            rows?.forEachIndexed { index, device ->
                ListRow(divider = index < rows.lastIndex) { DeviceRow(device) { signOut(device) } }
            }
            error?.let { WorkErrorNotice(it) }
        }
        Footer(stringResource(R.string.settings_devices_footer))
    }
}

@Composable
private fun DeviceRow(device: OwnerDeviceSummary, signOut: () -> Unit) {
    val c = Starlings.colors
    val kind = DeviceRows.kind(device)
    val title = DeviceRows.label(device) ?: when (kind) {
        DeviceRows.Kind.ANDROID -> stringResource(R.string.settings_kind_android)
        DeviceRows.Kind.IPHONE -> stringResource(R.string.settings_title_iphone)
        DeviceRows.Kind.MAC -> stringResource(R.string.settings_kind_mac)
    }
    val kindText = stringResource(
        when (kind) {
            DeviceRows.Kind.ANDROID -> R.string.settings_kind_android
            DeviceRows.Kind.IPHONE -> R.string.settings_kind_ios
            DeviceRows.Kind.MAC -> R.string.settings_kind_mac
        },
    )
    val now = System.currentTimeMillis()
    val renewed = DateUtils.getRelativeTimeSpanString(DeviceRows.renewedMs(device, now), now, DateUtils.MINUTE_IN_MILLIS).toString()
    val base = stringResource(R.string.settings_device_renewed, kindText, renewed)
    val detail = if (device.current) stringResource(R.string.settings_this_device, base) else base
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = StarlingsType.body, color = c.primary)
            Text(detail, style = StarlingsType.footnote, color = c.secondary)
        }
        Spacer(Modifier.width(12.dp))
        // Signing a device out loses nothing: it signs in again.
        Text(
            stringResource(R.string.settings_sign_out),
            Modifier.clickable(role = Role.Button, onClick = signOut).padding(vertical = 6.dp),
            style = StarlingsType.body,
            color = c.danger,
        )
    }
}

// MARK: Room

/** `MobileRoomPolicySettingsView`: refuse recording notetakers at the owner's room. */
@Composable
private fun RoomPage(account: OwnerAccount) {
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var slug by remember { mutableStateOf<String?>(null) }
    var refuse by remember { mutableStateOf<Boolean?>(null) }
    var loading by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }

    LaunchedEffect(account, attempt) {
        loading = true
        error = null
        try {
            val room = account.client.call(SettingsRoutes.ownerRoom).room
            val lobby = account.client.call(HostRoutes.lobby(room.slug))
            slug = room.slug
            refuse = lobby.roomSettings?.refuseRecorders ?: false
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.operation(SettingsRoutes.ownerRoom.operation)
        } finally {
            loading = false
        }
    }

    fun save(next: Boolean) {
        val room = slug ?: return
        val previous = refuse ?: return
        if (saving) return
        refuse = next
        saving = true
        error = null
        scope.launch {
            try {
                refuse = account.client.call(SettingsExtraRoutes.updateRoomSettings(room, next)).refuseRecorders
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                refuse = previous
                error = e.operation(SettingsExtraRoutes.updateRoomSettings(room, next).operation)
            } finally {
                saving = false
            }
        }
    }

    Column {
        ListSection(stringResource(R.string.settings_recording_notetakers)) {
            ListRow {
                val value = refuse
                when {
                    value != null -> StarlingsToggle(stringResource(R.string.settings_refuse_recorders), value, ::save, enabled = !loading && !saving)
                    loading -> Text(stringResource(R.string.settings_loading_room), style = StarlingsType.body, color = c.secondary)
                }
                slug?.let { Text(stringResource(R.string.settings_your_room, it), style = StarlingsType.footnote, color = c.secondary) }
            }
            error?.let { WorkErrorNotice(it, stringResource(R.string.settings_try_again), onRetry = { if (!loading && !saving) attempt++ }) }
        }
        Footer(stringResource(R.string.settings_recorders_footer))
    }
}

// MARK: Notifications

/**
 * The meeting warning switch, its lead and the Lock Screen countdown's lead,
 * device-local as iOS `MeetingAlertSettings` (`MeetingWarnings`). Turning it
 * off takes back the warnings already set and ends the countdown; Home sets
 * the warnings again with the new lead on its next read.
 */
@Composable
private fun NotificationsPage() {
    val context = LocalContext.current.applicationContext
    var enabled by remember { mutableStateOf(MeetingWarnings.enabled(context)) }
    var lead by remember { mutableStateOf(MeetingWarnings.leadMinutes(context)) }
    var countdownLead by remember { mutableStateOf(MeetingWarnings.countdownLeadMinutes(context)) }
    ListSection(stringResource(R.string.settings_page_notifications)) {
        ListRow {
            StarlingsToggle(stringResource(R.string.settings_meeting_warning), enabled, { on ->
                MeetingWarnings.setEnabled(context, on)
                if (!on) MeetingWarnings.cancelAll(context)
                MeetingCountdown.synchronize(context)
                enabled = on
            })
        }
    }
    ListSection(stringResource(R.string.settings_warn)) {
        MeetingAlertPlan.leadChoices.forEachIndexed { index, minutes ->
            ChoiceRow(leadLabel(context, minutes), chosen = minutes == lead, enabled = enabled, divider = index < MeetingAlertPlan.leadChoices.lastIndex) {
                MeetingWarnings.setLeadMinutes(context, minutes)
                lead = minutes
            }
        }
    }
    // iOS's "Lock Screen countdown" picker: how early the countdown notification appears.
    ListSection(stringResource(R.string.settings_countdown)) {
        MeetingCountdownRules.leadChoices.forEachIndexed { index, minutes ->
            ChoiceRow(leadLabel(context, minutes), chosen = minutes == countdownLead, enabled = enabled, divider = index < MeetingCountdownRules.leadChoices.lastIndex) {
                MeetingWarnings.setCountdownLeadMinutes(context, minutes)
                MeetingCountdown.synchronize(context)
                countdownLead = minutes
            }
        }
    }
    ChannelsSection()
}

/** `MeetingAlertSettings.leadLabel`: "5 min before", "2h before". */
private fun leadLabel(context: Context, minutes: Int): String =
    if (minutes < 60) context.getString(R.string.settings_minutes_before, minutes) else context.getString(R.string.settings_hours_before, minutes / 60)

// MARK: Calls

/** What a call on this phone does. Android has no spatial audio switch. */
@Composable
private fun CallsPage() {
    Column {
        ListSection(stringResource(R.string.settings_page_calls)) {
            WorkLabeledRow(stringResource(R.string.settings_participation), stringResource(R.string.settings_host_and_join))
            WorkDivider()
            WorkLabeledRow(stringResource(R.string.settings_background_audio), stringResource(R.string.settings_on))
        }
        Footer(stringResource(R.string.settings_never_records))
    }
}

// MARK: Appearance

/**
 * Appearance and Grid texture first, as iOS (DeviceSections.kt). Then the
 * interface language, owner-synced and drawn through
 * Android's per-app locale. The Worker hears the choice first; the locale
 * changes only when it is saved, so a failed save leaves the row where it
 * was. Changing the locale recreates the activity; the sheet reopens on
 * this page.
 */
@Composable
private fun AppearancePage(account: OwnerAccount) {
    AppearanceSection()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) LanguageSection(account)
    AppIconSection()
}

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
@Composable
private fun LanguageSection(account: OwnerAccount) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val locales = remember(context) { context.getSystemService(LocaleManager::class.java) }
    var chosen by remember { mutableStateOf(LanguageChoice.fromTags(locales.applicationLocales.toLanguageTags())) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun choose(next: InterfaceLanguage?) {
        if (saving || next == chosen) return
        saving = true
        error = null
        scope.launch {
            try {
                val saved = account.client.call(SettingsRoutes.setLanguage(next)).language
                chosen = saved
                val tag = LanguageChoice.tag(saved)
                locales.applicationLocales = if (tag.isEmpty()) LocaleList.getEmptyLocaleList() else LocaleList.forLanguageTags(tag)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.operation(SettingsRoutes.setLanguage(next).operation)
            } finally {
                saving = false
            }
        }
    }

    ListSection(stringResource(R.string.settings_language)) {
        LanguageChoice.offered.forEachIndexed { index, language ->
            val label = stringResource(
                when (language) {
                    null -> R.string.settings_language_system
                    InterfaceLanguage.PT_BR -> R.string.settings_language_pt
                    else -> R.string.settings_language_en
                },
            )
            ChoiceRow(label, chosen = language == chosen, enabled = !saving, divider = index < LanguageChoice.offered.lastIndex) { choose(language) }
        }
        error?.let { WorkErrorNotice(it) }
    }
}

// MARK: About

/** Version, build, the server this build talks to, and the workspace's Help and Privacy pages. */
@Composable
private fun AboutPage() {
    val context = LocalContext.current
    ListSection(stringResource(R.string.settings_page_about)) {
        WorkLabeledRow(stringResource(R.string.settings_version), BuildConfig.VERSION_NAME)
        WorkDivider()
        WorkLabeledRow(stringResource(R.string.settings_build), "${BuildConfig.VERSION_CODE} (${BuildConfig.GIT_COMMIT})")
        WorkDivider()
        WorkLabeledRow(stringResource(R.string.settings_server), AppEnvironment.name(work.starlings.android.Workspaces.active.apiOrigin))
        WorkDivider()
        WorkActionRow(stringResource(R.string.settings_help), onClick = { open(context, "${work.starlings.android.Workspaces.active.publicOrigin}/help") }, accent = true)
        WorkDivider()
        WorkActionRow(stringResource(R.string.settings_privacy), onClick = { open(context, "${work.starlings.android.Workspaces.active.publicOrigin}/privacy") }, accent = true)
    }
}

private fun open(context: Context, url: String) {
    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}
