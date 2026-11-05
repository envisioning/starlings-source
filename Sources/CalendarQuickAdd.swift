import Foundation

/// Calendar quick add: one typed sentence becomes an event draft.
///
/// One grammar, written twice — here for the Mac and the phone, and in
/// `packages/contracts/src/quick-add.ts` for the Worker and the web — and
/// `fixtures/quick-add.json` is what keeps them the same: every rule there is
/// a case in both suites, and a change to either parser starts in the fixture.
///
/// Deterministic and instant: no model, no network. What it does not read
/// (no date at all, or two time expressions) is what the Worker sends to the
/// notes engine instead; `confidence` says which. Times are local wall time
/// in the caller's zone, written without an offset; days are `YYYY-MM-DD`.
/// The arithmetic runs on calendar fields in a fixed proleptic Gregorian
/// calendar, never on `Date` in a zone, so a DST edge cannot move a day.
struct CalendarQuickAddDraft: Equatable, Sendable {
    let title: String
    /// `YYYY-MM-DDTHH:MM` local, `YYYY-MM-DD` when all-day or when only a date was read, nil when nothing was.
    let start: String?
    let end: String?
    let allDay: Bool
    let location: String?
    /// Names as typed after "with"; the caller resolves them against contacts.
    let invitees: [String]
    /// 1: a date and a time, or an all-day span. 0.5: only a date. 0: nothing read.
    let confidence: Double
}

enum CalendarQuickAdd {
    static let emptyTitle = String(localized: "New event")

    struct Context {
        /// The moment of typing as local wall time, `YYYY-MM-DDTHH:MM`.
        let now: String
        let defaultDurationMinutes: Int

        /// The moment of typing, in the device's calendar.
        init(now date: Date = Date(), calendar: Calendar = .current, defaultDurationMinutes: Int) {
            let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
            self.now = String(format: "%04d-%02d-%02dT%02d:%02d", parts.year ?? 2000, parts.month ?? 1, parts.day ?? 1, parts.hour ?? 0, parts.minute ?? 0)
            self.defaultDurationMinutes = defaultDurationMinutes
        }

        init(now: String, defaultDurationMinutes: Int) {
            self.now = now
            self.defaultDurationMinutes = defaultDurationMinutes
        }
    }

    private struct Local: Equatable { var y: Int; var m: Int; var d: Int }
    private struct Clock: Equatable { var h: Int; var min: Int }
    private struct Span { let start: Int; let end: Int }
    private struct TimeRead { let clock: Clock; let end: Clock?; let span: Span }

    private static let weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
    private static let weekdayShort = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
    private static let months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
    private static let monthShort = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
    private static let weekdayRE = "(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)"
    private static let monthRE = "(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)"
    /// A time with a marker: `14:00`, `14.00`, `2pm`, `2 pm`, `9:30am`, `14h`, `14h30`.
    private static let timeStrict = "(\\d{1,2})(?::(\\d{2})|\\.(\\d{2})|h(\\d{2})?)?\\s*(am|pm)?"

