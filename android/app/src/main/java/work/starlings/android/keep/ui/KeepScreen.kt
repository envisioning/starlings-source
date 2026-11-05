package work.starlings.android.keep.ui

import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.outlined.Fingerprint
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.LockOpen
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import work.starlings.android.R
import work.starlings.android.keep.KeepAccess
import work.starlings.android.keep.KeepMe
import work.starlings.android.keep.KeepPasskey
import work.starlings.android.keep.KeepPasskeyError
import work.starlings.android.keep.KeepSession
import work.starlings.android.ui.SegmentedChoice
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkTopBar

/** Where Keep opens once unlocked: the vault list, or straight into one project's vault (`KeepLanding`). */
sealed interface KeepLanding {
    data object Vaults : KeepLanding
    data class Project(val id: String, val name: String) : KeepLanding
}

/** What Keep's own stack can push over its root. Kept by ids, so a rotation keeps the page. */
internal sealed interface KeepPage {
    data class Vault(val id: String) : KeepPage
    data class Item(val vaultId: String, val itemId: String) : KeepPage
    data object Settings : KeepPage

    companion object {
        fun encode(page: KeepPage): String = when (page) {
            is Vault -> "vault:${page.id}"
            is Item -> "item:${page.vaultId}:${page.itemId}"
            Settings -> "settings"
        }

        fun decode(line: String): KeepPage? {
            val parts = line.split(':')
            return when {
                parts.size == 2 && parts[0] == "vault" -> Vault(parts[1])
                parts.size == 3 && parts[0] == "item" -> Item(parts[1], parts[2])
                line == "settings" -> Settings
                else -> null
            }
        }
    }
}

private val KeepStackSaver: Saver<SnapshotStateList<KeepPage>, ArrayList<String>> = Saver(
    save = { stack -> ArrayList(stack.map(KeepPage::encode)) },
    restore = { lines -> mutableStateListOf<KeepPage>().apply { addAll(lines.mapNotNull(KeepPage::decode)) } },
)

/**
 * Keep under Work: core-kit `KeepRootView` on a phone (`MobileKeepScreen`).
 * Three gates, then the vaults. Connected (the app brokered a device
 * token), enrolled (a key on the server), unlocked (the key in memory).
 * The vault, the item and Keep's settings push onto Keep's own stack;
 * Back pops it before it leaves Keep.
 */
@Composable
fun KeepScreen(access: KeepAccess, landing: KeepLanding, onBack: () -> Unit) {
    val session = access.session
    val stack = rememberSaveable(saver = KeepStackSaver) { mutableStateListOf<KeepPage>() }
    val push: (KeepPage) -> Unit = { stack.add(it) }
    val pop: () -> Unit = { if (stack.isNotEmpty()) stack.removeAt(stack.lastIndex) else onBack() }
    BackHandler(enabled = stack.isNotEmpty()) { stack.removeAt(stack.lastIndex) }

    LaunchedEffect(session) { session.refresh() }
    // Any Keep screen shown counts as activity for the idle lock.
    DisposableEffect(stack.size) {
        session.touch()
        onDispose { }
    }

    val state = session.state
    val title = stringResource(R.string.keep_title)
    if (state !is KeepSession.State.Unlocked) {
        Column(Modifier.fillMaxSize().background(Starlings.colors.canvas)) {
            WorkTopBar(if (landing is KeepLanding.Project) landing.name else title, stringResource(R.string.back), onBack)
            KeepGates(access, state)
        }
        return
    }
    when (val page = stack.lastOrNull()) {
        null -> when (landing) {
            KeepLanding.Vaults -> KeepVaultsScreen(session, onBack, push)
            is KeepLanding.Project -> KeepProjectVault(session, landing, onBack, push)
        }
        is KeepPage.Vault -> KeepVaultScreen(session, page.id, pop, push)
        is KeepPage.Item -> KeepItemScreen(session, page.vaultId, page.itemId, pop)
        KeepPage.Settings -> KeepSettingsScreen(session, pop)
    }
}

/** The gates before the vaults, also what a host's own Keep act sits behind (`KeepUnlockGate`). */
@Composable
internal fun KeepGates(access: KeepAccess, state: KeepSession.State) {
    val session = access.session
    when (state) {
        KeepSession.State.Disconnected -> KeepGate(stringResource(R.string.keep_title), access.errorMessage ?: stringResource(R.string.keep_connect_message)) {
            KeepAsyncButton(stringResource(R.string.keep_connect), icon = Icons.Filled.Link) { access.link() }
        }
        KeepSession.State.Loading -> Box(Modifier.fillMaxSize().background(Starlings.colors.canvas), contentAlignment = Alignment.Center) {
            Text(stringResource(R.string.keep_connecting), style = StarlingsType.body, color = Starlings.colors.secondary)
        }
        is KeepSession.State.Failed -> KeepGate(stringResource(R.string.keep_title), state.message) {
            KeepAsyncButton(stringResource(R.string.keep_try_again), filled = false, icon = Icons.Filled.Refresh) { session.refresh() }
        }
        is KeepSession.State.Unenrolled -> KeepEnrolGate(session, state.me)
        is KeepSession.State.Locked -> KeepUnlockGate(session)
        is KeepSession.State.Unlocked -> Unit
    }
}

/**
 * Enrolment (`KeepEnrolView`): make a keypair on this device, wrap the
 * private half under a passkey's PRF output or a passphrase, send the
 * public half and the wrapped blob. The passkey choice shows only where
 * [KeepPasskey.isAvailable]; a passkey without PRF falls back to the
 * passphrase, as on iOS.
 */
