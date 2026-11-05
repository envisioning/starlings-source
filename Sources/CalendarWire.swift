import Foundation
import StarlingsContracts

// The calendar's wire, shared by the Mac app and the iOS app. The shapes are
// generated (`StarlingsContracts`, from `packages/contracts/src/calendar.ts`);
// this file is what the clients add to them, plus the two domain models the
// app builds from EventKit as well as from the wire (`CalendarEventSummary`,
// `CalendarPreferences`) and the request bodies. The AppKit-drawn attendee
// chrome lives in CalendarAppKitChrome.swift, which only the Mac compiles.

/// `GET /api/calendar/status`, and the answer to a connect. `calendars` is
/// only on the answer to a connect: the account's calendars, listed by the
/// Worker with the access token it had just minted. The client draws from
/// these rather than listing again — see `CalendarWorkspace.noteGoogleConnected`.
typealias CalendarConnectionStatus = CalendarStatus

extension CalendarStatus {
    init(connected: Bool, email: String?) {
        self.init(connected: connected, email: email, calendars: nil)
    }
}

extension GoogleCalendarListEntry: Identifiable {
    /// A row the app makes itself (a test, a placeholder): the wire needs every
    /// field, a client rarely has more than the name.
    init(id: String, summary: String, primary: Bool = false, selected: Bool = false, writable: Bool = true, accountID: String = "", accountEmail: String = "") {
        self.init(id: id, summary: summary, primary: primary, selected: selected, writable: writable, accountID: accountID, accountEmail: accountEmail, backgroundColor: nil)
    }
}

/// The owner's stored calendar choices as the app holds them: subjects as
/// `CrmSubject`, the display policy as `UpcomingPreferencesWire`. Read from the
/// generated `CalendarPreferencesResponse` with `init(wire:)`.
struct CalendarPreferences: Equatable, Sendable {
    let selectedCalendarIds: [String]
    /// Subscribed feeds omitted from the shared Home Upcoming feed.
    let upcomingExcludedSubscriptionIds: [String]
    /// Which calendars the owner has switched off, in keys that mean the same
    /// thing on every device — see `StarlingsCalendar.visibilityKey`.
    let hiddenCalendarKeys: [String]
    /// Which calendars — and which whole accounts — the owner has taken out of
    /// the app. Stronger than hidden: a disabled calendar is not listed, not
    /// fetched, and not offered to write to. Same key grammar as above.
    let disabledCalendarKeys: [String]
    /// Individual events that stay visible but cannot become Next.
    let demotedEventKeys: [String]
    /// Master gate for EventKit calendars. False when absent so local calendar
    /// access is opt-in on every owner account.
    let includesLocalCalendars: Bool
    /// The project or lead an event is about, by the same opaque key
    /// `demotedEventKeys` uses. Owner-wide, so a room started from that event
    /// is filed under the same subject on the Mac and on the phone.
    let eventSubjects: [String: CrmSubject]
    /// One owner-wide display policy shared by Mac, iOS, and web.
    let upcoming: UpcomingPreferencesWire

    init(
        selectedCalendarIds: [String],
        upcomingExcludedSubscriptionIds: [String] = [],
        hiddenCalendarKeys: [String] = [],
        disabledCalendarKeys: [String] = [],
        demotedEventKeys: [String] = [],
        includesLocalCalendars: Bool = false,
        eventSubjects: [String: CrmSubject] = [:],
        upcoming: UpcomingPreferencesWire = .defaults
    ) {
        self.selectedCalendarIds = selectedCalendarIds
        self.upcomingExcludedSubscriptionIds = upcomingExcludedSubscriptionIds
        self.hiddenCalendarKeys = hiddenCalendarKeys
        self.disabledCalendarKeys = disabledCalendarKeys
        self.demotedEventKeys = demotedEventKeys
        self.includesLocalCalendars = includesLocalCalendars
        self.eventSubjects = eventSubjects
        self.upcoming = upcoming
    }

    init(wire: CalendarPreferencesResponse) {
        self.init(
            selectedCalendarIds: wire.selectedCalendarIDs,
            upcomingExcludedSubscriptionIds: wire.upcomingExcludedSubscriptionIDs ?? [],
            hiddenCalendarKeys: wire.hiddenCalendarKeys,
            disabledCalendarKeys: wire.disabledCalendarKeys,
            demotedEventKeys: wire.demotedEventKeys,
            includesLocalCalendars: wire.includesLocalCalendars,
            eventSubjects: wire.eventSubjects.mapValues(CrmSubject.init(wire:)),
            upcoming: wire.upcoming
        )
    }
}

