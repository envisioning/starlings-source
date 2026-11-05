package work.starlings.android.workspace.search

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.SearchDoor
import work.starlings.android.SearchKind
import work.starlings.android.SearchPersonVerb
import work.starlings.android.SearchRow
import work.starlings.android.SearchRowVerb
import work.starlings.android.SearchSubjectKind
import work.starlings.android.SearchSubjectVerb
import work.starlings.android.workspace.MemberSurface
import work.starlings.android.workspace.work.WorkRoute

/** The phone's search list, as iOS `MobileSearchView` and the web's `hrefForDoor` build it. */
class SearchPaletteTest {
    private val ada = SearchRow(SearchKind.PERSON, "ada@x.work", "Ada Lovelace", "ada@x.work", SearchDoor.Thing(SearchKind.PERSON, "ada@x.work"))
    private val apollo = SearchRow(SearchKind.SUBJECT, "p1", "Apollo", "Project", SearchDoor.Subject(SearchSubjectKind.PROJECT, "p1"))
    private val doc = SearchRow(SearchKind.DOCUMENT, "d1", "Apollo brief", "Document", SearchDoor.Thing(SearchKind.DOCUMENT, "d1"))

    @Test
    fun doorRowsFollowTheVisibleTabs() {
        val doors = SearchPalette.doorRows(listOf(MemberSurface.HOME, MemberSurface.WORK, MemberSurface.TEAM))
        assertEquals(listOf("home", "work", "team", "start-room", "open-internal-room"), doors.map { it.id })
        assertTrue(doors.none { it.kind == SearchKind.SETTINGS })
    }

    @Test
    fun emptyQueryIsRecentThenGoToThenDo() {
        val doors = SearchPalette.doorRows(MemberSurface.entries)
        val ranked = SearchPalette.ranked(emptyList(), listOf(apollo, ada), doors, "  ")
        val sections = SearchPalette.emptySections(ranked, listOf(apollo, ada))
        assertEquals(listOf(apollo.key, ada.key), sections.recent.map { it.key })
        assertEquals(listOf("home", "calendar", "work", "team", "docs"), sections.goTo.map { it.id })
        assertEquals(listOf("start-room", "open-internal-room"), sections.verbs.map { it.id })
        assertTrue(SearchPalette.isEmptyQuery("   "))
    }

    @Test
    fun aHitIsNotListedTwiceWhenItIsAlsoRecent() {
        val newer = apollo.copy(subtitle = "Project · Rosa")
        val ranked = SearchPalette.ranked(listOf(newer), listOf(apollo), emptyList(), "apo")
        assertEquals(listOf(newer), ranked)
    }

    @Test
    fun docTailDropsADocumentAlreadyRanked() {
        val tail = SearchPalette.docTail(listOf(doc), listOf("d1", "d2")) { it }
        assertEquals(listOf("d2"), tail)
    }

    @Test
    fun snippetLosesItsMarks() {
        assertEquals("the apollo brief", SearchPalette.snippetText(" the <mark>apollo</mark>\n  brief "))
    }

    @Test
    fun meetAboutThisHostsARoomFiledUnderTheSubject() {
        assertTrue(SearchPalette.verbs(apollo).any { it is SearchRowVerb.Subject && it.verb == SearchSubjectVerb.START_ROOM })
        assertEquals(4, SearchPalette.verbs(apollo).size)
        assertEquals(3, SearchPalette.verbs(ada).size)
        assertEquals(
            SearchPalette.Target.MeetAbout(work.starlings.contracts.CrmSubjectKind.PROJECT, "p1", "Apollo"),
            SearchPalette.target(apollo, SearchRowVerb.Subject(SearchSubjectVerb.START_ROOM)),
        )
    }

    @Test
    fun targetsAreTheWebPaths() {
        assertEquals(SearchPalette.Target.Path(MemberSurface.WORK, "/work/project/p1"), SearchPalette.target(apollo, null))
        assertEquals(
            SearchPalette.Target.Path(MemberSurface.WORK, "/work/project/p1?pane=tasks&new=task"),
            SearchPalette.target(apollo, SearchRowVerb.Subject(SearchSubjectVerb.NEW_TASK)),
        )
        assertEquals(SearchPalette.Target.Path(MemberSurface.TEAM, "/team/person/ada"), SearchPalette.target(ada, null))
        assertEquals(
            SearchPalette.Target.Path(MemberSurface.TEAM, "/team/person/ada?do=wave"),
            SearchPalette.target(ada, SearchRowVerb.Person(SearchPersonVerb.WAVE)),
        )
        assertEquals(
            SearchPalette.Target.Path(MemberSurface.TEAM, "/team/person/ada"),
            SearchPalette.target(ada, SearchRowVerb.Person(SearchPersonVerb.MESSAGE)),
        )
        assertEquals(SearchPalette.Target.Path(MemberSurface.DOCS, "/docs/document/d1"), SearchPalette.target(doc, null))
        val home = SearchPalette.doorRows(MemberSurface.entries).first()
        assertEquals(SearchPalette.Target.Path(MemberSurface.HOME, "/"), SearchPalette.target(home, null))
        val doors = SearchPalette.doorRows(MemberSurface.entries)
        assertEquals(SearchPalette.Target.StartRoom, SearchPalette.target(doors.first { it.id == "start-room" }, null))
        assertEquals(SearchPalette.Target.OpenTeamRoom, SearchPalette.target(doors.first { it.id == "open-internal-room" }, null))
        val core = SearchRow(SearchKind.CORE, "c1", "Contacts", "Core", SearchDoor.Thing(SearchKind.CORE, "c1"))
        // A Core door opens that entity in Work, as iOS `openSearch(.core)` (#222).
        assertEquals(SearchPalette.Target.Path(MemberSurface.WORK, "/work/core/c1"), SearchPalette.target(core, null))
    }

    @Test
    fun theSearchSheetListsCoreEntitiesThatOpenInWork() {
        val entries = listOf(SearchPalette.CoreEntry("tasks", "Tasks", 12), SearchPalette.CoreEntry("offers", "Offers", null))
        assertEquals(emptyList<Any>(), SearchPalette.coreRows(false, entries) { "" })
        val rows = SearchPalette.coreRows(true, entries) { count -> if (count == null) "Core" else "Core · $count records" }
        assertEquals(listOf("Core · 12 records", "Core"), rows.map { it.subtitle })
        assertEquals(SearchDoor.Thing(SearchKind.CORE, "tasks"), rows.first().door)
        val ranked = SearchPalette.ranked(emptyList(), emptyList(), emptyList(), "task", rows)
        assertEquals(listOf("tasks"), ranked.map { it.id })
        val target = SearchPalette.target(rows.first(), null) as SearchPalette.Target.Path
        assertEquals(MemberSurface.WORK, target.surface)
        assertEquals(WorkRoute.CoreEntity("tasks"), WorkRoute.parse(target.path))
        assertEquals(WorkRoute.CoreEntity("a b"), WorkRoute.parse(WorkRoute.path(WorkRoute.CoreEntity("a b"))))
    }
}
