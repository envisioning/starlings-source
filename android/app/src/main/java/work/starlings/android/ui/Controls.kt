package work.starlings.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * The iOS controls the join and call screens wear, in Compose. Each names the
 * Swift it mirrors. iOS draws a pressed state and a pointer hover; a phone
 * has no pointer, so only the press is drawn here (docs/DESIGN.md, "Touch").
 */

private fun shape(radius: androidx.compose.ui.unit.Dp) = RoundedCornerShape(radius)

/**
 * `meetFloatingGlass`: Liquid Glass on iOS 26, the opaque fallback below it.
 * Compose cannot blur what lies behind a view, so Android always draws the
 * iOS fallback: the same shape, filled.
 */
fun Modifier.floatingGlass(fallback: Color, shape: Shape): Modifier = background(fallback, shape)

/** A dimmed, inert control (docs/DESIGN.md, "Precedence"): the toggle's 0.45. */
private const val DISABLED_ALPHA = 0.45f

/**
 * `StarlingsFilledButtonStyle`: the accent fill with dark ink, radius
 * `control`, headline type, 48 tall and full width; `compact` is 36 tall,
 * subheadline semibold, as wide as its label.
 */
@Composable
fun FilledButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    icon: ImageVector? = null,
    compact: Boolean = false,
) {
    val c = Starlings.colors
    val press = remember { MutableInteractionSource() }
    val pressed by press.collectIsPressedAsState()
    ButtonShell(
        text, onClick, modifier, enabled, icon, compact, press,
        fill = if (pressed) c.accentPressed else c.accent,
        ink = c.accentInk,
        border = null,
    )
}

/**
 * `StarlingsBorderedButtonStyle`: the elevated rung with the `border`
 * hairline, primary ink, 46 tall; `compact` as the filled one.
 */
@Composable
fun BorderedButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    icon: ImageVector? = null,
    compact: Boolean = false,
    foreground: Color? = null,
) {
    val c = Starlings.colors
    val press = remember { MutableInteractionSource() }
    val pressed by press.collectIsPressedAsState()
    ButtonShell(
        text, onClick, modifier, enabled, icon, compact, press,
        fill = c.elevated.copy(alpha = if (pressed) 0.7f else 1f),
        ink = foreground ?: c.primary,
        border = c.border,
        minHeight = if (compact) StarlingsSize.compact else StarlingsSize.bordered,
    )
}

@Composable
private fun ButtonShell(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier,
    enabled: Boolean,
    icon: ImageVector?,
    compact: Boolean,
    press: MutableInteractionSource,
    fill: Color,
    ink: Color,
    border: Color?,
    minHeight: androidx.compose.ui.unit.Dp = if (compact) StarlingsSize.compact else StarlingsSize.filled,
) {
    val s = shape(StarlingsRadius.control)
    val type = if (compact) StarlingsType.subheadline.copy(fontWeight = FontWeight.SemiBold) else StarlingsType.headline
    Row(
        modifier
            .then(if (compact) Modifier else Modifier.fillMaxWidth())
            .heightIn(min = minHeight)
            .alpha(if (enabled) 1f else DISABLED_ALPHA)
            .background(fill, s)
            .then(if (border != null) Modifier.border(1.dp, border, s) else Modifier)
            .clickable(press, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = if (compact) 14.dp else 20.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Decorative: the label beside it says what the button does.
        icon?.let { Icon(it, null, Modifier.size(if (compact) 16.dp else 18.dp), tint = ink) }
        Text(text, style = type, color = ink, maxLines = 1)
    }
}

/** A chromeless text button in secondary ink: the prejoin's Back. */
@Composable
fun PlainButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, color: Color = Starlings.colors.secondary) {
    Text(
        text,
        modifier
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        style = StarlingsType.body,
        color = color,
    )
}

/**
 * `meetField`: a well. The field rung, radius `field`, 14 of inset, 48 tall,
 * the `border` hairline, and the accent caret. The placeholder is the label,
 * as iOS's `TextField("Your name", …)`; `label` is what TalkBack says.
 */
