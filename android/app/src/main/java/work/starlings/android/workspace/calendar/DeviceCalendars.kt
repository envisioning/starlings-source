package work.starlings.android.workspace.calendar

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.provider.CalendarContract
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import work.starlings.android.CalCalendar
import work.starlings.android.CalEvent
import work.starlings.android.CalSource
import work.starlings.android.CalendarColors
import work.starlings.android.CalendarKeys
import work.starlings.android.MeetingPlatforms
import work.starlings.android.Rsvp
import work.starlings.contracts.CalendarAttendeeStatus
import work.starlings.contracts.CalendarAttendeeWire
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * `Sources/EventKitCalendarStore.swift` on Android: the phone's own calendars
 * through `CalendarContract`, read with `READ_CALENDAR`. Google stays on the
 * Worker, so a Google account the phone also syncs is not listed twice. The
 * rules are in [DeviceCalendarRules] (`DeviceCalendarsTest`); this class is
 * the content-provider reads and writes. The writes are EventKit's: create,
 * update (this occurrence or the series), move to another calendar (the
 * whole series) and delete. The values they write are [DeviceCalendarWrites]
 * (`DeviceCalendarWritesTest`). No reply: EventKit has no API for it.
 */
class DeviceCalendars(private val context: Context) {
    /** `EventKitCalendarStore.Access`. */
    enum class Access { UNKNOWN, GRANTED, DENIED }

    val granted: Boolean
        get() = ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED

    /** `WRITE_CALENDAR`, asked with the read as iOS asks EventKit for full access. */
    val writeGranted: Boolean
        get() = ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_CALENDAR) == PackageManager.PERMISSION_GRANTED

    suspend fun calendars(): List<CalCalendar> = withContext(Dispatchers.IO) {
        if (!granted) return@withContext emptyList()
        val rows = mutableListOf<DeviceCalendarRules.Row>()
        runCatching {
            context.contentResolver.query(
                CalendarContract.Calendars.CONTENT_URI,
                arrayOf(
                    CalendarContract.Calendars._ID,
                    CalendarContract.Calendars.ACCOUNT_NAME,
                    CalendarContract.Calendars.ACCOUNT_TYPE,
                    CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
                    CalendarContract.Calendars.CALENDAR_COLOR,
                    CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,
                    CalendarContract.Calendars.OWNER_ACCOUNT,
                ),
                null, null, null,
            )?.use { c ->
                while (c.moveToNext()) {
                    rows += DeviceCalendarRules.Row(
                        id = c.getLong(0).toString(),
                        accountName = c.getString(1).orEmpty(),
                        accountType = c.getString(2).orEmpty(),
                        title = c.getString(3).orEmpty(),
                        color = if (c.isNull(4)) null else c.getInt(4),
                        writable = c.getInt(5) >= CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR,
                        owner = c.getString(6).orEmpty(),
                    )
                }
            }
        }
        DeviceCalendarRules.calendars(rows, DeviceCalendarRules.localGroupTitle(isTablet()), canWrite = writeGranted)
    }

    /** The instances of [calendars] in the range, recurring ones expanded by the provider. */
    suspend fun events(fromMs: Long, toMs: Long, calendars: List<CalCalendar>, ownHosts: List<String>, zone: ZoneId): List<CalEvent> =
        withContext(Dispatchers.IO) {
            if (!granted || calendars.isEmpty()) return@withContext emptyList()
            val byRaw = calendars.filter { it.source == CalSource.DEVICE }.associateBy { it.rawId }
            if (byRaw.isEmpty()) return@withContext emptyList()
            val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also {
                ContentUris.appendId(it, fromMs)
                ContentUris.appendId(it, toMs)
            }.build()
            val instances = mutableListOf<DeviceCalendarRules.Instance>()
            runCatching {
                context.contentResolver.query(
                    uri,
                    arrayOf(
                        CalendarContract.Instances.EVENT_ID,
                        CalendarContract.Instances.CALENDAR_ID,
                        CalendarContract.Instances.TITLE,
                        CalendarContract.Instances.BEGIN,
                        CalendarContract.Instances.END,
                        CalendarContract.Instances.ALL_DAY,
                        CalendarContract.Instances.RRULE,
                        CalendarContract.Instances.RDATE,
                        CalendarContract.Instances.EVENT_LOCATION,
                        CalendarContract.Instances.DESCRIPTION,
                        CalendarContract.Instances.EVENT_TIMEZONE,
                        CalendarContract.Instances.SELF_ATTENDEE_STATUS,
                    ),
                    "${CalendarContract.Instances.CALENDAR_ID} IN (${byRaw.keys.joinToString(",") { "?" }})",
                    byRaw.keys.toTypedArray(),
                    "${CalendarContract.Instances.BEGIN} ASC",
                )?.use { c ->
                    while (c.moveToNext()) {
                        instances += DeviceCalendarRules.Instance(
                            eventId = c.getLong(0).toString(),
                            calendarRawId = c.getLong(1).toString(),
                            title = c.getString(2).orEmpty(),
                            begin = c.getLong(3),
                            end = c.getLong(4),
                            allDay = c.getInt(5) != 0,
                            recurring = !c.getString(6).isNullOrEmpty() || !c.getString(7).isNullOrEmpty(),
                            location = c.getString(8).orEmpty(),
                            notes = c.getString(9).orEmpty(),
                            timeZone = c.getString(10),
                            selfStatus = c.getInt(11),
                        )
                    }
                }
            }
            val people = attendees(instances.map { it.eventId }.toSet())
            instances.mapNotNull { DeviceCalendarRules.event(it, byRaw[it.calendarRawId], people[it.eventId].orEmpty(), ownHosts, zone) }
        }

    private fun attendees(eventIds: Set<String>): Map<String, List<DeviceCalendarRules.Attendee>> {
        if (eventIds.isEmpty()) return emptyMap()
        val out = HashMap<String, MutableList<DeviceCalendarRules.Attendee>>()
        // The provider takes a bounded number of arguments per query.
        eventIds.chunked(200).forEach { chunk ->
            runCatching {
                context.contentResolver.query(
                    CalendarContract.Attendees.CONTENT_URI,
                    arrayOf(
                        CalendarContract.Attendees.EVENT_ID,
                        CalendarContract.Attendees.ATTENDEE_NAME,
                        CalendarContract.Attendees.ATTENDEE_EMAIL,
                        CalendarContract.Attendees.ATTENDEE_STATUS,
                        CalendarContract.Attendees.ATTENDEE_TYPE,
                    ),
                    "${CalendarContract.Attendees.EVENT_ID} IN (${chunk.joinToString(",") { "?" }})",
                    chunk.toTypedArray(),
                    null,
                )?.use { c ->
                    while (c.moveToNext()) {
                        out.getOrPut(c.getLong(0).toString()) { mutableListOf() } += DeviceCalendarRules.Attendee(
                            name = c.getString(1).orEmpty(),
                            email = c.getString(2).orEmpty(),
                            status = c.getInt(3),
                            type = c.getInt(4),
                        )
                    }
                }
            }
        }
        return out
    }

    // Writing (`EventKitCalendarStore.create`, `update`, `move`, `delete`)

    /** A device write that failed, with the title the Calendar alert shows. */
    class WriteError(val operation: String, cause: Throwable? = null) : Exception(operation, cause)

    /** `create`: a new event on [calendarRawId]. Answers the new event's id. */
    suspend fun create(calendarRawId: String, values: DeviceCalendarWrites.Values, zone: ZoneId): String = write(CREATE) {
        val row = DeviceCalendarWrites.eventRow(values, zone) + (DeviceCalendarWrites.CALENDAR_ID to calendarRawId.toLong())
        val uri = context.contentResolver.insert(CalendarContract.Events.CONTENT_URI, contentValues(row))
            ?: throw WriteError(CREATE)
        ContentUris.parseId(uri).toString()
    }

    /**
     * `update(eventIdentifier:occurrenceStart:…span:)`. A single event is
     * written in place. One occurrence of a series becomes an exception at
     * its original time; the whole series moves its first start by the same
     * days and takes the new time of day and length.
     */
    suspend fun update(event: CalEvent, values: DeviceCalendarWrites.Values, wholeSeries: Boolean, zone: ZoneId): Unit = write<Unit>(UPDATE) {
        val resolver = context.contentResolver
        val id = event.rawEventId.toLong()
        val series = seriesRow(id) ?: throw WriteError(MISSING)
        val original = DeviceCalendarWrites.instanceTime(event.start, event.allDay, zone)
        val eventUri = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id)
        when {
            !series.recurring -> {
                if (resolver.update(eventUri, contentValues(DeviceCalendarWrites.eventRow(values, zone)), null, null) == 0) throw WriteError(MISSING)
            }
            wholeSeries -> {
                val row = DeviceCalendarWrites.seriesRow(values, series.start, series.allDay, original, event.allDay, zone)
                if (resolver.update(eventUri, contentValues(row), null, null) == 0) throw WriteError(MISSING)
            }
            else -> {
                val row = DeviceCalendarWrites.exceptionRow(values, original, zone)
                resolver.insert(Uri.withAppendedPath(CalendarContract.Events.CONTENT_EXCEPTION_URI, id.toString()), contentValues(row))
                    ?: throw WriteError(UPDATE)
            }
        }
    }

    /** `delete(eventIdentifier:occurrenceStart:span:)`: one occurrence of a series is a cancelled exception. */
    suspend fun delete(event: CalEvent, wholeSeries: Boolean, zone: ZoneId): Unit = write<Unit>(DELETE) {
        val resolver = context.contentResolver
        val id = event.rawEventId.toLong()
        val series = seriesRow(id) ?: throw WriteError(MISSING)
        if (series.recurring && !wholeSeries) {
            val row = DeviceCalendarWrites.cancelledRow(DeviceCalendarWrites.instanceTime(event.start, event.allDay, zone))
            resolver.insert(Uri.withAppendedPath(CalendarContract.Events.CONTENT_EXCEPTION_URI, id.toString()), contentValues(row))
                ?: throw WriteError(DELETE)
        } else if (resolver.delete(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), null, null) == 0) {
            throw WriteError(MISSING)
        }
    }

    /**
     * `move(eventIdentifier:occurrenceStart:toCalendarRawID:)`: the whole
     * series, as EventKit moves it. The provider keeps an event on its
     * calendar's account, so the row, its guests and its alerts are copied to
     * the target and the original is deleted.
     */
    suspend fun move(event: CalEvent, toCalendarRawId: String): Unit = write<Unit>(UPDATE) {
        val resolver = context.contentResolver
        val id = event.rawEventId.toLong()
        val columns = DeviceCalendarWrites.MOVED_COLUMNS
        val copy = resolver.query(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), columns.toTypedArray(), null, null, null)?.use { c ->
            if (!c.moveToFirst()) null else readRow(c, columns)
        } ?: throw WriteError(MISSING)
        copy.put(DeviceCalendarWrites.CALENDAR_ID, toCalendarRawId.toLong())
        val created = resolver.insert(CalendarContract.Events.CONTENT_URI, copy) ?: throw WriteError(UPDATE)
        val newId = ContentUris.parseId(created)
        copyRows(CalendarContract.Attendees.CONTENT_URI, DeviceCalendarWrites.EVENT_ID, id, newId, DeviceCalendarWrites.ATTENDEE_COLUMNS)
        copyRows(CalendarContract.Reminders.CONTENT_URI, DeviceCalendarWrites.EVENT_ID, id, newId, DeviceCalendarWrites.REMINDER_COLUMNS)
        resolver.delete(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), null, null)
    }

    private fun readRow(c: Cursor, columns: List<String>): ContentValues = ContentValues().apply {
        columns.forEachIndexed { i, column ->
            when (c.getType(i)) {
                Cursor.FIELD_TYPE_NULL -> putNull(column)
                Cursor.FIELD_TYPE_INTEGER -> put(column, c.getLong(i))
                else -> put(column, c.getString(i))
            }
        }
    }

    /** The guests and alerts of [from], as rows of [to]. A row the provider refuses is left behind. */
    private fun copyRows(uri: Uri, eventColumn: String, from: Long, to: Long, columns: List<String>) {
        val resolver = context.contentResolver
        val rows = runCatching {
            resolver.query(uri, columns.toTypedArray(), "$eventColumn = ?", arrayOf(from.toString()), null)?.use { c ->
                buildList { while (c.moveToNext()) add(readRow(c, columns).apply { put(eventColumn, to) }) }
            }.orEmpty()
        }.getOrDefault(emptyList())
        rows.forEach { runCatching { resolver.insert(uri, it) } }
    }

    private class Series(val start: Long, val allDay: Boolean, val recurring: Boolean)

    private fun seriesRow(id: Long): Series? =
        context.contentResolver.query(
            ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id),
            arrayOf(CalendarContract.Events.DTSTART, CalendarContract.Events.ALL_DAY, CalendarContract.Events.RRULE, CalendarContract.Events.RDATE),
            null, null, null,
        )?.use { c ->
            if (!c.moveToFirst()) null
            else Series(c.getLong(0), c.getInt(1) != 0, !c.getString(2).isNullOrEmpty() || !c.getString(3).isNullOrEmpty())
        }

    private suspend fun <T> write(operation: String, work: () -> T): T = withContext(Dispatchers.IO) {
        if (!writeGranted) throw WriteError(operation)
        try {
            work()
        } catch (e: WriteError) {
            throw e
        } catch (e: RuntimeException) {
            // SecurityException, IllegalArgumentException: the provider refused.
            throw WriteError(operation, e)
        }
    }

    private fun contentValues(row: Map<String, Any?>): ContentValues = ContentValues().apply {
        row.forEach { (key, value) ->
            when (value) {
                null -> putNull(key)
                is Long -> put(key, value)
                is Int -> put(key, value)
                else -> put(key, value.toString())
            }
        }
    }

    private fun isTablet(): Boolean = context.resources.configuration.smallestScreenWidthDp >= 600

    private companion object {
        // The Calendar alert's titles, as the Google routes name them. Errors stay English.
        const val CREATE = "Couldn’t create the Calendar event"
        const val UPDATE = "Couldn’t update the Calendar event"
        const val DELETE = "Couldn’t delete the Calendar event"
        /** `EventKitCalendarError.missingEvent`, plain English on iOS too. */
        const val MISSING = "That event couldn’t be found in Calendar."
    }
}

