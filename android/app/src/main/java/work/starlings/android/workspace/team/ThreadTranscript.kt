package work.starlings.android.workspace.team

import work.starlings.android.Reactions
import work.starlings.contracts.ThreadMessageType
import work.starlings.contracts.ThreadMessageWire
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/*
 * `Sources/ThreadTranscript.swift`: how a conversation is arranged for
 * reading. Pure, so the JVM tests hold it.
 */

val ThreadMessageWire.isEvent: Boolean get() = type == ThreadMessageType.EVENT
val ThreadMessageWire.isWithdrawn: Boolean get() = deletedAt != null
val ThreadMessageWire.isPartial: Boolean get() = partial == true

val ThreadMessageWire.senderShortName: String
    get() {
        val n = senderName?.trim().orEmpty()
        if (n.isNotEmpty()) return n.split(' ').firstOrNull { it.isNotEmpty() } ?: n
        return senderEmail.substringBefore('@')
    }

/** One row of a transcript. */
sealed interface TranscriptRow {
    data class Day(val date: LocalDate) : TranscriptRow
    data object UnreadMark : TranscriptRow
    data class Message(val message: ThreadMessageWire, val grouped: Boolean) : TranscriptRow
    data class Event(val message: ThreadMessageWire) : TranscriptRow
    /** An agent's steps on its way to an answer, oldest first. */
    data class Trail(val steps: List<ThreadMessageWire>) : TranscriptRow
}

/** What a day divider says. */
sealed interface DayLabel {
    data object Today : DayLabel
    data object Yesterday : DayLabel
    /** Inside the last week: the weekday's name. */
    data class Weekday(val date: LocalDate) : DayLabel
    data class Date(val date: LocalDate) : DayLabel
}

object ThreadTranscript {
    /** THREAD_GROUPING_WINDOW_MS (fixtures/shared-constants.json). */
    const val GROUPING_WINDOW_MS = 5 * 60 * 1000L

    /**
     * Arrange messages for reading. [unreadBoundaryMs] is captured when the
     * conversation opens and held still. An event an agent in [agentEmails]
     * signed folds into its trail; any other event stays its own line.
     */
    fun rows(
        messages: List<ThreadMessageWire>,
        unreadBoundaryMs: Long?,
        agentEmails: Set<String> = emptySet(),
        zone: ZoneId = ZoneId.systemDefault(),
    ): List<TranscriptRow> {
        val rows = mutableListOf<TranscriptRow>()
        var lastDay: LocalDate? = null
        var previous: ThreadMessageWire? = null
        var markPlaced = false
        for (message in messages) {
            val day = Instant.ofEpochMilli(message.sentAt).atZone(zone).toLocalDate()
            if (lastDay != day) {
                rows += TranscriptRow.Day(day)
                lastDay = day
                previous = null
            }
            // Your own message is never something you came back to read.
            if (!markPlaced && unreadBoundaryMs != null && message.sentAt > unreadBoundaryMs && !message.isMine) {
                rows += TranscriptRow.UnreadMark
                markPlaced = true
                previous = null
            }
            if (message.isEvent) {
                previous = null
                if (message.senderEmail in agentEmails) {
                    val last = rows.lastOrNull()
                    if (last is TranscriptRow.Trail && last.steps.first().senderEmail == message.senderEmail) {
                        rows[rows.lastIndex] = TranscriptRow.Trail(last.steps + message)
                    } else {
                        rows += TranscriptRow.Trail(listOf(message))
                    }
                    continue
                }
                rows += TranscriptRow.Event(message)
                continue
            }
            rows += TranscriptRow.Message(message, isGrouped(message, previous))
            previous = message
        }
        return rows
    }

    /** A withdrawn line, another sender or another hand (`via`) starts a new turn. */
    private fun isGrouped(message: ThreadMessageWire, previous: ThreadMessageWire?): Boolean {
        previous ?: return false
        if (previous.isWithdrawn || message.isWithdrawn) return false
        if (previous.senderEmail != message.senderEmail) return false
        if (previous.via != message.via) return false
        return message.sentAt - previous.sentAt <= GROUPING_WINDOW_MS
    }

