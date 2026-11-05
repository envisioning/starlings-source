import Foundation

/// The kinds a search row can be. The order of `allCases` is the kind order
/// used to break ties — `fixtures/search-rows.json` `kinds`, which
/// `SearchFixtureTests` holds this file to. Every case before `destination` is
/// a hit (a thing); the last three are doors (places and verbs).
enum SearchKind: String, CaseIterable, Codable, Hashable, Sendable {
    case subject
    case person
    case agent
    /// A person outside the workspace. The door opens their page.
    case contact
    case thread
    case document
    case folder
    case event
    case task
    case issue
    /// A goal on a project and a decision on a subject (#262).
    /// Their door is the subject's: the row opens where the thing lives.
    case goal
    case decision
    /// A milestone on a project and a call on a subject. Found
    /// once their group answers from D1; their door is the subject's.
    case milestone
    case call
    case core
    case destination
    case settings
    case verb

    var isHit: Bool { Search.hitKinds.contains(self) }
}

enum SearchDestination: String, CaseIterable, Codable, Hashable, Sendable {
    case home, calendar, work, team, docs
}

/// The Settings pages a door can open: the ones every client lists, which is
/// `SETTINGS_PAGES_EVERYWHERE` in `settings-pages.ts` (`fixtures/settings-pages.json` `everywhere`).
enum SearchSettingsPage: String, CaseIterable, Codable, Hashable, Sendable {
    case account, home, work, calendar, appearance, about
}

enum SearchVerb: String, CaseIterable, Codable, Hashable, Sendable {
    case newTask = "new-task"
    case newIssue = "new-issue"
    case newDocument = "new-document"
    case startRoom = "start-room"
    case openInternalRoom = "open-internal-room"
}

enum SearchSubjectKind: String, CaseIterable, Codable, Hashable, Sendable {
    case lead, project, organization, event

    /// Reads `subject:organization:<id>` as the partner it was, so this build
    /// keeps opening doors when the Worker renames the kind (ADR 0006).
    init?(rawValue: String) {
        switch rawValue {
        case "lead": self = .lead
        case "project": self = .project
        case "organization", "partner": self = .organization
        case "event": self = .event
        default: return nil
        }
    }
}

/// A person is one row. → or ⌘-Enter shows these, named per docs/SURFACES.md;
/// a client drops Call when the person is not callable. Knock is a guest's
/// gesture at a room door, not a person verb.
enum SearchPersonVerb: String, CaseIterable, Codable, Hashable, Sendable {
    case message, wave, call
}

/// A subject is one row too. → or ⌘-Enter shows what can be made
/// about it: a task, an issue, a document, a room filed under it. The names
/// are the bare palette verbs' with the subject as their argument.
enum SearchSubjectVerb: String, CaseIterable, Codable, Hashable, Sendable {
    case newTask = "new-task"
    case newIssue = "new-issue"
    case newDocument = "new-document"
    case startRoom = "start-room"
}

/// What → shows behind a row: a person's verbs, or a subject's.
enum SearchRowVerb: Hashable, Sendable {
    case person(SearchPersonVerb)
    case subject(SearchSubjectVerb)

    var title: String {
        switch self {
        case .person(let verb): verb.title
        case .subject(let verb): verb.title
        }
    }
}

/// Where a row goes. The wire spelling is `<to>:<id>` (`subject:<kind>:<id>`);
/// `init?(string:)` is the one reader and `string` the one writer. A door
/// names an existing route or window destination; the palette never invents
/// navigation.
enum SearchDoor: Equatable, Hashable, Sendable {
    case destination(SearchDestination)
    case settings(SearchSettingsPage)
    case verb(SearchVerb)
    case subject(SearchSubjectKind, id: String)
    case person(id: String)
    case agent(id: String)
    case contact(id: String)
    case thread(id: String)
    case document(id: String)
    case folder(id: String)
    case event(id: String)
    case task(id: String)
    case issue(id: String)
    case core(id: String)

