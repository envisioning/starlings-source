import AppKit
import StarlingsContracts
import UniformTypeIdentifiers

/// Getting a meeting's transcript out of the Mac: the link to its
/// page in Meet, the system share menu with that link and the title, the text
/// on the clipboard, and a `.md` or `.txt` file.
///
/// The link is the meeting's page on the public origin with no token in it
/// (`TranscriptExport.permalink`); it grants nothing, so whoever opens it
/// still signs in and is still refused if they cannot read the meeting. The
/// copy and the files are the record as the Worker serves it, formatted by
/// the rule every client shares (`TranscriptExport`, pinned to
/// `fixtures/transcript-export.json`): struck lines gone, renamed speakers
/// under their new names. Not the panel's own lines, which are a bounded
/// view of the captions, never the record.
@MainActor
final class TranscriptShareMenu: NSObject {
    private let api: MeetingControlAPI
    private let context: () -> MeetingContext?
    private let onError: (StarlingsError) -> Void
    /// The title the last record carried, shared beside the link.
    private var lastTitle: (meetingID: String, title: String)?

    private func title(for context: MeetingContext) -> String? {
        lastTitle?.meetingID == context.meetingID ? lastTitle?.title : nil
    }

    private func remember(_ view: TranscriptViewResponse, for context: MeetingContext) {
        lastTitle = view.artifact.title.map { (context.meetingID, $0) }
    }

    init(api: MeetingControlAPI, context: @escaping () -> MeetingContext?, onError: @escaping (StarlingsError) -> Void) {
        self.api = api
        self.context = context
        self.onError = onError
    }

    func present(from button: NSView) {
        guard let context = context() else { return }
        // The title, for Share…, while the menu is open. Quiet on failure:
        // Share works without it, and Copy says what went wrong itself.
        if title(for: context) == nil {
            Task { [weak self] in
                guard let self, let view = try? await api.meetingTranscript(context: context) else { return }
                remember(view, for: context)
            }
        }
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.addItem(item(String(localized: "Copy Link"), symbol: "link", action: #selector(copyLink(_:))))
        let share = item(String(localized: "Share…"), symbol: "square.and.arrow.up", action: #selector(share(_:)))
        share.representedObject = button
        menu.addItem(share)
        menu.addItem(.separator())
        menu.addItem(item(String(localized: "Copy Transcript"), symbol: "doc.on.doc", action: #selector(copyTranscript(_:))))
        menu.addItem(item(String(localized: "Download Markdown…"), symbol: "arrow.down.doc", action: #selector(downloadMarkdown(_:))))
        menu.addItem(item(String(localized: "Download Text…"), symbol: "arrow.down.doc", action: #selector(downloadText(_:))))
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.height + 2), in: button)
    }

    private func item(_ title: String, symbol: String, action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        return item
    }

    private var link: String? {
        guard let context = context() else { return nil }
        return TranscriptExport.permalink(room: context.room.rawValue, meetingID: context.meetingID)
    }

    // MARK: Link

    @objc private func copyLink(_ sender: NSMenuItem) {
        guard let link else { return }
        let board = NSPasteboard.general
        board.clearContents()
        board.setString(link, forType: .string)
        board.setString(link, forType: .URL)
        StarlingsToast.show(String(localized: "Link copied"), in: NSApp.keyWindow)
    }

    @objc private func share(_ sender: NSMenuItem) {
        guard let context = context(), let link, let url = URL(string: link), let anchor = sender.representedObject as? NSView else { return }
        // The link and the meeting's title, when the record has said it: a
        // bare link reads as spam in Mail and Messages.
        let items: [Any] = title(for: context).map { [$0 as NSString, url] } ?? [url]
        let picker = NSSharingServicePicker(items: items)
        picker.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .minY)
    }

    // MARK: Text and files

    @objc private func copyTranscript(_ sender: NSMenuItem) {
        Task { [weak self] in
            guard let self, let text = await formatted(.text) else { return }
            let board = NSPasteboard.general
            board.clearContents()
            board.setString(text.body, forType: .string)
            StarlingsToast.show(String(localized: "Transcript copied"), in: NSApp.keyWindow)
        }
    }

    @objc private func downloadMarkdown(_ sender: NSMenuItem) { download(.markdown) }

    @objc private func downloadText(_ sender: NSMenuItem) { download(.text) }

    private func download(_ format: TranscriptExport.Format) {
        Task { [weak self] in
            guard let self, let file = await formatted(format) else { return }
            let panel = NSSavePanel()
            panel.nameFieldStringValue = file.name
            panel.allowedContentTypes = [UTType(filenameExtension: format.rawValue) ?? .plainText]
            panel.canCreateDirectories = true
            let answer: NSApplication.ModalResponse
            if let window = NSApp.keyWindow {
                answer = await panel.beginSheetModal(for: window)
            } else {
                answer = panel.runModal()
            }
            guard answer == .OK, let url = panel.url else { return }
            do {
                try file.body.write(to: url, atomically: true, encoding: .utf8)
            } catch {
                onError(Self.failure(String(localized: "Couldn’t save the transcript"), diagnostic: error.localizedDescription))
            }
        }
    }

    /// The record, fetched now and formatted. Nil after saying why it could not be.
    private func formatted(_ format: TranscriptExport.Format) async -> (body: String, name: String)? {
        guard let context = context() else { return nil }
        do {
            let view = try await api.meetingTranscript(context: context)
            remember(view, for: context)
            let input = TranscriptExport.Input(
                view: view,
                untitled: String(localized: "Meeting"),
                subject: view.category.subjectTitle
            )
            return (
                TranscriptExport.format(input, as: format),
                TranscriptExport.fileName(title: input.title, startedAt: input.startedAt, timeZone: input.timeZone, format: format)
            )
        } catch {
            onError((error as? StarlingsError).map { Self.notice($0) }
                ?? Self.failure(String(localized: "Couldn’t load the transcript"), diagnostic: String(describing: error)))
            return nil
        }
    }

    /// A transcript that will not come out is worth saying, not worth a modal.
    private static func notice(_ error: StarlingsError) -> StarlingsError {
        var error = error
        error.severity = .notice
        return error
    }

    private static func failure(_ title: String, diagnostic: String) -> StarlingsError {
        StarlingsError(
            code: "transcript.export_failed",
            title: title,
            message: String(localized: "Try again in a moment."),
            severity: .notice,
            diagnostic: diagnostic
        )
    }
}
