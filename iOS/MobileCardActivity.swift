import EnvisioningUI
import StarlingsContracts
import SwiftUI

/// What was said about one card: the hand-off with its brief, the
/// agent's steps and answers, its questions, the event lines, from every
/// thread that named the card and that the member can read. A question with
/// one answer is answered here; the answer clears Inbox and Talk too.
struct MobileCardActivitySection: View {
    let refKind: String
    let refID: String

    @EnvironmentObject private var app: StarlingsAppModel
    @State private var lines: [ThreadMessage]?
    @State private var error: String?
    @State private var submitting: Set<String> = []

    var body: some View {
        Section("Activity") {
            if let error {
                StarlingsErrorNotice(message: error, font: .body)
            } else if let lines {
                let answers = Dictionary(
                    lines.compactMap { line in line.questionAnswer.map { ($0.questionMessageID, $0) } },
                    uniquingKeysWith: { _, latest in latest }
                )
                let shown = lines.filter { $0.questionAnswer == nil }
                if shown.isEmpty {
                    Text("Nothing said about this yet.").foregroundStyle(.secondary)
                }
                ForEach(shown) { line in
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(line.senderName ?? line.senderEmail) · \(line.sentAt.meetDateTimeString(dateStyle: .abbreviated))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(line.isWithdrawn ? String(localized: "Withdrawn.") : line.text)
                            .font(.subheadline)
                            .foregroundStyle(line.isEvent ? .secondary : .primary)
                            .textSelection(.enabled)
                        if let question = line.question, !line.isWithdrawn {
                            questionControls(question, line: line, answer: answers[line.id])
                        }
                    }
                }
            } else {
                EnvisioningPlaceholderRows()
            }
        }
        .task(id: refID) { await load() }
    }

    @ViewBuilder
    private func questionControls(_ question: ThreadQuestion, line: ThreadMessage, answer: ThreadQuestionAnswer?) -> some View {
        if let answer {
            Text("Answered: \(answer.optionLabels.joined(separator: ", "))")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else if question.mode == .single {
            ForEach(question.options, id: \.id) { option in
                Button(option.label) { Task { await answerQuestion(line, optionID: option.id) } }
                    .disabled(submitting.contains(line.id))
                    .meetHoverLift(cornerRadius: EnvisioningRadius.control)
            }
        } else {
            Text("Answer it in Talk.").font(.footnote).foregroundStyle(.secondary)
        }
    }

    private func load() async {
        guard let credentials = app.ownerCredentials else { return }
        do {
            lines = try await app.api.cardLines(credentials: credentials, kind: refKind, id: refID)
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    private func answerQuestion(_ line: ThreadMessage, optionID: String) async {
        guard let credentials = app.ownerCredentials else { return }
        submitting.insert(line.id)
        defer { submitting.remove(line.id) }
        do {
            let result = try await app.api.answerQuestion(
                credentials: credentials, threadID: line.threadID, messageID: line.id, optionIDs: [optionID]
            )
            lines?.append(result.message)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
