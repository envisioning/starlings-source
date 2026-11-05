package work.starlings.android.workspace.team

import work.starlings.contracts.ThreadMessageRef
import work.starlings.contracts.ThreadMessageRefKind
import work.starlings.contracts.ThreadMessageWire

/*
 * A subject channel's replies, its Mark as decision, and the ref chips
 * under an event line (`Sources/DirectMessages.swift`, `ThreadTranscript`,
 * `iOS/MobileThreadView.swift`). Pure, so the JVM tests hold them.
 */

/** `ThreadAddress.supportsMessageReplies`: replies are a subject channel's. */
val ThreadAddress.supportsMessageReplies: Boolean get() = target is ThreadTarget.Subject

/** `decisionSubject`: the channel's subject, where Mark as decision records. */
val ThreadAddress.decisionSubject: ThreadTarget.Subject? get() = target as? ThreadTarget.Subject

/** Save as Quick Note: your own line with text, never an event (`MessageRow.contextMenu`). */
val ThreadMessageWire.offersSaveAsQuickNote: Boolean get() = isMine && !isEvent && text.isNotEmpty()

/** `ThreadReplyDraft`: the next message's parent, only while it can still be replied to. */
data class ThreadReplyDraft(val parentMessageId: String? = null) {
    fun select(message: ThreadMessageWire): ThreadReplyDraft? = if (message.isReplyable) ThreadReplyDraft(message.id) else null

    /** Whether the parent is still in [messages] and replyable; true when there is none. */
    fun isValid(messages: List<ThreadMessageWire>): Boolean =
        parentMessageId == null || messages.any { it.id == parentMessageId && it.isReplyable }
}

/** What a ref chip says and where it leads (`ThreadMessageRef.chipTitle`, `githubURL`, `openLabel`). */
object RefChips {
    /** The chip's face: a word the screen says in its language, or the literal text. */
    sealed interface Title {
        data object Task : Title
        data object Meeting : Title
        data object Issue : Title
        data object Commit : Title
        data object Release : Title
        data class Literal(val text: String) : Title
    }

    /** Where a press goes, read by the screen against what it can open. */
    sealed interface Door {
        data class Task(val id: String) : Door
        data class Issue(val owner: String, val repo: String, val number: Long) : Door
        /** A decision or a goal: the subject's Overview lists both. */
        data object Overview : Door
        data class Web(val url: String) : Door
        data object None : Door
    }

    fun title(ref: ThreadMessageRef): Title = when (ref.kind) {
        ThreadMessageRefKind.TASK -> Title.Task
        ThreadMessageRefKind.MEETING -> Title.Meeting
        ThreadMessageRefKind.ISSUE, ThreadMessageRefKind.PULL -> ref.id.split('#').lastOrNull()?.let { Title.Literal("#$it") } ?: Title.Issue
        ThreadMessageRefKind.COMMIT -> ref.id.split('@').lastOrNull()?.let { Title.Literal(it.take(7)) } ?: Title.Commit
        ThreadMessageRefKind.RUN -> Title.Literal("CI")
        ThreadMessageRefKind.RELEASE -> ref.id.split('@').lastOrNull()?.let { Title.Literal(it) } ?: Title.Release
        else -> Title.Literal(ref.kind.value.replaceFirstChar { it.titlecase() })
    }

    /**
     * A task or an issue opens its reader, a decision or a goal lands on
     * Overview, a pull, commit, run or release opens github.com.
     */
    fun door(ref: ThreadMessageRef): Door = when (ref.kind) {
        ThreadMessageRefKind.TASK -> Door.Task(ref.id)
        ThreadMessageRefKind.ISSUE -> issue(ref.id) ?: Door.None
        ThreadMessageRefKind.DECISION, ThreadMessageRefKind.GOAL -> Door.Overview
        else -> githubUrl(ref)?.let { Door.Web(it) } ?: Door.None
    }

    /** `owner/repo#n`. */
    fun issue(id: String): Door.Issue? {
        val parts = id.split('#')
        if (parts.size != 2) return null
        val number = parts[1].toLongOrNull() ?: return null
        val slug = parts[0].split('/')
        if (slug.size != 2) return null
        return Door.Issue(slug[0], slug[1], number)
    }

    /** `githubURLForRef`: the github.com page a GitHub ref names; null for a meeting, a task, or an id that does not parse. */
    fun githubUrl(ref: ThreadMessageRef): String? {
        val separator = when (ref.kind) {
            ThreadMessageRefKind.ISSUE, ThreadMessageRefKind.PULL -> '#'
            ThreadMessageRefKind.RUN -> '!'
            ThreadMessageRefKind.COMMIT, ThreadMessageRefKind.RELEASE -> '@'
            else -> return null
        }
        val at = ref.id.lastIndexOf(separator)
        if (at <= 0) return null
        val slug = ref.id.substring(0, at).split('/').filter { it.isNotEmpty() }
        val rest = ref.id.substring(at + 1)
        if (slug.size != 2 || rest.isEmpty()) return null
        val base = "https://github.com/${slug[0]}/${slug[1]}"
        return when (ref.kind) {
            ThreadMessageRefKind.ISSUE -> "$base/issues/$rest"
            ThreadMessageRefKind.PULL -> "$base/pull/$rest"
            ThreadMessageRefKind.COMMIT -> "$base/commit/$rest"
            ThreadMessageRefKind.RUN -> "$base/actions/runs/$rest"
            ThreadMessageRefKind.RELEASE -> "$base/releases/tag/${java.net.URLEncoder.encode(rest, "UTF-8").replace("+", "%20")}"
            else -> null
        }
    }
}

/**
 * What a conversation opens from a chip: a task by id, an issue by its
 * reference, and Overview for a decision or a goal. Only a subject's own
 * page has an Overview, so elsewhere [showOverview] is null and those
 * chips stay labels, as iOS (`refSubject`, `onShowOverview`).
 */
class ThreadRefDoors(
    val openTask: (String) -> Unit,
    val openIssue: (owner: String, repo: String, number: Long) -> Unit,
    val showOverview: (() -> Unit)?,
)
