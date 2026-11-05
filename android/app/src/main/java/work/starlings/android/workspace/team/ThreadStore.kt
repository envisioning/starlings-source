package work.starlings.android.workspace.team

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import work.starlings.android.OwnerAccount
import work.starlings.android.api.StarlingsApiError
import work.starlings.android.api.TeamMediaRoutes
import work.starlings.android.api.TeamRoutes
import work.starlings.android.ThreadMarkdown
import work.starlings.android.keep.KeepSession
import work.starlings.contracts.AttachmentStageRequest
import work.starlings.contracts.LinkPreview
import work.starlings.contracts.ThreadKind
import work.starlings.contracts.ThreadMessageAttachment
import work.starlings.contracts.ThreadMessageWire
import work.starlings.contracts.ThreadReleaseAction
import work.starlings.contracts.ThreadSummaryWire
import java.time.Instant

/**
 * `iOS/MobileThreadStore.swift`: one open conversation, its messages, its
 * polling and its read receipt. Scoped to the screen: a store that outlived
 * it would poll a conversation nobody is reading.
 */
class ThreadStore(private val account: OwnerAccount) {
    companion object {
        /** Marks "Choose at least one option." in [questionErrors]; the screen says it in its own words. */
        const val QUESTION_EMPTY = "question.empty"
    }

    var messages by mutableStateOf<List<ThreadMessageWire>>(emptyList())
        private set
    var isLoading by mutableStateOf(false)
        private set
    var isSending by mutableStateOf(false)
        private set
    var canLoadOlder by mutableStateOf(false)
        private set
    var errorMessage by mutableStateOf<String?>(null)
    var isMuted by mutableStateOf(false)
        private set
    var isArchived by mutableStateOf(false)
        private set
    /** A DM only: a channel is a place, and leaving one is another verb. */
    var canArchive by mutableStateOf(false)
        private set
    /** Where the reader left off, captured on open and held still. */
    var unreadBoundaryMs by mutableStateOf<Long?>(null)
        private set
    var thread by mutableStateOf<ThreadSummaryWire?>(null)
        private set

    /** An agent question's options picked but not yet sent, by question message id. */
    var questionSelections by mutableStateOf<Map<String, Set<String>>>(emptyMap())
        private set
    var submittingQuestionIds by mutableStateOf<Set<String>>(emptySet())
        private set
    /** A question's own line under its options: [QUESTION_EMPTY] or a failure title. */
    var questionErrors by mutableStateOf<Map<String, String>>(emptyMap())
        private set

    /** Files uploaded and waiting for a message to carry them. */
    var pending by mutableStateOf<List<ThreadMessageAttachment>>(emptyList())
        private set
    var uploading by mutableStateOf(0)
        private set

    /** Set by the screen while a turn with an agent is open: the poll runs at the turn's cadence. */
    var isAgentTurnOpen = false

    private var olderCursor: String? = null
    private var cursorInitialized = false
    private val client get() = account.client
    private val media = TeamMedia(account)

    /** Pictures already drawn in this conversation, so scrolling back decodes nothing. */
    val pictures = android.util.LruCache<String, androidx.compose.ui.graphics.ImageBitmap>(24)

    suspend fun open(address: ThreadAddress) {
        isLoading = true
        try {
            val route = when (val t = address.target) {
                is ThreadTarget.Peer -> TeamRoutes.open(t.email)
                is ThreadTarget.Group -> TeamRoutes.open(t.emails)
                ThreadTarget.Team -> TeamRoutes.openChannel
                is ThreadTarget.Subject -> TeamRoutes.openSubject(t.kind, t.id)
            }
            val summary = client.call(route).thread
            thread = summary
            unreadBoundaryMs = if (summary.unread) summary.lastReadAt else null
            isMuted = summary.isMuted(System.currentTimeMillis())
            isArchived = summary.archivedAt != null
            canArchive = summary.kind == ThreadKind.DM
            reload()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            errorMessage = e.teamMessage()
        }
        isLoading = false
    }

    /** Four seconds while the screen is started, one while an agent's turn is open. */
    suspend fun poll(foreground: () -> Boolean) {
        while (true) {
            val cadence = when {
                isAgentTurnOpen && foreground() -> TeamCadence.AGENT_TURN_POLL_MS
                foreground() -> TeamCadence.OPEN_THREAD_POLL_MS
                else -> TeamCadence.BACKGROUND_THREAD_POLL_MS
            }
            delay(cadence)
            if (thread != null) reload()
        }
    }

