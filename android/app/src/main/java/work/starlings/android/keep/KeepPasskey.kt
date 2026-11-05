package work.starlings.android.keep

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

// Passkeys with the PRF extension, natively: core-kit `KeepKit/KeepPasskey.swift`.
// The same credential Safari made on Keep's built-in host answers
// here, and with the same salt gives the same 32 bytes, which is what lets
// one enrolment unlock on the web, on iOS and here. Credential Manager runs
// the ceremony; it trusts this app for the relying party only when the Keep
// Worker serves `/.well-known/assetlinks.json` naming it. Until then every
// ceremony fails, and the screen shows the failure as iOS does.

/** Why a passkey ceremony gave no PRF output. The messages are KeepKit's. */
sealed class KeepPasskeyError(message: String) : Exception(message) {
    class Unsupported : KeepPasskeyError("Passkeys with PRF need iOS 18 or macOS 15.")
    class Cancelled : KeepPasskeyError("Cancelled.")
    class NoPRF : KeepPasskeyError("This passkey does not support PRF. Use a passphrase instead.")
    class Failed(message: String) : KeepPasskeyError(message)
}

/** A new passkey and its PRF output. The output is a secret: memory only, never printed. */
class KeepPasskeyEnrolment(val credentialId: String, val prf: ByteArray) {
    override fun toString(): String = "KeepPasskeyEnrolment($credentialId, …)"
}

/**
 * The WebAuthn JSON that Credential Manager takes and gives back. Pure, so
 * the request shape (relying party, salt, the PRF extension) is held by
 * `KeepPasskeyTest` without a device.
 */
internal object KeepPasskeyRequests {
    /** Same as KeepKit: user verification required, the PRF salt as `eval.first`. */
    fun registration(rpId: String, challenge: ByteArray, userId: ByteArray, email: String, name: String, salt: ByteArray): String =
        buildJsonObject {
            put("challenge", KeepCrypto.base64URL(challenge))
            putJsonObject("rp") {
                put("id", rpId)
                put("name", "Keep")
            }
            putJsonObject("user") {
                put("id", KeepCrypto.base64URL(userId))
                put("name", email)
                put("displayName", name)
            }
            // ES256 first, then RS256, as WebAuthn's own example.
            putJsonArray("pubKeyCredParams") {
                for (alg in listOf(-7, -257)) addJsonObject {
                    put("type", "public-key")
                    put("alg", alg)
                }
            }
            put("timeout", TIMEOUT_MS)
            put("attestation", "none")
            putJsonObject("authenticatorSelection") {
                put("residentKey", "required")
                put("requireResidentKey", true)
                put("userVerification", "required")
            }
            putJsonObject("extensions") { prf(salt) }
        }.toString()

    /** Ask the one named passkey, as KeepKit's `allowedCredentials`. */
    fun assertion(rpId: String, challenge: ByteArray, credentialId: String, salt: ByteArray): String =
        buildJsonObject {
            put("challenge", KeepCrypto.base64URL(challenge))
            put("rpId", rpId)
            putJsonArray("allowCredentials") {
                addJsonObject {
                    put("type", "public-key")
                    put("id", KeepCrypto.base64URL(KeepCrypto.data(credentialId)))
                }
            }
            put("timeout", TIMEOUT_MS)
            put("userVerification", "required")
            putJsonObject("extensions") { prf(salt) }
        }.toString()

    private fun kotlinx.serialization.json.JsonObjectBuilder.prf(salt: ByteArray) {
        putJsonObject("prf") {
            putJsonObject("eval") { put("first", KeepCrypto.base64URL(salt)) }
        }
    }

    /** What a registration answered: the credential id (base64url, no padding) and PRF, if evaluated. */
    class Registration(val credentialId: String, val prf: ByteArray?, val prfEnabled: Boolean) {
        override fun toString(): String = "Registration($credentialId, prf=${prf != null}, enabled=$prfEnabled)"
    }

    fun parseRegistration(json: String): Registration {
        val root = parse(json)
        val raw = root.string("rawId") ?: root.string("id") ?: throw unexpected()
        val prf = root.prf()
        return Registration(KeepCrypto.base64URL(KeepCrypto.data(raw)), prf.first(), (prf?.get("enabled") as? JsonPrimitive)?.booleanOrNull == true)
    }

    /** The PRF output of an assertion, or null when the authenticator gave none. */
    fun parseAssertion(json: String): ByteArray? = parse(json).prf().first()

    private fun parse(json: String): JsonObject = try {
        KeepJson.parseToJsonElement(json).jsonObject
    } catch (_: Exception) {
        throw unexpected()
    }

