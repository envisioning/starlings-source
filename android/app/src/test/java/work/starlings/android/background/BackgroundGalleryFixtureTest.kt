package work.starlings.android.background

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.WireJson
import work.starlings.contracts.WorkspaceBackgroundProfile
import java.io.File

/**
 * The background gallery's drawing rule (meet#862) against
 * `fixtures/background-gallery.json`, the file Swift
 * (`Tests/BackgroundGalleryFixtureTests.swift`) and the web read too. A
 * failure here is a question about the fixture first.
 */
class BackgroundGalleryFixtureTest {
    private fun fixture(name: String): JsonObject {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        return Json.parseToJsonElement(File(dir, name).readText()).jsonObject
    }

    private val table = fixture("background-gallery.json")

    @Test fun randomMatchesTheContract() {
        table["random"]!!.jsonArray.forEach { row ->
            val o = row.jsonObject
            val seed = o["seed"]!!.jsonPrimitive.long.toInt()
            val random = SeededRandom(seed)
            val expected = o["values"]!!.jsonArray.map { it.jsonPrimitive.double }
            assertEquals("seed $seed", expected, expected.map { random.next() })
        }
    }

    @Test fun pixelCellsMatchTheContract() {
        table["cells"]!!.jsonArray.forEach { check(it.jsonObject, BackgroundGenerator.PIXEL_FIELD) }
    }

    @Test fun newGeneratorsMatchTheContract() {
        table["generatedCells"]!!.jsonArray.forEach { row ->
            val o = row.jsonObject
            check(o, BackgroundGenerator.from(o["generator"]!!.jsonPrimitive.content)!!)
        }
    }

    private fun check(o: JsonObject, generator: BackgroundGenerator) {
        val seed = o["seed"]!!.jsonPrimitive.long.toInt()
        val width = o["width"]!!.jsonPrimitive.int
        val height = o["height"]!!.jsonPrimitive.int
        val name = "${generator.wire} seed ${o["seed"]} ${width}x$height"
        val cells = GalleryField.cells(generator, width, height, seed)
        assertEquals(name, o["count"]!!.jsonPrimitive.int, cells.size)
        assertEquals(name, o["digest"]!!.jsonPrimitive.long, digest(cells))
        val first = o["first"]!!.jsonArray.map {
            val c = it.jsonObject
            GalleryCell(c["x"]!!.jsonPrimitive.int, c["y"]!!.jsonPrimitive.int, c["width"]!!.jsonPrimitive.int, c["height"]!!.jsonPrimitive.int, c["alpha"]!!.jsonPrimitive.double)
        }
        assertEquals(name, first, cells.take(3))
    }

    @Test fun tablesMatchTheContract() {
        assertEquals(table["tones"]!!.jsonArray.map { it.jsonPrimitive.content }, BackgroundTone.entries.map { it.wire })
        assertEquals(table["generators"]!!.jsonArray.map { it.jsonPrimitive.content }, BackgroundGenerator.entries.map { it.wire })
        val tones = table["envisioningTones"]!!.jsonObject
        BackgroundTone.entries.forEach { tone ->
            val t = tones[tone.wire]!!.jsonObject
            val pair = BackgroundGalleryRegistry.envisioningTones.getValue(tone)
            assertEquals(t["label"]!!.jsonPrimitive.content.uppercase(), pair.label.name)
            assertEquals(BackgroundGalleryRegistry.hex(t["base"]!!.jsonPrimitive.content), pair.base)
            assertEquals(BackgroundGalleryRegistry.hex(t["modules"]!!.jsonPrimitive.content), pair.modules)
        }
        assertEquals(
            table["legacyPlateTones"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content },
            BackgroundGalleryRegistry.legacyPlateTones.mapValues { it.value.wire },
        )
        val pixel = table["pixelField"]!!.jsonObject
        with(BackgroundGalleryRegistry.PixelField) {
            assertEquals(listOf(MARGIN_RATIO, ORIGIN_RATIO, GRID.toDouble(), KEEP_BASE, KEEP_FADE, ALPHA_BASE, ALPHA_FADE),
                listOf("marginRatio", "originRatio", "grid", "keepBase", "keepFade", "alphaBase", "alphaFade").map { pixel[it]!!.jsonPrimitive.double })
        }
        val flock = table["flockField"]!!.jsonObject
        with(BackgroundGalleryRegistry.FlockField) {
            assertEquals(listOf(PITCH.toDouble(), SIZE.toDouble(), ALPHA_BASE, ALPHA_FADE),
                listOf("pitch", "size", "alphaBase", "alphaFade").map { flock[it]!!.jsonPrimitive.double })
        }
        val grid = table["gridField"]!!.jsonObject
        with(BackgroundGalleryRegistry.GridField) {
            assertEquals(listOf(PITCH.toDouble(), MULTIPLIER_MIN, MULTIPLIER_MAX.toDouble(), BAKED_LINES.toDouble(), ALPHA, HORIZONTAL_FADE, VERTICAL_FADE),
                listOf("pitch", "multiplierMin", "multiplierMax", "bakedLines", "alpha", "horizontalFade", "verticalFade").map { grid[it]!!.jsonPrimitive.double })
        }
    }

