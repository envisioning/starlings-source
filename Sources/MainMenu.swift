import AppKit

enum MainMenuBuilder {
    /// Retained so submenu `NSMenuDelegate`s stay alive for the app lifetime.
    @MainActor private static var deviceMenuControllers: [MeetingDeviceMenuController] = []
    @MainActor private static var accountMenuController: AppMenuAccountController?
    @MainActor private static var workspaceSwitchController: WorkspaceSwitchMenuController?

    @MainActor
    static func install() {
        let appName = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String
            ?? String(localized: "Starlings")

        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu(title: appName)
        appMenuItem.submenu = appMenu

        appMenu.addItem(
            withTitle: String(localized: "About \(appName)"),
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(
            withTitle: String(localized: "Check for Updates…"),
            action: #selector(AppDelegate.checkForUpdates(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(.separator())
        let settingsItem = appMenu.addItem(
            withTitle: String(localized: "Settings…"),
            action: #selector(AppDelegate.showSettings(_:)),
            keyEquivalent: ","
        )
        settingsItem.target = nil
        // Which workspace, and as whom. A window carries no account chip
        // (not HIG); the app menu says it, the way macOS apps name the
        // signed-in account above Sign Out.
        let accountItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        accountItem.isEnabled = false
        appMenu.addItem(accountItem)
        let accountController = AppMenuAccountController(item: accountItem)
        appMenu.delegate = accountController
        accountMenuController = accountController
        accountController.menuNeedsUpdate(appMenu)
        // Every workspace added on this Mac, and Add Workspace.
        let switchItem = NSMenuItem(title: String(localized: "Switch Workspace"), action: nil, keyEquivalent: "")
        let switchMenu = NSMenu(title: String(localized: "Switch Workspace"))
        let switchController = WorkspaceSwitchMenuController()
        switchMenu.delegate = switchController
        switchItem.submenu = switchMenu
        appMenu.addItem(switchItem)
        workspaceSwitchController = switchController
        appMenu.addItem(
            withTitle: String(localized: "Admin on the Web…"),
            action: #selector(AppDelegate.openWebAdmin(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(
            withTitle: String(localized: "Sign in…"),
            action: #selector(AppDelegate.signInWithGoogle(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(
            withTitle: String(localized: "Sign Out"),
            action: #selector(AppDelegate.signOutOwner(_:)),
            keyEquivalent: ""
        )
        // Option turns Sign Out into Sign Out of All Workspaces.
        let signOutAll = appMenu.addItem(
            withTitle: String(localized: "Sign Out of All Workspaces"),
            action: #selector(AppDelegate.signOutOfAllWorkspaces(_:)),
            keyEquivalent: ""
        )
        signOutAll.keyEquivalentModifierMask = [.option]
        signOutAll.isAlternate = true
        appMenu.addItem(.separator())

        let servicesItem = appMenu.addItem(withTitle: String(localized: "Services"), action: nil, keyEquivalent: "")
        let servicesMenu = NSMenu()
        servicesItem.submenu = servicesMenu
        NSApp.servicesMenu = servicesMenu

        appMenu.addItem(.separator())
        appMenu.addItem(
            withTitle: String(localized: "Hide \(appName)"),
            action: #selector(NSApplication.hide(_:)),
            keyEquivalent: "h"
        )
        let hideOthers = appMenu.addItem(
            withTitle: String(localized: "Hide Others"),
            action: #selector(NSApplication.hideOtherApplications(_:)),
            keyEquivalent: "h"
        )
        hideOthers.keyEquivalentModifierMask = [.option, .command]
        appMenu.addItem(
            withTitle: String(localized: "Show All"),
            action: #selector(NSApplication.unhideAllApplications(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(.separator())
        // Closes the windows and the Dock icon; the menu bar item stays, and
        // opening any window from it brings the Dock icon back.
        appMenu.addItem(
            withTitle: String(localized: "Quit to Menu Bar"),
            action: #selector(AppDelegate.quitToMenuBar(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(
            withTitle: String(localized: "Quit \(appName)"),
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )

        let fileMenuItem = NSMenuItem()
        mainMenu.addItem(fileMenuItem)
        let fileMenu = NSMenu(title: String(localized: "File"))
        fileMenuItem.submenu = fileMenu
        fileMenu.addItem(
            withTitle: String(localized: "New Event…"),
            action: #selector(AppDelegate.newCalendarEvent(_:)),
            keyEquivalent: "n"
        )
        fileMenu.addItem(.separator())
        fileMenu.addItem(
            withTitle: String(localized: "Close Window"),
            action: #selector(NSWindow.performClose(_:)),
            keyEquivalent: "w"
        )

        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: String(localized: "Edit"))
        editMenuItem.submenu = editMenu
        editMenu.addItem(withTitle: String(localized: "Undo"), action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: String(localized: "Redo"), action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.shift, .command]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: String(localized: "Cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: String(localized: "Copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: String(localized: "Paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: String(localized: "Select All"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenu.addItem(.separator())
        editMenu.addItem(
            withTitle: String(localized: "Delete Event"),
            action: #selector(CalendarViewController.deleteSelectedEvent(_:)),
            keyEquivalent: "\u{8}"
        )
        // One Find for the shell windows: Calendar's events, Work's subjects,
        // and Team's people/conversations.
        // It resolves through the responder chain, so it reaches whichever of
        // the two is frontmost — and is now the *only* way the caret gets into
        // a search box, since neither window opens with it focused.
        editMenu.addItem(
            withTitle: String(localized: "Find"),
            action: #selector(StarlingsShellViewController.findInSurface(_:)),
            keyEquivalent: "f"
        )
        // ⌘K is global where ⌘F is local ( decision 1): one palette
        // that finds anything and jumps anywhere, over whichever window is
        // key. Find stays the window's own field, which is the same search
        // with that window's scope.
        editMenu.addItem(
            withTitle: String(localized: "Search Anything…"),
            action: #selector(AppDelegate.showSearch(_:)),
            keyEquivalent: "k"
        )

        let meetingMenuItem = NSMenuItem()
        mainMenu.addItem(meetingMenuItem)
        let meetingMenu = NSMenu(title: String(localized: "Meeting"))
        meetingMenuItem.submenu = meetingMenu
        let muteItem = meetingMenu.addItem(
            withTitle: String(localized: "Mute"),
            action: #selector(MeetingViewController.toggleMicrophone(_:)),
            keyEquivalent: "a"
        )
        muteItem.keyEquivalentModifierMask = [.command, .shift]
        let videoItem = meetingMenu.addItem(
            withTitle: String(localized: "Stop Video"),
            action: #selector(MeetingViewController.toggleCamera(_:)),
            keyEquivalent: "v"
        )
        videoItem.keyEquivalentModifierMask = [.command, .shift]
        let shareItem = meetingMenu.addItem(
            withTitle: String(localized: "Share Screen…"),
            action: #selector(MeetingViewController.shareScreen(_:)),
            keyEquivalent: "s"
        )
        shareItem.keyEquivalentModifierMask = [.command, .shift]
        // ⌘⇧H matches Zoom's show/hide chat. ⌘⇧C, the obvious first choice, is
        // already Copy Invite Link.
        let chatItem = meetingMenu.addItem(
            withTitle: String(localized: "Chat"),
            action: #selector(MeetingViewController.toggleChat(_:)),
            keyEquivalent: "h"
        )
        chatItem.keyEquivalentModifierMask = [.command, .shift]
        meetingMenu.addItem(
            withTitle: String(localized: "Live Transcript"),
            action: #selector(MeetingViewController.toggleTranscriptPanel(_:)),
            keyEquivalent: ""
        )
        // ⌥⌘S is the Mac's sidebar key everywhere else; ⌘⇧S is already Share
        // Screen here. Live meetings only — idle, the rail is the screen.
        let panelItem = meetingMenu.addItem(
            withTitle: String(localized: "Hide Meeting Panel"),
            action: #selector(MeetingViewController.toggleMeetingPanel(_:)),
            keyEquivalent: "s"
        )
        panelItem.keyEquivalentModifierMask = [.command, .option]
        // The rail and the transcript are two halves of one intention — "just
        // the meeting" — so one key does both and puts both back.
        let focusItem = meetingMenu.addItem(
            withTitle: String(localized: "Focus"),
            action: #selector(MeetingViewController.toggleFocusMode(_:)),
            keyEquivalent: "f"
        )
        focusItem.keyEquivalentModifierMask = [.command, .option]
        meetingMenu.addItem(.separator())

        deviceMenuControllers = [
            attachDeviceSubmenu(to: meetingMenu, title: String(localized: "Microphone"), kind: .microphone),
            attachDeviceSubmenu(to: meetingMenu, title: String(localized: "Camera"), kind: .camera),
            attachDeviceSubmenu(to: meetingMenu, title: String(localized: "Speaker"), kind: .speaker),
        ]

        meetingMenu.addItem(.separator())
        meetingMenu.addItem(
            withTitle: String(localized: "Blur Background"),
            action: #selector(MeetingViewController.toggleBackgroundBlur(_:)),
            keyEquivalent: ""
        )
        meetingMenu.addItem(
            withTitle: String(localized: "Block Background"),
            action: #selector(MeetingViewController.toggleBackgroundBlock(_:)),
            keyEquivalent: ""
        )
        meetingMenu.addItem(
            withTitle: String(localized: "Hide Me"),
            action: #selector(MeetingViewController.toggleHideSelf(_:)),
            keyEquivalent: ""
        )
        meetingMenu.addItem(
            withTitle: String(localized: "Float Me"),
            action: #selector(MeetingViewController.toggleFloatSelf(_:)),
            keyEquivalent: ""
        )
        meetingMenu.addItem(
            withTitle: String(localized: "Center Stage"),
            action: #selector(MeetingViewController.toggleCenterStage(_:)),
            keyEquivalent: ""
        )
        meetingMenu.addItem(
            withTitle: String(localized: "Video Effects…"),
            action: #selector(MeetingViewController.openSystemVideoEffects(_:)),
            keyEquivalent: ""
        )
        meetingMenu.addItem(
            withTitle: String(localized: "Microphone Modes…"),
            action: #selector(MeetingViewController.openSystemMicrophoneModes(_:)),
            keyEquivalent: ""
        )
        meetingMenu.addItem(.separator())
        let copyInviteItem = meetingMenu.addItem(
            withTitle: String(localized: "Copy Invite Link"),
            action: #selector(MeetingViewController.copyInviteLink(_:)),
            keyEquivalent: "c"
        )
        copyInviteItem.keyEquivalentModifierMask = [.command, .shift]
        meetingMenu.addItem(
            withTitle: String(localized: "Calendar"),
            action: #selector(AppDelegate.showCalendar(_:)),
            keyEquivalent: ""
        )
        meetingMenu.addItem(
            withTitle: String(localized: "Join Someone Else’s Room…"),
            action: #selector(MeetingViewController.switchToJoinMode(_:)),
            keyEquivalent: ""
        )
        meetingMenu.addItem(.separator())
        meetingMenu.addItem(
            withTitle: String(localized: "Start Meeting"),
            action: #selector(MeetingViewController.toggleMeeting(_:)),
            keyEquivalent: "\r"
        )
        meetingMenu.addItem(.separator())
        meetingMenu.addItem(
            withTitle: String(localized: "Take host"),
            action: #selector(MeetingViewController.takeHost(_:)),
            keyEquivalent: ""
        )
        meetingMenu.addItem(
            withTitle: String(localized: "Move host…"),
            action: #selector(MeetingViewController.moveHost(_:)),
            keyEquivalent: ""
        )
        meetingMenu.addItem(
            withTitle: String(localized: "Leave meeting"),
            action: #selector(MeetingViewController.leaveMeeting(_:)),
            keyEquivalent: ""
        )
        meetingMenu.addItem(.separator())
        // Host moderation. Everything else about a participant is a right-click
        // on their row in the sidebar; this one is a room-wide action, so it
        // belongs to the meeting rather than to anybody in it.
        meetingMenu.addItem(
            withTitle: String(localized: "Mute Everyone Else"),
            action: #selector(MeetingViewController.muteEveryoneElse(_:)),
            keyEquivalent: ""
        )
        // Beside it for the same reason: both are room-wide, and both belong to
        // whoever is running the meeting rather than to anybody in it. Clearing
        // the queue after answering it is the other half of having one.
        meetingMenu.addItem(
            withTitle: String(localized: "Lower All Hands"),
            action: #selector(MeetingViewController.lowerAllHandsFromMenu),
            keyEquivalent: ""
        )
        // `/room/team` only: there the host's ⌘⇧W leaves, and ending the call
        // for the people still in it is its own act. Hidden
        // everywhere else — see `validateMenuItem`.
        meetingMenu.addItem(
            withTitle: String(localized: "End Meeting for Everyone"),
            action: #selector(MeetingViewController.endMeetingForEveryone(_:)),
            keyEquivalent: ""
        )
        meetingMenu.addItem(.separator())
        let admitItem = meetingMenu.addItem(
            withTitle: String(localized: "Admit Next Guest"),
            action: #selector(MeetingViewController.admitNextWaitingGuest(_:)),
            keyEquivalent: "\r"
        )
        admitItem.keyEquivalentModifierMask = [.command, .shift]
        let declineItem = meetingMenu.addItem(
            withTitle: String(localized: "Decline Next Guest"),
            action: #selector(MeetingViewController.rejectNextWaitingGuest(_:)),
            keyEquivalent: "\u{08}"
        )
        declineItem.keyEquivalentModifierMask = [.command, .shift]

        let workMenuItem = NSMenuItem()
        mainMenu.addItem(workMenuItem)
        let workMenu = NSMenu(title: String(localized: "Work"))
        workMenuItem.submenu = workMenu
        workMenu.addItem(
            withTitle: String(localized: "New Project…"),
            action: #selector(AppDelegate.newWorkProject(_:)),
            keyEquivalent: ""
        )
        workMenu.addItem(
            withTitle: String(localized: "New Lead…"),
            action: #selector(AppDelegate.newWorkLead(_:)),
            keyEquivalent: ""
        )
        workMenu.addItem(.separator())
        let newTask = workMenu.addItem(
            withTitle: String(localized: "New Task"),
            action: #selector(AppDelegate.newWorkTask(_:)),
            keyEquivalent: "t"
        )
        newTask.keyEquivalentModifierMask = [.command, .option]
        let newIssue = workMenu.addItem(
            withTitle: String(localized: "New Issue"),
            action: #selector(AppDelegate.newWorkIssue(_:)),
            keyEquivalent: "i"
        )
        newIssue.keyEquivalentModifierMask = [.command, .option]
        let newDocument = workMenu.addItem(
            withTitle: String(localized: "New Document"),
            action: #selector(AppDelegate.newWorkDocument(_:)),
            keyEquivalent: "d"
        )
        newDocument.keyEquivalentModifierMask = [.command, .option]
        workMenu.addItem(
            withTitle: String(localized: "New Quick Note…"),
            action: #selector(AppDelegate.newWorkQuickNote(_:)),
            keyEquivalent: ""
        )
        workMenu.addItem(.separator())
        workMenu.addItem(
            withTitle: String(localized: "Meet about this"),
            action: #selector(AppDelegate.meetAboutSelectedWork(_:)),
            keyEquivalent: ""
        )
        workMenu.addItem(.separator())
        // Hopping between subjects is how Work is used, so it has a history
        // like a browser ( slice 3b). Overview is the way home.
        let overview = workMenu.addItem(
            withTitle: String(localized: "Overview"),
            action: #selector(AppDelegate.showWorkOverview(_:)),
            keyEquivalent: "0"
        )
        overview.keyEquivalentModifierMask = [.command, .option]
        workMenu.addItem(
            withTitle: String(localized: "Browse Subjects"),
            action: #selector(AppDelegate.showWorkBrowse(_:)),
            keyEquivalent: ""
        )
        let back = workMenu.addItem(
            withTitle: String(localized: "Back"),
            action: #selector(AppDelegate.workBack(_:)),
            keyEquivalent: "["
        )
        back.keyEquivalentModifierMask = [.command]
        let forward = workMenu.addItem(
            withTitle: String(localized: "Forward"),
            action: #selector(AppDelegate.workForward(_:)),
            keyEquivalent: "]"
        )
        forward.keyEquivalentModifierMask = [.command]
        workMenu.addItem(.separator())
        // Docs has its own window and a search from here ( decision 6).
        workMenu.addItem(
            withTitle: String(localized: "Search Docs…"),
            action: #selector(AppDelegate.searchWorkDocs(_:)),
            keyEquivalent: ""
        )
        // Keep is a link out, because its vaults only open in a browser that
        // holds the key.
        workMenu.addItem(
            withTitle: String(localized: "Keep…"),
            action: #selector(AppDelegate.openKeep(_:)),
            keyEquivalent: ""
        )

        // Calendar's selected event. Responder-chain targets like the View
        // items below: grey unless the Calendar window is frontmost and an
        // event is marked, per `CalendarViewController.validateMenuItem`.
        // ⌘D duplicates, as in Calendar.app; the letters are free elsewhere
        // (Work's New Document is ⌥⌘D).
        let eventMenuItem = NSMenuItem()
        mainMenu.addItem(eventMenuItem)
        let eventMenu = NSMenu(title: String(localized: "Event"))
        eventMenuItem.submenu = eventMenu
        eventMenu.addItem(
            withTitle: String(localized: "Open"),
            action: #selector(CalendarViewController.openSelectedEvent(_:)),
            keyEquivalent: "o"
        )
        eventMenu.addItem(
            withTitle: String(localized: "Join"),
            action: #selector(CalendarViewController.joinSelectedEvent(_:)),
            keyEquivalent: "j"
        )
        let copyLink = eventMenu.addItem(
            withTitle: String(localized: "Copy link"),
            action: #selector(CalendarViewController.copySelectedEventLink(_:)),
            keyEquivalent: "c"
        )
        copyLink.keyEquivalentModifierMask = [.shift, .command]
        eventMenu.addItem(.separator())
        eventMenu.addItem(
            withTitle: String(localized: "Duplicate"),
            action: #selector(CalendarViewController.duplicateSelectedEvent(_:)),
            keyEquivalent: "d"
        )
        eventMenu.addItem(.separator())
        let keys: [CalendarRSVP: String] = [.accepted: "y", .tentative: "m", .declined: "n"]
        for response in CalendarRSVP.answers {
            let key = keys[response] ?? ""
            let item = eventMenu.addItem(
                withTitle: response.answerTitle,
                action: #selector(CalendarViewController.respondToSelectedEvent(_:)),
                keyEquivalent: key
            )
            item.keyEquivalentModifierMask = [.shift, .command]
            item.representedObject = response.rawValue
        }
        eventMenu.addItem(.separator())
        eventMenu.addItem(
            withTitle: String(localized: "Delete"),
            action: #selector(CalendarViewController.deleteSelectedEvent(_:)),
            keyEquivalent: ""
        )

        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: String(localized: "View"))
        viewMenuItem.submenu = viewMenu
        // Calendar navigation. Responder-chain targets, so these dim to grey
        // unless the Calendar window is frontmost.
        // ⌃⌘1/2/3 rather than Calendar.app's plain ⌘1/2/3: the bare digits are
        // the three *windows* now (Window menu). What a window is showing is a
        // tier below which window you are in, so these took the same digits one
        // modifier down. The digits come from `CalendarViewMode` so the
        // bindings and the toolbar's tooltips cannot drift.
        let dayItem = viewMenu.addItem(
            withTitle: CalendarViewMode.day.label,
            action: #selector(CalendarViewController.showDayView(_:)),
            keyEquivalent: CalendarViewMode.day.shortcut
        )
        dayItem.keyEquivalentModifierMask = [.control, .command]
        let weekItem = viewMenu.addItem(
            withTitle: CalendarViewMode.week.label,
            action: #selector(CalendarViewController.showWeekView(_:)),
            keyEquivalent: CalendarViewMode.week.shortcut
        )
        weekItem.keyEquivalentModifierMask = [.control, .command]
        let monthItem = viewMenu.addItem(
            withTitle: CalendarViewMode.month.label,
            action: #selector(CalendarViewController.showMonthView(_:)),
            keyEquivalent: CalendarViewMode.month.shortcut
        )
        monthItem.keyEquivalentModifierMask = [.control, .command]
        viewMenu.addItem(.separator())
        viewMenu.addItem(
            withTitle: String(localized: "Today"),
            action: #selector(CalendarViewController.goToToday(_:)),
            keyEquivalent: "t"
        )
        viewMenu.addItem(
            withTitle: String(localized: "Reload"),
            action: #selector(CalendarViewController.refreshCalendar(_:)),
            keyEquivalent: "r"
        )
        let previousPeriod = viewMenu.addItem(
            withTitle: String(localized: "Previous"),
            action: #selector(CalendarViewController.goToPreviousPeriod(_:)),
            keyEquivalent: "\u{2190}"
        )
        previousPeriod.keyEquivalentModifierMask = [.command]
        let nextPeriod = viewMenu.addItem(
            withTitle: String(localized: "Next"),
            action: #selector(CalendarViewController.goToNextPeriod(_:)),
            keyEquivalent: "\u{2192}"
        )
        nextPeriod.keyEquivalentModifierMask = [.command]
        viewMenu.addItem(.separator())
        // The two sides of whatever window is in front, on one pair of keys:
        // ⌃⌘S for the left, ⌃⌘I for the right, same modifiers, mirrored
        // letters. They used to be ⌃⌘S and ⌃⌥⌘I — two shapes for one idea, so
        // neither was the one you remembered. Both resolve through the
        // responder chain: Calendar and Work answer as the shell, and Meet
        // answers the right one with its meeting rail, which is the right-hand
        // panel of that window. Meet has no left side, so ⌃⌘S dims there.
        let sidebarItem = viewMenu.addItem(
            withTitle: String(localized: "Show Left Sidebar"),
            action: #selector(NSSplitViewController.toggleSidebar(_:)),
            keyEquivalent: "s"
        )
        sidebarItem.keyEquivalentModifierMask = [.control, .command]
        let inspectorItem = viewMenu.addItem(
            withTitle: String(localized: "Show Right Sidebar"),
            action: #selector(NSSplitViewController.toggleInspector(_:)),
            keyEquivalent: "i"
        )
        inspectorItem.keyEquivalentModifierMask = [.control, .command]
        viewMenu.addItem(.separator())
        let fullScreen = viewMenu.addItem(
            withTitle: String(localized: "Enter Full Screen"),
            action: #selector(NSWindow.toggleFullScreen(_:)),
            keyEquivalent: "f"
        )
        fullScreen.keyEquivalentModifierMask = [.control, .command]

        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: String(localized: "Window"))
        windowMenuItem.submenu = windowMenu
        windowMenu.addItem(
            withTitle: String(localized: "Minimize"),
            action: #selector(NSWindow.performMiniaturize(_:)),
            keyEquivalent: "m"
        )
        windowMenu.addItem(
            withTitle: String(localized: "Zoom"),
            action: #selector(NSWindow.performZoom(_:)),
            keyEquivalent: ""
        )
        windowMenu.addItem(.separator())
        // The five destinations are ⌘1 to ⌘5, the same numbering the iOS tab
        // bar uses and the same order the surface switcher draws in every
        // window's toolbar. Calendar's day/week/month, which used to hold these
        // digits, moved to ⌃⌘1/2/3 — a window's contents rank below which
        // window you are in. Titles and digits come from `StarlingsSurface`, so the
        // menu, the switcher and its tooltips cannot disagree.
        for surface in StarlingsSurface.allCases {
            let action: Selector = switch surface {
            case .meet: #selector(AppDelegate.showMeetWindow(_:))
            case .calendar: #selector(AppDelegate.showCalendar(_:))
            case .work: #selector(AppDelegate.showWork(_:))
            case .team: #selector(AppDelegate.showTeam(_:))
            case .docs: #selector(AppDelegate.showDocs(_:))
            }
            windowMenu.addItem(
                withTitle: surface.title,
                action: action,
                keyEquivalent: surface.shortcut
            ).keyEquivalentModifierMask = [.command]
        }
        // Mine is a place inside Work, so it hangs off Work's own digit
        // rather than taking a fourth: ⌘3 is Work, ⌥⌘3 is Work on Mine.
        // Not ⇧⌘3, which belongs to the system screenshot.
        windowMenu.addItem(
            withTitle: String(localized: "Mine"),
            action: #selector(AppDelegate.showWorkMine(_:)),
            keyEquivalent: StarlingsSurface.work.shortcut
        ).keyEquivalentModifierMask = [.command, .option]
        // The document open in the key window's inspector, in a window of
        // its own that floats over every app. Reaches Docs and
        // Work through the responder chain, like the sidebar toggles.
        windowMenu.addItem(.separator())
        windowMenu.addItem(
            withTitle: String(localized: "Float Document"),
            action: #selector(StarlingsShellViewController.floatDocument(_:)),
            keyEquivalent: "f"
        ).keyEquivalentModifierMask = [.command, .shift]
        // Settings deliberately stays in the app menu on ⌘, — the macOS
        // convention — rather than being duplicated here.
        windowMenu.addItem(
            withTitle: String(localized: "Bring All to Front"),
            action: #selector(NSApplication.arrangeInFront(_:)),
            keyEquivalent: ""
        )
        NSApp.windowsMenu = windowMenu

        let helpMenuItem = NSMenuItem()
        mainMenu.addItem(helpMenuItem)
        let helpMenu = NSMenu(title: String(localized: "Help"))
        helpMenuItem.submenu = helpMenu
        // The reference page for the surface in front (docs/DOCUMENTATION.md
        // decision 6). ⌘? is what macOS gives its own Help.
        let meetHelp = helpMenu.addItem(
            withTitle: String(localized: "Starlings Help"),
            action: #selector(AppDelegate.openHelp(_:)),
            keyEquivalent: "?"
        )
        meetHelp.keyEquivalentModifierMask = [.command]
        helpMenu.addItem(
            withTitle: String(localized: "Bug Report"),
            action: #selector(AppDelegate.openBugReport(_:)),
            keyEquivalent: ""
        )
        NSApp.helpMenu = helpMenu

        NSApp.mainMenu = mainMenu
    }

    @MainActor
    private static func attachDeviceSubmenu(
        to meetingMenu: NSMenu,
        title: String,
        kind: MeetingDeviceMenuController.Kind
    ) -> MeetingDeviceMenuController {
        let item = meetingMenu.addItem(withTitle: title, action: nil, keyEquivalent: "")
        let submenu = NSMenu(title: title)
        let controller = MeetingDeviceMenuController(kind: kind)
        submenu.delegate = controller
        item.submenu = submenu
        return controller
    }
}

@MainActor
final class MeetingDeviceMenuController: NSObject, NSMenuDelegate {
    enum Kind {
        case microphone
        case camera
        case speaker
    }

    let kind: Kind

    init(kind: Kind) {
        self.kind = kind
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard let meeting = MeetingMenuTarget.meetingViewController() else {
            menu.removeAllItems()
            let empty = NSMenuItem(title: String(localized: "Home window unavailable"), action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
            return
        }
        meeting.populateMainMenuDeviceSubmenu(menu, kind: kind)
    }
}

/// The app menu's account row: the workspace name, the signed-in address
/// under it. Read when the menu opens, so a sign-in, a sign-out or a renamed
/// workspace shows without rebuilding the menu. Hidden when signed out.
@MainActor
final class AppMenuAccountController: NSObject, NSMenuDelegate {
    private let item: NSMenuItem

    init(item: NSMenuItem) {
        self.item = item
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        item.isHidden = !Self.fill(item)
    }

    /// Writes the workspace name and the signed-in address into `item`.
    /// Returns false when signed out. The menu bar draws the same row.
    @discardableResult
    static func fill(_ item: NSMenuItem) -> Bool {
        let store = StarlingsWorkspaceStore.shared
        guard let address = store.signedInAddress, !address.isEmpty else { return false }
        if #available(macOS 14.4, *) {
            item.title = store.current.name
            item.subtitle = address
        } else {
            item.title = "\(store.current.name) · \(address)"
        }
        return true
    }
}

@MainActor
enum MeetingMenuTarget {
    static func meetingViewController() -> MeetingViewController? {
        if let appDelegate = NSApp.delegate as? AppDelegate {
            return appDelegate.mainWindowController?.meetingViewController
        }
        return nil
    }
}
