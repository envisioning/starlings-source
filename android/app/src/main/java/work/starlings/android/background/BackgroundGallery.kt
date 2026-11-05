package work.starlings.android.background

import work.starlings.android.ui.GatheringDots
import work.starlings.contracts.WorkspaceBackgroundGeneratedDefault
import work.starlings.contracts.WorkspaceBackgroundImageDefault
import work.starlings.contracts.WorkspaceBackgroundProfile
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * The background gallery, `Sources/BackgroundGallery.swift` and
 * `Sources/Generated/BackgroundGalleryRegistry.swift` in Kotlin. The values
 * come from `packages/contracts/src/background-gallery-values.ts`;
 * `BackgroundGalleryFixtureTest` holds the drawing rule to
 * `fixtures/background-gallery.json`, as the Swift and web suites do.
 * Pure: no Android type, so the JVM tests run it.
 */

/** A gallery tone, in picker order. */
enum class BackgroundTone(val wire: String) {
    DARK("dark"),
    ACCENT("accent"),
    BRIGHT("bright");

    companion object {
        fun from(wire: String): BackgroundTone? = entries.firstOrNull { it.wire == wire }
    }
}

/** A gallery generator, in picker order. */
enum class BackgroundGenerator(val wire: String) {
    PIXEL_FIELD("pixel-field"),
    FLOCK("flock"),
    GRID("grid");

    companion object {
        fun from(wire: String): BackgroundGenerator? = entries.firstOrNull { it.wire == wire }
    }
}

/**
 * The name a tone shows. Envisioning's pinned pair keeps Night, Lime and
 * Ice; a workspace's own colours read as Dark, Accent and Bright.
 */
enum class ToneLabel { NIGHT, LIME, ICE, DARK, ACCENT, BRIGHT }

/** `BackgroundGalleryRegistry.TonePair`: colours are `0xRRGGBB`. */
data class TonePair(val label: ToneLabel, val base: Int, val modules: Int)

object BackgroundGalleryRegistry {
    val envisioningTones: Map<BackgroundTone, TonePair> = mapOf(
        BackgroundTone.DARK to TonePair(ToneLabel.NIGHT, 0x25262E, 0x656877),
        BackgroundTone.ACCENT to TonePair(ToneLabel.LIME, 0xD6F249, 0xABC900),
        BackgroundTone.BRIGHT to TonePair(ToneLabel.ICE, 0xF2F5F9, 0xC8D1DE),
    )

    /** The plate names Meet used before the gallery. */
    val legacyPlateTones: Map<String, BackgroundTone> = mapOf(
        "night" to BackgroundTone.DARK,
        "lime" to BackgroundTone.ACCENT,
        "ice" to BackgroundTone.BRIGHT,
    )

    object FlockField {
        const val PITCH = 112
        const val SIZE = 72
        const val ALPHA_BASE = 0.25
        const val ALPHA_FADE = 0.35
    }

    object GridField {
        const val PITCH = 32
        const val MULTIPLIER_MIN = 0.7
        const val MULTIPLIER_MAX = 1
        const val BAKED_LINES = 80
        const val ALPHA = 0.5
        const val HORIZONTAL_FADE = 0.12
        const val VERTICAL_FADE = 0.18
    }

    object PixelField {
        const val MARGIN_RATIO = 0.08
        const val ORIGIN_RATIO = 0.22
        const val GRID = 33
        const val KEEP_BASE = 0.06
        const val KEEP_FADE = 0.52
        const val ALPHA_BASE = 0.14
        const val ALPHA_FADE = 0.52
    }

    /**
     * `WorkspaceBackgrounds.tonePair`: the workspace's own pair when it set
     * one in valid `#rrggbb`, else Envisioning's pinned pair.
     */
    fun tonePair(tone: BackgroundTone, profile: WorkspaceBackgroundProfile?): TonePair {
        val pinned = envisioningTones.getValue(tone)
        val tones = profile?.tones ?: return pinned
        val (rawBase, rawModules) = when (tone) {
            BackgroundTone.DARK -> tones.dark.base to tones.dark.modules
            BackgroundTone.ACCENT -> tones.accent.base to tones.accent.modules
            BackgroundTone.BRIGHT -> tones.bright.base to tones.bright.modules
        }
        val base = hex(rawBase) ?: return pinned
        val modules = hex(rawModules) ?: return pinned
        if (base == pinned.base && modules == pinned.modules) return pinned
        val label = when (tone) {
            BackgroundTone.DARK -> ToneLabel.DARK
            BackgroundTone.ACCENT -> ToneLabel.ACCENT
            BackgroundTone.BRIGHT -> ToneLabel.BRIGHT
        }
        return TonePair(label, base, modules)
    }

    internal fun hex(value: String): Int? {
        if (value.length != 7 || value[0] != '#') return null
        return value.substring(1).toIntOrNull(16)
    }
}

