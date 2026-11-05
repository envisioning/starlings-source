package work.starlings.android.workspace.calendar

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.ListFooter
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.contracts.GoogleCalendarListEntry

/**
 * `MobileUpcomingCalendarSelection`: which Google calendars and subscribed
 * feeds feed Upcoming, owner-wide. Only calendars in Starlings are offered:
 * one marked Not in Starlings has no business feeding Upcoming. Save writes
 * both choices and goes back; it waits while a Google list is on screen with
 * nothing picked ("Keep at least one Google calendar enabled for Upcoming.").
 */
@Composable
fun CalendarUpcomingSelection(store: CalendarStore, onSaved: () -> Unit) {
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var loading by remember { mutableStateOf(true) }
    var saving by remember { mutableStateOf(false) }
    var entries by remember { mutableStateOf<List<GoogleCalendarListEntry>>(emptyList()) }
    var selected by remember { mutableStateOf<Set<String>>(emptySet()) }
    var chosenFeeds by remember { mutableStateOf<Set<String>>(emptySet()) }
    LaunchedEffect(store) {
        store.errorMessage = null
        store.refreshSources()
        entries = store.upcomingGoogleEntries().orEmpty()
        selected = entries.filter { it.selected }.map { it.id }.toSet()
        chosenFeeds = store.upcomingSubscriptions.map { it.rawId }.toSet() - store.upcomingExcludedSubscriptionIds
        loading = false
    }
    val feeds = store.upcomingSubscriptions
    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
        store.errorMessage?.let { ListSection(null) { WorkErrorNotice(it) } }
        if (loading) CircularProgressIndicator(Modifier.size(20.dp).align(Alignment.CenterHorizontally), color = c.secondary, strokeWidth = 2.dp)
        if (entries.isNotEmpty()) {
            ListSection(stringResource(R.string.cal_google_calendars)) {
                entries.forEachIndexed { index, entry ->
                    if (index > 0) Divider()
                    CheckRow(entry.summary, if (entry.primary) stringResource(R.string.work_primary) else null, entry.id in selected) {
                        selected = if (entry.id in selected) selected - entry.id else selected + entry.id
                    }
                }
            }
        }
        if (feeds.isNotEmpty()) {
            Column {
                ListSection(CalendarStore.SUBSCRIBED) {
                    feeds.forEachIndexed { index, feed ->
                        if (index > 0) Divider()
                        CheckRow(feed.title, null, feed.rawId in chosenFeeds) {
                            chosenFeeds = if (feed.rawId in chosenFeeds) chosenFeeds - feed.rawId else chosenFeeds + feed.rawId
                        }
                    }
                }
                ListFooter(stringResource(R.string.cal_upcoming_feeds_footer))
            }
        }
        if (!loading) {
            FilledButton(
                stringResource(if (saving) R.string.cal_saving else R.string.cal_save),
                onClick = {
                    saving = true
                    scope.launch {
                        val excluded = feeds.map { it.rawId }.toSet() - chosenFeeds
                        val ok = store.saveUpcoming(if (entries.isEmpty()) null else selected.toList(), excluded)
                        saving = false
                        if (ok) onSaved()
                    }
                },
                enabled = !saving && (entries.isEmpty() || selected.isNotEmpty()),
            )
        }
    }
}

@Composable
private fun CheckRow(title: String, caption: String?, checked: Boolean, onToggle: () -> Unit) {
    val c = Starlings.colors
    val state = stringResource(if (checked) R.string.cal_shown else R.string.cal_hidden)
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onToggle)
            .clearAndSetSemantics { contentDescription = listOfNotNull(title, caption).joinToString(", "); stateDescription = state; role = Role.Button }
            .padding(horizontal = 16.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = StarlingsType.body, color = c.primary)
            caption?.let { Text(it, style = StarlingsType.caption, color = c.secondary) }
        }
        if (checked) Icon(Icons.Filled.Check, null, Modifier.size(18.dp), tint = c.primary)
    }
}

@Composable
private fun Divider() = HorizontalDivider(Modifier.padding(start = 16.dp), thickness = 1.dp, color = Starlings.colors.border)
