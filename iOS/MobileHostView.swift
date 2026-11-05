import SwiftUI
import EnvisioningUI
import StarlingsContracts

/// Hosting your own room from the phone.
///
/// The Mac has always been the host surface, and the control plane never
/// required that — the room, the lease, and admission all key on the Google
/// `sub` this owner already proves. What the phone owes the room is the same
/// two duties the Mac performs: renew the lease, and answer the door.
///
/// Captions and the artifact come from whichever device holds the host — this
/// phone included, when it hosts and no companion Mac is present
/// (docs/IOS_HOST.md).
struct MobileHostView: View {
    @EnvironmentObject private var app: StarlingsAppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var host: MobileRoomHost
    @StateObject private var lobby: MobileLobbyWatch
    @State private var showsWaitingRoom = false

    /// `filing` is the subject this room is about when it was started from
    /// Work; nil from Home, where the meeting is filed by hand. `room` names a
    /// room other than the owner's own — the internal room, from Team.
    init(
        api: StarlingsAPI,
        outbox: MeetingArtifactOutbox,
        filing: CrmSubject? = nil,
        isWalkUp: Bool = false,
        room: String? = nil,
        claimsHostOnJoin: Bool = false
    ) {
        let host = MobileRoomHost(api: api, outbox: outbox)
        host.filing = filing
        host.isWalkUp = isWalkUp
        host.requestedRoom = room
        host.claimsHostOnJoin = claimsHostOnJoin
        _host = StateObject(wrappedValue: host)
        _lobby = StateObject(wrappedValue: MobileLobbyWatch(api: api))
    }

    var body: some View {
        // A ZStack, not a Group: a Group hands the background below to each
        // child, so the starting and ending spinners got a canvas-coloured box
        // the size of themselves over the cover's system background.
        ZStack {
            switch host.phase {
            case .idle, .starting:
                starting
            case .hosting:
                MobileCallView(host: host, lobby: lobby, showsWaitingRoom: $showsWaitingRoom)
            case .ending:
                ProgressView("Ending the meeting…")
            case .ended:
                // Nothing left to show and nothing to wait for: the artifact
                // finishes uploading on its own.
                Color.clear
            case .failed(let message):
                failed(message)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(StarlingsMobileColors.canvas.ignoresSafeArea())
        .sheet(isPresented: $showsWaitingRoom) {
            MobileWaitingRoomView(lobby: lobby)
        }
        .task {
            guard let credentials = app.ownerCredentials else { return }
            await host.start(credentials: credentials)
            guard let room = host.room else { return }
            lobby.onMeeting = { [weak host] meeting in await host?.reconcile(meeting) }
            lobby.start(credentials: credentials, room: room)
        }
        // Hosting is a success the moment the room opens; a room that would not
        // open is the one failure this screen shows, so it is the one it buzzes.
        .meetHaptic(trigger: host.phase) { _, phase in
            switch phase {
            case .hosting: .success
            case .failed: .error
            default: nil
            }
        }
        .onChange(of: host.phase) { _, phase in
            // The waiting room is only a waiting room while somebody can be let
            // in. A sheet left open over an ended meeting offers a decision the
            // control plane would refuse.
            if phase != .hosting { showsWaitingRoom = false }
            // Ending is the end of this screen. Without this the cover stayed
            // up over a finished meeting, showing a spinner for a room that
            // was already closed.
            if phase == .ended { dismiss() }
        }
        .onDisappear {
            // Cleanup only — never `host.end()`. View teardown is not a
            // decision to close the room for everyone: this fires for any
            // reason the cover leaves the hierarchy, and ending belongs to the
            // End button (MobileCallView) alone. A host that vanishes without
            // ending lapses its lease within 30s, which is the designed
            // outcome for a crash and the right one here too.
            lobby.stop()
        }
    }

    private var starting: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Opening your room…").font(.subheadline).foregroundStyle(.secondary)
        }
    }

    private func failed(_ message: String) -> some View {
        StarlingsCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Couldn’t start your room").font(.headline)
                Text(message).font(.subheadline).foregroundStyle(.secondary)
                Button("Close") { dismiss() }
                    .buttonStyle(StarlingsBorderedButtonStyle())
            }
        }
        .padding(20)
    }
}

