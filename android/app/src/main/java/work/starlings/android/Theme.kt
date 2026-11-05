package work.starlings.android

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.compose.ui.graphics.Color
import work.starlings.android.ui.LocalStarlingsPalette
import work.starlings.android.ui.StarlingsPalette
import work.starlings.android.ui.StarlingsType

/**
 * The colour roles of `fixtures/color-tokens.json`: every role the iOS app
 * draws, as ARGB, dark then light. `RulesFixtureTest` holds these to the
 * fixture, the way `MobileColorTokensTests` holds iOS. A veil role keeps its
 * alpha, so it tints whatever it sits on.
 */
object StarlingsTokens {
    val roles: Map<String, Pair<Long, Long>> = mapOf(
        "canvas" to Pair(0xFF202128, 0xFFEFEFEF),
        "panel" to Pair(0xFF292A32, 0xFFF6F6F6),
        "elevated" to Pair(0xFF343640, 0xFFFFFFFF),
        "field" to Pair(0xFF1A1B21, 0xFFE4E4E4),
        "ink" to Pair(0xFFFAFAFA, 0xFF1A1A1A),
        "inkMuted" to Pair(0xFFA3A3A3, 0xFF5C5C5C),
        "border" to Pair(0x1ADEE2FF, 0x24000000),
        "borderHover" to Pair(0x33DEE2FF, 0x42000000),
        "hoverLift" to Pair(0x0FDEE2FF, 0x0F000000),
        "selected" to Pair(0xFF3F414D, 0xFFDCDCDC),
        "accent" to Pair(0xFFD6F249, 0xFFAACC00),
        "accentHover" to Pair(0xFFE0F76F, 0xFFBFE000),
        "accentDown" to Pair(0xFFAACC00, 0xFF91AD00),
        "accentMark" to Pair(0xFFD6F249, 0xFFAACC00),
        "onAccent" to Pair(0xFF1A1A1A, 0xFF1A1A1A),
        "danger" to Pair(0xFFFF6361, 0xFFFF6361),
        "presenceBusy" to Pair(0xFF9CBF2E, 0xFF9CBF2E),
        "presenceInMeeting" to Pair(0xFF667C4A, 0xFF667C4A),
    )

    fun color(role: String, dark: Boolean): Color =
        Color(roles.getValue(role).let { if (dark) it.first else it.second })
}

/**
 * Material 3 roles and type drawn from the Starlings tokens; nothing else
 * picks a colour. The screens draw with `Starlings.colors` and
 * `StarlingsType` (ui/Tokens.kt); the Material roles cover what Material
 * itself still draws (menus, the text cursor).
 *
 * Light or dark is Settings › Appearance ([DeviceSettings.appearance]):
 * Auto follows the device, and a new install opens dark, as iOS. The system
 * bars' icons follow the app, not the device.
 */
@Composable
fun StarlingsTheme(content: @Composable () -> Unit) {
    val mode by DeviceSettings.appearance.collectAsState()
    val dark = mode.dark(isSystemInDarkTheme())
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            (view.context as? android.app.Activity)?.window?.let { window ->
                WindowCompat.getInsetsController(window, view).apply {
                    isAppearanceLightStatusBars = !dark
                    isAppearanceLightNavigationBars = !dark
                }
            }
        }
    }
    fun c(role: String) = StarlingsTokens.color(role, dark)
    val scheme = if (dark) darkColorScheme() else lightColorScheme()
    val type = Typography(
        displaySmall = StarlingsType.largeTitle,
        headlineMedium = StarlingsType.title,
        headlineSmall = StarlingsType.title2,
        titleLarge = StarlingsType.title3,
        titleMedium = StarlingsType.headline,
        titleSmall = StarlingsType.subheadline,
        bodyLarge = StarlingsType.body,
        bodyMedium = StarlingsType.callout,
        bodySmall = StarlingsType.footnote,
        labelLarge = StarlingsType.headline,
        labelMedium = StarlingsType.caption,
        labelSmall = StarlingsType.caption2,
    )
    MaterialTheme(
        typography = type,
        colorScheme = scheme.copy(
            background = c("canvas"),
            onBackground = c("ink"),
            surface = c("panel"),
            onSurface = c("ink"),
            surfaceVariant = c("elevated"),
            onSurfaceVariant = c("inkMuted"),
            surfaceContainer = c("elevated"),
            surfaceContainerHigh = c("elevated"),
            secondaryContainer = c("selected"),
            onSecondaryContainer = c("ink"),
            primary = c("accent"),
            onPrimary = c("onAccent"),
            secondary = c("accentMark"),
            onSecondary = c("onAccent"),
            error = c("danger"),
            outline = c("border"),
            outlineVariant = c("border"),
        ),
    ) {
        CompositionLocalProvider(LocalStarlingsPalette provides StarlingsPalette.of(dark), content = content)
    }
}
