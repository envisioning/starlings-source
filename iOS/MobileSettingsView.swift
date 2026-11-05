import EnvisioningUI
import SwiftUI

/// Presented as a sheet from Home's toolbar rather than as a tab: settings are
/// something you go and change, not one of the four things the app is about.
/// The Mac says the same thing with ⌘,.
struct MobileSettingsView: View {
    @EnvironmentObject private var app: StarlingsAppModel
    @EnvironmentObject private var appLock: StarlingsAppLock
    @EnvironmentObject private var language: MobileLanguageStore
    @AppStorage(StarlingsAppearanceSettings.key) private var appearanceRaw = StarlingsAppearanceSettings.defaultMode.rawValue
    @AppStorage(HomeTexturePreferences.key) private var showsHomeTexture = HomeTexturePreferences.defaultValue
    @AppStorage(SpatialAudioPreferences.key) private var spatialAudio = SpatialAudioPreferences.defaultValue
    @AppStorage(MeetingAlertSettings.Key.enabled) private var alertsEnabled = true
    @AppStorage(MeetingAlertSettings.Key.countdownLeadMinutes) private var countdownLeadMinutes = 60
    @AppStorage(MeetingAlertSettings.Key.leadMinutes) private var alertLeadMinutes = MeetingAlertSettings.defaultLeadMinutes
    @AppStorage(MessageNotificationPreferences.key) private var notifiesOnAllChannelMessages = MessageNotificationPreferences.defaultValue
    @StateObject private var calendarStore = MobileCalendarStore()
    @State private var developmentEndpoint = UserDefaults.standard.string(forKey: "meet.development.apiEndpoint") ?? ""
    @State private var savedEndpoint = ""
    @State private var appLockEnabled = false
    @State private var isChangingAppLock = false
    /// The page to open on — the ⌘K palette's settings door — or the index.
    private let initialPage: StarlingsSettingID?

    init(initialPage: StarlingsSettingID? = nil) {
        self.initialPage = initialPage
    }

    var body: some View {
        MobileMeetSettingsShell(groups: settingsGroups, paneTitle: paneTitle, initialSelection: initialPage) { definition in
            settingsPane(for: definition)
        }
        .task { appLockEnabled = appLock.isEnabled }
        .task(id: app.ownerCredentials?.accessToken) {
            await calendarStore.attach(to: app)
        }
        .onDisappear { calendarStore.detach() }
    }

    /// The groups and their pages are the shared table's (`settings-pages.ts`), the
    /// same headings the Mac sidebar and the web draw.
    private var settingsGroups: [MobileSettingsGroup] {
        StarlingsSettingsRegistry.groups(for: .iosSettings) { definition in
            #if DEBUG
            true
            #else
            definition.control != .developmentServer
            #endif
        }
        .map { MobileSettingsGroup(id: $0.group.rawValue, title: $0.group.title, definitions: $0.definitions) }
    }

    private func paneTitle(for definition: StarlingsSettingDefinition) -> String {
        switch definition.control {
        case .account: return "General"
        case .appLock: return "App Lock"
        case .notifications: return "Notifications"
        case .developmentServer: return "Development Server"
        default: return definition.title
        }
    }

    /// The row shows the synced choice and writes through the store, so the
    /// old choice comes back on a failed save instead of a local value
    /// drifting from what every other device reads.
    private var languageChoice: Binding<StarlingsLanguageChoice> {
        Binding(
            get: { StarlingsLanguageChoice(language.language) },
            set: { choice in Task { await language.save(choice.language) } }
        )
    }

    private func settingsPane(for definition: StarlingsSettingDefinition) -> some View {
        Group {
            if definition.control == .calendarShortcut {
                MobileCalendarSettingsRootView(store: calendarStore)
            } else if definition.control == .home {
                MobileHomeSettingsView(calendarStore: calendarStore)
            } else if definition.control == .roomPolicy {
                MobileRoomPolicySettingsView()
            } else {
                StarlingsList {
                    settingsSection(for: definition)
                }
            }
        }
    }

