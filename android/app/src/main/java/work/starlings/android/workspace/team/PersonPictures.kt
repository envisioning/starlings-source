package work.starlings.android.workspace.team

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * `PersonAvatarStore` of `Sources/PersonAvatars.swift`, generic over what
 * a picture decodes to so the JVM tests hold it. Keyed by address and
 * version: a changed picture is another entry, and somebody without one
 * costs one remembered miss, not one per redraw. The roster publishes each
 * person's version with [remember]; a surface that knows only an address (a
 * message) asks by email and gets that version, or nothing.
 */
class PersonPictures<T : Any>(private val maximumEntries: Int = 256) {
    private val lock = Mutex()
    private val cached = HashMap<String, T?>()
    private val inFlight = HashMap<String, CompletableDeferred<T?>>()
    private val versions = HashMap<String, Long>()

    /** What the roster just said. Idempotent: call it on every poll. */
    suspend fun remember(people: List<Pair<String, Long?>>) = lock.withLock {
        for ((email, version) in people) {
            val key = email.lowercase()
            if (version != null) versions[key] = version else versions.remove(key)
        }
    }

    /** The version the roster last published for [email]. */
    suspend fun version(email: String): Long? = lock.withLock { versions[email.lowercase()] }

    /**
     * The picture for [email] at [version], or at the version the roster
     * published when [version] is null. [fetch] runs at most once per key,
     * shared by concurrent callers; its null (a 404, a failure) is kept too.
     */
    suspend fun picture(email: String, version: Long?, fetch: suspend (Long) -> T?): T? {
        val wanted = version ?: version(email) ?: return null
        val key = key(email, wanted)
        val (deferred, owner) = lock.withLock {
            if (cached.containsKey(key)) return cached[key]
            inFlight[key]?.let { return@withLock it to false }
            CompletableDeferred<T?>().also { inFlight[key] = it } to true
        }
        if (!owner) return deferred.await()
        val value = try {
            fetch(wanted)
        } catch (e: kotlinx.coroutines.CancellationException) {
            lock.withLock { inFlight.remove(key) }
            deferred.complete(null)
            throw e
        } catch (_: Exception) {
            null
        }
        lock.withLock {
            inFlight.remove(key)
            if (cached.size >= maximumEntries) cached.clear()
            cached[key] = value
        }
        deferred.complete(value)
        return value
    }

    /** Drops everything held for one person, after your own upload. */
    suspend fun forget(email: String, version: Long? = null) = lock.withLock {
        val prefix = "${email.lowercase()}|"
        cached.keys.removeAll { it.startsWith(prefix) }
        if (version != null) versions[email.lowercase()] = version else versions.remove(email.lowercase())
    }

    companion object {
        fun key(email: String, version: Long): String = "${email.lowercase()}|$version"
    }
}
