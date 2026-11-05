package work.starlings.android.workspace.team

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextOverflow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import work.starlings.contracts.LinkPreview
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.automirrored.filled.FormatListBulleted
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.DataObject
import androidx.compose.material.icons.filled.FormatBold
import androidx.compose.material.icons.filled.FormatItalic
import androidx.compose.material.icons.filled.FormatListNumbered
import androidx.compose.material.icons.filled.FormatQuote
import androidx.compose.material.icons.filled.FormatStrikethrough
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.TextFormat
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.CheckBoxOutlineBlank
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.RadioButtonChecked
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import work.starlings.android.R
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsType
import work.starlings.contracts.ThreadMessageRef
import work.starlings.contracts.ThreadMessageRefKind
import work.starlings.contracts.ThreadMessageWire
import androidx.compose.material.icons.filled.Close
import work.starlings.contracts.ThreadQuestion
import work.starlings.contracts.ThreadQuestionMode

/**
 * `MessageLinkPreview` and `LinkPreviewCard`: the Worker's unfurl of the
 * message's first https link. Every field is the publisher's text, drawn as
 * text. Nothing draws when the page gave no title and no description.
 */
@Composable
fun MessageLinkCard(text: String, store: ThreadStore) {
    val c = Starlings.colors
    val preview by produceState<LinkPreview?>(null, text) { value = store.linkPreview(text) }
    val p = preview ?: return
    if (p.title.isNullOrEmpty() && p.description.isNullOrEmpty()) return
    if (!p.url.startsWith("https://")) return
    val uri = LocalUriHandler.current
    val image by produceState<ImageBitmap?>(null, p.imageUrl) {
        value = p.imageUrl?.takeIf { it.isNotEmpty() }?.let { store.previewImage(it) }
            ?.let { bytes -> withContext(Dispatchers.Default) { runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }.getOrNull() } }
    }
    val shape = RoundedCornerShape(StarlingsRadius.control)
    Row(
        Modifier
            .widthIn(max = 420.dp)
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .clip(shape)
            .background(c.elevated, shape)
            .clickable(role = Role.Button) { runCatching { uri.openUri(p.url) } },
    ) {
        // The accent rule the Mac and the web both draw.
        Box(Modifier.padding(vertical = 4.dp).width(3.dp).fillMaxHeight().background(c.accent.copy(alpha = 0.55f), RoundedCornerShape(1.5.dp)))
        Column(Modifier.padding(horizontal = 10.dp, vertical = 7.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (!p.imageUrl.isNullOrEmpty()) {
                // A fixed box, not the picture's own shape: the transcript must not reflow as each lands.
                Box(Modifier.fillMaxWidth().aspectRatio(1.91f).clip(RoundedCornerShape(StarlingsRadius.field)).background(c.field).padding(bottom = 2.dp)) {
                    image?.let { Image(it, p.imageAlt?.takeIf { alt -> alt.isNotEmpty() }, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
                }
            }
            Text(p.siteName?.takeIf { it.isNotEmpty() } ?: p.domain, style = StarlingsType.caption2.copy(fontWeight = FontWeight.SemiBold), color = c.secondary)
            p.title?.takeIf { it.isNotEmpty() }?.let { Text(it, style = StarlingsType.footnote.copy(fontWeight = FontWeight.SemiBold), color = c.primary, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            p.description?.takeIf { it.isNotEmpty() }?.let { Text(it, style = StarlingsType.caption, color = c.secondary, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
    }
}

/** The composer's format menu (`formatMenu`): each action edits the field's text and selection. */
@Composable
fun FormatButton(field: TextFieldValue, onEdit: (TextFieldValue) -> Unit) {
    val c = Starlings.colors
    var menu by remember { mutableStateOf(false) }
    val placeholders = ThreadMarkdownEditing.Placeholders(stringResource(R.string.thread_bold_text), stringResource(R.string.thread_italic_text))
    val label = stringResource(R.string.thread_format)
    fun run(action: FormatAction) {
        menu = false
        val edit = ThreadMarkdownEditing.apply(action, field.text, field.selection.start, field.selection.end, placeholders)
        onEdit(TextFieldValue(edit.text, TextRange(edit.start, edit.end)))
    }
    Box {
        Box(
            Modifier
                .size(32.dp)
                .background(c.panel, CircleShape)
                .border(1.dp, c.border, CircleShape)
                .clickable(role = Role.Button) { menu = true }
                .clearAndSetSemantics { contentDescription = label; role = Role.Button },
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Filled.TextFormat, null, Modifier.size(18.dp), tint = c.secondary) }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            FORMAT_ITEMS.forEachIndexed { index, (action, item) ->
                if (index == 5) HorizontalDivider(color = c.border)
                DropdownMenuItem(
                    text = { Text(stringResource(item.first)) },
                    leadingIcon = { Icon(item.second, null) },
                    onClick = { run(action) },
                )
            }
        }
    }
}

private val FORMAT_ITEMS = listOf(
    FormatAction.BOLD to (R.string.thread_bold to Icons.Filled.FormatBold),
    FormatAction.ITALIC to (R.string.thread_italic to Icons.Filled.FormatItalic),
    FormatAction.STRIKETHROUGH to (R.string.thread_strikethrough to Icons.Filled.FormatStrikethrough),
    FormatAction.INLINE_CODE to (R.string.thread_inline_code to Icons.Filled.Code),
    FormatAction.LINK to (R.string.thread_link to Icons.Filled.Link),
    FormatAction.BULLETED_LIST to (R.string.thread_bulleted_list to Icons.AutoMirrored.Filled.FormatListBulleted),
    FormatAction.NUMBERED_LIST to (R.string.thread_numbered_list to Icons.Filled.FormatListNumbered),
    FormatAction.QUOTE to (R.string.thread_quote to Icons.Filled.FormatQuote),
    FormatAction.CODE_BLOCK to (R.string.thread_code_block to Icons.Filled.DataObject),
)

/*
 * The parts a message row carries under its bubble, as `MessageRow` in
 * `iOS/MobileThreadView.swift`: the reply line and the agent's question.
 */

@Composable
private fun ReplyPreview.authorText(): String = when (val a = author) {
    ReplyPreview.Author.EarlierMessage -> stringResource(R.string.thread_earlier_message)
    is ReplyPreview.Author.Named -> a.shortName
}

@Composable
private fun ReplyPreview.lineText(): String = when (val t = text) {
    ReplyPreview.Text.None -> ""
    ReplyPreview.Text.Withdrawn -> stringResource(R.string.thread_withdrawn)
    ReplyPreview.Text.Message -> stringResource(R.string.thread_message)
    ReplyPreview.Text.Attachment -> stringResource(R.string.thread_attachment)
    is ReplyPreview.Text.Quote -> t.line
}

/**
 * The parent a reply answers. On a subject channel it is a panel that
 * jumps to the parent ([onJump], `supportsMessageReplies`); elsewhere one
 * quiet line that only reads.
 */
@Composable
fun ReplyLine(parent: ThreadMessageWire?, onJump: (() -> Unit)? = null) {
    val c = Starlings.colors
    val content = ReplyPreview.resolve(parent)
    val author = content.authorText()
    val line = content.lineText()
    val title = if (line.isEmpty()) author else "$author: $line"
    if (onJump != null) {
        val label = stringResource(R.string.thread_reply_to_jump, title)
        Row(
            Modifier
                .fillMaxWidth()
                .background(c.panel, RoundedCornerShape(StarlingsRadius.control))
                .clickable(role = Role.Button, onClick = onJump)
                .clearAndSetSemantics { contentDescription = label; role = Role.Button }
                .padding(horizontal = 9.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Icons.AutoMirrored.Filled.Reply, null, Modifier.size(12.dp), tint = c.secondary)
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(author, style = StarlingsType.caption2.copy(fontWeight = FontWeight.SemiBold), color = c.secondary)
                if (line.isNotEmpty()) Text(line, style = StarlingsType.caption2, color = c.secondary, maxLines = 2)
            }
        }
        return
    }
    val label = stringResource(R.string.thread_reply_to, title)
    Row(
        Modifier.clearAndSetSemantics { contentDescription = label },
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.AutoMirrored.Filled.Reply, null, Modifier.size(12.dp), tint = c.secondary)
        Text(title, style = StarlingsType.caption2, color = c.secondary, maxLines = 2)
    }
}

/**
 * `replyContext`: over the composer, the parent the next message answers,
 * "Replying to" with a cancel, or "Reply to" while a reply is edited.
 */
@Composable
fun ReplyContext(parent: ThreadMessageWire?, editingReply: Boolean, onCancel: () -> Unit) {
    val c = Starlings.colors
    val content = ReplyPreview.resolve(parent)
    val author = content.authorText()
    val line = content.lineText()
    Row(
        Modifier.fillMaxWidth().background(c.elevated, RoundedCornerShape(StarlingsRadius.control)).padding(horizontal = 10.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.AutoMirrored.Filled.Reply, null, Modifier.size(14.dp), tint = c.secondary)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                stringResource(if (editingReply) R.string.thread_reply_to else R.string.thread_replying_to, author),
                style = StarlingsType.caption.copy(fontWeight = FontWeight.SemiBold), color = c.secondary,
            )
            if (line.isNotEmpty()) Text(line, style = StarlingsType.caption, color = c.secondary, maxLines = 2)
        }
        if (!editingReply) {
            val cancel = stringResource(R.string.thread_cancel_reply)
            Box(
                Modifier.size(32.dp).clickable(role = Role.Button, onClick = onCancel).clearAndSetSemantics { contentDescription = cancel; role = Role.Button },
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Filled.Close, null, Modifier.size(14.dp), tint = c.secondary) }
        }
    }
}

