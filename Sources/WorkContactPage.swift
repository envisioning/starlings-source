import AppKit

/// A contact's page on the Mac (docs/RELATIONSHIPS.md slice 2):
/// their addresses, the projects and leads they are on, the calls they were
/// in and the members who met them. Work's inspector draws it beside the
/// organization or the search that opened it. Every block folds, and each
/// fold is kept per block, as every other list header in Work.
@MainActor
enum WorkContactPage {
    static func sections(
        _ contact: CrmContactDetail,
        onOpenSubject: @escaping (CrmSubject) -> Void,
        onOpenCall: @escaping (CrmInteraction) -> Void
    ) -> [NSView] {
        var sections: [NSView] = []

        let addresses = SidebarSection(title: String(localized: "ADDRESSES"), key: "work.contact.addresses")
        addresses.setRows(contact.emails.enumerated().map { index, email in
            row(
                title: email,
                detail: index == 0 && contact.emails.count > 1 ? String(localized: "Primary") : "",
                accessibility: String(localized: "Write to \(email)")
            ) {
                if let url = URL(string: "mailto:\(email)") { NSWorkspace.shared.open(url) }
            }
        }, count: contact.emails.count)
        if contact.emails.isEmpty { addresses.setRows([quiet(String(localized: "No addresses."))], count: 0) }
        sections.append(addresses)

        // Birthday, language, Signals status and characteristics:
        // a row only for a field with a value, and no block when none has one.
        let profile = ContactProfileDraft(contact: contact)
        var facts: [NSView] = []
        if let birthday = ContactFieldText.birthday(month: profile.birthdayMonth, day: profile.birthdayDay, year: profile.birthdayYear) {
            facts.append(fact(String(localized: "Birthday"), birthday))
        }
        if let language = ContactListFilter.trimmed(contact.preferredLanguage) {
            facts.append(fact(String(localized: "Language"), ContactFieldText.language(language)))
        }
        if let status = profile.signalsOutreachStatus {
            facts.append(fact(String(localized: "Signals status"), ContactFieldText.outreach(status)))
        }
        let characteristics = profile.characteristics.filter(\.value).keys.sorted().map(ContactFieldText.characteristic)
        if !characteristics.isEmpty {
            facts.append(fact(String(localized: "Characteristics"), characteristics.joined(separator: ", ")))
        }
        if !facts.isEmpty {
            let details = SidebarSection(title: String(localized: "DETAILS"), key: "work.contact.details")
            details.setRows(facts, count: facts.count)
            sections.append(details)
        }

        for (title, key, rows, kind, empty) in [
            (String(localized: "PROJECTS"), "work.contact.projects", contact.projects, "project", String(localized: "On no project.")),
            (String(localized: "LEADS"), "work.contact.leads", contact.leads, "lead", String(localized: "On no lead.")),
        ] {
            let section = SidebarSection(title: title, key: key)
            if rows.isEmpty {
                section.setRows([quiet(empty)], count: 0)
            } else {
                section.setRows(rows.map { related in
                    let subject = CrmSubject(
                        id: related.id,
                        kind: kind,
                        title: related.title?.isEmpty == false ? related.title! : String(localized: "Untitled"),
                        subtitle: related.status
                    )
                    return row(title: subject.title, detail: related.status ?? "", accessibility: subject.title) { onOpenSubject(subject) }
                }, count: rows.count)
            }
            sections.append(section)
        }

        let calls = SidebarSection(title: String(localized: "CALLS"), key: "work.contact.calls")
        if contact.interactions.isEmpty {
            calls.setRows([quiet(String(localized: "No calls yet."))], count: 0)
        } else {
            calls.setRows(contact.interactions.map { interaction in
                row(title: interaction.displayTitle, detail: interaction.metadataLabel, accessibility: interaction.displayTitle) { onOpenCall(interaction) }
            }, count: contact.interactions.count)
        }
        sections.append(calls)

        if !contact.metBy.isEmpty {
            let metBy = SidebarSection(title: String(localized: "MET BY"), key: "work.contact.met-by")
            metBy.setRows(contact.metBy.map { member in
                let name = member.name ?? member.email
                return row(title: name, detail: String(localized: "\(member.calls) calls"), accessibility: name) {}
            }, count: contact.metBy.count)
            sections.append(metBy)
        }
        return sections
    }

