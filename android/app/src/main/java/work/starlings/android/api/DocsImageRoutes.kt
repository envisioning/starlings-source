package work.starlings.android.api

/**
 * A link save's pictures: DocsKit's `DocsClient.linkImage`,
 * `uploadImage`, `imageData` and `deleteImage` (core-kit
 * `Sources/DocsKit/DocsClient.swift`), on the Worker's copy of Docs' paths,
 * `/api/docs-service` + Docs' own `/api/…`. The byte routes answer
 * [Answer.None]: `workspace/docs/DocsImages.kt` sends them through
 * `TeamMedia`, because [StarlingsClient] reads a body as text.
 */
object DocsImageRoutes {
    private val service = listOf("docs-service", "api")

    /** The copy of the page's own image Docs keeps. Nothing here calls the site. */
    fun linkImage(documentId: String): Route<Unit> = Route(
        "GET", service + listOf("docs", documentId, "link-image"),
        answer = Answer.None, operation = "Couldn’t load that picture", timeoutSeconds = 30.0,
    )

    /** One attached screenshot's bytes. */
    fun image(documentId: String, imageId: String): Route<Unit> = Route(
        "GET", service + listOf("docs", documentId, "images", imageId),
        answer = Answer.None, operation = "Couldn’t load that picture", timeoutSeconds = 30.0,
    )

    /**
     * Attach one image, the bytes as the body. Prepare it with
     * `DocsImagePrep` first: Docs takes PNG, JPEG, WebP or GIF up to
     * `DocsImagePrep.MAX_BYTES`, and checks the bytes, not the type named.
     */
    fun upload(documentId: String, caption: String? = null): Route<Unit> = Route(
        "POST", service + listOf("docs", documentId, "images"),
        query = listOfNotNull(caption?.takeIf { it.isNotEmpty() }?.let { "caption" to it }),
        answer = Answer.None, operation = "Couldn’t attach that image", timeoutSeconds = 120.0,
    )

    /** Off the document's list. Docs keeps the file. */
    fun delete(documentId: String, imageId: String): Route<Unit> = Route(
        "DELETE", service + listOf("docs", documentId, "images", imageId),
        answer = Answer.None, operation = "Couldn’t remove that image",
    )
}
