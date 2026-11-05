package work.starlings.android.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import work.starlings.contracts.AttentionResolveInput
import work.starlings.contracts.AttentionResolveInputAction
import work.starlings.contracts.CrmIssueCreate
import work.starlings.contracts.CrmIssueUpdate
import work.starlings.contracts.QuickNotePromote
import work.starlings.contracts.QuickNotePromotionKind
import java.io.File

/** [WorkExtraRoutes] against `fixtures/routes.json`, the way `RouteFixtureTest` holds the other areas. */
class WorkExtraRoutesTest {
    private val routes: List<Route<*>> = WorkExtraRoutesSamples.all

    @Test
    fun everyRouteIsOneTheWorkerAnswers() {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        val table = Json.parseToJsonElement(File(dir, "routes.json").readText()).jsonObject["routes"]!!.jsonArray.map { it.jsonPrimitive.content }
        val patterns = table.map { line ->
            val (method, path) = line.split(' ', limit = 2)
            method to path.trim('/').split('/')
        }
        val unanswered = routes.filterNot { route ->
            val segments = listOf("api") + route.path
            patterns.any { (method, pattern) ->
                (method == "*" || method == route.method) && pattern.size == segments.size &&
                    pattern.zip(segments).all { (p, s) -> p == "{}" || p == s }
            }
        }.map { it.signature }
        assertEquals("routes the Worker does not answer", emptyList<String>(), unanswered)
    }

    @Test
    fun bodiesFollowSwift() {
        assertEquals("""{"answer":"flag"}""", WorkExtraRoutes.answerDecision("d1", "flag", "  ").body)
        assertEquals("""{"answer":"flag","note":"why"}""", WorkExtraRoutes.answerDecision("d1", "flag", " why ").body)
        assertEquals("POST", WorkExtraRoutes.setInboxItemDismissed("booking:1", true).method)
        assertEquals("DELETE", WorkExtraRoutes.setInboxItemDismissed("booking:1", false).method)
        assertEquals(listOf("project_id" to "p1", "include_closed" to "true"), WorkExtraRoutes.goals("p1", true).query)
        assertEquals("""{"body":"Call Rosa","source":"work","id":"n1","captured_at":1}""", WorkExtraRoutes.createQuickNote("Call Rosa", "n1", 1).body)
        // The picture's bytes are the body, sent by TeamMedia; the route itself carries none, and sends Origin.
        val upload = WorkExtraRoutes.uploadIssueImage()
        assertEquals("PUT", upload.method)
        assertEquals(null, upload.body)
        assertEquals(true, upload.origin)
        assertEquals("PATCH", WorkExtraRoutes.updateContact("c1", work.starlings.contracts.CrmContactUpdate(name = "Rosa")).method)
    }
}

/** One of each route this area adds, for the table check. */
internal object WorkExtraRoutesSamples {
    private val followUp = work.starlings.contracts.InboxFollowUpItem(
        key = "followup:m1", at = 1, meeting = work.starlings.contracts.InboxFollowUpItemMeeting("rosa", "m1", "Kickoff"),
        subject = work.starlings.contracts.InboxSubjectRef(work.starlings.contracts.InboxSubjectRefKind("project"), "p1", "Atlas"),
        recipients = emptyList(), draft = work.starlings.contracts.MeetingFollowUpDraft("S", "B"), revision = 1, tasks = emptyList(), expiresAt = 2,
    )