/** One entry in the gallery: a generator drawn in a tone. */
data class BackgroundChoice(val generator: BackgroundGenerator, val tone: BackgroundTone) {
    /** The entry after this one, or null after the last. */
    val next: BackgroundChoice? get() = all.indexOf(this).let { if (it + 1 < all.size) all[it + 1] else null }

    companion object {
        /** Every entry, generator by generator, each in tone order. */
        val all: List<BackgroundChoice> = BackgroundGenerator.entries.flatMap { g -> BackgroundTone.entries.map { BackgroundChoice(g, it) } }
        val first: BackgroundChoice = all[0]

        /** The pixel-field entry for a pre-gallery plate name or a tone's own name. */
        fun plate(name: String): BackgroundChoice? {
            val lower = name.lowercase()
            val tone = BackgroundGalleryRegistry.legacyPlateTones[lower] ?: BackgroundTone.from(lower) ?: return null
            return BackgroundChoice(BackgroundGenerator.PIXEL_FIELD, tone)
        }
    }
}

/** `MeetingBackgroundEffect`: a choice, never a bitmap, so it compares and stores. */
sealed interface BackgroundEffect {
    data object None : BackgroundEffect
    data object Blur : BackgroundEffect
    data class Generated(val choice: BackgroundChoice) : BackgroundEffect
    /** The picture this device holds ([CustomBackgroundStore]). */
    data object CustomImage : BackgroundEffect
    data object WorkspaceImage : BackgroundEffect

    companion object {
        /** `WorkspaceBackgrounds.encodeChoice`: the device-local preference value iOS stores. */
        fun encode(effect: BackgroundEffect): String = when (effect) {
            None -> "none"
            Blur -> "blur"
            CustomImage -> "personal-image"
            WorkspaceImage -> "workspace-image"
            is Generated -> "generated:${effect.choice.generator.wire}:${effect.choice.tone.wire}"
        }

        fun decode(raw: String): BackgroundEffect? = when (raw) {
            "none" -> None
            "blur" -> Blur
            "personal-image" -> CustomImage
            "workspace-image" -> WorkspaceImage
            else -> {
                val parts = raw.split(":")
                val generator = parts.getOrNull(1)?.let(BackgroundGenerator::from)
                val tone = parts.getOrNull(2)?.let(BackgroundTone::from)
                if (parts.size == 3 && parts[0] == "generated" && generator != null && tone != null) Generated(BackgroundChoice(generator, tone)) else null
            }
        }

        /** `WorkspaceBackgrounds.select`: an explicit saved choice wins over the workspace default. */
        fun select(saved: String?, profile: WorkspaceBackgroundProfile?): BackgroundEffect {
            saved?.let(::decode)?.let { return it }
            return when (val default = profile?.default) {
                is WorkspaceBackgroundGeneratedDefault -> {
                    val generator = BackgroundGenerator.from(default.generator.value)
                    val tone = BackgroundTone.from(default.tone.value)
                    if (generator != null && tone != null) Generated(BackgroundChoice(generator, tone)) else None
                }
                is WorkspaceBackgroundImageDefault -> WorkspaceImage
                else -> None
            }
        }

        /**
         * `MeetingBackgroundEffect.resolved`: a stored choice for a picture
         * that is gone resolves to None, so no control shows an effect that
         * will not appear.
         */
        fun resolve(effect: BackgroundEffect, hasCustomImage: Boolean, hasWorkspaceImage: Boolean): BackgroundEffect = when {
            effect == WorkspaceImage && !hasWorkspaceImage -> None
            effect == CustomImage && !hasCustomImage -> None
            else -> effect
        }
    }
}

/** One filled rectangle (or dot, for the flock), top-left origin. */
data class GalleryCell(val x: Int, val y: Int, val width: Int, val height: Int, val alpha: Double)

/** `SeededRandom`: Mulberry32, stepped as the contracts module's `seededRandom`. */
class SeededRandom(seed: Int) {
    private var value = seed

    fun next(): Double {
        value += 0x6d2b79f5
        var result = value
        result = (result xor (result ushr 15)) * (result or 1)
        result = result xor (result + (result xor (result ushr 7)) * (result or 61))
        return (result xor (result ushr 14)).toUInt().toDouble() / 4294967296.0
    }
}

/** `HomeGridNoise`: the LCG the grid generator bakes its line strengths with. */
class HomeGridNoise(seed: Int) {
    private var state = seed

    fun next(): Double {
        state = state * 1103515245 + 12345
        return (state ushr 16).toDouble() / 65536.0
    }
}

/** `GalleryField` and `PixelField`, step for step. */
object GalleryField {
    /** `Math.round`: half up, so the negative edges left of the anchor match the web. */
    private fun jsRound(value: Double): Int = floor(value + 0.5).toInt()

    fun cells(generator: BackgroundGenerator, width: Int, height: Int, seed: Int): List<GalleryCell> {
        if (width <= 0 || height <= 0) return emptyList()
        return when (generator) {
            BackgroundGenerator.PIXEL_FIELD -> pixelField(width, height, seed)
            BackgroundGenerator.FLOCK -> flock(width, height, seed)
            BackgroundGenerator.GRID -> grid(width, height, seed)
        }
    }

