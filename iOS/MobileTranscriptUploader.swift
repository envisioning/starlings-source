import Foundation

/// What the shared artifact outbox talks to on the phone.
///
/// The Mac's `MeetingControlAPI` holds its owner session, so it conforms to
/// `TranscriptUploading` directly. `StarlingsAPI` is a stateless struct that takes
/// credentials per call, so the credentials are bound here instead — one value
/// per hosted meeting, handed to the outbox when hosting starts.
struct MobileTranscriptUploader: TranscriptUploading {
    let api: StarlingsAPI
    let credentials: MobileOwnerCredentials

    func appendTranscript(room: String, meetingID: String, segments: [TranscriptSegment]) async throws {
        try await api.appendTranscript(
            credentials: credentials,
            room: room,
            meetingID: meetingID,
            segments: segments
        )
    }

    func finalizeMeeting(room: String, meetingID: String) async throws {
        try await api.finalizeHostedMeeting(credentials: credentials, room: room, meetingID: meetingID)
    }
}
