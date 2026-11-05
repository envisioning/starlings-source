import AppKit

@MainActor
final class CalendarInspectorView: NSView {
    var onSave: ((CalendarInspectorDraft) -> Void)?
    /// Save was pressed with nothing to save; the message names why.
    var onValidationError: ((String) -> Void)?
    var onCancel: (() -> Void)?
    var onRespond: ((CalendarRSVP) -> Void)?
    /// Fires as the guest list changes, so the grid can shade their busy time
    /// while a slot is still being chosen.
    var onGuestsChanged: (([String]) -> Void)?
    /// The event was filed under a project or lead, or unfiled (nil). Written
    /// at once, outside Save — it is a preference about the event, not a
    /// field of it, and it must not wait on a calendar write to land.
    var onSubjectChanged: ((CrmSubject?) -> Void)?
    /// The list to file under, for the kind the person just chose.
    var onSubjectsNeeded: ((MeetingCategoryKind.SubjectKind) async -> [CrmSubject])?
    /// Quick add's fallback: a sentence the grammar could not read,
    /// answered by the notes engine through the Worker, or nil.
    var onDescribeFallback: ((String, String, Int) async -> CalendarQuickAddDraft?)?
    /// Who to offer while typing an invitee. Handed through to the list.
    var inviteeSuggestions: (() -> [(email: String, name: String)])? {
        get { guestsField.suggestions }
        set { guestsField.suggestions = newValue }
    }
    /// Which guests are contacts. Handed through to the list.
    var contactLookup: (([String]) async -> [CrmContact]?)? {
        get { guestsField.contactLookup }
        set { guestsField.contactLookup = newValue }
    }
    /// A guest who is a contact was pressed.
    var onOpenContact: ((CrmContact) -> Void)? {
        get { guestsField.onOpenContact }
        set { guestsField.onOpenContact = newValue }
    }

    /// Whatever the calendar popup is currently pointing at.
    var selectedCalendarID: String? {
        calendarField.selectedID
    }

    var selectedSpan: CalendarEditSpan {
        spanControl.selectedSegment == 1 ? .futureEvents : .thisEvent
    }

    /// The travel row's choices: the same five on Mac, iOS and web.
    static let travelChoices = CalendarValues.travelMinutes

    private var selectedTravelMinutes: Int {
        let index = travelControl.selectedSegment
        return Self.travelChoices.indices.contains(index) ? Self.travelChoices[index] : 0
    }

    /// Quick add: one sentence above the form fills it in, not saved.
    private let describedNote = NSTextField(labelWithString: "")
    private let titleField = StarlingsTextField(placeholder: String(localized: "New Event"))
    private let startField = StarlingsDayTimeField()
    private let endField = StarlingsDayTimeField()
    /// The calendar stays in the same searchable field style as other long
    /// choices; account name is its searchable context.
    private let calendarField = StarlingsSearchablePickerField(frame: .zero)
    private let meetLinkButton = NSButton(checkboxWithTitle: "Add Starlings room link", target: nil, action: nil)
    /// The call link, whole and one press from the clipboard: the room a
    /// new event will carry, or the link the event already has.
    private let joinLinkRow = CopyableURLRow()
    private let guestsField = CalendarInviteesEditorView()
    private let locationField = StarlingsTextField(placeholder: String(localized: "Location"))
    /// Minutes to get there, the owner's own number. Offered once there is a
    /// location or a value; Google events only, EventKit keeps it read-only.
    private lazy var travelLabel = sectionLabel(String(localized: "Travel time"))
    private let travelControl = StarlingsSegmentedControl(labels: [String(localized: "Off"), "15", "30", "45", "60"])
    private var travelAllowed = true
    private var originalTravelMinutes = 0
    private let notesView = NSTextView()
    private let notesScroll = NSScrollView()
    /// The well around the notes: NSScrollView repaints its own layer from
    /// `drawsBackground`, so chrome set on the scroll view is cleared on the
    /// next layout. A plain view owns the fill and hairline instead.
    private let notesWell = StarlingsFieldWell()
    private let notesButton = NSButton(title: String(localized: "Notes"), target: nil, action: nil)
    private let notesPopover = NSPopover()
    private let mergedNote = NSTextField(labelWithString: "")
    private let rsvpLabel = NSTextField(labelWithString: String(localized: "Your reply"))
    private let rsvpControl = StarlingsSegmentedControl(
        labels: CalendarRSVP.answers.map(\.label),
        trackingMode: .selectOne,
        target: nil,
        action: nil
    )
    private let rsvpNote = NSTextField(labelWithString: "")
    private let spanLabel = NSTextField(labelWithString: String(localized: "Recurring"))
    private let spanControl = StarlingsSegmentedControl(labels: [String(localized: "This event"), String(localized: "All future")])
    /// Same control the meeting rail files a live meeting with, so an event
    /// and the meeting it becomes are filed by one vocabulary.
    private let filedLabel = NSTextField(labelWithString: String(localized: "Filed under"))
    private let filingControls = MeetingCategoryControls()
    private var filingLoadTask: Task<Void, Never>?
    private let saveButton = StarlingsFilledButton(style: .accent, title: String(localized: "Save"))
    private let cancelButton = NSButton(title: String(localized: "Cancel"), target: nil, action: nil)
    private var calendars: [StarlingsCalendar] = []
    private var isNew = true
    /// Set once the participant works the checkbox themselves, after which
    /// guessing at it would be overruling them.
    private var meetLinkTouched = false
    private var canInviteGuests = true
    /// What the event held when it was loaded. Fields that come back unchanged
    /// are sent as `nil` so a save never rewrites what the user did not touch.
    private var originalNotes = ""
    private var originalLocation = ""
    /// The call link the event carries, so the empty Location field can say
    /// what will fill it (the Worker stores the link there when no place is
    /// typed, so Google and Apple Calendar show Join).
    private var currentJoinURL = ""
    /// The member's room link, offered to a new event by the checkbox.
    private var roomJoinURL = ""
    private var originalAttendees: [String] = []

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        // No ground of its own: the host (`CalendarInspectorViewController`)
        // carries the panel rung, and on macOS 26 the glass under the
        // overlay has to show through the form, not only below it.
        wantsLayer = true

