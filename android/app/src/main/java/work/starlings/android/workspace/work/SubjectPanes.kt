package work.starlings.android.workspace.work

import work.starlings.contracts.CrmSubjectKind

/**
 * `SubjectPane` (`Sources/Generated/SubjectPanesRegistry.swift`), held to
 * `fixtures/subject-panes.json` by `SubjectPanesFixtureTest`: the tabs one
 * subject shows, in order, and what each needs to be there.
 */
enum class SubjectPane(val id: String, val need: SubjectPanes.Need? = null) {
    OVERVIEW("overview"),
    TALK("talk", SubjectPanes.Need.NARROW),
    TASKS("tasks"),
    ISSUES("issues", SubjectPanes.Need.REPO),
    BOARD("board"),
    INTERACTIONS("interactions"),
    FIELDS("fields"),
    DOCUMENTS("documents", SubjectPanes.Need.DOCS),
    PARTNER("partner"),
    EVENT("event"),
    ;

    companion object {
        fun of(id: String?): SubjectPane? = entries.firstOrNull { it.id == id }
    }
}

object SubjectPanes {
    enum class Need(val id: String) { REPO("repo"), NARROW("narrow"), DOCS("docs"), CORE("core") }

    val layout: Map<String, List<SubjectPane>> = mapOf(
        "project" to listOf(SubjectPane.OVERVIEW, SubjectPane.TALK, SubjectPane.BOARD, SubjectPane.TASKS, SubjectPane.ISSUES, SubjectPane.INTERACTIONS, SubjectPane.DOCUMENTS, SubjectPane.FIELDS),
        "lead" to listOf(SubjectPane.OVERVIEW, SubjectPane.TALK, SubjectPane.TASKS, SubjectPane.INTERACTIONS, SubjectPane.DOCUMENTS, SubjectPane.FIELDS),
        "organization" to listOf(SubjectPane.OVERVIEW, SubjectPane.PARTNER, SubjectPane.TALK, SubjectPane.TASKS, SubjectPane.INTERACTIONS, SubjectPane.DOCUMENTS, SubjectPane.FIELDS),
        "event" to listOf(SubjectPane.OVERVIEW, SubjectPane.EVENT, SubjectPane.TALK, SubjectPane.TASKS),
    )

    /** `SubjectPane.panes(for:has:)`. */
    fun panes(kind: String, has: Set<Need>): List<SubjectPane> =
        (layout[kind] ?: listOf(SubjectPane.OVERVIEW)).filter { pane -> pane.need?.let { it in has } ?: true }

    /** The panes this Android build draws: every pane of the table. */
    val drawn: Set<SubjectPane> = setOf(
        SubjectPane.OVERVIEW, SubjectPane.TALK, SubjectPane.TASKS, SubjectPane.ISSUES, SubjectPane.BOARD, SubjectPane.INTERACTIONS,
        SubjectPane.FIELDS, SubjectPane.DOCUMENTS, SubjectPane.PARTNER, SubjectPane.EVENT,
    )

    /**
     * The pane a page shows for the one asked for (`MobileSubjectView.shownPane`
     * and its `onChange(of: panes)`): Talk inside Overview on a regular width;
     * Issues on a project even before a repository is linked (the pane offers
     * the link); a pane the tabs lost falls back to Talk, else Overview.
     */
    fun showing(asked: SubjectPane, tabs: List<SubjectPane>, narrow: Boolean, isProject: Boolean): SubjectPane = when {
        asked == SubjectPane.TALK && !narrow -> SubjectPane.OVERVIEW
        asked in tabs -> asked
        asked == SubjectPane.ISSUES && isProject -> asked
        SubjectPane.TALK in tabs -> SubjectPane.TALK
        else -> SubjectPane.OVERVIEW
    }

    /**
     * The tabs a subject page shows: the table's order, narrowed to what is
     * drawn. Issues once a repository is linked, as iOS; Documents where the
     * workspace has Docs. [narrow] is a compact width: on a regular width
     * Talk is half of Overview (`sideBySide`), so it has no tab of its own.
     */
    fun shown(kind: CrmSubjectKind, hasRepo: Boolean, hasDocs: Boolean, narrow: Boolean = true): List<SubjectPane> =
        panes(kind, hasRepo, hasDocs, narrow).filter { it in drawn }

    /** `MobileSubjectView.panes`: every pane of the table this subject has, drawn here or not. */
    fun panes(kind: CrmSubjectKind, hasRepo: Boolean, hasDocs: Boolean, narrow: Boolean): List<SubjectPane> {
        val has = buildSet {
            if (narrow) add(Need.NARROW)
            add(Need.CORE)
            if (hasRepo) add(Need.REPO)
            if (hasDocs) add(Need.DOCS)
        }
        return panes(kind.value, has)
    }

    /**
     * The pane a path's `?pane=` and `?new=` ask for, when this page draws it:
     * `new=issue` is Issues, `new=document` is Documents, `new=task` is Tasks.
     */
    fun requested(pane: String?, create: String?): SubjectPane? = when (create) {
        "issue" -> SubjectPane.ISSUES
        "document" -> SubjectPane.DOCUMENTS
        "task" -> SubjectPane.TASKS
        else -> SubjectPane.of(pane)?.takeIf { it in drawn }
    }
}
