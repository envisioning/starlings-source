import XCTest
@testable import Starlings

/// The organization edge on a subject row (meet#147 slice 1, core#142), and
/// the one rule for "is this an Envisioning project": Core's flag when it is
/// there, the title prefix only when it is not.
final class CrmSubjectOrganizationTests: XCTestCase {
    private func decode(_ json: String) throws -> CrmSubject {
        try JSONDecoder().decode(CrmSubject.self, from: Data(json.utf8))
    }

    func testDecodesTheOrganizationEdge() throws {
        let subject = try decode("""
        {"id":"p1","kind":"project","title":"Acme rollout","subtitle":null,
         "organization_id":"org-1","organization_name":"Acme","internal":false}
        """)
        XCTAssertEqual(subject.organizationID, "org-1")
        XCTAssertEqual(subject.organizationName, "Acme")
        XCTAssertEqual(subject.isInternal, false)
    }

    func testARowWithoutTheEdgeStillDecodes() throws {
        // A Core that predates core#142, or a row built from a meeting filing.
        let subject = try decode("""
        {"id":"l1","kind":"lead","title":"Acme","subtitle":null}
        """)
        XCTAssertNil(subject.organizationID)
        XCTAssertNil(subject.organizationName)
        XCTAssertNil(subject.isInternal)
    }

    func testTheFlagDecidesWhenCoreSendsIt() throws {
        let internalWithoutPrefix = try decode("""
        {"id":"p1","kind":"project","title":"Meet","subtitle":null,"internal":true}
        """)
        XCTAssertTrue(internalWithoutPrefix.isInternalProject)
        // The title is left whole: there is no redundant prefix to drop.
        XCTAssertEqual(internalWithoutPrefix.displayTitle, "Meet")

        let externalWithPrefix = try decode("""
        {"id":"p2","kind":"project","title":"Envisioning for Acme","subtitle":null,"internal":false}
        """)
        XCTAssertFalse(externalWithPrefix.isInternalProject)
        XCTAssertEqual(externalWithPrefix.displayTitle, "Envisioning for Acme")
    }

    func testThePrefixIsOnlyTheFallback() throws {
        let original = StarlingsWorkspace.active
        defer { StarlingsWorkspace.setActive(original) }
        var workspace = StarlingsWorkspace.builtIn
        workspace.name = "Envisioning"
        workspace.workspaceDefaults = nil
        StarlingsWorkspace.setActive(workspace)
        let legacy = try decode("""
        {"id":"p3","kind":"project","title":"Envisioning Meet","subtitle":null}
        """)
        XCTAssertTrue(legacy.isInternalProject)
        // The prefix matches this workspace's own group (meet#866).
        XCTAssertEqual(legacy.displayTitle, "Meet")

        let lead = try decode("""
        {"id":"l2","kind":"lead","title":"Envisioning Meet","subtitle":null,"internal":true}
        """)
        // Never a lead, whatever the title or a stray flag says.
        XCTAssertFalse(lead.isInternalProject)
    }
}
