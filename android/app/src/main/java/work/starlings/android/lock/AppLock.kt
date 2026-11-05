package work.starlings.android.lock

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_WEAK
import android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import android.hardware.biometrics.BiometricPrompt
import android.os.Bundle
import android.os.CancellationSignal
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import work.starlings.android.R
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * A biometric or the screen lock in front of the whole app, as iOS
 * `StarlingsAppLock`. The screen lock is the fallback, not a second setting:
 * a biometric fails for wet hands or a re-enrolled face, and an app that only
 * takes a fingerprint locks its owner out of their own agenda.
 *
 * The lock is a cover over the app, not a sign-out. The session stays in the
 * Keystore vault either way: this answers "somebody else picked up my
 * unlocked phone", not "this device is stolen". The cover is its own
 * activity ([LockActivity]) above whatever is open, sheets and calls
 * included, so the app (a hosted meeting too) keeps running under it, as
 * iOS raises a window above the alert level.
 *
 * It uses the platform `BiometricPrompt` (API 30+ takes a biometric or the
 * screen lock in one prompt; minSdk is 31), so no library is added.
 */
object AppLock {
    /** What the prompts call this app (`StarlingsAppLock.appName`). */
    private const val APP_NAME = "Starlings"

    private lateinit var app: Application
    private val prefs get() = app.getSharedPreferences("app_lock", Context.MODE_PRIVATE)

    /** Locked is the launch state whenever the setting is on. */
    var isLocked by mutableStateOf(false); private set
    var isAuthenticating by mutableStateOf(false); private set
    var failure by mutableStateOf<String?>(null); private set
    var biometry by mutableStateOf(AppLockRules.Biometry.UNAVAILABLE); private set

    private var backgroundedAt: Long? = null
    private var cover: Activity? = null

    val isEnabled: Boolean get() = prefs.getBoolean(AppLockRules.ENABLED_KEY, false)

