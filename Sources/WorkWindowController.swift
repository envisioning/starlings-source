import AppKit
import Combine
import CoreCRMUI
import CoreKit
import DocsKit
import DocsUI
import StarlingsContracts
import SwiftUI

/// Work — the *what*, beside Calendar's *when* and Team's *who*.
///
/// The projects and leads Envisioning is working on, plus the optional Sales
/// section for the lead pipeline, and what you owe on them.
/// One sidebar holds the work lists as foldable sections, the way a chat app
/// holds its channels: nothing is a mode you have to leave to see the rest.
/// Choosing a subject shows the conversation about it and the tasks owed on
/// it; choosing a task or issue from Overview reads it in the inspector so
/// Overview's lists stay in place. Direct Work destinations keep their reader
/// in the middle column.
/// Core still owns what a project *is* — the focused editor writes supported
/// subject fields back through the Worker, never directly to Core.
/// See docs/CHANNELS.md and docs/WORK_SURFACE.md.
extension NSToolbarItem.Identifier {
    static let workSearch = NSToolbarItem.Identifier("meet.work.search")
}

@MainActor
final class WorkWindowController: NSWindowController, NSToolbarDelegate {
    let workViewController: WorkViewController
    private let surfaceSwitcher = StarlingsSurfaceSwitcher(surface: .work)

    init(api: MeetingControlAPI, watch: PeerWatch, work: WorkWatch, core: CoreSession, docs: DocsSession, favorites: StarredWatch, owner: OwnerProfile? = nil) {
        let viewController = WorkViewController(api: api, watch: watch, work: work, core: core, docs: docs, favorites: favorites, owner: owner)
        workViewController = viewController
        let window = NSWindow(contentViewController: viewController)
        window.setContentSize(StarlingsSurface.work.openingContentSize)
        super.init(window: window)
        // Search belongs in the toolbar, unified with the title, the way a Mac
        // keeps it — not stacked above the list it acts on. Work got there
        // first; `StarlingsWindowChrome` is that same dressing, now shared.
        StarlingsWindowChrome.apply(
            to: window,
            surface: .work,
            toolbarIdentifier: "MeetWorkToolbar",
            delegate: self
        )
        shouldCascadeWindows = false
        windowFrameAutosaveName = "MeetWorkWindow"
    }

