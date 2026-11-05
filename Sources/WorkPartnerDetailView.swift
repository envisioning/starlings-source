import AppKit

/// A partner's own page in Work's detail column (PARTNERS (HQ Docs)).
///
/// A partner *is* a CRM organization. Edit and Delete act on it over the
/// Worker's organization route; it has no tasks or issues. What it shows is
/// what the relationship is — description, website, industry — and what hangs
/// off it: the projects and leads as rows that open their subject, and the
/// contacts as names. Built on `WorkListRowView` like every other list in the
/// detail pane, so the rows hover, select and read to VoiceOver the same way.
@MainActor
final class WorkPartnerDetailView: NSView {
    /// A related project or lead was chosen; the window opens it.
    var onOpenSubject: ((CrmSubject) -> Void)?
    /// A contact was chosen; the window opens their page.
    var onOpenContact: ((_ id: String, _ name: String) -> Void)?
    /// Add contact on this organization; the window opens the sheet.
    var onAddContact: ((CrmSubject) -> Void)?
    /// Edit organization; the window opens the sheet.
    var onEdit: ((CrmSubject, CrmSubjectDetail) -> Void)?
    /// Merge a duplicate into it; the window opens the sheet.
    var onMerge: ((CrmSubject) -> Void)?
    /// Delete; the window asks first.
    var onDelete: ((CrmSubject) -> Void)?

    private let scroll = NSScrollView()
    private let column = NSStackView()
    private let statusLabel = StarlingsNoticeView(wrapping: true)