    @ViewBuilder
    private func settingsSection(for definition: StarlingsSettingDefinition) -> some View {
        switch definition.control {
        case .account:
            if let owner = app.ownerCredentials?.owner {
                // A string title only pairs with `content:`; the moment a
                // footer joins, the header has to be a closure too.
                Section {
                    // The workspace this phone is signed in to, and with
                    // which address.
                    StarlingsWorkspaceBadge(address: owner.email, markSize: 28)
                        .padding(.vertical, 2)
                    LabeledContent("Name", value: owner.name)
                    LabeledContent("Email", value: owner.email)
                } header: {
                    Text("Account")
                }

                ProfilePictureSettingsSection()

                // A workspace without Core or Keep shows no row for it.
                // Docs and Keep come with the Meet session: no Connect row.
                if StarlingsWorkspace.active.has(.core) { MobileCoreSettingsSection() }
                if StarlingsWorkspace.active.has(.keep) { MobileKeepSettingsSection() }
                MobileConnectedClaudesSection()
                MobileDevicesSection()

                Section {
                    Button(EnvisioningCopy.signOut, role: .destructive) { app.signOut() }
                    // Shown when more than one workspace is signed in.
                    if StarlingsWorkspaceStore.shared.known.filter(MobileWorkspaceSwitch.hasSession).count > 1 {
                        Button("Sign out of all workspaces", role: .destructive) { app.signOutOfAllWorkspaces() }
                    }
                } footer: {
                    // The workspace, not a product name: you sign in to it
                    // again with Google or an emailed link.
                    Text("Removes this device’s session. You can sign in to \(StarlingsWorkspace.active.name) again.")
                }
            } else {
                Section("Account") {
                    StarlingsWorkspaceBadge(address: nil, markSize: 28)
                        .padding(.vertical, 2)
                    MobileSignInButton(prominence: .bordered)
                }
            }

        case .calendarShortcut, .home, .roomPolicy:
            EmptyView()

        case .work:
            MobileWorkSettingsSection()

        case .notifications:
            Section(definition.title) {
                // The words are `MeetingAlertSettings`', shared with the Mac.
                Toggle(MeetingAlertSettings.warningTitle, isOn: $alertsEnabled)
                    .meetToggleTint()
                Picker(MeetingAlertSettings.leadTitle, selection: $alertLeadMinutes) {
                    ForEach(MeetingAlertSettings.leadChoices, id: \.self) { minutes in
                        Text(MeetingAlertSettings.leadLabel(minutes: minutes)).tag(minutes)
                    }
                }
                .disabled(!alertsEnabled)
                Picker("Lock Screen countdown", selection: $countdownLeadMinutes) {
                    ForEach(MeetingAlertSettings.countdownLeadChoices, id: \.self) { minutes in
                        Text(MeetingAlertSettings.leadLabel(minutes: minutes)).tag(minutes)
                    }
                }
                .disabled(!alertsEnabled)
                Text("Open Starlings in the window to start the countdown.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text(MeetingAlertSettings.openOnlyFooter)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section("Channels") {
                Toggle("Every channel message", isOn: $notifiesOnAllChannelMessages)
                    .meetToggleTint()
                Text("Off notifies only when a channel names you.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

        case .calls:
            Section(definition.title) {
                LabeledContent("Participation", value: "Host and join")
                LabeledContent("Background audio", value: "On")
                Text("Starlings never records audio or video.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section {
                Toggle("Spatial audio", isOn: $spatialAudio)
                    .meetToggleTint()
            } footer: {
                Text("Each voice comes from where that person’s tile is on the stage. Best on headphones.")
            }

        case .appearance:
            Section("Appearance") {
                EnvisioningAppearancePicker(selection: $appearanceRaw)
                Toggle("Grid texture", isOn: $showsHomeTexture)
                    .meetToggleTint()
                Text("This phone only.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            // The Language picker is parked until product-market fit.
            Section("App icon") {
                MobileAppIconSettings()
            }

        case .appLock:
            EnvisioningAppLockSection(
                isEnabled: $appLockEnabled,
                biometricTitle: appLock.biometry.title,
                isBiometricAvailable: appLock.biometry.isAvailable,
                isChanging: isChangingAppLock,
                failure: appLock.failure,
                graceInterval: Int(StarlingsAppLockSettings.graceInterval)
            ) { requested in
                guard !isChangingAppLock, requested != appLock.isEnabled else { return }
                isChangingAppLock = true
                Task {
                    // The lock answers before the switch settles: the toggle
                    // shows what the device agreed to, not what was requested.
                    appLockEnabled = await appLock.setEnabled(requested)
                    isChangingAppLock = false
                }
            }
            .meetToggleTint()

        case .about:
            Section("About") {
                LabeledContent("Version", value: StarlingsAppVersion.marketing)
                LabeledContent("Build", value: StarlingsAppVersion.build)
                LabeledContent("Server", value: StarlingsAppVersion.environment.capitalized)
                Link("Help", destination: URL(string: "\(StarlingsWorkspace.active.publicOrigin)/help")!)
                Link("Privacy", destination: URL(string: "\(StarlingsWorkspace.active.publicOrigin)/privacy")!)
            }

        case .developmentServer:
            #if DEBUG
            Section(definition.title) {
                TextField("http://your-mac.local:8787/api", text: $developmentEndpoint)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                Button("Use endpoint") {
                    let value = developmentEndpoint.trimmingCharacters(in: .whitespacesAndNewlines)
                    UserDefaults.standard.set(value.isEmpty ? nil : value, forKey: "meet.development.apiEndpoint")
                    savedEndpoint = StarlingsEnvironment.configured().apiBaseURL.absoluteString
                    // Owner tokens are environment-bound. Force a fresh sign-in after switching stacks.
                    app.signOut()
                }
                Text("On a device, enter your Mac’s .local URL.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if !savedEndpoint.isEmpty {
                    Text("Using \(savedEndpoint)").font(.caption).foregroundStyle(.secondary)
                }
            }
            #else
            EmptyView()
            #endif

        case .transcription:
            Section(definition.title) {
                MobileTranscriptionSettings()
            }

        case .macPage:
            EmptyView()
        }
    }

}

private struct MobileRoomPolicySettingsView: View {
    @EnvironmentObject private var app: StarlingsAppModel
    @State private var roomSlug: String? = nil
    @State private var refuseRecorders: Bool? = nil
    @State private var isLoading = false
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        StarlingsList {
            Section {
                if let refuseRecorders {
                    Toggle("Refuse recording notetakers", isOn: Binding(
                        get: { refuseRecorders },
                        set: { value in Task { await save(value) } }
                    ))
                    .disabled(isLoading || isSaving)
                } else if isLoading {
                    ProgressView("Loading room settings…")
                } else if errorMessage == nil {
                    Text("Sign in to load your room setting.")
                        .foregroundStyle(.secondary)
                }

                if let roomSlug {
                    Text("Your room: /room/\(roomSlug)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button("Try again") { Task { await load() } }
                        .disabled(isLoading || isSaving)
                }
            } header: {
                Text("Recording notetakers")
            } footer: {
                Text("Notetakers declare that they record. They still wait for admission when this is off.")
            }
        }
        .task(id: app.ownerCredentials?.accessToken) { await load() }
    }

    private func load() async {
        guard let credentials = app.ownerCredentials else {
            roomSlug = nil
            refuseRecorders = nil
            errorMessage = nil
            return
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let room = try await app.api.ownerRoom(credentials: credentials)
            let snapshot = try await app.api.lobby(credentials: credentials, room: room.slug)
            roomSlug = room.slug
            refuseRecorders = snapshot.roomSettings?.refuseRecorders ?? false
        } catch is CancellationError {
            return
        } catch {
            errorMessage = (error as? StarlingsError)?.message ?? error.localizedDescription
        }
    }

    private func save(_ refuse: Bool) async {
        guard !isSaving,
              let credentials = app.ownerCredentials,
              let roomSlug,
              let previous = refuseRecorders else { return }
        refuseRecorders = refuse
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            let settings = try await app.api.updateRoomSettings(
                credentials: credentials,
                room: roomSlug,
                settings: RoomSettingsUpdate(refuseRecorders: refuse)
            )
            refuseRecorders = settings.refuseRecorders
        } catch {
            refuseRecorders = previous
            errorMessage = (error as? StarlingsError)?.message ?? error.localizedDescription
        }
    }
}

/// The Calendar index inside Settings. Calendar has enough independent
/// decisions that putting every control on one screen makes the top-level
/// Settings row a dead end rather than a useful destination.
struct MobileCalendarSettingsRootView: View {
    @ObservedObject var store: MobileCalendarStore

    var body: some View {
        NavigationStack {
            StarlingsList {
                Section(CalendarSettingGroup.accountsAndSources.title) {
                    NavigationLink {
                        MobileCalendarSourcesView(
                            store: store,
                            showsDoneButton: false,
                            showsExtendedSettings: false
                        )
                    } label: {
                        calendarLinkLabel(
                            CalendarSettingsRegistry.definition(for: .calendarSources),
                            detail: String(localized: "Choose accounts, local calendars, and subscriptions")
                        )
                    }
                }

                // How many rows Upcoming shows on Home moved to Settings >
                // Home with the rest of the Home layout; what feeds it stays
                // here, because it is a calendar choice.
                Section(CalendarSettingGroup.upcoming.title) {
                    NavigationLink {
                        MobileUpcomingCalendarSelection(store: store)
                    } label: {
                        calendarLinkLabel(
                            CalendarSettingsRegistry.definition(for: .googleCalendarSync),
                            detail: String(localized: "Choose Google calendars and subscribed feeds for Upcoming")
                        )
                    }
                }

                Section(CalendarSettingGroup.display.title) {
                    NavigationLink {
                        MobileCalendarDisplaySettingsView(store: store)
                    } label: {
                        calendarLinkLabel(
                            CalendarSettingsRegistry.definition(for: .calendarDisplay),
                            detail: String(localized: "Choose the layout, hours, and grid")
                        )
                    }
                    NavigationLink {
                        MobileCalendarWeatherSettingsView(store: store)
                    } label: {
                        calendarLinkLabel(
                            CalendarSettingsRegistry.definition(for: .calendarWeather),
                            detail: String(localized: "Show weather beside your calendar")
                        )
                    }
                }

                Section(CalendarSettingGroup.behavior.title) {
                    NavigationLink {
                        MobileCalendarLayersSettingsView(store: store)
                    } label: {
                        calendarLinkLabel(
                            CalendarSettingsRegistry.definition(for: .calendarLayers),
                            detail: String(localized: "Show or hide \(StarlingsWorkspace.active.name) layers")
                        )
                    }
                    NavigationLink {
                        MobileCalendarNewEventSettingsView(store: store)
                    } label: {
                        calendarLinkLabel(
                            CalendarSettingsRegistry.definition(for: .defaultWriteCalendar),
                            detail: String(localized: "Choose where new events are created")
                        )
                    }
                }

                // The hours guests book you in, owner-synced with the Mac
                // and the web.
                Section(CalendarSettingGroup.booking.title) {
                    NavigationLink {
                        MobileBookingHoursView(store: store)
                    } label: {
                        calendarLinkLabel(
                            CalendarSettingsRegistry.definition(for: .bookingHours),
                            detail: String(localized: "Choose when guests can book a time with you")
                        )
                    }
                }
            }
            .navigationTitle(StarlingsSettingsRegistry.title(for: .calendar))
            .navigationBarTitleDisplayMode(.inline)
        }
        .task { await store.reload(force: true) }
    }

    private func calendarLinkLabel(
        _ definition: CalendarSettingDefinition,
        detail: String
    ) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(definition.title)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: symbolName(for: definition.id))
        }
        .accessibilityHint("Opens " + definition.title + " settings")
    }

    private func symbolName(for id: CalendarSettingID) -> String {
        switch id {
        case .calendarSources, .googleCalendar: return "calendar"
        case .googleCalendarSync: return "calendar.badge.clock"
        case .calendarDisplay: return "rectangle.split.3x1"
        case .calendarWeather: return "cloud.sun"
        case .calendarLayers: return "square.3.layers.3d"
        case .defaultWriteCalendar: return "calendar.badge.plus"
        case .bookingHours: return "calendar.badge.checkmark"
        }
    }
}

private struct MobileSettingsGroup: Identifiable {
    let id: String
    let title: String
    let definitions: [StarlingsSettingDefinition]
}

/// Meet owns its surface ladder, so the iOS shell needs to hide the platform
/// scroll backgrounds before it can use Meet's canvas. The shared settings
/// shell intentionally leaves surfaces to each app; keeping this small shell
/// here avoids making the app's custom canvas look like a second product.
private struct MobileMeetSettingsShell<PaneContent: View>: View {
    let groups: [MobileSettingsGroup]
    let paneTitle: (StarlingsSettingDefinition) -> String
    let pane: (StarlingsSettingDefinition) -> PaneContent

    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var selection: StarlingsSettingID?

    init(
        groups: [MobileSettingsGroup],
        paneTitle: @escaping (StarlingsSettingDefinition) -> String,
        initialSelection: StarlingsSettingID? = nil,
        @ViewBuilder pane: @escaping (StarlingsSettingDefinition) -> PaneContent
    ) {
        self.groups = groups
        self.paneTitle = paneTitle
        self.pane = pane
        _selection = State(initialValue: initialSelection)
    }

    private var allDefinitions: [StarlingsSettingDefinition] {
        groups.flatMap(\.definitions)
    }

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                ForEach(groups) { group in
                    Section(group.title) {
                        ForEach(group.definitions) { definition in
                            NavigationLink(value: definition.id) {
                                Label(paneTitle(definition), systemImage: definition.symbolName)
                            }
                            .accessibilityHint("Opens \(paneTitle(definition)) settings")
                        }
                    }
                }
                .meetListRows()
                // Last, signed in or not: a workspace with no session can
                // still switch back to one that has one.
                MobileWorkspacesSection()
                    .meetListRows()
            }
            .meetSurfaceBackground()
            .navigationTitle("Settings")
            .navigationSplitViewColumnWidth(min: 200, ideal: 220)
        } detail: {
            if let active = allDefinitions.first(where: { $0.id == selection }) {
                pane(active)
                    .id(active.id)
                    .navigationTitle(paneTitle(active))
                    .navigationBarTitleDisplayMode(.inline)
            } else {
                ContentUnavailableView("Select a Setting", systemImage: "gearshape")
            }
        }
        .meetSurfaceBackground()
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(EnvisioningCopy.done) { dismiss() }
                    .meetToolbarConfirm()
            }
        }
        .neutralChrome()
        .onAppear { selectInitialPaneIfNeeded() }
        .onChange(of: horizontalSizeClass) { _, _ in selectInitialPaneIfNeeded() }
    }

    /// iPad keeps a useful detail visible; iPhone starts at the settings index
    /// and pushes the selected pane, matching the system Settings rhythm.
    private func selectInitialPaneIfNeeded() {
        guard selection == nil, horizontalSizeClass == .regular else { return }
        selection = allDefinitions.first?.id
    }
}

