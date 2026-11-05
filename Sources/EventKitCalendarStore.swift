import EventKit
import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Local + iCloud calendars via EventKit. Google stays on the OAuth proxy so a
/// Calendar.app Google account is not listed twice.
@MainActor
final class EventKitCalendarStore {
    /// EventKit is the same framework on both platforms; only the noun differs.
    /// `UIDevice.model` is "iPhone" or "iPad" — exactly what the system Calendar
    /// app calls that group.
    #if os(macOS)
    /// Same rule as `subscriptionGroupTitle`: persisted with the cache.
    static let localGroupTitle = String(localized: "On My Mac")
    #else
    static var localGroupTitle: String { "On My \(UIDevice.current.model)" }
    #endif

    enum Access: Equatable, Sendable {
        case unknown
        case granted
        case denied
    }

    private let store = EKEventStore()
    private(set) var access: Access = .unknown

    nonisolated static func includeSource(type: EKSourceType, title: String, identifier: String) -> Bool {
        switch type {
        case .local:
            return true
        case .calDAV:
            let haystack = "\(title) \(identifier)".lowercased()
            if haystack.contains("google") || haystack.contains("gmail") { return false }
            return true
        case .subscribed:
            // Meet's own subscription shelf fetches feeds through the control
            // plane, and the owner's booking hours arrive from Core as the
            // Availability layer — a Calendar.app subscription adds nothing.
            return false
        default:
            return false
        }
    }

    /// The answer already on file, without the async request that could put a
    /// permission dialog in front of a first paint. Says nothing when access
    /// has never been decided — that question belongs to `refreshAccess`.
    @discardableResult
    func adoptExistingAccess() -> Access {
        if EKEventStore.authorizationStatus(for: .event) == .fullAccess { access = .granted }
        return access
    }

    func refreshAccess(requestIfNeeded: Bool = true) async -> Access {
        let status = EKEventStore.authorizationStatus(for: .event)
        switch status {
        case .fullAccess:
            access = .granted
        case .notDetermined:
            guard requestIfNeeded else {
                access = .unknown
                return access
            }
            do {
                let granted = try await store.requestFullAccessToEvents()
                access = granted ? .granted : .denied
            } catch {
                access = .denied
            }
        default:
            access = .denied
        }
        return access
    }

    func calendars() -> [StarlingsCalendar] {
        guard access == .granted else { return [] }
        let ekCalendars = store.calendars(for: .event).filter { calendar in
            Self.includeSource(
                type: calendar.source.sourceType,
                title: "\(calendar.source.title) \(calendar.title)",
                identifier: calendar.source.sourceIdentifier
            )
        }
        return ekCalendars.enumerated().map { index, calendar in
            let color = StarlingsRGBColor(cgColor: calendar.cgColor) ?? StarlingsRGBColor.fallback(at: index + 3)
            // Use the account's own name. Calling every CalDAV source "iCloud"
            // collapses separate accounts into one indistinguishable group.
            let sourceTitle = calendar.source.title.trimmingCharacters(in: .whitespacesAndNewlines)
            let group: String = {
                if calendar.source.sourceType == .local { return Self.localGroupTitle }
                return sourceTitle.isEmpty ? "iCloud" : sourceTitle
            }()
            return StarlingsCalendar(
                id: StarlingsCalendar.eventKitID(calendar.calendarIdentifier),
                source: .eventKit,
                rawID: calendar.calendarIdentifier,
                title: calendar.title,
                groupTitle: group,
                isWritable: calendar.allowsContentModifications,
                color: color
            )
        }
        .sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    }

