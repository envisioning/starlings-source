package work.starlings.android

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import work.starlings.contracts.WireJson
import work.starlings.contracts.WorkspaceDescriptor
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.URI
import java.util.concurrent.TimeUnit

/**
 * One workspace this install can sign in to, as `StarlingsWorkspace`
 * (Sources/StarlingsWorkspace.swift, docs/CENTRAL_AUTH.md "Native sign-in").
 * Not a secret and not a session: what the workspace publishes at
 * `/.well-known/meet`. The session stays in the Keystore-sealed vault,
 * keyed by [webOrigin].
 */
@Serializable
data class StarlingsWorkspace(
    /** The workspace's own web origin. Per-workspace state is keyed by it. */
    val webOrigin: String,
    /** The origin the API answers on (`<apiOrigin>/api/…`). */
    val apiOrigin: String,
    val name: String,
    /** The mark on [webOrigin], or null. */
    val markUrl: String? = null,
    /** The descriptor's `public_web_origin`: the host room links name. */
    val publicWebOrigin: String? = null,
    /** Other hosts confirmed to serve this workspace (slice F); a link on one opens here. */
    val linkHosts: List<String>? = null,
    /** Member domains from the descriptor's `identity`. Null before the first read. */
    val domains: List<String>? = null,
) {
    /** True for the build's own workspace, however it was reached. */
    val isBuiltIn: Boolean get() = webOrigin == builtIn.webOrigin || apiOrigin == builtIn.apiOrigin

    /** The origin every link this workspace hands out names. */
    val publicOrigin: String get() = publicWebOrigin ?: if (isBuiltIn) Contracts.PUBLIC_WEB_ORIGIN else webOrigin

    /** `StarlingsWorkspace.address`: the host, with the port only on a local stack. */
    val address: String get() = AppEnvironment.address(webOrigin)

    /** The first letter of the name, for a workspace with no mark. */
    val initial: String get() = name.trim().firstOrNull()?.uppercase() ?: "?"

    /** `resolvedIdentity.domains`: the build's own without a descriptor; any other admits nobody by domain. */
    val resolvedDomains: List<String> get() = domains ?: if (isBuiltIn) Contracts.identityDomains else emptyList()

    /** True when this build may talk to the workspace (`canSignIn`). */
    fun canSignIn(development: Boolean = BuildConfig.DEBUG): Boolean =
        isBuiltIn || (WorkspaceAddress.origin(webOrigin, development) != null && WorkspaceAddress.origin(apiOrigin, development) != null)

    /** A switcher row's second line (`rowDetail`): the address, then who is signed in, or [signedOut]. */
    fun rowDetail(email: String?, signedOut: String? = null): String = when {
        email != null -> "$address · $email"
        signedOut != null -> "$address · $signedOut"
        else -> address
    }

    /**
     * True when [origin] is one of this workspace's hosts: its web or API
     * origin, or a confirmed link host. The build's own workspace also owns
     * the hosts the build names for it (`PUBLIC_WEB_ORIGIN`, `SERVED_WEB_ORIGIN`).
     */
    fun owns(origin: String, development: Boolean = BuildConfig.DEBUG): Boolean {
        val wanted = comparable(origin, development) ?: return false
        val hosts = listOf(webOrigin, apiOrigin) + linkHosts.orEmpty() +
            if (isBuiltIn) listOf(Contracts.PUBLIC_WEB_ORIGIN, Contracts.SERVED_WEB_ORIGIN) else emptyList()
        return hosts.mapNotNull { comparable(it, development) }.contains(wanted)
    }

    /**
     * The preferences key for [name] in this workspace (`WorkspaceScope.defaultsKey`).
     * The build's own workspace keeps the key it had before there was more
     * than one, so a current member upgrades without losing it.
     */
    fun scopedKey(name: String): String = if (isBuiltIn) name else "$name@$webOrigin"

    companion object {
        /**
         * The workspace the build names: Envisioning, so a current member
         * starts where they were (`StarlingsWorkspace.builtIn`).
         */
        val builtIn = StarlingsWorkspace(
            webOrigin = BuildConfig.ORIGIN,
            apiOrigin = BuildConfig.ORIGIN,
            name = "Envisioning",
            publicWebOrigin = Contracts.PUBLIC_WEB_ORIGIN,
        )

        /** Debug reads the loopback names as one host, so `localhost` matches `127.0.0.1`. */
        private fun comparable(value: String, development: Boolean): String? {
            val origin = WorkspaceAddress.originOf(value) ?: return null
            if (development) {
                for (loopback in listOf("://localhost", "://[::1]")) {
                    if (origin.contains(loopback)) return origin.replace(loopback, "://127.0.0.1")
                }
            }
            return origin
        }
    }
}

