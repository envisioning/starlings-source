package work.starlings.android

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.io.File

/**
 * Thread Markdown, mention matching and presence labels, against the shared
 * fixtures. Mirrors `Tests/RuleFixtureTests.swift` and `web/src/rule-fixtures.test.ts`.
 */
class TeamFixtureTest {
    private fun fixture(name: String): JsonObject {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        return Json.parseToJsonElement(File(dir, name).readText()).jsonObject
    }

    private val JsonElement.string get() = jsonPrimitive.content
    private fun JsonElement?.strings(): List<String> = (this as JsonArray).map { it.string }

    /** A block in the fixture's shape: spans list only the marks that are on. */
    private fun wire(block: MarkdownBlock): JsonObject {
        val fields = mutableMapOf<String, JsonElement>()
        fun spans() = JsonArray(block.spans.map { s ->
            val m = mutableMapOf<String, JsonElement>("text" to JsonPrimitive(s.text))
            if (s.bold) m["bold"] = JsonPrimitive(true)
            if (s.italic) m["italic"] = JsonPrimitive(true)
            if (s.strike) m["strike"] = JsonPrimitive(true)
            if (s.code) m["code"] = JsonPrimitive(true)
            s.link?.let { m["link"] = JsonPrimitive(it) }
            JsonObject(m)
        })
        when (val k = block.kind) {
            MarkdownBlockKind.Paragraph -> { fields["kind"] = JsonPrimitive("paragraph"); fields["spans"] = spans() }
            MarkdownBlockKind.Quote -> { fields["kind"] = JsonPrimitive("quote"); fields["spans"] = spans() }
            is MarkdownBlockKind.Heading -> { fields["kind"] = JsonPrimitive("heading"); fields["level"] = JsonPrimitive(k.level); fields["spans"] = spans() }
            is MarkdownBlockKind.Bullet -> { fields["kind"] = JsonPrimitive("bullet"); fields["level"] = JsonPrimitive(k.level); fields["spans"] = spans() }
            is MarkdownBlockKind.Ordered -> {
                fields["kind"] = JsonPrimitive("ordered"); fields["level"] = JsonPrimitive(k.level)
                fields["number"] = JsonPrimitive(k.number); fields["spans"] = spans()
            }
            is MarkdownBlockKind.Code -> { fields["kind"] = JsonPrimitive("code"); fields["text"] = JsonPrimitive(k.text) }
        }
        return JsonObject(fields)
    }

    /** Normalises a fixture block so numbers compare by value. */
    private fun normal(e: JsonElement): JsonElement = when (e) {
        is JsonObject -> JsonObject(e.mapValues { normal(it.value) })
        is JsonArray -> JsonArray(e.map(::normal))
        is JsonPrimitive -> if (!e.isString && e.content.toIntOrNull() != null) JsonPrimitive(e.int) else e
    }

    @Test
    fun threadMarkdown() {
        val table = fixture("thread-markdown.json")
        assertEquals(1, table["version"]!!.jsonPrimitive.int)
        val cases = table["cases"]!!.jsonArray
        assertFalse(cases.isEmpty())
        cases.forEach { raw ->
            val c = raw.jsonObject
            val got = JsonArray(ThreadMarkdown.parse(c["in"]!!.string).map(::wire))
            assertEquals(c["name"]!!.string, normal(c["out"]!!), normal(got))
        }
    }

    @Test
    fun mentionMatching() {
        val table = fixture("mention-matching.json")
        assertEquals(1, table["version"]!!.jsonPrimitive.int)
        val cases = table["cases"]!!.jsonArray
        assertFalse(cases.isEmpty())
        cases.forEach { raw ->
            val c = raw.jsonObject
            assertEquals(c["name"]!!.string, c["mentions"].strings(), MentionMatching.mentions(c["text"]!!.string, c["candidates"].strings()))
        }
    }

    @Test
    fun presenceLabels() {
        val table = fixture("presence-values.json")
        assertEquals(1, table["version"]!!.jsonPrimitive.int)
        fun labels(key: String) = table[key]!!.jsonObject.mapValues { it.value.string }
        assertEquals(labels("statusLabels"), PresenceLabels.status)
        assertEquals(labels("clientLabels"), PresenceLabels.client)
        assertEquals(labels("intentLabels"), PresenceLabels.intent)
    }
}
