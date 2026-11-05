import AppKit
import Combine
import EnvisioningUI
import KeepUI
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class SettingsViewController: NSViewController {
    var onSignIn: (() -> Void)?
    var onSignOut: (() -> Void)?
    var onSessionChanged: ((OwnerSessionCredentials?) -> Void)?

    private typealias Page = StarlingsSettingID

    private let devices = MediaDeviceService()
    private let ownerSessionStore: OwnerSessionStore
    private let authenticator: GoogleOwnerAuthenticator

    // Every account on Settings is one SettingsConnectionGroup, with its current
    // action beside the status row it changes.
    private let accountConnection = SettingsConnectionGroup(
        title: String(localized: "Host account"),
        connectTitle: String(localized: "Sign in"),
        disconnectTitle: String(localized: "Sign out"),
        busyTitle: String(localized: "Signing in…")
    )
    private let calendarConnection = SettingsConnectionGroup(
        title: String(localized: "Google Calendar"),
        connectTitle: String(localized: "Connect Calendar"),
        disconnectTitle: String(localized: "Disconnect")
    )
    private let coreConnection = SettingsConnectionGroup(
        title: String(localized: "Other records"),
        connectTitle: String(localized: "Connect records"),
        disconnectTitle: String(localized: "Disconnect")
    )
    private let core: CoreSession
    /// Docs and Keep come with the Meet session (`MainWindowController`
    /// links them), so neither has a Connect row here. Keep keeps its
    /// unlock-method rows.
    private let keep: KeepAccess
    private var keepObserver: AnyCancellable?
    private var keepSessionObserver: AnyCancellable?
    /// The unlock-method rows from KeepUI, shown once Keep is linked.
    private lazy var keepMethodsHost = NSHostingView(rootView: AnyView(EmptyView()))
    /// Connected agents (docs/MCP.md). Rebuilt whole on every refresh, like
    /// the calendar accounts group: a revoke takes its row off the page.
    private let connectedClaudesGroup = SettingsGroupView(rows: [])
    /// Devices (docs/ADMIN.md §5a): the person's signed-in Macs and phones,
    /// this one marked. Rebuilt whole like Connected agents; a Sign out
    /// takes its row off the page and the Worker.
    private let devicesGroup = SettingsGroupView(rows: [])
    /// The other workspaces signed in to on this Mac, each with
    /// Sign out and Remove. Rebuilt whole on every refresh.
    private let workspacesGroup = SettingsGroupView(rows: [])
    private var coreObserver: AnyCancellable?
    private let microphoneRow = SettingsInfoRow(title: String(localized: "Microphone"))
    private let roomPolicyRow = SettingsToggleRow(
        title: String(localized: "Refuse recording notetakers"),
        detail: String(localized: "Notetakers declare that they record. They still wait for admission when this is off.")
    )
    private let roomPolicyStatusRow = SettingsInfoRow(title: String(localized: "Your room"), showsStatusDot: false)
    private var roomPolicyRoom: RoomSlug?
    private var roomPolicySaving = false
    private let microphonePicker = SettingsDevicePickerRow(title: String(localized: "Microphone"))
    private let audioMeter = SettingsAudioMeterRow()
    private let hostRow = SettingsInfoRow(title: String(localized: "Host Mac"))
    /// Your own face, and the two buttons that change it. Settings owns this
    /// rather than the Work sidebar shelf: a picture is something you go
    /// looking for once, and an avatar you have to discover is clickable is
    /// not a place anybody looks.
    private let pictureAvatar = StarlingsPersonAvatarView(
        identity: StarlingsAvatarIdentity(displayName: "You"),
        diameter: 64
    )
    private let pictureRow = SettingsInfoRow(title: String(localized: "Profile picture"))
    private let choosePictureButton = StarlingsFilledButton(style: .accent, title: String(localized: "Choose Picture…"))
    private let removePictureButton = NSButton(title: String(localized: "Remove"), target: nil, action: nil)
    /// The version of the picture currently on the server, or nil for none —
    /// which is also what decides whether Remove is offered.
    private var pictureVersion: Date?
    private var pictureBusy = false
    private let lobbyKnockAlertsRow = SettingsToggleRow(
        title: String(localized: "Notify when guests knock"),
        detail: String(localized: "Knock at the door, bounce the Dock, and post a notification when someone enters the waiting room.")
    )
    private let meetingWarningRow = SettingsToggleRow(
        title: MeetingAlertSettings.warningTitle,
        detail: String(localized: "A notification before each meeting on your agenda, with Join.")
    )
    private let meetingWarningLeadRow = SettingsChoiceRow(
        title: MeetingAlertSettings.leadTitle,
        options: MeetingAlertSettings.leadChoices.map { MeetingAlertSettings.leadLabel(minutes: $0) },
        selectedIndex: MeetingAlertSettings.leadChoices.firstIndex(of: MeetingAlertSettings.leadMinutes) ?? 0
    )
    private let captionsRow = SettingsInfoRow(title: String(localized: "Speech model"))
    /// Which engine reads the transcript for task suggestions, and whether it
    /// can run here — the standing answer; the live one is the Tasks panel's.
    private let suggestionsRow = SettingsInfoRow(title: String(localized: "Task suggestions"))
    /// One toggle per language this build can label a transcript with. Built
    /// from the list rather than declared one by one, so retiring or adding a
    /// language is one edit in `TranscriptionLanguages`.
    private lazy var languageRows: [(language: TranscriptLanguage, row: SettingsToggleRow)] =
        TranscriptionLanguages.selectable.map { language in
            (language, SettingsToggleRow(title: language.settingsName))
        }
    private let openMicrophoneRow = SettingsActionRow(title: String(localized: "Open Microphone settings"))
    private let openMicModesRow = SettingsActionRow(title: String(localized: "Open Mic Modes…"))
    private let voiceProcessingRow = SettingsInfoRow(title: String(localized: "Voice processing"), showsStatusDot: false)
    private let prepareCaptionsButton = StarlingsFilledButton(style: .accent, title: String(localized: "Download speech model"))
    private var videoSettingsPage: VideoSettingsPageView?

    private let updatesStatusRow = SettingsInfoRow(title: String(localized: "App updates"), showsStatusDot: false)
    private let automaticUpdatesRow = SettingsToggleRow(
        title: String(localized: "Check automatically"),
        detail: String(localized: "Look weekly for a newer notarized build.")
    )
    private let checkUpdatesRow = SettingsActionRow(title: String(localized: "Check for updates"))
    private let installUpdateRow = SettingsActionRow(title: String(localized: "Install and restart"))
    private var updatesGroup: SettingsGroupView?
    private var updatesFooterLabel: NSTextField?
    private var updateInstallMessage: String?

    private let sidebarStack = NSStackView()
    private let detailTitle = NSTextField(labelWithString: "")
    private let detailContainer = NSView()
    private var navItems: [SettingsNavItemView] = []
    private var pageViews: [Page: NSView] = [:]
    private var selectedPage: Page = .account
    private var keyObserver: NSObjectProtocol?
    private var updateObserver: NSObjectProtocol?
    private var isPreparingCaptions = false
    private var microphonePrivacyGroup: SettingsGroupView?
    private var captionsActionsStack: NSStackView?
    private var calendarPickerGroup: SettingsGroupView?
    private var calendarPickerRows: [SettingsToggleRow] = []
    private var upcomingSubscriptionRows: [SettingsToggleRow] = []
    private var upcomingFollowingRowsRow: SettingsChoiceRow?
    private var upcomingPreferences = UpcomingPreferencesWire.defaults
    /// Settings > Home: the module list, owner-synced (`HomeLayout`). The
    /// cached copy draws first; the Worker's answer replaces it.
    private var homeLayout = HomeLayoutCache.load()
    private var homeWorkModules: [WorkModule]?
    private var homeLayoutRows: [HomeModuleID: SettingsOrderRow] = [:]
    private var homeLayoutGroup: SettingsGroupView?
    private var homeLayoutSaving = false
    private var languageChoiceRow: SettingsChoiceRow?
    private var languageSaving = false
    private var homeLayoutSignedOutLabel: NSTextField?
    /// Settings > Work. The block list is `WorkSidebarPreferences` (this
    /// Mac); Sales is the Worker's `sales_enabled` (this person).
    private var workSidebarRows: [String: SettingsOrderRow] = [:]
    private var workSidebarGroup: SettingsGroupView?
    /// Settings › Work's "Show in Work" switches, one per subject kind.
    private var workKindRows: [String: SettingsToggleRow] = [:]
    private var workHiddenKinds: [String] = []
    private var workSalesGroup: SettingsGroupView?
    private var workSalesSignedOutLabel: NSTextField?
    private var workSalesEnabled = false
    private var workSalesSaving = false
    private var workInboxRows: [String: SettingsToggleRow] = [:]
    private var workInboxGroup: SettingsGroupView?
    /// The Worker's answer, overrides only; the rows draw it resolved.
    private var workInboxSources: [String: Bool] = [:]
    private var workInboxAvailableSources = Set(InboxSourceSpec.all.map(\.source))
    private var workInboxSaving = false
    private var appearanceChoiceRow: SettingsChoiceRow?
    private var useTabsRow: SettingsToggleRow?
    private var homeTextureRow: SettingsToggleRow?
    /// One group per account, stacked. Rebuilt whole on every change, because
    /// switching an account off takes its calendars off the page with it.
    private let calendarSourcesStack = NSStackView()
    private var availableCalendars: [GoogleCalendarListEntry] = []
    private var availableUpcomingSubscriptions: [CalendarSubscription] = []
    private var calendarBusy = false
    private var preferencesObserver: NSObjectProtocol?
    private var workSidebarObserver: NSObjectProtocol?

    private let controlAPI: MeetingControlAPI
    private let calendarAuthenticator: GoogleCalendarAuthenticator
    /// The same workspace the Calendar window drives, so a switch flipped here
    /// and a sidebar over there are never two opinions about one list.
    private let calendarWorkspace: CalendarWorkspace
    /// Settings › Calendar › Booking hours, the row the web edits.
    private lazy var bookingHoursView = BookingHoursSettingsView(api: controlAPI)

    private static let sidebarWidth: CGFloat = 196
    private static let contentMaxWidth: CGFloat = 520

    init(
        ownerSessionStore: OwnerSessionStore = OwnerSessionStore(),
        authenticator: GoogleOwnerAuthenticator = GoogleOwnerAuthenticator(),
        /// Nil only for a Settings window built on its own (the default
        /// window controller); the app passes the session it shares with Work.
        core: CoreSession? = nil,
        keep: KeepAccess? = nil,
        controlAPI: MeetingControlAPI? = nil,
        calendarAuthenticator: GoogleCalendarAuthenticator = GoogleCalendarAuthenticator(),
        calendarWorkspace: CalendarWorkspace? = nil
    ) {
        self.ownerSessionStore = ownerSessionStore
        self.authenticator = authenticator
        self.core = core ?? CoreSession(
            apiEndpoint: HTTPConnectionDetailsProvider.configuredAPIBase.absoluteString,
            deviceName: Host.current().localizedName ?? String(localized: "Mac")
        )
        self.keep = keep ?? KeepAccess(
            apiEndpoint: HTTPConnectionDetailsProvider.configuredAPIBase.absoluteString,
            deviceName: Host.current().localizedName ?? String(localized: "Mac")
        )
        let api = controlAPI ?? MeetingControlAPI(ownerSessionStore: ownerSessionStore)
        self.controlAPI = api
        self.calendarAuthenticator = calendarAuthenticator
        self.calendarWorkspace = calendarWorkspace ?? CalendarWorkspace(backend: api)
        super.init(nibName: nil, bundle: nil)
        coreObserver = self.core.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                Task { @MainActor in self?.refreshCore() }
            }
        keepObserver = self.keep.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                Task { @MainActor in self?.refreshKeep() }
            }
        keepSessionObserver = self.keep.session.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                Task { @MainActor in self?.refreshKeep() }
            }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func loadView() {
        view = NSView()
        view.wantsLayer = true
        view.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.canvas, for: view).cgColor
        buildInterface()
        beginDeviceMonitoring()
        beginUpdateMonitoring()
        selectPage(.account)
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        refresh()
        // viewWillDisappear tears both observers down, so re-register on every
        // appearance — otherwise a reopened Settings window stops live-updating
        // its device pickers when preferences change elsewhere.
        observeMediaPreferenceChanges()
        guard keyObserver == nil, let window = view.window else { return }
        keyObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didBecomeKeyNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    override func viewWillDisappear() {
        super.viewWillDisappear()
        videoSettingsPage?.setActive(false)
        audioMeter.stop()
        if let keyObserver {
            NotificationCenter.default.removeObserver(keyObserver)
            self.keyObserver = nil
        }
        if let preferencesObserver {
            NotificationCenter.default.removeObserver(preferencesObserver)
            self.preferencesObserver = nil
        }
        if let workSidebarObserver {
            NotificationCenter.default.removeObserver(workSidebarObserver)
            self.workSidebarObserver = nil
        }
    }

    func refresh() {
        // Some callers refresh account state before Settings has ever been
        // shown. Build the AppKit rows before mutating them so the first-open
        // path and background session changes use the same lifecycle.
        loadViewIfNeeded()
        refreshAccount()
        refreshCaptions()
        refreshDevicePickers()
        refreshUpdates()
        if let appearanceChoiceRow {
            appearanceChoiceRow.select(StarlingsAppearanceMode.allCases.firstIndex(of: StarlingsAppearanceSettings.mode()) ?? 0)
        }
        useTabsRow?.isOn = StarlingsWindowChrome.usesTabs()
        homeTextureRow?.isOn = HomeTexturePreferences.showsTexture()
        Task { await refreshPicture() }
        Task {
            await refreshCalendarSources()
            await refreshCalendar()
        }
        Task { await refreshUpcomingPreferences() }
        Task { await refreshHomeLayout() }
        Task { await refreshLanguage() }
        Task { await refreshWorkSales() }
        Task { await refreshRoomPolicy() }
        bookingHoursView.reload(signedIn: (try? ownerSessionStore.load()) != nil)
        renderWorkSidebar()
        Task { await refreshPermissions() }
    }

    /// Opens the Calendar page — where the Calendar window sends anyone
    /// looking for an account it is not showing.
    func showCalendarSettings() {
        selectPage(.calendar)
        Task {
            await refreshCalendarSources()
            await refreshCalendar()
        }
    }

    /// Opens one page by its shared id — the ⌘K palette's settings door.
    func show(page: StarlingsSettingID) {
        selectPage(page)
    }

    /// Opens About and starts a manual update check (Meet menu).
    func showAboutAndCheckForUpdates() {
        selectPage(.about)
        Task { await UpdateChecker.shared.check() }
    }

    /// Opens the About page without replacing an already successful check with
    /// another network request. The main-window banner already has the same
    /// validated update the page is about.
    func showAbout() {
        selectPage(.about)
    }

    /// The main-window banner's explicit install action. Keeping the actual
    /// handoff here means failures still land in the About page's footer.
    func installAvailableUpdateFromBanner() {
        selectPage(.about)
        Task { @MainActor [weak self] in
            guard let self else { return }
            if UpdateChecker.shared.available == nil {
                await UpdateChecker.shared.check()
            }
            self.refreshUpdates()
            self.installAvailableUpdate()
        }
    }

    private func beginDeviceMonitoring() {
        devices.onDevicesChanged = { [weak self] in
            self?.refreshDevicePickers()
        }
        devices.beginMonitoring()
        observeMediaPreferenceChanges()
        microphonePicker.onSelectionChanged = { [weak self] id in
            MediaDevicePreferences.preferredMicrophoneID = id
            MediaDevicePreferences.applyMicrophoneSelection(id: id)
            self?.audioMeter.setDeviceID(id)
        }
    }

    private func observeMediaPreferenceChanges() {
        if workSidebarObserver == nil {
            // The Work window's own Sections menu writes the same store this
            // page draws; redraw so the two never disagree while both are up.
            workSidebarObserver = NotificationCenter.default.addObserver(
                forName: WorkSidebarPreferences.didChangeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.renderWorkSidebar() }
            }
        }
        guard preferencesObserver == nil else { return }
        preferencesObserver = NotificationCenter.default.addObserver(
            forName: MediaDevicePreferences.didChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.refreshDevicePickers() }
        }
    }

    private func refreshDevicePickers() {
        devices.refreshDevices()
        videoSettingsPage?.refresh()
        microphonePicker.reload(
            devices: devices.microphones,
            symbolName: "mic.fill",
            selectedID: MediaDevicePreferences.resolveMicrophoneID(from: devices.microphones)
        )
        audioMeter.setDeviceID(MediaDevicePreferences.resolveMicrophoneID(from: devices.microphones))
    }

    private func buildInterface() {
        let sidebar = NSView()
        sidebar.wantsLayer = true
        sidebar.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.panel, for: sidebar).cgColor

        sidebarStack.orientation = .vertical
        sidebarStack.alignment = .leading
        sidebarStack.spacing = 2
        sidebarStack.translatesAutoresizingMaskIntoConstraints = false

        // The shared table's groups (`settings-pages.ts`), the headings iOS and the web draw too.
        for (index, row) in StarlingsSettingsRegistry.groups(for: .macSettingsSidebar).enumerated() {
            let heading = StarlingsTypography.sectionLabel(row.group.title)
            if index > 0, let last = sidebarStack.arrangedSubviews.last {
                sidebarStack.setCustomSpacing(14, after: last)
            }
            sidebarStack.addArrangedSubview(heading)
            sidebarStack.setCustomSpacing(6, after: heading)
            heading.leadingAnchor.constraint(equalTo: sidebarStack.leadingAnchor, constant: 8).isActive = true
            for definition in row.definitions {
                let item = SettingsNavItemView(
                    tag: definition.id.rawValue,
                    title: definition.title,
                    symbolName: definition.symbolName
                )
                item.onSelect = { [weak self] tag in
                    guard let page = Page(rawValue: tag) else { return }
                    self?.selectPage(page)
                }
                navItems.append(item)
                sidebarStack.addArrangedSubview(item)
                item.widthAnchor.constraint(equalTo: sidebarStack.widthAnchor).isActive = true
            }
        }

        sidebar.addSubview(sidebarStack)
        NSLayoutConstraint.activate([
            sidebarStack.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 10),
            sidebarStack.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: -10),
            sidebarStack.topAnchor.constraint(equalTo: sidebar.topAnchor, constant: 12),
        ])

        let divider = NSView()
        divider.wantsLayer = true
        divider.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.border, for: divider).cgColor

        detailTitle.font = .systemFont(ofSize: StarlingsTypography.scaled(22), weight: .semibold)
        detailTitle.textColor = StarlingsColors.primaryText

        let detailColumn = NSStackView(views: [detailTitle, detailContainer])
        detailColumn.orientation = .vertical
        detailColumn.alignment = .leading
        detailColumn.spacing = 20
        detailColumn.translatesAutoresizingMaskIntoConstraints = false

        let document = NSView()
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(detailColumn)

        let clipView = SettingsFlippedClipView()
        clipView.drawsBackground = false

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.contentView = clipView
        scroll.documentView = document

        let detailPane = NSView()
        detailPane.wantsLayer = true
        detailPane.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.canvas, for: detailPane).cgColor
        detailPane.addSubview(scroll)
        scroll.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(sidebar)
        view.addSubview(divider)
        view.addSubview(detailPane)
        sidebar.translatesAutoresizingMaskIntoConstraints = false
        divider.translatesAutoresizingMaskIntoConstraints = false
        detailPane.translatesAutoresizingMaskIntoConstraints = false

        var pages: [Page: NSView] = [:]
        for definition in StarlingsSettingsRegistry.definitions(for: .macSettingsSidebar) {
            pages[definition.id] = makePage(for: definition.id)
        }
        pageViews = pages

        let columnWidth = detailColumn.widthAnchor.constraint(equalTo: document.widthAnchor, constant: -56)
        columnWidth.priority = .defaultHigh

        NSLayoutConstraint.activate([
            sidebar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            sidebar.topAnchor.constraint(equalTo: view.topAnchor),
            sidebar.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            sidebar.widthAnchor.constraint(equalToConstant: Self.sidebarWidth),

            divider.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor),
            divider.topAnchor.constraint(equalTo: view.topAnchor),
            divider.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            divider.widthAnchor.constraint(equalToConstant: 1),

            detailPane.leadingAnchor.constraint(equalTo: divider.trailingAnchor),
            detailPane.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            detailPane.topAnchor.constraint(equalTo: view.topAnchor),
            detailPane.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            scroll.leadingAnchor.constraint(equalTo: detailPane.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: detailPane.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: detailPane.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: detailPane.bottomAnchor),

            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),

            detailColumn.topAnchor.constraint(equalTo: document.topAnchor, constant: 22),
            detailColumn.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -28),
            detailColumn.centerXAnchor.constraint(equalTo: document.centerXAnchor),
            detailColumn.widthAnchor.constraint(lessThanOrEqualToConstant: Self.contentMaxWidth),
            columnWidth,
            detailColumn.leadingAnchor.constraint(greaterThanOrEqualTo: document.leadingAnchor, constant: 28),
            detailColumn.trailingAnchor.constraint(lessThanOrEqualTo: document.trailingAnchor, constant: -28),

            detailContainer.widthAnchor.constraint(equalTo: detailColumn.widthAnchor),
        ])
    }

    private func makePage(for page: Page) -> NSView {
        switch page {
        case .account: return makeAccountPage()
        case .home: return makeHomePage()
        case .work: return makeWorkPage()
        case .calendar: return makeCalendarPage()
        case .video: return makeVideoPage()
        case .audio: return makeAudioPage()
        case .captions: return makeCaptionsPage()
        case .meetings: return makeMeetingsPage()
        case .room: return makeRoomPage()
        case .notifications: return makeNotificationsPage()
        case .appearance: return makeAppearancePage()
        case .about: return makeAboutPage()
        case .calls, .appLock, .developmentServer:
            preconditionFailure("\(page) is not a macOS settings page")
        }
    }

    private func makeAccountPage() -> NSView {
        accountConnection.onConnect = { [weak self] in self?.signIn() }
        accountConnection.onDisconnect = { [weak self] in self?.signOut() }

        lobbyKnockAlertsRow.isOn = LobbyKnockPreferences.alertsEnabled
        lobbyKnockAlertsRow.onChange = { enabled in
            LobbyKnockPreferences.alertsEnabled = enabled
        }
        let hostGroup = SettingsGroupView(rows: [hostRow, lobbyKnockAlertsRow])

        // The meeting warning, 1:1 with the phone's Notifications section:
        // the same two rows, the same words, the same keys.
        meetingWarningRow.isOn = MeetingAlertSettings.enabled
        meetingWarningRow.onChange = { [weak self] enabled in
            MeetingAlertSettings.enabled = enabled
            self?.meetingWarningLeadRow.isEnabled = enabled
        }
        meetingWarningLeadRow.isEnabled = MeetingAlertSettings.enabled
        meetingWarningLeadRow.onSelect = { index in
            guard MeetingAlertSettings.leadChoices.indices.contains(index) else { return }
            MeetingAlertSettings.leadMinutes = MeetingAlertSettings.leadChoices[index]
        }
        let notificationsGroup = SettingsGroupView(rows: [meetingWarningRow, meetingWarningLeadRow])

        choosePictureButton.target = self
        choosePictureButton.action = #selector(choosePicture)
        removePictureButton.target = self
        removePictureButton.action = #selector(removePicture)
        choosePictureButton.applyMeetFilledStyle(
            .accent,
            title: String(localized: "Choose Picture…"),
            font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold)
        )
        SettingsChrome.applySecondaryButton(removePictureButton, title: String(localized: "Remove"))
        choosePictureButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 168).isActive = true
        removePictureButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 96).isActive = true

        pictureAvatar.translatesAutoresizingMaskIntoConstraints = false
        let pictureButtons = NSStackView(views: [choosePictureButton, removePictureButton, NSView()])
        pictureButtons.orientation = .horizontal
        pictureButtons.spacing = 10
        pictureButtons.alignment = .centerY
        let pictureActions = NSStackView(views: [pictureAvatar, pictureButtons])
        pictureActions.orientation = .horizontal
        pictureActions.spacing = 14
        pictureActions.alignment = .centerY

        coreConnection.onConnect = { [weak self] in self?.connectCore() }
        coreConnection.onDisconnect = { [weak self] in self?.disconnectCore() }
        refreshCore()

        refreshKeep()
        refreshConnectedClaudes()
        refreshDevices()

        // A workspace without Core or Keep shows no row for it.
        var serviceSections: [PageSection] = []
        if core.isAvailable {
            serviceSections.append(.init(
                header: String(localized: "Other records"),
                content: coreConnection,
                footer: String(localized: "Lets this Mac read and edit records with no subject page.")
            ))
        }
        if keep.isAvailable {
            serviceSections.append(.init(content: keepMethodsHost))
        }

        return pageSections([
            .init(header: String(localized: "Sign-In"), content: accountConnection, footer: String(localized: "Sign in to \(StarlingsWorkspace.active.name) to host meetings from this Mac.")),
            .init(header: String(localized: "Other workspaces"), content: workspacesGroup),
            .init(content: addWorkspaceRow()),
            .init(
                header: String(localized: "Picture"),
                content: SettingsGroupView(rows: [pictureRow]),
                footer: String(localized: "Visible to colleagues, not guests.")
            ),
            .init(content: pictureActions),
        ] + serviceSections + [
            .init(header: String(localized: "Connected agents"), content: connectedClaudesGroup),
            .init(
                header: String(localized: "Devices"),
                content: devicesGroup,
                footer: String(localized: "Lost a phone? Sign it out here. Its Starlings session ends at its next request.")
            ),
            .init(
                header: String(localized: "Host"),
                content: hostGroup,
                footer: String(localized: "A live room keeps this Mac awake and renews the admission lease every 10 seconds.")
            ),
            .init(
                header: String(localized: "Notifications"),
                content: notificationsGroup,
                footer: MeetingAlertSettings.openOnlyFooter
            ),
        ])
    }

    private func makeCalendarPage() -> NSView {
        calendarConnection.onConnect = { [weak self] in self?.connectCalendar() }
        calendarConnection.onDisconnect = { [weak self] in self?.disconnectCalendar() }

        let pickerGroup = SettingsGroupView(rows: [])
        pickerGroup.isHidden = true
        calendarPickerGroup = pickerGroup
        // How many rows Upcoming shows on Home moved to the Home page with
        // the rest of the Home layout; what feeds it stays here.
        let upcomingStack = NSStackView(views: [pickerGroup])
        upcomingStack.orientation = .vertical
        upcomingStack.alignment = .width
        upcomingStack.spacing = 12

        calendarSourcesStack.orientation = .vertical
        calendarSourcesStack.alignment = .width
        calendarSourcesStack.spacing = 12

        let sourcesStack = NSStackView(views: [calendarConnection, calendarSourcesStack])
        sourcesStack.orientation = .vertical
        sourcesStack.alignment = .width
        sourcesStack.spacing = 12

        // Calendar display and weather answer the same question — how this Mac
        // presents the calendar — so they share one section while keeping
        // their controls in separate groups.
        let displayStack = NSStackView(views: [makeCalendarBehaviourGroup(), makeWeatherGroup()])
        displayStack.orientation = .vertical
        displayStack.alignment = .width
        displayStack.spacing = 12

        return pageSections([
            .init(
                header: CalendarSettingGroup.accountsAndSources.title,
                content: sourcesStack,
                footer: String(localized: "Off hides an account’s calendars.")
            ),
            .init(
                header: CalendarSettingGroup.upcoming.title,
                content: upcomingStack,
                footer: String(localized: "Choose which Google calendars and subscribed feeds feed Upcoming.")
            ),
            .init(
                header: CalendarSettingGroup.display.title,
                content: displayStack,
                footer: String(localized: "Hours outside your day stay hidden unless events need them.")
            ),
            .init(
                header: CalendarSettingsRegistry.title(for: .bookingHours),
                content: bookingHoursView
            ),
        ])
    }

    /// Settings > Home: what Home is made of, in what order, and how dense
    /// the agenda is. The module list is `HomeLayout` (fixtures/home-layout.json)
    /// and is owner-synced — move a row here and the phone and the browser
    /// draw the same order on their next read.
    private func makeHomePage() -> NSView {
        let group = SettingsGroupView(rows: [])
        homeLayoutGroup = group
        let signedOut = StarlingsTypography.wrappingLabel(String(localized: "Sign in to arrange Home across your devices."))
        signedOut.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        signedOut.textColor = StarlingsColors.secondaryText
        signedOut.isHidden = true
        homeLayoutSignedOutLabel = signedOut
        let modulesStack = NSStackView(views: [group, signedOut])
        modulesStack.orientation = .vertical
        modulesStack.alignment = .width
        modulesStack.spacing = 12
        renderHomeLayout()

        return pageSections([
            .init(
                header: String(localized: "Modules"),
                content: modulesStack,
                footer: String(localized: "Off keeps a module off Home even when it has something to show.")
            ),
            .init(
                header: HomeLayout.definition(for: .agenda).title,
                content: makeUpcomingPreferencesGroup(),
                footer: String(localized: "How many meetings show before the foldout.")
            ),
        ])
    }

    private func renderHomeLayout() {
        guard let homeLayoutGroup else { return }
        let signedIn = (try? ownerSessionStore.load()) != nil
        homeLayoutGroup.isHidden = !signedIn
        homeLayoutSignedOutLabel?.isHidden = signedIn
        var rows: [NSView] = []
        let offered = HomeLayout.offered(homeLayout, workModules: homeWorkModules)
        for (index, setting) in offered.enumerated() {
            let row = homeLayoutRows[setting.id] ?? makeHomeLayoutRow(for: setting.id)
            row.render(
                enabled: setting.enabled,
                isFirst: index == 0,
                isLast: index == offered.count - 1,
                saving: homeLayoutSaving,
                canMoveUp: setting.id != .recent,
                canMoveDown: setting.id != .recent && index < offered.count - 2
            )
            rows.append(row)
        }
        homeLayoutGroup.setRows(rows)
    }

    private func makeHomeLayoutRow(for id: HomeModuleID) -> SettingsOrderRow {
        let row = SettingsOrderRow(module: HomeLayout.definition(for: id))
        row.onMove = { [weak self] direction in
            guard let self else { return }
            self.saveHomeLayout(HomeLayout.move(self.homeLayout, id, direction, workModules: self.homeWorkModules))
        }
        row.onToggle = { [weak self] enabled in
            guard let self, let index = self.homeLayout.firstIndex(where: { $0.id == id }) else { return }
            var next = self.homeLayout
            next[index].enabled = enabled
            self.saveHomeLayout(next)
        }
        homeLayoutRows[id] = row
        return row
    }

    private func refreshHomeLayout() async {
        guard (try? ownerSessionStore.load()) != nil else {
            homeLayout = HomeLayout.defaults
            renderHomeLayout()
            return
        }
        guard let response = try? await controlAPI.homeLayout() else { return }
        let layout = response.layout
        if layout != homeLayout {
            homeLayout = layout
            renderHomeLayout()
        }
        if layout != HomeLayoutCache.load() { HomeLayoutCache.store(layout) }
    }

    /// The owner-synced language choice. The row already shows
    /// the cached value; the Worker's answer replaces it, and a failed read
    /// keeps it.
    private func refreshLanguage() async {
        guard (try? ownerSessionStore.load()) != nil else {
            renderLanguage(nil)
            return
        }
        guard let response = try? await controlAPI.language() else { return }
        if response.preferred != StarlingsLanguageCache.load() { StarlingsLanguageCache.store(response.preferred) }
        renderLanguage(response.preferred)
    }

    private func renderLanguage(_ language: StarlingsLanguage?) {
        languageChoiceRow?.select(StarlingsLanguageChoice.offeredCases.firstIndex(of: StarlingsLanguageChoice(language)) ?? 0)
    }

    /// Show the choice now, then tell the Worker. On failure the old choice
    /// comes back.
    private func saveLanguage(_ next: StarlingsLanguage?) {
        let previous = StarlingsLanguageCache.load()
        guard next != previous, !languageSaving else {
            renderLanguage(previous)
            return
        }
        languageSaving = true
        StarlingsLanguageCache.store(next)
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.languageSaving = false }
            do {
                let saved = try await self.controlAPI.setLanguage(next).preferred
                StarlingsLanguageCache.store(saved)
                self.renderLanguage(saved)
                if let notice = StarlingsLanguageLaunch.restartNotice(for: saved) {
                    StarlingsToast.show(notice, in: self.view.window)
                }
            } catch {
                StarlingsLanguageCache.store(previous)
                self.renderLanguage(previous)
                self.presentAlert((error as? StarlingsError)?.message ?? String(localized: "Couldn’t save your language."))
            }
        }
    }

    /// Draw the new order now — here and on Home, through the cache's
    /// notification — then tell the Worker. On failure the old order comes back.
    private func saveHomeLayout(_ next: [HomeModuleSetting]) {
        let resolved = HomeLayout.resolve(next)
        let previous = homeLayout
        guard resolved != previous, !homeLayoutSaving else { return }
        homeLayout = resolved
        homeLayoutSaving = true
        renderHomeLayout()
        HomeLayoutCache.store(resolved)
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                self.homeLayoutSaving = false
                self.renderHomeLayout()
            }
            do {
                let saved = try await self.controlAPI.setHomeLayout(resolved).layout
                self.homeLayout = saved
                HomeLayoutCache.store(saved)
            } catch {
                self.homeLayout = previous
                HomeLayoutCache.store(previous)
                self.presentAlert((error as? StarlingsError)?.message ?? String(localized: "Couldn’t save your Home layout."))
            }
        }
    }

    /// Settings > Work: whether Sales is on for you, and what the rail is
    /// made of on this Mac. Star and mute are not here — they are about
    /// one subject and live on its row in Work.
    private func makeWorkPage() -> NSView {
        // One switch per subject kind; Leads is the old Sales opt-in. A kind
        // whose work module is off is not offered (refreshWorkSales).
        var kindRows: [SettingsToggleRow] = []
        for spec in ShownKindRow.all {
            let row = SettingsToggleRow(title: spec.title, detail: spec.detail)
            row.onChange = { [weak self] shown in self?.saveWorkKind(spec.kind.rawValue, shown: shown) }
            workKindRows[spec.kind.rawValue] = row
            kindRows.append(row)
        }
        let salesGroup = SettingsGroupView(rows: kindRows)
        workSalesGroup = salesGroup
        let signedOut = StarlingsTypography.wrappingLabel(String(localized: "Sign in to choose what shows in Work."))
        signedOut.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        signedOut.textColor = StarlingsColors.secondaryText
        signedOut.isHidden = true
        workSalesSignedOutLabel = signedOut
        let salesStack = NSStackView(views: [salesGroup, signedOut])
        salesStack.orientation = .vertical
        salesStack.alignment = .width
        salesStack.spacing = 12

        // Which INBOX sources you want: one switch per spec, the same list
        // the phone and the web draw (`InboxSourceSpec.all`).
        var inboxRows: [SettingsToggleRow] = []
        for spec in InboxSourceSpec.all {
            let row = SettingsToggleRow(title: spec.title, detail: spec.detail)
            row.isOn = spec.defaultOn
            row.onChange = { [weak self] on in self?.saveWorkInboxSource(spec.source, on: on) }
            workInboxRows[spec.source] = row
            inboxRows.append(row)
        }
        let inboxGroup = SettingsGroupView(rows: inboxRows)
        workInboxGroup = inboxGroup
        renderWorkInboxSources()

        let group = SettingsGroupView(rows: [])
        workSidebarGroup = group
        let reset = SettingsActionRow(title: String(localized: "Reset Sidebar"))
        reset.onClick = { WorkSidebarPreferences.reset() }
        let sidebarStack = NSStackView(views: [group, SettingsGroupView(rows: [reset])])
        sidebarStack.orientation = .vertical
        sidebarStack.alignment = .width
        sidebarStack.spacing = 12
        renderWorkSidebar()

        return pageSections([
            .init(
                header: String(localized: "Sales"),
                content: salesStack,
                footer: String(localized: "Follows your account.")
            ),
            .init(
                header: String(localized: "Inbox"),
                content: inboxGroup,
                footer: String(localized: "What INBOX carries. Follows your account.")
            ),
            .init(
                header: String(localized: "Sidebar"),
                content: sidebarStack,
                footer: String(localized: "Order and visibility are this Mac’s.")
            ),
        ])
    }

    private func renderWorkSidebar() {
        guard let workSidebarGroup else { return }
        let order = WorkSidebarPreferences.order()
        let hidden = WorkSidebarPreferences.hidden()
        var rows: [NSView] = []
        for (index, key) in order.enumerated() {
            guard let spec = WorkSidebarPreferences.spec(for: key) else { continue }
            let row = workSidebarRows[key] ?? makeWorkSidebarRow(for: spec)
            row.render(
                enabled: !hidden.contains(key),
                isFirst: index == 0,
                isLast: index == order.count - 1,
                saving: false
            )
            rows.append(row)
        }
        workSidebarGroup.setRows(rows)
    }

    private func makeWorkSidebarRow(for spec: WorkSidebarSectionSpec) -> SettingsOrderRow {
        let row = SettingsOrderRow(
            title: spec.title.capitalized,
            detail: spec.detail,
            surface: "Work",
            canHide: true
        )
        row.onMove = { [weak self] direction in
            guard let self else { return }
            let order = WorkSidebarPreferences.order()
            WorkSidebarPreferences.setOrder(WorkSidebarPreferences.moved(
                spec.key,
                by: direction == .up ? -1 : 1,
                order: order,
                hidden: []
            ))
            self.renderWorkSidebar()
        }
        row.onToggle = { [weak self] visible in
            guard let self else { return }
            WorkSidebarPreferences.setVisible(visible, for: spec.key)
            self.renderWorkSidebar()
        }
        workSidebarRows[spec.key] = row
        return row
    }

    private func refreshWorkSales() async {
        let signedIn = (try? ownerSessionStore.load()) != nil
        workSalesGroup?.isHidden = !signedIn
        workInboxGroup?.isHidden = !signedIn
        workSalesSignedOutLabel?.isHidden = signedIn
        guard signedIn, let state = try? await controlAPI.crmSubjectState() else { return }
        applyWorkKinds(state)
        workInboxSources = state.inboxSources
        workInboxAvailableSources = Set(state.inboxAvailableSources)
        renderWorkInboxSources()
        renderWorkSidebar()
    }

    /// Each switch draws the resolved answer; Sales touches follow the
    /// Sales opt-in above, so that row is dimmed while Sales is off.
    private func renderWorkInboxSources() {
        let resolved = InboxSourceSpec.resolve(workInboxSources)
        for (source, row) in workInboxRows {
            row.isHidden = !workInboxAvailableSources.contains(source)
            row.isOn = resolved[source] ?? true
            row.isEnabled = !workInboxSaving && (source != "sales" || workSalesEnabled)
        }
    }

    /// Sent whole, drawn from the Worker's answer; on failure the switch
    /// goes back.
    private func saveWorkInboxSource(_ source: String, on: Bool) {
        guard !workInboxSaving else {
            renderWorkInboxSources()
            return
        }
        var next = workInboxSources
        next[source] = on
        workInboxSaving = true
        renderWorkInboxSources()
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                self.workInboxSaving = false
                self.renderWorkInboxSources()
            }
            do {
                let state = try await self.controlAPI.crmSetWorkPreferences(inboxSources: next)
                self.workInboxSources = state.inboxSources
            } catch {
                self.presentAlert((error as? StarlingsError)?.message ?? String(localized: "Couldn’t change Inbox."))
            }
        }
    }

    /// The switches drawn from the Worker's answer: shown unless hidden,
    /// offered only where the kind's work module is on.
    private func applyWorkKinds(_ state: SubjectStateResponse) {
        homeWorkModules = state.workModules
        renderHomeLayout()
        workSalesEnabled = state.salesEnabled
        workHiddenKinds = state.resolvedHiddenKinds
        let offered = Set(ShownKindRow.offered(workModules: state.workModules).map(\.id))
        for (kind, row) in workKindRows {
            row.isHidden = !offered.contains(kind)
            row.isOn = !workHiddenKinds.contains(kind)
        }
    }

    /// Sent first, drawn after: the hidden kinds decide what Work and INBOX
    /// carry, so the Worker's answer is the one to draw. On failure the
    /// switch goes back.
    private func saveWorkKind(_ kind: String, shown: Bool) {
        guard !workSalesSaving else {
            workKindRows[kind]?.isOn = !workHiddenKinds.contains(kind)
            return
        }
        let others = workHiddenKinds.filter { $0 != kind }
        let next = shown ? others : others + [kind]
        workSalesSaving = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.workSalesSaving = false }
            do {
                let state = try await self.controlAPI.crmSetWorkPreferences(hiddenKinds: next)
                self.applyWorkKinds(state)
                // Showing leads also shows the block if this Mac had hidden
                // it, and tells any open Work window either way.
                if kind == "lead" { WorkSidebarPreferences.setVisible(state.salesEnabled, for: "work.leads") }
                self.renderWorkSidebar()
                self.renderWorkInboxSources()
            } catch {
                self.workKindRows[kind]?.isOn = !self.workHiddenKinds.contains(kind)
                self.presentAlert((error as? StarlingsError)?.message ?? String(localized: "Couldn’t change Work."))
            }
        }
    }

    private func makeUpcomingPreferencesGroup() -> SettingsGroupView {
        let followingChoices = [0, 1, 2, 3, 4]
        let followingRow = SettingsChoiceRow(
            title: String(localized: "Following meetings"),
            options: followingChoices.map { count in
                count == 0 ? String(localized: "None") : String(localized: "\(count) meetings")
            },
            selectedIndex: followingChoices.firstIndex(of: upcomingPreferences.homeFollowingRows) ?? 2
        )
        followingRow.onSelect = { [weak self] index in
            guard let self, followingChoices.indices.contains(index) else { return }
            let next = UpcomingPreferencesWire(
                horizonDays: self.upcomingPreferences.horizonDays,
                homeFollowingRows: followingChoices[index],
                showTomorrow: self.upcomingPreferences.showTomorrow
            )
            self.saveUpcomingPreferences(next)
        }
        upcomingFollowingRowsRow = followingRow

        return SettingsGroupView(rows: [followingRow])
    }

    private func refreshUpcomingPreferences() async {
        guard (try? ownerSessionStore.load()) != nil else {
            upcomingPreferences = .defaults
            renderUpcomingPreferences()
            return
        }
        guard let preferences = try? await controlAPI.calendarPreferences() else { return }
        upcomingPreferences = preferences.upcoming
        renderUpcomingPreferences()
    }

    private func renderUpcomingPreferences() {
        let followingChoices = [0, 1, 2, 3, 4]
        upcomingFollowingRowsRow?.select(followingChoices.firstIndex(of: upcomingPreferences.homeFollowingRows) ?? 2)
    }

    private func saveUpcomingPreferences(_ preferences: UpcomingPreferencesWire) {
        upcomingPreferences = preferences
        renderUpcomingPreferences()
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await calendarWorkspace.setUpcomingPreferences(preferences)
                NotificationCenter.default.post(name: CalendarSourcePreferences.upcomingDidChange, object: nil)
            } catch {
                presentAlert((error as? StarlingsError)?.message ?? String(localized: "Couldn’t save Upcoming settings."))
                await refreshUpcomingPreferences()
            }
        }
    }

    private func makeWeatherGroup() -> NSView {
        let showRow = SettingsToggleRow(
            title: String(localized: "Show weather"),
            detail: String(localized: "A symbol and the day’s high and low, beside each day in the week and day views."),
            symbolName: "cloud.sun"
        )
        showRow.isOn = WeatherPreferences.showsWeather()
        showRow.onChange = { WeatherPreferences.setShowsWeather($0) }

        let stored = WeatherPreferences.place()
        let locationRow = SettingsTextEntryRow(
            title: String(localized: "Location"),
            placeholder: String(localized: "City"),
            detail: Self.weatherLocationDetail(stored)
        )
        locationRow.text = stored?.name ?? ""
        locationRow.onCommit = { [weak locationRow] query in
            guard let locationRow else { return }
            guard !query.isEmpty else {
                WeatherPreferences.setPlace(nil)
                locationRow.setDetail(Self.weatherLocationDetail(nil))
                return
            }
            locationRow.setDetail(String(localized: "Looking up \(query)…"))
            Task { @MainActor in
                switch await WeatherForecastService.search(matching: query) {
                case let .unreachable(diagnostic):
                    // Never "no such place" — that blames their spelling for
                    // what is almost always a network fault.
                    let error = StarlingsError.weatherLookupUnavailable(diagnostic)
                    StarlingsDiagnosticsLog.shared.record(error, context: "weather place lookup")
                    locationRow.setDetail(String(localized: "\(error.message) Check your connection and press Return to try again."))
                case let .matches(places):
                    guard let place = places.first else {
                        locationRow.setDetail(String(localized: "No place found for “\(query)”. Check the spelling, or try adding the country."))
                        return
                    }
                    WeatherPreferences.setPlace(place)
                    locationRow.text = place.name
                    locationRow.setDetail(Self.weatherLocationDetail(place))
                }
            }
        }

        return SettingsGroupView(rows: [showRow, locationRow])
    }

    /// Shows the coordinate as well as the name, because the coordinate is the
    /// part that leaves the Mac — two decimals of it, and nothing else.
    private static func weatherLocationDetail(_ place: WeatherPlace?) -> String {
        guard let place else { return "Type a city and press Return. Empty means no weather and no lookups." }
        return String(format: "%@ · %.2f, %.2f", place.name, place.latitude, place.longitude)
    }

    private func makeCalendarBehaviourGroup() -> NSView {
        let hourTitles = (0...23).map { CalendarWeekMath.hourLabel($0) }

        let viewRow = SettingsChoiceRow(
            title: String(localized: "Default view"),
            options: CalendarViewMode.allCases.map(\.label),
            selectedIndex: CalendarViewMode.allCases.firstIndex(of: CalendarWindowPreferences.defaultView()) ?? 1
        )
        viewRow.onSelect = { index in
            guard CalendarViewMode.allCases.indices.contains(index) else { return }
            CalendarWindowPreferences.setDefaultView(CalendarViewMode.allCases[index])
        }

        let startRow = SettingsChoiceRow(
            title: String(localized: "Day view starts"),
            options: hourTitles,
            selectedIndex: CalendarWindowPreferences.dayStartHour()
        )
        startRow.onSelect = { CalendarWindowPreferences.setDayStartHour($0) }

        let endRow = SettingsChoiceRow(
            title: String(localized: "Day view ends"),
            options: hourTitles,
            selectedIndex: CalendarWindowPreferences.dayEndHour()
        )
        endRow.onSelect = { CalendarWindowPreferences.setDayEndHour($0) }

        let durationRow = SettingsChoiceRow(
            title: String(localized: "Default event length"),
            options: CalendarWindowPreferences.durationChoices.map { "\($0) minutes" },
            selectedIndex: CalendarWindowPreferences.durationChoices
                .firstIndex(of: CalendarWindowPreferences.defaultDurationMinutes()) ?? 3
        )
        durationRow.onSelect = { index in
            guard CalendarWindowPreferences.durationChoices.indices.contains(index) else { return }
            CalendarWindowPreferences.setDefaultDurationMinutes(CalendarWindowPreferences.durationChoices[index])
        }

        let declinedRow = SettingsToggleRow(
            title: String(localized: "Show declined events"),
            detail: String(localized: "Keep events you said no to visible in the grid.")
        )
        declinedRow.isOn = CalendarWindowPreferences.showsDeclined()
        declinedRow.onChange = { CalendarWindowPreferences.setShowsDeclined($0) }

        let hiddenRow = SettingsToggleRow(
            title: String(localized: "Show hidden events"),
            detail: String(localized: "Draw events you hid from Next faded in the grid, so you can show them again.")
        )
        hiddenRow.isOn = CalendarWindowPreferences.showsHidden()
        hiddenRow.onChange = { CalendarWindowPreferences.setShowsHidden($0) }

        return SettingsGroupView(rows: [viewRow, startRow, endRow, durationRow, declinedRow, hiddenRow])
    }

    private func makeVideoPage() -> NSView {
        let page = VideoSettingsPageView(devices: devices)
        page.onOpenCameraPrivacy = { [weak self] in self?.openCameraPrivacy() }
        videoSettingsPage = page
        return page
    }

    private func makeAudioPage() -> NSView {
        openMicrophoneRow.onClick = { [weak self] in self?.openMicrophonePrivacy() }
        openMicModesRow.onClick = { MicrophoneModes.showSystemPicker() }

        let deviceGroup = SettingsGroupView(rows: [microphonePicker])
        let meterGroup = SettingsGroupView(rows: [audioMeter])
        let statusGroup = SettingsGroupView(rows: [microphoneRow])
        let microphonePrivacy = SettingsGroupView(rows: [openMicrophoneRow])
        microphonePrivacyGroup = microphonePrivacy
        refreshVoiceProcessing()
        let modesGroup = SettingsGroupView(rows: [voiceProcessingRow, openMicModesRow])

        let spatialRow = SettingsToggleRow(
            title: String(localized: "Spatial audio"),
            detail: String(localized: "Each voice comes from where that person’s tile is on the stage. Best on headphones."),
            symbolName: "person.wave.2.fill"
        )
        spatialRow.isOn = SpatialAudioPreferences.isEnabled()
        spatialRow.onChange = { on in SpatialAudioPreferences.setEnabled(on) }
        let spatialGroup = SettingsGroupView(rows: [spatialRow])

        return pageSections([
            .init(
                header: String(localized: "Microphone"),
                content: deviceGroup,
                footer: String(localized: "Choose which microphone Starlings uses for meetings on this Mac.")
            ),
            .init(
                header: String(localized: "Listening"),
                content: spatialGroup,
                footer: String(localized: "Best on headphones. Screen-share audio stays in the centre.")
            ),
            .init(
                header: String(localized: "Tester"),
                content: meterGroup,
                footer: String(localized: "Check that this Mac is receiving input from the selected microphone.")
            ),
            .init(content: statusGroup),
            .init(content: microphonePrivacy),
            .init(
                header: String(localized: "Mic Modes"),
                content: modesGroup,
                footer: String(localized: "Voice Isolation and other mic modes are controlled by macOS. Starlings is offered a mode only while it captures through Apple voice processing; the row above says whether it does.")
            ),
        ])
    }

    /// Recording meetings Meet did not host (docs/AMBIENT_CAPTURE.md): the
    /// pairing token the browser extension needs, and the resume window.
    private func makeMeetingsPage() -> NSView {
        let tokenRow = SettingsInfoRow(title: String(localized: "Browser extension"), showsStatusDot: false)
        tokenRow.update(state: .unknown, detail: String(localized: "Paste the pairing token into the Starlings extension’s options in Chrome."))
        let copy = NSButton(title: String(localized: "Copy pairing token"), target: self, action: #selector(copyPairingToken))
        copy.bezelStyle = .rounded
        tokenRow.setTrailing(copy)

        let graceRow = SettingsInfoRow(title: String(localized: "Resume window"), showsStatusDot: false)
        graceRow.update(state: .unknown, detail: String(localized: "After a call ends on its own, rejoining within this window continues the same recording."))
        let picker = NSPopUpButton(frame: .zero, pullsDown: false)
        let choices: [(String, TimeInterval)] = [("Off", 0), ("1 minute", 60), ("2 minutes", 120), ("5 minutes", 300), ("10 minutes", 600)]
        for (title, seconds) in choices {
            picker.addItem(withTitle: title)
            picker.lastItem?.representedObject = seconds
        }
        let current = StarlingsAutomationController.graceSeconds
        picker.selectItem(at: choices.firstIndex { $0.1 == current } ?? 3)
        picker.target = self
        picker.action = #selector(graceWindowChanged(_:))
        graceRow.setTrailing(picker)

        let askRow = SettingsToggleRow(title: String(localized: "Ask who was there"), detail: String(localized: "When a recording stops and nobody said who was in it, ask — the names label the speakers and the action items."))
        askRow.isOn = AttendeeConfirmation.isEnabled
        askRow.onChange = { on in AttendeeConfirmation.isEnabled = on }

        let zoomRow = SettingsToggleRow(title: String(localized: "Read Zoom for names"), detail: String(localized: "With the Accessibility permission, Starlings reads who is in a Zoom meeting and who is speaking from Zoom’s own window — names and timing only — so a Zoom call offers to record itself and its speakers come out by name."))
        zoomRow.isOn = ZoomCallReader.isEnabled && ZoomCallReader.isTrusted
        zoomRow.onChange = { on in
            ZoomCallReader.isEnabled = on
            if on, !ZoomCallReader.isTrusted { ZoomCallReader.requestTrust() }
        }

        return pageSections([
            .init(
                header: String(localized: "Recording"),
                content: SettingsGroupView(rows: [tokenRow, graceRow, askRow, zoomRow]),
                footer: String(localized: "Record this meeting lives in the menu bar. With the extension installed, a Google Meet call offers to record itself and stops when the call ends.")
            ),
        ])
    }

    private func makeRoomPage() -> NSView {
        roomPolicyRow.isEnabled = false
        roomPolicyRow.onChange = { [weak self] value in self?.setRoomPolicy(value) }
        roomPolicyStatusRow.update(state: .unknown, detail: String(localized: "Loading room settings…"))
        let group = SettingsGroupView(rows: [roomPolicyRow, roomPolicyStatusRow])
        return pageSections([
            .init(
                header: String(localized: "Recording notetakers"),
                content: group,
                footer: String(localized: "This policy applies to declared recording notetakers in your permanent room.")
            ),
        ])
    }

    private func refreshRoomPolicy() async {
        guard !roomPolicySaving else { return }
        guard (try? ownerSessionStore.load()) != nil else {
            roomPolicyRoom = nil
            roomPolicyRow.isOn = false
            roomPolicyRow.isEnabled = false
            roomPolicyStatusRow.update(state: .restricted, detail: String(localized: "Sign in to load your room setting."))
            return
        }

        roomPolicyRow.isEnabled = false
        roomPolicyStatusRow.update(state: .unknown, detail: String(localized: "Loading room settings…"))
        do {
            let ownerRoom = try await controlAPI.ownerRoom()
            guard let room = RoomSlug(rawValue: ownerRoom.room.slug) else {
                roomPolicyRoom = nil
                roomPolicyStatusRow.update(state: .restricted, detail: String(localized: "Couldn’t load your room."))
                return
            }
            let snapshot = try await controlAPI.lobby(room: room)
            roomPolicyRoom = room
            roomPolicyRow.isOn = snapshot.roomSettings?.refuseRecorders ?? false
            roomPolicyRow.isEnabled = true
            roomPolicyStatusRow.update(state: .unknown, detail: "/room/\(room.rawValue)")
        } catch {
            roomPolicyRoom = nil
            roomPolicyRow.isEnabled = false
            roomPolicyStatusRow.update(state: .restricted, detail: error.localizedDescription)
        }
    }

    private func setRoomPolicy(_ refuseRecorders: Bool) {
        guard !roomPolicySaving, let room = roomPolicyRoom else { return }
        let previous = roomPolicyRow.isOn
        roomPolicySaving = true
        roomPolicyRow.isOn = refuseRecorders
        roomPolicyRow.isEnabled = false
        roomPolicyStatusRow.update(state: .unknown, detail: String(localized: "Saving room settings…"))
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                roomPolicySaving = false
                roomPolicyRow.isEnabled = true
            }
            do {
                let settings = try await controlAPI.updateRoomSettings(
                    room: room,
                    settings: RoomSettingsUpdate(refuseRecorders: refuseRecorders)
                )
                roomPolicyRow.isOn = settings.refuseRecorders
                roomPolicyStatusRow.update(state: .unknown, detail: "/room/\(room.rawValue)")
            } catch {
                roomPolicyRow.isOn = previous
                roomPolicyStatusRow.update(state: .restricted, detail: error.localizedDescription)
            }
        }
    }

    @objc private func copyPairingToken() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(StarlingsEventsPairing.token, forType: .string)
    }

    @objc private func graceWindowChanged(_ sender: NSPopUpButton) {
        StarlingsAutomationController.graceSeconds = sender.selectedItem?.representedObject as? TimeInterval ?? 300
    }

    private func makeCaptionsPage() -> NSView {
        prepareCaptionsButton.target = self
        prepareCaptionsButton.action = #selector(prepareCaptions)
        prepareCaptionsButton.applyMeetFilledStyle(
            .accent,
            title: String(localized: "Download speech model"),
            font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold),
            cornerRadius: 8
        )
        prepareCaptionsButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 180).isActive = true

        let modelGroup = SettingsGroupView(rows: [captionsRow])
        let actions = NSStackView(views: [prepareCaptionsButton, NSView()])
        actions.orientation = .horizontal
        actions.spacing = 10
        captionsActionsStack = actions

        for entry in languageRows {
            entry.row.isOn = TranscriptionLanguages.isSelected(entry.language)
            entry.row.onChange = { [weak self] _ in
                TranscriptionLanguages.toggle(entry.language)
                // Read back rather than trusting the switch: the store
                // normalizes, and a row that disagreed with it would be a
                // second answer to the same question.
                self?.refreshLanguageRows()
            }
        }
        let languageGroup = SettingsGroupView(rows: languageRows.map(\.row))
        let suggestionsGroup = SettingsGroupView(rows: [suggestionsRow])

        return pageSections([
            .init(
                header: String(localized: "Local Speech Model"),
                content: modelGroup,
                footer: String(localized: "Transcription runs on this Mac when you host.")
            ),
            .init(content: actions),
            .init(
                header: String(localized: "Task Suggestions"),
                content: suggestionsGroup,
                footer: String(localized: "What reads the transcript for commitments while you host.")
            ),
            .init(
                header: String(localized: "Languages On This Mac"),
                content: languageGroup,
                // Choosing a language does two things: narrows how a finished
                // line is labelled, and — since both are Latin-script — keeps
                // FluidAudio decoding in Latin script instead of wandering into
                // Cyrillic mid-meeting. It does not teach the model to tell
                // English from Portuguese by ear. See `TranscriptionLanguages`.
                footer: String(localized: "All off allows any language.")
            ),
        ])
    }

    private func refreshSuggestionsEngine() {
        let status = TaskSuggestionEngineFactory.status()
        suggestionsRow.update(
            state: status.mode == .off ? .unknown : (status.available ? .allowed : .restricted),
            detail: "\(status.name) — \(status.detail)"
        )
    }

    /// Put every switch back in step with the stored selection.
    private func refreshLanguageRows() {
        for entry in languageRows {
            entry.row.isOn = TranscriptionLanguages.isSelected(entry.language)
        }
    }

    /// What this Mac announces, and the honest ceiling of it: every notice
    /// fires only while Meet is running, and whether it shows as a banner is
    /// macOS's own decision, reached through the one door to that setting.
    /// See `StarlingsNotices`. The one thing that *is* a Meet preference, not a
    /// system one, is how loud a channel gets — see `MessageNotificationPreferences`.
    private func makeNotificationsPage() -> NSView {
        let knock = SettingsInfoRow(title: String(localized: "Someone knocks on your room"), showsStatusDot: false)
        let wave = SettingsInfoRow(title: String(localized: "A colleague waves at you or calls"), showsStatusDot: false)
        let message = SettingsInfoRow(title: String(localized: "A message arrives while you are in another window"), showsStatusDot: false)
        let system = SettingsActionRow(title: String(localized: "Banners and sounds"), detail: String(localized: "macOS Notifications"))
        system.onClick = { SystemSettingsOpener.openNotifications() }

        let allChannelMessages = SettingsToggleRow(
            title: String(localized: "Every channel message"),
            detail: String(localized: "Off notifies only when a channel names you."),
            symbolName: "bubble.left.and.bubble.right.fill"
        )
        allChannelMessages.isOn = MessageNotificationPreferences.notifiesOnAllChannelMessages()
        allChannelMessages.onChange = { MessageNotificationPreferences.setNotifiesOnAllChannelMessages($0) }

        return pageSections([
            .init(
                header: String(localized: "While Starlings is running"),
                content: SettingsGroupView(rows: [knock, wave, message]),
                footer: MeetingAlertSettings.openOnlyFooter
            ),
            .init(
                header: String(localized: "Channels"),
                content: SettingsGroupView(rows: [allChannelMessages]),
                footer: String(localized: "A direct message or group conversation always notifies — this only widens or narrows a project or lead channel.")
            ),
            .init(
                header: String(localized: "System"),
                content: SettingsGroupView(rows: [system]),
                footer: String(localized: "Change banners and sounds in System Settings › Notifications › Starlings.")
            ),
        ])
    }

    private func makeAppearancePage() -> NSView {
        let row = SettingsChoiceRow(
            title: String(localized: "Theme"),
            options: StarlingsAppearanceMode.allCases.map(\.title),
            selectedIndex: StarlingsAppearanceMode.allCases.firstIndex(of: StarlingsAppearanceSettings.mode()) ?? 0
        )
        row.onSelect = { index in
            guard StarlingsAppearanceMode.allCases.indices.contains(index) else { return }
            StarlingsAppearanceSettings.setMode(StarlingsAppearanceMode.allCases[index])
        }
        appearanceChoiceRow = row

        let group = SettingsGroupView(rows: [row])
        let tabsRow = SettingsToggleRow(
            title: String(localized: "Use tabs"),
            detail: String(localized: "Open Home, Calendar, Work, Team, and Docs as tabs in one window. Turn off to use separate windows."),
            symbolName: "macwindow.on.rectangle"
        )
        tabsRow.isOn = StarlingsWindowChrome.usesTabs()
        tabsRow.onChange = { StarlingsWindowChrome.setUsesTabs($0) }
        useTabsRow = tabsRow

        let textSizeRow = SettingsChoiceRow(
            title: String(localized: "Text size"),
            options: StarlingsTextSize.allCases.map(\.title),
            selectedIndex: StarlingsTextSize.allCases.firstIndex(of: StarlingsTextSize.current()) ?? 0
        )
        textSizeRow.onSelect = { index in
            guard StarlingsTextSize.allCases.indices.contains(index) else { return }
            StarlingsTextSize.set(StarlingsTextSize.allCases[index])
        }

        let languageRow = SettingsChoiceRow(
            title: String(localized: "Language"),
            options: StarlingsLanguageChoice.offeredCases.map(\.title),
            selectedIndex: StarlingsLanguageChoice.offeredCases.firstIndex(of: StarlingsLanguageChoice(StarlingsLanguageCache.load())) ?? 0
        )
        languageRow.onSelect = { [weak self] index in
            guard StarlingsLanguageChoice.offeredCases.indices.contains(index) else { return }
            self?.saveLanguage(StarlingsLanguageChoice.offeredCases[index].language)
        }
        languageChoiceRow = languageRow
        // The Language section is parked until product-market fit: `languageRow` is built but not placed.

        let textureRow = SettingsToggleRow(
            title: String(localized: "Grid texture"),
            detail: String(localized: "A faint square grid behind Home and the meeting Stage."),
            symbolName: "grid"
        )
        textureRow.isOn = HomeTexturePreferences.showsTexture()
        textureRow.onChange = { HomeTexturePreferences.setShowsTexture($0) }
        homeTextureRow = textureRow

        return pageSections([
            .init(
                header: String(localized: "Theme"),
                content: group,
                footer: String(localized: "Auto follows macOS.")
            ),
            .init(
                header: String(localized: "Windows"),
                content: SettingsGroupView(rows: [tabsRow]),
                footer: String(localized: "This Mac only.")
            ),
            .init(
                header: String(localized: "Text"),
                content: SettingsGroupView(rows: [textSizeRow]),
                footer: String(localized: "This Mac only. A window you open next uses the new size; reopen an open one to apply it.")
            ),
            .init(
                header: String(localized: "Home"),
                content: SettingsGroupView(rows: [textureRow]),
                footer: String(localized: "This Mac only.")
            ),
        ])
    }

    private func makeAboutPage() -> NSView {
        let name = NSHostingView(rootView: StarlingsWordmark(size: 30, ink: Color(nsColor: StarlingsColors.primaryText)))

        let version = NSTextField(labelWithString: Self.versionString())
        version.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        version.textColor = StarlingsColors.secondaryText
        version.alignment = .center

        let blurb = StarlingsTypography.wrappingLabel(String(localized: "One workspace for a team and its agents."))
        blurb.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        blurb.textColor = StarlingsColors.secondaryText
        blurb.alignment = .center

        let brandStack = NSStackView(views: [name, version, blurb])
        brandStack.orientation = .vertical
        brandStack.alignment = .centerX
        brandStack.spacing = 8
        brandStack.setCustomSpacing(6, after: name)
        brandStack.setCustomSpacing(12, after: version)

        let brandCard = NSView()
        SettingsChrome.applyGroupSurface(brandCard)
        brandCard.addSubview(brandStack)
        brandStack.pinToEdges(of: brandCard, insets: NSEdgeInsets(top: 28, left: 24, bottom: 28, right: 24))

        automaticUpdatesRow.isOn = UpdateChecker.shared.automaticChecksEnabled
        automaticUpdatesRow.onChange = { enabled in
            UpdateChecker.shared.automaticChecksEnabled = enabled
        }
        checkUpdatesRow.onClick = { [weak self] in
            self?.updateInstallMessage = nil
            Task { await UpdateChecker.shared.check() }
        }
        installUpdateRow.onClick = { [weak self] in
            self?.installAvailableUpdate()
        }
        let updates = SettingsGroupView(rows: [
            updatesStatusRow,
            automaticUpdatesRow,
            checkUpdatesRow,
        ])
        updatesGroup = updates
        let updatesFooter = StarlingsTypography.wrappingLabel("")
        updatesFooter.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        updatesFooter.textColor = StarlingsColors.secondaryText
        updatesFooterLabel = updatesFooter

        let privacyRow = SettingsActionRow(title: String(localized: "Privacy"))
        privacyRow.onClick = { [weak self] in self?.openPrivacy() }
        let termsRow = SettingsActionRow(title: String(localized: "Terms of use"))
        termsRow.onClick = { [weak self] in self?.openTerms() }
        let linksGroup = SettingsGroupView(rows: [privacyRow, termsRow])

        let copyright = NSTextField(labelWithString: String(localized: "© Starlings"))
        copyright.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        copyright.textColor = StarlingsColors.secondaryText
        copyright.alignment = .center

        NSLayoutConstraint.activate([
            blurb.widthAnchor.constraint(lessThanOrEqualToConstant: 360),
        ])

        refreshUpdates()

        return pageSections([
            .init(content: brandCard),
            .init(header: String(localized: "Updates"), content: updates, footer: nil),
            .init(content: updatesFooter),
            .init(header: String(localized: "Legal"), content: linksGroup),
            .init(content: copyright),
        ])
    }

    private func beginUpdateMonitoring() {
        guard updateObserver == nil else { return }
        updateObserver = NotificationCenter.default.addObserver(
            forName: UpdateChecker.didChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.refreshUpdates() }
        }
    }

    private func refreshUpdates() {
        let checker = UpdateChecker.shared
        checkUpdatesRow.setTitle(checker.isChecking ? String(localized: "Checking…") : String(localized: "Check for updates"))
        checkUpdatesRow.setEnabled(!checker.isChecking)
        automaticUpdatesRow.isOn = checker.automaticChecksEnabled

        if let found = checker.available {
            let remote = checker.latestSummary ?? found.version
            updatesStatusRow.update(
                state: .allowed,
                detail: "\(UpdateCheck.installedVersion) → \(remote)"
            )
        } else if checker.lastError != nil {
            updatesStatusRow.update(state: .unknown, detail: String(localized: "Couldn’t check"))
        } else if let summary = checker.latestSummary {
            updatesStatusRow.update(state: .allowed, detail: String(localized: "Up to date · \(summary)"))
        } else if checker.lastChecked != nil {
            updatesStatusRow.update(state: .allowed, detail: String(localized: "Up to date"))
        } else {
            updatesStatusRow.update(state: .unknown, detail: UpdateCheck.installedVersion)
        }

        var rows: [NSView] = [updatesStatusRow, automaticUpdatesRow, checkUpdatesRow]
        if checker.available != nil, UpdateCheck.canSelfUpdate {
            rows.append(installUpdateRow)
        }
        updatesGroup?.setRows(rows)

        if let updateInstallMessage {
            updatesFooterLabel?.stringValue = updateInstallMessage
        } else if !UpdateCheck.canSelfUpdate {
            updatesFooterLabel?.stringValue = String(localized: "Updates install to /Applications. This copy runs from somewhere else.")
        } else if checker.lastError != nil {
            updatesFooterLabel?.stringValue = String(localized: "Couldn’t reach the update feed. Try again when you’re online.")
        } else {
            updatesFooterLabel?.stringValue = String(localized: "Starlings checks weekly for updates and asks before installing.")
        }
    }

    private func installAvailableUpdate() {
        guard let found = UpdateChecker.shared.available else { return }
        do {
            try UpdateInstaller.install(found)
        } catch {
            updateInstallMessage = error.localizedDescription
            refreshUpdates()
        }
    }

    private struct PageSection {
        var header: String? = nil
        var content: NSView
        var footer: String? = nil
    }

    private func pageSections(_ sections: [PageSection]) -> NSView {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false

        for (index, section) in sections.enumerated() {
            if index > 0 {
                let spacer = NSView()
                spacer.translatesAutoresizingMaskIntoConstraints = false
                spacer.heightAnchor.constraint(equalToConstant: 18).isActive = true
                stack.addArrangedSubview(spacer)
                spacer.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            }

            if let header = section.header {
                let label = sectionHeader(header)
                stack.addArrangedSubview(label)
                label.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
                stack.setCustomSpacing(8, after: label)
            }

            stack.addArrangedSubview(section.content)
            section.content.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

            if let footer = section.footer {
                stack.setCustomSpacing(8, after: section.content)
                let label = sectionFooter(footer)
                stack.addArrangedSubview(label)
                label.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            }
        }

        let wrap = NSView()
        wrap.addSubview(stack)
        stack.pinToEdges(of: wrap)
        return wrap
    }

    private func sectionHeader(_ title: String) -> NSTextField {
        let label = NSTextField(labelWithString: title.uppercased())
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold)
        label.textColor = StarlingsColors.secondaryText
        return label
    }

    private func sectionFooter(_ text: String) -> NSTextField {
        let label = StarlingsTypography.wrappingLabel(text)
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        label.textColor = StarlingsColors.secondaryText
        return label
    }

    private func selectPage(_ page: Page) {
        if selectedPage == .audio, page != .audio {
            audioMeter.stop()
        }
        selectedPage = page
        detailTitle.stringValue = StarlingsSettingsRegistry.title(for: page)
        detailContainer.subviews.forEach { $0.removeFromSuperview() }
        if let pageView = pageViews[page] {
            detailContainer.addSubview(pageView)
            pageView.pinToEdges(of: detailContainer)
        }
        for item in navItems {
            item.setSelected(item.pageTag == page.rawValue)
        }
        videoSettingsPage?.setActive(page == .video)
    }

    private func refreshAccount() {
        refreshWorkspaces()
        lobbyKnockAlertsRow.isOn = LobbyKnockPreferences.alertsEnabled
        refreshCore()
        // The workspace names the row: which one this Mac is signed in to,
        // and with which address.
        let workspace = StarlingsWorkspaceStore.shared.current
        accountConnection.connectTitle = String(localized: "Sign in")
        if let credentials = try? ownerSessionStore.load() {
            accountConnection.apply(.connected(title: workspace.name, detail: credentials.owner.email))
        } else {
            accountConnection.apply(.disconnected(
                title: String(localized: "Not signed in"),
                detail: String(localized: "Required to host meetings")
            ))
            calendarConnection.apply(.unavailable(
                title: String(localized: "Google Calendar"),
                detail: String(localized: "Sign in to connect")
            ))
        }
    }

    /// What the server says your picture is right now.
    ///
    /// Read from the roster rather than from a route of its own: your own row
    /// already carries `avatarUpdatedAt`, and it is the same answer every
    /// colleague's client is drawing you from — so this page cannot disagree
    /// with the sidebar about whether you have a picture.
    private func refreshPicture() async {
        guard let credentials = try? ownerSessionStore.load() else {
            pictureVersion = nil
            pictureRow.update(state: .unknown, detail: "")
            pictureAvatar.setIdentity(StarlingsAvatarIdentity(displayName: "You"))
            choosePictureButton.isHidden = true
            removePictureButton.isHidden = true
            return
        }
        choosePictureButton.isHidden = false
        let me = try? await controlAPI.peers().me
        pictureVersion = me?.avatarUpdatedAt
        applyPicture(name: me?.displayName ?? credentials.owner.name, email: credentials.owner.email)
    }

    /// One place that draws the well, the row and the buttons from the same
    /// three facts, so "has a picture" can never be true in one of them and
    /// false in another.
    private func applyPicture(name: String, email: String) {
        pictureAvatar.setIdentity(StarlingsAvatarIdentity(
            displayName: name,
            email: email,
            avatarUpdatedAt: pictureVersion
        ))
        pictureRow.update(
            state: pictureVersion == nil ? .unknown : .allowed,
            detail: pictureVersion == nil ? String(localized: "Showing your initials") : String(localized: "Visible to your colleagues")
        )
        removePictureButton.isHidden = pictureVersion == nil
        choosePictureButton.isEnabled = !pictureBusy
        removePictureButton.isEnabled = !pictureBusy
    }

    @objc private func choosePicture() {
        guard !pictureBusy, let window = view.window else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.prompt = String(localized: "Use Picture")
        panel.message = "Choose a picture for your colleagues to see."
        // A sheet on this window rather than `runModal()`: Settings is already
        // a window somebody is looking at, and a detached modal in front of it
        // is the kind of panel that opens behind and reads as nothing
        // happening.
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .OK, let url = panel.url else { return }
            self.uploadPicture(from: url)
        }
    }

    private func uploadPicture(from url: URL) {
        guard let credentials = try? ownerSessionStore.load() else { return }
        // Squared and re-encoded here, because the Worker stores what it is
        // given and a photo off a camera is a multi-megabyte download for
        // every colleague who opens the roster.
        guard let image = NSImage(contentsOf: url),
              let jpeg = StarlingsProfilePicture.squareJPEG(from: image) else {
            pictureRow.update(state: .unknown, detail: String(localized: "That file isn’t a picture Starlings can read"))
            return
        }
        setPictureBusy(true, detail: String(localized: "Uploading…"))
        Task { @MainActor in
            do {
                pictureVersion = try await controlAPI.uploadProfileAvatar(jpeg)
                StarlingsAvatarImageCache.shared.forget(email: credentials.owner.email)
                await PersonAvatarStore.shared.forget(
                    email: credentials.owner.email,
                    version: pictureVersion
                )
                setPictureBusy(false)
                applyPicture(name: credentials.owner.name, email: credentials.owner.email)
            } catch {
                setPictureBusy(false)
                pictureRow.update(state: .unknown, detail: (error as? StarlingsError)?.message ?? String(localized: "Couldn’t save that picture"))
            }
        }
    }

    @objc private func removePicture() {
        guard !pictureBusy, let credentials = try? ownerSessionStore.load() else { return }
        setPictureBusy(true, detail: String(localized: "Removing…"))
        Task { @MainActor in
            do {
                try await controlAPI.removeProfileAvatar()
                pictureVersion = nil
                StarlingsAvatarImageCache.shared.forget(email: credentials.owner.email)
                await PersonAvatarStore.shared.forget(email: credentials.owner.email)
                setPictureBusy(false)
                applyPicture(name: credentials.owner.name, email: credentials.owner.email)
            } catch {
                setPictureBusy(false)
                pictureRow.update(state: .unknown, detail: (error as? StarlingsError)?.message ?? String(localized: "Couldn’t remove that picture"))
            }
        }
    }

    private func setPictureBusy(_ busy: Bool, detail: String? = nil) {
        pictureBusy = busy
        choosePictureButton.isEnabled = !busy
        removePictureButton.isEnabled = !busy
        if let detail { pictureRow.update(state: .unknown, detail: detail) }
    }

    private func refreshCalendar() async {
        guard !calendarBusy else { return }
        guard (try? ownerSessionStore.load()) != nil else {
            calendarPickerGroup?.isHidden = true
            return
        }
        do {
            var status = try await controlAPI.calendarStatus()
            // Just connected and KV still serving the miss it cached before the
            // token was written — see `CalendarSourcePreferences.googleConnectionGrace`.
            if !status.connected, CalendarSourcePreferences.googleConnectionRecentlyAsserted() {
                status = CalendarConnectionStatus(connected: true, email: (try? ownerSessionStore.load())?.owner.email)
            }
            applyCalendarStatus(status)
            await refreshCalendarPicker(googleConnected: status.connected)
        } catch {
            // 401 clears the Keychain in MeetingControlAPI — refresh account chrome.
            if (try? ownerSessionStore.load()) == nil {
                refreshAccount()
                onSessionChanged?(nil)
                return
            }
            calendarConnection.apply(.disconnected(
                title: String(localized: "Google Calendar"),
                detail: String(localized: "Couldn’t load status")
            ))
            await refreshCalendarPicker(googleConnected: false)
        }
    }

    private func applyCalendarStatus(_ status: CalendarConnectionStatus) {
        bookingHoursView.calendarConnected = status.connected
        if status.connected {
            calendarConnection.apply(.connected(
                title: String(localized: "Connected"),
                detail: status.email ?? String(localized: "Google Calendar")
            ))
        } else if !StarlingsWorkspace.active.calendarConnectable {
            calendarConnection.apply(.unavailable(
                title: String(localized: "Not connected"),
                detail: String(localized: "Calendar connects to Google only.")
            ))
        } else {
            calendarConnection.apply(.disconnected(
                title: String(localized: "Not connected"),
                detail: String(localized: "Needed to schedule and list meetings")
            ))
        }
    }

    private func refreshCalendarPicker(
        googleConnected: Bool,
        knownCalendars: [GoogleCalendarListEntry]? = nil
    ) async {
        if let knownCalendars {
            availableCalendars = knownCalendars
        } else if googleConnected {
            do {
                availableCalendars = try await calendarWorkspace.googleCalendarEntries()
            } catch {
                availableCalendars = []
                calendarConnection.apply(.stale(
                    title: String(localized: "Connected"),
                    detail: String(localized: "Connected — reconnect to choose calendars for Upcoming"),
                    reconnectTitle: String(localized: "Reconnect")
                ))
            }
        } else {
            availableCalendars = []
        }
        let enabledSubscriptionIDs = Set(calendarWorkspace.calendars
            .filter { $0.source == .subscription }
            .map(\.rawID))
        availableUpcomingSubscriptions = calendarWorkspace.subscriptions
            .filter { enabledSubscriptionIDs.contains($0.id) }
        await calendarWorkspace.refreshUpcomingSubscriptionSelection()
        renderCalendarPicker()
    }

    private func renderCalendarPicker(_ calendars: [GoogleCalendarListEntry]? = nil) {
        guard let calendarPickerGroup else { return }
        if let calendars { availableCalendars = calendars }
        calendarPickerRows = availableCalendars.map { entry in
            let row = SettingsToggleRow(
                title: entry.summary,
                detail: Self.calendarPickerDetail(for: entry, selected: entry.selected)
            )
            row.isOn = entry.selected
            row.onChange = { [weak self, weak row] selected in
                row?.setDetail(Self.calendarPickerDetail(for: entry, selected: selected))
                Task { @MainActor in self?.persistCalendarSelection() }
            }
            return row
        }
        upcomingSubscriptionRows = availableUpcomingSubscriptions.map { subscription in
            let row = SettingsToggleRow(
                title: subscription.title,
                detail: String(localized: "Subscribed feed")
            )
            row.isOn = !calendarWorkspace.upcomingExcludedSubscriptionIDs.contains(subscription.id)
            row.onChange = { [weak self] _ in
                Task { @MainActor in self?.persistUpcomingSubscriptionSelection() }
            }
            return row
        }
        calendarPickerGroup.setRows(calendarPickerRows + upcomingSubscriptionRows)
        calendarPickerGroup.isHidden = calendarPickerRows.isEmpty && upcomingSubscriptionRows.isEmpty
    }

    private static func calendarPickerDetail(for entry: GoogleCalendarListEntry, selected: Bool) -> String {
        let calendarDetail = entry.primary ? String(localized: "Primary") : entry.id
        guard selected else { return calendarDetail }
        return "\(String(localized: "Subscribed")) · \(calendarDetail)"
    }

    /// Every account and calendar the app can reach, each with the one switch
    /// that decides whether it is in Meet at all.
    ///
    /// Two levels, because both questions get asked: whether a whole account
    /// belongs here — a personal iCloud, a work CalDAV, a Google account macOS
    /// also has a copy of — and, inside the accounts that do, which of their
    /// calendars are worth carrying. An account switched off hides its
    /// calendars from this page too: there is nothing left to say about them.
    private func refreshCalendarSources() async {
        await calendarWorkspace.refreshSources()
        renderCalendarSources()
    }

    private func renderCalendarSources() {
        calendarSourcesStack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        let localRow = SettingsToggleRow(
            title: String(localized: "Include local calendars"),
            detail: calendarWorkspace.includesLocalCalendars
                ? String(localized: "iCloud and calendars on this Mac")
                : "Off — Starlings does not read local events",
            symbolName: "laptopcomputer"
        )
        localRow.isOn = calendarWorkspace.includesLocalCalendars
        localRow.onChange = { [weak self] included in
            guard let self else { return }
            self.calendarWorkspace.setIncludesLocalCalendars(included)
            Task { @MainActor in await self.refreshCalendarSources() }
        }
        addSourceGroup(SettingsGroupView(rows: [localRow]))

        let all = calendarWorkspace.allCalendars
        guard !all.isEmpty else {
            let empty = SettingsInfoRow(title: String(localized: "No calendars yet"), showsStatusDot: false)
            empty.update(
                state: .unknown,
                detail: calendarWorkspace.eventKitAccess == .denied
                    ? String(localized: "Calendar access is off for Starlings in System Settings › Privacy & Security.")
                    : "Connect Google Calendar above, or allow Calendar access on this Mac."
            )
            addSourceGroup(SettingsGroupView(rows: [empty]))
            addAccountRepairRows()
            addCalendarSourceActions()
            return
        }

        for group in calendarWorkspace.sourceGroups {
            let members = group.calendars
            let enabled = !calendarWorkspace.isAccountDisabled(group.title)
            let accountRow = SettingsToggleRow(
                title: group.title,
                detail: Self.accountDetail(members: members, enabled: enabled),
                symbolName: group.symbolName
            )
            accountRow.isOn = enabled
            accountRow.onChange = { [weak self] isOn in
                guard let self else { return }
                self.calendarWorkspace.setAccountDisabled(group.title, disabled: !isOn)
                self.renderCalendarSources()
                Task { @MainActor in
                    await self.refreshCalendarPicker(googleConnected: !self.availableCalendars.isEmpty)
                }
            }

            var rows: [NSView] = [accountRow]
            if enabled {
                rows += members.map { calendar in
                    let row = SettingsToggleRow(
                        title: calendar.title,
                        detail: calendar.role == .globalInterest
                            ? String(localized: "Editable · Global interest")
                            : (calendar.isWritable ? "" : String(localized: "Read only")),
                        image: calendar.role == .globalInterest
                            ? StarlingsBrand.glyphImage(size: 14, color: StarlingsColors.secondaryText)
                            : nil
                    )
                    row.isOn = !self.calendarWorkspace.isDisabled(calendar)
                    row.onChange = { [weak self] isOn in
                        guard let self else { return }
                        self.calendarWorkspace.setDisabled(calendar, disabled: !isOn)
                        self.renderCalendarSources()
                        Task { @MainActor in
                            await self.refreshCalendarPicker(googleConnected: !self.availableCalendars.isEmpty)
                        }
                    }
                    return row
                }
            }
            addSourceGroup(SettingsGroupView(rows: rows))
        }
        addAccountRepairRows()
        addCalendarSourceActions()
    }

    /// The two ways a calendar gets *into* the app, kept with the list of what
    /// is already in it. The Calendar sidebar used to carry both; it is a list
    /// of switches for what you can see today, and adding an account or a feed
    /// is neither a switch nor about today.
    private func addCalendarSourceActions() {
        let addAccount = SettingsActionRow(
            title: String(localized: "Add another Google account"),
            detail: String(localized: "For its calendars only")
        )
        addAccount.onClick = { [weak self] in
            Task { @MainActor in await self?.addGoogleAccount() }
        }

        let subscribe = SettingsActionRow(
            title: String(localized: "Subscribe to a calendar…"),
            detail: String(localized: "webcal:// or .ics")
        )
        subscribe.onClick = { [weak self] in
            Task { @MainActor in await self?.promptForSubscription() }
        }

        addSourceGroup(SettingsGroupView(rows: [addAccount, subscribe]))
    }

    /// A second Google account, for its calendars only. The owner session is
    /// untouched by this — it is the credential that authorises the attach.
    private func addGoogleAccount() async {
        guard let window = view.window ?? NSApp.keyWindow else { return }
        guard (try? ownerSessionStore.load()) != nil else {
            presentAlert(String(localized: "Sign in before adding another account."))
            return
        }
        do {
            let response = try await calendarAuthenticator.connectAdditionalAccount(in: window, controlAPI: controlAPI)
            // The exchange's answer is the truth for the next minute; the
            // listing `refreshCalendarSources` makes may still predate it.
            calendarWorkspace.noteGoogleAccountAdded(response.account, calendars: response.calendars)
            await refreshCalendarSources()
            // An open Calendar window holds its own workspace, and a new
            // account has events it has never fetched.
            Self.announceGoogleConnectionChange()
        } catch {
            presentAlert((error as? StarlingsError)?.message ?? error.localizedDescription)
        }
    }

    private func removeGoogleAccount(_ account: CalendarAccount) async {
        do {
            try await calendarWorkspace.removeGoogleAccount(account.id)
            await refreshCalendarSources()
            NotificationCenter.default.post(name: CalendarSourcePreferences.didChange, object: nil)
        } catch {
            presentAlert((error as? StarlingsError)?.message ?? error.localizedDescription)
        }
    }

    /// Accounts that are attached but no longer reachable: their refresh token
    /// died and the Worker dropped it. They have no calendars to list, so
    /// without this they were nowhere on the page while still counting as
    /// "already connected" when added again.
    private func addAccountRepairRows() {
        for account in calendarWorkspace.accountsNeedingReconnect {
            let status = SettingsInfoRow(title: account.email)
            status.update(state: .denied, detail: String(localized: "Google no longer honours this account’s access. Reconnect it, or remove it."))
            let reconnect = SettingsActionRow(title: String(localized: "Reconnect"), detail: String(localized: "Choose \(account.email) again"))
            reconnect.onClick = { [weak self] in
                Task { @MainActor in await self?.addGoogleAccount() }
            }
            let remove = SettingsActionRow(title: String(localized: "Remove account"))
            remove.onClick = { [weak self] in
                Task { @MainActor in await self?.removeGoogleAccount(account) }
            }
            addSourceGroup(SettingsGroupView(rows: [status, reconnect, remove]))
        }
    }

    /// A Google connect or disconnect happened here; the Calendar window and
    /// the main window hold their own workspaces and need telling. The flag
    /// asks them to read once more after KV has had time to catch up.
    private static func announceGoogleConnectionChange() {
        NotificationCenter.default.post(
            name: CalendarSourcePreferences.didChange,
            object: nil,
            userInfo: [CalendarSourcePreferences.googleConnectionAssertedKey: true]
        )
    }

    /// Subscribing takes an address, so it asks for one. The address is checked
    /// by the server rather than here — the server is the side that will fetch
    /// it, and the side that has to refuse a feed pointing somewhere private.
    private func promptForSubscription() async {
        let alert = NSAlert()
        alert.messageText = String(localized: "Subscribe to a calendar")
        alert.informativeText = String(localized: "Paste a published calendar feed URL.")
        alert.addButton(withTitle: String(localized: "Subscribe"))
        alert.addButton(withTitle: String(localized: "Cancel"))

        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.placeholderString = "webcal://…"
        alert.accessoryView = field
        alert.window.initialFirstResponder = field

        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let address = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty else { return }

        do {
            _ = try await calendarWorkspace.subscribe(to: address)
            await refreshCalendarSources()
            await refreshCalendarPicker(googleConnected: calendarWorkspace.googleConnected)
        } catch {
            presentAlert((error as? StarlingsError)?.message ?? error.localizedDescription)
        }
    }

    private func addSourceGroup(_ group: SettingsGroupView) {
        calendarSourcesStack.addArrangedSubview(group)
        group.widthAnchor.constraint(equalTo: calendarSourcesStack.widthAnchor).isActive = true
    }

    private static func accountDetail(members: [StarlingsCalendar], enabled: Bool) -> String {
        guard enabled else { return "Not in Starlings" }
        return members.count == 1 ? String(localized: "1 calendar") : String(localized: "\(members.count) calendars")
    }

    private func persistCalendarSelection() {
        let selected = zip(availableCalendars, calendarPickerRows)
            .compactMap { entry, row in row.isOn ? entry.id : nil }
        guard !selected.isEmpty else {
            presentAlert(String(localized: "Keep at least one calendar enabled for Upcoming."))
            Task { await refreshCalendarPicker(googleConnected: !availableCalendars.isEmpty) }
            return
        }
        calendarBusy = true
        Task {
            defer { calendarBusy = false }
            do {
                _ = try await calendarWorkspace.setGoogleCalendarSelection(selected)
            } catch {
                presentAlert(error.localizedDescription)
                await refreshCalendarPicker(googleConnected: !availableCalendars.isEmpty)
            }
        }
    }

    private func persistUpcomingSubscriptionSelection() {
        let excluded = Set(zip(availableUpcomingSubscriptions, upcomingSubscriptionRows)
            .compactMap { subscription, row in row.isOn ? nil : subscription.id })
        calendarBusy = true
        Task {
            defer { calendarBusy = false }
            do {
                try await calendarWorkspace.setUpcomingExcludedSubscriptionIDs(excluded)
            } catch {
                presentAlert(error.localizedDescription)
                await refreshCalendarPicker(googleConnected: !availableCalendars.isEmpty)
            }
        }
    }

    /// Read, never set: the Mic Mode belongs to the user, and whether Meet
    /// reaches Apple voice processing belongs to LiveKit's audio module.
    private func refreshVoiceProcessing() {
        voiceProcessingRow.update(state: .unknown, detail: MicrophoneProcessingSnapshot.current().summary)
    }

    private func refreshPermissions() async {
        let permissions = await devices.requestPermissions()
        microphoneRow.update(
            state: permissions.microphone,
            detail: permissions.microphone == .allowed ? String(localized: "Available for meetings") : String(localized: "Permission needed")
        )
        hostRow.update(
            state: .allowed,
            detail: String(localized: "Wake assertion + admission lease while a room is live")
        )

        refreshVoiceProcessing()
        openMicrophoneRow.isHidden = permissions.microphone == .allowed
        microphonePrivacyGroup?.setRows(permissions.microphone == .allowed ? [] : [openMicrophoneRow])
        microphonePrivacyGroup?.isHidden = permissions.microphone == .allowed
        videoSettingsPage?.refresh()
    }

    private func refreshCaptions() {
        refreshSuggestionsEngine()
        guard !isPreparingCaptions else { return }
        switch LocalTranscriptionModel.status() {
        case .ready:
            captionsRow.update(
                state: .allowed,
                detail: String(localized: "Ready — starts with the room when you host")
            )
            prepareCaptionsButton.isHidden = true
            captionsActionsStack?.isHidden = true
        case .notDownloaded:
            captionsRow.update(
                state: .unknown,
                detail: String(localized: "Not downloaded yet — prepare it here or on first host")
            )
            prepareCaptionsButton.title = String(localized: "Download speech model")
            prepareCaptionsButton.applyMeetFilledStyle(
                .accent,
                title: String(localized: "Download speech model"),
                font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold),
                cornerRadius: 8
            )
            prepareCaptionsButton.isEnabled = true
            prepareCaptionsButton.isHidden = false
            captionsActionsStack?.isHidden = false
        case .unsupportedPlatform:
            captionsRow.update(
                state: .restricted,
                detail: String(localized: "Requires Apple Silicon")
            )
            prepareCaptionsButton.isHidden = true
            captionsActionsStack?.isHidden = true
        }
    }

    @objc private func prepareCaptions() {
        guard !isPreparingCaptions else { return }
        isPreparingCaptions = true
        prepareCaptionsButton.isEnabled = false
        prepareCaptionsButton.applyMeetFilledStyle(
            .accent,
            title: String(localized: "Downloading…"),
            font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold),
            cornerRadius: 8
        )
        captionsRow.update(state: .unknown, detail: String(localized: "Downloading the speech model…"))
        Task {
            defer {
                isPreparingCaptions = false
                refreshCaptions()
            }
            do {
                try await LocalTranscriptionModel.prepare { [weak self] fraction in
                    Task { @MainActor in
                        guard let self, self.isPreparingCaptions else { return }
                        let percentage = Int((fraction * 100).rounded())
                        self.captionsRow.update(
                            state: .unknown,
                            detail: String(localized: "Downloading the speech model… \(percentage)%")
                        )
                    }
                }
            } catch {
                presentAlert(error.localizedDescription)
            }
        }
    }

    @objc private func signIn() {
        guard let window = view.window ?? NSApp.keyWindow else { return }
        accountConnection.apply(.disconnected(
            title: String(localized: "Not signed in"),
            detail: String(localized: "Required to host meetings"),
            busy: true
        ))
        Task {
            defer { refreshAccount() }
            do {
                let credentials = try await authenticator.authenticate(in: window)
                refreshAccount()
                await refreshCalendar()
                onSessionChanged?(credentials)
                onSignIn?()
            } catch {
                // Cancelling the browser sheet is a choice, not a failure.
                guard !SignInOutcome.isCancel(error) else { return }
                let plain = SignInOutcome.plainMessage(for: error)
                presentAlert([plain.text, plain.detail].compactMap { $0 }.joined(separator: "\n\n"))
            }
        }
    }

    /// Core is only on offer to a signed-in owner: the token is minted on the
    /// strength of that session. The row says which of the three states this
    /// Mac is in, and the two buttons follow it.
    private func refreshCore() {
        guard (try? ownerSessionStore.load()) != nil else {
            coreConnection.apply(.unavailable(title: String(localized: "Other records"), detail: String(localized: "Sign in to connect")))
            return
        }
        if let credential = core.credential {
            coreConnection.apply(.connected(
                title: String(localized: "Connected"),
                detail: core.errorMessage ?? Self.renewalDetail(email: credential.email, expiry: credential.expiryDate),
                busy: core.isLinking
            ))
        } else {
            coreConnection.apply(.disconnected(
                title: String(localized: "Not connected"),
                detail: core.errorMessage ?? String(localized: "Read and edit records with no subject page."),
                busy: core.isLinking
            ))
        }
    }

    /// The detail line under a connected token: who, and when the token
    /// renews. Renewal happens on its own inside the last week.
    private static func renewalDetail(email: String?, expiry: Date?) -> String {
        let renews = expiry.map { String(localized: "renews before \($0.formatted(date: .abbreviated, time: .omitted))") }
        return [email, renews].compactMap { $0 }.joined(separator: " · ")
    }

    @objc private func connectCore() {
        Task { await core.link() }
    }

    @objc private func disconnectCore() {
        Task { await core.unlink() }
    }

    /// Keep's unlock-method rows from KeepUI, once Keep is linked: the same
    /// rows the Keep window's own settings show. The token itself has no
    /// row; it comes with the Meet session.
    private func refreshKeep() {
        keepMethodsHost.isHidden = !keep.isLinked
        guard keep.isLinked else { return }
        let window = view.window
        keepMethodsHost.rootView = meetHosted(
            EnvisioningForm {
                KeepSettingsSections(session: keep.session, anchor: { window ?? NSApp.keyWindow ?? NSWindow() })
            }
            .frame(minHeight: keep.session.isUnlocked ? 320 : 60)
        )
    }

    // MARK: - Connected agents (docs/MCP.md)

    private func refreshConnectedClaudes() {
        guard (try? ownerSessionStore.load()) != nil else {
            let row = SettingsInfoRow(title: String(localized: "None"), showsStatusDot: false)
            row.update(state: .unknown, detail: "")
            connectedClaudesGroup.setRows([row] + connectorAddressRows())
            return
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                self.showConnectedClaudes(try await self.controlAPI.mcpGrants())
            } catch {
                let row = SettingsInfoRow(title: String(localized: "Connected agents"), showsStatusDot: false)
                row.update(state: .denied, detail: error.localizedDescription)
                self.connectedClaudesGroup.setRows([row] + self.connectorAddressRows())
            }
        }
    }

    private func showConnectedClaudes(_ grants: [McpGrant]) {
        guard !grants.isEmpty else {
            let row = SettingsInfoRow(title: String(localized: "None"), showsStatusDot: false)
            row.update(state: .unknown, detail: "")
            connectedClaudesGroup.setRows([row] + connectorAddressRows())
            return
        }
        connectedClaudesGroup.setRows(grants.map { grant in
            let row = SettingsInfoRow(title: grant.clientName, showsStatusDot: true)
            let when = grant.lastCallDate.map { min($0, Date()).formatted(.relative(presentation: .named)) } ?? String(localized: "no calls yet")
            // A paused pairing is still there, just not live: the hollow dot.
            if grant.isPaused {
                row.update(state: .unknown, detail: "\(String(localized: "Paused")) · \(grant.scopeDescription) · \(when)")
            } else {
                row.update(state: .allowed, detail: "\(grant.scopeDescription) · \(when)")
            }
            let pauseTitle = grant.isPaused ? String(localized: "Resume") : String(localized: "Pause")
            let pause = NSButton(title: pauseTitle, target: nil, action: nil)
            SettingsChrome.applySecondaryButton(pause, title: pauseTitle)
            pause.target = self
            pause.action = grant.isPaused ? #selector(resumeConnectedClaude(_:)) : #selector(pauseConnectedClaude(_:))
            pause.identifier = NSUserInterfaceItemIdentifier(grant.id)
            let revoke = NSButton(title: String(localized: "Revoke"), target: nil, action: nil)
            SettingsChrome.applySecondaryButton(revoke, title: String(localized: "Revoke"))
            revoke.target = self
            revoke.action = #selector(revokeConnectedClaude(_:))
            revoke.identifier = NSUserInterfaceItemIdentifier(grant.id)
            let actions = NSStackView(views: [pause, revoke])
            actions.orientation = .horizontal
            actions.spacing = 8
            row.setTrailing(actions)
            return row
        } + connectorAddressRows())
    }

    /// The name and the address a member gives Claude or any MCP client, each
    /// with Copy, and the help page that says where to add them. The name is
    /// the one the server gives itself. The same rows on iPhone and the web.
    private func connectorAddressRows() -> [NSView] {
        let workspace = StarlingsWorkspace.active
        let help = NSButton(title: String(localized: "How to connect Claude"), target: self, action: #selector(openConnectHelp))
        SettingsChrome.applySecondaryButton(help, title: String(localized: "How to connect Claude"))
        return [
            copyValueRow(title: String(localized: "Connector name"), value: workspace.mcpServerName, extra: nil),
            copyValueRow(title: String(localized: "Connector address"), value: workspace.mcpAddress, extra: help),
        ]
    }

    private func copyValueRow(title: String, value: String, extra: NSButton?) -> NSView {
        let row = SettingsInfoRow(title: title, showsStatusDot: false)
        row.update(state: .unknown, detail: value)
        let copy = NSButton(title: String(localized: "Copy"), target: self, action: #selector(copyConnectorValue(_:)))
        SettingsChrome.applySecondaryButton(copy, title: String(localized: "Copy"))
        copy.identifier = NSUserInterfaceItemIdentifier(value)
        let actions = NSStackView(views: [copy] + (extra.map { [$0] } ?? []))
        actions.orientation = .horizontal
        actions.spacing = 8
        row.setTrailing(actions)
        return row
    }

    @objc private func copyConnectorValue(_ sender: NSButton) {
        guard let value = sender.identifier?.rawValue else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
        SettingsChrome.applySecondaryButton(sender, title: String(localized: "Copied"))
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak sender] in
            guard let sender else { return }
            SettingsChrome.applySecondaryButton(sender, title: String(localized: "Copy"))
        }
    }

    @objc private func openConnectHelp() {
        guard let url = StarlingsWorkspace.active.mcpConnectHelpURL else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func pauseConnectedClaude(_ sender: NSButton) {
        setConnectedClaudePaused(sender, paused: true)
    }

    @objc private func resumeConnectedClaude(_ sender: NSButton) {
        setConnectedClaudePaused(sender, paused: false)
    }

    /// Pause stops the Claude at its next call and keeps the pairing.
    private func setConnectedClaudePaused(_ sender: NSButton, paused: Bool) {
        guard let id = sender.identifier?.rawValue else { return }
        sender.isEnabled = false
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                self.showConnectedClaudes(try await self.controlAPI.setMcpGrantPaused(id: id, paused: paused))
            } catch {
                sender.isEnabled = true
                self.presentAlert(error.localizedDescription)
            }
        }
    }

    @objc private func revokeConnectedClaude(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        sender.isEnabled = false
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                self.showConnectedClaudes(try await self.controlAPI.revokeMcpGrant(id: id))
            } catch {
                sender.isEnabled = true
                self.presentAlert(error.localizedDescription)
            }
        }
    }

    // MARK: - Other workspaces

    private func addWorkspaceRow() -> NSView {
        let button = NSButton(title: String(localized: "Add Workspace…"), target: self, action: #selector(addWorkspace))
        SettingsChrome.applySecondaryButton(button, title: String(localized: "Add Workspace…"))
        let row = NSStackView(views: [button, NSView()])
        row.orientation = .horizontal
        return row
    }

    private func refreshWorkspaces() {
        let store = StarlingsWorkspaceStore.shared
        let others = store.known.filter { $0.webOrigin != store.current.webOrigin }
        guard !others.isEmpty else {
            let row = SettingsInfoRow(title: String(localized: "None"), showsStatusDot: false)
            row.update(state: .unknown, detail: "")
            workspacesGroup.setRows([row])
            return
        }
        workspacesGroup.setRows(others.map { workspace in
            let email = WorkspaceAccounts.email(workspace)
            let row = SettingsInfoRow(title: workspace.name, showsStatusDot: true)
            row.update(state: email == nil ? .unknown : .allowed, detail: workspace.rowDetail(email: email, saysSignedOut: true))
            var buttons: [NSView] = []
            if email != nil {
                buttons.append(workspaceButton(String(localized: "Sign out"), workspace, #selector(signOutOfWorkspace(_:))))
            }
            buttons.append(workspaceButton(String(localized: "Remove"), workspace, #selector(removeWorkspace(_:))))
            let trailing = NSStackView(views: buttons)
            trailing.orientation = .horizontal
            trailing.spacing = 8
            row.setTrailing(trailing)
            return row
        })
    }

    private func workspaceButton(_ title: String, _ workspace: StarlingsWorkspace, _ action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        SettingsChrome.applySecondaryButton(button, title: title)
        button.identifier = NSUserInterfaceItemIdentifier(workspace.webOrigin)
        return button
    }

    private func listedWorkspace(_ sender: NSButton) -> StarlingsWorkspace? {
        guard let origin = sender.identifier?.rawValue else { return nil }
        return StarlingsWorkspaceStore.shared.known.first { $0.webOrigin == origin }
    }

    @objc private func signOutOfWorkspace(_ sender: NSButton) {
        guard let workspace = listedWorkspace(sender) else { return }
        do {
            try WorkspaceAccounts.signOut(workspace)
        } catch {
            presentAlert(error.localizedDescription)
        }
        refreshWorkspaces()
    }

    @objc private func removeWorkspace(_ sender: NSButton) {
        guard let workspace = listedWorkspace(sender) else { return }
        do {
            try WorkspaceAccounts.remove(workspace)
        } catch {
            presentAlert(error.localizedDescription)
        }
        refreshWorkspaces()
    }

    @objc private func addWorkspace() {
        guard !StarlingsSurfaceActivity.isMeetLive else { return }
        AddWorkspaceSheet.present(over: view.window)
    }

    // MARK: - Devices (docs/ADMIN.md §5a)

    private func refreshDevices() {
        guard (try? ownerSessionStore.load()) != nil else {
            let row = SettingsInfoRow(title: String(localized: "None"), showsStatusDot: false)
            row.update(state: .unknown, detail: "")
            devicesGroup.setRows([row])
            return
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                self.showDevices(try await self.controlAPI.ownerDevices())
            } catch {
                let row = SettingsInfoRow(title: String(localized: "Devices"), showsStatusDot: false)
                row.update(state: .denied, detail: error.localizedDescription)
                self.devicesGroup.setRows([row])
            }
        }
    }

    private func showDevices(_ devices: [OwnerDevice]) {
        guard !devices.isEmpty else {
            let row = SettingsInfoRow(title: String(localized: "None"), showsStatusDot: false)
            row.update(state: .unknown, detail: "")
            devicesGroup.setRows([row])
            return
        }
        devicesGroup.setRows(devices.map { device in
            let row = SettingsInfoRow(title: device.title, showsStatusDot: true)
            row.update(state: .allowed, detail: device.detail)
            let button = NSButton(title: String(localized: "Sign out"), target: nil, action: nil)
            SettingsChrome.applySecondaryButton(button, title: String(localized: "Sign out"))
            button.target = self
            button.action = #selector(signOutDevice(_:))
            button.identifier = NSUserInterfaceItemIdentifier(device.deviceID)
            row.setTrailing(button)
            return row
        })
    }

    @objc private func signOutDevice(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        // Signing out the Mac that is asking is signing out: one path.
        if id == ownerSessionStore.deviceID() {
            signOut()
            return
        }
        sender.isEnabled = false
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                self.showDevices(try await self.controlAPI.revokeOwnerDevice(deviceID: id))
            } catch {
                sender.isEnabled = true
                self.presentAlert(error.localizedDescription)
            }
        }
    }

    @objc private func signOut() {
        // Tell the Worker first, best effort: the row is what makes this
        // Mac's tokens dead from its next request, and Devices on the other
        // devices stops listing it. Offline, the row falls out at the 60-day
        // sweep or under somebody's Sign out.
        controlAPI.revokeOwnDeviceBestEffort(deviceID: ownerSessionStore.deviceID())
        do {
            try ownerSessionStore.clear()
            // This workspace's caches only (slice G).
            WorkspaceSignOut.purgeLocalData(allWorkspaces: false)
            // A running recording stops, and no capture waits for whoever
            // signs in next.
            AmbientCaptureController.ownerSignedOut()
            refreshAccount()
            refreshDevices()
            onSessionChanged?(nil)
            onSignOut?()
        } catch {
            presentAlert(error.localizedDescription)
        }
    }

    @objc private func connectCalendar() {
        guard let window = view.window ?? NSApp.keyWindow else { return }
        guard (try? ownerSessionStore.load()) != nil else {
            presentAlert(String(localized: "Sign in before connecting Calendar."))
            return
        }
        calendarBusy = true
        calendarConnection.connectButton.isEnabled = false
        Task {
            defer {
                calendarBusy = false
                calendarConnection.connectButton.isEnabled = true
            }
            do {
                // Prove the stored owner JWT still works for this build's API
                // before opening Google — avoids a successful OAuth dance that
                // then fails exchange with a stale/cross-env session. Not the
                // status endpoint: that reads the token key, and a miss read
                // seconds before the token is written is exactly what KV
                // caches — see `CalendarSourcePreferences.googleConnectionGrace`.
                _ = try await controlAPI.calendarPreferences()
                let status = try await calendarAuthenticator.connect(in: window, controlAPI: controlAPI)
                calendarWorkspace.noteGoogleConnected(status)
                applyCalendarStatus(status)
                await refreshCalendarSources()
                await refreshCalendarPicker(googleConnected: true, knownCalendars: status.calendars)
                renderCalendarSources()
                Self.announceGoogleConnectionChange()
            } catch {
                if (try? ownerSessionStore.load()) == nil {
                    refreshAccount()
                    onSessionChanged?(nil)
                    presentAlert(String(localized: "Sign in again, then connect Calendar."))
                } else {
                    presentAlert(error.localizedDescription)
                    await refreshCalendar()
                }
            }
        }
    }

    @objc private func disconnectCalendar() {
        calendarBusy = true
        calendarConnection.disconnectButton.isEnabled = false
        Task {
            defer {
                calendarBusy = false
                calendarConnection.disconnectButton.isEnabled = true
            }
            do {
                let status = try await controlAPI.disconnectCalendar()
                calendarWorkspace.noteGoogleDisconnected()
                applyCalendarStatus(status)
                availableCalendars = []
                calendarPickerRows = []
                await refreshCalendarSources()
                await refreshCalendarPicker(googleConnected: false)
                renderCalendarSources()
                NotificationCenter.default.post(name: CalendarSourcePreferences.didChange, object: nil)
            } catch {
                presentAlert(error.localizedDescription)
            }
        }
    }

    @objc private func openCameraPrivacy() {
        SystemSettingsOpener.openPrivacyCamera()
    }

    @objc private func openMicrophonePrivacy() {
        SystemSettingsOpener.openPrivacyMicrophone()
    }

    @objc private func openPrivacy() {
        openWebPath("/privacy")
    }

    @objc private func openTerms() {
        openWebPath("/terms")
    }

    private func openWebPath(_ path: String) {
        let urlString = MeetingInvite.absoluteURL(path: path, webOrigin: MeetingControlAPI.configuredWebOrigin)
        guard let url = URL(string: urlString) else { return }
        NSWorkspace.shared.open(url)
    }

    private static func versionString() -> String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
        return String(localized: "Version \(short) (\(build))")
    }

    /// Every message that reaches here is something that did not work, so it
    /// reads as a warning and carries Copy like every other error.
    private func presentAlert(_ message: String) {
        guard let window = view.window else { return }
        let alert = NSAlert()
        alert.messageText = String(localized: "Settings")
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: String(localized: "OK"))
        let copyResponse = alert.addCopyErrorButton()
        alert.beginSheetModal(for: window) { response in
            if response == copyResponse { StarlingsErrorReport.copy(message: message) }
        }
    }
}

@MainActor
final class SettingsWindowController: NSWindowController {
    let settingsViewController: SettingsViewController

    init(settingsViewController: SettingsViewController = SettingsViewController()) {
        self.settingsViewController = settingsViewController
        let window = NSWindow(contentViewController: settingsViewController)
        window.title = String(localized: "Settings")
        window.setContentSize(NSSize(width: 760, height: 540))
        window.minSize = NSSize(width: 680, height: 440)
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.backgroundColor = StarlingsColors.canvas
        // Settings is not a surface: it has no switcher, and it must never be
        // merged into the Home / Calendar / Work tab group, because a tab you
        // cannot get back out of is not a settings window.
        window.tabbingMode = .disallowed
        window.center()
        super.init(window: window)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show() {
        settingsViewController.refresh()
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}

/// Keeps short settings content pinned to the top (default clip views sit at the bottom).
private final class SettingsFlippedClipView: NSClipView {
    override var isFlipped: Bool { true }
}
