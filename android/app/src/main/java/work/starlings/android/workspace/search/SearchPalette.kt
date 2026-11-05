package work.starlings.android.workspace.search

import work.starlings.android.Search
import work.starlings.android.SearchDestination
import work.starlings.android.SearchDoor
import work.starlings.android.SearchKind
import work.starlings.android.SearchPersonVerb
import work.starlings.android.SearchRow
import work.starlings.android.SearchRowVerb
import work.starlings.android.SearchSubjectVerb
import work.starlings.android.SearchVerb
import work.starlings.android.workspace.MemberSurface
import work.starlings.android.workspace.home.HomeLinks
import work.starlings.android.workspace.work.WorkRoute
import work.starlings.contracts.CrmSubjectKind

/**
 * The phone's search list (`iOS/MobileSearchView.swift`), the part with no
 * screen in it. Hits come from `GET /api/search` in the contract's order;
 * doors and recents are this device's. One `Search.run` goes over all of
 * them once more, so a recent row and a door rank by the one rule.
 */
object SearchPalette {
    /** The bare verbs this phone can run: Start room and Open Team Room, as iOS. */
    val VERBS: List<SearchVerb> = listOf(SearchVerb.START_ROOM, SearchVerb.OPEN_INTERNAL_ROOM)

    /** iOS trims spaces only: a query of spaces is the empty query. */
    fun isEmptyQuery(query: String): Boolean = query.trim(' ').isEmpty()

    /** The Go to doors are the tabs this workspace shows, in their order. */
    fun destinations(tabs: List<MemberSurface>): List<SearchDestination> =
        tabs.mapNotNull { tab -> SearchDestination.read(tab.id) }

    /**
     * The door rows: the visible tabs and [VERBS]. No Settings doors: this
     * client has no Settings page to open (a page it cannot draw stays out).
     */
    fun doorRows(tabs: List<MemberSurface>): List<SearchRow> =
        Search.doorRows(destinations(tabs), settingsPages = emptyList(), verbs = VERBS, hasDocs = MemberSurface.DOCS in tabs)

    /**
     * `ranked`: hits, the recents the hits do not hold, Core's rows, then
     * doors; ranked with the recents' keys.
     */
    fun ranked(hits: List<SearchRow>, recents: List<SearchRow>, doors: List<SearchRow>, query: String, core: List<SearchRow> = emptyList()): List<SearchRow> {
        val hitKeys = hits.map { it.key }.toSet()
        val pool = hits + recents.filter { it.key !in hitKeys } + core + doors
        return Search.run(pool, query, Search.Scope.PALETTE.kinds, Search.Order.RANK, recents.map { it.key })
    }

    /** One Core entity this account may see, as the search sheet reads it. */
    data class CoreEntry(val id: String, val pluralLabel: String, val count: Int?)

    /**
     * `coreRows`: Core's registry as rows, one per entity Core publishes to
     * this account, while Core is linked. The subtitle says Core, and how many
     * records once Core has counted them; [subtitle] words it.
     */
    fun coreRows(linked: Boolean, entries: List<CoreEntry>, subtitle: (Int?) -> String): List<SearchRow> {
        if (!linked) return emptyList()
        return entries.map { entry -> SearchRow(SearchKind.CORE, entry.id, entry.pluralLabel, subtitle(entry.count), SearchDoor.Thing(SearchKind.CORE, entry.id)) }
    }

    data class Sections(val recent: List<SearchRow>, val goTo: List<SearchRow>, val verbs: List<SearchRow>)

    /** With no query the list is Recent, then Go to, then Do: the fixture's empty-query order made visible. */
    fun emptySections(ranked: List<SearchRow>, recents: List<SearchRow>): Sections {
        val recentKeys = recents.map { it.key }.toSet()
        return Sections(
            recent = ranked.filter { it.key in recentKeys },
            goTo = ranked.filter { it.key !in recentKeys && it.kind != SearchKind.VERB },
            verbs = ranked.filter { it.kind == SearchKind.VERB },
        )
    }

