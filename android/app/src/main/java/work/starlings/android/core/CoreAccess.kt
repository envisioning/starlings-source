package work.starlings.android.core

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import work.starlings.android.Account
import work.starlings.android.BuildConfig
import work.starlings.android.SealedFile
import work.starlings.android.StarlingsApp
import work.starlings.android.api.CoreRoutes
import work.starlings.android.api.StarlingsApiError
import work.starlings.android.deviceName
import work.starlings.contracts.ControlErrorCodeValue
import java.io.File
import java.time.Instant

/**
 * The token this device holds for Core, as stored: `CoreCredential` in
 * `Sources/CoreAccess.swift`. Stamped with the Starlings API that brokered it
 * and the Core it is for, so a token minted for another Core, or by a local
 * Worker, is never presented to this one.
 */
@Serializable
data class CoreCredential(
    val token: String,
    val scopes: List<String> = emptyList(),
    @SerialName("expires_at") val expiresAt: String,
    val email: String,
    @SerialName("api_endpoint") val apiEndpoint: String,
    @SerialName("core_origin") val coreOrigin: String,
) {
    val expiry: Instant? get() = runCatching { Instant.parse(expiresAt) }.getOrNull()

    /** Renew inside the last week: a token that dies mid-edit is a lost edit. An unreadable expiry renews now. */
    fun expiresSoon(nowMs: Long = System.currentTimeMillis()): Boolean {
        val at = expiry?.toEpochMilli() ?: return true
        return at - nowMs < 7L * 24 * 60 * 60 * 1000
    }

    override fun toString(): String = "CoreCredential(email=$email, expiresAt=$expiresAt)"
}

/**
 * Where the Core token lives: one [SealedFile],
 * `noBackupFilesDir/core/<sha256(api)>.bin`, under a Keystore key of its own
 * (`core-token`). One per workspace, as the Keep token: the file is named by
 * the workspace's API.
 */
class CoreTokenStore(context: Context, private val apiEndpoint: String) {
    private val file = SealedFile(context, "core", SealedFile.nameFor(apiEndpoint), "core-token")

    fun load(coreOrigin: String): CoreCredential? {
        val bytes = file.read() ?: return null
        return runCatching { CoreJson.decodeFromString(CoreCredential.serializer(), String(bytes)) }
            .getOrNull()?.takeIf { it.apiEndpoint == apiEndpoint && it.coreOrigin == coreOrigin }
    }

    fun save(credential: CoreCredential) {
        file.write(CoreJson.encodeToString(CoreCredential.serializer(), credential).toByteArray())
    }

    fun clear() {
        file.delete()
    }
}

/**
 * This device's standing with Core: `CoreSession` in `Sources/CoreAccess.swift`
 * with its phone half, `iOS/MobileCoreAccess.swift`. The token, the registry
 * it unlocks, how many records each entity holds, and the one line to Core
 * every Core screen reads through.
 *
 * Starlings' own Work keeps talking to the Worker. This is the layer beneath:
 * the Core page, its lists and records, Core search, and the
 * subject search in Docs. It talks to Core directly under the same per-entity
 * permissions as Core. Connecting is one act (Connect Core): the Worker
 * proves the owner to Core and Core mints the token. Unlike Keep it does not
 * link by itself; it renews inside the last week, and signing out drops it.
 *
 * Only where the workspace has Core: the descriptor's
 * `services.core` names the origin. Null hides every Core entry and drops the
 * token. Before the descriptor is read, the build's own workspace keeps
 * core-kit's host (`ServerConfig.baseURL`).
 */
