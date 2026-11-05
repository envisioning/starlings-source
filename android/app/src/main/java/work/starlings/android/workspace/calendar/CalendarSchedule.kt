package work.starlings.android.workspace.calendar

import work.starlings.android.CalendarValues
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * Schedule a meeting's rules (`MobileScheduleDraft`, `MobileAgendaStrip`,
 * `Sources/StarlingsScheduleTimeZone.swift`). The zones are
 * [CalendarValues.scheduleTimeZones]; the room link is the owner's room.
 */
object CalendarSchedule {
    val durations = listOf(30, 45, 60, 90)
    const val MAX_GUESTS = 50

    /** `matchingSystem`: the preset for the phone's zone, an alias, then a preset with the same offset now. */
    fun matchingSystem(zoneId: String, now: Instant = Instant.now()): CalendarValues.ScheduleZone? {
        val zones = CalendarValues.scheduleTimeZones
        zones.firstOrNull { it.zone == zoneId }?.let { return it }
        aliases[zoneId]?.let { id -> return zones.firstOrNull { it.id == id } }
        val offset = runCatching { ZoneId.of(zoneId).rules.getOffset(now) }.getOrNull() ?: return null
        return zones.firstOrNull { ZoneId.of(it.zone).rules.getOffset(now) == offset }
    }

    /**
     * `offered`: the workspace's shortlist (the descriptor's `defaults.time_zones`,
     * docs/CENTRAL_AUTH.md) in the presets' own order. No shortlist, or one
     * that names no preset this build knows, offers every preset.
     */
    fun offered(shortlist: List<String>?): List<CalendarValues.ScheduleZone> {
        val all = CalendarValues.scheduleTimeZones
        if (shortlist == null) return all
        return all.filter { it.id in shortlist }.ifEmpty { all }
    }

    /**
     * `loadPreferred`: the stored choice, else the phone's zone, else
     * Amsterdam, else the first offered; each only when the shortlist offers it.
     */
    fun preferred(
        stored: String?,
        systemZone: String,
        now: Instant = Instant.now(),
        offered: List<CalendarValues.ScheduleZone> = CalendarValues.scheduleTimeZones,
    ): CalendarValues.ScheduleZone {
        stored?.let { id -> offered.firstOrNull { it.id == id }?.let { return it } }
        matchingSystem(systemZone, now)?.takeIf { it in offered }?.let { return it }
        return offered.firstOrNull { it.id == "amsterdam" } ?: offered.first()
    }

    /** `nextQuarterHour`: the quarter hour after now, never now itself. */
    fun nextQuarterHour(ms: Long): Long {
        val step = 15 * 60_000L
        return (ms / step) * step + step
    }

    /** The strip's days from today: 42 with weekends, else 30 weekdays, from the next 50. */
    fun stripDays(today: LocalDate, showWeekends: Boolean): List<LocalDate> {
        val candidates = (0 until 50).map { today.plusDays(it.toLong()) }
        val visible = if (showWeekends) candidates else candidates.filter { it.dayOfWeek != DayOfWeek.SATURDAY && it.dayOfWeek != DayOfWeek.SUNDAY }
        return visible.take(if (showWeekends) 42 else 30)
    }

    /** A typed guest is kept only when it is an address, once, and up to [MAX_GUESTS]. */
    fun addGuest(guests: List<String>, typed: String): List<String> {
        val value = typed.trim().lowercase()
        if (!value.contains('@') || value in guests || guests.size >= MAX_GUESTS) return guests
        return guests + value
    }

    private val aliases = mapOf(
        "US/Eastern" to "newYork",
        "America/Toronto" to "newYork",
        "America/Montreal" to "newYork",
        "Brazil/East" to "saoPaulo",
        "America/Argentina/Buenos_Aires" to "saoPaulo",
        "Europe/Dublin" to "london",
        "GB" to "london",
        "Europe/Brussels" to "amsterdam",
        "Europe/Berlin" to "amsterdam",
        "Europe/Paris" to "amsterdam",
        "Asia/Kuwait" to "riyadh",
        "Asia/Qatar" to "riyadh",
        "Asia/Bahrain" to "riyadh",
        "Asia/Muscat" to "dubai",
        "Asia/Abu_Dhabi" to "dubai",
        "US/Pacific" to "losAngeles",
        "America/Vancouver" to "losAngeles",
        "America/Tijuana" to "losAngeles",
        "Asia/Calcutta" to "mumbai",
        "Asia/Colombo" to "mumbai",
        "Japan" to "tokyo",
        "Asia/Seoul" to "tokyo",
    )
}
