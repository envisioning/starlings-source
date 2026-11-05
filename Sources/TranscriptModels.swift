import Foundation

/// The languages the recognizer speaks, named for reading; the raw values
/// are the contract's (`transcriptLanguageSchema`), and `TranscriptSegment`
/// crosses to the generated value by them.
enum TranscriptLanguage: String, Codable, Equatable, Sendable {
    case english = "en"
    case portuguese = "pt"
    case german = "de"
    case undetermined = "und"
}

/// A settled line of transcript as the app holds it: the id as a UUID, the
/// language as the closed list the recognizer speaks. The wire is the
/// generated `StarlingsContracts.TranscriptSegment`; `wire` and `init(wire:)` are
/// the two ways across, and Codable here follows them so the outbox on disk
/// and the captions topic carry the same bytes the Worker reads.
struct TranscriptSegment: Codable, Equatable, Identifiable, Sendable {
    let id: UUID
    let meetingID: String
    let speakerID: String
    let speakerName: String
    let language: TranscriptLanguage
    let startsAtMilliseconds: Int64
    let endsAtMilliseconds: Int64
    let text: String
    let isFinal: Bool

    init(id: UUID, meetingID: String, speakerID: String, speakerName: String, language: TranscriptLanguage, startsAtMilliseconds: Int64, endsAtMilliseconds: Int64, text: String, isFinal: Bool) {
        self.id = id
        self.meetingID = meetingID
        self.speakerID = speakerID
        self.speakerName = speakerName
        self.language = language
        self.startsAtMilliseconds = startsAtMilliseconds
        self.endsAtMilliseconds = endsAtMilliseconds
        self.text = text
        self.isFinal = isFinal
    }

    /// Nil for a segment whose id is not a UUID or whose language this build
    /// does not speak; a caption it cannot place is not drawn.
    init?(wire: StarlingsContracts.TranscriptSegment) {
        guard let id = UUID(uuidString: wire.id), let language = TranscriptLanguage(rawValue: wire.language.rawValue) else { return nil }
        self.init(
            id: id, meetingID: wire.meetingID, speakerID: wire.speakerID, speakerName: wire.speakerName,
            language: language, startsAtMilliseconds: Int64(wire.startsAtMs), endsAtMilliseconds: Int64(wire.endsAtMs),
            text: wire.text, isFinal: wire.isFinal
        )
    }

    var wire: StarlingsContracts.TranscriptSegment {
        StarlingsContracts.TranscriptSegment(
            id: id.uuidString.lowercased(), meetingID: meetingID, speakerID: speakerID, speakerName: speakerName,
            language: .init(rawValue: language.rawValue), startsAtMs: Int(startsAtMilliseconds), endsAtMs: Int(endsAtMilliseconds),
            text: text, isFinal: isFinal
        )
    }

    init(from decoder: Decoder) throws {
        let wire = try StarlingsContracts.TranscriptSegment(from: decoder)
        guard let segment = TranscriptSegment(wire: wire) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "transcript: a segment this build cannot place (\(wire.id), \(wire.language))"))
        }
        self = segment
    }

    func encode(to encoder: Encoder) throws {
        try wire.encode(to: encoder)
    }
}

/// One packet on the captions topic: the generated `CaptionMessageWire`,
/// carrying the app's segment.
struct CaptionMessage: Codable, Equatable, Sendable {
    static let topic = ContractConstants.captionDataTopic
    /// How many live transcript lines a meeting view keeps, on every surface
    ///. A view, never the record.
    static let historyLineLimit = ContractConstants.liveTranscriptHistoryLines

    let version: Int
    let segment: TranscriptSegment

    init(segment: TranscriptSegment) {
        version = 1
        self.segment = segment
    }

    init(from decoder: Decoder) throws {
        let wire = try CaptionMessageWire(from: decoder)
        guard let segment = TranscriptSegment(wire: wire.segment) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "captions: a segment this build cannot place"))
        }
        version = wire.version
        self.segment = segment
    }

    func encode(to encoder: Encoder) throws {
        try CaptionMessageWire(version: version, segment: segment.wire).encode(to: encoder)
    }

    static func acceptsPublisherIdentity(_ identity: String?) -> Bool {
        guard let identity else { return false }
        let normalized = identity.lowercased()
        return EnvisioningIdentity.isIdentityAddress(normalized) && !normalized.hasPrefix("guest:")
    }
}

/// Host moderation, addressed to one participant: the app's form of
/// `moderationMessageSchema` in `packages/contracts`.
///
/// Unlike captions this is published by the control plane rather than by a
/// participant, which is also how it is authenticated: the packet arrives with
/// no sender, because only the Worker can prove who the verified owner is. A
/// participant forging the topic arrives *with* a sender and is ignored.
struct ModerationMessage: Codable, Equatable, Sendable {
    static let topic = ContractConstants.moderationDataTopic
    static let screenShareStopped = ContractConstants.moderationScreenShareStopped
    static let audioMuted = ContractConstants.moderationAudioMuted
    static let participantRemoved = ContractConstants.moderationParticipantRemoved

    let version: Int
    let type: String
    /// Display name of the owner who acted, for the notice shown to the target.
    let by: String
}

protocol LocalTranscriptionSession: Sendable {
    var events: AsyncStream<TranscriptSegment> { get }
    func finish() async
    func cancel() async
}