/** The CalendarContract rows as `EventKitCalendarStore` reads EventKit. No Android types: JVM-tested. */
object DeviceCalendarRules {
    /** One `Calendars` row. [owner] is the calendar's own address, which names the owner among the guests. */
    data class Row(
        val id: String,
        val accountName: String,
        val accountType: String,
        val title: String,
        val color: Int?,
        val writable: Boolean,
        val owner: String = "",
    )

    data class Instance(
        val eventId: String,
        val calendarRawId: String,
        val title: String,
        val begin: Long,
        val end: Long,
        val allDay: Boolean,
        val recurring: Boolean,
        val location: String,
        val notes: String,
        val timeZone: String?,
        val selfStatus: Int,
    )

    data class Attendee(val name: String, val email: String, val status: Int, val type: Int)

    /** `CalendarContract.ACCOUNT_TYPE_LOCAL`. */
    const val LOCAL_ACCOUNT_TYPE = "LOCAL"
    private const val GOOGLE_ACCOUNT_TYPE = "com.google"

    // `CalendarContract.Attendees` values, spelled out so the rules run on the JVM.
    private const val STATUS_ACCEPTED = 1
    private const val STATUS_DECLINED = 2
    private const val STATUS_INVITED = 3
    private const val STATUS_TENTATIVE = 4
    private const val TYPE_OPTIONAL = 2
    private const val TYPE_RESOURCE = 3

