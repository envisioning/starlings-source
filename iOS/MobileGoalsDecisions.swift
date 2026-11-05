import EnvisioningUI
import StarlingsContracts
import SwiftUI

/// The phone's goal and decision sheets (#262): the task editor's
/// shell with fewer rows. A goal is a title, a target day and an owner; a
/// decision is a body that may cite a live goal.
struct MobileGoalEditor: View {
    struct Draft {
        var title = ""
        var targetDate: Date?
        var owner: String?
    }

    @State var draft = Draft()
    let team: [CrmTeamMember]
    let onSave: (Draft) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            StarlingsForm {
                Section {
                    TextField("What the project is aiming at", text: $draft.title, axis: .vertical)
                        .meetSingleLine($draft.title)
                }
                Section {
                    Toggle("Target date", isOn: Binding(
                        get: { draft.targetDate != nil },
                        set: { draft.targetDate = $0 ? (draft.targetDate ?? Date()) : nil }
                    ))
                    .meetToggleTint()
                    if draft.targetDate != nil {
                        DatePicker(
                            "By",
                            selection: Binding(get: { draft.targetDate ?? Date() }, set: { draft.targetDate = $0 }),
                            displayedComponents: .date
                        )
                    }
                }
                if !team.isEmpty {
                    Section {
                        StarlingsSearchablePicker(
                            label: String(localized: "Owner"),
                            placeholder: String(localized: "Nobody yet"),
                            options: [StarlingsSearchablePickerOption(id: "", title: String(localized: "Nobody yet"))]
                                + team.people.map { StarlingsSearchablePickerOption(id: $0.id, title: $0.name) },
                            selection: Binding(
                                get: { draft.owner ?? "" },
                                set: { draft.owner = $0.isEmpty ? nil : $0 }
                            ),
                            emptyMessage: String(localized: "No options match that search.")
                        )
                    }
                }
            }
            .navigationTitle("New goal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(draft)
                        dismiss()
                    }
                    .disabled(draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .meetToolbarConfirm()
                }
            }
        }
    }
}

struct MobileDecisionEditor: View {
    struct Draft {
        var body = ""
        var goalID: String?
    }

    @State var draft = Draft()
    let goals: [CrmGoal]
    let onSave: (Draft) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            StarlingsForm {
                Section {
                    TextField("What was settled", text: $draft.body, axis: .vertical)
                        .lineLimit(2...6)
                }
                if !goals.isEmpty {
                    Section {
                        StarlingsSearchablePicker(
                            label: String(localized: "Goal"),
                            placeholder: String(localized: "None"),
                            options: [StarlingsSearchablePickerOption(id: "", title: String(localized: "None"))]
                                + goals.map { StarlingsSearchablePickerOption(id: $0.id, title: $0.title) },
                            selection: Binding(
                                get: { draft.goalID ?? "" },
                                set: { draft.goalID = $0.isEmpty ? nil : $0 }
                            ),
                            emptyMessage: String(localized: "No options match that search.")
                        )
                    }
                }
            }
            .navigationTitle("Record decision")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(draft)
                        dismiss()
                    }
                    .disabled(draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .meetToolbarConfirm()
                }
            }
        }
    }
}

/// A wire date as the person reads it, never as the API spells it. A plain
/// `YYYY-MM-DD` is a calendar day and stays that day in every zone; a full
/// ISO timestamp is parsed once and drawn as a date in the device's zone.
/// Anything unparseable is no date rather than a raw string.
enum MobileDayLabel {
    static func text(_ wire: String?) -> String? {
        guard let wire = wire?.trimmingCharacters(in: .whitespaces), !wire.isEmpty else { return nil }
        if wire.count > 10 {
            return CrmTaskDate.date(wire).map { StarlingsDateFormatting.date($0) }
        }
        guard let (year, month, day) = WorkItems.civilDay(wire) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        let utc = TimeZone(secondsFromGMT: 0) ?? .gmt
        calendar.timeZone = utc
        guard let date = calendar.date(from: DateComponents(year: year, month: month, day: day)) else { return nil }
        var style = Date.FormatStyle(date: .abbreviated, time: .omitted, timeZone: utc)
        style.locale = StarlingsDateFormatting.locale
        return style.format(date)
    }
}

