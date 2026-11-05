import Foundation
import LiveKit
import StarlingsContracts

/// Cumulative bytes received by one native client in one UTC month.
///
/// The server stores only the session id, month, byte count and report time.
/// RTP counters do not include every provider-side transfer cost, so this is
/// an estimate rather than a billing value.
@MainActor
final class MeetingDownstreamUsageMeter {
    private var reporterID = UUID().uuidString.lowercased()
    private var monthStart = MeetingDownstreamUsageMeter.utcMonthStart(Date())
    private var receivedBytes: UInt64 = 0
    private var bytesByTrack: [String: UInt64] = [:]

    func start() {
        reporterID = UUID().uuidString.lowercased()
        monthStart = Self.utcMonthStart(Date())
        receivedBytes = 0
        bytesByTrack = [:]
    }

    func report(room: Room) -> DownstreamUsageReport {
        let currentMonthStart = Self.utcMonthStart(Date())
        if currentMonthStart != monthStart {
            monthStart = currentMonthStart
            receivedBytes = 0
        }

        for participant in room.remoteParticipants.values {
            for publication in participant.trackPublications.values {
                guard publication.isSubscribed,
                      let track = publication.track,
                      let statistics = track.statistics else { continue }
                let bytes = statistics.inboundRtpStream.reduce(UInt64(0)) {
                    $0 &+ ($1.bytesReceived ?? 0)
                }
                let key = publication.sid.stringValue
                let previous = bytesByTrack[key]
                let delta = previous.map { bytes >= $0 ? bytes - $0 : bytes } ?? bytes
                bytesByTrack[key] = bytes
                receivedBytes = min(receivedBytes &+ delta, 5_000_000_000_000)
            }
        }

        return DownstreamUsageReport(
            reporterID: reporterID,
            monthStart: Int(monthStart.timeIntervalSince1970 * 1_000),
            receivedBytes: Int(receivedBytes)
        )
    }

    private static func utcMonthStart(_ date: Date) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let components = calendar.dateComponents([.year, .month], from: date)
        return calendar.date(from: DateComponents(year: components.year, month: components.month, day: 1)) ?? date
    }
}
