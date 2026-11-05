import EnvisioningUI
import SwiftUI

/// What the calendar is presenting over the grid. One enum so only one sheet is
/// ever up, and so "tap a slot" and "tap an event" cannot both win.
enum MobileCalendarSheet: Identifiable {
    case create(start: Date, end: Date)
    /// One sentence that opens New Event filled in.
    case quickAdd
    case detail(CalendarEventGroup)
    case layer(CalendarLayerItem)

    var id: String {
        switch self {
        case .create(let start, _): return "create-\(start.timeIntervalSince1970)"
        case .quickAdd: return "quick-add"
        case .detail(let group): return "detail-\(group.id)"
        case .layer(let item): return "layer-\(item.id)"
        }
    }
}

/// What a milestone, task, or published event says when you open it.
///
/// There is no Save here and no Delete. These come from Core and the events
/// feed; the sheet reads them and leads to where they live: the task or
/// subject in Work, or the event's own page.
struct MobileCalendarLayerDetail: View {
    let item: CalendarLayerItem
    /// A Work link was tapped. The screen closes the sheet and moves the tab.
    let onOpenWork: (WorkDestination) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            StarlingsList {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Label {
                            Text(item.kind.title)
                        } icon: {
                            StarlingsGlyphMark(size: 12, color: item.kind.color.swiftUIColor)
                        }
                        .font(.caption)
                        .foregroundStyle(item.kind.color.swiftUIColor)
                        Text(item.displayTitle).font(.title3.bold())
                        Text(item.whenText).font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }

                Section {
                    if !item.detail.isEmpty {
                        row(item.kind == .publicEvents ? String(localized: "Location") : String(localized: "Project"), item.detail)
                    }
                    if !item.assignee.isEmpty {
                        row(item.isMine ? String(localized: "Assigned to you") : String(localized: "Assigned to"), item.assignee)
                    }
                    if !item.status.isEmpty { row(String(localized: "Status"), item.statusText) }
                    if !item.notes.isEmpty { row(String(localized: "Notes"), item.notes) }
                } footer: {
                    Text(item.kind.caption)
                }

                if !item.workLinks.isEmpty || !item.url.isEmpty {
                    Section {
                        ForEach(item.workLinks, id: \.title) { link in
                            Button { onOpenWork(link.destination) } label: {
                                Label(link.title, systemImage: "arrow.right.circle")
                            }
                        }
                        if !item.url.isEmpty, let url = URL(string: item.url) {
                            Button { openURL(url) } label: {
                                Label(item.kind.openTitle, systemImage: "arrow.up.right.square")
                            }
                        }
                    }
                }
            }
            .navigationTitle(item.kind.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.meetToolbarConfirm() }
            }
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.subheadline)
        }
    }
}

/// Pick the project, lead or partner an event is about. The kinds are the
/// registry's calendar-event ones, and the same Core search the meeting's filing sheet uses, so an event and the meeting it
/// becomes are filed by one vocabulary.
struct MobileSubjectPicker: View {
    /// The Core search behind the list. The calendar hands in its store's;
    /// a task's Move to… hands in the API's directly.
    let search: (MeetingCategoryKind.SubjectKind, String) async -> [CrmSubject]
    let onPick: (CrmSubject) -> Void
    /// The kinds on offer. An event files under the kinds that can carry
    /// calendar events; a task's Move to… hands in the ones that take tasks.
    let kinds: [MeetingCategoryKind.SubjectKind]

    init(store: MobileCalendarStore, onPick: @escaping (CrmSubject) -> Void) {
        self.search = { kind, query in await store.searchSubjects(kind: kind, query: query) }
        self.onPick = onPick
        kinds = MeetingCategoryKind.SubjectKind.kinds(with: .calendarEvents)
    }

    init(
        kinds: [MeetingCategoryKind.SubjectKind] = MeetingCategoryKind.SubjectKind.kinds(with: .calendarEvents),
        search: @escaping (MeetingCategoryKind.SubjectKind, String) async -> [CrmSubject],
        onPick: @escaping (CrmSubject) -> Void
    ) {
        self.kinds = kinds
        self.search = search
        self.onPick = onPick
    }