    init?(string door: String) {
        guard let colon = door.firstIndex(of: ":"), colon != door.startIndex else { return nil }
        let to = String(door[..<colon])
        let rest = String(door[door.index(after: colon)...])
        guard !rest.isEmpty else { return nil }
        switch to {
        case "destination":
            guard let value = SearchDestination(rawValue: rest) else { return nil }
            self = .destination(value)
        case "settings":
            guard let value = SearchSettingsPage(rawValue: rest) else { return nil }
            self = .settings(value)
        case "verb":
            guard let value = SearchVerb(rawValue: rest) else { return nil }
            self = .verb(value)
        case "subject":
            guard let second = rest.firstIndex(of: ":"), second != rest.startIndex,
                  let subjectKind = SearchSubjectKind(rawValue: String(rest[..<second])) else { return nil }
            let id = String(rest[rest.index(after: second)...])
            guard !id.isEmpty else { return nil }
            self = .subject(subjectKind, id: id)
        case "person": self = .person(id: rest)
        case "agent": self = .agent(id: rest)
        case "contact": self = .contact(id: rest)
        case "thread": self = .thread(id: rest)
        case "document": self = .document(id: rest)
        case "folder": self = .folder(id: rest)
        case "event": self = .event(id: rest)
        case "task": self = .task(id: rest)
        case "issue": self = .issue(id: rest)
        case "core": self = .core(id: rest)
        default: return nil
        }
    }

    var string: String {
        switch self {
        case .destination(let value): return "destination:\(value.rawValue)"
        case .settings(let value): return "settings:\(value.rawValue)"
        case .verb(let value): return "verb:\(value.rawValue)"
        case .subject(let kind, let id): return "subject:\(kind.rawValue):\(id)"
        case .person(let id): return "person:\(id)"
        case .agent(let id): return "agent:\(id)"
        case .contact(let id): return "contact:\(id)"
        case .thread(let id): return "thread:\(id)"
        case .document(let id): return "document:\(id)"
        case .folder(let id): return "folder:\(id)"
        case .event(let id): return "event:\(id)"
        case .task(let id): return "task:\(id)"
        case .issue(let id): return "issue:\(id)"
        case .core(let id): return "core:\(id)"
        }
    }
}

/// One result: on the wire from `GET /api/search?q=`, in memory from a
/// client's own stores, and in a device's recents. A row whose door does not
/// parse is not a row — `init(from:)` refuses it.
struct SearchRow: Equatable, Hashable, Codable, Sendable, Identifiable {
    let kind: SearchKind
    /// Stable inside its kind; `key` is `<kind>:<id>`.
    let id: String
    let title: String
    /// May be empty. The second line, and the last thing a token can match.
    let subtitle: String
    /// The wire spelling; `door` is the parsed one.
    let doorString: String
    /// A mark for the row — an organization's logo on a subject; nil
    /// otherwise. Never matched, never ranked (fixture: IMAGE). A client
    /// draws the kind's glyph without it.
    let image: String?

    var door: SearchDoor { SearchDoor(string: doorString)! }
    var key: String { Search.key(kind: kind, id: id) }

    init(kind: SearchKind, id: String, title: String, subtitle: String, door: SearchDoor, image: String? = nil) {
        self.kind = kind
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.doorString = door.string
        self.image = image
    }

    /// The row as the wire carries it (`SearchRowWire`, generated). A row
    /// whose kind this build does not know, or whose door does not parse, is
    /// not a row this build can open.
    init?(wire: SearchRowWire) {
        guard !wire.id.isEmpty, let kind = SearchKind(rawValue: wire.kind.rawValue), let door = SearchDoor(string: wire.door) else { return nil }
        self.init(kind: kind, id: wire.id, title: wire.title, subtitle: wire.subtitle, door: door, image: wire.image)
    }

