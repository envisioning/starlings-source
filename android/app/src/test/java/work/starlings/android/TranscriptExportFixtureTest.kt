package work.starlings.android

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** [TranscriptExport] against `fixtures/transcript-export.json`, the file Swift and the web read. */
class TranscriptExportFixtureTest {
    private val fixture: JsonObject by lazy {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        Json.parseToJsonElement(File(dir, "transcript-export.json").readText()).jsonObject
    }

    private fun JsonObject.string(key: String): String? = this[key]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content

    private fun format(name: String) = TranscriptExport.Format.entries.first { it.extension == name }

    @Test
    fun permalinks() {
        fixture["permalinks"]!!.jsonArray.map { it.jsonObject }.forEach { c ->
            assertEquals(c.string("name"), c.string("out"), TranscriptExport.permalink(c.string("origin")!!, c.string("room")!!, c.string("meeting_id")!!))
        }
    }

    @Test
    fun clocks() {
        fixture["clocks"]!!.jsonArray.map { it.jsonObject }.forEach { c ->
            assertEquals(c.string("out"), TranscriptExport.clock(c["ms"]!!.jsonPrimitive.long))
        }
    }

    @Test
    fun fileNames() {
        fixture["file_names"]!!.jsonArray.map { it.jsonObject }.forEach { c ->
            assertEquals(
                c.string("name"), c.string("out"),
                TranscriptExport.fileName(c.string("title")!!, c["started_at"]!!.jsonPrimitive.long, c.string("time_zone"), format(c.string("format")!!)),
            )
        }
    }

    @Test
    fun cases() {
        fixture["cases"]!!.jsonArray.map { it.jsonObject }.forEach { c ->
            val i = c["input"]!!.jsonObject
            val input = TranscriptExport.Input(
                title = i.string("title").orEmpty(),
                startedAt = i["started_at"]!!.jsonPrimitive.long,
                timeZone = i.string("time_zone"),
                subject = i.string("subject"),
                attendees = (i["attendees"] as? JsonArray)?.map { it.jsonPrimitive.content }.orEmpty(),
                link = i.string("link"),
                lines = i["lines"]!!.jsonArray.map { it.jsonObject }.map { l ->
                    TranscriptExport.Line(l.string("id")!!, l.string("speaker_id")!!, l.string("speaker_name").orEmpty(), l["starts_at_ms"]!!.jsonPrimitive.long, l.string("text").orEmpty())
                },
                struck = (i["struck"] as? JsonArray)?.map { it.jsonPrimitive.content }.orEmpty().toSet(),
                renames = (i["renames"] as? JsonObject)?.mapValues { it.value.jsonPrimitive.content }.orEmpty(),
            )
            val name = c.string("name")
            (c["attendees"] as? JsonArray)?.let { assertEquals(name, it.map { a -> a.jsonPrimitive.content }, TranscriptExport.attendees(input)) }
            c.string("md")?.let { assertEquals(name, it, TranscriptExport.format(input, TranscriptExport.Format.MARKDOWN)) }
            c.string("txt")?.let { assertEquals(name, it, TranscriptExport.format(input, TranscriptExport.Format.TEXT)) }
        }
    }
}
