package work.starlings.android.share

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import work.starlings.android.api.StarlingsApiError
import java.io.File
import java.security.MessageDigest

/**
 * One share waiting for the Worker: a link for Docs or a Quick Note
 * (`iOS/ShareOutbox.swift` `ShareOutboxItem`). The id is minted on the
 * device, so a note sent twice is still one note.
 */
@Serializable
data class ShareOutboxItem(
    val id: String,
    /** Epoch milliseconds: the order the items go out in, and a note's `captured_at`. */
    val createdAt: Long,
    /** The workspace the person saw named when they saved. */
    val workspaceOrigin: String,
    val kind: Kind,
    val url: String? = null,
    val title: String? = null,
    val note: String = "",
    val body: String? = null,
) {
    @Serializable
    enum class Kind { LINK, NOTE }
}

/**
 * The shares one owner on one workspace has not sent yet, one JSON file each,
 * in app storage (`filesDir`, never backed up: `allowBackup` is off).
 * A different owner reads a different folder and never sends another's
 * shares, as iOS `QuickNoteOutbox` keys its file by owner.
 */
class ShareOutbox(root: File, val origin: String, owner: String) {
    private val folder = File(root, digest("${origin.lowercase()}\n${owner.lowercase()}"))

    fun write(item: ShareOutboxItem) {
        folder.mkdirs()
        val tmp = File(folder, "${item.id}.tmp")
        tmp.writeText(json.encodeToString(ShareOutboxItem.serializer(), item))
        if (!tmp.renameTo(File(folder, "${item.id}.json"))) {
            tmp.delete()
            error("share outbox write failed")
        }
    }

    /** Every share waiting for this workspace, oldest first. A file that no longer reads is removed: it would wait forever. */
    fun pending(): List<ShareOutboxItem> {
        val files = folder.listFiles { f -> f.extension == "json" } ?: return emptyList()
        return files.mapNotNull { file ->
            runCatching { json.decodeFromString(ShareOutboxItem.serializer(), file.readText()) }
                .onFailure { file.delete() }
                .getOrNull()
        }.filter { it.workspaceOrigin == origin }.sortedBy { it.createdAt }
    }

    fun remove(id: String) {
        File(folder, "$id.json").delete()
    }

    /**
     * One pass, oldest first (`StarlingsAppModel.drainShareOutbox`). A share
     * the Worker refuses is dropped, since it would be refused again; offline,
     * a 5xx, a 429 or a refused session ends the pass and keeps the rest.
     * Answers what happened to each item the pass reached.
     */
    suspend fun drain(send: suspend (ShareOutboxItem) -> Unit): Map<String, Outcome> {
        val seen = LinkedHashMap<String, Outcome>()
        for (item in pending()) {
            val outcome = try {
                send(item)
                Outcome.SENT
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                outcome(e)
            }
            if (outcome == Outcome.KEPT) {
                seen[item.id] = outcome
                break
            }
            remove(item.id)
            seen[item.id] = outcome
        }
        return seen
    }

    enum class Outcome { SENT, REFUSED, KEPT }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        /**
         * iOS's rule: a 4xx other than 429 is the Worker refusing this share.
         * A 2xx that does not decode was still saved. Anything else waits.
         */
        fun outcome(error: Throwable): Outcome = when (error) {
            is StarlingsApiError.Service -> if (error.status in 400..499 && error.status != 429 && error.status != 408) Outcome.REFUSED else Outcome.KEPT
            is StarlingsApiError.Undecodable -> Outcome.SENT
            else -> Outcome.KEPT
        }

        private fun digest(text: String): String =
            MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).take(12).joinToString("") { "%02x".format(it) }
    }
}
