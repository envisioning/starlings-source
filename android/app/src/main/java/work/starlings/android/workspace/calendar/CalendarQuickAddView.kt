package work.starlings.android.workspace.calendar

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.ui.FormSheetBar
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.StarlingsField

/**
 * `MobileCalendarQuickAddView`: one line, then New Event
 * filled in for review. Next sends the sentence; the editor takes over.
 */
@Composable
fun CalendarQuickAddView(store: CalendarStore, onClose: () -> Unit, onSaved: () -> Unit) {
    val scope = rememberCoroutineScope()
    var sentence by remember { mutableStateOf("") }
    var reading by remember { mutableStateOf(false) }
    var prefill by remember { mutableStateOf<QuickAddPrefill?>(null) }
    val focus = remember { FocusRequester() }

    val read = prefill
    if (read != null) {
        CalendarEditor(store, null, null, null, onClose = onClose, onSaved = onSaved, prefill = read)
        return
    }

    fun submit() {
        val typed = sentence.trim()
        if (typed.isEmpty() || reading) return
        reading = true
        scope.launch {
            prefill = store.quickAdd(typed)
            reading = false
        }
    }

    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Column(Modifier.fillMaxSize().imePadding()) {
        FormSheetBar(
            title = stringResource(R.string.cal_quick_add_title),
            closeLabel = stringResource(R.string.cal_close),
            onClose = onClose,
            confirm = stringResource(if (reading) R.string.cal_reading else R.string.cal_next_step),
            confirmEnabled = !reading && sentence.isNotBlank(),
            onConfirm = ::submit,
        )
        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            ListSection(null) {
                ListRow {
                    StarlingsField(
                        sentence,
                        { if (!reading) sentence = it },
                        stringResource(R.string.cal_quick_add_prompt),
                        Modifier.focusRequester(focus),
                        label = stringResource(R.string.cal_quick_add_menu),
                    )
                }
            }
        }
    }
}
