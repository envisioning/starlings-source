package work.starlings.android.workspace.calendar

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import work.starlings.android.R
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.roundToInt
import kotlin.math.sign

/**
 * `Sources/WeatherForecast.swift`: the forecast drawn in the day heads.
 * Open-Meteo, as iOS: no key, and nothing is fetched until the person names
 * a place under Calendar › Weather (docs/PRIVACY.md). No Android types here
 * except the string ids, so `CalendarWeatherTest` runs on the JVM.
 */

/** `WeatherPlace`: the coordinate is rounded on the way in, so only the city can leave the phone. */
@Serializable
data class WeatherPlace(val name: String, val latitude: Double, val longitude: Double) {
    companion object {
        /** Two decimal places, a little over a kilometre. Half away from zero, as Swift's `rounded()`. */
        fun of(name: String, latitude: Double, longitude: Double): WeatherPlace =
            WeatherPlace(name, round2(latitude), round2(longitude))

        private fun round2(value: Double): Double = sign(value) * floor(abs(value) * 100 + 0.5) / 100
    }
}

/**
 * `WeatherCondition`: a WMO 4677 code as a sky to draw and the words for it.
 * [symbol] is the SF Symbol name iOS draws; [CalendarWeatherIcons] maps it.
 */
data class WeatherCondition(val symbol: String, val label: Int) {
    companion object {
        /** Null outside the subset Open-Meteo reports: no icon reads better than a wrong one. */
        fun code(code: Int): WeatherCondition? = when (code) {
            0 -> WeatherCondition("sun.max", R.string.cal_weather_clear)
            1 -> WeatherCondition("sun.max", R.string.cal_weather_mainly_clear)
            2 -> WeatherCondition("cloud.sun", R.string.cal_weather_partly_cloudy)
            3 -> WeatherCondition("cloud", R.string.cal_weather_overcast)
            45, 48 -> WeatherCondition("cloud.fog", R.string.cal_weather_fog)
            51, 53, 55 -> WeatherCondition("cloud.drizzle", R.string.cal_weather_drizzle)
            56, 57 -> WeatherCondition("cloud.sleet", R.string.cal_weather_freezing_drizzle)
            61, 63 -> WeatherCondition("cloud.rain", R.string.cal_weather_rain)
            65 -> WeatherCondition("cloud.heavyrain", R.string.cal_weather_heavy_rain)
            66, 67 -> WeatherCondition("cloud.sleet", R.string.cal_weather_freezing_rain)
            71, 73 -> WeatherCondition("cloud.snow", R.string.cal_weather_snow)
            75 -> WeatherCondition("cloud.snow", R.string.cal_weather_heavy_snow)
            77 -> WeatherCondition("cloud.snow", R.string.cal_weather_snow_grains)
            80, 81 -> WeatherCondition("cloud.sun.rain", R.string.cal_weather_showers)
            82 -> WeatherCondition("cloud.heavyrain", R.string.cal_weather_heavy_showers)
            85, 86 -> WeatherCondition("cloud.snow", R.string.cal_weather_snow_showers)
            95 -> WeatherCondition("cloud.bolt.rain", R.string.cal_weather_thunderstorm)
            96, 99 -> WeatherCondition("cloud.bolt.rain", R.string.cal_weather_thunderstorm_hail)
            else -> null
        }
    }
}

/** `DailyForecast`: one day's sky, rounded to what the head draws. [day] is `yyyy-MM-dd` in the phone's zone. */
data class DailyForecast(val day: String, val condition: WeatherCondition, val high: Int, val low: Int) {
    /** "21°/16°": what fits above a day number. */
    val summary: String get() = "$high°/$low°"
}

/** Open-Meteo's parallel arrays. Nullable, because it pads the far end of the window with `null`. */
@Serializable
data class OpenMeteoForecast(val daily: Daily) {
    @Serializable
    data class Daily(
        val time: List<String>,
        @SerialName("weather_code") val weatherCode: List<Int?>,
        @SerialName("temperature_2m_max") val high: List<Double?>,
        @SerialName("temperature_2m_min") val low: List<Double?>,
    )
}

@Serializable
data class OpenMeteoGeocoding(val results: List<Match>? = null) {
    @Serializable
    data class Match(
        val name: String,
        val latitude: Double,
        val longitude: Double,
        val country: String? = null,
        val admin1: String? = null,
    )
}

/** `WeatherLookupResult`: "nothing matched" and "couldn't ask" stay different answers. */
sealed interface WeatherLookup {
    data class Matches(val places: List<WeatherPlace>) : WeatherLookup
    data class Unreachable(val reason: String) : WeatherLookup
}

/** `WeatherForecastOutcome`: [days] may be a stale cache, and [failure] may be set beside it. */
data class WeatherOutcome(val days: Map<String, DailyForecast>, val failure: String?)

/**
 * `WeatherPreferences`: off until switched on and pointed somewhere, under
 * the keys iOS uses. With no place no request is made at all.
 */
object WeatherPreferences {
    const val KEY_SHOWS = "meet.calendar.showsWeather"
    const val KEY_PLACE = "meet.calendar.weatherPlace"

    private val json = Json { ignoreUnknownKeys = true }

    fun showsWeather(values: Map<String, Any?>): Boolean = values[KEY_SHOWS] as? Boolean ?: true