        calendarField.setOptions([], placeholder: String(localized: "Choose a calendar"), selectedID: nil)

        meetLinkButton.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        meetLinkButton.applyMeetCheckboxStyle()
        meetLinkButton.target = self
        meetLinkButton.action = #selector(meetLinkToggled)
        calendarField.onSelection = { [weak self] _ in self?.refreshGuestField() }
        guestsField.onChange = { [weak self] in self?.guestsChanged() }

        notesView.isEditable = true
        notesView.isRichText = false
        notesView.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        notesView.textColor = StarlingsColors.primaryText
        notesView.drawsBackground = false
        notesView.minSize = NSSize(width: 0, height: 0)
        notesView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        notesView.isVerticallyResizable = true
        notesView.isHorizontallyResizable = false
        notesView.autoresizingMask = [.width]
        notesView.textContainer?.widthTracksTextView = true
        notesScroll.documentView = notesView
        notesScroll.hasVerticalScroller = true
        notesScroll.drawsBackground = false
        // The same well as the fields around it, not AppKit's bezel: a
        // multi-line input is still an input.
        notesScroll.borderType = .noBorder
        notesWell.embed(notesScroll)
        notesView.textContainerInset = NSSize(width: 8, height: 8)
        notesScroll.translatesAutoresizingMaskIntoConstraints = false
        // Notes are read far more than written, so the well lives in a popover
        // behind one quiet button, and the button only shows when there is
        // something to read.
        SettingsChrome.applyQuietButton(notesButton)
        notesButton.image = NSImage(systemSymbolName: "note.text", accessibilityDescription: String(localized: "Notes"))
        notesButton.imagePosition = .imageLeading
        notesButton.target = self
        notesButton.action = #selector(notesTapped)
        notesButton.isHidden = true
        notesWell.translatesAutoresizingMaskIntoConstraints = false
        let notesHost = NSView()
        notesHost.addSubview(notesWell)
        NSLayoutConstraint.activate([
            notesWell.topAnchor.constraint(equalTo: notesHost.topAnchor, constant: 12),
            notesWell.leadingAnchor.constraint(equalTo: notesHost.leadingAnchor, constant: 12),
            notesWell.trailingAnchor.constraint(equalTo: notesHost.trailingAnchor, constant: -12),
            notesWell.bottomAnchor.constraint(equalTo: notesHost.bottomAnchor, constant: -12),
            notesHost.widthAnchor.constraint(equalToConstant: 340),
            notesHost.heightAnchor.constraint(equalToConstant: 220),
        ])
        notesPopover.behavior = .transient
        notesPopover.contentViewController = NSViewController()
        notesPopover.contentViewController?.view = notesHost

        mergedNote.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        mergedNote.textColor = StarlingsColors.secondaryText
        mergedNote.lineBreakMode = .byTruncatingTail
        mergedNote.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        mergedNote.isHidden = true

        rsvpLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold)
        rsvpLabel.textColor = StarlingsColors.secondaryText
        rsvpControl.target = self
        rsvpControl.action = #selector(rsvpChanged)
        rsvpNote.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        rsvpNote.textColor = StarlingsColors.secondaryText
        rsvpNote.lineBreakMode = .byTruncatingTail
        rsvpNote.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        rsvpLabel.isHidden = true
        rsvpControl.isHidden = true
        rsvpNote.isHidden = true

        spanLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold)
        spanLabel.textColor = StarlingsColors.secondaryText
        spanControl.selectedSegment = 0
        spanControl.isHidden = true
        spanLabel.isHidden = true

        filedLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold)
        filedLabel.textColor = StarlingsColors.secondaryText
        filedLabel.isHidden = true
        filingControls.isHidden = true
        filingControls.offersPartner = MeetingCategoryKind.SubjectKind.organization.can(.calendarEvents)
        filingControls.onChange = { [weak self] kind, subject in
            guard let self else { return }
            if kind.needsSubject, subject == nil {
                // A kind with nothing chosen yet: fetch the list, file nothing.
                filingLoadTask?.cancel()
                filingLoadTask = Task { @MainActor [weak self] in
                    guard let self, let subjectKind = kind.subjectKind else { return }
                    let found = await onSubjectsNeeded?(subjectKind) ?? []
                    guard !Task.isCancelled else { return }
                    filingControls.setSubjects(found, selecting: nil)
                }
                return
            }
            onSubjectChanged?(subject)
            filingControls.setBusy(false, message: subject.map { "New meetings use \($0.title)." } ?? String(localized: "Not filed."))
        }

        saveButton.target = self
        saveButton.action = #selector(saveTapped)
        cancelButton.target = self
        cancelButton.action = #selector(cancelTapped)
        SettingsChrome.applyQuietButton(cancelButton)

        // No heading: the panel is one event's form, and the title well is
        // the first thing in it. A well with a placeholder carries no label
        // either — Calendar, Invitees and Location say what they are. Starts
        // and Ends keep theirs: a bare date reads as neither.
        //
        // Each edge is a full-width row, day beside clock. Two edges side by
        // side left the day field 8pt wide in a 320pt panel, which is how a
        // date that was always editable came to look like it was not.
        let startColumn = NSStackView(views: [sectionLabel(String(localized: "Starts")), startField])
        let endColumn = NSStackView(views: [sectionLabel(String(localized: "Ends")), endField])
        for column in [startColumn, endColumn] {
            column.orientation = .vertical
            column.alignment = .leading
            column.spacing = 8
        }

        // Duplicate and Delete live in the Event menu, the context menu, ⌘D
        // and ⌫; the panel keeps the two things only it can do.
        let actions = NSStackView(views: [cancelButton, saveButton])
        actions.orientation = .horizontal
        actions.spacing = 8
        actions.alignment = .centerY

        // What Quick add event… understood, under the title it filled
        //. The sentence itself is typed in the + menu's prompt.
        describedNote.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        describedNote.textColor = StarlingsColors.secondaryText
        describedNote.lineBreakMode = .byTruncatingTail
        describedNote.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        describedNote.isHidden = true

        let stack = NSStackView(views: [
            titleField,
            describedNote,
            startColumn,
            endColumn,
            calendarField,
            mergedNote,
            meetLinkButton,
            joinLinkRow,
            guestsField,
            rsvpLabel, rsvpControl, rsvpNote,
            locationField,
            travelLabel, travelControl,
            notesButton,
            filedLabel, filingControls,
            spanLabel, spanControl,
            NSView(),
            actions,
        ])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            describedNote.widthAnchor.constraint(equalTo: stack.widthAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -16),
            titleField.widthAnchor.constraint(equalTo: stack.widthAnchor),
            startColumn.widthAnchor.constraint(equalTo: stack.widthAnchor),
            endColumn.widthAnchor.constraint(equalTo: stack.widthAnchor),
            startField.widthAnchor.constraint(equalTo: startColumn.widthAnchor),
            endField.widthAnchor.constraint(equalTo: endColumn.widthAnchor),
            calendarField.widthAnchor.constraint(equalTo: stack.widthAnchor),
            joinLinkRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            guestsField.widthAnchor.constraint(equalTo: stack.widthAnchor),
            rsvpControl.widthAnchor.constraint(equalTo: stack.widthAnchor),
            rsvpNote.widthAnchor.constraint(equalTo: stack.widthAnchor),
            locationField.widthAnchor.constraint(equalTo: stack.widthAnchor),
            travelControl.widthAnchor.constraint(equalTo: stack.widthAnchor),
            filingControls.widthAnchor.constraint(equalTo: stack.widthAnchor),
            spanControl.widthAnchor.constraint(equalTo: stack.widthAnchor),
            saveButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 88),
            saveButton.heightAnchor.constraint(equalToConstant: 36),
        ])
        stack.setCustomSpacing(16, after: spanControl)
        // Typing a place is what makes the travel row worth showing.
        NotificationCenter.default.addObserver(
            forName: NSControl.textDidChangeNotification,
            object: locationField,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.renderTravelRow() }
        }
        renderTravelRow()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func showCreate(
        start: Date,
        end: Date,
        calendars: [StarlingsCalendar],
        selectedCalendarID: String?,
        roomJoinURL: String?
    ) {
        isNew = true
        // Nothing to file yet: the event has no identity until it is saved.
        // File it from the inspector afterwards.
        hideFiling()
        meetLinkTouched = false
        describedNote.isHidden = true
        titleField.stringValue = ""
        startField.date = start
        endField.date = end
        // Off until the event looks like a meeting. A calendar is mostly
        // blocks of your own time — gym, lunch, a flight — and minting a room
        // link into every one of them puts a join door on your morning run.
        // Adding the first guest turns it on (see `guestsChanged`).
        meetLinkButton.state = .off
        meetLinkButton.isEnabled = roomJoinURL != nil
        meetLinkButton.isHidden = false
        guestsField.setAttendees([], emails: [])
        currentJoinURL = ""
        self.roomJoinURL = roomJoinURL ?? ""
        locationField.stringValue = ""
        renderLocationPlaceholder()
        notesView.string = ""
        originalNotes = ""
        notesButton.isHidden = true
        notesPopover.performClose(nil)
        originalLocation = ""
        originalAttendees = []
        travelAllowed = true
        originalTravelMinutes = 0
        travelControl.selectedSegment = 0
        renderTravelRow()
        mergedNote.isHidden = true
        rsvpLabel.isHidden = true
        rsvpControl.isHidden = true
        rsvpNote.isHidden = true
        spanLabel.isHidden = true
        spanControl.isHidden = true
        spanControl.selectedSegment = 0
        saveButton.apply(.accent, title: String(localized: "Add"), height: 36)
        // A read-only event shown before this left the button off; a new
        // event is always yours to add.
        saveButton.isEnabled = true
        populateCalendars(calendars, selectedID: selectedCalendarID)
        window?.makeFirstResponder(titleField)
    }

    /// Quick add event…: the sentence into the new event's form,
    /// for review and Add. The grammar first, the notes engine when it read
    /// no date. A name after "with" becomes a guest when the contacts know one
    /// address for it; the names stay in the title.
    func applyQuickAdd(_ sentence: String) {
        let typed = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isNew, !typed.isEmpty else { return }
        let context = CalendarQuickAdd.Context(defaultDurationMinutes: CalendarWindowPreferences.defaultDurationMinutes())
        let parsed = CalendarQuickAdd.parse(typed, context: context)
        if parsed.confidence == 0, let fallback = onDescribeFallback {
            describedNote.stringValue = String(localized: "Reading…")
            describedNote.isHidden = false
            Task { [weak self] in
                let answered = await fallback(typed, context.now, context.defaultDurationMinutes)
                self?.apply(answered ?? parsed, fromModel: answered != nil, context: context)
            }
            return
        }
        apply(parsed, fromModel: false, context: context)
    }

    private func apply(_ parsed: CalendarQuickAddDraft, fromModel: Bool, context: CalendarQuickAdd.Context) {
        titleField.stringValue = parsed.title
        if let location = parsed.location {
            locationField.stringValue = location
            renderTravelRow()
        }
        if let start = parsed.startDate() {
            // The Mac inspector writes timed events: an all-day draft lands
            // as its first day at the default hour, the days in the title.
            startField.date = start
            endField.date = parsed.allDay
                ? start.addingTimeInterval(TimeInterval(context.defaultDurationMinutes * 60))
                : parsed.endDate() ?? start.addingTimeInterval(TimeInterval(context.defaultDurationMinutes * 60))
        }
        if !parsed.invitees.isEmpty {
            let directory = ContactEmailDirectory.displayNameByEmail()
            var emails = draftAttendees
            for name in parsed.invitees {
                let needle = name.lowercased()
                let match = directory.first { $0.value.lowercased() == needle || $0.value.lowercased().hasPrefix(needle + " ") }
                if let email = match?.key.lowercased(), !emails.contains(email) { emails.append(email) }
            }
            if emails != draftAttendees {
                guestsField.setAttendees([], emails: emails)
                guestsChanged()
            }
        }
        describedNote.stringValue = fromModel
            ? String(localized: "Read by the notes engine. Check the times.")
            : parsed.confidence == 0
                ? String(localized: "No date read; the title is set.")
                : parsed.confidence < 1
                    ? String(localized: "Day read; set the time.")
                    : String(localized: "Filled in from the sentence.")
        describedNote.isHidden = false
        window?.makeFirstResponder(parsed.confidence == 0 ? titleField : startField)
    }

    func showEvent(
        _ event: StarlingsCalendarEvent,
        calendars: [StarlingsCalendar],
        includeMeetLink: Bool,
        alsoOn: [String] = []
    ) {
        isNew = false
        describedNote.isHidden = true
        mergedNote.stringValue = alsoOn.isEmpty
            ? ""
            : "Also on \(alsoOn.joined(separator: ", "))"
        mergedNote.isHidden = alsoOn.isEmpty
        titleField.stringValue = event.title
        startField.date = event.start
        endField.date = event.end
        // Only what the event already has. Defaulting this on meant opening
        // "Gym" to fix a typo and saving a Meet room into it.
        meetLinkTouched = false
        // Checked only when the link on the event is *our* room — a Google
        // Meet or Zoom link in `joinURL` is somebody else's meeting, not a
        // reason to say we added one. And only offered on an event you can
        // write: an invitation you received is not yours to put a room on.
        // Only when creating: an existing event either has our room or it
        // does not, and the editor is not where that changes. The state is
        // still tracked so a save carries the room through unchanged.
        let hasMeetRoom = !event.roomSlug.isEmpty
        meetLinkButton.state = hasMeetRoom ? .on : .off
        meetLinkButton.isEnabled = false
        meetLinkButton.isHidden = true
        guestsField.setAttendees(event.attendees, emails: event.attendeeEmails, lookUpContacts: true)
        currentJoinURL = event.joinURL
        locationField.stringValue = event.location
        renderLocationPlaceholder()
        notesView.string = event.notes
        originalNotes = event.notes
        notesButton.isHidden = event.notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        notesPopover.performClose(nil)
        originalLocation = event.location
        originalAttendees = event.attendeeEmails
        travelAllowed = event.source == .google && event.isWritable
        originalTravelMinutes = event.travelTimeMinutes ?? 0
        travelControl.selectedSegment = Self.travelChoices.firstIndex(of: originalTravelMinutes) ?? 0
        travelControl.isEnabled = travelAllowed
        renderTravelRow()
        renderRSVP(for: event)
        saveButton.apply(.accent, title: String(localized: "Save"), height: 36)
        saveButton.isEnabled = event.isWritable
        titleField.isEditable = event.isWritable
        locationField.isEditable = event.isWritable
        notesView.isEditable = event.isWritable
        startField.isEditable = event.isWritable
        endField.isEditable = event.isWritable
        populateCalendars(
            calendars,
            selectedID: event.calendarID,
            allowsCalendarMove: event.canMoveBetweenCalendars
        )
        // Internal is a stable home. Its calendar field is readable but not a
        // re-homing control; Duplicate remains available as a safe copy path.
        calendarField.isEnabled = event.canMoveBetweenCalendars
        guestsField.isHidden = event.source != .google
        canInviteGuests = event.source == .google && event.isWritable
        // Google lists instances expanded and has no cheap "this and following",
        // so its second choice is the whole series. EventKit really does support
        // this-and-future. Label each for what it actually does.
        let showSpan = event.isRecurring && event.isWritable
        spanControl.setLabel(String(localized: "This event"), forSegment: 0)
        spanControl.setLabel(event.source == .google ? String(localized: "All events") : String(localized: "All future"), forSegment: 1)
        spanLabel.isHidden = !showSpan
        spanControl.isHidden = !showSpan
        spanControl.selectedSegment = 0
        spanControl.isEnabled = event.isWritable
        // Filing is Envisioning's CRM. A personal account has nothing to file to.
        // Read off the full list, not `self.calendars`, which keeps only the
        // writable ones.
        if calendars.first(where: { $0.id == event.calendarID })?.isMemberAccount == true {
            showFiling(for: event)
        } else {
            hideFiling()
        }
    }

    /// What the event is filed under. Offered on every event of an Envisioning
    /// account, writable or not: filing is the owner's preference about the
    /// event, not a field of somebody else's invitation.
    private func showFiling(for event: StarlingsCalendarEvent) {
        filingLoadTask?.cancel()
        filedLabel.isHidden = false
        filingControls.isHidden = false
        let subject = event.subject
        filingControls.apply(MeetingCategory(
            meetingKind: subject?.meetingKind ?? .uncategorized,
            subjectID: subject?.id,
            subjectTitle: subject?.title
        ))
        filingControls.setBusy(false, message: subject.map { "New meetings use \($0.title)." } ?? String(localized: "Not filed."))
        guard let subjectKind = subject?.meetingKind.subjectKind else { return }
        // The rest of that kind, so the popup can move to another one.
        filingLoadTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let found = await onSubjectsNeeded?(subjectKind) ?? []
            guard !Task.isCancelled else { return }
            filingControls.setSubjects(found, selecting: subject?.id)
        }
    }

    private func hideFiling() {
        filingLoadTask?.cancel()
        filedLabel.isHidden = true
        filingControls.isHidden = true
    }

    private func populateCalendars(
        _ calendars: [StarlingsCalendar],
        selectedID: String?,
        allowsCalendarMove: Bool = true
    ) {
        self.calendars = calendars.filter { calendar in
            guard calendar.isWritable else { return false }
            // A new event may be created in Internal. When editing, shared
            // Internal is shown only as the event's existing home, never as a
            // move destination.
            return calendar.id == selectedID || (allowsCalendarMove && calendar.canBeMoveTarget)
        }
        let orderedCalendars = StarlingsCalendar.orderedGroups(of: self.calendars).flatMap { group in
            self.calendars.filter { $0.groupTitle == group }
        }
        let options = orderedCalendars.map { calendar in
            StarlingsSearchablePickerOption(
                id: calendar.id,
                title: calendar.title,
                context: calendar.groupTitle,
                subtitle: calendar.accountEmail,
                colorHex: String(format: "#%02X%02X%02X", Int(calendar.displayColor.red * 255), Int(calendar.displayColor.green * 255), Int(calendar.displayColor.blue * 255))
            )
        }
        let selected = selectedID ?? orderedCalendars.first?.id
        calendarField.setOptions(options, placeholder: String(localized: "Choose a calendar"), selectedID: selected)
        refreshGuestField()
    }

    /// Addresses currently typed, whether or not they have been saved.
    var draftAttendees: [String] { guestsField.addresses }

    @objc private func meetLinkToggled() {
        meetLinkTouched = true
        renderLocationPlaceholder()
    }

    /// The link row shows whenever the event has a call, or a new event will.
    /// Empty Location on such an event: the link takes the slot on save, and
    /// the placeholder says so without repeating the link.
    private func renderLocationPlaceholder() {
        let link = !currentJoinURL.isEmpty
            ? currentJoinURL
            : (isNew && meetLinkButton.state == .on ? roomJoinURL : "")
        joinLinkRow.isHidden = link.isEmpty
        if !link.isEmpty { joinLinkRow.setInviteURL(link) }
        locationField.placeholderString = link.isEmpty
            ? String(localized: "Location")
            : String(localized: "Location, or the call link")
    }

    private func guestsChanged() {
        // Guests are what makes an event a meeting. The first one turns the
        // room on for a new event; removing them all turns it back off, up
        // until the moment the checkbox is set by hand.
        if isNew, !meetLinkTouched, meetLinkButton.isEnabled {
            meetLinkButton.state = draftAttendees.isEmpty ? .off : .on
            renderLocationPlaceholder()
        }
        onGuestsChanged?(draftAttendees)
    }

    private func refreshGuestField() {
        let selected = selectedCalendarID.flatMap { id in calendars.first { $0.id == id } }
        canInviteGuests = selected?.source == .google
        guestsField.isHidden = !canInviteGuests
    }

    @objc private func saveTapped() {
        let title = titleField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        // Never a silent no-op: say what is missing and put the caret there.
        guard !title.isEmpty else {
            onValidationError?(String(localized: "Give the event a title first"))
            window?.makeFirstResponder(titleField)
            return
        }
        let calendarID = calendarField.selectedID
            ?? calendars.first?.id
        guard let calendarID else {
            onValidationError?(String(localized: "No writable calendar to add this to — pick one in the sidebar"))
            return
        }
        let attendees = guestsField.addresses
        let notes = notesView.string
        let location = locationField.stringValue
        onSave?(CalendarInspectorDraft(
            title: title,
            start: startField.date,
            end: max(endField.date, startField.date.addingTimeInterval(15 * 60)),
            calendarID: calendarID,
            includeMeetLink: meetLinkButton.state == .on,
            // Untouched fields go as nil so the write leaves them alone.
            attendees: (isNew || attendees != originalAttendees) ? attendees : nil,
            notes: (isNew || notes != originalNotes) ? notes : nil,
            location: (isNew || location != originalLocation) ? location : nil,
            travelTimeMinutes: travelAllowed && selectedTravelMinutes != originalTravelMinutes ? selectedTravelMinutes : nil,
            span: selectedSpan
        ))
    }

    /// The row appears once there is somewhere to get to, or a value to
    /// clear; an EventKit event never shows it.
    private func renderTravelRow() {
        let hasPlace = !locationField.stringValue.trimmingCharacters(in: .whitespaces).isEmpty
        let shown = travelAllowed && (hasPlace || selectedTravelMinutes > 0)
        travelLabel.isHidden = !shown
        travelControl.isHidden = !shown
    }

    /// Return on a selected event should put the caret in the title.
    func focusTitle() {
        guard titleField.isEditable else { return }
        window?.makeFirstResponder(titleField)
    }

    private func renderRSVP(for event: StarlingsCalendarEvent) {
        guard let mine = event.myResponse else {
            rsvpLabel.isHidden = true
            rsvpControl.isHidden = true
            rsvpNote.isHidden = true
            return
        }
        rsvpLabel.isHidden = false
        rsvpControl.isHidden = false
        rsvpControl.selectedSegment = CalendarRSVP.answers.firstIndex(of: mine) ?? -1
        // Readable everywhere, answerable only on Google.
        rsvpControl.isEnabled = event.canRespond
        rsvpNote.isHidden = event.canRespond
        rsvpNote.stringValue = event.canRespond
            ? ""
            : "Reply in Calendar for iCloud invitations."
    }

    @objc private func rsvpChanged() {
        let index = rsvpControl.selectedSegment
        guard CalendarRSVP.answers.indices.contains(index) else { return }
        onRespond?(CalendarRSVP.answers[index])
    }

    @objc private func notesTapped() {
        if notesPopover.isShown {
            notesPopover.performClose(nil)
        } else {
            notesPopover.show(relativeTo: notesButton.bounds, of: notesButton, preferredEdge: .maxY)
        }
    }

    @objc private func cancelTapped() {
        onCancel?()
    }

    private func sectionLabel(_ title: String) -> NSTextField {
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold)
        label.textColor = StarlingsColors.secondaryText
        return label
    }
}

