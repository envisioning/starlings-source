package work.starlings.android.workspace.docs

import kotlinx.serialization.json.JsonElement
import work.starlings.android.api.DocsExtraRoutes
import work.starlings.android.api.DocsImageRoutes
import work.starlings.android.api.DocsRoutes
import work.starlings.android.api.DocsShareRoutes
import work.starlings.android.api.SnapshotCache
import work.starlings.android.api.StarlingsApiError
import work.starlings.android.api.StarlingsClient
import work.starlings.android.api.WorkRoutes
import work.starlings.android.workspace.team.TeamMedia
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import work.starlings.contracts.DocsCreateDocumentRequest
import work.starlings.contracts.DocsCreateDocumentRequestSubjectsItem
import work.starlings.contracts.DocsCreateDocumentRequestSubjectsItemKind

/**
 * The Docs reads and writes the tab makes, decoded (DocsKit's `DocsClient`
 * on the signed-in client). Every call throws [StarlingsApiError] or
 * [DocsUndecodable].
 *
 * Last known first (docs/CACHING.md): the summary, the categories and every
 * list read are kept in [snapshots] under [DocsSnapshotKey], as DocsKit keeps
 * them in Meet's `SnapshotStore`, so a screen paints from `cached…` before
 * Docs answers. Saved after the decode: a body this build cannot read is no
 * head start. A write marks every Docs key stale.
 *
 * [media] carries the byte routes (a link save's cover and screenshots);
 * without it no picture loads and none can be attached.
 */
