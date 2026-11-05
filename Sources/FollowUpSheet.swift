import AppKit
import StarlingsContracts

/// After the call, on the Mac: the follow-up drafted for the
/// people outside, the tasks the call proposed with a tick each, and Approve.
/// Approve accepts the ticked tasks, declines the rest, and opens the draft
/// in the host's own mail app, where it is edited and sent. Starlings sends
/// nothing. Built on `WorkFormSheet`, the goal and decision form.
@MainActor
enum FollowUpSheet {
    static func present(over window: NSWindow?, item: InboxFollowUpItem, onApprove: @escaping (_ accept: [String], _ decline: [String]) -> Void) {
        let names = item.recipients.map(\.name).joined(separator: ", ")
        var boxes: [(id: String, box: NSButton)] = []
        let tasks = NSStackView()
        tasks.orientation = .vertical
        tasks.alignment = .leading
        tasks.spacing = 6
        for task in item.tasks {
            let box = NSButton(checkboxWithTitle: task.title, target: nil, action: nil)
            box.state = .on
            box.applyMeetCheckboxStyle()
            boxes.append((task.id, box))
            tasks.addArrangedSubview(box)
        }

        let sheet = WorkFormSheet(
            heading: String(localized: "Follow-up: \(item.meeting.title)"),
            saveTitle: String(localized: "Approve"),
            rows: [
                .view(note(String(localized: "To \(names)"))),
                .field(caption: String(localized: "Subject"), control: text(item.draft.subject)),
                .field(caption: String(localized: "Message"), control: text(item.draft.body)),
                .view(item.tasks.isEmpty ? nil : WorkFormSheet.field(caption: String(localized: "Tasks from this call"), control: tasks)),
                .view(note(String(localized: "Approve opens this in your mail app. Edit it there, then send it."))),
            ],
            firstResponder: nil,
            canSave: { true },
            onSave: {
                onApprove(
                    boxes.filter { $0.box.state == .on }.map(\.id),
                    boxes.filter { $0.box.state != .on }.map(\.id)
                )
            }
        )
        sheet.run(over: window)
    }

    /// Opens the approved draft. The body goes to the clipboard when it is too long for a mail link.
    static func openMail(_ mail: MeetingFollowUpApproveResponseMail) -> Bool {
        let draft = FollowUpMail.draft(to: mail.to, subject: mail.subject, body: mail.body)
        if draft.bodyOnClipboard {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(mail.body, forType: .string)
        }
        if let url = draft.url { NSWorkspace.shared.open(url) }
        return draft.bodyOnClipboard
    }

    private static func text(_ value: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: value)
        label.font = NSFont.systemFont(ofSize: StarlingsTypography.scaled(13))
        label.textColor = StarlingsColors.primaryText
        label.isSelectable = true
        label.preferredMaxLayoutWidth = WorkFormSheet.contentWidth
        return label
    }

    private static func note(_ value: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: value)
        label.font = NSFont.systemFont(ofSize: StarlingsTypography.scaled(12))
        label.textColor = StarlingsColors.secondaryText
        label.preferredMaxLayoutWidth = WorkFormSheet.contentWidth
        return label
    }
}