/**
 * One ref under an event line (`EventLine.chip`). One that opens something
 * is accent ink, as a link in a message; one that does not is a quiet
 * label. The tap target is a fingertip whatever the capsule's size.
 */
@Composable
fun RefChip(ref: ThreadMessageRef, doors: ThreadRefDoors?) {
    val c = Starlings.colors
    val uri = LocalUriHandler.current
    val title = when (val t = RefChips.title(ref)) {
        RefChips.Title.Task -> stringResource(R.string.work_task)
        RefChips.Title.Meeting -> stringResource(R.string.work_kind_meeting)
        RefChips.Title.Issue -> stringResource(R.string.work_issue)
        RefChips.Title.Commit -> stringResource(R.string.thread_ref_commit)
        RefChips.Title.Release -> stringResource(R.string.thread_ref_release)
        is RefChips.Title.Literal -> t.text
    }
    val open: (() -> Unit)? = when (val door = RefChips.door(ref)) {
        is RefChips.Door.Task -> doors?.let { d -> { d.openTask(door.id) } }
        is RefChips.Door.Issue -> doors?.let { d -> { d.openIssue(door.owner, door.repo, door.number) } }
        RefChips.Door.Overview -> doors?.showOverview
        is RefChips.Door.Web -> ({ runCatching { uri.openUri(door.url) }; Unit })
        RefChips.Door.None -> null
    }
    val label = when (ref.kind) {
        ThreadMessageRefKind.TASK -> stringResource(R.string.thread_ref_open_task)
        ThreadMessageRefKind.ISSUE -> stringResource(R.string.thread_ref_open_issue, title)
        ThreadMessageRefKind.PULL -> stringResource(R.string.thread_ref_open_pull, title)
        ThreadMessageRefKind.COMMIT -> stringResource(R.string.thread_ref_open_commit, title)
        ThreadMessageRefKind.RUN -> stringResource(R.string.thread_ref_open_run)
        ThreadMessageRefKind.RELEASE -> stringResource(R.string.thread_ref_open_release, title)
        ThreadMessageRefKind.DECISION -> stringResource(R.string.thread_ref_show_decisions)
        ThreadMessageRefKind.GOAL -> stringResource(R.string.thread_ref_show_goals)
        else -> title
    }
    Box(
        Modifier
            .heightIn(min = 44.dp)
            .widthIn(min = 44.dp)
            .then(if (open != null) Modifier.clickable(role = Role.Button, onClick = open).clearAndSetSemantics { contentDescription = label; role = Role.Button } else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            title,
            Modifier.border(1.dp, c.secondary.copy(alpha = 0.3f), CircleShape).padding(horizontal = 10.dp, vertical = 4.dp),
            style = StarlingsType.caption.copy(fontWeight = if (open != null) FontWeight.Medium else FontWeight.Normal),
            color = if (open != null) c.accentMark else c.secondary,
        )
    }
}

