package work.starlings.android.workspace.home

import work.starlings.android.workspace.QuickNoteFiling
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.SearchDoor
import work.starlings.android.SearchRow
import work.starlings.android.workspace.MemberSurface
import work.starlings.android.workspace.team.TeamThreads
import work.starlings.contracts.CrmMyWorkResponse
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import work.starlings.contracts.Patch
import work.starlings.contracts.QuickNotePromotionKind
import work.starlings.contracts.InboxResponse
import work.starlings.contracts.InboxTaskItem
import work.starlings.contracts.SearchResponseWire
import work.starlings.contracts.ThreadsResponse
import work.starlings.contracts.WireJson
import java.io.File
import java.time.LocalDate
import java.time.ZoneOffset

/** Home's hand-over modules, against `fixtures/responses/` and the web paths they mirror. */
class HomeWorkTest {
    private fun fixture(name: String): String {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        return File(dir, "responses/$name").readText()
    }

    private val inbox by lazy { WireJson.decodeFromString(InboxResponse.serializer(), fixture("crm-inbox.json")) }
    private val threads by lazy { WireJson.decodeFromString(ThreadsResponse.serializer(), fixture("threads.json")).threads }
    private val starred by lazy {
        WireJson.decodeFromString(SearchResponseWire.serializer(), fixture("crm-starred.json")).rows
            .mapNotNull { SearchRow.fromWire(it.kind.value, it.id, it.title, it.subtitle, it.door, it.image) }
    }

    @Test
    fun encodeIsEncodeUriComponent() {
        assertEquals("primary%3Aabc", HomeLinks.encode("primary:abc"))
        assertEquals("a%20b%2Fc%23d", HomeLinks.encode("a b/c#d"))
        assertEquals("-_.!~*'()", HomeLinks.encode("-_.!~*'()"))
        assertEquals("%C3%A9", HomeLinks.encode("é"))
    }

    @Test
    fun pathsAreTheWebPermalinks() {
        assertEquals("/work/task/t1", HomeLinks.task("t1"))
        assertEquals("/work/issue/example-org/pilot/12", HomeLinks.issue("example-org/pilot#12"))
        assertEquals("/work", HomeLinks.issue("not an issue"))
        assertEquals("/work/project/p1?pane=tasks&task=t1&edit=task", HomeLinks.subjectTask("t1", "project", "p1"))
        assertEquals("/calendar/event/primary%3Aabc?day=2026-10-07", HomeLinks.event("primary:abc", LocalDate.of(2026, 10, 7)))
        assertEquals("/calendar/event/c%3Ae?day=2026-10-07", HomeLinks.calendarEvent("c:e", "2026-10-07T23:30:00Z", ZoneOffset.UTC))
        assertEquals("/team/person/ada", HomeLinks.peer("Ada@Example.test", agent = false))
        assertEquals("/team/thread/x", HomeLinks.teamThread("x"))
    }

    @Test
    fun surfaceIsTheFirstSegment() {
        assertEquals(MemberSurface.WORK, HomeLinks.surface("/work/task/1"))
        assertEquals(MemberSurface.WORK, HomeLinks.surface("/work?decision=1"))
        assertEquals(MemberSurface.CALENDAR, HomeLinks.surface("/calendar?day=2026-10-07"))
        assertEquals(MemberSurface.TEAM, HomeLinks.surface("/team/thread/x"))
        assertEquals(MemberSurface.HOME, HomeLinks.surface("/"))
        assertNull(HomeLinks.surface("/room/team"))
        assertNull(HomeLinks.surface("/settings#settings-home"))
    }

    @Test
    fun inboxItemsGoWhereTheWebSends_them() {
        val paths = inbox.items.map { HomeLinks.inboxItem(it) }
        assertEquals("/work?decision=00000000-0000-4000-8000-000000000001", paths[0])
        assertEquals("/work/task/aaaaaaaa-0000-4000-8000-000000000004", paths[1])
    }

    @Test
    fun aDirectMessageOpensOnTeam() {
        val dm = threads.first()
        assertEquals("/team/thread/${HomeLinks.encode(dm.id)}", HomeLinks.thread(dm))
    }

    @Test
    fun inboxPinsDecisionsThenNewestFirst() {
        val rows = HomeInbox.rows(TeamThreads.of(threads, null).unread, inbox.items)
        // The decision leads although the thread is newer.
        assertTrue(rows.first() is HomeInbox.Row.Item)
        assertEquals("decision:00000000-0000-4000-8000-000000000001", rows.first().key)
        assertEquals("thread:${threads.first().id}", rows[1].key)
        // Then the tasks, newest first; the one at 0 last.
        assertEquals(listOf("task:aaaaaaaa-0000-4000-8000-000000000004", "task:aaaaaaaa-0000-4000-8000-0000000000f4"), rows.drop(2).map { it.key })
        assertEquals(3, HomeInbox.cap)
    }

