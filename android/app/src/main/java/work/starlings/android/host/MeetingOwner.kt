package work.starlings.android.host

import work.starlings.android.MeetingKinds
import work.starlings.android.api.HostRoutes
import work.starlings.android.api.StarlingsClient
import work.starlings.android.api.WorkRoutes
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import work.starlings.contracts.MeetingCategoryResponse
import work.starlings.contracts.MeetingCategoryUpdate
import work.starlings.contracts.MeetingKind
import work.starlings.contracts.Patch
import work.starlings.contracts.TranscriptViewResponse

/**
 * What the host of a meeting asks of it besides the lease: moderation
 * (`MobileParticipantsSheet`), filing (`MobileMeetingFilingView`) and the
 * record (`MobileTranscriptPanel`). Owner-only on the Worker, which checks
 * room ownership and the host lease again, so each call is a request.
 */
interface MeetingOwnerApi {
    /** A null [identity] mutes everyone but the host. */
    suspend fun mute(room: String, meetingId: String, identity: String?)
    suspend fun remove(room: String, meetingId: String, identity: String)
    suspend fun stopScreenShare(room: String, meetingId: String, identity: String)
    /** Every raised hand down (`lowerAllHands`); the room's attributes say when they are. */
    suspend fun lowerAllHands(room: String, meetingId: String)
    suspend fun category(room: String, meetingId: String): MeetingCategoryResponse
    suspend fun setCategory(room: String, meetingId: String, update: MeetingCategoryUpdate): MeetingCategoryResponse
    suspend fun transcript(room: String, meetingId: String): TranscriptViewResponse
    /** `crmSubjects`: the rows of [kind] that match [query], from Core through the Worker. */
    suspend fun subjects(kind: CrmSubjectKind, query: String): List<CrmSubjectWire>
}

/** [MeetingOwnerApi] over `OwnerAccount.client`. */
class ClientMeetingOwnerApi(private val client: StarlingsClient) : MeetingOwnerApi {
    override suspend fun mute(room: String, meetingId: String, identity: String?) { client.call(HostRoutes.mute(room, meetingId, identity)) }
    override suspend fun remove(room: String, meetingId: String, identity: String) { client.call(HostRoutes.remove(room, meetingId, identity)) }
    override suspend fun stopScreenShare(room: String, meetingId: String, identity: String) {
        client.call(HostRoutes.stopScreenShare(room, meetingId, identity))
    }
    override suspend fun lowerAllHands(room: String, meetingId: String) { client.call(HostRoutes.lowerAllHands(room, meetingId)) }
    override suspend fun category(room: String, meetingId: String) = client.call(HostRoutes.category(room, meetingId))
    override suspend fun setCategory(room: String, meetingId: String, update: MeetingCategoryUpdate) =
        client.call(HostRoutes.setCategory(room, meetingId, update))
    override suspend fun transcript(room: String, meetingId: String) = client.call(HostRoutes.transcript(room, meetingId))
    override suspend fun subjects(kind: CrmSubjectKind, query: String): List<CrmSubjectWire> =
        client.call(WorkRoutes.subjects(kind, query, null)).subjects.filter { it.kind == kind }
}

/**
 * The host's rows in People (`MobileParticipantsSheet.canModerate`): a host
 * moderates everyone but itself. Stopping your own share is a stage control,
 * not a moderation act.
 */
object Moderation {
    fun canModerate(isHost: Boolean, isLocal: Boolean): Boolean = isHost && !isLocal

    /** A screen share's tile is keyed `<identity>:screen` (`CallSession.tiles`). */
    fun isSharing(identity: String, tileKeys: Collection<String>): Boolean = "$identity:screen" in tileKeys
}

/**
 * Filing a hosted meeting (`MeetingCategoryKind` in Sources/MeetingCategory.swift):
 * the kinds the menu offers, the subject a kind is filed on, and the update a
 * save writes. The kinds are [MeetingKinds], the generated registry's order.
 */