struct CalendarInspectorDraft: Equatable, Sendable {
    var title: String
    var start: Date
    var end: Date
    var calendarID: String
    var includeMeetLink: Bool
    /// `nil` means "unchanged — leave what the server already stores".
    var attendees: [String]?
    var notes: String?
    var location: String?
    /// nil is untouched; 0 is Off.
    var travelTimeMinutes: Int?
    var span: CalendarEditSpan
}

/// The shell's inspector, for Calendar: the one event chosen, read and
/// edited in a panel that floats over the grid's trailing edge, so the days
/// keep their width while it is open. The form is the same
/// `CalendarInspectorView`; this only gives it the panel's ground, a
/// scroll for windows shorter than the form, and something honest to say
/// when the toolbar toggle opens the column with nothing chosen.
@MainActor
final class CalendarInspectorViewController: NSViewController {
    let inspector = CalendarInspectorView()
    /// A task, milestone, published event or availability block, read-only
    ///. Shares the panel with the form; one shows at a time.
    let layerDetail = CalendarLayerDetailView()
    private let scroll = NSScrollView()
    private let layerScroll = NSScrollView()
    private var showsLayer = false
    private let emptyLabel = StarlingsTypography.wrappingLabel(String(localized: "Select an event to view or edit."))
    /// The panel's ✕. It puts the inspector away without
    /// touching the event; Esc, a click on empty grid and the toolbar toggle
    /// are the other ways, and this is the one that is visible.
    var onClose: (() -> Void)?
    private let closeButton = NSButton(title: "", target: nil, action: nil)