    /**
     * `localGroupTitle`: "On My iPhone" is `UIDevice.model`, a stored group
     * identity iOS does not translate. Android names the phone the same way.
     */
    fun localGroupTitle(tablet: Boolean): String = if (tablet) "On My Tablet" else "On My Phone"

    /**
     * `includeSource`: the phone's own calendars and other accounts, never
     * Google, which Starlings reads through the Worker. Matched on the
     * account (type and name), as iOS matches the source's title and id.
     */
    fun includeAccount(type: String, name: String): Boolean {
        if (type == LOCAL_ACCOUNT_TYPE) return true
        if (type == GOOGLE_ACCOUNT_TYPE) return false
        val haystack = name.lowercase()
        return !haystack.contains("google") && !haystack.contains("gmail")
    }

    /** The account's own name; "On My Phone" for the local store. */
    fun groupTitle(row: Row, localTitle: String): String =
        if (row.accountType == LOCAL_ACCOUNT_TYPE) localTitle else row.accountName.trim().ifEmpty { localTitle }

    /** [canWrite] is `WRITE_CALENDAR`: without it every calendar reads as read only. */
    fun calendars(rows: List<Row>, localTitle: String, canWrite: Boolean = true): List<CalCalendar> =
        rows.filter { includeAccount(it.accountType, it.accountName) }
            .mapIndexed { index, row ->
                CalCalendar(
                    id = CalendarKeys.EVENT_KIT_PREFIX + row.id,
                    source = CalSource.DEVICE,
                    rawId = row.id,
                    title = row.title,
                    groupTitle = groupTitle(row, localTitle),
                    writable = row.writable && canWrite,
                    color = row.color?.let { 0xFF000000L or (it.toLong() and 0xFFFFFFL) } ?: CalendarColors.fallback(index + 3),
                    accountEmail = row.owner.trim().lowercase().ifEmpty { null },
                )
            }
            .sortedBy { it.title.lowercase() }

