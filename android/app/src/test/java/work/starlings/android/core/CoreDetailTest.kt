package work.starlings.android.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.core.ui.CoreDoor
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.Locale

/**
 * The tasks checklist, the parts around a record's fields, Core's Markdown
 * and the create door, against core-kit's registry fixture
 * (`src/test/resources/core/registry-v1.json`).
 */
class CoreDetailTest {
    private val registry: CoreEntityContractData by lazy {
        val text = javaClass.classLoader!!.getResource("core/registry-v1.json")!!.readText()
        CoreJson.decodeFromString(CoreEntityContractData.serializer(), text)
    }

    private fun contract(id: String) = registry.entities.first { it.id == id }

    private fun obj(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(
        pairs.mapNotNull { (k, v) ->
            when (v) {
                null -> null
                is String -> k to JsonPrimitive(v)
                is Number -> k to JsonPrimitive(v)
                is Boolean -> k to JsonPrimitive(v)
                is JsonObject -> k to v
                else -> error("value")
            }
        }.toMap(),
    )

    private fun task(id: String, status: String, project: String? = null, due: String? = null, created: String = "2026-01-01") =
        obj("id" to id, "title" to id, "status" to status, "due_date" to due, "created_at" to created,
            "project_id" to project?.let { "p-$it" }, "project" to project?.let { obj("title" to it) })

    // MARK: Tasks checklist

    @Test
    fun checklistGroupsByProjectNoProjectLastAndHidesCancelled() {
        val records = listOf(
            task("a", "pending", "Zeta"), task("b", "pending", "alpha"), task("c", "pending"),
            task("d", "cancelled", "alpha"), task("e", "completed", "alpha"),
        )
        val sections = CoreTasks.sections(records, showCompleted = false, lingering = emptySet(), locale = Locale.US)
        assertEquals(listOf("alpha", "Zeta", null), sections.map { it.title })
        assertEquals(listOf("b"), sections[0].records.map { it.coreId })
        assertEquals(mapOf("project_id" to "p-alpha"), CoreTasks.prefill(sections[0]))
        assertEquals(emptyMap<String, String>(), CoreTasks.prefill(sections[2]))
        val shown = CoreTasks.sections(records, showCompleted = true, lingering = emptySet(), locale = Locale.US)
        assertEquals(listOf("b", "e"), shown[0].records.map { it.coreId })
        // A task ticked off just now stays, in its open place, until it fades.
        val lingering = CoreTasks.sections(listOf(task("e", "completed", "alpha"), task("b", "pending", "alpha", due = "2026-05-01")), false, setOf("e"), Locale.US)
        assertEquals(listOf("b", "e"), lingering[0].records.map { it.coreId })
        assertTrue(CoreTasks.sections(listOf(task("d", "cancelled")), true, emptySet()).isEmpty())
    }

    @Test
    fun checklistSortsOpenByDueThenDoneByRecency() {
        val sorted = CoreTasks.sorted(
            listOf(
                task("undated", "pending", created = "2026-03-01"),
                task("late", "pending", due = "2026-06-01"),
                task("soon", "pending", due = "2026-02-01"),
                obj("id" to "doneOld", "status" to "completed", "completed_at" to "2026-01-02"),
                obj("id" to "doneNew", "status" to "completed", "completed_at" to "2026-04-02"),
            ),
            lingering = emptySet(),
        )
        assertEquals(listOf("soon", "late", "undated", "doneNew", "doneOld"), sorted.map { it.coreId })
        assertEquals("completed", CoreTasks.toggledStatus(task("x", "pending")))
        assertEquals("pending", CoreTasks.toggledStatus(task("x", "completed")))
    }

    @Test
    fun dueWordsAndOwner() {
        val today = LocalDate.of(2026, 10, 29)
        assertEquals(CoreTasks.Due.Today, CoreTasks.due(task("t", "pending", due = "2026-10-29"), today))
        assertEquals(CoreTasks.Due.Tomorrow, CoreTasks.due(task("t", "pending", due = "2026-10-30"), today))
        assertEquals(CoreTasks.Due.Yesterday, CoreTasks.due(task("t", "pending", due = "2026-10-28"), today))
        assertEquals(CoreTasks.Due.Day(LocalDate.of(2026, 12, 1)), CoreTasks.due(task("t", "pending", due = "2026-12-01"), today))
        assertNull(CoreTasks.due(task("t", "pending"), today))
        assertEquals(CoreTasks.Responsible.Named("Ana"), CoreTasks.responsible(obj("responsible_party" to "team", "assignee" to obj("name" to "Ana"))))
        assertEquals(CoreTasks.Responsible.Named("bo@x.io"), CoreTasks.responsible(obj("responsible_party" to "team", "assignee" to obj("email" to "bo@x.io"))))
        assertEquals(CoreTasks.Responsible.Envisioning, CoreTasks.responsible(obj("responsible_party" to "team")))
        assertEquals(CoreTasks.Responsible.Client, CoreTasks.responsible(obj("responsible_party" to "client")))
        assertNull(CoreTasks.responsible(obj("responsible_party" to "unassigned")))
    }

    // MARK: Context cards

    @Test
    fun contextCardsAreTheRelationsToAFace() {
        val all = registry.entities
        assertEquals(listOf("organization_id"), CoreDetail.contextRelationFields(contract("licenses"), all).map { it.name })
        assertEquals(listOf("milestone_id", "contact_id"), CoreDetail.contextRelationFields(contract("tasks"), all).map { it.name })
        assertTrue(CoreDetail.contextRelationFields(contract("organizations"), all).isEmpty())
    }

    @Test
    fun contextCardReadsTheEmbeddedOrganization() {
        val license = contract("licenses")
        val field = license.field("organization_id")!!
        val source = obj("id" to "l1", "organization" to obj("id" to "o1", "name" to "Acme", "country" to "DE", "is_partner" to true, "city" to "Berlin"))
        assertEquals("o1", CoreDetail.relatedId(field, source))
        assertEquals("o2", CoreDetail.relatedId(field, obj("organization_id" to "o2")))
        assertNull(CoreDetail.relatedId(field, obj("id" to "l1")))
        val record = CoreDetail.displayRecord(field, source, resolved = null)!!
        val orgs = contract("organizations")
        assertEquals("🇩🇪 Germany", CoreDetail.cardSubtitle(orgs, record, Locale.US))
        assertEquals(listOf("Partner"), CoreDetail.flags(orgs, record))
        val rows = CoreDetail.detailRows(orgs, record, Locale.US)
        assertEquals(listOf("city"), rows.map { it.name })
        assertFalse(rows.single().block)
        assertEquals(JsonObject(mapOf("id" to JsonPrimitive("o2"))), CoreDetail.displayRecord(field, obj("organization_id" to "o2"), null))
        // Read-only, the relation row gives way to its card.
        val carded = setOf("organization_id")
        val readOnly = license.copy(capabilities = license.capabilities.copy(update = false))
        assertFalse(CoreRules.isFieldVisible(field, readOnly, obj("organization_id" to "o1", "organization" to obj("name" to "Acme")), emptyMap(), canWrite = false, carded = carded))
    }

    // MARK: Footer, license, support case

    @Test
    fun footerSkipsDeclaredStampsAndEndsWithTheId() {
        val rows = CoreDetail.footerRows(contract("tasks"), obj("id" to "t1", "created_at" to "2026-10-29T09:30:00.000Z", "updated_at" to "2026-10-29"), Locale.US, ZoneOffset.UTC)
        assertEquals(listOf(CoreDetail.FooterLabel.CREATED, CoreDetail.FooterLabel.UPDATED, CoreDetail.FooterLabel.ID), rows.map { it.first })
        assertEquals("Oct 29, 2026, 9:30 AM", rows[0].second.replace(' ', ' '))
        assertEquals("t1", rows[2].second)
        assertEquals("soon", CoreDetail.timestamp("soon"))
        assertTrue(CoreDetail.footerRows(contract("tasks"), obj(), Locale.US).isEmpty())
    }

    @Test
    fun licenseOverviewValues() {
        val license = obj("id" to "l1", "amount_eur" to 12000.4, "seats" to 25.0, "is_active" to true, "renewal_date" to "2027-01-01", "organization" to obj("name" to "Acme"))
        assertEquals("Acme", CoreDetail.licenseOrganization(contract("licenses"), license))
        assertNull(CoreDetail.licenseOrganization(contract("offers"), license))
        assertEquals("€12,000", CoreDetail.arr(license, Locale.US))
        assertEquals("€0", CoreDetail.arr(obj(), Locale.US))
        assertEquals("€300", CoreDetail.arr(obj("amount_eur" to "300"), Locale.US))
        assertEquals("25", CoreDetail.seats(license))
        assertEquals("", CoreDetail.seats(obj()))
        assertTrue(CoreDetail.licenseActive(license))
        assertFalse(CoreDetail.licenseActive(obj("is_active" to "true")))
        assertEquals("2027-01-01", CoreDetail.renewal(license))
    }

    @Test
    fun replyToCustomerIsAMailCcdToTheCaptureMailbox() {
        val case = obj("customer_email" to " ana@acme.io ", "short_id" to "SIG-0042", "subject" to "Login fails")
        assertEquals(
            "mailto:ana@acme.io?cc=cc@org.example&subject=%5BSIG-0042%5D%20Re%3A%20Login%20fails",
            CoreDetail.replyMailto(emptyMap(), case),
        )
        assertEquals(
            "mailto:bo@acme.io?cc=cc@org.example&subject=Re%3A%20Login%20fails",
            CoreDetail.replyMailto(mapOf("customer_email" to JsonPrimitive("bo@acme.io"), "short_id" to JsonPrimitive("")), case),
        )
        assertNull(CoreDetail.replyMailto(emptyMap(), obj("subject" to "x")))
    }

    // MARK: Related create

    @Test
    fun relatedCreateFillsTheLinkBack() {
        val all = registry.entities
        val org = contract("organizations")
        val contacts = org.related!!.first { it.id == "contacts" }
        val form = CoreDetail.creation(contacts, org, "o1", all, emptyMap(), "https://core.example") as CoreDetail.Creation.Form
        assertEquals("contacts", form.target.id)
        assertEquals(JsonPrimitive("o1"), form.initialValues["organization_id"])
        assertNull(form.linkField)
        // A section Core will not let this account write draws no +.
        assertNull(CoreDetail.creation(contacts.copy(access = CoreAccessState(canRead = true, canWrite = false)), org, "o1", all, emptyMap(), null))
        // An entity the registry does not carry opens Core's web page, its defaults sorted.
        val web = CoreDetail.creation(contacts, org, "o1", all.filterNot { it.id == "contacts" }, mapOf("b" to "2"), "https://core.example/") as CoreDetail.Creation.Web
        assertEquals("https://core.example/dashboard/contacts/new?b=2&organization_id=o1", web.url)
        assertEquals("Contact", CoreDetail.createEntityName(contacts, all))
    }

    @Test
    fun newDoorKeepsItsPrefillAndLink() {
        val door = CoreDoor.New("contacts", CoreFields.prefillText(mapOf("organization_id" to JsonPrimitive("o1"), "tags" to JsonArray(listOf(JsonPrimitive("a"))))), CoreDoor.New.Link("organizations", "o1", "primary_contact_id"))
        val fields = CoreDoor.encode(door)
        assertEquals(door, CoreDoor.decode { fields[it] })
        assertEquals(mapOf("organization_id" to JsonPrimitive("o1"), "tags" to JsonArray(listOf(JsonPrimitive("a")))), CoreFields.prefill(door.prefill))
        assertEquals(emptyMap<String, Any>(), CoreFields.prefill(null))
        assertEquals(emptyMap<String, Any>(), CoreFields.prefill("not json"))
        assertNull(CoreFields.prefillText(emptyMap()))
    }

    // MARK: Markdown

    @Test
    fun markdownKeepsLinesAndReadsBlocks() {
        val blocks = CoreMarkdown.blocks(
            "# Title\n#1 ref\nline one\nline two\n\n- a\n* b\n2. two\n> said\n---\n![Logo](https://x.io/l.png)\n![bad](ftp://x)\n```\ncode **raw**\n```\n```\nopen",
        )
        assertEquals(
            listOf(
                CoreMarkdown.Block.Heading("Title", 1),
                CoreMarkdown.Block.Paragraph("#1 ref"),
                CoreMarkdown.Block.Paragraph("line one"),
                CoreMarkdown.Block.Paragraph("line two"),
                CoreMarkdown.Block.Blank,
                CoreMarkdown.Block.Bullet("a"),
                CoreMarkdown.Block.Bullet("b"),
                CoreMarkdown.Block.Ordered(2, "two"),
                CoreMarkdown.Block.Quote("said"),
                CoreMarkdown.Block.Rule,
                CoreMarkdown.Block.Image("Logo", "https://x.io/l.png"),
                CoreMarkdown.Block.Paragraph("![bad](ftp://x)"),
                CoreMarkdown.Block.Code("code **raw**"),
                CoreMarkdown.Block.Code("open"),
            ),
            blocks,
        )
    }

    @Test
    fun registryMarkdownFieldsExist() {
        // The CRM space renders these as Markdown; it publishes no `svg` field and no `notes` (Docs) entity.
        assertEquals("markdown", contract("licenses").field("notes")!!.kind)
        assertTrue(registry.entities.none { e -> e.fields.any { it.kind == "svg" } })
        assertTrue(registry.entities.none { it.id == "notes" })
    }

    private fun section(entity: String, id: String) = contract(entity).related.orEmpty().first { it.id == id }

    @Test
    fun relatedPresentationFollowsTheRegistry() {
        assertEquals(CoreDetail.RelatedPresentation.List, CoreDetail.relatedPresentation(section("organizations", "contacts")))
        assertEquals(CoreDetail.RelatedPresentation.Compact, CoreDetail.relatedPresentation(section("contacts", "organization")))
        assertEquals(CoreDetail.RelatedPresentation.Timeline, CoreDetail.relatedPresentation(section("contacts", "interactions")))
        assertEquals(CoreDetail.RelatedPresentation.Cards, CoreDetail.relatedPresentation(section("projects", "deliverables")))
        val base = section("organizations", "contacts")
        assertEquals(CoreDetail.RelatedPresentation.List, CoreDetail.relatedPresentation(base.copy(presentation = null)))
        assertEquals(CoreDetail.RelatedPresentation.List, CoreDetail.relatedPresentation(base.copy(presentation = "gallery")))
    }

    @Test
    fun listDetailIsTheTagElseTheSubtitle() {
        assertEquals("Lead", CoreDetail.listDetail(CoreRelatedItem("1", "A", tag = "Lead", subtitle = "Today")))
        assertEquals("Today", CoreDetail.listDetail(CoreRelatedItem("1", "A", subtitle = "Today")))
        // An empty tag wins over the subtitle and draws no line, as `item.tag ?? item.subtitle`.
        assertNull(CoreDetail.listDetail(CoreRelatedItem("1", "A", tag = "", subtitle = "Today")))
        assertNull(CoreDetail.listDetail(CoreRelatedItem("1", "A")))
    }

    @Test
    fun timelineMarksAndLines() {
        assertEquals("envelope", CoreDetail.interactionSymbol("Email"))
        assertEquals("note.text", CoreDetail.interactionSymbol("note"))
        assertEquals("phone", CoreDetail.interactionSymbol("call"))
        assertEquals("person.2", CoreDetail.interactionSymbol("meeting"))
        assertEquals("globe", CoreDetail.interactionSymbol("web"))
        assertNull(CoreDetail.interactionSymbol("Done"))
        assertNull(CoreDetail.interactionSymbol(null))

        assertEquals(listOf("Email", "Oct 29, 2026"), CoreDetail.timelineLines(CoreRelatedItem("1", "A", tag = "email", subtitle = "Oct 29, 2026")))
        assertEquals(listOf("Call"), CoreDetail.timelineLines(CoreRelatedItem("1", "A", tag = "CALL")))
        assertEquals(listOf("Oct 29, 2026"), CoreDetail.timelineLines(CoreRelatedItem("1", "A", tag = "Done", subtitle = "Oct 29, 2026")))
        assertEquals(listOf("Done"), CoreDetail.timelineLines(CoreRelatedItem("1", "A", tag = "Done")))
        assertEquals(emptyList<String>(), CoreDetail.timelineLines(CoreRelatedItem("1", "A")))
    }
}