/// Settings > Work on the phone: which subject kinds show in Work (;
/// Leads is the old Sales opt-in). The Worker's `hidden_kinds`, so it follows
/// the account to the Mac and the web. Star and mute stay on the subject's
/// row in Work.
private struct MobileWorkSettingsSection: View {
    @EnvironmentObject private var work: MobileMyWorkStore
    @State private var errorMessage: String?

    var body: some View {
        Section {
            ForEach(ShownKindRow.offered(workModules: work.subjectState.workModules)) { row in
                Toggle(isOn: Binding(
                    get: { !work.subjectState.resolvedHiddenKinds.contains(row.kind.rawValue) },
                    set: { shown in
                        let hidden = work.subjectState.resolvedHiddenKinds.filter { $0 != row.kind.rawValue }
                        Task {
                            do {
                                try await work.setHiddenKinds(shown ? hidden : hidden + [row.kind.rawValue])
                                errorMessage = nil
                            } catch {
                                errorMessage = error.localizedDescription
                            }
                        }
                    }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: row.title)
                        Text(verbatim: row.detail).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .meetToggleTint()
            }
            if let errorMessage {
                Text(errorMessage).font(.footnote).foregroundStyle(.secondary)
            }
        } header: {
            Text("Show in Work")
        } footer: {
            Text("Follows your account. Star or mute a subject from its row in Work.")
        }
        Section {
            ForEach(InboxSourceSpec.all.filter { work.subjectState.inboxAvailableSources.contains($0.source) }) { spec in
                Toggle(isOn: Binding(
                    get: { work.inboxSources[spec.source] ?? spec.defaultOn },
                    set: { on in
                        Task {
                            do {
                                try await work.setInboxSource(spec.source, on: on)
                                errorMessage = nil
                            } catch {
                                errorMessage = error.localizedDescription
                            }
                        }
                    }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(spec.title)
                        Text(spec.detail).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .meetToggleTint()
                // Sales touches follow the Sales opt-in above.
                .disabled(spec.source == "sales" && !work.salesEnabled)
            }
        } header: {
            Text("Inbox")
        } footer: {
            Text("What Inbox carries. Follows your account.")
        }
    }
}
