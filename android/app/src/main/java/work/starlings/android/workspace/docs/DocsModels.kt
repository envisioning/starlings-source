@file:OptIn(ExperimentalSerializationApi::class)

package work.starlings.android.workspace.docs

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * DocsKit's wire models (core-kit `Sources/DocsKit/DocsModels.swift` and
 * `DocsBrowserModels.swift`), for the Docs answers `api/DocsRoutes.kt`
 * returns as [JsonElement]. Snake case on the wire, as `DocsCoding`.
 *
 * Strict at the boundary: a field Swift requires is required here, so a
 * body DocsKit refuses is refused here too. Tolerant of growth: an unknown
 * key is ignored, and a field an older Docs leaves out takes the default
 * Swift gives it (`transcript`, `by_source`, `links`, `unfiled`).
 */
object DocsJson {
    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

    /** Decodes [element] as [strategy]. Throws [DocsUndecodable] when it does not fit. */
    fun <T> decode(strategy: DeserializationStrategy<T>, element: JsonElement): T = try {
        json.decodeFromJsonElement(strategy, element)
    } catch (e: IllegalArgumentException) {
        // kotlinx's SerializationException is an IllegalArgumentException.
        throw DocsUndecodable(strategy.descriptor.serialName.substringAfterLast('.'), e)
    }

    fun summary(element: JsonElement): DocsSummary = decode(DocsSummary.serializer(), element)
    fun tree(element: JsonElement): List<DocsFolder> = decode(DocsFolderTree.serializer(), element).folders
    fun documentList(element: JsonElement): DocsDocumentList = decode(DocsDocumentList.serializer(), element)
    fun document(element: JsonElement): DocsDocumentDetail = decode(DocsDocumentDetail.serializer(), element)
    fun searchHits(element: JsonElement): List<DocsSearchHit> = decode(ListSerializer(DocsSearchHit.serializer()), element)
    fun annotations(element: JsonElement): List<DocsAnnotation> = decode(ListSerializer(DocsAnnotation.serializer()), element)
    fun annotation(element: JsonElement): DocsAnnotation = decode(DocsAnnotation.serializer(), element)
    fun savedLink(element: JsonElement): DocsDocumentDetail = decode(DocsSavedLink.serializer(), element).document
    fun categories(element: JsonElement): List<DocsCategoryList.DocsCategoryInfo> = decode(DocsCategoryList.serializer(), element).categories
}

/** `DocsClientError.invalidResponse`: a 2xx body that is not the model it should be. */
class DocsUndecodable(type: String, cause: Throwable) : Exception("Docs returned an invalid response ($type).", cause)

/** `DocsSubject`: what a document is about, a CRM subject. */
@Serializable
data class DocsSubject(
    @EncodeDefault val system: String = "core",
    val kind: String,
    @SerialName("subject_id") val subjectId: String,
) {
    /** `core:organization:<id>`: the form the API takes in a query. */
    val ref: String get() = "$system:$kind:$subjectId"
}

/** `DocsLinkSave`: what a saved page said about itself. */
@Serializable
data class DocsLinkSave(
    val url: String,
    @SerialName("canonical_url") val canonicalUrl: String,
    @SerialName("site_name") val siteName: String? = null,
    val description: String? = null,
    @SerialName("has_image") val hasImage: Boolean,
    /** Screenshots the person attached. Null from a Docs older than slice 2. */
    @SerialName("image_count") val imageCount: Int? = null,
    /** The first of them: the cover when the page gave no image. */
    @SerialName("first_image_id") val firstImageId: String? = null,
    /** `ok`, `failed` (the site did not answer; the URL is kept) or `skipped` (not a web page). */
    @SerialName("fetch_status") val fetchStatus: String,
    @SerialName("fetch_error") val fetchError: String? = null,
    @SerialName("fetched_at") val fetchedAt: String? = null,
) {
    /** The site name, or the host without `www.` when the page named none. */
    val site: String
        get() {
            if (!siteName.isNullOrEmpty()) return siteName
            val host = hostOf(canonicalUrl) ?: hostOf(url) ?: url
            return host.removePrefix("www.")
        }

    private fun hostOf(value: String): String? = runCatching { java.net.URI(value).host }.getOrNull()
}

