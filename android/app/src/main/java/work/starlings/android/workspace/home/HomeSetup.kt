package work.starlings.android.workspace.home

import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import work.starlings.android.OwnerAccount
import work.starlings.android.R
import work.starlings.android.api.HomeExtraRoutes
import work.starlings.android.api.SettingsRoutes
import work.starlings.android.api.StarlingsApiError
import work.starlings.android.ui.CompactMark
import work.starlings.android.ui.HomeCardLabel
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsCard
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.homeRow
import work.starlings.android.workspace.settings.SettingsPages
import work.starlings.contracts.SetupResponse
import work.starlings.contracts.SetupStepState

/**
 * `SetupStep`: the steps this build knows, in `fixtures/setup-steps.json`'s
 * order, with the table's title and route. A step a newer Worker names and
 * this build does not know is left out.
 */
enum class SetupStep(val id: String, val title: Int, val route: String) {
    PROFILE("profile", R.string.setup_step_profile, "/settings#settings-account"),
    LOOK("look", R.string.setup_step_look, "/admin/people"),
    MEMBERSHIP("membership", R.string.setup_step_membership, "/admin/people"),
    INVITE("invite", R.string.setup_step_invite, "/admin/people"),
    PROJECT("project", R.string.setup_step_project, "/work"),
    CALENDAR("calendar", R.string.setup_step_calendar, "/settings#settings-calendar"),
    ASSISTANT("assistant", R.string.setup_step_assistant, "/help/howto/connect-an-agent-over-mcp"),
    AGENT("agent", R.string.setup_step_agent, "/admin/agents"),
    CALL("call", R.string.setup_step_call, "/"),
    APPS("apps", R.string.setup_step_apps, "${work.starlings.android.Deployment.PRODUCT_SITE_ORIGIN}/download");

    companion object {
        fun of(id: String): SetupStep? = entries.firstOrNull { it.id == id }
    }
}

/**
 * `SetupChecklist` (Sources/SetupChecklist.swift, docs/ONBOARDING.md): which
 * rows draw, when the card draws at all, and where a step opens. Which steps
 * are done is `GET /api/setup`.
 */
object SetupChecklist {
    data class Row(val step: SetupStep, val state: SetupStepState, val isNext: Boolean) {
        /** Opens somewhere: not done, and nobody blocks it. */
        val opens: Boolean get() = !state.done && state.blocked == null
        /** Skip clears any step that is not done, blocked or not (`PUT /api/setup/skip`). */
        val skippable: Boolean get() = !state.done
    }

    sealed interface Card {
        /** No answer yet, turned off, hidden this session, or set up and already said so. */
        data object None : Card
        /** Every required step is done; said once. */
        data object Done : Card
        data class Steps(val rows: List<Row>) : Card
    }

    fun card(response: SetupResponse?, hidden: Boolean, doneSaid: Boolean): Card {
        if (response == null || !response.on || hidden) return Card.None
        if (response.complete) return if (doneSaid) Card.None else Card.Done
        val rows = response.steps.mapNotNull { state -> SetupStep.of(state.id)?.let { Row(it, state, state.id == response.next) } }
        return if (rows.isEmpty()) Card.None else Card.Steps(rows)
    }

    sealed interface Destination {
        data class Settings(val page: SettingsPages.Page) : Destination
        data object Work : Destination
        data object Room : Destination
        data class Web(val url: String) : Destination
    }

    fun destination(step: SetupStep, webOrigin: String): Destination = when (step) {
        SetupStep.PROFILE -> Destination.Settings(SettingsPages.Page.ACCOUNT)
        // Settings › Account holds Connected agents: the connector's name and address, with Copy.
        SetupStep.ASSISTANT -> Destination.Settings(SettingsPages.Page.ACCOUNT)
        SetupStep.CALENDAR -> Destination.Settings(SettingsPages.Page.CALENDAR)
        SetupStep.PROJECT -> Destination.Work
        SetupStep.CALL -> Destination.Room
        SetupStep.LOOK, SetupStep.MEMBERSHIP, SetupStep.INVITE, SetupStep.AGENT, SetupStep.APPS -> Destination.Web(webUrl(step.route, webOrigin))
    }

    /** A route from the table: absolute as it is, else a path on the workspace's origin. */
    fun webUrl(route: String, origin: String): String =
        if (route.startsWith("https://") || route.startsWith("http://")) route else origin.trimEnd('/') + route

    /** Where "You're set up" was said: per workspace and person, on this device. */
    fun doneSaidKey(workspace: String, owner: String): String = "setup.doneSaid.$workspace|${owner.lowercase()}"
}

/** `SetupChecklistSession.hidden`: Hide puts the card away until the app next starts. */
object SetupChecklistSession {
    var hidden = false
}

/** Home's setup checklist state: the answer, the error, and the writes (`MobileHomeView.loadSetup`). */
class HomeSetup(private val account: OwnerAccount, private val workspace: String) {
    var setup by mutableStateOf<SetupResponse?>(null); private set
    var error by mutableStateOf<String?>(null); private set
    var hidden by mutableStateOf(SetupChecklistSession.hidden); private set
    private var doneSaid: Boolean? = null

    private fun owner(): String? = account.session.credentials()?.email

