import LiveKit
import StarlingsContracts
import EnvisioningUI
import SwiftUI

/// One row of the participants panel: who is here, how well they are
/// connected, and whether they are sharing.
struct MobileParticipantQuality: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let isLocal: Bool
    let quality: ConnectionQuality
    let isSharingScreen: Bool
    /// Which app they are on, from the metadata the Worker stamped at mint.
    /// Nil for a token that predates the field.
    var client: GuestClient? = nil
    var recording = false
    var onBehalfOf: String? = nil
    /// Let in by an event registration link (docs/SESSIONS.md §7).
    var registered = false

    var qualityLabel: String {
        MeetingConnectionQuality(quality).label
    }

    var qualityColor: Color {
        MeetingConnectionQuality(quality).isWeak ? StarlingsMobileColors.danger : .secondary
    }
}

/// Who is in the room, how their connection is holding up, and — for a host —
/// the one moderation control Meet has.
///
/// Stopping a share stops what is on screen now; it does not revoke the right
/// to share, so somebody stopped mid-mistake can share again deliberately. The
/// Worker re-checks room ownership and the host lease before it touches the
/// SFU, so this button is a request, not an authority.
struct MobileParticipantsSheet: View {
    @ObservedObject var session: MobileGuestSession
    /// Nil when joining rather than hosting: a guest sees the roster and the
    /// connection quality, and no moderation at all.
    var host: MobileRoomHost?
    var credentials: MobileOwnerCredentials?
    let api: StarlingsAPI
    @Environment(\.dismiss) private var dismiss
    @State private var stopping: Set<String> = []
    @State private var failure: String?
    /// What the last mute did, so a mute that closed nothing still answers.
    @State private var muteOutcome: String?
    @State private var removing: MobileParticipantQuality?
    @State private var isModerating = false
    @State private var haptic = StarlingsHapticPulse()

    var body: some View {
        NavigationStack {
            StarlingsList {
                if session.isReconnecting {
                    Section {
                        Label("Reconnecting…", systemImage: "arrow.triangle.2.circlepath")
                            .foregroundStyle(.secondary)
                    } footer: {
                        Text("Media resumes when the network returns.")
                    }
                }
                if let failure {
                    Section { StarlingsErrorNotice(message: failure, font: .body) }
                } else if let muteOutcome {
                    Section {
                        Label(muteOutcome, systemImage: "mic.slash")
                            .foregroundStyle(.secondary)
                    }
                }
                if host != nil && credentials != nil {
                    Section {
                        Button("Mute everyone else") { Task { await moderate(nil) } }
                            .disabled(isModerating)
                            .meetHoverLift(cornerRadius: EnvisioningRadius.control)
                    } footer: {
                        Text("Each person chooses when to unmute their microphone.")
                    }
                }
                Section("In the room") {
                    ForEach(session.quality) { participant in
                        row(participant)
                    }
                }
            }
            .confirmationDialog("Remove \(removing?.name ?? String(localized: "this person")) from the meeting?", isPresented: Binding(
                get: { removing != nil }, set: { if !$0 { removing = nil } }
            ), titleVisibility: .visible) {
                if let participant = removing {
                    Button("Remove", role: .destructive) { Task { await moderate(participant, remove: true) } }
                }
                Button("Cancel", role: .cancel) { removing = nil }
            } message: {
                Text("They will be disconnected and must ask to join again.")
            }
            .navigationTitle("People")
            .navigationBarTitleDisplayMode(.inline)
            .meetHaptics(haptic)
            .meetHaptic(.error, whenSet: failure)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .meetToolbarConfirm()
                }
            }
        }
    }

    private func row(_ participant: MobileParticipantQuality) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(participant.name)
                Spacer()
                Text(participant.qualityLabel)
                    .font(.caption)
                    .foregroundStyle(participant.qualityColor)
            }
            // Which app they are on. The lobby already shows this before
            // admission; a host asking "why is their audio odd" wants it after.
            if let client = participant.client {
                Label(client.badge, systemImage: client.systemSymbolName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            // The queue, oldest raise first, as the Mac's PEOPLE rows number it.
            if let place = handPlace(participant) {
                Label(
                    place == 1 ? String(localized: "Hand raised") : String(localized: "Hand raised, number \(place)"),
                    systemImage: "hand.raised.fill"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            if participant.registered {
                Label("Registered", systemImage: "ticket")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if participant.recording {
                Label("Recording notetaker", systemImage: "record.circle.fill")
                    .font(.caption)
                    .foregroundStyle(StarlingsMobileColors.danger)
                if let onBehalfOf = participant.onBehalfOf {
                    Text("Sent by \(onBehalfOf)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if canModerate(participant) {
                HStack {
                    Button("Mute") { Task { await moderate(participant) } }
                        .meetHoverLift(cornerRadius: EnvisioningRadius.control)
                    Button("Remove…", role: .destructive) { removing = participant }
                        .meetHoverLift(cornerRadius: EnvisioningRadius.control)
                }
                .buttonStyle(StarlingsBorderedButtonStyle.compact)
                .disabled(isModerating)
            }
            if participant.isSharingScreen {
                HStack {
                    Label("Sharing a screen", systemImage: "rectangle.on.rectangle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    if canModerate(participant) {
                        Button("Stop share") {
                            Task { await stopShare(participant) }
                        }
                        .buttonStyle(StarlingsBorderedButtonStyle.compact)
                        .disabled(stopping.contains(participant.id))
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }

    /// Where this person stands in the raised-hand queue, from 1; nil with no hand up.
    /// Asked of the queue, not compared by id: your own row carries a local id.
    private func handPlace(_ participant: MobileParticipantQuality) -> Int? {
        session.raisedHands.firstIndex { $0.identity == participant.id || ($0.isLocal && participant.isLocal) }.map { $0 + 1 }
    }

    /// A host can stop somebody else's share, never their own — stopping your
    /// own share is a control on the stage, not a moderation action.
    private func canModerate(_ participant: MobileParticipantQuality) -> Bool {
        host != nil && credentials != nil && !participant.isLocal
    }

    private func moderate(_ participant: MobileParticipantQuality?, remove: Bool = false) async {
        guard !isModerating, let credentials, let room = host?.room,
              let meetingID = host?.meetingID else { return }
        isModerating = true
        defer { isModerating = false }
        do {
            let muted = try await api.moderateParticipant(credentials: credentials, room: room,
                meetingID: meetingID, identity: participant?.id, remove: remove)
            failure = nil
            muteOutcome = muted.map { StarlingsRoomRoutes.muteOutcome(muted: $0, everyone: participant == nil) }
            // Taking somebody out is the heavier act; a mute is a confirmation.
            haptic.fire(remove ? .destructive : .success)
        } catch { failure = error.localizedDescription }
    }

    private func stopShare(_ participant: MobileParticipantQuality) async {
        guard let credentials,
              let room = host?.room,
              let meetingID = host?.meetingID else { return }
        stopping.insert(participant.id)
        defer { stopping.remove(participant.id) }
        do {
            try await api.stopScreenShare(
                credentials: credentials,
                room: room,
                meetingID: meetingID,
                identity: participant.id
            )
            failure = nil
            haptic.fire(.destructive)
        } catch {
            failure = (error as? StarlingsError)?.message ?? error.localizedDescription
        }
    }
}
