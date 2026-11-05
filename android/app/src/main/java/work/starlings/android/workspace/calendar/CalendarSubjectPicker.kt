package work.starlings.android.workspace.calendar

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.delay
import work.starlings.android.CalEvent
import work.starlings.android.R
import work.starlings.android.ui.ListActionRow
import work.starlings.android.ui.ListFooter
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.SegmentedChoice
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsType
import work.starlings.contracts.CalendarEventSubject
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire

private fun kindLabel(kind: CrmSubjectKind): Int = when (kind) {
    CrmSubjectKind.LEAD -> R.string.cal_lead
    CrmSubjectKind.ORGANIZATION -> R.string.cal_partner
    else -> R.string.cal_project
}

/**
 * The event detail's filing section: Filed under, the way into the subject
 * in Work, and Unfile. Offered on a member Google account's events only; a
 * personal account has no CRM to file to.
 */
@Composable
fun CalendarFilingSection(
    store: CalendarStore,
    event: CalEvent,
    working: Boolean,
    onFile: (CalendarEventSubject?) -> Unit,
    onOpenWork: (String) -> Unit,
) {
    val c = Starlings.colors
    var picking by remember { mutableStateOf(false) }
    val subject = event.subject
    Column {
        ListSection(null) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .alpha(if (working) 0.45f else 1f)
                    .clickable(enabled = !working, role = Role.Button) { picking = true }
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(stringResource(R.string.cal_filed_under), style = StarlingsType.caption, color = c.secondary)
                    Text(
                        subject?.title ?: stringResource(R.string.cal_not_filed),
                        style = StarlingsType.subheadline,
                        color = if (subject == null) c.secondary else c.primary,
                    )
                }
                Icon(Icons.Filled.ChevronRight, null, Modifier.size(18.dp), tint = c.secondary)
            }
            if (subject != null) {
                ListActionRow(
                    stringResource(R.string.cal_open_subject, subject.title),
                    Icons.AutoMirrored.Outlined.ArrowForward,
                    onClick = { onOpenWork(CalendarFiling.workPath(subject)) },
                )
                ListActionRow(stringResource(R.string.cal_unfile), null, onClick = { onFile(null) }, tint = c.danger, enabled = !working)
            }
        }
        // "New meetings use <subject>." has no catalog entry; the general line stays for an unfiled event.
        if (subject == null) ListFooter(stringResource(R.string.cal_filing_footer))
    }
    if (picking) {
        Dialog(onDismissRequest = { picking = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
            CalendarSubjectPicker(store, onClose = { picking = false }) { picked ->
                picking = false
                onFile(picked)
            }
        }
    }
}

/**
 * `MobileSubjectPicker`: the kinds as a segmented choice, a search over
 * Core, one row per match. A beat of quiet before asking, so typing a name
 * is one request rather than one per letter.
 */
@Composable
fun CalendarSubjectPicker(store: CalendarStore, onClose: () -> Unit, onPick: (CalendarEventSubject) -> Unit) {
    val c = Starlings.colors
    val context = LocalContext.current
    var kind by remember { mutableStateOf(CrmSubjectKind.PROJECT) }
    var query by remember { mutableStateOf("") }
    var matches by remember { mutableStateOf<List<CrmSubjectWire>>(emptyList()) }
    var searching by remember { mutableStateOf(true) }
    var first by remember { mutableStateOf(true) }

    LaunchedEffect(kind, query) {
        if (!first) delay(250)
        first = false
        searching = true
        matches = store.searchSubjects(kind, query.trim())
        searching = false
    }

    Column(Modifier.fillMaxSize().background(c.canvas).padding(top = 8.dp).imePadding()) {
        // Close only: a pick is the answer, so there is no confirm.
        val closeLabel = stringResource(R.string.cal_close)
        Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
            Box(
                Modifier
                    .align(Alignment.CenterStart)
                    .size(36.dp)
                    .background(c.elevated, CircleShape)
                    .clickable(role = Role.Button, onClick = onClose)
                    .clearAndSetSemantics { contentDescription = closeLabel; role = Role.Button },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Close, null, Modifier.size(18.dp), tint = c.primary)
            }
            Text(stringResource(R.string.cal_file_under), Modifier.align(Alignment.Center).padding(vertical = 8.dp), style = StarlingsType.headline, color = c.primary)
        }
        Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SegmentedChoice(
                CalendarFiling.kinds.map { context.getString(kindLabel(it)) },
                CalendarFiling.kinds.indexOf(kind),
                onSelect = { kind = CalendarFiling.kinds[it] },
            )
            StarlingsField(query, { query = it }, stringResource(R.string.cal_search))
        }
        LazyColumn(Modifier.fillMaxSize().padding(16.dp)) {
            item {
                ListSection(null) {
                    matches.forEachIndexed { index, match ->
                        Column(
                            Modifier
                                .fillMaxWidth()
                                .clickable(role = Role.Button) { CalendarFiling.subject(match)?.let(onPick) }
                                .padding(horizontal = 16.dp, vertical = 10.dp),
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            Text(match.title, style = StarlingsType.body, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            match.subtitle?.takeIf { it.isNotEmpty() }?.let {
                                Text(it, style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                        if (index < matches.lastIndex) HorizontalDivider(Modifier.padding(start = 16.dp), thickness = 1.dp, color = c.border)
                    }
                    if (searching && matches.isEmpty()) {
                        repeat(3) {
                            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp)) {
                                Text("", Modifier.fillMaxWidth(0.6f).height(14.dp).background(c.field, RoundedCornerShape(StarlingsRadius.field)))
                            }
                        }
                    }
                    if (!searching && matches.isEmpty()) {
                        Text(
                            stringResource(if (query.isBlank()) R.string.cal_nothing_here else R.string.cal_nothing_in_core),
                            Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                            style = StarlingsType.footnote,
                            color = c.secondary,
                        )
                    }
                }
            }
        }
    }
}
