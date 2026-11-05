import AppKit

struct MeetingMenubarWaitingGuest: Equatable {
    let id: String
    let name: String
    let hasBooking: Bool
}

struct MeetingMenubarSnapshot: Equatable {
    let isOwnerSignedIn: Bool
    let isHost: Bool
    let phase: MeetingPhase
    let roomLink: String
    /// What is left of today. Not the whole feed: "NEXT UP" is a claim about
    /// today, and the window the app fetches now reaches a week out.
    let upcoming: [CalendarEventSummary]
    /// What to say when `upcoming` is empty, written by `MeetingFocus` so the
    /// menu bar, the sidebar, and the phone close the day in the same words.
    let upcomingSummary: String
    let waitingGuests: [MeetingMenubarWaitingGuest]
    let lurkerCount: Int
    let participantCount: Int
    let calendarConnected: Bool
    /// A meeting a crash or force-quit left open on the owner's room. The CTA
    /// is the same click either way — it just reads as a door, not a switch.
    let roomIsOpen: Bool
}

/// Small, owner-only command center for the menu bar. It deliberately owns no
/// meeting state: MeetingViewController remains the source of truth for media,
/// Calendar, and waiting-room decisions.
@MainActor
final class StarlingsMenubarController: NSObject, NSMenuDelegate {
    private weak var mainWindowController: MainWindowController?
    private weak var meetingViewController: MeetingViewController?
    private let statusItem: NSStatusItem
    private let workspaceSwitchController = WorkspaceSwitchMenuController()
    private var menuIsOpen = false
    /// Who is around, published by `PeerWatch` rather than carried in the
    /// meeting snapshot: presence is not meeting state, and the menu bar is the
    /// one place you can reach a colleague without opening a window first.
    private var teamRoster: PeerRoster = .empty
    /// The presence poll's last read reached the Worker. See `PeerWatch.isReachable`.
    private var isReachable = true
    /// Your own tasks, published by `WorkWatch`. What of them is today's is
    /// decided at draw time, so a menu opened after midnight is right.
    private var myWork: [CrmMyTask] = []
    private var myIssues: [CrmIssue] = []
    private var inboxBesideTalk: [WorkInboxItem] = []
    /// Ambient capture — a meeting Meet did not host, recorded from the menu
    /// bar (docs/AMBIENT_CAPTURE.md). Its state is drawn ahead of the room's:
    /// a recording in progress is the one thing here that must not be missed.
    private weak var ambientCapture: AmbientCaptureController?
    private var ambientState: AmbientCaptureController.State = .unsupported
    private var liveCaptionsWindow: AmbientLiveCaptionsWindowController?
    private var elapsedTimer: Timer?
    /// Redraws the flock while an agent you asked is working.
    private var flockTimer: Timer?
    /// Fires when `askedAgentWork` next changes without a new roster.
    private var flockRecheck: Timer?
    private var snapshot = MeetingMenubarSnapshot(
        isOwnerSignedIn: false,
        isHost: false,
        phase: .setup,
        roomLink: "",
        upcoming: [],
        upcomingSummary: "Nothing left today.",
        waitingGuests: [],
        lurkerCount: 0,
        participantCount: 1,
        calendarConnected: false,
        roomIsOpen: false
    )

    init(
        mainWindowController: MainWindowController,
        meetingViewController: MeetingViewController
    ) {
        self.mainWindowController = mainWindowController
        self.meetingViewController = meetingViewController
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        statusItem.menu = makeMenu()
        statusItem.menu?.delegate = self
        updateIcon()
        AgentAsks.onChange = { [weak self] in self?.refreshFlock() }
    }

    func attachAmbientCapture(_ controller: AmbientCaptureController) {
        ambientCapture = controller
        ambientState = controller.state
        controller.onChange = { [weak self] state in
            self?.ambientState = state
            self?.updateIcon()
            self?.refreshFlock()
            self?.rebuildMenuIfOpen()
        }
        updateIcon()
    }

