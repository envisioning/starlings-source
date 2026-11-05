package work.starlings.android.workspace.team

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.api.StarlingsApiError
import work.starlings.android.workspace.team.PeerScheduleBlock.Kind.AVAILABLE
import work.starlings.android.workspace.team.PeerScheduleBlock.Kind.BUSY
import work.starlings.android.workspace.work.SubjectRef
import work.starlings.contracts.CalendarBusyInterval
import work.starlings.contracts.CalendarFreeBusyPerson
import work.starlings.contracts.ControlErrorCodeValue
import work.starlings.contracts.CrmMyTaskWire
import work.starlings.contracts.CrmSubjectKind
import java.time.Instant
import java.time.ZoneOffset

class PeerScheduleTest {
    private val zone = ZoneOffset.UTC
    private val now = Instant.parse("2026-10-28T12:00:00Z").toEpochMilli()
    private fun ms(at: String) = Instant.parse(at).toEpochMilli()

    @Test
    fun aDayIsMergedBusyAndTheGapsBetween() {
        val person = CalendarFreeBusyPerson(
            "ana@x.com",
            listOf(
                CalendarBusyInterval("2026-10-28T10:00:00Z", "2026-10-28T11:00:00Z"),
                CalendarBusyInterval("2026-10-28T09:00:00Z", "2026-10-28T10:30:00Z"),
                // Yesterday into today is clipped at midnight.
                CalendarBusyInterval("2026-10-27T23:00:00Z", "2026-10-28T01:00:00Z"),
                // Backwards and outside the day: dropped.
                CalendarBusyInterval("2026-10-28T15:00:00Z", "2026-10-28T14:00:00Z"),
                CalendarBusyInterval("2026-10-29T09:00:00Z", "2026-10-29T10:00:00Z"),
            ),
            "",
        )
        val blocks = PeerDaySchedule.today(person, now, zone)
        assertEquals(
            listOf(
                PeerScheduleBlock(BUSY, ms("2026-10-28T00:00:00Z"), ms("2026-10-28T01:00:00Z")),
                PeerScheduleBlock(AVAILABLE, ms("2026-10-28T01:00:00Z"), ms("2026-10-28T09:00:00Z")),
                PeerScheduleBlock(BUSY, ms("2026-10-28T09:00:00Z"), ms("2026-10-28T11:00:00Z")),
                PeerScheduleBlock(AVAILABLE, ms("2026-10-28T11:00:00Z"), ms("2026-10-29T00:00:00Z")),
            ),
            blocks,
        )
    }

    @Test
    fun aFreeDayIsOneAvailableBlock() {
        val blocks = PeerDaySchedule.today(CalendarFreeBusyPerson("a@x.com", emptyList(), ""), now, zone)
        assertEquals(listOf(PeerScheduleBlock(AVAILABLE, ms("2026-10-28T00:00:00Z"), ms("2026-10-29T00:00:00Z"))), blocks)
    }

    @Test
    fun notesNameTheCause() {
        assertEquals(PeerScheduleNote.Unreadable.NOT_SHARED, PeerScheduleNote.unreadable("notFound"))
        assertEquals(PeerScheduleNote.Unreadable.NOT_SHARED, PeerScheduleNote.unreadable("not_shared"))
        assertEquals(PeerScheduleNote.Unreadable.UNAVAILABLE, PeerScheduleNote.unreadable("internalError"))
        fun service(code: ControlErrorCodeValue?) = StarlingsApiError.Service("x", 400, code, null)
        assertEquals(PeerScheduleNote.Failure.NOT_CONNECTED, PeerScheduleNote.classify(service(ControlErrorCodeValue.CALENDAR_NOT_CONNECTED)))
        assertEquals(PeerScheduleNote.Failure.GOOGLE_EXPIRED, PeerScheduleNote.classify(service(ControlErrorCodeValue.CALENDAR_EXPIRED)))
        assertEquals(PeerScheduleNote.Failure.SIGN_IN_EXPIRED, PeerScheduleNote.classify(StarlingsApiError.SessionRefused("x")))
        assertEquals(PeerScheduleNote.Failure.FAILED, PeerScheduleNote.classify(service(null)))
        assertEquals(PeerScheduleNote.Failure.FAILED, PeerScheduleNote.classify(IllegalStateException()))
    }

    private fun task(id: String, status: String = "pending", project: String? = null, lead: String? = null, org: String? = null, title: String? = "Atlas") =
        CrmMyTaskWire(id = id, title = id, status = status, responsibleParty = "team", projectId = project, leadId = lead, organizationId = org, subjectTitle = title)

    @Test
    fun sharedWorkIsOpenTasksOnTheSameSubject() {
        val mine = listOf(task("m1", project = "p1"), task("m2", project = "p2"), task("m3", status = "completed", project = "p3"), task("m4", org = "o1"))
        val theirs = listOf(
            task("t1", project = "p1"), task("t2", project = "p1"),
            task("t3", project = "p2"),
            task("t4", project = "p3"),
            task("t5", status = "cancelled", project = "p2"),
            task("t6", org = "o1", title = "Partner"),
            task("t7"),
        )
        val shared = SharedWork.subjects(mine, theirs)
        // Busiest first; a tie keeps the order their list gave.
        assertEquals(listOf("p1", "p2", "o1"), shared.map { it.key })
        assertEquals(SharedSubject("p1", SubjectRef(CrmSubjectKind.PROJECT, "p1", "Atlas"), 2, 1), shared.first())
        assertEquals(CrmSubjectKind.ORGANIZATION, shared.first { it.key == "o1" }.subject.kind)
        assertTrue(shared.none { it.key == "p3" })
    }
}