    private static func row(title: String, detail: String, accessibility: String, onActivate: @escaping () -> Void) -> NSView {
        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = WorkListRowView.titleFont()
        titleLabel.textColor = StarlingsColors.primaryText
        titleLabel.allowSqueezing()
        let stack = NSStackView(views: [titleLabel])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = WorkListRowView.textSpacing
        if !detail.isEmpty {
            let detailLabel = NSTextField(labelWithString: detail)
            detailLabel.font = WorkListRowView.detailFont()
            detailLabel.textColor = StarlingsColors.secondaryText
            detailLabel.allowSqueezing()
            stack.addArrangedSubview(detailLabel)
        }
        return WorkListRowView(content: stack, isSelected: false, accessibilityLabel: accessibility, onActivate: onActivate)
    }

    /// A caption over its value. Not a control: nothing to click.
    private static func fact(_ caption: String, _ value: String) -> NSView {
        let captionLabel = NSTextField(labelWithString: caption)
        captionLabel.font = WorkListRowView.detailFont()
        captionLabel.textColor = StarlingsColors.secondaryText
        captionLabel.allowSqueezing()
        let valueLabel = NSTextField(wrappingLabelWithString: value)
        valueLabel.font = WorkListRowView.titleFont()
        valueLabel.textColor = StarlingsColors.primaryText
        let stack = NSStackView(views: [captionLabel, valueLabel])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = WorkListRowView.textSpacing
        stack.edgeInsets = NSEdgeInsets(top: 4, left: 8, bottom: 4, right: 8)
        return stack
    }

    private static func quiet(_ text: String) -> NSView {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        label.textColor = StarlingsColors.secondaryText
        return label
    }
}

/// Add a contact, or edit one, on the Mac: name, title,
/// organization, and addresses one per line, the primary first. A sheet over
/// Work's window, open until the save lands, like the subject editor.
@MainActor
enum WorkContactEditor {
    static func present(
        over window: NSWindow?,
        api: MeetingControlAPI,
        contact: CrmContactDetail?,
        organization: SubjectRelationOption? = nil,
        onSaved: @escaping (CrmContactDetail) -> Void
    ) {
        ContactSheetController(api: api, contact: contact, organization: organization, onSaved: onSaved).run(over: window)
    }
}

@MainActor
private final class ContactSheetController: NSViewController, NSTextFieldDelegate {
    private enum Metrics {
        static let width: CGFloat = 460
        static let padding: CGFloat = 20
        static let gap: CGFloat = 14
        static let buttonHeight: CGFloat = 32
    }

    private let api: MeetingControlAPI
    private let contact: CrmContactDetail?
    private let organization: SubjectRelationOption?
    private let onSaved: (CrmContactDetail) -> Void
    private let nameField = StarlingsTextField(placeholder: String(localized: "Name"))
    private let titleField = StarlingsTextField(placeholder: String(localized: "Title"))
    private let organizationPicker: RelationPickerView
    private let addressesView = NSTextView()
    private let saveButton = StarlingsFilledButton(frame: .zero)
    private let cancelButton = NSButton(title: String(localized: "Cancel"), target: nil, action: nil)
    private let errorLabel = StarlingsNoticeView(wrapping: true)
    private var saveTask: Task<Void, Never>?
    /// Birthday, characteristics, language and Signals status.
    /// `initialProfile` is what the contact carried, nil for a new one; the
    /// save sends only what differs from it.
    private let initialProfile: ContactProfileDraft?
    private var profile: ContactProfileDraft
    private let monthField = StarlingsPopUpField(frame: .zero)
    private let dayField = StarlingsPopUpField(frame: .zero)
    private let yearField = StarlingsTextField(placeholder: String(localized: "Year"))
    private let languageField = StarlingsPopUpField(frame: .zero)
    private let outreachField = StarlingsPopUpField(frame: .zero)
    private let characteristicsStack = NSStackView()
    private var characteristicsRow: NSView?
    private var characteristicBoxes: [String: NSButton] = [:]
    /// What the workspace offers. Nil until the read lands, and after a failed
    /// read: the sheet then offers what the contact carries.
    private var options: CrmContactOptionsResponse?
    private var optionsTask: Task<Void, Never>?

