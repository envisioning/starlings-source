package work.starlings.android.workspace.docs

import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import java.text.Normalizer

/**
 * One way to file documents, as DocsKit's `DocsFilingAct`: into
 * a folder, under a category (null clears it), or on and off a subject.
 */
sealed interface DocsFilingAct {
    data class Folder(val path: String) : DocsFilingAct
    data class Category(val category: String?) : DocsFilingAct
    data class AddSubject(val subject: DocsSubject) : DocsFilingAct
    data class RemoveSubject(val subject: DocsSubject) : DocsFilingAct
}

/** What a list can file into, as DocsUI's `DocsFilingChoices`. The rail loads them; the menu only draws them. */
data class DocsFilingChoices(
    val folders: List<DocsFolder> = emptyList(),
    /** The workspace's categories in rail order. Empty offers "No category" only. */
    val categories: List<DocsSummary.CategoryCount> = emptyList(),
    val projects: List<Subject> = emptyList(),
    val leads: List<Subject> = emptyList(),
    /** A partner files as its organization. */
    val partners: List<Subject> = emptyList(),
) {
    data class Subject(val subject: DocsSubject, val title: String)
}

/** What the toast after a filing says, before the screen words it (`DocsRailGroups.filedMessage`). */
sealed interface DocsFiledMessage {
    data class TakenOff(val place: String, val changed: Int) : DocsFiledMessage
    data class CategoryCleared(val changed: Int) : DocsFiledMessage
    data class FiledIn(val place: String, val changed: Int) : DocsFiledMessage
}

/** One write a filing makes for one document: what `DocsClient.file` sends. */
sealed interface DocsFilingWrite {
    data class Move(val folderPath: String) : DocsFilingWrite
    data class SetCategory(val category: String?) : DocsFilingWrite
    data class SetSubjects(val subjects: List<DocsSubject>) : DocsFilingWrite
}

/**
 * The filing and path rules: `Sources/DocsRailGroups.swift` (`slug`,
 * `folderPath`, `filingChoices`, `filedMessage`) and DocsKit's
 * `DocsFiling.swift` (`folderPath`, `isAbout`, `file`).
 */
object DocsFiling {
    /**
     * `DocsRailGroups.slug`: compatibility decomposition, marks dropped,
     * lower case, apostrophes dropped, every run of anything but `a-z0-9`
     * one dash, at most 60, `untitled` when nothing is left.
     * `fixtures/docs-slug.json` pins it.
     */
    fun slug(title: String): String {
        val decomposed = Normalizer.normalize(title, Normalizer.Form.NFKD)
        val marksDropped = buildString {
            decomposed.codePoints().forEach { if (it !in 0x0300..0x036F) appendCodePoint(it) }
        }.lowercase(java.util.Locale.ROOT)
        val out = StringBuilder()
        var pendingDash = false
        marksDropped.codePoints().forEach { scalar ->
            when (scalar) {
                0x27, 0x2019 -> Unit
                in 0x30..0x39, in 0x61..0x7A -> {
                    if (pendingDash && out.isNotEmpty()) out.append('-')
                    pendingDash = false
                    out.appendCodePoint(scalar)
                }
                else -> pendingDash = true
            }
        }
        val capped = out.toString().take(60).trimEnd('-')
        return capped.ifEmpty { "untitled" }
    }

    /** `DocsRailGroups.folderPath`: `/work/<kind>/<subject-slug>` (docs/DOCS.md, "Default path"). */
    fun folderPath(kind: String, title: String): String = "/work/$kind/${slug(title)}"

    /** `DocsDocumentSummary.folderPath`: `/work/acme/brief` is in `/work/acme`. */
    fun folderOf(path: String): String = "/" + path.split('/').filter { it.isNotEmpty() }.dropLast(1).joinToString("/")

    /** `isAbout`: the document is about this subject, whatever system named it. */
    fun isAbout(document: DocsDocumentSummary, subject: DocsSubject): Boolean =
        document.subjects.any { it.kind == subject.kind && it.subjectId == subject.subjectId }

    /** `CrmSubject.docsSubject`: a project or lead by its kind, a partner by its organization; an event has none. */
    fun docsSubject(subject: CrmSubjectWire): DocsSubject? = when (subject.kind) {
        CrmSubjectKind.PROJECT, CrmSubjectKind.LEAD -> DocsSubject(kind = subject.kind.value, subjectId = subject.id)
        CrmSubjectKind.ORGANIZATION -> DocsSubject(kind = "organization", subjectId = subject.id)
        else -> null
    }

    /** `DocsRailGroups.filingChoices`: the move targets and every project, lead and partner the CRM names. */
    fun choices(
        tree: List<DocsFolder>,
        categories: List<DocsSummary.CategoryCount>,
        projects: List<CrmSubjectWire>,
        leads: List<CrmSubjectWire>,
        partners: List<CrmSubjectWire>,
    ): DocsFilingChoices {
        fun choice(subject: CrmSubjectWire) = docsSubject(subject)?.let { DocsFilingChoices.Subject(it, subject.title) }
        return DocsFilingChoices(
            folders = DocsRules.moveTargets(tree),
            categories = categories,
            projects = projects.mapNotNull(::choice),
            leads = leads.mapNotNull(::choice),
            partners = partners.mapNotNull(::choice),
        )
    }

