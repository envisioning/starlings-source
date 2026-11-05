import AppKit
import LiveKit

/// One tile on the stage. The local participant is modelled exactly like a
/// remote one so the grid, the name badge, and the speaking ring have a single
/// code path — mirroring is the only difference. The badge carries no "(you)"
/// marker: the mirrored tile showing your own face needs no caption to say so.
private struct StageTile {
    let id: String
    /// LiveKit identity of whoever this tile belongs to, or `localTileID` for the
    /// local one. A person can hold two tiles (camera + share), so moderation
    /// addresses the identity rather than the tile.
    let identity: String
    let track: VideoTrack?
    let name: String
    let isScreenShare: Bool
    let isSpeaking: Bool
    /// Their hand is up, and stays up until it is lowered — see `MeetingHands`.
    let handRaised: Bool
    /// This device hosts the meeting: the tile says so beside the name.
    let isHost: Bool
    let quality: MeetingConnectionQuality
    let recording: Bool
    let onBehalfOf: String?
    /// True for a track published by this Mac. A local screen share is local
    /// content but is not the movable self-view, hence `isSelfView` below.
    let isLocal: Bool
    let isSelfView: Bool
    /// Set only on a remote share the local participant is allowed to stop —
    /// the host's one control over what other people publish.
    let stoppableShareIdentity: String?
}

@MainActor
final class MeetingStageView: NSView {
    /// Reserved id for the local tile. Remote ids are always `<identity>:…`,
    /// and no identity can contain a colon-free sentinel like this.
    private static let localTileID = "__local__"
    private static let localScreenShareTileID = "__local_screen_share__"

    private let prejoinPreview = CameraPreviewView()
    private let brandGridBackground = BrandGridBackground(frame: .zero)
    private let tileContainer = NSView()
    private let shareRailScrollView = NSScrollView()
    private let shareRailDocumentView = StageRailDocumentView()
    /// Stage furniture, drawn over the tiles: the room's own readout, and the
    /// knock that must be answerable without the rail.
    private let readoutPill = StageReadoutPill()
    private let knockBanner = StageKnockBanner()

    private var tiles: [String: ParticipantTileView] = [:]
    private var remoteVideos: [MeetingRemoteVideo] = []
    /// What the local tile is captioned with, and the name the local
    /// participant's own reactions fly under.
    private(set) var localDisplayName = "You"
    private var localTrack: VideoTrack?
    private var localScreenShareTrack: VideoTrack?
    private var localIsSpeaking = false
    private var localHandRaised = false
    private var localIsHost = false
    private var localQuality: MeetingConnectionQuality = .unknown
    private var showsLocalTile = false

    private let stagePadding: CGFloat = 10
    private let tileSpacing: CGFloat = 12
    private let stageCornerRadius: CGFloat = 18
    private var shareRailMode: StageGridLayout.ScreenSharePlan.RailMode = .none
    private var screenShareLayoutChoice = StageGridLayout.ScreenShareLayoutPreferences.choice

    /// You are not a participant on your own stage. Everyone else divides the
    /// whole of it; your own camera always shrinks to a fraction of the stage
    /// width — one of the three steps `SelfViewSize` names — and parks against
    /// one of the six edges `SelfViewPlacement` names — top centre by default,
    /// under the built-in camera, so looking at yourself is as close as this
    /// gets to looking down the lens. A face you have watched all day is a
    /// reference, not a peer, even when you are alone.
    private(set) var selfSize = SelfViewPreferences.size

    /// True while the local participant is being kept off this Mac's own stage
    /// via Hide me. Independent of PiP — floating self-view uses
    /// `suppressesLocalTileForPiP` so closing the panel can restore the tile
    /// without clearing a deliberate Hide me preference.
    private(set) var hidesLocalTile = false

    /// True while self-view is floating in `SelfViewPiPController`.
    private(set) var suppressesLocalTileForPiP = false

    /// Which of the six spots the inset parks in. A preference of this Mac's,
    /// restored from the last meeting and moved by dragging your own tile or
    /// by the one-click corner action.
    private(set) var selfPlacement = SelfViewPreferences.placement

    /// True while the local tile is drawn as the inset — the only state it can
    /// be dragged in. A hidden tile is absent, so it is not yours to move.
    private var localTileIsInset = false

    /// Live drag: where the inset was grabbed, where it sat when it was, and
    /// whether the pointer has actually gone anywhere yet.
    private var selfInsetDrag: (grab: NSPoint, origin: NSPoint, moved: Bool)?

    /// Consumed by the next layout pass so a placement change slides rather
    /// than teleports. Every other pass — a resize, a camera reporting a new
    /// shape — stays instant.
    private var animatesSelfInsetMove = false

    /// Host only: puts a stop button on other people's screen-share tiles.
    /// The button is never shown to a guest, and the control plane checks
    /// ownership again anyway — this only decides whether to offer it.
    private var canModerateShares = false

    /// Called with the sharer's LiveKit identity when the host presses stop.
    var onStopScreenShare: ((String) -> Void)?

    /// Where each remote person's camera tile landed, keyed by account
    /// address, after every layout pass. Spatial audio puts their
    /// voice there. A share carries no voice and the local tile is the
    /// listener, so neither is reported.
    var onRemoteTilePositions: (([String: SpatialAudioPosition]) -> Void)?

    /// The local preview owns its two direct actions. Keeping them here means
    /// the stage tile and the floating self-view can use the same local-only
    /// semantics without teaching a participant row how to manage layout.
    var onHideLocalSelf: (() -> Void)?
    var onMoveLocalSelfToCorner: (() -> Void)?

    /// The knock banner's two decisions and its way into the queue. Wired to the
    /// same calls the rail's rows and ⌘⇧↩ / ⌘⇧⌫ make.
    var onAdmitKnock: (() -> Void)?
    var onDeclineKnock: (() -> Void)?
    var onShowKnockQueue: (() -> Void)?

    func setCanModerateShares(_ canModerate: Bool) {
        guard canModerate != canModerateShares else { return }
        canModerateShares = canModerate
        rebuildTiles()
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: self).cgColor
        layer?.cornerRadius = stageCornerRadius
        layer?.masksToBounds = true

        addSubview(brandGridBackground)
        brandGridBackground.translatesAutoresizingMaskIntoConstraints = false
        brandGridBackground.pinToEdges(of: self)
        brandGridBackground.setVisibleForMeeting()

        for child in [prejoinPreview, tileContainer] {
            addSubview(child)
            child.translatesAutoresizingMaskIntoConstraints = false
            child.pinToEdges(of: self)
        }

        shareRailScrollView.drawsBackground = false
        shareRailScrollView.backgroundColor = .clear
        shareRailScrollView.borderType = .noBorder
        shareRailScrollView.scrollerStyle = .overlay
        shareRailScrollView.autohidesScrollers = true
        shareRailScrollView.hasHorizontalScroller = false
        shareRailScrollView.hasVerticalScroller = false
        shareRailScrollView.contentView.drawsBackground = false
        shareRailScrollView.documentView = shareRailDocumentView
        shareRailScrollView.isHidden = true
        tileContainer.addSubview(shareRailScrollView)

