package work.starlings.android.workspace.team

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import work.starlings.android.R
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsType
import work.starlings.contracts.PeerWire

/**
 * `iOS/MobileGroupPicker.swift`: choose two or more people, at most
 * [maximum]. At the ceiling the unchosen rows go quiet rather than refuse
 * after the fact.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GroupPicker(candidates: List<PeerWire>, maximum: Int, onDismiss: () -> Unit, onChoose: (List<PeerWire>) -> Unit) {
    var chosen by remember { mutableStateOf(setOf<String>()) }
    val c = Starlings.colors
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = c.canvas) {
        Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
            val close = stringResource(R.string.close)
            Box(
                Modifier
                    .align(Alignment.CenterStart)
                    .size(36.dp)
                    .background(c.elevated, CircleShape)
                    .clickable(onClick = onDismiss)
                    .clearAndSetSemantics { contentDescription = close; role = Role.Button },
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Filled.Close, null, Modifier.size(18.dp), tint = c.primary) }
            Text(stringResource(R.string.team_new_group), Modifier.align(Alignment.Center), style = StarlingsType.headline, color = c.primary)
            val ready = chosen.size >= 2
            Text(
                stringResource(R.string.team_open),
                Modifier
                    .align(Alignment.CenterEnd)
                    .alpha(if (ready) 1f else 0.45f)
                    .background(c.accent, CircleShape)
                    .clickable(enabled = ready, role = Role.Button) {
                        onChoose(candidates.filter { it.email in chosen })
                    }
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                style = StarlingsType.headline,
                color = c.accentInk,
            )
        }
        LazyColumn(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
            item {
                Column(Modifier.fillMaxWidth().background(c.panel, RoundedCornerShape(StarlingsRadius.field))) {
                    if (candidates.isEmpty()) {
                        Text(
                            stringResource(R.string.team_nobody_else),
                            Modifier.padding(16.dp),
                            style = StarlingsType.footnote,
                            color = c.secondary,
                        )
                    }
                    candidates.forEachIndexed { index, peer ->
                        if (index > 0) HorizontalDivider(Modifier.padding(start = 16.dp), thickness = 1.dp, color = c.border)
                        val on = peer.email in chosen
                        val enabled = on || chosen.size < maximum
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .alpha(if (enabled) 1f else 0.45f)
                                .clickable(enabled = enabled) { chosen = if (on) chosen - peer.email else chosen + peer.email }
                                .semantics { selected = on }
                                .padding(horizontal = 16.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(peer.displayName, Modifier.weight(1f), style = StarlingsType.body, color = c.primary)
                            if (on) Icon(Icons.Filled.Check, null, Modifier.size(20.dp), tint = c.accent)
                        }
                    }
                }
                Text(
                    stringResource(R.string.team_group_footer),
                    Modifier.padding(start = 16.dp, top = 6.dp),
                    style = StarlingsType.footnote,
                    color = c.secondary,
                )
            }
        }
    }
}
