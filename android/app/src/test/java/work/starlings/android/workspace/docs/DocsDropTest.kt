package work.starlings.android.workspace.docs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A drop on the screenshots strip takes images and nothing else, as DocsUI's `DocumentImagesStrip`. */
class DocsDropTest {
    @Test
    fun aDragWithAnyImageTypeIsTaken() {
        assertTrue(DocsDrop.accepts(listOf("text/plain", "image/png")))
        assertTrue(DocsDrop.accepts(setOf("IMAGE/JPEG")))
        assertFalse(DocsDrop.accepts(listOf("text/plain", "application/pdf")))
        assertFalse(DocsDrop.accepts(emptyList()))
    }

    @Test
    fun onlyTheImageItemsAreRead() {
        val types = mapOf("a" to "image/png", "b" to "text/plain", "c" to null, "d" to "image/heic")
        assertEquals(listOf("a", "d"), DocsDrop.imageUris(listOf("a", "b", "c", "d")) { types[it] })
    }
}
