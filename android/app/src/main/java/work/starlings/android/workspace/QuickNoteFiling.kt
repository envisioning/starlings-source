package work.starlings.android.workspace

import work.starlings.android.Search
import work.starlings.contracts.CrmIssueCreate
import work.starlings.contracts.CrmResponsiblePartyValue
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import work.starlings.contracts.CrmTaskCreate
import work.starlings.contracts.CrmTaskStatusValue
import work.starlings.contracts.Patch
import work.starlings.contracts.QuickNotePromotionKind

/**
 * The rules of filing one Quick Note (`MobileQuickNoteTriageSheet`,
 *), with no Android in them. Task and Issue need a subject (an
 * issue a project), Message a conversation, and every kind but Message a
 * title. Home offers [kinds]; Work's sheet offers [withDocs], Doc too, where
 * the workspace has Docs. Home and Work both file through this one copy.
 */
object QuickNoteFiling {
    val kinds = listOf(QuickNotePromotionKind.TASK, QuickNotePromotionKind.ISSUE, QuickNotePromotionKind.MESSAGE)

    /** `[.task, .issue, .message] + (docs.isLinked ? [.doc] : [])`. */
    val withDocs = kinds + QuickNotePromotionKind.DOC

    /** Where a Doc filed from a note lands. */
    const val DOC_FOLDER = "/work"

    fun needsSubject(kind: QuickNotePromotionKind) = kind == QuickNotePromotionKind.TASK || kind == QuickNotePromotionKind.ISSUE
    fun needsTitle(kind: QuickNotePromotionKind) = kind != QuickNotePromotionKind.MESSAGE

    /** `"<kind>:<id>"`, the picker's selection. */
    fun key(s: CrmSubjectWire): String = "${s.kind.value}:${s.id}"

    /** `CrmSubject.stateKey`, the key a star is kept under. */
    fun stateKey(s: CrmSubjectWire): String = "${s.kind.value}:${s.id}"

    /** Starred first, then by title, ignoring case. */
    fun sorted(subjects: List<CrmSubjectWire>, starred: Set<String>): List<CrmSubjectWire> =
        subjects.distinctBy(::key).sortedWith(compareBy<CrmSubjectWire> { stateKey(it) !in starred }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.title })

    /** An issue goes on a project's repository; a task on a project, a lead or a partner. */
    fun offered(subjects: List<CrmSubjectWire>, kind: QuickNotePromotionKind, query: String = ""): List<CrmSubjectWire> =
        subjects.filter { kind != QuickNotePromotionKind.ISSUE || it.kind == CrmSubjectKind.PROJECT }
            .filter { query.isBlank() || Search.matches(query, it.title, it.subtitle.orEmpty()) }

    fun canFile(kind: QuickNotePromotionKind, subjectKey: String, threadId: String, title: String, busy: Boolean): Boolean {
        if (busy) return false
        val clean = title.trim()
        return when (kind) {
            QuickNotePromotionKind.TASK, QuickNotePromotionKind.ISSUE -> subjectKey.isNotEmpty() && clean.isNotEmpty()
            QuickNotePromotionKind.MESSAGE -> threadId.isNotEmpty()
            QuickNotePromotionKind.DOC -> clean.isNotEmpty()
            QuickNotePromotionKind.RETAINED_NOTE -> false
        }
    }

    /** The task a note becomes: no assignee, the filer's team's; the body as notes when it says more than the title. */
    fun task(body: String, title: String, subject: CrmSubjectWire): CrmTaskCreate {
        val clean = title.trim()
        return CrmTaskCreate(
            title = clean,
            notes = if (body == clean) Patch.Omit else Patch.Value(body),
            status = CrmTaskStatusValue.PENDING,
            responsibleParty = CrmResponsiblePartyValue.TEAM,
            projectId = if (subject.kind == CrmSubjectKind.PROJECT) Patch.Value(subject.id) else Patch.Omit,
            leadId = if (subject.kind == CrmSubjectKind.LEAD) Patch.Value(subject.id) else Patch.Omit,
            organizationId = if (subject.kind == CrmSubjectKind.ORGANIZATION) Patch.Value(subject.id) else Patch.Omit,
        )
    }

    fun issue(body: String, title: String, project: CrmSubjectWire): CrmIssueCreate =
        CrmIssueCreate(projectId = project.id, title = title.trim(), body = body)

    /** `note_firstLine` (Sources/QuickNotes.swift): the first non-empty line, trimmed of spaces; the proposed title. */
    fun firstLine(body: String): String =
        (body.split('\n', '\r').firstOrNull { it.isNotEmpty() } ?: body).trim(' ', '\t')
}