/** What a person types to name a workspace: `<slug>`, a host, or a pasted URL (`StarlingsWorkspaceAddress`). */
object WorkspaceAddress {
    private val slug = Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")

    /**
     * The workspace origin [input] names, or null. A bare slug is
     * `<slug>.<suffix>`. Release takes `https` only; a debug build
     * also takes a loopback or `.local` host over `http`, for the local stack.
     */
    fun origin(input: String, development: Boolean = BuildConfig.DEBUG): String? {
        var value = input.trim().lowercase()
        if (value.isEmpty() || value.any { it.isWhitespace() }) return null
        if (!value.contains("://")) {
            val host = value.substringBefore('/')
            if (!host.contains('.') && !host.contains(':')) {
                if (!slug.matches(host)) return null
                value = "$host.${Contracts.WORKSPACE_HOST_SUFFIX}"
            }
            value = "https://$value"
        }
        val uri = runCatching { URI(value) }.getOrNull() ?: return null
        val scheme = uri.scheme ?: return null
        val host = uri.host?.takeIf { it.isNotEmpty() } ?: return null
        if (uri.rawUserInfo != null) return null
        val local = development && isDevelopmentHost(host)
        when (scheme) {
            "https" -> if (uri.port != -1 && !local) return null
            "http" -> if (!local) return null
            else -> return null
        }
        return if (uri.port != -1) "$scheme://$host:${uri.port}" else "$scheme://$host"
    }

    /** `scheme://host[:port]` of a configured URL, or null. */
    fun originOf(configured: String): String? {
        val uri = runCatching { URI(configured.trim()) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        return if (uri.port != -1) "$scheme://$host:${uri.port}" else "$scheme://$host"
    }

    private fun isDevelopmentHost(host: String) =
        host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "[::1]" || host.endsWith(".local")
}

/** Why a lookup found no workspace (`StarlingsWorkspaceLookupError`). */
class WorkspaceLookupError(val kind: Kind) : Exception(kind.name) {
    enum class Kind { INVALID_ADDRESS, NOT_FOUND, UNREACHABLE, UPDATE_REQUIRED }
}

/**
 * Reads workspace descriptors (`StarlingsWorkspaceDirectory`). The trust
 * rule: a workspace speaks for itself only from its own `web_origin`. When
 * the typed host names another, the descriptor is read again from that
 * origin and must name the same origin.
 */
class WorkspaceDirectory(
    private val online: () -> Boolean = { true },
    private val development: Boolean = BuildConfig.DEBUG,
) {
    private val http = OkHttpClient.Builder().followRedirects(true).callTimeout(10, TimeUnit.SECONDS).build()

    suspend fun lookUp(input: String): StarlingsWorkspace = withContext(Dispatchers.IO) {
        val typed = WorkspaceAddress.origin(input, development) ?: throw WorkspaceLookupError(WorkspaceLookupError.Kind.INVALID_ADDRESS)
        var descriptor = read(typed)
        val canonical = canonicalOrigin(descriptor.webOrigin) ?: throw notFound()
        if (canonical != typed) {
            descriptor = read(canonical)
            if (canonicalOrigin(descriptor.webOrigin) != canonical) throw notFound()
        }
        val workspace = workspace(descriptor, development) ?: throw notFound()
        workspace.copy(linkHosts = verifiedHosts(descriptor))
    }

    /** The descriptor's `public_web_origin` and `aliases` whose own descriptor names the same `web_origin`. */
    private fun verifiedHosts(descriptor: WorkspaceDescriptor): List<String> {
        val web = canonicalOrigin(descriptor.webOrigin) ?: return emptyList()
        val hosts = mutableListOf<String>()
        for (claimed in listOf(descriptor.publicWebOrigin) + descriptor.aliases.orEmpty().take(8)) {
            val origin = canonicalOrigin(claimed) ?: continue
            if (origin == web || origin in hosts) continue
            val answer = runCatching { read(origin) }.getOrNull() ?: continue
            if (canonicalOrigin(answer.webOrigin) == web) hosts.add(origin)
        }
        return hosts
    }

    /** `GET <origin>/.well-known/meet`, strictly decoded. A redirect may only stay on the origin asked. */
    private fun read(origin: String): WorkspaceDescriptor {
        val request = Request.Builder().url(origin + DESCRIPTOR_PATH).header("Accept", "application/json").build()
        val body = try {
            http.newCall(request).execute().use { response ->
                if (response.code != 200 || WorkspaceAddress.originOf(response.request.url.toString()) != origin) throw notFound()
                val bytes = response.body?.bytes() ?: throw notFound()
                if (bytes.size > 64 * 1024) throw notFound()
                bytes.decodeToString()
            }
        } catch (e: WorkspaceLookupError) {
            throw e
        } catch (e: IOException) {
            throw WorkspaceLookupError(if (isUnreachable(e)) WorkspaceLookupError.Kind.UNREACHABLE else WorkspaceLookupError.Kind.NOT_FOUND)
        }
        val descriptor = runCatching { WireJson.decodeFromString(WorkspaceDescriptor.serializer(), body) }.getOrNull()
        if (descriptor == null || descriptor.version != DESCRIPTOR_VERSION) {
            if (asksForUpdate(body)) throw WorkspaceLookupError(WorkspaceLookupError.Kind.UPDATE_REQUIRED)
            throw notFound()
        }
        return descriptor
    }

    /**
     * `StarlingsWorkspaceDirectory.markData`: the bytes of a workspace's mark,
     * on its own origin, PNG or SVG, no larger than an admin may upload. No
     * cookie, no token. Null on any failure: the row draws without it.
     */
    suspend fun markData(workspace: StarlingsWorkspace): ByteArray? = withContext(Dispatchers.IO) {
        val url = workspace.markUrl?.takeIf { WorkspaceAddress.originOf(it) == workspace.webOrigin } ?: return@withContext null
        runCatching {
            val request = Request.Builder().url(url).build()
            http.newCall(request).execute().use { response ->
                val type = response.body?.contentType()?.let { "${it.type}/${it.subtype}" }
                val length = response.body?.contentLength() ?: -1L
                val sameOrigin = WorkspaceAddress.originOf(response.request.url.toString()) == workspace.webOrigin
                if (!sameOrigin || !markAccepted(response.code, type, length)) return@use null
                val bytes = response.body?.byteStream()?.use { input ->
                    val out = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(16 * 1024)
                    while (out.size() <= Contracts.WORKSPACE_MARK_MAX_BYTES) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        out.write(buffer, 0, read)
                    }
                    out.toByteArray()
                } ?: return@use null
                bytes.takeIf { markAccepted(response.code, type, it.size.toLong()) }
            }
        }.getOrNull()
    }