    private fun prefs(context: Context) = context.getSharedPreferences("home", Context.MODE_PRIVATE)

    fun card(): SetupChecklist.Card = SetupChecklist.card(setup, hidden, doneSaid ?: true)

    /** The card, and an error with nothing to show under it unless hidden. */
    val draws: Boolean get() = card() != SetupChecklist.Card.None || (error != null && !hidden)

    private fun answered(context: Context, answer: SetupResponse) {
        setup = answer
        error = null
        val owner = owner() ?: return
        if (answer.on && answer.complete) prefs(context).edit().putBoolean(SetupChecklist.doneSaidKey(workspace, owner), true).apply()
    }

    suspend fun load(context: Context) {
        val owner = owner() ?: return
        if (doneSaid == null) doneSaid = prefs(context).getBoolean(SetupChecklist.doneSaidKey(workspace, owner), false)
        try {
            answered(context, account.client.call(SettingsRoutes.setup))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (setup == null) error = (e as? StarlingsApiError)?.sentence ?: SettingsRoutes.setup.operation
        }
    }

    suspend fun skip(context: Context, step: SetupStep) = write(context, HomeExtraRoutes.skipSetupStep(step.id))

    suspend fun turnOff(context: Context) = write(context, HomeExtraRoutes.setSetupChecklist(false))

    private suspend fun write(context: Context, route: work.starlings.android.api.Route<SetupResponse>) {
        try {
            answered(context, account.client.call(route))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = (e as? StarlingsApiError)?.sentence ?: route.operation
        }
    }

    fun hide() {
        SetupChecklistSession.hidden = true
        hidden = true
    }
}

/** `MobileSetupCard`: GET STARTED, Turn off for everyone and Hide, then the steps or "You're set up." */
@Composable
fun SetupCard(
    card: SetupChecklist.Card,
    canTurnOff: Boolean,
    error: String?,
    open: (SetupStep) -> Unit,
    skip: (SetupStep) -> Unit,
    hide: () -> Unit,
    turnOff: () -> Unit,
    retry: () -> Unit,
) {
    val c = Starlings.colors
    StarlingsCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                HomeCardLabel(stringResource(R.string.setup_get_started))
                Spacer(Modifier.weight(1f))
                if (canTurnOff && card is SetupChecklist.Card.Steps) QuietButton(stringResource(R.string.setup_turn_off), turnOff)
                if (card != SetupChecklist.Card.None) QuietButton(stringResource(R.string.setup_hide), hide)
            }
            when (card) {
                SetupChecklist.Card.None -> Unit
                SetupChecklist.Card.Done -> Text(stringResource(R.string.setup_done_title), style = StarlingsType.headline, color = c.primary)
                is SetupChecklist.Card.Steps -> card.rows.forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        StepRow(row, Modifier.weight(1f), if (row.opens) ({ open(row.step) }) else null)
                        if (row.skippable) {
                            val title = stringResource(row.step.title)
                            val label = stringResource(R.string.setup_skip_step, title)
                            QuietButton(stringResource(R.string.setup_skip), { skip(row.step) }, label)
                        }
                    }
                }
            }
            error?.let { WorkErrorNotice(it, stringResource(R.string.setup_retry), onRetry = retry) }
        }
    }
}

@Composable
private fun StepRow(row: SetupChecklist.Row, modifier: Modifier, open: (() -> Unit)?) {
    val c = Starlings.colors
    val done = row.state.done
    val title = stringResource(row.step.title)
    val reason = row.state.blocked?.reason
    val parts = buildList {
        add(title)
        if (done) add(stringResource(R.string.setup_done))
        if (!row.state.required) add(stringResource(R.string.setup_optional))
        reason?.let { add(it) }
    }
    val label = parts.joinToString(", ")
    val hint = stringResource(R.string.setup_opens_hint)
    Row(
        modifier
            .then(if (open != null) Modifier.clickable(role = Role.Button, onClick = open) else Modifier)
            .homeRow(c.elevated)
            .clearAndSetSemantics {
                contentDescription = label
                if (open != null) { role = Role.Button; onClick(hint) { open(); true } }
            },
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        CompactMark(if (done) Icons.Outlined.Check else Icons.Outlined.Circle, round = true, tint = if (row.isNext) c.primary else c.secondary)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                title,
                style = StarlingsType.headline.copy(textDecoration = if (done) TextDecoration.LineThrough else null),
                color = if (done) c.secondary else c.primary,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
            reason?.let { Text(it, style = StarlingsType.caption, color = c.secondary, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
        if (!row.state.required && !done) {
            Text(stringResource(R.string.setup_optional), style = StarlingsType.caption.copy(fontWeight = FontWeight.SemiBold), color = c.secondary)
        }
    }
}

/** A caption-semibold text button in secondary ink (`.buttonStyle(.meetPlain)`). */
@Composable
private fun QuietButton(text: String, onClick: () -> Unit, label: String = text) {
    Text(
        text,
        Modifier
            .clickable(role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = label; role = Role.Button; onClick { onClick(); true } }
            .padding(vertical = 4.dp),
        style = StarlingsType.caption.copy(fontWeight = FontWeight.SemiBold),
        color = Starlings.colors.secondary,
    )
}