        // Added after the tiles, so both stay above whatever the grid does with
        // its own subviews. The pill takes the top-left corner; an inset parked
        // there is the one placement that covers it, which is the owner's call.
        readoutPill.isHidden = true
        addSubview(readoutPill)
        readoutPill.translatesAutoresizingMaskIntoConstraints = false
        knockBanner.isHidden = true
        knockBanner.onAdmit = { [weak self] in self?.onAdmitKnock?() }
        knockBanner.onDecline = { [weak self] in self?.onDeclineKnock?() }
        knockBanner.onShowQueue = { [weak self] in self?.onShowKnockQueue?() }
        addSubview(knockBanner)
        knockBanner.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            readoutPill.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            readoutPill.topAnchor.constraint(equalTo: topAnchor, constant: 14),
            knockBanner.centerXAnchor.constraint(equalTo: centerXAnchor),
            knockBanner.topAnchor.constraint(equalTo: topAnchor, constant: 14),
            knockBanner.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 14),
            knockBanner.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -14),
        ])
    }

    /// The room's own readout. Nil participants takes the pill off the stage —
    /// there is nothing to count before a meeting.
    func setStageReadout(participants: String?, duration: String?) {
        readoutPill.isHidden = participants == nil
        if let participants {
            readoutPill.setParticipants(participants)
        }
        readoutPill.setDuration(duration)
    }

    /// Somebody at the door, said on the stage. Nil name takes the banner down.
    func setKnock(name: String?, waiting: Int, busy: Bool) {
        guard let name, waiting > 0 else {
            knockBanner.isHidden = true
            return
        }
        knockBanner.configure(name: name, waiting: waiting, busy: busy)
        knockBanner.isHidden = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layout() {
        super.layout()
        layoutTiles()
        // Only the inset is yours to pick up, and only it says so under the
        // pointer. Set from the layout that decided it, not from meeting state:
        // a share or an empty room takes the tile somewhere it cannot be moved.
        tiles[Self.localTileID]?.isMovable = localTileIsInset
        reportRemoteTilePositions()
    }

    private func reportRemoteTilePositions() {
        guard let onRemoteTilePositions else { return }
        let size = tileContainer.bounds.size
        var positions: [String: SpatialAudioPosition] = [:]
        for entry in stageTiles() where !entry.isLocal && !entry.isScreenShare {
            guard let tile = tiles[entry.id] else { continue }
            let frame = tile.convert(tile.bounds, to: tileContainer)
            let center = NSPoint(x: frame.midX, y: frame.midY)
            positions[EnvisioningIdentity.accountAddress(entry.identity.lowercased())] =
                SpatialAudioPosition(flippedCenter: center, in: size)
        }
        onRemoteTilePositions(positions)
    }

    /// Prejoin only. In a meeting the square self tile is the one self-view;
    /// a full-stage preview behind it would show you twice.
    func showPrejoinCamera(deviceID: String?) {
        guard !showsLocalTile else {
            prejoinPreview.isHidden = true
            prejoinPreview.show(deviceID: nil)
            return
        }
        prejoinPreview.isHidden = false
        prejoinPreview.show(deviceID: deviceID)
    }

    func setPrejoinBackgroundEffect(_ effect: MeetingBackgroundEffect) {
        prejoinPreview.setBackgroundEffect(effect)
    }

    /// Hand the camera to another idle surface (the launch preview pane). Two
    /// capture sessions on one device flood CMIO, so whoever is on screen has
    /// to take the device rather than open a second one.
    func releasePrejoinCamera() async {
        await prejoinPreview.stopAndWait()
    }

    func prepareForConnection(localName: String) async {
        localDisplayName = localName.isEmpty ? String(localized: "You") : localName
        await prejoinPreview.stopAndWait()
        prejoinPreview.isHidden = true
        showsLocalTile = true
        localTrack = nil
        localScreenShareTrack = nil
        localIsSpeaking = false
        localHandRaised = false
        localQuality = .unknown
        remoteVideos = []
        rebuildTiles()
    }

    func showLocal(track: VideoTrack?) {
        showsLocalTile = true
        localTrack = track
        rebuildTiles()
    }

    /// Shows the local share as meeting content. It deliberately stays out of
    /// self-view controls: it owns the primary stage while the local camera
    /// remains in its separate self-view inset.
    func showLocalScreenShare(track: VideoTrack?) {
        localScreenShareTrack = track
        rebuildTiles()
    }

    /// Quality and speaking arrive far more often than the tile set changes, so
    /// they poke the existing tile instead of rebuilding the grid.
    func setLocalConnectionQuality(_ quality: MeetingConnectionQuality) {
        localQuality = quality
        tiles[Self.localTileID]?.setConnectionQuality(quality)
    }

    /// Welcome *you*, and nobody else. The other people on the stage get no
    /// signal that somebody arrived: a room that announces every entrance is a
    /// room that interrupts everyone in it. See docs/PRESENCE.md.
    func welcomeLocal() {
        tiles[Self.localTileID]?.flashWelcome()
    }

    /// Your own hand, so your tile badges like everybody else's. The host is a
    /// participant too, and a control that does not show on your own tile is a
    /// control you cannot tell worked.
    /// This Mac hosts the meeting; the self-view says so like any other tile.
    func setLocalIsHost(_ isHost: Bool) {
        guard isHost != localIsHost else { return }
        localIsHost = isHost
        rebuildTiles()
    }

    func setLocalHandRaised(_ raised: Bool) {
        guard raised != localHandRaised else { return }
        localHandRaised = raised
        rebuildTiles()
    }

    func setLocalSpeaking(_ isSpeaking: Bool) {
        guard isSpeaking != localIsSpeaking else { return }
        localIsSpeaking = isSpeaking
        tiles[Self.localTileID]?.setSpeaking(isSpeaking)
    }

    /// Drops the local tile from this Mac's own stage. Publishing is untouched:
    /// everyone else still sees the camera, the host just stops watching
    /// themselves.
    func setLocalTileHidden(_ hidden: Bool) {
        guard hidden != hidesLocalTile else { return }
        hidesLocalTile = hidden
        rebuildTiles()
    }

    /// Parks the inset somewhere else on the stage. Local to this Mac: nothing
    /// is published, nothing is told to anyone, and nobody else's stage moves.
    func setSelfPlacement(_ placement: SelfViewPlacement) {
        selfPlacement = placement
        SelfViewPreferences.placement = placement
        animatesSelfInsetMove = true
        needsLayout = true
    }

    /// Same shape as `setSelfPlacement`: the tile grows or shrinks in place,
    /// against the edge it is already parked on.
    func setSelfSize(_ size: SelfViewSize) {
        guard size != selfSize else { return }
        selfSize = size
        SelfViewPreferences.size = size
        animatesSelfInsetMove = true
        needsLayout = true
    }

    func setScreenShareLayoutChoice(_ choice: StageGridLayout.ScreenShareLayoutChoice) {
        guard choice != screenShareLayoutChoice else { return }
        screenShareLayoutChoice = choice
        StageGridLayout.ScreenShareLayoutPreferences.choice = choice
        needsLayout = true
    }

    /// Keeps the local tile off the stage while it lives in the floating PiP
    /// panel — same publish semantics as Hide me.
    func setLocalTileSuppressedForPiP(_ suppressed: Bool) {
        guard suppressed != suppressesLocalTileForPiP else { return }
        suppressesLocalTileForPiP = suppressed
        rebuildTiles()
    }

    func updateRemotes(_ videos: [MeetingRemoteVideo]) {
        remoteVideos = videos
        rebuildTiles()
    }

    func reset(deviceID: String?) {
        remoteVideos = []
        showsLocalTile = false
        localTrack = nil
        localScreenShareTrack = nil
        localIsSpeaking = false
        localHandRaised = false
        localQuality = .unknown
        hidesLocalTile = false
        suppressesLocalTileForPiP = false
        canModerateShares = false
        rebuildTiles()
        readoutPill.setWaitingHint(false)
        showPrejoinCamera(deviceID: deviceID)
    }

    private func stageTiles() -> [StageTile] {
        var stage: [StageTile] = []
        if showsLocalTile && !hidesLocalTile && !suppressesLocalTileForPiP {
            stage.append(
                StageTile(
                    id: Self.localTileID,
                    identity: Self.localTileID,
                    track: localTrack,
                    name: localDisplayName,
                    isScreenShare: false,
                    isSpeaking: localIsSpeaking,
                    handRaised: localHandRaised,
                    isHost: localIsHost,
                    quality: localQuality,
                    recording: false,
                    onBehalfOf: nil,
                    isLocal: true,
                    isSelfView: true,
                    stoppableShareIdentity: nil
                )
            )
        }
        if let localScreenShareTrack {
            stage.append(
                StageTile(
                    id: Self.localScreenShareTileID,
                    identity: Self.localTileID,
                    track: localScreenShareTrack,
                    name: "Your screen",
                    isScreenShare: true,
                    isSpeaking: false,
                    handRaised: false,
                    isHost: false,
                    quality: localQuality,
                    recording: false,
                    onBehalfOf: nil,
                    isLocal: true,
                    isSelfView: false,
                    stoppableShareIdentity: nil
                )
            )
        }
        for video in remoteVideos {
            stage.append(
                StageTile(
                    id: video.id,
                    identity: video.identity,
                    track: video.track,
                    name: video.participantName,
                    isScreenShare: video.isScreenShare,
                    isSpeaking: video.isSpeaking,
                    handRaised: video.handRaised,
                    isHost: video.isHost,
                    quality: video.quality,
                    recording: video.recording,
                    onBehalfOf: video.onBehalfOf,
                    isLocal: false,
                    isSelfView: false,
                    stoppableShareIdentity: video.isScreenShare && canModerateShares ? video.identity : nil
                )
            )
        }
        return stage
    }

    private func rebuildTiles() {
        let stage = stageTiles()
        let ids = Set(stage.map(\.id))

        for id in tiles.keys where !ids.contains(id) {
            tiles[id]?.removeFromSuperview()
            tiles[id] = nil
        }

        for entry in stage {
            let tile = tiles[entry.id] ?? ParticipantTileView()
            if tiles[entry.id] == nil {
                tile.onStopShare = { [weak self] identity in
                    self?.onStopScreenShare?(identity)
                }
                // Your own tile is the one on the stage you can pick up. A
                // remote tile keeps AppKit's ordinary routing, so the host's
                // stop-share button still gets its own clicks.
                if entry.isSelfView {
                    tile.onMouseEvent = { [weak self] event in
                        self?.dragSelfInset(event)
                    }
                    tile.onHideLocal = { [weak self] in
                        self?.onHideLocalSelf?()
                    }
                    tile.onMoveLocalToCorner = { [weak self] in
                        self?.onMoveLocalSelfToCorner?()
                    }
                }
                tileContainer.addSubview(tile)
                tiles[entry.id] = tile
            }
            tile.configure(entry)
        }

        // The inset overlaps whatever peers are behind it, and a tile added
        // later (somebody joining) would otherwise land on top of it.
        if let localTile = tiles[Self.localTileID] {
            tileContainer.addSubview(localTile, positioned: .above, relativeTo: nil)
        }

        // "Waiting" is only true when nobody else is here — a hidden local tile
        // on an otherwise empty stage is still an empty room.
        readoutPill.setWaitingHint(remoteVideos.isEmpty && localScreenShareTrack == nil)
        needsLayout = true
    }

    private func layoutTiles() {
        // Re-earned by `layoutSelfInset` on every pass: every other route
        // through this method puts the local tile somewhere it cannot be moved.
        localTileIsInset = false
        let stage = stageTiles()
        guard !stage.isEmpty else {
            restoreShareRailTiles()
            return
        }

        let bounds = tileContainer.bounds.insetBy(dx: stagePadding, dy: stagePadding)
        guard bounds.width > 1, bounds.height > 1 else {
            restoreShareRailTiles()
            return
        }

        let local = stage.first(where: \.isSelfView)
        let focus = focusTile(in: stage)

        // Your own camera is always the same small square reference tile. The
        // empty-room state remains visible around it, and the first person
        // joining does not cause the local video to change shape.
        let peers = stage.filter { !$0.isSelfView }

        // Everyone else gets the stage whole. The local camera stays separate,
        // including during screen share, so it never becomes a gallery peer.
        if let focus {
            let strip = focus.isScreenShare
                ? stage.filter { $0.id != focus.id && !$0.isSelfView }
                : peers.filter { $0.id != focus.id }
            layoutFocus(focus, strip: strip, in: bounds)
        } else {
            restoreShareRailTiles()
            layoutEqualGrid(peers, in: bounds)
        }
        layoutSelfInset(local, in: bounds)
        if let localTile = tiles[Self.localTileID], localTileIsInset {
            tileContainer.addSubview(localTile, positioned: .above, relativeTo: nil)
        }
    }

    /// The shared planner chooses between a small floating row and a reserved,
    /// scrollable rail. Native views only apply the returned frames.
    private func layoutFocus(_ focus: StageTile, strip: [StageTile], in bounds: NSRect) {
        guard !strip.isEmpty else {
            restoreShareRailTiles()
            tiles[focus.id]?.frame = bounds
            return
        }

        let localInset = selfInsetFrame(in: bounds).map { frame in
            CGRect(
                x: frame.minX - bounds.minX,
                y: bounds.maxY - frame.maxY,
                width: frame.width,
                height: frame.height
            )
        }
        let plan = StageGridLayout.screenSharePlan(
            in: bounds.size,
            participantCount: strip.count,
            localInset: localInset,
            choice: screenShareLayoutChoice,
            spacing: tileSpacing
        )
        guard let focusTile = tiles[focus.id] else { return }
        focusTile.setCompactScreenShareRailStyle(false)
        if focusTile.superview !== tileContainer {
            tileContainer.addSubview(focusTile)
        }
        focusTile.frame = appKitFrame(plan.shareFrame, in: bounds)

        switch plan.railMode {
        case .none:
            restoreShareRailTiles()
        case .overlay:
            layoutShareRail(strip, plan: plan, focusTile: focusTile, in: bounds)
        case .horizontal, .vertical:
            layoutShareRail(strip, plan: plan, focusTile: focusTile, in: bounds)
        }
    }

    private func layoutShareRail(
        _ strip: [StageTile],
        plan: StageGridLayout.ScreenSharePlan,
        focusTile: ParticipantTileView,
        in bounds: NSRect
    ) {
        let previousMode = shareRailMode
        let previousOrigin = shareRailScrollView.contentView.bounds.origin
        for (entry, frame) in zip(strip, plan.participantFrames) {
            guard let tile = tiles[entry.id] else { continue }
            tile.setCompactScreenShareRailStyle(true)
            if tile.superview !== shareRailDocumentView {
                shareRailDocumentView.addSubview(tile)
            }
            tile.frame = NSRect(origin: frame.origin, size: frame.size)
        }

        shareRailDocumentView.frame = NSRect(origin: .zero, size: plan.railContentSize)
        shareRailScrollView.frame = appKitFrame(plan.railFrame, in: bounds)
        shareRailScrollView.hasHorizontalScroller = plan.railMode == .horizontal || plan.railMode == .overlay
        shareRailScrollView.hasVerticalScroller = plan.railMode == .vertical
        shareRailScrollView.isHidden = false
        tileContainer.addSubview(shareRailScrollView, positioned: .above, relativeTo: focusTile)
        shareRailMode = plan.railMode

        let oldPoint = previousMode == plan.railMode ? previousOrigin : .zero
        let maxX = max(0, plan.railContentSize.width - shareRailScrollView.contentView.bounds.width)
        let maxY = max(0, plan.railContentSize.height - shareRailScrollView.contentView.bounds.height)
        shareRailScrollView.contentView.scroll(to: NSPoint(
            x: min(max(oldPoint.x, 0), maxX),
            y: min(max(oldPoint.y, 0), maxY)
        ))
        shareRailScrollView.reflectScrolledClipView(shareRailScrollView.contentView)
    }

    /// Bring the participant views back into the stage when no share is focused.
    /// Their ids and video renderers stay intact.
    private func restoreShareRailTiles() {
        for tile in tiles.values where tile.superview === shareRailDocumentView {
            tile.setCompactScreenShareRailStyle(false)
            tileContainer.addSubview(tile)
        }
        shareRailScrollView.isHidden = true
        shareRailScrollView.hasHorizontalScroller = false
        shareRailScrollView.hasVerticalScroller = false
        shareRailMode = .none
    }

    private func appKitFrame(_ topLeftFrame: CGRect, in bounds: NSRect) -> NSRect {
        NSRect(
            x: bounds.minX + topLeftFrame.minX,
            y: bounds.maxY - topLeftFrame.maxY,
            width: topLeftFrame.width,
            height: topLeftFrame.height
        )
    }

    /// The local tile, small and flush with whichever stage edge it has been
    /// parked against. Its square shape does not change when a camera reports
    /// portrait or landscape dimensions.
    private func layoutSelfInset(_ local: StageTile?, in bounds: NSRect) {
        guard let local, tiles[local.id] != nil else { return }
        guard let frame = selfInsetFrame(in: bounds) else { return }
        localTileIsInset = true
        // The pointer owns the frame while a drag is in flight; a camera
        // reporting a new shape mid-drag must not snatch the tile back.
        guard selfInsetDrag == nil else { return }
        layoutLocal(local, to: frame)
    }

    private func selfInsetFrame(in bounds: NSRect) -> NSRect? {
        guard let tile = tiles[Self.localTileID] else { return nil }
        if selfInsetDrag != nil { return tile.frame }
        let width = min(
            max(bounds.width * selfSize.widthFraction, selfSize.minWidth),
            min(selfSize.maxWidth, bounds.width)
        )
        let side = min(width, bounds.height)
        return selfPlacement.frame(for: NSSize(width: side, height: side), in: bounds)
    }

    /// Where the inset is free to be dragged: the padded stage, the same
    /// rectangle `layoutTiles` hands out.
    private func selfInsetBounds() -> NSRect {
        tileContainer.bounds.insetBy(dx: stagePadding, dy: stagePadding)
    }

    /// Drag your own head somewhere else. The tile follows the pointer while
    /// the button is down and snaps to the nearest of the six parking spots
    /// when it is let go, so a stage laid out at one window size still knows
    /// where the inset belongs at another.
    private func dragSelfInset(_ event: NSEvent) {
        guard localTileIsInset, let tile = tiles[Self.localTileID] else { return }
        switch event.type {
        case .leftMouseDown:
            selfInsetDrag = (
                grab: tileContainer.convert(event.locationInWindow, from: nil),
                origin: tile.frame.origin,
                moved: false
            )
        case .leftMouseDragged:
            guard var drag = selfInsetDrag else { return }
            let point = tileContainer.convert(event.locationInWindow, from: nil)
            let dx = point.x - drag.grab.x
            let dy = point.y - drag.grab.y
            // A click with a shiver in it is still a click.
            guard drag.moved || (dx * dx + dy * dy) > 9 else { return }
            if !drag.moved {
                drag.moved = true
                NSCursor.closedHand.set()
            }
            selfInsetDrag = drag
            tile.frame = clampToStage(
                NSRect(
                    x: drag.origin.x + dx,
                    y: drag.origin.y + dy,
                    width: tile.frame.width,
                    height: tile.frame.height
                )
            )
        case .leftMouseUp:
            guard let drag = selfInsetDrag else { return }
            selfInsetDrag = nil
            guard drag.moved else { return }
            NSCursor.openHand.set()
            // Set even when the nearest spot is the one it started in: the tile
            // is currently sitting wherever the pointer let go of it, and only a
            // layout pass puts it back flush with an edge.
            setSelfPlacement(SelfViewPlacement.nearest(to: tile.frame, in: selfInsetBounds()))
        default:
            selfInsetDrag = nil
        }
    }

    /// Keeps a dragged inset inside the stage. Half off the edge is a tile you
    /// cannot pick up again.
    private func clampToStage(_ frame: NSRect) -> NSRect {
        let bounds = selfInsetBounds()
        return NSRect(
            x: min(max(frame.minX, bounds.minX), max(bounds.minX, bounds.maxX - frame.width)),
            y: min(max(frame.minY, bounds.minY), max(bounds.minY, bounds.maxY - frame.height)),
            width: frame.width,
            height: frame.height
        )
    }

    /// Frames the local tile, animating only a placement change. Every other
    /// pass — a window resize, a camera reporting a new shape — sets the frame
    /// outright, so ordinary layout stays instant.
    private func layoutLocal(_ local: StageTile?, to frame: NSRect) {
        let moved = animatesSelfInsetMove
        animatesSelfInsetMove = false
        guard let local, let tile = tiles[local.id] else { return }
        // A tile that has never been laid out has no frame to animate from, and
        // one off-screen has nobody to animate for.
        guard moved, window != nil, !tile.frame.isEmpty else {
            tile.frame = frame
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.22
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            context.allowsImplicitAnimation = true
            tile.animator().frame = frame
        }
    }

    /// Which tile gets the big frame, with the shared planner placing the
    /// participant rail around it. Nil means the stage is an equal grid.
    private func focusTile(in stage: [StageTile]) -> StageTile? {
        stage.first(where: \.isScreenShare)
    }

    private func layoutEqualGrid(_ stage: [StageTile], in rect: NSRect) {
        let plan = StageGridLayout.equalGridPlan(
            tileCount: stage.count,
            in: rect.size,
            spacing: tileSpacing
        )
        let gridHeight = CGFloat(plan.rows) * plan.cell.height + CGFloat(plan.rows - 1) * tileSpacing
        // The block is centred as a block. Dividing the slack between the rows
        // instead is what pushed the tiles apart: two rows of cameras with a
        // corridor of empty stage down the middle of the window.
        let top = rect.maxY - max(0, (rect.height - gridHeight) / 2)

        for (index, entry) in stage.enumerated() {
            guard let tile = tiles[entry.id] else { continue }
            let row = index / plan.columns
            let column = index % plan.columns
            // A short last row is centred under the full ones, so five people
            // read as 3 + 2 rather than as a row with a hole on the right.
            let inRow = min(plan.columns, stage.count - row * plan.columns)
            let rowWidth = CGFloat(inRow) * plan.cell.width + CGFloat(inRow - 1) * tileSpacing
            let x = rect.minX + max(0, (rect.width - rowWidth) / 2)
                + CGFloat(column) * (plan.cell.width + tileSpacing)
            let y = top - CGFloat(row + 1) * plan.cell.height - CGFloat(row) * tileSpacing
            let cell = NSRect(x: x, y: y, width: plan.cell.width, height: plan.cell.height)
            tile.frame = cell
        }
    }

}

