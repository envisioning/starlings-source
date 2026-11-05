package work.starlings.android.workspace.calendar

import work.starlings.android.MeetingKinds
import work.starlings.contracts.CalendarEventSubject
import work.starlings.contracts.CalendarEventSubjectKind
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire

/**
 * Filing an event under a project, lead or partner (`MobileSubjectPicker`,
 * `CalendarWorkspace.setSubject`). The kinds are the subject registry's
 * `calendarEvents` list (`fixtures/subject-kinds.json`), named as
 * [MeetingKinds] names them. The choice is owner-wide: the
 * `event_subjects` preference, keyed by the event's demotion key.
 */
object CalendarFiling {
    /** `kinds(with: .calendarEvents)`, in the registry's order. */
    val kinds: List<CrmSubjectKind> = listOf(CrmSubjectKind.PROJECT, CrmSubjectKind.LEAD, CrmSubjectKind.ORGANIZATION)

    /** The meeting kind a subject kind files as: `organization` is a Partner. */
    fun meetingKind(kind: CrmSubjectKind): MeetingKinds.Kind? = MeetingKinds.all.firstOrNull { it.subject == kind.value }

    fun subject(wire: CrmSubjectWire): CalendarEventSubject? {
        if (wire.kind !in kinds) return null
        return CalendarEventSubject(CalendarEventSubjectKind(wire.kind.value), wire.id, wire.title)
    }

    /** The map the save writes: this event's key set to [subject], or taken out. */
    fun withSubject(map: Map<String, CalendarEventSubject>, key: String, subject: CalendarEventSubject?): Map<String, CalendarEventSubject> =
        if (subject == null) map - key else map + (key to subject)

    /** Work's page for the subject (`subjectHref`). */
    fun workPath(subject: CalendarEventSubject): String =
        "/work/${subject.kind.value}/${java.net.URLEncoder.encode(subject.id, Charsets.UTF_8).replace("+", "%20")}"
}
