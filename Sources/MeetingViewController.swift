import AppKit
import LiveKit
import StarlingsContracts
import SwiftUI
import UniformTypeIdentifiers

enum LobbyKnockPreferences {
    private static let alertsKey = "meet.lobbyKnockAlertsEnabled"

    /// Sound + Dock bounce when a guest enters the waiting room. Default on.
    static var alertsEnabled: Bool {
        get {
            UserDefaults.standard.object(forKey: alertsKey) as? Bool ?? true
        }
        set {
            UserDefaults.standard.set(newValue, forKey: alertsKey)
        }
    }
}

enum TranscriptPanelPreferences {
    private static let expandedKey = "meet.transcriptPanelExpanded"

    /// Captions on screen. Default off — most meetings do not need them, and the
    /// panel costs stage height on every Mac. The transcript itself is unaffected:
    /// segments still arrive, finalize, and upload while this is collapsed.
    static var isExpanded: Bool {
        get {
            UserDefaults.standard.object(forKey: expandedKey) as? Bool ?? false
        }
        set {
            UserDefaults.standard.set(newValue, forKey: expandedKey)
        }
    }

    /// Every new Mac meeting starts with captions folded, even if the previous
    /// meeting was left open. The disclosure can still be opened for the
    /// current meeting and remembers that choice until the next one starts.
    static func resetForMeetingStart() {
        isExpanded = false
    }
}

enum MeetingPanelPreferences {
    private static let collapsedKey = "meet.meetingPanelCollapsed"

    /// The rail's ceiling. Its floor is the shell's
    /// (`StarlingsShellViewController.Column.inspectorMinimum`); the width it was
    /// left at is the shell's split-view autosave, the same as Calendar's and
    /// Work's inspectors. The ceiling is lower than theirs because a meeting
    /// rail is a list, not a reading column.
    static let railMaximumWidth: CGFloat = 420

    /// The meeting rail closed, for a stage that wants the whole window.
    /// Only ever honoured in a live meeting: idle, the rail *is* the screen —
    /// Host/Join, the room field, and the button that starts anything.
    static var isCollapsed: Bool {
        get {
            UserDefaults.standard.bool(forKey: collapsedKey)
        }
        set {
            UserDefaults.standard.set(newValue, forKey: collapsedKey)
        }
    }
}

/// The stage, the control row and the transcript — the middle column of
/// `StarlingsRoomShellViewController`, in the Room window. The meeting rail is
/// built here too (`railView`) but stands in the shell's inspector column, so
/// it collapses, resizes and answers ⌃⌘I the way Calendar's and Work's do.
/// Home's launch card is built here as well (`homeView`) and stands in the
/// Home window, so a meeting never takes Home off the screen.
@MainActor
final class MeetingViewController: NSViewController {
    var onMenubarStateChange: ((MeetingMenubarSnapshot) -> Void)?
    /// The main window owns the update destination and the install handoff;
    /// this surface only reports the one action the banner was given.
    var onUpdateAction: (() -> Void)?
    /// Home's Quick Notes card sends capture to the app-wide watcher, which
    /// keeps the list alive even when this window is hidden.
    var onCreateQuickNote: ((String) -> Void)?
    var onUpdateQuickNote: ((QuickNote, String) -> Void)?
    var onTriageQuickNote: ((QuickNote) -> Void)?
    var onDeleteQuickNote: ((QuickNote) -> Void)?
    var onMoveQuickNote: ((QuickNote, StarlingsWorkspace) -> Void)?
    private let devices = MediaDeviceService()
    private let meetingSession: MeetingSession
    private let controlAPI: MeetingControlAPI
    private let ownerSessionStore: OwnerSessionStore
    private let ownerAuthenticator: GoogleOwnerAuthenticator
    private lazy var artifactOutbox = MeetingArtifactOutbox(api: controlAPI)
    private var connectivityRecovery: ConnectivityRecovery?

    private let meetingStage = MeetingStageView()
    private let ownerLaunchView = OwnerLaunchView()
    private let updateBanner = UpdateBannerView()
    /// Brand-tinged grid behind the launch surface. Hidden during calls.
    private let brandGridBackground = BrandGridBackground(frame: .zero)
    /// Home: the launch card, in the Home window. Built here with the rest of
    /// the surface and mounted by `StarlingsHomeViewController`, the way the
    /// rail is mounted by the Room window's shell. The stage is the Room
    /// window's; Home stays on screen while a meeting runs.
    private(set) var homeView: NSView!
    private let homeGridBackground = BrandGridBackground(frame: .zero)
    private let homeUpdateBanner = UpdateBannerView()
    /// Whether the stage has anything to show: a meeting, an admission, or
    /// the Join form. The window controller opens the Room window on true
    /// and closes it on false (`onStageVisibilityChange`).
    private(set) var isStageVisible = false
    var isHostRole: Bool { currentRole == .host }
    var onStageVisibilityChange: ((Bool) -> Void)?
    /// Home's Start while the stage is up: bring the Room window forward
    /// rather than start or leave anything.
    var onShowRoom: (() -> Void)?
    private var meetingBodyView: NSView!
    /// The stage's top, in the two places it can be. Outside Focus the body
    /// starts under the toolbar's soft edge, at the safe area, so the stage's
    /// own pills clear the glass; in Focus the toolbar is gone and the stage
    /// takes the window to its edge. `applyFocusChrome` swaps them.
    private var bodyTopAtSafeArea: NSLayoutConstraint!
    private var bodyTopAtEdge: NSLayoutConstraint!
    /// The meeting rail. Built with the rest of the surface, mounted by the
    /// shell as this window's inspector column; whether it is standing is
    /// `applyMeetingPanelVisibility`'s to say.
    private(set) var railView: NSView!
    /// The stage owns the gap to the rail while the rail is standing: the
    /// shell's column gutter, so the tiles stop short of the panel the way
    /// Calendar's grid does. When the rail is hidden the gap goes to zero;
    /// keeping it would leave a phantom strip on the right and visibly shift
    /// the whole meeting surface left.
    private var stageTrailingToRail: NSLayoutConstraint!
    private let cameraPopup = NSPopUpButton()
    private let microphonePopup = NSPopUpButton()
    private let speakerPopup = NSPopUpButton()
    private let microphoneMenu = NSMenu()
    private let cameraMenu = NSMenu()
    /// The chevrons beside Mute and Camera. The device menus were always on
    /// those buttons — right-click, press-and-hold — but nothing on the row
    /// said so, and a headset plugged in mid-call is not the moment to go
    /// hunting. Zoom puts a chevron there; so do we.
    private let microphoneChooserButton = StarlingsMeetingControlButton(title: "", symbol: "chevron.down")
    private let cameraChooserButton = StarlingsMeetingControlButton(title: "", symbol: "chevron.down")
    private let nameField = StarlingsTextField(placeholder: String(localized: "Your name"))
    private let emailField = StarlingsTextField(placeholder: EnvisioningDeployment.exampleAddress)
    private let roomField = StarlingsTextField(placeholder: String(localized: "Room name"))
    private let bookingContextLabel = StarlingsTypography.wrappingLabel("")
    private let modeControl = StarlingsSegmentedControl(labels: [String(localized: "Your room"), String(localized: "Join")])
    private let startButton = NSButton(title: String(localized: "Ask to join"), target: nil, action: nil)
    private let accountLabel = NSTextField(labelWithString: String(localized: "Not signed in — open Settings"))
    private let scheduleMeetingButton = NSButton(title: String(localized: "Schedule…"), target: nil, action: nil)
    private let bookTimeButton = NSButton(title: String(localized: "Book a time"), target: nil, action: nil)
    private let reloadUpcomingButton = NSButton(image: NSImage(), target: nil, action: nil)
    private let upcomingStack = NSStackView()
    private let upcomingEmptyLabel = StarlingsTypography.wrappingLabel(String(localized: "Connect a calendar to see upcoming meetings."))
    private let nextEmptyLabel = StarlingsTypography.wrappingLabel(String(localized: "Nothing after this one today."))
    private var calendarConnected = false
    /// Upcoming also reads selected .ics subscriptions, which do not require a
    /// Google Calendar connection. Keep that availability separate from the
    /// Google-only state used for invitations and event writes.
    private var upcomingSourcesAvailable = false
    /// False until `calendarStatus` has actually answered. The empty label is
    /// copy, not a gate: telling somebody to connect Google Calendar while the
    /// request that would say otherwise is still in flight is a guess.
    private var calendarConnectionKnown = false
    /// Today-only rows retained for the live NEXT mode while the idle Home
    /// surfaces use `latestUpcomingPlan.homeRows` below.
    private var latestUpcomingEvents: [CalendarEventSummary] = []
    /// The same compact Home projection as the launch card, sidebar, iOS, and
    /// web; the menu bar only gives it a different native renderer.
    private var latestMenubarUpcomingEvents: [CalendarEventSummary] = []
    /// Everything the last Calendar read returned, unfiltered — both lists above
    /// are derived from it, and the clock re-derives them as meetings end.
    private var latestCalendarEvents: [CalendarEventSummary] = []
    /// Full tomorrow tier retained so the clock can notice a day-boundary
    /// change even when the compact Home projection is unchanged.
    private var latestTomorrowEvents: [CalendarEventSummary] = []
    /// The shared reading of the feed — agenda, tiers, and the hero. Every
    /// calendar-derived label on this screen comes from here rather than from a
    /// filter of its own. See `Sources/MeetingFocus.swift`.
    private var latestUpcomingPlan: UpcomingPlan<CalendarEventSummary> = .empty
    private var meetingWarningObserver: NSObjectProtocol?
    /// Settings › Audio › Spatial audio, applied to the live call.
    private var spatialAudioObserver: NSObjectProtocol?
    private var spatialAudioWanted = SpatialAudioPreferences.isEnabled()
    private var upcomingPreferences: UpcomingPreferencesWire = .defaults
    private var upcomingFreshnessTask: Task<Void, Never>?
    private var upcomingReloadTask: Task<Void, Never>?
    /// Rows whose countdown the meeting clock refreshes each second.
    private var upcomingRows: [UpcomingMeetingRow] = []
    private var upcomingRenderMode: UpcomingRenderMode?
    /// Which meeting the live NEXT row is currently about, so the clock can notice
    /// when a different one becomes next.
    private var renderedNextEventID: String?
    private var nextMeetingWatchTask: Task<Void, Never>?
    private let screenShareButton = StarlingsMeetingControlButton(title: String(localized: "Share screen"), symbol: "rectangle.on.rectangle")
    private let screenShareLayoutButton = StarlingsMeetingControlButton(title: String(localized: "Screen share layout"), symbol: "rectangle.3.group")
    private let chatButton = StarlingsMeetingControlButton(title: String(localized: "Chat"), symbol: "bubble.left.and.bubble.right.fill")
    private let muteButton = StarlingsMeetingControlButton(title: String(localized: "Mute"), symbol: "mic.fill")
    private let cameraButton = StarlingsMeetingControlButton(title: String(localized: "Camera off"), symbol: "video.fill")
    /// Blur and the three Block themes, behind one control. Four ways to change
    /// one thing did not need four buttons on the row.
    private let backgroundButton = StarlingsMeetingControlButton(title: String(localized: "Background"), symbol: "person.and.background.dotted")
    /// Hide me, Float me, and Put me in the corner: everything you can do to
    /// your own picture, in the one place you look for it.
    private let selfViewButton = StarlingsMeetingControlButton(title: String(localized: "You"), symbol: "person.crop.square")
    /// Closes the rail so the stage has the window. Live meetings only.
    /// End / Leave, on the control row exactly while the rail — where that
    /// button normally lives — is closed. Never in both places at once.
    private let endMeetingButton = StarlingsMeetingControlButton(title: String(localized: "End meeting"), symbol: "phone.down.fill", danger: true)
    /// The rail itself, kept so it can be taken out of the body stack.
    /// What Focus turned off, so leaving Focus puts it back rather than
    /// guessing. Non-nil exactly while Focus is on.
    private var focusRestore: (panelCollapsed: Bool, transcriptExpanded: Bool)?
    private let selfViewPiP = SelfViewPiPController()
    private var localVideoTrack: VideoTrack?
    /// Set for exactly one `toggleMeeting` — the room that a colleague's call
    /// opened. Cleared as soon as the configuration is built, because the flag
    /// describes *how this meeting began* and the next one begins differently.
    private var isOpeningForWalkUp = false
    /// One welcome per meeting. `onPhaseChange` fires for reasons other than
    /// arriving — a reconnect republishes `.connected` — and a room that
    /// chimed every time would be announcing something that did not happen.
    private var hasWelcomedArrival = false
    /// The people count last seen while connected, or nil outside a meeting.
    /// Seeded on connect so the joiner's own arrival is not also an arrival
    /// chime; see `announceArrival`.
    private var arrivalPeopleBaseline: Int?
    private let chatPanel = MeetingChatPanelView()
    private lazy var chatWindowController = MeetingChatWindowController(panelView: chatPanel)
    private let reactionsButton = StarlingsMeetingControlButton(title: String(localized: "React"), symbol: "face.smiling")
    /// Beside React because they answer the same need from two directions —
    /// both are ways of saying something without taking the floor — and apart
    /// from it because only one of the two persists.
    private let handButton = StarlingsMeetingControlButton(title: String(localized: "Hand"), symbol: "hand.raised.fill")
    /// The queue, oldest raise first. Held so the People rail and the button's
    /// own state read from one answer rather than two.
    private var raisedHands: [RaisedHand] = []
    /// Your own hand, from the room rather than from the last click — a raise
    /// the control plane refused leaves this false, which is what keeps the
    /// button honest.
    private var ownHandRaised = false
    private let reactionOverlay = MeetingReactionOverlayView()
    private var lastReactionSentAt: Date?
    private var isChatVisible = false
    private var unreadChatCount = 0
    private let videoEffectsMonitor = SystemVideoEffectsMonitor()
    private var videoEffectsSnapshot = SystemVideoEffectsSnapshot.current
    private let phaseLabel = NSTextField(labelWithString: String(localized: "Your room"))
    /// The murmuring flock beside the phase heading while the room is
    /// connecting or this Mac waits at the door — the same flock the web
    /// shows on its waiting card. Hidden the rest of the time.
    private let phaseOrb = NSHostingView(rootView: GatheringDotsView(side: 20, ink: Color(nsColor: StarlingsColors.secondaryText), motion: .murmuration))
    private let phaseRow = NSStackView()
    /// Non-blocking failures, under the phase heading: red, with Copy. Cleared
    /// by the next phase change, like the status line it replaces for errors.
    private let sidebarErrorNotice = StarlingsNoticeView(wrapping: true)
    /// The stage's own readout, kept as text here and drawn on the stage.
    private var meetingDurationText: String?
    private let hostLiveStatus = StatusRow(title: String(localized: "Admission"))
    private let categoryControls: MeetingCategoryControls = {
        let controls = MeetingCategoryControls()
        controls.offersPartner = true
        return controls
    }()
    private let tasksControls = MeetingTasksControls()
    private var categoryLoadTask: Task<Void, Never>?
    private var categorySaveGeneration = 0
    private var tasksLoadTask: Task<Void, Never>?
    private var activeTaskSubject: (kind: MeetingCategoryKind, id: String, title: String?)?
    /// Live task proposals from what is being said. Local to this Mac until
    /// the owner accepts one — see `docs/TASK_SUGGESTIONS.md`.
    private var suggestionEngine: TaskSuggestionEngine?
    /// Held separately from the engine so the panel's open tasks can be handed
    /// to the model as "already tracked" on every reload.
    private var cloudTaskExtractor: WorkerTaskExtractor?
    private var suggestionEngineMeetingID: String?
    /// Why the engine resolved the way it did, kept for the debug report —
    /// the panel note is overwritten by the Worker's live answer.
    private var suggestionResolutionNote: String?
    /// The Worker's own answer once it has one ("no model configured"), which
    /// is what the panel shows after resolution.
    private var suggestionLiveNote: String?
    private var visibleSuggestions: [TaskSuggestion] = []
    /// Utterances that produced a task, so the caption panel can show which
    /// sentence a suggestion came out of. Accepted markers survive; dismissed
    /// ones do not.
    private var flaggedTranscriptSegmentIDs: Set<UUID> = []
    private var acceptedTranscriptSegmentIDs: Set<UUID> = []
    private let roomLinkRow = CopyableURLRow()
    private let sidebarIntroLabel = StarlingsTypography.wrappingLabel(String(localized: "Share your room link or start when guests knock."))
    private let participantsStack = NSStackView()
    /// Every foldable block of the rail, in the order they appear. The rail
    /// itself scrolls, so a long meeting — CRM, tasks, NEXT, participants,
    /// devices, a queue of knocks — can never push the window taller than the
    /// screen and take the End meeting button off the bottom of it with it.
    private var sidebarSections: [SidebarSection] = []
    private var crmSection: SidebarSection!
    private var tasksSection: SidebarSection!
    private var identitySection: SidebarSection!
    private var upcomingSection: SidebarSection!
    private var participantsSection: SidebarSection!
    private var devicesSection: SidebarSection!
    private var lobbySection: SidebarSection!
    private var roomActionsStack: NSStackView!
    private var participantCountText = String(localized: "1 participant")
    private let pendingGuestLabel = StarlingsTypography.wrappingLabel(String(localized: "No one on the page yet."))
    private let lobbyQueueStack = NSStackView()
    private let transcriptText = NSTextView()
    private var transcriptLines: [TranscriptRenderLine] = []
    /// Every segment this meeting has produced, not the bounded panel. The
    /// header shows this count as the sign that transcription is working.
    private var capturedTranscriptLineCount = 0
    /// What the header says instead of the count: a problem, a pending upload,
    /// or (before a meeting) where the captions come from. `nil` shows the count.
    private var transcriptionNotice: String?
    private var transcriptPlaceholder = String(localized: "Captions appear here when you host.")
    private let transcriptScroll = NSScrollView()
    private let transcriptDisclosure = NSButton()
    private let transcriptionStatusLabel = NSTextField(labelWithString: String(localized: "ON THIS MAC"))
    private let wakeAssertion = HostWakeAssertion()
    /// Frames the shared display or window on this Mac while sharing is live.
    private let screenShareBorder = ScreenShareBorderOverlay()
    private var isMicrophoneEnabled = true
    private var isCameraEnabled = true
    private var isScreenShareEnabled = false
    private var backgroundEffect: MeetingBackgroundEffect = WorkspaceBackgrounds.preferredEffect
    private var meetingContext: MeetingContext? {
        didSet { applyTranscriptShareVisibility() }
    }
    /// Owner sessions can be connected as companions. Only the host publishes
    /// a microphone, transcribes locally, or renews the host lease.
    private var meetingHoldsHost = false
    /// The host state the caption panel was last reset for. The lobby poll
    /// re-applies host state every few seconds; the panel resets only when
    /// this Mac's host role changes, or the poll wipes the live lines.
    private var transcriptPanelHoldsHost: Bool?
    private var hostMutationInFlight = false
    private var hostReleaseAwaitingResolution = false
    /// After a failed handover the host keeps hosting and waits before it
    /// tries again, so a flaky network does not mute it every lobby poll.
    private var hostReleaseRetryAfter: Date?
    private var hostReleaseIsBlocked: Bool { hostReleaseRetryAfter.map { $0 > Date() } ?? false }
    /// Set while this Mac leaves, so it does not claim the host it just released.
    private var isLeavingMeeting = false
    private var lastVacantHostClaimAt: Date?
    /// The device this Mac asked to host, and its name, until it answers.
    private var pendingHostOffer: (identity: String, name: String)?
    /// Set when this Mac accepted an offer and rejoins the room as its host:
    /// on arriving as a companion it takes the host.
    private var takeHostAfterJoin = false
    private var finalizedMeetingIDs: Set<String> = []
    private var pendingLobbyRequests: [LobbyRequestResponse] = []
    private var pendingLurkers: [GuestPresenceRow] = []
    /// An event session's second door (docs/SESSIONS.md §7): open while
    /// registration links let guests in without a knock.
    private var sessionDoorOpen = false
    private var sessionDoorClosing = false
    private let sessionDoorButton = NSButton(title: "", target: nil, action: nil)
    private var lobbyPeople: [Peer] = []
    private var lobbyPeopleLoaded = false
    private var lobbyPeopleLoading = false
    private var renderedLobbyPeopleEmails: [String] = []
    private var pendingRecorderSenders: [String: String] = [:]
    /// A meeting whose host lease expired, which Start can reclaim and Close
    /// room can end. A healthy lease belongs to another live host instance.
    private var reclaimableMeetingID: String?
    /// The open meeting this launch already tried to walk back into, so a
    /// failed connect shows its error once instead of retrying on every poll.
    private var autoReclaimedMeetingID: String?
    /// Auto-reclaim only fires on the polls right after launch, and only after
    /// the other host's lease has expired. A live host must not be joined
    /// behind the owner's back with a second microphone.
    private let launchedAt = Date()
    private static let autoReclaimWindow: TimeInterval = 120
    private var lobbyDecisionInFlight: Set<String> = []
    /// Lurker presence ids the host just closed the connection on — busy while
    /// the remove is in flight, mirrors `lobbyDecisionInFlight` for requests.
    private var lurkerRemovalInFlight: Set<String> = []
    /// Guest to admit automatically after a pre-live Start & Admit.
    private var admitAfterStartRequestID: String?
    /// IDs already announced with knock attention (knock sound, Dock bounce,
    /// notification).
    private var announcedLobbyRequestIDs: Set<String> = []
    private var lobbyKnockAnnouncementsPrimed = false
    /// This owner's permanent room, remembered so their own door can still be
    /// watched while the Join surface is pointed at somebody else's.
    private var permanentRoom: RoomSlug?
    /// The shared internal room selected from Team. It stays separate from the
    /// personal room so calendar links and the owner room contract do not drift.
    private var hostRoomOverride: RoomSlug?
    /// The role this Mac was in before Team placed a call. Hanging up puts it
    /// back: a host parked in Join after a two-minute call is a host whose own
    /// room nobody can knock on.
    private var roleBeforeCall: MeetingRole?
    private var lobbyPollingTask: Task<Void, Never>?
    private var hostHeartbeatTask: Task<Void, Never>?
    private var softPresenceTask: Task<Void, Never>?
    /// App Nap assertion held only while the soft presence beat runs. See
    /// `startSoftPresence()` for why an idle room needs one.
    private var softPresenceActivity: (any NSObjectProtocol)?
    private var lastSoftPresenceAt: Date?
    private var softPresenceFailure: StarlingsError?
    /// One modal per expiry, not one every ten seconds.
    private var reportedPresenceSessionExpiry = false
    private var guestPresenceTask: Task<Void, Never>?
    private var guestPresenceID = ""
    private var guestPresenceRoom: RoomSlug?
    /// Returning to the Join form after an intentional Leave is not a new
    /// visit. The next explicit Ask to join starts presence again.
    private var guestPresenceSuppressed = false
    private var guestAdmissionTask: Task<Void, Never>?
    private var guestLobbySocketTask: Task<Void, Never>?
    private var bookingContextTask: Task<Void, Never>?
    private var mediaPreferencesObserver: (any NSObjectProtocol)?
    private var calendarSourcesObserver: (any NSObjectProtocol)?
    private var upcomingPreferencesObserver: (any NSObjectProtocol)?
    private var homeLayoutObserver: (any NSObjectProtocol)?
    /// Window/app visibility observers: an idle preview only deserves the
    /// camera while someone can actually see it.
    private var surfaceVisibilityObservers: [any NSObjectProtocol] = []
    private var idleCameraSurfaceWasOnScreen = false
    private var durationTask: Task<Void, Never>?
    private var meetingStartedAt: Date?
    private var hostLeaseHealthy = false
    private var currentRole: MeetingRole = .guest
    private var participantCount = 1
    private let connectionQualityButton = NSButton()
    private let bandwidthButton = NSButton()
    /// Getting the transcript out: its link, the text, a file.
    /// The owner's, who can read the record while the meeting runs.
    private let transcriptShareButton = NSButton()
    private lazy var transcriptShare = TranscriptShareMenu(
        api: controlAPI,
        context: { [weak self] in self?.meetingContext },
        onError: { [weak self] error in self?.present(error) }
    )
    /// Gap between control buttons, and the basis for deciding how many of their
    /// labels still fit.
    private static let controlBarSpacing: CGFloat = 10
    /// Gaps close up once the row is all icons, which is what lets the window
    /// actually reach its 880pt minimum instead of clipping the last control.
    private static let controlBarTightSpacing: CGFloat = 6
    /// The row's own margin of error (the spacer's two gaps, a title that grew
    /// since it was measured).
    private static let controlBarSlack: CGFloat = 24
    /// A chevron is an icon and a bezel, nothing else — narrow enough that
    /// Mute and Camera keep their labels at the width they used to.
    /// Tight enough that the button and its chevron read as one control.
    private static let deviceChooserGap: CGFloat = 2
    /// The hairline between a media control and its chevron.
    private static let deviceSeparatorWidth: CGFloat = 1
    private var controlsRow: NSStackView!
    private var mediaControlsRow: NSStackView!
    private var controlBarButtons: [StarlingsMeetingControlButton] = []
    /// Which labels are worth the width first. Mute and Camera carry state you
    /// act on; Background and You are last because their icons already say it
    /// and the Meeting menu spells out the less-common states. Hand stays in
    /// the labelled set: it is a persistent action, not a transient reaction.
    private var controlBarLabelPriority: [StarlingsMeetingControlButton] = []
    /// Icon-only width per control, measured once before any of them is on
    /// screen. Never changes afterwards, so density can be decided on every
    /// layout pass without touching a button to ask it.
    private var controlIconWidths: [ObjectIdentifier: CGFloat] = [:]
    /// The row under the stage, and the order it gives things up in — the
    /// rightmost readout is the first to go, the participant count the last.
    private var transcriptHeaderRow: NSStackView?
    private var transcriptHeaderShedOrder: [NSView] = []
    /// Gap between readouts, and what a readout costs beyond its own text.
    private static let transcriptHeaderSpacing: CGFloat = 10
    /// Width the heading keeps in reserve for the rest of the row before it
    /// gives up its own title. Fixed rather than measured, so the decision
    /// cannot chase its own tail across layout passes.
    private static let transcriptHeaderTailRoom: CGFloat = 140
    private var transcriptDisclosureWideWidth: CGFloat = 0
    private var transcriptDisclosureIconWidth: CGFloat = 0
    /// What the meeting says belongs on that row, before width has a say.
    /// Density hides from this rather than reading `isHidden` back, so a narrow
    /// window and a quiet meeting can never argue over the same flag.
    private var transcriptHeaderReadoutsWanted: Set<ObjectIdentifier> = []
    private var participantQuality: [MeetingParticipantQuality] = []
    /// Last set of remote tracks on the stage, kept so a participant's context
    /// menu knows whether that person is sharing their screen right now.
    private var remoteVideoSnapshot: [MeetingRemoteVideo] = []

    private var hasMacOwnerCompanion: Bool {
        participantQuality.contains { !$0.isLocal && $0.isOwner && $0.client?.app == .mac }
    }

    private var currentHostIsPhone: Bool {
        guard let identity = meetingContext?.hostIdentity else { return false }
        return OwnerDeviceIdentity.isMobile(identity)
    }

    /// This Mac hosts a colleague's room on their offer. Its way
    /// out is Leave, never End: the meeting and the room stay the owner's.
    private var isHostingColleaguesRoom: Bool {
        guard currentRole == .host, let override = hostRoomOverride else { return false }
        return override.rawValue != MeetingInvite.internalRoomSlug
    }

    private var meetingMainActionTitle: String {
        if currentRole == .host, isInInternalRoom || isHostingColleaguesRoom { return String(localized: "Leave meeting") }
        if currentRole == .host, !meetingHoldsHost { return String(localized: "Leave meeting") }
        if currentRole == .host { return String(localized: "End meeting") }
        return String(localized: "Leave meeting")
    }
    private var bandwidthSnapshot: MeetingBandwidthSnapshot?
    private var qualityReportTask: Task<Void, Never>?
    private var downstreamUsageReportTask: Task<Void, Never>?
    // Removed in a nonisolated deinit; the token itself is never touched elsewhere off-main.
    nonisolated(unsafe) private var updateObserver: NSObjectProtocol?
    nonisolated(unsafe) private var upgradeRecommendationObserver: NSObjectProtocol?

    init(
        meetingSession: MeetingSession = LiveKitMeetingSession(),
        controlAPI: MeetingControlAPI? = nil,
        ownerSessionStore: OwnerSessionStore = OwnerSessionStore(),
        ownerAuthenticator: GoogleOwnerAuthenticator = GoogleOwnerAuthenticator()
    ) {
        self.meetingSession = meetingSession
        self.ownerSessionStore = ownerSessionStore
        self.ownerAuthenticator = ownerAuthenticator
        self.controlAPI = controlAPI ?? MeetingControlAPI(ownerSessionStore: ownerSessionStore)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func loadView() {
        view = NSView()
        view.wantsLayer = true
        view.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.canvas, for: view).cgColor
        // Do not let an expanded panel from an earlier app session make the
        // first meeting start open.
        TranscriptPanelPreferences.resetForMeetingStart()
        // Brand grid sits behind everything on the launch surface — Join /
        // Host idle, plus the brief `.ended` / `.failed` windows. The phase
        // hook hides it the moment a call connects.
        view.addSubview(brandGridBackground)
        brandGridBackground.pinToEdges(of: view)
        brandGridBackground.setVisible(for: meetingSession.phase)
        buildInterface()
        wireActions()
        // A meeting can be started programmatically from Team before this
        // controller has appeared. Re-render the current phase after all of
        // the controls and callbacks exist, so a connection that completed
        // during that handoff cannot leave the row in setup-only state.
        render(phase: meetingSession.phase)
        beginUpdateMonitoring()
        applyRole(.guest)
        videoEffectsMonitor.onChange = { [weak self] snapshot in
            self?.videoEffectsSnapshot = snapshot
        }
        videoEffectsMonitor.refresh()
    }

    // MARK: - Window width

    /// Where a full-width control in the rail stops being squeezed. Well
    /// under the rail's own 280pt minimum once the rail's padding is paid, so
    /// the rail reaches its floor with every control still hittable.
    static let railControlFloor: CGFloat = 180

    /// The stage's own floor. Below this the control row wraps past the point
    /// where the buttons can be told apart.
    static let stageMinimumWidth: CGFloat = 440
    /// The control row's and transcript's inset from the column's edges, and
    /// the column's bottom. The stage itself is flush.
    static let bodyMargin: CGFloat = 20
    /// What the middle column needs: the control row and its insets. The
    /// launch card, a 420pt strip in a scroller with 56pt around it, fits.
    static let detailMinimumWidth: CGFloat = bodyMargin * 2 + stageMinimumWidth

    override func viewDidLayout() {
        super.viewDidLayout()
        applyControlBarDensity()
        applyTranscriptHeaderDensity()
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        StarlingsWindowMetrics.refresh(view.window)
        surfaceDidAppear()
    }

    /// What either window coming on screen starts: Home's (the launch card
    /// reads the calendar and the waiting room) or the Room's (the stage
    /// reads the devices). Each step is idempotent or a refresh.
    func surfaceDidAppear() {
        videoEffectsMonitor.refresh()
        Task { await prepareDevices() }
        Task { await refreshCalendarIntegration() }
        observeCalendarSources()
        startUpcomingFreshnessSweep()
        // Idempotent: one lobby watch for the app's lifetime, independent of
        // which surface is on screen.
        startLobbyWatch()
        // Compile the speech models now, while nobody is talking yet.
        SpeechModelLoader.shared.warmUp()
        notifyMenubarStateChange()
    }

    deinit {
        lobbyPollingTask?.cancel()
        bookingContextTask?.cancel()
        upcomingFreshnessTask?.cancel()
        if let updateObserver {
            NotificationCenter.default.removeObserver(updateObserver)
        }
        if let upgradeRecommendationObserver {
            NotificationCenter.default.removeObserver(upgradeRecommendationObserver)
        }
    }

    private func buildInterface() {
        // The strip under the toolbar that carries the update banner — no
        // brand/settings chrome on the meeting surface (Settings is in the
        // app menu). It sits at the safe area: the window's content runs
        // under the toolbar (`StarlingsWindowChrome.apply(contentUnderToolbar:)`),
        // and this is the first row that must not.
        let header = NSView()
        view.addSubview(header)
        header.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(updateBanner)
        updateBanner.translatesAutoresizingMaskIntoConstraints = false
        updateBanner.onAction = { [weak self] in
            self?.onUpdateAction?()
        }
        updateBanner.onDismiss = {
            StarlingsUpgradeRecommendation.shared.dismiss()
        }

        // Flat and flush: the column the shell puts this in is already an
        // inset, rounded region on macOS 26, so a rounded card with a margin
        // of its own inside it read as a frame within a frame.
        let previewContainer = NSView()
        previewContainer.wantsLayer = true
        previewContainer.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.panel, for: previewContainer).cgColor
        previewContainer.addSubview(meetingStage)
        meetingStage.pinToEdges(of: previewContainer)


        configureControlButton(muteButton, symbol: "mic.fill")
        configureControlButton(cameraButton, symbol: "video.fill")
        configureDeviceChooser(
            microphoneChooserButton,
            label: "Choose microphone",
            action: #selector(presentMicrophoneChooser(_:))
        )
        configureDeviceChooser(
            cameraChooserButton,
            label: "Choose camera",
            action: #selector(presentCameraChooser(_:))
        )
        configureControlButton(backgroundButton, symbol: "person.and.background.dotted")
        configureControlButton(screenShareButton, symbol: "rectangle.on.rectangle")
        configureControlButton(screenShareLayoutButton, symbol: "rectangle.3.group")
        screenShareLayoutButton.isHidden = true
        configureControlButton(selfViewButton, symbol: "person.crop.square")
        configureControlButton(chatButton, symbol: "bubble.left.and.bubble.right.fill")
        configureControlButton(endMeetingButton, symbol: "phone.down.fill", danger: true)
        endMeetingButton.target = self
        endMeetingButton.action = #selector(toggleMeeting(_:))
        endMeetingButton.isHidden = true
        endMeetingButton.isEnabled = false
        // The self-view tile and its floating panel carry their own direct
        // actions. The button opens the same menu without another hover hint.
        muteButton.isEnabled = true
        cameraButton.isEnabled = true
        backgroundButton.isEnabled = true
        screenShareButton.isEnabled = false
        screenShareButton.isHidden = true
        selfViewButton.isEnabled = false
        selfViewButton.isHidden = true
        chatButton.isEnabled = false
        chatButton.isHidden = true
        chatButton.target = self
        chatButton.action = #selector(toggleChat(_:))
        configureControlButton(reactionsButton, symbol: "face.smiling")
        reactionsButton.isEnabled = false
        reactionsButton.isHidden = true
        reactionsButton.target = self
        reactionsButton.action = #selector(presentReactionsMenu(_:))
        configureControlButton(handButton, symbol: "hand.raised.fill")
        handButton.isEnabled = false
        handButton.isHidden = true
        handButton.target = self
        handButton.action = #selector(toggleOwnHand(_:))
        applyBackgroundEffectAppearance()
        applyHideSelfAppearance()
        applyFloatSelfAppearance()

        // Seven, not eleven: mute and camera are the pair you hit without
        // looking, and everything else that used to have its own button now
        // opens a menu from the one control that owns that subject.
        let mediaControls = NSStackView(views: [
            deviceControlGroup(muteButton, chooser: microphoneChooserButton),
            deviceControlGroup(cameraButton, chooser: cameraChooserButton),
            backgroundButton,
            screenShareButton,
            screenShareLayoutButton,
            selfViewButton,
            reactionsButton,
            handButton,
        ])
        mediaControls.orientation = .horizontal
        mediaControls.alignment = .centerY
        mediaControls.spacing = 10

        let controlsSpacer = NSView()
        controlsSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        // Chat, then End at the far right — the one destructive control on the
        // row, kept away from the media buttons people reach for without
        // looking. The rail's own toggle lives in the toolbar now, alongside
        // Calendar's and Work's, not down here.
        let controls = NSStackView(views: [
            mediaControls, controlsSpacer, chatButton, endMeetingButton,
        ])
        controls.orientation = .horizontal
        controls.alignment = .centerY
        controls.spacing = Self.controlBarSpacing
        mediaControls.spacing = Self.controlBarSpacing
        controlsRow = controls
        mediaControlsRow = mediaControls
        controlBarButtons = [
            muteButton, cameraButton, backgroundButton, screenShareButton, screenShareLayoutButton,
            selfViewButton, reactionsButton, handButton, chatButton, endMeetingButton,
        ]
        controlBarLabelPriority = [
            endMeetingButton, muteButton, cameraButton, screenShareButton, screenShareLayoutButton, chatButton,
            handButton, selfViewButton, backgroundButton, reactionsButton,
        ]

        chatPanel.onSend = { [weak self] text in
            try await self?.meetingSession.sendChat(text)
        }
        chatPanel.onToggleReaction = { [weak self] reaction, messageID in
            Task { await self?.meetingSession.toggleChatReaction(reaction, on: messageID) }
        }
        chatPanel.isMine = { [weak self] reaction, messageID in
            self?.meetingSession.localHasChatReaction(reaction, on: messageID) ?? false
        }
        // Read by the Worker on the meeting's own token, so a guest in Join
        // mode gets the same cards as a signed-in host without an account —
        // and, as everywhere, no client ever fetches a pasted link itself.
        chatPanel.loadPreview = { [weak self] link in
            guard let self, let context = meetingContext else { return nil }
            return try? await controlAPI.meetingLinkPreview(context: context, url: link)
        }
        chatWindowController.onClose = { [weak self] in
            guard let self, isChatVisible else { return }
            isChatVisible = false
            returnKeyboard(to: chatButton)
        }

        // The heading doubles as the disclosure control: the captions are worth
        // reading when you want them and worth the vertical space back when you
        // don't, and the control row below the stage is already full.
        transcriptDisclosure.bezelStyle = .inline
        SettingsChrome.applyQuietButton(transcriptDisclosure)
        transcriptDisclosure.font = .systemFont(ofSize: StarlingsTypography.scaled(14), weight: .semibold)
        transcriptDisclosure.contentTintColor = StarlingsColors.primaryText
        transcriptDisclosure.imagePosition = .imageLeading
        transcriptDisclosure.target = self
        transcriptDisclosure.action = #selector(toggleTranscriptPanel(_:))

        transcriptionStatusLabel.font = StarlingsTypography.sectionLabelFont
        transcriptionStatusLabel.textColor = StarlingsColors.secondaryText
        transcriptionStatusLabel.lineBreakMode = .byTruncatingTail
        transcriptionStatusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        transcriptText.isEditable = false
        transcriptText.drawsBackground = false
        transcriptText.textColor = StarlingsColors.secondaryText
        transcriptText.font = .systemFont(ofSize: StarlingsTypography.scaled(14))
        transcriptText.textContainerInset = NSSize(width: 0, height: 8)
        transcriptText.selectedTextAttributes = StarlingsColors.textSelectionAttributes
        transcriptText.insertionPointColor = StarlingsColors.primaryText
        renderTranscript()

        transcriptScroll.drawsBackground = false
        transcriptScroll.hasVerticalScroller = true
        transcriptScroll.documentView = transcriptText
        transcriptScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 108).isActive = true

        connectionQualityButton.bezelStyle = .inline
        SettingsChrome.applyQuietButton(connectionQualityButton)
        connectionQualityButton.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .medium)
        connectionQualityButton.contentTintColor = StarlingsColors.secondaryText
        setReadoutIcon(
            connectionQualityButton,
            symbol: "wifi",
            accessibility: "Connection quality"
        )
        connectionQualityButton.target = self
        connectionQualityButton.action = #selector(presentConnectionQualityMenu(_:))
        connectionQualityButton.isHidden = true
        connectionQualityButton.setAccessibilityLabel(String(localized: "Connection quality for each participant"))

        bandwidthButton.bezelStyle = .inline
        SettingsChrome.applyQuietButton(bandwidthButton)
        bandwidthButton.font = .monospacedDigitSystemFont(ofSize: StarlingsTypography.scaled(12), weight: .medium)
        bandwidthButton.contentTintColor = StarlingsColors.secondaryText
        setReadoutIcon(
            bandwidthButton,
            symbol: "arrow.down.arrow.up",
            accessibility: "Incoming and outgoing bandwidth"
        )
        bandwidthButton.target = self
        bandwidthButton.action = #selector(presentBandwidthMenu(_:))
        bandwidthButton.isHidden = true
        bandwidthButton.setAccessibilityLabel(String(localized: "Incoming and outgoing bandwidth"))

        transcriptShareButton.bezelStyle = .inline
        SettingsChrome.applyQuietButton(transcriptShareButton)
        transcriptShareButton.title = ""
        transcriptShareButton.contentTintColor = StarlingsColors.secondaryText
        transcriptShareButton.image = NSImage(
            systemSymbolName: "square.and.arrow.up",
            accessibilityDescription: String(localized: "Share transcript")
        )?.withSymbolConfiguration(.init(pointSize: 12, weight: .semibold))
        transcriptShareButton.imagePosition = .imageOnly
        transcriptShareButton.target = self
        transcriptShareButton.action = #selector(presentTranscriptShareMenu(_:))
        transcriptShareButton.toolTip = String(localized: "Share transcript")
        transcriptShareButton.setAccessibilityLabel(String(localized: "Share transcript"))
        transcriptShareButton.isHidden = true

        // Same bargain as the control row: this line reports the meeting, it does
        // not get to set the window's width. Everything in it gives way before
        // the window is pushed wider — and `applyTranscriptHeaderDensity` takes
        // readouts off the row entirely rather than letting them be squeezed.
        transcriptionStatusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        transcriptionStatusLabel.usesSingleLineMode = true
        for readout in [transcriptDisclosure, transcriptShareButton, connectionQualityButton, bandwidthButton] {
            readout.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        }

        // Who is in the room and how long it has been going are facts about the
        // stage, and they live on it now (`StageReadoutPill`). What is left here
        // is the transcript's own heading and the two readouts that open a menu.
        let transcriptHeader = NSStackView(views: [
            transcriptDisclosure,
            transcriptShareButton,
            connectionQualityButton,
            bandwidthButton,
            NSView(),
            transcriptionStatusLabel,
        ])
        transcriptHeader.orientation = .horizontal
        transcriptHeader.alignment = .centerY
        transcriptHeader.spacing = Self.transcriptHeaderSpacing
        transcriptHeaderRow = transcriptHeader
        // Right to left: the status line is the first thing the row can do
        // without, the participant count the last.
        transcriptHeaderShedOrder = [
            transcriptionStatusLabel,
            bandwidthButton,
            connectionQualityButton,
            transcriptShareButton,
        ]
        // The status line is on the row whenever there is room; the other two
        // are switched on by the meeting itself (`setTranscriptHeaderReadout`).
        transcriptHeaderReadoutsWanted.insert(ObjectIdentifier(transcriptionStatusLabel))

        // The stage runs edge to edge; the control row and the transcript
        // under it keep an inset, so `left` is only those.
        let left = NSStackView(views: [controls, transcriptHeader, transcriptScroll])
        left.orientation = .vertical
        left.alignment = .leading
        left.spacing = 14
        // A hidden arranged view must release its slot. Without this explicit
        // setting, the transcript can be folded visually while its minimum
        // height still participates in the stage's fitting size.
        left.detachesHiddenViews = true
        // Floor, not a preference: this is the only required height in the body,
        // so it is also the shortest the window can be made. 200pt still shows a
        // usable grid; the old 360 put the floor above the window's own minimum
        // and made the meeting surface unshrinkable.
        previewContainer.heightAnchor.constraint(greaterThanOrEqualToConstant: 200).isActive = true
        // The stage is the primary surface. When the transcript is folded, it
        // takes the unused height; when the transcript is open, the transcript
        // keeps its readable floor while the video remains the flexible pane.
        previewContainer.setContentHuggingPriority(.defaultLow, for: .vertical)
        previewContainer.setContentCompressionResistancePriority(.required, for: .vertical)
        transcriptScroll.setContentHuggingPriority(.required, for: .vertical)
        transcriptScroll.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        controls.widthAnchor.constraint(equalTo: left.widthAnchor).isActive = true
        controls.setHuggingPriority(.required, for: .vertical)
        transcriptHeader.widthAnchor.constraint(equalTo: left.widthAnchor).isActive = true
        transcriptScroll.widthAnchor.constraint(equalTo: left.widthAnchor).isActive = true
        applyTranscriptPanelVisibility()
        measureTranscriptDisclosure()

        // The rail is not a subview here. The shell stands it in the
        // inspector column beside this controller's view, so this column is
        // the stage and what sits under it.
        railView = makeSidebar()
        railView.translatesAutoresizingMaskIntoConstraints = false

        let body = NSView()
        body.translatesAutoresizingMaskIntoConstraints = false
        previewContainer.translatesAutoresizingMaskIntoConstraints = false
        left.translatesAutoresizingMaskIntoConstraints = false
        body.addSubview(previewContainer)
        body.addSubview(left)
        meetingBodyView = body
        view.addSubview(body)
        // The update banner's strip sits over the top of the stage, not
        // above it — a band of canvas between the toolbar and the stage was
        // the last of the old margins.
        view.addSubview(header, positioned: .above, relativeTo: body)
        stageTrailingToRail = previewContainer.trailingAnchor.constraint(equalTo: body.trailingAnchor)
        NSLayoutConstraint.activate([
            previewContainer.topAnchor.constraint(equalTo: body.topAnchor),
            previewContainer.leadingAnchor.constraint(equalTo: body.leadingAnchor),
            stageTrailingToRail,
            left.topAnchor.constraint(equalTo: previewContainer.bottomAnchor, constant: 14),
            left.leadingAnchor.constraint(equalTo: body.leadingAnchor, constant: Self.bodyMargin),
            left.trailingAnchor.constraint(equalTo: body.trailingAnchor, constant: -Self.bodyMargin),
            left.bottomAnchor.constraint(equalTo: body.bottomAnchor),
        ])

        homeView = makeHomeView()
        wireOwnerLaunch()

        bodyTopAtSafeArea = body.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor)
        bodyTopAtEdge = body.topAnchor.constraint(equalTo: view.topAnchor)
        NSLayoutConstraint.activate([
            header.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 28),
            header.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -28),
            header.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            header.heightAnchor.constraint(equalToConstant: 28),

            updateBanner.trailingAnchor.constraint(equalTo: header.trailingAnchor),
            updateBanner.centerYAnchor.constraint(equalTo: header.centerYAnchor),

            body.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            body.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bodyTopAtSafeArea,
            body.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -Self.bodyMargin),
        ])

        // Last subview and edge-to-edge: reactions cross the whole stage
        // column, over everything else in it. It never takes a click — see
        // its `hitTest`.
        view.addSubview(reactionOverlay)
        reactionOverlay.translatesAutoresizingMaskIntoConstraints = false
        reactionOverlay.pinToEdges(of: view)
    }

    /// Home's content: the launch card on its own grid, with its own update
    /// strip. The launch column reaches the window's top edge so its scroll
    /// view runs under the toolbar: AppKit insets the content by the
    /// toolbar's height, and what scrolls up from there passes under the soft
    /// edge instead of stopping at the toolbar's bottom line. The strip goes
    /// above it so the banner is not under the scrolled column.
    private func makeHomeView() -> NSView {
        let home = NSView()
        home.wantsLayer = true
        home.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.canvas, for: home).cgColor
        home.addSubview(homeGridBackground)
        homeGridBackground.pinToEdges(of: home)
        homeGridBackground.setVisible(for: .setup)
        home.addSubview(ownerLaunchView)
        ownerLaunchView.translatesAutoresizingMaskIntoConstraints = false
        ownerLaunchView.setVisible(false)
        let header = NSView()
        header.translatesAutoresizingMaskIntoConstraints = false
        home.addSubview(header, positioned: .above, relativeTo: ownerLaunchView)
        header.addSubview(homeUpdateBanner)
        homeUpdateBanner.translatesAutoresizingMaskIntoConstraints = false
        homeUpdateBanner.onAction = { [weak self] in
            self?.onUpdateAction?()
        }
        homeUpdateBanner.onDismiss = {
            StarlingsUpgradeRecommendation.shared.dismiss()
        }
        NSLayoutConstraint.activate([
            ownerLaunchView.leadingAnchor.constraint(equalTo: home.leadingAnchor),
            ownerLaunchView.trailingAnchor.constraint(equalTo: home.trailingAnchor),
            ownerLaunchView.topAnchor.constraint(equalTo: home.topAnchor),
            ownerLaunchView.bottomAnchor.constraint(equalTo: home.bottomAnchor),

            header.leadingAnchor.constraint(equalTo: home.leadingAnchor, constant: 28),
            header.trailingAnchor.constraint(equalTo: home.trailingAnchor, constant: -28),
            header.topAnchor.constraint(equalTo: home.safeAreaLayoutGuide.topAnchor),
            header.heightAnchor.constraint(equalToConstant: 28),

            homeUpdateBanner.trailingAnchor.constraint(equalTo: header.trailingAnchor),
            homeUpdateBanner.centerYAnchor.constraint(equalTo: header.centerYAnchor),
        ])
        return home
    }

    private func beginUpdateMonitoring() {
        updateObserver = NotificationCenter.default.addObserver(
            forName: UpdateChecker.didChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            // Notification callbacks can arrive off the actor even when the
            // checker posts from its main-actor state changes.
            Task { @MainActor in self?.refreshUpdateBanner() }
        }
        upgradeRecommendationObserver = NotificationCenter.default.addObserver(
            forName: StarlingsUpgradeRecommendation.didChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.refreshUpdateBanner() }
        }
        refreshUpdateBanner()
    }

    /// Where a sheet or a toast from this controller goes: the Room window
    /// while the stage stands in it, Home's otherwise.
    private var frontWindow: NSWindow? {
        if isStageVisible, let window = view.window, window.isVisible { return window }
        return homeView.window ?? view.window
    }

    private func refreshUpdateBanner() {
        let checker = UpdateChecker.shared
        for banner in [updateBanner, homeUpdateBanner] {
            banner.setUpdate(
                checker.available,
                recommendation: StarlingsUpgradeRecommendation.shared.isVisible,
                canInstall: UpdateCheck.canSelfUpdate
            )
        }
    }

    private func wireOwnerLaunch() {
        // Home stays on screen through a meeting now, so its room buttons
        // can be pressed while one runs. Then they bring the Room window
        // forward: Start must never leave a call, or start a second one.
        ownerLaunchView.onStart = { [weak self] in
            guard let self else { return }
            guard !isStageVisible else { onShowRoom?(); return }
            toggleMeeting(nil)
        }
        ownerLaunchView.onUseUpcoming = { [weak self] event in
            guard let self else { return }
            guard isBetweenMeetings else { onShowRoom?(); return }
            joinUpcomingEvent(event)
        }
        ownerLaunchView.onOpenUpcoming = { [weak self] event in
            self?.onRevealCalendarEvent?(event)
        }
        ownerLaunchView.onOpenPublicEvent = { event in
            guard let url = URL(string: event.url) else { return }
            NSWorkspace.shared.open(url)
        }
        ownerLaunchView.onToggleUpcomingDemoted = { [weak self] event in
            self?.toggleUpcomingDemoted(event)
        }
        ownerLaunchView.conflictsForInvitation = { [weak self] invitation in
            guard let self else { return [] }
            return CalendarConflictDetector.conflicts(
                for: invitation.calendarConflictEvent,
                among: latestCalendarEvents.map(\.calendarConflictEvent)
            )
        }
        ownerLaunchView.onWork = { [weak self] in
            self?.presentWork(nil)
        }
        ownerLaunchView.onTeam = { [weak self] in
            self?.onOpenTeam?()
        }
        ownerLaunchView.onOpenConversation = { [weak self] threadID, title in
            self?.onOpenConversation?(threadID, title)
        }
        ownerLaunchView.onOpenWork = { [weak self] destination in
            self?.onOpenWork?(destination)
        }
        ownerLaunchView.onOpenSearchRow = { [weak self] row in
            self?.onOpenSearchRow?(row)
        }
        ownerLaunchView.recentsOwner = { [weak self] in self?.controlAPI.signedInOwnerEmail }
        ownerLaunchView.onWorkRowAction = { [weak self] action in
            self?.onWorkRowAction?(action)
        }
        ownerLaunchView.onCreateQuickNote = { [weak self] body in
            self?.onCreateQuickNote?(body)
        }
        ownerLaunchView.onUpdateQuickNote = { [weak self] note, body in
            self?.onUpdateQuickNote?(note, body)
        }
        ownerLaunchView.onTriageQuickNote = { [weak self] note in
            self?.onTriageQuickNote?(note)
        }
        ownerLaunchView.onDeleteQuickNote = { [weak self] note in
            self?.onDeleteQuickNote?(note)
        }
        ownerLaunchView.onMoveQuickNote = { [weak self] note, workspace in
            self?.onMoveQuickNote?(note, workspace)
        }
        ownerLaunchView.onConnectCalendar = { [weak self] in
            self?.onOpenCalendarSettings?()
        }
        ownerLaunchView.onOpenHomeSettings = { [weak self] in
            self?.onOpenHomeSettings?()
        }
        ownerLaunchView.onCloseRoom = { [weak self] in
            guard let self else { return }
            guard isBetweenMeetings else { onShowRoom?(); return }
            closeAbandonedRoom()
        }
        ownerLaunchView.onOpenSetupStep = { [weak self] step in
            self?.openSetupStep(step)
        }
        ownerLaunchView.onSkipSetupStep = { [weak self] step in
            Task { @MainActor in await self?.skipSetupStep(step) }
        }
        ownerLaunchView.onTurnOffSetup = { [weak self] in
            Task { @MainActor in await self?.turnOffSetup() }
        }
    }

    // MARK: Setup checklist (docs/ONBOARDING.md §The setup checklist)

    /// The last good answer, kept through a failed refresh.
    private var lastSetup: SetupResponse?
    /// Read once per owner per launch, so the refresh that says "You're set
    /// up" keeps saying it until the app next starts.
    private var setupDoneSaid: [String: Bool] = [:]

    private func refreshSetup() async {
        guard let owner = controlAPI.signedInOwnerEmail else { return }
        let workspace = StarlingsWorkspace.active.webOrigin
        let doneSaid = setupDoneSaid[owner] ?? SetupChecklist.doneSaid(workspace: workspace, owner: owner)
        setupDoneSaid[owner] = doneSaid
        do {
            let setup = try await controlAPI.setup()
            lastSetup = setup
            ownerLaunchView.setSetup(setup, doneSaid: doneSaid, error: nil)
            if setup.on, setup.complete { SetupChecklist.markDoneSaid(workspace: workspace, owner: owner) }
        } catch {
            ownerLaunchView.setSetup(lastSetup, doneSaid: doneSaid, error: lastSetup == nil ? error.localizedDescription : nil)
        }
    }

    private func turnOffSetup() async {
        guard let owner = controlAPI.signedInOwnerEmail else { return }
        do {
            let setup = try await controlAPI.setSetupChecklist(on: false)
            lastSetup = setup
            ownerLaunchView.setSetup(setup, doneSaid: setupDoneSaid[owner] ?? false, error: nil)
        } catch {
            ownerLaunchView.setSetup(lastSetup, doneSaid: setupDoneSaid[owner] ?? false, error: error.localizedDescription)
        }
    }

    private func skipSetupStep(_ step: SetupStep) async {
        guard let owner = controlAPI.signedInOwnerEmail else { return }
        let doneSaid = setupDoneSaid[owner] ?? false
        do {
            let setup = try await controlAPI.skipSetupStep(step)
            lastSetup = setup
            ownerLaunchView.setSetup(setup, doneSaid: doneSaid, error: nil)
            if setup.on, setup.complete { SetupChecklist.markDoneSaid(workspace: StarlingsWorkspace.active.webOrigin, owner: owner) }
        } catch {
            ownerLaunchView.setSetup(lastSetup, doneSaid: doneSaid, error: error.localizedDescription)
        }
    }

    private func openSetupStep(_ step: SetupStep) {
        switch SetupChecklist.destination(for: step, webOrigin: StarlingsWorkspace.active.webOrigin) {
        case .settings(let page)?: onOpenSettingsPage?(page)
        case .work?: presentWork(nil)
        case .room?: toggleMeeting(nil)
        case .web(let url)?: NSWorkspace.shared.open(url)
        case nil: break
        }
    }

    /// Signed-in host between meetings → full-bleed launch; everyone else / live
    /// → classic meeting body. Ended and failed count as "between meetings" too,
    /// otherwise those phases drop the host back into the guest-shaped sidebar
    /// and re-offer identity, Host/Join and Upcoming the launch surface owns.
    private func showsOwnerLaunch(for phase: MeetingPhase) -> Bool {
        let signedIn = (try? ownerSessionStore.load()) != nil
        return currentRole == .host && signedIn && phase.isIdle && guestAdmissionTask == nil
    }

    /// Nothing live and nobody mid-admission. The window may swap the surface
    /// out from under this controller only when this is true.
    var isBetweenMeetings: Bool {
        meetingSession.phase.isIdle && guestAdmissionTask == nil
    }

    private func updateSurfaceVisibility() {
        let showLaunch = showsOwnerLaunch(for: meetingSession.phase)
        // Home draws the launch card for any signed-in member, in a meeting
        // or not; the stage is the Room window's, and stands whenever there
        // is something on it.
        ownerLaunchView.setVisible((try? ownerSessionStore.load()) != nil)
        ownerLaunchView.setStartTitle(
            meetingSession.phase.isIdle && guestAdmissionTask == nil
                ? String(localized: "Start room")
                : String(localized: "Open meeting")
        )
        meetingBodyView.isHidden = showLaunch
        // The rail comes and goes with the stage.
        applyMeetingPanelVisibility()
        if isStageVisible == showLaunch {
            isStageVisible = !showLaunch
            onStageVisibilityChange?(isStageVisible)
        }
        if showLaunch {
            syncOwnerLaunchInvite()
            syncOwnerLaunchUpcoming()
            ownerLaunchView.setWaitingEmptyMessage("")
            startSoftPresence()
            // Launch has no media preview. Keep the stage's prejoin camera
            // off while it is behind the idle home surface.
            meetingStage.showPrejoinCamera(deviceID: nil)
        } else {
            stopSoftPresence()
            // The stage owns the only idle preview whenever it is visible.
            refreshPrejoinCamera()
        }
        // Host and guest presence are mutually exclusive by construction: this
        // is the one place that knows which side of the door we are on.
        refreshGuestPresence()
    }

    /// Handed down from `PeerWatch` by the window controller, because the
    /// launch surface lives in here and the poll does not. Nothing is drawn
    /// while a meeting is running — the surface is hidden, and the button will
    /// be current again the moment it comes back.
    func setUnreadMessages(_ threads: [ThreadSummary]) {
        ownerLaunchView.setUnreadMessages(threads)
    }

    /// Mine, handed down from `WorkWatch` the same way. The launch card
    /// plans its focus slice.
    func setMine(tasks: [CrmMyTask], issues: [CrmIssue]) {
        ownerLaunchView.setWork(tasks: tasks, issues: issues)
    }

    func setCommercial(_ summary: CommercialSummary?) {
        ownerLaunchView.setCommercial(summary)
    }

    /// The workspace's work modules, so Home follows them.
    func setWorkModules(_ modules: [WorkModule]?) {
        ownerLaunchView.setWorkModules(modules)
    }

    /// Home's QUICK ACCESS list: starred rows as search rows.
    func setStarred(_ rows: [SearchRow]) {
        ownerLaunchView.setStarred(rows)
    }

    func setPeerRoster(_ roster: PeerRoster) {
        ownerLaunchView.setAgentAvatars(roster.peers)
    }

    /// INBOX, the same way: the Work button's count and the WORK card's
    /// first rows read it.
    func setInbox(_ inbox: WorkInboxResponse) {
        ownerLaunchView.setInbox(inbox)
    }

    func setQuickNotes(_ notes: [QuickNote], unsent: [QuickNote.ID: QuickNotePending] = [:]) {
        ownerLaunchView.setQuickNotes(notes, unsent: unsent)
    }

    func setQuickNoteSaving(_ saving: Bool, error: String? = nil) {
        ownerLaunchView.setQuickNoteSaving(saving, error: error)
    }

    func markQuickNoteSaved() {
        ownerLaunchView.markQuickNoteSaved()
    }

    /// A row on the launch card named a place in Work. The window controller
    /// owns that window, so it answers; this only carries the request.
    var onOpenWork: ((WorkDestination) -> Void)?
    var onWorkRowAction: ((WorkRowAction) -> Void)?
    /// A RECENT row on the launch card: a search row, through the window
    /// controller's palette door.
    var onOpenSearchRow: ((SearchRow) -> Void)?
    /// The launch card's Team door. Team owns people and agent conversations;
    /// the meeting controller only forwards the destination request.
    var onOpenTeam: (() -> Void)?
    var onOpenConversation: ((String, String?) -> Void)?
    /// The launch card's Docs door. Docs owns the corpus in its own window;
    /// the meeting controller only forwards the destination request.
    var onOpenDocs: (() -> Void)?
    /// True while Focus is on, false otherwise.
    ///
    /// The window stays dressed exactly like Calendar and Work for the whole
    /// meeting — same style mask, same unified toolbar, same surface switcher —
    /// because a call is when the calendar you are talking about and the notes
    /// you are taking matter most. Only Focus takes the chrome, and Focus is
    /// something you ask for. What the chrome *is* is still not this
    /// controller's business. See `StarlingsWindowChrome.setImmersive`.
    var onImmersiveChange: ((Bool) -> Void)?
    /// The launch card asked for a calendar. Settings owns that page.
    var onOpenCalendarSettings: (() -> Void)?
    /// Home's gear: Settings on the Home page.
    var onOpenHomeSettings: (() -> Void)?
    /// A setup step done in Settings: Settings on that page.
    var onOpenSettingsPage: ((StarlingsSettingID) -> Void)?
    /// A Home row was clicked: Calendar opens on that event.
    var onRevealCalendarEvent: ((CalendarEventSummary) -> Void)?

    /// Whether "Meet about this" can start a room right now: this Mac is the
    /// host, signed in, and its room is idle. Work asks before offering it.
    var canStartHostRoom: Bool {
        currentRole == .host && meetingSession.phase.isIdle && (try? ownerSessionStore.load()) != nil
    }

    /// The subject a room was started *about*, held until the meeting is up.
    /// Applied through the same category write the CRM sidebar makes, one
    /// request after start — the CRM row opens already filed, and the sidebar
    /// shows it filed, without a second start contract.
    private var pendingFiling: CrmSubject?
    /// The invitees of the calendar event this room was started from, for
    /// the transcript name pass. Cleared with `pendingFiling`.
    private var pendingInviteeNames: [String] = []

    /// A colleague called and you said yes. Opens your room the way pressing
    /// Start does, with two differences: the microphone is on, because the
    /// point is to talk, and the camera is not, because nobody agreed to be on
    /// camera by answering a call. Transcription does not begin — see
    /// `MeetingConfiguration.isWalkUp`.
    ///
    /// The caller is not admitted here. They join the ordinary way the moment
    /// this room is live, and `memberAdmission` at the Worker lets a verified
    /// member past the queue — so nothing in lobby-before-media moves.
    @discardableResult
    func openRoomForWalkUp() -> Bool {
        guard canStartHostRoom else { return false }
        // Nothing is connected yet, so these are the pre-join flags the
        // configuration reads — set directly rather than through the toggles,
        // which talk to a LiveKit room that does not exist.
        isMicrophoneEnabled = true
        isCameraEnabled = false
        applyMicrophoneControlAppearance()
        applyCameraControlAppearance()
        applyBackgroundEffectAppearance()
        updateBackgroundButtonsEnabled()
        isOpeningForWalkUp = true
        toggleMeeting(nil)
        isOpeningForWalkUp = false
        return true
    }

    /// Your own Claude asked to open your room and you said yes.
    ///
    /// The same door as a walk-up with one difference that matters: this
    /// meeting **transcribes**. A walk-up is "got a sec?" and is not minuted;
    /// an agent's ask carries a title, a time and attendees on the calendar,
    /// so it is a convened meeting and the record belongs with it.
    /// `isOpeningForWalkUp` therefore stays false.
    @discardableResult
    func openRoomForAgentAsk() -> Bool {
        guard canStartHostRoom else { return false }
        // Pre-join flags, as in `openRoomForWalkUp`: nothing is connected yet,
        // so these are read by the configuration rather than by a live room.
        isMicrophoneEnabled = true
        isCameraEnabled = false
        applyMicrophoneControlAppearance()
        applyCameraControlAppearance()
        applyBackgroundEffectAppearance()
        updateBackgroundButtonsEnabled()
        toggleMeeting(nil)
        return true
    }

    /// Start the owner's room filed under a subject, from Work. False when
    /// the room cannot start from here, so the caller does not open a window
    /// on nothing.
    @discardableResult
    func startRoom(filedAs subject: CrmSubject) -> Bool {
        guard canStartHostRoom else { return false }
        pendingFiling = subject
        toggleMeeting(nil)
        return true
    }

    /// The launch card draws the same compact projection as the sidebar, iOS,
    /// and web. It receives the shared plan's answer rather than choosing a day
    /// or row count of its own.
    private func syncOwnerLaunchUpcoming() {
        let plan = latestUpcomingPlan
        let countdownIDs = Set<String>(
            plan.homeRows.compactMap { event in
                guard let tier = plan.tier(of: event), tier == .now || tier == .today else { return nil }
                return event.id
            }
        )
        ownerLaunchView.setUpcoming(
            focus: plan.focus,
            following: plan.homeRows,
            remainingToday: plan.remainingToday,
            countdownIDs: countdownIDs,
            calendarConnected: calendarConnectionKnown ? upcomingSourcesAvailable : nil,
            emptyMessage: plan.focus == nil && calendarConnectionKnown ? upcomingEmptyLabel.stringValue : nil,
            heroLabel: plan.heroLabel
        )
    }

    private func syncOwnerLaunchInvite() {
        let clipboard = roomLinkRow.clipboardString
        let display = roomLinkRow.displayString
        if !clipboard.isEmpty {
            ownerLaunchView.setInviteURL(clipboard)
        } else if !display.isEmpty {
            ownerLaunchView.setInviteURL(display.hasPrefix("http") ? display : "https://\(display)")
        }
    }

    private func makeSidebar() -> NSView {
        phaseLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(23), weight: .semibold)
        phaseLabel.textColor = StarlingsColors.primaryText
        phaseOrb.translatesAutoresizingMaskIntoConstraints = false
        phaseOrb.widthAnchor.constraint(equalToConstant: 20).isActive = true
        phaseOrb.heightAnchor.constraint(equalToConstant: 20).isActive = true
        phaseOrb.setAccessibilityElement(false)
        phaseOrb.isHidden = true
        phaseRow.orientation = .horizontal
        phaseRow.alignment = .centerY
        phaseRow.spacing = 8
        phaseRow.addArrangedSubview(phaseOrb)
        phaseRow.addArrangedSubview(phaseLabel)
        sidebarErrorNotice.label.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        roomLinkRow.setRoomPath(
            "/room/mz",
            webOrigin: MeetingInvite.shareOrigin(configuredWebOrigin: MeetingControlAPI.configuredWebOrigin)
        )

        sidebarIntroLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        sidebarIntroLabel.textColor = StarlingsColors.secondaryText
        participantsStack.orientation = .vertical
        participantsStack.alignment = .leading
        participantsStack.spacing = 6
        participantsStack.isHidden = true

        roomField.stringValue = "mz"
        bookingContextLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        bookingContextLabel.textColor = StarlingsColors.secondaryText
        bookingContextLabel.maximumNumberOfLines = 4
        bookingContextLabel.isHidden = true

        modeControl.selectedSegment = 1
        modeControl.setWidth(132, forSegment: 0)
        modeControl.setWidth(132, forSegment: 1)
        accountLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .medium)
        accountLabel.textColor = StarlingsColors.secondaryText
        accountLabel.lineBreakMode = .byTruncatingMiddle
        scheduleMeetingButton.bezelStyle = .inline
        SettingsChrome.applyQuietButton(scheduleMeetingButton)
        scheduleMeetingButton.contentTintColor = StarlingsColors.primaryText
        // Same calendar mark as OwnerLaunchView / web room-entry Schedule.
        if let image = NSImage(systemSymbolName: "calendar", accessibilityDescription: String(localized: "Schedule")) {
            scheduleMeetingButton.image = image.withSymbolConfiguration(.init(pointSize: 12, weight: .semibold))
            scheduleMeetingButton.imagePosition = .imageLeading
            scheduleMeetingButton.imageHugsTitle = true
            scheduleMeetingButton.title = "\u{2002}Calendar"
        }
        SettingsChrome.applySecondaryButton(bookTimeButton, title: String(localized: "Book a time"), symbolName: "calendar")
        bookTimeButton.isHidden = false

        if let image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: String(localized: "Reload upcoming")) {
            reloadUpcomingButton.image = image.withSymbolConfiguration(.init(pointSize: 11, weight: .semibold))
        }
        reloadUpcomingButton.imagePosition = .imageOnly
        reloadUpcomingButton.bezelStyle = .inline
        SettingsChrome.applyQuietButton(reloadUpcomingButton)
        reloadUpcomingButton.contentTintColor = StarlingsColors.secondaryText
        reloadUpcomingButton.toolTip = String(localized: "Reload upcoming")
        reloadUpcomingButton.target = self
        reloadUpcomingButton.action = #selector(reloadUpcomingMeetings)
        reloadUpcomingButton.setContentHuggingPriority(.required, for: .horizontal)
        reloadUpcomingButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        upcomingEmptyLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        upcomingEmptyLabel.textColor = StarlingsColors.secondaryText
        nextEmptyLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        nextEmptyLabel.textColor = StarlingsColors.secondaryText
        upcomingStack.orientation = .vertical
        upcomingStack.alignment = .leading
        upcomingStack.spacing = 6
        upcomingStack.addArrangedSubview(upcomingEmptyLabel)

        pendingGuestLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        pendingGuestLabel.textColor = StarlingsColors.secondaryText
        hostLiveStatus.isHidden = true
        categoryControls.isHidden = true
        tasksControls.isHidden = true
        categoryControls.onChange = { [weak self] kind, subject in
            self?.persistMeetingCategory(kind: kind, subject: subject)
        }
        categoryControls.onOpenSubject = { [weak self] subject in
            self?.onOpenWork?(WorkDestination(subject: subject, pane: .talk))
        }
        tasksControls.onNewTask = { [weak self] in self?.presentNewTaskEditor() }
        tasksControls.onEditTask = { [weak self] task in self?.presentEditTaskEditor(task) }
        tasksControls.onToggleTaskDone = { [weak self] task, done in self?.setTaskDone(task, done: done) }
        tasksControls.onDecideProposal = { [weak self] task, accepted in
            self?.writeTask(task, update: .proposalDecision(accepted: accepted))
        }
        tasksControls.onTaskAction = { [weak self] action in self?.performTaskAction(action) }
        tasksControls.onAcceptSuggestion = { [weak self] suggestion in self?.acceptSuggestion(suggestion) }
        tasksControls.onEditSuggestion = { [weak self] suggestion in self?.presentSuggestionEditor(suggestion) }
        tasksControls.onDismissSuggestion = { [weak self] suggestion in self?.dismissSuggestion(suggestion) }
        lobbyQueueStack.orientation = .vertical
        lobbyQueueStack.alignment = .leading
        lobbyQueueStack.spacing = 8
        lobbyQueueStack.isHidden = true

        cameraPopup.controlSize = .large
        microphonePopup.controlSize = .large
        speakerPopup.controlSize = .large
        // A device name is as long as whoever named the device made it:
        // "Studio Display Microphone (Standard)" measures 287pt, past the
        // rail's own 280pt floor, so at the default resistance the rail could
        // not be dragged down to its minimum. The name truncates instead.
        for popup in [cameraPopup, microphonePopup, speakerPopup] {
            popup.allowSqueezing(toAtLeast: Self.railControlFloor)
        }

        startButton.controlSize = .large
        // Out of the autoresizing world before `applyMeetFilledStyle`, which
        // activates its own height constraint (44).
        startButton.translatesAutoresizingMaskIntoConstraints = false
        startButton.applyMeetFilledStyle(.accent, title: String(localized: "Ask to join"), symbolName: "video.fill")

        let roomActions = NSStackView(views: [scheduleMeetingButton, bookTimeButton])
        roomActions.orientation = .vertical
        roomActions.alignment = .leading
        roomActions.spacing = 4
        roomActionsStack = roomActions

        // Every block below the room link folds, and remembers being folded. A
        // live host meeting fills this rail — CRM, tasks, NEXT, participants,
        // devices, the waiting room — and the fold is how the owner gets the
        // parts they are not using out of the way.
        let crm = SidebarSection(title: String(localized: "SUBJECT"), key: "crm", body: [categoryControls])
        let tasks = SidebarSection(
            title: String(localized: "TASKS"),
            key: "tasks",
            accessory: tasksControls.newTaskButton,
            body: [tasksControls]
        )
        let identity = SidebarSection(
            title: String(localized: "IDENTITY"),
            key: "identity",
            body: [
                accountLabel, nameField, emailField,
                roomField, bookingContextLabel, roomActions,
            ]
        )
        let upcoming = SidebarSection(
            title: String(localized: "UPCOMING"),
            key: "upcoming",
            accessory: reloadUpcomingButton,
            body: [upcomingStack]
        )
        let participants = SidebarSection(title: String(localized: "PEOPLE"), key: "participants", body: [participantsStack])
        let deviceList = SidebarSection(
            title: String(localized: "DEVICES"),
            key: "devices",
            body: [cameraPopup, microphonePopup, speakerPopup]
        )
        let lobby = SidebarSection(
            title: String(localized: "WAITING ROOM"),
            key: "lobby",
            body: [pendingGuestLabel, lobbyQueueStack]
        )
        crmSection = crm
        tasksSection = tasks
        identitySection = identity
        upcomingSection = upcoming
        participantsSection = participants
        devicesSection = deviceList
        lobbySection = lobby
        // UPCOMING/NEXT and DEVICES are still built above like every other
        // section — `upcomingSection`/`devicesSection` still back real logic
        // (the NEXT countdown, the calendar refresh, and `cameraPopup`/
        // `microphonePopup`/`speakerPopup` are the actual selected-device
        // state read all over this file) — they are just not part of what
        // this rail shows. NEXT duplicated the launch screen's own upcoming
        // list, and DEVICES duplicated the chooser now living under the
        // mute/camera buttons.
        sidebarSections = [crm, tasks, identity, participants, lobby]

        let stack = NSStackView(views: [
            phaseRow, sidebarErrorNotice, hostLiveStatus, crm, tasks, roomLinkRow, sidebarIntroLabel,
            modeControl, identity, participants, lobby,
        ])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.setCustomSpacing(18, after: sidebarIntroLabel)

        let fullWidth: [NSView] = [
            modeControl, roomLinkRow, sidebarErrorNotice, hostLiveStatus, sidebarIntroLabel,
            crm, tasks, identity, participants, lobby,
        ]
        for child in fullWidth {
            child.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        // The rail scrolls; Start / End meeting does not. Whatever a live meeting
        // piles into the sections, the button that ends it stays on the bottom
        // edge of the panel where the owner left it.
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.autohidesScrollers = true
        scroll.horizontalScrollElasticity = .none
        scroll.translatesAutoresizingMaskIntoConstraints = false
        let document = SidebarDocumentView()
        document.addSubview(stack)
        stack.pinToEdges(of: document)
        scroll.documentView = document
        document.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
            // Width from the clip view, height from the content: the rail wraps
            // rather than scrolling sideways, and only ever scrolls vertically.
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
        ])

        // The same flat sidebar surface Calendar, Work, Team and Docs sit on
        // (`StarlingsShellViewController.Column.sidebarInsets`) — decided in
        // over this rail's former rounded, bordered card, so a header
        // here starts at the same x as a header in Work. The shell mounts
        // this view as the inspector column, edge to edge; the stage keeps the
        // shell's column gutter from it (`stageTrailingToRail`).
        let panel = StarlingsShellBackdrop(ground: StarlingsColors.panel)
        let insets = StarlingsShellViewController.Column.sidebarInsets
        panel.addSubview(scroll)
        panel.addSubview(startButton)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: panel.topAnchor, constant: insets.top),
            scroll.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: insets.left),
            scroll.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -insets.right),
            scroll.bottomAnchor.constraint(equalTo: startButton.topAnchor, constant: -14),
            startButton.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: insets.left),
            startButton.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -insets.right),
            startButton.bottomAnchor.constraint(equalTo: panel.bottomAnchor, constant: -insets.bottom),
        ])

        for section in sidebarSections {
            section.onFoldChange = { [weak self] in
                // One section closing can empty or fill nothing else, but the
                // rail's scroll position and the others' state are cheap to
                // re-settle, and this keeps one path for "the rail changed".
                self?.refreshSidebarSections()
            }
        }
        return panel
    }

    /// Re-applies every section's fold over whatever the meeting just showed or
    /// hid inside it. Cheap and idempotent — call it after any change to the
    /// rail's contents rather than reasoning about which section moved.
    private func refreshSidebarSections() {
        for section in sidebarSections {
            section.refresh()
        }
    }

    private func wireActions() {
        cameraPopup.target = self
        cameraPopup.action = #selector(cameraSelectionChanged(_:))
        microphonePopup.target = self
        microphonePopup.action = #selector(microphoneSelectionChanged(_:))
        speakerPopup.target = self
        speakerPopup.action = #selector(speakerSelectionChanged(_:))
        roomField.target = self
        roomField.action = #selector(roomChanged)
        modeControl.target = self
        modeControl.action = #selector(meetingModeChanged)
        startButton.target = self
        startButton.action = #selector(toggleMeeting(_:))
        scheduleMeetingButton.target = self
        scheduleMeetingButton.action = #selector(presentScheduleMeeting(_:))
        bookTimeButton.target = self
        bookTimeButton.action = #selector(openBookableRoom(_:))
        muteButton.target = self
        muteButton.action = #selector(toggleMicrophone(_:))
        configureDeviceMenus()
        cameraButton.target = self
        cameraButton.action = #selector(toggleCamera(_:))
        backgroundButton.target = self
        backgroundButton.action = #selector(presentBackgroundMenu(_:))
        screenShareButton.target = self
        screenShareButton.action = #selector(shareScreen(_:))
        screenShareLayoutButton.target = self
        screenShareLayoutButton.action = #selector(presentScreenShareLayoutMenu(_:))
        screenShareLayoutButton.toolTip = String(localized: "Screen share layout")
        selfViewButton.target = self
        selfViewButton.action = #selector(presentSelfViewMenu(_:))
        selfViewPiP.onClose = { [weak self] in
            self?.closeSelfViewPiP(userInitiated: true)
        }
        selfViewPiP.onHide = { [weak self] in
            self?.hideSelfViewFromAnySurface()
        }
        selfViewPiP.onDockToCorner = { [weak self] in
            self?.dockSelfViewToCorner()
        }
        meetingStage.onHideLocalSelf = { [weak self] in
            self?.hideSelfViewFromAnySurface()
        }
        meetingStage.onMoveLocalSelfToCorner = { [weak self] in
            self?.dockSelfViewToCorner()
        }

        meetingSession.onPhaseChange = { [weak self] phase in
            self?.render(phase: phase)
            self?.updateSurfaceVisibility()
            self?.brandGridBackground.setVisible(for: phase)
            self?.notifyMenubarStateChange()
            self?.welcomeIfArrived(phase)
            if case .failed = phase, self?.meetingContext?.role == .host {
                self?.finalizeCurrentMeetingIfNeeded()
            }
        }
        meetingSession.onLocalVideoTrack = { [weak self] track in
            self?.localVideoTrack = track
            self?.meetingStage.showLocal(track: track)
            self?.selfViewPiP.setTrack(track)
        }
        meetingSession.onLocalScreenShareTrack = { [weak self] track in
            self?.meetingStage.showLocalScreenShare(track: track)
            self?.updateScreenShareLayoutButton()
        }
        meetingSession.onLocalSpeakingChange = { [weak self] isSpeaking in
            self?.meetingStage.setLocalSpeaking(isSpeaking)
        }
        meetingSession.onLocalHandRaisedChange = { [weak self] raised in
            guard let self else { return }
            ownHandRaised = raised
            meetingStage.setLocalHandRaised(raised)
            applyHandAppearance()
        }
        meetingSession.onRaisedHandsChange = { [weak self] hands in
            guard let self else { return }
            let before = Set(raisedHands.map(\.identity))
            let newly = hands.filter { !$0.isLocal && !before.contains($0.identity) }
            if newly.count == 1, let hand = newly.first {
                StarlingsAccessibility.announce(String(localized: "\(hand.name) raised a hand"), from: view)
            } else if newly.count > 1 {
                StarlingsAccessibility.announce(String(localized: "\(newly.count) hands raised"), from: view)
            }
            raisedHands = hands
            applyHandAppearance()
            // The stage badges the tile; this is the other half — the rail says
            // who is waiting when their tile is off-screen or the grid is large.
            if case .connected = meetingSession.phase {
                renderParticipantsList()
            }
        }
        meetingSession.onRemoteVideosChange = { [weak self] videos in
            guard let self else { return }
            remoteVideoSnapshot = videos
            meetingStage.updateRemotes(videos)
            updateScreenShareLayoutButton()
            // A share starting or stopping changes what a participant's context
            // menu can offer, and the stage may have dropped a pin with the
            // person who held it.
            if case .connected = meetingSession.phase {
                renderParticipantsList()
            }
        }
        meetingStage.onStopScreenShare = { [weak self] identity in
            self?.stopRemoteScreenShare(identity: identity)
        }
        meetingStage.onRemoteTilePositions = { [weak self] positions in
            self?.meetingSession.setSpatialAudioPositions(positions)
        }
        armSpatialAudioPreference()
        // The banner is the queue's first row, on the stage. Same two calls the
        // row and ⌘⇧↩ / ⌘⇧⌫ make, so there is one admission path, not three.
        meetingStage.onAdmitKnock = { [weak self] in
            self?.admitNextWaitingGuest(nil)
        }
        meetingStage.onDeclineKnock = { [weak self] in
            self?.rejectNextWaitingGuest(nil)
        }
        meetingStage.onShowKnockQueue = { [weak self] in
            self?.revealWaitingRoom()
        }
        meetingSession.onParticipantCountChange = { [weak self] count in
            self?.participantCount = count
            self?.participantCountText = String(localized: "\(count) participants")
            self?.refreshStageReadout()
            self?.notifyMenubarStateChange()
            self?.announceArrival(peopleCount: count)
        }
        meetingSession.onParticipantArrived = { [weak self] name in
            guard let self else { return }
            StarlingsAccessibility.announce(String(localized: "\(name) joined"), from: view)
        }
        meetingSession.onParticipantLeft = { [weak self] name in
            guard let self else { return }
            StarlingsAccessibility.announce(String(localized: "\(name) left"), from: view)
        }
        meetingSession.onConnectionQualityChange = { [weak self] quality in
            self?.participantQuality = quality
            self?.updateConnectionQualityButton()
            self?.renderParticipantsList()
            // Remote tiles carry their own quality through MeetingRemoteVideo;
            // the local tile has no such record, so it is updated directly.
            self?.meetingStage.setLocalConnectionQuality(
                quality.first(where: \.isLocal)?.quality ?? .unknown
            )
        }
        meetingSession.onBandwidthChange = { [weak self] snapshot in
            self?.bandwidthSnapshot = snapshot
            self?.updateBandwidthButton()
        }
        meetingSession.onMeetingContext = { [weak self] context in
            self?.meetingContext = context
            self?.meetingStartedAt = context.startedAt
            // Only the host is offered the stop control. Joining as a guest in
            // the same window must not leave it behind on the stage.
            self?.meetingStage.setCanModerateShares(context.role == .host)
            if context.role == .host {
                Task { await self?.retryPendingArtifacts() }
            }
        }
        meetingSession.onHostStateChange = { [weak self] holdsHost, hostIdentity in
            guard let self else { return }
            self.meetingHoldsHost = holdsHost
            if let context = self.meetingContext {
                self.meetingContext = MeetingContext(
                    room: context.room,
                    meetingID: context.meetingID,
                    artifactToken: context.artifactToken,
                    role: context.role,
                    startedAt: context.startedAt,
                    ownerIdentity: context.ownerIdentity,
                    hostIdentity: hostIdentity
                )
            }
            self.applyHostStateToControls()
            if !holdsHost, hostIdentity == nil { self.claimVacantHost() }
            if !holdsHost, hostIdentity != nil, self.takeHostAfterJoin {
                self.takeHostAfterJoin = false
                self.claimHost()
            }
        }
        meetingSession.onHostReleaseRequested = { [weak self] in
            await self?.completeRequestedHostTransfer()
        }
        meetingSession.onHostOffered = { [weak self] name in
            await self?.receiveHostOffer(from: name)
        }
        meetingSession.onTranscriptionStatus = { [weak self] status in
            self?.setTranscriptionNotice(status.isEmpty ? nil : status)
        }
        meetingSession.onTranscriptSegment = { [weak self] segment in
            await self?.receiveTranscriptSegment(segment)
        }
        meetingSession.wordChecker = StarlingsSpellChecker.isWord
        meetingSession.onChatMessage = { [weak self] message in
            self?.receiveChatMessage(message)
        }
        meetingSession.onReaction = { [weak self] reaction, sender in
            self?.reactionOverlay.fly(reaction, from: sender)
        }
        meetingSession.onChatReactionsChange = { [weak self] tally in
            self?.chatPanel.setReactions(tally)
        }
        // A mute this Mac did not press — the host closed it, or something
        // else moved the published track. Either way the button must say what
        // is actually true.
        meetingSession.onMicrophoneEnabledChange = { [weak self] enabled in
            guard let self, isMicrophoneEnabled != enabled else { return }
            isMicrophoneEnabled = enabled
            applyMicrophoneControlAppearance()
            notifyMenubarStateChange()
        }
        meetingSession.onLocalScreenShareEnabledChange = { [weak self] enabled in
            guard let self, isScreenShareEnabled != enabled else { return }
            if enabled {
                // The delegate does not carry the selected source. The picker
                // applies the source-aware border after publish returns; keep
                // this callback from briefly framing the wrong display.
                isScreenShareEnabled = true
                screenShareButton.title = String(localized: "Stop sharing")
                setMeetingControlImage(
                    screenShareButton,
                    symbol: "rectangle.on.rectangle.slash",
                    accessibility: screenShareButton.title
                )
            } else {
                applyScreenShareUI(enabled: false)
            }
            notifyMenubarStateChange()
        }
        meetingSession.onMicrophoneMutedByHost = { [weak self] mutedBy in
            self?.present(StarlingsError(
                code: "media.microphone_muted",
                title: String(localized: "Microphone muted"),
                message: String(localized: "\(mutedBy) muted you. Unmute when you need to speak — ")
                    + "only you can open your microphone again.",
                severity: .notice
            ))
        }
        meetingSession.onRemovedByHost = { [weak self] removedBy in
            // Said before the disconnect lands, so the meeting ends with a
            // reason rather than as a connection that dropped.
            self?.present(StarlingsError(
                code: "meeting.removed_by_host",
                title: String(localized: "Removed from the meeting"),
                message: String(localized: "\(removedBy) removed you from this meeting. ")
                    + "You can ask to join again.",
                severity: .notice
            ))
        }
        meetingSession.onScreenShareStoppedByHost = { [weak self] stoppedBy in
            guard let self else { return }
            // Take the border down and put the button back before saying
            // anything — the notice explains a state the app is already in.
            applyScreenShareUI(enabled: false)
            present(StarlingsError(
                code: "media.screen_share_stopped",
                title: String(localized: "Screen sharing stopped"),
                message: String(localized: "\(stoppedBy) stopped your screen share. You can share again when you need to."),
                severity: .notice
            ))
        }
        meetingSession.onNonFatalError = { [weak self] failure in
            guard let self else { return }
            // Degraded, not broken. Say it where it happened and let the
            // meeting carry on.
            if failure.code.hasPrefix("chat.") || failure.code == "media.datachannel_timeout" {
                chatPanel.setNotice(failure.message)
            }
            present(failure)
        }
    }

    private func prepareDevices() async {
        watchConnectivityForPendingArtifacts()
        let pendingArtifacts = await artifactOutbox.retryPending()
        if pendingArtifacts > 0 {
            setTranscriptionNotice(String(localized: "\(pendingArtifacts) UPLOAD PENDING"))
        }
        applyStoredOwnerSession()
        devices.onDevicesChanged = { [weak self] in
            self?.reloadDeviceMenus(preserveSelection: true)
        }
        devices.beginMonitoring()
        // viewDidAppear fires on every onboarding↔meeting swap; without the
        // guard each pass stacked another observer, and every preference change
        // restarted the prejoin camera once per accumulated registration.
        if mediaPreferencesObserver == nil {
            mediaPreferencesObserver = NotificationCenter.default.addObserver(
                forName: MediaDevicePreferences.didChangeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.reloadDeviceMenus(preserveSelection: false)
                    // Only the prejoin preview may own the camera, and only
                    // while no meeting holds it. Restarting the preview during
                    // a call opened a second capture session on the same
                    // device, which floods CMIO ("queue full"), starves the
                    // published track, and reloads the system video-effects
                    // stack on every restart. In a meeting the device change
                    // belongs to the live track instead.
                    guard self.isCameraEnabled else { return }
                    let cameraID = MediaDevicePreferences.resolveCameraID(from: self.devices.cameras)
                    guard self.meetingSession.phase != .connected else {
                        if let cameraID { try? await self.meetingSession.setCameraDevice(id: cameraID) }
                        return
                    }
                    self.showIdleCamera(deviceID: cameraID)
                }
            }
        }
        observeSurfaceVisibility()
        let permissions = await devices.requestPermissions()
        reloadDeviceMenus(preserveSelection: false)

        if permissions.camera == .allowed, isCameraEnabled {
            showIdleCamera(deviceID: selectedCameraID ?? devices.cameras.first?.id)
        } else {
            showIdleCamera(deviceID: nil)
        }
    }

    func applyStoredOwnerSession() {
        if let credentials = try? ownerSessionStore.load() {
            applyOwnerSession(credentials)
        } else {
            clearOwnerSession()
        }
    }

    func applyOwnerSession(_ credentials: OwnerSessionCredentials) {
        nameField.stringValue = credentials.owner.name
        emailField.stringValue = credentials.owner.email
        // The toolbar's workspace badge names who is signed in.
        StarlingsWorkspaceStore.shared.signedInAddress = credentials.owner.email
        refreshIdentityPresentation()
        updateSurfaceVisibility()
        Task {
            await loadPermanentRoom()
            await retryPendingArtifacts()
            await refreshCalendarIntegration()
            self.updateSurfaceVisibility()
            self.notifyMenubarStateChange()
        }
        notifyMenubarStateChange()
    }

    func clearOwnerSession() {
        StarlingsWorkspaceStore.shared.signedInAddress = nil
        refreshIdentityPresentation()
        calendarConnected = false
        upcomingSourcesAvailable = false
        // Signing out answers the question rather than reopening it.
        calendarConnectionKnown = true
        latestUpcomingEvents = []
        latestMenubarUpcomingEvents = []
        latestCalendarEvents = []
        latestTomorrowEvents = []
        latestUpcomingPlan = .empty
        // The next owner's snapshots are painted for them, not skipped.
        paintedCalendarSnapshots = false
        upcomingHasAnswer = false
        renderUpcomingEvents([])
        upcomingEmptyLabel.stringValue = String(localized: "Connect a calendar to see upcoming meetings.")
        Task { await MeetingWarningNotices.cancelAll() }
        updateSurfaceVisibility()
        notifyMenubarStateChange()
    }

    func enterJoinMode() {
        applyRole(.guest)
    }

    /// Start the member-only internal room from Team. Any signed-in Envisioning
    /// member may take its host; the Worker enforces that boundary.
    @discardableResult
    func startInternalRoom() -> Bool {
        guard meetingSession.phase.isIdle, guestAdmissionTask == nil else { return false }
        guard (try? ownerSessionStore.load()) != nil,
              let room = RoomSlug(rawValue: MeetingInvite.internalRoomSlug) else {
            present(StarlingsError.authenticationRequired())
            return false
        }
        hostRoomOverride = room
        applyRole(.host)
        roomField.stringValue = room.rawValue
        setDisplayedRoom(room)
        toggleMeeting(nil)
        return true
    }

    /// One click from Team: point Join at their room, fill in this owner's own
    /// identity, and knock — all of it.
    ///
    /// The knock used to stay a separate press of "Ask to join". That was a
    /// second confirmation of a decision already made by pressing Call, on a
    /// form the person had not filled in. Opening the roster still rings
    /// nobody; only Call does, and Call is deliberate.
    ///
    /// Returns false when a meeting or a knock is already running and Call
    /// stopped short of knocking, so the caller can say why.
    @discardableResult
    func callRoom(slug: String, name: String, email: String) -> Bool {
        let busy = !meetingSession.phase.isIdle || guestAdmissionTask != nil
        if roleBeforeCall == nil, !busy { roleBeforeCall = currentRole }
        enterJoinMode()
        applyGuestIdentity(name: name, email: email, room: slug)
        // Mid-meeting, Call sets Join up and stops: leaving the room you are in
        // is the person's decision, not a side effect of clicking a roster.
        guard !busy else { return false }
        toggleMeeting(nil)
        return true
    }

    /// Back to your own door. A call is a visit, and a visit ends — leaving the
    /// Mac in Join afterwards points `watchedRoom`, the launch surface, and the
    /// menu bar at the room of whoever was called.
    private func restoreRoleAfterCallIfNeeded() {
        guard let role = roleBeforeCall else { return }
        roleBeforeCall = nil
        guard role == .host, currentRole != .host else { return }
        applyRole(.host)
    }

    func applyGuestIdentity(name: String, email: String, room: String) {
        nameField.stringValue = name
        emailField.stringValue = email
        if let entry = GuestRoomEntry(input: room) {
            roomField.stringValue = entry.bookingToken == nil ? entry.room.rawValue : room
            setDisplayedRoom(entry.room)
            bookTimeButton.isHidden = entry.bookingToken != nil
            refreshGuestBookingContext(entry)
        }
        refreshIdentityPresentation()
    }

    func enterHostMode() {
        applyRole(.host)
    }

    /// Join, pointed at a link that chose this workspace (slice F).
    func applyCarriedLink(_ link: String) {
        applyRole(.guest)
        roomField.stringValue = link
        roomChanged()
    }

    private func reloadDeviceMenus(preserveSelection: Bool) {
        let previousCameraID = preserveSelection
            ? (selectedCameraID ?? MediaDevicePreferences.preferredCameraID)
            : MediaDevicePreferences.preferredCameraID
        let previousMicrophoneID = preserveSelection
            ? (selectedMicrophoneID ?? MediaDevicePreferences.preferredMicrophoneID)
            : MediaDevicePreferences.preferredMicrophoneID
        let previousSpeakerID = preserveSelection
            ? (selectedSpeakerID ?? MediaDevicePreferences.resolveSpeakerID(from: devices.speakers))
            : MediaDevicePreferences.resolveSpeakerID(from: devices.speakers)

        populateDevicePopup(
            cameraPopup,
            devices: devices.cameras,
            symbolName: "video.fill",
            selectID: previousCameraID
        )
        populateDevicePopup(
            microphonePopup,
            devices: devices.microphones,
            symbolName: "mic.fill",
            selectID: previousMicrophoneID
        )
        populateDevicePopup(
            speakerPopup,
            devices: devices.speakers,
            symbolName: "speaker.wave.2.fill",
            selectID: previousSpeakerID
        )

        if let microphoneID = selectedMicrophoneID {
            MediaDevicePreferences.applyMicrophoneSelection(id: microphoneID)
        }
        if let speakerID = selectedSpeakerID {
            MediaDevicePreferences.applySpeakerSelection(id: speakerID)
        }
    }

    /// Click the chevron beside mute / camera — or right-click, or press and
    /// hold the button itself — to switch device mid-call. The prejoin popups
    /// are gone once the meeting starts, and Settings is a long way to go for a
    /// headset that just got plugged in. The mute chevron lists speakers too:
    /// picking a headset is one gesture, not a trip to the Meeting menu.
    /// Every surface builds its items from ``deviceMenuItems(for:symbolName:selectedID:action:)``,
    /// so the in-call list is the prejoin list.
    private func configureDeviceMenus() {
        microphoneMenu.delegate = self
        muteButton.menu = microphoneMenu
        cameraMenu.delegate = self
        cameraButton.menu = cameraMenu

        for (button, selector) in [
            (muteButton, #selector(presentMicrophoneMenu(_:))),
            (cameraButton, #selector(presentCameraMenu(_:))),
        ] {
            let press = NSPressGestureRecognizer(target: self, action: selector)
            press.minimumPressDuration = 0.4
            button.addGestureRecognizer(press)
        }
    }

    @objc private func presentMicrophoneMenu(_ sender: NSGestureRecognizer) {
        present(microphoneMenu, from: muteButton, for: sender)
    }

    @objc private func presentCameraMenu(_ sender: NSGestureRecognizer) {
        present(cameraMenu, from: cameraButton, for: sender)
    }

    @objc private func presentMicrophoneChooser(_ sender: NSButton) {
        popUpDeviceMenu(microphoneMenu, from: sender)
    }

    @objc private func presentCameraChooser(_ sender: NSButton) {
        popUpDeviceMenu(cameraMenu, from: sender)
    }

    private func present(_ menu: NSMenu, from button: NSButton, for gesture: NSGestureRecognizer) {
        guard gesture.state == .began else { return }
        popUpDeviceMenu(menu, from: button)
    }

    private func popUpDeviceMenu(_ menu: NSMenu, from button: NSButton) {
        let point = NSPoint(x: 0, y: button.bounds.height + 4)
        menu.popUp(positioning: nil, at: point, in: button)
    }

    @objc private func microphoneSelectedFromMenu(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String,
              devices.microphones.contains(where: { $0.id == id }) else { return }
        MediaDevicePreferences.preferredMicrophoneID = id
        MediaDevicePreferences.applyMicrophoneSelection(id: id)
    }

    @objc private func cameraSelectedFromMenu(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String,
              devices.cameras.contains(where: { $0.id == id }) else { return }
        MediaDevicePreferences.preferredCameraID = id
        guard isCameraEnabled else { return }
        if case .connected = meetingSession.phase {
            Task {
                do {
                    try await meetingSession.setCameraDevice(id: id)
                } catch {
                    // Swapping cameras mid-meeting: the meeting is fine, this
                    // one device isn't. Never a "couldn't join" sheet.
                    present(StarlingsError.liveKit(error, stage: .deviceSwap))
                }
            }
        } else {
            showIdleCamera(deviceID: id)
        }
    }

    private func deviceMenuItems(
        for devices: [MediaDevice],
        symbolName: String,
        selectedID: String?,
        action: Selector?
    ) -> [NSMenuItem] {
        let icon = deviceMenuIcon(symbolName: symbolName)
        return devices.map { device in
            let item = NSMenuItem(title: device.name, action: action, keyEquivalent: "")
            item.image = icon
            item.target = action == nil ? nil : self
            item.representedObject = device.id
            item.state = device.id == selectedID ? .on : .off
            return item
        }
    }

    private func populateDevicePopup(
        _ popup: NSPopUpButton,
        devices: [MediaDevice],
        symbolName: String,
        selectID: String?
    ) {
        let menu = NSMenu()
        // The popup reports its own selection through the popup action, so the
        // items stay actionless here.
        for item in deviceMenuItems(for: devices, symbolName: symbolName, selectedID: nil, action: nil) {
            menu.addItem(item)
        }
        popup.menu = menu
        popup.imagePosition = .imageLeading
        popup.contentTintColor = StarlingsColors.primaryText
        popup.isEnabled = !devices.isEmpty

        if let selectID,
           let index = devices.firstIndex(where: { $0.id == selectID }) {
            popup.selectItem(at: index)
        } else if !devices.isEmpty {
            popup.selectItem(at: 0)
        }
    }

    private func deviceMenuIcon(symbolName: String) -> NSImage? {
        guard let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil) else {
            return nil
        }
        let configured = image.withSymbolConfiguration(
            NSImage.SymbolConfiguration(pointSize: 12, weight: .medium)
        )
        configured?.isTemplate = true
        return configured
    }

    @objc private func cameraSelectionChanged(_ sender: NSPopUpButton) {
        guard devices.cameras.indices.contains(sender.indexOfSelectedItem) else { return }
        let id = devices.cameras[sender.indexOfSelectedItem].id
        MediaDevicePreferences.preferredCameraID = id
        guard isCameraEnabled else { return }
        showIdleCamera(deviceID: id)
    }

    @objc private func microphoneSelectionChanged(_ sender: NSPopUpButton) {
        guard devices.microphones.indices.contains(sender.indexOfSelectedItem) else { return }
        let id = devices.microphones[sender.indexOfSelectedItem].id
        MediaDevicePreferences.preferredMicrophoneID = id
        MediaDevicePreferences.applyMicrophoneSelection(id: id)
    }

    @objc private func speakerSelectionChanged(_ sender: NSPopUpButton) {
        guard devices.speakers.indices.contains(sender.indexOfSelectedItem) else { return }
        selectSpeaker(id: devices.speakers[sender.indexOfSelectedItem].id)
    }

    @objc private func speakerSelectedFromMenu(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String,
              devices.speakers.contains(where: { $0.id == id }) else { return }
        selectSpeaker(id: id)
    }

    /// Unlike the camera and the microphone, the speaker can be changed at any
    /// point in a meeting — headphones go on mid-call more often than not, and
    /// nothing has to be republished for the room to arrive somewhere else.
    private func selectSpeaker(id: String) {
        MediaDevicePreferences.preferredSpeakerID = id
        MediaDevicePreferences.applySpeakerSelection(id: id)
        meetingSession.setSpeaker(id: id)
    }

    /// Between meetings the stage owns the idle preview when it is visible.
    /// Launch has no media preview, so it keeps the stage camera off while it
    /// is on screen.
    private func showIdleCamera(deviceID: String?) {
        let wanted = idleCameraSurfaceIsOnScreen ? deviceID : nil
        if showsOwnerLaunch(for: meetingSession.phase) {
            meetingStage.showPrejoinCamera(deviceID: nil)
        } else {
            meetingStage.showPrejoinCamera(deviceID: wanted)
        }
    }

    /// Is any surface that would show a camera preview actually in front of a
    /// person right now? This app sits open all day between meetings; a
    /// capture session behind a hidden, minimised or covered window is a green
    /// light with no viewer.
    private var idleCameraSurfaceIsOnScreen: Bool {
        guard !NSApp.isHidden, let window = view.window else { return false }
        return window.isVisible
            && !window.isMiniaturized
            && window.occlusionState.contains(.visible)
    }

    /// The camera the stage's prejoin mirror may hold for a given phase — nil
    /// whenever the mirror is not the thing on screen.
    private func idlePrejoinCameraID(for phase: MeetingPhase) -> String? {
        guard isCameraEnabled, phase.isIdle else { return nil }
        guard idleCameraSurfaceIsOnScreen, !showsOwnerLaunch(for: phase) else { return nil }
        return selectedCameraID
    }

    /// Follow the window: give the camera up when the preview goes out of
    /// sight, take it back when it returns. A live meeting owns its own track
    /// and is never touched here.
    private func observeSurfaceVisibility() {
        guard surfaceVisibilityObservers.isEmpty else { return }
        let center = NotificationCenter.default
        let names: [Notification.Name] = [
            NSWindow.didChangeOcclusionStateNotification,
            NSWindow.didMiniaturizeNotification,
            NSWindow.didDeminiaturizeNotification,
            NSApplication.didHideNotification,
            NSApplication.didUnhideNotification,
        ]
        idleCameraSurfaceWasOnScreen = idleCameraSurfaceIsOnScreen
        surfaceVisibilityObservers = names.map { name in
            center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    self?.refreshIdleCameraForVisibilityChange()
                }
            }
        }
    }

    /// Calendar was connected, disconnected, or a source switched in Settings
    /// — another window. Refresh the combined Google and subscription feed
    /// immediately so Home does not wait for the next sweep or relaunch.
    private func observeCalendarSources() {
        guard calendarSourcesObserver == nil else { return }
        calendarSourcesObserver = NotificationCenter.default.addObserver(
            forName: CalendarSourcePreferences.didChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.reloadUpcomingMeetings() }
        }
        upcomingPreferencesObserver = NotificationCenter.default.addObserver(
            forName: CalendarSourcePreferences.upcomingDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.reloadUpcomingMeetings() }
        }
        // Settings saved a new Home order on this Mac: draw it now rather
        // than on the next calendar refresh.
        homeLayoutObserver = NotificationCenter.default.addObserver(
            forName: HomeLayoutCache.didChange,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let layout = note.object as? [HomeModuleSetting] else { return }
            Task { @MainActor in self?.ownerLaunchView.setLayout(layout) }
        }
    }

    /// What Home is made of, from the Worker — the same list the phone and
    /// the browser read. The cached copy already drew the first frame; this
    /// replaces it, and a failed read keeps it.
    private func refreshHomeLayout() async {
        do {
            let layout = try await controlAPI.homeLayout().layout
            ownerLaunchView.setLayout(layout)
            if layout != HomeLayoutCache.load() { HomeLayoutCache.store(layout) }
        } catch {
            // Offline or a stale token: the cached order is still the right
            // order to draw. Nothing to tell the owner about.
        }
        // The language choice rides the same moment: read once per session,
        // cached so the next launch knows it before the Worker answers.
        if let response = try? await controlAPI.language(),
           response.preferred != StarlingsLanguageCache.load() {
            StarlingsLanguageCache.store(response.preferred)
            // Chosen on another device: this process keeps the language it
            // started with, so say so once.
            if let notice = StarlingsLanguageLaunch.restartNotice(for: response.preferred) {
                StarlingsToast.show(notice, in: frontWindow)
            }
        }
    }

    /// Occlusion notifications arrive for every window in the app, and
    /// restarting a capture session on each one would churn the device for
    /// nothing. Only a real on-screen ⇄ off-screen flip moves the camera.
    private func refreshIdleCameraForVisibilityChange() {
        let onScreen = idleCameraSurfaceIsOnScreen
        guard onScreen != idleCameraSurfaceWasOnScreen else { return }
        idleCameraSurfaceWasOnScreen = onScreen
        refreshPrejoinCamera()
    }

    /// Once per open meeting, only while the app is fresh from launch, and only
    /// from an idle host launch screen — never mid-connect, never in Join mode.
    private func shouldAutoReclaim(_ meeting: LobbySnapshotResponseMeeting) -> Bool {
        guard autoReclaimedMeetingID != meeting.id,
              Double(meeting.hostLeaseExpiresAt) <= Date().timeIntervalSince1970 * 1_000,
              Date().timeIntervalSince(launchedAt) < Self.autoReclaimWindow,
              canStartHostRoom,
              guestAdmissionTask == nil else { return false }
        return true
    }

    /// Walk away from a meeting a crash or force-quit left open, instead of
    /// reclaiming it with Start. No artifact to finalize — this app instance
    /// holds no transcript for a meeting it never joined.
    private func closeAbandonedRoom() {
        guard let meetingID = reclaimableMeetingID,
              let room = RoomSlug(rawValue: roomField.stringValue) else { return }
        ownerLaunchView.setStatus(String(localized: "Closing the room…"))
        Task {
            do {
                try await controlAPI.closeOpenMeeting(room: room, meetingID: meetingID)
                reclaimableMeetingID = nil
                await refreshLobbyOnce()
            } catch {
                ownerLaunchView.setStatus(
                    "Couldn’t close the room — \(error.localizedDescription)",
                    tone: .danger,
                    offersClose: true
                )
            }
        }
    }

    @objc private func roomChanged() {
        // A link for another workspace opens there, not here.
        let typed = roomField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if currentRole == .guest, !StarlingsWorkspaceLink.isActive(typed) {
            Task { _ = await LinkWorkspaceOffer.handle(typed, in: view.window) }
            return
        }
        if currentRole == .guest, let entry = GuestRoomEntry(input: roomField.stringValue) {
            guestPresenceSuppressed = false
            if let token = entry.bookingToken {
                roomField.stringValue = MeetingInvite.absoluteURL(
                    path: "/room/\(entry.room.rawValue)/\(token)",
                    webOrigin: MeetingInvite.shareOrigin(configuredWebOrigin: controlAPI.webOrigin)
                )
            } else {
                roomField.stringValue = entry.room.rawValue
            }
            setDisplayedRoom(entry.room)
            refreshGuestBookingContext(entry)
            refreshGuestPresence()
        } else if currentRole == .host, let room = RoomSlug(rawValue: roomField.stringValue) {
            roomField.stringValue = room.rawValue
            setDisplayedRoom(room)
            clearGuestBookingContext()
        }
    }

    private func refreshGuestBookingContext(_ entry: GuestRoomEntry) {
        bookingContextTask?.cancel()
        guard currentRole == .guest, let token = entry.bookingToken else {
            clearGuestBookingContext()
            return
        }
        bookingContextLabel.stringValue = String(localized: "Loading invite…")
        bookingContextLabel.isHidden = false
        bookingContextTask = Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await controlAPI.publicBooking(room: entry.room, token: token)
                guard !Task.isCancelled,
                      GuestRoomEntry(input: roomField.stringValue) == entry else { return }
                switch result {
                case .expired:
                    bookingContextLabel.stringValue = String(localized: "This invite has expired. You can still ask to join.")
                case .scheduled(let projection):
                    bookingContextLabel.stringValue = bookingContextCopy(projection)
                    bookingContextLabel.isHidden = bookingContextLabel.stringValue.isEmpty
                }
            } catch {
                // An invite projection outage degrades to the opaque room; it
                // must never block the guest from joining.
                clearGuestBookingContext()
            }
        }
    }

    private func clearGuestBookingContext() {
        bookingContextTask?.cancel()
        bookingContextTask = nil
        bookingContextLabel.stringValue = ""
        bookingContextLabel.isHidden = true
    }

    private func bookingContextCopy(_ projection: StarlingsMintedBookingProjection) -> String {
        if let endsAt = projection.endsAt.flatMap(ISODate.parse), endsAt < .now {
            return String(localized: "This invite has expired. You can still ask to join.")
        }
        var lines: [String] = []
        if let title = projection.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
            lines.append(title)
        }
        if let startsAt = projection.startsAt.flatMap(ISODate.parse) {
            let day = startsAt.formatted(.dateTime.weekday(.wide).month(.wide).day())
            let start = startsAt.meetTimeString()
            if let endsAt = projection.endsAt.flatMap(ISODate.parse) {
                let end = endsAt.meetTimeString()
                lines.append("\(day) · \(start)–\(end)")
            } else {
                lines.append("\(day) · \(start)")
            }
        }
        if let subject = projection.subject?.trimmingCharacters(in: .whitespacesAndNewlines), !subject.isEmpty {
            lines.append(subject)
        }
        return lines.joined(separator: "\n")
    }

    private func setDisplayedRoom(_ room: RoomSlug) {
        roomLinkRow.setRoomPath(
            room.urlPath,
            webOrigin: MeetingInvite.shareOrigin(configuredWebOrigin: controlAPI.webOrigin)
        )
        syncOwnerLaunchInvite()
        notifyMenubarStateChange()
    }

    @objc private func openBookableRoom(_ sender: Any?) {
        guard let entry = GuestRoomEntry(input: roomField.stringValue), entry.bookingToken == nil else { return }
        let address = MeetingInvite.absoluteURL(
            path: "/book/\(entry.room.rawValue)",
            webOrigin: MeetingInvite.shareOrigin(configuredWebOrigin: controlAPI.webOrigin)
        )
        if let url = URL(string: address) { NSWorkspace.shared.open(url) }
    }

    private func setDisplayedRoomSlug(_ slug: String) {
        if let room = RoomSlug(rawValue: slug) {
            setDisplayedRoom(room)
        } else {
            roomLinkRow.setRoomPath(
                "/room/\(slug)",
                webOrigin: MeetingInvite.shareOrigin(configuredWebOrigin: controlAPI.webOrigin)
            )
            syncOwnerLaunchInvite()
            notifyMenubarStateChange()
        }
    }

    /// The launch surface deliberately has no Host/Join toggle — a signed-in
    /// owner is hosting until they say otherwise. This is the door out to the
    /// guest sidebar, which carries the toggle back.
    @objc func switchToJoinMode(_ sender: Any?) {
        guard meetingSession.phase.isIdle, guestAdmissionTask == nil else { return }
        modeControl.selectedSegment = 1
        meetingModeChanged()
    }

    @objc private func meetingModeChanged() {
        guard meetingSession.phase != .connecting, meetingSession.phase != .connected,
              guestAdmissionTask == nil else {
            modeControl.selectedSegment = currentRole == .host ? 0 : 1
            return
        }
        currentRole = modeControl.selectedSegment == 0 ? .host : .guest
        if currentRole == .host {
            clearGuestBookingContext()
            phaseLabel.stringValue = String(localized: "Your room")
            startButton.applyMeetFilledStyle(.accent, title: String(localized: "Start room"), symbolName: "video.fill")
            emailField.placeholderString = EnvisioningDeployment.exampleAddress
            if let credentials = try? ownerSessionStore.load() {
                nameField.stringValue = credentials.owner.name
                emailField.stringValue = credentials.owner.email
            }
            setTranscriptionNotice(String(localized: "ON THIS MAC"))
            pendingGuestLabel.stringValue = String(localized: "No one on the page yet.")
            clearLobbyQueue()
            Task {
                if let override = hostRoomOverride {
                    roomField.stringValue = override.rawValue
                    setDisplayedRoom(override)
                    ownerLaunchView.setRoomMapped(true)
                } else {
                    await loadPermanentRoom()
                }
                await refreshCalendarIntegration()
                self.updateSurfaceVisibility()
            }
        } else {
            hostRoomOverride = nil
            phaseLabel.stringValue = String(localized: "Join a room")
            startButton.applyMeetFilledStyle(.accent, title: String(localized: "Ask to join"), symbolName: "video.fill")
            emailField.placeholderString = String(localized: "Email address")
            pendingGuestLabel.stringValue = String(localized: "The room owner will admit you.")
            clearLobbyQueue()
            setTranscriptionNotice(String(localized: "SHARED CAPTIONS"))
            if let entry = GuestRoomEntry(input: roomField.stringValue) {
                refreshGuestBookingContext(entry)
            }
        }
        refreshIdentityPresentation()
        refreshSidebarChrome()
        updateSurfaceVisibility()
    }

    private func refreshIdentityPresentation() {
        let credentials = try? ownerSessionStore.load()
        let signedIn = credentials != nil

        if let credentials {
            nameField.stringValue = credentials.owner.name
            emailField.stringValue = credentials.owner.email
            ownerLaunchView.setSignedInEmail(credentials.owner.email)
        } else {
            ownerLaunchView.setSignedInEmail(nil)
        }

        nameField.applyPersistentAppearance(signedIn)
        emailField.applyPersistentAppearance(signedIn, emphasis: .secondary)
        // Host room slug comes from the account / invite actions — don't present it as free text.
        // Guests still type a room to join.
        roomField.applyPersistentAppearance(signedIn && currentRole == .host)

        if signedIn {
            accountLabel.isHidden = true
            if currentRole == .host {
            }
        } else {
            if currentRole == .host {
                accountLabel.stringValue = String(localized: "Not signed in — open Settings")
                accountLabel.textColor = StarlingsColors.secondaryText
                accountLabel.isHidden = false
            } else {
                accountLabel.isHidden = true
            }
        }

        // Text color and font come from applyPersistentAppearance above — the
        // emphasis argument is the only supported way to rank these fields.
    }

    @objc func toggleMeeting(_ sender: Any?) {
        if let guestAdmissionTask {
            guestAdmissionTask.cancel()
            self.guestAdmissionTask = nil
            guestLobbySocketTask?.cancel()
            guestLobbySocketTask = nil
            phaseLabel.stringValue = String(localized: "Join cancelled")
            phaseOrb.isHidden = true
            startButton.applyMeetFilledStyle(.accent, title: String(localized: "Ask to join"), symbolName: "video.fill")
            startButton.isEnabled = true
            modeControl.isEnabled = true
            meetingStage.reset(deviceID: idlePrejoinCameraID(for: meetingSession.phase))
            refreshGuestPresence()
            restoreRoleAfterCallIfNeeded()
            return
        }
        switch meetingSession.phase {
        case .setup, .ended, .failed:
            guard let configuration = configurationFromForm() else {
                admitAfterStartRequestID = nil
                // A filing with no room to file must not wait for the next
                // Start and land on a meeting about something else.
                pendingFiling = nil
                return
            }
            TranscriptPanelPreferences.resetForMeetingStart()
            applyTranscriptPanelVisibility()
            if configuration.role != .host { pendingFiling = nil }
            if configuration.role == .host,
               admitAfterStartRequestID == nil,
               let next = pendingLobbyRequests.first?.id {
                // Start from the menu/button while guests wait ⇒ Start & Admit.
                admitAfterStartRequestID = next
            }
            if configuration.role != .host {
                admitAfterStartRequestID = nil
            }
            meetingContext = nil
            Task {
                await meetingStage.prepareForConnection(localName: configuration.identity.name)
                try? await meetingSession.setBackgroundEffect(backgroundEffect)
                if configuration.role == .host {
                    loadKnownNamesForTranscript()
                    await meetingSession.connect(configuration: configuration, entry: .host)
                } else {
                    beginGuestAdmission(configuration: configuration)
                }
            }
        case .connected:
            let context = meetingContext
            if context?.role == .host, !meetingHoldsHost {
                leaveCompanionMeeting()
                return
            }
            if context?.role == .host, isHostingColleaguesRoom {
                leaveMeetingByReleasingHost()
                return
            }
            if context?.role == .host, isInInternalRoom, hasMacOwnerCompanion {
                leaveMeetingByReleasingHost()
                return
            }
            // On `/room/team` the host's button is Leave and drops nobody, so
            // there is nothing to confirm.
            if context?.role == .host, !isInInternalRoom, participantCount > 1 {
                confirmEndMeeting(others: participantCount - 1)
                return
            }
            endMeetingNow()
        case .connecting:
            break
        }
    }

    /// A companion asks the active host to stop local capture and hand over.
    @objc func takeHost(_ sender: Any?) {
        guard !currentHostIsPhone else { return }
        claimHost()
    }

    /// Ask for the host. A phone host is asked only when it offered the host
    /// to this Mac: an older iPhone build cannot answer a release request.
    private func claimHost() {
        guard meetingSession.phase == .connected,
              let context = meetingContext,
              context.role == .host,
              !meetingHoldsHost,
              !hostMutationInFlight else { return }
        hostMutationInFlight = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { hostMutationInFlight = false }
            do {
                let result = try await controlAPI.claimHost(context: context)
                if result.status == .host {
                    await meetingSession.updateHost(identity: result.hostIdentity)
                } else {
                    setTranscriptionNotice(String(localized: "Waiting for the host to hand over…"))
                }
            } catch {
                present(StarlingsError.wrapping(error, code: "meeting.host_claim_failed", title: String(localized: "Couldn’t take host"), recovery: .retry))
            }
        }
    }

    /// Leave as a companion, or release this Mac's host while another Mac is
    /// already in the room. This keeps the LiveKit room and meeting record open.
    @objc func leaveMeeting(_ sender: Any?) {
        guard meetingSession.phase == .connected,
              meetingContext?.role == .host else { return }
        if meetingHoldsHost {
            guard hasMacOwnerCompanion else { return }
            leaveMeetingByReleasingHost()
        } else {
            leaveCompanionMeeting()
        }
    }

    private func leaveCompanionMeeting() {
        guard !hostMutationInFlight else { return }
        isLeavingMeeting = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { isLeavingMeeting = false }
            await meetingSession.disconnect()
            meetingContext = nil
            meetingHoldsHost = false
        }
    }

    /// The host asked this Mac to host. Another device of the same member
    /// takes it as Take host does; a member in somebody else's room is asked.
    private func receiveHostOffer(from name: String?) async {
        guard meetingSession.phase == .connected, let context = meetingContext else { return }
        if context.role == .host {
            claimHost()
            return
        }
        guard let window = view.window ?? NSApp.mainWindow else { return }
        let alert = NSAlert()
        alert.messageText = String(localized: "\(name ?? String(localized: "Someone")) asked you to host.")
        alert.addButton(withTitle: String(localized: "Take host"))
        alert.addButton(withTitle: String(localized: "Not now"))
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            let accept = response == .alertFirstButtonReturn
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    _ = try await controlAPI.answerHostOffer(room: context.room, meetingID: context.meetingID, accept: accept)
                    if accept { await rejoinAsHost(room: context.room) }
                } catch {
                    // A decline that does not arrive lets the offer run out.
                    guard accept else { return }
                    present(StarlingsError.wrapping(error, code: "meeting.host_offer_failed", title: String(localized: "Couldn’t take host"), recovery: .retry))
                }
            }
        }
    }

    /// Leave the room as a guest and come back as its host, the way the team
    /// room is hosted: a companion first, then Take host once connected.
    private func rejoinAsHost(room: RoomSlug) async {
        takeHostAfterJoin = true
        roleBeforeCall = nil
        await meetingSession.disconnect()
        meetingContext = nil
        hostRoomOverride = room
        applyRole(.host)
        roomField.stringValue = room.rawValue
        setDisplayedRoom(room)
        toggleMeeting(nil)
    }

    /// The people this Mac can hand the host to: other Macs, iPhones and iPads
    /// in the call. The Worker checks that each is an Envisioning member.
    private var hostTargets: [(identity: String, title: String)] {
        let me = meetingContext?.ownerIdentity.map(OwnerDeviceIdentity.person)
        return participantQuality
            .filter { !$0.isLocal && !$0.isHost && ($0.client?.app == .mac || $0.client?.app == .ios) }
            .map { entry in
                let mine = me != nil && OwnerDeviceIdentity.person(entry.id) == me
                let device = entry.client?.app == .ios
                    ? (entry.client?.device == .tablet ? "iPad" : "iPhone")
                    : "Mac"
                return (entry.id, mine
                    ? String(localized: "\(entry.name) · Your \(device)")
                    : "\(entry.name) · \(device)")
            }
    }

    /// Hand the host to another Mac in the call: another of yours, or a
    /// member's. The receiving Mac takes it; this one drains and hands over.
    @objc func moveHost(_ sender: Any?) {
        guard meetingSession.phase == .connected,
              let context = meetingContext,
              context.role == .host,
              meetingHoldsHost,
              !hostMutationInFlight,
              let window = view.window ?? NSApp.mainWindow else { return }
        let targets = hostTargets
        guard !targets.isEmpty else { return }
        let alert = NSAlert()
        alert.messageText = String(localized: "Move host")
        let picker = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 280, height: 26), pullsDown: false)
        for target in targets {
            picker.addItem(withTitle: target.title)
            picker.lastItem?.representedObject = target.identity
        }
        alert.accessoryView = picker
        alert.addButton(withTitle: String(localized: "Move host"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn,
                  let identity = picker.selectedItem?.representedObject as? String else { return }
            let name = targets.first { $0.identity == identity }.map { entry in
                participantQuality.first { $0.id == entry.identity }?.name ?? entry.title
            } ?? identity
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    _ = try await controlAPI.offerHost(context: context, targetIdentity: identity)
                    pendingHostOffer = (identity, name)
                    setTranscriptionNotice(String(localized: "Asked \(name) to host…"))
                } catch {
                    present(StarlingsError.wrapping(error, code: "meeting.host_offer_failed", title: String(localized: "Couldn’t move host"), recovery: .retry))
                }
            }
        }
    }

    /// A companion takes the host on its own when nobody holds it: the host
    /// left, or its device dropped and the lease ran out. `ifVacant` means a
    /// live host is never taken this way, and when two companions try, one
    /// wins and the other stays a companion.
    private func claimVacantHost() {
        guard meetingSession.phase == .connected,
              let context = meetingContext,
              context.role == .host,
              !meetingHoldsHost,
              !hostMutationInFlight,
              !isLeavingMeeting else { return }
        if let last = lastVacantHostClaimAt, Date().timeIntervalSince(last) < 10 { return }
        lastVacantHostClaimAt = Date()
        hostMutationInFlight = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { hostMutationInFlight = false }
            guard let result = try? await controlAPI.claimHost(context: context, ifVacant: true),
                  result.status == .host else { return }
            await meetingSession.updateHost(identity: result.hostIdentity)
        }
    }

    private func leaveMeetingByReleasingHost() {
        guard let context = meetingContext, !hostMutationInFlight else { return }
        isLeavingMeeting = true
        hostReleaseAwaitingResolution = false
        hostReleaseRetryAfter = nil
        hostMutationInFlight = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                hostMutationInFlight = false
                isLeavingMeeting = false
            }
            await completeHostRelease(context: context, disconnectAfterRelease: true)
        }
    }

    private func completeRequestedHostTransfer() async {
        guard let context = meetingContext,
              context.role == .host,
              meetingHoldsHost,
              !hostMutationInFlight,
              !hostReleaseIsBlocked else { return }
        hostReleaseAwaitingResolution = false
        hostMutationInFlight = true
        defer { hostMutationInFlight = false }
        await completeHostRelease(context: context, disconnectAfterRelease: false)
    }

    private func completeHostRelease(context: MeetingContext, disconnectAfterRelease: Bool) async {
        if isScreenShareEnabled {
            await stopScreenSharing()
        }
        await meetingSession.prepareForHostRelease()
        let delivery = await artifactOutbox.flush(room: context.room.rawValue, meetingID: context.meetingID)
        guard delivery.uploaded else {
            hostReleaseAwaitingResolution = false
            hostReleaseRetryAfter = Date().addingTimeInterval(30)
            await meetingSession.resumeHostAfterReleaseFailure()
            setTranscriptionNotice(String(localized: "SAVED — UPLOAD PENDING"))
            present(StarlingsError(
                code: "meeting.host_transcript_pending",
                title: String(localized: "Transcript upload is still pending"),
                message: String(localized: "Starlings kept this Mac as host because its transcript has not reached the room yet. Check your connection and try again."),
                recovery: .retry,
                severity: .notice
            ))
            return
        }

        // Until the Worker confirms the transfer, keep the old host muted.
        // A timeout is ambiguous: the transaction may have committed even
        // though its response did not reach this Mac.
        hostReleaseAwaitingResolution = true
        do {
            var result = try await controlAPI.releaseHost(context: context)
            // `host` means the device that asked has left the call: the Worker
            // dropped its request and kept this Mac the host. On Leave, release
            // again, now with no request, so a companion can claim.
            if disconnectAfterRelease, result.status == .host {
                result = try await controlAPI.releaseHost(context: context)
            }
            hostReleaseAwaitingResolution = false
            hostReleaseRetryAfter = nil
            if result.status == .host {
                await meetingSession.resumeHostAfterReleaseFailure()
                return
            }
            await meetingSession.updateHost(identity: result.hostIdentity)
            if disconnectAfterRelease {
                await meetingSession.disconnect()
                meetingContext = nil
                meetingHoldsHost = false
            }
        } catch {
            // Keep `hostReleaseAwaitingResolution`: the next lobby poll says
            // whether the release committed, and resumes hosting if not.
            hostReleaseRetryAfter = Date().addingTimeInterval(30)
            present(StarlingsError.wrapping(error, code: "meeting.host_release_failed", title: String(localized: "Couldn’t hand over host"), recovery: .retry))
        }
    }

    private func applyHostStateToControls() {
        let connected = meetingSession.phase == .connected
        meetingStage.setLocalIsHost(connected && meetingHoldsHost)
        muteButton.isEnabled = connected && (meetingContext?.role != .host || meetingHoldsHost)
        if connected, meetingContext?.role == .host {
            let hostChanged = transcriptPanelHoldsHost != meetingHoldsHost
            transcriptPanelHoldsHost = meetingHoldsHost
            if meetingHoldsHost {
                hostLeaseHealthy = true
                if hostChanged { setTranscriptPlaceholder(String(localized: "Listening…")) }
                startHostHeartbeat()
                renderHostLiveStatus(active: true)
                startTaskSuggestions()
            } else {
                hostLeaseHealthy = false
                stopHostHeartbeat()
                if hostChanged {
                    setTranscriptPlaceholder(String(localized: "Waiting for shared captions from the host Mac."))
                }
                renderHostLiveStatus(active: false)
                stopTaskSuggestions()
            }
        }
        if connected {
            startButton.applyMeetFilledStyle(.danger, title: meetingMainActionTitle)
            applyEndMeetingButtonAppearance()
        }
    }

    /// Ending as host drops everyone else too. With other people in the room
    /// the button and ⌘⇧W both go through this sheet first.
    private func confirmEndMeeting(others: Int) {
        guard let window = view.window ?? NSApp.mainWindow else {
            endMeetingNow()
            return
        }
        let alert = NSAlert()
        alert.messageText = String(localized: "End the meeting for everyone?")
        alert.informativeText = others == 1
            ? String(localized: "1 other person is still in the room.")
            : "\(others) other people are still in the room."
        alert.alertStyle = .warning
        alert.addButton(withTitle: String(localized: "End meeting"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        alert.buttons.first?.hasDestructiveAction = true
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn else { return }
            self.endMeetingNow()
        }
    }

    /// `/room/team` is nobody's room (ADR 0001): the host's button leaves, and
    /// ending the call for the people still in it is a separate, deliberate
    /// act any member may take. Same sheet as a personal room's End.
    @objc func endMeetingForEveryone(_ sender: Any?) {
        guard isInInternalRoom, case .connected = meetingSession.phase, let context = meetingContext else { return }
        let others = max(participantCount - 1, 0)
        let proceed = { [weak self] in
            guard let self else { return }
            Task {
                try? await self.controlAPI.endMeeting(context: context, everyone: true)
                self.endMeetingNow()
            }
        }
        guard others > 0, let window = view.window ?? NSApp.mainWindow else {
            proceed()
            return
        }
        let alert = NSAlert()
        alert.messageText = String(localized: "End the meeting for everyone?")
        alert.informativeText = others == 1
            ? String(localized: "1 other person is still in the room.")
            : "\(others) other people are still in the room."
        alert.alertStyle = .warning
        alert.addButton(withTitle: String(localized: "End for everyone"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        alert.buttons.first?.hasDestructiveAction = true
        alert.beginSheetModal(for: window) { response in
            guard response == .alertFirstButtonReturn else { return }
            proceed()
        }
    }

    /// Whether the meeting on screen is `/room/team`. Read off the context,
    /// which a member joining somebody else's room does not have yet.
    private var isInInternalRoom: Bool {
        meetingContext?.room.rawValue == MeetingInvite.internalRoomSlug
    }

    private func endMeetingNow() {
        let context = meetingContext
        if context?.role == .guest {
            // A guest who leaves lands back on the room form. Keep that
            // transition from immediately creating a new lurker row.
            guestPresenceSuppressed = true
            stopGuestPresence()
        }
        Task {
            await meetingSession.disconnect()
            if let context, context.role == .host {
                await requestFinalization(context: context)
            }
        }
    }

    /// The room noticing you: a chime and a ring around your own tile, once,
    /// on the transition into a meeting.
    ///
    /// As a guest in somebody else's room the joiner is the only person who
    /// gets anything. Other guests are told nothing at all — a sound for every
    /// arrival is an interruption charged to everybody already talking. The
    /// host and `/room/team` are the exceptions; see `announceArrival` and
    /// docs/PRESENCE.md.
    private func welcomeIfArrived(_ phase: MeetingPhase) {
        guard case .connected = phase else {
            // Armed again by leaving, so the next meeting is welcomed too.
            hasWelcomedArrival = false
            arrivalPeopleBaseline = nil
            return
        }
        guard !hasWelcomedArrival else { return }
        hasWelcomedArrival = true
        WelcomeSound.play()
        meetingStage.welcomeLocal()
    }

    /// The room hearing somebody arrive: the same chime the joiner hears,
    /// played for the people already there. Two rooms do this:
    ///
    /// - **Your own room, as host.** A guest arrives because you pressed
    ///   Admit, and a member walks straight in because `memberAdmission` at
    ///   the Worker let them — silently, which meant the host chimed for their
    ///   own arrival and for nobody else's. The host hears every arrival.
    /// - **`/room/team`**, for everybody. It is ours, not a client's, and
    ///   people drift in and out of it while working.
    ///
    /// Counts are people, not devices — `updateParticipantCount` folds one
    /// account's devices together — so a second device of somebody present is
    /// silent. The first count after connect is the baseline: that is the
    /// joiner's own arrival, and `welcomeIfArrived` has already chimed for it.
    private func announceArrival(peopleCount: Int) {
        guard case .connected = meetingSession.phase else { return }
        guard let context = meetingContext else { return }
        let hears = context.role == .host || context.room.rawValue == MeetingInvite.internalRoomSlug
        guard hears else { return }
        defer { arrivalPeopleBaseline = peopleCount }
        guard let baseline = arrivalPeopleBaseline, peopleCount > baseline else { return }
        WelcomeSound.play()
    }

    @objc func copyInviteLink(_ sender: Any?) {
        _ = roomLinkRow.copyInviteLink()
    }

    @objc func admitNextWaitingGuest(_ sender: Any?) {
        guard meetingSession.phase == .connected, meetingContext?.role == .host else { return }
        guard let requestID = pendingLobbyRequests.first?.id else { return }
        decideLobbyGuest(requestID: requestID, admit: true)
    }

    @objc func rejectNextWaitingGuest(_ sender: Any?) {
        guard let requestID = pendingLobbyRequests.first?.id else { return }
        decideLobbyGuest(requestID: requestID, admit: false)
    }

    private func startAndAdmit(requestID: String, onBehalfOf: String? = nil) {
        if let onBehalfOf { pendingRecorderSenders[requestID] = onBehalfOf }
        admitAfterStartRequestID = requestID
        toggleMeeting(nil)
    }

    private func loadLobbyPeople() async {
        defer { lobbyPeopleLoading = false }
        do {
            let roster = try await controlAPI.peers()
            lobbyPeople = roster.people
            lobbyPeopleLoaded = true
            await refreshLobbyOnce()
        } catch {
            // Booking-attributed notetakers remain usable. A later knock can
            // retry this read before the owner needs to choose a sender.
        }
    }

    private func beginGuestAdmission(configuration: MeetingConfiguration) {
        guestPresenceSuppressed = false
        phaseLabel.stringValue = String(localized: "Requesting admission…")
        phaseOrb.isHidden = false
        startButton.applyMeetFilledStyle(.accent, title: String(localized: "Cancel request"))
        startButton.isEnabled = true
        modeControl.isEnabled = false
        // Hand the knock the row this Mac has been heartbeating so the owner
        // sees one visitor, not a lurker beside a waiting guest.
        let presenceID = guestPresenceRoom == configuration.room ? guestPresenceID : nil
        stopGuestPresence()
        guestAdmissionTask = Task { [weak self] in
            guard let self else { return }
            do {
                let receipt = try await controlAPI.requestJoin(
                    room: configuration.room,
                    identity: configuration.identity,
                    bookingToken: configuration.bookingToken,
                    presenceID: presenceID
                )
                phaseLabel.stringValue = waitingRoomPhaseLabel(count: receipt.waitingCount)
                startGuestLobbySocket(room: configuration.room, receipt: receipt)
                while !Task.isCancelled {
                    let joinStatus = try await controlAPI.joinStatus(room: configuration.room, receipt: receipt)
                    let status = joinStatus.status
                    if status == .waiting {
                        phaseLabel.stringValue = waitingRoomPhaseLabel(count: joinStatus.waitingCount)
                    }
                    switch status {
                    case .admitted, .joined:
                        guestLobbySocketTask?.cancel()
                        guestLobbySocketTask = nil
                        let details = try await controlAPI.exchangeAdmission(room: configuration.room, receipt: receipt)
                        guestAdmissionTask = nil
                        startButton.isEnabled = false
                        try? await meetingSession.setBackgroundEffect(backgroundEffect)
                        await meetingSession.connect(configuration: configuration, entry: .admittedGuest(details))
                        return
                    case .rejected, .expired:
                        throw GuestAdmissionError.rejected
                    default:
                        try await Task.sleep(for: .seconds(StarlingsPollingCadence.lobbyFallback))
                    }
                }
            } catch is CancellationError {
                // The cancel action already restored the controls.
            } catch {
                guestLobbySocketTask?.cancel()
                guestLobbySocketTask = nil
                guestAdmissionTask = nil
                modeControl.isEnabled = true
                startButton.applyMeetFilledStyle(.accent, title: String(localized: "Ask to join"), symbolName: "video.fill")
                startButton.isEnabled = true
                let failure = StarlingsError.wrapping(
                    error,
                    code: "lobby.join_failed",
                    title: String(localized: "Couldn’t join"),
                    recovery: .retry
                )
                phaseLabel.stringValue = failure.title
                phaseOrb.isHidden = true
                present(failure)
                // A knock refused because the owner is away is the common case
                // here. Go back to heartbeating so they are still standing at
                // the door when the owner opens the app.
                refreshGuestPresence()
            }
        }
    }

    /// Mirrors the web guest lobby socket so Mac Join learns admit/waiting updates promptly.
    private func startGuestLobbySocket(room: RoomSlug, receipt: JoinRequestReceipt) {
        guestLobbySocketTask?.cancel()
        guestLobbySocketTask = Task { [weak self] in
            guard let self else { return }
            let httpURL = ["rooms", room.rawValue, "lobby", "socket"]
                .reduce(controlAPI.apiBaseURL) { $0.appending(path: $1) }
            guard var components = URLComponents(url: httpURL, resolvingAgainstBaseURL: false) else {
                return
            }
            components.scheme = components.scheme == "https" ? "wss" : "ws"
            components.queryItems = LobbySocketQuery(requestID: receipt.requestID, token: receipt.lobbyToken).queryItems
            guard let url = components.url else { return }
            // Shared session: a per-attempt URLSession is never invalidated and
            // leaks its delegate queue across join/cancel cycles.
            let task = URLSession.shared.webSocketTask(with: url)
            task.resume()
            defer { task.cancel(with: .goingAway, reason: nil) }
            while !Task.isCancelled {
                do {
                    let message = try await task.receive()
                    guard case .string(let text) = message,
                          let data = text.data(using: .utf8)
                    else { continue }
                    // The socket carries two shapes; the count is the one this
                    // line draws, and a status packet simply is not one.
                    if let waiting = try? JSONDecoder().decode(LobbyWaitingMessage.self, from: data) {
                        let count = waiting.waitingCount
                        await MainActor.run {
                            // Only while still waiting.
                            //
                            // Cancelling this task does not interrupt a
                            // `receive()` that is already parked — it is a
                            // delegate API bridged to a continuation, and it
                            // returns whatever the socket had in flight. So the
                            // admitted path could cancel, connect, and then have
                            // a late "still waiting" packet paint the waiting
                            // line back over "In meeting", where it stayed for
                            // the rest of the call.
                            //
                            // Guarding on the phase rather than on `isCancelled`
                            // because the phase is the thing this line is about:
                            // it belongs to the waiting room, so it may only be
                            // written while there is one. `isIdle` rather than
                            // `.setup` — somebody who left one meeting and asked
                            // to join another is waiting from `.ended`.
                            guard self.meetingSession.phase.isIdle else { return }
                            self.phaseLabel.stringValue = self.waitingRoomPhaseLabel(count: count)
                        }
                    }
                } catch {
                    break
                }
            }
        }
    }

    @objc func presentScheduleMeeting(_ sender: Any? = nil) {
        NSApp.sendAction(#selector(AppDelegate.showCalendar(_:)), to: nil, from: sender)
    }

    @objc func presentCalendarToday(_ sender: Any? = nil) {
        NSApp.sendAction(#selector(AppDelegate.showCalendarToday(_:)), to: nil, from: sender)
    }

    @objc func presentWork(_ sender: Any? = nil) {
        NSApp.sendAction(#selector(AppDelegate.showWork(_:)), to: nil, from: sender)
    }

    func calendarRoomContext() -> (slug: String, joinURL: String)? {
        let slug = roomField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !slug.isEmpty else { return nil }
        let joinURL = MeetingInvite.absoluteURL(
            slug: slug,
            webOrigin: MeetingInvite.shareOrigin(configuredWebOrigin: controlAPI.webOrigin)
        )
        return (slug, joinURL)
    }

    /// Next few days for the schedule sheet columns (wider than the idle “today” list).
    private func loadScheduleAgendaEvents() async -> [CalendarEventSummary] {
        do {
            // ~30 weekdays ≈ six calendar weeks ahead.
            return try await controlAPI.upcomingCalendarEvents(hours: Self.hoursUntilEndOfDayOffset(44))
        } catch {
            return latestUpcomingEvents
        }
    }

    /// Hours until local start of day `offset+1` days from today (at least 1).
    private static func hoursUntilEndOfDayOffset(_ offset: Int) -> Int {
        let calendar = Calendar.current
        let now = Date()
        let startOfToday = calendar.startOfDay(for: now)
        guard let end = calendar.date(byAdding: .day, value: offset + 1, to: startOfToday) else {
            return max(24, (offset + 1) * 24)
        }
        return max(1, Int(ceil(end.timeIntervalSince(now) / 3_600)))
    }

    private func createScheduledEvent(_ draft: ScheduleMeetingDraft) async {
        do {
            _ = try await controlAPI.createCalendarEvent(
                title: draft.title,
                start: draft.start,
                end: draft.end,
                joinURL: draft.joinURL,
                roomSlug: draft.roomSlug,
                attendees: draft.attendees,
                timeZone: draft.timeZoneIdentifier
            )
            phaseLabel.stringValue = String(localized: "Calendar event created")
            await refreshUpcomingMeetings()
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.4) { [weak self] in
                guard let self, self.phaseLabel.stringValue == "Calendar event created" else { return }
                self.phaseLabel.stringValue = String(localized: "Your room")
            }
        } catch {
            present(StarlingsError.wrapping(error, code: "calendar.event_failed", title: String(localized: "Couldn’t create the Calendar event"), recovery: .retry))
        }
    }

    private func refreshCalendarIntegration() async {
        guard currentRole == .host, (try? ownerSessionStore.load()) != nil else {
            calendarConnected = false
            upcomingSourcesAvailable = false
            calendarConnectionKnown = true
            latestMenubarUpcomingEvents = []
            latestCalendarEvents = []
            latestTomorrowEvents = []
            latestUpcomingPlan = .empty
            ownerLaunchView.setPublicEvents([])
            renderUpcomingEvents([])
            upcomingEmptyLabel.stringValue = String(localized: "Sign in to list meetings from Google Calendar.")
            // Signed out: nobody's layout. The default, not the last owner's.
            if HomeLayoutCache.load() != HomeLayout.defaults { HomeLayoutCache.clear() }
            if StarlingsLanguageCache.load() != nil { StarlingsLanguageCache.clear() }
            return
        }
        scheduleMeetingButton.isEnabled = true
        // Usually done already, at launch (`paintHomeSnapshots`); a sign-in
        // that arrives later paints here, still before the first request.
        paintHomeSnapshots()
        await refreshHomeLayout()
        await refreshSetup()
        ownerLaunchView.setPublicEvents(await PublicEventsCalendar.load())
        do {
            let status = try await controlAPI.calendarStatus()
            // A connect made in Settings outranks a status KV has not caught
            // up with — see `CalendarSourcePreferences.googleConnectionGrace`.
            calendarConnected = status.connected || CalendarSourcePreferences.googleConnectionRecentlyAsserted()
            calendarConnectionKnown = true
            // Which surfaces every window lists. An older Worker
            // has no `sources`; its `connected` is the best it knows.
            StarlingsCalendarSources.record(server: calendarConnected || (status.sources ?? false))
        } catch {
            // A failed request proves nothing about whether an account is
            // attached — offline is not disconnected — so the flag stays where
            // it was (a snapshot may have set it) and the copy keeps its
            // mouth shut. Setting it false here blanked a painted agenda
            // offline and offered "Connect a calendar" over it.
        }
        await refreshUpcomingMeetings()
    }

    /// Every Home module's last answer, from disk, before any request goes
    /// out (docs/CACHING.md). The watches paint theirs as they
    /// start; this is the calendar's half and EVENTS, then the launch surface
    /// is told the pass is over so cached modules draw without waiting for a
    /// module that had nothing saved. Synchronous on purpose: the window
    /// controller calls it before the first frame.
    func paintHomeSnapshots() {
        guard currentRole == .host else { return }
        paintCalendarSnapshots()
        if let events = PublicEventsCalendar.cached() {
            ownerLaunchView.setPublicEvents(events)
        }
        ownerLaunchView.finishSnapshotPass()
    }

    /// The last answers first (docs/CACHING.md): UPCOMING is right in the
    /// first frame, and the live reads replace them in
    /// place. Only on a cold surface — once anything live has landed, the
    /// snapshot is older than what is drawn.
    private var paintedCalendarSnapshots = false
    /// UPCOMING holds an answer — a snapshot or a live read — that a failed
    /// refresh must leave on screen.
    private var upcomingHasAnswer = false
    private func paintCalendarSnapshots() {
        guard !paintedCalendarSnapshots, controlAPI.signedInOwnerEmail != nil else { return }
        paintedCalendarSnapshots = true
        // The policy the agenda was last drawn under, first: the live
        // preferences then confirm the plan instead of reordering it.
        if let cached = controlAPI.snapshot(MeetingControlAPI.calendarPreferencesSnapshotKey, as: CalendarPreferencesResponse.self) {
            upcomingPreferences = cached.value.upcoming
        }
        if latestCalendarEvents.isEmpty,
           let cached = controlAPI.snapshot(MeetingControlAPI.upcomingSnapshotKey, as: CalendarEventsResponse.self) {
            var seen = Set<String>()
            let events = cached.value.summaries
                .sorted { (parseCalendarISODate($0.start) ?? .distantFuture) < (parseCalendarISODate($1.start) ?? .distantFuture) }
                .filter { seen.insert($0.id).inserted }
            // A snapshot says a source was answering when it was taken, and
            // a saved empty day is an answer too: "Nothing left today", not
            // placeholders until the calendar replies.
            calendarConnected = true
            upcomingSourcesAvailable = true
            calendarConnectionKnown = true
            upcomingHasAnswer = true
            applyCalendarEvents(events)
        }
    }

    private func refreshUpcomingMeetings() async {
        var events: [CalendarEventSummary] = []
        var hasUpcomingSubscriptions = false
        if let preferences = try? await controlAPI.calendarPreferences() {
            upcomingPreferences = preferences.upcoming
            if !calendarConnected,
               !preferences.disabledCalendarKeys.contains(CalendarKeys.subscribedAccount),
               let subscriptions = try? await controlAPI.calendarSubscriptions() {
                let excluded = Set(preferences.upcomingExcludedSubscriptionIds)
                let disabled = Set(preferences.disabledCalendarKeys)
                hasUpcomingSubscriptions = subscriptions.contains { subscription in
                    !excluded.contains(subscription.id) && !disabled.contains(CalendarKeys.subscription(subscription.id))
                }
            }
        }
        upcomingSourcesAvailable = calendarConnected || hasUpcomingSubscriptions
        if upcomingSourcesAvailable {
            do {
                events = try await controlAPI.upcomingCalendarEvents(hours: upcomingPreferences.requestHours)
                upcomingHasAnswer = true
            } catch {
                ownerLaunchView.setStatus(
                    "Couldn’t load upcoming meetings.",
                    tone: .danger,
                    detail: (error as? StarlingsError)?.logLine ?? error.localizedDescription
                )
                // The last answer stays on screen, painted from the snapshot
                // or a read before this one: a failed refresh is not an
                // empty day (docs/CACHING.md).
                if upcomingHasAnswer {
                    applyCalendarEvents(latestCalendarEvents)
                    return
                }
                upcomingEmptyLabel.stringValue = String(localized: "Couldn’t reach your calendar.")
            }
        }
        events.sort { left, right in
            let leftStart = parseCalendarISODate(left.start) ?? .distantFuture
            let rightStart = parseCalendarISODate(right.start) ?? .distantFuture
            return leftStart < rightStart
        }
        var seen = Set<String>()
        events = events.filter { seen.insert($0.id).inserted }

        applyCalendarEvents(events)
    }

    /// Invitations and events from email are answered from INBOX
    /// (`WorkRowAction.respondToInvitation`, `.addForwardedEvent`); Upcoming
    /// reads again so an accepted or added event shows at once.
    func refreshUpcomingAfterCalendarAnswer() {
        Task { await refreshUpcomingMeetings() }
    }

    /// The single place every Home Upcoming list on this screen is cut from one
    /// owner-selected Google and subscription calendar read. `MeetingFocus`
    /// decides what is on the agenda, which day each row belongs to, and which one — if any — is
    /// the hero; this surface only draws the shared compact projection.
    private func applyCalendarEvents(_ events: [CalendarEventSummary], now: Date = Date()) {
        latestCalendarEvents = events
        let plan = MeetingFocus.classify(events, now: now, preferences: upcomingPreferences)
        latestUpcomingPlan = plan
        latestTomorrowEvents = plan.events(in: .tomorrow)
        let today = Self.remainingToday(in: plan)
        // The menu bar consumes the same compact projection as every other Home
        // surface. It may draw it differently, but it must not invent a second
        // answer about whether tomorrow belongs.
        latestMenubarUpcomingEvents = ([plan.focus].compactMap { $0 } + plan.homeRows)
        if plan.focus == nil {
            upcomingEmptyLabel.stringValue = MeetingFocus.closedDaySummary(plan)
            if events.isEmpty, calendarConnectionKnown, !upcomingSourcesAvailable {
                upcomingEmptyLabel.stringValue = StarlingsWorkspace.active.calendarConnectable
                    ? String(localized: "Connect a calendar to see upcoming meetings.")
                    : String(localized: "Calendar connects to Google only.")
            }
        }
        renderUpcomingEvents(today)
        // The warning follows the agenda: the plan already dropped what has
        // ended and every placeholder, and `MeetingAlertPlan` skips the
        // demoted and the all-day, as the phone's does.
        let agenda = plan.agenda
        Task { await MeetingWarningNotices.synchronize(meetings: agenda, now: now) }
        armMeetingWarningResync()
    }

    /// The switch in Settings › Audio reaches the session without a rejoin.
    /// `UserDefaults.didChangeNotification` fires for every key, so the value
    /// is compared before the session hears about it.
    private func armSpatialAudioPreference() {
        guard spatialAudioObserver == nil else { return }
        spatialAudioObserver = NotificationCenter.default.addObserver(
            forName: UserDefaults.didChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let wanted = SpatialAudioPreferences.isEnabled()
                guard wanted != self.spatialAudioWanted else { return }
                self.spatialAudioWanted = wanted
                self.meetingSession.setSpatialAudio(enabled: wanted)
            }
        }
    }

    /// A lead or a switch changed in Settings: the pending set is rewritten
    /// from the last plan, the way the phone's store does on any defaults
    /// change. Armed once; the observer lives as long as this controller.
    private func armMeetingWarningResync() {
        guard meetingWarningObserver == nil else { return }
        meetingWarningObserver = NotificationCenter.default.addObserver(
            forName: UserDefaults.didChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let agenda = self.latestUpcomingPlan.agenda
                Task { await MeetingWarningNotices.synchronize(meetings: agenda) }
            }
        }
    }

    /// What is left of today, in order: the meeting under way, then the ones
    /// still to come. The plan already dropped everything that has ended, every
    /// placeholder row, and everything that starts on another day.
    private static func remainingToday(in plan: UpcomingPlan<CalendarEventSummary>) -> [CalendarEventSummary] {
        plan.events(in: .now) + plan.events(in: .today)
    }

    /// UPCOMING is a claim about what is still ahead, and Calendar reads are
    /// minutes apart at best — on the idle launch surface, only on demand. So the
    /// clock re-cuts the lists locally every minute: a meeting leaves the list
    /// when it ends, not when the network next answers. No network, no re-render
    /// unless the answer actually changed (a rebuild would collapse "show more").
    private func startUpcomingFreshnessSweep() {
        upcomingFreshnessTask?.cancel()
        upcomingFreshnessTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard !Task.isCancelled, let self else { return }
                self.refreshUpcomingFreshness()
            }
        }
    }

    private func refreshUpcomingFreshness() {
        guard !latestCalendarEvents.isEmpty else { return }
        let now = Date()
        let plan = MeetingFocus.classify(latestCalendarEvents, now: now, preferences: upcomingPreferences)
        let today = Self.remainingToday(in: plan)
        let tomorrow = plan.events(in: .tomorrow)
        guard today.map(\.id) != latestUpcomingEvents.map(\.id)
            || tomorrow.map(\.id) != latestTomorrowEvents.map(\.id)
            || plan.focus?.id != latestUpcomingPlan.focus?.id
            // Same hero, but it has started: the label over it changes.
            || plan.heroLabel != latestUpcomingPlan.heroLabel else { return }
        applyCalendarEvents(latestCalendarEvents, now: now)
    }

    @objc private func reloadUpcomingMeetings() {
        upcomingReloadTask?.cancel()
        upcomingReloadTask = Task { await refreshCalendarIntegration() }
    }

    private func renderUpcomingEvents(_ events: [CalendarEventSummary]) {
        defer { refreshSidebarSections() }
        upcomingStack.arrangedSubviews.forEach {
            upcomingStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        upcomingRows = []
        // The shared plan has already selected the hero and compact following
        // rows. This surface only draws that projection; it does not decide
        // whether tomorrow belongs or how many rows fit below the hero.
        latestUpcomingEvents = events
        syncOwnerLaunchUpcoming()
        upcomingRenderMode = showsNextOnly ? .next : .list
        if showsNextOnly {
            renderNextMeeting()
            notifyMenubarStateChange()
            return
        }
        upcomingSection.title = String(localized: "UPCOMING")
        let plan = latestUpcomingPlan
        if plan.focus == nil, plan.homeRows.isEmpty {
            upcomingStack.addArrangedSubview(upcomingEmptyLabel)
            upcomingEmptyLabel.widthAnchor.constraint(equalTo: upcomingStack.widthAnchor).isActive = true
            notifyMenubarStateChange()
            return
        }
        if plan.focus == nil {
            upcomingStack.addArrangedSubview(upcomingEmptyLabel)
            upcomingEmptyLabel.widthAnchor.constraint(equalTo: upcomingStack.widthAnchor).isActive = true
        }

        if let focus = plan.focus {
            let row = UpcomingMeetingRow(event: focus)
            row.onHost = { [weak self] selected in
                self?.joinUpcomingEvent(selected)
            }
            row.onToggleDemoted = { [weak self] selected in self?.toggleUpcomingDemoted(selected) }
            upcomingStack.addArrangedSubview(row)
            upcomingRows.append(row)
            row.widthAnchor.constraint(equalTo: upcomingStack.widthAnchor).isActive = true
        }

        for event in plan.homeRows {
            let tier = plan.tier(of: event)
            let row = UpcomingCompactRow(
                event: event,
                showsTimeLeft: tier == .now || tier == .today
            )
            row.onUse = { [weak self] selected in
                self?.joinUpcomingEvent(selected)
            }
            row.onToggleDemoted = { [weak self] selected in self?.toggleUpcomingDemoted(selected) }
            upcomingStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: upcomingStack.widthAnchor).isActive = true
        }
        notifyMenubarStateChange()
    }

    /// While a meeting runs, the calendar section stops being a list. The host is
    /// already in the meeting the list would offer to start; the only calendar
    /// fact that can change what they do now is what comes after this one, and
    /// how long there is — so the section becomes exactly that, one row.
    private var showsNextOnly: Bool {
        switch meetingSession.phase {
        case .connecting, .connected:
            return currentRole == .host
        case .setup, .ended, .failed:
            return false
        }
    }

    private func renderNextMeeting() {
        upcomingSection.title = String(localized: "NEXT")
        let next = Self.nextEvent(
            in: latestUpcomingEvents,
            now: Date(),
            meetingStartedAt: meetingStartedAt
        )
        renderedNextEventID = next?.id
        guard let next else {
            upcomingStack.addArrangedSubview(nextEmptyLabel)
            nextEmptyLabel.widthAnchor.constraint(equalTo: upcomingStack.widthAnchor).isActive = true
            return
        }
        let row = UpcomingMeetingRow(event: next, showsAction: false)
        row.onToggleDemoted = { [weak self] selected in self?.toggleUpcomingDemoted(selected) }
        upcomingStack.addArrangedSubview(row)
        upcomingRows = [row]
        row.widthAnchor.constraint(equalTo: upcomingStack.widthAnchor).isActive = true
    }

    /// The earliest meeting that starts after this one began — so a meeting that
    /// overlaps this one still counts, which is the case worth warning about.
    ///
    /// Two exclusions, both about not lying: anything already running when this
    /// meeting started is either this meeting or one already missed, and anything
    /// that has since ended is over. A meeting that has *started* but not ended
    /// stays — the host running past the hour is exactly who needs to see it, and
    /// the countdown flips to what is left of it.
    private static func nextEvent(
        in events: [CalendarEventSummary],
        now: Date,
        meetingStartedAt: Date?
    ) -> CalendarEventSummary? {
        let startedAt = meetingStartedAt ?? now
        return events
            .compactMap { event -> (event: CalendarEventSummary, start: Date)? in
                guard !event.demoted else { return nil }
                guard let start = parseCalendarISODate(event.start), start > startedAt else { return nil }
                if let end = parseCalendarISODate(event.end), end <= now { return nil }
                return (event, start)
            }
            .min { $0.start < $1.start }?
            .event
    }

    /// Local arithmetic, once a second, off the meeting clock — no network.
    ///
    /// The clock can also change *which* meeting is next: one ends, or the meeting
    /// after it becomes the nearer one. Re-pick before ticking so NEXT never sits
    /// on a finished meeting waiting for the five-minute Calendar refresh.
    private func refreshUpcomingCountdowns() {
        if upcomingRenderMode == .next {
            let next = Self.nextEvent(
                in: latestUpcomingEvents,
                now: Date(),
                meetingStartedAt: meetingStartedAt
            )
            if next?.id != renderedNextEventID {
                renderUpcomingEvents(latestUpcomingEvents)
                return
            }
        }
        guard !upcomingRows.isEmpty else { return }
        let now = Date()
        for row in upcomingRows {
            row.refreshRelativeTime(now: now)
        }
    }

    /// Re-read Calendar every few minutes while the meeting runs, so NEXT keeps
    /// telling the truth after somebody moves, cancels, or adds an event
    /// mid-call. The countdown itself needs no network.
    private func startNextMeetingWatch() {
        stopNextMeetingWatch()
        nextMeetingWatchTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                await self?.refreshUpcomingMeetings()
                try? await Task.sleep(for: .seconds(300))
            }
        }
    }

    private func stopNextMeetingWatch() {
        nextMeetingWatchTask?.cancel()
        nextMeetingWatchTask = nil
    }

    /// The window this Mac asks the control plane for. The same configured
    /// horizon the phone and the web ask for, plus the shared request slack so
    /// an event at the edge does not pop in and out. Keeping the full feed here
    /// leaves Calendar and the other surfaces with the same agenda; the shared
    /// Home projection decides what the idle card advertises.
    /// Join, in the app, never the browser. Our own room starts as host with
    /// the event's filing and guest list; a colleague's Meet room is a knock,
    /// the same one Call makes from Team; anything else goes to the app that
    /// owns it (Zoom, Teams) through its own link.
    private func joinUpcomingEvent(_ event: CalendarEventSummary) {
        guard event.isVideoMeeting else { return }
        if event.hasMeetRoom, let mine = permanentRoom, event.roomSlug != mine.rawValue {
            let owner = try? ownerSessionStore.load()
            callRoom(slug: event.roomSlug, name: owner?.owner.name ?? "", email: owner?.owner.email ?? "")
            return
        }
        guard event.hasMeetRoom else {
            hostUpcomingEvent(event)
            return
        }
        guard currentRole == .host, meetingSession.phase.isIdle, guestAdmissionTask == nil else { return }
        hostUpcomingEvent(event)
        toggleMeeting(nil)
    }

    /// Point the host form at the event's room without starting it. What
    /// "Use room" did on its own; now the first half of `joinUpcomingEvent`.
    private func hostUpcomingEvent(_ event: CalendarEventSummary) {
        guard currentRole == .host, event.isVideoMeeting else { return }
        if event.hasMeetRoom {
            roomField.stringValue = event.roomSlug
            setDisplayedRoomSlug(event.roomSlug)
            let invite = event.conferenceUrl.isEmpty ? event.joinUrl : event.conferenceUrl
            roomLinkRow.setInviteURL(invite)
            syncOwnerLaunchInvite()
            phaseLabel.stringValue = event.title
            // An event filed under a project or lead files the room started
            // from it: the same hand-off "Meet about this" makes from Work.
            pendingFiling = event.subject
            pendingInviteeNames = event.attendees.map(\.name).filter { !$0.isEmpty }
            return
        }
        let target = event.launchURL
        if let url = URL(string: target), !target.isEmpty {
            NSWorkspace.shared.open(url)
            return
        }
        present(StarlingsError(code: "calendar.no_join_link", title: String(localized: "This event has no join link"), message: String(localized: "Open it in Google Calendar and paste a Starlings URL into the event."), severity: .notice))
    }

    private func toggleUpcomingDemoted(_ event: CalendarEventSummary) {
        let demoted = !event.demoted
        // The row is the thing the owner just acted on. Update the local feed
        // before the preferences round trip so Home/NEXT does not keep drawing
        // the old focus while the Worker answers.
        setUpcomingDemotionLocally(eventID: event.id, demoted: demoted)
        Task { @MainActor in
            do {
                let preferences = try await controlAPI.calendarPreferences()
                var keys = Set(preferences.demotedEventKeys)
                let key = CalendarKeys.eventDemotion(isSubscription: event.calendarId.hasPrefix("sub:"), eventID: event.id)
                if demoted { keys.insert(key) } else { keys.remove(key) }
                _ = try await controlAPI.setDemotedEventKeys(keys.sorted())
                await refreshUpcomingMeetings()
                // A just-written KV preference can briefly lag the calendar
                // projection. Keep the action that is already visible locally
                // while that read catches up.
                setUpcomingDemotionLocally(eventID: event.id, demoted: demoted)
            } catch {
                setUpcomingDemotionLocally(eventID: event.id, demoted: event.demoted)
                ownerLaunchView.setStatus(
                    "Couldn’t change this meeting’s Next status.",
                    tone: .danger,
                    detail: (error as? StarlingsError)?.logLine ?? error.localizedDescription
                )
            }
        }
    }

    private func setUpcomingDemotionLocally(eventID: String, demoted: Bool) {
        var events = latestCalendarEvents
        var changed = false
        for index in events.indices where events[index].id == eventID {
            guard events[index].demoted != demoted else { continue }
            events[index] = events[index].withDemoted(demoted)
            changed = true
        }
        guard changed else { return }
        applyCalendarEvents(events)
    }

    func hostUpcomingEventFromMenubar(eventID: String) {
        guard let event = latestUpcomingPlan.agenda.first(where: { $0.id == eventID }) else { return }
        joinUpcomingEvent(event)
    }

    private func loadPermanentRoom() async {
        guard hostRoomOverride == nil else { return }
        do {
            let response = try await controlAPI.ownerRoom()
            permanentRoom = RoomSlug(rawValue: response.room.slug)
            roomField.stringValue = response.room.slug
            setDisplayedRoomSlug(response.room.slug)
            ownerLaunchView.setRoomMapped(true)
        } catch {
            // Unmapped is a state, not a fault: swap Start for the next step,
            // and drop the placeholder slug so the lobby watch does not poll a
            // room that belongs to somebody else. Anything else is left for
            // Start to surface as an actionable auth or network error.
            if let failure = error as? StarlingsError, failure.code == "room.unmapped" {
                permanentRoom = nil
                roomField.stringValue = ""
                ownerLaunchView.setRoomMapped(false, email: emailField.stringValue)
            }
        }
    }

    /// Team's shared room is a one-meeting destination. Once that meeting has
    /// ended, Home must show this account's own room again instead of leaving
    /// the internal slug in the host form and room link.
    private func restorePersonalHostRoomIfNeeded() {
        guard hostRoomOverride != nil else { return }
        hostRoomOverride = nil
        if let personalRoom = permanentRoom {
            roomField.stringValue = personalRoom.rawValue
            setDisplayedRoom(personalRoom)
            ownerLaunchView.setRoomMapped(true)
        } else {
            roomField.stringValue = ""
            Task { await loadPermanentRoom() }
        }
    }

    /// Retries the outbox when the network returns and when the Mac wakes
    ///. Before this, a meeting that ended offline stayed unfiled
    /// until relaunch or the next hosted meeting, and a Mac runs for days.
    private func watchConnectivityForPendingArtifacts() {
        guard connectivityRecovery == nil else { return }
        let recovery = ConnectivityRecovery { [weak self] in
            Task { await self?.retryPendingArtifacts() }
        }
        recovery.start()
        connectivityRecovery = recovery
    }

    private func retryPendingArtifacts() async {
        let pending = await artifactOutbox.retryPending()
        if pending > 0 {
            setTranscriptionNotice(String(localized: "\(pending) UPLOAD PENDING"))
        }
    }

    private func finalizeCurrentMeetingIfNeeded() {
        guard let context = meetingContext else { return }
        Task { await requestFinalization(context: context) }
    }

    private func requestFinalization(context: MeetingContext) async {
        guard context.role == .host else { return }
        guard finalizedMeetingIDs.insert(context.meetingID).inserted else { return }
        // Close the SFU before draining the transcript outbox so web guests are
        // not left in a hostless room while segments upload. /finalize later is
        // idempotent with this and still sends the artifact email.
        try? await controlAPI.endMeeting(context: context)
        let delivery = await artifactOutbox.requestFinalization(
            room: context.room.rawValue,
            meetingID: context.meetingID
        )
        if !delivery.finalized {
            setTranscriptionNotice(String(localized: "SAVED — UPLOAD PENDING"))
        }
    }

    private func decideLobbyGuest(requestID: String, admit: Bool, onBehalfOf: String? = nil) {
        // `watchedRoom`, not the room field: a decision reached from a
        // notification while this Mac is off in somebody else's room would
        // otherwise be sent to *their* door.
        guard let room = watchedRoom else { return }
        guard !lobbyDecisionInFlight.contains(requestID) else { return }
        let sender = onBehalfOf ?? pendingRecorderSenders[requestID]
        if let sender { pendingRecorderSenders[requestID] = sender }
        lobbyDecisionInFlight.insert(requestID)
        markLobbyRowBusy(requestID: requestID)
        Task {
            defer { lobbyDecisionInFlight.remove(requestID) }
            do {
                try await controlAPI.decide(room: room, requestID: requestID, admit: admit, onBehalfOf: sender)
                pendingLobbyRequests.removeAll { $0.id == requestID }
                pendingRecorderSenders.removeValue(forKey: requestID)
                renderLobbyQueue()
                await refreshLobbyOnce()
            } catch {
                renderLobbyQueue()
                await refreshLobbyOnce()
                present(StarlingsError.wrapping(error, code: "lobby.decision_failed", title: String(localized: "Couldn’t send the admission decision"), recovery: .retry))
            }
        }
    }

    /// Registration links stop admitting for the rest of the session; those
    /// guests knock like anyone else (docs/SESSIONS.md §7).
    @objc private func closeSessionDoor() {
        guard let room = watchedRoom, !sessionDoorClosing else { return }
        sessionDoorClosing = true
        sessionDoorButton.isEnabled = false
        Task {
            defer { sessionDoorClosing = false }
            do {
                let door = try await controlAPI.closeSessionDoor(room: room)
                sessionDoorOpen = door.sessionDoorOpen
                renderLobbyQueue()
            } catch {
                renderLobbyQueue()
                present(StarlingsError.wrapping(error, code: "lobby.session_door_failed", title: String(localized: "Couldn’t close the door"), recovery: .retry))
            }
        }
    }

    /// Close a lurker's connection: drops them off the waiting page and blocks
    /// their tab from re-announcing for a cooldown.
    private func removeLurker(lurkerID: String) {
        guard let room = watchedRoom else { return }
        guard !lurkerRemovalInFlight.contains(lurkerID) else { return }
        lurkerRemovalInFlight.insert(lurkerID)
        for case let row as LobbyLurkerRow in lobbyQueueStack.arrangedSubviews where row.lurkerID == lurkerID {
            row.setBusy(true)
        }
        Task {
            defer { lurkerRemovalInFlight.remove(lurkerID) }
            do {
                try await controlAPI.removeGuestPresence(room: room, presenceID: lurkerID)
                pendingLurkers.removeAll { $0.id == lurkerID }
                renderLobbyQueue()
                await refreshLobbyOnce()
            } catch {
                renderLobbyQueue()
                await refreshLobbyOnce()
                present(StarlingsError.wrapping(error, code: "lobby.remove_failed", title: String(localized: "Couldn’t remove that visitor"), recovery: .retry))
            }
        }
    }

    /// Admit or decline from outside the queue's own surface — the menu bar, or
    /// a knock notification's action button.
    ///
    /// Declining works from anywhere. Admitting needs a room that has actually
    /// been started, so from a notification it may mean Start & Admit — and if
    /// this Mac is in the middle of somebody else's call, it means nothing at
    /// all: hanging up on that person to answer the door is not a decision this
    /// button gets to make.
    func decideWaitingGuest(requestID: String, admit: Bool) {
        guard admit else {
            decideLobbyGuest(requestID: requestID, admit: false)
            return
        }
        if meetingContext?.role == .host, meetingSession.phase == .connected {
            decideLobbyGuest(requestID: requestID, admit: true)
            return
        }
        guard meetingSession.phase.isIdle, guestAdmissionTask == nil else { return }
        restoreRoleAfterCallIfNeeded()
        startAndAdmit(requestID: requestID)
    }

    func declineAllWaitingGuestsFromMenubar() {
        declineAllWaitingGuests()
    }

    /// Summarizes the room in the header with the worst quality present, so a
    /// struggling guest is visible without opening anything.
    private func updateConnectionQualityButton() {
        guard !participantQuality.isEmpty else {
            setTranscriptHeaderReadout(connectionQualityButton, visible: false)
            return
        }
        let worst = participantQuality
            .compactMap { entry in entry.quality.severity.map { ($0, entry.quality) } }
            .min { $0.0 < $1.0 }?.1 ?? .unknown
        setTranscriptHeaderReadout(connectionQualityButton, visible: true)
        connectionQualityButton.title = String(localized: "Connection")
        setReadoutIcon(
            connectionQualityButton,
            symbol: worst.tileIconSystemName,
            accessibility: worst.tileIconAccessibilityLabel,
            variableValue: worst.tileSignalValue
        )
        connectionQualityButton.contentTintColor = StarlingsColors.resolved(
            worst.isWeak ? StarlingsColors.danger : StarlingsColors.secondaryText,
            for: connectionQualityButton
        )
    }

    private func updateBandwidthButton() {
        guard let snapshot = bandwidthSnapshot else {
            setTranscriptHeaderReadout(bandwidthButton, visible: false)
            return
        }
        setTranscriptHeaderReadout(bandwidthButton, visible: true)
        bandwidthButton.title = snapshot.headerTitle
        setReadoutIcon(
            bandwidthButton,
            symbol: "arrow.down.arrow.up",
            accessibility: "Incoming and outgoing bandwidth"
        )
        bandwidthButton.contentTintColor = StarlingsColors.resolved(
            StarlingsColors.secondaryText,
            for: bandwidthButton
        )
    }

    @objc private func presentTranscriptShareMenu(_ sender: Any?) {
        transcriptShare.present(from: transcriptShareButton)
    }

    /// The share control follows the meeting: on while this Mac hosts one,
    /// gone when it ends or when it joined someone else's as a guest, whose
    /// record it cannot read yet.
    private func applyTranscriptShareVisibility() {
        guard isViewLoaded else { return }
        setTranscriptHeaderReadout(transcriptShareButton, visible: meetingContext?.role == .host)
    }

    @objc private func presentConnectionQualityMenu(_ sender: Any?) {
        let menu = NSMenu()
        menu.autoenablesItems = false

        let header = NSMenuItem(title: String(localized: "Connection quality"), action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        if participantQuality.isEmpty {
            let empty = NSMenuItem(title: String(localized: "Not in a meeting"), action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        } else {
            for entry in participantQuality {
                let item = NSMenuItem(title: entry.menuTitle, action: nil, keyEquivalent: "")
                item.isEnabled = false
                menu.addItem(item)
            }
        }

        menu.addItem(.separator())
        let note = NSMenuItem(
            title: String(localized: "Reported by the meeting server, not measured here"),
            action: nil,
            keyEquivalent: ""
        )
        note.isEnabled = false
        menu.addItem(note)

        let point = NSPoint(x: 0, y: connectionQualityButton.bounds.height + 2)
        menu.popUp(positioning: nil, at: point, in: connectionQualityButton)
    }

    @objc private func presentBandwidthMenu(_ sender: Any?) {
        let menu = NSMenu()
        menu.autoenablesItems = false

        let header = NSMenuItem(title: String(localized: "Bandwidth (this Mac)"), action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        if let snapshot = bandwidthSnapshot {
            let totals = NSMenuItem(title: snapshot.totalsMenuTitle, action: nil, keyEquivalent: "")
            totals.isEnabled = false
            menu.addItem(totals)
            menu.addItem(.separator())

            if snapshot.incomingVideo.isEmpty && snapshot.outgoingVideo.isEmpty {
                let empty = NSMenuItem(title: String(localized: "No A/V tracks yet"), action: nil, keyEquivalent: "")
                empty.isEnabled = false
                menu.addItem(empty)
            } else {
                for row in snapshot.incomingVideo {
                    let item = NSMenuItem(title: row.menuTitle, action: nil, keyEquivalent: "")
                    item.isEnabled = false
                    menu.addItem(item)
                }
                for row in snapshot.outgoingVideo {
                    let item = NSMenuItem(title: row.menuTitle, action: nil, keyEquivalent: "")
                    item.isEnabled = false
                    menu.addItem(item)
                }
            }
        } else {
            let empty = NSMenuItem(title: String(localized: "Measuring…"), action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        }

        menu.addItem(.separator())
        let copy = NSMenuItem(
            title: String(localized: "Copy debug report"),
            action: #selector(copyBandwidthDebugReport(_:)),
            keyEquivalent: ""
        )
        copy.target = self
        menu.addItem(copy)

        let note = NSMenuItem(
            title: String(localized: "Measured locally from WebRTC stats"),
            action: nil,
            keyEquivalent: ""
        )
        note.isEnabled = false
        menu.addItem(note)

        let point = NSPoint(x: 0, y: bandwidthButton.bounds.height + 2)
        menu.popUp(positioning: nil, at: point, in: bandwidthButton)
    }

    @objc private func copyBandwidthDebugReport(_ sender: Any?) {
        let sessionReport = meetingSession.buildDebugReport()
        let engine = suggestionEngine
        let note = suggestionResolutionNote
        let liveNote = suggestionLiveNote
        Task { @MainActor [weak self] in
            // The engine is an actor; its tally is read here, not on the
            // session, so the report builder stays synchronous.
            let engineReport = await engine?.report
            let suggestions = TaskSuggestionDebugReport.lines(
                status: TaskSuggestionEngineFactory.status(),
                resolutionNote: note,
                liveNote: liveNote,
                report: engineReport
            )
            let report = sessionReport + "\n\n" + suggestions.joined(separator: "\n")
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(report, forType: .string)
            guard let self else { return }
            self.bandwidthButton.title = String(localized: "Copied")
            try? await Task.sleep(for: .seconds(1.5))
            self.updateBandwidthButton()
        }
    }

    private func startQualityReporting() {
        stopQualityReporting()
        qualityReportTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(StarlingsPollingCadence.qualityReport))
                if Task.isCancelled { return }
                await self?.flushQualityReport()
            }
        }
        downstreamUsageReportTask = Task { [weak self] in
            await self?.flushDownstreamUsageReport()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(StarlingsPollingCadence.downstreamUsageReport))
                if Task.isCancelled { return }
                await self?.flushDownstreamUsageReport()
            }
        }
    }

    private func stopQualityReporting() {
        qualityReportTask?.cancel()
        qualityReportTask = nil
        downstreamUsageReportTask?.cancel()
        downstreamUsageReportTask = nil
    }

    /// Counters are cumulative, so a dropped flush costs nothing and the next
    /// one carries the full picture. Never surfaced as an error to the user.
    private func flushQualityReport() async {
        guard let context = meetingContext,
              let report = meetingSession.qualityReport() else { return }
        try? await controlAPI.reportQuality(context: context, report: report)
        await flushDownstreamUsageReport()
    }

    private func flushDownstreamUsageReport() async {
        guard let context = meetingContext,
              let report = meetingSession.downstreamUsageReport() else { return }
        try? await controlAPI.reportDownstreamUsage(context: context, report: report)
    }

    @objc func toggleBackgroundBlur(_ sender: Any?) {
        let next: MeetingBackgroundEffect = {
            if case .blur = backgroundEffect { return .none }
            return .blur
        }()
        applyBackgroundEffect(next)
    }

    @objc func toggleBackgroundBlock(_ sender: Any?) {
        let next: MeetingBackgroundEffect = {
            switch backgroundEffect {
            case .generated(let choice):
                return choice.next.map { MeetingBackgroundEffect.generated($0) } ?? MeetingBackgroundEffect.none
            default:
                return .generated(.first)
            }
        }()
        applyBackgroundEffect(next)
    }

    private func applyBackgroundEffect(_ effect: MeetingBackgroundEffect) {
        guard isCameraEnabled else {
            present(StarlingsError(code: "media.camera_off", title: String(localized: "Camera is off"), message: String(localized: "Turn the camera on before changing the background."), severity: .notice))
            return
        }
        backgroundEffect = effect.resolved
        WorkspaceBackgrounds.remember(effect)
        applyBackgroundEffectAppearance()
        meetingStage.setPrejoinBackgroundEffect(effect)

        guard meetingSession.phase == .connected else { return }
        backgroundButton.isEnabled = false
        Task {
            defer { updateBackgroundButtonsEnabled() }
            do {
                try await meetingSession.setBackgroundEffect(effect)
            } catch {
                present(StarlingsError.liveKit(error, stage: .backgroundEffect))
            }
        }
    }

    /// One control, and its title says which of the four states the camera is
    /// in. Lit whenever the background is not the room you are actually in.
    private func applyBackgroundEffectAppearance() {
        switch backgroundEffect {
        case .blur:
            backgroundButton.title = String(localized: "Blur")
            backgroundButton.state = .on
            setMeetingControlImage(
                backgroundButton,
                symbol: "person.and.background.dotted",
                accessibility: "Background blurred"
            )
        case .generated(let choice):
            backgroundButton.title = choice.displayName
            backgroundButton.state = .on
            setMeetingControlImage(
                backgroundButton,
                symbol: "rectangle.fill",
                accessibility: "\(choice.displayName) background"
            )
        case .workspaceImage:
            backgroundButton.title = String(localized: "Workspace picture")
            backgroundButton.state = .on
            setMeetingControlImage(backgroundButton, symbol: "photo.fill", accessibility: String(localized: "Workspace picture"))
        case .customImage:
            backgroundButton.title = String(localized: "Image")
            backgroundButton.state = .on
            setMeetingControlImage(
                backgroundButton,
                symbol: "photo.fill",
                accessibility: "Your own background image"
            )
        case .none:
            backgroundButton.title = String(localized: "Background")
            backgroundButton.state = .off
            setMeetingControlImage(
                backgroundButton,
                symbol: "person.fill",
                accessibility: "No background effect"
            )
        }
        applyControlStateTint(backgroundButton, lit: backgroundButton.state == .on)
    }

    /// Blur, the gallery grouped by generator, and off, with a
    /// mark against the one that is on. Cycling by repeated clicks was fine with
    /// two buttons on the row; it is not a way to find Ice.
    @objc private func presentBackgroundMenu(_ sender: Any?) {
        guard backgroundButton.isEnabled else { return }
        let menu = NSMenu()
        menu.autoenablesItems = false

        let off = NSMenuItem(title: String(localized: "No background"), action: #selector(chooseBackground(_:)), keyEquivalent: "")
        off.target = self
        off.representedObject = ""
        off.state = backgroundEffect == .none ? .on : .off
        menu.addItem(off)

        let blur = NSMenuItem(title: String(localized: "Blur"), action: #selector(chooseBackground(_:)), keyEquivalent: "")
        blur.target = self
        blur.representedObject = "blur"
        blur.state = backgroundEffect == .blur ? .on : .off
        menu.addItem(blur)

        menu.addItem(.separator())
        for generator in BackgroundGenerator.allCases {
            let group = NSMenuItem(title: generator.label, action: nil, keyEquivalent: "")
            let choices = NSMenu()
            choices.autoenablesItems = false
            for choice in BackgroundChoice.all where choice.generator == generator {
                let item = NSMenuItem(title: choice.displayName, action: #selector(chooseBackground(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = choice
                item.state = backgroundEffect == .generated(choice) ? .on : .off
                choices.addItem(item)
            }
            group.submenu = choices
            menu.addItem(group)
        }

        menu.addItem(.separator())
        // Choosing a picture and turning it on are one action: nobody opens a
        // file chooser in order to look at a menu item afterwards. Once there is
        // one, the item toggles it and "Choose Image…" sits below to replace it.
        if WorkspaceBackgrounds.hasPicture {
            let item = NSMenuItem(title: String(localized: "Workspace picture"), action: #selector(chooseBackground(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = "workspace-image"
            item.state = backgroundEffect == .workspaceImage ? .on : .off
            menu.addItem(item)
        }
        if CustomBackgroundStore.hasImage {
            let image = NSMenuItem(
                title: String(localized: "My image"),
                action: #selector(chooseBackground(_:)),
                keyEquivalent: ""
            )
            image.target = self
            image.representedObject = "image"
            image.state = backgroundEffect == .customImage ? .on : .off
            menu.addItem(image)
        }
        let pick = NSMenuItem(
            title: CustomBackgroundStore.hasImage ? String(localized: "Replace Image…") : String(localized: "Choose Image…"),
            action: #selector(pickBackgroundImage(_:)),
            keyEquivalent: ""
        )
        pick.target = self
        menu.addItem(pick)
        if CustomBackgroundStore.hasImage {
            let remove = NSMenuItem(
                title: String(localized: "Remove Image"),
                action: #selector(removeBackgroundImage(_:)),
                keyEquivalent: ""
            )
            remove.target = self
            menu.addItem(remove)
        }

        menu.addItem(.separator())
        let effects = NSMenuItem(
            title: String(localized: "Video Effects…"),
            action: #selector(openSystemVideoEffects(_:)),
            keyEquivalent: ""
        )
        effects.target = self
        menu.addItem(effects)

        let point = NSPoint(x: 0, y: backgroundButton.bounds.height + 2)
        menu.popUp(positioning: nil, at: point, in: backgroundButton)
    }

    @objc private func chooseBackground(_ sender: NSMenuItem) {
        if let choice = sender.representedObject as? BackgroundChoice {
            applyBackgroundEffect(.generated(choice))
            return
        }
        guard let raw = sender.representedObject as? String else { return }
        if raw.isEmpty {
            applyBackgroundEffect(.none)
        } else if raw == "blur" {
            applyBackgroundEffect(.blur)
        } else if raw == "workspace-image" {
            applyBackgroundEffect(.workspaceImage)
        } else if raw == "image" {
            // `resolved` rather than the raw case: a picture removed in another
            // window would otherwise leave the camera plain with the menu
            // ticked. It cannot show an effect that will not appear.
            applyBackgroundEffect(MeetingBackgroundEffect.customImage.resolved)
        } else if let choice = BackgroundChoice(plate: raw) {
            applyBackgroundEffect(.generated(choice))
        }
    }

    /// Pick a picture off disk, keep it, and put it up.
    ///
    /// The file never leaves this Mac — `CustomBackgroundStore` says why — and
    /// it is scaled and re-encoded on the way in, so what is stored is pixels
    /// this Mac drew rather than the original with its metadata attached.
    @objc private func pickBackgroundImage(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = CustomBackgroundStore.allowedTypes
        panel.prompt = String(localized: "Use as Background")
        panel.message = "Pick a picture to sit behind you. It stays on this Mac."
        panel.begin { [weak self] response in
            guard let self, response == .OK, let url = panel.url else { return }
            do {
                try CustomBackgroundStore.save(contentsOf: url)
                applyBackgroundEffect(.customImage)
            } catch {
                present(StarlingsError.wrapping(
                    error,
                    code: "background.image_failed",
                    title: String(localized: "Couldn’t use that image"),
                    recovery: .retry
                ))
            }
        }
    }

    @objc private func removeBackgroundImage(_ sender: Any?) {
        CustomBackgroundStore.clear()
        // Taking the picture away takes the effect with it, rather than leaving
        // a background that silently is not there any more.
        if backgroundEffect == .customImage { applyBackgroundEffect(.none) }
    }

    /// The one menu for self-view state. Placement is deliberately reduced to
    /// the common corner action; dragging the inset remains available for the
    /// occasional need to get it out of a particular shared-screen area.
    @objc private func presentSelfViewMenu(_ sender: Any?) {
        guard meetingSession.phase == .connected else { return }
        let menu = NSMenu()
        menu.autoenablesItems = false

        let hidden = meetingStage.hidesLocalTile
        let hide = NSMenuItem(
            title: hidden ? String(localized: "Show me") : String(localized: "Hide me"),
            action: #selector(toggleHideSelf(_:)),
            keyEquivalent: ""
        )
        hide.target = self
        hide.state = hidden ? .on : .off
        menu.addItem(hide)

        let floating = selfViewPiP.isVisible || meetingStage.suppressesLocalTileForPiP
        let float = NSMenuItem(
            title: floating ? String(localized: "Dock me") : String(localized: "Float me"),
            action: #selector(toggleFloatSelf(_:)),
            keyEquivalent: ""
        )
        float.target = self
        float.state = floating ? .on : .off
        menu.addItem(float)

        let corner = NSMenuItem(
            title: String(localized: "Put me in the corner"),
            action: #selector(moveSelfViewToCorner(_:)),
            keyEquivalent: ""
        )
        corner.target = self
        corner.isEnabled = !hidden && !floating
        menu.addItem(corner)

        menu.addItem(makeSelfViewSizeItem(enabled: !hidden && !floating))

        let point = NSPoint(x: 0, y: selfViewButton.bounds.height + 2)
        menu.popUp(positioning: nil, at: point, in: selfViewButton)
    }

    /// Shows or hides the caption list under the stage. Display only:
    /// transcription keeps running, and segments keep finalizing and uploading,
    /// whether or not anyone is looking at them.
    @objc func toggleTranscriptPanel(_ sender: Any?) {
        focusRestore = nil
        TranscriptPanelPreferences.isExpanded.toggle()
        applyTranscriptPanelVisibility()
        applyFocusChrome()
    }

    /// Focus is the only thing that takes the window's chrome, and moving
    /// either half of it by hand ends Focus — so this reads `focusRestore`
    /// rather than tracking a flag of its own, and every path that clears it
    /// hands the titlebar back without having to remember to.
    private func applyFocusChrome() {
        let immersive = meetingSession.phase == .connected && focusRestore != nil
        onImmersiveChange?(immersive)
        bodyTopAtSafeArea.isActive = !immersive
        bodyTopAtEdge.isActive = immersive
    }

    private func applyTranscriptPanelVisibility() {
        let expanded = TranscriptPanelPreferences.isExpanded
        transcriptScroll.isHidden = !expanded
        transcriptDisclosure.title = String(localized: "Live transcript")
        let symbol = expanded ? "chevron.down" : "chevron.right"
        transcriptDisclosure.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 10, weight: .semibold))
        transcriptDisclosure.setAccessibilityExpanded(expanded)
    }

    /// Takes your own tile off your own stage. Nothing is unpublished — the
    /// people you are talking to still see you; you just stop watching
    /// yourself.
    @objc func toggleHideSelf(_ sender: Any?) {
        if meetingStage.hidesLocalTile {
            meetingStage.setLocalTileHidden(false)
            applyHideSelfAppearance()
        } else {
            hideSelfViewFromAnySurface()
        }
    }

    /// Gives the stage the whole window, or gives the rail back. Live meetings
    /// only: idle, the rail carries Host/Join, the room field, and Start, so
    /// there would be nothing left to work with.
    @objc func toggleMeetingPanel(_ sender: Any?) {
        guard meetingSession.phase == .connected else { return }
        // Moving half of Focus by hand ends it: there is nothing coherent left
        // to restore.
        focusRestore = nil
        MeetingPanelPreferences.isCollapsed.toggle()
        applyMeetingPanelVisibility(animated: true)
    }

    /// Meet's rail *is* this window's inspector column, so it answers the same
    /// ⌃⌘I as Calendar's and Work's inspectors, and the same toolbar button —
    /// `.toggleInspector` in `RoomWindowController.toolbarDefaultItemIdentifiers`.
    /// `StarlingsRoomShellViewController` forwards its own `toggleInspector` here
    /// rather than letting `NSSplitViewController` flip the column, so the
    /// preference and the column never disagree. `toggleMeetingPanel` stays
    /// what ⌥⌘S calls, and the guard inside it is why the key does nothing
    /// idle: with no meeting, the rail is the screen.
    @objc func toggleInspector(_ sender: Any?) {
        toggleMeetingPanel(sender)
    }

    /// Puts the rail and the control row's End button in agreement, and asks
    /// the window's toolbar to re-validate so its inspector button's enabled
    /// state catches up without waiting for AppKit's own idle pass. Called on
    /// every phase change as well as on the toggle, so a meeting that ends
    /// always hands the rail back.
    ///
    /// The rail is the shell's inspector column. It is away for two reasons
    /// that never meet: the signed-in host is idle and the launch card is the
    /// window, or the meeting is live and the panel was put away. Idle for a
    /// guest, the rail *is* the screen — Host/Join, the room field, and the
    /// button that starts anything — so it stands.
    private func applyMeetingPanelVisibility(animated: Bool = false) {
        let live = meetingSession.phase == .connected
        let collapsed = live && MeetingPanelPreferences.isCollapsed
        let visible = !collapsed && !showsOwnerLaunch(for: meetingSession.phase)
        view.window?.toolbar?.validateVisibleItems()
        applyFocusChrome()
        // End lives in the rail. While the rail is away it joins the control
        // row, because a meeting you cannot leave without the menu bar is not a
        // meeting you can leave.
        applyEndMeetingButtonAppearance()
        endMeetingButton.isHidden = !collapsed
        endMeetingButton.isEnabled = collapsed
        stageTrailingToRail?.constant = visible ? -StarlingsShellViewController.Column.contentGutter : 0
        if let shell = parent as? StarlingsShellViewController, shell.isInspectorVisible != visible {
            // The column opens into the window and closes out of it; the
            // window keeps its frame either way (`StarlingsShellViewController`).
            shell.setInspector(visible: visible, animated: animated)
            // The rail leaving or arriving changes what this window needs.
            StarlingsWindowMetrics.refresh(view.window)
        }
        applyControlBarDensity()
    }

    /// The shell calls this once the rail is standing in its column, so the
    /// visibility `render(phase:)` decided before this controller had a
    /// parent is applied to a column that now exists.
    func syncMeetingPanelVisibility() {
        applyMeetingPanelVisibility()
    }

    /// Stage only: the rail closed and the transcript collapsed in one press,
    /// and both back exactly as they were on the next one. Two shortcuts for
    /// what is really one intention — "just the meeting".
    @objc func toggleFocusMode(_ sender: Any?) {
        guard meetingSession.phase == .connected else { return }
        if let restore = focusRestore {
            MeetingPanelPreferences.isCollapsed = restore.panelCollapsed
            TranscriptPanelPreferences.isExpanded = restore.transcriptExpanded
            focusRestore = nil
        } else {
            focusRestore = (
                panelCollapsed: MeetingPanelPreferences.isCollapsed,
                transcriptExpanded: TranscriptPanelPreferences.isExpanded
            )
            MeetingPanelPreferences.isCollapsed = true
            TranscriptPanelPreferences.isExpanded = false
        }
        applyTranscriptPanelVisibility()
        applyMeetingPanelVisibility(animated: true)
    }

    /// The one-click placement offered by the self-view itself and its menu.
    /// Dragging still snaps to the same six stable positions, but the menu does
    /// not make people choose between six nearly identical labels.
    @objc private func moveSelfViewToCorner(_ sender: Any?) {
        meetingStage.setSelfPlacement(.bottomLeft)
    }

    /// "Size" with the three steps under it, the current one checked. One
    /// builder for both self-view menus so they cannot drift apart.
    private func makeSelfViewSizeItem(enabled: Bool) -> NSMenuItem {
        let item = NSMenuItem(title: String(localized: "Size"), action: nil, keyEquivalent: "")
        item.isEnabled = enabled
        let submenu = NSMenu()
        submenu.autoenablesItems = false
        for size in SelfViewSize.allCases {
            let step = NSMenuItem(
                title: size.title,
                action: #selector(setSelfViewSize(_:)),
                keyEquivalent: ""
            )
            step.target = self
            step.representedObject = size.rawValue
            step.state = size == meetingStage.selfSize ? .on : .off
            step.isEnabled = enabled
            submenu.addItem(step)
        }
        item.submenu = submenu
        return item
    }

    @objc private func setSelfViewSize(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let size = SelfViewSize(rawValue: raw) else { return }
        meetingStage.setSelfSize(size)
    }

    /// Parks self-view in a floating always-on-top panel (typically near the
    /// webcam) and pulls it off the in-window stage while it is open.
    @objc func toggleFloatSelf(_ sender: Any?) {
        if selfViewPiP.isVisible {
            closeSelfViewPiP(userInitiated: true)
        } else {
            openSelfViewPiP()
        }
    }

    private func openSelfViewPiP() {
        // Stage, floating, and hidden are mutually exclusive presentations of
        // the same private preview. Choosing Float is an explicit way to show
        // it again after it was hidden.
        meetingStage.setLocalTileHidden(false)
        selfViewPiP.setDisplayName(nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines))
        selfViewPiP.setTrack(localVideoTrack)
        selfViewPiP.show(relativeTo: view.window)
        meetingStage.setLocalTileSuppressedForPiP(true)
        applyFloatSelfAppearance()
    }

    private func closeSelfViewPiP(userInitiated _: Bool) {
        if selfViewPiP.isVisible {
            selfViewPiP.hide()
        }
        meetingStage.setLocalTileSuppressedForPiP(false)
        meetingStage.setLocalTileHidden(false)
        applyFloatSelfAppearance()
    }

    /// Hides the local preview regardless of whether it is on the stage or in
    /// the floating panel. Publishing is untouched; this is only what this Mac
    /// chooses to watch.
    private func hideSelfViewFromAnySurface() {
        if selfViewPiP.isVisible {
            selfViewPiP.hide()
        }
        meetingStage.setLocalTileSuppressedForPiP(false)
        meetingStage.setLocalTileHidden(true)
        applyHideSelfAppearance()
    }

    /// Returns the preview to the stage at the one common corner position.
    private func dockSelfViewToCorner() {
        if selfViewPiP.isVisible {
            selfViewPiP.hide()
        }
        meetingStage.setLocalTileHidden(false)
        meetingStage.setLocalTileSuppressedForPiP(false)
        meetingStage.setSelfPlacement(.bottomLeft)
        applySelfViewAppearance()
    }

    /// Only offered in a live call: outside one the stage is the prejoin
    /// camera, which is the entire point of that screen. Leaving a meeting also
    /// clears the preference so the next call starts with you on screen.
    private func updateHideSelfControl(phase: MeetingPhase) {
        let live = phase == .connected
        selfViewButton.isHidden = !live
        selfViewButton.isEnabled = live
        if !live {
            if meetingStage.hidesLocalTile {
                meetingStage.setLocalTileHidden(false)
            }
            closeSelfViewPiP(userInitiated: false)
        }
        applyHideSelfAppearance()
        applyFloatSelfAppearance()
    }

    private func applyHideSelfAppearance() {
        applySelfViewAppearance()
    }

    private func applyFloatSelfAppearance() {
        applySelfViewAppearance()
    }

    /// One button for three states of your own picture: on the stage, off it,
    /// or floating in its own window. The title is whichever is true.
    private func applySelfViewAppearance() {
        let hidden = meetingStage.hidesLocalTile
        let floating = selfViewPiP.isVisible || meetingStage.suppressesLocalTileForPiP
        selfViewButton.state = hidden || floating ? .on : .off
        if hidden {
            selfViewButton.title = String(localized: "Hidden")
            setMeetingControlImage(
                selfViewButton,
                symbol: "eye.slash",
                accessibility: "You are hidden from your own stage"
            )
        } else if floating {
            selfViewButton.title = String(localized: "Floating")
            setMeetingControlImage(
                selfViewButton,
                symbol: "pip.exit",
                accessibility: "Your camera is floating in its own window"
            )
        } else {
            selfViewButton.title = String(localized: "You")
            setMeetingControlImage(
                selfViewButton,
                symbol: "person.crop.square",
                accessibility: "Your own picture"
            )
        }
        applyControlStateTint(selfViewButton, lit: selfViewButton.state == .on)
    }

    private func updateBackgroundButtonsEnabled() {
        let enabled = isCameraEnabled && (
            meetingSession.phase == .setup
                || meetingSession.phase == .connected
                || meetingSession.phase == .ended
                || isFailedPhase
        )
        backgroundButton.isEnabled = enabled
    }

    @objc func openSystemVideoEffects(_ sender: Any?) {
        SystemVideoEffects.showVideoEffectsUI()
    }

    @objc func openSystemMicrophoneModes(_ sender: Any?) {
        MicrophoneModes.showSystemPicker()
    }

    @objc func toggleCenterStage(_ sender: Any?) {
        let next: Bool
        if let item = sender as? NSMenuItem {
            next = item.state != .on
        } else {
            next = !videoEffectsSnapshot.centerStageEnabled
        }
        _ = SystemVideoEffects.setCenterStageEnabled(next)
        videoEffectsMonitor.refresh()
    }

    @objc func shareScreen(_ sender: Any?) {
        guard meetingSession.phase == .connected else { return }
        if isScreenShareEnabled {
            Task { await stopScreenSharing() }
            return
        }
        guard ScreenCaptureAccess.ensurePermission() else {
            present(.screenCapturePermissionDenied())
            return
        }
        Task { await presentScreenSharePicker() }
    }

    /// A sheet of thumbnails rather than a menu of window titles: you can see
    /// what you are about to show the room before anyone else does.
    private func presentScreenSharePicker() async {
        do {
            let displays = try await MacOSScreenCapturer.displaySources()
            let windows = try await MacOSScreenCapturer.windowSources()
            let picker = ScreenSharePickerViewController(displays: displays, windows: windows)
            picker.onPick = { [weak self, weak picker] source in
                guard let self, let picker else { return }
                picker.closeSheetWindow()
                startScreenShare(source: source)
            }
            picker.onCancel = { [weak picker] in
                picker?.closeSheetWindow()
            }
            presentInSheetWindow(picker)
        } catch {
            present(screenShareError(error))
        }
    }

    private func startScreenShare(source: MacOSScreenCaptureSource) {
        Task {
            do {
                try await meetingSession.setScreenShare(source: source)
                applyScreenShareUI(enabled: true, source: source)
            } catch {
                guard meetingSession.phase == .connected else { return }
                present(screenShareError(error))
            }
        }
    }

    private func screenShareError(_ error: Error) -> StarlingsError {
        guard ScreenCaptureAccess.isGranted else {
            return .screenCapturePermissionDenied(diagnostic: error.localizedDescription)
        }
        return StarlingsError.liveKit(error, stage: .screenShare)
    }

    private func stopScreenSharing() async {
        do {
            try await meetingSession.setScreenShare(enabled: false)
            applyScreenShareUI(enabled: false)
        } catch {
            present(StarlingsError.liveKit(error, stage: .screenShare))
        }
    }

    /// One funnel for every way a share starts or stops — the picker, the CLI,
    /// and the host stopping it remotely — so the on-screen border can never
    /// outlive the share it frames.
    private func applyScreenShareUI(enabled: Bool, source: MacOSScreenCaptureSource? = nil) {
        isScreenShareEnabled = enabled
        updateScreenShareLayoutButton()
        screenShareButton.title = enabled ? String(localized: "Stop sharing") : String(localized: "Share screen")
        setMeetingControlImage(
            screenShareButton,
            symbol: enabled ? "rectangle.on.rectangle.slash" : "rectangle.on.rectangle",
            accessibility: screenShareButton.title
        )
        if enabled {
            screenShareBorder.show(for: source)
        } else {
            screenShareBorder.hide()
        }
    }

    private func updateScreenShareLayoutButton() {
        let hasShare = meetingSession.phase == .connected
            && (isScreenShareEnabled || remoteVideoSnapshot.contains(where: \.isScreenShare))
        screenShareLayoutButton.isHidden = !hasShare
        screenShareLayoutButton.isEnabled = hasShare
    }

    @objc private func presentScreenShareLayoutMenu(_ sender: Any?) {
        guard meetingSession.phase == .connected,
              isScreenShareEnabled || remoteVideoSnapshot.contains(where: \.isScreenShare) else { return }
        let menu = NSMenu()
        menu.autoenablesItems = false
        for choice in StageGridLayout.ScreenShareLayoutChoice.allCases {
            let item = NSMenuItem(title: choice.title, action: #selector(changeScreenShareLayout(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = choice.rawValue
            item.state = StageGridLayout.ScreenShareLayoutPreferences.choice == choice ? .on : .off
            menu.addItem(item)
        }
        let point = NSPoint(x: 0, y: screenShareLayoutButton.bounds.height + 2)
        menu.popUp(positioning: nil, at: point, in: screenShareLayoutButton)
    }

    @objc private func changeScreenShareLayout(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let choice = StageGridLayout.ScreenShareLayoutChoice(rawValue: raw) else { return }
        meetingStage.setScreenShareLayoutChoice(choice)
    }

    /// Host stopping somebody else's share.
    ///
    /// Deliberately not confirmed: a share that should not be up is usually a
    /// wrong window or a private message on screen, and a confirmation sheet
    /// keeps it in front of the room for as long as it takes to read one. It is
    /// also cheap to undo — the person may share again straight away.
    private func stopRemoteScreenShare(identity: String) {
        guard let context = meetingContext, context.role == .host else { return }
        Task {
            do {
                try await controlAPI.stopScreenShare(context: context, identity: identity)
            } catch {
                present(StarlingsError.wrapping(
                    error,
                    code: "media.stop_share_failed",
                    title: String(localized: "Couldn’t stop that screen share"),
                    recovery: .retry
                ))
            }
        }
    }


    @objc func toggleMicrophone(_ sender: Any?) {
        if meetingSession.phase == .setup || meetingSession.phase == .ended || isFailedPhase {
            isMicrophoneEnabled.toggle()
            applyMicrophoneControlAppearance()
            return
        }
        guard meetingSession.phase == .connected,
              meetingContext?.role != .host || meetingHoldsHost else { return }
        let enabled = !isMicrophoneEnabled
        Task {
            do {
                try await meetingSession.setMicrophone(enabled: enabled)
                isMicrophoneEnabled = enabled
                applyMicrophoneControlAppearance()
            } catch {
                present(StarlingsError.liveKit(error, stage: .microphone))
            }
        }
    }

    @objc func toggleCamera(_ sender: Any?) {
        if meetingSession.phase == .setup || meetingSession.phase == .ended || isFailedPhase {
            isCameraEnabled.toggle()
            applyCameraControlAppearance()
            updateBackgroundButtonsEnabled()
            refreshPrejoinCamera()
            if isCameraEnabled {
                meetingStage.setPrejoinBackgroundEffect(backgroundEffect)
            } else {
                meetingStage.setPrejoinBackgroundEffect(.none)
            }
            return
        }
        guard meetingSession.phase == .connected else { return }
        let enabled = !isCameraEnabled
        let previous = isCameraEnabled
        cameraButton.isEnabled = false
        // Switching off waits on the capture session stopping, which is slow
        // enough to look broken. Paint the control now — the tile blanks at the
        // same moment — and roll it back if LiveKit refuses.
        if !enabled {
            isCameraEnabled = false
            applyCameraControlAppearance()
            applyBackgroundEffectAppearance()
            updateBackgroundButtonsEnabled()
        }
        Task {
            defer {
                cameraButton.isEnabled = meetingSession.phase == .connected
                    || meetingSession.phase == .setup
                    || meetingSession.phase == .ended
                    || isFailedPhase
            }
            do {
                try await meetingSession.setCamera(enabled: enabled)
                isCameraEnabled = enabled
            } catch {
                isCameraEnabled = previous
                present(StarlingsError.liveKit(error, stage: .camera))
            }
            applyCameraControlAppearance()
            applyBackgroundEffectAppearance()
            updateBackgroundButtonsEnabled()
        }
    }

    private var isFailedPhase: Bool {
        if case .failed = meetingSession.phase { return true }
        return false
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        let canToggleMedia = meetingSession.phase == .connected
            || meetingSession.phase == .setup
            || meetingSession.phase == .ended
            || isFailedPhase
        let isHost = currentRole == .host
        let isHostInMeeting = meetingContext?.role == .host && meetingSession.phase == .connected && meetingHoldsHost
        let isPreliveHost = isHost && (
            meetingSession.phase == .setup || meetingSession.phase == .ended || isFailedPhase
        )
        let hasWaitingGuest = !pendingLobbyRequests.isEmpty
        let signedIn = (try? ownerSessionStore.load()) != nil
        switch menuItem.action {
        case #selector(toggleMicrophone(_:)):
            menuItem.title = isMicrophoneEnabled ? String(localized: "Mute") : String(localized: "Unmute")
            return canToggleMedia && (meetingSession.phase != .connected || meetingContext?.role != .host || meetingHoldsHost)
        case #selector(toggleCamera(_:)):
            menuItem.title = isCameraEnabled ? String(localized: "Stop Video") : String(localized: "Start Video")
            return canToggleMedia
        case #selector(toggleBackgroundBlur(_:)):
            menuItem.title = {
                if case .blur = backgroundEffect { return "Turn Off Background Blur" }
                return String(localized: "Blur Background")
            }()
            return isCameraEnabled
        case #selector(toggleBackgroundBlock(_:)):
            menuItem.title = {
                switch backgroundEffect {
                case .generated(let choice):
                    if let following = choice.next {
                        return String(localized: "Next Background (\(following.displayName))")
                    }
                    return String(localized: "Turn Off Background Block")
                default:
                    return String(localized: "Block Background (\(BackgroundChoice.first.displayName))")
                }
            }()
            return isCameraEnabled
        case #selector(shareScreen(_:)):
            menuItem.title = isScreenShareEnabled ? String(localized: "Stop Sharing Screen") : String(localized: "Share Screen…")
            return meetingSession.phase == .connected
        case #selector(muteEveryoneElse(_:)):
            // Host-only, and pointless in an empty room.
            return isHostInMeeting && participantCount > 1
        case #selector(endMeetingForEveryone(_:)):
            // Only `/room/team` has a Leave that is not an End; elsewhere the
            // End is the button. Hidden rather than dimmed so a
            // personal room's menu does not grow an item that never enables.
            let shows = isInInternalRoom && meetingSession.phase == .connected && meetingHoldsHost
            menuItem.isHidden = !shows
            return shows
        case #selector(takeHost(_:)):
            let shows = currentRole == .host && meetingSession.phase == .connected && !meetingHoldsHost && !currentHostIsPhone
            menuItem.isHidden = !shows
            return shows
        case #selector(moveHost(_:)):
            let shows = currentRole == .host && meetingSession.phase == .connected && meetingHoldsHost
            menuItem.isHidden = !shows
            return shows && !hostTargets.isEmpty && !hostMutationInFlight
        case #selector(leaveMeeting(_:)):
            // The primary button already leaves for a companion and in
            // /room/team. This separate action preserves End meeting on a
            // personal room while still allowing its host to hand over.
            let shows = currentRole == .host && meetingSession.phase == .connected
                && meetingHoldsHost && hasMacOwnerCompanion && !isInInternalRoom
            menuItem.isHidden = !shows
            return shows
        case #selector(lowerAllHandsFromMenu):
            // Host-only, and dimmed when there is no queue: an enabled item
            // that would do nothing teaches people to stop reading the menu.
            menuItem.title = raisedHands.count > 1
                ? String(localized: "Lower All Hands (\(raisedHands.count))")
                : String(localized: "Lower All Hands")
            return isHostInMeeting && !raisedHands.isEmpty
        case #selector(toggleOwnHand(_:)):
            menuItem.title = ownHandRaised ? String(localized: "Lower Hand") : String(localized: "Raise Hand")
            return meetingSession.phase == .connected
        case #selector(toggleChat(_:)):
            menuItem.title = isChatVisible ? String(localized: "Hide Chat") : String(localized: "Chat")
            return meetingSession.phase == .connected
        case #selector(toggleTranscriptPanel(_:)):
            menuItem.title = TranscriptPanelPreferences.isExpanded ? String(localized: "Hide Live Transcript") : String(localized: "Live Transcript")
            // Always available: the panel is part of the window, not the call,
            // and hiding it before a meeting starts is the point.
            return true
        case #selector(toggleHideSelf(_:)):
            menuItem.title = meetingStage.hidesLocalTile ? String(localized: "Show Me") : String(localized: "Hide Me")
            return meetingSession.phase == .connected
        case #selector(toggleFloatSelf(_:)):
            menuItem.title = (selfViewPiP.isVisible || meetingStage.suppressesLocalTileForPiP)
                ? String(localized: "Dock Me")
                : "Float Me"
            return meetingSession.phase == .connected
        case #selector(toggleFocusMode(_:)):
            menuItem.state = focusRestore == nil ? .off : .on
            return meetingSession.phase == .connected
        case #selector(toggleMeetingPanel(_:)):
            menuItem.title = MeetingPanelPreferences.isCollapsed
                ? String(localized: "Show Meeting Panel")
                : "Hide Meeting Panel"
            return meetingSession.phase == .connected
        // The same rail under the name the View menu gives both other windows.
        case #selector(toggleInspector(_:)):
            menuItem.title = MeetingPanelPreferences.isCollapsed
                ? String(localized: "Show Right Sidebar")
                : "Hide Right Sidebar"
            return meetingSession.phase == .connected
        case #selector(copyInviteLink(_:)):
            return !roomLinkRow.clipboardString.isEmpty
        case #selector(presentScheduleMeeting(_:)):
            return isHost && signedIn
        case #selector(switchToJoinMode(_:)):
            return isHost && meetingSession.phase.isIdle && guestAdmissionTask == nil
        case #selector(toggleCenterStage(_:)):
            menuItem.state = videoEffectsSnapshot.centerStageEnabled ? .on : .off
            return true
        case #selector(openSystemVideoEffects(_:)), #selector(openSystemMicrophoneModes(_:)):
            return true
        case #selector(toggleMeeting(_:)):
            if guestAdmissionTask != nil {
                menuItem.title = String(localized: "Cancel Join Request")
                menuItem.keyEquivalent = "w"
                menuItem.keyEquivalentModifierMask = [.command, .shift]
                return true
            }
            switch meetingSession.phase {
            case .connected:
                menuItem.title = currentRole == .host && !isInInternalRoom && meetingHoldsHost
                    ? String(localized: "End Meeting")
                    : String(localized: "Leave Meeting")
                menuItem.keyEquivalent = "w"
                menuItem.keyEquivalentModifierMask = [.command, .shift]
                return true
            case .connecting:
                menuItem.title = currentRole == .host ? String(localized: "Start Meeting") : String(localized: "Ask to Join")
                menuItem.keyEquivalent = "\r"
                menuItem.keyEquivalentModifierMask = [.command]
                return false
            case .setup, .ended, .failed:
                if isHost && hasWaitingGuest {
                    menuItem.title = String(localized: "Start & Admit")
                } else {
                    menuItem.title = currentRole == .host ? String(localized: "Start Meeting") : String(localized: "Ask to Join")
                }
                menuItem.keyEquivalent = "\r"
                menuItem.keyEquivalentModifierMask = [.command]
                return true
            }
        case #selector(admitNextWaitingGuest(_:)):
            return isHostInMeeting && hasWaitingGuest
        case #selector(rejectNextWaitingGuest(_:)):
            return (isHostInMeeting || isPreliveHost) && hasWaitingGuest
        default:
            return true
        }
    }

    private func refreshPrejoinCamera() {
        Task {
            await WorkspaceBackgrounds.refresh()
            guard meetingSession.phase != .connected, meetingSession.phase != .connecting else { return }
            backgroundEffect = WorkspaceBackgrounds.preferredEffect
            applyBackgroundEffectAppearance()
            meetingStage.setPrejoinBackgroundEffect(backgroundEffect)
        }
        guard meetingSession.phase != .connected, meetingSession.phase != .connecting else { return }
        if isCameraEnabled, let cameraID = selectedCameraID {
            showIdleCamera(deviceID: cameraID)
        } else {
            showIdleCamera(deviceID: nil)
        }
    }

    /// Boolean controls use the accent for their active mark. The icon still
    /// changes with the state (`mic.slash.fill`, not `mic.fill`), so colour is
    /// reinforcement rather than the only state signal.
    private func applyControlStateTint(_ button: NSButton, lit: Bool) {
        button.contentTintColor = lit ? StarlingsColors.accentMark : nil
    }

    /// Replacing an NSButton image during a call can restore AppKit's default
    /// image placement. Keep the meeting row's stacked treatment explicit;
    /// otherwise a state change turns a clean icon/label cell into an image
    /// painted over its title (the failure is especially visible on Background,
    /// You, and Hand).
    private func setMeetingControlImage(
        _ button: StarlingsMeetingControlButton,
        symbol: String,
        accessibility: String
    ) {
        button.setMeetingControlImage(symbol: symbol, accessibility: accessibility)
    }

    /// Readouts are quiet text controls, so their symbols sit beside the word
    /// rather than joining the stacked command cells below the stage.
    private func setReadoutIcon(
        _ button: NSButton,
        symbol: String,
        accessibility: String,
        variableValue: Double? = nil
    ) {
        let image: NSImage?
        if let variableValue {
            image = NSImage(
                systemSymbolName: symbol,
                variableValue: variableValue,
                accessibilityDescription: accessibility
            )
        } else {
            image = NSImage(systemSymbolName: symbol, accessibilityDescription: accessibility)
        }
        button.image = image?.withSymbolConfiguration(.init(pointSize: 12, weight: .semibold))
        button.imagePosition = .imageLeading
        button.imageHugsTitle = true
    }

    private func applyMicrophoneControlAppearance() {
        muteButton.title = isMicrophoneEnabled ? String(localized: "Mute") : String(localized: "Unmute")
        muteButton.state = isMicrophoneEnabled ? .off : .on
        setMeetingControlImage(
            muteButton,
            symbol: isMicrophoneEnabled ? "mic.fill" : "mic.slash.fill",
            accessibility: muteButton.title
        )
        applyControlStateTint(muteButton, lit: !isMicrophoneEnabled)
    }

    private func applyCameraControlAppearance() {
        cameraButton.title = isCameraEnabled ? String(localized: "Camera off") : String(localized: "Camera on")
        cameraButton.state = isCameraEnabled ? .off : .on
        setMeetingControlImage(
            cameraButton,
            symbol: isCameraEnabled ? "video.fill" : "video.slash.fill",
            accessibility: cameraButton.title
        )
        applyControlStateTint(cameraButton, lit: !isCameraEnabled)
    }

    private func configurationFromForm() -> MeetingConfiguration? {
        let identity = MeetingIdentity(
            name: nameField.stringValue,
            email: emailField.stringValue
        )
        if currentRole == .host, !identity.hostIdentity.isValid {
            present(.validation(code: "form.host_identity", message: String(localized: "Add a host name and a member email address.")))
            return nil
        }
        if currentRole == .guest, !identity.isValidGuest {
            present(.validation(code: "form.guest_identity", message: String(localized: "Add your name and a valid email address.")))
            return nil
        }
        let entry = currentRole == .guest
            ? GuestRoomEntry(input: roomField.stringValue)
            : RoomSlug(rawValue: roomField.stringValue).map { GuestRoomEntry(room: $0, bookingToken: nil) }
        guard let entry else {
            present(.validation(code: "form.room_slug", message: GuestEntryWords.roomInvalid))
            return nil
        }
        guard devices.cameras.indices.contains(cameraPopup.indexOfSelectedItem),
              devices.microphones.indices.contains(microphonePopup.indexOfSelectedItem) else {
            present(StarlingsError(code: "media.devices_required", title: String(localized: "Camera and microphone needed"), message: String(localized: "A camera and microphone are required to join this meeting."), recovery: .openCameraSettings))
            return nil
        }

        return MeetingConfiguration(
            identity: identity,
            role: currentRole,
            room: entry.room,
            cameraID: devices.cameras[cameraPopup.indexOfSelectedItem].id,
            microphoneID: devices.microphones[microphonePopup.indexOfSelectedItem].id,
            speakerID: selectedSpeakerID,
            cameraEnabled: isCameraEnabled,
            microphoneEnabled: isMicrophoneEnabled,
            bookingToken: entry.bookingToken,
            isWalkUp: isOpeningForWalkUp
        )
    }

    private func render(phase: MeetingPhase) {
        // The Meet segment's live dot, read by every window's switcher —
        // see `StarlingsSurfaceActivity`.
        StarlingsSurfaceActivity.setMeetLive(!phase.isIdle)
        updateHideSelfControl(phase: phase)
        applyMeetingPanelVisibility()
        refreshStageReadout()
        refreshKnockBanner()
        sidebarErrorNotice.clear()
        switch phase {
        case .setup:
            phaseLabel.stringValue = currentRole == .host ? String(localized: "Your room") : String(localized: "Join a room")
            phaseOrb.isHidden = true
            ownerLaunchView.setStatus(nil)
            hostLeaseHealthy = false
            renderHostLiveStatus(active: false)
            stopDurationClock()
            muteButton.isEnabled = true
            cameraButton.isEnabled = true
            updateBackgroundButtonsEnabled()
            screenShareButton.isHidden = true
            screenShareButton.isEnabled = false
            updateScreenShareLayoutButton()
            resetChatUI()
        case .connecting:
            phaseLabel.stringValue = currentRole == .host ? String(localized: "Starting room…") : String(localized: "Joining room…")
            phaseOrb.isHidden = false
            startButton.isEnabled = false
            muteButton.isEnabled = false
            cameraButton.isEnabled = false
            backgroundButton.isEnabled = false
            screenShareButton.isEnabled = false
            screenShareButton.isHidden = true
            updateScreenShareLayoutButton()
            resetChatUI()
            renderHostLiveStatus(active: false)
            stopDurationClock()
        case .connected:
            phaseLabel.stringValue = String(localized: "In meeting")
            phaseOrb.isHidden = true
            startButton.applyMeetFilledStyle(
                .danger,
                title: meetingMainActionTitle
            )
            startButton.isEnabled = true
            modeControl.isEnabled = false
            muteButton.isEnabled = currentRole != .host || meetingHoldsHost
            cameraButton.isEnabled = true
            updateBackgroundButtonsEnabled()
            screenShareButton.isEnabled = true
            screenShareButton.isHidden = false
            chatButton.isHidden = false
            chatButton.isEnabled = true
            reactionsButton.isHidden = false
            reactionsButton.isEnabled = true
            handButton.isHidden = false
            applyHandAppearance()
            returnKeyboard(to: muteButton)
            if isCameraEnabled, backgroundEffect != .none {
                Task { try? await meetingSession.setBackgroundEffect(backgroundEffect) }
            }
            wakeAssertion.begin(
                reason: currentRole == .host && meetingHoldsHost
                    ? String(localized: "Hosting a Starlings room")
                    : "Participating in a Starlings meeting"
            )
            startDurationClock()
            // Guests report their own quality too — the host's view of the call
            // says nothing about what the person on hotel wifi experienced.
            startQualityReporting()
            transcriptPanelHoldsHost = meetingHoldsHost
            if currentRole == .host && meetingHoldsHost {
                hostLeaseHealthy = true
                setTranscriptPlaceholder(String(localized: "Listening…"))
                startHostHeartbeat()
                renderHostLiveStatus(active: true)
                if let filing = pendingFiling {
                    // Started from Work: file it now rather than reading back
                    // an unfiled meeting, then fetch the list so the popup
                    // offers the rest of that kind.
                    pendingFiling = nil
                    persistMeetingCategory(kind: filing.meetingKind, subject: filing)
                    Task { @MainActor [weak self] in
                        guard let self, let subjectKind = filing.meetingKind.subjectKind else { return }
                        await refreshCategorySubjects(kind: subjectKind, selecting: filing.id)
                    }
                } else {
                    loadMeetingCategoryIfNeeded()
                }
                startTaskSuggestions()
            } else {
                hostLeaseHealthy = false
                setTranscriptPlaceholder(String(localized: "Waiting for shared captions from the host Mac."))
                renderHostLiveStatus(active: false)
                stopHostHeartbeat()
                stopTaskSuggestions()
            }
        case .ended:
            restorePersonalHostRoomIfNeeded()
            meetingHoldsHost = false
            phaseLabel.stringValue = String(localized: "Meeting ended")
            stopTaskSuggestions()
            // A clean end needs no announcement — the clock and Start say it.
            // This also clears a stale failure once the retry works.
            ownerLaunchView.setStatus(nil)
            startButton.applyMeetFilledStyle(
                .accent,
                title: currentRole == .host ? String(localized: "Start another room") : String(localized: "Join another room"),
                symbolName: "video.fill"
            )
            startButton.isEnabled = true
            modeControl.isEnabled = true
            screenShareButton.isEnabled = false
            screenShareButton.isHidden = true
            updateScreenShareLayoutButton()
            resetChatUI()
            resetMediaControlState()
            muteButton.isEnabled = true
            cameraButton.isEnabled = true
            updateBackgroundButtonsEnabled()
            meetingStage.reset(deviceID: idlePrejoinCameraID(for: phase))
            wakeAssertion.end()
            hostLeaseHealthy = false
            renderHostLiveStatus(active: false)
            stopHostHeartbeat()
            stopDurationClock()
            stopQualityReporting()
            participantQuality = []
            remoteVideoSnapshot = []
            bandwidthSnapshot = nil
            updateConnectionQualityButton()
            updateBandwidthButton()
            Task { await flushQualityReport() }
        case .failed(let error):
            restorePersonalHostRoomIfNeeded()
            phaseLabel.stringValue = error.title
            sidebarErrorNotice.setText(error.message, tone: .danger, detail: error.logLine)
            ownerLaunchView.setStatus("\(error.title) — \(error.message)", tone: .danger, detail: error.logLine)
            startButton.isEnabled = true
            modeControl.isEnabled = true
            screenShareButton.isEnabled = false
            screenShareButton.isHidden = true
            updateScreenShareLayoutButton()
            resetChatUI()
            resetMediaControlState()
            muteButton.isEnabled = true
            cameraButton.isEnabled = true
            updateBackgroundButtonsEnabled()
            meetingStage.reset(deviceID: idlePrejoinCameraID(for: phase))
            // The launch surface states the reason inline and keeps Start one
            // click away; a sheet on top of that is the same news twice.
            if showsOwnerLaunch(for: phase) {
                // present() would log this; keep the Console trace when the
                // inline banner takes the sheet's place.
                StarlingsDiagnosticsLog.shared.record(error, context: "launch banner")
            } else {
                present(error)
            }
            wakeAssertion.end()
            hostLeaseHealthy = false
            renderHostLiveStatus(active: false)
            stopHostHeartbeat()
            stopDurationClock()
            stopQualityReporting()
            participantQuality = []
            remoteVideoSnapshot = []
            bandwidthSnapshot = nil
            updateConnectionQualityButton()
            updateBandwidthButton()
            Task { await flushQualityReport() }
        }
        switch phase {
        case .ended, .failed:
            // A call placed from Team is a visit, and a visit ends: put the
            // host back on their own door. No-op unless Work put this Mac in
            // Join in the first place.
            restoreRoleAfterCallIfNeeded()
        case .setup, .connecting, .connected:
            break
        }
        refreshSidebarChrome()
    }

    /// The team's names, spelled the way Core spells them, for the transcript
    /// name pass. Best effort and off the critical path: a roster
    /// that does not arrive leaves the pass with the room's own names.
    private func loadKnownNamesForTranscript() {
        let invitees = pendingInviteeNames
        pendingInviteeNames = []
        meetingSession.knownNames = invitees
        Task { [weak self] in
            guard let self, let roster = try? await controlAPI.peers() else { return }
            let names = invitees + roster.peers.compactMap(\.name)
            meetingSession.knownNames = names
            await suggestionEngine?.setKnownNames(names)
        }
    }

    private func receiveTranscriptSegment(_ segment: TranscriptSegment) async {
        appendTranscriptLine(segment)
        // Proposing runs alongside the upload, never in front of it: the
        // outbox is the durable path and must not wait on inference.
        ingestForSuggestions(segment)
        guard let context = meetingContext else { return }
        guard context.role == .host else { return }
        let delivery = await artifactOutbox.enqueue(
            segment,
            room: context.room.rawValue,
            meetingID: context.meetingID
        )
        // Text the Worker does not have yet — not, as before, "the meeting
        // is still open", which showed the notice on every line.
        if delivery.isUploadPending {
            setTranscriptionNotice(String(localized: "SAVED — UPLOAD PENDING"))
        }
    }

    // MARK: - Caption panel

    private struct TranscriptRenderLine {
        let segmentID: UUID
        let speaker: String
        let text: String
    }

    /// Live captions are a view, not the record — the transcript itself is the
    /// outbox and the room coordinator. Bounding the panel keeps a long
    /// meeting from re-laying out thousands of lines on every utterance.
    private static let transcriptPanelLineLimit = CaptionMessage.historyLineLimit

    private func setTranscriptPlaceholder(_ message: String) {
        transcriptPlaceholder = message
        transcriptLines = []
        capturedTranscriptLineCount = 0
        transcriptionNotice = nil
        renderTranscript()
        renderTranscriptionStatus()
    }

    private func setTranscriptionNotice(_ notice: String?) {
        transcriptionNotice = notice
        renderTranscriptionStatus()
    }

    /// The header line is deliberately quiet: the count of captured lines when
    /// things are working, a notice only when there is something to say. The
    /// transcriber's moment-to-moment chatter (listening, processing) used to
    /// flicker here and told nobody anything the line count does not.
    private func renderTranscriptionStatus() {
        let text: String
        if let transcriptionNotice {
            text = transcriptionNotice
        } else if capturedTranscriptLineCount == 0 {
            text = ""
        } else {
            text = String(localized: "\(capturedTranscriptLineCount) LINES")
        }
        transcriptionStatusLabel.stringValue = text
    }

    private func appendTranscriptLine(_ segment: TranscriptSegment) {
        capturedTranscriptLineCount += 1
        // A line arriving is proof the pipeline works, so any earlier notice
        // about it has expired. A failed upload re-raises its own right after.
        transcriptionNotice = nil
        renderTranscriptionStatus()
        transcriptLines.append(
            TranscriptRenderLine(
                segmentID: segment.id,
                speaker: segment.speakerName,
                text: segment.text
            )
        )
        if transcriptLines.count > Self.transcriptPanelLineLimit {
            transcriptLines.removeFirst(transcriptLines.count - Self.transcriptPanelLineLimit)
        }
        renderTranscript()
        transcriptText.scrollToEndOfDocument(nil)
    }

    /// Lines that produced a task are marked and lifted to primary text. That
    /// mark is the whole feedback loop: the owner can see which sentence the
    /// suggestion in the sidebar came out of.
    private func renderTranscript() {
        let body = NSFont.systemFont(ofSize: StarlingsTypography.scaled(14))
        guard !transcriptLines.isEmpty else {
            setTranscriptContents(
                NSAttributedString(
                    string: transcriptPlaceholder,
                    attributes: [.font: body, .foregroundColor: StarlingsColors.secondaryText]
                )
            )
            return
        }
        let output = NSMutableAttributedString()
        for (index, line) in transcriptLines.enumerated() {
            if index > 0 {
                output.append(NSAttributedString(string: "\n\n", attributes: [.font: body]))
            }
            let flagged = flaggedTranscriptSegmentIDs.contains(line.segmentID)
            if flagged {
                output.append(NSAttributedString(
                    string: "◆ ",
                    attributes: [
                        .font: NSFont.systemFont(ofSize: StarlingsTypography.scaled(14), weight: .bold),
                        .foregroundColor: StarlingsColors.accentMark,
                    ]
                ))
            }
            output.append(NSAttributedString(
                string: "\(line.speaker): \(line.text)",
                attributes: [
                    .font: body,
                    .foregroundColor: flagged ? StarlingsColors.primaryText : StarlingsColors.secondaryText,
                ]
            ))
        }
        setTranscriptContents(output)
    }

    private func setTranscriptContents(_ contents: NSAttributedString) {
        if let storage = transcriptText.textStorage {
            storage.setAttributedString(contents)
        } else {
            transcriptText.string = contents.string
        }
    }

    // MARK: - Task suggestions

    private func startTaskSuggestions() {
        guard let context = meetingContext, context.role == .host else { return }
        guard suggestionEngineMeetingID != context.meetingID else { return }
        let resolution = TaskSuggestionEngineFactory.resolve { [weak self] in
            guard let self else { return nil }
            let extractor = WorkerTaskExtractor(
                api: self.controlAPI,
                context: context
            ) { [weak self] note in
                Task { @MainActor in
                    self?.suggestionLiveNote = note
                    self?.tasksControls.setSuggestionNote(note)
                }
            }
            self.cloudTaskExtractor = extractor
            return extractor
        }
        visibleSuggestions = []
        flaggedTranscriptSegmentIDs = []
        acceptedTranscriptSegmentIDs = []
        tasksControls.setSuggestionNote(resolution.note)
        suggestionResolutionNote = resolution.note
        suggestionLiveNote = nil
        guard let extractor = resolution.extractor else {
            suggestionEngine = nil
            cloudTaskExtractor = nil
            suggestionEngineMeetingID = nil
            renderSuggestions()
            return
        }
        let engine = TaskSuggestionEngine(meetingID: context.meetingID, extractor: extractor)
        suggestionEngine = engine
        let names = meetingSession.knownNames
        Task { await engine.setKnownNames(names) }
        suggestionEngineMeetingID = context.meetingID
        renderSuggestions()
    }

    private func stopTaskSuggestions() {
        suggestionEngine = nil
        suggestionResolutionNote = nil
        suggestionLiveNote = nil
        cloudTaskExtractor = nil
        suggestionEngineMeetingID = nil
        visibleSuggestions = []
        flaggedTranscriptSegmentIDs = []
        acceptedTranscriptSegmentIDs = []
        tasksControls.setSuggestionNote(nil)
        tasksControls.setSuggestions([], canAccept: false)
    }

    private func ingestForSuggestions(_ segment: TranscriptSegment) {
        guard let engine = suggestionEngine else { return }
        Task { @MainActor [weak self] in
            let proposed = await engine.ingest(segment)
            guard let self, !proposed.isEmpty else { return }
            guard self.suggestionEngineMeetingID == segment.meetingID else { return }
            self.visibleSuggestions.append(contentsOf: proposed)
            for suggestion in proposed {
                self.flaggedTranscriptSegmentIDs.formUnion(suggestion.sourceSegmentIDs)
            }
            self.renderTranscript()
            self.renderSuggestions()
        }
    }

    private func renderSuggestions() {
        // Accepting no longer waits on the meeting being categorized: the sheet
        // files the task itself, defaulting to the meeting's subject when there
        // is one.
        tasksControls.setSuggestions(visibleSuggestions, canAccept: true)
        refreshTasksPanelVisibility()
    }

    /// The panel earns its place when there is a subject *or* something to
    /// propose. Withholding suggestions until a lead is filed would throw away
    /// everything said in the first minutes of a call.
    private func refreshTasksPanelVisibility() {
        defer { refreshSidebarSections() }
        guard currentRole == .host, case .connected = meetingSession.phase else { return }
        tasksControls.isHidden = activeTaskSubject == nil && !tasksControls.hasSuggestions
    }

    /// Ticking a suggestion writes it, with the title, owner, and provenance it
    /// already carries. A toggle that opened a sheet would not be a toggle —
    /// the sheet is still there on the row's title, for the ones worth reading
    /// before they land.
    /// One tap accepts against the meeting's own filing. With no filing there
    /// is nowhere to put it, so the sheet opens and asks — which beats a tick
    /// that silently writes nothing.
    private func acceptSuggestion(_ suggestion: TaskSuggestion) {
        guard let subject = activeCrmSubject else {
            presentSuggestionEditor(suggestion)
            return
        }
        createTask(
            from: suggestion,
            draft: .init(
                title: suggestion.title,
                notes: suggestion.provenanceNote,
                status: .pending,
                responsible: suggestion.responsibleGuess,
                subject: subject
            )
        )
    }

    /// The meeting's own filing, as something a task sheet can file to.
    private var activeCrmSubject: CrmSubject? {
        guard let subject = activeTaskSubject, let kind = subject.kind.subjectKind else { return nil }
        return CrmSubject(
            id: subject.id,
            kind: kind.rawValue,
            title: subject.title ?? (kind == .project ? String(localized: "This project") : kind == .organization ? String(localized: "This partner") : String(localized: "This lead")),
            subtitle: nil
        )
    }

    /// The sheet needs a roster for the assignee menu and a page of subjects so
    /// an uncategorized meeting can still file the task somewhere. Both are
    /// gathered before it opens: a sheet that appears with a spinner where the
    /// filing goes is a sheet you cannot answer.
    private func presentTaskSheet(
        title: String,
        initial: MeetingTaskEditor.Draft,
        onSave: @escaping (MeetingTaskEditor.Draft) -> Void
    ) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            async let projects = try? await self.controlAPI.crmSubjectPage(kind: .project, query: "")
            async let leads = try? await self.controlAPI.crmSubjectPage(kind: .lead, query: "")
            async let partners = try? await self.controlAPI.crmSubjectPage(kind: .organization, query: "")
            async let roster = try? await self.controlAPI.crmTeam()
            let options = ((await projects)?.subjects ?? []) + ((await leads)?.subjects ?? []) + ((await partners)?.subjects ?? [])
            let team = (await roster) ?? []
            let email = (try? self.ownerSessionStore.load())?.owner.email.lowercased()
            MeetingTaskEditor.present(
                over: self.view.window,
                title: title,
                initial: initial,
                team: team,
                subjectField: .choose(initial: self.activeCrmSubject, options: options, search: nil),
                selfMemberID: team.first { $0.email?.lowercased() == email }?.id,
                isNew: true,
                onSave: onSave
            )
        }
    }

    private func presentSuggestionEditor(_ suggestion: TaskSuggestion) {
        presentTaskSheet(
            title: String(localized: "Task from this meeting"),
            initial: .init(
                title: suggestion.title,
                notes: suggestion.provenanceNote,
                status: .pending,
                responsible: suggestion.responsibleGuess,
                subject: activeCrmSubject
            )
        ) { [weak self] draft in
            guard let self, !draft.title.isEmpty else { return }
            self.createTask(from: suggestion, draft: draft)
        }
    }

    /// The subject comes off the draft, because the sheet is where filing
    /// happens: a meeting nobody has categorized can still accept a task.
    private func createTask(from suggestion: TaskSuggestion, draft: MeetingTaskEditor.Draft) {
        guard let subject = draft.subject ?? activeCrmSubject, !draft.title.isEmpty else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let created = try await self.controlAPI.createCrmTask(CrmTaskCreate(
                    title: draft.title,
                    notes: draft.notes.isEmpty ? nil : draft.notes,
                    status: draft.status.rawValue,
                    responsibleParty: draft.responsible.rawValue,
                    assignedTo: Patch(draft.assignedTo),
                    dueDate: draft.dueDate.map(CrmTaskDate.wire),
                    projectID: subject.kind == "project" ? subject.id : nil,
                    leadID: subject.kind == "lead" ? subject.id : nil,
                    organizationID: subject.kind == "organization" ? subject.id : nil,
                    // Work the meeting produced, said so: this is what the
                    // subject's channel reports, and a typed task is not.
                    meetingID: self.meetingContext?.meetingID,
                    source: "suggestion"
                ))
                await self.suggestionEngine?.markAccepted(id: suggestion.id, crmTaskID: created.id)
                // The caption mark stays: that line really did produce a task.
                self.acceptedTranscriptSegmentIDs.formUnion(suggestion.sourceSegmentIDs)
                self.resolveSuggestion(suggestion)
                self.refreshTasks()
            } catch {
                let failure = StarlingsError.wrapping(error, code: "crm.task_create", title: String(localized: "Couldn’t create task"))
                self.tasksControls.setUnavailable(failure.message)
                // Put the row back the way it was: nothing was written, so the
                // tick has to come off.
                self.tasksControls.clearAcceptingSuggestion(suggestion.id)
                self.renderSuggestions()
            }
        }
    }

    /// Done and back again, without a sheet. The panel has already redrawn —
    /// this is only the write, and a failure re-reads Core rather than leaving
    /// a tick that means nothing.
    private func setTaskDone(_ task: CrmTask, done: Bool) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                _ = try await self.controlAPI.updateCrmTask(
                    id: task.id,
                    update: .completion(done)
                )
            } catch {
                let failure = StarlingsError.wrapping(error, code: "crm.task_update", title: String(localized: "Couldn’t update task"))
                self.tasksControls.setTaskDoneLocally(task, done: !done)
                self.tasksControls.setRefreshFailed(failure.message)
            }
        }
    }

    /// The panel's row menu: the same registry Work draws. Every write
    /// re-reads the panel from Core.
    private func performTaskAction(_ action: WorkRowAction) {
        switch action {
        case .accept(let task): writeTask(task, update: .proposalDecision(accepted: true))
        case .decline(let task): writeTask(task, update: .proposalDecision(accepted: false))
        case .completeTask(let task):
            tasksControls.setTaskDoneLocally(task, done: true)
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    _ = try await controlAPI.updateCrmTask(id: task.id, update: .completion(true))
                } catch {
                    let failure = StarlingsError.wrapping(error, code: "crm.task_update", title: String(localized: "Couldn’t update task"))
                    tasksControls.setTaskDoneLocally(task, done: false)
                    tasksControls.setRefreshFailed(failure.message)
                }
            }
        case .cancelTask(let task): writeTask(task, update: .cancellation)
        case .promoteTask(let task):
            guard let projectID = task.projectID else { return }
            runTaskWrite {
                _ = try await $0.createCrmIssue(.promotion(
                    projectID: projectID, taskID: task.id, title: task.title, body: task.notes
                ))
            }
        case .openCore(let url): NSWorkspace.shared.open(url)
        case .deleteTask(let id, let title):
            TaskDeleteAlert.ask(title: title, over: view.window) { [weak self] in
                guard let self else { return }
                let api = controlAPI
                Task { @MainActor [weak self] in
                    do {
                        try await api.deleteCrmTask(id: id)
                    } catch {
                        let failure = StarlingsError.wrapping(error, code: "crm.task_delete", title: TaskDeleteCopy.failure)
                        self?.tasksControls.setRefreshFailed(failure.message)
                    }
                    self?.refreshTasks()
                }
            }
        default: break
        }
    }

    private func writeTask(_ task: CrmTask, update: CrmTaskUpdate) {
        runTaskWrite { _ = try await $0.updateCrmTask(id: task.id, update: update) }
    }

    private func runTaskWrite(_ write: @escaping @MainActor (MeetingControlAPI) async throws -> Void) {
        let api = controlAPI
        Task { @MainActor [weak self] in
            do {
                try await write(api)
            } catch {
                let failure = StarlingsError.wrapping(error, code: "crm.task_update", title: String(localized: "Couldn’t update task"))
                self?.tasksControls.setUnavailable(failure.message)
            }
            self?.refreshTasks()
        }
    }

    private func dismissSuggestion(_ suggestion: TaskSuggestion) {
        let engine = suggestionEngine
        Task { await engine?.markDismissed(id: suggestion.id) }
        resolveSuggestion(suggestion)
    }

    private func resolveSuggestion(_ suggestion: TaskSuggestion) {
        visibleSuggestions.removeAll { $0.id == suggestion.id }
        flaggedTranscriptSegmentIDs = acceptedTranscriptSegmentIDs
            .union(visibleSuggestions.flatMap(\.sourceSegmentIDs))
        renderTranscript()
        renderSuggestions()
    }

    @objc func toggleChat(_ sender: Any?) {
        guard meetingSession.phase == .connected else { return }
        setChatVisible(!isChatVisible)
    }

    private func setChatVisible(_ visible: Bool) {
        let showing = visible && meetingSession.phase == .connected
        isChatVisible = showing
        if showing {
            chatWindowController.show(relativeTo: view.window)
            unreadChatCount = 0
            updateChatButtonTitle()
        } else {
            chatWindowController.hide()
            returnKeyboard(to: chatButton)
        }
    }

    /// The keyboard goes back to the control that opened what just closed,
    /// and lands on the control bar after connect, so Tab never starts from
    /// nowhere. A text field that has the keyboard keeps it.
    private func returnKeyboard(to control: NSControl) {
        guard let window = view.window, !control.isHidden, control.isEnabled else { return }
        if let responder = window.firstResponder, responder is NSTextView || responder is NSTextField {
            return
        }
        window.makeFirstResponder(control)
    }

    private func receiveChatMessage(_ message: MeetingChatMessage) {
        chatPanel.append(message)
        if !isChatVisible, !message.isLocal {
            unreadChatCount += 1
            updateChatButtonTitle()
        }
    }

    private func resetChatUI() {
        isChatVisible = false
        chatWindowController.hide()
        chatPanel.clear()
        unreadChatCount = 0
        chatButton.isHidden = true
        chatButton.isEnabled = false
        reactionsButton.isHidden = true
        reactionsButton.isEnabled = false
        handButton.isHidden = true
        handButton.isEnabled = false
        // A queue does not outlive the meeting it belonged to.
        raisedHands = []
        ownHandRaised = false
        lastReactionSentAt = nil
        updateChatButtonTitle()
        refreshSidebarChrome()
    }

    private func updateChatButtonTitle() {
        if unreadChatCount > 0 {
            chatButton.title = String(localized: "Chat (\(unreadChatCount))")
            chatButton.setAccessibilityLabel(String(localized: "Chat, \(unreadChatCount) unread messages"))
        } else {
            chatButton.title = String(localized: "Chat")
            chatButton.setAccessibilityLabel(String(localized: "Chat"))
        }
    }

    /// The palette, as a menu under the React button. Six items, no submenu,
    /// no picker — the whole point is that reacting costs one click.
    /// Raise or lower your own hand.
    ///
    /// The write goes through the control plane, which takes the identity from
    /// this meeting's token — see `MeetingHands` for why no client writes the
    /// attribute itself. Nothing is assumed locally: the button changes when
    /// the room says it did.
    @objc private func toggleOwnHand(_ sender: Any?) {
        guard meetingSession.phase == .connected, let context = meetingContext else { return }
        let wanted = !ownHandRaised
        handButton.isEnabled = false
        Task { [weak self] in
            guard let self else { return }
            do {
                try await controlAPI.setOwnHand(context: context, raised: wanted)
            } catch {
                present(StarlingsError.wrapping(
                    error,
                    code: "hand.write_failed",
                    title: wanted ? String(localized: "Couldn’t raise your hand") : String(localized: "Couldn’t lower your hand"),
                    recovery: .retry
                ))
            }
            applyHandAppearance()
        }
    }

    /// Clear the whole queue, for the host.
    ///
    /// Owner-only server-side. A host who has just answered six people should
    /// not be lowering six hands one at a time, and a queue nobody can reset is
    /// a queue that stops meaning anything by the second meeting.
    @objc func lowerAllHandsFromMenu() {
        guard meetingSession.phase == .connected, let context = meetingContext else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                let lowered = try await controlAPI.lowerAllHands(context: context)
                showStatusNotice(lowered == 1 ? String(localized: "Lowered 1 hand") : String(localized: "Lowered \(lowered) hands"))
            } catch {
                present(StarlingsError.wrapping(
                    error,
                    code: "hand.lower_all_failed",
                    title: String(localized: "Couldn’t lower the hands"),
                    recovery: .retry
                ))
            }
        }
    }

    /// The button says which way the next press goes, and carries the queue's
    /// size when there is one — the stage badge answers "who", this answers "is
    /// anybody waiting" when their tile is off-screen.
    private func applyHandAppearance() {
        let connected = meetingSession.phase == .connected
        handButton.isEnabled = connected
        setMeetingControlImage(
            handButton,
            symbol: "hand.raised.fill",
            accessibility: ownHandRaised ? String(localized: "Lower your hand") : String(localized: "Raise your hand")
        )
        handButton.contentTintColor = ownHandRaised
            ? StarlingsColors.resolved(StarlingsColors.accentMark, for: handButton)
            : nil
        let waiting = raisedHands.count
        handButton.setAccessibilityLabel(waiting == 0
            ? (ownHandRaised ? String(localized: "Lower your hand") : String(localized: "Raise your hand — it stays up until you lower it"))
            : waiting == 1 ? String(localized: "1 hand raised") : String(localized: "\(waiting) hands raised"))
    }

    @objc private func presentReactionsMenu(_ sender: Any?) {
        guard meetingSession.phase == .connected else { return }
        let menu = NSMenu()
        menu.autoenablesItems = false
        for reaction in MeetingReaction.allCases {
            let item = NSMenuItem(
                title: reaction.accessibilityName,
                action: #selector(sendReaction(_:)),
                keyEquivalent: ""
            )
            item.target = self
            item.representedObject = reaction.rawValue
            item.image = NSImage(
                systemSymbolName: reaction.systemSymbolName,
                accessibilityDescription: reaction.accessibilityName
            )
            menu.addItem(item)
        }
        let point = NSPoint(x: 0, y: reactionsButton.bounds.height + 2)
        menu.popUp(positioning: nil, at: point, in: reactionsButton)
    }

    @objc private func sendReaction(_ sender: Any?) {
        guard let raw = (sender as? NSMenuItem)?.representedObject as? String,
              let reaction = MeetingReaction(rawValue: raw) else { return }
        emit(reaction)
    }

    /// Rate-limited at the source: one participant holding the menu open cannot
    /// fill everyone's window. The local emoji is launched here because LiveKit
    /// does not echo data back to whoever published it — captioned with the
    /// same name everyone else's copy will carry, rather than a "you".
    private func emit(_ reaction: MeetingReaction) {
        let now = Date()
        if let last = lastReactionSentAt, now.timeIntervalSince(last) < MeetingReaction.minimumInterval {
            return
        }
        lastReactionSentAt = now
        reactionOverlay.fly(reaction, from: meetingStage.localDisplayName)
        Task { [weak self] in
            await self?.meetingSession.sendReaction(reaction)
        }
    }

    /// One poller for the whole app. The launch page and the in-meeting queue
    /// are two renderers of the same server-side queue, and they used to own a
    /// poller each — so knocks arriving while neither surface was "active"
    /// (connecting, signing in, mid-transition) produced no row, badge, or
    /// sound until something else woke up. This runs whenever an owner and a
    /// room are known and feeds both renderers.
    private func startLobbyWatch() {
        guard lobbyPollingTask == nil else { return }
        lobbyPollingTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshLobbyOnce()
                try? await Task.sleep(for: .seconds(StarlingsPollingCadence.lobbyFallback))
            }
        }
    }

    /// Room the lobby belongs to: the meeting being hosted right now, then the
    /// room the host form is set to — and, while this Mac is off in somebody
    /// else's room as a guest, the owner's own permanent room.
    ///
    /// That last case is the point. `roomField` holds the room you are
    /// *visiting* in Join mode, and watching it would mean answering the door
    /// of the person you called.
    private var watchedRoom: RoomSlug? {
        if let context = meetingContext, context.role == .host { return context.room }
        if currentRole == .host, let room = RoomSlug(rawValue: roomField.stringValue) { return room }
        return permanentRoom
    }

    private func refreshLobbyOnce() async {
        guard (try? ownerSessionStore.load()) != nil else { return }
        guard let room = watchedRoom else { return }
        do {
            let snapshot = try await controlAPI.lobby(room: room)
            if let context = meetingContext,
               context.role == .host,
               meetingSession.phase == .connected,
               snapshot.meeting?.id == context.meetingID,
               context.ownerIdentity != nil {
                let hostIdentity = snapshot.meeting?.hostIdentity
                await meetingSession.updateHost(identity: hostIdentity)
                if let offer = pendingHostOffer, snapshot.meeting?.hostOfferIdentity == nil,
                   snapshot.meeting?.pendingHostIdentity == nil {
                    // The offer is answered or ran out. Moved: the new host's
                    // tile says so. Still here: say who did not take it.
                    pendingHostOffer = nil
                    if hostIdentity == context.ownerIdentity {
                        setTranscriptionNotice(String(localized: "\(offer.name) didn’t take host."))
                    }
                }
                if hostIdentity == context.ownerIdentity,
                   snapshot.meeting?.pendingHostIdentity != nil,
                   !hostReleaseIsBlocked {
                    await completeRequestedHostTransfer()
                } else if hostIdentity == context.ownerIdentity,
                          hostReleaseAwaitingResolution,
                          !hostMutationInFlight {
                    // A release that failed or timed out did not move the
                    // host: this Mac is still it, so it hosts again. A
                    // pending request is retried once the pause ends.
                    hostReleaseAwaitingResolution = false
                    await meetingSession.resumeHostAfterReleaseFailure()
                } else if hostIdentity != context.ownerIdentity {
                    hostReleaseAwaitingResolution = false
                    hostReleaseRetryAfter = nil
                    // Nobody holds the host, or its device dropped and the
                    // lease ran out: a companion takes it.
                    let leaseLapsed = snapshot.meeting.map {
                        Double($0.hostLeaseExpiresAt) <= Date().timeIntervalSince1970 * 1_000
                    } ?? false
                    if hostIdentity == nil || leaseLapsed { claimVacantHost() }
                }
            }
            let waiting = snapshot.requests
                .filter { $0.status.isPending }
                .sorted { $0.createdAt < $1.createdAt }
            // Keep server FIFO (created_at) — sorting by seenAt made rows jump on every heartbeat.
            let lurkers = snapshot.lurkers
            if waiting.contains(where: { $0.recording == true }) && !lobbyPeopleLoaded && !lobbyPeopleLoading {
                lobbyPeopleLoading = true
                Task { @MainActor in await loadLobbyPeople() }
            }
            // Pre-live until the host is actually connected: admitting a guest
            // requires a started room.
            let prelive = meetingContext == nil || meetingSession.phase != .connected
            sessionDoorOpen = snapshot.meeting?.sessionDoorOpen == true
            applyHostLobbyWaiting(waiting, lurkers: lurkers, prelive: prelive)
            // Away in somebody else's room: the knock is still heard, badged,
            // and notified, but none of the host surfaces are painted — they
            // are hidden behind Join, and the next beat after coming home
            // rebuilds them anyway.
            guard currentRole == .host else { return }
            renderLobbyQueue()
            renderLaunchWaiting(
                waiting,
                lurkers: lurkers,
                prelive: prelive,
                people: lobbyPeople,
                openMeeting: snapshot.meeting
            )
            if !prelive { await fulfillAdmitAfterStartIfNeeded() }
        } catch {
            guard currentRole == .host else { return }
            renderLobbyUnavailable(error)
        }
    }

    private func startSoftPresence() {
        // Every surface refresh lands here. Restarting would drop the record of
        // when this room was last reachable, which is the one thing the status
        // row is decided on.
        guard softPresenceTask == nil else { return }
        // A launch surface with nothing happening on it is a background app for
        // most of the day, and App Nap throttles a backgrounded ten-second beat
        // well past the thirty-second window the control plane checks before it
        // lets anyone knock. Idle *system* sleep stays allowed on purpose: a
        // sleeping Mac genuinely cannot admit anyone.
        softPresenceActivity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiatedAllowingIdleSystemSleep],
            reason: "Keeping your Starlings room reachable"
        )
        softPresenceTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.touchSoftPresenceOnce()
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    private func stopSoftPresence() {
        softPresenceTask?.cancel()
        softPresenceTask = nil
        if let softPresenceActivity {
            ProcessInfo.processInfo.endActivity(softPresenceActivity)
            self.softPresenceActivity = nil
        }
        lastSoftPresenceAt = nil
    }

    /// The one call that decides whether anybody can knock: no beat inside the
    /// lease window and the control plane refuses every join request with
    /// deliberately neutral copy ("couldn't reach this room right now").
    ///
    /// So this failing in silence is the worst case in the app — the room is
    /// shut and the launch surface still says it is waiting for someone. It
    /// reports now: the debug log every time, the status row once the room has
    /// actually been dark longer than the lease, and a modal for the one cause
    /// the owner has to act on, an expired sign-in.
    private func touchSoftPresenceOnce() async {
        guard let room = RoomSlug(rawValue: roomField.stringValue) else { return }
        do {
            try await controlAPI.touchPresence(room: room)
            lastSoftPresenceAt = Date()
            reportedPresenceSessionExpiry = false
            if softPresenceFailure != nil {
                softPresenceFailure = nil
                renderRoomReachability()
            }
        } catch {
            let failure = StarlingsError.wrapping(
                error,
                code: "host.presence_heartbeat",
                title: String(localized: "Guests can’t reach this room")
            )
            StarlingsDiagnosticsLog.shared.record(failure, context: "room presence heartbeat")
            softPresenceFailure = failure
            renderRoomReachability()
            // 401 already cleared the Keychain inside MeetingControlAPI. Bring
            // the surfaces in line so the app stops presenting a signed-out
            // account as a live room, and say it once — this is the failure an
            // owner cannot diagnose from the guest's neutral error.
            if failure.code == "auth.session_expired", !reportedPresenceSessionExpiry {
                reportedPresenceSessionExpiry = true
                refreshIdentityPresentation()
                refreshSidebarChrome()
                updateSurfaceVisibility()
                present(failure)
            }
        }
    }

    /// Lease window the control plane enforces (`HOST_LEASE_MILLISECONDS`).
    /// Nothing is said before it: one dropped beat out of three is a blip, not
    /// a closed room.
    private static let roomReachabilityWindow: TimeInterval = 30

    /// Status copy while the room is unreachable — nil when it is fine.
    private func roomReachabilityStatus() -> String? {
        guard let failure = softPresenceFailure else { return nil }
        if let lastSoftPresenceAt,
           Date().timeIntervalSince(lastSoftPresenceAt) < Self.roomReachabilityWindow {
            return nil
        }
        return String(localized: "Guests can’t reach this room — \(failure.message)")
    }

    private func renderRoomReachability() {
        guard showsOwnerLaunch(for: meetingSession.phase) else { return }
        guard let status = roomReachabilityStatus() else {
            // A live phase failure owns the row; don't wipe it on recovery.
            if case .failed = meetingSession.phase { return }
            ownerLaunchView.setStatus(nil)
            return
        }
        ownerLaunchView.setStatus(status, tone: .danger)
    }

    /// Pre-knock presence for Mac Join, mirroring the browser join page.
    ///
    /// A knock at an unreachable room is refused outright, so this is the only
    /// thing a Mac guest can leave behind while the owner is away — and it is
    /// what turns "start when guests knock" into something the Mac can honour.
    private func refreshGuestPresence() {
        let entry = GuestRoomEntry(input: roomField.stringValue)
        let wantsPresence = currentRole == .guest
            && meetingSession.phase.isIdle
            && guestAdmissionTask == nil
        guard wantsPresence, let entry else {
            stopGuestPresence()
            return
        }
        // Same room, beat already running: leave it alone rather than restart
        // it (and orphan a lurker row) on every unrelated surface refresh.
        if guestPresenceRoom == entry.room, guestPresenceTask != nil { return }
        stopGuestPresence()
        guestPresenceRoom = entry.room
        // Fresh id per room, so two rooms in one sitting are two visitors and
        // the first one ages out instead of following you.
        guestPresenceID = UUID().uuidString.lowercased()
        let presenceID = guestPresenceID
        guestPresenceTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.touchGuestPresenceOnce(entry: entry, presenceID: presenceID)
                try? await Task.sleep(for: .seconds(PeerPresenceCadence.guestPresenceHeartbeat))
            }
        }
    }

    private func stopGuestPresence() {
        guestPresenceTask?.cancel()
        guestPresenceTask = nil
        guestPresenceRoom = nil
    }

    private func touchGuestPresenceOnce(entry: GuestRoomEntry, presenceID: String) async {
        let typedName = nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try await controlAPI.touchGuestPresence(
                room: entry.room,
                presenceID: presenceID,
                stage: isCameraEnabled ? .preview : .visit,
                name: typedName.isEmpty ? nil : typedName,
                bookingToken: entry.bookingToken
            )
        } catch {
            // Best-effort, exactly like the browser's: the owner just doesn't
            // see this Mac until a later beat lands.
            StarlingsDiagnosticsLog.shared.record(
                StarlingsError.wrapping(error, code: "lobby.guest_presence", title: String(localized: "Presence")),
                context: "guest presence heartbeat"
            )
        }
    }

    private func renderLaunchWaiting(
        _ waiting: [LobbyRequestResponse],
        lurkers: [GuestPresenceRow],
        prelive: Bool,
        people: [Peer],
        openMeeting: LobbySnapshotResponseMeeting?
    ) {
        let emptyCopy = lurkers.isEmpty
            ? ""
            : "Waiting for a knock — or Start & Admit when they join."
        ownerLaunchView.setWaitingEmptyMessage(
            waiting.isEmpty
                ? emptyCopy
                : "Start the room to admit guests — or Start & Admit."
        )
        // An open meeting with a healthy lease belongs to a live app instance;
        // it must not be treated as abandoned or offered to Close room.
        let anotherHostIsLive: Bool
        if prelive, let openMeeting {
            anotherHostIsLive = Double(openMeeting.hostLeaseExpiresAt) > Date().timeIntervalSince1970 * 1_000
        } else {
            anotherHostIsLive = false
        }
        reclaimableMeetingID = prelive && !anotherHostIsLive ? openMeeting?.id : nil
        if prelive, let openMeeting {
            if anotherHostIsLive {
                ownerLaunchView.setStatus(String(localized: "Room is already live on another device."))
            } else if shouldAutoReclaim(openMeeting) {
                // A crash mid-call: guests are still in the LiveKit room and
                // the lease lapses in 30s, so walk back in without a click.
                autoReclaimedMeetingID = openMeeting.id
                ownerLaunchView.setStatus(String(localized: "Room still open from last session — rejoining…"))
                toggleMeeting(nil)
            } else {
                ownerLaunchView.setStatus(
                    "Room still open from last session — Join to reclaim.",
                    offersClose: true
                )
            }
            // The room is already open, so the CTA is a door, not a switch.
            ownerLaunchView.setStartTitle(waiting.isEmpty ? String(localized: "Join room") : String(localized: "Join & Admit"))
        } else {
            switch meetingSession.phase {
            case .failed(let error):
                ownerLaunchView.setStatus("\(error.title) — \(error.message)", tone: .danger, detail: error.logLine)
            case .setup, .ended:
                // A room nobody can knock at outranks an empty status row —
                // and this poll runs often enough to paint over it otherwise.
                if let unreachable = roomReachabilityStatus() {
                    ownerLaunchView.setStatus(unreachable, tone: .danger)
                } else {
                    ownerLaunchView.setStatus(nil)
                }
            case .connecting, .connected:
                break
            }
            ownerLaunchView.setStartTitle(waiting.isEmpty ? String(localized: "Start room") : String(localized: "Start & Admit"))
        }
        ownerLaunchView.renderWaiting(
            requests: waiting,
            lurkers: lurkers,
            prelive: prelive,
            people: people,
            onStartAndAdmit: { [weak self] id, sender in
                self?.startAndAdmit(requestID: id, onBehalfOf: sender)
            },
            onAdmit: { [weak self] id, sender in
                self?.decideLobbyGuest(requestID: id, admit: true, onBehalfOf: sender)
            },
            onDecline: { [weak self] id in
                self?.decideLobbyGuest(requestID: id, admit: false)
            },
            onDeclineAll: { [weak self] in
                self?.declineAllWaitingGuests()
            },
            onRemoveLurker: { [weak self] id in
                self?.removeLurker(lurkerID: id)
            }
        )
        ownerLaunchView.setStartEnabled(true)
        // The open-room read lands here, after the lobby beat that feeds the
        // menu bar — so the menu is told again rather than lagging a poll.
        notifyMenubarStateChange()
    }

    private func renderLobbyUnavailable(_ error: Error) {
        defer { refreshSidebarSections() }
        pendingGuestLabel.stringValue = String(localized: "Waiting room unavailable: \(error.localizedDescription)")
        removeLobbyQueueRows()
        lobbyQueueStack.isHidden = true
        lobbySection?.setBadge(nil)
        pendingLurkers = []
        ownerLaunchView.setWaitingEmptyMessage("")
        ownerLaunchView.setStartTitle(String(localized: "Start room"))
        reclaimableMeetingID = nil
        notifyMenubarStateChange()
    }

    /// Clears every waiting knock at once — abandoned tabs leave rows behind,
    /// since a knock only expires when the guest is still polling for it.
    private func declineAllWaitingGuests() {
        for request in pendingLobbyRequests {
            decideLobbyGuest(requestID: request.id, admit: false)
        }
    }

    private func applyHostLobbyWaiting(_ waiting: [LobbyRequestResponse], lurkers: [GuestPresenceRow], prelive: Bool) {
        let previousIDs = Set(pendingLobbyRequests.map(\.id))
        pendingLobbyRequests = waiting
        pendingLurkers = lurkers
        notifyMenubarStateChange()
        announceLobbyKnocks(
            previousIDs: previousIDs,
            waiting: waiting,
            prelive: prelive
        )
    }

    private func announceLobbyKnocks(
        previousIDs: Set<String>,
        waiting: [LobbyRequestResponse],
        prelive: Bool
    ) {
        let nextIDs = Set(waiting.map(\.id))
        NSApp.dockTile.badgeLabel = waiting.isEmpty ? nil : "\(waiting.count)"
        // The window title belongs to whatever surface is on screen. In Join it
        // is somebody else's room, so a waiting count there would name the
        // wrong door.
        if currentRole == .host {
            // Before the meeting the queue is Home's, drawn in YOUR ROOM; once
            // it is live it is the Room window's. Anything urgent about either
            // is that window's subtitle. See `StarlingsWindowChrome`.
            homeView.window?.subtitle = prelive && !waiting.isEmpty
                ? String(localized: "\(waiting.count) waiting")
                : ""
            if !prelive {
                view.window?.subtitle = waiting.isEmpty
                    ? String(localized: "Host")
                    : "Host · \(waiting.count) waiting"
            }
        }

        // Somebody admitted, declined, or gone: their banner must not stay up
        // offering to let in a person who is no longer there.
        KnockNotices.withdraw(requestIDs: previousIDs.subtracting(nextIDs))

        defer {
            announcedLobbyRequestIDs = nextIDs
            lobbyKnockAnnouncementsPrimed = true
        }
        guard lobbyKnockAnnouncementsPrimed else { return }
        let newcomers = nextIDs.subtracting(previousIDs).subtracting(announcedLobbyRequestIDs)
        guard !newcomers.isEmpty else { return }
        guard LobbyKnockPreferences.alertsEnabled else { return }
        NSApp.requestUserAttention(.informationalRequest)
        KnockSound.play()
        let notices = waiting
            .filter { newcomers.contains($0.id) }
            .map {
                KnockNotice(
                    requestID: $0.id,
                    name: $0.name,
                    hasBooking: $0.bookingToken?.isEmpty == false
                )
            }
        Task { await KnockNotices.deliver(notices) }
    }

    private func fulfillAdmitAfterStartIfNeeded() async {
        guard let requestID = admitAfterStartRequestID else { return }
        guard meetingSession.phase == .connected, meetingContext?.role == .host else { return }
        guard pendingLobbyRequests.contains(where: { $0.id == requestID }) else {
            // Guest may still be migrating from pre-live; keep waiting a few polls.
            return
        }
        admitAfterStartRequestID = nil
        decideLobbyGuest(requestID: requestID, admit: true, onBehalfOf: pendingRecorderSenders[requestID])
    }

    /// Somebody at the door, said on the stage so the answer does not depend on
    /// the rail being open. It speaks for whoever has waited longest, which is
    /// exactly who ⌘⇧↩ admits.
    private func refreshKnockBanner() {
        guard meetingSession.phase == .connected,
              currentRole == .host,
              let next = pendingLobbyRequests.first else {
            meetingStage.setKnock(name: nil, waiting: 0, busy: false)
            return
        }
        meetingStage.setKnock(
            name: next.name.isEmpty ? String(localized: "Someone") : next.name,
            waiting: pendingLobbyRequests.count,
            busy: lobbyDecisionInFlight.contains(next.id)
        )
    }

    /// Opens the rail on the waiting room — where a decision about somebody
    /// other than the next guest is made.
    private func revealWaitingRoom() {
        if MeetingPanelPreferences.isCollapsed {
            focusRestore = nil
            MeetingPanelPreferences.isCollapsed = false
            applyMeetingPanelVisibility(animated: true)
        }
        lobbySection?.isCollapsed = false
    }

    private func renderLobbyQueue() {
        defer {
            refreshSidebarSections()
            refreshKnockBanner()
        }
        let previousKnockIDs = Set(lobbyQueueStack.arrangedSubviews.compactMap { ($0 as? LobbyGuestRow)?.requestID })
        let previousLurkerIDs = Set(lobbyQueueStack.arrangedSubviews.compactMap { ($0 as? LobbyLurkerRow)?.lurkerID })
        let nextKnockIDs = Set(pendingLobbyRequests.map(\.id))
        let nextLurkerIDs = Set(pendingLurkers.map(\.id))
        // The session door's button is one more arranged view while it shows.
        let rowCount = pendingLobbyRequests.count + pendingLurkers.count + (sessionDoorOpen ? 1 : 0)
        if previousKnockIDs != nextKnockIDs
            || previousLurkerIDs != nextLurkerIDs
            || renderedLobbyPeopleEmails != lobbyPeople.map(\.email)
            || lobbyQueueStack.arrangedSubviews.count != rowCount {
            rebuildLobbyQueueRows()
        } else {
            for case let row as LobbyGuestRow in lobbyQueueStack.arrangedSubviews {
                row.setBusy(lobbyDecisionInFlight.contains(row.requestID))
            }
            // Identity is stable across a visit but the detail is not — a guest
            // moves visit → naming → preview, and their name and city arrive
            // mid-visit. Refreshing only on an id change froze every row on
            // whatever the guest was doing the moment they first appeared.
            let detailByID = Dictionary(
                pendingLurkers.map { ($0.id, LobbyLurkerCopy.detail(for: $0)) },
                uniquingKeysWith: { first, _ in first }
            )
            let countryByID = Dictionary(
                pendingLurkers.map { ($0.id, $0.country) },
                uniquingKeysWith: { first, _ in first }
            )
            for case let row as LobbyLurkerRow in lobbyQueueStack.arrangedSubviews {
                if let detail = detailByID[row.lurkerID] { row.setDetail(detail) }
                row.setCountry(countryByID[row.lurkerID] ?? nil)
                row.setBusy(lurkerRemovalInFlight.contains(row.lurkerID))
            }
        }

        // The pill only shows while the section is folded shut, and it is the
        // whole point of folding safely: a knock is somebody standing at the
        // door, and a closed block must not be where that gets lost. Accent for
        // a knock, which wants a decision; quiet for people merely on the page.
        if pendingLobbyRequests.isEmpty && pendingLurkers.isEmpty {
            pendingGuestLabel.stringValue = String(localized: "No one on the page yet.")
            lobbyQueueStack.isHidden = false
            lobbySection?.setBadge(nil)
        } else if pendingLobbyRequests.isEmpty {
            let count = pendingLurkers.count
            pendingGuestLabel.stringValue = String(localized: "\(count) on the page")
            lobbyQueueStack.isHidden = false
            lobbySection?.setBadge("\(count) on the page", accented: false)
        } else {
            let count = pendingLobbyRequests.count
            let lurkerNote = pendingLurkers.isEmpty ? "" : String(localized: " · \(pendingLurkers.count) on the page")
            pendingGuestLabel.stringValue = String(localized: "\(count) guests waiting") + lurkerNote
            lobbyQueueStack.isHidden = false
            lobbySection?.setBadge("\(count) waiting")
        }
    }

    private func rebuildLobbyQueueRows() {
        removeLobbyQueueRows()
        renderedLobbyPeopleEmails = lobbyPeople.map(\.email)
        // In an event session, registration links admit without a knock. The
        // host sees that door and can close it for the rest of the session.
        if sessionDoorOpen {
            SettingsChrome.applySecondaryButton(sessionDoorButton, title: String(localized: "Make registered guests knock"), symbolName: "door.left.hand.closed")
            sessionDoorButton.target = self
            sessionDoorButton.action = #selector(closeSessionDoor)
            sessionDoorButton.isEnabled = !sessionDoorClosing
            lobbyQueueStack.addArrangedSubview(sessionDoorButton)
        }
        for lurker in pendingLurkers {
            let row = LobbyLurkerRow(
                lurkerID: lurker.id,
                detail: LobbyLurkerCopy.detail(for: lurker),
                country: lurker.country,
                client: lurker.client
            )
            row.onRemove = { [weak self] id in self?.removeLurker(lurkerID: id) }
            row.setBusy(lurkerRemovalInFlight.contains(lurker.id))
            lobbyQueueStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: lobbyQueueStack.widthAnchor).isActive = true
        }
        for (index, request) in pendingLobbyRequests.enumerated() {
            let row = LobbyGuestRow(
                requestID: request.id,
                detail: LobbyGuestCopy.detail(for: request, onBehalfOf: pendingRecorderSenders[request.id]),
                client: request.client,
                recording: request.recording == true,
                onBehalfOf: request.onBehalfOf ?? pendingRecorderSenders[request.id],
                people: lobbyPeople
            )
            let isNext = index == 0
            let busy = lobbyDecisionInFlight.contains(request.id)
            row.configure(
                admitTitle: "Admit",
                admitVisible: true,
                admitEnabled: true,
                isNext: isNext,
                busy: busy
            )
            row.onAdmit = { [weak self] id, sender in self?.decideLobbyGuest(requestID: id, admit: true, onBehalfOf: sender) }
            row.onDecline = { [weak self] id in self?.decideLobbyGuest(requestID: id, admit: false) }
            // Add first: activating a constraint between two views with no
            // common ancestor throws NSGenericException.
            lobbyQueueStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: lobbyQueueStack.widthAnchor).isActive = true
        }
        lobbyQueueStack.isHidden = currentRole != .host
    }

    private func markLobbyRowBusy(requestID: String) {
        refreshKnockBanner()
        for case let row as LobbyGuestRow in lobbyQueueStack.arrangedSubviews where row.requestID == requestID {
            row.setBusy(true)
        }
    }

    private func removeLobbyQueueRows() {
        for view in lobbyQueueStack.arrangedSubviews {
            lobbyQueueStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
    }

    private func clearLobbyQueue(keepLabel: Bool = false) {
        defer { refreshSidebarSections() }
        removeLobbyQueueRows()
        lobbyQueueStack.isHidden = true
        lobbySection?.setBadge(nil)
        pendingLobbyRequests = []
        pendingLurkers = []
        lobbyDecisionInFlight = []
        lurkerRemovalInFlight = []
        announcedLobbyRequestIDs = []
        lobbyKnockAnnouncementsPrimed = false
        admitAfterStartRequestID = nil
        pendingRecorderSenders = [:]
        NSApp.dockTile.badgeLabel = nil
        if !keepLabel {
            pendingGuestLabel.stringValue = String(localized: "No one on the page yet.")
        }
    }

    private func startHostHeartbeat() {
        stopHostHeartbeat()
        guard let context = meetingContext, context.role == .host, meetingHoldsHost else { return }
        hostHeartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await self?.controlAPI.heartbeat(context: context)
                    self?.hostLeaseHealthy = true
                    if self?.transcriptionNotice == "LEASE RECONNECTING" {
                        // Back to the line count.
                        self?.setTranscriptionNotice(nil)
                    }
                    self?.renderHostLiveStatus(active: true)
                    if self?.phaseLabel.stringValue == "Lease reconnecting…" {
                        self?.phaseLabel.stringValue = String(localized: "In meeting")
                    }
                } catch {
                    // The UI says "reconnecting" and retries in 10s, so this
                    // stays non-blocking — but it used to leave no trace at all,
                    // which made a lease that never recovered impossible to explain.
                    let failure = StarlingsError.wrapping(error, code: "host.lease_heartbeat", title: String(localized: "Lease reconnecting"))
                    StarlingsDiagnosticsLog.shared.record(failure, context: "host lease heartbeat")
                    self?.hostLeaseHealthy = false
                    self?.setTranscriptionNotice("LEASE RECONNECTING")
                    self?.phaseLabel.stringValue = String(localized: "Lease reconnecting…")
                    self?.renderHostLiveStatus(active: true)
                }
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    private func stopHostHeartbeat() {
        hostHeartbeatTask?.cancel()
        hostHeartbeatTask = nil
    }

    private func renderHostLiveStatus(active: Bool) {
        defer { refreshSidebarSections() }
        guard currentRole == .host, meetingHoldsHost, active, case .connected = meetingSession.phase else {
            hostLiveStatus.isHidden = true
            categoryControls.isHidden = true
            tasksControls.isHidden = true
            categoryLoadTask?.cancel()
            categoryLoadTask = nil
            tasksLoadTask?.cancel()
            tasksLoadTask = nil
            activeTaskSubject = nil
            return
        }
        hostLiveStatus.isHidden = false
        categoryControls.isHidden = false
        // Tasks panel visibility follows whether a lead/project is filed — or
        // whether the meeting has proposed something worth filing.
        tasksControls.isHidden = activeTaskSubject == nil && !tasksControls.hasSuggestions
        if hostLeaseHealthy, wakeAssertion.isActive {
            hostLiveStatus.update(
                state: .allowed,
                detail: wakeAssertion.statusDetail
            )
        } else if !hostLeaseHealthy {
            hostLiveStatus.update(
                state: .denied,
                detail: String(localized: "Lease reconnecting — guests cannot join until heartbeat recovers")
            )
        } else {
            hostLiveStatus.update(
                state: .unknown,
                detail: String(localized: "Wake assertion inactive — Mac sleep may drop admission in ~30s")
            )
        }
    }

    private func loadMeetingCategoryIfNeeded() {
        guard let context = meetingContext, context.role == .host else { return }
        categoryLoadTask?.cancel()
        categoryLoadTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let category = try await controlAPI.meetingCategory(context: context)
                guard !Task.isCancelled else { return }
                categoryControls.apply(category)
                if let subjectKind = category.meetingKind.subjectKind {
                    await refreshCategorySubjects(kind: subjectKind, selecting: category.subjectID)
                }
                updateTasksSubject(from: category)
            } catch {
                categoryControls.setBusy(false, message: StarlingsError.wrapping(error, code: "crm.category", title: String(localized: "Subject")).message)
            }
        }
    }

    private func persistMeetingCategory(kind: MeetingCategoryKind, subject: CrmSubject?) {
        guard let context = meetingContext, context.role == .host else { return }
        if kind.needsSubject, subject == nil {
            activeTaskSubject = nil
            tasksControls.setUnavailable(String(localized: "Pick a \(kind.menuTitle.lowercased()) to see tasks."))
            renderSuggestions()
            Task { @MainActor [weak self] in
                guard let self, let subjectKind = kind.subjectKind else { return }
                await refreshCategorySubjects(kind: subjectKind, selecting: nil)
            }
            return
        }
        categorySaveGeneration += 1
        let generation = categorySaveGeneration
        categoryControls.setBusy(true, message: String(localized: "Saving…"))
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let update = MeetingCategoryUpdate(meetingKind: kind, subjectID: subject?.id, subjectTitle: subject?.title)
                let saved = try await controlAPI.setMeetingCategory(context: context, update: update)
                guard generation == categorySaveGeneration else { return }
                categoryControls.apply(saved)
                categoryControls.setBusy(false)
                updateTasksSubject(from: saved)
            } catch {
                guard generation == categorySaveGeneration else { return }
                categoryControls.setBusy(false, message: StarlingsError.wrapping(error, code: "crm.category", title: String(localized: "Subject")).message)
            }
        }
    }

    private func updateTasksSubject(from category: MeetingCategory) {
        defer { refreshSidebarSections() }
        guard category.meetingKind.needsSubject else {
            activeTaskSubject = nil
            tasksControls.setUnavailable(String(localized: "Tasks appear for leads, projects and partners."))
            renderSuggestions()
            return
        }
        let id = category.subjectID
        guard let id else {
            activeTaskSubject = nil
            tasksControls.setUnavailable(String(localized: "Pick a \(category.meetingKind.menuTitle.lowercased()) to see tasks."))
            tasksControls.isHidden = false
            renderSuggestions()
            return
        }
        activeTaskSubject = (category.meetingKind, id, category.subjectTitle)
        tasksControls.isHidden = false
        renderSuggestions()
        refreshTasks()
    }

    private func refreshTasks() {
        guard let subject = activeTaskSubject else { return }
        tasksLoadTask?.cancel()
        tasksControls.setLoading()
        tasksLoadTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let tasks = try await controlAPI.crmTasks(
                    projectID: subject.kind == .project ? subject.id : nil,
                    leadID: subject.kind == .lead ? subject.id : nil,
                    organizationID: subject.kind == .partner ? subject.id : nil
                )
                guard !Task.isCancelled else { return }
                tasksControls.setTasks(tasks, subjectTitle: subject.title)
                // Work already on the board should not be proposed again —
                // told to the engine, which drops duplicates, and to the model,
                // which then does not spend a proposal on them at all.
                let engine = suggestionEngine
                let cloud = cloudTaskExtractor
                let titles = tasks.map(\.title)
                Task {
                    await engine?.setKnownTaskTitles(titles)
                    await cloud?.setKnownTitles(titles)
                }
            } catch {
                guard !Task.isCancelled else { return }
                let failure = StarlingsError.wrapping(error, code: "crm.tasks", title: String(localized: "Tasks"))
                tasksControls.setUnavailable(failure.message)
            }
        }
    }

    private func presentNewTaskEditor() {
        presentTaskSheet(
            title: String(localized: "New task"),
            initial: .init(
                title: "",
                notes: "",
                status: .pending,
                responsible: .unassigned,
                subject: activeCrmSubject
            )
        ) { [weak self] draft in
            guard let self, let subject = draft.subject, !draft.title.isEmpty else { return }
            Task { @MainActor in
                do {
                    _ = try await self.controlAPI.createCrmTask(CrmTaskCreate(
                        title: draft.title,
                        notes: draft.notes.isEmpty ? nil : draft.notes,
                        status: draft.status.rawValue,
                        responsibleParty: draft.responsible.rawValue,
                        assignedTo: Patch(draft.assignedTo),
                        dueDate: draft.dueDate.map(CrmTaskDate.wire),
                        projectID: subject.kind == "project" ? subject.id : nil,
                        leadID: subject.kind == "lead" ? subject.id : nil,
                        organizationID: subject.kind == "organization" ? subject.id : nil
                    ))
                    self.refreshTasks()
                } catch {
                    let failure = StarlingsError.wrapping(error, code: "crm.task_create", title: String(localized: "Couldn’t create task"))
                    self.tasksControls.setUnavailable(failure.message)
                }
            }
        }
    }

    private func presentEditTaskEditor(_ task: CrmTask) {
        MeetingTaskEditor.present(
            over: view.window,
            title: String(localized: "Edit task"),
            initial: .init(
                title: task.title,
                notes: task.notes ?? "",
                status: task.status,
                responsible: task.responsibleParty
            )
        ) { [weak self] draft in
            guard let self, !draft.title.isEmpty else { return }
            Task { @MainActor in
                do {
                    _ = try await self.controlAPI.updateCrmTask(
                        id: task.id,
                        update: CrmTaskUpdate(
                            title: draft.title,
                            notes: draft.notes.isEmpty ? nil : draft.notes,
                            status: draft.status.rawValue,
                            responsibleParty: draft.responsible.rawValue
                        )
                    )
                    self.refreshTasks()
                } catch {
                    let failure = StarlingsError.wrapping(error, code: "crm.task_update", title: String(localized: "Couldn’t update task"))
                    self.tasksControls.setUnavailable(failure.message)
                }
            }
        }
    }

    private func refreshCategorySubjects(kind: MeetingCategoryKind.SubjectKind, selecting id: String?) async {
        do {
            let subjects = try await controlAPI.crmSubjects(kind: kind, query: "")
            categoryControls.setSubjects(subjects, selecting: id)
        } catch {
            categoryControls.setBusy(false, message: StarlingsError.wrapping(error, code: "crm.category", title: String(localized: "Subject")).message)
        }
    }

    private func startDurationClock() {
        stopDurationClock(clearStartedAt: false)
        if meetingStartedAt == nil {
            meetingStartedAt = Date()
        }
        refreshDurationLabel()
        // One clock drives both readings: how long this meeting has run, and how
        // long until the next one. They are the same question from two ends.
        durationTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                self?.refreshDurationLabel()
                self?.refreshUpcomingCountdowns()
                try? await Task.sleep(for: .seconds(1))
            }
        }
        startNextMeetingWatch()
    }

    private func stopDurationClock(clearStartedAt: Bool = true) {
        durationTask?.cancel()
        durationTask = nil
        stopNextMeetingWatch()
        if clearStartedAt {
            meetingStartedAt = nil
        }
        meetingDurationText = nil
        refreshStageReadout()
    }

    /// The chunk gate means the last thing agreed before a lull would otherwise
    /// wait for speech that never comes. The engine decides whether the room
    /// has actually gone quiet; this only asks, once a second, off the clock
    /// that is already ticking.
    private func flushSuggestionsIfQuiet() {
        guard let engine = suggestionEngine, let meetingID = suggestionEngineMeetingID else { return }
        Task { @MainActor [weak self] in
            let proposed = await engine.flushIfQuiet()
            guard let self, !proposed.isEmpty else { return }
            guard self.suggestionEngineMeetingID == meetingID else { return }
            self.visibleSuggestions.append(contentsOf: proposed)
            for suggestion in proposed {
                self.flaggedTranscriptSegmentIDs.formUnion(suggestion.sourceSegmentIDs)
            }
            self.renderTranscript()
            self.renderSuggestions()
        }
    }

    private func refreshDurationLabel() {
        flushSuggestionsIfQuiet()
        guard let meetingStartedAt else { return }
        meetingDurationText = MeetingDurationFormat.string(
            elapsed: Date().timeIntervalSince(meetingStartedAt)
        )
        refreshStageReadout()
    }

    /// The pill on the stage. Only while a meeting is live: before one there is
    /// nobody to count and no clock to read.
    private func refreshStageReadout() {
        let live = meetingSession.phase == .connected
        meetingStage.setStageReadout(
            participants: live ? participantCountText : nil,
            duration: live ? meetingDurationText : nil
        )
    }

    private var selectedCameraID: String? {
        guard devices.cameras.indices.contains(cameraPopup.indexOfSelectedItem) else { return nil }
        return devices.cameras[cameraPopup.indexOfSelectedItem].id
    }

    private func resetMediaControlState() {
        isMicrophoneEnabled = true
        isCameraEnabled = true
        backgroundEffect = WorkspaceBackgrounds.preferredEffect
        localVideoTrack = nil
        closeSelfViewPiP(userInitiated: false)
        applyScreenShareUI(enabled: false)
        applyMicrophoneControlAppearance()
        applyCameraControlAppearance()
        applyBackgroundEffectAppearance()
        meetingStage.setPrejoinBackgroundEffect(.none)
    }

    /// The one place a `StarlingsError` becomes something a person sees.
    ///
    /// Severity decides the surface: only `.blocking` earns a sheet. Everything
    /// else lands in the status line or the log, which is why a too-long chat
    /// message no longer interrupts a working meeting.
    private func present(_ error: StarlingsError) {
        StarlingsDiagnosticsLog.shared.record(error, context: "error")

        switch error.severity {
        case .silent:
            return
        case .notice:
            sidebarErrorNotice.showError(error)
            return
        case .blocking:
            break
        }

        // Reached from async completions (late LiveKit disconnects, artifact
        // failures) that can land after this view left the window. Without a
        // window there is nowhere to put a sheet — say it in the status line
        // instead of dropping it, which is what this used to do.
        guard let window = frontWindow ?? NSApp.mainWindow else {
            sidebarErrorNotice.showError(error)
            return
        }

        let alert = NSAlert()
        alert.messageText = error.title
        alert.informativeText = error.message
        alert.alertStyle = .warning
        if let recoveryTitle = error.recovery.buttonTitle {
            alert.addButton(withTitle: recoveryTitle)
        }
        alert.addButton(withTitle: error.recovery == .none ? String(localized: "OK") : String(localized: "Not now"))
        let copyResponse = alert.addCopyErrorButton()

        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            switch response {
            case .alertFirstButtonReturn where error.recovery != .none:
                self.applyRecovery(error.recovery)
            case copyResponse:
                StarlingsErrorReport.copy(error)
            default:
                break
            }
        }
    }

    private func applyRecovery(_ recovery: StarlingsError.Recovery) {
        switch recovery {
        case .none:
            break
        case .retry, .rejoin:
            // `toggleMeeting` starts from `.setup`, `.ended` and `.failed`, which
            // is exactly the state a recoverable failure leaves us in.
            toggleMeeting(nil)
        case .signIn:
            beginOwnerSignIn()
        case .update:
            onUpdateAction?()
        case .openCameraSettings:
            SystemSettingsOpener.openPrivacyCamera()
        case .openMicrophoneSettings:
            SystemSettingsOpener.openPrivacyMicrophone()
        case .openScreenRecordingSettings:
            SystemSettingsOpener.openPrivacyScreenRecording()
        }
    }

    private func beginOwnerSignIn() {
        guard let window = frontWindow
            ?? (NSApp.delegate as? AppDelegate)?.mainWindowController?.window
            ?? NSApp.keyWindow else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                let credentials = try await ownerAuthenticator.authenticate(in: window)
                applyOwnerSession(credentials)
                (NSApp.delegate as? AppDelegate)?.mainWindowController?.handleSignedIn(credentials)
            } catch {
                present(StarlingsError.wrapping(error, code: "auth.sign_in_failed", title: String(localized: "Sign-in didn’t finish")))
            }
        }
    }

    /// Non-error confirmations ("Lowered 2 hands") land here: visible, in
    /// place, gone on the next phase change. Never steals focus. Errors go to
    /// `sidebarErrorNotice` instead, so they read red and carry Copy.
    private func showStatusNotice(_ text: String) {
        phaseLabel.stringValue = text
    }

    private func waitingRoomPhaseLabel(count: Int) -> String {
        if count <= 1 {
            return String(localized: "Waiting for the owner — just you in the waiting room")
        }
        return String(localized: "Waiting for the owner — \(count) people in the waiting room")
    }

    /// Idle chrome (Host/Join, identity, upcoming) vs live chrome (participants).
    private func refreshSidebarChrome() {
        let live: Bool
        switch meetingSession.phase {
        case .connecting, .connected:
            live = true
        case .setup, .ended, .failed:
            live = false
        }

        sidebarIntroLabel.isHidden = live
        modeControl.isHidden = live
        identitySection.isHeaderHidden = live
        participantsSection.isHeaderHidden = !live
        participantsStack.isHidden = !live
        // Chat is its own window, so it only follows the meeting's own phase:
        // it goes away when the call does, and nothing else here touches it.
        if !live, chatWindowController.isPanelVisible {
            setChatVisible(false)
        }

        if live {
            accountLabel.isHidden = true
            nameField.isHidden = true
            emailField.isHidden = currentRole == .host
            roomField.isHidden = true
            bookingContextLabel.isHidden = true
            roomActionsStack?.isHidden = true
            // NEXT survives into the meeting: a host running a call still has to
            // know whether the next one is in five minutes or two hours.
            // Scheduling and the day's list do not — those belong to Launch.
            let showsNext = showsNextOnly && upcomingSourcesAvailable
            upcomingSection.isHeaderHidden = !showsNext
            upcomingStack.isHidden = !showsNext
            if showsNext, upcomingRenderMode != .next {
                renderUpcomingEvents(latestUpcomingEvents)
            }
            // `/room/team` has no waiting room: the Worker lets members
            // straight in and answers everybody else 404, so nobody ever
            // knocks. `hostRoomOverride` is the team-room marker from the
            // moment Start is pressed, before `meetingContext` arrives.
            let isTeamRoom = hostRoomOverride?.rawValue == MeetingInvite.internalRoomSlug
            let showLobby = currentRole == .host && !isTeamRoom
            lobbySection.isHeaderHidden = !showLobby
            pendingGuestLabel.isHidden = !showLobby
            if !showLobby {
                lobbyQueueStack.isHidden = true
            }
            renderParticipantsList()
        } else {
            // Idle here now means guest, or a host who has not signed in yet —
            // the signed-in host is on the launch surface. Calendar chrome needs
            // an account, so it stays out of both of those.
            let signedIn = (try? ownerSessionStore.load()) != nil
            let showsCalendar = currentRole == .host && signedIn
            nameField.isHidden = false
            emailField.isHidden = false
            roomField.isHidden = false
            bookingContextLabel.isHidden = currentRole == .host || bookingContextLabel.stringValue.isEmpty
            roomActionsStack?.isHidden = currentRole == .host ? !showsCalendar : false
            scheduleMeetingButton.isHidden = !showsCalendar
            bookTimeButton.isHidden = currentRole == .host || GuestRoomEntry(input: roomField.stringValue)?.bookingToken != nil
            upcomingSection.isHeaderHidden = !showsCalendar
            upcomingStack.isHidden = !showsCalendar
            if showsCalendar, upcomingRenderMode != .list {
                renderUpcomingEvents(latestUpcomingEvents)
            }
            let showLobby = currentRole == .host
            lobbySection.isHeaderHidden = !showLobby
            pendingGuestLabel.isHidden = !showLobby
            if currentRole == .guest {
                lobbyQueueStack.isHidden = true
                hostLiveStatus.isHidden = true
            }
            clearParticipantsList()
            refreshIdentityPresentation()
        }
        refreshSidebarSections()
    }

    private func clearParticipantsList() {
        participantsStack.arrangedSubviews.forEach {
            participantsStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
    }

    private func renderParticipantsList() {
        clearParticipantsList()
        let entries: [MeetingParticipantQuality]
        if participantQuality.isEmpty {
            let fallbackName = nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            entries = [
                MeetingParticipantQuality(
                    id: "local",
                    name: fallbackName.isEmpty ? String(localized: "You") : fallbackName,
                    isLocal: true,
                    quality: .unknown
                ),
            ]
        } else {
            entries = participantQuality
        }

        for entry in entries {
            let row = ParticipantSidebarRow(
                entry: entry,
                isSharing: isSharingScreen(entry),
                handPosition: handPosition(of: entry)
            )
            // Built on the click, not now: what the menu can offer changes with
            // the meeting — someone starts sharing, the role changes.
            row.menuProvider = { [weak self] in self?.participantContextMenu(for: entry) }
            participantsStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: participantsStack.widthAnchor).isActive = true
        }
        refreshSidebarSections()
    }

    /// Where this person sits in the queue, 1-based, or nil if their hand is
    /// down. `raisedHands` is already oldest-first, so the index is the place.
    private func handPosition(of entry: MeetingParticipantQuality) -> Int? {
        // The local row carries a placeholder id rather than the LiveKit
        // identity, so your own hand is matched through the session's own
        // answer instead of by id — the rail must be able to show yours too.
        let index = entry.isLocal
            ? raisedHands.firstIndex(where: \.isLocal)
            : raisedHands.firstIndex { $0.identity == entry.id }
        return index.map { $0 + 1 }
    }

    private func isSharingScreen(_ entry: MeetingParticipantQuality) -> Bool {
        guard !entry.isLocal else { return isScreenShareEnabled }
        return remoteVideoSnapshot.contains { $0.identity == entry.id && $0.isScreenShare }
    }

    /// Right-click on a participant. Everything here is local to this Mac except
    /// Stop screen share, which is the host's one control over what other people
    /// publish and is checked again by the control plane.
    private func participantContextMenu(for entry: MeetingParticipantQuality) -> NSMenu? {
        guard case .connected = meetingSession.phase else { return nil }
        let menu = NSMenu()
        menu.autoenablesItems = false

        let header = NSMenuItem(
            title: [entry.name, entry.quality.label, entry.client?.badge].compactMap { $0 }.joined(separator: " · "),
            action: nil,
            keyEquivalent: ""
        )
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        if entry.isLocal {
            let hide = NSMenuItem(
                title: meetingStage.hidesLocalTile ? String(localized: "Show myself on my stage") : String(localized: "Hide myself from my stage"),
                action: #selector(toggleHideSelf(_:)),
                keyEquivalent: ""
            )
            hide.target = self
            menu.addItem(hide)

            let float = NSMenuItem(
                title: selfViewPiP.isVisible ? String(localized: "Stop floating myself") : String(localized: "Float myself in a window"),
                action: #selector(toggleFloatSelf(_:)),
                keyEquivalent: ""
            )
            float.target = self
            menu.addItem(float)

            let corner = NSMenuItem(
                title: String(localized: "Put myself in the corner"),
                action: #selector(moveSelfViewToCorner(_:)),
                keyEquivalent: ""
            )
            corner.target = self
            corner.isEnabled = !meetingStage.hidesLocalTile && !meetingStage.suppressesLocalTileForPiP
            menu.addItem(corner)

            menu.addItem(
                makeSelfViewSizeItem(
                    enabled: !meetingStage.hidesLocalTile && !meetingStage.suppressesLocalTileForPiP
                )
            )
        } else if currentRole == .host {
            if isSharingScreen(entry) {
                let stop = NSMenuItem(
                    title: String(localized: "Stop screen share"),
                    action: #selector(stopParticipantScreenShare(_:)),
                    keyEquivalent: ""
                )
                stop.target = self
                stop.representedObject = entry.id
                menu.addItem(stop)
            }

            // Offered whether or not they are talking: a microphone left open
            // in another room is exactly the case with nothing on screen to
            // hint at it. There is no Unmute here — see `muteParticipant`.
            let mute = NSMenuItem(
                title: String(localized: "Mute microphone"),
                action: #selector(muteParticipant(_:)),
                keyEquivalent: ""
            )
            mute.target = self
            mute.representedObject = entry.id
            menu.addItem(mute)

            let remove = NSMenuItem(
                title: String(localized: "Remove from meeting…"),
                action: #selector(removeParticipantFromMeeting(_:)),
                keyEquivalent: ""
            )
            remove.target = self
            remove.representedObject = entry
            menu.addItem(remove)
        }

        menu.addItem(.separator())
        let copy = NSMenuItem(title: String(localized: "Copy name"), action: #selector(copyParticipantName(_:)), keyEquivalent: "")
        copy.target = self
        copy.representedObject = entry.name
        menu.addItem(copy)
        return menu
    }

    @objc private func stopParticipantScreenShare(_ sender: NSMenuItem) {
        guard let identity = sender.representedObject as? String else { return }
        stopRemoteScreenShare(identity: identity)
    }

    @objc private func muteParticipant(_ sender: NSMenuItem) {
        guard let identity = sender.representedObject as? String else { return }
        mute(identity: identity)
    }

    /// Host closing somebody's microphone — one person, or with a nil identity
    /// everybody but this Mac.
    ///
    /// Unconfirmed for the same reason stopping a share is: the case for it is
    /// a dog, a doorbell, a forgotten open mic, and a sheet keeps all of that
    /// in the room while somebody reads a button. It is also the mildest thing
    /// on this menu — nothing is unpublished, and the person can unmute.
    private func mute(identity: String?) {
        guard let context = meetingContext, context.role == .host else { return }
        Task {
            do {
                let muted = try await controlAPI.muteParticipant(context: context, identity: identity)
                showStatusNotice(StarlingsRoomRoutes.muteOutcome(muted: muted, everyone: identity == nil))
            } catch {
                present(StarlingsError.wrapping(
                    error,
                    code: "media.mute_failed",
                    title: identity == nil ? String(localized: "Couldn’t mute everyone else") : String(localized: "Couldn’t mute that person"),
                    recovery: .retry
                ))
            }
        }
    }

    /// Host removing somebody from the meeting.
    ///
    /// Confirmed, unlike every other control on this menu, because it is the
    /// one that cannot be taken back from here: it disconnects them and spends
    /// the admission they were let in on, so undoing it means waiting for them
    /// to knock again and admitting them a second time.
    @objc private func removeParticipantFromMeeting(_ sender: NSMenuItem) {
        guard let entry = sender.representedObject as? MeetingParticipantQuality,
              let context = meetingContext, context.role == .host else { return }
        guard let window = view.window ?? NSApp.mainWindow else { return }

        let alert = NSAlert()
        alert.messageText = String(localized: "Remove \(entry.name) from this meeting?")
        alert.informativeText = String(localized: "They are disconnected straight away. To come back they have to ")
            + "ask to join again, and you have to admit them."
        alert.alertStyle = .warning
        alert.addButton(withTitle: String(localized: "Remove"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        alert.buttons.first?.hasDestructiveAction = true
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn else { return }
            Task {
                do {
                    try await self.controlAPI.removeParticipant(context: context, identity: entry.id)
                    self.showStatusNotice(String(localized: "Removed \(entry.name) from the meeting."))
                } catch {
                    self.present(StarlingsError.wrapping(
                        error,
                        code: "media.remove_participant_failed",
                        title: String(localized: "Couldn’t remove \(entry.name)"),
                        recovery: .retry
                    ))
                }
            }
        }
    }

    /// Meeting ▸ Mute Everyone Else. The noisy-room control: it closes every
    /// microphone in the room except this Mac's, and opens none of them.
    @objc func muteEveryoneElse(_ sender: Any?) {
        mute(identity: nil)
    }

    @objc private func copyParticipantName(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(name, forType: .string)
    }

    private func configureControlButton(
        _ button: StarlingsMeetingControlButton,
        symbol: String,
        danger: Bool = false
    ) {
        button.configureMeetingControl(symbol: symbol, danger: danger)
        // Icon-only controls are fixed squares (`setLabelled`), so density math
        // can use that constant instead of measuring an unsettled button.
        controlIconWidths[ObjectIdentifier(button)] = StarlingsMeetingControlButton.height
    }

    private func applyEndMeetingButtonAppearance() {
        endMeetingButton.setMeetControlTitle(meetingMainActionTitle, color: .white)
    }

    /// The chevron next to Mute or Camera: same bezel as the control it rides
    /// with, icon only, and a fixed narrow width so the row's density maths
    /// stays predictable.
    private func configureDeviceChooser(_ button: StarlingsMeetingControlButton, label: String, action: Selector) {
        button.configureMeetingChooser(label: label, target: self, action: action)
    }

    /// A control and its chevron share one shell. The two children remain
    /// separate hit targets, but the outer border and continuous fill make the
    /// pair one compound control instead of two buttons glued together.
    private func deviceControlGroup(_ button: StarlingsMeetingControlButton, chooser: StarlingsMeetingControlButton) -> NSView {
        let group = NSView()
        group.translatesAutoresizingMaskIntoConstraints = false
        group.applyMeetHoverLift(
            base: StarlingsColors.elevated,
            border: StarlingsColors.controlBorder,
            cornerRadius: StarlingsRadius.control(height: StarlingsMeetingControlButton.height),
            amount: StarlingsColors.hoverLift * 1.6
        )

        // The group owns the one outline and the shell-wide hover. The child
        // buttons arrive from `applyMeetControlStyle` with their own border,
        // fill and hover monitor; all of that comes off, or the pair draws
        // three outlines. They keep only their actions and focus rings.
        group.layer?.borderWidth = 1
        group.layer?.borderColor = StarlingsColors.resolved(StarlingsColors.controlBorder, for: group).cgColor
        for segment in [button, chooser] {
            segment.isBordered = false
            segment.bezelStyle = .inline
            segment.bezelColor = .clear
            segment.meetHoverMonitor?.invalidate()
            segment.layer?.borderWidth = 0
            segment.layer?.backgroundColor = NSColor.clear.cgColor
        }
        // The chevron is the only segment with its own hover: a faint well on
        // top of the shell's lift, clipped to the shell's trailing corners.
        chooser.applyMeetHoverLift(base: .clear, cornerRadius: StarlingsRadius.control(height: StarlingsMeetingControlButton.height))
        chooser.layer?.maskedCorners = [.layerMaxXMinYCorner, .layerMaxXMaxYCorner]
        // The word and glyph centre on the whole shell, chevron included.
        button.companionWidth = StarlingsMeetingControlButton.chooserWidth + Self.deviceSeparatorWidth

        let separator = NSView()
        separator.wantsLayer = true
        separator.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.controlBorder, for: separator).cgColor
        separator.onMeetAppearanceChange { view in
            view.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.controlBorder, for: view).cgColor
        }
        separator.widthAnchor.constraint(equalToConstant: Self.deviceSeparatorWidth).isActive = true
        separator.heightAnchor.constraint(equalToConstant: 36).isActive = true

        let stack = NSStackView(views: [button, separator, chooser])
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false
        group.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: group.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: group.trailingAnchor),
            stack.topAnchor.constraint(equalTo: group.topAnchor),
            stack.bottomAnchor.constraint(equalTo: group.bottomAnchor),
            group.heightAnchor.constraint(equalToConstant: StarlingsMeetingControlButton.height),
        ])
        return group
    }

    /// Gives out labels in priority order for as long as the row's width lasts,
    /// and draws the rest as icons. Titles are never taken away — tooltips,
    /// VoiceOver and the Meeting menu still read them — so a narrow window costs
    /// labels rather than controls, and a wide one gets all ten back.
    private func applyControlBarDensity() {
        guard let controlsRow else { return }
        let available = controlsRow.bounds.width
        guard available > 1 else { return }

        let visible = controlBarButtons.filter { !$0.isHidden }
        guard !visible.isEmpty else { return }
        let icons = visible.reduce(CGFloat.zero) { $0 + iconWidth(of: $1) }
            + CGFloat(visible.count - 1) * Self.controlBarSpacing
        // The two chevrons never take a label, so they are not in
        // `controlBarButtons` — but they do take width the labels cannot have.
        let choosers = 2 * (StarlingsMeetingControlButton.chooserWidth + Self.deviceChooserGap)
        var budget = available - icons - choosers - Self.controlBarSlack

        var labelled: Set<ObjectIdentifier> = []
        for button in controlBarLabelPriority where !button.isHidden {
            // A label costs only what it grows the square by — a short word
            // ("You", "Hand") fits inside the 68pt already reserved and is free.
            // Same formula `setLabelled` draws with, so the budget never says
            // no to a label the row had room for.
            let cost = button.labelledWidth - iconWidth(of: button)
            guard cost <= budget else { continue }
            budget -= cost
            labelled.insert(ObjectIdentifier(button))
        }

        let spacing = labelled.isEmpty ? Self.controlBarTightSpacing : Self.controlBarSpacing
        if mediaControlsRow.spacing != spacing {
            mediaControlsRow.spacing = spacing
            controlsRow.spacing = spacing
        }

        for button in controlBarButtons {
            // `setLabelled` no-ops on a repeat call, so this runs safely from
            // `viewDidLayout` every pass without thrashing the button's size.
            button.setLabelled(labelled.contains(ObjectIdentifier(button)))
            // An icon-only button draws no title, and these titles are state
            // ("Unmute", "Stop sharing"), so it has to be restated as it changes.
            button.setAccessibilityLabel(button.title)
        }
    }

    /// Whether the meeting wants a readout on the transcript header at all.
    /// Everything that used to set `isHidden` on one of these goes through
    /// here, so width can hide a readout without state later un-hiding it.
    private func setTranscriptHeaderReadout(_ view: NSView, visible: Bool) {
        let id = ObjectIdentifier(view)
        if visible {
            transcriptHeaderReadoutsWanted.insert(id)
        } else {
            transcriptHeaderReadoutsWanted.remove(id)
        }
        view.isHidden = !visible
        applyTranscriptHeaderDensity()
    }

    /// Both widths of the heading, taken once before it is on screen — the same
    /// trick `configureControlButton` uses, and for the same reason: density
    /// runs on every layout pass and must not have to touch a control to ask.
    private func measureTranscriptDisclosure() {
        let position = transcriptDisclosure.imagePosition
        transcriptDisclosure.imagePosition = .imageLeading
        transcriptDisclosureWideWidth = transcriptDisclosure.fittingSize.width
        transcriptDisclosure.imagePosition = .imageOnly
        transcriptDisclosureIconWidth = transcriptDisclosure.fittingSize.width
        transcriptDisclosure.imagePosition = position
    }

    /// Same bargain as the control row, one line down. What does not fit leaves
    /// the row from the right — status, bandwidth, connection, duration, count
    /// — and the heading is the last thing standing, dropping its own title to
    /// a bare chevron rather than being squeezed. Nothing here is ever squeezed:
    /// a readout with no room is off the row, not two pixels wide.
    private func applyTranscriptHeaderDensity() {
        guard let transcriptHeaderRow else { return }
        let available = transcriptHeaderRow.bounds.width
        guard available > 1 else { return }

        let titled = available >= transcriptDisclosureWideWidth + Self.transcriptHeaderTailRoom
        let position: NSControl.ImagePosition = titled ? .imageLeading : .imageOnly
        // Only on a real change: assigning the same value still invalidates the
        // button's intrinsic size, and this runs from `viewDidLayout`.
        if transcriptDisclosure.imagePosition != position {
            transcriptDisclosure.imagePosition = position
        }
        transcriptDisclosure.setAccessibilityLabel(transcriptDisclosure.title)
        var budget = available
            - (titled ? transcriptDisclosureWideWidth : transcriptDisclosureIconWidth)

        for readout in transcriptHeaderShedOrder {
            guard transcriptHeaderReadoutsWanted.contains(ObjectIdentifier(readout)) else {
                readout.isHidden = true
                continue
            }
            let cost = readout.fittingSize.width + Self.transcriptHeaderSpacing
            let fits = cost <= budget
            if fits {
                budget -= cost
            }
            if readout.isHidden == fits {
                readout.isHidden = !fits
            }
        }
    }

    private func iconWidth(of button: NSButton) -> CGFloat {
        controlIconWidths[ObjectIdentifier(button)] ?? button.fittingSize.width
    }

}

/// What puts `validateMenuItem(_:)` in front of the menu bar at all.
///
/// Without the conformance the method is invisible to AppKit — Swift only
/// exposes a member to the runtime when something asks it to — so validation
/// fell back to "does the target respond to this action", and every dynamic
/// title in there (Mute/Unmute, Start/End Meeting) never ran.
extension MeetingViewController: NSMenuItemValidation {}

/// What enables and disables the toolbar's inspector button.
///
/// `validateMenuItem(_:)` above already gates the View menu's "Right Sidebar"
/// entry and the Meeting menu's ⌥⌘S entry on `meetingSession.phase ==
/// .connected`, but a toolbar item is not an `NSMenuItem` — AppKit validates it
/// through this protocol instead. Same rule, so the toolbar button, the two
/// menu items, and both shortcuts never disagree about whether the rail can be
/// toggled right now.
extension MeetingViewController: NSUserInterfaceValidations {
    func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        switch item.action {
        case #selector(toggleMeetingPanel(_:)), #selector(toggleInspector(_:)):
            return meetingSession.phase == .connected
        default:
            return true
        }
    }
}

extension MeetingViewController: NSMenuDelegate {
    /// Rebuilt on every open so a device plugged in mid-call shows up without
    /// any refresh plumbing.
    func menuNeedsUpdate(_ menu: NSMenu) {
        switch menu {
        case microphoneMenu:
            // The mute chevron is where a headset gets picked, and a headset
            // is a microphone and a speaker at once — so both live here,
            // instead of the speaker hiding in the menubar.
            menu.removeAllItems()
            menu.autoenablesItems = false
            appendDeviceSection(
                to: menu,
                title: String(localized: "Microphone"),
                symbolName: "mic.fill",
                available: devices.microphones,
                selectedID: selectedMicrophoneID,
                action: #selector(microphoneSelectedFromMenu(_:))
            )
            menu.addItem(.separator())
            appendDeviceSection(
                to: menu,
                title: String(localized: "Speaker"),
                symbolName: "speaker.wave.2.fill",
                available: devices.speakers,
                selectedID: selectedSpeakerID,
                action: #selector(speakerSelectedFromMenu(_:))
            )
        case cameraMenu:
            populateDeviceMenu(
                menu,
                title: String(localized: "Camera"),
                symbolName: "video.fill",
                available: devices.cameras,
                selectedID: selectedCameraID,
                action: #selector(cameraSelectedFromMenu(_:))
            )
        default:
            return
        }
    }

    func populateMainMenuDeviceSubmenu(_ menu: NSMenu, kind: MeetingDeviceMenuController.Kind) {
        switch kind {
        case .microphone:
            populateDeviceMenu(
                menu,
                title: String(localized: "Microphone"),
                symbolName: "mic.fill",
                available: devices.microphones,
                selectedID: selectedMicrophoneID,
                action: #selector(microphoneSelectedFromMenu(_:))
            )
        case .camera:
            populateDeviceMenu(
                menu,
                title: String(localized: "Camera"),
                symbolName: "video.fill",
                available: devices.cameras,
                selectedID: selectedCameraID,
                action: #selector(cameraSelectedFromMenu(_:))
            )
        case .speaker:
            populateDeviceMenu(
                menu,
                title: String(localized: "Speaker"),
                symbolName: "speaker.wave.2.fill",
                available: devices.speakers,
                selectedID: selectedSpeakerID,
                action: #selector(speakerSelectedFromMenu(_:))
            )
        }
    }

    private func populateDeviceMenu(
        _ menu: NSMenu,
        title: String,
        symbolName: String,
        available: [MediaDevice],
        selectedID: String?,
        action: Selector
    ) {
        menu.removeAllItems()
        menu.autoenablesItems = false
        appendDeviceSection(
            to: menu,
            title: title,
            symbolName: symbolName,
            available: available,
            selectedID: selectedID,
            action: action
        )
    }

    /// One titled run of devices — header, then the list or "No devices" —
    /// so a menu can stack a microphone section over a speaker one.
    private func appendDeviceSection(
        to menu: NSMenu,
        title: String,
        symbolName: String,
        available: [MediaDevice],
        selectedID: String?,
        action: Selector
    ) {
        let header = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)

        guard !available.isEmpty else {
            let empty = NSMenuItem(title: String(localized: "No devices available"), action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
            return
        }

        for item in deviceMenuItems(
            for: available,
            symbolName: symbolName,
            selectedID: selectedID,
            action: action
        ) {
            menu.addItem(item)
        }
    }
}

extension MeetingViewController {
    func handleCLI(_ request: StarlingsCLIRequest) async -> StarlingsCLIResponse {
        do {
            let output = try await performCLICommand(request)
            return .success(
                for: request,
                message: output.message,
                state: cliState(),
                output: output.output
            )
        } catch let error as StarlingsCLICommandError {
            return .failure(for: request, code: error.code, message: error.localizedDescription, state: cliState())
        } catch let error as StarlingsError {
            // The Worker's code and its own sentence, not the type's name.
            return .failure(for: request, code: error.serverCode ?? error.code, message: error.message, state: cliState())
        } catch {
            return .failure(for: request, code: "command_failed", message: error.localizedDescription, state: cliState())
        }
    }

    private func performCLICommand(_ request: StarlingsCLIRequest) async throws -> CLICommandOutput {
        switch request.command {
        case "status", "devices":
            return CLICommandOutput(message: String(localized: "Starlings state returned."))
        case "show":
            if let main = (NSApp.delegate as? AppDelegate)?.mainWindowController {
                if (try? ownerSessionStore.load()) != nil {
                    main.showMeeting(asGuest: false)
                }
                main.showWindow(nil)
            } else {
                view.window?.makeKeyAndOrderFront(nil)
            }
            NSApp.activate(ignoringOtherApps: true)
            return CLICommandOutput(message: String(localized: "Starlings is visible."))
        case "auth":
            if let credentials = try ownerSessionStore.load() {
                applyOwnerSession(credentials)
                (NSApp.delegate as? AppDelegate)?.mainWindowController?.showMeeting(asGuest: false)
                return CLICommandOutput(message: String(localized: "Already signed in as \(credentials.owner.email)."))
            }
            guard let window = frontWindow
                ?? (NSApp.delegate as? AppDelegate)?.mainWindowController?.window
                ?? NSApp.keyWindow else {
                throw StarlingsCLICommandError.windowUnavailable
            }
            let credentials = try await ownerAuthenticator.authenticate(in: window)
            applyOwnerSession(credentials)
            (NSApp.delegate as? AppDelegate)?.mainWindowController?.handleSignedIn(credentials)
            return CLICommandOutput(message: String(localized: "Signed in as \(credentials.owner.email)."))
        case "host":
            try ensureIdle()
            (NSApp.delegate as? AppDelegate)?.mainWindowController?.showMeeting(asGuest: false)
            if let credentials = try ownerSessionStore.load() {
                applyOwnerSession(credentials)
            } else if let name = request.arguments["name"], let email = request.arguments["email"] {
                // Debug builds can exchange this validated identity at /dev/session.
                // Release builds still reject hosting until real Google auth exists.
                nameField.stringValue = name
                emailField.stringValue = email
            } else {
                throw StarlingsCLICommandError.authenticationRequired
            }
            applyRole(.host)
            try applyRoom(request.arguments["room"])
            try applyRequestedDevices(request.arguments)
            let configuration = try cliConfiguration()
            meetingContext = nil
            await meetingStage.prepareForConnection(localName: configuration.identity.name)
            try? await meetingSession.setBackgroundEffect(backgroundEffect)
            loadKnownNamesForTranscript()
            await meetingSession.connect(configuration: configuration, entry: .host)
            if case .failed(let error) = meetingSession.phase {
                throw StarlingsCLICommandError.operationFailed(error.logLine)
            }
            return CLICommandOutput(message: String(localized: "Host room \(configuration.room.rawValue) is \(cliPhaseName())."))
        case "join":
            try ensureIdle()
            (NSApp.delegate as? AppDelegate)?.mainWindowController?.showMeeting(asGuest: true)
            guard let name = request.arguments["name"], !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw StarlingsCLICommandError.missingArgument("name")
            }
            applyRole(.guest)
            nameField.stringValue = name
            emailField.stringValue = request.arguments["email"] ?? ""
            try applyRoom(request.arguments["room"])
            try applyRequestedDevices(request.arguments)
            let configuration = try cliConfiguration()
            meetingContext = nil
            await meetingStage.prepareForConnection(localName: configuration.identity.name)
            beginGuestAdmission(configuration: configuration)
            return CLICommandOutput(message: String(localized: "Admission requested for room \(configuration.room.rawValue)."))
        case "leave":
            if let guestAdmissionTask {
                guestAdmissionTask.cancel()
                self.guestAdmissionTask = nil
                phaseLabel.stringValue = String(localized: "Join cancelled")
                phaseOrb.isHidden = true
                startButton.applyMeetFilledStyle(.accent, title: String(localized: "Ask to join"), symbolName: "video.fill")
                startButton.isEnabled = true
                modeControl.isEnabled = true
                return CLICommandOutput(message: String(localized: "Admission request cancelled."))
            }
            guard meetingSession.phase == .connected || meetingSession.phase == .connecting else {
                return CLICommandOutput(message: String(localized: "Starlings is already idle."))
            }
            let context = meetingContext
            if context?.role == .guest {
                guestPresenceSuppressed = true
                stopGuestPresence()
            }
            await meetingSession.disconnect()
            if let context, context.role == .host {
                await requestFinalization(context: context)
            }
            return CLICommandOutput(message: String(localized: "Meeting left cleanly."))
        case "lobby":
            guard let context = meetingContext, context.role == .host else {
                throw StarlingsCLICommandError.hostMeetingRequired
            }
            let snapshot = try await controlAPI.lobby(room: context.room)
            let waiting = snapshot.requests
                .filter { $0.status == .waiting }
                .sorted { $0.createdAt < $1.createdAt }
            let lurkers = snapshot.lurkers
            applyHostLobbyWaiting(waiting, lurkers: lurkers, prelive: false)
            renderLobbyQueue()
            let lurkerNote = lurkers.isEmpty ? "" : String(localized: " · \(lurkers.count) on the page")
            return CLICommandOutput(
                message: "\(waiting.count) guest\(waiting.count == 1 ? "" : "s") waiting\(lurkerNote).",
                output: StarlingsCLIOutput(
                    transcript: nil,
                    waitingGuests: waiting.map(cliWaitingGuest)
                )
            )
        case "admit", "reject":
            guard let context = meetingContext, context.role == .host else {
                throw StarlingsCLICommandError.hostMeetingRequired
            }
            let snapshot = try await controlAPI.lobby(room: context.room)
            let waiting = snapshot.requests.filter { $0.status == .waiting }
            let requestedID = request.arguments["request_id"]
            guard let target = requestedID.flatMap({ id in waiting.first(where: { $0.id == id }) }) ?? waiting.first else {
                throw StarlingsCLICommandError.waitingGuestNotFound
            }
            let admit = request.command == "admit"
            try await controlAPI.decide(room: context.room, requestID: target.id, admit: admit)
            await refreshLobbyOnce()
            return CLICommandOutput(message: "\(admit ? String(localized: "Admitted") : String(localized: "Rejected")) \(target.name).")
        case "microphone", "camera", "blur", "block", "screen-share":
            try await setCLIControl(request.command, requested: request.arguments["state"] ?? "toggle")
            return CLICommandOutput(message: String(localized: "\(request.command) updated."))
        case "select-camera":
            try ensureIdle()
            try selectCLIDevice(id: request.arguments["id"], kind: .camera)
            return CLICommandOutput(message: String(localized: "Camera selected."))
        case "select-microphone":
            try ensureIdle()
            try selectCLIDevice(id: request.arguments["id"], kind: .microphone)
            return CLICommandOutput(message: String(localized: "Microphone selected."))
        case "select-speaker":
            try selectCLIDevice(id: request.arguments["id"], kind: .speaker)
            return CLICommandOutput(message: String(localized: "Speaker selected."))
        case "plan":
            let plan = try await controlAPI.workspacePlan()
            return CLICommandOutput(message: cliPlanSummary(plan))
        case "plan-set":
            guard let value = request.arguments["plan"], !value.isEmpty else {
                throw StarlingsCLICommandError.missingArgument("plan")
            }
            let plan = try await controlAPI.setWorkspacePlan(WorkspacePlanUpdateRequestPlan(rawValue: value))
            return CLICommandOutput(message: cliPlanSummary(plan))
        case "plan-keep":
            guard let id = request.arguments["project_id"], !id.isEmpty else {
                throw StarlingsCLICommandError.missingArgument("project_id")
            }
            let plan = try await controlAPI.keepWorkspaceProject(id: id)
            return CLICommandOutput(message: cliPlanSummary(plan))
        case "transcript":
            return CLICommandOutput(
                message: String(localized: "Current live transcript returned."),
                output: StarlingsCLIOutput(transcript: transcriptText.string, waitingGuests: nil)
            )
        default:
            throw StarlingsCLICommandError.unknownCommand(request.command)
        }
    }

    /// The plan as the starlings CLI prints it: the wire value, so `plan set` takes back what `plan` printed.
    private func cliPlanSummary(_ plan: WorkspacePlanResponse) -> String {
        var parts = [String(localized: "Plan: \(plan.plan.rawValue).")]
        if let limit = plan.projectLimit { parts.append(String(localized: "Project limit: \(limit).")) }
        if let kept = plan.keptProjectID { parts.append(String(localized: "Kept project: \(kept).")) }
        return parts.joined(separator: " ")
    }

    private func cliState() -> StarlingsCLIState {
        let credentials = try? ownerSessionStore.load()
        let waiting = pendingLobbyRequests.map(cliWaitingGuest)
        return StarlingsCLIState(
            phase: cliPhaseName(),
            role: currentRole.rawValue,
            room: RoomSlug(rawValue: roomField.stringValue)?.rawValue ?? roomField.stringValue,
            meetingID: meetingContext?.meetingID,
            status: cliStatusDescription(),
            identity: StarlingsCLIIdentityState(
                name: nameField.stringValue,
                email: emailField.stringValue
            ),
            authenticatedOwnerEmail: credentials?.owner.email,
            participantCount: participantCount,
            cameraPermission: cliPermissionName(devices.cameraPermission),
            microphonePermission: cliPermissionName(devices.microphonePermission),
            media: StarlingsCLIMediaState(
                microphoneEnabled: isMicrophoneEnabled,
                cameraEnabled: isCameraEnabled,
                screenShareEnabled: isScreenShareEnabled,
                backgroundBlurEnabled: {
                    switch backgroundEffect {
                    case .blur, .generated, .customImage, .workspaceImage: true
                    case .none: false
                    }
                }(),
                selectedCameraID: selectedCameraID,
                selectedMicrophoneID: selectedMicrophoneID,
                selectedSpeakerID: selectedSpeakerID
            ),
            cameras: devices.cameras.map { device in
                StarlingsCLIDeviceState(id: device.id, name: device.name, selected: device.id == selectedCameraID)
            },
            microphones: devices.microphones.map { device in
                StarlingsCLIDeviceState(id: device.id, name: device.name, selected: device.id == selectedMicrophoneID)
            },
            speakers: devices.speakers.map { device in
                StarlingsCLIDeviceState(id: device.id, name: device.name, selected: device.id == selectedSpeakerID)
            },
            waitingGuest: waiting.first,
            waitingGuests: waiting,
            hostAppliance: StarlingsCLIHostApplianceState(
                wakeAssertionActive: wakeAssertion.isActive,
                leaseHealthy: hostLeaseHealthy,
                detail: cliHostApplianceDetail()
            )
        )
    }

    private func cliHostApplianceDetail() -> String {
        guard currentRole == .host, case .connected = meetingSession.phase else {
            return String(localized: "Host appliance idle")
        }
        if hostLeaseHealthy, wakeAssertion.isActive {
            return wakeAssertion.statusDetail
        }
        if !hostLeaseHealthy {
            return String(localized: "Lease reconnecting")
        }
        return String(localized: "Wake assertion inactive")
    }

    private func cliWaitingGuest(_ request: LobbyRequestResponse) -> StarlingsCLIWaitingGuestState {
        StarlingsCLIWaitingGuestState(
            id: request.id,
            name: request.name,
            email: request.email,
        )
    }

    private func cliPermissionName(_ permission: PermissionState) -> String {
        switch permission {
        case .unknown: "not_determined"
        case .allowed: "authorized"
        case .denied: "denied"
        case .restricted: "restricted"
        }
    }

    private func cliPhaseName() -> String {
        switch meetingSession.phase {
        case .setup: "setup"
        case .connecting: "connecting"
        case .connected: "connected"
        case .ended: "ended"
        case .failed: "failed"
        }
    }

    private func cliStatusDescription() -> String {
        if case .failed(let error) = meetingSession.phase {
            return error.logLine
        }
        return phaseLabel.stringValue
    }

    private var selectedMicrophoneID: String? {
        guard devices.microphones.indices.contains(microphonePopup.indexOfSelectedItem) else { return nil }
        return devices.microphones[microphonePopup.indexOfSelectedItem].id
    }

    private var selectedSpeakerID: String? {
        guard devices.speakers.indices.contains(speakerPopup.indexOfSelectedItem) else { return nil }
        return devices.speakers[speakerPopup.indexOfSelectedItem].id
    }

    private func applyRole(_ role: MeetingRole) {
        currentRole = role
        modeControl.selectedSegment = role == .host ? 0 : 1
        meetingModeChanged()
        notifyMenubarStateChange()
    }

    func menubarSnapshot() -> MeetingMenubarSnapshot {
        let signedIn = (try? ownerSessionStore.load()) != nil
        let hosting = currentRole == .host
        // The waiting queue is about *your* door, which is now watched from
        // wherever you are standing — including from inside somebody else's
        // room. Hiding it there left the Dock badge counting people the menu
        // bar claimed were not present. The launch-surface state below stays
        // host-only, because that is genuinely about the surface.
        return MeetingMenubarSnapshot(
            isOwnerSignedIn: signedIn,
            isHost: hosting,
            phase: meetingSession.phase,
            roomLink: roomLinkRow.clipboardString,
            upcoming: signedIn && hosting ? latestMenubarUpcomingEvents : [],
            upcomingSummary: MeetingFocus.closedDaySummary(latestUpcomingPlan),
            waitingGuests: signedIn ? pendingLobbyRequests.map {
                MeetingMenubarWaitingGuest(
                    id: $0.id,
                    name: $0.name.isEmpty ? String(localized: "Guest") : $0.name,
                    hasBooking: $0.bookingToken?.isEmpty == false
                )
            } : [],
            lurkerCount: signedIn ? pendingLurkers.count : 0,
            participantCount: participantCount,
            calendarConnected: upcomingSourcesAvailable,
            roomIsOpen: signedIn && hosting && reclaimableMeetingID != nil
        )
    }

    private func notifyMenubarStateChange() {
        onMenubarStateChange?(menubarSnapshot())
    }

    private func applyRoom(_ value: String?) throws {
        if let value {
            guard let room = RoomSlug(rawValue: value) else { throw StarlingsCLICommandError.invalidRoom }
            roomField.stringValue = room.rawValue
            setDisplayedRoom(room)
        }
    }

    private func applyRequestedDevices(_ arguments: [String: String]) throws {
        if let camera = arguments["camera_id"] {
            try selectCLIDevice(id: camera, kind: .camera)
        }
        if let microphone = arguments["microphone_id"] {
            try selectCLIDevice(id: microphone, kind: .microphone)
        }
        if let speaker = arguments["speaker_id"] {
            try selectCLIDevice(id: speaker, kind: .speaker)
        }
    }

    private func selectCLIDevice(id: String?, kind: MediaDevice.Kind) throws {
        guard let id, !id.isEmpty else { throw StarlingsCLICommandError.missingArgument("id") }
        switch kind {
        case .camera:
            guard let index = devices.cameras.firstIndex(where: { $0.id == id }) else {
                throw StarlingsCLICommandError.deviceNotFound(id)
            }
            cameraPopup.selectItem(at: index)
            MediaDevicePreferences.preferredCameraID = id
            showIdleCamera(deviceID: id)
        case .microphone:
            guard let index = devices.microphones.firstIndex(where: { $0.id == id }) else {
                throw StarlingsCLICommandError.deviceNotFound(id)
            }
            microphonePopup.selectItem(at: index)
            MediaDevicePreferences.preferredMicrophoneID = id
            MediaDevicePreferences.applyMicrophoneSelection(id: id)
        case .speaker:
            guard let index = devices.speakers.firstIndex(where: { $0.id == id }) else {
                throw StarlingsCLICommandError.deviceNotFound(id)
            }
            speakerPopup.selectItem(at: index)
            selectSpeaker(id: id)
        }
    }

    private func cliConfiguration() throws -> MeetingConfiguration {
        let identity = MeetingIdentity(
            name: nameField.stringValue,
            email: emailField.stringValue
        )
        if currentRole == .host, !identity.hostIdentity.isValid {
            throw StarlingsCLICommandError.invalidIdentity("A host needs a member email address.")
        }
        if currentRole == .guest, !identity.isValidGuest {
            throw StarlingsCLICommandError.invalidIdentity("A guest needs a name and a valid email address.")
        }
        guard let room = RoomSlug(rawValue: roomField.stringValue) else { throw StarlingsCLICommandError.invalidRoom }
        guard let cameraID = selectedCameraID, let microphoneID = selectedMicrophoneID else {
            throw StarlingsCLICommandError.devicesNotReady
        }
        return MeetingConfiguration(
            identity: identity,
            role: currentRole,
            room: room,
            cameraID: cameraID,
            microphoneID: microphoneID,
            speakerID: selectedSpeakerID,
            cameraEnabled: isCameraEnabled,
            microphoneEnabled: isMicrophoneEnabled
        )
    }

    private func ensureIdle() throws {
        guard meetingSession.phase != .connected, meetingSession.phase != .connecting, guestAdmissionTask == nil else {
            throw StarlingsCLICommandError.meetingAlreadyActive
        }
    }

    private func setCLIControl(_ control: String, requested: String) async throws {
        guard meetingSession.phase == .connected else { throw StarlingsCLICommandError.connectedMeetingRequired }
        switch control {
        case "microphone":
            let enabled = try cliRequestedState(requested, current: isMicrophoneEnabled)
            try await meetingSession.setMicrophone(enabled: enabled)
            isMicrophoneEnabled = enabled
            applyMicrophoneControlAppearance()
        case "camera":
            let enabled = try cliRequestedState(requested, current: isCameraEnabled)
            try await meetingSession.setCamera(enabled: enabled)
            isCameraEnabled = enabled
            applyCameraControlAppearance()
            applyBackgroundEffectAppearance()
            updateBackgroundButtonsEnabled()
            if enabled, backgroundEffect != .none {
                try await meetingSession.setBackgroundEffect(backgroundEffect)
            }
        case "blur", "block":
            guard isCameraEnabled else {
                throw StarlingsCLICommandError.operationFailed("Turn the camera on before changing the background.")
            }
            let next: MeetingBackgroundEffect
            if control == "blur" {
                let enabled = try cliRequestedState(requested, current: {
                    if case .blur = backgroundEffect { return true }
                    return false
                }())
                next = enabled ? .blur : .none
            } else {
                let current: BackgroundChoice? = {
                    if case .generated(let choice) = backgroundEffect { return choice }
                    return nil
                }()
                // `night`, `lime` and `ice` keep working, and so do the tone names.
                switch requested.lowercased() {
                case "toggle":
                    if let current {
                        next = current.next.map { MeetingBackgroundEffect.generated($0) } ?? MeetingBackgroundEffect.none
                    } else {
                        next = .generated(.first)
                    }
                case "on", "true", "1":
                    next = .generated(.first)
                case "off", "false", "0":
                    next = .none
                default:
                    guard let choice = BackgroundChoice(plate: requested) else {
                        throw StarlingsCLICommandError.invalidState(requested)
                    }
                    next = .generated(choice)
                }
            }
            backgroundEffect = next
            WorkspaceBackgrounds.remember(next)
            applyBackgroundEffectAppearance()
            meetingStage.setPrejoinBackgroundEffect(next)
            if meetingSession.phase == .connected {
                try await meetingSession.setBackgroundEffect(next)
            }
        case "screen-share":
            let enabled = try cliRequestedState(requested, current: isScreenShareEnabled)
            try await meetingSession.setScreenShare(enabled: enabled)
            applyScreenShareUI(enabled: enabled)
        default:
            throw StarlingsCLICommandError.unknownCommand(control)
        }
    }

    private func cliRequestedState(_ requested: String, current: Bool) throws -> Bool {
        switch requested.lowercased() {
        case "on", "true", "1": true
        case "off", "false", "0": false
        case "toggle": !current
        default: throw StarlingsCLICommandError.invalidState(requested)
        }
    }

    private func cliBoolean(_ value: String?, default defaultValue: Bool) -> Bool {
        guard let value else { return defaultValue }
        return ["true", "1", "yes", "on"].contains(value.lowercased())
    }
}

private struct CLICommandOutput {
    let message: String
    let output: StarlingsCLIOutput?

    init(message: String, output: StarlingsCLIOutput? = nil) {
        self.message = message
        self.output = output
    }
}

private enum StarlingsCLICommandError: LocalizedError {
    case unknownCommand(String)
    case missingArgument(String)
    case authenticationRequired
    case windowUnavailable
    case invalidRoom
    case invalidIdentity(String)
    case devicesNotReady
    case deviceNotFound(String)
    case meetingAlreadyActive
    case connectedMeetingRequired
    case hostMeetingRequired
    case waitingGuestNotFound
    case invalidState(String)
    case operationFailed(String)

    var code: String {
        switch self {
        case .unknownCommand: "unknown_command"
        case .missingArgument: "missing_argument"
        case .authenticationRequired: "authentication_required"
        case .windowUnavailable: "window_unavailable"
        case .invalidRoom: "invalid_room"
        case .invalidIdentity: "invalid_identity"
        case .devicesNotReady: "devices_not_ready"
        case .deviceNotFound: "device_not_found"
        case .meetingAlreadyActive: "meeting_already_active"
        case .connectedMeetingRequired: "connected_meeting_required"
        case .hostMeetingRequired: "host_meeting_required"
        case .waitingGuestNotFound: "waiting_guest_not_found"
        case .invalidState: "invalid_state"
        case .operationFailed: "operation_failed"
        }
    }

    var errorDescription: String? {
        switch self {
        case .unknownCommand(let command): String(localized: "Unknown Starlings command: \(command).")
        case .missingArgument(let name): "The --\(name.replacingOccurrences(of: "_", with: "-")) argument is required."
        case .authenticationRequired: String(localized: "Sign in before hosting or managing rooms.")
        case .windowUnavailable: String(localized: "The Starlings window is unavailable for interactive Google sign-in.")
        case .invalidRoom: GuestEntryWords.roomInvalid
        case .invalidIdentity(let message): message
        case .devicesNotReady: String(localized: "Camera and microphone permissions or devices are not ready yet.")
        case .deviceNotFound(let id): String(localized: "No media device has ID \(id).")
        case .meetingAlreadyActive: String(localized: "Leave or cancel the current meeting before starting another.")
        case .connectedMeetingRequired: String(localized: "This command requires a connected meeting.")
        case .hostMeetingRequired: String(localized: "This command requires an active hosted meeting.")
        case .waitingGuestNotFound: String(localized: "No matching guest is waiting for admission.")
        case .invalidState(let state): String(localized: "State must be on, off, or toggle, not \(state).")
        case .operationFailed(let message): message
        }
    }
}

private enum GuestAdmissionError: LocalizedError {
    case rejected

    var errorDescription: String? {
        "The room owner declined this request or the meeting ended."
    }
}

@MainActor
private final class ParticipantSidebarRow: NSView {
    /// Built fresh on each right-click, so the menu describes the meeting as it
    /// is now rather than as it was when the row was drawn.
    var menuProvider: (() -> NSMenu?)?

    /// `handPosition` is 1-based place in the queue, or nil for a hand that is
    /// down. A number rather than a flag because the rail is the one surface
    /// with room to say *when* somebody asked, and that is the thing the host
    /// needs when three hands are up at once — the stage badge can only ever
    /// say "this person is waiting".
    init(
        entry: MeetingParticipantQuality,
        isSharing: Bool,
        handPosition: Int? = nil
    ) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: self).cgColor
        layer?.cornerRadius = 8
        layer?.borderWidth = 1
        layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor

        let name = NSTextField(labelWithString: entry.name)
        name.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold)
        name.textColor = StarlingsColors.primaryText
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let detail = NSTextField(labelWithString: Self.detailText(
            entry: entry,
            isSharing: isSharing,
            handPosition: handPosition
        ))
        detail.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        detail.textColor = StarlingsColors.secondaryText
        detail.lineBreakMode = .byTruncatingTail
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let labels = NSStackView(views: [name, detail])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 1

        let quality = NSImageView()
        quality.image = NSImage(
            systemSymbolName: entry.quality.tileIconSystemName,
            variableValue: entry.quality.tileSignalValue,
            accessibilityDescription: entry.quality.tileIconAccessibilityLabel
        )?.withSymbolConfiguration(.init(pointSize: 12, weight: .semibold))
        quality.contentTintColor = StarlingsColors.resolved(
            entry.quality.isWeak ? StarlingsColors.danger : StarlingsColors.secondaryText,
            for: quality
        )
        quality.toolTip = entry.quality.label
        quality.setAccessibilityLabel(entry.quality.tileIconAccessibilityLabel)
        quality.setContentHuggingPriority(.required, for: .horizontal)

        // Leading, before the name: with a queue on screen the host is scanning
        // for who is waiting, not reading names in order, and a marker after
        // the name is one the eye has to hunt for down a ragged column.
        var rowViews: [NSView] = []
        if handPosition != nil {
            let hand = NSImageView()
            hand.image = NSImage(
                systemSymbolName: "hand.raised.fill",
                accessibilityDescription: String(localized: "Hand raised")
            )?.withSymbolConfiguration(.init(pointSize: 11, weight: .semibold))
            hand.contentTintColor = StarlingsColors.resolved(StarlingsColors.accentMark, for: self)
            hand.setContentHuggingPriority(.required, for: .horizontal)
            rowViews.append(hand)
        }
        rowViews.append(contentsOf: [labels, NSView(), quality])

        let row = NSStackView(views: rowViews)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        addSubview(row)
        row.pinToEdges(of: self, insets: NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10))
        heightAnchor.constraint(greaterThanOrEqualToConstant: 40).isActive = true
        applyMeetHoverLift(base: StarlingsColors.elevated, cornerRadius: 8)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// The second line: who they are to this Mac, how their connection is,
    /// which app they are on, and whether they are sharing.
    private static func detailText(
        entry: MeetingParticipantQuality,
        isSharing: Bool,
        handPosition: Int?
    ) -> String {
        var parts: [String] = []
        // First, because it is the only line item somebody is waiting on an
        // answer to. "Hand raised" alone when they are the only one: a "#1"
        // beside a queue of one is a number with nothing to compare it to.
        if let handPosition {
            parts.append(handPosition == 1 ? String(localized: "Hand raised") : String(localized: "Hand raised · #\(handPosition)"))
        }
        parts.append(entry.isLocal ? String(localized: "You") : entry.quality.label)
        // Which app they are on. The lobby already shows this before admission;
        // the host asking "why is their audio odd" wants it after, too.
        if let client = entry.client { parts.append(client.badge) }
        if entry.registered { parts.append(String(localized: "Registered")) }
        if entry.recording {
            parts.append(String(localized: "Recording"))
            if let sender = entry.onBehalfOf {
                parts.append(String(localized: "Sent by \(sender)"))
            }
        }
        if isSharing { parts.append(String(localized: "Sharing")) }
        return parts.joined(separator: " · ")
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        menuProvider?() ?? super.menu(for: event)
    }
}

@MainActor
/// What the sidebar's calendar section is currently showing — today's list
/// (idle) or the single next meeting (live). Tracked so chrome refreshes that
/// have nothing to do with the calendar do not rebuild the rows.
private enum UpcomingRenderMode {
    case list
    case next
}

private final class UpcomingMeetingRow: NSView {
    var onHost: ((CalendarEventSummary) -> Void)?
    var onToggleDemoted: ((CalendarEventSummary) -> Void)?
    private let event: CalendarEventSummary
    private let hostButton = NSButton(title: String(localized: "Join"), target: nil, action: nil)
    private let timeLeftLabel = NSTextField(labelWithString: "")

    /// `showsAction: false` is the live sidebar's NEXT row. Mid-meeting, Join
    /// would point the app at a different room while this one is still
    /// running, so that row is awareness only — it answers "how long have I
    /// got", not "switch now".
    init(event: CalendarEventSummary, showsAction: Bool = true) {
        self.event = event
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: self).cgColor
        layer?.cornerRadius = 8
        layer?.borderWidth = 1
        layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor

        let title = NSTextField(labelWithString: event.title)
        title.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold)
        title.textColor = StarlingsColors.primaryText
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        timeLeftLabel.font = .monospacedDigitSystemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold)
        timeLeftLabel.alignment = .right
        timeLeftLabel.setContentHuggingPriority(.required, for: .horizontal)
        timeLeftLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        let titleRow = NSStackView(views: [title, NSView(), timeLeftLabel])
        titleRow.orientation = .horizontal
        titleRow.alignment = .centerY
        titleRow.spacing = 4

        let clock = MeetingCountdown.clockRange(
            startISO: event.start,
            endISO: event.end,
            isAllDay: event.isAllDay
        )
        let when = NSTextField(labelWithString: [event.platform.displayName, clock, event.calendarSummary, CalendarTravelTime.label(minutes: event.travelTimeMinutes)]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " · "))
        when.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        when.textColor = StarlingsColors.secondaryText
        when.lineBreakMode = .byTruncatingTail
        when.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let platformIcon = NSImageView()
        platformIcon.image = CalendarMeetingPlatformMark.image(
            for: event.platform,
            size: 14,
            color: event.platform == .starlings ? StarlingsColors.accentMark : StarlingsColors.secondaryText
        )
        platformIcon.isHidden = event.platform == .none
        platformIcon.setContentHuggingPriority(.required, for: .horizontal)
        platformIcon.setContentCompressionResistancePriority(.required, for: .horizontal)

        let whenRow = NSStackView(views: [platformIcon, when])
        whenRow.orientation = .horizontal
        whenRow.alignment = .centerY
        whenRow.spacing = 4

        let contactNames = ContactEmailDirectory.displayNameByEmail()
        // Live, the row shares 330pt with participants and the waiting room, so
        // the guest list states who is coming without becoming a paragraph.
        let people = CalendarAttendeeListView(
            attendees: event.attendees,
            font: .systemFont(ofSize: StarlingsTypography.scaled(11)),
            color: StarlingsColors.secondaryText,
            contactNames: contactNames,
            maximumRows: showsAction ? nil : 2
        )

        hostButton.title = event.platform.actionTitle
        hostButton.bezelStyle = .inline
        SettingsChrome.applyQuietButton(hostButton)
        hostButton.controlSize = .small
        hostButton.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold)
        hostButton.contentTintColor = StarlingsColors.primaryText
        hostButton.target = self
        hostButton.action = #selector(hostTapped)
        hostButton.setContentHuggingPriority(.required, for: .horizontal)
        hostButton.isHidden = !showsAction || !event.isVideoMeeting

        let text = NSStackView(views: [titleRow, whenRow, people])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 2

        let row = NSStackView(views: [text, NSView(), hostButton])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        addSubview(row)
        row.pinToEdges(of: self, insets: NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10))
        titleRow.widthAnchor.constraint(equalTo: text.widthAnchor).isActive = true
        heightAnchor.constraint(greaterThanOrEqualToConstant: 58).isActive = true
        refreshRelativeTime()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Re-read the clock. Called every second while a meeting runs, so the
    /// countdown is never a number that was true when the row was built.
    func refreshRelativeTime(now: Date = Date()) {
        let remaining = MeetingCountdown.timeLeft(startISO: event.start, endISO: event.end, now: now)
        timeLeftLabel.stringValue = remaining ?? ""
        timeLeftLabel.isHidden = remaining == nil

        let minutesUntilStart = MeetingCountdown.minutesUntilStart(startISO: event.start, now: now) ?? .max
        let underway = minutesUntilStart < 0
        // Accent only in the last few minutes: a countdown that is always loud
        // is a countdown the host stops reading.
        let imminent = !underway && minutesUntilStart <= 5
        timeLeftLabel.textColor = imminent ? StarlingsColors.accentMark : StarlingsColors.secondaryText
    }

    @objc private func hostTapped() {
        onHost?(event)
    }

    override func menu(for nsEvent: NSEvent) -> NSMenu? {
        let menu = NSMenu()
        let item = menu.addItem(
            withTitle: event.demoted ? String(localized: "Show in Next") : String(localized: "Hide from Next"),
            action: #selector(toggleDemoted),
            keyEquivalent: ""
        )
        item.target = self
        return menu
    }

    @objc private func toggleDemoted() {
        onToggleDemoted?(event)
    }
}

private func parseCalendarISODate(_ value: String) -> Date? {
    ISODate.parse(value)
}
