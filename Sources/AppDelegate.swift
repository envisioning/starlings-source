import AppKit
import DocsUI
import LiveKit
import UserNotifications

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private(set) var mainWindowController: MainWindowController?
    private var commandServer: StarlingsCommandServer?
    private var menubarController: StarlingsMenubarController?
    /// Ambient capture (docs/AMBIENT_CAPTURE.md): the one session, started
    /// and stopped from the menu bar. Created at launch so its sweep runs
    /// before anything else touches the capture folder.
    private var ambientCapture: AmbientCaptureController?
    /// Recording that starts and stops itself, from the browser extension
    /// and the calendar (docs/AMBIENT_CAPTURE.md §4).
    private var automation: StarlingsAutomationController?
    /// The two-track pass over every finished capture (slice 2).
    private var capturePass: AmbientCapturePassRunner?
    private let appearanceController = StarlingsMacAppearanceController()
    private let noticeDelegate = StarlingsNoticeDelegate()
    private var metricKitReporter: MetricKitReporter?
    /// Set while Meet runs from the menu bar only (`quitToMenuBar`).
    private var dockIconObserver: NSObjectProtocol?
    private var workspaceObserver: NSObjectProtocol?
    /// The surface window the person used last. Reopen brings it back, so the
    /// Dock icon never moves them to Home.
    private weak var lastSurfaceWindow: NSWindow?
    private var surfaceWindowObservers: [NSObjectProtocol] = []

    /// Hosted unit tests inject XCTest into this process. Do not use
    /// `NSClassFromString("XCTestCase")` for this: XCTest can be present in a
    /// normal Debug launch without the app actually being test-hosted.
    private static var isHostedTest: Bool {
        let environment = ProcessInfo.processInfo.environment
        return environment["XCTestConfigurationFilePath"] != nil
            || environment["XCInjectBundleInto"] != nil
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        // First thing, before any default or file is read: the one-time move
        // out of the sandbox container (3.8.3), then the folders to their
        // Starlings names. Never under hosted tests: the test host
        // would move the folders of the app installed on this Mac.
        if !Self.isHostedTest {
            SandboxMigration.runIfNeeded()
            AppFolderMigration.runIfNeeded()
        }
        // LiveKit's default AVAudioEngine device module always captures from the
        // macOS system default input: it exposes a single synthetic "default"
        // device and resets the engine back to it just before starting. The
        // platform module (Core Audio HAL) is the only one that honours a
        // per-app microphone choice. This must run before anything touches
        // ``AudioManager``, which builds the peer connection factory that pins
        // the module type for the life of the process.
        do {
            #if DEBUG
            // The audio spike needs to compare both modules, and the choice is
            // frozen once the factory exists. Every other Debug launch resolves
            // to the same `.platformDefault` the Release build hard-codes.
            try AudioManager.set(audioDeviceModuleType: AudioProcessingSpike.requestedModuleType)
            #else
            try AudioManager.set(audioDeviceModuleType: .platformDefault)
            #endif
        } catch {
            NSLog("Meet couldn’t select the platform audio device module: %@", error.localizedDescription)
        }
        MainMenuBuilder.install()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Hosted unit tests inject XCTest into this process. Starting the real
        // window there would request camera/microphone access and can leave CI
        // waiting forever on an OS permission sheet. Do not use
        // `NSClassFromString("XCTestCase")` here: XCTest can be present in a
        // normal Debug launch without the app actually being test-hosted.
        guard !Self.isHostedTest else { return }
        // One runtime per workspace (slice E): every window, poll, session and
        // API client here was built for the workspace active at launch. A
        // change of workspace relaunches the app, so none of them outlives it.
        workspaceObserver = NotificationCenter.default.addObserver(
            forName: StarlingsWorkspace.didChangeNotification, object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated { StarlingsRelaunch.now() }
        }
        MacDockIcon.install()
        surfaceWindowObservers = [
            NotificationCenter.default.addObserver(
                forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main
            ) { [weak self] notification in
                let window = notification.object as? NSWindow
                MainActor.assumeIsolated {
                    guard let window, window.tabbingIdentifier == StarlingsWindowChrome.tabbingIdentifier else { return }
                    self?.lastSurfaceWindow = window
                }
            },
            // A closed surface reopens through its controller's `show`, not a
            // bare order-front, so reopen forgets it and falls back to Home.
            NotificationCenter.default.addObserver(
                forName: NSWindow.willCloseNotification, object: nil, queue: .main
            ) { [weak self] notification in
                let window = notification.object as? NSWindow
                MainActor.assumeIsolated {
                    if let self, window === self.lastSurfaceWindow { self.lastSurfaceWindow = nil }
                }
            },
        ]

        #if DEBUG
        // A spike run is headless: it measures the audio stack and quits, with
        // no window, no LiveKit room, and no network.
        if AudioProcessingSpike.isRequested {
            Task { await AudioProcessingSpike.run() }
            return
        }
        // The process-tap probe: builds the capture graph slice 1
        // would build and reports what arrives, then quits.
        if SystemAudioTapSpike.isRequested {
            Task { await SystemAudioTapSpike.run() }
            return
        }
        // Before the main window: a Debug build's signature is not on the
        // owner-session keychain item, and the window's first read would sit
        // on a keychain prompt nobody at a remote terminal can answer.
        // `MEET_PASS_SMOKE=<capture dir>`: the two-track pass over one capture
        // folder, printed, not uploaded. `scripts/pass-smoke.sh` builds the
        // folder from synthetic speech.
        if let folder = ProcessInfo.processInfo.environment["MEET_PASS_SMOKE"], !folder.isEmpty {
            NSApp.setActivationPolicy(.accessory)
            let directory = URL(fileURLWithPath: folder)
            Task {
                do {
                    let manifest = try AmbientCaptureStore.read(from: directory)
                    let pass = AmbientCapturePass(environment: .init(api: MeetingControlAPI(ownerSessionStore: OwnerSessionStore()), ownerName: String(localized: "Me"), signedInOwner: { nil }))
                    let started = Date()
                    let segments = try await pass.dryRun(manifest, in: directory)
                    print("segments: \(segments.count) in \(Int(Date().timeIntervalSince(started)))s")
                    for segment in segments {
                        print(String(format: "%7.2f–%7.2f  %@: %@", segment.start, segment.end, segment.speaker, segment.text))
                    }
                } catch {
                    print("pass failed: \(error)")
                }
                print("SMOKE COMPLETE")
                fflush(stdout)
                NSApp.terminate(nil)
            }
            return
        }
        // `MEET_ZOOM_SMOKE=1`: what Accessibility sees of Zoom right now, and
        // what the reader makes of it. Run during a real Zoom call to tune
        // the reads; asks for the Accessibility grant if it has none.
        if ProcessInfo.processInfo.environment["MEET_ZOOM_SMOKE"] == "1" {
            NSApp.setActivationPolicy(.accessory)
            if !ZoomCallReader.isTrusted { ZoomCallReader.requestTrust() }
            print("sandboxed: \(ProcessInfo.processInfo.environment["APP_SANDBOX_CONTAINER_ID"] != nil)")
            print("accessibility trusted: \(ZoomCallReader.isTrusted)")
            let observation = ZoomCallReader.observe()
            print("observation: inCall=\(String(describing: observation.inCall)) key=\(observation.meetingKey ?? "-") title=\(observation.title ?? "-")")
            for person in observation.roster { print("  \(person.name)\(person.speaking == true ? String(localized: " (speaking)") : "")") }
            print(ZoomCallReader.dump())
            print("SMOKE COMPLETE")
            fflush(stdout)
            NSApp.terminate(nil)
            return
        }
        // `MEET_AUTOMATION_SMOKE=1`: the listener and the tracker without a
        // window. Post batches with curl (docs/MEET_EVENTS.md) and watch the
        // actions print; the run ends after 90 s.
        if ProcessInfo.processInfo.environment["MEET_AUTOMATION_SMOKE"] == "1" {
            NSApp.setActivationPolicy(.accessory)
            let ambient = AmbientCaptureController()
            ambientCapture = ambient
            let automation = StarlingsAutomationController(capture: ambient)
            self.automation = automation
            noticeDelegate.automation = automation
            automation.onAction = { action in
                print("action: \(action)")
                fflush(stdout)
            }
            ambient.onChange = { state in
                print("capture: \(state)")
                fflush(stdout)
            }
            automation.start()
            print("token: \(StarlingsEventsPairing.token)")
            print("listening on 127.0.0.1:\(StarlingsEventsListener.port)\(StarlingsEventsListener.path)")
            fflush(stdout)
            DispatchQueue.main.asyncAfter(deadline: .now() + 90) {
                print("SMOKE COMPLETE")
                fflush(stdout)
                NSApp.terminate(nil)
            }
            return
        }
        // `MEET_AMBIENT_SMOKE=<seconds>`: record through the real controller
        // for that long, stop, print the manifest, quit. The end-to-end check
        // for the capture engine, driven from `scripts/ambient-smoke.sh`.
        if let seconds = ProcessInfo.processInfo.environment["MEET_AMBIENT_SMOKE"].flatMap(Int.init) {
            let ambient = AmbientCaptureController()
            ambientCapture = ambient
            let wanted = ProcessInfo.processInfo.environment["MEET_AMBIENT_SMOKE_INPUT"] ?? ""
            let input = ambient.inputs.first { wanted.isEmpty || $0.name.localizedCaseInsensitiveContains(wanted) }
            NSApp.setActivationPolicy(.accessory)
            var lastState: AmbientCaptureController.State = ambient.state
            ambient.onChange = { state in
                lastState = state
                print("state: \(state)")
                fflush(stdout)
            }
            do {
                try ambient.start(input: input)
                print("started with \(input?.name ?? "default"); recording \(seconds)s")
                fflush(stdout)
            } catch {
                print("start failed: \(error)")
                fflush(stdout)
                NSApp.terminate(nil)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(seconds)) {
                ambient.stop()
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    for (directory, manifest) in AmbientCaptureStore.all().suffix(1) {
                        print("manifest: \(AmbientCaptureStore.manifestURL(in: directory).path)")
                        if let data = try? Data(contentsOf: AmbientCaptureStore.manifestURL(in: directory)), let text = String(data: data, encoding: .utf8) { print(text) }
                        _ = manifest
                    }
                    print("final state: \(lastState)")
                    print("SMOKE COMPLETE")
                    fflush(stdout)
                    NSApp.terminate(nil)
                }
            }
            return
        }
        #endif

        appearanceController.start()
        let controller = MainWindowController()
        mainWindowController = controller
        let menubar = StarlingsMenubarController(
            mainWindowController: controller,
            meetingViewController: controller.meetingViewController
        )
        menubarController = menubar
        let ambient = AmbientCaptureController()
        ambientCapture = ambient
        menubar.attachAmbientCapture(ambient)
        let automation = StarlingsAutomationController(capture: ambient)
        self.automation = automation
        noticeDelegate.automation = automation
        automation.start()
        // The pass runs after every stop and, at launch, over what a previous
        // run left behind. The owner's name is what the mic track is labeled.
        let sessionStore = OwnerSessionStore()
        // Do not read the Keychain before the first window is visible. The
        // renewer resolves the signed-in owner after launch; "Me" is the
        // correct local fallback for capture metadata in the meantime.
        let ownerName = String(localized: "Me")
        ambient.ownerName = ownerName
        // Who owns a capture: read at a start and before a pass files, never
        // at launch. Every capture is filed on the account that made it.
        let signedInOwner: @Sendable () -> String? = {
            (try? sessionStore.load())?.owner.email.lowercased()
        }
        ambient.signedInOwner = signedInOwner
        let pass = AmbientCapturePassRunner(environment: .init(
            api: MeetingControlAPI(ownerSessionStore: sessionStore),
            ownerName: ownerName,
            signedInOwner: signedInOwner
        ))
        capturePass = pass
        // A stop held in grace for a resume is not the pass's yet: the pass
        // would file part 0 and delete it under the resume.
        pass.isHeld = { [weak automation] id in automation?.isHolding(id) == true }
        let previousOnStopped = ambient.onStopped
        ambient.onStopped = { [weak pass] manifest, directory in
            previousOnStopped?(manifest, directory)
            guard manifest.status == .captured else { return }
            // Nobody said who was there: ask now, while the person is still
            // at the keyboard, before the names are needed.
            let confirmed = AttendeeConfirmation.askIfNeeded(manifest, in: directory)
            pass?.enqueue(confirmed, in: directory)
        }
        // Grace ran out, or ended without a resume: the pass may have it now.
        // The pass reads the manifest from disk, names included.
        automation.onReleased = { [weak pass] manifest, directory in
            pass?.enqueue(manifest, in: directory)
        }
        ambient.onDiscarded = { [weak pass, weak automation] in
            pass?.cancelPending()
            automation?.dropHeld()
        }
        pass.processPending()
        controller.meetingViewController.onMenubarStateChange = { [weak menubar, weak automation] snapshot in
            menubar?.update(snapshot)
            automation?.updateUpcoming(snapshot.upcoming)
        }
        menubar.update(controller.meetingViewController.menubarSnapshot())
        // Who is around, straight from the app-wide presence poll: the menu bar
        // is the one place you can knock on a colleague's room without opening
        // a window first.
        controller.peerWatch.observe { [weak menubar] roster in
            menubar?.updateTeam(roster)
        }
        controller.peerWatch.observeReachability { [weak menubar] reachable in
            menubar?.updateReachable(reachable)
        }
        // Mine's focus slice, from the same app-wide poll the launch card reads.
        controller.workWatch.observeInbox { [weak menubar] inbox in
            menubar?.updateInbox(inbox)
        }
        controller.workWatch.observe { [weak menubar] tasks, issues in
            menubar?.updateWork(tasks: tasks, issues: issues)
        }
        noticeDelegate.mainWindowController = controller
        UNUserNotificationCenter.current().delegate = noticeDelegate
        StarlingsNotices.registerCategories()
        // The launch surface is fully built by MainWindowController.init. Set
        // its window appearance and fixed layer colours before the first frame
        // instead of waiting for the deferred didBecomeKey refresh.
        appearanceController.prepare(window: controller.window)
        controller.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
        // The onboarding surface is already visible before touching the
        // Keychain. Debug/ad-hoc signatures may need user approval for an
        // existing item, and a hidden prompt must never prevent launch.
        controller.presentInitialSurface()
        controller.prepareForAppLaunch()
        // Renew the owner session after a surface is visible, and again on
        // every wake and activation: that is what turns an overnight gap into
        // nothing rather than a Google sign-in over breakfast.
        OwnerSessionRenewer.shared.startObserving()
        // Crash and hang reports from earlier runs, from MetricKit.
        let diagnosticsAPI = MeetingControlAPI(ownerSessionStore: sessionStore)
        let reporter = MetricKitReporter(platform: .macos) { report in
            try await diagnosticsAPI.sendDiagnosticReport(report)
        }
        reporter.start()
        metricKitReporter = reporter

        let viewController = controller.meetingViewController
        let server = StarlingsCommandServer { [weak viewController] request in
            guard let viewController else {
                return .failure(for: request, code: "app_unavailable", message: String(localized: "The Starlings window is unavailable."))
            }
            return await viewController.handleCLI(request)
        }
        do {
            try server.start()
            commandServer = server
        } catch {
            NSLog("Meet CLI transport couldn’t start: %@", error.localizedDescription)
        }

        Task { await UpdateChecker.shared.runPeriodically() }
    }

    @objc func showSearch(_ sender: Any?) {
        mainWindowController?.showSearch()
    }

    @objc func showSettings(_ sender: Any?) {
        mainWindowController?.showSettings(sender)
    }

    @objc func showCalendar(_ sender: Any?) {
        mainWindowController?.showCalendar(sender)
    }

    @objc func showCalendarToday(_ sender: Any?) {
        mainWindowController?.showCalendarToday(sender)
    }

    @objc func showMeetWindow(_ sender: Any?) {
        mainWindowController?.showHome()
    }

    @objc func showWork(_ sender: Any?) {
        mainWindowController?.showWork(sender)
    }

    @objc func showTeam(_ sender: Any?) {
        mainWindowController?.showTeam(sender)
    }

    @objc func showDocs(_ sender: Any?) {
        mainWindowController?.showDocs(sender)
    }

    @objc func showWorkMine(_ sender: Any?) {
        mainWindowController?.showWorkMine()
    }

    @objc func newWorkProject(_ sender: Any?) {
        mainWindowController?.newWorkProject()
    }

    @objc func newWorkLead(_ sender: Any?) {
        mainWindowController?.newWorkLead()
    }

    @objc func newWorkTask(_ sender: Any?) {
        mainWindowController?.newWorkTask()
    }

    @objc func newWorkIssue(_ sender: Any?) {
        mainWindowController?.newWorkIssue()
    }

    @objc func newWorkDocument(_ sender: Any?) {
        mainWindowController?.newWorkDocument()
    }

    @objc func newWorkQuickNote(_ sender: Any?) {
        mainWindowController?.newWorkQuickNote()
    }

    @objc func searchWorkDocs(_ sender: Any?) {
        mainWindowController?.searchWorkDocs()
    }

    @objc func showWorkOverview(_ sender: Any?) {
        mainWindowController?.showWorkOverview()
    }

    @objc func showWorkBrowse(_ sender: Any?) {
        mainWindowController?.showWorkBrowse()
    }

    @objc func workBack(_ sender: Any?) {
        mainWindowController?.workBack()
    }

    @objc func workForward(_ sender: Any?) {
        mainWindowController?.workForward()
    }

    @objc func meetAboutSelectedWork(_ sender: Any?) {
        mainWindowController?.meetAboutSelectedWork()
    }

    @objc func newCalendarEvent(_ sender: Any?) {
        mainWindowController?.newCalendarEvent(sender)
    }

    @objc func checkForUpdates(_ sender: Any?) {
        mainWindowController?.checkForUpdates(sender)
    }

    /// Work › Keep…: the vaults, in their own window.
    @objc func openKeep(_ sender: Any?) {
        mainWindowController?.showKeep()
    }

    /// The help page for the surface in front: `/help/surfaces/<id>`, the
    /// ids `scripts/docs-frontmatter.mjs` enforces one page each for. The key
    /// window's title is the surface (`StarlingsWindowChrome.apply` sets it and
    /// hides it); Home in a live call is the meeting page; Settings is its own.
    @objc func openHelp(_ sender: Any?) {
        let slug: String
        if NSApp.keyWindow?.windowController is SettingsWindowController {
            slug = "surfaces/settings"
        } else if let surface = StarlingsSurface.allCases.first(where: { $0.title == NSApp.keyWindow?.title }) {
            slug = surface == .meet && StarlingsSurfaceActivity.isMeetLive ? "surfaces/meeting" : "surfaces/\(surface.helpID)"
        } else {
            slug = ""
        }
        guard let url = URL(string: "\(StarlingsWorkspace.active.publicOrigin)/help/\(slug)") else { return }
        NSWorkspace.shared.open(url)
    }

    @objc func openBugReport(_ sender: Any?) {
        guard let url = URL(string: "https://github.com/envisioning/starlings-source/issues") else { return }
        NSWorkspace.shared.open(url)
    }

    /// The web admin console, on the same origin the share links use —
    /// loopback in Debug, the public host in Release.
    @objc func openWebAdmin(_ sender: Any?) {
        let origin = MeetingInvite.shareOrigin(configuredWebOrigin: MeetingControlAPI.configuredWebOrigin)
        guard let url = URL(string: MeetingInvite.absoluteURL(path: "/admin", webOrigin: origin)) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc func signInWithGoogle(_ sender: Any?) {
        mainWindowController?.signInFromMenu(sender)
    }

    @objc func signOutOwner(_ sender: Any?) {
        mainWindowController?.signOutFromMenu(sender)
    }

    @objc func signOutOfAllWorkspaces(_ sender: Any?) {
        mainWindowController?.signOutOfAllWorkspacesFromMenu(sender)
    }

    /// Quit to Menu Bar: the windows go and the Dock icon goes, but the process
    /// and the menu bar item stay — recording, notices and the command server
    /// keep running. The first ordinary window that becomes key again
    /// (`restoreDockIcon`) turns the app back into a Dock app.
    @objc func quitToMenuBar(_ sender: Any?) {
        for window in NSApp.windows where window.isVisible {
            window.orderOut(nil)
        }
        NSApp.setActivationPolicy(.accessory)
        guard dockIconObserver == nil else { return }
        dockIconObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didBecomeKeyNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            let window = notification.object as? NSWindow
            MainActor.assumeIsolated { self?.restoreDockIcon(for: window) }
        }
    }

    private func restoreDockIcon(for window: NSWindow?) {
        // Panels (live captions, the menu bar's own popovers) do not bring the
        // Dock icon back; a real window does.
        guard let window, !(window is NSPanel), NSApp.activationPolicy() != .regular else { return }
        NSApp.setActivationPolicy(.regular)
        // Without a fresh activation the main menu stays hidden after the
        // policy change.
        NSApp.activate(ignoringOtherApps: true)
        if let dockIconObserver {
            NotificationCenter.default.removeObserver(dockIconObserver)
        }
        dockIconObserver = nil
    }

    /// Member destinations, off while signed out: signed out,
    /// the app is the door — sign-in, join, Settings, Help, Quit.
    private static let memberActions: Set<Selector> = [
        #selector(showSearch(_:)), #selector(showCalendar(_:)), #selector(showCalendarToday(_:)),
        #selector(showWork(_:)), #selector(showTeam(_:)), #selector(showDocs(_:)), #selector(showWorkMine(_:)),
        #selector(newWorkProject(_:)), #selector(newWorkLead(_:)), #selector(newWorkTask(_:)), #selector(newWorkIssue(_:)),
        #selector(newWorkDocument(_:)), #selector(newWorkQuickNote(_:)), #selector(searchWorkDocs(_:)),
        #selector(showWorkOverview(_:)), #selector(showWorkBrowse(_:)), #selector(workBack(_:)), #selector(workForward(_:)),
        #selector(meetAboutSelectedWork(_:)), #selector(newCalendarEvent(_:)), #selector(openKeep(_:)), #selector(openWebAdmin(_:)),
    ]

    @objc func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        let signedIn = mainWindowController?.isOwnerSignedIn == true
        if let action = menuItem.action, Self.memberActions.contains(action), !signedIn { return false }
        switch menuItem.action {
        case #selector(quitToMenuBar(_:)):
            // A live call with no window is a call nobody can see or leave.
            return !StarlingsSurfaceActivity.isMeetLive
        case #selector(signInWithGoogle(_:)):
            // The menu names neither the method nor the workspace: the
            // sign-in screen offers the ways in (docs/DESIGN.md §Copy law).
            menuItem.title = String(localized: "Sign in…")
            return !signedIn
        case #selector(signOutOwner(_:)):
            return signedIn
        case #selector(signOutOfAllWorkspaces(_:)):
            // One rule on every client: only when more than one
            // workspace is signed in, as iOS Settings shows it.
            let signedInCount = StarlingsWorkspaceStore.shared.known.filter(WorkspaceAccounts.hasSession).count
            menuItem.isHidden = signedInCount < 2
            return signedIn && signedInCount > 1
        // A workspace without Docs or Keep shows no item for it.
        case #selector(showDocs(_:)), #selector(newWorkDocument(_:)), #selector(searchWorkDocs(_:)):
            menuItem.isHidden = !StarlingsWorkspace.active.has(.docs)
            return !menuItem.isHidden
        case #selector(openKeep(_:)):
            menuItem.isHidden = !StarlingsWorkspace.active.has(.keep)
            return !menuItem.isHidden
        // No calendar source, no Calendar item, and ⌘2 does nothing.
        case #selector(showCalendar(_:)):
            menuItem.isHidden = !SurfaceVisibility.isVisible(.calendar)
            return !menuItem.isHidden
        default:
            return true
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // Quit during a recording is the same stop path as Stop: the tracks
        // are closed and verified before the process goes.
        automation?.stop()
        ambientCapture?.stopAndWaitForQuit()
        // Open documents save before the process goes: every editor, in an
        // inspector or a window of its own. A save that does not land in time
        // leaves its draft on disk, and the next open restores it.
        let editors = DocsOpenEditors.shared
        guard !editors.unsaved.isEmpty else { return .terminateNow }
        // The deadline replies on its own: a task group waits for every save
        // even after it is cancelled, so a save that hangs must not hold quit.
        quitReplied = false
        Task { @MainActor in
            await editors.flushAll(timeout: .seconds(4))
            self.replyToQuit(sender)
        }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(5))
            self.replyToQuit(sender)
        }
        return .terminateLater
    }

    private var quitReplied = false

    private func replyToQuit(_ sender: NSApplication) {
        guard !quitReplied else { return }
        quitReplied = true
        sender.reply(toApplicationShouldTerminate: true)
    }

    func applicationWillTerminate(_ notification: Notification) {
        commandServer?.stop()
        commandServer = nil
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    /// Reopen comes from the Dock icon, from Finder, and from a click on a
    /// notification banner. With a window on screen it only activates Meet:
    /// the tab in front stays in front, and a banner's own route (a thread, a
    /// knock) is not covered by Home. With no window on screen it restores the
    /// surface used last, and Home only when there is none.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard !flag else { return false }
        guard let window = lastSurfaceWindow else {
            mainWindowController?.showMeetingWindow()
            return false
        }
        if window.isMiniaturized {
            window.deminiaturize(nil)
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        return false
    }
}

