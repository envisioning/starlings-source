package work.starlings.android.background

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Photo
import androidx.compose.material.icons.filled.RadioButtonChecked
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import work.starlings.android.CallSession
import work.starlings.android.R
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType

/**
 * The Background menu from the call's More menu, as iOS `MobileCallView`:
 * None, Blur, each generator's entries, the workspace picture, your own
 * picture, then Choose or Replace image and Remove image. The picture comes
 * from the system photo picker, which needs no storage permission.
 */
@Composable
fun BackgroundMenu(call: CallSession, expanded: Boolean, onDismiss: () -> Unit) {
    val c = Starlings.colors
    val effect by call.backgroundEffect.collectAsStateWithLifecycle()
    val hasCustom by call.hasCustomBackground.collectAsStateWithLifecycle()
    val profile by call.workspaceBackgrounds.profile.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<Int?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) scope.launch {
            call.useCustomBackground(uri).onFailure { e ->
                error = (e as? CustomBackgroundStore.Failure)?.messageRes ?: R.string.background_error_unreadable
            }
        }
    }

    DropdownMenu(expanded, onDismiss) {
        @Composable
        fun item(text: String, icon: ImageVector, onClick: () -> Unit) = DropdownMenuItem(
            text = { Text(text, style = StarlingsType.body) },
            leadingIcon = { Icon(icon, null) },
            onClick = { onClick(); onDismiss() },
        )

        @Composable
        fun choice(text: String, value: BackgroundEffect) = item(
            text,
            if (effect == value) Icons.Filled.RadioButtonChecked else Icons.Filled.RadioButtonUnchecked,
        ) { call.setBackgroundEffect(value) }

        choice(stringResource(R.string.background_none), BackgroundEffect.None)
        choice(stringResource(R.string.background_blur), BackgroundEffect.Blur)
        BackgroundGenerator.entries.forEach { generator ->
            val name = stringResource(generator.labelResource)
            Text(name, Modifier.padding(horizontal = 12.dp, vertical = 6.dp), style = StarlingsType.footnote, color = c.secondary)
            BackgroundChoice.all.filter { it.generator == generator }.forEach { entry ->
                val tone = stringResource(BackgroundGalleryRegistry.tonePair(entry.tone, profile).label.resource)
                choice(stringResource(R.string.background_choice, name, tone), BackgroundEffect.Generated(entry))
            }
        }
        if (profile?.imageUrl != null) choice(stringResource(R.string.background_workspace_picture), BackgroundEffect.WorkspaceImage)
        if (hasCustom) choice(stringResource(R.string.background_my_image), BackgroundEffect.CustomImage)
        HorizontalDivider(color = c.border)
        item(
            stringResource(if (hasCustom) R.string.background_replace_image else R.string.background_choose_image),
            Icons.Filled.Photo,
        ) { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
        if (hasCustom) item(stringResource(R.string.background_remove_image), Icons.Filled.Delete) { call.removeCustomBackground() }
    }

    error?.let { message ->
        AlertDialog(
            onDismissRequest = { error = null },
            title = { Text(stringResource(R.string.background_error_title)) },
            text = { Text(stringResource(message)) },
            confirmButton = { TextButton({ error = null }) { Text(stringResource(R.string.cal_ok)) } },
        )
    }
}

private val BackgroundGenerator.labelResource get() = when (this) {
    BackgroundGenerator.PIXEL_FIELD -> R.string.background_pixels
    BackgroundGenerator.FLOCK -> R.string.background_flock
    BackgroundGenerator.GRID -> R.string.background_grid
}

private val ToneLabel.resource get() = when (this) {
    ToneLabel.NIGHT -> R.string.background_tone_night
    ToneLabel.LIME -> R.string.background_tone_lime
    ToneLabel.ICE -> R.string.background_tone_ice
    ToneLabel.DARK -> R.string.background_tone_dark
    ToneLabel.ACCENT -> R.string.background_tone_accent
    ToneLabel.BRIGHT -> R.string.background_tone_bright
}
