import AppKit

/// Create/edit sheet for a Core lead or project. This is intentionally shared
/// by the Mac Work window and the meeting-adjacent entry points so the three
/// native states cannot drift apart.
@MainActor
enum WorkSubjectEditor {
    /// One end of a relation a subject can carry: an organization, a contact.
    /// Same two fields either way, so one picker draws both. Defined beside
    /// the draft in `MeetingCategory.swift`, which the phone compiles too.
    typealias RelationOption = SubjectRelationOption

    typealias OrganizationOption = RelationOption

    typealias OrganizationSearch = @MainActor (String) async throws -> [RelationOption]
    /// Enriches selected organization ids with details the relation picker can
    /// show under their names, through the Worker's subject route.
    typealias OrganizationResolve = @MainActor ([String]) async throws -> [RelationOption]
    /// Contacts, by the same contract. Both search through the Worker; neither
    /// preloads a directory — see `RelationPickerView`.
    typealias ContactSearch = @MainActor (String) async throws -> [RelationOption]
    /// Ids to names. A project's `contact_ids` arrive bare from Core, so the
    /// sheet opens drawing them as ids and replaces them the moment this
    /// answers — rather than holding the sheet shut on a network call, or
    /// dropping the ones it cannot name and unlinking them on save.
    typealias ContactResolve = @MainActor ([String]) async throws -> [RelationOption]

    struct Draft {
        let kind: MeetingCategoryKind.SubjectKind
        var title: String
        var status: String
        var startDate: Date?
        var endDate: Date?
        var description: String
        var url: String
        var notes: String
        var organizationID: String?
        /// A lead's single contact. Nil on a project, which uses `contactIDs`.
        var contactID: String?
        /// A project's contacts. Empty on a lead.
        var contactIDs: [String]
        /// A lead's characteristics as the sheet read them with the five
        /// qualification checks as the person left them. Nil on a project.
        var characteristics: [String: Bool]? = nil
    }

    /// What a *new* subject's sheet opens with when something else already
    /// knows part of the answer — "Start a lead" from the Sales inbox.
    struct Prefill {
        var title: String
        var notes: String
        var organizationID: String? = nil
        var organizationName: String? = nil
        var contactID: String? = nil
        var contactName: String? = nil
    }

    /// A project's GitHub repositories, and the way to link one more. The
    /// link lands on its own call, apart from Save: it is a row in the link
    /// table, not a field on the subject.
    struct RepositoryLink {
        var linked: [String]
        /// Shows the picker over the editor's window. The closure gets the
        /// new repository's address once the link lands.
        let link: (NSWindow, @escaping (String) -> Void) -> Void
    }

    /// Why a save did not land. A plan limit is a notice, not a
    /// fault; `offersUpgrade` puts the Upgrade button beside it for an admin.
    struct SaveFailure {
        let message: String
        var isPlanLimit = false
        var offersUpgrade = false
    }

    static func present(
        over window: NSWindow?,
        title: String,
        kind: MeetingCategoryKind.SubjectKind,
        detail: CrmSubjectDetail?,
        prefill: Prefill? = nil,
        organizationSearch: OrganizationSearch? = nil,
        organizationCreate: RelationPickerView.Create? = nil,
        resolveOrganizations: OrganizationResolve? = nil,
        contactSearch: ContactSearch? = nil,
        resolveContacts: ContactResolve? = nil,
        repository: RepositoryLink? = nil,
        // `onSave` owns the network call and reports back via `completion`:
        // `nil` closes the sheet, a failure keeps it open with the draft
        // intact so a failed save (a Core hiccup, most often) can be retried
        // without retyping anything.
        onSave: @escaping (Draft, @escaping (SaveFailure?) -> Void) -> Void
    ) {
        SubjectSheetController(
            heading: title,
            kind: kind,
            detail: detail,
            prefill: prefill,
            organizationSearch: organizationSearch,
            organizationCreate: organizationCreate,
            resolveOrganizations: resolveOrganizations,
            contactSearch: contactSearch,
            resolveContacts: resolveContacts,
            repository: repository,
            onSave: onSave
        ).run(over: window)
    }
}