    /**
     * An all-day instance is stored as UTC midnights; it covers those dates
     * in the phone's zone, as EventKit hands a local all-day event.
     */
    fun allDaySpan(begin: Long, end: Long, zone: ZoneId): Pair<Long, Long> {
        val first = Instant.ofEpochMilli(begin).atZone(ZoneOffset.UTC).toLocalDate()
        val last = Instant.ofEpochMilli(maxOf(end, begin)).atZone(ZoneOffset.UTC).toLocalDate()
        val start = first.atStartOfDay(zone).toInstant().toEpochMilli()
        val stop = (if (last.isAfter(first)) last else first.plusDays(1)).atStartOfDay(zone).toInstant().toEpochMilli()
        return start to stop
    }

    /** `myResponse(of:)`: null when the owner is not a guest. */
    fun response(status: Int): Rsvp? = when (status) {
        STATUS_ACCEPTED -> Rsvp.ACCEPTED
        STATUS_DECLINED -> Rsvp.DECLINED
        STATUS_TENTATIVE -> Rsvp.TENTATIVE
        STATUS_INVITED -> Rsvp.NEEDS_ACTION
        else -> null
    }

    private fun attendeeStatus(status: Int): CalendarAttendeeStatus = when (status) {
        STATUS_ACCEPTED -> CalendarAttendeeStatus.ACCEPTED
        STATUS_DECLINED -> CalendarAttendeeStatus.DECLINED
        STATUS_TENTATIVE -> CalendarAttendeeStatus.TENTATIVE
        STATUS_INVITED -> CalendarAttendeeStatus.NEEDS_ACTION
        else -> CalendarAttendeeStatus.UNKNOWN
    }

