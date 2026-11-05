package work.starlings.android.api

import kotlinx.serialization.json.JsonElement
import work.starlings.android.workspace.docs.DocsCreateGrant
import work.starlings.android.workspace.docs.DocsCreateSignatureRequest
import work.starlings.android.workspace.docs.DocsJson
import work.starlings.android.workspace.docs.DocsSetVisibility

/**
 * The editor's Share and Send for signature: DocsKit's `DocsClient.grants`,
 * `createGrant`, `revokeGrant`, `setVisibility` and `createSignatureRequest`
 * (core-kit `Sources/DocsKit/DocsClient.swift`), on the Worker's copy of
 * Docs' paths, `/api/docs-service` + Docs' own `/api/…`. They answer
 * DocsKit's models, read with `workspace/docs/DocsShare.kt`.
 */
object DocsShareRoutes {
    private val service = listOf("docs-service", "api")

    /** Every link to a document, revoked ones included. */
    fun grants(documentId: String): Route<JsonElement> = Route(
        "GET", service + listOf("docs", documentId, "grants"),
        answer = Answer.Json, operation = "Couldn’t load links",
    )

    fun createGrant(documentId: String, input: DocsCreateGrant): Route<JsonElement> = Route(
        "POST", service + listOf("docs", documentId, "grants"),
        body = DocsJson.json.encodeToString(DocsCreateGrant.serializer(), input),
        answer = Answer.Json, operation = "Couldn’t create that link",
    )

    fun revokeGrant(grantId: String): Route<Unit> = Route(
        "DELETE", service + listOf("grants", grantId),
        answer = Answer.None, operation = "Couldn’t revoke that link",
    )

    /** The www switch: `link` or `internal`. Answers the document's detail. */
    fun setVisibility(documentId: String, visibility: String): Route<JsonElement> = Route(
        "PATCH", service + listOf("docs", documentId),
        body = DocsJson.json.encodeToString(DocsSetVisibility.serializer(), DocsSetVisibility(visibility)),
        answer = Answer.Json, operation = "Couldn’t change sharing",
    )

    /** Docs mails each signer their own link; they sign this exact version. */
    fun createSignatureRequest(documentId: String, input: DocsCreateSignatureRequest): Route<JsonElement> = Route(
        "POST", service + listOf("docs", documentId, "signature-requests"),
        body = DocsJson.json.encodeToString(DocsCreateSignatureRequest.serializer(), input),
        answer = Answer.Json, operation = "Couldn’t send that for signature",
    )
}
