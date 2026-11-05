package work.starlings.android.workspace.work

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import work.starlings.contracts.CrmIssueState
import work.starlings.contracts.CrmIssueWire
import work.starlings.contracts.CrmTeamMember
import work.starlings.contracts.CrmTeamMemberKind

/** UNOWNED's Assign to (`assignableTeam`, `CrmIssueUpdate.assignment` on iOS). */
class AssignToTest {
    private val zoe = CrmTeamMember("1", "Zoe", "zoe@x.com", githubLogin = "zoe")
    private val ana = CrmTeamMember("2", "ana", "ana@x.com", githubLogin = null)
    private val bot = CrmTeamMember("3", "Atlas", "atlas@x.com", githubLogin = "atlas-bot", kind = CrmTeamMemberKind("agent"))
    private val me = CrmTeamMember("4", "Mz", " MZ@x.com ", githubLogin = "mz")

    @Test
    fun youFirstAsMeThenPeopleThenAgents() {
        val out = IssueWrites.assignableTeam(listOf(bot, zoe, me, ana), "mz@x.com", "Me", needsGithub = false)
        assertEquals(listOf("Me", "ana", "Zoe", "Atlas"), out.map { it.name })
        assertEquals("4", out.first().id)
    }

    @Test
    fun anIssueOffersOnlyMembersWithALogin() {
        val out = IssueWrites.assignableTeam(listOf(bot, zoe, me, ana), "mz@x.com", "Me", needsGithub = true)
        assertEquals(listOf("4", "1", "3"), out.map { it.id })
        assertEquals(listOf("Zoe", "Atlas"), IssueWrites.assignableTeam(listOf(bot, zoe), null, "Me", needsGithub = true).map { it.name })
    }

    @Test
    fun theLoginIsTheWholeAssigneeSet() {
        val issue = CrmIssueWire(
            id = "i", owner = "envisioning", repo = "starlings", number = 7, title = "T",
            state = CrmIssueState.OPEN, url = "https://github.com/envisioning/starlings-source/issues/7",
            labels = emptyList(), comments = 0,
        )
        val update = IssueWrites.assignment(issue, zoe)!!
        assertEquals(listOf("zoe"), update.assignees)
        assertEquals("envisioning", update.owner)
        assertEquals(7L, update.number)
        assertNull(update.state)
        assertNull(IssueWrites.assignment(issue, ana))
        assertNull(IssueWrites.assignment(issue, ana.copy(githubLogin = "")))
    }
}