/// The shared planner uses top-left frames on both native clients. Flipping the
/// document view lets AppKit consume those rail-content frames unchanged.
private final class StageRailDocumentView: NSView {
    override var isFlipped: Bool { true }
}

/// A compact quality mark pinned to the bottom-right of every square tile. The
/// exact state remains available as the image's accessibility label and tooltip.
@MainActor
private func makeConnectionQualityIcon() -> NSImageView {
    let imageView = NSImageView()
    imageView.imageScaling = .scaleProportionallyDown
    imageView.wantsLayer = true
    imageView.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.68).cgColor
    imageView.layer?.cornerRadius = 6
    return imageView
}

@MainActor
private func applyConnectionQualityIcon(_ quality: MeetingConnectionQuality, to imageView: NSImageView) {
    let label = quality.tileIconAccessibilityLabel
    imageView.image = NSImage(
        systemSymbolName: quality.tileIconSystemName,
        variableValue: quality.tileSignalValue,
        accessibilityDescription: label
    )?.withSymbolConfiguration(.init(pointSize: 12, weight: .semibold))
    imageView.contentTintColor = StarlingsColors.resolved(
        quality.isWeak ? StarlingsColors.danger : StarlingsColors.primaryText,
        for: imageView
    )
    imageView.toolTip = label
    imageView.setAccessibilityLabel(label)
}

