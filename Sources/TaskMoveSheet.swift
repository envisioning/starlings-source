import AppKit

/// Move to…: one task, one new subject. The list the quick note
/// filing sheet offers — every open project and lead, starred first — plus
/// partners (filed on the organization) and events: every kind the registry
/// says holds tasks, in a searchable picker, and one button. Nothing else about the task changes; the
/// caller reloads the list the task left and the one it joined.
@MainActor
enum TaskMoveSheet {
    static func present(
        over window: NSWindow?,
        task: CrmTask,
        api: MeetingControlAPI,
        onMoved: @escaping (CrmTask) -> Void
    ) {
        TaskMoveSheetController(task: task, api: api, onMoved: onMoved).run(over: window)
    }
}

@MainActor
private final class TaskMoveSheetController: NSViewController {
    private enum Metrics {
        static let width: CGFloat = 440
        static let padding: CGFloat = 20
        static let gap: CGFloat = 14
        static let captionGap: CGFloat = 6
        static let buttonHeight: CGFloat = 32
    }

    private let task: CrmTask
    private let api: MeetingControlAPI
    private let onMoved: (CrmTask) -> Void

    private let targetCaption = StarlingsTypography.fieldCaption(String(localized: "Move to"))
    private let targetField = StarlingsSearchablePickerField(frame: .zero)
    private let cancelButton = NSButton(title: String(localized: "Cancel"), target: nil, action: nil)
    private let moveButton = StarlingsFilledButton(frame: .zero)
    private let errorLabel = StarlingsNoticeView(wrapping: true)
    private var subjects: [CrmSubject] = []
    private var selectedSubject: CrmSubject?
    private var load: Task<Void, Never>?
    private var write: Task<Void, Never>?

    init(task: CrmTask, api: MeetingControlAPI, onMoved: @escaping (CrmTask) -> Void) {
        self.task = task
        self.api = api
        self.onMoved = onMoved
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

        let headingLabel = NSTextField(labelWithString: task.title)
        headingLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(15), weight: .semibold)
        headingLabel.textColor = StarlingsColors.primaryText
        headingLabel.lineBreakMode = .byTruncatingTail

        targetField.setOptions([], placeholder: String(localized: "Loading…"), selectedID: nil)
        targetField.onSelection = { [weak self] id in
            guard let self else { return }
            selectedSubject = subjects.first { "\($0.kind):\($0.id)" == id }
            moveButton.isEnabled = selectedSubject != nil
        }
        rebuildTargets(isLoading: true)

        let targetGroup = NSStackView(views: [targetCaption, targetField])
        targetGroup.orientation = .vertical
        targetGroup.alignment = .leading
        targetGroup.spacing = Metrics.captionGap
        targetField.widthAnchor.constraint(equalTo: targetGroup.widthAnchor).isActive = true

        let form = NSStackView(views: [headingLabel, targetGroup])
        form.orientation = .vertical
        form.alignment = .leading
        form.spacing = Metrics.gap
        headingLabel.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
        targetGroup.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true

        cancelButton.target = self
        cancelButton.action = #selector(cancel)
        SettingsChrome.applySecondaryButton(cancelButton, height: Metrics.buttonHeight)
        cancelButton.keyEquivalent = "\u{1b}"

        moveButton.target = self
        moveButton.action = #selector(move)
        moveButton.keyEquivalent = "\r"
        moveButton.apply(
            .accent,
            title: String(localized: "Move"),
            font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold),
            height: Metrics.buttonHeight
        )
        moveButton.isEnabled = false

        errorLabel.label.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        errorLabel.label.maximumNumberOfLines = 3

        let spacer = NSView()
        spacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        let footer = NSStackView(views: [spacer, cancelButton, moveButton])
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
        load = Task { [weak self] in
            guard let self else { return }
            do {
                // Every kind that holds tasks, in the registry's order.
                let api = api
                let all = try await withThrowingTaskGroup(of: (Int, [CrmSubject]).self) { group in
                    for (index, kind) in MeetingCategoryKind.SubjectKind.kinds(with: .tasks).enumerated() {
                        group.addTask { (index, try await api.crmSubjects(kind: kind, query: "")) }
                    }
                    var pages: [(Int, [CrmSubject])] = []
                    for try await page in group { pages.append(page) }
                    return pages.sorted { $0.0 < $1.0 }.flatMap(\.1)
                }
                guard !Task.isCancelled else { return }
                // Where it already is stays out of the list: a move to the
                // same place is not a move.
                let current = CrmTaskSubjectRef(task: task)?.id
                subjects = all.filter { $0.id != current }
                rebuildTargets(isLoading: false)
            } catch {
                guard !Task.isCancelled else { return }
                errorLabel.showError(error)
                resizeToFit()
            }
        }
    }

    private static func kindLabel(_ subject: CrmSubject) -> String {
        subject.subjectKind.label
    }

    private func rebuildTargets(isLoading: Bool) {
        let options = subjects.map { subject in
            StarlingsSearchablePickerOption(
                id: "\(subject.kind):\(subject.id)",
                title: subject.title,
                context: Self.kindLabel(subject),
                subtitle: subject.subtitle
            )
        }
        targetField.setOptions(
            options,
            placeholder: isLoading ? String(localized: "Loading…") : String(localized: "Choose a project, lead or partner"),
            selectedID: selectedSubject.map { "\($0.kind):\($0.id)" }
        )
        moveButton.isEnabled = false
    }

    @objc private func move() {
        guard let subject = selectedSubject else { return }
        // A partner is filed on its organization, and its id is that.
        let kind: CrmTaskSubjectRef.Kind
        switch subject.subjectKind {
        case .project: kind = .project
        case .lead: kind = .lead
        case .event: kind = .event
        case .organization: kind = .organization
        }
        moveButton.isEnabled = false
        errorLabel.clear()
        write = Task { [weak self] in
            guard let self else { return }
            do {
                let moved = try await api.updateCrmTask(id: task.id, update: .move(task, to: CrmTaskSubjectRef(kind: kind, id: subject.id)))
                guard !Task.isCancelled else { return }
                close()
                onMoved(moved)
            } catch {
                guard !Task.isCancelled else { return }
                moveButton.isEnabled = true
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
        window.title = String(localized: "Move to…")
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
