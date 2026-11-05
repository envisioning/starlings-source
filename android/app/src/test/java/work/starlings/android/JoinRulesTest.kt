package work.starlings.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.StarlingsMintedBookingProjection
import work.starlings.contracts.StarlingsMintedBookingProjectionStatus

/** The join-flow rules ported from iOS (JoinRules.kt). No fixture holds them; the cases follow the Swift. */
class JoinRulesTest {
    @Test
    fun guestChecksRunNameThenEmailThenRoom() {
        assertEquals(GuestEntry.Outcome.Invalid(GuestEntry.Problem.NAME_MISSING), GuestEntry.check("  ", "bad", "x"))
        assertEquals(GuestEntry.Outcome.Invalid(GuestEntry.Problem.EMAIL_INVALID), GuestEntry.check("Rosa", "rosa@example", "x"))
        assertEquals(GuestEntry.Outcome.Invalid(GuestEntry.Problem.ROOM_INVALID), GuestEntry.check("Rosa", "rosa@example.com", "x"))
        val ready = GuestEntry.check(" Rosa ", " Rosa@Example.COM ", "https://envisioning.starlings.example/room/rosa-room")
        assertEquals(GuestEntry.Outcome.Ready("Rosa", "rosa@example.com", RoomLink.Parsed("rosa-room", null)), ready)
    }

    @Test
    fun canonicalLinkKeepsTheBookingToken() {
        assertEquals("https://a.test/room/rosa", GuestEntry.canonicalUrl("https://a.test/", RoomLink.Parsed("rosa", null)))
        assertEquals("https://a.test/room/rosa/tok", GuestEntry.canonicalUrl("https://a.test", RoomLink.Parsed("rosa", "tok")))
    }

    @Test
    fun emailRuleIsTheSwiftPattern() {
        assertTrue(GuestEntry.isValid("a", "a@b.co"))
        assertFalse(GuestEntry.isValid("a", "a b@c.de"))
        assertFalse(GuestEntry.isValid("a", "a@@c.de"))
        assertFalse(GuestEntry.isValid("", "a@b.co"))
    }

    @Test
    fun pasteTakesTheSlugOutOfAnInvite() {
        assertEquals("rosa", GuestEntry.pasted("  https://envisioning.starlings.example/room/rosa  "))
        assertEquals("Join me at noon", GuestEntry.pasted("Join me at noon"))
        assertNull(GuestEntry.pasted("   "))
    }

    @Test
    fun environmentNamesTheServer() {
        assertEquals("Production", AppEnvironment.name("https://envisioning.starlings.example"))
        assertEquals("Local", AppEnvironment.name("http://127.0.0.1:8787"))
        assertEquals("Staging.example.com", AppEnvironment.name("https://staging.example.com"))
        assertEquals("envisioning.starlings.example", AppEnvironment.address("https://envisioning.starlings.example"))
        assertEquals("localhost:5173", AppEnvironment.address("http://localhost:5173"))
    }

    @Test
    fun durationRoundsToWholeSeconds() {
        assertEquals(EndedFacts.Duration(0, 0), EndedFacts.duration(-500))
        assertEquals(EndedFacts.Duration(0, 2), EndedFacts.duration(1_500))
        assertEquals(EndedFacts.Duration(2, 5), EndedFacts.duration(125_000))
    }

    @Test
    fun qualityBarsFollowTheSymbolValue() {
        assertEquals(CallQuality.EXCELLENT, CallQuality.from("EXCELLENT"))
        assertEquals(CallQuality.UNKNOWN, CallQuality.from(null))
        assertEquals(listOf(0, 0, 1, 2, 4), CallQuality.entries.map { it.litBars() })
        assertEquals(listOf(false, true, true, false, false), CallQuality.entries.map { it.isWeak })
    }