extension CalendarAccount: Identifiable {
    /// The Worker's id for the owner's own account, wherever it is listed.
    static let primaryID = "primary-account"

    /// The owner's own account as the app lists it before the Worker has
    /// answered; the wire always carries `connectedAt`, a placeholder has none.
    init(id: String, email: String, primary: Bool, connected: Bool = true) {
        self.init(id: id, email: email, connectedAt: 0, primary: primary, connected: connected)
    }
}

extension CalendarSubscription: Identifiable {}

// `POST /api/calendar/subscriptions` is the generated
// `CalendarSubscriptionCreateRequest`; `PUT /api/calendar/preferences` is
// `CalendarPreferencesUpdate`, a partial write. Sending only the field that
// changed is what keeps the Settings calendar picker and the sidebar
// checkboxes from clobbering each other — an omitted field keeps whatever
// the server already holds. The lists go whole: read, change one entry,
// write back.

extension CrmSubject {
    /// The subject as a calendar preference names it.
    var calendarEventSubject: CalendarEventSubject {
        CalendarEventSubject(kind: CalendarEventSubjectKind(rawValue: kind), id: id, title: title)
    }
}

struct CalendarAttendeeSummary: Codable, Equatable, Sendable {
    let name: String
    let email: String
    let inCrm: Bool
    let crmUrl: String?
    let status: String
    let optional: Bool
    let isSelf: Bool

    enum CodingKeys: String, CodingKey {
        case name, email, inCrm, crmUrl, status, optional
        case isSelf = "self"
    }

    init(
        name: String,
        email: String = "",
        inCrm: Bool = false,
        crmUrl: String? = nil,
        status: String,
        optional: Bool,
        isSelf: Bool
    ) {
        self.name = name
        self.email = email
        self.inCrm = inCrm
        self.crmUrl = crmUrl
        self.status = status
        self.optional = optional
        self.isSelf = isSelf
    }

    init(wire: CalendarAttendeeWire) {
        self.init(
            name: wire.name,
            email: wire.email,
            inCrm: wire.inCrm ?? false,
            crmUrl: wire.crmURL,
            status: wire.status.rawValue,
            optional: wire.optional,
            isSelf: wire.isSelf
        )
    }

    /// The attendee as the wire carries it, for a body that round-trips one.
    var wire: CalendarAttendeeWire {
        CalendarAttendeeWire(
            name: name, email: email, inCrm: inCrm, crmURL: crmUrl,
            status: CalendarAttendeeStatus(rawValue: status), optional: optional, isSelf: isSelf
        )
    }

