package work.starlings.android.workspace.team

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PersonPicturesTest {
    @Test
    fun noVersionMeansNoFetch() = runBlocking {
        val pictures = PersonPictures<String>()
        var calls = 0
        assertNull(pictures.picture("a@x.co", null) { calls++; "face" })
        assertEquals(0, calls)
    }

    @Test
    fun theRosterVersionServesAnAddressOnlyCaller() = runBlocking {
        val pictures = PersonPictures<String>()
        pictures.remember(listOf("A@x.co" to 5L))
        assertEquals("face-5", pictures.picture("a@x.co", null) { "face-$it" })
    }

    @Test
    fun oneFetchPerVersionAndMissesAreKept() = runBlocking {
        val pictures = PersonPictures<String>()
        var calls = 0
        repeat(3) { pictures.picture("a@x.co", 1) { calls++; null } }
        assertEquals(1, calls)
        pictures.picture("a@x.co", 2) { calls++; "new" }
        assertEquals(2, calls)
    }

    @Test
    fun concurrentCallersShareOneFetch() = runBlocking {
        val pictures = PersonPictures<String>()
        var calls = 0
        val answers = (1..4).map { async { pictures.picture("a@x.co", 1) { calls++; delay(20); "face" } } }.awaitAll()
        assertEquals(1, calls)
        assertEquals(listOf("face", "face", "face", "face"), answers)
    }

    @Test
    fun forgetDropsTheCachedPicture() = runBlocking {
        val pictures = PersonPictures<String>()
        var calls = 0
        pictures.picture("a@x.co", 1) { calls++; "old" }
        pictures.forget("a@x.co", 1)
        assertEquals("again", pictures.picture("a@x.co", 1) { calls++; "again" })
        assertEquals(2, calls)
    }

    @Test
    fun aRosterWithoutAVersionClearsIt() = runBlocking {
        val pictures = PersonPictures<String>()
        pictures.remember(listOf("a@x.co" to 1L))
        pictures.remember(listOf("a@x.co" to null))
        assertNull(pictures.version("a@x.co"))
    }
}
