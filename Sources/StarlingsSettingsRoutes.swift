import Foundation
import StarlingsContracts

/// The settings and profile routes, each named once for the Mac
/// and the phone: Home's layout, the setup steps, the language, your own
/// picture, connected agents, signed-in devices, diagnostics, and the
/// native sign-in and renewal routes. `MeetingControlAPI`, `StarlingsAPI`
/// and `OwnerSessionRenewer` send them.
enum StarlingsSettingsRoutes {
    // MARK: Home and setup

    /// What Home is made of, for this owner: the same list every client reads
    /// (`fixtures/home-layout.json`).
    static let homeLayout = StarlingsRoute<HomePreferencesResponse>(
        method: "GET", path: ["home", "preferences"],
        operation: String(localized: "Couldn’t read your Home layout")
    )

    static func setHomeLayout(_ layout: [HomeModuleSetting]) -> StarlingsRoute<HomePreferencesResponse> {
        StarlingsRoute(
            method: "PUT", path: ["home", "preferences"], body: HomePreferencesUpdate(layout),
            operation: String(localized: "Couldn’t save your Home layout")
        )
    }

    /// This owner's setup steps, each done when the thing exists
    /// (docs/ONBOARDING.md).
    static let setup = StarlingsRoute<SetupResponse>(
        method: "GET", path: ["setup"],
        operation: String(localized: "Couldn’t load your setup steps")
    )

    /// An admin turns the checklist off, or on, for the whole workspace.
    static func setSetupChecklist(on: Bool) -> StarlingsRoute<SetupResponse> {
        StarlingsRoute(
            method: "PUT", path: ["admin", "setup"], body: SetupSettingUpdate(on: on),
            operation: String(localized: "Couldn’t turn the checklist off")
        )
    }

    /// Skip: this owner clears one step from their own checklist.
    static func skipSetupStep(_ step: SetupStep) -> StarlingsRoute<SetupResponse> {
        StarlingsRoute(
            method: "PUT", path: ["setup", "skip"], body: SetupSkipUpdate(step: step.rawValue, skipped: true),
            operation: String(localized: "Couldn’t skip that step")
        )
    }

    // MARK: Profile

    /// The language the interface is drawn in, for this owner.
    static let language = StarlingsRoute<LanguagePreferenceResponse>(
        method: "GET", path: ["profile", "language"],
        operation: String(localized: "Couldn’t read your language")
    )

    static func setLanguage(_ language: StarlingsLanguage?) -> StarlingsRoute<LanguagePreferenceResponse> {
        StarlingsRoute(
            method: "PUT", path: ["profile", "language"], body: LanguagePreferenceUpdate(language),
            operation: String(localized: "Couldn’t save your language")
        )
    }

    /// Your own picture, and only ever your own: the route takes no address.
    /// The bytes are already a square JPEG, because the Worker stores what
    /// it is given.
    static func uploadAvatar(_ data: Data) -> StarlingsRoute<AvatarResponse> {
        StarlingsRoute(
            method: "PUT", path: ["profile", "avatar"],
            upload: StarlingsUpload(data: data, contentType: "image/jpeg"),
            operation: String(localized: "Couldn’t save your picture"),
            origin: true
        )
    }

    static let removeAvatar = StarlingsRoute<AvatarResponse>(
        method: "DELETE", path: ["profile", "avatar"],
        operation: String(localized: "Couldn’t remove your picture"),
        origin: true
    )

    // MARK: Connected agents (docs/MCP.md)

    /// The person's own live pairings.
    static let mcpGrants = StarlingsRoute<McpGrantsResponse>(
        method: "GET", path: ["mcp", "grants"],
        operation: String(localized: "Couldn’t load connected agents")
    )

    /// One pairing's record, newest first.
    static func mcpGrantCalls(id: String) -> StarlingsRoute<McpGrantCallsResponse> {
        StarlingsRoute(
            method: "GET", path: ["mcp", "grants", id, "calls"],
            operation: String(localized: "Couldn’t load the record")
        )
    }

    /// Revoke in place; answers the pairings that remain.
    static func revokeMcpGrant(id: String) -> StarlingsRoute<McpGrantsResponse> {
        StarlingsRoute(
            method: "POST", path: ["mcp", "grants", id, "revoke"], body: StarlingsEmptyBody(),
            operation: String(localized: "Couldn’t revoke")
        )
    }

    /// Pause or resume one pairing; answers the live pairings.
    static func setMcpGrantPaused(id: String, paused: Bool) -> StarlingsRoute<McpGrantsResponse> {
        StarlingsRoute(
            method: "POST", path: ["mcp", "grants", id, paused ? "pause" : "resume"], body: StarlingsEmptyBody(),
            operation: paused ? String(localized: "Couldn’t pause") : String(localized: "Couldn’t resume")
        )
    }

    // MARK: Devices (docs/ADMIN.md §5a)

    /// The person's signed-in Macs and phones, this one marked.
    static let devices = StarlingsRoute<OwnerDevicesResponse>(
        method: "GET", path: ["auth", "devices"],
        operation: String(localized: "Couldn’t load devices")
    )

    /// Sign one device out. Its row goes, so its tokens are refused from its
    /// next request. Answers the devices that remain.
    static func revokeDevice(deviceID: String) -> StarlingsRoute<OwnerDevicesResponse> {
        StarlingsRoute(
            method: "POST", path: ["auth", "devices", "revoke"], body: DeviceRevokeRequest(deviceID: deviceID),
            operation: String(localized: "Couldn’t sign that device out")
        )
    }

    /// One MetricKit payload. Owner session only; the answer
    /// (`{ id }`) is not read.
    static func diagnosticReport(_ report: DiagnosticReport) -> StarlingsRoute<StarlingsNoAnswer> {
        StarlingsRoute(
            method: "POST", path: ["diagnostics"], body: report,
            operation: String(localized: "Couldn’t send diagnostics")
        )
    }

    // MARK: Native sign-in and renewal (no bearer)

    static func exchangeOwnerCode(_ exchange: NativeExchangeRequest) -> StarlingsRoute<OwnerSessionResponse> {
        StarlingsRoute(
            method: "POST", path: ["auth", "native", "exchange"], body: exchange,
            operation: String(localized: "Couldn’t sign in")
        )
    }

    /// Redeem a workspace sign-in's single-use code.
    static func redeemSignIn(_ redeem: NativeSignInRedeemRequest) -> StarlingsRoute<OwnerSessionResponse> {
        StarlingsRoute(
            method: "POST", path: ["auth", "native", "redeem"], body: redeem,
            operation: String(localized: "Couldn’t sign in")
        )
    }

    /// Trade the refresh token for a fresh pair. Single use: the request is
    /// never sent twice. The Worker re-checks the domain and the revocation,
    /// so only a 401 or 403 here is a reason to sign somebody out.
    static func refresh(_ refresh: SessionRefreshRequest) -> StarlingsRoute<OwnerSessionResponse> {
        StarlingsRoute(
            method: "POST", path: ["auth", "refresh"], body: refresh,
            operation: String(localized: "Couldn’t renew your sign-in")
        )
    }
}
