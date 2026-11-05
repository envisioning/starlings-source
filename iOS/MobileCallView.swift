import EnvisioningUI
import LiveKit
import SwiftUI
import UniformTypeIdentifiers

struct MobileCallView: View {
    /// What this device is doing in the room. Joining and hosting share the
    /// stage, the controls, and the pipeline; they differ in who they answer to
    /// on the way out and whether there is a door to watch.
    private enum Role {
        case guest(JoinViewModel)
        case host(MobileRoomHost, MobileLobbyWatch)
    }

    @ObservedObject private var session: MobileGuestSession
    @State private var showsChat = false
    /// Chat stays in the session for the life of the meeting. This is the
    /// quiet companion to that buffer: it tells somebody who was looking at
    /// the stage that there is something worth opening, without interrupting
    /// the call with a banner or notification.
    @State private var unreadChatCount = 0
    @State private var showsTranscript = false
    @State private var showsParticipants = false
    @State private var showsReactions = false
    @State private var showsFiling = false
    @State private var showsTasks = false
    @State private var showsBackgroundImporter = false
    /// Ending drops everyone else, so with anyone in the room it is asked
    /// first — the Mac's sheet, as a dialog. In a personal room that is the
    /// End button; on `/room/team` it is the host's second way out.
    @State private var confirmsEndForEveryone = false
    /// Read once and kept, so the menu does not hit the filesystem on every
    /// SwiftUI body evaluation.
    @State private var hasCustomBackground = CustomBackgroundStore.hasImage
    @State private var backgroundImageError: String?
    @AppStorage(StageGridLayout.ScreenShareLayoutPreferences.defaultsKey)
    private var screenShareLayoutRawValue = StageGridLayout.ScreenShareLayoutChoice.automatic.rawValue
    /// The measured height of `stageFoot`, so the grid stops above it.
    @State private var footHeight: CGFloat = 0
    private let role: Role
    private var waitingRoom: Binding<Bool>?

    init(model: JoinViewModel) {
        role = .guest(model)
        session = model.session
    }

    init(host: MobileRoomHost, lobby: MobileLobbyWatch, showsWaitingRoom: Binding<Bool>) {
        role = .host(host, lobby)
        session = host.media
        waitingRoom = showsWaitingRoom
    }

    private var host: MobileRoomHost? {
        if case .host(let host, _) = role { return host }
        return nil
    }

    /// `MeetingBackgroundEffect` carries an associated value, which a SwiftUI
    /// `Picker` tag cannot hash across cases on its own. This is the same set,
    /// flattened for selection, and it converts back on the way out.
    private enum MobileBackgroundChoice: Hashable {
        case none
        case blur
        case generated(BackgroundChoice)
        case customImage
        case workspaceImage

        var effect: MeetingBackgroundEffect {
            switch self {
            case .none: .none
            case .blur: .blur
            case .generated(let choice): .generated(choice)
            case .customImage: .customImage
            case .workspaceImage: .workspaceImage
            }
        }

        init(_ effect: MeetingBackgroundEffect) {
            switch effect {
            case .none: self = .none
            case .blur: self = .blur
            case .generated(let choice): self = .generated(choice)
            case .customImage: self = .customImage
            case .workspaceImage: self = .workspaceImage
            }
        }
    }

    private var backgroundSelection: Binding<MobileBackgroundChoice> {
        Binding(
            get: { MobileBackgroundChoice(session.backgroundEffect) },
            set: { session.setBackgroundEffect($0.effect) }
        )
    }

    private var screenShareLayoutChoice: StageGridLayout.ScreenShareLayoutChoice {
        StageGridLayout.ScreenShareLayoutChoice(rawValue: screenShareLayoutRawValue) ?? .automatic
    }

    private var screenShareLayoutSelection: Binding<StageGridLayout.ScreenShareLayoutChoice> {
        Binding(
            get: { screenShareLayoutChoice },
            set: { screenShareLayoutRawValue = $0.rawValue }
        )
    }

    private var lobby: MobileLobbyWatch? {
        if case .host(_, let lobby) = role { return lobby }
        return nil
    }

    /// Gap between peer tiles, and the inset's clearance from the top of the
    /// stage. Matches the Mac stage's `tileSpacing`.
    private let tileSpacing: CGFloat = 12