    /// The sentence as a draft. Pure.
    static func parse(_ input: String, context: Context) -> CalendarQuickAddDraft {
        let text = input.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        let lower = text.lowercased() as NSString
        let original = text as NSString
        let now = parseLocal(context.now)
        var consumed: [Span] = []
        func take(_ span: Span) { consumed.append(span) }
        func free(_ index: Int) -> Bool { !consumed.contains { index >= $0.start && index < $0.end } }
        func span(_ range: NSRange) -> Span { Span(start: range.location, end: range.location + range.length) }

        // All day, anywhere.
        var allDay = false
        for match in matches("\\ball[- ]day\\b", in: lower) {
            allDay = true
            take(span(match.range))
        }

        // A span of days: "3-5 Oct", "3 to 5 Oct", "Oct 3-5", "14 Oct - 16 Oct".
        var day: Local?
        var lastDay: Local?
        var dayIsToday = false
        if let c = first("\\b(\\d{1,2})\\s+(\(monthRE))\\s*(?:-|–|to)\\s*(\\d{1,2})\\s+(\(monthRE))\\b", in: lower) {
            let firstDay = nextDate(now, month: monthIndex(group(c, 2, lower)), day: Int(group(c, 1, lower))!)
            var last = Local(y: firstDay.y, m: monthIndex(group(c, 4, lower)), d: Int(group(c, 3, lower))!)
            if compare(last, firstDay) < 0 { last.y += 1 }
            day = firstDay; lastDay = last; allDay = true
            take(span(c.range))
        } else if let a = first("\\b(\\d{1,2})\\s*(?:-|–|to)\\s*(\\d{1,2})\\s+(\(monthRE))\\b", in: lower) {
            let month = monthIndex(group(a, 3, lower))
            let firstDay = nextDate(now, month: month, day: Int(group(a, 1, lower))!)
            day = firstDay
            lastDay = Local(y: firstDay.y, m: firstDay.m, d: Int(group(a, 2, lower))!)
            allDay = true
            take(span(a.range))
        } else if let b = first("\\b(\(monthRE))\\s+(\\d{1,2})\\s*(?:-|–|to)\\s*(\\d{1,2})\\b", in: lower) {
            let month = monthIndex(group(b, 1, lower))
            let firstDay = nextDate(now, month: month, day: Int(group(b, 2, lower))!)
            day = firstDay
            lastDay = Local(y: firstDay.y, m: firstDay.m, d: Int(group(b, 3, lower))!)
            allDay = true
            take(span(b.range))
        }

        // A date: "14 October", "Oct 14", "14/10", "2026-10-14".
        if day == nil {
            if let iso = first("\\b(\\d{4})-(\\d{2})-(\\d{2})\\b", in: lower) {
                day = Local(y: Int(group(iso, 1, lower))!, m: Int(group(iso, 2, lower))! - 1, d: Int(group(iso, 3, lower))!)
                take(span(iso.range))
            } else if let dm = first("\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(\(monthRE))\\b", in: lower) {
                day = nextDate(now, month: monthIndex(group(dm, 2, lower)), day: Int(group(dm, 1, lower))!)
                take(span(dm.range))
            } else if let md = first("\\b(\(monthRE))\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b", in: lower) {
                day = nextDate(now, month: monthIndex(group(md, 1, lower)), day: Int(group(md, 2, lower))!)
                take(span(md.range))
            } else if let numeric = first("\\b(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}))?\\b", in: lower) {
                let month = Int(group(numeric, 2, lower))! - 1
                if numeric.range(at: 3).location != NSNotFound {
                    day = Local(y: Int(group(numeric, 3, lower))!, m: month, d: Int(group(numeric, 1, lower))!)
                } else {
                    day = nextDate(now, month: month, day: Int(group(numeric, 1, lower))!)
                }
                take(span(numeric.range))
            }
        }

        // A day word: today, tomorrow, tonight, a weekday, "next <weekday>". A
        // weekday after "every" is recurrence, not a date, and stays in the title.
        var tonight = false
        if day == nil {
            if let word = first("\\b(today|tomorrow|tonight)\\b", in: lower) {
                let which = group(word, 1, lower)
                day = which == "tomorrow" ? addDays(now, 1) : Local(y: now.y, m: now.m, d: now.d)
                dayIsToday = which != "tomorrow"
                tonight = which == "tonight"
                take(span(word.range))
            } else if let weekday = first("(?<!\\bevery\\s)\\b(next\\s+)?(\(weekdayRE))\\b", in: lower) {
                let target = weekdayIndex(group(weekday, 2, lower))
                let todayIndex = weekdayOf(now)
                var ahead = (target - todayIndex + 7) % 7
                if weekday.range(at: 1).location != NSNotFound { ahead += 7 }
                day = addDays(now, ahead)
                dayIsToday = ahead == 0
                take(span(weekday.range))
            }
        }
        // "on" before a day or date is dropped with it.
        for existing in consumed {
            let before = original.substring(to: existing.start)
            if let on = first("\\bon\\s+$", in: before as NSString) {
                take(Span(start: on.range.location, end: existing.start))
            }
        }

        // Times: a range first, then "at <time>", then any marked time. More
        // than one expression is not for the grammar.
        var times: [TimeRead] = []
        if let range = firstFree("\\b\(timeStrict)\\s*(?:-|–|to|until)\\s*\(timeStrict)\\b", in: lower, free: free, avoiding: []) {
            if var startClock = clock(hour: group(range, 1, lower), minute: firstPresent(range, [2, 3, 4], lower), meridiem: optional(range, 5, lower)),
               let endClock = clock(hour: group(range, 6, lower), minute: firstPresent(range, [7, 8, 9], lower), meridiem: optional(range, 10, lower)) {
                // A bare start takes the end's marker: "9-10am".
                if optional(range, 5, lower) == nil, let marker = optional(range, 10, lower), startClock.h <= 12,
                   let marked = clock(hour: group(range, 1, lower), minute: nil, meridiem: marker) {
                    startClock.h = marked.h
                }
                times.append(TimeRead(clock: startClock, end: endClock, span: span(range.range)))
            }
        }
        if let at = firstFree("\\bat\\s+\(timeStrict)\\b", in: lower, free: free, avoiding: times.map(\.span)),
           let read = clock(hour: group(at, 1, lower), minute: firstPresent(at, [2, 3, 4], lower), meridiem: optional(at, 5, lower)) {
            times.append(TimeRead(clock: read, end: nil, span: span(at.range)))
        }
        for match in matches("\\b(\\d{1,2})(?::(\\d{2})|\\.(\\d{2})|h(\\d{2})?|\\s*(am|pm))(?:\\s*(am|pm))?\\b", in: lower) {
            let this = span(match.range)
            if !free(this.start) || times.contains(where: { overlaps($0.span, this) }) { continue }
            let whole = lower.substring(with: match.range)
            let isHourForm = match.range(at: 4).location != NSNotFound || whole.range(of: "^\\d{1,2}h", options: .regularExpression) != nil
            // "1h30" after a time is a duration, not one o'clock.
            if isHourForm, !times.isEmpty { continue }
            if let read = clock(hour: group(match, 1, lower), minute: firstPresent(match, [2, 3, 4], lower), meridiem: optional(match, 5, lower) ?? optional(match, 6, lower)) {
                times.append(TimeRead(clock: read, end: nil, span: this))
            }
        }
        if times.count > 1 {
            return CalendarQuickAddDraft(title: text.isEmpty ? emptyTitle : text, start: nil, end: nil, allDay: false, location: nil, invitees: [], confidence: 0)
        }
        let time = times.first
        if let time { take(time.span) }

        // A duration: "45 min", "1h30", "for 30 minutes", "1.5h".
        var durationMinutes: Int?
        if let duration = firstFree("\\b(?:for\\s+)?(\\d+(?:[.,]\\d+)?)\\s*(minutes?|mins?|hours?|hrs?|h)(?:\\s*(\\d{2}))?\\b", in: lower, free: free, avoiding: []) {
            let amount = Double(group(duration, 1, lower).replacingOccurrences(of: ",", with: ".")) ?? 0
            let unit = group(duration, 2, lower)
            let extra = optional(duration, 3, lower).flatMap(Int.init) ?? 0
            durationMinutes = unit.hasPrefix("h") ? Int((amount * 60).rounded()) + extra : Int(amount.rounded())
            take(span(duration.range))
        }

        // Invitees: "with <name>, <name> and <name>". Read over the sentence
        // with what was consumed blanked out, not consumed themselves.
        var invitees: [String] = []
        // Built over UTF-16 offsets to stay aligned with NSRange.
        var residual = ""
        for index in 0..<original.length {
            let unit = original.substring(with: NSRange(location: index, length: 1))
            residual += free(index) ? unit : " "
        }
        let name = "[A-ZÀ-ÝÁÉÍÓÚÂÊÔÃÕÇ][\\w'’-]*(?:\\s+[A-ZÀ-ÝÁÉÍÓÚÂÊÔÃÕÇ][\\w'’-]*)?"
        if let with = first("\\bwith\\s+(\(name)(?:\\s*,\\s*\(name))*(?:\\s+and\\s+\(name))?)", in: residual as NSString, caseInsensitive: false) {
            let phrase = group(with, 1, residual as NSString)
            let separated = phrase.replacingOccurrences(of: "\\s*,\\s*|\\s+and\\s+", with: "\n", options: .regularExpression)
            for part in separated.components(separatedBy: "\n") {
                let trimmed = part.trimmingCharacters(in: .whitespaces)
                if !trimmed.isEmpty { invitees.append(trimmed) }
            }
        }

        // A place: "at <words>" up to a comma or something already read.
        var location: String?
        if let at = firstFree("\\bat\\s+(?=\\S)", in: original, free: free, avoiding: []) {
            let from = at.range.location + at.range.length
            var end = original.length
            for existing in consumed where existing.start >= from && existing.start < end { end = existing.start }
            let comma = original.range(of: ",", options: [], range: NSRange(location: from, length: original.length - from))
            if comma.location != NSNotFound, comma.location < end { end = comma.location }
            let withAt = original.range(of: "\\bwith\\b", options: .regularExpression, range: NSRange(location: from, length: original.length - from))
            if withAt.location != NSNotFound, withAt.location < end { end = withAt.location }
            let place = original.substring(with: NSRange(location: from, length: end - from)).trimmingCharacters(in: .whitespaces)
            if !place.isEmpty {
                location = place
                take(Span(start: at.range.location, end: end))
            }
        }

        // The title is what is left.
        var title = ""
        for index in 0..<original.length where free(index) {
            title += original.substring(with: NSRange(location: index, length: 1))
        }
        title = title.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s*,\\s*", with: ", ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        let dangling = "^(?:(?:on|for|from|the|at|,)\\s+)+|(?:\\s+(?:on|for|from|the|at))+$|[,\\s]+$|^[,\\s]+"
        var previous = ""
        while previous != title {
            previous = title
            title = title.replacingOccurrences(of: dangling, with: "", options: [.regularExpression, .caseInsensitive]).trimmingCharacters(in: .whitespaces)
        }
        if title.isEmpty { title = emptyTitle }

        // Assemble.
        if day == nil, time == nil {
            return CalendarQuickAddDraft(title: title, start: nil, end: nil, allDay: false, location: location, invitees: invitees, confidence: 0)
        }
        if allDay || lastDay != nil {
            let firstDay = day ?? Local(y: now.y, m: now.m, d: now.d)
            let last = lastDay ?? firstDay
            return CalendarQuickAddDraft(title: title, start: formatDay(firstDay), end: formatDay(addDays(last, 1)), allDay: true, location: location, invitees: invitees, confidence: 1)
        }
        if let day, time == nil, !tonight {
            return CalendarQuickAddDraft(title: title, start: formatDay(day), end: nil, allDay: false, location: location, invitees: invitees, confidence: 0.5)
        }
        let clockRead = time?.clock ?? Clock(h: 19, min: 0)
        var startDay: Local
        let nowClock = clockOfLocal(context.now)
        if let day {
            startDay = day
            if dayIsToday, time != nil, clockRead.h * 60 + clockRead.min <= nowClock.h * 60 + nowClock.min, !tonight,
               first("\\btoday\\b", in: lower) == nil {
                // A weekday that is today with its time gone is next week;
                // "today" itself stays today.
                startDay = addDays(day, 7)
            }
        } else {
            // No day: today while the time is ahead, otherwise tomorrow.
            startDay = clockRead.h * 60 + clockRead.min > nowClock.h * 60 + nowClock.min ? Local(y: now.y, m: now.m, d: now.d) : addDays(now, 1)
        }
        let endDay: Local
        let endClock: Clock
        if let rangeEnd = time?.end {
            endDay = rangeEnd.h * 60 + rangeEnd.min < clockRead.h * 60 + clockRead.min && clockRead.h >= 12 ? addDays(startDay, 1) : startDay
            endClock = rangeEnd
        } else {
            (endDay, endClock) = addMinutes(day: startDay, clock: clockRead, minutes: durationMinutes ?? context.defaultDurationMinutes)
        }
        return CalendarQuickAddDraft(
            title: title,
            start: formatLocal(startDay, clockRead),
            end: formatLocal(endDay, endClock),
            allDay: false,
            location: location,
            invitees: invitees,
            confidence: 1
        )
    }