@Composable
private fun KeepEnrolGate(session: KeepSession, me: KeepMe) {
    val context = LocalContext.current
    val passkeyAvailable = remember(context) { KeepPasskey.isAvailable(context) }
    var usePasskey by remember { mutableStateOf(passkeyAvailable) }
    var passphrase by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val minimum = 12
    val tooShort = stringResource(R.string.keep_use_at_least, minimum)
    val differ = stringResource(R.string.keep_passphrases_differ)
    KeepGate(stringResource(R.string.keep_set_up), stringResource(R.string.keep_set_up_message)) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (passkeyAvailable) {
                SegmentedChoice(
                    listOf(stringResource(R.string.keep_passkey), stringResource(R.string.keep_passphrase)),
                    if (usePasskey) 0 else 1,
                    { usePasskey = it == 0 },
                )
            }
            if (usePasskey) {
                Text(stringResource(R.string.keep_passkey_enrol_hint), style = StarlingsType.footnote, color = Starlings.colors.secondary, textAlign = TextAlign.Center)
                KeepAsyncButton(stringResource(R.string.keep_create_passkey), icon = Icons.Outlined.Key) {
                    error = null
                    try {
                        val enrolment = keepPasskey(context, session).enrol(me.email, me.name)
                        try {
                            session.enrol(enrolment)
                        } finally {
                            enrolment.prf.fill(0)
                        }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: KeepPasskeyError.Cancelled) {
                        // Nothing to say.
                    } catch (e: KeepPasskeyError.NoPRF) {
                        error = e.message
                        usePasskey = false
                    } catch (e: Exception) {
                        error = e.message
                    }
                }
            } else {
                KeepSecretField(stringResource(R.string.keep_passphrase), passphrase, { passphrase = it })
                KeepSecretField(stringResource(R.string.keep_again), confirm, { confirm = it })
                Text(stringResource(R.string.keep_forgetting), style = StarlingsType.footnote, color = Starlings.colors.secondary, textAlign = TextAlign.Center)
                KeepAsyncButton(stringResource(R.string.keep_set_passphrase), icon = Icons.Outlined.Lock, enabled = passphrase.length >= minimum && passphrase == confirm) {
                    error = null
                    when {
                        passphrase.length < minimum -> error = tooShort
                        passphrase != confirm -> error = differ
                        else -> try {
                            session.enrol(passphrase)
                            passphrase = ""
                            confirm = ""
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            error = e.message
                        }
                    }
                }
            }
            KeepErrorText(error)
        }
    }
}

/**
 * The third gate (`KeepUnlockView`): the wrapped private key into a live
 * one, in memory. Offers every way the key holds: the passkey when this
 * phone can use one (asked once, without a tap, as iOS), the passphrase
 * when the key has one. A passkey-only key on a phone without passkeys
 * says where to add a passphrase.
 */
@Composable
private fun KeepUnlockGate(session: KeepSession) {
    val context = LocalContext.current
    val passkeyAvailable = remember(context) { KeepPasskey.isAvailable(context) }
    var passphrase by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var askedOnce by rememberSaveable { mutableStateOf(false) }
    val hasPassphrase = session.hasPassphrase
    val canPasskey = passkeyAvailable && session.passkeyCredentialId != null
    val wrong = stringResource(R.string.keep_wrong_passphrase)
    suspend fun unlock() {
        if (passphrase.isEmpty()) return
        error = null
        try {
            session.unlock(passphrase)
            passphrase = ""
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            error = wrong
        }
    }
    suspend fun unlockPasskey() {
        error = null
        val credentialId = session.passkeyCredentialId ?: return
        try {
            val prf = keepPasskey(context, session).unlock(credentialId)
            try {
                session.unlock(prf)
            } finally {
                prf.fill(0)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: KeepPasskeyError.Cancelled) {
            // Nothing to say.
        } catch (e: Exception) {
            error = e.message
        }
    }
    // A passkey unlock is one tap; start it without asking, once.
    LaunchedEffect(canPasskey) {
        if (canPasskey && !askedOnce) {
            askedOnce = true
            unlockPasskey()
        }
    }
    val message = stringResource(
        when {
            canPasskey && hasPassphrase -> R.string.keep_unlock_both_message
            canPasskey -> R.string.keep_unlock_passkey_message
            hasPassphrase -> R.string.keep_unlock_passphrase_message
            else -> R.string.keep_unlock_passkey_only
        },
    )
    KeepGate(stringResource(R.string.keep_unlock_title), message) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (canPasskey) {
                KeepAsyncButton(stringResource(R.string.keep_unlock_with_passkey), icon = Icons.Outlined.Fingerprint) { unlockPasskey() }
            }
            if (hasPassphrase) {
                var submit by remember { mutableStateOf(0) }
                LaunchedEffect(submit) { if (submit > 0) unlock() }
                KeepSecretField(stringResource(R.string.keep_passphrase), passphrase, { passphrase = it }, onDone = { submit++ })
                KeepAsyncButton(stringResource(R.string.keep_unlock), filled = !canPasskey, icon = Icons.Outlined.LockOpen, enabled = passphrase.isNotEmpty()) { unlock() }
            }
            if (!canPasskey && !hasPassphrase) {
                KeepAsyncButton(stringResource(R.string.keep_check_again), filled = false, icon = Icons.Filled.Refresh) { session.refresh() }
            }
            KeepErrorText(error)
            if (canPasskey || hasPassphrase) {
                Text(stringResource(R.string.keep_idle_lock), Modifier.padding(top = 2.dp), style = StarlingsType.footnote, color = Starlings.colors.secondary)
            }
        }
    }
}

/** A ceremony on the Activity this screen sits in, for the session's relying party. */
internal fun keepPasskey(context: Context, session: KeepSession): KeepPasskey =
    KeepPasskey(KeepPasskey.activityOf(context) ?: context, session.client.relyingPartyIdentifier)
