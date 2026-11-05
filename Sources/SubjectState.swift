import Foundation

// Per-user subject state: star and mute ( decision 5; follow removed
// 2026-09-15). The Swift port of `packages/contracts/src/subject-state.ts`,
// pinned by `fixtures/subject-state.json` — both implementations answer to
// that file.
//
// The Worker stores overrides only. A subject nobody has said anything about
// is plain. The active rail is ranked separately from this state; the only
// gate here that is not a per-subject opinion is the SALES opt-in, which hides
// leads for a person who has not turned Sales on.

/// The four groups of the SUBJECTS zone. A subject is in exactly one.
enum SubjectGroup: String, CaseIterable, Codable, Hashable, Sendable {
    case envisioning
    case clients
    case partners
    case events
    case sales

    /// The rail header for the group.
    var title: String {
        switch self {
        // The workspace's own projects, under its own name.
        case .envisioning: StarlingsWorkspace.active.projectGroupName.uppercased()
        case .clients: "CLIENTS"
        case .partners: "ORGANIZATIONS"
        case .events: "EVENTS"
        case .sales: "LEADS"
        }
    }
}

/// Preferences that are not about one subject.
struct SubjectStatePrefs: Equatable, Sendable {
    let salesEnabled: Bool
    /// The subject kinds this person hides. When present it
    /// decides, leads included; nil (an older Worker) hides leads while
    /// Sales is off.
    var hiddenKinds: [String]? = nil
}

/// One stored override.
struct SubjectStateOverride: Equatable, Sendable {
    var starred: Bool
    var muted: Bool

    /// True when the row says nothing — the Worker deletes such a row rather
    /// than keep it.
    var isDefault: Bool { !starred && !muted }
}

/// A stored override as `GET /api/crm/subject-state` returns it.
/// One subject's stored state as Work reads it; the generated `SubjectStateRow`
/// is the wire, this is the app's (`kind` as the string every key uses).
struct SubjectStateRow: Decodable, Equatable, Sendable {
    let kind: String
    let id: String
    let starred: Bool
    let muted: Bool
    let updatedAt: Int

    init(wire: StarlingsContracts.SubjectStateRow) {
        self.init(kind: wire.kind.rawValue, id: wire.id, starred: wire.starred, muted: wire.muted, updatedAt: wire.updatedAt)
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try StarlingsContracts.SubjectStateRow(from: decoder))
    }

    init(kind: String, id: String, starred: Bool, muted: Bool, updatedAt: Int = 0) {
        self.kind = kind
        self.id = id
        self.starred = starred
        self.muted = muted
        self.updatedAt = updatedAt
    }

    var override: SubjectStateOverride {
        SubjectStateOverride(starred: starred, muted: muted)
    }

    /// The key a client files the row under: one per subject, never per kind
    /// alone — a lead and the project it became have different ids.
    var subjectKey: String { SubjectState.key(kind: kind, id: id) }
}

/// What a client draws for one subject.
struct ResolvedSubjectState: Equatable, Sendable {
    /// On the rail and read by INBOX: not muted, and not a lead while Sales
    /// is off.
    let listed: Bool
    let starred: Bool
    let muted: Bool

    /// Nothing said: the state of a row nobody has touched.
    static let plain = ResolvedSubjectState(listed: true, starred: false, muted: false)
}

/// How the SUBJECTS list is ordered (`WorkListPreferences.sort`).
enum WorkListSort: String, CaseIterable, Codable, Sendable {
    case activity, upcoming, busiest, alphabetical

    var title: String {
        switch self {
        case .activity: String(localized: "Last activity")
        case .upcoming: String(localized: "Upcoming first")
        case .busiest: String(localized: "Busiest first")
        case .alphabetical: String(localized: "Alphabetical")
        }
    }
}

/// How the SUBJECTS list is split (`WorkListPreferences.group`).
enum WorkListGroup: String, CaseIterable, Codable, Sendable {
    case none, relationship

    var title: String {
        switch self {
        case .none: String(localized: "None")
        case .relationship: String(localized: "Relationship")
        }
    }
}