/// What a goal row says under its title: the target day (late when it is),
/// the status when closed, the owner.
enum MobileGoalRow {
    static func metadata(_ goal: CrmGoal) -> String {
        let late = GoalsDecisions.isLate(goal)
        let date = MobileDayLabel.text(goal.targetDate).map { late ? String(localized: "Late, \($0)") : $0 }
        let status = goal.status == .open ? nil : goal.status.label
        return [date, status, goal.ownerName].compactMap { $0 }.joined(separator: " · ")
    }

    static func symbol(_ goal: CrmGoal) -> String {
        goal.status == .met ? "checkmark.circle" : GoalsDecisions.isLate(goal) ? "exclamationmark.circle" : "flag"
    }
}

/// What a decision row says under its body: the day, who, the client when a
/// Claude recorded it, and the goal it cites.
enum MobileDecisionRow {
    static func metadata(_ decision: CrmDecision, goals: [CrmGoal]) -> String {
        let day = MobileDayLabel.text(decision.decidedAt)
        let via = decision.source == .agent ? decision.sourceRef.map { String(localized: "via \($0)") } : nil
        let goal = decision.goalID.flatMap { id in goals.first { $0.id == id }?.title }
        return [day, decision.decidedByName, via, goal].compactMap { $0 }.joined(separator: " · ")
    }
}

/// A decision waiting on you, opened from INBOX
/// (docs/help/howto/answer-a-decision.md): the agent's context and links,
/// a note, and one button per option with the recommendation marked.
/// Choosing an option answers it and closes the sheet.
struct MobileDecisionSheet: View {
    let ask: DecisionAsk
    let onAnswer: (_ option: DecisionAskOption, _ note: String?) -> Void

    @State private var note = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            StarlingsForm {
                Section {
                    Text(ask.question)
                        .font(.headline)
                    Text("Asked by \(ask.askedBy)")
                        .font(.subheadline.weight(.semibold))
                    Text(meta)
                        .font(.footnote)
                        .foregroundStyle(ask.overdue ? StarlingsMobileColors.danger : .secondary)
                }
                if let context = ask.context, !context.isEmpty {
                    Section {
                        Text(Self.markdown(context))
                            .font(.callout)
                            .textSelection(.enabled)
                    }
                }
                if !ask.links.isEmpty {
                    Section("Links") {
                        ForEach(ask.links, id: \.url) { link in
                            if let url = URL(string: link.url) {
                                Link(link.title ?? link.url, destination: url)
                            }
                        }
                    }
                }
                Section {
                    TextField("Note (optional)", text: $note, axis: .vertical)
                        .lineLimit(1...4)
                }
                Section {
                    Text("Choose an option to send your answer.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    ForEach(ask.options, id: \.key) { option in
                        Button {
                            let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
                            onAnswer(option, trimmed.isEmpty ? nil : trimmed)
                            dismiss()
                        } label: {
                            HStack {
                                Text(option.label)
                                Spacer()
                                if option.key == ask.recommendation {
                                    Text("Recommended")
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                        .meetHoverLift(cornerRadius: EnvisioningRadius.control)
                        .accessibilityLabel(option.key == ask.recommendation
                            ? String(localized: "\(option.label), recommended")
                            : option.label)
                    }
                }
            }
            .navigationTitle("Decision")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { dismiss() }
                }
            }
        }
    }

    private var meta: String {
        [
            ask.overdue ? String(localized: "Overdue") : nil,
            ask.defaultByLabel,
            ask.subject?.title,
        ].compactMap { $0 }.joined(separator: " · ")
    }

    /// The agent's markdown, inline styles kept, line breaks as written.
    private static func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}
