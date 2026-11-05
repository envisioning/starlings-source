package work.starlings.android.workspace.home

import android.content.Context
import work.starlings.android.R
import work.starlings.android.SearchDoor
import work.starlings.android.SearchKind
import work.starlings.android.SearchRow
import work.starlings.android.SearchSubjectKind
import work.starlings.android.Upcoming
import work.starlings.android.WorkStage
import work.starlings.android.workspace.team.displayTitle
import work.starlings.android.workspace.team.isChannel
import work.starlings.android.workspace.team.isGroup
import work.starlings.android.workspace.team.shortName
import work.starlings.android.workspace.work.MineItem
import work.starlings.android.workspace.work.commercialDetail
import work.starlings.android.workspace.work.commercialTitle
import work.starlings.contracts.CommercialSummary
import work.starlings.contracts.InboxBookingChange
import work.starlings.contracts.InboxBookingItem
import work.starlings.contracts.InboxCardItem
import work.starlings.contracts.InboxCardItemStage
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
import work.starlings.contracts.InboxSubjectRefKind
import work.starlings.contracts.InboxSubmissionItem
import work.starlings.contracts.InboxTaskItem
import work.starlings.contracts.ThreadKind
import work.starlings.contracts.ThreadSummaryWire
import work.starlings.contracts.UntriagedTouchSource
import java.text.NumberFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Currency

/**
 * The words of Home's INBOX, MINE, COMMERCIAL and QUICK ACCESS rows: the
 * glance lines of `WorkInboxItem` (Sources/WorkInbox.swift), `HomeMine`
 * (Sources/WorkSurface.swift), `MobileCommercialCard` and `homeTypeLabel`
 * (Sources/Search.swift).
 */
object HomeWorkText {
    private fun locale(context: Context) = HomeText.locale(context)