    /** m:ss since a moment, unpadded minutes, never hours. */
    fun elapsedLabel(sinceMs: Long, nowMs: Long): String {
        val seconds = maxOf(0L, (nowMs - sinceMs) / 1000)
        return "%d:%02d".format(seconds / 60, seconds % 60)
    }

    /** The meeting palette for a person's line; thumbs up alone on an agent's. */
    fun quickReactions(fromAgent: Boolean): List<String> = if (fromAgent) listOf(Reactions.palette.first()) else Reactions.palette

    fun dayLabel(date: LocalDate, today: LocalDate): DayLabel = when {
        date == today -> DayLabel.Today
        date == today.minusDays(1) -> DayLabel.Yesterday
        date.isAfter(today.minusDays(6)) && !date.isAfter(today) -> DayLabel.Weekday(date)
        else -> DayLabel.Date(date)
    }

    /** Union by id, sorted by time then id: a poll and a sent message often carry one row. */
    fun merge(current: List<ThreadMessageWire>, incoming: List<ThreadMessageWire>): List<ThreadMessageWire> {
        val byId = LinkedHashMap<String, ThreadMessageWire>()
        current.forEach { byId[it.id] = it }
        incoming.forEach { byId[it.id] = it }
        return byId.values.sortedWith(compareBy<ThreadMessageWire> { it.sentAt }.thenBy { it.id })
    }
}

/**
 * The agent turn of `MobileThreadView`: which agent a turn is open with,
 * whether it still runs, and where the standing reaction rail goes.
 */
object AgentTurn {
    /** The addressed agent in its DM; in a channel, the agent my latest line names. */
    fun addressedAgent(peerEmail: String?, messages: List<ThreadMessageWire>, agents: List<work.starlings.contracts.PeerWire>): work.starlings.contracts.PeerWire? {
        if (peerEmail != null) return agents.firstOrNull { it.email == peerEmail }
        val lastReal = messages.lastOrNull { !it.isEvent } ?: return null
        if (lastReal.isPartial) return agents.firstOrNull { it.email == lastReal.senderEmail }
        if (!lastReal.isMine) return null
        val named = lastReal.mentions.orEmpty()
        return agents.firstOrNull { it.email in named }
    }

    /** The last real line is mine, or the agent's answer is still streaming. */
    fun awaiting(agent: work.starlings.contracts.PeerWire?, messages: List<ThreadMessageWire>): Boolean {
        agent ?: return false
        val lastReal = messages.lastOrNull { !it.isEvent } ?: return false
        return lastReal.isMine || lastReal.isPartial
    }

    /** Busy with a `busy_until` still ahead: an elapsed TTL reads as not working. */
    fun isWorking(agent: work.starlings.contracts.PeerWire?, nowMs: Long): Boolean {
        agent ?: return false
        val until = agent.busyUntil ?: return false
        return agent.presence == PeerStatus.BUSY && until > nowMs
    }

    /** The working row shows while the agent works, or on trust for the grace after sending. */
    fun showsWorkingRow(agent: work.starlings.contracts.PeerWire?, messages: List<ThreadMessageWire>, nowMs: Long): Boolean {
        if (!awaiting(agent, messages)) return false
        if (isWorking(agent, nowMs)) return true
        val sentAt = messages.lastOrNull { !it.isEvent }?.sentAt ?: return false
        return nowMs - sentAt < TeamCadence.AGENT_ACCEPT_GRACE_MS
    }

    /** The latest answer from the addressed agent carries the rail until I react or write again. */
    fun persistentReactionMessageId(peerEmail: String?, messages: List<ThreadMessageWire>, agents: List<work.starlings.contracts.PeerWire>): String? {
        val email = peerEmail ?: return null
        if (agents.none { it.email == email }) return null
        val latest = messages.lastOrNull { !it.isEvent } ?: return null
        if (latest.senderEmail != email || latest.isWithdrawn || latest.isPartial) return null
        if (latest.reactions.orEmpty().any { it.isMine }) return null
        return latest.id
    }
}