    /** `events(from:to:calendars:)`: one row per occurrence, `ek:<event>:<start seconds>`. */
    fun event(instance: Instance, calendar: CalCalendar?, attendees: List<Attendee>, ownHosts: List<String>, zone: ZoneId): CalEvent? {
        calendar ?: return null
        val (start, end) = if (instance.allDay) allDaySpan(instance.begin, instance.end, zone) else instance.begin to instance.end
        val stored = instance.location.trim()
        // The location doubles as the link's home; a link is not a place.
        val join = if (stored.startsWith("http")) stored else ""
        val location = if (stored == join) "" else stored
        val slug = MeetingPlatforms.roomSlug(join).orEmpty()
        // Rooms and resources are left out; the guest mark is about people.
        val owner = calendar.accountEmail
        val people = attendees.filter { it.type != TYPE_RESOURCE }.map {
            val email = it.email.trim().lowercase()
            CalendarAttendeeWire(
                name = it.name.ifEmpty { email },
                email = email,
                status = attendeeStatus(it.status),
                optional = it.type == TYPE_OPTIONAL,
                isSelf = owner != null && email == owner,
            )
        }
        val self = people.firstOrNull { it.isSelf }
        return CalEvent(
            id = "${CalendarKeys.EVENT_KIT_PREFIX}${instance.eventId}:${start / 1000}",
            calendarId = calendar.id,
            rawEventId = instance.eventId,
            title = instance.title,
            start = start,
            end = maxOf(end, start + 60_000L),
            allDay = instance.allDay,
            // `meta.isWritable`: the calendar's access level, and the write permission.
            writable = calendar.writable,
            recurring = instance.recurring,
            joinUrl = join,
            roomSlug = slug,
            attendeeEmails = people.map { it.email }.filter { it.contains('@') }.distinct(),
            attendees = people,
            source = CalSource.DEVICE,
            notes = instance.notes,
            location = location,
            startTimeZone = instance.timeZone,
            myResponse = if (self != null) response(instance.selfStatus) else null,
            platform = MeetingPlatforms.inferred(join, location, slug, ownHosts),
        )
    }

    /**
     * `CalendarSourceGroup.ordered`: one group per account, its calendars by
     * title; Google first, then the other accounts, the phone's own store,
     * and the subscribed feeds last. The input order is not used.
     */
    fun orderedGroups(calendars: List<CalCalendar>): List<Pair<String, List<CalCalendar>>> =
        calendars.groupBy { it.groupTitle }.toList()
            .map { (title, members) -> title to members.sortedWith(compareBy<CalCalendar> { it.title.lowercase() }.thenBy { it.id }) }
            .sortedWith(
                compareBy<Pair<String, List<CalCalendar>>> { (title, members) -> rank(title, members.first().source) }
                    .thenBy { it.first.lowercase() }
                    .thenBy { "${it.second.first().source}:${it.first}" },
            )

    private fun rank(title: String, source: CalSource): Int = when {
        source == CalSource.GOOGLE && title == "Google" -> 0
        source == CalSource.DEVICE && title.startsWith("On My ") -> 2
        source == CalSource.SUBSCRIPTION -> 3
        else -> 1
    }

    /**
     * `CalendarSourcePreferences.adoptLocal`: the first list ever read is
     * adopted whole and nothing is new; after that, a calendar not seen
     * before is new, and the caller keeps it out until it is enabled. An
     * empty read seeds nothing: access may not be granted yet.
     * Answers the keys seen from now on and the new ones.
     */
    fun adoptLocal(seen: Set<String>?, keys: Set<String>): Pair<Set<String>?, List<String>> {
        if (keys.isEmpty()) return seen to emptyList()
        if (seen == null) return keys to emptyList()
        return (seen + keys) to (keys - seen).sorted()
    }
}