/// The door. One row per person, in the order they knocked.
///
/// Admit and decline are here rather than on the knock notification on purpose:
/// deciding from a banner means deciding without seeing who is asking, and this
/// is the one control in Meet that must not be answered blind.
struct MobileWaitingRoomView: View {
    @ObservedObject var lobby: MobileLobbyWatch
    @Environment(\.dismiss) private var dismiss
    @State private var haptic = StarlingsHapticPulse()
    @State private var recorderSenders: [String: String] = [:]

    var body: some View {
        NavigationStack {
            StarlingsList {
                if let unavailable = lobby.unavailable {
                    // Never show an empty queue for a queue that failed to
                    // load: "nobody is waiting" and "I couldn’t look" are
                    // different answers, and only one of them is safe to act on.
                    Section {
                        Text(unavailable).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                if lobby.sessionDoorOpen {
                    // An event session lets registration links in without a
                    // knock; the host can close that door (docs/SESSIONS.md §7).
                    Section {
                        Button("Make registered guests knock") {
                            Task { haptic.fire(await lobby.closeSessionDoor() ? .success : .error) }
                        }
                        .buttonStyle(StarlingsBorderedButtonStyle.compact)
                        .meetHoverLift(cornerRadius: EnvisioningRadius.control)
                        .disabled(lobby.closingSessionDoor)
                    }
                }
                if lobby.waiting.isEmpty && lobby.lurking.isEmpty && lobby.unavailable == nil {
                    Section {
                        Text("Nobody is waiting.").foregroundStyle(.secondary)
                    }
                }
                if !lobby.lurking.isEmpty {
                    Section("On the page") {
                        ForEach(lobby.lurking) { lurker in
                            lurkerRow(lurker)
                        }
                    }
                }
                if !lobby.waiting.isEmpty {
                    Section("Waiting to join") {
                        ForEach(lobby.waiting) { guest in
                            row(guest)
                        }
                    }
                }
            }
            .navigationTitle("Waiting room")
            .navigationBarTitleDisplayMode(.inline)
            .meetHaptics(haptic)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .meetToolbarConfirm()
                }
            }
        }
    }

    private func row(_ guest: LobbyRequestResponse) -> some View {
        let selectedSender = recorderSenders[guest.id] ?? guest.onBehalfOf
        let senderName = lobby.people.first(where: { $0.email.caseInsensitiveCompare(selectedSender ?? "") == .orderedSame })
            .map(displayName) ?? selectedSender
        return VStack(alignment: .leading, spacing: 8) {
            Text(guest.name).font(.headline)
            if !guest.email.isEmpty {
                Text(guest.email).font(.caption).foregroundStyle(.secondary)
            }
            if guest.recording == true {
                Label("Recording", systemImage: "record.circle.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(StarlingsMobileColors.danger)
                if let senderName {
                    Label("For \(senderName)", systemImage: "person.crop.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if !lobby.people.isEmpty {
                    Menu {
                        ForEach(lobby.people) { person in
                            Button(displayName(person)) {
                                recorderSenders[guest.id] = person.email
                            }
                        }
                    } label: {
                        Label("Choose who sent this notetaker", systemImage: "person.crop.circle.badge.questionmark")
                    }
                    .accessibilityHint("Choose a person from the team roster before admitting this notetaker.")
                }
            }
            HStack(spacing: 10) {
                // The row leaves either way, so the hand is told which way.
                Button("Admit") {
                    Task { haptic.fire(await lobby.admit(guest, onBehalfOf: recorderSenders[guest.id]) ? .success : .error) }
                }
                .buttonStyle(StarlingsFilledButtonStyle())
                .disabled(guest.recording == true && selectedSender == nil)
                Button("Decline") {
                    Task { haptic.fire(await lobby.decline(guest) ? .destructive : .error) }
                }
                .buttonStyle(StarlingsBorderedButtonStyle())
            }
            .disabled(lobby.deciding.contains(guest.id))
        }
        .padding(.vertical, 6)
    }

    private func lurkerRow(_ lurker: GuestPresenceRow) -> some View {
        HStack(alignment: .top, spacing: 8) {
            StarlingsCountryFlagView(country: lurker.country)
            VStack(alignment: .leading, spacing: 3) {
                Text(lurker.displayName).font(.headline)
                if let location = lurker.location {
                    Text(location).font(.caption).foregroundStyle(.secondary)
                }
                Text("On the join page").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private func displayName(_ person: Peer) -> String {
        let name = person.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        return name?.isEmpty == false ? name! : person.email
    }
}
