package work.starlings.android.workspace.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.Upcoming
import work.starlings.contracts.CalendarEventWire
import work.starlings.contracts.CalendarEventsResponse
import work.starlings.contracts.CalendarMeetingPlatform
import work.starlings.contracts.WireJson
import java.io.File
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

/** Home's readings, against `fixtures/responses/calendar-upcoming.json` and the Swift they mirror. */
class HomeFeedTest {
    private val fixture: CalendarEventWire by lazy {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        WireJson.decodeFromString(CalendarEventsResponse.serializer(), File(dir, "responses/calendar-upcoming.json").readText()).events.single()
    }

    private val minute = 60_000L

    @Test
    fun compactDurationFollowsSwift() {
        val now = 0L
        assertEquals(Span.Now, HomeClock.compactDuration(now + 20_000, now))
        assertEquals(Span.Minutes(1), HomeClock.compactDuration(now + 60_000, now))
        assertEquals(Span.Minutes(59), HomeClock.compactDuration(now + 59 * minute, now))
        assertEquals(Span.Hours(1), HomeClock.compactDuration(now + 67 * minute, now))
        assertEquals(Span.HoursMinutes(1, 10), HomeClock.compactDuration(now + 68 * minute, now))
        assertEquals(Span.HoursMinutes(2, 15), HomeClock.compactDuration(now + 134 * minute, now))
        assertEquals(Span.Hours(4), HomeClock.compactDuration(now + 238 * minute, now))
        assertEquals(Span.Hours(12), HomeClock.compactDuration(now + (11 * 60 + 40) * minute, now))
        assertEquals(Span.Now, HomeClock.compactDuration(now - minute, now))
    }

    @Test
    fun countdownBeforeDuringAfter() {
        assertEquals(Countdown.Until(Span.Minutes(5)), HomeClock.relativeCountdown(5 * minute, 65 * minute, 0))
        assertEquals(Countdown.EndsIn(Span.Minutes(40)), HomeClock.relativeCountdown(0, 40 * minute, 0))
        assertEquals(Countdown.Ended, HomeClock.relativeCountdown(0, 40 * minute, 41 * minute))
        assertEquals(Countdown.Ended, HomeClock.relativeCountdown(null, null, 0))
    }

    @Test
    fun dayTimeIsTwentyFourHour() {
        val zone = ZoneOffset.UTC
        val now = LocalDate.of(2026, 10, 28).atTime(9, 0).toInstant(zone).toEpochMilli()
        val today = HomeClock.dayTime(LocalDate.of(2026, 10, 28).atTime(15, 0).toInstant(zone).toEpochMilli(), now, zone)
        assertEquals(DayTime(DayTime.Day.TODAY, LocalDate.of(2026, 10, 28), "15:00"), today)
        val tomorrow = HomeClock.dayTime(LocalDate.of(2026, 10, 29).atTime(9, 30).toInstant(zone).toEpochMilli(), now, zone)
        assertEquals(DayTime.Day.TOMORROW, tomorrow.day)
        assertEquals("09:30", tomorrow.clock)
        assertEquals(DayTime.Day.OTHER, HomeClock.dayTime(LocalDate.of(2026, 11, 2).atTime(23, 5).toInstant(zone).toEpochMilli(), now, zone).day)
    }

    @Test
    fun theFixtureReadsAsAStarlingsMeeting() {
        val e = fixture
        assertEquals("https://envisioning.starlings.example/room/example-room", HomeFeed.launchUrl(e))
        assertTrue(HomeFeed.isVideoMeeting(e))
        assertTrue(HomeFeed.isStarlingsRoom(e))
        assertEquals("event:sub:example-feed:0", HomeFeed.demotionKey(e))
        assertEquals("Join", HomeFeed.actionTitle(e.platform))
        assertEquals("Open Zoom", HomeFeed.actionTitle(CalendarMeetingPlatform.ZOOM))
    }

    @Test
    fun joinGoesToTheKnockTheHostOrTheOwningApp() {
        val e = fixture
        assertEquals(HomeFeed.JoinTarget.Room(HomeFeed.launchUrl(e)), HomeFeed.joinTarget(e, ownSlug = "rosa"))
        assertEquals(HomeFeed.JoinTarget.Room(HomeFeed.launchUrl(e)), HomeFeed.joinTarget(e, ownSlug = null))
        assertEquals(HomeFeed.JoinTarget.OwnRoom, HomeFeed.joinTarget(e, ownSlug = "example-room"))
        val zoom = e.copy(platform = CalendarMeetingPlatform.ZOOM, conferenceUrl = "https://zoom.us/j/1", joinUrl = "")
        assertEquals(HomeFeed.JoinTarget.External("https://zoom.us/j/1"), HomeFeed.joinTarget(zoom, ownSlug = "example-room"))
        assertNull(HomeFeed.joinTarget(e.copy(platform = CalendarMeetingPlatform.NONE), null))
        assertNull(HomeFeed.joinTarget(e.copy(conferenceUrl = "", joinUrl = ""), null))
    }

    @Test
    fun alertableIsTheAgendasJoinableMeetingsLessTheDemoted() {
        val e = fixture
        val now = Upcoming.parse(e.start)!! - 60 * minute
        val zone = ZoneId.of("UTC")
        val zoom = e.copy(id = "z", platform = CalendarMeetingPlatform.ZOOM, conferenceUrl = "https://zoom.us/j/1", title = "Standup")
        val talk = e.copy(id = "t", platform = CalendarMeetingPlatform.NONE, conferenceUrl = "", joinUrl = "", title = "Lunch")
        val hidden = e.copy(id = "h", demoted = true, title = "Hidden")
        val raw = listOf(e, zoom, talk, hidden)
        val plan = Upcoming.classify(raw.map(HomeFeed::upcoming), now, zone)
        assertEquals(listOf(e.id, "z"), HomeFeed.alertable(plan, raw).map { it.id })
    }
}
