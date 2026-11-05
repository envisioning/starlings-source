package work.starlings.android.workspace.work

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.io.File

/** `Sources/CrmIssueImage.swift`'s rules: the cap, the type sent, and the line the body takes. */
class IssueImageTest {
    @Test
    fun theCapIsTheSharedOne() {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        val numbers = Json.parseToJsonElement(File(dir, "shared-constants.json").readText()).jsonObject["numbers"]!!.jsonObject
        assertEquals(numbers["issueImageMaxBytes"]!!.jsonPrimitive.long, IssueImage.MAX_BYTES.toLong())
    }

    @Test
    fun theTypeComesFromTheExtensionThenThePickerThenPng() {
        assertEquals("image/jpeg", IssueImage.contentType("Photo.JPG"))
        assertEquals("image/webp", IssueImage.contentType("a.webp", "image/png"))
        assertEquals("image/jpeg", IssueImage.contentType("picture", "image/jpeg"))
        assertEquals("image/png", IssueImage.contentType("scan.heic", "image/heic"))
        assertEquals("image/png", IssueImage.contentType("screenshot"))
    }

    @Test
    fun theFileNameIsTheAltTextWithoutBrackets() {
        assertEquals("![shot 1.png](https://x/i/1)", IssueImage.markdown("shot [1].png", "https://x/i/1"))
        assertEquals("![a](u)", IssueImage.appending("![a](u)", ""))
        assertEquals("Steps\n\n![a](u)", IssueImage.appending("![a](u)", "Steps"))
    }

    @Test
    fun noEmDashInTheErrors() {
        assertFalse(IssueImage.TOO_LARGE.contains('—'))
    }
}