    /// The shell's bookends — switcher then sidebar toggle leading, inspector
    /// toggle trailing — with Work's own items between them. The scope
    /// picker is gone: the sidebar holds every work list at once, so nothing
    /// of Work's sits in the leading section.
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        StarlingsShellViewController.leadingToolbarItems
            + [.flexibleSpace, .meetNew, .workSearch]
            + StarlingsShellViewController.trailingToolbarItems
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }

    func toolbar(
        _ toolbar: NSToolbar,
        itemForItemIdentifier identifier: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar flag: Bool
    ) -> NSToolbarItem? {
        switch identifier {
        case .meetSurfaces:
            return surfaceSwitcher.item()
        case .meetSurfacesDivider:
            return StarlingsSurfaceSwitcher.dividerItem()
        case .workSearch:
            return StarlingsSearchField.toolbarItem(identifier, field: workViewController.searchField, toolTip: String(localized: "Search subjects, tasks and issues (⌘F). ⌘K searches anything."))
        // One `+`, the way a Mac spells "make something here" — two labelled
        // buttons were 200pt of toolbar for a thing done a few times a week.
        // Both stay in the Work menu.
        case .meetNew:
            let item = NSMenuToolbarItem(itemIdentifier: identifier)
            item.image = NSImage(systemSymbolName: "plus", accessibilityDescription: String(localized: "New"))
            item.label = String(localized: "New")
            item.toolTip = String(localized: "Create a project or a lead, a task, issue or document on the open one, or a quick note")
            item.showsIndicator = true
            let menu = NSMenu()
            menu.addItem(
                withTitle: String(localized: "New Project…"),
                action: #selector(WorkViewController.newProjectPressed),
                keyEquivalent: ""
            ).symbol(.newProject).target = workViewController
            menu.addItem(
                withTitle: String(localized: "New Lead…"),
                action: #selector(WorkViewController.newLeadPressed),
                keyEquivalent: ""
            ).symbol(.startLead).target = workViewController
            menu.addItem(.separator())
            // On the open subject: a task on any subject, an issue on a
            // project with a repository. Overview has no header buttons for
            // these, so the + is where they live.
            menu.addItem(
                withTitle: String(localized: "New Task…"),
                action: #selector(WorkViewController.newTaskPressed),
                keyEquivalent: ""
            ).symbol(.newTask).target = workViewController
            menu.addItem(
                withTitle: String(localized: "New Issue…"),
                action: #selector(WorkViewController.newIssueFromToolbar),
                keyEquivalent: ""
            ).symbol(.newIssue).target = workViewController
            menu.addItem(.separator())
            if StarlingsWorkspace.active.has(.docs) {
                menu.addItem(
                    withTitle: String(localized: "New Document…"),
                    action: #selector(WorkViewController.newDocumentPressed),
                    keyEquivalent: ""
                ).symbol(.newDocument).target = workViewController
            }
            menu.addItem(
                withTitle: String(localized: "New Quick Note…"),
                action: #selector(WorkViewController.newQuickNotePressed),
                keyEquivalent: ""
            ).symbol(.notes).target = workViewController
            item.menu = menu
            return item
        default:
            return nil
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Open on a named subject and pane. The window comes up first so the
    /// subject's lists have somewhere to land.
    func show(relativeTo host: NSWindow? = nil, destination: WorkDestination) {
        show(relativeTo: host)
        workViewController.open(destination)
    }

    func show(relativeTo host: NSWindow? = nil) {
        guard let window else { return }
        if !window.setFrameUsingName(windowFrameAutosaveName), let host {
            var frame = window.frame
            frame.origin = NSPoint(x: host.frame.minX - frame.width - 12, y: host.frame.maxY - frame.height)
            window.setFrame(frame, display: false)
        }
        // A saved frame is a frame from some other day: an earlier build with
        // different minimums, or a display this Mac no longer has. Restore it,
        // then put it back inside the floor, the ceiling, and this screen.
        StarlingsWindowMetrics.refresh(window)
        workViewController.prepareForOpening(in: window)
        showWindow(nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        workViewController.windowDidOpen()
    }
}

/// What the middle column is reading. A subject shows its panes; a direct
/// destination can read one of your own rows on its own because Mine spans
/// every subject and a row in it has no pane to be a tab of.
private enum WorkFocus: Equatable {
    case none
    case subject(CrmSubject)
    case task(CrmMyTask)
    case issue(CrmIssue)
    /// Every open task and issue on every subject, in columns of where each
    /// one is and who is holding it — Overview's other view mode. The
    /// subject pipeline board that used to answer *where is this project* is
    /// gone ( decision 3): a subject's status is a field, edited
    /// from Edit details… and Core. docs/BOARD.md.
    case cards
    /// The service catalog, on Work's rail.
    case catalog
    /// The page behind Browse's foot row, **Other records**: the registry's
    /// tables with no subject door yet (docs/SURFACES.md, #1262).
    case otherRecords
    /// One of those tables, drawn from the registry in the middle column
    /// (docs/CORE_REGISTRY.md).
    case coreEntity(CRMEntityContract)
    /// Registry search across every entity Core publishes to this account.
    case coreSearch
    /// Full-text search across every document.
    case docsSearch
    /// The directory: every subject in the four relationship groups, by
    /// organization, with the status filter and sort ( slice 3b).
    case browse
}

/// The subject's current view. These are mutually exclusive views of the same
/// subject: one row of tabs in the subject header.
private enum WorkPaneSelection: Int, CaseIterable {
    case overview
    case talk
    case tasks
    case issues
    /// A project's tasks and issues by stage (docs/BOARD.md):
    /// the card board, scoped to the project.
    case board
    case interactions
    case fields
    case documents
    /// The partner's own page (PARTNERS (HQ Docs)): what the relationship is,
    /// and the projects, leads and contacts that hang off it.
    case partner
    /// The event's own page (docs/EVENTS.md): when and where, and the
    /// projects that link to it. Drawn by the same view as the partner page.
    case event

    /// The shared pane this segment shows; its order and title are
    /// `SUBJECT_PANES` (Generated/SubjectPanesRegistry.swift).
    var pane: SubjectPane {
        switch self {
        case .overview: .overview
        case .talk: .talk
        case .tasks: .tasks
        case .issues: .issues
        case .board: .board
        case .interactions: .interactions
        case .fields: .fields
        case .documents: .documents
        case .partner: .partner
        case .event: .event
        }
    }

    var title: String { pane.title }

    init(_ pane: SubjectPane) {
        switch pane {
        case .overview: self = .overview
        case .talk: self = .talk
        case .tasks: self = .tasks
        case .issues: self = .issues
        case .board: self = .board
        case .interactions: self = .interactions
        case .fields: self = .fields
        case .documents: self = .documents
        case .partner: self = .partner
        case .event: self = .event
        }
    }
}

@MainActor
final class WorkViewController: StarlingsShellViewController, NSMenuDelegate {
    /// Start the owner's room about the chosen subject. The meeting window
    /// owns the room; this only names what it is about.
    var onMeetAbout: ((CrmSubject) -> Void)?
    /// Work › a project › Keep vault: the app opens Keep on that vault.
    var onOpenKeep: ((CrmSubject) -> Void)?
    /// An INBOX booking row: the app opens Calendar on that event, by the
    /// door a search row spells (`<calendarId>:<eventId>`).
    /// A guest thread on intake, by id and title: Team opens it.
    var onOpenConversation: ((String, String) -> Void)?
    var onOpenCalendarEvent: ((String) -> Void)?
    /// An invitation or an event from email was answered here: the app reads
    /// Home's Upcoming again, so an accepted or added event shows.
    var onCalendarAnswered: (() -> Void)?
    /// A colleague chosen in the subject inspector; the app opens their DM in
    /// Team, where messages are owned.
    var onOpenPeer: ((String) -> Void)?
    var onQuickNoteSaved: ((QuickNote) -> Void)?
    /// Whether a room can start from here right now. Asked at draw time, so
    /// the offer disappears while a meeting is running rather than failing.
    var canMeet: (() -> Bool)?
    /// A star or mute landed on the Worker. Home's QUICK ACCESS list reads the
    /// same table through the Worker, so the app asks it to read again.
    var onSubjectStateChanged: (() -> Void)?

    private let api: MeetingControlAPI
    /// This Mac's standing with Core: token, registry, repository. Owned by
    /// the app, like `work`; this window only draws from it.
    private let core: CoreSession
    private var coreObserver: AnyCancellable?
    /// Core's own screens, hosted: `coreHost` is an entity list or the
    /// search, and holds a `NavigationStack` because the Core views push their
    /// detail themselves. `fieldsHost` is a subject's Fields pane, which reads
    /// the Worker.
    private let coreHost = NSHostingView(rootView: AnyView(EmptyView()))
    private let fieldsHost = NSHostingView(rootView: AnyView(EmptyView()))
    private var fieldsSubjectID: String?
    /// This Mac's standing with Docs: the token and the client. Owned by the
    /// app like `core`; this window only draws from it. `docsHost` is a
    /// subject's Documents pane, kept across pane switches for the same
    /// reason as Fields — the editor holds text between autosaves.
    private let docs: DocsSession
    private let favorites: StarredWatch
    private var docsObserver: AnyCancellable?
    private let docsHost = NSHostingView(rootView: AnyView(EmptyView()))
    private var docsSubjectID: String?
    /// The same poll the launch surface and Team read unread from, so a count
    /// on the Work button and a dot on a row here can never disagree. The
    /// server decides unread; this window only draws it.
    private let watch: PeerWatch
    /// Your own work, as the launch card and the menu bar see it. Every write
    /// here asks it to read again, so Home never lags a tick by a poll.
    private let work: WorkWatch
    /// Subject conversations with something new, newest first. Team owns
    /// direct messages and Everyone; Work only carries subject talk.
    private var unreadThreads: [ThreadSummary] = []
    private var unreadSubjectThreads: [ThreadSummary] {
        unreadThreads.filter(\.kind.isSubjectChannel)
    }
    private var unreadSubjectIDs: Set<String> {
        Set(unreadSubjectThreads.compactMap(\.parentID))
    }
    /// Lives in the toolbar; the controller owns it so typing reaches the list.
    /// `StarlingsSearchField`, the same shell Calendar's search wears: brand fill,
    /// field radius, accent focus ring. Two windows, one search box.
    let searchField = StarlingsSearchField()
    private let statusLine = StarlingsNoticeView()
    /// The one line above the lists, and the two things that can fill it.
    /// Kept apart so a list that loaded does not rub out the reason the other
    /// one is empty.
    private let statusRow = NSStackView()
    /// "Retry" beside a failed refresh. Hidden unless the shown status names
    /// something to run again — a failed write has nothing to retry.
    private let retryButton = NSButton(title: String(localized: "Retry"), target: nil, action: nil)
    private var retryAction: (() -> Void)?
    private struct WorkStatus {
        var text: String
        var tone: StarlingsNoticeView.Tone
        var retry: (() -> Void)?
    }
    private var mineStatus: WorkStatus?
    private var subjectsStatus: WorkStatus?
    /// When each list last came back from the server, or the age of the
    /// snapshot it painted from. Read into the status line when a refresh
    /// fails, so a stale list is never mistaken for a live one.
    private var mineUpdatedAt: Date?
    private var subjectsUpdatedAt: Date?
    private var tasksUpdatedAt: Date?
    private let subjectStack = NSStackView()
    private let subjectScroll = NSScrollView()
    /// The work blocks of the one sidebar, built once and refilled. Fold state
    /// belongs to the section, so rebuilding rows never reopens what somebody
    /// shut.
    /// The rail ( slice 3b): a fixed OVERVIEW row, then SUBJECTS —
    /// a short, automatically ranked wall of active subjects, with the full
    /// directory behind Browse. INBOX (what needs you) and MINE (what you
    /// owe) left the rail on 2026-09-23 and are Overview's two columns.
    /// The four relationship groups live in the Browse view, below.
    private lazy var overviewRow: WorkSidebarRowView = {
        let row = WorkSidebarRowView(
            leading: .glyph(systemSymbolName: "square.grid.2x2.fill", accessibilityLabel: String(localized: "Overview")),
            title: String(localized: "Overview"),
            subtitle: String(localized: "Work, at a glance"),
            accessibilityLabel: String(localized: "Overview"),
            onSelect: { [weak self] in self?.showOverview() }
        )
        row.selectionKey = SidebarKey.overview
        return row
    }()
    /// The service catalog: under Overview while offers answer from this
    /// workspace and the Offers module is on, as on the web.
    private lazy var catalogRow: WorkSidebarRowView = {
        let row = WorkSidebarRowView(
            leading: .glyph(systemSymbolName: "tag", accessibilityLabel: String(localized: "Catalog")),
            title: String(localized: "Catalog"),
            subtitle: String(localized: "Services and prices"),
            accessibilityLabel: String(localized: "Catalog"),
            onSelect: { [weak self] in self?.showCatalog() }
        )
        row.selectionKey = SidebarKey.catalog
        return row
    }()
    private let inboxFilterButton: NSButton = {
        let button = NSButton()
        button.bezelStyle = .inline
        SettingsChrome.applyQuietButton(button)
        button.image = NSImage(systemSymbolName: "line.3.horizontal.decrease", accessibilityDescription: String(localized: "Filter Inbox"))
        button.imagePosition = .imageOnly
        button.contentTintColor = StarlingsColors.secondaryText
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        button.setAccessibilityLabel(String(localized: "Filter Inbox"))
        return button
    }()
    private let mineFilterButton: NSButton = {
        let button = NSButton()
        button.bezelStyle = .inline
        SettingsChrome.applyQuietButton(button)
        button.image = NSImage(systemSymbolName: "line.3.horizontal.decrease", accessibilityDescription: String(localized: "Filter Mine"))
        button.imagePosition = .imageOnly
        button.contentTintColor = StarlingsColors.secondaryText
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        button.setAccessibilityLabel(String(localized: "Filter Mine"))
        return button
    }()
    private var mineFilter = WorkSidebarPreferences.mineFilter()
    /// MINE showing Recently finished in place of open work: a choice in its
    /// Due menu, as on the web — not a list of its own below MINE. This
    /// window only; it opens on open work again.
    private var mineShowsFinished = false
    private let unownedFilterButton: NSButton = {
        let button = NSButton()
        button.bezelStyle = .inline
        SettingsChrome.applyQuietButton(button)
        button.image = NSImage(systemSymbolName: "line.3.horizontal.decrease", accessibilityDescription: String(localized: "Filter Unowned"))
        button.imagePosition = .imageOnly
        button.contentTintColor = StarlingsColors.secondaryText
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        button.setAccessibilityLabel(String(localized: "Filter Unowned"))
        return button
    }()
    private var unownedOrigin = WorkSidebarPreferences.unownedOrigin()
    private var unownedHiddenSubjects = WorkSidebarPreferences.unownedHiddenSubjects()
    private var inboxFilter = WorkSidebarPreferences.inboxFilter()
    private lazy var subjectsSection = SidebarSection(title: String(localized: "SUBJECTS"), key: "work.subjects")
    /// The Browse view's groups, in the middle pane. Envisioning's own
    /// projects — Core's `internal` flag, through `SubjectState.group`.
    private let envisioningSection = WorkViewController.browseSection(.envisioning)
    /// Delivery projects for other organizations. The key stays
    /// `work.projects` for preference continuity.
    private let projectsSection = WorkViewController.browseSection(.clients)
    /// Every CRM organization, read as subjects (ADR 0006), with
    /// Core's list filters behind the header's filter button. Partner is on
    /// by default, so the default view is the partners. The key stays
    /// `work.partners`.
    private lazy var partnersSection = WorkViewController.browseSection(.partners, accessory: organizationFilterButton)
    private let organizationFilterButton: NSButton = {
        let button = NSButton()
        button.bezelStyle = .inline
        SettingsChrome.applyQuietButton(button)
        button.image = NSImage(systemSymbolName: "line.3.horizontal.decrease", accessibilityDescription: String(localized: "Filter Organizations"))
        button.imagePosition = .imageOnly
        button.contentTintColor = StarlingsColors.secondaryText
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        button.setAccessibilityLabel(String(localized: "Filter Organizations"))
        return button
    }()
    /// The Organizations group's filter, per device.
    private var organizationFilter = OrganizationListFilter.saved()
    /// Every industry and country, from the last organization read, for the filter menu.
    private var organizationFacets: CrmSubjectsResponseFacets?
    /// Every CRM contact, after the Organizations group. Its own
    /// search and Core's contact filters sit on the header; the Worker reads
    /// both. Starts folded; the fold is kept under `work.contacts`.
    private lazy var offersSection = SidebarSection(
        title: String(localized: "OFFERS"), key: BrowseRecordGroupRegistry.offers.preferenceKey, startsCollapsed: BrowseRecordGroupRegistry.offers.startsCollapsed
    )
    private lazy var licensesSection = SidebarSection(
        title: String(localized: "LICENSES"), key: BrowseRecordGroupRegistry.licenses.preferenceKey, startsCollapsed: BrowseRecordGroupRegistry.licenses.startsCollapsed
    )
    /// Browse's two record groups (decided by MZ, 2026-11-05). `nil` while their read runs.
    private var browseOffers: [CrmOffer]?
    private var browseLicenses: [CrmLicense]?
    private var browseOffersError: String?
    private var browseLicensesError: String?
    private var offerStatusFilter = WorkSidebarPreferences.filter(
        for: BrowseRecordGroupRegistry.offers.preferenceKey,
        allowed: ["any"] + OfferValues.statuses,
        fallback: "any"
    )
    /// `any`, or a product, each alone or with `:active` or `:ended`.
    private var licenseFilter = WorkSidebarPreferences.filter(
        for: BrowseRecordGroupRegistry.licenses.preferenceKey,
        allowed: BrowseLicenseFilter.options.map(\.id),
        fallback: "any"
    )
    private lazy var contactsSection = SidebarSection(
        title: String(localized: "CONTACTS"), key: "work.contacts", accessory: contactsAccessory, startsCollapsed: true
    )
    private let contactSearchField = StarlingsSearchField(placeholder: String(localized: "Search"))
    private let contactCountLabel: NSTextField = {
        let label = NSTextField(labelWithString: "")
        label.font = StarlingsTypography.sectionLabelFont
        label.textColor = StarlingsColors.secondaryText
        label.setContentHuggingPriority(.required, for: .horizontal)
        label.setContentCompressionResistancePriority(.required, for: .horizontal)
        return label
    }()
    private let contactFilterButton: NSButton = {
        let button = NSButton()
        button.bezelStyle = .inline
        SettingsChrome.applyQuietButton(button)
        button.image = NSImage(systemSymbolName: "line.3.horizontal.decrease", accessibilityDescription: String(localized: "Filter Contacts"))
        button.imagePosition = .imageOnly
        button.contentTintColor = StarlingsColors.secondaryText
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        button.setAccessibilityLabel(String(localized: "Filter Contacts"))
        return button
    }()
    /// The search, the count and the filter button, on the CONTACTS header.
    private lazy var contactsAccessory: NSView = {
        contactSearchField.setAccessibilityLabel(String(localized: "Search Contacts"))
        let width = contactSearchField.widthAnchor.constraint(equalToConstant: StarlingsSearchField.toolbarWidth)
        width.priority = .defaultLow
        width.isActive = true
        contactSearchField.widthAnchor.constraint(greaterThanOrEqualToConstant: 80).isActive = true
        let row = NSStackView(views: [contactSearchField, contactCountLabel, contactFilterButton])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        return row
    }()
    /// The Contacts group's filter, per device.
    private var contactFilter = ContactListFilter.saved()
    /// Every country and language, from the last contact read, for the filter menu.
    private var contactFacets: CrmContactsResponseFacets?
    private var contactQuery = ""
    /// The last page the group read. Nil until the first read lands.
    private var contactPage: CrmContactsResponse?
    private var contactError: Error?
    private var contactLoad: Task<Void, Never>?
    /// CMS events as subjects (docs/EVENTS.md): upcoming and live,
    /// by date. Read-only as a record; Talk and Tasks are its own.
    private let eventsSection = WorkViewController.browseSection(.events)
    /// The lead pipeline, on Browse only for people with Sales on
    /// (`subjectState.salesEnabled`). The key stays `work.leads`.
    private let salesSection = WorkViewController.browseSection(.sales)

    /// One Browse group: its saved key and whether it starts folded come from the shared
    /// table (`BrowseGroupRegistry`, packages/contracts/src/browse-groups.ts).
    private static func browseSection(_ group: SubjectGroup, accessory: NSView? = nil) -> SidebarSection {
        let spec = BrowseGroupRegistry.spec(for: group)
        return SidebarSection(title: group.title, key: spec.preferenceKey, accessory: accessory, startsCollapsed: spec.startsCollapsed)
    }

    /// Browse: the four groups stacked in the middle pane, scrolling as one.
    private let browseStack = NSStackView()
    private let browseScroll = NSScrollView()
    /// The foot of Browse: the registry's tables with no subject door yet
    /// (#1262). Only where the workspace has them.
    private lazy var otherRecordsRow = WorkSidebarRowView(
        leading: .glyph(systemSymbolName: "square.grid.2x2", accessibilityLabel: String(localized: "Other records")),
        title: String(localized: "Other records"),
        subtitle: "",
        accessibilityLabel: String(localized: "Other records"),
        onSelect: { [weak self] in self?.showOtherRecords() }
    )
    /// Not a zone and not in the catalog: the tail that appears under the
    /// rail while something is typed, offering the same words to Core and
    /// Docs. It is how those two are reached from here now that their blocks
    /// are gone ( decision 6).
    private let searchSection = SidebarSection(
        title: String(localized: "SEARCH"), key: "work.search", hidesWhenEmpty: true
    )
    private lazy var partnerPane: WorkPartnerDetailView = {
        let pane = WorkPartnerDetailView()
        pane.isHidden = true
        pane.onOpenSubject = { [weak self] subject in self?.select(subject) }
        pane.onOpenContact = { [weak self] id, name in self?.openContact(id: id, name: name) }
        pane.onAddContact = { [weak self] organization in self?.addContact(to: organization) }
        pane.onEdit = { [weak self] organization, detail in self?.editOrganization(organization, detail: detail) }
        pane.onMerge = { [weak self] organization in self?.mergeOrganization(organization) }
        pane.onDelete = { [weak self] organization in self?.confirmDeleteOrganization(organization) }
        return pane
    }()
    private lazy var threadPane = ThreadPaneView(api: api)
    private lazy var subjectOverview = WorkSubjectOverviewView(api: api, docs: docs, favorites: favorites)
    private let tasksControls = MeetingTasksControls()
    private let tasksHeader = NSTextField(labelWithString: String(localized: "TASKS"))
    /// Tasks use the same compact filter row as issues. Unlike GitHub's list,
    /// the subject task endpoint is complete, so this stays local and never
    /// interrupts editing with a reload.
    private let tasksFilterBar = WorkTaskFilterBar()
    private var taskFilter = CrmTaskFilter()
    private var loadedTasks: [CrmTask] = []
    /// The rule under the subject view controls.
    private let tabsDivider = NSBox()
    private var paneSwitcherHeightConstraint: NSLayoutConstraint?
    private var tabsDividerHeightConstraint: NSLayoutConstraint?
    /// Was 36 (the control's own height, no room to breathe). The stack view
    /// centers the control vertically, so this margin lands above and below
    /// it evenly.
    private static let paneSwitcherHeight: CGFloat = 44
    /// The subject's tabs, from `SubjectPane.layout`. Overview
    /// is where a subject lands; "Show all" and a direct destination pick
    /// the others.
    private let paneSwitcher = NSStackView()
    private let paneControl = StarlingsSegmentedControl(labels: [])
    /// The panes the tabs stand for, in the order drawn.
    private var shownPanes: [WorkPaneSelection] = []
    private var selectedPane: WorkPaneSelection = .overview
    private lazy var interactionsView = WorkInteractionsView(api: api)
    private let interactionsHeader = NSTextField(labelWithString: String(localized: "HISTORY"))
    private let unlinkedLabel = NSTextField(
        labelWithString: String(localized: "No repository is linked to this project.")
    )
    /// With nothing chosen the column was a plain rect. A faint, centered mark
    /// says whose app this is without competing with whatever gets picked next.
    /// The Starlings flock, breathing, where nothing is open. Reduce Motion stills it.
    private let emptyGlyph = NSHostingView(rootView: GatheringDotsView(side: 64, ink: Color(nsColor: StarlingsColors.secondaryText)))
    /// The card board: tasks and issues, dealt into stage columns by the
    /// shared `WorkItems.board`. A project's Board pane is its door
    ///. The company-wide board has none: `showCards()`
    /// is its one way in, and nothing calls it.
    private let cardBoard = WorkCardBoardView()
    /// Work's home: what the column shows with nothing chosen.
    private let overview = WorkOverviewView()
    private var cardsTask: Task<Void, Never>?
    /// The project the board's cards were read for; nil for every subject.
    private var cardBoardProjectID: String?
    /// The board reads itself again while it is up, at this cadence: an
    /// agent's move mid-run has to show without the board being reopened.
    private static let cardsRefreshInterval: Duration = .seconds(30)
    private var isLinkedToGitHub = false
    private var tasksTitleRow = NSStackView()
    private let issuesHeader = NSTextField(labelWithString: String(localized: "GITHUB"))
    private let newIssueButton = NSButton(title: String(localized: "New Issue"), target: nil, action: nil)
    private let addRepoButton = NSButton(title: String(localized: "Add repository"), target: nil, action: nil)
    private let issuesStack = NSStackView()
    private let issuesScroll = NSScrollView()
    /// GitHub's own filters over the subject's issues. Everything but the
    /// search field asks the server again, because a repository can hold more
    /// issues than one page and narrowing a page would hide the rest.
    private let issuesFilterBar = WorkIssueFilterBar()
    private var issueFilter = CrmIssueFilter()
    /// The third column: the one task or issue chosen from a subject's panes,
    /// read and answered beside them. Collapsed until something is chosen; the
    /// toolbar toggle puts it away and brings it back.
    private lazy var inspector = WorkInspectorViewController(api: api)
    /// The same reading view, used as the middle column's content when what
    /// was chosen came from the sidebar rather than from a subject's pane.
    /// One renderer, so a task reads the same wherever it was clicked.
    private lazy var itemDetail = WorkInspectorViewController(api: api, ground: StarlingsColors.canvas)
    /// The issue row that owns the inspector, so the list can mark it.
    private var inspectedIssueID: String?
    /// The subject's open issues, kept so the list can redraw its selection
    /// without asking GitHub again.
    private var issues: [CrmIssue] = []
    /// A linked repository had more than one page. The list is a prefix of the
    /// truth, the rung above it says so, and the row at the foot asks for the
    /// rest.
    private var issuesHaveMore = false
    /// The last page asked for. Reset by anything that changes the question.
    private var issuePage = 1
    /// A page is on its way. The row at the foot says so rather than looking
    /// like a button that did nothing.
    private var issuesLoadingMore = false
    /// Fed by `WorkInteractionsView.onCountChange`, so the tab bar's badge
    /// can read a count that view keeps privately.
    private var interactionsCount = 0
    /// Documents is built lazily (only once its pane is chosen), unlike
    /// Tasks/Issues/Interactions — so the badge needs its own cheap fetch,
    /// asked for as soon as a subject is selected rather than waiting on that.
    private var documentsCount = 0
    private var documentsCountTask: Task<Void, Never>?
    /// Exact project links, loaded only for the project being viewed. The
    /// subject list still uses `has_repo` for its cheap at-a-glance marker.
    private var projectRepos: [CrmGithubRepo] = []

    /// Presence is separate from the CRM assignee ledger below. The Team menu
    /// needs room reachability; task editing needs the Core team list.
    private var roster: PeerRoster = .empty

    /// Envisioning's own projects and client projects, split by
    /// `SubjectState.group` after each half is fetched — Core's list has no
    /// filter for the flag yet, so both halves fetch and keep their own.
    private var envisioningProjects: [CrmSubject] = []
    private var clientProjects: [CrmSubject] = []
    private var leads: [CrmSubject] = []
    private var partners: [CrmSubject] = []
    private var events: [CrmSubject] = []
    private var partnerDetailTask: Task<Void, Never>?
    private var subjectDetailTask: Task<Void, Never>?
    /// Full subject facts used by the Overview inspector. The list summary is
    /// enough to paint the rail, but not enough for the concise metadata panel.
    private var subjectDetails: [String: CrmSubjectDetail] = [:]
    /// The status each subject list opens on. Shipped defaults until the
    /// owner picks another; after that the choice is the default, because a
    /// filter you set every single launch is a preference you already stated.
    private var envisioningStatusFilter = WorkSidebarPreferences.filter(
        for: "work.envisioning",
        allowed: CrmSubjectStatusOption.project.map(\.id),
        fallback: SubjectStatusRegistry.project.defaultFilter
    )
    private var clientStatusFilter = WorkSidebarPreferences.filter(
        for: "work.projects",
        allowed: CrmSubjectStatusOption.project.map(\.id),
        fallback: SubjectStatusRegistry.project.defaultFilter
    )
    private var leadStatusFilter = WorkSidebarPreferences.filter(
        for: "work.leads",
        allowed: CrmSubjectStatusOption.leadFilter.map(\.id),
        fallback: SubjectStatusRegistry.lead.defaultFilter
    )
    /// The sort each project-ish list opens on. Team and Agents have none —
    /// their order comes from the server (present-first-then-alphabetical).
    private var envisioningSortOption = WorkSidebarPreferences.sort(
        for: "work.envisioning",
        allowed: CrmSubjectSortOption.all.map(\.id),
        fallback: CrmSubjectSortOption.busiest.id
    )
    private var clientSortOption = WorkSidebarPreferences.sort(
        for: "work.projects",
        allowed: CrmSubjectSortOption.all.map(\.id),
        fallback: CrmSubjectSortOption.busiest.id
    )
    private var leadSortOption = WorkSidebarPreferences.sort(
        for: "work.leads",
        allowed: CrmSubjectSortOption.all.map(\.id),
        fallback: CrmSubjectSortOption.busiest.id
    )
    /// The rail's blocks, top to bottom, as the owner has arranged them.
    private var sidebarOrder = WorkSidebarPreferences.order()
    private var focus: WorkFocus = .none
    /// The subject whose panes are loaded. Nil whenever the middle column is
    /// reading one of your own rows instead.
    private var selected: CrmSubject?
    /// The search in flight. Cancelled by the next keystroke, or a slow early
    /// request lands after a fast later one and puts a stale list on screen.
    private var searchTask: Task<Void, Never>?
    /// The board's fan-out: one request per column. Cancelled by anything that
    /// changes the question, exactly like the sidebar's own search.
    private var statusCountTask: Task<Void, Never>?
    private var statusCountsQuery: String?
    private var mineTask: Task<Void, Never>?
    private var recentlyClosedTask: Task<Void, Never>?
    private var unownedTask: Task<Void, Never>?
    private var taskTask: Task<Void, Never>?
    /// An organization's Tasks By project: this device's choice,
    /// and the groups read for the organization on screen.
    private var tasksByProject = UserDefaults.standard.bool(forKey: CrmOrganizationProjectTaskGroups.byProjectDefaultsKey)
    private var organizationGroups: CrmOrganizationProjectTaskGroups?
    private var organizationGroupsID: String?
    private var organizationGroupsTask: Task<Void, Never>?
    private lazy var byProjectButton: NSButton = {
        let button = NSButton(title: String(localized: "By project"), target: self, action: #selector(byProjectPressed))
        button.bezelStyle = .inline
        button.controlSize = .small
        SettingsChrome.applyQuietButton(button)
        button.setButtonType(.pushOnPushOff)
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.isHidden = true
        return button
    }()
    private var issueTask: Task<Void, Never>?
    private var repoTask: Task<Void, Never>?
    private var detailTask: Task<Void, Never>?
    /// Who work can go to, from Core. Read once with the window — the roster
    /// changes far less often than the tasks do.
    private var team: [CrmTeamMember] = []

    private var mine: [CrmMyTask] = []
    private var myIssues: [CrmIssue] = []
    private var recentlyClosed: [CrmRecentlyClosedItem] = []
    private var recentlyClosedError: String?
    /// Overview's UNOWNED (docs/BOARD.md §Unowned): open work nobody on our
    /// side holds. Nil until the first answer.
    private var unowned: CrmUnownedWorkResponse?
    private var unownedError: String?
    private var inboxTask: Task<Void, Never>?
    private var inbox: WorkInboxResponse = .empty
    /// Overview's TODAY block: today's meetings filed to a subject.
    private var todayMeetingsTask: Task<Void, Never>?
    private var todayMeetings: [WorkTodayMeetings.Row] = []
    /// The RECENT tail is folded by default: it never resolves, so it must
    /// not sit among the things that do.
    /// This person's follow / star / mute and SALES opt-in (
    /// decision 5). `.unknown` until the Worker answers, and a rail drawn
    /// from `.unknown` hides nothing — see `resolvedState(for:)`.
    private var subjectState: SubjectStateResponse = .unknown
    private var subjectStateTask: Task<Void, Never>?
    /// Overrides by `SubjectState.key`, the same rows as
    /// `subjectState.states` but addressable, and updated in place the moment
    /// a menu item is chosen so the rail never waits on the round trip.
    private var subjectOverrides: [String: SubjectStateOverride] = [:]
    /// The subjects opened this session, oldest first, and where in that
    /// list the window is. Hopping is the normal way Work is used, so ⌘[
    /// and ⌘] walk it like a browser. `isTravelling` keeps a walk from
    /// recording itself as a new hop.
    private var subjectHistory: [CrmSubject] = []
    private var historyCursor = -1
    private var isTravelling = false
    private var githubLogin: String?
    /// Mine is always the signed-in member's work, so its rows can use the
    /// same identity marker as chat and the fixed profile shelf.
    private let ownerIdentity: StarlingsAvatarIdentity
    /// Ticked here, before Core has answered. The row must not wait on the
    /// round trip to show the tick, and a reload would drop a just-completed
    /// task out of the list before the owner could take it back.
    private var locallyDoneMineIDs: Set<String> = []
    /// One of your rows, named from outside before Mine had loaded — a task
    /// on Home tapped on a cold window. Applied by the next render and
    /// cleared, so it can never re-open a row somebody has since left.
    private var pendingMineTaskID: String?

    /// What is being typed in the toolbar, trimmed. While it is not empty
    /// every section draws open: a match hidden inside a folded block is the
    /// same as no match at all.
    private var query: String {
        searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The subject a room would be about: the one that is open, or the one
    /// the task being read belongs to.
    private var meetSubject: CrmSubject? {
        switch focus {
        case .subject(let subject): subject
        case .task(let task): task.subject
        case .issue, .none, .cards, .catalog, .otherRecords, .coreEntity, .coreSearch, .docsSearch, .browse: nil
        }
    }

    init(api: MeetingControlAPI, watch: PeerWatch, work: WorkWatch, core: CoreSession, docs: DocsSession, favorites: StarredWatch, owner: OwnerProfile? = nil) {
        self.api = api
        self.core = core
        self.docs = docs
        self.favorites = favorites
        self.watch = watch
        self.work = work
        tasksControls.favorites = favorites
        ownerIdentity = StarlingsAvatarIdentity(
            displayName: owner?.name ?? String(localized: "You"),
            email: owner?.email
        )
        super.init(nibName: nil, bundle: nil)
        // Connected, registry loaded, an error — the block redraws on any of
        // them. `objectWillChange` fires ahead of the change, so the redraw is
        // hopped one turn to read the state after it.
        coreObserver = core.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                Task { @MainActor in self?.coreStateDidChange() }
            }
        docsObserver = docs.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                Task { @MainActor in self?.docsStateDidChange() }
            }
        inspector.docsSession = docs
        inspector.coreSession = core
        envisioningSection.setFilter(
            options: CrmSubjectStatusOption.project,
            selectedID: envisioningStatusFilter
        ) { [weak self] value in
            self?.envisioningStatusFilterChanged(value)
        }
        projectsSection.setFilter(
            options: CrmSubjectStatusOption.project,
            selectedID: clientStatusFilter
        ) { [weak self] value in
            self?.clientStatusFilterChanged(value)
        }
        salesSection.setFilter(
            options: CrmSubjectStatusOption.leadFilter,
            selectedID: leadStatusFilter
        ) { [weak self] value in
            self?.leadStatusFilterChanged(value)
        }
        // Busiest-first-or-alphabetical, beside the status filter.
        envisioningSection.setSort(
            options: CrmSubjectSortOption.all,
            selectedID: envisioningSortOption
        ) { [weak self] value in
            self?.envisioningSortChanged(value)
        }
        projectsSection.setSort(
            options: CrmSubjectSortOption.all,
            selectedID: clientSortOption
        ) { [weak self] value in
            self?.clientSortChanged(value)
        }
        salesSection.setSort(
            options: CrmSubjectSortOption.all,
            selectedID: leadSortOption
        ) { [weak self] value in
            self?.leadSortChanged(value)
        }
        watch.observe { [weak self] roster in
            guard let self else { return }
            self.roster = roster
            guard isViewLoaded, view.window != nil else { return }
            // Work cards can be handed to an agent, and subject Talk completes
            // mentions from the same app-wide roster. Team owns the roster UI.
            threadPane.setMentionable(roster.peers)
            // A subject's task rows hand off to the same agents as its Board.
            subjectOverview.agents = roster.agents
            tasksControls.agents = roster.agents
            // The subject card's TEAM reads presence; redraw it only when
            // who is there, or how they are, actually moved.
            if let subject = infoSubject, subject.id == selected?.id,
               ConversationTeam.subject(subject, roster: roster, tasks: tasks(of: subject)) != infoTeam {
                showSubjectInfo(subject)
            }
        }
        watch.observeUnread { [weak self] threads in
            guard let self else { return }
            guard threads != unreadThreads else { return }
            unreadThreads = threads
            // A window nobody has open does not need redrawing on every poll;
            // `windowDidOpen()` repaints from whatever arrived while it was shut.
            guard isViewLoaded, view.window != nil else { return }
            renderSidebar()
            // Something was read or arrived: INBOX's talk rows are the same
            // fact, read from the Worker, so ask it again rather than wait.
            loadInbox()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// One sidebar of work lists, then the thing that was chosen, then the
    /// inspector: the shell's three columns. Search lives in the toolbar and
    /// narrows every work list at once.
    /// The subject list, so the window opens on what it is for. It used to
    /// open with the caret in the search box, which meant the first thing
    /// typed at a freshly opened Work went into a search nobody asked for —
    /// the same thing Calendar stopped doing. Search is opt-in in both, and
    /// ⌘F is the way in. See `StarlingsShellViewController`.
    override var openingFirstResponder: NSView? { subjectScroll }
    override var surfaceSearchField: NSSearchField? { searchField }
    override var documentInspector: WorkInspectorViewController? { inspector }

    override func viewDidLoad() {
        super.viewDidLoad()

        searchField.configure(
            placeholder: String(localized: "Search"),
            target: self,
            action: #selector(searchChanged)
        )
        // The session ended under us. Reading again turns a list that belonged
        // to it into the honest reason the window is empty.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(ownerSessionDidExpire),
            name: OwnerSessionStore.didExpireNotification,
            object: nil
        )
        // Settings > Work rearranged the rail, or turned Sales on or off.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(sidebarPreferencesDidChange),
            name: WorkSidebarPreferences.didChangeNotification,
            object: nil
        )

        statusLine.hidesWhenEmpty = false
        statusLine.label.allowSqueezing()
        statusLine.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        // Indented to the rows' own text rather than to the rail's edge. The
        // inset lives on a wrapper: a stack aligns its arranged views itself,
        // and a second leading constraint would fight it.
        statusRow.orientation = .horizontal
        statusRow.edgeInsets = NSEdgeInsets(top: 0, left: 10, bottom: 0, right: 10)
        statusRow.addArrangedSubview(statusLine)
        retryButton.bezelStyle = .inline
        retryButton.isBordered = false
        retryButton.font = .systemFont(ofSize: StarlingsTypography.scaled(10), weight: .medium)
        retryButton.contentTintColor = StarlingsColors.secondaryText
        retryButton.setAccessibilityLabel(String(localized: "Retry loading"))
        retryButton.target = self
        retryButton.action = #selector(retryStatus)
        retryButton.setContentHuggingPriority(.required, for: .horizontal)
        retryButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        SettingsChrome.applyQuietButton(retryButton)
        retryButton.isHidden = true
        statusRow.addArrangedSubview(retryButton)
        statusRow.isHidden = true

        // Another screen wrote — a task completed from a subject pane, a lead
        // renamed on the board — and the API layer said which lists that
        // made stale. Re-read those rather than wait for the next open.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(snapshotsDidInvalidate(_:)),
            name: SnapshotStore.didInvalidateNotification,
            object: nil
        )

        subjectStack.orientation = .vertical
        subjectStack.alignment = .leading
        subjectStack.spacing = 14
        subjectStack.translatesAutoresizingMaskIntoConstraints = false
        inboxFilterButton.target = self
        inboxFilterButton.action = #selector(showInboxFilterMenu(_:))
        organizationFilterButton.target = self
        organizationFilterButton.action = #selector(showOrganizationFilterMenu(_:))
        organizationFilterButton.contentTintColor = organizationFilter.isDefault ? StarlingsColors.secondaryText : StarlingsColors.accent
        contactFilterButton.target = self
        contactFilterButton.action = #selector(showContactFilterMenu(_:))
        contactFilterButton.contentTintColor = contactFilter.isDefault ? StarlingsColors.secondaryText : StarlingsColors.accent
        contactSearchField.configure(placeholder: String(localized: "Search"), target: self, action: #selector(contactSearchChanged))
        mineFilterButton.target = self
        mineFilterButton.action = #selector(showMineFilterMenu(_:))
        unownedFilterButton.target = self
        unownedFilterButton.action = #selector(showUnownedFilterMenu(_:))
        for section in allSections {
            section.translatesAutoresizingMaskIntoConstraints = false
            // Folding changes the rail's height, and a scroll view that was at
            // the bottom of the old one has to be told.
            section.onFoldChange = { [weak self] in
                guard let self else { return }
                subjectScroll.reflectScrolledClipView(subjectScroll.contentView)
            }
            section.contextMenuProvider = { [weak self, weak section] in
                self?.sidebarMenu(for: section?.sectionKey)
            }
        }
        // The rail's own menu, for the gap between sections — where there is
        // no header to right-click but somebody wanting a hidden section back
        // still looks. Filled by the delegate at open time, like the headers'.
        let railMenu = NSMenu()
        railMenu.delegate = self
        subjectStack.menu = railMenu
        applySidebarLayout()

        // Browse: the four groups as one scrolling column in the middle pane.
        // Same section views the rail used to hold, so their filters, sorts,
        // folds and board buttons carry over untouched.
        browseStack.orientation = .vertical
        browseStack.alignment = .leading
        browseStack.spacing = 14
        browseStack.edgeInsets = NSEdgeInsets(top: 12, left: 10, bottom: 20, right: 10)
        browseStack.translatesAutoresizingMaskIntoConstraints = false
        for section in browseSections {
            section.translatesAutoresizingMaskIntoConstraints = false
            section.onFoldChange = { [weak self] in
                guard let self else { return }
                browseScroll.reflectScrolledClipView(browseScroll.contentView)
            }
            browseStack.addArrangedSubview(section)
            section.widthAnchor.constraint(equalTo: browseStack.widthAnchor, constant: -20).isActive = true
        }
        otherRecordsRow.isHidden = !core.isAvailable
        otherRecordsRow.translatesAutoresizingMaskIntoConstraints = false
        browseStack.addArrangedSubview(otherRecordsRow)
        otherRecordsRow.widthAnchor.constraint(equalTo: browseStack.widthAnchor, constant: -20).isActive = true
        browseScroll.drawsBackground = false
        browseScroll.hasVerticalScroller = true
        browseScroll.borderType = .noBorder
        let browseClip = WorkFlippedClipView()
        browseClip.drawsBackground = false
        browseScroll.contentView = browseClip
        browseScroll.documentView = browseStack
        browseScroll.isHidden = true
        browseStack.widthAnchor.constraint(equalTo: browseScroll.contentView.widthAnchor).isActive = true

        subjectScroll.drawsBackground = false
        subjectScroll.hasVerticalScroller = true
        subjectScroll.borderType = .noBorder
        let clip = WorkFlippedClipView()
        clip.drawsBackground = false
        subjectScroll.contentView = clip
        subjectScroll.documentView = subjectStack
        subjectScroll.translatesAutoresizingMaskIntoConstraints = false

        // Sidebar content only: the shell supplies the panel surface and the insets.
        let sidebarColumn = NSStackView(views: [statusRow, subjectScroll])
        sidebarColumn.orientation = .vertical
        sidebarColumn.alignment = .leading
        sidebarColumn.spacing = 6
        NSLayoutConstraint.activate([
            statusRow.widthAnchor.constraint(equalTo: sidebarColumn.widthAnchor),
            subjectScroll.widthAnchor.constraint(equalTo: sidebarColumn.widthAnchor),
            subjectStack.widthAnchor.constraint(equalTo: subjectScroll.contentView.widthAnchor),
        ])

        // Detail: the subject's view controls, then its pane — or, when what
        // was chosen is one of your own rows, that row read in full.
        let detail = NSView()
        detail.wantsLayer = true
        detail.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.canvas, for: detail).cgColor

        tasksHeader.font = StarlingsTypography.sectionLabelFont
        tasksHeader.textColor = StarlingsColors.secondaryText

        interactionsHeader.font = StarlingsTypography.sectionLabelFont
        interactionsHeader.textColor = StarlingsColors.secondaryText

        paneControl.target = self
        paneControl.action = #selector(paneControlChanged)
        paneControl.setAccessibilityLabel(String(localized: "Work views"))

        paneControl.translatesAutoresizingMaskIntoConstraints = false
        paneSwitcher.addSubview(paneControl)
        NSLayoutConstraint.activate([
            paneControl.leadingAnchor.constraint(equalTo: paneSwitcher.leadingAnchor, constant: 20),
            paneControl.trailingAnchor.constraint(lessThanOrEqualTo: paneSwitcher.trailingAnchor, constant: -20),
            paneControl.centerYAnchor.constraint(equalTo: paneSwitcher.centerYAnchor),
        ])
        syncPaneControl()

        unlinkedLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        unlinkedLabel.textColor = StarlingsColors.secondaryText
        unlinkedLabel.isHidden = true

        issuesHeader.font = StarlingsTypography.sectionLabelFont
        issuesHeader.textColor = StarlingsColors.secondaryText
        issuesHeader.isHidden = true

        newIssueButton.bezelStyle = .inline
        newIssueButton.controlSize = .small
        SettingsChrome.applyQuietButton(newIssueButton)
        newIssueButton.target = self
        newIssueButton.action = #selector(newIssuePressed)
        newIssueButton.isHidden = true

        addRepoButton.bezelStyle = .inline
        addRepoButton.controlSize = .small
        SettingsChrome.applyQuietButton(addRepoButton)
        addRepoButton.target = self
        addRepoButton.action = #selector(addRepoPressed)
        addRepoButton.isHidden = true

        issuesStack.orientation = .vertical
        issuesStack.alignment = .leading
        issuesStack.spacing = 6
        issuesStack.translatesAutoresizingMaskIntoConstraints = false

        issuesFilterBar.isHidden = true
        issuesFilterBar.onChange = { [weak self] filter in
            guard let self else { return }
            // Only a change the server cares about is worth a round trip;
            // typing in the search field narrows what is already in hand.
            let asksAgain = filter.asksServerDifferently(from: issueFilter)
            issueFilter = filter
            if asksAgain { loadIssues() } else { renderIssues() }
        }

        tasksFilterBar.isHidden = true
        tasksFilterBar.onChange = { [weak self] filter in
            guard let self else { return }
            taskFilter = filter
            renderTasks()
        }

        interactionsView.onSelect = { [weak self] interaction in
            self?.inspect(.interaction(interaction))
        }
        interactionsView.onCountChange = { [weak self] count in
            guard let self else { return }
            interactionsCount = count
            applyPane()
        }

        issuesScroll.drawsBackground = false
        issuesScroll.hasVerticalScroller = true
        issuesScroll.borderType = .noBorder
        let issuesClip = WorkFlippedClipView()
        issuesClip.drawsBackground = false
        issuesScroll.contentView = issuesClip
        issuesScroll.documentView = issuesStack
        issuesScroll.isHidden = true

        tasksControls.onNewTask = { [weak self] in
            guard let self else { return }
            composeTask(nil, subject: selected)
        }
        // Clicking a task reads it in the inspector; editing is a button there.
        // The live meeting's rail keeps its straight-to-editor click — a call
        // has no third column.
        tasksControls.onEditTask = { [weak self] task in self?.inspectTask(task) }
        tasksControls.onTaskAction = { [weak self] action in self?.performRowAction(action) }
        // The tick box draws itself on the row whether or not anybody listens
        // to it. Without this it struck a task through here and told Core
        // nothing — the one write on the screen that only looked like one.
        // A Core-proposed task is answered where it is read: accept
        // puts it on the plate as pending, decline keeps the row as declined
        // so the same event cannot propose it again. Both re-read Mine — an
        // accepted proposal may be yours.
        tasksControls.onDecideProposal = { [weak self] task, accepted in
            self?.decideProposal(task, accepted: accepted)
        }
        tasksControls.onToggleTaskDone = { [weak self] task, done in self?.setTaskDone(task, done: done) }
        tasksControls.setUnavailable(String(localized: "Pick a project or lead."))

        tasksControls.onOpenProject = { [weak self] project in self?.select(project, pane: .tasks) }
        tasksTitleRow = NSStackView(views: [tasksHeader, NSView(), byProjectButton, tasksControls.newTaskButton])
        tasksTitleRow.orientation = .horizontal
        tasksTitleRow.distribution = .fill

        tabsDivider.boxType = .separator

        let detailPane = StarlingsShellPaneViewController(view: detail)
        detailPane.addChild(itemDetail)
        itemDetail.view.isHidden = true

        overview.isHidden = true
        overview.onBrowse = { [weak self] in self?.showBrowse() }
        overview.setFilterButtons(inbox: inboxFilterButton, mine: mineFilterButton, unowned: unownedFilterButton)
        cardBoard.isHidden = true
        cardBoard.onSelect = { [weak self] card in self?.inspectCard(card) }
        cardBoard.onMove = { [weak self] card, stage in self?.moveCard(card, to: stage) }
        cardBoard.onRetry = { [weak self] in self?.loadCards() }
        cardBoard.onOpenTrace = { [weak self] card in self?.openTrace(of: card) }
        cardBoard.onHandOff = { [weak self] card, agent in self?.handOff(card, to: agent) }
        cardBoard.onOpenSubject = { [weak self] subject in self?.select(subject) }
        cardBoard.onHiddenStagesChange = { [weak self] stages in self?.setBoardHiddenStages(stages) }
        cardBoard.onDeleteTask = { [weak self] card in
            guard let task = card.task else { return }
            self?.performRowAction(.deleteTask(id: task.id, title: task.title))
        }
        // A ref in a transcript is a door into the card: the one the message
        // was sent from, or the one an event line is about.
        threadPane.onOpenRef = { [weak self] ref in self?.openRef(ref) }
        threadPane.onThreadLoaded = { [weak self] summary in self?.noteInboundAddress(summary) }
        threadPane.onRosterWanted = { [weak self] in self?.watch.refreshNow() }
        threadPane.onQuickNoteSaved = { [weak self] note in self?.onQuickNoteSaved?(note) }

        subjectOverview.setTalkView(threadPane)
        subjectOverview.onOpenTask = { [weak self] task in
            self?.inspect(.task(task, canFile: self?.canFile(task) ?? false, subject: self?.selected))
        }
        subjectOverview.onOpenIssue = { [weak self] issue in self?.openIssue(issue) }
        subjectOverview.onRowAction = { [weak self] action in self?.performRowAction(action) }
        subjectOverview.onOpenInteraction = { [weak self] interaction in self?.inspect(.interaction(interaction)) }
        subjectOverview.onOpenDocument = { [weak self] id, title in self?.openDocument(id: id, title: title) }
        subjectOverview.onOpenSubject = { [weak self] subject in self?.select(subject, pane: .overview) }
        subjectOverview.onOpenContact = { [weak self] id, name in self?.openContact(id: id, name: name) }
        subjectOverview.onNew = { [weak self] group in
            guard let self, let subject = selected else { return }
            switch group {
            case .goals: composeGoal(subject: subject)
            case .decisions: composeDecision(subject: subject)
            case .tasks: composeTask(nil, subject: subject)
            case .issues: inspect(.newIssue(subject))
            case .offers: createOffer(on: subject)
            case .licenses: openLicenseEditor(nil, on: subject)
            case .documents, .history, .related, .contacts, .submission: break
            }
        }
        subjectOverview.onOpenOffer = { [weak self] id in self?.openOfferEditor(id: id) }
        subjectOverview.onOpenLicense = { [weak self] license in self?.openLicenseEditor(license, on: nil) }
        subjectOverview.onEditPartnerDiscount = { [weak self] organization, current in self?.editPartnerDiscount(organization, current) }
        subjectOverview.isWorkspaceAdmin = { [weak self] in self?.subjectState.isWorkspaceAdmin ?? false }
        subjectOverview.onGoalsChanged = { [weak self] in
            guard let self, let subject = infoSubject, subject.id == selected?.id else { return }
            showSubjectInfo(subject)
        }
        subjectOverview.onSetGoalStatus = { [weak self] goal, status in
            guard let self, let subject = selected else { return }
            Task {
                do {
                    _ = try await self.api.updateCrmGoal(id: goal.id, update: CrmGoalUpdate(status: status))
                    self.subjectOverview.loadGoals(for: subject)
                } catch {
                    self.presentError(error, fallback: String(localized: "Couldn’t update that goal"))
                }
            }
        }
        subjectOverview.onShowBoard = { [weak self] in self?.selectPane(.board) }
        // Where each group's Show all goes is the registry's (`SubjectOverviewGroup.showAll`).
        subjectOverview.onShowAll = { [weak self] group in
            guard let pane = SubjectOverviewGroup(rawValue: group.rawValue)?.showAll else { return }
            self?.selectPane(WorkPaneSelection(pane))
        }

        emptyGlyph.alphaValue = 0.16

        // The column sizes the hosts, never the SwiftUI inside them (AGENTS.md #21).
        for host in [coreHost, fieldsHost, docsHost] { host.sizingOptions = [] }
        coreHost.isHidden = true
        fieldsHost.isHidden = true
        docsHost.isHidden = true
        for view in [paneSwitcher, tabsDivider, subjectOverview, tasksTitleRow, tasksFilterBar, tasksControls,
                     issuesHeader, newIssueButton, addRepoButton, issuesFilterBar, issuesScroll,
                     interactionsHeader, interactionsView, partnerPane,
                     unlinkedLabel, cardBoard, browseScroll, overview, coreHost, fieldsHost, docsHost, emptyGlyph,
                     itemDetail.view] {
            view.translatesAutoresizingMaskIntoConstraints = false
            detail.addSubview(view)
        }

        // The subject view controls are the detail column's primary row. Keep
        // them at the top so a flexible subject header cannot consume the
        // column and push navigation into the lower half of the window.
        let paneSwitcherTop = paneSwitcher.topAnchor.constraint(equalTo: detail.topAnchor)
        let paneSwitcherHeight = paneSwitcher.heightAnchor.constraint(equalToConstant: Self.paneSwitcherHeight)
        paneSwitcherHeightConstraint = paneSwitcherHeight
        let tabsDividerTop = tabsDivider.topAnchor.constraint(equalTo: paneSwitcher.bottomAnchor)
        let tabsDividerHeight = tabsDivider.heightAnchor.constraint(equalToConstant: 1)
        tabsDividerHeightConstraint = tabsDividerHeight
        NSLayoutConstraint.activate([
            // No width floor here. The middle column's minimum is the split
            // view item's (`Column.detailMinimum`), said once; a second copy
            // as a required constraint outranked it and became the real floor
            // the window obeyed.
            detail.heightAnchor.constraint(greaterThanOrEqualToConstant: 360),

            paneSwitcherTop,
            paneSwitcherHeight,
            paneSwitcher.leadingAnchor.constraint(equalTo: detail.leadingAnchor),
            paneSwitcher.trailingAnchor.constraint(equalTo: detail.trailingAnchor),

            tabsDividerTop,
            tabsDivider.leadingAnchor.constraint(equalTo: detail.leadingAnchor),
            tabsDivider.trailingAnchor.constraint(equalTo: detail.trailingAnchor),
            tabsDividerHeight,

            subjectOverview.leadingAnchor.constraint(equalTo: detail.leadingAnchor),
            subjectOverview.trailingAnchor.constraint(equalTo: detail.trailingAnchor),
            subjectOverview.topAnchor.constraint(equalTo: tabsDivider.bottomAnchor),
            subjectOverview.bottomAnchor.constraint(equalTo: detail.bottomAnchor),

            tasksTitleRow.leadingAnchor.constraint(equalTo: detail.leadingAnchor, constant: 20),
            tasksTitleRow.trailingAnchor.constraint(equalTo: detail.trailingAnchor, constant: -20),
            tasksTitleRow.topAnchor.constraint(equalTo: tabsDivider.bottomAnchor, constant: 12),

            tasksFilterBar.leadingAnchor.constraint(equalTo: detail.leadingAnchor, constant: 20),
            tasksFilterBar.trailingAnchor.constraint(equalTo: detail.trailingAnchor, constant: -20),
            tasksFilterBar.topAnchor.constraint(equalTo: tasksTitleRow.bottomAnchor, constant: 8),

            tasksControls.leadingAnchor.constraint(equalTo: detail.leadingAnchor, constant: 20),
            tasksControls.trailingAnchor.constraint(equalTo: detail.trailingAnchor, constant: -20),
            tasksControls.topAnchor.constraint(equalTo: tasksFilterBar.bottomAnchor, constant: 8),
            tasksControls.bottomAnchor.constraint(lessThanOrEqualTo: detail.bottomAnchor, constant: -12),
            tasksControls.heightAnchor.constraint(greaterThanOrEqualToConstant: 120),

            issuesHeader.leadingAnchor.constraint(equalTo: detail.leadingAnchor, constant: 20),
            issuesHeader.topAnchor.constraint(equalTo: tabsDivider.bottomAnchor, constant: 12),
            newIssueButton.trailingAnchor.constraint(equalTo: detail.trailingAnchor, constant: -20),
            newIssueButton.centerYAnchor.constraint(equalTo: issuesHeader.centerYAnchor),
            issuesFilterBar.leadingAnchor.constraint(equalTo: detail.leadingAnchor, constant: 20),
            issuesFilterBar.trailingAnchor.constraint(equalTo: detail.trailingAnchor, constant: -20),
            issuesFilterBar.topAnchor.constraint(equalTo: issuesHeader.bottomAnchor, constant: 8),
            issuesScroll.leadingAnchor.constraint(equalTo: detail.leadingAnchor, constant: 20),
            issuesScroll.trailingAnchor.constraint(equalTo: detail.trailingAnchor, constant: -20),
            issuesScroll.topAnchor.constraint(equalTo: issuesFilterBar.bottomAnchor, constant: 8),
            issuesScroll.bottomAnchor.constraint(equalTo: detail.bottomAnchor, constant: -12),
            issuesStack.widthAnchor.constraint(equalTo: issuesScroll.contentView.widthAnchor),

            interactionsHeader.leadingAnchor.constraint(equalTo: detail.leadingAnchor, constant: 20),
            interactionsHeader.topAnchor.constraint(equalTo: tabsDivider.bottomAnchor, constant: 12),
            interactionsView.leadingAnchor.constraint(equalTo: detail.leadingAnchor),
            interactionsView.trailingAnchor.constraint(equalTo: detail.trailingAnchor),
            interactionsView.topAnchor.constraint(equalTo: interactionsHeader.bottomAnchor, constant: 2),
            interactionsView.bottomAnchor.constraint(equalTo: detail.bottomAnchor),

            partnerPane.leadingAnchor.constraint(equalTo: detail.leadingAnchor),
            partnerPane.trailingAnchor.constraint(equalTo: detail.trailingAnchor),
            partnerPane.topAnchor.constraint(equalTo: tabsDivider.bottomAnchor),
            partnerPane.bottomAnchor.constraint(equalTo: detail.bottomAnchor),

            unlinkedLabel.leadingAnchor.constraint(equalTo: detail.leadingAnchor, constant: 20),
            unlinkedLabel.trailingAnchor.constraint(lessThanOrEqualTo: addRepoButton.leadingAnchor, constant: -10),
            unlinkedLabel.topAnchor.constraint(equalTo: tabsDivider.bottomAnchor, constant: 16),
            addRepoButton.trailingAnchor.constraint(equalTo: detail.trailingAnchor, constant: -20),
            addRepoButton.centerYAnchor.constraint(equalTo: unlinkedLabel.centerYAnchor),

            // The card board is the whole column under the shared tab boundary,
            // like the conversation pane: its columns scroll sideways inside it.
            cardBoard.leadingAnchor.constraint(equalTo: detail.leadingAnchor),
            cardBoard.trailingAnchor.constraint(equalTo: detail.trailingAnchor),
            cardBoard.topAnchor.constraint(equalTo: tabsDivider.bottomAnchor),
            cardBoard.bottomAnchor.constraint(equalTo: detail.bottomAnchor),

            browseScroll.leadingAnchor.constraint(equalTo: detail.leadingAnchor),
            browseScroll.trailingAnchor.constraint(equalTo: detail.trailingAnchor),
            browseScroll.topAnchor.constraint(equalTo: tabsDivider.bottomAnchor),
            browseScroll.bottomAnchor.constraint(equalTo: detail.bottomAnchor),

            overview.leadingAnchor.constraint(equalTo: detail.leadingAnchor),
            overview.trailingAnchor.constraint(equalTo: detail.trailingAnchor),
            overview.topAnchor.constraint(equalTo: tabsDivider.bottomAnchor),
            overview.bottomAnchor.constraint(equalTo: detail.bottomAnchor),

            // Core's screens take the column under the shared tab boundary,
            // like the board.
            coreHost.leadingAnchor.constraint(equalTo: detail.leadingAnchor),
            coreHost.trailingAnchor.constraint(equalTo: detail.trailingAnchor),
            coreHost.topAnchor.constraint(equalTo: tabsDivider.bottomAnchor),
            coreHost.bottomAnchor.constraint(equalTo: detail.bottomAnchor),

            fieldsHost.leadingAnchor.constraint(equalTo: detail.leadingAnchor),
            fieldsHost.trailingAnchor.constraint(equalTo: detail.trailingAnchor),
            fieldsHost.topAnchor.constraint(equalTo: tabsDivider.bottomAnchor),
            fieldsHost.bottomAnchor.constraint(equalTo: detail.bottomAnchor),

            docsHost.leadingAnchor.constraint(equalTo: detail.leadingAnchor),
            docsHost.trailingAnchor.constraint(equalTo: detail.trailingAnchor),
            docsHost.topAnchor.constraint(equalTo: tabsDivider.bottomAnchor),
            docsHost.bottomAnchor.constraint(equalTo: detail.bottomAnchor),


            // The read view is the whole column when it is showing: it carries
            // its own title and does not need the subject tab row.
            itemDetail.view.topAnchor.constraint(equalTo: detail.topAnchor),
            itemDetail.view.leadingAnchor.constraint(equalTo: detail.leadingAnchor),
            itemDetail.view.trailingAnchor.constraint(equalTo: detail.trailingAnchor),
            itemDetail.view.bottomAnchor.constraint(equalTo: detail.bottomAnchor),

            emptyGlyph.centerXAnchor.constraint(equalTo: detail.centerXAnchor),
            emptyGlyph.centerYAnchor.constraint(equalTo: detail.centerYAnchor),
            emptyGlyph.widthAnchor.constraint(equalToConstant: 64),
            emptyGlyph.heightAnchor.constraint(equalToConstant: 64),
        ])

        // "3": positions saved for the old two-column layout would land the
        // divider somewhere the three-column one cannot honour.
        installColumns(
            sidebar: sidebarColumn,
            detail: detailPane,
            inspector: inspector,
            columnsName: "MeetWorkSplit3"
        )

        // The shared-work rows are a way in, not a label: the middle column
        // already knows how to open a subject by id.
        inspector.onOpenPeer = { [weak self] email in self?.onOpenPeer?(email) }
        inspector.onMakeResponsible = { [weak self] email in
            guard let self, let subject = self.infoSubject else { return }
            self.performRowAction(.makeResponsible(subject, email: email))
        }
        inspector.onOpenSharedSubject = { [weak self] id in self?.openSharedSubject(id: id) }
        // Both of these tell the work store as well as the pane, the way
        // `onTaskChanged` below always has. An issue is a card on the board and
        // a row in Mine, so a pane that refreshes only itself leaves the rest of
        // Work describing the state before the write.
        inspector.onIssueChanged = { [weak self] in
            guard let self else { return }
            loadIssues()
            work.refreshNow()
        }
        inspector.onIssueFiled = { [weak self] issue in
            guard let self else { return }
            loadIssues()
            work.refreshNow()
            openIssue(issue)
        }
        inspector.onToggleTaskDone = { [weak self] task, done in
            self?.setTaskDone(task, done: done, fromInspector: true)
        }
        inspector.onPromoteTask = { [weak self] task in self?.promote(task) }
        inspector.onDismiss = { [weak self] in
            guard let self else { return }
            restoreInspectorContext()
            renderIssues()
        }
        // A contact's page: its projects, leads and organization
        // open in the middle column; an edit re-reads the organization beside it.
        inspector.onOpenSubject = { [weak self] subject in
            self?.select(subject)
        }
        inspector.onContactChanged = { [weak self] _ in
            self?.contactsDidChange()
        }
        // Merged away or deleted: the Contacts group and the
        // organization page re-read.
        inspector.onContactRemoved = { [weak self] _ in
            self?.contactsDidChange()
        }
        // Deleted from the task's own page: every list drops it.
        inspector.onTaskDeleted = { [weak self] id in self?.taskWasDeleted(id: id) }
        // Edited or deleted from the interaction's page: History re-reads.
        inspector.onInteractionChanged = { [weak self] saved in
            self?.interactionsView.reload(selecting: saved.id)
        }
        inspector.onInteractionDeleted = { [weak self] _ in
            self?.interactionsView.reload()
        }
        itemDetail.onTaskDeleted = { [weak self] id in self?.taskWasDeleted(id: id) }
        itemDetail.onInteractionChanged = { [weak self] saved in
            self?.interactionsView.reload(selecting: saved.id)
        }
        itemDetail.onInteractionDeleted = { [weak self] _ in
            self?.interactionsView.reload()
        }
        inspector.onQuickNoteFiled = { [weak self] _, kind in
            guard let self else { return }
            loadInbox()
            if kind == .task { loadMine() }
        }
        inspector.onReturnToContext = { [weak self] in
            guard let self else { return }
            restoreInspectorContext()
            renderIssues()
        }

        // The middle column's copy uses the same inline editor, but reports
        // back to Mine rather than to a subject's panes — that is the only
        // difference between the two.
        itemDetail.onToggleTaskDone = { [weak self] task, done in
            self?.setFocusedTaskDone(task, done: done)
        }
        itemDetail.onPromoteTask = { [weak self] task in self?.promoteFocusedTask(task) }
        itemDetail.onOpenSubject = { [weak self] subject in self?.select(subject, pane: .tasks) }
        itemDetail.onIssueChanged = { [weak self] in self?.loadMine() }
        inspector.taskTeam = team
        itemDetail.taskTeam = team
        inspector.onTaskChanged = { [weak self] in
            guard let self else { return }
            loadTasks(resetFilter: false)
            loadMine()
            work.refreshNow()
        }
        itemDetail.onTaskChanged = { [weak self] in
            guard let self else { return }
            loadMine()
            work.refreshNow()
        }
        itemDetail.onDismiss = { [weak self] in
            guard let self else { return }
            focus = .none
            itemDetail.clear()
            applySidebarSelection()
            applyPane()
        }
    }

    // MARK: - Inspector

    private func inspect(_ item: WorkInspectorItem, subjectProjectID: String? = nil) {
        // Which project the column is looking at, so a close or a reopen can
        // say so in that project's channel. Nil on Mine, which is every
        // project at once and therefore none of them. An Overview task can
        // carry its own project context while the Overview itself stays put.
        inspector.subjectProjectID = selected?.kind == "project" ? selected?.id : subjectProjectID
        inspector.taskGoals = selected?.kind == "project" ? subjectOverview.liveGoals : []
        infoSubject = nil
        setInspector(visible: true)
        inspector.show(item)
        updateTabTitle()
        if focus == .none { renderOverview() }
    }

    /// The subject whose facts the inspector is showing, so a late read —
    /// the goals landing after the click — can refresh the same card and
    /// not one somebody has since moved on from.
    private var infoSubject: CrmSubject?

    /// The TEAM that card last drew, so a roster poll redraws only on change.
    private var infoTeam: ConversationTeam?

    private func showSubjectInfo(_ subject: CrmSubject) {
        infoSubject = subject
        let info = subjectInfo(subject)
        infoTeam = info.team
        inspector.showInfo(info)
    }

    /// The right sidebar stays meaningful for every Work selection. Detailed
    /// task and issue reads still use the editor above; list, subject, board,
    /// and Core selections use this shared read-only context mode.
    /// Fills the panel; never opens or closes it. Whether the right sidebar
    /// is up is the user's setting, the way it is in every Mac window with
    /// one, and a click on the left rail does not get to change it. `inspect`
    /// is the exception: editing needs the editor on screen.
    private func showInspectorInfo(_ info: WorkInspectorInfo) {
        infoSubject = nil
        inspector.showInfo(info)
        updateTabTitle()
    }

    private func workOverviewInfo() -> WorkInspectorInfo {
        WorkInspectorInfo(
            title: String(localized: "Work"),
            subtitle: String(localized: "Projects, leads, and your work"),
            sections: [
                .init(String(localized: "ABOUT"), lines: [
                    String(localized: "Choose a subject, list, board or record to see its context here."),
                ]),
            ]
        )
    }

    private func browseInfo() -> WorkInspectorInfo {
        WorkInspectorInfo(
            title: String(localized: "Browse"),
            subtitle: String(localized: "Every subject, by relationship"),
            sections: [
                .init(String(localized: "ABOUT"), lines: [
                    String(localized: "\(StarlingsWorkspace.active.name)’s own projects, clients, organizations and events, plus the lead pipeline when Sales is on."),
                    String(localized: "Star a subject to keep it at the top of the rail; mute it to keep it quiet."),
                ]),
            ]
        )
    }

    /// A subject's card: its facts, under who is on it.
    private func subjectInfo(_ subject: CrmSubject) -> WorkInspectorInfo {
        var info = subjectFacts(subject)
        info.team = ConversationTeam.subject(subject, roster: roster, tasks: tasks(of: subject))
        return info
    }

    /// The loaded tasks that are this subject's, for the suggested responsible person.
    private func tasks(of subject: CrmSubject) -> [CrmTask] {
        loadedTasks.filter { $0.projectID == subject.id || $0.leadID == subject.id }
    }

    private func subjectFacts(_ subject: CrmSubject) -> WorkInspectorInfo {
        let noun = subject.subjectKind.label
        if subject.isPartner {
            let relatedCount = subjectDetails[subject.id].map {
                ($0.related?.projects.count ?? 0) + ($0.related?.leads.count ?? 0) + ($0.related?.contacts.count ?? 0)
            } ?? 0
            var blocks: [SubjectContextBlock: WorkInspectorInfo.Section] = [
                .work: .init(String(localized: "WORK"), lines: [
                    String(localized: "\(subject.openTasks) open tasks"),
                    String(localized: "\(relatedCount) related records"),
                ])
            ]
            if let detail = subjectDetails[subject.id], let industry = detail.industry, !industry.isEmpty {
                blocks[.about] = .init(String(localized: "ABOUT"), lines: [industry])
            }
            // What the organization is to the workspace.
            if let line = subjectDetails[subject.id]?.relationshipLine {
                blocks[.relationship] = .init(String(localized: "RELATIONSHIP"), lines: [line])
            }
            if let address = inboundAddresses[subject.id] {
                blocks[.email] = .init(String(localized: "EMAIL"), lines: [address])
            }
            return WorkInspectorInfo(
                title: subject.title,
                subtitle: subject.subtitle ?? noun,
                sections: contextSections(blocks, for: subject)
            )
        }
        if subject.isEvent { return eventInfo(subject, noun: noun) }
        var workLines = [
            String(localized: "\(subject.openTasks) open tasks"),
        ]
        if subject.overdueTasks > 0 {
            workLines.append(String(subject.overdueTasks) + " overdue")
        }
        if subject.kind == "project" {
            workLines.append(subject.hasRepo ? String(localized: "Repository linked") : String(localized: "No repository linked"))
        }
        var blocks: [SubjectContextBlock: WorkInspectorInfo.Section] = [.work: .init(String(localized: "WORK"), lines: workLines)]
        // The open goals, by name: the direction, beside the counts.
        // Read by the Overview; until it lands the section is not there.
        if subject.kind == "project", subject.id == selected?.id {
            let goals = subjectOverview.liveGoals
            if !goals.isEmpty {
                blocks[.goals] = .init(String(localized: "GOALS"), lines: goals.prefix(3).map { goal in
                    GoalsDecisions.isLate(goal) ? String(localized: "Late: \(goal.title)") : goal.title
                } + (goals.count > 3 ? [String(localized: "\(goals.count - 3) more")] : []))
            }
        }
        if let organization = subject.organizationName, !organization.isEmpty {
            blocks[.relationship] = .init(String(localized: "RELATIONSHIP"), lines: [organization])
        }
        if let detail = subjectDetails[subject.id] {
            var facts: [String] = []
            if !detail.status.isEmpty { facts.append(detail.status) }
            // How many of Core's five checks are set.
            if subject.kind == "lead" { facts.append(LeadQualification.summary(detail.characteristics)) }
            let dates = [detail.startDate, detail.endDate].compactMap { $0 }.joined(separator: " → ")
            if !dates.isEmpty {
                facts.append(dates)
            }
            if subject.kind == "project" {
                if let url = detail.url, !url.isEmpty { facts.append(url) }
                if let description = detail.description?.trimmingCharacters(in: .whitespacesAndNewlines), !description.isEmpty {
                    facts.append(String(description.prefix(180)))
                }
            } else if let notes = detail.notes?.trimmingCharacters(in: .whitespacesAndNewlines), !notes.isEmpty {
                facts.append(String(notes.prefix(180)))
            }
            if !facts.isEmpty { blocks[.about] = .init(String(localized: "ABOUT"), lines: facts) }
        }
        if let address = inboundAddresses[subject.id] {
            blocks[.email] = .init(String(localized: "EMAIL"), lines: [address])
        }
        return WorkInspectorInfo(
            title: subject.title,
            subtitle: subject.subtitle ?? noun,
            sections: contextSections(blocks, for: subject)
        )
    }

    /// The sections in the order the shared registry gives for the subject's kind
    /// (`SubjectContextRegistry`, packages/contracts/src/subject-context.ts). TEAM and
    /// AGENTS come from `info.team`, drawn above these; a block with nothing to say is
    /// simply not in `blocks`.
    private func contextSections(
        _ blocks: [SubjectContextBlock: WorkInspectorInfo.Section],
        for subject: CrmSubject
    ) -> [WorkInspectorInfo.Section] {
        SubjectContextRegistry.blocks(for: subject.subjectKind, client: .mac).compactMap { blocks[$0] }
    }

    /// An event's facts (docs/EVENTS.md), readable from every pane: when,
    /// where, the links, whether the website lists it. The long form —
    /// description, host, linked projects — is the Event pane. The CMS row
    /// arrives with the pane's detail read; until then the summary's date
    /// is all there is.
    private func eventInfo(_ subject: CrmSubject, noun: String) -> WorkInspectorInfo {
        let detail = eventDetails[subject.id]
        let raw = detail?.eventDate ?? subject.eventDate
        let phase = WorkItems.eventPhase(eventDate: raw, now: Date(), calendar: .current)
        var blocks: [SubjectContextBlock: WorkInspectorInfo.Section] = [:]

        var when: [String] = []
        if let raw {
            let parser = DateFormatter()
            parser.calendar = Calendar(identifier: .gregorian)
            parser.dateFormat = "yyyy-MM-dd"
            if let date = parser.date(from: raw) {
                let full = DateFormatter()
                full.dateStyle = .full
                full.timeStyle = .none
                when.append(full.string(from: date))
            } else {
                when.append(raw)
            }
        } else {
            when.append(String(localized: "No date yet"))
        }
        if let startAt = detail?.startAt, let start = ISODate.parse(startAt) {
            let timeZone = detail?.timezone.flatMap(TimeZone.init(identifier:))
            when.append([StarlingsDateFormatting.time(start, timeZone: timeZone), detail?.timezone].compactMap { $0 }.joined(separator: " "))
        }
        blocks[.when] = .init(String(localized: "WHEN"), lines: when)

        let place = [detail?.place, detail?.location].compactMap { $0?.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if !place.isEmpty { blocks[.where] = .init(String(localized: "WHERE"), lines: place) }

        var links: [String] = []
        if let url = detail?.url, !url.isEmpty { links.append(url) }
        if let partner = detail?.partner, !partner.isEmpty {
            links.append([partner, detail?.partnerURL].compactMap { $0 }.joined(separator: " · "))
        }
        if !links.isEmpty { blocks[.links] = .init(String(localized: "LINKS"), lines: links) }

        if let published = detail?.published ?? subject.published {
            blocks[.website] = .init(String(localized: "WEBSITE"), lines: [published ? String(localized: "Listed") : String(localized: "Not listed yet")])
        }

        var workLines = [String(localized: "\(subject.openTasks) open tasks")]
        if subject.overdueTasks > 0 { workLines.append(String(subject.overdueTasks) + " overdue") }
        blocks[.work] = .init(String(localized: "WORK"), lines: workLines)

        if let address = inboundAddresses[subject.id] {
            blocks[.email] = .init(String(localized: "EMAIL"), lines: [address])
        }
        return WorkInspectorInfo(
            title: subject.title,
            subtitle: {
                let line = [phase.label, subject.subtitle].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                return line.isEmpty ? noun : line
            }(),
            sections: contextSections(blocks, for: subject)
        )
    }

    /// The CMS row behind each event this window has opened, by subject id,
    /// so the inspector can say where and when once the pane has read it.
    private var eventDetails: [String: CrmSubjectDetail] = [:]

    /// The forwarding address of each subject channel this window has opened
    ///, by subject id. It arrives on the thread summary, which Talk
    /// loads, so the inspector learns it a moment after the channel opens and
    /// redraws if it is showing that subject. Copying is Talk's context menu.
    private var inboundAddresses: [String: String] = [:]

    private func noteInboundAddress(_ summary: ThreadSummary) {
        guard let subjectID = summary.parentID, let address = summary.inboundAddress else { return }
        guard inboundAddresses[subjectID] != address else { return }
        inboundAddresses[subjectID] = address
        if case .subject(let subject) = focus, subject.id == subjectID {
            showSubjectInfo(subject)
        }
    }

    private func cardsInfo() -> WorkInspectorInfo {
        WorkInspectorInfo(
            title: String(localized: "Board"),
            subtitle: String(localized: "Every open task and issue"),
            sections: [
                .init(String(localized: "ABOUT"), lines: [String(localized: "Open work across every project and lead, grouped by stage.")]),
                .init(String(localized: "SELECTION"), lines: [String(localized: "Choose a card to read its task or issue details.")]),
            ]
        )
    }

    private func coreEntityInfo(_ contract: CRMEntityContract) -> WorkInspectorInfo {
        var access = contract.canUpdate ? String(localized: "Read and edit") : String(localized: "Read only")
        if let count = core.countLabel(for: contract.id) {
            access = count + " · " + access
        }
        return WorkInspectorInfo(
            title: contract.pluralLabel,
            subtitle: contract.singularLabel,
            sections: [
                .init(String(localized: "ABOUT"), lines: [String(localized: "Records with no subject page.")]),
                .init(String(localized: "ACCESS"), lines: [access]),
            ]
        )
    }

    private func docsSearchInfo() -> WorkInspectorInfo {
        WorkInspectorInfo(
            title: String(localized: "Search Docs"),
            subtitle: String(localized: "Titles and full text"),
            sections: [
                .init(String(localized: "ABOUT"), lines: [String(localized: "Every document in Docs, by any word in it.")]),
            ]
        )
    }

    private func coreSearchInfo() -> WorkInspectorInfo {
        WorkInspectorInfo(
            title: String(localized: "Search records"),
            subtitle: String(localized: "Any record, by name"),
            sections: []
        )
    }

    private func catalogInfo() -> WorkInspectorInfo {
        WorkInspectorInfo(
            title: String(localized: "Catalog"),
            subtitle: String(localized: "Services and prices"),
            sections: []
        )
    }

    private func otherRecordsInfo() -> WorkInspectorInfo {
        WorkInspectorInfo(
            title: String(localized: "Other records"),
            subtitle: String(localized: "Records with no subject page"),
            sections: []
        )
    }

    private func taskInfo(_ task: CrmMyTask) -> WorkInspectorInfo {
        var lines = [task.status.menuTitle]
        if let subject = task.subjectTitle { lines.append(subject) }
        if let due = CrmTaskDate.display(task.dueDate) { lines.append(String(localized: "Due \(due)")) }
        return WorkInspectorInfo(
            title: task.title,
            subtitle: String(localized: "Task"),
            sections: [.init(String(localized: "DETAILS"), lines: lines)]
        )
    }

    private func issueInfo(_ issue: CrmIssue) -> WorkInspectorInfo {
        WorkInspectorInfo(
            title: issue.title,
            subtitle: issue.shortReference,
            sections: [
                .init(String(localized: "DETAILS"), lines: [
                    issue.stateSummary,
                    issue.owner + "/" + issue.repo,
                ]),
            ]
        )
    }

    private func restoreInspectorContext() {
        subjectOverview.clearSelection()
        switch focus {
        case .none:
            inspector.showInfo(workOverviewInfo())
        case .subject(let subject): showSubjectInfo(subject)
        case .cards: showInspectorInfo(cardsInfo())
        case .catalog: showInspectorInfo(catalogInfo())
        case .otherRecords: showInspectorInfo(otherRecordsInfo())
        case .coreEntity(let contract): showInspectorInfo(coreEntityInfo(contract))
        case .coreSearch: showInspectorInfo(coreSearchInfo())
        case .docsSearch: showInspectorInfo(docsSearchInfo())
        case .browse: showInspectorInfo(browseInfo())
        case .task(let task): showInspectorInfo(taskInfo(task))
        case .issue(let issue): showInspectorInfo(issueInfo(issue))
        }
        updateTabTitle()
        if focus == .none { renderOverview() }
    }

    private func inspectTask(_ task: CrmTask) {
        inspectedIssueID = nil
        renderIssues()
        tasksControls.setSelectedTaskID(task.id)
        inspect(.task(task, canFile: canFile(task), subject: selected))
    }

    /// Filing needs a repository, and is offered once: a second issue would
    /// orphan the first.
    private func canFile(_ task: CrmTask) -> Bool {
        selected?.kind == "project" && isLinkedToGitHub && task.githubIssueNumber == nil
    }

    /// Nothing chosen any more. The column goes with it rather than staying
    /// open on something the list no longer shows.
    private func clearInspector() {
        inspectedIssueID = nil
        tasksControls.setSelectedTaskID(nil)
        inspector.clear()
        updateTabTitle()
    }

    /// Any way back to the window starts the open conversation again, not
    /// only `windowDidOpen()`.
    override func viewDidAppear() {
        super.viewDidAppear()
        if case .subject = focus { threadPane.resume() }
    }

    override func viewDidDisappear() {
        super.viewDidDisappear()
        // The open conversation stops polling with the window that showed it.
        threadPane.stop()
        searchTask?.cancel()
        mineTask?.cancel()
        taskTask?.cancel()
        issueTask?.cancel()
        interactionsView.stop()
        detailTask?.cancel()
    }

    func windowDidOpen() {
        // Sales is intentionally quiet on every ordinary Work visit. A direct
        // lead destination expands it again after this reset has happened.
        salesSection.startCollapsed()
        if boardIsUp { loadCards() }
        if focus == .none { inspector.showInfo(workOverviewInfo()) }
        applyPane()
        if case .subject = focus { threadPane.resume() }
        reload()
        guard team.isEmpty else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                team = try await api.crmTeam()
                inspector.taskTeam = team
                itemDetail.taskTeam = team
            } catch {
                // Not fatal — a task can still be written down. But an empty
                // assignee menu must not be the only thing that says so.
                setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t load the team"), tone: .danger)
            }
        }
    }

    /// Land on a subject somebody named elsewhere — a row on Home, the menu
    /// bar. The lists are searched afresh so the row is marked when it
    /// arrives; the panes do not wait for it.
    func open(_ destination: WorkDestination) {
        switch destination.target {
        case .mine(let taskID):
            openMine(taskID: taskID)
        case .subject(let subject):
            openSubject(subject, destination: destination)
        case .issue(let owner, let repo, let number):
            openIssue(owner: owner, repo: repo, number: number)
        case .coreEntity(let id):
            showCore(entityID: id)
        case .contact(let id, let name):
            if let name { openContact(id: id, name: name) } else { openContact(id: id) }
        }
    }

    /// A contact's page in the inspector, from search or an
    /// organization's page. The middle column stays where it is.
    func openContact(id: String, name: String = String(localized: "Contact")) {
        inspect(.contact(id: id, name: name))
    }

    /// Add contact on an organization's page: the sheet with the organization
    /// chosen, then the new contact's page.
    private func addContact(to organization: CrmSubject) {
        WorkContactEditor.present(
            over: view.window,
            api: api,
            contact: nil,
            organization: SubjectRelationOption(id: organization.id, name: organization.title)
        ) { [weak self] saved in
            guard let self else { return }
            if selected?.id == organization.id { loadPartnerDetail(organization) }
            loadContacts()
            openContact(id: saved.id, name: saved.displayName)
        }
    }

    /// A contact was edited, merged or deleted in the inspector: the Contacts
    /// group re-reads, and so does the organization page beside it.
    private func contactsDidChange() {
        loadContacts()
        guard let selected, selected.kind == "organization", !selected.isEvent else { return }
        loadPartnerDetail(selected)
    }

    /// Edit organization: the sheet, then the page, the rail row
    /// and the inspector take the saved record.
    private func editOrganization(_ organization: CrmSubject, detail: CrmSubjectDetail) {
        WorkOrganizationEditor.present(over: view.window, api: api, detail: detail) { [weak self] saved in
            guard let self else { return }
            let summary = saved.summary
            subjectDetails[summary.id] = saved
            partners = partners.map { $0.id == summary.id ? summary : $0 }
            if selected?.id == summary.id {
                selected = summary
                focus = .subject(summary)
                partnerPane.show(summary, detail: saved)
                showSubjectInfo(summary)
            }
            renderSidebar()
            loadSubjects(debounced: false, refreshCounts: true)
        }
    }

    /// Merge a duplicate into an organization: the sheet picks
    /// it, a question confirms, then the one that stayed opens.
    private func mergeOrganization(_ organization: CrmSubject) {
        OrganizationMergeSheet.present(over: view.window, api: api, organization: organization) { [weak self] duplicate in
            self?.confirmMergeOrganization(organization, with: duplicate)
        }
    }

    private func confirmMergeOrganization(_ organization: CrmSubject, with duplicate: StarlingsSearchablePickerOption) {
        let alert = NSAlert()
        alert.messageText = String(localized: "Merge “\(organization.displayTitle)” and “\(duplicate.title)”?")
        alert.informativeText = String(localized: "The older one keeps every link, and the other is deleted for good.")
        alert.alertStyle = .warning
        alert.addButton(withTitle: String(localized: "Merge"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        alert.buttons.first?.hasDestructiveAction = true
        let proceed: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            self?.mergeOrganizations(organization, duplicate: duplicate)
        }
        if let window = view.window { alert.beginSheetModal(for: window, completionHandler: proceed) } else { proceed(alert.runModal()) }
    }

    private func mergeOrganizations(_ organization: CrmSubject, duplicate: StarlingsSearchablePickerOption) {
        Task { [weak self] in
            guard let self else { return }
            do {
                let answer = try await api.mergeCrmOrganizations(ids: [organization.id, duplicate.id])
                let keptTitle = answer.kept == organization.id ? organization.displayTitle : duplicate.title
                partners.removeAll { answer.merged.contains($0.id) }
                for id in answer.merged { subjectDetails[id] = nil }
                subjectDetails[answer.kept] = nil
                renderSidebar()
                setStatus(String(localized: "Merged into \(keptTitle)"))
                loadSubjects(debounced: false, refreshCounts: true)
                if let kept = partners.first(where: { $0.id == answer.kept }) {
                    select(kept)
                } else if answer.merged.contains(selected?.id ?? "") {
                    showOverview()
                }
            } catch {
                presentError(error, fallback: String(localized: "Couldn’t merge those organizations"))
            }
        }
    }

    /// Delete an organization, after a question. The Worker
    /// refuses while a record still points at it and names those records;
    /// that message is the alert.
    private func confirmDeleteOrganization(_ organization: CrmSubject) {
        let alert = NSAlert()
        alert.messageText = String(localized: "Delete “\(organization.displayTitle)”?")
        alert.informativeText = String(localized: "The organization is deleted. This can’t be undone.")
        alert.alertStyle = .warning
        alert.addButton(withTitle: String(localized: "Delete"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        alert.buttons.first?.hasDestructiveAction = true
        let proceed: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            self?.deleteOrganization(organization)
        }
        if let window = view.window { alert.beginSheetModal(for: window, completionHandler: proceed) } else { proceed(alert.runModal()) }
    }

    private func deleteOrganization(_ organization: CrmSubject) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await api.deleteCrmOrganization(id: organization.id)
                partners.removeAll { $0.id == organization.id }
                subjectDetails[organization.id] = nil
                if selected?.id == organization.id { showOverview() }
                renderSidebar()
                setStatus(String(localized: "Deleted \(organization.displayTitle)"))
                loadSubjects(debounced: false, refreshCounts: true)
            } catch {
                presentError(error, fallback: String(localized: "Couldn’t delete that organization"))
            }
        }
    }

    /// One issue by reference, from Search (#225). Loaded here because a
    /// search row carries `owner/repo#n` and nothing else; a direct search
    /// destination reads it in the middle column. Overview issue rows use the
    /// inspector so their lists stay in place.
    private func openIssue(owner: String, repo: String, number: Int) {
        searchField.stringValue = ""
        Task { [weak self] in
            guard let self else { return }
            do {
                let detail = try await self.api.crmIssue(owner: owner, repo: repo, number: number)
                self.focusIssue(detail.issue)
            } catch {
                self.setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t load that issue"), tone: .danger)
            }
        }
    }

    /// A direct Work destination for Mine. No row named means Overview; a
    /// named row is read in the middle column. A click from Overview uses the
    /// right inspector instead. Mine may not have landed yet when a row on
    /// Home names one of its tasks, so the id waits for the next render
    /// rather than being dropped.
    func openMine(taskID: String?) {
        searchField.stringValue = ""
        if let taskID, let task = mine.first(where: { $0.id == taskID }) {
            focusTask(task)
        } else {
            if taskID == nil { showOverview() }
            pendingMineTaskID = taskID
            renderSidebar()
        }
        reload()
    }

    private func openSubject(_ subject: CrmSubject, destination: WorkDestination) {
        searchField.stringValue = ""
        focus = .subject(subject)
        selected = subject
        subjectOverview.show(subject)
        if !subject.isPartner, !subject.isEvent { loadSubjectDetail(subject) }
        showSubjectInfo(subject)
        for thread in unreadSubjectThreads where thread.parentID == subject.id {
            watch.markRead(threadID: thread.id)
        }
        selectedPane = switch destination.pane {
        // Talk lives inside Overview; there is no bare Talk column.
        case .overview, .talk: .overview
        case .tasks: .tasks
        case .issues: .issues
        case .interactions: .interactions
        }
        // The block the subject is in has to be open, or the window lands on
        // something the sidebar appears not to contain.
        subjectsSection.expand()
        recordHop(subject)
        reload()
        threadPane.show(.subject(subject))
        applyPane()
        loadTasks()
        loadProjectRepos()
        loadIssues()
        loadInteractions()
        // The editor a search verb asked for, once the subject is
        // on screen; the same doors the menu items go through.
        switch destination.action {
        case .newTask: newTaskFromMenu()
        case .newIssue: newIssueFromMenu()
        case .newDocument: newDocumentFromMenu()
        case nil: break
        }
    }

    /// Open a person-based conversation in the middle column. The sidebar
    /// A project or lead named on the person panel. Only somewhere to go when
    /// the list already holds it — the panel knows an id and a title, and
    /// inventing a subject from those two would put a row on screen that Core
    /// has never confirmed.
    private func openSharedSubject(id: String) {
        guard let subject = (envisioningProjects + clientProjects + leads).first(where: { $0.id == id })
        else { return }
        select(subject, pane: .talk)
    }

    @objc private func paneControlChanged() {
        guard shownPanes.indices.contains(paneControl.selectedSegment) else { return }
        selectPane(shownPanes[paneControl.selectedSegment])
    }

    private func selectPane(_ pane: WorkPaneSelection) {
        guard pane != .documents || docs.isLinked else { return }
        if pane != .interactions, case .interaction(_) = inspector.item {
            if let subject = selected {
                showSubjectInfo(subject)
            } else {
                clearInspector()
            }
        }
        // Leaving Documents is the moment to re-ask: a document filed while
        // that pane was open (`DocumentsPane` holds its own list, not this
        // badge's count) only shows up here on the way out.
        let leftDocuments = selectedPane == .documents && pane != .documents
        selectedPane = pane
        syncPaneControl()
        applyPane()
        if pane == .interactions { loadInteractions() }
        if pane == .board { loadCards() }
        if pane == .fields { loadFields() }
        if pane == .documents { loadDocuments() }
        if leftDocuments { loadDocumentsCount() }
    }

    /// "Meet about this" is a row's and a card's context menu now — it left the
    /// toolbar, where it was a wide labelled button among icons and was
    /// disabled more often than not. `canMeet` moved with it: what the greyed
    /// button used to say, this says by doing nothing.
    @objc private func meetPressed() {
        guard canMeet?() ?? false, let subject = meetSubject else { return }
        onMeetAbout?(subject)
    }

    /// Menu-bar entry points keep the action in the Work controller, so the
    /// menu and the row context menu always use the same editors and selection.
    func newProjectFromMenu() {
        presentSubjectEditor(kind: .project, detail: nil, subject: nil)
    }

    func newLeadFromMenu() {
        // A lead is sales work: filing one turns Sales on for you, so the
        // row has somewhere to be seen.
        if !subjectState.salesEnabled { setSalesEnabled(true) }
        presentSubjectEditor(kind: .lead, detail: nil, subject: nil)
    }

    /// ⌘[ and ⌘]: the subjects opened this session, like a browser's history.
    func goBack() {
        travel(to: historyCursor - 1)
    }

    func goForward() {
        travel(to: historyCursor + 1)
    }

    var canGoBack: Bool { historyCursor > 0 }
    var canGoForward: Bool { historyCursor >= 0 && historyCursor < subjectHistory.count - 1 }

    private func travel(to index: Int) {
        guard subjectHistory.indices.contains(index) else { return }
        historyCursor = index
        isTravelling = true
        select(subjectHistory[index])
        isTravelling = false
    }

    /// A subject opened by a click, a row, a link — not by walking history.
    /// Anything ahead of the cursor is dropped, as a browser does.
    private func recordHop(_ subject: CrmSubject) {
        guard !isTravelling else { return }
        // Into the device's recents too — the list Home's QUICK ACCESS module and
        // the ⌘K palette share. The session history stays ⌘[ ⌘]'s.
        if let row = SearchRow.subject(subject) { SearchRecents.remember(row, owner: api.signedInOwnerEmail ?? "") }
        if subjectHistory.indices.contains(historyCursor), subjectHistory[historyCursor].id == subject.id { return }
        if historyCursor < subjectHistory.count - 1 {
            subjectHistory.removeSubrange((historyCursor + 1)...)
        }
        subjectHistory.append(subject)
        historyCursor = subjectHistory.count - 1
    }

    /// Escape, anywhere in the window: back to Overview. The one key that
    /// always leads home, the way Team's grid is what you open on.
    override func cancelOperation(_ sender: Any?) {
        guard focus != .none else { return }
        showOverview()
    }

    /// Work's home: nothing chosen, the middle pane as the day at a glance.
    func showOverview() {
        detailTask?.cancel()
        itemDetail.clear()
        leaveSubject()
        focus = .none
        showInspectorInfo(workOverviewInfo())
        applySidebarSelection()
        applyPane()
    }

    /// The directory, in the middle pane.
    func showBrowse() {
        guard focus != .browse else { return }
        detailTask?.cancel()
        itemDetail.clear()
        leaveSubject()
        focus = .browse
        showInspectorInfo(browseInfo())
        applySidebarSelection()
        applyPane()
        if contactPage == nil { loadContacts() }
        if browseOffers == nil, browseLicenses == nil { configureBrowseRecords(); loadBrowseRecords() }
        browseScroll.reflectScrolledClipView(browseScroll.contentView)
    }

    func newTaskFromMenu() {
        guard let subject = selected else {
            setStatus(String(localized: "Select a project, lead or partner first."))
            return
        }
        select(subject, pane: .tasks)
        composeTask(nil, subject: subject)
    }

    func newIssueFromMenu() {
        guard let subject = selected, subject.kind == "project" else {
            setStatus(String(localized: "Select a project first."))
            return
        }
        select(subject, pane: .issues)
        newIssuePressed()
    }

    /// A document is always about the open subject; the pane owns the title
    /// prompt, so this only lands on Documents and asks it to open one.
    func newDocumentFromMenu() {
        guard docs.isLinked else {
            setStatus(String(localized: "Docs isn’t connected."))
            Task { await docs.ensureLinked() }
            return
        }
        guard let subject = selected else {
            setStatus(String(localized: "Select a project or lead first."))
            return
        }
        select(subject)
        selectPane(.documents)
        let ref = "core:\(subject.kind):\(subject.id)"
        // The pane may have been built this very turn; let it attach first.
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: DocumentsPane.requestNew, object: ref)
        }
    }

    func meetAboutSelectedFromMenu() {
        meetPressed()
    }

    @objc func newProjectPressed() {
        newProjectFromMenu()
    }

    @objc func newLeadPressed() {
        newLeadFromMenu()
    }

    @objc func newTaskPressed() {
        newTaskFromMenu()
    }

    @objc func newIssueFromToolbar() {
        newIssueFromMenu()
    }

    @objc func newDocumentPressed() {
        newDocumentFromMenu()
    }

    /// Capture, from the toolbar's + and the Work menu. The note lands in
    /// INBOX until it is filed.
    @objc func newQuickNotePressed() {
        captureQuickNote()
    }

    func searchDocsFromMenu() {
        guard docs.isLinked else {
            setStatus(String(localized: "Docs isn’t connected."))
            Task { await docs.ensureLinked() }
            return
        }
        showDocsSearch(query: "")
    }

    @objc private func editSubjectPressed() {
        guard let subject = selected else { return }
        detailTask?.cancel()
        setStatus(String(localized: "Loading subject…"))
        detailTask = Task { [weak self] in
            guard let self else { return }
            do {
                let detail = try await api.crmSubjectDetail(
                    kind: subject.subjectKind,
                    id: subject.id
                )
                guard !Task.isCancelled else { return }
                setStatus(nil)
                presentSubjectEditor(
                    kind: subject.subjectKind,
                    detail: detail,
                    subject: subject
                )
            } catch {
                guard !Task.isCancelled else { return }
                setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t load that subject"), tone: .danger)
            }
        }
    }

    /// A row-level rename keeps the common title-only edit quick, without
    /// sending nil metadata from the full editor and clearing Core fields.
    private func renameSubject(_ subject: CrmSubject) {
        presentRenameAlert(for: subject, prefilled: subject.title, errorMessage: nil)
    }

    /// `errorMessage` set means this is a retry after a failed save — the
    /// alert reopens pre-filled with what was already typed instead of
    /// dropping it, so a Core hiccup doesn't cost the user their edit.
    private func presentRenameAlert(for subject: CrmSubject, prefilled: String, errorMessage: String?) {
        let alert = NSAlert()
        let noun = subject.kind == "lead" ? "lead" : subject.kind == "organization" ? "partner" : "project"
        alert.messageText = String(localized: "Rename \(noun)")
        alert.informativeText = errorMessage ?? ""
        alert.alertStyle = errorMessage == nil ? .informational : .warning
        alert.addButton(withTitle: errorMessage == nil ? String(localized: "Rename") : String(localized: "Try Again"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        let copyResponse = errorMessage == nil ? nil : alert.addCopyErrorButton()
        let field = StarlingsTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 28))
        field.stringValue = prefilled
        field.placeholderString = String(localized: "Name")
        alert.accessoryView = field
        let response = alert.runModal()
        if let copyResponse, response == copyResponse, let errorMessage {
            StarlingsErrorReport.copy(message: errorMessage)
            // Copying should not cost the typed name — come back with it.
            presentRenameAlert(for: subject, prefilled: field.stringValue, errorMessage: errorMessage)
            return
        }
        guard response == .alertFirstButtonReturn else { return }
        let title = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else {
            setStatus(String(localized: "Add a name first."))
            return
        }
        Task { [weak self] in
            guard let self else { return }
            do {
                let detail = try await api.renameCrmSubject(
                    kind: subject.subjectKind,
                    id: subject.id,
                    title: title
                )
                let summary = detail.summary
                if summary.kind == "project" {
                    // A rename can cross the Envisioning/client line (adding or
                    // dropping the "Envisioning " prefix), so drop it from
                    // both before filing it back under whichever it is now.
                    envisioningProjects.removeAll { $0.id == summary.id }
                    clientProjects.removeAll { $0.id == summary.id }
                    if summary.isInternalProject {
                        envisioningProjects.append(summary)
                    } else {
                        clientProjects.append(summary)
                    }
                } else {
                    leads = leads.map { $0.id == summary.id ? summary : $0 }
                }
                if selected?.id == summary.id {
                    selected = summary
                    focus = .subject(summary)
                    threadPane.show(.subject(summary))
                }
                renderSidebar()
                applyPane()
                setStatus(nil)
                loadSubjects(debounced: false, refreshCounts: true)
            } catch {
                let message = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t rename that subject")
                setStatus(message, tone: .danger)
                presentRenameAlert(for: subject, prefilled: title, errorMessage: message)
            }
        }
    }

    /// A saved or won project goes to the top of its list, under
    /// Envisioning or clients by what it is now.
    private func fileProject(_ summary: CrmSubject) {
        envisioningProjects.removeAll { $0.id == summary.id }
        clientProjects.removeAll { $0.id == summary.id }
        if summary.isInternalProject {
            envisioningProjects.insert(summary, at: 0)
        } else {
            clientProjects.insert(summary, at: 0)
        }
    }

    /// Win (ADR 0008): the sheet makes the project from the lead; Work files
    /// it, opens it, and says what stayed behind.
    private func winLead(_ lead: CrmSubject) {
        LeadWinSheet.present(over: view.window, lead: lead, api: api) { [weak self] response in
            self?.leadWon(response)
        }
    }

    private func leadWon(_ response: CrmLeadWinResponse) {
        let summary = CrmSubjectDetail(wire: response.project).summary
        fileProject(summary)
        select(summary, pane: .talk)
        var notes: [String] = []
        if !response.leadClosed {
            notes.append(String(localized: "Project started. The lead is still open."))
        }
        let unmoved = response.unmovedTaskIDs.count
        if unmoved > 0 {
            notes.append(String(localized: "\(unmoved) tasks stayed on the lead."))
        }
        setStatus(notes.isEmpty ? nil : notes.joined(separator: " "))
        loadSubjects(debounced: false, refreshCounts: true)
    }

    private func presentSubjectEditor(
        kind: MeetingCategoryKind.SubjectKind,
        detail: CrmSubjectDetail?,
        subject: CrmSubject?
    ) {
        WorkSubjectEditor.present(
            over: view.window,
            title: subject == nil ? String(localized: "New \(kind.rawValue.capitalized)") : String(localized: "Edit \(kind.rawValue.capitalized)"),
            kind: kind,
            detail: detail,
            organizationSearch: organizationSearchHandler(),
            organizationCreate: organizationCreateHandler(),
            resolveOrganizations: organizationResolveHandler(),
            contactSearch: contactSearchHandler(),
            resolveContacts: contactResolveHandler(),
            repository: subject.flatMap(repositoryLink(for:))
        ) { [weak self] draft, completion in
            guard let self else { return }
            saveSubject(draft, existing: subject, completion: completion)
        }
    }

    /// The editor's Repository row. A new project has no id to link to yet,
    /// so only an existing project gets one.
    private func repositoryLink(for subject: CrmSubject) -> WorkSubjectEditor.RepositoryLink? {
        guard subject.kind == "project" else { return nil }
        let linked = selected?.id == subject.id ? projectRepos.map(\.address) : []
        return WorkSubjectEditor.RepositoryLink(linked: linked) { [weak self] window, done in
            self?.presentRepositoryPicker(over: window, projectID: subject.id) { done($0.address) }
        }
    }

    /// The organization picker reads the Worker's `/api/crm/organizations`
    /// only: Core while the subjects group is there, D1 after. A
    /// failure is an error the picker shows, never an empty list.
    private func organizationSearchHandler() -> WorkSubjectEditor.OrganizationSearch? {
        let api = api
        return { query in try await api.crmOrganizations(matching: query) }
    }

    /// Through the Worker, the route the web's picker uses: Core on a Core
    /// workspace, the workspace's own D1 otherwise, so "Create" works before
    /// Core is linked and on a workspace with no Core at all.
    private func organizationCreateHandler() -> RelationPickerView.Create? {
        let api = api
        return { name in try await api.crmCreateOrganization(named: name) }
    }

    /// The workspace's contacts, through the Worker (`GET /api/crm/contacts`,
    ///): D1's own on a D1 workspace, Core's as the member on Core.
    /// It needs no Core link on this Mac.
    private func contactSearchHandler() -> WorkSubjectEditor.ContactSearch? {
        let api = api
        return { query in
            try await api.crmContacts(matching: query).map(\.relationOption)
        }
    }

    /// The contacts a subject carries, named by id through the same route.
    private func contactResolveHandler() -> WorkSubjectEditor.ContactResolve? {
        let api = api
        return { ids in
            let found = try await api.crmContacts(ids: ids)
            return ids.compactMap { id in found.first { $0.id == id }?.relationOption }
        }
    }

    /// The organizations a subject names, by id, through the Worker's
    /// subject route: the name, and the city and country that
    /// tell two like names apart. An id the Worker does not answer keeps the
    /// name the picker already has.
    private func organizationResolveHandler() -> WorkSubjectEditor.OrganizationResolve? {
        let api = api
        return { ids in
            var options: [WorkSubjectEditor.RelationOption] = []
            for id in ids {
                guard let detail = try? await api.crmSubjectDetail(kind: .organization, id: id) else { continue }
                let place = [detail.city, detail.country]
                    .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                options.append(WorkSubjectEditor.RelationOption(
                    id: id,
                    name: detail.title,
                    secondaryText: place.isEmpty ? nil : place.joined(separator: " · ")
                ))
            }
            return options
        }
    }

    private func saveSubject(
        _ draft: WorkSubjectEditor.Draft,
        existing: CrmSubject?,
        relations: (organizationID: String?, contactID: String?) = (nil, nil),
        completion: @escaping (WorkSubjectEditor.SaveFailure?) -> Void
    ) {
        let organizationID = relations.organizationID ?? draft.organizationID
        // A lead names its organization; a project may have none.
        let organization = SubjectFormFields(draft.kind).organization
        let lacking: Set<String> = existing != nil && existing?.organizationID == nil ? [organization.id] : []
        // The sheet shows a refusal; the window's status line does not repeat it.
        if let message = FormFieldRegistry.problem([(organization, organizationID)], lacking: lacking) {
            completion(.init(message: message))
            return
        }
        let wire = { (date: Date?) -> String? in
            guard let date else { return nil }
            let formatter = DateFormatter()
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "yyyy-MM-dd"
            return formatter.string(from: date)
        }
        Task { [weak self] in
            guard let self else { return }
            do {
                let start = wire(draft.startDate)
                let end = wire(draft.endDate)
                let cleanDescription = draft.description.isEmpty ? nil : draft.description
                let cleanURL = draft.url.isEmpty ? nil : draft.url
                let cleanNotes = draft.notes.isEmpty ? nil : draft.notes
                let detail: CrmSubjectDetail
                if let existing {
                    detail = try await api.updateCrmSubject(
                        kind: draft.kind,
                        id: existing.id,
                        update: CrmSubjectUpdate(
                            kind: draft.kind,
                            title: draft.title,
                            status: draft.status,
                            startDate: start,
                            endDate: end,
                            description: draft.kind == .project ? cleanDescription : nil,
                            url: draft.kind == .project ? cleanURL : nil,
                            notes: draft.kind == .lead ? cleanNotes : nil,
                            organizationID: organizationID,
                            contactID: draft.kind == .lead ? draft.contactID : nil,
                            contactIDs: draft.kind == .lead ? [] : draft.contactIDs,
                            characteristics: draft.kind == .lead ? draft.characteristics : nil
                        )
                    )
                } else {
                    detail = try await api.createCrmSubject(
                        CrmSubjectDraft(
                            kind: draft.kind,
                            title: draft.title,
                            status: draft.status,
                            startDate: start,
                            endDate: end,
                            description: draft.kind == .project ? cleanDescription : nil,
                            url: draft.kind == .project ? cleanURL : nil,
                            notes: draft.kind == .lead ? cleanNotes : nil,
                            organizationID: organizationID,
                            contactID: relations.contactID ?? draft.contactID,
                            contactIDs: draft.contactIDs,
                            characteristics: draft.kind == .lead ? draft.characteristics : nil
                        )
                    )
                }
                let summary = detail.summary
                if draft.kind == .project {
                    fileProject(summary)
                } else {
                    leads.removeAll { $0.id == summary.id }
                    leads.insert(summary, at: 0)
                }
                setStatus(nil)
                select(summary, pane: .talk)
                loadSubjects(debounced: false, refreshCounts: true)
                completion(nil)
            } catch {
                // The plan's words, not the Worker's. The line stays
                // in the sheet; the window's status line is for faults.
                let serverCode = (error as? StarlingsError)?.serverCode
                let isAdmin = subjectState.isWorkspaceAdmin
                if WorkspacePlanNotice.isProjectLimit(serverCode) {
                    completion(.init(
                        message: WorkspacePlanNotice.limitText(isAdmin: isAdmin),
                        isPlanLimit: true,
                        offersUpgrade: isAdmin
                    ))
                    return
                }
                if WorkspacePlanNotice.isProjectFrozen(serverCode) {
                    completion(.init(
                        message: WorkspacePlanNotice.frozenText(isAdmin: isAdmin),
                        isPlanLimit: true,
                        offersUpgrade: isAdmin
                    ))
                    return
                }
                let message = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t save that subject")
                completion(.init(message: message))
            }
        }
    }

    private func applyPane() {
        let subject = selected
        let isProject = subject?.kind == "project"
        let hasSubject = subject != nil
        let readsItem: Bool = switch focus {
        case .task, .issue: true
        case .none, .subject, .cards, .catalog, .otherRecords, .coreEntity, .coreSearch, .docsSearch, .browse: false
        }
        let showsBrowse = focus == .browse
        let showsCards = boardIsUp
        let coreContract: CRMEntityContract? = if case .coreEntity(let contract) = focus { contract } else { nil }
        let showsCoreSearch = focus == .coreSearch
        let showsCatalog = focus == .catalog
        let showsOtherRecords = core.isAvailable && focus == .otherRecords
        let showsCore = showsCatalog || showsOtherRecords || (core.isLinked && (coreContract != nil || showsCoreSearch))
        let showsDocs = docs.isLinked && focus == .docsSearch
        // The window names what it is open on, the way a document window does.
        view.window?.subtitle = switch focus {
        case .subject(let subject): subject.title
        case .task(let task): task.title
        case .issue(let issue): issue.title
        case .cards: String(localized: "Board")
        case .catalog: String(localized: "Catalog")
        case .otherRecords: String(localized: "Other records")
        case .coreEntity(let contract): contract.pluralLabel
        case .coreSearch: String(localized: "Search records")
        case .docsSearch: String(localized: "Search Docs")
        case .browse: String(localized: "Browse")
        case .none: ""
        }
        updateTabTitle()
        // Subject view controls are the only content that uses this strip.
        // Collapse the row and its divider for boards/Core so those surfaces
        // also start at the top rather than inheriting invisible chrome.
        let showsStrip = hasSubject
        paneSwitcher.isHidden = !showsStrip
        paneSwitcherHeightConstraint?.constant = showsStrip ? Self.paneSwitcherHeight : 0
        tabsDivider.isHidden = !showsStrip
        tabsDividerHeightConstraint?.constant = showsStrip ? 1 : 0
        itemDetail.view.isHidden = !readsItem
        cardBoard.isHidden = !showsCards
        browseScroll.isHidden = !showsBrowse
        // Docs' own screens share Core's host slot: the two are never up at once.
        coreHost.isHidden = !(showsCore || showsDocs)
        // Nothing chosen is Overview, not an empty column. The mark stays as
        // the fallback for a session with nothing to draw from.
        let showsOverview = focus == .none && (try? api.ownerSessionStore.load()) != nil
        overview.isHidden = !showsOverview
        if showsOverview { renderOverview() }
        emptyGlyph.isHidden = showsOverview || readsItem || showsCards || showsBrowse || showsCore || showsDocs || hasSubject
        if !showsCards { cardsTask?.cancel() }
        if selectedPane == .issues && !selectedHasRepository { selectedPane = .overview }
        syncPaneControl()
        let pane: WorkPaneSelection? = hasSubject ? selectedPane : nil
        partnerPane.isHidden = pane != .partner && pane != .event
        subjectOverview.isHidden = pane != .overview
        tasksTitleRow.isHidden = pane != .tasks
        tasksFilterBar.isHidden = pane != .tasks
        tasksControls.isHidden = pane != .tasks
        let showsIssues = pane == .issues && isProject
        issuesHeader.isHidden = !(showsIssues && isLinkedToGitHub)
        issuesFilterBar.isHidden = !(showsIssues && isLinkedToGitHub)
        issuesScroll.isHidden = !(showsIssues && isLinkedToGitHub)
        // Filing needs somewhere to file to, so the button follows the link
        // rather than offering an act that can only fail.
        newIssueButton.isHidden = !(showsIssues && isLinkedToGitHub)
        unlinkedLabel.isHidden = !(showsIssues && !isLinkedToGitHub)
        addRepoButton.isHidden = !(showsIssues && !isLinkedToGitHub)
        let showsInteractions = pane == .interactions && hasSubject
        interactionsHeader.isHidden = !showsInteractions
        interactionsView.isHidden = !showsInteractions
        fieldsHost.isHidden = !(hasSubject && pane == .fields)
        docsHost.isHidden = !(docs.isLinked && hasSubject && pane == .documents)
    }

    /// The surface title names the selected subject while one is open. A
    /// direct destination names its item; Overview names a row opened in its
    /// inspector. The fixed Work segment in the toolbar continues to name the
    /// surface itself.
    private var tabContextTitle: String? {
        if let selected { return selected.title }
        switch focus {
        case .subject(let subject): return subject.title
        case .task(let task): return task.title
        case .issue(let issue): return issue.title
        case .cards: return String(localized: "Board")
        case .catalog: return String(localized: "Catalog")
        case .otherRecords: return String(localized: "Other records")
        case .coreEntity(let contract): return contract.pluralLabel
        case .coreSearch: return String(localized: "Search records")
        case .docsSearch: return String(localized: "Search Docs")
        case .browse: return String(localized: "Browse")
        case .none:
            switch inspector.item {
            case .some(.issue(let issue)): return issue.title
            case .some(.interaction(let interaction)): return interaction.title
            case .some(.task(let task, _, let subject)): return subject?.title ?? task.title
            case .some(.newIssue(let subject)): return subject.title
            case .some(.document(_, let title)): return title
            case .some(.quickNote(let note)): return note.firstLine
            case .some(.contact(_, let name)): return name
            case nil: return nil
            }
        }
    }

    private func updateTabTitle() {
        StarlingsWindowChrome.setContextTitle(for: view.window, surface: .work, context: tabContextTitle)
    }

    /// The subject's tabs, from the one table every client reads
    /// (`SubjectPane.layout`). Docs is an optional integration, so Documents
    /// is a tab only while Settings has a live credential. Fields reads the
    /// Worker and needs no Core credential. Talk always stands
    /// beside Overview here.
    private func syncPaneControl() {
        var has: Set<SubjectPane.Need> = []
        if selectedHasRepository { has.insert(.repo) }
        if docs.isLinked { has.insert(.docs) }
        let panes = SubjectPane.panes(for: selected?.subjectKind ?? .project, has: has).map(WorkPaneSelection.init)
        if !panes.contains(selectedPane) { selectedPane = panes.first ?? .overview }
        if panes != shownPanes {
            shownPanes = panes
            paneControl.segmentCount = panes.count
        }
        for (index, pane) in panes.enumerated() {
            paneControl.setLabel(paneLabel(pane), forSegment: index)
        }
        paneControl.selectedSegment = panes.firstIndex(of: selectedPane) ?? 0
    }

    /// A tab's name. Fields, Event and Partner
    /// have no single count that means anything. Tasks, Issues, History and
    /// Documents say how much is behind them, the same count each pane
    /// already keeps for its own header.
    private func paneLabel(_ pane: WorkPaneSelection) -> String {
        let count: Int? = switch pane {
        case .overview, .talk, .board, .fields, .partner, .event: nil
        case .tasks: selected?.openTasks
        case .issues: issues.count
        case .interactions: interactionsCount
        case .documents: documentsCount
        }
        guard let count, count > 0 else { return pane.title }
        return String(localized: "\(pane.title) (\(count))")
    }

    /// Independent of `loadDocuments()`, which only builds the pane's host
    /// once Documents is actually chosen — the badge needs a count before
    /// that, so this asks Docs directly and throws the answer away if the
    /// subject has already moved on by the time it answers.
    private func loadDocumentsCount() {
        documentsCountTask?.cancel()
        guard docs.isLinked, let subject = selected, let about = subject.docsSubject else {
            documentsCount = 0
            return
        }
        documentsCountTask = Task { [weak self] in
            guard let self else { return }
            let found = try? await docs.client.documents(about: about)
            guard !Task.isCancelled, selected?.id == subject.id else { return }
            documentsCount = found?.count ?? 0
            applyPane()
        }
    }

    private func coreStateDidChange() {
        guard isViewLoaded else { return }
        otherRecordsRow.isHidden = !core.isAvailable
        if !core.isLinked {
            switch focus {
            case .coreEntity, .coreSearch:
                focus = .none
                coreHost.rootView = meetHosted(EmptyView())
            default:
                break
            }
        }
        syncPaneControl()
        applySidebarLayout()
        renderSidebar()
        applyPane()
    }

    @objc private func searchChanged() {
        // Mine is already in hand; typing narrows it without a round trip.
        // The CRM's own lists are too long to hold, so those are asked again.
        renderSidebar()
        loadSubjects()
    }

    /// `mine` and `subjects` each own their half of the line; anything else —
    /// a failed write, a roster that would not load — replaces both, because
    /// it is about the whole window.
    private enum WorkStatusSource { case mine, subjects, window }

    /// Failures pass `tone: .danger` and read red with Copy; confirmations and
    /// progress stay neutral.
    private func setStatus(
        _ message: String?,
        from source: WorkStatusSource = .window,
        tone: StarlingsNoticeView.Tone = .neutral,
        retry: (() -> Void)? = nil
    ) {
        let entry = message.map { WorkStatus(text: $0, tone: tone, retry: retry) }
        switch source {
        case .mine: mineStatus = entry
        case .subjects: subjectsStatus = entry
        case .window:
            mineStatus = entry
            subjectsStatus = entry
        }
        let shown = [mineStatus, subjectsStatus].compactMap { $0 }.first
        statusLine.setText(shown?.text, tone: shown?.tone ?? .neutral)
        retryAction = shown?.retry
        retryButton.isHidden = retryAction == nil
        statusRow.isHidden = shown == nil
    }

    /// A failed refresh, worded so the list that is still on screen reads as
    /// what it is: "Couldn't load your work · Updated 4 minutes ago", with
    /// Retry. Without a date there is nothing on screen to be stale.
    private func setRefreshFailure(
        _ message: String,
        from source: WorkStatusSource,
        updatedAt: Date?,
        retry: @escaping () -> Void
    ) {
        let text = updatedAt.map { "\(message) · \(SnapshotStore.updatedLabel($0))" } ?? message
        setStatus(text, from: source, tone: .danger, retry: retry)
    }

    @objc private func retryStatus() {
        retryAction?()
    }

    @objc private func snapshotsDidInvalidate(_ notification: Notification) {
        guard let owner = (try? api.ownerSessionStore.load())?.owner.email,
              let prefixes = SnapshotStore.invalidatedPrefixes(in: notification, owner: owner)
        else { return }
        if SnapshotStore.matches(key: MeetingControlAPI.mineSnapshotKey, prefixes: prefixes) {
            loadMine()
        }
        if SnapshotStore.matches(key: MeetingControlAPI.inboxSnapshotKey, prefixes: prefixes) {
            loadInbox()
        }
        if SnapshotStore.matches(key: MeetingControlAPI.subjectsSnapshotPrefix, prefixes: prefixes) {
            loadSubjects(debounced: false, refreshCounts: true)
        }
    }

    // MARK: - Loading

    private func reload() {
        loadSubjectState()
        loadInbox()
        loadTodayMeetings()
        loadMine()
        loadSubjects(debounced: false, refreshCounts: true)
    }

    @objc private func ownerSessionDidExpire() {
        reload()
    }

    /// The store changed under the window — from Settings > Work, or from
    /// this window's own menu, which is the same store. Read it back and
    /// redraw; the SALES gate is the Worker's, so ask it again too.
    @objc private func sidebarPreferencesDidChange() {
        guard isViewLoaded else { return }
        sidebarOrder = WorkSidebarPreferences.order()
        mineFilter = WorkSidebarPreferences.mineFilter()
        inboxFilter = WorkSidebarPreferences.inboxFilter()
        applySidebarLayout()
        renderSidebar()
        loadSubjectState()
    }

    /// Everything on your plate, in one list. No paging and no cut-off: this
    /// is one person's work, and a list of it that stops short is worse than
    /// no list at all.
    private func loadMine() {
        mineTask?.cancel()
        // Last known first (docs/CACHING.md): the list paints from its
        // snapshot before the request goes out, so a cold window is never a
        // blank MINE while Core answers.
        if mine.isEmpty, myIssues.isEmpty,
           let cached = api.snapshot(MeetingControlAPI.mineSnapshotKey, as: CrmMyWorkResponse.self) {
            mine = cached.value.tasks
            myIssues = cached.value.issues
            githubLogin = cached.value.githubLogin
            mineUpdatedAt = cached.savedAt
            renderSidebar()
        }
        mineTask = Task { [weak self] in
            guard let self else { return }
            do {
                let work = try await api.crmMyWork()
                guard !Task.isCancelled else { return }
                mine = work.tasks
                myIssues = work.issues
                githubLogin = work.githubLogin
                mineUpdatedAt = Date()
                setStatus(nil, from: .mine)
                renderSidebar()
                loadRecentlyClosed()
                loadUnowned()
            } catch {
                guard !Task.isCancelled else { return }
                // A failed refresh keeps the last snapshot on screen and says
                // so — with its age and Retry; only a list with nothing to
                // show goes empty.
                setRefreshFailure(
                    (error as? StarlingsError)?.message ?? String(localized: "Couldn’t load your work"),
                    from: .mine,
                    updatedAt: mine.isEmpty && myIssues.isEmpty ? nil : mineUpdatedAt
                ) { [weak self] in self?.loadMine() }
                renderSidebar()
            }
        }
    }

    /// The server applies the shared one-week Work window and member filter;
    /// keep this separate from Mine's open-work snapshot.
    private func loadRecentlyClosed() {
        recentlyClosedTask?.cancel()
        recentlyClosedTask = Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await api.crmRecentlyClosedWork()
                guard !Task.isCancelled else { return }
                recentlyClosed = response.items
                recentlyClosedError = nil
            } catch {
                guard !Task.isCancelled else { return }
                recentlyClosedError = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t load recently finished work")
            }
            renderSidebar()
        }
    }

    /// Rides on every Mine refresh: whatever a write did to Mine — assigning,
    /// completing, filing — it may also have done to UNOWNED.
    private func loadUnowned() {
        unownedTask?.cancel()
        unownedTask = Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await api.crmUnownedWork()
                guard !Task.isCancelled else { return }
                unowned = response
                unownedError = nil
            } catch {
                guard !Task.isCancelled else { return }
                unownedError = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t load unowned work")
            }
            renderSidebar()
        }
    }

    // MARK: - Quick Notes and sales touches

    /// One Quick Notes row: a click opens it in the inspector to file, and the
    /// menu copies or deletes it.
    private func quickNoteRow(
        _ note: QuickNote,
        actions: [[WorkRowAction]],
        isSelected: Bool = false
    ) -> NSView {
        let subtitle = note.detailLabel
        return WorkSidebarRowView(
            leading: .glyph(systemSymbolName: "pencil", accessibilityLabel: String(localized: "Quick Note")),
            leadingShape: .square,
            title: note.firstLine,
            subtitle: subtitle,
            isSelected: isSelected,
            isSubdued: !note.isOpen,
            accessibilityLabel: note.isOpen
                ? String(localized: "\(note.firstLine). \(subtitle). File this note.")
                : "\(note.firstLine). \(subtitle).",
            onSelect: { [weak self] in
                guard note.isOpen else { return }
                self?.triageQuickNote(note)
            },
            menuProvider: { [weak self] in NSMenu.workRow(actions) { self?.performRowAction($0) } }
        )
    }

    /// Capture from Work: the same one field Home offers, as a sheet so the
    /// rail stays a list. Filing is a second, separate step on purpose.
    @objc private func captureQuickNote() {
        let alert = NSAlert()
        alert.messageText = String(localized: "New Quick Note")
        alert.informativeText = String(localized: "Capture now, file later.")
        alert.addButton(withTitle: String(localized: "Add"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
        field.placeholderString = String(localized: "What should you remember?")
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        guard let window = view.window else { return }
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            let body = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !body.isEmpty else { return }
            Task { [weak self] in
                guard let self else { return }
                do {
                    // A client id: a repeat of this create finds
                    // the note the first one made.
                    _ = try await api.createQuickNote(QuickNotePending(body: body, source: .work).create)
                    loadInbox()
                } catch {
                    setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t save that note"), from: .subjects, tone: .danger)
                }
            }
        }
    }

    /// A note opens in the inspector, the way a task or an issue does; the
    /// filing form is the column's until it is filed or left.
    private func triageQuickNote(_ note: QuickNote) {
        inspect(.quickNote(note))
    }

    private func deleteQuickNote(_ note: QuickNote) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await api.deleteQuickNote(id: note.id)
                loadInbox()
            } catch {
                setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t delete that note"), from: .subjects, tone: .danger)
            }
        }
    }

    private func loadSubjects(debounced: Bool = true, refreshCounts: Bool = false) {
        searchTask?.cancel()
        let wanted = query
        searchTask = Task { [weak self] in
            if debounced {
                // A beat of quiet before asking, so typing a project name is
                // one request rather than one per letter.
                try? await Task.sleep(for: .milliseconds(250))
            }
            guard let self, !Task.isCancelled else { return }
            // Last known first: each list paints from its own snapshot for
            // this exact query and filter, then the live read replaces it.
            if envisioningProjects.isEmpty, clientProjects.isEmpty, leads.isEmpty {
                let envisioningKey = MeetingControlAPI.subjectsSnapshotKey(kind: .project, query: wanted, status: envisioningStatusFilter)
                let clientKey = MeetingControlAPI.subjectsSnapshotKey(kind: .project, query: wanted, status: clientStatusFilter)
                let leadKey = MeetingControlAPI.subjectsSnapshotKey(kind: .lead, query: wanted, status: leadStatusFilter)
                if let envisioningCached = api.snapshot(envisioningKey, as: CrmSubjectsResponse.self),
                   let clientCached = api.snapshot(clientKey, as: CrmSubjectsResponse.self),
                   let leadCached = api.snapshot(leadKey, as: CrmSubjectsResponse.self) {
                    envisioningProjects = envisioningCached.value.subjects
                        .filter(\.isInternalProject)
                        .sorted(bySidebarOption: envisioningSortOption)
                    clientProjects = clientCached.value.subjects
                        .filter { !$0.isInternalProject }
                        .sorted(bySidebarOption: clientSortOption)
                    leads = leadCached.value.subjects.sorted(bySidebarOption: leadSortOption)
                    subjectsUpdatedAt = [envisioningCached, clientCached, leadCached].map(\.savedAt).min()
                    renderSidebar()
                }
            }
            do {
                // Envisioning and client projects are each the *whole* set of
                // projects at their own status filter — Core has no
                // internal/external flag to ask for one half directly, so both
                // halves fetch and then keep only their own rows. When the two
                // filters happen to match this duplicates a Core query; that is
                // an accepted tradeoff, the same one Projects and Sales already
                // make by always being two independent fetches.
                async let envisioningPage = api.crmSubjectPage(
                    kind: .project,
                    query: wanted,
                    status: envisioningStatusFilter
                )
                async let clientPage = api.crmSubjectPage(
                    kind: .project,
                    query: wanted,
                    status: clientStatusFilter
                )
                let signalsLeads = leadStatusFilter == CrmSubjectStatusOption.signalsLeads.id
                async let leadPage = api.crmSubjectPage(
                    kind: .lead,
                    query: wanted,
                    status: signalsLeads ? "all" : leadStatusFilter,
                    leadSource: signalsLeads ? "signals" : nil
                )
                let (envisioningFound, clientFound, prospects) = try await (envisioningPage, clientPage, leadPage)
                guard !Task.isCancelled else { return }
                envisioningProjects = envisioningFound.subjects
                    .filter(\.isInternalProject)
                    .sorted(bySidebarOption: envisioningSortOption)
                clientProjects = clientFound.subjects
                    .filter { !$0.isInternalProject }
                    .sorted(bySidebarOption: clientSortOption)
                leads = prospects.subjects.sorted(bySidebarOption: leadSortOption)
                subjectsUpdatedAt = Date()
                setStatus(nil, from: .subjects)
                renderSidebar()
                await loadPartners(query: wanted)
                await loadEvents(query: wanted)
            } catch {
                guard !Task.isCancelled else { return }
                // The snapshot painted above stays; the status line says the
                // refresh failed, how old the lists are, and offers Retry
                // rather than emptying three lists.
                let showing = !(envisioningProjects.isEmpty && clientProjects.isEmpty && leads.isEmpty)
                setRefreshFailure(
                    (error as? StarlingsError)?.message ?? String(localized: "Couldn’t search the CRM"),
                    from: .subjects,
                    updatedAt: showing ? subjectsUpdatedAt : nil
                ) { [weak self] in self?.loadSubjects(debounced: false, refreshCounts: true) }
                renderSidebar()
            }
        }

        // The visible page above answers the current filter. Keep facet work
        // separate, and only repeat it when the search changed or a refresh
        // followed a subject mutation; changing from one status to another
        // does not make every other category's count change.
        if refreshCounts || statusCountsQuery != wanted {
            statusCountTask?.cancel()
            statusCountsQuery = wanted
            envisioningSection.setFilterCounts([:], loading: true)
            projectsSection.setFilterCounts([:], loading: true)
            salesSection.setFilterCounts([:], loading: true)
            statusCountTask = Task { [weak self] in
                if debounced {
                    // Keep typing a project name to one facet pass, just like
                    // the visible subject list.
                    try? await Task.sleep(for: .milliseconds(250))
                }
                guard let self, !Task.isCancelled else { return }
                // One request per kind. The project badges ignore `wanted`:
                // Core's `q` has no documented way to AND two terms, and the
                // rows shown are always filtered by the exact client-side
                // predicate against subjects Meet already fetched, so a badge
                // is never what decides a row. Sales follows the search box.
                // The Envisioning / client split is Core's `is_internal`
                // flag, answered in the same body (docs/WORK.md).
                async let projectCounts = try? api.crmSubjectCounts(kind: .project, query: "")
                async let leadCounts = try? api.crmSubjectCounts(kind: .lead, query: wanted)
                let (projects, leads) = await (projectCounts, leadCounts)
                guard !Task.isCancelled else { return }
                // A count that failed leaves the header plain rather than wrong.
                envisioningSection.setFilterCounts(projects?.internalBadges ?? [:])
                projectsSection.setFilterCounts(projects?.clientBadges ?? [:])
                salesSection.setFilterCounts(leads?.leadBadges ?? [:])
            }
        }
    }

    private func envisioningStatusFilterChanged(_ value: String) {
        guard value != envisioningStatusFilter else { return }
        envisioningStatusFilter = value
        WorkSidebarPreferences.setFilter(value, for: "work.envisioning")
        loadSubjects(debounced: false)
    }

    private func clientStatusFilterChanged(_ value: String) {
        guard value != clientStatusFilter else { return }
        clientStatusFilter = value
        WorkSidebarPreferences.setFilter(value, for: "work.projects")
        loadSubjects(debounced: false)
    }

    private func leadStatusFilterChanged(_ value: String) {
        guard value != leadStatusFilter else { return }
        leadStatusFilter = value
        WorkSidebarPreferences.setFilter(value, for: "work.leads")
        loadSubjects(debounced: false)
    }

    /// A sort choice is a pure client-side reorder of data already fetched —
    /// unlike a status filter, it never needs to ask Core again.
    private func envisioningSortChanged(_ value: String) {
        guard value != envisioningSortOption else { return }
        envisioningSortOption = value
        WorkSidebarPreferences.setSort(value, for: "work.envisioning")
        envisioningProjects = envisioningProjects.sorted(bySidebarOption: value)
        renderEnvisioningProjects()
    }

    private func clientSortChanged(_ value: String) {
        guard value != clientSortOption else { return }
        clientSortOption = value
        WorkSidebarPreferences.setSort(value, for: "work.projects")
        clientProjects = clientProjects.sorted(bySidebarOption: value)
        renderProjects()
    }

    private func leadSortChanged(_ value: String) {
        guard value != leadSortOption else { return }
        leadSortOption = value
        WorkSidebarPreferences.setSort(value, for: "work.leads")
        leads = leads.sorted(bySidebarOption: value)
        renderLeads()
    }

    // MARK: - The card board

    /// The card board over the column. Kept without a door; the
    /// OVERVIEW row stays lit here, because the board is Work's home read
    /// another way.
    private func showCards() {
        guard focus != .cards else { showOverview(); return }
        detailTask?.cancel()
        itemDetail.clear()
        leaveSubject()
        focus = .cards
        cardBoard.setAgents(roster.agents)
        showInspectorInfo(cardsInfo())
        applySidebarSelection()
        applyPane()
        loadCards()
    }

    /// The board is on screen: the company-wide one, or a project's Board pane.
    private var boardIsUp: Bool {
        focus == .cards || (selected?.kind == "project" && selectedPane == .board)
    }

    /// The project the board is scoped to; nil for the company-wide board.
    private var boardProjectID: String? {
        focus == .cards ? nil : selected?.id
    }

    /// One read; the Worker does the fan-out, or reads the one project. The
    /// columns stay up while it runs, so a re-read after a drop never blanks
    /// what is on screen. Once it has landed the read schedules the next one,
    /// for as long as the board is the thing on screen; `applyPane` cancels
    /// it the moment it is not, and `windowDidOpen` starts it again.
    private func loadCards() {
        cardsTask?.cancel()
        let api = api
        let projectID = boardProjectID
        // Another project's cards must not stand in for this one's.
        if projectID != cardBoardProjectID {
            cardBoard.clear()
            cardBoardProjectID = projectID
        }
        cardBoard.setScopedToProject(projectID != nil)
        cardBoard.setMessage(nil)
        cardBoard.setLoading()
        cardsTask = Task { [weak self] in
            do {
                let response = try await api.crmBoard(projectID: projectID)
                guard let self, !Task.isCancelled, boardProjectID == projectID else { return }
                cardBoard.setAgents(roster.agents)
                cardBoard.setBoard(response)
            } catch {
                guard let self, !Task.isCancelled else { return }
                cardBoard.setMessage((error as? StarlingsError)?.message ?? String(localized: "Couldn’t load the board"))
            }
            try? await Task.sleep(for: Self.cardsRefreshInterval)
            guard let self, !Task.isCancelled, boardIsUp, view.window != nil else { return }
            loadCards()
        }
    }

    /// A card was dropped into another column. The card moves first and the
    /// write follows, through the same `writeStage` the fixture pins — and a
    /// refusal puts it back rather than leaving the board lying.
    private func moveCard(_ card: BoardCard, to stage: WorkStage) {
        let previous = cardBoard.stage(of: card) ?? WorkItems.stage(of: card)
        Task { [weak self] in
            guard let self else { return }
            do {
                switch WorkItems.write(stage, for: card) {
                case .task(let status):
                    _ = try await api.updateCrmTask(
                        id: card.workID,
                        update: .stage(status)
                    )
                case .issue(let state, let stateReason, let labels):
                    guard let issue = card.issue else { return }
                    // The card carries its own subject, so the move is
                    // reported to the project the card is on.
                    _ = try await api.updateCrmIssue(.stageMove(
                        issue,
                        projectID: card.subject?.kind == "project" ? card.subject?.id : nil,
                        state: state,
                        stateReason: stateReason,
                        labels: labels
                    ))
                }
                setStatus(nil, from: .subjects)
                work.refreshNow()
                // Out of an agent's hands: the label is the person's now, and
                // the runtime has to be told to stop, or the board would say
                // one thing while a sandbox goes on building the other.
                if previous == .doing, stage != .doing, card.isHeldByAgent {
                    await tellAgentToStop(card)
                }
                loadCards()
            } catch {
                cardBoard.move(card, to: previous)
                setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t move that card"), from: .subjects, tone: .danger)
            }
        }
    }

    /// The Board columns this person hides, on every project and device
    ///. The board already shows the change; a refusal puts the
    /// columns back.
    private func setBoardHiddenStages(_ stages: Set<WorkStage>) {
        let before = subjectState
        subjectState = before.with(boardHiddenStages: stages)
        Task { [weak self] in
            guard let self else { return }
            do {
                applySubjectState(try await api.crmSetWorkPreferences(boardHiddenStages: stages))
            } catch {
                applySubjectState(before)
                setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t change the board"), from: .subjects, tone: .danger)
            }
        }
    }

    /// The card moved; now the runtime. Honest about the two ways this can
    /// fall short: a project that names no agent, and an agent with no
    /// runtime to tell. Either way the label already moved.
    private func tellAgentToStop(_ card: BoardCard) async {
        guard let agentEmail = card.subject?.agentEmail else {
            setStatus(String(localized: "Moved. Couldn’t tell the agent to stop: this project names no agent."), from: .subjects, tone: .danger)
            return
        }
        do {
            switch try await api.cancelAgent(email: agentEmail, ref: card.ref) {
            case .accepted:
                StarlingsToast.show(String(localized: "Moved, and the agent was told to stop"), in: view.window)
            case .noRuntime:
                StarlingsToast.show(String(localized: "Moved · the agent has no runtime to tell"), in: view.window)
            case .failed:
                // The run may still be going. Moving the card again resends.
                setStatus(String(localized: "Moved, but the agent didn’t get the stop."), from: .subjects, tone: .danger)
            }
        } catch {
            setStatus(String(localized: "Moved, but the agent couldn’t be told to stop: \((error as? StarlingsError)?.message ?? "unknown error")"), from: .subjects, tone: .danger)
        }
    }

    /// Hand off: a Message to the agent carrying the card (docs/SURFACES.md),
    /// after the sheet asks what done looks like and what comes back
    ///. The runtime reads its ticket from the ref and the brief
    /// from `handoff`; the text repeats both for the person reading later.
    private func handOff(_ card: BoardCard, to agent: Peer) {
        handOff(HandOffTarget(
            title: card.title, issueNumber: card.issue?.number, ref: card.ref,
            subjectKind: card.subject?.kind, subjectID: card.subject?.id
        ), to: agent)
    }

    /// A Board card or a subject's task row: the same sheet and
    /// the same message.
    private func handOff(_ target: HandOffTarget, to agent: Peer) {
        HandOffSheet.present(over: view.window, cardTitle: target.title, agentName: agent.displayName) { [weak self] handoff in
            self?.send(target, to: agent, handoff: handoff)
        }
    }

    private func send(_ target: HandOffTarget, to agent: Peer, handoff: ThreadHandoff) {
        Task { [weak self] in
            guard let self else { return }
            do {
                let thread = if let kind = target.subjectKind, let id = target.subjectID {
                    try await api.openSubjectThread(kind: kind, subjectID: id)
                } else {
                    try await api.openThread(.peer(agent))
                }
                let line = HandOffText.cardLine(issueNumber: target.issueNumber, title: target.title)
                let text = HandOffSheet.messageText(card: line, handoff: handoff)
                _ = try await api.sendMessage(
                    threadID: thread.id,
                    text: target.inChannel ? HandOffText.addressed(text, to: agent.email) : text,
                    refs: [target.ref],
                    mentions: target.inChannel ? [agent.email] : [],
                    handoff: handoff
                )
                AgentAsks.record(agent)
                StarlingsToast.show(String(localized: "Handed off to \(agent.displayName)"), in: view.window)
            } catch {
                setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t hand that off"), from: .subjects, tone: .danger)
            }
        }
    }

    /// A card dropped on an agent's sidebar row. The token is what the card
    /// put on the pasteboard; the board resolves it, nothing else does.
    private func handOffToken(_ token: String, to agent: Peer) {
        guard let card = cardBoard.card(forToken: token) else { return }
        handOff(card, to: agent)
    }

    /// The card, in the inspector beside the board. One renderer for a task
    /// or an issue wherever it was clicked.
    private func inspectCard(_ card: BoardCard) {
        switch card.source {
        case .task(let task):
            inspect(.task(
                task,
                canFile: card.subject?.kind == "project" && (card.subject?.hasRepo ?? false) && task.githubIssueNumber == nil,
                subject: card.subject
            ))
        case .issue(let issue):
            inspect(.issue(issue))
        }
    }

    /// The card's last event line, in its channel. The subject opens on Talk
    /// and the pane scrolls to the line once the page carrying it lands.
    private func openTrace(of card: BoardCard) {
        guard let trace = card.trace else { return }
        if let subject = card.subject {
            select(subject, pane: .talk)
        } else {
            return
        }
        threadPane.reveal(messageID: trace.messageID)
    }

    /// A ref chip in a transcript. A task is looked for in what is already in
    /// hand — the subject's list, then the board — and read from Core when it
    /// is not. An issue is read by its reference.
    private func openRef(_ ref: ThreadMessageRef) {
        switch ref.kind.rawValue {
        case "task":
            if let task = loadedTasks.first(where: { $0.id == ref.id }) {
                inspect(.task(task, canFile: canFile(task), subject: selected))
                return
            }
            if let card = cardBoard.card(forToken: "task:\(ref.id)") {
                inspectCard(card)
                return
            }
            guard let subject = selected else {
                setStatus(String(localized: "Open the project or lead first to read that task."), from: .subjects)
                return
            }
            Task { [weak self] in
                guard let self else { return }
                let tasks = try? await api.crmTasks(
                    projectID: subject.kind == "project" ? subject.id : nil,
                    leadID: subject.kind == "lead" ? subject.id : nil,
                    eventID: subject.kind == "event" ? subject.id : nil,
                    organizationID: subject.kind == "organization" ? subject.id : nil
                )
                guard let task = tasks?.first(where: { $0.id == ref.id }) else {
                    setStatus(String(localized: "That task is not on this subject any more."), from: .subjects)
                    return
                }
                inspect(.task(task, canFile: canFile(task), subject: subject))
            }
        case "issue":
            let parts = ref.id.split(separator: "#")
            guard parts.count == 2, let number = Int(parts[1]) else { return }
            let slug = parts[0].split(separator: "/")
            guard slug.count == 2 else { return }
            if let issue = issues.first(where: { $0.id == ref.id }) {
                inspect(.issue(issue))
                return
            }
            Task { [weak self] in
                guard let self else { return }
                do {
                    let detail = try await api.crmIssue(owner: String(slug[0]), repo: String(slug[1]), number: number)
                    inspect(.issue(detail.issue))
                } catch {
                    setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t open that issue"), from: .subjects, tone: .danger)
                }
            }
        case "pull", "commit", "run", "release":
            // No sheet for these; github.com is the depth.
            if let url = ref.githubURL { NSWorkspace.shared.open(url) }
        // A decision reads in History, a goal on Tasks — where the web sends
        // the same chip (#262).
        case "decision":
            selectPane(.interactions)
        case "goal":
            selectPane(.tasks)
        default:
            break
        }
    }

    // MARK: - The sidebar

    /// Every block Work can put on the rail, in the order it ships in. What
    /// is actually on the rail, and where, is `sidebarOrder`.
    private var allSections: [SidebarSection] {
        [subjectsSection]
    }

    /// The Browse view's groups, in the order they stack.
    private var browseSections: [SidebarSection] {
        [envisioningSection, projectsSection, partnersSection, contactsSection, eventsSection, salesSection, offersSection, licensesSection]
    }

    private func section(for key: String) -> SidebarSection? {
        allSections.first { $0.sectionKey == key }
    }

    /// The one group by which the SUBJECTS zone reaches a section, and back.
    private func section(for group: SubjectGroup) -> SidebarSection {
        switch group {
        case .envisioning: envisioningSection
        case .clients: projectsSection
        case .partners: partnersSection
        case .events: eventsSection
        case .sales: salesSection
        }
    }

    /// Every block is always available; hiding is a local choice. (SALES is
    /// not a block any more: it is on Browse for the people who have Sales
    /// on, the Worker's `sales_enabled`.)
    /// A rail block is offered unless it is a subject group whose work
    /// module is off for this workspace (docs/WORK_MODEL.md).
    private func sectionIsAvailable(_ key: String) -> Bool {
        guard let group = BrowseGroupRegistry.order.first(where: { BrowseGroupRegistry.spec(for: $0).preferenceKey == key }) else { return true }
        return BrowseGroupRegistry.isKindShown(group, state: subjectState)
    }

    /// Rebuild the rail from the owner's arrangement. Sections are re-added
    /// rather than reordered in place: a stack view's arranged list and the
    /// width constraints hung off it come and go together, and one stale
    /// constraint left over from an old position is a rail that cannot lay
    /// itself out. The SEARCH tail is always last and never arranged.
    private func applySidebarLayout() {
        let hidden = WorkSidebarPreferences.hidden()
        overviewRow.removeFromSuperview()
        for section in allSections + [searchSection] {
            section.removeFromSuperview()
        }
        // The way home, above everything and never arranged away.
        subjectStack.addArrangedSubview(overviewRow)
        overviewRow.widthAnchor.constraint(equalTo: subjectStack.widthAnchor).isActive = true
        catalogRow.removeFromSuperview()
        if subjectState.workModules?.contains(.offers) == true, OfferAvailability.isEditableHere {
            subjectStack.addArrangedSubview(catalogRow)
            catalogRow.widthAnchor.constraint(equalTo: subjectStack.widthAnchor).isActive = true
        }
        for key in sidebarOrder {
            guard let section = section(for: key) else { continue }
            section.isOnRail = sectionIsAvailable(key) && !hidden.contains(key)
            subjectStack.addArrangedSubview(section)
            section.widthAnchor.constraint(equalTo: subjectStack.widthAnchor).isActive = true
        }
        subjectStack.addArrangedSubview(searchSection)
        searchSection.widthAnchor.constraint(equalTo: subjectStack.widthAnchor).isActive = true
        salesSection.isOnRail = BrowseGroupRegistry.isShown(.sales, salesEnabled: subjectState.salesEnabled, workModules: subjectState.workModules)
        subjectScroll.reflectScrolledClipView(subjectScroll.contentView)
    }

    /// What the rail offers about itself: put this block away, move it, bring
    /// another one back, or start over. Built fresh on every click so the
    /// ticks and the disabled ends are the truth at that moment.
    private func sidebarMenu(for key: String?) -> NSMenu {
        let menu = NSMenu()
        populateSidebarMenu(menu, for: key)
        return menu
    }

    private func populateSidebarMenu(_ menu: NSMenu, for key: String?) {
        menu.removeAllItems()
        menu.autoenablesItems = false
        let hidden = WorkSidebarPreferences.hidden()
        let visible = sidebarOrder.filter { !hidden.contains($0) && sectionIsAvailable($0) }
        // SALES stays in the catalog whether or not it is on, because the
        // menu is where it is turned on.
        let catalog = WorkSidebarPreferences.catalog
        if let key, let spec = catalog.first(where: { $0.key == key }) {
            let name = spec.title.capitalized
            let hide = NSMenuItem(
                title: String(localized: "Hide \(name)"),
                action: #selector(hideSidebarSection(_:)),
                keyEquivalent: ""
            )
            hide.target = self
            hide.representedObject = key
            menu.addItem(hide)
            menu.addItem(.separator())
            let position = visible.firstIndex(of: key)
            let up = NSMenuItem(
                title: String(localized: "Move Up"),
                action: #selector(moveSidebarSectionUp(_:)),
                keyEquivalent: ""
            )
            up.target = self
            up.representedObject = key
            up.isEnabled = (position ?? 0) > 0
            menu.addItem(up)
            let down = NSMenuItem(
                title: String(localized: "Move Down"),
                action: #selector(moveSidebarSectionDown(_:)),
                keyEquivalent: ""
            )
            down.target = self
            down.representedObject = key
            down.isEnabled = position.map { $0 < visible.count - 1 } ?? false
            menu.addItem(down)
            menu.addItem(.separator())
        }
        let sections = NSMenuItem(title: String(localized: "Sections"), action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        submenu.autoenablesItems = false
        for spec in catalog {
            let item = NSMenuItem(
                title: spec.title.capitalized,
                action: #selector(toggleSidebarSection(_:)),
                keyEquivalent: ""
            )
            item.target = self
            item.representedObject = spec.key
            item.state = hidden.contains(spec.key) || !sectionIsAvailable(spec.key) ? .off : .on
            item.isEnabled = true
            submenu.addItem(item)
        }
        sections.submenu = submenu
        sections.isEnabled = true
        menu.addItem(sections)
        menu.addItem(.separator())
        let reset = NSMenuItem(
            title: String(localized: "Reset Sidebar"),
            action: #selector(resetSidebarLayout),
            keyEquivalent: ""
        )
        reset.target = self
        menu.addItem(reset)
    }

    /// The rail's background menu, refilled every time it opens.
    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === subjectStack.menu else { return }
        populateSidebarMenu(menu, for: nil)
    }

    @objc private func hideSidebarSection(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        WorkSidebarPreferences.setVisible(false, for: key)
        applySidebarLayout()
    }

    @objc private func toggleSidebarSection(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        WorkSidebarPreferences.setVisible(!WorkSidebarPreferences.isVisible(key), for: key)
        applySidebarLayout()
    }

    /// The SALES opt-in is the Worker's, so it follows the person to every
    /// Mac and decides what INBOX carries too. Settings > Work is the
    /// switch; filing a lead flips it on. The local visibility flag under
    /// `work.leads` is set alongside for Settings' own row state.
    private func setSalesEnabled(_ enabled: Bool) {
        Task { [weak self] in
            guard let self else { return }
            do {
                applySubjectState(try await api.crmSetWorkPreferences(salesEnabled: enabled))
                // After the Worker has it, so the re-read the notification
                // triggers cannot answer with the old value.
                WorkSidebarPreferences.setVisible(enabled, for: salesSection.sectionKey)
                applySidebarLayout()
                renderSidebar()
                loadInbox()
            } catch {
                setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t change Sales"), tone: .danger)
            }
        }
    }

    // MARK: - The INBOX and MINE filter menus

    @objc private func showMineFilterMenu(_ sender: NSButton) {
        let menu = NSMenu()
        let counted = WorkItems.planMine(
            tasks: mine, issues: myIssues,
            query: query.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        let dueTitle = NSMenuItem(title: String(localized: "Due"), action: nil, keyEquivalent: "")
        dueTitle.isEnabled = false
        menu.addItem(dueTitle)
        for section in MineSectionFilter.allCases {
            let item = NSMenuItem(title: "\(section.title) (\(counted.count(matching: MineFilter(section: section, origin: mineFilter.origin))))", action: #selector(chooseMineSectionFilter(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = section.rawValue
            item.state = !mineShowsFinished && section == mineFilter.section ? .on : .off
            item.indentationLevel = 1
            menu.addItem(item)
        }
        // The last week's finished work, in place of the open list: the
        // web's Due menu has the same choice.
        let finished = NSMenuItem(title: String(localized: "Recently finished (\(finishedCount(origin: mineFilter.origin)))"), action: #selector(chooseMineFinished), keyEquivalent: "")
        finished.target = self
        finished.state = mineShowsFinished ? .on : .off
        finished.indentationLevel = 1
        menu.addItem(finished)
        menu.addItem(.separator())
        let typeTitle = NSMenuItem(title: String(localized: "Type"), action: nil, keyEquivalent: "")
        typeTitle.isEnabled = false
        menu.addItem(typeTitle)
        for origin in MineOriginFilter.allCases {
            let originCount = mineShowsFinished
                ? finishedCount(origin: origin)
                : counted.count(matching: MineFilter(section: mineFilter.section, origin: origin))
            let item = NSMenuItem(title: "\(origin.title) (\(originCount))", action: #selector(chooseMineOriginFilter(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = origin.rawValue
            item.state = origin == mineFilter.origin ? .on : .off
            item.indentationLevel = 1
            menu.addItem(item)
        }
        if !mineFilter.isDefault || mineShowsFinished {
            menu.addItem(.separator())
            let reset = NSMenuItem(title: String(localized: "Reset"), action: #selector(resetMineFilter), keyEquivalent: "").symbol(.reset)
            reset.target = self
            menu.addItem(reset)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
    }

    @objc private func chooseMineSectionFilter(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let section = MineSectionFilter(rawValue: raw) else { return }
        mineShowsFinished = false
        mineFilter.section = section
        WorkSidebarPreferences.setMineFilter(mineFilter)
        renderSidebar()
    }

    @objc private func chooseMineOriginFilter(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let origin = MineOriginFilter(rawValue: raw) else { return }
        mineFilter.origin = origin
        WorkSidebarPreferences.setMineFilter(mineFilter)
        renderSidebar()
    }

    @objc private func chooseMineFinished() {
        mineShowsFinished = true
        renderSidebar()
    }

    /// Recently finished rows of one type, for the count beside a menu row.
    private func finishedCount(origin: MineOriginFilter) -> Int {
        recentlyClosed.filter { origin == .all || $0.kind.rawValue == origin.rawValue }.count
    }

    @objc private func showUnownedFilterMenu(_ sender: NSButton) {
        let menu = NSMenu()
        let all = WorkItems.planMine(
            tasks: unowned?.tasks ?? [], issues: unowned?.issues ?? [],
            query: query.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        let issueSubjects = unowned?.issueSubjects ?? [:]
        // Hidden subjects count nowhere; the Subjects group below lists them so they can come back.
        let counted = UnownedSubjects.shown(all, hidden: unownedHiddenSubjects, issueSubjects: issueSubjects)
        let typeTitle = NSMenuItem(title: String(localized: "Type"), action: nil, keyEquivalent: "")
        typeTitle.isEnabled = false
        menu.addItem(typeTitle)
        for origin in MineOriginFilter.allCases {
            let item = NSMenuItem(title: "\(origin.title) (\(counted.count(matching: MineFilter(section: .all, origin: origin))))", action: #selector(chooseUnownedOrigin(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = origin.rawValue
            item.state = origin == unownedOrigin ? .on : .off
            item.indentationLevel = 1
            menu.addItem(item)
        }
        let subjects = UnownedSubjects.choices(all, origin: unownedOrigin, issueSubjects: issueSubjects)
        if !subjects.isEmpty {
            menu.addItem(.separator())
            let subjectsTitle = NSMenuItem(title: String(localized: "Subjects"), action: nil, keyEquivalent: "")
            subjectsTitle.isEnabled = false
            menu.addItem(subjectsTitle)
            for subject in subjects {
                let item = NSMenuItem(title: "\(subject.title) (\(subject.count))", action: #selector(toggleUnownedSubject(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = subject.key
                item.state = unownedHiddenSubjects.contains(subject.key) ? .off : .on
                item.indentationLevel = 1
                menu.addItem(item)
            }
        }
        if !unownedHiddenSubjects.isEmpty {
            menu.addItem(.separator())
            let showAll = NSMenuItem(title: String(localized: "Show all subjects"), action: #selector(showAllUnownedSubjects), keyEquivalent: "").symbol(.reset)
            showAll.target = self
            menu.addItem(showAll)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
    }

    @objc private func toggleUnownedSubject(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        if unownedHiddenSubjects.remove(key) == nil { unownedHiddenSubjects.insert(key) }
        WorkSidebarPreferences.setUnownedHiddenSubjects(unownedHiddenSubjects)
        renderSidebar()
    }

    @objc private func showAllUnownedSubjects() {
        unownedHiddenSubjects = []
        WorkSidebarPreferences.setUnownedHiddenSubjects(unownedHiddenSubjects)
        renderSidebar()
    }

    @objc private func chooseUnownedOrigin(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let origin = MineOriginFilter(rawValue: raw) else { return }
        unownedOrigin = origin
        WorkSidebarPreferences.setUnownedOrigin(origin)
        renderSidebar()
    }

    @objc private func resetMineFilter() {
        mineShowsFinished = false
        mineFilter = .default
        WorkSidebarPreferences.setMineFilter(mineFilter)
        renderSidebar()
    }

    @objc private func showInboxFilterMenu(_ sender: NSButton) {
        let menu = NSMenu()
        let present = Set(inbox.items.map(\.filterSource))
        let sources = InboxFilterSource.allCases.filter { $0 != .note && ($0 == .all || present.contains($0) || $0 == inboxFilter) }
        for source in sources {
            let item = NSMenuItem(title: source.title, action: #selector(chooseInboxFilter(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = source.rawValue
            item.state = source == inboxFilter ? .on : .off
            menu.addItem(item)
        }
        if !inboxFilter.isDefault {
            menu.addItem(.separator())
            let reset = NSMenuItem(title: String(localized: "Reset"), action: #selector(resetInboxFilter), keyEquivalent: "").symbol(.reset)
            reset.target = self
            menu.addItem(reset)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
    }

    /// Core's organization list filters: Partner, Agency and
    /// Existing client turn on and off; Industry and Country pick one value
    /// from what the organizations carry.
    @objc private func showOrganizationFilterMenu(_ sender: NSButton) {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let flags: [(String, String, Bool)] = [
            ("partner", String(localized: "Partner"), organizationFilter.partner),
            ("agency", String(localized: "Agency"), organizationFilter.agency),
            ("existingClient", String(localized: "Existing client"), organizationFilter.existingClient),
        ]
        for (key, title, on) in flags {
            let item = NSMenuItem(title: title, action: #selector(toggleOrganizationFlag(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = key
            item.state = on ? .on : .off
            menu.addItem(item)
        }
        let industries = organizationFacets?.industries ?? []
        let countries = organizationFacets?.countries ?? []
        if !industries.isEmpty || !countries.isEmpty { menu.addItem(.separator()) }
        if !industries.isEmpty {
            menu.addItem(organizationChoiceItem(title: String(localized: "Industry"), field: "industry", chosen: organizationFilter.industry, options: industries))
        }
        if !countries.isEmpty {
            menu.addItem(organizationChoiceItem(title: String(localized: "Country"), field: "country", chosen: organizationFilter.country, options: countries))
        }
        if !organizationFilter.isDefault {
            menu.addItem(.separator())
            let reset = NSMenuItem(title: String(localized: "Reset"), action: #selector(resetOrganizationFilter), keyEquivalent: "").symbol(.reset)
            reset.target = self
            menu.addItem(reset)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
    }

    /// Industry ▸ or Country ▸: Any, then every value. The title names the chosen one.
    private func organizationChoiceItem(title: String, field: String, chosen: String?, options: [String]) -> NSMenuItem {
        let item = NSMenuItem(title: chosen.map { "\(title): \($0)" } ?? title, action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        for value in [nil] + options.map(Optional.some) {
            let option = NSMenuItem(title: value ?? String(localized: "Any"), action: #selector(chooseOrganizationValue(_:)), keyEquivalent: "")
            option.target = self
            option.representedObject = [field, value ?? ""]
            option.state = value == chosen ? .on : .off
            submenu.addItem(option)
        }
        item.submenu = submenu
        return item
    }

    @objc private func toggleOrganizationFlag(_ sender: NSMenuItem) {
        var next = organizationFilter
        switch sender.representedObject as? String {
        case "partner": next.partner.toggle()
        case "agency": next.agency.toggle()
        case "existingClient": next.existingClient.toggle()
        default: return
        }
        changeOrganizationFilter(next)
    }

    @objc private func chooseOrganizationValue(_ sender: NSMenuItem) {
        guard let pair = sender.representedObject as? [String], pair.count == 2 else { return }
        var next = organizationFilter
        let value = pair[1].isEmpty ? nil : pair[1]
        if pair[0] == "industry" { next.industry = value } else { next.country = value }
        changeOrganizationFilter(next)
    }

    @objc private func resetOrganizationFilter() {
        changeOrganizationFilter(.default)
    }

    private func changeOrganizationFilter(_ next: OrganizationListFilter) {
        guard next != organizationFilter else { return }
        organizationFilter = next
        next.save()
        organizationFilterButton.contentTintColor = next.isDefault ? StarlingsColors.secondaryText : StarlingsColors.accent
        Task { [weak self] in
            guard let self else { return }
            await loadPartners(query: query)
        }
    }

    // MARK: - The Contacts group

    /// Core's contact filters: Organization from a search, Country and
    /// Language from what the contacts carry, Partner and Existing client
    /// turn on and off, and the five Signals states.
    @objc private func showContactFilterMenu(_ sender: NSButton) {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.addItem(contactOrganizationItem())
        let countries = (contactFacets?.countries ?? []).sorted {
            ContactFieldText.country($0).localizedCaseInsensitiveCompare(ContactFieldText.country($1)) == .orderedAscending
        }
        if !countries.isEmpty {
            menu.addItem(contactChoiceItem(title: String(localized: "Country"), field: "country", chosen: contactFilter.country, options: countries, label: ContactFieldText.country))
        }
        menu.addItem(.separator())
        let flags: [(String, String, Bool)] = [
            ("partner", String(localized: "Partner"), contactFilter.partner),
            ("existingClient", String(localized: "Existing client"), contactFilter.existingClient),
        ]
        for (key, title, on) in flags {
            let item = NSMenuItem(title: title, action: #selector(toggleContactFlag(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = key
            item.state = on ? .on : .off
            menu.addItem(item)
        }
        menu.addItem(.separator())
        menu.addItem(contactChoiceItem(
            title: String(localized: "Signals status"),
            field: "status",
            chosen: contactFilter.signalsOutreachStatus?.rawValue,
            options: CrmContactsQuerySignalsOutreachStatus.known.map(\.rawValue),
            label: ContactFieldText.outreach
        ))
        let languages = contactFacets?.languages ?? []
        if !languages.isEmpty {
            menu.addItem(contactChoiceItem(title: String(localized: "Language"), field: "language", chosen: contactFilter.preferredLanguage, options: languages, label: ContactFieldText.language))
        }
        if !contactFilter.isDefault {
            menu.addItem(.separator())
            let reset = NSMenuItem(title: String(localized: "Reset"), action: #selector(resetContactFilter), keyEquivalent: "").symbol(.reset)
            reset.target = self
            menu.addItem(reset)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
    }

    /// Country ▸, Signals status ▸ or Language ▸: Any, then every value in
    /// its words. The title names the chosen one.
    private func contactChoiceItem(title: String, field: String, chosen: String?, options: [String], label: (String) -> String) -> NSMenuItem {
        let item = NSMenuItem(title: chosen.map { "\(title): \(label($0))" } ?? title, action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        for value in [nil] + options.map(Optional.some) {
            let option = NSMenuItem(title: value.map(label) ?? String(localized: "Any"), action: #selector(chooseContactValue(_:)), keyEquivalent: "")
            option.target = self
            option.representedObject = [field, value ?? ""]
            option.state = value == chosen ? .on : .off
            submenu.addItem(option)
        }
        item.submenu = submenu
        return item
    }

    /// Organization ▸: Any, the chosen one, and Choose… for a search. A
    /// workspace has too many organizations to list in a menu.
    private func contactOrganizationItem() -> NSMenuItem {
        let title = String(localized: "Organization")
        let chosenName = contactFilter.organizationName ?? title
        let item = NSMenuItem(title: contactFilter.organizationID == nil ? title : "\(title): \(chosenName)", action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        let any = NSMenuItem(title: String(localized: "Any"), action: #selector(chooseContactValue(_:)), keyEquivalent: "")
        any.target = self
        any.representedObject = ["organization", ""]
        any.state = contactFilter.organizationID == nil ? .on : .off
        submenu.addItem(any)
        if contactFilter.organizationID != nil {
            let current = NSMenuItem(title: chosenName, action: nil, keyEquivalent: "")
            current.state = .on
            submenu.addItem(current)
        }
        submenu.addItem(.separator())
        let choose = NSMenuItem(title: String(localized: "Choose…"), action: #selector(pickContactOrganization), keyEquivalent: "")
        choose.target = self
        submenu.addItem(choose)
        item.submenu = submenu
        return item
    }

    /// The organization for the filter, from the organization search the
    /// contact editor uses.
    @objc private func pickContactOrganization() {
        let picker = StarlingsSearchablePickerField(frame: .zero)
        var picked: StarlingsSearchablePickerOption?
        var shown: [StarlingsSearchablePickerOption] = []
        picker.setOptions([], placeholder: String(localized: "Search organizations"), selectedID: nil)
        let api = api
        picker.search = { query in
            let matches = (try? await api.crmOrganizations(matching: query)) ?? []
            shown = matches.map { StarlingsSearchablePickerOption(id: $0.id, title: $0.name) }
            return shown
        }
        let sheet = WorkFormSheet(
            heading: String(localized: "Filter by organization"),
            saveTitle: String(localized: "Filter"),
            rows: [.field(caption: String(localized: "Organization"), control: picker)],
            firstResponder: picker,
            canSave: { picked != nil },
            onSave: { [weak self] in
                guard let self, let picked else { return }
                var next = contactFilter
                next.organizationID = picked.id
                next.organizationName = picked.title
                changeContactFilter(next)
            }
        )
        picker.onSelection = { [weak sheet] id in
            picked = shown.first { $0.id == id }
            sheet?.refreshSaveAvailability()
        }
        sheet.run(over: view.window)
    }

    @objc private func toggleContactFlag(_ sender: NSMenuItem) {
        var next = contactFilter
        switch sender.representedObject as? String {
        case "partner": next.partner.toggle()
        case "existingClient": next.existingClient.toggle()
        default: return
        }
        changeContactFilter(next)
    }

    @objc private func chooseContactValue(_ sender: NSMenuItem) {
        guard let pair = sender.representedObject as? [String], pair.count == 2 else { return }
        var next = contactFilter
        let value = pair[1].isEmpty ? nil : pair[1]
        switch pair[0] {
        case "country": next.country = value
        case "status": next.signalsOutreachStatus = value.map { CrmContactsQuerySignalsOutreachStatus(rawValue: $0) }
        case "language": next.preferredLanguage = value
        case "organization":
            next.organizationID = nil
            next.organizationName = nil
        default: return
        }
        changeContactFilter(next)
    }

    @objc private func resetContactFilter() {
        changeContactFilter(.default)
    }

    private func changeContactFilter(_ next: ContactListFilter) {
        guard next != contactFilter else { return }
        contactFilter = next
        next.save()
        contactFilterButton.contentTintColor = next.isDefault ? StarlingsColors.secondaryText : StarlingsColors.accent
        loadContacts()
    }

    @objc private func contactSearchChanged() {
        guard contactSearchField.stringValue != contactQuery else { return }
        contactQuery = contactSearchField.stringValue
        loadContacts(debounced: true)
    }

    /// One page of contacts for the search and the filter. A search waits
    /// for a pause in typing; a filter reads at once. A newer read cancels
    /// the one before it.
    private func loadContacts(debounced: Bool = false) {
        guard BrowseGroupRegistry.isKindShown(.partners, state: subjectState) else { return }
        contactLoad?.cancel()
        let query = contactQuery
        let filter = contactFilter
        contactLoad = Task { [weak self] in
            if debounced, ContactListFilter.trimmed(query) != nil {
                try? await Task.sleep(for: .milliseconds(250))
            }
            guard let self, !Task.isCancelled else { return }
            do {
                let page = try await api.crmContactList(query: query, filter: filter)
                guard !Task.isCancelled else { return }
                contactPage = page
                contactError = nil
                if let facets = page.facets { contactFacets = facets }
            } catch {
                guard !Task.isCancelled else { return }
                contactError = error
            }
            browseScroll.preservingScrollOffset { renderContacts() }
        }
    }

    private func configureBrowseRecords() {
        offersSection.setFilter(
            options: [CrmSubjectStatusOption(id: "any", title: String(localized: "All statuses"))]
                + OfferValues.statuses.map { CrmSubjectStatusOption(id: $0, title: OfferValues.statusLabel($0) ?? $0) },
            selectedID: offerStatusFilter
        ) { [weak self] value in
            guard let self, value != offerStatusFilter else { return }
            offerStatusFilter = value
            WorkSidebarPreferences.setFilter(value, for: BrowseRecordGroupRegistry.offers.preferenceKey)
            loadBrowseRecords()
        }
        licensesSection.setFilter(options: BrowseLicenseFilter.options, selectedID: licenseFilter) { [weak self] value in
            guard let self, value != licenseFilter else { return }
            licenseFilter = value
            WorkSidebarPreferences.setFilter(value, for: BrowseRecordGroupRegistry.licenses.preferenceKey)
            loadBrowseRecords()
        }
    }

    /// Reads both groups: each shows while its work module is on.
    private func loadBrowseRecords() {
        browseOffers = nil
        browseLicenses = nil
        renderBrowseRecords()
        let status = offerStatusFilter == "any" ? nil : offerStatusFilter
        let parts = licenseFilter.split(separator: ":").map(String.init)
        let product = parts.first == "any" ? nil : parts.first
        let active: Bool? = parts.count > 1 ? parts[1] == "active" : nil
        Task { [api, weak self] in
            do {
                let found = try await api.offers(status: status)
                self?.browseOffers = found
                self?.browseOffersError = nil
            } catch {
                self?.browseOffers = []
                self?.browseOffersError = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t load offers.")
            }
            do {
                let found = try await api.licenses(product: product, active: active)
                self?.browseLicenses = found
                self?.browseLicensesError = nil
            } catch {
                self?.browseLicenses = []
                self?.browseLicensesError = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t load licenses.")
            }
            self?.browseScroll.preservingScrollOffset { self?.renderBrowseRecords() }
        }
    }

    private func renderBrowseRecords() {
        offersSection.isHidden = subjectState.workModules?.contains(.offers) == false
        licensesSection.isHidden = subjectState.workModules?.contains(.licenses) == false
        renderRecordSection(offersSection, rows: browseOffers, error: browseOffersError) { [weak self] offer in
            WorkSidebarRowView(
                title: SubjectCommercial.offerTitle(offer),
                subtitle: [offer.organizationName ?? offer.leadTitle, SubjectCommercial.offerSubtitle(offer, day: CrmTaskDate.display)].compactMap { $0 }.joined(separator: " · "),
                isSubdued: true,
                accessibilityLabel: SubjectCommercial.offerTitle(offer),
                onSelect: {
                    guard OfferAvailability.isEditableHere else { return }
                    self?.openOfferEditor(id: offer.id)
                }
            )
        }
        renderRecordSection(licensesSection, rows: browseLicenses, error: browseLicensesError) { [weak self] license in
            let title = license.organizationName ?? license.leadTitle ?? SubjectCommercial.licenseTitle(license)
            return WorkSidebarRowView(
                title: title,
                subtitle: SubjectCommercial.licenseSubtitle(license, day: CrmTaskDate.display),
                isSubdued: true,
                accessibilityLabel: title,
                onSelect: {
                    guard OfferAvailability.isEditableHere else { return }
                    self?.openLicenseEditor(license, on: nil)
                }
            )
        }
    }

    private func renderRecordSection<Row>(_ section: SidebarSection, rows: [Row]?, error: String?, row: (Row) -> NSView) {
        if let error {
            let notice = StarlingsNoticeView(wrapping: true)
            notice.showError(error)
            section.setRows([notice], count: 0)
        } else if let rows {
            if rows.isEmpty {
                section.setRows([quietLabel(String(localized: "Nothing matches."))], count: 0)
            } else {
                section.setRows(rows.map(row), count: rows.count)
            }
        } else {
            section.setRows(StarlingsPlaceholderRowView.rows(glyph: false), count: 0)
        }
    }

    /// The group shows where the organization kind does (the same work-module
    /// gate). A row opens the contact page in the inspector.
    private func renderContacts() {
        contactsSection.isHidden = !BrowseGroupRegistry.isKindShown(.partners, state: subjectState)
        let searching = ContactListFilter.trimmed(contactQuery) != nil
        // Only this group's own search opens it; the rail's search does not read contacts.
        contactsSection.setForcedExpanded(searching)
        if let contactError {
            let notice = StarlingsNoticeView(wrapping: true)
            notice.showError(contactError)
            contactCountLabel.stringValue = ""
            contactsSection.setRows([notice], count: 0)
            return
        }
        guard let page = contactPage else {
            contactCountLabel.stringValue = ""
            contactsSection.setRows(StarlingsPlaceholderRowView.rows(glyph: false), count: 0)
            return
        }
        contactCountLabel.stringValue = page.hasMore ? "\(page.contacts.count)+" : "\(page.contacts.count)"
        guard !page.contacts.isEmpty else {
            let filtered = searching || !contactFilter.isDefault
            contactsSection.setRows([quietLabel(filtered ? String(localized: "Nothing matches.") : String(localized: "No contacts yet."), uppercase: false)], count: 0)
            return
        }
        let rows = page.contacts.map { contact in
            WorkSidebarRowView(
                title: contact.displayName,
                subtitle: contact.context,
                isSubdued: true,
                accessibilityLabel: contact.displayName,
                onSelect: { [weak self] in self?.openContact(id: contact.id, name: contact.displayName) }
            )
        }
        contactsSection.setRows(rows, count: rows.count)
    }

    @objc private func chooseInboxFilter(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let source = InboxFilterSource(rawValue: raw) else { return }
        inboxFilter = source
        WorkSidebarPreferences.setInboxFilter(source)
        renderSidebar()
    }

    @objc private func resetInboxFilter() {
        inboxFilter = .all
        WorkSidebarPreferences.setInboxFilter(inboxFilter)
        renderSidebar()
    }

    @objc private func moveSidebarSectionUp(_ sender: NSMenuItem) {
        moveSidebarSection(sender, by: -1)
    }

    @objc private func moveSidebarSectionDown(_ sender: NSMenuItem) {
        moveSidebarSection(sender, by: 1)
    }

    private func moveSidebarSection(_ sender: NSMenuItem, by delta: Int) {
        guard let key = sender.representedObject as? String else { return }
        sidebarOrder = WorkSidebarPreferences.moved(
            key,
            by: delta,
            order: sidebarOrder,
            hidden: WorkSidebarPreferences.hidden()
        )
        WorkSidebarPreferences.setOrder(sidebarOrder)
        applySidebarLayout()
    }

    /// Back to the shipped rail: every default-visible section on, in its
    /// shipped place, and both lists opening on the status they ship with.
    @objc private func resetSidebarLayout() {
        WorkSidebarPreferences.reset()
        sidebarOrder = WorkSidebarPreferences.order()
        mineFilter = .default
        inboxFilter = .all
        envisioningStatusFilter = SubjectStatusRegistry.project.defaultFilter
        clientStatusFilter = SubjectStatusRegistry.project.defaultFilter
        leadStatusFilter = SubjectStatusRegistry.lead.defaultFilter
        envisioningSortOption = CrmSubjectSortOption.busiest.id
        clientSortOption = CrmSubjectSortOption.busiest.id
        leadSortOption = CrmSubjectSortOption.busiest.id
        envisioningSection.setFilter(
            options: CrmSubjectStatusOption.project,
            selectedID: envisioningStatusFilter
        ) { [weak self] value in
            self?.envisioningStatusFilterChanged(value)
        }
        projectsSection.setFilter(
            options: CrmSubjectStatusOption.project,
            selectedID: clientStatusFilter
        ) { [weak self] value in
            self?.clientStatusFilterChanged(value)
        }
        salesSection.setFilter(
            options: CrmSubjectStatusOption.leadFilter,
            selectedID: leadStatusFilter
        ) { [weak self] value in
            self?.leadStatusFilterChanged(value)
        }
        envisioningSection.setSort(
            options: CrmSubjectSortOption.all,
            selectedID: envisioningSortOption
        ) { [weak self] value in
            self?.envisioningSortChanged(value)
        }
        projectsSection.setSort(
            options: CrmSubjectSortOption.all,
            selectedID: clientSortOption
        ) { [weak self] value in
            self?.clientSortChanged(value)
        }
        salesSection.setSort(
            options: CrmSubjectSortOption.all,
            selectedID: leadSortOption
        ) { [weak self] value in
            self?.leadSortChanged(value)
        }
        applySidebarLayout()
        loadSubjects(debounced: false, refreshCounts: true)
    }

    /// What a sidebar row stands for. **One of these is lit, at most.** It is
    /// read off `focus`, never off `selected`, `inspectedIssueID`, or the
    /// tasks list's own selection — those are what the middle and right
    /// columns are doing, and letting each of them mark the rail is how two
    /// rows came to be lit at once and none when a board was up.
    private enum SidebarKey: Hashable {
        case overview
        case browse
        case subject(String)
        case task(String)
        case issue(String)
        case docsSearch
        case catalog
    }

    private var sidebarKey: SidebarKey? {
        switch focus {
        case .none: .overview
        case .browse: .browse
        case .subject(let subject): .subject(subject.id)
        case .task(let task): .task(task.id)
        case .issue(let issue): .issue(issue.id)
        case .docsSearch: .docsSearch
        case .catalog: .catalog
        // Other records opens from Browse; no rail row stands for its pages.
        case .otherRecords, .coreEntity, .coreSearch: nil
        // The card board is the toolbar's, and the two subject boards are
        // marked on their section headers.
        // Cards is Overview's other view, so the home row stays lit.
        case .cards: .overview
        }
    }

    /// Move the highlight. Rows stay; nothing is rebuilt, nothing flashes.
    /// This is what a click does to the rail; `renderSidebar` is for when the
    /// lists themselves changed.
    private func applySidebarSelection() {
        let key = sidebarKey.map { AnyHashable($0) }
        overviewRow.isSelected = key == overviewRow.selectionKey
        catalogRow.isSelected = key == catalogRow.selectionKey
        for section in allSections + browseSections + [searchSection] {
            for case let row as WorkSidebarSelectableRow in section.rows {
                row.isSelected = key != nil && row.selectionKey == key
            }
        }
    }

    /// Rebuild the lists. For data that changed — a load, a poll that found
    /// something new, a search — not for a click.
    /// Every block at once, without moving the reader: a rebuild empties
    /// each section for one layout pass, and the rail's clip view clamps to
    /// the shorter document — see `NSScrollView.preservingScrollOffset`.
    /// The SUBJECTS order last drawn, so the open subject holds its place.
    private var subjectRailOrder: [String] = []

    private func renderSidebar() {
        let searching = !query.isEmpty
        for section in allSections + browseSections {
            section.setForcedExpanded(searching)
        }
        subjectScroll.preservingScrollOffset {
            renderInbox()
            renderMine()
            renderSubjects()
            renderSearchTail()
        }
        browseScroll.preservingScrollOffset {
            renderEnvisioningProjects()
            renderProjects()
            renderLeads()
            renderPartners()
            renderContacts()
        }
        applySidebarSelection()
    }

    /// SUBJECTS: a bounded, wall-like answer to "what matters now?" Browse
    /// remains the full directory. The order is shared with iOS and web and
    /// moves as stars, unread threads, work, events and activity change.
    private func renderSubjects() {
        let searching = !query.isEmpty
        let everything = envisioningProjects + clientProjects + partners + events + leads
        let states = Dictionary(uniqueKeysWithValues: everything.map { ($0.id, resolvedState(for: $0)) })
        let listed = everything.filter { subject in
            guard let state = states[subject.id] else { return true }
            return searching || state.listed
        }
        let ranked = WorkSubjectRanker.rail(
            listed,
            signals: Dictionary(uniqueKeysWithValues: listed.map { subject in
                (subject.id, WorkRankSignals(
                    starred: states[subject.id]?.starred == true,
                    directAttention: false,
                    unread: unreadSubjectIDs.contains(subject.id)
                ))
            }),
            holding: { if case .subject(let open) = focus { return open.id } else { return nil } }(),
            previous: subjectRailOrder
        )
        subjectRailOrder = ranked.map(\.subject.id)
        var rows: [NSView] = []
        if ranked.isEmpty {
            rows.append(quietLabel(searching ? String(localized: "Nothing matches.") : String(localized: "No active subjects yet."), uppercase: false))
        }
        for row in ranked {
            rows.append(subjectRow(row.subject, state: states[row.subject.id], showsLeading: true, isSubdued: false))
        }
        let browse = WorkSidebarRowView(
            leading: .glyph(systemSymbolName: "list.bullet.rectangle", accessibilityLabel: String(localized: "Browse")),
            title: String(localized: "Browse…"),
            subtitle: String(localized: "Every subject, by relationship"),
            isSelected: focus == .browse,
            isSubdued: true,
            accessibilityLabel: String(localized: "Browse every subject"),
            onSelect: { [weak self] in self?.showBrowse() }
        )
        browse.selectionKey = SidebarKey.browse
        rows.append(browse)
        subjectsSection.setRows(rows, count: ranked.count)
    }

    /// Subject conversations waiting on you, above the work graph. People and
    /// Everyone are Team's unread rows, so Work never becomes a second roster.
    /// Accept puts a proposal on the plate as pending; decline keeps the row
    /// as declined so the same event cannot propose it again. Both
    /// re-read Mine — an accepted proposal may be yours — and INBOX, where
    /// the question was asked.
    private func decideProposal(_ task: CrmTask, accepted: Bool) {
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await api.updateCrmTask(
                    id: task.id,
                    update: CrmTaskUpdate(
                        title: nil,
                        notes: nil,
                        status: accepted ? CrmTaskStatus.pending.rawValue : CrmTaskStatus.declined.rawValue,
                        responsibleParty: nil
                    )
                )
                loadTasks(resetFilter: false)
                loadMine()
                loadInbox()
                subjectOverview.reloadWork()
                work.refreshNow()
            } catch {
                setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t update that task"), tone: .danger)
            }
        }
    }

    // MARK: - INBOX

    func refreshInboxNow() {
        loadInbox()
    }

    private var activityLoading = true
    private var activityFailed = false

    private func loadInbox() {
        activityLoading = true
        inboxTask?.cancel()
        if inbox.items.isEmpty,
           let cached = api.snapshot(MeetingControlAPI.inboxSnapshotKey, as: WorkInboxResponse.self) {
            inbox = cached.value
            renderInbox()
        }
        inboxTask = Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await api.crmInbox()
                guard !Task.isCancelled else { return }
                inbox = response.retainingQuestions(from: inbox)
                activityLoading = false
                activityFailed = false
                work.adoptInbox(inbox)
                renderInbox()
            } catch {
                guard !Task.isCancelled else { return }
                activityLoading = false
                activityFailed = true
                renderInbox()
            }
        }
    }

    /// Today's meetings about a subject, for Overview. The same upcoming
    /// read Home makes; it covers all of today. A failed read keeps the
    /// last rows: the block is a convenience, never an error.
    private func loadTodayMeetings() {
        todayMeetingsTask?.cancel()
        todayMeetingsTask = Task { [weak self] in
            guard let self else { return }
            guard let events = try? await api.upcomingCalendarEvents(), !Task.isCancelled else { return }
            todayMeetings = WorkTodayMeetings.rows(
                events,
                id: \.upcomingID, title: \.upcomingTitle, start: \.upcomingStart, isAllDay: \.upcomingIsAllDay, subject: \.subject
            )
            renderOverview()
        }
    }

    /// INBOX is drawn on Overview only; this keeps its filter's tint honest
    /// and redraws that column.
    private func renderInbox() {
        inboxFilterButton.contentTintColor = inboxFilter.isDefault ? StarlingsColors.secondaryText : StarlingsColors.accent
        renderOverview()
    }

    /// The rows, built fresh, for Overview's INBOX column.
    private func inboxRows() -> (rows: [NSView], count: Int) {
        let wanted = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let unreadIDs = Set(unreadSubjectThreads.map(\.id))
        // The first text is the row's title, the rest its subtitle — the one
        // matcher (invariant 27), thinning the list in place.
        func matches(_ texts: [String?]) -> Bool {
            let parts = texts.compactMap { $0 }
            return Search.matches(query: wanted, title: parts.first ?? "", subtitle: parts.dropFirst().joined(separator: " "))
        }
        var rows: [NSView] = []
        let liveItems = inbox.itemsWithoutQuickNotes.filter { item in
            if case .talk(let thread, _, _, _) = item { return unreadIDs.contains(thread.id) }
            return true
        }
        let count = liveItems.count
        for item in liveItems {
            guard item.matches(inboxFilter) else { continue }
            switch item {
            case .talk(let thread, let mention, _, _):
                guard unreadIDs.contains(thread.id), let subject = thread.subject,
                      matches([subject.title, thread.lastMessagePreview]) else { continue }
                // An INBOX row that opens a subject lights with that subject,
                // the same as its SUBJECTS row; `applySidebarSelection`
                // only looks at the key.
                let row = WorkSidebarRowView.subject(
                    subject,
                    isSelected: subject.id == selected?.id,
                    hasUnread: true,
                    detail: (mention ? String(localized: "Mentions you · ") : "") + (thread.lastMessagePreview ?? thread.kind.channelNoun.capitalized),
                    onSelect: { [weak self] chosen in self?.select(chosen, pane: .talk) },
                    menu: { [weak self] in NSMenu.workRow(item.rowActions) { self?.performRowAction($0) } }
                )
                row.selectionKey = SidebarKey.subject(subject.id)
                rows.append(row)
            case .task(let task, let subject, _, _):
                guard matches([task.title, subject.title]) else { continue }
                let subtitle = subject.proposedTaskDetail
                let row = WorkSidebarRowView(
                    leading: .glyph(systemSymbolName: item.glanceSymbolName, accessibilityLabel: String(localized: "Proposed task")),
                    leadingShape: .square,
                    title: task.title,
                    subtitle: subtitle,
                    isSelected: task.id == focusedTaskID,
                    accessibilityLabel: String(localized: "\(task.title). \(subtitle). Opens the task in the inspector."),
                    onSelect: { [weak self] in
                        self?.inspectOverviewTask(
                            task,
                            canFile: false,
                            subject: subject,
                            subjectProjectID: subject.kind == "project" ? subject.id : nil
                        )
                    },
                    menuProvider: { [weak self] in NSMenu.workRow(item.rowActions) { self?.performRowAction($0) } }
                )
                row.selectionKey = SidebarKey.task(task.id)
                rows.append(row)
            case .card(let card, _, _):
                guard matches([card.title, card.detail]) else { continue }
                // The card itself, in the inspector, the door the project's
                // board opens; accepting it is a move there.
                let row = WorkSidebarRowView(
                    leading: .glyph(systemSymbolName: item.glanceSymbolName, accessibilityLabel: card.detail),
                    leadingShape: .square,
                    title: card.title,
                    subtitle: card.detail,
                    isSelected: card.task.map { $0.id == focusedTaskID } ?? false,
                    accessibilityLabel: String(localized: "\(card.title). \(card.detail). Opens the card in the inspector."),
                    onSelect: { [weak self] in
                        if let issue = card.issue {
                            self?.inspect(.issue(issue))
                        } else if let task = card.task {
                            self?.inspectOverviewTask(
                                task,
                                canFile: false,
                                subject: card.subject,
                                subjectProjectID: card.subject.kind == "project" ? card.subject.id : nil
                            )
                        }
                    },
                    menuProvider: { [weak self] in NSMenu.workRow(item.rowActions) { self?.performRowAction($0) } }
                )
                if let task = card.task { row.selectionKey = SidebarKey.task(task.id) }
                rows.append(row)
            case .followUp(let followUp, _, _):
                guard matches([item.glanceTitle, item.glanceDetail]) else { continue }
                let row = WorkSidebarRowView(
                    leading: .glyph(systemSymbolName: item.glanceSymbolName, accessibilityLabel: item.glanceDetail),
                    leadingShape: .square,
                    title: item.glanceTitle,
                    subtitle: item.glanceDetail,
                    accessibilityLabel: String(localized: "\(item.glanceTitle). \(item.glanceDetail). Opens the follow-up."),
                    onSelect: { [weak self] in self?.performRowAction(.openFollowUp(followUp)) },
                    menuProvider: { [weak self] in NSMenu.workRow(item.rowActions) { self?.performRowAction($0) } }
                )
                rows.append(row)
            case .note:
                continue
            case .sales(let touch, _, _):
                guard !touch.dismissed, matches([touch.displayTitle, touch.metadataLabel]) else { continue }
                rows.append(salesTouchRow(touch, actions: item.rowActions))
            case .comment(let comment, _, _):
                guard matches([comment.document.title, comment.latest.bodyMd, comment.subject?.title ?? ""]) else { continue }
                rows.append(commentRow(comment, actions: item.rowActions))
            case .booking(let booking, _, _):
                guard matches([booking.booking.guestName, booking.booking.guestOrganization ?? "", booking.booking.guestNotes ?? ""]) else { continue }
                rows.append(bookingRow(booking, actions: item.rowActions))
            case .invitation(let event, _, _):
                guard matches([item.glanceTitle, item.glanceDetail, event.location]) else { continue }
                rows.append(calendarRequestRow(item))
            case .forwarded(let event, _, _):
                guard matches([item.glanceTitle, item.glanceDetail, event.location ?? ""]) else { continue }
                rows.append(calendarRequestRow(item))
            case .interest, .submission, .commercial, .decision, .question, .guest:
                guard matches([item.glanceTitle, item.glanceDetail]) else { continue }
                rows.append(glanceRow(item))
            }
        }
        if rows.isEmpty, count > 0 {
            rows.append(quietLabel(String(localized: "NOTHING MATCHES"), uppercase: false))
        }
        if !inbox.partial.isEmpty {
            // The honest edge: which sources did not answer, so an empty
            // inbox is not mistaken for a quiet one.
            if let line = inbox.partialLine {
                rows.append(quietLabel(line, uppercase: false))
            }
        }
        if let line = inbox.cappedLine {
            rows.append(quietLabel(line, uppercase: false))
        }

        return (rows, count)
    }

    /// Quick Notes is a separate list below INBOX, while retaining the same
    /// inbox feed and row actions for consistent refresh and filing behavior.
    private func quickNoteRows() -> (rows: [NSView], count: Int) {
        let wanted = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let notes = inbox.quickNoteItems
        let count = notes.count
        var rows: [NSView] = []
        for item in notes {
            guard case .note(let note, _, _) = item,
                  Search.matches(query: wanted, title: note.body, subtitle: "") else { continue }
            rows.append(quickNoteRow(
                note,
                actions: item.rowActions,
                isSelected: note.id == focusedQuickNoteID
            ))
        }
        if rows.isEmpty, count > 0 {
            rows.append(quietLabel(String(localized: "NOTHING MATCHES"), uppercase: false))
        }
        return (rows, count)
    }

    /// Your own work, across every subject — every task and every issue, not a
    /// sample of them. Choosing a row opens it in the inspector beside these
    /// lists; the project or lead it came from is one click on from there.
    private func renderMine() {
        mineFilterButton.contentTintColor = mineFilter.isDefault && !mineShowsFinished ? StarlingsColors.secondaryText : StarlingsColors.accent
        unownedFilterButton.contentTintColor = unownedOrigin == WorkSidebarPreferences.unownedOriginDefault && unownedHiddenSubjects.isEmpty ? StarlingsColors.secondaryText : StarlingsColors.accent
        // A row named from Home while the list was still in flight. Read it
        // now the list holds it — and forget it either way, so a later render
        // does not drag the middle column back.
        if let pendingMineTaskID {
            self.pendingMineTaskID = nil
            if let task = mine.first(where: { $0.id == pendingMineTaskID }) {
                focusTask(task)
            }
        }
        renderOverview()
    }

    /// The rows, built fresh, for Overview's MINE column. One list
    /// in the order it is owed — late, today, soon, undated, then the
    /// pending — from the same table of rules the phone and the web answer
    /// to (fixtures/work-items.json). No headers between them: the row says
    /// its date, and MINE is one section on every client. A task and an
    /// issue sit in the same run of rows: the vendor is a mark on the row,
    /// not a heading above a block of them. A task promoted to an issue is
    /// one row here, not two. Search is applied after that dedupe.
    private func mineRows() -> (rows: [NSView], count: Int) {
        let wanted = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let allPlan = WorkItems.planMine(tasks: mine, issues: myIssues, query: wanted)
        let plan = allPlan.filtered(by: mineFilter)
        // Recently finished is a choice in MINE's Due menu, as on the web:
        // it replaces the open rows, it is not a second list below them.
        if mineShowsFinished { return (finishedRows(), allPlan.openCount) }

        var rows = workRows(plan.order)
        if plan.openCount == 0 {
            rows.append(quietLabel(allPlan.openCount > 0 ? String(localized: "NOTHING MATCHES") : (query.isEmpty ? String(localized: "NOTHING ASSIGNED TO YOU") : String(localized: "NOTHING MATCHES"))))
        }
        if githubLogin == nil {
            // The honest reason this half is empty, where it is noticed, with
            // the fix a click away.
            let button = NSButton(
                title: String(localized: "Set your GitHub username…"),
                target: self,
                action: #selector(askGithubLogin)
            )
            button.bezelStyle = .inline
            button.controlSize = .small
            SettingsChrome.applyQuietButton(button)
            rows.append(button)
        }
        return (rows, plan.openCount)
    }

    /// MINE on Recently finished: your own work closed this week, newest
    /// first, of the type MINE's Type menu names, each with Reopen.
    private func finishedRows() -> [NSView] {
        var rows: [NSView] = []
        if let recentlyClosedError {
            let notice = StarlingsNoticeView(wrapping: true)
            notice.showError(recentlyClosedError)
            rows.append(notice)
        }
        let items = recentlyClosed.filter { mineFilter.origin == .all || $0.kind.rawValue == mineFilter.origin.rawValue }
        for item in items {
            let kindLabel = item.kind == .task ? String(localized: "Task") : String(localized: "GitHub issue")
            let subtitle = item.issue.map { "\($0.repo) #\($0.number)" } ?? item.subjectTitle ?? kindLabel
            let button = NSButton(title: String(localized: "Reopen"), target: self, action: #selector(reopenRecentlyClosedItem(_:)))
            button.identifier = NSUserInterfaceItemIdentifier("\(item.kind.rawValue):\(item.id)")
            button.bezelStyle = .inline
            button.controlSize = .small
            SettingsChrome.applyQuietButton(button)
            rows.append(WorkSidebarRowView(
                leading: .glyph(
                    systemSymbolName: item.kind == .task ? "checkmark.circle" : "exclamationmark.circle",
                    accessibilityLabel: kindLabel
                ),
                title: item.title,
                subtitle: subtitle,
                trailing: .actions([button]),
                accessibilityLabel: String(localized: "Recently finished: \(item.title)"),
                onSelect: nil
            ))
        }
        if items.isEmpty, recentlyClosedError == nil {
            rows.append(quietLabel(String(localized: "NOTHING FINISHED THIS WEEK")))
        }
        return rows
    }

    /// Mine's rows for a planned list: a task as `WorkMyTaskRowView`, an
    /// issue as `WorkIssueRowView`. UNOWNED draws its rows with the same
    /// views, so a row reads and acts the same in either list.
    private func workRows(_ items: [PlannedWorkItem], assignTeam: [CrmTeamMember]? = nil) -> [NSView] {
        var rows: [NSView] = []
        let me = assignTeam == nil ? nil : (try? api.ownerSessionStore.load())?.owner.email
        for item in items {
            switch item {
            case .task(let task):
                let row = WorkMyTaskRowView(
                    task: task,
                    favorites: favorites,
                    isDone: locallyDoneMineIDs.contains(task.id) || task.status == .completed,
                    isSelected: task.id == focusedTaskID
                ) { [weak self] chosen in
                    self?.inspectMineTask(chosen)
                }
                row.selectionKey = SidebarKey.task(task.id)
                row.onToggleDone = { [weak self] task, done in self?.setMineDone(task, done: done) }
                // Context-menu editing lands in the same inline inspector as
                // a direct click; there is no second task form hiding in a
                // sheet.
                row.onEditTask = { [weak self] task in self?.inspectMineTask(task) }
                row.onRowAction = { [weak self] action in self?.performRowAction(action) }
                row.assignTeam = assignTeam
                row.assignMe = me
                row.agents = roster.agents
                rows.append(row)
            case .issue(let issue):
                let row = WorkIssueRowView(
                    issue: issue,
                    isSelected: issue.id == focusedIssueID
                ) { [weak self] chosen in
                    self?.inspectOverviewIssue(chosen)
                }
                row.selectionKey = SidebarKey.issue(issue.id)
                row.onRowAction = { [weak self] action in self?.performRowAction(action) }
                row.favorites = favorites
                row.assignTeam = assignTeam
                row.assignMe = me
                row.agents = roster.agents
                rows.append(row)
            case .subjectTask:
                // Mine is built from `CrmMyTask` and issues only.
                continue
            }
        }
        return rows
    }

    /// UNOWNED, below MINE: the Worker's rows in Mine's plan and Mine's row
    /// views. Search narrows it like every other block. Nothing at all when
    /// there is none — a nudge, not a header that reads empty every day.
    private func unownedRows() -> (rows: [NSView], count: Int) {
        let wanted = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let allPlan = WorkItems.planMine(tasks: unowned?.tasks ?? [], issues: unowned?.issues ?? [], query: wanted)
        let plan = UnownedSubjects.shown(allPlan, hidden: unownedHiddenSubjects, issueSubjects: unowned?.issueSubjects ?? [:])
            .filtered(by: MineFilter(section: .all, origin: unownedOrigin))
        var rows = workRows(plan.order, assignTeam: team)
        if plan.openCount == 0, allPlan.openCount > 0 {
            rows.append(quietLabel(String(localized: "NOTHING MATCHES")))
        }
        // Red with Copy and Retry, as every failed read is, naming each
        // source and its cause. A subject that only hit the row cap is quiet
        // grey copy, not an error.
        if let failure = unownedError ?? unowned?.gaps.failureLine {
            let notice = StarlingsNoticeView(wrapping: true)
            notice.showError(failure)
            notice.addRetry(target: self, action: #selector(retryUnowned))
            rows.append(notice)
        }
        if unownedError == nil, let truncated = unowned?.gaps.truncatedLine {
            rows.append(quietLabel(truncated, uppercase: false))
        }
        return (rows, plan.openCount)
    }

    @objc private func retryUnowned() {
        loadUnowned()
    }

    // MARK: - Overview

    /// Work's home, in the middle pane ( slice 3d). Drawn from the
    /// same lists as the rail, only when it is what the column shows.
    private func renderOverview() {
        guard focus == .none else { return }
        let inboxBuilt = inboxRows()
        let quickNotesBuilt = quickNoteRows()
        let mineBuilt = mineRows()
        let unownedBuilt = unownedRows()
        overview.setContent(
            today: todayMeetingRows(),
            inbox: inboxBuilt.rows,
            inboxCount: inboxBuilt.count,
            quickNotes: quickNotesBuilt.rows,
            quickNotesCount: quickNotesBuilt.count,
            activity: activityRows(),
            mine: mineBuilt.rows,
            mineCount: mineBuilt.count,
            unowned: unownedBuilt.rows,
            unownedCount: unownedBuilt.count
        )
    }

    private func activityRows() -> [NSView] {
        let entries = inbox.recent.filter { $0.matchesActivity(query: query) }
        var rows: [NSView] = [quietLabel(String(localized: "Latest 30 entries · Past 7 days"))]
        for entry in entries {
            rows.append(WorkSidebarRowView.conversation(
                leading: .glyph(systemSymbolName: "clock", accessibilityLabel: String(localized: "Activity")),
                title: entry.title, detail: entry.activityDetail, isSelected: false, hasUnread: false
            ) { [weak self] in self?.select(entry.subject.crmSubject, pane: .interactions) })
        }
        if activityLoading && entries.isEmpty { rows.append(quietLabel(String(localized: "Loading…"))) }
        if entries.isEmpty && inbox.recentPartial.isEmpty && !activityLoading && !activityFailed {
            rows.append(quietLabel(query.isEmpty ? String(localized: "No activity this week.") : String(localized: "Nothing matches.")))
        }
        if !inbox.recentPartial.isEmpty || activityFailed {
            let notice = StarlingsNoticeView(wrapping: true)
            notice.showError(String(localized: "Couldn’t read some activity. Refresh to try again."))
            rows.append(notice)
            rows.append(WorkSidebarRowView.conversation(
                leading: .glyph(systemSymbolName: "arrow.clockwise", accessibilityLabel: String(localized: "Retry")),
                title: String(localized: "Retry"), detail: "", isSelected: false, hasUnread: false
            ) { [weak self] in self?.loadInbox() })
        }
        return rows
    }

    /// TODAY's rows: a meeting opens the subject it is about, at Talk.
    private func todayMeetingRows() -> [NSView] {
        todayMeetings.map { row in
            WorkSidebarRowView.conversation(
                leading: .glyph(systemSymbolName: "calendar", accessibilityLabel: String(localized: "Meeting")),
                title: row.title,
                detail: row.detail,
                isSelected: false,
                hasUnread: false
            ) { [weak self] in self?.select(row.subject, pane: .talk) }
        }
    }

    private func renderEnvisioningProjects() {
        renderGroup(.envisioning, subjects: envisioningProjects)
    }

    private func renderProjects() {
        renderGroup(.clients, subjects: clientProjects)
    }

    /// Once a project is open, replace the generic repository marker with the
    /// address that explains exactly where its work lives. The kind leads
    /// on every row now that no header names it (a lead and a project can
    /// sit beside each other in SUBJECTS); Core's subtitle already carries
    /// the organization where there is one. On our own projects that
    /// organization is the kind word itself, so it is said once, not twice.
    private func subjectSubtitle(_ subject: CrmSubject) -> String {
        let kind = switch subject.subjectKind {
        case .project: subject.isInternalProject ? StarlingsWorkspace.active.projectGroupName : String(localized: "Client")
        case .lead, .organization, .event: subject.subjectKind.label
        }
        let withRepos = subject.kind == "project" && subject.id == selected?.id && !projectRepos.isEmpty
        let addresses = withRepos ? projectRepos.map(\.address).joined(separator: ", ") : ""
        let eventLabel = subject.isEvent
            ? WorkItems.eventCountdownLabel(eventDate: subject.eventDate, now: Date(), calendar: .current)
            : nil
        let standing = subject.standing(includeRepository: !withRepos, eventLabel: eventLabel)
            .components(separatedBy: " · ")
            .filter { $0 != kind }
            .joined(separator: " · ")
        return [kind, addresses, standing].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// One touch in INBOX: a click starts a lead; dismiss and undo are on
    /// the menu.
    /// An open comment thread on a document: who said what, on
    /// which document; opening it reads the document in the inspector.
    private func commentRow(_ comment: WorkInboxComment, actions: [[WorkRowAction]]) -> NSView {
        let who = comment.latest.who
        let verb = comment.replies > 0 && comment.latest.id != comment.thread.id ? String(localized: "replied on") : String(localized: "commented on")
        let title = "\(who) \(verb) \(comment.document.title)"
        var parts: [String] = []
        let body = comment.latest.bodyMd.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        if !body.isEmpty { parts.append(String(body.prefix(80))) }
        if let subject = comment.subject { parts.append(subject.title) }
        let subtitle = parts.joined(separator: " · ")
        return WorkSidebarRowView(
            leading: .glyph(systemSymbolName: comment.latest.authorKind == .agent ? "cpu" : "text.bubble", accessibilityLabel: String(localized: "Comment")),
            leadingShape: .square,
            title: title,
            subtitle: subtitle,
            accessibilityLabel: String(localized: "\(title). \(subtitle). Opens the document."),
            onSelect: { [weak self] in self?.openDocument(id: comment.document.id, title: comment.document.title) },
            menuProvider: { [weak self] in NSMenu.workRow(actions) { self?.performRowAction($0) } }
        )
    }

    private func salesTouchRow(_ touch: UntriagedTouch, actions: [[WorkRowAction]]) -> NSView {
        var subtitle = touch.metadataLabel
        if touch.dismissed { subtitle = "Dismissed · " + subtitle }
        return WorkSidebarRowView(
            leading: .glyph(systemSymbolName: "tray", accessibilityLabel: touch.source.label),
            title: touch.displayTitle,
            subtitle: subtitle,
            isSubdued: touch.dismissed,
            accessibilityLabel: String(localized: "\(touch.displayTitle). \(subtitle). Start a lead."),
            onSelect: { [weak self] in self?.startLead(from: touch) },
            menuProvider: { [weak self] in NSMenu.workRow(actions) { self?.performRowAction($0) } }
        )
    }

    /// A guest booked: who, when, and the door to the event. Filing happens
    /// in the calendar's inspector; here the row is seen or dismissed.
    private func bookingRow(_ booking: WorkInboxBooking, actions: [[WorkRowAction]]) -> NSView {
        let subtitle = booking.detailLabel
        let name = booking.booking.guestName
        return WorkSidebarRowView(
            leading: .glyph(systemSymbolName: "calendar.badge.plus", accessibilityLabel: String(localized: "Booking")),
            title: name,
            subtitle: subtitle,
            accessibilityLabel: String(localized: "\(name). \(subtitle). Opens the event in Calendar."),
            onSelect: { [weak self] in
                guard let reference = booking.eventReference else { return }
                self?.onOpenCalendarEvent?(reference)
            },
            menuProvider: { [weak self] in NSMenu.workRow(actions) { self?.performRowAction($0) } }
        )
    }

    /// A calendar request: an invitation opens its event in Calendar, where
    /// the inspector answers it too; an event from email has no event yet,
    /// so a click shows the row's answers. Both answer from the menu.
    private func calendarRequestRow(_ item: WorkInboxItem) -> NSView {
        let title = item.glanceTitle
        let subtitle = item.glanceDetail
        weak var drawn: WorkSidebarRowView?
        let row = WorkSidebarRowView(
            leading: .glyph(systemSymbolName: item.glanceSymbolName, accessibilityLabel: subtitle),
            title: title,
            subtitle: subtitle,
            accessibilityLabel: "\(title). \(subtitle).",
            onSelect: { [weak self] in
                guard let self else { return }
                if case .invitation(let event, _, _) = item {
                    onOpenCalendarEvent?(event.eventReference)
                } else if let drawn, let menu = NSMenu.workRow(item.rowActions, perform: { [weak self] in self?.performRowAction($0) }) {
                    menu.popUp(positioning: nil, at: NSPoint(x: 0, y: drawn.bounds.height), in: drawn)
                }
            },
            menuProvider: { [weak self] in NSMenu.workRow(item.rowActions) { self?.performRowAction($0) } }
        )
        drawn = row
        return row
    }

    /// A row drawn from the glance strings alone — what it is, then where
    /// it is from — that opens its `glanceDestination`: an interest row
    /// its lead, a decision its sheet. They need nothing more.
    private func glanceRow(_ item: WorkInboxItem) -> NSView {
        let title = item.glanceTitle
        let subtitle = item.glanceDetail
        let isSelected: Bool
        if case .subject(let subject) = item.glanceDestination?.target {
            isSelected = subject.id == selected?.id
        } else {
            isSelected = false
        }
        let row = WorkSidebarRowView(
            leading: .glyph(systemSymbolName: item.glanceSymbolName, accessibilityLabel: subtitle),
            leadingShape: item.glanceUsesSquareMark ? .square : .round,
            title: title,
            subtitle: subtitle,
            isSelected: isSelected,
            accessibilityLabel: "\(title). \(subtitle).",
            onSelect: { [weak self] in
                self?.openOverviewGlance(item)
            },
            menuProvider: { [weak self] in NSMenu.workRow(item.rowActions) { self?.performRowAction($0) } }
        )
        switch item.glanceDestination?.target {
        case .subject(let subject): row.selectionKey = SidebarKey.subject(subject.id)
        case .mine(let taskID?): row.selectionKey = SidebarKey.task(taskID)
        default: break
        }
        return row
    }

    /// Task and issue rows in Overview open beside their lists. Other inbox
    /// rows keep their established destination, such as Calendar or a subject.
    private func openOverviewGlance(_ item: WorkInboxItem) {
        switch item {
        case .question(let request, _, _):
            presentQuestion(request)
        case .decision(let ask, _, _):
            presentDecision(ask)
        default:
            if let threadID = item.glanceThreadID {
                onOpenConversation?(threadID, item.glanceTitle)
                return
            }
            guard let destination = item.glanceDestination else { return }
            open(destination)
        }
    }

    /// One INBOX row's menu choice, carried out with this window's API and
    /// sheets. The list itself is shared with Home and the phone
    /// (`WorkRowAction`); only this switch is the Work window's.
    func performRowAction(_ action: WorkRowAction) {
        leaveUnowned(after: action)
        switch action {
        case .open(let destination, _):
            open(destination)
        case .openGitHub(let url):
            NSWorkspace.shared.open(url)
        case .copyLink(let link):
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(link, forType: .string)
        case .openDocument(let id, let title):
            openDocument(id: id, title: title)
        case .openCore(let url):
            NSWorkspace.shared.open(url)
        case .openEvent(let reference):
            onOpenCalendarEvent?(reference)
        // A person's conversation is Team's; Home opens it there before
        // asking Work. Work opens only a subject's Talk.
        case .openConversation(let thread):
            if let subject = thread.subject { open(WorkDestination(subject: subject, pane: .talk)) }
        case .markRead(let thread):
            // The row leaves Home and INBOX at once, as Team's reader does;
            // a failed write comes back on the next unread poll.
            watch.markRead(threadID: thread.id)
            run("Couldn’t mark as read") { try await self.api.markThreadRead(threadID: thread.id) }
        case .mute(let thread):
            let until: Date? = thread.isMuted ? nil : Date().addingTimeInterval(7 * 24 * 3600)
            run("Couldn’t change that") { try await self.api.muteThread(threadID: thread.id, until: until) }
        case .archive(let thread):
            run("Couldn’t change that") { try await self.api.archiveThread(threadID: thread.id, archived: thread.archivedAt == nil) }
        case .accept(let task):
            decideProposal(task, accepted: true)
        case .decline(let task):
            decideProposal(task, accepted: false)
        // INBOX never offers Edit; its rows file the note. Home's rows do,
        // and Home performs it in its own panel.
        case .editNote(let note), .fileNote(let note):
            triageQuickNote(note)
        case .deleteNote(let note):
            deleteQuickNote(note)
        // Home offers Move to, and Home performs it; INBOX does not offer it.
        case .moveNote:
            break
        case .startLead(let touch):
            startLead(from: touch)
        case .dismissTouch(let touch):
            setSalesInboxDismissed(touch, dismissed: true)
        case .undoDismissTouch(let touch):
            setSalesInboxDismissed(touch, dismissed: false)
        case .copyEmail(let email):
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(email, forType: .string)
        case .resolveComment(let comment):
            run("Couldn’t resolve that comment") { try await self.api.resolveComment(threadID: comment.thread.id) }
        case .answerDecision(let ask, let option):
            answerDecision(ask, option: option.key, note: nil)
        case .openQuestion(let request):
            presentQuestion(request)
        case .openDecision(let ask):
            presentDecision(ask)
        case .dismissBooking(let key):
            run("Couldn’t dismiss that") { try await self.api.setInboxItemDismissed(key: key, dismissed: true) }
        case .undoDismissBooking(let key):
            run("Couldn’t undo that") { try await self.api.setInboxItemDismissed(key: key, dismissed: false) }
        case .markSeen(let key):
            run("Couldn’t change that") { try await self.api.setInboxItemDismissed(key: key, dismissed: true) }
        case .respondToInvitation(let event, let response, let key):
            answerCalendarRequest(key: key, failure: String(localized: "Couldn’t send your reply")) {
                _ = try await self.api.respondToCalendarEvent(calendarId: event.calendarId, eventId: event.rawEventID, response: response)
            }
        case .addForwardedEvent(let event, let key):
            answerCalendarRequest(key: key, failure: String(localized: "Couldn’t add the event")) {
                _ = try await self.api.addPendingCalendarEvent(id: event.id)
            }
        case .discardForwardedEvent(let event, let key):
            answerCalendarRequest(key: key, failure: String(localized: "Couldn’t discard the event")) {
                try await self.api.discardPendingCalendarEvent(id: event.id)
            }
        case .complete(let task):
            setMineDone(task, done: true)
            loadInbox()
        case .promote(let task):
            promoteMine(task)
        case .cancel(let task):
            cancelTask(id: task.id)
        case .completeTask(let task):
            setTaskDone(task, done: true)
        case .cancelTask(let task):
            cancelTask(id: task.id)
        case .setIssueState(let issue, let projectID, let change):
            setIssueState(issue, projectID: projectID, change)
        case .promoteTask(let task):
            promote(task)
        case .deleteTask(let id, let title):
            TaskDeleteAlert.ask(title: title, over: view.window) { [weak self] in
                self?.deleteTask(id: id)
            }
        case .assignTask(let task, let member):
            run("Couldn’t assign that task") {
                _ = try await self.api.updateCrmTask(id: task.id, update: .assignment(to: member))
                self.loadMine()
            }
        case .assignIssue(let issue, let member):
            guard let update = CrmIssueUpdate.assignment(issue, to: member) else { return }
            run("Couldn’t assign that issue") {
                _ = try await self.api.updateCrmIssue(update)
                self.loadMine()
            }
        case .handOff(let target, let agent):
            handOff(target, to: agent)
        case .makeResponsible(let subject, let email):
            run("Couldn’t change who is responsible") {
                let detail = try await self.api.setCrmSubjectResponsible(kind: subject.subjectKind, id: subject.id, email: email)
                guard self.selected?.id == detail.id else { return }
                let summary = CrmSubject(
                    id: subject.id, kind: subject.kind, title: subject.title, subtitle: subject.subtitle,
                    openTasks: subject.openTasks, overdueTasks: subject.overdueTasks, hasRepo: subject.hasRepo,
                    agentEmail: subject.agentEmail, responsibleEmail: detail.responsibleEmail,
                    organizationLogoURL: subject.organizationLogoURL, organizationID: subject.organizationID,
                    organizationName: subject.organizationName, isInternal: subject.isInternal,
                    lastActivityAt: subject.lastActivityAt, eventDate: subject.eventDate, published: subject.published
                )
                self.selected = summary
                self.showSubjectInfo(summary)
                self.loadSubjects(debounced: false, refreshCounts: false)
            }
        case .openFollowUp(let item):
            FollowUpSheet.present(over: view.window, item: item) { [weak self] accept, decline in
                self?.run("Couldn’t approve that follow-up") {
                    let answer = try await self?.api.approveFollowUp(item, accept: accept, decline: decline)
                    guard let answer else { return }
                    if FollowUpSheet.openMail(answer.mail) {
                        StarlingsToast.show(String(localized: "The message is on the clipboard. Paste it into the mail."), in: self?.view.window)
                    }
                    if !answer.failedTaskIDs.isEmpty {
                        self?.setStatus(String(localized: "Some tasks did not change. Answer them in Inbox."), from: .subjects, tone: .danger)
                    }
                    self?.loadMine()
                }
            }
        case .dismissFollowUp(let item):
            run("Couldn’t dismiss that follow-up") {
                try await self.api.dismissFollowUp(item)
            }
        }
    }

    /// A row acted on leaves UNOWNED at once — done, cancelled, closed or
    /// now held by someone — rather than waiting for the re-read every Mine
    /// refresh makes. A write that fails comes back with that re-read.
    private func leaveUnowned(after action: WorkRowAction) {
        guard var list = unowned else { return }
        switch action {
        case .complete(let task), .cancel(let task), .assignTask(let task, _):
            list.tasks.removeAll { $0.id == task.id }
        case .setIssueState(let issue, _, .close), .setIssueState(let issue, _, .closeNotPlanned), .assignIssue(let issue, _):
            list.issues.removeAll { $0.id == issue.id }
        default:
            return
        }
        unowned = list
        renderSidebar()
    }

    /// A decision waiting on you, read whole before answering.
    private func presentQuestion(_ request: AttentionRequest) {
        AttentionQuestionSheet(request: request, api: api) { [weak self] in self?.loadInbox() }.run(over: view.window)
    }

    private func presentDecision(_ ask: DecisionAsk) {
        DecisionAskSheet.present(over: view.window, ask: ask) { [weak self] option, note in
            self?.answerDecision(ask, option: option, note: note)
        }
    }

    private func answerDecision(_ ask: DecisionAsk, option: String, note: String?) {
        run("Couldn’t answer that decision") { _ = try await self.api.answerDecisionAsk(id: ask.id, answer: option, note: note) }
    }

    /// A calendar answer: the row leaves INBOX — here, on Home and in the
    /// menu bar — as soon as the write succeeds, before the re-read, because
    /// Google can take a moment to show the new attendee status.
    private func answerCalendarRequest(key: String, failure: String, _ write: @escaping () async throws -> Void) {
        run(failure) { [weak self] in
            try await write()
            guard let self else { return }
            // Home can answer before this window has read INBOX: drop the
            // row from each list that holds it, never adopt an empty one.
            if inbox.items.contains(where: { $0.id == key }) {
                inbox = inbox.removing(key: key)
                renderInbox()
            }
            work.dropInboxItem(key: key)
            onCalendarAnswered?()
        }
    }

    /// A write that only has to leave INBOX: run it, then re-read what the
    /// rail draws from. The roster poll owns unread talk, so it is asked too.
    private func run(_ failure: String, _ write: @escaping () async throws -> Void) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await write()
                loadInbox()
                watch.refreshNow()
                work.refreshNow()
            } catch {
                setStatus((error as? StarlingsError)?.message ?? failure, from: .subjects, tone: .danger)
            }
        }
    }

    /// The ordinary New Lead sheet, pre-filled from the touch; the created
    /// lead carries the touch's organization and contact ids.
    private func startLead(from touch: UntriagedTouch) {
        WorkSubjectEditor.present(
            over: view.window,
            title: String(localized: "New Lead"),
            kind: .lead,
            detail: nil,
            prefill: .init(
                title: touch.prefill.title,
                notes: touch.draftNotes,
                organizationID: touch.prefill.organizationID,
                organizationName: touch.prefill.organizationName,
                contactID: touch.prefill.contactID,
                contactName: touch.prefill.contactName
            ),
            organizationSearch: organizationSearchHandler(),
            organizationCreate: organizationCreateHandler(),
            resolveOrganizations: organizationResolveHandler(),
            contactSearch: contactSearchHandler(),
            resolveContacts: contactResolveHandler()
        ) { [weak self] draft, completion in
            guard let self else { return }
            // The sheet now shows the prefilled contact in a picker the
            // person can change, so the draft is the answer — `relations`
            // only still carries the organization, which a lead-edit sheet
            // does not offer.
            saveSubject(
                draft,
                existing: nil,
                relations: (touch.prefill.organizationID, nil),
                completion: completion
            )
        }
    }

    private func setSalesInboxDismissed(_ touch: UntriagedTouch, dismissed: Bool) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await api.setSalesInboxDismissed(id: touch.id, dismissed: dismissed)
                loadInbox()
            } catch {
                setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t change that"), from: .subjects, tone: .danger)
            }
        }
    }

    /// Organizations ride behind the three subject lists and never fail
    /// them: a Core that does not answer `kind=partner` yet leaves the block
    /// quiet rather than putting the whole rail in red. Not snapshotted —
    /// Core's answer is one page, and the filter decides which.
    private func loadPartners(query: String) async {
        guard !WorkSidebarPreferences.hidden().contains(partnersSection.sectionKey) else { return }
        do {
            let page = try await api.crmSubjectPage(kind: .organization, query: query, status: nil, organizations: organizationFilter)
            guard !Task.isCancelled else { return }
            partners = page.subjects
            if let facets = page.facets { organizationFacets = facets }
        } catch {
            guard !Task.isCancelled else { return }
            partners = []
        }
        renderPartners()
    }

    private func renderPartners() {
        renderGroup(.partners, subjects: partners, isSubdued: true)
    }

    /// Events ride behind the lists the same way partners do (docs/EVENTS.md).
    /// Core answers the open ones — today and later where this Mac is, and
    /// undated drafts — soonest first.
    private func loadEvents(query: String) async {
        guard !WorkSidebarPreferences.hidden().contains(eventsSection.sectionKey) else { return }
        do {
            let page = try await api.crmSubjectPage(kind: .event, query: query, status: nil)
            guard !Task.isCancelled else { return }
            events = page.subjects
        } catch {
            guard !Task.isCancelled else { return }
            events = []
        }
        renderEvents()
        renderSubjects()
    }

    private func renderEvents() {
        renderGroup(.events, subjects: events, isSubdued: true)
    }

    private func renderLeads() {
        renderGroup(.sales, subjects: leads)
    }

    // MARK: - The SUBJECTS zone

    /// One group of the SUBJECTS zone, as draws it. The rows are
    /// the subjects you follow — starred first, then the section's own
    /// sort — grouped by organization: an organization with more than one
    /// row here is a fold, one with a single row is just that row, and rows
    /// with no organization sit under NO ORGANIZATION at the bottom. Muted
    /// rows draw quiet.
    private func renderGroup(
        _ group: SubjectGroup,
        subjects: [CrmSubject],
        showsLeading: Bool = true,
        isSubdued: Bool = false
    ) {
        let block = section(for: group)
        block.isHidden = !BrowseGroupRegistry.isKindShown(group, state: subjectState)
        let emptyMessage = query.isEmpty
            ? (group == .partners
                ? (organizationFilter.isDefault ? String(localized: "No partners yet.") : String(localized: "Nothing matches."))
                : group == .events ? String(localized: "No upcoming events.") : String(localized: "Nothing here yet."))
            : "Nothing matches."
        guard !subjects.isEmpty else {
            block.setRows([quietLabel(emptyMessage, uppercase: false)], count: 0)
            return
        }
        let states = Dictionary(uniqueKeysWithValues: subjects.map { ($0.id, resolvedState(for: $0)) })
        // Starred to the top; otherwise the order the sort control already
        // gave the list. A stable partition, not a sort, so that order
        // survives inside each half.
        let starred = subjects.filter { states[$0.id]?.starred == true }
        let rest = subjects.filter { states[$0.id]?.starred != true }
        let rows = organizationRows(
            starred + rest,
            group: group,
            states: states,
            showsLeading: showsLeading,
            isSubdued: isSubdued
        )
        block.setRows(rows, count: subjects.count)
    }

    /// Rows in the order given. One hierarchy — group, then subject — the
    /// same as the rail, just unfolded. Organization is a line on the row,
    /// never a header: a second tier of headers under the group's own was
    /// nesting that told nothing (ENVISIONING over ENVISIONING).
    private func organizationRows(
        _ subjects: [CrmSubject],
        group: SubjectGroup,
        states: [String: ResolvedSubjectState],
        showsLeading: Bool,
        isSubdued: Bool
    ) -> [NSView] {
        subjects.map { subjectRow($0, state: states[$0.id], showsLeading: showsLeading, isSubdued: isSubdued) }
    }

    private func subjectRow(
        _ subject: CrmSubject,
        state: ResolvedSubjectState?,
        showsLeading: Bool = true,
        isSubdued: Bool = false
    ) -> WorkSidebarRowView {
        // Core's summary normally carries this marker. The selected
        // project's exact links arrive a moment later, so use those too;
        // otherwise the row would keep offering Link after it succeeded.
        let canLinkRepository = subject.kind == "project"
            && !subject.hasRepo
            && !(selected?.id == subject.id && !projectRepos.isEmpty)
        let onLinkRepository: ((CrmSubject) -> Void)? = canLinkRepository ? { [weak self] chosen in
            guard let self, let window = view.window else { return }
            select(chosen)
            presentRepositoryPicker(over: window, projectID: chosen.id) { [weak self] _ in
                guard let self, selected?.id == chosen.id else { return }
                select(chosen, pane: .issues)
            }
        } : nil
        let row = WorkSidebarRowView.subject(
            subject,
            isSelected: subject.id == selected?.id,
            hasUnread: unreadSubjectIDs.contains(subject.id),
            detail: subjectSubtitle(subject),
            showsLeading: showsLeading,
            isSubdued: isSubdued,
            state: state,
            onSetState: { [weak self] chosen, update in
                self?.setSubjectState(chosen, update: update)
            },
            onSelect: { [weak self] chosen in
                self?.select(chosen)
            },
            onOpenPane: { [weak self] chosen, pane in
                self?.select(chosen, pane: pane)
            },
            onEdit: { [weak self] chosen in
                self?.select(chosen)
                self?.editSubjectPressed()
            },
            onWin: { [weak self] chosen in
                self?.winLead(chosen)
            },
            onRename: { [weak self] chosen in
                self?.renameSubject(chosen)
            },
            onNewTask: { [weak self] chosen in
                self?.select(chosen, pane: .tasks)
                self?.composeTask(nil, subject: chosen)
            },
            onNewIssue: { [weak self] chosen in
                self?.select(chosen, pane: .issues)
                self?.newIssuePressed()
            },
            onMeet: { [weak self] chosen in
                self?.onMeetAbout?(chosen)
            },
            // Open in Core and Keep vault only where the workspace has them.
            onOpenCore: subject.coreURL == nil ? nil : { chosen in
                if let url = chosen.coreURL { NSWorkspace.shared.open(url) }
            },
            onLinkRepository: onLinkRepository,
            onOpenKeep: StarlingsWorkspace.active.has(.keep) ? { [weak self] chosen in
                self?.onOpenKeep?(chosen)
            } : nil
        )
        row.selectionKey = SidebarKey.subject(subject.id)
        return row
    }

    // MARK: - Subject state

    private func loadSubjectState() {
        subjectStateTask?.cancel()
        if subjectState == .unknown,
           let cached = api.snapshot(MeetingControlAPI.subjectStateSnapshotKey, as: SubjectStateResponse.self) {
            applySubjectState(cached.value)
            applySidebarLayout()
        }
        subjectStateTask = Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await api.crmSubjectState()
                guard !Task.isCancelled else { return }
                let salesChanged = response.salesEnabled != subjectState.salesEnabled
                applySubjectState(response)
                if salesChanged { applySidebarLayout() }
                renderSidebar()
            } catch {
                // Not configured, no session, a blip: the rail is already
                // drawn from `.unknown`, which hides nothing. Nothing to add.
            }
        }
    }

    private func applySubjectState(_ response: SubjectStateResponse) {
        subjectState = response
        subjectOverview.setWorkModules(response.workModules)
        cardBoard.setHiddenStages(response.boardHiddenStages)
        subjectOverrides = Dictionary(
            response.states.map { ($0.subjectKey, $0.override) },
            uniquingKeysWith: { _, latest in latest }
        )
    }

    /// The person's answer for one subject. Before the Worker has answered,
    /// every subject reads as listed — a rail that hid rows on a guess
    /// would be worse than one that fills in a moment later.
    private func resolvedState(for subject: CrmSubject) -> ResolvedSubjectState {
        guard subjectState != .unknown else { return .plain }
        return SubjectState.resolve(
            group: subject.group,
            prefs: subjectState.prefs,
            override: subjectOverrides[subject.stateKey]
        )
    }

    /// Applied in place first, then sent. On failure the row goes back to
    /// what the Worker last said and the status line names the reason.
    private func setSubjectState(_ subject: CrmSubject, update: SubjectStateUpdate) {
        let key = subject.stateKey
        let before = subjectOverrides[key]
        let next = update.applied(to: before ?? SubjectStateOverride(starred: false, muted: false))
        subjectOverrides[key] = next.isDefault ? nil : next
        renderSidebar()
        Task { [weak self] in
            guard let self else { return }
            do {
                let stored = try await api.crmSetSubjectState(kind: subject.subjectKind, id: subject.id, update: update)
                subjectOverrides[key] = stored?.override
                renderSidebar()
                onSubjectStateChanged?()
                // Following changes what INBOX's tail carries.
                loadInbox()
            } catch {
                subjectOverrides[key] = before
                renderSidebar()
                setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t change that"), tone: .danger)
            }
        }
    }

    private func quietLabel(_ title: String, uppercase: Bool = true) -> NSTextField {
        let label = NSTextField(labelWithString: title)
        label.font = uppercase ? StarlingsTypography.sectionLabelFont : .systemFont(ofSize: StarlingsTypography.scaled(11))
        label.textColor = StarlingsColors.secondaryText
        label.allowSqueezing()
        return label
    }

    // MARK: - Docs, through search

    /// Docs has no block of its own ( decision 6): it has a window.
    /// While something is typed, the tail of the rail offers the same words
    /// to it. ⌘K and this field find every record with a subject door
    /// (#1221); the rest is **Other records** at the foot of Browse (#1262).
    private func renderSearchTail() {
        let wanted = query
        var rows: [NSView] = []
        if !wanted.isEmpty, docs.isLinked {
            let row = WorkSidebarRowView(
                leading: .glyph(systemSymbolName: "doc.text.magnifyingglass", accessibilityLabel: String(localized: "Search")),
                title: String(localized: "Search Docs for “\(wanted)”"),
                subtitle: String(localized: "Titles and full text"),
                isSelected: focus == .docsSearch,
                accessibilityLabel: String(localized: "Search Docs for \(wanted)"),
                onSelect: { [weak self] in self?.showDocsSearch(query: wanted) }
            )
            row.selectionKey = SidebarKey.docsSearch
            rows.append(row)
        }
        searchSection.setRows(rows, count: rows.count)
    }

    /// A document chosen in the middle column is edited in the inspector,
    /// exactly where a task or an issue chosen from a list is read.
    private func openDocument(id: String, title: String) {
        guard docs.isLinked else { return }
        infoSubject = nil
        inspector.show(.document(id: id, title: title))
        setInspector(visible: true)
        updateTabTitle()
        if focus == .none { renderOverview() }
    }

    /// `query` seeds the search field in the column; the rail's tail passes
    /// what was typed, the Work menu passes nothing.
    func showDocsSearch(query: String) {
        guard docs.isLinked else { return }
        detailTask?.cancel()
        itemDetail.clear()
        leaveSubject()
        focus = .docsSearch
        coreHost.rootView = meetHosted(MacDocsSearchRoot(session: docs, initialQuery: query) { [weak self] id, title in
            MainActor.assumeIsolated { self?.openDocument(id: id, title: title) }
        })
        showInspectorInfo(docsSearchInfo())
        applySidebarSelection()
        applyPane()
    }

    /// The service catalog, in the middle column.
    func showCatalog() {
        detailTask?.cancel()
        itemDetail.clear()
        leaveSubject()
        focus = .catalog
        coreHost.rootView = meetHosted(MacCatalogRoot(api: api))
        showInspectorInfo(catalogInfo())
        applySidebarSelection()
        applyPane()
    }

    /// The licence editor, as a sheet over the subject: `license`, or a new one on `subject`.
    private func openLicenseEditor(_ license: CrmLicense?, on subject: CrmSubject?) {
        var sheet: NSViewController?
        let close = { [weak self] in
            guard let sheet else { return }
            self?.dismiss(sheet)
        }
        let host = NSHostingController(rootView: meetHosted(MacLicenseSheet(
            api: api,
            license: license,
            subject: subject,
            onChanged: { [weak self] in
                self?.subjectOverview.reloadCommercial()
                self?.loadBrowseRecords()
            },
            onClose: close
        )))
        sheet = host
        presentAsSheet(host)
    }

    /// The offer editor, as a sheet over the subject.
    private func openOfferEditor(id: String) {
        var sheet: NSViewController?
        let close = { [weak self] in
            guard let sheet else { return }
            self?.dismiss(sheet)
        }
        let host = NSHostingController(rootView: meetHosted(MacOfferEditor(
            api: api,
            offerID: id,
            onChanged: { [weak self] in
                self?.subjectOverview.reloadCommercial()
                self?.loadBrowseRecords()
            },
            onClose: close
        )))
        sheet = host
        presentAsSheet(host)
    }

    private func createOffer(on subject: CrmSubject) {
        let create = subject.kind == "lead" ? OfferCreate(leadID: subject.id) : OfferCreate(organizationID: subject.id)
        Task { [api] in
            do {
                let created = try await api.createOffer(create)
                subjectOverview.reloadCommercial()
                openOfferEditor(id: created.offer.id)
            } catch {
                presentError(error, fallback: String(localized: "Couldn’t create the offer."))
            }
        }
    }

    private func editPartnerDiscount(_ organization: CrmSubject, _ current: OrganizationDiscountResponse) {
        var sheet: NSViewController?
        let close = { [weak self] in
            guard let sheet else { return }
            self?.dismiss(sheet)
        }
        let host = NSHostingController(rootView: meetHosted(MacPartnerDiscountSheet(
            api: api,
            organizationID: organization.id,
            current: current,
            onSaved: { [weak self] in
                self?.subjectOverview.reloadCommercial()
                close()
            },
            onCancel: close
        )))
        sheet = host
        presentAsSheet(host)
    }

    /// The page behind Browse's foot row. Not connected yet, it is one button.
    func showOtherRecords() {
        guard core.isAvailable else { return }
        detailTask?.cancel()
        itemDetail.clear()
        leaveSubject()
        focus = .otherRecords
        coreHost.rootView = meetHosted(MacOtherRecordsRoot(
            session: core,
            onSearch: { [weak self] in MainActor.assumeIsolated { self?.showCoreSearch() } },
            onEntity: { [weak self] contract in MainActor.assumeIsolated { self?.showCore(contract) } }
        ))
        showInspectorInfo(otherRecordsInfo())
        applySidebarSelection()
        applyPane()
    }

    /// One registry table by id, the ⌘K palette's door.
    func showCore(entityID: String) {
        guard let contract = core.entities.first(where: { $0.id == entityID }) else { return }
        showCore(contract)
    }

    private func showCore(_ contract: CRMEntityContract) {
        guard core.isLinked else { return }
        if case .coreEntity(let shown) = focus, shown.id == contract.id { return }
        detailTask?.cancel()
        itemDetail.clear()
        leaveSubject()
        focus = .coreEntity(contract)
        coreHost.rootView = meetHosted(MacCoreEntityRoot(
            contract: contract,
            session: core,
            onToast: { [weak self] message in
                MainActor.assumeIsolated { StarlingsToast.show(message, in: self?.view.window) }
            },
            onOpenWorkSubject: { [weak self] subject in
                MainActor.assumeIsolated { self?.open(WorkDestination(subject: subject, pane: .talk)) }
            }
        ))
        showInspectorInfo(coreEntityInfo(contract))
        applySidebarSelection()
        applyPane()
    }

    private func showCoreSearch() {
        guard core.isLinked else { return }
        detailTask?.cancel()
        itemDetail.clear()
        leaveSubject()
        focus = .coreSearch
        coreHost.rootView = meetHosted(MacCoreSearchRoot(
            session: core,
            onOpenWorkSubject: { [weak self] subject in
                MainActor.assumeIsolated { self?.open(WorkDestination(subject: subject, pane: .talk)) }
            }
        ))
        showInspectorInfo(coreSearchInfo())
        applySidebarSelection()
        applyPane()
    }

    private func docsStateDidChange() {
        guard isViewLoaded else { return }
        if !docs.isLinked {
            switch focus {
            case .docsSearch:
                focus = .none
                coreHost.rootView = meetHosted(EmptyView())
            default:
                break
            }
            docsHost.rootView = meetHosted(EmptyView())
            docsSubjectID = nil
            if case .document = inspector.item { clearInspector() }
        }
        loadDocumentsCount()
        syncPaneControl()
        applySidebarLayout()
        renderSidebar()
        applyPane()
    }

    /// Documents is built once per subject and kept, like Fields: the editor
    /// holds text between autosaves, and switching to Talk and back must not
    /// throw it away.
    private func loadDocuments() {
        guard docs.isLinked else { return }
        guard let subject = selected, selectedPane == .documents else { return }
        guard docsSubjectID != subject.id else { return }
        docsSubjectID = subject.id
        docsHost.rootView = meetHosted(MacSubjectDocumentsRoot(
            subject: subject,
            session: docs,
            onOpen: { [weak self] document in
                MainActor.assumeIsolated { self?.openDocument(id: document.id, title: document.title) }
            },
            onToast: { [weak self] message in
                MainActor.assumeIsolated { StarlingsToast.show(message, in: self?.view.window) }
            }
        ))
    }

    /// Fields is built the first time the pane is chosen for a subject and
    /// kept until the subject changes — the pane holds unsaved edits, and
    /// switching to Talk and back must not throw them away. It reads and
    /// writes through the Worker, on a Core or a D1 workspace.
    private func loadFields() {
        guard let subject = selected, selectedPane == .fields else { return }
        guard fieldsSubjectID != subject.id else { return }
        fieldsSubjectID = subject.id
        fieldsHost.rootView = meetHosted(MacSubjectFieldsRoot(
            subject: subject,
            workModules: subjectState.workModules,
            api: api,
            onToast: { [weak self] message in
                MainActor.assumeIsolated { StarlingsToast.show(message, in: self?.view.window) }
            },
            onSaved: { [weak self] _ in
                MainActor.assumeIsolated { self?.loadSubjects(debounced: false, refreshCounts: true) }
            }
        ))
    }

    // MARK: - Choosing

    /// `pane` is the reason the row was clicked — a task row lands on Tasks,
    /// an unread row on Talk. Nil keeps whatever pane is showing, which is
    /// what a subject row in the list means. Choosing the subject already
    /// open only switches the pane: the inspector stays with what it has.
    private func select(_ subject: CrmSubject, pane: WorkPane? = nil) {
        if let pane {
            selectedPane = switch pane {
            case .overview, .talk: .overview
            case .tasks: .tasks
            case .issues: .issues
            case .interactions: .interactions
            }
        } else if subject.id != selected?.id {
            selectedPane = .overview
        }
        guard subject.id != selected?.id else {
            applyPane()
            return
        }
        detailTask?.cancel()
        itemDetail.clear()
        focus = .subject(subject)
        selected = subject
        recordHop(subject)
        showSubjectInfo(subject)
        // Opening is reading: clear the dot now rather than waiting for the
        // next poll to confirm what the person is already looking at. The
        // read receipt is already on its way from the pane.
        for thread in unreadSubjectThreads where thread.parentID == subject.id {
            watch.markRead(threadID: thread.id)
        }
        applySidebarSelection()
        subjectOverview.show(subject)
        if !subject.isPartner, !subject.isEvent { loadSubjectDetail(subject) }
        if subject.isPartner {
            // The gate the trap warns about: a partner never
            // reaches the tasks or issues paths. It does talk, on its
            // organization (slice 4a).
            threadPane.show(.subject(subject))
            applyPane()
            loadPartnerDetail(subject)
            loadInteractions()
            loadFields()
            loadDocumentsCount()
            return
        }
        if subject.isEvent {
            // An event talks and has tasks; no issues and no history
            // (docs/EVENTS.md). Its page reads the CMS row.
            threadPane.show(.subject(subject))
            applyPane()
            loadPartnerDetail(subject)
            loadTasks()
            loadFields()
            loadDocumentsCount()
            return
        }
        threadPane.show(.subject(subject))
        applyPane()
        loadTasks()
        loadProjectRepos()
        loadIssues()
        loadInteractions()
        loadFields()
        loadDocumentsCount()
    }

    /// The id asked for was merged into another record: Work
    /// opens the survivor in its place, so the selection, the ⌘[ history,
    /// the recents and the star hold the survivor's id. True when it did.
    private func adoptSurvivor(of subject: CrmSubject, _ detail: CrmSubjectDetail) -> Bool {
        guard let mergedID = detail.mergedFrom, detail.id != subject.id else { return false }
        let survivor = detail.summary
        subjectDetails[survivor.id] = detail
        subjectHistory = subjectHistory.map { $0.id == mergedID ? survivor : $0 }
        SearchRecents.replace(mergedID: mergedID, with: nil, owner: api.signedInOwnerEmail ?? "")
        let favorites = favorites
        Task { await favorites.moveStar(kind: subject.kind, from: mergedID, to: survivor.id) }
        select(survivor)
        return true
    }

    /// The list summary keeps the rail fast. Overview's inspector gets the
    /// fuller Core projection independently, so a slow detail read cannot
    /// delay Talk or the contextual work column.
    private func loadSubjectDetail(_ subject: CrmSubject) {
        subjectDetailTask?.cancel()
        subjectDetailTask = Task { [weak self] in
            guard let self else { return }
            do {
                let detail = try await api.crmSubjectDetail(kind: subject.subjectKind, id: subject.id)
                guard !Task.isCancelled, selected?.id == subject.id else { return }
                if adoptSurvivor(of: subject, detail) { return }
                subjectDetails[subject.id] = detail
                if case .subject(let shown) = focus, shown.id == subject.id {
                    showInspectorInfo(subjectInfo(shown))
                }
            } catch {
                // The summary is still useful metadata; the inspector keeps
                // it rather than turning a detail outage into an empty panel.
            }
        }
    }

    /// The partner's page, from the same detail read the editor uses: the
    /// organization's description, website and industry, and the projects,
    /// leads and contacts that hang off it. Related rows open their subject.
    private func loadPartnerDetail(_ subject: CrmSubject) {
        partnerDetailTask?.cancel()
        subjectDetailTask?.cancel()
        partnerPane.show(subject, detail: nil)
        partnerDetailTask = Task { [weak self] in
            guard let self else { return }
            do {
                let detail = try await api.crmSubjectDetail(kind: subject.subjectKind, id: subject.id)
                guard !Task.isCancelled, selected?.id == subject.id else { return }
                if adoptSurvivor(of: subject, detail) { return }
                subjectDetails[subject.id] = detail
                partnerPane.show(subject, detail: detail)
                if subject.isEvent {
                    eventDetails[subject.id] = detail
                    showSubjectInfo(subject)
                }
            } catch {
                guard !Task.isCancelled, selected?.id == subject.id else { return }
                partnerPane.showError((error as? StarlingsError)?.message ?? (subject.isEvent ? String(localized: "Couldn’t load that event") : String(localized: "Couldn’t load that partner")))
            }
        }
    }

    /// One of your own tasks, read in the middle column. Mine carries the
    /// summary only, so the row is drawn from what is already in hand and
    /// replaced by the full record the moment Core answers — nobody waits on
    /// a round trip to see what they clicked.
    private func focusTask(_ task: CrmMyTask) {
        leaveSubject()
        focus = .task(task)
        showInspectorInfo(taskInfo(task))
        applySidebarSelection()
        applyPane()
        itemDetail.partialTaskID = task.id
        itemDetail.show(.task(
            task.partialTask,
            canFile: task.projectID != nil && task.githubIssueNumber == nil,
            subject: task.subject
        ))
        loadFullTask(task)
    }

    /// A task chosen from Overview belongs in the inspector, so its two lists
    /// remain visible while it is read or edited.
    private func inspectMineTask(_ task: CrmMyTask) {
        inspector.partialTaskID = task.id
        inspectOverviewTask(
            task.partialTask,
            canFile: task.projectID != nil && task.githubIssueNumber == nil,
            subject: task.subject,
            subjectProjectID: task.projectID
        )
        loadFullTask(task, into: inspector)
    }

    /// INBOX proposals and MINE rows share the same right-side task reader.
    private func inspectOverviewTask(
        _ task: CrmTask,
        canFile: Bool,
        subject: CrmSubject?,
        subjectProjectID: String?
    ) {
        detailTask?.cancel()
        tasksControls.setSelectedTaskID(nil)
        inspect(.task(task, canFile: canFile, subject: subject), subjectProjectID: subjectProjectID)
    }

    /// Issues opened from MINE keep Overview in the center as well.
    private func inspectOverviewIssue(_ issue: CrmIssue) {
        detailTask?.cancel()
        inspect(.issue(issue))
    }

    private func focusIssue(_ issue: CrmIssue) {
        leaveSubject()
        focus = .issue(issue)
        showInspectorInfo(issueInfo(issue))
        applySidebarSelection()
        applyPane()
        itemDetail.show(.issue(issue))
    }

    /// The middle column is about to read something that is not a subject.
    /// The subject's panes stop rather than polling a conversation nobody can
    /// see; choosing it again shows it afresh.
    private func leaveSubject() {
        threadPane.stop()
        subjectOverview.clear()
        interactionsView.stop()
        partnerDetailTask?.cancel()
        partnerPane.clear()
        fieldsHost.rootView = meetHosted(EmptyView())
        fieldsSubjectID = nil
        docsHost.rootView = meetHosted(EmptyView())
        docsSubjectID = nil
        repoTask?.cancel()
        selected = nil
        issues = []
        projectRepos = []
        isLinkedToGitHub = false
        clearInspector()
        tasksControls.setUnavailable(String(localized: "Pick a project or lead."))
    }

    /// The task or issue selected in the middle column or inspector, as ids:
    /// a reloaded row is a new value for the same item, and its list still has
    /// to mark it.
    private var focusedTaskID: String? {
        if case .task(let task) = focus { return task.id }
        if case .task(let task, _, _) = inspector.item { return task.id }
        return nil
    }

    private var focusedIssueID: String? {
        if case .issue(let issue) = focus { return issue.id }
        if case .issue(let issue) = inspector.item { return issue.id }
        return nil
    }

    private var focusedQuickNoteID: String? {
        if case .quickNote(let note)? = inspector.item { return note.id }
        return nil
    }

    /// The subject the task on screen belongs to, where it has one.
    private var focusedTaskSubject: CrmSubject? {
        guard case .task(let task) = focus else { return nil }
        return task.subject
    }

    private func loadFullTask(_ task: CrmMyTask, into destination: WorkInspectorViewController? = nil) {
        detailTask?.cancel()
        let detail = destination ?? itemDetail
        detail.onRetryFullTask = { [weak self] in self?.loadFullTask(task, into: destination) }
        detailTask = Task { [weak self] in
            guard let self else { return }
            // Read by id, whatever the task hangs off (a partner, a meeting,
            // nothing): Mine's summary has no assignee or responsible party,
            // so a form left on it would read Unassigned and save that.
            do {
                let full = try await api.crmTask(id: task.id)
                guard !Task.isCancelled else { return }
                detail.refresh(
                    task: full,
                    canFile: full.projectID != nil && full.githubIssueNumber == nil,
                    subject: task.subject
                )
            } catch {
                guard !Task.isCancelled else { return }
                detail.setTaskError((error as? StarlingsError)?.message ?? String(localized: "Couldn’t load that task"))
            }
        }
    }

    // MARK: - Writes from the middle column

    private func setFocusedTaskDone(_ task: CrmTask, done: Bool) {
        Task { [weak self] in
            guard let self else { return }
            do {
                let updated = try await api.updateCrmTask(
                    id: task.id,
                    update: .completion(done)
                )
                itemDetail.refresh(
                    task: updated,
                    canFile: updated.projectID != nil && updated.githubIssueNumber == nil
                )
                loadMine()
                work.refreshNow()
            } catch {
                itemDetail.setTaskError((error as? StarlingsError)?.message ?? String(localized: "Couldn’t update that task"))
            }
        }
    }

    /// Hand a task on screen to GitHub. A hand-off, not a sync — see the
    /// subject pane's `promote`.
    private func promoteFocusedTask(_ task: CrmTask) {
        guard let projectID = task.projectID else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await api.createCrmIssue(.promotion(
                    projectID: projectID, taskID: task.id, title: task.title, body: task.notes
                ))
                loadMine()
                work.refreshNow()
                if case .task(let shown) = focus, shown.id == task.id {
                    loadFullTask(shown)
                }
            } catch {
                itemDetail.setTaskError((error as? StarlingsError)?.message ?? String(localized: "Couldn’t file that task"))
            }
        }
    }

    // MARK: - Mine, in place

    /// Done or not, from Mine, without opening the subject: the one edit worth
    /// a single click. Same write the subject pane makes; the row redraws
    /// first and Core is told second, and a refusal puts the row back.
    private func setMineDone(_ task: CrmMyTask, done: Bool) {
        if done { locallyDoneMineIDs.insert(task.id) } else { locallyDoneMineIDs.remove(task.id) }
        renderMine()
        Task { [weak self] in
            guard let self else { return }
            do {
                let updated = try await api.updateCrmTask(
                    id: task.id,
                    update: .completion(done)
                )
                // The middle column may be reading the very row that was
                // ticked; it has to agree with the list beside it.
                itemDetail.refresh(
                    task: updated,
                    canFile: updated.projectID != nil && updated.githubIssueNumber == nil
                )
                loadRecentlyClosed()
                work.refreshNow()
            } catch {
                if done { locallyDoneMineIDs.remove(task.id) } else { locallyDoneMineIDs.insert(task.id) }
                setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t update that task"), tone: .danger)
                renderMine()
            }
        }
    }

    /// Cancel from any task row's menu: Mine, INBOX, Home or the subject's
    /// Tasks pane. The row leaves every list, so each list is re-read. The
    /// status editor and the board can reopen it.
    private func cancelTask(id: String) {
        Task { [weak self] in
            guard let self else { return }
            do {
                let updated = try await api.updateCrmTask(id: id, update: .cancellation)
                itemDetail.refresh(
                    task: updated,
                    canFile: updated.projectID != nil && updated.githubIssueNumber == nil
                )
                loadTasks(resetFilter: false)
                loadMine()
                loadInbox()
                subjectOverview.reloadWork()
                work.refreshNow()
            } catch {
                setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t cancel that task"), tone: .danger)
            }
        }
    }

    /// Delete a task after the question was answered. A refusal
    /// is the window's red line with Copy; the Worker's own message first.
    private func deleteTask(id: String) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await api.deleteCrmTask(id: id)
                taskWasDeleted(id: id)
            } catch {
                setStatus((error as? StarlingsError)?.message ?? TaskDeleteCopy.failure, tone: .danger)
            }
        }
    }

    /// A task is gone: its row leaves at once, a page that showed
    /// it closes, and every list that can hold it reads again.
    private func taskWasDeleted(id: String) {
        loadedTasks.removeAll { $0.id == id }
        if let groups = organizationGroups {
            organizationGroups = groups.removing(taskID: id)
        }
        renderTasks()
        cardBoard.remove(cardID: id)
        inspector.closeIfShowing(taskID: id)
        itemDetail.closeIfShowing(taskID: id)
        loadTasks(resetFilter: false)
        loadMine()
        loadInbox()
        subjectOverview.reloadWork()
        work.refreshNow()
    }

    /// Close or reopen an issue from any row's menu: Mine, INBOX, the
    /// subject's Issues pane or its Overview. Every list that can show it
    /// is re-read.
    private func setIssueState(_ issue: CrmIssue, projectID: String?, _ change: WorkIssueStateChange) {
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await api.updateCrmIssue(.stateChange(change, issue: issue, projectID: projectID))
                loadIssues()
                loadMine()
                loadInbox()
                subjectOverview.reloadWork()
                work.refreshNow()
            } catch {
                setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t update that issue"), tone: .danger)
            }
        }
    }

    @objc private func reopenRecentlyClosedItem(_ sender: NSButton) {
        guard let item = recentlyClosed.first(where: { "\($0.kind.rawValue):\($0.id)" == sender.identifier?.rawValue }) else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                switch item.kind {
                case .task:
                    _ = try await api.updateCrmTask(id: item.id, update: .completion(false))
                case .issue:
                    guard let issue = item.issue else { return }
                    _ = try await api.updateCrmIssue(.stateChange(.reopen, issue: issue, projectID: item.projectID))
                }
                recentlyClosed.removeAll { $0.id == item.id && $0.kind == item.kind }
                loadMine()
                loadRecentlyClosed()
                work.refreshNow()
                setStatus(nil, from: .mine)
            } catch {
                setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t reopen that work"), tone: .danger)
            }
        }
    }

    /// Hand a task from Mine to GitHub. A hand-off, not a sync — see the
    /// subject pane's `promote`.
    private func promoteMine(_ task: CrmMyTask) {
        guard let projectID = task.projectID else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await api.createCrmIssue(.promotion(
                    projectID: projectID, taskID: task.id, title: task.title, body: nil
                ))
                loadMine()
                work.refreshNow()
            } catch {
                setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t file that task"), tone: .danger)
            }
        }
    }

    /// Only your own. The Worker takes the address from the session, so this
    /// cannot name somebody else however it is asked.
    @objc private func askGithubLogin() {
        let alert = NSAlert()
        alert.messageText = String(localized: "Your GitHub username")
        alert.informativeText = String(localized: "Used to find the issues assigned to you.")
        alert.addButton(withTitle: String(localized: "Save"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        let field = StarlingsTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 28))
        field.placeholderString = "octocat"
        field.stringValue = githubLogin ?? ""
        alert.accessoryView = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let wanted = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        Task { [weak self] in
            guard let self else { return }
            do {
                githubLogin = try await api.setCrmGithubLogin(wanted.isEmpty ? nil : wanted)
                loadMine()
            } catch {
                setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t save that username"), tone: .danger)
            }
        }
    }

    // MARK: - The subject's own panes

    /// Done or not, straight into Core — the same write the live meeting's
    /// panel makes. From the row, the panel has already redrawn the tick and
    /// must not be reloaded out from under it. From the inspector the list
    /// knows nothing yet, so it is reloaded; the inspector keeps the task on
    /// screen with a Reopen button, so a tick there can still be taken back.
    /// A failure puts things back by reloading from Core rather than guessing.
    private func setTaskDone(_ task: CrmTask, done: Bool, fromInspector: Bool = false) {
        if !fromInspector {
            tasksControls.setTaskDoneLocally(task, done: done)
        }
        Task { [weak self] in
            guard let self else { return }
            do {
                let updated = try await api.updateCrmTask(
                    id: task.id,
                    update: .completion(done)
                )
                inspector.refresh(task: updated, canFile: canFile(updated))
                if fromInspector { loadTasks() }
                subjectOverview.reloadWork()
                loadMine()
                work.refreshNow()
            } catch {
                let message = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t update that task")
                if fromInspector {
                    inspector.setTaskError(message)
                } else {
                    tasksControls.setTaskDoneLocally(task, done: !done)
                    tasksControls.setRefreshFailed(message)
                }
            }
        }
    }

    /// Only a project can have repositories; a lead is a conversation before
    /// there is code. An unlinked project hides the section rather than
    /// claiming zero issues, and a failure hides it too: GitHub being
    /// unreachable must not obscure the tasks beside it.
    /// A fresh question: a different subject, a changed filter, or a write
    /// that means the answer moved. Always starts at the first page.
    private func loadIssues() {
        issuePage = 1
        loadIssues(page: 1, appending: false)
    }

    private func loadIssues(page: Int, appending: Bool) {
        issueTask?.cancel()
        if !appending {
            issues = []
            issuesHaveMore = false
            renderIssues()
        }
        guard let subject = selected, subject.kind == "project" else {
            isLinkedToGitHub = false
            applyPane()
            return
        }
        issuesLoadingMore = appending
        if appending { renderIssues() }
        issueTask = Task { [weak self] in
            guard let self else { return }
            let answer = try? await api.crmIssues(projectID: subject.id, filter: issueFilter, page: page)
            guard !Task.isCancelled else { return }
            issuesLoadingMore = false
            isLinkedToGitHub = answer?.linked ?? false
            let found = isLinkedToGitHub ? (answer?.issues ?? []) : []
            if appending {
                // A page boundary can repeat a row when something is filed
                // between the two reads; the reader wants it once.
                let known = Set(issues.map(\.id))
                issues += found.filter { !known.contains($0.id) }
            } else {
                issues = found
            }
            issuePage = page
            issuesHaveMore = answer?.hasMore ?? false
            // The menus are filled from what came back, so a repository with
            // no milestones never offers a milestone filter.
            issuesFilterBar.offer(issues)
            applyPane()
            renderIssues()
        }
    }

    @objc private func loadMoreIssuesPressed() {
        guard !issuesLoadingMore else { return }
        loadIssues(page: issuePage + 1, appending: true)
    }

    /// What the GITHUB rung says: how many issues, under which filter, and
    /// whether the list on screen is all of them. A count with a filter on it
    /// that did not say so would read as the repository's whole truth.
    private func issuesHeaderText(showing: Int) -> String {
        guard isLinkedToGitHub else { return "GITHUB" }
        let noun = issueFilter.state == .open ? String(localized: "OPEN") : issueFilter.state.menuTitle.uppercased()
        if issues.isEmpty { return "GITHUB — NO \(noun) ISSUES" }
        var text = String(localized: "GITHUB — \(showing) \(noun)")
        if showing != issues.count { text += " OF \(issues.count)" }
        if issuesHaveMore { text += "+" }
        return text
    }

    private func loadProjectRepos() {
        repoTask?.cancel()
        projectRepos = []
        guard let subject = selected, subject.kind == "project" else {
            applyPane()
            return
        }
        repoTask = Task { [weak self] in
            guard let self else { return }
            let repos = try? await api.crmProjectRepos(projectID: subject.id)
            guard !Task.isCancelled else { return }
            // A repository lookup can be unavailable while the issue route is
            // still healthy. Keep the generic GitHub marker in that case.
            projectRepos = repos ?? []
            for section in allSections {
                for case let row as WorkSidebarRowView in section.rows
                where row.selectionKey == AnyHashable(SidebarKey.subject(subject.id)) {
                    row.setSubtitle(subjectSubtitle(subject))
                }
            }
            applyPane()
        }
    }

    private func renderIssues() {
        issuesStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        // The one narrowing this side does: the search field, over what the
        // server already sent. Everything else was asked for.
        let shown = issues.filter(issueFilter.matches)
        issuesHeader.stringValue = issuesHeaderText(showing: shown.count)
        if shown.isEmpty && !issues.isEmpty {
            // A list emptied by typing has to say so, or it reads as a
            // repository that lost its issues.
            let empty = NSTextField(labelWithString: String(localized: "No issues match these filters."))
            empty.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            empty.textColor = StarlingsColors.secondaryText
            empty.translatesAutoresizingMaskIntoConstraints = false
            issuesStack.addArrangedSubview(empty)
        }
        defer { addLoadMoreRow(showing: shown.count) }
        for issue in shown {
            let row = WorkIssueRowView(
                issue: issue,
                isSelected: issue.id == inspectedIssueID,
                highlightedLabel: issueFilter.labels.first
            ) { [weak self] chosen in
                self?.openIssue(chosen)
            }
            row.projectID = selected?.kind == "project" ? selected?.id : nil
            row.onRowAction = { [weak self] action in self?.performRowAction(action) }
            row.favorites = favorites
            row.translatesAutoresizingMaskIntoConstraints = false
            issuesStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: issuesStack.widthAnchor).isActive = true
        }
    }

    /// The foot of the list, when GitHub has more than this. A count with no
    /// way to see the rest is a dead end; this is the way.
    private func addLoadMoreRow(showing: Int) {
        guard issuesHaveMore, isLinkedToGitHub else { return }
        let button = NSButton(
            title: issuesLoadingMore ? String(localized: "Loading…") : String(localized: "Load more from GitHub"),
            target: self,
            action: #selector(loadMoreIssuesPressed)
        )
        SettingsChrome.applySecondaryButton(
            button,
            title: issuesLoadingMore ? String(localized: "Loading…") : String(localized: "Load more from GitHub"),
            height: 26
        )
        button.isEnabled = !issuesLoadingMore
        // A search narrows what is on screen but not what GitHub holds, so a
        // filtered list has to say that the rest are unsearched.
        let note = showing == issues.count
            ? nil
            : "Typing filters the \(issues.count) loaded, not the rest."
        var views: [NSView] = [button]
        if let note {
            let label = NSTextField(labelWithString: note)
            label.font = .systemFont(ofSize: StarlingsTypography.scaled(10))
            label.textColor = StarlingsColors.secondaryText
            views.append(label)
        }
        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.edgeInsets = NSEdgeInsets(top: 6, left: 6, bottom: 4, right: 0)
        row.translatesAutoresizingMaskIntoConstraints = false
        issuesStack.addArrangedSubview(row)
    }

    /// A draft in the inspector, beside the issues it will join — the list
    /// stays readable while the title is being written.
    @objc private func newIssuePressed() {
        guard let subject = selected, subject.kind == "project" else { return }
        inspectedIssueID = nil
        renderIssues()
        inspect(.newIssue(subject))
    }

    /// A project shows Issues once a repository is linked: Core's marker on
    /// the summary, or what this session learned since it loaded.
    private var selectedHasRepository: Bool {
        guard let subject = selected, subject.kind == "project" else { return false }
        return subject.hasRepo || isLinkedToGitHub || !projectRepos.isEmpty
    }

    @objc private func addRepoPressed() {
        guard let subject = selected, subject.kind == "project", let window = view.window else { return }
        presentRepositoryPicker(over: window, projectID: subject.id) { _ in }
    }

    /// The picker as a sheet on `parentWindow`, which is the Work window or
    /// the project editor. `linked` runs after the link lands.
    private func presentRepositoryPicker(
        over parentWindow: NSWindow,
        projectID: String,
        linked: @escaping (CrmGithubRepo) -> Void
    ) {
        let picker = WorkRepositoryPicker(api: api)
        picker.onPick = { [weak self, weak picker] repo in
            guard let self, let picker else { return }
            picker.closeSheetWindow()
            self.linkRepository(repo, projectID: projectID, linked: linked)
        }
        picker.onCancel = { [weak picker] in
            picker?.closeSheetWindow()
        }
        let sheetWindow = NSWindow(
            contentRect: NSRect(origin: .zero, size: NSSize(width: 500, height: 440)),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        sheetWindow.title = String(localized: "Add repository")
        sheetWindow.contentViewController = picker
        sheetWindow.setContentSize(NSSize(width: 500, height: 440))
        sheetWindow.isReleasedWhenClosed = false
        sheetWindow.center()
        parentWindow.beginSheet(sheetWindow) { _ in
            sheetWindow.orderOut(nil)
        }
    }

    private func linkRepository(_ repo: CrmGithubRepo, projectID: String, linked done: @escaping (CrmGithubRepo) -> Void) {
        Task { [weak self] in
            guard let self else { return }
            do {
                let linked = try await api.addCrmProjectRepo(CrmProjectRepoCreate(
                    projectID: projectID,
                    owner: repo.owner,
                    repo: repo.repo,
                    label: repo.label,
                    milestone: repo.milestone,
                    isPrimary: projectRepos.isEmpty
                ))
                // The summary's repository marker comes from the next load.
                loadSubjects(debounced: false, refreshCounts: true)
                if selected?.id == projectID {
                    if !projectRepos.contains(where: { $0.id == linked.id }) {
                        projectRepos.append(linked)
                    }
                    isLinkedToGitHub = true
                    renderSidebar()
                    applyPane()
                    loadIssues()
                }
                done(linked)
            } catch {
                setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t link that repository"), tone: .danger)
            }
        }
    }

    /// Hand a task to GitHub. The task keeps a pointer to what it became; the
    /// two states stay independent, because this is a hand-off, not a sync.
    private func promote(_ task: CrmTask) {
        guard let subject = selected, subject.kind == "project", isLinkedToGitHub else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                let issue = try await api.createCrmIssue(.promotion(
                    projectID: subject.id, taskID: task.id, title: task.title, body: task.notes
                ))
                loadTasks()
                loadIssues()
                loadMine()
                work.refreshNow()
                // Filed from the inspector: follow the task to what it became.
                if case .task(let shown, _, _) = inspector.item, shown.id == task.id {
                    openIssue(issue)
                }
            } catch {
                let message = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t file that task")
                inspector.setTaskError(message)
                tasksControls.setUnavailable(message)
            }
        }
    }

    /// Opening an issue keeps somebody in the app: the body, the comments, a
    /// reply, and close or reopen, in the inspector beside the list. GitHub
    /// stays one button away for the rest.
    private func openIssue(_ issue: CrmIssue) {
        inspectedIssueID = issue.id
        tasksControls.setSelectedTaskID(nil)
        renderIssues()
        inspect(.issue(issue))
    }

    private func loadInteractions() {
        guard let subject = selected else {
            interactionsView.stop()
            return
        }
        interactionsView.show(subject)
    }

    private func loadTasks(resetFilter: Bool = true) {
        taskTask?.cancel()
        if resetFilter {
            loadedTasks = []
            taskFilter = CrmTaskFilter()
            tasksFilterBar.reset()
        }
        guard let subject = selected else {
            tasksControls.setUnavailable(String(localized: "Pick a project, lead or partner."))
            return
        }
        let projectID = subject.kind == "project" ? subject.id : nil
        let leadID = subject.kind == "lead" ? subject.id : nil
        let eventID = subject.kind == "event" ? subject.id : nil
        let organizationID = subject.kind == "organization" ? subject.id : nil
        // Last known first (docs/CACHING.md): the pane paints the subject's
        // last task list before Core answers, then the live read replaces it.
        if loadedTasks.isEmpty,
           let cached = api.snapshot(
               MeetingControlAPI.tasksSnapshotKey(projectID: projectID, leadID: leadID, eventID: eventID, organizationID: organizationID),
               as: CrmTasksResponse.self
           ) {
            loadedTasks = cached.value.tasks
            tasksUpdatedAt = cached.savedAt
            tasksFilterBar.offer(loadedTasks)
            renderTasks()
        } else {
            tasksControls.setLoading()
        }
        // By project re-reads its groups with the list, so a write shows in both.
        if tasksByProject, let organizationID { loadOrganizationGroups(organizationID) }
        taskTask = Task { [weak self] in
            guard let self else { return }
            do {
                let tasks = try await api.crmTasks(projectID: projectID, leadID: leadID, eventID: eventID, organizationID: organizationID)
                guard !Task.isCancelled else { return }
                loadedTasks = tasks
                tasksUpdatedAt = Date()
                tasksFilterBar.offer(tasks)
                renderTasks()
            } catch {
                guard !Task.isCancelled else { return }
                let message = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t load tasks")
                if loadedTasks.isEmpty {
                    tasksControls.setUnavailable(message)
                } else {
                    // The snapshot stays; the pane says it is old and the
                    // window's line offers Retry.
                    tasksControls.setRefreshFailed(
                        tasksUpdatedAt.map { "\(message) · \(SnapshotStore.updatedLabel($0))" } ?? message
                    )
                    setRefreshFailure(message, from: .subjects, updatedAt: tasksUpdatedAt) { [weak self] in
                        self?.loadTasks(resetFilter: false)
                    }
                }
            }
        }
    }

    /// Tasks are a complete subject list, so the filter changes the visible
    /// rows immediately and keeps the list stable while somebody edits one.
    private func renderTasks() {
        let organizationID = selected?.kind == "organization" ? selected?.id : nil
        byProjectButton.isHidden = organizationID == nil
        byProjectButton.state = tasksByProject ? .on : .off
        byProjectButton.contentTintColor = tasksByProject ? StarlingsColors.accent : StarlingsColors.secondaryText
        if tasksByProject, let organizationID {
            guard let groups = organizationGroups, organizationGroupsID == organizationID else {
                loadOrganizationGroups(organizationID)
                return
            }
            // The pane's own filters narrow each project; an emptied project leaves.
            let projects = groups.projects.compactMap { project -> CrmOrganizationProjectTaskGroups.Project? in
                let tasks = narrowTasks(project.tasks)
                guard !tasks.isEmpty else { return nil }
                return CrmOrganizationProjectTaskGroups.Project(id: project.id, title: project.title, status: project.status, tasks: tasks)
            }
            tasksControls.setProjectGroups(projects, organizationID: organizationID, failureLine: groups.failureLine)
            return
        }
        tasksControls.setTasks(narrowTasks(loadedTasks), subject: selected)
    }

    /// The pane's filter and sort, over any list of this subject's tasks.
    private func narrowTasks(_ list: [CrmTask]) -> [CrmTask] {
        list
            .filter(taskFilter.matches)
            .sorted { left, right in
                switch taskFilter.sort {
                case .title:
                    let order = left.title.localizedCaseInsensitiveCompare(right.title)
                    return taskFilter.ascending ? order == .orderedDescending : order == .orderedAscending
                case .due:
                    let leftDate = CrmTaskDate.date(left.dueDate)
                    let rightDate = CrmTaskDate.date(right.dueDate)
                    switch (leftDate, rightDate) {
                    case let (left?, right?):
                        return taskFilter.ascending ? left > right : left < right
                    case (nil, _?): return false
                    case (_?, nil): return true
                    case (nil, nil): return left.title.localizedCaseInsensitiveCompare(right.title) == .orderedAscending
                    }
                case .updated:
                    let leftDate = CrmTaskDate.date(left.updatedAt) ?? .distantPast
                    let rightDate = CrmTaskDate.date(right.updatedAt) ?? .distantPast
                    return taskFilter.ascending ? leftDate < rightDate : leftDate > rightDate
                }
            }
    }

    @objc private func byProjectPressed() {
        tasksByProject.toggle()
        UserDefaults.standard.set(tasksByProject, forKey: CrmOrganizationProjectTaskGroups.byProjectDefaultsKey)
        renderTasks()
    }

    /// Read an organization's Tasks By project. A failed read is
    /// the pane's red line; the flat list stays one toggle away.
    private func loadOrganizationGroups(_ organizationID: String) {
        organizationGroupsTask?.cancel()
        if organizationGroupsID != organizationID {
            organizationGroups = nil
            organizationGroupsID = organizationID
        }
        if organizationGroups == nil { tasksControls.setLoading() }
        organizationGroupsTask = Task { [weak self] in
            guard let self else { return }
            do {
                let groups = try await api.crmOrganizationProjectTasks(organizationID: organizationID)
                guard !Task.isCancelled, organizationGroupsID == organizationID else { return }
                organizationGroups = groups
                renderTasks()
            } catch {
                guard !Task.isCancelled, organizationGroupsID == organizationID else { return }
                let message = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t load tasks")
                tasksControls.setRefreshFailed(message)
                setStatus(message, from: .subjects, tone: .danger) { [weak self] in
                    self?.loadOrganizationGroups(organizationID)
                }
            }
        }
    }

    /// New task when `existing` is nil, edit when it is not — the same sheet
    /// the live meeting uses, so a task typed in a call and a task typed here
    /// are the same act with the same fields. A new one needs a subject to
    /// belong to; an edit only needs the task.
    /// A failed goal or decision write, said once. The sheet is gone by then,
    /// so an alert is the surface; Copy carries the message to a report.
    private func presentError(_ error: Error, fallback: String) {
        let alert = NSAlert()
        alert.messageText = fallback
        alert.informativeText = (error as? StarlingsError)?.message ?? error.localizedDescription
        alert.alertStyle = .warning
        alert.addButton(withTitle: String(localized: "OK"))
        _ = alert.addCopyErrorButton()
        if let window = view.window { alert.beginSheetModal(for: window) } else { alert.runModal() }
    }

    /// A goal on a project. No channel line: a goal is direction,
    /// not an event, and the Overview lists it.
    private func composeGoal(subject: CrmSubject) {
        GoalSheet.present(over: view.window, initial: GoalSheet.Draft(title: "", targetDate: nil, owner: nil), team: team) { [weak self] draft in
            guard let self else { return }
            Task {
                do {
                    _ = try await self.api.createCrmGoal(CrmGoalCreate(
                        projectID: subject.id,
                        title: draft.title,
                        targetDate: draft.targetDate.map { CrmTaskDate.civilDay($0) },
                        owner: draft.owner
                    ))
                    self.subjectOverview.loadGoals(for: subject)
                } catch {
                    self.presentError(error, fallback: String(localized: "Couldn’t create that goal"))
                }
            }
        }
    }

    /// A decision on any subject. The route writes the channel
    /// line; the Overview re-reads its list.
    private func composeDecision(subject: CrmSubject) {
        DecisionSheet.present(over: view.window, initial: DecisionSheet.Draft(body: "", goalID: nil), goals: subjectOverview.liveGoals) { [weak self] draft in
            guard let self else { return }
            Task {
                do {
                    _ = try await self.api.createCrmDecision(CrmDecisionCreate(
                        subjectKind: subject.kind,
                        subjectID: subject.id,
                        body: draft.body,
                        goalID: draft.goalID
                    ))
                    self.subjectOverview.loadDecisions(for: subject)
                } catch {
                    self.presentError(error, fallback: String(localized: "Couldn’t record that decision"))
                }
            }
        }
    }

    private func composeTask(_ existing: CrmTask?, subject: CrmSubject?) {
        guard existing != nil || subject != nil else { return }
        let initial = MeetingTaskEditor.Draft(
            title: existing?.title ?? "",
            notes: existing?.notes ?? "",
            status: existing?.status ?? .pending,
            // Most work a meeting produces is ours. Starting at `team` is the
            // honest default, and it is what puts the assignee menu in front of
            // somebody rather than behind a choice they have to make first.
            responsible: existing?.responsibleParty ?? .team,
            assignedTo: existing?.assigneeID,
            dueDate: CrmTaskDate.date(existing?.dueDate),
            goalID: existing?.goalID
        )
        // The Goal row only on a project: the goals shown are the Overview's
        // live ones, plus the one this task already serves if it has closed.
        let projectID = existing?.projectID ?? (subject?.kind == "project" ? subject?.id : nil)
        let goals = projectID != nil && projectID == selected?.id ? subjectOverview.liveGoals : []
        MeetingTaskEditor.present(
            over: view.window,
            title: existing == nil ? String(localized: "New task") : String(localized: "Edit task"),
            initial: initial,
            team: team,
            goals: goals
        ) { [weak self] draft in
            guard let self else { return }
            Task {
                do {
                    if let existing {
                        let updated = try await self.api.updateCrmTask(
                            id: existing.id,
                            update: CrmTaskUpdate(
                                title: draft.title,
                                notes: draft.notes.isEmpty ? nil : draft.notes,
                                status: draft.status.rawValue,
                                responsibleParty: draft.responsible.rawValue,
                                assignedTo: Patch(draft.assignedTo),
                                dueDate: Patch(draft.dueDate.map(CrmTaskDate.wire)),
                                goalID: goals.isEmpty ? .omit : Patch(draft.goalID)
                            )
                        )
                        self.inspector.refresh(task: updated, canFile: self.canFile(updated))
                        self.itemDetail.refresh(
                            task: updated,
                            canFile: updated.projectID != nil && updated.githubIssueNumber == nil
                        )
                    } else if let subject {
                        _ = try await self.api.createCrmTask(
                            CrmTaskCreate(
                                title: draft.title,
                                notes: draft.notes.isEmpty ? nil : draft.notes,
                                status: draft.status.rawValue,
                                responsibleParty: draft.responsible.rawValue,
                                assignedTo: Patch(draft.assignedTo),
                                dueDate: draft.dueDate.map(CrmTaskDate.wire),
                                projectID: subject.kind == "project" ? subject.id : nil,
                                leadID: subject.kind == "lead" ? subject.id : nil,
                                eventID: subject.kind == "event" ? subject.id : nil,
                                organizationID: subject.kind == "organization" ? subject.id : nil,
                                goalID: draft.goalID
                            )
                        )
                    }
                    self.loadTasks()
                    self.loadMine()
                    self.work.refreshNow()
                } catch {
                    self.tasksControls.setUnavailable(
                        (error as? StarlingsError)?.message ?? String(localized: "Couldn’t save that task")
                    )
                }
            }
        }
    }
}

/// A small Core-backed typeahead. The picker chooses from repositories the
/// GitHub App can actually see; it never accepts an arbitrary URL or asks Meet
/// to hold a GitHub credential.
@MainActor
private final class WorkRepositoryPicker: NSViewController {
    var onPick: ((CrmGithubRepo) -> Void)?
    var onCancel: (() -> Void)?

    private let api: MeetingControlAPI
    private let searchField = StarlingsSearchField(placeholder: String(localized: "Search"))
    private let statusLabel = StarlingsNoticeView()
    private let resultsStack = NSStackView()
    private let scrollView = NSScrollView()
    private let cancelButton = NSButton(title: String(localized: "Cancel"), target: nil, action: nil)
    private var results: [CrmGithubRepo] = []
    private var searchTask: Task<Void, Never>?

    init(api: MeetingControlAPI) {
        self.api = api
        super.init(nibName: nil, bundle: nil)
        title = "Add repository"
        preferredContentSize = NSSize(width: 500, height: 440)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func loadView() {
        let root = NSView()
        root.wantsLayer = true
        root.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.canvas, for: root).cgColor
        view = root

        let titleLabel = NSTextField(labelWithString: String(localized: "Link a GitHub repository"))
        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(18), weight: .semibold)
        titleLabel.textColor = StarlingsColors.primaryText

        let explanation = StarlingsTypography.wrappingLabel(String(localized: "Choose a repository available to the workspace’s GitHub App."))
        explanation.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        explanation.textColor = StarlingsColors.secondaryText

        searchField.configure(
            placeholder: String(localized: "Search"),
            target: self,
            action: #selector(searchChanged)
        )

        statusLabel.hidesWhenEmpty = false
        statusLabel.label.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        statusLabel.label.allowSqueezing()

        resultsStack.orientation = .vertical
        resultsStack.alignment = .leading
        resultsStack.spacing = 2
        resultsStack.translatesAutoresizingMaskIntoConstraints = false

        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.borderType = .noBorder
        scrollView.contentView = WorkFlippedClipView()
        scrollView.documentView = resultsStack
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        cancelButton.bezelStyle = .inline
        cancelButton.controlSize = .regular
        SettingsChrome.applyQuietButton(cancelButton)
        cancelButton.target = self
        cancelButton.action = #selector(cancelPressed)
        // A sheet window has no close button; Escape is the keyboard way out.
        cancelButton.keyEquivalent = "\u{1b}"

        let buttons = NSStackView(views: [NSView(), cancelButton])
        buttons.orientation = .horizontal
        buttons.alignment = .centerY
        buttons.translatesAutoresizingMaskIntoConstraints = false

        for child in [titleLabel, explanation, searchField, statusLabel, scrollView, buttons] {
            child.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(child)
        }

        NSLayoutConstraint.activate([
            titleLabel.topAnchor.constraint(equalTo: root.topAnchor, constant: 24),
            titleLabel.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
            titleLabel.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
            explanation.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 4),
            explanation.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            explanation.trailingAnchor.constraint(equalTo: titleLabel.trailingAnchor),
            searchField.topAnchor.constraint(equalTo: explanation.bottomAnchor, constant: 16),
            searchField.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            searchField.trailingAnchor.constraint(equalTo: titleLabel.trailingAnchor),
            statusLabel.topAnchor.constraint(equalTo: searchField.bottomAnchor, constant: 10),
            statusLabel.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            statusLabel.trailingAnchor.constraint(equalTo: titleLabel.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 4),
            scrollView.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: titleLabel.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: buttons.topAnchor, constant: -12),
            resultsStack.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor),
            buttons.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            buttons.trailingAnchor.constraint(equalTo: titleLabel.trailingAnchor),
            buttons.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -18),
        ])
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        // Search is opt-in here too; opening the picker should not place a
        // caret in the first text field automatically.
        view.window?.makeFirstResponder(nil)
        loadRepositories()
    }

    override func viewDidDisappear() {
        super.viewDidDisappear()
        searchTask?.cancel()
    }

    @objc private func searchChanged() {
        loadRepositories()
    }

    private func loadRepositories() {
        searchTask?.cancel()
        let query = searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        statusLabel.setText(query.isEmpty ? String(localized: "Loading repositories…") : String(localized: "Searching…"))
        searchTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(180))
            guard let self, !Task.isCancelled else { return }
            do {
                let repos = try await api.crmGithubRepos(query: query)
                guard !Task.isCancelled else { return }
                results = repos
                render()
            } catch {
                guard !Task.isCancelled else { return }
                results = []
                statusLabel.showError((error as? StarlingsError)?.message ?? String(localized: "Couldn’t search repositories"))
                render()
            }
        }
    }

    private func render() {
        resultsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        guard !results.isEmpty else {
            if statusLabel.tone != .danger {
                statusLabel.setText(searchField.stringValue.isEmpty
                    ? String(localized: "No repositories available.")
                    : "No repositories match.")
            }
            return
        }
        statusLabel.setText(String(localized: "Choose a repository"))
        for (index, repo) in results.enumerated() {
            let button = NSButton(title: repo.address, target: self, action: #selector(repoPressed(_:)))
            button.tag = index
            button.bezelStyle = .inline
            button.controlSize = .regular
            button.alignment = .left
            SettingsChrome.applyQuietButton(button)

            var details: [String] = []
            if let label = repo.label, !label.isEmpty { details.append(label) }
            if let milestone = repo.milestone, !milestone.isEmpty { details.append(milestone) }
            let detail = NSTextField(labelWithString: details.joined(separator: " · "))
            detail.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            detail.textColor = StarlingsColors.secondaryText
            detail.allowSqueezing()
            detail.isHidden = details.isEmpty

            let row = NSStackView(views: [button, detail])
            row.orientation = .vertical
            row.alignment = .leading
            row.spacing = 0
            row.translatesAutoresizingMaskIntoConstraints = false
            resultsStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: resultsStack.widthAnchor).isActive = true
            row.heightAnchor.constraint(greaterThanOrEqualToConstant: details.isEmpty ? 34 : 46).isActive = true
        }
    }

    @objc private func repoPressed(_ sender: NSButton) {
        guard results.indices.contains(sender.tag) else { return }
        onPick?(results[sender.tag])
    }

    @objc private func cancelPressed() {
        onCancel?()
    }
}

