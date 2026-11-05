package work.starlings.android.workspace.calendar

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.outlined.AddToPhotos
import androidx.compose.material.icons.outlined.ArrowCircleDown
import androidx.compose.material.icons.outlined.ArrowCircleUp
import androidx.compose.material.icons.outlined.MoveToInbox
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import work.starlings.android.CalEvent
import work.starlings.android.CalGroup
import work.starlings.android.CalendarPeople
import work.starlings.android.CalendarColors
import work.starlings.android.R
import work.starlings.android.RoomLink
import work.starlings.android.Rsvp
import work.starlings.android.ui.ListActionRow
import work.starlings.android.ui.ListFooter
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.SegmentedChoice
import work.starlings.android.ui.SheetHeader
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.contracts.CalendarAttendeeStatus
import work.starlings.contracts.CalendarSemanticRole
import work.starlings.contracts.CrmContact
import work.starlings.android.workspace.work.WorkRoute
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * `MobileCalendarEventDetail`: everything an event carries and the actions
 * it allows. Join is the one accent: it opens a Starlings room in the app
 * (`onJoinRoom`), any other link in the browser. The reply answers the tap at
 * once and goes back if the write fails.
 */
@Composable
fun CalendarEventDetail(
    store: CalendarStore,
    group: CalGroup,
    onDone: () -> Unit,
    onEdit: (CalEvent) -> Unit,
    onJoinRoom: (String?) -> Unit,
    onOpenWork: (String) -> Unit,
) {
    val c = Starlings.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val event = group.event
    val zone = store.zone
    var reply by remember(event.id) { mutableStateOf(event.myResponse ?: Rsvp.NEEDS_ACTION) }
    var demoted by remember(event.id) { mutableStateOf(event.demoted) }
    // The subject shows as soon as it is picked, not after the store republishes.
    var filed by remember(event.id) { mutableStateOf(event) }
    var working by remember { mutableStateOf(false) }
    var confirmingDelete by remember { mutableStateOf(false) }
    var moveMenu by remember { mutableStateOf(false) }
    var duplicateMenu by remember { mutableStateOf(false) }
    // The contacts the guests are, read once per opened event; a failed read leaves the rows as they are.
    var contacts by remember(event.id) { mutableStateOf(emptyList<CrmContact>()) }
    LaunchedEffect(event.id) {
        val emails = CalendarAttendeeContacts.lookup(guestRows(event).map { it.email })
        if (emails.isNotEmpty()) contacts = store.attendeeContacts(emails)
    }

    fun run(dismiss: Boolean = true, work: suspend () -> Boolean) {
        working = true
        scope.launch {
            val ok = work()
            working = false
            if (ok && dismiss) onDone()
        }
    }

    Column(Modifier.fillMaxSize()) {
        SheetHeader(stringResource(R.string.cal_event), stringResource(R.string.cal_done), onDone)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            ListSection(null) {
                ListRow {
                    Text(CalendarChrome.title(context, event), style = StarlingsType.title3.copy(fontWeight = FontWeight.Bold), color = c.primary)
                    Text(dateLine(context, event, store), style = StarlingsType.subheadline, color = c.secondary)
                    if (event.role == CalendarSemanticRole.GLOBAL_INTEREST) {
                        val tint = CalendarChrome.color(CalendarColors.globalInterest)
                        Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                            WorkspaceMark(tint, 12)
                            Text(stringResource(R.string.cal_global_interest), style = StarlingsType.caption, color = tint)
                        }
                    }
                    if (event.recurring) {
                        work.starlings.android.ui.CaptionLabel(stringResource(R.string.cal_repeating_event), Icons.Filled.Repeat)
                    }
                }
            }

            if (event.joinUrl.isNotEmpty()) {
                val isRoom = event.roomSlug.isNotEmpty()
                ListSection(null) {
                    ListActionRow(
                        stringResource(if (isRoom) R.string.cal_join_meeting else R.string.cal_open_link),
                        if (isRoom) Icons.Filled.Videocam else Icons.Filled.Link,
                        onClick = {
                            val room = RoomLink.parse(event.joinUrl)?.let { event.joinUrl } ?: event.roomSlug.takeIf { isRoom }
                            if (room != null) onJoinRoom(room) else openLink(context, event.joinUrl)
                        },
                    )
                    CallLinkRow(event.joinUrl)
                }
            }

            if (event.canRespond) {
                Column {
                    SectionHeader(stringResource(R.string.cal_going))
                    val answers = Rsvp.answers
                    val replyLabel = stringResource(R.string.cal_your_reply)
                    SegmentedChoice(
                        answers.map { CalendarChrome.rsvpLabel(context, it) },
                        answers.indexOf(reply).takeIf { it >= 0 },
                        onSelect = { index ->
                            val next = answers[index]
                            if (next != reply) {
                                val previous = reply
                                reply = next
                                working = true
                                scope.launch {
                                    if (!store.respond(event, next)) reply = previous
                                    working = false
                                }
                            }
                        },
                        modifier = Modifier.semantics { contentDescription = replyLabel },
                        enabled = !working,
                    )
                }
            }

            Column {
                SectionHeader(stringResource(R.string.cal_details))
                ListSection(null) {
                    val rows = buildList {
                        add(context.getString(R.string.cal_calendar) to store.calendarTitle(event.calendarId))
                        if (event.location.isNotEmpty()) add(context.getString(R.string.cal_where) to event.location)
                        CalendarChrome.travel(context, event.travelTimeMinutes)?.let { add(context.getString(R.string.cal_travel) to it) }
                    }
                    rows.forEach { (label, value) -> DetailRow(label, value) }
                    if (event.attendeeEmails.isNotEmpty()) {
                        ListRow {
                            Text(stringResource(R.string.cal_guests), style = StarlingsType.caption, color = c.secondary)
                            guestRows(event).forEach { guest ->
                                val contact = CalendarAttendeeContacts.match(contacts, guest.email)
                                if (contact == null) {
                                    Text(
                                        guest.name,
                                        Modifier.alpha(if (guest.declined) 0.55f else 1f),
                                        style = StarlingsType.subheadline,
                                        color = c.primary,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                } else {
                                    Column(
                                        Modifier
                                            .fillMaxWidth()
                                            .alpha(if (guest.declined) 0.55f else 1f)
                                            .clickable(role = Role.Button) { onOpenWork(WorkRoute.path(WorkRoute.Contact(contact.id))) },
                                    ) {
                                        Text(
                                            CalendarAttendeeContacts.name(contact, guest.name),
                                            style = StarlingsType.subheadline,
                                            color = c.primary,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                        CalendarAttendeeContacts.detail(contact)?.let {
                                            Text(it, style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if (event.notes.isNotEmpty()) DetailRow(stringResource(R.string.cal_notes), event.notes)
                }
            }

            // Filing is the owner's preference about the event, not a field of the invitation.
            if (store.calendar(event.calendarId)?.isMemberAccount == true) {
                CalendarFilingSection(
                    store,
                    filed,
                    working,
                    onFile = { picked ->
                        val previous = filed
                        filed = filed.copy(subject = picked)
                        run(dismiss = false) { store.setSubject(event, picked).also { if (!it) filed = previous } }
                    },
                    onOpenWork = onOpenWork,
                )
            }

            Column {
                ListSection(null) {
                    ListActionRow(
                        stringResource(if (demoted) R.string.cal_show_in_next else R.string.cal_hide_from_next),
                        if (demoted) Icons.Outlined.ArrowCircleUp else Icons.Outlined.ArrowCircleDown,
                        enabled = !working,
                        onClick = {
                            val next = !demoted
                            demoted = next
                            run(dismiss = false) { store.setDemoted(event, next).also { if (!it) demoted = !next } }
                        },
                    )
                }
                ListFooter(stringResource(if (demoted) R.string.cal_hidden_footer else R.string.cal_hide_footer))
            }

            if (event.writable) {
                ListSection(null) {
                    ListActionRow(stringResource(R.string.cal_edit), Icons.Filled.Edit, onClick = { onEdit(event) }, enabled = !working)
                    val targets = store.moveTargets(event)
                    if (event.canMoveBetweenCalendars && targets.isNotEmpty()) {
                        Box {
                            ListActionRow(stringResource(R.string.cal_move_to), Icons.Outlined.MoveToInbox, onClick = { moveMenu = true }, enabled = !working)
                            DropdownMenu(moveMenu, onDismissRequest = { moveMenu = false }) {
                                targets.forEach { calendar ->
                                    DropdownMenuItem(text = { Text(calendar.title) }, onClick = {
                                        moveMenu = false
                                        run { store.move(event, calendar) }
                                    })
                                }
                            }
                        }
                    }
                    if (store.writableCalendars.isNotEmpty()) {
                        Box {
                            ListActionRow(stringResource(R.string.cal_duplicate_to), Icons.Outlined.AddToPhotos, onClick = { duplicateMenu = true }, enabled = !working)
                            DropdownMenu(duplicateMenu, onDismissRequest = { duplicateMenu = false }) {
                                store.writableCalendars.forEach { calendar ->
                                    DropdownMenuItem(text = { Text(calendar.title) }, onClick = {
                                        duplicateMenu = false
                                        run { store.duplicate(event, calendar) }
                                    })
                                }
                            }
                        }
                    }
                    ListActionRow(stringResource(R.string.cal_delete), Icons.Filled.Delete, onClick = { confirmingDelete = true }, tint = c.danger, enabled = !working)
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }

    if (confirmingDelete) {
        AlertDialog(
            onDismissRequest = { confirmingDelete = false },
            title = { Text(stringResource(R.string.cal_delete_title, event.title)) },
            text = { Text(stringResource(R.string.cal_cannot_undo)) },
            confirmButton = {
                // A recurring instance has two honest answers, so it is asked rather than guessed.
                Column(horizontalAlignment = Alignment.End) {
                    if (event.recurring) {
                        TextButton({ confirmingDelete = false; run { store.delete(event, wholeSeries = false) } }) {
                            Text(stringResource(R.string.cal_delete_this), color = c.danger)
                        }
                        TextButton({ confirmingDelete = false; run { store.delete(event, wholeSeries = true) } }) {
                            Text(stringResource(R.string.cal_delete_series), color = c.danger)
                        }
                    } else {
                        TextButton({ confirmingDelete = false; run { store.delete(event, wholeSeries = false) } }) {
                            Text(stringResource(R.string.cal_delete), color = c.danger)
                        }
                    }
                }
            },
            dismissButton = { TextButton({ confirmingDelete = false }) { Text(stringResource(R.string.cal_cancel), color = c.primary) } },
            containerColor = c.elevated,
            titleContentColor = c.primary,
            textContentColor = c.secondary,
        )
    }
}

@Composable
internal fun SectionHeader(text: String) {
    Text(text, Modifier.padding(start = 16.dp, bottom = 6.dp), style = StarlingsType.footnote, color = Starlings.colors.secondary)
}

@Composable
internal fun DetailRow(label: String, value: String) {
    val c = Starlings.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = StarlingsType.caption, color = c.secondary)
        Text(value, style = StarlingsType.subheadline, color = c.primary)
    }
}

/** `MobileCallLinkRow`: the link whole, with a copy button beside it. */
@Composable
fun CallLinkRow(link: String) {
    val c = Starlings.colors
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) { delay(1_200); copied = false }
    }
    val label = stringResource(if (copied) R.string.cal_copied else R.string.cal_copy_link)
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(link, Modifier.weight(1f), style = StarlingsType.callout, color = c.secondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Box(
            Modifier
                .size(36.dp)
                .clickable(role = Role.Button) {
                    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.setPrimaryClip(ClipData.newPlainText(link, link))
                    copied = true
                }
                .clearAndSetSemantics { contentDescription = label; role = Role.Button },
            contentAlignment = Alignment.Center,
        ) {
            Icon(if (copied) Icons.Filled.Check else Icons.Filled.ContentCopy, null, Modifier.size(20.dp), tint = c.accent)
        }
    }
}

/**
 * Which guests are contacts: the addresses to
 * ask about, and the contact one address belongs to.
 */
internal object CalendarAttendeeContacts {
    /** The Worker reads at most this many addresses at once. */
    const val MAX_EMAILS = 25

    /** The guests' addresses, lower-cased and once each, without workspace members; [MAX_EMAILS] at most. */
    fun lookup(emails: List<String>): List<String> =
        emails.map { it.trim().lowercase() }
            .filter { it.isNotEmpty() && !CalendarPeople.isMemberAddress(it) }
            .distinct()
            .take(MAX_EMAILS)

    /** The contact that holds [email] among any of its addresses, or null. */
    fun match(contacts: List<CrmContact>, email: String): CrmContact? {
        val key = email.trim().lowercase()
        if (key.isEmpty()) return null
        return contacts.firstOrNull { contact ->
            (contact.emails + listOfNotNull(contact.email)).any { it.trim().lowercase() == key }
        }
    }

    /** The contact's name, else what the event calls the guest. */
    fun name(contact: CrmContact, fallback: String): String = contact.name?.trim()?.takeIf { it.isNotEmpty() } ?: fallback

    /** `title · organization`, either half alone, or null when the contact has neither. */
    fun detail(contact: CrmContact): String? =
        listOfNotNull(contact.title, contact.organizationName)
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .joinToString(" · ")
            .takeIf { it.isNotEmpty() }
}

private data class GuestRow(val email: String, val name: String, val declined: Boolean)

/** One row per guest: the name when the event carries it, else the address. */
private fun guestRows(event: CalEvent): List<GuestRow> {
    val seen = mutableSetOf<String>()
    return event.attendeeEmails.mapNotNull { raw ->
        val email = raw.lowercase()
        if (email.isEmpty() || !seen.add(email)) return@mapNotNull null
        val known = event.attendees.firstOrNull { it.email.lowercase() == email }
        val name = known?.let { it.name.ifEmpty { it.email } } ?: email
        GuestRow(email, name, known?.status == CalendarAttendeeStatus.DECLINED)
    }
}

private fun dateLine(context: Context, event: CalEvent, store: CalendarStore): String {
    val day = DateTimeFormatter.ofLocalizedDate(FormatStyle.FULL).format(CalendarDatesUi.day(event.start, store.zone))
    if (event.allDay) return context.getString(R.string.cal_all_day_line, day)
    return "$day\n${CalendarChrome.timeRange(context, event, store.zone)}"
}

internal fun openLink(context: Context, url: String) {
    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
}
