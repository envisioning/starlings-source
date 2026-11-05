package work.starlings.android

import java.net.URI
import work.starlings.contracts.StarlingsMintedBookingProjection
import work.starlings.contracts.StarlingsMintedBookingProjectionStatus

/**
 * The pure rules of the guest join flow, the welcome card and the call
 * screen's chrome, each naming the Swift it ports. No Android types, so
 * `JoinRulesTest` runs them on the JVM.
 */

/**
 * The welcome card's guest checks (`MobileFirstRunCard.continueAsGuest`),
 * in the Mac's order: name, then email, then room. The identity rule is
 * `MobileGuestIdentity` (iOS/StarlingsMobileModels.swift); the sentences are
 * `GuestEntryWords` (Sources/GuestEntryWords.swift).
 */
object GuestEntry {
    enum class Problem { NAME_MISSING, EMAIL_INVALID, ROOM_INVALID }

    sealed interface Outcome {
        data class Ready(val name: String, val email: String, val room: RoomLink.Parsed) : Outcome
        data class Invalid(val problem: Problem) : Outcome
    }

    private val emailPattern = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")

    /** `MobileGuestIdentity.normalized`: the name trimmed, the email lowercased and trimmed. */
    fun normalizedName(name: String): String = name.trim()
    fun normalizedEmail(email: String): String = email.lowercase().trim()

    /** `MobileGuestIdentity.isValid`. */
    fun isValid(name: String, email: String): Boolean =
        normalizedName(name).isNotEmpty() && emailPattern.matches(normalizedEmail(email))

    fun check(name: String, email: String, room: String): Outcome {
        if (normalizedName(name).isEmpty()) return Outcome.Invalid(Problem.NAME_MISSING)
        if (!isValid(name, email)) return Outcome.Invalid(Problem.EMAIL_INVALID)
        val parsed = RoomLink.parse(room) ?: return Outcome.Invalid(Problem.ROOM_INVALID)
        return Outcome.Ready(normalizedName(name), normalizedEmail(email), parsed)
    }

    /** `MobileRoomPath.canonicalURL`: the room's link on [origin], with its booking token when it has one. */
    fun canonicalUrl(origin: String, room: RoomLink.Parsed): String =
        "${origin.trimEnd('/')}/room/${room.slug}" + (room.bookingToken?.let { "/$it" } ?: "")

    /** `pasteRoom`: a `/room/…` slug out of pasted invite text, else the text as it is. */
    fun pasted(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null
        return RoomLink.parse(trimmed)?.slug ?: trimmed
    }
}

/**
 * The welcome shell's version line (`EnvisioningVersionLine`) names the
 * server this build talks to, as `StarlingsAppVersion.environment`
 * (iOS/StarlingsAppVersion.swift), then `.capitalized`.
 */
object AppEnvironment {
    fun name(origin: String): String {
        val host = runCatching { URI(origin).host }.getOrNull()?.lowercase() ?: return capitalized("unknown server")
        val raw = when (host) {
            "127.0.0.1", "localhost" -> "local"
            Deployment.SERVED_WEB_HOST, Deployment.LEGACY_WORKER_HOST -> "production"
            else -> host
        }
        return capitalized(raw)
    }

    /** `StarlingsWorkspace.address`: the host, with the port only when there is one. */
    fun address(origin: String): String {
        val uri = runCatching { URI(origin) }.getOrNull() ?: return origin
        val host = uri.host ?: return origin
        return if (uri.port > 0) "$host:${uri.port}" else host
    }

    /** Foundation's `capitalized`: each whitespace-separated word's first letter up, the rest down. */
    fun capitalized(s: String): String =
        s.split(" ").joinToString(" ") { w -> w.lowercase().replaceFirstChar { it.uppercaseChar() } }

    /** The active workspace's name (`StarlingsWorkspace.active.name`). */
    val WORKSPACE_NAME: String get() = Workspaces.active.name
}

/** `JoinView.durationLabel`: whole seconds, rounded, never negative, as minutes and seconds. */
object EndedFacts {
    data class Duration(val minutes: Long, val seconds: Long)

    fun duration(elapsedMs: Long): Duration {
        val total = maxOf(0L, Math.round(elapsedMs / 1000.0))
        return Duration(total / 60, total % 60)
    }
}

