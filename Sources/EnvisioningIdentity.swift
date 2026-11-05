import Foundation

/// The domains that make someone one of us.
///
/// The active workspace's member domains, from its descriptor (,
/// docs/CENTRAL_AUTH.md slice C). Before the first read, the build's own
/// workspace uses `IDENTITY_DOMAINS` from `packages/contracts`: Envisioning's
/// two domains, one Google Workspace whose `hd` claim names whichever domain
/// the account lives on. The control plane is what actually enforces this;
/// these clients only shape the account picker and the local form validation.
///
/// Identity only. Attaching a Google account as a *calendar to read* is
/// deliberately exempt — that credential is data, not a claim about who you are.
enum EnvisioningIdentity {
    static var domains: Set<String> { Set(StarlingsWorkspace.active.resolvedIdentity.domains) }

    /// What to send as Google's `hd`: the one domain the account chooser is
    /// narrowed to, so a sign-in is offered Envisioning accounts and nothing
    /// else. `*` would still list every other Workspace the browser knows.
    ///
    /// A filter, not the gate — the Worker makes the real decision and still
    /// admits either identity domain. Never use this when attaching a personal
    /// calendar account: `hd` has to be absent there, not set.
    /// The descriptor's `sign_in_hint`; `SIGN_IN_DOMAIN` in `packages/contracts`
    /// before the first read. Nil shows every account.
    static var hostedDomainHint: String? { StarlingsWorkspace.active.resolvedIdentity.signInHint }

    /// Which of an owner's devices a host connection comes from.
    ///
    /// LiveKit evicts a duplicate identity, so one account signed in on two
    /// devices needs two identities. The device rides in the local part
    /// (`mz+mac@example.com`) so the identity stays an Envisioning address:
    /// caption trust is `isIdentityAddress` on every client that already
    /// shipped, and a scheme that left the domain would silence captions.
    ///
    /// Nothing is authorized on this. Owner gates key on the Google `sub`.
    /// The generated `HostDevice`, the contract's closed set.
    typealias HostDevice = StarlingsContracts.HostDevice

    /// The LiveKit identity for one owner installation. The platform label
    /// distinguishes Mac from iPhone; the signed install id distinguishes two
    /// Macs. Mirrors `deviceScopedOwnerIdentity` in `packages/contracts`.
    static func deviceScopedIdentity(_ email: String, device: HostDevice, installID: String? = nil) -> String {
        guard let at = email.lastIndex(of: "@"), at != email.startIndex else { return email }
        let install = installID.map { value in
            String(value.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }.prefix(64))
        }
        let installSuffix = install.flatMap { $0.isEmpty ? nil : "-\($0)" } ?? ""
        return "\(email[..<at])+\(device.rawValue)\(installSuffix)\(email[at...])"
    }

    /// The account address behind a device-scoped identity. Whatever the owner
    /// is entitled to as a person is decided on this, never on the device.
    static func accountAddress(_ identity: String) -> String {
        guard let at = identity.lastIndex(of: "@"), at != identity.startIndex else { return identity }
        let local = identity[..<at]
        guard let plus = local.firstIndex(of: "+"), plus != local.startIndex else { return identity }
        return "\(local[..<plus])\(identity[at...])"
    }

    /// True for a bare address on one of the identity domains.
    static func isIdentityAddress(_ value: String) -> Bool {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard let at = normalized.lastIndex(of: "@") else { return false }
        let local = normalized[..<at]
        guard !local.isEmpty, !local.contains("@"), !local.contains(" ") else { return false }
        return domains.contains(String(normalized[normalized.index(after: at)...]))
    }
}

/// Every string that says *which organisation this build is for*: the public
/// hosts, the sibling CRM, the address a human writes to.
///
/// One place, for the same reason [EnvisioningIdentity] is one place — a
/// literal like `the built-in workspace's host` must not drift between the Mac app, the
/// phone, the SPA, and the Worker. Mirrors
/// `packages/contracts/src/deployment.ts`.
enum EnvisioningDeployment {

    /// Keep, the zero-knowledge vault for client credentials. The apps have a
    /// native client (`KeepKit`); this is the web address for links out.
    static let keepOrigin = ContractConstants.keepWebOrigin

    /// The organisation's public site — the marketing link, not a product host.
    static let orgWebOrigin = ContractConstants.orgWebOrigin

    /// Where the org's public events live, used to recognise one on a calendar
    /// row. Path fragment, deliberately scheme-less: it is matched against
    /// whatever string an invite happened to carry.
    static let eventsLinkFragment = "\(ContractConstants.orgWebHost)/events"

    /// The RFC 5545 domain for a `UID` this app mints: the active workspace's
    /// public host. Identifies the issuer of the invite; never resolved, never
    /// mailed.
    static var calendarUIDDomain: String {
        URL(string: StarlingsWorkspace.active.publicOrigin)?.host ?? ContractConstants.workspaceHostSuffix
    }

    /// The RFC 5545 `PRODID` of a calendar file this app builds:
    /// Envisioning keeps its fixed value, any other workspace fills
    /// `ContractConstants.icsProductIDTemplate` with its name (`icsProductId`
    /// in `packages/contracts/src/deployment.ts`).
    static var calendarProductID: String {
        calendarProductID(workspaceName: StarlingsWorkspace.active.name)
    }

    static func calendarProductID(workspaceName: String) -> String {
        if workspaceName == ContractConstants.orgName { return ContractConstants.orgICSProductID }
        let kept = workspaceName.unicodeScalars.filter { $0 != "/" && !CharacterSet.controlCharacters.contains($0) }
        let name = String(String.UnicodeScalarView(kept)).trimmingCharacters(in: .whitespaces)
        return ContractConstants.icsProductIDTemplate.replacingOccurrences(of: "{name}", with: name.isEmpty ? "Starlings" : name)
    }

    /// Placeholder shown where an owner types their own address: on the
    /// active workspace's first member domain.
    static var exampleAddress: String {
        "you@\(StarlingsWorkspace.active.resolvedIdentity.domains.first ?? "example.com")"
    }

    /// Canonical Core page for one CRM record. Native clients link here instead
    /// of recreating a CRM detail route, so web and app open the same record.
    /// Nil on a workspace without Core, and for a record whose
    /// group has moved to D1.
    static func coreDashboardURL(collection: String, id: String) -> URL? {
        let workspace = StarlingsWorkspace.active
        guard workspace.services?.coreHolds(collection: collection) ?? true else { return nil }
        return workspace.coreOrigin?.appending(path: "dashboard/\(collection)/\(id)")
    }
}
