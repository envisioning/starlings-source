package work.starlings.android.api

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.security.MessageDigest

/**
 * Stale-while-revalidate snapshots of list reads, as `Sources/SnapshotStore.swift`
 * (docs/CACHING.md): the last good response body per owner and key, with its
 * ETag, so a screen paints what it last knew and refreshes behind it. Bytes,
 * not decoded values: a snapshot decodes through the same `Wire.kt` code as a
 * live answer.
 *
 * One folder per workspace origin under [root] (the app's `cacheDir`, never
 * `noBackupFilesDir`), one file per owner and key, named by a SHA-256 of
 * workspace, owner and key, so one address on two workspaces never paints
 * the other's lists. Never holds tokens or credentials: only the reads the
 * policy table names go through it. Sign-out calls [purge].
 */
class SnapshotCache(
    root: File,
    workspaceOrigin: String,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val workspace = workspaceOrigin
    private val dir = File(root, sha256(workspaceOrigin))
    private val lock = Any()
    private val _invalidations = MutableSharedFlow<Invalidation>(extraBufferCapacity = 16)

    /** A write made these lists stale for [owner]; a screen showing one re-reads (`didInvalidateNotification`). */
    data class Invalidation(val owner: String, val prefixes: List<String>)

    val invalidations: SharedFlow<Invalidation> = _invalidations.asSharedFlow()

    /** One stored answer. */
    data class Entry(val body: String, val savedAtMs: Long, val etag: String?)

    @Serializable
    private data class Envelope(
        val schema: Int,
        val owner: String,
        val key: String,
        val savedAtMs: Long,
        val body: String,
        val etag: String? = null,
    )

    /** The last snapshot for [key], or null when none is usable: absent, another shape, or older than [MAX_AGE_MS]. */
    fun load(owner: String, key: String): Entry? = synchronized(lock) { read(owner, key) }

    private fun read(owner: String, key: String): Entry? {
        if (owner.isEmpty()) return null
        val file = file(owner, key)
        if (!file.exists()) return null
        val envelope = runCatching { json.decodeFromString(Envelope.serializer(), file.readText()) }.getOrNull() ?: return null
        if (envelope.schema != SCHEMA || envelope.owner != owner.lowercase() || envelope.key != key) return null
        if (clock() - envelope.savedAtMs >= MAX_AGE_MS) return null
        return Entry(envelope.body, envelope.savedAtMs, envelope.etag)
    }

    /** Best effort: a snapshot that failed to write costs the next launch its head start and nothing else. */
    fun save(owner: String, key: String, body: String, etag: String?) {
        if (owner.isEmpty()) return
        synchronized(lock) {
            dir.mkdirs()
            val envelope = Envelope(SCHEMA, owner.lowercase(), key, clock(), body, etag)
            val target = file(owner, key)
            val temp = File(dir, "${target.name}.tmp")
            runCatching {
                temp.writeText(json.encodeToString(Envelope.serializer(), envelope))
                if (!temp.renameTo(target)) temp.delete()
            }
        }
    }

    /**
     * `SnapshotStore.invalidate(prefixes:owner:)`: the lists a write made
     * stale. As on iOS the file stays, the next cold start's head start, and
     * the re-read replaces it; the ETag beside it makes that re-read a full
     * answer when the list changed. Screens learn of it from [invalidations].
     */
    fun invalidate(owner: String, prefixes: List<String>) {
        if (owner.isEmpty() || prefixes.isEmpty()) return
        _invalidations.tryEmit(Invalidation(owner, prefixes))
    }

    /** Signing out takes this workspace's snapshots with it: the next owner starts cold. */
    fun purge() {
        synchronized(lock) { dir.deleteRecursively() }
    }

    private fun file(owner: String, key: String) = File(dir, sha256("$workspace\n${owner.lowercase()}\n$key") + ".json")

    companion object {
        /** Bumped whenever [Envelope] changes; anything else on disk is not read. */
        private const val SCHEMA = 1

        /** `SnapshotStore.maxAge`: past a week a snapshot is no head start, and is not shown. */
        const val MAX_AGE_MS = 7L * 24 * 3_600 * 1_000

        private val json = Json { ignoreUnknownKeys = true }

        private fun sha256(s: String) = MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}