    override func loadView() {
        let root = StarlingsShellBackdrop(ground: StarlingsColors.panel)

        for (scrollView, document) in [(scroll, inspector as NSView), (layerScroll, layerDetail as NSView)] {
            scrollView.drawsBackground = false
            scrollView.hasVerticalScroller = true
            scrollView.borderType = .noBorder
            let clip = CalendarInspectorClipView()
            clip.drawsBackground = false
            scrollView.contentView = clip
            document.translatesAutoresizingMaskIntoConstraints = false
            scrollView.documentView = document
            scrollView.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(scrollView)
            // A strip across the top is the ✕'s, so it never sits on a field.
            NSLayoutConstraint.activate([
                scrollView.topAnchor.constraint(equalTo: root.topAnchor, constant: 30),
                scrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
                scrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
                scrollView.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            ])
            document.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor).isActive = true
        }

        emptyLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        emptyLabel.textColor = StarlingsColors.secondaryText
        emptyLabel.alignment = .center
        emptyLabel.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(emptyLabel)
        NSLayoutConstraint.activate([
            emptyLabel.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            emptyLabel.widthAnchor.constraint(lessThanOrEqualTo: root.widthAnchor, constant: -48),
        ])

        closeButton.image = NSImage(
            systemSymbolName: "xmark",
            accessibilityDescription: String(localized: "Close")
        )?.withSymbolConfiguration(.init(pointSize: 11, weight: .semibold))
        closeButton.imagePosition = .imageOnly
        closeButton.bezelStyle = .inline
        closeButton.isBordered = false
        closeButton.contentTintColor = StarlingsColors.secondaryText
        closeButton.toolTip = String(localized: "Close")
        closeButton.setAccessibilityLabel(String(localized: "Close"))
        closeButton.target = self
        closeButton.action = #selector(closePressed)
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        SettingsChrome.applyQuietButton(closeButton)
        root.addSubview(closeButton)
        NSLayoutConstraint.activate([
            closeButton.topAnchor.constraint(equalTo: root.topAnchor, constant: 8),
            closeButton.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
            closeButton.widthAnchor.constraint(equalToConstant: 22),
            closeButton.heightAnchor.constraint(equalToConstant: 22),
        ])