    @Test fun oldPlateNamesReadAsTheSamePlate() {
        assertEquals(BackgroundTone.DARK, BackgroundChoice.plate("night")?.tone)
        assertEquals(BackgroundTone.ACCENT, BackgroundChoice.plate("Lime")?.tone)
        assertEquals(BackgroundTone.BRIGHT, BackgroundChoice.plate("ice")?.tone)
        assertEquals(BackgroundTone.BRIGHT, BackgroundChoice.plate("bright")?.tone)
        assertNull(BackgroundChoice.plate("stars"))
    }

    @Test fun galleryStepsThroughEveryEntryThenStops() {
        val seen = generateSequence(BackgroundChoice.first) { it.next }.toList()
        assertEquals(BackgroundChoice.all, seen)
        assertEquals(9, seen.size)
    }

    @Test fun choicesRoundTripAsIOSStoresThem() {
        val effects = listOf(BackgroundEffect.None, BackgroundEffect.Blur, BackgroundEffect.CustomImage, BackgroundEffect.WorkspaceImage) +
            BackgroundChoice.all.map { BackgroundEffect.Generated(it) }
        effects.forEach { assertEquals(it, BackgroundEffect.decode(BackgroundEffect.encode(it))) }
        assertEquals("generated:pixel-field:dark", BackgroundEffect.encode(BackgroundEffect.Generated(BackgroundChoice.first)))
        assertEquals("personal-image", BackgroundEffect.encode(BackgroundEffect.CustomImage))
        assertNull(BackgroundEffect.decode("generated:stars:dark"))
        assertNull(BackgroundEffect.decode("generated:grid"))
    }

    @Test fun savedChoiceWinsOverTheWorkspaceDefault() {
        val profile = WireJson.decodeFromString(
            WorkspaceBackgroundProfile.serializer(),
            """{"tones":{"dark":{"base":"#000000","modules":"#111111"},"accent":{"base":"#d6f249","modules":"#abc900"},"bright":{"base":"#bad","modules":"#ffffff"}},"default":{"mode":"generated","generator":"grid","tone":"accent"}}""",
        )
        assertEquals(BackgroundEffect.Generated(BackgroundChoice(BackgroundGenerator.GRID, BackgroundTone.ACCENT)), BackgroundEffect.select(null, profile))
        assertEquals(BackgroundEffect.Blur, BackgroundEffect.select("blur", profile))
        assertEquals(BackgroundEffect.None, BackgroundEffect.select(null, null))
        // A workspace pair of its own is Dark/Accent/Bright; the pinned pair keeps its name; a bad hex falls back.
        assertEquals(TonePair(ToneLabel.DARK, 0x000000, 0x111111), BackgroundGalleryRegistry.tonePair(BackgroundTone.DARK, profile))
        assertEquals(ToneLabel.LIME, BackgroundGalleryRegistry.tonePair(BackgroundTone.ACCENT, profile).label)
        assertEquals(BackgroundGalleryRegistry.envisioningTones[BackgroundTone.BRIGHT], BackgroundGalleryRegistry.tonePair(BackgroundTone.BRIGHT, profile))
    }

    @Test fun aChoiceForAMissingPictureResolvesToNone() {
        assertEquals(BackgroundEffect.None, BackgroundEffect.resolve(BackgroundEffect.CustomImage, hasCustomImage = false, hasWorkspaceImage = true))
        assertEquals(BackgroundEffect.None, BackgroundEffect.resolve(BackgroundEffect.WorkspaceImage, hasCustomImage = true, hasWorkspaceImage = false))
        assertEquals(BackgroundEffect.CustomImage, BackgroundEffect.resolve(BackgroundEffect.CustomImage, hasCustomImage = true, hasWorkspaceImage = false))
    }

    @Test fun descriptorRouteAndLimitsMatchTheContracts() {
        val routes = fixture("routes.json")["routes"]!!.jsonArray.map { it.jsonPrimitive.content }.toSet()
        assertTrue("${WorkspaceBackgrounds.DESCRIPTOR_ROUTE} is not in fixtures/routes.json", WorkspaceBackgrounds.DESCRIPTOR_ROUTE in routes)
        val constants = fixture("shared-constants.json")
        assertEquals(constants["strings"]!!.jsonObject["workspaceDescriptorPath"]!!.jsonPrimitive.content, WorkspaceBackgrounds.DESCRIPTOR_PATH)
        val numbers = constants["numbers"]!!.jsonObject
        assertEquals(numbers["workspaceDescriptorVersion"]!!.jsonPrimitive.long, WorkspaceBackgrounds.DESCRIPTOR_VERSION)
        assertEquals(numbers["customBackgroundMaxWidth"]!!.jsonPrimitive.int, CustomBackgroundStore.MAX_WIDTH)
        assertEquals(numbers["customBackgroundMaxHeight"]!!.jsonPrimitive.int, CustomBackgroundStore.MAX_HEIGHT)
        assertEquals(numbers["customBackgroundMaxBytes"]!!.jsonPrimitive.long, CustomBackgroundStore.MAX_BYTES)
    }

    /** The contract's `pixelCellsDigest`: FNV-1a over x, y, width, height and opacity in ten-thousandths, four bytes each, low byte first. */
    private fun digest(cells: List<GalleryCell>): Long {
        var hash = 0x811c9dc5.toInt()
        for (cell in cells) {
            for (value in intArrayOf(cell.x, cell.y, cell.width, cell.height, Math.round(cell.alpha * 10000).toInt())) {
                for (shift in 0 until 32 step 8) {
                    hash = hash xor ((value ushr shift) and 0xFF)
                    hash *= 0x01000193
                }
            }
        }
        return hash.toUInt().toLong()
    }
}
