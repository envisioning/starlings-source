import EnvisioningUI
import SwiftUI

/// Which calendars Meet reads, and the permissions that gate them. Settings
/// presents this as a focused source destination; the Calendar tab can opt into
/// its adjacent shortcuts so that existing calendar workflows stay intact.
struct MobileCalendarSourcesView: View {
    @ObservedObject var store: MobileCalendarStore
    @EnvironmentObject private var app: StarlingsAppModel

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    private let showsDoneButton: Bool
    private let showsExtendedSettings: Bool
    @State private var connecting = false
    @State private var addingAccount = false
    @State private var subscriptionURL = ""
    @State private var subscribing = false

    init(
        store: MobileCalendarStore,
        showsDoneButton: Bool = true,
        showsExtendedSettings: Bool = true
    ) {
        self.store = store
        self.showsDoneButton = showsDoneButton
        self.showsExtendedSettings = showsExtendedSettings
    }

    var body: some View {
        Group {
            if showsDoneButton {
                NavigationStack {
                    content
                }
            } else {
                content
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        StarlingsList {
            if !store.isSignedIn {
                Section {
                    MobileSignInButton(prominence: .bordered)
                }
            }

            googleSection
            subscriptionSection
            deviceSection
            if showsExtendedSettings {
                Section("View") {
                    NavigationLink(CalendarSettingsRegistry.title(for: .calendarDisplay)) {
                        MobileCalendarDisplaySettingsView(store: store)
                    }
                    NavigationLink(CalendarSettingsRegistry.title(for: .calendarWeather)) {
                        MobileCalendarWeatherSettingsView(store: store)
                    }
                }
                if StarlingsWorkspace.active.has(.core) { layerSection }
                defaultCalendarSection
            }
        }
        .navigationTitle(showsExtendedSettings ? String(localized: "Calendars") : CalendarSettingsRegistry.title(for: .calendarSources))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if showsDoneButton {
                ToolbarItem(placement: .confirmationAction) {
                    Button(EnvisioningCopy.done) { dismiss() }
                        .meetToolbarConfirm()
                }
            }
        }
        // The Mac can add a subscription while this destination is already
        // alive. Opening it is the moment when the owner expects current data.
        .task {
            await store.reload(force: true)
        }
    }

    // MARK: - Sources

    @ViewBuilder
    private var googleSection: some View {
        if store.isSignedIn {
            // Grouped by account: with a second Google account attached, "Google"
            // stops being one heading and each address becomes its own.
            ForEach(store.sourceGroups.filter { $0.source == .google }) { group in
                Section {
                    accountRow(group)
                    if !store.isAccountDisabled(group.title) {
                        ForEach(group.calendars) { calendar in
                            sourceRow(calendar)
                        }
                    }
                    if let accountID = store.removableAccounts[group.title] {
                        Button(role: .destructive) {
                            Task { await removeAccount(accountID) }
                        } label: {
                            Label("Remove this account", systemImage: "minus.circle")
                        }
                    }
                } header: {
                    Text(group.title)
                }
            }

            Section(CalendarSettingsRegistry.title(for: .googleCalendar)) {
                if store.googleConnected {
                    Button {
                        addAccount()
                    } label: {
                        Label(
                            addingAccount ? String(localized: "Adding account…") : String(localized: "Add another Google account"),
                            systemImage: "person.badge.plus"
                        )
                    }
                    .disabled(addingAccount)
                } else if !StarlingsWorkspace.active.calendarConnectable {
                    Text("Calendar connects to Google only.")
                        .foregroundStyle(.secondary)
                } else {
                    Button {
                        connect()
                    } label: {
                        Label(
                            connecting ? String(localized: "Connecting…") : String(localized: "Connect Google Calendar"),
                            systemImage: "calendar.badge.plus"
                        )
                    }
                    .disabled(connecting)
                }
            }
        }
    }

    /// Subscribed feeds. Kept above the device's own calendars because they are
    /// the owner's choice rather than this phone's, and because subscribing here
    /// is the only place in the app it can be done on iOS.
    @ViewBuilder
    private var subscriptionSection: some View {
        if store.isSignedIn {
            Section {
                ForEach(store.allCalendars.filter { $0.source == .subscription }) { calendar in
                    sourceRow(calendar)
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                Task { await unsubscribe(calendar.rawID) }
                            } label: {
                                Label("Unsubscribe", systemImage: "minus.circle")
                            }
                        }
                }
                HStack(spacing: 10) {
                    Image(systemName: "link").frame(width: 18)
                    TextField("webcal://…", text: $subscriptionURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .submitLabel(.done)
                        .onSubmit { Task { await subscribe() } }
                    if subscribing {
                        ProgressView()
                    } else if !subscriptionURL.trimmingCharacters(in: .whitespaces).isEmpty {
                        Button("Add") { Task { await subscribe() } }
                    }
                }
            } header: {
                Text(StarlingsCalendar.subscriptionGroupTitle)
            } footer: {
                if let error = store.subscriptionErrorMessage {
                    StarlingsErrorNotice(message: String(localized: "Couldn’t load shared subscriptions: ") + error)
                        .accessibilityLabel("Subscription error: \(error)")
                } else {
                    Text("Paste a calendar URL.")
                }
            }
        }
    }

