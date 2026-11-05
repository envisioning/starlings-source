import AppKit

/// One event on the pasteboard.
///
/// It carries what a copy can honestly recreate — the title, the length, the
/// time of day, the guests, the notes, the link — and not the identity of the
/// original. A paste always makes a new event; it never re-files the one that
/// was copied, so ⌘C ⌘V cannot move or destroy anything.
struct CalendarEventPasteboardItem: Codable, Sendable {
    static let type = NSPasteboard.PasteboardType("\(ContractConstants.nativeAppBundleID).calendar-event")

    var title: String
    /// Hour and minute the copy came from, so a paste lands at the same time on
    /// whichever day the window points at. Stored as clock time rather than as
    /// an absolute date: across a DST boundary the hour is what a reader means.
    var hour: Int
    var minute: Int
    var duration: TimeInterval
    var isAllDay: Bool
    /// The calendar the copy came from. A paste prefers it, and falls back to
    /// the default write calendar when it is gone or read-only.
    var calendarID: String
    var joinURL: String
    var roomSlug: String
    var attendeeEmails: [String]
    var notes: String
    var location: String

    init(_ event: StarlingsCalendarEvent, calendar: Calendar = .current) {
        let parts = calendar.dateComponents([.hour, .minute], from: event.start)
        title = event.displayTitle
        hour = parts.hour ?? 0
        minute = parts.minute ?? 0
        duration = max(event.end.timeIntervalSince(event.start), 60)
        isAllDay = event.isAllDay
        calendarID = event.calendarID
        joinURL = event.joinURL
        roomSlug = event.roomSlug
        attendeeEmails = event.attendeeEmails
        notes = event.notes
        location = event.location
    }

    /// The slot this copy takes on a given day.
    func slot(on day: Date, calendar: Calendar = .current) -> (start: Date, end: Date) {
        let start = calendar.date(
            bySettingHour: hour,
            minute: minute,
            second: 0,
            of: calendar.startOfDay(for: day)
        ) ?? calendar.startOfDay(for: day)
        return (start, start.addingTimeInterval(duration))
    }
}

extension CalendarEventPasteboardItem {
    /// Write the event twice: once as Meet's own type, once as plain text so a
    /// copy is still worth something in a mail draft or a note.
    static func write(_ event: StarlingsCalendarEvent, to pasteboard: NSPasteboard = .general) {
        let item = CalendarEventPasteboardItem(event)
        pasteboard.clearContents()
        if let data = try? JSONEncoder().encode(item) {
            pasteboard.setData(data, forType: Self.type)
        }
        pasteboard.setString(Self.plainText(for: event), forType: .string)
    }

    static func read(from pasteboard: NSPasteboard = .general) -> CalendarEventPasteboardItem? {
        guard let data = pasteboard.data(forType: Self.type) else { return nil }
        return try? JSONDecoder().decode(CalendarEventPasteboardItem.self, from: data)
    }

    static func canRead(_ pasteboard: NSPasteboard = .general) -> Bool {
        pasteboard.types?.contains(Self.type) ?? false
    }

    private static func plainText(for event: StarlingsCalendarEvent) -> String {
        let formatter = DateFormatter()
        formatter.locale = .current
        var lines = [event.displayTitle]
        if event.isAllDay {
            formatter.setLocalizedDateFormatFromTemplate("EEE d MMM yyyy")
            lines.append(formatter.string(from: event.start))
        } else {
            formatter.setLocalizedDateFormatFromTemplate("EEE d MMM yyyy")
            let day = "\(formatter.string(from: event.start)) \(StarlingsDateFormatting.time(event.start))"
            lines.append("\(day) – \(StarlingsDateFormatting.time(event.end))")
        }
        if !event.location.isEmpty { lines.append(event.location) }
        if !event.joinURL.isEmpty { lines.append(event.joinURL) }
        return lines.joined(separator: "\n")
    }
}