    fun place(values: Map<String, Any?>): WeatherPlace? =
        (values[KEY_PLACE] as? String)?.let { runCatching { json.decodeFromString(WeatherPlace.serializer(), it) }.getOrNull() }

    fun encode(place: WeatherPlace): String = json.encodeToString(WeatherPlace.serializer(), place)

    /** The place to draw for, or null for every reason not to draw. */
    fun activePlace(values: Map<String, Any?>): WeatherPlace? = if (showsWeather(values)) place(values) else null
}

/** `WeatherForecastService`: the two Open-Meteo reads, a 30-minute cache and one retry. */
object WeatherForecasts {
    /** 16 is Open-Meteo's ceiling. The days behind cover a week scrolled back. */
    const val FORECAST_DAYS = 16
    const val PAST_DAYS = 5
    private const val CACHE_TTL_MS = 30 * 60_000L

    private val json = Json { ignoreUnknownKeys = true }
    private val http = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build()
    private var cache: Triple<WeatherPlace, Long, Map<String, DailyForecast>>? = null

    fun forecastUrl(place: WeatherPlace, zoneId: String, unit: String): HttpUrl = HttpUrl.Builder()
        .scheme("https")
        .host("api.open-meteo.com")
        .addPathSegments("v1/forecast")
        .addQueryParameter("latitude", place.latitude.toString())
        .addQueryParameter("longitude", place.longitude.toString())
        .addQueryParameter("daily", "weather_code,temperature_2m_max,temperature_2m_min")
        .addQueryParameter("timezone", zoneId)
        .addQueryParameter("temperature_unit", unit)
        .addQueryParameter("past_days", PAST_DAYS.toString())
        .addQueryParameter("forecast_days", FORECAST_DAYS.toString())
        .build()

    fun searchUrl(query: String): HttpUrl? {
        val trimmed = query.trim()
        if (trimmed.isEmpty()) return null
        return HttpUrl.Builder()
            .scheme("https")
            .host("geocoding-api.open-meteo.com")
            .addPathSegments("v1/search")
            .addQueryParameter("name", trimmed)
            .addQueryParameter("count", "5")
            .addQueryParameter("format", "json")
            .build()
    }

    /** "Lisbon, Portugal", not "Lisbon, Lisbon, Portugal". */
    fun displayName(name: String, region: String?, country: String?): String {
        val parts = mutableListOf(name)
        if (!region.isNullOrEmpty() && !region.equals(name, ignoreCase = true)) parts += region
        if (!country.isNullOrEmpty() && !country.equals(name, ignoreCase = true)) parts += country
        return parts.joinToString(", ")
    }

    /** Only the days that cannot be completed are dropped, never the whole answer. */
    fun decode(response: OpenMeteoForecast): Map<String, DailyForecast> {
        val d = response.daily
        val days = LinkedHashMap<String, DailyForecast>()
        d.time.forEachIndexed { index, day ->
            val code = d.weatherCode.getOrNull(index) ?: return@forEachIndexed
            val high = d.high.getOrNull(index) ?: return@forEachIndexed
            val low = d.low.getOrNull(index) ?: return@forEachIndexed
            val condition = WeatherCondition.code(code) ?: return@forEachIndexed
            days[day] = DailyForecast(day, condition, roundHalfAway(high), roundHalfAway(low))
        }
        return days
    }

    fun decodeForecast(body: String): Map<String, DailyForecast> = decode(json.decodeFromString(OpenMeteoForecast.serializer(), body))

    fun decodeSearch(body: String): List<WeatherPlace> =
        json.decodeFromString(OpenMeteoGeocoding.serializer(), body).results.orEmpty().map {
            WeatherPlace.of(displayName(it.name, it.admin1, it.country), it.latitude, it.longitude)
        }

    /** Never throws: a head with no sky is right when the network is gone, and the reason is kept. */
    suspend fun forecast(place: WeatherPlace, zoneId: String, unit: String): WeatherOutcome {
        val now = System.currentTimeMillis()
        cache?.let { (p, at, days) -> if (p == place && now - at < CACHE_TTL_MS) return WeatherOutcome(days, null) }
        var failure: String? = null
        repeat(2) {
            try {
                val days = decodeForecast(get(forecastUrl(place, zoneId, unit)))
                cache = Triple(place, System.currentTimeMillis(), days)
                return WeatherOutcome(days, null)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure = e.toString()
            }
        }
        // A stale cache still beats a blank head; the failure is reported either way.
        val stale = cache?.takeIf { it.first == place }?.third.orEmpty()
        return WeatherOutcome(stale, failure)
    }

    suspend fun search(query: String): WeatherLookup {
        val url = searchUrl(query) ?: return WeatherLookup.Matches(emptyList())
        return try {
            WeatherLookup.Matches(decodeSearch(get(url)))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            WeatherLookup.Unreachable(e.toString())
        }
    }

    private suspend fun get(url: HttpUrl): String = withContext(Dispatchers.IO) {
        http.newCall(Request.Builder().url(url).get().build()).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException("HTTP ${response.code}")
            response.body?.string() ?: throw IllegalStateException("no body")
        }
    }

    private fun roundHalfAway(value: Double): Int = (sign(value) * floor(abs(value) + 0.5)).roundToInt()
}