    var body: some View {
        VStack(spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(host == nil ? String(localized: "In meeting") : String(localized: "Hosting")).font(.headline)
                    Text("\(session.participantCount) participants")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let host, let lobby, let waitingRoom {
                    MobileHostChrome(host: host, lobby: lobby, showsWaitingRoom: waitingRoom)
                }
                SwiftUIAudioRoutePickerButton()
                    .frame(width: 42, height: 42)
                    .background(StarlingsMobileColors.elevated, in: Circle())
            }
            .padding(.horizontal, 14)

            if let host, host.notesAreOffForCall {
                HStack {
                    Text("Notes are off for this call.").font(.caption)
                    Button("Turn on notes") { host.enableCallNotes() }.meetHoverLift(cornerRadius: EnvisioningRadius.control)
                }
            }
            // Why the microphone button is off and will not turn on. Without
            // this the rule reads as a broken button.
            if session.isCompanion {
                Text("Your other device has the microphone in this meeting.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 14)
            }

            stage
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                // The Mac stage's ground: one rung up from the canvas, with
                // the grid on it, in a rounded panel. On the bare canvas the
                // grid read as noise on black and the tiles floated on nothing.
                .meetConcentricClip(fallbackRadius: EnvisioningRadius.card)
                .meetContainerShape(cornerRadius: EnvisioningRadius.card)
                .meetConcentricBackground(
                    StarlingsMobileColors.elevated,
                    fallbackRadius: EnvisioningRadius.card
                )
                // Over the stage and deaf to taps — a reaction must not be
                // able to swallow a press on Mute. It passes under the
                // controls' glass; the foot is drawn after it, so it is on top.
                .overlay {
                    MobileReactionOverlay(reactions: session.reactions) { id in
                        session.retireReaction(id)
                    }
                }
                // The controls float on the stage so the video passes under
                // their glass (docs/DESIGN.md, "Glass — the floating layer").
                // `stage` keeps its grid clear of them by `footHeight`.
                .overlay(alignment: .bottom) { stageFoot }
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
        }
        .toolbar(.hidden, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        // Felt, not watched: mid-sentence the eyes are on the other person,
        // so the state changes that matter reach the hand. Driven by the
        // session's own state, so a mute from the host buzzes the same way.
        .meetHaptic(.toggle, trigger: session.microphoneEnabled)
        .meetHaptic(.toggle, trigger: session.cameraEnabled)
        .meetHaptic(.toggle, trigger: session.handRaised)
        .meetHaptic(.warning, whenSet: session.moderationNotice)
        .meetHaptic(.warning, whenSet: session.transcriptionNotice)
        // The door, while hosting: a knock reaches the hand before the eye
        // finds the badge.
        .meetHaptic(.tap, trigger: lobby?.knockCount ?? 0)
        .confirmationDialog(
            "End the meeting for everyone?",
            isPresented: $confirmsEndForEveryone,
            titleVisibility: .visible
        ) {
            Button("End for everyone", role: .destructive) {
                Task { await endForEveryone() }
            }
        } message: {
            let others = max(session.participantCount - 1, 0)
            Text(others == 1 ? String(localized: "1 other person is still in the room.") : String(localized: "\(others) other people are still in the room."))
        }
        .sheet(isPresented: $showsChat) { MobileChatView(session: session) }
        .sheet(isPresented: $showsTranscript) { MobileTranscriptPanel(session: session, host: host) }
        .sheet(isPresented: $showsParticipants) {
            MobileParticipantsSheet(
                session: session,
                host: host,
                credentials: host?.credentials,
                api: StarlingsAPI(environment: .configured())
            )
        }
        .sheet(isPresented: $showsFiling) {
            if let host, let credentials = host.credentials {
                MobileMeetingFilingView(
                    host: host,
                    api: StarlingsAPI(environment: .configured()),
                    credentials: credentials
                )
            }
        }
        .sheet(isPresented: $showsTasks) {
            if let host {
                MobileTasksPanel(host: host)
            }
        }
        // A file picker rather than the photo library: the store takes a URL,
        // and this is one code path with the Mac's open panel rather than two
        // that have to be kept saying the same thing.
        .fileImporter(
            isPresented: $showsBackgroundImporter,
            allowedContentTypes: CustomBackgroundStore.allowedTypes
        ) { result in
            guard case .success(let url) = result else { return }
            // A file outside the app's own container arrives scoped, and
            // reading it without this fails with a permission error that reads
            // like a corrupt image.
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                try CustomBackgroundStore.save(contentsOf: url)
                hasCustomBackground = true
                session.setBackgroundEffect(.customImage)
            } catch {
                backgroundImageError = error.localizedDescription
            }
        }
        .meetErrorAlert("Couldn’t use that image", message: $backgroundImageError)
        .sheet(isPresented: $showsReactions) {
            MobileReactionPalette { reaction in await session.sendReaction(reaction) }
                .presentationDetents([.height(96)])
                .presentationBackground(.clear)
        }
        .onChange(of: session.chatMessages) { previous, current in
            guard !showsChat else { return }
            unreadChatCount += MeetingChatUnread.newlyReceivedRemoteMessageCount(
                previous: previous,
                current: current
            )
        }
        .onChange(of: session.phase) { _, phase in
            // The chat buffer is scoped to one LiveKit session, so its unread
            // signal must not leak into the next meeting.
            if phase != .connected {
                unreadChatCount = 0
            }
        }
    }

    private func noticeRow(_ notice: MobileModerationNotice, dismiss: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Image(systemName: notice.symbol)
            Text(notice.text).font(.callout)
            Spacer(minLength: 0)
            Button("Dismiss", action: dismiss)
                .font(.callout.weight(.semibold))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .meetContainerShape(cornerRadius: EnvisioningRadius.control)
        .meetConcentricBackground(
            StarlingsMobileColors.panel,
            fallbackRadius: EnvisioningRadius.control
        )
    }

    /// What sits on the stage's bottom edge: a moderation notice, the live
    /// caption, then the controls. Measured, so the grid can leave it room.
    private var stageFoot: some View {
        VStack(spacing: 10) {
            if let notice = session.moderationNotice {
                noticeRow(notice) { session.moderationNotice = nil }
            }
            if let notice = session.transcriptionNotice {
                noticeRow(notice) { session.transcriptionNotice = nil }
            }

            if let caption = session.captions.last?.text, !caption.isEmpty {
                Text(caption)
                    .font(.body.weight(.medium))
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .meetFloatingGlass(
                        Color.black.opacity(0.72),
                        in: RoundedRectangle(cornerRadius: EnvisioningRadius.field, style: .continuous)
                    )
            }

            controls
        }
        .padding(10)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { footHeight = $0 }
    }

    /// Camera and avatar tiles are one square primitive. Screen share uses the
    /// shared stage plan for its focus area and participant rail. The local
    /// camera stays a separate small reference tile, including during a share.
    private var stage: some View {
        let peers = session.videos.filter { !$0.isLocal }
        let local = session.selfViewHidden ? nil : session.videos.first { $0.isLocal }
        return GeometryReader { proxy in
            if proxy.size.width > 0, proxy.size.height > 0 {
                // The grid's room: the stage minus the foot floating on it.
                let room = CGSize(
                    width: proxy.size.width,
                    height: max(1, proxy.size.height - footHeight)
                )
                let localInsetSide = local.map { _ in selfInsetWidth(in: room) }
                let localInsetFrame = localInsetSide.map { side in
                    CGRect(
                        x: (room.width - side) / 2,
                        y: tileSpacing,
                        width: side,
                        height: side
                    )
                }
                ZStack(alignment: .top) {
                    MobileHomeGridBackground(meetingMode: true)
                    if let share = peers.first(where: \.isScreenShare) {
                        screenShareStage(
                            share,
                            strip: peers.filter { $0.id != share.id },
                            localInset: localInsetFrame,
                            in: room
                        )
                    } else if !peers.isEmpty {
                        peerStage(peers, in: room)
                    } else {
                        waitingForPeers()
                            .frame(width: room.width, height: room.height)
                    }
                    if let local, let localInsetFrame {
                        // The local camera is always the same square reference
                        // tile, so joining, leaving, or screen sharing cannot
                        // put it into the stage grid or morph its geometry.
                        MobileVideoTile(video: local, isSelfInset: true)
                            .frame(
                                width: localInsetFrame.width,
                                height: localInsetFrame.height
                            )
                            .padding(.top, localInsetFrame.minY)
                    }
                }
                .frame(width: proxy.size.width, height: proxy.size.height)
            } else {
                // SwiftUI can make one zero-height pass while the vertical
                // stack is negotiating space with the controls below it. Do
                // not construct a LiveKit renderer for that transient frame:
                // its UIKit bridge tries to convert the zero-sized layer and
                // emits a misleading geometry error.
                Color.clear
            }
        }
    }