        scroll.isHidden = true
        layerScroll.isHidden = true
        view = root
    }

    @objc private func closePressed() {
        onClose?()
    }

    /// Esc from a field inside the panel: the same close.
    override func cancelOperation(_ sender: Any?) {
        onClose?()
    }

    /// Nothing chosen: the form goes, one sentence takes its place.
    func setEmpty(_ empty: Bool) {
        loadViewIfNeeded()
        scroll.isHidden = empty || showsLayer
        layerScroll.isHidden = empty || !showsLayer
        emptyLabel.isHidden = !empty
    }

    /// The event form, for an event or a new one.
    func showForm() {
        loadViewIfNeeded()
        showsLayer = false
        scroll.isHidden = !emptyLabel.isHidden
        layerScroll.isHidden = true
    }

    func showLayer(_ item: CalendarLayerItem) {
        loadViewIfNeeded()
        showsLayer = true
        layerDetail.show(item)
        scroll.isHidden = true
        layerScroll.isHidden = !emptyLabel.isHidden
    }
}

/// A layer row, read in the inspector: what it is, when, whose, and the
/// ways to where it lives. No fields and no Save. Core owns the row, and
/// Work is where it is changed (; editing is).
@MainActor
final class CalendarLayerDetailView: NSView {
    /// A Work link was pressed. The controller hands it to the window
    /// that owns Work.
    var onOpenWork: ((WorkDestination) -> Void)?