/// One GitHub issue. Clicking reads it: in the middle column when it came
/// from the sidebar, in the inspector when it came from a subject's own list.
/// Either way the issue is GitHub's row, and Meet shows it rather than owning
/// it.
@MainActor
private final class WorkIssueRowView: WorkListRowView {
    /// Performs Close issue, Close as not planned or Reopen issue.
    var onRowAction: ((WorkRowAction) -> Void)?
    /// The project whose list this row is in; nil in Mine.
    var projectID: String?
    var favorites: StarredWatch?
    /// Who Assign to ▸ offers; set on an UNOWNED row, whose menu is the registry's `unowned`.
    var assignTeam: [CrmTeamMember]?
    /// The signed-in address, listed first in Assign to ▸ as "Me".
    var assignMe: String?
    /// Who the row can be handed to.
    var agents: [Peer] = []
    private let issue: CrmIssue
    private let onSelect: (CrmIssue) -> Void

    init(
        issue: CrmIssue,
        isSelected: Bool = false,
        highlightedLabel: String? = nil,
        onSelect: @escaping (CrmIssue) -> Void
    ) {
        self.issue = issue
        self.onSelect = onSelect

        let mark = WorkGlyphMarkView(
            diameter: WorkListRowView.leadingSlot,
            content: .symbol(WorkIssueRowView.symbol(for: issue)),
            accessibilityLabel: issue.stateSummary,
            shape: .square
        )
        mark.setAccessibilityElement(false)
        mark.setContentHuggingPriority(.required, for: .horizontal)

        let title = NSTextField(labelWithString: issue.title)
        title.font = WorkListRowView.titleFont()
        title.textColor = StarlingsColors.primaryText
        title.maximumNumberOfLines = 1
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let detail = NSTextField(labelWithString: WorkIssueRowView.meta(for: issue))
        detail.font = WorkListRowView.detailFont()
        detail.textColor = StarlingsColors.secondaryText
        detail.maximumNumberOfLines = 1
        detail.lineBreakMode = .byTruncatingTail

        var headlineViews: [NSView] = [title]
        if !issue.drawableLabels.isEmpty {
            headlineViews.append(
                StarlingsIssueSummaryPills(
                    issue.drawableLabels,
                    highlightedLabel: highlightedLabel
                )
            )
        }
        let headline = NSStackView(views: headlineViews)
        headline.orientation = .horizontal
        headline.alignment = .centerY
        headline.spacing = 6
        headline.translatesAutoresizingMaskIntoConstraints = false

        let text = NSStackView(views: [headline, detail])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = WorkListRowView.textSpacing
        text.translatesAutoresizingMaskIntoConstraints = false

        super.init(
            content: WorkListRowView.content(leading: mark, text: text),
            isSelected: isSelected,
            accessibilityLabel: WorkIssueRowView.accessibilityLabel(for: issue),
            onActivate: { onSelect(issue) }
        )
    }

