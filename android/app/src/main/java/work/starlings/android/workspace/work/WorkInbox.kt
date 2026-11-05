package work.starlings.android.workspace.work

import work.starlings.android.Search
import work.starlings.contracts.AttentionRequest
import work.starlings.contracts.AttentionSelectionMode
import work.starlings.contracts.AttentionState
import work.starlings.contracts.CalendarEventWire
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.DecisionAsk
import work.starlings.contracts.InboxBookingChange
import work.starlings.contracts.InboxBookingItem
import work.starlings.contracts.InboxCardItem
import work.starlings.contracts.InboxCardItemStage
import work.starlings.contracts.InboxCommentItem
import work.starlings.contracts.InboxCommercialItem
import work.starlings.contracts.InboxCommercialItemEvent
import work.starlings.contracts.InboxDecisionItem
import work.starlings.contracts.InboxFollowUpItem
import work.starlings.contracts.InboxForwardedItem
import work.starlings.contracts.InboxInterestItem
import work.starlings.contracts.InboxInvitationItem
import work.starlings.contracts.InboxItem
import work.starlings.contracts.InboxNoteItem
import work.starlings.contracts.InboxQuestionItem
import work.starlings.contracts.InboxResponse
import work.starlings.contracts.InboxSalesItem
import work.starlings.contracts.InboxSource
import work.starlings.contracts.InboxSubjectRef
import work.starlings.contracts.InboxSubmissionItem
import work.starlings.contracts.InboxTalkItem
import work.starlings.contracts.InboxTalkItemSource
import work.starlings.contracts.InboxTaskItem
import work.starlings.contracts.source
import java.time.LocalDate

/**
 * INBOX as the phone draws it (`Sources/WorkInbox.swift`,
 * `MobileWorkView.inboxSection`): which rows a build draws, the source a
 * row filters under, the text the one matcher reads, and the decision and
 * question lines. The words are resources; this file holds only the rules.
 */
object WorkInbox {
    /**
     * The contextual filter's sources (`INBOX_FILTER_SOURCES`), in the
     * contract's order: every source but `mention`, which folds into talk.
     */
    val filterSources: List<String> = InboxSource.known.map { it.value }.filter { it != "mention" }

    /** `WorkInboxItem.init?(wire:)`: a stranger, support and guest rows are not drawn on the phone; a note is Quick Notes'. */
    fun drawn(response: InboxResponse): List<InboxItem> = response.items.filter { item ->
        item !is InboxItem.Other && item.source != "support" && item.source != "guest" && item !is InboxNoteItem
    }

    /** INBOX's unfiled notes, for the Quick Notes section under it. */
    fun notes(response: InboxResponse): List<InboxNoteItem> = response.items.filterIsInstance<InboxNoteItem>()

    /** `filterSource`: mention reads as talk. */
    fun filterSource(item: InboxItem): String = if (item.source == "mention") "talk" else item.source

    fun matchesFilter(item: InboxItem, filter: String): Boolean = filter == ALL || filterSource(item) == filter

    /** The texts the one matcher reads (invariant 27): the first is the title, the rest the subtitle. */
    fun searchTexts(item: InboxItem): List<String?> = when (item) {
        is InboxTalkItem -> listOf(item.thread.title, item.thread.lastMessagePreview)
        is InboxTaskItem -> listOf(item.task.title, item.subject.title)
        is InboxCardItem -> listOf(item.task?.title ?: item.issue?.title, item.agent.name, item.subject.title)
        is InboxFollowUpItem -> listOf(item.draft.subject, item.recipients.joinToString(", ") { it.name }, item.subject.title)
        is InboxSalesItem -> listOf(item.touch.organization?.name ?: item.touch.contact.name, item.touch.preview)
        is InboxCommentItem -> listOf(item.document.title, item.latest.bodyMd, item.subject?.title)
        is InboxBookingItem -> listOf(item.booking.guestName, item.booking.guestOrganization, item.booking.guestNotes)
        is InboxInvitationItem -> listOf(item.event.title, item.event.calendarSummary, item.event.location)
        is InboxForwardedItem -> listOf(item.event.title, item.event.location)
        is InboxInterestItem -> listOf(item.submission.company, item.submission.name)
        is InboxSubmissionItem -> listOf(item.submission.organization.ifEmpty { item.submission.name }, item.submission.title, item.submission.summary)
        is InboxCommercialItem -> listOf(item.subject.title, item.offer?.title ?: item.license?.product)
        is InboxDecisionItem -> listOf(item.ask.question, item.ask.askedBy, item.ask.subject?.title)
        is InboxQuestionItem -> listOf(item.request.prompt, item.request.askedBy, item.request.subject?.title ?: item.request.context)
        else -> emptyList()
    }

    fun matches(item: InboxItem, query: String): Boolean {
        val wanted = query.trim()
        if (wanted.isEmpty()) return true
        if (item is InboxSalesItem && item.touch.dismissed) return false
        val parts = searchTexts(item).filterNotNull()
        return Search.matches(wanted, parts.firstOrNull().orEmpty(), parts.drop(1).joinToString(" "))
    }

    /** The rows INBOX holds before the filter: drawn, not a dismissed touch, matching the search. */
    fun searched(response: InboxResponse, query: String): List<InboxItem> =
        drawn(response).filter { !(it is InboxSalesItem && it.touch.dismissed) && matches(it, query) }

