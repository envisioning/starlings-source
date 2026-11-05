package work.starlings.android.workspace.calendar

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import work.starlings.android.CalendarLayout
import work.starlings.android.R
import work.starlings.android.ui.ListFooter
import work.starlings.android.ui.ListMenuRow
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.MenuChoice
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType
import work.starlings.android.workspace.layoutLabel
import kotlin.math.roundToInt

/**
 * `MobileCalendarDisplaySettingsView`: the hours the day opens and closes on,
 * the default length and snap, the default view, the grid scale, declined
 * and hidden events, and the second clock. Device-local ([CalendarDisplay]).
 * The second clock offers the workspace's zones ([CalendarStore.offeredZones]).
 * The Calendars sheet pushes it on its own scroll; Settings › Calendar ›
 * Calendar display draws [CalendarDisplaySections] in its page.
 */
@Composable
fun CalendarDisplaySettings(store: CalendarStore) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
        CalendarDisplaySections(store)
    }
}

@Composable
fun CalendarDisplaySections(store: CalendarStore) {
    val c = Starlings.colors
    val context = LocalContext.current
    val d = store.display
    fun set(next: CalendarDisplay) = store.updateDisplay(next)
    fun length(minutes: Int): String =
        if (minutes >= 60 && minutes % 60 == 0) context.resources.getQuantityString(R.plurals.cal_n_hours, minutes / 60, minutes / 60)
        else context.getString(R.string.cal_n_minutes, minutes)

    Column {
        ListSection(stringResource(R.string.cal_display_title)) {
            ListMenuRow(
                stringResource(R.string.cal_day_starts), hour(d.dayStartHour),
                (0 until 24).map { h -> MenuChoice(hour(h), h == d.dayStartHour) { set(d.withStartHour(h)) } },
            )
            Divider()
            ListMenuRow(
                stringResource(R.string.cal_day_ends), hour(d.dayEndHour),
                (1 until 24).map { h -> MenuChoice(hour(h), h == d.dayEndHour) { set(d.withEndHour(h)) } },
            )
            Divider()
            ListMenuRow(
                stringResource(R.string.cal_default_length), length(d.durationMinutes),
                CalendarDisplay.durationChoices.map { m -> MenuChoice(length(m), m == d.durationMinutes) { set(d.copy(durationMinutes = m)) } },
            )
            Divider()
            ListMenuRow(
                stringResource(R.string.cal_snap_to), stringResource(R.string.cal_n_minutes, d.snapMinutes),
                CalendarDisplay.snapChoices.map { m ->
                    MenuChoice(context.getString(R.string.cal_n_minutes, m), m == d.snapMinutes) { set(d.copy(snapMinutes = m)) }
                },
            )
            Divider()
            // Every layout the bar offers, in the same order.
            val opening = store.defaultLayout
            ListMenuRow(
                stringResource(R.string.cal_default_view), stringResource(layoutLabel(opening)),
                CalendarLayout.entries.map { l -> MenuChoice(context.getString(layoutLabel(l)), l == opening) { store.setDefaultLayout(l) } },
            )
            Divider()
            ListRow(divider = true) {
                val scale = stringResource(R.string.cal_grid_scale)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(scale, style = StarlingsType.body, color = c.primary)
                    Text(stringResource(R.string.cal_grid_points, d.hourHeight.roundToInt()), style = StarlingsType.body, color = c.secondary)
                }
                Slider(
                    value = d.hourHeight,
                    onValueChange = { set(d.withHourHeight((it / CalendarDisplay.HOUR_HEIGHT_STEP).roundToInt() * CalendarDisplay.HOUR_HEIGHT_STEP)) },
                    valueRange = CalendarDisplay.MIN_HOUR_HEIGHT..CalendarDisplay.MAX_HOUR_HEIGHT,
                    steps = ((CalendarDisplay.MAX_HOUR_HEIGHT - CalendarDisplay.MIN_HOUR_HEIGHT) / CalendarDisplay.HOUR_HEIGHT_STEP).toInt() - 1,
                    colors = SliderDefaults.colors(thumbColor = c.accent, activeTrackColor = c.accent, inactiveTrackColor = c.field, activeTickColor = c.accent, inactiveTickColor = c.field),
                    modifier = Modifier.semantics { contentDescription = scale },
                )
            }
            ListRow(divider = true) {
                StarlingsToggle(stringResource(R.string.cal_show_declined), d.showsDeclined, { set(d.copy(showsDeclined = it)) })
            }
            ListRow(divider = true) {
                StarlingsToggle(stringResource(R.string.cal_show_hidden), d.showsHidden, { set(d.copy(showsHidden = it)) })
            }
            val off = stringResource(R.string.cal_off)
            ListMenuRow(
                stringResource(R.string.cal_second_timezone), d.secondaryZone?.city ?: off,
                listOf(MenuChoice(off, d.secondaryZoneId == null) { set(d.copy(secondaryZoneId = null)) }) +
                    store.offeredZones.map { z -> MenuChoice(z.city, z.id == d.secondaryZoneId) { set(d.copy(secondaryZoneId = z.id)) } },
            )
        }
        ListFooter(stringResource(R.string.cal_device_footer))
    }
}

@Composable
private fun Divider() = HorizontalDivider(Modifier.padding(start = 16.dp), thickness = 1.dp, color = Starlings.colors.border)

/** `CalendarWeekMath.hourLabel`: two digits, 24-hour. */
private fun hour(h: Int): String = "%02d".format(h.coerceIn(0, 23))
