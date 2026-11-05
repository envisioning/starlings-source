import Foundation

/// The row a long single-select list searches and displays. Search includes
/// the visible kind/context as well as the title, while selection stays the
/// stable id that the write needs.
struct StarlingsSearchablePickerOption: Hashable, Identifiable, Sendable {
    let id: String
    let title: String
    let context: String?
    let subtitle: String?
    let isStarred: Bool
    let colorHex: String?

    init(
        id: String,
        title: String,
        context: String? = nil,
        subtitle: String? = nil,
        isStarred: Bool = false,
        colorHex: String? = nil
    ) {
        self.id = id
        self.title = title
        self.context = context
        self.subtitle = subtitle
        self.isStarred = isStarred
        self.colorHex = colorHex
    }

    var visibleTitle: String {
        guard let context, !context.isEmpty else { return title }
        return "\(context) · \(title)"
    }

    func matches(_ query: String) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return true }
        let foldedNeedle = needle.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        let haystack = [title, context, subtitle]
            .compactMap { $0 }
            .joined(separator: " ")
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        return haystack.contains(foldedNeedle)
    }
}

extension Array where Element == CrmTeamMember {
    /// Who can hold a task, as picker rows: people, then the enrolled agents,
    /// each agent marked as one.
    var assigneeOptions: [StarlingsSearchablePickerOption] {
        people.map { StarlingsSearchablePickerOption(id: $0.id, title: $0.name) }
            + filter { $0.kind == .agent }.map {
                StarlingsSearchablePickerOption(id: $0.id, title: $0.name, subtitle: String(localized: "Agent"))
            }
    }

    /// The people alone: a goal's owner is a person, never an agent.
    var people: [CrmTeamMember] { filter { $0.kind != .agent } }
}
