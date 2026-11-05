package work.starlings.android.workspace.work

import android.content.Intent
import android.content.res.Resources
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Business
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.ChatBubbleOutline
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.EventAvailable
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.MarkEmailUnread
import androidx.compose.material.icons.filled.QuestionAnswer
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.Upcoming
import work.starlings.android.ui.BorderedButton
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkFoldTitle
import work.starlings.android.ui.WorkIconButton
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkRowAction
import work.starlings.android.ui.WorkRowMenu
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSheet
import work.starlings.android.ui.WorkSidebarRow
import work.starlings.android.ui.WorkSwipeRow
import work.starlings.android.workspace.LocalWorkspaceNavigator
import work.starlings.android.workspace.MemberSurface
import work.starlings.contracts.AttentionResolveInput
import work.starlings.contracts.AttentionResolveInputAction
import work.starlings.contracts.AttentionState
import work.starlings.contracts.CalendarEventReply
import work.starlings.contracts.DecisionAsk
import work.starlings.contracts.DecisionAskOption
import work.starlings.contracts.InboxBookingChange
import work.starlings.contracts.InboxBookingItem
import work.starlings.contracts.InboxCardItem
import work.starlings.contracts.InboxCommentItem
import work.starlings.contracts.InboxCommercialItem
import work.starlings.contracts.InboxDecisionItem
import work.starlings.contracts.InboxFollowUpItem
import work.starlings.contracts.InboxForwardedItem
import work.starlings.contracts.InboxInterestItem
import work.starlings.contracts.InboxInvitationItem
import work.starlings.contracts.InboxItem
import work.starlings.contracts.InboxQuestionItem
import work.starlings.contracts.InboxSalesItem
import work.starlings.contracts.InboxSubmissionItem
import work.starlings.contracts.InboxTalkItem
import work.starlings.contracts.InboxTaskItem
import work.starlings.contracts.AttentionRequest

/** What a row can open that the Work stack holds. */
internal class InboxDoors(
    val openSubject: (SubjectRef) -> Unit,
    val openIssue: (owner: String, repo: String, number: Long, url: String) -> Unit,
    /** The follow-up sheet (`openFollowUp`); the list holds it so a route can open one. */
    val openFollowUp: (InboxFollowUpItem) -> Unit = {},
    /** Start a lead from a Sales touch: the New Lead editor, prefilled. */
    val startLead: (InboxSalesItem) -> Unit = {},
)

/**
 * `inboxSection`: what needs you, newest first, each row leaving when
 * resolved. The header folds, keeps the one total and the source filter;
 * the footer says what the Worker could not read. [openDecision] and
 * [openQuestion] are the sheets, held by the list so a route can open one.
 */
@Composable
internal fun InboxBlock(
    store: WorkStore,
    query: String,
    filter: String,
    onFilter: (String) -> Unit,
    folded: Boolean,
    onFold: () -> Unit,
    doors: InboxDoors,
    openDecision: (DecisionAsk) -> Unit,
    openQuestion: (AttentionRequest) -> Unit,
) {
    val r = LocalContext.current.resources
    val response = store.inbox
    val all = response?.let { WorkInbox.searched(it, query) }.orEmpty()
    val items = all.filter { WorkInbox.matchesFilter(it, filter) }
    val wanted = query.trim()
    val footer = response?.let { inboxFooter(r, it) }
    WorkSection(
        header = {
            WorkFoldTitle(stringResource(R.string.work_inbox), folded, stringResource(R.string.work_folded), stringResource(R.string.work_open), onFold)
            Spacer(Modifier.weight(1f))
            // The one total a header keeps: what is waiting on you.
            if (all.isNotEmpty()) Text("${all.size}", style = StarlingsType.footnote, color = Starlings.colors.secondary)
            InboxFilterMenu(filter, all, onFilter)
        },
        footer = footer,
    ) {
        if (!folded) {
            store.inboxError?.let { WorkErrorNotice(it, retry = r.getString(R.string.work_retry), onRetry = { store.questionResolved() }) }
            items.forEachIndexed { index, item ->
                if (index > 0) WorkDivider()
                InboxRow(store, item, doors, openDecision, openQuestion)
            }
            if (items.isEmpty() && store.inboxError == null) {
                WorkNote(
                    stringResource(if (all.isEmpty() && wanted.isEmpty()) R.string.work_nothing_needs_you else R.string.work_nothing_matches),
                )
            }
        }
    }
}

