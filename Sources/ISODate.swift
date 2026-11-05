import Foundation

/// Shared ISO-8601 parsing/formatting for wire timestamps, which arrive both
/// with and without fractional seconds. Formatters are cached — creating an
/// ISO8601DateFormatter is expensive, and the class is thread-safe.
enum ISODate {
    // nonisolated(unsafe): Foundation date formatters are thread-safe for
    // parsing and formatting as long as their configuration is not mutated
    // after setup, which is the case here — formatOptions is set once inside
    // the initializer and never touched again.
    private nonisolated(unsafe) static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private nonisolated(unsafe) static let whole: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func parse(_ value: String) -> Date? {
        fractional.date(from: value) ?? whole.date(from: value)
    }

    static func format(_ date: Date) -> String {
        fractional.string(from: date)
    }
}
