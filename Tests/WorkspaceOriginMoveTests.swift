import Foundation
import XCTest
@testable import Starlings

/// The parts of a workspace's origin move that need no Keychain: the stamp
/// rewrite inside a stored credential, and the names things move between.
final class WorkspaceOriginMoveTests: XCTestCase {
    private let replacements = [
        "https://legacy.org.example/api": "https://envisioning.starlings.example/api",
        "https://legacy.org.example": "https://envisioning.starlings.example",
    ]

    func testAStampedCredentialMovesToTheNewEndpointAndNamesItsOwner() throws {
        let stored = try JSONSerialization.data(withJSONObject: [
            "api_endpoint": "https://legacy.org.example/api",
            "owner": ["email": "Rosa@example.com", "name": "Rosa Ortiz"],
            "expires_at": 1_790_000_000.5,
            "renewable": true,
        ])
        var emails = Set<String>()
        let moved = WorkspaceOriginMove.rewritten(stored, replacing: replacements, emails: &emails)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: moved) as? [String: Any])
        XCTAssertEqual(object["api_endpoint"] as? String, "https://envisioning.starlings.example/api")
        XCTAssertEqual((object["owner"] as? [String: Any])?["name"] as? String, "Rosa Ortiz")
        XCTAssertEqual(object["expires_at"] as? Double, 1_790_000_000.5)
        XCTAssertEqual(object["renewable"] as? Bool, true)
        XCTAssertEqual(emails, ["rosa@example.com"])
    }

    func testADeviceIDIsNotJSONAndStaysAsItIs() {
        let id = Data("3f2a9c1e-0000-4000-8000-000000000000".utf8)
        var emails = Set<String>()
        XCTAssertEqual(WorkspaceOriginMove.rewritten(id, replacing: replacements, emails: &emails), id)
        XCTAssertTrue(emails.isEmpty)
    }

    func testTheOutboxAndFolderNamesFollowTheOrigin() {
        let old = QuickNoteOutbox.fileName(owner: "rosa@example.com@https://legacy.org.example")
        let new = QuickNoteOutbox.fileName(owner: "rosa@example.com@https://envisioning.starlings.example")
        XCTAssertNotEqual(old, new)
        XCTAssertEqual(old, QuickNoteOutbox.fileName(owner: "ROSA@example.com@https://legacy.org.example"))
        XCTAssertNotEqual(
            WorkspaceScope.folderName(webOrigin: "https://legacy.org.example"),
            WorkspaceScope.folderName(webOrigin: "https://envisioning.starlings.example")
        )
    }

    func testAStoredWorkspaceWithNoAliasIsLeftAlone() throws {
        let suite = "meet.test.origin-move.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let other = StarlingsWorkspace(webOrigin: "https://acme.starlings.example", apiOrigin: "https://acme.starlings.example", name: "Acme", markURL: nil)
        defaults.set(try JSONEncoder().encode(other), forKey: "current")
        defaults.set(try JSONEncoder().encode([other]), forKey: "known")
        WorkspaceOriginMove.migrateStoredWorkspaces(defaults: defaults, currentKey: "current", knownKey: "known")
        let current = try JSONDecoder().decode(StarlingsWorkspace.self, from: XCTUnwrap(defaults.data(forKey: "current")))
        XCTAssertEqual(current, other)
        XCTAssertNil(defaults.object(forKey: WorkspaceOriginMove.markerKey(fromWeb: other.webOrigin)))
    }
}