/** `partialLine` and `cappedLine`, one under the other. */
private fun inboxFooter(r: Resources, response: work.starlings.contracts.InboxResponse): String? {
    val lines = buildList {
        if (response.partial.isNotEmpty()) {
            val names = response.partial.map { source ->
                val noun = PARTIAL_NOUNS[if (source.value == "mention") "talk" else source.value] ?: source.value
                val subjects = response.taskPartial.orEmpty()
                if (source.value != "task" || subjects.isEmpty()) noun
                else "$noun on ${subjects.take(3).joinToString(", ")}" + if (subjects.size > 3) " and ${subjects.size - 3} more" else ""
            }
            add(r.getString(R.string.work_inbox_partial, names.joinToString(", ")))
        }
        if (response.capped.orEmpty().any { it.value == "comment" }) add(r.getString(R.string.work_inbox_capped))
    }
    return lines.takeIf { it.isNotEmpty() }?.joinToString("\n")
}

/** `InboxSourceSpec.partial`: the source as a noun in "Couldn't read …" (English, as the line is an error). */
private val PARTIAL_NOUNS = mapOf(
    "decision" to "decisions", "question" to "questions", "card" to "agent work", "followup" to "follow-ups",
    "talk" to "talk", "guest" to "guest messages", "support" to "Starlings support", "task" to "proposed tasks",
    "note" to "notes", "sales" to "sales touches", "comment" to "comments", "booking" to "bookings",
    "invitation" to "calendar invitations", "forwarded" to "events from email", "interest" to "interest",
    "submission" to "form submissions", "commercial" to "offers and licenses",
)

/** A source's title (`InboxSourceSpec.title`), or All items. */
internal fun inboxSourceTitle(r: Resources, source: String): String = when (source) {
    WorkInbox.ALL -> r.getString(R.string.work_all_items)
    "decision" -> r.getString(R.string.work_source_decision)
    "question" -> r.getString(R.string.work_source_question)
    "card" -> r.getString(R.string.work_source_card)
    "followup" -> r.getString(R.string.work_source_followup)
    "talk" -> r.getString(R.string.work_source_talk)
    "guest" -> r.getString(R.string.work_source_guest)
    "support" -> r.getString(R.string.work_source_support)
    "task" -> r.getString(R.string.work_source_task)
    "note" -> r.getString(R.string.work_source_note)
    "sales" -> r.getString(R.string.work_source_sales)
    "comment" -> r.getString(R.string.work_source_comment)
    "booking" -> r.getString(R.string.work_source_booking)
    "invitation" -> r.getString(R.string.work_source_invitation)
    "forwarded" -> r.getString(R.string.work_source_forwarded)
    "interest" -> r.getString(R.string.work_source_interest)
    "submission" -> r.getString(R.string.work_source_submission)
    "commercial" -> r.getString(R.string.work_source_commercial)
    else -> source
}

/** `inboxFilterMenu`: All items and the sources present (or chosen), Reset when off its default. */
@Composable
private fun InboxFilterMenu(filter: String, items: List<InboxItem>, onFilter: (String) -> Unit) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    var open by remember { mutableStateOf(false) }
    val present = items.map(WorkInbox::filterSource).toSet()
    val options = listOf(WorkInbox.ALL) + WorkInbox.filterSources.filter { it != "note" && (it in present || it == filter) }
    Box {
        WorkIconButton(Icons.Filled.FilterList, stringResource(R.string.work_filter_inbox), { open = true }, tint = if (filter == WorkInbox.ALL) c.secondary else c.accent)
        DropdownMenu(open, { open = false }, containerColor = c.elevated, shape = RoundedCornerShape(14.dp)) {
            options.forEach { option ->
                MenuChoice(inboxSourceTitle(r, option), option == filter) { onFilter(option); open = false }
            }
            if (filter != WorkInbox.ALL) {
                HorizontalDivider(color = c.border)
                DropdownMenuItem(
                    text = { Text(r.getString(R.string.work_reset), style = StarlingsType.body, color = c.primary) },
                    onClick = { onFilter(WorkInbox.ALL); open = false },
                )
            }
        }
    }
}

