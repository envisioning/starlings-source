package work.starlings.android.workspace.home

import work.starlings.android.SearchDestination
import work.starlings.android.SearchDoor
import work.starlings.android.SearchKind
import work.starlings.android.SearchVerb
import work.starlings.android.Upcoming
import work.starlings.android.workspace.MemberSurface
import work.starlings.android.workspace.team.isSubjectChannel
import work.starlings.contracts.InboxBookingChange
import work.starlings.contracts.InboxBookingItem
import work.starlings.contracts.InboxCardItem
import work.starlings.contracts.InboxCommentItem
import work.starlings.contracts.InboxCommercialItem
import work.starlings.contracts.InboxDecisionItem
import work.starlings.contracts.InboxFollowUpItem
import work.starlings.contracts.InboxForwardedItem
import work.starlings.contracts.InboxGuestItem
import work.starlings.contracts.InboxInterestItem
import work.starlings.contracts.InboxInvitationItem
import work.starlings.contracts.InboxItem
import work.starlings.contracts.InboxQuestionItem
import work.starlings.contracts.InboxSubjectRefKind
import work.starlings.contracts.InboxSubmissionItem
import work.starlings.contracts.InboxSupportItem
import work.starlings.contracts.InboxTaskItem
import work.starlings.contracts.ThreadSummaryWire
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * Where a Home row goes, as the web path of the destination: the same
 * address a link copied from the browser names (`web/src/work-hrefs.ts`,
 * `inbox-rows.tsx` `inboxItemHref`, `conversation-model.ts` `threadHref`,
 * `search-doors.ts` `hrefForDoor`, `owner-agenda.ts` `calendarEventHref`).
 * A path is a permalink (`packages/contracts/src/permalinks.ts`); the tab
 * that receives it reads it with `rememberWorkspaceRoute`.
 */
object HomeLinks {
    /** Work's own page: INBOX at the top. */
    const val WORK = "/work"
    const val MINE = "/work/mine"
    const val CALENDAR = "/calendar"

    private val issueId = Regex("^([^/#\\s]+)/([^/#\\s]+)#(\\d+)$")

    /** JavaScript's `encodeURIComponent`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )`. */
    fun encode(value: String): String {
        val out = StringBuilder()
        for (byte in value.toByteArray(Charsets.UTF_8)) {
            val ch = byte.toInt().toChar()
            val b = byte.toInt() and 0xff
            if (b < 0x80 && (ch.isLetterOrDigit() || ch in "-_.!~*'()")) out.append(ch) else out.append('%').append("%02X".format(b))
        }
        return out.toString()
    }

    private fun query(path: String, extra: List<Pair<String, String>>): String =
        if (extra.isEmpty()) path else path + "?" + extra.joinToString("&") { (k, v) -> "${formEncode(k)}=${formEncode(v)}" }

    /** `URLSearchParams`: a space is `+`. */
    private fun formEncode(value: String): String = encode(value).replace("%20", "+")

    private fun permalink(surface: String, kind: String, id: String) = "/$surface/$kind/${encode(id)}"

    fun task(id: String): String = permalink("work", "task", id)

    fun subject(kind: String, id: String, extra: List<Pair<String, String>> = emptyList()): String =
        query(permalink("work", kind, id), extra)

    fun subjectTask(taskId: String, kind: String, subjectId: String): String =
        subject(kind, subjectId, listOf("pane" to "tasks", "task" to taskId, "edit" to "task"))

    /** `issueHref`: `owner/repo#n` as its path; any other id is Work itself. */
    fun issue(id: String): String {
        val m = issueId.matchEntire(id) ?: return WORK
        return "/work/issue/${encode(m.groupValues[1])}/${encode(m.groupValues[2])}/${m.groupValues[3]}"
    }

    fun contact(id: String): String = permalink("work", "contact", id)
    fun document(id: String): String = permalink("docs", "document", id)
    fun teamThread(id: String): String = permalink("team", "thread", id)

    /** `peerHref`: the address's local part names the person. */
    fun peer(email: String, agent: Boolean): String {
        val address = email.trim().lowercase()
        val at = address.lastIndexOf('@')
        return permalink("team", if (agent) "agent" else "person", if (at > 0) address.substring(0, at) else address)
    }

    /** `eventHref`: `calendarId:eventId`, and the day whose week Calendar loads first. */
    fun event(id: String, day: LocalDate? = null): String =
        query(permalink("calendar", "event", id), listOfNotNull(day?.let { "day" to it.toString() }))

    /** `calendarEventHref`: the event's own day, in this device's zone. */
    fun calendarEvent(id: String, start: String, zone: ZoneId = ZoneId.systemDefault()): String =
        event(id, Upcoming.parse(start)?.let { Instant.ofEpochMilli(it).atZone(zone).toLocalDate() })