/// How the SUBJECTS list is ordered and cut — one answer for the Mac rail,
/// the iOS list and the web rail, stored per person behind
/// `PATCH /api/crm/subject-state` (`work_list`) and pinned by the fixture.
///
/// Starred rows always lead; `sort` orders within starred and within the
/// rest. `group` splits by relationship or not at all. `starredOnly`
/// narrows to what is starred. Mute and the SALES opt-in are membership,
/// decided by `SubjectState.resolve` before any of this applies.
struct WorkListPreferences: Codable, Equatable, Sendable {
    var sort: WorkListSort
    var group: WorkListGroup
    var starredOnly: Bool

    static let `default` = WorkListPreferences(sort: .activity, group: .none, starredOnly: false)

    var isDefault: Bool { self == .default }

    init(sort: WorkListSort, group: WorkListGroup, starredOnly: Bool) {
        self.sort = sort
        self.group = group
        self.starredOnly = starredOnly
    }

    /// WORK_LIST in the fixture: field by field, a missing or unknown value
    /// falls back alone and the other fields keep what was stored.
    /// A sort or group this build has not heard of reads as the default,
    /// never as a list that fails to draw.
    init(wire: WorkListPreferencesWire) {
        self.init(
            sort: WorkListSort(rawValue: wire.sort.rawValue) ?? Self.default.sort,
            group: WorkListGroup(rawValue: wire.group.rawValue) ?? Self.default.group,
            starredOnly: wire.starredOnly
        )
    }

    /// The preferences as the wire carries them, for a write.
    var wire: WorkListPreferencesWire {
        WorkListPreferencesWire(sort: .init(rawValue: sort.rawValue), group: .init(rawValue: group.rawValue), starredOnly: starredOnly)
    }

    /// RESOLVE in `fixtures/subject-state.json`: a stored row may be partial
    /// or name a sort this build does not know, and each field falls back
    /// alone. The wire response is whole; this is for what a device stored.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sort = (try? container.decodeIfPresent(WorkListSort.self, forKey: .sort)) ?? Self.default.sort
        group = (try? container.decodeIfPresent(WorkListGroup.self, forKey: .group)) ?? Self.default.group
        starredOnly = (try? container.decodeIfPresent(Bool.self, forKey: .starredOnly)) ?? Self.default.starredOnly
    }

    private enum CodingKeys: String, CodingKey {
        case sort, group
        case starredOnly = "starred_only"
    }

    func encode(to encoder: Encoder) throws {
        try wire.encode(to: encoder)
    }
}

/// One run of the SUBJECTS list as `WorkList.blocks` cuts it: every row
/// under one relationship, or the whole list when nothing is grouped.
struct WorkListBlock: Equatable, Sendable {
    /// Nil when the list is not grouped.
    let group: SubjectGroup?
    let subjects: [CrmSubject]
}

enum WorkList {
    /// The SUBJECTS list, arranged. `subjects` are the listed rows — mute
    /// and Sales already applied. Starred first inside every block, each
    /// half in `prefs.sort`; grouped blocks come in `SubjectGroup` order and
    /// an empty group is not a block.
    static func blocks(
        _ subjects: [CrmSubject],
        prefs: WorkListPreferences,
        now: Date = Date(),
        isStarred: (CrmSubject) -> Bool
    ) -> [WorkListBlock] {
        let kept = prefs.starredOnly ? subjects.filter(isStarred) : subjects
        func arranged(_ rows: [CrmSubject]) -> [CrmSubject] {
            let starred = rows.filter(isStarred)
            let rest = rows.filter { !isStarred($0) }
            return ordered(starred, sort: prefs.sort, now: now) + ordered(rest, sort: prefs.sort, now: now)
        }
        switch prefs.group {
        case .none:
            return [WorkListBlock(group: nil, subjects: arranged(kept))]
        case .relationship:
            return SubjectGroup.allCases.compactMap { group in
                let rows = kept.filter { $0.group == group }
                return rows.isEmpty ? nil : WorkListBlock(group: group, subjects: arranged(rows))
            }
        }
    }
}