    var wire: SearchRowWire {
        SearchRowWire(kind: .init(rawValue: kind.rawValue), id: id, title: title, subtitle: subtitle, door: doorString, image: image)
    }

    func encode(to encoder: Encoder) throws {
        try wire.encode(to: encoder)
    }

    init(from decoder: Decoder) throws {
        let wire = try SearchRowWire(from: decoder)
        guard let row = SearchRow(wire: wire) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "search: a row this build cannot open (\(wire.kind) \(wire.door))"))
        }
        self = row
    }
}

/// `GET /api/search` response.
struct SearchResponse: Decodable, Sendable {
    let rows: [SearchRow]
    /// Sources the Worker could not read in time, by name. Their rows are
    /// missing, not absent.
    let partial: [String]?

    init(from decoder: Decoder) throws {
        let wire = try SearchResponseWire(from: decoder)
        // A row this build cannot open is left out, never a reason to lose the rest.
        rows = wire.rows.compactMap(SearchRow.init(wire:))
        partial = wire.partial
    }
}

/// What one search came back with: the rows, and whether they are all of them.
struct SearchAnswer: Sendable {
    let rows: [SearchRow]
    let partial: [String]

    init(_ response: SearchResponse) {
        rows = response.rows
        partial = response.partial ?? []
    }
}

/// One search for Mac, iOS and web: the row a result is, the kinds
/// a row can be, the door a row opens, and the order results are owed. Pinned
/// by `fixtures/search-rows.json`; the TypeScript port
/// (`packages/contracts/src/search.ts`) reads the same file.
///
/// Every search field is the palette's query with a fixed scope. The ⌘K
/// palette asks with every kind; a per-surface field (Work, Team, Calendar,
/// Docs) asks with its own. No surface keeps a matcher of its own.
enum Search {
    static let kinds: [SearchKind] = SearchKind.allCases
    /// Things. A hit's door opens the thing.
    static let hitKinds: [SearchKind] = Array(SearchKind.allCases.prefix { $0 != .destination })
    /// Places and verbs. A door's door is the place or verb itself.
    static let doorKinds: [SearchKind] = Array(SearchKind.allCases.drop { $0 != .destination })

    /// The scope each field asks with. The table in the fixture.
    enum Scope: String, CaseIterable, Sendable {
        case palette, work, team, calendar, docs

        var kinds: [SearchKind] {
            switch self {
            case .palette: return Search.kinds
            case .work: return [.subject, .contact, .task, .issue, .goal, .decision, .milestone, .call, .core, .document]
            case .team: return [.person, .agent, .thread]
            case .calendar: return [.event]
            case .docs: return [.document, .folder]
            }
        }
    }

    enum Order: String, Sendable {
        /// The matches, in the order the rows were given. A field over an
        /// in-place list thins the list; it does not reshuffle it.
        case list
        /// Tier, then recency, then kind order, then the rows' order.
        case rank
    }

    static func key(kind: SearchKind, id: String) -> String { "\(kind.rawValue):\(id)" }

    static func personVerbs(for kind: SearchKind) -> [SearchPersonVerb] {
        switch kind {
        case .person: return SearchPersonVerb.allCases
        case .agent: return [.message]
        default: return []
        }
    }

    /// An event or a partner takes tasks only.
    static func subjectVerbs(for kind: SearchSubjectKind) -> [SearchSubjectVerb] {
        switch kind {
        case .project, .lead: return SearchSubjectVerb.allCases
        case .event, .organization: return [.newTask]
        }
    }

    /// The verbs behind a row: a person's, or a subject's by the kind its door names.
    static func rowVerbs(for row: SearchRow) -> [SearchRowVerb] {
        if case .subject(let kind, _) = row.door { return subjectVerbs(for: kind).map(SearchRowVerb.subject) }
        return personVerbs(for: row.kind).map(SearchRowVerb.person)
    }

