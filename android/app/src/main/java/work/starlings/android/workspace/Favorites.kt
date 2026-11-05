package work.starlings.android.workspace

import work.starlings.android.ui.ToastTone
import work.starlings.android.ui.toast
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import work.starlings.android.OwnerAccount
import work.starlings.android.R
import work.starlings.android.SearchRow
import work.starlings.android.api.StarlingsApiError
import work.starlings.android.api.TeamMediaRoutes
import work.starlings.android.api.WorkRoutes
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.WorkRowAction
import work.starlings.contracts.FavoriteRow
import work.starlings.contracts.FavoriteTarget
import work.starlings.contracts.SearchRowWire

/**
 * The signed-in session's one set of stars, as `StarlingsAppModel`'s
 * `favorites` and `starredRows` (iOS/StarlingsAppModel.swift): what Team,
 * Docs and Work draw Star or Unstar from, and the rows Home's Quick Access
 * shows. Only this store reads `GET /api/crm/favorites` and
 * `GET /api/crm/starred`, side by side, and only it writes a star.
 *
 * Last known first (docs/CACHING.md): both paint from their snapshots. A
 * read already in flight when a star changes began before the write; its
 * answer is dropped by the revision check, as iOS's `favoritesRevision`.
 */
@Stable
class FavoritesStore(private val account: OwnerAccount) {
    var favorites by mutableStateOf<List<FavoriteRow>>(emptyList())
        private set
    /** QUICK ACCESS: the starred things as search rows, newest star first. */
    var starredRows by mutableStateOf<List<SearchRow>>(emptyList())
        private set
    /** Both reads have answered once (or failed): `favoritesReady`. */
    var ready by mutableStateOf(false)
        private set

    private val client get() = account.client
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var revision = 0
    private var running: Job? = null
    private var painted = false

    fun isFavorite(target: FavoriteTarget): Boolean = FavoriteTargets.contains(favorites, target)

    fun paintSnapshots() {
        if (painted) return
        painted = true
        client.snapshot(WorkRoutes.favorites)?.let { favorites = it.value.favorites }
        client.snapshot(WorkRoutes.starred)?.let { starredRows = rows(it.value.rows) }
    }

    /** `refreshFavorites`: a second caller waits for the read in flight instead of sending its own. */
    suspend fun refresh() {
        running?.let { it.join(); return }
        val job = scope.launch { load() }
        running = job
        try {
            job.join()
        } finally {
            if (running === job) running = null
        }
    }

    /** Star or unstar. Throws the Worker's refusal; the stars are read again after the write either way. */
    suspend fun setFavorite(target: FavoriteTarget, starred: Boolean) {
        revision++
        try {
            if (starred) client.call(TeamMediaRoutes.addFavorite(target)) else client.call(TeamMediaRoutes.removeFavorite(target))
        } finally {
            revision++
            // Past the coalescer: a read in flight began before the write.
            load()
        }
    }

    private suspend fun load() {
        val at = revision
        paintSnapshots()
        val (nextFavorites, nextStarred) = coroutineScope {
            val f = async { attempt { client.call(WorkRoutes.favorites).favorites } }
            val s = async { attempt { client.call(WorkRoutes.starred).rows } }
            f.await() to s.await()
        }
        if (at != revision) return
        nextFavorites?.let { favorites = it }
        nextStarred?.let { starredRows = rows(it) }
        ready = true
    }

    private suspend fun <T> attempt(block: suspend () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (_: StarlingsApiError) {
        null
    }

    private fun rows(rows: List<SearchRowWire>): List<SearchRow> =
        rows.mapNotNull { SearchRow.fromWire(it.kind.value, it.id, it.title, it.subtitle, it.door, it.image) }
}

/** The session's [FavoritesStore], provided by the shell. Null outside a signed-in workspace. */
val LocalFavorites = staticCompositionLocalOf<FavoritesStore?> { null }

/** The app-level store, read once when the workspace opens. Called once, from the shell. */
@Composable
fun rememberFavorites(account: OwnerAccount): FavoritesStore {
    val store = remember(account) { FavoritesStore(account).also { it.paintSnapshots() } }
    LaunchedEffect(store) { store.refresh() }
    return store
}

/** The toggle every control shares: an error says the operation, in English (AGENTS.md). */
@Composable
private fun rememberToggle(): (FavoritesStore, FavoriteTarget, Boolean, () -> Unit) -> Unit {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    return { store, target, starred, done ->
        scope.launch {
            try {
                store.setFavorite(target, starred)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val message = (e as? StarlingsApiError)?.sentence ?: e.message.orEmpty()
                toast(message, ToastTone.DANGER)
            } finally {
                done()
            }
        }
    }
}

/** `MobileFavoriteAction`: Star or Unstar, in a long-press or options menu. Nothing outside a workspace. */
@Composable
fun FavoriteMenuItem(target: FavoriteTarget, dismiss: () -> Unit) {
    val store = LocalFavorites.current ?: return
    val toggle = rememberToggle()
    val starred = store.isFavorite(target)
    DropdownMenuItem(
        text = { Text(stringResource(if (starred) R.string.favorites_unstar else R.string.favorites_star)) },
        leadingIcon = { Icon(if (starred) Icons.Filled.Star else Icons.Filled.StarBorder, null) },
        onClick = { dismiss(); toggle(store, target, !starred) {} },
    )
}

/** `MobileFavoriteButton`: the toolbar's star, labelled for TalkBack, off while the write runs. */
@Composable
fun FavoriteButton(target: FavoriteTarget) {
    val store = LocalFavorites.current ?: return
    val toggle = rememberToggle()
    var working by remember { mutableStateOf(false) }
    val starred = store.isFavorite(target)
    val c = Starlings.colors
    IconButton(
        onClick = { working = true; toggle(store, target, !starred) { working = false } },
        enabled = !working,
    ) {
        Icon(
            if (starred) Icons.Filled.Star else Icons.Filled.StarBorder,
            stringResource(if (starred) R.string.favorites_unstar else R.string.favorites_star),
            tint = c.primary,
        )
    }
}

/** Star or Unstar as one more entry of a Work row menu (`WorkRowMenu`), in its own group. Null outside a workspace. */
@Composable
fun favoriteRowAction(target: FavoriteTarget): WorkRowAction? {
    val store = LocalFavorites.current ?: return null
    val toggle = rememberToggle()
    val starred = store.isFavorite(target)
    val title = stringResource(if (starred) R.string.favorites_unstar else R.string.favorites_star)
    return WorkRowAction(title, startsGroup = true) { toggle(store, target, !starred) {} }
}
