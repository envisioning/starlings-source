package work.starlings.android.keep

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import java.security.spec.PKCS8EncodedKeySpec
import java.text.Normalizer
import java.util.Base64
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// The Kotlin half of Keep's crypto: a third implementation of
// `envisioning/keep` `packages/crypto/src/index.ts`, byte for byte the
// construction of core-kit `KeepKit/KeepCrypto.swift`. `KeepCryptoTest`
// opens every blob in `vectors.json` (a copy of Keep's) with the keys given.
//
//   staff keypair     ECDH P-256. Public key on the wire is the raw x9.63
//                     point (65 bytes); private key is PKCS#8 DER.
//   wrap to a person  ECIES: ephemeral P-256, ECDH, HKDF-SHA256 (salt =
//                     ephemeral ‖ recipient, info = suite label), AES-256-GCM
//                     with the recipient's public key as AAD.
//   private key       AES-256-GCM under a wrapping key from a passkey's PRF
//                     output (HKDF) or a passphrase (PBKDF2-SHA256).
//   vault key         32 random bytes.
//   item              JSON body, AES-256-GCM, AAD = `vault:item:version`.
//   release           one item body under a one-time key, AAD =
//                     `release:<release>:<vault>:<item>`.
//
// Platform crypto only (java.security, javax.crypto). HKDF is not a JCA
// primitive, so it is the two HMAC steps of RFC 5869 here. PBKDF2 is also
// HMAC by hand: the JCA factory takes a char[] and each provider picks its
// own byte encoding, while Keep's input is the UTF-8 of the NFKC string.
// Nothing here logs, puts a plaintext in an error, or keeps a key past the
// call. Holding keys in memory is `KeepSession`'s job.

/** Why a Keep operation failed. Deliberately one message for a wrong key and tampered data. */
class KeepCryptoError(val kind: Kind) : Exception(kind.message) {
    enum class Kind(val message: String) {
        BAD_ENCODING("Malformed data."),
        BAD_KEY("Malformed key."),
        CANNOT_OPEN("Could not open: wrong key or tampered data."),
        ITERATIONS_BELOW_FLOOR("PBKDF2 iterations below the floor."),
    }
}

/** A P-256 private key in memory, with the raw public point it makes. */
class KeepPrivateKey internal constructor(internal val key: ECPrivateKey, val publicKeyRaw: ByteArray) {
    /** The public key as the wire carries it: the x9.63 point, base64url. */
    val publicKey: String get() = KeepCrypto.base64URL(publicKeyRaw)

    override fun toString(): String = "KeepPrivateKey(…)"
}

/** A 32-byte symmetric key. */
class KeepSymmetricKey internal constructor(internal val bytes: ByteArray) {
    override fun toString(): String = "KeepSymmetricKey(…)"
}

object KeepCrypto {
    private val infoWrap = "${KeepSuite.CURRENT}/wrap-to-public-key".toByteArray()
    private val infoPRF = "${KeepSuite.CURRENT}/prf-wrapping-key".toByteArray()
    private val privateKeyAAD = "${KeepSuite.CURRENT}/staff-private-key".toByteArray()
    private val random = SecureRandom()

    // MARK: Encoding

    fun base64URL(data: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(data)

    /** Accepts base64url with or without padding, and the standard alphabet, as Swift does. */
    fun data(base64URL: String): ByteArray {
        val normalised = base64URL.replace('+', '-').replace('/', '_').trimEnd('=')
        return try {
            Base64.getUrlDecoder().decode(normalised)
        } catch (_: IllegalArgumentException) {
            throw KeepCryptoError(KeepCryptoError.Kind.BAD_ENCODING)
        }
    }

    fun randomBytes(count: Int): ByteArray = ByteArray(count).also { random.nextBytes(it) }

    /** The PRF salt every enrolment and unlock passes to the authenticator. */
    val prfSalt: ByteArray get() = KeepSuite.PRF_SALT_LABEL.toByteArray()

    // MARK: HMAC, HKDF, PBKDF2

    private fun hmac(key: ByteArray, vararg parts: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        // An empty HMAC key is legal (RFC 2104) but SecretKeySpec refuses one; HMAC pads it to zeros anyway.
        mac.init(SecretKeySpec(if (key.isEmpty()) ByteArray(64) else key, "HmacSHA256"))
        parts.forEach(mac::update)
        return mac.doFinal()
    }

    /** RFC 5869 HKDF-SHA256, at most one block (32 bytes) of output: all Keep asks for. */
    internal fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int = 32): ByteArray {
        require(length in 1..32)
        val prk = hmac(salt, ikm)
        return hmac(prk, info, byteArrayOf(1)).copyOf(length)
    }

