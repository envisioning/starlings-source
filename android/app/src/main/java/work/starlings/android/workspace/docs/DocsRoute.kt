package work.starlings.android.workspace.docs

import work.starlings.android.workspace.work.WorkRoute

/**
 * What a web path asks the Docs tab to open, as `readLocation` and the
 * `?new=` effect read it in `web/src/DocsPage.tsx`:
 *
 * - `/docs` is the rail.
 * - `/docs/document/<id>` is one document (its permalink).
 * - `/docs?folder=<id>` is a folder by its Docs id, resolved against the
 *   folder tree, so a rename does not break the link.
 * - `/docs?new=document` opens New document on the rail (the palette's verb).
 */
sealed interface DocsRoute {
    data object Rail : DocsRoute
    data class Document(val id: String) : DocsRoute
    data class Folder(val id: String) : DocsRoute
    data object NewDocument : DocsRoute

    companion object {
        private val DOCUMENT_PATH = Regex("^/docs/document/([^/]+)/?$")

        /** The route a path names, or null when it is not a Docs path. */
        fun parse(route: String): DocsRoute? {
            val noHash = route.substringBefore('#')
            val path = noHash.substringBefore('?')
            val query = noHash.substringAfter('?', "")
            if (!path.equals("/docs", ignoreCase = true) && !path.startsWith("/docs/", ignoreCase = true)) return null
            DOCUMENT_PATH.find(path)?.let { match ->
                return WorkRoute.decode(match.groupValues[1])?.let(::Document) ?: Rail
            }
            val params = query.split('&').filter { it.isNotEmpty() }.associate { part ->
                WorkRoute.decode(part.substringBefore('='), plus = true).orEmpty() to WorkRoute.decode(part.substringAfter('=', ""), plus = true).orEmpty()
            }
            params["folder"]?.trim()?.takeIf { it.isNotEmpty() }?.let { return Folder(it) }
            if (params["new"] == "document") return NewDocument
            return Rail
        }

        /** The folder a [Folder] route names in the tree; null while the tree does not hold it. */
        fun folder(route: Folder, tree: List<DocsFolder>): DocsSelection.Folder? {
            tree.firstOrNull { it.id == route.id }?.let { return DocsSelection.Folder(it.path, it.title) }
            // A path, as `view=folder:<path>` spells one: its last segment is the title.
            if (route.id.startsWith("/")) return DocsSelection.Folder(route.id, route.id.split('/').lastOrNull { it.isNotEmpty() } ?: route.id)
            return null
        }
    }
}