    /** `WorkInboxResponse.removing`: a row answered here leaves at once, before the re-read confirms it. */
    fun removing(response: InboxResponse, key: String): InboxResponse = response.copy(items = response.items.filter { key(it) != key })

    fun key(item: InboxItem): String? = when (item) {
        is InboxTalkItem -> item.key
        is InboxTaskItem -> item.key
        is InboxCardItem -> item.key
        is InboxFollowUpItem -> item.key
        is InboxNoteItem -> item.key
        is InboxSalesItem -> item.key
        is InboxCommentItem -> item.key
        is InboxBookingItem -> item.key
        is InboxInvitationItem -> item.key
        is InboxForwardedItem -> item.key
        is InboxInterestItem -> item.key
        is InboxSubmissionItem -> item.key
        is InboxCommercialItem -> item.key
        is InboxDecisionItem -> item.key
        is InboxQuestionItem -> item.key
        else -> null
    }

    fun isMention(item: InboxTalkItem): Boolean = item.source == InboxTalkItemSource.MENTION

    /** The subject an INBOX ref names, for the subject page. */
    fun subject(ref: InboxSubjectRef): SubjectRef = SubjectRef(CrmSubjectKind.of(ref.kind.value), ref.id, ref.title)

    /** What a commercial row says: an offer that expires, a license that renews, or a renewal day already gone. */
    enum class CommercialLine { OFFER_EXPIRES, LICENSE_RENEWS, RENEWAL_PASSED }

    /** An `offer_expiring` row is an offer; any other event is a license, passed when `due` is before [today]. */
    fun commercialLine(item: InboxCommercialItem, today: LocalDate): CommercialLine = when {
        item.event == InboxCommercialItemEvent.OFFER_EXPIRING -> CommercialLine.OFFER_EXPIRES
        TaskDates.day(item.due)?.isBefore(today) == true -> CommercialLine.RENEWAL_PASSED
        else -> CommercialLine.LICENSE_RENEWS
    }

    /** The lead or organization a commercial row is about, for the subject page. */
    fun commercialSubject(item: InboxCommercialItem): SubjectRef =
        SubjectRef(CrmSubjectKind.of(item.subject.kind.value), item.subject.id, item.subject.title)

    /** A card is a Review or a Blocked stop (`WorkInboxCard.Stage`). */
    fun isBlocked(card: InboxCardItem): Boolean = card.stage == InboxCardItemStage.BLOCKED

    /** `WorkInboxBooking.eventReference`: `primary:<google id>`, none once cancelled. */
    fun bookingEventReference(item: InboxBookingItem): String? =
        if (item.change == InboxBookingChange.CANCELLED) null else item.booking.googleEventId?.let { "primary:$it" }

    /** `CalendarEventSummary.rawEventID`: the Worker prefixes the Google id with the calendar ref. */
    fun rawEventId(event: CalendarEventWire): String {
        val prefix = "${event.calendarId}:"
        return if (event.id.startsWith(prefix)) event.id.removePrefix(prefix) else event.id
    }

    /** `eventReference`: `<calendarId>:<eventId>`, the door a search row spells for an event. */
    fun eventReference(event: CalendarEventWire): String = "${event.calendarId}:${rawEventId(event)}"

    /** The filter's default: every source (`DEFAULT_INBOX_FILTER`). */
    const val ALL = "all"
}

/** `DecisionAsk` as INBOX reads it (`Sources/WorkInbox.swift`). */
object DecisionLines {
    /** `recommendedLabel`: the recommended option's label, or its key when the list lacks it. */
    fun recommendedLabel(ask: DecisionAsk): String = ask.options.firstOrNull { it.key == ask.recommendation }?.label ?: ask.recommendation

    fun recommended(ask: DecisionAsk) = ask.options.firstOrNull { it.key == ask.recommendation }

    /** `dayLabel`: a `YYYY-MM-DD` day read as the day it names; null for nonsense (the raw string shows). */
    fun day(defaultBy: String): LocalDate? = runCatching { LocalDate.parse(defaultBy.take(10)) }.getOrNull()
}

/** `AttentionQuestionState`: the draft, who may answer, and the canonical winner. */
data class QuestionDraft(
    val request: AttentionRequest,
    val selected: Set<String> = emptySet(),
    val busy: Boolean = false,
    /** A permission read landed: the controls may be used. */
    val fresh: Boolean = false,
) {
    fun canAnswer(email: String?): Boolean =
        fresh && !busy && request.state == AttentionState.OPEN && email?.lowercase() == request.recipientEmail.lowercase()

    /** One tap: a single choice replaces, a multiple choice toggles. */
    fun toggle(id: String): QuestionDraft {
        if (request.options.none { it.id == id } || request.state != AttentionState.OPEN) return this
        val next = when {
            request.selectionMode == AttentionSelectionMode.SINGLE -> setOf(id)
            id in selected -> selected - id
            else -> selected + id
        }
        return copy(selected = next)
    }

    /** `adopt`: a newer or equal revision of the same request wins; a resolved one clears the draft. */
    fun adopt(next: AttentionRequest): QuestionDraft {
        if (next.id != request.id || next.revision < request.revision) return this
        return copy(request = next, selected = if (next.state != AttentionState.OPEN) emptySet() else selected)
    }

    /** The chosen ids, in the request's own order. */
    val chosen: List<String> get() = request.options.filter { it.id in selected }.map { it.id }

    /** `terminalLabel`'s state, or null while open. */
    val terminal: AttentionState? get() = request.state.takeIf { it != AttentionState.OPEN }
}
