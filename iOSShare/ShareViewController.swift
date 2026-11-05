import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The share sheet's entry (NSExtensionPrincipalClass). It reads what the
/// host app shared and hosts `ShareSheet`; the page goes to the outbox, and
/// the app saves it (`ShareOutbox`).
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let model = ShareModel(context: extensionContext)
        let host = UIHostingController(rootView: ShareSheet(model: model))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        model.load()
    }
}

/// What was shared, in plain values. Safari runs `PageCapture.js` and hands
/// back the page; another app hands a URL alone.
struct SharedPage: Sendable {
    var url: URL
    var title: String
    var html: String?

    /// `PageCapture.js`'s answer, wrapped by Safari in a property list.
    init?(propertyList item: (any NSSecureCoding)?) {
        guard let root = item as? [String: Any],
              let results = root[NSExtensionJavaScriptPreprocessingResultsKey] as? [String: Any],
              let address = results["url"] as? String,
              let url = URL(string: address)
        else { return nil }
        self.url = url
        title = (results["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        html = (results["html"] as? String).flatMap { $0.count <= ShareOutbox.pageHTMLMaxCharacters ? $0 : nil }
    }

    init?(urlItem item: (any NSSecureCoding)?) {
        guard let url = item as? URL else { return nil }
        self.url = url
        title = ""
        html = nil
    }
}

@MainActor
final class ShareModel: ObservableObject {
    enum Phase: Equatable {
        case reading
        case ready
        case saved
        /// Shared from something that is not a web page.
        case notAPage
    }

    @Published private(set) var phase: Phase = .reading
    @Published private(set) var page: SharedPage?
    @Published var title = ""
    @Published var note = ""
    @Published private(set) var errorMessage: String?
    let workspace = ShareOutbox.workspace()

    private weak var context: NSExtensionContext?

    init(context: NSExtensionContext?) {
        self.context = context
    }

    func load() {
        let providers = (context?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier) }) {
            provider.loadItem(forTypeIdentifier: UTType.propertyList.identifier, options: nil) { item, _ in
                let page = SharedPage(propertyList: item)
                Task { @MainActor in self.show(page) }
            }
        } else if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }) {
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
                let page = SharedPage(urlItem: item)
                Task { @MainActor in self.show(page) }
            }
        } else {
            show(nil)
        }
    }

    private func show(_ page: SharedPage?) {
        guard let page, page.url.scheme == "https" else {
            phase = .notAPage
            return
        }
        self.page = page
        title = page.title
        phase = .ready
    }

    var canSave: Bool { phase == .ready && workspace != nil }

    func save() {
        guard canSave, let page, let workspace else { return }
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try ShareOutbox.write(ShareOutboxItem(
                id: UUID(),
                createdAt: Date(),
                workspaceOrigin: workspace.webOrigin,
                url: page.url.absoluteString,
                title: trimmedTitle.isEmpty ? nil : trimmedTitle,
                note: note.trimmingCharacters(in: .whitespacesAndNewlines),
                pageHTML: page.html
            ))
            errorMessage = nil
            phase = .saved
        } catch {
            errorMessage = String(localized: "Couldn’t keep the page for Starlings.")
        }
    }

    func close() {
        context?.completeRequest(returningItems: nil)
    }
}
