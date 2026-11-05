package work.starlings.android

import work.starlings.contracts.LinkPreview
import android.os.SystemClock
import io.livekit.android.room.Room
import io.livekit.android.room.datastream.StreamTextOptions
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.participant.RemoteParticipant
import io.livekit.android.room.track.DataPublishReliability
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.util.UUID

/** `fixtures/shared-constants.json`, pinned by `RulesFixtureTest`. */
object Contracts {
    const val CAPTION_TOPIC = "captions.v1"
    const val MODERATION_TOPIC = "moderation.v1"
    const val HOST_TOPIC = "host.v1"
    const val REACTION_TOPIC = "reactions.v1"
    const val CHAT_REACTION_TOPIC = "chat-reactions.v1"
    val identityDomains = Deployment.IDENTITY_DOMAINS
    const val LIVE_TRANSCRIPT_HISTORY_LINES = 500

    /** `publicWebOrigin`, `servedWebOrigin` and `workspaceHostSuffix` in shared-constants.json. */
    const val PUBLIC_WEB_ORIGIN = Deployment.PUBLIC_WEB_ORIGIN
    const val SERVED_WEB_ORIGIN = Deployment.SERVED_WEB_ORIGIN
    const val WORKSPACE_HOST_SUFFIX = Deployment.WORKSPACE_HOST_SUFFIX

    /** `workspaceMarkMaxBytes`: the largest mark an admin may upload, and the most the app reads. */
    const val WORKSPACE_MARK_MAX_BYTES = 262_144

    /** `nativeLinkScheme` and `legacyNativeLinkScheme`: `starlings://`, and `meet://` from before the rename. */
    const val NATIVE_LINK_SCHEME = "starlings"
    const val LEGACY_NATIVE_LINK_SCHEME = "meet"

    /** LiveKit components' chat: a text stream, plus the legacy packet older clients read. */
    const val CHAT_TOPIC = "lk.chat"
    const val LEGACY_CHAT_TOPIC = "lk-chat-topic"

    /** `HAND_STALE_AFTER_MS` in packages/contracts/src/hands.ts. */
    const val HAND_STALE_AFTER_MS = 60 * 60 * 1000L
    const val HAND_ATTRIBUTE = "hand"
    const val HOST_ATTRIBUTE = "host"

    /** `LiveKitMeetingSession.sendChat`: the Swift limit. */
    const val CHAT_MAX_BYTES = 8_000
    const val CHAT_REACTION_MIN_INTERVAL_MS = 120L
    const val CHAT_REACTION_MAX_PER_MESSAGE = 4

    /** `CaptionMessage.acceptsPublisherIdentity`: a verified domain address, never a guest. */
    fun acceptsCaptionPublisher(identity: String?): Boolean {
        val normalized = identity?.trim()?.lowercase() ?: return false
        if (normalized.startsWith("guest:")) return false
        val at = normalized.lastIndexOf('@')
        if (at <= 0) return false
        val local = normalized.substring(0, at)
        if (local.contains('@') || local.contains(' ')) return false
        return normalized.substring(at + 1) in identityDomains
    }

    /** `handRaisedAt`: tolerant, a value it cannot read is a lowered hand. */
    fun handRaisedAt(value: String?): Long? = value?.toLongOrNull()?.takeIf { it > 0 }
}

/** `participantMetadataSchema`, stamped by the Worker at mint, read-only after. */
@Serializable
private data class ParticipantMetadata(
    val owner: Boolean = false,
    val client: GuestClient? = null,
    val recording: Boolean? = null,
    val registered: Boolean? = null,
)

data class ParticipantFacts(
    val client: String?,
    val notetaker: Boolean,
    val registered: Boolean,
    /** The raw client, for its icon. */
    val app: GuestClient? = null,
)

object ParticipantClient {
    private val json = Json { ignoreUnknownKeys = true }

    /** Tolerant, as Swift: metadata it cannot read is no facts, never a throw. */
    fun facts(metadata: String?): ParticipantFacts {
        val m = metadata?.let { runCatching { json.decodeFromString(ParticipantMetadata.serializer(), it) }.getOrNull() }
            ?: return ParticipantFacts(null, false, false)
        return ParticipantFacts(m.client?.let(::badge), m.recording == true, m.registered == true, m.client)
    }

