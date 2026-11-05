import XCTest
@testable import Starlings

/// The shared table, run against the Swift implementation. The TypeScript
/// port runs the same file (`services/control-plane/test/subject-state.test.ts`):
/// the Worker decides what INBOX carries from this rule, and the rail decides
/// what it draws from it, so the two may not disagree.
///
/// A failure here is a question about `fixtures/subject-state.json` first.
final class SubjectStateFixtureTests: XCTestCase {
    private var originalWorkspace: StarlingsWorkspace!

    override func setUp() {
        super.setUp()
        originalWorkspace = StarlingsWorkspace.active
        var workspace = StarlingsWorkspace.builtIn
        // This legacy fixture describes Envisioning; the test host may be HQ.
        workspace.name = "Envisioning"
        workspace.workspaceDefaults = nil
        StarlingsWorkspace.setActive(workspace)
    }

    override func tearDown() {
        StarlingsWorkspace.setActive(originalWorkspace)
        super.tearDown()
    }

    func testGroups() throws {
        let table = try loadTable()
        XCTAssertEqual(table.version, 3, "The fixture changed shape; re-read its rules before touching this.")
        XCTAssertFalse(table.groups.isEmpty)
        for row in table.groups {
            let group = SubjectState.group(kind: row.subject.kind, title: row.subject.title, isInternal: row.subject.isInternal)
            XCTAssertEqual(group.rawValue, row.expect, row.name)
        }
    }

    func testResolve() throws {
        let table = try loadTable()
        XCTAssertFalse(table.resolve.isEmpty)
        for row in table.resolve {
            let prefs = SubjectStatePrefs(salesEnabled: row.salesEnabled, hiddenKinds: row.hiddenKinds)
            let group = SubjectState.group(kind: row.subject.kind, title: row.subject.title, isInternal: row.subject.isInternal)
            let override = row.override.map {
                SubjectStateOverride(starred: $0.starred, muted: $0.muted)
            }
            let resolved = SubjectState.resolve(group: group, prefs: prefs, override: override)
            XCTAssertEqual(resolved.listed, row.expect.listed, "listed — \(row.name)")
            XCTAssertEqual(resolved.starred, row.expect.starred, "starred — \(row.name)")
            XCTAssertEqual(resolved.muted, row.expect.muted, "muted — \(row.name)")
        }
    }

    /// WORK_LIST: the stored JSON decodes field by field, and a field that
    /// is missing or unknown falls back alone. The decoder is the resolver
    /// here, so the raw fixture bytes are what go in.
    func testWorkListResolves() throws {
        let table = try loadTable()
        XCTAssertFalse(table.workList.isEmpty)
        for row in table.workList {
            let resolved: WorkListPreferences
            if let stored = row.stored {
                resolved = try JSONDecoder().decode(WorkListPreferences.self, from: stored)
            } else {
                resolved = .default
            }
            XCTAssertEqual(resolved.sort.rawValue, row.expect.sort, "sort — \(row.name)")
            XCTAssertEqual(resolved.group.rawValue, row.expect.group, "group — \(row.name)")
            XCTAssertEqual(resolved.starredOnly, row.expect.starredOnly, "starred_only — \(row.name)")
        }
    }

    /// ORDER: one block in one sort, the float rule included, against the
    /// same table the TypeScript port runs.
    func testWorkListOrder() throws {
        let table = try loadTable()
        XCTAssertFalse(table.workListOrder.isEmpty)
        for row in table.workListOrder {
            let now = try XCTUnwrap(ISODate.parse(row.now), row.name)
            let sort = try XCTUnwrap(WorkListSort(rawValue: row.sort), row.name)
            let subjects = row.rows.map {
                CrmSubject(
                    id: $0.id, kind: $0.kind, title: $0.title, subtitle: nil,
                    openTasks: $0.openTasks ?? 0, overdueTasks: $0.overdueTasks ?? 0,
                    lastActivityAt: $0.lastActivityAt, eventDate: $0.eventDate
                )
            }
            XCTAssertEqual(WorkList.ordered(subjects, sort: sort, now: now).map(\.id), row.expect, row.name)
        }
    }

    /// Starred first, each half in the chosen sort; starred-only narrows;
    /// grouping cuts by relationship and drops an empty group.
    func testWorkListBlocks() {
        func subject(_ id: String, _ title: String, kind: String = "project", open: Int = 0, activity: String? = nil) -> CrmSubject {
            CrmSubject(
                id: id, kind: kind, title: title, subtitle: nil,
                openTasks: open, overdueTasks: 0, hasRepo: false, isInternal: kind == "project" ? title.hasPrefix("Envisioning ") : nil,
                lastActivityAt: activity
            )
        }
        let rows = [
            subject("a", "Envisioning Meet", open: 1, activity: "2026-09-01"),
            subject("b", "Acme rollout", open: 5, activity: "2026-09-10"),
            subject("c", "Zeta", kind: "lead", open: 0, activity: "2026-09-05"),
        ]
        let starred: Set<String> = ["c"]
        let flat = WorkList.blocks(rows, prefs: .default) { starred.contains($0.id) }
        XCTAssertEqual(flat.map { $0.group }, [nil])
        XCTAssertEqual(flat[0].subjects.map(\.id), ["c", "b", "a"])

        let alpha = WorkList.blocks(rows, prefs: .init(sort: .alphabetical, group: .none, starredOnly: false)) { starred.contains($0.id) }
        XCTAssertEqual(alpha[0].subjects.map(\.id), ["c", "b", "a"])

        let busiest = WorkList.blocks(rows, prefs: .init(sort: .busiest, group: .none, starredOnly: false)) { _ in false }
        XCTAssertEqual(busiest[0].subjects.map(\.id), ["b", "a", "c"])

        let only = WorkList.blocks(rows, prefs: .init(sort: .activity, group: .none, starredOnly: true)) { starred.contains($0.id) }
        XCTAssertEqual(only[0].subjects.map(\.id), ["c"])

        let grouped = WorkList.blocks(rows, prefs: .init(sort: .activity, group: .relationship, starredOnly: false)) { starred.contains($0.id) }
        XCTAssertEqual(grouped.map { $0.group }, [.envisioning, .clients, .sales])
        XCTAssertEqual(grouped.map { $0.subjects.map(\.id) }, [["a"], ["b"], ["c"]])
    }

