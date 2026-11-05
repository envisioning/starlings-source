import Foundation
import StarlingsContracts

/// Which surface a guest is on, as the control plane received it. Coarse and
/// self-reported — enough for the host to read the room before admitting, not a
/// fingerprint, and nothing is authorized on the strength of it. The shape is
/// the generated `GuestClient`; its values are open, so a future client that
/// reports something this build has never heard of still shows up in the
/// lobby, with a badge that says what it said.
///
/// The same value follows a person into the room: the Worker stamps it into
/// their LiveKit participant metadata at mint (`participantMetadataSchema` in
/// `packages/contracts`), read-only after that, so the People list can say
/// which app each participant is on. Shared by the Mac and iOS clients.
extension GuestClient {
    /// Spoken label for the lobby's client marker and the People row.
    var badge: String {
        switch app {
        case .web: return "Web"
        case .mac: return "Mac app"
        case .ios: return "\(device == .tablet ? "iPad" : "iPhone") app"
        case .android: return "Android app"
        default: return app.rawValue
        }
    }

    /// SF Symbol for the lobby's client marker.
    var systemSymbolName: String {
        switch app {
        case .web: "globe"
        case .mac: "desktopcomputer"
        case .ios: device == .tablet ? "ipad" : "iphone"
        case .android: "candybarphone"
        default: "questionmark.circle"
        }
    }

    /// The client stamped into a LiveKit participant's metadata, or nil when
    /// the token predates the field or carries something this build cannot
    /// read. Tolerant for the same reason `MeetingHand.raisedAt` is: a missing
    /// badge is a missing badge, a throw inside a roster refresh is a broken
    /// meeting.
    static func fromParticipantMetadata(_ metadata: String?) -> GuestClient? {
        participantMetadata(metadata)?.client
    }

    static func isOwnerParticipant(_ metadata: String?) -> Bool {
        participantMetadata(metadata)?.owner == true
    }

    /// Let in by an event registration link, not by the host (docs/SESSIONS.md
    /// §7). The host's People list says "Registered".
    static func isRegisteredParticipant(_ metadata: String?) -> Bool {
        participantMetadata(metadata)?.registered == true
    }

    static func consentFromParticipantMetadata(_ metadata: String?) -> ParticipantConsentMetadata? {
        guard let value = participantMetadata(metadata), value.recording == true else { return nil }
        return ParticipantConsentMetadata(onBehalfOf: value.onBehalfOf)
    }

    private static func participantMetadata(_ metadata: String?) -> ParticipantMetadata? {
        guard let metadata, !metadata.isEmpty, let data = metadata.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(ParticipantMetadata.self, from: data)
    }
}

struct ParticipantConsentMetadata: Equatable, Sendable {
    let onBehalfOf: String?
}
