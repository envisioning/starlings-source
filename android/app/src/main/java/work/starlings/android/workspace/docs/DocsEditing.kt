package work.starlings.android.workspace.docs

/** What the editor holds or last saved: the title, the Markdown body and the category. */
data class DocsEditFields(val title: String, val body: String, val category: String?) {
    companion object {
        fun of(document: DocsDocumentDetail) = DocsEditFields(document.title, document.bodyMd.orEmpty(), document.category)
    }
}

/** `DocumentEditorModel.SaveState`. */
sealed interface DocsSaveState {
    data object Clean : DocsSaveState
    data object Dirty : DocsSaveState
    data object Saving : DocsSaveState
    data class Failed(val message: String) : DocsSaveState
}

/**
 * The save rules of DocsUI's `DocumentEditorModel`: which edits are
 * unsaved, what a save sends, and whether a crash draft outranks the body
 * the server answered.
 */
object DocsEditing {
    /** `AUTOSAVE_DELAY`: quiet time before an edit goes to the server. Drafts hit disk at once. */
    const val AUTOSAVE_DELAY_MS = 1_500L

    /** `edited()`: anything differs from what was saved, as typed. */
    fun isDirty(saved: DocsEditFields, current: DocsEditFields): Boolean = current != saved

    /**
     * `save()`: the PATCH for [current] against [saved], carrying the hash
     * that was read; only the fields that changed go, the title trimmed.
     * Null when nothing would change.
     */
    fun update(saved: DocsEditFields, current: DocsEditFields, contentHash: String): DocsUpdateDocument? {
        val title = current.title.trim()
        if (title == saved.title && current.body == saved.body && current.category == saved.category) return null
        return DocsUpdateDocument(
            title = title.takeIf { it != saved.title },
            bodyMd = current.body.takeIf { it != saved.body },
            category = if (current.category != saved.category) DocsUpdateDocument.CategoryChange.to(current.category) else DocsUpdateDocument.CategoryChange.Keep,
            ifContentHash = contentHash,
        )
    }

    /** `load()`: a draft that survived a crash outranks the server body, only when it differs. */
    fun draftWins(draft: String?, serverBody: String?): Boolean = draft != null && draft != serverBody.orEmpty()

    /** The fields a save made true: the title as sent (trimmed), the body and the category. */
    fun savedAfter(current: DocsEditFields): DocsEditFields = current.copy(title = current.title.trim())
}
