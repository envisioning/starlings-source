package work.starlings.android

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Celebration
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.material.icons.filled.TabletMac
import androidx.compose.material.icons.outlined.HelpOutline
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.PanTool
import androidx.compose.material.icons.filled.ThumbUp
import androidx.compose.material.icons.outlined.SentimentSatisfied
import androidx.compose.ui.graphics.vector.ImageVector

/**
 * Emoji stay on the wire; the screen draws a semantic icon (docs/DESIGN.md,
 * Iconography law). The Material counterparts of the SF Symbols in
 * `Sources/MeetingReactions.swift`. Laugh is the outlined face there too.
 */
object StarlingsIcons {
    val reaction = mapOf(
        "👍" to Icons.Filled.ThumbUp,
        "❤️" to Icons.Filled.Favorite,
        "😂" to Icons.Outlined.SentimentSatisfied,
        "🎉" to Icons.Filled.Celebration,
    )

    /** `hand.raised.fill` on iOS. */
    val hand: ImageVector = Icons.Filled.PanTool

    /** `GuestClient.systemSymbolName` in Sources/MeetingParticipantClient.swift. */
    fun client(client: GuestClient): ImageVector = when (client.app) {
        "web" -> Icons.Filled.Language
        "mac" -> Icons.Filled.Computer
        "ios" -> if (client.device == "tablet") Icons.Filled.TabletMac else Icons.Filled.Smartphone
        "android" -> Icons.Filled.Smartphone
        else -> Icons.Outlined.HelpOutline
    }

    /** A reaction this build does not know draws as its wire text. */
    fun reaction(emoji: String): ImageVector? = reaction[emoji]
}