class DocsData(
    private val client: StarlingsClient,
    private val snapshots: SnapshotCache? = null,
    private val media: TeamMedia? = null,
    private val owner: () -> String? = { null },
) {
    /** `DocsClient.linkImage`: the page's image Docs keeps. Null when there is none or it does not load. */
    suspend fun linkImage(documentId: String): ByteArray? = media?.bytes(DocsImageRoutes.linkImage(documentId), DocsImagePrep.MAX_BYTES.toLong())

    /** `DocsClient.imageData`: one screenshot's bytes. Null when it does not load. */
    suspend fun imageData(documentId: String, imageId: String): ByteArray? =
        media?.bytes(DocsImageRoutes.image(documentId, imageId), DocsImagePrep.MAX_BYTES.toLong())

    /** `DocsClient.uploadImage`: [prepared] went through [DocsImagePrep] first. */
    suspend fun uploadImage(documentId: String, prepared: DocsImagePrep.Prepared) {
        val sender = media ?: return
        sender.upload(DocsImageRoutes.upload(documentId), prepared.data, prepared.contentType)
        invalidate()
    }

    /** `DocsClient.deleteImage`: off the document's list. Docs keeps the file. */
    suspend fun deleteImage(documentId: String, imageId: String) {
        client.call(DocsImageRoutes.delete(documentId, imageId))
        invalidate()
    }

    suspend fun summary(): DocsSummary = kept(DocsSnapshotKey.SUMMARY, client.call(DocsRoutes.summary), DocsJson::summary)

    suspend fun tree(): List<DocsFolder> = DocsJson.tree(client.call(DocsRoutes.tree))

    /** `DocsClient.categories`: the workspace's categories, in rail order. */
    suspend fun categories(): List<DocsCategoryList.DocsCategoryInfo> =
        kept(DocsSnapshotKey.CATEGORIES, client.call(DocsRoutes.categories), DocsJson::categories)

    /**
     * `DocsClient.allDocuments`: every row of [read], not just its first
     * page. Docs caps one page at 200 rows, so this walks `offset` until the
     * list's `total` is in hand. Stops at [cap] rows. The whole list becomes
     * the snapshot for the read's key.
     */
    suspend fun allDocuments(read: DocsListRead, cap: Int = 5_000): List<DocsDocumentSummary> {
        val documents = mutableListOf<DocsDocumentSummary>()
        var total = Int.MAX_VALUE
        while (documents.size < minOf(total, cap)) {
            val page = DocsJson.documentList(client.call(DocsRoutes.documents(read.filter, read.limit, documents.size)))
            total = page.total
            if (page.documents.isEmpty()) break
            documents += page.documents
        }
        save(read.snapshotKey, DocsJson.json.encodeToString(DocsDocumentList.serializer(), DocsDocumentList(documents, total)))
        return documents
    }

    /** `cachedDocuments`: the last list that came back for [read], without a request. */
    fun cachedDocuments(read: DocsListRead): List<DocsDocumentSummary>? = cached(read.snapshotKey, DocsJson::documentList)?.documents

    /** `cachedSummary`: the last rail counts, without a request. */
    fun cachedSummary(): DocsSummary? = cached(DocsSnapshotKey.SUMMARY, DocsJson::summary)

    /** `cachedCategories`: the last category list, without a request. */
    fun cachedCategories(): List<DocsCategoryList.DocsCategoryInfo>? = cached(DocsSnapshotKey.CATEGORIES, DocsJson::categories)

    /** `DocsClient.search`: an empty query asks nothing. Never kept: a query is typed, not returned to. */
    suspend fun search(text: String, limit: Int = 100): List<DocsSearchHit> {
        if (text.isBlank()) return emptyList()
        return DocsJson.searchHits(client.call(DocsRoutes.search(text, limit)))
    }

    suspend fun document(id: String): DocsDocumentDetail = DocsJson.document(client.call(DocsRoutes.document(id)))

    suspend fun annotations(documentId: String): List<DocsAnnotation> =
        DocsJson.annotations(client.call(DocsExtraRoutes.annotations(documentId)))

    suspend fun post(documentId: String, body: String, parentId: String?): DocsAnnotation =
        DocsJson.annotation(client.call(DocsExtraRoutes.createAnnotation(documentId, body, parentId)))

    suspend fun setStatus(annotationId: String, status: String): DocsAnnotation =
        DocsJson.annotation(client.call(DocsExtraRoutes.setAnnotationStatus(annotationId, status)))

    /** `DocsClient.create`. */
    suspend fun create(input: DocsCreateDocument): DocsDocumentDetail = wrote(DocsJson.document(client.call(DocsExtraRoutes.create(input))))

    /** `DocsClient.update`. A moved body is a 409 `hash_mismatch`: see [isHashMismatch]. */
    suspend fun update(id: String, input: DocsUpdateDocument): DocsDocumentDetail =
        wrote(DocsJson.document(client.call(DocsExtraRoutes.update(id, input))))

    /** `DocsClient.grants`: every link to the document, revoked ones included. */
    suspend fun grants(documentId: String): List<DocsGrant> = DocsShare.grants(client.call(DocsShareRoutes.grants(documentId)))

    suspend fun createGrant(documentId: String, input: DocsCreateGrant): DocsGrant =
        DocsShare.grantOf(client.call(DocsShareRoutes.createGrant(documentId, input)))

    suspend fun revokeGrant(grantId: String) {
        client.call(DocsShareRoutes.revokeGrant(grantId))
    }

    /** `DocsClient.setVisibility`: the www switch. Answers the detail Docs keeps after it. */
    suspend fun setVisibility(documentId: String, visibility: String): DocsDocumentDetail =
        wrote(DocsJson.document(client.call(DocsShareRoutes.setVisibility(documentId, visibility))))

    /** `DocsClient.createSignatureRequest`. */
    suspend fun requestSignatures(documentId: String, input: DocsCreateSignatureRequest): DocsSignatureRequest =
        DocsShare.signatureOf(client.call(DocsShareRoutes.createSignatureRequest(documentId, input)))

    /** `DocsClient.archive`: status `archived`. */
    suspend fun archive(id: String): DocsDocumentDetail = update(id, DocsUpdateDocument(status = "archived"))

    /**
     * `DocsClient.file`: files every document Starlings can change and
     * answers how many changed. One already filed so is left alone. Stops at
     * the first failure; what was filed before it stays filed.
     */
    suspend fun file(documents: List<DocsDocumentSummary>, act: DocsFilingAct): Int {
        var changed = 0
        for (document in documents) {
            val write = DocsFiling.write(document, act) ?: continue
            when (write) {
                is DocsFilingWrite.Move -> client.call(DocsExtraRoutes.move(document.id, write.folderPath))
                is DocsFilingWrite.SetCategory ->
                    client.call(DocsExtraRoutes.update(document.id, DocsUpdateDocument(category = DocsUpdateDocument.CategoryChange.to(write.category))))
                is DocsFilingWrite.SetSubjects -> client.call(DocsExtraRoutes.setSubjects(document.id, write.subjects))
            }
            changed++
        }
        if (changed > 0) invalidate()
        return changed
    }

    /**
     * `StarlingsAPI.saveDocsLink`: the Worker reads the page and files the
     * link under [folderPath] (Docs' link folder when null), about [subjects].
     */
    suspend fun saveLink(url: String, folderPath: String?, subjects: List<DocsSubject>, message: String): DocsDocumentDetail {
        val request = DocsCreateDocumentRequest(
            url = url,
            folderPath = folderPath,
            subjects = subjects.takeIf { it.isNotEmpty() }?.map {
                DocsCreateDocumentRequestSubjectsItem(system = it.system, kind = DocsCreateDocumentRequestSubjectsItemKind(it.kind), subjectId = it.subjectId)
            },
            message = message,
        )
        val answer = client.call(DocsRoutes.saveLink(request))
        return wrote(DocsJson.savedLink(answer))
    }

    /** Every subject of [kind] the CRM names: what the By project, By lead and By partner rows are counted against. */
    suspend fun subjects(kind: CrmSubjectKind): List<CrmSubjectWire> = client.call(WorkRoutes.subjects(kind, "", null)).subjects

    /** The subjects of [kind] whose name holds [query]: what the editor's subject picker offers. */
    suspend fun searchSubjects(kind: CrmSubjectKind, query: String): List<CrmSubjectWire> =
        client.call(WorkRoutes.subjects(kind, query, null)).subjects

    /** `DocsClient.setSubjects`: the whole list, replaced. Answers the detail Docs keeps after it. */
    suspend fun setSubjects(documentId: String, subjects: List<DocsSubject>): DocsDocumentDetail =
        wrote(DocsJson.document(client.call(DocsExtraRoutes.setSubjects(documentId, subjects))))

    /** The last subjects of [kind] the CRM answered, without a request (the policy table keeps them on iOS, so here). */
    fun cachedSubjects(kind: CrmSubjectKind): List<CrmSubjectWire>? = client.snapshot(WorkRoutes.subjects(kind, "", null))?.value?.subjects

    private fun <T> kept(key: String, element: JsonElement, decode: (JsonElement) -> T): T {
        val value = decode(element)
        save(key, element.toString())
        return value
    }

    private fun save(key: String, body: String) {
        val who = owner() ?: return
        snapshots?.save(who, key, body, null)
    }

    private fun <T> cached(key: String, decode: (JsonElement) -> T): T? {
        val who = owner() ?: return null
        val entry = snapshots?.load(who, key) ?: return null
        return runCatching { decode(DocsJson.json.parseToJsonElement(entry.body)) }.getOrNull()
    }

    private fun <T> wrote(value: T): T {
        invalidate()
        return value
    }

    private fun invalidate() {
        val who = owner() ?: return
        snapshots?.invalidate(who, listOf(DocsSnapshotKey.PREFIX))
    }

    companion object {
        /** What a failure says under its title: the operation, in English, as every error. */
        fun describe(error: Throwable): String = when (error) {
            is StarlingsApiError -> error.sentence
            else -> error.message.orEmpty()
        }

        /** `DocsClientError.hashMismatch`: Docs refused a save because the body moved since it was read. */
        fun isHashMismatch(error: Throwable): Boolean =
            error is StarlingsApiError.Service && error.status == 409 && error.serverCode?.value == "hash_mismatch"
    }
}
