package work.starlings.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import work.starlings.android.MarkdownBlock
import work.starlings.android.MarkdownBlockKind
import work.starlings.android.MarkdownSpan
import work.starlings.android.ThreadMarkdown

/**
 * The list and state controls the Docs tab wears, beside `Controls.kt`:
 * EnvisioningUI's retry, empty, loading and placeholder states, the
 * folding rail section (`MobileRailSection`), and Markdown drawn from
 * [ThreadMarkdown]'s blocks.
 */

/** `MobileRailSection`: a grouped section whose header folds it. [folded] is the caller's, saved under the table's key. */
@Composable
fun FoldingSection(
    title: String,
    folded: Boolean,
    onFold: (Boolean) -> Unit,
    collapsed: String,
    expanded: String,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = Starlings.colors
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button) { onFold(!folded) }
                .semantics(mergeDescendants = true) {
                    heading()
                    stateDescription = if (folded) collapsed else expanded
                }
                .padding(start = 16.dp, end = 12.dp, top = 10.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(title, Modifier.weight(1f), style = StarlingsType.footnote, color = c.secondary)
            Icon(
                Icons.Filled.ChevronRight, null,
                Modifier.size(16.dp).rotate(if (folded) 0f else 90f),
                tint = c.secondary,
            )
        }
        if (!folded) {
            Column(Modifier.fillMaxWidth().background(c.panel, RoundedCornerShape(StarlingsRadius.field)), content = content)
        }
    }
}

/**
 * One navigable row of a grouped list: a symbol, the title, a count in
 * secondary ink. With [menu], a long press opens it (iOS `contextMenu`);
 * [menuLabel] names that action for TalkBack.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun NavigationRow(
    title: String,
    icon: ImageVector,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    count: Int? = null,
    divider: Boolean = false,
    menuLabel: String? = null,
    menu: (@Composable (dismiss: () -> Unit) -> Unit)? = null,
) {
    val c = Starlings.colors
    var open by remember { mutableStateOf(false) }
    Box {
        Row(
            modifier
                .fillMaxWidth()
                .heightIn(min = 44.dp)
                .combinedClickable(
                    role = Role.Button,
                    onLongClickLabel = if (menu != null) menuLabel else null,
                    onLongClick = if (menu != null) ({ open = true }) else null,
                    onClick = onClick,
                )
                .padding(horizontal = 16.dp, vertical = 11.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Decorative: the title says what the row is.
            Icon(icon, null, Modifier.size(20.dp), tint = c.accentMark)
            Text(title, Modifier.weight(1f), style = StarlingsType.body, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            count?.let { Text("$it", style = StarlingsType.body, color = c.secondary) }
        }
        if (menu != null) {
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) { menu { open = false } }
        }
    }
    if (divider) HorizontalDivider(Modifier.padding(start = 48.dp), thickness = 1.dp, color = c.border)
}

/** `EnvisioningRetryState`: a headline, the reason, and Retry. */
@Composable
fun RetryState(title: String, message: String, retry: String, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    val c = Starlings.colors
    Column(
        modifier.fillMaxSize().padding(StarlingsSpacing.screenCentred),
        verticalArrangement = Arrangement.spacedBy(StarlingsSpacing.titleGap, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, style = StarlingsType.headline, color = c.primary, textAlign = TextAlign.Center)
        if (message.isNotEmpty()) Text(message, style = StarlingsType.subheadline, color = c.secondary, textAlign = TextAlign.Center)
        Spacer(Modifier.height(StarlingsSpacing.titleGap))
        BorderedButton(retry, onRetry, compact = true)
    }
}

/** `EnvisioningEmptyState`: a symbol, a headline and one line. */
@Composable
fun EmptyState(title: String, icon: ImageVector, message: String, modifier: Modifier = Modifier) {
    val c = Starlings.colors
    Column(
        modifier.fillMaxSize().padding(StarlingsSpacing.screenCentred),
        verticalArrangement = Arrangement.spacedBy(StarlingsSpacing.titleGap, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, null, Modifier.size(40.dp), tint = c.secondary)
        Text(title, style = StarlingsType.headline, color = c.primary, textAlign = TextAlign.Center)
        Text(message, style = StarlingsType.subheadline, color = c.secondary, textAlign = TextAlign.Center)
    }
}

/** `EnvisioningLoadingState`: a spinner over one line. */
@Composable
fun LoadingState(text: String, modifier: Modifier = Modifier) {
    val c = Starlings.colors
    Column(
        modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator(Modifier.size(24.dp), color = c.secondary, strokeWidth = 2.dp)
        Text(text, style = StarlingsType.subheadline, color = c.secondary)
    }
}

/** `EnvisioningPlaceholderRows`: grey bars where rows will be. TalkBack hears [label] once. */
@Composable
fun PlaceholderRows(count: Int, label: String, modifier: Modifier = Modifier) {
    val c = Starlings.colors
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .background(c.panel, RoundedCornerShape(StarlingsRadius.field))
            .clearAndSetSemantics { contentDescription = label },
    ) {
        repeat(count) { index ->
            Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.fillMaxWidth(0.6f).height(14.dp).background(c.elevated, RoundedCornerShape(4.dp)))
                Box(Modifier.fillMaxWidth(0.35f).height(10.dp).background(c.elevated, RoundedCornerShape(4.dp)))
            }
            if (index < count - 1) HorizontalDivider(Modifier.padding(start = 16.dp), thickness = 1.dp, color = c.border)
        }
    }
}

