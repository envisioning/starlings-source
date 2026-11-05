package work.starlings.android.workspace.calendar

import work.starlings.android.CalEvent
import work.starlings.android.CalendarDates
import work.starlings.android.CalendarValues
import work.starlings.android.api.PublicEvent
import work.starlings.contracts.CalendarAvailabilityBlock
import work.starlings.contracts.CrmWorkItem
import work.starlings.contracts.CrmWorkItemKind
import java.time.LocalDate
import java.time.ZoneId

/**
 * `Sources/CalendarLayer.swift`: company-determined rows drawn beside the
 * owner's events. A layer is not a calendar: the app reads it and never
 * writes it, so it has its own type and no edit path. The kinds are
 * [CalendarValues.layers], keyed by their `kind`.
 */
enum class CalendarLayerKind(val wire: String, val color: Long) {
    /** `CalendarLayerPalette`: the brand lime in four steps, loudest first. */
    EVENTS("events", 0xFFC8E63CL),
    MILESTONES("milestones", 0xFF9CBF2EL),
    TASKS("tasks", 0xFF7C9455L),
    AVAILABILITY("availability", 0xFF667C4AL),
    ;

    val value: CalendarValues.Layer get() = CalendarValues.layers.first { it.kind == wire }

    companion object {
        fun of(wire: String): CalendarLayerKind? = entries.firstOrNull { it.wire == wire }
    }
}

/** One way from a layer row into Work, as a Work web path (`work-hrefs.ts`). */
sealed interface CalendarLayerWorkLink {
    val path: String

    /** Your own task, on its row in Mine: `/work/task/<id>`. */
    data class Mine(override val path: String) : CalendarLayerWorkLink

    /** The subject the item is filed on. [name] is null where the wire has none (a lead). */
    data class Subject(val kind: String, val name: String?, override val path: String) : CalendarLayerWorkLink
}

/** `CalendarLayerItem`. Times are epoch ms. */
data class CalendarLayerItem(
    val id: String,
    val kind: CalendarLayerKind,
    val title: String,
    val start: Long,
    val end: Long,
    val allDay: Boolean,
    /** Where to read the whole thing: a published event's page. */
    val url: String = "",
    /** The project for work items, the place for events. */
    val detail: String = "",
    val assignee: String = "",
    /** Server-marked: everyone's dated work is drawn, only yours is emphasised. */
    val isMine: Boolean = false,
    val status: String = "",
    val notes: String = "",
    val workLinks: List<CalendarLayerWorkLink> = emptyList(),
) {
    /** The trimmed title, or null where the screen says the kind's name. */
    val shownTitle: String? get() = title.trim().ifEmpty { null }

    fun isPast(now: Long): Boolean = end <= now

    /** `statusText`: `in_progress` reads "In progress". */
    val statusText: String
        get() {
            val words = status.replace('_', ' ')
            return words.take(1).uppercase() + words.drop(1)
        }

    /** Tasks complete and milestones are done; both read as finished. */
    val isFinished: Boolean get() = status.lowercase() in setOf("completed", "done")
}

object CalendarLayers {
    /** A task with no length still needs a block tall enough to read. */
    const val DEFAULT_TASK_MINUTES = 30

    /** A dated task or milestone from Core. A row with no due date is not on the calendar. */
    fun workItem(item: CrmWorkItem, zone: ZoneId): CalendarLayerItem? {
        val due = item.dueAt ?: return null
        val parsed = CalendarDates.parse(due, zone) ?: return null
        val allDay = CalendarDates.isAllDay(due, false)
        val start = if (allDay) CalendarDates.startOfDay(CalendarDates.day(parsed, zone), zone) else parsed
        val end = if (allDay) CalendarDates.startOfDay(CalendarDates.day(parsed, zone).plusDays(1), zone) else start + DEFAULT_TASK_MINUTES * 60_000L
        return CalendarLayerItem(
            id = "wi:${item.id}",
            kind = if (item.kind == CrmWorkItemKind.MILESTONE) CalendarLayerKind.MILESTONES else CalendarLayerKind.TASKS,
            title = item.title,
            start = start,
            end = end,
            allDay = allDay,
            detail = item.projectTitle ?: item.organizationTitle ?: "",
            assignee = item.assigneeName ?: "",
            isMine = item.mine ?: false,
            status = item.status,
            notes = item.notes?.trim().orEmpty(),
            workLinks = workLinks(item),
        )
    }

