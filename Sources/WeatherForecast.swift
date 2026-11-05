import Foundation

/// The forecast drawn in the calendar's day header.
///
/// Open-Meteo rather than WeatherKit: no API key, no entitlement, and no
/// provisioning profile to embed alongside Developer ID signing. That last one
/// is the trap — a WeatherKit build compiles perfectly and then returns
/// nothing at runtime if the App ID was never enabled for it, which is a
/// failure you only ever see on a shipped app. The cost of the trade is one
/// more third-party host the Mac talks to, which is why nothing is fetched
/// until someone names a place in Settings (`docs/PRIVACY.md`).

/// Where the forecast is for.
struct WeatherPlace: Codable, Equatable, Sendable {
    /// What Settings shows and what the geocoder resolved — "Lisbon, Portugal".
    let name: String
    let latitude: Double
    let longitude: Double

    /// Two decimal places is a little over a kilometre. Rounding here, on the
    /// way in, means the coordinate that is stored — and therefore the only
    /// coordinate that can ever leave the Mac — names the city, not the desk.
    init(name: String, latitude: Double, longitude: Double) {
        self.name = name
        self.latitude = (latitude * 100).rounded() / 100
        self.longitude = (longitude * 100).rounded() / 100
    }
}

/// Weather is off until it is both switched on and pointed somewhere. With no
/// place set no request is made at all, so the default state of the app is
/// still one that never talks to Open-Meteo.
enum WeatherPreferences {
    static let didChangeNotification = Notification.Name("MeetCalendarWeatherPreferencesDidChange")

    private enum Key {
        static let shows = "meet.calendar.showsWeather"
        static let place = "meet.calendar.weatherPlace"
    }

    static func showsWeather(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: Key.shows) as? Bool ?? true
    }

    static func setShowsWeather(_ value: Bool, _ defaults: UserDefaults = .standard) {
        defaults.set(value, forKey: Key.shows)
        NotificationCenter.default.post(name: didChangeNotification, object: nil)
    }

    static func place(_ defaults: UserDefaults = .standard) -> WeatherPlace? {
        guard let data = defaults.data(forKey: Key.place) else { return nil }
        return try? JSONDecoder().decode(WeatherPlace.self, from: data)
    }

    static func setPlace(_ place: WeatherPlace?, _ defaults: UserDefaults = .standard) {
        if let place, let data = try? JSONEncoder().encode(place) {
            defaults.set(data, forKey: Key.place)
        } else {
            defaults.removeObject(forKey: Key.place)
        }
        NotificationCenter.default.post(name: didChangeNotification, object: nil)
    }

    /// The place to draw for, or `nil` for every reason there is not to draw.
    static func activePlace(_ defaults: UserDefaults = .standard) -> WeatherPlace? {
        showsWeather(defaults) ? place(defaults) : nil
    }
}

/// A WMO code as something to draw. Daily aggregates have no night, so the
/// symbols are all daytime ones.
struct WeatherCondition: Equatable, Sendable {
    let symbolName: String
    /// Tooltip and accessibility text — the symbol alone does not say "sleet".
    let label: String

    /// WMO 4677 interpretation codes, in the subset Open-Meteo actually
    /// reports. `nil` for anything outside it: no icon reads better than a
    /// confidently wrong one.
    static func code(_ code: Int) -> WeatherCondition? {
        switch code {
        case 0: return .init(symbolName: "sun.max", label: String(localized: "Clear"))
        case 1: return .init(symbolName: "sun.max", label: String(localized: "Mainly clear"))
        case 2: return .init(symbolName: "cloud.sun", label: String(localized: "Partly cloudy"))
        case 3: return .init(symbolName: "cloud", label: String(localized: "Overcast"))
        case 45, 48: return .init(symbolName: "cloud.fog", label: String(localized: "Fog"))
        case 51, 53, 55: return .init(symbolName: "cloud.drizzle", label: String(localized: "Drizzle"))
        case 56, 57: return .init(symbolName: "cloud.sleet", label: String(localized: "Freezing drizzle"))
        case 61, 63: return .init(symbolName: "cloud.rain", label: String(localized: "Rain"))
        case 65: return .init(symbolName: "cloud.heavyrain", label: String(localized: "Heavy rain"))
        case 66, 67: return .init(symbolName: "cloud.sleet", label: String(localized: "Freezing rain"))
        case 71, 73: return .init(symbolName: "cloud.snow", label: String(localized: "Snow"))
        case 75: return .init(symbolName: "cloud.snow", label: String(localized: "Heavy snow"))
        case 77: return .init(symbolName: "cloud.snow", label: String(localized: "Snow grains"))
        case 80, 81: return .init(symbolName: "cloud.sun.rain", label: String(localized: "Showers"))
        case 82: return .init(symbolName: "cloud.heavyrain", label: String(localized: "Heavy showers"))
        case 85, 86: return .init(symbolName: "cloud.snow", label: String(localized: "Snow showers"))
        case 95: return .init(symbolName: "cloud.bolt.rain", label: String(localized: "Thunderstorm"))
        case 96, 99: return .init(symbolName: "cloud.bolt.rain", label: String(localized: "Thunderstorm with hail"))
        default: return nil
        }
    }
}