    /// `CrmSubject.group` is the same test the fixture pins, read off the
    /// wire row, so the rail cannot drift from the Worker on a title.
    func testSubjectGroupReadsTheSameRule() throws {
        for row in try loadTable().groups {
            let subject = CrmSubject(
                id: "s", kind: row.subject.kind, title: row.subject.title, subtitle: nil,
                openTasks: 0, overdueTasks: 0, hasRepo: false, isInternal: row.subject.isInternal
            )
            XCTAssertEqual(subject.group.rawValue, row.expect, row.name)
        }
    }

    /// The PUT body: only the keys named go out.
    func testUpdateEncoding() throws {
        func body(_ update: SubjectStateUpdate) throws -> [String: Any] {
            let data = try JSONEncoder().encode(update)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        XCTAssertEqual(try body(SubjectStateUpdate(starred: true)).keys.sorted(), ["starred"])
        let set = try body(SubjectStateUpdate(muted: true))
        XCTAssertEqual(set["muted"] as? Bool, true)
        XCTAssertNil(set["starred"])
    }

    // MARK: - The table

    private func loadTable() throws -> FixtureTable {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "subject-state", withExtension: "json"),
            "fixtures/subject-state.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(FixtureTable.self, from: Data(contentsOf: url))
    }

    private struct OrderCase: Decodable {
        struct Row: Decodable {
            let id: String
            let kind: String
            let title: String
            let openTasks: Int?
            let overdueTasks: Int?
            let lastActivityAt: String?
            let eventDate: String?

            enum CodingKeys: String, CodingKey {
                case id, kind, title
                case openTasks = "open_tasks"
                case overdueTasks = "overdue_tasks"
                case lastActivityAt = "last_activity_at"
                case eventDate = "event_date"
            }
        }

        let name: String
        let now: String
        let sort: String
        let rows: [Row]
        let expect: [String]
    }

    private struct FixtureTable: Decodable {
        let version: Int
        let groups: [GroupCase]
        let resolve: [ResolveCase]
        let workList: [WorkListCase]
        let workListOrder: [OrderCase]

        enum CodingKeys: String, CodingKey {
            case version, groups, resolve
            case workList = "work_list"
            case workListOrder = "work_list_order"
        }
    }

    private struct WorkListExpect: Decodable {
        let sort: String
        let group: String
        let starredOnly: Bool

        enum CodingKeys: String, CodingKey {
            case sort, group
            case starredOnly = "starred_only"
        }
    }

    private struct WorkListCase: Decodable {
        let name: String
        /// The stored value as raw JSON, or nil for `null`.
        let stored: Data?
        let expect: WorkListExpect

        enum CodingKeys: String, CodingKey { case name, stored, expect }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            name = try container.decode(String.self, forKey: .name)
            expect = try container.decode(WorkListExpect.self, forKey: .expect)
            if try container.decodeNil(forKey: .stored) {
                stored = nil
            } else {
                let raw = try container.decode(JSONFragment.self, forKey: .stored)
                stored = try JSONEncoder().encode(raw)
            }
        }
    }

    /// Any JSON, kept as is, so a value the contract does not know (a wrong
    /// type, an unknown name) reaches the decoder under test unchanged.
    private enum JSONFragment: Codable {
        case string(String)
        case bool(Bool)
        case number(Double)
        case object([String: JSONFragment])
        case array([JSONFragment])
        case null

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if container.decodeNil() { self = .null }
            else if let value = try? container.decode(Bool.self) { self = .bool(value) }
            else if let value = try? container.decode(Double.self) { self = .number(value) }
            else if let value = try? container.decode(String.self) { self = .string(value) }
            else if let value = try? container.decode([String: JSONFragment].self) { self = .object(value) }
            else { self = .array(try container.decode([JSONFragment].self)) }
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self {
            case .null: try container.encodeNil()
            case .bool(let value): try container.encode(value)
            case .number(let value): try container.encode(value)
            case .string(let value): try container.encode(value)
            case .object(let value): try container.encode(value)
            case .array(let value): try container.encode(value)
            }
        }
    }

    private struct FixtureSubject: Decodable {
        let kind: String
        let title: String
        let isInternal: Bool?

        enum CodingKeys: String, CodingKey {
            case kind, title
            case isInternal = "internal"
        }
    }

    private struct GroupCase: Decodable {
        let name: String
        let subject: FixtureSubject
        let expect: String
    }

    private struct FixtureOverride: Decodable {
        let starred: Bool
        let muted: Bool
    }

    private struct FixtureResolved: Decodable {
        let listed: Bool
        let starred: Bool
        let muted: Bool
    }

    private struct ResolveCase: Decodable {
        let name: String
        let salesEnabled: Bool
        let hiddenKinds: [String]?
        let subject: FixtureSubject
        let override: FixtureOverride?
        let expect: FixtureResolved

        enum CodingKeys: String, CodingKey {
            case name, subject, override, expect
            case salesEnabled = "sales_enabled"
            case hiddenKinds = "hidden_kinds"
        }
    }
}