/** One INBOX row, drawn the way its source's own list presents it (`workItemRow`). */
@Composable
private fun InboxRow(
    store: WorkStore,
    item: InboxItem,
    doors: InboxDoors,
    openDecision: (DecisionAsk) -> Unit,
    openQuestion: (AttentionRequest) -> Unit,
) {
    val context = LocalContext.current
    val r = context.resources
    val navigator = LocalWorkspaceNavigator.current
    val now = System.currentTimeMillis()
    fun calendar(path: String) = navigator?.open(MemberSurface.CALENDAR, path)

    when (item) {
        is InboxDecisionItem -> {
            val ask = item.ask
            val detail = decisionDetail(r, ask)
            val recommended = DecisionLines.recommended(ask)
            val actions = ask.options.map { option -> WorkRowAction(option.label) { store.answerDecision(item, option, null) } } +
                WorkRowAction(r.getString(R.string.work_open_action)) { openDecision(ask) }
            Swiped(recommended?.let { r.getString(R.string.work_recommended) }, Icons.Filled.Check, { recommended?.let { store.answerDecision(item, it, null) } }) {
                Menu(actions) { long ->
                    WorkSidebarRow(
                        Icons.Filled.Check, ask.question, detail, { openDecision(ask) }, square = true, onLongClick = long,
                        label = r.getString(R.string.work_open_decision_label, ask.question, detail),
                    )
                }
            }
        }
        is InboxQuestionItem -> {
            val request = item.request
            val detail = questionDetail(r, request)
            Menu(listOf(WorkRowAction(r.getString(R.string.work_open_action)) { openQuestion(request) })) { long ->
                WorkSidebarRow(
                    Icons.Filled.QuestionAnswer, request.prompt, detail, { openQuestion(request) }, square = true, onLongClick = long,
                    label = r.getString(R.string.work_open_question_label, request.prompt, detail),
                )
            }
        }
        is InboxTaskItem -> {
            val subject = WorkInbox.subject(item.subject)
            val accept = WorkRowAction(r.getString(R.string.work_accept)) { store.decideProposal(item, true) }
            val decline = WorkRowAction(r.getString(R.string.work_decline), danger = true) { store.decideProposal(item, false) }
            Swiped(accept.title, Icons.Filled.Check, accept.run) {
                Menu(listOf(accept, decline)) { long ->
                    WorkSidebarRow(
                        Icons.Filled.Check, item.task.title, r.getString(R.string.work_inbox_proposed, item.subject.title),
                        { doors.openSubject(subject) }, square = true, onLongClick = long,
                    )
                }
            }
        }
        is InboxInvitationItem -> {
            val event = item.event
            val title = event.title.ifEmpty { r.getString(R.string.work_calendar_invitation) }
            val detail = invitationDetail(r, item, now)
            val day = Upcoming.parse(event.start)?.let { java.time.Instant.ofEpochMilli(it).atZone(java.time.ZoneId.systemDefault()).toLocalDate() }
            val open = { calendar("/calendar/event/${WorkRoute.encode(WorkInbox.eventReference(event))}" + (day?.let { "?day=$it" } ?: "")) }
            val accept = WorkRowAction(r.getString(R.string.work_accept)) { store.respond(item, CalendarEventReply.ACCEPTED) }
            val maybe = WorkRowAction(r.getString(R.string.work_maybe)) { store.respond(item, CalendarEventReply.TENTATIVE) }
            val decline = WorkRowAction(r.getString(R.string.work_decline), danger = true) { store.respond(item, CalendarEventReply.DECLINED) }
            Swiped(accept.title, Icons.Filled.Check, accept.run) {
                Menu(listOf(accept, maybe, decline)) { long ->
                    WorkSidebarRow(
                        Icons.Filled.Schedule, title, detail, { open() }, onLongClick = long,
                        label = r.getString(R.string.work_opens_event_label, title, detail),
                    )
                }
            }
        }
        is InboxForwardedItem -> {
            val event = item.event
            val add = WorkRowAction(r.getString(R.string.work_add_to_calendar)) { store.addForwarded(item) }
            val discard = WorkRowAction(r.getString(R.string.work_discard), danger = true) { store.discardForwarded(item) }
            // No event exists yet, so a tap offers the two answers: the row's menu.
            Swiped(r.getString(R.string.work_add), Icons.Filled.EventAvailable, add.run) {
                Menu(listOf(add, discard)) { long ->
                    WorkSidebarRow(Icons.Filled.MarkEmailUnread, event.title, forwardedDetail(r, item, now), { long?.invoke() }, onLongClick = long)
                }
            }
        }
        is InboxCardItem -> {
            val title = item.task?.title ?: item.issue?.title.orEmpty()
            val detail = r.getString(if (WorkInbox.isBlocked(item)) R.string.work_inbox_blocked else R.string.work_inbox_review, item.agent.name, item.subject.title)
            val issue = item.issue
            WorkSidebarRow(
                if (WorkInbox.isBlocked(item)) Icons.Filled.Warning else Icons.Filled.CheckCircle, title, detail,
                {
                    if (issue != null) doors.openIssue(issue.owner, issue.repo, issue.number, issue.url)
                    else doors.openSubject(WorkInbox.subject(item.subject))
                },
                square = true,
            )
        }
        is InboxFollowUpItem -> {
            // The draft and the call's tasks, in the follow-up sheet.
            val detail = r.getString(R.string.work_inbox_followup, item.recipients.joinToString(", ") { it.name }, item.subject.title)
            val open = WorkRowAction(r.getString(R.string.work_open_action)) { doors.openFollowUp(item) }
            val dismiss = WorkRowAction(r.getString(R.string.work_dismiss), danger = true) { store.dismissFollowUp(item) }
            Menu(listOf(open, dismiss)) { long ->
                WorkSidebarRow(Icons.Filled.Email, item.draft.subject, detail, { doors.openFollowUp(item) }, square = true, onLongClick = long)
            }
        }
        is InboxTalkItem -> {
            val thread = item.thread
            val title = thread.title ?: r.getString(R.string.work_unread)
            val detail = (if (WorkInbox.isMention(item)) r.getString(R.string.work_mentions_you) else "") + (thread.lastMessagePreview ?: r.getString(R.string.work_unread))
            WorkSidebarRow(Icons.Filled.ChatBubble, title, detail, { navigator?.open(MemberSurface.TEAM, "/team/thread/${WorkRoute.encode(thread.id)}") }, unreadDot = true)
        }
        is InboxCommentItem -> {
            val who = item.latest.authorName ?: item.latest.author
            val detail = r.getString(R.string.work_inbox_comment, item.subject?.title ?: r.getString(R.string.work_docs)) + " · $who: ${item.latest.bodyMd}"
            WorkSidebarRow(
                Icons.Filled.ChatBubbleOutline, item.document.title, detail,
                { navigator?.open(MemberSurface.DOCS, "/docs/document/${WorkRoute.encode(item.document.id)}") }, square = true,
            )
        }
        is InboxBookingItem -> {
            val reference = WorkInbox.bookingEventReference(item)
            val dismiss = WorkRowAction(r.getString(R.string.work_dismiss), danger = true) { store.dismiss(item.key) }
            val detail = bookingDetail(r, item, now)
            Swiped(dismiss.title, Icons.Filled.Close, dismiss.run, danger = true) {
                Menu(listOf(dismiss)) { long ->
                    WorkSidebarRow(
                        Icons.Filled.EventAvailable, item.booking.guestName, detail,
                        { if (reference != null) calendar("/calendar/event/${WorkRoute.encode(reference)}") else long?.invoke() },
                        onLongClick = long,
                        label = if (reference != null) r.getString(R.string.work_opens_event_label, item.booking.guestName, detail) else null,
                    )
                }
            }
        }
        is InboxInterestItem, is InboxSubmissionItem -> {
            val key = WorkInbox.key(item).orEmpty()
            val (title, detail, lead) = when (item) {
                is InboxInterestItem -> Triple(
                    item.submission.company,
                    listOf(r.getString(R.string.work_interest), item.submission.name, item.submission.teamSize, item.submission.deployment).filter { it.isNotEmpty() }.joinToString(" · "),
                    item.submission.lead,
                )
                is InboxSubmissionItem -> Triple(
                    item.submission.organization.ifEmpty { item.submission.name },
                    listOf(item.submission.title, item.submission.name, item.submission.summary).filter { it.isNotEmpty() }.joinToString(" · "),
                    item.submission.lead,
                )
                else -> Triple("", "", null)
            }
            val dismiss = WorkRowAction(r.getString(R.string.work_dismiss), danger = true) { store.dismiss(key) }
            Swiped(dismiss.title, Icons.Filled.Close, dismiss.run, danger = true) {
                Menu(listOf(dismiss)) { long ->
                    WorkSidebarRow(Icons.Filled.Business, title, detail, { if (lead != null) doors.openSubject(WorkInbox.subject(lead)) else long?.invoke() }, onLongClick = long)
                }
            }
        }
        is InboxCommercialItem -> {
            // An offer about to expire or a license about to renew: a tap opens its subject on Overview.
            val title = commercialTitle(r, item, java.time.LocalDate.now())
            val detail = commercialDetail(r, item)
            val subject = WorkInbox.commercialSubject(item)
            val dismiss = WorkRowAction(r.getString(R.string.work_dismiss), danger = true) { store.dismiss(item.key) }
            Swiped(dismiss.title, Icons.Filled.Close, dismiss.run, danger = true) {
                Menu(commercialInboxMenu(r, store, item.key, subject, doors.openSubject)) { long ->
                    WorkSidebarRow(
                        if (item.offer != null) Icons.Filled.Description else Icons.Filled.Key, title, detail,
                        { doors.openSubject(subject) }, square = true, onLongClick = long,
                    )
                }
            }
        }
        is InboxSalesItem -> {
            // `metadataLabel`: source, who, and when. A tap starts a lead from it.
            val touch = item.touch
            val source = touchSourceTitle(r, SalesTouch.sourceKey(touch))
            val title = SalesTouch.displayTitle(touch, source)
            val who = touch.organization?.let { "${touch.contact.name} · ${it.name}" } ?: touch.contact.name
            val meta = listOfNotNull(source, who, TaskDates.parse(touch.occurredAt)?.let(WorkFormat::dateTime)).joinToString(" · ")
            val start = WorkRowAction(r.getString(R.string.work_start_lead)) { doors.startLead(item) }
            val dismiss = WorkRowAction(r.getString(R.string.work_dismiss), danger = true) { store.dismissTouch(item) }
            Swiped(dismiss.title, Icons.Filled.Close, dismiss.run, danger = true) {
                Menu(listOf(start, dismiss)) { long ->
                    WorkSidebarRow(
                        Icons.Filled.Inbox, title, r.getString(R.string.work_inbox_sales, meta), { doors.startLead(item) },
                        onLongClick = long, label = r.getString(R.string.work_start_lead_label, title, meta),
                    )
                }
            }
        }
        else -> Unit
    }
}