@Composable
fun StarlingsField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    label: String = placeholder,
    keyboardType: KeyboardType = KeyboardType.Text,
    capitalization: KeyboardCapitalization = KeyboardCapitalization.None,
    singleLine: Boolean = true,
    maxLines: Int = 1,
    trailingInset: androidx.compose.ui.unit.Dp = 0.dp,
    /** `onSubmit` with `.submitLabel(.search)`: the keyboard's action key searches. */
    onSearch: (() -> Unit)? = null,
) {
    val c = Starlings.colors
    val s = shape(StarlingsRadius.field)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = StarlingsSize.field)
            .background(c.field, s)
            .border(1.dp, c.border, s)
            .semantics { contentDescription = label },
        singleLine = singleLine,
        maxLines = if (singleLine) 1 else maxLines,
        textStyle = StarlingsType.body.copy(color = c.primary),
        cursorBrush = SolidColor(c.accent),
        keyboardOptions = KeyboardOptions(
            keyboardType = keyboardType,
            capitalization = capitalization,
            autoCorrectEnabled = false,
            imeAction = if (onSearch != null) ImeAction.Search else ImeAction.Default,
        ),
        keyboardActions = KeyboardActions(onSearch = { onSearch?.invoke() }),
        decorationBox = { inner ->
            Box(
                Modifier.padding(start = StarlingsSpacing.fieldInset, end = StarlingsSpacing.fieldInset + trailingInset, top = 13.dp, bottom = 13.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (value.isEmpty()) Text(placeholder, style = StarlingsType.body, color = c.secondary.copy(alpha = 0.7f), maxLines = 1)
                inner()
            }
        },
    )
}

/**
 * `StarlingsToggleStyle`: a 51 × 31 capsule, the accent when on and the
 * secondary ink when off, with a white 27 thumb in both states. The track
 * changes; the thumb does not.
 */
@Composable
fun StarlingsToggle(label: String, on: Boolean, onChange: (Boolean) -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val c = Starlings.colors
    Row(
        modifier
            .fillMaxWidth()
            .alpha(if (enabled) 1f else DISABLED_ALPHA)
            .clickable(enabled = enabled, role = Role.Switch) { onChange(!on) }
            .padding(vertical = 6.dp)
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Switch
                stateDescription = if (on) "On" else "Off"
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, Modifier.weight(1f), style = StarlingsType.body, color = c.primary)
        Spacer(Modifier.width(12.dp))
        Box(
            Modifier
                .size(StarlingsSize.toggleWidth, StarlingsSize.toggleHeight)
                .background(if (on) c.accent else c.secondary, CircleShape)
                .padding(2.dp),
            contentAlignment = if (on) Alignment.CenterEnd else Alignment.CenterStart,
        ) {
            Box(Modifier.size(StarlingsSize.toggleThumb).background(Color.White, CircleShape))
        }
    }
}

/** `StarlingsCard`: the panel rung, the `border` hairline, radius `card`, 16 of padding. */
@Composable
fun StarlingsCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val c = Starlings.colors
    val s = shape(StarlingsRadius.card)
    Column(
        modifier.fillMaxWidth().background(c.panel, s).border(1.dp, c.border, s).padding(StarlingsSpacing.card),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        content = content,
    )
}

/**
 * `JoinView.mediaButton`: the symbol over a caption-semibold title, 62
 * tall, on the elevated rung with the hairline, radius `control`.
 */
@Composable
fun MediaButton(icon: ImageVector, title: String, onClick: () -> Unit, modifier: Modifier = Modifier, label: String = title) {
    val c = Starlings.colors
    val s = shape(StarlingsRadius.control)
    val press = remember { MutableInteractionSource() }
    val pressed by press.collectIsPressedAsState()
    Column(
        modifier
            .heightIn(min = StarlingsSize.mediaButton)
            .background(c.elevated.copy(alpha = if (pressed) 0.7f else 1f), s)
            .border(1.dp, c.border, s)
            .clickable(press, indication = null, role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = label; role = Role.Button }
            .padding(vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, null, Modifier.size(22.dp), tint = c.primary)
        Text(title, style = StarlingsType.caption.copy(fontWeight = FontWeight.SemiBold), color = c.primary)
    }
}

/**
 * `MobileCallView.callButton`: one control in the floating row. The symbol
 * over a caption2 word, 54 tall, glass in radius `control` (the elevated
 * fallback; End wears danger). `label` is what TalkBack says; `badge` is the
 * chat's unread count, primary ink on a capsule at the top trailing corner.
 */
@Composable
fun CallControl(
    icon: ImageVector,
    title: String,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    danger: Boolean = false,
    badge: Int = 0,
) {
    val c = Starlings.colors
    val s = shape(StarlingsRadius.control)
    val press = remember { MutableInteractionSource() }
    val pressed by press.collectIsPressedAsState()
    val fill = if (danger) c.danger else c.elevated
    Box(
        modifier
            .heightIn(min = StarlingsSize.callControl)
            .floatingGlass(fill.copy(alpha = if (pressed) 0.75f else 1f), s)
            .clickable(press, indication = null, role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = label; role = Role.Button },
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            CompositionLocalProvider(LocalContentColor provides c.primary) {
                Icon(icon, null, Modifier.size(20.dp))
                Text(title, style = StarlingsType.caption2, color = c.primary, maxLines = 1)
            }
        }
        if (badge > 0) {
            CountBadge(
                badge,
                Modifier.align(Alignment.TopEnd).offset(x = (-6).dp, y = 4.dp),
            )
        }
    }
}

