package work.starlings.android.ui

import work.starlings.android.R
import kotlinx.coroutines.delay
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The Work tab's row and section chrome: `MobileWorkRow`,
 * `MobileCompactMark` and `WorkGlyphMark` (iOS/StarlingsMobileDesign.swift,
 * iOS/PeerRosterViews.swift), `WorkSidebarRow` (iOS/WorkSidebarRow.swift),
 * and the grouped list's section with a folding header.
 */

/** `MobileCompactMark` / `WorkGlyphMark`: a symbol in neutral ink in a well on the elevated rung, square or round. */
@Composable
fun WorkMark(icon: ImageVector, size: Dp = 24.dp, square: Boolean = true, glyphScale: Float = 0.5f, color: Color = Starlings.colors.secondary) {
    val c = Starlings.colors
    val shape = if (square) RoundedCornerShape(size * 0.25f) else CircleShape
    Box(
        Modifier.size(size).background(c.elevated, shape).border(1.dp, c.border, shape).clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, Modifier.size(size * glyphScale), tint = color)
    }
}

/**
 * `MobileWorkRow`: the leading mark in an 18 slot, the title in body on one
 * line, the metadata in caption secondary on one line under it.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun WorkRow(
    title: String,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
    leading: @Composable () -> Unit,
    metadata: @Composable RowScope.() -> Unit,
) {
    val c = Starlings.colors
    Row(
        modifier
            .fillMaxWidth()
            .then(
                if (onClick != null) Modifier.combinedClickable(role = Role.Button, onLongClick = onLongClick, onClick = onClick) else Modifier,
            )
            .padding(horizontal = 16.dp, vertical = 9.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(Modifier.width(18.dp).padding(top = 2.dp), contentAlignment = Alignment.Center) { leading() }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = StarlingsType.body, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically, content = metadata)
        }
    }
}

/** One caption part of a row's metadata line; `strong` is the bold overdue date. */
@Composable
fun WorkMeta(text: String, strong: Boolean = false) {
    val c = Starlings.colors
    Text(
        text,
        style = StarlingsType.caption.copy(fontWeight = if (strong) FontWeight.Bold else FontWeight.Normal),
        color = if (strong) c.primary else c.secondary,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

/**
 * `WorkSidebarRow`: a 40 glyph well (with the star badge), the title in
 * body at the spec's weight and ink, a caption subtitle up to two lines,
 * and the unread dot. `label` replaces what TalkBack reads when set.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun WorkSidebarRow(
    icon: ImageVector,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    weight: FontWeight = FontWeight.Medium,
    subdued: Boolean = false,
    starred: Boolean = false,
    unreadDot: Boolean = false,
    label: String? = null,
    onLongClick: (() -> Unit)? = null,
    square: Boolean = false,
) {
    val c = Starlings.colors
    Row(
        modifier
            .fillMaxWidth()
            .combinedClickable(role = Role.Button, onLongClick = onLongClick, onClick = onClick)
            .then(if (label != null) Modifier.clearAndSetSemantics { contentDescription = label; role = Role.Button } else Modifier)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            WorkMark(icon, size = 40.dp, square = square, glyphScale = 0.42f)
            if (starred) {
                Box(
                    Modifier.offset((-4).dp, (-4).dp).size(16.dp).background(c.canvas, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.Star, null, Modifier.size(9.dp), tint = c.secondary)
                }
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = StarlingsType.body.copy(fontWeight = weight), color = if (subdued) c.secondary else c.primary)
            if (subtitle.isNotEmpty()) {
                Text(subtitle, style = StarlingsType.caption, color = c.secondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        if (unreadDot) Box(Modifier.size(9.dp).background(c.primary, CircleShape))
    }
}

/**
 * A grouped list section: the header row over a panel group, the footer in
 * footnote secondary under it (`StarlingsList` `Section { } header: { } footer: { }`).
 */
@Composable
fun WorkSection(
    modifier: Modifier = Modifier,
    header: (@Composable RowScope.() -> Unit)? = null,
    footer: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = Starlings.colors
    Column(modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        if (header != null) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 32.dp).padding(start = 16.dp, end = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                content = header,
            )
        }
        Column(Modifier.fillMaxWidth().background(c.panel, RoundedCornerShape(StarlingsRadius.field)).padding(vertical = 4.dp), content = content)
        if (footer != null) {
            Text(footer, Modifier.padding(start = 16.dp, end = 16.dp, top = 6.dp), style = StarlingsType.footnote, color = c.secondary)
        }
    }
}

/** A section header's plain title. */
@Composable
fun WorkHeaderTitle(text: String) {
    Text(text, style = StarlingsType.footnote.copy(fontWeight = FontWeight.SemiBold), color = Starlings.colors.secondary)
}

/** `foldTitle`: chevron then the name; TalkBack reads Folded or Open. */
@Composable
fun WorkFoldTitle(text: String, folded: Boolean, foldedLabel: String, openLabel: String, onToggle: () -> Unit) {
    val c = Starlings.colors
    Row(
        Modifier
            .clickable(role = Role.Button, onClick = onToggle)
            .semantics { stateDescription = if (folded) foldedLabel else openLabel }
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(if (folded) Icons.AutoMirrored.Filled.KeyboardArrowRight else Icons.Filled.KeyboardArrowDown, null, Modifier.size(14.dp), tint = c.secondary)
        WorkHeaderTitle(text)
    }
}

