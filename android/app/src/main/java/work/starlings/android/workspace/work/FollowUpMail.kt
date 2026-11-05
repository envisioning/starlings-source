package work.starlings.android.workspace.work

import work.starlings.contracts.InboxFollowUpItem

/**
 * `Sources/FollowUpMail.swift` (the web's `follow-up-mail.ts`): the
 * follow-up as a mail draft in the host's own mail app.
 * Starlings sends nothing. A mail link carries about 2,000 characters;
 * past that the body goes to the clipboard and the link carries the
 * recipients and the subject only.
 */
object FollowUpMail {
    const val LINK_MAX = 1_900

    /** A `mailto:` link: each address as written, the subject and the body percent-encoded. */
    fun url(to: List<String>, subject: String, body: String?): String {
        val query = listOf("subject=${WorkRoute.encode(subject)}") + listOfNotNull(body?.let { "body=${WorkRoute.encode(it)}" })
        return "mailto:" + to.joinToString(",") { WorkRoute.encode(it).replace("%40", "@") } + "?" + query.joinToString("&")
    }

    /** The link to open, and whether the body has to travel by clipboard. */
    data class Draft(val url: String, val bodyOnClipboard: Boolean)

    fun draft(to: List<String>, subject: String, body: String): Draft {
        val full = url(to, subject, body)
        return if (full.length <= LINK_MAX) Draft(full, false) else Draft(url(to, subject, null), true)
    }

    /** Approve's split (`MobileFollowUpSheet`): the switched-on tasks are accepted, the rest declined, in the item's order. */
    fun split(item: InboxFollowUpItem, kept: Set<String>): Pair<List<String>, List<String>> {
        val ids = item.tasks.map { it.id }
        return ids.filter { it in kept } to ids.filter { it !in kept }
    }
}