    /** The transport failures that say nothing about the address. A host that does not resolve, on a live network, is an answer. */
    private fun isUnreachable(e: IOException): Boolean =
        !online() || e is ConnectException || e is SocketTimeoutException || e is NoRouteToHostException ||
            e is java.io.InterruptedIOException

    private fun canonicalOrigin(value: String): String? = WorkspaceAddress.originOf(value)?.let { WorkspaceAddress.origin(it, development) }

    private fun notFound() = WorkspaceLookupError(WorkspaceLookupError.Kind.NOT_FOUND)

    companion object {
        /** `workspaceDescriptorPath` in fixtures/shared-constants.json. */
        const val DESCRIPTOR_PATH = "/.well-known/meet"
        const val DESCRIPTOR_VERSION = 1L

        /** A mark answer the app keeps: 200, PNG or SVG, within the upload limit (an unknown length passes until read). */
        fun markAccepted(status: Int, mimeType: String?, length: Long): Boolean =
            status == 200 &&
                mimeType?.lowercase() in setOf("image/png", "image/svg+xml") &&
                length <= Contracts.WORKSPACE_MARK_MAX_BYTES

        /**
         * The workspace a descriptor describes, or null when its origins are
         * not ones this build may talk to. A mark off the workspace's origin
         * is dropped.
         */
        fun workspace(descriptor: WorkspaceDescriptor, development: Boolean = BuildConfig.DEBUG): StarlingsWorkspace? {
            if (descriptor.version != DESCRIPTOR_VERSION) return null
            fun canonical(value: String) = WorkspaceAddress.originOf(value)?.let { WorkspaceAddress.origin(it, development) }
            val web = canonical(descriptor.webOrigin) ?: return null
            val api = canonical(descriptor.apiOrigin) ?: return null
            val name = descriptor.name.trim().takeIf { it.isNotEmpty() } ?: return null
            val mark = descriptor.brand.markUrl?.takeIf { WorkspaceAddress.originOf(it) == web }
            val domains = descriptor.identity.domains.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
            return StarlingsWorkspace(
                webOrigin = web,
                apiOrigin = api,
                name = name.take(80),
                markUrl = mark,
                publicWebOrigin = canonical(descriptor.publicWebOrigin),
                domains = domains,
            )
        }

        /**
         * The handshake for a descriptor this build cannot decode,
         * `StarlingsWorkspaceDirectory.asksForUpdate`: only `version` and
         * `min_client` are read. A newer `version`, or a `min_client.android`
         * floor above [installed], says update.
         */
        fun asksForUpdate(body: String, installed: String = UpdateRecommendation.installedVersion): Boolean {
            val root = runCatching { Json.parseToJsonElement(body).jsonObject }.getOrNull() ?: return false
            val version = runCatching { root["version"]?.jsonPrimitive?.intOrNull }.getOrNull()
            if (version != null && version > DESCRIPTOR_VERSION) return true
            val floor = runCatching { root["min_client"]?.jsonObject?.get("android")?.jsonPrimitive?.contentOrNull }.getOrNull()
            return UpdateRecommendation.isBelow(floor, installed)
        }
    }
}