/// Outline around a tile: accent for whoever is currently talking, sharing blue
/// for a screen share.
///
/// It is its own view rather than a layer on the tile because `VideoView`
/// rebuilds its renderer whenever the track, the render mode, or the display
/// changes, and each rebuild appends a fresh Metal layer to the tile's layer
/// tree. A sibling layer therefore has to be restacked on top after every one
/// of those — and the ones that arrive without a layout pass (a camera
/// unmuting mid-call, most of all) left the ring buried under the video with
/// nothing to bring it back. Subview order is not up for renegotiation the same
/// way: `VideoView`'s layers live inside its own subtree, so an overlay added
/// after it stays above it for good.
@MainActor
private final class TileOutlineView: NSView {
    /// Sharing outranks speaking: while a tile carries someone's desktop, that
    /// is the more important thing to know about it. A share never sets
    /// `.speaking` anyway (`configure` suppresses it), so the two never race.
    enum Style {
        case none
        case speaking
        case sharing
        /// Drawn once, on your own tile, the moment you arrive — then faded
        /// out. It shares the accent with `speaking` deliberately: a second
        /// ring colour would be a new thing to learn, and these two can never
        /// be confused because nobody is speaking in the instant they join.
        case welcome

        var color: NSColor? {
            switch self {
            case .none: nil
            case .speaking, .welcome: StarlingsColors.accent
            // Neutral, not blue — the point was always to not reuse the
            // speaking accent, not to read as any particular hue. The tile's
            // own screen-share glyph badge carries the rest of the signal.
            case .sharing: StarlingsColors.secondaryText
            }
        }
    }