    fun pixelField(width: Int, height: Int, seed: Int): List<GalleryCell> {
        val f = BackgroundGalleryRegistry.PixelField
        val margin = jsRound(width * f.MARGIN_RATIO)
        val size = jsRound(min(width, height) * f.ORIGIN_RATIO)
        if (size < 1) return emptyList()
        // Bottom-centre, so the field grades up from the bottom.
        val originX = jsRound((width - size).toDouble() / 2)
        val originY = height - margin - size
        val cell = size.toDouble() / f.GRID
        val random = SeededRandom(seed)
        val bottomY = (height - margin).toDouble()
        val maxDistance = max(1.0, bottomY)

        fun edgeX(index: Int) = jsRound(originX + index * cell)
        fun edgeY(index: Int) = jsRound(originY + index * cell)
        val firstColumn = floor(-originX.toDouble() / cell).toInt()
        val lastColumn = ceil((width - originX).toDouble() / cell).toInt()
        val firstRow = floor(-originY.toDouble() / cell).toInt()
        val lastRow = ceil((height - originY).toDouble() / cell).toInt()

        val cells = ArrayList<GalleryCell>()
        for (row in firstRow until lastRow) {
            val y = max(0, edgeY(row))
            val cellHeight = min(height, edgeY(row + 1)) - y
            if (cellHeight <= 0) continue
            for (column in firstColumn until lastColumn) {
                val x = max(0, edgeX(column))
                val cellWidth = min(width, edgeX(column + 1)) - x
                if (cellWidth <= 0) continue
                val distance = max(0.0, bottomY - (y.toDouble() + cellHeight.toDouble() / 2))
                val fade = max(0.0, 1 - distance / maxDistance)
                if (random.next() > f.KEEP_BASE + fade * f.KEEP_FADE) continue
                cells += GalleryCell(x, y, cellWidth, cellHeight, f.ALPHA_BASE + fade * f.ALPHA_FADE)
            }
        }
        return cells
    }

    private fun flock(width: Int, height: Int, seed: Int): List<GalleryCell> {
        val f = BackgroundGalleryRegistry.FlockField
        val random = SeededRandom(seed)
        val scale = f.SIZE.toDouble() / GatheringDots.VIEW_BOX
        val rows = ceil(height.toDouble() / 2 / f.PITCH).toInt()
        val columns = ceil(width.toDouble() / 2 / f.PITCH).toInt()
        val cells = ArrayList<GalleryCell>()
        for (row in -rows..rows) {
            for (column in -columns..columns) {
                val alpha = f.ALPHA_BASE + random.next() * f.ALPHA_FADE
                for (dot in GatheringDots.dots) {
                    val x = jsRound(width.toDouble() / 2 + (column * f.PITCH).toDouble() - f.SIZE.toDouble() / 2 + (dot.x - dot.radius) * scale)
                    val y = jsRound(height.toDouble() / 2 + (row * f.PITCH).toDouble() - f.SIZE.toDouble() / 2 + (dot.y - dot.radius) * scale)
                    val diameter = jsRound(dot.radius * 2 * scale)
                    if (x + diameter <= 0 || y + diameter <= 0 || x >= width || y >= height) continue
                    cells += GalleryCell(x, y, diameter, diameter, alpha)
                }
            }
        }
        return cells
    }

    private fun grid(width: Int, height: Int, seed: Int): List<GalleryCell> {
        val f = BackgroundGalleryRegistry.GridField
        val random = HomeGridNoise(seed)
        fun bake() = List(f.BAKED_LINES) { f.MULTIPLIER_MIN + random.next() * (f.MULTIPLIER_MAX.toDouble() - f.MULTIPLIER_MIN) }
        val columnStrengths = bake()
        val rowStrengths = bake()
        fun fade(p: Double, span: Int, fraction: Double) = min(1.0, max(0.0, min(p, span - p) / (span * fraction)))
        val cells = ArrayList<GalleryCell>()
        for (vertical in listOf(true, false)) {
            val span = if (vertical) width else height
            val length = if (vertical) height else width
            val multipliers = if (vertical) columnStrengths else rowStrengths
            val reach = ceil(span.toDouble() / 2 / f.PITCH).toInt() + 1
            for (index in -reach..reach) {
                val position = jsRound(span.toDouble() / 2 + (index * f.PITCH).toDouble())
                if (position < 0 || position >= span) continue
                val slot = index + f.BAKED_LINES / 2
                val strength = f.ALPHA * (multipliers.getOrNull(slot) ?: 1.0)
                for (offset in 0 until length) {
                    val x = if (vertical) position else offset
                    val y = if (vertical) offset else position
                    cells += GalleryCell(x, y, 1, 1, strength * fade(x + 0.5, width, f.HORIZONTAL_FADE) * fade(y + 0.5, height, f.VERTICAL_FADE))
                }
            }
        }
        return cells
    }
}