class CoreAccess private constructor(private val app: StarlingsApp) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val prefs = app.getSharedPreferences("core", Context.MODE_PRIVATE)

    private val account = app.account
    private val workspace = account.workspace
    private val originKey = workspace.scopedKey(ORIGIN_KEY)
    private val groupsKey = workspace.scopedKey(GROUPS_KEY)
    private val store = CoreTokenStore(app, workspace.apiOrigin)
    private val cacheFile = File(File(app.cacheDir, "core").apply { mkdirs() }, "${SealedFile.nameFor(workspace.apiOrigin)}.json")
    private var foreground: DefaultLifecycleObserver? = null

    private val builtInDefault: String? = BUILT_IN_ORIGIN.takeIf { workspace.isBuiltIn }

    /** The Core this workspace names, or null when it has none. */
    var origin: String? by mutableStateOf(storedOrigin())
        private set

    /** The descriptor's `core_groups`: which record groups Core still holds. Null holds every group. */
    var coreGroups: List<String>? by mutableStateOf(storedGroups())
        private set

    var credential: CoreCredential? by mutableStateOf(null)
        private set

    /** The registry: every entity Core publishes to this account, with its fields, capabilities and access. */
    var contracts: List<CoreEntityContract> by mutableStateOf(emptyList())
        private set

    /** How many records each listed entity holds, by id. Absent until Core answers, never guessed. */
    val recordCounts = mutableStateMapOf<String, Int>()

    var isLoading by mutableStateOf(false)
        private set
    var isLinking by mutableStateOf(false)
        private set
    var errorMessage: String? by mutableStateOf(null)
        private set

    /** Core answered that this address has no Core account: the owner signs in to Core on the web once, then connects. */
    var needsCoreAccount by mutableStateOf(false)
        private set

    val client = CoreClient(baseUrl = { origin?.toHttpUrlOrNull() }, tokenProvider = { credential?.token })

    /** Each entity's records, read once and kept for this run (`CRMCacheStore`'s records, in memory). */
    private val records = mutableMapOf<String, Pair<List<JsonObject>, Long>>()
    private val recordsLock = Mutex()
    private var members: List<CoreMember>? = null
    private var characteristics: Map<String, List<CoreCharacteristicOption>>? = null

    /** True while the workspace has Core. Every Core request and every Core entry checks it. */
    val isAvailable: Boolean get() = origin != null
    val isLinked: Boolean get() = isAvailable && credential != null

    /** `CoreSession.entities`: what Other records lists. A table whose group moved to D1 leaves (#1262). */
    val entities: List<CoreEntityContract> get() = CoreRules.blockEntities(contracts).filter { CoreLinks.holds(it.id, coreGroups) }

    init {
        work.starlings.android.core.ui.CorePictures.directory = File(app.cacheDir, "CRMAvatars")
        credential = origin?.let(store::load)
        if (credential != null) contracts = readCachedContracts()
    }

    fun contract(id: String): CoreEntityContract? = contracts.firstOrNull { it.id == id }

    /** Connect, or reconnect: mint a token for this device through the Worker. */
    suspend fun link() {
        val core = origin ?: return
        if (isLinking) return
        if (account.session.credentials() == null) {
            errorMessage = SIGN_IN_FIRST
            return
        }
        isLinking = true
        errorMessage = null
        needsCoreAccount = false
        try {
            val issued = account.client.call(CoreRoutes.token(deviceName(app)))
            val next = CoreCredential(issued.token, issued.scopes, issued.expiresAt, issued.email, workspace.apiOrigin, core)
            withContext(Dispatchers.IO) { store.save(next) }
            credential = next
            loadContracts(forceRefresh = true)
        } catch (e: CancellationException) {
            throw e
        } catch (e: StarlingsApiError) {
            if ((e as? StarlingsApiError.Service)?.serverCode == ControlErrorCodeValue.CORE_ACCOUNT_MISSING) needsCoreAccount = true
            errorMessage = if (needsCoreAccount) {
                "This address has no records account yet. Sign in once at ${origin.orEmpty().removePrefix("https://")}, then try again."
            } else {
                e.sentence
            }
        } catch (e: Exception) {
            errorMessage = CoreRoutes.TOKEN_OPERATION
        } finally {
            isLinking = false
        }
    }

    /**
     * Forget the token on this device and what it read. The token stays valid
     * until Core revokes it, in Core's own token list.
     */
    fun unlink() {
        store.clear()
        credential = null
        contracts = emptyList()
        recordCounts.clear()
        errorMessage = null
        needsCoreAccount = false
        records.clear()
        members = null
        characteristics = null
        cacheFile.delete()
        work.starlings.android.core.ui.CorePictures.clear()
    }

    /** On foreground and at launch: renews a token inside its last week and fills an empty registry. Quiet. */
    suspend fun refreshIfNeeded() {
        if (!isAvailable) return
        val held = credential ?: return
        val owner = account.session.credentials() ?: return
        // A token for someone else (a sign-in as another person) is dropped.
        if (!held.email.equals(owner.email, ignoreCase = true)) { unlink(); return }
        if (held.expiresSoon()) link() else if (contracts.isEmpty() || recordCounts.isEmpty()) loadContracts()
    }

    /** The cached registry first, then Core's. A stale registry still draws; only an empty one explains itself. */
    suspend fun loadContracts(forceRefresh: Boolean = false) {
        if (!isLinked) return
        isLoading = true
        try {
            if (!forceRefresh && contracts.isEmpty()) contracts = withContext(Dispatchers.IO) { readCachedContracts() }
            val fresh = client.entityContracts()
            contracts = fresh.entities
            errorMessage = null
            withContext(Dispatchers.IO) { writeCachedContracts(fresh.entities) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (contracts.isEmpty()) errorMessage = e.message
        } finally {
            isLoading = false
        }
        loadCounts()
    }

    /** One count per listed entity, all at once. A count that fails stays absent. */
    suspend fun loadCounts() {
        if (!isLinked) return
        val ids = entities.map { it.id }
        val counts = coroutineScope {
            ids.map { id -> async { id to runCatching { client.list(id, limit = 1).second }.getOrNull() } }.awaitAll()
        }
        counts.forEach { (id, count) -> if (count != null) recordCounts[id] = count }
    }

    // MARK: Records (`CRMRepository`)

    /** The kept list, or null; and whether it is younger than five minutes (`recordsAreFresh`). */
    fun cachedRecords(entity: String): Pair<List<JsonObject>, Boolean>? =
        records[entity]?.let { (rows, at) -> rows to (System.currentTimeMillis() - at < FRESH_MS) }

    /** `refreshRecords`: every page of an entity, 200 at a time, kept for this run. */
    suspend fun refreshRecords(entity: String): List<JsonObject> {
        val all = mutableListOf<JsonObject>()
        while (true) {
            val (page, count) = client.list(entity, limit = PAGE, offset = all.size)
            all += page
            if (page.isEmpty() || all.size >= count) break
        }
        recordsLock.withLock { records[entity] = all to System.currentTimeMillis() }
        return all
    }

    /** `record(entity:id:)`: live first; the kept row when Core cannot be reached. */
    suspend fun record(entity: String, id: String): JsonObject = try {
        client.get(entity, id).also { merge(entity, it) }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        records[entity]?.first?.firstOrNull { it.coreId == id } ?: throw e
    }

    suspend fun related(entity: String, id: String, relation: String): CoreRelatedData = client.related(entity, id, relation)

    suspend fun save(entity: String, id: String, values: Map<String, JsonElement>): JsonObject =
        client.update(entity, id, values).also { merge(entity, it) }

    /** `save(entity:id: nil)`: a new record, kept at the end of its list. */
    suspend fun create(entity: String, values: Map<String, JsonElement>): JsonObject =
        client.create(entity, values).also { merge(entity, it) }

    /** The members directory, read once per run (`memberOptions`). A failure reads as an empty directory. */
    suspend fun members(): List<CoreMember> {
        members?.let { return it }
        return runCatching { client.members() }.getOrNull()?.also { members = it }.orEmpty()
    }

    /** The characteristics vocabulary, read once per run (`characteristicOptions`). */
    suspend fun characteristics(entity: String): List<CoreCharacteristicOption> {
        val vocabulary = characteristics ?: runCatching { client.characteristics() }.getOrNull()?.also { characteristics = it }
        return vocabulary?.get(entity).orEmpty()
    }

    /**
     * `loadRelationOptions`: an entity's records for a relation picker: the
     * kept list at once, then Core's when it is older than five minutes.
     */
    suspend fun relationOptions(entity: String): List<JsonObject> {
        val kept = cachedRecords(entity)
        if (kept != null && kept.second) return kept.first
        return runCatching { refreshRecords(entity) }.getOrNull() ?: kept?.first.orEmpty()
    }

    suspend fun delete(entity: String, id: String) {
        client.delete(entity, id)
        recordsLock.withLock { records[entity]?.let { (rows, at) -> records[entity] = rows.filterNot { it.coreId == id } to at } }
    }

    suspend fun search(query: String, limit: Int = 8): List<CoreSearchResult> = client.search(query, limit)

    private suspend fun merge(entity: String, record: JsonObject) = recordsLock.withLock {
        val (rows, at) = records[entity] ?: return@withLock
        val index = rows.indexOfFirst { it.coreId == record.coreId }
        records[entity] = (if (index >= 0) rows.toMutableList().also { it[index] = record } else rows + record) to at
    }

    // MARK: Links

    /**
     * `EnvisioningDeployment.coreDashboardURL`: a record's page in Core,
     * `<core>/dashboard/<collection>/<id>`, only while Core still holds that
     * collection's group (`coreHolds`).
     */
    fun dashboardUrl(collection: String, id: String): String? {
        val core = origin ?: return null
        if (!CoreLinks.holds(collection, coreGroups)) return null
        return CoreLinks.dashboard(core, collection, id)
    }

    // MARK: Descriptor

    /** Reads `services.core` and `core_groups`. A failed read keeps what was known. */
    private suspend fun refreshOrigin() {
        val descriptor = withContext(Dispatchers.IO) { runCatching { app.call.workspaceBackgrounds.readDescriptor() }.getOrNull() } ?: return
        val services = descriptor.services
        val next = if (services == null) builtInDefault else services.core?.takeIf { CoreLinks.acceptsOrigin(it, BuildConfig.DEBUG) }
        val groups = services?.coreGroups?.map { it.value }
        prefs.edit().putString(originKey, next ?: NONE).putString(groupsKey, groups?.joinToString(",")).apply()
        coreGroups = groups
        if (next == origin) return
        // Another Core, or none: the token and what it read belong to the old one.
        if (credential != null) unlink()
        origin = next
        credential = next?.let(store::load)
    }

    private fun storedOrigin(): String? = when (val saved = prefs.getString(originKey, null)) {
        null -> builtInDefault
        NONE -> null
        else -> saved
    }

    private fun storedGroups(): List<String>? = prefs.getString(groupsKey, null)?.split(',')?.filter { it.isNotEmpty() }

    private fun readCachedContracts(): List<CoreEntityContract> = runCatching {
        CoreJson.decodeFromString(ListSerializer(CoreEntityContract.serializer()), cacheFile.readText())
    }.getOrDefault(emptyList())

    private fun writeCachedContracts(entities: List<CoreEntityContract>) {
        runCatching { cacheFile.writeText(CoreJson.encodeToString(ListSerializer(CoreEntityContract.serializer()), entities)) }
    }

    private fun start() {
        scope.launch {
            account.account.map { it is Account.SignedIn }.distinctUntilChanged().collect { signedIn ->
                if (signedIn) {
                    refreshOrigin()
                    refreshIfNeeded()
                } else if (credential != null) {
                    // Signing out of Starlings signs out of Core on this device too.
                    unlink()
                } else {
                    store.clear()
                    cacheFile.delete()
                }
            }
        }
        val observer = object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                if (account.account.value is Account.SignedIn) scope.launch {
                    refreshOrigin()
                    refreshIfNeeded()
                }
            }
        }
        foreground = observer
        ProcessLifecycleOwner.get().lifecycle.addObserver(observer)
    }

    private fun stop() {
        foreground?.let { ProcessLifecycleOwner.get().lifecycle.removeObserver(it) }
        foreground = null
        scope.cancel()
    }

    companion object {
        /** core-kit `ServerConfig.productionURL`, the build's own workspace's Core before its descriptor says. */
        const val BUILT_IN_ORIGIN = work.starlings.android.Deployment.CORE_API_ORIGIN
        private const val ORIGIN_KEY = "origin"
        private const val GROUPS_KEY = "groups"
        private const val NONE = "none"
        private const val PAGE = 200
        private const val FRESH_MS = 5 * 60 * 1000L
        private const val SIGN_IN_FIRST = "Sign in to Starlings before connecting records."

        @Volatile private var instance: CoreAccess? = null

        /** Called from `StarlingsApp.onCreate`, so the token renews at launch as on iOS. */
        fun install(app: StarlingsApp) {
            of(app)
        }

        /** A switch of workspace (`StarlingsApp.rebuild`): the next [of] builds Core for the new one. */
        fun reset() {
            synchronized(this) {
                instance?.stop()
                instance = null
            }
        }

        fun of(context: Context): CoreAccess {
            instance?.let { return it }
            val app = context.applicationContext as StarlingsApp
            return synchronized(this) {
                instance ?: CoreAccess(app).also {
                    instance = it
                    it.start()
                }
            }
        }
    }
}

