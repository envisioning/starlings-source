package work.starlings.android.workspace.calendar

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import work.starlings.contracts.CalendarEventSubject
import work.starlings.contracts.CalendarEventSubjectKind
import work.starlings.contracts.CrmContact
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import java.io.File

/** Filing an event: the kinds held to `fixtures/subject-kinds.json`, the map the save writes. */
class CalendarFilingTest {
    @Test
    fun kindsAreTheRegistrysCalendarEventsList() {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        val with = Json.parseToJsonElement(File(dir, "subject-kinds.json").readText()).jsonObject["with"]!!.jsonObject
        val expected = with["calendarEvents"]!!.jsonArray.map { it.jsonPrimitive.content }
        assertEquals(expected, CalendarFiling.kinds.map { it.value })
        assertEquals("Partner", CalendarFiling.meetingKind(CrmSubjectKind.ORGANIZATION)?.label)
    }

    @Test
    fun subjectsAndTheMap() {
        val project = CalendarFiling.subject(CrmSubjectWire(id = "p1", kind = CrmSubjectKind.PROJECT, title = "Atlas"))!!
        assertEquals(CalendarEventSubject(CalendarEventSubjectKind.PROJECT, "p1", "Atlas"), project)
        assertNull(CalendarFiling.subject(CrmSubjectWire(id = "e1", kind = CrmSubjectKind.EVENT, title = "Expo")))
        val filed = CalendarFiling.withSubject(emptyMap(), "event:g:a:b", project)
        assertEquals(mapOf("event:g:a:b" to project), filed)
        assertEquals(emptyMap<String, CalendarEventSubject>(), CalendarFiling.withSubject(filed, "event:g:a:b", null))
        assertEquals("/work/project/p1", CalendarFiling.workPath(project))
    }

    @Test
    fun attendeeContacts() {
        val asked = CalendarAttendeeContacts.lookup(listOf("Ana@Client.com", "ana@client.com", "rosa@org.example", "") + (1..30).map { "g$it@x.com" })
        assertEquals("ana@client.com", asked.first())
        assertEquals(CalendarAttendeeContacts.MAX_EMAILS, asked.size)
        assertEquals(false, asked.any { it.endsWith("@org.example") })

        val ana = CrmContact(id = "c1", name = "Ana Lima", title = "CTO", organizationName = "Client", email = "ana@client.com", emails = listOf("ana@client.com", "a.lima@client.io"))
        val bare = CrmContact(id = "c2", name = " ", emails = listOf("bo@y.com"))
        val contacts = listOf(ana, bare)
        assertEquals(ana, CalendarAttendeeContacts.match(contacts, "A.Lima@client.io"))
        assertEquals(bare, CalendarAttendeeContacts.match(contacts, "bo@y.com"))
        assertNull(CalendarAttendeeContacts.match(contacts, "nobody@z.com"))
        assertEquals("CTO · Client", CalendarAttendeeContacts.detail(ana))
        assertNull(CalendarAttendeeContacts.detail(bare))
        assertEquals("Client", CalendarAttendeeContacts.detail(ana.copy(title = "")))
        assertEquals("Ana Lima", CalendarAttendeeContacts.name(ana, "ana@client.com"))
        assertEquals("bo@y.com", CalendarAttendeeContacts.name(bare, "bo@y.com"))
    }
}
