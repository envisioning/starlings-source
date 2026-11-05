package work.starlings.android.background

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.SystemClock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import work.starlings.contracts.WireJson
import work.starlings.contracts.WorkspaceBackgroundProfile
import work.starlings.contracts.WorkspaceDescriptor
import java.util.concurrent.TimeUnit

/**
 * `Sources/WorkspaceBackgrounds.swift`: the workspace's public background
 * profile (tones, a picture, a default) and this device's own choice.
 *
 * The profile comes from the workspace descriptor, `GET /.well-known/meet`
 * ([DESCRIPTOR_ROUTE], held to `fixtures/routes.json`), the route iOS reads.
 * It needs no session, so a guest gets the workspace's tones too. The last
 * profile is kept in preferences, so offline keeps the tones; the picture
 * stays in memory only. The choice is device-local, under the key iOS uses
 * (`meet.background.<origin>.choice`).
 */
class WorkspaceBackgrounds(context: Context, private val origin: String = work.starlings.android.Workspaces.active.webOrigin) {
    private val prefs = context.applicationContext.getSharedPreferences("backgrounds", Context.MODE_PRIVATE)
    private val http = OkHttpClient.Builder().followRedirects(true).build()

    private val _profile = MutableStateFlow(cachedProfile())
    val profile: StateFlow<WorkspaceBackgroundProfile?> = _profile.asStateFlow()

    @Volatile var image: Bitmap? = null
        private set
    private var readAt = 0L

    /** The workspace names a picture: the menu offers it. */
    val hasPicture: Boolean get() = _profile.value?.imageUrl != null

    fun tonePair(tone: BackgroundTone): TonePair = BackgroundGalleryRegistry.tonePair(tone, _profile.value)

    /** The saved choice, else the workspace default, resolved against the pictures there are. */
    fun preferredEffect(hasCustomImage: Boolean): BackgroundEffect = BackgroundEffect.resolve(
        BackgroundEffect.select(prefs.getString(key("choice"), null), _profile.value),
        hasCustomImage = hasCustomImage,
        hasWorkspaceImage = image != null,
    )

    fun remember(effect: BackgroundEffect) {
        prefs.edit().putString(key("choice"), BackgroundEffect.encode(effect)).apply()
    }

    /** Refreshed when a camera opens; at most every 30 s. Offline keeps the cached profile. */
    suspend fun refresh() = withContext(Dispatchers.IO) {
        if (readAt != 0L && SystemClock.elapsedRealtime() - readAt < 30_000) return@withContext
        val base = origin.toHttpUrlOrNull() ?: return@withContext
        val descriptor = runCatching { readDescriptor(base) }.getOrNull() ?: return@withContext
        val next = descriptor.brand.backgrounds ?: return@withContext
        var picture = if (_profile.value?.imageUrl == next.imageUrl) image else null
        val raw = next.imageUrl
        if (raw != null && picture == null) picture = runCatching { readPicture(raw) }.getOrNull()
        image = picture
        readAt = SystemClock.elapsedRealtime()
        _profile.value = next
        prefs.edit().putString(key("profile"), WireJson.encodeToString(WorkspaceBackgroundProfile.serializer(), next)).apply()
    }

    /**
     * The descriptor, strictly decoded, from [base] only. Blocking: call it
     * off the main thread. Calendar's zone shortlist reads it too.
     */
    fun readDescriptor(base: HttpUrl = origin.toHttpUrl()): WorkspaceDescriptor? {
        val url = base.resolve(DESCRIPTOR_PATH) ?: return null
        val request = Request.Builder().url(url).header("Accept", "application/json").build()
        val client = http.newBuilder().callTimeout(10, TimeUnit.SECONDS).build()
        client.newCall(request).execute().use { response ->
            // A redirect may only stay on the origin that was asked.
            if (response.code != 200 || originOf(response.request.url) != originOf(base)) return null
            val bytes = response.body?.bytes() ?: return null
            if (bytes.size > 64 * 1024) return null
            val descriptor = runCatching { WireJson.decodeFromString(WorkspaceDescriptor.serializer(), bytes.decodeToString()) }.getOrNull()
            return descriptor?.takeIf { it.version == DESCRIPTOR_VERSION }
        }
    }

    /** Only from the workspace's own origin, at most 12 MB and 1280 × 720, PNG, JPEG or WebP. */
    private fun readPicture(raw: String): Bitmap? {
        val url = raw.toHttpUrlOrNull() ?: return null
        val home = origin.toHttpUrlOrNull() ?: return null
        if (originOf(url) != originOf(home)) return null
        val client = http.newBuilder().callTimeout(15, TimeUnit.SECONDS).build()
        client.newCall(Request.Builder().url(url).build()).execute().use { response ->
            if (response.code != 200 || originOf(response.request.url) != originOf(home)) return null
            val type = response.body?.contentType()?.let { "${it.type}/${it.subtype}" }
            if (type !in setOf("image/png", "image/jpeg", "image/webp")) return null
            val length = response.body?.contentLength() ?: -1
            if (length > CustomBackgroundStore.MAX_BYTES) return null
            val bytes = response.body?.bytes() ?: return null
            if (bytes.size > CustomBackgroundStore.MAX_BYTES) return null
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outWidth > CustomBackgroundStore.MAX_WIDTH || bounds.outHeight > CustomBackgroundStore.MAX_HEIGHT) return null
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }
    }

    private fun cachedProfile(): WorkspaceBackgroundProfile? = prefs.getString(key("profile"), null)?.let {
        runCatching { WireJson.decodeFromString(WorkspaceBackgroundProfile.serializer(), it) }.getOrNull()
    }

    private fun key(suffix: String) = "meet.background.$origin.$suffix"

    companion object {
        /** `workspaceDescriptorPath` and `workspaceDescriptorVersion` in `fixtures/shared-constants.json`. */
        const val DESCRIPTOR_PATH = "/.well-known/meet"
        const val DESCRIPTOR_VERSION = 1L
        /** What `fixtures/routes.json` lists for it (`WorkspaceBackgroundsTest`). */
        const val DESCRIPTOR_ROUTE = "GET $DESCRIPTOR_PATH"

        fun originOf(url: HttpUrl): String {
            val defaultPort = HttpUrl.defaultPort(url.scheme)
            return if (url.port == defaultPort) "${url.scheme}://${url.host}" else "${url.scheme}://${url.host}:${url.port}"
        }
    }
}