    val all: List<Route<*>> get() = listOf(
        WorkExtraRoutes.answerDecision("d1", "a", null),
        WorkExtraRoutes.attentionRequest("a1"),
        WorkExtraRoutes.resolveAttention("a1", AttentionResolveInput(AttentionResolveInputAction.DISMISS)),
        WorkExtraRoutes.setInboxItemDismissed("booking:1", true),
        WorkExtraRoutes.setInboxItemDismissed("booking:1", false),
        WorkExtraRoutes.setSalesInboxDismissed("t1", true),
        WorkExtraRoutes.createQuickNote("Call Rosa", "n1", 1),
        WorkExtraRoutes.deleteQuickNote("n1"),
        WorkExtraRoutes.promoteQuickNote("n1", QuickNotePromote(QuickNotePromotionKind.TASK, "t1")),
        WorkExtraRoutes.createIssue(CrmIssueCreate(projectId = "p1", title = "Bug")),
        WorkExtraRoutes.updateIssue(CrmIssueUpdate(owner = "o", repo = "r", number = 7)),
        WorkExtraRoutes.goals("p1", includeClosed = true),
        WorkExtraRoutes.issue("o", "r", 7),
        WorkExtraRoutes.contactList("rosa"),
        WorkExtraRoutes.contact("c1"),
        WorkExtraRoutes.issues(work.starlings.contracts.CrmIssueQuery(projectId = "p1")),
        WorkExtraRoutes.issueFacets("o", "r"),
        WorkExtraRoutes.approveFollowUp(followUp, listOf("t1"), emptyList()),
        WorkExtraRoutes.dismissFollowUp(followUp),
        WorkExtraRoutes.createSubject(work.starlings.contracts.CrmLeadCreate(startDate = "2026-10-28")),
        WorkExtraRoutes.organizations("acme"),
        WorkExtraRoutes.createOrganization("Acme"),
        WorkExtraRoutes.contactSearch("rosa"),
        WorkExtraRoutes.projectRepos("p1"),
        WorkExtraRoutes.githubRepos("star"),
        WorkExtraRoutes.addProjectRepo(work.starlings.contracts.CrmProjectRepoCreate(projectId = "p1", owner = "o", repo = "r")),
        WorkExtraRoutes.updateContact("c1", work.starlings.contracts.CrmContactUpdate(name = "Rosa")),
        WorkExtraRoutes.contactOptions(),
        WorkExtraRoutes.uploadIssueImage(),
        WorkExtraRoutes.deleteContact("c1"),
        WorkExtraRoutes.mergeContacts(listOf("c1", "c2")),
        SubjectRoutes.updateOrganization("o1", work.starlings.contracts.CrmOrganizationUpdate(name = "Acme")),
        SubjectRoutes.mergeOrganizations(listOf("o1", "o2")),
        SubjectRoutes.deleteOrganization("o1"),
        SubjectRoutes.decisions(work.starlings.contracts.CrmSubjectKind.PROJECT, "p1"),
        SubjectRoutes.createDecision(work.starlings.contracts.CrmDecisionCreate(subjectId = "p1", body = "Ship it")),
        SubjectRoutes.createGoal(work.starlings.contracts.CrmGoalCreate(projectId = "p1", title = "Launch")),
        SubjectRoutes.updateGoal("g1", work.starlings.contracts.CrmGoalUpdate()),
        SubjectRoutes.interactions(work.starlings.contracts.CrmInteractionsQuery(projectId = "p1")),
        SubjectRoutes.leadSubmission("l1"),
        SubjectRoutes.commercial(work.starlings.contracts.CrmSubjectKind.LEAD, "l1"),
        SubjectRoutes.createInteraction(
            work.starlings.contracts.CrmInteractionCreate(
                type = work.starlings.contracts.CrmInteractionCreateType.CALL, title = "Call", occurredAt = "2026-10-29T10:00:00.000Z",
            ),
        ),
        SubjectRoutes.updateInteraction("i1", work.starlings.contracts.CrmInteractionUpdate(title = "Call")),
        SubjectRoutes.deleteInteraction("i1"),
        SubjectRoutes.updateProject("p1", work.starlings.contracts.CrmProjectUpdate(title = "Site")),
        SubjectRoutes.updateLead("l1", work.starlings.contracts.CrmLeadUpdate()),
        SubjectRoutes.setResponsible(work.starlings.contracts.CrmSubjectKind.PROJECT, "p1", "ana@x.co"),
    )
}
