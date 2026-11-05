package work.starlings.android.workspace.home

import android.content.Context
import androidx.compose.runtime.mutableIntStateOf
import kotlinx.serialization.builtins.ListSerializer
import work.starlings.android.HomeLayout
import work.starlings.android.R
import work.starlings.android.Search
import work.starlings.android.SearchDoor
import work.starlings.android.SearchKind
import work.starlings.android.SearchRow
import work.starlings.android.SearchSubjectKind
import work.starlings.android.workspace.team.displayTitle
import work.starlings.android.workspace.team.isSubjectChannel
import work.starlings.contracts.PeerKindValue
import work.starlings.contracts.SearchRowWire
import work.starlings.contracts.SearchRowWireKind
import work.starlings.contracts.ThreadKind
import work.starlings.contracts.ThreadSummaryWire
import work.starlings.contracts.WireJson

/**
 * `SearchRecents` (Sources/Search.swift): the things last opened on this
 * device, as rows, so a recent draws before any store answers. Per device,
 * per workspace and per owner: the key carries the owner's address and the
 * workspace origin, `meet.search.recentRows.<owner>@<origin>`, so a second
 * account never sees the first's. Rows are kept as the wire's search row
 * (plain JSON), newest first, at most 20; Home shows the first eight.
 */
object HomeRecents {
    private const val PREFS = "search_recents"
    private const val KEY_PREFIX = "meet.search.recentRows."

    /** Bumped on every write, so Quick Access redraws without polling. */
    val changes = mutableIntStateOf(0)

    private fun key(owner: String) = "$KEY_PREFIX$owner@${work.starlings.android.Workspaces.active.webOrigin.trimEnd('/')}"

    private val codec = ListSerializer(SearchRowWire.serializer())

    fun load(context: Context, owner: String): List<SearchRow> {
        if (owner.isEmpty()) return emptyList()
        val text = runCatching {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(key(owner), null)
        }.getOrNull() ?: return emptyList()
        return decode(text)
    }

    /** `homeRows`: the stored list, capped. Doors never land here (`Search.remember` refuses them). */
    fun homeRows(context: Context, owner: String): List<SearchRow> = load(context, owner).take(HomeLayout.MAX_RECENT_ROWS)

    /** `SearchRecents.remember`: to the front, once; a row written again keeps a mark the newer write lacks. */
    fun remember(context: Context, owner: String, row: SearchRow) {
        if (owner.isEmpty()) return
        val next = merge(load(context, owner), row)
        runCatching {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(key(owner), encode(next)).apply()
        }
        changes.intValue++
    }

    /**
     * `SearchRecents.replace`: a merged id leaves the list, and the survivor,
     * when there is one, goes to the front. A contact merge passes no survivor,
     * as iOS.
     */
    fun replace(context: Context, owner: String, mergedId: String, survivor: SearchRow? = null) {
        if (owner.isEmpty()) return
        val current = load(context, owner)
        val kept = replaced(current, mergedId)
        if (kept.size != current.size) {
            runCatching {
                context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(key(owner), encode(kept)).apply()
            }
            changes.intValue++
        }
        if (survivor != null) remember(context, owner, survivor)
    }

    /** The pure half of [replace]: every row with the merged id goes, whatever its kind. */
    fun replaced(current: List<SearchRow>, mergedId: String): List<SearchRow> = current.filter { it.id != mergedId }

    /** The pure half of [remember]. */
    fun merge(current: List<SearchRow>, row: SearchRow): List<SearchRow> {
        val keys = Search.remember(current.map { it.key }, row)
        val byKey = current.associateBy { it.key }.toMutableMap()
        val kept = byKey[row.key]?.image
        byKey[row.key] = if (row.image == null && kept != null) row.copy(image = kept) else row
        return keys.mapNotNull { byKey[it] }
    }

    fun encode(rows: List<SearchRow>): String =
        WireJson.encodeToString(codec, rows.map { SearchRowWire(SearchRowWireKind(it.kind.wire), it.id, it.title, it.subtitle, it.doorString, it.image) })