    /** `threadHref`: a subject's channel opens on its Talk pane; anything else is Team's. */
    fun thread(thread: ThreadSummaryWire): String {
        if (!thread.kind.isSubjectChannel) return teamThread(thread.id)
        val parent = thread.parentId ?: return WORK
        return subject(thread.kind.value, parent, listOf("pane" to "talk"))
    }

    /** `inboxItemHref`: the pane that resolves the item, or Work itself. */
    fun inboxItem(item: InboxItem, zone: ZoneId = ZoneId.systemDefault()): String = when (item) {
        // A proposal on a partner is not the caller's task yet: its subject's Tasks pane holds it.
        is InboxTaskItem ->
            if (item.subject.kind == InboxSubjectRefKind.ORGANIZATION) subject(item.subject.kind.value, item.subject.id, listOf("pane" to "tasks"))
            else task(item.task.id)
        is InboxCardItem -> when {
            item.issue != null -> issue(item.issue!!.id)
            item.task != null -> subjectTask(item.task!!.id, item.subject.kind.value, item.subject.id)
            else -> subject(item.subject.kind.value, item.subject.id)
        }
        is InboxFollowUpItem -> query(WORK, listOf("followup" to item.meeting.id))
        is InboxCommentItem -> item.subject?.let { subject(it.kind.value, it.id, listOf("pane" to "documents")) } ?: WORK
        is InboxBookingItem -> {
            val google = item.booking.googleEventId
            if (item.change == InboxBookingChange.CANCELLED || google == null) WORK
            else event("primary:$google", runCatching { LocalDate.parse(item.booking.startTime.take(10)) }.getOrNull())
        }
        is InboxInvitationItem -> event(item.event.id, startDay(item.event.start, zone))
        is InboxForwardedItem -> startDay(item.event.start, zone)?.let { query(CALENDAR, listOf("day" to it.toString())) } ?: CALENDAR
        is InboxInterestItem -> item.submission.lead?.let { subject(it.kind.value, it.id) } ?: WORK
        is InboxSubmissionItem -> item.submission.lead?.let { subject(it.kind.value, it.id) } ?: WORK
        is InboxCommercialItem -> subject(item.subject.kind.value, item.subject.id)
        is InboxQuestionItem -> query(WORK, listOf("question" to item.request.id))
        is InboxDecisionItem -> query(WORK, listOf("decision" to item.ask.id))
        is InboxGuestItem -> if (item.subject.id == "intake") teamThread(item.threadId) else subject(item.subject.kind.value, item.subject.id)
        is InboxSupportItem -> query(WORK, listOf("help" to item.conversationId))
        else -> WORK
    }

    private fun startDay(start: String, zone: ZoneId): LocalDate? =
        Upcoming.parse(start)?.let { Instant.ofEpochMilli(it).atZone(zone).toLocalDate() }

    /**
     * `hrefForDoor`: where a search row's door goes on this client. Null for
     * a door this client has no page for (a Core entity, a verb it cannot run).
     */
    fun door(door: SearchDoor, roomSlug: String?): String? = when (door) {
        is SearchDoor.Destination -> when (door.destination) {
            SearchDestination.HOME -> "/"
            SearchDestination.CALENDAR -> CALENDAR
            SearchDestination.WORK -> WORK
            SearchDestination.TEAM -> "/team"
            SearchDestination.DOCS -> "/docs"
        }
        is SearchDoor.Settings -> "/settings#settings-${door.page.wire}"
        is SearchDoor.Verb -> when (door.verb) {
            SearchVerb.NEW_DOCUMENT -> "/docs?new=document"
            SearchVerb.START_ROOM -> roomSlug?.let { "/room/${encode(it)}" }
            SearchVerb.OPEN_INTERNAL_ROOM -> "/room/team"
            else -> null
        }
        is SearchDoor.Subject -> subject(door.subjectKind.wire, door.id)
        is SearchDoor.Thing -> when (door.to) {
            SearchKind.PERSON -> peer(door.id, agent = false)
            SearchKind.AGENT -> peer(door.id, agent = true)
            SearchKind.CONTACT -> contact(door.id)
            SearchKind.THREAD -> teamThread(door.id)
            SearchKind.DOCUMENT -> document(door.id)
            SearchKind.FOLDER -> query("/docs", listOf("folder" to door.id))
            SearchKind.EVENT -> event(door.id)
            SearchKind.TASK -> task(door.id)
            SearchKind.ISSUE -> issue(door.id)
            else -> null
        }
    }

    /** The tab a path belongs to, by its first segment; null for a page that is no tab (a room, Settings). */
    fun surface(path: String): MemberSurface? {
        val first = path.removePrefix("/").substringBefore('/').substringBefore('?').substringBefore('#')
        if (first.isEmpty()) return MemberSurface.HOME
        return MemberSurface.entries.firstOrNull { it.id == first }
    }
}