    /** PBKDF2-HMAC-SHA256 over raw bytes, one 32-byte block. */
    internal fun pbkdf2(password: ByteArray, salt: ByteArray, iterations: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(if (password.isEmpty()) ByteArray(64) else password, "HmacSHA256"))
        mac.update(salt)
        mac.update(byteArrayOf(0, 0, 0, 1))
        var u = mac.doFinal()
        val out = u.copyOf()
        for (round in 1 until iterations) {
            u = mac.doFinal(u)
            for (i in out.indices) out[i] = (out[i].toInt() xor u[i].toInt()).toByte()
        }
        return out
    }

    // MARK: AES-GCM

    private fun seal(plaintext: ByteArray, key: ByteArray, aad: ByteArray): KeepSealed {
        val iv = randomBytes(12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        cipher.updateAAD(aad)
        return KeepSealed(iv = base64URL(iv), ciphertext = base64URL(cipher.doFinal(plaintext)))
    }

    private fun open(sealed: KeepSealed, key: ByteArray, aad: ByteArray): ByteArray {
        val iv = data(sealed.iv)
        val combined = data(sealed.ciphertext)
        if (combined.size < 16 || iv.size != 12) throw KeepCryptoError(KeepCryptoError.Kind.CANNOT_OPEN)
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            cipher.updateAAD(aad)
            cipher.doFinal(combined)
        } catch (_: AEADBadTagException) {
            throw KeepCryptoError(KeepCryptoError.Kind.CANNOT_OPEN)
        } catch (_: java.security.GeneralSecurityException) {
            throw KeepCryptoError(KeepCryptoError.Kind.CANNOT_OPEN)
        }
    }

    // MARK: P-256

    private val curve: ECParameterSpec by lazy {
        AlgorithmParameters.getInstance("EC").run {
            init(ECGenParameterSpec("secp256r1"))
            getParameterSpec(ECParameterSpec::class.java)
        }
    }

    private fun fixed32(value: BigInteger): ByteArray {
        val raw = value.toByteArray()
        return when {
            raw.size == 32 -> raw
            raw.size > 32 -> raw.copyOfRange(raw.size - 32, raw.size)
            else -> ByteArray(32 - raw.size) + raw
        }
    }

    private fun raw(point: ECPoint): ByteArray = byteArrayOf(4) + fixed32(point.affineX) + fixed32(point.affineY)

    private fun publicKey(raw: ByteArray): ECPublicKey {
        if (raw.size != 65 || raw[0] != 4.toByte()) throw KeepCryptoError(KeepCryptoError.Kind.BAD_KEY)
        val point = ECPoint(BigInteger(1, raw.copyOfRange(1, 33)), BigInteger(1, raw.copyOfRange(33, 65)))
        if (!P256.onCurve(point)) throw KeepCryptoError(KeepCryptoError.Kind.BAD_KEY)
        return try {
            KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, curve)) as ECPublicKey
        } catch (_: java.security.GeneralSecurityException) {
            throw KeepCryptoError(KeepCryptoError.Kind.BAD_KEY)
        }
    }

    private fun publicKey(base64: String): ECPublicKey = publicKey(data(base64))

    fun generateStaffKeypair(): KeepPrivateKey {
        val generator = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1"), random) }
        val pair = generator.generateKeyPair()
        return KeepPrivateKey(pair.private as ECPrivateKey, raw((pair.public as ECPublicKey).w))
    }

    /**
     * PKCS#8 DER with the public key inside, the 138 bytes CryptoKit's
     * `derRepresentation` and WebCrypto's `exportKey('pkcs8')` produce.
     */
    fun exportPrivateKey(key: KeepPrivateKey): ByteArray =
        PKCS8_PREFIX + fixed32(key.key.s) + PKCS8_MIDDLE + key.publicKeyRaw

    fun importPrivateKey(pkcs8: ByteArray): KeepPrivateKey {
        val key = try {
            KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(pkcs8)) as ECPrivateKey
        } catch (_: Exception) {
            throw KeepCryptoError(KeepCryptoError.Kind.BAD_KEY)
        }
        val d = key.s
        if (d.signum() <= 0 || d >= P256.n) throw KeepCryptoError(KeepCryptoError.Kind.BAD_KEY)
        // The public half from the scalar, so a PKCS#8 without its optional public key imports too.
        val public = raw(P256.multiplyG(d))
        // Re-made from the scalar alone: one shape whatever provider parsed it.
        val normalised = KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(d, curve)) as ECPrivateKey
        return KeepPrivateKey(normalised, public)
    }

    // MARK: Wrapping the private key

    fun wrappingKey(prfOutput: ByteArray, hkdfSalt: ByteArray): KeepSymmetricKey =
        KeepSymmetricKey(hkdf(prfOutput, hkdfSalt, infoPRF))

    fun wrappingKey(passphrase: String, salt: ByteArray, iterations: Int): KeepSymmetricKey {
        if (iterations < KeepSuite.PBKDF2_ITERATIONS) throw KeepCryptoError(KeepCryptoError.Kind.ITERATIONS_BELOW_FLOOR)
        // `precomposedStringWithCompatibilityMapping` is NFKC.
        val password = Normalizer.normalize(passphrase, Normalizer.Form.NFKC).toByteArray(Charsets.UTF_8)
        return KeepSymmetricKey(pbkdf2(password, salt, iterations))
    }

    fun wrapPrivateKey(key: KeepPrivateKey, prfOutput: ByteArray, credentialId: String): Pair<KeepSealed, KeepWrapParams> {
        val hkdfSalt = randomBytes(32)
        val wrapped = seal(exportPrivateKey(key), wrappingKey(prfOutput, hkdfSalt).bytes, privateKeyAAD)
        return wrapped to KeepWrapParams.prf(credentialId, base64URL(hkdfSalt))
    }

    fun wrapPrivateKey(key: KeepPrivateKey, passphrase: String): Pair<KeepSealed, KeepWrapParams> {
        val salt = randomBytes(32)
        val wrapping = wrappingKey(passphrase, salt, KeepSuite.PBKDF2_ITERATIONS)
        val wrapped = seal(exportPrivateKey(key), wrapping.bytes, privateKeyAAD)
        return wrapped to KeepWrapParams.passphrase(base64URL(salt), KeepSuite.PBKDF2_ITERATIONS)
    }

    fun unwrapPrivateKey(wrapped: KeepSealed, wrappingKey: KeepSymmetricKey): KeepPrivateKey =
        importPrivateKey(open(wrapped, wrappingKey.bytes, privateKeyAAD))

    // MARK: Wrapping a symmetric key to a public key (ECIES)

    private fun ecdhWrappingKey(privateKey: ECPrivateKey, publicKey: ECPublicKey, ephemeralRaw: ByteArray, recipientRaw: ByteArray): ByteArray {
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(privateKey)
        agreement.doPhase(publicKey, true)
        val shared = agreement.generateSecret()
        return hkdf(shared, ephemeralRaw + recipientRaw, infoWrap)
    }

    fun wrapKey(keyBytes: ByteArray, toPublicKey: String): KeepWrappedKey {
        val recipientRaw = data(toPublicKey)
        val recipient = publicKey(recipientRaw)
        val ephemeral = generateStaffKeypair()
        val wrapping = ecdhWrappingKey(ephemeral.key, recipient, ephemeral.publicKeyRaw, recipientRaw)
        val sealed = seal(keyBytes, wrapping, recipientRaw)
        return KeepWrappedKey(ephemeralPublicKey = ephemeral.publicKey, iv = sealed.iv, ciphertext = sealed.ciphertext)
    }

    fun unwrapKey(wrapped: KeepWrappedKey, privateKey: KeepPrivateKey, ownPublicKey: String): ByteArray {
        val ephemeralRaw = data(wrapped.ephemeralPublicKey)
        val ephemeral = publicKey(ephemeralRaw)
        val ownRaw = data(ownPublicKey)
        val wrapping = ecdhWrappingKey(privateKey.key, ephemeral, ephemeralRaw, ownRaw)
        return open(KeepSealed(wrapped.iv, wrapped.ciphertext), wrapping, ownRaw)
    }

    // MARK: Recovery: two shares, both required

    /** XOR split: share A is random, share B = secret ⊕ A. Either alone is noise. */
    fun splitSecret(secret: ByteArray): Pair<ByteArray, ByteArray> {
        val a = randomBytes(secret.size)
        return a to ByteArray(secret.size) { (secret[it].toInt() xor a[it].toInt()).toByte() }
    }

    fun joinShares(a: ByteArray, b: ByteArray): ByteArray {
        if (a.size != b.size) throw KeepCryptoError(KeepCryptoError.Kind.BAD_ENCODING)
        return ByteArray(a.size) { (a[it].toInt() xor b[it].toInt()).toByte() }
    }

    fun formatShare(label: String, share: ByteArray): String = "keep-recovery-$label:${base64URL(share)}"

    /** Parses `keep-recovery-A:…` or `keep-recovery-B:…`; whitespace tolerated. */
    fun parseShare(text: String): Pair<String, ByteArray> {
        val trimmed = text.trim()
        val colon = trimmed.indexOf(':')
        if (!trimmed.startsWith("keep-recovery-") || colon < 0) throw KeepCryptoError(KeepCryptoError.Kind.BAD_ENCODING)
        val label = trimmed.substring("keep-recovery-".length, colon)
        if (label != "A" && label != "B") throw KeepCryptoError(KeepCryptoError.Kind.BAD_ENCODING)
        return label to data(trimmed.substring(colon + 1))
    }

    // MARK: Vault keys and items

    fun generateVaultKey(): ByteArray = randomBytes(32)

    fun vaultKey(raw: ByteArray): KeepSymmetricKey {
        if (raw.size != 32) throw KeepCryptoError(KeepCryptoError.Kind.BAD_KEY)
        return KeepSymmetricKey(raw.copyOf())
    }

    private fun itemAAD(vaultId: String, itemId: String, keyVersion: Int) = "$vaultId:$itemId:$keyVersion".toByteArray()

    fun sealItem(body: KeepItemBody, vaultKey: KeepSymmetricKey, vaultId: String, itemId: String, keyVersion: Int): KeepSealed =
        seal(KeepJson.encodeToString(KeepItemBody.serializer(), body).toByteArray(), vaultKey.bytes, itemAAD(vaultId, itemId, keyVersion))

    fun openItem(sealed: KeepSealed, vaultKey: KeepSymmetricKey, vaultId: String, itemId: String, keyVersion: Int): KeepItemBody =
        decodeBody(open(sealed, vaultKey.bytes, itemAAD(vaultId, itemId, keyVersion)))

    private fun decodeBody(plaintext: ByteArray): KeepItemBody = try {
        KeepJson.decodeFromString(KeepItemBody.serializer(), plaintext.decodeToString())
    } catch (_: Exception) {
        throw KeepCryptoError(KeepCryptoError.Kind.BAD_ENCODING)
    }

    // MARK: Releases (KeepRelease.swift)

    private fun releaseAAD(releaseId: String, vaultId: String, itemId: String) = "release:$releaseId:$vaultId:$itemId".toByteArray()

    /** The approving device's half: seal the opened body under a fresh release key and wrap that key to the agent's session key. */
    fun sealRelease(body: KeepItemBody, sessionPublicKey: String, releaseId: String, vaultId: String, itemId: String): Pair<KeepSealed, KeepWrappedKey> {
        val releaseKey = randomBytes(32)
        val sealed = seal(KeepJson.encodeToString(KeepItemBody.serializer(), body).toByteArray(), releaseKey, releaseAAD(releaseId, vaultId, itemId))
        return sealed to wrapKey(releaseKey, sessionPublicKey)
    }

    /** The agent's half: unwrap the release key with the session private key, then open the body. */
    fun openRelease(sealed: KeepSealed, wrappedKey: KeepWrappedKey, sessionPrivateKey: KeepPrivateKey, sessionPublicKey: String, releaseId: String, vaultId: String, itemId: String): KeepItemBody {
        val releaseKey = unwrapKey(wrappedKey, sessionPrivateKey, sessionPublicKey)
        return decodeBody(open(sealed, releaseKey, releaseAAD(releaseId, vaultId, itemId)))
    }

    // The fixed parts of a P-256 PKCS#8 with its public key: version 0, id-ecPublicKey with
    // prime256v1, then ECPrivateKey { 1, d (32), [1] publicKey (65) }.
    private val PKCS8_PREFIX = hex("308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420")
    private val PKCS8_MIDDLE = hex("a144034200")

    private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}