    /** A row this build cannot read is dropped, never the whole list. */
    fun decode(text: String): List<SearchRow> =
        runCatching { WireJson.decodeFromString(codec, text) }.getOrDefault(emptyList())
            .mapNotNull { SearchRow.fromWire(it.kind.value, it.id, it.title, it.subtitle, it.door, it.image) }
}

/**
 * `Sources/SearchRecentRows.swift`: the row a tab writes into [HomeRecents]
 * when a thing is opened by hand (a subject from Work, a conversation from
 * Team, a document from Docs). Each has the Worker's title and subtitle
 * (`subjectRow`, `threadRecentRow`, `documentRow` in search.ts), so a row
 * opened from a list and the same row from Search are one entry.
 */
object RecentRows {
    /** The thread subtitles this client names in its own language. */
    data class ThreadLabels(val agent: String, val group: String, val direct: String, val teamRoom: String, val channel: String, val conversation: String)

    /** Null for a kind the door grammar has no word for. The kind word stays English, as the Worker writes it. */
    fun subject(kind: String, id: String, title: String, subtitle: String? = null, logo: String? = null): SearchRow? {
        val door = SearchSubjectKind.read(kind) ?: return null
        val word = kind.replaceFirstChar { it.uppercase() }
        return SearchRow(
            SearchKind.SUBJECT, id, title, subtitle?.let { "$word · $it" } ?: word,
            SearchDoor.Subject(door, id), logo?.trim()?.takeIf { it.isNotEmpty() },
        )
    }

    /**
     * A one-to-one is that peer's row (one face, one entry); a subject's
     * channel is that subject's row; a group or Everyone is a thread.
     */
    fun thread(thread: ThreadSummaryWire, labels: ThreadLabels): SearchRow {
        // `ThreadSummary.title`: its own, the roster for a group, the person, else "Conversation".
        val title = thread.displayTitle ?: labels.conversation
        if (thread.kind.isSubjectChannel) {
            thread.parentId?.let { parent -> subject(thread.kind.value, parent, title)?.let { return it } }
        }
        if (thread.kind == ThreadKind.DM) {
            val peers = thread.peers.orEmpty()
            val peerEmail = thread.peerEmail
            val only: Triple<String, String?, Boolean>? = when {
                peers.size == 1 -> peers.first().let { Triple(it.email, it.name, it.kind == PeerKindValue.AGENT) }
                peers.isEmpty() && peerEmail != null -> Triple(peerEmail, thread.peerName, false)
                else -> null
            }
            if (only != null) {
                val (email, rawName, agent) = only
                val name = rawName?.trim().orEmpty()
                val kind = if (agent) SearchKind.AGENT else SearchKind.PERSON
                return SearchRow(kind, email, name.ifEmpty { email }, if (agent) labels.agent else email, SearchDoor.Thing(kind, email))
            }
        }
        val subtitle = when (thread.kind) {
            ThreadKind.DM -> if (thread.peers.orEmpty().size > 1) labels.group else labels.direct
            ThreadKind.TEAM -> labels.teamRoom
            else -> labels.channel
        }
        return SearchRow(SearchKind.THREAD, thread.id, title, subtitle, SearchDoor.Thing(SearchKind.THREAD, thread.id))
    }

    /** A document opened by id and title alone, before its summary is read. */
    fun document(id: String, title: String, subtitle: String = "Document"): SearchRow =
        SearchRow(SearchKind.DOCUMENT, id, title, subtitle, SearchDoor.Thing(SearchKind.DOCUMENT, id))

    fun threadLabels(context: Context) = ThreadLabels(
        agent = context.getString(R.string.home_kind_agent),
        group = context.getString(R.string.home_recent_group),
        direct = context.getString(R.string.home_recent_direct),
        teamRoom = context.getString(R.string.home_recent_team_room),
        channel = context.getString(R.string.home_recent_channel),
        conversation = context.getString(R.string.home_kind_thread),
    )
}
