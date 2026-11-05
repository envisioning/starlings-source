package work.starlings.android.workspace

import work.starlings.contracts.FavoriteRow
import work.starlings.contracts.FavoriteTarget
import work.starlings.contracts.FavoriteTargetKind
import work.starlings.contracts.PeerKindValue
import work.starlings.contracts.PeerWire

/**
 * `FavoriteTargets` (`Sources/CalendarWire.swift`), for every area: what a
 * star on a subject, a task, an issue, a document, a folder, a person, an
 * agent or a conversation names, and whether a stored favorite is that
 * target in the Worker's spelling. Pure, for the JVM tests.
 */
object FavoriteTargets {
    /** Kinds whose ref is a UUID: the Worker stores these lowercased (`favoriteTargetSchema` in packages/contracts/src/favorites.ts). */
    private val uuidKinds = setOf(
        "crm.lead", "crm.project", "crm.partner", "cms.event", "crm.task",
        "docs.document", "docs.folder", "meet.thread",
    )

    /** A CRM subject by its route kind; null for a kind that has no favorite. */
    fun crmSubject(kind: String, id: String): FavoriteTarget? {
        val target = when (kind) {
            "lead" -> FavoriteTargetKind.CRM_LEAD
            "project" -> FavoriteTargetKind.CRM_PROJECT
            "organization" -> FavoriteTargetKind.CRM_PARTNER
            "event" -> FavoriteTargetKind.CMS_EVENT
            else -> return null
        }
        return FavoriteTarget(target, id)
    }

    /** A roster row, by its stable reference; null when the Worker gave none. */
    fun peer(peer: PeerWire): FavoriteTarget? {
        val ref = peer.favoriteRef ?: return null
        return FavoriteTarget(if (peer.kind == PeerKindValue.AGENT) FavoriteTargetKind.MEET_AGENT else FavoriteTargetKind.MEET_PERSON, ref)
    }

    fun thread(threadId: String) = FavoriteTarget(FavoriteTargetKind.MEET_THREAD, threadId)

    fun task(taskId: String) = FavoriteTarget(FavoriteTargetKind.CRM_TASK, taskId)

    /** `owner/repo#number`, lowercased, as `MobileSubjectIssues` spells it. */
    fun issue(owner: String, repo: String, number: Long) =
        FavoriteTarget(FavoriteTargetKind.GITHUB_ISSUE, "${owner.lowercase()}/${repo.lowercase()}#$number")

    fun document(documentId: String) = FavoriteTarget(FavoriteTargetKind.DOCS_DOCUMENT, documentId)

    /** A folder by its stable id, never its path: a rename keeps the star. */
    fun folder(folderId: String) = FavoriteTarget(FavoriteTargetKind.DOCS_FOLDER, folderId)

    /** A row starred with an uppercase id still reads as starred. */
    fun matches(row: FavoriteRow, target: FavoriteTarget): Boolean {
        if (row.kind != target.kind.value) return false
        return if (row.kind in uuidKinds) row.targetRef.equals(target.targetRef, ignoreCase = true) else row.targetRef == target.targetRef
    }

    fun contains(rows: List<FavoriteRow>, target: FavoriteTarget): Boolean = rows.any { matches(it, target) }
}