/// Knocks and rings route back through the one controller that owns both doors.
///
/// `@unchecked Sendable`: the notification centre calls these back on an
/// arbitrary thread, and the one mutable field is written and read only on the
/// main actor. Same shape as iOS's `MeetingNoticeDelegate`, deliberately.
private final class StarlingsNoticeDelegate: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    weak var mainWindowController: MainWindowController?
    weak var automation: StarlingsAutomationController?

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let handler = NoticeCompletion(completionHandler)
        Task { @MainActor in
            // Meet already in front is showing the waiting queue and Work's own
            // ring banner; a system banner over the top of them is the same
            // news twice. It lands in Notification Center either way.
            handler.call(NSApp.isActive ? [.list] : [.banner, .list])
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let content = response.notification.request.content
        let category = content.categoryIdentifier
        let action = response.actionIdentifier
        // Pulled out here rather than inside the hop: `userInfo` is a dictionary
        // of `Any` and cannot cross an isolation boundary, but these can.
        let knockRequestID = content.userInfo[KnockNotices.requestIDKey] as? String
        let ringRoomSlug = content.userInfo[RingNotices.roomSlugKey] as? String
        let messageThreadID = content.userInfo[MessageNotices.threadIDKey] as? String
        let inboxThreadID = content.userInfo[InboxNotices.threadIDKey] as? String
        let inboxThreadTitle = content.userInfo[InboxNotices.threadTitleKey] as? String
        let warnedEventID = content.userInfo[MeetingWarningNotices.eventIDKey] as? String
        let meetingCode = content.userInfo[StarlingsAutomationController.codeKey] as? String
        let calendarEventID = content.userInfo[StarlingsAutomationController.eventKey] as? String
        completionHandler()

        Task { @MainActor [weak self] in
            // Automation's notifications need no window.
            switch category {
            case StarlingsAutomationController.startCategory, StarlingsAutomationController.watchdogCategory, StarlingsAutomationController.launchCategory:
                self?.automation?.handleNotification(category: category, action: action, code: meetingCode, eventID: calendarEventID)
                return
            default:
                break
            }
            guard let controller = self?.mainWindowController else { return }
            switch category {
            case KnockNotices.categoryIdentifier:
                guard let requestID = knockRequestID else { return }
                switch action {
                case KnockNotices.admitAction:
                    controller.decideWaitingGuest(requestID: requestID, admit: true)
                case KnockNotices.declineAction:
                    controller.decideWaitingGuest(requestID: requestID, admit: false)
                default:
                    // Tapping the banner itself decides nothing — it opens the
                    // queue and lets the person look at who is there.
                    controller.showMeetingWindow()
                }
            case RingNotices.categoryIdentifier:
                if action == RingNotices.joinAction, let slug = ringRoomSlug {
                    controller.callRoom(slug: slug)
                } else {
                    controller.showTeam(nil)
                }
            case RingNotices.agentStartCategoryIdentifier:
                switch action {
                case RingNotices.openAction:
                    // The transcribing path: an agent's ask is a convened
                    // meeting, not a walk-up.
                    controller.openRoomForAgentAsk()
                case RingNotices.declineAction:
                    controller.dismissIncomingRing()
                default:
                    controller.showMeetingWindow()
                }
            case RingNotices.callCategoryIdentifier:
                switch action {
                case RingNotices.openAction:
                    controller.openRoomForWalkUp()
                case RingNotices.declineAction:
                    // "Not now" is an answer, so it clears the ring rather than
                    // leaving the caller watching a request nobody declined.
                    controller.dismissIncomingRing()
                default:
                    controller.showTeam(nil)
                }
            case MessageNotices.categoryIdentifier:
                guard let threadID = messageThreadID else { return }
                controller.showConversation(threadID: threadID)
            case InboxNotices.categoryIdentifier:
                // A guest row on intake opens its conversation. Any other row
                // is at the top of INBOX; Work is where it is drawn.
                if let threadID = inboxThreadID {
                    controller.showConversation(threadID: threadID, title: inboxThreadTitle)
                } else {
                    controller.showWork(nil)
                }
            case MeetingWarningNotices.categoryIdentifier:
                // Join and the banner itself go the same way: the meeting,
                // through the door the menu bar's rows use.
                controller.showMeetingWindow()
                if let eventID = warnedEventID {
                    controller.meetingViewController.hostUpcomingEventFromMenubar(eventID: eventID)
                }
            default:
                break
            }
        }
    }
}

