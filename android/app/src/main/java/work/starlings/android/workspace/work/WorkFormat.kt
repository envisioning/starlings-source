package work.starlings.android.workspace.work

import android.content.res.Resources
import work.starlings.android.R
import work.starlings.android.WorkItems
import work.starlings.android.WorkStage
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * The words and dates the Work tab draws, resolved against the app's
 * resources: `StarlingsDateFormatting`, `CrmTaskStatus.menuTitle`,
 * `CrmTaskResponsible.title`, `MobileTaskWhere`, `CrmSubject.standing`.
 */
internal object WorkFormat {
    private fun zone() = ZoneId.systemDefault()

    /** `StarlingsDateFormatting.date`: an abbreviated day, "28 Oct 2026", in the reader's locale. */
    fun day(ms: Long): String =
        DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(Locale.getDefault()).format(Instant.ofEpochMilli(ms).atZone(zone()))

    /** `meetDateTimeString(dateStyle: .abbreviated)`: the day, then a 24-hour clock. */
    fun dateTime(ms: Long): String {
        val at = Instant.ofEpochMilli(ms).atZone(zone())
        return "${day(ms)}, ${DateTimeFormatter.ofPattern("HH:mm", Locale.getDefault()).format(at)}"
    }

    /** `StarlingsDateFormatting.time`: the 24-hour clock. */
    fun time(ms: Long): String = DateTimeFormatter.ofPattern("HH:mm", Locale.getDefault()).format(Instant.ofEpochMilli(ms).atZone(zone()))

    /** `cardDate`: "7 Oct" this year, with the year otherwise, in the reader's locale. */
    fun cardDate(ms: Long, now: Long = System.currentTimeMillis()): String {
        val at = Instant.ofEpochMilli(ms).atZone(zone())
        val sameYear = at.year == Instant.ofEpochMilli(now).atZone(zone()).year
        val pattern = android.text.format.DateFormat.getBestDateTimePattern(Locale.getDefault(), if (sameYear) "MMMd" else "yMMMd")
        return DateTimeFormatter.ofPattern(pattern, Locale.getDefault()).format(at)
    }

    /** `StarlingsDateFormatting.dayTime`: "Today 14:00", "Tomorrow 14:00", else "Tue 7 Oct 14:00". */
    fun dayTime(r: Resources, ms: Long, now: Long = System.currentTimeMillis()): String {
        val at = Instant.ofEpochMilli(ms).atZone(zone())
        val today = Instant.ofEpochMilli(now).atZone(zone()).toLocalDate()
        val clock = time(ms)
        return when (at.toLocalDate()) {
            today -> r.getString(R.string.work_today_at, clock)
            today.plusDays(1) -> r.getString(R.string.work_tomorrow_at, clock)
            else -> {
                val pattern = android.text.format.DateFormat.getBestDateTimePattern(Locale.getDefault(), "EEEdMMM")
                "${DateTimeFormatter.ofPattern(pattern, Locale.getDefault()).format(at)} $clock"
            }
        }
    }

    /** `DecisionAsk.dayLabel`: a civil `YYYY-MM-DD` as an abbreviated date, never shifted by the zone. */
    fun civilDay(day: java.time.LocalDate): String =
        DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(Locale.getDefault()).format(day)

    fun status(r: Resources, status: TaskStatus): String = r.getString(
        when (status) {
            TaskStatus.PENDING -> R.string.work_status_pending
            TaskStatus.IN_PROGRESS -> R.string.work_status_in_progress
            TaskStatus.REVIEW -> R.string.work_status_review
            TaskStatus.BLOCKED -> R.string.work_status_blocked
            TaskStatus.COMPLETED -> R.string.work_status_completed
            TaskStatus.CANCELLED -> R.string.work_status_cancelled
            TaskStatus.PROPOSED -> R.string.work_status_proposed
            TaskStatus.DECLINED -> R.string.work_status_declined
        },
    )

    /** `menuTitle`: the editor's words. */
    fun sideMenu(r: Resources, side: TaskSide): String = r.getString(
        when (side) {
            TaskSide.TEAM -> R.string.work_side_team
            TaskSide.CLIENT -> R.string.work_side_client
            TaskSide.UNASSIGNED -> R.string.work_side_unassigned
        },
    )

    /** `CrmTaskResponsible.title`: the team side reads as the workspace's name. */
    fun side(r: Resources, side: TaskSide): String =
        if (side == TaskSide.TEAM) SubjectState.PROJECT_GROUP_NAME else sideMenu(r, side)

