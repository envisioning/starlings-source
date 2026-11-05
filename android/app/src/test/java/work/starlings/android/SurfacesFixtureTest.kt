package work.starlings.android

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import work.starlings.android.workspace.MemberSurface
import work.starlings.android.workspace.SurfaceVisibility
import java.io.File

/** The tabs: member-surfaces.json for order and titles, surface-visibility.json for which show. */
class SurfacesFixtureTest {
    private fun fixture(name: String) =
        Json.parseToJsonElement(File(System.getProperty("starlings.fixtures")!!, name).readText()).jsonObject

    @Test
    fun surfaces() {
        val listed = fixture("member-surfaces.json")["surfaces"]!!.jsonArray.map {
            it.jsonObject["id"]!!.jsonPrimitive.content to it.jsonObject["title"]!!.jsonPrimitive.content
        }
        assertEquals(listed, MemberSurface.entries.map { it.id to it.title })
    }

    @Test
    fun visibility() {
        fixture("surface-visibility.json")["cases"]!!.jsonArray.forEach {
            val c = it.jsonObject
            val sources = c["calendarSources"]!!.let { v -> if (v is JsonNull) null else v.jsonPrimitive.boolean }
            assertEquals(
                c["name"]!!.jsonPrimitive.content,
                c["visible"]!!.jsonArray.map { v -> v.jsonPrimitive.content },
                SurfaceVisibility.visible(sources, c["docs"]!!.jsonPrimitive.boolean).map { s -> s.id },
            )
        }
    }
}