extension WorkList {
    /// How far ahead an event starts to float (docs/EVENTS.md). Beyond this
    /// it is only where its talk and tasks put it; inside it, each day
    /// closer is a day higher, and on the day it reads as touched now.
    static let eventFloatHorizonDays = 30

    private static let day: TimeInterval = 86_400

    /// A plain `YYYY-MM-DD` as UTC midnight, with no zone to apply.
    private static func eventDate(_ raw: String?) -> Date? {
        guard let raw, raw.count >= 10 else { return nil }
        let parts = raw.prefix(10).split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, let year = Int(parts[0]), let month = Int(parts[1]), let dayOfMonth = Int(parts[2]) else { return nil }
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        return utc.date(from: DateComponents(year: year, month: month, day: dayOfMonth))
    }

    /// FLOAT in the fixture: `now - daysUntil days` for a dated event from
    /// today out to the horizon; nil past, undated or farther. Civil days
    /// in UTC on purpose: the key only orders rows, and every client must
    /// compute the same one.
    static func eventFloat(_ subject: CrmSubject, now: Date) -> Date? {
        guard subject.isEvent, let date = eventDate(subject.eventDate) else { return nil }
        let daysUntil = Int((date.timeIntervalSince1970 / day).rounded(.down)) - Int((now.timeIntervalSince1970 / day).rounded(.down))
        guard daysUntil >= 0, daysUntil <= eventFloatHorizonDays else { return nil }
        return now.addingTimeInterval(-Double(daysUntil) * day)
    }

    /// ACTIVITY: the later of what moved and where the date floats it.
    static func activityKey(_ subject: CrmSubject, now: Date) -> Date? {
        // Core sends an instant; a plain date still orders.
        let moved = subject.lastActivityAt.flatMap { ISODate.parse($0) ?? eventDate($0) }
        let floated = eventFloat(subject, now: now)
        switch (moved, floated) {
        case (let m?, let f?): return Swift.max(m, f)
        case (let m?, nil): return m
        case (nil, let f?): return f
        case (nil, nil): return nil
        }
    }

    /// One block in one sort — `sortByWorkList` in the contract, pinned by
    /// `work_list_order` in `fixtures/subject-state.json`.
    static func ordered(_ rows: [CrmSubject], sort: WorkListSort, now: Date) -> [CrmSubject] {
        let busiest = rows.sorted(bySidebarOption: CrmSubjectSortOption.busiest.id)
        func byActivity(_ list: [CrmSubject]) -> [CrmSubject] {
            let keyed = list.map { ($0, activityKey($0, now: now)) }
            let dated = keyed.filter { $0.1 != nil }.sorted { ($0.1 ?? .distantPast) > ($1.1 ?? .distantPast) }
            let undated = keyed.filter { $0.1 == nil }
            return (dated + undated).map(\.0)
        }
        switch sort {
        case .alphabetical:
            return rows.sorted(bySidebarOption: CrmSubjectSortOption.alphabetical.id)
        case .busiest:
            return busiest
        case .activity:
            return byActivity(busiest)
        case .upcoming:
            let today = (now.timeIntervalSince1970 / day).rounded(.down)
            func isUpcoming(_ subject: CrmSubject) -> Bool {
                guard subject.isEvent, let date = eventDate(subject.eventDate) else { return false }
                return (date.timeIntervalSince1970 / day).rounded(.down) >= today
            }
            let events = busiest.filter(isUpcoming).sorted { a, b in
                let ad = eventDate(a.eventDate) ?? .distantPast
                let bd = eventDate(b.eventDate) ?? .distantPast
                if ad != bd { return ad < bd }
                return a.title.localizedCaseInsensitiveCompare(b.title) == .orderedAscending
            }
            return events + byActivity(busiest.filter { !isUpcoming($0) })
        }
    }
}