    init(api: MeetingControlAPI, contact: CrmContactDetail?, organization: SubjectRelationOption?, onSaved: @escaping (CrmContactDetail) -> Void) {
        self.api = api
        self.contact = contact
        self.organization = organization
        self.onSaved = onSaved
        initialProfile = contact.map(ContactProfileDraft.init(contact:))
        profile = initialProfile ?? ContactProfileDraft()
        organizationPicker = RelationPickerView(
            mode: .single,
            placeholder: String(localized: "Search organizations"),
            emptyText: String(localized: "No organizations match"),
            search: { query in try await api.crmOrganizations(matching: query) },
            create: { name in try await api.crmCreateOrganization(named: name) }
        )
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private var heading: String { contact == nil ? String(localized: "Add contact") : String(localized: "Edit contact") }

    override func loadView() {
        let root = NSView()
        root.wantsLayer = true
        root.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.panel, for: root).cgColor

        let headingLabel = NSTextField(labelWithString: heading)
        headingLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(15), weight: .semibold)
        headingLabel.textColor = StarlingsColors.primaryText

        nameField.stringValue = contact?.name ?? ""
        nameField.delegate = self
        titleField.stringValue = contact?.title ?? ""
        if let id = contact?.organizationID {
            organizationPicker.setSelected([SubjectRelationOption(id: id, name: contact?.organizationName ?? String(localized: "Organization"))])
        } else if let organization {
            organizationPicker.setSelected([organization])
        }
        organizationPicker.onChange = { [weak self] in self?.resizeToFit() }
        organizationPicker.onError = { [weak self] message in
            self?.errorLabel.showError(message)
            self?.resizeToFit()
        }

        addressesView.string = (contact?.emails ?? []).joined(separator: "\n")
        addressesView.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        addressesView.textColor = StarlingsColors.primaryText
        addressesView.backgroundColor = StarlingsColors.field
        addressesView.drawsBackground = true
        addressesView.isRichText = false
        addressesView.textContainerInset = NSSize(width: 8, height: 7)
        StarlingsTextField.styleFieldEditor(addressesView, font: .systemFont(ofSize: StarlingsTypography.scaled(13)))
        let addressesScroll = NSScrollView()
        addressesScroll.borderType = .bezelBorder
        addressesScroll.hasVerticalScroller = true
        addressesScroll.documentView = addressesView
        addressesView.minSize = NSSize(width: 0, height: 70)
        addressesView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        addressesView.isVerticallyResizable = true
        addressesView.isHorizontallyResizable = false
        addressesView.autoresizingMask = [.width]
        addressesScroll.heightAnchor.constraint(equalToConstant: 72).isActive = true

        configureProfileFields()
        let birthday = NSStackView(views: [monthField, dayField, yearField])
        birthday.orientation = .horizontal
        birthday.spacing = 8
        monthField.setContentHuggingPriority(.defaultLow, for: .horizontal)
        dayField.widthAnchor.constraint(equalToConstant: 76).isActive = true
        yearField.widthAnchor.constraint(equalToConstant: 76).isActive = true
        characteristicsStack.orientation = .vertical
        characteristicsStack.alignment = .leading
        characteristicsStack.spacing = 6
        let characteristicsRow = field(String(localized: "Characteristics"), characteristicsStack)
        self.characteristicsRow = characteristicsRow
        renderCharacteristics()