    /// The empty-room line is centred on the stage behind the separate local
    /// reference tile.
    private func waitingForPeers() -> some View {
        VStack(spacing: 10) {
            Image(systemName: "person.2.fill").font(.system(size: 36))
            Text("Waiting for someone to join")
        }
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Peers share the same square-cell grid plan as the Mac stage, so a phone
    /// held in portrait gets the column count that leaves the biggest faces
    /// rather than a fixed two.
    @ViewBuilder
    private func peerStage(_ peers: [MobileVideo], in size: CGSize) -> some View {
        let plan = StageGridLayout.equalGridPlan(
            tileCount: peers.count,
            in: size,
            spacing: tileSpacing
        )
        VStack(spacing: tileSpacing) {
            ForEach(Array(stride(from: 0, to: peers.count, by: plan.columns)), id: \.self) { start in
                HStack(spacing: tileSpacing) {
                    ForEach(peers[start..<min(start + plan.columns, peers.count)]) { video in
                        MobileVideoTile(video: video)
                            .frame(width: plan.cell.width, height: plan.cell.height)
                    }
                }
            }
        }
        .frame(width: size.width, height: size.height)
        .onChange(of: SpatialLayoutKey(people: peers.map(\.person), size: size, screenSharePlan: nil), initial: true) { _, key in
            session.setSpatialAudioPositions(Self.gridPositions(for: key, plan: plan, spacing: tileSpacing))
        }
    }

    /// What decides where the tiles land, so a voice moves when a tile does
    /// and not on every speaking-ring flicker.
    private struct SpatialLayoutKey: Equatable {
        let people: [String]
        let size: CGSize
        let screenSharePlan: StageGridLayout.ScreenSharePlan?
    }

    /// The grid's cell centres, from the same plan the view drew, as spatial
    /// audio positions keyed by person. The Mac reads its tiles'
    /// frames; here SwiftUI keeps them, so the arithmetic is repeated once.
    private static func gridPositions(
        for key: SpatialLayoutKey,
        plan: StageGridLayout.EqualGridPlan,
        spacing: CGFloat
    ) -> [String: SpatialAudioPosition] {
        let count = key.people.count
        guard count > 0, plan.columns > 0 else { return [:] }
        let gridHeight = CGFloat(plan.rows) * plan.cell.height + CGFloat(plan.rows - 1) * spacing
        let top = max(0, (key.size.height - gridHeight) / 2)
        var positions: [String: SpatialAudioPosition] = [:]
        for (index, person) in key.people.enumerated() where !person.isEmpty {
            let row = index / plan.columns
            let column = index % plan.columns
            let inRow = min(plan.columns, count - row * plan.columns)
            let rowWidth = CGFloat(inRow) * plan.cell.width + CGFloat(inRow - 1) * spacing
            let x = max(0, (key.size.width - rowWidth) / 2)
                + CGFloat(column) * (plan.cell.width + spacing) + plan.cell.width / 2
            let y = top + CGFloat(row) * (plan.cell.height + spacing) + plan.cell.height / 2
            positions[person] = SpatialAudioPosition(center: CGPoint(x: x, y: y), in: key.size)
        }
        return positions
    }

    /// The shared layout plan decides whether the participant rail floats over
    /// the share or gets its own scrollable edge.
    @ViewBuilder
    private func screenShareStage(
        _ share: MobileVideo,
        strip: [MobileVideo],
        localInset: CGRect?,
        in size: CGSize
    ) -> some View {
        let plan = StageGridLayout.screenSharePlan(
            in: size,
            participantCount: strip.count,
            localInset: localInset,
            choice: screenShareLayoutChoice,
            spacing: tileSpacing
        )
        ZStack(alignment: .topLeading) {
            MobileVideoTile(video: share)
                .frame(width: plan.shareFrame.width, height: plan.shareFrame.height)
                .position(x: plan.shareFrame.midX, y: plan.shareFrame.midY)

            if plan.railMode != .none {
                screenShareRail(strip, plan: plan)
            }
        }
        .frame(width: size.width, height: size.height)
        .onChange(
            of: SpatialLayoutKey(
                people: strip.map(\.person),
                size: size,
                screenSharePlan: plan
            ),
            initial: true
        ) { _, key in
            session.setSpatialAudioPositions(Self.screenSharePositions(for: key, plan: plan))
        }
    }

    @ViewBuilder
    private func screenShareRail(
        _ strip: [MobileVideo],
        plan: StageGridLayout.ScreenSharePlan
    ) -> some View {
        let content = ZStack(alignment: .topLeading) {
            ForEach(strip.indices, id: \.self) { index in
                let video = strip[index]
                let frame = plan.participantFrames[index]
                MobileVideoTile(video: video, isScreenShareRailTile: true)
                    .frame(width: frame.width, height: frame.height)
                    .position(x: frame.midX, y: frame.midY)
            }
        }
        .frame(width: plan.railContentSize.width, height: plan.railContentSize.height)

        Group {
            switch plan.railMode {
            case .none:
                EmptyView()
            case .overlay:
                ScrollView(.horizontal, showsIndicators: false) { content }
                    .frame(width: plan.railFrame.width, height: plan.railFrame.height)
            case .horizontal:
                ScrollView(.horizontal, showsIndicators: false) { content }
                    .frame(width: plan.railFrame.width, height: plan.railFrame.height)
            case .vertical:
                ScrollView(.vertical, showsIndicators: false) { content }
                    .frame(width: plan.railFrame.width, height: plan.railFrame.height)
            }
        }
        .position(x: plan.railFrame.midX, y: plan.railFrame.midY)
    }

    /// Share-rail coordinates come from the same plan the stage draws. The
    /// spatial mixer clamps scrolled tiles beyond the viewport to its edge.
    private static func screenSharePositions(
        for key: SpatialLayoutKey,
        plan: StageGridLayout.ScreenSharePlan
    ) -> [String: SpatialAudioPosition] {
        var positions: [String: SpatialAudioPosition] = [:]
        for (index, person) in key.people.enumerated() where !person.isEmpty {
            guard plan.participantFrames.indices.contains(index) else { continue }
            let tile = plan.participantFrames[index]
            positions[person] = SpatialAudioPosition(
                center: CGPoint(
                    x: plan.railFrame.minX + tile.midX,
                    y: plan.railFrame.minY + tile.midY
                ),
                in: key.size
            )
        }
        return positions
    }

    /// Small enough to stay out of the way, big enough to check your framing:
    /// a fifth of the stage width, held between two thumb-sized bounds.
    private func selfInsetWidth(in size: CGSize) -> CGFloat {
        min(max(size.width * 0.2, 76), 128)
    }

    private var controls: some View {
        StarlingsGlassGroup(spacing: 10) {
            controlsRow
        }
    }

    private var controlsRow: some View {
        HStack(spacing: 10) {
            callButton(
                symbol: session.microphoneEnabled ? "mic.fill" : "mic.slash.fill",
                label: session.microphoneEnabled ? String(localized: "Mute") : String(localized: "Unmute")
            ) { await session.toggleMicrophone() }
                .overlay(alignment: .topTrailing) {
                    MobileDeviceChooser(label: "Choose microphone") {
                        MobileMicrophoneMenu(inputs: session.audioInputs)
                    }
                }
            callButton(
                symbol: session.cameraEnabled ? "video.fill" : "video.slash.fill",
                label: session.cameraEnabled ? String(localized: "Camera") : String(localized: "Camera on")
            ) { await session.toggleCamera() }
                .overlay(alignment: .topTrailing) {
                    MobileDeviceChooser(label: "Choose camera") {
                        MobileCameraMenu(session: session)
                    }
                }
            // Everything that is not mic, camera, chat, or the way out. Five
            // controls fit a phone's width; nine do not, and the four that stay
            // are the ones reached mid-sentence.
            Menu {
                Button {
                    showsReactions = true
                } label: {
                    Label("React", systemImage: "face.smiling")
                }
                // `/room/team` only: there Leave drops nobody, so ending the
                // call for the people still in it is its own act.
                if host?.isInternalRoom == true, host?.holdsHost == true {
                    Button(role: .destructive) {
                        confirmsEndForEveryone = true
                    } label: {
                        Label("End for everyone", systemImage: "phone.down.circle")
                    }
                }
                // The host can hand the host to another device in the call;
                // any other owner device can ask for it.
                if let host, host.holdsHost, !session.hostTargets.isEmpty {
                    Menu {
                        ForEach(session.hostTargets, id: \.identity) { target in
                            Button {
                                Task { await host.offerHost(to: target.identity, name: target.name) }
                            } label: {
                                Text(verbatim: "\(target.name) · \(target.device)")
                            }
                        }
                    } label: {
                        Label("Move host…", systemImage: "person.crop.circle.badge.checkmark")
                    }
                } else if let host, !host.holdsHost {
                    Button {
                        Task { await host.claimHost(ifVacant: false) }
                    } label: {
                        Label("Take host", systemImage: "person.crop.circle.badge.checkmark")
                    }
                }
                // Beside React because they answer the same need from two
                // directions — both are ways of saying something without taking
                // the floor — and distinct from it because only one persists.
                // The label says which way the next press goes.
                Button {
                    Task { await session.setOwnHand(raised: !session.handRaised) }
                } label: {
                    Label(
                        session.handRaised ? String(localized: "Lower hand") : String(localized: "Raise hand"),
                        systemImage: session.handRaised ? "hand.raised.fill" : "hand.raised"
                    )
                }
                Button {
                    Task { await session.switchCamera() }
                } label: {
                    Label("Flip camera", systemImage: "camera.rotate.fill")
                }
                Picker("Screen share layout", selection: screenShareLayoutSelection) {
                    ForEach(StageGridLayout.ScreenShareLayoutChoice.allCases, id: \.self) { choice in
                        Text(choice.title).tag(choice)
                    }
                }
                Divider()
                // Hiding yourself stops the tile being drawn, never the camera
                // being published: the room still sees you.
                Button {
                    session.toggleSelfView()
                } label: {
                    Label(
                        session.selfViewHidden ? String(localized: "Show my tile") : String(localized: "Hide my tile"),
                        systemImage: session.selfViewHidden ? "person.slash.fill" : "person.fill"
                    )
                }
                Button {
                    showsTranscript = true
                } label: {
                    Label("Live transcript", systemImage: "text.bubble")
                }
                Button {
                    showsParticipants = true
                } label: {
                    Label("People", systemImage: "person.3.fill")
                }
                // Segmentation runs on this device and the room sees only the
                // composited frames, so this is a local choice end to end.
                if let host, host.credentials != nil {
                    // Host-only, and absent with no queue: an item that would
                    // do nothing teaches people to stop reading the menu. The
                    // Mac keeps the same action in its Meeting menu beside Mute
                    // Everyone Else — clearing the queue after answering it is
                    // the other half of having one.
                    if !session.raisedHands.isEmpty {
                        Button {
                            Task { await host.lowerAllHands() }
                        } label: {
                            Label(
                                session.raisedHands.count == 1
                                    ? String(localized: "Lower all hands (1)")
                                    : "Lower all hands (\(session.raisedHands.count))",
                                systemImage: "hand.raised.slash"
                            )
                        }
                    }
                    Button {
                        showsFiling = true
                    } label: {
                        Label("File this meeting", systemImage: "tray.full")
                    }
                    Button {
                        showsTasks = true
                    } label: {
                        Label(
                            host.proposedTasks.isEmpty
                                ? String(localized: "Tasks")
                                : "Tasks (\(host.proposedTasks.count))",
                            systemImage: "checklist"
                        )
                    }
                }
                Menu {
                    Button("None") { backgroundSelection.wrappedValue = .none }
                    Button("Blur") { backgroundSelection.wrappedValue = .blur }
                    ForEach(BackgroundGenerator.allCases, id: \.self) { generator in
                        Menu(generator.label) {
                            ForEach(BackgroundChoice.all.filter { $0.generator == generator }, id: \.self) { choice in
                                Button {
                                    backgroundSelection.wrappedValue = .generated(choice)
                                } label: {
                                    if session.backgroundEffect == .generated(choice) {
                                        Label(choice.displayName, systemImage: "checkmark")
                                    } else {
                                        Text(choice.displayName)
                                    }
                                }
                            }
                        }
                    }
                    if WorkspaceBackgrounds.hasPicture {
                        Button("Workspace picture") { backgroundSelection.wrappedValue = .workspaceImage }
                    }
                    if hasCustomBackground {
                        Button("My image") { backgroundSelection.wrappedValue = .customImage }
                    }
                    Divider()
                    Button {
                        showsBackgroundImporter = true
                    } label: {
                        Label(
                            hasCustomBackground ? String(localized: "Replace image…") : String(localized: "Choose image…"),
                            systemImage: "photo"
                        )
                    }
                    if hasCustomBackground {
                        Button(role: .destructive) {
                            CustomBackgroundStore.clear()
                            hasCustomBackground = false
                            // Taking the picture away takes the effect with it,
                            // rather than leaving a background that quietly is
                            // not there any more.
                            if session.backgroundEffect == .customImage {
                                session.setBackgroundEffect(.none)
                            }
                        } label: {
                            Label("Remove image", systemImage: "trash")
                        }
                    }
                } label: {
                    Label("Background", systemImage: "person.crop.rectangle")
                }
            } label: {
                VStack(spacing: 4) {
                    Image(systemName: "ellipsis.circle")
                    Text("More").font(.caption2)
                }
                .frame(maxWidth: .infinity, minHeight: 54)
            }
            .buttonStyle(.plain) // hover: meetHoverLift after the glass
            .meetFloatingGlass(
                StarlingsMobileColors.elevated,
                in: RoundedRectangle(cornerRadius: EnvisioningRadius.control, style: .continuous),
                interactive: true
            )
            .meetHoverLift(cornerRadius: EnvisioningRadius.control)
            chatButton
            Button {
                if host?.holdsHost == true, host?.isInternalRoom != true, host?.isHostingColleaguesRoom != true, session.participantCount > 1 {
                    confirmsEndForEveryone = true
                } else {
                    Task { await leaveOrEnd() }
                }
            } label: {
                VStack(spacing: 4) {
                    Image(systemName: "phone.down.fill")
                    // Ending closes the room for everybody in it, so it must
                    // never wear the word for stepping out of one — and on
                    // `/room/team` the host's button drops nobody.
                    Text(host == nil || host?.holdsHost != true || host?.isInternalRoom == true || host?.isHostingColleaguesRoom == true ? String(localized: "Leave") : String(localized: "End")).font(.caption2)
                }
                .frame(maxWidth: .infinity, minHeight: 54)
            }
            .buttonStyle(.plain) // hover: meetHoverLift after the glass
            .foregroundStyle(.primary)
            .meetFloatingGlass(
                StarlingsMobileColors.danger,
                in: RoundedRectangle(cornerRadius: EnvisioningRadius.control, style: .continuous),
                tint: StarlingsMobileColors.danger,
                interactive: true
            )
            .meetHoverLift(cornerRadius: EnvisioningRadius.control)
        }
    }

    /// The confirmed End: for everyone in a personal room by definition, and
    /// by request on `/room/team`.
    private func endForEveryone() async {
        guard case .host(let host, let lobby) = role, host.holdsHost else { return }
        StarlingsHaptics.destructive.play()
        lobby.stop()
        await host.end(everyone: host.isInternalRoom)
    }

    private func leaveOrEnd() async {
        // Played directly: the view is gone before a trigger could fire.
        StarlingsHaptics.destructive.play()
        switch role {
        case .guest(let model): await model.leave()
        case .host(let host, let lobby):
            lobby.stop()
            await host.end()
        }
    }

    private func callButton(
        symbol: String,
        label: String,
        action: @escaping @MainActor () async -> Void
    ) -> some View {
        Button { Task { await action() } } label: {
            VStack(spacing: 4) {
                Image(systemName: symbol)
                Text(label).font(.caption2)
            }
            .frame(maxWidth: .infinity, minHeight: 54)
        }
        .buttonStyle(.plain) // hover: meetHoverLift after the glass
        .meetFloatingGlass(
            StarlingsMobileColors.elevated,
            in: RoundedRectangle(cornerRadius: EnvisioningRadius.control, style: .continuous),
            interactive: true
        )
        .meetHoverLift(cornerRadius: EnvisioningRadius.control)
    }

    private var chatButton: some View {
        Button {
            // Opening is the read action. The messages themselves remain in
            // `session.chatMessages`, so the count can disappear without
            // making anything that arrived while Chat was closed disappear.
            unreadChatCount = 0
            showsChat = true
        } label: {
            VStack(spacing: 4) {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                Text("Chat").font(.caption2)
            }
            .frame(maxWidth: .infinity, minHeight: 54)
            .overlay(alignment: .topTrailing) {
                if unreadChatCount > 0 {
                    Text(unreadChatCount > 99 ? "99+" : "\(unreadChatCount)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(StarlingsMobileColors.canvas)
                        .padding(.horizontal, 4)
                        .frame(minWidth: 20, minHeight: 20)
                        .background(StarlingsMobileColors.primary, in: Capsule())
                        .offset(x: 7, y: -7)
                        .accessibilityHidden(true)
                }
            }
        }
        .buttonStyle(.plain) // hover: meetHoverLift after the glass
        .meetFloatingGlass(
            StarlingsMobileColors.elevated,
            in: RoundedRectangle(cornerRadius: EnvisioningRadius.control, style: .continuous),
            interactive: true
        )
        .meetHoverLift(cornerRadius: EnvisioningRadius.control)
        .accessibilityLabel(
            unreadChatCount == 0
                ? String(localized: "Chat")
                : String(localized: "Chat, \(unreadChatCount) unread messages")
        )
        .accessibilityHint("Opens messages for everyone in this meeting")
    }
}

/// The two things only a host sees: who is at the door, and whether the room
/// can still let them in.
///
/// It is its own view so SwiftUI observes the host and the lobby directly —
/// reaching them through the call view's role enum would publish nothing, and
/// the waiting count would sit at whatever it was when the stage was built.
private struct MobileHostChrome: View {
    @ObservedObject var host: MobileRoomHost
    @ObservedObject var lobby: MobileLobbyWatch
    @Binding var showsWaitingRoom: Bool

    var body: some View {
        HStack(spacing: 8) {
            // A lapsed lease does not end the meeting — media outlives it — but
            // nobody new can be admitted, so a host who looks healthy while the
            // door is bolted is the failure worth shouting about.
            if host.leaseLapsed {
                Label("Room closed to new guests", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .labelStyle(.iconOnly)
                    .foregroundStyle(StarlingsMobileColors.danger)
                    .accessibilityLabel("Your room stopped admitting guests")
            }
            let lobbyCount = lobby.waiting.count + lobby.lurking.count
            Button {
                showsWaitingRoom = true
            } label: {
                Image(systemName: lobbyCount == 0 ? "person.badge.clock" : "person.badge.clock.fill")
                    .accessibilityLabel(lobbyCount == 0 ? String(localized: "Waiting room") : String(localized: "Waiting room, \(lobbyCount) waiting"))
                    .frame(width: 42, height: 42)
                    .overlay(alignment: .topTrailing) {
                        if lobbyCount > 0 {
                            Text("\(lobbyCount)")
                                .font(.caption2.bold())
                                .padding(4)
                                .background(StarlingsMobileColors.accent, in: Circle())
                                .foregroundStyle(StarlingsMobileColors.accentInk)
                        }
                    }
            }
            .buttonStyle(.plain)
            .background(StarlingsMobileColors.elevated, in: Circle())
            // Half the 42pt well: the veil is the circle.
            .meetHoverLift(cornerRadius: 21)
            .accessibilityLabel(mobileLobbyLabel(waiting: lobby.waiting.count, lurking: lobby.lurking.count))
        }
    }

    private func mobileLobbyLabel(waiting: Int, lurking: Int) -> String {
        switch (waiting, lurking) {
        case (0, 0): return "Waiting room, nobody waiting"
        case (0, let lurking): return "Waiting room, \(lurking) on the join page"
        case (let waiting, 0): return "Waiting room, \(waiting) waiting"
        default: return "Waiting room, \(waiting) waiting, \(lurking) on the join page"
        }
    }
}

private struct MobileVideoTile: View {
    let video: MobileVideo
    /// The local camera riding over the stage rather than sitting in it. It
    /// drops the name badge — a mirrored face needs no caption saying it is
    /// yours — and keeps the speaking ring, which is the one thing the inset is
    /// still worth reading at that size.
    var isSelfInset = false
    /// Share-rail thumbnails keep their name and connection quality available
    /// to VoiceOver, but clear those overlays from the small visual tiles.
    var isScreenShareRailTile = false

    /// A share is somebody's desktop, not their face, and mistaking the two is
    /// how private windows get read out to a room. Name the sharer the same way
    /// the Mac stage does (`ParticipantTileView.configure`) so a share is
    /// attributed identically wherever it is watched. The local tile carries
    /// no "(you)" suffix — the mirrored preview already says whose it is.
    private var label: String {
        if video.isScreenShare { return "\(video.name) · Screen" }
        if video.isHost { return String(localized: "\(video.name) · Host") }
        return video.name
    }

    /// A share still outranks the speaking ring — while a tile is a screen
    /// share that is the more important thing to know about it — but the ring
    /// itself is neutral now, not a stray blue (docs/DESIGN.md, "The accent
    /// budget"). The "rectangle.on.rectangle" badge in the name label below is
    /// what tells a share apart from someone speaking.
    private var outline: (color: Color, width: CGFloat) {
        if video.isScreenShare { return (StarlingsMobileColors.primary, 3) }
        if video.isSpeaking { return (StarlingsMobileColors.accent, 3) }
        return (StarlingsMobileColors.border, 1)
    }

    private var cornerRadius: CGFloat { isSelfInset ? 12 : 16 }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if let track = video.track {
                if video.isScreenShare {
                    SwiftUIVideoView(
                        track,
                        layoutMode: .fit,
                        mirrorMode: .auto,
                        pinchToZoomOptions: [.zoomIn, .zoomOut]
                    )
                    .background(Color.black)
                } else {
                    MobileFaceCenteredVideo(track: track, mirror: video.isLocal)
                }
            } else {
                MobileParticipantAvatar(name: video.name)
            }
            if !isSelfInset && (!isScreenShareRailTile || video.isScreenShare || video.recording) {
                HStack(spacing: 5) {
                    if video.isScreenShare {
                        // No tint — the glyph itself is the "sharing" signal.
                        Image(systemName: "rectangle.on.rectangle")
                    }
                    if video.recording && !video.isScreenShare {
                        Image(systemName: "record.circle.fill")
                            .foregroundStyle(StarlingsMobileColors.danger)
                        Text("Recording")
                    }
                    if !isScreenShareRailTile || video.isScreenShare {
                        Text(label)
                    }
                }
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .meetFloatingGlass(.black.opacity(0.7), in: Capsule())
                .padding(8)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            Image(systemName: video.quality.tileIconSystemName, variableValue: video.quality.tileSignalValue)
                .font(.system(size: isSelfInset ? 11 : 12, weight: .semibold))
                .foregroundStyle(
                    video.quality.isWeak
                        ? StarlingsMobileColors.danger
                        : Color.white
                )
                .frame(width: 24, height: 24)
                .meetFloatingGlass(.black.opacity(0.68), in: RoundedRectangle(cornerRadius: 6))
                .padding(isSelfInset ? 4 : 8)
                .opacity(isScreenShareRailTile ? 0 : 1)
                .accessibilityHidden(true)
        }
        .meetContainerShape(cornerRadius: cornerRadius)
        .meetConcentricClip(fallbackRadius: cornerRadius)
        .overlay(alignment: .topLeading) {
            // A screen has no hand: the badge belongs to the person, and their
            // camera tile is where it goes. Drawn on the self inset too — a
            // control you cannot tell worked is worse than no control.
            if video.handRaised && !video.isScreenShare {
                Image(systemName: "hand.raised.fill")
                    .font(.system(size: isSelfInset ? 10 : 13, weight: .semibold))
                    .foregroundStyle(StarlingsMobileColors.accentInk)
                    .frame(width: isSelfInset ? 20 : 26, height: isSelfInset ? 20 : 26)
                    .meetFloatingGlass(StarlingsMobileColors.accent, in: Circle(), tint: StarlingsMobileColors.accent)
                    .padding(isSelfInset ? 4 : 8)
                    .accessibilityLabel("Hand raised")
            }
        }
        .overlay {
            StarlingsConcentricStroke(
                style: outline.color,
                fallbackRadius: cornerRadius,
                lineWidth: outline.width
            )
        }
        .shadow(color: .black.opacity(isSelfInset ? 0.35 : 0), radius: 8, y: 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(handAccessibilityLabel)
    }

    /// A raised hand is the most important thing about a tile when it is up, so
    /// it leads the label rather than trailing it.
    private var handAccessibilityLabel: String {
        let base = cameraOffAccessibilityLabel ?? label
        let hand = video.handRaised && !video.isScreenShare ? String(localized: "Hand raised, ") : ""
        let recording = video.recording ? String(localized: ", recording notetaker") : ""
        let sender = video.onBehalfOf.map { String(localized: ", sent by \($0)") } ?? ""
        return String(localized: "\(hand)\(base)\(recording)\(sender), \(video.quality.tileIconAccessibilityLabel)")
    }

    /// A blank tile is worth saying out loud — otherwise VoiceOver reads the
    /// same label whether or not there is anything to see.
    private var cameraOffAccessibilityLabel: String? {
        guard video.track == nil else { return nil }
        return video.isLocal ? String(localized: "Your camera is off") : String(localized: "\(video.name), camera off")
    }
}

/// SwiftUI's stock video view has no object-position equivalent, so the native
/// camera view is given the same aspect-fill frame as AppKit and moved inside
/// the square tile. Vision is sampled slowly and only affects this local crop.
private struct MobileFaceCenteredVideo: View {
    let track: VideoTrack
    let mirror: Bool
    @State private var faceAnchor = StageGridLayout.defaultCropAnchor
    @State private var tracker = FaceCenteringTracker()

    private let detectorTimer = Timer.publish(every: 1.25, on: .main, in: .common).autoconnect()

    var body: some View {
        GeometryReader { proxy in
            let sourceSize = track.dimensions.map {
                CGSize(width: CGFloat($0.width), height: CGFloat($0.height))
            } ?? CGSize(width: 16, height: 9)
            let anchor = CGPoint(
                x: mirror ? 1 - faceAnchor.x : faceAnchor.x,
                y: faceAnchor.y
            )
            let appKitFrame = StageGridLayout.videoFrame(
                inTile: CGRect(origin: .zero, size: proxy.size),
                sourceSize: sourceSize,
                anchor: anchor
            )
            let swiftFrame = CGRect(
                x: appKitFrame.minX,
                y: proxy.size.height - appKitFrame.maxY,
                width: appKitFrame.width,
                height: appKitFrame.height
            )

            SwiftUIVideoView(track, layoutMode: .fill, mirrorMode: mirror ? .mirror : .auto)
                .frame(width: swiftFrame.width, height: swiftFrame.height)
                .offset(x: swiftFrame.minX, y: swiftFrame.minY)
                .onReceive(detectorTimer) { _ in
                    // At crowd scale the square primitive stays stable, but
                    // Vision should spend its budget on tiles large enough to
                    // produce a useful crop.
                    guard proxy.size.width >= 140, track.dimensions != nil else { return }
                    let target = FaceCentering.anchor(for: track.videoFrame)
                    let nextAnchor = tracker.update(
                        target: target,
                        at: ProcessInfo.processInfo.systemUptime
                    )
                    withAnimation(.easeInOut(duration: 0.45)) {
                        faceAnchor = nextAnchor
                    }
                }
        }
        .clipped()
        .background(Color.black)
    }
}

/// Initials in a circle for a camera-off tile, in the same proportions as the
/// Mac's `ParticipantAvatarView` and the web's `.meet-avatar`: a circle at 46%
/// of the tile's short side, capped, with the initials at just over a third of
/// that.
private struct MobileParticipantAvatar: View {
    let name: String

    var body: some View {
        GeometryReader { proxy in
            let diameter = min(min(proxy.size.width, proxy.size.height) * 0.46, 128)
            Circle()
                .fill(StarlingsMobileColors.elevated)
                .overlay(Circle().strokeBorder(StarlingsMobileColors.border, lineWidth: 1))
                .overlay(
                    Text(ParticipantInitials.make(from: name))
                        .font(.system(size: max(11, diameter * 0.34), weight: .semibold))
                        .foregroundStyle(.primary)
                )
                .frame(width: diameter, height: diameter)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(StarlingsMobileColors.panel)
    }
}

private struct MobileChatView: View {
    @ObservedObject var session: MobileGuestSession
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            if session.chatMessages.isEmpty {
                                Text("No messages yet")
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity)
                                    .padding(.top, 40)
                            }
                            ForEach(session.chatMessages) { message in
                                HStack {
                                    // Yours are pushed over rather than stretched: a
                                    // bubble that fills the width is a paragraph, not
                                    // a message.
                                    if message.isLocal { Spacer(minLength: 40) }
                                    VStack(alignment: message.isLocal ? .trailing : .leading, spacing: 3) {
                                        Text(message.isLocal ? String(localized: "You") : message.senderName)
                                            .font(.caption.bold())
                                            .foregroundStyle(.secondary)
                                        Text(message.text)
                                        MobileChatLinkPreview(session: session, text: message.text)
                                        MobileChatReactionsRow(session: session, messageID: message.id)
                                    }
                                    .padding(10)
                                    .meetContainerShape(cornerRadius: EnvisioningRadius.field)
                                    .meetConcentricBackground(
                                        message.isLocal ? StarlingsMobileColors.accent.opacity(0.18) : StarlingsMobileColors.elevated,
                                        fallbackRadius: EnvisioningRadius.field
                                    )
                                    .fixedSize(horizontal: false, vertical: true)
                                    if !message.isLocal { Spacer(minLength: 40) }
                                }
                                .id(message.id)
                            }
                        }
                        .padding()
                    }
                    .onAppear { scrollToLatest(proxy, animated: false) }
                    .onChange(of: session.chatMessages.count) { _, _ in
                        scrollToLatest(proxy, animated: true)
                    }
                }
                HStack {
                    // The send control sits inset inside the field rather than
                    // beside it: one pill, not two shapes fighting for the eye.
                    ZStack(alignment: .trailing) {
                        TextField("Message everyone", text: $draft, axis: .vertical)
                            .lineLimit(1...4)
                            .meetField()
                            .padding(.trailing, 34)

                        Button {
                            let text = draft
                            draft = ""
                            Task {
                                do { try await session.sendChat(text) }
                                catch { errorMessage = error.localizedDescription }
                            }
                        } label: {
                            Image(systemName: "arrow.up")
                                .font(.footnote.weight(.bold))
                                .foregroundStyle(StarlingsMobileColors.accentInk)
                                .frame(width: 26, height: 26)
                                .background(Circle().fill(StarlingsMobileColors.accent))
                        }
                        .accessibilityLabel("Send message")
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .opacity(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
                        .padding(.trailing, 10)
                    }
                }
                .padding()
            }
            .meetSheetGround()
            .navigationTitle("Chat")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.meetToolbarConfirm() } }
        }
        .meetHalfSheet()
        .meetErrorAlert("Chat unavailable", message: $errorMessage)
    }

    /// The chat sheet can be reopened after its messages are already loaded,
    /// so positioning only from message changes leaves it wherever SwiftUI
    /// restores the scroll view. Defer one turn until the lazy stack is laid
    /// out, just like the team conversation view.
    private func scrollToLatest(_ proxy: ScrollViewProxy, animated: Bool) {
        guard let lastID = session.chatMessages.last?.id else { return }
        DispatchQueue.main.async {
            if animated {
                withAnimation { proxy.scrollTo(lastID, anchor: .bottom) }
            } else {
                proxy.scrollTo(lastID, anchor: .bottom)
            }
        }
    }
}