    /** Full text under the ranked run, minus a document already there. */
    fun <T> docTail(ranked: List<SearchRow>, docHits: List<T>, id: (T) -> String): List<T> {
        val seen = ranked.map { it.key }.toSet()
        return docHits.filter { Search.key(SearchKind.DOCUMENT, id(it)) !in seen }
    }

    /** A full-text hit as the row it opens, as iOS `docRow`. */
    fun documentRow(id: String, title: String): SearchRow =
        SearchRow(SearchKind.DOCUMENT, id, title, "", SearchDoor.Thing(SearchKind.DOCUMENT, id))

    private val spaces = Regex("\\s+")

    /** The FTS snippet without its `<mark>` tags: the row is text, not HTML. */
    fun snippetText(snippet: String): String =
        snippet.replace("<mark>", "").replace("</mark>", "").replace(spaces, " ").trim()

    /** The verbs behind a row on this phone: all of `Search.rowVerbs`, as iOS. */
    fun verbs(row: SearchRow): List<SearchRowVerb> = Search.rowVerbs(row)

    /** What opening a row does: a tab at a web path, or a room hosted on this device. */
    sealed interface Target {
        data class Path(val surface: MemberSurface, val path: String) : Target
        data object StartRoom : Target
        data object OpenTeamRoom : Target

        /** Meet about this (`startRoom(about:)`): the owner's room, filed under the subject. */
        data class MeetAbout(val kind: CrmSubjectKind, val id: String, val title: String) : Target
    }

    /**
     * `hrefForDoor` with its verb (web/src/search-doors.ts): a subject verb
     * opens the subject's own editor, Wave and Call ride on the person's page
     * as `?do=`. Null for a door this client has no page for.
     */
    fun target(row: SearchRow, verb: SearchRowVerb?, roomSlug: String? = null): Target? {
        val door = row.door
        if (door is SearchDoor.Verb && door.verb == SearchVerb.START_ROOM) return Target.StartRoom
        if (door is SearchDoor.Verb && door.verb == SearchVerb.OPEN_INTERNAL_ROOM) return Target.OpenTeamRoom
        // A Core door opens that entity in Work, as iOS `openSearch(.core)` (#222); the web goes to Core's dashboard.
        if (door is SearchDoor.Thing && door.to == SearchKind.CORE) {
            return Target.Path(MemberSurface.WORK, WorkRoute.path(WorkRoute.CoreEntity(door.id)))
        }
        if (door is SearchDoor.Subject && verb is SearchRowVerb.Subject && verb.verb == SearchSubjectVerb.START_ROOM) {
            return Target.MeetAbout(CrmSubjectKind(door.subjectKind.wire), door.id, row.title)
        }
        val path = when {
            door is SearchDoor.Subject && verb is SearchRowVerb.Subject -> when (verb.verb) {
                SearchSubjectVerb.NEW_TASK -> HomeLinks.subject(door.subjectKind.wire, door.id, listOf("pane" to "tasks", "new" to "task"))
                SearchSubjectVerb.NEW_ISSUE -> HomeLinks.subject(door.subjectKind.wire, door.id, listOf("pane" to "issues", "new" to "issue"))
                SearchSubjectVerb.NEW_DOCUMENT -> HomeLinks.subject(door.subjectKind.wire, door.id, listOf("pane" to "documents", "new" to "document"))
                SearchSubjectVerb.START_ROOM -> null
            }
            door is SearchDoor.Thing && verb is SearchRowVerb.Person && (door.to == SearchKind.PERSON || door.to == SearchKind.AGENT) -> {
                val peer = HomeLinks.peer(door.id, agent = door.to == SearchKind.AGENT)
                if (verb.verb == SearchPersonVerb.WAVE || verb.verb == SearchPersonVerb.CALL) "$peer?do=${verb.verb.wire}" else peer
            }
            else -> HomeLinks.door(door, roomSlug)
        } ?: return null
        val surface = HomeLinks.surface(path) ?: return null
        return Target.Path(surface, path)
    }
}