    /** From `StarlingsApp.onCreate`: the launch state, the process clock and the cover over every activity. */
    fun install(application: Application) {
        app = application
        isLocked = isEnabled
        biometry = current()
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStop(owner: LifecycleOwner) {
                backgroundedAt = System.currentTimeMillis()
            }

            override fun onStart(owner: LifecycleOwner) = cameBack()
        })
        application.registerActivityLifecycleCallbacks(Covers)
    }

    private fun cameBack() {
        biometry = current()
        if (!isEnabled) {
            isLocked = false
            return
        }
        val left = backgroundedAt ?: return
        backgroundedAt = null
        if (AppLockRules.locksOnReturn(true, left, System.currentTimeMillis())) {
            isLocked = true
            failure = null
        }
    }

    /** Read once per prompt: a person can enrol or remove a fingerprint while the app is away. */
    private fun current(): AppLockRules.Biometry {
        val manager = app.getSystemService(BiometricManager::class.java) ?: return AppLockRules.Biometry.UNAVAILABLE
        val pm = app.packageManager
        return AppLockRules.biometry(
            canUnlock = manager.canAuthenticate(BIOMETRIC_WEAK or DEVICE_CREDENTIAL) == BiometricManager.BIOMETRIC_SUCCESS,
            hasBiometric = manager.canAuthenticate(BIOMETRIC_WEAK) == BiometricManager.BIOMETRIC_SUCCESS,
            fingerprint = pm.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT),
            face = pm.hasSystemFeature(PackageManager.FEATURE_FACE),
        )
    }

    /** The cover's own name for what it asks for, in the setting's switch and footer. */
    fun title(context: Context, biometry: AppLockRules.Biometry): String = context.getString(
        when (biometry) {
            AppLockRules.Biometry.FINGERPRINT -> R.string.lock_fingerprint
            AppLockRules.Biometry.FACE -> R.string.lock_face
            AppLockRules.Biometry.BIOMETRIC -> R.string.lock_biometric
            AppLockRules.Biometry.SCREEN_LOCK -> R.string.lock_screen_lock
            AppLockRules.Biometry.UNAVAILABLE -> R.string.lock_device_unlock
        },
    )

    // Unlocking

    suspend fun unlock(activity: Activity) {
        if (!isLocked || isAuthenticating) return
        isAuthenticating = true
        failure = null
        val outcome = evaluate(activity, activity.getString(R.string.lock_unlock_reason, APP_NAME))
        isAuthenticating = false
        when (outcome) {
            AppLockRules.Outcome.Success -> isLocked = false
            AppLockRules.Outcome.Cancelled -> Unit
            is AppLockRules.Outcome.Failed -> failure = outcome.message
        }
    }

    /**
     * Turning the lock on proves the device can answer it before the setting
     * sticks. Turning it off asks too, so somebody holding an unlocked phone
     * cannot quietly remove the gate. Answers what the setting now is.
     */
    suspend fun setEnabled(activity: Activity, enabled: Boolean): Boolean {
        biometry = current()
        if (!biometry.isAvailable) {
            failure = activity.getString(R.string.lock_unavailable)
            return isEnabled
        }
        val reason = activity.getString(if (enabled) R.string.lock_turn_on_reason else R.string.lock_turn_off_reason, APP_NAME)
        return when (val outcome = evaluate(activity, reason)) {
            AppLockRules.Outcome.Success -> {
                prefs.edit().putBoolean(AppLockRules.ENABLED_KEY, enabled).apply()
                failure = null
                if (!enabled) isLocked = false
                enabled
            }
            AppLockRules.Outcome.Cancelled -> isEnabled
            is AppLockRules.Outcome.Failed -> {
                failure = outcome.message
                isEnabled
            }
        }
    }

    /** One prompt per ask: a biometric first, the screen lock after it fails or on request. */
    private suspend fun evaluate(activity: Activity, reason: String): AppLockRules.Outcome = suspendCancellableCoroutine { done ->
        val manager = activity.getSystemService(BiometricManager::class.java)
        if (manager == null || manager.canAuthenticate(BIOMETRIC_WEAK or DEVICE_CREDENTIAL) != BiometricManager.BIOMETRIC_SUCCESS) {
            done.resume(AppLockRules.Outcome.Failed(activity.getString(R.string.lock_cannot_ask)))
            return@suspendCancellableCoroutine
        }
        val signal = CancellationSignal()
        done.invokeOnCancellation { signal.cancel() }
        val prompt = BiometricPrompt.Builder(activity)
            .setTitle(reason)
            .setAllowedAuthenticators(BIOMETRIC_WEAK or DEVICE_CREDENTIAL)
            .build()
        prompt.authenticate(signal, activity.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                if (done.isActive) done.resume(AppLockRules.Outcome.Success)
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                if (done.isActive) done.resume(AppLockRules.outcome(errorCode, errString.toString()))
            }
            // A single miss keeps the prompt open; it is not an outcome.
        })
    }

    /** Raises the cover over any activity that comes forward while locked. */
    private object Covers : Application.ActivityLifecycleCallbacks {
        /** The activity in front, for a cover that is cleared away while still locked. */
        private var front: Activity? = null
        /** Asked for and not yet created: one cover at a time. */
        private var launching = false

        private fun present(activity: Activity) {
            if (!isLocked || activity is LockActivity || cover != null || launching) return
            launching = true
            activity.startActivity(Intent(activity, LockActivity::class.java))
            @Suppress("DEPRECATION")
            activity.overridePendingTransition(0, 0)
        }

        override fun onActivityResumed(activity: Activity) {
            front = activity
            present(activity)
        }

        override fun onActivityPaused(activity: Activity) {
            if (activity === front) front = null
        }

        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
            if (activity is LockActivity) {
                cover = activity
                launching = false
            }
        }

        override fun onActivityDestroyed(activity: Activity) {
            if (activity !== cover) return
            cover = null
            // A launcher tap clears the task above the main activity, the cover too,
            // and the main activity may resume before the cover is gone.
            if (!activity.isChangingConfigurations) front?.let(::present)
        }

        override fun onActivityStarted(activity: Activity) = Unit
        override fun onActivityStopped(activity: Activity) = Unit
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    }
}