/// `GET /api/crm/subject-state`.
struct SubjectStateResponse: Decodable, Equatable, Sendable {
    let role: String
    let salesEnabled: Bool
    let workList: WorkListPreferences
    /// Which INBOX sources this person turned on or off — overrides only;
    /// `InboxSourceSpec.resolve` fills in the rest.
    let inboxSources: [String: Bool]
    /// Source kinds this account may receive; Settings filters by it.
    let inboxAvailableSources: [String]
    /// The subject kinds this person hides; nil from an older Worker.
    let hiddenKinds: [String]?
    /// The work modules this workspace has on (docs/WORK_MODEL.md); nil from
    /// a Worker older than them, read as every work module on.
    let workModules: [WorkModule]?
    /// The Board columns this person hides; empty from an older Worker.
    let boardHiddenStages: Set<WorkStage>
    let states: [SubjectStateRow]

    init(wire: SubjectStateResponseWire) {
        self.init(
            role: wire.role,
            salesEnabled: wire.salesEnabled,
            hiddenKinds: wire.hiddenKinds?.map(\.rawValue),
            workList: WorkListPreferences(wire: wire.workList),
            inboxSources: Dictionary(uniqueKeysWithValues: wire.inboxSources.map { ($0.key, $0.value) }),
            inboxAvailableSources: wire.inboxAvailableSources.map(\.rawValue),
            workModules: wire.workModules.map { $0.compactMap { WorkModule(rawValue: $0.rawValue) } },
            boardHiddenStages: Set((wire.boardHiddenStages ?? []).compactMap { WorkStage(rawValue: $0.rawValue) }),
            states: wire.states.map(SubjectStateRow.init(wire:))
        )
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try SubjectStateResponseWire(from: decoder))
    }

    init(role: String, salesEnabled: Bool, hiddenKinds: [String]? = nil, workList: WorkListPreferences = .default, inboxSources: [String: Bool] = [:], inboxAvailableSources: [String]? = nil, workModules: [WorkModule]? = nil, boardHiddenStages: Set<WorkStage> = [], states: [SubjectStateRow]) {
        self.role = role
        self.salesEnabled = salesEnabled
        self.hiddenKinds = hiddenKinds
        self.workList = workList
        self.inboxSources = inboxSources
        self.inboxAvailableSources = inboxAvailableSources ?? InboxSourceSpec.all.map(\.source)
        self.workModules = workModules
        self.boardHiddenStages = boardHiddenStages
        self.states = states
    }

    /// Before the Worker has answered: nobody, Sales off, nothing said. A
    /// rail drawn from this shows every subject it has, because hiding rows
    /// on a guess would be worse than a rail that fills in a moment later.
    static let unknown = SubjectStateResponse(role: "", salesEnabled: false, states: [])

    var prefs: SubjectStatePrefs { SubjectStatePrefs(salesEnabled: salesEnabled, hiddenKinds: hiddenKinds) }

    /// The same answer with the list preferences swapped: what a client
    /// draws the moment a menu is used, before the Worker has agreed.
    func with(workList: WorkListPreferences) -> SubjectStateResponse {
        SubjectStateResponse(role: role, salesEnabled: salesEnabled, hiddenKinds: hiddenKinds, workList: workList, inboxSources: inboxSources, inboxAvailableSources: inboxAvailableSources, workModules: workModules, boardHiddenStages: boardHiddenStages, states: states)
    }

    /// The same answer with the INBOX sources swapped, for the switch that
    /// moves before the Worker has agreed.
    func with(inboxSources: [String: Bool]) -> SubjectStateResponse {
        SubjectStateResponse(role: role, salesEnabled: salesEnabled, hiddenKinds: hiddenKinds, workList: workList, inboxSources: inboxSources, inboxAvailableSources: inboxAvailableSources, workModules: workModules, boardHiddenStages: boardHiddenStages, states: states)
    }

    /// The same answer with the Board's hidden columns swapped, for the menu
    /// that moves before the Worker has agreed.
    func with(boardHiddenStages: Set<WorkStage>) -> SubjectStateResponse {
        SubjectStateResponse(role: role, salesEnabled: salesEnabled, hiddenKinds: hiddenKinds, workList: workList, inboxSources: inboxSources, inboxAvailableSources: inboxAvailableSources, workModules: workModules, boardHiddenStages: boardHiddenStages, states: states)
    }
}

