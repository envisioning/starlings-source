package work.starlings.android.lock

/**
 * The App Lock's rules (`iOS/MobileAppLock.swift`), apart from Android:
 * the setting's key, the grace a short trip out gets, what this device can
 * ask for, and how a prompt's error reads.
 */
object AppLockRules {
    /** Device-local, as iOS `StarlingsAppLockSettings.enabledKey`. */
    const val ENABLED_KEY = "meet.appLock.enabled"

    /**
     * A short trip out (the share sheet, a browser link, a permission dialog)
     * is not a new visit. Re-locking after every task switch trains the owner
     * to turn the whole feature off.
     */
    const val GRACE_SECONDS = 15
    const val GRACE_MS = GRACE_SECONDS * 1_000L

    /**
     * `applicationWillEnterForeground`: back after the grace interval locks
     * again. A cold launch is locked whenever the setting is on; nothing
     * keeps an "unlocked" flag.
     */
    fun locksOnReturn(enabled: Boolean, backgroundedAtMs: Long?, nowMs: Long): Boolean =
        enabled && backgroundedAtMs != null && nowMs - backgroundedAtMs >= GRACE_MS

    /** What this device can ask for (`StarlingsBiometry`). Read again before every prompt. */
    enum class Biometry { FINGERPRINT, FACE, BIOMETRIC, SCREEN_LOCK, UNAVAILABLE;
        val isAvailable: Boolean get() = this != UNAVAILABLE
    }

    /**
     * [canUnlock]: a biometric or the screen lock can answer. [hasBiometric]:
     * an enrolled biometric can. [fingerprint] and [face] are the device's
     * sensors; with both, or neither named, it is a biometric.
     */
    fun biometry(canUnlock: Boolean, hasBiometric: Boolean, fingerprint: Boolean, face: Boolean): Biometry = when {
        !canUnlock -> Biometry.UNAVAILABLE
        !hasBiometric -> Biometry.SCREEN_LOCK
        fingerprint && !face -> Biometry.FINGERPRINT
        face && !fingerprint -> Biometry.FACE
        else -> Biometry.BIOMETRIC
    }

    sealed interface Outcome {
        data object Success : Outcome
        /** The owner dismissed the prompt: the gate stays up and says nothing. */
        data object Cancelled : Outcome
        data class Failed(val message: String) : Outcome
    }

    /** `BiometricPrompt`'s cancel codes: the person, the app, or the system closed it. */
    private val CANCELS = setOf(ERROR_CANCELED, ERROR_USER_CANCELED, ERROR_NEGATIVE_BUTTON)

    fun outcome(errorCode: Int, message: String): Outcome =
        if (errorCode in CANCELS) Outcome.Cancelled else Outcome.Failed(message)

    // android.hardware.biometrics.BiometricPrompt's values, kept here so the rule runs on the JVM.
    const val ERROR_CANCELED = 5
    const val ERROR_USER_CANCELED = 10
    const val ERROR_NEGATIVE_BUTTON = 13
}
