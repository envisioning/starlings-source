package work.starlings.android.workspace.calendar

import work.starlings.android.R
import work.starlings.contracts.BookingDayHours
import work.starlings.contracts.BookingSettingsResponse
import work.starlings.contracts.BookingSettingsUpdate
import work.starlings.contracts.BookingWeeklyHours
import java.time.DayOfWeek
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale

/**
 * `Sources/BookingHours.swift`: Settings › Calendar › Booking hours, the parts
 * every client shares. The wire is
 * `packages/contracts/src/booking-settings.ts`; the web editor is
 * `web/src/BookingSettings.tsx`. The screen draws its own controls; the
 * defaults, the limits and the words come from here.
 */
object BookingHours {
    /** One number field: its label and the range `bookingFields` accepts. */
    data class NumberField(
        val label: Int,
        val range: IntRange,
        val get: (BookingSettingsUpdate) -> Long,
        val set: (BookingSettingsUpdate, Long) -> BookingSettingsUpdate,
    ) {
        fun clamped(value: Long): Long = value.coerceIn(range.first.toLong(), range.last.toLong())
    }

    /** The five numbers, in the web's order. */
    val numberFields: List<NumberField> = listOf(
        NumberField(R.string.booking_meeting_length, 15..240, { it.durationMinutes }, { d, v -> d.copy(durationMinutes = v) }),
        NumberField(R.string.booking_slot_step, 5..240, { it.slotStepMinutes }, { d, v -> d.copy(slotStepMinutes = v) }),
        NumberField(R.string.booking_buffer, 0..120, { it.bufferMinutes }, { d, v -> d.copy(bufferMinutes = v) }),
        NumberField(R.string.booking_notice, 0..168, { it.minNoticeHours }, { d, v -> d.copy(minNoticeHours = v) }),
        NumberField(R.string.booking_max_days, 1..365, { it.maxBookingDays }, { d, v -> d.copy(maxBookingDays = v) }),
    )

    /** Every quarter hour of the day, as minutes after midnight. */
    val clockMinutes: List<Int> = (0 until 24 * 60 step 15).toList()

    /** A minute of the day on the 24-hour clock (AGENTS.md invariant 20). */
    fun clock(minute: Int): String = "%02d:%02d".format(minute / 60, minute % 60)

    private val workday = BookingDayHours(enabled = true, startMinute = 9 * 60L, endMinute = 17 * 60L)
    private val weekend = BookingDayHours(enabled = false, startMinute = 9 * 60L, endMinute = 17 * 60L)

    /** 09:00 to 17:00 on weekdays, as the web starts a member with no hours. */
    val defaultWeek = BookingWeeklyHours(workday, workday, workday, workday, workday, weekend, weekend)

    /** The form's starting values: the saved ones, else the default week in this phone's zone. */
    fun draft(from: BookingSettingsResponse, zone: ZoneId = ZoneId.systemDefault()): BookingSettingsUpdate = BookingSettingsUpdate(
        active = from.active,
        durationMinutes = from.durationMinutes,
        bufferMinutes = from.bufferMinutes,
        minNoticeHours = from.minNoticeHours,
        maxBookingDays = from.maxBookingDays,
        slotStepMinutes = from.slotStepMinutes,
        timezone = from.timezone ?: zone.id,
        weeklyHours = from.weeklyHours ?: defaultWeek,
    )

    /** The zones this phone knows, with the current one first when it is not among them. */
    fun timeZoneOptions(current: String?, known: Collection<String> = ZoneId.getAvailableZoneIds()): List<String> {
        val zones = known.sorted()
        return if (current != null && current !in zones) listOf(current) + zones else zones
    }

    /** The path the line above the form names, or null when there is no booking page. */
    fun bookingPath(room: String?): String? = room?.let { "/book/$it" }

    /** `BookingWeekday`: Monday first, the order of `BOOKING_WEEKDAYS`. */
    enum class Weekday(val day: DayOfWeek) {
        MON(DayOfWeek.MONDAY), TUE(DayOfWeek.TUESDAY), WED(DayOfWeek.WEDNESDAY), THU(DayOfWeek.THURSDAY),
        FRI(DayOfWeek.FRIDAY), SAT(DayOfWeek.SATURDAY), SUN(DayOfWeek.SUNDAY);

        /** This language's short weekday name. */
        fun label(locale: Locale = Locale.getDefault()): String = day.getDisplayName(TextStyle.SHORT, locale)
    }

    fun hours(week: BookingWeeklyHours, day: Weekday): BookingDayHours = when (day) {
        Weekday.MON -> week.mon
        Weekday.TUE -> week.tue
        Weekday.WED -> week.wed
        Weekday.THU -> week.thu
        Weekday.FRI -> week.fri
        Weekday.SAT -> week.sat
        Weekday.SUN -> week.sun
    }

    fun replacing(week: BookingWeeklyHours, day: Weekday, hours: BookingDayHours): BookingWeeklyHours = when (day) {
        Weekday.MON -> week.copy(mon = hours)
        Weekday.TUE -> week.copy(tue = hours)
        Weekday.WED -> week.copy(wed = hours)
        Weekday.THU -> week.copy(thu = hours)
        Weekday.FRI -> week.copy(fri = hours)
        Weekday.SAT -> week.copy(sat = hours)
        Weekday.SUN -> week.copy(sun = hours)
    }
}