    static let width: CGFloat = 3
    static let remoteCornerRadius: CGFloat = 12

    private let ring = CAShapeLayer()

    var style: Style = .none {
        didSet {
            guard style != oldValue else { return }
            guard let color = style.color else {
                ring.isHidden = true
                return
            }
            ring.strokeColor = StarlingsColors.resolved(color, for: self).cgColor
            ring.isHidden = false
        }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        ring.fillColor = nil
        ring.strokeColor = StarlingsColors.resolved(StarlingsColors.accent, for: self).cgColor
        ring.lineWidth = Self.width
        ring.isHidden = true
        ring.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
        layer?.addSublayer(ring)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Purely decorative — never take the click away from the tile beneath.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        // Half the stroke sits either side of the path, so inset by half a
        // width to keep it inside bounds — the tile clips to its corner radius.
        let inset = Self.width / 2
        let local = CGRect(origin: .zero, size: bounds.size)
        let rect = local.insetBy(dx: inset, dy: inset)
        let radius = max(0, Self.remoteCornerRadius - inset)
        // The implicit animation on `path` would smear the ring across a resize.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ring.frame = local
        ring.path = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
        CATransaction.commit()
    }
}

@MainActor
private final class ParticipantTileView: NSView {
    private let videoView = VideoView()
    private let avatar = ParticipantAvatarView()
    private let nameLabel = NSTextField(labelWithString: "")
    private let connectionQualityIcon = makeConnectionQualityIcon()
    private var usesCompactScreenShareRailStyle = false
    private let outline = TileOutlineView()
    /// The welcome, which is a separate view rather than a `style` on `outline`
    /// for one reason: the first speaking update after you join would otherwise
    /// wipe it mid-fade, and the two are answering different questions.
    private let welcomeOutline = TileOutlineView()
    /// Styled in `init` rather than here: the convenience initializer applies a
    /// height constraint, and this button must be out of the autoresizing world
    /// before it gets one.
    private let stopShareButton = StarlingsFilledButton(frame: .zero)
    /// Shown for as long as this tile is a screen share — the ring alone is
    /// neutral now, so this glyph is what tells a share apart from a plain
    /// speaking tile at a glance.
    private let shareBadge = NSImageView()
    private let recordingBadge = NSImageView()
    /// The local tile's only direct actions: hide the private preview, or park
    /// it in the bottom-left corner. The full self-view menu remains on the
    /// control row; these are the two actions people reach for from the tile.
    private let hideLocalButton = NSButton()
    private let cornerLocalButton = NSButton()
    /// Top-left, the one corner of a tile nothing else claims: the hover
    /// cluster is top-right and the name plate is along the bottom. Always
    /// visible while the hand is up, unlike the hover affordances — a badge you
    /// have to go looking for is not an answer to "who is waiting".
    private let handBadge = NSImageView()
    private var tileHover: StarlingsHoverMonitor?
    private var isHovered = false
    /// Latched from `configure`, so a speaking update can never repaint a share
    /// tile's sharing outline as an ordinary speaking ring.
    private var isScreenShare = false
    private var stoppableShareIdentity: String?

