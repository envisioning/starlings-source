package work.starlings.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.Image
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import work.starlings.android.ParticipantInitials
import work.starlings.android.StarlingsTokens

/**
 * Team's row parts: `PeerAvatar`, `UnreadDot`, `WorkGlyphMark` and
 * `WorkSidebarRow` of iOS/PeerRosterViews.swift and iOS/WorkSidebarRow.swift.
 */

/** The presence a dot draws, as `PeerAvatar.dot`. */
enum class PresenceDot { IN_MEETING, BUSY, AVAILABLE, ACTIVE, DND, NONE }

/**
 * A face: initials on the elevated rung, and the person's [picture] over
 * them once it has loaded (`PersonAvatarImage`: the initials stay under it,
 * so a picture that never arrives changes nothing), with the presence dot
 * punched out of the panel at the bottom trailing corner. No dot on an agent
 * or on somebody offline. [face] replaces the initials and picture: an
 * agent's seeded identity (`AgentAvatarImage`).
 */
@Composable
fun PeerAvatar(
    name: String,
    dot: PresenceDot,
    modifier: Modifier = Modifier,
    diameter: Dp = 40.dp,
    picture: ImageBitmap? = null,
    face: (@Composable () -> Unit)? = null,
) {
    val c = Starlings.colors
    Box(modifier.size(diameter).clearAndSetSemantics { }) {
        if (face != null) face() else Box(
            Modifier.size(diameter).background(c.elevated, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                ParticipantInitials.make(name),
                style = (if (diameter >= 36.dp) StarlingsType.subheadline else StarlingsType.caption2).copy(fontWeight = FontWeight.SemiBold),
                color = c.secondary,
            )
            picture?.let { Image(it, null, Modifier.size(diameter).clip(CircleShape), contentScale = ContentScale.Crop) }
        }
        if (dot != PresenceDot.NONE) {
            val fill = when (dot) {
                PresenceDot.IN_MEETING -> StarlingsTokens.color("presenceInMeeting", c.dark)
                PresenceDot.BUSY -> StarlingsTokens.color("presenceBusy", c.dark)
                PresenceDot.AVAILABLE, PresenceDot.ACTIVE -> c.accent
                PresenceDot.DND -> c.secondary.copy(alpha = 0.5f).compositeOver(c.panel)
                PresenceDot.NONE -> Color.Transparent
            }
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .size(12.dp)
                    .background(fill, CircleShape)
                    .border(2.dp, c.panel, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                if (dot == PresenceDot.IN_MEETING) Icon(Icons.Filled.Videocam, null, Modifier.size(6.dp), tint = c.panel)
            }
        }
    }
}

/** The unread mark: a 9 dot in primary ink. Decorative: the row's label says unread. */
@Composable
fun UnreadDot(modifier: Modifier = Modifier) {
    Box(modifier.size(9.dp).background(Starlings.colors.primary, CircleShape).clearAndSetSemantics { })
}

/** `WorkGlyphMark`: a symbol in a 40 circle on the elevated rung. */
@Composable
fun GlyphMark(icon: ImageVector = Icons.Filled.Groups, modifier: Modifier = Modifier) {
    val c = Starlings.colors
    Box(modifier.size(40.dp).background(c.elevated, CircleShape).clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
        Icon(icon, null, Modifier.size(20.dp), tint = c.secondary)
    }
}

/**
 * `WorkSidebarRow`: leading mark, title (semibold when unread, medium
 * otherwise), an optional caption line, and the unread dot at the end.
 */
@Composable
fun SidebarRow(
    title: String,
    subtitle: String,
    hasUnread: Boolean,
    modifier: Modifier = Modifier,
    leading: @Composable () -> Unit,
) {
    val c = Starlings.colors
    Row(
        modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                title,
                style = StarlingsType.body.copy(fontWeight = if (hasUnread) FontWeight.SemiBold else FontWeight.Medium),
                color = c.primary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle.isNotEmpty()) {
                Text(subtitle, style = StarlingsType.caption, color = c.secondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        if (hasUnread) {
            Spacer(Modifier.width(0.dp))
            UnreadDot()
        }
    }
}
