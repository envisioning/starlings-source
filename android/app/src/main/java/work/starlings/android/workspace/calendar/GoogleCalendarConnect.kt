package work.starlings.android.workspace.calendar

import android.app.Activity
import android.content.Context
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Scope
import com.google.android.gms.tasks.Task
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import work.starlings.android.OwnerAccount
import work.starlings.android.api.CalendarRoutes
import work.starlings.android.api.StarlingsApiError
import work.starlings.contracts.CalendarAccountResponse
import work.starlings.contracts.CalendarAndroidExchangeRequest
import work.starlings.contracts.CalendarStatus
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** What a connect attaches: the owner's own calendar, or one more Google account for its calendars. */
enum class GoogleCalendarTarget {
    OWN, ACCOUNT;

    /** The title a failure shows, the route's own (`CalendarRoutes`). */
    val failure: String get() = if (this == OWN) CalendarRoutes.CONNECT_FAILED else CalendarRoutes.ADD_ACCOUNT_FAILED
}

/** The Worker's answer to a connect that landed. */
sealed interface GoogleCalendarConnected {
    data class Own(val status: CalendarStatus) : GoogleCalendarConnected
    data class Account(val response: CalendarAccountResponse) : GoogleCalendarConnected
}

/**
 * The Google side of the connect, without Android: the scopes it asks for.
 * The Calendar scopes are the Worker's `CALENDAR_OAUTH_SCOPES`
 * (`services/control-plane/src/google-scopes.ts`), so a phone's grant reads
 * what a web consent reads; `openid email` give the Worker the ID token it
 * checks the account with. `GoogleCalendarConnectTest` holds the list to the
 * TypeScript.
 */
object GoogleCalendarAuthorization {
    val calendarScopes: List<String> = listOf(
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        "https://www.googleapis.com/auth/calendar.events.freebusy",
    )

    val scopes: List<String> = calendarScopes + listOf("openid", "email")

    /**
     * `requestOfflineAccess(serverClientId, true)`: a refresh token for the
     * Worker's client every time, also for an account that consented before.
     */
    fun request(serverClientId: String): AuthorizationRequest =
        AuthorizationRequest.builder()
            .setRequestedScopes(scopes.map(::Scope))
            .requestOfflineAccess(serverClientId, true)
            .build()

    /** A cancel on Google's sheet says nothing (iOS ignores `CancellationError`). */
    fun isCancel(error: Throwable): Boolean =
        error is ApiException && error.statusCode == CommonStatusCodes.CANCELED
}

/**
 * One connect at a time for one screen. [busy] names the target while the
 * Worker or Google's sheet works, so the row can read "Connecting…".
 */
@Stable
class GoogleCalendarConnect internal constructor() {
    var busy by mutableStateOf<GoogleCalendarTarget?>(null)
        internal set
    internal var begin: (GoogleCalendarTarget) -> Unit = {}

    fun start(target: GoogleCalendarTarget) {
        if (busy == null) begin(target)
    }
}

/**
 * The one Google Calendar connect every entry point uses (Calendar sources,
 * Settings › Calendar, Home's Upcoming), as iOS `connectCalendar` and
 * `addCalendarAccount` are one flow for each of its callers:
 *
 * 1. `GET /api/calendar/connect/android` for the server client id.
 * 2. Play services' `AuthorizationClient.authorize`; when Google needs the
 *    person (an account choice, the consent), its PendingIntent opens and
 *    the result is read with `getAuthorizationResultFromIntent`.
 * 3. The `serverAuthCode` goes to the Worker for [GoogleCalendarTarget].
 *
 * [onFailure] gets the route's title; a cancel calls nothing.
 */
@Composable
fun rememberGoogleCalendarConnect(
    account: OwnerAccount,
    onFailure: (String) -> Unit,
    onConnected: suspend (GoogleCalendarConnected) -> Unit,
): GoogleCalendarConnect {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val failure by rememberUpdatedState(onFailure)
    val connected by rememberUpdatedState(onConnected)
    val currentAccount by rememberUpdatedState(account)
    val state = remember { GoogleCalendarConnect() }
    // The target while Google's sheet is up, kept across a process death.
    var pending by rememberSaveable { mutableStateOf<String?>(null) }

    /** Runs [work]; true from it means Google's sheet took over and [state] stays busy. */
    fun attempt(target: GoogleCalendarTarget, work: suspend () -> Boolean) {
        state.busy = target
        scope.launch {
            var handedOff = false
            try {
                handedOff = work()
            } catch (e: CancellationException) {
                throw e
            } catch (e: StarlingsApiError) {
                failure(e.sentence)
            } catch (e: Exception) {
                if (!GoogleCalendarAuthorization.isCancel(e)) failure(target.failure)
            } finally {
                if (!handedOff) state.busy = null
            }
        }
    }

    suspend fun exchange(target: GoogleCalendarTarget, result: AuthorizationResult) {
        val code = result.serverAuthCode?.takeIf { it.isNotBlank() } ?: return failure(target.failure)
        val body = CalendarAndroidExchangeRequest(code)
        val client = currentAccount.client
        val outcome = when (target) {
            GoogleCalendarTarget.OWN -> GoogleCalendarConnected.Own(client.call(CalendarRoutes.connectAndroid(body)))
            GoogleCalendarTarget.ACCOUNT -> GoogleCalendarConnected.Account(client.call(CalendarRoutes.connectAccountAndroid(body)))
        }
        connected(outcome)
    }

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { answer ->
        val target = pending?.let { name -> GoogleCalendarTarget.entries.firstOrNull { it.name == name } }
        pending = null
        val data: Intent? = answer.data
        if (target == null || answer.resultCode != Activity.RESULT_OK || data == null) {
            state.busy = null
            return@rememberLauncherForActivityResult
        }
        attempt(target) {
            exchange(target, authorizationClient(context).getAuthorizationResultFromIntent(data))
            false
        }
    }

    state.begin = { target ->
        attempt(target) {
            val serverClientId = currentAccount.client.call(CalendarRoutes.androidClient).serverClientId
            val result = authorizationClient(context).authorize(GoogleCalendarAuthorization.request(serverClientId)).awaitResult()
            val resolution = result.pendingIntent
            if (result.hasResolution() && resolution != null) {
                pending = target.name
                launcher.launch(IntentSenderRequest.Builder(resolution.intentSender).build())
                true
            } else {
                exchange(target, result)
                false
            }
        }
    }
    return state
}

private fun authorizationClient(context: Context) = Identity.getAuthorizationClient(context)

/** A Play services [Task] as a suspend call, without one more coroutines artifact. */
private suspend fun <T> Task<T>.awaitResult(): T = suspendCancellableCoroutine { continuation ->
    addOnSuccessListener { continuation.resume(it) }
    addOnFailureListener { continuation.resumeWithException(it) }
    addOnCanceledListener { continuation.cancel() }
}
