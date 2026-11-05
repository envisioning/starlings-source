import Foundation

/// Settings › Calendar › Booking hours, the parts the Mac and the phone share
///. The web editor is `web/src/BookingSettings.tsx`; the wire is
/// `packages/contracts/src/booking-settings.ts`. Each view draws its own
/// controls; the defaults, the limits and the words come from here.
enum BookingHours {
    /// One number field: its label and the range `bookingFields` accepts.
    struct NumberField: Identifiable {
        let id: WritableKeyPath<BookingSettingsUpdate, Int>
        let label: String
        let range: ClosedRange<Int>

        func clamped(_ value: Int) -> Int {
            min(range.upperBound, max(range.lowerBound, value))
        }
    }

    /// The five numbers, in the web's order.
    static var numberFields: [NumberField] {
        [
            NumberField(id: \.durationMinutes, label: String(localized: "Meeting length (minutes)"), range: 15...240),
            NumberField(id: \.slotStepMinutes, label: String(localized: "Start a slot every (minutes)"), range: 5...240),
            NumberField(id: \.bufferMinutes, label: String(localized: "Gap around meetings (minutes)"), range: 0...120),
            NumberField(id: \.minNoticeHours, label: String(localized: "Notice (hours)"), range: 0...168),
            NumberField(id: \.maxBookingDays, label: String(localized: "Book up to (days ahead)"), range: 1...365),
        ]
    }

    /// Every quarter hour of the day, as minutes after midnight.
    static let clockMinutes: [Int] = Array(stride(from: 0, to: 24 * 60, by: 15))

    /// A minute of the day on the 24-hour clock (AGENTS.md invariant 20).
    static func clock(_ minute: Int) -> String {
        String(format: "%02d:%02d", minute / 60, minute % 60)
    }

    /// 09:00 to 17:00 on weekdays, as the web starts a member with no hours.
    static let defaultWeek = BookingWeeklyHours(
        mon: workday, tue: workday, wed: workday, thu: workday, fri: workday,
        sat: BookingDayHours(enabled: false, startMinute: 9 * 60, endMinute: 17 * 60),
        sun: BookingDayHours(enabled: false, startMinute: 9 * 60, endMinute: 17 * 60)
    )
    private static let workday = BookingDayHours(enabled: true, startMinute: 9 * 60, endMinute: 17 * 60)

    /// The form's starting values: the saved ones, else the default week in
    /// this device's zone.
    static func draft(from settings: BookingSettingsResponse) -> BookingSettingsUpdate {
        BookingSettingsUpdate(
            active: settings.active,
            durationMinutes: settings.durationMinutes,
            bufferMinutes: settings.bufferMinutes,
            minNoticeHours: settings.minNoticeHours,
            maxBookingDays: settings.maxBookingDays,
            slotStepMinutes: settings.slotStepMinutes,
            timezone: settings.timezone ?? TimeZone.current.identifier,
            weeklyHours: settings.weeklyHours ?? defaultWeek
        )
    }

    /// The zones this device knows, with the current one first when it is not among them.
    static func timeZoneOptions(current: String?) -> [StarlingsSearchablePickerOption] {
        var zones = TimeZone.knownTimeZoneIdentifiers
        if let current, !zones.contains(current) { zones.insert(current, at: 0) }
        return zones.map { StarlingsSearchablePickerOption(id: $0, title: $0) }
    }

    /// The line above the form: where guests book, or that there is no page.
    static func note(room: String?) -> String {
        guard let room else {
            return String(localized: "These are your working hours. You have no booking page yet.")
        }
        let path = "/book/\(room)"
        return String(localized: "Guests book a time on \(path) inside these hours, around your busy times.")
    }

    /// The web shows this when the member has a booking page and no calendar.
    static var notTakingBookingsWarning: String {
        String(localized: "Connect Google Calendar above to take bookings. Until then your booking page says you are not taking bookings.")
    }

    static var readFailure: String { String(localized: "Couldn’t read your booking hours.") }
    static var saveFailure: String { String(localized: "Couldn’t save your booking hours.") }
    static var saved: String { String(localized: "Saved. Your hours on Team follow the same setting.") }
}