/**
 * `MeetingConnectionQuality` (Sources/MeetingQuality.swift): LiveKit's
 * quality by name, the bars the tile badge lights, and the one definition
 * of a weak connection.
 */
enum class CallQuality {
    UNKNOWN, LOST, POOR, GOOD, EXCELLENT;

    /** `unknown` is not weak: the SFU has not scored this participant yet. */
    val isWeak: Boolean get() = this == POOR || this == LOST

    /** `tileSignalValue`: 0 until scored, then a third, two thirds, all. */
    val signal: Double get() = when (this) {
        UNKNOWN, LOST -> 0.0
        POOR -> 0.33
        GOOD -> 0.67
        EXCELLENT -> 1.0
    }

    /**
     * The bars SF Symbols lights on `cellularbars` for [signal]: bar `i` of
     * `bars` is lit when its threshold `(i + 1) / bars` is at most the value.
     */
    fun litBars(bars: Int = 4): Int = (1..bars).count { it.toDouble() / bars <= signal + 1e-9 }

    companion object {
        /** LiveKit Android's `ConnectionQuality.name`; anything else is unknown. */
        fun from(name: String?): CallQuality = when (name?.uppercase()) {
            "EXCELLENT" -> EXCELLENT
            "GOOD" -> GOOD
            "POOR" -> POOR
            "LOST" -> LOST
            else -> UNKNOWN
        }
    }
}

/**
 * `MobileCallView`'s End: when the exit ends the meeting for everyone and
 * anyone else is in the room, it asks first. The dialog says how many others.
 */
object EndConfirmation {
    fun needed(exitEndsMeeting: Boolean, participantCount: Int): Boolean = exitEndsMeeting && participantCount > 1

    fun others(participantCount: Int): Int = maxOf(participantCount - 1, 0)
}

/**
 * The join flow's invite (`StarlingsMintedBookingProjection.card` and
 * `invitedIdentity`, iOS/StarlingsMobileModels.swift): what a booking token
 * says about the meeting and who it was minted for.
 */
object BookingInvite {
    sealed interface Card {
        data class Scheduled(val title: String?, val subject: String?, val startsAtMs: Long?, val endsAtMs: Long?) : Card
        data object Expired : Card
    }

    data class Identity(val name: String, val email: String)

    /** A 404: an invite this room does not know, as a cancelled card. The wire names no other state. */
    val EXPIRED = StarlingsMintedBookingProjection(status = StarlingsMintedBookingProjectionStatus.CANCELLED)

    /** Cancelled, unknown, or over: expired. */
    fun card(p: StarlingsMintedBookingProjection, nowMs: Long): Card {
        if (p.status != StarlingsMintedBookingProjectionStatus.SCHEDULED) return Card.Expired
        val end = p.endsAt?.let(::parse)
        if (end != null && end < nowMs) return Card.Expired
        return Card.Scheduled(p.title?.trim()?.ifEmpty { null }, p.subject?.trim()?.ifEmpty { null }, p.startsAt?.let(::parse), end)
    }

    /** An invite minted for one person names them; null unless it is scheduled and names someone. */
    fun invitedIdentity(p: StarlingsMintedBookingProjection): Identity? {
        val name = p.guestName?.trim().orEmpty()
        val email = p.guestEmail?.trim().orEmpty()
        if (p.status != StarlingsMintedBookingProjectionStatus.SCHEDULED || (name.isEmpty() && email.isEmpty())) return null
        return Identity(name, email)
    }

    /**
     * `MobileGuestIdentity.apply(identity:)`: each non-empty part of [next]
     * replaces what the fields hold. The invite wins over what this phone
     * remembers, and stays editable.
     */
    fun applied(name: String, email: String, next: Identity): Pair<String, String> =
        (GuestEntry.normalizedName(next.name).ifEmpty { name }) to (GuestEntry.normalizedEmail(next.email).ifEmpty { email })

    private fun parse(iso: String): Long? = runCatching { java.time.OffsetDateTime.parse(iso).toInstant().toEpochMilli() }.getOrNull()
        ?: runCatching { java.time.Instant.parse(iso).toEpochMilli() }.getOrNull()
}