@Composable
private fun Menu(actions: List<WorkRowAction>, content: @Composable (onLongClick: (() -> Unit)?) -> Unit) = WorkRowMenu(actions, content)

/** A row with a trailing swipe when [title] is set, else the row alone. */
@Composable
private fun Swiped(title: String?, icon: ImageVector, run: () -> Unit, danger: Boolean = false, content: @Composable () -> Unit) {
    if (title == null) content() else WorkSwipeRow(title, icon, run, danger = danger) { content() }
}

/** "Offer expires 7 Nov 2026", "License renews 7 Nov 2026", or "License renewal passed 28 Oct 2026". */
internal fun commercialTitle(r: Resources, item: InboxCommercialItem, today: java.time.LocalDate): String {
    val day = OverviewText.day(item.due) ?: item.due
    return r.getString(
        when (WorkInbox.commercialLine(item, today)) {
            WorkInbox.CommercialLine.OFFER_EXPIRES -> R.string.work_offer_expires
            WorkInbox.CommercialLine.LICENSE_RENEWS -> R.string.work_license_renews
            WorkInbox.CommercialLine.RENEWAL_PASSED -> R.string.work_license_renewal_passed
        },
        day,
    )
}

/** "Acme · Pilot offer · €12,000": the subject, the offer's title or the license's product, its amount as Overview draws it. */
internal fun commercialDetail(r: Resources, item: InboxCommercialItem): String {
    val offer = item.offer
    val license = item.license
    val (what, amount) = when {
        offer != null -> OverviewText.offerTitle(r, offer) to OverviewText.offerAmount(offer)
        license != null -> (license.product?.trim()?.takeIf { it.isNotEmpty() } ?: r.getString(R.string.work_license)) to OverviewText.licenseAmount(license)
        else -> null to null
    }
    return listOfNotNull(item.subject.title.ifEmpty { null }, what, amount).joinToString(" · ")
}

