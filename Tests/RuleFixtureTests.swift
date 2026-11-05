import XCTest
@testable import Starlings

/// Small rules the Mac, iOS and web each write for themselves, and the
/// cases that make them one rule (meet#596, #1065). The web runs the same files
/// (`web/src/rule-fixtures.test.ts`). A failure here is a question about the
/// fixture first: the cases are the rule, and both implementations answer to
/// them. `docs/agents/areas/registries.md`, "Rules with cases".
final class RuleFixtureTests: XCTestCase {
    // MARK: Docs folder slug

    func testDocsSlugMatchesTheFixture() throws {
        let table = try load(Slugs.self, "docs-slug")
        XCTAssertEqual(table.version, 1)
        XCTAssertFalse(table.cases.isEmpty)
        for row in table.cases {
            XCTAssertEqual(DocsRailGroups.slug(row.title), row.slug, row.name)
        }
        for row in table.folders {
            XCTAssertEqual(DocsRailGroups.folderPath(kind: row.kind, title: row.title), row.path, row.name)
        }
    }

    // MARK: Initials

    func testParticipantInitialsMatchTheFixture() throws {
        let table = try load(Initials.self, "participant-initials")
        XCTAssertEqual(table.version, 1)
        XCTAssertFalse(table.cases.isEmpty)
        for row in table.cases {
            XCTAssertEqual(ParticipantInitials.make(from: row.in), row.out, row.name)
        }
    }

    // MARK: Thread markdown

    func testThreadMarkdownMatchesTheFixture() throws {
        let table = try load(Markdown.self, "thread-markdown")
        XCTAssertEqual(table.version, 1)
        XCTAssertFalse(table.cases.isEmpty)
        for row in table.cases {
            XCTAssertEqual(ThreadMarkdown.parse(row.in).map { MarkdownBlock($0) }, row.out, row.name)
        }
    }

    // MARK: Subject page query

    func testSubjectQueryMatchesTheFixture() throws {
        let table = try load(Queries.self, "subject-query")
        XCTAssertEqual(table.version, 1)
        XCTAssertFalse(table.cases.isEmpty)
        for row in table.cases {
            let kind = try XCTUnwrap(MeetingCategoryKind.SubjectKind(rawValue: row.kind), row.name)
            let organizations = row.organizations.map {
                OrganizationListFilter(partner: $0.partner, agency: $0.agency, existingClient: $0.existingClient, industry: $0.industry, country: $0.country)
            }
            let items = CrmSubjectsQuery.browse(kind: kind, query: row.query, status: row.status, today: row.today, organizations: organizations).queryItems
            XCTAssertEqual(items.map { [$0.name, $0.value ?? ""] }, row.out, row.name)
        }
    }

    // MARK: Contact list query (meet#1213)

    func testContactQueryMatchesTheFixture() throws {
        let table = try load(ContactQueries.self, "contact-query")
        XCTAssertEqual(table.version, 1)
        XCTAssertFalse(table.cases.isEmpty)
        for row in table.cases {
            let filter = ContactListFilter(
                organizationID: row.filter.organizationID,
                country: row.filter.country,
                partner: row.filter.partner,
                existingClient: row.filter.existingClient,
                signalsOutreachStatus: row.filter.signalsOutreachStatus.map(CrmContactsQuerySignalsOutreachStatus.init(rawValue:)),
                preferredLanguage: row.filter.preferredLanguage
            )
            let items = CrmContactsQuery.list(query: row.query, filter: filter).queryItems
            XCTAssertEqual(items.map { [$0.name, $0.value ?? ""] }, row.out, row.name)
        }
    }

    // MARK: Mention recipients

    func testMentionRecipientsMatchTheFixture() throws {
        let table = try load(MentionCases.self, "mention-matching")
        XCTAssertEqual(table.version, 1)
        XCTAssertFalse(table.cases.isEmpty)
        for row in table.cases {
            let candidates = row.candidates.map(MentionMatching.Candidate.init(email:))
            XCTAssertEqual(MentionMatching.mentions(in: row.text, candidates: candidates), row.mentions, row.name)
        }
    }

    // MARK: Transcript export

