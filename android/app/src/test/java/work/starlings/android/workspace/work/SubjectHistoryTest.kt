package work.starlings.android.workspace.work

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.api.SubjectRoutes
import work.starlings.contracts.CrmInteraction
import work.starlings.contracts.CrmInteractionContact
import work.starlings.contracts.CrmInteractionType
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.Patch
import work.starlings.contracts.ThreadMessageType
import work.starlings.contracts.ThreadMessageWire
import java.time.LocalDate
import java.time.ZoneOffset

/** History's timeline and the Log sheet's draft, as `MobileSubjectInteractionsView` and `CrmInteractionDraft` hold them. */
class SubjectHistoryTest {
    private val utc = ZoneOffset.UTC
    private val today = LocalDate.of(2026, 10, 29)

    private fun interaction(id: String, type: CrmInteractionType = CrmInteractionType.CALL, occurredAt: String? = null, title: String = "Call") = CrmInteraction(
        id = id, title = title, type = type, occurredAt = occurredAt, contacts = emptyList(),
    )

    private fun event(id: String, at: String) = ThreadMessageWire(
        id = id, threadId = "t", sentAt = java.time.Instant.parse(at).toEpochMilli(), senderEmail = "starlings@x.co",
        text = "Task done", isMine = false, type = ThreadMessageType.EVENT,
    )

    @Test
    fun theTimelineIsNewestFirstByDayWithUndatedLast() {
        val groups = HistoryTimeline.groups(
            listOf(
                interaction("old", occurredAt = "2026-10-20T09:00:00Z"),
                interaction("none"),
                interaction("now", occurredAt = "2026-10-29T08:00:00Z"),
            ),
            listOf(event("e", "2026-10-28T12:00:00Z")),
            InteractionFilter.ALL, today, utc,
        )
        assertEquals(
            listOf(HistoryTimeline.Day.Today, HistoryTimeline.Day.Yesterday, HistoryTimeline.Day.On(LocalDate.of(2026, 10, 20), 1_792_454_400_000), HistoryTimeline.Day.Undated),
            groups.map { it.day },
        )
        assertEquals(listOf("now", "e", "old", "none"), groups.flatMap { g -> g.rows.map { it.id } })
    }

    @Test
    fun aNarrowedFilterLeavesTheEventsOut() {
        val groups = HistoryTimeline.groups(
            listOf(interaction("call", occurredAt = "2026-10-29T08:00:00Z"), interaction("note", CrmInteractionType.NOTE, "2026-10-29T09:00:00Z")),
            listOf(event("e", "2026-10-29T10:00:00Z")),
            InteractionFilter.NOTE, today, utc,
        )
        assertEquals(listOf("note"), groups.flatMap { g -> g.rows.map { it.id } })
        assertTrue(InteractionFilter.ALL.matches(interaction("x", CrmInteractionType.EMAIL)))
        assertFalse(InteractionFilter.CALL.matches(interaction("x", CrmInteractionType.EMAIL)))
    }

    @Test
    fun aNewOneIsFiledWhereTheHistoryIs() {
        val org = Relation("o1", "Acme")
        val project = InteractionDraft.new(SubjectRef(CrmSubjectKind.PROJECT, "p1", "Site"), org, now = 0)
        assertEquals(Relation("p1", "Site"), project.project)
        assertEquals(org, project.organization)
        assertNull(project.lead)
        val lead = InteractionDraft.new(SubjectRef(CrmSubjectKind.LEAD, "l1", "Deal"), org, now = 0)
        assertEquals(Relation("l1", "Deal"), lead.lead)
        val partner = InteractionDraft.new(SubjectRef(CrmSubjectKind.ORGANIZATION, "o1", "Acme"), null, now = 0)
        assertEquals(org, partner.organization)
        assertEquals(CrmInteractionType.CALL, project.type)
        assertFalse("no title", project.canSave)
        assertTrue(project.copy(title = "Kickoff").canSave)
        assertFalse("nowhere to file it", project.copy(title = "Kickoff", project = null, organization = null).canSave)
        assertFalse("not http", project.copy(title = "Kickoff", url = "ftp://x.co").canSave)
        assertTrue(project.copy(title = "Kickoff", url = "https://x.co/a").canSave)
    }

    @Test
    fun theCreateSendsWhatIsSet() {
        val draft = InteractionDraft.new(SubjectRef(CrmSubjectKind.PROJECT, "p1", "Site"), Relation("o1", "Acme"), now = 1_793_268_000_000)
            .copy(title = "  Kickoff ", contacts = listOf(Relation("c1", "Rosa")))
        assertEquals(
            """{"type":"call","title":"Kickoff","occurred_at":"2026-10-29T10:00:00.000Z","organization_id":"o1","project_id":"p1","contact_ids":["c1"]}""",
            SubjectRoutes.createInteraction(draft.create).body,
        )
    }

    @Test
    fun anEditSendsOnlyWhatChanged() {
        val row = interaction("i1", CrmInteractionType.EMAIL, "2026-10-29T10:00:00.000Z", title = "**Intro**").copy(
            projectId = "p1", organizationId = "o1", summaryPreview = "Short", contacts = listOf(CrmInteractionContact("c1", name = "Rosa")),
        )
        val draft = InteractionDraft.editing(row, SubjectRef(CrmSubjectKind.PROJECT, "p1", "Site"))
        assertEquals("Intro", draft.title)
        assertEquals(Relation("p1", "Site"), draft.project)
        assertEquals("the organization is an id until read", listOf(CrmSubjectKind.ORGANIZATION to "o1"), draft.unnamedLinks)
        assertEquals(Relation("o1", "Acme"), draft.named(CrmSubjectKind.ORGANIZATION, "o1", "Acme").organization)
        // A connector's email keeps its own kind among the choices.
        assertEquals(InteractionDraft.LOGGABLE + CrmInteractionType.EMAIL, draft.typeOptions)
        assertEquals("""{}""", SubjectRoutes.updateInteraction("i1", draft.update).body)
        val edited = draft.copy(summary = "Notes", project = null)
        val update = edited.update
        assertEquals(Patch.Value("Notes"), update.summaryMarkdown)
        assertEquals(Patch.Null, update.projectId)
        assertEquals(Patch.Omit, update.organizationId)
        assertNull(update.title)
        assertNull(update.contactIds)
    }
}