    /// GitHub's own marks: an open issue is a ring, a finished one a tick, and
    /// one closed as not planned is neither — it was decided against, and a
    /// tick beside it would read as work that got done.
    private static func symbol(for issue: CrmIssue) -> String {
        if issue.isOpen { return "smallcircle.filled.circle" }
        return issue.stateReason == "not_planned" ? "slash.circle" : "checkmark.circle"
    }

    /// Open, closed, and closed-not-planned already read apart by
    /// `symbol(for:)`'s three distinct glyphs — none of the three states is
    /// a success, a failure, or an action to take, so none of them spends a
    /// colour on top of the glyph.
    private static func tint(for _: CrmIssue) -> NSColor {
        StarlingsColors.secondaryText
    }

    /// Where it lives, who opened it and when, and what has accrued since —
    /// the line GitHub puts under a title, in the same order.
    private static func meta(for issue: CrmIssue) -> String {
        var parts = ["\(issue.repo) \(issue.shortReference)"]
        if let author = issue.author?.login { parts.append(String(localized: "by \(author)")) }
        if let opened = CrmTaskDate.date(issue.createdAt) {
            parts.append(StarlingsDateFormatting.date(opened))
        } else if let updated = CrmTaskDate.date(issue.updatedAt) {
            parts.append(String(localized: "updated ") + StarlingsDateFormatting.date(updated))
        }
        let owners = issue.assignees.isEmpty
            ? [issue.assigneeLogin].compactMap { $0 }
            : issue.assignees.map(\.login)
        if !owners.isEmpty { parts.append(String(localized: "Owners: \(owners.joined(separator: ", "))")) }
        if let milestone = issue.milestone { parts.append(milestone) }
        if let type = issue.issueType { parts.append(type) }
        if let sub = issue.subIssues { parts.append(String(localized: "\(sub.completed)/\(sub.total) done")) }
        if issue.comments > 0 {
            parts.append(issue.comments == 1 ? String(localized: "1 comment") : String(localized: "\(issue.comments) comments"))
        }
        return parts.joined(separator: " · ")
    }