    /// meet#692: the file and the link, the same on every client.
    func testTranscriptExportMatchesTheFixture() throws {
        let table = try load(TranscriptExports.self, "transcript-export")
        XCTAssertEqual(table.version, 1)
        XCTAssertFalse(table.cases.isEmpty)
        for row in table.permalinks {
            XCTAssertEqual(TranscriptExport.permalink(origin: row.origin, room: row.room, meetingID: row.meetingID), row.out, row.name)
        }
        for row in table.clocks {
            XCTAssertEqual(TranscriptExport.clock(row.ms), row.out, "clock \(row.ms)")
        }
        for row in table.fileNames {
            let format = try XCTUnwrap(TranscriptExport.Format(rawValue: row.format), row.name)
            XCTAssertEqual(
                TranscriptExport.fileName(title: row.title, startedAt: row.startedAt, timeZone: row.timeZone, format: format),
                row.out,
                row.name
            )
        }
        for row in table.cases {
            let input = row.input.export
            XCTAssertEqual(TranscriptExport.attendees(input), row.attendees, row.name)
            XCTAssertEqual(TranscriptExport.format(input, as: .markdown), row.md, row.name)
            XCTAssertEqual(TranscriptExport.format(input, as: .text), row.txt, row.name)
        }
    }

    // MARK: Member surface visibility

    func testSurfaceVisibilityMatchesTheFixture() throws {
        let table = try load(SurfaceCases.self, "surface-visibility")
        XCTAssertEqual(table.version, 1)
        XCTAssertFalse(table.cases.isEmpty)
        for row in table.cases {
            let visible = SurfaceVisibility.visible(calendarSources: row.calendarSources, docs: row.docs)
            XCTAssertEqual(visible.map(\.rawValue), row.visible, row.name)
        }
    }

    // MARK: Loading

    private func load<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        let url = try XCTUnwrap(
            Bundle(for: Self.self).url(forResource: name, withExtension: "json"),
            "fixtures/\(name).json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
    }

    private struct Slugs: Decodable {
        struct Case: Decodable { let name: String; let title: String; let slug: String }
        struct Folder: Decodable { let name: String; let kind: String; let title: String; let path: String }
        let version: Int
        let cases: [Case]
        let folders: [Folder]
    }

    private struct Initials: Decodable {
        struct Case: Decodable { let name: String; let `in`: String; let out: String }
        let version: Int
        let cases: [Case]
    }

    private struct TranscriptExports: Decodable {
        struct Permalink: Decodable {
            let name: String
            let origin: String
            let room: String
            let meetingID: String
            let out: String
            enum CodingKeys: String, CodingKey { case name, origin, room, out, meetingID = "meeting_id" }
        }
        struct Clock: Decodable { let ms: Int64; let out: String }
        struct FileName: Decodable {
            let name: String
            let title: String
            let startedAt: Int64
            let timeZone: String?
            let format: String
            let out: String
            enum CodingKeys: String, CodingKey { case name, title, format, out, startedAt = "started_at", timeZone = "time_zone" }
        }
        struct Line: Decodable {
            let id: String
            let speakerID: String
            let speakerName: String
            let startsAtMs: Int64
            let text: String
            enum CodingKeys: String, CodingKey {
                case id, text
                case speakerID = "speaker_id", speakerName = "speaker_name", startsAtMs = "starts_at_ms"
            }
        }
        struct Input: Decodable {
            let title: String
            let startedAt: Int64
            let timeZone: String?
            let subject: String?
            let attendees: [String]?
            let link: String?
            let lines: [Line]
            let struck: [String]?
            let renames: [String: String]?
            enum CodingKeys: String, CodingKey {
                case title, subject, attendees, link, lines, struck, renames
                case startedAt = "started_at", timeZone = "time_zone"
            }

            var export: TranscriptExport.Input {
                TranscriptExport.Input(
                    title: title,
                    startedAt: startedAt,
                    timeZone: timeZone,
                    subject: subject,
                    attendees: attendees ?? [],
                    link: link,
                    lines: lines.map {
                        TranscriptExport.Line(id: $0.id, speakerID: $0.speakerID, speakerName: $0.speakerName, startsAtMilliseconds: $0.startsAtMs, text: $0.text)
                    },
                    struck: Set(struck ?? []),
                    renames: renames ?? [:]
                )
            }
        }
        struct Case: Decodable { let name: String; let input: Input; let attendees: [String]; let md: String; let txt: String }
        let version: Int
        let permalinks: [Permalink]
        let clocks: [Clock]
        let fileNames: [FileName]
        let cases: [Case]
        enum CodingKeys: String, CodingKey { case version, permalinks, clocks, cases, fileNames = "file_names" }
    }