    /// Decoding stays for the snapshot the app writes for itself; the wire is
    /// `CalendarAttendeeWire`, read through `init(wire:)`.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        email = try container.decodeIfPresent(String.self, forKey: .email) ?? ""
        inCrm = try container.decodeIfPresent(Bool.self, forKey: .inCrm) ?? false
        crmUrl = try container.decodeIfPresent(String.self, forKey: .crmUrl)
        status = try container.decodeIfPresent(String.self, forKey: .status) ?? "unknown"
        optional = try container.decodeIfPresent(Bool.self, forKey: .optional) ?? false
        isSelf = try container.decodeIfPresent(Bool.self, forKey: .isSelf) ?? false
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(email, forKey: .email)
        try container.encode(inCrm, forKey: .inCrm)
        try container.encodeIfPresent(crmUrl, forKey: .crmUrl)
        try container.encode(status, forKey: .status)
        try container.encode(optional, forKey: .optional)
        try container.encode(isSelf, forKey: .isSelf)
    }

    /// SF Symbol for the attendee status mark in native lists.
    var statusSymbolName: String {
        switch status {
        case "accepted": return "checkmark"
        case "declined": return "xmark"
        case "tentative": return "questionmark"
        case "needsAction": return "circle"
        default: return "circle"
        }
    }

    var statusLabel: String {
        switch status {
        case "accepted": return "Accepted"
        case "declined": return "Declined"
        case "tentative": return "Tentative"
        case "needsAction": return "Pending"
        default: return "Unknown"
        }
    }

    /// True when any address on the row is on one of the active workspace's
    /// member domains. Checks `email` and `name` — Google often puts
    /// the address only in one of them, or embeds it as `Name <user@example.com>`.
    var isMember: Bool {
        Self.isMemberAddress(email) || Self.isMemberAddress(name)
    }

    /// Core is the canonical contact record. Only accept the URL shape Core
    /// publishes before handing it to a native browser opener; attendee data is
    /// server-provided and should not turn into an arbitrary external launch.
    var coreURL: URL? {
        guard let raw = crmUrl,
              let url = URL(string: raw),
              url.scheme?.lowercased() == "https",
              StarlingsWorkspace.active.services?.coreHolds(collection: "contacts") ?? true,
              let core = StarlingsWorkspace.active.coreOrigin,
              url.host?.lowercased() == core.host?.lowercased(),
              url.path.hasPrefix("/contacts/")
        else { return nil }
        return url
    }

    /// A calendar provider may put the address in either field. This is used
    /// by contact actions, while `listingDisplayName` remains the display-only
    /// answer for the row.
    var normalizedEmail: String? {
        Self.emailCandidates(in: email).first
            ?? Self.emailCandidates(in: name).first
    }

    static func isMemberAddress(_ value: String) -> Bool {
        emailCandidates(in: value).contains { candidate in
            guard let at = candidate.lastIndex(of: "@") else { return false }
            let domain = String(candidate[candidate.index(after: at)...])
            return EnvisioningIdentity.domains.contains(domain)
        }
    }

    /// Pulls bare addresses from plain, `mailto:`, and `Name <addr>` forms.
    static func emailCandidates(in value: String) -> [String] {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }

        var found: [String] = []
        var seen = Set<String>()
        func append(_ raw: String) {
            var candidate = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if candidate.lowercased().hasPrefix("mailto:") {
                candidate = String(candidate.dropFirst(7))
            }
            candidate = candidate.trimmingCharacters(in: CharacterSet(charactersIn: "<>"))
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            guard candidate.contains("@"), !candidate.hasPrefix("@"), !candidate.hasSuffix("@") else { return }
            guard !seen.contains(candidate) else { return }
            seen.insert(candidate)
            found.append(candidate)
        }

        append(trimmed)
        if let start = trimmed.firstIndex(of: "<"), let end = trimmed.firstIndex(of: ">"), start < end {
            append(String(trimmed[trimmed.index(after: start)..<end]))
        }
        // Last-resort scan for an addr token when the field is free-form text.
        let scalars = trimmed.unicodeScalars
        var token = ""
        for scalar in scalars {
            let ch = Character(scalar)
            if ch.isWhitespace || "<>\",;".contains(ch) {
                if !token.isEmpty { append(token); token = "" }
            } else {
                token.append(ch)
            }
        }
        if !token.isEmpty { append(token) }
        return found
    }

    /// Person-facing label: real name when we have one, never prefer a bare address.
    /// `contactNames` is `email.lowercased → display name` from Contacts (optional).
    func listingDisplayName(contactNames: [String: String] = [:]) -> String {
        if let angled = Self.angleBracketDisplayName(name) {
            return angled
        }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty, !Self.looksLikeEmailAddress(trimmed) {
            return trimmed
        }
        let address = (
            Self.emailCandidates(in: email).first
                ?? Self.emailCandidates(in: trimmed).first
                ?? ""
        )
        if let resolved = contactNames[address], !resolved.isEmpty {
            return resolved
        }
        // The CRM-backed calendar projection normally supplies a canonical
        // name. If that lookup is unavailable, show the address by itself.
        if isMember {
            return address
        }
        return trimmed.isEmpty ? address : trimmed
    }

    /// Plain-text listing line used by tooltips and accessibility projections.
    func listingLine(contactNames: [String: String] = [:]) -> String {
        let label = listingDisplayName(contactNames: contactNames)
        return [statusLabel, label, isMember ? String(localized: "Member") : nil]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    /// True when the whole string is a single email (possibly mailto: / angled).
    static func looksLikeEmailAddress(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        if let angled = angleBracketDisplayName(trimmed) {
            return angled.isEmpty
        }
        let candidates = emailCandidates(in: trimmed)
        guard let only = candidates.first else { return false }
        return only == trimmed.lowercased()
            || trimmed.lowercased() == "mailto:\(only)"
    }

    /// `Daiane Cavalheiro <daiane@…>` → `Daiane Cavalheiro`; nil when not that form.
    static func angleBracketDisplayName(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let start = trimmed.firstIndex(of: "<"),
              let end = trimmed.firstIndex(of: ">"),
              start < end,
              start > trimmed.startIndex
        else { return nil }
        let leading = trimmed[..<start].trimmingCharacters(in: .whitespacesAndNewlines)
        return leading.isEmpty ? nil : String(leading)
    }
}

