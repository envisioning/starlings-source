package work.starlings.android.workspace.home

import androidx.compose.ui.platform.LocalView
import work.starlings.android.ui.HapticWhenSet
import work.starlings.android.ui.Haptic
import work.starlings.android.widgets.LaunchAction
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Campaign
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.MoveToInbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import work.starlings.android.HomeLayout
import work.starlings.android.R
import work.starlings.android.api.PublicEvent
import work.starlings.android.ui.CompactMark
import work.starlings.android.ui.HomeCardLabel
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsCard
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.homeRow
import work.starlings.contracts.OwnerRoomConfiguration
import work.starlings.contracts.QuickNote
import java.time.Instant
import java.time.ZoneId

/**
 * `MobileMeetHero`: the clock and the date under it, centred. iOS sets the
 * clock in Octa at 56; that face is not in this repo, so the system face
 * sets it at the same size. 24-hour, always.
 */
@Composable
fun HomeHero(nowMs: Long, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val c = Starlings.colors
    val date = Instant.ofEpochMilli(nowMs).atZone(ZoneId.systemDefault()).toLocalDate()
    Column(
        modifier.fillMaxWidth().padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(HomeClock.time(nowMs), style = StarlingsType.largeTitle.copy(fontSize = 56.sp, lineHeight = 64.sp, fontWeight = FontWeight.Normal), color = c.primary)
        Text(HomeText.homeDate(context, date), style = StarlingsType.subheadline.copy(fontSize = 14.sp, fontWeight = FontWeight.Medium), color = c.secondary)
    }
}

/** `MeetingInvite.absoluteURL(slug:)`: the workspace's own room link. */
fun roomLink(slug: String): String = "${work.starlings.android.Workspaces.active.publicOrigin.trimEnd('/')}/room/$slug"

/**
 * `MobileHomeView.roomCard`: the slug, the link that copies itself, and the
 * unmapped state with its next step, and Start room, which opens the
 * owner's room on this device (host/RoomHost.kt).
 */
@Composable
fun RoomCard(room: OwnerRoomConfiguration?, loading: Boolean, unmapped: Boolean, ownerEmail: String, onStart: () -> Unit, open: Boolean = false) {
    val c = Starlings.colors
    StarlingsCard {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                HomeCardLabel(stringResource(R.string.home_room))
                when {
                    loading -> Box(
                        Modifier.padding(vertical = 4.dp).width(140.dp).heightIn(min = 20.dp)
                            .background(c.border, CircleShape).clearAndSetSemantics { },
                    )
                    room != null -> {
                        Text(room.slug, style = StarlingsType.title2.copy(fontWeight = FontWeight.Bold), color = c.primary)
                        RoomLinkButton(roomLink(room.slug))
                        // Your own roster row is the honest answer to "is my room open"; closed says nothing.
                        if (open) RoomOpenLine()
                        // Start is the room card's primary on the native apps.
                        work.starlings.android.ui.FilledButton(stringResource(R.string.host_start_room), onStart, Modifier.padding(top = 6.dp))
                    }
                    unmapped -> {
                        Text(stringResource(R.string.home_no_room), style = StarlingsType.title2.copy(fontWeight = FontWeight.Bold), color = c.primary)
                        Text(stringResource(R.string.home_no_room_mapped, ownerEmail), style = StarlingsType.subheadline, color = c.secondary)
                    }
                    else -> {
                        Text(stringResource(R.string.home_room_error), style = StarlingsType.body, color = c.secondary)
                        if (open) RoomOpenLine()
                    }
                }
            }
            Icon(Icons.Outlined.Devices, null, Modifier.size(26.dp), tint = c.secondary)
        }
    }
}

/** "Your room is open.": the same signal Team reads about everybody else, pointed back at you. */
@Composable
private fun RoomOpenLine() {
    Text(stringResource(R.string.home_room_open), Modifier.padding(top = 6.dp), style = StarlingsType.subheadline, color = Starlings.colors.secondary)
}

/** The link as a line that copies itself, with "Copied" for a moment after. */
@Composable
private fun RoomLinkButton(link: String) {
    val context = LocalContext.current
    val c = Starlings.colors
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) { delay(1_200); copied = false }
    }
    val label = stringResource(if (copied) R.string.home_copied else R.string.home_copy_room_link)
    Row(
        Modifier
            .clickable(role = Role.Button) { copy(context, link); copied = true }
            .clearAndSetSemantics { contentDescription = label; role = Role.Button; onClick { copy(context, link); copied = true; true } }
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            if (copied) stringResource(R.string.home_copied) else link,
            Modifier.weight(1f, fill = false),
            style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.MiddleEllipsis,
        )
        Icon(if (copied) Icons.Outlined.Check else Icons.Outlined.ContentCopy, null, Modifier.size(14.dp), tint = c.accent)
    }
}