/** `DocsDocumentSummary`: one row of a list. */
@Serializable
data class DocsDocumentSummary(
    val id: String,
    val path: String,
    val slug: String,
    val title: String,
    val kind: String,
    val visibility: String,
    val status: String,
    @SerialName("source_system") val sourceSystem: String,
    @SerialName("source_kind") val sourceKind: String? = null,
    @SerialName("source_url") val sourceUrl: String? = null,
    val editable: Boolean,
    val version: Int,
    @SerialName("byte_size") val byteSize: Int,
    @SerialName("content_hash") val contentHash: String,
    val tags: List<String>,
    /** Any category id the workspace owns. Its label comes from the summary. */
    val category: String? = null,
    val transcript: Boolean = false,
    val subjects: List<DocsSubject>,
    @SerialName("created_at") val createdAt: String,
    @SerialName("updated_at") val updatedAt: String,
    @SerialName("updated_by") val updatedBy: String? = null,
    val excerpt: String? = null,
    val link: DocsLinkSave? = null,
    @SerialName("written_at") val writtenAt: String? = null,
) {
    /** The written date, whatever Docs answered. */
    val written: String get() = writtenAt ?: createdAt
    val isLinkSave: Boolean get() = sourceKind == DocsRules.LINK_SOURCE_KIND

    companion object {
        /**
         * A search hit as a row, as `MobileDocsListView.load` builds it: no
         * category, no subjects, editable only when Docs wrote it.
         */
        fun of(hit: DocsSearchHit) = DocsDocumentSummary(
            id = hit.id, path = hit.path, slug = hit.path.substringAfterLast('/'), title = hit.title, kind = hit.kind,
            visibility = "internal", status = "active", sourceSystem = hit.sourceSystem, sourceKind = hit.sourceKind,
            sourceUrl = null, editable = hit.sourceSystem == "native", version = 1, byteSize = 0, contentHash = "",
            tags = emptyList(), category = null, subjects = emptyList(), createdAt = hit.updatedAt,
            updatedAt = hit.updatedAt, updatedBy = null, excerpt = null,
        )
    }
}

@Serializable
data class DocsDocumentLink(
    val target: String,
    @SerialName("to_id") val toId: String? = null,
    @SerialName("to_path") val toPath: String? = null,
)

@Serializable
data class DocsBacklink(val id: String, val path: String, val title: String)

/** `DocsDocumentDetail`: one document, with its body. */
@Serializable
data class DocsDocumentDetail(
    val id: String,
    val path: String,
    val slug: String,
    val title: String,
    val kind: String,
    val visibility: String,
    val status: String,
    @SerialName("source_system") val sourceSystem: String,
    @SerialName("source_kind") val sourceKind: String? = null,
    @SerialName("source_url") val sourceUrl: String? = null,
    val editable: Boolean,
    val version: Int,
    @SerialName("byte_size") val byteSize: Int,
    @SerialName("content_hash") val contentHash: String,
    val tags: List<String>,
    val category: String? = null,
    val transcript: Boolean = false,
    val subjects: List<DocsSubject>,
    @SerialName("created_at") val createdAt: String,
    @SerialName("updated_at") val updatedAt: String,
    @SerialName("updated_by") val updatedBy: String? = null,
    @SerialName("body_md") val bodyMd: String? = null,
    val links: List<DocsDocumentLink>,
    val backlinks: List<DocsBacklink>,
    @SerialName("open_annotations") val openAnnotations: Int,
    val link: DocsLinkSave? = null,
    /** Attached images, oldest first. Null from a Docs older than slice 2. */
    val images: List<DocsImage>? = null,
    @SerialName("written_at") val writtenAt: String? = null,
) {
    val isLinkSave: Boolean get() = sourceKind == DocsRules.LINK_SOURCE_KIND
}

/** `DocsImage`: one screenshot on a document ( slice 2). */
@Serializable
data class DocsImage(
    val id: String,
    @SerialName("content_type") val contentType: String,
    @SerialName("byte_size") val byteSize: Int,
    val caption: String? = null,
    @SerialName("created_by") val createdBy: String,
    @SerialName("created_at") val createdAt: String,
)

@Serializable
data class DocsDocumentList(val documents: List<DocsDocumentSummary>, val total: Int)

/** `DocsSearchHit`. `snippet` is FTS5's, with `<mark>` around the hits. */
@Serializable
data class DocsSearchHit(
    val id: String,
    val path: String,
    val title: String,
    val kind: String,
    @SerialName("source_system") val sourceSystem: String,
    @SerialName("source_kind") val sourceKind: String? = null,
    @SerialName("updated_at") val updatedAt: String,
    val snippet: String,
)

/** `DocsFolder`: one folder of the flat tree. */
@Serializable
data class DocsFolder(
    val id: String,
    val path: String,
    val slug: String,
    val title: String,
    @SerialName("parent_id") val parentId: String? = null,
    val depth: Int,
    val icon: String? = null,
    val description: String? = null,
    @SerialName("source_key") val sourceKey: String? = null,
    @SerialName("document_count") val documentCount: Int? = null,
)

@Serializable
data class DocsFolderTree(val folders: List<DocsFolder>)

/** `DocsSummary`: the rail's counts. */
@Serializable
data class DocsSummary(
    val categories: List<CategoryCount>,
    /** Absent from a Docs older than `by_source`: every category is then WORK. */
    @SerialName("by_source") val bySource: List<SourceCount> = emptyList(),
    val folders: List<FolderCount>,
    val links: Int = 0,
    val unfiled: Int = 0,
    val total: Int,
) {
    @Serializable
    data class CategoryCount(val category: String, val label: String, val count: Int)

    @Serializable
    data class SourceCount(val source: String, val category: String, val label: String, val count: Int)

    @Serializable
    data class FolderCount(val path: String, val title: String, val count: Int)
}

/** `DocsAnchor`: the passage a comment points at, by its words. */
@Serializable
data class DocsAnchor(
    val type: String,
    val quote: String? = null,
    val prefix: String? = null,
    val suffix: String? = null,
)