/// Who else is on an event, folded to one mark for the card: that there are
/// other people, and whether they have all said yes. The owner is never
/// counted — the mark answers "who is coming", not "am I".
enum CalendarAttendance: Equatable, Sendable {
    /// Everyone still on the list has accepted.
    case confirmed
    /// Others are invited; at least one has not accepted yet.
    case pending
    /// Everyone else declined.
    case declined

    /// `nil` when the owner is alone on the event, so a solo block carries no
    /// mark. A guest who declined drops out of the confirmed check: two yeses
    /// and one no is a confirmed meeting.
    static func of(_ attendees: [CalendarAttendeeSummary]) -> CalendarAttendance? {
        let others = attendees.filter { !$0.isSelf }
        guard !others.isEmpty else { return nil }
        let coming = others.filter { $0.status != "declined" }
        if coming.isEmpty { return .declined }
        return coming.allSatisfy { $0.status == "accepted" } ? .confirmed : .pending
    }

    /// SF Symbol for the mark on the Mac and the phone. The web draws the
    /// same three shapes by hand in `action-icons.tsx`.
    var symbolName: String {
        switch self {
        case .confirmed: return "person.fill.checkmark"
        case .pending: return "person.fill.questionmark"
        case .declined: return "person.fill.xmark"
        }
    }

    var label: String {
        switch self {
        case .confirmed: return "Guests confirmed"
        case .pending: return "Guests pending"
        case .declined: return "Guests declined"
        }
    }
}

extension Array where Element == CalendarAttendeeSummary {
    /// Guests for calendar UI: hide self, external addresses first (stable within each group).
    var forCalendarListing: [CalendarAttendeeSummary] {
        let visible = filter { !$0.isSelf }
        let external = visible.filter { !$0.isMember }
        let envisioning = visible.filter(\.isMember)
        return external + envisioning
    }

    func calendarListingLabel(contactNames: [String: String] = [:]) -> String {
        let listed = forCalendarListing
        guard !listed.isEmpty else { return "" }
        return listed.prefix(20).map { $0.listingLine(contactNames: contactNames) }.joined(separator: "\n")
    }

    func calendarListingTooltip(contactNames: [String: String] = [:]) -> String {
        forCalendarListing.map {
            "\($0.listingDisplayName(contactNames: contactNames)) — \($0.statusLabel)"
        }.joined(separator: "\n")
    }
}

extension CalendarMeetingPlatform {
    var displayName: String {
        switch self {
        case .starlings: return "Starlings"
        case .googleMeet: return "Google Meet"
        case .zoom: return "Zoom"
        case .teams: return "Teams"
        case .webex: return "Webex"
        case .other: return "Link"
        default: return "Calendar"
        }
    }

    var actionTitle: String {
        switch self {
        case .starlings: return "Join"
        case .googleMeet: return "Open Google Meet"
        case .zoom: return "Open Zoom"
        case .teams: return "Open Teams"
        case .webex: return "Open Webex"
        case .other: return "Open link"
        default: return "Open"
        }
    }

    var symbolName: String {
        switch self {
        case .starlings: return "video.fill"
        case .googleMeet: return "video.badge.waveform"
        case .zoom: return "video"
        case .teams: return "person.3"
        case .webex: return "phone.connection"
        case .other: return "link"
        default: return "calendar"
        }
    }

    /// EventKit and subscribed feeds do not carry the Worker-normalized
    /// platform field. Infer their provider from the actual destination (or a
    /// clear provider label) so a local Zoom event cannot look like our room.
    static func inferred(joinURL: String, location: String, roomSlug: String) -> Self {
        if !roomSlug.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .starlings
        }

        let haystack = [joinURL, location]
            .joined(separator: "\n")
            .lowercased()
        // Our room only on the active workspace's own hosts, never another
        // workspace's.
        let workspace = StarlingsWorkspace.active
        let ownHosts = [workspace.publicOrigin, workspace.webOrigin]
            .compactMap { URL(string: $0)?.host?.lowercased() }
        if ownHosts.contains(where: { haystack.contains("\($0)/room/") }) {
            return .starlings
        }
        if haystack.contains("meet.google.com") || haystack.contains("hangouts.google.com") {
            return .googleMeet
        }
        if haystack.contains("zoom.us") || haystack.contains("zoom.com") {
            return .zoom
        }
        if haystack.contains("teams.microsoft.com") || haystack.contains("teams.live.com") {
            return .teams
        }
        if haystack.contains("webex.com") {
            return .webex
        }

