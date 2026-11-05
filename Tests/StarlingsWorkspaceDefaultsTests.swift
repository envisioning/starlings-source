import XCTest
@testable import Starlings

final class StarlingsWorkspaceDefaultsTests: XCTestCase {
    func testSharedPresentationCases() throws {
        let original = StarlingsWorkspace.active
        defer { StarlingsWorkspace.setActive(original) }
        let url = try XCTUnwrap(Bundle(for: type(of: self)).url(forResource: "workspace-defaults", withExtension: "json"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        for row in fixture.cases {
            var workspace = StarlingsWorkspace.builtIn
            workspace.name = "HQ"
            workspace.workspaceDefaults = row.defaults
            StarlingsWorkspace.setActive(workspace)
            XCTAssertEqual(StarlingsScheduleTimeZone.offered.map(\.rawValue), row.zones, row.name)
            XCTAssertEqual(StarlingsLanguage.offered.map(\.rawValue), row.languages, row.name)
            XCTAssertEqual(workspace.projectGroupName, row.group, row.name)
            let project = CrmSubject(id: "own", kind: "project", title: "\(row.group) Roadmap", subtitle: nil)
            XCTAssertTrue(project.isInternalProject, row.name)
            XCTAssertEqual(project.displayTitle, "Roadmap", row.name)
            XCTAssertEqual(SubjectState.group(kind: "project", title: project.title, isInternal: false), .clients, row.name)
            XCTAssertEqual(StarlingsLanguage.resolveChoice(StarlingsLanguage.resolve(row.choice), device: StarlingsLanguage.resolve(row.device)!), row.language, row.name)
        }
    }

    func testAnOlderStoredWorkspaceStillDecodesAndKeepsItsDefaults() throws {
        let workspace = try JSONDecoder().decode(StarlingsWorkspace.self, from: Data(#"{"webOrigin":"https://hq.starlings.example","apiOrigin":"https://hq.starlings.example","name":"HQ"}"#.utf8))
        XCTAssertNil(workspace.workspaceDefaults)
        XCTAssertEqual(workspace.projectGroupName, "HQ")
    }

    #if os(macOS)
    func testWorkspaceSpellingFallbackPreservesExplicitSpokenLanguages() {
        XCTAssertEqual(StarlingsSpellChecker.codes(for: .undetermined, spoken: [.portuguese], offered: [.english]), ["pt_BR", "pt"])
        XCTAssertEqual(StarlingsSpellChecker.codes(for: .undetermined, spoken: [], offered: [.english]), ["en"])
        XCTAssertEqual(StarlingsSpellChecker.codes(for: .english, spoken: [], offered: [.portuguese]), ["en"])
    }
    #endif

    private struct Fixture: Decodable { let cases: [Case] }
    private struct Case: Decodable {
        let name: String
        let defaults: WorkspaceClientDefaults?
        let choice: String?
        let device: String
        let zones: [String]
        let languages: [String]
        let language: String
        let group: String
    }
}