/** The rules behind a Core link (`EnvisioningDeployment.coreDashboardURL`, `Services.coreHolds`). */
object CoreLinks {
    /** `ContractConstants.coreCollectionGroups`, held to `fixtures/shared-constants.json` `maps.coreCollectionGroups`. */
    val collectionGroups: Map<String, String> = mapOf(
        "organizations" to "subjects",
        "contacts" to "subjects",
        "leads" to "subjects",
        "projects" to "subjects",
        "milestones" to "tasks",
        "tasks" to "tasks",
        "goals" to "goals",
        "decisions" to "goals",
        "interactions" to "interactions",
        "offers" to "commercial",
        "licenses" to "commercial",
        "services" to "commercial",
        "policies" to "commercial",
    )

    /** `coreHolds(collection:)`: a collection outside every group, or a descriptor that names no groups, is Core's. */
    fun holds(collection: String, groups: List<String>?): Boolean {
        val group = collectionGroups[collection] ?: return true
        return groups?.contains(group) ?: true
    }

    /** An origin that is not `https` reads as no Core; a loopback one too, outside a debug build (docs/CENTRAL_AUTH.md). */
    fun acceptsOrigin(origin: String, debug: Boolean): Boolean {
        val url = origin.toHttpUrlOrNull() ?: return false
        if (url.isHttps) return true
        return debug && url.host in setOf("localhost", "127.0.0.1", "[::1]", "::1")
    }

    fun dashboard(origin: String, collection: String, id: String): String =
        "${origin.trimEnd('/')}/dashboard/$collection/${segment(id)}"

    /** One path segment, percent-encoded (`encodedPathComponent`). */
    fun segment(value: String): String =
        okhttp3.HttpUrl.Builder().scheme("https").host("x").addPathSegment(value).build().encodedPath.removePrefix("/")

    /** `SubjectKind.coreCollection`: the Core collection a Work subject lives in. */
    fun collection(kind: String): String? = when (kind) {
        "project" -> "projects"
        "lead" -> "leads"
        "organization" -> "organizations"
        "event" -> "events"
        else -> null
    }
}