    private static func accessibilityLabel(for issue: CrmIssue) -> String {
        var parts = [issue.title, "\(issue.repo) \(issue.shortReference)", issue.stateSummary]
        if !issue.drawableLabels.isEmpty {
            parts.append(String(localized: "Labels: \(issue.drawableLabels.map(\.name).joined(separator: ", "))"))
        }
        return parts.joined(separator: ", ")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Right-click: the same read the row's own click gives, close or
    /// reopen, then GitHub's copy — the issue is GitHub's row, so leaving it
    /// without one would send people hunting for the link elsewhere.
    override func menu(for event: NSEvent) -> NSMenu? {
        let groups = issue.rowActions(
            projectID: projectID,
            context: assignTeam == nil ? .row : .unowned,
            client: .mac,
            team: assignTeam ?? [],
            me: assignMe,
            agents: onRowAction == nil ? [] : agents
        ).map { group in
            group.filter { action in
                if case .setIssueState = action { return onRowAction != nil }
                if action.isAssign { return onRowAction != nil }
                return true
            }
        }.filter { !$0.isEmpty }
        let menu = NSMenu.workRow(groups) { [weak self] action in
            guard let self else { return }
            if let onRowAction = self.onRowAction {
                onRowAction(action)
                return
            }
            switch action {
            case .open: self.openPressed()
            case .openGitHub(let url): NSWorkspace.shared.open(url)
            case .copyLink(let link):
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(link, forType: .string)
            default: break
            }
        } ?? NSMenu()
        if let favorites {
            if !menu.items.isEmpty { menu.addItem(.separator()) }
            let target = FavoriteTarget(
                kind: .githubIssue,
                targetRef: "\(issue.owner.lowercased())/\(issue.repo.lowercased())#\(issue.number)"
            )
            menu.addFavoriteAction(target, watch: favorites, window: window)
        }
        return menu
    }

    @objc private func openPressed() { onSelect(issue) }
}

/// One task from the cross-subject list: what, when, and which project it came
/// from — unreadable without the last of those. The tick box acts here, so
/// what you owe can be ticked off where it is read; the row itself reads the
/// task in full, and the menu is the shared `mine` task menu.
@MainActor
private final class WorkMyTaskRowView: WorkListRowView {
    var onToggleDone: ((CrmMyTask, Bool) -> Void)?
    /// Opens the same inspector used by issue rows, where every task field can
    /// be edited without inventing a second inline form for the sidebar.
    var onEditTask: ((CrmMyTask) -> Void)?
    /// Performs a choice from the shared menu (`WorkRowAction`).
    var onRowAction: ((WorkRowAction) -> Void)?
    /// Who Assign to ▸ offers; set on an UNOWNED row, whose menu is the registry's `unowned`.
    var assignTeam: [CrmTeamMember]?
    /// The signed-in address, listed first in Assign to ▸ as "Me".
    var assignMe: String?
    /// Who the row can be handed to.
    var agents: [Peer] = []
    private let task: CrmMyTask
    private let favorites: StarredWatch
    private let isDone: Bool
    private let onSelect: (CrmMyTask) -> Void