/**
 * The curve's arithmetic, for the one thing JCA does not offer: the public
 * point of a private scalar (an imported PKCS#8 may omit it). Affine
 * double-and-add over BigInteger; it runs once per unlock, never on a
 * secret-dependent timing path an attacker can watch from off the device.
 */
internal object P256 {
    val p = BigInteger("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", 16)
    val a: BigInteger = p - BigInteger.valueOf(3)
    val b = BigInteger("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", 16)
    val n = BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16)
    private val gx = BigInteger("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296", 16)
    private val gy = BigInteger("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5", 16)

    fun onCurve(point: ECPoint): Boolean {
        val x = point.affineX
        val y = point.affineY
        if (x.signum() < 0 || x >= p || y.signum() < 0 || y >= p) return false
        return y.multiply(y).subtract(x.pow(3).add(a.multiply(x)).add(b)).mod(p).signum() == 0
    }

    fun multiplyG(k: BigInteger): ECPoint {
        var result: Pair<BigInteger, BigInteger>? = null
        var addend: Pair<BigInteger, BigInteger>? = gx to gy
        for (i in 0 until k.bitLength()) {
            if (k.testBit(i)) result = add(result, addend)
            addend = add(addend, addend)
        }
        val (x, y) = result ?: throw KeepCryptoError(KeepCryptoError.Kind.BAD_KEY)
        return ECPoint(x, y)
    }

    private fun add(p1: Pair<BigInteger, BigInteger>?, p2: Pair<BigInteger, BigInteger>?): Pair<BigInteger, BigInteger>? {
        if (p1 == null) return p2
        if (p2 == null) return p1
        val (x1, y1) = p1
        val (x2, y2) = p2
        val slope = if (x1 == x2) {
            if (y1.add(y2).mod(p).signum() == 0) return null
            x1.multiply(x1).multiply(BigInteger.valueOf(3)).add(a).multiply(y1.shiftLeft(1).modInverse(p)).mod(p)
        } else {
            y2.subtract(y1).multiply(x2.subtract(x1).modInverse(p)).mod(p)
        }
        val x3 = slope.multiply(slope).subtract(x1).subtract(x2).mod(p)
        val y3 = slope.multiply(x1.subtract(x3)).subtract(y1).mod(p)
        return x3 to y3
    }
}
