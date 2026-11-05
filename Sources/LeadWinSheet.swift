import AppKit
import StarlingsContracts

/// Win (ADR 0008 decisions 6-7): one open lead becomes a project. The member
/// can edit the project title and picks which of the lead's open tasks move
/// to the project. The rest stay on the lead. The Worker creates the project,
/// moves the tasks, then closes the lead as won; the caller files the new
/// project and says what did not happen.
@MainActor
enum LeadWinSheet {
    static func present(
        over window: NSWindow?,
        lead: CrmSubject,
        api: MeetingControlAPI,
        onWon: @escaping (CrmLeadWinResponse) -> Void
    ) {
        LeadWinSheetController(lead: lead, api: api, onWon: onWon).run(over: window)
    }
}

@MainActor
private final class LeadWinSheetController: NSViewController {
    private enum Metrics {
        static let width: CGFloat = 440
        static let padding: CGFloat = 20
        static let gap: CGFloat = 14
        static let captionGap: CGFloat = 6
        static let buttonHeight: CGFloat = 32
        static let taskListMaxHeight: CGFloat = 240
    }

    /// The statuses that count as open work on the lead.
    private static let openStatuses: Set<CrmTaskStatus> = [.pending, .inProgress, .review, .blocked]

    private let lead: CrmSubject
    private let api: MeetingControlAPI
    private let onWon: (CrmLeadWinResponse) -> Void

    private let titleCaption = StarlingsTypography.fieldCaption(String(localized: "Project title"))
    private let titleField = StarlingsTextField(placeholder: String(localized: "Project title"))
    private let tasksCaption = StarlingsTypography.fieldCaption(String(localized: "Move to the project"))
    private let tasksStack = NSStackView()
    private let tasksScroll = NSScrollView()
    private let tasksGroup = NSStackView()
    private let cancelButton = NSButton(title: String(localized: "Cancel"), target: nil, action: nil)
    private let winButton = StarlingsFilledButton(frame: .zero)
    private let errorLabel = StarlingsNoticeView(wrapping: true)
    private var tasks: [CrmTask] = []
    private var boxes: [NSButton] = []
    private var load: Task<Void, Never>?
    private var write: Task<Void, Never>?

    init(lead: CrmSubject, api: MeetingControlAPI, onWon: @escaping (CrmLeadWinResponse) -> Void) {
        self.lead = lead
        self.api = api
        self.onWon = onWon
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

        let headingLabel = NSTextField(labelWithString: lead.displayTitle)
        headingLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(15), weight: .semibold)
        headingLabel.textColor = StarlingsColors.primaryText
        headingLabel.lineBreakMode = .byTruncatingTail

        titleField.stringValue = lead.title
        let titleGroup = NSStackView(views: [titleCaption, titleField])
        titleGroup.orientation = .vertical
        titleGroup.alignment = .leading
        titleGroup.spacing = Metrics.captionGap
        titleField.widthAnchor.constraint(equalTo: titleGroup.widthAnchor).isActive = true

        tasksStack.orientation = .vertical
        tasksStack.alignment = .leading
        tasksStack.spacing = 6
        tasksStack.translatesAutoresizingMaskIntoConstraints = false
        let document = SidebarDocumentView()
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(tasksStack)
        tasksScroll.hasVerticalScroller = true
        tasksScroll.autohidesScrollers = true
        tasksScroll.drawsBackground = false
        tasksScroll.borderType = .noBorder
        tasksScroll.documentView = document
        let fitsContent = tasksScroll.heightAnchor.constraint(equalTo: document.heightAnchor)
        fitsContent.priority = .defaultHigh
        NSLayoutConstraint.activate([
            tasksStack.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            tasksStack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            tasksStack.topAnchor.constraint(equalTo: document.topAnchor),
            tasksStack.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            document.widthAnchor.constraint(equalTo: tasksScroll.widthAnchor),
            tasksScroll.heightAnchor.constraint(lessThanOrEqualToConstant: Metrics.taskListMaxHeight),
            fitsContent,
        ])

        tasksGroup.addArrangedSubview(tasksCaption)
        tasksGroup.addArrangedSubview(tasksScroll)
        tasksGroup.orientation = .vertical
        tasksGroup.alignment = .leading
        tasksGroup.spacing = Metrics.captionGap
        tasksScroll.widthAnchor.constraint(equalTo: tasksGroup.widthAnchor).isActive = true
        // No task section until the lead's open tasks arrive, and none when
        // it has none.
        tasksGroup.isHidden = true

        let form = NSStackView(views: [headingLabel, titleGroup, tasksGroup])
        form.orientation = .vertical
        form.alignment = .leading
        form.spacing = Metrics.gap
        headingLabel.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
        titleGroup.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
        tasksGroup.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true

        cancelButton.target = self
        cancelButton.action = #selector(cancel)
        SettingsChrome.applySecondaryButton(cancelButton, height: Metrics.buttonHeight)
        cancelButton.keyEquivalent = "\u{1b}"

        winButton.target = self
        winButton.action = #selector(win)
        winButton.keyEquivalent = "\r"
        winButton.apply(
            .accent,
            title: String(localized: "Win"),
            font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold),
            height: Metrics.buttonHeight
        )
        // Win waits for the task list, so a fast click never wins with
        // nothing checked by accident.
        winButton.isEnabled = false

        errorLabel.label.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        errorLabel.label.maximumNumberOfLines = 3

        let spacer = NSView()
        spacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        let footer = NSStackView(views: [spacer, cancelButton, winButton])
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
        load = Task { [weak self] in
            guard let self else { return }
            do {
                let all = try await api.crmTasks(projectID: nil, leadID: lead.id)
                guard !Task.isCancelled else { return }
                tasks = all.filter { Self.openStatuses.contains($0.status) }
                rebuildTasks()
            } catch {
                guard !Task.isCancelled else { return }
                // The tasks stay on the lead; Win still works without them.
                errorLabel.showError(error)
            }
            winButton.isEnabled = true
            resizeToFit()
        }
    }

    private func rebuildTasks() {
        boxes.forEach { $0.removeFromSuperview() }
        boxes = tasks.map { task in
            let box = NSButton(checkboxWithTitle: task.title, target: nil, action: nil)
            box.applyMeetCheckboxStyle()
            box.state = .on
            box.lineBreakMode = .byTruncatingTail
            return box
        }
        boxes.forEach { tasksStack.addArrangedSubview($0) }
        tasksGroup.isHidden = boxes.isEmpty
    }

    @objc private func win() {
        let title = titleField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else {
            errorLabel.showError(String(localized: "Add a name first."))
            resizeToFit()
            return
        }
        let taskIDs = zip(tasks, boxes).filter { $0.1.state == .on }.map(\.0.id)
        // An unchanged title is left for the Worker to copy from the lead.
        let body = CrmLeadWin(title: title == lead.title ? .omit : .value(title), taskIDs: taskIDs)
        winButton.isEnabled = false
        errorLabel.clear()
        write = Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await api.winLead(id: lead.id, body: body)
                guard !Task.isCancelled else { return }
                close()
                onWon(response)
            } catch {
                guard !Task.isCancelled else { return }
                winButton.isEnabled = true
                errorLabel.showError(error)
                resizeToFit()
            }
        }
    }

    @objc private func cancel() {
        load?.cancel()
        write?.cancel()
        close()
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
        window.title = String(localized: "Win lead")
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
        guard let window = view.window else { return }
        if let parent = window.sheetParent {
            parent.endSheet(window)
        } else {
            NSApp.stopModal()
            window.orderOut(nil)
        }
    }
}