    @Test
    fun theHomeCardLeavesNotesAndTalkToTheirOwnSurfaces() {
        val kept = HomeInbox.forHomeCard(inbox.items)
        assertEquals(inbox.items.size, kept.size)
        assertTrue(kept.any { it is InboxTaskItem })
    }

    @Test
    fun mineReadsLateAgainstToday() {
        val mine = WireJson.decodeFromString(CrmMyWorkResponse.serializer(), fixture("crm-mine.json"))
        val now = LocalDate.of(2026, 10, 9).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        val plan = HomeMine.plan(mine.tasks, mine.issues, now, ZoneOffset.UTC)
        assertTrue(!plan.isEmpty)
        val first = plan.rows.first()
        assertTrue(plan.isLate(first))
        assertTrue(plan.whenOf(first) is HomeMine.When.Late)
        assertTrue(plan.lateCount >= 1)
        assertTrue(HomeMine.link(first).startsWith("/work/"))
        assertEquals(5, HomeMine.cap)
    }

    @Test
    fun starredDoorsOpenTheirPermalinks() {
        assertEquals("/work/lead/aaaaaaaa-0000-4000-8000-000000000002", HomeLinks.door(starred[0].door, null))
        assertEquals("/work/task/aaaaaaaa-0000-4000-8000-000000000004", HomeLinks.door(starred[2].door, null))
        assertEquals("/work/issue/example-org/pilot/12", HomeLinks.door(starred[3].door, null))
        assertNull(HomeLinks.door(SearchDoor.parse("verb:start-room")!!, null))
        assertEquals("/room/ada", HomeLinks.door(SearchDoor.parse("verb:start-room")!!, "ada"))
    }

    @Test
    fun filingNeedsWhatEachKindNeeds() {
        val project = CrmSubjectWire(id = "p1", kind = CrmSubjectKind.PROJECT, title = "beta")
        val lead = CrmSubjectWire(id = "l1", kind = CrmSubjectKind.LEAD, title = "Alpha")
        val partner = CrmSubjectWire(id = "o1", kind = CrmSubjectKind.ORGANIZATION, title = "Gamma")
        // Starred first, then by title ignoring case.
        assertEquals(listOf("o1", "l1", "p1"), QuickNoteFiling.sorted(listOf(project, lead, partner), setOf("organization:o1")).map { it.id })
        assertEquals(listOf("p1"), QuickNoteFiling.offered(listOf(project, lead, partner), QuickNotePromotionKind.ISSUE, "").map { it.id })
        assertEquals(listOf("l1"), QuickNoteFiling.offered(listOf(project, lead, partner), QuickNotePromotionKind.TASK, "alp").map { it.id })

        assertTrue(QuickNoteFiling.canFile(QuickNotePromotionKind.TASK, "project:p1", "", "Title", busy = false))
        assertTrue(!QuickNoteFiling.canFile(QuickNotePromotionKind.TASK, "", "", "Title", busy = false))
        assertTrue(!QuickNoteFiling.canFile(QuickNotePromotionKind.TASK, "project:p1", "", "  ", busy = false))
        assertTrue(QuickNoteFiling.canFile(QuickNotePromotionKind.MESSAGE, "", "t1", "", busy = false))
        assertTrue(!QuickNoteFiling.canFile(QuickNotePromotionKind.MESSAGE, "", "t1", "", busy = true))

        val task = QuickNoteFiling.task("Call Ada", " Call Ada ", partner)
        assertEquals("Call Ada", task.title)
        assertEquals(Patch.Omit, task.notes)
        assertEquals(Patch.Value("o1"), task.organizationId)
        assertEquals(Patch.Omit, task.projectId)
        assertEquals(Patch.Value("Call Ada\nabout the pilot"), QuickNoteFiling.task("Call Ada\nabout the pilot", "Call Ada", project).notes)
        assertEquals("Call Ada", QuickNoteFiling.firstLine("\n  Call Ada  \nabout the pilot"))
    }

    @Test
    fun recentsKeepTheNewestOnceAndTheirMark() {
        val lead = starred[0]
        val withoutImage = lead.copy(image = null, title = "Renamed")
        val merged = HomeRecents.merge(HomeRecents.merge(listOf(starred[2]), lead), withoutImage)
        assertEquals(listOf(lead.key, starred[2].key), merged.map { it.key })
        assertEquals("Renamed", merged[0].title)
        assertEquals(lead.image, merged[0].image)
        assertEquals(merged, HomeRecents.decode(HomeRecents.encode(merged)))
        assertEquals(emptyList<SearchRow>(), HomeRecents.decode("not json"))
    }

    @Test
    fun aMergedIdLeavesTheRecents() {
        val rows = starred.take(3)
        val gone = rows[1]
        assertEquals(rows.filter { it.id != gone.id }, HomeRecents.replaced(rows, gone.id))
        assertEquals("an id nobody holds changes nothing", rows, HomeRecents.replaced(rows, "nobody"))
    }
}
