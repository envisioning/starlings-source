package work.starlings.android.workspace.calendar

import work.starlings.android.CalendarLayout
import work.starlings.android.CalendarValues
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * `Sources/CalendarWindowPreferences.swift`: the device-local calendar
 * choices (`MobileCalendarDisplaySettingsView`), under the keys iOS and the
 * Mac use. Read from and written to a plain key-value map, so the store
 * keeps them in preferences and the tests keep them in a map.
 */
data class CalendarDisplay(
    val dayStartHour: Int = DEFAULT_START,
    val dayEndHour: Int = DEFAULT_END,
    val durationMinutes: Int = DEFAULT_DURATION,
    val snapMinutes: Int = DEFAULT_SNAP,
    val hourHeight: Float = DEFAULT_HOUR_HEIGHT,
    val showsDeclined: Boolean = true,
    val showsHidden: Boolean = false,
    /** A [CalendarValues.ScheduleZone] id (`StarlingsScheduleTimeZone.rawValue`); null is one set of hours. */
    val secondaryZoneId: String? = null,
) {
    val secondaryZone: CalendarValues.ScheduleZone?
        get() = secondaryZoneId?.let { id -> CalendarValues.scheduleTimeZones.firstOrNull { it.id == id } }

    /** `setDayStartHour`: the end moves to an hour after a start that reached it. */
    fun withStartHour(hour: Int): CalendarDisplay {
        val start = clampHour(hour)
        return copy(dayStartHour = start, dayEndHour = if (dayEndHour <= start) minOf(23, start + 1) else dayEndHour)
    }

    fun withEndHour(hour: Int): CalendarDisplay = copy(dayEndHour = maxOf(clampHour(hour), dayStartHour + 1))

    fun withHourHeight(height: Float): CalendarDisplay = copy(hourHeight = clampHourHeight(height))

    /** What the store writes back: every key, the zone removed when off. */
    fun entries(): Map<String, Any?> = mapOf(
        KEY_START to dayStartHour,
        KEY_END to dayEndHour,
        KEY_DURATION to durationMinutes,
        KEY_SNAP to snapMinutes,
        KEY_HOUR_HEIGHT to hourHeight,
        KEY_DECLINED to showsDeclined,
        KEY_HIDDEN to showsHidden,
        KEY_SECONDARY to secondaryZoneId,
    )

    companion object {
        const val KEY_START = "meet.calendar.dayStartHour"
        const val KEY_END = "meet.calendar.dayEndHour"
        const val KEY_DEFAULT_VIEW = "meet.calendar.defaultView"
        const val KEY_DURATION = "meet.calendar.defaultDurationMinutes"
        const val KEY_SNAP = "meet.calendar.snapMinutes"
        const val KEY_DECLINED = "meet.calendar.showsDeclined"
        const val KEY_HIDDEN = "meet.calendar.showsHidden"
        const val KEY_HOUR_HEIGHT = "meet.calendar.hourHeight"
        const val KEY_SECONDARY = "meet.calendar.secondaryTimeZone"
        /** `MobileCalendarLayout.defaultLayoutKey`: the exact layout, beside the shared day/week/month. */
        const val KEY_MOBILE_DEFAULT_VIEW = "meet.calendar.mobileDefaultView"

        /** The keys [read] reads: a change to one is a change of display. */
        val KEYS: Set<String> = setOf(KEY_START, KEY_END, KEY_DURATION, KEY_SNAP, KEY_DECLINED, KEY_HIDDEN, KEY_HOUR_HEIGHT, KEY_SECONDARY)

        const val DEFAULT_START = 8
        const val DEFAULT_END = 20
        const val DEFAULT_DURATION = 60
        const val DEFAULT_SNAP = 15
        const val DEFAULT_HOUR_HEIGHT = 48f
        const val MIN_HOUR_HEIGHT = 24f
        const val MAX_HOUR_HEIGHT = 160f
        /** The slider's step, as iOS. */
        const val HOUR_HEIGHT_STEP = 4f

        val durationChoices = listOf(15, 30, 45, 60, 90)
        val snapChoices = listOf(5, 10, 15, 30)

        fun clampHour(value: Int): Int = value.coerceIn(0, 23)

        fun clampHourHeight(value: Float): Float = value.coerceIn(MIN_HOUR_HEIGHT, MAX_HOUR_HEIGHT)

        /** A pinch: the height the gesture started from, times its scale, inside the range. */
        fun zoomed(base: Float, scale: Float): Float = clampHourHeight(base * scale)

        fun read(values: Map<String, Any?>): CalendarDisplay {
            val start = clampHour(int(values[KEY_START]) ?: DEFAULT_START)
            val end = maxOf(clampHour(int(values[KEY_END]) ?: DEFAULT_END), start + 1)
            val duration = int(values[KEY_DURATION])?.takeIf { it in durationChoices } ?: DEFAULT_DURATION
            val snap = int(values[KEY_SNAP])?.takeIf { it in snapChoices } ?: DEFAULT_SNAP
            val height = (values[KEY_HOUR_HEIGHT] as? Number)?.toFloat()?.let(::clampHourHeight) ?: DEFAULT_HOUR_HEIGHT
            val zone = (values[KEY_SECONDARY] as? String)?.takeIf { id -> CalendarValues.scheduleTimeZones.any { it.id == id } }
            return CalendarDisplay(
                dayStartHour = start,
                dayEndHour = end,
                durationMinutes = duration,
                snapMinutes = snap,
                hourHeight = height,
                showsDeclined = values[KEY_DECLINED] as? Boolean ?: true,
                showsHidden = values[KEY_HIDDEN] as? Boolean ?: false,
                secondaryZoneId = zone,
            )
        }

        /**
         * `MobileCalendarStore.init`: the exact layout the owner picked, else
         * the shared day/week/month (a week is 3 Days on the phone), else Day
         * on a phone and 3 Days on a [tablet] (the iPad's fallback).
         */
        fun openingLayout(values: Map<String, Any?>, tablet: Boolean = false): CalendarLayout {
            CalendarLayout.of(values[KEY_MOBILE_DEFAULT_VIEW] as? String)?.let { return it }
            return when (values[KEY_DEFAULT_VIEW] as? String) {
                "week" -> CalendarLayout.THREE_DAY
                "month" -> CalendarLayout.MONTH
                null -> if (tablet) CalendarLayout.THREE_DAY else CalendarLayout.DAY
                else -> CalendarLayout.DAY
            }
        }

        /** iOS `userInterfaceIdiom == .pad`: the device, not the window, as on iOS. */
        fun isTablet(context: android.content.Context): Boolean = context.resources.configuration.smallestScreenWidthDp >= 600

        /** `defaultViewMode`: what the Mac reads back from a phone's choice. */
        fun sharedView(layout: CalendarLayout): String = when (layout) {
            CalendarLayout.DAY -> "day"
            CalendarLayout.MONTH -> "month"
            CalendarLayout.TWO_DAY, CalendarLayout.THREE_DAY, CalendarLayout.AGENDA -> "week"
        }

        /** `secondaryHourLabel`: the hour that row is in the other zone, on the first day shown. */
        fun secondaryHour(hour: Int, day: LocalDate, viewer: ZoneId, other: ZoneId): Int {
            val instant: Instant = day.atStartOfDay(viewer).plusHours(hour.toLong()).toInstant()
            return instant.atZone(other).hour
        }

        private fun int(value: Any?): Int? = (value as? Number)?.toInt()
    }
}
