package work.starlings.android.workspace.work

import work.starlings.contracts.CrmContact
import work.starlings.contracts.CrmContactDetail
import work.starlings.contracts.CrmSubjectKind

/** How a contact reads on a row and its page (`CrmContact.displayName`, `.context`, `organizationSubject`). */
object ContactLines {
    /** The name; the address when there is none; null when there is neither (the caller says Unnamed). */
    fun name(name: String?, email: String?): String? = name?.trim()?.takeIf { it.isNotEmpty() } ?: email

    /** What they do and where: the title and the organization. */
    fun context(title: String?, organization: String?): String =
        listOfNotNull(title, organization).map { it.trim() }.filter { it.isNotEmpty() }.joinToString(" · ")

    fun name(contact: CrmContact): String? = name(contact.name, contact.email)
    fun context(contact: CrmContact): String = context(contact.title, contact.organizationName)
    fun name(contact: CrmContactDetail): String? = name(contact.name, contact.email)
    fun context(contact: CrmContactDetail): String = context(contact.title, contact.organizationName)

    /** The organization they work at, as a subject page can open it. */
    fun organization(contact: CrmContactDetail): SubjectRef? {
        val id = contact.organizationId ?: return null
        val title = contact.organizationName?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return SubjectRef(CrmSubjectKind.ORGANIZATION, id, title)
    }

    /** The count beside the Contacts header: "12", or "50+" when Core holds more. */
    fun count(rows: Int, hasMore: Boolean): String = if (hasMore) "$rows+" else "$rows"
}
