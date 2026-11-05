package work.starlings.android.workspace.work

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.Locale

/**
 * A picture attached to a GitHub issue (`Sources/CrmIssueImage.swift`).
 * GitHub has no public API to put a file in an issue, so the Worker keeps
 * the bytes (`PUT /api/issue-images`) and the body carries a markdown image
 * link to an address github.com can render.
 */
object IssueImage {
    /** `ISSUE_IMAGE_MAX_BYTES` (`fixtures/shared-constants.json`, `issueImageMaxBytes`). */
    const val MAX_BYTES = 8 * 1024 * 1024

    /** What the Worker vouches for (`allowedTypes`). It sniffs the bytes, so a wrong type is refused, not stored. */
    val allowedTypes = listOf("image/png", "image/jpeg", "image/webp")

    /** English, as every error (AGENTS.md). Swift's em dash is a colon here: no em dashes in rendered copy. */
    const val READ_FAILURE = "Couldn’t read that file."
    const val TOO_LARGE = "That image is too large: 8 MB is the limit."

    /**
     * The type to send, from the file's own extension (`contentType(for:)`),
     * then the type the picker reports when it is one of the three. PNG is
     * the fallback, because a screenshot is what this is for.
     */
    fun contentType(name: String, reported: String? = null): String {
        val ext = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
        return when (ext) {
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "webp" -> "image/webp"
            else -> reported?.lowercase(Locale.ROOT)?.takeIf { it in allowedTypes } ?: "image/png"
        }
    }

    /** The line for the issue body: the file name is the alt text, without the brackets that would end it early. */
    fun markdown(name: String, url: String): String = "![${name.replace("[", "").replace("]", "")}]($url)"

    /** The link at the end of a body, after a blank line when the body has text. */
    fun appending(markdown: String, body: String): String = if (body.isEmpty()) markdown else "$body\n\n$markdown"

    /** A picked file: its name, the type to send and its bytes. */
    class Picked(val name: String, val contentType: String, val data: ByteArray)

    /** Reads the picked file whole. Throws with [READ_FAILURE] or [TOO_LARGE]. */
    suspend fun read(context: Context, uri: Uri): Picked = withContext(Dispatchers.IO) {
        val resolver = context.contentResolver
        var name = "image"
        var size = -1L
        runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    cursor.getString(0)?.let { name = it }
                    if (!cursor.isNull(1)) size = cursor.getLong(1)
                }
            }
        }
        if (size > MAX_BYTES) throw IllegalStateException(TOO_LARGE)
        val data = runCatching { resolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull() ?: throw IllegalStateException(READ_FAILURE)
        if (data.size > MAX_BYTES) throw IllegalStateException(TOO_LARGE)
        Picked(name, contentType(name, resolver.getType(uri)), data)
    }
}
