package work.starlings.android.workspace.docs

import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The two halves of every Docs rail: `DocsRailHalf` (DocsKit) and
 * `DOCS_RAIL_HALF_SOURCES` (packages/contracts/src/docs-values.ts). WORK is
 * what Starlings wrote (`native`), LIBRARY every mirror.
 */
enum class DocsRailHalf(val sources: List<String>) {
    WORK(listOf("native")),
    LIBRARY(listOf("core", "obsidian"));

    companion object {
        fun of(source: String): DocsRailHalf = if (source == "native") WORK else LIBRARY
    }
}

/**
 * The Docs rail's blocks that Android draws, in the shared table's order
 * (`RAIL_BLOCKS.docs` in packages/contracts/src/rail-blocks.ts,
 * `fixtures/rail-blocks.json`). `explore` holds the graph (`DocsGraph.kt`).
 * A table id this enum lacks is left out, as `MobileRail.blocks` does.
 */
enum class DocsBlock(val id: String) {
    EXPLORE("explore"), WORK("work"), PROJECTS("projects"), LEADS("leads"), PARTNERS("partners"), FOLDERS("folders"), LIBRARY("library");
}

/** One row of the shared rail table. */
data class RailBlock(val id: String, val key: String, val hidesWhenEmpty: Boolean)

/** A document subject with how many documents are about it: `DocsSubjectGroup`. */
data class DocsSubjectGroup(val subject: CrmSubjectWire, val count: Int, val docsKind: String)

/** One thread: the root and its replies in the order written (`DocsThread`). */
data class DocsThread(val root: DocsAnnotation, val replies: List<DocsAnnotation>) {
    val id: String get() = root.threadId
    val isOpen: Boolean get() = root.status == "open"
}

/**
 * `DocsSnapshotKey` (DocsKit `DocsSnapshots.swift`): where Docs reads are
 * kept, the names the web keeps (`DOCS_SNAPSHOT` in web/src/docs.ts). Every
 * key sits under [PREFIX], so one invalidation after a write takes them all.
 */
object DocsSnapshotKey {
    const val PREFIX = "docs"
    const val SUMMARY = "docs/summary"
    const val CATEGORIES = "docs/categories"
    const val WRITTEN = "docs/written"
    const val DOCUMENTS = "docs/documents"
}

/**
 * One list read of `/api/docs` (`DocsListRead` in DocsKit's
 * `DocsSnapshots.swift`): the filter it sends, before `limit`.
 */
sealed interface DocsListRead {
    val filter: List<Pair<String, String>>
    val limit: Int

    /**
     * `DocsListRead.snapshotKey`: `docs/documents?<query>`, one key per
     * exact list; the rail's written list keeps `docs/written`, the name
     * the web shares.
     */
    val snapshotKey: String
        get() {
            if (this is Written && limit == 200) return DocsSnapshotKey.WRITTEN
            val pairs = (filter + ("limit" to limit.toString())).joinToString("&") { "${it.first}=${it.second}" }
            return "${DocsSnapshotKey.DOCUMENTS}?$pairs"
        }

    data class Recent(override val limit: Int = 30) : DocsListRead {
        override val filter get() = emptyList<Pair<String, String>>()
    }
    data class Written(override val limit: Int = 200) : DocsListRead {
        override val filter get() = listOf("source" to "native")
    }
    data class About(val subject: DocsSubject, override val limit: Int = 100) : DocsListRead {
        override val filter get() = listOf("subject" to subject.ref)
    }
    data class UnderPrefix(val path: String, override val limit: Int = 200) : DocsListRead {
        override val filter get() = listOf("prefix" to path)
    }
    data class CategoryOnHalf(val category: String, val half: DocsRailHalf, override val limit: Int = 200) : DocsListRead {
        override val filter get() = listOf("category" to category, "source" to half.sources.joinToString(","))
    }
    data class Links(override val limit: Int = 200) : DocsListRead {
        override val filter get() = listOf("source" to "native", "source_kind" to DocsRules.LINK_SOURCE_KIND)
    }
    data class Unfiled(override val limit: Int = 200) : DocsListRead {
        override val filter get() = listOf("unfiled" to "1")
    }
}

/**
 * What a rail row or the search field opens: `MobileDocsSelection`
 * (iOS/MobileDocsView.swift), without the graph, which Android does not
 * draw yet.
 */
sealed interface DocsSelection {
    data object Recent : DocsSelection
    data object Links : DocsSelection
    /** Documents nobody filed. */
    data object Unfiled : DocsSelection
    /** One category on one half of the rail. */
    data class Category(val category: String, val half: DocsRailHalf) : DocsSelection
    /** Every document about one project, lead or organization: its Docs kind, id and title. */
    data class Subject(val kind: String, val id: String, val title: String) : DocsSelection
    data class Folder(val path: String, val title: String) : DocsSelection
    data class Search(val query: String) : DocsSelection