/// The reactions on one chat message, and the way to add one.
///
/// The pills are what people came for; the palette is behind a menu, because
/// six emoji under every message is a lot of ink for something most messages
/// never get. A reaction is state and travels reliably — see
/// `Sources/ChatReactions.swift` for why it is not a flying reaction and not a
/// participant attribute.
///
/// Reads the session's whole tally, so every visible row redraws when any
/// reaction lands. That is the right trade here: a chat pane on a phone is a
/// handful of rows, and the alternative is an observable per message.
private struct MobileChatReactionsRow: View {
    @ObservedObject var session: MobileGuestSession
    let messageID: String

    var body: some View {
        let onThisMessage = session.chatReactions.reactions(on: messageID)
        HStack(spacing: 6) {
            ForEach(onThisMessage) { entry in
                let mine = session.localHasChatReaction(entry.reaction, on: messageID)
                Button {
                    Task { await session.toggleChatReaction(entry.reaction, on: messageID) }
                } label: {
                    Label {
                        Text("\(entry.count)")
                    } icon: {
                        Image(systemName: entry.reaction.systemSymbolName)
                    }
                    .font(.caption)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(
                            mine ? StarlingsMobileColors.accent.opacity(0.18) : Color(uiColor: .quaternarySystemFill),
                            in: Capsule()
                        )
                        .foregroundStyle(mine ? StarlingsMobileColors.accent : Color.secondary)
                }
                .buttonStyle(.plain)
                // The chip is a capsule about 20pt tall.
                .meetHoverLift(cornerRadius: 10)
                .accessibilityLabel(Text("\(entry.reaction.accessibilityName), \(entry.count)"))
                .accessibilityAddTraits(mine ? [.isSelected] : [])
            }
            Menu {
                ForEach(ChatReaction.emoji, id: \.self) { reaction in
                    Button {
                        Task { await session.toggleChatReaction(reaction, on: messageID) }
                    } label: {
                        Label(
                            reaction.accessibilityName,
                            systemImage: session.localHasChatReaction(reaction, on: messageID)
                                ? "checkmark.circle.fill"
                                : "circle"
                        )
                    }
                }
            } label: {
                Image(systemName: "face.smiling")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .accessibilityLabel("React to this message")
        }
        .padding(.top, 2)
    }
}

/// The card under a chat message that carries a link.
///
/// The same card the thread panes draw, fetched through a different door: the
/// meeting's own token rather than a member session, because the person
/// reading may be a guest with no account. Nobody's device fetches the linked
/// page — see `LinkPreview` for why.
private struct MobileChatLinkPreview: View {
    @ObservedObject var session: MobileGuestSession
    let text: String

    @State private var preview: LinkPreview?

    var body: some View {
        LinkPreviewCard(preview: preview)
            .task(id: text) {
                guard let link = ThreadMarkdown.firstPreviewableLink(in: text) else {
                    preview = nil
                    return
                }
                preview = await session.chatLinkPreview(for: link)
            }
    }
}