    /**
     * The write [act] makes on [document], or null when it is filed so
     * already or is not editable: `DocsClient.file` for one document.
     */
    fun write(document: DocsDocumentSummary, act: DocsFilingAct): DocsFilingWrite? {
        if (!document.editable) return null
        return when (act) {
            is DocsFilingAct.Folder -> if (folderOf(document.path) == act.path) null else DocsFilingWrite.Move(act.path)
            is DocsFilingAct.Category -> if (document.category == act.category) null else DocsFilingWrite.SetCategory(act.category)
            is DocsFilingAct.AddSubject ->
                if (isAbout(document, act.subject)) null else DocsFilingWrite.SetSubjects(document.subjects + act.subject)
            is DocsFilingAct.RemoveSubject ->
                if (!isAbout(document, act.subject)) {
                    null
                } else {
                    DocsFilingWrite.SetSubjects(
                        document.subjects.filterNot { it.kind == act.subject.kind && it.subjectId == act.subject.subjectId },
                    )
                }
        }
    }

    /** `DocsRailGroups.filedMessage`: where it went, by the name the menu showed. */
    fun filedMessage(act: DocsFilingAct, changed: Int, choices: DocsFilingChoices): DocsFiledMessage {
        val place = when (act) {
            is DocsFilingAct.Folder -> choices.folders.firstOrNull { it.path == act.path }?.title ?: act.path
            is DocsFilingAct.Category -> act.category?.let { id -> choices.categories.firstOrNull { it.category == id }?.label ?: DocsRules.fallbackLabel(id) }.orEmpty()
            is DocsFilingAct.AddSubject -> subjectTitle(act.subject, choices)
            is DocsFilingAct.RemoveSubject -> subjectTitle(act.subject, choices)
        }
        return when {
            act is DocsFilingAct.RemoveSubject -> DocsFiledMessage.TakenOff(place, changed)
            act is DocsFilingAct.Category && act.category == null -> DocsFiledMessage.CategoryCleared(changed)
            else -> DocsFiledMessage.FiledIn(place, changed)
        }
    }

    private fun subjectTitle(subject: DocsSubject, choices: DocsFilingChoices): String =
        (choices.projects + choices.leads + choices.partners).firstOrNull { it.subject.subjectId == subject.subjectId }?.title
            ?: subject.kind.replaceFirstChar(Char::uppercaseChar)

    /** Where the rail's `+` files a new document: `/work` (`MobileDocsView.create`). */
    const val RAIL_FOLDER = "/work"

    /**
     * `MobileDocsListView.folderPath`: the chosen folder, the chosen subject's
     * folder (docs/DOCS.md, "Default path"), or `/work` for a view.
     */
    fun createFolder(selection: DocsSelection): String = when (selection) {
        is DocsSelection.Folder -> selection.path
        is DocsSelection.Subject -> folderPath(selection.kind, selection.title)
        else -> RAIL_FOLDER
    }

    /** `newSubjects`: a subject's list writes about that subject. */
    fun createSubjects(selection: DocsSelection): List<DocsSubject> =
        if (selection is DocsSelection.Subject) listOf(DocsSubject(kind = selection.kind, subjectId = selection.id)) else emptyList()

    /** `linkSaveFolderPath`: a subject's list files a save there; any other uses Docs' link folder (null). */
    fun linkFolder(selection: DocsSelection): String? =
        if (selection is DocsSelection.Subject) folderPath(selection.kind, selection.title) else null

    /** `canCreate`: not on a search or Links, and LIBRARY is a mirror, so nothing is written there. */
    fun canCreate(selection: DocsSelection): Boolean = when (selection) {
        is DocsSelection.Search, DocsSelection.Links -> false
        is DocsSelection.Category -> selection.half == DocsRailHalf.WORK
        else -> true
    }

    /** `canSaveLink`: everywhere but a LIBRARY category. */
    fun canSaveLink(selection: DocsSelection): Boolean =
        !(selection is DocsSelection.Category && selection.half == DocsRailHalf.LIBRARY)

    /**
     * `DocsLinks.url(fromPasted:)`, narrowed as the Save link sheet narrows
     * it: one https link with a host and nothing else, at most 2,048
     * characters. A paragraph that happens to hold a link is text.
     */
    fun httpsLink(pasted: String): String? {
        val trimmed = pasted.trim()
        if (trimmed.isEmpty() || trimmed.length > 2048 || trimmed.any(Char::isWhitespace)) return null
        val uri = runCatching { java.net.URI(trimmed) }.getOrNull() ?: return null
        if (uri.scheme?.lowercase() != "https" || uri.host.isNullOrEmpty()) return null
        return trimmed
    }

    /**
     * DocumentFileMenu's folder tree: the folders under [parent]; null is
     * the top, every folder whose parent is not itself a choice.
     */
    fun children(folders: List<DocsFolder>, parent: String?): List<DocsFolder> {
        val ids = folders.map { it.id }.toSet()
        return folders
            .filter { if (parent == null) it.parentId?.let(ids::contains) != true else it.parentId == parent }
            .sortedBy { it.path }
    }
}
