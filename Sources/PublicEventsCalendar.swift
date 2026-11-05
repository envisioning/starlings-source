import Foundation

/// Published Envisioning events, from the same projection every scheduling
/// surface reads — Meet's web Schedule screen and the booking page on
/// the organisation's site show exactly these rows, so a day that is an event day here
/// is an event day there.
///
/// Previously this scraped `https://the organisation's site/events.ics` and parsed
/// RFC 5545 by hand. The ICS feed still exists for calendar subscribers; it is
/// no longer what this reads.
enum PublicEventsCalendar {
    /// `GET /api/public/events?startDate&endDate` on the Meet control plane,
    /// which fronts Core's projection. Unscoped on purpose: published events
    /// are company-wide, so a client needs neither a room slug nor a session.
    static var feedURL: URL {
        apiBase
            .appending(path: "public")
            .appending(path: "events")
    }

    /// The active workspace's API base. Read from `StarlingsWorkspace`, which the
    /// iOS target also compiles, not from `HTTPConnectionDetailsProvider`,
    /// which it does not.
    private static var apiBase: URL { StarlingsWorkspace.active.apiBaseURL }

    static var displayName: String { String(localized: "\(StarlingsWorkspace.active.name) events") }
    static let legendCaption = String(localized: "Public")

    /// How far ahead the schedule sheet ever looks.
    private static let horizonDays = 120

    /// Default length when a timed VEVENT has DTSTART but no DTEND.
    private static let defaultTimedDuration: TimeInterval = 60 * 60

    struct Event: Equatable, Identifiable, Sendable {
        let id: String
        let title: String
        /// ISO-8601 instant (`…Z`) or date-only (`yyyy-MM-dd`) for all-day.
        let start: String
        let end: String
        let url: String
        let location: String

        var isAllDay: Bool {
            !start.contains("T")
        }

        /// The projection carries either an ISO instant or a calendar date.
        /// Home uses the date for both kinds, while timed rows also use the
        /// instant to keep their clock in the viewer's zone.
        var startDate: Date? {
            isAllDay ? PublicEventsCalendar.dateOnlyComponents(start) : ISODate.parse(start)
        }

        var endDate: Date? {
            isAllDay ? PublicEventsCalendar.dateOnlyComponents(end) : ISODate.parse(end)
        }
    }

    @MainActor
    private static var memoryCache: (fetchedAt: Date, events: [Event])?
    private static let cacheTTL: TimeInterval = 5 * 60

    /// The last projection on disk, so Home draws EVENTS on a cold start
    /// before the read lands (docs/CACHING.md). Published events are
    /// company-wide, so the snapshot is not keyed to a person.
    private static let snapshotKey = "public/events"
    private static let snapshotOwner = "public"

    /// What is already known, without a request: this run's answer, or the
    /// last one saved on disk. Rows that have ended are left out. Nil when
    /// nothing was ever read.
    @MainActor
    static func cached() -> [Event]? {
        if let memoryCache { return memoryCache.events }
        guard let snapshot = SnapshotStore.load(key: snapshotKey, owner: snapshotOwner),
              let events = try? decode(snapshot.data)
        else { return nil }
        let today = Calendar.current.startOfDay(for: Date())
        return events.filter { ($0.endDate ?? $0.startDate ?? today) >= today }
    }

    /// Fetches (or returns a short-lived cache of) published public events.
    @MainActor
    static func load(session: URLSession = .shared) async -> [Event] {
        if let memoryCache, Date().timeIntervalSince(memoryCache.fetchedAt) < cacheTTL {
            return memoryCache.events
        }
        do {
            let events = try await fetch(session: session)
            memoryCache = (Date(), events)
            return events
        } catch {
            // One retry with a fresh session — sandboxed first attempts sometimes flake.
            do {
                let events = try await fetch(session: URLSession(configuration: .ephemeral))
                memoryCache = (Date(), events)
                return events
            } catch {
                // Offline: the last projection on disk, never an empty card
                // over rows that were drawn from it a moment ago.
                return memoryCache?.events ?? cached() ?? []
            }
        }
    }

    /// One row of the shared projection. Field names match the JSON exactly.
    private struct ProjectedEvent: Decodable {
        let id: String
        let title: String
        let date: String
        let startsAt: String?
        let endsAt: String?
        let isAllDay: Bool
        let location: String?
        let signupURL: String?

        enum CodingKeys: String, CodingKey {
            case id, title, date, location
            case startsAt = "starts_at"
            case endsAt = "ends_at"
            case isAllDay = "is_all_day"
            case signupURL = "signup_url"
        }
    }

    private struct ProjectionResponse: Decodable {
        let events: [ProjectedEvent]
    }

