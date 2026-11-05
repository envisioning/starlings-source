package work.starlings.android.api

import kotlinx.serialization.json.JsonElement
import work.starlings.android.workspace.docs.DocsAnnotationStatus
import work.starlings.android.workspace.docs.DocsCreateAnnotation
import work.starlings.android.workspace.docs.DocsCreateDocument
import work.starlings.android.workspace.docs.DocsJson
import work.starlings.android.workspace.docs.DocsMoveDocument
import work.starlings.android.workspace.docs.DocsSetSubjects
import work.starlings.android.workspace.docs.DocsSubject
import work.starlings.android.workspace.docs.DocsUpdateDocument

/**
 * The Docs routes the phone's comments need beside [DocsRoutes]: DocsKit's
 * `DocsClient.annotations`, `createAnnotation` and `updateAnnotation`
 * (core-kit `Sources/DocsKit/DocsClient.swift`), on the Worker's copy of
 * Docs' paths, `/api/docs-service` + Docs' own `/api/…`. They answer
 * DocsKit's models, read with `workspace/docs/DocsModels.kt`.
 */
object DocsExtraRoutes {
    private val service = listOf("docs-service", "api")

    /** Every comment on a document, flat; `DocsRules.threads` groups them. */
    fun annotations(documentId: String): Route<JsonElement> = Route(
        "GET", service + listOf("docs", documentId, "annotations"),
        answer = Answer.Json, operation = "Couldn’t load comments",
    )

    /** A new thread on the whole document, or a reply when [parentId] names the root. */
    fun createAnnotation(documentId: String, body: String, parentId: String?): Route<JsonElement> = Route(
        "POST", service + listOf("docs", documentId, "annotations"),
        body = DocsJson.json.encodeToString(DocsCreateAnnotation.serializer(), DocsCreateAnnotation(body, parentId)),
        answer = Answer.Json, operation = "Couldn’t post that comment",
    )

    /**
     * Resolve (`resolved`) or reopen (`open`) a thread by its root. Any
     * member may. The thread leaves or comes back to INBOX with it.
     */
    fun setAnnotationStatus(annotationId: String, status: String): Route<JsonElement> = Route(
        "PATCH", service + listOf("annotations", annotationId),
        body = DocsJson.json.encodeToString(DocsAnnotationStatus.serializer(), DocsAnnotationStatus(status)),
        answer = Answer.Json, operation = if (status == "resolved") "Couldn’t resolve that comment" else "Couldn’t reopen that comment",
        writes = listOf(SnapshotWrite.COMMENT_RESOLVE),
    )

    /** `DocsClient.create`: a new document. Answers its detail. */
    fun create(input: DocsCreateDocument): Route<JsonElement> = Route(
        "POST", service + "docs",
        body = DocsJson.json.encodeToString(DocsCreateDocument.serializer(), input),
        answer = Answer.Json, operation = "Couldn’t create that document",
    )

    /**
     * `DocsClient.update`: title, body, category or status (Archive). With
     * `if_content_hash` Docs answers 409 `hash_mismatch` when the body moved.
     */
    fun update(id: String, input: DocsUpdateDocument): Route<JsonElement> = Route(
        "PATCH", service + listOf("docs", id), body = input.encode(),
        answer = Answer.Json,
        operation = if (input.status == "archived") "Couldn’t archive that document" else "Couldn’t save that document",
    )

    /** `DocsClient.move`: into another folder. */
    fun move(id: String, folderPath: String): Route<JsonElement> = Route(
        "POST", service + listOf("docs", id, "move"),
        body = DocsJson.json.encodeToString(DocsMoveDocument.serializer(), DocsMoveDocument(folderPath)),
        answer = Answer.Json, operation = "Couldn’t move that document",
    )

    /** `DocsClient.setSubjects`: the whole list, replaced. */
    fun setSubjects(id: String, subjects: List<DocsSubject>): Route<JsonElement> = Route(
        "PUT", service + listOf("docs", id, "subjects"),
        body = DocsJson.json.encodeToString(DocsSetSubjects.serializer(), DocsSetSubjects(subjects)),
        answer = Answer.Json, operation = "Couldn’t file that document",
    )
}