/** The unread capsule: caption2 bold in the canvas colour on primary ink, 20 tall, `99+` past 99. */
@Composable
fun CountBadge(count: Int, modifier: Modifier = Modifier) {
    val c = Starlings.colors
    Text(
        if (count > 99) "99+" else "$count",
        modifier
            .clearAndSetSemantics { }
            .defaultMinSize(minWidth = 20.dp, minHeight = 20.dp)
            .background(c.primary, CircleShape)
            .padding(horizontal = 4.dp, vertical = 3.dp),
        style = StarlingsType.caption2.copy(fontWeight = FontWeight.Bold, textAlign = TextAlign.Center),
        color = c.canvas,
    )
}

/**
 * The 42 circle on the elevated rung that holds the call header's audio
 * route (and, for a host, the waiting room). Opaque: glass needs something
 * under it, and the header sits on the canvas.
 */
@Composable
fun HeaderCircleButton(icon: ImageVector, label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Starlings.colors
    Box(
        modifier
            .size(StarlingsSize.headerCircle)
            .background(c.elevated, CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = label; role = Role.Button },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, Modifier.size(20.dp), tint = c.primary)
    }
}

/**
 * `MobileCallView.noticeRow`: a callout line on the panel rung, radius
 * `control`, with a semibold Dismiss at the trailing end. Also the call's
 * reconnecting and audio lines, which have nothing to dismiss.
 */
@Composable
fun NoticeRow(text: String, modifier: Modifier = Modifier, icon: ImageVector? = null, dismiss: String? = null, onDismiss: (() -> Unit)? = null) {
    val c = Starlings.colors
    Row(
        modifier
            .fillMaxWidth()
            .background(c.panel, shape(StarlingsRadius.control))
            .padding(horizontal = 12.dp, vertical = 9.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        icon?.let { Icon(it, null, Modifier.size(18.dp), tint = c.primary) }
        Text(text, Modifier.weight(1f), style = StarlingsType.callout, color = c.primary)
        if (dismiss != null && onDismiss != null) {
            Text(
                dismiss,
                Modifier.clickable(role = Role.Button, onClick = onDismiss).padding(4.dp),
                style = StarlingsType.callout.copy(fontWeight = FontWeight.SemiBold),
                color = c.primary,
            )
        }
    }
}

/**
 * A sheet's bar: the inline title centred, the confirm (Done) as a filled
 * accent capsule at the trailing end (`meetToolbarConfirm`).
 */
@Composable
fun SheetHeader(title: String, done: String, onDone: () -> Unit, modifier: Modifier = Modifier) {
    val c = Starlings.colors
    Box(modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Text(title, Modifier.align(Alignment.Center), style = StarlingsType.headline, color = c.primary)
        Text(
            done,
            Modifier
                .align(Alignment.CenterEnd)
                .background(c.accent, CircleShape)
                .clickable(role = Role.Button, onClick = onDone)
                .padding(horizontal = 16.dp, vertical = 8.dp),
            style = StarlingsType.headline,
            color = c.accentInk,
        )
    }
}

/**
 * `StarlingsList` (EnvisioningList): a grouped section, its header in
 * footnote secondary ink over a panel group with hairline separators.
 */
@Composable
fun ListSection(header: String?, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val c = Starlings.colors
    Column(modifier.fillMaxWidth()) {
        header?.let {
            Text(it, Modifier.padding(start = 16.dp, bottom = 6.dp), style = StarlingsType.footnote, color = c.secondary)
        }
        Column(Modifier.fillMaxWidth().background(c.panel, shape(StarlingsRadius.field)), content = content)
    }
}

/** One row of a `ListSection`; `divider` draws the hairline under it. */
@Composable
fun ListRow(modifier: Modifier = Modifier, divider: Boolean = false, content: @Composable ColumnScope.() -> Unit) {
    val c = Starlings.colors
    Column(modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 11.dp), verticalArrangement = Arrangement.spacedBy(6.dp), content = content)
    if (divider) HorizontalDivider(Modifier.padding(start = 16.dp), thickness = 1.dp, color = c.border)
}

/** A caption line with an optional leading symbol, as iOS `Label(…).font(.caption)`. */
@Composable
fun CaptionLabel(text: String, icon: ImageVector? = null, color: Color = Starlings.colors.secondary) {
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
        // Decorative: the text beside it says the same.
        icon?.let { Icon(it, null, Modifier.size(14.dp), tint = color) }
        Text(text, style = StarlingsType.caption, color = color)
    }
}
