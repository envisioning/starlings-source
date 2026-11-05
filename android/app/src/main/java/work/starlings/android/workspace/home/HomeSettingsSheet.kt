package work.starlings.android.workspace.home

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.unit.dp
import work.starlings.android.HomeLayout
import work.starlings.android.HomeModuleSetting
import work.starlings.android.R
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.SheetHeader
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType

/** A module's name and line, from the app's strings (the registry's English is the iOS catalog key). */
object HomeModuleText {
    fun title(id: String): Int = when (id) {
        "messages" -> R.string.home_module_messages
        "work" -> R.string.home_module_work
        "commercial" -> R.string.home_module_commercial
        "notes" -> R.string.home_module_notes
        "agenda" -> R.string.home_module_agenda
        "events" -> R.string.home_module_events
        "room" -> R.string.home_module_room
        else -> R.string.home_module_recent
    }

    fun detail(id: String): Int = when (id) {
        "messages" -> R.string.home_detail_messages
        "work" -> R.string.home_detail_work
        "commercial" -> R.string.home_detail_commercial
        "notes" -> R.string.home_detail_notes
        "agenda" -> R.string.home_detail_agenda
        "events" -> R.string.home_detail_events
        "room" -> R.string.home_detail_room
        else -> R.string.home_detail_recent
    }
}

/**
 * `MobileHomeSettingsView`: what Home is made of, in what order, and how
 * dense the agenda is. Owner-synced: the Mac and the browser draw the same
 * order on their next read. iOS drags a row; Android moves one place with
 * the arrows, `HomeLayout.move`, the same rule. Quick Access never moves.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeSettingsSheet(
    layout: List<HomeModuleSetting>,
    workModules: List<String>?,
    saving: Boolean,
    error: String?,
    followingRows: Int,
    followingLoaded: Boolean,
    save: (List<HomeModuleSetting>) -> Unit,
    setFollowingRows: (Int) -> Unit,
    dismiss: () -> Unit,
) {
    val c = Starlings.colors
    val context = LocalContext.current
    val offered = HomeLayout.offered(layout, workModules)
    ModalBottomSheet(onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = c.canvas) {
        Column(Modifier.navigationBarsPadding()) {
            SheetHeader(stringResource(R.string.home_settings), stringResource(R.string.home_done), dismiss)
            Column(
                Modifier.verticalScroll(rememberScrollState()).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    ListSection(stringResource(R.string.home_modules)) {
                        offered.forEachIndexed { index, row ->
                            val module = HomeLayout.definition(row.id)
                            val title = stringResource(HomeModuleText.title(row.id))
                            ListRow(divider = index < offered.lastIndex) {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Column(Modifier.weight(1f)) {
                                        StarlingsToggle(
                                            title, row.enabled,
                                            { on -> save(layout.map { if (it.id == row.id) it.copy(enabled = on) else it }) },
                                            enabled = module.canHide && !saving,
                                        )
                                        Text(stringResource(HomeModuleText.detail(row.id)), style = StarlingsType.footnote, color = c.secondary)
                                    }
                                    if (row.id != HomeLayout.RECENT) {
                                        val up = HomeLayout.move(layout, row.id, up = true, workModules) != layout
                                        val down = HomeLayout.move(layout, row.id, up = false, workModules) != layout
                                        MoveButton(Icons.Filled.KeyboardArrowUp, context.getString(R.string.home_move_up, title), up && !saving) {
                                            save(HomeLayout.move(layout, row.id, up = true, workModules))
                                        }
                                        MoveButton(Icons.Filled.KeyboardArrowDown, context.getString(R.string.home_move_down, title), down && !saving) {
                                            save(HomeLayout.move(layout, row.id, up = false, workModules))
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Footer(stringResource(R.string.home_modules_footer))
                    Footer(stringResource(R.string.home_room_footer))
                    error?.let { Text(it, Modifier.padding(horizontal = 16.dp), style = StarlingsType.footnote, color = c.danger) }
                }

                Column(Modifier.alpha(if (followingLoaded) 1f else 0.45f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    ListSection(stringResource(R.string.home_module_agenda)) {
                        ListRow { Text(stringResource(R.string.home_following), style = StarlingsType.body, color = c.primary) }
                        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            (0..4).forEach { count ->
                                val label = if (count == 0) stringResource(R.string.home_following_none) else pluralStringResource(R.plurals.home_following_count, count, count)
                                val chosen = count == followingRows
                                Box(
                                    Modifier
                                        .weight(1f)
                                        .clickable(enabled = followingLoaded, role = Role.RadioButton) { setFollowingRows(count) }
                                        .clearAndSetSemantics {
                                            contentDescription = label
                                            role = Role.RadioButton
                                            selected = chosen
                                            if (followingLoaded) onClick { setFollowingRows(count); true }
                                        }
                                        .padding(vertical = 8.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        if (count == 0) label else "$count",
                                        style = StarlingsType.subheadline,
                                        color = if (chosen) c.accent else c.secondary,
                                    )
                                }
                            }
                        }
                    }
                    Footer(stringResource(R.string.home_following_footer))
                }
            }
        }
    }
}

@Composable
private fun MoveButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, enabled: Boolean, action: () -> Unit) {
    val c = Starlings.colors
    Box(
        Modifier
            .size(36.dp)
            .alpha(if (enabled) 1f else 0.3f)
            .clickable(enabled = enabled, role = Role.Button, onClick = action)
            .clearAndSetSemantics { contentDescription = label; role = Role.Button; if (enabled) onClick { action(); true } },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, tint = c.primary)
    }
}

@Composable
private fun Footer(text: String) {
    Text(text, Modifier.padding(horizontal = 16.dp), style = StarlingsType.footnote, color = Starlings.colors.secondary)
}
