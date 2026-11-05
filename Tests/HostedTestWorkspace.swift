import Foundation
@testable import Starlings

/// The test bundle's principal class (`NSPrincipalClass` in `project.yml`).
/// XCTest creates it once, when the bundle loads, before any test runs.
///
/// The test host is Starlings.app, so it shares the defaults of the install on
/// the machine. `StarlingsWorkspace.active` restores the workspace that install is
/// signed in to: another workspace's origin, Core and accent would reach every
/// test that reads a link, a Core URL or a colour. This sets the build's own
/// workspace, the one a machine with no install has, with the test member
/// domains (`StarlingsWorkspace.tests`). It changes the value in memory only
/// and writes no default.
final class HostedTestWorkspace: NSObject {
    override init() {
        super.init()
        StarlingsWorkspace.setActive(.tests)
    }
}
