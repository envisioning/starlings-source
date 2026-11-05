import Foundation
import StarlingsContracts

struct MobileRoomPath: Equatable, Sendable {
    let slug: String
    let bookingToken: String?

    init?(input: String) {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        // A link on another workspace's host is that workspace's room, not
        // a room here.
        guard !trimmed.isEmpty, StarlingsWorkspaceLink.isActive(trimmed) else { return nil }

        let components: [String]
        let isURL: Bool
        if let url = URL(string: trimmed), url.scheme != nil {
            components = url.pathComponents.filter { $0 != "/" }
            isURL = true
        } else {
            components = trimmed.split(separator: "/").map(String.init)
            isURL = false
        }

        // A bare typed slug is a room. A pasted URL or path is a room only in
        // its canonical /room form; the short /<slug> form is not a room.
        let rawSlug: String
        let token: String?
        if let roomIndex = components.firstIndex(of: "room"), components.indices.contains(roomIndex + 1) {
            rawSlug = components[roomIndex + 1]
            token = components.indices.contains(roomIndex + 2) ? components[roomIndex + 2] : nil
        } else if !isURL, components.count == 1, let first = components.first {
            rawSlug = first
            token = nil
        } else {
            return nil
        }

        let normalized = rawSlug
            .lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"[^a-z0-9-]"#, with: "-", options: .regularExpression)
            .replacingOccurrences(of: #"-+"#, with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        guard (2...40).contains(normalized.count) else { return nil }

        slug = normalized
        bookingToken = token?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }

    var canonicalURL: String {
        let base = MeetingInvite.absoluteURL(slug: slug)
        guard let bookingToken else { return base }
        return "\(base)/\(bookingToken.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? bookingToken)"
    }
}

struct MobileGuestIdentity: Decodable, Equatable, Sendable {
    var name: String
    var email: String

    var normalized: MobileGuestIdentity {
        MobileGuestIdentity(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            email: email.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    var isValid: Bool {
        let value = normalized
        return !value.name.isEmpty
            && value.email.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) != nil
    }
}

enum MobileBookingCard: Equatable, Sendable {
    case scheduled(title: String?, subject: String?, startsAt: Date?, endsAt: Date?)
    case expired
}

extension StarlingsMintedBookingProjection {
    /// A 404 is an invite this room does not recognize. The shared wire only
    /// names booking lifecycle states, so represent that empty local card as
    /// cancelled without inventing another wire value.
    static var expired: Self {
        Self(
            title: nil,
            subject: nil,
            startsAt: nil,
            endsAt: nil,
            status: .cancelled,
            rescheduleURL: nil,
            cancelURL: nil,
            guestName: nil,
            guestEmail: nil
        )
    }

    /// Nil unless the projection names someone.
    var invitedIdentity: MobileGuestIdentity? {
        let name = guestName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let email = guestEmail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard status == .scheduled, !name.isEmpty || !email.isEmpty else { return nil }
        return MobileGuestIdentity(name: name, email: email)
    }

    var card: MobileBookingCard {
        guard status == .scheduled else { return .expired }
        let end = endsAt.flatMap(ISODate.parse)
        if let end, end < .now { return .expired }
        return .scheduled(
            title: title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            subject: subject?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            startsAt: startsAt.flatMap(ISODate.parse),
            endsAt: end
        )
    }
}

struct MobileOwnerProfile: Codable, Equatable, Sendable {
    let sub: String
    let email: String
    let name: String
    let picture: String?

    init(sub: String, email: String, name: String, picture: String?) {
        self.sub = sub
        self.email = email
        self.name = name
        self.picture = picture
    }

    init(wire: OwnerSessionResponseOwner) {
        self.init(sub: wire.sub, email: wire.email, name: wire.name, picture: wire.picture)
    }
}

struct MobileOwnerCredentials: WorkspaceStampedCredential, Equatable {
    let accessToken: String
    /// Renews the 8h access token without another Google sign-in.
    ///
    /// Optional because a session stored by a build that predates renewal has
    /// none: that owner signs in once more and then stops being asked. Single
    /// use — the Worker records which token is current and refuses the rest —
    /// so it must be replaced, never kept, after a renewal.
    let refreshToken: String?
    let owner: MobileOwnerProfile
    let apiEndpoint: String?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case owner
        case apiEndpoint = "api_endpoint"
    }

    init(
        accessToken: String,
        refreshToken: String? = nil,
        owner: MobileOwnerProfile,
        apiEndpoint: String? = nil
    ) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.owner = owner
        self.apiEndpoint = apiEndpoint
    }

    /// What a sign-in or a renewal answers (`OwnerSessionResponse`), as the
    /// Keychain keeps it. Codable above is the Keychain's format, not the wire.
    init(wire: OwnerSessionResponse) {
        self.init(accessToken: wire.accessToken, refreshToken: wire.refreshToken, owner: MobileOwnerProfile(wire: wire.owner))
    }
}

/// Home, the composer, the Live Activity and the watch bridge draw the same
/// row the calendar does: `CalendarEventSummary`, built from the generated
/// wire. What the phone reads off it beyond the shared readings lives here.
typealias MobileCalendarEvent = CalendarEventSummary

extension CalendarEventSummary {
    var startDate: Date? { CalendarDateParsing.parse(start) }
    var endDate: Date? { CalendarDateParsing.parse(end) }

    /// Placeholder rows people use to defend time are not meetings and must
    /// never win the countdown card or fire an alert.
    var hasRealTitle: Bool {
        let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return !normalized.isEmpty && normalized != "block" && normalized != "blank" && normalized != "(no title)"
    }

    /// The served platform, under the name the phone's surfaces read.
    var meetingPlatform: CalendarMeetingPlatform { platform }

    /// Ours, so the action gets the accent everywhere it appears.
    var isStarlingsRoom: Bool { platform == .starlings }

    var platformActionTitle: String { platform.actionTitle }
    var platformSymbolName: String { platform.symbolName }

    func isInProgress(at moment: Date = Date()) -> Bool {
        guard let startDate, let endDate else { return false }
        return startDate <= moment && endDate > moment
    }

    /// `launchURL` as a URL, or nil when the row has nothing to open.
    /// `htmlLink` is the calendar event page, not a conference destination;
    /// a map URL in `location` must never become an Open video action.
    var conferenceLink: URL? { launchURL.isEmpty ? nil : URL(string: launchURL) }

    var demotionKey: String {
        CalendarKeys.eventDemotion(isSubscription: calendarId.hasPrefix("sub:"), eventID: id)
    }
}

extension CalendarAttendeeSummary {
    var displayName: String { name.isEmpty ? email : name }
}

struct MobileScheduleDraft: Equatable, Sendable {
    var title = String(localized: "Starlings")
    var start = MeetingInvite.nextQuarterHour()
    var durationMinutes = CalendarWindowPreferences.defaultDurationMinutes()
    var attendees: [String] = []
    var timeZone = StarlingsScheduleTimeZone.loadPreferred()

    var end: Date { start.addingTimeInterval(TimeInterval(durationMinutes * 60)) }
}

extension String {
    fileprivate var nilIfEmpty: String? { isEmpty ? nil : self }
}