        let label = location
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        if label.range(of: #"^(?:microsoft\s+teams|teams)(?:\s+meeting)?$"#, options: .regularExpression) != nil {
            return .teams
        }
        if label.range(of: #"^(?:google\s+meet)(?:\s+meeting)?$"#, options: .regularExpression) != nil {
            return .googleMeet
        }
        if label.range(of: #"^(?:zoom)(?:\s+meeting)?$"#, options: .regularExpression) != nil {
            return .zoom
        }
        if label.range(of: #"^(?:webex)(?:\s+meeting)?$"#, options: .regularExpression) != nil {
            return .webex
        }

        let hasHTTPURL = haystack.range(of: #"https?://"#, options: .regularExpression) != nil
        return hasHTTPURL ? .other : .none
    }
}

/// A calendar row as every surface draws it. Built from the wire
/// (`init(wire:)`, the generated `CalendarEventWire`) or from EventKit
/// (`init(eventKit:)`); `subject` is a `CrmSubject` because the device fills
/// it in for EventKit rows from the same owner-wide map.
struct CalendarEventSummary: Equatable, Identifiable, Sendable {
    let id: String
    let calendarId: String
    let calendarSummary: String
    let htmlLink: String
    let title: String
    let start: String
    let end: String
    let joinUrl: String
    let roomSlug: String
    let isMeetEvent: Bool
    let attendees: [CalendarAttendeeSummary]
    let organizerSelf: Bool
    let platform: CalendarMeetingPlatform
    let conferenceUrl: String
    let isAllDay: Bool
    /// Series id when this row is one instance of a recurring event.
    let recurringEventId: String
    let isRecurring: Bool
    let notes: String
    let location: String
    /// IANA zone the event's start was made in, when the source says.
    let startTimeZone: String?
    /// Explicit travel duration from calendar metadata, in whole minutes.
    let travelTimeMinutes: Int?
    let demoted: Bool
    let calendarRole: CalendarSemanticRole
    /// The project or lead this event is about. A room started from the event
    /// is filed under it. Google events carry it from the Worker; EventKit
    /// ones are matched on the device from the same owner-wide map.
    var subject: CrmSubject?

    var hasMeetRoom: Bool {
        platform == .starlings || isMeetEvent || (!joinUrl.isEmpty && !roomSlug.isEmpty)
    }

    /// The connected account's own reply, when it is on the guest list.
    var myResponse: CalendarRSVP? {
        guard let mine = attendees.first(where: \.isSelf) else { return nil }
        return CalendarRSVP(rawValue: mine.status)
    }

    /// The Worker prefixes the Google event id with the calendar ref so the
    /// same event from two accounts cannot collide. Keep the reverse operation
    /// here for actions originating from a summary, such as an invitation card.
    var rawEventID: String {
        let prefix = calendarId + ":"
        return id.hasPrefix(prefix) ? String(id.dropFirst(prefix.count)) : id
    }

    /// Who’s coming with RSVP marks (up to 20 names), one person per line.
    /// Hides self, external guests first, then Envisioning-domain names.
    func attendeesLabel(contactNames: [String: String] = [:]) -> String {
        attendees.calendarListingLabel(contactNames: contactNames)
    }

    func attendeesTooltip(contactNames: [String: String] = [:]) -> String {
        attendees.calendarListingTooltip(contactNames: contactNames)
    }

    var launchURL: String {
        if !conferenceUrl.isEmpty { return conferenceUrl }
        if !joinUrl.isEmpty { return joinUrl }
        return ""
    }

    /// Calendar's event page and a location's map URL are not meeting links.
    /// Only a platform plus an explicit conference/room URL can make a row
    /// actionable as video on any native surface.
    var isVideoMeeting: Bool { platform != .none && !launchURL.isEmpty }