/// A notification centre completion handler, carried across the hop to the main
/// actor that decides what to do with it.
///
/// `@unchecked Sendable` and genuinely safe: the value is a one-shot callback
/// the notification centre hands over, it is invoked exactly once, and nothing
/// else ever reads it.
private struct NoticeCompletion: @unchecked Sendable {
    private let handler: (UNNotificationPresentationOptions) -> Void

    init(_ handler: @escaping (UNNotificationPresentationOptions) -> Void) {
        self.handler = handler
    }

    func call(_ options: UNNotificationPresentationOptions) {
        handler(options)
    }
}

/// Quits and opens the app again: the Mac's rebuild after a change of
/// workspace (slice E). A shell waits for this process to exit before it
/// opens the bundle, so the new process never meets the old one's socket
/// or windows.
@MainActor
enum StarlingsRelaunch {
    static func now() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [
            "-c",
            "while /bin/kill -0 \"$1\" 2>/dev/null; do /bin/sleep 0.1; done; /usr/bin/open \"$2\"",
            "meet-relaunch",
            String(ProcessInfo.processInfo.processIdentifier),
            Bundle.main.bundleURL.path,
        ]
        do {
            try process.run()
        } catch {
            NSLog("Meet couldn’t relaunch after a workspace change: %@", error.localizedDescription)
        }
        NSApp.terminate(nil)
    }
}
