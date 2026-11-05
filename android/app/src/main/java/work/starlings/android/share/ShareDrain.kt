package work.starlings.android.share

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import work.starlings.android.R
import work.starlings.android.StarlingsApp
import work.starlings.android.api.DocsRoutes
import work.starlings.android.api.ShareRoutes
import work.starlings.contracts.DocsCreateDocumentRequest
import java.io.File

/**
 * Sends the share outbox through the owner session. The share sheet sends
 * its item at once; the app sends what is left each time it comes to the
 * front, as iOS drains on becoming active. The pass runs in a scope of its
 * own, so closing the sheet does not cancel a send in flight. One pass at a
 * time.
 */
object ShareDrain {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Mutex()

    /** The signed-in owner's outbox; null when nobody is signed in. */
    fun outbox(app: StarlingsApp): ShareOutbox? {
        val owner = app.account.session.credentials()?.email ?: return null
        return ShareOutbox(File(app.filesDir, "share-outbox"), work.starlings.android.Workspaces.active.webOrigin, owner)
    }

    fun drain(app: StarlingsApp): Deferred<Map<String, ShareOutbox.Outcome>> = scope.async {
        lock.withLock {
            val outbox = outbox(app) ?: return@withLock emptyMap()
            val client = app.account.client
            val message = app.getString(R.string.sharesheet_saved_from)
            outbox.drain { item ->
                when (item.kind) {
                    ShareOutboxItem.Kind.LINK -> client.call(DocsRoutes.saveLink(DocsCreateDocumentRequest(
                        title = item.title,
                        url = item.url,
                        bodyMd = item.note.ifEmpty { null },
                        message = message,
                    )))
                    ShareOutboxItem.Kind.NOTE -> client.call(ShareRoutes.createQuickNote(item.body.orEmpty(), item.id, item.createdAt))
                }
            }
        }
    }
}
