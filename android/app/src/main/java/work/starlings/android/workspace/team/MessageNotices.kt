package work.starlings.android.workspace.team

import work.starlings.android.workspace.home.HomeLinks
import work.starlings.contracts.ThreadSummaryWire

/** One "somebody wrote to you" banner, decided before any Android notification type exists. */
data class MessageNotice(
    val threadId: String,
    val peerEmail: String,
    /** The conversation's name, or null for "Conversation". */
    val title: String?,
    /** The last line, or null for "New message". */
    val body: String?,
    val sentAtMs: Long,
    /** Where the tap goes: the conversation's web path (`HomeLinks.thread`), handed to the workspace navigator. */
    val path: String,
)

/**
 * `MessageNotices.plan` of `iOS/MessageNotices.swift`: which conversations
 * announce a new message. These fire only while the app runs and polls;
 * there is no push, so never call them push in copy.
 */
object MessageNotices {
    /** How far before the last poll a never-seen thread's newest message may be and still count as new. */
    const val NEW_THREAD_CLOCK_ALLOWANCE_MS = 60_000L

    /** `MessageNotificationPreferences.defaultValue`: a channel notifies only when it names you. */
    const val NOTIFY_ON_ALL_CHANNEL_MESSAGES_DEFAULT = false

    data class Plan(val notices: List<MessageNotice>, val seen: Map<String, Long>)

    /** `ThreadSummary.shouldNotifyLocally`: a DM or a group always; a channel when it names you, unless widened. */
    fun shouldNotify(thread: ThreadSummaryWire, notifyOnAllChannelMessages: Boolean): Boolean {
        if (!thread.unread) return false
        if (!thread.kind.isChannel) return true
        return thread.hasMention || notifyOnAllChannelMessages
    }

    /**
     * The first poll ([previousObservationMs] null) records and announces
     * nothing: a banner per old unread conversation is news about history.
     * After that, a thread announces when its newest message is newer than
     * the one seen, or, for a thread never seen, written after the last poll
     * less [NEW_THREAD_CLOCK_ALLOWANCE_MS]. The open conversation never does.
     */
    fun plan(
        threads: List<ThreadSummaryWire>,
        seen: Map<String, Long>,
        activeThreadId: String?,
        previousObservationMs: Long?,
        notifyOnAllChannelMessages: Boolean = NOTIFY_ON_ALL_CHANNEL_MESSAGES_DEFAULT,
    ): Plan {
        val updated = seen.toMutableMap()
        val notices = mutableListOf<MessageNotice>()
        for (thread in threads) {
            val last = thread.lastMessageAt ?: continue
            val previous = seen[thread.id]
            updated[thread.id] = last
            if (thread.id == activeThreadId) continue
            if (!shouldNotify(thread, notifyOnAllChannelMessages)) continue
            previousObservationMs ?: continue
            if (previous != null) {
                if (last <= previous) continue
            } else if (last <= previousObservationMs - NEW_THREAD_CLOCK_ALLOWANCE_MS) {
                continue
            }
            notices += MessageNotice(thread.id, thread.peerEmail.orEmpty(), thread.displayTitle, thread.lastMessagePreview, last, HomeLinks.thread(thread))
        }
        return Plan(notices, updated)
    }
}