    // MARK: - Pieces

    private static func regex(_ pattern: String, caseInsensitive: Bool = true) -> NSRegularExpression {
        // Every pattern here is a literal in this file; a typo is a crash at first use, in tests.
        try! NSRegularExpression(pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : [])
    }

    private static func matches(_ pattern: String, in text: NSString) -> [NSTextCheckingResult] {
        regex(pattern).matches(in: text as String, range: NSRange(location: 0, length: text.length))
    }

    private static func first(_ pattern: String, in text: NSString, caseInsensitive: Bool = true) -> NSTextCheckingResult? {
        regex(pattern, caseInsensitive: caseInsensitive).firstMatch(in: text as String, range: NSRange(location: 0, length: text.length))
    }

    private static func firstFree(_ pattern: String, in text: NSString, free: (Int) -> Bool, avoiding: [Span]) -> NSTextCheckingResult? {
        for match in matches(pattern, in: text) {
            let candidate = Span(start: match.range.location, end: match.range.location + match.range.length)
            if free(candidate.start), free(max(candidate.start, candidate.end - 1)), !avoiding.contains(where: { overlaps($0, candidate) }) {
                return match
            }
        }
        return nil
    }

    private static func overlaps(_ a: Span, _ b: Span) -> Bool { a.start < b.end && b.start < a.end }