    @Environment(\.dismiss) private var dismiss
    @State private var kind: MeetingCategoryKind.SubjectKind = .project
    @State private var query = ""
    @State private var matches: [CrmSubject] = []
    @State private var isSearching = false
    @State private var searchTask: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            StarlingsList {
                Section {
                    Picker("Kind", selection: $kind) {
                        ForEach(kinds, id: \.self) { option in
                            Text(Self.title(of: option)).tag(option)
                        }
                    }
                    .pickerStyle(.segmented)
                }
                Section {
                    ForEach(matches) { match in
                        Button {
                            onPick(match)
                            dismiss()
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(match.title).foregroundStyle(.primary)
                                if let subtitle = match.subtitle, !subtitle.isEmpty {
                                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    if isSearching && matches.isEmpty {
                        EnvisioningPlaceholderRows()
                    }
                    if !isSearching && matches.isEmpty {
                        Text(query.isEmpty ? String(localized: "Nothing here yet.") : String(localized: "Nothing matches that."))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .searchable(text: $query, prompt: String(localized: "Search"))
            .navigationTitle("File under")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { StarlingsSheetCloseButton { dismiss() } }
            }
            .task { await search() }
            .onChange(of: kind) { _, _ in schedule() }
            .onChange(of: query) { _, _ in schedule() }
        }
    }

    private static func title(of kind: MeetingCategoryKind.SubjectKind) -> String {
        kind.label
    }

    /// A beat of quiet before asking, so typing a name is one request rather
    /// than one per letter.
    private func schedule() {
        searchTask?.cancel()
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await search()
        }
    }

    private func search() async {
        isSearching = true
        defer { isSearching = false }
        let found = await search(kind, query.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !Task.isCancelled else { return }
        matches = found
    }
}

/// Everything an event carries, plus the actions it allows. The editor is a
/// push from here rather than a separate sheet, so Back means "don't save".
struct MobileCalendarEventDetail: View {
    @ObservedObject var store: MobileCalendarStore
    let group: CalendarEventGroup
    /// Open the event's subject in Work. The screen closes the sheet and moves
    /// the tab; nil where the detail is shown without a Work tab behind it.
    var onOpenWork: ((WorkDestination) -> Void)?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var isEditing = false
    @State private var confirmingDelete = false
    @State private var pendingSpan: CalendarEditSpan = .thisEvent
    @State private var working = false
    /// The detail sheet receives an event snapshot when it opens. Keep the
    /// reply separately so the segmented picker reflects the answer before the
    /// calendar reload returns a newer snapshot from Google.
    @State private var reply: CalendarRSVP
    @State private var demoted: Bool
    /// What the event is filed under, kept here so the row updates the moment
    /// a subject is picked rather than after the store republishes.
    @State private var subject: CrmSubject?
    @State private var isPickingSubject = false
    /// Guests who are contacts, by lower-cased address. Read once
    /// per opened event; empty until it answers and when it fails, so the
    /// rows stay as the event names them.
    @State private var contacts: [String: CrmContact] = [:]

    @EnvironmentObject private var team: MobileTeamStore
    @EnvironmentObject private var app: StarlingsAppModel

    private var event: StarlingsCalendarEvent { group.event }

    /// One row per guest: their name when the event carries it, else the
    /// address; reply from the summary when there is one.
    private var guestRows: [(email: String, name: String, status: String?, isMember: Bool)] {
        var seen = Set<String>()
        return event.attendeeEmails.compactMap { raw in
            let email = raw.lowercased()
            guard !email.isEmpty, seen.insert(email).inserted else { return nil }
            let known = event.attendees.first { $0.email.lowercased() == email }
            let name = known.map { $0.name.isEmpty ? $0.email : $0.name } ?? email
            return (email, name, known?.status, CalendarAttendeeSummary.isMemberAddress(email))
        }
    }

    private func guestRow(_ guest: (email: String, name: String, status: String?, isMember: Bool)) -> some View {
        HStack(spacing: 8) {
            MobileAttendeeAvatar(
                name: guest.name, email: guest.email, status: guest.status,
                isMember: guest.isMember, source: team.avatarSource
            )
            VStack(alignment: .leading, spacing: 1) {
                Text(guest.name)
                    .font(.subheadline)
                    .lineLimit(1)
                if let context = contacts[guest.email]?.context, !context.isEmpty {
                    Text(context)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .opacity(guest.status == "declined" ? 0.55 : 1)
        }
        .accessibilityElement(children: .combine)
    }

    /// A guest who is a contact: their name, title · organization under it,
    /// and a press that opens their page.
    @ViewBuilder
    private func contactGuestRow(
        _ guest: (email: String, name: String, status: String?, isMember: Bool),
        contact: CrmContact
    ) -> some View {
        let named = (email: guest.email, name: contact.displayName, status: guest.status, isMember: guest.isMember)
        if let onOpenWork {
            Button {
                onOpenWork(.contact(id: contact.id, name: contact.displayName))
            } label: {
                guestRow(named).contentShape(Rectangle())
            }
            .buttonStyle(.meetPlain)
        } else {
            NavigationLink {
                MobileContactView(contactID: contact.id)
            } label: {
                guestRow(named)
            }
        }
    }

    /// Which guests are contacts: one read per opened event, for everyone but
    /// you and the members. Best effort; a failure changes nothing.
    private func loadContacts() async {
        let wanted = CrmContact.attendeeLookupAddresses(event.attendees, emails: event.attendeeEmails)
        guard !wanted.isEmpty, let credentials = app.ownerCredentials,
              let found = try? await app.api.crmContacts(credentials: credentials, emails: wanted),
              !Task.isCancelled else { return }
        contacts = CrmContact.byAddress(found, among: wanted)
    }

    private var canFile: Bool {
        store.calendars.first(where: { $0.id == event.calendarID })?.isMemberAccount == true
    }

    init(store: MobileCalendarStore, group: CalendarEventGroup, onOpenWork: ((WorkDestination) -> Void)? = nil) {
        self.store = store
        self.group = group
        self.onOpenWork = onOpenWork
        _reply = State(initialValue: group.event.myResponse ?? .needsAction)
        _demoted = State(initialValue: group.event.isDemoted)
        _subject = State(initialValue: group.event.subject)
    }

    var body: some View {
        NavigationStack {
            StarlingsList {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(event.displayTitle).font(.title3.bold())
                        Text(dateLine).foregroundStyle(.secondary).font(.subheadline)
                        if event.calendarRole == .globalInterest {
                            Label {
                                Text(event.calendarRole.title)
                            } icon: {
                                StarlingsGlyphMark(size: 12, color: CalendarLayerPalette.globalInterest.swiftUIColor)
                            }
                            .font(.caption)
                            .foregroundStyle(CalendarLayerPalette.globalInterest.swiftUIColor)
                        }
                        if event.isRecurring {
                            Label("Repeating event", systemImage: "repeat")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }

                if !event.joinURL.isEmpty, let url = URL(string: event.joinURL) {
                    Section {
                        Button {
                            openURL(url)
                        } label: {
                            Label(
                                event.roomSlug.isEmpty ? String(localized: "Open link") : String(localized: "Join meeting"),
                                systemImage: event.roomSlug.isEmpty ? "link" : "video.fill"
                            )
                        }
                        // The one accent on this sheet: everything else here —
                        // Edit, Move, Duplicate, Hide, Done — is a way of
                        // fiddling with the event, and this is the way into it.
                        .tint(StarlingsMobileColors.accent)
                        MobileCallLinkRow(link: event.joinURL)
                    }
                }

                if event.canRespond {
                    Section("Going?") {
                        Picker("Your reply", selection: replyBinding) {
                            ForEach(CalendarRSVP.answers, id: \.rawValue) { reply in
                                Text(reply.label).tag(reply)
                            }
                        }
                        .pickerStyle(.segmented)
                        .disabled(working)
                    }
                }

                Section("Details") {
                    row(String(localized: "Calendar"), store.calendarTitle(for: event.calendarID))
                    if !event.location.isEmpty { row(String(localized: "Where"), event.location) }
                    if let travel = CalendarTravelTime.label(minutes: event.travelTimeMinutes) { row(String(localized: "Travel"), travel) }
                    if !event.attendeeEmails.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Guests").font(.caption).foregroundStyle(.secondary)
                            ForEach(guestRows, id: \.email) { guest in
                                if let contact = contacts[guest.email] {
                                    contactGuestRow(guest, contact: contact)
                                } else {
                                    guestRow(guest)
                                }
                            }
                        }
                    }
                    if !event.notes.isEmpty { row(String(localized: "Notes"), event.notes) }
                }

                // Filing is the owner's preference about the event, not a field
                // of somebody else's invitation — offered on every event of an
                // Envisioning account, and written at once. A room started from
                // this event is filed under it, on the Mac and on the phone
                // alike. A personal account has no CRM to file to.
                if canFile {
                Section {
                    Button {
                        isPickingSubject = true
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Filed under").font(.caption).foregroundStyle(.secondary)
                                Text(subject?.title ?? String(localized: "Not filed"))
                                    .font(.subheadline)
                                    .foregroundStyle(subject == nil ? Color.secondary : Color.primary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .buttonStyle(.meetPlain)
                    .disabled(working)
                    if let subject, let onOpenWork {
                        Button {
                            onOpenWork(WorkDestination(subject: subject, pane: .overview))
                        } label: {
                            Text("Open \(subject.title)")
                        }
                    }
                    if subject != nil {
                        Button("Unfile", role: .destructive) {
                            working = true
                            Task {
                                await store.setSubject(event, nil)
                                subject = nil
                                working = false
                            }
                        }
                        .disabled(working)
                    }
                } footer: {
                    Text(subject == nil
                        ? String(localized: "New meetings use this project, lead or partner.")
                        : "New meetings use \(subject!.title).")
                }
                }


                Section {
                    Button {
                        let next = !demoted
                        // Keep the editor in step with the action immediately;
                        // the shared calendar store persists it asynchronously.
                        demoted = next
                        working = true
                        Task {
                            _ = await store.setDemoted(event, demoted: next)
                            working = false
                        }
                    } label: {
                        Label(
                            demoted ? String(localized: "Show in Next") : String(localized: "Hide from Next"),
                            systemImage: demoted ? "arrow.up.circle" : "arrow.down.circle"
                        )
                    }
                    .disabled(working)
                } footer: {
                    Text(demoted
                        ? String(localized: "Visible, but excluded from alerts and Next.")
                        : String(localized: "Hide affects only your view."))
                }

                if event.isWritable {
                    Section {
                        Button { isEditing = true } label: { Label("Edit", systemImage: "pencil") }
                        if event.canMoveBetweenCalendars {
                            MobileCalendarMoveMenu(store: store, event: event) { calendarID in
                                run { await store.move(event, to: calendarID) }
                            }
                        }
                        Menu {
                            ForEach(store.writableCalendars) { calendar in
                                Button(calendar.title) { run { await store.duplicate(event, to: calendar.id) } }
                            }
                        } label: {
                            Label("Duplicate to calendar", systemImage: "plus.square.on.square")
                        }
                        Button(role: .destructive) {
                            confirmingDelete = true
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
            }
            .navigationTitle("Event")
            .navigationBarTitleDisplayMode(.inline)
            .task(id: group.id) { await loadContacts() }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.meetToolbarConfirm() }
            }
            .navigationDestination(isPresented: $isEditing) {
                MobileCalendarEditorForm(store: store, editing: event) { dismiss() }
            }
            .sheet(isPresented: $isPickingSubject) {
                MobileSubjectPicker(store: store) { picked in
                    working = true
                    Task {
                        await store.setSubject(event, picked)
                        subject = picked
                        working = false
                    }
                }
            }
            .confirmationDialog(
                String(localized: "Delete “\(event.title)”?"),
                isPresented: $confirmingDelete,
                titleVisibility: .visible
            ) {
                // A recurring instance has two honest answers, so it is asked
                // rather than guessed.
                if event.isRecurring {
                    Button("Delete this event", role: .destructive) {
                        run { await store.delete(event, span: .thisEvent) }
                    }
                    Button("Delete all events in the series", role: .destructive) {
                        run { await store.delete(event, span: .futureEvents) }
                    }
                } else {
                    Button("Delete", role: .destructive) {
                        run { await store.delete(event, span: .thisEvent) }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This can’t be undone.")
            }
        }
    }

    private var replyBinding: Binding<CalendarRSVP> {
        Binding(
            get: { reply },
            set: { next in respond(next) }
        )
    }

    private func respond(_ next: CalendarRSVP) {
        guard next != reply else { return }
        let previous = reply
        // The write and the forced reload are asynchronous. The picker must
        // answer the tap now, not only after Google's event snapshot catches
        // up; restore the previous answer if the write fails.
        reply = next
        working = true
        Task {
            let ok = await store.respond(to: event, as: next)
            if !ok { reply = previous }
            working = false
        }
    }

    private var dateLine: String {
        if event.isAllDay {
            return String(localized: "\(event.start.formatted(date: .complete, time: .omitted)) · All day")
        }
        let day = event.start.formatted(date: .complete, time: .omitted)
        return "\(day)\n\(MobileCalendarChrome.timeRangeLabel(event))"
    }

    private func row(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.subheadline)
        }
    }

    private func run(dismissOnSuccess: Bool = true, _ work: @escaping () async -> Bool) {
        working = true
        Task {
            let ok = await work()
            working = false
            if ok, dismissOnSuccess { dismiss() }
        }
    }
}

/// Create and edit are the same form; only the title and the save verb differ.
struct MobileCalendarEditorForm: View {
    @ObservedObject var store: MobileCalendarStore
    var editing: StarlingsCalendarEvent?
    var initialStart: Date?
    var initialEnd: Date?
    /// What Quick add read from a sentence: the form opens filled
    /// in, for review and Save.
    var prefill: MobileCalendarQuickAddPrefill?
    var onFinish: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var team: MobileTeamStore
    @State private var contacts: [MobileContactSuggestion] = []
    @State private var draft = MobileCalendarDraft()
    @State private var attendees: [String] = []
    @State private var addsMeetLink = false

    /// The call link, whole and one press from the clipboard: the link the
    /// event has, or the room a new event will carry.
    private var callLink: String {
        if let editing, !editing.joinURL.isEmpty { return editing.joinURL }
        if addsMeetLink, let room = store.room { return MeetingInvite.absoluteURL(slug: room.slug) }
        return ""
    }

    private var locationPlaceholder: String {
        callLink.isEmpty ? String(localized: "Location") : String(localized: "Location, or the call link")
    }
    @State private var span: CalendarEditSpan = .thisEvent
    @State private var isSaving = false
    @State private var loaded = false
    // What Quick add understood, said under Title.
    @State private var describedNote = ""
    /// Names Quick add read after "with", matched once contacts load.
    @State private var pendingInvitees: [String] = []
    @FocusState private var titleFocused: Bool
    @State private var availability: [CalendarFreeBusyPerson] = []
    @State private var isCheckingAvailability = false

    var body: some View {
        StarlingsForm {
            Section {
                TextField("Title", text: $draft.title)
                    .focused($titleFocused)
                StarlingsSearchablePicker(
                    label: String(localized: "Calendar"),
                    placeholder: String(localized: "Choose a calendar"),
                    options: (editing.map { store.calendarChoices(for: $0) } ?? store.writableCalendars).map { calendar in
                        StarlingsSearchablePickerOption(
                            id: calendar.id,
                            title: calendar.title,
                            context: calendar.groupTitle,
                            subtitle: calendar.accountEmail,
                            colorHex: String(format: "#%02X%02X%02X", Int(calendar.displayColor.red * 255), Int(calendar.displayColor.green * 255), Int(calendar.displayColor.blue * 255))
                        )
                    },
                    selection: $draft.calendarID,
                    emptyMessage: String(localized: "No options match that search.")
                )
                .disabled(editing?.canMoveBetweenCalendars == false)
            } footer: {
                if !describedNote.isEmpty {
                    Text(describedNote)
                }
            }

            Section {
                Toggle("All day", isOn: $draft.isAllDay)
                    .meetToggleTint()
                DatePicker(
                    "Starts",
                    selection: $draft.start,
                    displayedComponents: draft.isAllDay ? [.date] : [.date, .hourAndMinute]
                )
                DatePicker(
                    "Ends",
                    selection: $draft.end,
                    in: draft.start...,
                    displayedComponents: draft.isAllDay ? [.date] : [.date, .hourAndMinute]
                )
            }

            Section("Where") {
                // Empty with a call on the event: the link takes the slot on
                // save, so Google and Apple Calendar show Join.
                TextField(locationPlaceholder, text: $draft.location)
                // Minutes to get there, the owner's own number;
                // once there is somewhere to get to. Google events only.
                if travelAllowed, !draft.location.trimmingCharacters(in: .whitespaces).isEmpty || draft.travelTimeMinutes > 0 {
                    Picker("Travel time", selection: $draft.travelTimeMinutes) {
                        ForEach(MobileCalendarDraft.travelChoices, id: \.self) { minutes in
                            Text(minutes == 0 ? String(localized: "Off") : String(localized: "\(minutes) min")).tag(minutes)
                        }
                    }
                }
                if store.room != nil, editing?.joinURL.isEmpty ?? true {
                    Toggle("Add my Starlings room link", isOn: $addsMeetLink)
                        .meetToggleTint()
                }
                if !callLink.isEmpty {
                    MobileCallLinkRow(link: callLink)
                }
            }

            Section("Invitees") {
                MobileInviteesEditor(
                    addresses: $attendees,
                    existing: editing?.attendees ?? [],
                    suggestions: inviteeSuggestions
                )
            }

            availabilitySection

            Section("Notes") {
                TextField("Notes", text: $draft.notes, axis: .vertical).lineLimit(3...8)
            }

            if editing?.isRecurring == true {
                Section {
                    Picker("Apply to", selection: $span) {
                        Text("This event").tag(CalendarEditSpan.thisEvent)
                        Text("All events").tag(CalendarEditSpan.futureEvents)
                    }
                }
            }
        }
        .navigationTitle(editing == nil ? String(localized: "New Event") : String(localized: "Edit Event"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { StarlingsSheetCloseButton { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? String(localized: "Saving…") : String(localized: "Save")) { save() }
                    .disabled(isSaving || !isValid)
                    .meetToolbarConfirm()
            }
        }
        .onAppear(perform: load)
        // Contacts, once per editor, for Add invitee's completions. The roster
        // needs no load; it is the store's live list.
        .task {
            contacts = await MobileContacts().load()
            matchPendingInvitees()
        }
        // Re-runs and cancels itself whenever the guests or the slot change, so
        // a list still being typed does not fire a request per keystroke.
        .task(id: availabilityKey) { await checkAvailability() }
    }

    // MARK: - Availability

    /// Only for timed events with guests: an all-day event has no slot to
    /// defend, and free/busy needs the Google account the owner connected.
    private var wantsAvailability: Bool {
        !draft.isAllDay && !parsedAttendees.isEmpty && store.googleConnected
    }

    private var availabilityKey: String {
        guard wantsAvailability else { return "" }
        return parsedAttendees.sorted().joined(separator: ",")
            + "|" + CalendarDateParsing.format(day: draft.start)
    }

    private var proposedSlot: DateInterval {
        DateInterval(start: draft.start, end: max(draft.end, draft.start.addingTimeInterval(60)))
    }

    @ViewBuilder
    private var availabilitySection: some View {
        if wantsAvailability {
            Section {
                MobileCalendarAvailabilityStrip(
                    window: MobileCalendarAvailability.window(for: proposedSlot, on: draft.start),
                    busy: MobileCalendarAvailability.busyIntervals(
                        availability,
                        clippedTo: MobileCalendarAvailability.window(for: proposedSlot, on: draft.start)
                    ),
                    slot: proposedSlot
                ) { picked in
                    // Tapping the strip is how a time gets picked rather than
                    // proposed and corrected by reply. Length is preserved.
                    let length = draft.end.timeIntervalSince(draft.start)
                    draft.start = picked
                    draft.end = picked.addingTimeInterval(max(60, length))
                }
                .padding(.vertical, 4)

                verdict
            } header: {
                HStack {
                    Text("Availability")
                    if isCheckingAvailability {
                        ProgressView().controlSize(.mini).tint(.secondary)
                    }
                }
            } footer: {
                Text("Free/busy only. Event details stay private.")
            }
        }
    }

    @ViewBuilder
    private var verdict: some View {
        let clashes = MobileCalendarAvailability.conflicts(availability, with: proposedSlot)
        let unreadable = MobileCalendarAvailability.unreadable(availability)

        if !clashes.isEmpty {
            Label(
                clashes.count == 1
                    ? String(localized: "\(clashes[0]) is busy then")
                    : "\(clashes.count) guests are busy then",
                systemImage: "exclamationmark.triangle"
            )
            .font(.caption)
            .foregroundStyle(StarlingsMobileColors.danger)
        } else if !availability.isEmpty {
            Label("Everyone is free then", systemImage: "checkmark.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
        }

        // Said plainly, never folded into "free".
        if !unreadable.isEmpty {
            Text("No availability for \(unreadable.joined(separator: ", "))")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func checkAvailability() async {
        guard wantsAvailability else {
            availability = []
            return
        }
        // Typing an address is several keystrokes; each one should not be a
        // round trip. `.task(id:)` cancels the previous wait for us.
        do { try await Task.sleep(for: .milliseconds(450)) } catch { return }
        guard !Task.isCancelled else { return }

        isCheckingAvailability = true
        availability = await store.freeBusy(for: parsedAttendees, on: draft.start)
        isCheckingAvailability = false
    }

    private var isValid: Bool {
        var candidate = draft
        candidate.attendees = parsedAttendees
        return candidate.isValid
    }

    private var parsedAttendees: [String] { attendees }

    /// Who Add invitee completes from: the roster first (it knows names),
    /// then whoever Contacts knows by address. Nothing hard-wired.
    private func inviteeSuggestions() -> [(email: String, name: String)] {
        var seen = Set<String>()
        var out: [(email: String, name: String)] = []
        for peer in team.roster.people where !peer.email.isEmpty {
            guard seen.insert(peer.email.lowercased()).inserted else { continue }
            out.append((peer.email.lowercased(), peer.displayName))
        }
        for contact in contacts where seen.insert(contact.email).inserted {
            out.append((contact.email, contact.name))
        }
        return out
    }

    /// EventKit is read-only for travel; a new event's calendar decides too.
    private var travelAllowed: Bool {
        if let editing { return editing.source == .google && editing.isWritable }
        return store.calendars.first { $0.id == draft.calendarID }?.source == .google
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        if let editing {
            draft = MobileCalendarDraft(
                title: editing.title,
                start: editing.start,
                end: editing.end,
                isAllDay: editing.isAllDay,
                calendarID: editing.calendarID,
                location: editing.location,
                notes: editing.notes,
                attendees: editing.attendeeEmails,
                joinURL: editing.joinURL.isEmpty ? nil : editing.joinURL,
                roomSlug: editing.roomSlug.isEmpty ? nil : editing.roomSlug,
                travelTimeMinutes: editing.travelTimeMinutes ?? 0
            )
            // Everyone but you: the list the save writes. You are drawn from
            // `editing.attendees` and never removed.
            attendees = editing.attendeeEmails.map { $0.lowercased() }
                .filter { email in !(editing.attendees.first { $0.isSelf }?.email.lowercased() == email) }
        } else {
            // The next slot, never 08:03 and never already past.
            let start = initialStart ?? CalendarWeekMath.snapUp(
                Date(), minutes: CalendarWindowPreferences.snapMinutes()
            )
            draft.start = start
            draft.end = initialEnd ?? start.addingTimeInterval(
                TimeInterval(CalendarWindowPreferences.defaultDurationMinutes() * 60)
            )
            draft.calendarID = store.defaultWriteCalendar?.id
                ?? store.defaultCalendarChoices.first?.id
                ?? ""
            if let prefill { apply(prefill) }
        }
    }

    /// Quick add's reading into the form. Names after "with" become invitees
    /// when a contact matches; the rest stays in the title.
    private func apply(_ prefill: MobileCalendarQuickAddPrefill) {
        let parsed = prefill.draft
        draft.title = parsed.title
        if let location = parsed.location { draft.location = location }
        if let start = parsed.startDate() {
            draft.isAllDay = parsed.allDay
            draft.start = start
            draft.end = parsed.endDate() ?? start.addingTimeInterval(
                TimeInterval(CalendarWindowPreferences.defaultDurationMinutes() * 60)
            )
        }
        pendingInvitees = parsed.invitees
        matchPendingInvitees()
        describedNote = prefill.fromModel
            ? String(localized: "Read by the notes engine. Check the times.")
            : parsed.confidence == 0
                ? String(localized: "No date read; the title is set.")
                : parsed.confidence < 1
                    ? String(localized: "Day read; set the time.")
                    : String(localized: "Filled in from the sentence.")
        if parsed.confidence == 0 { titleFocused = true }
    }

    private func matchPendingInvitees() {
        guard !pendingInvitees.isEmpty, !contacts.isEmpty else { return }
        for name in pendingInvitees {
            let needle = name.lowercased()
            if let match = contacts.first(where: { $0.name.lowercased() == needle || $0.name.lowercased().hasPrefix(needle + " ") }),
               !attendees.contains(match.email.lowercased()) {
                attendees.append(match.email.lowercased())
            }
        }
        pendingInvitees = []
    }

    private func save() {
        var payload = draft
        payload.attendees = parsedAttendees
        payload.attendeesChanged = parsedAttendees != (editing?.attendeeEmails ?? [])
        if payload.isAllDay {
            let calendar = Calendar.current
            payload.start = calendar.startOfDay(for: payload.start)
            // All-day ends are the exclusive next midnight on both sources.
            payload.end = calendar.date(
                byAdding: .day,
                value: 1,
                to: calendar.startOfDay(for: payload.end)
            ) ?? payload.end
        }
        if addsMeetLink, let room = store.room {
            payload.roomSlug = room.slug
            payload.joinURL = MeetingInvite.absoluteURL(slug: room.slug)
        }

        isSaving = true
        Task {
            let ok: Bool
            if let editing {
                ok = await store.update(editing, with: payload, span: span)
            } else {
                ok = await store.create(payload)
            }
            isSaving = false
            if ok {
                let moved = editing.map { $0.start != payload.start || $0.end != payload.end } ?? false
                store.noticeInvites(count: parsedAttendees.count, isNew: editing == nil, moved: moved)
                onFinish()
                dismiss()
            }
        }
    }
}

/// A call link, whole and selectable, with a copy button beside it. The
/// editor and the event sheet show the same row.
private struct MobileCallLinkRow: View {
    let link: String
    @State private var copied = false

    var body: some View {
        HStack(spacing: 12) {
            Text(link)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .truncationMode(.middle)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                UIPasteboard.general.string = link
                copied = true
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(1.2))
                    copied = false
                }
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .foregroundStyle(StarlingsMobileColors.accent)
            }
            .buttonStyle(.meetPlain)
            .accessibilityLabel(copied ? String(localized: "Copied") : String(localized: "Copy link"))
        }
    }
}

/// What Quick add read, handed to New Event.
struct MobileCalendarQuickAddPrefill: Equatable {
    let draft: CalendarQuickAddDraft
    /// The grammar read nothing and the notes engine answered instead.
    let fromModel: Bool
}

/// Quick add event…: one line, then New Event filled in for
/// review. The grammar first, the notes engine when it read no date.
struct MobileCalendarQuickAddView: View {
    @ObservedObject var store: MobileCalendarStore

    @Environment(\.dismiss) private var dismiss
    @State private var sentence = ""
    @State private var isReading = false
    @State private var prefill: MobileCalendarQuickAddPrefill?
    @FocusState private var focused: Bool

    var body: some View {
        if let prefill {
            MobileCalendarEditorForm(store: store, prefill: prefill)
        } else {
            StarlingsForm {
                Section {
                    TextField("Quick add event…", text: $sentence, prompt: Text("Coffee with Ana Thu 14:00 at Ground, 45 min"))
                        .submitLabel(.go)
                        .focused($focused)
                        .onSubmit { Task { await read() } }
                        .disabled(isReading)
                }
            }
            .navigationTitle(String(localized: "Quick add event"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { StarlingsSheetCloseButton { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isReading ? String(localized: "Reading…") : String(localized: "Next")) {
                        Task { await read() }
                    }
                    .disabled(isReading || sentence.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .meetToolbarConfirm()
                }
            }
            .onAppear { focused = true }
        }
    }

    private func read() async {
        let typed = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty, !isReading else { return }
        isReading = true
        defer { isReading = false }
        let context = CalendarQuickAdd.Context(defaultDurationMinutes: CalendarWindowPreferences.defaultDurationMinutes())
        var parsed = CalendarQuickAdd.parse(typed, context: context)
        var fromModel = false
        if parsed.confidence == 0, let answered = await store.quickAddFallback(typed, now: context.now, defaultDurationMinutes: context.defaultDurationMinutes) {
            parsed = answered
            fromModel = true
        }
        prefill = MobileCalendarQuickAddPrefill(draft: parsed, fromModel: fromModel)
    }
}
