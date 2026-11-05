import Foundation

/// Product-wide display formatting for clock times.
///
/// Calendar data remains in the owner's or viewer's real time zone, but the
/// way a time is written is a Meet decision, not a device-locale decision.
/// Keeping this here prevents a 12-hour locale from leaking a meridiem marker
/// through a native screen that happened to use Swift's `.shortened` style.
enum StarlingsDateFormatting {
    /// Also supplied to native date-picker controls so their editable clock
    /// fields follow the same 24-hour rule as rendered labels.
    ///
    /// The locale follows the language the bundle draws in ( step
    /// 5): `pt_BR` when the person chose Português, `en_GB` otherwise. Both
    /// write a 24-hour clock, which is what `check-time-format.sh` pins; day
    /// and month names follow the language. `Bundle.main.preferredLocalizations`
    /// is what the strings themselves resolve through, so labels and dates
    /// cannot disagree. In a widget or the watch it is the device's language.
    static var locale: Locale {
        Bundle.main.preferredLocalizations.first?.hasPrefix("pt") == true ? portugueseLocale : englishLocale
    }

    private static let englishLocale = Locale(identifier: "en_GB")
    private static let portugueseLocale = Locale(identifier: "pt_BR")

    static var timeStyle: Date.FormatStyle {
        Date.FormatStyle(date: .omitted, time: .shortened)
            .locale(locale)
            .hour(.twoDigits(amPM: .omitted))
            .minute(.twoDigits)
    }

    static func time(_ date: Date, timeZone: TimeZone? = nil) -> String {
        var style: Date.FormatStyle
        if let timeZone {
            style = Date.FormatStyle(date: .omitted, time: .shortened, timeZone: timeZone)
        } else {
            style = Date.FormatStyle(date: .omitted, time: .shortened)
        }
        style.locale = locale
        style = style.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)
        return style.format(date)
    }

    static func date(_ date: Date, dateStyle: Date.FormatStyle.DateStyle = .abbreviated) -> String {
        var style = Date.FormatStyle(date: dateStyle, time: .omitted)
        style.locale = locale
        return style.format(date)
    }

    /// A day on a Home card row: "6 Oct", or "6 Oct 2027" when it is not this
    /// year. Mac, iOS and the web draw the same line.
    static func cardDate(_ date: Date, now: Date = Date(), calendar: Calendar = .autoupdatingCurrent) -> String {
        let sameYear = calendar.isDate(date, equalTo: now, toGranularity: .year)
        var style = Date.FormatStyle(date: .omitted, time: .omitted)
        style.locale = locale
        style.calendar = calendar
        return sameYear
            ? style.month(.abbreviated).day().format(date)
            : style.year().month(.abbreviated).day().format(date)
    }

    /// "5 minutes ago", "yesterday": a past moment on a Home row. Clamped
    /// forward, so clock skew between this device and the control plane never
    /// reads "in 3 minutes".
    static func relative(_ date: Date, now: Date = Date()) -> String {
        min(date, now).formatted(.relative(presentation: .named).locale(locale))
    }

    /// The date under Home's clock, shared by the Mac and iOS surfaces.
    static func homeDate(_ date: Date) -> String {
        var style = Date.FormatStyle(date: .omitted, time: .omitted)
        style.locale = locale
        return style.weekday(.wide).month(.wide).day().format(date)
    }

    static func dateTime(
        _ date: Date,
        dateStyle: Date.FormatStyle.DateStyle,
        timeZone: TimeZone? = nil
    ) -> String {
        var style: Date.FormatStyle
        if let timeZone {
            style = Date.FormatStyle(date: dateStyle, time: .shortened, timeZone: timeZone)
        } else {
            style = Date.FormatStyle(date: dateStyle, time: .shortened)
        }
        style.locale = locale
        style = style.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)
        return style.format(date)
    }

    static func hour(_ date: Date, timeZone: TimeZone? = nil) -> String {
        var calendar = Calendar.autoupdatingCurrent
        if let timeZone { calendar.timeZone = timeZone }
        return String(format: "%02d", calendar.component(.hour, from: date))
    }

    /// Compact countdown precision follows distance: minutes when close, five
    /// minute steps within the first ten hours, and whole hours after that.
    static func compactDuration(until target: Date, from now: Date = Date()) -> String {
        let totalMinutes = Int((max(0, target.timeIntervalSince(now)) / 60).rounded())
        if totalMinutes < 1 { return "now" }
        if totalMinutes < 60 { return "\(totalMinutes)m" }

        let hours = totalMinutes / 60
        let minutes = totalMinutes % 60
        if hours >= 10 {
            let rounded = Int((Double(totalMinutes) / 60).rounded())
            return String(localized: "\(max(hours, rounded))h")
        }
        if minutes < 8 { return "\(hours)h" }
        let snapped = Int((Double(minutes) / 5).rounded()) * 5
        if snapped >= 60 { return "\(hours + 1)h" }
        return String(localized: "\(hours)h \(snapped)m")
    }
}

extension StarlingsDateFormatting {
    /// Absolute, the way Home says when: "Today 15:00", "Tomorrow 09:30",
    /// "Mon 12 Aug 09:30".
    static func dayTime(_ date: Date, calendar: Calendar = .autoupdatingCurrent) -> String {
        let clock = time(date)
        if calendar.isDateInToday(date) { return "Today \(clock)" }
        if calendar.isDateInTomorrow(date) { return "Tomorrow \(clock)" }
        return String(localized: "\(date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))) \(clock)")
    }

    /// Relative, the way Home counts: "in 2h 15m" before the start, "ends in
    /// 40m" once it has begun, "ended" after. Re-derived from `now` on every
    /// call so a meeting that ends while you look stops claiming to be on.
    static func relativeCountdown(start: Date?, end: Date?, now: Date) -> String {
        if let start, start > now {
            return String(localized: "in \(compactDuration(until: start, from: now))")
        }
        if let end, end > now {
            return String(localized: "ends in \(compactDuration(until: end, from: now))")
        }
        return "ended"
    }
}

extension Date {
    func meetTimeString(timeZone: TimeZone? = nil) -> String {
        StarlingsDateFormatting.time(self, timeZone: timeZone)
    }

    func meetDateTimeString(
        dateStyle: Date.FormatStyle.DateStyle,
        timeZone: TimeZone? = nil
    ) -> String {
        StarlingsDateFormatting.dateTime(self, dateStyle: dateStyle, timeZone: timeZone)
    }
}