    /** `GuestClient.badge` in Sources/MeetingParticipantClient.swift. */
    fun badge(client: GuestClient): String = when (client.app) {
        "web" -> "Web"
        "mac" -> "Mac app"
        "ios" -> if (client.device == "tablet") "iPad app" else "iPhone app"
        "android" -> "Android app"
        else -> client.app
    }
}

data class ChatMessage(
    val id: String,
    val atMs: Long,
    val from: String,
    val isLocal: Boolean,
    val text: String,
    /** emoji to the identities that put it on. */
    val reactions: Map<String, Set<String>> = emptyMap(),
)

data class Caption(val id: String, val speaker: String, val text: String, val final: Boolean, val startsAtMs: Long)

data class FlyingReaction(val key: Long, val emoji: String, val from: String, val startedAt: Long)

@Serializable
private data class LegacyChat(
    val id: String,
    val timestamp: Long,
    val message: String,
    val ignoreLegacy: Boolean? = null,
)

@Serializable
private data class ReactionPacket(val version: Int, val emoji: String)

@Serializable
private data class ChatReactionPacket(
    val version: Int,
    @SerialName("message_id") val messageId: String,
    val emoji: String,
    val on: Boolean,
)

@Serializable
private data class CaptionSegment(
    val id: String,
    @SerialName("speaker_name") val speakerName: String,
    val text: String,
    @SerialName("is_final") val isFinal: Boolean,
    @SerialName("starts_at_ms") val startsAtMs: Long,
)

@Serializable
private data class CaptionPacket(val version: Int, val segment: CaptionSegment)

@Serializable
private data class ModerationPacket(val version: Int, val type: String, val by: String)

/**
 * The guest's in-call features, on the same wire as web and iOS: chat
 * (`lk.chat` text stream plus the legacy packet), emoji reactions, chat
 * reactions, raised hands (through the Worker), received captions and host
 * moderation notices. Nothing here is stored: a late joiner has missed it.
 */
