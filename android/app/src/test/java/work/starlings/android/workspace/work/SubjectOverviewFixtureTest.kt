package work.starlings.android.workspace.work

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import work.starlings.contracts.CrmSubjectDetailWireRelationshipsItem as Relationship
import work.starlings.contracts.CrmSubjectKind
import java.io.File

/**
 * Overview's tables against the fixtures the Swift and web clients read:
 * [OverviewGroup] (`subject-overview-groups.json`), [ContextBlock]
 * (`subject-context.json`) and [Responsible] (`responsible.json`).
 */
class SubjectOverviewFixtureTest {
    private fun fixture(name: String): JsonObject = Json.parseToJsonElement(
        File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set"), name).readText(),
    ).jsonObject

    private fun ids(element: kotlinx.serialization.json.JsonElement) = element.jsonArray.map { it.jsonPrimitive.content }

    @Test
    fun overviewGroupsFollowTheTable() {
        val table = fixture("subject-overview-groups.json")
        assertEquals(ids(table["groups"]!!), OverviewGroup.entries.map { it.id })
        val layout = table["layout"]!!.jsonObject
        assertEquals(layout.keys, OverviewGroup.layout.keys)
        layout.forEach { (kind, groups) -> assertEquals(kind, ids(groups), OverviewGroup.layout.getValue(kind).map { it.id }) }
        val needs = table["needs"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }
        assertEquals(needs, OverviewGroup.entries.mapNotNull { g -> g.need?.let { g.id to it.name.lowercase() } }.toMap())
        val showAll = table["showAll"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }
        assertEquals(showAll, OverviewGroup.entries.mapNotNull { g -> g.showAll?.let { g.id to it.id } }.toMap())
    }

    @Test
    fun aGroupWaitsForWhatItNeeds() {
        assertEquals(
            listOf(OverviewGroup.GOALS, OverviewGroup.TASKS, OverviewGroup.CONTACTS, OverviewGroup.DECISIONS, OverviewGroup.HISTORY, OverviewGroup.RELATED),
            OverviewGroup.groups(CrmSubjectKind.PROJECT, emptySet()),
        )
        // An event has no Documents, whatever the workspace has: Docs has no event subject.
        assertEquals(
            listOf(OverviewGroup.TASKS, OverviewGroup.DECISIONS),
            OverviewGroup.groups(CrmSubjectKind.EVENT, setOf(OverviewGroup.Need.DOCS, OverviewGroup.Need.REPO)),
        )
    }

    @Test
    fun offersAndLicensesWaitForTheirModules() {
        val both = setOf(OverviewGroup.Need.OFFERS, OverviewGroup.Need.LICENSES)
        assertEquals("absent work_modules turns every module on", both, OverviewGroup.moduleNeeds(null))
        assertEquals(setOf(OverviewGroup.Need.OFFERS), OverviewGroup.moduleNeeds(listOf("sales", "offers")))
        assertEquals(emptySet<OverviewGroup.Need>(), OverviewGroup.moduleNeeds(emptyList()))
        assertEquals(
            listOf(OverviewGroup.TASKS, OverviewGroup.CONTACTS, OverviewGroup.OFFERS, OverviewGroup.LICENSES, OverviewGroup.DECISIONS, OverviewGroup.HISTORY, OverviewGroup.RELATED),
            OverviewGroup.groups(CrmSubjectKind.ORGANIZATION, both),
        )
        assertEquals(
            listOf(OverviewGroup.SUBMISSION, OverviewGroup.TASKS, OverviewGroup.CONTACTS, OverviewGroup.LICENSES, OverviewGroup.DECISIONS, OverviewGroup.HISTORY, OverviewGroup.RELATED),
            OverviewGroup.groups(CrmSubjectKind.LEAD, OverviewGroup.moduleNeeds(listOf("licenses"))),
        )
        assertEquals(false, OverviewGroup.OFFERS in OverviewGroup.groups(CrmSubjectKind.PROJECT, both))
    }

    @Test
    fun anActiveLicenseRenewingWithin30DaysAsksForAttention() {
        val today = java.time.LocalDate.of(2026, 10, 31)
        assertEquals(true, CommercialRows.renewsSoon(true, today.plusDays(30), today))
        assertEquals(false, CommercialRows.renewsSoon(true, today.plusDays(31), today))
        assertEquals("a passed renewal day still asks", true, CommercialRows.renewsSoon(true, today.minusDays(2), today))
        assertEquals("an inactive license does not", false, CommercialRows.renewsSoon(false, today.plusDays(3), today))
        assertEquals(false, CommercialRows.renewsSoon(true, null, today))
    }

