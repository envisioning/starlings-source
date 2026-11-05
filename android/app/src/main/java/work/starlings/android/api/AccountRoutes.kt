package work.starlings.android.api

import work.starlings.contracts.AvatarResponse
import work.starlings.contracts.McpGrantCallsResponse
import work.starlings.contracts.McpGrantsResponse

/**
 * Settings › Account's own routes: the profile picture and the connected
 * agents, as `StarlingsSettingsRoutes` (Profile, Connected agents). The
 * picture's upload is bytes: `workspace/team/TeamMedia.kt` sends it.
 * Held to `fixtures/routes.json` by `AccountRoutesTest`.
 */
object AccountRoutes {
    /** The squared JPEG, as the body. Answers the new version. */
    val uploadAvatar = Route(
        "PUT", listOf("profile", "avatar"), answer = Answer.Wire(AvatarResponse.serializer()),
        operation = "Couldn’t save your picture", origin = true,
    )

    /** Back to initials. */
    val removeAvatar = Route(
        "DELETE", listOf("profile", "avatar"), answer = Answer.Wire(AvatarResponse.serializer()),
        operation = "Couldn’t remove your picture", origin = true,
    )

    /** The person's own live pairings (docs/MCP.md). */
    val mcpGrants = Route(
        "GET", listOf("mcp", "grants"), answer = Answer.Wire(McpGrantsResponse.serializer()),
        operation = "Couldn’t load connected agents",
    )

    /** One pairing's record, newest first. */
    fun mcpGrantCalls(id: String): Route<McpGrantCallsResponse> = Route(
        "GET", listOf("mcp", "grants", id, "calls"), answer = Answer.Wire(McpGrantCallsResponse.serializer()),
        operation = "Couldn’t load the record",
    )

    /** Revoke in place; answers the pairings that remain. */
    fun revokeMcpGrant(id: String): Route<McpGrantsResponse> = Route(
        "POST", listOf("mcp", "grants", id, "revoke"), body = EMPTY_BODY,
        answer = Answer.Wire(McpGrantsResponse.serializer()), operation = "Couldn’t revoke",
    )

    /** Pause or resume one pairing; answers the live pairings. */
    fun setMcpGrantPaused(id: String, paused: Boolean): Route<McpGrantsResponse> = Route(
        "POST", listOf("mcp", "grants", id, if (paused) "pause" else "resume"), body = EMPTY_BODY,
        answer = Answer.Wire(McpGrantsResponse.serializer()), operation = if (paused) "Couldn’t pause" else "Couldn’t resume",
    )
}