    private static func group(_ match: NSTextCheckingResult, _ index: Int, _ text: NSString) -> String {
        let range = match.range(at: index)
        return range.location == NSNotFound ? "" : text.substring(with: range)
    }

    private static func optional(_ match: NSTextCheckingResult, _ index: Int, _ text: NSString) -> String? {
        match.range(at: index).location == NSNotFound ? nil : text.substring(with: match.range(at: index))
    }

    private static func firstPresent(_ match: NSTextCheckingResult, _ indices: [Int], _ text: NSString) -> String? {
        for index in indices {
            if let value = optional(match, index, text) { return value }
        }
        return nil
    }

    private static func clock(hour: String, minute: String?, meridiem: String?) -> Clock? {
        guard var h = Int(hour) else { return nil }
        let min = minute.flatMap(Int.init) ?? 0
        if h > 23 || min > 59 { return nil }
        if meridiem == "pm", h < 12 { h += 12 }
        if meridiem == "am", h == 12 { h = 0 }
        return Clock(h: h, min: min)
    }

    private static func monthIndex(_ name: String) -> Int {
        let lower = name.lowercased()
        if let long = months.firstIndex(of: lower) { return long }
        return monthShort.firstIndex(of: String(lower.prefix(3))) ?? 0
    }

    private static func weekdayIndex(_ name: String) -> Int {
        let lower = name.lowercased()
        if let long = weekdays.firstIndex(of: lower) { return long }
        return weekdayShort.firstIndex(of: String(lower.prefix(3))) ?? 0
    }

