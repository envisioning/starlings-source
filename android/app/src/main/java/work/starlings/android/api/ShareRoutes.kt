package work.starlings.android.api

import work.starlings.contracts.QuickNoteCreate
import work.starlings.contracts.QuickNoteResponse
import work.starlings.contracts.QuickNoteSource

/**
 * The share target's one route of its own. A shared link goes through
 * [DocsRoutes.saveLink]; shared text becomes a Quick Note with the device's
 * id and capture time, so a retry from the outbox is still one note
 *. No `QuickNoteSource` names a share, so it is `home`, the
 * Worker's default.
 */
object ShareRoutes {
    fun createQuickNote(body: String, id: String, capturedAt: Long): Route<QuickNoteResponse> = Route(
        "POST", listOf("quick-notes"),
        body = json(QuickNoteCreate.serializer(), QuickNoteCreate(body = body, source = QuickNoteSource.HOME, id = id, capturedAt = capturedAt)),
        answer = Answer.Wire(QuickNoteResponse.serializer()), operation = "Couldn’t save Quick Note",
        writes = listOf(SnapshotWrite.QUICK_NOTE_WRITE),
    )
}
