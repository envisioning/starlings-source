package work.starlings.android.workspace.team

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

class CaptureFilesTest {
    @Test
    fun aCaptureIsReadOnceThenGone() = runBlocking {
        val file = File.createTempFile("capture", ".m4a").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        assertArrayEquals(byteArrayOf(1, 2, 3), CaptureFiles.take(file))
        assertFalse(file.exists())
    }

    @Test
    fun nothingWrittenIsNothingToSend() = runBlocking {
        val empty = File.createTempFile("capture", ".jpg")
        assertNull(CaptureFiles.take(empty))
        assertFalse(empty.exists())
        assertNull(CaptureFiles.take(File(empty.parentFile, "never-written.jpg")))
    }
}

/** The clip half of iOS `CameraCapture`: ten minutes, high quality, under the attachment cap. */
class CameraClipTest {
    @Test
    fun aClipKeepsTheIosLimitsAndTheCap() {
        assertEquals(600, CameraClip.MAX_SECONDS)
        assertEquals(1, CameraClip.QUALITY_HIGH)
        assertEquals(TeamMedia.ATTACHMENT_MAX_BYTES, CameraClip.MAX_BYTES)
        assertEquals(25L * 1_048_576, CameraClip.MAX_BYTES)
    }

    @Test
    fun aClipGoesAsTheMpeg4TheCameraWrote() {
        val capture = CameraClip.capture(byteArrayOf(9))
        assertEquals("video.mp4", capture.name)
        assertEquals("video/mp4", capture.contentType)
        assertArrayEquals(byteArrayOf(9), capture.data)
        assertNull(capture.width)
        assertNull(capture.height)
    }
}