    fun whereKind(r: Resources, kind: TaskWhereKind): String = r.getString(
        when (kind) {
            TaskWhereKind.PROJECT -> R.string.work_kind_project
            TaskWhereKind.LEAD -> R.string.work_kind_lead
            TaskWhereKind.EVENT -> R.string.work_kind_event
            TaskWhereKind.PARTNER -> R.string.work_kind_partner
            TaskWhereKind.MEETING -> R.string.work_kind_meeting
            TaskWhereKind.NO_SUBJECT -> R.string.work_kind_no_subject
            TaskWhereKind.SUBJECT -> R.string.work_kind_subject
        },
    )

    fun where(r: Resources, keys: TaskKeys?, subject: SubjectRef?, name: String?): String {
        val kind = TaskWhere.kind(keys, subject)
        return TaskWhere.text(whereKind(r, kind), kind, subject?.title ?: name)
    }

    fun stage(r: Resources, stage: WorkStage): String = r.getString(
        when (stage) {
            WorkStage.QUEUED -> R.string.work_stage_queued
            WorkStage.DOING -> R.string.work_stage_doing
            WorkStage.REVIEW -> R.string.work_stage_review
            WorkStage.BLOCKED -> R.string.work_stage_blocked
            WorkStage.DONE -> R.string.work_stage_done
            WorkStage.DROPPED -> R.string.work_stage_dropped
        },
    )

    /** `columnLabel.capitalized`: "Queued", "Na fila", for a menu or a list header. */
    fun stageTitle(r: Resources, stage: WorkStage): String =
        stage(r, stage).lowercase(Locale.getDefault()).split(' ').joinToString(" ") { word -> word.replaceFirstChar { it.titlecase(Locale.getDefault()) } }

    /** `eventCountdownLabel`, from the one day rule in `WorkItems.eventDaysUntil`. */
    fun eventCountdown(r: Resources, eventDate: String?, now: Long): String {
        val days = WorkItems.eventDaysUntil(eventDate, now, zone()) ?: return r.getString(R.string.work_event_upcoming)
        return when {
            days < 0 -> r.getString(R.string.work_event_past)
            days == 0 -> r.getString(R.string.work_event_today)
            days == 1 -> r.getString(R.string.work_event_one_day_left)
            else -> r.getString(R.string.work_event_days_left, days)
        }
    }

    /** `subjectKindLabel`: the kind, spelled for a row no header names. */
    fun subjectKind(r: Resources, subject: CrmSubjectWire): String = when (subject.kind) {
        CrmSubjectKind.PROJECT ->
            if (SubjectState.group(subject.kind.value, subject.title, subject.isInternal) == SubjectGroup.ENVISIONING) SubjectState.PROJECT_GROUP_NAME
            else r.getString(R.string.work_kind_client)
        CrmSubjectKind.LEAD -> r.getString(R.string.work_kind_lead)
        CrmSubjectKind.EVENT -> r.getString(R.string.work_kind_event)
        CrmSubjectKind.ORGANIZATION -> r.getString(R.string.work_kind_partner)
        else -> r.getString(R.string.work_kind_subject)
    }

    /** `CrmSubject.standing(includeRepository: true, eventLabel:)`. */
    fun standing(r: Resources, subject: CrmSubjectWire, now: Long): String = buildList {
        if (subject.kind == CrmSubjectKind.EVENT) add(eventCountdown(r, subject.eventDate, now))
        subject.subtitle?.takeIf { it.isNotEmpty() }?.let(::add)
        val open = (subject.openTasks ?: 0).toInt()
        val overdue = (subject.overdueTasks ?: 0).toInt()
        if (open > 0) add(r.getString(R.string.work_n_open, open))
        if (overdue > 0) add(r.getString(R.string.work_n_overdue, overdue))
        if (subject.hasRepo == true) add(r.getString(R.string.work_github))
    }.joinToString(" · ")

    /** The rail row's detail: kind, then standing. */
    fun subjectDetail(r: Resources, subject: CrmSubjectWire, now: Long): String =
        listOf(subjectKind(r, subject), standing(r, subject, now)).filter { it.isNotEmpty() }.joinToString(" · ")

    /** `displayTitle`: inside its own group a leading "Envisioning " is dropped, for display only. */
    fun displayTitle(subject: CrmSubjectWire): String {
        val prefix = "${SubjectState.PROJECT_GROUP_NAME} "
        val internal = SubjectState.group(subject.kind.value, subject.title, subject.isInternal) == SubjectGroup.ENVISIONING
        return if (internal && subject.title.startsWith(prefix)) subject.title.removePrefix(prefix) else subject.title
    }
}