    /** The list read behind the row, or null for a search, which reads `/api/search`. */
    val read: DocsListRead?
        get() = when (this) {
            Recent -> DocsListRead.Recent(limit = 200)
            Links -> DocsListRead.Links()
            Unfiled -> DocsListRead.Unfiled()
            is Category -> DocsListRead.CategoryOnHalf(category, half)
            is Subject -> DocsListRead.About(DocsSubject(kind = kind, subjectId = id))
            is Folder -> DocsListRead.UnderPrefix(path)
            is Search -> null
        }
}

/**
 * The Docs rules the phone screens read, ported from DocsKit
 * (`DocsSummary.categories(on:)`, `DocsThread.threads`, `DocsCategory`),
 * `Sources/DocsRailGroups.swift` and DocsUI's date lines.
 */
object DocsRules {
    /** `DocsLinks.sourceKind`: the source kind that marks a link save. */
    const val LINK_SOURCE_KIND = "link"

    /** `DocsLinkSave.fetchStatus` when the site did not answer; the URL is kept. */
    const val LINK_FETCH_FAILED = "failed"

    /** `DocsClient.productionURL`, where a document's public link points. */
    const val DOCS_ORIGIN = work.starlings.android.Deployment.DOCS_ORIGIN

    /** `DOCS_RAIL_FOLDERS_LEFT_OUT` (fixtures/shared-constants.json): WORK and LIBRARY reach these. */
    val railFoldersLeftOut = listOf("/work", "/published")

    /** `RAIL_BLOCKS.docs`, as `fixtures/rail-blocks.json` pins it. */
    val railTable = listOf(
        RailBlock("explore", "docs.explore", hidesWhenEmpty = false),
        RailBlock("work", "docs.work", hidesWhenEmpty = false),
        RailBlock("projects", "docs.projects", hidesWhenEmpty = true),
        RailBlock("leads", "docs.leads", hidesWhenEmpty = true),
        RailBlock("partners", "docs.partners", hidesWhenEmpty = true),
        RailBlock("folders", "docs.folders", hidesWhenEmpty = true),
        RailBlock("library", "docs.library", hidesWhenEmpty = false),
    )

    /** `MobileRail.blocks`: the blocks to draw, top to bottom; a block that hides while empty goes when [empty] holds it. */
    fun blocks(empty: Set<DocsBlock>, table: List<RailBlock> = railTable): List<Pair<DocsBlock, RailBlock>> =
        table.mapNotNull { block ->
            val kind = DocsBlock.entries.firstOrNull { it.id == block.id } ?: return@mapNotNull null
            if (block.hidesWhenEmpty && kind in empty) null else kind to block
        }

    /** `DocsClient.publicLink(path:)`: the production reader at the document's path. */
    fun publicLink(path: String): String = "$DOCS_ORIGIN/doc$path"

    /** `DocsCategory.fallbackLabel`: `case-study` reads `Case study`. Only for a category no list names. */
    fun fallbackLabel(category: String): String {
        val words = category.replace('-', ' ')
        return words.take(1).uppercase() + words.drop(1)
    }

    /** `DocsSummary.label(for:)`. */
    fun label(summary: DocsSummary?, category: String): String =
        summary?.categories?.firstOrNull { it.category == category }?.label ?: fallbackLabel(category)

    /**
     * `DocsSummary.categories(on:includeEmpty:)`: one row per category on a
     * half, counts summed across its sources, in rail order. With no
     * `by_source` every category is WORK and LIBRARY is empty.
     */
    fun categories(summary: DocsSummary, half: DocsRailHalf, includeEmpty: Boolean = false): List<DocsSummary.CategoryCount> {
        if (summary.bySource.isEmpty()) {
            if (half != DocsRailHalf.WORK) return emptyList()
            return if (includeEmpty) summary.categories else summary.categories.filter { it.count > 0 }
        }
        val totals = linkedMapOf<String, Int>()
        val labels = mutableMapOf<String, String>()
        for (row in summary.bySource) {
            if (DocsRailHalf.of(row.source) != half) continue
            totals[row.category] = (totals[row.category] ?: 0) + row.count
            labels[row.category] = row.label
        }
        val rows = summary.categories.mapNotNull { entry ->
            val count = totals[entry.category] ?: 0
            if (count > 0 || includeEmpty) DocsSummary.CategoryCount(entry.category, entry.label, count) else null
        }.toMutableList()
        // A by_source row whose category the list lacks still shows, last.
        val listed = summary.categories.map { it.category }.toSet()
        for (row in summary.bySource) {
            if (DocsRailHalf.of(row.source) != half || row.category in listed) continue
            if (rows.any { it.category == row.category }) continue
            val count = totals[row.category] ?: continue
            rows += DocsSummary.CategoryCount(row.category, labels[row.category] ?: row.label, count)
        }
        return rows
    }

