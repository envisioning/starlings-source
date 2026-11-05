package work.starlings.android.workspace.calendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** `Sources/WeatherForecast.swift`, case by case as `StarlingsEnvisioningTests` holds it. */
class CalendarWeatherTest {
    @Test
    fun forecastUrlCarriesOnlyACoarseCoordinateAndTheLocalZone() {
        val place = WeatherPlace.of("Lisbon, Portugal", 38.716_67, -9.133_33)
        val url = WeatherForecasts.forecastUrl(place, "Europe/Lisbon", "celsius")
        assertEquals("api.open-meteo.com", url.host)
        assertEquals("/v1/forecast", url.encodedPath)
        assertEquals("38.72", url.queryParameter("latitude"))
        assertEquals("-9.13", url.queryParameter("longitude"))
        assertEquals("Europe/Lisbon", url.queryParameter("timezone"))
        assertEquals("celsius", url.queryParameter("temperature_unit"))
        assertEquals("weather_code,temperature_2m_max,temperature_2m_min", url.queryParameter("daily"))
        assertEquals("5", url.queryParameter("past_days"))
        assertEquals("16", url.queryParameter("forecast_days"))
        assertFalse(url.toString().contains("Lisbon, Portugal"))
    }

    @Test
    fun placeRoundsCoordinatesOnTheWayIn() {
        val place = WeatherPlace.of("Desk", 38.716_674_1, -9.133_339_9)
        assertEquals(38.72, place.latitude, 0.0001)
        assertEquals(-9.13, place.longitude, 0.0001)
        // Half away from zero, as Swift's rounded(): a negative half goes down.
        assertEquals(-0.13, WeatherPlace.of("x", 0.0, -0.125).longitude, 0.0001)
    }

    @Test
    fun conditionMapsWmoCodesAndRefusesUnknownOnes() {
        assertEquals("sun.max", WeatherCondition.code(0)?.symbol)
        assertEquals("cloud.sun", WeatherCondition.code(2)?.symbol)
        assertEquals("cloud", WeatherCondition.code(3)?.symbol)
        assertEquals("cloud.fog", WeatherCondition.code(45)?.symbol)
        assertEquals("cloud.rain", WeatherCondition.code(61)?.symbol)
        assertEquals("cloud.sun.rain", WeatherCondition.code(80)?.symbol)
        assertEquals("cloud.bolt.rain", WeatherCondition.code(95)?.symbol)
        assertNull(WeatherCondition.code(7))
        assertNull(WeatherCondition.code(-1))
    }

    @Test
    fun decodeDropsRaggedDaysAndRoundsTemperatures() {
        val days = WeatherForecasts.decode(
            OpenMeteoForecast(OpenMeteoForecast.Daily(listOf("2026-08-18", "2026-08-19", "2026-08-20"), listOf(3, 61, 0), listOf(21.4, 20.6), listOf(15.5, 12.2))),
        )
        assertEquals(2, days.size)
        assertEquals("21°/16°", days["2026-08-18"]?.summary)
        assertEquals("21°/12°", days["2026-08-19"]?.summary)
        assertEquals("cloud.rain", days["2026-08-19"]?.condition?.symbol)
        assertNull(days["2026-08-20"])
    }

    @Test
    fun decodeKeepsGoodDaysWhenTheTailIsNull() {
        val body = """{"daily":{"time":["2026-08-18","2026-08-19","2026-08-20"],"weather_code":[3,61,null],
            "temperature_2m_max":[21.4,20.6,null],"temperature_2m_min":[15.5,12.2,null]},"latitude":38.7}"""
        val days = WeatherForecasts.decodeForecast(body)
        assertEquals(2, days.size)
        assertEquals("21°/16°", days["2026-08-18"]?.summary)
        assertEquals("cloud.rain", days["2026-08-19"]?.condition?.symbol)
        assertNull(days["2026-08-20"])
    }

    @Test
    fun decodeDropsADayMissingOnlyItsTemperature() {
        val days = WeatherForecasts.decode(
            OpenMeteoForecast(OpenMeteoForecast.Daily(listOf("2026-08-18", "2026-08-19"), listOf(3, 3), listOf(21.4, null), listOf(15.5, 12.2))),
        )
        assertEquals(1, days.size)
        assertNotNull(days["2026-08-18"])
        assertNull(days["2026-08-19"])
    }

    @Test
    fun decodeSkipsDaysWithUnmappableCodes() {
        assertTrue(WeatherForecasts.decode(OpenMeteoForecast(OpenMeteoForecast.Daily(listOf("2026-08-18"), listOf(7), listOf(21.4), listOf(15.5)))).isEmpty())
    }

    @Test
    fun belowZeroRoundsAwayFromZero() {
        val days = WeatherForecasts.decode(OpenMeteoForecast(OpenMeteoForecast.Daily(listOf("2026-01-10"), listOf(71), listOf(-0.5), listOf(-3.5))))
        assertEquals("-1°/-4°", days["2026-01-10"]?.summary)
    }

    @Test
    fun placeNameDropsARegionThatRepeatsTheCity() {
        assertEquals("Lisbon, Portugal", WeatherForecasts.displayName("Lisbon", "Lisbon", "Portugal"))
        assertEquals("Austin, Texas, United States", WeatherForecasts.displayName("Austin", "Texas", "United States"))
        assertEquals("Berlin", WeatherForecasts.displayName("Berlin", null, null))
    }

    @Test
    fun searchNamesAndRoundsEachMatch() {
        val places = WeatherForecasts.decodeSearch(
            """{"results":[{"name":"Lisbon","latitude":38.71667,"longitude":-9.13333,"country":"Portugal","admin1":"Lisbon","id":1}]}""",
        )
        assertEquals(listOf(WeatherPlace("Lisbon, Portugal", 38.72, -9.13)), places)
        assertTrue(WeatherForecasts.decodeSearch("""{"generationtime_ms":0.1}""").isEmpty())
        assertNull(WeatherForecasts.searchUrl("   "))
        assertEquals("Porto Alegre", WeatherForecasts.searchUrl(" Porto Alegre ")?.queryParameter("name"))
    }

    @Test
    fun lookupSeparatesNoMatchFromUnreachable() {
        assertEquals(WeatherLookup.Matches(emptyList()), WeatherLookup.Matches(emptyList()))
        assertNotEquals(WeatherLookup.Matches(emptyList()), WeatherLookup.Unreachable("offline"))
    }

    @Test
    fun weatherIsOnByDefaultButNeedsAPlace() {
        assertTrue(WeatherPreferences.showsWeather(emptyMap()))
        assertNull(WeatherPreferences.activePlace(emptyMap()))
        val stored = WeatherPreferences.encode(WeatherPlace.of("Lisbon, Portugal", 38.72, -9.13))
        val on = mapOf(WeatherPreferences.KEY_PLACE to stored)
        assertEquals("Lisbon, Portugal", WeatherPreferences.activePlace(on)?.name)
        assertNull(WeatherPreferences.activePlace(on + (WeatherPreferences.KEY_SHOWS to false)))
        // The iOS Codable shape: name, latitude, longitude.
        assertEquals("Lisbon", WeatherPreferences.place(mapOf(WeatherPreferences.KEY_PLACE to """{"name":"Lisbon","latitude":38.72,"longitude":-9.13}"""))?.name)
        assertNull(WeatherPreferences.place(mapOf(WeatherPreferences.KEY_PLACE to "not json")))
    }
}
