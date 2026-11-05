import AppKit
import StarlingsContracts

/// The Hand off sheet: before a card goes to an agent, the person
/// says what done looks like and what comes back. Both are required, on the
/// menu and on a drop, so the person who accepts the card at Review can read
/// what was asked for. Built on `WorkFormSheet`, the goal and decision form.
@MainActor
enum HandOffSheet {
    static func present(over window: NSWindow?, cardTitle: String, agentName: String, onHandOff: @escaping (ThreadHandoff) -> Void) {
        let doneField = StarlingsTextField(placeholder: String(localized: "What is true when this is finished"))
        let deliverableField = StarlingsTextField(placeholder: String(localized: "A pull request, a document, a message"))
        let trimmed = { (field: StarlingsTextField) in field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) }

        let sheet = WorkFormSheet(
            heading: String(localized: "Hand off to \(agentName)"),
            saveTitle: String(localized: "Hand off"),
            rows: [
                .view(cardLabel(cardTitle)),
                .field(caption: String(localized: "Done when"), control: doneField),
                .field(caption: String(localized: "Deliverable"), control: deliverableField),
            ],
            firstResponder: doneField,
            canSave: { !trimmed(doneField).isEmpty && !trimmed(deliverableField).isEmpty },
            onSave: {
                onHandOff(ThreadHandoff(doneWhen: trimmed(doneField), deliverable: trimmed(deliverableField)))
            }
        )
        doneField.delegate = sheet
        deliverableField.delegate = sheet
        sheet.run(over: window)
    }

    /// The message text: the card, then the brief, so a person reading the
    /// conversation later sees what was asked without opening anything.
    static func messageText(card line: String, handoff: ThreadHandoff) -> String {
        HandOffText.message(cardLine: line, doneWhen: handoff.doneWhen, deliverable: handoff.deliverable)
    }

    private static func cardLabel(_ title: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: title)
        label.font = NSFont.systemFont(ofSize: StarlingsTypography.scaled(13))
        label.textColor = StarlingsColors.secondaryText
        label.preferredMaxLayoutWidth = WorkFormSheet.contentWidth
        return label
    }
}