    /**
     * `CalendarLayerWorkLink.links`: your task lands on its row in Mine; any
     * task or milestone opens the subject it is filed on, a task on the
     * subject's Tasks pane, a milestone on its overview.
     */
    fun workLinks(item: CrmWorkItem): List<CalendarLayerWorkLink> {
        val links = mutableListOf<CalendarLayerWorkLink>()
        val task = item.kind == CrmWorkItemKind.TASK
        if (task && item.mine == true) links += CalendarLayerWorkLink.Mine("/work/task/${encode(item.id)}")
        fun named(title: String?) = title?.trim()?.ifEmpty { null }
        val subject: Triple<String, String, String?>? = when {
            !item.projectId.isNullOrEmpty() -> Triple("project", item.projectId!!, named(item.projectTitle))
            !item.leadId.isNullOrEmpty() -> Triple("lead", item.leadId!!, null)
            !item.eventId.isNullOrEmpty() -> Triple("event", item.eventId!!, named(item.eventTitle))
            !item.organizationId.isNullOrEmpty() -> Triple("organization", item.organizationId!!, named(item.organizationTitle))
            else -> null
        }
        subject?.let { (kind, id, name) ->
            val path = "/work/$kind/${encode(id)}" + if (task) "?pane=tasks" else ""
            links += CalendarLayerWorkLink.Subject(kind, name, path)
        }
        return links
    }

    /** A published event: the projection's date for an all-day row, its instants for a timed one. */
    fun publicEvent(event: PublicEvent, zone: ZoneId): CalendarLayerItem? {
        val startText = if (event.isAllDay) event.date else event.startsAt ?: event.date
        val endText = if (event.isAllDay) event.date else event.endsAt ?: event.startsAt ?: event.date
        val start = CalendarDates.parse(startText, zone) ?: return null
        val end = CalendarDates.parse(endText, zone) ?: (start + 3_600_000L)
        return CalendarLayerItem(
            id = "pe:${event.id}",
            kind = CalendarLayerKind.EVENTS,
            title = event.title,
            start = start,
            end = maxOf(end, start + 60_000L),
            allDay = event.isAllDay,
            url = event.signupUrl.orEmpty(),
            detail = event.location.orEmpty(),
        )
    }

    /** One stretch of bookable time from Core. Always timed. */
    fun availability(block: CalendarAvailabilityBlock, zone: ZoneId): CalendarLayerItem? {
        val start = CalendarDates.parse(block.start, zone) ?: return null
        val end = CalendarDates.parse(block.end, zone) ?: return null
        if (end <= start) return null
        return CalendarLayerItem(id = "av:${block.start}", kind = CalendarLayerKind.AVAILABILITY, title = "", start = start, end = end, allDay = false, isMine = true)
    }

    /** `MirrorSplit`: the layers with mirrored published events removed, and the events standing in for them. */
    data class MirrorSplit(val layers: List<CalendarLayerItem>, val publishedEventIds: Set<String>)

    /**
     * A published event the owner also has on a calendar is one appointment:
     * the same title at the same instants. The calendar's row stays, with the
     * Events swatch added.
     */
    fun splitMirrored(layers: List<CalendarLayerItem>, events: List<CalEvent>): MirrorSplit {
        val published = layers.filter { it.kind == CalendarLayerKind.EVENTS }.map { key(it.title, it.allDay, it.start, it.end) }.toSet()
        if (published.isEmpty()) return MirrorSplit(layers, emptySet())
        val mirrored = events.filter { key(it.title, it.allDay, it.start, it.end) in published }
        if (mirrored.isEmpty()) return MirrorSplit(layers, emptySet())
        val covered = mirrored.map { key(it.title, it.allDay, it.start, it.end) }.toSet()
        return MirrorSplit(
            layers.filter { it.kind != CalendarLayerKind.EVENTS || key(it.title, it.allDay, it.start, it.end) !in covered },
            mirrored.map { it.id }.toSet(),
        )
    }

    private fun key(title: String, allDay: Boolean, start: Long, end: Long) =
        "${title.trim().lowercase()}|${if (allDay) "all-day" else "timed"}|$start|$end"

    /** `layerItems(on:)`: rows touching [day], all-day first, then by start. */
    fun on(day: LocalDate, items: List<CalendarLayerItem>, zone: ZoneId): List<CalendarLayerItem> {
        val dayStart = CalendarDates.startOfDay(day, zone)
        val dayEnd = CalendarDates.startOfDay(day.plusDays(1), zone)
        return items.filter { it.start < dayEnd && it.end > dayStart }
            .sortedWith(compareBy<CalendarLayerItem> { !it.allDay }.thenBy { it.start })
    }

    /** Clipped to [from, to): Core rounds to whole days. */
    fun inRange(items: List<CalendarLayerItem>, from: Long, to: Long): List<CalendarLayerItem> =
        items.filter { it.start < to && it.end > from }

    private fun encode(raw: String): String =
        java.net.URLEncoder.encode(raw, Charsets.UTF_8).replace("+", "%20")
}