    func update(_ snapshot: MeetingMenubarSnapshot) {
        guard self.snapshot != snapshot else { return }
        self.snapshot = snapshot
        updateIcon()
        if menuIsOpen {
            statusItem.menu = makeMenu()
            statusItem.menu?.delegate = self
        }
    }

    func updateReachable(_ reachable: Bool) {
        guard isReachable != reachable else { return }
        isReachable = reachable
        updateIcon()
    }

    func updateTeam(_ roster: PeerRoster) {
        guard teamRoster != roster else { return }
        teamRoster = roster
        refreshFlock()
        if menuIsOpen {
            statusItem.menu = makeMenu()
            statusItem.menu?.delegate = self
        }
    }

    func updateWork(tasks: [CrmMyTask], issues: [CrmIssue]) {
        guard myWork != tasks || myIssues != issues else { return }
        myWork = tasks
        myIssues = issues
        if menuIsOpen {
            statusItem.menu = makeMenu()
            statusItem.menu?.delegate = self
        }
    }

    /// INBOX beside the talk, for the WORK section ("inbox
    /// everywhere"): the same rows Home's WORK card leads with.
    func updateInbox(_ inbox: WorkInboxResponse) {
        let next = inbox.itemsBesideTalk
        guard next.map(\.id) != inboxBesideTalk.map(\.id) else { return }
        inboxBesideTalk = next
        if menuIsOpen {
            statusItem.menu = makeMenu()
            statusItem.menu?.delegate = self
        }
    }

