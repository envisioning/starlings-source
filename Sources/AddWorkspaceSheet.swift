import AppKit
import Combine
import SwiftUI

/// Add a workspace on the Mac: the Starlings menu's Add
/// Workspace…. The heading, one address field with the `.<suffix>`
/// suffix inside it, what the lookup found as the person types, one line on
/// what happens next, and one full-width button. The steps and the words
/// are `AddWorkspaceFlow`'s, shared with the iPhone sheet; the sign-in is
/// `GoogleOwnerAuthenticator`'s, into the new workspace's own scope, before
/// the switch relaunches the app.
@MainActor
enum AddWorkspaceSheet {
    /// `signInCurrent`: the door's, where the current workspace is signed
    /// out. Its address then signs in to it.
    static func present(over window: NSWindow?, signInCurrent: (() -> Void)? = nil) {
        let controller = AddWorkspaceSheetController()
        controller.signInCurrent = signInCurrent
        controller.run(over: window)
    }
}

@MainActor
private final class AddWorkspaceSheetController: NSViewController, NSTextFieldDelegate {
    private enum Metrics {
        static let width: CGFloat = 440
        static let padding: CGFloat = 24
        static let gap: CGFloat = 14
        static let buttonHeight: CGFloat = 40
    }

    private let flow: AddWorkspaceFlow
    private let heading = NSTextField(labelWithString: String(localized: "Add a workspace"))
    private let caption = StarlingsTypography.fieldCaption(String(localized: "Workspace address"))
    private let field = StarlingsTextField(frame: .zero)
    private let suffix = NSTextField(labelWithString: AddWorkspaceFlow.suffix)
    private let nextStep = NSTextField(wrappingLabelWithString: AddWorkspaceFlow.nextStep)
    private let continueButton = StarlingsFilledButton(frame: .zero)
    private let cancelButton = NSButton(title: String(localized: "Cancel"), target: nil, action: nil)
    private var lookupHost: NSHostingView<AnyView>!
    private var failureHost: NSHostingView<AnyView>!
    private var observation: AnyCancellable?
    var signInCurrent: (() -> Void)?

    init() {
        let flow = AddWorkspaceFlow(
            signIn: { workspace in
                // The sheet is key while its button is pressed: it anchors the browser sheet.
                guard let window = NSApp.keyWindow ?? NSApp.mainWindow else { throw CancellationError() }
                let authenticator = GoogleOwnerAuthenticator(store: OwnerSessionStore(scope: WorkspaceScope(workspace)))
                _ = try await authenticator.authenticate(workspace, in: window, requireActive: false)
            },
            hasSession: { workspace in
                (try? OwnerSessionStore(scope: WorkspaceScope(workspace)).load()) != nil
            },
            isLocked: { StarlingsSurfaceActivity.isMeetLive }
        )
        self.flow = flow
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

        heading.font = .systemFont(ofSize: StarlingsTypography.scaled(17), weight: .semibold)
        heading.textColor = StarlingsColors.primaryText

        field.placeholderString = "your-team"
        field.delegate = self
        field.target = self
        field.action = #selector(submit)
        suffix.font = StarlingsTextField.fieldFont
        suffix.textColor = StarlingsColors.secondaryText
        suffix.translatesAutoresizingMaskIntoConstraints = false
        field.addSubview(suffix)
        NSLayoutConstraint.activate([
            suffix.trailingAnchor.constraint(equalTo: field.trailingAnchor, constant: -12),
            suffix.centerYAnchor.constraint(equalTo: field.centerYAnchor),
        ])
        field.trailingAccessoryWidth = suffix.intrinsicContentSize.width + 12

        let fieldGroup = NSStackView(views: [caption, field])
        fieldGroup.orientation = .vertical
        fieldGroup.alignment = .leading
        fieldGroup.spacing = 6
        field.widthAnchor.constraint(equalTo: fieldGroup.widthAnchor).isActive = true

        lookupHost = NSHostingView(rootView: meetHosted(AddWorkspaceLookupView(flow: flow)))
        failureHost = NSHostingView(rootView: meetHosted(AddWorkspaceFailureView(flow: flow)))
        for host in [lookupHost!, failureHost!] {
            host.sizingOptions = [.intrinsicContentSize]
            host.setContentHuggingPriority(.required, for: .vertical)
        }

        nextStep.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        nextStep.textColor = StarlingsColors.secondaryText

        continueButton.target = self
        continueButton.action = #selector(submit)
        continueButton.keyEquivalent = "\r"
        continueButton.apply(.accent, title: flow.buttonTitle, height: Metrics.buttonHeight)

        cancelButton.target = self
        cancelButton.action = #selector(cancel)
        cancelButton.keyEquivalent = "\u{1b}"
        SettingsChrome.applyQuietButton(cancelButton)

        let column = NSStackView(views: [heading, fieldGroup, lookupHost, nextStep, continueButton, failureHost, cancelButton])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = Metrics.gap
        column.setCustomSpacing(20, after: heading)
        root.addSubview(column)
        column.pinToEdges(of: root, insets: NSEdgeInsets(
            top: Metrics.padding, left: Metrics.padding, bottom: Metrics.padding, right: Metrics.padding
        ))
        var constraints = [root.widthAnchor.constraint(equalToConstant: Metrics.width)]
        for view in [heading, fieldGroup, lookupHost!, nextStep, continueButton, failureHost!] as [NSView] {
            constraints.append(view.widthAnchor.constraint(equalTo: column.widthAnchor))
        }
        constraints.append(cancelButton.centerXAnchor.constraint(equalTo: column.centerXAnchor))
        NSLayoutConstraint.activate(constraints)
        view = root

        flow.onEntered = { [weak self] in self?.close() }
        flow.onSignInCurrent = signInCurrent
        observation = flow.objectWillChange.sink { [weak self] _ in
            // `objectWillChange` fires before the value moves: read it on the next turn.
            DispatchQueue.main.async { self?.refresh() }
        }
        refresh()
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        view.window?.makeFirstResponder(field)
    }

    func controlTextDidChange(_ notification: Notification) {
        flow.setAddress(field.stringValue)
    }

    private func refresh() {
        suffix.isHidden = !flow.showsSuffix
        field.trailingAccessoryWidth = flow.showsSuffix ? suffix.intrinsicContentSize.width + 12 : 0
        field.isEnabled = !flow.isBusy
        continueButton.apply(.accent, title: flow.buttonTitle, height: Metrics.buttonHeight)
        continueButton.isEnabled = flow.canSubmit
        cancelButton.isEnabled = !flow.isBusy
        lookupHost.isHidden = flow.lookup == .idle
        failureHost.isHidden = flow.failure == nil
        resizeToFit()
    }

    @objc private func submit() {
        flow.submit()
    }

    @objc private func cancel() {
        guard !flow.isBusy else { return }
        flow.cancel()
        close()
    }

    private func resizeToFit() {
        guard let window = view.window else { return }
        view.layoutSubtreeIfNeeded()
        window.setContentSize(view.fittingSize)
    }

    func run(over parent: NSWindow?) {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: NSSize(width: Metrics.width, height: 200)),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.title = String(localized: "Add a workspace")
        window.isReleasedWhenClosed = false
        window.contentViewController = self
        guard let parent else {
            window.center()
            window.makeKeyAndOrderFront(nil)
            return
        }
        parent.beginSheet(window) { _ in window.orderOut(nil) }
    }

    private func close() {
        observation = nil
        guard let window = view.window else { return }
        if let parent = window.sheetParent {
            parent.endSheet(window)
        } else {
            window.orderOut(nil)
        }
    }
}
