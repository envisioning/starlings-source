import AppKit

/// Settings › Calendar › Booking hours on the Mac. The same
/// editor as the web's `BookingSettings.tsx` and the phone's
/// `MobileBookingHoursView`: the hours and the zone are the member's profile
/// hours, the rest is how a guest books a slot inside them. Save writes the
/// whole form once, as the web does.
@MainActor
final class BookingHoursSettingsView: NSView {
    private let api: MeetingControlAPI

    private let noteLabel = StarlingsTypography.wrappingLabel("")
    private let warningNotice = StarlingsNoticeView(wrapping: true)
    private let loadNotice = StarlingsNoticeView(wrapping: true)
    private let formStack = NSStackView()
    private let activeRow = SettingsToggleRow(title: String(localized: "Take bookings"))
    private let zonePicker = StarlingsSearchablePickerField(frame: .zero)
    private var dayRows: [BookingWeekday: BookingDayRow] = [:]
    private var numberRows: [BookingNumberRow] = []
    private let saveButton = StarlingsFilledButton(style: .accent, title: String(localized: "Save booking hours"))
    private let saveNotice = StarlingsNoticeView(wrapping: true)

    private var saved: BookingSettingsResponse?
    private var draft: BookingSettingsUpdate?
    private var isLoading = false
    private var isSaving = false

    /// Nil while the Calendar page has not heard from the Worker yet; the
    /// warning only shows on a definite "not connected", as on the web.
    var calendarConnected: Bool? {
        didSet { renderWarning() }
    }

    init(api: MeetingControlAPI) {
        self.api = api
        super.init(frame: .zero)
        build()
        render()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: - Layout

    private func build() {
        noteLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        noteLabel.textColor = StarlingsColors.secondaryText
        noteLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        activeRow.onChange = { [weak self] value in
            self?.change { $0.active = value }
        }

        zonePicker.onSelection = { [weak self] zone in
            self?.change { $0.timezone = zone }
        }
        zonePicker.setAccessibilityLabel(String(localized: "Time zone"))
        let zoneRow = Self.labelledRow(title: String(localized: "Time zone"), control: zonePicker)
        zonePicker.widthAnchor.constraint(equalToConstant: 240).isActive = true

        var dayViews: [NSView] = []
        for day in BookingWeekday.allCases {
            let row = BookingDayRow(day: day)
            row.onChange = { [weak self] hours in
                self?.change { $0.weeklyHours = $0.weeklyHours.replacing(day, with: hours) }
            }
            dayRows[day] = row
            dayViews.append(row)
        }

        for field in BookingHours.numberFields {
            let row = BookingNumberRow(field: field)
            row.onChange = { [weak self] value in
                self?.change { $0[keyPath: field.id] = value }
            }
            numberRows.append(row)
        }

        let rulesGroup = SettingsGroupView(rows: [activeRow, zoneRow])
        let daysGroup = SettingsGroupView(rows: dayViews)
        let numbersGroup = SettingsGroupView(rows: numberRows)

        saveButton.apply(
            .accent,
            title: String(localized: "Save booking hours"),
            font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold)
        )
        saveButton.target = self
        saveButton.action = #selector(saveTapped)
        saveButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 180).isActive = true
        let saveLine = NSStackView(views: [saveButton, saveNotice, NSView()])
        saveLine.orientation = .horizontal
        saveLine.alignment = .centerY
        saveLine.spacing = 10

        formStack.orientation = .vertical
        formStack.alignment = .width
        formStack.spacing = 12
        for view in [rulesGroup, daysGroup, numbersGroup, saveLine] as [NSView] {
            formStack.addArrangedSubview(view)
        }

        let stack = NSStackView(views: [noteLabel, warningNotice, loadNotice, formStack])
        stack.orientation = .vertical
        stack.alignment = .width
        stack.spacing = 12
        addSubview(stack)
        stack.pinToEdges(of: self)
    }

    /// Title on the left, control on the right: the settings list row.
    private static func labelledRow(title: String, control: NSView) -> NSView {
        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .medium)
        titleLabel.textColor = StarlingsColors.primaryText
        let row = NSStackView(views: [titleLabel, NSView(), control])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        let wrap = NSView()
        wrap.addSubview(row)
        row.pinToEdges(of: wrap, insets: SettingsChrome.rowInset)
        wrap.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
        return wrap
    }

    // MARK: - Data

    /// Reads the saved settings. An edit not yet saved is kept: Settings
    /// refreshes every time its window becomes key.
    func reload(signedIn: Bool) {
        guard signedIn else {
            saved = nil
            draft = nil
            loadNotice.setText(String(localized: "Sign in to load your booking hours."))
            render()
            return
        }
        guard !isLoading, !isSaving else { return }
        if let saved, let draft, draft != BookingHours.draft(from: saved) { return }
        isLoading = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { isLoading = false }
            do {
                let loaded = try await api.bookingSettings()
                saved = loaded
                draft = BookingHours.draft(from: loaded)
                loadNotice.clear()
            } catch {
                if draft == nil { loadNotice.showError(error) }
            }
            render()
        }
    }

    private func change(_ edit: (inout BookingSettingsUpdate) -> Void) {
        guard var next = draft else { return }
        edit(&next)
        draft = next
        saveNotice.clear()
        render()
    }

    @objc private func saveTapped() {
        guard let draft, !isSaving else { return }
        // A number typed without Return still counts.
        var update = draft
        for row in numberRows { update[keyPath: row.field.id] = row.committedValue(fallback: update[keyPath: row.field.id]) }
        isSaving = true
        saveNotice.clear()
        render()
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                isSaving = false
                render()
            }
            do {
                let next = try await api.saveBookingSettings(update)
                saved = next
                self.draft = BookingHours.draft(from: next)
                saveNotice.setText(BookingHours.saved)
            } catch {
                saveNotice.showError(error)
            }
        }
    }

    // MARK: - Render

    private func render() {
        noteLabel.stringValue = BookingHours.note(room: saved?.room)
        renderWarning()
        guard let draft else {
            formStack.isHidden = true
            return
        }
        formStack.isHidden = false
        let enabled = !isSaving
        activeRow.isOn = draft.active
        activeRow.isEnabled = enabled
        zonePicker.setOptions(
            BookingHours.timeZoneOptions(current: draft.timezone),
            placeholder: String(localized: "Time zone"),
            selectedID: draft.timezone
        )
        zonePicker.isEnabled = enabled
        for day in BookingWeekday.allCases {
            dayRows[day]?.show(draft.weeklyHours[day], enabled: enabled)
        }
        for row in numberRows {
            row.show(draft[keyPath: row.field.id], enabled: enabled)
        }
        saveButton.apply(
            .accent,
            title: isSaving ? String(localized: "Saving…") : String(localized: "Save booking hours"),
            font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold)
        )
        saveButton.isEnabled = enabled
    }

    private func renderWarning() {
        if saved?.room != nil, calendarConnected == false {
            warningNotice.showError(BookingHours.notTakingBookingsWarning)
        } else {
            warningNotice.clear()
        }
    }
}