    /// NORMALIZE in the fixture: case-folded, diacritic-folded.
    static func normalize(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }

    private static func words(_ normalized: String) -> [String] {
        normalized
            .split(whereSeparator: { !($0.isLetter || $0.isNumber) })
            .map(String.init)
    }

    static func tokens(_ query: String) -> [String] {
        words(normalize(query))
    }

    /// MATCH in the fixture: the row's tier, or nil when a token matches nothing.
    static func tier(title: String, subtitle: String, tokens: [String]) -> Int? {
        guard !tokens.isEmpty else { return 2 }
        let title = normalize(title)
        let titleWords = words(title)
        let subtitle = normalize(subtitle)
        var tier = 2
        for token in tokens {
            let own: Int
            if titleWords.contains(where: { $0.hasPrefix(token) }) {
                own = 2
            } else if title.contains(token) {
                own = 1
            } else if subtitle.contains(token) {
                own = 0
            } else {
                return nil
            }
            tier = min(tier, own)
        }
        return tier
    }

    /// A field that thins a list in place (decision 13) asks this per row:
    /// the same MATCH rule as `run`, with the order left to the list.
    static func matches(query: String, title: String, subtitle: String) -> Bool {
        tier(title: title, subtitle: subtitle, tokens: tokens(query)) != nil
    }

    /// The one matcher.
    /// - Parameters:
    ///   - recents: keys of the last opened hits, newest first. Per device;
    ///     never on the server. Read only for `.rank`.
    static func run(
        _ rows: [SearchRow],
        query: String,
        scope: [SearchKind],
        order: Order,
        recents: [String] = []
    ) -> [SearchRow] {
        let scope = Set(scope)
        let tokens = tokens(query)
        var matched: [(row: SearchRow, tier: Int, index: Int)] = []
        for (index, row) in rows.enumerated() where scope.contains(row.kind) {
            guard let tier = tier(title: row.title, subtitle: row.subtitle, tokens: tokens) else { continue }
            matched.append((row, tier, index))
        }
        guard order == .rank else { return matched.map(\.row) }

        var recency: [String: Int] = [:]
        for (at, key) in recents.enumerated() where recency[key] == nil {
            recency[key] = at
        }
        func recentRank(_ row: SearchRow) -> Int {
            guard row.kind.isHit else { return .max }
            return recency[row.key] ?? .max
        }
        let kindOrder = Dictionary(uniqueKeysWithValues: kinds.enumerated().map { ($1, $0) })
        matched.sort { a, b in
            if a.tier != b.tier { return a.tier > b.tier }
            let ra = recentRank(a.row), rb = recentRank(b.row)
            if ra != rb { return ra < rb }
            let ka = kindOrder[a.row.kind]!, kb = kindOrder[b.row.kind]!
            if ka != kb { return ka < kb }
            return a.index < b.index
        }
        return matched.map(\.row)
    }

    /// Push a key to the front of a recents list, once, capped.
    static func remember(_ recents: [String], _ row: SearchRow, limit: Int = 20) -> [String] {
        guard row.kind.isHit else { return recents }
        let key = row.key
        return Array(([key] + recents.filter { $0 != key }).prefix(limit))
    }
}

/// The last opened hits, per device, per workspace and per owner, as rows: a
/// recent needs its title to be drawn before any store has answered.
/// UserDefaults is per device, which is what the fixture asks for — no server
/// state — and the key carries the owner's address and the workspace, so a
/// second account or the same address in a second workspace
/// never sees the first's history. Sign-out drops every owner's.
enum SearchRecents {
    static let defaultsKeyPrefix = "meet.search.recentRows."
    /// The one key every owner shared before; dropped on first read.
    static let legacyDefaultsKey = "meet.search.recentRows"
    /// Posted after a row lands or the list is purged, so Home's Quick Access
    /// module redraws without polling UserDefaults.
    static let didChange = Notification.Name("MeetSearchRecentsDidChange")
    /// How many rows Home's Quick Access module draws. The palette ranks by the
    /// whole list; Home is a jump list, not a history.
    static let homeLimit = 8

