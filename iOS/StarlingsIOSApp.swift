import CoreKit
import DocsKit
import EnvisioningUI
import SwiftUI

@main
struct StarlingsIOSApp: App {
    @StateObject private var appLock = StarlingsAppLock()
    @AppStorage(StarlingsAppearanceSettings.key) private var appearanceRaw = StarlingsAppearanceSettings.defaultMode.rawValue

    init() {
        // Before the first view: the bundle's language is fixed the first time
        // a string is read.
        StarlingsLanguageLaunch.apply()
        // The accent follows the active workspace's palette.
        // Before the first colour resolves. The widgets read `WidgetAccent`.
        StarlingsMobileColors.accentResolver = { role, dark in
            let shade: WorkspaceAccent.Shade = switch role {
            case .fill: .fill
            case .hover: .hover
            case .down: .down
            case .ink: .ink
            case .mark: .mark
            case .focus: .focus
            }
            return WorkspaceAccent.rgb(shade, dark: dark)
        }
        // Every segmented picker draws its chosen segment in the accent with
        // accent ink, as the Mac's StarlingsSegmentedControl does, instead of the
        // system tint. SwiftUI's `.segmented` style is UISegmentedControl
        // underneath, and the appearance proxy is the one place to say it.
        let segmented = UISegmentedControl.appearance()
        segmented.selectedSegmentTintColor = StarlingsMobileColors.accentUIColor
        segmented.setTitleTextAttributes([.foregroundColor: UIColor(StarlingsMobileColors.accentInk)], for: .selected)
        // Every time wheel moves in 5-minute steps. SwiftUI's
        // DatePicker has no interval of its own; it is UIDatePicker underneath.
        // A Google event on an odd minute keeps it until someone turns the wheel.
        UIDatePicker.appearance().minuteInterval = 5
    }

    var body: some Scene {
        WindowGroup {
            MobileWorkspaceRoot()
                .meetAppLock(appLock)
                .environmentObject(appLock)
                .environment(\.locale, StarlingsDateFormatting.locale)
                .preferredColorScheme((StarlingsAppearanceMode(rawValue: appearanceRaw) ?? StarlingsAppearanceSettings.defaultMode).colorScheme)
                // Neutral root. Accent is opted into by the control that earns
                // it, so Lists, Toggles and navigation chrome do not all turn
                // lime when the user changes theme.
                .neutralChrome()
                .task { await MobileAppIconChoice.migrateLegacyName() }
                // The workspace's current name and mark, from its descriptor.
                .task { await StarlingsWorkspaceStore.shared.refresh() }
        }
    }
}

/// One runtime per workspace (slice E, docs/CENTRAL_AUTH.md). Keyed by the
/// workspace's web origin: choosing another workspace discards every store,
/// session, client and poll built for the old one, and builds them again
/// for the new one, so nothing keeps the old workspace's data or origin.
private struct MobileWorkspaceRoot: View {
    @ObservedObject private var workspace = StarlingsWorkspaceStore.shared

    var body: some View {
        // The Docs origin too: a workspace stored before its descriptor named
        // Docs builds its Docs session with none, and only a rebuild links it
        // once the descriptor arrives.
        MobileWorkspaceRuntime().id("\(workspace.current.webOrigin)|\(workspace.current.docsOrigin?.absoluteString ?? "")")
    }
}

