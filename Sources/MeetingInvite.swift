import Foundation

/// Thin calendar-native invite packaging: absolute join URL + optional `.ics`.
enum MeetingInvite {
    /// Guest-facing permalink host for Release / production shares: the
    /// active workspace's public origin, so no workspace hands out another
    /// workspace's host.
    static var publicWebOrigin: String { StarlingsWorkspace.active.publicOrigin }

    /// The member-only room exposed from the Team surfaces. Keep the slug in
    /// one place so native affordances cannot drift from `/room/team`.
    static let internalRoomSlug = "team"

    static func absoluteURL(path: String, webOrigin: String = publicWebOrigin) -> String {
        let normalizedPath = path.hasPrefix("/") ? path : "/\(path)"
        let origin = webOrigin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return "\(origin)\(normalizedPath)"
    }

    static func absoluteURL(slug: String, webOrigin: String = publicWebOrigin) -> String {
        absoluteURL(path: "/room/\(slug)", webOrigin: webOrigin)
    }

    /// Canonical `/room/<slug>[/<token>]` URL → slug. A short `/<slug>` URL is
    /// not a room.
    static func roomSlug(fromJoinURL url: String) -> String? {
        guard let path = URL(string: url)?.path else { return nil }
        let parts = path.split(separator: "/").map(String.init)
        guard parts.first == "room", parts.count >= 2 else { return nil }
        let slug = parts[1].lowercased()
        return slug.isEmpty ? nil : slug
    }

    /// Origin for copy-link / calendar joins from this Mac build.
    /// Debug (`MEET_WEB_ORIGIN` on loopback) keeps localhost so the pasted URL
    /// hits the same stack the host is leasing. Release always uses the public
    /// permalink host — never workers.dev.
    static func shareOrigin(configuredWebOrigin: String) -> String {
        let trimmed = configuredWebOrigin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return isLoopbackOrigin(trimmed) ? trimmed : publicWebOrigin
    }

    /// Normalize a canonical room URL for display and pasteboard. A non-room
    /// URL (including the retired short `/<slug>` form) passes through untouched.
    /// Loopback stays loopback (Debug); everything else → `publicWebOrigin`.
    static func canonicalJoinURL(_ url: String) -> String {
        guard let parsed = URL(string: url) else { return url }
        let parts = parsed.path.split(separator: "/").map(String.init)
        guard let slug = roomSlug(fromJoinURL: url) else { return url }
        let token = parts.count >= 3 ? parts[2] : nil
        let canonicalPath = "/room/\(slug)" + (token.map { "/\($0)" } ?? "")
        if isLoopbackHost(parsed.host) {
            return absoluteURL(path: canonicalPath, webOrigin: loopbackOrigin(from: parsed))
        }
        return absoluteURL(path: canonicalPath)
    }

    /// Compact label for the UI row: `host[:port]/path` (no scheme).
    /// Keeps `:5173` on Debug loopback so the visible link matches Vite.
    static func displayJoinURL(_ url: String) -> String {
        guard let parsed = URL(string: url), let host = parsed.host else { return url }
        let authority: String
        if let port = parsed.port {
            authority = "\(host):\(port)"
        } else {
            authority = host
        }
        return "\(authority)\(parsed.path)"
    }

    private static func isLoopbackOrigin(_ origin: String) -> Bool {
        isLoopbackHost(URL(string: origin)?.host)
    }

    private static func isLoopbackHost(_ host: String?) -> Bool {
        guard let host = host?.lowercased() else { return false }
        return host == "127.0.0.1" || host == "localhost" || host == "::1"
    }

    private static func loopbackOrigin(from url: URL) -> String {
        let scheme = url.scheme ?? "http"
        let host = url.host ?? "127.0.0.1"
        if let port = url.port {
            return "\(scheme)://\(host):\(port)"
        }
        return "\(scheme)://\(host)"
    }

    /// Compact text that pastes cleanly into Calendar / Slack / email.
    static func inviteText(url: String, expiresAt: Date? = nil, now: Date = .now) -> String {
        var lines = [
            "Starlings",
            url,
        ]
        if let expiresAt {
            let formatter = RelativeDateTimeFormatter()
            formatter.unitsStyle = .full
            formatter.locale = StarlingsDateFormatting.locale
            let relative = formatter.localizedString(for: expiresAt, relativeTo: now)
            lines.append(String(localized: "Link expires \(relative)."))
        }
        return lines.joined(separator: "\n")
    }

    static func calendarEventICS(
        title: String = "Starlings",
        url: String,
        start: Date,
        duration: TimeInterval = 3_600,
        expiresAt: Date? = nil,
        uid: String = "meet-\(UUID().uuidString.lowercased())@\(EnvisioningDeployment.calendarUIDDomain)",
        stampedAt: Date = .now
    ) -> String {
        let end = start.addingTimeInterval(duration)
        var description = String(localized: "Join: \(url)")
        if let expiresAt {
            description += "\n" + String(localized: "Link expires \(icsDate(expiresAt)).")
        }
        let lines = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:\(EnvisioningDeployment.calendarProductID)",
            "CALSCALE:GREGORIAN",
            "METHOD:PUBLISH",
            "BEGIN:VEVENT",
            "UID:\(uid)",
            "DTSTAMP:\(icsDate(stampedAt))",
            "DTSTART:\(icsDate(start))",
            "DTEND:\(icsDate(end))",
            "SUMMARY:\(escapeICS(title))",
            "DESCRIPTION:\(escapeICS(description))",
            "URL:\(url)",
            "LOCATION:\(escapeICS(url))",
            "END:VEVENT",
            "END:VCALENDAR",
        ]
        return lines.joined(separator: "\r\n") + "\r\n"
    }

    /// Writes a temporary `.ics` and returns its file URL for Calendar.app.
    static func writeCalendarEventFile(
        title: String = "Starlings",
        url: String,
        start: Date = Self.nextQuarterHour(),
        duration: TimeInterval = 3_600,
        expiresAt: Date? = nil,
        fileManager: FileManager = .default
    ) throws -> URL {
        let ics = calendarEventICS(
            title: title,
            url: url,
            start: start,
            duration: duration,
            expiresAt: expiresAt
        )
        let directory = fileManager.temporaryDirectory
            .appendingPathComponent("MeetInvites", isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        let fileURL = directory.appendingPathComponent("meet-\(UUID().uuidString.lowercased()).ics")
        try Data(ics.utf8).write(to: fileURL, options: .atomic)
        return fileURL
    }

    static func nextQuarterHour(from date: Date = .now) -> Date {
        let interval: TimeInterval = 15 * 60
        let next = floor(date.timeIntervalSinceReferenceDate / interval) * interval + interval
        return Date(timeIntervalSinceReferenceDate: next)
    }

    private static func icsDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        return formatter.string(from: date)
    }

    private static func escapeICS(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: ";", with: "\\;")
            .replacingOccurrences(of: ",", with: "\\,")
            .replacingOccurrences(of: "\n", with: "\\n")
    }
}