    @Test
    fun commercialIsOneReadPerSubject() {
        val route = work.starlings.android.api.SubjectRoutes.commercial(CrmSubjectKind.LEAD, "l1")
        assertEquals("GET", route.method)
        assertEquals(listOf("crm", "subjects", "lead", "l1", "commercial"), route.path)
    }

    @Test
    fun contextBlocksAreWhatIosDraws() {
        val table = fixture("subject-context.json")
        assertEquals(ids(table["blocks"]!!), ContextBlock.entries.map { it.id })
        table["layout"]!!.jsonObject.forEach { (kind, blocks) -> assertEquals(kind, ids(blocks), ContextBlock.layout.getValue(kind).map { it.id }) }
        table["resolved"]!!.jsonObject.forEach { (kind, clients) ->
            assertEquals(kind, ids(clients.jsonObject["ios"]!!), ContextBlock.blocks(CrmSubjectKind(kind)).map { it.id })
        }
    }

    @Test
    fun responsibleFollowsTheCases() {
        fixture("responsible.json")["cases"]!!.jsonArray.forEach { element ->
            val case = element.jsonObject
            val name = case["name"]!!.jsonPrimitive.content
            val subject = case["subject"]!!.jsonObject
            val tasks = case["tasks"]!!.jsonArray.map {
                val task = it.jsonObject
                Responsible.Task(task["assignee_email"]?.jsonPrimitive?.contentOrNull, task["status"]!!.jsonPrimitive.content)
            }
            val got = Responsible.of(subject["kind"]!!.jsonPrimitive.content, subject["responsible_email"]?.jsonPrimitive?.contentOrNull, tasks)
            val expect = case["expect"]
            if (expect == null || expect is JsonNull) {
                assertEquals(name, null, got)
            } else {
                val e = expect.jsonObject
                assertEquals(name, Responsible(e["email"]!!.jsonPrimitive.content, e["source"]!!.jsonPrimitive.content == "chosen"), got)
            }
        }
    }

    @Test
    fun makeResponsibleIsOfferedAsIos() {
        val chosen = Responsible("ana@x.co", chosen = true)
        assertEquals(false, Responsible.offersChoice("project", "Ana@x.co", chosen))
        assertEquals(true, Responsible.offersChoice("project", "rui@x.co", chosen))
        assertEquals("a suggestion can be chosen", true, Responsible.offersChoice("lead", "ana@x.co", chosen.copy(chosen = false)))
        assertEquals(false, Responsible.offersChoice("organization", "rui@x.co", null))
        // The write names the person alone; a clear sends null.
        assertEquals(
            """{"responsible_email":"rui@x.co"}""",
            work.starlings.android.api.SubjectRoutes.setResponsible(CrmSubjectKind.PROJECT, "p1", "rui@x.co").body,
        )
        assertEquals("""{"responsible_email":null}""", work.starlings.android.api.SubjectRoutes.setResponsible(CrmSubjectKind.LEAD, "l1", null).body)
    }

    @Test
    fun aProposedTaskOffersAcceptAndDecline() {
        assertEquals(listOf(listOf("accept", "decline")), WorkRowActions.groups(WorkRowActions.Kind.TASK, "subject_proposed", mapOf("hasCore" to false)))
    }
}

/** [OverviewText.relationships]: an organization's Relationship line. */
class OrganizationRelationshipsTest {
    private val label: (Relationship) -> String? = { relationship ->
        when (relationship) {
            Relationship.CLIENT -> "Client"
            Relationship.PARTNER -> "Partner"
            Relationship.PROSPECT -> "Prospect"
            else -> null
        }
    }

    @Test
    fun joinsInTheContractOrder() {
        assertEquals("Client · Partner · Prospect", OverviewText.relationships(listOf(Relationship.PROSPECT, Relationship.CLIENT, Relationship.PARTNER), label))
        assertEquals("Partner", OverviewText.relationships(listOf(Relationship.PARTNER), label))
        assertEquals("Client · Prospect", OverviewText.relationships(listOf(Relationship.PROSPECT, Relationship.CLIENT, Relationship.CLIENT), label))
    }

    @Test
    fun nothingWhenEmptyOrNull() {
        assertNull(OverviewText.relationships(null, label))
        assertNull(OverviewText.relationships(emptyList(), label))
        assertNull("an unknown value alone draws nothing", OverviewText.relationships(listOf(Relationship("vendor")), label))
    }
}
