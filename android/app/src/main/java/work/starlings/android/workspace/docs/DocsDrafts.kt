package work.starlings.android.workspace.docs

import java.io.File

/**
 * Unsaved editor text on disk per document, as DocsKit's `DocsDraftStore`,
 * so a crash or a process death does not eat an edit. Written on every
 * keystroke the autosave has not sent yet, cleared the moment the server
 * acknowledges the same bytes. One `.md` file per key, the key made safe
 * the way Swift does it (letters, digits and `-` kept, anything else `_`).
 */
class DocsDrafts(private val directory: File) {
    fun read(key: String): String? = runCatching { file(key).takeIf { it.exists() }?.readText() }.getOrNull()

    fun write(key: String, body: String) {
        runCatching {
            directory.mkdirs()
            val target = file(key)
            val temp = File(directory, "${target.name}.tmp")
            temp.writeText(body)
            if (!temp.renameTo(target)) temp.delete()
        }
    }

    fun clear(key: String) {
        runCatching { file(key).delete() }
    }

    private fun file(key: String) = File(directory, safe(key) + ".md")

    companion object {
        fun safe(key: String): String = buildString {
            key.codePoints().forEach { if (Character.isLetterOrDigit(it) || it == '-'.code) appendCodePoint(it) else append('_') }
        }
    }
}