/// Everything the app builds for the active workspace.
private struct MobileWorkspaceRuntime: View {
    @StateObject private var model = StarlingsAppModel()
    @StateObject private var team = MobileTeamStore()
    @StateObject private var work = MobileMyWorkStore()
    @StateObject private var commercial = MobileCommercialStore()
    @StateObject private var quickNotes = MobileQuickNotesStore()
    /// The order Home draws its modules in — owner-synced, cached for the
    /// first frame. Settings edits it; Home reads it.
    @StateObject private var homeLayout = MobileHomeLayoutStore()
    /// The language the interface is drawn in — owner-synced.
    @StateObject private var language = MobileLanguageStore()
    /// This phone’s standing with Core — token, registry, repository — for the
    /// life of the workspace, like Mine. Every Core screen in Work reads it.
    @StateObject private var core = CoreSession(
        apiEndpoint: StarlingsEnvironment.configured().apiBaseURL.absoluteString,
        deviceName: UIDevice.current.name
    )
    /// This phone's line to Docs, through the Worker on the owner session,
    /// for the life of the workspace. The Docs tab and every Documents pane read it.
    @StateObject private var docs = DocsSession(
        apiEndpoint: StarlingsEnvironment.configured().apiBaseURL.absoluteString,
        deviceName: UIDevice.current.name,
        ownerSession: { DocsOwnerSession(MobileOwnerSessionStore()) }
    )
    /// This phone's standing with Keep — the token and the key session. The
    /// Keep screen under Work reads it.
    @StateObject private var keep = KeepAccess(
        apiEndpoint: StarlingsEnvironment.configured().apiBaseURL.absoluteString,
        deviceName: UIDevice.current.name
    )
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        StarlingsRootView()
            .environmentObject(model)
            .environmentObject(model.upcoming)
            .environmentObject(team)
            .environmentObject(work)
            .environmentObject(commercial)
            .environmentObject(quickNotes)
            .environmentObject(homeLayout)
            .environmentObject(language)
            .environmentObject(core)
            .environmentObject(docs)
            .environmentObject(keep)
            .onOpenURL { model.route(url: $0) }
            // On appear, not in a task: every call here is synchronous,
            // and the stores paint their snapshots as they attach. A task
            // starts after the first frame, which drew Home's loading
            // shells over lists already on disk (docs/CACHING.md).
            .onAppear {
                model.start()
                model.performLaunchAction()
                team.attach(to: model)
                work.attach(to: model)
                commercial.attach(to: model)
                quickNotes.attach(to: model)
                homeLayout.attach(to: model)
                language.attach(to: model)
                core.attach(to: model)
                docs.attach(to: model)
                keep.attach(to: model)
                // A switch or an add rebuilt this runtime: say where the person is.
                if let name = StarlingsWorkspaceStore.shared.takeArrival() {
                    StarlingsToastCenter.shared.show(String(localized: "You’re in \(name)"))
                }
            }
            // Coming back to the app is the moment to renew: it costs one
            // request, and it is what stops an overnight gap turning into a
            // Google sign-in over breakfast.
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active else { return }
                model.performLaunchAction()
                Task {
                    await model.renewSessionIfNeeded()
                    await model.retryPendingArtifacts()
                    await model.drainShareOutbox()
                }
                Task { await quickNotes.refresh() }
                Task { await core.refreshIfNeeded() }
                if model.ownerCredentials != nil {
                    Task { await docs.ensureLinked() }
                    Task { await keep.ensureLinked() }
                }
            }
    }
}

private struct StarlingsRootView: View {
    @Environment(\.openURL) private var openURL
    @EnvironmentObject private var app: StarlingsAppModel
    @EnvironmentObject private var team: MobileTeamStore
    @EnvironmentObject private var work: MobileMyWorkStore
    @ObservedObject private var upgrade = StarlingsUpgradeRecommendation.shared
    @ObservedObject private var store = StarlingsWorkspaceStore.shared

