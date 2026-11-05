package work.starlings.android.workspace.calendar

import android.content.Context
import work.starlings.android.ui.toast
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import work.starlings.android.CalCalendar
import work.starlings.android.CalEvent
import work.starlings.android.CalGroup
import work.starlings.android.CalendarDates
import work.starlings.android.CalendarKeys
import work.starlings.android.CalendarLayout
import work.starlings.android.CalendarMerge
import work.starlings.android.CalSource
import work.starlings.android.MeetingPlatforms
import work.starlings.android.OwnerAccount
import work.starlings.android.Rsvp
import work.starlings.android.api.CalendarExtraRoutes
import work.starlings.android.api.CalendarRoutes
import work.starlings.android.api.HomeExtraRoutes
import work.starlings.android.api.SettingsRoutes
import work.starlings.android.api.TeamRoutes
import work.starlings.android.api.WorkExtraRoutes
import work.starlings.android.api.WorkRoutes
import work.starlings.contracts.CrmContact
import work.starlings.contracts.CrmContactsQuery
import work.starlings.android.R
import work.starlings.contracts.CalendarAccount
import work.starlings.contracts.CalendarFreeBusyPerson
import work.starlings.contracts.CalendarSubscriptionCreateRequest
import work.starlings.contracts.CalendarFreeBusyRequest
import work.starlings.contracts.PeerKindValue
import work.starlings.contracts.CalendarEventSubject
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import work.starlings.android.workspace.home.roomLink
import work.starlings.contracts.OwnerRoomConfiguration
import work.starlings.android.api.StarlingsApiError
import work.starlings.contracts.CalendarBookingMintRequest
import work.starlings.contracts.CalendarEventCreateRequest
import work.starlings.contracts.CalendarEventDeleteRequest
import work.starlings.contracts.CalendarEventMoveRequest
import work.starlings.contracts.CalendarEventPatchRequest
import work.starlings.contracts.CalendarEventRespondRequest
import work.starlings.contracts.CalendarPreferencesResponse
import work.starlings.contracts.CalendarQuickAddRequest
import work.starlings.contracts.CalendarQuickAddResponseSource
import work.starlings.contracts.CalendarPreferencesUpdate
import work.starlings.contracts.GoogleCalendarListEntry
import work.starlings.contracts.Patch
import java.net.URI
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.WeekFields
import java.util.Locale

/**
 * `iOS/MobileCalendarStore.swift` over the slice of `CalendarWorkspace` the
 * phone reads from the Worker: the Google calendars and subscribed feeds,
 * their events for the period on screen and one period either side, the
 * owner-wide calendar choices, and every write the event sheet makes. Owned
 * by the Calendar screen; Compose reads its state directly.
 *
 * The phone's own calendars ([DeviceCalendars], iOS EventKit) join the list
 * when Include local calendars is on and `READ_CALENDAR` is granted; their
 * events merge with the rest by [CalendarMerge]. The forecast for the day
 * heads ([WeatherForecasts]) is read apart from the calendar, so a slow
 * forecast never makes the events wait.
 */
class CalendarStore(private val context: Context, internal val account: OwnerAccount, private val scope: CoroutineScope) {
    private val defaults = context.getSharedPreferences("calendar", Context.MODE_PRIVATE)
    private val ownHosts = work.starlings.android.Workspaces.active.let { w -> listOf(w.webOrigin, w.publicOrigin) + w.linkHosts.orEmpty() }.mapNotNull { runCatching { URI(it).host?.lowercase() }.getOrNull() }.distinct()
    val zone: ZoneId get() = ZoneId.systemDefault()
    val firstDayOfWeek: DayOfWeek get() = WeekFields.of(Locale.getDefault()).firstDayOfWeek

    /** The last layout picked wins; else the default view, else Day, as iOS on a phone. */
    var layout by mutableStateOf(CalendarLayout.of(defaults.getString(MODE_KEY, null)) ?: CalendarDisplay.openingLayout(defaults.all, CalendarDisplay.isTablet(context)))
        private set

    /** The device-local display choices (`CalendarWindowPreferences`). */
    var display by mutableStateOf(CalendarDisplay.read(defaults.all))
        private set

    /** The workspace's time-zone shortlist, null for every preset. */
    private var zoneShortlist by mutableStateOf(CalendarWorkspaceZones.cached(defaults))
    private var zonesRead = false

    /** `StarlingsScheduleTimeZone.offered`: the composer's and the second clock's zones. */
    val offeredZones: List<work.starlings.android.CalendarValues.ScheduleZone>
        get() = CalendarSchedule.offered(zoneShortlist)

    /** The connected Google accounts; extra ones can be removed from the sources sheet. */
    var googleAccounts by mutableStateOf<List<CalendarAccount>>(emptyList())
        private set

    /** The last subscriptions read's failure, said under the Subscribed section. */
    var subscriptionError by mutableStateOf<String?>(null)
        private set

    private val device = DeviceCalendars(context)

    /** Include local calendars: owner-wide on the Worker, cached here for the first paint. */
    var includesLocalCalendars by mutableStateOf(defaults.getBoolean(INCLUDES_LOCAL_KEY, false))
        private set

    /** `eventKitAccess`: unknown until the person has been asked, then granted or denied. */
    var deviceAccess by mutableStateOf(readDeviceAccess())
        private set

    /** Whether the write permission was asked for: a phone that granted the read before writes existed asks once more. */
    private var deviceWriteAsked by mutableStateOf(defaults.getBoolean(DEVICE_WRITE_ASKED_KEY, false))

    /** The forecast for the days on screen, by `yyyy-MM-dd`. Empty when weather is off or has no place. */
    var weather by mutableStateOf<Map<String, DailyForecast>>(emptyMap())
        private set
    var weatherFailure by mutableStateOf<String?>(null)
        private set
    var showsWeather by mutableStateOf(WeatherPreferences.showsWeather(defaults.all))
        private set
    var weatherPlace by mutableStateOf(WeatherPreferences.place(defaults.all))
        private set
    private var weatherJob: Job? = null

