package work.starlings.android.workspace.work

import work.starlings.contracts.CrmContact
import work.starlings.contracts.CrmContactCreate
import work.starlings.contracts.CrmContactDetail
import work.starlings.contracts.CrmContactUpdate
import work.starlings.contracts.Patch
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The contact editor's rules (`MobileContactEditorView.save`): the four
 * fields of `FormFieldRegistry.contact` (`fixtures/form-fields.json`) and
 * the edit or the new contact they send. On an edit a blank title or no
 * organization clears it on the Worker; on a new contact they are left
 * out. The addresses always go whole, an empty list clearing them.
 */
object ContactForm {
    /** One field's rule: its id, whether a save needs it, and how long it may be. */
    data class Spec(val id: String, val label: String, val required: Boolean, val maxLength: Int?)

    val name = Spec("name", "Name", required = true, maxLength = 200)
    val title = Spec("title", "Title", required = false, maxLength = 200)
    val organization = Spec("organization", "Organization", required = false, maxLength = null)
    val emails = Spec("emails", "Addresses, one per line", required = false, maxLength = null)

    /** `FormFieldRegistry.emails`: one per line, or split by a comma or semicolon, lower case, blanks dropped. */
    fun emails(text: String): List<String> =
        text.split('\n', ',', ';').map { it.trim().lowercase(Locale.ROOT) }.filter { it.isNotEmpty() }

    /** `FormFieldRegistry.problem` over name and title: the first required blank, then the first one too long. */
    fun problem(name: String, title: String): LeadForm.Problem? {
        val values = listOf(ContactForm.name to name, ContactForm.title to title)
        values.firstOrNull { (spec, value) -> spec.required && value.trim().isEmpty() }?.let { return LeadForm.Problem.Required(it.first.label) }
        values.firstOrNull { (spec, value) -> spec.maxLength != null && value.trim().length > spec.maxLength }
            ?.let { return LeadForm.Problem.TooLong(it.first.label, it.first.maxLength!!) }
        return null
    }

    /** The edit: the name always, the title and organization as the table says a blank goes, then the profile's changes. */
    fun update(
        name: String,
        title: String,
        organizationId: String?,
        addresses: String,
        profile: ContactProfileDraft,
        initial: ContactProfileDraft?,
    ): CrmContactUpdate = profile.apply(
        CrmContactUpdate(
            name = name.trim(),
            title = title.trim().takeIf { it.isNotEmpty() }?.let { Patch.Value(it) } ?: Patch.Null,
            organizationId = organizationId?.let { Patch.Value(it) } ?: Patch.Null,
            emails = emails(addresses),
        ),
        initial,
    )

    /** A new contact: the name, the title and organization only when set, the addresses whole, then what the profile sets. */
    fun create(
        name: String,
        title: String,
        organizationId: String?,
        addresses: String,
        profile: ContactProfileDraft,
    ): CrmContactCreate = profile.apply(
        CrmContactCreate(
            name = name.trim(),
            title = title.trim().takeIf { it.isNotEmpty() }?.let { Patch.Value(it) } ?: Patch.Omit,
            organizationId = organizationId?.let { Patch.Value(it) } ?: Patch.Omit,
            emails = emails(addresses),
        ),
    )
}

/**
 * `MobileContactMergeView`: the duplicate is picked from a
 * contact search without the contact being merged into, and the Worker
 * keeps the older one, which can be the duplicate.
 */
object ContactMerge {
    /** The search's rows as (id, name), without [own]. */
    fun candidates(rows: List<CrmContact>, own: String): List<Pair<String, String>> =
        rows.filter { it.id != own }.map { it.id to (ContactLines.name(it) ?: it.id) }

    /** The id the page reads after a merge: the one the Worker kept. */
    fun survivor(current: String, kept: String): String? = kept.takeIf { it != current }

    /** The ids a merge deleted: the answer's `merged`, never the one it kept. These leave the recents. */
    fun mergedAway(answer: work.starlings.contracts.CoreMergeResponseData): List<String> = answer.merged.filter { it != answer.kept }.distinct()
}

/**
 * `Sources/ContactProfileDraft.swift`: the birthday, characteristics,
 * preferred language and Signals status. An edit sends only
 * what changed from the contact as it was read.
 */
