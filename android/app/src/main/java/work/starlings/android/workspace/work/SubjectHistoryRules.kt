package work.starlings.android.workspace.work

import work.starlings.android.ThreadMarkdown
import work.starlings.contracts.CrmInteraction
import work.starlings.contracts.CrmInteractionCreate
import work.starlings.contracts.CrmInteractionCreateType
import work.starlings.contracts.CrmInteractionType
import work.starlings.contracts.CrmInteractionUpdate
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.Patch
import work.starlings.contracts.ThreadMessageWire
import java.net.URI
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * `CrmInteractionFilter` (Sources/WorkInteractions.swift): History's type
 * menu. All types is the default; a narrowed filter shows that kind only.
 */
enum class InteractionFilter(val wire: String) {
    ALL("all"), MEETING("meeting"), EMAIL("email"), CALL("call"), WEB("web"), NOTE("note");

    fun matches(interaction: CrmInteraction): Boolean = this == ALL || wire == interaction.type.value
}

/**
 * History's timeline (`MobileSubjectInteractionsView.visibleGroups`):
 * interactions and the subject's event lines, newest first, grouped by
 * day. Pure, so the JVM tests hold it.
 */
object HistoryTimeline {
    sealed interface Entry {
        val id: String
        /** Epoch ms; null is a row with no date, which sorts last and groups as Undated. */
        val at: Long?

        data class Interaction(val interaction: CrmInteraction) : Entry {
            override val id: String get() = interaction.id
            override val at: Long? get() = date(interaction)
        }

        data class Event(val message: ThreadMessageWire) : Entry {
            override val id: String get() = message.id
            override val at: Long get() = message.sentAt
        }
    }

    /** A group's title, said by the screen: Today, Yesterday, the day, or Undated. */
    sealed interface Day {
        data object Today : Day
        data object Yesterday : Day
        data class On(val date: LocalDate, val at: Long) : Day
        data object Undated : Day
    }

    data class Group(val day: Day, val rows: List<Entry>)

    /** `CrmInteraction.date`: the first of `occurred_at` and `created_at` that is set, parsed. */
    fun date(interaction: CrmInteraction): Long? =
        listOf(interaction.occurredAt, interaction.createdAt).map { it?.trim().orEmpty() }.firstOrNull { it.isNotEmpty() }?.let { TaskDates.parse(it) }

    /** Events join only under All types: a narrowed filter asks for that kind alone. */
    fun groups(
        interactions: List<CrmInteraction>,
        events: List<ThreadMessageWire>,
        filter: InteractionFilter,
        today: LocalDate,
        zone: ZoneId = ZoneId.systemDefault(),
    ): List<Group> {
        val entries = interactions.filter(filter::matches).map<CrmInteraction, Entry>(Entry::Interaction) +
            if (filter == InteractionFilter.ALL) events.map(Entry::Event) else emptyList()
        val sorted = entries.sortedByDescending { it.at ?: Long.MIN_VALUE }
        val groups = LinkedHashMap<Day, MutableList<Entry>>()
        for (entry in sorted) {
            val day = day(entry.at, today, zone)
            groups.getOrPut(day) { mutableListOf() } += entry
        }
        return groups.map { (day, rows) -> Group(day, rows) }
    }

    private fun day(at: Long?, today: LocalDate, zone: ZoneId): Day {
        at ?: return Day.Undated
        val date = Instant.ofEpochMilli(at).atZone(zone).toLocalDate()
        return when (date) {
            today -> Day.Today
            today.minusDays(1) -> Day.Yesterday
            else -> Day.On(date, date.atStartOfDay(zone).toInstant().toEpochMilli())
        }
    }
}

/**
 * `CrmInteractionDraft` (Sources/WorkInteractions.swift): the
 * Log and Edit sheet's fields, and the two writes they become. A relation
 * carries its name so the picker can draw it; an id nobody named yet draws
 * as itself until the screen reads it.
 */