    init(
        id: String,
        calendarId: String,
        calendarSummary: String,
        htmlLink: String,
        title: String,
        start: String,
        end: String,
        joinUrl: String,
        roomSlug: String,
        isMeetEvent: Bool,
        attendees: [CalendarAttendeeSummary],
        organizerSelf: Bool,
        platform: CalendarMeetingPlatform,
        conferenceUrl: String,
        isAllDay: Bool,
        recurringEventId: String = "",
        isRecurring: Bool = false,
        notes: String = "",
        location: String = "",
        startTimeZone: String? = nil,
        travelTimeMinutes: Int? = nil,
        demoted: Bool = false,
        calendarRole: CalendarSemanticRole = .ordinary,
        subject: CrmSubject? = nil
    ) {
        self.subject = subject
        self.id = id
        self.calendarId = calendarId
        self.calendarSummary = calendarSummary
        self.htmlLink = htmlLink
        self.title = title
        self.start = start
        self.end = end
        self.joinUrl = joinUrl
        self.roomSlug = roomSlug
        self.isMeetEvent = isMeetEvent
        self.attendees = attendees
        self.organizerSelf = organizerSelf
        self.platform = platform
        self.conferenceUrl = conferenceUrl
        self.isAllDay = isAllDay
        self.recurringEventId = recurringEventId
        self.isRecurring = isRecurring
        self.notes = notes
        self.location = location
        self.startTimeZone = startTimeZone
        self.travelTimeMinutes = CalendarTravelTime.validMinutes(travelTimeMinutes)
        self.demoted = demoted
        self.calendarRole = calendarRole
    }

    func withDemoted(_ value: Bool) -> CalendarEventSummary {
        CalendarEventSummary(
            id: id,
            calendarId: calendarId,
            calendarSummary: calendarSummary,
            htmlLink: htmlLink,
            title: title,
            start: start,
            end: end,
            joinUrl: joinUrl,
            roomSlug: roomSlug,
            isMeetEvent: isMeetEvent,
            attendees: attendees,
            organizerSelf: organizerSelf,
            platform: platform,
            conferenceUrl: conferenceUrl,
            isAllDay: isAllDay,
            recurringEventId: recurringEventId,
            isRecurring: isRecurring,
            notes: notes,
            location: location,
            startTimeZone: startTimeZone,
            travelTimeMinutes: travelTimeMinutes,
            demoted: value,
            calendarRole: calendarRole,
            subject: subject
        )
    }

    /// The row as the wire carries it: what a client writes to its own disk
    /// (the phone's upcoming cache) and the inverse of `init(wire:)`. A
    /// subject built on the device keeps only what the wire holds.
    var wire: CalendarEventWire {
        CalendarEventWire(
            id: id,
            calendarID: calendarId,
            calendarSummary: calendarSummary,
            htmlLink: htmlLink,
            title: title,
            start: start,
            end: end,
            joinURL: joinUrl,
            roomSlug: roomSlug,
            isMeetEvent: isMeetEvent,
            attendees: attendees.map(\.wire),
            organizerSelf: organizerSelf,
            platform: platform,
            conferenceURL: conferenceUrl,
            allDay: isAllDay,
            recurringEventID: recurringEventId,
            recurring: isRecurring,
            description: notes,
            location: location,
            startTimeZone: startTimeZone,
            travelTimeMinutes: travelTimeMinutes,
            demoted: demoted,
            calendarRole: calendarRole,
            subject: subject.map { CalendarEventSubject(kind: CalendarEventSubjectKind(rawValue: $0.kind), id: $0.id, title: $0.title) }
        )
    }

    init(wire: CalendarEventWire) {
        self.init(
            id: wire.id,
            calendarId: wire.calendarID,
            calendarSummary: wire.calendarSummary,
            htmlLink: wire.htmlLink,
            title: wire.title,
            start: wire.start,
            end: wire.end,
            joinUrl: wire.joinURL,
            roomSlug: wire.roomSlug,
            isMeetEvent: wire.isMeetEvent,
            attendees: wire.attendees.map(CalendarAttendeeSummary.init(wire:)),
            organizerSelf: wire.organizerSelf,
            platform: wire.platform,
            conferenceUrl: wire.conferenceURL,
            isAllDay: wire.allDay,
            recurringEventId: wire.recurringEventID,
            isRecurring: wire.recurring,
            notes: wire.description,
            location: wire.location,
            startTimeZone: wire.startTimeZone,
            travelTimeMinutes: wire.travelTimeMinutes,
            demoted: wire.demoted,
            calendarRole: wire.calendarRole,
            subject: wire.subject.map(CrmSubject.init(wire:))
        )
    }
}