    /// No avatar. Every row in Mine is yours by definition — that is what the
    /// list is — so a picture of yourself on each one is a column of the same
    /// face saying nothing, in the space the title wanted.
    init(
        task: CrmMyTask,
        favorites: StarredWatch,
        isDone: Bool,
        isSelected: Bool,
        onSelect: @escaping (CrmMyTask) -> Void
    ) {
        self.task = task
        self.favorites = favorites
        self.isDone = isDone
        self.onSelect = onSelect

        var parts: [String] = [task.status.menuTitle]
        if let due = CrmTaskDate.date(task.dueDate) {
            parts.append(StarlingsDateFormatting.date(due))
        }
        if let priority = task.priority, priority != "medium" {
            parts.append(priority)
        }
        if let subject = task.subjectTitle { parts.append(subject) }
        if let number = task.githubIssueNumber { parts.append("#\(number)") }

        let (content, toggle) = WorkTaskRowContent.build(
            title: task.title,
            isDone: isDone,
            isLate: task.isOverdue && !isDone,
            detailParts: parts
        )
        super.init(
            content: content,
            isSelected: isSelected,
            accessibilityLabel: isDone ? String(localized: "\(task.title), done") : task.title,
            onActivate: { onSelect(task) }
        )
        toggle.target = self
        toggle.action = #selector(togglePressed)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Right-click: the registry's `mine` menu, the same one INBOX, Home and
    /// the phone draw, then Edit. A ticked row has no Done or Cancel (its
    /// tick box takes it back), and the row is already in Mine, so "Open in
    /// Mine" is left out.
    override func menu(for event: NSEvent) -> NSMenu? {
        let isDone = isDone
        let actions = assignTeam.map { task.rowActions(context: .unowned, team: $0, me: assignMe, agents: agents) }
            ?? task.rowActions(context: .mine, agents: agents)
        let groups = actions.map { group in
            group.filter { action in
                switch action {
                case .complete, .cancel: return !isDone
                case .open(let destination, _):
                    if case .mine = destination.target { return false }
                    return true
                default: return true
                }
            }
        }
        let menu = NSMenu.workRow(groups) { [weak self] action in self?.onRowAction?(action) } ?? NSMenu()
        if onEditTask != nil {
            if !menu.items.isEmpty { menu.addItem(.separator()) }
            let edit = menu.addItem(withTitle: String(localized: "Edit task…"), action: #selector(editTaskPressed), keyEquivalent: "").symbol(.edit)
            edit.target = self
        }
        if !menu.items.isEmpty { menu.addItem(.separator()) }
        menu.addFavoriteAction(
            FavoriteTarget(kind: .crmTask, targetRef: task.id.lowercased()),
            watch: favorites,
            window: window
        )
        return menu.items.isEmpty ? nil : menu
    }

    @objc private func editTaskPressed() {
        onEditTask?(task)
    }

    @objc private func togglePressed() {
        onToggleDone?(task, !isDone)
    }

}

/// The sidebar grows downward, like the agenda and the roster.
/// Shared with `WorkLoungeView`: two scrolling lists in the same window must
/// both start at the top rather than at the bottom.
final class WorkFlippedClipView: NSClipView {
    override var isFlipped: Bool { true }
}

/// Two panes side by side that keep their *proportion*, not a pixel width:
/// Work's Overview (INBOX | MINE) and a subject's Overview (Talk | Work)
/// share it. The divider is the user's; what is saved is the fraction it
/// leaves on the leading side, so a window resize grows or shrinks both
/// panes together and neither is squeezed to nothing. The trailing pane sits
/// on the panel ground, one step off the canvas, so the two read as columns;
/// each pane brings its own scroll view and scrolls on its own.
@MainActor
final class StarlingsHalvesSplitView: NSSplitView {
    private let fractionKey: String
    private let minimumPane: CGFloat
    private var fraction: CGFloat
    /// The width `fraction` was last applied at; a new width re-places the
    /// divider, a drag at the same width is the user's and is saved.
    private var placedWidth: CGFloat = 0
    private var placing = false
    private let trailingGround = StarlingsShellBackdrop(ground: StarlingsColors.panel)
    private weak var leadingPane: NSView?
    /// `NSSplitView`'s sidebar selector checks can re-enter `respondsToSelector`
    /// through its delegate. Keep that delegate as a distinct object rather
    /// than making the split view delegate to itself.
    private var splitViewDelegate: StarlingsHalvesSplitViewDelegate?

    init(name: String, trailing: NSView, minimumPane: CGFloat = 240) {
        fractionKey = "MeetHalves.\(name).fraction"
        self.minimumPane = minimumPane
        let stored = CGFloat(UserDefaults.standard.double(forKey: fractionKey))
        fraction = stored > 0.05 && stored < 0.95 ? stored : 0.5
        super.init(frame: .zero)
        isVertical = true
        dividerStyle = .thin
        let splitViewDelegate = StarlingsHalvesSplitViewDelegate(owner: self)
        self.splitViewDelegate = splitViewDelegate
        delegate = splitViewDelegate
        translatesAutoresizingMaskIntoConstraints = false

        trailing.translatesAutoresizingMaskIntoConstraints = false
        trailingGround.addSubview(trailing)
        NSLayoutConstraint.activate([
            trailing.leadingAnchor.constraint(equalTo: trailingGround.leadingAnchor),
            trailing.trailingAnchor.constraint(equalTo: trailingGround.trailingAnchor),
            trailing.topAnchor.constraint(equalTo: trailingGround.topAnchor),
            trailing.bottomAnchor.constraint(equalTo: trailingGround.bottomAnchor),
        ])
        for host in [self, trailingGround] as [NSView] {
            host.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            host.setContentHuggingPriority(.defaultLow, for: .horizontal)
        }
        addArrangedSubview(trailingGround)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// The leading pane; replacing it keeps the saved proportion.
    func setLeading(_ view: NSView) {
        guard leadingPane !== view else { return }
        if let leadingPane { removeArrangedSubview(leadingPane); leadingPane.removeFromSuperview() }
        leadingPane = view
        view.translatesAutoresizingMaskIntoConstraints = false
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        insertArrangedSubview(view, at: 0)
        setHoldingPriority(.defaultLow, forSubviewAt: 0)
        setHoldingPriority(.defaultLow, forSubviewAt: 1)
        placedWidth = 0
        needsLayout = true
    }

    override func layout() {
        super.layout()
        guard arrangedSubviews.count == 2, bounds.width > 0, abs(bounds.width - placedWidth) > 0.5 else { return }
        placedWidth = bounds.width
        placing = true
        setPosition(clamped(available * fraction), ofDividerAt: 0)
        placing = false
    }

    private var available: CGFloat { max(0, bounds.width - dividerThickness) }

    private var floor: CGFloat { min(minimumPane, available / 2) }

    private func clamped(_ position: CGFloat) -> CGFloat {
        min(max(position, floor), available - floor)
    }

    fileprivate func constrainedMinimum(_ proposedMinimumPosition: CGFloat) -> CGFloat {
        max(proposedMinimumPosition, floor)
    }

    fileprivate func constrainedMaximum(_ proposedMaximumPosition: CGFloat) -> CGFloat {
        min(proposedMaximumPosition, available - floor)
    }

    fileprivate func rememberDividerDrag(_ notification: Notification) {
        // Only a drag carries the divider index; a window resize re-places
        // from the saved fraction in `layout()` instead of rewriting it.
        guard !placing, notification.userInfo?["NSSplitViewDividerIndex"] != nil,
              abs(bounds.width - placedWidth) <= 0.5, available > 0,
              let leading = arrangedSubviews.first else { return }
        fraction = leading.frame.width / available
        UserDefaults.standard.set(Double(fraction), forKey: fractionKey)
    }
}

/// The `NSSplitView` delegate must not be the split view itself: AppKit's
/// sidebar `respondsToSelector:` path can recurse through that self-reference.
@MainActor
private final class StarlingsHalvesSplitViewDelegate: NSObject, NSSplitViewDelegate {
    private weak var owner: StarlingsHalvesSplitView?

    init(owner: StarlingsHalvesSplitView) {
        self.owner = owner
        super.init()
    }

    func splitView(
        _ splitView: NSSplitView,
        constrainMinCoordinate proposedMinimumPosition: CGFloat,
        ofSubviewAt dividerIndex: Int
    ) -> CGFloat {
        owner?.constrainedMinimum(proposedMinimumPosition) ?? proposedMinimumPosition
    }

    func splitView(
        _ splitView: NSSplitView,
        constrainMaxCoordinate proposedMaximumPosition: CGFloat,
        ofSubviewAt dividerIndex: Int
    ) -> CGFloat {
        owner?.constrainedMaximum(proposedMaximumPosition) ?? proposedMaximumPosition
    }

    func splitViewDidResizeSubviews(_ notification: Notification) {
        owner?.rememberDividerDrag(notification)
    }
}