    /**
     * Settings and the Calendar tab each hold a store, as on iOS; the
     * preferences file is the hand-off, so a choice made in one is drawn in
     * the other without a relaunch. Held in a field: the file keeps a weak one.
     */
    private val preferenceWatch = android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        when {
            key == WeatherPreferences.KEY_SHOWS || key == WeatherPreferences.KEY_PLACE -> refreshWeather()
            key != null && key in CalendarDisplay.KEYS -> display = CalendarDisplay.read(defaults.all)
            key == INCLUDES_LOCAL_KEY || key == DEVICE_ASKED_KEY -> {
                val included = defaults.getBoolean(INCLUDES_LOCAL_KEY, false)
                val access = readDeviceAccess()
                if (included != includesLocalCalendars || access != deviceAccess) {
                    includesLocalCalendars = included
                    deviceAccess = access
                    held.clear()
                    reload(force = true)
                }
            }
        }
    }

    init {
        defaults.registerOnSharedPreferenceChangeListener(preferenceWatch)
    }

    /** Set the display choices: kept on the device, drawn at once. */
    fun updateDisplay(next: CalendarDisplay) {
        val declinedOrHidden = next.showsDeclined != display.showsDeclined || next.showsHidden != display.showsHidden
        display = next
        defaults.edit().apply {
            next.entries().forEach { (key, value) ->
                when (value) {
                    null -> remove(key)
                    is Int -> putInt(key, value)
                    is Float -> putFloat(key, value)
                    is Boolean -> putBoolean(key, value)
                    is String -> putString(key, value)
                }
            }
        }.apply()
        // The held period draws again under the new filter before the refresh lands.
        if (declinedOrHidden) reload()
    }

    /** A pinch in progress: drawn at once, written when the fingers lift ([updateDisplay]). */
    fun previewHourHeight(height: Float) {
        display = display.withHourHeight(height)
    }

    /** Zoom in or out by a factor (TalkBack's actions), kept at once. */
    fun zoomHours(factor: Float) = updateDisplay(display.withHourHeight(display.hourHeight * factor))

    /** `MobileCalendarLayout.setStoredDefault`: the exact layout, the shared day/week/month, and the screen. */
    fun setDefaultLayout(next: CalendarLayout) {
        defaults.edit()
            .putString(CalendarDisplay.KEY_MOBILE_DEFAULT_VIEW, next.wire)
            .putString(CalendarDisplay.KEY_DEFAULT_VIEW, CalendarDisplay.sharedView(next))
            .apply()
        choose(next)
    }

    val defaultLayout: CalendarLayout get() = CalendarDisplay.openingLayout(defaults.all, CalendarDisplay.isTablet(context))
    var anchor by mutableStateOf(LocalDate.now())
        private set
    var calendars by mutableStateOf<List<CalCalendar>>(emptyList())
        private set
    /** What the grids draw: hidden calendars out, hidden-from-Next out. */
    var events by mutableStateOf<List<CalEvent>>(emptyList())
        private set
    /** Unknown until the Worker answers: no banner on a guess. */
    var googleConnected by mutableStateOf<Boolean?>(null)
        private set
    var isLoading by mutableStateOf(false)
        private set
    /** The last read's failure, said in a banner that retries. */
    var loadFailure by mutableStateOf<String?>(null)
        private set
    /** A write that failed: the alert. */
    var errorMessage by mutableStateOf<String?>(null)

    /** Which layers are drawn: a per-device view choice, not a subscription (`CalendarLayerPreferences`). */
    var hiddenLayers by mutableStateOf(
        defaults.getStringSet(LAYERS_KEY, null).orEmpty().mapNotNull(CalendarLayerKind::of).toSet(),
    )
        private set
    /** Published events, Core's dated work and bookable hours for the loaded range. */
    private var layerItems by mutableStateOf<List<CalendarLayerItem>>(emptyList())

    private val mirror: CalendarLayers.MirrorSplit
        get() = CalendarLayers.splitMirrored(layerItems.filter { it.kind !in hiddenLayers }, events)

    /** The layer rows the grids draw: hidden kinds out, mirrored published events out. */
    val visibleLayers: List<CalendarLayerItem> get() = mirror.layers

    /** The owner's room, which Schedule a meeting books against. Null until read, or when there is none. */
    var room by mutableStateOf<OwnerRoomConfiguration?>(null)
        private set

    /** The calendar last written to, as state so the sheet's choice shows at once. */
    private var writeChoice by mutableStateOf(defaults.getString(WRITE_KEY, null))

    /** Every calendar listed, those out of Starlings too: the sources sheet offers them back. */
    var allCalendars by mutableStateOf<List<CalCalendar>>(emptyList())
        private set

    private var preferences by mutableStateOf<CalendarPreferencesResponse?>(null)
    private var calendarListAt = 0L
    private val held = HashMap<String, List<CalEvent>>()
    private val heldLayers = HashMap<String, List<CalendarLayerItem>>()
    private var loadJob: Job? = null

    fun choose(next: CalendarLayout) {
        if (next == layout) return
        layout = next
        defaults.edit().putString(MODE_KEY, next.wire).apply()
        reload()
    }

    // Period on screen

    val days: List<LocalDate> get() = layout.days(anchor, firstDayOfWeek)

    fun days(offset: Int): List<LocalDate> =
        if (offset == 0) days else layout.days(anchor(offset), firstDayOfWeek)

    /** The anchor [offset] periods away: what the pager's neighbour page is drawn around. */
    fun anchor(offset: Int): LocalDate = if (offset == 0) anchor else layout.step(anchor, offset)

    fun step(direction: Int) {
        anchor = layout.step(anchor, direction)
        reload()
    }

    fun goToToday() {
        anchor = LocalDate.now()
        reload()
    }

    fun select(day: LocalDate) {
        anchor = day
        reload()
    }

    /** The period on screen and one either side, so the next page is real before it is reached. */
    private fun loadedRange(): Pair<Instant, Instant> {
        val spread = (-1..1).flatMap { days(it) }
        val first = spread.minOrNull() ?: anchor
        val last = spread.maxOrNull() ?: anchor
        return Instant.ofEpochMilli(CalendarDates.startOfDay(first, zone)) to
            Instant.ofEpochMilli(CalendarDates.startOfDay(last.plusDays(1), zone))
    }

    // Reading

    fun reload(force: Boolean = false) {
        loadJob?.cancel()
        loadJob = scope.launch { load(force) }
    }

    /** `refreshSources`: the calendar list read before a pane offers it (Show in Upcoming). */
    suspend fun refreshSources() = reloadNow()

    /** A reload the caller waits for, so what follows reads the period it asked for. */
    private suspend fun reloadNow(force: Boolean = false) {
        loadJob?.cancel()
        val job = scope.launch { load(force) }
        loadJob = job
        job.join()
    }

    /**
     * `reveal(eventReference:)`: page to the day a route names and find its
     * event there. Without a day, or when the event is not in that period,
     * the window the Worker searched (a week back, five ahead) is read once
     * before giving up. A merged group is found through its fingerprint.
     */
    suspend fun reveal(route: CalendarRoute): CalGroup? {
        route.day?.let { anchor = it }
        reloadNow()
        val raw = route.rawEventId ?: return null
        fun find(list: List<CalEvent>) = list.firstOrNull { it.rawEventId == raw || it.rawEventId.endsWith(raw) }
        var found = find(events)
        if (found == null) {
            val now = Instant.now()
            isLoading = true
            val window = try {
                eventsIn(now.minusSeconds(7 * 86_400L), now.plusSeconds(38 * 86_400L))
            } catch (e: CancellationException) {
                throw e
            } catch (_: StarlingsApiError) {
                emptyList()
            } finally {
                isLoading = false
            }
            found = find(CalendarMerge.displayed(window)) ?: return null
            anchor = CalendarDates.day(found.start, zone)
            reloadNow()
        }
        val key = CalendarMerge.fingerprint(found, zone)
        return groupsOn(CalendarDates.day(found.start, zone)).firstOrNull { CalendarMerge.fingerprint(it.event, zone) == key }
    }

    /** Google and feed events in a range, against the calendars already listed. Not published. */
    private suspend fun eventsIn(from: Instant, to: Instant): List<CalEvent> = coroutineScope {
        val client = account.client
        val listed = calendars
        val subscribed = listed.any { it.source == CalSource.SUBSCRIPTION }
        val google = async { if (googleConnected != true) emptyList() else client.call(CalendarRoutes.events(from, to)).events }
        val feeds = async {
            if (!subscribed) emptyList()
            else runCatching { client.call(CalendarRoutes.subscriptionEvents(from, to)).events }.getOrDefault(emptyList())
        }
        val demoted = preferences?.demotedEventKeys.orEmpty().toSet()
        val hidden = preferences?.hiddenCalendarKeys.orEmpty()
        val hiddenIds = listed.filter { it.isIn(hidden) }.map { it.id }.toSet()
        (google.await().mapNotNull { CalEvent.google(it, listed, ownHosts, zone) } +
            feeds.await().mapNotNull { CalEvent.subscription(it, listed, demoted, ownHosts, zone) } +
            deviceEvents(from, to, listed, demoted))
            .filter { it.calendarId !in hiddenIds }
    }

    private suspend fun load(force: Boolean) {
        val (from, to) = loadedRange()
        val key = "$from|$to"
        held[key]?.let { publish(it) }
        heldLayers[key]?.let { layerItems = it }
        if (force || held[key] == null) isLoading = true
        val client = account.client
        try {
            coroutineScope {
                // Unrelated to the events, and never a reason to fail the calendar.
                val layers = async { fetchLayers(from, to) }
                val status = async { client.call(CalendarRoutes.status) }
                val prefs = async { runCatching { client.call(CalendarRoutes.preferences) }.getOrNull() }
                val subs = async {
                    try {
                        client.call(CalendarExtraRoutes.subscriptions).subscriptions.also { subscriptionError = null }
                    } catch (e: StarlingsApiError) {
                        subscriptionError = e.sentence
                        null
                    }
                }
                if (room == null) launch { room = runCatching { client.call(SettingsRoutes.ownerRoom).room }.getOrNull() }
                if (!zonesRead) launch {
                    zoneShortlist = CalendarWorkspaceZones.refresh(context, defaults)
                    zonesRead = true
                }
                val connected = status.await().connected
                googleConnected = connected
                preferences = prefs.await() ?: preferences
                adoptIncludesLocal()
                val google = if (!connected) emptyList() else googleCalendars(force)
                val subscribed = subs.await()?.let { CalCalendar.subscriptions(it, SUBSCRIBED) }
                    ?: calendars.filter { it.source == CalSource.SUBSCRIPTION }
                deviceAccess = readDeviceAccess()
                val local = if (includesLocalCalendars && deviceAccess == DeviceCalendars.Access.GRANTED) device.calendars() else emptyList()
                applyLocalDefaults(local)
                allCalendars = google + subscribed + local
                val listed = allCalendars.filter(::isIncluded)
                calendars = listed

                val googleEvents = async {
                    if (!connected) emptyList() else client.call(CalendarRoutes.events(from, to)).events
                }
                val feedEvents = async {
                    if (subscribed.isEmpty()) emptyList()
                    else runCatching { client.call(CalendarRoutes.subscriptionEvents(from, to)).events }.getOrDefault(emptyList())
                }
                val demoted = preferences?.demotedEventKeys.orEmpty().toSet()
                val built = googleEvents.await().mapNotNull { CalEvent.google(it, listed, ownHosts, zone) } +
                    feedEvents.await().mapNotNull { CalEvent.subscription(it, listed, demoted, ownHosts, zone) } +
                    deviceEvents(from, to, listed, demoted)
                held[key] = built
                publish(built)
                val fetched = layers.await()
                heldLayers[key] = fetched
                layerItems = fetched
            }
            loadFailure = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: StarlingsApiError) {
            // The weeks on screen drew from what was held; this says the refresh did not land.
            loadFailure = e.sentence
        } finally {
            isLoading = false
        }
        refreshWeather()
    }

    /** The calendar list barely changes: read again after ten minutes, or when asked. */
    private suspend fun googleCalendars(force: Boolean): List<CalCalendar> {
        val now = System.currentTimeMillis()
        val cached = calendars.filter { it.source == CalSource.GOOGLE }
        if (!force && cached.isNotEmpty() && now - calendarListAt < LIST_TTL_MS) return cached
        val client = account.client
        return coroutineScope {
            val entries = async { client.call(CalendarExtraRoutes.calendars).calendars }
            val accounts = async { runCatching { client.call(CalendarExtraRoutes.accounts).accounts }.getOrNull() }
            val known = accounts.await()?.also { googleAccounts = it } ?: googleAccounts
            val listed = CalCalendar.google(entries.await(), namesAccounts = known.size > 1)
            calendarListAt = now
            listed
        }
    }

    private fun publish(all: List<CalEvent>) {
        val hidden = preferences?.hiddenCalendarKeys.orEmpty()
        val hiddenIds = calendars.filter { it.isIn(hidden) }.map { it.id }.toSet()
        events = CalendarMerge.displayed(all.filter { it.calendarId !in hiddenIds }, display.showsDeclined, display.showsHidden)
    }

    /**
     * `fetchedLayers`: none can fail the calendar. The Worker answers work
     * items and availability empty when Core is down, and a published-events
     * outage is no reason to stop showing the week, so all are swallowed.
     */
    private suspend fun fetchLayers(from: Instant, to: Instant): List<CalendarLayerItem> = coroutineScope {
        val client = account.client
        val hidden = hiddenLayers
        val firstDay = CalendarDates.day(from.toEpochMilli(), zone)
        val lastDay = CalendarDates.day(to.toEpochMilli(), zone)
        val published = async {
            if (CalendarLayerKind.EVENTS in hidden) emptyList()
            else runCatching { client.call(HomeExtraRoutes.publicEvents(LocalDate.now())).events }.getOrDefault(emptyList())
                .mapNotNull { CalendarLayers.publicEvent(it, zone) }
        }
        val work = async {
            if (CalendarLayerKind.MILESTONES in hidden && CalendarLayerKind.TASKS in hidden) emptyList()
            else runCatching { client.call(CalendarRoutes.workItems(firstDay, lastDay, includeDone = false)).items }.getOrDefault(emptyList())
                .mapNotNull { CalendarLayers.workItem(it, zone) }
        }
        val open = async {
            if (CalendarLayerKind.AVAILABILITY in hidden) emptyList()
            else runCatching { client.call(CalendarRoutes.availability(firstDay, lastDay)).blocks }.getOrDefault(emptyList())
                .mapNotNull { CalendarLayers.availability(it, zone) }
        }
        CalendarLayers.inRange(published.await() + work.await() + open.await(), from.toEpochMilli(), to.toEpochMilli())
            .sortedBy { it.start }
    }

    fun isHidden(layer: CalendarLayerKind): Boolean = layer in hiddenLayers

    /** A layer turned back on is read again: a hidden kind is never fetched. */
    fun setHidden(layer: CalendarLayerKind, hidden: Boolean) {
        hiddenLayers = if (hidden) hiddenLayers + layer else hiddenLayers - layer
        defaults.edit().putStringSet(LAYERS_KEY, hiddenLayers.map { it.wire }.toSet()).apply()
        if (!hidden) {
            heldLayers.clear()
            reload()
        }
    }

    // Sources: owner-wide, through `CalendarKeys`

    /** `CalendarSourceGroup.ordered`: Google, the other accounts, the phone's own, then the feeds. */
    val sourceGroups: List<Pair<String, List<CalCalendar>>>
        get() = DeviceCalendarRules.orderedGroups(allCalendars)

    private val hiddenKeys: List<String> get() = preferences?.hiddenCalendarKeys.orEmpty()
    private val disabledKeys: List<String> get() = preferences?.disabledCalendarKeys.orEmpty()

    fun isHidden(calendar: CalCalendar): Boolean = calendar.isIn(hiddenKeys)
    fun isDisabled(calendar: CalCalendar): Boolean = calendar.isIn(disabledKeys)

    /** `isAccountDisabled`: the account's key, or every calendar in it. */
    fun isAccountDisabled(group: String): Boolean {
        val members = allCalendars.filter { it.groupTitle == group }
        if (members.firstOrNull()?.accountKey in disabledKeys) return true
        return members.isNotEmpty() && members.all(::isDisabled)
    }

    /** `isAccountHidden`: the account's key, or every calendar in it hidden. */
    fun isAccountHidden(group: String): Boolean {
        val members = allCalendars.filter { it.groupTitle == group }
        if (members.firstOrNull()?.accountKey in hiddenKeys) return true
        return members.isNotEmpty() && members.all(::isHidden)
    }

    /** Show all or Hide all, for a device account. */
    fun setAccountHidden(group: String, hidden: Boolean) {
        val members = allCalendars.filter { it.groupTitle == group }
        val key = members.firstOrNull()?.accountKey ?: return
        saveKeys(hidden = CalendarKeys.withAccountHidden(hiddenKeys, key, members.map { it.visibilityKey }, hidden))
    }

    fun setHidden(calendar: CalCalendar, hidden: Boolean) {
        val siblings = allCalendars.filter { it.groupTitle == calendar.groupTitle }.map { it.visibilityKey }
        saveKeys(hidden = CalendarKeys.withCalendarHidden(hiddenKeys, calendar.visibilityKey, calendar.accountKey, siblings, hidden))
    }

    fun setDisabled(calendar: CalCalendar, disabled: Boolean) {
        val siblings = allCalendars.filter { it.groupTitle == calendar.groupTitle }.map { it.visibilityKey }
        saveKeys(disabled = CalendarKeys.withCalendarHidden(disabledKeys, calendar.visibilityKey, calendar.accountKey, siblings, disabled))
    }

    fun setAccountDisabled(group: String, disabled: Boolean) {
        val members = allCalendars.filter { it.groupTitle == group }
        val key = members.firstOrNull()?.accountKey ?: return
        saveKeys(disabled = CalendarKeys.withAccountHidden(disabledKeys, key, members.map { it.visibilityKey }, disabled))
    }

    /** The choice shows at once; the Worker's answer replaces it, and a failure says so in the alert. */
    private fun saveKeys(hidden: List<String>? = null, disabled: List<String>? = null) {
        preferences = preferences?.copy(
            hiddenCalendarKeys = hidden ?: hiddenKeys,
            disabledCalendarKeys = disabled ?: disabledKeys,
        )
        calendars = allCalendars.filter(::isIncluded)
        held.clear()
        scope.launch {
            perform {
                preferences = account.client.call(
                    CalendarRoutes.savePreferences(CalendarPreferencesUpdate(hiddenCalendarKeys = hidden, disabledCalendarKeys = disabled)),
                )
            }
        }
    }

    // The phone's own calendars

    /** `isIncluded`: in Starlings, and a device calendar only while local calendars are included. */
    private fun isIncluded(calendar: CalCalendar): Boolean =
        !calendar.isIn(disabledKeys) && (calendar.source != CalSource.DEVICE || includesLocalCalendars)

    /** Access is read, never asked for here: the prompt is the screen's ([rememberDeviceCalendarAccess]). */
    private fun readDeviceAccess(): DeviceCalendars.Access = when {
        device.granted -> DeviceCalendars.Access.GRANTED
        defaults.getBoolean(DEVICE_ASKED_KEY, false) -> DeviceCalendars.Access.DENIED
        else -> DeviceCalendars.Access.UNKNOWN
    }

    /** The prompt a screen showed has been answered, whichever way. */
    fun noteDeviceAccessAnswered() {
        defaults.edit().putBoolean(DEVICE_ASKED_KEY, true).putBoolean(DEVICE_WRITE_ASKED_KEY, true).apply()
        deviceWriteAsked = true
        deviceAccess = readDeviceAccess()
        held.clear()
        reload(force = true)
    }

    /**
     * Whether a screen should put the system prompt up now: included, and
     * never asked. iOS asks EventKit for full access, read and write in one
     * question; Android asks `READ_CALENDAR` and `WRITE_CALENDAR` together,
     * one system dialog. A read granted before writes existed asks once more.
     */
    val needsDeviceAccessPrompt: Boolean
        get() = includesLocalCalendars && (
            deviceAccess == DeviceCalendars.Access.UNKNOWN ||
                (deviceAccess == DeviceCalendars.Access.GRANTED && !deviceWriteAsked && !device.writeGranted)
            )

    /**
     * `setIncludesLocalCalendars`: one owner-wide decision before the
     * per-calendar ones, so the Mac, the iPhone and Android agree. Fire and
     * forget, as iOS: the local copy already answers every read.
     */
    fun includeLocalCalendars(included: Boolean) {
        if (included == includesLocalCalendars) return
        includesLocalCalendars = included
        defaults.edit().putBoolean(INCLUDES_LOCAL_KEY, included).apply()
        calendars = allCalendars.filter(::isIncluded)
        preferences = preferences?.copy(includesLocalCalendars = included)
        scope.launch {
            runCatching { account.client.call(CalendarRoutes.savePreferences(CalendarPreferencesUpdate(includesLocalCalendars = included))) }
        }
        held.clear()
        reload(force = true)
    }

    /** The Worker's answer wins over the cached switch (`adoptRemotePreferences`). */
    private fun adoptIncludesLocal() {
        val remote = preferences?.includesLocalCalendars ?: return
        if (remote != includesLocalCalendars) {
            includesLocalCalendars = remote
            defaults.edit().putBoolean(INCLUDES_LOCAL_KEY, remote).apply()
        }
    }

    /**
     * `applyLocalDefaults`: the first device list is adopted whole; a
     * calendar that turns up later starts out of Starlings until enabled
     * ("New calendars stay hidden until enabled here.").
     */
    private fun applyLocalDefaults(local: List<CalCalendar>) {
        val seen = defaults.getStringSet(SEEN_LOCAL_KEY, null)?.toSet()
        val (next, fresh) = DeviceCalendarRules.adoptLocal(seen, local.map { it.visibilityKey }.toSet())
        if (next != null && next != seen) defaults.edit().putStringSet(SEEN_LOCAL_KEY, next).apply()
        if (fresh.isEmpty()) return
        val merged = (disabledKeys + fresh).distinct().sorted()
        preferences = preferences?.copy(disabledCalendarKeys = merged)
        scope.launch {
            runCatching { account.client.call(CalendarRoutes.savePreferences(CalendarPreferencesUpdate(disabledCalendarKeys = merged))) }
        }
    }

    /** EventKit is a local database: read fresh every time, never held. */
    private suspend fun deviceEvents(from: Instant, to: Instant, listed: List<CalCalendar>, demoted: Set<String>): List<CalEvent> {
        val local = listed.filter { it.source == CalSource.DEVICE }
        if (local.isEmpty()) return emptyList()
        return device.events(from.toEpochMilli(), to.toEpochMilli(), local, ownHosts, zone)
            .map { it.copy(demoted = it.demotionKey in demoted) }
    }

    // Weather

    /** `refreshWeather`: apart from the calendar; a stale or failed read keeps its reason. */
    fun refreshWeather() {
        weatherJob?.cancel()
        showsWeather = WeatherPreferences.showsWeather(defaults.all)
        weatherPlace = WeatherPreferences.place(defaults.all)
        val place = WeatherPreferences.activePlace(defaults.all)
        if (place == null) {
            weather = emptyMap()
            weatherFailure = null
            return
        }
        weatherJob = scope.launch {
            val outcome = WeatherForecasts.forecast(place, zone.id, temperatureUnit())
            if (WeatherPreferences.activePlace(defaults.all) != place) return@launch
            weather = outcome.days
            weatherFailure = outcome.failure
        }
    }

    fun showWeather(on: Boolean) {
        defaults.edit().putBoolean(WeatherPreferences.KEY_SHOWS, on).apply()
        refreshWeather()
    }

    fun chooseWeatherPlace(place: WeatherPlace?) {
        defaults.edit().apply {
            if (place == null) remove(WeatherPreferences.KEY_PLACE) else putString(WeatherPreferences.KEY_PLACE, WeatherPreferences.encode(place))
        }.apply()
        refreshWeather()
    }

    /** Fahrenheit only where the locale uses it; Open-Meteo converts. */
    private fun temperatureUnit(): String =
        if (android.icu.util.LocaleData.getMeasurementSystem(android.icu.util.ULocale.getDefault()) == android.icu.util.LocaleData.MeasurementSystem.US) {
            "fahrenheit"
        } else {
            "celsius"
        }

    // Upcoming

    /** Subscribed feeds in Starlings, which Show in Upcoming can keep out of Upcoming. */
    val upcomingSubscriptions: List<CalCalendar> get() = calendars.filter { it.source == CalSource.SUBSCRIPTION }

    val upcomingExcludedSubscriptionIds: Set<String> get() = preferences?.upcomingExcludedSubscriptionIds.orEmpty().toSet()

    /** The Google calendars Show in Upcoming offers: only those in Starlings. Null when the read failed. */
    suspend fun upcomingGoogleEntries(): List<GoogleCalendarListEntry>? {
        if (googleConnected != true) return emptyList()
        val enabled = calendars.filter { it.source == CalSource.GOOGLE }.map { it.rawId }.toSet()
        return try {
            account.client.call(CalendarExtraRoutes.calendars).calendars.filter { it.id in enabled }
        } catch (e: CancellationException) {
            throw e
        } catch (e: StarlingsApiError) {
            errorMessage = e.sentence
            null
        }
    }

    /** `setGoogleCalendarSelection` then `setUpcomingExcludedSubscriptionIDs`: one write each. */
    suspend fun saveUpcoming(selected: List<String>?, excluded: Set<String>): Boolean = perform {
        if (selected != null) {
            account.client.call(CalendarRoutes.savePreferences(CalendarPreferencesUpdate(selectedCalendarIds = selected)))
            calendarListAt = 0L
        }
        preferences = account.client.call(
            CalendarRoutes.savePreferences(CalendarPreferencesUpdate(upcomingExcludedSubscriptionIds = excluded.sorted())),
        )
    }

    /** Where new events land. Never the shared company calendar by default. */
    fun setDefaultWriteCalendar(calendar: CalCalendar) {
        if (!calendar.canBeWriteTarget) return
        defaults.edit().putString(WRITE_KEY, calendar.id).apply()
        writeChoice = calendar.id
    }

    /** `removableAccounts`: each extra Google account by its address, the group title it lists under. */
    val removableAccounts: Map<String, String>
        get() = googleAccounts.filter { !it.primary }.associate { it.email to it.id }

    /**
     * `subscribe(to:)`: the Worker checks the address, since it is the side
     * that fetches it. The calendar list is read again, then a toast says so.
     */
    suspend fun subscribe(url: String): Boolean {
        val address = url.trim()
        if (address.isEmpty()) return false
        var title = ""
        val ok = perform {
            title = account.client.call(CalendarExtraRoutes.addSubscription(CalendarSubscriptionCreateRequest(url = address))).subscription.title
        }
        if (ok) notice(context.getString(R.string.cal_subscribed_to, title))
        return ok
    }

    suspend fun unsubscribe(calendar: CalCalendar): Boolean {
        val ok = perform { account.client.call(CalendarExtraRoutes.removeSubscription(calendar.rawId)) }
        if (ok) notice(context.getString(R.string.cal_unsubscribed_from, calendar.title))
        return ok
    }

    /** `removeGoogleAccount`: the calendar list is per account, so it is read again. */
    suspend fun removeAccount(id: String): Boolean {
        val email = googleAccounts.firstOrNull { it.id == id }?.email ?: context.getString(R.string.cal_that_account)
        val ok = perform {
            account.client.call(CalendarExtraRoutes.removeAccount(id))
            googleAccounts = googleAccounts.filter { it.id != id }
            calendarListAt = 0L
        }
        if (ok) notice(context.getString(R.string.cal_removed_named, email))
        return ok
    }

    /**
     * `noteGoogleConnected`: the exchange said Google is connected, so the
     * sources read as connected before the next status read lands.
     */
    fun noteGoogleConnected() {
        googleConnected = true
        calendarListAt = 0L
        held.clear()
        reload(force = true)
    }

    /** `noteGoogleAccountAdded`: the new account lists at once; its calendars come with the reload. */
    fun noteGoogleAccountAdded(added: CalendarAccount) {
        googleAccounts = googleAccounts.filter { it.id != added.id } + added
        calendarListAt = 0L
        held.clear()
        reload(force = true)
    }

    /** A confirmation is a toast, so it cannot sit there looking like state. */
    private fun notice(message: String) = toast(message)

    /**
     * `noticeInvites(count:isNew:moved:)`: a toast after a save with guests.
     * Google only: the phone's own calendars take no guests (EventKit writes
     * none), so nothing was sent.
     */
    fun noticeInvites(count: Int, isNew: Boolean, moved: Boolean, calendarId: String) {
        if (count <= 0 || calendar(calendarId)?.source != CalSource.GOOGLE) return
        val verb = context.getString(if (isNew) R.string.cal_invites_sent else if (moved) R.string.cal_updates_sent else R.string.cal_invites_updated)
        notice(context.resources.getQuantityString(R.plurals.cal_invite_notice, count, verb, count))
    }

    // Reads for the screens

    fun layersOn(day: LocalDate): List<CalendarLayerItem> = CalendarLayers.on(day, visibleLayers, zone)

    fun groupsOn(day: LocalDate): List<CalGroup> = CalendarMerge.groupsOn(day, events, zone)

    /** By day, empty days left out; a day carrying only a milestone is not empty. */
    fun agenda(days: List<LocalDate>): List<CalendarMerge.DaySection> =
        days.map { CalendarMerge.DaySection(it, groupsOn(it)) }.filter { it.groups.isNotEmpty() || layersOn(it.day).isNotEmpty() }

    fun color(calendarId: String): Long =
        calendars.firstOrNull { it.id == calendarId }?.displayColor ?: work.starlings.android.CalendarColors.fallback(0)

    /** A calendar row standing in for a published event carries the Events swatch too. */
    fun colors(group: CalGroup): List<Long> {
        val own = group.calendarIds.map(::color)
        return if (group.event.id in mirror.publishedEventIds) own + CalendarLayerKind.EVENTS.color else own
    }

    fun calendarTitle(calendarId: String): String = calendars.firstOrNull { it.id == calendarId }?.title.orEmpty()

    fun calendar(calendarId: String): CalCalendar? = calendars.firstOrNull { it.id == calendarId }

    /** `writableCalendars`: Google and the phone's own calendars; subscribed feeds are read-only. */
    val writableCalendars: List<CalCalendar> get() = calendars.filter { it.writable }

    /** Where a new event lands: the last calendar written to, never the shared company one by default. */
    val defaultWriteCalendar: CalCalendar?
        get() {
            val last = writeChoice
            return writableCalendars.firstOrNull { it.id == last && it.canBeWriteTarget }
                ?: writableCalendars.firstOrNull { it.canBeWriteTarget }
        }

    fun moveTargets(event: CalEvent): List<CalCalendar> =
        if (!event.canMoveBetweenCalendars) emptyList()
        else writableCalendars.filter { it.id != event.calendarId && it.canBeMoveTarget }

    /** An existing event's choices: its own calendar, plus where it may move. */
    fun calendarChoices(event: CalEvent): List<CalCalendar> {
        val targets = moveTargets(event).map { it.id }.toSet()
        return calendars.filter { it.id == event.calendarId || it.id in targets }
    }

    // Writing

    /** What Schedule a meeting's strip shows: your events and the published ones, from today. */
    suspend fun scheduleAgenda(days: Int): Pair<List<CalEvent>, List<CalendarLayerItem>> = coroutineScope {
        val today = LocalDate.now()
        val from = Instant.ofEpochMilli(CalendarDates.startOfDay(today, zone))
        val to = Instant.ofEpochMilli(CalendarDates.startOfDay(today.plusDays(days.toLong()), zone))
        val own = async { runCatching { CalendarMerge.displayed(eventsIn(from, to)) }.getOrDefault(emptyList()) }
        val published = async {
            runCatching { account.client.call(HomeExtraRoutes.publicEvents(today)).events }.getOrDefault(emptyList())
                .mapNotNull { CalendarLayers.publicEvent(it, zone) }
        }
        own.await() to published.await()
    }

    /**
     * `createEvent(draft:room:)`: a meeting in the owner's room, its link as
     * the join link, the guests invited, in the zone picked.
     */
    suspend fun schedule(title: String, start: Long, end: Long, guests: List<String>, timeZone: String): Boolean {
        val slug = room?.slug ?: return false
        return perform {
            account.client.call(
                CalendarRoutes.createEvent(
                    CalendarEventCreateRequest(
                        title = title.trim(),
                        start = iso(start),
                        end = iso(end),
                        joinUrl = roomLink(slug),
                        roomSlug = slug,
                        attendees = guests,
                        timeZone = timeZone,
                    ),
                ),
            )
        }
    }

    /** Quick add: the sentence read on the Worker, the grammar first. Null when it did not answer. */
    suspend fun quickAdd(sentence: String): QuickAddPrefill? = try {
        val answer = account.client.call(
            CalendarExtraRoutes.quickAdd(
                CalendarQuickAddRequest(
                    sentence = sentence,
                    now = QuickAddPrefill.WALL.format(java.time.LocalDateTime.now(zone)),
                    timeZone = zone.id,
                    defaultDurationMinutes = display.durationMinutes.toLong(),
                    allowModel = true,
                ),
            ),
        )
        QuickAddPrefill.of(answer.draft, answer.source == CalendarQuickAddResponseSource.MODEL, zone, display.durationMinutes)
    } catch (e: CancellationException) {
        throw e
    } catch (e: StarlingsApiError) {
        errorMessage = e.sentence
        null
    }

    /** Owner-wide Hide from Next, written to the Worker so the owner's other devices follow. */
    suspend fun setDemoted(event: CalEvent, demoted: Boolean): Boolean {
        val keys = preferences?.demotedEventKeys.orEmpty().toMutableSet()
        if (demoted) keys += event.demotionKey else keys -= event.demotionKey
        return perform {
            preferences = account.client.call(CalendarRoutes.savePreferences(CalendarPreferencesUpdate(demotedEventKeys = keys.sorted())))
        }
    }

    /** One day of the guests' busy time. Empty when Google is not connected or the read fails. */
    suspend fun freeBusy(emails: List<String>, day: LocalDate): List<CalendarFreeBusyPerson> {
        if (googleConnected != true || emails.isEmpty()) return emptyList()
        val from = Instant.ofEpochMilli(CalendarDates.startOfDay(day, zone))
        val to = Instant.ofEpochMilli(CalendarDates.startOfDay(day.plusDays(1), zone))
        return try {
            account.client.call(CalendarExtraRoutes.freeBusy(CalendarFreeBusyRequest(iso(from.toEpochMilli()), iso(to.toEpochMilli()), emails))).people
        } catch (e: CancellationException) {
            throw e
        } catch (_: StarlingsApiError) {
            emptyList()
        }
    }

    /**
     * Who Add invitee completes from: the roster's people (it knows names).
     * Device contacts need the contacts permission, which this app does not ask for.
     */
    suspend fun inviteeSuggestions(): List<CalendarAvailability.Suggestion> = try {
        account.client.call(TeamRoutes.peers).peers
            .filter { it.kind == PeerKindValue.HUMAN && it.email.isNotEmpty() }
            .map { CalendarAvailability.Suggestion(it.email.lowercase(), it.name?.ifEmpty { null } ?: it.email) }
            .distinctBy { it.email }
    } catch (e: CancellationException) {
        throw e
    } catch (_: StarlingsApiError) {
        emptyList()
    }

    /** Projects, leads or partners to file under. Empty on any failure: the picker says nothing matched. */
    suspend fun searchSubjects(kind: CrmSubjectKind, query: String): List<CrmSubjectWire> =
        try {
            account.client.call(WorkRoutes.subjects(kind, query, null)).subjects.filter { it.kind == kind }
        } catch (e: CancellationException) {
            throw e
        } catch (_: StarlingsApiError) {
            emptyList()
        }

    /**
     * The contacts that hold any of [emails] (`GET /api/crm/contacts?emails=`,
     * at most [CalendarAttendeeContacts.MAX_EMAILS]). Best effort: any failure
     * answers an empty list, and the guest rows stay as they are.
     */
    suspend fun attendeeContacts(emails: List<String>): List<CrmContact> {
        if (emails.isEmpty()) return emptyList()
        return try {
            account.client.call(WorkExtraRoutes.contactList(CrmContactsQuery(emails = emails.joinToString(","), limit = 200))).contacts
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyList()
        }
    }

    /**
     * File the event under a subject, or unfile it: owner-wide, written to
     * the `event_subjects` preference under the event's demotion key. The
     * rows on screen change at once and go back if the write fails.
     */
    suspend fun setSubject(event: CalEvent, subject: CalendarEventSubject?): Boolean {
        val key = event.demotionKey
        val before = events
        fun relabel(list: List<CalEvent>) = list.map { if (it.demotionKey == key) it.copy(subject = subject) else it }
        events = relabel(events)
        held.replaceAll { _, list -> relabel(list) }
        val map = CalendarFiling.withSubject(preferences?.eventSubjects.orEmpty(), key, subject)
        val ok = perform {
            preferences = account.client.call(CalendarRoutes.savePreferences(CalendarPreferencesUpdate(eventSubjects = map)))
        }
        if (!ok) events = before
        return ok
    }

    suspend fun respond(event: CalEvent, reply: Rsvp): Boolean {
        val answer = reply.reply ?: return false
        return perform {
            account.client.call(CalendarRoutes.respond(CalendarEventRespondRequest(event.googleCalendarId, event.rawEventId, answer)))
        }
    }

    /**
     * `mintedMeetLink`: an event in a Starlings room carries a booking link,
     * minted for its slot. No room, and the link stays as it is.
     */
    private suspend fun mintedLink(draft: CalendarDraft): String? {
        val slug = draft.roomSlug?.ifEmpty { null } ?: draft.joinUrl?.let(MeetingPlatforms::roomSlug) ?: return draft.joinUrl
        return account.client.call(
            CalendarExtraRoutes.mintBooking(
                CalendarBookingMintRequest(title = draft.title, start = iso(draft.start), end = iso(draft.end), roomSlug = slug, joinUrl = draft.joinUrl),
            ),
        ).joinUrl
    }

    suspend fun create(draft: CalendarDraft): Boolean {
        val calendar = calendars.firstOrNull { it.id == draft.calendarId } ?: return false
        if (calendar.canBeWriteTarget) {
            defaults.edit().putString(WRITE_KEY, calendar.id).apply()
            writeChoice = calendar.id
        }
        return perform {
            val link = mintedLink(draft)
            if (calendar.source == CalSource.DEVICE) {
                // EventKit takes no guests and no travel time: iOS writes neither.
                device.create(calendar.rawId, deviceValues(draft.title, draft.start, draft.end, draft.allDay, draft.location, link, draft.notes.ifEmpty { null }), zone)
                return@perform
            }
            account.client.call(
                CalendarRoutes.createEvent(
                    CalendarEventCreateRequest(
                        title = draft.title,
                        start = iso(draft.start),
                        end = iso(draft.end),
                        joinUrl = link,
                        roomSlug = draft.roomSlug,
                        calendarId = calendar.rawId,
                        attendees = draft.attendees,
                        description = draft.notes.ifEmpty { null },
                        location = draft.location.ifEmpty { null },
                        timeZone = zone.id,
                        travelTimeMinutes = Patch.ifSome(draft.travelTimeMinutes.takeIf { it > 0 }?.toLong()),
                    ),
                ),
            )
        }
    }

    suspend fun update(event: CalEvent, draft: CalendarDraft, wholeSeries: Boolean): Boolean = perform {
        val travel = if (draft.travelTimeMinutes != (event.travelTimeMinutes ?: 0)) draft.travelTimeMinutes.toLong() else null
        val link = mintedLink(draft)
        if (event.source == CalSource.DEVICE) {
            device.update(event, deviceValues(draft.title, draft.start, draft.end, draft.allDay, draft.location, link, draft.notes), wholeSeries, zone)
            return@perform
        }
        account.client.call(
            CalendarRoutes.patchEvent(
                CalendarEventPatchRequest(
                    calendarId = event.googleCalendarId,
                    eventId = event.googleTarget(wholeSeries),
                    title = draft.title,
                    start = iso(draft.start),
                    end = iso(draft.end),
                    // Null, not an echo: a reschedule must not rewrite the guest list.
                    attendees = if (draft.attendeesChanged) draft.attendees else null,
                    description = draft.notes,
                    location = draft.location,
                    timeZone = zone.id,
                    joinUrl = link,
                    roomSlug = draft.roomSlug,
                    travelTimeMinutes = Patch.ifSome(travel),
                ),
            ),
        )
    }

    /**
     * The long-press move: the block lands at once, the write follows, and a
     * failed write puts it back rather than leave the grid lying about it.
     * The guest list is left alone (null, not an echo).
     */
    suspend fun reschedule(event: CalEvent, start: Long, end: Long): Boolean {
        val before = events
        events = events.map { if (it.id == event.id) it.copy(start = start, end = end) else it }.sortedBy { it.start }
        val ok = perform {
            if (event.source == CalSource.DEVICE) {
                device.update(event, deviceValues(event.title, start, end, event.allDay, event.location, event.joinUrl, event.notes), wholeSeries = false, zone = zone)
                return@perform
            }
            account.client.call(
                CalendarRoutes.patchEvent(
                    CalendarEventPatchRequest(
                        calendarId = event.googleCalendarId,
                        eventId = event.rawEventId,
                        title = event.title,
                        start = iso(start),
                        end = iso(end),
                        description = event.notes,
                        location = event.location,
                        timeZone = zone.id,
                        joinUrl = event.joinUrl.ifEmpty { null },
                        roomSlug = event.roomSlug.ifEmpty { null },
                    ),
                ),
            )
        }
        if (!ok) events = before
        return ok
    }

    suspend fun delete(event: CalEvent, wholeSeries: Boolean): Boolean = perform { remove(event, wholeSeries) }

    private suspend fun remove(event: CalEvent, wholeSeries: Boolean) {
        when (event.source) {
            CalSource.DEVICE -> device.delete(event, wholeSeries, zone)
            else -> account.client.call(CalendarRoutes.deleteEvent(CalendarEventDeleteRequest(event.googleCalendarId, event.googleTarget(wholeSeries))))
        }
    }

    /**
     * `move(_:to:)`. Within one Google account, or between the phone's own
     * calendars, the event keeps its identity. Across Google accounts and
     * across sources nothing is shared, so it is copied with its guests and
     * the original deleted, as iOS does.
     */
    suspend fun move(event: CalEvent, to: CalCalendar): Boolean = perform {
        if (!to.writable || !to.canBeMoveTarget || !event.canMoveBetweenCalendars) throw DeviceCalendars.WriteError(MOVE)
        val from = calendar(event.calendarId)
        when {
            event.source == CalSource.GOOGLE && to.source == CalSource.GOOGLE && from?.groupTitle == to.groupTitle ->
                account.client.call(CalendarExtraRoutes.moveEvent(CalendarEventMoveRequest(event.googleCalendarId, event.rawEventId, to.rawId)))
            event.source == CalSource.DEVICE && to.source == CalSource.DEVICE -> device.move(event, to.rawId)
            else -> {
                copy(event, to, carryingAttendees = true)
                remove(event, wholeSeries = false)
            }
        }
    }

    /** `duplicate(_:to:)`: a structural copy, not a re-invite: no guests travel with it. */
    suspend fun duplicate(event: CalEvent, to: CalCalendar): Boolean = perform { copy(event, to, carryingAttendees = false) }

    /** `copy(_:to:carryingAttendees:)`: a move carries the guests, a duplicate does not. */
    private suspend fun copy(event: CalEvent, to: CalCalendar, carryingAttendees: Boolean) {
        if (to.source == CalSource.DEVICE) {
            device.create(
                to.rawId,
                DeviceCalendarWrites.Values(
                    title = event.title,
                    start = event.start,
                    end = event.end,
                    allDay = event.allDay,
                    location = event.location.ifEmpty { event.joinUrl },
                    notes = event.notes.ifEmpty { null },
                ),
                zone,
            )
            return
        }
        account.client.call(
            CalendarRoutes.createEvent(
                CalendarEventCreateRequest(
                    title = event.title,
                    start = iso(event.start),
                    end = iso(event.end),
                    joinUrl = event.joinUrl.ifEmpty { null },
                    roomSlug = event.roomSlug.ifEmpty { null },
                    calendarId = to.rawId,
                    attendees = if (carryingAttendees) event.attendeeEmails else emptyList(),
                    description = event.notes.ifEmpty { null },
                    location = event.location.ifEmpty { null },
                    timeZone = zone.id,
                    // A copy keeps the way there.
                    travelTimeMinutes = Patch.ifSome(event.travelTimeMinutes?.toLong()),
                ),
            ),
        )
    }

    /** What EventKit is handed: the place, or the link where no place was typed. */
    private fun deviceValues(title: String, start: Long, end: Long, allDay: Boolean, location: String?, link: String?, notes: String?) =
        DeviceCalendarWrites.Values(title, start, end, allDay, DeviceCalendarWrites.storedLocation(location, link), notes)

    private suspend fun perform(work: suspend () -> Unit): Boolean {
        try {
            work()
        } catch (e: CancellationException) {
            throw e
        } catch (e: StarlingsApiError) {
            errorMessage = e.sentence
            return false
        } catch (e: DeviceCalendars.WriteError) {
            errorMessage = e.operation
            return false
        }
        held.clear()
        reload(force = true)
        return true
    }

    private fun iso(ms: Long): String = ISO.format(Instant.ofEpochMilli(ms))

    companion object {
        private const val MODE_KEY = "meet.calendar.mobileMode"
        private const val WRITE_KEY = "meet.calendar.writeCalendarID"
        private const val LAYERS_KEY = "meet.calendar.hiddenLayers"
        private const val INCLUDES_LOCAL_KEY = "meet.calendar.includesLocalCalendars"
        private const val SEEN_LOCAL_KEY = "meet.calendar.seenLocalKeys"
        /** Android cannot tell "never asked" from "denied" without remembering it asked. */
        private const val DEVICE_ASKED_KEY = "meet.calendar.deviceAccessAsked"
        /** Asked for `WRITE_CALENDAR` too. A read granted before writes existed asks once more. */
        private const val DEVICE_WRITE_ASKED_KEY = "meet.calendar.deviceWriteAsked"
        /** The move alert's title when the target cannot take it (`calendar.readOnly`). */
        private const val MOVE = "That calendar is read-only"
        private const val LIST_TTL_MS = 10 * 60_000L
        /** `StarlingsCalendar.subscriptionGroupTitle`: a stored group identity, displayed as is. */
        const val SUBSCRIBED = "Subscribed"
        private val ISO = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSSX").withZone(java.time.ZoneOffset.UTC)
    }
}

/** `MobileCalendarDraft`: text being typed, not an event yet. Times are epoch ms. */
data class CalendarDraft(
    val title: String = "",
    val start: Long = 0,
    val end: Long = 0,
    val allDay: Boolean = false,
    val calendarId: String = "",
    val location: String = "",
    val notes: String = "",
    val attendees: List<String> = emptyList(),
    val attendeesChanged: Boolean = false,
    val joinUrl: String? = null,
    val roomSlug: String? = null,
    /** 0 is Off. Google only. */
    val travelTimeMinutes: Int = 0,
) {
    val isValid: Boolean get() = title.isNotBlank() && calendarId.isNotEmpty() && end > start
}