internal data class InteractionDraft(
    /** The row being edited; null on a new one. */
    val original: CrmInteraction?,
    val type: CrmInteractionType,
    val title: String,
    /** Epoch ms. */
    val occurredAt: Long,
    val summary: String,
    val url: String,
    val organization: Relation?,
    val lead: Relation?,
    val project: Relation?,
    val contacts: List<Relation>,
) {
    val isNew: Boolean get() = original == null

    /** Call, Meeting, Note, plus the row's own kind when a connector filed it. */
    val typeOptions: List<CrmInteractionType>
        get() {
            val own = original?.type
            return if (own == null || own in LOGGABLE) LOGGABLE else LOGGABLE + own
        }

    /** The relations whose name is still the id, for the screen to read once. */
    val unnamedLinks: List<Pair<CrmSubjectKind, String>>
        get() = listOf(CrmSubjectKind.ORGANIZATION to organization, CrmSubjectKind.LEAD to lead, CrmSubjectKind.PROJECT to project)
            .mapNotNull { (kind, option) -> option?.takeIf { it.name == it.id }?.let { kind to it.id } }

    /** Put a resolved name in place of its id. */
    fun named(kind: CrmSubjectKind, id: String, name: String): InteractionDraft {
        val option = Relation(id, name)
        return when (kind) {
            CrmSubjectKind.ORGANIZATION -> if (organization?.id == id) copy(organization = option) else this
            CrmSubjectKind.LEAD -> if (lead?.id == id) copy(lead = option) else this
            CrmSubjectKind.PROJECT -> if (project?.id == id) copy(project = option) else this
            else -> this
        }
    }

    /** Empty, or an http(s) address with a host: the Worker refuses anything else. */
    val hasValidLink: Boolean
        get() {
            val link = nonEmpty(url) ?: return true
            val lowered = link.lowercase()
            if (!lowered.startsWith("http://") && !lowered.startsWith("https://")) return false
            return runCatching { URI(link).host }.getOrNull()?.isNotEmpty() == true
        }

    /** A title, somewhere to file it, and a link the Worker takes. */
    val canSave: Boolean get() = title.trim().isNotEmpty() && (organization != null || lead != null || project != null) && hasValidLink

    val create: CrmInteractionCreate
        get() = CrmInteractionCreate(
            type = CrmInteractionCreateType(type.value),
            title = title.trim(),
            occurredAt = iso(occurredAt),
            summaryMarkdown = ifSome(nonEmpty(summary)),
            url = ifSome(nonEmpty(url)),
            organizationId = ifSome(organization?.id),
            leadId = ifSome(lead?.id),
            projectId = ifSome(project?.id),
            contactIds = contacts.map { it.id },
        )

    /**
     * Only what changed against the row as it was opened. A summary Core sent
     * only as a preview is not sent back, so an untouched field never clears it.
     */
    val update: CrmInteractionUpdate
        get() {
            val before = original?.let { editing(it) }
            fun <T> changed(now: T, was: T?): Boolean = before == null || now != was
            val summaryNow = nonEmpty(summary)
            val urlNow = nonEmpty(url)
            return CrmInteractionUpdate(
                type = type.takeIf { changed(it, before?.type) },
                title = title.trim().takeIf { changed(it, before?.title?.trim()) },
                occurredAt = iso(occurredAt).takeIf { changed(occurredAt, before?.occurredAt) },
                summaryMarkdown = if (changed(summaryNow, before?.let { nonEmpty(it.summary) })) Patch.of(summaryNow) else Patch.Omit,
                url = if (changed(urlNow, before?.let { nonEmpty(it.url) })) Patch.of(urlNow) else Patch.Omit,
                organizationId = if (changed(organization?.id, before?.organization?.id)) Patch.of(organization?.id) else Patch.Omit,
                leadId = if (changed(lead?.id, before?.lead?.id)) Patch.of(lead?.id) else Patch.Omit,
                projectId = if (changed(project?.id, before?.project?.id)) Patch.of(project?.id) else Patch.Omit,
                contactIds = contacts.map { it.id }.takeIf { changed(it, before?.contacts?.map { c -> c.id }) },
            )
        }

    companion object {
        /** The kinds a member logs by hand (`CRM_INTERACTION_MANUAL_TYPES`). */
        val LOGGABLE = listOf(CrmInteractionType.CALL, CrmInteractionType.MEETING, CrmInteractionType.NOTE)

        private val ISO = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSSX").withZone(ZoneOffset.UTC)

        /** `ISODate.format`: fractional seconds, UTC. */
        fun iso(ms: Long): String = ISO.format(Instant.ofEpochMilli(ms))

        private fun nonEmpty(value: String): String? = value.trim().takeIf { it.isNotEmpty() }

        private fun ifSome(value: String?): Patch<String> = value?.let { Patch.Value(it) } ?: Patch.Omit

        /**
         * A new one, filed where the History is: a project fills its project and
         * its organization, a lead its lead and organization, an organization itself.
         */
        fun new(subject: SubjectRef, organization: Relation?, now: Long = System.currentTimeMillis()): InteractionDraft {
            val own = Relation(subject.id, subject.title)
            return InteractionDraft(
                original = null, type = CrmInteractionType.CALL, title = "", occurredAt = now, summary = "", url = "",
                organization = when (subject.kind) {
                    CrmSubjectKind.ORGANIZATION -> own
                    CrmSubjectKind.PROJECT, CrmSubjectKind.LEAD -> organization
                    else -> null
                },
                lead = own.takeIf { subject.kind == CrmSubjectKind.LEAD },
                project = own.takeIf { subject.kind == CrmSubjectKind.PROJECT },
                contacts = emptyList(),
            )
        }

        /**
         * The row as it is. Names come from the subject the History is on where
         * the ids match; the rest are ids until resolved.
         */
        fun editing(interaction: CrmInteraction, subject: SubjectRef? = null, organization: Relation? = null): InteractionDraft {
            fun named(id: String?): Relation? {
                if (id.isNullOrEmpty()) return null
                if (subject != null && subject.id == id) return Relation(id, subject.title)
                if (organization != null && organization.id == id) return organization
                return Relation(id, id)
            }
            return InteractionDraft(
                original = interaction,
                type = interaction.type,
                title = ThreadMarkdown.plainText(interaction.title).trim(),
                occurredAt = HistoryTimeline.date(interaction) ?: System.currentTimeMillis(),
                summary = interaction.summaryMarkdown.orEmpty(),
                url = interaction.url.orEmpty(),
                organization = named(interaction.organizationId),
                lead = named(interaction.leadId),
                project = named(interaction.projectId),
                contacts = interaction.contacts.map { contact ->
                    Relation(contact.id, contact.name?.trim()?.takeIf { it.isNotEmpty() } ?: contact.email ?: contact.id)
                },
            )
        }
    }
}