    private let stack = NSStackView()
    private var item: CalendarLayerItem?

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        stack.pinToEdges(of: self)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show(_ item: CalendarLayerItem) {
        self.item = item
        for view in stack.arrangedSubviews {
            stack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }

        let kind = label(item.kind.title, size: 11, weight: .semibold, color: item.kind.color.nsColor)
        let title = label(item.displayTitle, size: 15, weight: .semibold, color: StarlingsColors.primaryText)
        title.maximumNumberOfLines = 4
        let when = label(item.whenText, size: 12, weight: .regular, color: StarlingsColors.secondaryText)
        let header = NSStackView(views: [kind, title, when])
        header.orientation = .vertical
        header.alignment = .leading
        header.spacing = 4
        add(header)

        var facts: [(String, String)] = []
        if !item.detail.isEmpty {
            facts.append((item.kind == .publicEvents ? String(localized: "Location") : String(localized: "Project"), item.detail))
        }
        if !item.assignee.isEmpty {
            facts.append((item.isMine ? String(localized: "Assigned to you") : String(localized: "Assigned to"), item.assignee))
        }
        if !item.status.isEmpty { facts.append((String(localized: "Status"), item.statusText)) }
        for (name, value) in facts {
            let pair = NSStackView(views: [
                label(name, size: 11, weight: .regular, color: StarlingsColors.secondaryText),
                label(value, size: 12, weight: .regular, color: StarlingsColors.primaryText),
            ])
            pair.orientation = .vertical
            pair.alignment = .leading
            pair.spacing = 2
            add(pair)
        }

        if !item.notes.isEmpty {
            let notes = label(item.notes, size: 12, weight: .regular, color: StarlingsColors.primaryText)
            notes.maximumNumberOfLines = 0
            notes.isSelectable = true
            add(notes)
        }

        var buttons: [NSButton] = []
        for (index, link) in item.workLinks.enumerated() {
            let button = NSButton(title: link.title, target: self, action: #selector(openWorkPressed(_:)))
            button.tag = index
            SettingsChrome.applySecondaryButton(button, title: link.title, height: 32)
            buttons.append(button)
        }
        if !item.url.isEmpty {
            let button = NSButton(title: item.kind.openTitle, target: self, action: #selector(openURLPressed(_:)))
            SettingsChrome.applySecondaryButton(button, title: item.kind.openTitle, symbolName: "arrow.up.right", height: 32)
            buttons.append(button)
        }
        if !buttons.isEmpty {
            let column = NSStackView(views: buttons)
            column.orientation = .vertical
            column.alignment = .leading
            column.spacing = 8
            add(column)
        }

        add(label(item.kind.caption, size: 11, weight: .regular, color: StarlingsColors.secondaryText))
    }

    private func add(_ view: NSView) {
        stack.addArrangedSubview(view)
        view.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor, constant: -40).isActive = true
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSTextField {
        let label = StarlingsTypography.wrappingLabel(text)
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(size), weight: weight)
        label.textColor = color
        label.maximumNumberOfLines = 3
        return label
    }

    @objc private func openWorkPressed(_ sender: NSButton) {
        guard let links = item?.workLinks, links.indices.contains(sender.tag) else { return }
        onOpenWork?(links[sender.tag].destination)
    }

    @objc private func openURLPressed(_ sender: NSButton) {
        guard let raw = item?.url, let url = URL(string: raw) else { return }
        NSWorkspace.shared.open(url)
    }
}

/// The form reads from the top down, like the rail beside it.
private final class CalendarInspectorClipView: NSClipView {
    override var isFlipped: Bool { true }
}

/// One event edge as two wells: the day as text ("19 Sep", no year — the
/// calendar is always this year or next and the year only cost width) and
/// the clock as a stepper picker. The picker keeps the full `Date`; the day
/// field rewrites its year, month and day on commit.
@MainActor
final class StarlingsDayTimeField: NSView, NSTextFieldDelegate {
    private let dayField = StarlingsTextField(placeholder: String(localized: "19 Sep"))
    private let timeField = StarlingsDatePickerField()