    /** `StarlingsDateFormatting.date`, abbreviated: "3 Oct 2026". */
    fun date(context: Context, atMs: Long, zone: ZoneId = ZoneId.systemDefault()): String =
        DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale(context)).format(Instant.ofEpochMilli(atMs).atZone(zone))

    /** `cardDate`: "6 Oct", or "6 Oct 2027" in another year. */
    fun cardDate(context: Context, atMs: Long, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String {
        val l = locale(context)
        val at = Instant.ofEpochMilli(atMs).atZone(zone)
        val sameYear = at.year == Instant.ofEpochMilli(nowMs).atZone(zone).year
        val pt = l.language == "pt"
        val pattern = when {
            sameYear && pt -> "d 'de' MMM"
            sameYear -> "d MMM"
            pt -> "d 'de' MMM 'de' yyyy"
            else -> "d MMM yyyy"
        }
        return DateTimeFormatter.ofPattern(pattern, l).format(at)
    }

    // Conversations

    /** `ThreadSummary.title`. */
    fun threadTitle(context: Context, thread: ThreadSummaryWire): String =
        thread.displayTitle ?: context.getString(R.string.home_conversation)

    /** `previewWithSender`: the sender's first name before the line, where the title does not name them. */
    fun threadPreview(thread: ThreadSummaryWire, rosterName: (String) -> String?): String? {
        val preview = thread.lastMessagePreview?.takeIf { it.isNotEmpty() } ?: return null
        val email = thread.lastSenderEmail?.lowercase()?.takeIf { it.isNotEmpty() } ?: return preview
        if (thread.kind == ThreadKind.DM && !thread.isGroup) return preview
        val sender = rosterName(email) ?: thread.peers.orEmpty().firstOrNull { it.email.lowercase() == email }?.shortName ?: return preview
        return "$sender: $preview"
    }

    fun threadLabel(context: Context, thread: ThreadSummaryWire): String {
        val title = threadTitle(context, thread)
        return context.getString(if (thread.kind.isChannel) R.string.home_unread_in else R.string.home_unread_from, title)
    }

    // INBOX items

    /** `glanceTitle`. */
    fun title(context: Context, item: InboxItem): String = when (item) {
        is InboxTaskItem -> item.task.title
        is InboxCardItem -> item.task?.title ?: item.issue?.title.orEmpty()
        is InboxFollowUpItem -> item.draft.subject
        is InboxSalesItem -> item.touch.preview.trim().ifEmpty { sourceLabel(context, item.touch.source) }
        is InboxCommentItem -> item.document.title
        is InboxBookingItem -> item.booking.guestName
        is InboxInvitationItem -> item.event.title.ifEmpty { context.getString(R.string.home_calendar_invitation) }
        is InboxForwardedItem -> item.event.title
        is InboxInterestItem -> item.submission.company
        is InboxSubmissionItem -> item.submission.organization.ifEmpty { item.submission.name }
        is InboxCommercialItem -> commercialTitle(context.resources, item, LocalDate.now())
        is InboxDecisionItem -> item.ask.question
        is InboxQuestionItem -> item.request.prompt
        else -> ""
    }

    /** `glanceDetail`. */
    fun detail(context: Context, item: InboxItem, nowMs: Long): String = when (item) {
        is InboxTaskItem -> context.getString(
            if (item.subject.kind == InboxSubjectRefKind.ORGANIZATION) R.string.home_proposed_partner else R.string.home_proposed,
            item.subject.title,
        )
        is InboxCardItem -> context.getString(
            if (item.stage == InboxCardItemStage.BLOCKED) R.string.home_card_blocked else R.string.home_card_review,
            item.agent.name, item.subject.title,
        )
        is InboxFollowUpItem -> context.getString(R.string.home_followup, item.recipients.joinToString(", ") { it.name }, item.subject.title)
        is InboxSalesItem -> context.getString(R.string.home_sales_touch, sourceLabel(context, item.touch.source))
        is InboxCommentItem -> context.getString(R.string.home_comment, item.subject?.title ?: context.getString(R.string.home_docs))
        is InboxBookingItem -> bookingDetail(context, item, nowMs)
        is InboxInvitationItem -> {
            val start = Upcoming.parse(item.event.start)
            listOfNotNull(
                context.getString(R.string.home_invitation),
                start?.let { cardDate(context, it, nowMs) },
                if (item.event.allDay) null else start?.let { HomeClock.time(it) },
                item.event.calendarSummary.ifEmpty { null },
            ).joinToString(" · ")
        }
        is InboxForwardedItem -> {
            val start = Upcoming.parse(item.event.start)
            listOfNotNull(
                start?.let { DateTimeFormatter.ofPattern(if (locale(context).language == "pt") "d 'de' MMM" else "MMM d", locale(context)).format(Instant.ofEpochMilli(it).atZone(ZoneId.systemDefault())) },
                if (item.event.allDay) null else start?.let { HomeClock.time(it) },
                context.getString(R.string.home_from_email),
            ).joinToString(" · ")
        }
        is InboxInterestItem -> listOf(context.getString(R.string.home_interest), item.submission.name, item.submission.teamSize, item.submission.deployment)
            .filter { it.isNotEmpty() }.joinToString(" · ")
        is InboxSubmissionItem -> listOf(item.submission.title, item.submission.name, item.submission.summary).filter { it.isNotEmpty() }.joinToString(" · ")
        is InboxCommercialItem -> commercialDetail(context.resources, item)
        is InboxDecisionItem -> {
            val ask = item.ask
            val recommended = ask.options.firstOrNull { it.key == ask.recommendation }?.label ?: ask.recommendation
            listOf(
                context.getString(if (ask.overdue) R.string.home_overdue else R.string.home_decision),
                context.getString(R.string.home_asked_by, ask.askedBy),
                context.getString(R.string.home_recommended, recommended),
                context.getString(R.string.home_default_by, utcDay(context, ask.defaultBy)),
            ).joinToString(" · ")
        }
        is InboxQuestionItem -> listOf(
            context.getString(R.string.home_question),
            context.getString(R.string.home_asked_by, item.request.askedBy),
            item.request.subject?.title ?: item.request.context.orEmpty(),
        ).filter { it.isNotEmpty() }.joinToString(" · ")
        else -> ""
    }

    fun sourceLabel(context: Context, source: UntriagedTouchSource): String = when (source) {
        UntriagedTouchSource.CONTACT -> context.getString(R.string.home_source_contact)
        UntriagedTouchSource.SUPPORT_CASE -> context.getString(R.string.home_source_support)
        UntriagedTouchSource.PRICING_REQUEST -> context.getString(R.string.home_source_pricing)
        UntriagedTouchSource.READINESS_ASSESSMENT -> context.getString(R.string.home_source_readiness)
        else -> source.value
    }

    /** `WorkInboxBooking.detailLabel`: "Booked · Tomorrow 14:00 · Acme". */
    private fun bookingDetail(context: Context, item: InboxBookingItem, nowMs: Long): String {
        val whenText = { wire: String? -> Upcoming.parse(wire)?.let { HomeText.dayTime(context, it, nowMs) } }
        val b = item.booking
        val parts = when (item.change) {
            InboxBookingChange.RESCHEDULED -> listOfNotNull(
                context.getString(R.string.home_rescheduled),
                whenText(b.previousStartTime)?.let { context.getString(R.string.home_was, it) },
                whenText(b.startTime),
            )
            InboxBookingChange.CANCELLED -> listOfNotNull(
                context.getString(R.string.home_cancelled),
                whenText(b.startTime)?.let { context.getString(R.string.home_was, it) },
            )
            else -> listOfNotNull(context.getString(R.string.home_booked), whenText(b.startTime))
        }.toMutableList()
        b.guestOrganization?.takeIf { it.isNotEmpty() }?.let { parts += it }
        return parts.joinToString(" · ")
    }

    /** `DecisionAsk.dayLabel`: a `yyyy-MM-dd` day as a short date, read in UTC so it never shifts. */
    private fun utcDay(context: Context, day: String): String {
        val date = runCatching { LocalDate.parse(day) }.getOrNull() ?: return day
        return date(context, date.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(), ZoneOffset.UTC)
    }

    // MINE

    /** `HomeMine.summary`: "2 overdue · 1 due today", or null. */
    fun mineSummary(context: Context, mine: HomeMine): String? {
        val parts = listOfNotNull(
            mine.lateCount.takeIf { it > 0 }?.let { context.getString(R.string.home_overdue_count, it) },
            mine.todayCount.takeIf { it > 0 }?.let { context.getString(R.string.home_due_today_count, it) },
        )
        return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
    }

    /** `HomeMine.when`. */
    fun mineWhen(context: Context, mine: HomeMine, item: MineItem): String = when (val w = mine.whenOf(item)) {
        is HomeMine.When.Late -> w.dueMs?.let { context.getString(R.string.home_overdue_on, date(context, it)) } ?: context.getString(R.string.home_overdue)
        HomeMine.When.Today -> context.getString(R.string.home_today)
        is HomeMine.When.Soon -> date(context, w.dueMs)
        is HomeMine.When.Stage -> context.getString(
            when (w.stage) {
                WorkStage.REVIEW -> R.string.home_in_review
                WorkStage.BLOCKED -> R.string.home_blocked
                else -> R.string.home_in_progress
            },
        )
        HomeMine.When.None -> ""
    }

    // COMMERCIAL

    /** `.currency(code:).precision(.fractionLength(0))`. */
    fun currency(context: Context, value: Double, code: String): String {
        val format = NumberFormat.getCurrencyInstance(locale(context))
        runCatching { format.currency = Currency.getInstance(code) }
        format.maximumFractionDigits = 0
        format.minimumFractionDigits = 0
        return format.format(value)
    }

    fun number(context: Context, value: Long): String = NumberFormat.getIntegerInstance(locale(context)).format(value)

    fun commercialSummary(context: Context, s: CommercialSummary): String = context.getString(
        R.string.home_commercial_summary,
        s.offers.toInt(),
        currency(context, s.salesAmount, s.currencyCode),
        currency(context, s.pipelineAmount, s.currencyCode),
        s.newLicenses?.let { number(context, it) } ?: context.getString(R.string.home_no),
        s.lookbackMonths.toInt(),
    )

    // QUICK ACCESS

    /** `SearchRow.homeTypeLabel`: a subject by the kind in its door; anything else by the row's kind. */
    fun typeLabel(context: Context, row: SearchRow): String {
        val door = row.door
        if (row.kind == SearchKind.SUBJECT && door is SearchDoor.Subject) {
            return context.getString(
                when (door.subjectKind) {
                    SearchSubjectKind.PROJECT -> R.string.home_kind_project
                    SearchSubjectKind.LEAD -> R.string.home_kind_lead
                    SearchSubjectKind.ORGANIZATION -> R.string.home_kind_partner
                    SearchSubjectKind.EVENT -> R.string.home_kind_event
                },
            )
        }
        return when (row.kind) {
            SearchKind.SUBJECT -> context.getString(R.string.home_kind_subject)
            SearchKind.PERSON -> context.getString(R.string.home_kind_person)
            SearchKind.AGENT -> context.getString(R.string.home_kind_agent)
            SearchKind.CONTACT -> context.getString(R.string.home_kind_contact)
            SearchKind.THREAD -> context.getString(R.string.home_kind_thread)
            SearchKind.DOCUMENT -> context.getString(R.string.home_kind_document)
            SearchKind.FOLDER -> context.getString(R.string.home_kind_folder)
            SearchKind.EVENT -> context.getString(R.string.home_kind_event)
            SearchKind.TASK -> context.getString(R.string.home_kind_task)
            SearchKind.ISSUE -> context.getString(R.string.home_kind_issue)
            SearchKind.GOAL -> context.getString(R.string.home_kind_goal)
            SearchKind.DECISION -> context.getString(R.string.home_kind_decision)
            SearchKind.MILESTONE -> context.getString(R.string.home_kind_milestone)
            SearchKind.CALL -> context.getString(R.string.home_kind_call)
            SearchKind.CORE -> context.getString(R.string.home_kind_core)
            else -> row.kind.label
        }
    }
}