    func menuWillOpen(_ menu: NSMenu) {
        if case .recording = ambientState {
            // The elapsed line ticks while the menu is open, not in the bar.
            elapsedTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.rebuildMenuIfOpen() }
            }
        }
        menuIsOpen = true
        // Relative times and the waiting queue should be fresh even if no
        // server callback arrived between two clicks.
        menu.removeAllItems()
        makeMenu(into: menu)
    }

    func menuDidClose(_ menu: NSMenu) {
        elapsedTimer?.invalidate()
        elapsedTimer = nil
        menuIsOpen = false
    }

    /// The glyph stays black or white with the bar. Recording adds a red
    /// dot; the elapsed time stays in the menu, not the bar (calm). An alarm
    /// is the dot in the danger colour.
    private var ambientBadge: NSColor? {
        switch ambientState {
        case .recording: StarlingsSemanticColors.recordingMark
        case .alarm: StarlingsSemanticColors.dangerMark
        default: nil
        }
    }

    private var glyphImage: NSImage {
        StarlingsBrand.statusBarGlyphImage(
            size: 18,
            badge: ambientBadge,
            thinkingAt: flockTimer == nil ? nil : Date().timeIntervalSinceReferenceDate,
            inactive: isInactive
        )
    }

    /// Signed out or offline, Starlings does nothing for you: the glyph
    /// greys, as a disconnected VPN does. A recording or an alarm dot keeps
    /// full ink.
    private var isInactive: Bool {
        (!snapshot.isOwnerSignedIn || !isReachable) && ambientBadge == nil
    }

    private func updateIcon() {
        guard let button = statusItem.button else { return }
        button.image = glyphImage
        // The grey is in the image (`isInactive`); appearsDisabled did not
        // fade a template glyph in the bar.
        button.appearsDisabled = false
        button.imagePosition = .imageLeading
        button.title = snapshot.waitingGuests.isEmpty ? "" : " \(snapshot.waitingGuests.count)"
        button.font = .systemFont(ofSize: 11, weight: .semibold)
        button.toolTip = tooltip
        button.setAccessibilityLabel(String(localized: "Starlings"))
        button.setAccessibilityValue(tooltip)
    }

    private var tooltip: String {
        if case .recording = ambientState { return "Starlings: recording this meeting" }
        if !snapshot.waitingGuests.isEmpty {
            return String(localized: "Starlings: \(snapshot.waitingGuests.count) guests waiting")
        }
        if snapshot.phase == .connected {
            return String(localized: "Starlings: \(snapshot.participantCount) participants")
        }
        return String(localized: "Starlings")
    }

    private func makeMenu() -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        makeMenu(into: menu)
        return menu
    }

    private func makeMenu(into menu: NSMenu) {
        addAmbientCapture(to: menu)
        if snapshot.phase == .connected {
            addLabel(String(localized: "IN MEETING · \(snapshot.participantCount) PARTICIPANTS"), to: menu)
        } else if snapshot.phase == .connecting {
            addLabel(String(localized: "STARTING MEETING…"), to: menu)
        } else if snapshot.isOwnerSignedIn {
            addLabel(String(localized: "YOUR ROOM"), to: menu)
        } else {
            addLabel(String(localized: "NOT SIGNED IN"), to: menu)
        }

        if snapshot.isOwnerSignedIn && snapshot.isHost {
            menu.addItem(actionItem(
                snapshot.phase.isIdle
                    ? (snapshot.waitingGuests.isEmpty
                        ? String(localized: "Start room")
                        : (snapshot.roomIsOpen ? String(localized: "Join & Admit next guest") : String(localized: "Start & Admit next guest")))
                    : "Open Home",
                action: #selector(openMeet(_:)),
                enabled: true
            ))
        } else {
            menu.addItem(actionItem(String(localized: "Open Home"), action: #selector(openMeet(_:)), enabled: true))
        }

        menu.addItem(.separator())
        addWaitingRoom(to: menu)
        addTeam(to: menu)
        addWork(to: menu)
        addUpcoming(to: menu)

        menu.addItem(.separator())
        if !snapshot.roomLink.isEmpty {
            menu.addItem(actionItem(String(localized: "Copy room link"), action: #selector(copyRoomLink(_:))))
        }
        if snapshot.isOwnerSignedIn && snapshot.isHost {
            menu.addItem(actionItem(String(localized: "Calendar"), action: #selector(scheduleMeeting(_:))))
        }
        menu.addItem(actionItem(String(localized: "Open Home window"), action: #selector(openMeet(_:))))
        menu.addItem(actionItem(String(localized: "Settings…"), action: #selector(openSettings(_:))))
        menu.addItem(.separator())
        // Which workspace, and as whom: the app menu's account row, here
        // because menu bar mode has no app menu.
        let account = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        account.isEnabled = false
        if AppMenuAccountController.fill(account) {
            menu.addItem(account)
        }
        // The app menu's Switch Workspace, here because menu bar mode has no app menu.
        let switchItem = NSMenuItem(title: String(localized: "Switch Workspace"), action: nil, keyEquivalent: "")
        let switchMenu = NSMenu(title: String(localized: "Switch Workspace"))
        switchMenu.delegate = workspaceSwitchController
        switchItem.submenu = switchMenu
        menu.addItem(switchItem)
        // In menu bar mode there is no app menu, so the full quit lives here.
        let quit = NSMenuItem(
            title: String(localized: "Quit Starlings"),
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: ""
        )
        quit.target = NSApp
        menu.addItem(quit)
    }

    /// Record / Stop for a meeting Meet did not host. Sits first because a
    /// recording in progress outranks everything else in this menu.
    private func addAmbientCapture(to menu: NSMenu) {
        guard let ambientCapture, ambientState != .unsupported else { return }
        switch ambientState {
        case .recording(let since, let warnings):
            let elapsed = Int(Date().timeIntervalSince(since))
            addLabel(String(localized: "RECORDING · \(Self.clock(elapsed))"), to: menu)
            for warning in warnings {
                let item = NSMenuItem(title: warning.text, action: nil, keyEquivalent: "")
                item.isEnabled = false
                item.attributedTitle = NSAttributedString(string: warning.text, attributes: [.foregroundColor: NSColor.systemOrange, .font: NSFont.systemFont(ofSize: 12)])
                item.image = Self.warningImage(tint: .systemOrange)
                menu.addItem(item)
                if warning == .tapSilent {
                    menu.addItem(actionItem(String(localized: "Open System Audio Recording settings"), action: #selector(openAudioRecordingSettings(_:))))
                }
            }
            menu.addItem(actionItem(String(localized: "Live captions"), action: #selector(openLiveCaptions(_:))))
            menu.addItem(actionItem(String(localized: "Stop recording"), action: #selector(stopAmbientCapture(_:))))
        case .alarm(let text):
            let item = NSMenuItem(title: text, action: nil, keyEquivalent: "")
            item.isEnabled = false
            item.attributedTitle = NSAttributedString(string: text, attributes: [.foregroundColor: StarlingsSemanticColors.dangerMark, .font: NSFont.systemFont(ofSize: 12)])
            item.image = Self.warningImage(tint: StarlingsSemanticColors.dangerMark)
            menu.addItem(item)
            menu.addItem(actionItem(String(localized: "Copy error"), action: #selector(copyAmbientAlarm(_:))))
            menu.addItem(actionItem(String(localized: "Dismiss"), action: #selector(dismissAmbientAlarm(_:))))
            addRecordItems(to: menu, controller: ambientCapture)
        case .idle:
            addRecordItems(to: menu, controller: ambientCapture)
        case .unsupported:
            break
        }
        menu.addItem(.separator())
    }

    /// One item, the system default microphone — the way Granola does it.
    /// Which microphone is the default is macOS's Sound setting, not a
    /// choice this menu makes.
    private func addRecordItems(to menu: NSMenu, controller: AmbientCaptureController) {
        guard !controller.inputs.isEmpty else {
            menu.addItem(actionItem(String(localized: "Record this meeting (no microphone)"), action: #selector(startAmbientCapture(_:)), enabled: false))
            return
        }
        menu.addItem(actionItem(String(localized: "Record this meeting"), action: #selector(startAmbientCapture(_:))))
    }

    private static func clock(_ seconds: Int) -> String {
        let h = seconds / 3600, m = (seconds % 3600) / 60, s = seconds % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    private func rebuildMenuIfOpen() {
        guard menuIsOpen, let menu = statusItem.menu else { return }
        menu.removeAllItems()
        makeMenu(into: menu)
    }

    @objc private func startAmbientCapture(_ sender: NSMenuItem) {
        guard let ambientCapture else { return }
        do {
            try ambientCapture.start()
        } catch let error as StarlingsError {
            StarlingsDiagnosticsLog.shared.record(error, context: "ambient")
            let alert = NSAlert()
            alert.messageText = error.title
            alert.informativeText = error.message
            alert.alertStyle = .warning
            alert.addButton(withTitle: String(localized: "OK"))
            if error.recovery == .openScreenRecordingSettings {
                alert.addButton(withTitle: String(localized: "Open Settings"))
            }
            let copyResponse = alert.addCopyErrorButton()
            let response = alert.runModal()
            if response == copyResponse { StarlingsErrorReport.copy(error) }
            else if response == .alertSecondButtonReturn, error.recovery == .openScreenRecordingSettings { SystemSettingsOpener.openPrivacyScreenRecording() }
        } catch {
            NSLog("ambient capture start failed: %@", String(describing: error))
        }
    }

    @objc private func stopAmbientCapture(_ sender: Any?) {
        ambientCapture?.stop()
    }

    /// The live captions panel. One per app; reopens where it was.
    @objc private func openLiveCaptions(_ sender: Any?) {
        guard let ambientCapture else { return }
        let panel = liveCaptionsWindow ?? AmbientLiveCaptionsWindowController(controller: ambientCapture)
        liveCaptionsWindow = panel
        panel.show()
    }

    @objc private func dismissAmbientAlarm(_ sender: Any?) {
        ambientCapture?.dismissAlarm()
    }

    @objc private func copyAmbientAlarm(_ sender: Any?) {
        guard case .alarm(let text) = ambientState else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    @objc private func openAudioRecordingSettings(_ sender: Any?) {
        SystemSettingsOpener.openPrivacyScreenRecording()
    }

    private func addWaitingRoom(to menu: NSMenu) {
        let waitingCount = snapshot.waitingGuests.count
        let lurkerCount = snapshot.lurkerCount
        addLabel(
            waitingCount == 0 ? String(localized: "WAITING ROOM") : String(localized: "WAITING ROOM · \(waitingCount)"),
            to: menu
        )

        if waitingCount == 0 {
            let empty = NSMenuItem(title: lurkerCount == 0 ? String(localized: "No one waiting") : String(localized: "No one waiting"), action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        } else {
            for guest in snapshot.waitingGuests {
                let row = NSMenuItem(title: guest.displayName, action: nil, keyEquivalent: "")
                let submenu = NSMenu()
                let admit = actionItem(String(localized: "Admit"), action: #selector(admitGuest(_:)))
                admit.representedObject = guest.id
                let decline = actionItem(String(localized: "Decline"), action: #selector(declineGuest(_:)))
                decline.representedObject = guest.id
                submenu.addItem(admit)
                submenu.addItem(decline)
                row.submenu = submenu
                menu.addItem(row)
            }
            let clear = actionItem(String(localized: "Clear waiting room"), action: #selector(clearWaitingRoom(_:)))
            clear.isEnabled = snapshot.isHost
            menu.addItem(clear)
        }

        if lurkerCount > 0 {
            let lurkers = NSMenuItem(
                title: String(localized: "\(lurkerCount) people viewing the room"),
                action: nil,
                keyEquivalent: ""
            )
            lurkers.isEnabled = false
            menu.addItem(lurkers)
        }
    }

    /// Reaching a colleague without opening anything. Call knocks straight
    /// away — the same deliberate action offered from the Team destination.
    private func addTeam(to menu: NSMenu) {
        guard snapshot.isOwnerSignedIn else { return }
        menu.addItem(.separator())
        let others = teamRoster.others
        addLabel("TEAM", to: menu)

        guard !others.isEmpty else {
            let empty = NSMenuItem(title: String(localized: "Nobody else has signed in yet"), action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
            return
        }

        // Keep each colleague as a contact submenu so the two different
        // gestures stay together: Wave asks for attention, Call goes to their
        // room. The roster itself lives in Team; this menu is the quick
        // path that does not require opening another window.
        let contacts = others.filter { $0.isRingable || $0.isCallable }
        if contacts.isEmpty {
            let empty = NSMenuItem(title: String(localized: "Nobody is reachable right now"), action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        } else {
            for peer in contacts.prefix(6) {
                let item = NSMenuItem(title: peer.displayName, action: nil, keyEquivalent: "")
                let submenu = NSMenu()

                if peer.isRingable {
                    let wave = actionItem(String(localized: "Wave"), action: #selector(wavePeer(_:)))
                    wave.representedObject = peer.email
                    submenu.addItem(wave)
                }
                if peer.isCallable {
                    let call = actionItem(String(localized: "Call"), action: #selector(callPeer(_:)))
                    call.representedObject = peer
                    submenu.addItem(call)
                }
                item.submenu = submenu
                menu.addItem(item)
            }
        }
        menu.addItem(actionItem(String(localized: "Open Team"), action: #selector(openTeam(_:))))
    }

    /// Mine's focus slice, as Home draws it, one line each. A menu is not the
    /// list — the list is Work.
    private func addWork(to menu: NSMenu) {
        guard snapshot.isOwnerSignedIn else { return }
        menu.addItem(.separator())
        let focus = HomeFocus.plan(tasks: myWork, issues: myIssues)
        addLabel(focus.summary.map { "WORK · \($0.uppercased())" } ?? String(localized: "WORK"), to: menu)

        // What needs a decision, before what is due — as Home's WORK card.
        for (index, item) in inboxBesideTalk.prefix(4).enumerated() {
            let entry = actionItem(Self.glanceRow(title: item.glanceTitle, detail: item.glanceDetail), action: #selector(openInboxItem(_:)))
            entry.representedObject = index
            // The row is capped; the whole title and detail stay one hover away.
            entry.toolTip = "\(item.glanceTitle)\n\(item.glanceDetail)"
            menu.addItem(entry)
        }
        if inboxBesideTalk.count > 4 {
            let more = NSMenuItem(title: String(localized: "and \(inboxBesideTalk.count - 4) more in Work"), action: nil, keyEquivalent: "")
            more.isEnabled = false
            menu.addItem(more)
        }

        if focus.isEmpty && inboxBesideTalk.isEmpty {
            let empty = NSMenuItem(title: String(localized: "Nothing needs you today."), action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        } else if !focus.isEmpty {
            for row in focus.rows.prefix(6) {
                let title = Self.glanceRow(title: row.homeTitle, detail: row.homeDetail)
                let item = actionItem(title, action: #selector(openWorkTask(_:)), enabled: row.homeDestination != nil)
                item.representedObject = row.workID
                // The row is capped; the whole title and detail stay one hover away.
                item.toolTip = row.homeDetail.isEmpty ? row.homeTitle : "\(row.homeTitle)\n\(row.homeDetail)"
                if focus.isLate(row) {
                    // Late is bold neutral ink, not a colour — the tooltip
                    // below already says "Overdue."
                    item.attributedTitle = NSAttributedString(
                        string: title,
                        attributes: [.font: NSFont.boldSystemFont(ofSize: NSFont.menuFont(ofSize: 0).pointSize)]
                    )
                }
                menu.addItem(item)
            }
        }
        menu.addItem(actionItem(String(localized: "Open Work"), action: #selector(openWork(_:))))
    }

    private func addUpcoming(to menu: NSMenu) {
        menu.addItem(.separator())
        // A row's clock says nothing about its day. When the list has left
        // today, the label above it says so — "TOMORROW" instead of "NEXT UP",
        // or a second label where today's rows end and tomorrow's begin.
        let firstDay = snapshot.upcoming.first.flatMap { dayLabel(for: $0) }
        addLabel(firstDay ?? String(localized: "NEXT UP"), to: menu)
        guard snapshot.calendarConnected else {
            // A door, not a notice: this opens Settings on the Calendar page.
            // Only Google connects, so other suites get no door.
            if StarlingsWorkspace.active.calendarConnectable {
                menu.addItem(actionItem(String(localized: "Connect a calendar…"), action: #selector(connectCalendar(_:))))
            }
            return
        }
        guard !snapshot.upcoming.isEmpty else {
            let item = NSMenuItem(title: snapshot.upcomingSummary, action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
            return
        }

        var shownDay = firstDay
        for event in snapshot.upcoming.prefix(3) {
            let day = dayLabel(for: event)
            if day != shownDay, let day {
                addLabel(day, to: menu)
            }
            shownDay = day
            let clock = MeetingCountdown.clockRange(
                startISO: event.start,
                endISO: event.end,
                isAllDay: event.isAllDay
            )
            let item = actionItem(
                [clock.isEmpty ? Self.clipped(event.title) : "\(clock)  \(Self.clipped(event.title))", CalendarTravelTime.label(minutes: event.travelTimeMinutes)]
                    .compactMap { $0 }
                    .joined(separator: " · "),
                // Physical events remain useful context in the menu, but only
                // an explicit conference URL gets a menu action.
                action: #selector(useUpcoming(_:)),
                enabled: event.isVideoMeeting
            )
            item.representedObject = event.id
            menu.addItem(item)
        }
    }

    /// Nil for today — the default the menu never names. "TOMORROW" for
    /// tomorrow, the weekday beyond that.
    private func dayLabel(for event: CalendarEventSummary) -> String? {
        guard let start = ISODate.parse(event.start) else { return nil }
        let calendar = Calendar.current
        if calendar.isDateInToday(start) { return nil }
        if calendar.isDateInTomorrow(start) { return "TOMORROW" }
        return start.formatted(.dateTime.weekday(.wide)).uppercased()
    }

    private func addLabel(_ title: String, to menu: NSMenu) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        item.attributedTitle = NSAttributedString(
            string: title,
            attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .semibold),
                .foregroundColor: NSColor.secondaryLabelColor,
            ]
        )
        menu.addItem(item)
    }

    /// The flock moves in the thinking wave while an agent you asked is
    /// working, and is still otherwise. A recording or an alarm keeps it
    /// still, so the dot is the one thing that moves the eye. Reduce Motion
    /// and Low Power Mode keep it still too.
    private func refreshFlock() {
        let now = Date()
        let work = askedAgentWork(at: now)
        flockRecheck?.invalidate()
        flockRecheck = work.changesAt.map { date in
            Timer.scheduledTimer(withTimeInterval: date.timeIntervalSince(now) + 0.5, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated { self?.refreshFlock() }
            }
        }
        let moves = work.working && ambientBadge == nil && !Self.motionIsQuiet
        if moves, flockTimer == nil {
            let timer = Timer(timeInterval: 1.0 / 15, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.flockFrame() }
            }
            RunLoop.main.add(timer, forMode: .common)
            flockTimer = timer
        } else if !moves, let timer = flockTimer {
            timer.invalidate()
            flockTimer = nil
            updateIcon()
        }
    }

    private func flockFrame() {
        guard !Self.motionIsQuiet else { return refreshFlock() }
        statusItem.button?.image = glyphImage
    }

    private static var motionIsQuiet: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion || ProcessInfo.processInfo.isLowPowerModeEnabled
    }

    /// Whether an agent this Mac asked is working, and when that answer next
    /// changes on its own. Working is the roster's `busy` with a future
    /// `busyUntil` (the same expiry the thread pane applies), on a hand-off
    /// accepted after you asked: `since` is the acceptance, and a later one
    /// means somebody else's ask. In the first seconds after you ask, before
    /// the roster can know, it reads as working on trust.
    private func askedAgentWork(at now: Date) -> (working: Bool, changesAt: Date?) {
        let grace = DirectMessageCadence.agentAcceptGrace
        var working = false
        var changesAt: Date?
        func change(at date: Date) {
            if date > now { changesAt = min(changesAt ?? date, date) }
        }
        for peer in teamRoster.peers where peer.isAgent {
            guard let asked = AgentAsks.lastAsked[peer.email] else { continue }
            if asked.addingTimeInterval(grace) > now {
                working = true
                change(at: asked.addingTimeInterval(grace))
            }
            if peer.status == .busy, let until = peer.busyUntil, until > now,
               asked >= (peer.since ?? .distantPast).addingTimeInterval(-grace) {
                working = true
                change(at: until)
            }
        }
        return (working, changesAt)
    }

    /// A row title cut at a word before `limit` characters, so a long issue
    /// title does not stretch the whole menu. The row's detail after it
    /// (who, which issue) stays whole; the tooltip carries the full title.
    /// One WORK row, at most `limit` characters, so AppKit never
    /// middle-truncates it. The detail goes first, in at most half
    /// the row: its first part and, when it fits, its last part ("Decision ·
    /// Default by 16 Oct"); one long part is clipped. The title takes the rest.
    static func glanceRow(title: String, detail: String, limit: Int = 60) -> String {
        let parts = detail.components(separatedBy: " · ").filter { !$0.isEmpty }
        guard let first = parts.first else { return clipped(title, limit: limit) }
        let half = limit / 2
        var tail = first.count > half ? clipped(first, limit: half) : first
        if parts.count > 1, let last = parts.last, tail.count + 3 + last.count <= half {
            tail += " · \(last)"
        }
        return "\(clipped(title, limit: max(12, limit - tail.count - 3))) · \(tail)"
    }

    static func clipped(_ title: String, limit: Int = 48) -> String {
        guard title.count > limit else { return title }
        let head = title.prefix(limit - 1)
        let cut = head.lastIndex(of: " ").map { head[..<$0] } ?? head
        return cut.trimmingCharacters(in: CharacterSet(charactersIn: " ,:;·-")) + "…"
    }

    private func actionItem(
        _ title: String,
        action: Selector,
        enabled: Bool = true
    ) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.isEnabled = enabled
        return item
    }

    @objc private func openMeet(_ sender: Any?) {
        if snapshot.isOwnerSignedIn && snapshot.isHost && snapshot.phase.isIdle {
            meetingViewController?.toggleMeeting(nil)
        }
        mainWindowController?.showMeetingWindow()
    }

    @objc private func copyRoomLink(_ sender: Any?) {
        meetingViewController?.copyInviteLink(nil)
    }

    @objc private func scheduleMeeting(_ sender: Any?) {
        meetingViewController?.presentScheduleMeeting(nil)
    }

    /// The same Call as Team's: ask when nobody is in a room yet, walk in
    /// when somebody is. Knocking on their room straight from here
    /// skipped the ask and waited in a lobby nobody was hosting.
    @objc private func callPeer(_ sender: NSMenuItem) {
        guard let peer = sender.representedObject as? Peer else { return }
        mainWindowController?.callPeerFromMenuBar(peer)
    }

    @objc private func wavePeer(_ sender: NSMenuItem) {
        guard let email = sender.representedObject as? String else { return }
        mainWindowController?.wavePeer(email: email)
    }

    @objc private func openTeam(_ sender: Any?) {
        mainWindowController?.showTeam(nil)
    }

    @objc private func openWork(_ sender: Any?) {
        mainWindowController?.showWork(sender)
    }

    @objc private func connectCalendar(_ sender: Any?) {
        mainWindowController?.showCalendarSettings()
    }

    @objc private func openInboxItem(_ sender: NSMenuItem) {
        guard let index = sender.representedObject as? Int, inboxBesideTalk.indices.contains(index) else { return }
        let item = inboxBesideTalk[index]
        if let threadID = item.glanceThreadID {
            mainWindowController?.showConversation(threadID: threadID, title: item.glanceTitle)
        } else if let destination = item.glanceDestination {
            mainWindowController?.showWork(destination)
        } else {
            openWork(sender)
        }
    }

    @objc private func openWorkTask(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        let rows = HomeFocus.plan(tasks: myWork, issues: myIssues).rows
        guard let destination = rows.first(where: { $0.workID == id })?.homeDestination else { return }
        mainWindowController?.showWork(destination)
    }

    @objc private func openSettings(_ sender: Any?) {
        mainWindowController?.showSettings(sender)
    }

    @objc private func admitGuest(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        meetingViewController?.decideWaitingGuest(requestID: id, admit: true)
    }

    @objc private func declineGuest(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        meetingViewController?.decideWaitingGuest(requestID: id, admit: false)
    }

    @objc private func clearWaitingRoom(_ sender: Any?) {
        meetingViewController?.declineAllWaitingGuestsFromMenubar()
    }

    @objc private func useUpcoming(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        meetingViewController?.hostUpcomingEventFromMenubar(eventID: id)
        mainWindowController?.showMeetingWindow()
    }
}

private extension MeetingMenubarWaitingGuest {
    var displayName: String {
        hasBooking ? String(localized: "\(name) · booked") : name
    }
}

extension StarlingsMenubarController {
    /// The warning mark on a menu row: an SF Symbol, never a Unicode glyph
    /// (docs/DESIGN.md iconography law).
    static func warningImage(tint: NSColor) -> NSImage? {
        NSImage(systemSymbolName: "exclamationmark.triangle.fill", accessibilityDescription: String(localized: "Warning"))?
            .withSymbolConfiguration(.init(paletteColors: [tint]))
    }
}

/// The agents this Mac asked for something, and when. The roster says an
/// agent is busy, not for whom, so the menu bar flock reads this to move only
/// for your own asks. Memory only: after a relaunch the flock stays still
/// rather than guess. replaces it with a roster field that says who an
/// agent works for.
@MainActor
enum AgentAsks {
    private(set) static var lastAsked: [String: Date] = [:]
    static var onChange: (() -> Void)?

    static func record(_ agent: Peer) {
        guard agent.isAgent else { return }
        lastAsked[agent.email] = Date()
        onChange?()
    }
}