    static func load(owner: String, defaults: UserDefaults = .standard) -> [SearchRow] {
        defaults.removeObject(forKey: legacyDefaultsKey)
        guard !owner.isEmpty else { return [] }
        let key = defaultsKey(owner: owner)
        // The owner's list from before the workspace was in the key moves
        // once, to the build's own workspace, the only one it can be from.
        let unscoped = defaultsKeyPrefix + owner
        if defaults.object(forKey: key) == nil, WorkspaceScope.active.isBuiltIn,
           let legacy = defaults.data(forKey: unscoped) {
            defaults.set(legacy, forKey: key)
            defaults.removeObject(forKey: unscoped)
        }
        guard let data = defaults.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([SearchRow].self, from: data)) ?? []
    }

    /// `meet.search.recentRows.<owner>@<webOrigin>`.
    private static func defaultsKey(owner: String) -> String {
        WorkspaceScope.active.defaultsKey(defaultsKeyPrefix + owner)
    }

    static func keys(owner: String, defaults: UserDefaults = .standard) -> [String] {
        load(owner: owner, defaults: defaults).map(\.key)
    }

    static func remember(_ row: SearchRow, owner: String, defaults: UserDefaults = .standard) {
        guard !owner.isEmpty else { return }
        let current = load(owner: owner, defaults: defaults)
        let keys = Search.remember(current.map(\.key), row)
        var byKey = Dictionary(current.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        // A row written again keeps a mark the newer write does not know:
        // a subject's channel knows its id and title, not its logo.
        if row.image == nil, let image = byKey[row.key]?.image {
            byKey[row.key] = SearchRow(kind: row.kind, id: row.id, title: row.title, subtitle: row.subtitle, door: row.door, image: image)
        } else {
            byKey[row.key] = row
        }
        let next = keys.compactMap { byKey[$0] }
        if let data = try? JSONEncoder().encode(next) {
            defaults.set(data, forKey: defaultsKey(owner: owner))
        }
        NotificationCenter.default.post(name: didChange, object: nil)
    }

    /// A record merged into another: every row of the merged id
    /// goes, and the survivor's row comes first when the client has one.
    static func replace(mergedID: String, with survivor: SearchRow?, owner: String, defaults: UserDefaults = .standard) {
        guard !owner.isEmpty else { return }
        let current = load(owner: owner, defaults: defaults)
        let kept = current.filter { $0.id != mergedID }
        if kept.count != current.count, let data = try? JSONEncoder().encode(kept) {
            defaults.set(data, forKey: defaultsKey(owner: owner))
            NotificationCenter.default.post(name: didChange, object: nil)
        }
        if let survivor { remember(survivor, owner: owner, defaults: defaults) }
    }

    /// Home's Quick Access module: the last opened things, newest first. Doors
    /// never land here (`Search.remember` refuses them), so this is the
    /// stored list, capped.
    static func homeRows(owner: String, defaults: UserDefaults = .standard) -> [SearchRow] {
        Array(load(owner: owner, defaults: defaults).prefix(homeLimit))
    }

    /// One workspace's recents, every owner's, for a sign-out of that
    /// workspace (slice G). The list from before the workspace was in the key
    /// can only be the build's own workspace's.
    static func purge(scope: WorkspaceScope = .active, defaults: UserDefaults = .standard) {
        let suffix = scope.defaultsKey("")
        for key in defaults.dictionaryRepresentation().keys
        where key.hasPrefix(defaultsKeyPrefix) && (key.hasSuffix(suffix) || (scope.isBuiltIn && !key.contains("@http"))) {
            defaults.removeObject(forKey: key)
        }
        if scope.isBuiltIn { defaults.removeObject(forKey: legacyDefaultsKey) }
        NotificationCenter.default.post(name: didChange, object: nil)
    }

    /// Every workspace's recents on this device, for a sign-out of all.
    static func purgeAll(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: legacyDefaultsKey)
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(defaultsKeyPrefix) {
            defaults.removeObject(forKey: key)
        }
        NotificationCenter.default.post(name: didChange, object: nil)
    }
}

