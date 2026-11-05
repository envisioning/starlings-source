package work.starlings.android.workspace.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import work.starlings.android.AppearanceMode
import work.starlings.android.DeviceSettings
import work.starlings.android.R
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.SegmentedChoice
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType

/**
 * `MobileSettingsView`'s Appearance section: the appearance picker
 * (`EnvisioningAppearancePicker`, segmented) and Grid texture, both on this
 * phone only ([DeviceSettings]).
 */
@Composable
internal fun AppearanceSection() {
    val mode by DeviceSettings.appearance.collectAsState()
    val texture by DeviceSettings.homeTexture.collectAsState()
    val modes = AppearanceMode.entries
    val labels = modes.map { stringResource(appearanceLabel(it)) }
    ListSection(stringResource(R.string.appearance_section)) {
        ListRow {
            SegmentedChoice(labels, modes.indexOf(mode), { DeviceSettings.setAppearance(modes[it]) })
            StarlingsToggle(stringResource(R.string.appearance_grid_texture), texture, DeviceSettings::setHomeTexture)
            SectionNote(stringResource(R.string.appearance_this_phone_only))
        }
    }
}

private fun appearanceLabel(mode: AppearanceMode): Int = when (mode) {
    AppearanceMode.AUTO -> R.string.appearance_auto
    AppearanceMode.LIGHT -> R.string.appearance_light
    AppearanceMode.DARK -> R.string.appearance_dark
}

/** Notifications › Channels: Every channel message (`MessageNotificationPreferences`). */
@Composable
internal fun ChannelsSection() {
    val all by DeviceSettings.allChannelMessages.collectAsState()
    ListSection(stringResource(R.string.notifications_channels)) {
        ListRow {
            StarlingsToggle(stringResource(R.string.notifications_every_channel_message), all, DeviceSettings::setAllChannelMessages)
            SectionNote(stringResource(R.string.notifications_channel_footer))
        }
    }
}

/** A footnote line inside a section's row, as iOS `Text(…).font(.footnote).foregroundStyle(.secondary)`. */
@Composable
internal fun SectionNote(text: String) {
    Text(text, style = StarlingsType.footnote, color = Starlings.colors.secondary)
}

/** The footer under a section, as iOS `Section { } footer: { }`. */
@Composable
internal fun SectionFooter(text: String) {
    Text(text, Modifier.padding(horizontal = 16.dp, vertical = 6.dp), style = StarlingsType.footnote, color = Starlings.colors.secondary)
}

@Composable
internal fun SectionWithFooter(footer: String, content: @Composable () -> Unit) {
    Column {
        content()
        SectionFooter(footer)
    }
}