/** "Decision · Asked by Vocab · Recommended: Behind a flag · Default by 3 Oct", or "Overdue · …". */
internal fun decisionDetail(r: Resources, ask: DecisionAsk): String = listOf(
    r.getString(if (ask.overdue) R.string.work_overdue else R.string.work_decision),
    r.getString(R.string.work_asked_by, ask.askedBy),
    r.getString(R.string.work_recommended_value, DecisionLines.recommendedLabel(ask)),
    defaultByLabel(r, ask),
).joinToString(" · ")

internal fun defaultByLabel(r: Resources, ask: DecisionAsk): String =
    r.getString(R.string.work_default_by, DecisionLines.day(ask.defaultBy)?.let(WorkFormat::civilDay) ?: ask.defaultBy)

/** `questionDetail`: "Question · Asked by Vocab · Acme". */
internal fun questionDetail(r: Resources, request: AttentionRequest): String =
    listOf(r.getString(R.string.work_question), r.getString(R.string.work_asked_by, request.askedBy), request.subject?.title ?: request.context)
        .filterNotNull().filter { it.isNotEmpty() }.joinToString(" · ")

/** `invitationDetail`: "Invitation · 7 Oct · 14:00 · Work"; an all-day event has no time. */
private fun invitationDetail(r: Resources, item: InboxInvitationItem, now: Long): String {
    val event = item.event
    val start = Upcoming.parse(event.start)
    return listOfNotNull(
        r.getString(R.string.work_invitation),
        start?.let { WorkFormat.cardDate(it, now) },
        if (event.allDay) null else start?.let(WorkFormat::time),
        event.calendarSummary.ifEmpty { null },
    ).joinToString(" · ")
}

