package work.starlings.android.share

import java.net.URI

/**
 * What another app shared (`ACTION_SEND`, `text/plain`), read as iOS
 * `SharedPage` reads its item, with no Android in it.
 *
 * iOS takes only a web page (`NSExtensionActivationSupportsWebURLWithMaxCount`)
 * and refuses anything not https. Android apps share a link as text, often
 * with its title around it ("Title https://…"), so an https address with at
 * most one line of other text is a link to save in Docs; that line is its
 * title when the sharing app sent no subject. Any other text is kept as a
 * Quick Note, whole.
 */
object ShareIntake {
    /** `QUICK_NOTE_BODY_MAX_CHARS` (packages/contracts/src/quick-notes.ts): the Worker refuses more. */
    const val NOTE_MAX_CHARS = 5_000

    sealed interface Shared {
        data class Link(val url: String, val title: String) : Shared
        data class Note(val body: String) : Shared
        /** Nothing to keep: no text, or only spaces. */
        data object Empty : Shared
    }

    private val address = Regex("""https://\S+""", RegexOption.IGNORE_CASE)
    private const val TRAILING = ".,;:!?)]}>\"'”’"

    fun read(text: String?, subject: String?): Shared {
        val clean = text?.trim().orEmpty()
        if (clean.isEmpty()) return Shared.Empty
        val found = address.find(clean)
        val url = found?.value?.trimEnd { it in TRAILING }?.takeIf(::isWebAddress)
        if (found != null && url != null) {
            val rest = clean.removeRange(found.range).trim()
            if (!rest.contains('\n') && !rest.contains('\r')) {
                val title = subject?.trim()?.takeIf { it.isNotEmpty() } ?: rest
                return Shared.Link(url, title)
            }
        }
        return Shared.Note(clean.take(NOTE_MAX_CHARS))
    }

    /** The host shown over the fields, as iOS `page.url.host()`. */
    fun host(url: String): String = runCatching { URI(url).host }.getOrNull().orEmpty()

    private fun isWebAddress(candidate: String): Boolean =
        runCatching { URI(candidate) }.getOrNull()?.let { it.scheme.equals("https", true) && !it.host.isNullOrEmpty() } == true
}