@MainActor
private final class SubjectSheetController: NSViewController, NSTextFieldDelegate {
    private enum Metrics {
        static let width: CGFloat = 500
        static let padding: CGFloat = 20
        static let gap: CGFloat = 14
        static let captionGap: CGFloat = 6
        static let buttonHeight: CGFloat = 32
    }

    private let heading: String
    /// This kind's captions and rules, from `FormFieldRegistry`.
    private var fields: SubjectFormFields { SubjectFormFields(kind) }
    private let kind: MeetingCategoryKind.SubjectKind
    private let detail: CrmSubjectDetail?
    private let prefill: WorkSubjectEditor.Prefill?
    private let organizationSearch: WorkSubjectEditor.OrganizationSearch?
    private let organizationCreate: RelationPickerView.Create?
    private let resolveOrganizations: WorkSubjectEditor.OrganizationResolve?
    private let contactSearch: WorkSubjectEditor.ContactSearch?
    private let resolveContacts: WorkSubjectEditor.ContactResolve?
    private var organizationResolveTask: Task<Void, Never>?
    private var resolveTask: Task<Void, Never>?
    private var repository: WorkSubjectEditor.RepositoryLink?
    private var lastOrganizationIDs: [String] = []
    private var lastContactIDs: [String] = []
    private let repositoryLabel = NSTextField(labelWithString: "")
    private let repositoryButton = NSButton(title: String(localized: "Link…"), target: nil, action: nil)
    private let onSave: (WorkSubjectEditor.Draft, @escaping (WorkSubjectEditor.SaveFailure?) -> Void) -> Void

    private let titleField = StarlingsTextField(placeholder: String(localized: "Name"))
    private let statusField = StarlingsPopUpField(frame: .zero)
    private let organizationPicker: RelationPickerView
    private let contactPicker: RelationPickerView
    private let urlField = StarlingsTextField(placeholder: "https://…")
    private let startPicker = StarlingsDatePickerField(frame: .zero)
    private let endPicker = StarlingsDatePickerField(frame: .zero)
    private let startToggle = StarlingsLabeledToggle()
    private let endToggle = StarlingsLabeledToggle()
    private let notesView = NSTextView()
    private let descriptionView = NSTextView()
    private let qualificationSummary = NSTextField(labelWithString: "")
    /// One checkbox per qualification check, in Core's order.
    private var qualificationBoxes: [String: StarlingsLabeledToggle] = [:]
    /// The characteristics the lead came with; the five checks change in it, the rest stay.
    private var baseCharacteristics: [String: Bool] = [:]
    private let saveButton = StarlingsFilledButton(frame: .zero)
    private let cancelButton = NSButton(title: String(localized: "Cancel"), target: nil, action: nil)
    private let errorLabel = StarlingsNoticeView(wrapping: true)
    /// Footer left, only after an admin's save hit a plan limit.
    private let upgradeButton = NSButton(title: WorkspacePlanRules.upgradeText, target: nil, action: nil)
    private var isSaving = false

    init(
        heading: String,
        kind: MeetingCategoryKind.SubjectKind,
        detail: CrmSubjectDetail?,
        prefill: WorkSubjectEditor.Prefill? = nil,
        organizationSearch: WorkSubjectEditor.OrganizationSearch? = nil,
        organizationCreate: RelationPickerView.Create? = nil,
        resolveOrganizations: WorkSubjectEditor.OrganizationResolve? = nil,
        contactSearch: WorkSubjectEditor.ContactSearch? = nil,
        resolveContacts: WorkSubjectEditor.ContactResolve? = nil,
        repository: WorkSubjectEditor.RepositoryLink? = nil,
        onSave: @escaping (WorkSubjectEditor.Draft, @escaping (WorkSubjectEditor.SaveFailure?) -> Void) -> Void
    ) {
        self.heading = heading
        self.repository = repository
        self.kind = kind
        self.detail = detail
        self.prefill = prefill
        self.organizationSearch = organizationSearch
        self.organizationCreate = organizationCreate
        self.resolveOrganizations = resolveOrganizations
        self.contactSearch = contactSearch
        self.resolveContacts = resolveContacts
        self.organizationPicker = RelationPickerView(
            mode: .single,
            placeholder: String(localized: "Search organizations"),
            emptyText: String(localized: "No organizations match"),
            search: organizationSearch,
            create: organizationCreate
        )
        // A lead has one contact, a project has many — Core's own shape, and
        // the reason the picker takes a mode rather than always tokenising.
        self.contactPicker = RelationPickerView(
            mode: kind == .lead ? .single : .multi,
            placeholder: String(localized: "Search contacts"),
            emptyText: String(localized: "No contacts match"),
            search: contactSearch
        )
        self.onSave = onSave
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func loadView() {
        let root = NSView()
        root.wantsLayer = true
        root.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.panel, for: root).cgColor

        let headingLabel = NSTextField(labelWithString: heading)
        headingLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(15), weight: .semibold)
        headingLabel.textColor = StarlingsColors.primaryText

