package work.starlings.android

import java.text.Normalizer
import java.util.Locale

/**
 * One search for every client: the row a result is, the kinds a
 * row can be, the door a row opens, and the order results are owed.
 * `Sources/Search.swift` and `packages/contracts/src/search-values.ts`, held
 * to `fixtures/search-rows.json`. The words are `fixtures/search-values.json`.
 *
 * Every search field is the palette's query with a fixed scope. No surface
 * keeps a matcher of its own.
 */

/**
 * The kinds a row can be. The declaration order is the kind order that breaks
 * ties. Every kind before [DESTINATION] is a hit (a thing); the last three are
 * doors (places and verbs).
 */
enum class SearchKind(val wire: String, val label: String) {
    SUBJECT("subject", "Subject"),
    PERSON("person", "Person"),
    AGENT("agent", "Agent"),
    /** A person outside the workspace. The door opens their page. */
    CONTACT("contact", "Contact"),
    THREAD("thread", "Conversation"),
    DOCUMENT("document", "Document"),
    FOLDER("folder", "Folder"),
    EVENT("event", "Event"),
    TASK("task", "Task"),
    ISSUE("issue", "Issue"),
    /** A goal and a decision (#262). Their door is the subject's. */
    GOAL("goal", "Goal"),
    DECISION("decision", "Decision"),
    /** A milestone and a call. Their door is the subject's. */
    MILESTONE("milestone", "Milestone"),
    CALL("call", "Call"),
    CORE("core", "Records"),
    DESTINATION("destination", "Go to"),
    SETTINGS("settings", "Settings"),
    VERB("verb", "Do");

    val isHit: Boolean get() = ordinal < DESTINATION.ordinal

    companion object {
        private val byWire = entries.associateBy { it.wire }
        fun read(wire: String): SearchKind? = byWire[wire]
    }
}

/** The Go to doors are the member surfaces (`fixtures/member-surfaces.json`), in their order. */
enum class SearchDestination(val wire: String, val title: String) {
    HOME("home", "Home"),
    CALENDAR("calendar", "Calendar"),
    WORK("work", "Work"),
    TEAM("team", "Team"),
    DOCS("docs", "Docs");

    companion object {
        fun read(wire: String): SearchDestination? = entries.firstOrNull { it.wire == wire }
    }
}

/** The Settings pages a door can open: the ones every client lists (`fixtures/settings-pages.json`). */
enum class SearchSettingsPage(val wire: String, val title: String) {
    ACCOUNT("account", "Account"),
    HOME("home", "Home"),
    WORK("work", "Work"),
    CALENDAR("calendar", "Calendar"),
    APPEARANCE("appearance", "Appearance"),
    ABOUT("about", "About");

    companion object {
        fun read(wire: String): SearchSettingsPage? = entries.firstOrNull { it.wire == wire }
    }
}

/** The bare palette verbs. */
enum class SearchVerb(val wire: String, val title: String) {
    NEW_TASK("new-task", "New task"),
    NEW_ISSUE("new-issue", "New issue"),
    NEW_DOCUMENT("new-document", "New document"),
    START_ROOM("start-room", "Start room"),
    OPEN_INTERNAL_ROOM("open-internal-room", "Open Team Room");

    companion object {
        fun read(wire: String): SearchVerb? = entries.firstOrNull { it.wire == wire }
    }
}

/** The subject kinds a `subject:<kind>:<id>` door can name, in search's order. */
enum class SearchSubjectKind(val wire: String) {
    LEAD("lead"),
    PROJECT("project"),
    ORGANIZATION("organization"),
    EVENT("event");

    companion object {
        /** `partner` reads as [ORGANIZATION], the kind it was renamed to (ADR 0006). */
        fun read(wire: String): SearchSubjectKind? =
            if (wire == "partner") ORGANIZATION else entries.firstOrNull { it.wire == wire }
    }
}

/**
 * A person is one row; these are its verbs, named per docs/SURFACES.md. A
 * client drops Call when the person is not callable. Knock is not a person verb.
 */