/**
 * `InteractiveQuestionCard`: an agent's question. A single choice sends on
 * the tap; several wait for Submit answer. Once anybody answered, the card
 * shows that answer instead of the options.
 */
@Composable
fun QuestionCard(
    question: ThreadQuestion,
    askedBy: String,
    answer: ThreadMessageWire?,
    selected: Set<String>,
    submitting: Boolean,
    error: String?,
    onSelect: (String, Boolean) -> Unit,
    onSubmit: () -> Unit,
) {
    val c = Starlings.colors
    val card = RoundedCornerShape(StarlingsRadius.card)
    val control = RoundedCornerShape(StarlingsRadius.control)
    val cardLabel = stringResource(R.string.thread_question)
    Column(
        Modifier
            .widthIn(max = 420.dp)
            .fillMaxWidth()
            .background(c.panel, card)
            .semantics { contentDescription = cardLabel }
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Text(stringResource(R.string.thread_asked_by, askedBy), style = StarlingsType.subheadline.copy(fontWeight = FontWeight.SemiBold), color = c.primary)
        Text(
            stringResource(if (question.mode == ThreadQuestionMode.SINGLE) R.string.thread_choose_one else R.string.thread_choose_all),
            style = StarlingsType.caption,
            color = c.secondary,
        )
        val submitted = answer?.questionAnswer
        if (answer != null && submitted != null) {
            if (answer.isWithdrawn) {
                Text(stringResource(R.string.thread_answer_withdrawn), style = StarlingsType.caption, color = c.secondary)
            } else {
                Text(stringResource(R.string.thread_answered_by, answer.senderShortName, clock(answer.sentAt)), style = StarlingsType.caption, color = c.secondary)
                submitted.optionLabels.forEach { label ->
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.CheckCircle, null, Modifier.size(16.dp), tint = c.accentMark)
                        Text(label, style = StarlingsType.subheadline, color = c.primary)
                    }
                }
            }
        } else {
            question.options.forEach { option ->
                val on = option.id in selected
                val icon = when (question.mode) {
                    ThreadQuestionMode.SINGLE -> if (on) Icons.Filled.RadioButtonChecked else Icons.Filled.RadioButtonUnchecked
                    ThreadQuestionMode.MULTIPLE -> if (on) Icons.Filled.CheckBox else Icons.Filled.CheckBoxOutlineBlank
                }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 44.dp)
                        .background(if (on) c.elevated else c.canvas, control)
                        .border(1.dp, if (on) c.primary else c.border, control)
                        .clickable(enabled = !submitting, role = if (question.mode == ThreadQuestionMode.SINGLE) Role.RadioButton else Role.Checkbox) {
                            if (question.mode == ThreadQuestionMode.SINGLE) {
                                onSelect(option.id, true)
                                onSubmit()
                            } else {
                                onSelect(option.id, !on)
                            }
                        }
                        .clearAndSetSemantics {
                            contentDescription = option.label
                            this.selected = on
                            role = if (question.mode == ThreadQuestionMode.SINGLE) Role.RadioButton else Role.Checkbox
                        }
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(icon, null, Modifier.size(20.dp), tint = if (on) c.accentMark else c.secondary)
                    Text(option.label, style = StarlingsType.body, color = c.primary)
                }
            }
            error?.takeIf { it.isNotEmpty() }?.let {
                Text(if (it == ThreadStore.QUESTION_EMPTY) stringResource(R.string.thread_choose_at_least_one) else it, style = StarlingsType.footnote, color = c.danger)
            }
            if (question.mode == ThreadQuestionMode.MULTIPLE) {
                FilledButton(
                    stringResource(if (submitting) R.string.thread_submitting else R.string.thread_submit_answer),
                    onSubmit,
                    enabled = selected.isNotEmpty() && !submitting,
                    compact = true,
                )
            } else if (submitting) {
                Text(stringResource(R.string.thread_submitting), style = StarlingsType.footnote, color = c.secondary)
            }
        }
    }
}
