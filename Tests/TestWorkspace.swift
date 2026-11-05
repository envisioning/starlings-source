import Foundation
@testable import Starlings

extension StarlingsWorkspace {
    /// The build's own workspace with the test workspace's member domains, the
    /// same as `services/control-plane/wrangler.test.jsonc`. Invented people are
    /// on reserved domains (RFC 2606), never on a real one: members on
    /// `example.com` and `example.org`, outsiders on `example.net`.
    static var tests: StarlingsWorkspace {
        var workspace = StarlingsWorkspace.builtIn
        workspace.identity = Identity(domains: ["example.com", "example.org"], signInHint: "example.com")
        return workspace
    }
}