    private struct ContactQueries: Decodable {
        struct Case: Decodable {
            let name: String
            let query: String
            let filter: Filter
            let out: [[String]]
        }
        struct Filter: Decodable {
            let organizationID: String?
            let country: String?
            let partner: Bool
            let existingClient: Bool
            let signalsOutreachStatus: String?
            let preferredLanguage: String?

            enum CodingKeys: String, CodingKey {
                case country, partner
                case organizationID = "organization_id"
                case existingClient = "existing_client"
                case signalsOutreachStatus = "signals_outreach_status"
                case preferredLanguage = "preferred_language"
            }
        }
        let version: Int
        let cases: [Case]
    }

    private struct Queries: Decodable {
        struct Case: Decodable {
            let name: String
            let kind: String
            let query: String
            let status: String?
            let today: String?
            let organizations: Organizations?
            let out: [[String]]
        }
        struct Organizations: Decodable {
            let partner: Bool
            let agency: Bool
            let existingClient: Bool
            let industry: String?
            let country: String?

            enum CodingKeys: String, CodingKey {
                case partner, agency, industry, country
                case existingClient = "existing_client"
            }
        }
        let version: Int
        let cases: [Case]
    }

    private struct MentionCases: Decodable {
        struct Case: Decodable {
            let name: String
            let text: String
            let candidates: [String]
            let mentions: [String]
        }
        let version: Int
        let cases: [Case]
    }

    private struct Markdown: Decodable {
        struct Case: Decodable { let name: String; let `in`: String; let out: [MarkdownBlock] }
        let version: Int
        let cases: [Case]
    }

    /// A block the way the fixture writes it: the marks that are on, and the
    /// level / number / code text only where the kind has one.
    private struct MarkdownBlock: Decodable, Equatable {
        struct Span: Decodable, Equatable {
            var text: String
            var bold = false
            var italic = false
            var strike = false
            var code = false
            var link: String?

            init(_ span: ThreadMarkdown.Span) {
                text = span.text
                bold = span.bold
                italic = span.italic
                strike = span.strike
                code = span.code
                link = span.link
            }

            init(from decoder: Decoder) throws {
                let values = try decoder.container(keyedBy: Keys.self)
                text = try values.decode(String.self, forKey: .text)
                bold = try values.decodeIfPresent(Bool.self, forKey: .bold) ?? false
                italic = try values.decodeIfPresent(Bool.self, forKey: .italic) ?? false
                strike = try values.decodeIfPresent(Bool.self, forKey: .strike) ?? false
                code = try values.decodeIfPresent(Bool.self, forKey: .code) ?? false
                link = try values.decodeIfPresent(String.self, forKey: .link)
            }

            private enum Keys: String, CodingKey { case text, bold, italic, strike, code, link }
        }

        var kind: String
        var level: Int?
        var number: Int?
        var text: String?
        var spans: [Span]?

        init(_ block: ThreadMarkdown.Block) {
            let spans = block.spans.map(Span.init)
            switch block.kind {
            case .paragraph: (kind, self.spans) = ("paragraph", spans)
            case .quote: (kind, self.spans) = ("quote", spans)
            case .heading(let level): (kind, self.level, self.spans) = ("heading", level, spans)
            case .bullet(let level): (kind, self.level, self.spans) = ("bullet", level, spans)
            case .ordered(let level, let number): (kind, self.level, self.number, self.spans) = ("ordered", level, number, spans)
            case .code(let value): (kind, text) = ("code", value)
            }
        }
    }

    private struct SurfaceCases: Decodable {
        struct Row: Decodable {
            let name: String
            let calendarSources: Bool?
            let docs: Bool
            let visible: [String]
        }
        let version: Int
        let cases: [Row]
    }
}