/** A quiet footnote line inside a section: empty states and caps. */
@Composable
fun WorkNote(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 9.dp), style = StarlingsType.footnote, color = Starlings.colors.secondary)
}

/** A plain tappable row in a section: a text button in primary ink, or danger. */
@Composable
fun WorkActionRow(text: String, onClick: () -> Unit, enabled: Boolean = true, danger: Boolean = false, accent: Boolean = false) {
    val c = Starlings.colors
    Text(
        text,
        Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        style = StarlingsType.body,
        color = when {
            danger -> c.danger
            accent -> c.accent
            else -> c.primary
        }.copy(alpha = if (enabled) 1f else 0.45f),
    )
}

/** `LabeledContent`: the label left in primary, the value right in secondary. */
@Composable
fun WorkLabeledRow(label: String, value: String, onClick: (() -> Unit)? = null) {
    val c = Starlings.colors
    Row(
        Modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(horizontal = 16.dp, vertical = 11.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = StarlingsType.body, color = c.primary)
        Spacer(Modifier.weight(1f))
        Text(value, style = StarlingsType.body, color = c.secondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
        if (onClick != null) Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(18.dp), tint = c.secondary)
    }
}

/** The hairline between rows of a section. */
@Composable
fun WorkDivider() {
    HorizontalDivider(Modifier.padding(start = 16.dp), thickness = 1.dp, color = Starlings.colors.border)
}

/** `StarlingsErrorNotice`: the message in danger ink, an optional age line and Retry. */
@Composable
fun WorkErrorNotice(message: String, retry: String? = null, onRetry: (() -> Unit)? = null, updated: String? = null) {
    val c = Starlings.colors
    // Errors are red with Copy on every surface, as `StarlingsErrorNotice` on iOS.
    val clipboard = LocalClipboardManager.current
    var copied by remember(message) { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_500)
            copied = false
        }
    }
    val action = StarlingsType.callout.copy(fontWeight = FontWeight.SemiBold)
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(message, style = StarlingsType.callout, color = c.danger)
        if (updated != null) Text(updated, style = StarlingsType.footnote, color = c.secondary)
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(
                stringResource(if (copied) R.string.sharesheet_copied else R.string.sharesheet_copy),
                Modifier.clickable(role = Role.Button) {
                    clipboard.setText(AnnotatedString(message))
                    copied = true
                }.padding(vertical = 4.dp),
                style = action,
                color = c.primary,
            )
            if (retry != null && onRetry != null) {
                Text(
                    retry,
                    Modifier.clickable(role = Role.Button, onClick = onRetry).padding(vertical = 4.dp),
                    style = action,
                    color = c.primary,
                )
            }
        }
    }
}

/** `EnvisioningPlaceholderRows`: three quiet bars while a list has nothing to stand in for it. */
@Composable
fun WorkPlaceholderRows() {
    val c = Starlings.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp).clearAndSetSemantics { }, verticalArrangement = Arrangement.spacedBy(14.dp)) {
        listOf(0.7f, 0.5f, 0.6f).forEach { width ->
            Box(Modifier.fillMaxWidth(width).height(12.dp).background(c.elevated, RoundedCornerShape(6.dp)))
        }
    }
}

/**
 * The inline navigation bar of a pushed page: Back (labelled), the title
 * centred in headline, and trailing actions.
 */
@Composable
fun WorkTopBar(title: String, backLabel: String, onBack: () -> Unit, actions: @Composable RowScope.() -> Unit = {}) {
    val c = Starlings.colors
    Box(Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 4.dp)) {
        Box(
            Modifier
                .align(Alignment.CenterStart)
                .size(44.dp)
                .clickable(role = Role.Button, onClick = onBack)
                .clearAndSetSemantics { contentDescription = backLabel; role = Role.Button },
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, null, tint = c.primary)
        }
        Text(
            title,
            Modifier.align(Alignment.Center).padding(horizontal = 96.dp),
            style = StarlingsType.headline,
            color = c.primary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Row(Modifier.align(Alignment.CenterEnd), verticalAlignment = Alignment.CenterVertically, content = actions)
    }
}

/** A 44 icon button for a bar; [label] is what TalkBack says. */
@Composable
fun WorkIconButton(icon: ImageVector, label: String, onClick: () -> Unit, tint: Color = Starlings.colors.primary) {
    Box(
        Modifier
            .size(44.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = label; role = Role.Button },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, Modifier.size(22.dp), tint = tint)
    }
}

/** One choice on a row: its menu entry, its TalkBack action, and maybe its swipe. */
class WorkRowAction(
    val title: String,
    val danger: Boolean = false,
    val startsGroup: Boolean = false,
    /** A submenu's caption ("Assign to"): drawn, never performed. */
    val header: Boolean = false,
    val run: () -> Unit = {},
)

