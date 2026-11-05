package work.starlings.android.workspace.home

import work.starlings.android.workspace.FavoritesStore
import work.starlings.android.workspace.QuickNoteFiling
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import work.starlings.android.HomeLayout
import work.starlings.android.HomeModuleSetting
import work.starlings.android.MeetingWarnings
import work.starlings.android.OwnerAccount
import work.starlings.android.R
import work.starlings.android.Upcoming
import work.starlings.android.UpcomingConfig
import work.starlings.android.UpcomingPreferences
import work.starlings.android.api.CalendarRoutes
import work.starlings.android.api.HomeExtraRoutes
import work.starlings.android.api.PublicEvent
import work.starlings.android.api.SettingsRoutes
import work.starlings.android.api.StarlingsApiError
import work.starlings.android.api.TeamRoutes
import work.starlings.android.api.WorkRoutes
import work.starlings.android.SearchRow
import work.starlings.contracts.CalendarEventWire
import work.starlings.contracts.CalendarPreferencesUpdate
import work.starlings.contracts.CommercialSummary
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import work.starlings.contracts.QuickNotePromote
import work.starlings.contracts.QuickNotePromotionKind
import work.starlings.contracts.CrmIssueWire
import work.starlings.contracts.CrmMyTaskWire
import work.starlings.contracts.InboxItem
import work.starlings.contracts.ThreadSummaryWire
import work.starlings.contracts.ControlErrorCodeValue
import work.starlings.contracts.HomeModuleSettingWire
import work.starlings.contracts.OwnerRoomConfiguration
import work.starlings.contracts.QuickNote
import work.starlings.contracts.UpcomingPreferencesWire
import java.time.LocalDate

/**
 * What Home reads and holds: `MobileHomeView`'s own state plus the parts of
 * `UpcomingMeetingsStore`, `MobileHomeLayoutStore` and `MobileQuickNotesStore`
 * that Home draws. Each module flips its own `ready` when its first answer
 * lands (a snapshot or a live read), so no card waits for the slowest.
 * Compose state: the screen recomposes as each read lands.
 */
class HomeModel(private val account: OwnerAccount, private val favorites: FavoritesStore? = null) {
    private val client get() = account.client

    // Layout (`MobileHomeLayoutStore`).
    var layout by mutableStateOf(HomeLayout.resolve(null)); private set
    var layoutReady by mutableStateOf(false); private set
    var layoutSaving by mutableStateOf(false); private set
    var layoutError by mutableStateOf<String?>(null); private set
    /** The workspace's work modules; null until known, which offers every module (an older Worker). */
    var workModules by mutableStateOf<List<String>?>(null); private set

    // Upcoming (`UpcomingMeetingsStore`).
    var raw by mutableStateOf<List<CalendarEventWire>>(emptyList()); private set
    var preferences by mutableStateOf(UpcomingPreferences()); private set
    private var preferencesWire: UpcomingPreferencesWire? = null
    var preferencesLoaded by mutableStateOf(false); private set
    var upcomingReady by mutableStateOf(false); private set
    var calendarUnavailable by mutableStateOf(false); private set
    var calendarNotConnected by mutableStateOf(false); private set

    // YOUR ROOM.
    var room by mutableStateOf<OwnerRoomConfiguration?>(null); private set
    var roomLoading by mutableStateOf(false); private set
    var roomUnmapped by mutableStateOf(false); private set
    var roomFailed by mutableStateOf(false); private set
    var roomReady by mutableStateOf(false); private set

    // EVENTS.
    var events by mutableStateOf<List<PublicEvent>>(emptyList()); private set
    var eventsReady by mutableStateOf(false); private set

    // QUICK NOTES.
    var notes by mutableStateOf<List<QuickNote>>(emptyList()); private set
    var notesReady by mutableStateOf(false); private set
    var noteSaving by mutableStateOf(false); private set
    var noteError by mutableStateOf<String?>(null); private set

