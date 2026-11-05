package work.starlings.android.workspace.work

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import work.starlings.contracts.CrmContactsQuery
import work.starlings.contracts.CrmContactsQuerySignalsOutreachStatus
import java.util.Locale

/**
 * `ContactListFilter` (`Sources/ContactListFilter.swift`), held to
 * `fixtures/contact-query.json`: Core's contact list filters,
 * kept on this device under the Mac's key. A filter is sent only when set;
 * padding is trimmed; a country code is upper case; the group always asks
 * for the facets.
 */
@Serializable
data class ContactFilter(
    val organizationId: String? = null,
    val organizationName: String? = null,
    val country: String? = null,
    val partner: Boolean = false,
    val existingClient: Boolean = false,
    /** A `CrmContactsQuerySignalsOutreachStatus` value. */
    val signalsOutreachStatus: String? = null,
    val preferredLanguage: String? = null,
) {
    val isDefault: Boolean
        get() = organizationId == null && trimmed(country) == null && !partner && !existingClient &&
            signalsOutreachStatus == null && trimmed(preferredLanguage) == null

    /** `CrmContactsQuery.list(query:filter:)`. */
    fun query(search: String): CrmContactsQuery = CrmContactsQuery(
        q = trimmed(search),
        organizationId = organizationId,
        country = trimmed(country)?.uppercase(Locale.ROOT),
        partner = if (partner) true else null,
        existingClient = if (existingClient) true else null,
        signalsOutreachStatus = signalsOutreachStatus?.let(::CrmContactsQuerySignalsOutreachStatus),
        preferredLanguage = trimmed(preferredLanguage),
        facets = true,
    )

    /** What [save] writes: nothing for the default, so a reset forgets. */
    fun encoded(): String? = if (isDefault) null else json.encodeToString(serializer(), this)

    companion object {
        /** `meet.workSidebar.filter.contacts`, the key the Mac and iOS keep it under. */
        const val KEY = "meet.workSidebar.filter.contacts"
        val outreach: List<String> = CrmContactsQuerySignalsOutreachStatus.known.map { it.value }
        private val json = Json { ignoreUnknownKeys = true }

        fun trimmed(value: String?): String? = value?.trim()?.takeIf { it.isNotEmpty() }

        /** A saved filter, or the default when none was kept or it cannot be read. */
        fun decoded(text: String?): ContactFilter = text?.let { runCatching { json.decodeFromString(serializer(), it) }.getOrNull() } ?: ContactFilter()

        /** `ContactFieldText.country`: the region's name in the reader's language, or the code. */
        fun countryName(code: String, locale: Locale = Locale.getDefault()): String =
            Locale("", code.uppercase(Locale.ROOT)).getDisplayCountry(locale).takeIf { it.isNotEmpty() && !it.equals(code, ignoreCase = true) } ?: code

        /** `ContactFieldText.language`. */
        fun languageName(code: String, locale: Locale = Locale.getDefault()): String =
            Locale(code).getDisplayLanguage(locale).takeIf { it.isNotEmpty() && !it.equals(code, ignoreCase = true) } ?: code
    }
}
