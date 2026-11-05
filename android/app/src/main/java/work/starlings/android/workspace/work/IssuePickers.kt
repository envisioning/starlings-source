package work.starlings.android.workspace.work

import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import work.starlings.android.R
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkHeaderTitle
import work.starlings.android.ui.WorkLabeledRow
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSheet
import work.starlings.contracts.CrmIssueLabel
import work.starlings.contracts.CrmIssueUser

/**
 * The issue pickers the reader and the composer share (`MobileIssueView`'s
 * About rail, `MobileNewIssueView`'s "Give it to somebody",
 * `iOS/MobileIssueChrome.swift`): a checked menu for labels, a picker menu
 * for the milestone, and a screen for assignees, because an issue can
 * have several and a menu closes on the first tap.
 */

/** One entry of a [ChoiceMenuRow]: a title, a tick, and what a tap does. */
internal class MenuChoice(
    val title: String,
    val checked: Boolean = false,
    val startsGroup: Boolean = false,
    val danger: Boolean = false,
    /** A picker's caption ("Held by"): drawn, never performed. */
    val header: Boolean = false,
    val run: () -> Unit = {},
)

/** A labelled row that opens a menu of [choices] (`Menu { } label: { LabeledContent }`). */
@Composable
internal fun ChoiceMenuRow(label: String, value: String, choices: List<MenuChoice>, enabled: Boolean = true) {
    var open by remember { mutableStateOf(false) }
    Box(Modifier.alpha(if (enabled) 1f else 0.45f)) {
        WorkLabeledRow(label, value, onClick = if (enabled) ({ open = true }) else null)
        ChoiceMenu(open, { open = false }, choices)
    }
}

/** The dropdown itself: ticks on the left, a divider before a group. */
@Composable
internal fun ChoiceMenu(open: Boolean, onDismiss: () -> Unit, choices: List<MenuChoice>) {
    val c = Starlings.colors
    DropdownMenu(open, onDismiss, containerColor = c.elevated, shape = RoundedCornerShape(14.dp)) {
        choices.forEachIndexed { index, choice ->
            if (index > 0 && choice.startsGroup) HorizontalDivider(color = c.border)
            if (choice.header) {
                Text(choice.title, Modifier.padding(horizontal = 16.dp, vertical = 6.dp), style = StarlingsType.footnote, color = c.secondary)
                return@forEachIndexed
            }
            DropdownMenuItem(
                text = { Text(choice.title, style = StarlingsType.body, color = if (choice.danger) c.danger else c.primary) },
                leadingIcon = { Icon(Icons.Filled.Check, null, Modifier.size(18.dp).alpha(if (choice.checked) 1f else 0f), tint = c.primary) },
                onClick = { onDismiss(); choice.run() },
                modifier = Modifier.clearAndSetSemantics {
                    contentDescription = choice.title
                    role = Role.Button
                    selected = choice.checked
                },
            )
        }
    }
}

/** Labels as a checked menu: each tap toggles one name in or out. */
@Composable
internal fun LabelsMenuRow(facets: IssueFacets, chosen: List<String>, enabled: Boolean, summary: String, onChange: (List<String>) -> Unit) {
    val r = LocalContext.current.resources
    ChoiceMenuRow(
        r.getString(R.string.work_labels), summary,
        facets.labels.map { label -> MenuChoice(label.name, checked = label.name in chosen) { onChange(IssueFilter.toggled(label.name, chosen)) } },
        enabled,
    )
}

/** The milestone as a picker menu: None, then each one with a number. */
@Composable
internal fun MilestoneMenuRow(facets: IssueFacets, chosen: Long?, enabled: Boolean, summary: String, noneTitle: String, onChange: (Long?) -> Unit) {
    val r = LocalContext.current.resources
    val choices = listOf(MenuChoice(noneTitle, checked = chosen == null) { onChange(null) }) +
        facets.numbered.mapIndexed { index, (number, title) -> MenuChoice(title, checked = chosen == number, startsGroup = index == 0) { onChange(number) } }
    ChoiceMenuRow(r.getString(R.string.work_milestone), summary, choices, enabled)
}

/**
 * `MobileAssigneePicker`: Nobody, then the people with a tick each. Nothing
 * is written until it closes, and nothing when the set came back the same.
 */
