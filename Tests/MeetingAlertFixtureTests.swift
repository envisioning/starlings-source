import XCTest
@testable import Starlings

/// The shared meeting-warning table (`fixtures/meeting-alerts.json`), run by
/// both test targets (project.yml lists this file and the runner under
/// Starlings-iOSTests too): one rule, two schedulers.
final class MeetingAlertFixtureTests: XCTestCase {
    func testTheTable() throws {
        try MeetingAlertFixtureRunner.run(bundle: Bundle(for: type(of: self)))
    }
}
