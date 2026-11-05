package work.starlings.android.workspace.work

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import work.starlings.contracts.CrmSubjectKind
import java.io.File

/** [SubjectPanes] against `fixtures/subject-panes.json`, the table `SubjectPanesRegistry.swift` is generated from. */
class SubjectPanesFixtureTest {
    private val fixture = Json.parseToJsonElement(
        File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set"), "subject-panes.json").readText(),
    ).jsonObject

    @Test
    fun paneIdsAndLayoutFollowTheTable() {
        val ids = fixture["panes"]!!.jsonArray.map { it.jsonObject["id"]!!.jsonPrimitive.content }
        assertEquals(ids, SubjectPane.entries.map { it.id })
        val layout = fixture["layout"]!!.jsonObject
        assertEquals(layout.keys, SubjectPanes.layout.keys)
        layout.forEach { (kind, panes) ->
            assertEquals(kind, panes.jsonArray.map { it.jsonPrimitive.content }, SubjectPanes.layout.getValue(kind).map { it.id })
        }
    }

    @Test
    fun needsFollowTheTable() {
        val needs = fixture["needs"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }
        val ours = SubjectPane.entries.mapNotNull { pane -> pane.need?.let { pane.id to it.id } }.toMap()
        assertEquals(needs, ours)
    }

    @Test
    fun aPhoneSubjectShowsWhatItDraws() {
        assertEquals(
            listOf(SubjectPane.OVERVIEW, SubjectPane.TALK, SubjectPane.BOARD, SubjectPane.TASKS, SubjectPane.INTERACTIONS, SubjectPane.DOCUMENTS, SubjectPane.FIELDS),
            SubjectPanes.shown(CrmSubjectKind.PROJECT, hasRepo = false, hasDocs = true),
        )
        assertEquals(
            listOf(SubjectPane.OVERVIEW, SubjectPane.TALK, SubjectPane.BOARD, SubjectPane.TASKS, SubjectPane.ISSUES, SubjectPane.INTERACTIONS, SubjectPane.DOCUMENTS, SubjectPane.FIELDS),
            SubjectPanes.shown(CrmSubjectKind.PROJECT, hasRepo = true, hasDocs = true),
        )
        assertEquals(listOf(SubjectPane.OVERVIEW, SubjectPane.TALK, SubjectPane.TASKS, SubjectPane.INTERACTIONS, SubjectPane.FIELDS), SubjectPanes.shown(CrmSubjectKind.LEAD, hasRepo = true, hasDocs = false))
        // A partner opens on Overview, and its own page comes before Talk, as the table orders it.
        assertEquals(
            listOf(SubjectPane.OVERVIEW, SubjectPane.PARTNER, SubjectPane.TALK, SubjectPane.TASKS, SubjectPane.INTERACTIONS, SubjectPane.DOCUMENTS, SubjectPane.FIELDS),
            SubjectPanes.shown(CrmSubjectKind.ORGANIZATION, hasRepo = false, hasDocs = true),
        )
        // An event's own page comes before Talk; an event has no History, no Fields and no Documents.
        assertEquals(
            listOf(SubjectPane.OVERVIEW, SubjectPane.EVENT, SubjectPane.TALK, SubjectPane.TASKS),
            SubjectPanes.shown(CrmSubjectKind.EVENT, hasRepo = false, hasDocs = true),
        )
    }

    @Test
    fun aRegularWidthHasNoTalkTab() {
        // `MobileSubjectView.sideBySide`: Talk is half of Overview, so only a compact width gives it a tab.
        assertEquals(
            listOf(SubjectPane.OVERVIEW, SubjectPane.TALK, SubjectPane.TASKS, SubjectPane.INTERACTIONS, SubjectPane.DOCUMENTS, SubjectPane.FIELDS),
            SubjectPanes.panes(CrmSubjectKind.LEAD, hasRepo = false, hasDocs = true, narrow = true),
        )
        assertEquals(
            listOf(SubjectPane.OVERVIEW, SubjectPane.TASKS, SubjectPane.INTERACTIONS, SubjectPane.DOCUMENTS, SubjectPane.FIELDS),
            SubjectPanes.panes(CrmSubjectKind.LEAD, hasRepo = false, hasDocs = true, narrow = false),
        )
        assertEquals(
            listOf(SubjectPane.OVERVIEW, SubjectPane.BOARD, SubjectPane.TASKS, SubjectPane.ISSUES, SubjectPane.INTERACTIONS, SubjectPane.DOCUMENTS, SubjectPane.FIELDS),
            SubjectPanes.shown(CrmSubjectKind.PROJECT, hasRepo = true, hasDocs = true, narrow = false),
        )
    }

    @Test
    fun theShownPaneFollowsMobileSubjectView() {
        val narrow = SubjectPanes.shown(CrmSubjectKind.LEAD, hasRepo = false, hasDocs = true, narrow = true)
        val wide = SubjectPanes.shown(CrmSubjectKind.LEAD, hasRepo = false, hasDocs = true, narrow = false)
        assertEquals(SubjectPane.TALK, SubjectPanes.showing(SubjectPane.TALK, narrow, narrow = true, isProject = false))
        assertEquals("Talk is half of Overview on a regular width", SubjectPane.OVERVIEW, SubjectPanes.showing(SubjectPane.TALK, wide, narrow = false, isProject = false))
        assertEquals("a lead has no Issues: Talk", SubjectPane.TALK, SubjectPanes.showing(SubjectPane.ISSUES, narrow, narrow = true, isProject = false))
        assertEquals(SubjectPane.OVERVIEW, SubjectPanes.showing(SubjectPane.BOARD, wide, narrow = false, isProject = false))
        val project = SubjectPanes.shown(CrmSubjectKind.PROJECT, hasRepo = false, hasDocs = true)
        assertEquals("Issues offers the link", SubjectPane.ISSUES, SubjectPanes.showing(SubjectPane.ISSUES, project, narrow = true, isProject = true))
    }

    @Test
    fun aPathNamesThePaneItsCreatorLivesOn() {
        assertEquals(SubjectPane.ISSUES, SubjectPanes.requested("issues", "issue"))
        assertEquals(SubjectPane.DOCUMENTS, SubjectPanes.requested("documents", "document"))
        assertEquals(SubjectPane.TASKS, SubjectPanes.requested(null, "task"))
        assertEquals(SubjectPane.ISSUES, SubjectPanes.requested("issues", null))
        assertEquals(SubjectPane.TALK, SubjectPanes.requested("talk", null))
        assertEquals(SubjectPane.OVERVIEW, SubjectPanes.requested("overview", null))
        assertEquals(SubjectPane.FIELDS, SubjectPanes.requested("fields", null))
        assertEquals(null, SubjectPanes.requested("nowhere", null))
    }
}