    // INBOX (`MobileMyWorkStore.inbox`). Unread talk is the app-level TeamStore's (`MobileTeamStore.unreadThreads`).
    var inbox by mutableStateOf<List<InboxItem>>(emptyList()); private set
    var inboxReady by mutableStateOf(false); private set

    // MINE (`MobileMyWorkStore.tasks`, `issues`).
    var mineTasks by mutableStateOf<List<CrmMyTaskWire>>(emptyList()); private set
    var mineIssues by mutableStateOf<List<CrmIssueWire>>(emptyList()); private set
    var mineReady by mutableStateOf(false); private set

    // COMMERCIAL (`MobileCommercialStore`).
    var commercial by mutableStateOf<CommercialSummary?>(null); private set
    var commercialReady by mutableStateOf(false); private set

    /** QUICK ACCESS: the starred rows, newest star first, from the session's one store (`app.starredRows`). */
    val starred: List<SearchRow> get() = favorites?.starredRows.orEmpty()

    /** `MobileMyWorkStore.homeReady`: Mine and INBOX have both answered once. */
    val workReady: Boolean get() = mineReady && inboxReady
    /** `team.homeMessagesReady || work.homeReady`; [teamReady] is the TeamStore's. */
    fun messagesReady(teamReady: Boolean): Boolean = teamReady || workReady

    /** One line the screen shows over Home until dismissed: `app.alertMessage`. */
    var alert by mutableStateOf<String?>(null)

    var refreshing by mutableStateOf(false); private set
    private var lastReadMs = 0L

    /** The last answers on disk, before any request (docs/CACHING.md). */
    fun paintSnapshots() {
        client.snapshot(SettingsRoutes.ownerRoom)?.let { room = it.value.room; roomReady = true }
        client.snapshot(WorkRoutes.quickNotes)?.let { notes = it.value.notes; notesReady = true }
        client.snapshot(WorkRoutes.subjectState)?.let { s -> workModules = s.value.workModules?.map { it.value } }
        client.snapshot(CalendarRoutes.preferences)?.let { applyPreferences(it.value.upcoming) }
        client.snapshot(WorkRoutes.inbox)?.let { inbox = it.value.items; inboxReady = true }
        client.snapshot(WorkRoutes.mine)?.let { mineTasks = it.value.tasks; mineIssues = it.value.issues; mineReady = true }
        client.snapshot(WorkRoutes.commercialSummary)?.let { commercial = it.value; commercialReady = true }
        favorites?.paintSnapshots()
    }