    init() {
        super.init(frame: .zero)
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 10
        column.edgeInsets = NSEdgeInsets(top: 14, left: 20, bottom: 20, right: 20)
        column.translatesAutoresizingMaskIntoConstraints = false

        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.borderType = .noBorder
        let clip = WorkFlippedClipView()
        clip.drawsBackground = false
        scroll.contentView = clip
        scroll.documentView = column
        scroll.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            column.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Paint the summary at once and the detail when it lands; `detail` nil
    /// means Core has not answered yet. An event subject draws its own page
    /// (docs/EVENTS.md) through the same column.
    func show(_ subject: CrmSubject, detail: CrmSubjectDetail?) {
        column.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if subject.isEvent {
            showEvent(subject, detail: detail)
            return
        }

        if let subtitle = subject.subtitle, !subtitle.isEmpty {
            add(quiet(subtitle))
        }
        guard let detail else {
            StarlingsPlaceholderRowView.rows(glyph: false).forEach(add)
            return
        }
        shownSubject = subject
        shownDetail = detail
        add(actionsRow())

        var about: [String] = []
        if let industry = detail.industry, !industry.isEmpty { about.append(industry) }
        if let url = detail.url, !url.isEmpty { about.append(url) }
        if !about.isEmpty {
            add(sectionLabel("ABOUT"))
            for line in about {
                if line == detail.url, let url = URL(string: line) {
                    add(link(line, url: url))
                } else {
                    add(body(line))
                }
            }
        }
        if let description = detail.description?.trimmingCharacters(in: .whitespacesAndNewlines), !description.isEmpty {
            add(body(description))
        }

        let related = detail.related
        addRelated(
            title: String(localized: "PROJECTS"),
            rows: related?.projects ?? [],
            kind: .project,
            empty: "No projects with this partner yet."
        )
        addRelated(
            title: String(localized: "LEADS"),
            rows: related?.leads ?? [],
            kind: .lead,
            empty: "No open leads with this partner."
        )

        // Its people: each opens their page; + adds one here. A
        // block that folds, like every list header in Work.
        let contacts = related?.contacts ?? []
        let addButton = NSButton(
            image: NSImage(systemSymbolName: "plus", accessibilityDescription: String(localized: "Add contact")) ?? NSImage(),
            target: self,
            action: #selector(addContactPressed)
        )
        addButton.bezelStyle = .inline
        addButton.isBordered = false
        addButton.contentTintColor = StarlingsColors.secondaryText
        addButton.toolTip = String(localized: "Add contact")
        SettingsChrome.applyQuietButton(addButton)
        shownSubject = subject
        let section = SidebarSection(title: String(localized: "CONTACTS"), key: "work.organization.contacts", accessory: addButton)
        if contacts.isEmpty {
            section.setRows([quiet(String(localized: "No contacts yet."))], count: 0)
        } else {
            section.setRows(contacts.map { contact in
                let name = contact.name?.trimmingCharacters(in: .whitespaces).nonEmpty ?? contact.email ?? String(localized: "Unnamed")
                let meta = [contact.title, contact.email].compactMap { $0?.nonEmpty }.joined(separator: " · ")
                return WorkListRowView(
                    content: twoLine(name, meta),
                    isSelected: false,
                    accessibilityLabel: String(localized: "\(name). Opens the contact."),
                    onActivate: { [weak self] in self?.onOpenContact?(contact.id, name) }
                )
            }, count: contacts.count)
        }
        section.translatesAutoresizingMaskIntoConstraints = false
        column.addArrangedSubview(section)
        section.widthAnchor.constraint(equalTo: column.widthAnchor, constant: -40).isActive = true
    }

    /// The organization this page shows, for Add contact, Edit and Delete.
    private var shownSubject: CrmSubject?
    private var shownDetail: CrmSubjectDetail?

    @objc private func addContactPressed() {
        guard let shownSubject else { return }
        onAddContact?(shownSubject)
    }

    @objc private func editPressed() {
        guard let shownSubject, let shownDetail else { return }
        onEdit?(shownSubject, shownDetail)
    }

    @objc private func mergePressed() {
        guard let shownSubject else { return }
        onMerge?(shownSubject)
    }

    @objc private func deletePressed() {
        guard let shownSubject else { return }
        onDelete?(shownSubject)
    }

    /// Edit organization, Merge and Delete, above the page.
    private func actionsRow() -> NSView {
        let edit = NSButton(title: String(localized: "Edit organization"), target: self, action: #selector(editPressed))
        SettingsChrome.applySecondaryButton(edit, symbolName: "pencil", height: 28)
        let merge = NSButton(title: String(localized: "Merge…"), target: self, action: #selector(mergePressed))
        SettingsChrome.applySecondaryButton(merge, symbolName: "arrow.triangle.merge", height: 28)
        let delete = NSButton(title: String(localized: "Delete"), target: self, action: #selector(deletePressed))
        SettingsChrome.applySecondaryButton(delete, symbolName: "trash", height: 28)
        SettingsChrome.setSecondaryButtonTitle(delete, String(localized: "Delete"), color: StarlingsColors.danger)
        let row = NSStackView(views: [edit, merge, delete])
        row.orientation = .horizontal
        row.spacing = 8
        return row
    }

    /// An event's page: phase, date and place on one line, who hosts it and
    /// where to sign up, then the projects that link to it. Read-only: the
    /// row is edited under Website in Core.
    private func showEvent(_ subject: CrmSubject, detail: CrmSubjectDetail?) {
        let phase = WorkItems.eventPhase(eventDate: detail?.eventDate ?? subject.eventDate, now: Date(), calendar: .current)
        let when: String = {
            guard let raw = detail?.eventDate ?? subject.eventDate else { return String(localized: "No date yet") }
            var parser = DateFormatter()
            parser.calendar = Calendar(identifier: .gregorian)
            parser.dateFormat = "yyyy-MM-dd"
            guard let date = parser.date(from: raw) else { return raw }
            parser = DateFormatter()
            parser.dateStyle = .full
            parser.timeStyle = .none
            return parser.string(from: date)
        }()
        let where_ = [detail?.place, detail?.location].compactMap { $0?.trimmingCharacters(in: .whitespaces).nonEmpty }.joined(separator: ", ")
        add(quiet([phase.label, when, where_].filter { !$0.isEmpty }.joined(separator: " · ")))
        guard let detail else {
            StarlingsPlaceholderRowView.rows(glyph: false).forEach(add)
            return
        }

        var about: [NSView] = []
        if let raw = detail.imageURL?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty,
           let url = URL(string: raw) {
            about.append(WorkEventImageView(url: url, accessibilityLabel: subject.displayTitle))
        }
        if let host = detail.host?.nonEmpty { about.append(body(String(localized: "Hosted by \(host)"))) }
        if let partner = detail.partner?.nonEmpty {
            if let raw = detail.partnerURL, let url = URL(string: raw) { about.append(link(partner, url: url)) }
            else { about.append(body(partner)) }
        }
        if let raw = detail.url?.nonEmpty, let url = URL(string: raw) { about.append(link(raw, url: url)) }
        if let description = detail.description?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty {
            about.append(body(description))
        }
        if detail.published == false { about.append(quiet(String(localized: "Not on the website yet."))) }
        if !about.isEmpty {
            add(sectionLabel("ABOUT"))
            for view in about { add(view) }
        }

        // The event is the project in practice; a linked delivery project
        // is the exception, so the section exists only when there is one.
        let projects = detail.related?.projects ?? []
        if !projects.isEmpty {
            addRelated(title: String(localized: "PROJECTS"), rows: projects, kind: .project, empty: "")
        }
    }

    func showError(_ message: String) {
        column.arrangedSubviews.filter { $0 is StarlingsPlaceholderRowView }.forEach { $0.removeFromSuperview() }
        statusLabel.showError(message)
        if statusLabel.superview == nil { add(statusLabel) }
    }

    func clear() {
        column.arrangedSubviews.forEach { $0.removeFromSuperview() }
        shownSubject = nil
        shownDetail = nil
    }

    // MARK: - Pieces

    private func addRelated(title: String, rows: [CrmSubjectRelated.Row], kind: MeetingCategoryKind.SubjectKind, empty: String) {
        add(sectionLabel(title))
        guard !rows.isEmpty else {
            add(quiet(empty))
            return
        }
        for row in rows {
            let subject = CrmSubject(
                id: row.id,
                kind: kind.rawValue,
                title: row.title?.nonEmpty ?? String(localized: "Untitled"),
                subtitle: row.status
            )
            let content = twoLine(subject.displayTitle, row.status ?? "")
            let view = WorkListRowView(
                content: content,
                isSelected: false,
                accessibilityLabel: "\(subject.displayTitle). Opens the \(kind == .lead ? "lead" : "project").",
                onActivate: { [weak self] in self?.onOpenSubject?(subject) }
            )
            view.translatesAutoresizingMaskIntoConstraints = false
            column.addArrangedSubview(view)
            view.widthAnchor.constraint(equalTo: column.widthAnchor, constant: -40).isActive = true
        }
    }

    private func add(_ view: NSView) {
        view.translatesAutoresizingMaskIntoConstraints = false
        column.addArrangedSubview(view)
        view.widthAnchor.constraint(lessThanOrEqualTo: column.widthAnchor, constant: -40).isActive = true
    }

    private func sectionLabel(_ text: String) -> NSView {
        let label = NSTextField(labelWithString: text)
        StarlingsTypography.applySectionLabel(label)
        // A beat of air above every block but the first.
        let wrapper = NSStackView(views: [label])
        wrapper.orientation = .vertical
        wrapper.edgeInsets = NSEdgeInsets(top: column.arrangedSubviews.isEmpty ? 0 : 10, left: 0, bottom: 0, right: 0)
        return wrapper
    }

    private func body(_ text: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        label.textColor = StarlingsColors.primaryText
        label.isSelectable = true
        return label
    }

    private func quiet(_ text: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        label.textColor = StarlingsColors.secondaryText
        return label
    }

    private func link(_ text: String, url: URL) -> NSView {
        let button = NSButton(title: text, target: nil, action: nil)
        button.bezelStyle = .inline
        button.isBordered = false
        button.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        button.contentTintColor = StarlingsColors.accentMark
        button.setAccessibilityLabel(String(localized: "Open website \(text)"))
        button.target = self
        button.action = #selector(openLink(_:))
        button.identifier = NSUserInterfaceItemIdentifier(url.absoluteString)
        button.alignment = .left
        // A link button, not a link in prose, so it gets the veil.
        button.applyMeetHoverLift(cornerRadius: 5)
        return button
    }

    @objc private func openLink(_ sender: NSButton) {
        guard let raw = sender.identifier?.rawValue, let url = URL(string: raw) else { return }
        NSWorkspace.shared.open(url)
    }

    private func twoLine(_ title: String, _ subtitle: String) -> NSView {
        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = WorkListRowView.titleFont()
        titleLabel.textColor = StarlingsColors.primaryText
        titleLabel.allowSqueezing()
        let stack = NSStackView(views: [titleLabel])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = WorkListRowView.textSpacing
        if !subtitle.isEmpty {
            let subtitleLabel = NSTextField(labelWithString: subtitle)
            subtitleLabel.font = WorkListRowView.detailFont()
            subtitleLabel.textColor = StarlingsColors.secondaryText
            subtitleLabel.allowSqueezing()
            stack.addArrangedSubview(subtitleLabel)
        }
        return stack
    }
}

/// A bounded event image for the About pane. It keeps the source's aspect
/// ratio so posters and wide banners are both visible in full.
@MainActor
private final class WorkEventImageView: NSView {
    private let imageView = NSImageView()
    private var loadTask: Task<Void, Never>?
    private var imageSize: NSSize?

    init(url: URL, accessibilityLabel: String) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.cornerCurve = .continuous
        layer?.masksToBounds = true
        layer?.borderWidth = 1
        layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: self).cgColor
        layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor

        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.imageAlignment = .alignCenter
        imageView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(imageView)
        NSLayoutConstraint.activate([
            imageView.leadingAnchor.constraint(equalTo: leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: trailingAnchor),
            imageView.topAnchor.constraint(equalTo: topAnchor),
            imageView.bottomAnchor.constraint(equalTo: bottomAnchor),
            widthAnchor.constraint(lessThanOrEqualToConstant: 360),
            heightAnchor.constraint(lessThanOrEqualToConstant: 220),
        ])
        setAccessibilityRole(.image)
        setAccessibilityLabel(accessibilityLabel)

        loadTask = Task { [weak self] in
            guard let self else { return }
            guard let (data, response) = try? await URLSession.shared.data(from: url),
                  let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  let image = NSImage(data: data),
                  !Task.isCancelled else { return }
            imageView.image = image
            imageSize = image.size
            invalidateIntrinsicContentSize()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        loadTask?.cancel()
    }

    override var intrinsicContentSize: NSSize {
        guard let imageSize, imageSize.width > 0, imageSize.height > 0 else { return .zero }
        let scale = min(1, 360 / imageSize.width, 220 / imageSize.height)
        return NSSize(width: imageSize.width * scale, height: imageSize.height * scale)
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