    /// Shape of the frames arriving on this track, once it has reported one.
    /// Nil while the camera is off or the first frame is still in flight. This
    /// is used only for the media crop, never for stage geometry.
    private var sourceSize: CGSize?
    private var faceCenteringTimer: Timer?
    private var faceCenteringTracker = FaceCenteringTracker()

    /// Host pressed stop on this tile; carries the sharer's LiveKit identity.
    var onStopShare: ((String) -> Void)?

    /// Mouse down / dragged / up, forwarded whole so the stage can move the
    /// self-inset. Set on the local tile only; every other tile keeps AppKit's
    /// ordinary routing.
    var onMouseEvent: ((NSEvent) -> Void)?

    var onHideLocal: (() -> Void)?
    var onMoveLocalToCorner: (() -> Void)?

    /// True while this tile is the self-inset, which is the one tile on the
    /// stage that can be picked up and put somewhere else. The open-hand cursor
    /// is the drag affordance; the hover buttons are reserved for actions.
    var isMovable = false {
        didSet {
            guard isMovable != oldValue else { return }
            // The hand belongs to a tile you can actually pick up.
            tileHover?.cursor = isMovable ? .openHand : nil
            applyHoverAffordances()
        }
    }

    /// Point of the source frame that should land in the middle of the tile,
    /// normalised from its top-left. The default is centred horizontally and
    /// biased above the middle vertically; anything that knows better about
    /// where the face is — a Vision pass here, or an anchor published by the
    /// sender — sets it per tile.
    var cropAnchor = StageGridLayout.defaultCropAnchor {
        didSet {
            guard cropAnchor != oldValue else { return }
            if window != nil, !isScreenShare, sourceSize != nil {
                animateVideoCrop()
            } else {
                needsLayout = true
            }
        }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.panel, for: self).cgColor
        layer?.cornerRadius = TileOutlineView.remoteCornerRadius
        layer?.masksToBounds = true

        videoView.layoutMode = .fill
        videoView.renderMode = .sampleBuffer
        addSubview(videoView)
        // Framed by hand in `layoutVideo` rather than pinned to the tile:
        // filling a tile crops the camera, and that crop only has an anchor if
        // this view can sit larger than — and offset within — the tile clipping
        // it. Pinned edges can only ever centre the crop.
        videoView.autoresizingMask = []

        avatar.isHidden = true
        addSubview(avatar)
        avatar.translatesAutoresizingMaskIntoConstraints = false

        nameLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold)
        nameLabel.textColor = .white
        StarlingsFloatingGlass.scrim(nameLabel, cornerRadius: 6)
        nameLabel.lineBreakMode = .byTruncatingTail
        // Keep the full name when the tile has room; the trailing bound still
        // lets AppKit truncate it cleanly when a narrow tile really needs it.
        nameLabel.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        addSubview(nameLabel)
        nameLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(connectionQualityIcon)
        connectionQualityIcon.translatesAutoresizingMaskIntoConstraints = false

        // Top-right, opposite the name badge and the quality mark, so the one
        // destructive control on the stage never sits where a label just was.
        // Before `apply`, which activates its own height constraint.
        stopShareButton.translatesAutoresizingMaskIntoConstraints = false
        stopShareButton.apply(
            .danger,
            title: String(localized: "Stop sharing"),
            font: .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold),
            cornerRadius: 6,
            height: 24,
            symbolName: "rectangle.on.rectangle.slash"
        )
        stopShareButton.target = self
        stopShareButton.action = #selector(stopSharePressed)
        stopShareButton.isHidden = true

        NSLayoutConstraint.activate([
            avatar.centerXAnchor.constraint(equalTo: centerXAnchor),
            avatar.centerYAnchor.constraint(equalTo: centerYAnchor),
            nameLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            nameLabel.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -10),
            nameLabel.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
            connectionQualityIcon.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            connectionQualityIcon.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
            connectionQualityIcon.widthAnchor.constraint(equalToConstant: 24),
            connectionQualityIcon.heightAnchor.constraint(equalToConstant: 24),
        ])

        shareBadge.image = NSImage(
            systemSymbolName: "rectangle.on.rectangle",
            accessibilityDescription: String(localized: "Sharing their screen")
        )?.withSymbolConfiguration(.init(pointSize: 11, weight: .semibold))
        shareBadge.contentTintColor = .white
        StarlingsFloatingGlass.scrim(shareBadge, cornerRadius: 6)
        shareBadge.isHidden = true
        recordingBadge.image = NSImage(
            systemSymbolName: "record.circle.fill",
            accessibilityDescription: String(localized: "Recording notetaker")
        )?.withSymbolConfiguration(.init(pointSize: 12, weight: .semibold))
        recordingBadge.contentTintColor = StarlingsColors.danger
        recordingBadge.toolTip = String(localized: "Recording notetaker")
        recordingBadge.setAccessibilityLabel(String(localized: "Recording notetaker"))
        recordingBadge.isHidden = true
        StarlingsFloatingGlass.scrim(recordingBadge, cornerRadius: 6)

        configureLocalActionButton(
            hideLocalButton,
            symbolName: "eye.slash",
            accessibilityLabel: String(localized: "Hide your self-view")
        )
        hideLocalButton.target = self
        hideLocalButton.action = #selector(hideLocalPressed)

        configureLocalActionButton(
            cornerLocalButton,
            symbolName: "arrow.down.left",
            accessibilityLabel: String(localized: "Put your self-view in the bottom-left corner")
        )
        cornerLocalButton.target = self
        cornerLocalButton.action = #selector(moveLocalToCornerPressed)

        handBadge.image = NSImage(
            systemSymbolName: "hand.raised.fill",
            accessibilityDescription: String(localized: "Hand raised")
        )?.withSymbolConfiguration(.init(pointSize: 12, weight: .semibold))
        handBadge.contentTintColor = StarlingsColors.resolved(StarlingsColors.accentInk, for: self)
        handBadge.wantsLayer = true
        handBadge.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.accent, for: self).cgColor
        handBadge.layer?.cornerRadius = 13
        handBadge.isHidden = true
        handBadge.toolTip = String(localized: "Hand raised")
        addSubview(handBadge)
        handBadge.translatesAutoresizingMaskIntoConstraints = false

        // `shareBadge` sits in this cluster too rather than sharing the
        // warning pill's top-leading corner — the two can coexist on a
        // shared tile with a degraded connection.
        let cluster = NSStackView(
            views: [
                shareBadge,
                recordingBadge,
                cornerLocalButton,
                hideLocalButton,
                stopShareButton,
            ]
        )
        cluster.orientation = .horizontal
        cluster.alignment = .centerY
        cluster.spacing = 6
        addSubview(cluster)
        cluster.translatesAutoresizingMaskIntoConstraints = false

        NSLayoutConstraint.activate([
            cluster.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            cluster.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            shareBadge.widthAnchor.constraint(equalToConstant: 24),
            shareBadge.heightAnchor.constraint(equalToConstant: 24),
            recordingBadge.widthAnchor.constraint(equalToConstant: 24),
            recordingBadge.heightAnchor.constraint(equalToConstant: 24),
            cornerLocalButton.widthAnchor.constraint(equalToConstant: 24),
            cornerLocalButton.heightAnchor.constraint(equalToConstant: 24),
            hideLocalButton.widthAnchor.constraint(equalToConstant: 24),
            hideLocalButton.heightAnchor.constraint(equalToConstant: 24),
            handBadge.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            handBadge.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            handBadge.widthAnchor.constraint(equalToConstant: 26),
            handBadge.heightAnchor.constraint(equalToConstant: 26),
        ])

        // Installed once: re-tracking a view on every layout pass stacks
        // tracking areas on it. The cursor is swapped by `isMovable`.
        tileHover = trackMeetHover(cursor: .openHand) { [weak self] hovered in
            guard let self else { return }
            isHovered = hovered
            applyHoverAffordances()
        }
        tileHover?.cursor = nil

        // Last subview, so it stays above the video no matter how often
        // VideoView rebuilds its renderer.
        addSubview(outline)
        outline.translatesAutoresizingMaskIntoConstraints = false
        outline.pinToEdges(of: self)

        addSubview(welcomeOutline)
        welcomeOutline.translatesAutoresizingMaskIntoConstraints = false
        welcomeOutline.pinToEdges(of: self)
        welcomeOutline.alphaValue = 0
    }

    /// The inset is dragged as one object: while it can be moved, nothing
    /// inside it — least of all `VideoView` — gets to answer the click first.
    /// Every other tile hit-tests as usual, so the host's stop-share button
    /// keeps its own.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard isMovable else { return super.hitTest(point) }
        let hit = super.hitTest(point)
        if hit === hideLocalButton || hit === cornerLocalButton {
            return hit
        }
        return hit == nil ? nil : self
    }

    override func mouseDown(with event: NSEvent) {
        guard let onMouseEvent else { return super.mouseDown(with: event) }
        onMouseEvent(event)
    }

    override func mouseDragged(with event: NSEvent) {
        guard let onMouseEvent else { return super.mouseDragged(with: event) }
        onMouseEvent(event)
    }

    override func mouseUp(with event: NSEvent) {
        guard let onMouseEvent else { return super.mouseUp(with: event) }
        onMouseEvent(event)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            faceCenteringTimer?.invalidate()
            faceCenteringTimer = nil
            faceCenteringTracker.reset()
        } else if faceCenteringTimer == nil {
            faceCenteringTimer = Timer.scheduledTimer(withTimeInterval: 1.25, repeats: true) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.updateFaceCentering()
                }
            }
            faceCenteringTimer?.tolerance = 0.25
        }
    }

    override func layout() {
        super.layout()
        avatar.resize(forHost: bounds)
        layoutVideo()
    }

    /// A share is letterboxed by `VideoView` itself (`.fit`) and takes the tile
    /// whole. A camera fills the tile and is cropped for it, so the view is
    /// sized to the full aspect-fill rect and slid inside the tile's clip until
    /// `cropAnchor` sits in the middle.
    ///
    /// The oversize is deliberate for adaptive stream too: `VideoView` reports
    /// its own size to the SFU, and the layer it picks should cover the pixels
    /// being cropped away, not just the ones left on screen.
    private func layoutVideo() {
        guard !isScreenShare, let sourceSize else {
            videoView.frame = bounds
            return
        }
        videoView.frame = videoFrame(for: sourceSize)
    }

    /// Face detection arrives in samples rather than a video-rate stream. The
    /// crop therefore needs its own short interpolation, otherwise every
    /// otherwise-correct anchor reads as a camera jump.
    private func animateVideoCrop() {
        guard let sourceSize else {
            needsLayout = true
            return
        }
        let frame = videoFrame(for: sourceSize)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.45
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            context.allowsImplicitAnimation = true
            videoView.animator().frame = frame
        }
    }

    private func videoFrame(for sourceSize: CGSize) -> CGRect {
        // Mirroring flips what the renderer draws, so an off-centre anchor has
        // to flip with it or self-view pans away from the face.
        let anchor = CGPoint(
            x: videoView.mirrorMode == .mirror ? 1 - cropAnchor.x : cropAnchor.x,
            y: cropAnchor.y
        )
        return StageGridLayout.videoFrame(
            inTile: bounds,
            sourceSize: sourceSize,
            anchor: anchor
        )
    }

    /// Face detection is deliberately slow and bounded: one pass per visible
    /// camera every 1.25 seconds, with the last good anchor held through a
    /// missed frame. The grid never waits for this work and never reflows.
    private func updateFaceCentering() {
        guard !isScreenShare,
              !videoView.isHidden,
              (bounds.width >= 140 || videoView.mirrorMode == .mirror)
        else {
            faceCenteringTracker.reset()
            cropAnchor = StageGridLayout.defaultCropAnchor
            return
        }
        let target = FaceCentering.anchor(for: videoView.track?.videoFrame)
        cropAnchor = faceCenteringTracker.update(
            target: target,
            at: ProcessInfo.processInfo.systemUptime
        )
    }

    /// Dimensions can change mid-call — a publisher switching camera, or a
    /// different simulcast layer arriving — and both the tile's shape and its
    /// crop are computed from them.
    private func setSourceSize(_ dimensions: Dimensions?) {
        var size: CGSize?
        if let dimensions, dimensions.width > 0, dimensions.height > 0 {
            size = CGSize(width: CGFloat(dimensions.width), height: CGFloat(dimensions.height))
        }
        guard size != sourceSize else { return }
        sourceSize = size
        needsLayout = true
    }

    func configure(_ entry: StageTile) {
        isLocalTile = entry.isSelfView
        handBadge.toolTip = entry.isLocal ? nil : "Hand raised"
        applyConnectionQualityIcon(entry.quality, to: connectionQualityIcon)
        videoView.mirrorMode = entry.isSelfView ? .mirror : .auto
        // Reassigning the same track tears down and rebuilds the renderer, so
        // only touch it when the track really changed.
        if videoView.track !== entry.track {
            faceCenteringTracker.reset()
            cropAnchor = StageGridLayout.defaultCropAnchor
            videoView.track?.remove(delegate: self)
            videoView.track = entry.track
            entry.track?.add(delegate: self)
            // Dimensions are usually already known for a track that has been
            // rendering elsewhere; the delegate covers the ones that are not.
            setSourceSize(entry.track?.dimensions)
        }
        // A camera-off tile must not keep the last frame on screen: hiding the
        // video view blanks it, and the avatar says who is behind it.
        videoView.isHidden = entry.track == nil
        videoView.layoutMode = entry.isScreenShare ? .fit : .fill
        avatar.initials = ParticipantInitials.make(from: entry.name)
        avatar.isHidden = entry.track != nil || entry.isScreenShare
        if isScreenShare != entry.isScreenShare {
            faceCenteringTracker.reset()
            cropAnchor = StageGridLayout.defaultCropAnchor
        }
        isScreenShare = entry.isScreenShare
        applyCompactScreenShareRailStyle()
        shareBadge.isHidden = !entry.isScreenShare
        recordingBadge.isHidden = !entry.recording || entry.isScreenShare
        let label: String
        if entry.isScreenShare {
            label = entry.isLocal ? String(localized: "Your screen") : String(localized: "\(entry.name) · Screen")
        } else if entry.isHost {
            label = String(localized: "\(entry.name) · Host")
        } else {
            label = entry.name
        }
        nameLabel.stringValue = "  \(label)  "
        let tileLabel: String
        if entry.isScreenShare {
            tileLabel = entry.isLocal
                ? String(localized: "Your shared screen")
                : "\(entry.name) is sharing their screen"
        } else {
            tileLabel = entry.name
        }
        let consentLabel = entry.recording
            ? String(localized: "Recording notetaker") + (entry.onBehalfOf.map { ", sent by \($0)" } ?? "")
            : nil
        setAccessibilityLabel(([tileLabel, consentLabel, entry.quality.tileIconAccessibilityLabel].compactMap { $0 }).joined(separator: ", "))
        // Re-derived from hover state, never forced hidden: `configure` runs on
        // every stage tick (your own speaking level included), and a hard hide
        // here pulled the buttons out from under the pointer on its way to them.
        applyHoverAffordances()
        stoppableShareIdentity = entry.stoppableShareIdentity
        stopShareButton.isHidden = entry.stoppableShareIdentity == nil
        stopShareButton.setAccessibilityLabel(String(localized: "Stop \(entry.name)’s screen share"))
        setSpeaking(entry.isSpeaking && !entry.isScreenShare)
        // A screen has no hand: the badge belongs to the person, and their
        // camera tile is where it goes.
        handBadge.isHidden = !(entry.handRaised && !entry.isScreenShare)
        // A tile can change between share and camera without changing frame,
        // and the two lay their video out differently.
        needsLayout = true
    }

    /// What the pointer reveals: the grip and the two local actions on a tile
    /// you can move.
    private func applyHoverAffordances() {
        hideLocalButton.isHidden = !(isLocalTile && isHovered)
        cornerLocalButton.isHidden = !(isLocalTile && isMovable && isHovered)
    }

    private var isLocalTile = false

    private func configureLocalActionButton(
        _ button: NSButton,
        symbolName: String,
        accessibilityLabel: String
    ) {
        button.isBordered = false
        button.bezelStyle = .inline
        button.image = NSImage(
            systemSymbolName: symbolName,
            accessibilityDescription: accessibilityLabel
        )?.withSymbolConfiguration(.init(pointSize: 11, weight: .semibold))
        button.contentTintColor = .white
        StarlingsFloatingGlass.scrimButton(button, cornerRadius: 6)
        button.setAccessibilityLabel(accessibilityLabel)
        button.isHidden = true
    }

    @objc private func hideLocalPressed() {
        onHideLocal?()
    }

    @objc private func moveLocalToCornerPressed() {
        onMoveLocalToCorner?()
    }

    @objc private func stopSharePressed() {
        guard let stoppableShareIdentity else { return }
        onStopShare?(stoppableShareIdentity)
    }

    func setConnectionQuality(_ quality: MeetingConnectionQuality) {
        applyConnectionQualityIcon(quality, to: connectionQualityIcon)
    }

    /// The thumbnails beside a focused share keep their identity and quality
    /// in the accessibility label, while clearing visual overlays from the
    /// small participant rail.
    func setCompactScreenShareRailStyle(_ compact: Bool) {
        guard compact != usesCompactScreenShareRailStyle else { return }
        usesCompactScreenShareRailStyle = compact
        applyCompactScreenShareRailStyle()
    }

    private func applyCompactScreenShareRailStyle() {
        nameLabel.alphaValue = usesCompactScreenShareRailStyle && !isScreenShare ? 0 : 1
        connectionQualityIcon.alphaValue = usesCompactScreenShareRailStyle ? 0 : 1
    }

    func setSpeaking(_ isSpeaking: Bool) {
        outline.style = isScreenShare ? .sharing : (isSpeaking ? .speaking : .none)
    }

    /// The room noticing you arrived: a ring that appears and then goes away on
    /// its own. Nothing to dismiss and nothing to answer — it is over before
    /// anybody could act on it, which is the whole of the gesture.
    func flashWelcome() {
        welcomeOutline.style = .welcome
        welcomeOutline.alphaValue = 1
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 2.5
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            welcomeOutline.animator().alphaValue = 0
        } completionHandler: {
            // Back to nothing, so a second join draws it fresh rather than
            // animating a ring that is technically still there at zero alpha.
            // The handler is `@Sendable`, so hopping back on is explicit.
            Task { @MainActor [weak self] in self?.welcomeOutline.style = .none }
        }
    }
}

extension ParticipantTileView: TrackDelegate {
    /// Arrives off the main actor, and can arrive from a track this tile has
    /// already moved on from — the delegate list is weak, so a removal that
    /// races a notification still lands here.
    nonisolated func track(_ track: VideoTrack, didUpdateDimensions dimensions: Dimensions?) {
        Task { @MainActor [weak self] in
            guard let self, self.videoView.track === track else { return }
            self.setSourceSize(dimensions)
        }
    }
}