class Meeting(
    private val context: android.content.Context,
    private val room: Room,
    private val scope: CoroutineScope,
    private val api: LobbyApi,
    private val slug: String,
    private val details: ConnectionDetails,
    private val log: CallLog,
) {
    private val json = Json { ignoreUnknownKeys = true }

    private val _chat = MutableStateFlow<List<ChatMessage>>(emptyList())
    val chat: StateFlow<List<ChatMessage>> = _chat.asStateFlow()
    private val _unread = MutableStateFlow(0)
    val unread: StateFlow<Int> = _unread.asStateFlow()
    private val _captions = MutableStateFlow<List<Caption>>(emptyList())
    val captions: StateFlow<List<Caption>> = _captions.asStateFlow()
    private val _flying = MutableStateFlow<List<FlyingReaction>>(emptyList())
    val flying: StateFlow<List<FlyingReaction>> = _flying.asStateFlow()
    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()

    var chatOpen = false
        set(value) {
            field = value
            if (value) _unread.value = 0
        }

    private var lastReactionAt = 0L
    private var lastChatReactionAt = 0L
    private val lastReactionFrom = mutableMapOf<String, Long>()
    private var flyingKey = 0L

    fun start() {
        room.registerTextStreamHandler(Contracts.CHAT_TOPIC) { receiver, identity ->
            scope.launch {
                val text = receiver.flow.toList().joinToString("")
                val sender = room.remoteParticipants[identity]
                addChat(receiver.info.id, receiver.info.timestampMs, nameOf(sender, identity.value), false, text)
            }
        }
    }

    fun stop() {
        runCatching { room.unregisterTextStreamHandler(Contracts.CHAT_TOPIC) }
    }

    /** Every data packet the room receives. [from] is null for a server publish. */
    fun onData(topic: String?, data: ByteArray, from: RemoteParticipant?) {
        val text = data.decodeToString()
        when (topic) {
            Contracts.LEGACY_CHAT_TOPIC -> decode(LegacyChat.serializer(), text)?.let { m ->
                if (m.ignoreLegacy != true && from != null) addChat(m.id, m.timestamp, nameOf(from, null), false, m.message)
            }
            Contracts.REACTION_TOPIC -> decode(ReactionPacket.serializer(), text)?.let { r ->
                if (from != null && r.version == 1 && r.emoji in Reactions.palette) fly(r.emoji, from)
            }
            Contracts.CHAT_REACTION_TOPIC -> decode(ChatReactionPacket.serializer(), text)?.let { r ->
                val who = from?.identity?.value ?: return@let
                if (r.version == 1 && r.emoji in Reactions.palette) applyChatReaction(r.messageId, r.emoji, who, r.on)
            }
            Contracts.CAPTION_TOPIC -> decode(CaptionPacket.serializer(), text)?.let { c ->
                if (c.version == 1 && Contracts.acceptsCaptionPublisher(from?.identity?.value)) addCaption(c.segment)
            }
            // Only the Worker publishes moderation, and it publishes with no sender.
            Contracts.MODERATION_TOPIC -> if (from == null) decode(ModerationPacket.serializer(), text)?.let { m ->
                // The SFU already closed the track. This also releases the
                // capture, so the mic button and the call notification agree.
                if (m.type == "audio.muted") scope.launch { room.localParticipant.setMicrophoneEnabled(false) }
                _notice.value = when (m.type) {
                    "audio.muted" -> context.getString(R.string.notice_muted, m.by)
                    "screenshare.stopped" -> context.getString(R.string.notice_screen_stopped, m.by)
                    else -> null
                }
                log.event("moderation", "type" to m.type)
            }
        }
    }

    fun dismissNotice() {
        _notice.value = null
    }

    /** `reportModerationFailure`: a host's failed act, on the banner the call already shows. */
    fun report(message: String) {
        _notice.value = message
    }

    /** Returns false when the text is empty or over the limit. */
    fun send(text: String): Boolean {
        val trimmed = text.trim()
        if (trimmed.isEmpty() || trimmed.toByteArray().size > Contracts.CHAT_MAX_BYTES) return false
        scope.launch {
            val info = room.localParticipant.sendText(trimmed, StreamTextOptions(topic = Contracts.CHAT_TOPIC)).getOrNull()
            val id = info?.id ?: UUID.randomUUID().toString()
            val at = info?.timestampMs ?: System.currentTimeMillis()
            val legacy = json.encodeToString(LegacyChat.serializer(), LegacyChat(id, at, trimmed, ignoreLegacy = true))
            room.localParticipant.publishData(legacy.toByteArray(), DataPublishReliability.RELIABLE, Contracts.LEGACY_CHAT_TOPIC)
            addChat(id, at, context.getString(R.string.you), true, trimmed)
            log.event("chat_sent", "bytes" to trimmed.toByteArray().size)
        }
        return true
    }

    fun react(emoji: String) {
        val now = SystemClock.elapsedRealtime()
        if (emoji !in Reactions.palette || now - lastReactionAt < Reactions.MIN_INTERVAL_MS) return
        lastReactionAt = now
        scope.launch {
            val packet = json.encodeToString(ReactionPacket.serializer(), ReactionPacket(1, emoji))
            room.localParticipant.publishData(packet.toByteArray(), DataPublishReliability.LOSSY, Contracts.REACTION_TOPIC)
        }
        launchFlight(emoji, context.getString(R.string.you))
    }

    fun toggleChatReaction(messageId: String, emoji: String) {
        val now = SystemClock.elapsedRealtime()
        if (emoji !in Reactions.palette || now - lastChatReactionAt < Contracts.CHAT_REACTION_MIN_INTERVAL_MS) return
        val me = room.localParticipant.identity?.value ?: return
        val message = _chat.value.firstOrNull { it.id == messageId } ?: return
        val on = me !in message.reactions[emoji].orEmpty()
        if (on && message.reactions.count { me in it.value } >= Contracts.CHAT_REACTION_MAX_PER_MESSAGE) return
        lastChatReactionAt = now
        applyChatReaction(messageId, emoji, me, on)
        scope.launch {
            val packet = json.encodeToString(ChatReactionPacket.serializer(), ChatReactionPacket(1, messageId, emoji, on))
            room.localParticipant.publishData(packet.toByteArray(), DataPublishReliability.RELIABLE, Contracts.CHAT_REACTION_TOPIC)
        }
    }

    /** The Worker writes the `hand` attribute; the guest token cannot. */
    fun setHand(raised: Boolean) {
        val meetingId = details.meetingId ?: return
        val token = details.artifactToken ?: return
        scope.launch {
            runCatching { api.setHand(slug, meetingId, token, raised) }
                .onSuccess { log.event("hand", "raised" to raised) }
                .onFailure { _notice.value = context.getString(R.string.notice_hand_failed) }
        }
    }

    private val previews = mutableMapOf<String, LinkPreview?>()

    /**
     * The first https link's preview, once per link for the call. A link that
     * cannot be read is a link, not an error: the answer is null.
     */
    suspend fun linkPreview(text: String): LinkPreview? {
        val link = ThreadMarkdown.firstPreviewableLink(text) ?: return null
        if (previews.containsKey(link)) return previews[link]
        val meetingId = details.meetingId ?: return null
        val token = details.artifactToken ?: return null
        val preview = runCatching { api.linkPreview(slug, meetingId, token, link) }.getOrNull()
        previews[link] = preview
        return preview
    }

    suspend fun previewImage(url: String): ByteArray? = api.previewImage(url)

    fun handRaisedAt(p: Participant): Long? =
        Contracts.handRaisedAt(p.attributes[Contracts.HAND_ATTRIBUTE])
            ?.takeIf { System.currentTimeMillis() - it < Contracts.HAND_STALE_AFTER_MS }

    fun isHost(p: Participant): Boolean = p.attributes[Contracts.HOST_ATTRIBUTE] == "1"

    private fun addChat(id: String, atMs: Long, from: String, isLocal: Boolean, text: String) {
        if (text.isBlank() || _chat.value.any { it.id == id }) return
        _chat.value = (_chat.value + ChatMessage(id, atMs, from, isLocal, text)).sortedBy { it.atMs }
        if (!isLocal && !chatOpen) _unread.value += 1
    }

    private fun applyChatReaction(messageId: String, emoji: String, who: String, on: Boolean) {
        _chat.value = _chat.value.map { m ->
            if (m.id != messageId) return@map m
            val holders = m.reactions[emoji].orEmpty().let { if (on) it + who else it - who }
            m.copy(reactions = (m.reactions + (emoji to holders)).filterValues { it.isNotEmpty() })
        }
    }

    private fun addCaption(s: CaptionSegment) {
        val caption = Caption(s.id, s.speakerName, s.text, s.isFinal, s.startsAtMs)
        val current = _captions.value
        val i = current.indexOfFirst { it.id == s.id }
        val next = if (i >= 0) current.toMutableList().also { it[i] = caption } else current + caption
        _captions.value = next.takeLast(Contracts.LIVE_TRANSCRIPT_HISTORY_LINES)
    }

    private fun fly(emoji: String, from: RemoteParticipant) {
        val key = from.identity?.value ?: return
        val now = SystemClock.elapsedRealtime()
        if (now - (lastReactionFrom[key] ?: 0L) < Reactions.MIN_INTERVAL_MS) return
        lastReactionFrom[key] = now
        launchFlight(emoji, nameOf(from, key))
    }

    private fun launchFlight(emoji: String, from: String) {
        if (_flying.value.size >= Reactions.MAX_ONSCREEN) return
        val reaction = FlyingReaction(flyingKey++, emoji, from, SystemClock.elapsedRealtime())
        _flying.value = _flying.value + reaction
        scope.launch {
            delay(Reactions.FLIGHT_MS + Reactions.FLIGHT_JITTER_MS)
            _flying.value = _flying.value.filter { it.key != reaction.key }
        }
    }

    /** As Swift: the participant's name, else their identity, else "Guest". */
    private fun nameOf(p: Participant?, identity: String?): String =
        p?.name?.ifBlank { null } ?: identity ?: context.getString(R.string.guest)

    private fun <T> decode(serializer: kotlinx.serialization.KSerializer<T>, text: String): T? =
        runCatching { json.decodeFromString(serializer, text) }.getOrNull()
}