/**
 * DocsUI's `CategoryPicker`: a menu of "No category" and [choices] (id,
 * label), in rail order. A category the list does not hold still shows by
 * its readable id rather than as a blank. [label] is what TalkBack says.
 */
@Composable
fun CategoryPicker(
    category: String?,
    choices: List<Pair<String, String>>,
    none: String,
    label: String,
    onChange: (String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = Starlings.colors
    var open by remember { mutableStateOf(false) }
    val listed = choices.toMutableList()
    if (category != null && listed.none { it.first == category }) {
        listed += category to work.starlings.android.workspace.docs.DocsRules.fallbackLabel(category)
    }
    val current = category?.let { id -> listed.firstOrNull { it.first == id }?.second } ?: none
    Box(modifier) {
        Row(
            Modifier
                .clickable(role = Role.Button) { open = true }
                .semantics(mergeDescendants = true) { contentDescription = "$label, $current" }
                .padding(horizontal = 8.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(current, style = StarlingsType.subheadline, color = c.accentMark, maxLines = 1)
            Icon(Icons.Filled.UnfoldMore, null, Modifier.size(14.dp), tint = c.accentMark)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text(none) },
                trailingIcon = { if (category == null) Icon(Icons.Filled.Check, null) },
                onClick = { open = false; onChange(null) },
            )
            listed.forEach { (id, text) ->
                DropdownMenuItem(
                    text = { Text(text) },
                    trailingIcon = { if (category == id) Icon(Icons.Filled.Check, null) },
                    onClick = { open = false; onChange(id) },
                )
            }
        }
    }
}

/**
 * `meetToolbarProminent`: the toolbar's one creating action, an accent
 * circle with dark ink. [label] is what TalkBack says.
 */
@Composable
fun ProminentIconButton(icon: ImageVector, label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Starlings.colors
    Box(
        modifier
            .padding(horizontal = 4.dp)
            .size(36.dp)
            .background(c.accent, CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = label; role = Role.Button },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, Modifier.size(20.dp), tint = c.accentInk)
    }
}

/** A small capsule: DocsUI's `SubjectChips`. */
@Composable
fun SmallChip(text: String, modifier: Modifier = Modifier) {
    val c = Starlings.colors
    Text(
        text,
        modifier.background(c.secondary.copy(alpha = 0.14f), CircleShape).padding(horizontal = 6.dp, vertical = 2.dp),
        style = StarlingsType.caption2,
        color = c.primary,
        maxLines = 1,
    )
}

/**
 * Markdown in the subset [ThreadMarkdown] parses: headings, paragraphs,
 * lists, quotes, fenced code, and inline bold, italic, strikethrough, code
 * and links. Links open in the browser. [base] sets the body size.
 */
@Composable
fun MarkdownText(markdown: String, modifier: Modifier = Modifier, base: TextStyle = StarlingsType.body) {
    val blocks = ThreadMarkdown.parse(markdown)
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        blocks.forEach { MarkdownBlockView(it, base) }
    }
}

@Composable
private fun MarkdownBlockView(block: MarkdownBlock, base: TextStyle) {
    val c = Starlings.colors
    when (val kind = block.kind) {
        is MarkdownBlockKind.Heading -> {
            val style = when (kind.level) {
                1 -> StarlingsType.title2.copy(fontWeight = FontWeight.SemiBold)
                2 -> StarlingsType.title3.copy(fontWeight = FontWeight.SemiBold)
                else -> StarlingsType.headline
            }
            Text(spansText(block.spans), Modifier.semantics { heading() }, style = style, color = c.primary)
        }
        MarkdownBlockKind.Paragraph -> Text(spansText(block.spans), style = base, color = c.primary)
        is MarkdownBlockKind.Bullet -> ListItem("•", kind.level, block.spans, base)
        is MarkdownBlockKind.Ordered -> ListItem("${kind.number}.", kind.level, block.spans, base)
        MarkdownBlockKind.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
            Box(Modifier.width(3.dp).fillMaxHeight().background(c.border))
            Spacer(Modifier.width(10.dp))
            Text(spansText(block.spans), style = base, color = c.secondary)
        }
        is MarkdownBlockKind.Code -> Text(
            kind.text,
            Modifier.fillMaxWidth().background(c.field, RoundedCornerShape(8.dp)).padding(10.dp),
            style = base.copy(fontFamily = FontFamily.Monospace, fontSize = StarlingsType.footnote.fontSize),
            color = c.primary,
        )
    }
}

@Composable
private fun ListItem(marker: String, level: Int, spans: List<MarkdownSpan>, base: TextStyle) {
    val c = Starlings.colors
    Row(Modifier.padding(start = (level * 16).dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(marker, style = base, color = c.secondary)
        Text(spansText(spans), style = base, color = c.primary)
    }
}

@Composable
private fun spansText(spans: List<MarkdownSpan>): AnnotatedString {
    val c = Starlings.colors
    val linkStyles = TextLinkStyles(SpanStyle(color = c.accentMark, textDecoration = TextDecoration.Underline))
    return buildAnnotatedString {
        for (span in spans) {
            val style = SpanStyle(
                fontWeight = if (span.bold) FontWeight.SemiBold else null,
                fontStyle = if (span.italic) FontStyle.Italic else null,
                textDecoration = if (span.strike) TextDecoration.LineThrough else null,
                fontFamily = if (span.code) FontFamily.Monospace else null,
                background = if (span.code) c.field else Color.Unspecified,
            )
            val link = span.link
            if (link != null) {
                withLink(LinkAnnotation.Url(link, linkStyles)) { withStyle(style) { append(span.text) } }
            } else {
                withStyle(style) { append(span.text) }
            }
        }
    }
}