    var date: Date {
        get { timeField.picker.dateValue }
        set {
            timeField.picker.dateValue = newValue
            dayField.stringValue = Self.dayFormatter.string(from: newValue)
        }
    }

    var isEditable: Bool = true {
        didSet {
            dayField.isEditable = isEditable
            timeField.picker.isEnabled = isEditable
        }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        timeField.picker.datePickerElements = [.hourMinute]
        timeField.picker.minuteStep = 5
        // The clock well is exactly its picker plus the well's insets. It has
        // no intrinsic width of its own, and without this the stack handed it
        // the whole row and left the day well 8pt wide.
        timeField.widthAnchor.constraint(equalTo: timeField.picker.widthAnchor, constant: 16).isActive = true
        dayField.delegate = self
        dayField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let row = NSStackView(views: [dayField, timeField])
        row.orientation = .horizontal
        row.spacing = 8
        row.alignment = .centerY
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: topAnchor),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func controlTextDidEndEditing(_ obj: Notification) {
        commitDay()
    }

    /// Accepts "19 Sep", "19 sep 2026", "19/9" and "19/09/2026". Anything else
    /// snaps the field back to the date it already holds.
    private func commitDay() {
        let typed = dayField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let calendar = Calendar.autoupdatingCurrent
        var merged: Date?
        for (format, carriesYear) in Self.inputFormats {
            let formatter = DateFormatter()
            formatter.locale = StarlingsDateFormatting.locale
            formatter.dateFormat = format
            guard let parsed = formatter.date(from: typed) else { continue }
            var parts = calendar.dateComponents([.year, .month, .day], from: parsed)
            if !carriesYear {
                parts.year = calendar.component(.year, from: date)
            }
            let time = calendar.dateComponents([.hour, .minute], from: date)
            parts.hour = time.hour
            parts.minute = time.minute
            merged = calendar.date(from: parts)
            break
        }
        date = merged ?? date
    }

    private static let inputFormats: [(String, Bool)] = [
        ("d MMM", false), ("d MMMM", false), ("d/M", false),
        ("d MMM yyyy", true), ("d MMMM yyyy", true), ("d/M/yyyy", true),
    ]

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = StarlingsDateFormatting.locale
        formatter.dateFormat = "d MMM"
        return formatter
    }()
}