    /** `DocsRailGroups.moveTargets`: every folder but the mirrored shelves. */
    fun moveTargets(tree: List<DocsFolder>): List<DocsFolder> =
        tree.filter { !it.path.startsWith("/published") && it.sourceKey == null }

    /**
     * `DocsRailGroups.folders`: one row per top-level folder the summary
     * counts, but `/work` and `/published`; an empty one only when it can
     * take a move.
     */
    fun folders(summary: List<DocsSummary.FolderCount>, tree: List<DocsFolder>): List<DocsSummary.FolderCount> {
        val targets = moveTargets(tree).map { it.path }.toSet()
        return summary.filter { it.path !in railFoldersLeftOut && (it.count > 0 || it.path in targets) }
    }

    /**
     * `DocsRailGroups.groups` and `MobileDocsView.partnerGroups`: the subjects
     * something is filed about, most documents first, then by title. A
     * partner is filed on its organization. A subject the CRM did not name
     * is left out rather than drawn by its id.
     */
    fun groups(written: List<DocsDocumentSummary>, subjects: List<CrmSubjectWire>, kind: CrmSubjectKind): List<DocsSubjectGroup> {
        val docsKind = kind.value
        val counts = linkedMapOf<String, Int>()
        for (document in written) {
            for (subject in document.subjects) {
                if (subject.kind == docsKind) counts[subject.subjectId] = (counts[subject.subjectId] ?: 0) + 1
            }
        }
        val byId = subjects.groupBy { it.id }.mapValues { it.value.first() }
        return counts.mapNotNull { (id, count) -> byId[id]?.let { DocsSubjectGroup(it, count, docsKind) } }
            .sortedWith(compareByDescending<DocsSubjectGroup> { it.count }.thenBy { it.subject.title.lowercase() })
    }

    /** `DocsThread.threads`: threads from a flat list, newest root first; replies oldest first. */
    fun threads(annotations: List<DocsAnnotation>): List<DocsThread> =
        annotations.groupBy { it.threadId }.values.mapNotNull { list ->
            val sorted = list.sortedBy { it.createdAt }
            val root = sorted.firstOrNull { it.parentId == null } ?: sorted.firstOrNull() ?: return@mapNotNull null
            DocsThread(root, sorted.filter { it.id != root.id })
        }.sortedByDescending { it.root.createdAt }

    /** A Docs timestamp: ISO 8601 with or without fractions or offset; SQLite's space form as UTC. */
    fun instant(value: String): Instant? {
        val text = value.trim()
        if (text.isEmpty()) return null
        runCatching { return Instant.parse(text) }
        runCatching { return OffsetDateTime.parse(text).toInstant() }
        runCatching { return LocalDateTime.parse(text.replace(' ', 'T')).toInstant(ZoneOffset.UTC) }
        return null
    }

    /**
     * `DocumentEditor.updatedLabel`: `14:02` today (24-hour), `12 Sep` this
     * year, `12 Sep 2025` otherwise. Null when the timestamp does not parse.
     */
    fun updatedLabel(iso: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String? {
        val at = instant(iso)?.atZone(zone) ?: return null
        val today = now.atZone(zone).toLocalDate()
        val pattern = when {
            at.toLocalDate() == today -> "HH:mm"
            at.year == today.year -> "d MMM"
            else -> "d MMM yyyy"
        }
        return DateTimeFormatter.ofPattern(pattern, locale).format(at)
    }

    /** The day of [iso] in the reader's zone, for "written" and "edited" lines. */
    fun day(iso: String, zone: ZoneId = ZoneId.systemDefault()): LocalDate? = instant(iso)?.atZone(zone)?.toLocalDate()

    /**
     * The facts of a row's subtitle (`DocumentRow.subtitle`): the written
     * day, the edit when that was another day, the version past 1 and who
     * edited it last (not `core`). The screen words and joins them.
     */
    data class RowFacts(val written: LocalDate?, val edited: Instant?, val version: Int?, val who: String?)

    fun rowFacts(document: DocsDocumentSummary, zone: ZoneId = ZoneId.systemDefault()): RowFacts {
        val written = day(document.written, zone)
        val updated = instant(document.updatedAt)
        val edited = updated?.takeIf { written == null || it.atZone(zone).toLocalDate() != written }
        val who = document.updatedBy?.substringBefore('@')?.takeIf { it.isNotEmpty() && it != "core" }
        return RowFacts(written, edited, document.version.takeIf { it > 1 }, who)
    }
}