private fun copy(context: Context, text: String) {
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("room", text))
}

/** `MobileHomeEventsCard`: the first three published events; a row with a page opens it. */
@Composable
fun EventsCard(events: List<PublicEvent>, nowMs: Long, open: (String) -> Unit) {
    val context = LocalContext.current
    val c = Starlings.colors
    val cap = HomeLayout.definition("events").rows ?: 3
    StarlingsCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            HomeCardLabel(stringResource(R.string.home_events))
            events.take(cap).forEach { e ->
                val schedule = HomeText.eventSchedule(context, e, nowMs)
                val url = e.signupUrl?.takeIf { it.isNotEmpty() }
                val hint = stringResource(R.string.home_opens_event_page)
                Row(
                    Modifier
                        .homeRowClickable(url != null) { url?.let(open) }
                        .clearAndSetSemantics {
                            contentDescription = listOf(e.title, schedule).filter { it.isNotEmpty() }.joinToString(", ")
                            if (url != null) { role = Role.Button; onClick(hint) { open(url); true } }
                        },
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    CompactMark(Icons.Outlined.Campaign, round = true)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(e.title, style = StarlingsType.headline, color = c.primary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        if (schedule.isNotEmpty()) {
                            Text(schedule, style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            if (events.size > cap) {
                Text(stringResource(R.string.home_and_more, events.size - cap), style = StarlingsType.caption, color = c.secondary)
            }
        }
    }
}

@Composable
private fun Modifier.homeRowClickable(enabled: Boolean, onClick: () -> Unit): Modifier {
    val c = Starlings.colors
    val base = if (enabled) clickable(onClick = onClick) else this
    return base.homeRow(c.elevated)
}

/**
 * `MobileQuickNotesCard`: Home's capture card. The field opens from the
 * plus; Return or the round plus saves. Each open note is a Home row: a tap
 * opens it in the drawer to rewrite or file ([QuickNoteDrawer]); the
 * long-press holds Edit, File… and Delete.
 */
@Composable
fun QuickNotesCard(
    notes: List<QuickNote>,
    saving: Boolean,
    error: String?,
    nowMs: Long,
    create: suspend (String) -> Boolean,
    delete: (QuickNote) -> Unit,
    edit: (QuickNote) -> Unit,
    fileNote: (QuickNote) -> Unit,
) {
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var expanded by rememberSaveable { mutableStateOf(false) }
    var draft by rememberSaveable { mutableStateOf("") }
    var pages by rememberSaveable { mutableIntStateOf(1) }
    val open = HomeFeed.openNotes(notes)
    val listed = open.take(pages * HomeFeed.NOTES_PER_PAGE)
    val hidden = open.size - listed.size
    val canSave = draft.isNotBlank() && !saving
    val focus = remember { FocusRequester() }
    val view = LocalView.current
    HapticWhenSet(Haptic.ERROR, error)
    val save: () -> Unit = {
        if (canSave) scope.launch {
            if (create(draft)) { draft = ""; expanded = false; Haptic.SUCCESS.play(view) }
        }
    }
    LaunchedEffect(expanded) { if (expanded) runCatching { focus.requestFocus() } }
    // The Quick note tile lands here: field open, keyboard up (widgets/Controls.kt).
    val pending by LaunchAction.pendingQuickNote.collectAsStateWithLifecycle()
    LaunchedEffect(pending) {
        if (!pending) return@LaunchedEffect
        LaunchAction.pendingQuickNote.value = false
        expanded = true
    }

    StarlingsCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                HomeCardLabel(stringResource(R.string.home_quick_notes))
                Spacer(Modifier.weight(1f))
                if (open.isNotEmpty()) {
                    Text("${open.size}", style = StarlingsType.caption.copy(fontWeight = FontWeight.Bold), color = c.primary)
                }
                if (!expanded) {
                    val label = stringResource(R.string.home_add_note)
                    Box(
                        Modifier.size(32.dp).clickable(role = Role.Button) { expanded = true }
                            .clearAndSetSemantics { contentDescription = label; role = Role.Button; onClick { expanded = true; true } },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Filled.Add, null, tint = c.secondary)
                    }
                }
            }

            if (expanded) {
                val fieldLabel = stringResource(R.string.home_note)
                val addLabel = stringResource(if (saving) R.string.home_saving else R.string.home_add_note)
                Row(
                    Modifier.fillMaxWidth().background(c.field, RoundedCornerShape(24.dp)).padding(start = 14.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.Bottom,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    BasicTextField(
                        draft, { draft = it },
                        Modifier.weight(1f).padding(vertical = 4.dp).focusRequester(focus).clearAndSetSemantics { contentDescription = fieldLabel },
                        textStyle = StarlingsType.body.copy(color = c.primary),
                        cursorBrush = SolidColor(c.accent),
                        maxLines = 6,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { save() }),
                        decorationBox = { inner ->
                            Box {
                                if (draft.isEmpty()) Text(stringResource(R.string.home_note_prompt), style = StarlingsType.body, color = c.secondary.copy(alpha = 0.7f))
                                inner()
                            }
                        },
                    )
                    Box(
                        Modifier.size(26.dp).alpha(if (canSave) 1f else 0.4f).background(c.accent, CircleShape)
                            .clickable(enabled = canSave, role = Role.Button) { save() }
                            .clearAndSetSemantics { contentDescription = addLabel; role = Role.Button; if (canSave) onClick { save(); true } },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Filled.Add, null, Modifier.size(16.dp), tint = c.accentInk)
                    }
                }
                error?.let { Text(it, style = StarlingsType.caption, color = c.danger) }
            }

            listed.forEach { note -> NoteRow(note, nowMs, delete, edit, fileNote) }

            if (hidden > 0) {
                FoldButton(stringResource(R.string.home_see_more, hidden)) { pages += 1 }
            } else if (pages > 1) {
                FoldButton(stringResource(R.string.home_show_fewer)) { pages = 1 }
            }
        }
    }
}