    private static func parseLocal(_ value: String) -> Local {
        let parts = value.split(separator: "T")[0].split(separator: "-").compactMap { Int($0) }
        return Local(y: parts[0], m: parts[1] - 1, d: parts[2])
    }

    private static func clockOfLocal(_ value: String) -> Clock {
        let pieces = value.split(separator: "T")
        guard pieces.count > 1 else { return Clock(h: 0, min: 0) }
        let parts = pieces[1].split(separator: ":").compactMap { Int($0) }
        return Clock(h: parts.first ?? 0, min: parts.count > 1 ? parts[1] : 0)
    }

    private static func compare(_ a: Local, _ b: Local) -> Int {
        a.y != b.y ? a.y - b.y : a.m != b.m ? a.m - b.m : a.d - b.d
    }

    /// The next such day-and-month from `now`, today included.
    private static func nextDate(_ now: Local, month: Int, day: Int) -> Local {
        let candidate = Local(y: now.y, m: month, d: day)
        return compare(candidate, now) < 0 ? Local(y: now.y + 1, m: month, d: day) : candidate
    }

    private static var gregorian: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private static func addDays(_ local: Local, _ days: Int) -> Local {
        let base = gregorian.date(from: DateComponents(year: local.y, month: local.m + 1, day: local.d))!
        let moved = gregorian.date(byAdding: .day, value: days, to: base)!
        let parts = gregorian.dateComponents([.year, .month, .day], from: moved)
        return Local(y: parts.year!, m: parts.month! - 1, d: parts.day!)
    }