data class ContactProfileDraft(
    val birthdayMonth: Int? = null,
    val birthdayDay: Int? = null,
    val birthdayYear: Int? = null,
    /** Every name the contact carries, true or false; the editor toggles them. */
    val characteristics: Map<String, Boolean> = emptyMap(),
    val preferredLanguage: String = "en",
    val signalsOutreachStatus: String? = null,
) {
    /** A birthday needs a month and a day; the year is optional. Null when it is valid. English, as an error. */
    val birthdayProblem: String?
        get() = when {
            birthdayMonth == null && birthdayDay == null -> if (birthdayYear == null) null else NEEDS_MONTH_AND_DAY
            birthdayMonth == null || birthdayDay == null -> NEEDS_MONTH_AND_DAY
            birthdayMonth !in 1..12 || birthdayDay !in 1..31 -> NOT_A_DATE
            birthdayYear != null && birthdayYear !in 1900..2100 -> YEAR_RANGE
            else -> null
        }

    /** No month clears the whole birthday; a month starts the day at 1. */
    fun withMonth(month: Int?): ContactProfileDraft =
        if (month == null) copy(birthdayMonth = null, birthdayDay = null, birthdayYear = null)
        else copy(birthdayMonth = month, birthdayDay = birthdayDay ?: 1)

    /** The year as digits, at most four; an empty field is no year. */
    fun withYear(text: String): ContactProfileDraft =
        copy(birthdayYear = text.filter(Char::isDigit).take(4).takeIf { it.isNotEmpty() }?.toInt())

    /** Off drops a name the contact did not carry, so an unchanged set sends nothing. */
    fun withCharacteristic(name: String, on: Boolean, initial: ContactProfileDraft?): ContactProfileDraft =
        if (on || initial?.characteristics?.containsKey(name) == true) copy(characteristics = characteristics + (name to on))
        else copy(characteristics = characteristics - name)

    /** The fields that differ from [original] (null: from a blank draft), written into [update]. */
    fun apply(update: CrmContactUpdate, original: ContactProfileDraft?): CrmContactUpdate {
        val base = original ?: ContactProfileDraft()
        var next = update
        if (birthdayMonth != base.birthdayMonth) next = next.copy(birthdayMonth = patch(birthdayMonth))
        if (birthdayDay != base.birthdayDay) next = next.copy(birthdayDay = patch(birthdayDay))
        if (birthdayYear != base.birthdayYear) next = next.copy(birthdayYear = patch(birthdayYear))
        if (characteristics != base.characteristics) {
            next = next.copy(characteristics = if (characteristics.isEmpty()) Patch.Null else Patch.Value(characteristics))
        }
        if (preferredLanguage != base.preferredLanguage) next = next.copy(preferredLanguage = preferredLanguage)
        if (signalsOutreachStatus != base.signalsOutreachStatus) {
            next = next.copy(signalsOutreachStatus = signalsOutreachStatus?.let { Patch.Value(it) } ?: Patch.Null)
        }
        return next
    }

    /** A new contact's profile: only what is set, and the language when it is not English. */
    fun apply(create: CrmContactCreate): CrmContactCreate {
        var next = create
        birthdayMonth?.let { next = next.copy(birthdayMonth = Patch.Value(it.toLong())) }
        birthdayDay?.let { next = next.copy(birthdayDay = Patch.Value(it.toLong())) }
        birthdayYear?.let { next = next.copy(birthdayYear = Patch.Value(it.toLong())) }
        if (characteristics.isNotEmpty()) next = next.copy(characteristics = Patch.Value(characteristics))
        if (preferredLanguage != "en") next = next.copy(preferredLanguage = preferredLanguage)
        signalsOutreachStatus?.let { next = next.copy(signalsOutreachStatus = Patch.Value(it)) }
        return next
    }

    private fun patch(value: Int?): Patch<Long> = value?.let { Patch.Value(it.toLong()) } ?: Patch.Null

    companion object {
        const val NEEDS_MONTH_AND_DAY = "Choose a month and a day for the birthday."
        const val NOT_A_DATE = "That birthday is not a date."
        const val YEAR_RANGE = "Use a year from 1900 to 2100."

        /** `ContactProfileDraft(contact:)`. */
        fun of(contact: CrmContactDetail) = ContactProfileDraft(
            birthdayMonth = contact.birthdayMonth?.toInt(),
            birthdayDay = contact.birthdayDay?.toInt(),
            birthdayYear = contact.birthdayYear?.toInt(),
            characteristics = contact.characteristics.orEmpty(),
            preferredLanguage = ContactFilter.trimmed(contact.preferredLanguage) ?: "en",
            signalsOutreachStatus = ContactFilter.trimmed(contact.signalsOutreachStatus),
        )

        /** The characteristic names the editor offers: the vocabulary and any other the contact carries, sorted. */
        fun characteristicNames(options: List<String>, contact: Map<String, Boolean>): List<String> = (options.toSet() + contact.keys).sorted()
    }
}

/** `ContactFieldText`'s characteristic and birthday lines. */
object ContactFieldText {
    /** A stored name as a label: `board_member` reads "Board member". */
    fun characteristic(name: String): String {
        val words = name.replace('_', ' ').trim()
        if (words.isEmpty()) return name
        return words.first().uppercase() + words.drop(1)
    }

    /** Day and month in the reader's locale, with the year when known; null when it is not a date. */
    fun birthday(month: Int?, day: Int?, year: Int?, locale: Locale = Locale.getDefault()): String? {
        if (month == null || day == null || month !in 1..12 || day !in 1..31) return null
        val date = runCatching { LocalDate.of(year ?: 2000, month, day) }.getOrNull() ?: return null
        val pattern = android.text.format.DateFormat.getBestDateTimePattern(locale, if (year == null) "dMMMM" else "dMMMMy")
        return DateTimeFormatter.ofPattern(pattern, locale).format(date)
    }
}