    private func removeAccount(_ id: String) async {
        do {
            try await store.removeGoogleAccount(id)
        } catch {
            store.errorMessage = MobileCalendarStore.describe(error)
        }
    }

    private func subscribe() async {
        let address = subscriptionURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty, !subscribing else { return }
        subscribing = true
        do {
            try await store.subscribe(to: address)
            subscriptionURL = ""
        } catch {
            store.errorMessage = MobileCalendarStore.describe(error)
        }
        subscribing = false
    }

    private func unsubscribe(_ id: String) async {
        do {
            try await store.unsubscribe(id)
        } catch {
            store.errorMessage = MobileCalendarStore.describe(error)
        }
    }

    @ViewBuilder
    private var deviceSection: some View {
        let local = store.allCalendars.filter { $0.source == .eventKit }
        Section {
            Toggle(isOn: Binding(
                get: { store.includesLocalCalendars },
                set: { store.setIncludesLocalCalendars($0) }
            )) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Include local calendars")
                    Text("iCloud and calendars on this device")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .meetToggleTint()
        } header: {
            Text("Local calendars")
        } footer: {
            if !store.includesLocalCalendars {
                Text("Off until you turn it on.")
            }
        }

        if store.includesLocalCalendars, store.eventKitAccess == .granted, !local.isEmpty {
            // One section per account rather than one long list, because the
            // useful move here is usually about a whole account: a Google
            // account also added to this device arrives twice, and turning the
            // device's copy off is the fix.
            ForEach(store.sourceGroups.filter { $0.source == .eventKit }) { group in
                Section {
                    accountRow(group)
                    if !store.isAccountDisabled(group.title) {
                        ForEach(group.calendars) { calendar in
                            sourceRow(calendar)
                        }
                    }
                } header: {
                    HStack {
                        Text(group.title)
                        Spacer()
                        if !store.isAccountDisabled(group.title) {
                            Button(store.isAccountHidden(group.title) ? String(localized: "Show all") : String(localized: "Hide all")) {
                                store.setAccountHidden(group.title, hidden: !store.isAccountHidden(group.title))
                            }
                            .font(.caption)
                            .textCase(nil)
                        }
                    }
                } footer: {
                    if !store.isAccountDisabled(group.title) {
                        Text("New calendars stay hidden until enabled here.")
                    }
                }
            }
        } else if store.includesLocalCalendars {
            deviceAccessSection
        }
    }

