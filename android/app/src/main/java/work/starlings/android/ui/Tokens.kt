package work.starlings.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import work.starlings.android.StarlingsTokens

/**
 * The corner scale: `EnvisioningRadius` in the envisioning-ui package
 * (`Sources/EnvisioningUI/Radius.swift`). Three rungs, chosen by what the
 * shape is. iOS draws them as continuous corners; Android has no squircle
 * shape, so they are plain rounded corners at the same radius.
 */
object StarlingsRadius {
    /** Typed inputs and other wells. */
    val field = 12.dp
    /** Buttons and anything else a finger acts on. */
    val control = 14.dp
    /** Cards, the stage, the prejoin preview. */
    val card = 18.dp
    /** A stage tile (`MobileVideoTile.cornerRadius` in iOS/MobileCallView.swift). */
    val tile = 16.dp
    /** The self inset over the stage. */
    val selfInset = 12.dp
}

/**
 * The spacing the iOS join and call screens use, by name. There is no shared
 * spacing scale on iOS: each value names the Swift call site it mirrors.
 */
object StarlingsSpacing {
    /** Screen padding of `JoinView.roomEntry` and `prejoin`. */
    val screen = 20.dp
    /** Screen padding of `JoinView.waitingRoom` and `ended`. */
    val screenCentred = 24.dp
    /** Gap between the room entry's blocks (`VStack(spacing: 22)`). */
    val section = 22.dp
    /** Gap between the prejoin's blocks (`VStack(spacing: 18)`). */
    val stack = 18.dp
    /** Between fields, and between the media buttons. */
    val fields = 12.dp
    /** Between a title and the line under it. */
    val titleGap = 8.dp
    /** `StarlingsCard` padding. */
    val card = 16.dp
    /** Gap between call controls, and the stage foot's padding. */
    val controls = 10.dp
    /** `MobileCallView.tileSpacing`: between tiles, and the inset's top clearance. */
    val tile = 12.dp
    /** `meetField`: horizontal padding inside a well. */
    val fieldInset = 14.dp
    /** Call header's horizontal padding. */
    val header = 14.dp
}

/**
 * The control heights the iOS styles set (`StarlingsConcentricDesign.swift`,
 * `StarlingsMobileDesign.swift`, `MobileCallView.swift`).
 */
object StarlingsSize {
    /** `StarlingsFilledButtonStyle` default. */
    val filled = 48.dp
    /** `StarlingsBorderedButtonStyle` default. */
    val bordered = 46.dp
    /** `.compact` on both button styles. */
    val compact = 36.dp
    /** `meetField` minimum height. */
    val field = 48.dp
    /** A call control in the floating row (`callButton`). */
    val callControl = 54.dp
    /** A prejoin media button (`JoinView.mediaButton`). */
    val mediaButton = 62.dp
    /** The audio-route and waiting-room circles in the call header. */
    val headerCircle = 42.dp
    /** `StarlingsToggleStyle` track and thumb. */
    val toggleWidth = 51.dp
    val toggleHeight = 31.dp
    val toggleThumb = 27.dp
}

/**
 * The iOS text styles at the default Dynamic Type size (SF Pro's metrics),
 * which is what every iOS screen here names (`.largeTitle.bold()`,
 * `.headline`, `.caption2`). iOS sets body text in the system face; Android
 * uses its system face (Roboto) at the same sizes and weights. Octa, the
 * one display face, sets only Home's clock, and its TTF is not in this repo.
 * Sizes are `sp`, so they follow the font scale as Dynamic Type does.
 */
object StarlingsType {
    private fun style(size: Int, line: Int, weight: FontWeight = FontWeight.Normal) =
        TextStyle(fontFamily = FontFamily.Default, fontSize = size.sp, lineHeight = line.sp, fontWeight = weight)

    val largeTitle = style(34, 41, FontWeight.Bold)
    val title = style(28, 34)
    val title2 = style(22, 28)
    val title3 = style(20, 25)
    val headline = style(17, 22, FontWeight.SemiBold)
    val body = style(17, 22)
    val callout = style(16, 21)
    val subheadline = style(15, 20)
    val footnote = style(13, 18)
    val caption = style(12, 16)
    val caption2 = style(11, 13)
}

/**
 * Every colour role, resolved for the scheme in force. Names follow
 * `StarlingsMobileColors` (iOS/StarlingsMobileColors.swift); the values are
 * `StarlingsTokens`, which `RulesFixtureTest` holds to the fixture.
 */
@Immutable
data class StarlingsPalette(
    val dark: Boolean,
    val canvas: Color,
    val panel: Color,
    val elevated: Color,
    val field: Color,
    val primary: Color,
    val secondary: Color,
    val border: Color,
    val borderHover: Color,
    val selected: Color,
    val accent: Color,
    val accentPressed: Color,
    val accentMark: Color,
    val accentInk: Color,
    val danger: Color,
) {
    companion object {
        fun of(dark: Boolean): StarlingsPalette {
            fun c(role: String) = StarlingsTokens.color(role, dark)
            return StarlingsPalette(
                dark = dark,
                canvas = c("canvas"),
                panel = c("panel"),
                elevated = c("elevated"),
                field = c("field"),
                primary = c("ink"),
                secondary = c("inkMuted"),
                border = c("border"),
                borderHover = c("borderHover"),
                selected = c("selected"),
                accent = c("accent"),
                accentPressed = c("accentDown"),
                accentMark = c("accentMark"),
                accentInk = c("onAccent"),
                danger = c("danger"),
            )
        }
    }
}

val LocalStarlingsPalette = staticCompositionLocalOf { StarlingsPalette.of(dark = true) }

/** `Starlings.colors.panel`: the palette `StarlingsTheme` provides. */
object Starlings {
    val colors: StarlingsPalette
        @Composable @ReadOnlyComposable get() = LocalStarlingsPalette.current
}