/** Where the store keeps its rows: preferences on the device, a map in a test. */
interface WorkspacePrefs {
    fun get(key: String): String?
    fun set(key: String, value: String?)
}

/** String rows in one preferences file: `workspaces` for [WorkspaceStore], `update` for [UpdateRecommendation]. */
class SharedWorkspacePrefs(context: Context, name: String = "workspaces") : WorkspacePrefs {
    private val prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE)
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun set(key: String, value: String?) {
        prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
    }
}

/**
 * The current workspace and the ones signed in to on this device
 * (`StarlingsWorkspaceStore`, slice G). No secret in it. [known] is most
 * recent first and always holds [current]. A lookup never adds a row;
 * only [choose] or [enter], after a sign-in, does. Sign-out keeps the row;
 * only [forget] takes it off.
 */
class WorkspaceStore(private val prefs: WorkspacePrefs, private val development: Boolean = BuildConfig.DEBUG) {
    private val _current: MutableStateFlow<StarlingsWorkspace>
    val current: StateFlow<StarlingsWorkspace>
    private val _known: MutableStateFlow<List<StarlingsWorkspace>>
    val known: StateFlow<List<StarlingsWorkspace>>

    init {
        val stored = prefs.get(CURRENT_KEY)?.let { runCatching { json.decodeFromString(StarlingsWorkspace.serializer(), it) }.getOrNull() }
        val restored = stored?.takeIf { it.canSignIn(development) } ?: StarlingsWorkspace.builtIn
        _current = MutableStateFlow(restored)
        current = _current.asStateFlow()
        val list = prefs.get(KNOWN_KEY)?.let { runCatching { json.decodeFromString(listSerializer, it) }.getOrNull() }.orEmpty()
        _known = MutableStateFlow(listing(restored, list.filter { it.canSignIn(development) }))
        known = _known.asStateFlow()
    }

    /**
     * Makes [workspace] this install's workspace. Returns true when the
     * origin moved: everything built for the old one must be built again.
     */
    fun choose(workspace: StarlingsWorkspace): Boolean {
        if (!workspace.canSignIn(development)) return false
        val moved = workspace.webOrigin != _current.value.webOrigin
        _current.value = workspace
        save()
        return moved
    }

    /** [choose], and "You're in <name>" once the runtime for it is built ([takeArrival]). */
    fun enter(workspace: StarlingsWorkspace): Boolean {
        if (!workspace.canSignIn(development)) return false
        prefs.set(ARRIVAL_KEY, workspace.webOrigin)
        return choose(workspace)
    }

    /** The name to announce, once, and only on the workspace it was set for. */
    fun takeArrival(): String? {
        val origin = prefs.get(ARRIVAL_KEY) ?: return null
        prefs.set(ARRIVAL_KEY, null)
        return _current.value.name.takeIf { origin == _current.value.webOrigin }
    }

    /** The first other workspace [hasSession] says is signed in: where a sign-out of the current one moves. */
    fun nextSignedIn(hasSession: (StarlingsWorkspace) -> Boolean): StarlingsWorkspace? =
        _known.value.firstOrNull { it.webOrigin != _current.value.webOrigin && hasSession(it) }

    /** Remove from this device. Never the current workspace: the caller moves first. */
    fun forget(workspace: StarlingsWorkspace) {
        if (workspace.webOrigin == _current.value.webOrigin) return
        _known.value = _known.value.filter { it.webOrigin != workspace.webOrigin }
        saveKnown()
    }

