import AVFoundation
import Foundation
import StarlingsContracts

struct MediaDevice: Hashable, Sendable {
    enum Kind: Sendable {
        case camera
        case microphone
        case speaker
    }

    let id: String
    let name: String
    let kind: Kind
}

enum PermissionState: Equatable, Sendable {
    case unknown
    case allowed
    case denied
    case restricted

    init(_ status: AVAuthorizationStatus) {
        switch status {
        case .notDetermined: self = .unknown
        case .authorized: self = .allowed
        case .denied: self = .denied
        case .restricted: self = .restricted
        @unknown default: self = .restricted
        }
    }

    var title: String {
        switch self {
        case .unknown: String(localized: "Not checked")
        case .allowed: String(localized: "Ready")
        case .denied: String(localized: "Permission denied")
        case .restricted: String(localized: "Unavailable")
        }
    }
}

struct HostIdentity: Equatable, Sendable {
    let name: String
    let email: String

    var isValid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && EnvisioningIdentity.isIdentityAddress(email)
    }
}

struct MeetingIdentity: Equatable, Sendable {
    let name: String
    let email: String

    var isValidGuest: Bool {
        // Email is required for every guest (product decision 2026-08-09) —
        // the control plane's joinRequestSchema enforces the same rule.
        let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedEmail = email.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        return !normalizedName.isEmpty
            && normalizedEmail.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) != nil
    }

    var hostIdentity: HostIdentity {
        HostIdentity(name: name, email: email)
    }
}

enum MeetingRole: String, Equatable, Sendable {
    case host
    case guest
}

struct RoomSlug: RawRepresentable, Equatable, Sendable {
    let rawValue: String

    init?(rawValue: String) {
        let normalized = rawValue
            .lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"[^a-z0-9-]"#, with: "-", options: .regularExpression)
            .replacingOccurrences(of: #"-+"#, with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))

        guard (2...40).contains(normalized.count) else { return nil }
        self.rawValue = normalized
    }

    var urlPath: String { "/room/\(rawValue)" }
}

/// Visitor input accepted by native Join: a bare slug, canonical room URL, or
/// short room URL. The booking token is carried into the same lobby request as
/// web/iOS; it never changes the permanent room identity.
struct GuestRoomEntry: Equatable, Sendable {
    let room: RoomSlug
    let bookingToken: String?

    init(room: RoomSlug, bookingToken: String? = nil) {
        self.room = room
        self.bookingToken = bookingToken
    }

    /// `workspace` is the one a link must belong to: the active one, unless a
    /// test names another.
    init?(input: String, workspace: StarlingsWorkspace = .active) {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // A link on another workspace's host is that workspace's room, not
        // a room here.
        guard StarlingsWorkspaceLink.isActive(trimmed, in: workspace) else { return nil }
        let components: [String]
        if let url = URL(string: trimmed), url.scheme != nil {
            components = url.pathComponents.filter { $0 != "/" }
        } else if trimmed.contains("/") {
            components = trimmed.split(separator: "/").map(String.init)
        } else {
            guard let room = RoomSlug(rawValue: trimmed) else { return nil }
            self.room = room
            bookingToken = nil
            return
        }

        let roomValue: String
        let tokenValue: String?
        // A pasted URL or path is a room only in its canonical /room form.
        // The short /<slug> form is not a room; only the bare slug above is.
        if let roomIndex = components.firstIndex(of: "room"), components.indices.contains(roomIndex + 1) {
            roomValue = components[roomIndex + 1]
            tokenValue = components.indices.contains(roomIndex + 2) ? components[roomIndex + 2] : nil
        } else {
            return nil
        }
        guard let room = RoomSlug(rawValue: roomValue) else { return nil }
        let token = tokenValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let token, !token.isEmpty,
           token.range(of: #"^[A-Za-z0-9_-]{8,128}$"#, options: .regularExpression) == nil {
            return nil
        }
        self.room = room
        bookingToken = token?.isEmpty == false ? token : nil
    }
}

enum MeetingPhase: Equatable, Sendable {
    case setup
    case connecting
    case connected
    case ended
    /// Carries the typed failure, not a pre-rendered string — the presentation
    /// layer decides the title, the recovery action, and whether it warrants a
    /// modal at all.
    case failed(StarlingsError)

    /// No call in flight. Setup, ended and failed are the same place to stand:
    /// the host is between meetings, so the launch surface owns the window.
    var isIdle: Bool {
        switch self {
        case .setup, .ended, .failed:
            return true
        case .connecting, .connected:
            return false
        }
    }
}

struct MeetingConfiguration: Equatable, Sendable {
    let identity: MeetingIdentity
    let role: MeetingRole
    let room: RoomSlug
    let cameraID: String
    let microphoneID: String
    /// Where the room is played. Nil means whatever the Mac is using, which is
    /// what every meeting did before Meet had a speaker of its own to pick.
    var speakerID: String? = nil
    var cameraEnabled: Bool = true
    var microphoneEnabled: Bool = true
    var bookingToken: String? = nil
    /// Somebody walked up to this desk: a colleague called and the owner said
    /// yes, rather than a meeting being started on purpose.
    ///
    /// The only thing it changes is transcription, which does not begin. A chat
    /// at a desk is not minuted, and starting local STT on "got a sec?" would
    /// file an artifact for a conversation nobody convened. Turning it on
    /// mid-call still works — this is the default, not a prohibition.
    /// See docs/SURFACES.md §Reaching a person.
    var isWalkUp: Bool = false
}

enum MeetingEntry: Equatable, Sendable {
    case host
    case admittedGuest(ConnectionDetails)
}
