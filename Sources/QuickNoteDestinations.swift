import Foundation

/// The complete first page used by Quick Note filing. A bounded Core page is
/// still useful while idle; the picker searches Core when `subjectsHaveMore`
/// is true so a subject outside that page remains reachable.
struct QuickNoteDestinationOptions: Equatable, Sendable {
    var subjects: [CrmSubject]
    var starred: Set<String>
    var threads: [ThreadSummary]
    var projectsHaveMore: Bool
    var leadsHaveMore: Bool
    /// A partner is filed on its organization; only a task can go there.
    var partnersHaveMore = false

    var subjectsHaveMore: Bool { projectsHaveMore || leadsHaveMore || partnersHaveMore }

    func subjectOptions(projectsOnly: Bool) -> [StarlingsSearchablePickerOption] {
        subjects
            .filter { !projectsOnly || $0.kind == "project" }
            .map { subject in
                StarlingsSearchablePickerOption(
                    id: "\(subject.kind):\(subject.id)",
                    title: subject.title,
                    context: subject.pickerKindLabel,
                    subtitle: subject.subtitle,
                    isStarred: starred.contains(subject.stateKey)
                )
            }
    }

    var threadOptions: [StarlingsSearchablePickerOption] {
        threads.map { thread in
            StarlingsSearchablePickerOption(
                id: thread.id,
                title: thread.title,
                context: nil,
                subtitle: nil,
                isStarred: false
            )
        }
    }
}

extension CrmSubject {
    /// The context a picker row carries: what kind of place this is.
    var pickerKindLabel: String { subjectKind.label }
}

/// Short-lived, owner-scoped memory cache for the Quick Note destination
/// lists. The existing snapshot store remains the disk/head-start tier; this
/// tier avoids another API read simply because a filing sheet was reopened.
final class QuickNoteDestinationOptionsCache: @unchecked Sendable {
    static let shared = QuickNoteDestinationOptionsCache()
    static let lifetime: TimeInterval = 5 * 60

    private struct Entry {
        var owner: String
        var options: QuickNoteDestinationOptions
        var savedAt: Date
        var searches: [String: SearchEntry]
    }

    private struct SearchEntry {
        var subjects: [CrmSubject]
        var savedAt: Date
    }

    private let lock = NSLock()
    private var entry: Entry?

    private init() {}

    func load(owner: String, now: Date = Date()) -> QuickNoteDestinationOptions? {
        lock.withLock {
            guard let entry else { return nil }
            guard entry.owner == owner.lowercased(), now.timeIntervalSince(entry.savedAt) < Self.lifetime else {
                self.entry = nil
                return nil
            }
            return entry.options
        }
    }

    func store(_ options: QuickNoteDestinationOptions, owner: String, now: Date = Date()) {
        lock.withLock {
            entry = Entry(owner: owner.lowercased(), options: options, savedAt: now, searches: [:])
        }
    }

    func loadSearch(owner: String, query: String, projectsOnly: Bool, now: Date = Date()) -> [CrmSubject]? {
        let key = searchKey(query: query, projectsOnly: projectsOnly)
        return lock.withLock {
            guard var entry, entry.owner == owner.lowercased() else { return nil }
            guard now.timeIntervalSince(entry.savedAt) < Self.lifetime else {
                self.entry = nil
                return nil
            }
            guard let result = entry.searches[key], now.timeIntervalSince(result.savedAt) < Self.lifetime else {
                entry.searches.removeValue(forKey: key)
                self.entry = entry
                return nil
            }
            return result.subjects
        }
    }

    func storeSearch(_ subjects: [CrmSubject], owner: String, query: String, projectsOnly: Bool, now: Date = Date()) {
        let key = searchKey(query: query, projectsOnly: projectsOnly)
        lock.withLock {
            guard var entry, entry.owner == owner.lowercased(), now.timeIntervalSince(entry.savedAt) < Self.lifetime else {
                return
            }
            entry.searches[key] = SearchEntry(subjects: subjects, savedAt: now)
            self.entry = entry
        }
    }

    func clear() {
        lock.withLock { entry = nil }
    }

    func invalidate(owner: String, prefixes: [String]) {
        let affectsDestinations = prefixes.contains { prefix in
            ["crm/subjects", "crm/starred", "crm/subject-state", "threads"].contains { source in
                prefix == source || prefix.hasPrefix(source + "?") || source.hasPrefix(prefix + "/")
            }
        }
        guard affectsDestinations else { return }
        lock.withLock {
            guard entry?.owner == owner.lowercased() else { return }
            entry = nil
        }
    }

    private func searchKey(query: String, projectsOnly: Bool) -> String {
        "\(projectsOnly ? "projects" : "subjects"):\(query.trimmingCharacters(in: .whitespacesAndNewlines).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current))"
    }
}