        titleField.stringValue = detail?.title ?? prefill?.title ?? ""
        titleField.delegate = self
        configureChoice(statusField, selecting: detail?.status ?? kind.editorDefaultStatus)

        if kind == .lead || kind == .project {
            let initialOrganization: WorkSubjectEditor.RelationOption? = {
                let id = detail?.organizationID ?? prefill?.organizationID
                guard let id, !id.isEmpty else { return nil }
                let name = prefill?.organizationName ?? detail?.organizationName ?? detail?.subtitle ?? String(localized: "Organization")
                return .init(id: id, name: name)
            }()
            organizationPicker.setSelected(initialOrganization.map { [$0] } ?? [])
            if organizationSearch == nil {
                organizationPicker.setUnavailableHint(String(localized: "Sign in first"))
            }
        }

        contactPicker.setSelected(initialContacts())
        lastOrganizationIDs = organizationPicker.selectedIDs
        lastContactIDs = contactPicker.selectedIDs
        if contactSearch == nil {
            contactPicker.setUnavailableHint(String(localized: "Sign in first"))
        }
        for picker in [organizationPicker, contactPicker] {
            picker.onChange = { [weak self] in
                guard let self else { return }
                clearError()
                resolveChangedSelections()
                resizeToFit()
            }
            picker.onError = { [weak self] message in
                guard let self else { return }
                errorLabel.showError(message)
                resizeToFit()
            }
        }

