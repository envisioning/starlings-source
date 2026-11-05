package work.starlings.android.workspace.calendar

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AcUnit
import androidx.compose.material.icons.outlined.Air
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.Grain
import androidx.compose.material.icons.outlined.Place
import androidx.compose.material.icons.outlined.PinDrop
import androidx.compose.material.icons.outlined.Thunderstorm
import androidx.compose.material.icons.outlined.Umbrella
import androidx.compose.material.icons.outlined.WaterDrop
import androidx.compose.material.icons.outlined.WbCloudy
import androidx.compose.material.icons.outlined.WbSunny
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.ui.ListFooter
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType

/** The SF Symbol each sky draws on iOS, as the nearest Material icon. */
object CalendarWeatherIcons {
    fun icon(symbol: String): ImageVector = when (symbol) {
        "sun.max" -> Icons.Outlined.WbSunny
        "cloud.sun" -> Icons.Outlined.WbCloudy
        "cloud" -> Icons.Outlined.Cloud
        "cloud.fog" -> Icons.Outlined.Air
        "cloud.drizzle" -> Icons.Outlined.Grain
        "cloud.sleet", "cloud.snow" -> Icons.Outlined.AcUnit
        "cloud.rain", "cloud.sun.rain" -> Icons.Outlined.WaterDrop
        "cloud.heavyrain" -> Icons.Outlined.Umbrella
        "cloud.bolt.rain" -> Icons.Outlined.Thunderstorm
        else -> Icons.Outlined.Cloud
    }
}

/**
 * `MobileCalendarWeatherSettingsView`: Show weather, the place with Clear,
 * then a city search whose matches set the place. Device-local, under the
 * iOS keys ([WeatherPreferences]). "No places found." and "unavailable" are
 * different answers ([WeatherLookup]).
 */
@Composable
fun CalendarWeatherSettings(store: CalendarStore) {
    val c = Starlings.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var query by rememberSaveable { mutableStateOf("") }
    var matches by remember { mutableStateOf<List<WeatherPlace>>(emptyList()) }
    var message by remember { mutableStateOf<String?>(null) }
    fun search() {
        val text = query.trim()
        if (text.isEmpty()) return
        message = null
        scope.launch {
            when (val answer = WeatherForecasts.search(text)) {
                is WeatherLookup.Matches -> {
                    matches = answer.places
                    if (answer.places.isEmpty()) message = context.getString(R.string.cal_weather_no_places)
                }
                is WeatherLookup.Unreachable -> message = context.getString(R.string.cal_weather_unavailable)
            }
        }
    }
    Column {
        ListSection(stringResource(R.string.cal_weather_title)) {
            ListRow(divider = true) {
                StarlingsToggle(stringResource(R.string.cal_show_weather), store.showsWeather, { store.showWeather(it) })
            }
            store.weatherPlace?.let { place ->
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Outlined.PinDrop, null, Modifier.size(18.dp), tint = c.primary)
                    Text(place.name, Modifier.weight(1f), style = StarlingsType.body, color = c.primary)
                    Text(
                        stringResource(R.string.cal_weather_clear_place),
                        Modifier.clickable(role = Role.Button) { store.chooseWeatherPlace(null); matches = emptyList() }.padding(4.dp),
                        style = StarlingsType.body,
                        color = c.secondary,
                    )
                }
                Divider()
            }
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                StarlingsField(
                    query, { query = it }, stringResource(R.string.cal_weather_city),
                    Modifier.weight(1f),
                    capitalization = KeyboardCapitalization.Words,
                    onSearch = { search() },
                )
                val enabled = query.isNotBlank()
                Text(
                    stringResource(R.string.cal_search),
                    Modifier.clickable(enabled = enabled, role = Role.Button) { search() }.padding(4.dp),
                    style = StarlingsType.body,
                    color = if (enabled) c.accent else c.secondary,
                )
            }
            matches.forEach { place ->
                Divider()
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable(role = Role.Button) {
                            store.chooseWeatherPlace(place)
                            query = ""
                            matches = emptyList()
                            message = null
                        }
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Outlined.Place, null, Modifier.size(18.dp), tint = c.accent)
                    Text(place.name, style = StarlingsType.body, color = c.accent)
                }
            }
            message?.let {
                Text(it, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = StarlingsType.caption, color = c.secondary)
            }
        }
        ListFooter(stringResource(R.string.cal_weather_footer))
    }
}

@Composable
private fun Divider() = HorizontalDivider(Modifier.padding(start = 16.dp), thickness = 1.dp, color = Starlings.colors.border)

/** `skyMark`: the sky and "21°/16°" in caption ink, or nothing. */
@Composable
internal fun SkyMark(forecast: DailyForecast) {
    val c = Starlings.colors
    Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(CalendarWeatherIcons.icon(forecast.condition.symbol), null, Modifier.size(12.dp), tint = c.secondary)
        Text(forecast.summary, style = StarlingsType.caption2, color = c.secondary, maxLines = 1, softWrap = false)
    }
}