enum class SearchPersonVerb(val wire: String, val title: String) {
    MESSAGE("message", "Message"),
    WAVE("wave", "Wave"),
    CALL("call", "Call"),
}

/** A subject is one row too. The bare verbs' names, with the subject as their argument. */
enum class SearchSubjectVerb(val wire: String, val title: String) {
    NEW_TASK("new-task", "New task"),
    NEW_ISSUE("new-issue", "New issue"),
    NEW_DOCUMENT("new-document", "New document"),
    START_ROOM("start-room", "Meet about this"),
}

/** What → shows behind a row: a person's verbs, or a subject's. */
sealed interface SearchRowVerb {
    val title: String

    data class Person(val verb: SearchPersonVerb) : SearchRowVerb {
        override val title get() = verb.title
    }

    data class Subject(val verb: SearchSubjectVerb) : SearchRowVerb {
        override val title get() = verb.title
    }
}

/**
 * Where a row goes. The wire spelling is `<to>:<id>` (`subject:<kind>:<id>`);
 * [parse] is the one reader and [string] the one writer. A door names an
 * existing route; the palette never invents navigation.
 */
sealed interface SearchDoor {
    val string: String

    data class Destination(val destination: SearchDestination) : SearchDoor {
        override val string get() = "destination:${destination.wire}"
    }

    data class Settings(val page: SearchSettingsPage) : SearchDoor {
        override val string get() = "settings:${page.wire}"
    }

    data class Verb(val verb: SearchVerb) : SearchDoor {
        override val string get() = "verb:${verb.wire}"
    }

    data class Subject(val subjectKind: SearchSubjectKind, val id: String) : SearchDoor {
        override val string get() = "subject:${subjectKind.wire}:$id"
    }

    /** A thing whose id is one opaque string: person, agent, contact, thread, document, folder, event, task, issue, core. */
    data class Thing(val to: SearchKind, val id: String) : SearchDoor {
        init {
            require(to in THING_KINDS) { "search: ${to.wire} is not a thing door" }
        }

        override val string get() = "${to.wire}:$id"
    }

    companion object {
        val THING_KINDS = listOf(
            SearchKind.PERSON, SearchKind.AGENT, SearchKind.CONTACT, SearchKind.THREAD, SearchKind.DOCUMENT,
            SearchKind.FOLDER, SearchKind.EVENT, SearchKind.TASK, SearchKind.ISSUE, SearchKind.CORE,
        )

        /** Null for a door that does not parse: no `<to>`, an empty rest, or a name this build does not know. */
        fun parse(door: String): SearchDoor? {
            val colon = door.indexOf(':')
            if (colon <= 0) return null
            val to = door.substring(0, colon)
            val rest = door.substring(colon + 1)
            if (rest.isEmpty()) return null
            return when (to) {
                "destination" -> SearchDestination.read(rest)?.let(::Destination)
                "settings" -> SearchSettingsPage.read(rest)?.let(::Settings)
                "verb" -> SearchVerb.read(rest)?.let(::Verb)
                "subject" -> {
                    val second = rest.indexOf(':')
                    if (second <= 0) return null
                    val kind = SearchSubjectKind.read(rest.substring(0, second)) ?: return null
                    val id = rest.substring(second + 1)
                    if (id.isEmpty()) null else Subject(kind, id)
                }
                else -> SearchKind.read(to)?.takeIf { it in THING_KINDS }?.let { Thing(it, rest) }
            }
        }
    }
}

/**
 * One result: on the wire from `GET /api/search`, in memory from a client's
 * stores, and in a device's recents. [image] is a mark (an organization's
 * logo); it is never matched and never ranked.
 */
