package work.starlings.android.workspace.team

import work.starlings.android.CalendarDates
import work.starlings.android.api.StarlingsApiError
import work.starlings.android.workspace.calendar.CalendarAvailability
import work.starlings.android.workspace.work.TaskKeys
import work.starlings.android.workspace.work.TaskStatus
import work.starlings.android.workspace.work.SubjectRef
import work.starlings.contracts.CalendarFreeBusyPerson
import work.starlings.contracts.ControlErrorCodeValue
import work.starlings.contracts.CrmMyTaskWire
import java.time.LocalDate
import java.time.ZoneId

/**
 * The About sheet's rules for a colleague's day and the work you share,
 * as `PeerScheduleBlock`, `PeerDaySchedule` and `PeerScheduleNote` of
 * `Sources/PeerPresence.swift` and `sharedSubjects` of
 * `iOS/MobilePeerInfoView.swift`. Titles, attendees and places never cross
 * the peer boundary: a day is opaque blocks.
 */
data class PeerScheduleBlock(val kind: Kind, val start: Long, val end: Long) {
    enum class Kind { AVAILABLE, BUSY }
}

object PeerDaySchedule {
    /** Today, midnight to midnight in [zone]: busy time merged, and the gaps between as available. */
    fun today(person: CalendarFreeBusyPerson, now: Long, zone: ZoneId): List<PeerScheduleBlock> {
        val day = java.time.Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val window = window(day, zone)
        val blocks = mutableListOf<PeerScheduleBlock>()
        var cursor = window.start
        for (busy in CalendarAvailability.busy(listOf(person), window, zone)) {
            if (cursor < busy.start) blocks += PeerScheduleBlock(PeerScheduleBlock.Kind.AVAILABLE, cursor, busy.start)
            blocks += PeerScheduleBlock(PeerScheduleBlock.Kind.BUSY, busy.start, busy.end)
            cursor = maxOf(cursor, busy.end)
        }
        if (cursor < window.end) blocks += PeerScheduleBlock(PeerScheduleBlock.Kind.AVAILABLE, cursor, window.end)
        return blocks
    }

    fun window(day: LocalDate, zone: ZoneId) =
        CalendarAvailability.Span(CalendarDates.startOfDay(day, zone), CalendarDates.startOfDay(day.plusDays(1), zone))
}

/** What a schedule says when it is not a list of blocks: one sentence per cause. */
object PeerScheduleNote {
    enum class Unreadable { NOT_SHARED, UNAVAILABLE }

    /** Google answers `notFound` for a calendar the caller may not see: a fact about sharing, not an error. */
    fun unreadable(error: String): Unreadable =
        if (error == "not_shared" || error == "notFound") Unreadable.NOT_SHARED else Unreadable.UNAVAILABLE

    enum class Failure { NOT_CONNECTED, GOOGLE_EXPIRED, SIGN_IN_EXPIRED, FAILED }

    /** `Failure.classify` over `CalendarRefreshFailure.classify`. */
    fun classify(error: Throwable): Failure {
        if (error is StarlingsApiError.SignedOut || error is StarlingsApiError.SessionRefused) return Failure.SIGN_IN_EXPIRED
        val code = (error as? StarlingsApiError.Service)?.serverCode
        return when (code) {
            ControlErrorCodeValue.OWNER_AUTH_REQUIRED -> Failure.SIGN_IN_EXPIRED
            ControlErrorCodeValue.CALENDAR_EXPIRED -> Failure.GOOGLE_EXPIRED
            ControlErrorCodeValue.CALENDAR_NOT_CONNECTED -> Failure.NOT_CONNECTED
            else -> Failure.FAILED
        }
    }
}

/** One subject both of you have open tasks on: `SharedSubject`. */
data class SharedSubject(val key: String, val subject: SubjectRef, val theirs: Int, val mine: Int)

object SharedWork {
    /** `subjectKey`: the first id that files the task. */
    fun key(task: CrmMyTaskWire): String? = task.projectId ?: task.leadId ?: task.eventId ?: TaskKeys.of(task).partnerOrganizationId

    /** Subjects where both lists hold an open task, the busiest first. */
    fun subjects(mine: List<CrmMyTaskWire>, theirs: List<CrmMyTaskWire>): List<SharedSubject> {
        fun grouped(tasks: List<CrmMyTaskWire>) =
            tasks.filter { !TaskStatus.of(it.status).isFinished }.mapNotNull { t -> key(t)?.let { it to t } }.groupBy({ it.first }, { it.second })
        val mineBy = grouped(mine)
        return grouped(theirs).mapNotNull { (key, their) ->
            val my = mineBy[key] ?: return@mapNotNull null
            val source = their.first()
            val subject = TaskKeys.of(source).subject(source.subjectTitle) ?: return@mapNotNull null
            SharedSubject(key, subject, their.size, my.size)
        }.sortedByDescending { it.theirs + it.mine }
    }
}