/// One weekday: on or off, from, until, on quarter hours of the 24-hour clock.
@MainActor
private final class BookingDayRow: NSView {
    var onChange: ((BookingDayHours) -> Void)?

    private let checkbox: NSButton
    private let fromPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let untilPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private var hours = BookingDayHours(enabled: false, startMinute: 9 * 60, endMinute: 17 * 60)

    init(day: BookingWeekday) {
        checkbox = NSButton(checkboxWithTitle: day.label, target: nil, action: nil)
        super.init(frame: .zero)
        checkbox.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .medium)
        checkbox.applyMeetCheckboxStyle()
        checkbox.target = self
        checkbox.action = #selector(toggled)

        let clocks = BookingHours.clockMinutes.map(BookingHours.clock)
        for (popup, label) in [
            (fromPopup, String(localized: "\(day.label) from")),
            (untilPopup, String(localized: "\(day.label) until")),
        ] {
            popup.bezelStyle = .rounded
            popup.controlSize = .regular
            popup.addItems(withTitles: clocks)
            popup.target = self
            popup.action = #selector(timeChanged)
            popup.setAccessibilityLabel(label)
            popup.setContentHuggingPriority(.required, for: .horizontal)
        }

        let toLabel = NSTextField(labelWithString: String(localized: "to"))
        toLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        toLabel.textColor = StarlingsColors.secondaryText

        let row = NSStackView(views: [checkbox, NSView(), fromPopup, toLabel, untilPopup])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        addSubview(row)
        row.pinToEdges(of: self, insets: SettingsChrome.rowInset)
        heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show(_ hours: BookingDayHours, enabled: Bool) {
        self.hours = hours
        checkbox.state = hours.enabled ? .on : .off
        checkbox.isEnabled = enabled
        select(fromPopup, minute: hours.startMinute)
        select(untilPopup, minute: hours.endMinute)
        fromPopup.isEnabled = enabled && hours.enabled
        untilPopup.isEnabled = enabled && hours.enabled
    }

    private func select(_ popup: NSPopUpButton, minute: Int) {
        if let index = BookingHours.clockMinutes.firstIndex(of: minute) {
            popup.selectItem(at: index)
        } else {
            // A saved minute off the quarter hour (set elsewhere) still reads.
            popup.select(nil)
            popup.setTitle(BookingHours.clock(minute))
        }
    }

    @objc private func toggled() {
        onChange?(hours.with(enabled: checkbox.state == .on))
    }

    @objc private func timeChanged(_ sender: NSPopUpButton) {
        let index = sender.indexOfSelectedItem
        guard BookingHours.clockMinutes.indices.contains(index) else { return }
        let minute = BookingHours.clockMinutes[index]
        onChange?(sender === fromPopup ? hours.with(startMinute: minute) : hours.with(endMinute: minute))
    }
}

/// One of the five numbers. Return commits; Save also reads what is typed.
@MainActor
private final class BookingNumberRow: NSView {
    let field: BookingHours.NumberField
    var onChange: ((Int) -> Void)?

    private let input = StarlingsTextField(placeholder: "")
    /// The value the form holds, for a field left with no number in it.
    private var shown = 0

    init(field: BookingHours.NumberField) {
        self.field = field
        super.init(frame: .zero)
        let titleLabel = NSTextField(labelWithString: field.label)
        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .medium)
        titleLabel.textColor = StarlingsColors.primaryText
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        input.alignment = .right
        input.target = self
        input.action = #selector(commit)
        input.setAccessibilityLabel(field.label)
        input.setContentHuggingPriority(.required, for: .horizontal)

        let row = NSStackView(views: [titleLabel, NSView(), input])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        addSubview(row)
        row.pinToEdges(of: self, insets: SettingsChrome.rowInset)
        NSLayoutConstraint.activate([
            input.widthAnchor.constraint(equalToConstant: 80),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show(_ value: Int, enabled: Bool) {
        shown = value
        // Leave a field the person is typing in alone.
        if input.currentEditor() == nil {
            input.stringValue = String(value)
        }
        input.isEnabled = enabled
    }

    /// What is typed, inside the field's range; the fallback when it is not a number.
    func committedValue(fallback: Int) -> Int {
        guard let typed = Int(input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)) else { return fallback }
        return field.clamped(typed)
    }

    @objc private func commit() {
        let value = committedValue(fallback: shown)
        input.stringValue = String(value)
        onChange?(value)
    }
}