extension SearchRow {
    /// The kind of thing a Home tile opens. Subjects use the kind in their
    /// door; other rows use the row kind (document, conversation, goal, etc.).
    var homeTypeLabel: String {
        if kind == .subject, case .subject(let subjectKind, _) = door {
            return MeetingCategoryKind.SubjectKind(rawValue: subjectKind.rawValue)?.label ?? subjectKind.rawValue
        }
        return kind.label
    }

    /// The glyph a row wears where a list has room for one: Home's Quick Access
    /// module. A subject's is its kind's, the same three Work's tiles wore.
    var symbolName: String {
        // A goal's and a decision's door is their subject's; the kind says
        // what the row is (#262).
        if kind == .goal { return "flag" }
        if kind == .decision { return "checkmark.seal" }
        if kind == .milestone { return "diamond" }
        if kind == .call { return "phone" }
        return switch door {
        case .subject(let kind, _):
            switch kind {
            case .project: "folder.fill"
            case .lead: "flag.fill"
            case .organization: "building.2.fill"
            case .event: "calendar"
            }
        case .person: "person.fill"
        case .agent: "sparkles"
        case .contact: "person.crop.square"
        case .thread: "bubble.left.fill"
        case .document: "doc.text.fill"
        case .folder: "folder.fill"
        case .event: "calendar"
        case .task: "checkmark"
        case .issue: "smallcircle.filled.circle"
        case .core: "cylinder.fill"
        case .destination: "arrow.right"
        case .settings: "gearshape.fill"
        case .verb: "bolt.fill"
        }
    }

    /// Search results that are work records use the square mark family;
    /// destinations, people, subjects and conversations remain round.
    var usesSquareMark: Bool {
        switch kind {
        case .task, .issue, .goal, .decision, .milestone: true
        default: false
        }
    }
}

// MARK: - Doors, drawn

// `SearchDestination.title` is generated from `MEMBER_SURFACES`
// (Generated/MemberSurfacesRegistry.swift): the doors are the surfaces.

// `title` of the settings pages and the verbs, and `SearchKind.label`, are
// generated from `search-values.ts` (Generated/SearchValuesRegistry.swift).

extension Search {
    /// The door rows a client draws. Each client passes what it can open:
    /// a page it has no way to draw stays out, the same way a Home module a
    /// surface cannot draw draws nothing (invariant 26).
    static func doorRows(
        destinations: [SearchDestination] = SearchDestination.allCases,
        settingsPages: [SearchSettingsPage] = SearchSettingsPage.allCases,
        verbs: [SearchVerb] = SearchVerb.allCases
    ) -> [SearchRow] {
        // A destination the switcher does not list has no door,
        // and no Docs in this workspace means no New document.
        let hasDocs = StarlingsWorkspace.active.has(.docs)
        let destinations = destinations.filter { destination in
            MemberSurface(rawValue: destination.rawValue).map { SurfaceVisibility.isVisible($0) } ?? true
        }
        let verbs = verbs.filter { $0 != .newDocument || hasDocs }
        return destinations.map {
            SearchRow(kind: .destination, id: $0.rawValue, title: $0.title, subtitle: "", door: .destination($0))
        } + settingsPages.map {
            SearchRow(kind: .settings, id: $0.rawValue, title: $0.title, subtitle: String(localized: "Settings"), door: .settings($0))
        } + verbs.map {
            SearchRow(kind: .verb, id: $0.rawValue, title: $0.title, subtitle: "", door: .verb($0))
        }
    }
}