/**
 * A row with a long-press menu (`.contextMenu { WorkRowActionMenu }`): the
 * actions in order, a destructive one in danger ink. TalkBack reads each as
 * a custom action. [content] gets the long-press to hand to its row.
 */
@Composable
fun WorkRowMenu(actions: List<WorkRowAction>, content: @Composable (onLongClick: (() -> Unit)?) -> Unit) {
    val c = Starlings.colors
    var open by remember { mutableStateOf(false) }
    Box(
        Modifier.semantics {
            if (actions.isNotEmpty()) customActions = actions.filter { !it.header }.map { action -> CustomAccessibilityAction(action.title) { action.run(); true } }
        },
    ) {
        content(if (actions.isEmpty()) null else ({ open = true }))
        DropdownMenu(open, { open = false }, containerColor = c.elevated, shape = RoundedCornerShape(14.dp)) {
            actions.forEachIndexed { index, action ->
                if (index > 0 && action.startsGroup) HorizontalDivider(color = c.border)
                if (action.header) {
                    Text(action.title, Modifier.padding(horizontal = 16.dp, vertical = 6.dp), style = StarlingsType.footnote, color = c.secondary)
                    return@forEachIndexed
                }
                DropdownMenuItem(
                    text = { Text(action.title, style = StarlingsType.body, color = if (action.danger) c.danger else c.primary) },
                    onClick = { open = false; action.run() },
                )
            }
        }
    }
}

/**
 * A row's trailing swipe (`.swipeActions(edge: .trailing)`): one action,
 * the accent fill, or danger for a destructive one. The row springs back;
 * the action's own write removes it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkSwipeRow(
    title: String,
    icon: ImageVector,
    onAction: () -> Unit,
    danger: Boolean = false,
    leading: WorkRowAction? = null,
    leadingIcon: ImageVector? = null,
    content: @Composable () -> Unit,
) {
    val c = Starlings.colors
    val state = rememberSwipeToDismissBoxState(
        confirmValueChange = { value ->
            if (value == SwipeToDismissBoxValue.EndToStart) onAction()
            if (value == SwipeToDismissBoxValue.StartToEnd) leading?.run?.invoke()
            false
        },
    )
    SwipeToDismissBox(
        state = state,
        enableDismissFromStartToEnd = leading != null,
        backgroundContent = {
            // The leading swipe (`.swipeActions(edge: .leading)`) is a plain secondary well.
            if (leading != null && state.dismissDirection == SwipeToDismissBoxValue.StartToEnd) {
                Box(Modifier.fillMaxSize().background(c.elevated).padding(horizontal = 20.dp), contentAlignment = Alignment.CenterStart) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        leadingIcon?.let { Icon(it, null, tint = c.primary) }
                        Text(leading.title, style = StarlingsType.subheadline.copy(fontWeight = FontWeight.SemiBold), color = c.primary)
                    }
                }
                return@SwipeToDismissBox
            }
            Box(Modifier.fillMaxSize().background(if (danger) c.danger else c.accent).padding(horizontal = 20.dp), contentAlignment = Alignment.CenterEnd) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(icon, null, tint = if (danger) c.canvas else c.accentInk)
                    Text(title, style = StarlingsType.subheadline.copy(fontWeight = FontWeight.SemiBold), color = if (danger) c.canvas else c.accentInk)
                }
            }
        },
    ) {
        Box(Modifier.background(c.panel)) { content() }
    }
}

/**
 * A sheet over the screen (`NavigationStack` in `.sheet` with
 * `StarlingsSheetCloseButton`): Close at the leading edge, the title inline,
 * the content in a scroll.
 */
@Composable
fun WorkSheet(
    title: String,
    closeLabel: String,
    onDismiss: () -> Unit,
    confirm: String? = null,
    confirmEnabled: Boolean = true,
    onConfirm: () -> Unit = {},
    /** False when the content fills the sheet and scrolls itself (a Keep gate). */
    scrolls: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = Starlings.colors
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Column(Modifier.fillMaxSize().background(c.canvas).imePadding()) {
            Box(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 8.dp)) {
                Box(Modifier.align(Alignment.CenterStart)) { WorkIconButton(Icons.Filled.Close, closeLabel, onDismiss) }
                Text(title, Modifier.align(Alignment.Center).padding(horizontal = 96.dp), style = StarlingsType.headline, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                // The confirm is the filled pill (`meetToolbarConfirm`).
                if (confirm != null) {
                    Text(
                        confirm,
                        Modifier
                            .align(Alignment.CenterEnd)
                            .background(c.accent.copy(alpha = if (confirmEnabled) 1f else 0.45f), CircleShape)
                            .clickable(enabled = confirmEnabled, role = Role.Button, onClick = onConfirm)
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                        style = StarlingsType.headline,
                        color = c.accentInk,
                    )
                }
            }
            Column(
                Modifier.fillMaxSize().then(if (scrolls) Modifier.verticalScroll(rememberScrollState()).padding(vertical = 8.dp) else Modifier),
                verticalArrangement = Arrangement.spacedBy(18.dp),
                content = content,
            )
        }
    }
}
