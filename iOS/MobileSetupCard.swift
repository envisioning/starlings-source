import EnvisioningUI
import SwiftUI

/// Home's setup checklist on iPhone and iPad (docs/ONBOARDING.md §The setup
/// checklist): the same steps, words and done state as the Mac and the web.
/// What draws is `SetupChecklist.card`; this view only draws it.
struct MobileSetupCard: View {
    let card: SetupChecklist.Card
    let canTurnOff: Bool
    let error: String?
    let open: (SetupStep) -> Void
    let skip: (SetupStep) -> Void
    let hide: () -> Void
    let turnOff: () -> Void
    let retry: () -> Void

    var body: some View {
        StarlingsCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    Text("GET STARTED")
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                    Spacer()
                    if canTurnOff, case .steps = card {
                        Button("Turn off for everyone", action: turnOff)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .buttonStyle(.meetPlain)
                    }
                    if card != .none {
                        Button("Hide", action: hide)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .buttonStyle(.meetPlain)
                    }
                }

                switch card {
                case .none:
                    EmptyView()
                case .done:
                    Text("You’re set up.")
                        .font(.headline)
                        .foregroundStyle(.primary)
                case .steps(let rows):
                    ForEach(rows, id: \.step) { row in
                        HStack(spacing: 8) {
                            if row.opens {
                                Button { open(row.step) } label: { stepRow(row) }
                                    .buttonStyle(.plain) // hover: meetHomeRow
                                    .accessibilityHint("Opens where this step is done")
                            } else {
                                stepRow(row)
                            }
                            if row.skippable {
                                Button("Skip") { skip(row.step) }
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                    .buttonStyle(.meetPlain)
                                    .accessibilityLabel(Text("Skip \(row.step.title)"))
                            }
                        }
                    }
                }

                if let error {
                    StarlingsErrorNotice(message: error, retry: retry)
                }
            }
        }
    }

    private func stepRow(_ row: SetupChecklist.Row) -> some View {
        HStack(alignment: .top, spacing: 10) {
            MobileCompactMark(
                systemName: row.state.done ? "checkmark" : "circle",
                shape: .round,
                size: 24,
                color: row.isNext ? Color.primary : Color.secondary
            )
            .meetFirstLineMark(.headline)
            VStack(alignment: .leading, spacing: 3) {
                Text(row.step.title)
                    .font(.headline)
                    .foregroundStyle(row.state.done ? Color.secondary : Color.primary)
                    .strikethrough(row.state.done)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                if let reason = row.state.blocked?.reason {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .meetLineLimit(2)
                }
            }
            Spacer(minLength: 8)
            if !row.state.required && !row.state.done {
                Text("Optional")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .meetHomeRow()
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel(row))
    }

    private func accessibilityLabel(_ row: SetupChecklist.Row) -> String {
        var parts = [row.step.title]
        if row.state.done { parts.append(String(localized: "Done")) }
        if !row.state.required { parts.append(String(localized: "Optional")) }
        if let reason = row.state.blocked?.reason { parts.append(reason) }
        return parts.joined(separator: ", ")
    }
}
