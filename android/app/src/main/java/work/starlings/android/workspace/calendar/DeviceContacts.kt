package work.starlings.android.workspace.calendar

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.ContactsContract
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.Collator

/** `MobileContactSuggestion`: one address the phone's Contacts knows, with the name it files it under. */
data class ContactSuggestion(val name: String, val email: String) {
    val id: String get() = email.lowercase()
}

/**
 * `MobileContacts` (`iOS/MobileContacts.swift`): the phone's Contacts as
 * guest completions for the schedule composer and the event editor. Nothing
 * leaves the phone: the rows are read when a sheet opens and kept only while
 * it is open.
 */
object DeviceContacts {
    /**
     * One row per address, lowercased, the first name it was found under;
     * sorted by name, case-insensitive. A row whose name is only its address
     * has no name, as a Contacts card with no name and no company.
     */
    fun suggestions(rows: List<Pair<String?, String?>>, locale: java.util.Locale = java.util.Locale.getDefault()): List<ContactSuggestion> {
        val seen = LinkedHashMap<String, ContactSuggestion>()
        for ((rawName, rawEmail) in rows) {
            val email = rawEmail?.trim()?.lowercase().orEmpty()
            if ("@" !in email) continue
            val name = rawName?.trim().orEmpty().let { if (it.equals(email, ignoreCase = true)) "" else it }
            seen.putIfAbsent(email, ContactSuggestion(name, email))
        }
        val collator = Collator.getInstance(locale).apply { strength = Collator.SECONDARY }
        return seen.values.sortedWith { a, b -> collator.compare(a.name, b.name) }
    }

    /** The composer's completions: the name or the address holds what is typed, not already a guest; five at most. */
    fun matching(contacts: List<ContactSuggestion>, typed: String, guests: Collection<String>): List<ContactSuggestion> {
        val query = typed.trim().lowercase()
        if (query.isEmpty()) return emptyList()
        return contacts
            .filter { (it.name.lowercase().contains(query) || it.email.contains(query)) && it.email !in guests }
            .take(5)
    }

    /**
     * `matchPendingInvitees`: the names Quick add read after "with", each to the
     * first contact whose name is that name or starts with it and a space.
     * Addresses already invited are not added twice.
     */
    fun matchNames(contacts: List<ContactSuggestion>, names: List<String>, attendees: List<String>): List<String> {
        val out = attendees.toMutableList()
        for (name in names) {
            val needle = name.trim().lowercase()
            if (needle.isEmpty()) continue
            val match = contacts.firstOrNull { it.name.lowercase() == needle || it.name.lowercase().startsWith("$needle ") } ?: continue
            if (match.email !in out) out += match.email
        }
        return out
    }

    fun granted(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED

    /** Every address in the phone's Contacts. Empty without access or on any failure, as iOS. */
    suspend fun load(context: Context): List<ContactSuggestion> = withContext(Dispatchers.IO) {
        if (!granted(context)) return@withContext emptyList()
        runCatching {
            val rows = mutableListOf<Pair<String?, String?>>()
            context.contentResolver.query(
                ContactsContract.CommonDataKinds.Email.CONTENT_URI,
                arrayOf(
                    ContactsContract.CommonDataKinds.Email.DISPLAY_NAME_PRIMARY,
                    ContactsContract.CommonDataKinds.Email.ADDRESS,
                ),
                null, null, null,
            )?.use { cursor ->
                while (cursor.moveToNext()) rows += cursor.getString(0) to cursor.getString(1)
            }
            suggestions(rows)
        }.getOrDefault(emptyList())
    }

    internal const val ASKED_KEY = "meet.contacts.asked"
}

/**
 * The Contacts prompt where iOS asks it: the first time a guest field opens
 * (the schedule composer or the event editor) with access never decided.
 * iOS asks once; so does this, and a later open reads what was granted.
 * Access granted in system Settings reads at the next open.
 */
@Composable
fun rememberDeviceContacts(): State<List<ContactSuggestion>> {
    val context = LocalContext.current
    val contacts = remember { mutableStateOf<List<ContactSuggestion>>(emptyList()) }
    val prefs = remember { context.getSharedPreferences("calendar", Context.MODE_PRIVATE) }
    val reload = remember { mutableStateOf(0) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { reload.value++ }
    LaunchedEffect(reload.value) {
        if (!DeviceContacts.granted(context) && !prefs.getBoolean(DeviceContacts.ASKED_KEY, false)) {
            prefs.edit().putBoolean(DeviceContacts.ASKED_KEY, true).apply()
            ask.launch(Manifest.permission.READ_CONTACTS)
            return@LaunchedEffect
        }
        contacts.value = DeviceContacts.load(context)
    }
    return contacts
}