@Composable
internal fun AssigneePickerSheet(people: List<CrmIssueUser>, selected: List<String>, onCommit: (List<String>) -> Unit) {
    val r = LocalContext.current.resources
    var chosen by remember { mutableStateOf(selected.toSet()) }
    WorkSheet(r.getString(R.string.work_assignees), r.getString(R.string.work_close), { onCommit(chosen.sorted()) }) {
        WorkSection {
            PickRow(r.getString(R.string.work_nobody), chosen.isEmpty()) { chosen = emptySet() }
        }
        WorkSection(header = { WorkHeaderTitle(if (chosen.isEmpty()) r.getString(R.string.work_unassigned) else r.getString(R.string.work_n_selected, chosen.size)) }) {
            people.forEachIndexed { index, person ->
                if (index > 0) WorkDivider()
                PickRow(person.login, person.login in chosen, avatar = person.login) {
                    chosen = if (person.login in chosen) chosen - person.login else chosen + person.login
                }
            }
        }
    }
}

@Composable
private fun PickRow(title: String, on: Boolean, avatar: String? = null, onToggle: () -> Unit) {
    val c = Starlings.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onToggle)
            .clearAndSetSemantics { contentDescription = title; role = Role.Button; selected = on }
            .padding(horizontal = 16.dp, vertical = 11.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (avatar != null) LoginInitials(avatar)
        Text(title, style = StarlingsType.body, color = c.primary)
        Spacer(Modifier.weight(1f))
        Icon(Icons.Filled.Check, null, Modifier.size(18.dp).alpha(if (on) 1f else 0f), tint = c.accent)
    }
}

/**
 * `MobileLoginAvatar`'s initials: drawn at once and kept. The picture
 * (through the Worker's avatar route) is not loaded on Android yet.
 */
@Composable
internal fun LoginInitials(login: String, diameter: androidx.compose.ui.unit.Dp = 24.dp) {
    val c = Starlings.colors
    Box(
        Modifier.size(diameter).background(c.secondary.copy(alpha = 0.12f), CircleShape).border(1.dp, c.secondary.copy(alpha = 0.22f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            IssueLabels.initials(login),
            style = StarlingsType.caption2.copy(fontWeight = FontWeight.SemiBold, fontSize = (diameter.value * 0.42f).let { androidx.compose.ui.unit.TextUnit(it, androidx.compose.ui.unit.TextUnitType.Sp) }),
            color = c.secondary,
        )
    }
}

/** `MobileLabelChip`: GitHub's hue kept, the app's treatment: a wash, a hairline, and the hue as ink. */
@Composable
internal fun LabelChip(label: CrmIssueLabel) {
    val c = Starlings.colors
    val r = LocalContext.current.resources
    val base = IssueLabels.colour(label.color)?.let { Color(it) }
    val hue = base ?: c.secondary
    val ink = base?.let { if (c.dark) lerp(it, Color.White, 0.35f) else lerp(it, Color.Black, 0.25f) } ?: c.secondary
    val shape = RoundedCornerShape(50)
    Text(
        label.name,
        Modifier
            .background(hue.copy(alpha = if (c.dark) 0.20f else 0.16f), shape)
            .border(1.dp, hue.copy(alpha = if (c.dark) 0.42f else 0.36f), shape)
            .padding(horizontal = 6.dp, vertical = 2.dp)
            .clearAndSetSemantics { contentDescription = r.getString(R.string.work_label_named, label.name) },
        style = StarlingsType.caption2.copy(fontWeight = FontWeight.Medium),
        color = ink,
        maxLines = 1,
    )
}

/** Chips that wrap rather than truncate (`MobileLabelChipRow`). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun LabelChipRow(labels: List<CrmIssueLabel>, modifier: Modifier = Modifier) {
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        labels.forEach { LabelChip(it) }
    }
}

/** A labelled block for chips (the rail's Labels when nothing can be changed). */
@Composable
internal fun LabelsBlock(title: String, labels: List<CrmIssueLabel>, menu: (@Composable () -> Unit)? = null) {
    val c = Starlings.colors
    Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        if (menu == null) Text(title, Modifier.padding(horizontal = 16.dp), style = StarlingsType.caption, color = c.secondary)
        if (labels.isNotEmpty()) LabelChipRow(labels, Modifier.padding(horizontal = 16.dp))
        if (menu != null) menu() else Spacer(Modifier.padding(bottom = 4.dp))
    }
}
