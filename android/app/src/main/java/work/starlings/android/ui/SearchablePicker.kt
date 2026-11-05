package work.starlings.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import kotlinx.coroutines.delay
import work.starlings.android.Search

/**
 * One choice in a [SearchablePickerRow] (`StarlingsSearchablePickerOption`):
 * its stable id, the title, and an optional kind word ([context]) and line
 * under it ([subtitle]). The search reads all three.
 */
data class PickerOption(val id: String, val title: String, val context: String? = null, val subtitle: String? = null) {
    /** "Project · Site relaunch", or the title alone. */
    val visibleTitle: String get() = context?.takeIf { it.isNotEmpty() }?.let { "$it · $title" } ?: title

    fun matches(query: String): Boolean =
        query.isBlank() || Search.matches(query, listOfNotNull(title, context).joinToString(" "), subtitle.orEmpty())
}

/**
 * `StarlingsSearchablePicker`: a list row with the label and the current
 * value; a tap opens the choices behind a search field, the one in force
 * checked. [emptyMessage] is said when the search matches nothing.
 */
@Composable
fun SearchablePickerRow(
    label: String,
    placeholder: String,
    options: List<PickerOption>,
    selection: String,
    onPick: (String) -> Unit,
    emptyMessage: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    /** A server search for a typed query, after a quiet beat; the local [options] stay for an empty one. */
    search: (suspend (String) -> List<PickerOption>)? = null,
    /** The open list's search prompt. */
    searchPrompt: String = placeholder,
) {
    val c = Starlings.colors
    var open by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    var remote by remember { mutableStateOf<List<PickerOption>?>(null) }
    var searching by remember { mutableStateOf(false) }
    // A pick from a search answer is still named once the answer is gone.
    var picked by remember { mutableStateOf<PickerOption?>(null) }
    val chosen = options.firstOrNull { it.id == selection } ?: picked?.takeIf { it.id == selection }
    val value = chosen?.visibleTitle ?: selection.ifEmpty { placeholder }
    if (search != null) {
        LaunchedEffect(query, open) {
            if (!open || query.isBlank()) {
                remote = null
                searching = false
                return@LaunchedEffect
            }
            searching = true
            try {
                delay(250)
                remote = search(query)
            } finally {
                searching = false
            }
        }
    }
    Row(
        modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, role = Role.Button) { query = ""; open = true }
            .clearAndSetSemantics { contentDescription = "$label, $value"; role = Role.Button }
            .padding(horizontal = 16.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = StarlingsType.body, color = c.primary)
        Spacer(Modifier.width(12.dp))
        Spacer(Modifier.weight(1f))
        Text(value, style = StarlingsType.body, color = c.secondary, maxLines = 1)
        Icon(Icons.Filled.UnfoldMore, null, Modifier.size(18.dp), tint = c.secondary)
    }
    if (open) {
        Dialog(onDismissRequest = { open = false }) {
            Column(
                Modifier.fillMaxWidth().heightIn(max = 520.dp).background(c.elevated, RoundedCornerShape(18.dp)).padding(vertical = 12.dp),
            ) {
                Text(label, Modifier.padding(horizontal = 16.dp, vertical = 6.dp), style = StarlingsType.headline, color = c.primary)
                Box(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
                    StarlingsField(query, { query = it }, placeholder = searchPrompt)
                }
                val shown = (if (query.isBlank()) options else remote ?: options).filter { it.matches(query) }
                if (searching) {
                    WorkPlaceholderRows()
                } else if (shown.isEmpty()) {
                    Text(emptyMessage, Modifier.padding(horizontal = 16.dp, vertical = 12.dp), style = StarlingsType.footnote, color = c.secondary)
                }
                LazyColumn {
                    items(shown, key = { it.id }) { option ->
                        val isChosen = option.id == selection
                        Row(
                            Modifier.fillMaxWidth().clickable(role = Role.Button) { picked = option; onPick(option.id); open = false }.padding(horizontal = 16.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Box(Modifier.size(20.dp)) { if (isChosen) Icon(Icons.Filled.Check, null, tint = c.primary) }
                            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(option.visibleTitle, style = StarlingsType.body.copy(fontWeight = if (isChosen) FontWeight.SemiBold else FontWeight.Normal), color = c.primary)
                                option.subtitle?.takeIf { it.isNotEmpty() }?.let { Text(it, style = StarlingsType.caption, color = c.secondary) }
                            }
                        }
                    }
                }
            }
        }
    }
}