    func events(from start: Date, to end: Date, calendars: [StarlingsCalendar]) -> [StarlingsCalendarEvent] {
        guard access == .granted else { return [] }
        let lookup = Dictionary(uniqueKeysWithValues: calendars.map { ($0.rawID, $0) })
        let ekCalendars = store.calendars(for: .event).filter { lookup[$0.calendarIdentifier] != nil }
        guard !ekCalendars.isEmpty else { return [] }
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: ekCalendars)
        return store.events(matching: predicate).compactMap { event -> StarlingsCalendarEvent? in
            guard let calendar = event.calendar,
                  let meta = lookup[calendar.calendarIdentifier],
                  let identifier = event.eventIdentifier
            else { return nil }
            let startDate = event.startDate ?? start
            let endDate = event.endDate ?? startDate.addingTimeInterval(3_600)
            let occurrenceKey = Int(startDate.timeIntervalSince1970)
            let storedLocation = event.location?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let notes = event.notes ?? ""
            // The location slot doubles as the link's home (Calendar.app
            // shows Join from it), and `url` is the iCalendar slot. A link is
            // not a place, so the event keeps the two apart.
            let joinURL = storedLocation.hasPrefix("http")
                ? storedLocation
                : (event.url.flatMap { MeetingInvite.roomSlug(fromJoinURL: $0.absoluteString) } != nil
                    ? event.url?.absoluteString ?? ""
                    : "")
            let location = storedLocation == joinURL ? "" : storedLocation
            return StarlingsCalendarEvent(
                id: "ek:\(identifier):\(occurrenceKey)",
                calendarID: meta.id,
                rawEventID: identifier,
                title: event.title ?? "",
                start: startDate,
                end: max(endDate, startDate.addingTimeInterval(60)),
                isAllDay: event.isAllDay,
                isWritable: meta.isWritable,
                isRecurring: event.hasRecurrenceRules,
                joinURL: joinURL,
                roomSlug: MeetingInvite.roomSlug(fromJoinURL: joinURL) ?? "",
                attendeeEmails: Self.attendeeEmails(of: event),
                attendees: Self.attendees(of: event),
                source: .eventKit,
                notes: notes,
                location: location,
                startTimeZone: event.timeZone?.identifier,
                myResponse: Self.myResponse(of: event)
            )
        }
    }

    /// Fires whenever another process (Calendar.app, iCloud sync, an iPhone)
    /// changes the local store, so a stale week can refresh itself.
    static var externalChanges: NotificationCenter.Notifications {
        NotificationCenter.default.notifications(named: .EKEventStoreChanged)
    }

    func create(
        title: String,
        start: Date,
        end: Date,
        calendarRawID: String,
        location: String?,
        url: URL? = nil,
        notes: String? = nil
    ) throws -> String {
        guard let calendar = store.calendar(withIdentifier: calendarRawID) else {
            throw EventKitCalendarError.missingCalendar
        }
        let event = EKEvent(eventStore: store)
        event.calendar = calendar
        event.title = title
        event.startDate = start
        event.endDate = end
        event.location = location
        event.url = url
        event.notes = notes
        try store.save(event, span: .thisEvent, commit: true)
        return event.eventIdentifier ?? ""
    }

    func update(
        eventIdentifier: String,
        occurrenceStart: Date,
        title: String,
        start: Date,
        end: Date,
        location: String?,
        url: URL? = nil,
        notes: String? = nil,
        span: CalendarEditSpan = .thisEvent
    ) throws {
        guard let event = event(matching: eventIdentifier, occurrenceStart: occurrenceStart) else {
            throw EventKitCalendarError.missingEvent
        }
        event.title = title
        event.startDate = start
        event.endDate = end
        // `nil` means "caller had nothing to say about this field" — leave the
        // stored value alone rather than blanking it on a reschedule.
        if let location { event.location = location }
        if let url { event.url = url }
        if let notes { event.notes = notes }
        try store.save(event, span: span.eventKit, commit: true)
    }

    /// The owner's stored reply. Readable here, but EventKit has no public API
    /// to change it, so this is shown and not offered as an action.
    private static func myResponse(of event: EKEvent) -> CalendarRSVP? {
        guard let me = event.attendees?.first(where: \.isCurrentUser) else { return nil }
        switch me.participantStatus {
        case .accepted: return .accepted
        case .declined: return .declined
        case .tentative: return .tentative
        case .pending: return .needsAction
        default: return nil
        }
    }

    /// The guest list with each reply, so a local event carries the same
    /// guest mark a Google one does. Rooms and resources are left out; the
    /// mark is about people.
    private static func attendees(of event: EKEvent) -> [CalendarAttendeeSummary] {
        guard let participants = event.attendees else { return [] }
        return participants.compactMap { participant in
            guard participant.participantType == .person || participant.participantType == .unknown
            else { return nil }
            let email = participant.url.scheme?.lowercased() == "mailto"
                ? String(participant.url.absoluteString.dropFirst("mailto:".count)).lowercased()
                : ""
            let status: String
            switch participant.participantStatus {
            case .accepted: status = "accepted"
            case .declined: status = "declined"
            case .tentative: status = "tentative"
            case .pending: status = "needsAction"
            default: status = "unknown"
            }
            return CalendarAttendeeSummary(
                name: participant.name ?? email,
                email: email,
                status: status,
                optional: participant.participantRole == .optional,
                isSelf: participant.isCurrentUser
            )
        }
    }

    /// Guest addresses, lower-cased. EventKit exposes them as `mailto:` URLs.
    private static func attendeeEmails(of event: EKEvent) -> [String] {
        guard let attendees = event.attendees else { return [] }
        var seen = Set<String>()
        return attendees.compactMap { participant -> String? in
            let url = participant.url
            guard url.scheme?.lowercased() == "mailto" else { return nil }
            let address = url.absoluteString
                .dropFirst("mailto:".count)
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            guard address.contains("@"), seen.insert(address).inserted else { return nil }
            return address
        }
    }

    /// Re-file an event on another local calendar. EventKit moves a whole
    /// series, so this always applies to every occurrence.
    func move(eventIdentifier: String, occurrenceStart: Date, toCalendarRawID: String) throws {
        guard let target = store.calendar(withIdentifier: toCalendarRawID) else {
            throw EventKitCalendarError.missingCalendar
        }
        guard let event = event(matching: eventIdentifier, occurrenceStart: occurrenceStart) else {
            throw EventKitCalendarError.missingEvent
        }
        event.calendar = target
        try store.save(event, span: .futureEvents, commit: true)
    }

    func delete(eventIdentifier: String, occurrenceStart: Date, span: CalendarEditSpan = .thisEvent) throws {
        guard let event = event(matching: eventIdentifier, occurrenceStart: occurrenceStart) else {
            throw EventKitCalendarError.missingEvent
        }
        try store.remove(event, span: span.eventKit, commit: true)
    }

    private func event(matching identifier: String, occurrenceStart: Date) -> EKEvent? {
        if let exact = store.event(withIdentifier: identifier),
           abs(exact.startDate.timeIntervalSince(occurrenceStart)) < 1 {
            return exact
        }
        let windowStart = occurrenceStart.addingTimeInterval(-3_600)
        let windowEnd = occurrenceStart.addingTimeInterval(3_600)
        let predicate = store.predicateForEvents(withStart: windowStart, end: windowEnd, calendars: nil)
        return store.events(matching: predicate).first { event in
            event.eventIdentifier == identifier
                && abs((event.startDate ?? .distantPast).timeIntervalSince(occurrenceStart)) < 120
        }
    }
}

/// File-scope so the error type, which is not main-actor bound, can read it.
#if os(macOS)
private let eventKitDeviceNoun = "Mac"
#else
private let eventKitDeviceNoun = "device"
#endif

enum EventKitCalendarError: LocalizedError {
    case missingCalendar
    case missingEvent

    var errorDescription: String? {
        switch self {
        case .missingCalendar:
            return String(localized: "That iCloud calendar isn’t available on this \(eventKitDeviceNoun).")
        case .missingEvent: return "That event couldn’t be found in Calendar."
        }
    }
}

private extension CalendarEditSpan {
    var eventKit: EKSpan {
        switch self {
        case .thisEvent: return .thisEvent
        case .futureEvents: return .futureEvents
        }
    }
}

private extension StarlingsRGBColor {
    init?(cgColor: CGColor) {
        guard let srgb = cgColor.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil),
              let components = srgb.components,
              components.count >= 3
        else { return nil }
        self.init(red: Double(components[0]), green: Double(components[1]), blue: Double(components[2]))
    }
}