    var body: some View {
        Group {
            // The hand-off between sign-in and the workspace is Starlings'
            // own: EnvisioningUI's transition stacks the mark
            // over a system spinner, and the static flock beside a spinner
            // read as two loaders. The flock is the one loader motion
            // (docs/DESIGN.md, "Waiting").
            if app.isEnteringWorkspace {
                StarlingsWorkspaceOpening(name: store.current.name)
            } else {
                EnvisioningEntryGate(
                    productName: store.current.name,
                    phase: app.isSignedIn ? .ready : .signedOut
                ) {
                    MobileVisitorRoot()
                } workspace: {
                    workspace
                }
            }
        }
        // The window is named for the workspace: the iPad's app switcher and
        // Stage Manager read the scene title.
        .onChange(of: store.current.name, initial: true) { _, name in
            for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
                scene.title = name
            }
        }
        // Update on an error a retired route sent: the update link
        // the Worker named, else the TestFlight app, where the build waits.
        .onReceive(NotificationCenter.default.publisher(for: StarlingsUpgradeRecommendation.updateRequestedNotification)) { _ in
            if let url = upgrade.updateURL ?? URL(string: "itms-beta://") { openURL(url) }
        }
    }

    /// The member workspace. Home and Calendar live only here: a visitor has no
    /// agenda and no calendar, and a tab that can only ask them to sign in
    /// describes a product they are not using.
    private var workspace: some View {
        workspaceTabs
        // The accent is for the bar — the selected tab, and nothing else.
        // SwiftUI inherits a tint into everything the container holds, so this
        // one line would otherwise turn every toolbar, link and gear inside every
        // tab lime, overriding the neutral root set at `StarlingsIOSApp`.
        // `neutralChrome()` above puts each tab's content back where the root
        // left it, which is why no screen restates it for itself.
        .tint(StarlingsMobileColors.accent)
        .meetAlertHost()
        .safeAreaInset(edge: .top) {
            VStack(spacing: 0) {
                // No "newer version" banner on the iPhone: TestFlight
                // and the App Store announce updates, and a route that refuses
                // this build offers Update in its own error.
                if let ring = team.incomingRing, ring.kind == .call, app.selectedTab != .team {
                    HStack {
                        Text("\(ring.callerDisplayName) wants to talk").font(.callout)
                        Button("Open room") { Task { await team.answerCall() } }.meetHoverLift(cornerRadius: EnvisioningRadius.control)
                        Button("Not now") { Task { await team.clearRing() } }.meetHoverLift(cornerRadius: EnvisioningRadius.control)
                    }
                    .padding()
                    .background(StarlingsMobileColors.panel)
                }
            }
        }
    }

    private var tabSelection: Binding<StarlingsAppModel.Tab> {
        Binding(get: { app.selectedTab }, set: { app.selectTab($0) })
    }

    /// The `Tab` builder wherever it exists (iOS 18), `.tabItem` on iOS 17.
    /// On 26 the legacy spelling still renders the compatibility bar — flat next
    /// to the Liquid Glass one CORE gets — so the two apps only match on the
    /// builder. Seventeen has nothing but the legacy bar, so it loses nothing.
    /// Both draw `app.tabs`, so they list the same tabs in the same order.
    @ViewBuilder
    private var workspaceTabs: some View {
        if #available(iOS 18, *) {
            TabView(selection: tabSelection) {
                ForEach(app.tabs, id: \.self) { tab in
                    Tab(tab.title, systemImage: Self.symbolName(tab), value: tab) {
                        tabContent(tab)
                    }
                }
            }
            .meetTabBarMinimizes()
        } else {
            TabView(selection: tabSelection) {
                ForEach(app.tabs, id: \.self) { tab in
                    tabContent(tab)
                        .tabItem { Label(tab.title, systemImage: Self.symbolName(tab)) }
                        .tag(tab)
                }
            }
        }
    }

    @ViewBuilder
    private func tabContent(_ tab: StarlingsAppModel.Tab) -> some View {
        switch tab {
        case .home:
            MobileHomeView().neutralChrome().meetToastHost()
        case .calendar:
            MobileCalendarScreen().neutralChrome().meetToastHost()
        case .work:
            // Work is the graph: Mine, projects, leads, tasks and issues.
            MobileWorkView()
                .badge(team.unreadWorkCount + work.inboxBesideTalk.count)
                .neutralChrome()
                .meetToastHost()
        case .team:
            MobileTeamView()
                .badge(team.unreadTeamCount)
                .neutralChrome()
                .meetToastHost()
        case .docs:
            // Docs is the corpus: everything written, in its own place.
            MobileDocsView().neutralChrome().meetToastHost()
        }
    }

    private static func symbolName(_ tab: StarlingsAppModel.Tab) -> String {
        switch tab {
        case .home: "house.fill"
        case .calendar: "calendar"
        case .work: "tray.full.fill"
        case .team: "person.2.fill"
        case .docs: "doc.text.fill"
        }
    }
}

/// The unsigned root. The shared welcome shell owns the mark, wordmark, card,
/// version line, and auth label; this app adds its guest name/email/room path.
///
/// Continuing hands off to the join flow, which is a visitor's whole path.
/// There is no workspace to tab between until somebody signs in.
private struct MobileVisitorRoot: View {
    @EnvironmentObject private var app: StarlingsAppModel
    @State private var isJoining = false

    var body: some View {
        Group {
            if isJoining {
                JoinView(onClose: { isJoining = false })
            } else {
                MobileFirstRunCard()
            }
        }
        .background(StarlingsMobileColors.canvas.ignoresSafeArea())
        .meetAlertHost()
        // A room from the card, a `starlings://` link, or a notification are the same
        // signal: this visitor is on their way into a room.
        .onChange(of: app.pendingJoinInput) { _, input in
            if input != nil { isJoining = true }
        }
        .task { if app.pendingJoinInput != nil { isJoining = true } }
    }
}

/// "Opening HQ…" between sign-in and the workspace's first screen. It names
/// the workspace, never the product, and its one moving element is
/// the flock in the connecting wave: no system spinner beside it.
private struct StarlingsWorkspaceOpening: View {
    let name: String

    var body: some View {
        VStack(spacing: 16) {
            GatheringDotsView(side: 36, ink: .primary, motion: .murmuration)
            Text("Opening \(name)…")
                .font(.headline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("envisioning.entry.preparing-workspace")
    }
}
