package work.starlings.android

import android.content.Context
import android.os.Build
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * One file sealed with a non-exportable Android Keystore AES-GCM key: the
 * mechanism `KeystoreSessionVault` (OwnerSession.kt) uses for the owner
 * session. The file lives in `noBackupFilesDir/<folder>/<name>.bin`, so
 * neither backup nor a device-to-device transfer copies it. The Keep and
 * Core tokens each keep one, each under a key of its own ([alias]).
 *
 * Nothing here logs the bytes it seals or opens.
 */
class SealedFile(context: Context, folder: String, name: String, private val alias: String) {
    private val dir = File(context.noBackupFilesDir, folder).apply { mkdirs() }
    private val sealed = File(dir, "$name.bin")

    /** The opened bytes, or null when there is no file or it does not open. */
    fun read(): ByteArray? {
        if (!sealed.exists()) return null
        return runCatching {
            val bytes = sealed.readBytes()
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_BYTES))
            cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES)
        }.getOrNull()
    }

    /** Seals [bytes] and replaces the file in one rename. */
    fun write(bytes: ByteArray) {
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
        val body = cipher.doFinal(bytes)
        val temp = File(dir, "${sealed.name}.tmp")
        temp.writeBytes(cipher.iv + body)
        if (!temp.renameTo(sealed)) error("sealed: could not replace ${sealed.name}")
    }

    fun delete() {
        sealed.delete()
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    companion object {
        private const val KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12

        /** The file name a token takes for one Starlings API: its SHA-256 in hex. */
        fun nameFor(apiEndpoint: String): String =
            MessageDigest.getInstance("SHA-256").digest(apiEndpoint.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}

/** The name a brokered token is minted under (`Meet — <device>` on the service): the device name, else the maker and model. */
fun deviceName(context: Context): String =
    Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() }
        ?: "${Build.MANUFACTURER} ${Build.MODEL}"
