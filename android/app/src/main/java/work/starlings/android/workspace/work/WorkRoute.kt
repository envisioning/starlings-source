package work.starlings.android.workspace.work

import work.starlings.contracts.CrmSubjectKind
import java.io.ByteArrayOutputStream

/**
 * What a web path asks the Work tab to open, as `workDestinationFromLocation`
 * and `viewFromPath` read it in `web/src/WorkPage.tsx`, over the permalink
 * grammar in `packages/contracts/src/permalinks.ts`:
 *
 * - `/work` is Overview, opened at INBOX; `/work/mine` is Overview at MINE.
 * - `/work/browse` (and the old list segments) is Browse.
 * - `/work/task/<id>`, `/work/<kind>/<id>`, `/work/issue/<owner>/<repo>/<n>`
 *   and `/work/contact/<id>` name one record; `/work/core/<entity>`
 *   (Android's own) is a Core entity's list; `partner` reads as
 *   `organization` (ADR 0006).
 * - The query adds `pane`, `task` and `new` on a subject, and `decision`,
 *   `question` or `followup` on Overview: the INBOX row to open.
 *
 * Android has no `/work/signals` view; it opens Overview.
 */
sealed interface WorkRoute {
    enum class Focus { INBOX, MINE }

    data class Overview(
        val focus: Focus,
        val decisionId: String? = null,
        val questionId: String? = null,
        val followUpId: String? = null,
    ) : WorkRoute

    data object Browse : WorkRoute
    data class Task(val id: String) : WorkRoute
    /** [create] is `?new=`: `task`, `issue` or `document`, the editor to open once (`readWorkDestination`). */
    data class Subject(
        val kind: CrmSubjectKind,
        val id: String,
        val pane: String? = null,
        val taskId: String? = null,
        val create: String? = null,
    ) : WorkRoute
    data class Issue(val owner: String, val repo: String, val number: Long) : WorkRoute {
        /** `owner/repo#n`, the id an issue door carries. */
        val reference: String get() = "$owner/$repo#$number"
    }

    data class Contact(val id: String) : WorkRoute

    /** `WorkDestination.coreEntity`: one Core entity's list, from a Core row of the search sheet (#222). Android's own path. */
    data class CoreEntity(val id: String) : WorkRoute

    companion object {
        private const val MAX_ID_LENGTH = 512
        private val SUBJECT_KINDS = setOf("project", "lead", "organization", "event")
        private val CREATE_KINDS = setOf("task", "issue", "document")
        private val ISSUE_PATH = Regex("^/work/issue/([^/]+)/([^/]+)/(\\d+)/?$")
        private val RECORD_PATH = Regex("^/work/([a-z]+)/([^/]+)/?$")
        private val CORE_PATH = Regex("^/work/core/([^/]+)/?$", RegexOption.IGNORE_CASE)

        /** The route a path names, or null when it is not a Work path at all. */
        fun parse(route: String): WorkRoute? {
            val noHash = route.substringBefore('#')
            val path = noHash.substringBefore('?')
            val query = noHash.substringAfter('?', "")
            val params = query.split('&').filter { it.isNotEmpty() }.associate { part ->
                val key = decode(part.substringBefore('='), plus = true).orEmpty()
                key to decode(part.substringAfter('=', ""), plus = true).orEmpty()
            }
            fun param(name: String): String? = params[name]?.trim()?.takeIf { it.isNotEmpty() }

            if (!path.equals("/work", ignoreCase = true) && !path.startsWith("/work/", ignoreCase = true)) return null

            ISSUE_PATH.find(path)?.let { match ->
                val owner = decode(match.groupValues[1]) ?: return null
                val repo = decode(match.groupValues[2]) ?: return null
                val number = match.groupValues[3].toLongOrNull() ?: return null
                if (owner.any { it == '/' || it == '#' || it.isWhitespace() } || repo.any { it == '/' || it == '#' || it.isWhitespace() }) return null
                return Issue(owner, repo, number)
            }
            CORE_PATH.find(path)?.let { match -> decode(match.groupValues[1])?.let { return CoreEntity(it) } }
            RECORD_PATH.find(path)?.let { match ->
                val kind = CrmSubjectKind.of(match.groupValues[1]).value
                val id = decode(match.groupValues[2])
                if (id != null) {
                    when {
                        kind == "task" -> return Task(id)
                        kind == "contact" -> return Contact(id)
                        kind in SUBJECT_KINDS -> return Subject(CrmSubjectKind.of(kind), id, param("pane"), param("task"), param("new")?.takeIf { it in CREATE_KINDS })
                    }
                }
            }
            val segment = path.replace(Regex("^/work/?", RegexOption.IGNORE_CASE), "").trimEnd('/').lowercase()
            return when (segment) {
                "" -> Overview(Focus.INBOX, param("decision"), param("question"), param("followup"))
                "mine" -> Overview(Focus.MINE)
                "signals" -> Overview(Focus.INBOX)
                else -> Browse
            }
        }

        /** The path a route writes (`writeWorkDestination`), so the stack can be kept as paths. */
        fun path(route: WorkRoute): String = when (route) {
            is Overview -> if (route.focus == Focus.MINE) "/work/mine" else "/work"
            Browse -> "/work/browse"
            is Task -> "/work/task/${encode(route.id)}"
            is Contact -> "/work/contact/${encode(route.id)}"
            is CoreEntity -> "/work/core/${encode(route.id)}"
            is Issue -> "/work/issue/${encode(route.owner)}/${encode(route.repo)}/${route.number}"
            is Subject -> buildString {
                append("/work/${route.kind.value}/${encode(route.id)}")
                val query = listOfNotNull(route.pane?.let { "pane=${encode(it)}" }, route.taskId?.let { "task=${encode(it)}" })
                if (query.isNotEmpty()) append("?").append(query.joinToString("&"))
            }
        }

        /** `decodeURIComponent` for one segment; null for a bad escape, an empty or overlong id, or a control character. */
        internal fun decode(raw: String, plus: Boolean = false): String? {
            val bytes = ByteArrayOutputStream()
            var i = 0
            while (i < raw.length) {
                val ch = raw[i]
                when {
                    ch == '%' -> {
                        val hex = raw.substring(i + 1, minOf(i + 3, raw.length))
                        val value = hex.takeIf { it.length == 2 }?.toIntOrNull(16) ?: return null
                        bytes.write(value)
                        i += 3
                    }
                    plus && ch == '+' -> { bytes.write(' '.code); i++ }
                    else -> { bytes.write(ch.toString().toByteArray(Charsets.UTF_8)); i++ }
                }
            }
            val value = bytes.toString(Charsets.UTF_8.name())
            if (plus) return value
            if (value.isEmpty() || value.length > MAX_ID_LENGTH || value.any { it.code < 0x20 || it.code == 0x7f }) return null
            return value
        }

        /** `encodeURIComponent`. */
        internal fun encode(value: String): String = buildString {
            value.toByteArray(Charsets.UTF_8).forEach { byte ->
                val b = byte.toInt() and 0xff
                val ch = b.toChar()
                if (b < 0x80 && (ch.isLetterOrDigit() || ch in "-_.!~*'()")) append(ch) else append("%%%02X".format(b))
            }
        }
    }
}
