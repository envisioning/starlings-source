import EnvisioningUI
import SwiftUI

/// The Calendar tab: a real calendar, not a list of the meetings Meet happens to
/// host. Day, week, month, and list over every calendar the owner has — Google
/// through the control plane, iCloud and on-device through EventKit — with the
/// same reads, writes, and merge rules the Mac window uses.
struct MobileCalendarScreen: View {
    @EnvironmentObject private var app: StarlingsAppModel
    @EnvironmentObject private var meetings: UpcomingMeetingsStore
    @StateObject private var store = MobileCalendarStore()
    /// Only for the meeting composer, which schedules against the owner's room
    /// and the public events feed rather than being a plain calendar write.
    @StateObject private var scheduler = ScheduleViewModel()

    @State private var sheet: MobileCalendarSheet?
    @State private var showsSources = false
    @State private var showsComposer = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Only once there is something true to say. Until the Worker
                // answers, the connection is unknown rather than absent, and a
                // banner that opens every launch with "Google Calendar isn't
                // connected" is wrong more often than it is right.
                if (store.googleConnectionKnown && !store.googleConnected)
                    || store.eventKitAccess == .denied {
                    connectBanner
                }
                if let failure = store.loadFailureMessage {
                    refreshBanner(failure)
                }
                content
            }
            .meetSurfaceBackground()
            // The month rides in the bar the app already has. A phone has one
            // screen of height and the grid should have all of it: the dates
            // are in the column heads, paging is a swipe, and reselecting the
            // Calendar tab is Today.
            .navigationTitle(store.periodTitle)
            .navigationBarTitleDisplayMode(.inline)
            // The bar every tab wears (`MobileSurfaceMenu`): the surface
            // menu, and Add. The store reloads on every page turn and tab
            // reselect, and the calendar list lives in Settings and behind
            // the connect banner.
            .meetSearchSheet()
            .meetSettingsSheet()
            .toolbar {
                MobileSurfaceMenu(settingsPage: .calendar, settingsTitle: "Calendar settings…") {
                    Picker("View", selection: $store.layout) {
                        ForEach(MobileCalendarLayout.allCases) { layout in
                            Label(layout.label, systemImage: layout.symbolName).tag(layout)
                        }
                    }
                    Divider()
                }
                MobileSurfaceAddMenu { addMenu }
            }
        }
        .task(id: app.ownerCredentials?.accessToken) {
            await store.attach(to: app)
            await scheduler.load(app: app)
            await revealPendingEvent()
        }
        .onChange(of: app.calendarTabActivation) { _, _ in
            store.goToToday()
        }
        // A Home row named an event while the tab was already up. When the
        // tab is being built for it, the attach above reveals it instead.
        .task(id: app.pendingCalendarEvent?.id) {
            await revealPendingEvent()
        }
        .onDisappear { store.detach() }
        .sheet(item: $sheet) { sheet in
            Group {
                switch sheet {
                case .create(let start, let end):
                    NavigationStack {
                        MobileCalendarEditorForm(store: store, initialStart: start, initialEnd: end)
                    }
                case .quickAdd:
                    NavigationStack {
                        MobileCalendarQuickAddView(store: store)
                    }
                case .detail(let group):
                    MobileCalendarEventDetail(store: store, group: group) { destination in
                        self.sheet = nil
                        app.pendingWork = destination
                        app.selectTab(.work)
                    }
                case .layer(let item):
                    MobileCalendarLayerDetail(item: item) { destination in
                        // The sheet goes first; Work takes the tab after.
                        self.sheet = nil
                        app.pendingWork = destination
                        app.selectTab(.work)
                    }
                }
            }
            .calendarErrorAlert(store)
        }
        .sheet(isPresented: $showsSources) {
            MobileCalendarSourcesView(store: store)
                .environmentObject(app)
                .calendarErrorAlert(store)
                .meetAlertHost()
        }
        .sheet(isPresented: $showsComposer) {
            Group {
                if let room = scheduler.room {
                    MobileScheduleComposer(
                        room: room,
                        events: meetings.agenda,
                        publicEvents: scheduler.publicEvents,
                        isCreating: scheduler.isCreating
                    ) { draft in
                        let created = await scheduler.create(draft, app: app)
                        if created { await store.reload(force: true) }
                        return created
                    }
                }
            }
            .calendarErrorAlert(store)
        }
        .calendarErrorAlert(store, active: !isPresentingSheet)
    }

    /// Two callers can arrive for the same event — the attach task and the
    /// pending task — so the event is claimed before the first await. Both
    /// used to get past the guard, and the second `sheet =` re-presented the
    /// detail: the sheet closed and opened again.
    private func revealPendingEvent() async {
        guard store.isAttached, let pending = app.pendingCalendarEvent else { return }
        app.pendingCalendarEvent = nil
        let group: CalendarEventGroup? = switch pending {
        case .feed(let event): await store.reveal(event)
        case .reference(let reference): await store.reveal(eventReference: reference)
        }
        guard let group else { return }
        sheet = .detail(group)
    }

    /// UIKit refuses to present an alert from a view controller that is already
    /// presenting a sheet, and SwiftUI drops the alert instead of queueing it —
    /// the failure never reaches the person who caused it. So the alert is
    /// carried by every level that can be on top, and only the top one arms it.
    private var isPresentingSheet: Bool { sheet != nil || showsSources || showsComposer }

    // MARK: - Chrome

    /// Two ways to add: a plain calendar event on any writable calendar, and the
    /// meeting composer, which schedules against the owner's room.
    private var addMenu: some View {
        Menu {
            Button {
                sheet = newEventSheet()
            } label: {
                Label("New event…", systemImage: "calendar.badge.plus")
            }
            .disabled(store.writableCalendars.isEmpty)
            Button {
                sheet = .quickAdd
            } label: {
                Label("Quick add event…", systemImage: "text.badge.plus")
            }
            .disabled(store.writableCalendars.isEmpty)
            Button {
                showsComposer = true
            } label: {
                Label("Schedule a meeting…", systemImage: "video.badge.plus")
            }
            .disabled(scheduler.room == nil)
        } label: {
            Image(systemName: "plus")
        }
        .accessibilityLabel("Add")
    }

    @ViewBuilder
    private var connectBanner: some View {
        Button {
            showsSources = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.circle")
                Text(bannerMessage).font(.caption)
                Spacer()
                Image(systemName: "chevron.right").font(.caption2)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(StarlingsMobileColors.panel)
        }
        .buttonStyle(.plain)
        .meetHoverLift(cornerRadius: 0)
    }

    /// A refresh that did not land, said where it happened and nowhere else.
    ///
    /// This used to be the modal alert, which was the wrong shape for it twice
    /// over: the period on screen had already drawn from the cached months, so
    /// nothing was blocked, and the only action worth offering — try again — is
    /// not what an OK button does. Tapping the banner is that action.
    private func refreshBanner(_ message: String) -> some View {
        StarlingsInlineRetry(message: message) {
            Task { await store.reload(force: true) }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(StarlingsMobileColors.panel)
    }

    private var bannerMessage: String {
        if !store.isSignedIn { return String(localized: "Sign in") }
        if !store.googleConnected { return "Google Calendar isn’t connected" }
        return String(localized: "Calendar access is off for Starlings")
    }

    // MARK: - Body

    @ViewBuilder
    private var content: some View {
        switch store.layout {
        case .day, .twoDay, .threeDay:
            MobileCalendarTimeGrid(
                store: store,
                onSelect: { sheet = .detail($0) },
                onSelectLayer: { sheet = .layer($0) },
                onCreate: {
                    sheet = .create(
                        start: $0,
                        end: $0.addingTimeInterval(TimeInterval(CalendarWindowPreferences.defaultDurationMinutes() * 60))
                    )
                }
            )
        case .month, .agenda:
            MobileCalendarPager { offset in
                period(offset: offset)
            } onSettle: { direction in
                store.step(direction)
            }
        }
    }

    /// One period, `offset` steps from the anchor. The pager builds all three,
    /// so this is asked for the neighbours before anyone swipes.
    @ViewBuilder
    private func period(offset: Int) -> some View {
        let days = store.days(offset: offset)
        switch store.layout {
        case .day, .twoDay, .threeDay:
            // These layouts own their pager so the hour gutter can stay pinned.
            EmptyView()
        case .month:
            MobileCalendarMonthGrid(
                store: store,
                days: days,
                monthAnchor: monthAnchor(offset: offset),
                onSelect: { sheet = .detail($0) },
                onSelectLayer: { sheet = .layer($0) }
            )
        case .agenda:
            MobileCalendarAgendaList(
                store: store,
                days: days,
                onSelect: { sheet = .detail($0) },
                onSelectLayer: { sheet = .layer($0) }
            )
        }
    }

    /// Which month a page is showing, so its out-of-month days stay dimmed
    /// while it is only half on screen.
    private func monthAnchor(offset: Int) -> Date {
        guard offset != 0 else { return store.anchor }
        return CalendarWeekMath.step(store.mode, from: store.anchor, direction: offset)
    }

    private func newEventSheet() -> MobileCalendarSheet {
        // A new event from the toolbar lands on the day being read, at the next
        // half hour — not at whatever time it happens to be on some other day.
        let calendar = Calendar.current
        let now = Date()
        let anchorDay = calendar.startOfDay(for: store.anchor)
        let start: Date
        if calendar.isDateInToday(store.anchor) {
            start = CalendarWeekMath.snap(
                now.addingTimeInterval(1_800),
                minutes: CalendarWindowPreferences.snapMinutes()
            )
        } else {
            start = calendar.date(
                bySettingHour: CalendarWindowPreferences.dayStartHour(),
                minute: 0,
                second: 0,
                of: anchorDay
            ) ?? anchorDay
        }
        return .create(
            start: start,
            end: start.addingTimeInterval(TimeInterval(CalendarWindowPreferences.defaultDurationMinutes() * 60))
        )
    }
}

/// Shows `MobileCalendarStore.errorMessage` from one level of the presentation
/// stack. `active` is false for a level that has a sheet over it — see
/// `MobileCalendarScreen.isPresentingSheet`.
private struct CalendarErrorAlert: ViewModifier {
    @ObservedObject var store: MobileCalendarStore
    var active: Bool

    func body(content: Content) -> some View {
        content
            .meetHaptic(.error, whenSet: active ? store.errorMessage : nil)
            .alert("Calendar", isPresented: Binding(
            get: { active && store.errorMessage != nil },
            set: { if !$0 && active { store.errorMessage = nil } }
        )) {
            Button("Copy") {
                if let message = store.errorMessage { StarlingsErrorReport.copy(message: message) }
                store.errorMessage = nil
            }
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.errorMessage ?? "")
        }
    }
}

private extension View {
    func calendarErrorAlert(_ store: MobileCalendarStore, active: Bool = true) -> some View {
        modifier(CalendarErrorAlert(store: store, active: active))
    }
}