@Composable
private fun NoteRow(note: QuickNote, nowMs: Long, delete: (QuickNote) -> Unit, edit: (QuickNote) -> Unit, fileNote: (QuickNote) -> Unit) {
    val c = Starlings.colors
    var menu by remember { mutableStateOf(false) }
    val age = HomeText.noteAge(note.createdAt, nowMs)
    val deleteLabel = stringResource(R.string.home_delete)
    val editLabel = stringResource(R.string.home_edit_note)
    val fileLabel = stringResource(R.string.home_file_note)
    Box {
        Row(
            Modifier
                .homeRow(c.elevated)
                .pointerInput(note.id) { detectTapGestures(onTap = { edit(note) }, onLongPress = { menu = true }) }
                .clearAndSetSemantics {
                    contentDescription = listOf(note.body, age).filter { it.isNotEmpty() }.joinToString(", ")
                    role = Role.Button
                    onClick(editLabel) { edit(note); true }
                    customActions = listOf(
                        CustomAccessibilityAction(fileLabel) { fileNote(note); true },
                        CustomAccessibilityAction(deleteLabel) { delete(note); true },
                    )
                },
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.Top,
        ) {
            CompactMark(Icons.Outlined.Edit)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(note.body, style = StarlingsType.body, color = c.primary, maxLines = 3, overflow = TextOverflow.Ellipsis)
                if (age.isNotEmpty()) Text(age, style = StarlingsType.caption, color = c.secondary, maxLines = 1)
            }
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = c.elevated) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.home_edit), color = c.primary) },
                leadingIcon = { Icon(Icons.Outlined.Edit, null, tint = c.primary) },
                onClick = { menu = false; edit(note) },
            )
            DropdownMenuItem(
                text = { Text(fileLabel, color = c.primary) },
                leadingIcon = { Icon(Icons.Outlined.MoveToInbox, null, tint = c.primary) },
                onClick = { menu = false; fileNote(note) },
            )
            DropdownMenuItem(
                text = { Text(deleteLabel, color = c.danger) },
                leadingIcon = { Icon(Icons.Outlined.Delete, null, tint = c.danger) },
                onClick = { menu = false; delete(note) },
            )
        }
    }
}

@Composable
private fun FoldButton(title: String, onClick: () -> Unit) {
    Text(
        title,
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick).padding(vertical = 4.dp),
        style = StarlingsType.caption.copy(fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Start),
        color = Starlings.colors.secondary,
    )
}
