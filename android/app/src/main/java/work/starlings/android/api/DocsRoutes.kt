package work.starlings.android.api

import kotlinx.serialization.json.JsonElement
import work.starlings.contracts.DocsAnnotationUpdate
import work.starlings.contracts.DocsAnnotationUpdateStatus
import work.starlings.contracts.DocsCreateDocumentRequest

/**
 * Docs for the phone. The reads are DocsKit's (core-kit
 * `Sources/DocsKit/DocsClient.swift`) against the Worker's copy of Docs'
 * paths, `/api/docs-service` + Docs' own `/api/…`, on the owner session
 * (`Sources/DocsAccess.swift`). Their answers are DocsKit's models,
 * which `wire.json` does not carry, so they come back as [JsonElement]. The
 * link save and the comment resolve are `Sources/StarlingsDocsRoutes.swift`.
 */
object DocsRoutes {
    /** `DOCS_SERVICE_PREFIX` in packages/contracts/src/docs-service.ts, then Docs' own `/api`. */
    private val service = listOf("docs-service", "api")

    /** `DocsClient.search`: an empty query asks nothing, so a caller sends none. */
    fun search(text: String, limit: Int = 30): Route<JsonElement> = Route(
        "GET", service + "search", query = listOf("q" to text.trim(), "limit" to limit.toString()),
        answer = Answer.Json, operation = "Couldn’t search Docs",
    )

    /**
     * One page of `GET /api/docs`. [filter] is a `DocsListRead`'s query:
     * `subject`, `folder`, `prefix`, `category` or `source`, then `limit`.
     */
    fun documents(filter: List<Pair<String, String>> = emptyList(), limit: Int = 30, offset: Int? = null): Route<JsonElement> = Route(
        "GET", service + "docs",
        query = filter + ("limit" to limit.toString()) + listOfNotNull(offset?.let { "offset" to it.toString() }),
        answer = Answer.Json, operation = "Couldn’t load documents",
    )

    fun document(id: String): Route<JsonElement> = Route(
        "GET", service + listOf("docs", id), answer = Answer.Json, operation = "Couldn’t open that document",
    )

    /** The sidebar's counts. */
    val summary = Route("GET", service + listOf("docs", "summary"), answer = Answer.Json, operation = "Couldn’t load Docs")

    /** Every folder, flat, ordered by path. */
    val tree = Route("GET", service + "tree", answer = Answer.Json, operation = "Couldn’t load your folders")

    val categories = Route("GET", service + "categories", answer = Answer.Json, operation = "Couldn’t load categories")

    /**
     * A link save: the Worker reads the page and files it. 30 s, 90 s with
     * the page's HTML. Answers `{document}` in Docs' own shape, which iOS
     * reads (`StarlingsAPI.saveDocsLink`), so the answer is [JsonElement].
     */
    fun saveLink(create: DocsCreateDocumentRequest): Route<JsonElement> = Route(
        "POST", listOf("docs", "documents"), body = json(DocsCreateDocumentRequest.serializer(), create),
        answer = Answer.Json, operation = "Couldn’t save that link",
        timeoutSeconds = if (create.pageHtml == null) 30.0 else 90.0,
    )

    /** Close a comment thread on a document. The thread leaves INBOX with it. */
    fun resolveComment(threadId: String): Route<Unit> = Route(
        "PATCH", listOf("docs", "annotations", threadId),
        body = json(DocsAnnotationUpdate.serializer(), DocsAnnotationUpdate(status = DocsAnnotationUpdateStatus.RESOLVED)),
        answer = Answer.None, operation = "Couldn’t resolve that comment",
        writes = listOf(SnapshotWrite.COMMENT_RESOLVE),
    )
}
