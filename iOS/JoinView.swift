import EnvisioningUI
import LiveKit
import SwiftUI

struct JoinView: View {
    @EnvironmentObject private var app: StarlingsAppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = JoinViewModel()
    @ScaledMetric(relativeTo: .largeTitle) private var endedGlyphSize: CGFloat = 48
    private let onClose: (() -> Void)?

    init(onClose: (() -> Void)? = nil) {
        self.onClose = onClose
    }

    var body: some View {
        NavigationStack {
            Group {
                switch model.surface {
                case .roomEntry: roomEntry
                case .prejoin: prejoin
                case .waitingRoom: waitingRoom
                case .meeting: MobileCallView(model: model)
                case .ended: ended
                }
            }
            // Home owns this room flow. "Join" is the mode name on the wire
            // and in docs/SURFACES.md, not a fifth member destination.
            .background(StarlingsMobileColors.canvas.ignoresSafeArea())
            // The host asked this member to host. Yes leaves the
            // call as a guest; Home opens the room again as its host.
            .alert(
                String(localized: "\(model.hostOfferFrom ?? String(localized: "Someone")) asked you to host."),
                isPresented: Binding(
                    get: { model.hostOfferFrom != nil },
                    set: { if !$0 { model.hostOfferFrom = nil } }
                )
            ) {
                Button("Take host") {
                    Task {
                        guard let room = await model.answerHostOffer(accept: true, credentials: app.ownerCredentials) else { return }
                        app.pendingColleagueHostRoom = room
                        closeFlow()
                    }
                }
                Button("Not now", role: .cancel) {
                    Task { _ = await model.answerHostOffer(accept: false, credentials: app.ownerCredentials) }
                }
            }
            .navigationTitle(model.surface == .meeting ? "" : String(localized: "Join"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if model.surface != .meeting {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { closeFlow() }
                    }
                }
            }
            // In: success. Every other step is just a screen.
            .meetHaptic(trigger: model.surface) { _, surface in
                surface == .meeting ? .success : nil
            }
            // Out: the summary says whether the room closed, the line dropped,
            // or this phone left on its own — only the first two are felt.
            // Here rather than on the call view, which is gone by then.
            .meetHaptic(trigger: model.endedSummary) { _, summary in
                guard let summary, summary.reason != nil else { return nil }
                return summary.isFailure ? .error : .warning
            }
            .meetHaptic(.error, whenSet: model.errorMessage)
        }
        .onChange(of: app.pendingJoinInput) { _, input in
            guard let input else { return }
            model.apply(input: input)
            app.pendingJoinInput = nil
        }
        .onChange(of: app.pendingGuestIdentity) { _, identity in
            guard let identity else { return }
            model.apply(identity: identity)
            app.pendingGuestIdentity = nil
        }
        .onChange(of: model.roomInput) { _, _ in
            model.roomInputChanged(api: app.api, member: app.ownerCredentials)
        }
        .task(id: app.pendingCallRoom) {
            guard let slug = app.pendingCallRoom, let owner = app.ownerCredentials?.owner else { return }
            model.apply(input: slug)
            model.apply(identity: MobileGuestIdentity(name: owner.name, email: owner.email))
            await model.continueToPrejoin()
            model.askToJoin(api: app.api, member: app.ownerCredentials)
            app.pendingCallRoom = nil
        }
        .task {
            if let input = app.pendingJoinInput {
                model.apply(input: input)
                app.pendingJoinInput = nil
            }
            if let identity = app.pendingGuestIdentity {
                model.apply(identity: identity)
                app.pendingGuestIdentity = nil
            }
            model.roomInputChanged(api: app.api, member: app.ownerCredentials)
        }
        .meetErrorAlert("Couldn’t continue", message: $model.errorMessage)
    }

