import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Whether an extractor can run right now, and if not, why — in words the
/// tasks panel can show the owner.
enum TaskExtractorAvailability: Sendable {
    case available
    case unavailable(String)
}

#if canImport(FoundationModels)

/// What the on-device model is asked to produce. Guided generation makes this
/// schema a type rather than a prompt request, which is the whole reason the
/// extraction runs here instead of against a small remote model.
@available(macOS 26.0, iOS 26.0, *)
@Generable
struct ExtractedTaskList {
    @Guide(description: "Every commitment somebody made in this excerpt. Empty when nobody committed to anything.")
    var tasks: [ExtractedTaskItem]
}

@available(macOS 26.0, iOS 26.0, *)
@Generable
struct ExtractedTaskItem {
    @Guide(description: "The task as a short imperative title, at most 12 words. No speaker names, no dates unless spoken.")
    var title: String

    @Guide(description: "The exact sentence from the excerpt that contains the commitment, copied word for word.")
    var quote: String

    @Guide(description: "Who owes the work. Exactly one of: team, client, unassigned.")
    var responsible: String

    @Guide(description: "How certain this is a real commitment somebody made, from 0 to 100.")
    var confidence: Int
}

/// Apple's on-device model, running beside the transcriber on the same Mac.
/// Nothing here leaves the machine.
@available(macOS 26.0, iOS 26.0, *)
actor FoundationModelsTaskExtractor: TaskSuggestionExtracting {
    nonisolated var engineName: String { "on-device" }

    private static let instructions = """
    You read short excerpts of a live work meeting transcript and list the \
    commitments people made — things somebody said they would do, or asked \
    somebody else to do.

    Rules:
    - Only list commitments that were actually spoken. Never infer, never \
    invent, never add work that sounds sensible.
    - Discussing a topic is not a commitment. "We should think about pricing" \
    is not a task; "I'll send the pricing sheet on Friday" is.
    - Copy the quote verbatim from the excerpt. Do not paraphrase it.
    - Never invent an owner or a due date. If the speaker took the work on, \
    responsible is "team"; if they asked the other side for it, "client"; \
    otherwise "unassigned".
    - Return an empty list whenever nothing was committed to. That is a normal \
    and frequent answer.
    """

    static var availability: TaskExtractorAvailability {
        switch SystemLanguageModel.default.availability {
        case .available:
            return .available
        case .unavailable(let reason):
            switch reason {
            case .appleIntelligenceNotEnabled:
                return .unavailable("Apple Intelligence isn’t enabled on this Mac.")
            case .deviceNotEligible:
                return .unavailable("this Mac can’t run the on-device model.")
            case .modelNotReady:
                return .unavailable("the on-device model is still downloading.")
            @unknown default:
                return .unavailable("the on-device model is unavailable.")
            }
        }
    }

    func extract(window: [TranscriptSegment]) async throws -> [ExtractedTaskCandidate] {
        try await extract(window: window, knownNames: [])
    }

    func extract(window: [TranscriptSegment], knownNames: [String]) async throws -> [ExtractedTaskCandidate] {
        guard case .available = Self.availability else { return [] }
        let excerpt = Self.excerpt(from: window)
        guard !excerpt.isEmpty else { return [] }

        // A fresh session per extraction: the window is the whole context, and
        // a long-lived session would grow one meeting's worth of transcript.
        let session = LanguageModelSession(instructions: Self.instructions)
        // The names as the CRM spells them, so a title or a quote that names
        // somebody uses that spelling and not the recognizer's.
        let names = Array(Set(knownNames.filter { !$0.isEmpty })).sorted().prefix(40)
        let people = names.isEmpty ? "" : String(localized: "People in this meeting: \(names.joined(separator: ", ")). Spell their names exactly this way.\n\n")
        let response = try await session.respond(
            to: "\(people)Meeting excerpt:\n\n\(excerpt)",
            generating: ExtractedTaskList.self,
            options: GenerationOptions(temperature: 0.1)
        )
        return response.content.tasks.compactMap { item in
            let title = item.title.trimmingCharacters(in: .whitespacesAndNewlines)
            let quote = item.quote.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty, !quote.isEmpty else { return nil }
            return ExtractedTaskCandidate(
                title: title,
                quote: quote,
                responsible: TaskSuggestionHeuristics.responsible(from: item.responsible),
                confidence: min(1, max(0, Double(item.confidence) / 100))
            )
        }
    }

    private static func excerpt(from window: [TranscriptSegment]) -> String {
        window
            .map { segment in
                let stamp = TaskSuggestion.timestampLabel(segment.startsAtMilliseconds)
                return String(localized: "[\(stamp)] \(segment.speakerName): \(segment.text)")
            }
            .joined(separator: "\n")
    }
}

#endif