        let rows: [NSView] = [
            headingLabel,
            field(fields.name.caption, nameField),
            field(fields.title.caption, titleField),
            field(fields.organization.caption, organizationPicker),
            field(fields.emails.caption, addressesScroll),
            field(String(localized: "Birthday"), birthday),
            field(String(localized: "Language"), languageField),
            field(String(localized: "Signals status"), outreachField),
            characteristicsRow,
        ]
        let form = NSStackView(views: rows)
        form.orientation = .vertical
        form.alignment = .leading
        form.spacing = Metrics.gap
        for row in rows where row !== headingLabel {
            row.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
        }

        cancelButton.target = self
        cancelButton.action = #selector(cancel)
        SettingsChrome.applySecondaryButton(cancelButton, height: Metrics.buttonHeight)
        cancelButton.keyEquivalent = "\u{1b}"
        saveButton.target = self
        saveButton.action = #selector(save)
        applySaveTitle(String(localized: "Save"))
        saveButton.keyEquivalent = "\r"
        saveButton.isEnabled = !trimmedName.isEmpty

        let spacer = NSView()
        spacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        let footer = NSStackView(views: [spacer, cancelButton, saveButton])
        footer.orientation = .horizontal
        footer.alignment = .centerY
        footer.spacing = 10

        let column = NSStackView(views: [form, SettingsChrome.hairline(), errorLabel, footer])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = Metrics.padding
        root.addSubview(column)
        column.pinToEdges(of: root, insets: NSEdgeInsets(top: Metrics.padding, left: Metrics.padding, bottom: Metrics.padding, right: Metrics.padding))
        for view in column.arrangedSubviews {
            view.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        }
        root.widthAnchor.constraint(equalToConstant: Metrics.width).isActive = true
        view = root
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        view.window?.makeFirstResponder(nameField)
        loadOptions()
    }

    // MARK: Profile fields

    /// Month (None, then the twelve names), day, Signals status and the
    /// language from what the contact carries. The language list grows when
    /// the options land.
    private func configureProfileFields() {
        var months: [(String, String?)] = [(String(localized: "None"), nil)]
        for (index, name) in Self.monthNames.enumerated() { months.append((name, String(index + 1))) }
        WorkFormSheet.configure(monthField, choices: months, selecting: profile.birthdayMonth.map { String($0) })
        var days: [(String, String?)] = [(String(localized: "Day"), nil)]
        for day in 1...31 { days.append((String(day), String(day))) }
        WorkFormSheet.configure(dayField, choices: days, selecting: profile.birthdayDay.map { String($0) })
        yearField.stringValue = profile.birthdayYear.map { String($0) } ?? ""
        var statuses = CrmContactsQuerySignalsOutreachStatus.known.map(\.rawValue)
        if let current = profile.signalsOutreachStatus, !statuses.contains(current) { statuses.append(current) }
        var outreach: [(String, String?)] = [(String(localized: "None"), nil)]
        for status in statuses { outreach.append((ContactFieldText.outreach(status), status)) }
        WorkFormSheet.configure(outreachField, choices: outreach, selecting: profile.signalsOutreachStatus)
        configureLanguages()
    }

    private func configureLanguages() {
        var codes = options?.languages ?? []
        if !codes.contains(profile.preferredLanguage) { codes.insert(profile.preferredLanguage, at: 0) }
        let choices: [(String, String?)] = codes.map { (ContactFieldText.language($0), $0) }
        WorkFormSheet.configure(languageField, choices: choices, selecting: profile.preferredLanguage)
    }

    /// One checkbox per characteristic, two to a line.
    private func renderCharacteristics() {
        characteristicsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        characteristicBoxes = [:]
        let names = ContactProfileDraft.characteristicNames(options: options?.characteristics ?? [], contact: profile.characteristics)
        var index = 0
        while index < names.count {
            let line = NSStackView()
            line.orientation = .horizontal
            line.distribution = .fillEqually
            line.spacing = 12
            for name in names[index..<min(index + 2, names.count)] {
                let box = NSButton(checkboxWithTitle: ContactFieldText.characteristic(name), target: nil, action: nil)
                box.state = profile.characteristics[name] == true ? .on : .off
                box.applyMeetCheckboxStyle()
                characteristicBoxes[name] = box
                line.addArrangedSubview(box)
            }
            characteristicsStack.addArrangedSubview(line)
            line.widthAnchor.constraint(equalTo: characteristicsStack.widthAnchor).isActive = true
            index += 2
        }
        characteristicsRow?.isHidden = names.isEmpty
    }

    /// The editor's options, once per sheet. A failed read keeps the lists
    /// the contact carries; the sheet still saves.
    private func loadOptions() {
        guard optionsTask == nil else { return }
        let api = api
        optionsTask = Task { [weak self] in
            let loaded = try? await api.crmContactOptions()
            guard let self, !Task.isCancelled, let loaded else { return }
            profile = currentProfile
            options = loaded
            configureLanguages()
            renderCharacteristics()
            resizeToFit()
        }
    }

    /// The twelve month names in the reader's language.
    private static var monthNames: [String] {
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.calendar = Calendar(identifier: .gregorian)
        return formatter.standaloneMonthSymbols ?? formatter.monthSymbols ?? []
    }

    /// What the profile fields hold now.
    private var currentProfile: ContactProfileDraft {
        var draft = profile
        draft.birthdayMonth = (monthField.popup.selectedItem?.representedObject as? String).flatMap { Int($0) }
        draft.birthdayDay = (dayField.popup.selectedItem?.representedObject as? String).flatMap { Int($0) }
        let year = yearField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        // A year that is not a number reads as 0, so `birthdayProblem` names the range.
        draft.birthdayYear = year.isEmpty ? nil : (Int(year) ?? 0)
        draft.preferredLanguage = (languageField.popup.selectedItem?.representedObject as? String) ?? profile.preferredLanguage
        draft.signalsOutreachStatus = outreachField.popup.selectedItem?.representedObject as? String
        // A name the contact did not carry joins only when it is checked, so
        // an untouched vocabulary sends nothing.
        for (name, box) in characteristicBoxes {
            let on = box.state == .on
            if on || draft.characteristics[name] != nil { draft.characteristics[name] = on }
        }
        return draft
    }

    private func field(_ caption: String, _ control: NSView) -> NSView {
        let group = NSStackView(views: [StarlingsTypography.fieldCaption(caption), control])
        group.orientation = .vertical
        group.alignment = .leading
        group.spacing = 6
        control.widthAnchor.constraint(equalTo: group.widthAnchor).isActive = true
        return group
    }

    private var trimmedName: String { nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// One address per line (or comma), lower case, the primary first.
    private var addresses: [String] { FormFieldRegistry.emails(addressesView.string) }

    private var fields: ContactFormFields { FormFieldRegistry.contact }

    func controlTextDidChange(_ notification: Notification) {
        guard saveTask == nil else { return }
        saveButton.isEnabled = !trimmedName.isEmpty
    }

    @objc private func cancel() { close() }

    @objc private func save() {
        guard saveTask == nil, !trimmedName.isEmpty else { return }
        let title = titleField.stringValue
        let organizationID = organizationPicker.selectedIDs.first
        if let problem = FormFieldRegistry.problem([(fields.name, trimmedName), (fields.title, title)]) {
            errorLabel.showError(problem)
            resizeToFit()
            return
        }
        let profile = currentProfile
        if let problem = profile.birthdayProblem {
            errorLabel.showError(problem)
            resizeToFit()
            return
        }
        let initialProfile = initialProfile
        let fields = self.fields
        errorLabel.clear()
        saveButton.isEnabled = false
        applySaveTitle(String(localized: "Saving…"))
        let api = api
        let existing = contact
        let name = trimmedName
        let emails = addresses
        saveTask = Task { [weak self] in
            do {
                let saved: CrmContactDetail
                if let existing {
                    var update = CrmContactUpdate(
                        name: name,
                        title: fields.title.patch(title, .update),
                        organizationID: fields.organization.patch(organizationID, .update),
                        emails: fields.emails.list(emails, .update)
                    )
                    profile.apply(to: &update, from: initialProfile)
                    saved = try await api.updateCrmContact(id: existing.id, update)
                } else {
                    var create = CrmContactCreate(
                        name: name,
                        title: fields.title.patch(title, .create),
                        organizationID: fields.organization.patch(organizationID, .create),
                        emails: fields.emails.list(emails, .create)
                    )
                    profile.apply(to: &create)
                    saved = try await api.createCrmContact(create)
                }
                guard let self else { return }
                saveTask = nil
                onSaved(saved)
                close()
            } catch {
                guard let self else { return }
                saveTask = nil
                applySaveTitle(String(localized: "Save"))
                saveButton.isEnabled = !trimmedName.isEmpty
                errorLabel.showError((error as? StarlingsError)?.message ?? error.localizedDescription)
                resizeToFit()
            }
        }
    }

    private func applySaveTitle(_ title: String) {
        saveButton.apply(.accent, title: title, font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold), height: Metrics.buttonHeight)
    }

    private func resizeToFit() {
        guard let window = view.window else { return }
        view.layoutSubtreeIfNeeded()
        window.setContentSize(view.fittingSize)
    }

    func run(over parent: NSWindow?) {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: NSSize(width: Metrics.width, height: 100)),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.title = heading
        window.isReleasedWhenClosed = false
        window.contentViewController = self
        guard let parent else {
            window.center()
            NSApp.runModal(for: window)
            window.orderOut(nil)
            return
        }
        parent.beginSheet(window) { _ in window.orderOut(nil) }
    }

    private func close() {
        organizationPicker.cancel()
        saveTask?.cancel()
        optionsTask?.cancel()
        guard let window = view.window else { return }
        if let parent = window.sheetParent {
            parent.endSheet(window)
        } else {
            NSApp.stopModal()
            window.orderOut(nil)
        }
    }
}

