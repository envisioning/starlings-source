package work.starlings.android.workspace.team

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import work.starlings.android.MarkdownBlock
import work.starlings.android.MarkdownBlockKind
import work.starlings.android.MarkdownSpan
import work.starlings.android.ThreadMarkdown
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsType

/**
 * `iOS/MobileMarkdownText.swift`: the parsed blocks of [ThreadMarkdown],
 * drawn. A mention is accent and bold, never underlined; a link (already
 * clamped to http, https or mailto) is accent and underlined.
 */
@Composable
fun MarkdownText(text: String, mentionedEmails: List<String>, modifier: Modifier = Modifier, style: TextStyle = StarlingsType.body, color: Color = Starlings.colors.primary) {
    val blocks = remember(text, mentionedEmails) {
        ThreadMarkdown.highlightingMentions(ThreadMarkdown.parse(text), mentionedEmails)
    }
    val c = Starlings.colors
    Column(modifier) {
        blocks.forEachIndexed { index, block ->
            val gap = gap(block, blocks.getOrNull(index - 1))
            Box(Modifier.padding(top = gap)) {
                when (val kind = block.kind) {
                    MarkdownBlockKind.Paragraph -> Text(markdownAnnotated(block.spans, c.accentMark), style = style, color = color)
                    is MarkdownBlockKind.Heading -> Text(
                        markdownAnnotated(block.spans, c.accentMark),
                        style = when (kind.level) {
                            1 -> StarlingsType.title3
                            2 -> StarlingsType.headline
                            else -> StarlingsType.subheadline
                        }.copy(fontWeight = FontWeight.Bold),
                        color = color,
                    )
                    is MarkdownBlockKind.Bullet -> Marked("•", kind.level, block, style, color)
                    is MarkdownBlockKind.Ordered -> Marked("${kind.number}.", kind.level, block, style, color)
                    MarkdownBlockKind.Quote -> Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(Modifier.width(2.dp).fillMaxHeight().background(c.secondary))
                        Text(markdownAnnotated(block.spans, c.accentMark), style = style, color = c.secondary)
                    }
                    is MarkdownBlockKind.Code -> SelectionContainer {
                        // Scrolled, not wrapped: a wrapped command line is one nobody copies right.
                        Text(
                            kind.text,
                            Modifier
                                .fillMaxWidth()
                                .background(c.primary.copy(alpha = 0.06f), RoundedCornerShape(StarlingsRadius.field))
                                .horizontalScroll(rememberScrollState())
                                .padding(8.dp),
                            style = StarlingsType.footnote.copy(fontFamily = FontFamily.Monospace),
                            color = color,
                            softWrap = false,
                        )
                    }
                }
            }
        }
    }
}

/** Air between paragraphs, more above a heading, almost none inside a list. */
private fun gap(block: MarkdownBlock, previous: MarkdownBlock?): Dp {
    previous ?: return 0.dp
    if (block.kind.isItem() && previous.kind.isItem()) return 3.dp
    if (block.kind is MarkdownBlockKind.Heading) return 11.dp
    return 8.dp
}

private fun MarkdownBlockKind.isItem() = this is MarkdownBlockKind.Bullet || this is MarkdownBlockKind.Ordered

/** A list line: the marker in its own column, one indent step per level. */
@Composable
private fun Marked(marker: String, level: Int, block: MarkdownBlock, style: TextStyle, color: Color) {
    val c = Starlings.colors
    Row(Modifier.padding(start = (level * 14).dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(marker, Modifier.widthIn(min = 14.dp), style = style, color = c.secondary)
        Text(markdownAnnotated(block.spans, c.accentMark), style = style, color = color)
    }
}

/** The runs of a block as styled text: code, bold, italic, struck, a mention in accent, a link underlined. Core's Markdown reads its runs the same way. */
internal fun markdownAnnotated(spans: List<MarkdownSpan>, accent: Color): AnnotatedString = buildAnnotatedString {
    for (span in spans) {
        var s = SpanStyle()
        if (span.code) s = s.merge(SpanStyle(fontFamily = FontFamily.Monospace))
        if (span.bold) s = s.merge(SpanStyle(fontWeight = FontWeight.Bold))
        if (span.italic) s = s.merge(SpanStyle(fontStyle = FontStyle.Italic))
        if (span.strike) s = s.merge(SpanStyle(textDecoration = TextDecoration.LineThrough))
        if (span.mention != null) s = s.merge(SpanStyle(color = accent, fontWeight = FontWeight.Bold))
        val link = span.link
        if (link != null) {
            val linkStyle = s.merge(SpanStyle(color = accent, textDecoration = TextDecoration.Underline))
            withLink(LinkAnnotation.Url(link, TextLinkStyles(style = linkStyle))) { append(span.text) }
        } else {
            withStyle(s) { append(span.text) }
        }
    }
}