object MeetingFiling {
    /** A subject the meeting is filed on, as the sheet holds it. */
    data class Subject(val id: String, val kind: CrmSubjectKind, val title: String)

    /** `filingMenu(offersPartner:current:)`: Event has no native picker, so it shows only on a meeting already filed that way. */
    fun menu(current: MeetingKind, offersPartner: Boolean = true): List<MeetingKind> = MeetingKind.known.filter { kind ->
        when (kind) {
            MeetingKind.PARTNER -> offersPartner || current == MeetingKind.PARTNER
            MeetingKind.EVENT -> current == MeetingKind.EVENT
            else -> true
        }
    }

    /** `subjectKind`: the subject a meeting of [kind] is filed on; null when it takes none. */
    fun subjectKind(kind: MeetingKind): CrmSubjectKind? =
        MeetingKinds.all.firstOrNull { it.kind == kind.value }?.subject?.let(::CrmSubjectKind)

    fun needsSubject(kind: MeetingKind): Boolean = subjectKind(kind) != null

    /** `MeetingCategory.subjectID`: the id of whichever subject the kind names. */
    fun subjectId(category: MeetingCategoryResponse): String? = when (category.meetingKind) {
        MeetingKind.LEAD -> category.leadId
        MeetingKind.PROJECT -> category.projectId
        MeetingKind.PARTNER -> category.partnerOrganizationId
        MeetingKind.EVENT -> category.eventId
        else -> null
    }

    /** What the sheet shows as filed when it opens: the title stands in for a missing id, as iOS. */
    fun subject(category: MeetingCategoryResponse): Subject? {
        val title = category.subjectTitle ?: return null
        val kind = subjectKind(category.meetingKind) ?: return null
        return Subject(subjectId(category) ?: title, kind, title)
    }

    /** `MeetingCategoryUpdate(meetingKind:subjectID:subjectTitle:)`: the kind decides which id field carries the subject. */
    fun update(kind: MeetingKind, subject: Subject?): MeetingCategoryUpdate {
        val id = subject?.id?.takeIf { needsSubject(kind) }
        return MeetingCategoryUpdate(
            meetingKind = kind,
            leadId = Patch.ifSome(id.takeIf { kind == MeetingKind.LEAD }),
            projectId = Patch.ifSome(id.takeIf { kind == MeetingKind.PROJECT }),
            eventId = Patch.ifSome(id.takeIf { kind == MeetingKind.EVENT }),
            partnerOrganizationId = Patch.ifSome(id.takeIf { kind == MeetingKind.PARTNER }),
            subjectTitle = Patch.ifSome(subject?.title),
        )
    }

    /**
     * `CrmSubject.meetingFiling`: Meet about this files the room under the
     * subject with the kind whose subject is that kind, else Project.
     */
    fun about(kind: CrmSubjectKind, id: String, title: String): MeetingCategoryUpdate {
        val meetingKind = MeetingKind.known.firstOrNull { subjectKind(it) == kind } ?: MeetingKind.PROJECT
        return update(meetingKind, Subject(id, kind, title))
    }

    /** Save waits for a subject when the kind needs one. */
    fun canSave(kind: MeetingKind, subject: Subject?, saving: Boolean): Boolean = !saving && (!needsSubject(kind) || subject != null)

    /** The search runs from two letters, as iOS. */
    const val MIN_QUERY = 2

    /** A beat of quiet before the search: Core is not a typeahead cache. */
    const val SEARCH_DEBOUNCE_MS = 300L

    /**
     * `UnfiledMeetingNotice`: nudge once when a hosted meeting ended
     * uncategorized. No category read means no nudge: a wrong nudge after
     * every meeting trains the host to dismiss it.
     */
    fun nudges(category: MeetingCategoryResponse?): Boolean = category?.meetingKind == MeetingKind.UNCATEGORIZED
}
