package work.starlings.android.workspace.work

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectsQuery

/**
 * `OrganizationListFilter` (`Sources/MeetingCategory.swift`), held to the
 * organization cases of `fixtures/subject-query.json`: Core's organization
 * list filters. Partner is on by default; only what differs
 * from the default is sent; padding is trimmed. Kept on the device under
 * the Mac's key.
 */
@Serializable
data class OrganizationFilter(
    val partner: Boolean = true,
    val agency: Boolean = false,
    @SerialName("existingClient") val existingClient: Boolean = false,
    val industry: String? = null,
    val country: String? = null,
) {
    val isDefault: Boolean
        get() = partner && !agency && !existingClient && ContactFilter.trimmed(industry) == null && ContactFilter.trimmed(country) == null

    /** `CrmSubjectsQuery.browse(kind:query:organizations:)`: a filter only on an organization. */
    fun query(kind: CrmSubjectKind, search: String): CrmSubjectsQuery {
        val q = search.trim().ifEmpty { null }
        if (kind != CrmSubjectKind.ORGANIZATION) return CrmSubjectsQuery(kind = kind, q = q)
        return CrmSubjectsQuery(
            kind = kind,
            q = q,
            partner = if (partner) null else false,
            agency = if (agency) true else null,
            existingClient = if (existingClient) true else null,
            industry = ContactFilter.trimmed(industry),
            country = ContactFilter.trimmed(country),
        )
    }

    /** `snapshotTag`: the filter's own query, so a filtered page never paints the default one. Null for the default. */
    val snapshotTag: String?
        get() = if (isDefault) null else query(CrmSubjectKind.ORGANIZATION, "").queryItems().drop(1).joinToString("&") { (k, v) -> "$k=$v" }

    fun encoded(): String? = if (isDefault) null else json.encodeToString(serializer(), this)

    companion object {
        /** `meet.workSidebar.filter.organizations`. */
        const val KEY = "meet.workSidebar.filter.organizations"
        private val json = Json { ignoreUnknownKeys = true }

        fun decoded(text: String?): OrganizationFilter =
            text?.let { runCatching { json.decodeFromString(serializer(), it) }.getOrNull() } ?: OrganizationFilter()
    }
}