    private var roomEntry: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Join a room")
                        .font(.largeTitle.bold())
                    Text(model.ownerName.map { "Join \($0)’s room." }
                        ?? String(localized: "Paste a Starlings link or enter the room name."))
                        .foregroundStyle(.secondary)
                }

                VStack(spacing: 12) {
                    TextField("Room name or link", text: $model.roomInput)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .meetField()
                    if model.isInternalRoom, let identity = model.internalIdentity {
                        StarlingsCard {
                            Label(
                                "Signed in as \(identity.name)",
                                systemImage: "person.crop.circle.badge.checkmark"
                            )
                            .foregroundStyle(.secondary)
                        }
                    } else {
                        TextField("Your name", text: $model.name)
                            .textContentType(.name)
                            .textInputAutocapitalization(.words)
                            .meetField()
                        TextField("you@example.com", text: $model.email)
                            .keyboardType(.emailAddress)
                            .textContentType(.emailAddress)
                            .meetField()
                    }
                }

                roomContext

                Button {
                    // A link for another workspace opens there, not here.
                    guard StarlingsWorkspaceLink.isActive(model.roomInput) else {
                        app.open(link: model.roomInput)
                        return
                    }
                    Task { await model.continueToPrejoin() }
                } label: {
                    Label("Continue", systemImage: "arrow.right")
                }
                .buttonStyle(StarlingsFilledButtonStyle())
            }
            .padding(20)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder
    private var roomContext: some View {
        if model.isLoadingRoomContext, model.parsedRoomInput?.bookingToken != nil {
            HStack(spacing: 10) {
                GatheringDotsView(side: 20, ink: StarlingsMobileColors.secondary, motion: .murmuration)
                Text("Loading invite…").foregroundStyle(.secondary)
            }
        } else if let card = model.bookingCard {
            StarlingsCard {
                switch card {
                case .expired:
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Invite expired").font(.headline)
                        Text("You can still ask to join this room.")
                            .foregroundStyle(.secondary)
                    }
                case let .scheduled(title, subject, startsAt, endsAt):
                    VStack(alignment: .leading, spacing: 7) {
                        if let title { Text(title).font(.headline) }
                        if let startsAt {
                            Text(inviteRange(start: startsAt, end: endsAt))
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(.primary)
                        }
                        if let subject {
                            Text(subject)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .lineLimit(3)
                        }
                    }
                }
            }
        }
    }

    private func inviteRange(start: Date, end: Date?) -> String {
        let day = start.formatted(.dateTime.weekday(.wide).month(.wide).day())
        let startTime = start.meetTimeString()
        guard let end else { return "\(day) · \(startTime)" }
        return String(localized: "\(day) · \(startTime)–\(end.meetTimeString())")
    }

    private var prejoin: some View {
        ScrollView {
            VStack(spacing: 18) {
                Text("Before you join")
                    .font(.largeTitle.bold())
                    .frame(maxWidth: .infinity, alignment: .leading)

                ZStack {
                    Color.clear
                    if let track = model.session.previewTrack {
                        SwiftUIVideoView(track, layoutMode: .fill, mirrorMode: .mirror)
                            .meetConcentricClip(fallbackRadius: EnvisioningRadius.card)
                    } else {
                        GatheringDotsView(side: 128, ink: StarlingsMobileColors.secondary, motion: .drift, label: Text("Camera off"))
                    }
                }
                .meetContainerShape(cornerRadius: EnvisioningRadius.card)
                .meetConcentricBackground(
                    StarlingsMobileColors.elevated,
                    fallbackRadius: EnvisioningRadius.card
                )
                .aspectRatio(16 / 10, contentMode: .fit)

                HStack(spacing: 12) {
                    mediaButton(
                        title: model.session.microphoneEnabled ? String(localized: "Mute") : String(localized: "Unmute"),
                        symbol: model.session.microphoneEnabled ? "mic.fill" : "mic.slash.fill"
                    ) { await model.session.toggleMicrophone() }
                        .overlay(alignment: .topTrailing) {
                            MobileDeviceChooser(label: "Choose microphone") {
                                MobileMicrophoneMenu(inputs: model.session.audioInputs)
                            }
                        }
                    mediaButton(
                        title: model.session.cameraEnabled ? String(localized: "Camera off") : String(localized: "Camera on"),
                        symbol: model.session.cameraEnabled ? "video.fill" : "video.slash.fill"
                    ) { await model.session.toggleCamera() }
                        .overlay(alignment: .topTrailing) {
                            MobileDeviceChooser(label: "Choose camera") {
                                MobileCameraMenu(session: model.session)
                            }
                        }
                    mediaButton(title: String(localized: "Flip"), symbol: "camera.rotate.fill") {
                        await model.session.switchCamera()
                    }
                }

                Button {
                    model.askToJoin(api: app.api, member: app.ownerCredentials)
                } label: {
                    Label("Ask to join", systemImage: "video.fill")
                }
                .buttonStyle(StarlingsFilledButtonStyle())

                Button("Back") {
                    Task {
                        await model.session.stopPreview()
                        model.surface = .roomEntry
                    }
                }
                .foregroundStyle(.secondary)
            }
            .padding(20)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
    }

    private var waitingRoom: some View {
        VStack(spacing: 22) {
            Spacer()
            // The same murmuring flock the web waiting card shows, in the
            // same 96pt box around the 64pt flock.
            GatheringDotsView(side: 64, ink: StarlingsMobileColors.secondary, motion: .murmuration)
                .frame(width: 96, height: 96)
            Text("Waiting room")
                .font(.largeTitle.bold())
            Text(model.status)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button("Cancel request") { model.cancelWaiting() }
                .buttonStyle(StarlingsBorderedButtonStyle())
                .frame(maxWidth: 320)
            Spacer()
        }
        .padding(24)
    }

    /// A meeting can close on this phone three ways: this guest left, the room
    /// ended the seat (the host ended the meeting, or removed this guest), or
    /// the connection died for good. The first needs no explanation, the second
    /// reads as an ending with a reason, the third as a failure.
    private var ended: some View {
        let failed = model.endedSummary?.isFailure == true
        return VStack(spacing: 18) {
            Spacer()
            Image(systemName: failed ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .font(.system(size: endedGlyphSize))
                .foregroundStyle(.secondary)
            Text(failed ? String(localized: "Disconnected") : String(localized: "The meeting ended"))
                .font(.largeTitle.bold())
                .multilineTextAlignment(.center)
            if let reason = model.endedSummary?.reason {
                Text(reason)
                    .font(.headline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            if let summary = model.endedSummary {
                VStack(spacing: 7) {
                    if let duration = summary.duration {
                        Text("Lasted \(durationLabel(duration))")
                    }
                    Text("Room · \(summary.roomSlug)")
                    if !failed {
                        Text("Transcript · your host keeps it")
                    }
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
            Button("Back to this room") {
                Task {
                    await model.backToRoom()
                    model.roomInputChanged(api: app.api, member: app.ownerCredentials)
                }
            }
            .buttonStyle(StarlingsFilledButtonStyle())
            .frame(maxWidth: 360)
            Button("Join another room") {
                Task { await model.startAnother() }
            }
            .buttonStyle(StarlingsBorderedButtonStyle())
            .frame(maxWidth: 360)
            Spacer()
        }
        .padding(24)
    }

    private func durationLabel(_ duration: TimeInterval) -> String {
        let total = max(0, Int(duration.rounded()))
        let minutes = total / 60
        let seconds = total % 60
        return minutes > 0 ? String(localized: "\(minutes)m \(seconds)s") : String(localized: "\(seconds)s")
    }

    private func closeFlow() {
        Task {
            await model.close()
            app.pendingJoinInput = nil
            app.pendingCallRoom = nil
            app.pendingGuestIdentity = nil
            onClose?()
            dismiss()
        }
    }

    private func mediaButton(
        title: String,
        symbol: String,
        action: @escaping @MainActor () async -> Void
    ) -> some View {
        Button {
            Task { await action() }
        } label: {
            VStack(spacing: 6) {
                Image(systemName: symbol).font(.title3)
                Text(title).font(.caption.weight(.semibold))
            }
            .frame(maxWidth: .infinity, minHeight: 62)
        }
        .buttonStyle(.plain) // hover: meetHoverLift on the shell below
        .meetContainerShape(cornerRadius: EnvisioningRadius.control)
        .meetConcentricBackground(
            StarlingsMobileColors.elevated,
            fallbackRadius: EnvisioningRadius.control
        )
        // The hairline, brightening under the pointer with the veil.
        .meetHoverLift(cornerRadius: EnvisioningRadius.control, border: true)
    }
}