/// Merge a duplicate into a contact, as the organization page
/// does: pick the duplicate from a contact search, then the page asks before
/// it merges. The contact the page shows is never offered.
@MainActor
enum ContactMergeSheet {
    static func present(
        over window: NSWindow?,
        api: MeetingControlAPI,
        contact: CrmContactDetail,
        onPick: @escaping (_ duplicate: StarlingsSearchablePickerOption) -> Void
    ) {
        let picker = StarlingsSearchablePickerField(frame: .zero)
        var picked: StarlingsSearchablePickerOption?
        var shown: [StarlingsSearchablePickerOption] = []
        picker.setOptions([], placeholder: String(localized: "Search contacts"), selectedID: nil)
        picker.search = { query in
            let matches = (try? await api.crmContacts(matching: query)) ?? []
            shown = matches
                .filter { $0.id != contact.id }
                .map { StarlingsSearchablePickerOption(id: $0.id, title: $0.displayName, subtitle: $0.context.isEmpty ? $0.email : $0.context) }
            return shown
        }
        let sheet = WorkFormSheet(
            heading: String(localized: "Merge contact"),
            saveTitle: String(localized: "Merge"),
            rows: [.field(caption: String(localized: "Duplicate"), control: picker)],
            firstResponder: picker,
            canSave: { picked != nil },
            onSave: { if let picked { onPick(picked) } }
        )
        picker.onSelection = { [weak sheet] id in
            picked = shown.first { $0.id == id }
            sheet?.refreshSaveAvailability()
        }
        sheet.run(over: window)
    }
}
