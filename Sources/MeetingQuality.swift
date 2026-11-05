import Foundation
import StarlingsContracts
import LiveKit

/// LiveKit's ``ConnectionQuality`` mapped to a stable wire value. The raw enum
/// is an `Int` whose ordering is not meaningful for reporting, so everything
/// that leaves this app — the QoE report and the participant menu — uses these
/// names instead.
enum MeetingConnectionQuality: String, Sendable, Equatable {
    case unknown
    case lost
    case poor
    case good
    case excellent

    init(_ quality: ConnectionQuality) {
        switch quality {
        case .excellent: self = .excellent
        case .good: self = .good
        case .poor: self = .poor
        case .lost: self = .lost
        case .unknown: self = .unknown
        @unknown default: self = .unknown
        }
    }

    /// Lower is worse. `unknown` has no severity because it only means the SFU
    /// has not scored this participant yet.
    var severity: Int? {
        switch self {
        case .lost: 0
        case .poor: 1
        case .good: 2
        case .excellent: 3
        case .unknown: nil
        }
    }

    var label: String {
        switch self {
        case .excellent: String(localized: "Excellent")
        case .good: String(localized: "Good")
        case .poor: String(localized: "Poor")
        case .lost: String(localized: "Lost")
        case .unknown: String(localized: "Measuring…")
        }
    }

    /// The single definition of "this person is struggling". `unknown` is not
    /// weak — it only means the SFU has not scored them yet, and flashing a
    /// warning during the first seconds of every call would train people to
    /// ignore it.
    var isWeak: Bool {
        self == .poor || self == .lost
    }

    /// A shared variable-value symbol across the native clients. The bar count
    /// carries strength; colour and the accessibility label retain the exact
    /// quality state.
    var tileIconSystemName: String {
        "cellularbars"
    }

    /// SF Symbols maps 0...1 to the visible bars. Unknown stays at zero until
    /// LiveKit has scored the connection, rather than implying it is healthy.
    var tileSignalValue: Double {
        switch self {
        case .unknown, .lost: 0
        case .poor: 0.33
        case .good: 0.67
        case .excellent: 1
        }
    }

    var tileIconAccessibilityLabel: String {
        "Connection quality: \(label)"
    }

    /// Retained as the semantic warning text used by diagnostics and tests;
    /// tiles render the compact icon instead of placing this copy on the frame.
    var tileWarning: String? {
        switch self {
        case .poor: String(localized: "Weak connection")
        case .lost: String(localized: "Connection lost")
        case .excellent, .good, .unknown: nil
        }
    }

}

struct MeetingParticipantQuality: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let isLocal: Bool
    let quality: MeetingConnectionQuality
    /// Which app they are on, from the metadata the Worker stamped at mint.
    /// Nil for a token that predates the field.
    var client: GuestClient? = nil
    var isOwner = false
    /// This device hosts the meeting (`HostAttribute`).
    var isHost = false
    var recording = false
    var onBehalfOf: String? = nil
    /// Let in by an event registration link (docs/SESSIONS.md §7).
    var registered = false

    var menuTitle: String {
        isHost
            ? String(localized: "\(name) · Host · \(quality.label)")
            : "\(name) · \(quality.label)"
    }
}

/// The payload posted to `POST /api/rooms/:slug/meetings/:id/quality` is the
/// generated `MeetingQualityReport`. Counters are cumulative for the whole
/// meeting so a replayed flush is a no-op rather than double counting.

/// Time-weighted accumulator for the local participant's own connection
/// quality. Holds no audio, video, transcript, or network identifiers.
@MainActor
final class MeetingQualityTracker {
    private var startedAt: Date?
    private var current: MeetingConnectionQuality = .unknown
    private var currentSince: Date?
    private var totals: [MeetingConnectionQuality: TimeInterval] = [:]
    private var reconnectCount = 0
    private var worst: MeetingConnectionQuality?

    func start(at now: Date = Date()) {
        startedAt = now
        current = .unknown
        currentSince = now
        totals = [:]
        reconnectCount = 0
        worst = nil
    }

    func record(quality: MeetingConnectionQuality, at now: Date = Date()) {
        guard startedAt != nil else { return }
        accumulate(until: now)
        current = quality
        if let severity = quality.severity, severity < (worst?.severity ?? Int.max) {
            worst = quality
        }
    }

    func recordReconnect() {
        guard startedAt != nil else { return }
        reconnectCount += 1
    }

    func stop(at now: Date = Date()) {
        guard startedAt != nil else { return }
        accumulate(until: now)
    }

    func reset() {
        startedAt = nil
        currentSince = nil
        totals = [:]
        reconnectCount = 0
        worst = nil
        current = .unknown
    }

    /// Snapshot without ending the meeting, so a periodic flush and the final
    /// flush produce the same shape.
    func report(client: PeerClientValue, at now: Date = Date()) -> MeetingQualityReport? {
        guard let startedAt else { return nil }
        accumulate(until: now)
        return MeetingQualityReport(
            client: client,
            connectedMs: milliseconds(now.timeIntervalSince(startedAt)),
            excellentMs: milliseconds(totals[.excellent] ?? 0),
            goodMs: milliseconds(totals[.good] ?? 0),
            poorMs: milliseconds(totals[.poor] ?? 0),
            lostMs: milliseconds(totals[.lost] ?? 0),
            reconnectCount: reconnectCount,
            worstQuality: ConnectionQualityValue(rawValue: (worst ?? .unknown).rawValue)
        )
    }

    private func accumulate(until now: Date) {
        guard let since = currentSince else { return }
        totals[current, default: 0] += max(0, now.timeIntervalSince(since))
        currentSince = now
    }

    private func milliseconds(_ interval: TimeInterval) -> Int {
        Int((max(0, interval) * 1_000).rounded())
    }
}