    private fun JsonObject.string(key: String): String? = (get(key) as? JsonPrimitive)?.contentOrNull

    private fun JsonObject.prf(): JsonObject? =
        (get("clientExtensionResults") as? JsonObject)?.get("prf") as? JsonObject

    private fun JsonObject?.first(): ByteArray? {
        val results = this?.get("results") as? JsonObject ?: return null
        val first = results.string("first") ?: return null
        return KeepCrypto.data(first).takeIf { it.isNotEmpty() }
    }

    fun unexpected() = KeepPasskeyError.Failed("Unexpected credential.")

    private const val TIMEOUT_MS = 60_000
}

/**
 * One ceremony on [context], which must be (or wrap) the Activity the
 * system sheet attaches to. [relyingParty] is the Keep host
 * (`KeepClient.relyingPartyIdentifier`).
 */
class KeepPasskey(private val context: Context, private val relyingParty: String) {
    private val manager = CredentialManager.create(context)

    /** Make a passkey and evaluate PRF in the same ceremony. */
    suspend fun enrol(email: String, name: String): KeepPasskeyEnrolment {
        if (!isAvailable(context)) throw KeepPasskeyError.Unsupported()
        val json = KeepPasskeyRequests.registration(
            relyingParty, KeepCrypto.randomBytes(32), KeepCrypto.randomBytes(16), email, name, KeepCrypto.prfSalt,
        )
        val response = ceremony {
            manager.createCredential(context, CreatePublicKeyCredentialRequest(json))
        } as? CreatePublicKeyCredentialResponse ?: throw KeepPasskeyRequests.unexpected()
        val registration = KeepPasskeyRequests.parseRegistration(response.registrationResponseJson)
        registration.prf?.let { return KeepPasskeyEnrolment(registration.credentialId, it) }
        // Some authenticators only evaluate PRF on assertion. Ask once.
        if (registration.prfEnabled) return KeepPasskeyEnrolment(registration.credentialId, unlock(registration.credentialId))
        throw KeepPasskeyError.NoPRF()
    }

    /** Ask the named passkey for its PRF output. */
    suspend fun unlock(credentialId: String): ByteArray {
        if (!isAvailable(context)) throw KeepPasskeyError.Unsupported()
        val json = KeepPasskeyRequests.assertion(relyingParty, KeepCrypto.randomBytes(32), credentialId, KeepCrypto.prfSalt)
        val response = ceremony {
            manager.getCredential(context, GetCredentialRequest(listOf(GetPublicKeyCredentialOption(json))))
        }
        val credential = response.credential as? PublicKeyCredential ?: throw KeepPasskeyRequests.unexpected()
        return KeepPasskeyRequests.parseAssertion(credential.authenticationResponseJson) ?: throw KeepPasskeyError.NoPRF()
    }

    /** KeepKit's delegate mapping: a cancel is [KeepPasskeyError.Cancelled], anything else carries the system's sentence. */
    private suspend fun <T> ceremony(block: suspend () -> T): T = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (_: CreateCredentialCancellationException) {
        throw KeepPasskeyError.Cancelled()
    } catch (_: GetCredentialCancellationException) {
        throw KeepPasskeyError.Cancelled()
    } catch (e: CreateCredentialException) {
        throw KeepPasskeyError.Failed(e.errorMessage?.toString() ?: e.type)
    } catch (e: GetCredentialException) {
        throw KeepPasskeyError.Failed(e.errorMessage?.toString() ?: e.type)
    }

    companion object {
        /**
         * Android 14 or later, with Google Play services 25 or later: the
         * floor this port sets for Google Password Manager's PRF. KeepKit
         * reads the OS version and, on the Mac, the signature; Android
         * cannot read whether the Worker trusts the app, so a ceremony that
         * fails for that says so on the screen. A provider without PRF
         * answers [KeepPasskeyError.NoPRF], and enrolment falls back to the
         * passphrase as on iOS. False: the passphrase path, as today.
         */
        fun isAvailable(context: Context): Boolean {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return false
            return try {
                GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context, MIN_PLAY_SERVICES) == ConnectionResult.SUCCESS
            } catch (_: Exception) {
                false
            }
        }

        /** Play services 25.0.0 as an APK version code. */
        private const val MIN_PLAY_SERVICES = 250_000_000

        /** The Activity a Compose context wraps, which the system sheet needs. */
        tailrec fun activityOf(context: Context): Activity? = when (context) {
            is Activity -> context
            is ContextWrapper -> activityOf(context.baseContext)
            else -> null
        }
    }
}
