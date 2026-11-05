package work.starlings.android.workspace.work

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.AttentionRequest
import work.starlings.contracts.AttentionState
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.InboxCommercialItem
import work.starlings.contracts.InboxItem
import work.starlings.contracts.InboxDecisionItem
import work.starlings.contracts.InboxResponse
import work.starlings.contracts.InboxTaskItem
import work.starlings.contracts.WireJson
import work.starlings.android.workspace.home.HomeInbox
import work.starlings.android.workspace.home.HomeLinks
import java.io.File
import java.time.LocalDate

/** [WorkInbox], [DecisionLines] and [QuestionDraft] against `fixtures/`. */
class WorkInboxTest {
    private val fixtures = File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set"))

    private fun inbox(): InboxResponse = WireJson.decodeFromString(InboxResponse.serializer(), File(fixtures, "responses/crm-inbox.json").readText())

    @Test
    fun filterSourcesFollowTheRegistry() {
        val table = Json.parseToJsonElement(File(fixtures, "inbox-values.json").readText()).jsonObject["sources"]!!.jsonArray
            .map { it.jsonObject["source"]!!.jsonPrimitive.content }
        assertEquals(table, WorkInbox.filterSources)
    }

    @Test
    fun theFixtureDrawsAndFilters() {
        val response = inbox()
        val drawn = WorkInbox.drawn(response)
        assertEquals(listOf("decision", "task", "task"), drawn.map(WorkInbox::filterSource))
        assertEquals(2, drawn.count { WorkInbox.matchesFilter(it, "task") })
        assertEquals(3, drawn.count { WorkInbox.matchesFilter(it, WorkInbox.ALL) })
        val first = drawn.first() as InboxDecisionItem
        val rest = WorkInbox.removing(response, first.key)
        assertEquals(2, WorkInbox.drawn(rest).size)
        val task = drawn[1] as InboxTaskItem
        assertEquals(1, WorkInbox.searched(response, task.task.title).count { it is InboxTaskItem && it.task.id == task.task.id })
        assertTrue(WorkInbox.searched(response, "zzzz-nothing").isEmpty())
    }

    @Test
    fun decisionLines() {
        val ask = (WorkInbox.drawn(inbox()).first() as InboxDecisionItem).ask
        val label = DecisionLines.recommendedLabel(ask)
        assertEquals(ask.options.firstOrNull { it.key == ask.recommendation }?.label ?: ask.recommendation, label)
        assertEquals(LocalDate.of(2026, 10, 3), DecisionLines.day("2026-10-03"))
        assertNull(DecisionLines.day("soon"))
    }

    private fun request(state: String = "open", revision: Int = 1, mode: String = "single") = WireJson.decodeFromString(
        AttentionRequest.serializer(),
        """{"id":"a1","kind":"question","state":"$state","revision":$revision,"origin":{"type":"thread_question","thread_id":"t","message_id":"m"},
           "recipient_email":"Ada@Example.com","asked_by_email":"vocab@example.com","asked_by":"Vocab","prompt":"Ship it?",
           "options":[{"id":"y","label":"Yes"},{"id":"n","label":"No"}],"selection_mode":"$mode","allows_custom_answer":false,
           "links":[],"created_at":"2026-10-01T10:00:00Z"}""",
    )

    @Test
    fun questionDraftFollowsAttentionQuestionState() {
        var draft = QuestionDraft(request())
        assertFalse("no answer before a fresh read", draft.canAnswer("ada@example.com"))
        draft = draft.copy(fresh = true)
        assertTrue(draft.canAnswer("ada@example.com"))
        assertFalse(draft.canAnswer("bob@example.com"))
        assertEquals(setOf("y"), draft.toggle("y").selected)
        assertEquals(setOf("n"), draft.toggle("y").toggle("n").selected)
        assertEquals(draft, draft.toggle("other"))

        var many = QuestionDraft(request(mode = "multiple"), fresh = true).toggle("n").toggle("y")
        assertEquals(listOf("y", "n"), many.chosen)
        many = many.toggle("n")
        assertEquals(listOf("y"), many.chosen)

        val older = draft.toggle("y").adopt(request(revision = 0, state = "answered"))
        assertEquals(AttentionState.OPEN, older.request.state)
        val resolved = draft.toggle("y").adopt(request(revision = 2, state = "answered"))
        assertEquals(AttentionState.ANSWERED, resolved.terminal)
        assertTrue(resolved.selected.isEmpty())
        assertFalse(resolved.canAnswer("ada@example.com"))
    }

    private fun commercial(event: String, due: String, kind: String = "organization", payload: String) = WireJson.decodeFromString(
        InboxItem.serializer(),
        """{"source":"commercial","key":"commercial:$event:x1","at":1761900000000,"event":"$event",
           "subject":{"kind":"$kind","id":"o1","title":"Acme"},"due":"$due",$payload}""",
    ) as InboxCommercialItem

    @Test
    fun commercialRowsSayOfferRenewsOrPassed() {
        val today = LocalDate.of(2026, 10, 31)
        val offer = commercial("offer_expiring", "2026-10-30", payload = """"offer":{"id":"x1","title":"Pilot","total_amount":12000,"currency":"EUR"}""")
        val renews = commercial("license_renewal", "2026-10-31", payload = """"license":{"id":"x1","product":"Signals","is_active":true}""")
        val passed = commercial("license_renewal", "2026-10-30", kind = "lead", payload = """"license":{"id":"x1","product":"Signals","is_active":true}""")
        assertEquals(WorkInbox.CommercialLine.OFFER_EXPIRES, WorkInbox.commercialLine(offer, today))
        assertEquals(WorkInbox.CommercialLine.LICENSE_RENEWS, WorkInbox.commercialLine(renews, today))
        assertEquals(WorkInbox.CommercialLine.RENEWAL_PASSED, WorkInbox.commercialLine(passed, today))
        assertEquals(SubjectRef(CrmSubjectKind.ORGANIZATION, "o1", "Acme"), WorkInbox.commercialSubject(offer))
        assertEquals(CrmSubjectKind.LEAD, WorkInbox.commercialSubject(passed).kind)
        assertEquals("commercial:offer_expiring:x1", WorkInbox.key(offer))
        assertEquals("commercial", WorkInbox.filterSource(offer))
        assertEquals(listOf("Acme", "Pilot"), WorkInbox.searchTexts(offer))
        assertEquals("/work/organization/o1", HomeLinks.inboxItem(offer))
        assertEquals(listOf(offer), HomeInbox.forHomeCard(listOf(offer)))
    }
}