    /** Newest page. Older history is merged in, so a reload never shortens the transcript. */
    suspend fun reload() {
        val id = thread?.id ?: return
        try {
            val page = client.call(TeamRoutes.messages(id))
            messages = ThreadTranscript.merge(messages, page.messages)
            if (!cursorInitialized) {
                olderCursor = page.olderCursor
                cursorInitialized = true
            }
            canLoadOlder = olderCursor != null
            errorMessage = null
            // Only when the server says there is something unread: not a write every four seconds.
            if (page.thread.unread) {
                try {
                    client.call(TeamRoutes.markRead(id))
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // Best effort: a missed read receipt costs one unread dot.
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (messages.isEmpty()) errorMessage = e.teamMessage()
        }
    }

    suspend fun loadOlder() {
        val id = thread?.id ?: return
        val cursor = olderCursor ?: return
        try {
            val page = client.call(TeamRoutes.messages(id, before = cursor))
            messages = ThreadTranscript.merge(messages, page.messages)
            olderCursor = page.olderCursor
            canLoadOlder = olderCursor != null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            errorMessage = e.teamMessage()
        }
    }

    /**
     * `loadOlder(until:)`: older pages until [until] is in the transcript,
     * for a reply's parent or a line a door named. False when history runs
     * out without it.
     */
    suspend fun loadOlder(until: String): Boolean {
        while (messages.none { it.id == until }) {
            if (olderCursor == null) return false
            val before = messages.size
            loadOlder()
            if (messages.size == before) return messages.any { it.id == until }
        }
        return true
    }

    /**
     * Mark as decision: the line becomes a decision on the
     * channel's subject, verbatim, with the message as its source. The route
     * writes the channel line, so it shows here on the next poll. Throws the
     * Worker's refusal.
     */
    suspend fun markAsDecision(message: ThreadMessageWire, subject: ThreadTarget.Subject) {
        client.call(
            work.starlings.android.api.SubjectRoutes.createDecision(
                work.starlings.contracts.CrmDecisionCreate(
                    subjectKind = subject.kind, subjectId = subject.id, body = message.text,
                    source = work.starlings.contracts.DecisionSource.MESSAGE, sourceRef = work.starlings.contracts.Patch.Value(message.id),
                ),
            ),
        )
    }

    /**
     * Save as Quick Note (`quickNotes.create(body:source: .work)`): your own
     * line, verbatim, into Quick Notes. The id is minted here, so a retry
     * cannot make two. Throws the Worker's refusal.
     */
    suspend fun saveAsQuickNote(message: ThreadMessageWire) {
        val body = message.text.trim()
        if (body.isEmpty()) return
        client.call(
            work.starlings.android.api.WorkExtraRoutes.createQuickNote(
                body, java.util.UUID.randomUUID().toString().lowercase(), System.currentTimeMillis(),
            ),
        )
    }

    /**
     * False when the message never left, so the composer hands the text back.
     * [alone] sends the text as its own message and leaves the staged files
     * where they are: what is on the clipboard is not the message being written.
     */
    suspend fun send(text: String, mentions: List<String>, alone: Boolean = false, replyToMessageId: String? = null): Boolean {
        val id = thread?.id ?: return false
        val trimmed = text.trim()
        // A message with no text and no file is a keystroke.
        if (trimmed.isEmpty() && (alone || pending.isEmpty())) return false
        isSending = true
        val files = if (alone) emptyList() else pending.map { it.id }
        try {
            val sent = client.call(TeamRoutes.send(id, trimmed, mentions = mentions, attachments = files, replyToMessageId = replyToMessageId)).message
            if (!alone) pending = emptyList()
            messages = ThreadTranscript.merge(messages, listOf(sent))
            errorMessage = null
            return true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            errorMessage = e.teamMessage()
            return false
        } finally {
            isSending = false
        }
    }

    fun selectQuestionOption(message: ThreadMessageWire, optionId: String, selected: Boolean) {
        val question = message.question ?: return
        questionSelections = questionSelections + (message.id to QuestionSelection.select(question, questionSelections[message.id].orEmpty(), optionId, selected))
        questionErrors = questionErrors - message.id
    }

    /** The Worker answers the committed winner, which may be somebody else's answer. */
    suspend fun answerQuestion(message: ThreadMessageWire) {
        val id = thread?.id ?: return
        val question = message.question ?: return
        if (message.id in submittingQuestionIds) return
        val chosen = QuestionSelection.submitted(question, questionSelections[message.id].orEmpty())
        if (chosen.isEmpty()) {
            questionErrors = questionErrors + (message.id to QUESTION_EMPTY)
            return
        }
        submittingQuestionIds = submittingQuestionIds + message.id
        questionErrors = questionErrors - message.id
        try {
            val answer = client.call(TeamMediaRoutes.answerQuestion(id, message.id, chosen))
            messages = ThreadTranscript.merge(messages, listOf(answer.message))
            questionSelections = questionSelections - message.id
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            questionErrors = questionErrors + (message.id to e.teamMessage())
        } finally {
            submittingQuestionIds = submittingQuestionIds - message.id
        }
    }

    /** Release cards with a call in flight, by message id. */
    var releaseBusyIds by mutableStateOf<Set<String>>(emptySet())
        private set
    /** A release card's own error line, by message id. */
    var releaseErrors by mutableStateOf<Map<String, String>>(emptyMap())
        private set

    /** Ask the card to record what Keep did. Keep has it already; the Worker checks Keep. */
    suspend fun recordRelease(messageId: String, action: ThreadReleaseAction) {
        val id = thread?.id ?: return
        val answer = client.call(TeamMediaRoutes.updateRelease(id, messageId, action))
        messages = ThreadTranscript.merge(messages, listOf(answer.message))
        releaseErrors = releaseErrors - messageId
    }

    /** End now: Keep first, then the card. Needs no unlock; ending opens nothing. */
    suspend fun endRelease(message: ThreadMessageWire, keep: KeepSession) {
        val request = message.releaseRequest ?: return
        val state = message.releaseState ?: return
        if (message.id in releaseBusyIds) return
        releaseBusyIds = releaseBusyIds + message.id
        releaseErrors = releaseErrors - message.id
        try {
            keep.endRelease(state.vaultId, request.requestId)
            recordRelease(message.id, ThreadReleaseAction.END)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            releaseErrors = releaseErrors + (message.id to e.teamMessage())
        } finally {
            releaseBusyIds = releaseBusyIds - message.id
        }
    }

    /** Upload, then hold until a message carries it. Uploading is not sending: a staged file nobody sends is read by nothing. */
    suspend fun attach(name: String, contentType: String, data: ByteArray, width: Long?, height: Long?) {
        val id = thread?.id ?: return
        uploading += 1
        try {
            val staged = client.call(TeamMediaRoutes.stageAttachment(id, AttachmentStageRequest(name, contentType, data.size.toLong(), width, height)))
            media.upload(TeamMediaRoutes.uploadAttachment(staged.uploadPath), data, contentType)
            pending = pending + staged.attachment
            errorMessage = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            errorMessage = e.teamMessage()
        } finally {
            uploading -= 1
        }
    }

    /** Taken off the message only: the bytes stay staged and unreferenced, inert. */
    fun drop(attachment: ThreadMessageAttachment) {
        pending = pending.filterNot { it.id == attachment.id }
    }

    /** One attachment's bytes, for drawing or opening it. Throws, so an open can say why not. */
    suspend fun attachmentData(attachment: ThreadMessageAttachment): ByteArray {
        val id = thread?.id ?: throw StarlingsApiError.SignedOut("Couldn’t open that file")
        return media.bytesOrThrow(TeamMediaRoutes.attachment(id, attachment.id), TeamMedia.ATTACHMENT_MAX_BYTES)
    }

    private val previews = HashMap<String, LinkPreview?>()

    /**
     * The card for a message's first https link, read by the Worker. A link
     * it cannot read is a link, not an error; the answer is kept either way.
     */
    suspend fun linkPreview(text: String): LinkPreview? {
        val link = ThreadMarkdown.firstPreviewableLink(text) ?: return null
        if (previews.containsKey(link)) return previews[link]
        val preview = try {
            client.call(TeamMediaRoutes.linkPreview(link)).preview
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
        previews[link] = preview
        return preview
    }

    /** A card's picture, from the Worker's own signed address only. */
    suspend fun previewImage(url: String): ByteArray? = media.previewImage(url)

    /** The rail comes back from the Worker, never guessed at. */
    suspend fun react(message: ThreadMessageWire, emoji: String) {
        val id = thread?.id ?: return
        try {
            val answer = client.call(TeamRoutes.react(id, message.id, emoji))
            messages = messages.map { if (it.id == message.id) it.copy(reactions = answer.reactions) else it }
            errorMessage = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            errorMessage = e.teamMessage()
        }
    }

    suspend fun edit(message: ThreadMessageWire, text: String): Boolean {
        val id = thread?.id ?: return false
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return false
        return try {
            client.call(TeamRoutes.edit(id, message.id, trimmed))
            reload()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            errorMessage = e.teamMessage()
            false
        }
    }

    suspend fun withdraw(message: ThreadMessageWire) {
        val id = thread?.id ?: return
        try {
            client.call(TeamRoutes.withdraw(id, message.id))
            reload()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            errorMessage = e.teamMessage()
        }
    }

    /** Muted for a week rather than forever. */
    suspend fun toggleMute() {
        val id = thread?.id ?: return
        val until = if (isMuted) null else Instant.now().plusMillis(TeamCadence.MUTE_MS)
        try {
            client.call(TeamRoutes.mute(id, until))
            isMuted = until != null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            errorMessage = e.teamMessage()
        }
    }

    /** Put away or taken back. Anything said in it later brings it back by itself. */
    suspend fun toggleArchive() {
        val id = thread?.id ?: return
        val archived = !isArchived
        try {
            client.call(TeamRoutes.archive(id, archived))
            isArchived = archived
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            errorMessage = e.teamMessage()
        }
    }
}