/// One day's sky, already rounded to what the header draws.
struct DailyForecast: Equatable, Sendable {
    /// `yyyy-MM-dd` in the Mac's own time zone. The request names that zone
    /// explicitly rather than the place's, so a row always lines up with the
    /// column drawn over it — otherwise a forecast for Lisbon read on a Mac in
    /// Los Angeles would sit a day off.
    let day: String
    let condition: WeatherCondition
    let high: Int
    let low: Int

    /// "21°/16°" — what fits above a day number.
    var summary: String { "\(high)°/\(low)°" }
}

/// Open-Meteo answers in parallel arrays rather than a row per day, and pads
/// the far end of the window with `null` where it has no data yet. Decoding
/// those as non-optional throws away the whole response over one missing day,
/// which is a silent total failure — hence the optionals.
struct OpenMeteoForecastResponse: Decodable, Sendable {
    struct Daily: Decodable, Sendable {
        let time: [String]
        let weatherCode: [Int?]
        let high: [Double?]
        let low: [Double?]

        enum CodingKeys: String, CodingKey {
            case time
            case weatherCode = "weather_code"
            case high = "temperature_2m_max"
            case low = "temperature_2m_min"
        }
    }

    let daily: Daily
}

struct OpenMeteoGeocodingResponse: Decodable, Sendable {
    struct Match: Decodable, Sendable {
        let name: String
        let latitude: Double
        let longitude: Double
        let country: String?
        let admin1: String?
    }

    let results: [Match]?
}

/// What a forecast fetch came back with. `days` may be a stale cache, and
/// `failure` may be set even when `days` is not empty.
struct WeatherForecastOutcome: Equatable, Sendable {
    let days: [String: DailyForecast]
    /// Diagnostic text for the log when the fetch failed; `nil` on success.
    let failure: String?
}

/// A city lookup either answered — possibly with nothing — or could not be
/// reached. Settings says something different for each.
enum WeatherLookupResult: Equatable, Sendable {
    case matches([WeatherPlace])
    case unreachable(String)
}

@MainActor
enum WeatherForecastService {
    /// Long enough that paging weeks never refetches, short enough that a
    /// window left open overnight is not showing yesterday's sky.
    private static let cacheTTL: TimeInterval = 30 * 60
    /// 16 is Open-Meteo's ceiling. The days behind cover a week scrolled back.
    private nonisolated static let forecastDays = 16
    private nonisolated static let pastDays = 5

    private static var cache: (place: WeatherPlace, fetchedAt: Date, days: [String: DailyForecast])?

    /// Fahrenheit only where the locale actually uses it. Open-Meteo converts
    /// server-side, so nothing on this side has to.
    nonisolated static var temperatureUnit: String {
        Locale.current.measurementSystem == .us ? "fahrenheit" : "celsius"
    }

    nonisolated static func forecastURL(
        for place: WeatherPlace,
        timeZone: TimeZone = .current,
        unit: String = temperatureUnit
    ) -> URL {
        var components = URLComponents()
        components.scheme = "https"
        components.host = "api.open-meteo.com"
        components.path = "/v1/forecast"
        components.queryItems = [
            URLQueryItem(name: "latitude", value: String(place.latitude)),
            URLQueryItem(name: "longitude", value: String(place.longitude)),
            URLQueryItem(name: "daily", value: "weather_code,temperature_2m_max,temperature_2m_min"),
            URLQueryItem(name: "timezone", value: timeZone.identifier),
            URLQueryItem(name: "temperature_unit", value: unit),
            URLQueryItem(name: "past_days", value: String(pastDays)),
            URLQueryItem(name: "forecast_days", value: String(forecastDays)),
        ]
        return components.url!
    }

