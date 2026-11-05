package work.starlings.android.host

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.MeetingCategoryResponse
import work.starlings.contracts.MeetingCategoryUpdate
import work.starlings.contracts.MeetingKind
import work.starlings.contracts.WireJson

/** The host's moderation and filing rules, as `MobileParticipantsSheet` and `MeetingCategoryKind`. */
class MeetingOwnerTest {
    @Test
    fun aHostModeratesEveryoneButItself() {
        assertTrue(Moderation.canModerate(isHost = true, isLocal = false))
        assertFalse("your own share is a stage control", Moderation.canModerate(isHost = true, isLocal = true))
        assertFalse("a guest moderates nobody", Moderation.canModerate(isHost = false, isLocal = false))
    }

    @Test
    fun aShareIsTheIdentitysScreenTile() {
        assertTrue(Moderation.isSharing("ana@x", listOf("ana@x:screen")))
        assertFalse(Moderation.isSharing("ana@x", listOf("ana@x", "bo@x:screen")))
    }

    @Test
    fun theMenuOffersEventOnlyWhenFiledAsOne() {
        val plain = MeetingFiling.menu(MeetingKind.UNCATEGORIZED)
        assertEquals(MeetingKind.known - MeetingKind.EVENT, plain)
        assertTrue(MeetingKind.EVENT in MeetingFiling.menu(MeetingKind.EVENT))
        assertFalse(MeetingKind.PARTNER in MeetingFiling.menu(MeetingKind.STATUS, offersPartner = false))
        assertTrue(MeetingKind.PARTNER in MeetingFiling.menu(MeetingKind.PARTNER, offersPartner = false))
    }

    @Test
    fun meetAboutThisFilesUnderTheSubjectsOwnKind() {
        val lead = MeetingFiling.about(CrmSubjectKind.LEAD, "l1", "Acme")
        assertEquals(MeetingKind.LEAD, lead.meetingKind)
        assertEquals("l1", (lead.leadId as work.starlings.contracts.Patch.Value).value)
        assertEquals("Acme", (lead.subjectTitle as work.starlings.contracts.Patch.Value).value)
        assertEquals(MeetingKind.PROJECT, MeetingFiling.about(CrmSubjectKind.PROJECT, "p1", "Site").meetingKind)
        assertEquals(MeetingKind.PARTNER, MeetingFiling.about(CrmSubjectKind.ORGANIZATION, "o1", "Org").meetingKind)
        assertEquals(MeetingKind.EVENT, MeetingFiling.about(CrmSubjectKind.EVENT, "e1", "Fair").meetingKind)
    }

    @Test
    fun subjectKinds() {
        assertEquals(CrmSubjectKind.LEAD, MeetingFiling.subjectKind(MeetingKind.LEAD))
        assertEquals(CrmSubjectKind.PROJECT, MeetingFiling.subjectKind(MeetingKind.PROJECT))
        assertEquals(CrmSubjectKind.ORGANIZATION, MeetingFiling.subjectKind(MeetingKind.PARTNER))
        assertEquals(CrmSubjectKind.EVENT, MeetingFiling.subjectKind(MeetingKind.EVENT))
        assertNull(MeetingFiling.subjectKind(MeetingKind.STATUS))
        assertFalse(MeetingFiling.needsSubject(MeetingKind.INTERNAL))
    }

    @Test
    fun theKindDecidesWhichIdCarriesTheSubject() {
        val ana = MeetingFiling.Subject("o1", CrmSubjectKind.ORGANIZATION, "Ana Co")
        assertEquals(
            """{"meeting_kind":"partner","partner_organization_id":"o1","subject_title":"Ana Co"}""",
            WireJson.encodeToString(MeetingCategoryUpdate.serializer(), MeetingFiling.update(MeetingKind.PARTNER, ana)),
        )
        assertEquals(
            "a kind with no subject sends no id",
            """{"meeting_kind":"status","subject_title":"Ana Co"}""",
            WireJson.encodeToString(MeetingCategoryUpdate.serializer(), MeetingFiling.update(MeetingKind.STATUS, ana)),
        )
        assertEquals("""{"meeting_kind":"internal"}""", WireJson.encodeToString(MeetingCategoryUpdate.serializer(), MeetingFiling.update(MeetingKind.INTERNAL, null)))
    }

    @Test
    fun theSheetOpensOnWhatIsFiled() {
        val filed = MeetingCategoryResponse(MeetingKind.PROJECT, projectId = "p1", subjectTitle = "Signals")
        assertEquals(MeetingFiling.Subject("p1", CrmSubjectKind.PROJECT, "Signals"), MeetingFiling.subject(filed))
        assertEquals("the title stands in for a missing id", "Signals", MeetingFiling.subject(filed.copy(projectId = null))?.id)
        assertNull(MeetingFiling.subject(MeetingCategoryResponse(MeetingKind.STATUS, subjectTitle = "x")))
    }

    @Test
    fun saveWaitsForASubject() {
        assertFalse(MeetingFiling.canSave(MeetingKind.LEAD, null, saving = false))
        assertTrue(MeetingFiling.canSave(MeetingKind.LEAD, MeetingFiling.Subject("l", CrmSubjectKind.LEAD, "L"), saving = false))
        assertTrue(MeetingFiling.canSave(MeetingKind.STATUS, null, saving = false))
        assertFalse(MeetingFiling.canSave(MeetingKind.STATUS, null, saving = true))
    }

    @Test
    fun onlyAnUncategorizedMeetingNudges() {
        assertTrue(MeetingFiling.nudges(MeetingCategoryResponse(MeetingKind.UNCATEGORIZED)))
        assertFalse(MeetingFiling.nudges(MeetingCategoryResponse(MeetingKind.STATUS)))
        assertFalse("no category read, no nudge", MeetingFiling.nudges(null))
    }
}