    static func fetch(session: URLSession = .shared) async throws -> [Event] {
        var components = URLComponents(url: feedURL, resolvingAgainstBaseURL: false)
        let today = Date()
        components?.queryItems = [
            URLQueryItem(name: "startDate", value: calendarDay(today)),
            URLQueryItem(name: "endDate", value: calendarDay(
                Calendar.current.date(byAdding: .day, value: horizonDays, to: today) ?? today
            )),
        ]
        guard let endpoint = components?.url else { throw URLError(.badURL) }

        var request = URLRequest(url: endpoint)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        // A small public read. Past ten seconds it is not coming, and the
        // retry in `load` still has its own ten.
        request.timeoutInterval = 10
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw URLError(.badServerResponse)
        }
        let events = try decode(data)
        SnapshotStore.save(data, key: snapshotKey, owner: snapshotOwner)
        return events
    }

    private static func decode(_ data: Data) throws -> [Event] {
        let decoded = try JSONDecoder().decode(ProjectionResponse.self, from: data)
        return decoded.events.map { row in
            // The agenda distinguishes all-day from timed by whether `start`
            // carries a time, so keep the date-only form for all-day rows.
            Event(
                id: row.id,
                title: row.title,
                start: row.isAllDay ? row.date : (row.startsAt ?? row.date),
                end: row.isAllDay ? row.date : (row.endsAt ?? row.startsAt ?? row.date),
                url: row.signupURL ?? "",
                location: row.location ?? ""
            )
        }
    }

    /// `yyyy-MM-dd` in the host's own zone — the projection keys on calendar days.
    private static func calendarDay(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    /// Minimal RFC 5545 subset for this feed (unfold, VEVENT fields, DATE / UTC).
    ///
    /// No longer on the fetch path — events come from the shared projection
    /// above. Kept because `StarlingsEnvisioningTests` still covers it and the ICS
    /// feed is still published for calendar subscribers; delete both together.
    static func parseICS(_ text: String) -> [Event] {
        let lines = unfoldICSLines(text)
        var events: [Event] = []
        var index = 0
        while index < lines.count {
            guard lines[index].uppercased() == "BEGIN:VEVENT" else {
                index += 1
                continue
            }
            index += 1
            var fields: [String: String] = [:]
            while index < lines.count {
                let line = lines[index]
                index += 1
                let upper = line.uppercased()
                if upper == "END:VEVENT" { break }
                if upper == "BEGIN:VEVENT" {
                    index -= 1
                    break
                }
                guard let parsed = parseICSContentLine(line) else { continue }
                fields[parsed.name] = parsed.value
            }

            guard let startRaw = fields["DTSTART"],
                  let start = normalizeICSDate(startRaw) else { continue }
            let end: String
            if let endRaw = fields["DTEND"], let normalized = normalizeICSDate(endRaw) {
                end = normalized
            } else if start.contains("T"), let startDate = ISODate.parse(start) {
                end = ISODate.format(startDate.addingTimeInterval(defaultTimedDuration))
            } else if let day = dateOnlyComponents(start),
                      let next = Calendar(identifier: .gregorian).date(
                        byAdding: .day,
                        value: 1,
                        to: day
                      ) {
                end = formatDateOnly(next)
            } else {
                continue
            }

            let title = unescapeICSText(fields["SUMMARY"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { continue }
            let id = (fields["UID"] ?? "\(title)-\(start)")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            events.append(
                Event(
                    id: id,
                    title: title,
                    start: start,
                    end: end,
                    url: unescapeICSText(fields["URL"] ?? ""),
                    location: unescapeICSText(fields["LOCATION"] ?? "")
                )
            )
        }
        return events
    }

    // MARK: - ICS helpers

    private static func unfoldICSLines(_ text: String) -> [String] {
        var lines: [String] = []
        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            var line = String(raw)
            if line.hasSuffix("\r") { line.removeLast() }
            if line.hasPrefix(" ") || line.hasPrefix("\t") {
                if !lines.isEmpty {
                    lines[lines.count - 1] += String(line.dropFirst())
                }
            } else if !line.isEmpty {
                lines.append(line)
            }
        }
        return lines
    }

    private static func parseICSContentLine(_ line: String) -> (name: String, value: String)? {
        guard let colon = line.firstIndex(of: ":") else { return nil }
        let meta = String(line[..<colon])
        let value = String(line[line.index(after: colon)...])
        let name = meta.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)
            .first
            .map(String.init)?
            .uppercased()
        guard let name, !name.isEmpty else { return nil }
        return (name, value)
    }

    /// `YYYYMMDD` → `yyyy-MM-dd`; `YYYYMMDDTHHMMSSZ` → ISO-8601 with separators.
    private static func normalizeICSDate(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count == 8, trimmed.allSatisfy(\.isNumber) {
            let y = trimmed.prefix(4)
            let m = trimmed.dropFirst(4).prefix(2)
            let d = trimmed.dropFirst(6).prefix(2)
            return "\(y)-\(m)-\(d)"
        }
        // FORM #1: 20260817T153000Z
        if trimmed.count == 16,
           trimmed.hasSuffix("Z"),
           trimmed[trimmed.index(trimmed.startIndex, offsetBy: 8)] == "T" {
            let chars = Array(trimmed)
            return String([
                chars[0], chars[1], chars[2], chars[3], "-",
                chars[4], chars[5], "-",
                chars[6], chars[7], "T",
                chars[9], chars[10], ":",
                chars[11], chars[12], ":",
                chars[13], chars[14], "Z",
            ])
        }
        // Already ISO-ish
        if ISODate.parse(trimmed) != nil { return trimmed }
        if trimmed.count == 10, trimmed[trimmed.index(trimmed.startIndex, offsetBy: 4)] == "-",
           trimmed[trimmed.index(trimmed.startIndex, offsetBy: 7)] == "-" {
            return trimmed
        }
        return nil
    }

    private static func unescapeICSText(_ value: String) -> String {
        var result = ""
        result.reserveCapacity(value.count)
        var index = value.startIndex
        while index < value.endIndex {
            let ch = value[index]
            if ch == "\\", value.index(after: index) < value.endIndex {
                let next = value[value.index(after: index)]
                switch next {
                case "n", "N": result.append("\n")
                case "\\", ";", ",": result.append(next)
                default: result.append(next)
                }
                index = value.index(after: value.index(after: index))
            } else {
                result.append(ch)
                index = value.index(after: index)
            }
        }
        return result
    }

    private static func dateOnlyComponents(_ value: String) -> Date? {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: value)
    }

    private static func formatDateOnly(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}