    /** Home's reads, side by side. Skipped under a minute after the last, unless [force]: a tab switch is not a reason to ask again. */
    suspend fun read(context: Context, force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - lastReadMs < 60_000) return
        lastReadMs = now
        refreshing = force
        try {
            coroutineScope {
                launch { loadLayout() }
                launch { loadWorkModules() }
                launch { loadUpcoming(context) }
                launch { loadRoom() }
                launch { loadEvents() }
                launch { loadNotes() }
                launch { loadInbox() }
                // Today's work widget reads the Mine snapshot this saves.
                launch { loadMine(); work.starlings.android.widgets.WidgetRefresh.now(context.applicationContext) }
                launch { loadCommercial() }
                // `app.refreshFavorites()`: the store waits on a read already in flight.
                launch { favorites?.refresh() }
            }
        } finally {
            refreshing = false
        }
    }

    private suspend fun loadLayout() {
        try {
            val answer = client.call(SettingsRoutes.homeLayout)
            layout = HomeLayout.resolve(answer.modules.map { HomeModuleSetting(it.id, it.enabled) })
        } catch (e: CancellationException) {
            throw e
        } catch (_: StarlingsApiError) {
            // The defaults stand: Home draws, in the default order.
        }
        layoutReady = true
    }

    private suspend fun loadWorkModules() {
        try {
            workModules = client.call(WorkRoutes.subjectState).workModules?.map { it.value }
        } catch (e: CancellationException) {
            throw e
        } catch (_: StarlingsApiError) {
        }
    }

    private fun applyPreferences(wire: UpcomingPreferencesWire) {
        preferencesWire = wire
        preferences = UpcomingPreferences.normalize(wire.homeFollowingRows.toInt())
        preferencesLoaded = true
    }

    /**
     * `UpcomingMeetingsStore.load`: the policy and the feed side by side.
     * Home is fixed to today and tomorrow, so the hours never widen. A failed
     * read keeps the last agenda: a flaky network must not look like an
     * empty calendar. Every answer re-arms the meeting warnings.
     */
    private suspend fun loadUpcoming(context: Context) = coroutineScope {
        val prefs = async { runCatching { client.call(CalendarRoutes.preferences) }.getOrNull() }
        try {
            val answer = client.call(CalendarRoutes.upcoming(UpcomingConfig.REQUEST_HOURS.toLong()))
            raw = answer.events
            calendarUnavailable = false
            calendarNotConnected = false
        } catch (e: CancellationException) {
            throw e
        } catch (e: StarlingsApiError) {
            if ((e as? StarlingsApiError.Service)?.serverCode == ControlErrorCodeValue.CALENDAR_NOT_CONNECTED) {
                raw = emptyList()
                calendarUnavailable = false
                calendarNotConnected = true
            } else {
                calendarUnavailable = raw.isEmpty()
            }
        }
        prefs.await()?.let { applyPreferences(it.upcoming) }
        upcomingReady = true
        synchronizeWarnings(context)
    }

    /** `applyAlerts`: the meetings worth a warning, with the link a tap on one opens. */
    private fun synchronizeWarnings(context: Context) {
        val now = System.currentTimeMillis()
        val plan = Upcoming.classify(raw.map(HomeFeed::upcoming), now, preferences = preferences)
        val meetings = HomeFeed.alertable(plan, raw)
        val links = meetings.associate { it.id to HomeFeed.launchUrl(it) }
        MeetingWarnings.synchronize(context.applicationContext, meetings.map(HomeFeed::upcoming), link = { links[it.id] })
        // The home-screen widgets read the same feed (`AgendaFile.writeMeetings`).
        work.starlings.android.widgets.WidgetStore.publishMeetings(context.applicationContext, account, raw, room?.slug, preferences.homeFollowingRows)
    }

    /**
     * `setDemoted`: optimistic, so hiding the hero promotes the next one at
     * once; rolled back when the write is refused.
     */
    suspend fun setDemoted(context: Context, event: CalendarEventWire, demoted: Boolean) {
        val key = HomeFeed.demotionKey(event)
        val previous = raw.firstOrNull { HomeFeed.demotionKey(it) == key }?.demoted ?: event.demoted
        raw = raw.map { if (HomeFeed.demotionKey(it) == key) it.copy(demoted = demoted) else it }
        try {
            val current = client.call(CalendarRoutes.preferences)
            val keys = current.demotedEventKeys.toMutableSet().apply { if (demoted) add(key) else remove(key) }
            client.call(CalendarRoutes.savePreferences(CalendarPreferencesUpdate(demotedEventKeys = keys.sorted())))
        } catch (e: CancellationException) {
            throw e
        } catch (_: StarlingsApiError) {
            raw = raw.map { if (HomeFeed.demotionKey(it) == key && it.demoted == demoted) it.copy(demoted = previous) else it }
            alert = context.getString(R.string.home_demote_failed)
        }
        synchronizeWarnings(context)
    }

    /** The Following-meetings knob of Settings > Home, on `/api/calendar/preferences`. */
    suspend fun setFollowingRows(count: Int) {
        val current = preferencesWire ?: return
        if (current.homeFollowingRows.toInt() == count) return
        val next = current.copy(homeFollowingRows = count.toLong())
        try {
            applyPreferences(client.call(CalendarRoutes.savePreferences(CalendarPreferencesUpdate(upcoming = next))).upcoming)
        } catch (e: CancellationException) {
            throw e
        } catch (e: StarlingsApiError) {
            alert = e.sentence
        }
    }

    /** `loadOwnerRoom`: a failed read keeps a room on screen; only `room_not_found` takes it away. */
    private suspend fun loadRoom() {
        roomLoading = room == null
        roomFailed = false
        try {
            room = client.call(SettingsRoutes.ownerRoom).room
            roomUnmapped = false
        } catch (e: CancellationException) {
            throw e
        } catch (e: StarlingsApiError) {
            roomUnmapped = (e as? StarlingsApiError.Service)?.serverCode == ControlErrorCodeValue.ROOM_NOT_FOUND
            if (roomUnmapped || room == null) {
                room = null
                roomFailed = !roomUnmapped
            }
        }
        roomLoading = false
        roomReady = true
    }

    /** A failed read answers nothing new; the last rows stand. */
    private suspend fun loadEvents() {
        try {
            events = client.call(HomeExtraRoutes.publicEvents(LocalDate.now())).events
        } catch (e: CancellationException) {
            throw e
        } catch (_: StarlingsApiError) {
        }
        eventsReady = true
    }

    private suspend fun loadNotes() {
        try {
            notes = client.call(WorkRoutes.quickNotes).notes
        } catch (e: CancellationException) {
            throw e
        } catch (_: StarlingsApiError) {
        }
        notesReady = true
    }

    /** The calendar answer in flight, by INBOX key; null when none is (`answeringCalendarKey`). */
    var answeringKey by mutableStateOf<String?>(null); private set

    /** An invitation's Accept, Maybe or Decline, answered on its Home row and written to the Google event. */
    suspend fun respond(item: work.starlings.contracts.InboxInvitationItem, reply: work.starlings.contracts.CalendarEventReply) = answerCalendar(item.key) {
        val event = item.event
        client.call(CalendarRoutes.respond(work.starlings.contracts.CalendarEventRespondRequest(event.calendarId, work.starlings.android.workspace.work.WorkInbox.rawEventId(event), reply)))
    }

    /** An event from a forwarded mail: Add puts it on the calendar, Discard drops it. */
    suspend fun answerForwarded(item: work.starlings.contracts.InboxForwardedItem, add: Boolean) = answerCalendar(item.key) {
        client.call(if (add) CalendarRoutes.addPending(item.event.id) else CalendarRoutes.discardPending(item.event.id))
    }

    /** One at a time: the row shows it is busy, and leaves when the write lands. A failure is Home's alert. */
    private suspend fun answerCalendar(key: String, write: suspend () -> Unit) {
        if (answeringKey != null) return
        answeringKey = key
        try {
            write()
            inbox = inbox.filter { work.starlings.android.workspace.work.WorkInbox.key(it) != key }
            loadInbox()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            alert = (e as? StarlingsApiError)?.sentence ?: e.message
        } finally {
            answeringKey = null
        }
    }

    private suspend fun loadInbox() {
        try {
            inbox = client.call(WorkRoutes.inbox).items
        } catch (e: CancellationException) {
            throw e
        } catch (_: StarlingsApiError) {
        }
        inboxReady = true
    }

    private suspend fun loadMine() {
        try {
            val read = client.call(WorkRoutes.mine)
            mineTasks = read.tasks
            mineIssues = read.issues
        } catch (e: CancellationException) {
            throw e
        } catch (_: StarlingsApiError) {
        }
        mineReady = true
    }

    /** Core is the source; a failed read keeps the last summary, and none draws nothing. */
    private suspend fun loadCommercial() {
        try {
            commercial = client.call(WorkRoutes.commercialSummary)
        } catch (e: CancellationException) {
            throw e
        } catch (_: StarlingsApiError) {
        }
        commercialReady = true
    }

    /** Capture. True when the Worker kept it; the field empties then. */
    suspend fun createNote(body: String): Boolean {
        val trimmed = body.trim()
        if (trimmed.isEmpty() || noteSaving) return false
        noteSaving = true
        noteError = null
        return try {
            val saved = client.call(HomeExtraRoutes.createQuickNote(trimmed)).note
            notes = listOf(saved) + notes.filterNot { it.id == saved.id }
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: StarlingsApiError) {
            noteError = e.sentence
            false
        } finally {
            noteSaving = false
        }
    }

    /** True when the Worker deleted it. */
    suspend fun deleteNote(note: QuickNote): Boolean {
        val before = notes
        notes = notes.filterNot { it.id == note.id }
        return try {
            client.call(HomeExtraRoutes.deleteQuickNote(note.id))
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: StarlingsApiError) {
            notes = before
            alert = e.sentence
            false
        }
    }

    /** The drawer's Save: the new body, in place. True when the Worker kept it. */
    suspend fun updateNote(note: QuickNote, body: String): Boolean {
        val trimmed = body.trim()
        if (trimmed.isEmpty() || noteSaving) return false
        noteSaving = true
        noteError = null
        return try {
            val saved = client.call(HomeExtraRoutes.updateQuickNote(note.id, trimmed)).note
            notes = notes.map { if (it.id == saved.id) saved else it }
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: StarlingsApiError) {
            noteError = e.sentence
            false
        } finally {
            noteSaving = false
        }
    }

    /** Where a note can go: `MobileQuickNotesStore.loadFilingOptions`. */
    data class FilingOptions(val subjects: List<CrmSubjectWire>, val starred: Set<String>, val threads: List<ThreadSummaryWire>)

    /**
     * Projects, leads and partners side by side, starred first, and the
     * conversations. A failed partner page does not blank the others.
     */
    suspend fun loadFilingOptions(): FilingOptions = coroutineScope {
        val projects = async { client.call(WorkRoutes.subjects(CrmSubjectKind.PROJECT, "", null)).subjects }
        val leads = async { client.call(WorkRoutes.subjects(CrmSubjectKind.LEAD, "", null)).subjects }
        val partners = async { runCatching { client.call(WorkRoutes.subjects(CrmSubjectKind.ORGANIZATION, "", null)).subjects }.getOrDefault(emptyList()) }
        val conversations = async { client.call(TeamRoutes.threads).threads }
        val state = async { runCatching { client.call(WorkRoutes.subjectState) }.getOrNull() }
        val stars = state.await()?.states.orEmpty().filter { it.starred }.map { "${it.kind.value}:${it.id}" }.toSet()
        FilingOptions(
            QuickNoteFiling.sorted(projects.await() + leads.await() + partners.await(), stars),
            stars,
            conversations.await(),
        )
    }

    /**
     * Make the thing first, then point the note at it: the Worker accepts the
     * same promotion twice, so a lost second write can be retried without a
     * second task. The filed note leaves Home's list (it is no longer open).
     */
    suspend fun file(note: QuickNote, kind: QuickNotePromotionKind, subject: CrmSubjectWire?, threadId: String, title: String) {
        val id = when (kind) {
            QuickNotePromotionKind.TASK -> client.call(WorkRoutes.createTask(QuickNoteFiling.task(note.body, title, subject ?: return))).task.id
            QuickNotePromotionKind.ISSUE -> client.call(HomeExtraRoutes.createIssue(QuickNoteFiling.issue(note.body, title, subject ?: return))).issue.id
            QuickNotePromotionKind.MESSAGE -> client.call(TeamRoutes.send(threadId, note.body)).message.id
            else -> return
        }
        val filed = client.call(HomeExtraRoutes.promoteQuickNote(note.id, QuickNotePromote(kind, id))).note
        notes = notes.map { if (it.id == filed.id) filed else it }
    }

    /** Settings > Home: one write of the whole list, as `MobileHomeLayoutStore.save`. */
    suspend fun saveLayout(next: List<HomeModuleSetting>) {
        if (layoutSaving) return
        val before = layout
        layout = HomeLayout.resolve(next)
        layoutSaving = true
        layoutError = null
        try {
            val answer = client.call(SettingsRoutes.setHomeLayout(layout.map { HomeModuleSettingWire(it.id, it.enabled) }))
            layout = HomeLayout.resolve(answer.modules.map { HomeModuleSetting(it.id, it.enabled) })
        } catch (e: CancellationException) {
            throw e
        } catch (e: StarlingsApiError) {
            layout = before
            layoutError = e.sentence
        } finally {
            layoutSaving = false
        }
    }
}