extension CalendarEventSummary {
    init(eventKit event: StarlingsCalendarEvent) {
        let hasMeet = !event.joinURL.isEmpty
        self.init(
            id: event.id,
            calendarId: event.calendarID,
            calendarSummary: "",
            htmlLink: "",
            title: event.displayTitle,
            start: ISODate.format(event.start),
            end: ISODate.format(event.end),
            joinUrl: event.joinURL,
            roomSlug: event.roomSlug,
            isMeetEvent: hasMeet && !event.roomSlug.isEmpty,
            attendees: [],
            organizerSelf: true,
            platform: hasMeet ? .starlings : .none,
            conferenceUrl: event.joinURL,
            isAllDay: event.isAllDay,
            recurringEventId: event.recurringEventID,
            isRecurring: event.isRecurring,
            notes: event.notes,
            location: event.location,
            startTimeZone: event.startTimeZone,
            travelTimeMinutes: event.travelTimeMinutes,
            demoted: event.isDemoted,
            calendarRole: event.calendarRole,
            subject: event.subject
        )
    }
}

/// Stable identities for favorite targets shared across native surfaces.
/// EventKit rows deliberately return nil: only the Worker-backed Google id
/// and immutable recurrence key resolve on other devices.
enum FavoriteTargets {
    static func crmSubject(kind: String, id: String) -> FavoriteTarget? {
        let targetKind: FavoriteTargetKind
        switch kind {
        case "lead": targetKind = .crmLead
        case "project": targetKind = .crmProject
        case "organization": targetKind = .crmPartner
        case "event": targetKind = .cmsEvent
        default: return nil
        }
        return FavoriteTarget(kind: targetKind, targetRef: id)
    }

    static func peer(_ peer: Peer) -> FavoriteTarget? {
        guard let reference = peer.favoriteRef else { return nil }
        return FavoriteTarget(kind: peer.kind == .agent ? .meetAgent : .meetPerson, targetRef: reference)
    }

    /// Kinds whose ref is a UUID. The Worker stores these lowercased
    /// (`favoriteTargetSchema` in packages/contracts/src/favorites.ts).
    private static let uuidKinds: Set<String> = [
        "crm.lead", "crm.project", "crm.partner", "cms.event", "crm.task",
        "docs.document", "docs.folder", "meet.thread",
    ]

    /// Whether a stored favorite is this target, in the Worker's spelling:
    /// a row starred with an uppercase id must still read as starred.
    static func matches(_ row: FavoriteRow, _ target: FavoriteTarget) -> Bool {
        guard row.kind == target.kind.rawValue else { return false }
        return uuidKinds.contains(row.kind)
            ? row.targetRef.lowercased() == target.targetRef.lowercased()
            : row.targetRef == target.targetRef
    }
}

enum CalendarTravelTime {
    static func validMinutes(_ minutes: Int?) -> Int? {
        guard let minutes, (1...(24 * 60)).contains(minutes) else { return nil }
        return minutes
    }

    static func label(minutes: Int?) -> String? {
        guard let minutes = validMinutes(minutes) else { return nil }
        return String(localized: "Travel \(minutes) min")
    }
}

extension CalendarEventResponse {
    var summary: CalendarEventSummary { CalendarEventSummary(wire: event) }
}

extension CalendarEventsResponse {
    var summaries: [CalendarEventSummary] { events.map(CalendarEventSummary.init(wire:)) }
}


/// An event proposed from a mail forwarded to `calendar@`, waiting
/// on Home for Add or Discard. `start`/`end` are days when `allDay`, instants
/// with an offset otherwise, as the create body spells them. Nothing of the
/// mail itself is here except its subject line and sender.
/// A row proposed from mail forwarded to calendar@: the generated
/// `PendingCalendarEvent`, drawn on Home until it is added or discarded.
typealias ProposedCalendarEvent = PendingCalendarEvent

extension PendingCalendarEvent: Identifiable {
    var startDate: Date? { CalendarDateParsing.parse(start) }

    /// Home's second line: "Oct 3 · 07:10 · From email"; an all-day row has no time.
    var scheduleLine: String {
        var parts: [String] = []
        if let startDate {
            parts.append(startDate.formatted(.dateTime.month(.abbreviated).day()))
            if !allDay { parts.append(StarlingsDateFormatting.time(startDate)) }
        }
        parts.append(String(localized: "From email"))
        return parts.joined(separator: " · ")
    }
}


// Request bodies are the generated shapes. What the Mac and the iOS client
// share is how a Date becomes the wire's instant, so the two cannot drift.