    /** A fresh descriptor read for the current workspace: its name, mark and hosts. */
    fun refresh(fresh: StarlingsWorkspace) {
        val now = _current.value
        if (fresh.webOrigin != now.webOrigin && fresh.apiOrigin != now.apiOrigin) return
        val updated = now.copy(name = fresh.name, markUrl = fresh.markUrl, publicWebOrigin = fresh.publicWebOrigin, linkHosts = fresh.linkHosts, domains = fresh.domains)
        if (updated == now) return
        _current.value = updated
        save()
    }

    /**
     * Keeps [link] for the first runtime built on [workspace]
     * (`StarlingsWorkspaceLink.carry`): the app rebuilds on a change, so the
     * link cannot stay with the screen that received it.
     */
    fun carry(link: String, workspace: StarlingsWorkspace) {
        prefs.set(PENDING_LINK_KEY, json.encodeToString(Pending.serializer(), Pending(link, workspace.webOrigin)))
    }

    /** The carried link, once, and only on the workspace it was carried to. */
    fun takeCarried(): String? {
        val raw = prefs.get(PENDING_LINK_KEY) ?: return null
        prefs.set(PENDING_LINK_KEY, null)
        val pending = runCatching { json.decodeFromString(Pending.serializer(), raw) }.getOrNull() ?: return null
        return pending.link.takeIf { pending.webOrigin == _current.value.webOrigin }
    }

    private fun save() {
        prefs.set(CURRENT_KEY, json.encodeToString(StarlingsWorkspace.serializer(), _current.value))
        _known.value = listing(_current.value, _known.value)
        saveKnown()
    }

    private fun saveKnown() {
        prefs.set(KNOWN_KEY, json.encodeToString(listSerializer, _known.value))
    }

    @Serializable
    private data class Pending(val link: String, val webOrigin: String)

    companion object {
        const val CURRENT_KEY = "meet.workspace.current"
        const val KNOWN_KEY = "meet.workspace.known"
        const val ARRIVAL_KEY = "meet.workspace.arrival"
        const val PENDING_LINK_KEY = "meet.workspace.pendingLink"

        private val json = Json { ignoreUnknownKeys = true }
        private val listSerializer = ListSerializer(StarlingsWorkspace.serializer())

        /** [workspace] first, then every other entry once. */
        private fun listing(workspace: StarlingsWorkspace, list: List<StarlingsWorkspace>) =
            listOf(workspace) + list.filter { it.webOrigin != workspace.webOrigin }
    }
}

/**
 * The active workspace, as `StarlingsWorkspace.active`: what every store,
 * session and request reads its origin from. Only [StarlingsApp] installs
 * the store. Before it does (a JVM test), the build's own workspace.
 */
object Workspaces {
    @Volatile private var store: WorkspaceStore? = null

    fun install(store: WorkspaceStore) {
        this.store = store
    }

    val active: StarlingsWorkspace get() = store?.current?.value ?: StarlingsWorkspace.builtIn
}

/**
 * Which workspace a room or invite link belongs to (`StarlingsWorkspaceLink`,
 * slice F). A link names its workspace by its host. A link for another
 * workspace offers that workspace; a host that names none is refused.
 */
object WorkspaceLinks {
    sealed interface Resolution {
        data object Active : Resolution
        data class Other(val workspace: StarlingsWorkspace) : Resolution
        data object Unknown : Resolution
    }

    /** The `scheme://host[:port]` an `http(s)` link names, or null for typed text (a room name, a `/room/` path). */
    fun origin(input: String): String? {
        val uri = runCatching { URI(input.trim()) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        if (uri.host.isNullOrEmpty()) return null
        return WorkspaceAddress.originOf(input.trim())
    }

    /** True for typed text, or a link on a host of [workspace]. Nothing is read from the network. */
    fun isActive(input: String, workspace: StarlingsWorkspace = Workspaces.active, development: Boolean = BuildConfig.DEBUG): Boolean {
        val origin = origin(input) ?: return true
        return workspace.owns(origin, development)
    }

    /** Where a link belongs. A foreign host is trusted only through its own descriptor. */
    suspend fun resolve(input: String, directory: WorkspaceDirectory, active: StarlingsWorkspace = Workspaces.active): Resolution {
        val origin = origin(input) ?: return Resolution.Active
        if (active.owns(origin)) return Resolution.Active
        val found = runCatching { directory.lookUp(origin) }.getOrNull()?.takeIf { it.canSignIn() } ?: return Resolution.Unknown
        return if (found.webOrigin == active.webOrigin) Resolution.Active else Resolution.Other(found)
    }
}