data class SearchRow(
    val kind: SearchKind,
    /** Stable inside its kind; [key] is `<kind>:<id>`. */
    val id: String,
    val title: String,
    /** May be empty. The second line, and the last thing a token can match. */
    val subtitle: String,
    val door: SearchDoor,
    val image: String? = null,
) {
    val doorString: String get() = door.string
    val key: String get() = Search.key(kind, id)

    companion object {
        /** The row as the wire carries it. An unknown kind, an empty id or a door that does not parse is not a row. */
        fun fromWire(kind: String, id: String, title: String, subtitle: String, door: String, image: String? = null): SearchRow? {
            val k = SearchKind.read(kind) ?: return null
            if (id.isEmpty()) return null
            val d = SearchDoor.parse(door) ?: return null
            return SearchRow(k, id, title, subtitle, d, image)
        }
    }
}

object Search {
    val kinds: List<SearchKind> = SearchKind.entries
    /** Things. A hit's door opens the thing. */
    val hitKinds: List<SearchKind> = kinds.filter { it.isHit }
    /** Places and verbs. A door's door is the place or verb itself. */
    val doorKinds: List<SearchKind> = kinds.filterNot { it.isHit }

    /** SCOPE: the kinds each field asks with. A row outside the scope is not considered. */
    enum class Scope(val wire: String, val kinds: List<SearchKind>) {
        PALETTE("palette", SearchKind.entries),
        WORK(
            "work",
            listOf(
                SearchKind.SUBJECT, SearchKind.CONTACT, SearchKind.TASK, SearchKind.ISSUE, SearchKind.GOAL,
                SearchKind.DECISION, SearchKind.MILESTONE, SearchKind.CALL, SearchKind.CORE, SearchKind.DOCUMENT,
            ),
        ),
        TEAM("team", listOf(SearchKind.PERSON, SearchKind.AGENT, SearchKind.THREAD)),
        CALENDAR("calendar", listOf(SearchKind.EVENT)),
        DOCS("docs", listOf(SearchKind.DOCUMENT, SearchKind.FOLDER));

        companion object {
            fun read(wire: String): Scope? = entries.firstOrNull { it.wire == wire }
        }
    }

    enum class Order(val wire: String) {
        /** The matches in the order the rows were given. A field over a list thins it; it does not reshuffle it. */
        LIST("list"),
        /** Tier, then recency, then kind order, then the rows' order. */
        RANK("rank");

        companion object {
            fun read(wire: String): Order? = entries.firstOrNull { it.wire == wire }
        }
    }

    fun key(kind: SearchKind, id: String): String = "${kind.wire}:$id"

    /** PERSON VERBS: Message, Wave, Call for a person; Message alone for an agent. */
    fun personVerbs(kind: SearchKind): List<SearchPersonVerb> = when (kind) {
        SearchKind.PERSON -> SearchPersonVerb.entries
        SearchKind.AGENT -> listOf(SearchPersonVerb.MESSAGE)
        else -> emptyList()
    }

    /** SUBJECT VERBS: all four for a project or a lead; New task alone for an event or a partner. */
    fun subjectVerbs(kind: SearchSubjectKind): List<SearchSubjectVerb> = when (kind) {
        SearchSubjectKind.PROJECT, SearchSubjectKind.LEAD -> SearchSubjectVerb.entries
        SearchSubjectKind.EVENT, SearchSubjectKind.ORGANIZATION -> listOf(SearchSubjectVerb.NEW_TASK)
    }

    /** The verbs behind a row: a subject's by the kind its door names, else a person's. As Swift `rowVerbs`. */
    fun rowVerbs(row: SearchRow): List<SearchRowVerb> {
        val door = row.door
        if (door is SearchDoor.Subject) return subjectVerbs(door.subjectKind).map { SearchRowVerb.Subject(it) }
        return personVerbs(row.kind).map { SearchRowVerb.Person(it) }
    }

    private val marks = Regex("\\p{M}+")
    private val nonWord = Regex("[^\\p{L}\\p{N}]+")

    /** NORMALIZE: case-folded and diacritic-folded. */
    fun normalize(text: String): String =
        marks.replace(Normalizer.normalize(text, Normalizer.Form.NFD), "").lowercase(Locale.ROOT)

