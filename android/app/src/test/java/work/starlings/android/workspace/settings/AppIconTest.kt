package work.starlings.android.workspace.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The app icons against iOS: the three choices and their raw values
 * (`MobileAppIconChoice`), the launcher aliases the manifest declares, and
 * the launcher mark against the iOS icons' one symbol.
 */
class AppIconTest {
    private val repo: File
        get() = File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")).parentFile

    @Test
    fun choicesAreIos() {
        val swift = File(repo, "iOS/MobileAppIcon.swift").readText()
        val raws = Regex("case \\w+ = \"([a-z-]+)\"").findAll(swift).map { it.groupValues[1] }.toList()
        assertEquals(raws, AppIconChoice.entries.map { it.raw })
        assertEquals(AppIconChoice.entries.first(), AppIconChoice.DEFAULT)
    }

    @Test
    fun manifestDeclaresOneLauncherAliasPerChoice() {
        val manifest = File(repo, "android/app/src/main/AndroidManifest.xml").readText()
        val aliases = Regex("<activity-alias\\s+android:name=\"([.\\w]+)\"[^>]*?android:enabled=\"(true|false)\"").findAll(manifest)
            .associate { it.groupValues[1] to it.groupValues[2].toBoolean() }
        assertEquals(AppIconChoice.entries.map { it.alias }.toSet(), aliases.keys)
        assertEquals(mapOf(AppIconChoice.DEFAULT.alias to true), aliases.filterValues { it })
    }

    @Test
    fun currentReadsTheEnabledAlias() {
        assertEquals(AppIconChoice.DEFAULT, AppIconChoice.current { null })
        assertEquals(AppIconChoice.BLACK_BACKGROUND_WHITE_MARK, AppIconChoice.current { if (it == AppIconChoice.BLACK_BACKGROUND_WHITE_MARK) true else false })
        // The default alias disabled and nothing else enabled is not a state `set` leaves; read it as the default.
        assertEquals(AppIconChoice.DEFAULT, AppIconChoice.current { false })
    }

    @Test
    fun launcherMarkIsTheIosSymbol() {
        val svg = File(repo, "Resources/starlings.icon/Assets/symbol.svg").readText()
        val circles = Regex("<circle cx=\"([\\d.]+)\" cy=\"([\\d.]+)\" r=\"([\\d.]+)\"/>").findAll(svg)
            .map { m -> m.groupValues.drop(1).map(String::toDouble) }.toList()
        assertEquals(16, circles.size)
        for (color in listOf("black", "lime", "white")) {
            val vector = File(repo, "android/app/src/main/res/drawable/ic_launcher_mark_$color.xml").readText()
            val data = Regex("android:pathData=\"([^\"]+)\"").find(vector)!!.groupValues[1]
            val drawn = Regex("M([\\d.-]+),([\\d.-]+) a([\\d.]+),").findAll(data).map { m -> m.groupValues.drop(1).map(String::toDouble) }.toList()
            assertEquals(circles.size, drawn.size)
            circles.zip(drawn).forEach { (c, d) ->
                val (cx, cy, r) = c
                assertEquals(cx - r, d[0], 1e-3)
                assertEquals(cy, d[1], 1e-3)
                assertEquals(r, d[2], 1e-3)
            }
            assertTrue(vector.contains("android:scaleX=\"30\""))
        }
    }
}
