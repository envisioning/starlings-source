import Foundation

/// Today's meetings about a subject, for Work's Overview: the
/// calendar events on today's civil day that are filed to a project or a
/// lead, in start order. All-day rows are not meetings; an event with no
/// subject belongs to Home, not here. One rule for the Mac and the phone;
/// the web's `todayMeetings` in crm-work.ts is the same rule.
enum WorkTodayMeetings {
    struct Row: Equatable, Identifiable, Sendable {
        let id: String
        let title: String
        let start: Date
        let subject: CrmSubject

        /// "10:00 · Acme rollout" — the time, then the subject the row opens.
        var detail: String {
            "\(StarlingsDateFormatting.time(start)) · \(subject.displayTitle)"
        }
    }

    static func rows<Event>(
        _ events: [Event],
        now: Date = Date(),
        calendar: Calendar = .current,
        id: (Event) -> String,
        title: (Event) -> String,
        start: (Event) -> Date?,
        isAllDay: (Event) -> Bool,
        subject: (Event) -> CrmSubject?
    ) -> [Row] {
        var seen: Set<String> = []
        return events.compactMap { event -> Row? in
            guard !isAllDay(event), let subject = subject(event), let start = start(event) else { return nil }
            guard calendar.isDate(start, inSameDayAs: now) else { return nil }
            let key = id(event)
            guard seen.insert(key).inserted else { return nil }
            let title = title(event).trimmingCharacters(in: .whitespacesAndNewlines)
            return Row(id: key, title: title.isEmpty ? String(localized: "Meeting") : title, start: start, subject: subject)
        }
        .sorted { $0.start < $1.start }
    }
}