        startPicker.picker.datePickerElements = [.yearMonthDay]
        startPicker.picker.dateValue = Self.date(from: detail?.startDate) ?? Date()
        // A lead's start date is required (`FormFieldRegistry.lead`): no
        // toggle, the picker alone. A project's is optional.
        let hasStart = kind == .lead || detail?.startDate != nil
        configureToggle(startToggle, title: String(localized: "Has a start date"), state: hasStart, action: #selector(startToggled))
        startToggle.isHidden = kind == .lead
        startPicker.isHidden = !hasStart

        endPicker.picker.datePickerElements = [.yearMonthDay]
        endPicker.picker.dateValue = Self.date(from: detail?.endDate) ?? Date()
        let hasEnd = detail?.endDate != nil
        configureToggle(endToggle, title: String(localized: "Has an end date"), state: hasEnd, action: #selector(endToggled))
        endPicker.isHidden = !hasEnd

        urlField.stringValue = detail?.url ?? ""
        configureTextView(descriptionView, value: detail?.description ?? "")
        configureTextView(notesView, value: detail?.notes ?? prefill?.notes ?? "")

        let statusAndURL = NSStackView(views: [
            field(caption: fields.status.caption, control: statusField),
            kind == .project ? field(caption: FormFieldRegistry.project.url.caption, control: urlField) : NSView(),
        ])
        statusAndURL.orientation = .horizontal
        statusAndURL.alignment = .top
        statusAndURL.distribution = .fillEqually
        statusAndURL.spacing = 12

        let organizationControls: NSView? = kind == .lead || kind == .project ? organizationPicker : nil

        let startRow = NSStackView(views: [startToggle, startPicker, NSView()])
        startRow.orientation = .horizontal
        startRow.alignment = .centerY
        startRow.spacing = 12
        startPicker.widthAnchor.constraint(equalToConstant: 150).isActive = true
        startToggle.setContentHuggingPriority(.required, for: .horizontal)

        // A project's end date sits under its start date, in Dates, not
        // after Contacts.
        let dates: NSView
        if kind == .project {
            let endRow = NSStackView(views: [endToggle, endPicker, NSView()])
            endRow.orientation = .horizontal
            endRow.alignment = .centerY
            endRow.spacing = 12
            endPicker.widthAnchor.constraint(equalToConstant: 150).isActive = true
            endToggle.setContentHuggingPriority(.required, for: .horizontal)
            let stack = NSStackView(views: [startRow, endRow])
            stack.orientation = .vertical
            stack.alignment = .leading
            stack.spacing = 8
            dates = stack
        } else {
            dates = startRow
        }

        var rows: [NSView] = [
            headingLabel,
            field(caption: fields.title.caption, control: titleField),
            statusAndURL,
            field(caption: kind == .lead ? fields.startDate.caption : String(localized: "Dates"), control: dates),
        ]
        if let organizationControls, kind == .lead {
            rows.insert(field(caption: fields.organization.caption, control: organizationControls), at: 3)
        } else if let organizationControls {
            rows.append(field(caption: fields.organization.caption, control: organizationControls))
        }
        // Right under the relation it sits beside on a lead, and directly
        // after the dates on a project, where the old sheet simply had
        // nothing to say about who is involved.
        //
        // Leads and projects only. A partner is an organization in Core and
        // an event is a CMS row; neither has a subject PATCH route at all
        // (`services/control-plane/src/index.ts` keeps the two-kind match on
        // purpose), so a picker on those would offer a write that cannot
        // land. A partner's contacts are the organization's, and an event's
        // are `event_registrations` — both edited in Core.
        // A workspace without Core has no contact directory to search, and
        // its members never connect Core: no picker, never "Connect Core"
        //.
        if (kind == .lead || kind == .project), contactSearch != nil || StarlingsWorkspace.active.has(.core) {
            rows.append(field(caption: fields.contact.caption, control: contactPicker))
        }
        if kind == .lead {
            rows.append(field(caption: FormFieldRegistry.lead.characteristics.caption, control: qualificationControls()))
        }
        if kind == .project {
            if repository != nil {
                rows.append(field(caption: String(localized: "Repository"), control: repositoryRow()))
            }
            rows.append(field(caption: fields.text.caption, control: textScroll(descriptionView)))
        } else {
            rows.append(field(caption: fields.text.caption, control: textScroll(notesView)))
        }

        let form = NSStackView(views: rows)
        form.orientation = .vertical
        form.alignment = .leading
        form.spacing = Metrics.gap
        form.setCustomSpacing(Metrics.padding, after: headingLabel)
        for row in rows where row !== headingLabel {
            row.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
        }

        cancelButton.title = String(localized: "Cancel")
        cancelButton.target = self
        cancelButton.action = #selector(cancel)
        SettingsChrome.applySecondaryButton(cancelButton, height: Metrics.buttonHeight)
        cancelButton.keyEquivalent = "\u{1b}"

        saveButton.target = self
        saveButton.action = #selector(save)
        applySaveTitle(String(localized: "Save"))
        saveButton.keyEquivalent = "\r"
        saveButton.isEnabled = !trimmed(titleField).isEmpty

        errorLabel.label.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        errorLabel.label.maximumNumberOfLines = 3

        upgradeButton.target = self
        upgradeButton.action = #selector(openUpgrade)
        SettingsChrome.applySecondaryButton(upgradeButton, height: Metrics.buttonHeight)
        upgradeButton.isHidden = true

        let spacer = NSView()
        spacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        let footer = NSStackView(views: [upgradeButton, spacer, cancelButton, saveButton])
        footer.orientation = .horizontal
        footer.alignment = .centerY
        footer.spacing = 10

        let divider = SettingsChrome.hairline()
        let column = NSStackView(views: [form, divider, errorLabel, footer])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = Metrics.padding
        errorLabel.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        root.addSubview(column)
        column.pinToEdges(of: root, insets: NSEdgeInsets(
            top: Metrics.padding,
            left: Metrics.padding,
            bottom: Metrics.padding,
            right: Metrics.padding
        ))
        NSLayoutConstraint.activate([
            root.widthAnchor.constraint(equalToConstant: Metrics.width),
            form.widthAnchor.constraint(equalTo: column.widthAnchor),
            divider.widthAnchor.constraint(equalTo: column.widthAnchor),
            footer.widthAnchor.constraint(equalTo: column.widthAnchor),
        ])
        view = root
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        view.window?.makeFirstResponder(titleField)
        resolveInitialOrganizations()
        resolveInitialContacts()
    }

    private func field(caption: String, control: NSView) -> NSView {
        let group = NSStackView(views: [StarlingsTypography.fieldCaption(caption), control])
        group.orientation = .vertical
        group.alignment = .leading
        group.spacing = Metrics.captionGap
        control.widthAnchor.constraint(equalTo: group.widthAnchor).isActive = true
        return group
    }

    /// Core's five checks, one checkbox each, with a live "3/5 qualified".
    private func qualificationControls() -> NSView {
        baseCharacteristics = detail?.characteristics ?? [:]
        let column = NSStackView()
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 6
        for check in LeadQualification.checks {
            let box = StarlingsLabeledToggle()
            configureToggle(
                box,
                title: check.title,
                state: LeadQualification.isSet(check.key, in: baseCharacteristics),
                action: #selector(qualificationToggled)
            )
            box.identifier = NSUserInterfaceItemIdentifier(check.key)
            qualificationBoxes[check.key] = box
            column.addArrangedSubview(box)
        }
        qualificationSummary.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        qualificationSummary.textColor = StarlingsColors.secondaryText
        column.addArrangedSubview(qualificationSummary)
        renderQualificationSummary()
        return column
    }

    @objc private func qualificationToggled() {
        renderQualificationSummary()
    }

    private var qualificationDraft: [String: Bool] {
        var record = baseCharacteristics
        for (key, box) in qualificationBoxes {
            record = LeadQualification.merged(record, key: key, value: box.isOn)
        }
        return record
    }

    private func renderQualificationSummary() {
        qualificationSummary.stringValue = LeadQualification.summary(qualificationDraft)
    }

    private func repositoryRow() -> NSView {
        repositoryLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        repositoryLabel.lineBreakMode = .byTruncatingTail
        repositoryLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        renderRepository()
        repositoryButton.target = self
        repositoryButton.action = #selector(linkRepository)
        SettingsChrome.applySecondaryButton(repositoryButton, title: String(localized: "Link…"), height: 28)
        repositoryButton.setContentHuggingPriority(.required, for: .horizontal)
        let row = NSStackView(views: [repositoryLabel, NSView(), repositoryButton])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 12
        return row
    }

    private func renderRepository() {
        let linked = repository?.linked ?? []
        repositoryLabel.stringValue = linked.isEmpty ? String(localized: "None") : linked.joined(separator: ", ")
        repositoryLabel.textColor = linked.isEmpty ? StarlingsColors.secondaryText : StarlingsColors.primaryText
    }

    @objc private func linkRepository() {
        guard let repository, let window = view.window else { return }
        clearError()
        repository.link(window) { [weak self] address in
            guard let self else { return }
            if self.repository?.linked.contains(address) == false {
                self.repository?.linked.append(address)
            }
            renderRepository()
        }
    }

    private func textScroll(_ textView: NSTextView) -> NSScrollView {
        WorkSubjectEditor.textScroll(textView)
    }

    private func configureTextView(_ textView: NSTextView, value: String) {
        WorkSubjectEditor.configureTextView(textView, value: value)
    }

    private func configureToggle(_ toggle: StarlingsLabeledToggle, title: String, state: Bool, action: Selector) {
        toggle.title = title
        toggle.isOn = state
        toggle.setAction(action, target: self)
    }

    private func configureChoice(_ field: StarlingsPopUpField, selecting: String) {
        field.popup.removeAllItems()
        for option in kind.editorStatuses {
            field.popup.addItem(withTitle: option.title)
            field.popup.lastItem?.representedObject = option.value
        }
        if let index = field.popup.itemArray.firstIndex(where: {
            ($0.representedObject as? String) == selecting
        }) {
            field.popup.selectItem(at: index)
        } else {
            field.popup.selectItem(at: 0)
        }
    }

    /// The contact ids the subject already carries. A lead has one, a
    /// project has a list.
    private func initialContactIDs() -> [String] {
        if kind == .lead {
            guard let id = detail?.contactID ?? prefill?.contactID, !id.isEmpty else { return [] }
            return [id]
        }
        return (detail?.contactIDs ?? []).filter { !$0.isEmpty }
    }

    /// What the sheet opens with, before names are known. An id draws as
    /// itself rather than being dropped, so the first save cannot quietly
    /// unlink someone the sheet could not label.
    private func initialContacts() -> [WorkSubjectEditor.RelationOption] {
        initialContactIDs().map { .init(id: $0, name: prefill?.contactName ?? $0) }
    }

    /// Replace those placeholders once Core answers. A failure leaves the
    /// ids on screen: ugly, but every one of them still saves.
    private func resolveInitialContacts() {
        let ids = initialContactIDs()
        guard !ids.isEmpty, let resolveContacts else { return }
        resolveTask = Task { @MainActor [weak self] in
            guard let resolved = try? await resolveContacts(ids), !resolved.isEmpty else { return }
            guard let self, !Task.isCancelled else { return }
            let byID = Dictionary(resolved.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            contactPicker.setSelected(contactPicker.selected.map {
                byID[$0.id] ?? $0
            })
            resizeToFit()
        }
    }

    /// Resolve the two ids already on a subject after the sheet appears. The
    /// relation picker can still save its ids if Core does not return details.
    private func resolveInitialOrganizations() {
        let ids = organizationPicker.selectedIDs
        guard !ids.isEmpty, let resolveOrganizations else { return }
        organizationResolveTask = Task { @MainActor [weak self] in
            guard let resolved = try? await resolveOrganizations(ids), !resolved.isEmpty else { return }
            guard let self, !Task.isCancelled else { return }
            let byID = Dictionary(resolved.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            organizationPicker.setSelected(organizationPicker.selected.map {
                byID[$0.id] ?? $0
            })
            resizeToFit()
        }
    }

    /// Search returns names quickly; after an id is chosen, fetch its small
    /// set of display details. Search-result changes do not repeat the reads.
    private func resolveChangedSelections() {
        let organizationIDs = organizationPicker.selectedIDs
        if organizationIDs != lastOrganizationIDs {
            lastOrganizationIDs = organizationIDs
            organizationResolveTask?.cancel()
            if !organizationIDs.isEmpty, let resolveOrganizations {
                organizationResolveTask = Task { @MainActor [weak self] in
                    guard let resolved = try? await resolveOrganizations(organizationIDs), !resolved.isEmpty else { return }
                    guard let self, !Task.isCancelled else { return }
                    let byID = Dictionary(resolved.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
                    organizationPicker.setSelected(organizationPicker.selected.map {
                        byID[$0.id] ?? $0
                    })
                    resizeToFit()
                }
            }
        }

        let contactIDs = contactPicker.selectedIDs
        if contactIDs != lastContactIDs {
            lastContactIDs = contactIDs
            resolveTask?.cancel()
            if !contactIDs.isEmpty, let resolveContacts {
                resolveTask = Task { @MainActor [weak self] in
                    guard let resolved = try? await resolveContacts(contactIDs), !resolved.isEmpty else { return }
                    guard let self, !Task.isCancelled else { return }
                    let byID = Dictionary(resolved.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
                    contactPicker.setSelected(contactPicker.selected.map {
                        byID[$0.id] ?? $0
                    })
                    resizeToFit()
                }
            }
        }
    }

    func controlTextDidChange(_ notification: Notification) {
        guard notification.object as? NSTextField === titleField else { return }
        guard !isSaving else { return }
        saveButton.isEnabled = !trimmed(titleField).isEmpty
    }

    @objc private func startToggled() {
        guard kind == .project else { return }
        startPicker.isHidden = !startToggle.isOn
        resizeToFit()
    }

    @objc private func endToggled() {
        endPicker.isHidden = !endToggle.isOn
        resizeToFit()
    }

    @objc private func cancel() { close() }

    @objc private func save() {
        guard !isSaving else { return }
        let cleanTitle = trimmed(titleField)
        guard !cleanTitle.isEmpty else { return }
        // What the form requires is the registry's: a lead names its
        // organization, a project may have none. An edit keeps a
        // blank the record already had.
        let organizationID = kind == .lead || kind == .project ? organizationPicker.selectedIDs.first : nil
        let lacking: Set<String> = detail != nil && detail?.organizationID == nil ? [fields.organization.id] : []
        if let problem = FormFieldRegistry.problem([
            (fields.title, cleanTitle),
            (fields.organization, organizationID),
            (fields.text, kind == .project ? descriptionView.string : notesView.string),
        ], lacking: lacking) {
            let needsCore = fields.organization.isBlank(organizationID) && organizationSearch == nil && lacking.isEmpty && fields.organization.isRequired
            errorLabel.showError(needsCore
                ? String(localized: "Sign in to choose an organization.")
                : problem)
            resizeToFit()
            return
        }
        let draft = WorkSubjectEditor.Draft(
            kind: kind,
            title: cleanTitle,
            status: statusField.popup.selectedItem?.representedObject as? String ?? kind.editorDefaultStatus,
            startDate: kind == .lead || startToggle.isOn ? startPicker.picker.dateValue : nil,
            endDate: kind == .project && endToggle.isOn ? endPicker.picker.dateValue : nil,
            description: kind == .project ? descriptionView.string.trimmingCharacters(in: .whitespacesAndNewlines) : "",
            url: kind == .project ? trimmed(urlField) : "",
            notes: kind == .lead ? notesView.string.trimmingCharacters(in: .whitespacesAndNewlines) : "",
            organizationID: organizationID,
            contactID: kind == .lead ? contactPicker.selectedIDs.first : nil,
            contactIDs: kind == .project ? contactPicker.selectedIDs : [],
            characteristics: kind == .lead ? qualificationDraft : nil
        )
        // Stay open until the save actually lands — closing first (the old
        // behavior) threw the typed draft away the instant a Core hiccup
        // failed the request, with no way to retry without retyping it.
        isSaving = true
        clearError()
        saveButton.isEnabled = false
        applySaveTitle(String(localized: "Saving…"))
        onSave(draft) { [weak self] failure in
            guard let self else { return }
            isSaving = false
            guard let failure else {
                close()
                return
            }
            applySaveTitle(String(localized: "Save"))
            saveButton.isEnabled = !trimmed(titleField).isEmpty
            if failure.isPlanLimit {
                // A plan limit is a state, not a fault: no Copy, no red.
                errorLabel.setText(failure.message)
            } else {
                errorLabel.showError(failure.message)
            }
            upgradeButton.isHidden = !failure.offersUpgrade
            resizeToFit()
        }
    }

    private func clearError() {
        errorLabel.clear()
        upgradeButton.isHidden = true
    }

    @objc private func openUpgrade() {
        NSWorkspace.shared.open(WorkspacePlanRules.upgradeURL)
    }

    private func applySaveTitle(_ title: String) {
        saveButton.apply(
            .accent,
            title: title,
            font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold),
            height: Metrics.buttonHeight
        )
    }

    private func trimmed(_ field: NSTextField) -> String {
        field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
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
        contactPicker.cancel()
        organizationResolveTask?.cancel()
        resolveTask?.cancel()
        guard let window = view.window else { return }
        if let parent = window.sheetParent {
            parent.endSheet(window)
        } else {
            NSApp.stopModal()
            window.orderOut(nil)
        }
    }

    private static func date(from value: String?) -> Date? {
        guard let value, value.count >= 10 else { return nil }
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: String(value.prefix(10)))
    }
}

private extension MeetingCategoryKind.SubjectKind {
    var editorDefaultStatus: String { SubjectStatusRegistry.choices(for: self)?.defaultStatus ?? "" }

    var editorStatuses: [(value: String, title: String)] {
        CrmSubjectStatusOption.editable(for: self).map { ($0.id, $0.title) }
    }
}

/// The sheets' multiline field: a text view in a bordered scroll, on the
/// field ground. The subject sheet and the interaction sheet draw
/// the same one.
extension WorkSubjectEditor {
    static func textScroll(_ textView: NSTextView) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.borderType = .bezelBorder
        scroll.hasVerticalScroller = true
        scroll.documentView = textView
        textView.minSize = NSSize(width: 0, height: 90)
        textView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        scroll.heightAnchor.constraint(equalToConstant: 92).isActive = true
        return scroll
    }

    static func configureTextView(_ textView: NSTextView, value: String) {
        textView.string = value
        textView.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        textView.textColor = StarlingsColors.primaryText
        textView.backgroundColor = StarlingsColors.field
        textView.drawsBackground = true
        textView.textContainerInset = NSSize(width: 8, height: 7)
        StarlingsTextField.styleFieldEditor(textView, font: .systemFont(ofSize: StarlingsTypography.scaled(13)))
    }
}