    @Test
    fun endAsksOnlyWithOthersInTheRoom() {
        assertFalse(EndConfirmation.needed(exitEndsMeeting = true, participantCount = 1))
        assertTrue(EndConfirmation.needed(exitEndsMeeting = true, participantCount = 2))
        assertFalse(EndConfirmation.needed(exitEndsMeeting = false, participantCount = 5))
        assertEquals(0, EndConfirmation.others(0))
        assertEquals(3, EndConfirmation.others(4))
    }

    @Test
    fun aRoomLinkKeepsItsBookingTokenAsWritten() {
        assertEquals(RoomLink.Parsed("rosa", "AbC-12_x"), RoomLink.parse("https://envisioning.starlings.example/Room/Rosa/AbC-12_x"))
        assertEquals("decoded and trimmed", RoomLink.Parsed("rosa", "a b"), RoomLink.parse("/room/rosa/%20a%20b%20"))
        assertEquals("a plus is a plus, as decodeURIComponent", "a+b", RoomLink.parse("/room/rosa/a+b")?.bookingToken)
        assertNull("longer than 128", RoomLink.parse("/room/rosa/" + "x".repeat(129))?.bookingToken)
        assertEquals(RoomLink.Parsed("rosa", null), RoomLink.parse("rosa"))
    }

    private fun projection(
        status: StarlingsMintedBookingProjectionStatus = StarlingsMintedBookingProjectionStatus.SCHEDULED,
        endsAt: String? = "2026-10-29T15:00:00Z",
        name: String? = null,
        email: String? = null,
    ) = StarlingsMintedBookingProjection(
        title = " Intro call ", subject = "  ", startsAt = "2026-10-29T14:30:00Z", endsAt = endsAt, status = status,
        guestName = name, guestEmail = email,
    )

    private val beforeEnd = java.time.Instant.parse("2026-10-29T14:00:00Z").toEpochMilli()

    @Test
    fun aScheduledInviteIsACard() {
        assertEquals(
            BookingInvite.Card.Scheduled(
                "Intro call", null,
                java.time.Instant.parse("2026-10-29T14:30:00Z").toEpochMilli(),
                java.time.Instant.parse("2026-10-29T15:00:00Z").toEpochMilli(),
            ),
            BookingInvite.card(projection(), beforeEnd),
        )
    }

    @Test
    fun cancelledUnknownOrOverIsExpired() {
        assertEquals(BookingInvite.Card.Expired, BookingInvite.card(projection(StarlingsMintedBookingProjectionStatus.CANCELLED), beforeEnd))
        assertEquals("a 404", BookingInvite.Card.Expired, BookingInvite.card(BookingInvite.EXPIRED, beforeEnd))
        val after = java.time.Instant.parse("2026-10-29T15:01:00Z").toEpochMilli()
        assertEquals(BookingInvite.Card.Expired, BookingInvite.card(projection(), after))
        assertTrue("no end never expires by time", BookingInvite.card(projection(endsAt = null), after) is BookingInvite.Card.Scheduled)
    }

    @Test
    fun anInviteForOnePersonNamesThem() {
        assertNull(BookingInvite.invitedIdentity(projection()))
        assertNull(BookingInvite.invitedIdentity(projection(name = "  ", email = " ")))
        assertNull("only a scheduled invite", BookingInvite.invitedIdentity(projection(StarlingsMintedBookingProjectionStatus.CANCELLED, name = "Ana")))
        assertEquals(BookingInvite.Identity("Ana", ""), BookingInvite.invitedIdentity(projection(name = " Ana ")))
    }

    @Test
    fun theInviteWinsWhereItSaysSomething() {
        assertEquals("Ana" to "ana@x.com", BookingInvite.applied("Rosa", "rosa@x.com", BookingInvite.Identity(" Ana ", " Ana@X.com ")))
        assertEquals("an empty part keeps the field", "Ana" to "rosa@x.com", BookingInvite.applied("Rosa", "rosa@x.com", BookingInvite.Identity("Ana", "")))
    }
}
