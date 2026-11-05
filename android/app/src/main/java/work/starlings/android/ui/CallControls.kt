package work.starlings.android.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import work.starlings.android.CallQuality

/**
 * The join and call controls only this area draws, each naming the Swift
 * it mirrors: the tile's connection bars, the device chevron beside Mute and
 * Camera, the welcome card's workspace row and the End confirmation.
 */

/**
 * `MobileVideoTile`'s quality badge: the `cellularbars` symbol, its lit bars
 * from [CallQuality.litBars], in white or danger when weak, 24 square on black
 * glass at radius 6. TalkBack reads [label].
 */
@Composable
fun QualityBadge(quality: CallQuality, label: String, modifier: Modifier = Modifier, small: Boolean = false) {
    val c = Starlings.colors
    val ink = if (quality.isWeak) c.danger else Color.White
    val dim = Color.White.copy(alpha = 0.3f)
    val lit = quality.litBars(BARS)
    Box(
        modifier
            .size(24.dp)
            .floatingGlass(Color.Black.copy(alpha = 0.68f), RoundedCornerShape(6.dp))
            .clearAndSetSemantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        val side: Dp = if (small) 11.dp else 12.dp
        Canvas(Modifier.size(side)) {
            val gap = size.width * 0.12f
            val w = (size.width - gap * (BARS - 1)) / BARS
            for (i in 0 until BARS) {
                val h = size.height * (i + 1) / BARS
                drawRoundRect(
                    if (i < lit) ink else dim,
                    topLeft = Offset(i * (w + gap), size.height - h),
                    size = Size(w, h),
                    cornerRadius = CornerRadius(w / 3),
                )
            }
        }
    }
}

private const val BARS = 4

/**
 * `MobileDeviceChooser`: the chevron segment at the top trailing edge of a
 * media control, 26 wide and as tall as the control, on the elevated rung
 * behind a hairline. Its menu is [content]; TalkBack says [label].
 */
@Composable
fun DeviceChooser(
    label: String,
    height: Dp,
    modifier: Modifier = Modifier,
    content: @Composable (close: () -> Unit) -> Unit,
) {
    val c = Starlings.colors
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        Row(
            Modifier
                .width(26.dp)
                .height(height)
                .background(c.elevated, RoundedCornerShape(topEnd = StarlingsRadius.control, bottomEnd = StarlingsRadius.control))
                .clickable(role = Role.Button) { open = true }
                .clearAndSetSemantics { contentDescription = label; role = Role.Button },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.width(1.dp).height(30.dp).background(c.border))
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.KeyboardArrowDown, null, Modifier.size(14.dp), tint = c.secondary)
            }
        }
        DropdownMenu(open, { open = false }) { content { open = false } }
    }
}

/** A menu's section title (an inline `Picker`'s label): footnote, secondary. */
@Composable
fun MenuHeader(text: String) {
    Text(
        text,
        Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
        style = StarlingsType.footnote,
        color = Starlings.colors.secondary,
    )
}

/**
 * `WorkspaceDoorRow`: the workspace's mark (the flock while signed out),
 * its name and address, and the action on the trailing side, in a 48-tall
 * well on the elevated rung with the hairline, radius `field`. A press dims
 * it; [busy] shows the flock at work instead of the action.
 */
@Composable
fun WorkspaceDoorRow(
    name: String,
    detail: String,
    action: String,
    busy: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    /** The workspace's mark (`StarlingsWorkspaceMarkView`); null draws the flock. */
    mark: (@Composable () -> Unit)? = null,
) {
    val c = Starlings.colors
    val s = RoundedCornerShape(StarlingsRadius.field)
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .background(c.elevated, s)
            .border(1.dp, c.border, s)
            .clickable(enabled = enabled && !busy, role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = "$name, $detail, $action"; role = Role.Button }
            .alpha(if (enabled || busy) 1f else 0.5f)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (mark != null) mark() else GatheringDotsView(24.dp, c.primary, GatheringDots.Motion.STILL)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(name, style = StarlingsType.subheadline.copy(fontWeight = FontWeight.SemiBold), color = c.primary, maxLines = 1)
            Text(detail, style = StarlingsType.caption2, color = c.secondary, maxLines = 1)
        }
        if (busy) {
            GatheringDotsView(18.dp, c.secondary, GatheringDots.Motion.BUSY)
        } else {
            Text(action, style = StarlingsType.footnote.copy(fontWeight = FontWeight.SemiBold), color = c.primary)
        }
    }
}

/**
 * `MobileCallView`'s `confirmationDialog`: the question as the title, how
 * many others are still in the room under it, the destructive action in
 * danger ink and Cancel.
 */
@Composable
fun EndForEveryoneDialog(title: String, message: String, confirm: String, cancel: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    val c = Starlings.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, style = StarlingsType.headline, textAlign = TextAlign.Center) },
        text = { Text(message, style = StarlingsType.subheadline) },
        confirmButton = { TextButton(onConfirm) { Text(confirm, color = c.danger) } },
        dismissButton = { TextButton(onDismiss) { Text(cancel, color = c.primary) } },
        containerColor = c.elevated,
        titleContentColor = c.primary,
        textContentColor = c.secondary,
    )
}
