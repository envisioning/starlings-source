package work.starlings.android.workspace.docs

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * The two doors out of Docs that DocsUI's `ShareSheet` and `SignatureSheet`
 * open (core-kit `Sources/DocsUI/ShareSheet.swift`, `SignatureSheet.swift`),
 * and DocsKit's models for them (`DocsBrowserModels.swift`: `DocsGrant`,
 * `DocsCreateGrant`, `DocsSignatureRequest`, `DocsCreateSignatureRequest`;
 * `DocsModels.swift`: `DocsVisibility`, `DocsShareLink`). Snake case on the
 * wire, as `DocsCoding`. Pure, for the JVM tests.
 */
object DocsShare {
    /** `DocsVisibility`. */
    const val INTERNAL = "internal"
    const val LINK = "link"
    const val PUBLIC = "public"

    const val VIEWER = "viewer"
    const val COMMENTER = "commenter"

    /** True when the document answers on the www share page. `public` counts as on. */
    fun isShared(visibility: String): Boolean = visibility == LINK || visibility == PUBLIC

    /** The www switch: on is `link`, off is always `internal` (a `public` document switched off becomes `internal`). */
    fun visibility(shared: Boolean): String = if (shared) LINK else INTERNAL

    /**
     * `DocsShareLink.www`: the email-gated reader on the public site. It is
     * the Docs id, not a grant token; it answers only while the document is shared.
     */
    fun www(documentId: String): String = "${work.starlings.android.Deployment.ORG_WWW_ORIGIN}/private/docs/$documentId"

    /** The links still open: a revoked grant leaves the list. */
    fun live(grants: List<DocsGrant>): List<DocsGrant> = grants.filter { it.revokedAt == null }

    /** Create link: an address binds the link to it and asks the holder to prove it with a mailed code. */
    fun grant(role: String, email: String): DocsCreateGrant {
        val address = email.trim()
        return if (address.isEmpty()) DocsCreateGrant(role) else DocsCreateGrant(role, email = address, requireVerification = true)
    }

    /** `SignatureSheet.parties`: one per address, split on lines, commas, semicolons or spaces; a word with no `@` is not one. */
    fun signers(text: String): List<DocsCreateSignatureRequest.Party> =
        text.split('\n', ',', ';', ' ')
            .map { it.trim() }
            .filter { it.contains('@') }
            .map { DocsCreateSignatureRequest.Party(it) }

    /** `send()`: an empty subject or note is left off. */
    fun signatureRequest(signers: String, subject: String, message: String) = DocsCreateSignatureRequest(
        subject = subject.ifEmpty { null },
        message = message.ifEmpty { null },
        parties = signers(signers),
    )

    /** The grant row's role word: `role.rawValue.capitalized`. */
    fun roleWord(role: String): String = role.replaceFirstChar(Char::uppercaseChar)

    /** The day a signature request expires (`expiresAt.prefix(10)`), or null for the 30-day default. */
    fun expiryDay(request: DocsSignatureRequest): String? = request.expiresAt?.take(10)

    /** A party's status word: `status.capitalized`. */
    fun statusWord(status: String): String = status.replaceFirstChar(Char::uppercaseChar)

    fun grants(element: JsonElement): List<DocsGrant> = DocsJson.decode(DocsGrantList.serializer(), element).grants
    fun grantOf(element: JsonElement): DocsGrant = DocsJson.decode(DocsGrant.serializer(), element)
    fun signatureOf(element: JsonElement): DocsSignatureRequest = DocsJson.decode(DocsSignatureRequest.serializer(), element)
}

/** `DocsGrant`: one revocable link to a document, optionally bound to an address. */
@Serializable
data class DocsGrant(
    val id: String,
    @SerialName("document_id") val documentId: String? = null,
    @SerialName("folder_id") val folderId: String? = null,
    val url: String,
    val email: String? = null,
    val role: String,
    val label: String? = null,
    @SerialName("require_verification") val requireVerification: Boolean,
    @SerialName("created_by") val createdBy: String,
    @SerialName("created_at") val createdAt: String,
    @SerialName("expires_at") val expiresAt: String? = null,
    @SerialName("revoked_at") val revokedAt: String? = null,
    @SerialName("last_used_at") val lastUsedAt: String? = null,
    @SerialName("use_count") val useCount: Int,
)

@Serializable
data class DocsGrantList(val grants: List<DocsGrant>)

/** `DocsCreateGrant`: `POST /api/docs/:id/grants`. A null field is left off. */
@Serializable
data class DocsCreateGrant(
    val role: String,
    val email: String? = null,
    val label: String? = null,
    @SerialName("require_verification") val requireVerification: Boolean? = null,
    @SerialName("expires_in_days") val expiresInDays: Int? = null,
)

/** `DocsVisibility` as `PATCH /api/docs/:id` takes it: only the switch moves. */
@Serializable
data class DocsSetVisibility(val visibility: String)

@Serializable
data class DocsSignatureParty(
    val id: String,
    val email: String,
    val name: String? = null,
    val role: String,
    val sequence: Int,
    val status: String,
    @SerialName("signed_at") val signedAt: String? = null,
    val url: String? = null,
)

/** `DocsSignatureRequest`: who signs which version, and where each stands. */
@Serializable
data class DocsSignatureRequest(
    val id: String,
    @SerialName("document_id") val documentId: String,
    @SerialName("document_title") val documentTitle: String,
    @SerialName("document_version") val documentVersion: Int,
    @SerialName("requested_by") val requestedBy: String,
    val subject: String? = null,
    val status: String,
    @SerialName("created_at") val createdAt: String,
    @SerialName("expires_at") val expiresAt: String? = null,
    @SerialName("completed_at") val completedAt: String? = null,
    val parties: List<DocsSignatureParty>,
)

/** `DocsCreateSignatureRequest`: `POST /api/docs/:id/signature-requests`. Docs mails each signer their own link. */
@Serializable
data class DocsCreateSignatureRequest(
    val subject: String? = null,
    val message: String? = null,
    val parties: List<Party>,
    @SerialName("expires_in_days") val expiresInDays: Int? = null,
) {
    @Serializable
    data class Party(val email: String, val name: String? = null)
}
