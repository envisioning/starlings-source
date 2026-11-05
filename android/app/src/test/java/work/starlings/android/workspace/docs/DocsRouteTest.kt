package work.starlings.android.workspace.docs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import work.starlings.android.workspace.home.HomeLinks

/** [DocsRoute] reads the paths `web/src/DocsPage.tsx` reads and [HomeLinks] writes. */
class DocsRouteTest {
    @Test
    fun pathsParse() {
        assertEquals(DocsRoute.Rail, DocsRoute.parse("/docs"))
        assertEquals(DocsRoute.Document("d/1"), DocsRoute.parse(HomeLinks.document("d/1")))
        assertEquals(DocsRoute.NewDocument, DocsRoute.parse("/docs?new=document"))
        assertEquals(DocsRoute.Folder("f1"), DocsRoute.parse("/docs?folder=f1"))
        assertEquals(DocsRoute.Rail, DocsRoute.parse("/docs/document/%zz"))
        assertNull(DocsRoute.parse("/work"))
    }

    @Test
    fun aFolderResolvesByIdOrPath() {
        val tree = listOf(DocsFolder(id = "f1", path = "/work/notes", slug = "notes", title = "Notes", depth = 1))
        assertEquals(DocsSelection.Folder("/work/notes", "Notes"), DocsRoute.folder(DocsRoute.Folder("f1"), tree))
        assertNull(DocsRoute.folder(DocsRoute.Folder("f2"), tree))
        assertEquals(DocsSelection.Folder("/a/b", "b"), DocsRoute.folder(DocsRoute.Folder("/a/b"), emptyList()))
    }
}