    nonisolated static func searchURL(matching query: String) -> URL? {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        var components = URLComponents()
        components.scheme = "https"
        components.host = "geocoding-api.open-meteo.com"
        components.path = "/v1/search"
        components.queryItems = [
            URLQueryItem(name: "name", value: trimmed),
            URLQueryItem(name: "count", value: "5"),
            URLQueryItem(name: "format", value: "json"),
        ]
        return components.url
    }

    /// Days by `yyyy-MM-dd`, plus why they are missing when they are.
    ///
    /// Still never throws — a header with no weather in it is the right thing
    /// to draw when the network is gone. But it no longer swallows the reason:
    /// a caller that cannot tell "past the forecast horizon" from "every
    /// request failed" has no way to report the second, and the second then
    /// looks exactly like the first forever.
    static func forecast(for place: WeatherPlace) async -> WeatherForecastOutcome {
        if let cache, cache.place == place, Date().timeIntervalSince(cache.fetchedAt) < cacheTTL {
            return WeatherForecastOutcome(days: cache.days, failure: nil)
        }
        do {
            let days = try await fetchForecast(for: place)
            cache = (place, Date(), days)
            return WeatherForecastOutcome(days: days, failure: nil)
        } catch {
            // One retry on a fresh session — the same sandboxed first-attempt
            // flake `PublicEventsCalendar` works around.
            do {
                let days = try await fetchForecast(for: place, session: URLSession(configuration: .ephemeral))
                cache = (place, Date(), days)
                return WeatherForecastOutcome(days: days, failure: nil)
            } catch {
                let diagnostic = String(describing: error)
                // A stale cache still beats a blank header, but the failure is
                // reported either way.
                guard let cache, cache.place == place else {
                    return WeatherForecastOutcome(days: [:], failure: diagnostic)
                }
                return WeatherForecastOutcome(days: cache.days, failure: diagnostic)
            }
        }
    }

    /// Best matches for a typed city, most likely first.
    ///
    /// "Nothing matched" and "couldn’t ask" are different answers and must
    /// stay different: collapsing both to an empty list is what made Settings
    /// tell people to check their spelling when the network was down.
    nonisolated static func search(matching query: String) async -> WeatherLookupResult {
        guard let url = searchURL(matching: query) else { return .matches([]) }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse else {
                return .unreachable("no HTTP response")
            }
            guard (200..<300).contains(http.statusCode) else {
                return .unreachable("HTTP \(http.statusCode)")
            }
            let decoded = try JSONDecoder().decode(OpenMeteoGeocodingResponse.self, from: data)
            return .matches((decoded.results ?? []).map {
                WeatherPlace(
                    name: displayName(name: $0.name, region: $0.admin1, country: $0.country),
                    latitude: $0.latitude,
                    longitude: $0.longitude
                )
            })
        } catch {
            return .unreachable(String(describing: error))
        }
    }

    /// "Lisbon, Portugal", not "Lisbon, Lisbon, Portugal" — the geocoder names
    /// a city's own district as its region often enough to matter.
    nonisolated static func displayName(name: String, region: String?, country: String?) -> String {
        var parts = [name]
        if let region, !region.isEmpty, region.caseInsensitiveCompare(name) != .orderedSame {
            parts.append(region)
        }
        if let country, !country.isEmpty, country.caseInsensitiveCompare(name) != .orderedSame {
            parts.append(country)
        }
        return parts.joined(separator: ", ")
    }

    private nonisolated static func fetchForecast(
        for place: WeatherPlace,
        session: URLSession = .shared
    ) async throws -> [String: DailyForecast] {
        let (data, response) = try await session.data(from: forecastURL(for: place))
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return decode(try JSONDecoder().decode(OpenMeteoForecastResponse.self, from: data))
    }

    /// A short array, a ragged one, or a `null` in any of them is a real answer
    /// and not a decode failure. Only the days that cannot be completed are
    /// dropped — never the whole response.
    nonisolated static func decode(_ response: OpenMeteoForecastResponse) -> [String: DailyForecast] {
        let daily = response.daily
        var days: [String: DailyForecast] = [:]
        for (index, day) in daily.time.enumerated() {
            guard index < daily.weatherCode.count,
                  index < daily.high.count,
                  index < daily.low.count,
                  let rawCode = daily.weatherCode[index],
                  let high = daily.high[index],
                  let low = daily.low[index],
                  let condition = WeatherCondition.code(rawCode)
            else { continue }
            days[day] = DailyForecast(
                day: day,
                condition: condition,
                high: Int(high.rounded()),
                low: Int(low.rounded())
            )
        }
        return days
    }
}