    @ViewBuilder
    private var deviceAccessSection: some View {
        Section("On this device") {
            switch store.eventKitAccess {
            case .granted:
                Text("No calendars found on this device.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            case .denied:
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                } label: {
                    Label("Allow calendar access in Settings", systemImage: "gearshape")
                }
            case .unknown:
                Text("Checking calendar access…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// These controls remain in the Calendar tab's checklist sheet. Settings
    /// exposes them as their own focused destinations, so the source submenu
    /// can omit them without changing the calendar workflow.
    private var layerSection: some View {
        Section {
            ForEach(CalendarLayerKind.allCases) { layer in
                Button {
                    store.setHidden(layer, hidden: !store.isHidden(layer))
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: layer.symbolName)
                            .foregroundStyle(StarlingsMobileColors.accent)
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(layer.title).foregroundStyle(.primary)
                            Text(layer.caption)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if !store.isHidden(layer) {
                            Image(systemName: "checkmark").foregroundStyle(.primary)
                        }
                    }
                }
                .buttonStyle(.meetPlain)
            }
        } header: {
            Text(CalendarSettingsRegistry.title(for: .calendarLayers))
        } footer: {
            Text(CalendarLayerKind.sourceFootnote)
        }
    }

    @ViewBuilder
    private var defaultCalendarSection: some View {
        if !store.defaultCalendarChoices.isEmpty {
            Section(CalendarSettingsRegistry.title(for: .defaultWriteCalendar)) {
                StarlingsSearchablePicker(
                    label: CalendarSettingsRegistry.title(for: .defaultWriteCalendar),
                    placeholder: String(localized: "Choose a calendar"),
                    options: store.defaultCalendarPickerOptions,
                    selection: defaultCalendarBinding,
                    emptyMessage: String(localized: "No options match that search.")
                )
            }
        }
    }

    /// The whole account, in or out of Meet. Above the calendars rather than
    /// beside the heading because it governs them: switched off, there is
    /// nothing underneath it left to decide.
    private func accountRow(_ group: CalendarSourceGroup) -> some View {
        Toggle(isOn: Binding(
            get: { !store.isAccountDisabled(group.title) },
            set: { store.setAccountDisabled(group.title, disabled: !$0) }
        )) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Show in Starlings").foregroundStyle(.primary)
                Text(store.isAccountDisabled(group.title)
                    ? String(localized: "This account is not in Starlings")
                    : "Every calendar in \(group.title)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .meetToggleTint()
    }

    /// One calendar: the visibility checkmark when it is in Meet, and the way
    /// back in when it is not. Kept as one row so an account's list reads as
    /// its whole self, with the excluded ones dimmed rather than missing.
    @ViewBuilder
    private func sourceRow(_ calendar: StarlingsCalendar) -> some View {
        if store.isDisabled(calendar) {
            Button {
                store.setDisabled(calendar, disabled: false)
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "plus.circle")
                        .foregroundStyle(.secondary)
                        .frame(width: 11)
                    Text(calendar.title).foregroundStyle(.secondary)
                    Spacer()
                    Text("Not in Starlings")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.meetPlain)
        } else {
            visibilityRow(calendar)
                .swipeActions(edge: .leading) {
                    Button {
                        store.setDisabled(calendar, disabled: true)
                    } label: {
                        Label("Not in Starlings", systemImage: "minus.circle")
                    }
                    .tint(.secondary)
                }
        }
    }

    private func visibilityRow(_ calendar: StarlingsCalendar) -> some View {
        Button {
            store.setHidden(calendar.id, hidden: !store.isHidden(calendar.id))
        } label: {
            HStack(spacing: 10) {
                Circle()
                    .fill(calendar.displayColor.swiftUIColor)
                    .frame(width: 11, height: 11)
                VStack(alignment: .leading, spacing: 1) {
                    Text(calendar.title).foregroundStyle(.primary)
                    if calendar.role == .globalInterest {
                        Label {
                            Text("Editable · Global interest")
                        } icon: {
                            StarlingsGlyphMark(size: 11, color: calendar.displayColor.swiftUIColor)
                        }
                        .font(.caption2)
                        .foregroundStyle(calendar.displayColor.swiftUIColor)
                    }
                    if !calendar.isWritable {
                        Text("Read only")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if !store.isHidden(calendar.id) {
                    Image(systemName: "checkmark").foregroundStyle(.primary)
                }
            }
        }
        .buttonStyle(.meetPlain)
    }

    private var defaultCalendarBinding: Binding<String> {
        Binding(
            get: { store.defaultWriteCalendar?.id ?? store.defaultCalendarChoices.first?.id ?? "" },
            set: { store.writeCalendarID = $0 }
        )
    }

    private func connect() {
        connecting = true
        Task {
            do {
                let status = try await app.connectCalendar()
                store.noteGoogleConnected(email: status.email)
                await store.reload(force: true)
            } catch {
                store.errorMessage = MobileCalendarStore.describe(error)
            }
            connecting = false
        }
    }

    private func addAccount() {
        addingAccount = true
        Task {
            do {
                let account = try await app.addCalendarAccount()
                store.noteGoogleAccountAdded(account)
                await store.reload(force: true)
            } catch {
                store.errorMessage = MobileCalendarStore.describe(error)
            }
            addingAccount = false
        }
    }
}

/// The shared Upcoming feed's Google calendars and subscribed read-only feeds.
struct MobileUpcomingCalendarSelection: View {
    @ObservedObject var store: MobileCalendarStore
    @Environment(\.dismiss) private var dismiss
    @State private var entries: [GoogleCalendarListEntry] = []
    @State private var selected: Set<String> = []
    @State private var subscriptions: [CalendarSubscription] = []
    @State private var selectedSubscriptionIDs: Set<String> = []
    @State private var isLoading = true
    @State private var isSaving = false

    var body: some View {
        StarlingsList {
            if isLoading {
                EnvisioningPlaceholderRows()
            }
            if !entries.isEmpty {
                Section(String(localized: "Google calendars")) {
                    ForEach(entries) { entry in
                        Button {
                            if selected.contains(entry.id) { selected.remove(entry.id) } else { selected.insert(entry.id) }
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(entry.summary).foregroundStyle(.primary)
                                    if entry.primary {
                                        Text("Primary")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if selected.contains(entry.id) {
                                    Image(systemName: "checkmark").foregroundStyle(.primary)
                                }
                            }
                        }
                        .buttonStyle(.meetPlain)
                    }
                }
            }
            if !subscriptions.isEmpty {
                Section {
                    ForEach(subscriptions) { subscription in
                        Button {
                            if selectedSubscriptionIDs.contains(subscription.id) {
                                selectedSubscriptionIDs.remove(subscription.id)
                            } else {
                                selectedSubscriptionIDs.insert(subscription.id)
                            }
                        } label: {
                            HStack {
                                Text(subscription.title).foregroundStyle(.primary)
                                Spacer()
                                if selectedSubscriptionIDs.contains(subscription.id) {
                                    Image(systemName: "checkmark").foregroundStyle(.primary)
                                }
                            }
                        }
                        .buttonStyle(.meetPlain)
                    }
                } header: {
                    Text(StarlingsCalendar.subscriptionGroupTitle)
                } footer: {
                    Text("Subscribed feeds added in Accounts & sources can also appear in Upcoming.")
                }
            }
        }
        .navigationTitle(CalendarSettingsRegistry.title(for: .googleCalendarSync))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? String(localized: "Saving…") : String(localized: "Save")) { save() }
                    .disabled(isSaving || (!entries.isEmpty && selected.isEmpty))
                    .meetToolbarConfirm()
            }
        }
        .task { await load() }
    }

    private func load() async {
        await store.refreshSources()
        if store.googleConnected {
            do {
                // Only calendars that are in Meet. A calendar marked "Not in Starlings"
                // under Calendars has no business feeding Upcoming, and listing
                // it here would be a second place to switch it back on.
                let enabled = Set(store.calendars.filter { $0.source == .google }.map(\.rawID))
                entries = try await store.googleCalendarEntries().filter { enabled.contains($0.id) }
                selected = Set(entries.filter(\.selected).map(\.id))
            } catch {
                store.errorMessage = MobileCalendarStore.describe(error)
            }
        }
        subscriptions = store.upcomingSubscriptions
        selectedSubscriptionIDs = Set(subscriptions.map(\.id))
            .subtracting(store.upcomingExcludedSubscriptionIDs)
        isLoading = false
    }

    private func save() {
        isSaving = true
        Task {
            do {
                if !entries.isEmpty {
                    try await store.setGoogleCalendarSelection(Array(selected))
                }
                let excluded = Set(subscriptions.map(\.id)).subtracting(selectedSubscriptionIDs)
                try await store.setUpcomingExcludedSubscriptionIDs(excluded)
                dismiss()
            } catch {
                store.errorMessage = MobileCalendarStore.describe(error)
            }
            isSaving = false
        }
    }
}