    private static func weekdayOf(_ local: Local) -> Int {
        let date = gregorian.date(from: DateComponents(year: local.y, month: local.m + 1, day: local.d))!
        return gregorian.component(.weekday, from: date) - 1
    }

    private static func addMinutes(day: Local, clock: Clock, minutes: Int) -> (Local, Clock) {
        let total = clock.h * 60 + clock.min + minutes
        let days = Int((Double(total) / (24 * 60)).rounded(.down))
        let rest = total - days * 24 * 60
        return (addDays(day, days), Clock(h: rest / 60, min: rest % 60))
    }

    private static func formatDay(_ local: Local) -> String {
        String(format: "%04d-%02d-%02d", local.y, local.m + 1, local.d)
    }

    private static func formatLocal(_ local: Local, _ clock: Clock) -> String {
        String(format: "%@T%02d:%02d", formatDay(local), clock.h, clock.min)
    }
}

extension CalendarQuickAddDraft {
    /// The draft's start as an instant in `calendar`'s zone; nil when nothing was read.
    func startDate(calendar: Calendar = .current) -> Date? {
        start.flatMap { Self.date(from: $0, calendar: calendar) }
    }

    /// The draft's end as an instant. For an all-day draft the wire's end is
    /// the exclusive next day; the editors show the last day, so this gives
    /// the last day when `inclusiveAllDay` is set.
    func endDate(calendar: Calendar = .current, inclusiveAllDay: Bool = true) -> Date? {
        guard let end, let date = Self.date(from: end, calendar: calendar) else { return nil }
        if allDay, inclusiveAllDay { return calendar.date(byAdding: .day, value: -1, to: date) }
        return date
    }

    /// `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` as local wall time in `calendar`.
    static func date(from local: String, calendar: Calendar) -> Date? {
        let pieces = local.split(separator: "T")
        let day = pieces[0].split(separator: "-").compactMap { Int($0) }
        guard day.count == 3 else { return nil }
        var components = DateComponents(year: day[0], month: day[1], day: day[2], hour: 0, minute: 0)
        if pieces.count > 1 {
            let clock = pieces[1].split(separator: ":").compactMap { Int($0) }
            components.hour = clock.first ?? 0
            components.minute = clock.count > 1 ? clock[1] : 0
        }
        return calendar.date(from: components)
    }
}

/// What the Worker answers when the grammar could not read the sentence and
/// the notes engine did (`POST /api/calendar/quick-add`).
/// The Worker's reading of a sentence: the generated
/// `CalendarQuickAddResponse`; this is the draft as the composer takes it.
extension CalendarQuickAddDraftWire {
    var draft: CalendarQuickAddDraft {
        CalendarQuickAddDraft(title: title, start: start, end: end, allDay: allDay, location: location, invitees: invitees, confidence: confidence)
    }
}

// `POST /api/calendar/quick-add` is the generated `CalendarQuickAddRequest`.