/// `PUT /api/crm/subject-state/{kind}/{id}` is the generated
/// `SubjectStateUpdate` — only the keys sent change.
extension SubjectStateUpdate {
    /// The override as it will read once applied over `current`.
    func applied(to current: SubjectStateOverride) -> SubjectStateOverride {
        var next = current
        if let starred { next.starred = starred }
        if let muted { next.muted = muted }
        return next
    }
}

/// `PUT /api/crm/subject-state/{kind}/{id}` response: the row as stored, or
/// nil when it said nothing and was deleted.
struct SubjectStateUpdateResponse: Decodable, Sendable {
    let state: SubjectStateRow?

    init(from decoder: Decoder) throws {
        state = try SubjectStateUpdateResponseWire(from: decoder).state.map(SubjectStateRow.init(wire:))
    }
}

// `PATCH /api/crm/subject-state` is the generated `WorkPreferencesUpdate` —
// only the keys sent change; `inboxSources` goes whole and replaces the map.

/// The rule, in one place. Same test on every client.
enum SubjectState {
    static func key(kind: String, id: String) -> String { "\(kind):\(id)" }

    /// Which group a subject belongs to. partner → partners, lead → sales; a
    /// project is envisioning on Core's `internal` flag when present, and
    /// only when the flag is absent on the "Envisioning " title prefix.
    /// `internal: false` is external whatever the title says.
    static func group(kind: String, title: String, isInternal: Bool?) -> SubjectGroup {
        switch MeetingCategoryKind.SubjectKind(rawValue: kind) {
        case .organization: return .partners
        case .event: return .events
        case .lead: return .sales
        case .project, nil:
            let flagged = isInternal ?? title.hasPrefix("\(StarlingsWorkspace.active.projectGroupName) ")
            return flagged ? .envisioning : .clients
        }
    }

    static func resolve(
        group: SubjectGroup,
        prefs: SubjectStatePrefs,
        override: SubjectStateOverride?
    ) -> ResolvedSubjectState {
        let muted = override?.muted == true
        let kind = BrowseGroupRegistry.spec(for: group).subjectKind.rawValue
        let kindHidden = prefs.hiddenKinds.map { $0.contains(kind) } ?? (group == .sales && !prefs.salesEnabled)
        return ResolvedSubjectState(
            listed: !muted && !kindHidden,
            starred: override?.starred == true,
            muted: muted
        )
    }
}

extension CrmSubject {
    /// The rail group this subject is drawn in. Reads `SubjectState.group`,
    /// so ENVISIONING is Core's flag and never a second prefix test.
    var group: SubjectGroup {
        SubjectState.group(kind: kind, title: title, isInternal: isInternal)
    }

    var stateKey: String { SubjectState.key(kind: kind, id: id) }
}

/// Settings › Work's "Show in Work" rows: one switch per subject
/// kind, Leads being the old Sales opt-in. A client offers only the kinds
/// whose work module the workspace has on. The words match the web's.
struct ShownKindRow: Identifiable, Sendable {
    let kind: MeetingCategoryKind.SubjectKind
    let title: String
    let detail: String
    var id: String { kind.rawValue }

    static var all: [ShownKindRow] {
        [
            ShownKindRow(kind: .project, title: String(localized: "Projects"), detail: String(localized: "Projects in Browse and on your rail.")),
            ShownKindRow(kind: .lead, title: String(localized: "Leads"), detail: String(localized: "The lead pipeline in Browse, leads on your rail by default, and sales touches in INBOX.")),
            ShownKindRow(kind: .organization, title: String(localized: "Organizations"), detail: String(localized: "Organizations in Browse and on your rail.")),
            ShownKindRow(kind: .event, title: String(localized: "Events"), detail: String(localized: "Events in Browse and on your rail.")),
        ]
    }

    /// The rows this workspace offers: the kind's work module is on.
    static func offered(workModules: [WorkModule]?) -> [ShownKindRow] {
        all.filter { row in
            guard let module = WorkModule.gating(row.kind), let workModules else { return true }
            return workModules.contains(module)
        }
    }
}

extension SubjectStateResponse {
    /// The kinds this person hides; an older Worker sends only Sales.
    var resolvedHiddenKinds: [String] { hiddenKinds ?? (salesEnabled ? [] : ["lead"]) }
}
