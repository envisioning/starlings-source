import Foundation
// Re-exported: every target that compiles this file sees the generated wire
// types without an import per file, the way it sees Foundation.
@_exported import StarlingsContracts

enum StarlingsEventsLifecycleEventKind: Equatable {
    case callStarted
    case callEnded
    case heartbeat
    case other(String)
}

extension StarlingsEventsLifecycleKindValue {
    var eventKind: StarlingsEventsLifecycleEventKind {
        switch rawValue {
        case "call-started": .callStarted
        case "call-ended": .callEnded
        case "heartbeat": .heartbeat
        default: .other(rawValue)
        }
    }
}

extension StarlingsEventsBatch {
    static let supportedSchemaVersions: Set<Int> = [1, 2]
}

extension HostMessageWire {
    static let topic = ContractConstants.hostDataTopic
}

/// `HOST_ATTRIBUTE`: the Worker sets it to "1" on the device that hosts.
enum HostAttribute {
    static let key = "host"

    static func isHost(_ attributes: [String: String]) -> Bool {
        attributes[key] == "1"
    }
}

/// Mirrors `isMobileOwnerIdentity` in `packages/contracts`: an owner identity
/// from `deviceScopedOwnerIdentity` for an iPhone or iPad.
enum OwnerDeviceIdentity {
    static func isMobile(_ identity: String) -> Bool {
        identity.lowercased().range(of: #"\+(?:iphone|ipad)(?:-|@)"#, options: .regularExpression) != nil
    }

    /// The account address behind a device identity: `mz+mac-…@x` is `mz@x`.
    static func person(_ identity: String) -> String {
        identity.lowercased().replacingOccurrences(of: #"\+[^@]*@"#, with: "@", options: .regularExpression)
    }
}

// What the native clients add to the generated wire types (`StarlingsContracts`):
// identity for lists, dates for epoch fields, the readings a surface needs.
// The shapes themselves are generated; nothing here changes a field.

extension LobbyRequestResponse: Identifiable {}
extension GuestPresenceRow: Identifiable {}
extension OwnerDeviceSummary: Identifiable {
    public var id: String { deviceID }
}

extension AvatarResponse {
    /// The new cache key as a Date, or nil once the picture is gone.
    var updatedDate: Date? { avatarUpdatedAt.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000) } }
}

extension ConnectionDetails {
    /// `startedAt` on the wire is epoch milliseconds; the same moment as a Date.
    var startedDate: Date { Date(timeIntervalSince1970: TimeInterval(startedAt) / 1000) }
}

extension LobbyRequestResponse {
    /// Still in the queue awaiting an owner decision.
    var isWaiting: Bool { status.isPending }
    /// Ordering key. Server FIFO by knock time, never by when this client last
    /// saw the row, which would make the queue jump on every poll.
    var knockedAt: Date { Date(timeIntervalSince1970: TimeInterval(createdAt) / 1000) }
}

/// What a lobby request's lifecycle means to a client. The values are the
/// contract's; a status added server-side decodes as itself and matches none
/// of these.
extension LobbyStatusValue {
    /// Still in the queue awaiting an owner decision.
    var isPending: Bool { self == .waiting }

    /// The owner said yes and the guest may exchange for media credentials.
    var isAdmitted: Bool { self == .admitted || self == .joined }

    /// Terminal: declined, or the room went away.
    var isClosed: Bool { self == .rejected || self == .expired }
}

/// The 30-second promise, from the host session and from every heartbeat.
/// `renewAfterMs` is the Worker's own pacing: follow it rather than a local
/// constant, so a server-side change to the lease window does not need a new
/// build to be honoured.
protocol HostLeaseTiming {
    var hostLeaseExpiresAt: Int { get }
    var renewAfterMs: Int { get }
}

extension HostLeaseTiming {
    var renewInterval: TimeInterval { TimeInterval(renewAfterMs) / 1000 }
    var expiresAt: Date { Date(timeIntervalSince1970: TimeInterval(hostLeaseExpiresAt) / 1000) }
}

extension HostLeaseGrant: HostLeaseTiming {}
extension HostHeartbeatResponse: HostLeaseTiming {}

// MARK: - Request bodies

extension GuestClient {
    /// So the host's waiting room can say "Mac app" rather than assuming browser.
    static let mac = GuestClient(app: .mac, device: .desktop)
}

/// A key of `BookingWeeklyHours`.
enum BookingWeekday: String, CaseIterable, Identifiable, Sendable {
    // Monday first, the order of `BOOKING_WEEKDAYS`.
    case mon, tue, wed, thu, fri, sat, sun

    var id: String { rawValue }

    /// This language's short weekday name.
    var label: String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = .current
        // `shortWeekdaySymbols` starts on Sunday.
        let symbols = calendar.shortWeekdaySymbols
        let index = (BookingWeekday.allCases.firstIndex(of: self)! + 1) % 7
        return symbols.indices.contains(index) ? symbols[index] : rawValue
    }
}

/// One weekday of the booking week (Settings › Calendar › Booking hours).
extension BookingWeeklyHours {
    subscript(day: BookingWeekday) -> BookingDayHours {
        switch day {
        case .mon: mon
        case .tue: tue
        case .wed: wed
        case .thu: thu
        case .fri: fri
        case .sat: sat
        case .sun: sun
        }
    }

    /// The same week with one day's window changed.
    func replacing(_ day: BookingWeekday, with hours: BookingDayHours) -> BookingWeeklyHours {
        BookingWeeklyHours(
            mon: day == .mon ? hours : mon,
            tue: day == .tue ? hours : tue,
            wed: day == .wed ? hours : wed,
            thu: day == .thu ? hours : thu,
            fri: day == .fri ? hours : fri,
            sat: day == .sat ? hours : sat,
            sun: day == .sun ? hours : sun
        )
    }
}

extension BookingDayHours {
    func with(enabled: Bool? = nil, startMinute: Int? = nil, endMinute: Int? = nil) -> BookingDayHours {
        BookingDayHours(
            enabled: enabled ?? self.enabled,
            startMinute: startMinute ?? self.startMinute,
            endMinute: endMinute ?? self.endMinute
        )
    }
}

// Canonical identity is shared by Inbox rows and question sheets.
extension AttentionRequest: Identifiable {}

extension AttentionRequest {
    var questionDetail: String {
        [String(localized: "Question"), String(localized: "Asked by \(askedBy)"), subject?.title ?? context]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
    var terminalLabel: String? {
        switch state {
        case .open: nil
        case .answered: String(localized: "Answered")
        case .dismissed: String(localized: "Dismissed")
        case .withdrawn: String(localized: "Withdrawn")
        case .defaulted: String(localized: "Default applied")
        default: state.rawValue
        }
    }
}
