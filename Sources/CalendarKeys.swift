import Foundation

/// The keys calendar choices are stored under, and the two rules that change
/// them, decided once in `packages/contracts/src/calendar-keys.ts`. The prefixes are
/// generated from it (`pnpm registries:gen`); the rules below are the Swift mirror, which
/// `fixtures/calendar-keys.json` pins (`CalendarKeysFixtureTests`).
///
/// `hidden_calendar_keys` and `disabled_calendar_keys` are owner-wide and read by
/// every client and the Worker. A key is opaque text with a grammar; building
/// one anywhere else is how the copies drift.
enum CalendarKeys {
    // The prefixes and `subscribedAccount` are the grammar's data, generated from the
    // TypeScript module: Sources/Generated/CalendarKeysRegistry.swift.

    static func google(_ calendarID: String) -> String { "\(googlePrefix)\(calendarID)" }
    static func subscription(_ subscriptionID: String) -> String { "\(subscriptionPrefix)\(subscriptionID)" }
    static func eventKit(account: String, title: String) -> String {
        "\(eventKitPrefix)\(account.lowercased())\(eventKitSeparator)\(title.lowercased())"
    }

    /// A whole account, by its heading.
    static func account(_ title: String) -> String { "\(accountPrefix)\(title.lowercased())" }

    /// An event hidden from Next: a subscribed feed's row by its own id, a Google row as `event:g:` and the served id.
    static func eventDemotion(isSubscription: Bool, eventID: String) -> String {
        "\(isSubscription ? eventPrefix : googleEventPrefix)\(eventID)"
    }

    /// Show or hide one calendar. Turning one back on inside an account that was hidden
    /// wholesale expands the account key into one key per sibling, so the other choices are kept.
    static func withCalendarHidden(
        _ keys: Set<String>,
        calendarKey: String,
        accountKey: String,
        siblingKeys: [String],
        hidden: Bool
    ) -> Set<String> {
        var next = keys
        if hidden {
            next.insert(calendarKey)
            return next
        }
        if next.remove(accountKey) != nil {
            for sibling in siblingKeys where sibling != calendarKey { next.insert(sibling) }
        }
        next.remove(calendarKey)
        return next
    }

    /// Show or hide a whole account: its own key stands for every calendar, present and future.
    static func withAccountHidden(
        _ keys: Set<String>,
        accountKey: String,
        memberKeys: [String],
        hidden: Bool
    ) -> Set<String> {
        var next = keys
        for member in memberKeys { next.remove(member) }
        if hidden { next.insert(accountKey) } else { next.remove(accountKey) }
        return next
    }
}