    /** A word is a run of letters or digits. */
    private fun words(normalized: String): List<String> = normalized.split(nonWord).filter { it.isNotEmpty() }

    /** The query's words. An empty query has no tokens. */
    fun tokens(query: String): List<String> = words(normalize(query))

    /**
     * MATCH: tier 2 when a title word starts with the token, 1 when the title
     * contains it, 0 when the subtitle contains it. The row's tier is its
     * weakest token's; null when a token matches nothing. No tokens: tier 2.
     */
    fun tier(title: String, subtitle: String, tokens: List<String>): Int? {
        if (tokens.isEmpty()) return 2
        val t = normalize(title)
        val titleWords = words(t)
        val s = normalize(subtitle)
        var tier = 2
        for (token in tokens) {
            val own = when {
                titleWords.any { it.startsWith(token) } -> 2
                t.contains(token) -> 1
                s.contains(token) -> 0
                else -> return null
            }
            tier = minOf(tier, own)
        }
        return tier
    }

    /** A field that thins a list in place asks this per row: the same MATCH rule as [run]. */
    fun matches(query: String, title: String, subtitle: String): Boolean = tier(title, subtitle, tokens(query)) != null

    /**
     * The one matcher. [recents] are the keys of the last opened hits, newest
     * first, read only for [Order.RANK]. A key that names no row, and a door's
     * key, rank as not recent.
     */
    fun run(
        rows: List<SearchRow>,
        query: String,
        scope: List<SearchKind>,
        order: Order,
        recents: List<String> = emptyList(),
    ): List<SearchRow> {
        val inScope = scope.toSet()
        val tokens = tokens(query)
        data class Match(val row: SearchRow, val tier: Int, val index: Int)
        val matched = rows.withIndex().mapNotNull { (index, row) ->
            if (row.kind !in inScope) return@mapNotNull null
            tier(row.title, row.subtitle, tokens)?.let { Match(row, it, index) }
        }
        if (order == Order.LIST) return matched.map { it.row }

        val recency = mutableMapOf<String, Int>()
        recents.forEachIndexed { at, key -> recency.putIfAbsent(key, at) }
        fun recentRank(row: SearchRow): Int = if (!row.kind.isHit) Int.MAX_VALUE else recency[row.key] ?: Int.MAX_VALUE
        return matched.sortedWith(
            compareByDescending<Match> { it.tier }
                .thenBy { recentRank(it.row) }
                .thenBy { it.row.kind.ordinal }
                .thenBy { it.index },
        ).map { it.row }
    }

    /** RECENTS: push a hit's key to the front, once, capped. A door is never remembered. */
    fun remember(recents: List<String>, row: SearchRow, limit: Int = 20): List<String> {
        if (!row.kind.isHit) return recents
        val key = row.key
        return (listOf(key) + recents.filter { it != key }).take(limit)
    }

    /**
     * The door rows a client draws, from what it can open. With no Docs in
     * the workspace there is no New document. Settings rows carry
     * the subtitle [SETTINGS_SUBTITLE].
     */
    fun doorRows(
        destinations: List<SearchDestination> = SearchDestination.entries,
        settingsPages: List<SearchSettingsPage> = SearchSettingsPage.entries,
        verbs: List<SearchVerb> = SearchVerb.entries,
        hasDocs: Boolean = true,
    ): List<SearchRow> =
        destinations.map { SearchRow(SearchKind.DESTINATION, it.wire, it.title, "", SearchDoor.Destination(it)) } +
            settingsPages.map { SearchRow(SearchKind.SETTINGS, it.wire, it.title, SETTINGS_SUBTITLE, SearchDoor.Settings(it)) } +
            verbs.filter { it != SearchVerb.NEW_DOCUMENT || hasDocs }
                .map { SearchRow(SearchKind.VERB, it.wire, it.title, "", SearchDoor.Verb(it)) }

    const val SETTINGS_SUBTITLE = "Settings"
}
