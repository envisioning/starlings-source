package work.starlings.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * `Picker(…).pickerStyle(.segmented)`: one rounded track on the field rung,
 * the chosen segment lifted on the elevated rung. Each segment is a radio
 * for TalkBack, in a selectable group.
 */
@Composable
fun SegmentedChoice(
    options: List<String>,
    selected: Int?,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val c = Starlings.colors
    val track = RoundedCornerShape(9.dp)
    val thumb = RoundedCornerShape(7.dp)
    Row(
        modifier
            .fillMaxWidth()
            .alpha(if (enabled) 1f else 0.45f)
            .background(c.field, track)
            .padding(2.dp)
            .selectableGroup(),
    ) {
        options.forEachIndexed { index, title ->
            val on = index == selected
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = 32.dp)
                    .background(if (on) c.elevated else Color.Transparent, thumb)
                    .selectable(on, enabled = enabled, role = Role.RadioButton) { onSelect(index) },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    title,
                    style = StarlingsType.footnote.copy(fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal, textAlign = TextAlign.Center),
                    color = c.primary,
                    maxLines = 1,
                )
            }
        }
    }
}

/** A `Label` button in a list row: a symbol and a title, in the tint given (accent, danger, primary). */
@Composable
fun ListActionRow(
    title: String,
    icon: ImageVector?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color = Starlings.colors.accent,
    enabled: Boolean = true,
) {
    Row(
        modifier
            .fillMaxWidth()
            .alpha(if (enabled) 1f else 0.45f)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Decorative: the title says what the row does.
        icon?.let { Icon(it, null, Modifier.size(20.dp), tint = tint) }
        Text(title, style = StarlingsType.body, color = tint)
    }
}

/**
 * A form sheet's bar: Close at the leading end (`StarlingsSheetCloseButton`),
 * the inline title centred, the confirm as a filled accent capsule
 * (`meetToolbarConfirm`), dimmed while it cannot be pressed.
 */
@Composable
fun FormSheetBar(
    title: String,
    closeLabel: String,
    onClose: () -> Unit,
    confirm: String,
    confirmEnabled: Boolean,
    onConfirm: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = Starlings.colors
    Box(modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Box(
            Modifier
                .align(Alignment.CenterStart)
                .size(36.dp)
                .background(c.elevated, CircleShape)
                .clickable(role = Role.Button, onClick = onClose)
                .semantics { contentDescription = closeLabel },
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Close, null, Modifier.size(18.dp), tint = c.primary)
        }
        Text(title, Modifier.align(Alignment.Center), style = StarlingsType.headline, color = c.primary)
        Text(
            confirm,
            Modifier
                .align(Alignment.CenterEnd)
                .alpha(if (confirmEnabled) 1f else 0.45f)
                .background(c.accent, CircleShape)
                .clickable(enabled = confirmEnabled, role = Role.Button, onClick = onConfirm)
                .padding(horizontal = 16.dp, vertical = 8.dp),
            style = StarlingsType.headline,
            color = c.accentInk,
        )
    }
}

/** A grouped section's footer: footnote secondary ink under the group. */
@Composable
fun ListFooter(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.padding(start = 16.dp, end = 16.dp, top = 6.dp), style = StarlingsType.footnote, color = Starlings.colors.secondary)
}

/** One choice in a [ListMenuRow]: its title, and whether it is the one in force. */
data class MenuChoice(val title: String, val chosen: Boolean, val onChoose: () -> Unit)

/**
 * A `Picker` or `Menu` row in a grouped list: the label at the leading end,
 * the current value in secondary ink at the trailing end, and a menu of the
 * choices with a check on the one in force.
 */
@Composable
fun ListMenuRow(label: String, value: String, choices: List<MenuChoice>, modifier: Modifier = Modifier) {
    val c = Starlings.colors
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button) { open = true }
                .clearAndSetSemantics { contentDescription = "$label, $value"; role = Role.Button }
                .padding(horizontal = 16.dp, vertical = 13.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(label, Modifier.weight(1f), style = StarlingsType.body, color = c.primary)
            Text(value, style = StarlingsType.body, color = c.secondary, maxLines = 1)
        }
        DropdownMenu(open, onDismissRequest = { open = false }) {
            choices.forEach { choice ->
                DropdownMenuItem(
                    text = { Text(choice.title) },
                    trailingIcon = { if (choice.chosen) Icon(Icons.Filled.Check, null) },
                    onClick = { open = false; choice.onChoose() },
                )
            }
        }
    }
}