/** `scheduleLine`: "7 Oct · 14:00 · From email". */
private fun forwardedDetail(r: Resources, item: InboxForwardedItem, now: Long): String {
    val start = Upcoming.parse(item.event.start)
    return listOfNotNull(
        start?.let { WorkFormat.cardDate(it, now) },
        if (item.event.allDay) null else start?.let(WorkFormat::time),
        r.getString(R.string.work_from_email),
    ).joinToString(" · ")
}

/** `WorkInboxBooking.detailLabel`: "Booked · Tomorrow 14:00 · Acme", "Rescheduled · was …", "Cancelled · was …". */
private fun bookingDetail(r: Resources, item: InboxBookingItem, now: Long): String {
    fun at(wire: String?) = TaskDates.parse(wire)?.let { WorkFormat.dayTime(r, it, now) }
    val booking = item.booking
    val parts = when (item.change) {
        InboxBookingChange.RESCHEDULED -> listOfNotNull(r.getString(R.string.work_rescheduled), at(booking.previousStartTime)?.let { r.getString(R.string.work_was, it) }, at(booking.startTime))
        InboxBookingChange.CANCELLED -> listOfNotNull(r.getString(R.string.work_cancelled), at(booking.startTime)?.let { r.getString(R.string.work_was, it) })
        else -> listOfNotNull(r.getString(R.string.work_booked), at(booking.startTime))
    }.toMutableList()
    booking.guestOrganization?.takeIf { it.isNotEmpty() }?.let(parts::add)
    return parts.joinToString(" · ")
}

