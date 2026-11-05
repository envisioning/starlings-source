package work.starlings.android.workspace.settings

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import work.starlings.android.R
import work.starlings.android.StarlingsTokens
import work.starlings.android.ui.GatheringDots
import work.starlings.android.ui.GatheringDotsView
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkErrorNotice

/**
 * `MobileAppIconChoice`: the three iOS app icons. On Android each is a
 * launcher `activity-alias` of `MainActivity` (AndroidManifest.xml) with an
 * adaptive icon drawn from the iOS icons' symbol; exactly one alias is
 * enabled. [raw] is the iOS raw value, [alias] the component that never
 * changes name.
 */
enum class AppIconChoice(val raw: String, val alias: String, val title: Int, val detail: Int) {
    ACCENT_BACKGROUND_BLACK_MARK("accent-background-black-mark", ".IconLime", R.string.app_icon_lime_black, R.string.app_icon_lime_black_detail),
    BLACK_BACKGROUND_ACCENT_MARK("black-background-accent-mark", ".IconGraphiteLime", R.string.app_icon_black_lime, R.string.app_icon_black_lime_detail),
    BLACK_BACKGROUND_WHITE_MARK("black-background-white-mark", ".IconGraphiteWhite", R.string.app_icon_black_white, R.string.app_icon_black_white_detail);

    /** The tile's fill: the accent, or the palette's dark canvas (#202128), as the Icon Composer files. */
    val background: Color get() = when (this) {
        ACCENT_BACKGROUND_BLACK_MARK -> StarlingsTokens.color("accent", dark = true)
        else -> StarlingsTokens.color("canvas", dark = true)
    }

    val mark: Color get() = when (this) {
        ACCENT_BACKGROUND_BLACK_MARK -> Color.Black
        BLACK_BACKGROUND_ACCENT_MARK -> StarlingsTokens.color("accent", dark = true)
        BLACK_BACKGROUND_WHITE_MARK -> Color.White
    }

    fun component(context: Context): ComponentName = ComponentName(context.packageName, context.packageName + alias)

    companion object {
        val DEFAULT = ACCENT_BACKGROUND_BLACK_MARK

        /**
         * The alias the launcher shows: the first one whose state is enabled,
         * the manifest's own default ([DEFAULT]) when none was ever set.
         */
        fun current(enabled: (AppIconChoice) -> Boolean?): AppIconChoice =
            entries.firstOrNull { enabled(it) == true } ?: entries.firstOrNull { enabled(it) == null && it == DEFAULT } ?: DEFAULT

        fun current(context: Context): AppIconChoice {
            val pm = context.packageManager
            return current { choice ->
                when (pm.getComponentEnabledSetting(choice.component(context))) {
                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
                    PackageManager.COMPONENT_ENABLED_STATE_DISABLED -> false
                    else -> null
                }
            }
        }

        /** Enables [choice] first, then disables the rest, so the app always has a launcher entry. */
        fun set(context: Context, choice: AppIconChoice) {
            val pm = context.packageManager
            pm.setComponentEnabledSetting(choice.component(context), PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP)
            entries.filter { it != choice }.forEach {
                pm.setComponentEnabledSetting(it.component(context), PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
            }
        }
    }
}

/** `MobileAppIconSettings`: three tiles, the chosen one lifted and ringed in the accent, then the line under them. */
@Composable
internal fun AppIconSection() {
    val context = LocalContext.current
    var selected by remember { mutableStateOf(AppIconChoice.current(context)) }
    var error by remember { mutableStateOf<String?>(null) }
    val failure = stringResource(R.string.app_icon_failed)
    ListSection(stringResource(R.string.app_icon_section)) {
        ListRow {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                AppIconChoice.entries.forEach { icon ->
                    IconTile(icon, icon == selected, Modifier.weight(1f)) {
                        error = null
                        try {
                            AppIconChoice.set(context, icon)
                            selected = icon
                        } catch (_: RuntimeException) {
                            error = failure
                        }
                    }
                }
            }
            SectionNote(stringResource(R.string.app_icon_footer))
        }
        error?.let { WorkErrorNotice(it) }
    }
}

@Composable
private fun IconTile(icon: AppIconChoice, chosen: Boolean, modifier: Modifier, choose: () -> Unit) {
    val c = Starlings.colors
    val shape = RoundedCornerShape(12.dp)
    val detail = stringResource(icon.detail)
    val label = stringResource(R.string.app_icon_label, detail)
    val selectedText = stringResource(R.string.app_icon_selected)
    Column(
        modifier
            .background(if (chosen) c.elevated else Color.Transparent, shape)
            .border(if (chosen) 2.dp else 1.dp, if (chosen) c.accent else c.border, shape)
            .clickable(enabled = !chosen, role = Role.Button, onClick = choose)
            .clearAndSetSemantics {
                contentDescription = if (chosen) "$label, $selectedText" else label
                role = Role.Button
                selected = chosen
                if (!chosen) onClick { choose(); true }
            }
            .padding(vertical = 10.dp, horizontal = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // The mark spans about half the tile; the corner is the Home Screen ratio (22.37 %).
        val side = 78.dp
        Box(Modifier.size(side).background(icon.background, RoundedCornerShape(side * 0.2237f)), contentAlignment = Alignment.Center) {
            GatheringDotsView(side * 0.49f, icon.mark, GatheringDots.Motion.STILL)
        }
        Text(
            stringResource(icon.title),
            style = StarlingsType.caption.copy(fontWeight = FontWeight.Medium, textAlign = TextAlign.Center),
            color = c.primary,
            maxLines = 2,
        )
    }
}
