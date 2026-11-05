package work.starlings.android.widgets

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import work.starlings.android.workspace.home.HomeLinks
import java.time.Instant
import java.time.ZoneId

/** The Quick Settings tiles' verbs (Controls.kt), against iOS `LaunchAction` and `performLaunchAction`. */
class ControlsTest {
    private val zone = ZoneId.of("Europe/Amsterdam")
    private val now = Instant.parse("2026-10-28T10:00:00Z").toEpochMilli()

    private fun meeting(id: String, start: String, end: String, join: WidgetJoin? = null) =
        WidgetMeeting(id = id, title = "Standup $id", start = start, end = end, join = join)

    private fun file(vararg meetings: WidgetMeeting) =
        WidgetAgendaFile(owner = "rosa@org.example", savedAtMs = now, meetings = meetings.toList())

    @Test
    fun verbsKeepTheIosRawValues() {
        assertEquals("joinNextMeeting", LaunchAction.JOIN_NEXT_MEETING.raw)
        assertEquals("newQuickNote", LaunchAction.NEW_QUICK_NOTE.raw)
        assertEquals(LaunchAction.NEW_QUICK_NOTE, LaunchAction.from("newQuickNote"))
        assertNull(LaunchAction.from("somethingElse"))
        assertNull(LaunchAction.from(null))
    }

    /** res/xml/shortcuts.xml: one static shortcut per verb, each handing [LaunchAction.EXTRA] its raw value to MainActivity. */
    @Test
    fun launcherShortcutsHandTheVerbs() {
        val repo = java.io.File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")).parentFile
        val xml = java.io.File(repo, "android/app/src/main/res/xml/shortcuts.xml").readText()
        val extras = Regex("<extra android:name=\"([^\"]+)\" android:value=\"([^\"]+)\"").findAll(xml).toList()
        assertEquals(LaunchAction.entries.map { it.raw }, extras.map { it.groupValues[2] })
        extras.forEach { assertEquals(LaunchAction.EXTRA, it.groupValues[1]) }
        // One per shortcut, and the Assistant capability's.
        assertEquals(LaunchAction.entries.size + 1, Regex("android:targetClass=\"work.starlings.android.MainActivity\"").findAll(xml).count())
    }

    /**
     * The App Actions capability (iOS `JoinNextMeetingIntent`, `NewQuickNoteIntent`):
     * OPEN_APP_FEATURE hands the matched shortcut's id in [LaunchAction.EXTRA], and
     * every shortcut id is a verb, bound to that capability.
     */
    @Test
    fun assistantCapabilityHandsTheVerbs() {
        val repo = java.io.File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")).parentFile
        val xml = java.io.File(repo, "android/app/src/main/res/xml/shortcuts.xml").readText()
        val capability = Regex("<capability android:name=\"([^\"]+)\">(.*?)</capability>", RegexOption.DOT_MATCHES_ALL).findAll(xml).toList()
        assertEquals(listOf("actions.intent.OPEN_APP_FEATURE"), capability.map { it.groupValues[1] })
        val parameter = Regex("<parameter android:name=\"feature\" android:key=\"([^\"]+)\"").find(capability.single().groupValues[2])
        assertEquals(LaunchAction.EXTRA, parameter?.groupValues?.get(1))
        val ids = Regex("android:shortcutId=\"([^\"]+)\"").findAll(xml).map { it.groupValues[1] }.toList()
        assertEquals(LaunchAction.entries.map { it.raw }, ids)
        ids.forEach { assertEquals(it, LaunchAction.from(it)?.raw) }
        assertEquals(ids.size, Regex("<capability-binding android:key=\"actions.intent.OPEN_APP_FEATURE\">").findAll(xml).count())
    }

    @Test
    fun noFileOrNoMeetingOpensCalendar() {
        assertEquals(NextMeetingDoor.Calendar, NextMeetingDoor.resolve(null, now, zone))
        assertEquals(NextMeetingDoor.Calendar, NextMeetingDoor.resolve(file(), now, zone))
    }

    @Test
    fun theFocusMeetingsLinkWins() {
        val room = WidgetJoin(WidgetJoin.Kind.ROOM, "https://envisioning.starlings.example/room/ana")
        val zoom = WidgetJoin(WidgetJoin.Kind.EXTERNAL, "https://zoom.us/j/1")
        val agenda = file(
            meeting("later", "2026-10-28T11:00:00Z", "2026-10-28T11:30:00Z", zoom),
            meeting("soon", "2026-10-28T10:05:00Z", "2026-10-28T10:30:00Z", room),
        )
        assertEquals(NextMeetingDoor.Room(room.url), NextMeetingDoor.resolve(agenda, now, zone))
        val external = file(meeting("soon", "2026-10-28T10:05:00Z", "2026-10-28T10:30:00Z", zoom))
        assertEquals(NextMeetingDoor.External(zoom.url), NextMeetingDoor.resolve(external, now, zone))
    }

    @Test
    fun noLinkOpensTheMeetingInCalendar() {
        val m = meeting("desk", "2026-10-28T10:05:00Z", "2026-10-28T10:30:00Z")
        assertEquals(NextMeetingDoor.Event(HomeLinks.calendarEvent(m.id, m.start, zone)), NextMeetingDoor.resolve(file(m), now, zone))
    }

    @Test
    fun anEndedMeetingIsNotNext() {
        val ended = meeting("gone", "2026-10-28T08:00:00Z", "2026-10-28T09:00:00Z", WidgetJoin(WidgetJoin.Kind.EXTERNAL, "https://zoom.us/j/2"))
        assertEquals(NextMeetingDoor.Calendar, NextMeetingDoor.resolve(file(ended), now, zone))
    }
}