extension CalendarFreeBusyRequest {
    init(timeMin: Date, timeMax: Date, emails: [String]) {
        self.init(timeMin: ISODate.format(timeMin), timeMax: ISODate.format(timeMax), emails: emails)
    }
}

extension CalendarEventCreateRequest {
    /// `travelTimeMinutes`: minutes to get there; nil sends nothing.
    init(
        title: String,
        start: Date,
        end: Date,
        joinURL: String?,
        roomSlug: String?,
        attendees: [String],
        description: String?,
        location: String?,
        timeZone: String?,
        calendarID: String?,
        travelTimeMinutes: Int? = nil
    ) {
        self.init(
            title: title,
            start: ISODate.format(start),
            end: ISODate.format(end),
            joinURL: joinURL,
            roomSlug: roomSlug,
            calendarID: calendarID,
            attendees: attendees,
            description: description,
            location: location,
            timeZone: timeZone,
            travelTimeMinutes: .ifSome(travelTimeMinutes)
        )
    }
}

extension CalendarEventPatchRequest {
    /// `attendees` nil leaves the guest list alone. `travelTimeMinutes`: nil
    /// leaves it alone; 0 clears it; a number sets it.
    init(
        calendarID: String,
        eventID: String,
        title: String,
        start: Date,
        end: Date,
        attendees: [String]?,
        timeZone: String?,
        joinURL: String?,
        roomSlug: String?,
        notes: String?,
        location: String?,
        travelTimeMinutes: Int? = nil
    ) {
        self.init(
            calendarID: calendarID,
            eventID: eventID,
            title: title,
            start: ISODate.format(start),
            end: ISODate.format(end),
            attendees: attendees,
            description: notes,
            location: location,
            timeZone: timeZone,
            joinURL: joinURL,
            roomSlug: roomSlug,
            travelTimeMinutes: .ifSome(travelTimeMinutes)
        )
    }
}

extension CalendarEventRespondRequest {
    /// `needsAction` is a state, not an answer; it is never sent.
    init?(calendarID: String, eventID: String, response: CalendarRSVP) {
        guard let reply = CalendarEventReply(rawValue: response.rawValue) else { return nil }
        self.init(calendarID: calendarID, eventID: eventID, response: reply)
    }
}

extension CalendarBookingMintRequest {
    init(title: String, start: Date, end: Date, roomSlug: String, joinURL: String?) {
        self.init(title: title, start: ISODate.format(start), end: ISODate.format(end), roomSlug: roomSlug, joinURL: joinURL)
    }
}

/// A dated task or milestone from Core, via `GET /api/calendar/work-items`.
///
// `CrmWorkItem`, `CalendarWorkItemsResponse`, `CalendarBusyInterval`,
// `CalendarFreeBusyPerson`, `CalendarFreeBusyResponse`,
// `CalendarAvailabilityBlock` and `CalendarAvailabilityResponse` are
// generated. What the calendar reads off them:

/// A task or milestone with a date, drawn beside the events. `dueAt` is a
/// timestamp for a task and a plain date for a milestone; `mine` is set by
/// the Worker, which knows who is asking.
typealias CalendarWorkItem = CrmWorkItem

extension CalendarFreeBusyPerson {
    var isReadable: Bool { error.isEmpty }
}

extension CalendarWorkItemsResponse {
    /// Core unreachable answers an empty list and says so; the calendar keeps its events either way.
    var isDegraded: Bool { degraded ?? false }
}

extension CalendarAvailabilityResponse {
    var isDegraded: Bool { degraded ?? false }
}

/// The control plane's row, on both platforms. An all-day block whose end did
/// not parse is over when its day is, not the instant it began — that inference
/// belongs here rather than in the shared rule.
extension CalendarEventSummary: UpcomingEvent {
    var upcomingID: String { id }
    var upcomingCalendarID: String? { calendarId }
    var upcomingTitle: String { title }
    var upcomingStart: Date? { CalendarDateParsing.parse(start) }

    var upcomingEnd: Date? {
        if let end = CalendarDateParsing.parse(end) { return end }
        guard isAllDay, let start = upcomingStart else { return nil }
        let calendar = Calendar.current
        return calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: start))
    }

    var upcomingIsAllDay: Bool { isAllDay }
    var upcomingIsDemoted: Bool { demoted }
    var upcomingAttendees: [UpcomingAttendee]? {
        attendees.map { UpcomingAttendee(status: $0.status, isSelf: $0.isSelf) }
    }
}