/** `DocsAnnotation`: one comment, a thread's root (`parentId == null`) or a reply. */
@Serializable
data class DocsAnnotation(
    val id: String,
    @SerialName("document_id") val documentId: String,
    @SerialName("document_version") val documentVersion: Int,
    @SerialName("thread_id") val threadId: String,
    @SerialName("parent_id") val parentId: String? = null,
    val author: String,
    @SerialName("author_name") val authorName: String? = null,
    /** `staff`, `guest` or `agent`. */
    @SerialName("author_kind") val authorKind: String,
    @SerialName("body_md") val bodyMd: String,
    val anchor: DocsAnchor? = null,
    /** `open` or `resolved`. */
    val status: String,
    @SerialName("resolved_by") val resolvedBy: String? = null,
    @SerialName("resolved_at") val resolvedAt: String? = null,
    @SerialName("created_at") val createdAt: String,
    @SerialName("updated_at") val updatedAt: String,
    val orphaned: Boolean? = null,
) {
    /** The name Docs recorded, or the address's local part. */
    val who: String get() = authorName?.takeIf { it.isNotEmpty() } ?: author.substringBefore('@')
}

/** `DocsCreateAnnotation`: nulls are left off the wire. */
@Serializable
data class DocsCreateAnnotation(
    @SerialName("body_md") val bodyMd: String,
    @SerialName("parent_id") val parentId: String? = null,
)

/** `DocsUpdateAnnotation` with only a status: resolve or reopen. */
@Serializable
data class DocsAnnotationStatus(val status: String)

/** `DocsDocumentDetail.summary`: the row a list inserts for a document it just made or saved. */
fun DocsDocumentDetail.summary(): DocsDocumentSummary = DocsDocumentSummary(
    id = id, path = path, slug = slug, title = title, kind = kind, visibility = visibility, status = status,
    sourceSystem = sourceSystem, sourceKind = sourceKind, sourceUrl = sourceUrl, editable = editable, version = version,
    byteSize = byteSize, contentHash = contentHash, tags = tags, category = category, transcript = transcript,
    subjects = subjects, createdAt = createdAt, updatedAt = updatedAt, updatedBy = updatedBy, excerpt = null,
    link = link, writtenAt = writtenAt,
)

/** The link save's answer, `{document}` (`StarlingsAPI.saveDocsLink`). */
@Serializable
data class DocsSavedLink(val document: DocsDocumentDetail)

/** `DocsCategoryList`: `GET /api/categories`, in rail order. */
@Serializable
data class DocsCategoryList(val categories: List<DocsCategoryInfo>) {
    @Serializable
    data class DocsCategoryInfo(val id: String, val label: String, val position: Int, val count: Int)
}

/**
 * `DocsCreateDocument`: `POST /api/docs`. `body_md`, `subjects` and `tags`
 * always go, as Swift's synthesized encoder sends them; a null is left off.
 */
@Serializable
data class DocsCreateDocument(
    val title: String,
    @SerialName("folder_path") val folderPath: String? = null,
    @SerialName("body_md") @EncodeDefault val bodyMd: String = "",
    val category: String? = null,
    @EncodeDefault val subjects: List<DocsSubject> = emptyList(),
    @EncodeDefault val tags: List<String> = emptyList(),
    val message: String? = null,
)

/** `DocsMoveDocument`: `POST /api/docs/:id/move` into a folder. */
@Serializable
data class DocsMoveDocument(@SerialName("folder_path") val folderPath: String)

/** `PUT /api/docs/:id/subjects`. */
@Serializable
data class DocsSetSubjects(val subjects: List<DocsSubject>)

/**
 * `DocsUpdateDocument`: `PATCH /api/docs/:id`. A null field is left off;
 * [category] is three ways, as Swift's `DocsCategory??`: [CategoryChange.Keep]
 * sends nothing, [CategoryChange.Clear] sends `null`, [CategoryChange.Set] the id.
 */
data class DocsUpdateDocument(
    val title: String? = null,
    val bodyMd: String? = null,
    val status: String? = null,
    val category: CategoryChange = CategoryChange.Keep,
    val ifContentHash: String? = null,
) {
    sealed interface CategoryChange {
        data object Keep : CategoryChange
        data object Clear : CategoryChange
        data class Set(val category: String) : CategoryChange

        companion object {
            fun to(category: String?): CategoryChange = category?.let(::Set) ?: Clear
        }
    }

    /** The JSON body, in DocsKit's key order. */
    fun encode(): String = buildJsonObject {
        title?.let { put("title", JsonPrimitive(it)) }
        bodyMd?.let { put("body_md", JsonPrimitive(it)) }
        status?.let { put("status", JsonPrimitive(it)) }
        when (val change = category) {
            CategoryChange.Keep -> Unit
            CategoryChange.Clear -> put("category", JsonNull)
            is CategoryChange.Set -> put("category", JsonPrimitive(change.category))
        }
        ifContentHash?.let { put("if_content_hash", JsonPrimitive(it)) }
    }.toString()
}
