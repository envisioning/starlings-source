package work.starlings.android.workspace.docs

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire

/** One subject a document can be filed about, with the name the CRM gives it. */
data class DocsSubjectHit(val subject: DocsSubject, val name: String)

/**
 * What the directory asks Core once Core is linked on this device
 * (DocsUI `CoreSubjectDirectory`): a record's primary-field name, and
 * Core's own search across every entity.
 */
interface DocsCoreSource {
    suspend fun name(entity: String, id: String): String?
    suspend fun search(query: String, limit: Int): List<work.starlings.android.core.CoreSearchResult>
}

/**
 * The rules of DocsUI's `SubjectEditor` and `SubjectDirectory`. Once Core
 * is linked on the phone the directory is Core's registry
 * (`CoreSubjectDirectory`): organizations, contacts, offers, leads and
 * projects. Without the link, as iOS has no directory then, Android keeps
 * the Worker's CRM subjects (projects, leads and organizations, Core's
 * `workEntities`) so the chips still change.
 */
object DocsSubjects {
    /** `CoreSubjectDirectory.entityByKind`: the registry pluralises, Docs does not. */
    val coreEntityByKind: Map<String, String> = mapOf(
        "organization" to "organizations", "contact" to "contacts", "offer" to "offers", "lead" to "leads", "project" to "projects",
    )
    val coreKindByEntity: Map<String, String> = coreEntityByKind.entries.associate { (kind, entity) -> entity to kind }

    /** `CoreSubjectDirectory.search`: Core's hits that are one of the five subject kinds, in Core's order. */
    fun coreHits(results: List<work.starlings.android.core.CoreSearchResult>): List<DocsSubjectHit> =
        results.mapNotNull { hit -> coreKindByEntity[hit.entity]?.let { kind -> DocsSubjectHit(DocsSubject(kind = kind, subjectId = hit.id), hit.name) } }

    /** `search()`: a query under two characters asks nothing. */
    const val MIN_QUERY = 2

    /** The picker's quiet time before it asks (`Task.sleep(for: .milliseconds(200))`). */
    const val DEBOUNCE_MS = 200L

    /** `repository.search(query, limit: 12)`. */
    const val LIMIT = 12

    /** The CRM kinds the directory reads, in the order a tie falls. */
    val kinds: List<CrmSubjectKind> = listOf(CrmSubjectKind.ORGANIZATION, CrmSubjectKind.PROJECT, CrmSubjectKind.LEAD)

    /** The Docs subject for a CRM row: `system: core`, the Work kind, the id. */
    fun subject(row: CrmSubjectWire): DocsSubject = DocsSubject(kind = row.kind.value, subjectId = row.id)

    /** The CRM kind a Docs subject names, or null for one the Worker does not answer (contact, offer). */
    fun crmKind(subject: DocsSubject): CrmSubjectKind? = kinds.firstOrNull { it.value == subject.kind }

    /** The query as sent, or null when it is too short to ask. */
    fun query(text: String): String? = text.trim().takeIf { it.length >= MIN_QUERY }

    /**
     * The hits for [query] over every kind's rows: one per subject, names
     * that start with the query first, then the rest, each by name, at most
     * [LIMIT].
     */
    fun rank(rows: List<CrmSubjectWire>, query: String): List<DocsSubjectHit> {
        val q = query.trim().lowercase()
        val order = kinds.map { it.value }
        return rows
            .distinctBy { subject(it).ref }
            .sortedWith(
                compareBy<CrmSubjectWire> { if (it.title.lowercase().startsWith(q)) 0 else 1 }
                    .thenBy { it.title.lowercase() }
                    .thenBy { order.indexOf(it.kind.value) },
            )
            .take(LIMIT)
            .map { DocsSubjectHit(subject(it), it.title) }
    }

    /** `add`: the list with [subject] at the end, once. */
    fun adding(subjects: List<DocsSubject>, subject: DocsSubject): List<DocsSubject> =
        if (subjects.any { it.ref == subject.ref }) subjects else subjects + subject

    /** `remove`: the list without [subject]. */
    fun removing(subjects: List<DocsSubject>, subject: DocsSubject): List<DocsSubject> = subjects.filterNot { it.ref == subject.ref }

    /** A chip's words: the CRM's name, else the kind, capitalised, as `SubjectChips` without a name. */
    fun label(subject: DocsSubject, names: Map<String, String>): String =
        names[subject.ref] ?: subject.kind.replaceFirstChar(Char::uppercaseChar)
}

/**
 * `SubjectDirectory`: names for the subjects a document already has, and
 * search for ones to add. With [core] (Core linked on this device) it is
 * `CoreSubjectDirectory`, contacts and offers too; a Core failure names
 * nothing and finds nothing, as iOS's `try?`. Without it, the Worker's CRM:
 * each kind's list read once per directory, the last known first.
 */
class DocsSubjectDirectory(private val data: DocsData, core: DocsCoreSource? = null) {
    private val loaded = mutableMapOf<CrmSubjectKind, List<CrmSubjectWire>>()
    private val core = core?.let(::CoreSubjectDirectory)

    /** `name(for:)`: null for a subject the CRM does not name. */
    suspend fun name(subject: DocsSubject): String? {
        core?.let { return it.name(subject) }
        val kind = DocsSubjects.crmKind(subject) ?: return null
        val rows = loaded[kind] ?: (data.cachedSubjects(kind) ?: data.subjects(kind)).also { loaded[kind] = it }
        return rows.firstOrNull { it.id == subject.subjectId }?.title
    }

    /** `search(_:)`: Core's search; or every Worker kind asked with the query, ranked. */
    suspend fun search(query: String): List<DocsSubjectHit> {
        core?.let { return it.search(query) }
        val q = DocsSubjects.query(query) ?: return emptyList()
        val rows = coroutineScope {
            DocsSubjects.kinds.map { kind -> async { data.searchSubjects(kind, q) } }.awaitAll().flatten()
        }
        return DocsSubjects.rank(rows, q)
    }
}

/**
 * DocsUI `CoreSubjectDirectory` over [source]: a name by the entity's
 * primary field, search across the five subject kinds, 12 at most. A Core
 * failure names nothing and finds nothing, as iOS's `try?`.
 */
class CoreSubjectDirectory(private val source: DocsCoreSource) {
    suspend fun name(subject: DocsSubject): String? {
        val entity = DocsSubjects.coreEntityByKind[subject.kind] ?: return null
        return quietly { source.name(entity, subject.subjectId) }
    }

    suspend fun search(query: String): List<DocsSubjectHit> {
        val q = DocsSubjects.query(query) ?: return emptyList()
        return quietly { DocsSubjects.coreHits(source.search(q, DocsSubjects.LIMIT)) }.orEmpty()
    }

    private suspend fun <T> quietly(read: suspend () -> T): T? = try {
        read()
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }
}

/** [DocsCoreSource] over this device's Core: the record's primary field, and Core's search. */
class CoreDocsSource(private val core: work.starlings.android.core.CoreAccess) : DocsCoreSource {
    override suspend fun name(entity: String, id: String): String? {
        val contract = core.contract(entity) ?: return null
        val value = core.record(entity, id)[contract.primaryField] as? kotlinx.serialization.json.JsonPrimitive ?: return null
        return value.takeIf { it.isString }?.content
    }

    override suspend fun search(query: String, limit: Int): List<work.starlings.android.core.CoreSearchResult> = core.search(query, limit)
}