/**
 * `MobileDecisionSheet`: the question, who asked, overdue and the default
 * day, the context, the links, an optional note, then one button per
 * option with the recommendation marked. A tap answers and closes.
 */
@Composable
internal fun DecisionSheet(ask: DecisionAsk, onDismiss: () -> Unit, onAnswer: (DecisionAskOption, String?) -> Unit) {
    val context = LocalContext.current
    val r = context.resources
    val c = Starlings.colors
    var note by remember { mutableStateOf("") }
    WorkSheet(stringResource(R.string.work_decision), stringResource(R.string.work_close), onDismiss) {
        WorkSection {
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(ask.question, style = StarlingsType.headline, color = c.primary)
                Text(r.getString(R.string.work_asked_by, ask.askedBy), style = StarlingsType.subheadline, color = c.primary)
                val meta = listOfNotNull(if (ask.overdue) r.getString(R.string.work_overdue) else null, defaultByLabel(r, ask), ask.subject?.title).joinToString(" · ")
                Text(meta, style = StarlingsType.footnote, color = if (ask.overdue) c.danger else c.secondary)
            }
        }
        ask.context?.takeIf { it.isNotEmpty() }?.let { text ->
            WorkSection { Text(text, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), style = StarlingsType.callout, color = c.primary) }
        }
        if (ask.links.isNotEmpty()) {
            WorkSection(header = { work.starlings.android.ui.WorkHeaderTitle(stringResource(R.string.work_links)) }) {
                ask.links.forEachIndexed { index, link ->
                    if (index > 0) WorkDivider()
                    work.starlings.android.ui.WorkActionRow(link.title ?: link.url, {
                        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link.url))) }
                    }, accent = true)
                }
            }
        }
        Box(Modifier.padding(horizontal = 16.dp)) {
            StarlingsField(note, { note = it }, placeholder = stringResource(R.string.work_note_optional), singleLine = false, maxLines = 4)
        }
        Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(stringResource(R.string.work_choose_option), style = StarlingsType.footnote, color = c.secondary)
            ask.options.forEach { option ->
                val isRecommended = option.key == ask.recommendation
                val label = if (isRecommended) r.getString(R.string.work_recommended_option, option.label) else option.label
                Box(Modifier.fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = label }) {
                    BorderedButton(
                        if (isRecommended) "${option.label} · ${r.getString(R.string.work_recommended)}" else option.label,
                        { onAnswer(option, note.trim().ifEmpty { null }); onDismiss() },
                        Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

/**
 * `MobileAttentionQuestionSheet`: the prompt, who asked, the context; then
 * the answer controls, only for the person it waits on and only after a
 * fresh read (`AttentionQuestionState`); a resolved request says how it
 * ended. It reads the request again while open.
 */
@Composable
internal fun QuestionSheet(store: WorkStore, initial: AttentionRequest, onDismiss: () -> Unit) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var draft by remember(initial.id) { mutableStateOf(QuestionDraft(initial)) }
    var error by remember { mutableStateOf<String?>(null) }
    var reported by remember { mutableStateOf<Long?>(null) }
    val email = store.selfEmail

    LaunchedEffect(initial.id) {
        while (true) {
            if (!draft.busy) {
                try {
                    val next = store.client.call(work.starlings.android.api.WorkExtraRoutes.attentionRequest(initial.id))
                    draft = draft.adopt(next).copy(fresh = true)
                    error = null
                } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    draft = draft.copy(fresh = false)
                    error = e.workMessage()
                }
                if (draft.request.state != AttentionState.OPEN && reported != draft.request.revision) {
                    reported = draft.request.revision
                    store.questionResolved()
                }
            }
            delay(QUESTION_POLL_MS)
        }
    }

    fun resolve(action: AttentionResolveInputAction) {
        if (!draft.canAnswer(email)) return
        val ids = draft.chosen
        if (action == AttentionResolveInputAction.ANSWER && ids.isEmpty()) return
        draft = draft.copy(busy = true)
        error = null
        scope.launch {
            try {
                val result = store.client.call(
                    work.starlings.android.api.WorkExtraRoutes.resolveAttention(
                        initial.id,
                        AttentionResolveInput(action = action, optionIds = if (action == AttentionResolveInputAction.ANSWER) ids else emptyList()),
                    ),
                )
                // accepted=false still carries the first terminal winner.
                draft = draft.adopt(result.request)
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                error = e.workMessage()
            }
            draft = draft.copy(busy = false)
            if (draft.request.state != AttentionState.OPEN) store.questionResolved()
        }
    }

    val request = draft.request
    WorkSheet(stringResource(R.string.work_question), stringResource(R.string.work_close), { if (!draft.busy) onDismiss() }) {
        WorkSection {
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(request.prompt, style = StarlingsType.headline, color = c.primary)
                Text(r.getString(R.string.work_asked_by, request.askedBy), style = StarlingsType.subheadline, color = c.primary)
                (request.subject?.title ?: request.context)?.let { Text(it, style = StarlingsType.footnote, color = c.secondary) }
            }
        }
        val terminal = draft.terminal
        when {
            terminal != null -> WorkSection {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(terminalLabel(r, terminal), style = StarlingsType.body, color = c.primary)
                    request.answer?.let { Text(it.optionLabels.joinToString(", "), style = StarlingsType.body, color = c.secondary) }
                }
            }
            draft.fresh && email?.lowercase() != request.recipientEmail.lowercase() -> WorkSection {
                WorkNote(r.getString(R.string.work_waiting_on, request.recipientEmail))
            }
            else -> Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                val enabled = draft.canAnswer(email)
                val single = request.selectionMode == work.starlings.contracts.AttentionSelectionMode.SINGLE
                request.options.forEach { option ->
                    val chosen = option.id in draft.selected
                    Box(Modifier.fillMaxWidth().semantics { selected = chosen }) {
                        BorderedButton(
                            option.label,
                            {
                                draft = draft.toggle(option.id)
                                if (single) resolve(AttentionResolveInputAction.ANSWER)
                            },
                            Modifier.fillMaxWidth(),
                            enabled = enabled,
                            icon = if (chosen) Icons.Filled.Check else null,
                        )
                    }
                }
                if (!single) {
                    BorderedButton(stringResource(R.string.work_submit_answer), { resolve(AttentionResolveInputAction.ANSWER) }, Modifier.fillMaxWidth(), enabled = enabled && draft.selected.isNotEmpty())
                }
                BorderedButton(stringResource(R.string.work_dismiss), { resolve(AttentionResolveInputAction.DISMISS) }, Modifier.fillMaxWidth(), enabled = enabled)
            }
        }
        error?.let { WorkSection { Text(it, Modifier.padding(horizontal = 16.dp, vertical = 10.dp), style = StarlingsType.callout, color = c.danger) } }
    }
}

/** `DirectMessageCadence.openThreadPoll`. */
private const val QUESTION_POLL_MS = 4_000L

private fun terminalLabel(r: Resources, state: AttentionState): String = when (state) {
    AttentionState.ANSWERED -> r.getString(R.string.work_answered)
    AttentionState.DISMISSED -> r.getString(R.string.work_dismissed)
    AttentionState.WITHDRAWN -> r.getString(R.string.work_withdrawn)
    AttentionState.DEFAULTED -> r.getString(R.string.work_default_applied)
    else -> state.value
}
