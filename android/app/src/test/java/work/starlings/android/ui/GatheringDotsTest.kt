package work.starlings.android.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The flock against `fixtures/gathering-dots.json`, as the web and Swift draw it. */
class GatheringDotsTest {
    private val fixture = Json.parseToJsonElement(
        File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set"), "gathering-dots.json").readText(),
    ).jsonObject

    @Test
    fun dots() {
        assertEquals(fixture["viewBox"]!!.jsonPrimitive.double, GatheringDots.VIEW_BOX, 0.0)
        val dots = fixture["dots"]!!.jsonArray.map { it.jsonObject }
        assertEquals(dots.size, GatheringDots.dots.size)
        dots.zip(GatheringDots.dots).forEach { (f, k) ->
            fun d(key: String) = f[key]!!.jsonPrimitive.double
            assertEquals(GatheringDots.Dot(d("x"), d("y"), d("radius"), d("phase"), d("driftPhase"), d("driftFactor")), k)
        }
    }

    @Test
    fun motion() {
        val m = fixture["motion"]!!.jsonObject.mapValues { it.value.jsonPrimitive.double }
        assertEquals(m.getValue("driftSeconds"), GatheringDots.DRIFT_SECONDS, 0.0)
        assertEquals(m.getValue("driftLow"), GatheringDots.DRIFT_LOW, 0.0)
        assertEquals(m.getValue("driftHigh"), GatheringDots.DRIFT_HIGH, 0.0)
        assertEquals(m.getValue("murmurationSeconds"), GatheringDots.Motion.MURMURATION.sweepSeconds!!, 0.0)
        assertEquals(m.getValue("thinkingSeconds"), GatheringDots.Motion.THINKING.sweepSeconds!!, 0.0)
        assertEquals(m.getValue("busySeconds"), GatheringDots.Motion.BUSY.sweepSeconds!!, 0.0)
    }

    /** A sweep moves between the resting radii and never past them; no time is the rest. */
    @Test
    fun sweepStaysInRange() {
        GatheringDots.dots.forEach { dot ->
            (0..240).forEach { step ->
                val r = GatheringDots.radius(dot, GatheringDots.Motion.MURMURATION, step / 20.0)
                assertTrue("radius $r at $step", r in 1.55..2.5)
            }
            assertEquals(dot.radius, GatheringDots.radius(dot, GatheringDots.Motion.MURMURATION, null), 0.0)
        }
    }
}
